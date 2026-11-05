/**
 * Unit tests for the §5.7 non-SSE identity forwards in `src/handlers/responses.ts`:
 * `handleAsPassthrough`'s non-SSE tail, and the passthrough halves of
 * `POST /v1/responses/input_tokens` and `POST /v1/responses/compact`.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.7, §5.9.
 *
 * None of these branches converts, so the upstream bytes are the client's bytes: the
 * tests pin that identity (one fixture is not even JSON, so a parse-and-re-serialize
 * would fail them), the spill's life — charged while the response is in flight,
 * gone once the body has been read, the client aborts, or the read fails — and the
 * two cases that fail loudly rather than send a truncated body: a response past
 * `max_response_bytes`, and a spill that ends short. The §5.9 block pins that the
 * byte budget is taken around the **trace** read, which is the only read this
 * branch does: with tracing off there is nothing to admit and a budget one byte
 * short of the charge must still serve the response.
 *
 * The two `/input_tokens` and `/compact` sites came later and are the same shape, so
 * their properties are written once against a site table at the bottom of this file.
 *
 * Request-side egress (client -> upstream) is covered by
 * responses-ref-streaming.test.ts; the SSE response path by responses-stream-events.ts;
 * the converting readers by responses-response-spool.test.ts.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  handleResponsesRequest,
  handleResponsesInputTokensRequest,
  handleResponsesCompactRequest,
} from '../../src/handlers/responses.js';
import { SpoolResponseTooLargeError } from '../../src/utils/spool-response.js';
import { SpoolWriteError, getLiveSpillBytes } from '../../src/utils/spool-body.js';
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
const REQUEST_ID = 'req-responses-response';
const UPSTREAM_URL = 'https://upstream.example/v1/responses';
const INPUT_TOKENS_URL = 'https://upstream.example/v1/responses/input_tokens';
const COMPACT_URL = 'https://upstream.example/v1/responses/compact';

/** Spool enabled with a small threshold, so a few hundred bytes spill. */
function configureSpool(overrides: Partial<SpoolConfig> = {}): SpoolConfig {
  const dir = mkdtempSync(join(tmpdir(), 'responses-response-test-'));
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
 * An upstream Responses body with indentation and non-ASCII text: re-serializing
 * or re-encoding it would change the bytes, so equality here is meaningful.
 */
function responsePayload(filler = 'ok'): string {
  return JSON.stringify(
    {
      id: 'resp_1',
      object: 'response',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `日本語 — ✓ ${filler}` }] }],
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

/** A logger that records its trace lines, so a case can assert on the body log. */
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

/**
 * Send `body` through the real handler's passthrough branch and return the client
 * response. `mode` is the native one, so no converting branch intercepts the body.
 */
async function callHandler(opts: {
  body?: Record<string, unknown>;
  logger?: Logger;
} = {}): Promise<Response> {
  return await handleResponsesRequest(
    new Request(`${CLIENT_URL}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts.body ?? { model: 'gpt-test', stream: false, input: 'hi' }),
    }),
    UPSTREAM_URL,
    { Authorization: 'Bearer upstream-key' },
    REQUEST_ID,
    'gpt-test',
    ENV,
    opts.logger ?? recordingLogger(false),
    'openai-responses',
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('responses.ts passthrough non-SSE response (§5.7)', () => {
  it('forwards a body at or below threshold_bytes byte for byte, with no spill', async () => {
    const config = configureSpool({ thresholdBytes: 4096 });
    const payload = responsePayload();
    const upstreamBytes = new TextEncoder().encode(payload);
    assert.ok(upstreamBytes.byteLength < config.thresholdBytes, 'the fixture must stay under the threshold');
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callHandler();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    const forwarded = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha256(forwarded), sha256(upstreamBytes), 'the client must receive the upstream bytes, not a re-serialization');
    assert.deepEqual(spillFiles(config), [], 'a body under the threshold leaves no spill');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('forwards a body that is not JSON verbatim — this branch never parses it', async () => {
    const config = configureSpool({ thresholdBytes: 4096 });
    const payload = '{"id":"resp_1","output":[truncated';
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callHandler();

    assert.equal(response.status, 200);
    assert.equal(await response.text(), payload, 'an upstream body the proxy cannot parse must still reach the client');
    assert.deepEqual(spillFiles(config), []);
  });

  it('spills above threshold_bytes and sends the body from the spill, which ends with the response', async () => {
    const config = configureSpool();
    const payload = responsePayload('x'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    assert.ok(upstreamBytes.byteLength > config.thresholdBytes, 'the fixture must cross the threshold');
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callHandler();

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

  it('sends the trace body from the spool without changing what the client receives', async () => {
    const config = configureSpool();
    const payload = responsePayload('t'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    const logger = recordingLogger(true);
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callHandler({ logger });

    // The raw upstream body must still be visible at the upstream-response stage,
    // exactly as when it was read whole: tracing is what the read is for.
    const stage = logger.traces.filter((line) => line.startsWith('[UPSTREAM-RESP] '));
    assert.equal(stage.length, 1, `expected one upstream-response body line, got ${JSON.stringify(logger.traces)}`);
    assert.match(stage[0], new RegExp(`^\\[UPSTREAM-RESP\\] ${UPSTREAM_URL}: `));
    assert.equal(stage[0].slice(stage[0].indexOf(': ') + 2), payload, 'the traced body must be the upstream bytes');

    const forwarded = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha256(forwarded), sha256(upstreamBytes), 'reading the spill for the trace must not alter the body');
    assert.deepEqual(spillFiles(config), []);
  });

  it('sends nothing when the upstream has no body', async () => {
    const config = configureSpool();
    stubUpstream(() => new Response(null, { status: 200, headers: { 'Content-Type': 'application/json' } }));

    const response = await callHandler();

    assert.equal(response.status, 200);
    assert.equal(await response.text(), '');
    assert.deepEqual(spillFiles(config), [], 'a bodyless response must not touch the spool');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('fails loudly past max_response_bytes instead of truncating, and cancels the upstream body', async () => {
    const config = configureSpool({ maxResponseBytes: 200 });
    const src = source([new TextEncoder().encode(responsePayload('z'.repeat(1000)))]);
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
    assert.equal(calls(), 1);
    assert.equal(src.cancelled, true, 'the upstream body must be cancelled, not left flowing');
    assert.deepEqual(spillFiles(config), [], 'a rejected response leaves no partial spill');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('releases the spill when the client aborts mid-body', async () => {
    const config = configureSpool();
    const payload = responsePayload('w'.repeat(400));
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

  it('reports a spill that ends short instead of sending a truncated body', async () => {
    const config = configureSpool();
    const payload = responsePayload('v'.repeat(400));
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callHandler();
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
 * §5.9 byte admission on this path (`max_materialized_body_bytes`, off by
 * default). This branch materializes only to trace-log the body, so the budget
 * is taken around that read and nowhere else: the pair below is what says the
 * read — and therefore the hold — is the trace's, not a cost every response pays.
 */
describe('responses.ts passthrough non-SSE response, byte admission (§5.9)', () => {
  it('does not charge a response whose body is never read', async () => {
    const payload = responsePayload('n'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    const charge = Math.ceil(upstreamBytes.byteLength * 2);
    const config = configureSpool({ maxMaterializedBodyBytes: charge - 1 });
    assert.ok(upstreamBytes.byteLength > config.thresholdBytes, 'the fixture must spill, so a leak would be visible on disk');
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    // Tracing off: no read, so a budget that could not admit this body is not
    // consulted at all. A version that admitted the received body unconditionally
    // would refuse here with a 503 the client never asked for.
    const response = await callHandler({ logger: recordingLogger(false) });

    assert.equal(response.status, 200);
    const forwarded = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha256(forwarded), sha256(upstreamBytes));
    assert.equal(getAdmittedBytes(), 0);
    assert.deepEqual(spillFiles(config), []);
  });

  it('refuses a trace read one nominal byte past the budget, leaving no spill and no reservation', async () => {
    const payload = responsePayload('b'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    const charge = Math.ceil(upstreamBytes.byteLength * 2);
    const config = configureSpool({ maxMaterializedBodyBytes: charge - 1 });
    assert.ok(upstreamBytes.byteLength > config.thresholdBytes, 'the fixture must spill, so a leak here would be visible on disk');
    const { calls } = stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await callHandler({ logger: recordingLogger(true) });
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
    assert.equal(getAdmittedBytes(), 0, 'a refused response holds nothing on the ledger either');
  });

  it('holds exactly ceil(bytes × factor) while the body is traced, and releases before the client reads', async () => {
    const payload = responsePayload('a'.repeat(400));
    const upstreamBytes = new TextEncoder().encode(payload);
    const charge = Math.ceil(upstreamBytes.byteLength * 2);
    const config = configureSpool({ maxMaterializedBodyBytes: charge });
    assert.ok(upstreamBytes.byteLength > config.thresholdBytes, 'the fixture must spill, so the hold covers a body that lives on disk');

    let admittedDuringTrace: number | undefined;
    const logger = recordingLogger(true);
    const traces = logger.traces;
    logger.trace = (_requestId: string, message: string) => {
      // Runs inside the materialized window: the body has been received and
      // spilled, its text has been read, and the lease is still held.
      if (message.startsWith('[UPSTREAM-RESP] ') && admittedDuringTrace === undefined) {
        admittedDuringTrace = getAdmittedBytes();
      }
      traces.push(message);
    };
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await callHandler({ logger });

    assert.equal(response.status, 200);
    assert.equal(admittedDuringTrace, charge, 'the charge is ceil(received bytes × factor), over a budget that fits it exactly');
    assert.equal(spillFiles(config).length, 1);
    assert.equal(getAdmittedBytes(), 0, 'the lease is released before the client is handed the body');

    const forwarded = new Uint8Array(await response.arrayBuffer());
    assert.equal(sha256(forwarded), sha256(upstreamBytes), 'the admitted response is forwarded byte for byte');
    assert.equal(getLiveSpillBytes(), 0);
  });
});

/**
 * The other two identity forwards: the passthrough halves of
 * `POST /v1/responses/input_tokens` and `POST /v1/responses/compact`. They are the
 * same shape as the one above — the upstream body is the client's body, one
 * bounded receive, nothing parsed — so the properties are written once against a
 * site table. Before this they handed `new Response(<upstream>.body, …)` straight
 * to the client: no receive, no `max_response_bytes`, no spool.
 */
interface IdentitySite {
  name: string;
  /** Send the client request, with the native upstream mode, and return the answer. */
  invoke: (logger: Logger) => Promise<Response>;
  /** The upstream URL the body comes from, as it appears in the trace line. */
  upstreamUrl: string;
}

const IDENTITY_SITES: IdentitySite[] = [
  {
    name: 'POST /v1/responses/input_tokens',
    invoke: (logger) => handleResponsesInputTokensRequest(
      new Request(`${CLIENT_URL}/v1/responses/input_tokens`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-test', input: 'hi' }),
      }),
      INPUT_TOKENS_URL,
      { Authorization: 'Bearer upstream-key' },
      REQUEST_ID,
      'gpt-test',
      ENV,
      logger,
    ),
    upstreamUrl: INPUT_TOKENS_URL,
  },
  {
    name: 'POST /v1/responses/compact',
    invoke: (logger) => handleResponsesCompactRequest(
      new Request(`${CLIENT_URL}/v1/responses/compact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-test', input: 'hi' }),
      }),
      COMPACT_URL,
      { Authorization: 'Bearer upstream-key' },
      REQUEST_ID,
      'gpt-test',
      ENV,
      logger,
    ),
    upstreamUrl: COMPACT_URL,
  },
];

for (const site of IDENTITY_SITES) {
  describe(`responses.ts ${site.name} passthrough response (§5.7)`, () => {
    it('forwards a body it cannot parse verbatim, with no spill', async () => {
      const config = configureSpool({ thresholdBytes: 4096 });
      // Not JSON on purpose: a branch that parsed and re-serialized would fail here.
      const payload = '{"object":"response.input_tokens","input_tokens":12';
      stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

      const response = await site.invoke(recordingLogger(false));

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-request-id'), REQUEST_ID);
      assert.equal(await response.text(), payload, 'the upstream bytes are the client bytes');
      assert.deepEqual(spillFiles(config), [], 'a body under the threshold leaves no spill');
      assert.equal(getLiveSpillBytes(), 0);
    });

    it('spills above threshold_bytes and sends the body from the spill, which ends with the response', async () => {
      const config = configureSpool();
      const payload = responsePayload('x'.repeat(400));
      const upstreamBytes = new TextEncoder().encode(payload);
      assert.ok(upstreamBytes.byteLength > config.thresholdBytes, 'the fixture must cross the threshold');
      stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

      const response = await site.invoke(recordingLogger(false));

      // Unlike a converting branch, this one hands the body out still on the spool:
      // the spill is the live body until the client has read it.
      assert.equal(response.status, 200);
      assert.equal(spillFiles(config).length, 1);
      assert.equal(getLiveSpillBytes(), upstreamBytes.byteLength);

      const forwarded = new Uint8Array(await response.arrayBuffer());

      assert.equal(sha256(forwarded), sha256(upstreamBytes), 'the client must receive the upstream bytes');
      assert.deepEqual(spillFiles(config), [], 'the client reading the body must free the spill');
      assert.equal(getLiveSpillBytes(), 0);
    });

    it('fails loudly past max_response_bytes instead of truncating, and cancels the upstream body', async () => {
      const config = configureSpool({ maxResponseBytes: 200 });
      const src = source([new TextEncoder().encode(responsePayload('z'.repeat(1000)))]);
      const { calls } = stubUpstream(() => new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }));

      let caught: unknown;
      try {
        await site.invoke(recordingLogger(false));
      } catch (error) {
        caught = error;
      }

      assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
      assert.equal(caught.status, 500);
      assert.equal(caught.type, 'processing_error');
      assert.equal(calls(), 1);
      assert.equal(src.cancelled, true, 'the upstream body must be cancelled, not left flowing');
      assert.deepEqual(spillFiles(config), [], 'a rejected response leaves no partial spill');
      assert.equal(getLiveSpillBytes(), 0);
    });

    it('enforces max_response_bytes with the spool disabled, as the other egresses do', async () => {
      const config = configureSpool({ enabled: false, maxResponseBytes: 200 });
      const payload = responsePayload('d'.repeat(400));
      assert.ok(new TextEncoder().encode(payload).byteLength > config.maxResponseBytes);
      stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

      let caught: unknown;
      try {
        await site.invoke(recordingLogger(false));
      } catch (error) {
        caught = error;
      }

      // Deliberate: the receive replaced a whole-body forward, so the cap bounds
      // that receive and is not part of the spilling feature.
      assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
      assert.equal(caught.status, 500);
      assert.equal(caught.type, 'processing_error');
      assert.deepEqual(spillFiles(config), [], 'nothing may reach disk when spilling is off');
      assert.equal(getLiveSpillBytes(), 0);
    });

    it('traces the upstream bytes from the spool when tracing is on', async () => {
      const config = configureSpool();
      const payload = responsePayload('t'.repeat(400));
      const upstreamBytes = new TextEncoder().encode(payload);
      const logger = recordingLogger(true);
      stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

      const response = await site.invoke(logger);

      // The read that used to happen on every request now happens only for trace,
      // and it must still carry the raw upstream body.
      const stage = logger.traces.filter((line) => line.startsWith('[UPSTREAM-RESP] '));
      assert.equal(stage.length, 1, `expected one upstream-response body line, got ${JSON.stringify(logger.traces)}`);
      assert.match(stage[0], new RegExp(`^\\[UPSTREAM-RESP\\] ${site.upstreamUrl}: `));
      assert.equal(stage[0].slice(stage[0].indexOf(': ') + 2), payload, 'the traced body must be the upstream bytes');

      const forwarded = new Uint8Array(await response.arrayBuffer());
      assert.equal(sha256(forwarded), sha256(upstreamBytes), 'reading the spill for the trace must not alter the body');
      assert.deepEqual(spillFiles(config), [], 'the spill ends when the response is read out');
    });

    it('never charges the budget when nothing is read, and refuses a trace read one byte past it', async () => {
      const payload = responsePayload('b'.repeat(400));
      const upstreamBytes = new TextEncoder().encode(payload);
      const charge = Math.ceil(upstreamBytes.byteLength * 2);
      const config = configureSpool({ maxMaterializedBodyBytes: charge - 1 });
      assert.ok(upstreamBytes.byteLength > config.thresholdBytes, 'the fixture must spill, so a leak would be visible on disk');
      stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

      // Tracing off: no read, so a budget this body could not afford is never
      // consulted. A version that admitted every received body would 503 here.
      const served = await site.invoke(recordingLogger(false));
      assert.equal(served.status, 200);
      assert.equal(sha256(new Uint8Array(await served.arrayBuffer())), sha256(upstreamBytes));
      assert.equal(getAdmittedBytes(), 0);
      assert.deepEqual(spillFiles(config), []);

      // Tracing on: the same body needs the budget, and one byte short is a refusal
      // that leaves neither the spilled bytes nor a reservation behind.
      let caught: unknown;
      try {
        await site.invoke(recordingLogger(true));
      } catch (error) {
        caught = error;
      }

      assert.ok(caught instanceof AdmissionOverBudgetError, `expected AdmissionOverBudgetError, got ${String(caught)}`);
      assert.equal(caught.status, 503);
      assert.equal(caught.type, 'over_limit_error');
      assert.match(caught.message, /exceed max_materialized_body_bytes/);
      assert.deepEqual(spillFiles(config), [], 'a refused response must not leave its bytes on disk');
      assert.equal(getLiveSpillBytes(), 0);
      assert.equal(getAdmittedBytes(), 0, 'a refused response holds nothing on the ledger either');
    });
  });
}
