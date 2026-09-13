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
import { recordResponseStatusCodeFromUpstream, recordUpstreamResponseToolCount, createUsageTrackingTransformStream, extractUsageFromResponsePayload, recordModelUsage, extractToolNamesFromResponsePayload, recordUpstreamResponseToolNames } from '../utils/dashboard-stats.js';
import { recordUpstreamRateLimit } from '../utils/provider-quota.js';

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

    // Clone request before parsing body to preserve body for SDK handler
    // Parse request body from cloned request
    const requestBody = isSdkUrl(targetUrl) ? await request.clone().json() as Record<string, unknown> : await request.json() as Record<string, unknown>;
    // Parse request body
    //const requestBody = await request.json() as Record<string, unknown>;
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
    const upstreamHeaders = { 'Content-Type': 'application/json', ...addForwardedHeaders(authHeaders, request) };
    logPipelineHeaders(activeLogger, requestId, 'upstream-request', targetUrl, upstreamHeaders);
    let response = await fetch(targetUrl, {
        method: 'POST',
        headers: upstreamHeaders,
        body: JSON.stringify(upstreamBody),
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
            upstreamErrorBody = await response.text();
            activeLogger.error(requestId, `Upstream error response (${response.status}): ${upstreamErrorBody.substring(0, 2000)}`);
        } catch {
            upstreamErrorBody = '(failed to read response body)';
        }
        const bodyPreview = JSON.stringify(requestBody).substring(0, 300);
        handleTargetApiError(response, 'Claude API', { url: targetUrl, body: bodyPreview, upstreamBody: upstreamErrorBody });
    }

    // Token counting: the upstream is already emitting Anthropic SSE with real
    // usage in message_start.message.usage and message_delta.usage, but we have
    // to tap the stream to feed it into recordModelUsage.
    const contentType = response.headers.get('content-type') || '';
    const isEventStream = contentType.includes('text/event-stream');
    const accountingModel = modelId || (typeof requestBody.model === 'string' ? requestBody.model : undefined);
    // Anthropic-compatible upstreams report the account-wide 5h-window used
    // fraction in this header (same source as pi-proxy) — capture it for the
    // usage-left readouts. No-op when the upstream doesn't send it.
    recordUpstreamRateLimit(accountingModel, (name) => response.headers.get(name), targetUrl);

    if (isEventStream && response.body) {
        activeLogger.debug(requestId, `[UPSTREAM-RESP] ${targetUrl}: <streaming SSE, pass-through — see accompanying SSE chunk logs if enabled>`);
    }

    if (isEventStream && response.body && accountingModel) {
        // Tee the stream: one branch goes through the usage-tracking transform
        // (which records tokens on flush), the other is returned to the client
        // untouched. This keeps the pass-through contract for the client while
        // restoring token accounting for the TUI / dashboard.
        const [clientStream, usageStream] = response.body.tee();
        const trackingTransform = createUsageTrackingTransformStream(accountingModel);
        // Pipe usageStream through the transform; the bytes are dropped on
        // the other side, but the transform's flush() will call
        // recordModelUsage when the upstream closes the stream.
        usageStream.pipeThrough(trackingTransform).pipeTo(new WritableStream({
            write() { /* discard */ },
        })).catch(() => {
            // Upstream errors or aborts should not break the client response.
        });

        const outboundHeaders = sanitizeUpstreamResponseHeaders(response);
        logPipelineHeaders(activeLogger, requestId, 'outbound', '/v1/messages (native)', outboundHeaders);
        return new Response(clientStream, {
            status: response.status,
            headers: outboundHeaders,
        });
    }

    // Non-streaming JSON response: read a clone of the body to extract usage
    // and tool names; the original response.body is returned to the client.
    if (response.body) {
        const cloned = response.clone();
        try {
            const text = await cloned.text();
            logPipelineStage(activeLogger, requestId, 'upstream-response', targetUrl, text);
            // Native pass-through: outbound body to the client is identical to upstream response body.
            logPipelineStage(activeLogger, requestId, 'outbound', '/v1/messages (native)', text);
            if (accountingModel) {
                try {
                    const payload = JSON.parse(text);
                    const usage = extractUsageFromResponsePayload(payload);
                    if (usage) {
                        recordModelUsage(accountingModel, usage);
                    }
                    const toolNames = extractToolNamesFromResponsePayload(payload);
                    if (toolNames.length > 0 && !(toolNames.length === 1 && toolNames[0] === 'none')) {
                        recordUpstreamResponseToolNames(toolNames);
                    }
                } catch {
                    // body wasn't JSON; nothing to extract
                }
            }
        } catch {
            // failed to read body; nothing to do
        }
    }

    // Return response as-is (pass-through)
    const finalOutboundHeaders = sanitizeUpstreamResponseHeaders(response);
    logPipelineHeaders(activeLogger, requestId, 'outbound', '/v1/messages (native)', finalOutboundHeaders);
    return new Response(response.body, {
        status: response.status,
        headers: finalOutboundHeaders,
    });
}
