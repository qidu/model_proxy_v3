/**
 * Main router and middleware for Claude Proxy v3
 *
 * Handles dynamic routing to target APIs and converts between Claude and OpenAI formats.
 * Also supports Gemini API bypass mode for direct Gemini API access.
 */

import { Env } from './types/shared.js';
import { extractAuthHeaders, transformAuthHeadersForUpstream, formatApiKeyForUpstream, parseDynamicRoute, isHostAllowed, getHandlerType, buildTargetUrl, buildUpstreamUrl, sanitizeUpstreamResponseHeaders, getSidecarForwardedHeaders } from './utils/routing.js';
import { createErrorResponse, OverLimitError, ClaudeProxyError, classifyTransportError, extractUpstreamMessage } from './utils/errors.js';
import { createLogger, type Logger } from './utils/logger.js';
import { handleModelsRequest, getModelCount } from './handlers/models.js';
import { handleTokenCountingRequest } from './handlers/token-counting.js';
import { handleMessagesRequest } from './handlers/messages.js';
import { handleResponsesRequest, handleResponsesCompactRequest, handleResponsesInputTokensRequest, handleResponsesRetrievalRequest } from './handlers/responses.js';
import { handleGeminiRequest, handleGeminiRequestForMessages } from './handlers/gemini.js';
import { handleOpenAIRequest } from './handlers/openai.js';
import { handleClaudeRequest } from './handlers/claude.js';
import { handleEmbeddingsRequest } from './handlers/embeddings.js';
import { handleChatCompletionsPassthrough } from './handlers/chat-completions.js';
import {
  handleDashboardAgentStats,
  handleDashboardAddScheduleAlias,
  handleDashboardGetConfig,
  handleDashboardGlobalTokenLimit,
  handleDashboardModelStats,
  handleDashboardModelQuota,
  handleDashboardPage,
  handleDashboardPutConfig,
  handleDashboardRemoveScheduleAlias,
  handleDashboardRemoveScheduleTarget,
  handleDashboardRequestStats,
  handleDashboardTestModel,
  handleDashboardToggleToolBlock,
  handleDashboardToolBlocklist,
  handleDashboardUpsertModelTarget,
  handleDashboardUpsertScheduleTarget,
} from './handlers/dashboard.js';
import { loadProxyConfig, clearProxyConfigCache, dumpProxyConfigToml, getConfiguredModelIds, getModelRouteConfig, getCompositeRouteCandidates, getCompositeAliasMode, resolveFusionPlan, resolveCoordinatorPlan, FusionPlan, ModelRouteConfig, ProxyConfig, CompositeRouteCandidate, CompositeTargetConfig, parseHumanTokenLimit, getAllowedHostsFromConfig, resolveScheduleTarget } from './utils/config-loader.js';
import { detectCoordinatorStage } from './utils/coordinator.js';
import {
  extractToolNamesFromBody,
  extractToolRequestCharLengthsFromBody,
  extractToolNamesFromResponsePayload,
  extractUsageFromResponsePayload,
  extractUserAgentPrefix,
  resolveAgentName,
  type ResolvedAgent,
  createResponseToolTrackingTransformStream,
  recordAgentStat,
  recordModelStat,
  recordToolRequestChars,
  recordUpstreamResponseToolNames,
  recordModelFailedRequest,
  recordModelUsage,
  recordRequestEndpoint,
  recordRequestTiming,
  recordModelTiming,
  recordResponseStatusCodeFromUpstream,
  recordResponseStatusCodeToEndpoint,
  recordResponseUpstream,
  createUsageTrackingTransformStream,
  getCompositeAliasTokenUsage,
  recordCompositeTokenUsage,
  compositeAliasStates,
  updateCompositeAliasReverseMap,
  setCompositeLimit,
  clearCompositeLimit,
  parseWindowSpec,
  getWindowCutoff,
  setWeekStartDay,
  incrementActiveRequests,
  attachActiveRequestRelease,
  getTokensInWindow,
  getTokensInWindowSince,
  recordPrivacyKeysDetected,
} from './utils/dashboard-stats.js';
import { ThinkingConversionOptions } from './converters/claude-to-openai.js';
import {
  getPrivacyFilterConfig,
  redactBody,
  restoreText,
  createRestoreTransformStream,
  PiiMapping,
} from './utils/privacy-filter.js';
import { getKompressConfig, shouldCompressPath, compressBody } from './utils/kompress.js';
import { eraseBlockedTools } from './utils/tool-blocklist.js';
import { buildModelUsageRecordPayload, recordModelUsageToRemote } from './utils/model-usage-recorder.js';
import { runHook, applyWriteoutBody, pipeEventTransformer, formatTransformsDebug, type HookContext } from './utils/request-transform.js';

let hasLoggedUpstreamConfig = false;

const compositeEffectiveShares = new Map<string, number>();

function getConfiguredCompositeShare(targetConfig: CompositeTargetConfig): number {
  return typeof targetConfig.share === 'number' && targetConfig.share > 0 ? targetConfig.share : 1;
}

function compositeShareKey(alias: string, targetModel: string): string {
  return `${alias}\u0000${targetModel}`;
}

export function getEffectiveCompositeShare(alias: string, targetModel: string, configuredShare: number): number {
  return compositeEffectiveShares.get(compositeShareKey(alias, targetModel)) ?? configuredShare;
}

export function decayEffectiveCompositeShare(alias: string, targetModel: string, configuredShare: number): { previous: number; next: number; floor: number } {
  const normalizedShare = configuredShare > 0 ? configuredShare : 1;
  const previous = getEffectiveCompositeShare(alias, targetModel, normalizedShare);
  const floor = normalizedShare / 10;
  const next = Math.max(floor, previous / 2);
  compositeEffectiveShares.set(compositeShareKey(alias, targetModel), next);
  return { previous, next, floor };
}

export function recoverEffectiveCompositeShare(alias: string, targetModel: string, configuredShare: number): { previous: number; next: number; cap: number } {
  const normalizedShare = configuredShare > 0 ? configuredShare : 1;
  const previous = getEffectiveCompositeShare(alias, targetModel, normalizedShare);
  const next = Math.min(normalizedShare, previous * 2);
  if (next !== previous) {
    compositeEffectiveShares.set(compositeShareKey(alias, targetModel), next);
  }
  return { previous, next, cap: normalizedShare };
}

export function resetEffectiveCompositeSharesForTest(): void {
  compositeEffectiveShares.clear();
}

function selectWeightedCompositeCandidate<T>(candidates: T[], getWeight: (candidate: T) => number): T | undefined {
  const totalWeight = candidates.reduce((sum, candidate) => sum + Math.max(0, getWeight(candidate)), 0);
  if (totalWeight <= 0) return candidates[0];

  let remaining = Math.random() * totalWeight;
  for (const candidate of candidates) {
    remaining -= Math.max(0, getWeight(candidate));
    if (remaining <= 0) return candidate;
  }
  return candidates[candidates.length - 1];
}

function orderCompositeCandidatesForRuntimeShare(alias: string, candidates: CompositeRouteCandidate[]): CompositeRouteCandidate[] {
  const primary = candidates.find(candidate => candidate.targetConfig.primary);
  if (primary) {
    const configuredShare = getConfiguredCompositeShare(primary.targetConfig);
    const effectiveShare = getEffectiveCompositeShare(alias, primary.modelName, configuredShare);
    if (effectiveShare >= configuredShare) return candidates;

    const first = selectWeightedCompositeCandidate(candidates, candidate =>
      candidate === primary ? effectiveShare : getConfiguredCompositeShare(candidate.targetConfig)
    );
    return first ? [first, ...candidates.filter(candidate => candidate !== first)] : candidates;
  }

  // Fallback-only alias: candidates are pre-sorted by fallback number ascending.
  // If any fallback target has decayed, reorder using weighted selection among
  // fallback-numbered candidates so a degraded first-fallback can be skipped.
  const fallbackCandidates = candidates.filter(candidate =>
    typeof candidate.targetConfig.fallback === 'number' && candidate.targetConfig.fallback > 0
  );
  if (fallbackCandidates.length < 2) return candidates;

  const anyDecayed = fallbackCandidates.some(candidate => {
    const configured = getConfiguredCompositeShare(candidate.targetConfig);
    return getEffectiveCompositeShare(alias, candidate.modelName, configured) < configured;
  });
  if (!anyDecayed) return candidates;

  const first = selectWeightedCompositeCandidate(fallbackCandidates, candidate => {
    const configured = getConfiguredCompositeShare(candidate.targetConfig);
    return getEffectiveCompositeShare(alias, candidate.modelName, configured);
  });
  if (!first) return candidates;
  const rest = candidates.filter(candidate => candidate !== first);
  return [first, ...rest];
}

/**
 * Generate a unique request ID using a cryptographically secure source.
 * Format: req_<unix_ms>_<uuid>
 *
 * Uses crypto.randomUUID(), which is available in:
 *   - Cloudflare Workers
 *   - Node.js >=19 (global Web Crypto)
 *   - Modern browsers
 */
function generateRequestId(): string {
  return `req_${Date.now()}_${crypto.randomUUID()}`;
}

/**
 * Restore PII sentinels back to their original values in a client-facing
 * response. Handles JSON (buffered) and text/event-stream (transform) bodies.
 * Returns the response unchanged when the mapping is empty.
 */
async function restorePrivacyResponse(
  response: Response,
  mapping: PiiMapping,
  requestId: string,
  logger: Logger,
): Promise<Response> {
  if (Object.keys(mapping).length === 0) return response;
  const contentType = response.headers.get('content-type') || '';
  const sentinelKeys = Object.keys(mapping);
  logger.debug(requestId, `[PII-RESTORE] mapping size=${sentinelKeys.length}, content-type=${contentType || '-'}, sentinels=${JSON.stringify(sentinelKeys)}`);

  if (contentType.includes('text/event-stream') && response.body) {
    logger.debug(requestId, `[PII-RESTORE] streaming restore via transform stream`);
    return new Response(response.body.pipeThrough(createRestoreTransformStream(mapping)), {
      status: response.status,
      statusText: response.statusText,
      headers: sanitizeUpstreamResponseHeaders(response),
    });
  }

  if (contentType.includes('application/json')) {
    const text = await response.text();
    const restored = restoreText(text, mapping);
    logger.debug(requestId, `[PII-RESTORE] json restore: body ${text.length} -> ${restored.length} chars`);
    // restored text length differs from the redacted body; and the upstream
    // body has already been decompressed by .text(), so content-encoding no
    // longer matches. Strip both via sanitizeUpstreamResponseHeaders.
    return new Response(restored, {
      status: response.status,
      statusText: response.statusText,
      headers: sanitizeUpstreamResponseHeaders(response),
    });
  }

  // Fallback: treat any other content-type as text and restore sentinels.
  // This catches text/plain, text/html, empty content-type, etc.
  if (response.body) {
    const text = await response.text();
    const restored = restoreText(text, mapping);
    logger.debug(requestId, `[PII-RESTORE] text restore: body ${text.length} -> ${restored.length} chars`);
    return new Response(restored, {
      status: response.status,
      statusText: response.statusText,
      headers: sanitizeUpstreamResponseHeaders(response),
    });
  }

  return response;
}

/**
 * Get CORS origin based on environment configuration
 */
function getCorsOrigin(request: Request, env: Env): string {
  const requestOrigin = request.headers.get('origin');
  const isLocalhostOrigin = requestOrigin === 'http://localhost' ||
    requestOrigin === 'https://localhost' ||
    requestOrigin?.startsWith('http://localhost:') ||
    requestOrigin?.startsWith('https://localhost:') ||
    requestOrigin === 'http://127.0.0.1' ||
    requestOrigin === 'https://127.0.0.1' ||
    requestOrigin?.startsWith('http://127.0.0.1:') ||
    requestOrigin?.startsWith('https://127.0.0.1:');

  // Always allow localhost origins for local dashboard/API usage.
  if (isLocalhostOrigin && requestOrigin) {
    return requestOrigin;
  }

  // Development mode: allow all origins
  if (env.DEV_MODE === 'true' || env.DEV_MODE === '1') {
    return '*';
  }

  // Check if allowed origins are configured
  const allowedOrigins = env.ALLOWED_ORIGINS;
  if (!allowedOrigins) {
    // No configuration - be restrictive in production
    if (requestOrigin) {
      // In production without ALLOWED_ORIGINS, only allow the request's origin
      // This is a safe middle ground
      return requestOrigin;
    }
    return 'null'; // No origin header (e.g., curl requests)
  }

  // Parse allowed origins list
  const allowedList = (allowedOrigins as string).split(',').map((o: string) => o.trim());

  // If wildcard is in the list, allow all
  if (allowedList.includes('*')) {
    return '*';
  }

  // Check if request origin is in the allowed list
  if (requestOrigin && allowedList.includes(requestOrigin)) {
    return requestOrigin;
  }

  // Origin not allowed - return first allowed origin (or null for same-origin requests)
  return allowedList[0] || 'null';
}

/**
 * Get CORS headers configuration
 */
function getCorsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = getCorsOrigin(request, env);

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, x-goog-api-key, anthropic-beta',
    'Access-Control-Max-Age': '0',
  };
}

/**
 * Apply CORS headers to response
 */
function applyCorsHeaders(response: Response, request: Request, env: Env): Response {
  const newHeaders = sanitizeUpstreamResponseHeaders(response);
  const corsHeaders = getCorsHeaders(request, env);

  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

function getRawEndpointUserKey(authHeaders: Record<string, string>): string {
  const authorization = authHeaders['Authorization'] || authHeaders['authorization'];
  if (authorization) {
    return authorization.replace(/^Bearer\s+/i, '');
  }
  return authHeaders['x-goog-api-key'] || '';
}

function validateDashboardApiAuth(request: Request, proxyConfig: ProxyConfig): Response | null {
  const dashboardApiKey = proxyConfig.dashboard?.api_key?.trim();
  if (!dashboardApiKey) {
    return null;
  }

  const authHeader = request.headers.get('authorization') || '';
  if (authHeader !== `Bearer ${dashboardApiKey}`) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return null;
}

/**
 * Handle OPTIONS requests for CORS preflight
 */
function handleOptionsRequest(request: Request, env: Env): Response {
  const corsHeaders = getCorsHeaders(request, env);

  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

/**
 * Check if URL uses dynamic routing (starts with /http/ or /https/)
 */
function isDynamicRoute(path: string): boolean {
  return path.startsWith('/http/') || path.startsWith('/https/');
}

/**
 * Parse fixed route and return target configuration
 * Fixed route: /v1/messages -> /v1/chat/completions
 * Uses [models.default] and [default_upstream] from proxy_config.toml
 */
function parseFixedRoute(path: string, proxyConfig: ProxyConfig, env: Env): {
  targetUrl: string;
  targetEndpoint: string;
  handlerType: 'messages' | 'interactions' | 'generateContent' | 'models' | 'token-counting' | 'responses' | 'responses-compact' | 'responses-input-tokens' | 'embeddings' | 'chat-completions';
  upstreamMode?: string;
  modelId?: string;
  forceStreaming?: boolean;
} {
  // Get default config from [models.default] or [default_upstream]
  const defaultCategory = proxyConfig.models?.default;
  const defaultCategoryConfig = defaultCategory && !Array.isArray(defaultCategory) ? defaultCategory : undefined;
  const defaultMode = defaultCategoryConfig?.upstream_mode || 
                      proxyConfig.default_upstream?.upstream_mode || 
                      'openai-completions';
  const defaultBaseUrl = defaultCategoryConfig?.base_url || 
                        proxyConfig.default_upstream?.default_base_url;

  // 1. /v1/messages → multiple upstream modes
  if (path === '/v1/messages' || path.startsWith('/v1/messages?')) {
    if (defaultMode === 'anthropic-messages') {
      // Native Claude API
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/messages'),
        targetEndpoint: 'v1/messages',
        handlerType: 'messages',
        upstreamMode: 'anthropic-messages',
      };
    } else if (defaultMode === 'gemini-generatecontent' || defaultMode === 'gemini-interactions') {
      // Native Gemini API - not typically used for /v1/messages but supported
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1beta/models'),
        targetEndpoint: 'v1/messages',
        handlerType: 'messages',
        upstreamMode: defaultMode,
      };
    } else if (defaultMode === 'openai-responses') {
      // OpenAI Responses API upstream
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/responses'),
        targetEndpoint: 'v1/messages',
        handlerType: 'messages',
        upstreamMode: 'openai-responses',
      };
    } else {
      // OpenAI-compatible upstream
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/chat/completions'),
        targetEndpoint: 'v1/messages',
        handlerType: 'messages',
        upstreamMode: 'openai-completions',
      };
    }
  }

  // 2. /v1/interactions → multiple upstream modes
  if (path === '/v1/interactions' || path.startsWith('/v1/interactions?')) {
    if (defaultMode === 'gemini-generatecontent' || defaultMode === 'gemini-interactions') {
      // Native Gemini API
      const apiVersion = env.GEMINI_API_VERSION || 'v1beta';
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', apiVersion),
        targetEndpoint: 'v1/interactions',
        handlerType: 'interactions',
        upstreamMode: defaultMode,
      };
    } else if (defaultMode === 'anthropic-messages') {
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/messages'),
        targetEndpoint: 'v1/interactions',
        handlerType: 'interactions',
        upstreamMode: 'anthropic-messages',
      };
    } else if (defaultMode === 'openai-responses') {
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/responses'),
        targetEndpoint: 'v1/interactions',
        handlerType: 'interactions',
        upstreamMode: 'openai-responses',
      };
    } else {
      // OpenAI-compatible upstream
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/chat/completions'),
        targetEndpoint: 'v1/interactions',
        handlerType: 'interactions',
        upstreamMode: 'openai-completions',
      };
    }
  }

  // 3a. /v1beta/models/{model}:countTokens → forward to Gemini upstream
  if ((path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && path.includes(':countTokens')) {
    const modelMatch = path.match(/\/(v1beta|v1)\/models\/([^:?]+):countTokens/);
    const modelId = modelMatch ? decodeURIComponent(modelMatch[2]) : 'gemini-no-id-at-proxy';
    const safeModelId = encodeURIComponent(modelId);
    const apiVersion = env.GEMINI_API_VERSION || 'v1beta';
    if (defaultMode === 'gemini-generatecontent' || defaultMode === 'gemini-interactions') {
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', `${apiVersion}/models/${safeModelId}:countTokens`),
        targetEndpoint: 'v1beta/models/countTokens',
        handlerType: 'generateContent',
        upstreamMode: defaultMode,
        modelId,
      };
    } else {
      // countTokens has no OpenAI equivalent — proxy the request upstream as-is and return the raw JSON.
      // The handler will fall through to handleOpenAIRequest which passes the body through.
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/messages/count_tokens'),
        targetEndpoint: 'v1beta/models/countTokens',
        handlerType: 'token-counting',
        upstreamMode: 'openai-completions',
        modelId,
      };
    }
  }

  // 3. /v1beta/models/{model}:generateContent or :streamGenerateContent → multiple upstream modes
  // Also support /v1/models/{model}:generateContent (some Gemini APIs use v1 instead of v1beta)
  if ((path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && (path.includes(':generateContent') || path.includes(':streamGenerateContent'))) {
    const modelMatch = path.match(/\/(v1beta|v1)\/models\/([^:?]+):(stream)?[Gg]enerateContent/);
    const modelId = modelMatch ? decodeURIComponent(modelMatch[2]) : 'gemini-no-id-at-proxy';
    const safeModelId = encodeURIComponent(modelId);
    const isStreamEndpoint = path.includes(':streamGenerateContent');
    
    if (defaultMode === 'gemini-generatecontent' || defaultMode === 'gemini-interactions') {
      // Native Gemini - pass through the exact endpoint
      const apiVersion = env.GEMINI_API_VERSION || 'v1beta';
      const endpoint = isStreamEndpoint ? 'streamGenerateContent' : 'generateContent';
      // Preserve query string if present, or add ?alt=sse for streamGenerateContent
      let queryString = path.includes('?') ? path.substring(path.indexOf('?')) : '';
      if (isStreamEndpoint && !queryString.includes('alt=sse')) {
        queryString = queryString ? `${queryString}&alt=sse` : '?alt=sse';
      }
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', `${apiVersion}/models/${safeModelId}:${endpoint}${queryString}`),
        targetEndpoint: `v1beta/models/${endpoint}`,
        handlerType: 'generateContent',
        upstreamMode: defaultMode,
        modelId,
      };
    } else if (defaultMode === 'anthropic-messages') {
      // Route through openai-completions transforming: handler converts
      // generateContent body → openai-completions → anthropic-messages.
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/messages'),
        targetEndpoint: 'v1beta/models/generateContent',
        handlerType: 'generateContent',
        upstreamMode: 'anthropic-messages',
        modelId,
        forceStreaming: isStreamEndpoint,
      };
    } else if (defaultMode === 'openai-responses') {
      // Route through openai-completions transforming: handler converts
      // generateContent body → openai-completions → openai-responses.
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/responses'),
        targetEndpoint: 'v1beta/models/generateContent',
        handlerType: 'generateContent',
        upstreamMode: 'openai-responses',
        modelId,
        forceStreaming: isStreamEndpoint,
      };
    } else {
      // OpenAI-compatible upstream
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/chat/completions'),
        targetEndpoint: 'v1beta/models/generateContent',
        handlerType: 'generateContent',
        upstreamMode: 'openai-completions',
        modelId,
        forceStreaming: isStreamEndpoint,
      };
    }
  }

  // 4. /v1/chat/completions — passthrough
  if (path === '/v1/chat/completions' || path.startsWith('/v1/chat/completions?')) {
    if (defaultMode === 'openai-responses') {
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/responses'),
        targetEndpoint: 'v1/chat/completions',
        handlerType: 'chat-completions' as const,
        upstreamMode: 'openai-responses',
      };
    }
    return {
      targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/chat/completions'),
      targetEndpoint: 'v1/chat/completions',
      handlerType: 'chat-completions' as const,
      upstreamMode: 'openai-completions',
    };
  }

  // Token counting endpoint
  if (path === '/v1/messages/count_tokens' || path.startsWith('/v1/messages/count_tokens?')) {
    return {
      targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/messages/count_tokens'),
      targetEndpoint: 'v1/messages/count_tokens',
      handlerType: 'token-counting',
    };
  }

  // 5. /v1/responses/input_tokens → count input tokens
  if (path === '/v1/responses/input_tokens' || path.startsWith('/v1/responses/input_tokens?')) {
    if (defaultMode === 'openai-responses') {
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/responses/input_tokens'),
        targetEndpoint: 'v1/responses/input_tokens',
        handlerType: 'responses-input-tokens',
        upstreamMode: 'openai-responses',
      };
    } else {
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/chat/completions'),
        targetEndpoint: 'v1/responses/input_tokens',
        handlerType: 'responses-input-tokens',
        upstreamMode: 'openai-completions',
      };
    }
  }

  // 6. /v1/responses/compact → compact a conversation
  if (path === '/v1/responses/compact' || path.startsWith('/v1/responses/compact?')) {
    if (defaultMode === 'openai-responses') {
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/responses/compact'),
        targetEndpoint: 'v1/responses/compact',
        handlerType: 'responses-compact',
        upstreamMode: 'openai-responses',
      };
    } else {
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/chat/completions'),
        targetEndpoint: 'v1/responses/compact',
        handlerType: 'responses-compact',
        upstreamMode: 'openai-completions',
      };
    }
  }

  // 6. /v1/responses → multiple upstream modes
  if (path === '/v1/responses' || path.startsWith('/v1/responses?')) {
    if (defaultMode === 'openai-responses') {
      // Pass through to OpenAI Responses API
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/responses'),
        targetEndpoint: 'v1/responses',
        handlerType: 'responses',
        upstreamMode: 'openai-responses',
      };
    } else if (defaultMode === 'anthropic-messages') {
      // Convert Responses API to Claude Messages and forward to native Anthropic upstream
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/messages'),
        targetEndpoint: 'v1/responses',
        handlerType: 'responses',
        upstreamMode: 'anthropic-messages',
      };
    } else if (defaultMode === 'gemini-generatecontent' || defaultMode === 'gemini-interactions') {
      // Convert Responses API to Claude Messages and forward to Gemini upstream
      const apiVersion = env.GEMINI_API_VERSION || 'v1beta';
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', apiVersion),
        targetEndpoint: 'v1/responses',
        handlerType: 'responses',
        upstreamMode: defaultMode,
      };
    } else {
      // Convert to OpenAI Chat Completions
      return {
        targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/chat/completions'),
        targetEndpoint: 'v1/responses',
        handlerType: 'responses',
        upstreamMode: 'openai-completions',
      };
    }
  }

  // Models endpoint
  if (path === '/v1/models' || path.startsWith('/v1/models?')) {
    return {
      targetUrl: buildUpstreamUrl(defaultBaseUrl || '', 'v1/models'),
      targetEndpoint: 'v1/models',
      handlerType: 'models',
    };
  }

  // Embeddings endpoint — uses [models.EMBEDDING] / [models.embedding] config with priority over defaults
  if (path === '/v1/embeddings' || path.startsWith('/v1/embeddings?')) {
    const embeddingCategory = proxyConfig.models?.EMBEDDING ?? proxyConfig.models?.embedding;
    const embeddingConfig = embeddingCategory && !Array.isArray(embeddingCategory) ? embeddingCategory : undefined;
    const embeddingBaseUrl = embeddingConfig?.base_url || defaultBaseUrl;
    return {
      targetUrl: buildUpstreamUrl(embeddingBaseUrl || '', 'v1/embeddings'),
      targetEndpoint: 'v1/embeddings',
      handlerType: 'embeddings',
      upstreamMode: 'openai-completions',
    };
  }

  throw new Error(`Unsupported fixed route: ${path}`);
}

/**
 * Main request handler
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = generateRequestId();
    const logger = createLogger(env as Record<string, unknown>);
    const url = new URL(request.url);
    const path = url.pathname;

    // Debug: log all request headers
    // const headersObj: Record<string, string> = {};
    // request.headers.forEach((value, key) => { headersObj[key] = value; });
    // logger.debug(requestId, `Request headers: ${JSON.stringify(headersObj)}`);

    // Load proxy config on first request
    const configPath = env.PROXY_CONFIG_PATH;
    const configConsul = env.PROXY_CONFIG_CONSUL;
    const configApollo = env.PROXY_CONFIG_APOLLO;

    // Admin endpoints are restricted to loopback connections only.
    // server.ts injects the real socket address as x-client-address.
    const ADMIN_PATHS = ['/config-reload', '/dashboard'];
    const isAdminPath = ADMIN_PATHS.some(p => path === p || path.startsWith('/dashboard'));
    if (isAdminPath) {
      const clientAddr = request.headers.get('x-client-address') || '';
      const isLoopback = clientAddr === '127.0.0.1' || clientAddr === '::1' || clientAddr === 'localhost';
      if (!isLoopback) {
        return new Response(JSON.stringify({ error: 'Forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    if (path === '/config-reload') {
      logger.debug(requestId, `${path} Config path: ${configPath}, Consul: ${configConsul}, Apollo: ${configApollo}`);
      try {
        if (!env.PROXY_CONFIG_CONSUL && !env.PROXY_CONFIG_APOLLO) {
          throw new Error('no remote config source is set (PROXY_CONFIG_CONSUL or PROXY_CONFIG_APOLLO).');
        }

        clearProxyConfigCache();
        const proxyConfig = await loadProxyConfig(env);
        dumpProxyConfigToml(proxyConfig);

        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error) {
        // Log full error server-side (may include config URLs/paths); return generic
        // message to the client to avoid leaking internal filesystem or upstream details.
        logger.error(requestId, `${path} failed: ${(error as Error).message}`);
        return new Response(JSON.stringify({
          status: 'failed',
          error: 'Config reload failed; see server logs for details.',
        }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    const proxyConfig = await loadProxyConfig(env);
    const configuredModelIds = getConfiguredModelIds(proxyConfig);

    // Apply general.week_start_day to the windowing helper.
    setWeekStartDay(proxyConfig.general?.week_start_day === 'sunday' ? 'sunday' : 'monday');

    // Sync composite alias states from config: update reverse map and init/clear states.
    const composite = proxyConfig.composite || {};
    updateCompositeAliasReverseMap(composite);
    // setCompositeLimit preserves any existing per-alias event log, so reloads
    // (including post-restart state restored from JSONL) keep their history.
    for (const [alias, targets] of Object.entries(composite)) {
      if (targets.token_limit && typeof targets.token_limit === 'object') {
        const cfg = targets.token_limit;
        setCompositeLimit(alias, cfg.num, cfg.duration);
      } else {
        clearCompositeLimit(alias);
      }
    }
    // Clear states for aliases that no longer exist in config
    for (const alias of compositeAliasStates.keys()) {
      if (!(alias in composite)) {
        clearCompositeLimit(alias);
      }
    }

    let failedModelId: string | undefined;
    let modelFailureRecorded = false;
    let requestStartTime = 0;
    // Set once the request is counted as in-flight (after preflight checks). The
    // release is deferred onto the returned Response so server.ts can fire it when
    // the body finishes streaming, rather than when the handler returns.
    let releaseActiveRequest: (() => void) | undefined;

    if (!hasLoggedUpstreamConfig && proxyConfig.general) {
      logger.debug(requestId, `General config: \n\tbudget_to_effort_low=${proxyConfig.general?.budget_to_effort_low}, \n\tbudget_to_effort_medium=${proxyConfig.general?.budget_to_effort_medium}, \n\tbudget_to_effort_high=${proxyConfig.general?.budget_to_effort_high}`);
      hasLoggedUpstreamConfig = true;
    }

    const finalResponse = await (async (): Promise<Response> => {
    try {
      // Handle CORS preflight
      if (request.method === 'OPTIONS') {
        return handleOptionsRequest(request, env);
      }

      if (path === '/dashboard' && request.method === 'GET') {
        return applyCorsHeaders(handleDashboardPage(env), request, env);
      }

      if (path.startsWith('/dashboard/api/')) {
        const authError = validateDashboardApiAuth(request, proxyConfig);
        if (authError) {
          return applyCorsHeaders(authError, request, env);
        }
      }

      if (path === '/dashboard/api/config' && request.method === 'GET') {
        let configForDashboard = proxyConfig;
        if (url.searchParams.get('reload') === '1') {
          clearProxyConfigCache();
          configForDashboard = await loadProxyConfig(env);
        }
        return applyCorsHeaders(handleDashboardGetConfig(configForDashboard, env), request, env);
      }

      if (path === '/dashboard/api/config' && request.method === 'PUT') {
        const response = await handleDashboardPutConfig(request, env, proxyConfig);
        return applyCorsHeaders(response, request, env);
      }

      if (path === '/dashboard/api/stats/models' && request.method === 'GET') {
        return applyCorsHeaders(handleDashboardModelStats(), request, env);
      }

      if (path === '/dashboard/api/stats/agents' && request.method === 'GET') {
        return applyCorsHeaders(handleDashboardAgentStats(), request, env);
      }

      if (path === '/dashboard/api/tools/blocklist' && request.method === 'GET') {
        return applyCorsHeaders(handleDashboardToolBlocklist(), request, env);
      }

      if (path === '/dashboard/api/tools/toggle-block' && request.method === 'POST') {
        const response = await handleDashboardToggleToolBlock(request);
        return applyCorsHeaders(response, request, env);
      }

      if (path === '/dashboard/api/stats/requests' && request.method === 'GET') {
        return applyCorsHeaders(handleDashboardRequestStats(), request, env);
      }

      if (path === '/dashboard/api/test-model' && request.method === 'POST') {
        const response = await handleDashboardTestModel(request, env, proxyConfig);
        return applyCorsHeaders(response, request, env);
      }

      if (path === '/dashboard/api/quota' && request.method === 'GET') {
        const response = await handleDashboardModelQuota(request, proxyConfig);
        return applyCorsHeaders(response, request, env);
      }

      if (path === '/dashboard/api/global-token-limit' && request.method === 'POST') {
        const response = await handleDashboardGlobalTokenLimit(request, env);
        return applyCorsHeaders(response, request, env);
      }

      if (path === '/dashboard/api/schedule/alias' && request.method === 'POST') {
        const response = await handleDashboardAddScheduleAlias(request, env);
        return applyCorsHeaders(response, request, env);
      }

      {
        const aliasMatch = path.match(/^\/dashboard\/api\/schedule\/alias\/([^/]+)$/);
        if (aliasMatch && request.method === 'DELETE') {
          const alias = decodeURIComponent(aliasMatch[1]);
          const response = handleDashboardRemoveScheduleAlias(env, alias);
          return applyCorsHeaders(response, request, env);
        }
      }

      {
        const targetMatch = path.match(/^\/dashboard\/api\/schedule\/alias\/([^/]+)\/target$/);
        if (targetMatch && request.method === 'POST') {
          const alias = decodeURIComponent(targetMatch[1]);
          const response = await handleDashboardUpsertScheduleTarget(request, env, alias);
          return applyCorsHeaders(response, request, env);
        }
      }

      {
        const targetDeleteMatch = path.match(
          /^\/dashboard\/api\/schedule\/alias\/([^/]+)\/target\/([^/]+)$/,
        );
        if (targetDeleteMatch && request.method === 'DELETE') {
          const alias = decodeURIComponent(targetDeleteMatch[1]);
          const target = decodeURIComponent(targetDeleteMatch[2]);
          const response = handleDashboardRemoveScheduleTarget(env, alias, target);
          return applyCorsHeaders(response, request, env);
        }
      }

      {
        const modelTargetMatch = path.match(/^\/dashboard\/api\/models\/([^/]+)\/([^/]+)$/);
        if (modelTargetMatch && request.method === 'POST') {
          const category = decodeURIComponent(modelTargetMatch[1]);
          const aliasKey = decodeURIComponent(modelTargetMatch[2]);
          const response = await handleDashboardUpsertModelTarget(request, env, category, aliasKey);
          return applyCorsHeaders(response, request, env);
        }
      }

      // Skip favicon requests
      if (path === '/favicon.ico') {
        return new Response(null, { status: 204 });
      }

      // Health check endpoint (also for root path)
      if (path === '/health' || path === '/') {
        const defaultCategory = proxyConfig.models?.default;
        const defaultCategoryConfig = defaultCategory && !Array.isArray(defaultCategory) ? defaultCategory : undefined;
        const healthBaseUrl = defaultCategoryConfig?.base_url ||
                             proxyConfig.default_upstream?.default_base_url;
        const healthUrl = `${healthBaseUrl}/v1/models`;
        const healthAuth = extractAuthHeaders(request);

        try {
          const { count, cached } = await getModelCount(healthUrl, healthAuth, requestId, logger, env as unknown as Record<string, unknown>);
          if (count > 0) {
            return new Response(JSON.stringify({
              status: 'ok',
              models: count,
              cached,
              version: env.VERSION || 'unknown'
            }), {
              status: 200,
              headers: { 'Content-Type': 'application/json' },
            });
          }
        } catch {
          // Fall through to error
        }
        return new Response(JSON.stringify({
          error: 'No models Found.',
          version: env.VERSION || 'unknown'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Require at least one of: Authorization, x-api-key, x-goog-api-key
      // for model API requests. Health/dashboard/admin paths above are exempt.
      // /v1/models is also exempt: model listing/discovery must work without a
      // credential so SDKs can enumerate. DEV_NO_KEY disables only this
      // presence check; auth_server still applies for non-exempt paths.
      const isModelsListPath = path === '/v1/models' || path.startsWith('/v1/models?');
      const authHeader = request.headers.get('authorization');
      const xApiKey = request.headers.get('x-api-key');
      const xGoogApiKey = request.headers.get('x-goog-api-key');
      const hasAuth = (authHeader && authHeader.trim() !== '') ||
                      (xApiKey && xApiKey.trim() !== '') ||
                      (xGoogApiKey && xGoogApiKey.trim() !== '');
      const devNoKey = env.DEV_NO_KEY === 'true' || env.DEV_NO_KEY === '1';
      if (!hasAuth && !devNoKey && !isModelsListPath) {
        logger.warn(requestId, `Missing auth headers (need Authorization, x-api-key, or x-goog-api-key) for ${path}`);
        return createErrorResponse(
          new Error('Missing authentication: provide Authorization, x-api-key, or x-goog-api-key header.'),
          requestId,
          401
        );
      }

      // If auth_server is configured, validate the client's auth headers against it.
      // When auth_with_model is true, defer the auth call until after body parsing
      // so the requested model id can be forwarded as x-resource-for.
      // Skipped for /v1/models (exempt from auth entirely).
      const authUrl = isModelsListPath ? '' : (proxyConfig.remote?.authentication?.auth_server?.trim() ?? '');
      const authWithModel = proxyConfig.remote?.authentication?.auth_with_model === true;
      const authWithBody = proxyConfig.remote?.authentication?.auth_with_body === true;
      let modelUsageOneTimeAuthCode: string | undefined;
      // Client-IP forwarding headers for the auth_server / record_server sidecars.
      // Computed early so it is in scope for doAuthRequest (which may run now
      // when auth_with_model = false) and for the later stats record calls.
      const sidecarForwardedHeaders = getSidecarForwardedHeaders(request);
      const doAuthRequest = async (
        modelNameForAuth?: string,
        bodyTextForAuth?: string,
      ): Promise<Response | null> => {
        if (!authUrl) return null;
        const authForwardHeaders: Record<string, string> = {};
        if (authHeader) authForwardHeaders['Authorization'] = authHeader;
        if (xApiKey) authForwardHeaders['x-api-key'] = xApiKey;
        if (xGoogApiKey) authForwardHeaders['x-goog-api-key'] = xGoogApiKey;
        const ua = request.headers.get('user-agent');
        if (ua) authForwardHeaders['user-agent'] = ua;
        authForwardHeaders.request_id = requestId;
        authForwardHeaders.endpoint = path;
        if (modelNameForAuth) authForwardHeaders['x-resource-for'] = modelNameForAuth;
        Object.assign(authForwardHeaders, sidecarForwardedHeaders);

        // When auth_with_body is set, forward the entire parsed request body
        // to the auth sidecar as the POST body (raw JSON, no base64). This
        // requires the body to already be parsed, so it only fires on the
        // deferred (post-parse) auth path.
        const sendBody = authWithBody && typeof bodyTextForAuth === 'string';
        if (sendBody) authForwardHeaders['Content-Type'] = 'application/json';

        let authStatus: number;
        let authRespBodyText: string | undefined;
        try {
          const authResp = await fetch(authUrl, {
            method: sendBody ? 'POST' : 'GET',
            headers: authForwardHeaders,
            body: sendBody ? bodyTextForAuth : undefined,
            redirect: 'follow',
          });
          authStatus = authResp.status;
          modelUsageOneTimeAuthCode = authResp.headers.get('one_time_auth_code') || undefined;
          // Read the auth service's response body so a rejection (4xx/5xx) can
          // surface its reason to the client instead of a bare "Authentication
          // failed." — mirrors handleTargetApiError's upstream-message passthrough.
          try {
            authRespBodyText = await authResp.text();
          } catch {
            // best-effort; body read failures fall back to the generic message below
          }
        } catch (err) {
          logger.warn(requestId, `Auth server (${authUrl}) unreachable: ${(err as Error).message}`);
          return createErrorResponse(
            new Error(`Authentication service unavailable: could not reach remote auth server (${authUrl}). ${(err as Error).message}`),
            requestId,
            503,
          );
        }

        if (authStatus !== 200) {
          const authServiceMessage = extractUpstreamMessage(authRespBodyText);
          logger.warn(requestId, `Remote auth server (${authUrl}) rejected request with status ${authStatus} for ${path}${authServiceMessage ? `: ${authServiceMessage}` : ''}`);
          const detail = authServiceMessage
            ? `Remote auth server rejected the request (HTTP ${authStatus}): ${authServiceMessage}`
            : `Remote auth server rejected the request (HTTP ${authStatus}). This is a failure from the configured remote auth_server.`;
          return createErrorResponse(new Error(detail), requestId, 401);
        }
        return null;
      };

      // Early auth runs only when neither auth_with_model nor auth_with_body is
      // set — both require the body to be parsed first, so they defer auth.
      if (authUrl && !authWithModel && !authWithBody) {
        const authError = await doAuthRequest();
        if (authError) return authError;
      }

      // GET /v1/responses/{id} and GET /v1/responses/{id}/input_items —
      // retrieval served from the in-process conversation store (no upstream
      // call). Only intercepted when CONVERSATION_STATE is enabled; otherwise
      // the request falls through to normal routing. Auth-server validation
      // for deferred-auth configs runs here since GETs have no parsed body.
      if (request.method === 'GET' && (env.CONVERSATION_STATE === 'true' || env.CONVERSATION_STATE === '1')) {
        const retrievalMatch = path.match(/^\/v1\/responses\/([^/?]+?)(\/input_items)?$/);
        if (retrievalMatch && retrievalMatch[1] !== 'compact' && retrievalMatch[1] !== 'input_tokens') {
          if (authUrl && (authWithModel || authWithBody)) {
            const authError = await doAuthRequest();
            if (authError) return authError;
          }
          return handleResponsesRetrievalRequest(retrievalMatch[1], retrievalMatch[2] !== undefined, requestId, env, logger);
        }
      }

      const useConfigKey = proxyConfig.remote?.authentication?.auth_passthrough_with === 'config_key';

      // Global token limit check: only applies to model API requests, not dashboard/health
      const globalTokenLimitRaw = proxyConfig.general?.global_token_limit;
      if (globalTokenLimitRaw) {
        const parsedGlobal = parseHumanTokenLimit(globalTokenLimitRaw.trim());
        if (parsedGlobal && parsedGlobal.num > 0) {
          const cutoff = getWindowCutoff(parseWindowSpec(parsedGlobal.duration));
          const windowTotal = getTokensInWindowSince(cutoff);
          if (windowTotal >= parsedGlobal.num) {
            throw new OverLimitError(
              `exceed local token limit: global token limit (${parsedGlobal.num} ${parsedGlobal.duration}) reached (${windowTotal}). No further requests will be routed.`
            );
          }
        }
      }

      recordRequestEndpoint(path);
      requestStartTime = Date.now();
      releaseActiveRequest = incrementActiveRequests();

      // Request body size limit (10MB).
      // Content-Length is optional (chunked / HTTP2), so we enforce the cap
      // by reading the body into a buffer and re-wrapping the request so that
      // downstream code can still call request.text() / request.json() / etc.
      {
        const maxSizeBytes = 10 * 1024 * 1024; // 10MB
        const contentLength = request.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > maxSizeBytes) {
          logger.warn(requestId, `Request body too large (Content-Length): ${contentLength} bytes`);
          return createErrorResponse(new Error('Request body too large'), requestId, 413);
        }
        if (request.body) {
          const reader = request.body.getReader();
          const chunks: Uint8Array[] = [];
          let totalBytes = 0;
          let done = false;
          while (!done) {
            const { value, done: readerDone } = await reader.read();
            done = readerDone;
            if (value) {
              totalBytes += value.byteLength;
              if (totalBytes > maxSizeBytes) {
                reader.cancel();
                logger.warn(requestId, `Request body too large: exceeded ${maxSizeBytes} bytes`);
                return createErrorResponse(new Error('Request body too large'), requestId, 413);
              }
              chunks.push(value);
            }
          }
          // Reconstruct request with the buffered body so it remains readable.
          const buffered = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of chunks) { buffered.set(chunk, offset); offset += chunk.byteLength; }
          request = new Request(request, { body: buffered, duplex: 'half' } as RequestInit);
        }
      }

      let targetUrl: string = '';
      let handlerType: 'models' | 'token-counting' | 'messages' | 'interactions' | 'generateContent' | 'responses' | 'responses-compact' | 'responses-input-tokens' | 'embeddings' | 'chat-completions' = 'messages';
      let modelId: string | undefined;
      // Client-requested model name (pre-alias, from body.model as sent by the
      // caller) — carried into the final runAttempt call for the non-composite/
      // default-route path so response_egress can restore it (modelId gets
      // overwritten with the resolved upstream model id further down).
      let clientRequestedModel: string | undefined;
      let upstreamMode: string | undefined;
      let forceStreaming: boolean = false;
      // Route resolved in the passthrough/fixed path, threaded into the final
      // runAttempt so its request_ingress/response_egress transforms fire (this path
      // bypasses compositeAttempts/buildRouteAttempt which set route otherwise).
      let outerRoute: ModelRouteConfig | undefined;
      let isGeminiBypass = false;
      const userAgentPrefix = extractUserAgentPrefix(request.headers.get('user-agent'));
      // Structured agent identity — filled in once the request body is parsed
      // (path == '/v1/messages' etc.). Stays at this outer scope so it's
      // visible to the downstream `runAttempt(...)` closure, which threads
      // it into response-side tool stats so request and response records
      // share the same (prefix, ua) key.
      let agent: ResolvedAgent = { prefix: userAgentPrefix, ua: userAgentPrefix };
      let requestToolNames: string[] = ['none'];

      // Tool stats are extracted from the already-parsed body inside the routing
      // block below (where body is parsed anyway for model resolution). recordAgentStat
      // is called there for routed requests. For non-routed paths (models list,
      // dashboard, dynamic routes) there are no tools to record.

      type RouteAttemptHandlerType = 'models' | 'token-counting' | 'messages' | 'interactions' | 'generateContent' | 'responses' | 'responses-compact' | 'responses-input-tokens' | 'embeddings' | 'chat-completions';
      type RouteAttempt = {
        request: Request;
        targetUrl: string;
        handlerType: RouteAttemptHandlerType;
        modelId?: string;
        /** Client-requested model name (pre-alias, e.g. body.model as sent by
         *  the caller) — used to restore the alias in response_egress hooks. */
        clientModel?: string;
        upstreamMode?: string;
        forceStreaming: boolean;
        authHeaders: Record<string, string>;
        compositeTargetName?: string;
        compositeTargetConfig?: CompositeTargetConfig;
        /** Structured {prefix, ua} resolved from request body + User-Agent
         *  header. Carried into the response-tracking closure so request-side
         *  and response-side records share one (prefix, ua) key. Optional for
         *  legacy callers — defaults to UA-only. */
        agent?: ResolvedAgent;
        /** Resolved route config for this attempt; carries the transforms list. */
        route?: ModelRouteConfig;
      };
      let compositeAttempts: RouteAttempt[] | undefined;
      let compositeAliasName: string | undefined;
      let scheduleAliasName: string | undefined;

      // Privacy filter: sentinel -> original mapping for this request, restored
      // on the client-facing response. Empty unless redaction actually runs.
      const privacyConfig = getPrivacyFilterConfig(env, proxyConfig.privacy_filter);
      const privacyActive = !!privacyConfig;
      let piiMapping: PiiMapping = {};

      // Kompress: lossy, one-directional compression of outbound request text.
      // No response-side handling needed.
      const kompressConfig = getKompressConfig(env);
      const kompressActive = !!kompressConfig && shouldCompressPath(kompressConfig, path);

      // Extract authentication headers early
      const authHeaders = extractAuthHeaders(request);
      const endpointUserKey = getRawEndpointUserKey(authHeaders);
      const modelUsageRecordUrl = proxyConfig.remote?.recording?.record_server?.trim();
      const modelUsageRecordBody = proxyConfig.remote?.recording?.record_response_body === true;
      let modelAuthHeaders = authHeaders;

      // For endpoints that need model-specific routing, extract model from request body
      if (path === '/v1/messages' || path.startsWith('/v1/messages?') ||
          path === '/v1/interactions' || path.startsWith('/v1/interactions?') ||
          path === '/v1/responses' || path.startsWith('/v1/responses?') ||
          path === '/v1/responses/compact' || path.startsWith('/v1/responses/compact?') ||
          path === '/v1/responses/input_tokens' || path.startsWith('/v1/responses/input_tokens?') ||
          (path === '/v1/chat/completions' || path.startsWith('/v1/chat/completions?')) ||
          ((path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && (path.includes(':generateContent') || path.includes(':streamGenerateContent') || path.includes(':countTokens')))) {
        try {
          let bodyText = await request.text();
          const body = JSON.parse(bodyText);

          // Extract tool stats from the already-parsed body — avoids a second
          // clone()+parse that would otherwise happen before the routing block.
          requestToolNames = extractToolNamesFromBody(body);
          // Identify the agent by matching the system-content prefix against
          // known clients (e.g. "openclaw/hermes" for OpenClaw's Hermes
          // system prompt). Falls back to the User-Agent prefix when nothing
          // matches. Returns {prefix, ua} so we can display them separately
          // in the Tool Blocklist.
          agent = resolveAgentName(body, userAgentPrefix);
          recordToolRequestChars(extractToolRequestCharLengthsFromBody(body), agent);
          recordAgentStat(agent, requestToolNames);

          // Privacy filter: redact PII out of the request body before routing so
          // every downstream path (single/composite/fusion) operates on redacted
          // text. The mapping is restored on the client-facing response below.
          if (privacyActive) {
            const { mapping } = await redactBody(privacyConfig!, body);
            piiMapping = mapping;
            if (Object.keys(mapping).length > 0) {
              bodyText = JSON.stringify(body);
              recordPrivacyKeysDetected(Object.keys(mapping).length);
              logger.info(requestId, `Privacy filter redacted ${Object.keys(mapping).length} span(s) from ${path}`);
              logger.debug(requestId, `Found: ${Object.entries(mapping).map(([k, v]) => `${k}=${v}`).join(", ")}`);
            }
          }

          // Kompress: drop low-importance tokens from compressible request text
          // (user messages + tool defs/results) to save upstream tokens. Runs
          // after redaction so it operates on already-redacted text. One-directional
          // — no response-side restore. Fails open by default.
          if (kompressActive) {
            const { fragments, savedPct } = await compressBody(kompressConfig!, body);
            if (fragments > 0) {
              bodyText = JSON.stringify(body);
              logger.info(requestId, `Kompress compressed ${fragments} fragment(s), saved ~${savedPct.toFixed(1)}% chars from ${path}`);
            }
          }

          // Erase blocked tools from the request body before routing so every
          // downstream path (single/composite/fusion) operates on the filtered
          // body. Mirrors the privacy-filter pattern above — mutate `body`, then
          // reserialize `bodyText` so the passthrough reconstruction picks it up.
          const eraseResult = eraseBlockedTools(body, logger, requestId);
          if (eraseResult.erasedNames.length > 0 || eraseResult.toolChoiceReset) {
            bodyText = JSON.stringify(body);
          }

          let modelName = body.model;

          // For generateContent/countTokens endpoint, extract model from URL if not in body
          if (!modelName && (path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && (path.includes(':generateContent') || path.includes(':streamGenerateContent') || path.includes(':countTokens'))) {
            const modelMatch = path.match(/\/(v1beta|v1)\/models\/([^:?]+):(stream)?(?:generateContent|streamGenerateContent|countTokens)/);
            if (modelMatch) {
              modelName = decodeURIComponent(modelMatch[2]);
            }
          }

          // Schedule resolution: a schedule alias picks one of its listed target
          // aliases based on server-local time-of-day/day-of-week, then delegates
          // to the normal composite/fusion/plain routing logic for that target.
          // Single-hop only — if the resolved target is itself a schedule alias,
          // it is treated as a literal name rather than re-resolved.
          if (modelName) {
            const scheduledTarget = resolveScheduleTarget(modelName, proxyConfig);
            if (scheduledTarget) {
              scheduleAliasName = modelName;
              logger.debug(requestId, `Schedule routing: ${modelName} -> ${scheduledTarget}`);
              modelName = scheduledTarget;
            }
          }

          // Deferred auth: runs after the body is parsed when either auth_with_model
          // (forwards x-resource-for) or auth_with_body (forwards the whole body) is set.
          if (authUrl && (authWithModel || authWithBody)) {
            const authError = await doAuthRequest(modelName, bodyText);
            if (authError) return authError;
          }

          // Passthrough for /v1/chat/completions: use fixed routing but extract model name for stats.
          // When passthrough is NOT enabled, skip routing vars entirely — the outer "else" block
          // (fixed routing) calls parseFixedRoute() which throws the block error.
          if (path === '/v1/chat/completions' || path.startsWith('/v1/chat/completions?')) {
            // Prefer per-model route (e.g. gpt-5.5 in [models.free]) over the global default,
            // so the correct base_url, api_key, and upstream_mode are used.
            const modelRoute = modelName ? getModelRouteConfig(modelName, proxyConfig) : undefined;
            outerRoute = modelRoute;
            const fixedRoute = parseFixedRoute(path, proxyConfig, env);

            if (modelRoute && modelRoute.targetUrl) {
              let upstreamPath: string;
              if (modelRoute.upstreamMode === 'openai-responses') {
                upstreamPath = 'v1/responses';
              } else if (modelRoute.upstreamMode === 'anthropic-messages') {
                upstreamPath = 'v1/messages';
              } else if (modelRoute.upstreamMode === 'gemini-generatecontent'
                  || modelRoute.upstreamMode === 'gemini-interactions') {
                // Gemini generateContent URL embeds the target model id and the
                // action. The chat-completions handler handles non-streaming
                // (:generateContent); streaming lands in Phase 3.
                const targetModel = modelRoute.modelAlias || modelName || 'gemini-no-id-at-proxy';
                upstreamPath = `v1beta/models/${encodeURIComponent(targetModel)}:generateContent`;
              } else {
                upstreamPath = 'v1/chat/completions';
              }
              targetUrl = buildUpstreamUrl(modelRoute.targetUrl, upstreamPath);
              upstreamMode = modelRoute.upstreamMode || fixedRoute.upstreamMode;
            } else {
              targetUrl = fixedRoute.targetUrl;
              upstreamMode = fixedRoute.upstreamMode;
            }
            handlerType = fixedRoute.handlerType;
            modelId = modelName; // Use extracted model name for dashboard stats
            clientRequestedModel = modelName;
            forceStreaming = fixedRoute.forceStreaming || false;

            // Resolve composite/alias model id: if the configured route resolves to a
            // different target model (e.g. "for-claw" → "minimax-m3" → target "MiniMax-M3"),
            // rewrite the model field in the forwarded body so the upstream sees the real
            // model id. Fall back to the original model name if no alias is resolved.
            const resolvedModelAlias = modelRoute?.modelAlias;
            if (resolvedModelAlias && resolvedModelAlias !== modelName) {
              body.model = resolvedModelAlias;
              bodyText = JSON.stringify(body);
              logger.info(requestId, `/v1/chat/completions composite alias resolved: ${modelName} → ${resolvedModelAlias}`);
            }

            // Recreate request with (possibly rewritten) body
            request = new Request(request.url, {
              method: request.method,
              headers: request.headers,
              body: bodyText,
            });

            // Transform auth headers, then override with model-specific api_key if config_key mode
            modelAuthHeaders = transformAuthHeadersForUpstream(request, upstreamMode || 'openai-completions', path, requestId, env as Record<string, unknown>);
            // Same free-section rule as the normal routing paths: models in
            // [models.free] always use their configured api_key (client key
            // is never forwarded upstream for these routes).
            if ((useConfigKey || (modelRoute?.section === 'free' || modelRoute?.section === 'FREE')) && modelRoute?.apiKey) {
              modelAuthHeaders = { ...modelAuthHeaders, ...formatApiKeyForUpstream(modelRoute.apiKey, upstreamMode || 'openai-completions') };
            }
          } else if (modelName && proxyConfig.models) {
            clientRequestedModel = modelName;
            // ---- Coordinator mode: route to planner or executor based on stage ----
            if (getCompositeAliasMode(modelName, proxyConfig) === 'coordinator') {
              const coordPlan = resolveCoordinatorPlan(modelName, proxyConfig);
              if (coordPlan) {
                const messages = Array.isArray(body?.messages) ? body.messages as unknown[] : [];
                const stage = detectCoordinatorStage(messages, coordPlan.triggerTools);
                const chosenRoute = stage === 'executing' ? coordPlan.executorRoute : coordPlan.plannerRoute;
                const chosenName = stage === 'executing' ? coordPlan.executorName : coordPlan.plannerName;
                logger.info(requestId, `[coordinator] alias=${modelName} stage=${stage} model=${chosenRoute.modelAlias || chosenName}`);
                // Inject a single resolved candidate; the standard compositeAttempts machinery below will build the full attempt.
                (request as any)._coordCandidate = { modelName: chosenName, route: chosenRoute, targetConfig: {} } as CompositeRouteCandidate;
              }
            }

            // ---- Fusion mode: parallel fan-out → judge → synthesis ----
            if (!((request as any)._fusionPlan) && getCompositeAliasMode(modelName, proxyConfig) === 'fusion') {
              const fusionPlan = resolveFusionPlan(modelName, proxyConfig);
              if (fusionPlan) {
                // token_limit check (covers all panel+judge+synth targets under the alias)
                if (proxyConfig.composite?.[modelName]?.token_limit !== undefined) {
                  const limitCfg = proxyConfig.composite[modelName].token_limit!;
                  const allTargets = [
                    ...fusionPlan.panel.map(p => p.route.modelAlias || p.modelName),
                    ...(fusionPlan.judge ? [fusionPlan.judge.route.modelAlias || fusionPlan.judge.modelName] : []),
                    fusionPlan.synth.route.modelAlias || fusionPlan.synth.modelName,
                  ];
                  const totalUsed = getCompositeAliasTokenUsage(modelName, allTargets);
                  if (totalUsed >= limitCfg.num) {
                    throw new OverLimitError(
                      `exceed local token limit: composite alias '${modelName}' token limit (${limitCfg.num} ${limitCfg.duration}) reached (${totalUsed}).`
                    );
                  }
                }
                logger.info(requestId, `Fusion routing: ${modelName} → ${fusionPlan.panel.length} panel(s) + judge(${fusionPlan.judge?.modelName ?? 'none'}) + synth(${fusionPlan.synth.modelName})`);
                compositeAliasName = modelName;
                // runFusion is defined lower in this closure; call it after runAttempt is defined.
                // We set a sentinel so the compositeAttempts path is skipped.
                (request as any)._fusionPlan = fusionPlan;
                (request as any)._fusionBody = body;
                // Fall through with empty compositeAttempts — fusion is handled at dispatch time below
                compositeAttempts = [];
              }
            }

            if (!((request as any)._fusionPlan)) {
            const compositeCandidates = getCompositeRouteCandidates(modelName, proxyConfig);
            compositeAliasName = (compositeCandidates.length > 0 || (request as any)._coordCandidate) ? modelName : undefined;

            // Token-limit enforcement: check tokens in the current duration window against the alias-level limit.
            if (compositeCandidates.length > 0 && proxyConfig.composite?.[modelName]?.token_limit !== undefined) {
              const limitCfg = proxyConfig.composite[modelName].token_limit!;
              const targetModels = compositeCandidates.map((c) => c.route.modelAlias || c.modelName);
              const totalUsed = getCompositeAliasTokenUsage(modelName, targetModels);
              logger.debug(requestId, `Composite alias ${modelName}: window tokens ${totalUsed} across ${compositeCandidates.length} targets, limit ${limitCfg.num} (${limitCfg.duration})`);
              if (totalUsed >= limitCfg.num) {
                logger.info(requestId, `Rejecting request for ${modelName}: ${totalUsed} window tokens >= limit ${limitCfg.num}`);
                throw new OverLimitError(
                  `exceed local token limit: composite alias '${modelName}' token limit (${limitCfg.num} ${limitCfg.duration}) reached (${totalUsed}). No further requests will be routed through this alias.`
                );
              }
            }

            // Coordinator pre-selects a single candidate; bypass share/fallback ordering.
            const coordCandidate = (request as any)._coordCandidate as CompositeRouteCandidate | undefined;
            const routeCandidates: CompositeRouteCandidate[] = coordCandidate
              ? [coordCandidate]
              : compositeCandidates.length > 0
                ? orderCompositeCandidatesForRuntimeShare(modelName, compositeCandidates)
                : [{ modelName, route: getModelRouteConfig(modelName, proxyConfig), targetConfig: {} }];

            // Get client connection info from headers (added by Node.js server adapter)
            const clientAddress = request.headers.get('x-client-address') || 'unknown';
            const clientPort = request.headers.get('x-client-port') || 'unknown';

            compositeAttempts = routeCandidates.map(({ modelName: candidateName, route, targetConfig }) => {
              logger.debug(requestId, `Composite candidate ${modelName} -> ${candidateName} via ${route.targetUrl} (${route.upstreamMode}) [client ${clientAddress}:${clientPort}]`);

              const upstreamModelName = route.modelAlias || candidateName;
              const safeModel = encodeURIComponent(upstreamModelName);
              const forwardedBodyText = JSON.stringify({
                ...body,
                model: upstreamModelName,
              });

              const candidateRequest = new Request(request.url, {
                method: request.method,
                headers: request.headers,
                body: forwardedBodyText,
              });

              let candidateAuthHeaders = transformAuthHeadersForUpstream(candidateRequest, route.upstreamMode, path, requestId, env as Record<string, unknown>);

              if (route.apiKey && (route.section === 'free' || route.section === 'FREE' || useConfigKey)) {
                if (route.upstreamMode === 'openai-completions') {
                  if (route.modelAlias) {
                    candidateAuthHeaders = { ...candidateAuthHeaders, ...formatApiKeyForUpstream(route.apiKey, route.upstreamMode) };
                  }
                } else {
                  candidateAuthHeaders = { ...candidateAuthHeaders, ...formatApiKeyForUpstream(route.apiKey, route.upstreamMode) };
                }
              }

              const isNativeMode = route.upstreamMode === 'anthropic-messages' ||
                                  route.upstreamMode === 'gemini-generatecontent' ||
                                  route.upstreamMode === 'gemini-interactions' ||
                                  route.upstreamMode === 'openai-responses';

              let candidateTargetUrl = '';
              let candidateHandlerType: RouteAttempt['handlerType'] = 'messages';
              let candidateUpstreamMode: string | undefined;
              let candidateForceStreaming = false;

              if (path === '/v1/messages' || path.startsWith('/v1/messages?')) {
                candidateHandlerType = 'messages';
                if (isNativeMode) {
                  const requestBody = JSON.parse(forwardedBodyText) as Record<string, unknown>;
                  const isStreaming = requestBody.stream === true;

                  if (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions') {
                    candidateTargetUrl = isStreaming
                      ? buildUpstreamUrl(route.targetUrl, `v1beta/models/${safeModel}:streamGenerateContent?alt=sse`)
                      : buildUpstreamUrl(route.targetUrl, `v1beta/models/${safeModel}:generateContent`);
                  } else if (route.upstreamMode === 'openai-responses') {
                    candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/responses');
                  } else {
                    candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/messages');
                  }
                  candidateUpstreamMode = route.upstreamMode;
                } else {
                  candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/chat/completions');
                  candidateUpstreamMode = 'openai-completions';
                }
              } else if (path === '/v1/interactions' || path.startsWith('/v1/interactions?')) {
                candidateHandlerType = 'interactions';
                if (isNativeMode) {
                  if (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions') {
                    const requestBody = JSON.parse(forwardedBodyText) as Record<string, unknown>;
                    const isStreaming = requestBody.stream === true;
                    candidateTargetUrl = isStreaming
                      ? buildUpstreamUrl(route.targetUrl, `v1beta/models/${safeModel}:streamGenerateContent?alt=sse`)
                      : buildUpstreamUrl(route.targetUrl, `v1beta/models/${safeModel}:generateContent`);
                    candidateUpstreamMode = route.upstreamMode;
                  } else if (route.upstreamMode === 'anthropic-messages') {
                    candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/messages');
                    candidateUpstreamMode = 'anthropic-messages';
                  } else if (route.upstreamMode === 'openai-responses') {
                    candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/responses');
                    candidateUpstreamMode = 'openai-responses';
                  } else {
                    candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/chat/completions');
                    candidateUpstreamMode = 'openai-completions';
                  }
                } else {
                  candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/chat/completions');
                  candidateUpstreamMode = 'openai-completions';
                }
              } else if ((path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && path.includes(':countTokens')) {
                candidateHandlerType = 'generateContent';
                if (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions') {
                  candidateTargetUrl = buildUpstreamUrl(route.targetUrl, `v1beta/models/${safeModel}:countTokens`);
                  candidateUpstreamMode = route.upstreamMode;
                } else {
                  candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/messages/count_tokens');
                  candidateUpstreamMode = 'openai-completions';
                }
              } else if ((path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && (path.includes(':generateContent') || path.includes(':streamGenerateContent'))) {
                candidateHandlerType = 'generateContent';
                const isStreamEndpoint = path.includes(':streamGenerateContent');
                if (isNativeMode) {
                  if (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions') {
                    const endpoint = isStreamEndpoint ? 'streamGenerateContent' : 'generateContent';
                    let queryString = path.includes('?') ? path.substring(path.indexOf('?')) : '';
                    if (isStreamEndpoint && !queryString.includes('alt=sse')) {
                      queryString = queryString ? `${queryString}&alt=sse` : '?alt=sse';
                    }
                    candidateTargetUrl = buildUpstreamUrl(route.targetUrl, `v1beta/models/${safeModel}:${endpoint}${queryString}`);
                    candidateUpstreamMode = route.upstreamMode;
                  } else if (route.upstreamMode === 'anthropic-messages') {
                    // Through openai-completions transforming: handler converts
                    // generateContent body → openai-completions → anthropic-messages.
                    candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/messages');
                    candidateUpstreamMode = 'anthropic-messages';
                    candidateForceStreaming = isStreamEndpoint;
                  } else if (route.upstreamMode === 'openai-responses') {
                    // Through openai-completions transforming: handler converts
                    // generateContent body → openai-completions → openai-responses.
                    candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/responses');
                    candidateUpstreamMode = 'openai-responses';
                    candidateForceStreaming = isStreamEndpoint;
                  } else {
                    candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/chat/completions');
                    candidateUpstreamMode = 'openai-completions';
                    candidateForceStreaming = isStreamEndpoint;
                  }
                } else {
                  candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/chat/completions');
                  candidateUpstreamMode = 'openai-completions';
                  candidateForceStreaming = isStreamEndpoint;
                }
              } else if (path === '/v1/responses' || path.startsWith('/v1/responses?')) {
                candidateHandlerType = 'responses';
                if (route.upstreamMode === 'openai-responses') {
                  candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/responses');
                  candidateUpstreamMode = 'openai-responses';
                } else if (route.upstreamMode === 'anthropic-messages') {
                  candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/messages');
                  candidateUpstreamMode = 'anthropic-messages';
                } else if (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions') {
                  const apiVersion = env.GEMINI_API_VERSION || 'v1beta';
                  candidateTargetUrl = buildUpstreamUrl(route.targetUrl, apiVersion);
                  candidateUpstreamMode = route.upstreamMode;
                } else {
                  candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/chat/completions');
                  candidateUpstreamMode = 'openai-completions';
                }
              } else if (path === '/v1/responses/input_tokens' || path.startsWith('/v1/responses/input_tokens?')) {
                candidateHandlerType = 'responses-input-tokens';
                if (route.upstreamMode === 'openai-responses') {
                  candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/responses/input_tokens');
                  candidateUpstreamMode = 'openai-responses';
                } else {
                  candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/chat/completions');
                  candidateUpstreamMode = 'openai-completions';
                }
              } else if (path === '/v1/responses/compact' || path.startsWith('/v1/responses/compact?')) {
                candidateHandlerType = 'responses-compact';
                if (route.upstreamMode === 'openai-responses') {
                  candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/responses/compact');
                  candidateUpstreamMode = 'openai-responses';
                } else {
                  candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/chat/completions');
                  candidateUpstreamMode = 'openai-completions';
                }
              }

              return {
                request: candidateRequest,
                targetUrl: candidateTargetUrl,
                handlerType: candidateHandlerType,
                modelId: upstreamModelName,
                clientModel: modelName,
                upstreamMode: candidateUpstreamMode,
                forceStreaming: candidateForceStreaming,
                authHeaders: candidateAuthHeaders,
                compositeTargetName: compositeAliasName ? candidateName : undefined,
                compositeTargetConfig: compositeAliasName ? targetConfig : undefined,
                route,
              };
            });

            const firstAttempt = compositeAttempts[0];
            targetUrl = firstAttempt.targetUrl;
            handlerType = firstAttempt.handlerType;
            modelId = firstAttempt.modelId;
            upstreamMode = firstAttempt.upstreamMode;
            forceStreaming = firstAttempt.forceStreaming;
            modelAuthHeaders = firstAttempt.authHeaders;
            request = firstAttempt.request;

            logger.debug(requestId, `Model-specific routing: ${modelName} -> ${targetUrl} (${upstreamMode}) [${handlerType}]`);
            } // end if (!fusionPlan)
          } else {
            // No model-specific config, use default routing
            const fixedRoute = parseFixedRoute(path, proxyConfig, env);
            targetUrl = fixedRoute.targetUrl;
            handlerType = fixedRoute.handlerType;
            upstreamMode = fixedRoute.upstreamMode;
            modelId = fixedRoute.modelId;
            forceStreaming = fixedRoute.forceStreaming || false;

            // Recreate request with body
            request = new Request(request.url, {
              method: request.method,
              headers: request.headers,
              body: bodyText,
            });

            // In config_key mode, apply default_upstream.default_api_key for models
            // that fall through to the default route (no model-specific entry).
            if (useConfigKey) {
              const defaultApiKey = proxyConfig.default_upstream?.default_api_key;
              if (defaultApiKey && upstreamMode) {
                modelAuthHeaders = {
                  ...transformAuthHeadersForUpstream(request, upstreamMode, path, requestId, env as Record<string, unknown>),
                  ...formatApiKeyForUpstream(defaultApiKey, upstreamMode),
                };
              }
            }
          }
        } catch (error) {
          // Re-raise typed proxy errors (e.g. OverLimitError from composite /
          // global token-limit checks) so the client sees the correct status and
          // error type. Only swallow generic errors as a 400 body-parse failure.
          if (error instanceof ClaudeProxyError) {
            logger.error(requestId, `Proxy error during model routing ${path}: ${error.message}`);
            return createErrorResponse(error, requestId);
          }
          logger.error(requestId, `Failed to parse request body for model routing ${path}: ${(error as Error).message}`);
          return createErrorResponse(new Error('Invalid request body'), requestId, 400);
        }
      } else if (isDynamicRoute(path)) {
        // Dynamic routing: /http/host/... or /https/host/...
        // Validate parsed host against config-approved upstream hosts (SSRF protection).
        let parsedRoute;
        try {
          parsedRoute = parseDynamicRoute(path);
        } catch (err) {
          logger.error(requestId, `Dynamic route parse error for ${path}: ${(err as Error).message}`);
          return createErrorResponse(new Error('Invalid dynamic route.'), requestId, 400);
        }
        const parsedHost = new URL(parsedRoute.targetConfig.targetUrl).host;
        const allowedHosts = getAllowedHostsFromConfig(proxyConfig);
        if (!isHostAllowed(parsedHost, allowedHosts.join(','))) {
          logger.warn(requestId, `SSRF blocked: host '${parsedHost}' not in allowed list [${allowedHosts.join(', ')}]`);
          return createErrorResponse(new Error('Target host not allowed.'), requestId, 403);
        }
        const { claudeEndpoint, modelId: dynModelId, targetConfig } = parsedRoute;
        handlerType = getHandlerType(claudeEndpoint);
        modelId = dynModelId;
        targetUrl = buildTargetUrl(targetConfig, claudeEndpoint, dynModelId);
        // Auth headers forwarded as-is for dynamic routes
        modelAuthHeaders = authHeaders;
      } else {
        // Deferred auth for non-body-parsed paths: no model or body available,
        // auth runs with neither x-resource-for nor a body. auth_with_body has
        // no effect on these routes (there is no parsed body to forward).
        if (authUrl && (authWithModel || authWithBody)) {
          const authError = await doAuthRequest();
          if (authError) return authError;
        }

        // Fixed routing: /v1/messages -> /v1/chat/completions
        const fixedRoute = parseFixedRoute(path, proxyConfig, env);
        targetUrl = fixedRoute.targetUrl;
        handlerType = fixedRoute.handlerType;
        upstreamMode = fixedRoute.upstreamMode;
        modelId = fixedRoute.modelId;
        
        // Transform auth headers for fixed route based on upstream mode and endpoint
        if (upstreamMode) {
          modelAuthHeaders = transformAuthHeadersForUpstream(request, upstreamMode, path, requestId, env as Record<string, unknown>);

          // Debug log: show auth header keys and partial values for fixed routing
          const authKeys = Object.keys(modelAuthHeaders);
          if (authKeys.length > 0) {
            authKeys.forEach(key => {
              const value = modelAuthHeaders[key];
              const partialValue = value.length > 8 ? `${value.substring(0, 4)}...${value.substring(value.length - 4)}` : '***';
              logger.debug(requestId, `Auth header for fixed routing ${upstreamMode}: ${key}=${partialValue}`);
            });
          } else {
            logger.debug(requestId, `No auth headers found for fixed routing ${upstreamMode}`);
          }

          // In config_key mode, override with default_upstream.default_api_key for fixed routing
          if (useConfigKey) {
            const defaultApiKey = proxyConfig.default_upstream?.default_api_key;
            if (defaultApiKey) {
              modelAuthHeaders = { ...modelAuthHeaders, ...formatApiKeyForUpstream(defaultApiKey, upstreamMode) };
            }
          }
        }

        // Embeddings endpoint: apply [models.EMBEDDING] / [models.embedding] api_key if configured
        if (path === '/v1/embeddings' || path.startsWith('/v1/embeddings?')) {
          const embeddingCategory = proxyConfig.models?.EMBEDDING ?? proxyConfig.models?.embedding;
          const embeddingConfig = embeddingCategory && !Array.isArray(embeddingCategory) ? embeddingCategory : undefined;
          const embeddingApiKey = embeddingConfig?.api_key;
          if (embeddingApiKey) {
            modelAuthHeaders = {
              ...modelAuthHeaders,
              ...formatApiKeyForUpstream(embeddingApiKey, upstreamMode || 'openai-completions'),
            };
            logger.debug(requestId, `Applied [models.embedding] api_key for embeddings request`);
          }
        }
      }

      // Build a RouteAttempt for a given {modelName, route} pair and a body object.
      // Mirrors the inline logic in the compositeAttempts.map() block above.
      const buildRouteAttempt = (
        candidateName: string,
        route: ModelRouteConfig,
        bodyObj: Record<string, unknown>,
        forceStreamOverride?: boolean,
      ): RouteAttempt => {
        const upstreamModelName = route.modelAlias || candidateName;
        const safeModel = encodeURIComponent(upstreamModelName);
        const forwardedBodyText = JSON.stringify({ ...bodyObj, model: upstreamModelName });
        const candidateRequest = new Request(request.url, {
          method: request.method,
          headers: request.headers,
          body: forwardedBodyText,
        });

        let candidateAuthHeaders = transformAuthHeadersForUpstream(candidateRequest, route.upstreamMode, path, requestId, env as Record<string, unknown>);
        if (route.apiKey && (route.section === 'free' || route.section === 'FREE' || useConfigKey)) {
          if (route.upstreamMode === 'openai-completions') {
            if (route.modelAlias) {
              candidateAuthHeaders = { ...candidateAuthHeaders, ...formatApiKeyForUpstream(route.apiKey, route.upstreamMode) };
            }
          } else {
            candidateAuthHeaders = { ...candidateAuthHeaders, ...formatApiKeyForUpstream(route.apiKey, route.upstreamMode) };
          }
        }

        if (route.upstreamMode === 'openai-completions') {
          const authVal = candidateAuthHeaders['Authorization'] || candidateAuthHeaders['x-api-key'];
          if (authVal) {
            const masked = authVal.length > 8 ? `${authVal.substring(0, 8)}...` : '***';
            const attemptLogger = createLogger(env as Record<string, unknown>);
            attemptLogger.debug(requestId, `Upstream Authorization: ${masked}`);
          }
        }

        const isNativeMode = route.upstreamMode === 'anthropic-messages' ||
                             route.upstreamMode === 'gemini-generatecontent' ||
                             route.upstreamMode === 'gemini-interactions' ||
                             route.upstreamMode === 'openai-responses';

        let candidateTargetUrl = '';
        let candidateHandlerType: RouteAttempt['handlerType'] = 'messages';
        let candidateUpstreamMode: string | undefined;
        let candidateForceStreaming = forceStreamOverride ?? false;

        const bodyStream = (bodyObj.stream === true);

        if (path === '/v1/messages' || path.startsWith('/v1/messages?')) {
          candidateHandlerType = 'messages';
          if (isNativeMode) {
            if (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions') {
              candidateTargetUrl = bodyStream
                ? buildUpstreamUrl(route.targetUrl, `v1beta/models/${safeModel}:streamGenerateContent?alt=sse`)
                : buildUpstreamUrl(route.targetUrl, `v1beta/models/${safeModel}:generateContent`);
            } else if (route.upstreamMode === 'openai-responses') {
              candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/responses');
            } else {
              candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/messages');
            }
            candidateUpstreamMode = route.upstreamMode;
          } else {
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/chat/completions');
            candidateUpstreamMode = 'openai-completions';
          }
        } else if (path === '/v1/interactions' || path.startsWith('/v1/interactions?')) {
          candidateHandlerType = 'interactions';
          if (isNativeMode && (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions')) {
            candidateTargetUrl = bodyStream
              ? buildUpstreamUrl(route.targetUrl, `v1beta/models/${safeModel}:streamGenerateContent?alt=sse`)
              : buildUpstreamUrl(route.targetUrl, `v1beta/models/${safeModel}:generateContent`);
            candidateUpstreamMode = route.upstreamMode;
          } else if (isNativeMode && route.upstreamMode === 'anthropic-messages') {
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/messages');
            candidateUpstreamMode = 'anthropic-messages';
          } else if (isNativeMode && route.upstreamMode === 'openai-responses') {
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/responses');
            candidateUpstreamMode = 'openai-responses';
          } else {
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/chat/completions');
            candidateUpstreamMode = 'openai-completions';
          }
        } else if ((path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && path.includes(':countTokens')) {
          candidateHandlerType = 'generateContent';
          if (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions') {
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, `v1beta/models/${safeModel}:countTokens`);
            candidateUpstreamMode = route.upstreamMode;
          } else {
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/messages/count_tokens');
            candidateUpstreamMode = 'openai-completions';
          }
        } else if ((path.startsWith('/v1beta/models/') || path.startsWith('/v1/models/')) && (path.includes(':generateContent') || path.includes(':streamGenerateContent'))) {
          candidateHandlerType = 'generateContent';
          const isStreamEndpoint = path.includes(':streamGenerateContent');
          if (isNativeMode && (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions')) {
            const endpoint = isStreamEndpoint ? 'streamGenerateContent' : 'generateContent';
            let queryString = path.includes('?') ? path.substring(path.indexOf('?')) : '';
            if (isStreamEndpoint && !queryString.includes('alt=sse')) { queryString = queryString ? `${queryString}&alt=sse` : '?alt=sse'; }
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, `v1beta/models/${safeModel}:${endpoint}${queryString}`);
            candidateUpstreamMode = route.upstreamMode;
          } else if (isNativeMode && route.upstreamMode === 'anthropic-messages') {
            // Through openai-completions transforming: handler converts
            // generateContent body → openai-completions → anthropic-messages.
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/messages');
            candidateUpstreamMode = 'anthropic-messages';
            candidateForceStreaming = forceStreamOverride ?? isStreamEndpoint;
          } else if (isNativeMode && route.upstreamMode === 'openai-responses') {
            // Through openai-completions transforming: handler converts
            // generateContent body → openai-completions → openai-responses.
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/responses');
            candidateUpstreamMode = 'openai-responses';
            candidateForceStreaming = forceStreamOverride ?? isStreamEndpoint;
          } else {
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/chat/completions');
            candidateUpstreamMode = 'openai-completions';
            candidateForceStreaming = forceStreamOverride ?? isStreamEndpoint;
          }
        } else if (path === '/v1/responses' || path.startsWith('/v1/responses?')) {
          candidateHandlerType = 'responses';
          if (route.upstreamMode === 'openai-responses') {
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/responses');
            candidateUpstreamMode = 'openai-responses';
          } else if (route.upstreamMode === 'anthropic-messages') {
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/messages');
            candidateUpstreamMode = 'anthropic-messages';
          } else if (route.upstreamMode === 'gemini-generatecontent' || route.upstreamMode === 'gemini-interactions') {
            const apiVersion = env.GEMINI_API_VERSION || 'v1beta';
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, apiVersion);
            candidateUpstreamMode = route.upstreamMode;
          } else {
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/chat/completions');
            candidateUpstreamMode = 'openai-completions';
          }
        } else if (path === '/v1/responses/input_tokens' || path.startsWith('/v1/responses/input_tokens?')) {
          candidateHandlerType = 'responses-input-tokens';
          if (route.upstreamMode === 'openai-responses') {
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/responses/input_tokens');
            candidateUpstreamMode = 'openai-responses';
          } else {
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/chat/completions');
            candidateUpstreamMode = 'openai-completions';
          }
        } else if (path === '/v1/responses/compact' || path.startsWith('/v1/responses/compact?')) {
          candidateHandlerType = 'responses-compact';
          if (route.upstreamMode === 'openai-responses') {
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/responses/compact');
            candidateUpstreamMode = 'openai-responses';
          } else {
            candidateTargetUrl = buildUpstreamUrl(route.targetUrl, 'v1/chat/completions');
            candidateUpstreamMode = 'openai-completions';
          }
        }

        return {
          request: candidateRequest,
          targetUrl: candidateTargetUrl,
          handlerType: candidateHandlerType,
          modelId: upstreamModelName,
          clientModel: clientRequestedModel,
          upstreamMode: candidateUpstreamMode,
          forceStreaming: candidateForceStreaming,
          authHeaders: candidateAuthHeaders,
          route,
        };
      };

      // Extract the last user-turn text from the inbound body (Anthropic Messages format).
      // Used by runFusion to build judge/synthesis prompts.
      const extractUserPrompt = (bodyObj: Record<string, unknown>): string => {
        const msgs = bodyObj.messages;
        if (!Array.isArray(msgs) || msgs.length === 0) return '';
        // Walk backwards to find the last user message
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i] as Record<string, unknown>;
          if (m.role === 'user') {
            if (typeof m.content === 'string') return m.content;
            if (Array.isArray(m.content)) {
              return (m.content as Array<Record<string, unknown>>)
                .filter(b => b.type === 'text')
                .map(b => String(b.text ?? ''))
                .join('\n');
            }
          }
        }
        return '';
      };

      // Attempt to read the full JSON body from a (non-streaming) Response.
      const readResponseJson = async (resp: Response): Promise<Record<string, unknown> | null> => {
        try {
          const ct = resp.headers.get('content-type') || '';
          if (!ct.includes('application/json')) return null;
          return await resp.clone().json() as Record<string, unknown>;
        } catch { return null; }
      };

      // Extract text content from a Claude-format or OpenAI-format response payload.
      const extractResponseText = (payload: Record<string, unknown>): string => {
        // Anthropic Messages format
        if (Array.isArray(payload.content)) {
          return (payload.content as Array<Record<string, unknown>>)
            .filter(b => b.type === 'text')
            .map(b => String(b.text ?? ''))
            .join('\n');
        }
        // OpenAI completions format
        const choices = payload.choices as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(choices) && choices.length > 0) {
          const msg = choices[0].message as Record<string, unknown> | undefined;
          if (msg && typeof msg.content === 'string') return msg.content;
        }
        return '';
      };

      // ---- Fusion orchestrator ----
      const runFusion = async (plan: FusionPlan, bodyObj: Record<string, unknown>): Promise<Response> => {
        const { options } = plan;
        const fusionDepth = parseInt(request.headers.get('x-fusion-depth') || '0', 10);
        if (fusionDepth >= 1) {
          throw new Error(`fusion_invocation_capped: alias '${plan.alias}' cannot recursively invoke fusion`);
        }

        const userPrompt = extractUserPrompt(bodyObj);
        const panelErrors: Array<{ model: string; error: string }> = [];
        const panelTexts: Array<{ model: string; text: string }> = [];

        // ---- Stage 1: Panel fan-out (parallel, windowed by max_concurrent) ----
        const panelTargets = plan.panel;
        const batchSize = Math.max(1, Math.min(options.max_concurrent, panelTargets.length));

        for (let batchStart = 0; batchStart < panelTargets.length; batchStart += batchSize) {
          const batch = panelTargets.slice(batchStart, batchStart + batchSize);
          // Panel calls are always non-streaming so bodies can be buffered for aggregation
          const batchBodies = batch.map(t =>
            buildRouteAttempt(t.modelName, t.route, { ...bodyObj, stream: false })
          );
          // Attach fusion depth header to prevent recursive expansion.
          // Re-serialize body text (not stream) so Node.js fetch doesn't require duplex: 'half'.
          const batchTexts = await Promise.all(batchBodies.map(a => a.request.text()));
          const batchAttempts = batchBodies.map((a, i) => ({
            ...a,
            request: new Request(a.request.url, {
              method: a.request.method,
              headers: new Headers({ ...Object.fromEntries(a.request.headers.entries()), 'x-fusion-depth': '1' }),
              body: batchTexts[i],
            }),
          }));

          const timeoutMs = options.panel_timeout_ms;
          const settled = await Promise.allSettled(
            batchAttempts.map(a =>
              Promise.race([
                runAttempt(a),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error(`panel timeout after ${timeoutMs}ms`)), timeoutMs)
                ),
              ])
            )
          );

          for (let i = 0; i < batch.length; i++) {
            const result = settled[i];
            const modelName = batch[i].modelName;
            if (result.status === 'fulfilled') {
              const json = await readResponseJson(result.value);
              if (json) {
                const text = extractResponseText(json);
                if (text) {
                  panelTexts.push({ model: modelName, text });
                } else {
                  panelErrors.push({ model: modelName, error: 'empty response' });
                }
              } else {
                panelErrors.push({ model: modelName, error: 'non-JSON response' });
              }
            } else {
              panelErrors.push({ model: modelName, error: (result.reason as Error).message });
              logger.warn(requestId, `Fusion panel ${modelName} failed: ${(result.reason as Error).message}`);
            }
          }
        }

        if (panelTexts.length < options.min_panel) {
          const errorMsg = panelTexts.length === 0
            ? `all_panels_failed: no panel model returned a usable response (errors: ${panelErrors.map(e => `${e.model}: ${e.error}`).join('; ')})`
            : `insufficient_panels: only ${panelTexts.length}/${options.min_panel} required panels succeeded`;
          throw new Error(errorMsg);
        }

        logger.info(requestId, `Fusion panel complete: ${panelTexts.length} succeeded, ${panelErrors.length} failed`);

        // ---- Stage 2: Judge ----
        let analysis: Record<string, unknown> | null = null;
        if (plan.judge) {
          const panelSection = panelTexts
            .map(p => `--- MODEL: ${p.model} ---\n${p.text}`)
            .join('\n\n');
          const judgePromptText =
            `You are a meta-analyst comparing responses from multiple expert models.\n\n` +
            `ORIGINAL PROMPT:\n${userPrompt}\n\n` +
            `PANEL RESPONSES:\n${panelSection}\n\n` +
            `Produce ONLY valid JSON with these fields:\n` +
            `- consensus: string[] — points most/all models agree on\n` +
            `- contradictions: {topic:string, stances:{model:string,stance:string}[]}[]\n` +
            `- partial_coverage: {models:string[], point:string}[]\n` +
            `- unique_insights: {model:string, insight:string}[]\n` +
            `- blind_spots: string[] — angles no model addressed\n\n` +
            `Output ONLY the JSON object, no markdown fences.`;

          // Build judge body: replace messages with the judge prompt, always non-streaming
          const judgeMessages = [
            ...((bodyObj.messages as unknown[]) || []).slice(0, -1), // prior history minus last user turn
            { role: 'user', content: judgePromptText },
          ];
          const judgeBodyObj = { ...bodyObj, messages: judgeMessages, stream: false };

          const judgeAttempt = buildRouteAttempt(plan.judge.modelName, plan.judge.route, judgeBodyObj);
          const judgeBodyText = await judgeAttempt.request.text();
          const judgeAttemptWithDepth = {
            ...judgeAttempt,
            request: new Request(judgeAttempt.request.url, {
              method: judgeAttempt.request.method,
              headers: new Headers({ ...Object.fromEntries(judgeAttempt.request.headers.entries()), 'x-fusion-depth': '1' }),
              body: judgeBodyText,
            }),
          };

          try {
            const judgeResp = await runAttempt(judgeAttemptWithDepth);
            const judgeJson = await readResponseJson(judgeResp);
            if (judgeJson) {
              const judgeText = extractResponseText(judgeJson);
              // Strip optional markdown code fences
              const stripped = judgeText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
              analysis = JSON.parse(stripped) as Record<string, unknown>;
              logger.info(requestId, `Fusion judge complete for alias ${plan.alias}`);
            }
          } catch (e) {
            logger.warn(requestId, `Fusion judge failed: ${(e as Error).message}`);
            if (options.judge_required) {
              throw new Error(`judge_failed: ${(e as Error).message}`);
            }
            // degrade: analysis stays null, synthesis will use raw panel
          }
        }

        // ---- Stage 3: Synthesis ----
        let synthPromptText: string;
        if (analysis) {
          synthPromptText =
            `You are writing the final answer for the user.\n\n` +
            `ORIGINAL PROMPT: ${userPrompt}\n\n` +
            `STRUCTURED ANALYSIS FROM EXPERT PANEL:\n${JSON.stringify(analysis, null, 2)}\n\n` +
            `Instructions: Lead with consensus as the confident baseline. Present contradictions ` +
            `as nuanced disagreement with attribution. Include partial_coverage points with caveats. ` +
            `Highlight unique_insights as minority/expert perspectives. Explicitly address blind_spots. ` +
            `Write naturally — do not list the JSON fields.`;
        } else {
          // Degraded: no judge analysis; synthesise from raw panel responses
          const panelSection = panelTexts
            .map(p => `--- MODEL: ${p.model} ---\n${p.text}`)
            .join('\n\n');
          synthPromptText =
            `You are writing the final answer for the user.\n\n` +
            `ORIGINAL PROMPT: ${userPrompt}\n\n` +
            `PANEL RESPONSES (no structured analysis available):\n${panelSection}\n\n` +
            `Synthesise the above into a single coherent answer for the user.`;
        }

        const synthMessages = [
          ...((bodyObj.messages as unknown[]) || []).slice(0, -1),
          { role: 'user', content: synthPromptText },
        ];
        const synthBodyObj = { ...bodyObj, messages: synthMessages };
        // stream: pass through from the original request for the synth (client-visible) stage
        const synthAttempt = buildRouteAttempt(plan.synth.modelName, plan.synth.route, synthBodyObj);
        const synthBodyText = await synthAttempt.request.text();
        const synthAttemptWithDepth = {
          ...synthAttempt,
          request: new Request(synthAttempt.request.url, {
            method: synthAttempt.request.method,
            headers: new Headers({ ...Object.fromEntries(synthAttempt.request.headers.entries()), 'x-fusion-depth': '1' }),
            body: synthBodyText,
          }),
        };

        const synthResp = await runAttempt(synthAttemptWithDepth);

        // Attach fusion_metadata to non-streaming responses when expose_metadata is true
        if (options.expose_metadata && !bodyObj.stream) {
          const synthJson = await readResponseJson(synthResp);
          if (synthJson) {
            const metadata = {
              router: 'fusion',
              fusion_metadata: {
                alias: plan.alias,
                panel_models: plan.panel.map(p => p.modelName),
                judge_model: plan.judge?.modelName ?? null,
                synth_model: plan.synth.modelName,
                panel_errors: panelErrors,
                analysis_present: analysis !== null,
              },
            };
            const enriched = { ...synthJson, ...metadata };
            // Adding fusion_metadata changes the body size, so the upstream
            // Content-Length is stale and would truncate the client read.
            // Drop it and let the runtime recompute it for the new body.
            const enrichedHeaders = new Headers(synthResp.headers);
            enrichedHeaders.delete('content-length');
            return new Response(JSON.stringify(enriched), {
              status: synthResp.status,
              headers: enrichedHeaders,
            });
          }
        }

        return synthResp;
      };

      const runAttempt = async (attempt: RouteAttempt): Promise<Response> => {
        let attemptRequest = attempt.request;
        const attemptTargetUrl = attempt.targetUrl;
        const attemptHandlerType = attempt.handlerType;
        const attemptModelId = attempt.modelId;
        const attemptClientModel = attempt.clientModel;
        const attemptUpstreamMode = attempt.upstreamMode;
        const attemptForceStreaming = attempt.forceStreaming;
        let attemptAuthHeaders = attempt.authHeaders;
        const attemptRoute = attempt.route;

        // request_ingress: apply transforms to the inbound body before any handler sees it.
        if (attemptRoute && attemptRoute.transforms.length > 0) {
          const bodyText = await attemptRequest.clone().text();
          let parsedBody: Record<string, unknown>;
          try { parsedBody = JSON.parse(bodyText); } catch { parsedBody = {}; }
          const hookCtx: HookContext = {
            hook: 'request_ingress',
            route: attemptRoute,
            upstreamMode: attemptUpstreamMode || 'openai-completions',
            clientModel: (parsedBody.model as string) || attemptModelId || 'unknown',
            requestId,
            streaming: parsedBody.stream === true,
            logger,
          };
          const transformed = runHook('request_ingress', { body: parsedBody, headers: attemptAuthHeaders }, hookCtx);
          // Builtins/ops mutate `body` in place, so `transformed.body` keeps the
          // same reference as `parsedBody` — an identity check can't detect the
          // change. Always rebuild the request from the (possibly mutated) body.
          attemptRequest = new Request(attemptRequest.url, {
            method: attemptRequest.method,
            headers: attemptRequest.headers,
            body: JSON.stringify(transformed.body),
          });
          attemptAuthHeaders = transformed.headers;
        }

        // Debug: one line per request showing the resolved transform sets and per-hook op counts.
        if (attemptRoute && attemptRoute.transforms.length > 0) {
          const transformsLine = formatTransformsDebug(attemptRoute.transforms);
          if (transformsLine) logger.debug(requestId, transformsLine);
        }

        // Debug log routing info for test model requests (LOG_LEVEL=debug)
        if (path === '/v1/messages' && env.LOG_LEVEL === 'debug') {
          try {
            const clonedBody = attemptRequest.clone();
            const bodyText = await clonedBody.text();
            const { writeFileSync } = await import('fs');
            writeFileSync('/tmp/test_model.log',
              `[${new Date().toISOString()}] proxy routing\n` +
              `path: ${path}\n` +
              `targetUrl: ${attemptTargetUrl}\n` +
              `upstreamMode: ${attemptUpstreamMode}\n` +
              `modelId: ${attemptModelId}\n` +
              `handlerType: ${attemptHandlerType}\n` +
              `authHeaders: ${JSON.stringify(Object.keys(attemptAuthHeaders))}\n` +
              `request body:\n${JSON.stringify(JSON.parse(bodyText), null, 2)}\n`,
            );
          } catch (_e) {
            try {
              const { writeFileSync } = await import('fs');
              writeFileSync('/tmp/test_model.log', `[${new Date().toISOString()}] proxy routing - failed to log request body: ${(_e as Error).message}\n`);
            } catch {}
          }
        }

        // Route to appropriate handler
        let response: Response;

        // Build conversionOptions once for all handlers that need it
        // (messages, interactions, generateContent — anything that may go
        // through openai-completions and strip thinking → reasoning_effort).
        const conversionOptions: ThinkingConversionOptions = {};
        {
          const general = proxyConfig.general;
          const low = general?.budget_to_effort_low;
          if (low !== undefined && low !== '') {
            const val = parseInt(String(low));
            if (!isNaN(val)) conversionOptions.budget_to_effort_low = val;
          }
          const medium = general?.budget_to_effort_medium;
          if (medium !== undefined && medium !== '') {
            const val = parseInt(String(medium));
            if (!isNaN(val)) conversionOptions.budget_to_effort_medium = val;
          }
          const high = general?.budget_to_effort_high;
          if (high !== undefined && high !== '') {
            const val = parseInt(String(high));
            if (!isNaN(val)) conversionOptions.budget_to_effort_high = val;
          }
        }

        switch (attemptHandlerType) {
          case 'models':
            response = await handleModelsRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, logger, env as unknown as Record<string, unknown>, configuredModelIds);
            break;

          case 'token-counting':
            response = await handleTokenCountingRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, env, logger);
            break;

          case 'messages':
            if (attemptUpstreamMode === 'anthropic-messages') {
              response = await handleClaudeRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger, attemptRoute);
            } else if (attemptUpstreamMode === 'gemini-generatecontent' || attemptUpstreamMode === 'gemini-interactions') {
              response = await handleGeminiRequestForMessages(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger, attemptRoute);
            } else {
              // covers openai-completions and openai-responses
              response = await handleMessagesRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger, conversionOptions, attemptUpstreamMode, attemptRoute);
            }
            break;

          case 'interactions':
            if (attemptUpstreamMode === 'gemini-generatecontent' || attemptUpstreamMode === 'gemini-interactions') {
              response = await handleGeminiRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger, attemptRoute);
            } else {
              response = await handleOpenAIRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger, attemptForceStreaming, conversionOptions, attemptUpstreamMode, attemptRoute);
            }
            break;

          case 'generateContent':
            if (attemptUpstreamMode === 'gemini-generatecontent' || attemptUpstreamMode === 'gemini-interactions') {
              response = await handleGeminiRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger, attemptRoute);
            } else {
              response = await handleOpenAIRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger, attemptForceStreaming, conversionOptions, attemptUpstreamMode, attemptRoute);
            }
            break;

          case 'responses':
            response = await handleResponsesRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger, attemptUpstreamMode, attemptRoute);
            break;

          case 'responses-input-tokens':
            response = await handleResponsesInputTokensRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger, attemptUpstreamMode, attemptRoute);
            break;

          case 'responses-compact':
            response = await handleResponsesCompactRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, attemptModelId, env, logger, attemptUpstreamMode, attemptRoute);
            break;

          case 'chat-completions':
            response = await handleChatCompletionsPassthrough(
              attemptRequest, attemptTargetUrl, attemptAuthHeaders,
              requestId, logger, env, attemptModelId, attemptUpstreamMode, attemptRoute
            );
            break;

          case 'embeddings':
            response = await handleEmbeddingsRequest(attemptRequest, attemptTargetUrl, attemptAuthHeaders, requestId, logger, env);
            break;

          default:
            throw new Error(`Unsupported handler type: ${attemptHandlerType}`);
        }

        if (attemptModelId) {
          if (response.status >= 400) {
            recordModelFailedRequest(attemptModelId);
          } else {
            recordModelStat(attemptModelId);
          }
          recordModelTiming(attemptModelId, Date.now() - requestStartTime);
        }
        recordResponseUpstream(attemptTargetUrl);
        recordResponseStatusCodeToEndpoint(response.status);

        if (response.ok && attemptModelId) {
          const contentType = response.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            try {
              const responseForStats = response.clone();
              const payload = await responseForStats.json();
              const usage = extractUsageFromResponsePayload(payload);
              if (usage) {
                recordModelUsage(attemptModelId, usage);
                if (modelUsageRecordUrl) {
                  recordModelUsageToRemote(
                    modelUsageRecordUrl,
                    buildModelUsageRecordPayload(
                      requestId, path, endpointUserKey, attemptModelId, usage, response.status,
                      modelUsageRecordBody ? payload : undefined,
                    ),
                    logger,
                    modelUsageOneTimeAuthCode,
                    sidecarForwardedHeaders,
                  );
                }
                if (compositeAliasName && usage.total_tokens) {
                  recordCompositeTokenUsage(compositeAliasName, attemptModelId, usage.total_tokens);
                }
              }
              const toolNames = extractToolNamesFromResponsePayload(payload);
              recordUpstreamResponseToolNames(toolNames, attempt.agent);
            } catch {
              // ignore stats extraction failures
            }
          } else if (contentType.includes('text/event-stream')) {
            // For streaming responses, intercept the SSE stream to capture token usage
            // from Claude SSE events (message_start.usage.input_tokens,
            // message_delta.usage.output_tokens)
            const usageStream = createUsageTrackingTransformStream(
              attemptModelId,
              compositeAliasName,
              modelUsageRecordUrl
                ? (usage, responseBody) => recordModelUsageToRemote(
                  modelUsageRecordUrl,
                  buildModelUsageRecordPayload(
                    requestId, path, endpointUserKey, attemptModelId, usage, 200,
                    modelUsageRecordBody ? responseBody : undefined,
                  ),
                  logger,
                  modelUsageOneTimeAuthCode,
                  sidecarForwardedHeaders,
                )
                : undefined,
              modelUsageRecordBody,
            );
            const toolStream = createResponseToolTrackingTransformStream((names, agent) => recordUpstreamResponseToolNames(names, agent), attempt.agent);
            response = new Response(response.body!.pipeThrough(usageStream).pipeThrough(toolStream), response);
          }
        } else if (attemptModelId) {
          // Non-2xx upstream response: record it to the remote stats service
          // with zero usage and the real status, so the collector sees failed
          // requests too. When record_response_body is on, attach the constructed error
          // body (best-effort parse for JSON; raw text otherwise).
          if (modelUsageRecordUrl) {
            let errorBody: unknown;
            if (modelUsageRecordBody) {
              try {
                const ct = response.headers.get('content-type') || '';
                if (ct.includes('application/json')) {
                  errorBody = await response.clone().json();
                } else {
                  errorBody = await response.clone().text();
                }
              } catch {
                errorBody = undefined;
              }
            }
            const zeroUsage = {
              input_tokens: 0,
              cached_tokens: 0,
              cache_written_tokens: 0,
              output_tokens: 0,
              total_tokens: 0,
            };
            recordModelUsageToRemote(
              modelUsageRecordUrl,
              buildModelUsageRecordPayload(
                requestId, path, endpointUserKey, attemptModelId, zeroUsage, response.status,
                errorBody,
              ),
              logger,
              modelUsageOneTimeAuthCode,
              sidecarForwardedHeaders,
            );
          }
        }

        // response_egress: apply header + body transforms on the response going back to the client.
        if (attemptRoute && attemptRoute.transforms.length > 0) {
          // Re-read content-type after any streaming filter pipes applied above.
          const writeoutContentType = response.headers.get('content-type') || '';
          const writeoutCtx: HookContext = {
            hook: 'response_egress',
            route: attemptRoute,
            upstreamMode: attemptUpstreamMode || 'openai-completions',
            clientModel: attemptClientModel || attemptModelId || 'unknown',
            requestId,
            streaming: writeoutContentType.includes('text/event-stream'),
            logger,
            status: response.status,
          };

          // Body ops: buffered JSON rewrite (mirrors applyAfterUpstream shape).
          // Note: stats extraction above used response.clone() so its body is
          // already consumed — applyWriteoutBody works on the original here.
          // For streams: skip buffered JSON rewrite (would break streaming) and
          // let pipeEventTransformer handle per-event rewriting below.
          if (!writeoutCtx.streaming) {
            response = await applyWriteoutBody(response, writeoutCtx);
          }

          // SSE per-event rewrite: only when no JSON body ops changed the
          // response and content is still a stream. applyWriteoutBody is a no-op
          // for non-JSON, so response.body is intact.
          const responseContentType = response.headers.get('content-type') || '';
          if (response.body && responseContentType.includes('text/event-stream')) {
            const evtStream = pipeEventTransformer(response.body, writeoutCtx);
            if (evtStream) {
              response = new Response(evtStream, {
                status: response.status,
                statusText: response.statusText,
                headers: sanitizeUpstreamResponseHeaders(response),
              });
            }
          }

          // Header ops: also wired centrally here (run before body so headers
          // shape the new Response). Seed with sanitized headers so transforms
          // never observe a stale content-encoding from a decompressed body.
          const responseHeaders: Record<string, string> = {};
          sanitizeUpstreamResponseHeaders(response).forEach((v, k) => { responseHeaders[k] = v; });
          const { headers: transformedHeaders } = runHook('response_egress', { body: {}, headers: responseHeaders }, writeoutCtx);
          if (transformedHeaders !== responseHeaders) {
            const newHeaders = new Headers(transformedHeaders);
            response = new Response(response.body, { status: response.status, statusText: response.statusText, headers: newHeaders });
          }
        }

        return response;
      };

      // ---- Fusion dispatch ----
      const _fusionPlan = (request as any)._fusionPlan as FusionPlan | undefined;
      const _fusionBody = (request as any)._fusionBody as Record<string, unknown> | undefined;
      if (_fusionPlan && _fusionBody) {
        const fusionResp = await runFusion(_fusionPlan, _fusionBody);
        recordRequestTiming(path, Date.now() - requestStartTime);
        return applyCorsHeaders(await restorePrivacyResponse(fusionResp, piiMapping, requestId, logger), request, env);
      }

      if (compositeAttempts && compositeAttempts.length > 0) {
        let lastError: unknown;
        for (let i = 0; i < compositeAttempts.length; i++) {
          const attempt = compositeAttempts[i];
          try {
            logger.info(requestId, `${new URL(attempt.request.url).pathname},${scheduleAliasName ?? compositeAliasName ?? attempt.modelId},${attempt.targetUrl}`);
            const response = await runAttempt(attempt);
            // Gradual share recovery: a successful primary or fallback attempt
            // doubles its effective share back toward the configured value
            // (symmetric with the halving on failure), so a healthy-again
            // target regains traffic instead of staying decayed until restart.
            if (attempt.compositeTargetConfig && compositeAliasName && attempt.compositeTargetName) {
              const isPrimary = attempt.compositeTargetConfig.primary === true;
              const fallbackNum = attempt.compositeTargetConfig.fallback;
              const isFallback = typeof fallbackNum === 'number' && fallbackNum > 0;
              if (isPrimary || isFallback) {
                const configuredShare = getConfiguredCompositeShare(attempt.compositeTargetConfig);
                const { previous, next } = recoverEffectiveCompositeShare(compositeAliasName, attempt.compositeTargetName, configuredShare);
                if (next > previous) {
                  const role = isPrimary ? 'primary' : `fallback(${fallbackNum})`;
                  logger.info(requestId, `Composite ${role} ${compositeAliasName}.${attempt.compositeTargetName} succeeded; effective share ${previous} -> ${next} (cap ${configuredShare})`);
                }
              }
            }
            recordRequestTiming(path, Date.now() - requestStartTime);
            return applyCorsHeaders(await restorePrivacyResponse(response, piiMapping, requestId, logger), attempt.request, env);
          } catch (error) {
            lastError = error;
            // Transport errors (DNS / refused / TLS / abort) arrive as plain
            // Error and would skip the share-decay branch below (which only
            // matches ClaudeProxyError). Classify up-front so a dead target
            // still gets penalized, and so the decay log line has a real
            // status (502/504) instead of '-'. The raw error is preserved on
            // lastError so the outer catch still sees the original message.
            const classifiedError = error instanceof ClaudeProxyError
              ? error
              : (classifyTransportError(error) ?? error);
            if (attempt.modelId) {
              failedModelId = attempt.modelId;
              recordModelFailedRequest(attempt.modelId);
              modelFailureRecorded = true;
            }
            if (classifiedError instanceof ClaudeProxyError && compositeAliasName && attempt.compositeTargetName && attempt.compositeTargetConfig) {
              const isPrimary = attempt.compositeTargetConfig.primary === true;
              const fallbackNum = attempt.compositeTargetConfig.fallback;
              const isFallback = typeof fallbackNum === 'number' && fallbackNum > 0;
              if (isPrimary || isFallback) {
                const configuredShare = getConfiguredCompositeShare(attempt.compositeTargetConfig);
                const { previous, next, floor } = decayEffectiveCompositeShare(compositeAliasName, attempt.compositeTargetName, configuredShare);
                const role = isPrimary ? 'primary' : `fallback(${fallbackNum})`;
                logger.warn(requestId, `Composite ${role} ${compositeAliasName}.${attempt.compositeTargetName} returned ${classifiedError.status}; effective share ${previous} -> ${next} (floor ${floor})`);
              }
            }
            if (i < compositeAttempts.length - 1) {
              logger.warn(requestId, `Composite attempt ${i + 1}/${compositeAttempts.length} failed for model=${attempt.modelId}: ${(error as Error).message}; retrying next candidate`);
            }
          }
        }
        throw (lastError as Error);
      }

      failedModelId = modelId;
      const response = await runAttempt({
        request,
        targetUrl,
        handlerType,
        modelId,
        clientModel: clientRequestedModel,
        upstreamMode,
        forceStreaming,
        authHeaders: modelAuthHeaders,
        agent,
        route: outerRoute,
      });

      // Apply CORS headers
      recordRequestTiming(path, Date.now() - requestStartTime);
      return applyCorsHeaders(await restorePrivacyResponse(response, piiMapping, requestId, logger), request, env);

    } catch (error) {
      // Handle errors with Claude API format (without exposing sensitive info)
      if (!modelFailureRecorded && failedModelId) {
        recordModelFailedRequest(failedModelId);
      }
      const err = error as Error & { status?: number; type?: string };
      logger.error(requestId, `Catch Error [model=${failedModelId ?? '-'} status=${err.status ?? '-'} type=${err.type ?? '-'}: ${err.message}`);
      recordRequestTiming(path, Date.now() - requestStartTime);
      recordModelTiming(failedModelId, Date.now() - requestStartTime);
      return createErrorResponse(error as Error, requestId);
    }
    })();

    // Defer the in-flight decrement until the response body has finished
    // streaming to the client. server.ts consumes this release when it's done
    // piping the body (or immediately for non-streaming/error responses). If the
    // request was never counted (preflight returns before increment) this is a
    // no-op. The release is once-guarded so a redundant call here as a safety net
    // can't double-decrement.
    if (releaseActiveRequest) {
      attachActiveRequestRelease(finalResponse, releaseActiveRequest);
    }
    return finalResponse;
  },
};
