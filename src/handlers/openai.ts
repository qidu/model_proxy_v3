import { ClaudeMessagesRequest, ClaudeMessagesResponse } from '../types/claude.js';
import { convertClaudeToOpenAIRequest, ThinkingConversionOptions } from '../converters/claude-to-openai.js';
import { convertOpenAIToClaudeResponse } from '../converters/openai-to-claude.js';
import { convertOpenAIToGeminiGenerateContent, convertOpenAIToGeminiInteractions, registerGeminiToolSchemas, clearGeminiToolSchemas } from '../converters/openai-to-gemini.js';
import { createLogger, logPipelineStage, logPipelineHeaders } from '../utils/logger.js';
import { isSdkUrl, handleSdkOpenAIRequest } from '../utils/sdk-handler.js';
import type { Env, Logger } from '../types/shared.js';
import { addForwardedHeaders, normalizeOpenAIAuthHeaders } from '../utils/routing.js';
import { runHook, applyAfterUpstream, type HookContext } from '../utils/request-transform.js';
import type { ModelRouteConfig } from '../utils/config-loader.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { recordResponseStatusCodeFromUpstream, recordUpstreamResponseToolCount } from '../utils/dashboard-stats.js';
import { recordUpstreamRateLimit } from '../utils/provider-quota.js';
import { handleTargetApiError } from '../utils/errors.js';
import { OpenAIContent, OpenAIMessage } from '../types/openai.js';
import { decodeDataUri } from '../converters/claude-to-gemini.js';
import { fetchImageAsInlineData } from '../utils/image-fetch.js';

/**
 * Check if request is in Gemini Interactions format
 */
function isGeminiInteractionsRequest(body: Record<string, unknown>): boolean {
  return 'input' in body || 'contents' in body;
}

/**
 * Convert Gemini parts into an OpenAI Completions `content` value:
 *   - text-only parts collapse to a joined string (preserves wire shape).
 *   - any `inline_data` / `inlineData` part present → returns an array
 *     mixing `{type:'text'}` and `{type:'image_url'}` parts (data-URI form).
 *     Both snake_case (`inline_data.mime_type`) and camelCase
 *     (`inlineData.mimeType`) accepted.
 *   - `thought:true` text parts are skipped (thinking markers; not part of
 *     content body in this direction).
 * Returns '' for an empty / unrecognized parts list.
 *
 * Used by `convertGeminiInteractionsToOpenAI` (Interactions-API client →
 * openai-completions upstream). `convertGeminiGenerateContentToOpenAI` keeps
 * its own inline copy (lines 173-204) because the image extraction there
 * interleaves with the funcCallParts / funcRespParts / thinkingContent
 * branching.
 */
function geminiPartsToOpenAIContent(
  parts: any[] | undefined,
): string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> {
  if (!Array.isArray(parts)) return '';
  const textParts: string[] = [];
  const imageParts: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
  for (const p of parts as any[]) {
    if (p && typeof p.text === 'string' && !p.thought) {
      textParts.push(p.text);
    }
    const inline = p?.inline_data ?? p?.inlineData;
    if (inline && typeof inline.data === 'string' && inline.data !== '') {
      const mime = inline.mime_type ?? inline.mimeType;
      imageParts.push({
        type: 'image_url',
        image_url: { url: `data:${mime || 'image/jpeg'};base64,${inline.data}` },
      });
    }
  }
  if (imageParts.length === 0) {
    return textParts.join('');
  }
  const out: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [];
  const text = textParts.join('');
  if (text !== '') out.push({ type: 'text', text });
  out.push(...imageParts);
  return out;
}

/**
 * Convert Gemini Interactions request to OpenAI format
 */
export function convertGeminiInteractionsToOpenAI(geminiRequest: Record<string, unknown>): Record<string, unknown> {
  const model = (geminiRequest.model as string) || 'gemini-no-id-at-proxy';

  // Handle input.messages format (Interactions API)
  if (geminiRequest.input && typeof geminiRequest.input === 'object') {
    const input = geminiRequest.input as Record<string, unknown>;
    if (Array.isArray(input.messages)) {
      return {
        model,
        messages: input.messages,
        stream: geminiRequest.stream || false,
      };
    }
  }

  // Handle input as array-of-turns (TC203: [{role, content}, ...]).
  // String content is preserved; array content (Gemini parts shape) is
  // routed through geminiPartsToOpenAIContent so inline_data images survive.
  if (Array.isArray(geminiRequest.input)) {
    return {
      model,
      messages: (geminiRequest.input as any[]).map((turn: any) => ({
        role: turn.role === 'model' ? 'assistant' : turn.role,
        content: typeof turn.content === 'string'
          ? turn.content
          : Array.isArray(turn.content)
            ? geminiPartsToOpenAIContent(turn.content)
            : String(turn.content ?? ''),
      })),
      stream: geminiRequest.stream || false,
    };
  }

  // Handle simple input format
  if (typeof geminiRequest.input === 'string') {
    return {
      model,
      messages: [{ role: 'user', content: geminiRequest.input }],
      stream: geminiRequest.stream || false,
    };
  }

  // Handle contents format (Gemini generateContent shape).
  // Each content's parts → OpenAI content via geminiPartsToOpenAIContent.
  if (Array.isArray(geminiRequest.contents)) {
    const messages = (geminiRequest.contents as any[]).map((content: any) => ({
      role: content.role === 'model' ? 'assistant' : content.role,
      content: geminiPartsToOpenAIContent(content.parts),
    }));

    return {
      model,
      messages,
      stream: geminiRequest.stream || false,
    };
  }

  throw new Error('Invalid Gemini Interactions request format');
}

/**
 * Recursively normalize Gemini schema type names (uppercase) to JSON Schema
 * (lowercase) so OpenAI-compatible upstreams accept the function parameters.
 * e.g. "STRING" → "string", "OBJECT" → "object"
 */
function normalizeGeminiSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(normalizeGeminiSchema);
  const out: Record<string, any> = {};
  for (const key of Object.keys(schema)) {
    if (key === 'type' && typeof schema[key] === 'string') {
      out[key] = (schema[key] as string).toLowerCase();
    } else {
      out[key] = normalizeGeminiSchema(schema[key]);
    }
  }
  return out;
}

/**
 * Convert Gemini generateContent request to OpenAI format
 */
export function convertGeminiGenerateContentToOpenAI(geminiRequest: Record<string, unknown>): Record<string, unknown> {
  const model = (geminiRequest.model as string) || 'gemini-no-id-at-proxy';

  // Handle contents format
  if (Array.isArray(geminiRequest.contents)) {
    const messages: Record<string, unknown>[] = [];

    // Extract systemInstruction and prepend as OpenAI system message
    const sysInstr = geminiRequest.systemInstruction as Record<string, unknown> | undefined;
    if (sysInstr) {
      const parts = sysInstr.parts as Array<Record<string, unknown>> | undefined;
      const systemText = Array.isArray(parts)
        ? parts.map(p => (typeof p.text === 'string' ? p.text : '')).join('')
        : typeof sysInstr.text === 'string' ? sysInstr.text : '';
      if (systemText) {
        messages.push({ role: 'system', content: systemText });
      }
    }

    // Track the last emitted tool_calls so tool results can recover the correct id+name.
    let lastToolCalls: Array<{ id: string; name: string }> = [];

    for (const content of geminiRequest.contents as any[]) {
      const role = content.role === 'model' ? 'assistant' : content.role;
      const parts: any[] = content.parts ?? [];

      const funcCallParts = parts.filter((p: any) => p.functionCall);
      const funcRespParts = parts.filter((p: any) => p.functionResponse);
      // Separate thinking (thought:true) from regular text so they can be
      // reconstructed as proper Claude thinking blocks by completionsToClaudeBody.
      // DeepSeek requires `reasoning_content` to be round-tripped on any
      // assistant turn that performed a tool call — see
      // docs/review_of_antigravity_gemini_with_ds_tools.md.
      const thinkingContent = parts.filter((p: any) => p.thought && p.text).map((p: any) => p.text as string).join('');
      const textContent = parts.filter((p: any) => p.text && !p.thought).map((p: any) => p.text as string).join('');

      if (funcCallParts.length > 0) {
        // Model turn: convert functionCall parts to OpenAI tool_calls
        lastToolCalls = funcCallParts.map((p: any, i: number) => ({
          id: `call_${p.functionCall.name}_${i}`,
          name: p.functionCall.name,
        }));
        const msg: Record<string, unknown> = {
          role: 'assistant',
          content: textContent || null,
          tool_calls: lastToolCalls.map((tc, i) => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(funcCallParts[i].functionCall.args ?? {}),
            },
          })),
        };
        if (thinkingContent) msg.reasoning_content = thinkingContent;
        messages.push(msg);
      } else if (funcRespParts.length > 0) {
        // User turn: convert functionResponse parts to OpenAI tool messages.
        // Match by position to the preceding lastToolCalls so id and name agree.
        for (let i = 0; i < funcRespParts.length; i++) {
          const p = funcRespParts[i];
          const matched = lastToolCalls[i];
          messages.push({
            role: 'tool',
            tool_call_id: matched?.id ?? `call_${p.functionResponse.name}_${i}`,
            name: matched?.name ?? p.functionResponse.name,
            content: JSON.stringify(p.functionResponse.response ?? {}),
          });
        }
        lastToolCalls = [];
      } else {
        // Collect image parts. Gemini SDK accepts both snake_case
        // (inline_data.mime_type) and camelCase (inlineData.mimeType); emit
        // them as OpenAI image_url data-URI parts. When a turn has any image
        // part, content becomes an array mixing text and image_url parts
        // (matching src/converters/claude-to-openai.ts:54-60).
        const imageParts = parts
          .map((p: any) => {
            const inline = p.inline_data ?? p.inlineData;
            if (!inline) return null;
            const mime = inline.mime_type ?? inline.mimeType;
            const data = inline.data;
            if (typeof data !== 'string' || data === '') return null;
            return {
              type: 'image_url' as const,
              image_url: { url: `data:${mime || 'image/jpeg'};base64,${data}` },
            };
          })
          .filter((p: any): p is { type: 'image_url'; image_url: { url: string } } => p !== null);

        let msg: Record<string, unknown>;
        if (imageParts.length === 0) {
          msg = { role, content: textContent };
        } else {
          const contentArr: Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> = [];
          if (textContent) contentArr.push({ type: 'text', text: textContent });
          for (const ip of imageParts) contentArr.push(ip);
          msg = { role, content: contentArr };
        }
        if (thinkingContent) msg.reasoning_content = thinkingContent;
        messages.push(msg);
      }
    }

    // Convert Gemini tools[].functionDeclarations to OpenAI tools[]
    const tools: unknown[] = [];
    if (Array.isArray(geminiRequest.tools)) {
      for (const tool of geminiRequest.tools as any[]) {
        if (Array.isArray(tool.functionDeclarations)) {
          for (const fd of tool.functionDeclarations) {
            tools.push({
              type: 'function',
              function: {
                name: fd.name,
                description: fd.description,
                parameters: normalizeGeminiSchema(fd.parameters ?? { type: 'object', properties: {} }),
              },
            });
          }
        }
      }
    }

    // Check for stream parameter in both top-level and generationConfig
    const config = geminiRequest.generationConfig as Record<string, unknown> | undefined;
    const stream = geminiRequest.stream === true || config?.stream === true;

    const result: Record<string, unknown> = { model, messages, stream };
    if (tools.length > 0) result.tools = tools;
    return result;
  }

  throw new Error('Invalid Gemini generateContent request format');
}

function defaultMissingOpenAIMessageRoles(openaiRequest: Record<string, unknown>): void {
  if (!Array.isArray(openaiRequest.messages)) return;

  openaiRequest.messages = openaiRequest.messages.map(message => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return message;
    const msg = message as Record<string, unknown>;
    return msg.role == null ? { ...msg, role: 'user' } : msg;
  });
}

function openAIContentToText(content: OpenAIContent | null | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part.type === 'text')
    .map(part => 'text' in part ? part.text : '')
    .join('');
}

/**
 * Convert an OpenAI Chat Completions message `content` into Responses API
 * content parts (`input_text` / `output_text` / `input_image`). Used by
 * `completionsToResponsesBody` to route Completions clients through an
 * `openai-responses` upstream.
 *
 * `image_url` parts are forwarded as `input_image` with the URL object passed
 * through unchanged (the Responses upstream performs its own fetch — no
 * in-proxy SSRF-guarded fetch is needed). Matches the pattern used in
 * `src/handlers/messages.ts:151` for Claude → Responses image forwarding.
 */
function openAIContentToResponsesParts(
  content: OpenAIContent | null | undefined,
  textType: 'input_text' | 'output_text',
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (typeof content === 'string') {
    parts.push({ type: textType, text: content });
    return parts;
  }
  if (!Array.isArray(content)) return parts;
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: textType, text: part.text });
    } else if (part.type === 'image_url') {
      parts.push({ type: 'input_image', image_url: part.image_url });
    }
    // Unknown part types (e.g. thinking) are skipped here.
  }
  return parts;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string' || value === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function openAIChunk(text: string, model: string): Record<string, unknown> {
  return {
    id: `chatcmpl_${Date.now()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  };
}

// Per-request buffers for Anthropic SSE → Gemini conversion, keyed by requestId.
// Concurrent streaming requests (e.g. parallel sub-agent tool calls) interleave
// on the event loop across `await reader.read()` suspension points, so a single
// shared buffer would corrupt unrelated requests' tool-call args. Entries are
// removed on message_stop / stream completion (see cleanup call sites below).
interface AnthropicToolBuffer { id: string; name: string; args: string; }
let anthropicToolBuffers: Map<string, Map<number, AnthropicToolBuffer>> = new Map();
// Keyed by requestId -> block index -> accumulated thinking text.
let anthropicThinkingBuffers: Map<string, Map<number, string>> = new Map();

/** Remove all per-request SSE conversion state for a finished/aborted request. */
function clearAnthropicSSEState(requestId: string): void {
  anthropicToolBuffers.delete(requestId);
  anthropicThinkingBuffers.delete(requestId);
  clearGeminiSSEState(requestId);
}

function processAnthropicSSEBuffer(buffer: string, model: string, requestId: string, isInteractionsRequest: boolean, isGenerateContentRequest: boolean): { processed: string; remaining: string } {
  let result = '';
  const events = buffer.split('\n\n');
  const remaining = events.pop() || '';

  let toolBuffers = anthropicToolBuffers.get(requestId);
  let thinkingBuffers = anthropicThinkingBuffers.get(requestId);

  for (const event of events) {
    if (!event.trim()) continue;
    const dataLine = event.split('\n').find(line => line.startsWith('data: '));
    if (!dataLine) continue;
    try {
      const parsed = JSON.parse(dataLine.slice(6));

      if (parsed.type === 'content_block_start') {
        const block = parsed.content_block as Record<string, unknown> | undefined;
        if (block?.type === 'tool_use') {
          // Standard Anthropic sends input:{} here and streams args via input_json_delta.
          // Some compatible APIs (e.g. MiniMax) send args fully populated in input already.
          const input = block.input as Record<string, unknown> | undefined;
          const initialArgs = (input && Object.keys(input).length > 0) ? JSON.stringify(input) : '';
          if (!toolBuffers) { toolBuffers = new Map(); anthropicToolBuffers.set(requestId, toolBuffers); }
          toolBuffers.set(parsed.index as number, {
            id: (block.id as string) || '',
            name: (block.name as string) || '',
            args: initialArgs,
          });
        } else if (block?.type === 'thinking') {
          if (!thinkingBuffers) { thinkingBuffers = new Map(); anthropicThinkingBuffers.set(requestId, thinkingBuffers); }
          thinkingBuffers.set(parsed.index as number, '');
        }
      } else if (parsed.type === 'content_block_delta') {
        const delta = parsed.delta as Record<string, unknown> | undefined;
        if (delta?.type === 'text_delta') {
          const chunk = openAIChunk((delta.text as string) || '', model);
          const { processed } = processSSEBuffer(`data: ${JSON.stringify(chunk)}\n\n`, model, requestId, isInteractionsRequest, isGenerateContentRequest);
          result += processed;
        } else if (delta?.type === 'thinking_delta') {
          const existing = thinkingBuffers?.get(parsed.index as number);
          if (thinkingBuffers && existing !== undefined) {
            thinkingBuffers.set(parsed.index as number, existing + ((delta.thinking as string) || ''));
          }
        } else if (delta?.type === 'input_json_delta') {
          const tool = toolBuffers?.get(parsed.index as number);
          if (tool) tool.args += (delta.partial_json as string) || '';
        }
      } else if (parsed.type === 'content_block_stop') {
        const blockIndex = parsed.index as number;
        const tool = toolBuffers?.get(blockIndex);
        if (tool) {
          toolBuffers!.delete(blockIndex);
          // Emit a complete OpenAI-format tool_calls chunk, then convert to the target format.
          // Use the Anthropic content-block index (not a hardcoded 0) so multiple
          // parallel tool calls in one turn don't collide in geminiToolCallBuffer —
          // colliding indices concatenate different tools' argument JSON into one
          // string, producing invalid_args errors for the merged/clobbered call.
          const chunk = {
            id: `chatcmpl_${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
              index: 0,
              delta: {
                tool_calls: [{ index: blockIndex, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.args } }],
              },
              finish_reason: null,
            }],
          };
          const { processed } = processSSEBuffer(`data: ${JSON.stringify(chunk)}\n\n`, model, requestId, isInteractionsRequest, isGenerateContentRequest);
          result += processed;
        } else if (thinkingBuffers?.has(parsed.index as number)) {
          // Emit the completed thinking block as a <think>…</think>-wrapped text so
          // processSSEBuffer's existing logic strips it into reasoning/cleanText.
          const thinking = thinkingBuffers.get(parsed.index as number) || '';
          thinkingBuffers.delete(parsed.index as number);
          if (thinking) {
            const chunk = openAIChunk(`<think>${thinking}</think>`, model);
            const { processed } = processSSEBuffer(`data: ${JSON.stringify(chunk)}\n\n`, model, requestId, isInteractionsRequest, isGenerateContentRequest);
            result += processed;
          }
        }
      } else if (parsed.type === 'message_delta') {
        const delta = parsed.delta as Record<string, unknown> | undefined;
        const stopReason = delta?.stop_reason as string | undefined;
        const finishReason = stopReason === 'tool_use' ? 'tool_calls'
          : stopReason === 'max_tokens' ? 'length' : 'stop';
        // Route through processSSEBuffer so its geminiToolCallBuffer flush logic fires.
        // Without this, tool calls buffered during content_block_stop are never emitted.
        const syntheticFinish = {
          id: `chatcmpl_${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
        };
        const { processed } = processSSEBuffer(`data: ${JSON.stringify(syntheticFinish)}\n\n`, model, requestId, isInteractionsRequest, isGenerateContentRequest);
        result += processed;
      } else if (parsed.type === 'message_stop') {
        clearAnthropicSSEState(requestId);
        // Gemini generateContent/interactions streams end naturally; no sentinel needed.
      }
    } catch {
      // Skip invalid SSE data.
    }
  }

  return { processed: result, remaining };
}

function processResponsesSSEBuffer(buffer: string, model: string, requestId: string, isInteractionsRequest: boolean, isGenerateContentRequest: boolean): { processed: string; remaining: string } {
  let result = '';
  const events = buffer.split('\n\n');
  const remaining = events.pop() || '';

  for (const event of events) {
    if (!event.trim()) continue;
    const dataLine = event.split('\n').find(line => line.startsWith('data: '));
    if (!dataLine) continue;
    const data = dataLine.slice(6).trim();
    if (data === '[DONE]') continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed.type === 'response.output_text.delta') {
        const chunk = openAIChunk(parsed.delta || '', model);
        const { processed } = processSSEBuffer(`data: ${JSON.stringify(chunk)}\n\n`, model, requestId, isInteractionsRequest, isGenerateContentRequest);
        result += processed;
      }
    } catch {
      // Skip invalid SSE data.
    }
  }

  return { processed: result, remaining };
}

async function handleCrossModeStreamingResponse(
  response: Response,
  model: string,
  requestId: string,
  logger: Logger,
  isInteractionsRequest: boolean,
  isGenerateContentRequest: boolean,
  source: 'anthropic-messages' | 'openai-responses',
): Promise<Response> {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const rawChunk = new TextDecoder().decode(value);
        buffer += rawChunk;
        logPipelineStage(logger, requestId, 'upstream-response', response.url || `(upstream SSE, ${source})`, rawChunk);
        const converted = source === 'anthropic-messages'
          ? processAnthropicSSEBuffer(buffer, model, requestId, isInteractionsRequest, isGenerateContentRequest)
          : processResponsesSSEBuffer(buffer, model, requestId, isInteractionsRequest, isGenerateContentRequest);
        buffer = converted.remaining;
        if (converted.processed) {
          logPipelineStage(logger, requestId, 'outbound', 'stream', converted.processed);
          await writer.write(encoder.encode(converted.processed));
        }
      }
      if (buffer.trim()) {
        const converted = source === 'anthropic-messages'
          ? processAnthropicSSEBuffer(buffer + '\n\n', model, requestId, isInteractionsRequest, isGenerateContentRequest)
          : processResponsesSSEBuffer(buffer + '\n\n', model, requestId, isInteractionsRequest, isGenerateContentRequest);
        if (converted.processed) {
          logPipelineStage(logger, requestId, 'outbound', 'stream (final)', converted.processed);
          await writer.write(encoder.encode(converted.processed));
        }
      }
      await writer.close();
    } catch (error) {
      logger.error(requestId, `Cross-mode streaming error: ${(error as Error).message}`);
      await writer.abort();
    } finally {
      // Prevent leaking per-request buffer entries if the stream errors out
      // before message_stop/[DONE] triggers the normal cleanup.
      if (source === 'anthropic-messages') clearAnthropicSSEState(requestId);
    }
  })();

  const crossModeOutHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'x-request-id': requestId,
  };
  logPipelineHeaders(logger, requestId, 'outbound', 'stream', crossModeOutHeaders);
  return new Response(readable, { headers: crossModeOutHeaders });
}

/**
 * Convert an OpenAI message `content` value into the Claude representation:
 *   - string content returns as a string (preserves the common simple case).
 *   - array content with only text parts collapses to a joined string
 *     (matches prior behavior and keeps the wire shape minimal).
 *   - array content containing any `image_url` part returns Claude content
 *     blocks (`{type:'text'}` / `{type:'image', source:{type:'base64', ...}}`).
 *
 * `image_url` URLs are decoded via `decodeDataUri` for `data:` URIs and
 * `fetchImageAsInlineData` for http(s) (SSRF-guarded). Throws on any fetch /
 * decode failure (Rule #8 — Fail Loud, no placeholder image).
 */
async function openAIContentToClaudeStringOrBlocks(
  content: OpenAIContent | unknown,
): Promise<string | unknown[]> {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  const blocks: Array<{ type: string; [k: string]: unknown }> = [];
  for (const part of content as Array<Record<string, unknown>>) {
    const pType = part.type;
    if (pType === 'text') {
      const text = part.text as string | undefined;
      if (typeof text === 'string' && text !== '') blocks.push({ type: 'text', text });
    } else if (pType === 'image_url') {
      const url = (part.image_url as Record<string, unknown> | undefined)?.url as string;
      if (typeof url !== 'string' || url === '') continue;
      const img = url.startsWith('data:')
        ? decodeDataUri(url)
        : await fetchImageAsInlineData(url);
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: img.mime_type, data: img.data },
      });
    }
    // Unknown part types (e.g. thinking) are skipped here — handled by caller.
  }

  // Collapse text-only arrays back to a string (matches prior wire shape).
  if (blocks.length === 0) return '';
  if (blocks.every(b => b.type === 'text')) {
    return (blocks as unknown as Array<{ text: string }>).map(b => b.text).join('');
  }
  return blocks;
}

/**
 * Convert an OpenAI Chat Completions body (model, messages, max_tokens, ...) to a
 * Claude Messages body. Used to route Gemini endpoints (interactions/generateContent)
 * through an anthropic-messages upstream.
 *
 * Async because array-form `content` with `image_url` parts pointing at http(s)
 * URLs requires a server-side fetch (SSRF-guarded; see `fetchImageAsInlineData`).
 * `data:` URIs are decoded synchronously via `decodeDataUri`.
 */
export async function completionsToClaudeBody(completions: Record<string, unknown>, model: string): Promise<Record<string, unknown>> {
  const messages = (completions.messages as OpenAIMessage[]) || [];
  const systemMsg = messages.find(m => m.role === 'system');
  const otherMessages = messages.filter(m => m.role !== 'system');

  // Group consecutive tool-role messages into a single user message with multiple
  // tool_result blocks — Claude requires all results in one message immediately
  // after the assistant turn that issued the tool_calls.
  const claudeMessages: unknown[] = [];
  let i = 0;
  while (i < otherMessages.length) {
    const m = otherMessages[i];
    const thinking = (m as unknown as Record<string, unknown>).reasoning_content as string | undefined;
    if (m.tool_calls) {
      const content: unknown[] = [];
      if (thinking) content.push({ type: 'thinking', thinking });
      content.push(...m.tool_calls.map(tc => ({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: parseJsonObject(tc.function.arguments),
      })));
      claudeMessages.push({ role: 'assistant', content });
      i++;
      // Collect all immediately following tool messages into one user message.
      const toolResults: unknown[] = [];
      while (i < otherMessages.length && otherMessages[i].role === 'tool') {
        const t = otherMessages[i];
        toolResults.push({ type: 'tool_result', tool_use_id: t.tool_call_id, content: t.content ?? '' });
        i++;
      }
      if (toolResults.length > 0) {
        claudeMessages.push({ role: 'user', content: toolResults });
      }
    } else if (m.role === 'tool') {
      // Orphaned tool message (no preceding tool_calls — should not happen, but be safe).
      claudeMessages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content ?? '' }] });
      i++;
    } else if (thinking) {
      // Thinking turn: emit a `thinking` block followed by text/image blocks.
      const textOrBlocks = await openAIContentToClaudeStringOrBlocks(m.content);
      const blocks = typeof textOrBlocks === 'string'
        ? [{ type: 'text', text: textOrBlocks }]
        : textOrBlocks;
      claudeMessages.push({ role: m.role, content: [{ type: 'thinking', thinking }, ...blocks] });
      i++;
    } else {
      const content = await openAIContentToClaudeStringOrBlocks(m.content);
      claudeMessages.push({ role: m.role, content });
      i++;
    }
  }

  const claudeBody: Record<string, unknown> = {
    model,
    messages: claudeMessages,
    max_tokens: (completions.max_tokens as number | undefined) ?? 4096,
    stream: completions.stream === true,
  };

  if (systemMsg) claudeBody.system = systemMsg.content;
  if (completions.temperature !== undefined) claudeBody.temperature = completions.temperature;
  if (completions.top_p !== undefined) claudeBody.top_p = completions.top_p;
  if (completions.stop !== undefined) claudeBody.stop_sequences = Array.isArray(completions.stop) ? completions.stop : [completions.stop as string];

  if (completions.tools && Array.isArray(completions.tools) && (completions.tools as unknown[]).length > 0) {
    claudeBody.tools = (completions.tools as Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>).map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
  }

  return claudeBody;
}

/**
 * Convert an OpenAI Chat Completions body to an OpenAI Responses body (`input`).
 * Used to route Gemini endpoints (interactions/generateContent) through an
 * openai-responses upstream.
 */
export function completionsToResponsesBody(completions: Record<string, unknown>, model: string): Record<string, unknown> {
  const messages = (completions.messages as OpenAIMessage[]) || [];
  const input: unknown[] = [];
  const instructions = messages
    .filter(msg => msg.role === 'system' || msg.role === 'developer')
    .map(msg => openAIContentToText(msg.content))
    .filter(text => text !== '')
    .join('\n');

  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      continue;
    }

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
      const text = openAIContentToText(msg.content);
      if (text !== '') {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text }],
        });
      }
      continue;
    }

    if (msg.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: openAIContentToText(msg.content),
      });
      continue;
    }

    // Prior assistant turns replayed as input must use `output_text` (mirrors what
    // the upstream originally emitted); user turns use `input_text`.
    const textType = msg.role === 'assistant' ? 'output_text' : 'input_text';
    const contentParts = openAIContentToResponsesParts(msg.content, textType);
    input.push({
      type: 'message',
      role: msg.role,
      content: contentParts.length > 0 ? contentParts : [{ type: textType, text: '' }],
    });
  }

  const responsesBody: Record<string, unknown> = {
    model,
    input,
    stream: completions.stream === true,
  };
  if (instructions) responsesBody.instructions = instructions;

  if (completions.temperature !== undefined) responsesBody.temperature = completions.temperature;
  if (completions.top_p !== undefined) responsesBody.top_p = completions.top_p;
  if (completions.max_tokens !== undefined) responsesBody.max_output_tokens = completions.max_tokens;
  if (completions.prompt_cache_key !== undefined) responsesBody.prompt_cache_key = completions.prompt_cache_key;
  if (completions.tools && Array.isArray(completions.tools) && (completions.tools as unknown[]).length > 0) {
    responsesBody.tools = (completions.tools as Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>).map(t => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));
  }

  return responsesBody;
}

/**
 * Forward an OpenAI Chat Completions body as a Claude Messages request to an
 * anthropic-messages upstream. Used when the inbound endpoint is
 * /v1/interactions or :generateContent and the route is anthropic-messages.
 *
 * The body has already been converted from Gemini/Claude to OpenAI Completions
 * by handleOpenAIRequest; we run a second conversion to Claude Messages format
 * and call the upstream directly. The response is converted from Claude
 * format back to the Gemini endpoint shape (Interactions or generateContent).
 */
async function forwardCompletionsAsAnthropicMessages(
  openaiRequest: Record<string, unknown>,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  model: string,
  logger: Logger,
  originalRequest: Request,
  env?: Env,
  route?: ModelRouteConfig,
): Promise<Response> {
  const claudeBody = await completionsToClaudeBody(openaiRequest, model);

  // DeepSeek's anthropic-compatible endpoint REQUIRES a `content[].thinking`
  // block on any assistant turn that carried tool_use in thinking mode — a turn
  // with only tool_use blocks is rejected with "content[].thinking ... must be
  // passed back". Gemini strips thoughtSignature so the real thinking cannot be
  // replayed, but an unsigned (even empty) thinking block is accepted. Ensure a
  // leading thinking block on every assistant tool_use turn that lacks one.
  // Verified against the live upstream (2026-08-02).
  for (const m of (claudeBody.messages as Array<Record<string, unknown>>)) {
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const blocks = m.content as Array<Record<string, unknown>>;
      const hasToolUse = blocks.some(b => b.type === 'tool_use');
      const hasThinking = blocks.some(b => b.type === 'thinking');
      if (hasToolUse && !hasThinking) {
        blocks.unshift({ type: 'thinking', thinking: '' });
      }
    }
  }
  logger.debug(requestId, `Interactions/generateContent -> anthropic-messages body: ${JSON.stringify(claudeBody).substring(0, 500)}`);
  logPipelineStage(logger, requestId, 'upstream-request', targetUrl, claudeBody);

  // anthropic-messages expects x-api-key (or Authorization). Normalize headers.
  const anthropicHeaders: Record<string, string> = { ...authHeaders };
  if (anthropicHeaders['x-api-key']) {
    delete anthropicHeaders['Authorization'];
  }

  const anthropicFetchHeaders = {
    'Content-Type': 'application/json',
    ...addForwardedHeaders(anthropicHeaders, originalRequest),
  };
  logPipelineHeaders(logger, requestId, 'upstream-request', targetUrl, anthropicFetchHeaders);
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: anthropicFetchHeaders,
    body: JSON.stringify(claudeBody),
    signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
  });

  logPipelineHeaders(logger, requestId, 'upstream-response', targetUrl, response.headers);
  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('anthropic-messages', 0);
  recordUpstreamRateLimit(model, (name) => response.headers.get(name), targetUrl);

  if (!response.ok) {
    const upstreamBody = await response.text();
    logger.error(requestId, `Interactions/generateContent->anthropic-messages error: ${response.status}, URL: ${targetUrl}`);
    handleTargetApiError(response, 'Interactions/generateContent (via anthropic-messages)', { url: targetUrl, upstreamBody });
  }

  const url = new URL(originalRequest.url);
  const isInteractionsRequest = url.pathname === '/v1/interactions' || url.pathname.startsWith('/v1/interactions?');
  const isGenerateContentRequest = url.pathname.includes(':generateContent') || url.pathname.includes(':streamGenerateContent');

  const isStreaming = claudeBody.stream === true;
  if (isStreaming) {
    return handleCrossModeStreamingResponse(response, model, requestId, logger, isInteractionsRequest, isGenerateContentRequest, 'anthropic-messages');
  }

  const claudeJsonText = await response.text();
  logPipelineStage(logger, requestId, 'upstream-response', targetUrl, claudeJsonText);
  const claudeJson = JSON.parse(claudeJsonText) as Record<string, unknown>;
  // Convert Claude Messages response → OpenAI Completions response shape, then
  // let the existing Gemini response converters produce the right endpoint shape.
  const syntheticCompletions = claudeJsonToSyntheticCompletions(claudeJson, model);

  if (isGenerateContentRequest) {
    const geminiResponse = convertOpenAIToGeminiGenerateContent(syntheticCompletions, model, requestId);
    logPipelineStage(logger, requestId, 'outbound', ':generateContent', geminiResponse);
    const outHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
    logPipelineHeaders(logger, requestId, 'outbound', ':generateContent', outHeaders);
    return new Response(JSON.stringify(geminiResponse), { headers: outHeaders });
  }
  if (isInteractionsRequest) {
    const interactionResponse = convertOpenAIToGeminiInteractions(syntheticCompletions, model, requestId);
    logPipelineStage(logger, requestId, 'outbound', '/v1/interactions', interactionResponse);
    const outHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
    logPipelineHeaders(logger, requestId, 'outbound', '/v1/interactions', outHeaders);
    return new Response(JSON.stringify(interactionResponse), { headers: outHeaders });
  }

  // Fallback: return Claude Messages response as-is
  logPipelineStage(logger, requestId, 'outbound', '(fallback claude passthrough)', claudeJson);
  const fallbackHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
  logPipelineHeaders(logger, requestId, 'outbound', '(fallback claude passthrough)', fallbackHeaders);
  return new Response(JSON.stringify(claudeJson), { headers: fallbackHeaders });
}

/**
 * Convert a Claude Messages JSON response to an OpenAI Chat Completions response shape.
 */
export function claudeJsonToSyntheticCompletions(claudeJson: Record<string, unknown>, model: string): Record<string, unknown> {
  const contentBlocks = (claudeJson.content as Array<Record<string, unknown>>) ?? [];
  const toolUseBlocks = contentBlocks.filter(c => c.type === 'tool_use');
  // Preserve thinking blocks as reasoning_content so downstream converters
  // (convertOpenAIToGeminiGenerateContent) can emit {thought:true} parts and
  // the Gemini SDK can round-trip reasoning on the next turn for thinking-mode
  // upstreams (e.g. DeepSeek Anthropic-compatible endpoint).
  const thinkingText = contentBlocks.filter(c => c.type === 'thinking').map(c => c.thinking ?? '').join('\n');
  return {
    id: claudeJson.id ?? `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: (claudeJson.model as string) ?? model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        // When only tool_calls are present (no text), content must be null not "".
        // Upstreams like DeepSeek reject messages[N].content = "" with tool_calls present.
        content: (() => {
          const text = contentBlocks.filter(c => c.type === 'text').map(c => c.text).join('');
          return (toolUseBlocks.length > 0 && text === '') ? null : text;
        })(),
        ...(toolUseBlocks.length > 0 ? {
          tool_calls: toolUseBlocks.map(tc => ({
            id: (tc.id as string) ?? `call_${Date.now()}`,
            type: 'function',
            function: { name: tc.name ?? '', arguments: JSON.stringify(tc.input ?? {}) },
          })),
        } : {}),
        ...(thinkingText ? { reasoning_content: thinkingText } : {}),
      },
      finish_reason: toolUseBlocks.length > 0 ? 'tool_calls' : (claudeJson.stop_reason === 'max_tokens' ? 'length' : 'stop'),
    }],
    usage: (() => {
      const u = claudeJson.usage as Record<string, unknown> | undefined;
      if (!u) return undefined;
      return {
        prompt_tokens: u.input_tokens ?? 0,
        completion_tokens: u.output_tokens ?? 0,
        total_tokens: ((u.input_tokens as number) ?? 0) + ((u.output_tokens as number) ?? 0),
      };
    })(),
  };
}

/**
 * Forward an OpenAI Chat Completions body as an OpenAI Responses body to an
 * openai-responses upstream. Used when the inbound endpoint is
 * /v1/interactions or :generateContent and the route is openai-responses.
 *
 * The body has already been converted from Gemini/Claude to OpenAI Completions
 * by handleOpenAIRequest; we run a second conversion to Responses `input`
 * format and call the upstream. The response is converted from Responses
 * format back to the Gemini endpoint shape.
 */
async function forwardCompletionsAsOpenAIResponses(
  openaiRequest: Record<string, unknown>,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  model: string,
  logger: Logger,
  originalRequest: Request,
  env?: Env,
  isInteractionsRequest?: boolean,
  isGenerateContentRequest?: boolean,
  isStreaming?: boolean,
  route?: ModelRouteConfig,
): Promise<Response> {
  let responsesBody: Record<string, unknown> = completionsToResponsesBody(openaiRequest, model);
  logger.debug(requestId, `Interactions/generateContent -> openai-responses body: ${JSON.stringify(responsesBody).substring(0, 500)}`);

  if (route) {
    const hookCtx: HookContext = {
      hook: 'before_upstream', route,
      upstreamMode: 'openai-responses',
      clientModel: model, requestId, streaming: isStreaming ?? false, logger,
    };
    ({ body: responsesBody, headers: authHeaders } = runHook('before_upstream', { body: responsesBody, headers: authHeaders }, hookCtx));
  }

  logPipelineStage(logger, requestId, 'upstream-request', targetUrl, responsesBody);
  const responsesFetchHeaders = {
    'Content-Type': 'application/json',
    ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), originalRequest),
  };
  logPipelineHeaders(logger, requestId, 'upstream-request', targetUrl, responsesFetchHeaders);
  let response = await fetch(targetUrl, {
    method: 'POST',
    headers: responsesFetchHeaders,
    body: JSON.stringify(responsesBody),
    signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
  });

  if (route) {
    response = await applyAfterUpstream(response, {
      hook: 'after_upstream', route, upstreamMode: 'openai-responses',
      clientModel: model, requestId, streaming: isStreaming ?? false, logger,
    });
  }

  logPipelineHeaders(logger, requestId, 'upstream-response', targetUrl, response.headers);
  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('openai-responses', 0);
  recordUpstreamRateLimit(model, (name) => response.headers.get(name), targetUrl);

  if (!response.ok) {
    const upstreamBody = await response.text();
    logger.error(requestId, `Interactions/generateContent->openai-responses error: ${response.status}, URL: ${targetUrl}`);
    handleTargetApiError(response, 'Interactions/generateContent (via openai-responses)', { url: targetUrl, upstreamBody });
  }

  if (isStreaming) {
    return handleCrossModeStreamingResponse(response, model, requestId, logger, isInteractionsRequest === true, isGenerateContentRequest === true, 'openai-responses');
  }

  const responsesJsonText = await response.text();
  logPipelineStage(logger, requestId, 'upstream-response', targetUrl, responsesJsonText);
  const responsesJson = JSON.parse(responsesJsonText) as Record<string, unknown>;
  // Build a synthetic Completions response from the Responses output items so
  // we can reuse the existing Gemini response converters.
  const outputItems = (responsesJson.output as Array<Record<string, unknown>>) ?? [];
  const textMsg = outputItems.find(o => o.type === 'message');
  const textPart = (textMsg?.content as Array<Record<string, unknown>> | undefined)?.find(c => c.type === 'output_text');
  const toolCallItems = outputItems.filter(o => o.type === 'function_call');
  const usageObj = responsesJson.usage as Record<string, unknown> | undefined;

  const syntheticCompletions: Record<string, unknown> = {
    id: responsesJson.id ?? `chatcmpl_${Date.now()}`,
    object: 'chat.completion',
    created: (responsesJson.created_at as number) ?? Math.floor(Date.now() / 1000),
    model: (responsesJson.model as string) ?? model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: (textPart?.text as string) ?? '',
        ...(toolCallItems.length > 0 ? {
          tool_calls: toolCallItems.map(tc => ({
            id: (tc.call_id as string) ?? (tc.id as string) ?? `call_${Date.now()}`,
            type: 'function',
            function: { name: tc.name ?? '', arguments: tc.arguments ?? '' },
          })),
        } : {}),
      },
      finish_reason: toolCallItems.length > 0 ? 'tool_calls' : 'stop',
    }],
    usage: usageObj ? {
      prompt_tokens: usageObj.input_tokens ?? 0,
      completion_tokens: usageObj.output_tokens ?? 0,
      total_tokens: usageObj.total_tokens ?? 0,
    } : undefined,
  };

  if (isGenerateContentRequest) {
    const geminiResponse = convertOpenAIToGeminiGenerateContent(syntheticCompletions, model, requestId);
    logPipelineStage(logger, requestId, 'outbound', ':generateContent', geminiResponse);
    const outHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
    logPipelineHeaders(logger, requestId, 'outbound', ':generateContent', outHeaders);
    return new Response(JSON.stringify(geminiResponse), { headers: outHeaders });
  }
  if (isInteractionsRequest) {
    const interactionResponse = convertOpenAIToGeminiInteractions(syntheticCompletions, model, requestId);
    logPipelineStage(logger, requestId, 'outbound', '/v1/interactions', interactionResponse);
    const outHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
    logPipelineHeaders(logger, requestId, 'outbound', '/v1/interactions', outHeaders);
    return new Response(JSON.stringify(interactionResponse), { headers: outHeaders });
  }

  // Fallback: return Responses API response as-is
  logPipelineStage(logger, requestId, 'outbound', '(fallback responses passthrough)', responsesJson);
  const fallbackHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
  logPipelineHeaders(logger, requestId, 'outbound', '(fallback responses passthrough)', fallbackHeaders);
  return new Response(JSON.stringify(responsesJson), { headers: fallbackHeaders });
}

/**
 * Handle OpenAI-compatible API request
 */
export async function handleOpenAIRequest(
    request: Request,
    targetUrl: string,
    authHeaders: Record<string, string>,
    requestId: string,
    modelId?: string,
    env?: Env,
    logger?: Logger,
    forceStreaming?: boolean,
    conversionOptions?: ThinkingConversionOptions,
    upstreamMode?: string,
    route?: ModelRouteConfig,
): Promise<Response> {
    const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);

    // Check original request path for response format
    const url = new URL(request.url);
    const isStreamRequest = url.searchParams.get('alt') === 'sse' || url.pathname.includes(':streamGenerateContent');
    const isInteractionsRequest = url.pathname === '/v1/interactions' || url.pathname.startsWith('/v1/interactions?');
    const isGenerateContentRequest = url.pathname.includes(':generateContent') || url.pathname.includes(':streamGenerateContent');
    const isGeminiEndpoint = isInteractionsRequest || isGenerateContentRequest;
    
    activeLogger.debug(requestId, `OpenAI handler - path: ${url.pathname}, isGeminiEndpoint: ${isGeminiEndpoint}`);
    const authTokenIn = request.headers.get('Authorization') || '';
    const apiKey = request.headers.get('x-api-key') || '';
    const googApiKey = request.headers.get('x-goog-api-key') || '';
    activeLogger.debug(requestId, `Authorization: ${authTokenIn.substring(0, 16)}... at endpoint`);
    activeLogger.debug(requestId, `x-api-key: ${apiKey.substring(0, 16)}...`);
    activeLogger.debug(requestId, `x-goog-api-key: ${googApiKey.substring(0, 16)}...`);

    // This handler always targets an OpenAI-compatible upstream (openai-completions),
    // which expects `Authorization: Bearer <key>` regardless of the incoming endpoint
    // (/v1/messages, /v1/interactions, or :generateContent mapped here). Resolve the
    // key from whichever header the client supplied and forward it as Bearer — but
    // only when the proxy has not already populated an Authorization header from its
    // own configuration (e.g. [models.free] `api_key`). Overwriting a configured key
    // with a stray client header breaks the /v1beta/models (Gemini) path, which
    // dispatches here, while /v1/responses (handleResponsesRequest) does not.
    if (!authHeaders['Authorization']) {
        const incomingKey =
            (authTokenIn ? authTokenIn.replace(/^Bearer\s+/i, '') : '') ||
            apiKey ||
            (googApiKey ? googApiKey.replace(/^Bearer\s+/i, '') : '');
        if (incomingKey) {
            authHeaders['Authorization'] = `Bearer ${incomingKey}`;
        }
    }

    // Parse request body
    let requestBody = await request.json() as Record<string, unknown>;
    logPipelineStage(activeLogger, requestId, 'inbound', url.pathname, requestBody);
    logPipelineHeaders(activeLogger, requestId, 'inbound', url.pathname, request.headers);

    // Detect Gemini CLI and force non-streaming to avoid JSON parsing issues
    const userAgent = request.headers.get('user-agent') || '';
    if (userAgent.includes('gemini-cli')) {
        activeLogger.debug(requestId, 'Gemini CLI detected');
    }
    
    activeLogger.debug(requestId, `Request body keys: ${Object.keys(requestBody).join(', ')}`);

    let openaiRequest: Record<string, unknown>;
    let isStreaming: boolean;

    // before_conversion: client-schema transforms that need route/upstreamMode known
    // but must run before the format converter sees the body.
    if (route) {
      const hookCtxConv: HookContext = {
        hook: 'before_conversion',
        route,
        upstreamMode: upstreamMode || 'openai-completions',
        clientModel: (requestBody.model as string) || modelId || 'unknown',
        requestId,
        streaming: requestBody.stream === true,
        logger: activeLogger,
      };
      ({ body: requestBody } = runHook('before_conversion', { body: requestBody, headers: authHeaders }, hookCtxConv));
    }

    // Detect input format and convert to OpenAI
    if (isGeminiInteractionsRequest(requestBody)) {
      activeLogger.debug(requestId, 'Converting Gemini request to OpenAI format');
      
      // Check if it's generateContent format (has contents array)
      if (Array.isArray(requestBody.contents)) {
        activeLogger.debug(requestId, 'Detected generateContent format with contents array');
        // Register the inbound tool-parameter schemas so the egress converter can
        // coerce the model's tool-call args into the declared JSON types.
        if (Array.isArray(requestBody.tools)) {
          const schemasByName = new Map<string, Record<string, unknown>>();
          for (const tool of requestBody.tools as Array<Record<string, unknown>>) {
            const fds = tool.functionDeclarations as Array<Record<string, unknown>> | undefined;
            if (Array.isArray(fds)) {
              for (const fd of fds) {
                if (typeof fd.name === 'string' && fd.parameters && typeof fd.parameters === 'object') {
                  schemasByName.set(fd.name, fd.parameters as Record<string, unknown>);
                }
              }
            }
          }
          if (schemasByName.size > 0) registerGeminiToolSchemas(requestId, schemasByName);
        }
        openaiRequest = convertGeminiGenerateContentToOpenAI(requestBody);
      } else {
        activeLogger.debug(requestId, 'Detected Interactions format with input field');
        openaiRequest = convertGeminiInteractionsToOpenAI(requestBody);
      }
      
      isStreaming = (openaiRequest.stream as boolean) === true;
    } else {
      // Assume Claude format
      activeLogger.debug(requestId, 'Converting Claude request to OpenAI format');
      const claudeRequest = requestBody as unknown as ClaudeMessagesRequest;
      const converted = convertClaudeToOpenAIRequest(claudeRequest, modelId || claudeRequest.model);
      openaiRequest = converted as unknown as Record<string, unknown>;
      isStreaming = claudeRequest.stream === true;
    }

    // Override model if provided
    if (modelId) {
      openaiRequest.model = modelId;
    }

    // Force streaming for ?alt=sse query parameter
    if (forceStreaming || isStreamRequest) {
      openaiRequest.stream = true;
      isStreaming = true;
    }

    if (isGeminiEndpoint && (!upstreamMode || upstreamMode === 'openai-completions')) {
      defaultMissingOpenAIMessageRoles(openaiRequest);
    }

    // Cross-mode routes: re-target the converted Completions body to a different
    // upstream family. Done after the Gemini/Claude → Completions conversion so
    // we reuse that conversion ("through openai-completions transforming").
    if (upstreamMode === 'anthropic-messages') {
      return forwardCompletionsAsAnthropicMessages(
        openaiRequest, targetUrl, authHeaders, requestId,
        openaiRequest.model as string, activeLogger, request, env, route,
      );
    }
    if (upstreamMode === 'openai-responses') {
      return forwardCompletionsAsOpenAIResponses(
        openaiRequest, targetUrl, authHeaders, requestId,
        openaiRequest.model as string, activeLogger, request, env,
        isInteractionsRequest, isGenerateContentRequest, isStreaming, route,
      );
    }

    // Log request info
    activeLogger.debug(requestId, `OpenAI upstream url: ${targetUrl}`);
    activeLogger.debug(requestId, `Model: ${openaiRequest.model}, stream=${isStreaming}`);
    const authBaerer = authHeaders['Authorization'] || '';
    activeLogger.debug(requestId, `Authorization: ${authBaerer.substring(0, 16)}... upstream`);

    // Prepare headers
    let headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...authHeaders,
    };

    try {
        // Check if this is an SDK URL
        if (isSdkUrl(targetUrl)) {
            // Extract API key from auth headers
            let apiKey: string | undefined;
            if (authHeaders['Authorization']) {
                apiKey = authHeaders['Authorization'].replace('Bearer ', '');
            } else if (authHeaders['x-api-key']) {
                apiKey = authHeaders['x-api-key'];
            } else if (authHeaders['x-goog-api-key']) {
                apiKey = authHeaders['x-goog-api-key'];
            }

            // Use SDK handler for OpenAI requests
            return handleSdkOpenAIRequest(
                request,
                targetUrl,
                requestId,
                apiKey,
                modelId,
                activeLogger,
                env,
                undefined,
                'openai',
                conversionOptions
            );
        }

        // before_upstream: apply declared transforms to the upstream body.
        // (max_tokens → max_completion_tokens rename handled by the transform engine)
        let upstreamBody: Record<string, unknown> = openaiRequest as unknown as Record<string, unknown>;
        if (route) {
          const hookCtx: HookContext = {
            hook: 'before_upstream',
            route,
            upstreamMode: upstreamMode || 'openai-completions',
            clientModel: (openaiRequest.model as string) || modelId || 'unknown',
            requestId,
            streaming: isStreaming,
            logger: activeLogger,
          };
          ({ body: upstreamBody, headers } = runHook('before_upstream', { body: upstreamBody, headers }, hookCtx));
        }
        logPipelineStage(activeLogger, requestId, 'upstream-request', targetUrl, upstreamBody);
        const openaiFetchHeaders = addForwardedHeaders(headers, request);
        logPipelineHeaders(activeLogger, requestId, 'upstream-request', targetUrl, openaiFetchHeaders);
        let response = await fetch(targetUrl, {
            method: 'POST',
            headers: openaiFetchHeaders,
            body: JSON.stringify(upstreamBody),
            signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
        });

        if (route) {
          response = await applyAfterUpstream(response, {
            hook: 'after_upstream', route,
            upstreamMode: upstreamMode || 'openai-completions',
            clientModel: (openaiRequest.model as string) || modelId || 'unknown',
            requestId, streaming: isStreaming, logger: activeLogger,
          });
        }

        logPipelineHeaders(activeLogger, requestId, 'upstream-response', targetUrl, response.headers);
        recordResponseStatusCodeFromUpstream(response.status);
        recordUpstreamResponseToolCount('openai-completions', 0);
        recordUpstreamRateLimit((openaiRequest.model as string) || modelId, (name) => response.headers.get(name), targetUrl);

        // Handle target API errors
        if (!response.ok) {
            const errorText = await response.text();
            activeLogger.debug(requestId, `OpenAI API error: ${response.status} ${errorText}`);
            handleTargetApiError(response, 'OpenAI API', { url: targetUrl, upstreamBody: errorText });
        }

        // Handle streaming response
        if (isStreaming) {
            return handleOpenAIStreamingResponse(response, openaiRequest.model as string, requestId, activeLogger, isInteractionsRequest, isGenerateContentRequest);
        }

        // Handle non-streaming response
        return handleOpenAINonStreamingResponse(response, openaiRequest.model as string, requestId, activeLogger, isInteractionsRequest, isGenerateContentRequest);

    } catch (error) {
        activeLogger.debug(requestId, `OpenAI API error: ${(error as Error).message}`);
        throw error;
    }
}

/**
 * Handle OpenAI streaming response
 */
async function handleOpenAIStreamingResponse(
    response: Response,
    modelId: string,
    requestId: string,
    logger: Logger,
    isInteractionsRequest: boolean = false,
    isGenerateContentRequest: boolean = false
): Promise<Response> {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    logger.debug(requestId, `OpenAI streaming response started, status: ${response.status}, ok: ${response.ok}`);

    // Process stream
    (async () => {
        try {
            const reader = response.body?.getReader();
            if (!reader) {
                logger.error(requestId, 'No response body in streaming response');
                throw new Error('No response body');
            }

            let buffer = '';
            let chunkCount = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done) {
                    logger.debug(requestId, `Stream ended, processed ${chunkCount} chunks`);
                    break;
                }

                // Append to buffer
                const rawChunk = new TextDecoder().decode(value);
                buffer += rawChunk;
                chunkCount++;
                logPipelineStage(logger, requestId, 'upstream-response', response.url || '(upstream SSE)', rawChunk);

                // Process complete SSE events
                const { processed, remaining } = processSSEBuffer(buffer, modelId, requestId, isInteractionsRequest, isGenerateContentRequest);
                buffer = remaining;

                if (processed) {
                    logPipelineStage(logger, requestId, 'outbound', 'stream', processed);
                    await writer.write(encoder.encode(processed));
                }
            }

            // Process any remaining buffer
            if (buffer.trim()) {
                const { processed } = processSSEBuffer(buffer + '\n\n', modelId, requestId, isInteractionsRequest, isGenerateContentRequest);
                if (processed) {
                    logPipelineStage(logger, requestId, 'outbound', 'stream (final)', processed);
                    await writer.write(encoder.encode(processed));
                }
            }

            await writer.close();
        } catch (error) {
            logger.error(requestId, `OpenAI streaming error: ${(error as Error).message}`);
            await writer.abort();
        } finally {
            // Prevent leaking per-request buffer entries if the stream errors out
            // before [DONE] triggers the normal cleanup.
            clearGeminiSSEState(requestId);
        }
    })();

    const openaiStreamOutHeaders = {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
    };
    logPipelineHeaders(logger, requestId, 'outbound', 'stream', openaiStreamOutHeaders);
    return new Response(readable, { headers: openaiStreamOutHeaders });
}

/**
 * Handle OpenAI non-streaming response
 */
async function handleOpenAINonStreamingResponse(
    response: Response,
    modelId: string,
    requestId: string,
    logger: Logger,
    isInteractionsRequest: boolean = false,
    isGenerateContentRequest: boolean = false
): Promise<Response> {
    const responseText = await response.text();
    logPipelineStage(logger, requestId, 'upstream-response', response.url || '(upstream)', responseText);
    const openaiResponse = JSON.parse(responseText) as Record<string, unknown>;

    if (isGenerateContentRequest) {
        // Convert to Gemini generateContent format
        const geminiResponse = convertOpenAIToGeminiGenerateContent(
            openaiResponse as any,
            modelId,
            requestId
        );
        // Non-streaming path has no [DONE]/finally cleanup; release the schema map.
        clearGeminiToolSchemas(requestId);
        logPipelineStage(logger, requestId, 'outbound', ':generateContent', geminiResponse);

        const genContentOutHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
        logPipelineHeaders(logger, requestId, 'outbound', ':generateContent', genContentOutHeaders);
        return new Response(JSON.stringify(geminiResponse), { headers: genContentOutHeaders });
    } else if (isInteractionsRequest) {
        // Convert to Interactions format
        const interactionResponse = convertOpenAIToGeminiInteractions(
            openaiResponse as any,
            modelId,
            requestId
        );
        logPipelineStage(logger, requestId, 'outbound', '/v1/interactions', interactionResponse);

        const interactionsOutHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
        logPipelineHeaders(logger, requestId, 'outbound', '/v1/interactions', interactionsOutHeaders);
        return new Response(JSON.stringify(interactionResponse), { headers: interactionsOutHeaders });
    }

    // Convert to Claude format
    const claudeResponse = convertOpenAIToClaudeResponse(openaiResponse as any, modelId, requestId);
    logPipelineStage(logger, requestId, 'outbound', '/v1/messages', claudeResponse);

    const claudeOutHeaders = { 'Content-Type': 'application/json' };
    logPipelineHeaders(logger, requestId, 'outbound', '/v1/messages', claudeOutHeaders);
    return new Response(JSON.stringify(claudeResponse), { headers: claudeOutHeaders });
}

/**
 * Convert OpenAI streaming chunk to Claude format
 */
// Per-request buffer for <think>/<thinking> tags that may straddle SSE events,
// keyed by requestId. Concurrent streams interleave on the event loop across
// `await reader.read()` suspension points, so a single shared string would
// corrupt unrelated requests' text. Cleared on [DONE] / stream completion.
let thinkStreamBuffers: Map<string, string> = new Map();

// Per-request accumulation of streaming OpenAI tool_calls for the Gemini output
// paths, keyed by requestId -> tool_call index. Upstreams like DeepSeek fragment
// a single tool call across chunks: the first chunk carries id+name+partial-args,
// continuation chunks carry only more argument text at the same index. Emitting
// a Gemini functionCall per fragment produces name-less "call_undefined" calls,
// so we buffer by index and flush one complete functionCall when finish_reason
// arrives. Keyed by requestId (not just index) for the same reason as
// thinkStreamBuffers above — concurrent requests must not share state.
interface GeminiToolCallAccum { id: string; name: string; args: string; }
let geminiToolCallBuffers: Map<string, Map<number, GeminiToolCallAccum>> = new Map();

/** Remove all per-request SSE conversion state for a finished/aborted request. */
function clearGeminiSSEState(requestId: string): void {
    thinkStreamBuffers.delete(requestId);
    geminiToolCallBuffers.delete(requestId);
    clearGeminiToolSchemas(requestId);
}

/**
 * Process SSE buffer and extract complete events
 */
function processSSEBuffer(buffer: string, modelId: string, requestId: string, isInteractionsRequest: boolean = false, isGenerateContentRequest: boolean = false): { processed: string; remaining: string } {
    let result = '';
    let remaining = buffer;
    
    // Split by double newline (SSE event separator)
    const events = buffer.split('\n\n');
    
    // Last element might be incomplete, keep it in buffer
    remaining = events.pop() || '';

    let toolCallBuffer = geminiToolCallBuffers.get(requestId);

    for (const event of events) {
        if (!event.trim()) continue;

        const lines = event.split('\n');
        for (const line of lines) {
            if (line.startsWith('data: ')) {
                const data = line.slice(6).trim();
                if (data === '[DONE]') {
                    clearGeminiSSEState(requestId);
                    toolCallBuffer = undefined;
                    if (isGenerateContentRequest) {
                        // Gemini generateContent doesn't need explicit end marker
                        continue;
                    } else {
                        result += 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
                    }
                } else {
                    try {
                        const parsed = JSON.parse(data);

                        // Stitch cross-chunk think tags: prepend any partial thinkStreamBuffer to current content
                        const thinkBuffered = thinkStreamBuffers.get(requestId);
                        if (thinkBuffered && parsed?.choices?.[0]?.delta?.content) {
                            parsed.choices[0].delta.content = thinkBuffered + parsed.choices[0].delta.content;
                            thinkStreamBuffers.delete(requestId);
                        }

                        // For the Gemini output paths, accumulate fragmented streaming
                        // tool_calls across chunks and strip them from the delta so the
                        // stateless converter never emits a partial functionCall. Flush
                        // complete calls when finish_reason arrives (handled below).
                        if (isGenerateContentRequest || isInteractionsRequest) {
                            const deltaToolCalls = parsed?.choices?.[0]?.delta?.tool_calls;
                            if (Array.isArray(deltaToolCalls)) {
                                if (!toolCallBuffer) { toolCallBuffer = new Map(); geminiToolCallBuffers.set(requestId, toolCallBuffer); }
                                for (const tc of deltaToolCalls) {
                                    const idx = typeof tc.index === 'number' ? tc.index : 0;
                                    let acc = toolCallBuffer.get(idx);
                                    if (!acc) {
                                        acc = { id: '', name: '', args: '' };
                                        toolCallBuffer.set(idx, acc);
                                    }
                                    if (tc.id) acc.id = tc.id;
                                    if (tc.function?.name) acc.name = tc.function.name;
                                    if (typeof tc.function?.arguments === 'string') acc.args += tc.function.arguments;
                                }
                                // Remove tool_calls from this chunk; they are emitted on flush.
                                delete parsed.choices[0].delta.tool_calls;
                            }
                        }

                        let convertedChunk: Record<string, any> | null = null;

                        if (isGenerateContentRequest) {
                            // Convert to Gemini generateContent format
                            convertedChunk = convertOpenAIToGeminiGenerateContent(parsed, modelId, requestId);
                        } else if (isInteractionsRequest) {
                            // Convert to Gemini Interactions format
                            convertedChunk = convertOpenAIToGeminiInteractions(parsed, modelId, requestId);
                        } else {
                            // Convert to Claude format
                            convertedChunk = convertOpenAIToClaudeResponse(parsed, modelId, requestId);
                        }

                        // Flush accumulated tool calls when the turn finishes, injecting
                        // them as complete functionCall parts into the converted chunk.
                        const finishReason = parsed?.choices?.[0]?.finish_reason;
                        if ((isGenerateContentRequest || isInteractionsRequest) && finishReason && toolCallBuffer && toolCallBuffer.size > 0) {
                            const accumulated = Array.from(toolCallBuffer.values()).filter(a => a.name);
                            toolCallBuffer.clear();
                            geminiToolCallBuffers.delete(requestId);
                            const synthetic = {
                                choices: [{
                                    index: 0,
                                    delta: {},
                                    message: {
                                        role: 'assistant',
                                        content: '',
                                        tool_calls: accumulated.map(a => ({
                                            id: a.id, type: 'function',
                                            function: { name: a.name, arguments: a.args },
                                        })),
                                    },
                                    finish_reason: finishReason,
                                }],
                            };
                            convertedChunk = isGenerateContentRequest
                                ? convertOpenAIToGeminiGenerateContent(synthetic, modelId, requestId)
                                : convertOpenAIToGeminiInteractions(synthetic, modelId, requestId);
                        }

                        // If converter didn't consume the buffer-tail (tag never closed), carry it forward
                        const emittedContent: string | undefined = parsed?.choices?.[0]?.delta?.content;
                        if (emittedContent) {
                            const partialOpen = emittedContent.lastIndexOf('<');
                            if (partialOpen !== -1 && !emittedContent.slice(partialOpen).includes('>')) {
                                thinkStreamBuffers.set(requestId, emittedContent.slice(partialOpen));
                            }
                        }
                        
                        // Skip chunks with no endpoint-specific payload.
                        if (!convertedChunk || (!convertedChunk.candidates && !convertedChunk.content && !convertedChunk.outputs)) {
                            continue;
                        }
                        
                        result += `data: ${JSON.stringify(convertedChunk)}\n\n`;
                    } catch {
                        // Skip invalid JSON
                    }
                }
            }
        }
    }
    
    return { processed: result, remaining };
}

function convertOpenAIStreamToClaude(chunk: string, modelId: string, requestId: string): string | null {
    // Parse and convert OpenAI SSE format to Claude format
    const lines = chunk.split('\n');
    let result = '';
    
    for (const line of lines) {
        if (line.startsWith('data: ')) {
            const data = line.slice(6);
            if (data.trim() === '[DONE]') {
                result += 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
            } else {
                try {
                    const parsed = JSON.parse(data);
                    // Convert OpenAI chunk to Claude chunk format
                    const claudeChunk = convertOpenAIToClaudeResponse(parsed, modelId, requestId);
                    result += `data: ${JSON.stringify(claudeChunk)}\n\n`;
                } catch {
                    // Pass through if parsing fails
                    result += line + '\n';
                }
            }
        }
    }
    
    return result || null;
}
