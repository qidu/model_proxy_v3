import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ClaudeProxyError,
  ValidationError,
  AuthenticationError,
  PermissionError,
  RateLimitError,
  ProcessingError,
  OverLimitError,
  UpstreamApiError,
  classifyTransportError,
  createErrorResponse,
  handleTargetApiError,
  validateRequired,
  validateString,
  validateNumber,
  validateArray,
} from '../../src/utils/errors.js';

/**
 * Direct unit tests for the error classes, transport error classification,
 * error response factory, and validation helpers.
 */

// ─── Error classes ─────────────────────────────────────────────────────────

describe('error classes', () => {
  it('ClaudeProxyError has correct defaults', () => {
    const e = new ClaudeProxyError('boom');
    assert.equal(e.status, 500);
    assert.equal(e.type, 'error');
    assert.equal(e.name, 'ClaudeProxyError');
    assert.ok(e instanceof Error);
  });

  it('toClaudeErrorResponse produces the expected shape', () => {
    const e = new ClaudeProxyError('bad', 418, 'teapot_error');
    const resp = e.toClaudeErrorResponse();
    assert.deepEqual(resp, {
      type: 'teapot_error',
      error: { type: 'teapot_error', message: 'bad' },
    });
  });

  const subclasses: Array<[string, new (...args: any[]) => ClaudeProxyError, number, string]> = [
    ['ValidationError', ValidationError, 400, 'invalid_request_error'],
    ['AuthenticationError', AuthenticationError, 401, 'authentication_error'],
    ['PermissionError', PermissionError, 403, 'permission_error'],
    ['RateLimitError', RateLimitError, 429, 'rate_limit_error'],
    ['ProcessingError', ProcessingError, 500, 'processing_error'],
    ['OverLimitError', OverLimitError, 429, 'over_limit_error'],
  ];

  for (const [name, Ctor, expectedStatus, expectedType] of subclasses) {
    it(`${name} has status=${expectedStatus} and type=${expectedType}`, () => {
      const e = new Ctor('test');
      assert.equal(e.status, expectedStatus);
      assert.equal(e.type, expectedType);
      assert.equal(e.name, name);
      assert.ok(e instanceof ClaudeProxyError);
    });
  }
});

// ─── classifyTransportError ────────────────────────────────────────────────

describe('classifyTransportError', () => {
  it('returns null for a ClaudeProxyError (already classified)', () => {
    assert.equal(classifyTransportError(new ClaudeProxyError('x')), null);
  });

  it('classifies AbortError as 504 upstream_timeout', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    const classified = classifyTransportError(err)!;
    assert.equal(classified.status, 504);
    assert.equal(classified.type, 'upstream_timeout');
  });

  it('classifies TimeoutError as 504 upstream_timeout', () => {
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    const classified = classifyTransportError(err)!;
    assert.equal(classified.status, 504);
  });

  it('classifies ECONNREFUSED as 502 upstream_unreachable', () => {
    const err = new Error('connect') as Error & { cause: { code: string } };
    err.cause = { code: 'ECONNREFUSED' };
    const classified = classifyTransportError(err)!;
    assert.equal(classified.status, 502);
    assert.equal(classified.type, 'upstream_unreachable');
  });

  it('classifies ENOTFOUND (DNS) as 502 upstream_unreachable', () => {
    const err = new Error('dns') as Error & { cause: { code: string } };
    err.cause = { code: 'ENOTFOUND' };
    const classified = classifyTransportError(err)!;
    assert.equal(classified.status, 502);
  });

  it('classifies ERR_INVALID_URL as 502 upstream_unreachable', () => {
    const err = new Error('bad url') as Error & { code: string };
    err.code = 'ERR_INVALID_URL';
    const classified = classifyTransportError(err)!;
    assert.equal(classified.status, 502);
  });

  it('classifies TypeError "fetch failed" as 502', () => {
    const err = new TypeError('fetch failed');
    const classified = classifyTransportError(err)!;
    assert.equal(classified.status, 502);
    assert.equal(classified.type, 'upstream_unreachable');
  });

  it('returns null for an unrelated Error', () => {
    assert.equal(classifyTransportError(new Error('something else')), null);
  });
});

// ─── createErrorResponse ───────────────────────────────────────────────────

describe('createErrorResponse', () => {
  it('returns a Response with the correct status and body for a ClaudeProxyError', async () => {
    const resp = createErrorResponse(new ValidationError('bad input'), 'req-1');
    assert.equal(resp.status, 400);
    assert.equal(resp.headers.get('x-request-id'), 'req-1');
    const body = await resp.json();
    assert.equal(body.error.type, 'invalid_request_error');
    assert.equal(body.error.message, 'bad input');
  });

  it('classifies a transport error when no custom status is given', async () => {
    const err = new TypeError('fetch failed');
    const resp = createErrorResponse(err);
    assert.equal(resp.status, 502);
    const body = await resp.json();
    assert.equal(body.error.type, 'upstream_unreachable');
  });

  it('uses customStatus when provided, even for a generic Error', async () => {
    const resp = createErrorResponse(new Error('oops'), undefined, 503);
    assert.equal(resp.status, 503);
  });

  it('forwards an upstream error body unmodified with status and headers', async () => {
    const upstreamBody = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'model does not support tools' } });
    const err = new UpstreamApiError('synthesized log message', 400, 'invalid_request_error', upstreamBody, {
      'content-type': 'application/json',
      'anthropic-ratelimit-unified-status': 'rejected',
    });
    const resp = createErrorResponse(err, 'req-upstream');
    assert.equal(resp.status, 400);
    assert.equal(await resp.text(), upstreamBody);
    assert.equal(resp.headers.get('x-request-id'), 'req-upstream');
    assert.equal(resp.headers.get('anthropic-ratelimit-unified-status'), 'rejected');
  });

  it('wraps a non-JSON upstream body in the proxy envelope', async () => {
    const err = new UpstreamApiError('Service error from Claude API', 500, 'processing_error', '<html>oops</html>');
    const resp = createErrorResponse(err);
    assert.equal(resp.status, 500);
    const body = await resp.json();
    assert.equal(body.error.type, 'processing_error');
    assert.equal(body.error.message, 'Service error from Claude API');
  });

  it('emits retry-after (integer seconds) and x-should-retry on a local 429', async () => {
    const resp = createErrorResponse(new OverLimitError(), 'req-429');
    assert.equal(resp.status, 429);
    assert.match(resp.headers.get('retry-after') ?? '', /^\d+$/);
    assert.equal(resp.headers.get('x-should-retry'), 'true');
  });

  it('emits retry-after and x-should-retry on a 503 with custom status', async () => {
    const resp = createErrorResponse(new Error('down'), undefined, 503);
    assert.match(resp.headers.get('retry-after') ?? '', /^\d+$/);
    assert.equal(resp.headers.get('x-should-retry'), 'true');
  });

  it('prefers the captured upstream retry-after, normalized to integer seconds', async () => {
    const upstreamBody = JSON.stringify({ error: { message: 'slow down' } });
    const err = new UpstreamApiError('rate limited', 429, 'rate_limit_error', upstreamBody, {
      'retry-after': '17.4',
      'x-should-retry': 'false',
    });
    const resp = createErrorResponse(err);
    assert.equal(resp.headers.get('retry-after'), '18');
    assert.equal(resp.headers.get('x-should-retry'), 'false');
  });
});

// ─── handleTargetApiError ──────────────────────────────────────────────────

describe('handleTargetApiError', () => {
  it('throws UpstreamApiError carrying the raw upstream body', () => {
    const upstreamBody = JSON.stringify({ error: { message: 'context too long' } });
    const response = new Response(upstreamBody, {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'retry-after': '5' },
    });
    try {
      handleTargetApiError(response, 'Claude API', { url: 'https://api.example/v1/messages', upstreamBody });
      assert.fail('should have thrown');
    } catch (err: any) {
      assert.ok(err instanceof UpstreamApiError);
      assert.ok(err instanceof ClaudeProxyError);
      assert.equal(err.status, 400);
      assert.equal(err.type, 'invalid_request_error');
      assert.equal(err.message, 'context too long');
      assert.equal(err.upstreamBody, upstreamBody);
      assert.equal(err.upstreamHeaders['retry-after'], '5');
    }
  });

  it('throws a plain ClaudeProxyError when no upstream body was captured', () => {
    const response = new Response(null, { status: 503 });
    try {
      handleTargetApiError(response, 'Claude API', { url: 'https://api.example/v1/messages' });
      assert.fail('should have thrown');
    } catch (err: any) {
      assert.ok(!(err instanceof UpstreamApiError));
      assert.ok(err instanceof ClaudeProxyError);
      assert.equal(err.status, 503);
    }
  });
});

// ─── validation helpers ────────────────────────────────────────────────────

describe('validateRequired', () => {
  it('passes when all required fields are present', () => {
    assert.doesNotThrow(() => validateRequired({ a: 1, b: 'x' }, ['a', 'b']));
  });

  it('throws ValidationError for a missing field', () => {
    assert.throws(() => validateRequired({ a: 1 }, ['a', 'b']), ValidationError);
  });

  it('throws for null values', () => {
    assert.throws(() => validateRequired({ a: null }, ['a']), ValidationError);
  });
});

describe('validateString', () => {
  it('rejects non-strings', () => {
    assert.throws(() => validateString(42, 'field'), ValidationError);
  });

  it('enforces minLength', () => {
    assert.throws(() => validateString('ab', 'f', { minLength: 3 }), ValidationError);
    assert.doesNotThrow(() => validateString('abc', 'f', { minLength: 3 }));
  });

  it('enforces maxLength', () => {
    assert.throws(() => validateString('abcdef', 'f', { maxLength: 3 }), ValidationError);
  });

  it('enforces pattern', () => {
    assert.throws(() => validateString('abc', 'f', { pattern: /^\d+$/ }), ValidationError);
    assert.doesNotThrow(() => validateString('123', 'f', { pattern: /^\d+$/ }));
  });

  it('enforces allowedValues', () => {
    assert.throws(() => validateString('c', 'f', { allowedValues: ['a', 'b'] }), ValidationError);
    assert.doesNotThrow(() => validateString('a', 'f', { allowedValues: ['a', 'b'] }));
  });
});

describe('validateNumber', () => {
  it('rejects non-numbers', () => {
    assert.throws(() => validateNumber('5', 'f'), ValidationError);
  });

  it('rejects NaN', () => {
    assert.throws(() => validateNumber(NaN, 'f'), ValidationError);
  });

  it('enforces integer constraint', () => {
    assert.throws(() => validateNumber(1.5, 'f', { integer: true }), ValidationError);
    assert.doesNotThrow(() => validateNumber(2, 'f', { integer: true }));
  });

  it('enforces min/max bounds', () => {
    assert.throws(() => validateNumber(0, 'f', { min: 1 }), ValidationError);
    assert.throws(() => validateNumber(10, 'f', { max: 5 }), ValidationError);
  });
});

describe('validateArray', () => {
  it('rejects non-arrays', () => {
    assert.throws(() => validateArray('x', 'f'), ValidationError);
  });

  it('enforces minItems', () => {
    assert.throws(() => validateArray([], 'f', { minItems: 1 }), ValidationError);
  });

  it('enforces maxItems', () => {
    assert.throws(() => validateArray([1, 2, 3], 'f', { maxItems: 2 }), ValidationError);
  });

  it('runs itemValidator and wraps errors', () => {
    assert.throws(
      () =>
        validateArray([1, 'bad'], 'arr', {
          itemValidator: (item) => {
            if (typeof item !== 'number') throw new ValidationError('not a number');
          },
        }),
      (err: any) => {
        assert.ok(err instanceof ValidationError);
        assert.ok(err.message.includes('arr[1]'));
        return true;
      },
    );
  });
});
