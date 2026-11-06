/**
 * Models API handler for Claude Proxy v3
 *
 * Handles GET /v1/models endpoint with caching support
 */

import { Logger } from '../utils/logger.js';
import type { OpenAIModelsResponse } from '../types/openai.js';
import { mergeOpenAIModelsResponse } from '../converters/openai-to-claude.js';
import { validateModelsRequestParams } from '../utils/validation.js';
import { createErrorResponse, handleTargetApiError } from '../utils/errors.js';
import { addForwardedHeaders } from '../utils/routing.js';
import { createUpstreamAbortSignal, getUpstreamBodyTimeoutMs } from '../utils/fetch-timeout.js';
import { receiveJsonResponse, withResponseText } from '../utils/spool-response.js';

// In-memory cache for model list
interface CacheEntry {
  data: OpenAIModelsResponse;
  timestamp: number;
}

const modelCache: Map<string, CacheEntry> = new Map();

// Default cache TTL in milliseconds (300 seconds)
const DEFAULT_CACHE_TTL_MS = 300 * 1000;

/**
 * Get cache TTL from environment or use default
 */
function getCacheTTL(env?: Record<string, unknown>): number {
  const envValue = env?.MODELS_CACHE_TTL as string | undefined;
  if (envValue !== undefined) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed * 1000; // Convert seconds to milliseconds
    }
  }
  return DEFAULT_CACHE_TTL_MS;
}

/**
 * Check if cache is valid
 */
function isCacheValid(entry: CacheEntry, ttl: number): boolean {
  return Date.now() - entry.timestamp < ttl;
}

/**
 * Get cached model list
 */
export function getCachedModels(ttl: number): OpenAIModelsResponse | null {
  const entry = modelCache.get('models');
  if (entry && isCacheValid(entry, ttl)) {
    return entry.data;
  }
  return null;
}

/**
 * Set cached model list
 */
export function setCachedModels(data: OpenAIModelsResponse): void {
  modelCache.set('models', {
    data,
    timestamp: Date.now(),
  });
}

/**
 * Clear model cache (useful for testing)
 */
export function clearModelCache(): void {
  modelCache.clear();
}

/**
 * Get model count from cache
 * Returns null if cache is invalid or empty
 */
export function getCachedModelCount(env?: Record<string, unknown>): number | null {
  const cacheTTL = getCacheTTL(env);
  const cachedModels = getCachedModels(cacheTTL);
  if (cachedModels && cachedModels.data) {
    return cachedModels.data.length;
  }
  return null;
}

/**
 * Get model count by fetching from upstream if needed
 * Returns { count: number, cached: boolean }
 */
export async function getModelCount(
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  logger: Logger,
  env?: Record<string, unknown>
): Promise<{ count: number; cached: boolean }> {
  // Check cache first
  const cachedCount = getCachedModelCount(env);
  if (cachedCount !== null) {
    return { count: cachedCount, cached: true };
  }

  // Cache miss - fetch from upstream
  logger.debug(requestId, `Fetching model list from upstream for count: ${targetUrl}`);

  try {
    // One signal for the GET and for the receive below: this path takes no
    // `Request`, so there is no client signal to hand the §5.9 wait.
    const signal = createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env));

    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      signal,
    });

    if (!response.ok) {
      logger.error(requestId, `Failed to fetch models: ${response.status}`);
      return { count: 0, cached: false };
    }

    // §5.7: one bounded receive — above `threshold_bytes` the body lives on this
    // response's spill while it is received, and `max_response_bytes` caps it.
    // The catch below reports a cap or a spill failure at error level and returns
    // a count of 0, which this function's only caller answers as its usual 404 —
    // logged rather than silent, but not distinguishable to the client from an
    // upstream that answered with an empty list. Left as it is: this function's
    // contract is a count, and its caller treats 0 and a throw alike.
    const openaiResponse = await receiveJsonResponse<OpenAIModelsResponse>(
      response, requestId, logger, targetUrl, signal,
    );
    const mergedResponse = mergeOpenAIModelsResponse(openaiResponse, []);

    // Cache the response
    setCachedModels(mergedResponse);

    return { count: mergedResponse.data.length, cached: false };
  } catch (error) {
    logger.error(requestId, `Error fetching model count: ${(error as Error).message}`);
    return { count: 0, cached: false };
  }
}

/**
 * Handle models API request
 */
export async function handleModelsRequest(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  logger: Logger,
  env?: Record<string, unknown>,
  extraModelIds: string[] = []
): Promise<Response> {
  // Parse query parameters
  const url = new URL(request.url);
  const afterId = url.searchParams.get('after_id') || undefined;
  const beforeId = url.searchParams.get('before_id') || undefined;
  const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : undefined;

  // Validate parameters
  validateModelsRequestParams({ after_id: afterId, before_id: beforeId, limit });

  const cacheTTL = getCacheTTL(env);

  // Check if we have valid cached data (only for first page requests without pagination)
  if (!afterId && !beforeId && !limit) {
    const cachedModels = getCachedModels(cacheTTL);
    if (cachedModels) {
      logger.debug(requestId, `Using cached model list (TTL: ${cacheTTL}ms)`);
      const mergedCachedModels = mergeOpenAIModelsResponse(cachedModels, extraModelIds);
      return new Response(JSON.stringify(mergedCachedModels), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': requestId,
          'x-cache': 'HIT',
        },
      });
    }
  }

  logger.debug(requestId, `Cache miss or invalid, fetching from upstream: ${targetUrl}`);

  let upstreamModels: OpenAIModelsResponse = { object: "list", data: [] };

  try {
    // Build target API URL with query parameters
    const targetApiUrl = new URL(targetUrl);
    if (afterId) targetApiUrl.searchParams.set('after', afterId);
    if (beforeId) targetApiUrl.searchParams.set('before', beforeId);
    if (limit) targetApiUrl.searchParams.set('limit', limit.toString());

    // Log upstream request headers (without auth keys for security)
    logger.debug(requestId, `Upstream request URL: ${targetApiUrl.toString()}`);
    logger.debug(requestId, `Has auth headers: ${!!authHeaders['Authorization'] || !!authHeaders['x-api-key']}`);

    // Make request to target API
    const response = await fetch(targetApiUrl.toString(), {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        ...addForwardedHeaders(authHeaders, request),
      },
      signal: createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env)),
    });

    // Handle target API errors. §5.7: the error body is bounded exactly as the
    // success body below is — one receive, `max_response_bytes` applied. A cap
    // breach, a spill write failure or a §5.9 refusal is the proxy's own limit,
    // and the outer catch below would turn it into the config-only model list:
    // a smaller success standing in for a failure (rule #8), so it is answered
    // here as itself instead.
    if (!response.ok) {
      let upstreamErrorBody: string;
      try {
        upstreamErrorBody = await withResponseText(
          response,
          requestId,
          logger,
          targetApiUrl.toString(),
          (text) => text,
          request.signal,
        );
      } catch (error) {
        return createErrorResponse(error as Error, requestId);
      }
      handleTargetApiError(response, 'Models API', { url: targetApiUrl.toString(), upstreamBody: upstreamErrorBody });
    }

    // Parse target API response. §5.7: one bounded receive — above
    // `threshold_bytes` the body lives on this response's spill while it is
    // received, and `max_response_bytes` caps it.
    //
    // The inner catch is deliberately this narrow. A body that is not JSON keeps
    // this endpoint's existing degradation (the outer catch below answers with the
    // config-only list), but a §5.7 cap, a spill write failure or a §5.9 refusal
    // is the proxy's own limit and must surface as itself — the outer catch would
    // turn it into a silently smaller model list (rule #8).
    let openaiResponse: OpenAIModelsResponse;
    try {
      openaiResponse = await receiveJsonResponse<OpenAIModelsResponse>(
        response,
        requestId,
        logger,
        targetApiUrl.toString(),
        request.signal,
      );
    } catch (error) {
      if (!(error instanceof SyntaxError)) return createErrorResponse(error as Error, requestId);
      throw error;
    }
    upstreamModels = mergeOpenAIModelsResponse(openaiResponse, []);

    // Cache the response (only for non-paginated requests)
    if (!afterId && !beforeId && !limit) {
      setCachedModels(upstreamModels);
    }
  } catch (error) {
    logger.warn(requestId, `Upstream models fetch failed, returning config-only models: ${(error as Error).message}`);
  }

  const finalResponse = mergeOpenAIModelsResponse(upstreamModels, extraModelIds);

  // Return response with OpenAI headers
  return new Response(JSON.stringify(finalResponse), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'x-request-id': requestId,
      'x-cache': 'MISS',
    },
  });
}

/**
 * Anthropic Model Discovery shape (per Claude Code Gateway spec)
 */
export interface AnthropicModel {
  id: string;
  display_name?: string;
  description?: string;
}

export interface AnthropicModelsResponse {
  object: 'list';
  data: AnthropicModel[];
}

/**
 * Per the Claude Code gateway spec, discovery keeps only entries whose id
 * contains `claude` or `anthropic` anywhere (case-insensitive).
 */
export function isAnthropicModelId(id: string): boolean {
  const idLower = id.toLowerCase();
  return idLower.includes('claude') || idLower.includes('anthropic');
}

/** Map one upstream model entry to the Anthropic discovery shape. */
export function toAnthropicModel(model: any): AnthropicModel | null {
  if (!model || typeof model.id !== 'string') return null;
  return {
    id: model.id,
    display_name: model.display_name || model.id,
    description: model.description,
  };
}

/**
 * Check if Anthropic model discovery is enabled via environment variable
 */
export function isAnthropicModelDiscoveryEnabled(env?: Record<string, unknown>): boolean {
  const value = env?.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY as string | undefined;
  return value === '1' || value === 'true';
}

/**
 * Handle Anthropic-format model discovery request
 * Per spec: GET /v1/models?limit=1000, 3s timeout, redirect=error
 * Filters to models with 'claude' or 'anthropic' in id (case-insensitive)
 * Forwards both Authorization and x-api-key headers to upstream
 */
export async function handleAnthropicModelsDiscovery(
  request: Request,
  targetUrl: string,
  authHeaders: Record<string, string>,
  requestId: string,
  logger: Logger,
  env?: Record<string, unknown>
): Promise<Response> {
  // Check if discovery is enabled
  if (!isAnthropicModelDiscoveryEnabled(env)) {
    return new Response(JSON.stringify({ object: 'list', data: [] }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
    });
  }

  logger.debug(requestId, `Anthropic model discovery request to: ${targetUrl}`);

  // Build target API URL with limit=1000 as per spec
  const targetApiUrl = new URL(targetUrl);
  targetApiUrl.searchParams.set('limit', '1000');

  // Extract credentials from incoming request (both Authorization and x-api-key)
  // Per spec: Claude Code sends both, omitting ones that don't resolve
  const authHeader = request.headers.get('Authorization');
  const apiKeyHeader = request.headers.get('x-api-key');

  const upstreamHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Forward both headers if present (upstream model discovery endpoint needs them)
  if (authHeader) {
    upstreamHeaders['Authorization'] = authHeader;
  }
  if (apiKeyHeader) {
    upstreamHeaders['x-api-key'] = apiKeyHeader;
  }

  // Also include any auth headers that were already extracted (for backward compat)
  if (authHeaders['Authorization'] && !upstreamHeaders['Authorization']) {
    upstreamHeaders['Authorization'] = authHeaders['Authorization'];
  }
  if (authHeaders['x-api-key'] && !upstreamHeaders['x-api-key']) {
    upstreamHeaders['x-api-key'] = authHeaders['x-api-key'];
  }

  // 3 second timeout as per spec
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 3000);

  try {
    const response = await fetch(targetApiUrl.toString(), {
      method: 'GET',
      headers: upstreamHeaders,
      signal: controller.signal,
      redirect: 'error', // Treat redirect as failure per spec
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      // §5.7: the error body is received through the same bounded path as the
      // success body below, so `max_response_bytes` bounds it too. This
      // function's own catch-all would report a spool limit as a generic
      // `internal_error`, i.e. as "model discovery failed" — so the limit is
      // answered here as itself (rule #8).
      let errorText: string;
      try {
        errorText = await withResponseText(
          response,
          requestId,
          logger,
          targetApiUrl.toString(),
          (text) => text,
          request.signal,
        );
      } catch (error) {
        return createErrorResponse(error as Error, requestId);
      }
      logger.error(requestId, `Upstream model discovery failed: ${response.status} ${errorText}`);
      // Return error to client rather than silently degraded list
      return new Response(JSON.stringify({
        error: {
          type: 'upstream_error',
          message: `Model discovery failed: ${response.status} ${errorText}`,
        },
      }), {
        status: response.status,
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': requestId,
        },
      });
    }

    // §5.7: one bounded receive — above `threshold_bytes` the body lives on this
    // response's spill while it is received, and `max_response_bytes` caps it.
    // Same split as `handleModelsRequest`: a malformed body keeps this handler's
    // existing 500 `internal_error` (via the catch below), while a cap, a write
    // failure or a §5.9 refusal surfaces as itself rather than as a 500 that
    // claims the upstream broke (rule #8).
    let upstreamResponse: any;
    try {
      upstreamResponse = await receiveJsonResponse<any>(
        response,
        requestId,
        logger,
        targetApiUrl.toString(),
        request.signal,
      );
    } catch (error) {
      if (!(error instanceof SyntaxError)) return createErrorResponse(error as Error, requestId);
      throw error;
    }

    // Transform to Anthropic shape and filter
    let rawModels: any[] = [];

    // Handle different upstream response formats
    if (upstreamResponse.data && Array.isArray(upstreamResponse.data)) {
      // OpenAI format: { object: 'list', data: [{ id, ... }] }
      rawModels = upstreamResponse.data;
    } else if (Array.isArray(upstreamResponse)) {
      // Direct array format
      rawModels = upstreamResponse;
    } else if (upstreamResponse.models && Array.isArray(upstreamResponse.models)) {
      // Some providers use { models: [...] }
      rawModels = upstreamResponse.models;
    }

    const models = rawModels
      .map(toAnthropicModel)
      .filter((model): model is AnthropicModel => model !== null);

    // Filter: keep only models with 'claude' or 'anthropic' in id (case-insensitive)
    const filteredModels = models.filter((model) => isAnthropicModelId(model.id));

    logger.debug(requestId, `Model discovery: ${models.length} upstream models, ${filteredModels.length} after filter`);

    const anthropicResponse: AnthropicModelsResponse = {
      object: 'list',
      data: filteredModels,
    };

    return new Response(JSON.stringify(anthropicResponse), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
    });
  } catch (error) {
    clearTimeout(timeoutId);

    // Handle specific error types
    if (error instanceof DOMException && error.name === 'AbortError') {
      logger.error(requestId, 'Model discovery timed out after 3s');
      return new Response(JSON.stringify({
        error: {
          type: 'timeout',
          message: 'Model discovery timed out after 3 seconds',
        },
      }), {
        status: 504,
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': requestId,
        },
      });
    }

    if (error instanceof TypeError && error.message.includes('redirect')) {
      logger.error(requestId, 'Model discovery redirect treated as failure');
      return new Response(JSON.stringify({
        error: {
          type: 'redirect_failed',
          message: 'Model discovery redirect not allowed',
        },
      }), {
        status: 502,
        headers: {
          'Content-Type': 'application/json',
          'x-request-id': requestId,
        },
      });
    }

    logger.error(requestId, `Model discovery error: ${(error as Error).message}`);
    return new Response(JSON.stringify({
      error: {
        type: 'internal_error',
        message: 'Model discovery failed',
      },
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'x-request-id': requestId,
      },
    });
  }
}
