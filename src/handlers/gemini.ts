/**
 * Gemini API handler for Claude Proxy v3
 *
 * Handles interactions with Gemini Generative Language API
 * Supports both standard Claude API format and Gemini Interactions API
 */

import { Env } from '../types/shared.js';
import { Logger, createLogger, logPipelineStage, logPipelineHeaders, observeStream } from '../utils/logger.js';
import { ClaudeMessagesRequest, ClaudeMessagesResponse } from '../types/claude.js';
import { GeminiInteractionRequest, GeminiInteractionResponse } from '../types/gemini.js';
import { convertClaudeToGeminiRequest } from '../converters/claude-to-gemini.js';
import { convertInteractionsToGenerateContent } from '../converters/interactions-to-gemini.js';
import { convertGenerateContentToInteraction } from '../converters/gemini-to-interactions.js';
import { convertGeminiGenerateContentToClaude } from '../converters/gemini-to-claude.js';
import { createGeminiStreamTransformer, createNativeGeminiStreamTransformer, createInteractionsStreamTransformer } from '../converters/gemini-streaming.js';
import { ClaudeProxyError, handleTargetApiError } from '../utils/errors.js';
import { addForwardedHeaders } from '../utils/routing.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { recordResponseStatusCodeFromUpstream } from '../utils/dashboard-stats.js';
import { recordUpstreamRateLimit } from '../utils/provider-quota.js';
import { runHook, applyAfterUpstream, type HookContext } from '../utils/request-transform.js';
import type { ModelRouteConfig } from '../utils/config-loader.js';
import { postJsonWithSpool } from '../utils/spool-json.js';
import { createConvertedResponseBody, receiveJsonResponse, receiveResponseBody, withResponseText, type ConvertedResponseBody } from '../utils/spool-response.js';
import { admitResponseMaterialization, type AdmissionLease } from '../utils/spool-admission.js';

/**
 * Check if request is in native Gemini format
 */
function isNativeGeminiRequest(body: Record<string, unknown>): boolean {
    // Native Gemini requests have 'input' or 'contents' field, Claude requests have 'messages'
    return ('input' in body || 'contents' in body) && !('messages' in body);
}

/**
 * Handle Gemini API request for /v1/messages endpoint (returns Claude format)
 */
export async function handleGeminiRequestForMessages(
    request: Request,
    targetUrl: string,
    authHeaders: Record<string, string>,
    requestId: string,
    modelId?: string,
    env?: Env,
    logger?: Logger,
    route?: ModelRouteConfig,
): Promise<Response> {
    const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);
    activeLogger.debug(requestId, 'Routing to Gemini generateContent handler for /v1/messages (Claude format output)');

    // Always use generateContent handler but return Claude format
    return handleGeminiGenerateContentRequest(
        request, targetUrl, authHeaders, requestId, modelId, env, logger, 'claude-format', route
    );
}

/**
 * Handle Gemini API request (factory function)
 * Routes to either Interactions or generateContent handler based on URL
 */
export async function handleGeminiRequest(
    request: Request,
    targetUrl: string,
    authHeaders: Record<string, string>,
    requestId: string,
    modelId?: string,
    env?: Env,
    logger?: Logger,
    route?: ModelRouteConfig,
): Promise<Response> {
    const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);

    // Determine which handler to use based on original request path
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/v1/interactions' || path.startsWith('/v1/interactions?')) {
        activeLogger.debug(requestId, 'Routing to Gemini Interactions handler');
        return handleGeminiInteractionsRequest(
            request, targetUrl, authHeaders, requestId, modelId, env, logger, route
        );
    } else if (path.includes(':countTokens')) {
        activeLogger.debug(requestId, 'Routing to Gemini countTokens handler');
        return handleGeminiCountTokensRequest(
            request, targetUrl, authHeaders, requestId, modelId, env, logger, route
        );
    } else {
        activeLogger.debug(requestId, 'Routing to Gemini generateContent handler');
        return handleGeminiGenerateContentRequest(
            request, targetUrl, authHeaders, requestId, modelId, env, logger, 'native-gemini', route
        );
    }
}

/**
 * Handle Gemini :countTokens request — proxy the body to the upstream countTokens endpoint
 * and return the raw JSON response (totalTokens).
 */
async function handleGeminiCountTokensRequest(
    request: Request,
    targetUrl: string,
    authHeaders: Record<string, string>,
    requestId: string,
    modelId?: string,
    env?: Env,
    logger?: Logger,
    route?: ModelRouteConfig
): Promise<Response> {
    const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);
    activeLogger.debug(requestId, `Gemini countTokens request to: ${targetUrl}`);

    let geminiHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...authHeaders,
    };
    geminiHeaders = addForwardedHeaders(geminiHeaders, request);
    logPipelineHeaders(activeLogger, requestId, 'upstream-request', targetUrl, geminiHeaders);

    const response = await fetch(targetUrl, {
        method: 'POST',
        headers: geminiHeaders,
        body: request.body,
        signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
    });

    logPipelineHeaders(activeLogger, requestId, 'upstream-response', targetUrl, response.headers);
    recordResponseStatusCodeFromUpstream(response.status);
    recordUpstreamRateLimit(modelId, (name) => response.headers.get(name), targetUrl);

    if (!response.ok) {
        const errorText = await withResponseText(response, requestId, activeLogger, targetUrl, (text) => text, request.signal);
        activeLogger.error(requestId, `Gemini countTokens error: ${errorText}`);
        handleTargetApiError(response, 'Gemini API', { url: targetUrl, upstreamBody: errorText });
    }

    // §5.7: received with bounded memory — `max_response_bytes` enforced, the
    // upstream body cancelled on breach — and forwarded from that spool unparsed.
    // The body is a `{ totalTokens }` object, so nothing on §5.7's response
    // allowlist can be in it and there is nothing to extract; the client reads the
    // same bytes the upstream sent, from the spool rather than from a second copy.
    const received = await receiveResponseBody(response.body);
    const countTokensOutHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
    logPipelineHeaders(activeLogger, requestId, 'outbound', ':countTokens', countTokensOutHeaders);
    return new Response(received.readStream(), { status: 200, headers: countTokensOutHeaders });
}

/**
 * Handle Gemini Interactions API request
 */
async function handleGeminiInteractionsRequest(
    request: Request,
    targetUrl: string,
    authHeaders: Record<string, string>,
    requestId: string,
    modelId?: string,
    env?: Env,
    logger?: Logger,
    route?: ModelRouteConfig,
): Promise<Response> {
    const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);
    const requestBody = await request.json() as Record<string, unknown>;
    logPipelineStage(activeLogger, requestId, 'inbound', '/v1/interactions', requestBody);
    logPipelineHeaders(activeLogger, requestId, 'inbound', '/v1/interactions', request.headers);

    activeLogger.debug(requestId, `Interactions request to: ${targetUrl}`);

    // Convert Interactions format to generateContent format. The mapping lives in
    // `converters/interactions-to-gemini.ts`; a body this route cannot express is
    // refused there with a 400 rather than sent upstream to be rejected by name.
    const { body: geminiRequest, dropped } = convertInteractionsToGenerateContent(requestBody);
    if (dropped.length > 0) {
        // Rule #8: a field with no generateContent equivalent changes what the
        // client asked for, so the drop is reported rather than inferred from a
        // quietly different answer.
        activeLogger.warn(
            requestId,
            `Interactions request fields with no generateContent equivalent were dropped: ${dropped.join(', ')}`
        );
    }

    // Check for streaming
    let isStreaming = geminiRequest.stream === true;

    activeLogger.debug(requestId, `Converted request: ${JSON.stringify(geminiRequest).substring(0, 200)}...`);
    
    // Prepare headers for Gemini API - authHeaders already contains the correct format
    // from the main router (x-goog-api-key for native Gemini mode)
    let geminiHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...authHeaders,  // Already has correct x-goog-api-key from router
    };

    activeLogger.debug(requestId, `Using auth headers: ${Object.keys(geminiHeaders).join(', ')}`);
    geminiHeaders = addForwardedHeaders(geminiHeaders, request);
    const fullTargetUrl = constructGeminiUrl(targetUrl, request, geminiRequest, modelId || requestBody.model as string | undefined);

    // A target that names the streaming method streams whether or not the client
    // asked to — the same rule the generateContent branch below applies. Without
    // it an SSE body was taken for a JSON one and failed to parse.
    if (fullTargetUrl.includes(':streamGenerateContent')) {
        isStreaming = true;
    }
    activeLogger.debug(requestId, `Is streaming: ${isStreaming}`);

    let upstreamBodyGemini: Record<string, unknown> = geminiRequest;
    if (route) {
        const hookCtx: HookContext = {
            hook: 'before_upstream',
            route,
            upstreamMode: 'gemini',
            clientModel: (requestBody.model as string) || modelId || 'unknown',
            requestId,
            streaming: isStreaming,
            logger: activeLogger,
        };
        ({ body: upstreamBodyGemini, headers: geminiHeaders } = runHook('before_upstream', { body: upstreamBodyGemini, headers: geminiHeaders }, hookCtx));
    }

    logPipelineStage(activeLogger, requestId, 'upstream-request', fullTargetUrl, upstreamBodyGemini);
    logPipelineHeaders(activeLogger, requestId, 'upstream-request', fullTargetUrl, geminiHeaders);
    let response = await postJsonWithSpool(fullTargetUrl, upstreamBodyGemini, {
        headers: geminiHeaders,
        signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
    });

    if (route) {
        response = await applyAfterUpstream(response, {
            hook: 'after_upstream', route, upstreamMode: 'gemini',
            clientModel: (requestBody.model as string) || modelId || 'unknown',
            requestId, streaming: isStreaming, logger: activeLogger,
        });
    }

    logPipelineHeaders(activeLogger, requestId, 'upstream-response', fullTargetUrl, response.headers);
    activeLogger.debug(requestId, `Response status: ${response.status}`);
    recordResponseStatusCodeFromUpstream(response.status);
    recordUpstreamRateLimit((requestBody.model as string) || modelId, (name) => response.headers.get(name), fullTargetUrl);

    if (!response.ok) {
        const errorText = await withResponseText(response, requestId, activeLogger, fullTargetUrl, (text) => text, request.signal);
        activeLogger.error(requestId, `Gemini API error: ${errorText}`);
        const bodyPreview = JSON.stringify(geminiRequest).substring(0, 1000);
        handleTargetApiError(response, 'Gemini API', { url: fullTargetUrl, body: bodyPreview, upstreamBody: errorText });
    }

    // Handle streaming response
    if (isStreaming) {
        return handleGeminiStreamingResponse(response, requestBody.model as string || modelId || 'gemini-no-id-at-proxy', requestId, activeLogger, 'interactions');
    }
    
    // Convert generateContent response to Interactions format.
    // §5.7: the body is received with bounded memory instead of
    // `response.text()` — above `threshold_bytes` it lives on disk — and
    // `max_response_bytes` now caps it: a breach cancels the upstream body and
    // fails explicitly rather than truncating the response.
    const received = await receiveResponseBody(response.body);
    let lease: AdmissionLease;
    try {
        // §5.9 byte admission, opt-in via `max_materialized_body_bytes`: parsing
        // this body is the materialization the budget is for, and waiting for
        // capacity here waits before any of it has been materialized. The charge
        // is the received byte count, never a guess from `Content-Length`. A
        // refusal must leave neither bytes on disk nor a reservation (rule #8).
        lease = await admitResponseMaterialization(received.size, request.signal);
    } catch (error) {
        await received.release();
        throw error;
    }

    let converted: ConvertedResponseBody;
    try {
        const geminiResponseText = await received.readText();
        logPipelineStage(activeLogger, requestId, 'upstream-response', fullTargetUrl, geminiResponseText);

        // The mapping lives in `converters/gemini-to-interactions.ts`: it carries
        // the upstream's `finishReason` into the interaction's `status`/`error`
        // and translates every content kind, rather than relaying the
        // generateContent parts through in their own dialect.
        const { interaction, dropped: droppedParts } = convertGenerateContentToInteraction(
            JSON.parse(geminiResponseText),
            (requestBody.model as string) || modelId || 'gemini-no-id-at-proxy',
            requestId
        );
        if (droppedParts.length > 0) {
            // Rule #8: a content kind with no Interactions projection would
            // otherwise leave a shorter answer with no trace of what went missing.
            activeLogger.warn(
                requestId,
                `Upstream content with no Interactions projection was dropped: ${droppedParts.join(', ')}`
            );
        }

        logPipelineStage(activeLogger, requestId, 'outbound', '/v1/interactions', interaction);
        // §5.7 converted-response egress: the generated image in a non-text part
        // goes to this response's own scratch store and comes back as the client
        // takes the skeleton, so relaying it costs one chunk rather than a second
        // full copy. The parsed body's spill is released below, before the send.
        converted = await createConvertedResponseBody(interaction);
    } finally {
        lease.release();
        await received.release();
    }

    const interactionsOutHeaders: Record<string, string> = { 'Content-Type': 'application/json', 'x-request-id': requestId };
    // A streamed skeleton is not a text body the runtime can measure.
    if (converted.contentLength !== undefined) {
        interactionsOutHeaders['Content-Length'] = String(converted.contentLength);
    }
    logPipelineHeaders(activeLogger, requestId, 'outbound', '/v1/interactions', interactionsOutHeaders);
    return new Response(converted.body, { status: 200, headers: interactionsOutHeaders });
}


/**
 * Handle Gemini generateContent API request
 */
async function handleGeminiGenerateContentRequest(
    request: Request,
    targetUrl: string,
    authHeaders: Record<string, string>,
    requestId: string,
    modelId?: string,
    env?: Env,
    logger?: Logger,
    outputFormat: 'native-gemini' | 'claude-format' = 'native-gemini',
    route?: ModelRouteConfig,
): Promise<Response> {
    const activeLogger = logger ?? createLogger((env ?? {}) as Record<string, unknown>);
    activeLogger.debug(requestId, `[DEBUG] handleGeminiGenerateContentRequest authHeaders: ${JSON.stringify(authHeaders)}`);

    // Parse request body
    let requestBody = await request.json() as Record<string, unknown>;
    logPipelineStage(activeLogger, requestId, 'inbound', outputFormat === 'claude-format' ? '/v1/messages (via generateContent)' : ':generateContent', requestBody);
    logPipelineHeaders(activeLogger, requestId, 'inbound', outputFormat === 'claude-format' ? '/v1/messages (via generateContent)' : ':generateContent', request.headers);

    // before_conversion: client-schema transforms that need route/upstreamMode resolved
    // but must run before the format converter sees the body.
    if (route) {
        const hookCtxConv: HookContext = {
            hook: 'before_conversion',
            route,
            upstreamMode: 'gemini',
            clientModel: (requestBody.model as string) || modelId || 'unknown',
            requestId,
            streaming: requestBody.stream === true,
            logger: activeLogger,
        };
        ({ body: requestBody } = runHook('before_conversion', { body: requestBody, headers: authHeaders }, hookCtxConv));
    }
    const stopSequences = outputFormat === 'claude-format' && Array.isArray(requestBody.stop_sequences)
        ? requestBody.stop_sequences as string[]
        : [];

    // Determine if this is a native Gemini request or needs conversion from Claude format
    let geminiRequest: Record<string, unknown>;
    let isStreaming: boolean;
    let effectiveModelId = modelId;

    if (isNativeGeminiRequest(requestBody)) {
        // Native Gemini format - use directly
        activeLogger.debug(requestId, 'Using native Gemini request format');
        geminiRequest = requestBody;
        isStreaming = requestBody.stream === true;
        effectiveModelId = effectiveModelId || (requestBody.model as string);

        // Convert native format (input: string) to generateContent format (contents: [...])
        if (typeof geminiRequest.input === 'string') {
            geminiRequest = {
                model: effectiveModelId || geminiRequest.model || 'gemini-no-id-at-proxy',
                contents: [{ role: 'user', parts: [{ text: geminiRequest.input }] }],
                stream: isStreaming,
            };
        }
    } else {
        // Claude format - convert to Gemini generateContent format
        activeLogger.debug(requestId, 'Converting Claude request to Gemini format');
        const claudeRequest = requestBody as unknown as ClaudeMessagesRequest;
        // The logger is what makes the converter's Rule #8 warnings reachable: a
        // field this format cannot express (a server tool, a parallel-tool-use
        // constraint) is reported here rather than silently reshaped.
        geminiRequest = await convertClaudeToGeminiRequest(claudeRequest, modelId, {
            logger: activeLogger, requestId,
        });
        isStreaming = claudeRequest.stream === true;
        effectiveModelId = effectiveModelId || claudeRequest.model;
    }

    // Determine the target endpoint
    const fullTargetUrl = constructGeminiUrl(targetUrl, request, geminiRequest, effectiveModelId);

    // Check if upstream will return SSE (based on URL)
    const upstreamIsStreaming = fullTargetUrl.includes(":streamGenerateContent");
    if (upstreamIsStreaming) {
        isStreaming = true;
    }

    // Log request info
    activeLogger.debug(requestId, `Full URL: ${fullTargetUrl}`);
    activeLogger.debug(requestId, `Gemini model: ${effectiveModelId || 'gemini-no-id-at-proxy'}`);
    activeLogger.debug(requestId, `Is streaming: ${isStreaming}`);

    // Prepare headers for Gemini API - authHeaders already contains the correct format
    // from the main router (x-goog-api-key for native Gemini mode)
    let geminiHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...authHeaders,
    };

    activeLogger.debug(requestId, `Using auth headers: ${Object.keys(geminiHeaders).join(', ')}`);
    geminiHeaders = addForwardedHeaders(geminiHeaders, request);

    let upstreamBodyGeminiGen: Record<string, unknown> = geminiRequest;
    if (route) {
        const hookCtx: HookContext = {
            hook: 'before_upstream',
            route,
            upstreamMode: 'gemini',
            clientModel: effectiveModelId || modelId || 'unknown',
            requestId,
            streaming: isStreaming,
            logger: activeLogger,
        };
        ({ body: upstreamBodyGeminiGen, headers: geminiHeaders } = runHook('before_upstream', { body: upstreamBodyGeminiGen, headers: geminiHeaders }, hookCtx));
    }

    try {
        logPipelineStage(activeLogger, requestId, 'upstream-request', fullTargetUrl, upstreamBodyGeminiGen);
        logPipelineHeaders(activeLogger, requestId, 'upstream-request', fullTargetUrl, geminiHeaders);
        let response = await postJsonWithSpool(fullTargetUrl, upstreamBodyGeminiGen, {
            headers: geminiHeaders,
            signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
        });

        if (route) {
            response = await applyAfterUpstream(response, {
                hook: 'after_upstream', route, upstreamMode: 'gemini',
                clientModel: effectiveModelId || modelId || 'unknown',
                requestId, streaming: isStreaming, logger: activeLogger,
            });
        }

        logPipelineHeaders(activeLogger, requestId, 'upstream-response', fullTargetUrl, response.headers);
        recordResponseStatusCodeFromUpstream(response.status);
        recordUpstreamRateLimit(effectiveModelId || modelId, (name) => response.headers.get(name), fullTargetUrl);

        // Handle target API errors
        if (!response.ok) {
            const upstreamErrorBody = await withResponseText(response, requestId, activeLogger, fullTargetUrl, (text) => text, request.signal);
            const bodyPreview = JSON.stringify(geminiRequest).substring(0, 1000);
            handleTargetApiError(response, 'Gemini API', { url: fullTargetUrl, body: bodyPreview, upstreamBody: upstreamErrorBody });
        }

        // Handle streaming response
        if (isStreaming) {
            // `claude-format` is a `/v1/messages` client: it reads Claude SSE. The
            // name `interactions` used to stand in for it here, which is how this
            // egress came to emit the wrong dialect (see `handleGeminiStreamingResponse`).
            return handleGeminiStreamingResponse(
                response, effectiveModelId || 'gemini-no-id-at-proxy', requestId, activeLogger,
                outputFormat === 'claude-format' ? 'claude-format' : 'native-gemini', stopSequences
            );
        }

        // Handle non-streaming response
        const endpointType = outputFormat === 'claude-format' ? 'claude-format' : 'native-gemini';
        return handleGeminiNonStreamingResponse(response, effectiveModelId || 'gemini-no-id-at-proxy', requestId, activeLogger, endpointType, request.signal, stopSequences);

    } catch (error) {
        activeLogger.error(requestId, `Gemini API error: ${(error as Error).message}`);
        throw error;
    }
}

/**
 * Determine the Gemini endpoint based on request
 */
function determineGeminiEndpoint(request: Request, geminiRequest: Record<string, unknown>, modelId?: string): string {
    // Default: generateContent endpoint
    const model = modelId || (geminiRequest.model as string) || 'gemini-no-id-at-proxy';
    return `/v1/models/${model}:generateContent`;
}

/**
 * Construct full Gemini API URL, handling v1beta vs v1 path differences
 */
function constructGeminiUrl(targetUrl: string, request: Request, geminiRequest: Record<string, unknown>, effectiveModelId?: string): string {
    // Extract model from targetUrl if it contains :generateContent
    const urlMatch = targetUrl.match(/\/(v1beta|v1)\/models\/([^:?]+):(stream)?[Gg]enerateContent/);
    if (urlMatch) {
        // URL already contains model and endpoint, reconstruct with the same API version
        const apiVersion = urlMatch[1];
        const urlModel = urlMatch[2];
        const isStream = urlMatch[3] === 'stream';
        const endpoint = isStream ? 'streamGenerateContent' : 'generateContent';
        const queryString = targetUrl.includes('?') ? targetUrl.substring(targetUrl.indexOf('?')) : '';
        const baseOnly = targetUrl.split(`/${apiVersion}/models`)[0];
        return `${baseOnly}/${apiVersion}/models/${urlModel}:${endpoint}${queryString}`;
    } else {
        // Need to add endpoint. /v1/responses and /v1/interactions pass targetUrl as .../v1beta;
        // /v1/messages may pass .../v1beta/models.
        const model = effectiveModelId || (geminiRequest.model as string) || 'gemini-no-id-at-proxy';
        const normalizedTargetUrl = targetUrl.replace(/\/$/, '');
        const endpoint = normalizedTargetUrl.match(/\/(v1beta|v1)$/)
            ? `/models/${model}:generateContent`
            : normalizedTargetUrl.match(/\/(v1beta|v1)\/models$/)
                ? `/${model}:generateContent`
                : determineGeminiEndpoint(request, geminiRequest, effectiveModelId);
        return `${normalizedTargetUrl}${endpoint}`;
    }
}

/**
 * Handle non-streaming response
 *
 * `endpointType` here is `'claude-format'` for a `/v1/messages` client (converted
 * to a Claude response) and `'native-gemini'` for a native client (relayed). It
 * was spelled `'interactions'` for the first of those, which is the name the
 * streaming egress then took for a third dialect it did not have.
 */
async function handleGeminiNonStreamingResponse(
    response: Response,
    model: string,
    requestId: string,
    logger: Logger,
    endpointType: 'claude-format' | 'native-gemini' = 'claude-format',
    signal?: AbortSignal,
    stopSequences: string[] = []
): Promise<Response> {
    if (endpointType === 'native-gemini') {
        return await relayNativeGeminiResponse(response, requestId, logger, signal);
    }

    try {
        // Upstream-response headers are logged by callers; only body is logged here.
        logger.debug(requestId, 'Gemini response received');

        // §5.7: the body is received with bounded memory — `max_response_bytes`
        // enforced, the upstream cancelled on breach — and parsed once, because the
        // conversion needs the value; the spill is released before this returns.
        // No payload extraction: `convertGeminiGenerateContentToClaude` collects
        // text parts only, so an `inlineData` part is dropped before any converted
        // value exists to extract from (see the known limitation in the converter).
        const geminiResponse = await receiveJsonResponse<Record<string, unknown>>(
            response, requestId, logger, response.url || '(upstream)', signal
        );

        // Convert to Claude format. The logger is handed over so the converter's
        // Rule #8 reports (a reply part with no Claude Messages projection) are
        // actually emitted — they were unreachable while this call omitted it.
        const claudeResponse = convertGeminiGenerateContentToClaude(geminiResponse, model, requestId, { logger, stopSequences });
        logPipelineStage(logger, requestId, 'outbound', '/v1/messages (via generateContent)', claudeResponse);

        const genContentOutHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
        logPipelineHeaders(logger, requestId, 'outbound', '/v1/messages (via generateContent)', genContentOutHeaders);
        return new Response(JSON.stringify(claudeResponse), { status: 200, headers: genContentOutHeaders });
    } catch (error) {
        // A proxy error already carries the status and type the client switches on
        // (a spool cap breach is 500 `processing_error`, an admission refusal 503
        // `over_limit_error`); relabelling it as a conversion failure would hide
        // that (rule #8).
        if (error instanceof ClaudeProxyError) throw error;
        logger.error(requestId, `Error converting Gemini response: ${(error as Error).message}`);
        throw new Error(`Failed to convert Gemini response: ${(error as Error).message}`);
    }
}

/**
 * Relay a native Gemini non-streaming response as identity (§5.7).
 *
 * This branch never parses the body, so the upstream bytes are the client's
 * bytes — `inlineData` image/audio parts included, which is the payload §5.7's
 * response allowlist names for native Gemini passthrough. It used to be
 * `await response.text()` handed to `new Response`: the whole body as a string,
 * a second copy inside the response, and no `max_response_bytes` at all. The
 * body is now received bounded — spilled past `threshold_bytes` when spilling
 * is on — and the client is given a stream over that same spool, so its own
 * pace bounds what the proxy holds.
 *
 * The receive is **not** gated on `[spool] enabled`, matching the Interactions
 * branch above and the other identity egresses (`passthrough.ts`,
 * `responses.ts`): there the spool receive replaced the whole-body read
 * outright, so `max_response_bytes` bounds the read whether or not an operator
 * opted into spilling, and a response past the cap fails 500 `processing_error`
 * instead of being forwarded. `enabled` decides where the bytes live (RAM or
 * disk), not how many of them the proxy will hold. The two paths that *are*
 * gated — §5.7's SSE framing and the router's stats read — kept their pre-spool
 * behaviour as the `enabled = false` fallback, which is the difference.
 *
 * The trace line is the only read on this branch, so the §5.9 lease is taken
 * only when tracing materializes it — a body nobody reads is never charged and
 * never refused — and it is released before the client's copy is handed out.
 * `readText()` leaves a live spool readable, so the trace re-read does not
 * consume the bytes the client is about to receive.
 */
async function relayNativeGeminiResponse(
    response: Response,
    requestId: string,
    logger: Logger,
    signal?: AbortSignal
): Promise<Response> {
    const nativeOutHeaders = { 'Content-Type': 'application/json', 'x-request-id': requestId };
    logger.debug(requestId, 'Gemini response received');

    const received = await receiveResponseBody(response.body);

    if (logger.traceEnabled) {
        // §5.9 byte admission, opt-in via `max_materialized_body_bytes`. The
        // body is received but not yet read, so a body that has to wait for
        // capacity waits before any of it is materialized, and the client has
        // no headers yet, so a refusal can still be answered. A refusal must
        // leave neither bytes on disk nor a reservation (rule #8).
        let lease: AdmissionLease;
        try {
            lease = await admitResponseMaterialization(received.size, signal);
        } catch (error) {
            await received.release();
            throw error;
        }
        try {
            const traced = await received.readText();
            logPipelineStage(logger, requestId, 'upstream-response', response.url || '(upstream)', traced);
            logPipelineStage(logger, requestId, 'outbound', ':generateContent (native)', traced);
        } finally {
            // The trace text is unreachable here and the client's body has not
            // been handed out yet, so §5.9's "release before network streaming"
            // holds: the write to the client is bounded by its own pace, not by
            // this budget.
            lease.release();
        }
    }

    logPipelineHeaders(logger, requestId, 'outbound', ':generateContent (native)', nativeOutHeaders);
    return new Response(received.readStream(), { status: response.status, headers: nativeOutHeaders });
}

/**
 * The dialect the *client* asked in, which decides how the upstream's SSE is
 * rendered. They are not interchangeable: a `/v1beta/models/…:streamGenerateContent`
 * client reads generateContent chunks, a `/v1/messages` client reads Claude SSE
 * events, and a `/v1/interactions` client reads `event_type` events.
 */
type ClientStreamDialect = 'native-gemini' | 'claude-format' | 'interactions';

/**
 * Handle streaming response
 */
async function handleGeminiStreamingResponse(
    response: Response,
    model: string,
    requestId: string,
    logger: Logger,
    dialect: ClientStreamDialect = 'interactions',
    stopSequences: string[] = []
): Promise<Response> {
    if (!response.body) {
        throw new Error('Response body is not readable');
    }

    try {
        logger.debug(requestId, `Gemini streaming response started (${dialect} client)`);

        // A native client reads the upstream's own framing. The other two get the
        // transformer for their dialect — each of which returns a TransformStream
        // already, so it is piped as itself. It used to be wrapped in a second
        // `TransformStream`, which has no `transform` of its own and therefore
        // passed every byte through: `/v1/messages` and `/v1/interactions`
        // streaming clients both received raw generateContent chunks.
        const transformedStream = response.body
            .pipeThrough(observeStream(logger, requestId, 'upstream-response', response.url || '(upstream SSE)', 'sse-lines'));

        // §5.7: both the raw upstream SSE and the outbound events are logged by
        // observing the one path the client already reads, rather than by teeing
        // each a second reader that would pull the stream through on its own.
        const convertedStream = dialect === 'native-gemini'
            ? transformedStream.pipeThrough(createNativeGeminiStreamTransformer(model, requestId))
            : transformedStream.pipeThrough(
                dialect === 'claude-format'
                    ? createGeminiStreamTransformer(model, requestId, { logger, stopSequences })
                    : createInteractionsStreamTransformer(model, requestId, logger)
            );

        const outboundStream = convertedStream
            .pipeThrough(observeStream(logger, requestId, 'outbound', 'stream', 'sse-lines'));

        const streamOutHeaders = {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'x-request-id': requestId,
        };
        logPipelineHeaders(logger, requestId, 'outbound', 'stream', streamOutHeaders);
        return new Response(outboundStream, { status: 200, headers: streamOutHeaders });
    } catch (error) {
        logger.error(requestId, `Error creating streaming response: ${(error as Error).message}`);
        throw new Error(`Failed to create streaming response: ${(error as Error).message}`);
    }
}

/**
 * Check if a request is for Gemini API
 */
export function isGeminiRequest(request: Request, targetUrl: string): boolean {
    const url = new URL(request.url);
    const path = url.pathname;

    // Check if path indicates Gemini API
    if (path.includes('/v1/interactions') ||
        path.includes('/v1beta/interactions') ||
        targetUrl.includes('generativelanguage.googleapis.com')) {
        return true;
    }

    // Check for Gemini model identifiers in request
    if (targetUrl.includes('gemini')) {
        return true;
    }

    return false;
}
