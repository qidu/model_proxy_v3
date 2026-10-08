/**
 * Decision API handler for Claude Proxy v3
 *
 * Proxies POST /decision requests to an upstream serving the Clef contract
 * (as defined by docs/api/decision/clef-schema-input.json and clef-schema-output.json).
 *
 * The upstream is configured via [decision] in proxy_config.toml:
 *   backend    = "laya" | "cloudflare" | "clef"   # required; "clef" === "cloudflare"
 *   url        = "http://..."            # required, POSTed verbatim
 *   api_key    = ""                      # optional, sent as Authorization: Bearer
 *   timeout_ms = 5000                    # optional, defaults per backend
 *
 * `bodyText` is passed in rather than read from the Request because the caller
 * (src/index.ts) has already consumed the body to run the deferred auth gate —
 * same convention as handlePassthroughRequest.
 */

import type { Logger } from '../types/shared.js';
import type { ProxyConfig } from '../utils/config-loader.js';
import { createErrorResponse } from '../utils/errors.js';
import { createUpstreamAbortSignal } from '../utils/fetch-timeout.js';

export async function handleDecisionRequest(
  bodyText: string,
  proxyConfig: ProxyConfig,
  requestId: string,
  logger: Logger,
): Promise<Response> {
  const decisionConfig = proxyConfig.decision;

  // [decision] must supply both backend and url to enable this endpoint.
  if (!decisionConfig?.backend || !decisionConfig?.url) {
    logger.error(requestId, 'Decision endpoint not enabled: [decision] backend and url are required');
    return createErrorResponse(
      new Error('Decision endpoint not configured: [decision] backend ("laya" | "cloudflare" | "clef") and url are required'),
      requestId,
      503,
    );
  }

  // "clef" is an accepted spelling of "cloudflare": the Clef contract is served
  // by Cloudflare's `@cf/cloudflare/clef`, so both names are in use for the same
  // backend. Normalise once here and key everything downstream on the canonical
  // name, so the images gate and the timeout default cannot drift apart.
  const backend = decisionConfig.backend === 'clef' ? 'cloudflare' : decisionConfig.backend;
  const url = decisionConfig.url;
  const apiKey = decisionConfig.api_key;
  const timeoutMs = decisionConfig.timeout_ms ?? (backend === 'laya' ? 5000 : 30000);

  // Parse request body
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return createErrorResponse(new Error('Invalid JSON body'), requestId, 400);
  }

  // Envelope-only validation: top-level required fields of the Clef input schema.
  // Per-question shapes are left to the upstream, which owns that validation.
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return createErrorResponse(new Error('Request body must be a JSON object'), requestId, 400);
  }
  if (!body.model || typeof body.model !== 'string') {
    return createErrorResponse(new Error('Missing required field: model'), requestId, 400);
  }
  if (body.state === undefined || body.state === null) {
    return createErrorResponse(new Error('Missing required field: state'), requestId, 400);
  }
  if (!body.questions || typeof body.questions !== 'object' || Array.isArray(body.questions) || Object.keys(body.questions).length === 0) {
    return createErrorResponse(new Error('Missing required field: questions (non-empty object)'), requestId, 400);
  }

  // Images gate: the laya sidecar's MLX encoder is text-only. Reject before any
  // upstream call so the client gets a clear reason instead of a silent drop.
  if (backend === 'laya' && Array.isArray(body.images) && body.images.length > 0) {
    return createErrorResponse(
      new Error('Image input is not supported by the "laya" backend; set [decision] backend = "cloudflare" to use an upstream that accepts images'),
      requestId,
      400,
    );
  }

  // Make upstream request. The body is forwarded verbatim — the proxy implements
  // no transport of its own beyond the POST.
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const upstreamResponse = await fetch(url, {
    method: 'POST',
    headers,
    body: bodyText,
    signal: createUpstreamAbortSignal(timeoutMs),
  });

  if (!upstreamResponse.ok) {
    logger.error(requestId, `Upstream decision error: ${upstreamResponse.status}`);
    // Forward upstream error as-is (status + body + x-request-id)
    const errorText = await upstreamResponse.text();
    return new Response(errorText, {
      status: upstreamResponse.status,
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
    });
  }

  const responseText = await upstreamResponse.text();
  let responseData: Record<string, unknown>;
  try {
    responseData = JSON.parse(responseText);
  } catch {
    return createErrorResponse(new Error('Invalid upstream response'), requestId, 502);
  }

  // Envelope-only validation: top-level required fields of the Clef output schema.
  if (
    !responseData ||
    typeof responseData !== 'object' ||
    Array.isArray(responseData) ||
    typeof responseData.model !== 'string' ||
    !responseData.answers ||
    typeof responseData.answers !== 'object' ||
    Array.isArray(responseData.answers) ||
    !responseData.usage ||
    typeof responseData.usage !== 'object' ||
    Array.isArray(responseData.usage)
  ) {
    logger.error(requestId, 'Upstream response is missing the Clef envelope fields (model, answers, usage)');
    return createErrorResponse(new Error('Invalid upstream response'), requestId, 502);
  }

  // Return the upstream body verbatim.
  return new Response(responseText, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
    },
  });
}