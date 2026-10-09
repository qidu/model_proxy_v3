/**
 * Dynamic routing utility for Claude Proxy v3
 *
 * Handles URL patterns like:
 * - /v1/models (Models API)
 * - /https/api.qnaigc.com/v1/models (Models API)
 * - /https/api.qnaigc.com/openai/v1/models/deepseek-v3.1/v1/messages/count_tokens (Token Counting API)
 * - /https/api.qnaigc.com/openai/v1/models/deepseek-v3.1/v1/messages (Messages API)
 */

import { validateBetaFeatures as validateBetaFeaturesUtil } from './beta-features.js';
import { createLogger } from './logger.js';
import { pickRawApiKey } from './auth-headers.js';

export { parseDynamicRoute, getHandlerType, buildTargetUrl, extractAuthHeaders, transformAuthHeadersForUpstream, isHostAllowed, getAllowedHosts, formatApiKeyForUpstream };

// Default allowed hosts for SSRF protection
const DEFAULT_ALLOWED_HOSTS = ['127.0.0.1', 'localhost'];

/**
 * Returns true if the given hostname / IP resolves to localhost, a private
 * RFC-1918 range, or a link-local range — i.e. it is safe to use as the
 * target of an internal sidecar or config-server URL.
 *
 * Accepted:
 *   - localhost / 127.x.x.x  (loopback)
 *   - ::1                    (IPv6 loopback)
 *   - 10.0.0.0/8             (RFC 1918)
 *   - 172.16.0.0/12          (RFC 1918)
 *   - 192.168.0.0/16         (RFC 1918)
 *   - 169.254.0.0/16         (link-local / APIPA)
 *   - fc00::/7               (IPv6 ULA)
 *   - fe80::/10              (IPv6 link-local)
 *   - *.local                (mDNS)
 */
export function isInternalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, '').replace(/\]$/, ''); // strip IPv6 brackets

  // Loopback
  if (h === 'localhost' || h === '::1') return true;
  if (h.endsWith('.local')) return true;

  // IPv4 dotted-decimal checks
  const ipv4Parts = h.split('.');
  if (ipv4Parts.length === 4) {
    const [a, b, c] = ipv4Parts.map(Number);
    if (a === 127) return true;                          // 127.0.0.0/8 loopback
    if (a === 10) return true;                           // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16 link-local
  }

  // IPv6 private ranges (text prefix checks are sufficient for well-formed addresses)
  if (h === '::1') return true;
  if (h.startsWith('fc') || h.startsWith('fd')) return true; // fc00::/7 ULA
  if (h.startsWith('fe8') || h.startsWith('fe9') ||
      h.startsWith('fea') || h.startsWith('feb')) return true; // fe80::/10 link-local

  return false;
}

export interface TargetConfig {
  targetUrl: string;
  targetPathPrefix: string;
}

export interface ParsedRoute {
  targetConfig: TargetConfig;
  claudeEndpoint: string;
  modelId?: string;
}

/**
 * Validate if a host is allowed based on the ALLOWED_HOSTS environment variable
 */
function isHostAllowed(host: string, allowedHostsEnv?: string): boolean {
  const allowedHosts = allowedHostsEnv
    ? allowedHostsEnv.split(',').map(h => h.trim().toLowerCase()).filter(h => h.length > 0)
    : DEFAULT_ALLOWED_HOSTS;

  const normalizedHost = host.toLowerCase();

  return allowedHosts.some(allowed => {
    // Exact match
    if (allowed === normalizedHost) {
      return true;
    }
    // Handle wildcard domain (e.g., "*.example.com")
    if (allowed.startsWith('*.')) {
      const domain = allowed.slice(2);
      return normalizedHost === domain || normalizedHost.endsWith('.' + domain);
    }
    return false;
  });
}

/**
 * Get list of allowed hosts from environment or defaults
 */
function getAllowedHosts(allowedHostsEnv?: string): string[] {
  if (!allowedHostsEnv) {
    return DEFAULT_ALLOWED_HOSTS;
  }
  return allowedHostsEnv.split(',').map(h => h.trim()).filter(h => h.length > 0);
}

/**
 * Parse dynamic routing URL
 *
 * Expected format: /{claude_endpoint}
 * Expected format: /{protocol}{host}{path_prefix}/{model_id?}/{claude_endpoint}
 *
 * Examples:
 * - /v1/models
 * - /https/api.qnaigc.com/openai/v1/models
 * - /https/api.qnaigc.com/openai/v1/models/deepseek-v3.1/v1/messages
 * - /https/api.qnaigc.com/openai/v1/models/deepseek-v3.1/v1/messages/count_tokens
 */
function parseDynamicRoute(url: string): ParsedRoute {
  // Remove leading slash if present
  let path = url.startsWith('/') ? url.slice(1) : url;

  // Split by forward slashes
  const parts = path.split('/');

  if (parts.length < 4) {
    throw new Error(`Invalid URL format: ${url}. Expected format: /{protocol}{host}{path_prefix}/{model_id?}/{claude_endpoint}`);
  }

  // First part is the protocol (http or https)
  const protocol = parts[0];
  if (protocol !== 'http' && protocol !== 'https') {
    throw new Error(`Invalid protocol: ${protocol}. Must be 'http' or 'https'`);
  }

  // Second part is the host (e.g., api.qnaigc.com)
  let host = parts[1];

  // Find where the target API path ends and Claude endpoint begins
  // We look for known Claude endpoints: v1/models, v1/messages, v1/messages/count_tokens
  let targetPathEndIndex = -1;
  let claudeEndpointStartIndex = -1;

  // Look for Claude endpoint patterns from the end
  for (let i = parts.length - 1; i >= 2; i--) {
    if (parts[i] === 'v1' || parts[i] === 'v1beta') {
      // Check if this is a Claude endpoint
      const nextPart = i + 1 < parts.length ? parts[i + 1] : null;
      const twoPartsAhead = i + 2 < parts.length ? parts[i + 2] : null;

      if (nextPart === 'models' || nextPart === 'messages' || nextPart === 'interactions') {
        // Found a potential Claude endpoint
        targetPathEndIndex = i - 1;
        claudeEndpointStartIndex = i;
        break;
      }

      if (nextPart === 'messages' && twoPartsAhead === 'count_tokens') {
        // Found token counting endpoint
        targetPathEndIndex = i - 1;
        claudeEndpointStartIndex = i;
        break;
      }
    }
  }

  if (targetPathEndIndex === -1 || claudeEndpointStartIndex === -1) {
    throw new Error(`Could not locate Claude endpoint in URL: ${url}`);
  }

  // Extract Claude endpoint path
  const claudeEndpointPath = parts.slice(claudeEndpointStartIndex).join('/');

  // Determine if there's a model ID between target path and Claude endpoint
  let modelId: string | undefined;
  const betweenParts = parts.slice(targetPathEndIndex + 1, claudeEndpointStartIndex);
  if (betweenParts.length === 1) {
    // Likely a model ID
    modelId = betweenParts[0];
  } else if (betweenParts.length > 1) {
    // This might be part of the target path, adjust accordingly
    targetPathEndIndex = claudeEndpointStartIndex - 1;
    modelId = undefined;

    // Recalculate
    const newTargetPathPrefix = parts.slice(2, targetPathEndIndex + 1).join('/');
    throw new Error(`Unclear URL structure. Between target path '${newTargetPathPrefix}' and Claude endpoint '${claudeEndpointPath}' found: ${betweenParts.join('/')}`);
  } else if (betweenParts.length === 0) {
    // Check if the last element of target path prefix might be a model ID
    // Model IDs typically don't contain slashes and aren't common API path segments
    const targetPathParts = parts.slice(2, targetPathEndIndex + 1);
    if (targetPathParts.length > 0) {
      const lastPart = targetPathParts[targetPathParts.length - 1];
      // Check if last part looks like a model ID (not a common API path segment)
      const commonPathSegments = ['v1', 'v2', 'models', 'messages', 'completions', 'chat', 'openai', 'api'];
      if (!commonPathSegments.includes(lastPart) &&
          !lastPart.includes('/') &&
          lastPart.length > 0) {
        // This might be a model ID, extract it
        modelId = lastPart;
        // Adjust target path prefix to exclude the model ID
        targetPathEndIndex = targetPathEndIndex - 1;
      }
    }
  }

  // Recalculate target path prefix in case we adjusted for model ID
  const targetPathPrefix = parts.slice(2, targetPathEndIndex + 1).join('/');

  const targetConfig: TargetConfig = {
    targetUrl: `${protocol}://${host}`,
    targetPathPrefix: targetPathPrefix ? `/${targetPathPrefix}` : '',
  };

  return {
    targetConfig,
    claudeEndpoint: claudeEndpointPath,
    modelId,
  };
}

/**
 * Build target URL for API request
 */
function buildTargetUrl(targetConfig: TargetConfig, endpoint: string, modelId?: string): string {
  let url = `${targetConfig.targetUrl}${targetConfig.targetPathPrefix}`;

  if (modelId) {
    url += `/${modelId}`;
  }

  url += `/${endpoint}`;
  return url;
}

/**
 * Append `suffix` to `baseUrl` unless baseUrl already points at a known full
 * upstream endpoint path. Providers occasionally configure base_url to the
 * complete endpoint (e.g. ".../v1/messages" or ".../v1/chat/completions") and
 * appending the suffix again would produce an invalid doubled path.
 *
 * Recognised full-endpoint markers (case-insensitive substring match):
 *   - /v1/messages, /anthropic/messages      (anthropic-messages)
 *   - /v1/chat/completions, /v1/interactions  (openai-completions / interactions)
 *   - /v1/responses, /openai/responses        (openai-responses, incl. Azure)
 *   - /v1beta/models/{model}:generateContent, :streamGenerateContent, :countTokens
 *
 * If none match but the exact suffix is already present in baseUrl, the
 * baseUrl is returned unchanged to avoid duplicating the path segment.
 */
const GEMINI_ACTION_SUFFIXES = ['generatecontent', 'streamgeneratecontent', 'counttokens'];

export function buildUpstreamUrl(baseUrl: string, suffix: string): string {
  const lowerBase = baseUrl.toLowerCase();

  // Full-endpoint markers — base_url already points at the complete path.
  if (
    lowerBase.includes('/v1/messages') ||
    lowerBase.includes('/anthropic/messages') ||
    lowerBase.includes('/chat/completions') ||
    lowerBase.includes('/v1/interactions') ||
    lowerBase.includes('/v1/responses') ||
    lowerBase.includes('/openai/responses')
  ) {
    return baseUrl;
  }

  // Gemini full endpoint URLs like /v1beta/models/{model}:generateContent
  if (lowerBase.includes('/v1beta/models/') || lowerBase.includes('/v1/models/')) {
    if (GEMINI_ACTION_SUFFIXES.some(action => lowerBase.includes(`:${action}`))) {
      return baseUrl;
    }
  }

  // Version-dedupe: if base_url already ends with a version segment (v1, v2,
  // v4, v1beta, …) and the suffix begins with its own version segment, strip
  // the suffix's leading version to avoid a doubled segment like /v4/v1/...
  // The base's version wins (e.g. /v4 + v1/chat/completions -> /v4/chat/completions).
  const suffixMatch = suffix.match(/^(v\d+[a-z]*)\/(.*)$/i);
  if (suffixMatch && lowerBase.match(/\/v\d+[a-z]*\/?$/)) {
    return `${baseUrl.replace(/\/$/, '')}/${suffixMatch[2]}`;
  }

  // Defensive: exact suffix already present — don't duplicate.
  if (lowerBase.includes(`/${suffix.toLowerCase()}`)) {
    return baseUrl;
  }

  return `${baseUrl}/${suffix}`;
}

/**
 * Extract authentication headers from request
 *
 * Supports both Authorization and X-Api-Key headers.
 * If X-Api-Key is provided but Authorization is missing,
 * converts X-Api-Key to Authorization: Bearer format.
 * Also extracts Claude Code Gateway required headers for forwarding.
 */
function extractAuthHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};

  // Extract Authorization header
  let authHeader = request.headers.get('Authorization');

  // Extract API key headers
  const apiKeyHeader = request.headers.get('x-api-key');
  const googApiKeyHeader = request.headers.get('x-goog-api-key');

  // If X-Api-Key is provided but Authorization is missing, convert it
  if (apiKeyHeader && !authHeader) {
    // Check if X-Api-Key already has Bearer prefix
    if (apiKeyHeader.startsWith('Bearer ')) {
      headers['Authorization'] = apiKeyHeader;
    } else {
      headers['Authorization'] = `Bearer ${apiKeyHeader}`;
    }
  } else if (authHeader) {
    headers['Authorization'] = authHeader;
  }

  // If x-goog-api-key is provided, preserve it for Gemini native API
  if (googApiKeyHeader) {
    headers['x-goog-api-key'] = googApiKeyHeader;
  }

  // Forward beta feature headers (verbatim, carries OAuth)
  const betaVersionHeader = request.headers.get('anthropic-beta');
  if (betaVersionHeader) {
    // Validate beta features
    const validatedFeatures = validateBetaFeaturesUtil(betaVersionHeader);
    if (validatedFeatures) {
      headers['anthropic-beta'] = JSON.stringify(validatedFeatures);
    } else {
      // Forward as-is if validation fails (should still work)
      headers['anthropic-beta'] = betaVersionHeader.replace(/[\r\n\0]/g, '');
    }
  }

  // Forward anthropic-version header (required by Claude Code Gateway)
  const anthropicVersion = request.headers.get('anthropic-version');
  if (anthropicVersion) {
    headers['anthropic-version'] = anthropicVersion;
  }

  // Forward anthropic-workspace-id header (AWS Bedrock)
  const workspaceId = request.headers.get('anthropic-workspace-id');
  if (workspaceId) {
    headers['anthropic-workspace-id'] = workspaceId;
  }

  // Forward x-claude-code-* hint headers (opt-in gateway hints)
  // Per spec: request-class, agent-type, compaction, context-compacted, prev-tool-durations, prompt-id
  for (const [key, value] of request.headers.entries()) {
    if (key.startsWith('x-claude-code-')) {
      headers[key] = value;
    }
  }

  return headers;
}

/**
 * Transform auth headers to match upstream mode requirements
 * Extracts API key from request headers and formats it correctly for the target upstream
 * Respects endpoint-specific header preferences
 */
function transformAuthHeadersForUpstream(
  request: Request,
  upstreamMode: string,
  endpointPath?: string,
  requestId?: string,
  env?: Record<string, unknown>
): Record<string, string> {
  const headers: Record<string, string> = {};

  // Extract raw API key from headers with endpoint-specific priority
  let apiKey: string | null = null;

  const googApiKey = request.headers.get('x-goog-api-key');
  const xApiKey = request.headers.get('x-api-key');
  const authHeader = request.headers.get('Authorization');

  // Logging for header extraction
  if (requestId) {
    const logger = createLogger(env ?? {});
    if (googApiKey) {
      const partialGoogKey = googApiKey.length > 4 ? `${googApiKey.substring(0, 4)}...` : '***';
      logger.debug(requestId, `Found x-goog-api-key header: ${partialGoogKey}`);
    }
    if (xApiKey) {
      const partialXApiKey = xApiKey.length > 4 ? `${xApiKey.substring(0, 4)}...` : '***';
      logger.debug(requestId, `Found x-api-key header: ${partialXApiKey}`);
    }
    if (authHeader) {
      const partialAuth = authHeader.length > 4 ? `${authHeader.substring(0, 4)}...` : '***';
      logger.debug(requestId, `Found Authorization header: ${partialAuth}`);
    }
    logger.debug(requestId, `Endpoint path: ${endpointPath}, Upstream mode: ${upstreamMode}`);
  }
  
  // Determine priority based on endpoint
  const isMessagesEndpoint = endpointPath?.startsWith('/v1/messages');
  const isOpenAIEndpoint = upstreamMode === 'openai-completions' || upstreamMode === 'openai-responses';
  const isGeminiEndpoint = isGeminiApiPath(endpointPath);

  if (isMessagesEndpoint) {
    // /v1/messages: x-api-key > Authorization (no x-goog-api-key)
    apiKey = pickRawApiKey([xApiKey, authHeader]);
  } else if (isOpenAIEndpoint) {
    // OpenAI endpoints: Authorization > x-api-key (no x-goog-api-key)
    apiKey = pickRawApiKey([authHeader, xApiKey]);
  } else if (isGeminiEndpoint) {
    // Gemini endpoints prefer x-goog-api-key
    apiKey = pickRawApiKey([googApiKey, xApiKey, authHeader]);
  } else {
    // Default: Authorization > x-api-key > x-goog-api-key
    apiKey = pickRawApiKey([authHeader, xApiKey, googApiKey]);
  }
  
  // If no API key found, return empty headers
  if (!apiKey) {
    return headers;
  }
  
  // Format header based on upstream mode
  switch (upstreamMode) {
    case 'anthropic-messages':
      // Claude API uses x-api-key header
      headers['x-api-key'] = apiKey;
      break;
      
    case 'gemini-generatecontent':
    case 'gemini-interactions':
      // Gemini native API uses x-goog-api-key header
      headers['x-goog-api-key'] = apiKey;
      break;
      
    case 'openai-completions':
      // OpenAI-compatible uses Authorization Bearer
      headers['Authorization'] = `Bearer ${apiKey}`;
      break;
      
    default:
      // Default to Authorization Bearer for unknown modes
      headers['Authorization'] = `Bearer ${apiKey}`;
  }
  
  // Forward beta feature headers for Claude
  if (upstreamMode === 'anthropic-messages') {
    const betaVersionHeader = request.headers.get('anthropic-beta');
    if (betaVersionHeader) {
      const validatedFeatures = validateBetaFeaturesUtil(betaVersionHeader);
      if (validatedFeatures) {
        headers['anthropic-beta'] = JSON.stringify(validatedFeatures);
      } else {
        headers['anthropic-beta'] = betaVersionHeader.replace(/[\r\n\0]/g, '');
      }
    }
  }

  // Forward other Claude Code Gateway required headers (verbatim)
  // These are extracted by extractAuthHeaders and passed via authHeaders,
  // but we also forward them directly from request for any path using this function
  const anthropicVersion = request.headers.get('anthropic-version');
  if (anthropicVersion) {
    headers['anthropic-version'] = anthropicVersion;
  }

  const workspaceId = request.headers.get('anthropic-workspace-id');
  if (workspaceId) {
    headers['anthropic-workspace-id'] = workspaceId;
  }

  // Forward x-claude-code-* hint headers (opt-in gateway hints)
  for (const [key, value] of request.headers.entries()) {
    if (key.startsWith('x-claude-code-')) {
      headers[key] = value;
    }
  }

  return headers;
}



/**
 * True for Gemini native API paths: the interactions API (v1 and v1beta) and
 * models/{id} calls with any method suffix. The bare v1[/beta]/models model-list
 * endpoint is excluded — it is OpenAI-convention and classified separately.
 * Accepts paths with or without a leading slash.
 */
function isGeminiApiPath(path: string | undefined): boolean {
  if (!path) return false;
  const p = path.startsWith('/') ? path.slice(1) : path;
  return p.startsWith('v1/interactions') ||
         p.startsWith('v1beta/interactions') ||
         /^v1(?:beta)?\/models\/[^/]+/.test(p);
}

/**
 * Determine handler type based on Claude endpoint
 */
function getHandlerType(claudeEndpoint: string): 'models' | 'token-counting' | 'messages' | 'interactions' | 'generateContent' {
  if (claudeEndpoint === 'v1/models') {
    return 'models';
  }

  if (claudeEndpoint === 'v1/messages/count_tokens') {
    return 'token-counting';
  }

  if (claudeEndpoint.startsWith('v1/messages')) {
    return 'messages';
  }

  // Gemini Interactions API endpoints
  if (isGeminiApiPath(claudeEndpoint) && (claudeEndpoint.startsWith('v1/interactions') || claudeEndpoint.startsWith('v1beta/interactions'))) {
    return 'interactions';
  }

  // Gemini generateContent endpoints
  if (isGeminiApiPath(claudeEndpoint) && claudeEndpoint.includes(':generateContent')) {
    return 'generateContent';
  }

  throw new Error(`Unknown Claude endpoint: ${claudeEndpoint}`);
}

/**
 * Format a raw API key for the target upstream mode
 */
function formatApiKeyForUpstream(apiKey: string, upstreamMode: string): Record<string, string> {
  const headers: Record<string, string> = {};

  // Format header based on upstream mode
  switch (upstreamMode) {
    case 'anthropic-messages':
      // Claude API uses x-api-key header
      headers['x-api-key'] = apiKey;
      break;

    case 'gemini-generatecontent':
    case 'gemini-interactions':
      // Gemini native API uses x-goog-api-key header
      headers['x-goog-api-key'] = apiKey;
      break;

    case 'openai-completions':
      // OpenAI-compatible uses Authorization Bearer
      headers['Authorization'] = `Bearer ${apiKey}`;
      break;

    default:
      // Default to Authorization Bearer for unknown modes
      headers['Authorization'] = `Bearer ${apiKey}`;
  }

  return headers;
}

/**
 * Get client IP from request headers
 * Supports Cloudflare Workers, proxies, and direct connections
 */
export function getClientIp(request: Request): string | undefined {
  // Cloudflare Workers
  const cfConnectingIp = request.headers.get('cf-connecting-ip');
  if (cfConnectingIp) return cfConnectingIp;

  // Standard proxy headers
  const xForwardedFor = request.headers.get('x-forwarded-for');
  if (xForwardedFor) return xForwardedFor.split(',')[0].trim();

  // Nginx proxy
  const xRealIp = request.headers.get('x-real-ip');
  if (xRealIp) return xRealIp;

  return undefined;
}

/**
 * Add x-forwarded-for header to auth headers for upstream requests
 */
export function addForwardedHeaders(authHeaders: Record<string, string>, request: Request): Record<string, string> {
  const clientIp = getClientIp(request);
  if (clientIp) {
    return { ...authHeaders, 'x-forwarded-for': clientIp };
  }
  return { ...authHeaders };
}

/**
 * Build client-IP forwarding headers for the remote auth / stats sidecars.
 *
 * Sets `x-forwarded-for` to the resolved client IP. Sets `x-real-ip` only when
 * the caller did not already provide one (preserves an explicit `x-real-ip`
 * from an outer proxy). Returns an empty object when no client IP can be
 * determined, so the caller can spread the result without conditional checks.
 *
 * Distinct from {@link addForwardedHeaders}: that one targets upstream provider
 * calls (Claude/OpenAI/Gemini) and only carries `x-forwarded-for`; this one is
 * for the auth_server / record_server sidecars where both headers are expected.
 */
export function getSidecarForwardedHeaders(request: Request): Record<string, string> {
  const clientIp = getClientIp(request);
  if (!clientIp) return {};
  const headers: Record<string, string> = { 'x-forwarded-for': clientIp };
  const existingRealIp = request.headers.get('x-real-ip');
  if (!existingRealIp) {
    headers['x-real-ip'] = clientIp;
  }
  return headers;
}

/**
 * Strip transfer-encoding headers that no longer match the body.
 *
 * Node's fetch (undici) auto-decompresses gzip/deflate/br bodies but leaves
 * the original `content-encoding` and `content-length` headers on the
 * Response. Any handler that re-wraps the (already-decompressed) body with
 * the upstream headers would otherwise advertise an encoding the bytes no
 * longer match, causing clients to crash with Z_DATA_ERROR (surfaced as
 * "TypeError: terminated"). Apply at every site that builds a new Response
 * from a decompressed body + copied upstream headers.
 */
export function sanitizeUpstreamResponseHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return headers;
}


