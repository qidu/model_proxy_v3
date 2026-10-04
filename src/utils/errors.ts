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

  throw new ClaudeProxyError(errorMessage, status, errorType);
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
