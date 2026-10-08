/**
 * Unit tests for passthrough credential handling (src/handlers/passthrough.ts).
 *
 * The upstream must receive exactly one credential, in the header the target
 * mode reads — regardless of whether it came from `target.key` or the caller.
 * `extractAuthHeaders` is mode-agnostic (it folds `x-api-key` into
 * `Authorization: Bearer`), so the handler has to re-format it for the mode;
 * otherwise an anthropic-messages upstream gets a Bearer token it ignores.
 *
 * Run with: npx tsx --test tests/unit/passthrough-auth.test.ts
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handlePassthroughRequest } from '../../src/handlers/passthrough.js';
import { extractAuthHeaders } from '../../src/utils/routing.js';
import type { Logger } from '../../src/types/shared.js';
import type { ProxyConfig } from '../../src/utils/config-loader.js';

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Stub global fetch, returning a 200 JSON body and capturing the sent headers. */
function captureUpstreamHeaders(): { get: () => Headers } {
  let captured: Headers | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    captured = new Headers(init?.headers as HeadersInit);
    return new Response(JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    get: () => {
      if (!captured) throw new Error('upstream fetch was never called');
      return captured;
    },
  };
}

/** Build the `authHeaders` the dispatcher would pass, from a real Request. */
function authHeadersFrom(headers: Record<string, string>): Record<string, string> {
  return extractAuthHeaders(new Request('http://proxy.test/passthrough/v1/messages', { headers }));
}

async function runPassthrough(opts: {
  path: string;
  mode: string;
  body: Record<string, unknown>;
  targetKey?: string;
  callerHeaders: Record<string, string>;
}): Promise<Headers> {
  const capture = captureUpstreamHeaders();
  const proxyConfig: ProxyConfig = {
    passthrough: {
      t: { base: 'https://upstream.test', mode: opts.mode, ...(opts.targetKey ? { key: opts.targetKey } : {}) },
    },
  };
  const bodyText = JSON.stringify(opts.body);
  const res = await handlePassthroughRequest(
    new Request(`http://proxy.test${opts.path}`, { method: 'POST', body: bodyText }),
    opts.path,
    bodyText,
    proxyConfig,
    {},
    silentLogger,
    'req-test',
    authHeadersFrom(opts.callerHeaders),
    'caller',
    undefined,
    {},
  );
  assert.equal(res.status, 200);
  return capture.get();
}

const MESSAGES_BODY = { model: 'm', messages: [{ role: 'user', content: 'hi' }] };
const GEMINI_BODY = { model: 'm', contents: [{ role: 'user', parts: [{ text: 'hi' }] }] };

describe('passthrough credential handling', () => {
  it('no target.key: re-emits the caller x-api-key as x-api-key for anthropic-messages', async () => {
    const headers = await runPassthrough({
      path: '/passthrough/v1/messages',
      mode: 'anthropic-messages',
      body: MESSAGES_BODY,
      callerHeaders: { 'x-api-key': 'sk-CLIENT' },
    });
    assert.equal(headers.get('x-api-key'), 'sk-CLIENT');
    assert.equal(headers.get('authorization'), null, 'must not also send Authorization');
  });

  it('no target.key: caller Authorization stays Bearer for openai-completions', async () => {
    const headers = await runPassthrough({
      path: '/passthrough/v1/chat/completions',
      mode: 'openai-completions',
      body: MESSAGES_BODY,
      callerHeaders: { 'Authorization': 'Bearer sk-CLIENT' },
    });
    assert.equal(headers.get('authorization'), 'Bearer sk-CLIENT');
    assert.equal(headers.get('x-api-key'), null);
  });

  it('no target.key: caller x-goog-api-key is preserved for gemini', async () => {
    const headers = await runPassthrough({
      path: '/passthrough/v1beta/models/m:generateContent',
      mode: 'gemini-generatecontent',
      body: GEMINI_BODY,
      callerHeaders: { 'x-goog-api-key': 'g-CLIENT' },
    });
    assert.equal(headers.get('x-goog-api-key'), 'g-CLIENT');
    assert.equal(headers.get('authorization'), null);
  });

  it('target.key wins over the caller credential and uses the mode header', async () => {
    const headers = await runPassthrough({
      path: '/passthrough/v1/messages',
      mode: 'anthropic-messages',
      body: MESSAGES_BODY,
      targetKey: 'sk-CONFIGURED',
      callerHeaders: { 'x-api-key': 'sk-CLIENT' },
    });
    assert.equal(headers.get('x-api-key'), 'sk-CONFIGURED');
    assert.equal(headers.get('authorization'), null, 'caller credential must not leak alongside the config key');
  });

  it('keeps non-credential headers (anthropic-beta) alongside the re-formatted key', async () => {
    const headers = await runPassthrough({
      path: '/passthrough/v1/messages',
      mode: 'anthropic-messages',
      body: MESSAGES_BODY,
      callerHeaders: { 'x-api-key': 'sk-CLIENT', 'anthropic-beta': 'prompt-caching-2024-07-31' },
    });
    assert.equal(headers.get('x-api-key'), 'sk-CLIENT');
    assert.ok(headers.get('anthropic-beta')?.includes('prompt-caching-2024-07-31'));
  });

  it('no credential at all: sends neither x-api-key nor Authorization', async () => {
    const headers = await runPassthrough({
      path: '/passthrough/v1/messages',
      mode: 'anthropic-messages',
      body: MESSAGES_BODY,
      callerHeaders: {},
    });
    assert.equal(headers.get('x-api-key'), null);
    assert.equal(headers.get('authorization'), null);
  });
});
