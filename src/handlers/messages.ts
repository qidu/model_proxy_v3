/**
 * Messages API handler for Claude Proxy v3
 *
 * Handles POST /v1/messages endpoint with extended thinking support
 */

import { Env } from '../types/shared.js';
import { tmpdir } from 'os';
import { join } from 'path';
import { Logger, createLogger, logPipelineStage, logPipelineHeaders } from '../utils/logger.js';
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
import { addForwardedHeaders, normalizeOpenAIAuthHeaders } from '../utils/routing.js';
import { runHook, applyAfterUpstream, type HookContext } from '../utils/request-transform.js';
import type { ModelRouteConfig } from '../utils/config-loader.js';
import { countClaudeRequestTokens, getLocalTokenCountingConfig, TokenCountingOptions } from '../utils/token-counting.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { recordResponseStatusCodeFromUpstream, recordUpstreamResponseToolCount } from '../utils/dashboard-stats.js';
import { recordUpstreamRateLimit } from '../utils/provider-quota.js';
import { OpenAIResponsesResponse } from '../converters/completions-to-responses.js';

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

function normalizeOpenAICompletionsBody(requestBody: Record<string, unknown>): Record<string, unknown> {
  const normalizedBody: Record<string, unknown> = { ...requestBody };
  const outputConfig = normalizedBody.output_config as Record<string, unknown> | undefined;
  if (outputConfig && normalizedBody.reasoning_effort === undefined && outputConfig.effort !== undefined) {
    normalizedBody.reasoning_effort = outputConfig.effort;
  }
  return normalizedBody;
}

/**
 * Convert OpenAI Chat Completions tools ({type:"function", function:{name, ...}})
 * into the Responses API flat tool form ({type:"function", name, ...}).
 */
function completionsToolsToResponsesTools(tools: unknown[] | undefined): unknown[] | undefined {
  if (!tools || !Array.isArray(tools)) return tools;
  return tools.map((t) => {
    const tool = t as Record<string, unknown>;
    if (tool.type !== 'function') return tool;
    const fn = tool.function as Record<string, unknown> | undefined;
    if (!fn) return tool;
    const flat: Record<string, unknown> = { type: 'function' };
    if (fn.name !== undefined) flat.name = fn.name;
    if (fn.description !== undefined) flat.description = fn.description;
    if (fn.parameters !== undefined) flat.parameters = fn.parameters;
    return flat;
  });
}

/**
 * Convert OpenAI Chat Completions tool_choice to Responses API form.
 * Completions: {type:"function", function:{name:"..."}} or "auto"/"none"/"required"
 * Responses:   {type:"function", name:"..."} or "auto"/"none"/"required"
 */
function completionsToolChoiceToResponsesToolChoice(tc: unknown): unknown {
  if (typeof tc !== 'object' || tc === null) return tc;
  const obj = tc as Record<string, unknown>;
  if (obj.type !== 'function') return obj;
  const fn = obj.function as Record<string, unknown> | undefined;
  if (!fn) return obj;
  const flat: Record<string, unknown> = { type: 'function' };
  if (fn.name !== undefined) flat.name = fn.name;
  return flat;
}

/**
 * Convert OpenAI Chat Completions `messages` array into a Responses API
 * `input` array.
 *
 * The Responses API uses a different content part vocabulary:
 *   - `text` (Completions) → `input_text` (user/system) or `output_text` (assistant)
 *   - `image_url`         → `input_image`
 * Tool calls on assistant messages become standalone `function_call` items;
 * `tool` role messages become `function_call_output` items.
 */
function completionsMessagesToResponsesInput(messages: unknown[]): unknown[] {
  const input: unknown[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const msg = raw as Record<string, unknown>;
    const role = msg.role as string | undefined;
    const content = msg.content;

    // Extract reasoning carried on the message itself (OpenAI wire-format
    // `reasoning_content` is a per-message field set by thinking-mode upstreams
    // such as DeepSeek). Emit a Responses-side `reasoning` item so the prior
    // turn's reasoning round-trips and DeepSeek doesn't reject the next turn
    // with "reasoning_content must be passed back".
    const inlineReasoning = msg.reasoning_content;
    if (role === 'assistant' && typeof inlineReasoning === 'string' && inlineReasoning) {
      input.push({
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: inlineReasoning }],
      });
    }

    // assistant message with tool_calls → emit function_call items (no message item)
    if (role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
        const fn = tc.function as Record<string, unknown> | undefined;
        input.push({
          type: 'function_call',
          call_id: tc.id ?? `call_${Date.now()}`,
          name: fn?.name ?? '',
          arguments: fn?.arguments ?? '',
        });
      }
      // If the assistant message also has text content, fall through to emit a message item too
      if (content === undefined || content === null || content === '') continue;
    }

    // tool role → function_call_output item
    if (role === 'tool') {
      const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id ?? '',
        output: text,
      });
      continue;
    }

    // Regular message → map content parts to Responses vocabulary
    const textType = role === 'assistant' ? 'output_text' : 'input_text';
    let contentParts: unknown[];
    if (typeof content === 'string') {
      contentParts = [{ type: textType, text: content }];
    } else if (Array.isArray(content)) {
      const parts: unknown[] = [];
      for (const part of content as Array<Record<string, unknown>>) {
        const pType = part.type as string;
        if (pType === 'text') {
          parts.push({ type: textType, text: part.text ?? '' });
        } else if (pType === 'image_url') {
          parts.push({ type: 'input_image', image_url: part.image_url });
        } else if (pType === 'thinking') {
          // Thinking-mode content parts: emit a Responses `reasoning` item
          // carrying a single `reasoning_text` part so the prior reasoning
          // round-trips to thinking-mode upstreams (DeepSeek requires it).
          input.push({
            type: 'reasoning',
            content: [{ type: 'reasoning_text', text: part.thinking ?? '' }],
          });
        }
        // unknown part types are dropped (intentional; narrower than silent swallow)
      }
      contentParts = parts;
    } else {
      contentParts = [{ type: textType, text: JSON.stringify(content ?? '') }];
    }

    input.push({
      role: role ?? 'user',
      content: contentParts,
    });
  }
  return input;
}

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

  // Clone request before parsing body to preserve body for SDK handler
  // Parse request body from cloned request
  const requestBody = isSdkUrl(targetUrl) ? await request.clone().json() as Record<string, unknown> : await request.json() as Record<string, unknown>;
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
    // Request is already in OpenAI format, pass through directly
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
      const responsesBody: Record<string, unknown> = {
        model: openaiRequestBody.model ?? model,
        input: completionsMessagesToResponsesInput(openaiRequestBody.messages as unknown[]),
        stream: isStreaming,
      };
      if (openaiRequestBody.temperature !== undefined) responsesBody.temperature = openaiRequestBody.temperature;
      if (openaiRequestBody.top_p !== undefined) responsesBody.top_p = openaiRequestBody.top_p;
      if (openaiRequestBody.max_tokens !== undefined) responsesBody.max_output_tokens = openaiRequestBody.max_tokens;
      if (openaiRequestBody.tools !== undefined) responsesBody.tools = completionsToolsToResponsesTools(openaiRequestBody.tools as unknown[]);
      if (openaiRequestBody.tool_choice !== undefined) responsesBody.tool_choice = completionsToolChoiceToResponsesToolChoice(openaiRequestBody.tool_choice);

      logPipelineStage(activeLogger, requestId, 'upstream-request', targetUrl, responsesBody);
      const responsesFetchHeaders1 = { 'Content-Type': 'application/json', ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), request) };
      logPipelineHeaders(activeLogger, requestId, 'upstream-request', targetUrl, responsesFetchHeaders1);
      let responsesResponse = await fetch(targetUrl, {
        method: 'POST',
        headers: responsesFetchHeaders1,
        body: JSON.stringify(responsesBody),
        signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
      });

      if (route) {
        responsesResponse = await applyAfterUpstream(responsesResponse, {
          hook: 'after_upstream', route, upstreamMode: 'openai-responses',
          clientModel: (requestBody.model as string) || modelId || 'unknown',
          requestId, streaming: isStreaming, logger: activeLogger,
        });
      }

      logPipelineHeaders(activeLogger, requestId, 'upstream-response', targetUrl, responsesResponse.headers);
      recordResponseStatusCodeFromUpstream(responsesResponse.status);
      recordUpstreamResponseToolCount('openai-responses', 0);
      recordUpstreamRateLimit(model, (name) => responsesResponse.headers.get(name), targetUrl);

      if (!responsesResponse.ok) {
        const upstreamResponseBody = await responsesResponse.text();
        activeLogger.error(requestId, `Messages->Responses API error (openai-passthrough): ${responsesResponse.status}, URL: ${targetUrl}, upstream body: ${upstreamResponseBody.substring(0, 500)}`);
        handleTargetApiError(responsesResponse, 'Messages API (via Responses)', { url: targetUrl, body: JSON.stringify(responsesBody), upstreamBody: upstreamResponseBody });
      }

      const tokenCountingConfig = getTokenCountingConfig(env);
      if (isStreaming) {
        return handleResponsesStreamAsClaude(responsesResponse, model, requestId, activeLogger, requestBody);
      }
      const responsesJsonText = await responsesResponse.text();
      logPipelineStage(activeLogger, requestId, 'upstream-response', targetUrl, responsesJsonText);
      const responsesJson = JSON.parse(responsesJsonText) as OpenAIResponsesResponse;
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
    let response = await fetch(targetUrl, {
      method: 'POST',
      headers: openaiFetchHeaders,
      body: JSON.stringify(upstreamBodyOpenai),
      signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
    });

    if (route) {
      response = await applyAfterUpstream(response, {
        hook: 'after_upstream', route, upstreamMode: upstreamMode || 'openai-completions',
        clientModel: (requestBody.model as string) || modelId || 'unknown',
        requestId, streaming: isStreaming, logger: activeLogger,
      });
    }

    // Debug log upstream response for test model requests (openai-passthrough, LOG_LEVEL=debug)
    if (env?.LOG_LEVEL === 'debug') {
      try {
        const bodyText = typeof requestBody === 'string' ? requestBody : JSON.stringify(requestBody);
        if (bodyText.includes('test_tool')) {
          const respClone = response.clone();
          const respBody = await respClone.text();
          const { appendFileSync } = await import('fs');
          appendFileSync(join(tmpdir(), 'test_model.log'),
            `[${new Date().toISOString()}] upstream response (openai-passthrough)\n` +
            `upstream url: ${targetUrl}\n` +
            `upstream status: ${response.status}\n` +
            `upstream response body:\n${respBody.slice(0, 2000)}\n` +
            `---\n`,
          );
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
      const upstreamResponseBody = await response.text();
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
    return handleNonStreamingResponse(response, model, requestId, activeLogger, openaiRequestBody, tokenCountingConfig);
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
    const responsesBody: Record<string, unknown> = {
      model: openaiRequest.model,
      input: completionsMessagesToResponsesInput(openaiRequest.messages),
      stream: isStreaming,
    };
    if (openaiRequest.temperature !== undefined) responsesBody.temperature = openaiRequest.temperature;
    if (openaiRequest.top_p !== undefined) responsesBody.top_p = openaiRequest.top_p;
    if (openaiRequest.max_tokens !== undefined) responsesBody.max_output_tokens = openaiRequest.max_tokens;
    if (openaiRequest.tools !== undefined) responsesBody.tools = completionsToolsToResponsesTools(openaiRequest.tools);
    if (openaiRequest.tool_choice !== undefined) responsesBody.tool_choice = completionsToolChoiceToResponsesToolChoice(openaiRequest.tool_choice);

    logPipelineStage(activeLogger, requestId, 'upstream-request', targetUrl, responsesBody);
    const responsesFetchHeaders2 = { 'Content-Type': 'application/json', ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), request) };
    logPipelineHeaders(activeLogger, requestId, 'upstream-request', targetUrl, responsesFetchHeaders2);
    let responsesResponse = await fetch(targetUrl, {
      method: 'POST',
      headers: responsesFetchHeaders2,
      body: JSON.stringify(responsesBody),
      signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
    });

    if (route) {
      responsesResponse = await applyAfterUpstream(responsesResponse, {
        hook: 'after_upstream', route, upstreamMode: 'openai-responses',
        clientModel: (requestBody.model as string) || modelId || 'unknown',
        requestId, streaming: isStreaming, logger: activeLogger,
      });
    }

    logPipelineHeaders(activeLogger, requestId, 'upstream-response', targetUrl, responsesResponse.headers);
    recordResponseStatusCodeFromUpstream(responsesResponse.status);
    recordUpstreamResponseToolCount('openai-responses', 0);
    recordUpstreamRateLimit(targetModelId, (name) => responsesResponse.headers.get(name), targetUrl);

    if (!responsesResponse.ok) {
      const upstreamResponseBody = await responsesResponse.text();
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
    const responsesJsonText2 = await responsesResponse.text();
    logPipelineStage(activeLogger, requestId, 'upstream-response', targetUrl, responsesJsonText2);
    const responsesJson = JSON.parse(responsesJsonText2) as OpenAIResponsesResponse;

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
  const claudeFetchHeaders = { 'Content-Type': 'application/json', ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), request) };
  logPipelineHeaders(activeLogger, requestId, 'upstream-request', targetUrl, claudeFetchHeaders);
  let response = await fetch(targetUrl, {
    method: 'POST',
    headers: claudeFetchHeaders,
    body: JSON.stringify(upstreamBodyClaude),
    signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
  });

  if (route) {
    response = await applyAfterUpstream(response, {
      hook: 'after_upstream', route, upstreamMode: upstreamMode || 'openai-completions',
      clientModel: (requestBody.model as string) || modelId || 'unknown',
      requestId, streaming: requestBody.stream === true, logger: activeLogger,
    });
  }

  // Debug log upstream response for test model requests (claude->openai, LOG_LEVEL=debug)
  if (env?.LOG_LEVEL === 'debug') {
    try {
      if (upstreamRequest.includes('test_tool')) {
        const respClone = response.clone();
        const respBody = await respClone.text();
        const { appendFileSync } = await import('fs');
        appendFileSync(join(tmpdir(), 'test_model.log'),
          `[${new Date().toISOString()}] upstream response (claude->openai)\n` +
          `upstream url: ${targetUrl}\n` +
          `upstream status: ${response.status}\n` +
          `upstream response body:\n${respBody.slice(0, 2000)}\n` +
          `---\n`,
        );
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
    const upstreamResponseBody = await response.text();
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
  return handleNonStreamingResponse(response, targetModelId, requestId, activeLogger, requestBody, tokenCountingConfig);
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
  tokenCountingConfig?: TokenCountingConfig
): Promise<Response> {
  try {
    // Parse target API response
    const responseText = await response.text();
    logPipelineStage(logger, requestId, 'upstream-response', response.url || '(upstream)', responseText);

    const openaiResponse: OpenAIResponse = JSON.parse(responseText);

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

  const decoder = new TextDecoder();

  try {

    // Create streaming transformer
    const transformer = createStreamTransformer(model, requestId, requestBody, tokenCountingConfig);

    // Create a tee to read the raw response while also transforming it
    const [stream1, stream2] = response.body.tee();

    // Read and log raw chunks from stream2
    const reader = stream2.getReader();
    const logRawChunks = async () => {
      try {
        let rawData = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          rawData += decoder.decode(value, { stream: true });
          // Log when we have complete lines
          const lines = rawData.split('\n');
          if (lines.length > 1) {
            for (const line of lines.slice(0, -1)) {
              if (line.startsWith('data: ')) {
                const data = line.substring(6);
                if (data.trim() !== '[DONE]') {
                  logPipelineStage(logger, requestId, 'upstream-response', response.url || '(upstream SSE)', data);
                }
              }
            }
            rawData = lines[lines.length - 1] || '';
          }
        }
      } catch (e) {
        logger.error(requestId, `Error logging raw chunks: ${(e as Error).message}`);
      }
    };

    // Start logging in background
    logRawChunks();

    // Create transformed stream from stream1; tee again so the outbound
    // (Claude SSE) events sent to the client are also logged at trace level.
    const [outStream1, outStream2] = stream1
      .pipeThrough(new TransformStream(transformer))
      .tee();
    (async () => {
      try {
        const outReader = outStream2.getReader();
        const outDecoder = new TextDecoder();
        let outBuffer = '';
        while (true) {
          const { done, value } = await outReader.read();
          if (done) break;
          outBuffer += outDecoder.decode(value, { stream: true });
          const lines = outBuffer.split('\n');
          if (lines.length > 1) {
            for (const line of lines.slice(0, -1)) {
              if (line.startsWith('data: ')) {
                const data = line.substring(6);
                if (data.trim() !== '[DONE]') {
                  logPipelineStage(logger, requestId, 'outbound', '/v1/messages (SSE)', data);
                }
              }
            }
            outBuffer = lines[lines.length - 1] || '';
          }
        }
      } catch {
        // best-effort debug logging only
      }
    })();
    const transformedStream = outStream1;

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

  function claudeEvent(event: string, data: unknown): Uint8Array {
    return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  async function pump() {
    try {
      const messageId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

      let inputTokens = 0;
      if (requestBody) {
        try {
          const options: TokenCountingOptions = { useLocalCounting: true, tokenizer: null };
          inputTokens = countClaudeRequestTokens(requestBody as any, options);
        } catch {
          inputTokens = 0;
        }
      }

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
          try { evt = JSON.parse(raw); } catch { continue; }

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
          }
        }
      }

      logger.debug(requestId, `Responses stream done: input=${inputTokens} output=${outputTokens}`);
    } catch (e) {
      logger.error(requestId, `Error in Responses->Claude stream: ${(e as Error).message}`);
    } finally {
      await writer.close();
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
