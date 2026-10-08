/**
 * Unit tests for auth_with_model behaviour.
 *
 * Run with:
 *   npx tsx --test tests/unit/auth-with-model.test.ts
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigPath(toml: string): string {
  const p = join(tmpdir(), `proxy_test_${Date.now()}_${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(p, toml, 'utf-8');
  return p;
}

function makeEnv(configPath: string): Record<string, string> {
  return { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' };
}

function makeRequest(model: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-key', ...headers },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
  });
}

function makeRequestWithoutAuth(model: string): Request {
  return new Request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
  });
}

// Captured calls by the mock
type AuthCall = { url: string; headers: Record<string, string> };
let authCalls: AuthCall[] = [];
let authStatus = 200;

// upstream stub always returns a minimal non-streaming response
const UPSTREAM_BODY = JSON.stringify({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
  model: 'claude-sonnet-4-6',
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
});

// Save and restore the real global fetch
const realFetch = globalThis.fetch;

function installMockFetch(authUrl: string) {
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;

    if (url === authUrl) {
      const reqHeaders: Record<string, string> = {};
      if (init?.headers) {
        for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
          reqHeaders[k] = v;
        }
      }
      authCalls.push({ url, headers: reqHeaders });
      if (authStatus === 200) {
        // A passing auth response MUST advertise the wire-contract `version`.
        return new Response(JSON.stringify({ version: 'v1' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(null, { status: authStatus });
    }

    // Anything else is treated as the upstream model call
    return new Response(UPSTREAM_BODY, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const AUTH_URL = 'https://auth.example.com/validate';

const BASE_TOML = `
[dashboard]
api_key = "dash"

[remote]
auth_server = "${AUTH_URL}"

[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.example.com"
api_key = "sk-test"
"claude-*" = {}
`;

const AUTH_WITH_MODEL_TOML = `
[dashboard]
api_key = "dash"

[remote]
auth_server = "${AUTH_URL}"
auth_with_model = true

[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.example.com"
api_key = "sk-test"
"claude-*" = {}
`;

describe('DEV_NO_KEY', () => {
  let configPath: string;

  before(() => {
    configPath = makeConfigPath(BASE_TOML);
    installMockFetch(AUTH_URL);
  });

  after(() => {
    restoreFetch();
    unlinkSync(configPath);
  });

  beforeEach(() => {
    clearProxyConfigCache();
    authCalls = [];
    authStatus = 200;
  });

  it('rejects missing auth headers by default', async () => {
    const resp = await handler.fetch(makeRequestWithoutAuth('claude-sonnet-4-6'), makeEnv(configPath) as any);
    assert.equal(resp.status, 401);
    assert.equal(authCalls.length, 0);
  });

  for (const value of ['true', '1']) {
    it(`accepts missing auth headers when DEV_NO_KEY=${value}`, async () => {
      const resp = await handler.fetch(
        makeRequestWithoutAuth('claude-sonnet-4-6'),
        { ...makeEnv(configPath), DEV_NO_KEY: value } as any,
      );
      assert.equal(resp.status, 200);
      assert.equal(authCalls.length, 1, 'configured auth_server must still be called');
    });
  }

  it('still rejects when auth_url rejects', async () => {
    authStatus = 403;
    const resp = await handler.fetch(
      makeRequestWithoutAuth('claude-sonnet-4-6'),
      { ...makeEnv(configPath), DEV_NO_KEY: 'true' } as any,
    );
    assert.equal(authCalls.length, 1);
    assert.equal(resp.status, 401);
  });
});

describe('auth_with_model = false (default)', () => {
  let configPath: string;

  before(() => {
    configPath = makeConfigPath(BASE_TOML);
    installMockFetch(AUTH_URL);
  });

  after(() => {
    restoreFetch();
    unlinkSync(configPath);
  });

  beforeEach(() => {
    clearProxyConfigCache();
    authCalls = [];
    authStatus = 200;
  });

  it('calls auth_url without x-resource-for when auth passes', async () => {
    const resp = await handler.fetch(makeRequest('claude-sonnet-4-6'), makeEnv(configPath) as any);
    assert.equal(authCalls.length, 1, 'auth must be called once');
    assert.equal(authCalls[0].headers['x-resource-for'], undefined, 'must not send x-resource-for');
    assert.match(authCalls[0].headers.request_id, /^req_/);
    assert.equal(authCalls[0].headers.endpoint, '/v1/messages');
    assert.equal(resp.status, 200);
  });

  it('returns 401 when auth_url rejects', async () => {
    authStatus = 403;
    const resp = await handler.fetch(makeRequest('claude-sonnet-4-6'), makeEnv(configPath) as any);
    assert.equal(authCalls.length, 1);
    assert.equal(resp.status, 401);
  });

  it('forwards Authorization header to auth_url', async () => {
    const resp = await handler.fetch(
      makeRequest('claude-sonnet-4-6', { Authorization: 'Bearer my-token', 'x-api-key': '' }),
      makeEnv(configPath) as any,
    );
    assert.equal(authCalls.length, 1);
    assert.equal(authCalls[0].headers['Authorization'], 'Bearer my-token');
    assert.equal(resp.status, 200);
  });
});

describe('auth_with_model = true', () => {
  let configPath: string;

  before(() => {
    configPath = makeConfigPath(AUTH_WITH_MODEL_TOML);
    installMockFetch(AUTH_URL);
  });

  after(() => {
    restoreFetch();
    unlinkSync(configPath);
  });

  beforeEach(() => {
    clearProxyConfigCache();
    authCalls = [];
    authStatus = 200;
  });

  it('calls auth_url with x-resource-for set to the requested model', async () => {
    const resp = await handler.fetch(makeRequest('claude-sonnet-4-6'), makeEnv(configPath) as any);
    assert.equal(authCalls.length, 1, 'auth must be called once');
    assert.equal(authCalls[0].headers['x-resource-for'], 'claude-sonnet-4-6');
    assert.match(authCalls[0].headers.request_id, /^req_/);
    assert.equal(authCalls[0].headers.endpoint, '/v1/messages');
    assert.equal(resp.status, 200);
  });

  it('returns 401 when auth_url rejects even with model header present', async () => {
    authStatus = 401;
    const resp = await handler.fetch(makeRequest('claude-sonnet-4-6'), makeEnv(configPath) as any);
    assert.equal(authCalls.length, 1);
    assert.equal(authCalls[0].headers['x-resource-for'], 'claude-sonnet-4-6');
    assert.equal(resp.status, 401);
  });

  it('returns 503 when auth server is unreachable', async () => {
    globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      if (url === AUTH_URL) throw new Error('connection refused');
      return new Response(UPSTREAM_BODY, { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
    const resp = await handler.fetch(makeRequest('claude-sonnet-4-6'), makeEnv(configPath) as any);
    assert.equal(resp.status, 503);
    // restore mock
    installMockFetch(AUTH_URL);
  });

  it('forwards x-api-key alongside x-resource-for', async () => {
    await handler.fetch(makeRequest('claude-sonnet-4-6'), makeEnv(configPath) as any);
    assert.equal(authCalls.length, 1);
    assert.equal(authCalls[0].headers['x-api-key'], 'test-key');
    assert.equal(authCalls[0].headers['x-resource-for'], 'claude-sonnet-4-6');
  });
});
