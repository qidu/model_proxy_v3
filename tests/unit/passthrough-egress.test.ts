/**
 * Unit tests for passthrough identity egress (src/handlers/passthrough.ts).
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.3 shape 1.
 * `/passthrough` applies no mutation, so the raw client bytes are authoritative:
 * the upstream must receive those exact bytes (whitespace included — a
 * re-serialization of the parsed body would not) with an exact `Content-Length`,
 * streamed rather than held as a string at the send boundary. Only scalars
 * survive the parse (`model`, `stream_options.include_usage`).
 *
 * Run with: npx tsx --test tests/unit/passthrough-egress.test.ts
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handlePassthroughRequest } from '../../src/handlers/passthrough.js';
import { attachIngressSpool, getLiveSpillBytes, receiveIngressBody, type IngressSpool } from '../../src/utils/spool-ingress.js';
import { EVENT_SPILL_SUBDIR, SPOOL_DEFAULTS, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';
import { getUpstreamRateLimitLeft } from '../../src/utils/provider-quota.js';
import type { Logger } from '../../src/types/shared.js';
import type { ProxyConfig } from '../../src/utils/config-loader.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setSpoolConfig(SPOOL_DEFAULTS);
  // The ledger is process-wide: a leak here would silently weaken later tests.
  assert.equal(getLiveSpillBytes(), 0, 'every spool must return its reservation');
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A prompt body with indentation, so a re-serialization is detectable. */
function promptBody(model: string, content: string): string {
  return JSON.stringify({ model, messages: [{ role: 'user', content }] }, null, 2);
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** What the handler actually handed to `fetch`. */
interface CapturedUpstream {
  headers: Headers;
  bodyKind: 'string' | 'bytes' | 'stream';
  bodyBytes: Uint8Array;
}

/** Materialize whatever body `fetch` was given, keeping its kind. */
async function readBody(body: RequestInit['body']): Promise<{ bodyKind: CapturedUpstream['bodyKind']; bodyBytes: Uint8Array }> {
  if (typeof body === 'string') return { bodyKind: 'string', bodyBytes: new TextEncoder().encode(body) };
  if (body instanceof Uint8Array) return { bodyKind: 'bytes', bodyBytes: body };
  if (body instanceof ReadableStream) {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
    return { bodyKind: 'stream', bodyBytes: concat(chunks) };
  }
  throw new Error(`upstream body is neither string, bytes, nor stream: ${Object.prototype.toString.call(body)}`);
}

/**
 * Stub global fetch, capturing the upstream request and answering with
 * `respond()`. `calls()` proves a rejected request never reached the upstream.
 */
function stubUpstream(respond: () => Response): { get: () => CapturedUpstream; calls: () => number } {
  let captured: CapturedUpstream | undefined;
  let calls = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    captured = { headers: new Headers(init?.headers as HeadersInit), ...(await readBody(init?.body)) };
    return respond();
  }) as typeof fetch;
  return {
    get: () => {
      if (!captured) throw new Error('upstream fetch was never called');
      return captured;
    },
    calls: () => calls,
  };
}

function jsonResponse(body = '{}', headers: Record<string, string> = {}): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });
}

/** Logger that records warnings and trace lines so both can be asserted. */
function recordingLogger(traceEnabled = false): { logger: Logger; warnings: string[]; traces: string[] } {
  const warnings: string[] = [];
  const traces: string[] = [];
  const logger: Logger = {
    traceEnabled,
    trace(_requestId, message) { traces.push(message); },
    debug() {},
    info() {},
    warn(_requestId, message) { warnings.push(message); },
    error() {},
  };
  return { logger, warnings, traces };
}

function passthroughConfig(mode: string): ProxyConfig {
  return { passthrough: { t: { base: 'https://upstream.test', mode } } };
}

const MESSAGES_PATH = '/passthrough/v1/messages';
const CHAT_PATH = '/passthrough/v1/chat/completions';

/** One OpenAI chat-completions chunk carrying `text` as a content delta. */
function sseChunk(text: string): string {
  return `data: ${JSON.stringify({ id: '1', choices: [{ index: 0, delta: { content: text } }] })}\n\n`;
}

/** Relay `raw` as an SSE upstream response through the passthrough egress. */
async function ssePassthrough(raw: string): Promise<Response> {
  stubUpstream(() => new Response(raw, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
  const { logger } = recordingLogger();
  return await callHandler({
    mode: 'openai-completions',
    logger,
    path: CHAT_PATH,
    request: new Request(`http://proxy.test${CHAT_PATH}`, {
      method: 'POST',
      body: promptBody('gpt-test', 'hi'),
    }),
  });
}

async function callHandler(opts: {
  request: Request;
  mode: string;
  logger: Logger;
  path?: string;
}): Promise<Response> {
  const path = opts.path ?? MESSAGES_PATH;
  return await handlePassthroughRequest(
    opts.request,
    path,
    passthroughConfig(opts.mode),
    {},
    opts.logger,
    'req-egress',
    {},
    'caller',
    undefined,
    {},
  );
}

// ---------------------------------------------------------------------------
// Spill fixture (§5.1 raw-body ref, as src/index.ts builds it)
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) {
    try {
      chmodSync(dir, 0o700);
    } catch { /* already writable or already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

function configureSpool(overrides: Partial<SpoolConfig> = {}): SpoolConfig {
  const dir = mkdtempSync(join(tmpdir(), 'passthrough-egress-test-'));
  scratchDirs.push(dir);
  const config: SpoolConfig = {
    ...SPOOL_DEFAULTS,
    enabled: true,
    dir,
    thresholdBytes: 64,
    maxRequestBytes: 1 << 20,
    maxTotalBytes: 1 << 22,
    ...overrides,
  };
  setSpoolConfig(config);
  return config;
}

/** File names currently in the config's `events` spill dir, or `[]`. */
function eventSpills(config: SpoolConfig): string[] {
  const dir = join(config.dir, EVENT_SPILL_SUBDIR);
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

/**
 * Receive `bodyText` through the real ingress path and build the request exactly
 * as src/index.ts does (§5.1): streamed body, spool re-attached.
 */
async function spilledRequest(bodyText: string): Promise<{ request: Request; spool: IngressSpool; bytes: Uint8Array }> {
  const bytes = new TextEncoder().encode(bodyText);
  const spool = await receiveIngressBody(new Response(bytes).body, { declaredLength: bytes.byteLength });
  assert.equal(spool.spilled, true, 'the fixture must spill, or the test proves nothing about spilled egress');
  const request = new Request(`http://proxy.test${MESSAGES_PATH}`, { method: 'POST', body: spool.readStream(), duplex: 'half' } as RequestInit);
  attachIngressSpool(request, spool);
  return { request, spool, bytes };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('passthrough identity egress', () => {
  it('sends the client bytes unchanged with an exact byte Content-Length (no raw-body ref)', async () => {
    const bodyText = promptBody('claude-test', '日本語 — ✓');
    const clientBytes = new TextEncoder().encode(bodyText);
    assert.notEqual(clientBytes.byteLength, bodyText.length, 'fixture must have a byte length different from its UTF-16 length');

    const upstream = stubUpstream(() => jsonResponse());
    const { logger } = recordingLogger();
    const res = await callHandler({
      mode: 'anthropic-messages',
      logger,
      request: new Request(`http://proxy.test${MESSAGES_PATH}`, { method: 'POST', body: bodyText }),
    });

    assert.equal(res.status, 200);
    const sent = upstream.get();
    assert.equal(sent.headers.get('content-length'), String(clientBytes.byteLength), 'Content-Length is the byte count, not the string length');
    assert.equal(sha256(sent.bodyBytes), sha256(clientBytes), 'the upstream body is byte-identical to the client body');
    assert.equal(sent.bodyKind, 'bytes');
  });

  it('streams a spilled body from the raw-body ref instead of stringifying it', async () => {
    configureSpool();
    const bodyText = promptBody('claude-test', `${'x'.repeat(400)} 日本語`);
    const { request, spool, bytes } = await spilledRequest(bodyText);

    const upstream = stubUpstream(() => jsonResponse());
    const { logger } = recordingLogger();
    const readSpillStream = spool.readStream.bind(spool);
    let spillStreams = 0;
    spool.readStream = () => {
      spillStreams += 1;
      return readSpillStream();
    };
    try {
      const res = await callHandler({ mode: 'anthropic-messages', logger, request });
      assert.equal(res.status, 200);

      const sent = upstream.get();
      assert.equal(spillStreams, 1, 'identity egress reads the raw spill, not the rebuilt Request body');
      assert.equal(sent.bodyKind, 'stream', 'a spilled body is streamed, not re-serialized into a string');
      assert.equal(sent.headers.get('content-length'), String(bytes.byteLength), 'Content-Length is the spool byte count');
      assert.equal(sent.bodyBytes.byteLength, bytes.byteLength);
      assert.equal(sha256(sent.bodyBytes), sha256(bytes), 'the upstream receives the exact client bytes');
    } finally {
      await spool.release();
    }
  });

  it('keeps the upstream send in bounded spill reads without a second whole-body materialization', async () => {
    configureSpool();
    const bodyText = promptBody('claude-test', 'x'.repeat(140000));
    const { request, spool, bytes } = await spilledRequest(bodyText);
    const originalReadBytes = spool.readBytes.bind(spool);
    let wholeBodyReads = 0;
    spool.readBytes = async () => {
      wholeBodyReads += 1;
      return await originalReadBytes();
    };

    const chunkSizes: number[] = [];
    const chunks: Uint8Array[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      assert.ok(init?.body instanceof ReadableStream, 'identity egress must hand fetch a stream');
      const reader = (init.body as ReadableStream<Uint8Array>).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          chunkSizes.push(value.byteLength);
          chunks.push(value);
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
      }
      return jsonResponse();
    }) as typeof fetch;

    try {
      const { logger } = recordingLogger();
      const res = await callHandler({ mode: 'anthropic-messages', logger, request });

      assert.equal(res.status, 200);
      assert.equal(wholeBodyReads, 1, 'only the schema gate materializes the body; the delayed upstream send does not');
      assert.ok(chunkSizes.length >= 3, 'the delayed reader must cross multiple spill chunks');
      assert.ok(chunkSizes.every((size) => size <= 64 * 1024), `unbounded spill read: ${chunkSizes}`);
      assert.equal(sha256(concat(chunks)), sha256(bytes), 'slow delivery preserves every client byte');
    } finally {
      await spool.release();
    }
  });

  it('still traces the full raw body of a spilled request when trace logging is on', async () => {
    configureSpool();
    const tail = 'TAIL-MARKER-46f2';
    const bodyText = promptBody('claude-test', `${'y'.repeat(400)} ${tail}`);
    assert.ok(bodyText.length > 300, 'the fixture must exceed the 300-char preview, or a truncating log would pass');
    const { request, spool } = await spilledRequest(bodyText);

    const upstream = stubUpstream(() => jsonResponse());
    const { logger, traces } = recordingLogger(true);

    try {
      await callHandler({ mode: 'anthropic-messages', logger, request });

      assert.equal(upstream.calls(), 1);
      const bodyTrace = traces.find((line) => line.includes(bodyText));
      assert.ok(bodyTrace, `no trace line carries the raw body; got: ${traces.join(' | ')}`);
      assert.ok(bodyTrace.includes('https://upstream.test/v1/messages'), 'the raw body belongs to the upstream-request stage');
      assert.ok(bodyTrace.includes(tail), 'the trace must not be truncated to the preview');
    } finally {
      await spool.release();
    }
  });

  it('rejects invalid JSON without calling the upstream', async () => {
    const upstream = stubUpstream(() => jsonResponse());
    const { logger, warnings } = recordingLogger();

    const res = await callHandler({
      mode: 'anthropic-messages',
      logger,
      request: new Request(`http://proxy.test${MESSAGES_PATH}`, { method: 'POST', body: '{"model": "m", ' }),
    });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Invalid JSON body' });
    assert.equal(upstream.calls(), 0, 'a rejected body must not reach the upstream');
    assert.ok(warnings.some((line) => line.includes('invalid JSON body')));
  });

  it('rejects a body that fails the mode schema gate without calling the upstream', async () => {
    const upstream = stubUpstream(() => jsonResponse());
    const { logger } = recordingLogger();

    const res = await callHandler({
      mode: 'anthropic-messages',
      logger,
      request: new Request(`http://proxy.test${MESSAGES_PATH}`, {
        method: 'POST',
        body: JSON.stringify({ model: 'claude-test' }),
      }),
    });

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Request body does not match schema for anthropic-messages' });
    assert.equal(upstream.calls(), 0);
  });

  it('records the rate-limit entry under the parsed model name', async () => {
    const model = 'claude-egress-rate-limit-test';
    assert.equal(getUpstreamRateLimitLeft(model), null, 'precondition: no recorded rate limit yet');

    stubUpstream(() => jsonResponse('{}', { 'anthropic-ratelimit-unified-5h-utilization': '0.37' }));
    const { logger } = recordingLogger();

    const res = await callHandler({
      mode: 'anthropic-messages',
      logger,
      request: new Request(`http://proxy.test${MESSAGES_PATH}`, { method: 'POST', body: promptBody(model, 'hi') }),
    });

    assert.equal(res.status, 200);
    assert.equal(getUpstreamRateLimitLeft(model), '63%');
    assert.equal(getUpstreamRateLimitLeft('unknown'), null, 'the model scalar, not the fallback key, was used');
  });

  it('keeps the stream_options.include_usage warning driven by the parsed scalar', async () => {
    const sse = new Response(
      'data: {"id":"1","choices":[{"index":0,"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
    stubUpstream(() => sse);
    const warned = recordingLogger();
    const quiet = recordingLogger();

    const withoutFlag = await callHandler({
      mode: 'openai-completions',
      logger: warned.logger,
      path: '/passthrough/v1/chat/completions',
      request: new Request('http://proxy.test/passthrough/v1/chat/completions', {
        method: 'POST',
        body: promptBody('gpt-test', 'hi'),
      }),
    });
    await withoutFlag.text();

    const withFlag = await callHandler({
      mode: 'openai-completions',
      logger: quiet.logger,
      path: '/passthrough/v1/chat/completions',
      request: new Request('http://proxy.test/passthrough/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], stream_options: { include_usage: true } }),
      }),
    });
    await withFlag.text();

    assert.ok(
      warned.warnings.some((line) => line.includes('stream_options.include_usage')),
      `an openai-completions stream without include_usage must warn; got: ${warned.warnings.join(' | ')}`,
    );
    assert.deepEqual(
      quiet.warnings.filter((line) => line.includes('stream_options.include_usage')),
      [],
      'a request that asks for include_usage must not warn',
    );
  });

  it('frames the SSE relay without changing a byte, and only while the spool is on (§5.7)', async () => {
    const raw = sseChunk('alpha') + sseChunk('beta') + 'data: [DONE]\n\n';

    // §9.1: with spooling off there is no framing at all — the relay is the
    // upstream bytes as they arrive.
    setSpoolConfig(SPOOL_DEFAULTS);
    const off = await ssePassthrough(raw);
    assert.equal(off.status, 200);
    const offBody = await off.text();

    const config = configureSpool({ thresholdBytes: 4096, maxResponseBytes: 1 << 20 });
    const on = await ssePassthrough(raw);
    assert.equal(on.status, 200);
    const onBody = await on.text();

    assert.equal(onBody, raw, 'the framed relay forwards the upstream bytes exactly');
    assert.equal(onBody, offBody, 'framing is a relay: the client sees the same bytes either way');
    assert.deepEqual(eventSpills(config), [], 'events below threshold_bytes never spill');
  });

  it('caps one event at max_response_bytes on the SSE relay instead of forwarding it unbounded (§5.7)', async () => {
    const big = 'z'.repeat(32 * 1024);
    // The default 64-byte threshold makes this event spill before it breaches the
    // cap, so the breach path is exercised with a spill file open.
    const config = configureSpool({ maxResponseBytes: 8192 });

    const res = await ssePassthrough(sseChunk(big) + 'data: [DONE]\n\n');

    assert.equal(res.status, 200, 'the breach is mid-stream: the response has already begun');
    await assert.rejects(res.text(), /SSE event body too large/);
    assert.deepEqual(eventSpills(config), [], 'the aborted event leaves no spill behind');
  });
});
