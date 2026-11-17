import { ClaudeMessagesRequest, ClaudeMessagesResponse } from '../types/claude.js';
import { convertClaudeToOpenAIRequest, ThinkingConversionOptions } from '../converters/claude-to-openai.js';
import { convertOpenAIToClaudeResponse } from '../converters/openai-to-claude.js';
import { convertOpenAIToGeminiGenerateContent, convertOpenAIToGeminiInteractions, registerGeminiToolSchemas, clearGeminiToolSchemas } from '../converters/openai-to-gemini.js';
import { createLogger, logPipelineStage, logPipelineHeaders } from '../utils/logger.js';
import { isSdkUrl, handleSdkOpenAIRequest } from '../utils/sdk-handler.js';
import type { Env, Logger } from '../types/shared.js';
import { addForwardedHeaders } from '../utils/routing.js';
import { resolveIncomingAuthorization, normalizeOpenAIAuthHeaders, ensureStructuredOutputsBetaHeader, ensureMcpClientBetaHeader } from '../utils/auth-headers.js';
import { runHook, applyAfterUpstream, type HookContext } from '../utils/request-transform.js';
import type { ModelRouteConfig } from '../utils/config-loader.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { recordResponseStatusCodeFromUpstream, recordUpstreamResponseToolCount } from '../utils/dashboard-stats.js';
import { recordUpstreamRateLimit } from '../utils/provider-quota.js';
import { handleTargetApiError } from '../utils/errors.js';
import { postJsonWithSpool } from '../utils/spool-json.js';
import { receiveJsonResponse, withResponseText } from '../utils/spool-response.js';

import { handleCrossModeStreamingResponse, processSSEBuffer, clearGeminiSSEState, finishInteractionsStream, warnDroppedOutputItems } from './cross-mode-stream.js';
import {
  convertGeminiGenerateContentToOpenAI,
  convertGeminiInteractionsToOpenAI,
  isGeminiInteractionsRequest,
  defaultMissingOpenAIMessageRoles,
} from '../converters/gemini-to-openai.js';
import { completionsToClaudeBody } from '../converters/completions-to-claude.js';
import { completionsToResponsesBody } from '../converters/completions-to-responses.js';
import { convertResponsesToChatCompletionsAnswer } from '../converters/responses-to-completions.js';
import { interactionsToResponsesBody } from '../converters/interactions-to-responses.js';
import {
  createResponsesInteractionStreamState,
  responsesEventToInteractionEvents,
  responsesToInteraction,
} from '../converters/responses-to-interactions.js';
import { geminiToResponsesBody } from '../converters/gemini-to-responses.js';
import {
  createResponsesGeminiStreamState,
  responsesEventToGeminiChunks,
  responsesToGeminiResponse,
} from '../converters/responses-to-gemini.js';
import { extractGeminiAllowedTools, geminiToClaudeBody } from '../converters/gemini-to-claude-request.js';
import {
  claudeEventToGeminiChunks,
  claudeToGeminiResponse,
  createClaudeGeminiStreamState,
} from '../converters/claude-to-gemini-response.js';
import { extractInteractionsAllowedTools, interactionsToClaudeBody } from '../converters/interactions-to-claude.js';
import {
  claudeEventToInteractionEvents,
  claudeToInteraction,
  createClaudeInteractionStreamState,
} from '../converters/claude-to-interactions.js';

/**
 * Legacy fallback for a Gemini-shaped body that did not match either direct
 * Interactions or generateContent dispatch. Supported requests use direct pairs.
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
  let claudeBody = await completionsToClaudeBody(openaiRequest, model, { logger, requestId });

  // Rule #8: an Interactions client's `labels` rides the intermediate as `metadata`
  // (`convertGeminiInteractionsToOpenAI`), and this hop has nowhere to put it —
  // `completionsToClaudeBody` maps no metadata, and Claude's own `metadata` accepts
  // only `user_id`. Reported rather than dropped in silence. Only the
  // /v1/interactions and :generateContent front doors reach this function, and only
  // that converter emits `metadata`, so the field here is the client's labels.
  if (openaiRequest.metadata !== undefined) {
    logger.warn(requestId,
      'labels not carried to the anthropic-messages upstream: Claude metadata accepts only user_id; dropped');
  }

  // The DeepSeek workaround that used to live here — an unsigned empty
  // `content[].thinking` block prepended to every assistant tool_use turn — is
  // now the `inject_missing_thinking_block` builtin, attached per target. It is
  // only tolerable on an upstream that accepts an unsigned block; a
  // spec-compliant Messages upstream requires `signature` on `ThinkingBlockParam`
  // and rejected the fabricated one.
  // Paired with the body *before* the transforms run, not after. `filter_anthropic_beta`
  // is what makes the configured `anthropic_beta_map` authoritative, so a header added
  // afterwards bypasses it: a gateway configured to drop this legacy flag still received
  // it and could fail with "invalid beta flag". With no map the builtin passes the header
  // through unchanged, so nothing else moves.
  ensureStructuredOutputsBetaHeader(authHeaders, claudeBody);

  // Declared transforms and the per-entry maxTokens cap both run inside this hook
  // (`applyMaxTokensCap`, src/utils/request-transform.ts). Every other egress in the
  // repo runs it — including this function's sibling
  // `forwardCompletionsAsOpenAIResponses` — but this one did not, so an
  // anthropic-messages route reached from /v1/interactions or :generateContent
  // silently ignored both.
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
      // `refusal` is the Claude dialect's member for a withheld answer and
      // `content_filter` its Completions counterpart (`openai-api-reference.md:92`),
      // so a block survives this last hop instead of reading as a clean `stop`. The
      // Claude `refusal` reaches here from either upstream dialect: the Gemini
      // egresses report it directly, and a Claude upstream carries it natively.
      // An explicit truncation or refusal also outranks the presence of a tool block:
      // the block is answer content, not evidence that the upstream stopped for it.
      finish_reason: claudeJson.stop_reason === 'max_tokens' ? 'length'
        : claudeJson.stop_reason === 'refusal' ? 'content_filter'
        : toolUseBlocks.length > 0 ? 'tool_calls'
        : 'stop',
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
 * Legacy Responses fallback for a Gemini-shaped body that did not match either
 * direct Interactions or generateContent dispatch above.
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
  let responsesBody: Record<string, unknown> = completionsToResponsesBody(openaiRequest, model, { logger, requestId });

  // No warning for the Interactions `labels` map here: it rides the intermediate as
  // `metadata`, which `completionsToResponsesBody` re-emits into a field the Responses
  // API declares. The `anthropic-messages` twin above still warns — Claude's
  // `metadata` accepts only `user_id`, so that loss is real.

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
  // The answer is converted by the same function the `/v1/chat/completions`
  // egress uses (`convertResponsesToChatCompletionsAnswer`), so both routes read a
  // Responses answer the same way before the Gemini converters render it. The
  // hand-built substitute this replaces read only `output_text` parts and
  // `function_call` items and then reported `finish_reason: 'stop'` for every
  // answer that called no tool — a turn truncated at the output cap was told to
  // the client as STOP (MAX_TOKENS in Gemini terms) when the upstream had said
  // `incomplete_details.reason: "max_output_tokens"`. It also dropped `reasoning`
  // items, which belong in `reasoning_content` for the Gemini converters' thought
  // parts.
  const answer = convertResponsesToChatCompletionsAnswer(responsesJson, model);
  // A silent drop is forbidden (rule #8): an `image_generation_call` result or a
  // `web_search_call` has no Gemini position either, and the log is the only place
  // that can say so.
  warnDroppedOutputItems(logger, requestId, new URL(originalRequest.url).pathname, answer.dropped);
  const syntheticCompletions = answer.completions;

  if (isGenerateContentRequest) {
    const geminiResponse = convertOpenAIToGeminiGenerateContent(syntheticCompletions, model, requestId);
    logPipelineStage(logger, requestId, 'outbound', ':generateContent', geminiResponse);
    const outHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
    logPipelineHeaders(logger, requestId, 'outbound', ':generateContent', outHeaders);
    return new Response(JSON.stringify(geminiResponse), { headers: outHeaders });
  }
  if (isInteractionsRequest) {
    const interactionResponse = convertOpenAIToGeminiInteractions(syntheticCompletions, model, requestId);
    if (responsesJson.status === 'incomplete' || responsesJson.status === 'failed') {
      interactionResponse.status = 'failed';
    }
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

async function forwardGenerateContentAsAnthropicMessages(
  requestBody: Record<string, unknown>,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  model: string,
  logger: Logger,
  originalRequest: Request,
  forceStreaming: boolean,
  env?: Env,
  route?: ModelRouteConfig,
): Promise<Response> {
  let claudeBody = await geminiToClaudeBody(requestBody, model, { logger, requestId });
  if (forceStreaming) claudeBody.stream = true;
  const isStreaming = claudeBody.stream === true;
  const allowedTools = extractGeminiAllowedTools(requestBody);
  ensureStructuredOutputsBetaHeader(authHeaders, claudeBody);
  if (route) {
    const hookCtx: HookContext = {
      hook: 'before_upstream', route, upstreamMode: 'anthropic-messages',
      clientModel: model, requestId, streaming: isStreaming, logger,
    };
    ({ body: claudeBody, headers: authHeaders } = runHook('before_upstream', { body: claudeBody, headers: authHeaders }, hookCtx));
  }

  const anthropicHeaders = { ...authHeaders };
  if (anthropicHeaders['x-api-key']) delete anthropicHeaders.Authorization;
  const headers = {
    'Content-Type': 'application/json',
    ...addForwardedHeaders(anthropicHeaders, originalRequest),
  };
  logPipelineStage(logger, requestId, 'upstream-request', targetUrl, claudeBody);
  logPipelineHeaders(logger, requestId, 'upstream-request', targetUrl, headers);
  let response = await postJsonWithSpool(targetUrl, claudeBody, {
    headers,
    signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
  });
  if (route) {
    response = await applyAfterUpstream(response, {
      hook: 'after_upstream', route, upstreamMode: 'anthropic-messages',
      clientModel: model, requestId, streaming: isStreaming, logger, signal: originalRequest.signal,
    });
  }
  logPipelineHeaders(logger, requestId, 'upstream-response', targetUrl, response.headers);
  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('anthropic-messages', 0);
  recordUpstreamRateLimit(model, name => response.headers.get(name), targetUrl);
  if (!response.ok) {
    const upstreamBody = await withResponseText(response, requestId, logger, targetUrl, text => text, originalRequest.signal);
    handleTargetApiError(response, 'generateContent (direct anthropic-messages)', { url: targetUrl, upstreamBody });
  }

  if (isStreaming) return handleClaudeStreamAsGemini(response, model, requestId, logger, allowedTools);
  const claudeJson = await receiveJsonResponse<Record<string, unknown>>(
    response, requestId, logger, targetUrl, originalRequest.signal,
  );
  const geminiResponse = claudeToGeminiResponse(claudeJson, model, { logger, requestId, allowedTools });
  logPipelineStage(logger, requestId, 'outbound', ':generateContent', geminiResponse);
  return new Response(JSON.stringify(geminiResponse), {
    headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
  });
}

function handleClaudeStreamAsGemini(
  response: Response,
  model: string,
  requestId: string,
  logger: Logger,
  allowedTools: Set<string> | null,
): Response {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    throw new Error(`Claude upstream answered a streaming request with '${contentType || '(no content-type)'}' instead of text/event-stream`);
  }
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const state = createClaudeGeminiStreamState(model);

  const processEvent = async (rawEvent: string): Promise<void> => {
    if (state.finished) return;
    const data = rawEvent.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data) as Record<string, unknown>;
    if (event.type === 'error') throw new Error(`Claude stream failed: ${JSON.stringify(event.error ?? event)}`);
    for (const chunk of claudeEventToGeminiChunks(state, event, { logger, requestId, allowedTools })) {
      logPipelineStage(logger, requestId, 'outbound', 'stream', chunk);
      await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    }
  };

  (async () => {
    try {
      if (!response.body) throw new Error('Claude upstream returned an empty stream');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const rawChunk = decoder.decode(value, { stream: true });
        logPipelineStage(logger, requestId, 'upstream-response', response.url || '(upstream SSE)', rawChunk);
        buffer += rawChunk;
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || '';
        for (const event of events) await processEvent(event);
      }
      buffer += decoder.decode();
      if (buffer.trim()) await processEvent(buffer);
      if (!state.finished) throw new Error(`Claude stream ended before a terminal stop_reason (request ${requestId})`);
      await writer.close();
    } catch (error) {
      logger.error(requestId, `generateContent direct Claude streaming error: ${(error as Error).message}`);
      await writer.abort();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      'Connection': 'keep-alive', 'x-request-id': requestId,
    },
  });
}

async function forwardGenerateContentAsOpenAIResponses(
  requestBody: Record<string, unknown>,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  model: string,
  logger: Logger,
  originalRequest: Request,
  forceStreaming: boolean,
  env?: Env,
  route?: ModelRouteConfig,
): Promise<Response> {
  let responsesBody = geminiToResponsesBody(requestBody, model, { logger, requestId });
  if (forceStreaming) responsesBody.stream = true;
  const isStreaming = responsesBody.stream === true;
  if (route) {
    const hookCtx: HookContext = {
      hook: 'before_upstream', route, upstreamMode: 'openai-responses',
      clientModel: model, requestId, streaming: isStreaming, logger,
    };
    ({ body: responsesBody, headers: authHeaders } = runHook('before_upstream', { body: responsesBody, headers: authHeaders }, hookCtx));
  }

  const headers = {
    'Content-Type': 'application/json',
    ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), originalRequest),
  };
  logPipelineStage(logger, requestId, 'upstream-request', targetUrl, responsesBody);
  logPipelineHeaders(logger, requestId, 'upstream-request', targetUrl, headers);
  let response = await postJsonWithSpool(targetUrl, responsesBody, {
    headers,
    signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
  });
  if (route) {
    response = await applyAfterUpstream(response, {
      hook: 'after_upstream', route, upstreamMode: 'openai-responses',
      clientModel: model, requestId, streaming: isStreaming, logger, signal: originalRequest.signal,
    });
  }

  logPipelineHeaders(logger, requestId, 'upstream-response', targetUrl, response.headers);
  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('openai-responses', 0);
  recordUpstreamRateLimit(model, name => response.headers.get(name), targetUrl);
  if (!response.ok) {
    const upstreamBody = await withResponseText(response, requestId, logger, targetUrl, text => text, originalRequest.signal);
    handleTargetApiError(response, 'generateContent (direct openai-responses)', { url: targetUrl, upstreamBody });
  }

  if (isStreaming) return handleResponsesStreamAsGemini(response, model, requestId, logger);
  const responsesJson = await receiveJsonResponse<Record<string, unknown>>(
    response, requestId, logger, targetUrl, originalRequest.signal,
  );
  const answer = responsesToGeminiResponse(responsesJson, model, { logger, requestId });
  warnDroppedOutputItems(logger, requestId, new URL(originalRequest.url).pathname, answer.dropped);
  logPipelineStage(logger, requestId, 'outbound', ':generateContent', answer.response);
  return new Response(JSON.stringify(answer.response), {
    headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
  });
}

function handleResponsesStreamAsGemini(
  response: Response,
  model: string,
  requestId: string,
  logger: Logger,
): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const state = createResponsesGeminiStreamState(model);

  const processEvent = async (rawEvent: string): Promise<void> => {
    if (state.finished) return;
    const data = rawEvent.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data) as Record<string, unknown>;
    if (event.type === 'response.failed') throw new Error(`Responses stream failed (request ${requestId})`);
    for (const chunk of responsesEventToGeminiChunks(state, event)) {
      logPipelineStage(logger, requestId, 'outbound', 'stream', chunk);
      await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    }
  };

  (async () => {
    try {
      if (!response.body) throw new Error('Responses upstream returned an empty stream');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const rawChunk = decoder.decode(value, { stream: true });
        logPipelineStage(logger, requestId, 'upstream-response', response.url || '(upstream SSE)', rawChunk);
        buffer += rawChunk;
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || '';
        for (const event of events) await processEvent(event);
      }
      buffer += decoder.decode();
      if (buffer.trim()) await processEvent(buffer);
      if (!state.finished) throw new Error(`Responses stream ended before a terminal event (request ${requestId})`);
      warnDroppedOutputItems(logger, requestId, ':generateContent', state.dropped);
      await writer.close();
    } catch (error) {
      logger.error(requestId, `generateContent direct Responses streaming error: ${(error as Error).message}`);
      await writer.abort();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      'Connection': 'keep-alive', 'x-request-id': requestId,
    },
  });
}

async function forwardInteractionsAsAnthropicMessages(
  requestBody: Record<string, unknown>,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  model: string,
  logger: Logger,
  originalRequest: Request,
  env?: Env,
  route?: ModelRouteConfig,
): Promise<Response> {
  let claudeBody = interactionsToClaudeBody(requestBody, model, { logger, requestId });
  const isStreaming = claudeBody.stream === true;
  const allowedTools = extractInteractionsAllowedTools(requestBody);
  ensureMcpClientBetaHeader(authHeaders, claudeBody);
  ensureStructuredOutputsBetaHeader(authHeaders, claudeBody);
  if (route) {
    const hookCtx: HookContext = {
      hook: 'before_upstream', route, upstreamMode: 'anthropic-messages',
      clientModel: model, requestId, streaming: isStreaming, logger,
    };
    ({ body: claudeBody, headers: authHeaders } = runHook('before_upstream', { body: claudeBody, headers: authHeaders }, hookCtx));
  }

  const anthropicHeaders = { ...authHeaders };
  if (anthropicHeaders['x-api-key']) delete anthropicHeaders.Authorization;
  const headers = {
    'Content-Type': 'application/json',
    ...addForwardedHeaders(anthropicHeaders, originalRequest),
  };
  logPipelineStage(logger, requestId, 'upstream-request', targetUrl, claudeBody);
  logPipelineHeaders(logger, requestId, 'upstream-request', targetUrl, headers);
  let response = await postJsonWithSpool(targetUrl, claudeBody, {
    headers,
    signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
  });
  if (route) {
    response = await applyAfterUpstream(response, {
      hook: 'after_upstream', route, upstreamMode: 'anthropic-messages',
      clientModel: model, requestId, streaming: isStreaming, logger, signal: originalRequest.signal,
    });
  }
  logPipelineHeaders(logger, requestId, 'upstream-response', targetUrl, response.headers);
  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('anthropic-messages', 0);
  recordUpstreamRateLimit(model, name => response.headers.get(name), targetUrl);
  if (!response.ok) {
    const upstreamBody = await withResponseText(response, requestId, logger, targetUrl, text => text, originalRequest.signal);
    handleTargetApiError(response, 'Interactions (direct anthropic-messages)', { url: targetUrl, upstreamBody });
  }

  if (isStreaming) return handleClaudeStreamAsInteractions(response, model, requestId, logger, allowedTools);
  const claudeJson = await receiveJsonResponse<Record<string, unknown>>(
    response, requestId, logger, targetUrl, originalRequest.signal,
  );
  const interaction = claudeToInteraction(claudeJson, model, requestId, { logger, requestId, allowedTools });
  logPipelineStage(logger, requestId, 'outbound', '/v1/interactions', interaction);
  return new Response(JSON.stringify(interaction), {
    headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
  });
}

function handleClaudeStreamAsInteractions(
  response: Response,
  model: string,
  requestId: string,
  logger: Logger,
  allowedTools: Set<string> | null,
): Response {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    throw new Error(`Claude upstream answered a streaming request with '${contentType || '(no content-type)'}' instead of text/event-stream`);
  }
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const state = createClaudeInteractionStreamState(model, requestId);

  const processEvent = async (rawEvent: string): Promise<void> => {
    if (state.interaction.finished) return;
    const data = rawEvent.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data) as Record<string, unknown>;
    if (event.type === 'error') throw new Error(`Claude stream failed: ${JSON.stringify(event.error ?? event)}`);
    for (const output of claudeEventToInteractionEvents(state, event, { logger, requestId, allowedTools })) {
      logPipelineStage(logger, requestId, 'outbound', 'stream', output);
      await writer.write(encoder.encode(`event: ${output.event_type as string}\ndata: ${JSON.stringify(output)}\n\n`));
    }
  };

  (async () => {
    try {
      if (!response.body) throw new Error('Claude upstream returned an empty stream');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const rawChunk = decoder.decode(value, { stream: true });
        logPipelineStage(logger, requestId, 'upstream-response', response.url || '(upstream SSE)', rawChunk);
        buffer += rawChunk;
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || '';
        for (const event of events) await processEvent(event);
      }
      buffer += decoder.decode();
      if (buffer.trim()) await processEvent(buffer);
      if (!state.interaction.finished) throw new Error(`Claude stream ended before a terminal stop_reason (request ${requestId})`);
      await writer.close();
    } catch (error) {
      logger.error(requestId, `Interactions direct Claude streaming error: ${(error as Error).message}`);
      await writer.abort();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      'Connection': 'keep-alive', 'x-request-id': requestId,
    },
  });
}

async function forwardInteractionsAsOpenAIResponses(
  requestBody: Record<string, unknown>,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  model: string,
  logger: Logger,
  originalRequest: Request,
  env?: Env,
  route?: ModelRouteConfig,
): Promise<Response> {
  let responsesBody = interactionsToResponsesBody(requestBody, model, { logger, requestId });
  if (route) {
    const hookCtx: HookContext = {
      hook: 'before_upstream', route, upstreamMode: 'openai-responses',
      clientModel: model, requestId, streaming: requestBody.stream === true, logger,
    };
    ({ body: responsesBody, headers: authHeaders } = runHook('before_upstream', { body: responsesBody, headers: authHeaders }, hookCtx));
  }

  const headers = {
    'Content-Type': 'application/json',
    ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), originalRequest),
  };
  logPipelineStage(logger, requestId, 'upstream-request', targetUrl, responsesBody);
  logPipelineHeaders(logger, requestId, 'upstream-request', targetUrl, headers);
  let response = await postJsonWithSpool(targetUrl, responsesBody, {
    headers,
    signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
  });
  if (route) {
    response = await applyAfterUpstream(response, {
      hook: 'after_upstream', route, upstreamMode: 'openai-responses',
      clientModel: model, requestId, streaming: requestBody.stream === true, logger, signal: originalRequest.signal,
    });
  }

  logPipelineHeaders(logger, requestId, 'upstream-response', targetUrl, response.headers);
  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('openai-responses', 0);
  recordUpstreamRateLimit(model, name => response.headers.get(name), targetUrl);
  if (!response.ok) {
    const upstreamBody = await withResponseText(response, requestId, logger, targetUrl, text => text, originalRequest.signal);
    handleTargetApiError(response, 'Interactions (direct openai-responses)', { url: targetUrl, upstreamBody });
  }

  if (requestBody.stream === true) {
    return handleResponsesStreamAsInteractions(response, model, requestId, logger);
  }
  const responsesJson = await receiveJsonResponse<Record<string, unknown>>(
    response, requestId, logger, targetUrl, originalRequest.signal,
  );
  const interaction = responsesToInteraction(responsesJson, model, requestId, { logger, requestId });
  logPipelineStage(logger, requestId, 'outbound', '/v1/interactions', interaction);
  return new Response(JSON.stringify(interaction), {
    headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
  });
}

function handleResponsesStreamAsInteractions(
  response: Response,
  model: string,
  requestId: string,
  logger: Logger,
): Response {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const state = createResponsesInteractionStreamState(model, requestId);

  const writeEvents = async (events: Array<Record<string, unknown>>): Promise<void> => {
    for (const event of events) {
      const eventType = event.event_type as string;
      const framed = `event: ${eventType}\ndata: ${JSON.stringify(event)}\n\n`;
      logPipelineStage(logger, requestId, 'outbound', 'stream', event);
      await writer.write(encoder.encode(framed));
    }
  };
  const processEvent = async (rawEvent: string): Promise<void> => {
    const data = rawEvent.split(/\r?\n/)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    const event = JSON.parse(data) as Record<string, unknown>;
    await writeEvents(responsesEventToInteractionEvents(state, event, { logger, requestId }));
  };

  (async () => {
    try {
      if (!response.body) throw new Error('Responses upstream returned an empty stream');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const rawChunk = decoder.decode(value, { stream: true });
        logPipelineStage(logger, requestId, 'upstream-response', response.url || '(upstream SSE)', rawChunk);
        buffer += rawChunk;
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() || '';
        for (const event of events) await processEvent(event);
      }
      buffer += decoder.decode();
      if (buffer.trim()) await processEvent(buffer);
      if (!state.interaction.finished) throw new Error(`Responses stream ended before a terminal event (request ${requestId})`);
      await writer.close();
    } catch (error) {
      logger.error(requestId, `Interactions direct Responses streaming error: ${(error as Error).message}`);
      await writer.abort();
    }
  })();

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      'Connection': 'keep-alive', 'x-request-id': requestId,
    },
  });
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

    if (isInteractionsRequest && upstreamMode === 'anthropic-messages' && requestBody.input !== undefined) {
      return forwardInteractionsAsAnthropicMessages(
        requestBody, targetUrl, authHeaders, requestId,
        modelId || (requestBody.model as string) || 'unknown', activeLogger, request, env, route,
      );
    }
    if (isInteractionsRequest && upstreamMode === 'openai-responses' && requestBody.input !== undefined) {
      return forwardInteractionsAsOpenAIResponses(
        requestBody, targetUrl, authHeaders, requestId,
        (requestBody.model as string) || modelId || 'unknown', activeLogger, request, env, route,
      );
    }
    if (isGenerateContentRequest && upstreamMode === 'anthropic-messages' && Array.isArray(requestBody.contents)) {
      return forwardGenerateContentAsAnthropicMessages(
        requestBody, targetUrl, authHeaders, requestId,
        modelId || (requestBody.model as string) || 'unknown', activeLogger, request,
        forceStreaming === true || isStreamRequest, env, route,
      );
    }
    if (isGenerateContentRequest && upstreamMode === 'openai-responses' && Array.isArray(requestBody.contents)) {
      return forwardGenerateContentAsOpenAIResponses(
        requestBody, targetUrl, authHeaders, requestId,
        modelId || (requestBody.model as string) || 'unknown', activeLogger, request,
        forceStreaming === true || isStreamRequest, env, route,
      );
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
        openaiRequest = convertGeminiInteractionsToOpenAI(requestBody, { logger: activeLogger, requestId });
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

    // A Gemini front door is the one that forwards `input.messages` verbatim
    // (`convertGeminiInteractionsToOpenAI`), and nothing requires the client to put
    // a role on every entry. Fill it for every upstream mode rather than only
    // `openai-completions`: the converted hops need it just as much — a Claude
    // message requires a `role`, and a Responses message item declares one — so the
    // old gate let a role-less entry through to be rejected upstream, with the
    // proxy having done nothing to it.
    if (isGeminiEndpoint) {
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
                const { processed, remaining } = processSSEBuffer(buffer, modelId, requestId, isInteractionsRequest, isGenerateContentRequest, logger);
                buffer = remaining;

                if (processed) {
                    logPipelineStage(logger, requestId, 'outbound', 'stream', processed);
                    await writer.write(encoder.encode(processed));
                }
            }

            // Process any remaining buffer
            if (buffer.trim()) {
                const { processed } = processSSEBuffer(buffer + '\n\n', modelId, requestId, isInteractionsRequest, isGenerateContentRequest, logger);
                if (processed) {
                    logPipelineStage(logger, requestId, 'outbound', 'stream (final)', processed);
                    await writer.write(encoder.encode(processed));
                }
            }

            // The Interactions dialect ends on `interaction.completed`, which is
            // written here rather than on `[DONE]`: an `openai-completions` upstream
            // that gates usage behind `stream_options.include_usage` reports it on a
            // frame after the end marker, and completing on the marker would publish
            // zeros. '' when that drain already ran on the marker.
            if (isInteractionsRequest) {
                const terminal = finishInteractionsStream(requestId);
                if (terminal) {
                    logPipelineStage(logger, requestId, 'outbound', 'stream (terminal)', terminal);
                    await writer.write(encoder.encode(terminal));
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
