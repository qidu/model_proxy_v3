import { ClaudeMessagesRequest, ClaudeMessagesResponse } from '../types/claude.js';
import { convertClaudeToOpenAIRequest, ThinkingConversionOptions } from '../converters/claude-to-openai.js';
import { convertOpenAIToClaudeResponse } from '../converters/openai-to-claude.js';
import { convertOpenAIToGeminiGenerateContent, convertOpenAIToGeminiInteractions, registerGeminiToolSchemas, clearGeminiToolSchemas } from '../converters/openai-to-gemini.js';
import { createLogger, logPipelineStage, logPipelineHeaders } from '../utils/logger.js';
import { isSdkUrl, handleSdkOpenAIRequest } from '../utils/sdk-handler.js';
import type { Env, Logger } from '../types/shared.js';
import { addForwardedHeaders } from '../utils/routing.js';
import { resolveIncomingAuthorization, normalizeOpenAIAuthHeaders, ensureStructuredOutputsBetaHeader } from '../utils/auth-headers.js';
import { runHook, applyAfterUpstream, type HookContext } from '../utils/request-transform.js';
import type { ModelRouteConfig } from '../utils/config-loader.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { recordResponseStatusCodeFromUpstream, recordUpstreamResponseToolCount } from '../utils/dashboard-stats.js';
import { recordUpstreamRateLimit } from '../utils/provider-quota.js';
import { handleTargetApiError, ValidationError } from '../utils/errors.js';
import { OpenAIContent, OpenAIMessage } from '../types/openai.js';
import { decodeDataUriOrRef } from '../converters/claude-to-gemini.js';
import { fetchImageAsInlineData } from '../utils/image-fetch.js';
import { isBlobRef, rebindBlobRef } from '../utils/blob-refs.js';
import { postJsonWithSpool } from '../utils/spool-json.js';
import { receiveJsonResponse, withResponseText } from '../utils/spool-response.js';

import { handleCrossModeStreamingResponse, processSSEBuffer, clearGeminiSSEState } from './cross-mode-stream.js';
import {
  convertGeminiGenerateContentToOpenAI,
  convertGeminiInteractionsToOpenAI,
  isGeminiInteractionsRequest,
  defaultMissingOpenAIMessageRoles,
} from '../converters/gemini-to-openai.js';

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
 * `image_url` parts are forwarded as `input_image`; the Chat Completions
 * `{url, detail}` object is unwrapped into the Responses API's string `image_url`
 * with `detail` as a sibling. The Responses upstream performs its own fetch — no
 * in-proxy SSRF-guarded fetch is needed.
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
      // The Responses API wants `image_url` as a plain string — a fully qualified URL
      // or a base64 data URL — with `detail` as a *sibling* on the item
      // (`docs/api/openai-response-methods-create.md`: "image_url: optional string or
      // null"). That is the opposite of the Chat Completions shape arriving here, where
      // `image_url` is an object, so it is unwrapped; a client that already sent the
      // string form is passed through unchanged.
      const image = part.image_url as { url?: unknown; detail?: unknown } | string | undefined;
      if (typeof image === 'string') {
        parts.push({ type: 'input_image', image_url: image });
      } else {
        const imagePart: Record<string, unknown> = { type: 'input_image', image_url: image?.url };
        if (image?.detail !== undefined) imagePart.detail = image.detail;
        parts.push(imagePart);
      }
    }
    // Unknown part types (e.g. thinking) are skipped here.
  }
  return parts;
}

/**
 * Emit a Responses `reasoning` item for each `thinking` content part on an assistant
 * message. Called where the message item is pushed rather than up front, so the item
 * order matches the `/v1/messages` converter this one replaced: `reasoning_content`
 * first as the turn's preamble, then the `function_call` items, then this reasoning,
 * then the message. `openAIContentToResponsesParts` skips `thinking` parts, so the
 * text does not also appear as `input_text`/`output_text`.
 */
function pushThinkingReasoning(msg: OpenAIMessage, input: unknown[]): void {
  if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return;
  for (const part of msg.content as unknown as Array<Record<string, unknown>>) {
    if (part.type === 'thinking') {
      input.push({
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: (part.thinking as string) ?? '' }],
      });
    }
  }
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
      const url: unknown = (part.image_url as Record<string, unknown> | undefined)?.url;
      if (typeof url !== 'string' && !isBlobRef(url)) continue;
      if (typeof url === 'string' && url === '') continue;
      const img = isBlobRef(url) || url.startsWith('data:')
        ? decodeDataUriOrRef(url)
        : await fetchImageAsInlineData(url);
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mime_type,
          data: isBlobRef(img.data) ? rebindBlobRef(img.data, 'claude-source-data', '') : img.data,
        },
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

/** The forced function name of a Completions `{type:'function', function:{name}}` tool_choice. */
function completionsForcedToolName(toolChoice: unknown): string | undefined {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  const name = ((toolChoice as Record<string, unknown>).function as Record<string, unknown> | undefined)?.name;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

/** Map a Completions `tool_choice` onto the Claude Messages vocabulary. */
function completionsToolChoiceToClaude(toolChoice: unknown): Record<string, unknown> | undefined {
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'none') return { type: 'none' };
  // Completions' "a tool call and no prose" is Claude's `any`.
  if (toolChoice === 'required') return { type: 'any' };
  const name = completionsForcedToolName(toolChoice);
  return name === undefined ? undefined : { type: 'tool', name };
}

/** Map a Completions `tool_choice` onto the Responses vocabulary. */
function completionsToolChoiceToResponses(toolChoice: unknown): unknown {
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') return toolChoice;
  const name = completionsForcedToolName(toolChoice);
  return name === undefined ? undefined : { type: 'function', name };
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
  // Claude carries one top-level `system`, not system turns inside `messages`, so
  // every system-level message — OpenAI's `developer` included — is merged into it
  // in document order, the same join `completionsToResponsesBody` applies to
  // `instructions`. Taking only the first one dropped the others in silence, and
  // two can arrive together: `convertResponsesToChatCompletions` prepends a system
  // message from `instructions` and maps every `developer` input item to role
  // `system`, so `/v1/responses` reaches this hop with a pair.
  const systemText = messages
    .filter(m => m.role === 'system' || m.role === 'developer')
    .map(m => openAIContentToText(m.content))
    .filter(text => text !== '')
    .join('\n');
  const otherMessages = messages.filter(m => m.role !== 'system' && m.role !== 'developer');

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
    // Legacy `max_tokens` wins when both names are present; `max_completion_tokens`
    // is the newer OpenAI spelling and is the only one some clients send.
    max_tokens: (completions.max_tokens as number | undefined)
      ?? (completions.max_completion_tokens as number | undefined)
      ?? 4096,
    stream: completions.stream === true,
  };

  // Omitted entirely when every system message was empty or absent, as the
  // sibling converter does with `if (instructions)`.
  if (systemText) claudeBody.system = systemText;
  if (completions.temperature !== undefined) claudeBody.temperature = completions.temperature;
  if (completions.top_p !== undefined) claudeBody.top_p = completions.top_p;
  if (completions.stop !== undefined) claudeBody.stop_sequences = Array.isArray(completions.stop) ? completions.stop : [completions.stop as string];

  // Structured output: Completions spells it `response_format`, the Messages API
  // `output_config.format`. Anthropic has no schema-less JSON mode — the format's
  // `type` is always `json_schema` and its `schema` is required — so a Completions
  // `json_object` (a valid JSON object, no declared shape) becomes the permissive
  // object schema, the closest expressible equivalent. `text` asks for the default
  // and an unmapped `type` stays unmapped, as in `completionsToResponsesBody`.
  const responseFormat = completions.response_format as Record<string, unknown> | undefined;
  if (responseFormat && typeof responseFormat === 'object') {
    if (responseFormat.type === 'json_object') {
      claudeBody.output_config = { format: { type: 'json_schema', schema: { type: 'object' } } };
    } else if (responseFormat.type === 'json_schema') {
      const jsonSchema = responseFormat.json_schema as Record<string, unknown> | undefined;
      const schema = jsonSchema?.schema;
      // `format.schema` is required. Sending the request without one would only
      // be rejected upstream with a less useful message, and dropping the field
      // would lose the client's guarantee without saying so (repo rule #8).
      if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        throw new ValidationError("response_format json_schema requires a 'json_schema.schema' object");
      }
      claudeBody.output_config = { format: { type: 'json_schema', schema } };
    }
  }

  if (completions.tools && Array.isArray(completions.tools) && (completions.tools as unknown[]).length > 0) {
    claudeBody.tools = (completions.tools as Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>).map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));

    // Gated on the tools above: Claude rejects a tool_choice with no tools.
    const toolChoice = completionsToolChoiceToClaude(completions.tool_choice);
    if (toolChoice !== undefined) claudeBody.tool_choice = toolChoice;
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

    // Reasoning round-trip. An OpenAI thinking-mode upstream (DeepSeek) sets
    // `reasoning_content` on the assistant message, and a `thinking` content part
    // carries the same text; either must come back as a Responses `reasoning` item on
    // the next turn or the upstream rejects it with "reasoning_content must be passed
    // back". Taken from the `/v1/messages` converter, which had this and this one did
    // not — the same body shape reaches both.
    //
    // Only the `reasoning_content` half is emitted here. A `thinking` content part is
    // emitted by `pushThinkingReasoning` where the message item is pushed, which keeps
    // the item order this converter inherited: the preamble reasoning first, then the
    // turn's `function_call` items, then the reasoning carried inside `content[]`, then
    // the message.
    if (msg.role === 'assistant') {
      const inlineReasoning = (msg as unknown as Record<string, unknown>).reasoning_content;
      if (typeof inlineReasoning === 'string' && inlineReasoning) {
        input.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text: inlineReasoning }] });
      }
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
      pushThinkingReasoning(msg, input);
      const contentParts = openAIContentToResponsesParts(msg.content, 'output_text');
      if (msg.content !== '' && contentParts.length > 0) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: contentParts,
        });
      }
      continue;
    }

    if (msg.role === 'tool') {
      // `output` must be a string. A string passes through unchanged and an array of
      // parts is text-extracted as before; anything else is serialized, because a client
      // may send the tool result as an object and the text extractor yields '' for it —
      // that silently dropped the whole result. The serialize branch is the
      // `/v1/messages` converter's rule, kept when the two merged
      // (`tests/unit/messages-handler.test.ts`).
      const toolContent = msg.content;
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: typeof toolContent === 'string'
          ? toolContent
          : Array.isArray(toolContent)
            ? openAIContentToText(toolContent)
            : JSON.stringify(toolContent ?? ''),
      });
      continue;
    }

    // Prior assistant turns replayed as input must use `output_text` (mirrors what
    // the upstream originally emitted); user turns use `input_text`.
    const textType = msg.role === 'assistant' ? 'output_text' : 'input_text';
    const contentParts = openAIContentToResponsesParts(msg.content, textType);
    pushThinkingReasoning(msg, input);
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
  // Legacy `max_tokens` wins when both names are present; `max_completion_tokens` is the
  // newer OpenAI spelling and is the only one some clients send. Same precedence as
  // `completionsToClaudeBody`. Carrying only the legacy name left a client that used the
  // newer one with no output bound at all on a Responses upstream.
  const maxOutputTokens = (completions.max_tokens as number | undefined)
    ?? (completions.max_completion_tokens as number | undefined);
  if (maxOutputTokens !== undefined) responsesBody.max_output_tokens = maxOutputTokens;
  if (completions.prompt_cache_key !== undefined) responsesBody.prompt_cache_key = completions.prompt_cache_key;
  // Retention and reasoning: same field name on both sides for `store`; the
  // Completions scalar `reasoning_effort` is the Responses nested `reasoning.effort`.
  // Both are set by `convertGeminiInteractionsToOpenAI` for an Interactions client,
  // and either may already be on the body from a Completions client.
  if (completions.store !== undefined) responsesBody.store = completions.store;
  if (completions.reasoning_effort !== undefined) {
    responsesBody.reasoning = { effort: completions.reasoning_effort };
  }
  // Structured output: Chat Completions spells it `response_format`, the Responses
  // API `text.format`. The inverse of `responses-to-completions.ts:197-213`, which is
  // the shape unwrapped here. A `type` outside the three it accepts is left unmapped,
  // as it was before this mapping existed rather than throwing on a shared converter.
  const responseFormat = completions.response_format as Record<string, unknown> | undefined;
  if (responseFormat && typeof responseFormat === 'object') {
    if (responseFormat.type === 'json_schema') {
      const jsonSchema = responseFormat.json_schema as Record<string, unknown> | undefined;
      responsesBody.text = {
        format: {
          type: 'json_schema',
          name: (jsonSchema?.name as string) ?? 'response',
          schema: jsonSchema?.schema,
          ...(jsonSchema?.strict !== undefined ? { strict: jsonSchema.strict } : {}),
        },
      };
    } else if (responseFormat.type === 'json_object' || responseFormat.type === 'text') {
      responsesBody.text = { format: { type: responseFormat.type } };
    }
  }
  if (completions.tools && Array.isArray(completions.tools) && (completions.tools as unknown[]).length > 0) {
    responsesBody.tools = (completions.tools as Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>).map(t => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));

    // Gated on the tools above: a tool_choice with no tools is rejected upstream.
    const toolChoice = completionsToolChoiceToResponses(completions.tool_choice);
    if (toolChoice !== undefined) responsesBody.tool_choice = toolChoice;
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
  let claudeBody = await completionsToClaudeBody(openaiRequest, model);

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
  // Declared transforms and the per-entry maxTokens cap both run inside this hook
  // (`applyMaxTokensCap`, src/utils/request-transform.ts). Every other egress in the
  // repo runs it — including this function's sibling
  // `forwardCompletionsAsOpenAIResponses` — but this one did not, so an
  // anthropic-messages route reached from /v1/interactions or :generateContent
  // silently ignored both. Placed after the thinking-block fixup above so a
  // transform sees the body as it will actually be sent.
  if (route) {
    const hookCtx: HookContext = {
      hook: 'before_upstream', route,
      upstreamMode: 'anthropic-messages',
      clientModel: model, requestId, streaming: claudeBody.stream === true, logger,
    };
    ({ body: claudeBody, headers: authHeaders } = runHook('before_upstream', { body: claudeBody, headers: authHeaders }, hookCtx));
  }
  logger.debug(requestId, `Interactions/generateContent -> anthropic-messages body: ${JSON.stringify(claudeBody).substring(0, 500)}`);
  logPipelineStage(logger, requestId, 'upstream-request', targetUrl, claudeBody);

  // anthropic-messages expects x-api-key (or Authorization). Normalize headers.
  const anthropicHeaders: Record<string, string> = { ...authHeaders };
  ensureStructuredOutputsBetaHeader(anthropicHeaders, claudeBody);
  if (anthropicHeaders['x-api-key']) {
    delete anthropicHeaders['Authorization'];
  }

  const anthropicFetchHeaders = {
    'Content-Type': 'application/json',
    ...addForwardedHeaders(anthropicHeaders, originalRequest),
  };
  logPipelineHeaders(logger, requestId, 'upstream-request', targetUrl, anthropicFetchHeaders);
  const response = await postJsonWithSpool(targetUrl, claudeBody, {
    headers: anthropicFetchHeaders,
    signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
  });

  logPipelineHeaders(logger, requestId, 'upstream-response', targetUrl, response.headers);
  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('anthropic-messages', 0);
  recordUpstreamRateLimit(model, (name) => response.headers.get(name), targetUrl);

  if (!response.ok) {
    const upstreamBody = await withResponseText(response, requestId, logger, targetUrl, (text) => text, originalRequest.signal);
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

  // §5.7: one bounded receive instead of `response.text()` — above
  // `threshold_bytes` the body lives on this response's spill while it is
  // received, and `max_response_bytes` caps it.
  const claudeJson = await receiveJsonResponse<Record<string, unknown>>(
    response, requestId, logger, targetUrl, originalRequest.signal,
  );
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
  let response = await postJsonWithSpool(targetUrl, responsesBody, {
    headers: responsesFetchHeaders,
    signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
  });

  if (route) {
    response = await applyAfterUpstream(response, {
      hook: 'after_upstream', route, upstreamMode: 'openai-responses',
      clientModel: model, requestId, streaming: isStreaming ?? false, logger,
      signal: originalRequest.signal,
    });
  }

  logPipelineHeaders(logger, requestId, 'upstream-response', targetUrl, response.headers);
  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('openai-responses', 0);
  recordUpstreamRateLimit(model, (name) => response.headers.get(name), targetUrl);

  if (!response.ok) {
    const upstreamBody = await withResponseText(response, requestId, logger, targetUrl, (text) => text, originalRequest.signal);
    logger.error(requestId, `Interactions/generateContent->openai-responses error: ${response.status}, URL: ${targetUrl}`);
    handleTargetApiError(response, 'Interactions/generateContent (via openai-responses)', { url: targetUrl, upstreamBody });
  }

  if (isStreaming) {
    return handleCrossModeStreamingResponse(response, model, requestId, logger, isInteractionsRequest === true, isGenerateContentRequest === true, 'openai-responses');
  }

  // §5.7: the same bounded receive as the anthropic-messages egress above.
  const responsesJson = await receiveJsonResponse<Record<string, unknown>>(
    response, requestId, logger, targetUrl, originalRequest.signal,
  );
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
        const incomingKey = resolveIncomingAuthorization(request.headers);
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
        openaiRequest = convertGeminiGenerateContentToOpenAI(requestBody, { logger: activeLogger, requestId });
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
        let response = await postJsonWithSpool(targetUrl, upstreamBody, {
            headers: openaiFetchHeaders,
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
            const errorText = await withResponseText(response, requestId, activeLogger, targetUrl, (text) => text, request.signal);
            activeLogger.debug(requestId, `OpenAI API error: ${response.status} ${errorText}`);
            handleTargetApiError(response, 'OpenAI API', { url: targetUrl, upstreamBody: errorText });
        }

        // Handle streaming response
        if (isStreaming) {
            return handleOpenAIStreamingResponse(response, openaiRequest.model as string, requestId, activeLogger, isInteractionsRequest, isGenerateContentRequest);
        }

        // Handle non-streaming response
        return handleOpenAINonStreamingResponse(response, openaiRequest.model as string, requestId, activeLogger, isInteractionsRequest, isGenerateContentRequest, request.signal);

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
    isGenerateContentRequest: boolean = false,
    signal?: AbortSignal
): Promise<Response> {
    // §5.7: one bounded receive instead of `response.text()`, parsed once and
    // released before the converted body is built.
    const openaiResponse = await receiveJsonResponse<Record<string, unknown>>(
        response, requestId, logger, response.url || '(upstream)', signal,
    );

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
