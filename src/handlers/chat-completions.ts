/**
 * Passthrough handler for /v1/chat/completions.
 * Forwards the request as-is to the upstream OpenAI-compatible endpoint.
 * No format conversion is performed.
 */

import type { Env, Logger } from '../types/shared.js';
import { logPipelineStage, logPipelineHeaders, observeStream } from '../utils/logger.js';
import { addForwardedHeaders } from '../utils/routing.js';
import { repackBearerCredential, normalizeOpenAIAuthHeaders, ensureStructuredOutputsBetaHeader } from '../utils/auth-headers.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { recordResponseStatusCodeFromUpstream } from '../utils/dashboard-stats.js';
import { recordUpstreamRateLimit } from '../utils/provider-quota.js';
import { validateOpenAICompletionsRequest } from '../utils/validation.js';
import { ValidationError } from '../utils/errors.js';
import { claudeJsonToSyntheticCompletions } from './openai.js';
import { completionsToClaudeBody } from '../converters/completions-to-claude.js';
import { completionsToResponsesBody } from '../converters/completions-to-responses.js';
import {
  convertResponsesToChatCompletionsAnswer,
  createResponsesChatStreamState,
  responsesStreamEventToChatChunks,
} from '../converters/responses-to-completions.js';
import { convertCompletionsToGeminiGenerateContentBody } from '../converters/claude-to-gemini.js';
import { convertGeminiGenerateContentToClaude } from '../converters/gemini-to-claude.js';
import { runHook, applyAfterUpstream, type HookContext } from '../utils/request-transform.js';
import type { ModelRouteConfig } from '../utils/config-loader.js';
import { collectBlobRefs } from '../utils/blob-refs.js';
import { createRefAwareJsonBody } from '../utils/ref-serializer.js';
import { postJsonWithSpool } from '../utils/spool-json.js';
import { getSpoolConfig } from '../utils/spool.js';
import { receiveJsonResponse, receiveResponseBody, withResponseText } from '../utils/spool-response.js';
import { admitResponseMaterialization, type AdmissionLease } from '../utils/spool-admission.js';


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

  // §5.3 egress shape, decided once here and used at the send sites below.
  // Converters that preserve a ref let the shared POST path stream it; a
  // converter that intentionally drops or re-encodes a payload leaves no ref
  // behind and takes the ordinary string/attempt-spool path.
  const streamRefs = getSpoolConfig().enabled && collectBlobRefs(parsedBody).length > 0;

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
    ensureStructuredOutputsBetaHeader(anthropicHeaders, claudeBody);
    repackBearerCredential(anthropicHeaders, 'x-api-key');

    const anthropicFetchHeaders = {
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01',
      ...addForwardedHeaders(anthropicHeaders, request),
    };
    logPipelineHeaders(logger, requestId, 'upstream-request', targetUrl, anthropicFetchHeaders);
    let upstreamResponse = await postJsonWithSpool(targetUrl, claudeBody, {
      headers: anthropicFetchHeaders,
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
      // §5.7: the error body goes through the same bounded receive as a success
      // body, on the identity consumer — this branch relays the upstream's own
      // error bytes, it never converts them. A cap breach, a spill write failure
      // or a §5.9 refusal therefore propagates as itself instead of being served
      // to the client as the upstream's answer (rule #8).
      const errText = await withResponseText(upstreamResponse, requestId, logger, targetUrl, (text) => text, request.signal);
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
      // OpenAI's stream identifies the speaker once, in an opening chunk whose
      // delta is `{role, content: ''}`, and every later chunk carries only what
      // changed. Emitted lazily before the first data chunk of any kind — text,
      // tool_use or arguments — so a tool-call-only answer, which used to carry no
      // role at all, is covered too. A stream with no data chunks sends none.
      let roleSent = false;
      const writeRoleChunk = async () => {
        if (roleSent) return;
        roleSent = true;
        const roleChunk = { id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] };
        logPipelineStage(logger, requestId, 'outbound', path, roleChunk);
        await writer.write(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));
      };
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
                    await writeRoleChunk();
                    const chunk = { id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }] };
                    logPipelineStage(logger, requestId, 'outbound', path, chunk);
                    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  } else if (delta?.type === 'input_json_delta') {
                    // tool call argument streaming — emit as function arguments delta
                    await writeRoleChunk();
                    const chunk = { id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: delta.partial_json ?? '' } }] }, finish_reason: null }] };
                    logPipelineStage(logger, requestId, 'outbound', path, chunk);
                    await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                  }
                } else if (parsed.type === 'content_block_start') {
                  const block = parsed.content_block as Record<string, unknown> | undefined;
                  if (block?.type === 'tool_use') {
                    await writeRoleChunk();
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

    // Non-streaming: convert Claude JSON → OpenAI completions JSON.
    // §5.7: received with bounded memory and `max_response_bytes` enforced, then
    // parsed once — the conversion needs the value, so the spill is released
    // before this returns. No payload extraction: a Claude body's image blocks
    // are not on §5.7's response allowlist (only Gemini `inline_data` and
    // Responses `image_generation_call` are).
    const claudeJson = await receiveJsonResponse<Record<string, unknown>>(
      upstreamResponse, requestId, logger, upstreamResponse.url || targetUrl, request.signal,
    );
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
    let responsesUpstreamResponse = await postJsonWithSpool(targetUrl, responsesBody, {
      headers: responsesFetchHeaders,
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

    // An error answer is not a Responses object to convert — it is relayed as
    // bytes under the upstream's own status. §5.7: the body is received with
    // bounded memory — `max_response_bytes` enforced, the upstream cancelled on
    // breach — and forwarded from that spool unparsed. Identity forwarding never
    // parses: the trace line reads the same spool rather than teeing a second
    // reader that would pull the body through beside the client's.
    if (!responsesUpstreamResponse.ok) {
      const received = await receiveResponseBody(responsesUpstreamResponse.body);
      if (logger.traceEnabled) {
        // §5.9: the trace line is this shape's only materialization, so it is
        // the only thing charged, and the lease is given back as soon as it is read.
        let lease: AdmissionLease;
        try {
          lease = await admitResponseMaterialization(received.size, request.signal);
        } catch (error) {
          await received.release();
          throw error;
        }
        try {
          logPipelineStage(logger, requestId, 'upstream-response', responsesUpstreamResponse.url || targetUrl, await received.readText());
        } finally {
          lease.release();
        }
      }
      logPipelineHeaders(logger, requestId, 'outbound', path, responseHeaders);
      return new Response(received.readStream(), {
        status: responsesUpstreamResponse.status,
        statusText: responsesUpstreamResponse.statusText,
        headers: responseHeaders,
      });
    }

    if (isStreaming) {
      // The upstream answers a streamed Responses request in Responses SSE
      // events; the client asked for `chat.completion.chunk` frames. Each event
      // is mapped by the converter and re-framed here, following the two
      // converted branches above.
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      // Per OpenAI spec, streaming usage is only emitted when the client asks
      // for it via stream_options.include_usage, as a final chunk with an empty
      // choices array just before [DONE]. The Responses stream always reports
      // usage on its terminal event, so the source is there when it is wanted.
      const includeUsage = ((parsedBody.stream_options as Record<string, unknown> | undefined)?.include_usage === true);
      (async () => {
        try {
          const state = createResponsesChatStreamState(model);
          const reader = responsesUpstreamResponse.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const rawChunk = decoder.decode(value, { stream: true });
            logPipelineStage(logger, requestId, 'upstream-response', responsesUpstreamResponse.url || targetUrl, rawChunk);
            buffer += rawChunk;
            const events = buffer.split('\n\n');
            buffer = events.pop() || '';
            for (const event of events) {
              if (!event.trim()) continue;
              const dataLine = event.split('\n').find(l => l.startsWith('data: '));
              if (!dataLine) continue;
              const data = dataLine.slice(6).trim();
              if (!data || data === '[DONE]') continue;
              let parsed: Record<string, unknown>;
              try {
                parsed = JSON.parse(data) as Record<string, unknown>;
              } catch {
                // An unparseable frame is a broken stream, not a frame to skip:
                // silently dropping it would truncate the answer the client sees
                // while the upstream believes it delivered everything.
                throw new Error(`Invalid JSON in Responses SSE data (request ${requestId})`);
              }
              if (parsed.type === 'response.failed') {
                throw new Error(`Responses stream failed (request ${requestId})`);
              }
              for (const chunk of responsesStreamEventToChatChunks(state, parsed)) {
                logPipelineStage(logger, requestId, 'outbound', path, chunk);
                await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
              }
              if (state.finished) break;
            }
            if (state.finished) break;
          }
          // A stream that stops before the terminal event leaves the client with
          // a truncated answer and no finish_reason. `handleResponsesStreamAsClaude`
          // refuses the same way.
          if (!state.finished) {
            throw new Error(`Responses stream ended before response.completed (request ${requestId})`);
          }
          warnDroppedOutputItems(logger, requestId, path, state.dropped);
          if (includeUsage && state.usage) {
            const usageChunk = {
              id: state.id, object: 'chat.completion.chunk', created: state.created, model: state.model,
              choices: [], usage: state.usage,
            };
            logPipelineStage(logger, requestId, 'outbound', path, usageChunk);
            await writer.write(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
          }
          await writer.write(encoder.encode('data: [DONE]\n\n'));
          await writer.close();
        } catch (e) {
          logger.error(requestId, `${path} openai-responses streaming error: ${(e as Error).message}`);
          await writer.abort();
        }
      })();
      const responsesStreamOutHeaders = { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'x-request-id': requestId };
      logPipelineHeaders(logger, requestId, 'outbound', path, responsesStreamOutHeaders);
      return new Response(readable, { headers: responsesStreamOutHeaders });
    }

    // Non-streaming: convert the Responses answer into a `chat.completion`
    // object. §5.7: received with bounded memory and `max_response_bytes`
    // enforced, then parsed once — the conversion needs the value, so the spill
    // is released before this returns. No payload extraction: a Responses
    // `image_generation_call` result has no Chat Completions position, so it is
    // dropped and reported rather than kept for nobody (see the converter).
    const responsesJson = await receiveJsonResponse<Record<string, unknown>>(
      responsesUpstreamResponse, requestId, logger, responsesUpstreamResponse.url || targetUrl, request.signal,
    );
    const answer = convertResponsesToChatCompletionsAnswer(responsesJson, model);
    warnDroppedOutputItems(logger, requestId, path, answer.dropped);
    logPipelineStage(logger, requestId, 'outbound', path, answer.completions);
    const responsesOutHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
    logPipelineHeaders(logger, requestId, 'outbound', path, responsesOutHeaders);
    return new Response(JSON.stringify(answer.completions), { status: 200, headers: responsesOutHeaders });
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
    repackBearerCredential(geminiHeaders, 'x-goog-api-key');

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
    let geminiUpstreamResponse = await postJsonWithSpool(geminiTargetUrl, geminiBody, {
      headers: geminiFetchHeaders,
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
      // §5.7: bounded on the same identity consumer as the anthropic branch above.
      const errText = await withResponseText(geminiUpstreamResponse, requestId, logger, geminiTargetUrl, (text) => text, request.signal);
      return new Response(errText, {
        status: geminiUpstreamResponse.status,
        headers: { 'Content-Type': 'application/json', 'x-request-id': requestId },
      });
    }

    if (isStreaming) {
      // Gemini SSE -> OpenAI chat.completion.chunk SSE. Each Gemini chunk is a
      // complete generateContent-style object with candidates[].content.parts[];
      // we extract the text delta and any complete functionCall per chunk.
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      // Same gate and chunk shape as the anthropic-messages branch above: usage
      // only when the client asks via stream_options.include_usage, emitted as
      // an empty-choices chunk just before [DONE].
      const includeUsage = ((parsedBody.stream_options as Record<string, unknown> | undefined)?.include_usage === true);
      // Same opening role chunk as the anthropic-messages branch above, so a
      // client sees one chunk shape whichever upstream mode answered.
      let roleSent = false;
      const writeRoleChunk = async () => {
        if (roleSent) return;
        roleSent = true;
        const roleChunk = { id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] };
        logPipelineStage(logger, requestId, 'outbound', path, roleChunk);
        await writer.write(encoder.encode(`data: ${JSON.stringify(roleChunk)}\n\n`));
      };
      let usagePromptTokens: number | undefined;
      let usageCompletionTokens: number | undefined;
      (async () => {
        try {
          const reader = geminiUpstreamResponse.body!.getReader();
          const decoder = new TextDecoder();
          let buffer = '';
          // Gemini streams a functionCall whole, never split across chunks, so
          // each one becomes a complete OpenAI tool_calls delta whose index
          // counts the calls emitted so far.
          let toolCallIndex = 0;
          let sawToolCall = false;
          // Rule #8: a part this mapper cannot project is reported once per kind
          // per response, instead of leaving a shorter answer with no trace.
          const droppedKindsWarned = new Set<string>();
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
                const usageMetadata = parsed.usageMetadata as Record<string, unknown> | undefined;
                if (usageMetadata) {
                  if (typeof usageMetadata.promptTokenCount === 'number') usagePromptTokens = usageMetadata.promptTokenCount;
                  if (typeof usageMetadata.candidatesTokenCount === 'number') usageCompletionTokens = usageMetadata.candidatesTokenCount;
                }
                const text = (parts ?? []).filter(p => typeof p.text === 'string' && !(p.thought === true)).map(p => p.text).join('');
                if (text) {
                  await writeRoleChunk();
                  const chunk = {
                    id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
                  };
                  logPipelineStage(logger, requestId, 'outbound', path, chunk);
                  await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                for (const part of parts ?? []) {
                  const functionCall = part.functionCall as Record<string, unknown> | undefined;
                  if (!functionCall) continue;
                  sawToolCall = true;
                  const index = toolCallIndex++;
                  await writeRoleChunk();
                  const chunk = {
                    id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000), model,
                    choices: [{
                      index: 0,
                      delta: {
                        tool_calls: [{
                          index,
                          // Carry the upstream's own call id when it has one, so a
                          // client echoing it back keeps working either way; mint
                          // one in the shape the non-streaming converter uses when
                          // the upstream omitted it (`FunctionCall.id` is optional).
                          id: typeof functionCall.id === 'string' && functionCall.id !== ''
                            ? functionCall.id
                            : `tool_${Date.now()}_${index}`,
                          type: 'function',
                          function: { name: functionCall.name, arguments: JSON.stringify(functionCall.args ?? {}) },
                        }],
                      },
                      finish_reason: null,
                    }],
                  };
                  logPipelineStage(logger, requestId, 'outbound', path, chunk);
                  await writer.write(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                const finishReason = candidates?.[0]?.finishReason as string | undefined;
                for (const part of parts ?? []) {
                  if (part.functionCall) continue;
                  // `thought` parts carry `text` too but are filtered out of the
                  // answer above, so they are exactly a kind this mapper drops.
                  if (typeof part.text === 'string' && part.thought !== true) continue;
                  const kind = part.thought === true ? 'thought'
                    : part.inline_data || part.inlineData ? 'inline_data'
                    : part.functionResponse ? 'functionResponse'
                    : Object.keys(part).join('+') || '<empty>';
                  if (droppedKindsWarned.has(kind)) continue;
                  droppedKindsWarned.add(kind);
                  logger.warn(requestId, `${path} gemini-generatecontent stream: dropped ${kind} reply part(s) with no OpenAI chat.completion.chunk projection`);
                }
                if (finishReason && finishReason !== 'FINISH_REASON_UNSPECIFIED') {
                  // Gemini reports a tool call as finishReason STOP; the call
                  // itself is what makes this turn a tool turn.
                  let mapped: string;
                  if (sawToolCall) mapped = 'tool_calls';
                  else if (finishReason === 'STOP') mapped = 'stop';
                  else if (finishReason === 'MAX_TOKENS') mapped = 'length';
                  else if (finishReason === 'SAFETY' || finishReason === 'RECITATION') mapped = 'content_filter';
                  else {
                    // Rule #8: report the raw value rather than let it read as a clean stop.
                    logger.warn(requestId, `${path} gemini-generatecontent stream: unmapped finishReason ${JSON.stringify(finishReason)}, reported as "stop"`);
                    mapped = 'stop';
                  }
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
          if (includeUsage && usagePromptTokens !== undefined && usageCompletionTokens !== undefined) {
            const usageChunk = { id: `chatcmpl_${Date.now()}`, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [], usage: { prompt_tokens: usagePromptTokens, completion_tokens: usageCompletionTokens, total_tokens: usagePromptTokens + usageCompletionTokens } };
            logPipelineStage(logger, requestId, 'outbound', path, usageChunk);
            await writer.write(encoder.encode(`data: ${JSON.stringify(usageChunk)}\n\n`));
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
    // as a follow-up. §5.7: bounded receive as above, and no payload extraction
    // for the same reason the limitation gives — the converter drops
    // `inline_data` parts before any converted value exists to extract from.
    const geminiJson = await receiveJsonResponse<Record<string, unknown>>(
      geminiUpstreamResponse, requestId, logger, geminiUpstreamResponse.url || geminiTargetUrl, request.signal,
    );
    const claudeJson = convertGeminiGenerateContentToClaude(geminiJson, model, requestId, { logger }) as unknown as Record<string, unknown>;
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
  // §5.3 shape 3, the graduate path: a body that still carries refs is sent as
  // a stream — the skeleton plus one blob chunk at a time, read from L2 as the
  // upstream pulls — instead of as one expanded string. The exact
  // `Content-Length` the serializer measured comes with it (fetch cannot infer a
  // length for a streamed body, and a stale length is worse than none), plus
  // `duplex: 'half'`, this repo's streamed-egress convention
  // (src/handlers/passthrough.ts:271 — that call needs the `as RequestInit` cast
  // only because its `duplex` is a plain key; a conditional spread skips the
  // excess-property check). A ref-free body — and every request on a deployment
  // with spooling off — sends the expanded string exactly as before.
  const streamed = streamRefs ? createRefAwareJsonBody(parsedBody) : undefined;
  const defaultFetchHeaders = {
    'Content-Type': 'application/json',
    ...addForwardedHeaders(authHeaders, request),
    ...(streamed ? { 'Content-Length': String(streamed.contentLength) } : {}),
  };
  logPipelineHeaders(logger, requestId, 'upstream-request', targetUrl, defaultFetchHeaders);
  let upstreamResponse = await fetch(targetUrl, {
    method: 'POST',
    headers: defaultFetchHeaders,
    body: streamed ? streamed.body : JSON.stringify(parsedBody),
    ...(streamed ? { duplex: 'half' } : {}),
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
  // client equals the raw upstream-response body. §5.7: log the upstream bytes
  // by observing the client's own path, not by teeing a second reader.
  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set('x-request-id', requestId);

  if (upstreamResponse.body) {
    logPipelineHeaders(logger, requestId, 'outbound', path, responseHeaders);
    return new Response(
      upstreamResponse.body.pipeThrough(
        observeStream(logger, requestId, 'upstream-response', upstreamResponse.url || targetUrl, 'chunks'),
      ),
      {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText,
        headers: responseHeaders,
      }
    );
  }

  logPipelineHeaders(logger, requestId, 'outbound', path, responseHeaders);
  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers: responseHeaders,
  });
}

/**
 * Report Responses output items the conversion had no Chat Completions position
 * for. Called on both the JSON and the SSE egress; a silent drop is forbidden
 * (rule #8) — an `image_generation_call` result or a `web_search_call` vanishes
 * from the client's answer, and the log is the only place that can say so.
 */
function warnDroppedOutputItems(
  logger: Logger,
  requestId: string,
  path: string,
  dropped: Record<string, number>,
): void {
  for (const [type, count] of Object.entries(dropped)) {
    logger.warn(requestId, `${path} openai-responses → chat.completion: dropped ${count} output item(s) of type '${type}' (no Chat Completions representation)`);
  }
}
