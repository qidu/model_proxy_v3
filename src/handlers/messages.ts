/**
 * Messages API handler for Claude Proxy v3
 *
 * Handles POST /v1/messages endpoint with extended thinking support
 */

import { Env } from '../types/shared.js';
import { appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Logger, createLogger, logPipelineStage, logPipelineHeaders, observeStream } from '../utils/logger.js';
import { ClaudeMessagesRequest, ClaudeMessagesResponse } from '../types/claude.js';
import { OpenAIRequest, OpenAIResponse } from '../types/openai.js';
import { convertClaudeToOpenAIRequest, ThinkingConversionOptions, budgetToReasoningEffort } from '../converters/claude-to-openai.js';
import { convertOpenAIToClaudeResponse, TokenCountingConfig } from '../converters/openai-to-claude.js';
import { createStreamTransformer } from '../converters/streaming.js';
import { validateClaudeMessagesRequest } from '../utils/validation.js';
import { handleTargetApiError } from '../utils/errors.js';
import { normalizeOpenAIToClaudeThinking } from '../utils/thinking.js';
import { validateBetaFeatures, hasBetaFeature } from '../utils/beta-features.js';
import { isSdkUrl, handleSdkOpenAIRequest, handleSdkAnthropicRequest } from '../utils/sdk-handler.js';
import { addForwardedHeaders } from '../utils/routing.js';
import { normalizeOpenAIAuthHeaders } from '../utils/auth-headers.js';
import { runHook, applyAfterUpstream, type HookContext } from '../utils/request-transform.js';
import type { ModelRouteConfig } from '../utils/config-loader.js';
import { countClaudeRequestTokens, getLocalTokenCountingConfig, TokenCountingOptions } from '../utils/token-counting.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { recordResponseStatusCodeFromUpstream, recordUpstreamResponseToolCount } from '../utils/dashboard-stats.js';
import { recordUpstreamRateLimit } from '../utils/provider-quota.js';
import { OpenAIResponsesResponse } from '../converters/completions-to-responses.js';
import { collectBlobRefs, rehydrateInlineBlobs } from '../utils/blob-refs.js';
import { createRefAwareJsonBody } from '../utils/ref-serializer.js';
import { createJsonEgressBody, postJsonWithSpool } from '../utils/spool-json.js';
import { getSpoolConfig } from '../utils/spool.js';
import { receiveJsonResponse, withResponseText } from '../utils/spool-response.js';
// The one Completions→Responses request converter, shared with the /v1/interactions and
// /v1/chat/completions hops. No import cycle: openai.ts does not import this module.
import { completionsToResponsesBody } from './openai.js';

/**
 * Get token counting configuration from environment
 */
function getTokenCountingConfig(env?: Env): TokenCountingConfig {
  const config = getLocalTokenCountingConfig(env as unknown as Record<string, string>);
  return {
    enabled: config.enabled,
    modelName: config.modelName,
  };
}

/**
 * Estimate a request's input tokens from the body while it is still in hand.
 *
 * Every SSE path resolves this *before* it creates its response stream (§5.3):
 * the stream's transformer/pump outlives the handler for the whole downstream
 * send, so it must be handed a number instead of closing over the request body
 * — which would pin the entire request, inline base64 payloads included, until
 * the client stops reading. A counting failure degrades to 0, as the previous
 * in-stream counter did.
 */
function estimateInputTokens(requestBody: Record<string, unknown> | undefined): number {
  if (!requestBody) return 0;
  try {
    const options: TokenCountingOptions = { useLocalCounting: true, tokenizer: null };
    return countClaudeRequestTokens(requestBody as any, options);
  } catch {
    return 0;
  }
}

function normalizeOpenAICompletionsBody(requestBody: Record<string, unknown>): Record<string, unknown> {
  const normalizedBody: Record<string, unknown> = { ...requestBody };
  const outputConfig = normalizedBody.output_config as Record<string, unknown> | undefined;
  if (outputConfig && normalizedBody.reasoning_effort === undefined && outputConfig.effort !== undefined) {
    normalizedBody.reasoning_effort = outputConfig.effort;
  }
  return normalizedBody;
}

/**
 * The `/v1/messages` → `openai-responses` hop used to carry private copies of the three
 * Completions→Responses request conversions that live here. They had drifted from the
 * shared `completionsToResponsesBody` (`src/handlers/openai.ts`), which the
 * `/v1/interactions` and `/v1/chat/completions` hops use, in four ways: the system
 * prompt was emitted as a `system` item in `input[]` instead of the canonical
 * `instructions`; `input_image.image_url` was built from the client's object rather than
 * the string the Responses API declares; the assistant reasoning round-trip
 * (`reasoning_content`, `thinking` parts) existed here and not there; and
 * `store` / `response_format` / `reasoning_effort` / `prompt_cache_key` were carried
 * there and not here. Both hops now call the one converter, so a fix to either lands on
 * both. See `docs/api/review-interactions-to-openai-responses-hops.md`.
 */

/**
 * Handle messages API request
 */
export async function handleMessagesRequest(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  modelId?: string,
  env?: Env,
  logger?: Logger,
  conversionOptions?: ThinkingConversionOptions,
  upstreamMode?: string,
  route?: ModelRouteConfig,
): Promise<Response> {
  const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);

  // §5.7: the body is read once, in place. The `sdk://` route used to read it
  // through `request.clone()` "to preserve body for SDK handler", and a clone
  // *tees* the body: the branch nobody reads stays resident for as long as the
  // parse runs, i.e. a second full copy of a body that may carry an image.
  // Nothing reads that branch — both `sdk://` branches below are handed
  // `requestBody`, the parsed object, and the SDK handlers are stubs that never
  // touch the request they are given. The non-SDK route already consumed the
  // body here, so this only makes the two routes the same read. An SDK handler
  // that ever does need the wire body must be handed one explicitly (a receive,
  // as the ingress does) rather than by teeing this one.
  const requestBody = await request.json() as Record<string, unknown>;
  // §5.3 egress shape. The send boundary forwards refs, not payloads, so each
  // branch below decides at its own send whether to put the payloads back (shape 2)
  // or to hand the refs to a serializer that streams each payload at the offset its
  // ref occupies (shape 3). `streamRefs` is the Claude-format path's decision,
  // taken here because that path converts before it sends and a body expanded here
  // would have no refs left to stream; the already-OpenAI branch below decides for
  // itself at each of its sends.
  // `enabled` gates the walk, so a deployment with spooling off (§9.1) pays
  // nothing: with no extraction pass there can be no ref. The `sdk://` branch
  // below is handed the parsed body itself, so it stays on shape 2.
  const streamRefs = !isSdkUrl(targetUrl) && getSpoolConfig().enabled &&
    collectBlobRefs(requestBody).length > 0;
  if (isSdkUrl(targetUrl)) {
    await rehydrateInlineBlobs(requestBody);
  }
  logPipelineStage(activeLogger, requestId, 'inbound', '/v1/messages', requestBody);
  logPipelineHeaders(activeLogger, requestId, 'inbound', '/v1/messages', request.headers);

  // Normalize OpenAI-style thinking ({ enabled, budget_tokens }) to Claude
  // format ({ type, budget_tokens }) up-front so downstream code (format
  // detection, validation, conversion) can assume the canonical shape.
  if (requestBody.thinking && typeof requestBody.thinking === 'object') {
    const normalized = normalizeOpenAIToClaudeThinking(requestBody.thinking);
    if (normalized) {
      requestBody.thinking = normalized;
    }
  }
  // const requestBody = await request.json() as Record<string, unknown>;
  
  // Detect Gemini CLI and force non-streaming to avoid JSON parsing issues
  const userAgent = request.headers.get('user-agent') || '';
  activeLogger.debug(requestId, `UA: ${userAgent}, stream = ${requestBody.stream}`);
  
  // Check if request is already in OpenAI format
  // OpenAI format: { model, messages, stream, temperature, ... }
  // Claude format: { model, messages, max_tokens, thinking, system, ... }
  const hasClaudeContentBlocks = Array.isArray(requestBody.messages) && requestBody.messages.some((message) => {
    if (!message || typeof message !== 'object') {
      return false;
    }
    const content = (message as Record<string, unknown>).content;
    if (!Array.isArray(content)) {
      return false;
    }

    return content.some((part) => {
      if (!part || typeof part !== 'object') {
        return false;
      }
      const partType = (part as Record<string, unknown>).type;
      return partType === 'text' || partType === 'tool_use' || partType === 'tool_result' || partType === 'thinking';
    });
  });

  const isOpenAIFormat = !requestBody.system && !requestBody.thinking && !requestBody.stop_sequences && !hasClaudeContentBlocks;

  // Additional check: if request has tools, check if they're in Claude format
  // Claude tools format: { name: string, description?: string, input_schema: any }
  // OpenAI tools format: { type: "function", function: { name: string, description?: string, parameters: any } }
  let hasClaudeFormatTools = false;
  if (requestBody.tools && Array.isArray(requestBody.tools)) {
    // Check if first tool has Claude format (has 'name' and 'input_schema' fields)
    const firstTool = requestBody.tools[0];
    if (firstTool && firstTool.name && firstTool.input_schema && !firstTool.type) {
      hasClaudeFormatTools = true;
    }
  }

  if (isOpenAIFormat && !hasClaudeFormatTools) {
    // Request is already in OpenAI format, pass through directly.
    // §5.3: this branch forwards a body the client already spelled as OpenAI, so
    // there is no conversion of its own to carry a ref into — but the refs stay
    // in the body all the same. The token counter counts them where they sit
    // (an untyped block's refs are counted by their recorded size, §5.3's own
    // approximation), and both sends below decide their egress shape from the
    // body they are handed, so nothing here has to read a payload before the
    // send. The one expansion left in this handler is the `sdk://` branch above.
    const openaiRequestBody = normalizeOpenAICompletionsBody(requestBody);
    const isStreaming = openaiRequestBody.stream === true;

    // Log thinking configuration before stripping (for openai-completions)
    const originalThinking = openaiRequestBody.thinking as { enabled?: boolean; budget_tokens?: number } | undefined;
    if (originalThinking) {
      const thinkingType = originalThinking.enabled ? 'enabled' : 'disabled';
      const budget = originalThinking.budget_tokens ? ` budget_tokens: ${originalThinking.budget_tokens}` : 'budget: unknown';
      activeLogger.debug(requestId, `Thinking type: ${thinkingType} , ${budget} extracted from OpenAI-Format`);
    } else {
      activeLogger.debug(requestId, `Thinking type: not specified by req body format=${isOpenAIFormat}`);
    }

    // openai-completions doesn't support thinking field; derive reasoning_effort from budget_tokens
    if (upstreamMode === 'openai-completions' && openaiRequestBody.thinking !== undefined) {
      const thinking = openaiRequestBody.thinking as { enabled?: boolean; budget_tokens?: number } | undefined;
      if (thinking?.enabled && thinking?.budget_tokens && !openaiRequestBody.reasoning_effort) {
        const budget = thinking.budget_tokens;
        openaiRequestBody.reasoning_effort = budgetToReasoningEffort(budget, conversionOptions);
      }
      delete openaiRequestBody.thinking;
    }

    const model = (openaiRequestBody.model as string) || modelId || 'unknown';

    if (isStreaming) {
      const streamOptions = openaiRequestBody.stream_options as Record<string, unknown> | undefined;
      openaiRequestBody.stream_options = { ...streamOptions, include_usage: true };
    }

    // Log request info
    activeLogger.info(requestId, `Upstream (stream=${isStreaming}): /v1/chat/completions → ${model}`);

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

        activeLogger.debug(requestId, `handle by sdk: url=${request.url}, method=${request.method}`);
        // Use SDK handler for OpenAI requests
        return handleSdkOpenAIRequest(
            request,
            targetUrl,
            requestId,
            apiKey,
            model,
            activeLogger,
            env,
            openaiRequestBody,
            'claude',
            conversionOptions
        );
    }

    // OpenAI Responses API upstream: body has `messages` (Completions format), must be
    // converted to Responses format (`input`) before forwarding.
    if (upstreamMode === 'openai-responses') {
      // The shared converter (see the note above the tombstone comment) is a superset
      // of what this branch built by hand: it also emits `instructions`, `store`,
      // `response_format`, `reasoning_effort`, `prompt_cache_key` and the assistant
      // reasoning items.
      let responsesBody: Record<string, unknown> = completionsToResponsesBody(
        openaiRequestBody as unknown as Record<string, unknown>,
        (openaiRequestBody.model as string | undefined) ?? model,
      );
      // Re-asserted rather than taken from the converter: `stream` here is the proxy's
      // own decision (`?alt=sse` and the streaming doorways can force it), not a field
      // the client is trusted to have set.
      responsesBody.stream = isStreaming;

      // Declared transforms and the per-entry maxTokens cap both live in this hook
      // (`applyMaxTokensCap`, src/utils/request-transform.ts). Without it this
      // egress was the one that put `max_output_tokens` on the body and then never
      // gave the cap a chance to clamp it.
      if (route) {
        const hookCtxResponses: HookContext = {
          hook: 'before_upstream',
          route,
          upstreamMode: 'openai-responses',
          clientModel: (requestBody.model as string) || modelId || 'unknown',
          requestId,
          streaming: isStreaming,
          logger: activeLogger,
        };
        ({ body: responsesBody, headers: authHeaders } = runHook('before_upstream', { body: responsesBody, headers: authHeaders }, hookCtxResponses));
      }

      logPipelineStage(activeLogger, requestId, 'upstream-request', targetUrl, responsesBody);
      const responsesFetchHeaders1 = { 'Content-Type': 'application/json', ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), request) };
      logPipelineHeaders(activeLogger, requestId, 'upstream-request', targetUrl, responsesFetchHeaders1);
      let responsesResponse = await postJsonWithSpool(targetUrl, responsesBody, {
        headers: responsesFetchHeaders1,
        signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
      });

      if (route) {
        responsesResponse = await applyAfterUpstream(responsesResponse, {
          hook: 'after_upstream', route, upstreamMode: 'openai-responses',
          clientModel: (requestBody.model as string) || modelId || 'unknown',
          requestId, streaming: isStreaming, logger: activeLogger,
          signal: request.signal,
        });
      }

      logPipelineHeaders(activeLogger, requestId, 'upstream-response', targetUrl, responsesResponse.headers);
      recordResponseStatusCodeFromUpstream(responsesResponse.status);
      recordUpstreamResponseToolCount('openai-responses', 0);
      recordUpstreamRateLimit(model, (name) => responsesResponse.headers.get(name), targetUrl);

      if (!responsesResponse.ok) {
        const upstreamResponseBody = await withResponseText(responsesResponse, requestId, activeLogger, targetUrl, (text) => text, request.signal);
        activeLogger.error(requestId, `Messages->Responses API error (openai-passthrough): ${responsesResponse.status}, URL: ${targetUrl}, upstream body: ${upstreamResponseBody.substring(0, 500)}`);
        handleTargetApiError(responsesResponse, 'Messages API (via Responses)', { url: targetUrl, body: JSON.stringify(responsesBody), upstreamBody: upstreamResponseBody });
      }

      const tokenCountingConfig = getTokenCountingConfig(env);
      if (isStreaming) {
        return handleResponsesStreamAsClaude(responsesResponse, model, requestId, activeLogger, requestBody);
      }
      const responsesJson = await receiveJsonResponse<OpenAIResponsesResponse>(
        responsesResponse, requestId, activeLogger, targetUrl, request.signal,
      );
      const outputItem = responsesJson.output?.find(o => o.type === 'message');
      const textPart = outputItem?.content?.find(c => c.type === 'output_text');
      const toolCallItems = responsesJson.output?.filter(o => o.type === 'function_call') ?? [];
      const syntheticCompletions: OpenAIResponse = {
        id: responsesJson.id ?? 'resp_unknown',
        object: 'chat.completion',
        created: responsesJson.created_at ?? Math.floor(Date.now() / 1000),
        model: responsesJson.model ?? model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: textPart?.text ?? '',
            tool_calls: toolCallItems.length > 0
              ? toolCallItems.map(tc => ({
                  id: tc.call_id ?? tc.id ?? `call_${Date.now()}`,
                  type: 'function' as const,
                  function: { name: tc.name ?? '', arguments: tc.arguments ?? '' },
                }))
              : undefined,
          },
          finish_reason: toolCallItems.length > 0 ? 'tool_calls' : 'stop',
          logprobs: null,
        }],
        usage: responsesJson.usage ? {
          prompt_tokens: responsesJson.usage.input_tokens,
          completion_tokens: responsesJson.usage.output_tokens,
          total_tokens: responsesJson.usage.total_tokens,
          prompt_cache_hit_tokens: responsesJson.usage.input_tokens_details?.cached_tokens,
        } : undefined,
      };
      const claudeResponse = await convertOpenAIToClaudeResponse(syntheticCompletions, model, requestId, requestBody, tokenCountingConfig);
      logPipelineStage(activeLogger, requestId, 'outbound', '/v1/messages', claudeResponse);
      return new Response(JSON.stringify(claudeResponse), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
      });
    }

    // before_upstream: apply declared transforms to the upstream body.
    // (max_tokens → max_completion_tokens rename is now handled by the transform
    //  engine via the mode-default "max_tokens_rename" set in proxy_config.toml)
    let upstreamBodyOpenai: Record<string, unknown> = openaiRequestBody as unknown as Record<string, unknown>;
    if (route) {
      const hookCtx: HookContext = {
        hook: 'before_upstream',
        route,
        upstreamMode: upstreamMode || 'openai-completions',
        clientModel: (requestBody.model as string) || modelId || 'unknown',
        requestId,
        streaming: requestBody.stream === true,
        logger: activeLogger,
      };
      ({ body: upstreamBodyOpenai, headers: authHeaders } = runHook('before_upstream', { body: upstreamBodyOpenai, headers: authHeaders }, hookCtx));
    }
    logPipelineStage(activeLogger, requestId, 'upstream-request', targetUrl, upstreamBodyOpenai);
    const openaiFetchHeaders = { 'Content-Type': 'application/json', ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), request) };
    logPipelineHeaders(activeLogger, requestId, 'upstream-request', targetUrl, openaiFetchHeaders);
    let response = await postJsonWithSpool(targetUrl, upstreamBodyOpenai, {
      headers: openaiFetchHeaders,
      signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
    });

    if (route) {
      response = await applyAfterUpstream(response, {
        hook: 'after_upstream', route, upstreamMode: upstreamMode || 'openai-completions',
        clientModel: (requestBody.model as string) || modelId || 'unknown',
        requestId, streaming: isStreaming, logger: activeLogger,
        signal: request.signal,
      });
    }

    // Debug log upstream response for test model requests (openai-passthrough, LOG_LEVEL=debug)
    if (env?.LOG_LEVEL === 'debug') {
      try {
        const bodyText = typeof requestBody === 'string' ? requestBody : JSON.stringify(requestBody);
        if (bodyText.includes('test_tool')) {
          response = captureTestModelLog(response, 'openai-passthrough', targetUrl, requestId, activeLogger);
        }
      } catch (_e) { /* ignore */ }
    }

    logPipelineHeaders(activeLogger, requestId, 'upstream-response', targetUrl, response.headers);
    recordResponseStatusCodeFromUpstream(response.status);
    recordUpstreamResponseToolCount('openai-completions', 0);
    recordUpstreamRateLimit((requestBody.model as string) || modelId || model, (name) => response.headers.get(name), targetUrl);

    // Handle target API errors
    if (!response.ok) {
      const bodyPreview = typeof requestBody === 'string'
        ? requestBody
        : JSON.stringify(requestBody);
      const upstreamResponseBody = await withResponseText(response, requestId, activeLogger, targetUrl, (text) => text, request.signal);
      const upstreamBodyPreview = upstreamResponseBody.length > 500
        ? `${upstreamResponseBody.substring(0, 500)}...`
        : upstreamResponseBody;
      activeLogger.debug(requestId, `Messages API error from upstream (openai-passthrough): ${response.status}, target URL: ${targetUrl}, request Body: ${bodyPreview.substring(0, 250)} ... ${bodyPreview.substring(bodyPreview.length - 250)}, upstream response body: ${upstreamBodyPreview}`);
      handleTargetApiError(response, 'Messages API', { url: targetUrl, status: response.status, body: bodyPreview, upstreamBody: upstreamResponseBody });
    }

    // Get local token counting config
    const tokenCountingConfig = getTokenCountingConfig(env);

    // For OpenAI format pass-through, convert response to Claude format
    if (isStreaming) {
      return handleStreamingResponse(response, model, requestId, activeLogger, openaiRequestBody, tokenCountingConfig);
    }
    return handleNonStreamingResponse(response, model, requestId, activeLogger, openaiRequestBody, tokenCountingConfig, request.signal);
  }

  // Claude format - convert to OpenAI
  const claudeRequest = requestBody as unknown as ClaudeMessagesRequest;

  // Detect interleaved-thinking beta header (per docs/claude-extended-thinking.md:323):
  // when present, budget_tokens is allowed to exceed max_tokens.
  const betaFeatures = validateBetaFeatures(authHeaders['anthropic-beta'] ?? null);
  const interleavedThinking = hasBetaFeature(betaFeatures, 'interleaved-thinking-2025-05-14');

  // Validate Claude request
  validateClaudeMessagesRequest(claudeRequest, undefined, undefined, interleavedThinking);

  // Log thinking type configuration
  const thinking = claudeRequest.thinking;
  if (thinking) {
    activeLogger.debug(requestId, `Thinking: ${JSON.stringify(thinking)}`);
    const thinkingType = thinking.type === true || thinking.type === 'enabled' || thinking.type === 'adaptive' ? 'enabled' : 'disabled';
    const budget = 'budget_tokens' in thinking && thinking.budget_tokens ? `budget_tokens: ${thinking.budget_tokens}` : 'budget: unknown';
    activeLogger.debug(requestId, `Thinking type: ${thinkingType}, ${budget} extracted from Claude-Format`);
  } else {
    activeLogger.debug(requestId, `Thinking type: not specified by req body format=message`);
  }

  // Get target model ID
  const targetModelId = modelId || claudeRequest.model;

  // Check if streaming is requested
  const isStreaming = claudeRequest.stream === true;

  // Log request info. Flags: 's' present when streaming, 't' when thinking is
  // enabled (matching the thinkingType check above — a "disabled"/false thinking
  // block counts as off, not on).
  const flags = [isStreaming && 's', thinking && thinking.type !== 'disabled' && thinking.type !== false && 't']
    .filter(Boolean)
    .join(',');
  activeLogger.info(requestId, `${targetModelId},(${flags}) [openai-completions] ${userAgent}`);
  activeLogger.debug(requestId, `Has auth headers: ${!!authHeaders['Authorization'] || !!authHeaders['x-api-key']}`);
  activeLogger.debug(requestId, `Is for SDK Model: ${isSdkUrl(targetUrl)} with upstreamMode: ${upstreamMode}`);

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

      // Use appropriate SDK handler based on upstream mode
      if (upstreamMode === 'anthropic-messages') {
          return handleSdkAnthropicRequest(
              request,
              targetUrl,
              requestId,
              apiKey,
              targetModelId,
              activeLogger,
              env,
              requestBody
          );
      }
      return handleSdkOpenAIRequest(
          request,
          targetUrl,
          requestId,
          apiKey,
          targetModelId,
          activeLogger,
          env,
          requestBody,
          'claude'
      );
  }

  // before_conversion: apply client-schema transforms that need route/upstreamMode resolved
  // but must run before format conversion (e.g. drop fields only for a specific upstream).
  if (route) {
    const hookCtxConv: HookContext = {
      hook: 'before_conversion',
      route,
      upstreamMode: upstreamMode || 'openai-completions',
      clientModel: targetModelId || claudeRequest.model || 'unknown',
      requestId,
      streaming: claudeRequest.stream === true,
      logger: activeLogger,
    };
    const convResult = runHook('before_conversion', { body: requestBody as Record<string, unknown>, headers: authHeaders }, hookCtxConv);
    // Re-read any fields that may have been mutated (shallow merge for typed claudeRequest)
    Object.assign(claudeRequest, convResult.body);
  }

  // Convert to OpenAI format
  const openaiRequest: OpenAIRequest = convertClaudeToOpenAIRequest(claudeRequest, targetModelId, conversionOptions);

  // Strip thinking field for openai-completions (derive reasoning_effort from budget_tokens)
  if (upstreamMode === 'openai-completions' && openaiRequest.thinking !== undefined) {
    if (openaiRequest.thinking.enabled && openaiRequest.thinking.budget_tokens !== undefined && !openaiRequest.reasoning_effort) {
      const budget = openaiRequest.thinking.budget_tokens;
      openaiRequest.reasoning_effort = budgetToReasoningEffort(budget, conversionOptions);
    }
    delete openaiRequest.thinking;
  }

  // OpenAI Responses API upstream: convert Completions request → Responses request,
  // POST to /v1/responses, then convert the Responses response back to Claude format.
  if (upstreamMode === 'openai-responses') {
    activeLogger.info(requestId, `Upstream (stream=${isStreaming}): /v1/responses → ${targetModelId}`);

    // Build Responses API request body from the converted Completions request.
    // The Responses API uses `input` (array of message items) instead of `messages`.
    const responsesBody: Record<string, unknown> = completionsToResponsesBody(
      openaiRequest as unknown as Record<string, unknown>,
      openaiRequest.model,
    );
    responsesBody.stream = isStreaming;

    // Same hook, same reason as the OpenAI-Responses egress above: the per-entry
    // maxTokens cap only runs inside `runHook('before_upstream')`.
    let upstreamBodyResponses: Record<string, unknown> = responsesBody;
    if (route) {
      const hookCtxResponses: HookContext = {
        hook: 'before_upstream',
        route,
        upstreamMode: 'openai-responses',
        clientModel: (requestBody.model as string) || modelId || 'unknown',
        requestId,
        streaming: isStreaming,
        logger: activeLogger,
      };
      ({ body: upstreamBodyResponses, headers: authHeaders } = runHook('before_upstream', { body: upstreamBodyResponses, headers: authHeaders }, hookCtxResponses));
    }

    logPipelineStage(activeLogger, requestId, 'upstream-request', targetUrl, upstreamBodyResponses);
    // §5.3 shape 3 (claude.ts:154 precedent): a body that still carries refs is
    // sent as a stream — skeleton plus one blob chunk at a time — with the exact
    // length the serializer measured and `duplex: 'half'`. A ref-free body sends
    // the expanded string exactly as before.
    const responsesStreamed = streamRefs ? createRefAwareJsonBody(upstreamBodyResponses) : undefined;
    const responsesEgress = responsesStreamed
      ? { body: responsesStreamed.body, contentLength: responsesStreamed.contentLength, spilled: true }
      : await createJsonEgressBody(upstreamBodyResponses, 'att-');
    const responsesFetchHeaders2 = {
      'Content-Type': 'application/json',
      ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), request),
      ...(responsesEgress.contentLength !== undefined ? { 'Content-Length': String(responsesEgress.contentLength) } : {}),
    };
    logPipelineHeaders(activeLogger, requestId, 'upstream-request', targetUrl, responsesFetchHeaders2);
    let responsesResponse = await fetch(targetUrl, {
      method: 'POST',
      headers: responsesFetchHeaders2,
      body: responsesEgress.body,
      ...(responsesEgress.spilled ? { duplex: 'half' } : {}),
      signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
    });

    if (route) {
      responsesResponse = await applyAfterUpstream(responsesResponse, {
        hook: 'after_upstream', route, upstreamMode: 'openai-responses',
        clientModel: (requestBody.model as string) || modelId || 'unknown',
        requestId, streaming: isStreaming, logger: activeLogger,
        signal: request.signal,
      });
    }

    logPipelineHeaders(activeLogger, requestId, 'upstream-response', targetUrl, responsesResponse.headers);
    recordResponseStatusCodeFromUpstream(responsesResponse.status);
    recordUpstreamResponseToolCount('openai-responses', 0);
    recordUpstreamRateLimit(targetModelId, (name) => responsesResponse.headers.get(name), targetUrl);

    if (!responsesResponse.ok) {
      const upstreamResponseBody = await withResponseText(responsesResponse, requestId, activeLogger, targetUrl, (text) => text, request.signal);
      activeLogger.error(requestId, `Messages->Responses API error: ${responsesResponse.status}, URL: ${targetUrl}, upstream body: ${upstreamResponseBody.substring(0, 500)}`);
      handleTargetApiError(responsesResponse, 'Messages API (via Responses)', { url: targetUrl, body: JSON.stringify(responsesBody), upstreamBody: upstreamResponseBody });
    }

    const tokenCountingConfig = getTokenCountingConfig(env);

    if (isStreaming) {
      // Stream from upstream Responses API (SSE), re-emit as Claude SSE.
      // Convert each `response.output_text.delta` event to a Claude `content_block_delta`.
      return handleResponsesStreamAsClaude(responsesResponse, targetModelId, requestId, activeLogger, requestBody);
    }

    // Non-streaming: parse Responses response and convert to Claude format.
    const responsesJson = await receiveJsonResponse<OpenAIResponsesResponse>(
      responsesResponse, requestId, activeLogger, targetUrl, request.signal,
    );

    // Synthesise an OpenAI Completions-style response so we can reuse the existing converter.
    const outputItem = responsesJson.output?.find(o => o.type === 'message');
    const textPart = outputItem?.content?.find(c => c.type === 'output_text');
    const toolCallItems = responsesJson.output?.filter(o => o.type === 'function_call') ?? [];

    const syntheticCompletions: OpenAIResponse = {
      id: responsesJson.id ?? 'resp_unknown',
      object: 'chat.completion',
      created: responsesJson.created_at ?? Math.floor(Date.now() / 1000),
      model: responsesJson.model ?? targetModelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: textPart?.text ?? '',
          tool_calls: toolCallItems.length > 0
            ? toolCallItems.map(tc => ({
                id: tc.call_id ?? tc.id ?? `call_${Date.now()}`,
                type: 'function' as const,
                function: { name: tc.name ?? '', arguments: tc.arguments ?? '' },
              }))
            : undefined,
        },
        finish_reason: toolCallItems.length > 0 ? 'tool_calls' : 'stop',
        logprobs: null,
      }],
      usage: responsesJson.usage ? {
        prompt_tokens: responsesJson.usage.input_tokens,
        completion_tokens: responsesJson.usage.output_tokens,
        total_tokens: responsesJson.usage.total_tokens,
      } : undefined,
    };

    const claudeResponse = await convertOpenAIToClaudeResponse(syntheticCompletions, targetModelId, requestId, requestBody, tokenCountingConfig);
    logPipelineStage(activeLogger, requestId, 'outbound', '/v1/messages', claudeResponse);
    return new Response(JSON.stringify(claudeResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
    });
  }

  const upstreamRequest = JSON.stringify(openaiRequest);
  activeLogger.debug(requestId, `Converted request (claude->openai): ${upstreamRequest.substring(0, 250)} ... ${upstreamRequest.substring(upstreamRequest.length - 250)}`);
  logPipelineStage(activeLogger, requestId, 'upstream-request', targetUrl, openaiRequest);

  // Log the actual auth headers being sent upstream (for openai-completions)
  const finalHeaders = addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), request);
  if (finalHeaders['Authorization']) {
    const masked = finalHeaders['Authorization'].length > 16 ? `${finalHeaders['Authorization'].substring(0, 16)}...` : '***';
    activeLogger.debug(requestId, `Upstream Authorization: ${masked}`);
  } else if (finalHeaders['x-api-key']) {
    const masked = finalHeaders['x-api-key'].length > 8 ? `${finalHeaders['x-api-key'].substring(0, 8)}...` : '***';
    activeLogger.debug(requestId, `Upstream x-api-key: ${masked}`);
  }

  // before_upstream: apply declared transforms to the converted upstream body.
  // (max_tokens → max_completion_tokens rename handled by the transform engine)
  let upstreamBodyClaude: Record<string, unknown> = openaiRequest as unknown as Record<string, unknown>;
  if (route) {
    const hookCtxClaude: HookContext = {
      hook: 'before_upstream',
      route,
      upstreamMode: upstreamMode || 'openai-completions',
      clientModel: (requestBody.model as string) || modelId || 'unknown',
      requestId,
      streaming: requestBody.stream === true,
      logger: activeLogger,
    };
    ({ body: upstreamBodyClaude, headers: authHeaders } = runHook('before_upstream', { body: upstreamBodyClaude, headers: authHeaders }, hookCtxClaude));
  }
  const claudeFetchHeadersBase = { 'Content-Type': 'application/json', ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), request) };
  // §5.3 shape 3: see the OpenAI-Responses send above — the converted body
  // streams its blobs at their ref positions instead of being expanded into one
  // string first. `upstreamRequest` above is only a log preview, so a ref left in
  // it costs a few metadata bytes there and nothing upstream.
  const claudeStreamed = streamRefs ? createRefAwareJsonBody(upstreamBodyClaude) : undefined;
  const claudeEgress = claudeStreamed
    ? { body: claudeStreamed.body, contentLength: claudeStreamed.contentLength, spilled: true }
    : await createJsonEgressBody(upstreamBodyClaude, 'att-');
  const claudeFetchHeaders = {
    ...claudeFetchHeadersBase,
    ...(claudeEgress.contentLength !== undefined ? { 'Content-Length': String(claudeEgress.contentLength) } : {}),
  };
  logPipelineHeaders(activeLogger, requestId, 'upstream-request', targetUrl, claudeFetchHeaders);
  let response = await fetch(targetUrl, {
    method: 'POST',
    headers: claudeFetchHeaders,
    body: claudeEgress.body,
    ...(claudeEgress.spilled ? { duplex: 'half' } : {}),
    signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
  });

  if (route) {
    response = await applyAfterUpstream(response, {
      hook: 'after_upstream', route, upstreamMode: upstreamMode || 'openai-completions',
      clientModel: (requestBody.model as string) || modelId || 'unknown',
      requestId, streaming: requestBody.stream === true, logger: activeLogger,
      signal: request.signal,
    });
  }

  // Debug log upstream response for test model requests (claude->openai, LOG_LEVEL=debug)
  if (env?.LOG_LEVEL === 'debug') {
    try {
      if (upstreamRequest.includes('test_tool')) {
        response = captureTestModelLog(response, 'claude->openai', targetUrl, requestId, activeLogger);
      }
    } catch (_e) { /* ignore */ }
  }

  logPipelineHeaders(activeLogger, requestId, 'upstream-response', targetUrl, response.headers);
  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount('openai-completions', 0);
  recordUpstreamRateLimit(targetModelId, (name) => response.headers.get(name), targetUrl);

  // Handle target API errors
  if (!response.ok) {
    const bodyPreview = typeof openaiRequest === 'string'
      ? openaiRequest
      : JSON.stringify(openaiRequest);
    const upstreamResponseBody = await withResponseText(response, requestId, activeLogger, targetUrl, (text) => text, request.signal);
    const upstreamBodyPreview = upstreamResponseBody.length > 500
      ? `${upstreamResponseBody.substring(0, 500)}...`
      : upstreamResponseBody;
    activeLogger.debug(requestId, `Messages API error from upstream (claude->openai): ${response.status}, target URL: ${targetUrl}, request Body: ${bodyPreview.substring(0, 250)} ... ${bodyPreview.substring(bodyPreview.length - 250)}, upstream response body: ${upstreamBodyPreview}`);
    handleTargetApiError(response, 'Messages API', { url: targetUrl, status: response.status, body: bodyPreview, upstreamBody: upstreamResponseBody });
  }

  // Get local token counting config
  const tokenCountingConfig = getTokenCountingConfig(env);

  // Handle streaming response
  if (isStreaming) {
    return handleStreamingResponse(response, targetModelId, requestId, activeLogger, requestBody, tokenCountingConfig);
  }

  // Handle non-streaming response
  return handleNonStreamingResponse(response, targetModelId, requestId, activeLogger, requestBody, tokenCountingConfig, request.signal);
}

/** Characters of an upstream body the `/tmp/test_model.log` capture keeps. */
const TEST_MODEL_LOG_CHARS = 2000;

/**
 * §5.7: copy the start of an upstream response body to `/tmp/test_model.log` by
 * observing the one path the client already reads.
 *
 * Both call sites used to capture it with `response.clone().text()`: the tee
 * gave the logging branch a reader of its own, which ran ahead of the client and
 * held the whole body — a spooled response included — in its unread queue for a
 * debug line. Here every chunk is passed on unchanged, the first
 * {@link TEST_MODEL_LOG_CHARS} decoded characters are kept, and the line is
 * appended once the body reaches a terminal state. The line therefore lands when
 * the body is consumed rather than when the upstream finished, and a client that
 * disconnects before the end leaves none where the clone wrote one whatever the
 * client did.
 *
 * A manual stream rather than a `TransformStream` because the two terminal paths
 * are not the same one: a body read to its end (`receiveJsonResponse`, the error
 * path's `text()`) closes the stream, while the SSE egress stops at `[DONE]` by
 * terminating the converter downstream, which cancels this reader instead of
 * flushing it. {@link createRefAwareJsonBody} writes its one terminal action the
 * same way, and for the same reason; a `flush` alone would silently drop the
 * capture on every converted stream.
 *
 * `observeStream`'s rule applies to the capture itself: this sits on the client's
 * only path, where a throw would abort a response the tee'd branch could not have
 * touched, so a failed append becomes one debug line. The response returned is a
 * constructed one and so carries no `url`; the trace labels downstream already
 * fall back to `'(upstream)'` there — what they read after `applyAfterUpstream`
 * rebuilds a response too.
 */
function captureTestModelLog(
  response: Response,
  label: string,
  targetUrl: string,
  requestId: string,
  logger: Logger,
): Response {
  const decoder = new TextDecoder();
  let captured = '';
  let finished = false;

  /** One path per terminal state, and only one of them runs: the line is a `---`. */
  const finish = (): void => {
    if (finished) return;
    finished = true;
    // Flushing the decoder releases a sequence split across the last two chunks,
    // so the text is the one `text()` would have produced.
    if (captured.length < TEST_MODEL_LOG_CHARS) captured += decoder.decode();
    try {
      appendFileSync(join(tmpdir(), 'test_model.log'),
        `[${new Date().toISOString()}] upstream response (${label})\n` +
        `upstream url: ${targetUrl}\n` +
        `upstream status: ${response.status}\n` +
        `upstream response body:\n${captured.slice(0, TEST_MODEL_LOG_CHARS)}\n` +
        `---\n`,
      );
    } catch (error) {
      logger.debug(requestId, `Test model log capture failed: ${(error as Error).message}`);
    }
  };

  const source = response.body;
  if (!source) {
    // Nothing to observe and nothing left to read: the capture is complete.
    finish();
    return response;
  }

  const reader = source.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await reader.read();
      } catch (error) {
        finish();
        controller.error(error);
        return;
      }
      if (next.done) {
        finish();
        controller.close();
        return;
      }
      controller.enqueue(next.value);
      if (captured.length < TEST_MODEL_LOG_CHARS) captured += decoder.decode(next.value, { stream: true });
    },
    async cancel(reason) {
      // The converter stopped the stream early (or the client went away): what was
      // read is all there will be, and the upstream body is released here because
      // this reader, not a `pipeThrough`, is now the one holding it.
      finish();
      await reader.cancel(reason);
    },
  });

  return new Response(body, response);
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  response: Response,
  model: string,
  requestId: string,
  logger: Logger,
  requestBody?: Record<string, unknown>,
  tokenCountingConfig?: TokenCountingConfig,
  signal?: AbortSignal
): Promise<Response> {
  // §5.7: bounded receive outside the `try` below, so a cap breach keeps its own
  // status instead of being re-wrapped as a conversion failure.
  const openaiResponse = await receiveJsonResponse<OpenAIResponse>(
    response, requestId, logger, response.url || '(upstream)', signal,
  );

  try {
    // Convert to Claude format
    const claudeResponse: ClaudeMessagesResponse = await convertOpenAIToClaudeResponse(
      openaiResponse,
      model,
      requestId,
      requestBody,
      tokenCountingConfig
    );
    logPipelineStage(logger, requestId, 'outbound', '/v1/messages', claudeResponse);

    // Return response with Claude headers
    const nonStreamOutHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
    logPipelineHeaders(logger, requestId, 'outbound', '/v1/messages', nonStreamOutHeaders);
    return new Response(JSON.stringify(claudeResponse), {
      status: 200,
      headers: nonStreamOutHeaders,
    });
  } catch (error) {
    logger.error(requestId, `Error converting response: ${(error as Error).message}`);
    throw new Error(`Failed to convert response: ${(error as Error).message}`);
  }
}

/**
 * Handle streaming response
 */
async function handleStreamingResponse(
  response: Response,
  model: string,
  requestId: string,
  logger: Logger,
  requestBody?: Record<string, unknown>,
  tokenCountingConfig?: TokenCountingConfig
): Promise<Response> {
  // Check if response body exists and is readable
  if (!response.body) {
    throw new Error('Response body is not readable');
  }

  try {

    // §5.3: resolve input usage before the response stream exists, so the
    // transformer carries a scalar rather than retaining the request body.
    const inputTokens = tokenCountingConfig?.enabled ? estimateInputTokens(requestBody) : 0;

    // Create streaming transformer
    const transformer = createStreamTransformer(model, requestId, inputTokens, tokenCountingConfig);

    // §5.7: both the raw upstream SSE and the outbound (Claude SSE) events are
    // logged by observing the one path the client already reads, rather than by
    // teeing each a second reader that would pull the stream through on its own.
    const transformedStream = response.body
      .pipeThrough(observeStream(logger, requestId, 'upstream-response', response.url || '(upstream SSE)', 'sse-lines'))
      .pipeThrough(new TransformStream(transformer))
      .pipeThrough(observeStream(logger, requestId, 'outbound', '/v1/messages (SSE)', 'sse-lines'));

    // Return streaming response with proper headers
    const streamOutHeaders = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'x-request-id': requestId,
    };
    logPipelineHeaders(logger, requestId, 'outbound', '/v1/messages', streamOutHeaders);
    return new Response(transformedStream, { status: 200, headers: streamOutHeaders });
  } catch (error) {
    logger.error(requestId, `Error creating streaming response: ${(error as Error).message}`);
    throw new Error(`Failed to create streaming response: ${(error as Error).message}`);
  }
}

/**
 * Convert an upstream OpenAI Responses API SSE stream to Claude SSE format.
 *
 * Responses API events consumed:
 *   response.created                    → emit message_start
 *   response.output_text.delta          → emit content_block_delta
 *   response.output_text.done           → emit content_block_stop
 *   response.completed                  → emit message_delta (stop) + message_stop
 *
 * Tool-call events (response.output_item.added with function_call type) are
 * mapped to Claude tool_use content blocks.
 */
function handleResponsesStreamAsClaude(
  upstreamResponse: Response,
  model: string,
  requestId: string,
  logger: Logger,
  requestBody?: Record<string, unknown>,
): Response {
  if (!upstreamResponse.body) {
    throw new Error('Upstream Responses stream body is not readable');
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // §5.3: resolve input usage before the response stream exists, so the pump
  // below does not retain the request body for the stream's lifetime. This
  // path counts whenever a body was handed in (it never consulted the
  // token-counting config), and that behaviour is preserved here.
  const estimatedInputTokens = estimateInputTokens(requestBody);

  function claudeEvent(event: string, data: unknown): Uint8Array {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  let failed = false;

  async function pump() {
    try {
      const messageId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

      // Starts at the pre-stream estimate; upstream-reported usage replaces it
      // when the response.completed event carries one.
      let inputTokens = estimatedInputTokens;

      await writer.write(claudeEvent('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          content: [],
          model,
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
      }));

      let textBlockIndex = -1;
      // Map from function_call output_index → Claude content block index
      const toolBlockIndex = new Map<number, number>();
      let nextBlockIndex = 0;
      let buffer = '';
      let outputTokens = 0;
      let completed = false;

      const reader = upstreamResponse.body!.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw || raw === '[DONE]') continue;

          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(raw);
          } catch {
            throw new Error(`Invalid JSON in Responses SSE data (request ${requestId})`);
          }

          const type = evt.type as string | undefined;

          if (type === 'response.output_item.added') {
            const item = evt.item as Record<string, unknown> | undefined;
            if (item?.type === 'function_call') {
              const outputIndex = evt.output_index as number ?? nextBlockIndex;
              const blockIdx = nextBlockIndex++;
              toolBlockIndex.set(outputIndex, blockIdx);
              await writer.write(claudeEvent('content_block_start', {
                type: 'content_block_start',
                index: blockIdx,
                content_block: {
                  type: 'tool_use',
                  id: item.call_id ?? item.id ?? `call_${Date.now()}`,
                  name: item.name ?? '',
                  input: {},
                },
              }));
            }
          } else if (type === 'response.output_text.delta') {
            if (textBlockIndex === -1) {
              textBlockIndex = nextBlockIndex++;
              await writer.write(claudeEvent('content_block_start', {
                type: 'content_block_start',
                index: textBlockIndex,
                content_block: { type: 'text', text: '' },
              }));
            }
            await writer.write(claudeEvent('content_block_delta', {
              type: 'content_block_delta',
              index: textBlockIndex,
              delta: { type: 'text_delta', text: evt.delta ?? '' },
            }));
          } else if (type === 'response.function_call_arguments.delta') {
            const outputIndex = evt.output_index as number ?? 0;
            const blockIdx = toolBlockIndex.get(outputIndex);
            if (blockIdx !== undefined) {
              await writer.write(claudeEvent('content_block_delta', {
                type: 'content_block_delta',
                index: blockIdx,
                delta: { type: 'input_json_delta', partial_json: evt.delta ?? '' },
              }));
            }
          } else if (type === 'response.output_text.done') {
            if (textBlockIndex !== -1) {
              await writer.write(claudeEvent('content_block_stop', {
                type: 'content_block_stop',
                index: textBlockIndex,
              }));
            }
          } else if (type === 'response.output_item.done') {
            const item = evt.item as Record<string, unknown> | undefined;
            if (item?.type === 'function_call') {
              const outputIndex = evt.output_index as number ?? 0;
              const blockIdx = toolBlockIndex.get(outputIndex);
              if (blockIdx !== undefined) {
                await writer.write(claudeEvent('content_block_stop', {
                  type: 'content_block_stop',
                  index: blockIdx,
                }));
              }
            }
          } else if (type === 'response.failed') {
            throw new Error(`Responses stream failed before response.completed (request ${requestId})`);
          } else if (type === 'response.completed') {
            const resp = evt.response as Record<string, unknown> | undefined;
            const usage = resp?.usage as Record<string, unknown> | undefined;
            if (usage) {
              inputTokens = (usage.input_tokens as number) ?? 0;
              outputTokens = (usage.output_tokens as number) ?? 0;
            }
            const hasToolUse = toolBlockIndex.size > 0;
            await writer.write(claudeEvent('message_delta', {
              type: 'message_delta',
              delta: {
                stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
                stop_sequence: null,
              },
              usage: { input_tokens: inputTokens, output_tokens: outputTokens },
            }));
            await writer.write(claudeEvent('message_stop', { type: 'message_stop' }));
            completed = true;
          }
        }
        if (completed) break;
      }

      if (!completed) {
        throw new Error(`Responses stream ended before response.completed (request ${requestId})`);
      }
      logger.debug(requestId, `Responses stream done: input=${inputTokens} output=${outputTokens}`);
    } catch (e) {
      failed = true;
      logger.error(requestId, `Error in Responses->Claude stream: ${(e as Error).message}`);
      await writer.abort(e);
    } finally {
      if (!failed) await writer.close();
    }
  }

  pump();

  const responsesStreamOutHeaders = {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'x-request-id': requestId,
  };
  logPipelineHeaders(logger, requestId, 'outbound', '/v1/messages', responsesStreamOutHeaders);
  return new Response(readable, { status: 200, headers: responsesStreamOutHeaders });
}
