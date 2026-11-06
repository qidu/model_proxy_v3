import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';
import { clearModelCache } from '../../src/handlers/models.js';
import { BLOB_REF_MARKER } from '../../src/utils/blob-refs.js';
import { evictIdleBlobs, getBlobStoreStats, resetBlobStore } from '../../src/utils/blob-store.js';
import { getSpoolConfig, requestSpillDir, responseSpillDir } from '../../src/utils/spool.js';
import { getLiveSpillBytes, SpoolBody } from '../../src/utils/spool-body.js';
import { countClaudeRequestTokens } from '../../src/utils/token-counting.js';
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

/**
 * The text the upstream actually received, whichever egress shape carried it:
 * passthrough egress streams the raw client bytes (§5.3), while a converted
 * egress serializes its own body to one string at the send boundary.
 */
async function sentBodyText(init: RequestInit | undefined): Promise<string> {
  const body = init?.body;
  if (typeof body === 'string') return body;
  assert.ok(body instanceof ReadableStream, `expected a streamed upstream body, got ${Object.prototype.toString.call(body)}`);
  return await new Response(body).text();
}

/** Parse an SSE body into its named event frames. */
function parseSseEvents(raw: string): Array<{ event: string; data: any }> {
  const events: Array<{ event: string; data: any }> = [];
  for (const block of raw.split('\n\n')) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let event = '';
    let dataStr = '';
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) dataStr = line.slice(6);
    }
    if (dataStr) events.push({ event, data: JSON.parse(dataStr) });
  }
  return events;
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

  it('spools an inline image and sends the original bytes upstream', async () => {
    writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"

[spool]
enabled = true
dir = ${JSON.stringify(join(tempDir, 'spool'))}
`, 'utf8');
    clearProxyConfigCache();
    resetBlobStore();

    const image = Buffer.alloc(4096, 0xab).toString('base64');
    let upstreamText = '';
    let statsAtSend = { diskEntries: 0, diskBytes: 0 };
    let bodyReads = 0;
    // Sampled at the send: the property is about the request body, and the stats
    // read of the response (§5.7, `index.ts`) reads a spool of its own afterwards.
    let bodyReadsAtSend = -1;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamText = await sentBodyText(init);
      bodyReadsAtSend = bodyReads;
      // Sampled while the request is in flight: the payload must really be in the
      // store (extraction ran) and still leased (nothing released it early).
      statsAtSend = getBlobStoreStats();
      return new Response(JSON.stringify({
        id: 'chat-image', object: 'chat.completion', created: 1, model: 'test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'seen' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const originalReadBytes = SpoolBody.prototype.readBytes;
    SpoolBody.prototype.readBytes = async function (this: SpoolBody, ...args: any[]) {
      bodyReads += 1;
      return await originalReadBytes.apply(this, args);
    } as typeof originalReadBytes;
    let response: Response;
    try {
      response = await handler.fetch(new Request('http://proxy/v1/messages', {
        method: 'POST',
        headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'test',
          max_tokens: 32,
          messages: [{
            role: 'user',
            content: [
              { type: 'text', text: 'what is this' },
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
            ],
          }],
        }),
      }), env());
    } finally {
      SpoolBody.prototype.readBytes = originalReadBytes;
    }

    assert.equal(bodyReadsAtSend, 1, 'only the initial routing parse materializes the raw spool; request reconstruction does not');
    assert.equal(response.status, 200);
    assert.equal(statsAtSend.diskEntries, 1, 'the payload was in the blob store while the request was in flight');
    assert.equal(statsAtSend.diskBytes, image.length);
    assert.equal(
      upstreamText.includes(BLOB_REF_MARKER),
      false,
      'no ref may reach the upstream — the send boundary expands them all',
    );
    assert.ok(
      upstreamText.includes(image),
      'the boundary restored the exact base64 the client sent',
    );
    const body = await response.json() as { content: Array<{ type: string; text: string }> };
    assert.deepStrictEqual(body.content, [{ type: 'text', text: 'seen' }]);

    // The handler's `finally` gave the effective body's lease back, so the blob
    // is idle and the next sweep may reclaim it.
    assert.equal(
      await evictIdleBlobs(Date.now() + (getSpoolConfig().ttlSeconds * 1000) + 1000),
      1,
      'the request released its lease',
    );
    assert.equal(getBlobStoreStats().diskBytes, 0);
  });

  it('releases the large non-ref effective spill before dispatch and keeps only the attempt spill at upstream send', async () => {
    const spoolDir = join(tempDir, 'spool');
    writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"

[spool]
enabled = true
dir = ${JSON.stringify(spoolDir)}
threshold_bytes = 256
`, 'utf8');
    clearProxyConfigCache();
    resetBlobStore();

    const padding = `large non-ref ${'x'.repeat(1024)}`;
    let filesAtUpstream: string[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const spillDir = requestSpillDir(getSpoolConfig());
      filesAtUpstream = existsSync(spillDir) ? readdirSync(spillDir) : [];
      const upstreamBody = JSON.parse(await sentBodyText(init)) as { messages: Array<{ content: Array<{ type: string; text: string }> }> };
      assert.deepEqual(upstreamBody.messages[0].content, [{ type: 'text', text: padding }], 'the attempt inherits the effective body byte-for-byte');
      return new Response(JSON.stringify({
        id: 'chat-nonref', object: 'chat.completion', created: 1, model: 'test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'seen' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const response = await handler.fetch(new Request('http://proxy/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', max_tokens: 32, messages: [{ role: 'user', content: [{ type: 'text', text: padding }] }] }),
    }), env());

    assert.equal(response.status, 200);
    assert.ok(filesAtUpstream.some((name) => name.startsWith('att-')), `the upstream send must read an attempt spill, saw ${filesAtUpstream}`);
    assert.equal(filesAtUpstream.some((name) => name.startsWith('eff-')), false, `the effective spill must be consumed before dispatch, saw ${filesAtUpstream}`);
    const spillDir = requestSpillDir(getSpoolConfig());
    assert.deepEqual(existsSync(spillDir) ? readdirSync(spillDir) : [], [], 'raw, effective, and attempt spills are all gone after the exchange');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('gives two fallback rungs isolated disk-backed attempts over the same effective body', async () => {
    const spoolDir = join(tempDir, 'spool');
    writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"

[composite]
"combo" = {"rung-a" = {primary = true}, "rung-b" = {fallback = 1}}

[spool]
enabled = true
dir = ${JSON.stringify(spoolDir)}
threshold_bytes = 256
`, 'utf8');
    clearProxyConfigCache();
    resetBlobStore();

    const padding = `rung-shared ${'x'.repeat(1024)}`;
    const sentModels: string[] = [];
    const filesAtEachSend: string[][] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const spillDir = requestSpillDir(getSpoolConfig());
      filesAtEachSend.push(existsSync(spillDir) ? readdirSync(spillDir) : []);
      const upstreamBody = JSON.parse(await sentBodyText(init)) as { model: string; messages: Array<{ content: Array<{ text: string }> }> };
      sentModels.push(upstreamBody.model);
      assert.deepEqual(upstreamBody.messages[0].content, [{ type: 'text', text: padding }], 'each rung inherits the same effective body');
      if (sentModels.length === 1) {
        return new Response(JSON.stringify({ error: { message: 'first rung failed' } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        id: 'chat-rung-b', object: 'chat.completion', created: 1, model: 'rung-b',
        choices: [{ index: 0, message: { role: 'assistant', content: 'second ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const response = await handler.fetch(new Request('http://proxy/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'combo', max_tokens: 32, messages: [{ role: 'user', content: [{ type: 'text', text: padding }] }] }),
    }), env());

    assert.equal(response.status, 200);
    assert.deepEqual(sentModels, ['rung-a', 'rung-b'], "rung A's model rewrite must not leak into rung B");
    assert.equal(filesAtEachSend.length, 2);
    assert.ok(filesAtEachSend.every((names) => names.some((name) => name.startsWith('att-'))), `each send must use its own attempt spill: ${JSON.stringify(filesAtEachSend)}`);
    const spillDir = requestSpillDir(getSpoolConfig());
    assert.deepEqual(existsSync(spillDir) ? readdirSync(spillDir) : [], [], 'both attempt spills and the raw/effective state are gone');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('leaves an inline image alone when the spool is not configured', async () => {
    resetBlobStore();
    const image = Buffer.alloc(4096, 0xcd).toString('base64');
    let upstreamText = '';
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamText = await sentBodyText(init);
      return new Response(JSON.stringify({
        id: 'chat-image-off', object: 'chat.completion', created: 1, model: 'test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'seen' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const response = await handler.fetch(new Request('http://proxy/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        max_tokens: 32,
        messages: [{
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } }],
        }],
      }),
    }), env());

    // §9.1: with no `[spool]` section nothing is stored and the request is
    // byte-for-byte the request the proxy has always sent.
    assert.equal(getSpoolConfig().enabled, false);
    assert.equal(response.status, 200);
    assert.equal(getBlobStoreStats().diskEntries, 0);
    assert.ok(upstreamText.includes(image));
  });

  it('reports SSE input usage counted from the effective body before the response stream exists', async () => {
    writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"

[spool]
enabled = true
dir = ${JSON.stringify(join(tempDir, 'spool'))}
`, 'utf8');
    clearProxyConfigCache();
    resetBlobStore();

    const image = Buffer.alloc(4096, 0xab).toString('base64');
    const clientBody = {
      model: 'test',
      max_tokens: 32,
      stream: true,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
        ],
      }],
    };

    let upstreamText = '';
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamText = await sentBodyText(init);
      return new Response([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'seen' }, index: 0, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;

    const response = await handler.fetch(new Request('http://proxy/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
      body: JSON.stringify(clientBody),
    }), env({ LOCAL_TIKTOKEN: 'true' }));

    assert.equal(response.status, 200);
    // The body still carries a ref at the send boundary and the converted egress
    // streams it (§5.3 shape 3), so the client's exact base64 reaches upstream
    // without the expanded body ever existing.
    assert.ok(upstreamText.includes(image), 'the boundary restored the exact client base64');

    const events = parseSseEvents(await response.text());
    const messageStart = events.find(e => e.event === 'message_start');
    const options = { useLocalCounting: true, tokenizer: null };
    const withoutImage = countClaudeRequestTokens({
      ...clientBody,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'what is this' }] }],
    } as any, options);

    // The count now comes off the ref, not the text: the §5.3 rule is
    // `Math.ceil(base64 chars / charactersPerToken)` for the payload with every
    // fixed block cost dropped, so it is the ref's recorded `size` over 4 — a
    // number the body does not hold as a string — plus the text-only count.
    // Asserting the exact sum is what proves the payload was measured by its
    // recorded length rather than read.
    assert.equal(
      messageStart!.data.message.usage.input_tokens,
      Math.ceil(image.length / 4) + withoutImage,
      'input usage is the §5.3 ref count over the effective body, image included',
    );
    assert.ok(withoutImage > 0, 'the text-only count must be non-zero for the sum to mean anything');
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
    assert.equal(await sentBodyText(seenInit), JSON.stringify(body));
    assert.equal(
      new Headers(seenInit?.headers).get('content-length'),
      String(new TextEncoder().encode(JSON.stringify(body)).byteLength),
      'the upstream must get an exact byte length for the streamed body',
    );
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
    assert.equal(await sentBodyText(seenInit), JSON.stringify(body));
    assert.equal(
      new Headers(seenInit?.headers).get('content-length'),
      String(new TextEncoder().encode(JSON.stringify(body)).byteLength),
      'the upstream must get an exact byte length for the streamed body',
    );
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

  it('routes embeddings to [models.EMBEDDING].base_url, never to [models.default].base_url', async () => {
    writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"

[models.EMBEDDING]
base_url = "https://embed.example"
"nomic-embed-text" = {}
`, 'utf8');
    clearProxyConfigCache();
    let seenUrl = '';
    let seenBody = '';
    const upstreamPayload = {
      object: 'list',
      data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
      model: 'nomic-embed-text',
      usage: { prompt_tokens: 3, total_tokens: 3 },
    };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenBody = String(init?.body);
      return new Response(JSON.stringify(upstreamPayload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const payload = { model: 'nomic-embed-text', input: 'hello' };

    const response = await handler.fetch(new Request('http://proxy/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }), env());

    assert.equal(response.status, 200);
    assert.equal(seenUrl, 'https://embed.example/v1/embeddings');
    assert.equal(seenBody, JSON.stringify(payload));
    assert.deepEqual(await response.json(), upstreamPayload);
  });

  it('rejects /v1/embeddings when [models.EMBEDDING].base_url is absent', async () => {
    // The default upstream is configured and reachable — the point is that it is
    // NOT used as a fallback, so this must fail loudly and never call upstream.
    for (const [label, embeddingSection] of [
      ['section omitted', ''],
      ['section without base_url', '[models.EMBEDDING]\n"nomic-embed-text" = {}\n'],
    ] as const) {
      writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"

${embeddingSection}`, 'utf8');
      clearProxyConfigCache();

      const response = await handler.fetch(new Request('http://proxy/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'nomic-embed-text', input: 'hello' }),
      }), env());

      assert.equal(response.status, 500, label);
      assert.equal(
        ((await response.json()) as { error: { message: string } }).error.message,
        '/v1/embeddings requires [models.EMBEDDING].base_url (or [models.embedding].base_url): this route does not inherit [models.default].base_url',
        label,
      );
      assert.deepEqual(upstreamUrls, [], label);
    }
  });

  it('posts to {base_url}/api/embed for upstream_mode "ollama-embed" and converts both directions', async () => {
    writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"

[models.EMBEDDING]
upstream_mode = "ollama-embed"
base_url = "http://localhost:11434"
`, 'utf8');
    clearProxyConfigCache();
    let seenUrl = '';
    let seenBody: Record<string, unknown> = {};
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        model: 'nomic-embed-text', embeddings: [[0.1, 0.2]], total_duration: 42, prompt_eval_count: 7,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const response = await handler.fetch(new Request('http://proxy/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', input: 'hello', encoding_format: 'float', user: 'user-1' }),
    }), env());

    assert.equal(response.status, 200);
    assert.equal(seenUrl, 'http://localhost:11434/api/embed');
    assert.deepEqual(seenBody, { model: 'nomic-embed-text', input: 'hello' });
    assert.deepEqual(await response.json(), {
      object: 'list',
      data: [{ object: 'embedding', embedding: [0.1, 0.2], index: 0 }],
      model: 'nomic-embed-text',
      usage: { prompt_tokens: 7, total_tokens: 7 },
    });
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

describe('§5.7 SSE event framing on the response egress', () => {
  // The framing sits between the handler's converted SSE body and the client, so
  // these tests drive it through a real `/v1/messages` request with an
  // openai-completions upstream and inspect what the client and the spool see.
  const SPOOL_DIR_NAME = 'spool';

  function writeConfig(args: { enabled: boolean; extra?: string }): void {
    writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"

[spool]
enabled = ${args.enabled ? 'true' : 'false'}
dir = ${JSON.stringify(join(tempDir, SPOOL_DIR_NAME))}
${args.extra ?? ''}
`, 'utf8');
    clearProxyConfigCache();
    resetBlobStore();
  }

  /** File names currently in `<spool>/events`, or `[]` when the dir is absent. */
  function eventSpills(): string[] {
    const dir = join(tempDir, SPOOL_DIR_NAME, 'events');
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }

  /** One OpenAI chat-completions chunk carrying `text` as a content delta. */
  function deltaChunk(text: string): string {
    return `data: ${JSON.stringify({ choices: [{ delta: { content: text }, index: 0, finish_reason: null }] })}\n\n`;
  }

  const STOP_CHUNK = `data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] })}\n\n`;
  const DONE_CHUNK = 'data: [DONE]\n\n';

  /** Stub the upstream with a fixed SSE body and return it for byte comparisons. */
  function stubSseUpstream(raw: string): void {
    globalThis.fetch = (async () => new Response(raw, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })) as typeof fetch;
  }

  /**
   * Stub the upstream with an SSE body delivered one event per `pull`, which is
   * how a real upstream streams it, and so the relay is mid-stream at every
   * event boundary rather than holding the whole response in one chunk already
   * closed. Whether the proxy cancels the upstream is asserted at the primitive
   * level instead (`spool-events.test.ts`), because a stub's own `cancel` cannot
   * observe it: the converter drains a body this short into itself before the
   * framing sees the oversized event, so the stub has already closed and a
   * closed stream has no cancel to call.
   */
  function stubStreamedSseUpstream(parts: string[]): void {
    let index = 0;
    const encoder = new TextEncoder();
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= parts.length) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(parts[index++]!));
      },
    }), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })) as typeof fetch;
  }

  function messagesRequest(): Request {
    return new Request('http://proxy/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        max_tokens: 32,
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
  }

  /** Every `data.text` the client received, in order, concatenated. */
  function streamedText(raw: string): string {
    let out = '';
    for (const block of raw.split('\n\n')) {
      const dataLine = block.split('\n').find(line => line.startsWith('data: '));
      if (!dataLine) continue;
      const payload = JSON.parse(dataLine.slice(6));
      if (payload.type === 'content_block_delta' && payload.delta?.type === 'text_delta') {
        out += payload.delta.text;
      }
    }
    return out;
  }

  it('frames without changing a byte: the client stream is identical with the spool on and off', async () => {
    const raw = deltaChunk('alpha ') + deltaChunk('beta') + STOP_CHUNK + DONE_CHUNK;

    // §9.1/decision: disabled means no framing at all — the relay is exactly
    // today's bytes.
    writeConfig({ enabled: false });
    stubSseUpstream(raw);
    const off = await handler.fetch(messagesRequest(), env());
    assert.equal(off.status, 200);
    const offBody = await off.text();

    writeConfig({ enabled: true });
    stubSseUpstream(raw);
    const on = await handler.fetch(messagesRequest(), env());
    assert.equal(on.status, 200);
    const onBody = await on.text();

    // Framing is a relay, not a rewrite: same bytes, same event order. (The
    // handler's OpenAI→Claude conversion is what makes this stream differ from
    // the upstream bytes; framing must not add to that difference.) The message
    // id is generated per request, so it is normalized before the comparison.
    const withoutRequestId = (text: string) => text.replace(/req_\d+_[0-9a-f-]+/g, 'req_normalized');
    assert.equal(
      withoutRequestId(onBody),
      withoutRequestId(offBody),
      'the enabled relay forwards the identical byte sequence',
    );
    assert.equal(streamedText(onBody), 'alpha beta', 'event order and payloads survive framing');
    assert.deepEqual(eventSpills(), [], 'events below threshold_bytes never spill');
  });

  it('spills an event above threshold_bytes while the client is paused, and deletes it after delivery', async () => {
    const big = 'x'.repeat(256 * 1024);
    writeConfig({ enabled: true, extra: 'threshold_bytes = 4096\n' });
    stubSseUpstream(deltaChunk(big) + STOP_CHUNK + DONE_CHUNK);

    const response = await handler.fetch(messagesRequest(), env());
    assert.equal(response.status, 200);
    assert.ok(response.body);

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let liveSpills: string[] | null = null;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      chunks.push(next.value!);
      // The oversized event is streamed out of its spill a chunk at a time, so
      // once the client has begun receiving it the rest is still on disk — that
      // is the event-bound window §5.7 asks for, and it must not be empty.
      if (liveSpills === null && Buffer.concat(chunks).includes('event: content_block_delta')) {
        liveSpills = eventSpills();
      }
    }
    const body = Buffer.concat(chunks).toString('utf8');

    assert.ok(liveSpills, 'the client must have received the oversized event');
    assert.equal(liveSpills!.length, 1, `expected one live event spill, saw ${liveSpills!.length}`);
    assert.ok(liveSpills![0]!.startsWith('evt-'), `spill names its writer, got ${liveSpills![0]}`);

    assert.deepEqual(eventSpills(), [], 'the event spill is deleted once its last byte is written');
    assert.equal(streamedText(body).length, big.length, 'the whole oversized event reached the client');
    assert.equal(streamedText(body), big, 'and it reached it unmodified and in order');
  });

  it('caps one event at max_response_bytes instead of streaming it unbounded', async () => {
    const big = 'y'.repeat(32 * 1024);
    writeConfig({ enabled: true, extra: 'max_response_bytes = 8192\n' });
    stubStreamedSseUpstream([deltaChunk(big), STOP_CHUNK, DONE_CHUNK]);

    const response = await handler.fetch(messagesRequest(), env());
    assert.equal(response.status, 200);
    assert.ok(response.body);

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let failure: unknown;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        chunks.push(next.value!);
      }
    } catch (error) {
      failure = error;
    }

    assert.ok(failure, 'an event past max_response_bytes must fail the stream, not truncate it');
    assert.match(String(failure), /SSE event body too large/);
    const partial = Buffer.concat(chunks).toString('utf8');
    assert.ok(!partial.includes('message_stop'), 'no terminal event is emitted for a failed stream');
    assert.deepEqual(eventSpills(), [], 'the aborted event leaves no spill behind');
  });

  it('does not frame when the spool is disabled, even for an event past max_response_bytes', async () => {
    const big = 'z'.repeat(32 * 1024);
    // `max_response_bytes` is configured but the spool is off: with spooling off
    // there is nothing to spill and no per-event copy to pay for.
    writeConfig({ enabled: false, extra: 'max_response_bytes = 8192\n' });
    stubSseUpstream(deltaChunk(big) + STOP_CHUNK + DONE_CHUNK);

    const response = await handler.fetch(messagesRequest(), env());
    assert.equal(response.status, 200);
    const body = await response.text();

    assert.equal(streamedText(body), big, 'the oversized event is relayed untouched');
    assert.deepEqual(eventSpills(), [], 'no framing, so no event spill can exist');
  });
});

describe('§5.7 spooling of the attempt loop\'s response reads', () => {
  // `runAttempt` (index.ts) parses a completed JSON response once for usage and
  // tool-name stats. §5.7 forbids paying for that with `response.clone()` — the
  // clone holds every remaining byte while it is parsed — so with the spool on
  // the body goes through the bounded receive path and the client's copy streams
  // back out of the same spool.
  const SPOOL_DIR_NAME = 'spool';

  function writeConfig(args: { enabled: boolean; extra?: string }): void {
    writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"

[spool]
enabled = ${args.enabled ? 'true' : 'false'}
dir = ${JSON.stringify(join(tempDir, SPOOL_DIR_NAME))}
${args.extra ?? ''}
`, 'utf8');
    clearProxyConfigCache();
    resetBlobStore();
  }

  /** File names currently in `<spool>/responses`, or `[]` when the dir is absent. */
  function responseSpills(): string[] {
    const dir = responseSpillDir(getSpoolConfig());
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }

  /** One OpenAI chat-completions response whose only content is `text`. */
  function chatCompletion(text: string): string {
    return JSON.stringify({
      id: 'chat-json-spill', object: 'chat.completion', created: 1, model: 'test',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
  }

  function messagesRequest(): Request {
    return new Request('http://proxy/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        max_tokens: 32,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
  }

  it('spills the body past threshold_bytes, never clones it, and streams the same bytes back', async () => {
    const long = 'the quick brown fox '.repeat(256);
    const upstreamBody = chatCompletion(long);
    assert.ok(Buffer.byteLength(upstreamBody, 'utf8') > 4096, 'the fixture has to cross the threshold');
    writeConfig({ enabled: true, extra: 'threshold_bytes = 1024\n' });
    globalThis.fetch = (async () => new Response(upstreamBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    let clones = 0;
    const originalClone = Response.prototype.clone;
    Response.prototype.clone = function (this: Response) {
      clones += 1;
      return originalClone.call(this);
    } as typeof originalClone;
    let response: Response;
    try {
      response = await handler.fetch(messagesRequest(), env());
    } finally {
      Response.prototype.clone = originalClone;
    }

    assert.equal(response.status, 200);
    assert.equal(clones, 0, '§5.7: the stats read must not clone the body');
    assert.equal(responseSpills().length, 1, 'the body is on disk, not held as a second copy');

    const body = await response.json() as { content: Array<{ type: string; text: string }> };
    assert.deepEqual(body.content, [{ type: 'text', text: long }], 'the client gets the upstream text unchanged');
    assert.deepEqual(responseSpills(), [], 'the spill is released once the client has drained it');
    assert.equal(getLiveSpillBytes(), 0, 'the disk reservation went back with the file');
  });

  it('fails a body past max_response_bytes explicitly instead of truncating it', async () => {
    writeConfig({ enabled: true, extra: 'threshold_bytes = 512\nmax_response_bytes = 2048\n' });
    globalThis.fetch = (async () => new Response(chatCompletion('x'.repeat(8192)), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    const response = await handler.fetch(messagesRequest(), env());

    assert.equal(response.status, 500, 'an oversized response fails as SpoolResponseTooLargeError, not as a truncated 200');
    const payload = await response.json() as { type: string; error: { type: string; message: string } };
    assert.equal(payload.type, 'error');
    assert.equal(payload.error.type, 'processing_error');
    assert.match(payload.error.message, /Response body too large/);
    assert.deepEqual(responseSpills(), [], 'the refused body leaves no spill behind');
    assert.equal(getLiveSpillBytes(), 0);
  });

  describe('the non-2xx error body, when it is recorded to the collector', () => {
    // The same block's `else if (attemptModelId)` branch attaches the upstream's
    // error body to the zero-usage record for `[remote] record_server`. That read
    // used to be a `clone()` too, so a failed attempt paid a second copy of the
    // error body — the one path where the body is otherwise large and useless.
    //
    // These tests drive the openai-completions passthrough, not `/v1/messages`:
    // the branch only sees a non-2xx response the handler *returned*, and
    // `messages.ts` reads the error body itself and throws it out through
    // `handleTargetApiError`. The passthrough hands the upstream's status, headers
    // and bytes back untouched, so the client-side copy can be asserted exactly.
    const RECORD_URL = 'http://collector.test/usage';

    function completionsRequest(): Request {
      return new Request('http://proxy/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
      });
    }

    /** Upstream answers `status` with `body`; the collector POST is captured. */
    function upstreamError(body: string, status: number): { records: any[] } {
      const records: any[] = [];
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url === RECORD_URL) {
          records.push(JSON.parse(String(init?.body)));
          return new Response('{}', { status: 204 });
        }
        return new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch;
      return { records };
    }

    /** Counts `Response.prototype.clone` while `body` runs. */
    async function countingClones<T>(body: () => Promise<T>): Promise<{ value: T; clones: number }> {
      let clones = 0;
      const originalClone = Response.prototype.clone;
      Response.prototype.clone = function (this: Response) {
        clones += 1;
        return originalClone.call(this);
      } as typeof originalClone;
      try {
        return { value: await body(), clones };
      } finally {
        Response.prototype.clone = originalClone;
      }
    }

    /** The fire-and-forget record POST; one macrotask is enough to land it. */
    async function settleRecord(): Promise<void> {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    const REMOTE = `\n[remote]\nrecord_server = ${JSON.stringify(RECORD_URL)}\n`;

    it('spills the error body past threshold_bytes, never clones it, and streams the same bytes to the client', async () => {
      const message = `upstream exploded: ${'e'.repeat(6000)}`;
      const upstreamBody = JSON.stringify({ error: { message, type: 'server_error' } });
      assert.ok(Buffer.byteLength(upstreamBody, 'utf8') > 4096, 'the fixture has to cross the threshold');
      const { records } = upstreamError(upstreamBody, 500);
      writeConfig({ enabled: true, extra: `threshold_bytes = 1024\n${REMOTE}record_response_body = true\n` });

      const { value: response, clones } = await countingClones(() => handler.fetch(completionsRequest(), env()));

      assert.equal(response.status, 500, 'the upstream failure still reaches the client as itself');
      assert.equal(clones, 0, '§5.7: the error-body read must not clone the response');
      assert.equal(responseSpills().length, 1, 'the error body is on disk while the client holds it');
      const clientText = await response.text();
      await settleRecord();

      assert.equal(clientText, upstreamBody, 'the client receives the upstream error byte for byte, out of the spool');
      assert.equal(records.length, 1, 'the failure is still recorded to the collector');
      assert.equal(records[0].response_status, 500);
      assert.deepEqual(records[0].response_body, { error: { message, type: 'server_error' } },
        'the collector gets the upstream error body, not a truncation of it');
      assert.deepEqual(responseSpills(), [], 'the spill is released once the client has drained it');
      assert.equal(getLiveSpillBytes(), 0);
    });

    it('fails an error body past max_response_bytes explicitly instead of recording a truncated one', async () => {
      const { records } = upstreamError(JSON.stringify({ error: { message: 'x'.repeat(8192) } }), 502);
      writeConfig({
        enabled: true,
        extra: `threshold_bytes = 512\nmax_response_bytes = 2048\n${REMOTE}record_response_body = true\n`,
      });

      const response = await handler.fetch(completionsRequest(), env());
      await settleRecord();

      assert.equal(response.status, 500, 'the cap breach is a spool failure, not the upstream 502');
      const payload = await response.json() as { type: string; error: { type: string; message: string } };
      assert.equal(payload.error.type, 'processing_error');
      assert.match(payload.error.message, /Response body too large/);
      assert.deepEqual(records, [], 'no record is posted for a body the proxy refused to read');
      assert.deepEqual(responseSpills(), [], 'the refused body leaves no spill behind');
      assert.equal(getLiveSpillBytes(), 0);
    });

    it('leaves the error path byte-identical when the spool is off, and still records the parsed body', async () => {
      const upstreamBody = JSON.stringify({ error: { message: `legacy ${'l'.repeat(6000)}`, type: 'server_error' } });
      const { records } = upstreamError(upstreamBody, 500);
      writeConfig({ enabled: false, extra: `threshold_bytes = 1024\n${REMOTE}record_response_body = true\n` });

      const { value: response, clones } = await countingClones(() => handler.fetch(completionsRequest(), env()));
      const clientText = await response.text();
      await settleRecord();

      // The pre-existing shape of this branch: the clone is what the disabled
      // path does, which is why the spool turns it into a bounded receive.
      assert.equal(clones, 1, 'with the spool off the error body is still read through a clone');
      assert.equal(records.length, 1);
      assert.deepEqual(records[0].response_body, JSON.parse(upstreamBody));
      assert.equal(clientText, upstreamBody, 'the clone leaves the client copy untouched');
      assert.equal(responseSpills().length, 0, 'nothing is spilled when the spool is off');
    });

    it('does not read the error body at all when record_response_body is off', async () => {
      const upstreamBody = JSON.stringify({ error: { message: `unread ${'u'.repeat(6000)}`, type: 'server_error' } });
      const { records } = upstreamError(upstreamBody, 500);
      writeConfig({ enabled: true, extra: `threshold_bytes = 1024\n${REMOTE}record_response_body = false\n` });

      const { value: response, clones } = await countingClones(() => handler.fetch(completionsRequest(), env()));
      assert.equal(clones, 0, 'no body read, so nothing to clone');
      assert.deepEqual(responseSpills(), [], 'and nothing brought to disk on the way');
      const clientText = await response.text();
      await settleRecord();

      assert.equal(clientText, upstreamBody);
      assert.equal(records.length, 1, 'the failure is still recorded, just without a body');
      assert.equal(records[0].response_status, 500);
      assert.equal('response_body' in records[0], false, 'the record carries no body');
      assert.equal(getLiveSpillBytes(), 0);
    });
  });

  describe('the ladder\'s abandoned responses, when the spool holds them', () => {
    // A retried or superseded rung's Response never reaches the client, so
    // nothing drains the body the error read above attached a spill to. The
    // startup sweep is the only other reaper, so an abandoned spill would pin
    // its file and its §5.9 reservation for the life of the process — a budget
    // every later request pays for. The ladder cancels the body at both drop
    // points instead.
    const AUTH_URL = 'https://auth.example/validate';
    const RECORD_URL = 'http://collector.test/usage';
    const RUNG_A = 'https://up.example/a';
    const RUNG_B = 'https://up.example/b';
    /** The auth sidecar that hands back the ladder, plus the stats collector. */
    const REMOTE_AUTH = `\n[remote]\nauth_server = ${JSON.stringify(AUTH_URL)}\nrecord_server = ${JSON.stringify(RECORD_URL)}\n`;

    function ladderRequest(): Request {
      return new Request('http://proxy/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'hi' }] }),
      });
    }

    it('releases the spill of a re-hit rung and of a superseded one', async () => {
      const upstreamBody = JSON.stringify({ error: { message: `rung a says no ${'e'.repeat(6000)}` } });
      assert.ok(Buffer.byteLength(upstreamBody, 'utf8') > 4096, 'the fixture has to cross the threshold');
      writeConfig({
        enabled: true,
        extra: `threshold_bytes = 1024\n${REMOTE_AUTH}record_response_body = true\n`,
      });

      const upstreamCalls: string[] = [];
      globalThis.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url === AUTH_URL) {
          return new Response(JSON.stringify({
            version: '1',
            targets: [
              { target: 'rung-a', base: RUNG_A, mode: 'openai-completions', retry_on: [500], retry: 1 },
              { target: 'rung-b', base: RUNG_B, mode: 'openai-completions' },
            ],
          }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (url === RECORD_URL) return new Response('{}', { status: 204 });
        upstreamCalls.push(url);
        if (url.startsWith(RUNG_A)) {
          return new Response(upstreamBody, { status: 500, headers: { 'Content-Type': 'application/json' } });
        }
        return new Response(chatCompletion('rung b ok'), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as typeof fetch;

      const response = await handler.fetch(ladderRequest(), env());
      const clientText = await response.text();

      assert.equal(response.status, 200, 'the ladder falls through to the second rung');
      assert.equal(clientText, chatCompletion('rung b ok'));
      assert.equal(upstreamCalls.filter(url => url.startsWith(RUNG_A)).length, 2,
        'the first rung is re-hit once (axis 2), then superseded (axis 1)');
      assert.deepEqual(responseSpills(), [], 'both abandoned spills were released at their drop point');
      assert.equal(getLiveSpillBytes(), 0, 'and their disk reservations with them');
    });
  });
});

describe('§5.7 spooling of the PII restore read', () => {
  // `restorePrivacyResponse` (index.ts) rebuilt the client-facing body from
  // `response.text()` — the last unbounded whole-body read on a response the
  // proxy builds itself. §5.7: the restore now runs inside the bounded receive,
  // so the body is capped and the spill it was received into is released before
  // the restored text goes out (rule #8 — no partial copy is ever restored).
  // Local `[privacy_filter]` mode mints the `⟦HASH:n⟧` sentinel in-process, so
  // the whole redact → upstream → restore cycle is drivable without a sidecar.
  const SECRET = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const SENTINEL = '⟦HASH:0⟧';
  const FILLER = 'filler '.repeat(256);

  function writeConfig(args: { extra: string }): void {
    writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"

[spool]
enabled = true
dir = ${JSON.stringify(join(tempDir, 'spool'))}
${args.extra}
`, 'utf8');
    clearProxyConfigCache();
    resetBlobStore();
  }

  /** The local filter has no sidecar, so activation is the toml section alone. */
  const LOCAL_FILTER = '[privacy_filter]\nfilter_mode = "local"\n';

  /** File names currently in `<spool>/responses`, or `[]` when the dir is absent. */
  function responseSpills(): string[] {
    const dir = responseSpillDir(getSpoolConfig());
    return existsSync(dir) ? readdirSync(dir).sort() : [];
  }

  /** One OpenAI chat-completions response whose only content is `text`. */
  function chatCompletion(text: string): string {
    return JSON.stringify({
      id: 'chat-json-spill', object: 'chat.completion', created: 1, model: 'test',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
  }

  /** Upstream answers every call with `upstreamBody`, and the sent body is captured. */
  function upstreamEcho(upstreamBody: string): { sent: () => string } {
    let sent = '';
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      sent = await sentBodyText(init);
      return new Response(upstreamBody, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    return { sent: () => sent };
  }

  function messagesRequest(): Request {
    return new Request('http://proxy/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        max_tokens: 32,
        messages: [{ role: 'user', content: `my key is ${SECRET}` }],
      }),
    });
  }

  /** Counts `Response.prototype.clone` while `body` runs. */
  async function countingClones<T>(body: () => Promise<T>): Promise<{ value: T; clones: number }> {
    let clones = 0;
    const originalClone = Response.prototype.clone;
    Response.prototype.clone = function (this: Response) {
      clones += 1;
      return originalClone.call(this);
    } as typeof originalClone;
    try {
      return { value: await body(), clones };
    } finally {
      Response.prototype.clone = originalClone;
    }
  }

  it('restores a sentinel out of the spooled body, never cloning it, and leaves no spill behind', async () => {
    const upstreamBody = chatCompletion(`${SENTINEL} ${FILLER}`);
    assert.ok(Buffer.byteLength(upstreamBody, 'utf8') > 1024, 'the fixture has to cross the threshold');
    writeConfig({ extra: `threshold_bytes = 1024\n${LOCAL_FILTER}` });
    const upstream = upstreamEcho(upstreamBody);

    const { value: response, clones } = await countingClones(() => handler.fetch(messagesRequest(), env()));

    assert.equal(response.status, 200);
    assert.equal(clones, 0, '§5.7: neither consumer may hold a second copy of the body');
    const sentBody = JSON.parse(upstream.sent()) as { messages: Array<{ content: string }> };
    assert.equal(sentBody.messages[0].content, `my key is ${SENTINEL}`, 'the secret itself never leaves the proxy');
    assert.ok(!upstream.sent().includes(SECRET));

    const body = await response.json() as { content: Array<{ type: string; text: string }> };
    assert.deepEqual(body.content, [{ type: 'text', text: `${SECRET} ${FILLER}` }],
      'the restored body carries the original value, not the sentinel');
    assert.deepEqual(responseSpills(), [], 'the restore releases the spill it received the body into');
    assert.equal(getLiveSpillBytes(), 0, 'and puts its disk reservation back');
  });

  it('fails a restore it cannot receive, and leaves nothing reserved', async () => {
    // The restore receives the client-facing body, which the handler's own
    // receive still holds on disk, so a PII-active response past the threshold
    // needs room for a second spill — the measured cost of §5.7's bounded
    // restore. A budget that fits only the first fails here, explicitly, rather
    // than restoring from a body the spool had to truncate. (The converted
    // Claude body is ~50 bytes smaller than the upstream OpenAI body, so
    // `max_response_bytes` cannot cut between the two receives; `max_total_bytes`
    // can.)
    const upstreamBody = chatCompletion(`${SENTINEL} ${FILLER}`);
    const upstreamBytes = Buffer.byteLength(upstreamBody, 'utf8');
    writeConfig({ extra: `threshold_bytes = 512\nmax_total_bytes = ${upstreamBytes + 64}\n${LOCAL_FILTER}` });
    upstreamEcho(upstreamBody);

    const response = await handler.fetch(messagesRequest(), env());

    assert.equal(response.status, 503, 'a body the spool cannot hold is refused, not restored from a partial copy');
    const payload = await response.json() as { type: string; error: { type: string; message: string } };
    assert.equal(payload.type, 'error');
    assert.equal(payload.error.type, 'over_limit_error');
    assert.match(payload.error.message, /live spill budget exceeded/);
    assert.deepEqual(responseSpills(), [], 'the refused receive leaves no spill behind');
    assert.equal(getLiveSpillBytes(), 0, 'and no disk reservation either');
  });
});
