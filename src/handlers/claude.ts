/**
 * Claude API handler for native Claude endpoints
 * Handles pass-through to AWS Bedrock, Vertex AI, or Anthropic API
 */

import { Env, Logger } from '../types/shared.js';
import { createLogger, logPipelineStage, logPipelineHeaders } from '../utils/logger.js';
import { handleTargetApiError } from '../utils/errors.js';
import { isSdkUrl, handleSdkAnthropicRequest } from '../utils/sdk-handler.js';
import { addForwardedHeaders, sanitizeUpstreamResponseHeaders } from '../utils/routing.js';
import { runHook, applyAfterUpstream, type HookContext } from '../utils/request-transform.js';
import type { ModelRouteConfig } from '../utils/config-loader.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { recordResponseStatusCodeFromUpstream, recordUpstreamResponseToolCount } from '../utils/dashboard-stats.js';
import { recordUpstreamRateLimit } from '../utils/provider-quota.js';
import { collectBlobRefs, rehydrateInlineBlobs } from '../utils/blob-refs.js';
import { createRefAwareJsonBody } from '../utils/ref-serializer.js';
import { admitResponseMaterialization, type AdmissionLease } from '../utils/spool-admission.js';
import { receiveResponseBody, withResponseText } from '../utils/spool-response.js';
import { getSpoolConfig } from '../utils/spool.js';

/**
 * Handle native Claude API request (pass-through)
 */
export async function handleClaudeRequest(
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

    // §5.7: the body is read once, in place. The `sdk://` route used to read it
    // through `request.clone()` "to preserve body for SDK handler", and a clone
    // *tees* the body: the branch nobody reads stays resident for as long as the
    // parse runs, i.e. a second full copy of a body that may carry an image.
    // Nothing reads that branch — every `sdk://` branch below is handed
    // `requestBody`, the parsed object, and the SDK handlers are stubs that never
    // touch the request they are given. The non-SDK route already consumed the
    // body here, so this only makes the two routes the same read. An SDK handler
    // that ever does need the wire body must be handed one explicitly (a receive,
    // as the ingress does) rather than by teeing this one.
    const requestBody = await request.json() as Record<string, unknown>;
    // Parse request body
    //const requestBody = await request.json() as Record<string, unknown>;
    // §5.3 egress shape. Shape 2 (the default, and every other handler today):
    // the send boundary forwards refs, not payloads — put the inline payloads
    // back before anything reads this body. Shape 3 (this route's send, below):
    // the refs stay and the send streams each payload at the offset its ref
    // occupies, so the expanded body never exists. Which one this request takes
    // is decided here and used there, because a body expanded here has no refs
    // left to stream. `enabled` gates the walk, so a deployment with spooling off
    // (§9.1) pays nothing: with no extraction pass there can be no ref. The
    // `sdk://` branch below is handed the parsed body itself, so it stays on
    // shape 2.
    const streamRefs = !isSdkUrl(targetUrl) && getSpoolConfig().enabled &&
        collectBlobRefs(requestBody).length > 0;
    if (!streamRefs) {
        await rehydrateInlineBlobs(requestBody);
    }
    logPipelineStage(activeLogger, requestId, 'inbound', '/v1/messages (native)', requestBody);
    logPipelineHeaders(activeLogger, requestId, 'inbound', '/v1/messages (native)', request.headers);

    const isStreaming = requestBody.stream === true;

    // Use modelId (which may be an alias) if provided
    if (modelId) {
        requestBody.model = modelId;
    }

    // max_tokens passthrough: when the entry sets no per-entry max_tokens, the
    // field is never set, modified, or capped — a request that omits it is
    // forwarded as-is (a strictly-conformant Anthropic upstream will reject it).
    // When omitted and the entry DOES set max_tokens: fill it with that value.
    // After before_upstream: clamp down to route.maxTokens if the client/transform sent a larger value.
    if ((requestBody.max_tokens === undefined || requestBody.max_tokens === null)
        && route?.maxTokens !== undefined) {
        requestBody.max_tokens = route.maxTokens;
        activeLogger.debug(requestId, `max_tokens missing, defaulting to ${requestBody.max_tokens}`);
    }

    // Some upstreams (e.g., DeepSeek Anthropic-compatible API) default to thinking mode
    // and require prior thinking blocks in conversation. Explicitly disable thinking
    // when the client hasn't set it to avoid 400 errors on first requests.
    // (Stripping thinking-enabled on conversations without prior thinking blocks is
    // opt-in per target via the `strip_fresh_thinking` transform builtin.)
    if (requestBody.thinking === undefined || requestBody.thinking === null) {
        requestBody.thinking = { type: 'disabled' };
        activeLogger.debug(requestId, 'thinking not set, defaulting to disabled');
    }

    activeLogger.debug(requestId, `Claude native upstream: ${targetUrl}`);
    activeLogger.debug(requestId, `Model: ${modelId || requestBody.model}`);
    activeLogger.debug(requestId, `Streaming: ${isStreaming}`);
    activeLogger.debug(requestId, `Has thinking config: ${JSON.stringify(requestBody.thinking)}`);
    if (Array.isArray(requestBody.messages)) {
        const lastAssistantMsg = [...requestBody.messages as any[]].reverse().find(m => m.role === 'assistant');
        if (lastAssistantMsg && Array.isArray(lastAssistantMsg.content)) {
            const thinkingBlocks = lastAssistantMsg.content.filter((c: any) => c.type === 'thinking');
            activeLogger.debug(requestId, `Last assistant message has ${thinkingBlocks.length} thinking content blocks`);
        }
    }

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

        // Use SDK handler for Anthropic requests
        return handleSdkAnthropicRequest(
            request,
            targetUrl,
            requestId,
            apiKey,
            modelId,
            activeLogger,
            env,
            requestBody
        );
    }

    // before_upstream: apply declared transforms to the upstream body.
    let upstreamBody: Record<string, unknown> = requestBody;
    if (route) {
        const hookCtx: HookContext = {
            hook: 'before_upstream',
            route,
            upstreamMode: 'anthropic-messages',
            clientModel: (requestBody.model as string) || modelId || 'unknown',
            requestId,
            streaming: requestBody.stream === true,
            logger: activeLogger,
        };
        ({ body: upstreamBody, headers: authHeaders } = runHook('before_upstream', { body: upstreamBody, headers: authHeaders }, hookCtx));
    }
    // Per-entry max_tokens cap is applied centrally inside runHook('before_upstream')
    // (see applyMaxTokensCap in utils/request-transform.ts).

    // Pass through to native Claude API
    activeLogger.debug(requestId, `Sending to upstream: ${JSON.stringify(upstreamBody).substring(0, 500)}`);
    logPipelineStage(activeLogger, requestId, 'upstream-request', targetUrl, upstreamBody);
    // §5.3 shape 3, the graduate path: a body that still carries refs is sent as
    // a stream — the skeleton plus one blob chunk at a time, read from L2 as the
    // upstream pulls — instead of as one expanded string. Two things come with
    // it: the exact `Content-Length` the serializer measured from the skeleton
    // and the refs' recorded sizes (fetch cannot infer a length for a streamed
    // body, and a stale length is worse than none), and `duplex: 'half'` (this
    // repo's streamed-egress convention, src/handlers/passthrough.ts:271 — that
    // call needs the `as RequestInit` cast only because its `duplex` is a plain
    // key; a conditional spread skips the excess-property check). A ref-free body
    // — and every request on a deployment with spooling off — sends the expanded
    // string exactly as before.
    const streamed = streamRefs ? createRefAwareJsonBody(upstreamBody) : undefined;
    const upstreamHeaders = {
        'Content-Type': 'application/json',
        ...addForwardedHeaders(authHeaders, request),
        ...(streamed ? { 'Content-Length': String(streamed.contentLength) } : {}),
    };
    logPipelineHeaders(activeLogger, requestId, 'upstream-request', targetUrl, upstreamHeaders);
    let response = await fetch(targetUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: streamed ? streamed.body : JSON.stringify(upstreamBody),
        ...(streamed ? { duplex: 'half' } : {}),
        signal: createUpstreamAbortSignal(route?.timeout ?? getUpstreamBodyTimeoutMs(env)),
    });

    // after_upstream: apply response transforms before !ok check (fires on both success and error).
    if (route) {
        response = await applyAfterUpstream(response, {
            hook: 'after_upstream', route, upstreamMode: 'anthropic-messages',
            clientModel: (requestBody.model as string) || modelId || 'unknown',
            requestId, streaming: requestBody.stream === true, logger: activeLogger,
        });
    }

    logPipelineHeaders(activeLogger, requestId, 'upstream-response', targetUrl, response.headers);
    recordResponseStatusCodeFromUpstream(response.status);
    recordUpstreamResponseToolCount('anthropic-messages', 0);

    if (!response.ok) {
        // Read upstream response body for diagnostics
        let upstreamErrorBody = '';
        try {
            // §5.7: the error body goes through the same bounded receive as a success
            // body, so `max_response_bytes` bounds it too. Only an unreadable body — the
            // one thing the placeholder below was ever for — keeps it; a cap breach, a
            // spill write failure or a §5.9 refusal is the proxy's own limit and must
            // surface as itself, not as "the upstream body could not be read" (rule #8).
            upstreamErrorBody = await withResponseText(response, requestId, activeLogger, targetUrl, (text) => text, request.signal);
            activeLogger.error(requestId, `Upstream error response (${response.status}): ${upstreamErrorBody.substring(0, 2000)}`);
        } catch (error) {
            if (!(error instanceof TypeError)) throw error;
            upstreamErrorBody = '(failed to read response body)';
        }
        const bodyPreview = JSON.stringify(requestBody).substring(0, 300);
        handleTargetApiError(response, 'Claude API', { url: targetUrl, body: bodyPreview, upstreamBody: upstreamErrorBody });
    }

    const contentType = response.headers.get('content-type') || '';
    const isEventStream = contentType.includes('text/event-stream');
    const accountingModel = modelId || (typeof requestBody.model === 'string' ? requestBody.model : undefined);
    // Anthropic-compatible upstreams report the account-wide 5h-window used
    // fraction in this header (same source as pi-proxy) — capture it for the
    // usage-left readouts. No-op when the upstream doesn't send it.
    recordUpstreamRateLimit(accountingModel, (name) => response.headers.get(name), targetUrl);

    if (isEventStream && response.body) {
        activeLogger.debug(requestId, `[UPSTREAM-RESP] ${targetUrl}: <streaming SSE, pass-through — see accompanying SSE chunk logs if enabled>`);
        // Return the SSE stream untouched. Token usage is recorded centrally in
        // index.ts, which pipes every 2xx text/event-stream body through
        // createUsageTrackingTransformStream; tapping the stream here as well
        // would record the same usage twice.
        const outboundHeaders = sanitizeUpstreamResponseHeaders(response);
        logPipelineHeaders(activeLogger, requestId, 'outbound', '/v1/messages (native)', outboundHeaders);
        return new Response(response.body, {
            status: response.status,
            headers: outboundHeaders,
        });
    }

    // §5.7: receive the body bounded — above `threshold_bytes` it lives in a
    // `responses/` spill — and forward it from there a chunk at a time. This
    // branch never converts, so the upstream bytes are the client's bytes; the
    // clone read here existed only for the two trace lines below and cost a whole
    // second copy of the body (§5.7: "do not call `response.clone().text()` or
    // buffer a second copy"), pulled as fast as the upstream could send it
    // whatever pace the client kept. The trace re-reads the spool instead, and
    // only when tracing is on — the convention the identity egresses already
    // follow (src/handlers/responses.ts:1962).
    const received = response.body ? await receiveResponseBody(response.body) : null;

    if (received && activeLogger.traceEnabled) {
        // §5.9 byte admission, opt-in via `max_materialized_body_bytes`, taken only
        // where something is materialized: the sole read on this branch is the trace
        // one, so a body nobody is going to read is never charged and never refused.
        // The body is received but not yet read, so a body that has to wait for
        // capacity waits before any of it is materialized, and the client has no
        // headers yet, so a refusal can still be answered. A refusal must leave
        // neither the received bytes on disk nor a reservation on the ledger (#8).
        let lease: AdmissionLease;
        try {
            lease = await admitResponseMaterialization(received.size, request.signal);
        } catch (error) {
            await received.release();
            throw error;
        }
        try {
            const text = await received.readText();
            logPipelineStage(activeLogger, requestId, 'upstream-response', targetUrl, text);
            // Native pass-through: outbound body to the client is identical to upstream response body.
            logPipelineStage(activeLogger, requestId, 'outbound', '/v1/messages (native)', text);
        } finally {
            lease.release();
        }
    }

    // Return response as-is (pass-through)
    const finalOutboundHeaders = sanitizeUpstreamResponseHeaders(response);
    logPipelineHeaders(activeLogger, requestId, 'outbound', '/v1/messages (native)', finalOutboundHeaders);
    // Forwarded from the spool rather than from a materialized copy: a spilled body
    // is re-read from disk a chunk at a time, so the client's write pace — not a
    // buffer — bounds what the proxy holds while the response is sent.
    return new Response(received ? received.readStream() : null, {
        status: response.status,
        headers: finalOutboundHeaders,
    });
}
