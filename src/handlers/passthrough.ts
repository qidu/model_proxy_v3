/**
 * Passthrough handler for /passthrough/* endpoints.
 * Forwards requests verbatim to configured upstream targets.
 * Bypasses model routing, composite, schedule, transforms, privacy filter, kompress, tool blocklist.
 * Retains: auth_server gate, request logging, upstream status recording, timeout, record_server usage recording.
 */

import type { Env, Logger } from '../types/shared.js';
import { logPipelineStage, logPipelineHeaders } from '../utils/logger.js';
import { addForwardedHeaders, sanitizeUpstreamResponseHeaders, formatApiKeyForUpstream } from '../utils/routing.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { recordResponseStatusCodeFromUpstream, recordUpstreamResponseToolCount, extractUsageFromResponsePayload, recordModelUsage, createUsageTrackingTransformStream, UsageStats } from '../utils/dashboard-stats.js';
import { recordUpstreamRateLimit } from '../utils/provider-quota.js';
import { buildModelUsageRecordPayload, recordModelUsageToRemote } from '../utils/model-usage-recorder.js';
import type { PassthroughTargetConfig, ProxyConfig } from '../utils/config-loader.js';
import type { UpstreamMode } from '../utils/upstream-modes.js';
import { selectWeightedCompositeCandidate } from '../index.js';
import { handleTargetApiError } from '../utils/errors.js';

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

export async function handlePassthroughRequest(
  request: Request,
  path: string,
  bodyText: string,
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
      if (target.mode === mode) {
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

  // Parse request body (already read by the caller so the auth gate could see it)
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

  // Auth headers: default to client key, override with target.key if set
  let upstreamAuthHeaders = { ...authHeaders };
  if (target.key) {
    upstreamAuthHeaders = { ...upstreamAuthHeaders, ...formatApiKeyForUpstream(target.key, mode) };
  }

  // The auth_server gate has already run in index.ts before dispatch (either the
  // early gate, or the deferred post-parse gate for auth_with_model/body).

  // Forward request to upstream
  const isStreaming = body.stream === true;
  const upstreamHeaders = { 'Content-Type': 'application/json', ...addForwardedHeaders(upstreamAuthHeaders, request) };
  logPipelineHeaders(logger, requestId, 'upstream-request', upstreamUrl, upstreamHeaders);
  logPipelineStage(logger, requestId, 'upstream-request', upstreamUrl, bodyText);

  let response: Response;
  try {
    response = await fetch(upstreamUrl, {
      method: 'POST',
      headers: upstreamHeaders,
      body: bodyText,
      signal: createUpstreamAbortSignal(target.timeout ?? getUpstreamBodyTimeoutMs(env)),
    });
  } catch (err) {
    logger.error(requestId, `Passthrough: upstream fetch failed: ${(err as Error).message}`);
    const errorResponse = new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
    return handleTargetApiError(errorResponse, 'Passthrough upstream', { url: upstreamUrl, body: bodyText.slice(0, 300) });
  }

  logPipelineHeaders(logger, requestId, 'upstream-response', upstreamUrl, response.headers);
  recordResponseStatusCodeFromUpstream(response.status);
  recordUpstreamResponseToolCount(mode, 0);

  if (!response.ok) {
    let upstreamErrorBody = '';
    try {
      upstreamErrorBody = await response.text();
      logger.error(requestId, `Passthrough: upstream error (${response.status}): ${upstreamErrorBody.slice(0, 2000)}`);
    } catch {
      upstreamErrorBody = '(failed to read response body)';
    }
    return handleTargetApiError(response, 'Passthrough upstream', { url: upstreamUrl, body: bodyText.slice(0, 300), upstreamBody: upstreamErrorBody });
  }

  // Capture rate limit headers
  const modelForRateLimit = (body.model as string) || 'unknown';
  recordUpstreamRateLimit(modelForRateLimit, (name) => response.headers.get(name), upstreamUrl);

  const contentType = response.headers.get('content-type') || '';
  const isEventStream = contentType.includes('text/event-stream');
  const modelUsageRecordUrl = proxyConfig.remote?.record_server?.trim();
  const modelUsageRecordBody = proxyConfig.remote?.record_response_body === true;

  // Usage recording key: body.model (since no route model is resolved)
  const usageModelKey = (body.model as string) || 'unknown';

  if (isEventStream && response.body) {
    logger.debug(requestId, `[Passthrough] ${upstreamUrl}: <streaming SSE, relaying with usage tracking>`);

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

    // Pipe upstream -> usage tracker -> client
    const trackedResponse = new Response(
      response.body.pipeThrough(usageTrackingStream),
      {
        status: response.status,
        headers: sanitizeUpstreamResponseHeaders(response),
      }
    );

    logPipelineHeaders(logger, requestId, 'outbound', upstreamPath, trackedResponse.headers);
    return trackedResponse;
  }

  // Non-streaming: read body, record usage, return
  if (response.body) {
    const text = await response.text();
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

    const outboundHeaders = sanitizeUpstreamResponseHeaders(response);
    logPipelineHeaders(logger, requestId, 'outbound', upstreamPath, outboundHeaders);
    return new Response(text, {
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