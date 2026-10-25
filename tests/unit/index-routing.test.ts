import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';
import { clearModelCache } from '../../src/handlers/models.js';
import type { Env } from '../../src/types/shared.js';

const realFetch = globalThis.fetch;
let tempDir = '';
let configPath = '';
let upstreamUrls: string[] = [];

function env(extra: Partial<Env> = {}): Env {
  return {
    PROXY_CONFIG_PATH: configPath,
    LOG_LEVEL: 'error',
    VERSION: 'routing-test',
    ALLOWED_ORIGINS: 'https://client.example',
    ...extra,
  };
}

beforeEach(() => {
  clearProxyConfigCache();
  clearModelCache();
  tempDir = mkdtempSync(join(tmpdir(), 'mpv3-index-routing-'));
  configPath = join(tempDir, 'proxy.toml');
  writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"
`, 'utf8');
  upstreamUrls = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    upstreamUrls.push(url);
    return new Response(JSON.stringify({ object: 'list', data: [{ id: 'upstream-model' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
});

afterEach(() => {
  clearProxyConfigCache();
  clearModelCache();
  globalThis.fetch = realFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('top-level request routing', () => {
  it('handles CORS preflight with configured origin and headers', async () => {
    const response = await handler.fetch(new Request('http://proxy/v1/messages', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://client.example',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-api-key,content-type',
      },
    }), env());
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://client.example');
    assert.equal(response.headers.get('access-control-allow-methods'), 'GET, POST, OPTIONS, DELETE');
    assert.equal(response.headers.get('access-control-allow-headers'), 'Content-Type, Authorization, x-api-key, x-goog-api-key, anthropic-beta');
    assert.deepEqual(upstreamUrls, []);
  });

  it('restricts dashboard and config reload endpoints to loopback clients', async () => {
    const forbidden = await handler.fetch(new Request('http://proxy/dashboard', {
      headers: { 'x-client-address': '203.0.113.5' },
    }), env());
    assert.equal(forbidden.status, 403);
    assert.deepEqual(await forbidden.json(), { error: 'Forbidden' });

    const allowed = await handler.fetch(new Request('http://proxy/dashboard', {
      headers: { 'x-client-address': '127.0.0.1' },
    }), env());
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers.get('content-type') || '', /text\/html/);
  });

  it('returns a generic config reload error without a remote source', async () => {
    const response = await handler.fetch(new Request('http://proxy/config-reload', {
      method: 'POST',
      headers: { 'x-client-address': '::1' },
    }), env());
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      status: 'failed',
      error: 'Config reload failed; see server logs for details.',
    });
  });

  it('skips favicon requests without auth or upstream calls', async () => {
    const response = await handler.fetch(new Request('http://proxy/favicon.ico'), env());
    assert.equal(response.status, 204);
    assert.equal(await response.text(), '');
    assert.deepEqual(upstreamUrls, []);
  });

  it('reports healthy model counts from the default upstream', async () => {
    const response = await handler.fetch(new Request('http://proxy/health'), env());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'ok',
      models: 1,
      cached: false,
      version: 'routing-test',
    });
    assert.deepEqual(upstreamUrls, ['https://upstream.example/v1/models']);
  });

  it('returns 404 when no default upstream is configured', async () => {
    writeFileSync(configPath, '[general]\nweek_start_day = "sunday"\n', 'utf8');
    clearProxyConfigCache();
    const response = await handler.fetch(new Request('http://proxy/'), env());
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'No models Found.', version: 'routing-test' });
    assert.deepEqual(upstreamUrls, []);
  });

  it('rejects missing credentials before model request processing', async () => {
    const response = await handler.fetch(new Request('http://proxy/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [] }),
    }), env());
    assert.equal(response.status, 401);
    assert.match(JSON.stringify(await response.json()), /Missing authentication/);
    assert.deepEqual(upstreamUrls, []);
  });

  it('allows unauthenticated model discovery and merges configured models', async () => {
    const response = await handler.fetch(new Request('http://proxy/v1/models'), env());
    assert.equal(response.status, 200);
    const body = await response.json() as { data: Array<{ id: string }> };
    assert.ok(body.data.some((model) => model.id === 'upstream-model'));
    assert.equal(response.headers.get('x-cache'), 'MISS');
    assert.equal(upstreamUrls.length, 1);
  });

  it('enforces dashboard API authentication when configured', async () => {
    writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"

[dashboard]
api_key = "dashboard-secret"
`, 'utf8');
    clearProxyConfigCache();
    const request = (authorization?: string) => new Request('http://proxy/dashboard/api/config', {
      headers: {
        'x-client-address': '127.0.0.1',
        ...(authorization ? { Authorization: authorization } : {}),
      },
    });

    const missing = await handler.fetch(request(), env());
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), { error: 'Unauthorized' });
    const wrong = await handler.fetch(request('Bearer wrong'), env());
    assert.equal(wrong.status, 401);
    const allowed = await handler.fetch(request('Bearer dashboard-secret'), env());
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json() as { config: unknown }).config !== undefined, true);
  });

  it('rejects oversized request bodies before reading or forwarding them', async () => {
    const response = await handler.fetch(new Request('http://proxy/v1/messages', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer client-key',
        'Content-Type': 'application/json',
        'Content-Length': String(10 * 1024 * 1024 + 1),
      },
      body: '{}',
    }), env());
    assert.equal(response.status, 413);
    assert.match(JSON.stringify(await response.json()), /Request body too large/);
    assert.deepEqual(upstreamUrls, []);
  });

  it('routes a plain Messages request with converted body and client auth', async () => {
    let upstreamBody: Record<string, unknown> = {};
    let upstreamAuth = '';
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body));
      upstreamAuth = new Headers(init?.headers).get('authorization') || '';
      return new Response(JSON.stringify({
        id: 'chat-plain', object: 'chat.completion', created: 1, model: 'test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'plain ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const response = await handler.fetch(new Request('http://proxy/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] }),
    }), env());
    assert.equal(response.status, 200);
    assert.equal(upstreamAuth, 'Bearer client-key');
    assert.deepEqual(upstreamBody, {
      model: 'test', max_tokens: 32, messages: [{ role: 'user', content: 'hello' }],
    });
    const body = await response.json() as { content: Array<{ type: string; text: string }> };
    assert.deepEqual(body.content, [{ type: 'text', text: 'plain ok' }]);
  });

  it('dispatches Decision requests with verbatim body and configured auth', async () => {
    writeFileSync(configPath, `
[models.decision]
backend = "cloudflare"
url = "https://decision.example/evaluate"
api_key = "decision-key"
`, 'utf8');
    clearProxyConfigCache();
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response(JSON.stringify({ model: 'decider', answers: { q1: 'yes' }, usage: {} }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const decisionBody = { model: 'decider', state: {}, questions: { q1: {} } };

    const response = await handler.fetch(new Request('http://proxy/decision', {
      method: 'POST',
      headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
      body: JSON.stringify(decisionBody),
    }), env());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { model: 'decider', answers: { q1: 'yes' }, usage: {} });
    assert.equal(seenUrl, 'https://decision.example/evaluate');
    assert.equal(seenInit?.body, JSON.stringify(decisionBody));
    assert.equal(new Headers(seenInit?.headers).get('authorization'), 'Bearer decision-key');
  });

  it('routes an open-responses upstream mode as a Responses passthrough', async () => {
    writeFileSync(configPath, `
[models.default]
upstream_mode = "open-responses"
base_url = "https://upstream.example"
api_key = "upstream-key"
`, 'utf8');
    clearProxyConfigCache();
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response('{"id":"resp_open_responses","status":"completed","output":[]}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
    const body = { model: 'test', input: 'hello' };

    const response = await handler.fetch(new Request('http://proxy/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), env());
    assert.equal(response.status, 200);
    assert.equal(seenUrl, 'https://upstream.example/v1/responses');
    assert.equal(seenInit?.body, JSON.stringify(body));
    assert.equal(new Headers(seenInit?.headers).get('authorization'), 'Bearer client-key');
  });

  it('matches open-responses passthrough targets to /v1/responses paths', async () => {
    writeFileSync(configPath, `
[models.passthrough]
openres = { base = "https://openres.example", mode = "open-responses", key = "openres-key" }
`, 'utf8');
    clearProxyConfigCache();
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response('{"id":"resp_passthrough"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const body = { model: 'test', input: 'hello' };

    const response = await handler.fetch(new Request('http://proxy/passthrough/v1/responses', {
      method: 'POST',
      headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), env());
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"id":"resp_passthrough"}');
    assert.equal(seenUrl, 'https://openres.example/v1/responses');
    assert.equal(seenInit?.body, JSON.stringify(body));
    assert.equal(new Headers(seenInit?.headers).get('authorization'), 'Bearer openres-key');
  });

  it('dispatches passthrough requests with path, body, and mode-specific auth intact', async () => {    writeFileSync(configPath, `
[models.passthrough]
claude = { base = "https://passthrough.example", mode = "anthropic-messages", key = "passthrough-key" }
`, 'utf8');
    clearProxyConfigCache();
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response('{"id":"msg_passthrough"}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const body = { model: 'claude-test', messages: [{ role: 'user', content: 'hello' }] };

    const response = await handler.fetch(new Request('http://proxy/passthrough/v1/messages?trace=1', {
      method: 'POST',
      headers: { 'x-api-key': 'client-key', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }), env());
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"id":"msg_passthrough"}');
    assert.equal(seenUrl, 'https://passthrough.example/v1/messages?trace=1');
    assert.equal(seenInit?.body, JSON.stringify(body));
    assert.equal(new Headers(seenInit?.headers).get('x-api-key'), 'passthrough-key');
  });

  it('dispatches dashboard stats, tools, quota, and mutation routes', async () => {
    const call = (path: string, method = 'GET', body?: unknown) => handler.fetch(new Request(`http://proxy${path}`, {
      method,
      headers: {
        'x-client-address': '127.0.0.1',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), env());

    for (const path of [
      '/dashboard/api/stats/models',
      '/dashboard/api/stats/agents',
      '/dashboard/api/tools/blocklist',
      '/dashboard/api/stats/requests',
    ]) {
      const response = await call(path);
      assert.equal(response.status, 200, path);
      assert.equal(response.headers.get('access-control-allow-origin'), 'https://client.example');
    }
    assert.equal((await call('/dashboard/api/quota')).status, 400);
    assert.deepEqual(await (await call('/dashboard/api/tools/toggle-block', 'POST', { tool_name: 'route_tool', blocked: true })).json(), {
      ok: true, tool_name: 'route_tool', blocked: true,
    });

    assert.equal((await call('/dashboard/api/models/default/new_model', 'POST', {
      target: 'vendor/new', base_url: 'https://new.example/v1', api_key: '', mode: 'openai-completions',
    })).status, 200);
    assert.equal((await call('/dashboard/api/schedule/alias', 'POST', { alias: 'route_schedule' })).status, 200);
    assert.equal((await call('/dashboard/api/schedule/alias/route_schedule/target', 'POST', {
      target: 'new_model', windows: [{ from: 0, to: 12 }],
    })).status, 200);
    assert.equal((await call('/dashboard/api/schedule/alias/route_schedule/target/new_model', 'DELETE')).status, 200);
    assert.equal((await call('/dashboard/api/schedule/alias/route_schedule', 'DELETE')).status, 200);
  });

  it('rejects malformed model JSON without forwarding upstream', async () => {
    const response = await handler.fetch(new Request('http://proxy/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
      body: '{not-json',
    }), env());
    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /Invalid request body/);
    assert.deepEqual(upstreamUrls, []);
  });

  it('enforces configured global token limits before model routing', async () => {
    writeFileSync(configPath, `
[general]
global_token_limit = "1 1h"

[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"
`, 'utf8');
    clearProxyConfigCache();
    const previousDashboard = process.env.DASHBOARD;
    process.env.DASHBOARD = 'true';
    try {
      const { recordModelUsage } = await import('../../src/utils/dashboard-stats.js');
      recordModelUsage('__index_limit_model__', { total_tokens: 5 });
      const response = await handler.fetch(new Request('http://proxy/v1/messages', {
        method: 'POST',
        headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hello' }] }),
      }), env());
      assert.equal(response.status, 429);
      assert.match(JSON.stringify(await response.json()), /global token limit/);
      assert.deepEqual(upstreamUrls, []);
    } finally {
      if (previousDashboard === undefined) delete process.env.DASHBOARD;
      else process.env.DASHBOARD = previousDashboard;
    }
  });

  it('buffers streamed request bodies without a content-length before forwarding', async () => {
    const payload = { model: 'test', messages: [{ role: 'user', content: 'streamed body' }] };
    const encoded = new TextEncoder().encode(JSON.stringify(payload));
    let upstreamBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'chat-buffered', object: 'chat.completion', created: 1, model: 'test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'buffered ok' }, finish_reason: 'stop' }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded.slice(0, 17));
        controller.enqueue(encoded.slice(17));
        controller.close();
      },
    });
    const request = new Request('http://proxy/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
      body,
      duplex: 'half',
    } as RequestInit);
    assert.equal(request.headers.get('content-length'), null);

    const response = await handler.fetch(request, env());

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamBody, payload);
    const responseBody = await response.json() as { content: Array<{ type: string; text: string }> };
    assert.deepEqual(responseBody.content, [{ type: 'text', text: 'buffered ok' }]);
  });
});
