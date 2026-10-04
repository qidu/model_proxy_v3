import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';

function makeConfigPath(): string {
  const p = join(tmpdir(), `proxy_api_hello_${Date.now()}_${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(p, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://api.example.com"
api_key = "sk-test"
`, 'utf-8');
  return p;
}

const realFetch = globalThis.fetch;
let configPath = '';
let upstreamCalls: string[] = [];

function installMockFetch() {
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    upstreamCalls.push(url);
    return new Response(JSON.stringify({ data: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
}

describe('HEAD /api/hello connection-warming probe', () => {
  beforeEach(() => {
    clearProxyConfigCache();
    configPath = makeConfigPath();
    upstreamCalls = [];
    installMockFetch();
  });

  afterEach(() => {
    clearProxyConfigCache();
    globalThis.fetch = realFetch;
    if (configPath) unlinkSync(configPath);
  });

  it('answers HEAD /api/hello with 200 and no auth header', async () => {
    const resp = await handler.fetch(
      new Request('http://localhost/api/hello', { method: 'HEAD' }),
      { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any,
    );

    assert.equal(resp.status, 200);
  });

  it('does not reach the upstream', async () => {
    await handler.fetch(
      new Request('http://localhost/api/hello', { method: 'HEAD' }),
      { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any,
    );

    assert.deepEqual(upstreamCalls, []);
  });

  it('returns an empty body', async () => {
    const resp = await handler.fetch(
      new Request('http://localhost/api/hello', { method: 'HEAD' }),
      { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any,
    );

    assert.equal(await resp.text(), '');
  });

  it('is answered before the auth presence check (no 401 without credentials)', async () => {
    // The generic model-API gate rejects credential-less requests with 401;
    // /api/hello must be exempt, since Claude Code sends it unauthenticated.
    const resp = await handler.fetch(
      new Request('http://localhost/api/hello', { method: 'HEAD' }),
      { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error', DEV_NO_KEY: 'false' } as any,
    );

    assert.equal(resp.status, 200);
  });

  it('also answers GET /api/hello with 200', async () => {
    const resp = await handler.fetch(
      new Request('http://localhost/api/hello', { method: 'GET' }),
      { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any,
    );

    assert.equal(resp.status, 200);
  });

  it('leaves an unrelated unknown path unauthenticated-rejected', async () => {
    // Guards the exemption from widening: only /api/hello is exempt.
    const resp = await handler.fetch(
      new Request('http://localhost/api/not-hello', { method: 'HEAD' }),
      { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any,
    );

    assert.equal(resp.status, 401);
  });
});