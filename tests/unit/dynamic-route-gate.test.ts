import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';

// Dynamic routing (/{protocol}/{host}/...) is opt-in via ENABLE_DYNAMIC_ROUTING
// and off by default. These tests pin the gate itself: the disabled path must
// 403 (not fall through to fixed routing), and enabling it must restore the
// pre-existing behavior (SSRF allowlist check, then dispatch).

function makeConfigPath(): string {
  const p = join(tmpdir(), `proxy_dyn_route_gate_${Date.now()}_${Math.random().toString(36).slice(2)}.toml`);
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

/** Env with ENABLE_DYNAMIC_ROUTING set to `value` (omitted when undefined). */
function makeEnv(value?: string): Record<string, unknown> {
  const env: Record<string, unknown> = {
    PROXY_CONFIG_PATH: configPath,
    LOG_LEVEL: 'error',
  };
  if (value !== undefined) env.ENABLE_DYNAMIC_ROUTING = value;
  return env;
}

function dynamicRequest(path: string): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer sk-test',
    },
    body: JSON.stringify({
      model: 'deepseek/deepseek-v3.2',
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 5,
    }),
  });
}

async function errorMessage(resp: Response): Promise<string> {
  const body = await resp.json() as { error?: { message?: string } };
  return body?.error?.message ?? '';
}

describe('ENABLE_DYNAMIC_ROUTING gate', () => {
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

  it('rejects a dynamic route with 403 when the flag is unset (default off)', async () => {
    const resp = await handler.fetch(dynamicRequest('/https/api.example.com/v1/messages'), makeEnv() as any);

    assert.equal(resp.status, 403);
    assert.equal(await errorMessage(resp), 'Dynamic routing is disabled.');
  });

  it('does not reinterpret a disabled dynamic path as a fixed route', async () => {
    // A fall-through to parseFixedRoute would route the request to the configured
    // base_url and reach the upstream; being disabled must mean no outbound call.
    await handler.fetch(dynamicRequest('/https/api.example.com/v1/messages'), makeEnv() as any);

    assert.deepEqual(upstreamCalls, []);
  });

  it('treats the string "false" as disabled (the shipped default)', async () => {
    const resp = await handler.fetch(dynamicRequest('/https/api.example.com/v1/messages'), makeEnv('false') as any);

    assert.equal(resp.status, 403);
    assert.equal(await errorMessage(resp), 'Dynamic routing is disabled.');
    assert.deepEqual(upstreamCalls, []);
  });

  it('enables the SSRF allowlist check when set to "true" (disallowed host)', async () => {
    const resp = await handler.fetch(dynamicRequest('/https/evil.example.com/v1/messages'), makeEnv('true') as any);

    assert.equal(resp.status, 403);
    assert.equal(await errorMessage(resp), 'Target host not allowed.');
    assert.deepEqual(upstreamCalls, []);
  });

  it('accepts "1" as enabling', async () => {
    const resp = await handler.fetch(dynamicRequest('/https/evil.example.com/v1/messages'), makeEnv('1') as any);

    assert.equal(resp.status, 403);
    assert.equal(await errorMessage(resp), 'Target host not allowed.');
  });

  it('dispatches to an allowlisted host when enabled', async () => {
    const resp = await handler.fetch(dynamicRequest('/https/api.example.com/v1/messages'), makeEnv('true') as any);

    assert.notEqual(resp.status, 403);
    assert.equal(upstreamCalls.length, 1);
    assert.ok(
      upstreamCalls[0].includes('api.example.com'),
      `Expected dispatch to api.example.com, got ${upstreamCalls[0]}`,
    );
  });
});
