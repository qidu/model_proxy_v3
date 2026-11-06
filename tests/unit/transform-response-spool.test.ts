/**
 * Unit tests for the §5.7 bounded response receive on the two transform-hook
 * response paths (`src/utils/request-transform.ts`).
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.7, §5.9.
 *
 * `applyAfterUpstream` used to read its upstream body with `response.text()` and
 * parse the result, which held the whole body in RAM whatever the spool config
 * said. On a route that declares `after_upstream` ops this defeated the spool
 * twice over: the route's own transform materialized the body first, and the
 * handler's receive then ran its bound over the already-materialized text. It now
 * receives the body through `withResponseText` — the same primitive the converting
 * egresses use — so a body past `threshold_bytes` lives on disk while it is
 * transformed, is bounded by `max_response_bytes`, and charges the §5.9 budget for
 * the parse.
 *
 * The second block does the same for its mirror, `applyWriteoutBody` — the
 * `response_egress` hook that rewrites the body on its way *to the client*. Its
 * read is the same unbounded one, on the same shape of body, and it is the last
 * one left in this module. Two differences are pinned rather than blended: this
 * hook's own gate is a `hasHookOps('response_egress', …)` plus a
 * content-type check that `applyAfterUpstream` does not have (a non-JSON body is
 * returned untouched without being read at all), and its read is usually a
 * *second* receive of a body the caller already spooled — so above the threshold
 * it costs a second spill rather than saving RAM. What it buys is the bound, the
 * charge and a trace stage on this read too, which is what the tests assert.
 *
 * What these tests pin, and why each assertion is worth its space:
 *  - the answer is unchanged both under `threshold_bytes` and above it. The
 *    reference for the large body is the same call with spooling off, so equal
 *    answers mean the spool changed nothing about what the client receives;
 *  - a body over `threshold_bytes` really did live on disk while it was received —
 *    captured mid-receive, because this path releases the spill before it returns,
 *    so the end state alone cannot tell the two paths apart;
 *  - the body is read exactly once and never cloned: the receive exists so that no
 *    second copy of the body is held. The pull count is the read-once half, which
 *    the clone counter cannot see;
 *  - a body past `max_response_bytes` fails explicitly and cancels the upstream
 *    body rather than handing a truncated body to the transform's `JSON.parse`;
 *  - the cap applies with `[spool] enabled = false` too, which is the repository's
 *    stated rule (CHANGELOG: `max_response_bytes` bounds the body, `enabled` only
 *    decides whether disk is used) applied here as on the other egresses. It is
 *    asserted rather than assumed so a future change of that rule fails loudly;
 *  - the two fast paths still return the very same `Response` and never touch the
 *    body, so a route without `after_upstream` ops pays nothing for this change;
 *  - the SSE assembly builtin still assembles, and a non-JSON body is still passed
 *    through byte-for-byte with its upstream headers, now that both read the body
 *    through the receive;
 *  - a §5.9 refusal is reported as itself (503 `over_limit_error`), not swallowed,
 *    and a refused or aborted receive releases its spill and its queue slot;
 *  - the newly threaded `HookContext.signal` really reaches §5.9: an aborted client
 *    drops its queued waiter instead of holding its place until
 *    `admission_timeout_ms`. The client request's signal is the one threaded —
 *    `src/handlers/messages.ts` and `src/handlers/openai.ts` pass
 *    `request.signal` / `originalRequest.signal`, matching the existing
 *    `receiveJsonResponse(..., request.signal)` convention, rather than the
 *    upstream *timeout* signal, which is a different thing. These tests hand
 *    `ctx.signal` in directly and so pin the hook's side of that contract; the
 *    central wrap in `src/index.ts` that fills `writeoutCtx` is a call site, read
 *    rather than driven from here, exactly as `applyAfterUpstream`'s handler call
 *    sites are.
 *
 * Deliberately out of scope, and left as they are: the `!response.ok` error-body
 * reads beside the five call sites, which are a separate repo-wide increment, and
 * the pre-existing 5-arg vs 4-arg `applyTransformSet` asymmetry between the two
 * branches below, which is preserved rather than blended.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyAfterUpstream, applyWriteoutBody, type HookContext } from '../../src/utils/request-transform.js';
import type { Logger } from '../../src/utils/logger.js';
import { createLogger } from '../../src/utils/logger.js';
import type { TransformSet, ModelRouteConfig } from '../../src/utils/config-loader.js';
import { SpoolResponseTooLargeError } from '../../src/utils/spool-response.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { SPOOL_DEFAULTS, responseSpillDir, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';
import {
  AdmissionOverBudgetError,
  admitMaterialization,
  getAdmissionQueueDepth,
  getAdmittedBytes,
} from '../../src/utils/spool-admission.js';

const REQUEST_ID = 'req-transform-response';
const LOGGER: Logger = createLogger({});

afterEach(() => {
  setSpoolConfig(SPOOL_DEFAULTS);
  // Both ledgers are process-wide: a leak here would silently weaken later tests.
  assert.equal(getLiveSpillBytes(), 0, 'every spool must return its reservation');
  assert.equal(getAdmittedBytes(), 0, 'every §5.9 lease must be released');
  assert.equal(getAdmissionQueueDepth(), 0, 'no waiter may outlive its test');
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
  const dir = mkdtempSync(join(tmpdir(), 'transform-response-test-'));
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

/** Names of the response spill files currently on disk. */
function spillFiles(config: SpoolConfig): string[] {
  return existsSync(responseSpillDir(config)) ? readdirSync(responseSpillDir(config)) : [];
}

/** Strip `model`: the op both branches below are asked to apply. */
const STRIP_MODEL: TransformSet = {
  name: 'strip_model',
  schema: 'openai-completions',
  after_upstream: { ops: [{ op: 'remove', path: 'model' }] },
};

/** The same op, declared at the client-egress hook `applyWriteoutBody` runs. */
const STRIP_MODEL_EGRESS: TransformSet = {
  name: 'strip_model_egress',
  schema: 'openai-completions',
  response_egress: { ops: [{ op: 'remove', path: 'model' }] },
};

const ASSEMBLE_SSE: TransformSet = {
  name: 'sse_to_completions',
  schema: 'openai-completions',
  after_upstream: { builtins: ['assemble_sse_chunks'] },
};

const UNRELATED: TransformSet = {
  name: 'before_only',
  schema: 'openai-completions',
  before_upstream: { ops: [{ op: 'remove', path: 'max_tokens' }] },
};

function makeRoute(transforms: TransformSet[]): ModelRouteConfig {
  return {
    targetUrl: 'https://example.com',
    upstreamMode: 'openai-completions',
    transforms,
  };
}

function makeCtx(
  transforms: TransformSet[],
  signal?: AbortSignal,
  hook: HookContext['hook'] = 'after_upstream',
): HookContext {
  return {
    hook,
    route: makeRoute(transforms),
    upstreamMode: 'openai-completions',
    clientModel: 'test-model',
    requestId: REQUEST_ID,
    streaming: false,
    logger: LOGGER,
    signal,
  };
}

/**
 * An upstream answer the transform can act on, whose `note` field carries the
 * marker. `note` is not one of the fields any op here touches, so it survives the
 * transform and its size is what crosses the thresholds.
 */
function answer(marker: string): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: 'upstream-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    note: marker,
  };
}

/** `answer(marker)` with the op applied, i.e. what the transform must produce. */
function expected(marker: string): Record<string, unknown> {
  const body = answer(marker);
  delete body['model'];
  return body;
}

function jsonResponse(payload: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

/** An SSE body that `assemble_sse_chunks` turns into one `chat.completion`. */
function sseText(marker: string): string {
  const lines = [
    { id: 'chatcmpl-sse', object: 'chat.completion.chunk', created: 1700, model: 'upstream-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: marker }, finish_reason: null }] },
    { id: 'chatcmpl-sse', object: 'chat.completion.chunk', created: 1700, model: 'upstream-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    'data: [DONE]',
  ];
  return lines
    .map((line) => (typeof line === 'string' ? `${line}\n\n` : `data: ${JSON.stringify(line)}\n\n`))
    .join('');
}

interface Sourced {
  stream: ReadableStream<Uint8Array>;
  cancelled: boolean;
  /** Chunk indices the receive asked for, so a second read would be visible. */
  pulls: number[];
}

/**
 * An upstream body we can watch being cancelled and pulled chunk by chunk.
 * `onPull(i)` runs when the proxy asks for chunk `i`, i.e. after chunks `0…i-1`
 * have been read and written to the spill.
 */
function source(chunks: Uint8Array[], onPull?: (index: number) => void): Sourced {
  let index = 0;
  const state: Sourced = { cancelled: false, pulls: [], stream: null as unknown as ReadableStream<Uint8Array> };
  state.stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulls.push(index);
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

/** Split an encoded body in two, so a spill cannot be the declared-length path. */
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

function streamedResponse(src: Sourced, contentType: string, extraHeaders: Record<string, string> = {}): Response {
  return new Response(src.stream, { headers: { 'Content-Type': contentType, ...extraHeaders } });
}

/**
 * Count `Response.prototype.clone()` calls while `run` executes: the bounded
 * receive exists so that no second copy of the body is ever held.
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

/** Run `run` and return whatever it threw, so an assertion can name the error. */
async function caughtFrom(run: () => Promise<unknown>): Promise<any> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Resolve once `ready()` holds, or throw after a bounded number of turns. */
async function waitFor(ready: () => boolean): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (ready()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('waitFor: condition never held');
}

// ---------------------------------------------------------------------------
// §5.7: the fast paths must not touch the body at all
// ---------------------------------------------------------------------------

describe('applyAfterUpstream fast paths (§5.7)', () => {
  it('returns the same Response when no route declares after_upstream ops, without reading it', async () => {
    const config = configureSpool();
    // Spool-disabled too: the fast path must not even consult the config, which
    // the pull count below shows — a read here would have consumed the source.
    configureSpool({ enabled: false });
    const payload = answer('x'.repeat(400));
    const src = source(twoChunks(JSON.stringify(payload)));
    const original = streamedResponse(src, 'application/json');

    const result = await applyAfterUpstream(original, makeCtx([UNRELATED]));

    assert.equal(result, original, 'the exact same Response reference, op-free');
    assert.deepEqual(src.pulls, [], 'the fast path must not read a byte');
    assert.equal(src.cancelled, false);
    assert.deepEqual(await result.json(), payload, 'and the body is still there for the caller');
    assert.deepEqual(spillFiles(config), []);
  });

  it('returns the same Response when the route has no transforms array', async () => {
    configureSpool();
    const src = source(twoChunks(JSON.stringify(answer('ok'))));
    const original = streamedResponse(src, 'application/json');

    const result = await applyAfterUpstream(original, makeCtx([]));

    assert.equal(result, original);
    assert.deepEqual(src.pulls, []);
  });
});

// ---------------------------------------------------------------------------
// §5.7: bounded receive, spill, cap
// ---------------------------------------------------------------------------

describe('applyAfterUpstream bounded receive (§5.7)', () => {
  it('answers a body under threshold_bytes without touching the spool or cloning it', async () => {
    const config = configureSpool({ thresholdBytes: 4096 });
    const payload = answer('ok');
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength < config.thresholdBytes);
    const src = source(twoChunks(JSON.stringify(payload)));

    const { result: response, clones } = await countClones(() =>
      applyAfterUpstream(streamedResponse(src, 'application/json'), makeCtx([STRIP_MODEL])),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected('ok'));
    assert.deepEqual(spillFiles(config), [], 'a body under the threshold leaves no spill');
    assert.equal(clones, 0, 'the proxy must not hold a second copy of the body');
    assert.equal(getAdmittedBytes(), 0, 'the lease is given back before the body is returned');
  });

  it('spills a body above threshold_bytes, applies the ops, and frees the spill before returning', async () => {
    const marker = 'x'.repeat(400);
    const payload = answer(marker);
    const chunks = twoChunks(JSON.stringify(payload));

    // The reference is the same call with spooling off: the two runs differ in
    // nothing but the spool, so equal answers mean the spool changed nothing.
    configureSpool({ enabled: false });
    const baselineSrc = source(twoChunks(JSON.stringify(payload)));
    const baseline = await (await applyAfterUpstream(
      streamedResponse(baselineSrc, 'application/json'),
      makeCtx([STRIP_MODEL]),
    )).text();
    assert.deepEqual(JSON.parse(baseline), expected(marker));

    // Captured after the baseline run, because every `configureSpool` call makes a
    // fresh directory: this is the config whose `responses/` the spill lands in.
    const config = configureSpool();
    assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the first chunk must cross the threshold');

    const seen: Array<{ files: number; bytes: number }> = [];
    const src = source(chunks, (index) => {
      seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
      if (index > 2) throw new Error(`receive asked for too many chunks: ${index}`);
    });

    const { result: response, clones } = await countClones(() =>
      applyAfterUpstream(streamedResponse(src, 'application/json'), makeCtx([STRIP_MODEL])),
    );

    // The spill is the live body while it is received: by the time the proxy asks
    // for the second chunk, the first is on disk and charged.
    assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'the received prefix must be on disk, charged');
    // And it is gone before the caller sees the response: this path reads once and
    // returns a new Response, so holding the spool past that point would leak.
    assert.deepEqual(spillFiles(config), [], 'the spill must be released before the response is returned');
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(await response.text()), JSON.parse(baseline), 'the spool must not change the answer');
    assert.equal(clones, 0);
    assert.equal(getAdmittedBytes(), 0);
    // Read exactly once: one pull per chunk, plus the pull that closes the source.
    assert.deepEqual(src.pulls, [0, 1, 2], 'the body must be read exactly once, start to close');
  });

  it('fails loudly past max_response_bytes and cancels the upstream body', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const payload = answer('z'.repeat(400));
    // 160-byte slices: the first crosses `threshold_bytes` (64) but not the cap,
    // so a spill file really exists when the second slice breaches it — the state
    // the failure path has to clean up.
    const chunks = slices(JSON.stringify(payload), 160);
    assert.ok(chunks[0].byteLength > config.thresholdBytes && chunks[0].byteLength <= config.maxResponseBytes);
    assert.ok(chunks[0].byteLength + chunks[1].byteLength > config.maxResponseBytes);
    const seen: Array<{ files: number; bytes: number }> = [];
    const src = source(chunks, (index) => {
      seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
    });

    const caught = await caughtFrom(() =>
      applyAfterUpstream(streamedResponse(src, 'application/json'), makeCtx([STRIP_MODEL])),
    );

    assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'a spill must have been live when the cap was breached');
    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.status, 500, 'the client sent a legal request: not a 4xx');
    assert.equal(caught.type, 'processing_error');
    assert.match(caught.message, /too large/);
    assert.equal(src.cancelled, true, 'the upstream body must be cancelled, not left flowing');
    assert.deepEqual(spillFiles(config), [], 'a rejected response removes its partial spill');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('enforces max_response_bytes with the spool disabled, as the other egresses do', async () => {
    const config = configureSpool({ enabled: false, maxResponseBytes: 256 });
    const payload = answer('c'.repeat(400));
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength > config.maxResponseBytes);

    const caught = await caughtFrom(() =>
      applyAfterUpstream(jsonResponse(payload), makeCtx([STRIP_MODEL])),
    );

    // Deliberate, and the one behaviour change for an operator who never enabled
    // the spool: this receive replaced the whole-body read outright, so the cap
    // bounds that read and is not part of the spilling feature. Transforming the
    // body instead would mean holding it twice in RAM — the cost the cap exists
    // to refuse.
    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.status, 500);
    assert.equal(caught.type, 'processing_error');
    assert.deepEqual(spillFiles(config), [], 'nothing may reach disk when spilling is off');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('keeps the response status and upstream headers on the rebuilt answer', async () => {
    const config = configureSpool();
    const marker = 'h'.repeat(400);
    const src = source(twoChunks(JSON.stringify(answer(marker))));
    const response = new Response(src.stream, {
      status: 201,
      statusText: 'Created',
      headers: { 'Content-Type': 'application/json', 'x-upstream-trace': 'abc', 'content-encoding': 'gzip' },
    });

    const result = await applyAfterUpstream(response, makeCtx([STRIP_MODEL]));

    assert.equal(result.status, 201);
    assert.equal(result.statusText, 'Created');
    assert.equal(result.headers.get('x-upstream-trace'), 'abc', 'upstream headers other than the length/encoding pair survive');
    assert.equal(result.headers.get('content-encoding'), null, 'a rebuilt body must not claim the upstream encoding');
    assert.equal(result.headers.get('content-length'), null, 'nor the upstream length');
    assert.deepEqual(JSON.parse(await result.text()), expected(marker));
    assert.ok(new TextEncoder().encode(JSON.stringify(answer(marker))).byteLength > config.thresholdBytes);
    assert.deepEqual(spillFiles(config), []);
  });
});

// ---------------------------------------------------------------------------
// The two branches the receive now wraps
// ---------------------------------------------------------------------------

describe('applyAfterUpstream branches through the receive (§5.7)', () => {
  it('still assembles an SSE body, with that body received through the spool', async () => {
    const config = configureSpool();
    const marker = 's'.repeat(300);
    const text = sseText(marker);
    const chunks = twoChunks(text);
    assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the fixture must spill');

    const seen: Array<{ files: number; bytes: number }> = [];
    const src = source(chunks, (index) => {
      seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
    });

    const { result: response, clones } = await countClones(() =>
      applyAfterUpstream(streamedResponse(src, 'text/event-stream'), makeCtx([ASSEMBLE_SSE])),
    );

    assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'an SSE body is received through the spool too');
    assert.equal(response.headers.get('content-type'), 'application/json', 'assembly re-labels the body');
    const body = await response.json() as Record<string, unknown>;
    assert.equal(body['object'], 'chat.completion');
    assert.equal(body['id'], 'chatcmpl-sse');
    assert.equal(body['model'], 'upstream-model', 'the assemble branch runs its ops with the 5-arg form and keeps model');
    const choices = body['choices'] as Array<Record<string, unknown>>;
    assert.equal((choices[0]['message'] as Record<string, unknown>)['content'], marker, 'the whole stream must survive');
    assert.equal(choices[0]['finish_reason'], 'stop');
    assert.equal(clones, 0);
    assert.deepEqual(spillFiles(config), [], 'the spill is released before the assembled body is returned');
  });

  it('passes a non-JSON body through byte-for-byte, now that the receive reads it', async () => {
    const config = configureSpool();
    const text = `not json at all, ${'n'.repeat(300)}`;
    const chunks = twoChunks(text);
    assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the fixture must spill');

    const seen: Array<{ files: number; bytes: number }> = [];
    const src = source(chunks, (index) => {
      seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
    });
    const response = new Response(src.stream, {
      status: 200,
      headers: { 'Content-Type': 'text/plain', 'content-length': String(new TextEncoder().encode(text).byteLength) },
    });

    const { result, clones } = await countClones(() => applyAfterUpstream(response, makeCtx([STRIP_MODEL])));

    assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'a non-JSON body is received through the spool too');
    assert.equal(await result.text(), text, 'a body that is not JSON is passed through unchanged');
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-length'), null);
    assert.equal(clones, 0);
    assert.deepEqual(spillFiles(config), []);
  });

  it('passes an SSE body through unchanged when the route declares no assemble_sse_chunks', async () => {
    configureSpool();
    const text = sseText('plain');
    const src = source(twoChunks(text));

    const result = await applyAfterUpstream(streamedResponse(src, 'text/event-stream'), makeCtx([STRIP_MODEL]));

    assert.equal(await result.text(), text, 'without the builtin an SSE body is not JSON and is not touched');
    assert.equal(result.headers.get('content-type'), 'text/event-stream');
  });
});

// ---------------------------------------------------------------------------
// §5.9: the budget and the client abort the receive now charges
// ---------------------------------------------------------------------------

describe('applyAfterUpstream §5.9 admission (§5.9)', () => {
  it('refuses a body one nominal byte past the budget, leaving no spill and no reservation', async () => {
    const upstream = answer('b'.repeat(400));
    const bodyBytes = new TextEncoder().encode(JSON.stringify(upstream)).byteLength;
    const config = configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2) - 1 });
    assert.ok(bodyBytes > config.thresholdBytes, 'the fixture must spill, so a leak here would be visible on disk');
    const src = source(twoChunks(JSON.stringify(upstream)));

    const caught = await caughtFrom(() =>
      applyAfterUpstream(streamedResponse(src, 'application/json'), makeCtx([STRIP_MODEL])),
    );

    // A refused body is a spool limit, never a transform failure: the body may be
    // perfectly good JSON. Nothing here catches it, so it reaches the caller's
    // error handling as itself (503 `over_limit_error`).
    assert.ok(caught instanceof AdmissionOverBudgetError, `expected AdmissionOverBudgetError, got ${String(caught)}`);
    assert.equal(caught.status, 503);
    assert.equal(caught.type, 'over_limit_error', 'the type the client switches on');
    assert.match(caught.message, /exceed max_materialized_body_bytes/);
    assert.deepEqual(src.pulls, [0, 1, 2], 'the charge is the received byte count, so the body was received first');
    assert.deepEqual(spillFiles(config), [], 'a refused body must not leave its bytes on disk');
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(getAdmittedBytes(), 0, 'a refusal must not keep its queue slot');
  });

  it('admits the body that fits, applies the ops, and gives the bytes back', async () => {
    const upstream = answer('ok');
    const bodyBytes = new TextEncoder().encode(JSON.stringify(upstream)).byteLength;
    configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2) });

    const result = await applyAfterUpstream(jsonResponse(upstream), makeCtx([STRIP_MODEL]));

    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), expected('ok'));
    assert.equal(getAdmittedBytes(), 0, 'the lease is given back before the body is returned');
  });

  it('drops a queued waiter when the client aborts, keeping nothing on disk', async () => {
    const upstream = answer('q'.repeat(300));
    const bodyBytes = new TextEncoder().encode(JSON.stringify(upstream)).byteLength;
    // Room for exactly one body at factor 2, so the second has to queue.
    const config = configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2), admissionTimeoutMs: 60_000 });
    const held = await admitMaterialization(bodyBytes);

    const controller = new AbortController();
    const src = source(twoChunks(JSON.stringify(upstream)));
    const pending = applyAfterUpstream(streamedResponse(src, 'application/json'), makeCtx([STRIP_MODEL], controller.signal));
    // The receive reads the body before it charges for it, so the raw bytes are on
    // disk while the body waits — nothing is materialized until it is admitted.
    await waitFor(() => getAdmissionQueueDepth() === 1);

    const caught = await new Promise<unknown>((resolve) => {
      pending.then(() => resolve(undefined), resolve);
      controller.abort();
    });

    assert.equal(caught?.name, 'AbortError', `expected the abort to surface, got ${String(caught)}`);
    assert.equal(getAdmissionQueueDepth(), 0, 'an aborted waiter must leave the queue at once');
    assert.deepEqual(spillFiles(config), [], 'an abandoned receive must give its spill back');
    assert.equal(getLiveSpillBytes(), 0, 'the raw bytes were on disk while it waited, and are gone now');
    assert.ok(getAdmittedBytes() > 0, 'the holder still owns its bytes');
    held.release();
  });

  it('refuses to materialize for an already-aborted client, giving the spill back', async () => {
    const config = configureSpool({ maxMaterializedBodyBytes: 1 << 20 });
    const controller = new AbortController();
    controller.abort();
    const src = source(twoChunks(JSON.stringify(answer('a'.repeat(400)))));

    const caught = await caughtFrom(() =>
      applyAfterUpstream(streamedResponse(src, 'application/json'), makeCtx([STRIP_MODEL], controller.signal)),
    );

    assert.equal(caught?.name, 'AbortError', `expected the abort to surface, got ${String(caught)}`);
    // The body is received before it is charged, so it *was* read; what must not
    // happen is a materialization or a spill left behind.
    assert.deepEqual(spillFiles(config), [], 'an aborted receive must give its spill back');
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(getAdmittedBytes(), 0);
  });
});

// ---------------------------------------------------------------------------
// §5.7: the client-egress hook (`applyWriteoutBody`) goes through the same receive
// ---------------------------------------------------------------------------

/** Every call below declares ops at the hook this function serves. */
function egressCtx(transforms: TransformSet[], signal?: AbortSignal): HookContext {
  return makeCtx(transforms, signal, 'response_egress');
}

describe('applyWriteoutBody fast paths (§5.7)', () => {
  it('returns the same Response when no route declares response_egress ops, without reading it', async () => {
    const config = configureSpool();
    // Spool-disabled as well: the gate is the transform list, and this hook must
    // not consult the spool config on a route that declares nothing for it.
    configureSpool({ enabled: false });
    const src = source(twoChunks(JSON.stringify(answer('x'.repeat(400)))));
    const original = streamedResponse(src, 'application/json');

    const result = await applyWriteoutBody(original, egressCtx([UNRELATED]));

    assert.equal(result, original, 'the exact same Response reference, op-free');
    assert.deepEqual(src.pulls, [], 'the fast path must not read a byte');
    assert.equal(src.cancelled, false);
    assert.deepEqual(await result.json(), answer('x'.repeat(400)), 'and the body is still there for the client');
    assert.deepEqual(spillFiles(config), []);
  });

  it('returns the same Response untouched when the body is not JSON, ops declared or not', async () => {
    const config = configureSpool();
    const text = sseText('s');
    const src = source(twoChunks(text));
    const original = streamedResponse(src, 'text/event-stream');

    const result = await applyWriteoutBody(original, egressCtx([STRIP_MODEL_EGRESS]));

    // The content-type gate is this hook's own and sits before the receive: an
    // SSE body is the per-event path's business (`pipeEventTransformer`), so this
    // function must not buffer one — not even to hand it straight back.
    assert.equal(result, original);
    assert.deepEqual(src.pulls, [], 'a non-JSON body must not be read at all');
    assert.deepEqual(spillFiles(config), []);
  });
});

describe('applyWriteoutBody bounded receive (§5.7)', () => {
  it('answers a body under threshold_bytes without touching the spool or cloning it', async () => {
    const config = configureSpool({ thresholdBytes: 4096 });
    const payload = answer('ok');
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength < config.thresholdBytes);
    const src = source(twoChunks(JSON.stringify(payload)));

    const { result: response, clones } = await countClones(() =>
      applyWriteoutBody(streamedResponse(src, 'application/json'), egressCtx([STRIP_MODEL_EGRESS])),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), expected('ok'));
    assert.deepEqual(spillFiles(config), [], 'a body under the threshold leaves no spill');
    assert.equal(clones, 0, 'the proxy must not hold a second copy of the body');
    assert.equal(getAdmittedBytes(), 0, 'the lease is given back before the body is returned');
  });

  it('spills a body above threshold_bytes, applies the ops, and frees the spill before returning', async () => {
    const marker = 'w'.repeat(400);
    const payload = answer(marker);
    const chunks = twoChunks(JSON.stringify(payload));

    // The reference is the same call with spooling off: the two runs differ in
    // nothing but the spool, so equal answers mean the spool changed nothing.
    configureSpool({ enabled: false });
    const baselineText = await (await applyWriteoutBody(
      streamedResponse(source(twoChunks(JSON.stringify(payload))), 'application/json'),
      egressCtx([STRIP_MODEL_EGRESS]),
    )).text();
    assert.deepEqual(JSON.parse(baselineText), expected(marker));

    // Captured after the baseline run, because every `configureSpool` call makes a
    // fresh directory: this is the config whose `responses/` the spill lands in.
    const config = configureSpool();
    assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the first chunk must cross the threshold');

    const seen: Array<{ files: number; bytes: number }> = [];
    const src = source(chunks, (index) => {
      seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
      if (index > 2) throw new Error(`receive asked for too many chunks: ${index}`);
    });

    const { result: response, clones } = await countClones(() =>
      applyWriteoutBody(streamedResponse(src, 'application/json'), egressCtx([STRIP_MODEL_EGRESS])),
    );

    assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'the received prefix must be on disk, charged');
    assert.deepEqual(spillFiles(config), [], 'the spill must be released before the response is returned');
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.deepEqual(JSON.parse(await response.text()), JSON.parse(baselineText), 'the spool must not change the answer');
    assert.equal(clones, 0);
    assert.equal(getAdmittedBytes(), 0);
    // Read exactly once: one pull per chunk, plus the pull that closes the source.
    assert.deepEqual(src.pulls, [0, 1, 2], 'the body must be read exactly once, start to close');
  });

  it('fails loudly past max_response_bytes and cancels the body it was reading', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const payload = answer('z'.repeat(400));
    // 160-byte slices: the first crosses `threshold_bytes` (64) but not the cap,
    // so a spill file really exists when the second slice breaches it — the state
    // the failure path has to clean up.
    const chunks = slices(JSON.stringify(payload), 160);
    assert.ok(chunks[0].byteLength > config.thresholdBytes && chunks[0].byteLength <= config.maxResponseBytes);
    assert.ok(chunks[0].byteLength + chunks[1].byteLength > config.maxResponseBytes);
    const seen: Array<{ files: number; bytes: number }> = [];
    const src = source(chunks, (index) => {
      seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
    });

    const caught = await caughtFrom(() =>
      applyWriteoutBody(streamedResponse(src, 'application/json'), egressCtx([STRIP_MODEL_EGRESS])),
    );

    assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'a spill must have been live when the cap was breached');
    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.status, 500, 'the client sent a legal request: not a 4xx');
    assert.equal(caught.type, 'processing_error');
    assert.match(caught.message, /too large/);
    assert.equal(src.cancelled, true, 'the body this hook was rewriting must be cancelled, not left flowing');
    assert.deepEqual(spillFiles(config), [], 'a rejected response removes its partial spill');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('enforces max_response_bytes with the spool disabled, as the sibling hook does', async () => {
    const config = configureSpool({ enabled: false, maxResponseBytes: 256 });
    const payload = answer('c'.repeat(400));
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength > config.maxResponseBytes);

    const caught = await caughtFrom(() =>
      applyWriteoutBody(jsonResponse(payload), egressCtx([STRIP_MODEL_EGRESS])),
    );

    // Same rule as `applyAfterUpstream` and the rest of the egresses: the cap
    // bounds the read, `enabled` only decides whether disk is used. Asserted so a
    // future change of that rule fails loudly here too.
    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.status, 500);
    assert.equal(caught.type, 'processing_error');
    assert.deepEqual(spillFiles(config), [], 'nothing may reach disk when spilling is off');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('passes a malformed JSON body through byte-for-byte, now that the receive reads it', async () => {
    const config = configureSpool();
    const text = `not json at all, ${'m'.repeat(300)}`;
    const chunks = twoChunks(text);
    assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the fixture must spill');

    const seen: Array<{ files: number; bytes: number }> = [];
    const src = source(chunks, (index) => {
      seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
    });
    const response = new Response(src.stream, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'content-length': String(new TextEncoder().encode(text).byteLength) },
    });

    const { result, clones } = await countClones(() => applyWriteoutBody(response, egressCtx([STRIP_MODEL_EGRESS])));

    assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'the parse branch is behind the receive');
    assert.equal(await result.text(), text, 'a body that is not JSON is handed back unchanged');
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('content-length'), null, 'nor the upstream length, which the spill invalidates');
    assert.equal(clones, 0);
    assert.deepEqual(spillFiles(config), []);
  });
});

// ---------------------------------------------------------------------------
// §5.9: the budget and the client abort the client-egress receive charges
// ---------------------------------------------------------------------------

describe('applyWriteoutBody §5.9 admission (§5.9)', () => {
  it('refuses a body one nominal byte past the budget, leaving no spill and no reservation', async () => {
    const upstream = answer('b'.repeat(400));
    const bodyBytes = new TextEncoder().encode(JSON.stringify(upstream)).byteLength;
    const config = configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2) - 1 });
    assert.ok(bodyBytes > config.thresholdBytes, 'the fixture must spill, so a leak here would be visible on disk');
    const src = source(twoChunks(JSON.stringify(upstream)));

    const caught = await caughtFrom(() =>
      applyWriteoutBody(streamedResponse(src, 'application/json'), egressCtx([STRIP_MODEL_EGRESS])),
    );

    // A refused body is a spool limit, never a transform failure: the body may be
    // perfectly good JSON. Nothing here catches it, and `src/index.ts`'s writeout
    // wrap does not either, so it reaches the handler's terminal catch as itself
    // (503 `over_limit_error`) rather than as a transform error.
    assert.ok(caught instanceof AdmissionOverBudgetError, `expected AdmissionOverBudgetError, got ${String(caught)}`);
    assert.equal(caught.status, 503);
    assert.equal(caught.type, 'over_limit_error', 'the type the client switches on');
    assert.match(caught.message, /exceed max_materialized_body_bytes/);
    assert.deepEqual(src.pulls, [0, 1, 2], 'the charge is the received byte count, so the body was received first');
    assert.deepEqual(spillFiles(config), [], 'a refused body must not leave its bytes on disk');
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(getAdmittedBytes(), 0, 'a refusal must not keep its queue slot');
  });

  it('drops a queued client-egress waiter when the client aborts, keeping nothing on disk', async () => {
    const upstream = answer('q'.repeat(300));
    const bodyBytes = new TextEncoder().encode(JSON.stringify(upstream)).byteLength;
    // Room for exactly one body at factor 2, so the second has to queue.
    const config = configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2), admissionTimeoutMs: 60_000 });
    const held = await admitMaterialization(bodyBytes);

    const controller = new AbortController();
    const src = source(twoChunks(JSON.stringify(upstream)));
    const pending = applyWriteoutBody(streamedResponse(src, 'application/json'), egressCtx([STRIP_MODEL_EGRESS], controller.signal));
    // The receive reads the body before it charges for it, so the raw bytes are on
    // disk while the body waits — nothing is materialized until it is admitted.
    await waitFor(() => getAdmissionQueueDepth() === 1);

    const caught = await new Promise<unknown>((resolve) => {
      pending.then(() => resolve(undefined), resolve);
      controller.abort();
    });

    assert.equal(caught?.name, 'AbortError', `expected the abort to surface, got ${String(caught)}`);
    assert.equal(getAdmissionQueueDepth(), 0, 'an aborted waiter must leave the queue at once');
    assert.deepEqual(spillFiles(config), [], 'an abandoned receive must give its spill back');
    assert.equal(getLiveSpillBytes(), 0, 'the raw bytes were on disk while it waited, and are gone now');
    assert.ok(getAdmittedBytes() > 0, 'the holder still owns its bytes');
    held.release();
  });
});
