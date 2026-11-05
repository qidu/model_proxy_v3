/**
 * Unit tests for the §5.7 non-SSE response path in `src/handlers/gemini.ts`'s
 * two remaining readers: the `/v1/messages` (claude-format) branch of
 * `handleGeminiNonStreamingResponse`, which converts a native `generateContent`
 * response into a Claude message, and `handleGeminiCountTokensRequest`, which
 * forwards the `:countTokens` body unchanged.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.7, §5.9.
 *
 * The converted branch is the gap increment 43 reported: it was
 * `await response.text()` with no `max_response_bytes`. It is the *converted*
 * shape, so the body is parsed here — the tests pin the conversion the client
 * gets, that the spill is gone by the time the client reads (what it reads is
 * the converted body, never the upstream bytes), and that a spool failure keeps
 * its own status and type instead of being relabelled as a conversion error by
 * the branch's existing `catch`.
 *
 * No payload extraction is tested as a *property* rather than an absence: the
 * fixture carries an `inlineData` image part, and the assertions require it to
 * be dropped by `convertGeminiGenerateContentToClaude` (text parts only) — which
 * is why there is nothing for §5.7's response allowlist to extract on this
 * branch.
 *
 * The `:countTokens` branch is the identity shape: a `{ totalTokens }` object
 * with nothing allowlisted in it, forwarded byte-for-byte from its spool.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleGeminiRequest, handleGeminiRequestForMessages } from '../../src/handlers/gemini.js';
import { SpoolResponseTooLargeError } from '../../src/utils/spool-response.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { SPOOL_DEFAULTS, responseSpillDir, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';
import { AdmissionOverBudgetError, getAdmittedBytes } from '../../src/utils/spool-admission.js';
import type { Logger } from '../../src/types/shared.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setSpoolConfig(SPOOL_DEFAULTS);
  // The ledger is process-wide: a leak here would silently weaken later tests.
  assert.equal(getLiveSpillBytes(), 0, 'every spool must return its reservation');
  assert.equal(getAdmittedBytes(), 0, 'every §5.9 lease must be released');
});

// ---------------------------------------------------------------------------
// Fixtures
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

const ENV = { LOG_LEVEL: 'error' } as any;
const CLIENT_URL = 'http://proxy';
const GENERATE_CONTENT_URL = 'https://upstream.example/v1beta/models/gemini-test:generateContent';
const COUNT_TOKENS_URL = 'https://upstream.example/v1beta/models/gemini-test:countTokens';

/** A 1×1 PNG — an `inlineData` payload the converter is expected to drop. */
const IMAGE_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+7lPWAAAAAElFTkSuQmCC';

/** Spool enabled with a small threshold, so a few hundred bytes spill. */
function configureSpool(overrides: Partial<SpoolConfig> = {}): SpoolConfig {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-converted-test-'));
  scratchDirs.push(dir);
  const config: SpoolConfig = {
    ...SPOOL_DEFAULTS,
    enabled: true,
    dir,
    thresholdBytes: 64,
    maxResponseBytes: 1 << 20,
    maxTotalBytes: 1 << 22,
    ...overrides,
  };
  setSpoolConfig(config);
  return config;
}

/**
 * A native `generateContent` response: a text part (indented, non-ASCII, so a
 * re-encode would show) and an `inlineData` image part.
 */
function geminiPayload(filler = 'ok'): string {
  return JSON.stringify(
    {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [
              { text: `日本語 — ✓ ${filler}` },
              { inlineData: { mimeType: 'image/png', data: IMAGE_B64 } },
            ],
          },
          finishReason: 'STOP',
        },
      ],
      usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 259, totalTokenCount: 263 },
    },
    null,
    2,
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Names of the response spill files currently on disk. */
function spillFiles(config: SpoolConfig): string[] {
  return existsSync(responseSpillDir(config)) ? readdirSync(responseSpillDir(config)) : [];
}

/** Stub global fetch, counting calls and answering with `respond()`. */
function stubUpstream(respond: () => Response): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    // A real fetch consumes the request body, and the request-side spool releases
    // its file only once the send has drained it (increment 39's send-boundary
    // lease release).
    const body = init?.body;
    if (body instanceof ReadableStream) {
      const reader = body.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
    return respond();
  }) as typeof fetch;
  return { calls: () => calls };
}

interface Sourced {
  stream: ReadableStream<Uint8Array>;
  cancelled: boolean;
}

/** An upstream body we can watch being cancelled when the proxy gives up on it. */
function source(chunks: Uint8Array[]): Sourced {
  let index = 0;
  const state: Sourced = { cancelled: false, stream: null as unknown as ReadableStream<Uint8Array> };
  state.stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index++]);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return state;
}

function recordingLogger(traceEnabled: boolean): Logger & { traces: string[] } {
  const traces: string[] = [];
  return {
    traceEnabled,
    traces,
    trace(_requestId: string, message: string) { traces.push(message); },
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

/** Send a `/v1/messages` request answered by a native `:generateContent` upstream. */
async function callConverted(logger: Logger = recordingLogger(false)): Promise<Response> {
  return await handleGeminiRequestForMessages(
    new Request(`${CLIENT_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gemini-test',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }),
    GENERATE_CONTENT_URL,
    { 'x-goog-api-key': 'upstream-key' },
    'req-gemini-converted',
    'gemini-test',
    ENV,
    logger,
  );
}

/** Send a `:countTokens` request, which the handler forwards unchanged. */
async function callCountTokens(logger: Logger = recordingLogger(false)): Promise<Response> {
  return await handleGeminiRequest(
    new Request(`${CLIENT_URL}/v1beta/models/gemini-test:countTokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    }),
    COUNT_TOKENS_URL,
    { 'x-goog-api-key': 'upstream-key' },
    'req-gemini-count-tokens',
    'gemini-test',
    ENV,
    logger,
  );
}

/**
 * A converted Claude body with its clock-derived `id` masked.
 *
 * `convertGeminiGenerateContentToClaude` mints the id from `Date.now()` and the
 * request id's tail, so two identical runs differ there. Everything else must
 * match exactly — that is the property under test.
 */
function stableConverted(body: unknown): Record<string, unknown> {
  const parsed = body as Record<string, unknown>;
  return { ...parsed, id: undefined };
}

/**
 * Count `Response.prototype.clone()` calls while `run` executes: §5.7's whole
 * point on these branches is that a body nobody has to hold twice never gets a
 * second copy of itself in RAM.
 */
async function countClones<T>(run: () => Promise<T>): Promise<{ result: T; clones: number }> {
  const original = Response.prototype.clone;
  let clones = 0;
  Response.prototype.clone = function clone(this: Response) {
    clones += 1;
    return original.call(this);
  };
  try {
    return { result: await run(), clones };
  } finally {
    Response.prototype.clone = original;
  }
}

// ---------------------------------------------------------------------------
// §5.7: the converted (claude-format) non-SSE egress
// ---------------------------------------------------------------------------

describe('gemini.ts /v1/messages via :generateContent, converted non-SSE response (§5.7)', () => {
  it('converts a small response without touching the spool, dropping the inlineData part', async () => {
    const config = configureSpool({ thresholdBytes: 4096 });
    const payload = geminiPayload();
    assert.ok(new TextEncoder().encode(payload).byteLength < config.thresholdBytes, 'the fixture must stay under the threshold');
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const { result: response, clones } = await countClones(() => callConverted());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('x-request-id'), 'req-gemini-converted');
    const text = await response.text();
    assert.deepEqual(stableConverted(JSON.parse(text)), {
      id: undefined,
      type: 'message',
      role: 'assistant',
      model: 'gemini-test',
      content: [{ type: 'text', text: '日本語 — ✓ ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 4, output_tokens: 259 },
    });
    // The image the upstream generated never reaches the client: the converter
    // collects text parts only, which is exactly why this branch has nothing on
    // §5.7's response allowlist to extract.
    assert.ok(!text.includes(IMAGE_B64), 'the converter drops inlineData parts before the client sees them');
    assert.deepEqual(spillFiles(config), [], 'a body under the threshold leaves no spill');
    assert.equal(clones, 0, 'the proxy must not hold a second copy of the body');
  });

  it('spills above threshold_bytes, then releases the spill once the body has been converted', async () => {
    const config = configureSpool();
    const payload = geminiPayload('x'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    assert.ok(upstreamBytes.byteLength > config.thresholdBytes, 'the fixture must cross the threshold');
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const { result: response, clones } = await countClones(() => callConverted());

    // The converted body is built from the parse, so the upstream bytes are gone
    // by the time the caller has a response to read: what was on disk was the
    // receive, not the client's copy.
    assert.equal(response.status, 200);
    assert.deepEqual(spillFiles(config), [], 'the upstream spill ends with the parse, not with the client read');
    assert.equal(getLiveSpillBytes(), 0, 'nor may it be charged after the parse');

    const body = JSON.parse(await response.text());
    assert.equal(body.content[0].text, `日本語 — ✓ ${'x'.repeat(400)}`);
    assert.ok(!JSON.stringify(body).includes(IMAGE_B64));
    assert.equal(clones, 0);
  });

  it('fails loudly past max_response_bytes, keeping the spool error type rather than relabelling it', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const encoder = new TextEncoder();
    // Two chunks: the first crosses `threshold_bytes`, so a spill really exists
    // and then has to be cleaned up when the second breaches the cap.
    const src = source([
      encoder.encode(geminiPayload('z'.repeat(200))),
      encoder.encode(geminiPayload('z'.repeat(200))),
    ]);
    const { calls } = stubUpstream(() => new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await callConverted();
    } catch (error) {
      caught = error;
    }

    // The branch's own `catch` annotates conversion failures. A spool failure is
    // not a conversion failure: it has a status and a type the client switches
    // on, and the branch must not replace them with a generic `Error` (rule #8).
    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.status, 500, 'the client sent a legal request: not a 4xx');
    assert.equal(caught.type, 'processing_error');
    assert.match(caught.message, /too large/);
    assert.ok(!caught.message.startsWith('Failed to convert'), `the spool error must not be relabelled: ${caught.message}`);
    assert.equal(calls(), 1);
    assert.equal(src.cancelled, true, 'the upstream body must be cancelled, not left flowing');
    assert.deepEqual(spillFiles(config), [], 'a rejected response leaves no partial spill');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('enforces max_response_bytes with the spool disabled, like the other converted receive', async () => {
    const config = configureSpool({ enabled: false, maxResponseBytes: 256 });
    const payload = geminiPayload('c'.repeat(400));
    assert.ok(new TextEncoder().encode(payload).byteLength > config.maxResponseBytes);
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await callConverted();
    } catch (error) {
      caught = error;
    }

    // The receive replaced the whole-body read outright, so the cap is a memory
    // bound on that read and not part of the spilling feature — the rule the
    // native branch beside it, the passthrough egress and the Responses egress
    // already follow.
    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.type, 'processing_error');
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('still traces the raw upstream body, read from the same spill', async () => {
    const config = configureSpool();
    const payload = geminiPayload('t'.repeat(400));
    const logger = recordingLogger(true);
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callConverted(logger);

    const upstreamLine = logger.traces.find((line) => line.startsWith('[UPSTREAM-RESP] '));
    assert.ok(upstreamLine, `expected the upstream body line, got ${JSON.stringify(logger.traces)}`);
    assert.equal(upstreamLine.slice(upstreamLine.indexOf(': ') + 2), payload, 'the traced body must be the upstream bytes');
    const outboundLine = logger.traces.find((line) => line.startsWith('[OUT] '));
    assert.ok(outboundLine, 'the converted body must still be traced');
    assert.equal(JSON.parse(await response.text()).type, 'message');
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });
});

// ---------------------------------------------------------------------------
// §5.9: byte admission on the converted read
// ---------------------------------------------------------------------------

describe('gemini.ts /v1/messages via :generateContent, byte admission (§5.9)', () => {
  it('refuses a conversion one nominal byte past the budget, leaving no spill and no reservation', async () => {
    const payload = geminiPayload('b'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    const charge = Math.ceil(upstreamBytes.byteLength * 2);
    const config = configureSpool({ maxMaterializedBodyBytes: charge - 1 });
    assert.ok(upstreamBytes.byteLength > config.thresholdBytes, 'the fixture must spill, so a leak would be visible on disk');
    const { calls } = stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await callConverted();
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof AdmissionOverBudgetError, `expected AdmissionOverBudgetError, got ${String(caught)}`);
    assert.equal(caught.status, 503);
    assert.equal(caught.type, 'over_limit_error', 'the type the client switches on');
    assert.match(caught.message, /exceed max_materialized_body_bytes/);
    assert.equal(calls(), 1, 'a response is judged on what it received, so the body was received first');
    assert.deepEqual(spillFiles(config), [], 'a refused response must not leave its bytes on disk');
    assert.equal(getLiveSpillBytes(), 0, 'nor hold them against max_total_bytes');
    assert.equal(getAdmittedBytes(), 0);
  });

  it('admits a conversion the budget can cover, and gives the lease back before the client reads', async () => {
    const payload = geminiPayload('a'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    const charge = Math.ceil(upstreamBytes.byteLength * 2);
    configureSpool({ maxMaterializedBodyBytes: charge });
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callConverted();

    assert.equal(getAdmittedBytes(), 0, 'the parse is over before the response is handed out');
    const body = JSON.parse(await response.text());
    assert.equal(body.content[0].text, `日本語 — ✓ ${'a'.repeat(400)}`);
  });
});

// ---------------------------------------------------------------------------
// §5.7: the :countTokens identity egress
// ---------------------------------------------------------------------------

describe('gemini.ts :countTokens non-SSE response (§5.7)', () => {
  it('spills above threshold_bytes and forwards the upstream bytes unchanged', async () => {
    // A tiny threshold, because a `{ totalTokens }` body is small by nature: the
    // point is the receive path, not the size of this particular body.
    const config = configureSpool({ thresholdBytes: 8 });
    const payload = JSON.stringify({ totalTokens: 42 });
    const upstreamBytes = new TextEncoder().encode(payload);
    assert.ok(upstreamBytes.byteLength > config.thresholdBytes, 'the fixture must cross the threshold');
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const { result: response, clones } = await countClones(() => callCountTokens());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('x-request-id'), 'req-gemini-count-tokens');
    assert.equal(spillFiles(config).length, 1, 'the received body lives on disk while the response is in flight');
    assert.equal(getLiveSpillBytes(), upstreamBytes.byteLength);

    const forwarded = new Uint8Array(await response.arrayBuffer());

    assert.equal(sha256(forwarded), sha256(upstreamBytes), 'the countTokens body must be relayed unparsed');
    assert.equal(JSON.parse(new TextDecoder().decode(forwarded)).totalTokens, 42);
    assert.deepEqual(spillFiles(config), [], 'the client reading the body must free the spill');
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(clones, 0, 'the proxy must not hold a second copy of the body');
  });

  it('fails loudly past max_response_bytes and cancels the upstream body', async () => {
    const config = configureSpool({ maxResponseBytes: 16 });
    const encoder = new TextEncoder();
    const src = source([encoder.encode('{"totalTokens":'), encoder.encode('123456789012345}')]);
    const { calls } = stubUpstream(() => new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await callCountTokens();
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.status, 500, 'the client sent a legal request: not a 4xx');
    assert.equal(caught.type, 'processing_error');
    assert.equal(calls(), 1);
    assert.equal(src.cancelled, true);
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('with the spool disabled still forwards the body and writes nothing', async () => {
    const config = configureSpool({ enabled: false, thresholdBytes: 8 });
    const payload = JSON.stringify({ totalTokens: 42 });
    const upstreamBytes = new TextEncoder().encode(payload);
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callCountTokens();

    const forwarded = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha256(forwarded), sha256(upstreamBytes), '`enabled` decides where the bytes live, not what they are');
    assert.deepEqual(spillFiles(config), [], 'nothing may reach disk when spilling is off');
    assert.equal(getLiveSpillBytes(), 0);
  });
});
