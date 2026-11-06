/**
 * Passthrough handler for /passthrough/* endpoints.
 * Forwards requests verbatim to configured upstream targets.
 * Bypasses model routing, composite, schedule, transforms, privacy filter, kompress, tool blocklist.
 * Retains: auth_server gate, request logging, upstream status recording, timeout, record_server usage recording.
 */

import type { Env, Logger } from '../types/shared.js';
import { logPipelineStage, logPipelineHeaders } from '../utils/logger.js';
import { addForwardedHeaders, sanitizeUpstreamResponseHeaders, formatApiKeyForUpstream } from '../utils/routing.js';
import { extractRawCredential } from '../utils/auth-headers.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { recordResponseStatusCodeFromUpstream, recordUpstreamResponseToolCount, extractUsageFromResponsePayload, recordModelUsage, createUsageTrackingTransformStream, UsageStats } from '../utils/dashboard-stats.js';
import { recordUpstreamRateLimit } from '../utils/provider-quota.js';
import { buildModelUsageRecordPayload, recordModelUsageToRemote } from '../utils/model-usage-recorder.js';
import type { PassthroughTargetConfig, ProxyConfig } from '../utils/config-loader.js';
import type { UpstreamMode } from '../utils/upstream-modes.js';
import { selectWeightedCompositeCandidate } from '../index.js';
import { handleTargetApiError } from '../utils/errors.js';
import { wrapSseStreamWithKeepAlive } from '../utils/sse-keepalive.js';
import { getIngressSpool, readIngressSpoolText } from '../utils/spool-ingress.js';
import { receiveResponseBody, withResponseText } from '../utils/spool-response.js';
import { admitResponseMaterialization, type AdmissionLease } from '../utils/spool-admission.js';
import { streamResponseEvents } from '../utils/spool-events.js';
import { getSpoolConfig } from '../utils/spool.js';

interface EndpointModeMap {
  path: string;
  mode: UpstreamMode;
}

/** Route prefix owned by passthrough mode (see src/index.ts). */
export const PASSTHROUGH_PREFIX = '/passthrough';

const ENDPOINT_MODE_MAP: EndpointModeMap[] = [
  { path: '/v1/messages', mode: 'anthropic-messages' },
  { path: '/v1/messages/count_tokens', mode: 'anthropic-messages' },
  { path: '/v1/chat/completions', mode: 'openai-completions' },
  { path: '/v1/responses', mode: 'openai-responses' },
  { path: '/v1/responses/input_tokens', mode: 'openai-responses' },
  { path: '/v1/responses/compact', mode: 'openai-responses' },
  { path: '/v1/interactions', mode: 'gemini-interactions' },
];

const GEMINI_ACTION_PATTERNS: EndpointModeMap[] = [
  { path: '/v1beta/models/', mode: 'gemini-generatecontent' },
  { path: '/v1/models/', mode: 'gemini-generatecontent' },
];

function matchEndpointToMode(upstreamPath: string): UpstreamMode | null {
  // Exact matches first
  for (const entry of ENDPOINT_MODE_MAP) {
    if (upstreamPath === entry.path || upstreamPath.startsWith(entry.path + '?') || upstreamPath.startsWith(entry.path + '/')) {
      return entry.mode;
    }
  }
  // Gemini action patterns: /v1beta/models/<model>:generateContent|streamGenerateContent|countTokens
  for (const entry of GEMINI_ACTION_PATTERNS) {
    if (upstreamPath.startsWith(entry.path)) {
      const afterPrefix = upstreamPath.slice(entry.path.length);
      if (afterPrefix.match(/^[^:?]+:(generateContent|streamGenerateContent|countTokens)(\?|$)/i)) {
        return entry.mode;
      }
    }
  }
  return null;
}

function schemaGate(mode: UpstreamMode, body: Record<string, unknown>): boolean {
  switch (mode) {
    case 'openai-completions':
    case 'anthropic-messages':
      return Array.isArray(body.messages);
    case 'openai-responses':
      return typeof body.input === 'string' || Array.isArray(body.input);
    case 'gemini-interactions':
      return typeof body.input === 'string' || (typeof body.input === 'object' && body.input !== null) || Array.isArray(body.input);
    case 'gemini-generatecontent':
      return Array.isArray(body.contents);
    default:
      return false;
  }
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function buildPlainJoinUrl(base: string, upstreamPath: string, queryString: string): string {
  const baseNoSlash = stripTrailingSlash(base);
  const pathNoSlash = upstreamPath.replace(/^\/+/, '');
  const joined = `${baseNoSlash}/${pathNoSlash}`;
  return queryString ? `${joined}${queryString}` : joined;
}

/**
 * Recover the raw caller credential from `extractAuthHeaders` output.
 * `extractAuthHeaders` is mode-agnostic: it folds `x-api-key` into
 * `Authorization: Bearer ...` and preserves `x-goog-api-key` as-is. Prefer the
 * explicit Gemini key when present, otherwise unwrap the Bearer token.
 */
function extractCallerKey(authHeaders: Record<string, string>): string | undefined {
  return extractRawCredential(authHeaders, 'goog-api-key-first');
}

export async function handlePassthroughRequest(
  request: Request,
  path: string,
  proxyConfig: ProxyConfig,
  env: Env,
  logger: Logger,
  requestId: string,
  authHeaders: Record<string, string>,
  endpointUserKey: string,
  oneTimeAuthCode: string | undefined,
  sidecarForwardedHeaders: Record<string, string>,
): Promise<Response> {
  // Strip the /passthrough prefix, leaving the upstream path (e.g. /v1/messages).
  const upstreamPath = path.slice(PASSTHROUGH_PREFIX.length);
  if (!upstreamPath.startsWith('/')) {
    return new Response(JSON.stringify({ error: 'Invalid passthrough path' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Extract query string
  const url = new URL(request.url);
  const queryString = url.search;

  // Map upstream path to mode
  const mode = matchEndpointToMode(upstreamPath);
  if (!mode) {
    logger.warn(requestId, `Passthrough: no mode mapping for ${upstreamPath}`);
    return new Response(JSON.stringify({ error: 'Endpoint not supported in passthrough mode' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Collect candidates from config matching this mode
  const candidates: Array<{ name: string; config: PassthroughTargetConfig }> = [];
  if (proxyConfig.passthrough) {
    for (const [name, target] of Object.entries(proxyConfig.passthrough)) {
      // 'open-responses' targets serve the same /v1/responses paths as
      // 'openai-responses' (identical wire format).
      if (target.mode === mode || (target.mode === 'open-responses' && mode === 'openai-responses')) {
        candidates.push({ name, config: target });
      }
    }
  }
  if (candidates.length === 0) {
    logger.warn(requestId, `Passthrough: no targets configured for mode ${mode}`);
    return new Response(JSON.stringify({ error: 'No upstream targets configured for this endpoint' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse and gate on the client body, then keep only the scalars the rest of
  // the handler needs (§5.3). The source text and the parsed tree become
  // collectible when this block exits, so neither is alive at the send boundary.
  // `/passthrough` runs no privacy/kompress/tool-erase mutation, so the raw
  // client bytes stay authoritative for egress — the upstream gets the original
  // bytes, not a re-serialization of `body`.
  let bodyPreview = '';
  let bodyModel = 'unknown';
  let includeUsageRequested = false;
  let egressBody: ReadableStream<Uint8Array> | Uint8Array;
  let egressLength: number;
  {
    const bodyText = await readIngressSpoolText(request);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(bodyText);
    } catch {
      logger.warn(requestId, `Passthrough: invalid JSON body`);
      return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Schema gate
    if (!schemaGate(mode, body)) {
      logger.warn(requestId, `Passthrough: schema gate failed for mode ${mode}`);
      return new Response(JSON.stringify({ error: `Request body does not match schema for ${mode}` }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    bodyPreview = bodyText.slice(0, 300);
    bodyModel = typeof body.model === 'string' && body.model !== '' ? body.model : 'unknown';
    const streamOptions = body.stream_options as Record<string, unknown> | undefined;
    includeUsageRequested =
      typeof streamOptions === 'object' && streamOptions !== null && streamOptions.include_usage === true;

    // Egress: forward the raw spool in chunks with its exact length. Without a
    // raw-body ref (handler called directly, or a body-less request) fall back
    // to the decoded text's UTF-8 bytes.
    const rawSpool = getIngressSpool(request);
    if (rawSpool && request.body) {
      egressBody = rawSpool.readStream();
      egressLength = rawSpool.size;
    } else {
      egressBody = new TextEncoder().encode(bodyText);
      egressLength = egressBody.byteLength;
    }
  }

  // Weighted random selection by share
  const selected = selectWeightedCompositeCandidate(candidates, (c) => c.config.share ?? 1);
  if (!selected) {
    return new Response(JSON.stringify({ error: 'No upstream target available' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const target = selected.config;
  const targetName = selected.name;

  // Build upstream URL with plain join
  const upstreamUrl = buildPlainJoinUrl(target.base, upstreamPath, queryString);
  logger.info(requestId, `Passthrough: ${path} -> ${upstreamUrl} (target: ${targetName}, mode: ${mode})`);

  // Auth headers: the configured `target.key` when set, otherwise the caller's
  // credential. `extractAuthHeaders` is mode-agnostic — it folds the caller's
  // credential into `Authorization` (and preserves `x-goog-api-key`) — while
  // `formatApiKeyForUpstream` writes the header the mode actually uses
  // (`x-api-key` / `x-goog-api-key` / `Authorization`). Re-emit the credential in
  // the mode-appropriate header and drop the originals, so an anthropic-messages
  // upstream gets `x-api-key` (not a Bearer token it ignores) and no mode ever
  // sends BOTH credentials. Non-credential headers (e.g. `anthropic-beta`) are kept.
  const upstreamCredential = target.key ?? extractCallerKey(authHeaders);
  let upstreamAuthHeaders = { ...authHeaders };
  delete upstreamAuthHeaders['Authorization'];
  delete upstreamAuthHeaders['x-goog-api-key'];
  if (upstreamCredential) {
    upstreamAuthHeaders = { ...upstreamAuthHeaders, ...formatApiKeyForUpstream(upstreamCredential, mode) };
  }

  // The auth_server gate has already run in index.ts before dispatch (either the
  // early gate, or the deferred post-parse gate for auth_with_model/body).

  // Forward request to upstream
  const upstreamHeaders = {
    'Content-Type': 'application/json',
    ...addForwardedHeaders(upstreamAuthHeaders, request),
    // The body is streamed, so fetch cannot infer a length. `egressLength` is the
    // exact client byte count — never a stale or recomputed length (§5.3).
    'Content-Length': String(egressLength),
  };
  logPipelineHeaders(logger, requestId, 'upstream-request', upstreamUrl, upstreamHeaders);
  // Trace-only: re-read the raw body from the spool so the full upstream request
  // stays visible without holding it from the parse through the send. Without a
  // spool the request body is already consumed by the parse, so the preview is
  // all that is left to log.
  if (logger.traceEnabled) {
    const traceSpool = getIngressSpool(request);
    logPipelineStage(logger, requestId, 'upstream-request', upstreamUrl, traceSpool ? await traceSpool.readText() : bodyPreview);
  }

  let response: Response;
  try {
    response = await fetch(upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: egressBody,
      // A streamed request body needs `duplex: 'half'` (repo convention:
      // src/index.ts:1201, src/server.ts:163).
      duplex: 'half',
      signal: createUpstreamAbortSignal(target.timeout ?? getUpstreamBodyTimeoutMs(env)),
    } as RequestInit);
  } catch (err) {
    logger.error(requestId, `Passthrough: upstream fetch failed: ${(err as Error).message}`);
    const errorResponse = new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
    return handleTargetApiError(errorResponse, 'Passthrough upstream', { url: upstreamUrl, body: bodyPreview });
  }

  logPipelineHeaders(logger, requestId, 'upstream-response', upstreamUrl, response.headers);
  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount(mode, 0);

  if (!response.ok) {
    let upstreamErrorBody = '';
    try {
      // §5.7: the error body goes through the same bounded receive as a success
      // body, so `max_response_bytes` bounds it too. Only an unreadable body — the
      // one thing the placeholder below was ever for — keeps it; a cap breach, a
      // spill write failure or a §5.9 refusal is the proxy's own limit and must
      // surface as itself, not as "the upstream body could not be read" (rule #8).
      upstreamErrorBody = await withResponseText(response, requestId, logger, upstreamUrl, (text) => text, request.signal);
      logger.error(requestId, `Passthrough: upstream error (${response.status}): ${upstreamErrorBody.slice(0, 2000)}`);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      upstreamErrorBody = '(failed to read response body)';
    }
    return handleTargetApiError(response, 'Passthrough upstream', { url: upstreamUrl, body: bodyPreview, upstreamBody: upstreamErrorBody });
  }

  // Capture rate limit headers
  const modelForRateLimit = bodyModel;
  recordUpstreamRateLimit(modelForRateLimit, (name) => response.headers.get(name), upstreamUrl);

  const contentType = response.headers.get('content-type') || '';
  const isEventStream = contentType.includes('text/event-stream');
  const modelUsageRecordUrl = proxyConfig.remote?.record_server?.trim();
  const modelUsageRecordBody = proxyConfig.remote?.record_response_body === true;

  // Usage recording key: body.model (since no route model is resolved)
  const usageModelKey = bodyModel;

  if (isEventStream && response.body) {
    logger.debug(requestId, `[Passthrough] ${upstreamUrl}: <streaming SSE, relaying with usage tracking>`);

    // The request body is forwarded verbatim, so the proxy never injects
    // `stream_options.include_usage`. For an openai-completions upstream the
    // final usage chunk is emitted only when the client asked for it — warn so
    // a silently uncounted stream is not mistaken for a working one.
    if (mode === 'openai-completions' && !includeUsageRequested) {
      logger.warn(requestId, `Passthrough: streaming openai-completions request without stream_options.include_usage — the upstream will omit the usage chunk, so token usage will NOT be counted. Send stream_options = {include_usage = true} to enable it.`);
    }

    // Track usage via the central transform stream
    const usageTrackingStream = createUsageTrackingTransformStream(
      usageModelKey,
      undefined, // no composite alias
      modelUsageRecordUrl
        ? (usage: UsageStats, responseBody: unknown) => {
            recordModelUsageToRemote(
              modelUsageRecordUrl,
              buildModelUsageRecordPayload(
                requestId,
                upstreamPath,
                endpointUserKey,
                usageModelKey,
                usage,
                200,
                modelUsageRecordBody ? responseBody : undefined
              ),
              logger,
              oneTimeAuthCode,
              sidecarForwardedHeaders
            );
          }
        : undefined,
      modelUsageRecordBody
    );

    // Pipe upstream -> per-event framing -> usage tracker -> keep-alive ->
    // client. §5.7 framing goes first so a single event is bounded before the
    // usage tracker accumulates it in its `remainder`; `[spool] enabled` gates
    // it, since with spooling off there is nothing to spill.
    // The keep-alive wrapper injects `: ping` comment lines when the upstream is
    // silent for 30s+ (Claude Code aborts a stream after 5 min without bytes).
    const sseSource = getSpoolConfig().enabled
      ? streamResponseEvents(response.body)
      : response.body;
    const trackedResponse = new Response(
      wrapSseStreamWithKeepAlive(sseSource.pipeThrough(usageTrackingStream)),
      {
        status: response.status,
        headers: sanitizeUpstreamResponseHeaders(response),
      }
    );

    logPipelineHeaders(logger, requestId, 'outbound', upstreamPath, trackedResponse.headers);
    return trackedResponse;
  }

  // Non-streaming: spool body, record usage, stream it back
  if (response.body) {
    // §5.7: receive the body with bounded memory — above `threshold_bytes` it
    // lives on disk, and `readStream()` hands it to the client a chunk at a time
    // instead of a second full copy. The parse below is the one copy left, and
    // `max_response_bytes` now caps it: a breach cancels the upstream body and
    // fails explicitly rather than truncating the response.
    const received = await receiveResponseBody(response.body);
    // §5.9 byte admission, opt-in via `max_materialized_body_bytes`: the body is
    // received but not yet read, so a body that has to wait for capacity waits
    // before any of it is materialized, and the client has no headers yet, so a
    // refusal can still be answered. The charge is the received byte count, as on
    // the request path (`src/index.ts`) — never a guess from `Content-Length`.
    // A refusal must leave neither the received bytes on disk nor a reservation
    // on the ledger (rule #8).
    let lease: AdmissionLease;
    try {
      lease = await admitResponseMaterialization(received.size, request.signal);
    } catch (error) {
      await received.release();
      throw error;
    }
    try {
      const text = await received.readText();
      logPipelineStage(logger, requestId, 'upstream-response', upstreamUrl, text);
      logPipelineStage(logger, requestId, 'outbound', upstreamPath, text);

      // Extract and record usage
      let usage: UsageStats | undefined;
      try {
        const parsed = JSON.parse(text);
        usage = extractUsageFromResponsePayload(parsed);
        if (usage && (usage.input_tokens || usage.output_tokens || usage.total_tokens)) {
          recordModelUsage(usageModelKey, usage);
          if (modelUsageRecordUrl) {
            recordModelUsageToRemote(
              modelUsageRecordUrl,
              buildModelUsageRecordPayload(
                requestId,
                upstreamPath,
                endpointUserKey,
                usageModelKey,
                usage,
                response.status,
                modelUsageRecordBody ? parsed : undefined
              ),
              logger,
              oneTimeAuthCode,
              sidecarForwardedHeaders
            );
          }
        }
      } catch {
        // Not JSON or no usage - that's fine
      }
    } finally {
      // The materialized text is unreachable here and the client's body has not
      // been handed out yet, so §5.9's "release before network streaming" holds:
      // the write to the client is bounded by its own pace, not by this budget.
      lease.release();
    }

    const outboundHeaders = sanitizeUpstreamResponseHeaders(response);
    logPipelineHeaders(logger, requestId, 'outbound', upstreamPath, outboundHeaders);
    // Forwarded from the spool rather than from the parsed copy above: a spilled
    // body is re-read from disk a chunk at a time, so the client's write pace —
    // not a buffer — bounds what the proxy holds while the response is sent.
    return new Response(received.readStream(), {
      status: response.status,
      headers: outboundHeaders,
    });
  }

  // No body
  const finalHeaders = sanitizeUpstreamResponseHeaders(response);
  logPipelineHeaders(logger, requestId, 'outbound', upstreamPath, finalHeaders);
  return new Response(null, {
    status: response.status,
    headers: finalHeaders,
  });
}