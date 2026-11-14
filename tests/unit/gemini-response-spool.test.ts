/**
 * Unit tests for the §5.7 non-SSE response path in `src/handlers/gemini.ts`'s
 * native `:generateContent` branch (`relayNativeGeminiResponse`).
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.7, §5.9.
 *
 * This is the path §5.7's response allowlist names for native Gemini
 * passthrough: `inlineData` image/audio parts the model generated are the bytes
 * the proxy must not hold twice. The branch never parses, so the tests pin the
 * identity of the forwarded body (non-ASCII text and an `inlineData` part, so
 * a re-serialize or a re-encode would change the bytes), the spill's life —
 * charged while the response is in flight, gone once the client has read it or
 * aborted — and that no `Response.clone()` holds a second copy.
 *
 * The receive is not gated on `[spool] enabled`, matching the Interactions
 * branch of the same file and the other identity egresses, so `max_response_bytes`
 * is enforced with spilling off too: the last two cases in the first block pin
 * that, both the cap that now applies and the `enabled = false` forwarding that
 * still writes nothing to disk. The §5.9 block pins that the budget is taken
 * around the **trace** read, which is the only read this branch does: with
 * tracing off there is nothing to admit, so a budget one byte short of the
 * charge must still serve the response.
 *
 * The SSE half of this egress is covered by index-stream-events.test.ts; the
 * converted (`claude-format`) half never carries an `inlineData` part, because
 * `convertGeminiGenerateContentToClaude` drops those parts — see the report on
 * increment 43.
 *
 * The same file reads an upstream *error* body whole on three further paths —
 * the `!response.ok` branch of `:countTokens`, of the Interactions handler and of
 * the native `:generateContent` handler. Those now share `withResponseText` with
 * the success bodies above, so the last block here pins the same three
 * properties on each of them: the body spills while it is received, the upstream
 * error still reaches the client verbatim, and a cap breach or a §5.9 refusal
 * surfaces as itself instead. The only local catch is the
 * `handleGeminiGenerateContentRequest` one, which logs and re-throws.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleGeminiRequest } from '../../src/handlers/gemini.js';
import { SpoolResponseTooLargeError } from '../../src/utils/spool-response.js';
import { UpstreamApiError } from '../../src/utils/errors.js';
import { RESPONSE_BLOB_SCOPE } from '../../src/utils/response-blobs.js';
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
const UPSTREAM_URL = 'https://upstream.example/v1beta/models/gemini-test:generateContent';

/** A 1×1 PNG, the smallest real inline-data payload that is still an image. */
const IMAGE_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+7lPWAAAAAElFTkSuQmCC';

/** Spool enabled with a small threshold, so a few hundred bytes spill. */
function configureSpool(overrides: Partial<SpoolConfig> = {}): SpoolConfig {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-response-test-'));
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
 * A native `generateContent` response with an indented, non-ASCII text part and
 * an `inlineData` image part — the §5.7 response-allowlist payload. Round-tripping
 * it through JSON.parse/stringify or a UTF-8 re-encode would change the bytes,
 * so byte equality against this fixture is meaningful.
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
  globalThis.fetch = (async () => {
    calls += 1;
    return respond();
  }) as typeof fetch;
  return { calls: () => calls };
}

interface Sourced {
  stream: ReadableStream<Uint8Array>;
  cancelled: boolean;
}

/** An upstream body we can watch being cancelled when the proxy gives up on it. */
function source(chunks: Uint8Array[], onPull?: (index: number) => void): Sourced {
  let index = 0;
  const state: Sourced = { cancelled: false, stream: null as unknown as ReadableStream<Uint8Array> };
  state.stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        onPull?.(index);
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

/** Send a native `:generateContent` request and return the client response. */
async function callHandler(logger: Logger = recordingLogger(false)): Promise<Response> {
  return await handleGeminiRequest(
    new Request(`${CLIENT_URL}/v1beta/models/gemini-test:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    }),
    UPSTREAM_URL,
    { 'x-goog-api-key': 'upstream-key' },
    'req-gemini-response',
    'gemini-test',
    ENV,
    logger,
  );
}

/** The `inlineData` part of the forwarded body, for the "did it survive" check. */
function inlineDataPart(json: string): { mimeType: string; data: string } {
  return JSON.parse(json).candidates[0].content.parts[1].inlineData;
}

/**
 * Count `Response.prototype.clone()` calls while `run` executes: §5.7's whole
 * point on this branch is that a body nobody has to parse never gets a second
 * copy of itself in RAM.
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
// §5.7: receive, spill, forward
// ---------------------------------------------------------------------------

describe('gemini.ts native :generateContent non-SSE response (§5.7)', () => {
  it('forwards a small response byte-identically without touching the spool', async () => {
    const config = configureSpool({ thresholdBytes: 4096 });
    const payload = geminiPayload();
    const upstreamBytes = new TextEncoder().encode(payload);
    assert.ok(upstreamBytes.byteLength < config.thresholdBytes, 'the fixture must stay under the threshold');
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const { result: response, clones } = await countClones(() => callHandler());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('x-request-id'), 'req-gemini-response');
    const forwarded = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha256(forwarded), sha256(upstreamBytes));
    assert.equal(inlineDataPart(new TextDecoder().decode(forwarded)).data, IMAGE_B64, 'the model image must survive');
    assert.deepEqual(spillFiles(config), [], 'a body under the threshold leaves no spill');
    assert.equal(clones, 0, 'the proxy must not hold a second copy of the body');
  });

  it('spills above threshold_bytes and sends the body from the spill, which ends with the response', async () => {
    const config = configureSpool();
    const payload = geminiPayload('x'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    assert.ok(upstreamBytes.byteLength > config.thresholdBytes, 'the fixture must cross the threshold');
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const { result: response, clones } = await countClones(() => callHandler());

    // The spill is the live body while the response is being sent, so it is
    // charged to the ledger until the client has taken every byte.
    assert.equal(response.status, 200);
    assert.equal(spillFiles(config).length, 1);
    assert.equal(getLiveSpillBytes(), upstreamBytes.byteLength);

    const forwarded = new Uint8Array(await response.arrayBuffer());

    assert.equal(sha256(forwarded), sha256(upstreamBytes));
    assert.equal(inlineDataPart(new TextDecoder().decode(forwarded)).data, IMAGE_B64, 'the model image must survive');
    assert.deepEqual(spillFiles(config), [], 'the client reading the body must free the spill');
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(clones, 0, 'an inline-data response is exactly what must not be duplicated in RAM');
  });

  it('fails loudly past max_response_bytes instead of truncating, and cancels the upstream body', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const encoder = new TextEncoder();
    // Two chunks: the first crosses `threshold_bytes`, so a spill really is
    // created and then has to be cleaned up when the second breaches the cap.
    const src = source([
      encoder.encode(geminiPayload('z'.repeat(200))),
      encoder.encode(geminiPayload('z'.repeat(200))),
    ]);
    const { calls } = stubUpstream(() => new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await callHandler();
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.status, 500, 'the client sent a legal request: not a 4xx');
    assert.equal(caught.type, 'processing_error');
    assert.match(caught.message, /too large/);
    assert.equal(calls(), 1);
    assert.equal(src.cancelled, true, 'the upstream body must be cancelled, not left flowing');
    assert.deepEqual(spillFiles(config), [], 'a rejected response leaves no partial spill');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('releases the spill when the client aborts mid-body', async () => {
    const config = configureSpool();
    const payload = geminiPayload('w'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callHandler();

    assert.equal(spillFiles(config).length, 1);
    assert.equal(getLiveSpillBytes(), upstreamBytes.byteLength);

    // What the Node adapter does when the client disconnects: cancel the body.
    await response.body?.cancel();

    assert.deepEqual(spillFiles(config), [], 'an aborted response must not leave the body on disk');
    assert.equal(getLiveSpillBytes(), 0, 'nor hold its bytes against max_total_bytes');
  });

  it('with the spool disabled still forwards the body byte-identically and writes nothing', async () => {
    const config = configureSpool({ enabled: false });
    const payload = geminiPayload('d'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    assert.ok(upstreamBytes.byteLength > config.thresholdBytes);
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callHandler();

    assert.equal(response.status, 200);
    const forwarded = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha256(forwarded), sha256(upstreamBytes), '`enabled` decides where the bytes live, not what they are');
    assert.equal(inlineDataPart(new TextDecoder().decode(forwarded)).data, IMAGE_B64);
    assert.deepEqual(spillFiles(config), [], 'nothing may reach disk when spilling is off');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('enforces max_response_bytes with the spool disabled, like the other identity egresses', async () => {
    const config = configureSpool({ enabled: false, maxResponseBytes: 256 });
    const payload = geminiPayload('c'.repeat(400));
    assert.ok(new TextEncoder().encode(payload).byteLength > config.maxResponseBytes);
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await callHandler();
    } catch (error) {
      caught = error;
    }

    // Deliberate, and the same rule the Interactions branch of this file, the
    // passthrough egress and the Responses egress already follow: the receive
    // replaced the whole-body read outright, so the cap is a memory bound on
    // that read and not part of the spilling feature. Serving this body would
    // mean holding it twice in RAM — the cost the cap exists to refuse.
    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.status, 500);
    assert.equal(caught.type, 'processing_error');
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('sends the trace body from the spill without changing what the client receives', async () => {
    const config = configureSpool();
    const payload = geminiPayload('t'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    const logger = recordingLogger(true);
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callHandler(logger);

    // Both trace stages must still see the raw upstream body, exactly as when it
    // was read whole: tracing is what the read is for.
    const stages = logger.traces.filter((line) => line.startsWith('[UPSTREAM-RESP] ') || line.startsWith('[OUT] '));
    assert.equal(stages.length, 2, `expected the two body lines, got ${JSON.stringify(logger.traces)}`);
    assert.equal(stages[0].slice(stages[0].indexOf(': ') + 2), payload, 'the traced body must be the upstream bytes');
    assert.equal(stages[1].slice(stages[1].indexOf(': ') + 2), payload);

    const forwarded = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha256(forwarded), sha256(upstreamBytes), 'reading the spill for the trace must not alter the body');
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });
});

// ---------------------------------------------------------------------------
// §5.9: byte admission on the trace read
// ---------------------------------------------------------------------------

/**
 * §5.9 byte admission on this path (`max_materialized_body_bytes`, off by
 * default). This branch materializes only to trace-log the body, so the budget
 * is taken around that read and nowhere else: the pair below is what says the
 * read — and therefore the hold — is the trace's, not a cost every response pays.
 */
describe('gemini.ts native :generateContent non-SSE response, byte admission (§5.9)', () => {
  it('does not charge a response whose body is never read', async () => {
    const payload = geminiPayload('n'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    const charge = Math.ceil(upstreamBytes.byteLength * 2);
    const config = configureSpool({ maxMaterializedBodyBytes: charge - 1 });
    assert.ok(upstreamBytes.byteLength > config.thresholdBytes, 'the fixture must spill, so a leak would be visible on disk');
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    // Tracing off: no read, so a budget that could not admit this body is not
    // consulted at all. A version that admitted the received body unconditionally
    // would refuse here with a 503 the client never asked for.
    const response = await callHandler(recordingLogger(false));

    assert.equal(response.status, 200);
    const forwarded = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha256(forwarded), sha256(upstreamBytes));
    assert.equal(getAdmittedBytes(), 0);
    assert.deepEqual(spillFiles(config), []);
  });

  it('refuses a trace read one nominal byte past the budget, leaving no spill and no reservation', async () => {
    const payload = geminiPayload('b'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    const charge = Math.ceil(upstreamBytes.byteLength * 2);
    const config = configureSpool({ maxMaterializedBodyBytes: charge - 1 });
    assert.ok(upstreamBytes.byteLength > config.thresholdBytes, 'the fixture must spill, so a leak here would be visible on disk');
    const { calls } = stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await callHandler(recordingLogger(true));
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
});


// ---------------------------------------------------------------------------
// §5.7: the Interactions converted egress — the one handler that extracts
// ---------------------------------------------------------------------------

describe('gemini.ts /v1/interactions non-SSE converted response (§5.7)', () => {
  /** Names of the scratch blobs the converted body wrote. */
  function scratchFiles(config: SpoolConfig): string[] {
    const dir = join(config.dir, RESPONSE_BLOB_SCOPE.subdir);
    return existsSync(dir) ? readdirSync(dir) : [];
  }

  /** A `/v1/interactions` request, as the router hands it to this handler. */
  async function callInteractions(logger: Logger = recordingLogger(false)): Promise<Response> {
    return await handleGeminiRequest(
      new Request(`${CLIENT_URL}/v1/interactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gemini-test', input: 'hi' }),
      }),
      UPSTREAM_URL,
      { 'x-goog-api-key': 'upstream-key' },
      'req-interactions-response',
      'gemini-test',
      ENV,
      logger,
    );
  }

  it('converts, extracts the generated image, and streams it back with an exact Content-Length', async () => {
    const config = configureSpool();
    const upstreamBody = geminiPayload();
    const { calls } = stubUpstream(() => new Response(upstreamBody, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callInteractions();

    assert.equal(response.status, 200);
    assert.equal(calls(), 1);
    // The receive spill is released with the conversion, before the answer is
    // handed over; only the payload's scratch blob is still on disk.
    assert.deepEqual(
      spillFiles(config).filter((name) => !name.startsWith(RESPONSE_BLOB_SCOPE.filePrefix)),
      [],
      'the parsed body is done before the client is answered',
    );
    assert.equal(scratchFiles(config).length, 1, 'the generated image lives in this response’s scratch store');

    const declared = Number(response.headers.get('content-length'));
    const forwarded = Buffer.from(await response.arrayBuffer());
    assert.equal(Number.isFinite(declared), true, 'a streamed skeleton must declare its exact length');
    assert.equal(declared, forwarded.byteLength, 'the declared length is the exact byte count');

    const text = forwarded.toString('utf8');
    const parsed = JSON.parse(text);
    assert.equal(parsed.object, 'interaction');
    assert.deepEqual(parsed.outputs[0], { type: 'text', text: '日本語 — ✓ ok' }, 'the text part is converted');
    assert.deepEqual(
      parsed.outputs[1],
      // The Interactions `Content` the client asked in, not the upstream's own
      // `{inlineData:{…}}` dialect: `type` is required by that schema, and the
      // response allowlist grew the matching `data` position
      // (`addInteractionsMedia`), which is what keeps this payload extracted.
      { type: 'image', data: IMAGE_B64, mime_type: 'image/png' },
      'the generated image round-trips at its own position',
    );
    assert.ok(text.includes(IMAGE_B64), 'the payload is on the wire, not just a marker');
    assert.equal(text.includes('$spoolBlob'), false, 'the ref itself must never reach a client');

    assert.deepEqual(scratchFiles(config), [], 'the last byte deletes the scratch blob');
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(getAdmittedBytes(), 0);
  });

  it('deletes the scratch blob when the client disconnects mid-body', async () => {
    const config = configureSpool();
    stubUpstream(() => new Response(geminiPayload(), { headers: { 'Content-Type': 'application/json' } }));

    const response = await callInteractions();
    assert.equal(response.status, 200);
    assert.equal(scratchFiles(config).length, 1, 'the payload is still needed: the body has not been read');

    await response.body?.cancel('client gone');

    assert.deepEqual(scratchFiles(config), [], 'an abandoned response deletes its scratch blob');
    assert.equal(getLiveSpillBytes(), 0);
  });
});

// ---------------------------------------------------------------------------
// §5.7: the upstream *error* body
// ---------------------------------------------------------------------------

/**
 * The three `!response.ok` reads in `src/handlers/gemini.ts`: `:130` in
 * `handleGeminiCountTokensRequest`, `:280` in `handleGeminiInteractionsRequest`
 * and `:493` in `handleGeminiGenerateContentRequest`. The last sits under that
 * function's `catch`, which logs and re-throws; the first two are under no catch
 * at all. All three end in `handleTargetApiError` (typed `never`), so a cap
 * breach or a §5.9 refusal reaches the client as itself while the upstream's own
 * error reaches it unchanged.
 */

/** An upstream error body: 429, with a message the client-facing error quotes. */
function errorPayload(marker: string): string {
  return JSON.stringify({ error: { code: 429, message: `upstream said ${marker}`, status: 'RESOURCE_EXHAUSTED' } }, null, 2);
}

function errorResponse(body: ReadableStream<Uint8Array> | string): Response {
  return new Response(body, { status: 429, headers: { 'Content-Type': 'application/json' } });
}

/** Send `path` to the Gemini router with a body of the shape it expects. */
function callGeminiPath(path: string, body: unknown, logger: Logger = recordingLogger(false)): Promise<Response> {
  return handleGeminiRequest(
    new Request(`${CLIENT_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    UPSTREAM_URL,
    { 'x-goog-api-key': 'upstream-key' },
    'req-gemini-error',
    'gemini-test',
    ENV,
    logger,
  );
}

interface ErrorSite {
  name: string;
  post: () => Promise<Response>;
}

const ERROR_SITES: ErrorSite[] = [
  {
    name: ':countTokens',
    post: () => callGeminiPath('/v1beta/models/gemini-test:countTokens', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  },
  {
    name: ':generateContent',
    post: () => callGeminiPath('/v1beta/models/gemini-test:generateContent', { contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  },
  {
    name: '/v1/interactions',
    post: () => callGeminiPath('/v1/interactions', { model: 'gemini-test', input: 'hi' }),
  },
];

/** Run `run`, require that it failed, and hand back the error. */
async function thrownBy(run: () => Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, `expected an Error, got ${String(caught)}`);
  return caught;
}

/** Two chunks at the midpoint of an encoded body. */
function twoChunks(payload: string): Uint8Array[] {
  const bytes = new TextEncoder().encode(payload);
  const half = Math.floor(bytes.byteLength / 2);
  return [bytes.subarray(0, half), bytes.subarray(half)];
}

/** Fixed-size slices of an encoded body, for the cap case below. */
function slices(payload: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(payload);
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    out.push(bytes.subarray(offset, offset + size));
  }
  return out;
}

for (const site of ERROR_SITES) {
  describe(`gemini.ts ${site.name} upstream error body (§5.7)`, () => {
    it('receives the error body through the spill and carries it verbatim', async () => {
      const payload = errorPayload('x'.repeat(400));
      const chunks = twoChunks(payload);

      // The baseline runs with the spool off, so the two runs differ in nothing
      // but the way the body was received.
      setSpoolConfig(SPOOL_DEFAULTS);
      const { calls: baselineCalls } = stubUpstream(() => errorResponse(payload));
      const baseline = await thrownBy(() => site.post());
      assert.ok(baseline instanceof UpstreamApiError, `expected UpstreamApiError, got ${String(baseline)}`);
      assert.equal(baseline.status, 429);
      assert.equal(baseline.type, 'rate_limit_error');
      assert.equal(baseline.upstreamBody, payload);

      const config = configureSpool();
      assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the first chunk must cross the threshold');
      const seen: Array<{ files: number; bytes: number }> = [];
      const src = source(chunks, (index) => {
        seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
        if (index > 2) throw new Error(`receive asked for too many chunks: ${index}`);
      });
      const { calls } = stubUpstream(() => errorResponse(src.stream));

      const { result: spooled, clones } = await countClones(() => thrownBy(() => site.post()));

      // The spill is the live body while it is received — and this path releases
      // it before it throws, so the end state alone could not tell it apart.
      assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'the received prefix must be on disk, charged');
      assert.ok(spooled instanceof UpstreamApiError, `expected UpstreamApiError, got ${String(spooled)}`);
      assert.equal(spooled.status, baseline.status);
      assert.equal(spooled.type, baseline.type);
      assert.equal(spooled.message, baseline.message, 'the client-facing message must be the upstream one, unchanged');
      assert.equal(spooled.upstreamBody, payload, 'the raw body must reach the error whole');
      assert.equal(calls(), 1);
      assert.equal(baselineCalls(), 1);
      assert.deepEqual(spillFiles(config), [], 'the error path must release the spill before it throws');
      assert.equal(getLiveSpillBytes(), 0);
      assert.equal(clones, 0, 'the bounded receive holds no second copy of the body');
    });

    it('fails loudly past max_response_bytes, and cancels the upstream body', async () => {
      const config = configureSpool({ maxResponseBytes: 256 });
      const payload = errorPayload('z'.repeat(400));
      // 160-byte slices: the first crosses `threshold_bytes` (64) but not the cap,
      // so a spill file really exists when the second slice breaches it.
      const chunks = slices(payload, 160);
      assert.ok(chunks[0].byteLength > config.thresholdBytes && chunks[0].byteLength <= config.maxResponseBytes);
      assert.ok(chunks[0].byteLength + chunks[1].byteLength > config.maxResponseBytes);
      const seen: Array<{ files: number; bytes: number }> = [];
      const src = source(chunks, (index) => {
        seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
      });
      const { calls } = stubUpstream(() => errorResponse(src.stream));

      const caught = await thrownBy(() => site.post());

      assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'a spill must have been live when the cap was breached');
      assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
      assert.equal(caught.status, 500, 'the client sent a legal request: not a 4xx');
      assert.equal(caught.type, 'processing_error');
      assert.match(caught.message, /too large/);
      assert.equal(calls(), 1);
      assert.equal(src.cancelled, true, 'the upstream body must be cancelled, not left flowing');
      assert.deepEqual(spillFiles(config), [], 'a rejected error body removes its partial spill');
      assert.equal(getLiveSpillBytes(), 0);
    });

    it('surfaces a §5.9 refusal ahead of the upstream error, releasing the spill', async () => {
      const payload = errorPayload('b'.repeat(400));
      const bodyBytes = new TextEncoder().encode(payload).byteLength;
      const config = configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2) - 1 });
      assert.ok(bodyBytes > config.thresholdBytes, 'the fixture must spill, so a leak here would be visible on disk');
      const { calls } = stubUpstream(() => errorResponse(payload));

      const caught = await thrownBy(() => site.post());

      assert.ok(caught instanceof AdmissionOverBudgetError, `expected AdmissionOverBudgetError, got ${String(caught)}`);
      assert.equal(caught.status, 503);
      assert.equal(caught.type, 'over_limit_error', 'the type the client switches on');
      assert.equal(calls(), 1, 'the charge is the received byte count, so the body was received first');
      assert.deepEqual(spillFiles(config), [], 'a refused error body must not leave its bytes on disk');
      assert.equal(getLiveSpillBytes(), 0);
      assert.equal(getAdmittedBytes(), 0);
    });
  });
}
