/**
 * Unit tests for the §5.7 non-SSE response path in src/handlers/passthrough.ts.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.7, §5.9.
 *
 * `/passthrough` forwards the upstream body as identity, so the client must
 * receive the upstream bytes themselves — a parse-and-re-serialize would not be
 * the same bytes. Above `threshold_bytes` those bytes live in a `responses/`
 * spill, and the handler hands the client a stream over that spill instead of a
 * second copy. These tests pin the forwarded bytes, the spill's life (charged
 * while the response is in flight, gone once the body has been read, the client
 * aborts, or the read fails), the usage still recorded from the parsed body, and
 * the two cases that fail loudly rather than send a truncated body: a response
 * past `max_response_bytes`, and a spill that ends short. The §5.9 block below
 * pins the opt-in byte budget around the materialized body: its charge, its
 * independence from `[spool] enabled`, and that a refused response leaves
 * neither a spill nor a reservation behind.
 *
 * Request-side egress (client -> upstream) is covered by passthrough-egress.test.ts.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handlePassthroughRequest } from '../../src/handlers/passthrough.js';
import { SpoolResponseTooLargeError } from '../../src/utils/spool-response.js';
import { SpoolWriteError, getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { SPOOL_DEFAULTS, getSpoolConfig, responseSpillDir, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';
import { AdmissionOverBudgetError, getAdmittedBytes } from '../../src/utils/spool-admission.js';
import { getModelStatsDesc } from '../../src/utils/dashboard-stats.js';
import type { Logger } from '../../src/types/shared.js';
import type { ProxyConfig } from '../../src/utils/config-loader.js';

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

/** Spool enabled with a small threshold, so a few hundred bytes spill. */
function configureSpool(overrides: Partial<SpoolConfig> = {}): SpoolConfig {
  const dir = mkdtempSync(join(tmpdir(), 'passthrough-response-test-'));
  scratchDirs.push(dir);
  const config: SpoolConfig = {
    ...SPOOL_DEFAULTS,
    enabled: true,
    dir,
    thresholdBytes: 64,
    maxRequestBytes: 1 << 20,
    maxResponseBytes: 1 << 20,
    maxTotalBytes: 1 << 22,
    ...overrides,
  };
  setSpoolConfig(config);
  return config;
}

const MESSAGES_PATH = '/passthrough/v1/messages';

/** A request body whose `model` is the usage key the handler records under. */
function requestBody(model: string): string {
  return JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }] }, null, 2);
}

/**
 * An upstream response with indentation and non-ASCII text: re-serializing or
 * re-encoding it would change the bytes, so equality here is meaningful.
 */
function responsePayload(model: string, filler = 'ok'): string {
  return JSON.stringify(
    {
      id: 'msg_1',
      type: 'message',
      model,
      content: [{ type: 'text', text: `日本語 — ✓ ${filler}` }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 11, output_tokens: 22 },
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

/**
 * An upstream body we can watch being cancelled when the proxy gives up on it.
 * `onPull(i)` runs when the proxy asks for chunk `i`, i.e. after chunks `0…i-1`
 * have been read.
 */
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

function recordingLogger(): Logger {
  return {
    traceEnabled: false,
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function passthroughConfig(mode: string, recordServer?: string): ProxyConfig {
  return {
    passthrough: { t: { base: 'https://upstream.test', mode } },
    remote: recordServer ? { record_server: recordServer } : undefined,
  };
}

async function callHandler(opts: { request: Request; mode?: string; logger?: Logger; recordServer?: string }): Promise<Response> {
  return await handlePassthroughRequest(
    opts.request,
    MESSAGES_PATH,
    passthroughConfig(opts.mode ?? 'anthropic-messages', opts.recordServer),
    {},
    opts.logger ?? recordingLogger(),
    'req-response',
    {},
    'caller',
    undefined,
    {},
  );
}

function post(model: string): Request {
  return new Request(`http://proxy.test${MESSAGES_PATH}`, { method: 'POST', body: requestBody(model) });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('passthrough non-SSE response (§5.7)', () => {
  it('forwards a body at or below threshold_bytes byte for byte, with no spill', async () => {
    const config = configureSpool({ thresholdBytes: 4096 });
    const payload = responsePayload('claude-resp-small');
    const upstreamBytes = new TextEncoder().encode(payload);
    stubUpstream(() => new Response(payload, { status: 201, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } }));

    const response = await callHandler({ request: post('claude-resp-small') });

    assert.equal(response.status, 201);
    assert.equal(response.headers.get('content-encoding'), null, 'stale body headers are dropped');
    const forwarded = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha256(forwarded), sha256(upstreamBytes), 'the client must receive the upstream bytes, not a re-serialization');
    assert.deepEqual(spillFiles(config), [], 'a body under the threshold leaves no spill');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('spills above threshold_bytes and sends the body from the spill, which ends with the response', async () => {
    const config = configureSpool();
    const payload = responsePayload('claude-resp-spilled', 'x'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    assert.ok(upstreamBytes.byteLength > config.thresholdBytes, 'the fixture must cross the threshold');
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callHandler({ request: post('claude-resp-spilled') });

    // The spill is the live body while the response is being sent, so it is
    // charged to the ledger until the client has taken every byte.
    assert.equal(response.status, 200);
    assert.equal(spillFiles(config).length, 1);
    assert.equal(getLiveSpillBytes(), upstreamBytes.byteLength);

    const forwarded = new Uint8Array(await response.arrayBuffer());

    assert.equal(sha256(forwarded), sha256(upstreamBytes));
    assert.deepEqual(spillFiles(config), [], 'the client reading the body must free the spill');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('still records usage from a spilled response', async () => {
    configureSpool();
    const model = 'claude-resp-usage';
    const payload = responsePayload(model, 'y'.repeat(400));
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callHandler({ request: post(model) });
    await response.arrayBuffer();

    const stats = getModelStatsDesc().find((entry) => entry.model === model);
    assert.ok(stats, `no usage recorded under ${model}: ${JSON.stringify(getModelStatsDesc().map((e) => e.model))}`);
    assert.equal(stats.input_tokens, 11, 'usage comes from the parsed body, above the threshold too');
    assert.equal(stats.output_tokens, 22);
    assert.equal(stats.total_tokens, 33);
  });

  it('fails loudly past max_response_bytes instead of truncating, and cancels the upstream body', async () => {
    const config = configureSpool({ maxResponseBytes: 200 });
    const src = source([new TextEncoder().encode(responsePayload('claude-resp-too-large', 'z'.repeat(1000)))]);
    const { calls } = stubUpstream(() => new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await callHandler({ request: post('claude-resp-too-large') });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.status, 500, 'the client sent a legal request: not a 4xx');
    assert.equal(caught.type, 'processing_error');
    assert.equal(calls(), 1);
    assert.equal(src.cancelled, true, 'the upstream body must be cancelled, not left flowing');
    assert.deepEqual(spillFiles(config), [], 'a rejected response leaves no partial spill');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('releases the spill when the client aborts mid-body', async () => {
    const config = configureSpool();
    const payload = responsePayload('claude-resp-abort', 'w'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callHandler({ request: post('claude-resp-abort') });

    assert.equal(spillFiles(config).length, 1);
    assert.equal(getLiveSpillBytes(), upstreamBytes.byteLength);

    // What the Node adapter does when the client disconnects: cancel the body.
    await response.body?.cancel();

    assert.deepEqual(spillFiles(config), [], 'an aborted response must not leave the body on disk');
    assert.equal(getLiveSpillBytes(), 0, 'nor hold its bytes against max_total_bytes');
  });

  it('reports a spill that ends short instead of sending a truncated body', async () => {
    const config = configureSpool();
    const payload = responsePayload('claude-resp-short', 'v'.repeat(400));
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callHandler({ request: post('claude-resp-short') });
    const [spill] = spillFiles(config);
    assert.ok(spill, 'the fixture must have spilled');
    // A spill that lost bytes must not be handed to the client as a whole body:
    // the read has to fail with the error type the plan names, not end early and
    // not keep handing out empty chunks. The reader is stepped by hand and
    // bounded, so a read that never ends fails here instead of hanging the suite.
    truncateSync(join(responseSpillDir(config), spill), 0);

    const reader = response.body!.getReader();
    let bodyChunks = 0;
    let caught: unknown;
    try {
      for (let read = 0; read < 2; read += 1) {
        const { done } = await reader.read();
        if (done) break;
        bodyChunks += 1;
      }
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof SpoolWriteError, `expected SpoolWriteError, got ${String(caught)}`);
    assert.equal(bodyChunks, 0, 'not one byte of a short spill may reach the client');
    assert.deepEqual(spillFiles(config), [], 'a failed read still frees the spill');
    assert.equal(getLiveSpillBytes(), 0);
  });
});

/**
 * The upstream *error* body (§5.7). `!response.ok` used to call
 * `response.text()`, so an upstream error body was the one body on this path that
 * nothing bounded. It now goes through the same `withResponseText` as a success
 * body, and the raw text still reaches `handleTargetApiError` verbatim.
 */
describe('passthrough upstream error body (§5.7)', () => {
  /** A 429 answer whose body is large enough to spill, indented so bytes matter. */
  function errorPayload(marker: string): string {
    return JSON.stringify(
      { type: 'error', error: { type: 'rate_limit_error', message: `upstream said ${marker}` } },
      null,
      2,
    );
  }

  /** Run the handler and return whatever it threw: `handleTargetApiError` throws. */
  async function caughtFromHandler(): Promise<any> {
    try {
      await callHandler({ request: post('claude-err') });
    } catch (error) {
      return error;
    }
    return undefined;
  }

  it('receives an error body through the spill and carries it verbatim', async () => {
    const config = configureSpool();
    const payload = errorPayload('x'.repeat(200));
    const bytes = new TextEncoder().encode(payload);
    const half = Math.floor(bytes.byteLength / 2);
    const chunks = [bytes.subarray(0, half), bytes.subarray(half)];
    assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the fixture must spill');
    const seen: Array<{ files: number; bytes: number }> = [];
    const src = source(chunks, (index) => {
      seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
      if (index > 2) throw new Error(`receive asked for too many chunks: ${index}`);
    });
    stubUpstream(() => new Response(src.stream, { status: 429, headers: { 'Content-Type': 'application/json' } }));

    const caught = await caughtFromHandler();

    // The error body really went through the spill, or a whole-body read would
    // leave nothing on disk part-way through.
    assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'the error body must have been on disk mid-receive');
    assert.equal(caught?.status, 429, 'the upstream status still reaches the client');
    assert.equal(caught?.type, 'rate_limit_error');
    // The raw body is what the client receives on this path, so equality here is
    // the property that matters: indentation, order and the marker all survived.
    assert.equal(caught?.upstreamBody, payload, 'the error body must reach the client byte for byte');
    assert.deepEqual(spillFiles(config), [], 'the spill is released before the error is thrown');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('fails loudly past max_response_bytes instead of carrying a truncated error body', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const payload = errorPayload('z'.repeat(400));
    const bytes = new TextEncoder().encode(payload);
    const chunks: Uint8Array[] = [];
    for (let offset = 0; offset < bytes.byteLength; offset += 160) chunks.push(bytes.subarray(offset, offset + 160));
    assert.ok(chunks[0].byteLength > config.thresholdBytes && chunks[0].byteLength <= config.maxResponseBytes);
    const src = source(chunks);
    stubUpstream(() => new Response(src.stream, { status: 429, headers: { 'Content-Type': 'application/json' } }));

    const caught = await caughtFromHandler();

    // The proxy's cap, not the upstream's 429: the client is told what actually
    // stopped the body (rule #8).
    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.status, 500);
    assert.match(caught.message, /too large/);
    assert.equal(src.cancelled, true, 'the upstream body must be cancelled, not left flowing');
    assert.deepEqual(spillFiles(config), [], 'a rejected error body removes its partial spill');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('keeps its unreadable-body placeholder when the error stream itself breaks', async () => {
    configureSpool();
    // What a socket that dies mid-body does: the read rejects with a `TypeError`.
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new TypeError('terminated'));
      },
    });
    stubUpstream(() => new Response(broken, { status: 429, headers: { 'Content-Type': 'application/json' } }));

    const caught = await caughtFromHandler();

    // The one thing that placeholder was ever for: an unreadable body must not
    // replace the upstream's error with a crash; anything else (a cap, a write
    // failure, a §5.9 refusal) is the proxy's own limit and propagates as itself.
    assert.equal(caught?.status, 429);
    assert.equal(caught?.type, 'rate_limit_error');
    assert.equal(caught?.upstreamBody, '(failed to read response body)');
    assert.equal(getLiveSpillBytes(), 0);
  });
});

/**
 * §5.9 byte admission on this path (`max_materialized_body_bytes`, off by
 * default). A response's size is unknown until it has been received, so the
 * reservation comes after `receiveResponseBody` and before `readText` — the same
 * "receive, then reserve before read" order as the request path in src/index.ts.
 */
describe('passthrough non-SSE response, byte admission (§5.9)', () => {
  it('holds exactly ceil(bytes × factor) while the body is materialized, and releases before the client reads', async () => {
    const payload = responsePayload('claude-resp-admit', 'a'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    const charge = Math.ceil(upstreamBytes.byteLength * 2);
    const config = configureSpool({ maxMaterializedBodyBytes: charge });
    assert.ok(upstreamBytes.byteLength > config.thresholdBytes, 'the fixture must spill, so the hold covers a body that lives on disk');

    let admittedDuringUsageRecord: number | undefined;
    let spilledDuringUsageRecord: number | undefined;
    let upstreamCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith('https://records.test')) {
        // Runs inside the materialized window: the body has been received and
        // spilled, its text has been parsed, and the lease is still held.
        admittedDuringUsageRecord = getAdmittedBytes();
        spilledDuringUsageRecord = getLiveSpillBytes();
        return new Response('{}', { status: 200 });
      }
      upstreamCalls += 1;
      return new Response(payload, { headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const response = await callHandler({ request: post('claude-resp-admit'), recordServer: 'https://records.test/usage' });

    assert.equal(response.status, 200);
    assert.equal(upstreamCalls, 1);
    assert.equal(admittedDuringUsageRecord, charge, 'the charge is ceil(received bytes × factor), over a budget that fits it exactly');
    assert.equal(spilledDuringUsageRecord, upstreamBytes.byteLength, 'the §5.9 ledger and the spill ledger are separate ledgers');
    // The body is still there for the client even though the budget no longer
    // admits it: releasing the lease is not releasing the spill.
    assert.equal(spillFiles(config).length, 1);
    assert.equal(getAdmittedBytes(), 0, 'the lease is released before the client is handed the body');

    const forwarded = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha256(forwarded), sha256(upstreamBytes), 'the admitted response is forwarded byte for byte');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('refuses a response one nominal byte past the budget, leaving no spill and no reservation', async () => {
    const payload = responsePayload('claude-resp-over-budget', 'b'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    const charge = Math.ceil(upstreamBytes.byteLength * 2);
    const config = configureSpool({ maxMaterializedBodyBytes: charge - 1 });
    assert.ok(upstreamBytes.byteLength > config.thresholdBytes, 'the fixture must spill, so a leak here would be visible on disk');
    const { calls } = stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await callHandler({ request: post('claude-resp-over-budget') });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof AdmissionOverBudgetError, `expected AdmissionOverBudgetError, got ${String(caught)}`);
    assert.equal(caught.status, 503);
    assert.equal(caught.type, 'over_limit_error', 'the type the client switches on');
    assert.match(caught.message, /exceed max_materialized_body_bytes/);
    assert.equal(calls(), 1, 'a response is judged on what it received, so the body was received first');
    // One byte short of a charge the test above shows is exact: the refusal is
    // the budget talking, not an off-by-one in the fixture.
    assert.deepEqual(spillFiles(config), [], 'a refused response must not leave its bytes on disk');
    assert.equal(getLiveSpillBytes(), 0, 'nor hold them against max_total_bytes');
    assert.equal(getAdmittedBytes(), 0, 'a refused response holds nothing on the ledger either');
  });

  it('applies the budget with the store disabled, where nothing spills', async () => {
    const payload = responsePayload('claude-resp-admit-off', 'c'.repeat(400));
    const charge = Math.ceil(new TextEncoder().encode(payload).byteLength * 2);
    const config = configureSpool({ enabled: false, maxMaterializedBodyBytes: charge - 1 });
    assert.equal(getSpoolConfig().enabled, false, 'the budget is independent of [spool] enabled');
    const { calls } = stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await callHandler({ request: post('claude-resp-admit-off') });
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof AdmissionOverBudgetError, `expected AdmissionOverBudgetError, got ${String(caught)}`);
    assert.equal(caught.status, 503);
    assert.match(caught.message, /exceed max_materialized_body_bytes/);
    assert.equal(calls(), 1);
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(getAdmittedBytes(), 0);
  });

  it('charges the configured materialization_factor, not a fixed 2', async () => {
    const payload = responsePayload('claude-resp-factor', 'd'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    // A budget that fits the body at factor 2 and does not at factor 3: the
    // factor, not the raw size, is what decides.
    const budget = Math.ceil(upstreamBytes.byteLength * 2);
    const { calls } = stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    configureSpool({ maxMaterializedBodyBytes: budget, materializationFactor: 3 });
    await assert.rejects(
      () => callHandler({ request: post('claude-resp-factor') }),
      AdmissionOverBudgetError,
      'at factor 3 the same bytes must not fit the same budget',
    );
    assert.equal(getAdmittedBytes(), 0);

    configureSpool({ maxMaterializedBodyBytes: budget, materializationFactor: 2 });
    const response = await callHandler({ request: post('claude-resp-factor') });
    assert.equal(response.status, 200);
    const forwarded = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha256(forwarded), sha256(upstreamBytes), 'and at factor 2 they do, with the body unchanged');
    assert.equal(calls(), 2);
    assert.equal(getAdmittedBytes(), 0, 'both outcomes released: the refusal held nothing, the admit gave it back');
  });
});
