/**
 * Responses API handler for Claude Proxy v3
 *
 * Handles POST /responses endpoint (OpenAI Responses API format)
 * Supports both OpenAI Responses API pass-through and conversion to Chat Completions
 */

import { Env } from '../types/shared.js';
import { Logger, createLogger, logPipelineStage, logPipelineHeaders } from '../utils/logger.js';
import { OpenAIRequest, OpenAIResponse } from '../types/openai.js';
import { handleTargetApiError, createErrorResponse } from '../utils/errors.js';
import { addForwardedHeaders, normalizeOpenAIAuthHeaders } from '../utils/routing.js';
import { runHook, applyAfterUpstream, type HookContext } from '../utils/request-transform.js';
import type { ModelRouteConfig } from '../utils/config-loader.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { convertResponsesToChatCompletions, getNamespaceMap } from '../converters/responses-to-completions.js';
import { convertCompletionsToResponses, convertCompletionsToCompactedResponse } from '../converters/completions-to-responses.js';
import { getConversation, saveConversation, normalizeInputToItems, getConversationThreadItems, appendConversationThreadItems } from '../utils/conversation-store.js';
import { recordResponseStatusCodeFromUpstream, recordUpstreamResponseToolCount } from '../utils/dashboard-stats.js';
import { recordUpstreamRateLimit } from '../utils/provider-quota.js';
import { handleGeminiRequestForMessages } from './gemini.js';
import { completionsToClaudeBody } from './openai.js';

/**
 * Short-lived store: tool call ID → reasoning_content string.
 *
 * When a thinking-mode upstream (DeepSeek) returns reasoning_content alongside
 * tool_calls, the Codex SDK echoes back the tool_calls on the next turn but
 * does NOT include the reasoning.  The upstream then rejects with
 * "reasoning_content must be passed back".
 *
 * We solve this server-side: store the reasoning keyed by each call_id from
 * the response, then look it up when those call_ids appear in a later request
 * and inject reasoning_content onto the assistant messages we create.
 *
 * Entries auto-expire after 10 minutes so the map stays bounded.
 */
const reasoningByCallId = new Map<string, { reasoning: string; expiry: number }>();
const REASONING_TTL_MS = 10 * 60 * 1000; // 10 minutes

function storeReasoningForCalls(callIds: string[], reasoning: string) {
  if (!reasoning || callIds.length === 0) return;
  const expiry = Date.now() + REASONING_TTL_MS;
  for (const id of callIds) {
    reasoningByCallId.set(id, { reasoning, expiry });
  }
}

function lookupReasoningForCall(callId: string): string | undefined {
  const entry = reasoningByCallId.get(callId);
  if (!entry) return undefined;
  if (Date.now() > entry.expiry) {
    reasoningByCallId.delete(callId);
    return undefined;
  }
  return entry.reasoning;
}

/**
 * Handle responses API request
 */
export async function handleResponsesRequest(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  modelId?: string,
  env?: Env,
  logger?: Logger,
  upstreamMode?: string,
  route?: ModelRouteConfig,
): Promise<Response> {
  const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);

  const requestBody = await request.json() as Record<string, unknown>;
  logPipelineStage(activeLogger, requestId, 'inbound', '/v1/responses', requestBody);
  logPipelineHeaders(activeLogger, requestId, 'inbound', '/v1/responses', request.headers);
  const isStreaming = requestBody.stream === true;
  // Alias (modelId) takes precedence over the body's model field, matching the pattern
  // used by the messages handler: `const targetModelId = modelId || claudeRequest.model`
  const model = modelId || (requestBody.model as string) || 'unknown';

  activeLogger.debug(requestId, `Responses API request (stream=${isStreaming}, mode=${upstreamMode}, model=${model}): ${targetUrl}`);

  // Handle based on upstream mode
  if (upstreamMode === 'openai-completions') {
    // Convert Responses API format to Chat Completions format
    return handleAsCompletions(request, targetUrl, authHeaders, requestId, model, activeLogger, requestBody, isStreaming, env, route, upstreamMode);
  }

  if (upstreamMode === 'anthropic-messages') {
    return handleAsAnthropicMessages(request, targetUrl, authHeaders, requestId, model, activeLogger, requestBody, isStreaming, env, route, upstreamMode);
  }

  if (upstreamMode === 'gemini-generatecontent' || upstreamMode === 'gemini-interactions') {
    return handleAsGemini(request, targetUrl, authHeaders, requestId, model, activeLogger, requestBody, isStreaming, env, upstreamMode);
  }

  // Default: Pass through to OpenAI Responses API upstream
  return handleAsPassthrough(request, targetUrl, authHeaders, requestId, activeLogger, requestBody, isStreaming, env, route);
}

/**
 * Handle GET /v1/responses/{response_id} and GET /v1/responses/{response_id}/input_items.
 *
 * Served entirely from the in-memory conversation store (no upstream call).
 * Only available when CONVERSATION_STATE is enabled; otherwise 404. Unknown,
 * expired, or unstored (store: false) response IDs also return 404.
 */
export function handleResponsesRetrievalRequest(
  responseId: string,
  wantInputItems: boolean,
  requestId: string,
  env?: Env,
  logger?: Logger,
): Response {
  const conversationEnabled = env?.CONVERSATION_STATE === 'true' || env?.CONVERSATION_STATE === '1';
  const notFound = (message: string): Response => new Response(
    JSON.stringify({ error: { message, type: 'invalid_request_error', param: null, code: null } }),
    { status: 404, headers: { 'Content-Type': 'application/json', 'x-request-id': requestId } }
  );

  if (!conversationEnabled) {
    logger?.debug(requestId, `[conversation] GET retrieval for ${responseId} but CONVERSATION_STATE is not enabled`);
    return notFound(`Response ${responseId} not found (conversation state is not enabled on this proxy instance).`);
  }

  const entry = getConversation(responseId);
  if (!entry) {
    logger?.debug(requestId, `[conversation] GET retrieval for ${responseId}: not found in store (expired, unknown, or store: false)`);
    return notFound(`Response ${responseId} not found.`);
  }

  if (wantInputItems) {
    const body = { object: 'response.input_items.list', data: entry.inputItems };
    logPipelineStage(logger ?? createLogger({}), requestId, 'outbound', '/v1/responses/{id}/input_items', body);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
    });
  }

  if (!entry.response) {
    return notFound(`Response ${responseId} has no stored response object.`);
  }
  logPipelineStage(logger ?? createLogger({}), requestId, 'outbound', '/v1/responses/{id}', entry.response);
  return new Response(JSON.stringify(entry.response), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
  });
}

/**
 * Convert a Chat Completions body to Claude Messages body.
 * Extracts the system message from the messages array and maps the rest.
 *
 * NOTE: Kept for reference only — the call sites in `handleAsAnthropicMessages`
 * and `handleAsGemini` now reuse the more complete `completionsToClaudeBody`
 * imported from `./openai.js`. That version additionally handles consecutive
 * tool-result grouping, `reasoning_content` → `thinking` blocks, and array
 * `content` with `image_url` parts. This local copy is intentionally retained
 * as a reference for the simpler shape and as a fallback if a future refactor
 * re-decouples the responses handler from openai.ts. Do not add new call sites
 * here — use `completionsToClaudeBody` from `./openai.js` instead.
 *
 * Historical callers (both internal to this file, both now using the openai.ts
 * version instead):
 *
 *   - handleAsAnthropicMessages  — `/v1/responses` → `anthropic-messages` upstream.
 *     Chain: Responses `input` → convertResponsesToChatCompletions → Completions
 *     `messages` → completionsBodyToClaudeBody → Claude body → fetch upstream.
 *
 *   - handleAsGemini             — `/v1/responses` → `gemini-generatecontent` /
 *     `gemini-interactions`. Same chain; handleGeminiRequestForMessages accepts
 *     Claude-format input, so the body still goes through Completions→Claude
 *     before being passed in.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function completionsBodyToClaudeBody(completions: OpenAIRequest, model: string): Record<string, unknown> {
  const messages = completions.messages || [];
  const systemMsg = messages.find(m => m.role === 'system');
  const otherMessages = messages.filter(m => m.role !== 'system');

  const claudeBody: Record<string, unknown> = {
    model,
    messages: otherMessages.map(m => {
      if (m.tool_calls) {
        return {
          role: 'assistant',
          content: m.tool_calls.map(tc => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
          })),
        };
      }
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.tool_call_id,
            content: m.content ?? '',
          }],
        };
      }
      return { role: m.role, content: m.content ?? '' };
    }),
    max_tokens: completions.max_tokens ?? 4096,
    stream: completions.stream === true,
  };

  if (systemMsg) claudeBody.system = systemMsg.content;
  if (completions.temperature !== undefined) claudeBody.temperature = completions.temperature;
  if (completions.top_p !== undefined) claudeBody.top_p = completions.top_p;
  if (completions.stop !== undefined) claudeBody.stop_sequences = Array.isArray(completions.stop) ? completions.stop : [completions.stop];

  if (completions.tools && completions.tools.length > 0) {
    claudeBody.tools = completions.tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters ?? { type: 'object', properties: {} },
    }));
  }

  return claudeBody;
}

/**
 * Convert a Claude Messages JSON response to Responses API format.
 */
function claudeResponseToResponses(claudeJson: Record<string, unknown>, model: string): Record<string, unknown> {
  const content = (claudeJson.content as Array<Record<string, unknown>>) ?? [];
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, '')}`;
  const created_at = Math.floor(Date.now() / 1000);
  const msgId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;

  const outputItems: unknown[] = [];

  // Text content
  const textBlock = content.find(c => c.type === 'text');
  if (textBlock || content.length === 0) {
    outputItems.push({
      id: msgId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: (textBlock?.text as string) ?? '' }],
    });
  }

  // Tool use content
  for (const block of content) {
    if (block.type === 'tool_use') {
      outputItems.push({
        id: block.id ?? `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`,
        type: 'function_call',
        status: 'completed',
        name: block.name,
        arguments: typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {}),
        call_id: block.id ?? `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`,
      });
    }
  }

  const usage = claudeJson.usage as Record<string, unknown> | undefined;
  const cachedTokens = (usage?.cache_read_input_tokens as number | undefined) ?? 0;
  return {
    id: responseId,
    object: 'response',
    created_at,
    status: 'completed',
    model: (claudeJson.model as string) ?? model,
    output: outputItems.length > 0 ? outputItems : [{
      id: msgId,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '' }],
    }],
    usage: usage ? {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      total_tokens: ((usage.input_tokens as number) ?? 0) + ((usage.output_tokens as number) ?? 0),
      input_tokens_details: { cached_tokens: cachedTokens },
    } : undefined,
  };
}

/**
 * Convert a Claude SSE stream to a Responses API SSE stream.
 *
 * Claude SSE events: message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
 * Responses SSE events: response.created, response.output_item.added, response.content_part.added, response.output_text.delta, response.output_text.done, response.output_item.done, response.completed
 */
function streamClaudeAsResponses(
  upstreamResponse: Response,
  model: string,
  requestId: string,
  logger?: Logger,
): Response {
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, '')}`;
  const itemId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const created_at = Math.floor(Date.now() / 1000);

  let sequenceNumber = 0;
  const nextSeq = () => sequenceNumber++;

  const activeLogger = logger ?? createLogger({});

  function sseEvent(event: string, data: unknown): string {
    logPipelineStage(activeLogger, requestId, 'outbound', '/v1/responses (SSE)', data);
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  async function pump() {
    try {
      await writer.write(encoder.encode(sseEvent('response.created', {
        type: 'response.created',
        sequence_number: nextSeq(),
        response: { id: responseId, object: 'response', created_at, status: 'in_progress', model, output: [] },
      })));

      let textPartOpened = false;
      let accumulatedText = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedTokens = 0;
      let buffer = '';
      // Map from Claude block index → whether it's a tool_use block
      const toolBlocks = new Map<number, { id: string; name: string; arguments: string; outputIndex: number }>();
      let nextOutputIndex = 0;

      const reader = upstreamResponse.body?.getReader();
      if (!reader) { await writer.close(); return; }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const rawChunk = decoder.decode(value, { stream: true });
        logPipelineStage(activeLogger, requestId, 'upstream-response', upstreamResponse.url || '(upstream SSE)', rawChunk);
        buffer += rawChunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('event: ')) continue; // handled separately via data
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          let evt: Record<string, unknown>;
          try { evt = JSON.parse(raw); } catch { continue; }

          const type = evt.type as string;

          if (type === 'message_start') {
            const msg = evt.message as Record<string, unknown> | undefined;
            const usage = msg?.usage as Record<string, unknown> | undefined;
            if (usage?.input_tokens) inputTokens = usage.input_tokens as number;
            if (usage?.cache_read_input_tokens) cachedTokens = usage.cache_read_input_tokens as number;
          } else if (type === 'content_block_start') {
            const block = evt.content_block as Record<string, unknown> | undefined;
            const idx = evt.index as number;
            if (block?.type === 'text') {
              if (!textPartOpened) {
                const outputIndex = nextOutputIndex++;
                await writer.write(encoder.encode(sseEvent('response.output_item.added', {
                  type: 'response.output_item.added',
                  sequence_number: nextSeq(),
                  output_index: outputIndex,
                  item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
                })));
                await writer.write(encoder.encode(sseEvent('response.content_part.added', {
                  type: 'response.content_part.added',
                  sequence_number: nextSeq(),
                  item_id: itemId,
                  output_index: outputIndex,
                  content_index: 0,
                  part: { type: 'output_text', text: '' },
                })));
                textPartOpened = true;
              }
            } else if (block?.type === 'tool_use') {
              const outputIndex = nextOutputIndex++;
              const toolId = block.id as string ?? `call_${Date.now()}_${idx}`;
              const toolName = block.name as string ?? '';
              toolBlocks.set(idx, { id: toolId, name: toolName, arguments: '', outputIndex });
              await writer.write(encoder.encode(sseEvent('response.output_item.added', {
                type: 'response.output_item.added',
                sequence_number: nextSeq(),
                output_index: outputIndex,
                item: { id: toolId, type: 'function_call', status: 'in_progress', name: toolName, arguments: '', call_id: toolId },
              })));
            }
          } else if (type === 'content_block_delta') {
            const delta = evt.delta as Record<string, unknown> | undefined;
            const idx = evt.index as number;
            if (delta?.type === 'text_delta') {
              const text = delta.text as string ?? '';
              accumulatedText += text;
              await writer.write(encoder.encode(sseEvent('response.output_text.delta', {
                type: 'response.output_text.delta',
                sequence_number: nextSeq(),
                item_id: itemId,
                output_index: 0, // text item is always first
                content_index: 0,
                delta: text,
              })));
            } else if (delta?.type === 'input_json_delta') {
              const tool = toolBlocks.get(idx);
              if (tool) {
                const partial = delta.partial_json as string ?? '';
                tool.arguments += partial;
                await writer.write(encoder.encode(sseEvent('response.function_call_arguments.delta', {
                  type: 'response.function_call_arguments.delta',
                  sequence_number: nextSeq(),
                  item_id: tool.id,
                  output_index: tool.outputIndex,
                  delta: partial,
                })));
              }
            }
          } else if (type === 'content_block_stop') {
            const idx = evt.index as number;
            const tool = toolBlocks.get(idx);
            if (tool) {
              await writer.write(encoder.encode(sseEvent('response.function_call_arguments.done', {
                type: 'response.function_call_arguments.done',
                sequence_number: nextSeq(),
                item_id: tool.id,
                output_index: tool.outputIndex,
                arguments: tool.arguments,
              })));
              await writer.write(encoder.encode(sseEvent('response.output_item.done', {
                type: 'response.output_item.done',
                sequence_number: nextSeq(),
                output_index: tool.outputIndex,
                item: { id: tool.id, type: 'function_call', status: 'completed', name: tool.name, arguments: tool.arguments, call_id: tool.id },
              })));
            }
          } else if (type === 'message_delta') {
            const usage = evt.usage as Record<string, unknown> | undefined;
            if (usage?.input_tokens) inputTokens = usage.input_tokens as number;
            if (usage?.output_tokens) outputTokens = usage.output_tokens as number;
            if (usage?.cache_read_input_tokens) cachedTokens = usage.cache_read_input_tokens as number;
          }
        }
      }

      if (textPartOpened) {
        await writer.write(encoder.encode(sseEvent('response.output_text.done', {
          type: 'response.output_text.done',
          sequence_number: nextSeq(),
          item_id: itemId,
          output_index: 0,
          content_index: 0,
          text: accumulatedText,
        })));
        await writer.write(encoder.encode(sseEvent('response.output_item.done', {
          type: 'response.output_item.done',
          sequence_number: nextSeq(),
          output_index: 0,
          item: { id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: accumulatedText }] },
        })));
      }

      const outputItems: unknown[] = [];
      if (textPartOpened) {
        outputItems.push({ id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: accumulatedText }] });
      }
      for (const tool of toolBlocks.values()) {
        outputItems.push({ id: tool.id, type: 'function_call', status: 'completed', name: tool.name, arguments: tool.arguments, call_id: tool.id });
      }
      if (outputItems.length === 0) {
        outputItems.push({ id: itemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: '' }] });
      }

      await writer.write(encoder.encode(sseEvent('response.completed', {
        type: 'response.completed',
        sequence_number: nextSeq(),
        response: {
          id: responseId,
          object: 'response',
          created_at,
          status: 'completed',
          model,
          output: outputItems,
          usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens, input_tokens_details: { cached_tokens: cachedTokens } },
        },
      })));

      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch {
      // stream ended or errored
    } finally {
      await writer.close();
    }
  }

  pump();

  const streamOutHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'x-request-id': requestId,
  };
  logPipelineHeaders(activeLogger, requestId, 'outbound', '/v1/responses (SSE)', streamOutHeaders);
  return new Response(readable, { status: 200, headers: streamOutHeaders });
}

/**
 * Handle request by converting Responses API to Claude Messages format and forwarding to anthropic-messages upstream.
 */
async function handleAsAnthropicMessages(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  model: string,
  logger: Logger,
  requestBody: Record<string, unknown>,
  isStreaming: boolean,
  env?: Env,
  route?: ModelRouteConfig,
  upstreamMode?: string,
): Promise<Response> {
  const completionsRequest = convertResponsesToChatCompletions(requestBody, model, { logger, requestId });
  let claudeBody: Record<string, unknown> = await completionsToClaudeBody(completionsRequest as unknown as Record<string, unknown>, model);

  // before_upstream: apply declared transforms to the upstream-format body.
  // Required for anthropic-messages routes so per-model quirks (e.g. inject
  // missing tool_result blocks for DeepSeek's Anthropic-compatible endpoint)
  // can rewrite the Anthropic-format body before fetch.
  if (route) {
    const hookCtx: HookContext = {
      hook: 'before_upstream',
      route,
      upstreamMode: upstreamMode || 'anthropic-messages',
      clientModel: model,
      requestId,
      streaming: isStreaming,
      logger,
    };
    ({ body: claudeBody, headers: authHeaders } = runHook('before_upstream', { body: claudeBody, headers: authHeaders }, hookCtx));
  }

  logger.debug(requestId, `Responses->anthropic-messages: ${JSON.stringify(claudeBody).substring(0, 500)}`);
  if (Array.isArray(claudeBody.messages)) {
    logger.debug(requestId, `Responses->anthropic-messages msg structure: ${JSON.stringify((claudeBody.messages as Array<Record<string, unknown>>).map(m => ({ role: m.role, content: Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>).map(b => b.type === 'tool_use' ? `tu:${b.id}` : b.type === 'tool_result' ? `tr:${b.tool_use_id}` : String(b.type)) : `str:${String(m.content).substring(0, 20)}` })))}`);
  }
  logPipelineStage(logger, requestId, 'upstream-request', targetUrl, claudeBody);
  const anthropicFetchHeaders = {
    'Content-Type': 'application/json',
    ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), request),
  };
  logPipelineHeaders(logger, requestId, 'upstream-request', targetUrl, anthropicFetchHeaders);
  const response = await fetch(targetUrl, {
    method: 'POST',
    headers: anthropicFetchHeaders,
    body: JSON.stringify(claudeBody),
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
  });

  logPipelineHeaders(logger, requestId, 'upstream-response', targetUrl, response.headers);
  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('anthropic-messages', 0);
  recordUpstreamRateLimit(model, (name) => response.headers.get(name), targetUrl);

  if (!response.ok) {
    const upstreamBody = await response.text();
    logger.error(requestId, `Responses->anthropic-messages error: ${response.status}, URL: ${targetUrl}`);
    handleTargetApiError(response, 'Responses API (via anthropic-messages)', { url: targetUrl, upstreamBody });
  }

  if (isStreaming) {
    return streamClaudeAsResponses(response, model, requestId, logger);
  }

  const claudeJsonText = await response.text();
  logger.debug(requestId, `Upstream claude response: ${claudeJsonText.substring(0, 500)}`);
  logPipelineStage(logger, requestId, 'upstream-response', targetUrl, claudeJsonText);
  const claudeJson = JSON.parse(claudeJsonText) as Record<string, unknown>;
  const responsesResponse = claudeResponseToResponses(claudeJson, model);
  logPipelineStage(logger, requestId, 'outbound', '/v1/responses', responsesResponse);

  const outHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
  logPipelineHeaders(logger, requestId, 'outbound', '/v1/responses', outHeaders);
  return new Response(JSON.stringify(responsesResponse), { status: 200, headers: outHeaders });
}

/**
 * Handle request by converting Responses API to Claude Messages format and forwarding to a Gemini upstream.
 * The Gemini handler (handleGeminiRequestForMessages) accepts Claude-format input and returns Claude-format output.
 */
async function handleAsGemini(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  model: string,
  logger: Logger,
  requestBody: Record<string, unknown>,
  isStreaming: boolean,
  env?: Env,
  upstreamMode?: string
): Promise<Response> {
  const completionsRequest = convertResponsesToChatCompletions(requestBody, model, { logger, requestId });
  const claudeBody = await completionsToClaudeBody(completionsRequest as unknown as Record<string, unknown>, model);

  logger.debug(requestId, `Responses->${upstreamMode}: ${JSON.stringify(claudeBody).substring(0, 500)}`);

  // Build a synthetic request with Claude-format body so handleGeminiRequestForMessages can process it
  const claudeRequest = new Request(request.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...Object.fromEntries(request.headers),
    },
    body: JSON.stringify(claudeBody),
  });

  const claudeResponse = await handleGeminiRequestForMessages(claudeRequest, targetUrl, authHeaders, requestId, model, env, logger);

  if (!claudeResponse.ok) {
    // Error already handled by the Gemini handler; propagate it
    return claudeResponse;
  }

  if (isStreaming) {
    // claudeResponse is Claude SSE; convert to Responses SSE
    return streamClaudeAsResponses(claudeResponse, model, requestId, logger);
  }

  const claudeJson = await claudeResponse.json() as Record<string, unknown>;
  logger.debug(requestId, `Upstream gemini claude response: ${JSON.stringify(claudeJson).substring(0, 500)}`);
  const responsesResponse = claudeResponseToResponses(claudeJson, model);
  logPipelineStage(logger, requestId, 'outbound', '/v1/responses', responsesResponse);

  const outHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
  logPipelineHeaders(logger, requestId, 'outbound', '/v1/responses', outHeaders);
  return new Response(JSON.stringify(responsesResponse), { status: 200, headers: outHeaders });
}

/**
 * Handle request by converting Responses API format to Chat Completions
 */
async function handleAsCompletions(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  model: string,
  logger: Logger,
  requestBody: Record<string, unknown>,
  isStreaming: boolean,
  env?: Env,
  route?: ModelRouteConfig,
  upstreamMode?: string,
): Promise<Response> {
  const conversationEnabled = env?.CONVERSATION_STATE === 'true' || env?.CONVERSATION_STATE === '1';
  const previousResponseId = requestBody.previous_response_id as string | undefined;
  // `conversation`: string (ConversationID) or { id } (ResponseConversationParam).
  const conversationParam = requestBody.conversation as string | { id?: string } | undefined;
  const conversationId = typeof conversationParam === 'string'
    ? conversationParam
    : conversationParam?.id;
  // Spec: `previous_response_id` "Cannot be used in conjunction with `conversation`".
  if (previousResponseId && conversationId) {
    return createErrorResponse(
      new Error('previous_response_id and conversation cannot be used together.'),
      requestId,
      400
    );
  }
  // Spec default: store=true. store=false → the response is not stored for
  // retrieval or continuation, so skip all conversation-state saves below.
  const storeResponse = requestBody.store !== false;

  // Normalize current input to an item array so we can prepend prior history
  const newInputItems = normalizeInputToItems(requestBody.input);
  let mergedInput: unknown[] = newInputItems;

  // If conversation caching is on and client references a prior response,
  // prepend [prior_input_items, prior_output_items] before the new input.
  if (conversationEnabled && previousResponseId) {
    const prior = getConversation(previousResponseId);
    if (prior) {
      mergedInput = [...prior.inputItems, ...prior.outputItems, ...mergedInput];
      logger.debug(requestId, `[conversation] loaded prior=${previousResponseId} (${prior.inputItems.length + prior.outputItems.length} items prepended)`);
    } else {
      logger.debug(requestId, `[conversation] previous_response_id=${previousResponseId} not found in store (expired or unknown)`);
    }
  }

  // Conversation mode: prepend the accumulated thread items to the new input.
  if (conversationEnabled && conversationId) {
    const threadItems = getConversationThreadItems(conversationId);
    if (threadItems) {
      mergedInput = [...threadItems, ...mergedInput];
      logger.debug(requestId, `[conversation] loaded thread=${conversationId} (${threadItems.length} items prepended)`);
    } else {
      logger.debug(requestId, `[conversation] starting new thread=${conversationId}`);
    }
  }

  // Build effective request body: use merged input, drop stateful fields
  // (Chat Completions upstream does not understand them)
  let effectiveBody: Record<string, unknown> = { ...requestBody, input: mergedInput };
  delete effectiveBody.previous_response_id;
  delete effectiveBody.conversation;

  // before_conversion: client-schema transforms before format conversion
  if (route) {
    const hookCtxConv: HookContext = {
      hook: 'before_conversion',
      route,
      upstreamMode: upstreamMode || 'openai-completions',
      clientModel: model,
      requestId,
      streaming: isStreaming,
      logger,
    };
    ({ body: effectiveBody } = runHook('before_conversion', { body: effectiveBody, headers: authHeaders }, hookCtxConv));
  }

  // Convert Responses API request to Chat Completions format
  const completionsRequest = convertResponsesToChatCompletions(effectiveBody, model, { logger, requestId });
  const namespaceMap = getNamespaceMap(completionsRequest);

  // Inject stored reasoning_content onto any assistant messages that have tool_calls
  // whose IDs were recorded from a prior thinking-mode response (DeepSeek requires
  // reasoning_content to be passed back when continuing a thinking-mode conversation).
  for (const msg of completionsRequest.messages) {
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      const msgAny = msg as unknown as Record<string, unknown>;
      if (!msgAny.reasoning_content) {
        // Try each call_id until we find stored reasoning
        for (const tc of msg.tool_calls) {
          const stored = lookupReasoningForCall(tc.id);
          if (stored) {
            msgAny.reasoning_content = stored;
            logger.debug(requestId, `[reasoning] injected stored reasoning_content for call_id=${tc.id}`);
            break;
          }
        }
      }
    }
  }

  logger.debug(requestId, `Converted to completions format: ${JSON.stringify(completionsRequest)}`);

  // before_upstream: apply declared transforms to the upstream body.
  // (max_tokens → max_completion_tokens rename handled by the transform engine)
  let upstreamBodyResponses: Record<string, unknown> = completionsRequest as unknown as Record<string, unknown>;
  if (route) {
    const hookCtx: HookContext = {
      hook: 'before_upstream',
      route,
      upstreamMode: upstreamMode || 'openai-completions',
      clientModel: model || 'unknown',
      requestId,
      streaming: isStreaming,
      logger,
    };
    ({ body: upstreamBodyResponses, headers: authHeaders } = runHook('before_upstream', { body: upstreamBodyResponses, headers: authHeaders }, hookCtx));
  }
  logPipelineStage(logger, requestId, 'upstream-request', targetUrl, upstreamBodyResponses);
  const completionsFetchHeaders = {
    'Content-Type': 'application/json',
    ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), request),
  };
  logPipelineHeaders(logger, requestId, 'upstream-request', targetUrl, completionsFetchHeaders);
  let response = await fetch(targetUrl, {
    method: 'POST',
    headers: completionsFetchHeaders,
    body: JSON.stringify(upstreamBodyResponses),
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
  });

  if (route) {
    response = await applyAfterUpstream(response, {
      hook: 'after_upstream', route, upstreamMode: upstreamMode || 'openai-completions',
      clientModel: model, requestId, streaming: isStreaming, logger,
    });
  }

  logPipelineHeaders(logger, requestId, 'upstream-response', targetUrl, response.headers);
  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('openai-completions', 0);
  recordUpstreamRateLimit(model, (name) => response.headers.get(name), targetUrl);

  if (!response.ok) {
    const bodyPreview = JSON.stringify(completionsRequest);
    const upstreamErrorBody = await response.text();
    logger.debug(requestId, `Responses->Completions API error code: ${response.status}, URL: ${targetUrl}`);
    handleTargetApiError(response, 'Responses API (via Completions)', { url: targetUrl, status: response.status, body: bodyPreview, upstreamBody: upstreamErrorBody });
  }

  if (isStreaming) {
    // onComplete saves the conversation state after the stream finishes
    const onComplete = conversationEnabled && storeResponse
      ? (responseId: string, outputItems: unknown[], completedResponse?: Record<string, unknown>) => {
          saveConversation(responseId, mergedInput, outputItems, completedResponse);
          if (conversationId) {
            appendConversationThreadItems(conversationId, [...newInputItems, ...outputItems]);
          }
          logger.debug(requestId, `[conversation] saved responseId=${responseId} (${mergedInput.length} input + ${outputItems.length} output items)`);
        }
      : undefined;
    return streamCompletionsAsResponses(response, model, requestId, logger, onComplete, conversationId, namespaceMap);
  }

  // Convert Chat Completions response back to Responses API format
  const responseText = await response.text();
  logger.debug(requestId, `Upstream completions response: ${responseText.substring(0, 1000)}`);
  logPipelineStage(logger, requestId, 'upstream-response', targetUrl, responseText);
  const completionsResponse = JSON.parse(responseText) as OpenAIResponse;
  const responsesResponse = convertCompletionsToResponses(completionsResponse, model, namespaceMap);
  if (conversationId) {
    (responsesResponse as unknown as Record<string, unknown>).conversation = conversationId;
  }
  logPipelineStage(logger, requestId, 'outbound', '/v1/responses', responsesResponse);

  // Save conversation state for next turn
  if (conversationEnabled && storeResponse) {
    saveConversation(responsesResponse.id, mergedInput, responsesResponse.output, responsesResponse as unknown as Record<string, unknown>);
    if (conversationId) {
      appendConversationThreadItems(conversationId, [...newInputItems, ...responsesResponse.output]);
    }
    logger.debug(requestId, `[conversation] saved responseId=${responsesResponse.id} (${mergedInput.length} input + ${responsesResponse.output.length} output items)`);
  }

  const outHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
  logPipelineHeaders(logger, requestId, 'outbound', '/v1/responses', outHeaders);
  return new Response(JSON.stringify(responsesResponse), { status: 200, headers: outHeaders });
}

/**
 * Transform a Chat Completions SSE stream into a Responses API SSE stream.
 *
 * Chat Completions events look like:
 *   data: {"id":"...","choices":[{"delta":{"content":"hi"},"index":0}],"model":"..."}
 *
 * Responses API events emitted here:
 *   response.created           – once at start
 *   response.output_item.added – once (message item)
 *   response.content_part.added – once (output_text part)
 *   response.output_text.delta  – one per token chunk
 *   response.output_text.done   – once at end of text
 *   response.output_item.done   – once (message item)
 *   response.completed          – once at end with usage
 */
function streamCompletionsAsResponses(
  upstreamResponse: Response,
  model: string,
  requestId: string,
  logger?: Logger,
  onComplete?: (responseId: string, outputItems: unknown[], completedResponse?: Record<string, unknown>) => void,
  conversationId?: string,
  namespaceMap?: Map<string, string>
): Response {
  // Given a possibly-flattened tool name, restores the original `name`/`namespace`
  // split recorded by convertResponsesToChatCompletions, if it was a namespaced tool.
  const splitNamespace = (flatName: string): { name: string; namespace?: string } => {
    const namespace = namespaceMap?.get(flatName);
    if (!namespace) return { name: flatName };
    return { name: flatName.slice(namespace.replace(/\./g, '_').length + 1), namespace };
  };
  const responseId = `resp_${crypto.randomUUID().replace(/-/g, '')}`;
  const itemId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const created_at = Math.floor(Date.now() / 1000);

  let sequenceNumber = 0;
  const nextSeq = () => sequenceNumber++;

  const activeLogger = logger ?? createLogger({});

  function sseEvent(event: string, data: unknown): string {
    logPipelineStage(activeLogger, requestId, 'outbound', '/v1/responses (SSE)', data);
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // Accumulated state for tool calls streamed as indexed fragments.
  // Map from tool-call index -> { id, name, arguments }
  type ToolCallAccum = { id: string; name: string; arguments: string };

  async function pump() {
    try {
      // Emit response.created
      await writer.write(encoder.encode(sseEvent('response.created', {
        type: 'response.created',
        sequence_number: nextSeq(),
        response: { id: responseId, object: 'response', created_at, status: 'in_progress', model, output: [] },
      })));

      let accumulatedText = '';
      let accumulatedReasoning = ''; // reasoning_content / thinking tokens from upstream
      let thinkBuffer = ''; // partial <think>/<thinking> tag buffer for streaming extraction
      let textPartOpened = false;
      let textOutputIndex = -1; // set when text item is opened
      let usageData: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; prompt_cache_hit_tokens?: number } | undefined;
      let upstreamModel = model;
      let buffer = '';
      let rawUpstreamBody = ''; // accumulate for debug logging
      // tool_calls are streamed by index; accumulate across chunks
      const toolCalls: Map<number, ToolCallAccum> = new Map();
      // Track which tool call output_index slots have been opened
      const toolCallOutputIndex: Map<number, number> = new Map();
      let nextOutputIndex = 0; // claimed by the text message item if/when text appears, else tool calls start at 0

      const reader = upstreamResponse.body?.getReader();
      if (!reader) {
        await writer.close();
        return;
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        rawUpstreamBody += chunk;
        logPipelineStage(activeLogger, requestId, 'upstream-response', upstreamResponse.url || '(upstream SSE)', chunk);
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '[DONE]') continue;

          let chunk: Record<string, unknown>;
          try {
            chunk = JSON.parse(raw);
          } catch {
            continue;
          }

          if (chunk.model) upstreamModel = chunk.model as string;
          if (chunk.usage) usageData = chunk.usage as typeof usageData;

          const choices = chunk.choices as Array<{
            delta?: {
              content?: string;
              tool_calls?: Array<{
                index: number;
                id?: string;
                type?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            finish_reason?: string;
          }> | undefined;
          if (!choices?.length) continue;

          const delta = choices[0].delta;
          if (!delta) continue;

          // --- reasoning content (DeepSeek: delta.reasoning_content, OpenAI: delta.thinking) ---
          // Accumulate so it can be included in the output items for round-trip fidelity.
          const reasoningDelta = (delta as Record<string, unknown>).reasoning_content
            ?? (delta as Record<string, unknown>).thinking;
          if (typeof reasoningDelta === 'string' && reasoningDelta) {
            accumulatedReasoning += reasoningDelta;
          }

          // --- text content ---
          if (delta.content) {
            // Buffer chunks that may contain <think>/<thinking> tags; extract reasoning
            // inline and only forward clean text as output_text.delta events.
            let pendingText = thinkBuffer + delta.content;
            thinkBuffer = '';

            const thinkRegex = /<(?:thinking|think)>([\s\S]*?)<\/(?:thinking|think)>/g;
            let lastIdx = 0;
            let m;
            let cleanChunk = '';
            while ((m = thinkRegex.exec(pendingText)) !== null) {
              cleanChunk += pendingText.slice(lastIdx, m.index);
              accumulatedReasoning += m[1];
              lastIdx = thinkRegex.lastIndex;
            }
            // Remainder after last complete tag: may be a partial opening tag — buffer it
            const remainder = pendingText.slice(lastIdx);
            const partialOpen = remainder.lastIndexOf('<');
            if (partialOpen !== -1 && !remainder.slice(partialOpen).includes('>')) {
              // Potential partial tag — hold back from output until next chunk
              cleanChunk += remainder.slice(0, partialOpen);
              thinkBuffer = remainder.slice(partialOpen);
            } else {
              cleanChunk += remainder;
            }

            if (cleanChunk) {
              if (!textPartOpened) {
                // Text message item claims the next available index (always 0 if no tool calls came first)
                textOutputIndex = nextOutputIndex++;
                // Open the message output item and text part on first text delta
                await writer.write(encoder.encode(sseEvent('response.output_item.added', {
                  type: 'response.output_item.added',
                  sequence_number: nextSeq(),
                  output_index: textOutputIndex,
                  item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
                })));
                await writer.write(encoder.encode(sseEvent('response.content_part.added', {
                  type: 'response.content_part.added',
                  sequence_number: nextSeq(),
                  item_id: itemId,
                  output_index: textOutputIndex,
                  content_index: 0,
                  part: { type: 'output_text', text: '' },
                })));
                textPartOpened = true;
              }
              accumulatedText += cleanChunk;
              await writer.write(encoder.encode(sseEvent('response.output_text.delta', {
                type: 'response.output_text.delta',
                sequence_number: nextSeq(),
                item_id: itemId,
                output_index: textOutputIndex,
                content_index: 0,
                delta: cleanChunk,
              })));
            }
          }

          // --- tool call chunks ---
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index;
              if (!toolCalls.has(idx)) {
                // First chunk for this tool call index
                const tcId = tc.id ?? `call_${Date.now()}_${idx}`;
                const initialArgs = tc.function?.arguments ?? '';
                toolCalls.set(idx, { id: tcId, name: tc.function?.name ?? '', arguments: initialArgs });
                const outputIndex = nextOutputIndex++;
                toolCallOutputIndex.set(idx, outputIndex);
                // Emit output_item.added for this function_call
                const { name: addedName, namespace: addedNamespace } = splitNamespace(tc.function?.name ?? '');
                await writer.write(encoder.encode(sseEvent('response.output_item.added', {
                  type: 'response.output_item.added',
                  sequence_number: nextSeq(),
                  output_index: outputIndex,
                  item: {
                    id: tcId,
                    type: 'function_call',
                    status: 'in_progress',
                    name: addedName,
                    arguments: '',
                    call_id: tcId,
                    ...(addedNamespace ? { namespace: addedNamespace } : {}),
                  },
                })));
                // If the first chunk already carries argument data, emit it as a delta now
                if (initialArgs) {
                  await writer.write(encoder.encode(sseEvent('response.function_call_arguments.delta', {
                    type: 'response.function_call_arguments.delta',
                    sequence_number: nextSeq(),
                    item_id: tcId,
                    output_index: outputIndex,
                    delta: initialArgs,
                  })));
                }
              } else {
                const accum = toolCalls.get(idx)!;
                if (tc.function?.name) accum.name += tc.function.name;
                if (tc.function?.arguments) {
                  accum.arguments += tc.function.arguments;
                  const outputIndex = toolCallOutputIndex.get(idx)!;
                  // Emit arguments delta
                  await writer.write(encoder.encode(sseEvent('response.function_call_arguments.delta', {
                    type: 'response.function_call_arguments.delta',
                    sequence_number: nextSeq(),
                    item_id: accum.id,
                    output_index: outputIndex,
                    delta: tc.function.arguments,
                  })));
                }
              }
            }
          }
        }
      }

      activeLogger.debug(requestId, `[stream] upstream raw body (${rawUpstreamBody.length} bytes):\n${rawUpstreamBody}`);

      // Flush any buffered partial tag as plain text (tag never closed by upstream)
      if (thinkBuffer) {
        accumulatedText += thinkBuffer;
        thinkBuffer = '';
      }

      // --- close text part if it was opened ---
      if (textPartOpened) {
        await writer.write(encoder.encode(sseEvent('response.output_text.done', {
          type: 'response.output_text.done',
          sequence_number: nextSeq(),
          item_id: itemId,
          output_index: textOutputIndex,
          content_index: 0,
          text: accumulatedText,
        })));
        // Include reasoning_text alongside output_text so Codex echoes it back on
        // the next turn. DeepSeek rejects multi-turn requests when reasoning_content
        // is missing from the assistant message that followed a thinking turn.
        const doneContent: Array<{ type: string; text: string }> = [
          { type: 'output_text', text: accumulatedText },
        ];
        if (accumulatedReasoning) {
          doneContent.push({ type: 'reasoning_text', text: accumulatedReasoning });
        }
        await writer.write(encoder.encode(sseEvent('response.output_item.done', {
          type: 'response.output_item.done',
          sequence_number: nextSeq(),
          output_index: textOutputIndex,
          item: {
            id: itemId,
            type: 'message',
            status: 'completed',
            role: 'assistant',
            content: doneContent,
          },
        })));
      }

      // --- close each tool call item ---
      const completedToolCalls: Array<{ id: string; type: string; status: string; name: string; arguments: string; call_id: string; namespace?: string }> = [];
      for (const [idx, accum] of toolCalls) {
        const outputIndex = toolCallOutputIndex.get(idx)!;
        await writer.write(encoder.encode(sseEvent('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          sequence_number: nextSeq(),
          item_id: accum.id,
          output_index: outputIndex,
          arguments: accum.arguments,
        })));
        const { name: doneName, namespace: doneNamespace } = splitNamespace(accum.name);
        await writer.write(encoder.encode(sseEvent('response.output_item.done', {
          type: 'response.output_item.done',
          sequence_number: nextSeq(),
          output_index: outputIndex,
          item: {
            id: accum.id,
            type: 'function_call',
            status: 'completed',
            name: doneName,
            arguments: accum.arguments,
            call_id: accum.id,
            ...(doneNamespace ? { namespace: doneNamespace } : {}),
          },
        })));
        completedToolCalls.push({
          id: accum.id, type: 'function_call', status: 'completed', name: doneName,
          arguments: accum.arguments, call_id: accum.id,
          ...(doneNamespace ? { namespace: doneNamespace } : {}),
        });
      }

      // Build output array for response.completed
      const outputItems: unknown[] = [];

      // Prepend a reasoning output item when the upstream produced reasoning content.
      // This preserves the reasoning so Codex can echo it back on the next turn, which
      // is required by thinking-mode upstreams like DeepSeek ("reasoning_content must
      // be passed back to the API").
      if (accumulatedReasoning) {
        const reasoningId = `rs_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
        outputItems.push({
          id: reasoningId,
          type: 'reasoning',
          status: 'completed',
          content: [{ type: 'reasoning_text', text: accumulatedReasoning }],
        });
      }

      if (textPartOpened) {
        const textContent: Array<{ type: string; text: string }> = [{ type: 'output_text', text: accumulatedText }];
        // Also embed reasoning_text inside the message so it round-trips via assistant
        // message content when Codex sends the conversation back.
        if (accumulatedReasoning) {
          textContent.push({ type: 'reasoning_text', text: accumulatedReasoning });
        }
        outputItems.push({
          id: itemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: textContent,
        });
      }
      outputItems.push(...completedToolCalls);

      // If there was reasoning and tool calls, persist the reasoning keyed by each
      // call_id so we can inject it on the next turn when Codex echoes the calls back
      // without the reasoning (which thinking-mode upstreams require).
      if (accumulatedReasoning && completedToolCalls.length > 0) {
        storeReasoningForCalls(completedToolCalls.map(tc => tc.id), accumulatedReasoning);
      }

      // output: [] is invalid per spec. If the stream had only thinking/reasoning content
      // (no text, no tool calls), emit a fallback empty-text message item so the client
      // receives a non-empty output array.
      if (outputItems.every((it: unknown) => (it as Record<string, unknown>).type === 'reasoning')) {
        outputItems.push({
          id: itemId,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: '' }],
        });
      }

      // Build usage for response.completed
      const usage = usageData ? {
        input_tokens: usageData.prompt_tokens ?? 0,
        output_tokens: usageData.completion_tokens ?? 0,
        total_tokens: usageData.total_tokens ?? 0,
        input_tokens_details: { cached_tokens: usageData.prompt_cache_hit_tokens ?? usageData.prompt_tokens_details?.cached_tokens ?? 0 },
      } : undefined;

      // Build the completed response object once; it is both emitted in the
      // response.completed event and passed to onComplete for the store
      // (GET /v1/responses/{id} retrieval).
      const completedResponse: Record<string, unknown> = {
        id: responseId,
        object: 'response',
        created_at,
        status: 'completed',
        model: upstreamModel,
        output: outputItems,
        usage,
        ...(conversationId ? { conversation: conversationId } : {}),
      };

      // Save conversation state before emitting the completed event
      onComplete?.(responseId, outputItems, completedResponse);

      // Emit response.completed
      await writer.write(encoder.encode(sseEvent('response.completed', {
        type: 'response.completed',
        sequence_number: nextSeq(),
        response: completedResponse,
      })));

      await writer.write(encoder.encode('data: [DONE]\n\n'));
    } catch {
      // Stream ended or errored; close writer to flush what we have
    } finally {
      await writer.close();
    }
  }

  pump();

  const streamOutHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'x-request-id': requestId,
  };
  logPipelineHeaders(activeLogger, requestId, 'outbound', '/v1/responses (SSE)', streamOutHeaders);
  return new Response(readable, { status: 200, headers: streamOutHeaders });
}

/**
 * Handle POST /v1/responses/input_tokens request
 *
 * Returns input token count for the given request.
 * Spec: POST /responses/input_tokens → { object: "response.input_tokens", input_tokens: number }
 */
export async function handleResponsesInputTokensRequest(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  modelId?: string,
  env?: Env,
  logger?: Logger,
  upstreamMode?: string,
  route?: ModelRouteConfig,
): Promise<Response> {
  const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);

  const requestBody = await request.json() as Record<string, unknown>;
  const model = modelId || (requestBody.model as string) || 'unknown';

  activeLogger.debug(requestId, `Responses input_tokens request (mode=${upstreamMode}, model=${model}): ${targetUrl}`);

  if (upstreamMode === 'openai-completions') {
    // Convert to completions format, call with max_tokens=1, extract prompt_tokens from usage
    const completionsRequest = convertResponsesToChatCompletions(requestBody, model, { logger: activeLogger, requestId });
    let countRequest: Record<string, unknown> = { ...completionsRequest, max_tokens: 1, stream: false };

    activeLogger.debug(requestId, `input_tokens -> completions count: ${JSON.stringify(countRequest).substring(0, 500)}`);

    if (route) {
      const hookCtx: HookContext = {
        hook: 'before_upstream', route,
        upstreamMode: 'openai-completions',
        clientModel: model, requestId, streaming: false, logger: activeLogger,
      };
      ({ body: countRequest, headers: authHeaders } = runHook('before_upstream', { body: countRequest, headers: authHeaders }, hookCtx));
    }

    const countFetchHeaders = {
      'Content-Type': 'application/json',
      ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), request),
    };
    logPipelineHeaders(activeLogger, requestId, 'upstream-request', targetUrl, countFetchHeaders);
    let response = await fetch(targetUrl, {
      method: 'POST',
      headers: countFetchHeaders,
      body: JSON.stringify(countRequest),
      signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
    });

    if (route) {
      response = await applyAfterUpstream(response, {
        hook: 'after_upstream', route, upstreamMode: 'openai-completions',
        clientModel: model, requestId, streaming: false, logger: activeLogger,
      });
    }

    logPipelineHeaders(activeLogger, requestId, 'upstream-response', targetUrl, response.headers);
    recordResponseStatusCodeFromUpstream(response.status);
    recordUpstreamResponseToolCount('openai-completions', 0);
    recordUpstreamRateLimit(model, (name) => response.headers.get(name), targetUrl);

    if (!response.ok) {
      const upstreamErrorBody = await response.text();
      activeLogger.error(requestId, `Responses input_tokens error: ${response.status}, URL: ${targetUrl}`);
      handleTargetApiError(response, 'Responses input_tokens (via Completions)', { url: targetUrl, upstreamBody: upstreamErrorBody });
    }

    const responseText = await response.text();
    const completionsResponse = JSON.parse(responseText) as OpenAIResponse;
    const inputTokens = completionsResponse.usage?.prompt_tokens ?? 0;

    const outHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
    logPipelineHeaders(activeLogger, requestId, 'outbound', '/v1/responses/input_tokens', outHeaders);
    return new Response(JSON.stringify({ object: 'response.input_tokens', input_tokens: inputTokens }), { status: 200, headers: outHeaders });
  }

  // Passthrough to OpenAI Responses API upstream /responses/input_tokens
  let passthroughBodyInputTokens: Record<string, unknown> = requestBody;
  if (route) {
    const hookCtx: HookContext = {
      hook: 'before_upstream', route,
      upstreamMode: upstreamMode || 'openai-responses',
      clientModel: model, requestId, streaming: false, logger: activeLogger,
    };
    ({ body: passthroughBodyInputTokens, headers: authHeaders } = runHook('before_upstream', { body: passthroughBodyInputTokens, headers: authHeaders }, hookCtx));
  }
  const passthroughInputTokensHeaders = {
    'Content-Type': 'application/json',
    ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), request),
  };
  logPipelineHeaders(activeLogger, requestId, 'upstream-request', targetUrl, passthroughInputTokensHeaders);
  let passthroughInputTokensResponse = await fetch(targetUrl, {
    method: 'POST',
    headers: passthroughInputTokensHeaders,
    body: JSON.stringify(passthroughBodyInputTokens),
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
  });

  if (route) {
    passthroughInputTokensResponse = await applyAfterUpstream(passthroughInputTokensResponse, {
      hook: 'after_upstream', route, upstreamMode: upstreamMode || 'openai-responses',
      clientModel: model, requestId, streaming: false, logger: activeLogger,
    });
  }

  logPipelineHeaders(activeLogger, requestId, 'upstream-response', targetUrl, passthroughInputTokensResponse.headers);
  recordResponseStatusCodeFromUpstream(passthroughInputTokensResponse.status);
  recordUpstreamResponseToolCount('openai-completions', 0);
  recordUpstreamRateLimit(model, (name) => passthroughInputTokensResponse.headers.get(name), targetUrl);

  if (!passthroughInputTokensResponse.ok) {
    const upstreamErrorBody = await passthroughInputTokensResponse.text();
    activeLogger.error(requestId, `Responses input_tokens passthrough error: ${passthroughInputTokensResponse.status}, URL: ${targetUrl}`);
    handleTargetApiError(passthroughInputTokensResponse, 'Responses input_tokens', { url: targetUrl, upstreamBody: upstreamErrorBody });
  }

  const outHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
  logPipelineHeaders(activeLogger, requestId, 'outbound', '/v1/responses/input_tokens', outHeaders);
  return new Response(passthroughInputTokensResponse.body, { status: 200, headers: outHeaders });
}

/**
 * Handle POST /v1/responses/compact request
 *
 * Compact a conversation. Returns a CompactedResponse with object: "response.compaction".
 * Spec: POST /responses/compact
 */
export async function handleResponsesCompactRequest(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  modelId?: string,
  env?: Env,
  logger?: Logger,
  upstreamMode?: string,
  route?: ModelRouteConfig,
): Promise<Response> {
  const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);

  const requestBody = await request.json() as Record<string, unknown>;
  const model = modelId || (requestBody.model as string) || 'unknown';

  activeLogger.debug(requestId, `Responses compact request (mode=${upstreamMode}, model=${model}): ${targetUrl}`);

  if (upstreamMode === 'openai-completions') {
    // Convert to chat completions, call upstream, wrap as CompactedResponse
    const convertedRequest = convertResponsesToChatCompletions(requestBody, model, { logger: activeLogger, requestId });
    const namespaceMap = getNamespaceMap(convertedRequest);
    let completionsRequest: Record<string, unknown> = convertedRequest as unknown as Record<string, unknown>;

    activeLogger.debug(requestId, `Compact -> completions: ${JSON.stringify(completionsRequest).substring(0, 500)}`);

    if (route) {
      const hookCtx: HookContext = {
        hook: 'before_upstream', route,
        upstreamMode: 'openai-completions',
        clientModel: model, requestId, streaming: false, logger: activeLogger,
      };
      ({ body: completionsRequest, headers: authHeaders } = runHook('before_upstream', { body: completionsRequest, headers: authHeaders }, hookCtx));
    }

    const compactCompletionsHeaders = {
      'Content-Type': 'application/json',
      ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), request),
    };
    logPipelineHeaders(activeLogger, requestId, 'upstream-request', targetUrl, compactCompletionsHeaders);
    let compactCompletionsResponse = await fetch(targetUrl, {
      method: 'POST',
      headers: compactCompletionsHeaders,
      body: JSON.stringify(completionsRequest),
      signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
    });

    if (route) {
      compactCompletionsResponse = await applyAfterUpstream(compactCompletionsResponse, {
        hook: 'after_upstream', route, upstreamMode: 'openai-completions',
        clientModel: model, requestId, streaming: false, logger: activeLogger,
      });
    }

    logPipelineHeaders(activeLogger, requestId, 'upstream-response', targetUrl, compactCompletionsResponse.headers);
    recordResponseStatusCodeFromUpstream(compactCompletionsResponse.status);
    recordUpstreamResponseToolCount('openai-completions', 0);
    recordUpstreamRateLimit(model, (name) => compactCompletionsResponse.headers.get(name), targetUrl);

    if (!compactCompletionsResponse.ok) {
      const upstreamErrorBody = await compactCompletionsResponse.text();
      activeLogger.error(requestId, `Responses compact error: ${compactCompletionsResponse.status}, URL: ${targetUrl}`);
      handleTargetApiError(compactCompletionsResponse, 'Responses compact (via Completions)', { url: targetUrl, upstreamBody: upstreamErrorBody });
    }

    const responseText = await compactCompletionsResponse.text();
    const completionsResponse = JSON.parse(responseText) as OpenAIResponse;
    const compactedResponse = convertCompletionsToCompactedResponse(completionsResponse, model, namespaceMap);

    const outHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
    logPipelineHeaders(activeLogger, requestId, 'outbound', '/v1/responses/compact', outHeaders);
    return new Response(JSON.stringify(compactedResponse), { status: 200, headers: outHeaders });
  }

  // Passthrough to OpenAI Responses API upstream /responses/compact
  let passthroughBodyCompact: Record<string, unknown> = requestBody;
  if (route) {
    const hookCtx: HookContext = {
      hook: 'before_upstream', route,
      upstreamMode: upstreamMode || 'openai-responses',
      clientModel: model, requestId, streaming: false, logger: activeLogger,
    };
    ({ body: passthroughBodyCompact, headers: authHeaders } = runHook('before_upstream', { body: passthroughBodyCompact, headers: authHeaders }, hookCtx));
  }
  const compactPassthroughHeaders = {
    'Content-Type': 'application/json',
    ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), request),
  };
  logPipelineHeaders(activeLogger, requestId, 'upstream-request', targetUrl, compactPassthroughHeaders);
  let compactPassthroughResponse = await fetch(targetUrl, {
    method: 'POST',
    headers: compactPassthroughHeaders,
    body: JSON.stringify(passthroughBodyCompact),
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
  });

  if (route) {
    compactPassthroughResponse = await applyAfterUpstream(compactPassthroughResponse, {
      hook: 'after_upstream', route, upstreamMode: upstreamMode || 'openai-responses',
      clientModel: model, requestId, streaming: false, logger: activeLogger,
    });
  }

  logPipelineHeaders(activeLogger, requestId, 'upstream-response', targetUrl, compactPassthroughResponse.headers);
  recordResponseStatusCodeFromUpstream(compactPassthroughResponse.status);
  recordUpstreamResponseToolCount('openai-completions', 0);
  recordUpstreamRateLimit(model, (name) => compactPassthroughResponse.headers.get(name), targetUrl);

  if (!compactPassthroughResponse.ok) {
    const upstreamErrorBody = await compactPassthroughResponse.text();
    activeLogger.error(requestId, `Responses compact passthrough error: ${compactPassthroughResponse.status}, URL: ${targetUrl}`);
    handleTargetApiError(compactPassthroughResponse, 'Responses compact', { url: targetUrl, upstreamBody: upstreamErrorBody });
  }

  const outHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
  logPipelineHeaders(activeLogger, requestId, 'outbound', '/v1/responses/compact', outHeaders);
  return new Response(compactPassthroughResponse.body, { status: 200, headers: outHeaders });
}

/**
 * Handle request by passing through to OpenAI Responses API upstream
 */
async function handleAsPassthrough(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  logger: Logger,
  requestBody: Record<string, unknown>,
  isStreaming: boolean,
  env?: Env,
  route?: ModelRouteConfig,
): Promise<Response> {
  let upstreamBodyPassthrough: Record<string, unknown> = requestBody;
  if (route) {
    const hookCtx: HookContext = {
      hook: 'before_upstream', route,
      upstreamMode: 'openai-responses',
      clientModel: (requestBody.model as string) || 'unknown',
      requestId, streaming: isStreaming, logger,
    };
    ({ body: upstreamBodyPassthrough, headers: authHeaders } = runHook('before_upstream', { body: upstreamBodyPassthrough, headers: authHeaders }, hookCtx));
  }
  // Pure passthrough: no format conversion, so upstream-request == inbound body.
  logPipelineStage(logger, requestId, 'upstream-request', targetUrl, upstreamBodyPassthrough);
  const passthroughFetchHeaders = {
    'Content-Type': 'application/json',
    ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), request),
  };
  logPipelineHeaders(logger, requestId, 'upstream-request', targetUrl, passthroughFetchHeaders);
  let response = await fetch(targetUrl, {
    method: 'POST',
    headers: passthroughFetchHeaders,
    body: JSON.stringify(upstreamBodyPassthrough),
    signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
  });

  if (route) {
    response = await applyAfterUpstream(response, {
      hook: 'after_upstream', route, upstreamMode: 'openai-responses',
      clientModel: (requestBody.model as string) || 'unknown',
      requestId, streaming: isStreaming, logger,
    });
  }

  logPipelineHeaders(logger, requestId, 'upstream-response', targetUrl, response.headers);
  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('openai-completions', 0);
  recordUpstreamRateLimit((requestBody.model as string) || 'unknown', (name) => response.headers.get(name), targetUrl);

  if (!response.ok) {
    const bodyPreview = JSON.stringify(requestBody);
    const upstreamErrorBody = await response.text();
    logger.debug(requestId, `Responses API error code: ${response.status} from URL: ${targetUrl}`);
    handleTargetApiError(response, 'Responses API', { url: targetUrl, status: response.status, body: bodyPreview, upstreamBody: upstreamErrorBody });
  }

  if (isStreaming) {
    // Pure passthrough: outbound SSE == upstream-response SSE. Tee to log without
    // disturbing the stream returned to the client.
    const [clientStream, logStream] = response.body!.tee();
    (async () => {
      try {
        const reader = logStream.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          logPipelineStage(logger, requestId, 'upstream-response', response.url || targetUrl, decoder.decode(value, { stream: true }));
        }
      } catch {
        // best-effort debug logging only
      }
    })();
    const streamOutHeaders = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'x-request-id': requestId,
    };
    logPipelineHeaders(logger, requestId, 'outbound', '/v1/responses', streamOutHeaders);
    return new Response(clientStream, { status: 200, headers: streamOutHeaders });
  }

  const responseText = await response.text();
  logPipelineStage(logger, requestId, 'upstream-response', response.url || targetUrl, responseText);
  // Pure passthrough: outbound body == upstream-response body.
  const outHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
  logPipelineHeaders(logger, requestId, 'outbound', '/v1/responses', outHeaders);
  return new Response(responseText, { status: 200, headers: outHeaders });
}
