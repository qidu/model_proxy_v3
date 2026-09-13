/**
 * Passthrough handler for /v1/chat/completions.
 * Forwards the request as-is to the upstream OpenAI-compatible endpoint.
 * No format conversion is performed.
 */

import type { Env, Logger } from '../types/shared.js';
import { logPipelineStage, logPipelineHeaders } from '../utils/logger.js';
import { addForwardedHeaders, normalizeOpenAIAuthHeaders } from '../utils/routing.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { recordResponseStatusCodeFromUpstream } from '../utils/dashboard-stats.js';
import { recordUpstreamRateLimit } from '../utils/provider-quota.js';
import { validateOpenAICompletionsRequest } from '../utils/validation.js';
import { ValidationError } from '../utils/errors.js';
import { completionsToResponsesBody, completionsToClaudeBody, claudeJsonToSyntheticCompletions } from './openai.js';
import { convertCompletionsToGeminiGenerateContentBody } from '../converters/claude-to-gemini.js';
import { convertGeminiGenerateContentToClaude } from '../converters/gemini-to-claude.js';
import { runHook, applyAfterUpstream, type HookContext } from '../utils/request-transform.js';
import type { ModelRouteConfig } from '../utils/config-loader.js';


export async function handleChatCompletionsPassthrough(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  logger: Logger,
  env: Env,
  modelId?: string,
  upstreamMode?: string,
  route?: ModelRouteConfig,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  logger.info(requestId, `${path} passthrough → ${targetUrl} model=${modelId || 'unknown'} upstream=${upstreamMode || 'openai-completions'}`);

  const bodyText = await request.text();

  // Validate against openai-completions schema
  let parsedBody: Record<string, unknown>;
  try {
    parsedBody = JSON.parse(bodyText);
    validateOpenAICompletionsRequest(parsedBody);
  } catch (err) {
    if (err instanceof ValidationError) {
      logger.warn(requestId, `${path} validation failed: ${err.message}`);
      return new Response(JSON.stringify({ error: { message: err.message, type: 'invalid_request_error' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
      });
    }
    logger.warn(requestId, `${path} invalid JSON body: ${(err as Error).message}`);
    return new Response(JSON.stringify({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
    });
  }

  const isStreaming = parsedBody.stream === true;
  logger.debug(requestId, `${path} req: model=${parsedBody.model} messages=${Array.isArray(parsedBody.messages) ? (parsedBody.messages as unknown[]).length : 0} stream=${isStreaming}`);
  logPipelineStage(logger, requestId, 'inbound', path, parsedBody);
  logPipelineHeaders(logger, requestId, 'inbound', path, request.headers);

  // before_upstream: apply any declared transforms (builtins + ops) before forwarding.
  if (route) {
    const hookCtx: HookContext = {
      hook: 'before_upstream',
      route,
      upstreamMode: upstreamMode || 'openai-completions',
      clientModel: (parsedBody.model as string) || modelId || 'unknown',
      requestId,
      streaming: isStreaming,
      logger,
    };
    ({ body: parsedBody, headers: authHeaders } = runHook('before_upstream', { body: parsedBody, headers: authHeaders }, hookCtx));
  }

  // When the upstream is anthropic-messages, convert completions body → Claude Messages,
  // forward to upstream, then convert the Claude response back to OpenAI completions format.
  if (upstreamMode === 'anthropic-messages') {
    // Use the model name from the (already alias-rewritten) request body, falling back to modelId.
    // modelId carries the original alias name; parsedBody.model carries the rewritten target name.
    const model = (parsedBody.model as string || modelId || 'unknown');
    const claudeBody = await completionsToClaudeBody(parsedBody, model);
    logger.debug(requestId, `${path} converted to anthropic-messages body`);
    logPipelineStage(logger, requestId, 'upstream-request', targetUrl, claudeBody);

    const anthropicHeaders: Record<string, string> = { ...authHeaders };
    if (anthropicHeaders['Authorization'] && !anthropicHeaders['x-api-key']) {
      anthropicHeaders['x-api-key'] = anthropicHeaders['Authorization'].replace(/^Bearer\s+/i, '');
      delete anthropicHeaders['Authorization'];
    }

    const anthropicFetchHeaders = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...addForwardedHeaders(anthropicHeaders, request),
    };
    logPipelineHeaders(logger, requestId, 'upstream-request', targetUrl, anthropicFetchHeaders);
    let upstreamResponse = await fetch(targetUrl, {
      method: 'POST',
      headers: anthropicFetchHeaders,
      body: JSON.stringify(claudeBody),
      signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env as Record<string, unknown>)),
    });

    if (route) {
      upstreamResponse = await applyAfterUpstream(upstreamResponse, {
        hook: 'after_upstream', route, upstreamMode: 'anthropic-messages',
        clientModel: model, requestId, streaming: isStreaming, logger,
      });
    }

    logPipelineHeaders(logger, requestId, 'upstream-response', targetUrl, upstreamResponse.headers);
    recordResponseStatusCodeFromUpstream(upstreamResponse.status);
    recordUpstreamRateLimit(model, (name) => upstreamResponse.headers.get(name), targetUrl);
    logger.debug(requestId, `${path} resp: status=${upstreamResponse.status} stream=${isStreaming}`);

    if (!upstreamResponse.ok) {
      const errText = await upstreamResponse.text();
      return new Response(errText, {
        status: upstreamResponse.status,
        headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
      });
    }

    if (isStreaming) {
      // Convert Claude SSE → OpenAI SSE on the fly
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      // Per OpenAI spec, streaming usage is only emitted when the client asks
      // for it via stream_options.include_usage, as a final chunk with an
      // empty choices array just before [DONE].
      const includeUsage = ((parsedBody.stream_options as Record<string, unknown> | undefined)?.include_usage === true);
      let usagePromptTokens: number | undefined;
      let usageCompletionTokens: number | undefined;
      (async () => {
        try {
          const reader = upstreamResponse.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const rawChunk = decoder.decode(value, { stream: true });
            logPipelineStage(logger, requestId, 'upstream-response', upstreamResponse.url || targetUrl, rawChunk);
            buffer += rawChunk;
            const events = buffer.split('\n\n');
            buffer = events.pop() || '';
            for (const event of events) {
              if (!event.trim()) continue;
              const dataLine = event.split('\n').find(l => l.startsWith('data: '));
              if (!dataLine) continue;
              const data = dataLine.slice(6).trim();
              if (!data) continue;
              try {
                const parsed = JSON.parse(data) as Record<string, unknown>;
                // Claude SSE types we care about
                if (parsed.type === 'content_block_delta') {
                  const delta = parsed.delta as Record<string, unknown> | undefined;
                  if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                    const chunk = { id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant', content: delta.text }, finish_reason: null }] };
                    logPipelineStage(logger, requestId, 'outbound', path, chunk);
                    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  } else if (delta?.type === 'input_json_delta') {
                    // tool call argument streaming — emit as function arguments delta
                    const chunk = { id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: delta.partial_json ?? '' } }] }, finish_reason: null }] };
                    logPipelineStage(logger, requestId, 'outbound', path, chunk);
                    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  }
                } else if (parsed.type === 'content_block_start') {
                  const block = parsed.content_block as Record<string, unknown> | undefined;
                  if (block?.type === 'tool_use') {
                    const chunk = { id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: parsed.index ?? 0, id: block.id, type: 'function', function: { name: block.name, arguments: '' } }] }, finish_reason: null }] };
                    logPipelineStage(logger, requestId, 'outbound', path, chunk);
                    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  }
                } else if (parsed.type === 'message_start') {
                  const usage = (parsed.message as Record<string, unknown> | undefined)?.usage as Record<string, unknown> | undefined;
                  if (typeof usage?.input_tokens === 'number') usagePromptTokens = usage.input_tokens;
                } else if (parsed.type === 'message_delta') {
                  const delta = parsed.delta as Record<string, unknown> | undefined;
                  const usage = parsed.usage as Record<string, unknown> | undefined;
                  // Some upstreams (e.g. GLM anthropic endpoint) report input_tokens: 0
                  // in message_start and the real cumulative counts only in message_delta.
                  if (typeof usage?.input_tokens === 'number' && usage.input_tokens > 0) usagePromptTokens = usage.input_tokens;
                  if (typeof usage?.output_tokens === 'number') usageCompletionTokens = usage.output_tokens;
                  const finishReason = delta?.stop_reason === 'tool_use' ? 'tool_calls' : delta?.stop_reason === 'max_tokens' ? 'length' : 'stop';
                  const chunk = { id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] };
                  logPipelineStage(logger, requestId, 'outbound', path, chunk);
                  await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                } else if (parsed.type === 'message_stop') {
                  if (includeUsage && usagePromptTokens !== undefined && usageCompletionTokens !== undefined) {
                    const usageChunk = { id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage: { prompt_tokens: usagePromptTokens, completion_tokens: usageCompletionTokens, total_tokens: usagePromptTokens + usageCompletionTokens } };
                    logPipelineStage(logger, requestId, 'outbound', path, usageChunk);
                    await writer.write(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
                  }
                  await writer.write(encoder.encode('data: [DONE]\n\n'));
                }
              } catch { /* skip unparseable events */ }
            }
          }
          await writer.close();
        } catch (e) {
          logger.error(requestId, `${path} anthropic-messages streaming error: ${(e as Error).message}`);
          await writer.abort();
        }
      })();
      const streamingOutHeaders = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'x-request-id': requestId };
      logPipelineHeaders(logger, requestId, 'outbound', path, streamingOutHeaders);
      return new Response(readable, { headers: streamingOutHeaders });
    }

    // Non-streaming: convert Claude JSON → OpenAI completions JSON
    const claudeJsonText = await upstreamResponse.text();
    logPipelineStage(logger, requestId, 'upstream-response', upstreamResponse.url || targetUrl, claudeJsonText);
    const claudeJson = JSON.parse(claudeJsonText) as Record<string, unknown>;
    const completions = claudeJsonToSyntheticCompletions(claudeJson, model);
    logPipelineStage(logger, requestId, 'outbound', path, completions);
    const nonStreamOutHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
    logPipelineHeaders(logger, requestId, 'outbound', path, nonStreamOutHeaders);
    return new Response(JSON.stringify(completions), { status: 200, headers: nonStreamOutHeaders });
  }

  // When the upstream is openai-responses, convert the completions body to Responses API format
  if (upstreamMode === 'openai-responses') {
    const model = (modelId || parsedBody.model as string || 'unknown');
    let responsesBody: Record<string, unknown> = completionsToResponsesBody(parsedBody, model);
    logger.debug(requestId, `${path} converted to openai-responses body`);

    // before_upstream on the converted responses body (handles max_tokens rename etc.)
    if (route) {
      const hookCtxResp: HookContext = {
        hook: 'before_upstream',
        route,
        upstreamMode: 'openai-responses',
        clientModel: (parsedBody.model as string) || modelId || 'unknown',
        requestId,
        streaming: isStreaming,
        logger,
      };
      ({ body: responsesBody, headers: authHeaders } = runHook('before_upstream', { body: responsesBody, headers: authHeaders }, hookCtxResp));
    }
    logPipelineStage(logger, requestId, 'upstream-request', targetUrl, responsesBody);
    const responsesFetchHeaders = { 'Content-Type': 'application/json', ...addForwardedHeaders(normalizeOpenAIAuthHeaders(authHeaders, targetUrl), request) };
    logPipelineHeaders(logger, requestId, 'upstream-request', targetUrl, responsesFetchHeaders);
    let responsesUpstreamResponse = await fetch(targetUrl, {
      method: 'POST',
      headers: responsesFetchHeaders,
      body: JSON.stringify(responsesBody),
      signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env as Record<string, unknown>)),
    });

    if (route) {
      responsesUpstreamResponse = await applyAfterUpstream(responsesUpstreamResponse, {
        hook: 'after_upstream', route, upstreamMode: 'openai-responses',
        clientModel: (parsedBody.model as string) || modelId || 'unknown',
        requestId, streaming: isStreaming, logger,
      });
    }

    logPipelineHeaders(logger, requestId, 'upstream-response', targetUrl, responsesUpstreamResponse.headers);
    recordResponseStatusCodeFromUpstream(responsesUpstreamResponse.status);
    recordUpstreamRateLimit(model, (name) => responsesUpstreamResponse.headers.get(name), targetUrl);
    logger.debug(requestId, `${path} resp: status=${responsesUpstreamResponse.status} stream=${isStreaming}`);

    const responseHeaders = new Headers(responsesUpstreamResponse.headers);
    responseHeaders.set('x-request-id', requestId);

    // Pure passthrough of the (already converted) upstream response. Tee the
    // body so the client stream is undisturbed while we log the upstream bytes.
    if (responsesUpstreamResponse.body) {
      const [clientStream, logStream] = responsesUpstreamResponse.body.tee();
      (async () => {
        try {
          const reader = logStream.getReader();
          const decoder = new TextDecoder();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            logPipelineStage(logger, requestId, 'upstream-response', responsesUpstreamResponse.url || targetUrl, decoder.decode(value, { stream: true }));
          }
        } catch {
          // best-effort debug logging only
        }
      })();
      logPipelineHeaders(logger, requestId, 'outbound', path, responseHeaders);
      return new Response(clientStream, {
        status: responsesUpstreamResponse.status,
        statusText: responsesUpstreamResponse.statusText,
        headers: responseHeaders,
      });
    }

    logPipelineHeaders(logger, requestId, 'outbound', path, responseHeaders);
    return new Response(responsesUpstreamResponse.body, {
      status: responsesUpstreamResponse.status,
      statusText: responsesUpstreamResponse.statusText,
      headers: responseHeaders,
    });
  }

  // When the upstream is gemini-generatecontent, convert the OpenAI completions
  // body to a Gemini generateContent body, forward it, then convert the native
  // Gemini response back to OpenAI completions JSON. Non-streaming only in
  // Phase 2; streaming lands in Phase 3.
  if (upstreamMode === 'gemini-generatecontent') {
    const model = (parsedBody.model as string || modelId || 'unknown');

    const geminiBody = await convertCompletionsToGeminiGenerateContentBody(parsedBody, model);
    logger.debug(requestId, `${path} converted to gemini-generatecontent body`);

    const geminiHeaders: Record<string, string> = { ...authHeaders };
    // Gemini native API uses x-goog-api-key. If the request came in with
    // Authorization: Bearer, repack the key into x-goog-api-key.
    if (geminiHeaders['Authorization'] && !geminiHeaders['x-goog-api-key']) {
      geminiHeaders['x-goog-api-key'] = geminiHeaders['Authorization'].replace(/^Bearer\s+/i, '');
      delete geminiHeaders['Authorization'];
    }

    // For streaming, switch :generateContent -> :streamGenerateContent?alt=sse
    // (matches src/handlers/gemini.ts constructGeminiUrl convention).
    let geminiTargetUrl = targetUrl;
    if (isStreaming) {
      geminiTargetUrl = targetUrl.replace(/:generateContent(\?|$)/, ':streamGenerateContent$1');
      if (!geminiTargetUrl.includes(':streamGenerateContent')) {
        // Fallback: target didn't end in :generateContent — append the action.
        geminiTargetUrl = `${targetUrl.replace(/:generateContent$/, '')}:streamGenerateContent`;
      }
      if (!geminiTargetUrl.includes('alt=sse')) {
        geminiTargetUrl += (geminiTargetUrl.includes('?') ? '&' : '?') + 'alt=sse';
      }
    }

    logPipelineStage(logger, requestId, 'upstream-request', geminiTargetUrl, geminiBody);
    const geminiFetchHeaders = {
      'Content-Type': 'application/json',
      ...addForwardedHeaders(geminiHeaders, request),
    };
    logPipelineHeaders(logger, requestId, 'upstream-request', geminiTargetUrl, geminiFetchHeaders);
    let geminiUpstreamResponse = await fetch(geminiTargetUrl, {
      method: 'POST',
      headers: geminiFetchHeaders,
      body: JSON.stringify(geminiBody),
      signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env as Record<string, unknown>)),
    });

    if (route) {
      geminiUpstreamResponse = await applyAfterUpstream(geminiUpstreamResponse, {
        hook: 'after_upstream', route, upstreamMode: 'gemini-generatecontent',
        clientModel: model, requestId, streaming: isStreaming, logger,
      });
    }

    logPipelineHeaders(logger, requestId, 'upstream-response', geminiTargetUrl, geminiUpstreamResponse.headers);
    recordResponseStatusCodeFromUpstream(geminiUpstreamResponse.status);
    recordUpstreamRateLimit(model, (name) => geminiUpstreamResponse.headers.get(name), geminiTargetUrl);
    logger.debug(requestId, `${path} resp: status=${geminiUpstreamResponse.status} stream=${isStreaming}`);

    if (!geminiUpstreamResponse.ok) {
      const errText = await geminiUpstreamResponse.text();
      return new Response(errText, {
        status: geminiUpstreamResponse.status,
        headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
      });
    }

    if (isStreaming) {
      // Gemini SSE -> OpenAI chat.completion.chunk SSE. Each Gemini chunk is a
      // complete generateContent-style object with candidates[].content.parts[];
      // we extract the text delta per chunk.
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      (async () => {
        try {
          const reader = geminiUpstreamResponse.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const rawChunk = decoder.decode(value, { stream: true });
            logPipelineStage(logger, requestId, 'upstream-response', geminiUpstreamResponse.url || geminiTargetUrl, rawChunk);
            buffer += rawChunk;
            const events = buffer.split('\n\n');
            buffer = events.pop() || '';
            for (const event of events) {
              if (!event.trim()) continue;
              const dataLine = event.split('\n').find(l => l.startsWith('data: '));
              if (!dataLine) continue;
              const data = dataLine.slice(6).trim();
              if (!data) continue;
              try {
                const parsed = JSON.parse(data) as Record<string, unknown>;
                const candidates = parsed.candidates as Array<Record<string, unknown>> | undefined;
                const parts = (candidates?.[0]?.content as Record<string, unknown> | undefined)?.parts as Array<Record<string, unknown>> | undefined;
                const text = (parts ?? []).filter(p => typeof p.text === 'string' && !(p.thought === true)).map(p => p.text).join('');
                if (text) {
                  const chunk = {
                    id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
                  };
                  logPipelineStage(logger, requestId, 'outbound', path, chunk);
                  await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                const finishReason = candidates?.[0]?.finishReason as string | undefined;
                if (finishReason && finishReason !== 'FINISH_REASON_UNSPECIFIED') {
                  const mapped = finishReason === 'STOP' ? 'stop'
                    : finishReason === 'MAX_TOKENS' ? 'length'
                    : finishReason === 'SAFETY' || finishReason === 'RECITATION' ? 'content_filter'
                    : 'stop';
                  const chunk = {
                    id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: {}, finish_reason: mapped }],
                  };
                  logPipelineStage(logger, requestId, 'outbound', path, chunk);
                  await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
              } catch { /* skip unparseable events */ }
            }
          }
          await writer.write(encoder.encode('data: [DONE]\n\n'));
          await writer.close();
        } catch (e) {
          logger.error(requestId, `${path} gemini-generatecontent streaming error: ${(e as Error).message}`);
          await writer.abort();
        }
      })();
      const streamOutHeaders = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'x-request-id': requestId };
      logPipelineHeaders(logger, requestId, 'outbound', path, streamOutHeaders);
      return new Response(readable, { headers: streamOutHeaders });
    }

    // Native Gemini JSON -> Claude -> OpenAI completions JSON. Reuses the
    // existing chain also used by forwardCompletionsAsAnthropicMessages.
    // Known limitation: convertGeminiGenerateContentToClaude only extracts
    // text parts today; tool/thought response parts are dropped. Tracked
    // as a follow-up.
    const geminiJsonText = await geminiUpstreamResponse.text();
    logPipelineStage(logger, requestId, 'upstream-response', geminiUpstreamResponse.url || geminiTargetUrl, geminiJsonText);
    const geminiJson = JSON.parse(geminiJsonText) as Record<string, unknown>;
    const claudeJson = convertGeminiGenerateContentToClaude(geminiJson, model, requestId) as unknown as Record<string, unknown>;
    const completions = claudeJsonToSyntheticCompletions(claudeJson, model);
    logPipelineStage(logger, requestId, 'outbound', path, completions);
    const geminiOutHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
    logPipelineHeaders(logger, requestId, 'outbound', path, geminiOutHeaders);
    return new Response(JSON.stringify(completions), { status: 200, headers: geminiOutHeaders });
  }

  // Per OpenAI spec, streaming usage is only emitted when stream_options.include_usage
  // is set. Force it on so the SSE usage tracker records tokens even when the
  // client didn't ask for them (the extra final usage chunk is spec-compliant
  // and forwarded to the client as part of the passthrough stream).
  if (isStreaming) {
    parsedBody.stream_options = { ...(parsedBody.stream_options as Record<string, unknown> | undefined), include_usage: true };
  }

  logPipelineStage(logger, requestId, 'upstream-request', targetUrl, parsedBody);
  const defaultFetchHeaders = { 'Content-Type': 'application/json', ...addForwardedHeaders(authHeaders, request) };
  logPipelineHeaders(logger, requestId, 'upstream-request', targetUrl, defaultFetchHeaders);
  let upstreamResponse = await fetch(targetUrl, {
    method: 'POST',
    headers: defaultFetchHeaders,
    body: JSON.stringify(parsedBody),
    signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env as Record<string, unknown>)),
  });

  if (route) {
    upstreamResponse = await applyAfterUpstream(upstreamResponse, {
      hook: 'after_upstream', route, upstreamMode: 'openai-completions',
      clientModel: (parsedBody.model as string) || modelId || 'unknown',
      requestId, streaming: isStreaming, logger,
    });
  }

  logPipelineHeaders(logger, requestId, 'upstream-response', targetUrl, upstreamResponse.headers);
  recordResponseStatusCodeFromUpstream(upstreamResponse.status);
  recordUpstreamRateLimit((parsedBody.model as string) || modelId, (name) => upstreamResponse.headers.get(name), targetUrl);
  logger.debug(requestId, `${path} resp: status=${upstreamResponse.status} stream=${isStreaming}`);

  // Forward the response body as-is. Pure passthrough: outbound body to the
  // client equals the raw upstream-response body. Tee to log without
  // disturbing the client stream.
  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set('x-request-id', requestId);

  if (upstreamResponse.body) {
    const [clientStream, logStream] = upstreamResponse.body.tee();
    (async () => {
      try {
        const reader = logStream.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          logPipelineStage(logger, requestId, 'upstream-response', upstreamResponse.url || targetUrl, decoder.decode(value, { stream: true }));
        }
      } catch {
        // best-effort debug logging only
      }
    })();
    logPipelineHeaders(logger, requestId, 'outbound', path, responseHeaders);
    return new Response(clientStream, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: responseHeaders,
    });
  }

  logPipelineHeaders(logger, requestId, 'outbound', path, responseHeaders);
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}
