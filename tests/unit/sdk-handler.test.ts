/**
 * Unit tests for the sdk:// handler stub.
 *
 * The `chatjimmy` submodule that used to serve `sdk://` routes was removed from
 * this project. `src/utils/sdk-handler.ts` keeps `isSdkUrl()` and the two
 * handler entry points so the route still parses and config validation still
 * accepts `sdk://` base_urls, but every request must fail loud rather than
 * quietly doing nothing or returning a synthesized success.
 *
 * These tests pin that contract: the error is a `ClaudeProxyError` with
 * status 501, type `not_implemented`, and a message that names the model and
 * request so the operator can find the offending config entry.
 *
 * Run with: npx tsx --test tests/unit/sdk-handler.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  isSdkUrl,
  handleSdkOpenAIRequest,
  handleSdkAnthropicRequest,
} from '../../src/utils/sdk-handler.js';
import { ClaudeProxyError } from '../../src/utils/errors.js';

function makeRequest(): Request {
  return new Request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'llama3.1-8B', messages: [{ role: 'user', content: 'hi' }] }),
  });
}

describe('isSdkUrl', () => {
  it('recognises sdk:// and only sdk://', () => {
    assert.equal(isSdkUrl('sdk://localhost'), true);
    assert.equal(isSdkUrl('sdk://chatjimmy.ai/api'), true);
    assert.equal(isSdkUrl('http://localhost:4000'), false);
    assert.equal(isSdkUrl('https://api.example.com'), false);
    assert.equal(isSdkUrl(''), false);
  });
});

describe('sdk:// handler stubs', () => {
  it('handleSdkOpenAIRequest rejects with a 501 not_implemented ClaudeProxyError', async () => {
    await assert.rejects(
      () => handleSdkOpenAIRequest(makeRequest(), 'sdk://localhost', 'req_abc', 'sk-x', 'llama'),
      (error: unknown) => {
        assert.ok(error instanceof ClaudeProxyError, `expected ClaudeProxyError, got ${(error as Error)?.name}`);
        assert.equal(error.status, 501);
        assert.equal(error.type, 'not_implemented');
        assert.match(error.message, /sdk:\/\//);
        assert.match(error.message, /llama/);
        assert.match(error.message, /req_abc/);
        return true;
      }
    );
  });

  it('handleSdkOpenAIRequest reports an unknown model alias rather than an empty message', async () => {
    await assert.rejects(
      () => handleSdkOpenAIRequest(makeRequest(), 'sdk://localhost', 'req_def'),
      (error: unknown) => {
        assert.ok(error instanceof ClaudeProxyError);
        assert.match(error.message, /unknown/);
        return true;
      }
    );
  });

  it('handleSdkAnthropicRequest rejects with a 501 not_implemented ClaudeProxyError', async () => {
    await assert.rejects(
      () => handleSdkAnthropicRequest(makeRequest(), 'sdk://localhost', 'req_ghi', 'sk-x', 'claude-sonnet'),
      (error: unknown) => {
        assert.ok(error instanceof ClaudeProxyError, `expected ClaudeProxyError, got ${(error as Error)?.name}`);
        assert.equal(error.status, 501);
        assert.equal(error.type, 'not_implemented');
        assert.match(error.message, /claude-sonnet/);
        assert.match(error.message, /req_ghi/);
        return true;
      }
    );
  });

  it('501 is retryable, so target failover still moves on to a healthy rung', async () => {
    // If this stopped holding, an sdk:// target would become a dead end instead
    // of a rung the failover ladder skips past.
    const { isRetryableOutcome } = await import('../../src/utils/target-retry.js');
    assert.equal(isRetryableOutcome({ ok: false, status: 501 }), true);
  });
});
