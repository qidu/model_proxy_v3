/**
 * Error handling utilities for Claude Proxy v3
 */

import { ClaudeErrorResponse } from '../types/shared.js';
import { createLogger } from './logger.js';

export class ClaudeProxyError extends Error {
  constructor(
    message: string,
    public readonly status: number = 500,
    public readonly type: string = 'error'
  ) {
    super(message);
    this.name = 'ClaudeProxyError';
  }

  toClaudeErrorResponse(): ClaudeErrorResponse {
    return {
      type: this.type as any,
      error: {
        type: this.type,
        message: this.message,
      },
    };
  }
}

export class ValidationError extends ClaudeProxyError {
  constructor(message: string) {
    super(message, 400, 'invalid_request_error');
    this.name = 'ValidationError';
  }
}

export class AuthenticationError extends ClaudeProxyError {
  constructor(message: string = 'Authentication failed') {
    super(message, 401, 'authentication_error');
    this.name = 'AuthenticationError';
  }
}

export class PermissionError extends ClaudeProxyError {
  constructor(message: string = 'Insufficient permissions') {
    super(message, 403, 'permission_error');
    this.name = 'PermissionError';
  }
}

export class RateLimitError extends ClaudeProxyError {
  constructor(message: string = 'Rate limit exceeded') {
    super(message, 429, 'rate_limit_error');
    this.name = 'RateLimitError';
  }
}

export class ProcessingError extends ClaudeProxyError {
  constructor(message: string = 'Error processing request') {
    super(message, 500, 'processing_error');
    this.name = 'ProcessingError';
  }
}

export class OverLimitError extends ClaudeProxyError {
  constructor(message: string = 'exceed local token limit') {
    // Hitting a locally-configured token quota (global or composite alias) is
    // a "slow down / quota exhausted" signal, so return HTTP 429 — distinct
    // from a real upstream rejection. The type stays `over_limit_error` so it
    // is distinguishable from upstream RPM rate-limits (see README global /
    // composite token_limit sections).
    super(message, 429, 'over_limit_error');
    this.name = 'OverLimitError';
  }
}

/**
 * Error thrown when an upstream API returned a 4xx/5xx with a response body.
 *
 * Claude Code matches upstream error wording for capability-rejection
 * recovery, so the client must receive the upstream body unmodified rather
 * than a proxy-synthesized envelope. This class carries that raw body (plus a
 * small bag of upstream headers worth preserving) through the throw/catch
 * path to createErrorResponse / createResponsesErrorResponse, which render it
 * verbatim. The synthesized `message` is still used for server-side logs and
 * failover classification (status / instanceof ClaudeProxyError semantics are
 * unchanged).
 */
export class UpstreamApiError extends ClaudeProxyError {
  constructor(
    message: string,
    status: number,
    type: string,
    public readonly upstreamBody: string,
    public readonly upstreamHeaders: Record<string, string> = {},
  ) {
    super(message, status, type);
    this.name = 'UpstreamApiError';
  }
}

/** Headers worth preserving from an upstream error response. */
function captureUpstreamErrorHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (k === 'content-type' || k === 'retry-after' || k === 'x-should-retry' || k.startsWith('anthropic-ratelimit-')) {
      headers[k] = value;
    }
  });
  return headers;
}

/** Spec requires retry-after as integer delta-seconds, never an HTTP-date. */
function normalizeRetryAfterSeconds(raw: string): string | undefined {
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return String(Math.max(0, Math.ceil(seconds)));
  const dateMs = Date.parse(raw);
  if (Number.isFinite(dateMs)) return String(Math.max(0, Math.ceil((dateMs - Date.now()) / 1000)));
  return undefined;
}

/**
 * Default retry hint (seconds) for the proxy's own locally-generated 429/503,
 * where no upstream retry-after exists. 30s is a conservative middle ground:
 * local token-quota 429s rarely clear faster, and a local 503 is usually a
 * short-lived dependency outage.
 */
const DEFAULT_RETRY_AFTER_SECONDS = 30;

/**
 * Claude Code reads `retry-after` (integer seconds) and `x-should-retry` on
 * every 429/503. Emit them on the proxy's own error responses, preferring a
 * captured upstream value when one exists.
 */
function applyRetryHeaders(headers: Record<string, string>, status: number, upstreamHeaders?: Record<string, string>): void {
  if (status !== 429 && status !== 503) return;
  const upstreamRetryAfter = upstreamHeaders?.['retry-after'];
  const normalized = upstreamRetryAfter ? normalizeRetryAfterSeconds(upstreamRetryAfter) : undefined;
  headers['retry-after'] = normalized ?? String(DEFAULT_RETRY_AFTER_SECONDS);
  headers['x-should-retry'] = upstreamHeaders?.['x-should-retry'] ?? 'true';
}

function isJsonBody(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Classification of transport-layer errors thrown by `fetch()`.
 *
 * `fetch()` rejects with a plain `Error` (typically `TypeError: fetch failed`)
 * whose `cause` carries the real signal: `ENOTFOUND` (DNS), `ECONNREFUSED`
 * (port closed), `ERR_INVALID_URL` (bad config), etc. Timeouts surface as
 * `AbortError` / `TimeoutError`. None of these are `ClaudeProxyError`, so
 * without classification they fall through to a generic 500 and — worse —
 * `error.message` (which may contain internal hostnames / ports) is echoed
 * verbatim to the client.
 *
 * `classifyTransportError` maps them to a `ClaudeProxyError` with a sanitized
 * generic message and an appropriate status:
 *   - DNS / connection / TLS / URL failure → 502 `upstream_unreachable`
 *   - abort / timeout                       → 504 `upstream_timeout`
 * Returns `null` when the error doesn't look like a transport failure, so the
 * caller can fall back to its previous handling.
 */
const DNS_CODES = new Set(['ENOTFOUND', 'EAI_AGAIN', 'EAI_NODATA', 'EAI_NONAME']);
const CONNECTION_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ERR_CONNECTION_REFUSED',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED', 'EPROTO', 'EHOSTUNREACH', 'ENETUNREACH',
]);
const URL_CODES = new Set(['ERR_INVALID_URL']);

export function classifyTransportError(error: unknown): ClaudeProxyError | null {
  if (error instanceof ClaudeProxyError) return null;

  const err = error as Error & { code?: string; cause?: { code?: string; name?: string } };
  const causeCode = err.cause?.code;
  const code = err.code;
  const name = err.name;

  // Timeout / abort. AbortSignal.timeout() rejects with name 'TimeoutError';
  // a manual AbortController gives 'AbortError'; undici uses 'UND_ERR_ABORTED'.
  const isAbort =
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    code === 'UND_ERR_ABORTED' ||
    code === '23' ||
    err.cause?.name === 'TimeoutError' ||
    err.cause?.name === 'AbortError' ||
    (typeof err.message === 'string' && /abort/i.test(err.message));
  if (isAbort) {
    return new ClaudeProxyError('Upstream request timed out', 504, 'upstream_timeout');
  }

  // Malformed URL — config bug, not a network condition, but still upstream-side.
  if (URL_CODES.has(code ?? '') || URL_CODES.has(causeCode ?? '')) {
    return new ClaudeProxyError('Upstream URL is invalid', 502, 'upstream_unreachable');
  }

  const allCodes = [code, causeCode].filter(Boolean) as string[];
  if (allCodes.some(c => DNS_CODES.has(c) || CONNECTION_CODES.has(c))) {
    return new ClaudeProxyError('Upstream service unreachable', 502, 'upstream_unreachable');
  }

  // Node's fetch wraps any rejection as `TypeError: fetch failed`. If we see
  // that signature with no further classification, treat it as unreachable
  // rather than letting it fall through to a 500 with a raw message leak.
  if (name === 'TypeError' && typeof err.message === 'string' && /fetch failed/i.test(err.message)) {
    return new ClaudeProxyError('Upstream service unreachable', 502, 'upstream_unreachable');
  }

  return null;
}

/**
 * Create a Claude API error response
 *
 * Per Anthropic API spec, error response format:
 * {
 *   "type": "error",
 *   "error": {
 *     "type": "error_type",
 *     "message": "error message"
 *   }
 * }
 * The top-level "type" is always "error", not the specific error type.
 */
export function createErrorResponse(
  error: Error | ClaudeProxyError,
  requestId?: string,
  customStatus?: number
): Response {
  // Upstream error with a captured body: forward the upstream body unmodified
  // (Claude Code matches upstream error wording for capability-rejection
  // recovery). Only JSON bodies are forwarded verbatim; a non-JSON or missing
  // body falls through to the synthesized envelope below.
  if (error instanceof UpstreamApiError && error.upstreamBody && isJsonBody(error.upstreamBody)) {
    const passthroughHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(error.upstreamHeaders)) {
      passthroughHeaders[k] = k === 'retry-after' ? (normalizeRetryAfterSeconds(v) ?? v) : v;
    }
    if (!passthroughHeaders['content-type']) {
      passthroughHeaders['content-type'] = 'application/json';
    }
    if (requestId) {
      passthroughHeaders['x-request-id'] = requestId;
    }
    applyRetryHeaders(passthroughHeaders, error.status, error.upstreamHeaders);
    return new Response(error.upstreamBody, {
      status: error.status,
      headers: passthroughHeaders,
    });
  }

  let responseStatus = customStatus ?? 500;
  let errorType = 'error';
  let message = error.message;

  if (error instanceof ClaudeProxyError) {
    responseStatus = error.status;
    errorType = error.type;
  } else if (customStatus === undefined) {
    // No explicit status and not a ClaudeProxyError — this is the outer-catch
    // path where transport errors (DNS / refused / TLS / abort) surface as
    // plain Error objects. Classify them so the client gets a meaningful 502 /
    // 504 and the raw internal message (which may contain hostnames, ports, or
    // filesystem paths from the underlying socket error) is never echoed back.
    // The original message remains in the server log via the outer catch.
    const classified = classifyTransportError(error);
    if (classified) {
      responseStatus = classified.status;
      errorType = classified.type;
      message = classified.message;
    }
  }

  // Per Anthropic spec: top-level type is always "error"
  // The specific error type goes in error.type
  const errorResponse: ClaudeErrorResponse = {
    type: 'error',
    error: {
      type: errorType,
      message,
    },
  };

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (requestId) {
    headers['x-request-id'] = requestId;
  }

  applyRetryHeaders(headers, responseStatus);

  return new Response(JSON.stringify(errorResponse), {
    status: responseStatus,
    headers,
  });
}

/**
 * Extract the user-facing message from an upstream error response body.
 * Checks `error.message` (Anthropic/OpenAI format) then top-level `message`.
 * Returns undefined if no parseable message is found.
 */
export function extractUpstreamMessage(rawBody: string | undefined): string | undefined {
  if (!rawBody) return undefined;
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed && typeof parsed === 'object') {
      if (parsed.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string' && parsed.error.message.trim()) {
        return parsed.error.message;
      }
      if (typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message;
      }
    }
  } catch {
    // not JSON or unparseable
  }
  return undefined;
}

/**
 * Handle errors from target API responses
 */
export function handleTargetApiError(
  response: Response,
  targetApiName: string,
  requestInfo?: { url: string; status?: number; body?: string; upstreamBody?: string }
): never {
  const status = response.status;
  const upstreamMessage = extractUpstreamMessage(requestInfo?.upstreamBody);

  let errorMessage = upstreamMessage ?? `Target API (${targetApiName}) returned error: ${status}`;
  let errorType = 'processing_error';

  switch (status) {
    case 400:
      errorType = 'invalid_request_error';
      if (!upstreamMessage) {
        errorMessage = `Invalid request to ${targetApiName}`;
        // Log the body server-side only; do NOT include it in the client-facing
        // error message (it may contain user messages, PII, or tool arguments).
        if (requestInfo) {
          const logger = createLogger({});
          if (requestInfo.url) {
            logger.debug('errors', `Upstream 400 from ${targetApiName} [URL: ${requestInfo.url}]`);
          }
          if (requestInfo.body) {
            const bodyPreview = requestInfo.body.length > 300
              ? requestInfo.body.substring(0, 300) + '...'
              : requestInfo.body;
            logger.debug('errors', `Upstream 400 from ${targetApiName} [Body: ${bodyPreview}]`);
          }
        }
      }
      break;
    case 401:
      errorType = 'authentication_error';
      errorMessage = upstreamMessage
        ? `Upstream (${targetApiName}) rejected the API key: ${upstreamMessage}`
        : `Upstream (${targetApiName}) rejected the API key (HTTP 401) — check the configured api_key for this route.`;
      break;
    case 403:
      errorType = 'permission_error';
      errorMessage = upstreamMessage ?? `Insufficient permissions for ${targetApiName}`;
      break;
    case 429:
      errorType = 'rate_limit_error';
      errorMessage = upstreamMessage ?? `Rate limit exceeded for ${targetApiName}`;
      break;
    case 413:
      errorType = 'over_limit_error';
      errorMessage = upstreamMessage ?? `Request exceeds limits for ${targetApiName}`;
      break;
    case 500:
    case 502:
    case 503:
    case 504:
      errorType = 'processing_error';
      errorMessage = upstreamMessage ?? `Service error from ${targetApiName}`;
      break;
    default:
      // Unknown status — preserve upstream message if we have it; otherwise generic
      errorType = 'processing_error';
      if (!upstreamMessage) {
        errorMessage = `Target API (${targetApiName}) returned error: ${status}`;
      }
      break;
  }

  if (requestInfo?.upstreamBody) {
    // Carry the raw upstream body to the client (see UpstreamApiError). The
    // synthesized errorMessage above is kept for logs and failover
    // classification only.
    throw new UpstreamApiError(errorMessage, status, errorType, requestInfo.upstreamBody, captureUpstreamErrorHeaders(response));
  }
  throw new ClaudeProxyError(errorMessage, status, errorType);
}

// ---------------------------------------------------------------------------
// Open Responses / Responses API error envelope
//
// The Responses spec uses a different envelope than the Anthropic endpoints:
//   { "error": { "message", "type", "param", "code" } }
// with types server_error (500), invalid_request (400), not_found (404),
// model_error (500), too_many_requests (429). These helpers produce that shape
// for the /v1/responses route family only; createErrorResponse /
// handleTargetApiError above stay Anthropic-shaped for /v1/messages.
// ---------------------------------------------------------------------------

/** Error carrying the Responses-spec envelope fields. */
export class ResponsesApiError extends Error {
  constructor(
    message: string,
    public readonly status: number = 500,
    public readonly type: string = 'server_error',
    public readonly param: string | null = null,
    public readonly code: string | null = null,
  ) {
    super(message);
    this.name = 'ResponsesApiError';
  }
}

/** Map an HTTP status onto the spec's error-type vocabulary. */
export function responsesErrorTypeForStatus(status: number): string {
  if (status === 404) return 'not_found';
  if (status === 429) return 'too_many_requests';
  if (status >= 400 && status < 500) return 'invalid_request';
  return 'server_error';
}

/**
 * Create a Responses-spec error response: {error: {message, type, param, code}}.
 * Plain errors are classified like createErrorResponse does (transport errors
 * get a sanitized message); ClaudeProxyError instances keep their status but
 * are re-typed onto the spec vocabulary.
 */
export function createResponsesErrorResponse(
  error: Error,
  requestId?: string,
): Response {
  let status = 500;
  let type = 'server_error';
  let message = error.message;
  let param: string | null = null;
  let code: string | null = null;

  if (error instanceof ResponsesApiError) {
    status = error.status;
    type = error.type;
    param = error.param;
    code = error.code;
  } else if (error instanceof UpstreamApiError && error.upstreamBody && isJsonBody(error.upstreamBody)) {
    // Forward the upstream error body unmodified (same rationale as
    // createErrorResponse) with the upstream status.
    const passthroughHeaders: Record<string, string> = {};
    for (const [k, v] of Object.entries(error.upstreamHeaders)) {
      passthroughHeaders[k] = k === 'retry-after' ? (normalizeRetryAfterSeconds(v) ?? v) : v;
    }
    if (!passthroughHeaders['content-type']) {
      passthroughHeaders['content-type'] = 'application/json';
    }
    if (requestId) passthroughHeaders['x-request-id'] = requestId;
    applyRetryHeaders(passthroughHeaders, error.status, error.upstreamHeaders);
    return new Response(error.upstreamBody, { status: error.status, headers: passthroughHeaders });
  } else if (error instanceof ClaudeProxyError) {
    status = error.status;
    type = responsesErrorTypeForStatus(status);
  } else {
    // Outer-catch path: classify transport failures so internal hostnames /
    // ports in the raw message are never echoed to the client.
    const classified = classifyTransportError(error);
    if (classified) {
      status = classified.status;
      message = classified.message;
    }
    type = responsesErrorTypeForStatus(status);
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (requestId) headers['x-request-id'] = requestId;
  applyRetryHeaders(headers, status);

  return new Response(JSON.stringify({ error: { message, type, param, code } }), {
    status,
    headers,
  });
}

/**
 * Responses-spec mirror of handleTargetApiError: same message extraction and
 * status preservation, but throws a ResponsesApiError typed with the spec
 * vocabulary. Thrown errors reach the outer catch, which renders them through
 * createResponsesErrorResponse for /v1/responses routes.
 */
export function handleResponsesApiError(
  response: Response,
  targetApiName: string,
  requestInfo?: { url: string; status?: number; body?: string; upstreamBody?: string }
): never {
  const status = response.status;
  const upstreamMessage = extractUpstreamMessage(requestInfo?.upstreamBody);

  let errorMessage = upstreamMessage ?? `Target API (${targetApiName}) returned error: ${status}`;

  if (status === 400 && !upstreamMessage) {
    errorMessage = `Invalid request to ${targetApiName}`;
    // Log the body server-side only; do NOT include it in the client-facing
    // error message (it may contain user messages, PII, or tool arguments).
    if (requestInfo) {
      const logger = createLogger({});
      if (requestInfo.url) {
        logger.debug('errors', `Upstream 400 from ${targetApiName} [URL: ${requestInfo.url}]`);
      }
      if (requestInfo.body) {
        const bodyPreview = requestInfo.body.length > 300
          ? requestInfo.body.substring(0, 300) + '...'
          : requestInfo.body;
        logger.debug('errors', `Upstream 400 from ${targetApiName} [Body: ${bodyPreview}]`);
      }
    }
  } else if (status === 401) {
    errorMessage = upstreamMessage
      ? `Upstream (${targetApiName}) rejected the API key: ${upstreamMessage}`
      : `Upstream (${targetApiName}) rejected the API key (HTTP 401) — check the configured api_key for this route.`;
  }

  if (requestInfo?.upstreamBody) {
    // Carry the raw upstream body to the client (see UpstreamApiError). The
    // Responses-spec envelope below would discard the upstream wording Claude
    // Code matches on for capability-rejection recovery.
    throw new UpstreamApiError(errorMessage, status, responsesErrorTypeForStatus(status), requestInfo.upstreamBody, captureUpstreamErrorHeaders(response));
  }
  throw new ResponsesApiError(errorMessage, status, responsesErrorTypeForStatus(status));
}

/**
 * Validate required parameters
 */
export function validateRequired(
  obj: Record<string, any>,
  requiredFields: string[],
  context: string = 'request'
): void {
  for (const field of requiredFields) {
    if (obj[field] === undefined || obj[field] === null) {
      throw new ValidationError(
        `Missing required field: ${field} in ${context}`
      );
    }
  }
}

/**
 * Validate string parameter constraints
 */
export function validateString(
  value: any,
  fieldName: string,
  options?: {
    minLength?: number;
    maxLength?: number;
    pattern?: RegExp;
    allowedValues?: string[];
  }
): void {
  if (typeof value !== 'string') {
    throw new ValidationError(
      `${fieldName} must be a string, got ${typeof value}`
    );
  }

  if (options?.minLength !== undefined && value.length < options.minLength) {
    throw new ValidationError(
      `${fieldName} must be at least ${options.minLength} characters`
    );
  }

  if (options?.maxLength !== undefined && value.length > options.maxLength) {
    throw new ValidationError(
      `${fieldName} must be at most ${options.maxLength} characters`
    );
  }

  if (options?.pattern && !options.pattern.test(value)) {
    throw new ValidationError(
      `${fieldName} does not match required pattern`
    );
  }

  if (
    options?.allowedValues &&
    !options.allowedValues.includes(value)
  ) {
    throw new ValidationError(
      `${fieldName} must be one of: ${options.allowedValues.join(', ')}`
    );
  }
}

/**
 * Validate number parameter constraints
 */
export function validateNumber(
  value: any,
  fieldName: string,
  options?: {
    min?: number;
    max?: number;
    integer?: boolean;
  }
): void {
  if (typeof value !== 'number' || isNaN(value)) {
    throw new ValidationError(
      `${fieldName} must be a number, got ${typeof value}`
    );
  }

  if (options?.integer && !Number.isInteger(value)) {
    throw new ValidationError(`${fieldName} must be an integer`);
  }

  if (options?.min !== undefined && value < options.min) {
    throw new ValidationError(
      `${fieldName} must be at least ${options.min}`
    );
  }

  if (options?.max !== undefined && value > options.max) {
    throw new ValidationError(
      `${fieldName} must be at most ${options.max}`
    );
  }
}

/**
 * Validate array parameter constraints
 */
export function validateArray(
  value: any,
  fieldName: string,
  options?: {
    minItems?: number;
    maxItems?: number;
    itemValidator?: (item: any, index: number) => void;
  }
): void {
  if (!Array.isArray(value)) {
    throw new ValidationError(
      `${fieldName} must be an array, got ${typeof value}`
    );
  }

  if (options?.minItems !== undefined && value.length < options.minItems) {
    throw new ValidationError(
      `${fieldName} must contain at least ${options.minItems} items`
    );
  }

  if (options?.maxItems !== undefined && value.length > options.maxItems) {
    throw new ValidationError(
      `${fieldName} must contain at most ${options.maxItems} items`
    );
  }

  if (options?.itemValidator) {
    for (let i = 0; i < value.length; i++) {
      try {
        options.itemValidator(value[i], i);
      } catch (error) {
        if (error instanceof ClaudeProxyError) {
          throw new ValidationError(
            `${fieldName}[${i}]: ${error.message}`
          );
        }
        throw error;
      }
    }
  }
}
