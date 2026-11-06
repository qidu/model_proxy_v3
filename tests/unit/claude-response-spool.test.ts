/**
 * Unit tests for the §5.7 non-SSE response path in `src/handlers/claude.ts`
 * (`handleClaudeRequest`, the native `anthropic-messages` egress of the
 * `/v1/messages` front door).
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.7, §5.9.
 *
 * This branch never converts: the upstream JSON is the client's JSON, so the
 * tests pin the identity of the forwarded bytes (indented fixture, non-ASCII
 * text — a re-serialize or re-encode would change them), the spill's life
 * (charged while the response is in flight, gone once the client has read it or
 * aborted), and that no `Response.clone()` holds a second copy. That last one is
 * the point of the increment: the read this replaces was a `response.clone()`
 * made for two trace lines, which pulled the whole body into RAM as fast as the
 * upstream could send it whatever pace the client kept (plan §5.7: "do not call
 * `response.clone().text()` or buffer a second copy").
 *
 * The receive is not gated on `[spool] enabled`, matching the other identity
 * egresses (src/handlers/responses.ts, src/handlers/passthrough.ts,
 * src/handlers/gemini.ts), so `max_response_bytes` is enforced with spilling off
 * too: the fifth and sixth cases pin that, both the cap that now applies and the
 * `enabled = false` forwarding that still writes nothing to disk. The §5.9 block
 * pins that the budget is taken around the **trace** read, which is the only read
 * this branch does: with tracing off there is nothing to admit, so a budget one
 * byte short of the charge must still serve the response.
 *
 * The same file reads an upstream *error* body whole on the `!response.ok` branch
 * (`:184`), behind a bare `catch {}` that replaced any failure with
 * `'(failed to read response body)'`. That read now goes through
 * `withResponseText` and the catch keeps only a `TypeError`, so the placeholder is
 * still there for the case it was written for while a cap breach or a refusal
 * surfaces as itself rather than as the upstream's 429.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleClaudeRequest } from '../../src/handlers/claude.js';
import { SpoolResponseTooLargeError } from '../../src/utils/spool-response.js';
import { UpstreamApiError } from '../../src/utils/errors.js';
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
const UPSTREAM_URL = 'https://api.anthropic.com/v1/messages';

/** Spool enabled with a small threshold, so a few hundred bytes spill. */
function configureSpool(overrides: Partial<SpoolConfig> = {}): SpoolConfig {
  const dir = mkdtempSync(join(tmpdir(), 'claude-response-test-'));
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
 * A native Messages response, indented and with non-ASCII text: the client sees
 * these exact bytes, so byte equality against this fixture is meaningful.
 */
function claudePayload(filler = 'ok'): string {
  return JSON.stringify(
    {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [{ type: 'text', text: `日本語 — ✓ ${filler}` }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 4, output_tokens: 259 },
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

/**
 * Stub global fetch, counting calls and answering with `respond()`. A real fetch
 * consumes the request body, and a request-side spill is released only once the
 * send has drained it (increment 39's send-boundary lease release), so the stub
 * drains `init.body` when it is a stream.
 */
function stubUpstream(respond: () => Response): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
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

/** A body that fails partway through, the one case the placeholder was ever for. */
function failingSource(error: Error): Sourced {
  const state: Sourced = { cancelled: false, stream: null as unknown as ReadableStream<Uint8Array> };
  state.stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.error(error);
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

/** Send a native non-streaming `/v1/messages` request and return the client response. */
async function callHandler(logger: Logger = recordingLogger(false)): Promise<Response> {
  return await handleClaudeRequest(
    new Request(`${CLIENT_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'client-key' },
      body: JSON.stringify({
        model: 'claude-test',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    }),
    UPSTREAM_URL,
    { 'x-api-key': 'upstream-key' },
    'req-claude-response',
    'claude-test',
    ENV,
    logger,
  );
}

/** A response that streams `payload` as SSE, for the streaming branch's own shape. */
function sseResponse(payload: string): Response {
  return new Response(payload, { headers: { 'Content-Type': 'text/event-stream' } });
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

describe('claude.ts native /v1/messages non-SSE response (§5.7)', () => {
  it('forwards a small response byte-identically without touching the spool', async () => {
    const config = configureSpool({ thresholdBytes: 4096 });
    const payload = claudePayload();
    const upstreamBytes = new TextEncoder().encode(payload);
    assert.ok(upstreamBytes.byteLength < config.thresholdBytes, 'the fixture must stay under the threshold');
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const { result: response, clones } = await countClones(() => callHandler());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('content-length'), null, 'the upstream length is dropped, not restated');
    const forwarded = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha256(forwarded), sha256(upstreamBytes), 'the client must read the upstream bytes');
    assert.deepEqual(JSON.parse(new TextDecoder().decode(forwarded)).content, [
      { type: 'text', text: '日本語 — ✓ ok' },
    ]);
    assert.deepEqual(spillFiles(config), [], 'a body under the threshold leaves no spill');
    assert.equal(clones, 0, 'the proxy must not hold a second copy of the body');
  });

  it('spills above threshold_bytes and sends the body from the spill, which ends with the response', async () => {
    const config = configureSpool();
    const payload = claudePayload('x'.repeat(400));
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

    assert.equal(sha256(forwarded), sha256(upstreamBytes), 'forwarding from the spill must not alter the body');
    assert.deepEqual(spillFiles(config), [], 'the client reading the body must free the spill');
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(clones, 0, 'a pass-through body is exactly what must not be duplicated in RAM');
  });

  it('fails loudly past max_response_bytes instead of truncating, and cancels the upstream body', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const encoder = new TextEncoder();
    // Two chunks: the first crosses `threshold_bytes`, so a spill really is
    // created and then has to be cleaned up when the second breaches the cap.
    const src = source([
      encoder.encode(claudePayload('z'.repeat(200))),
      encoder.encode(claudePayload('z'.repeat(200))),
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
    const payload = claudePayload('w'.repeat(400));
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
    const payload = claudePayload('d'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    assert.ok(upstreamBytes.byteLength > config.thresholdBytes);
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callHandler();

    assert.equal(response.status, 200);
    const forwarded = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha256(forwarded), sha256(upstreamBytes), '`enabled` decides where the bytes live, not what they are');
    assert.deepEqual(spillFiles(config), [], 'nothing may reach disk when spilling is off');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('enforces max_response_bytes with the spool disabled, like the other identity egresses', async () => {
    const config = configureSpool({ enabled: false, maxResponseBytes: 256 });
    const payload = claudePayload('c'.repeat(400));
    assert.ok(new TextEncoder().encode(payload).byteLength > config.maxResponseBytes);
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await callHandler();
    } catch (error) {
      caught = error;
    }

    // Deliberate, and the same rule the Responses egress, the passthrough egress
    // and both other handlers in this family already follow: the receive replaced
    // the whole-body read outright, so the cap is a memory bound on that read and
    // not part of the spilling feature. Serving this body would mean holding it
    // twice in RAM — the cost the cap exists to refuse.
    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.status, 500);
    assert.equal(caught.type, 'processing_error');
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('sends both trace lines from the spill without changing what the client receives', async () => {
    const config = configureSpool();
    const payload = claudePayload('t'.repeat(400));
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

  it('leaves the SSE branch alone: an event-stream response is still passed straight through', async () => {
    const config = configureSpool();
    const payload = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    stubUpstream(() => sseResponse(payload));

    const response = await callHandler();

    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(await response.text(), payload, 'the SSE path is index.ts’s, not this branch’s');
    assert.deepEqual(spillFiles(config), [], 'the non-SSE spool must not touch an event stream');
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
describe('claude.ts native /v1/messages non-SSE response, byte admission (§5.9)', () => {
  it('does not charge a response whose body is never read', async () => {
    const payload = claudePayload('n'.repeat(400));
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
    const payload = claudePayload('b'.repeat(400));
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

  it('serves a trace read at exactly the budget and releases the lease before the client reads', async () => {
    const payload = claudePayload('a'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    const charge = Math.ceil(upstreamBytes.byteLength * 2);
    const config = configureSpool({ maxMaterializedBodyBytes: charge });
    const logger = recordingLogger(true);
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callHandler(logger);

    // The trace text is logged and unreachable by the time the client is answered,
    // so §5.9's "release before network streaming" holds: the lease is gone before
    // a single byte of the body is written, even though the spill is still live.
    assert.equal(getAdmittedBytes(), 0, 'the lease must not outlive the read it was taken for');
    assert.equal(spillFiles(config).length, 1, 'the body itself is still the client’s to read');

    const forwarded = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha256(forwarded), sha256(upstreamBytes));
    assert.deepEqual(spillFiles(config), []);
  });
});

// ---------------------------------------------------------------------------
// §5.7: the upstream *error* body
// ---------------------------------------------------------------------------

/**
 * The `!response.ok` branch on this handler read the upstream's error body with
 * `response.text()` behind a bare `catch {}` that replaced *any* failure with
 * `'(failed to read response body)'`. That catch now keeps only a `TypeError` —
 * the unreadable-body case the placeholder was written for — so a
 * `max_response_bytes` breach, a spill write failure or a §5.9 refusal surfaces
 * as itself instead of being reported to the client as the upstream's error
 * (rule #8). The upstream's own status, type, message and raw body still reach
 * the client unchanged, because `handleTargetApiError` is fed the same text.
 */

function errorPayload(marker: string): string {
  return JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: `upstream said ${marker}` } }, null, 2);
}

function errorResponse(body: ReadableStream<Uint8Array> | string): Response {
  return new Response(body, { status: 429, headers: { 'Content-Type': 'application/json' } });
}

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

function twoChunks(payload: string): Uint8Array[] {
  const bytes = new TextEncoder().encode(payload);
  const half = Math.floor(bytes.byteLength / 2);
  return [bytes.subarray(0, half), bytes.subarray(half)];
}

/**
 * Fixed-size slices of an encoded body. A body that first crosses
 * `threshold_bytes` (so a spill really is created) and only then breaches
 * `max_response_bytes` needs more than two chunks to arrange.
 */
function slices(payload: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(payload);
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    out.push(bytes.subarray(offset, offset + size));
  }
  return out;
}

describe('claude.ts native /v1/messages upstream error body (§5.7)', () => {
  it('receives the error body through the spill and carries it verbatim', async () => {
    const payload = errorPayload('x'.repeat(400));

    // Baseline: spooling off, which is the `response.text()` behaviour this
    // replaces — the same request must still fail the same way.
    setSpoolConfig(SPOOL_DEFAULTS);
    const baselineCalls = stubUpstream(() => errorResponse(payload));
    const baseline = await thrownBy(() => callHandler());
    assert.ok(baseline instanceof UpstreamApiError, `expected UpstreamApiError, got ${String(baseline)}`);
    assert.equal(baseline.status, 429);
    assert.equal(baseline.type, 'rate_limit_error', 'the type the client switches on');
    assert.equal(baseline.upstreamBody, payload);

    const chunks = twoChunks(payload);

    // Captured after the baseline run, because every `configureSpool` call makes
    // a fresh directory: this is the config whose `responses/` the spill lands in.
    const config = configureSpool();
    assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the first chunk must cross the threshold');

    const seen: Array<{ files: number; bytes: number }> = [];
    const src = source(chunks, (index) => {
      seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
      if (index > 2) throw new Error(`receive asked for too many chunks: ${index}`);
    });
    const { calls } = stubUpstream(() => errorResponse(src.stream));

    const { result: spooled, clones } = await countClones(() => thrownBy(() => callHandler()));

    // The spill is the live body while it is received — and this path releases
    // it before it throws, so the end state alone could not tell it apart.
    assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'the received prefix must be on disk, charged');
    assert.ok(spooled instanceof UpstreamApiError, `expected UpstreamApiError, got ${String(spooled)}`);
    assert.equal(spooled.status, baseline.status);
    assert.equal(spooled.type, baseline.type);
    assert.equal(spooled.message, baseline.message, 'the client-facing message must be the upstream one, unchanged');
    assert.equal(spooled.upstreamBody, payload, 'the raw body must reach the error whole');
    assert.equal(calls(), 1);
    assert.equal(baselineCalls.calls(), 1);
    assert.deepEqual(spillFiles(config), [], 'the spill must be released even though this path ends in a throw');
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(clones, 0, 'no `response.clone()` for an error body either');
  });

  it('fails loudly past max_response_bytes instead of reporting the placeholder', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    // 160-byte slices: the first crosses `threshold_bytes` (64) but not the cap,
    // so a spill file really exists when the second slice breaches it — the
    // state the failure path has to clean up.
    const chunks = slices(errorPayload('y'.repeat(400)), 160);
    assert.ok(chunks[0].byteLength > config.thresholdBytes && chunks[0].byteLength <= config.maxResponseBytes);
    assert.ok(chunks[0].byteLength + chunks[1].byteLength > config.maxResponseBytes);
    const seen: Array<{ files: number; bytes: number }> = [];
    const src = source(chunks, (index) => {
      seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
    });
    const { calls } = stubUpstream(() => errorResponse(src.stream));

    const caught = await thrownBy(() => callHandler());

    assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'a spill must have been live when the cap was breached');
    // The bare `catch {}` this replaces would have turned this into the upstream's
    // 429 with the placeholder body; the proxy's own limit must surface as itself.
    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.status, 500, 'the client sent a legal request: not a 4xx');
    assert.equal(caught.type, 'processing_error');
    assert.match(caught.message, /too large/);
    assert.equal(calls(), 1);
    assert.equal(src.cancelled, true, 'the upstream body must be cancelled, not left flowing');
    assert.deepEqual(spillFiles(config), [], 'a rejected response removes its partial spill');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('surfaces a §5.9 refusal instead of the upstream error, and holds no lease', async () => {
    const payload = errorPayload('z'.repeat(400));
    const bodyBytes = new TextEncoder().encode(payload).byteLength;
    // 160-byte slices: the first crosses the threshold, so the refusal has a
    // spill to clean up rather than refusing an in-memory body.
    const chunks = slices(payload, 160);
    const config = configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2) - 1 });
    assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the body must be spilling when it is admitted');
    stubUpstream(() => errorResponse(payload));

    const caught = await thrownBy(() => callHandler());

    assert.ok(caught instanceof AdmissionOverBudgetError, `expected AdmissionOverBudgetError, got ${String(caught)}`);
    assert.equal(caught.status, 503);
    assert.equal(caught.type, 'over_limit_error', 'the type the client switches on');
    assert.match(caught.message, /exceed max_materialized_body_bytes/);
    assert.deepEqual(spillFiles(config), [], 'a refused error body must not leave its bytes on disk');
    assert.equal(getLiveSpillBytes(), 0, 'nor hold them against max_total_bytes');
    assert.equal(getAdmittedBytes(), 0);
  });

  it('still substitutes the placeholder when the body itself cannot be read', async () => {
    const config = configureSpool({ thresholdBytes: 4096 });
    // A `TypeError` is what an unreadable body throws; the narrowing exists so
    // that only that case keeps the placeholder, and this pins that it still does.
    stubUpstream(() => errorResponse(failingSource(new TypeError('terminated')).stream));

    const caught = await thrownBy(() => callHandler());

    assert.ok(caught instanceof UpstreamApiError, `expected UpstreamApiError, got ${String(caught)}`);
    assert.equal(caught.status, 429);
    assert.equal(caught.upstreamBody, '(failed to read response body)');
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });
});
