/**
 * Unit tests for the §5.7 response reads of the three model-listing readers in
 * `src/handlers/models.ts`.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.7, §5.9.
 *
 * All three read their upstream body whole and then parsed it, so nothing bounded
 * what an upstream could send on:
 *  - `getModelCount` — the `/health` path's count, which reads the body only to
 *    throw it away and keep `data.length`;
 *  - `handleModelsRequest` — `GET /v1/models`, whose merged list is the answer;
 *  - `handleAnthropicModelsDiscovery` — the `?limit=1000` Anthropic-shaped
 *    discovery, which transforms and filters the list.
 * All three now go through `receiveJsonResponse`, the same bounded receive the
 * converting egresses use.
 *
 * The three differ in where a failure lands, and that difference is what most of
 * this file is about — each of these readers sits inside a catch-all that already
 * had a job, so the receive had to be threaded through it rather than replace it:
 *  - `getModelCount` answers `{ count: 0, cached: false }` for *any* failure, and
 *    its only caller (`src/index.ts:997`) answers a count of 0 with its usual 404
 *    (`src/index.ts:1013`). That catch-all is left intact: a cap breach is logged
 *    at error level but still reaches the client as a 404 it cannot tell from an
 *    upstream that listed nothing. Pinned below as the disclosed degradation it
 *    is, not as a property worth having.
 *  - `handleModelsRequest` degrades to its config-only list on a body it cannot
 *    parse, which is deliberate. A *cap*, a spill write failure or a §5.9 refusal
 *    is not a parse failure, so those leave through `createErrorResponse` as
 *    themselves; letting the catch-all take them would turn a proxy limit into a
 *    silently smaller model list (rule #8).
 *  - `handleAnthropicModelsDiscovery` answers a malformed body with its existing
 *    500 `internal_error`, and a cap or a refusal as itself for the same reason.
 *
 * What these tests pin, and why each assertion is worth its space:
 *  - each of the three really is bounded: a body over `threshold_bytes` lived on
 *    disk while it was received — captured mid-receive, because the spill is
 *    released before the reader answers, so the end state alone cannot tell a
 *    spooled read from a whole-body one;
 *  - the answer is byte-identical to the same request with spooling off, and the
 *    large list really did survive (a reader that dropped the body would pass a
 *    naive comparison of two degraded answers);
 *  - a body past `max_response_bytes` cancels the upstream body and leaves no
 *    partial spill, in both failure families;
 *  - the malformed-body answer each handler already gave is unchanged, and the
 *    spill is released on that path too;
 *  - a §5.9 refusal is reported as itself (503 `over_limit_error`) at the two
 *    sites that answer a `Response`, never as the handler's own fallback;
 *  - `Response.prototype.clone()` is never called: a bounded receive exists so
 *    that no second copy of the body is held.
 *
 * The `!response.ok` upstream *error* reads beside two of these sites
 * (`handleModelsRequest`, `handleAnthropicModelsDiscovery`) are bounded the same
 * way and pinned at the end of this file: an error body used to be the one body
 * these handlers read whole. A cap breach on it now answers the limit as itself
 * instead of leaving each catch-all to absorb it into its own smaller answer.
 */

import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearModelCache,
  getModelCount,
  handleAnthropicModelsDiscovery,
  handleModelsRequest,
} from '../../src/handlers/models.js';
import type { Logger } from '../../src/utils/logger.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { SPOOL_DEFAULTS, responseSpillDir, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';
import { getAdmittedBytes } from '../../src/utils/spool-admission.js';

const realFetch = globalThis.fetch;
const REQUEST_ID = 'req-models-response';
const AUTH = { Authorization: 'Bearer upstream-key' };
const ENV = { LOG_LEVEL: 'error' } as Record<string, unknown>;
const DISCOVERY_ENV = { LOG_LEVEL: 'error', CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' } as Record<string, unknown>;
const MODELS_TARGET = 'https://upstream.test/v1/models';
const LOGGER = captureLogger().logger;

beforeEach(() => {
  // Every reader here shares one process-wide model cache, and two of them read it
  // before they fetch: a stale entry would make a test pass without a receive.
  clearModelCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearModelCache();
  setSpoolConfig(SPOOL_DEFAULTS);
  // Both ledgers are process-wide: a leak here would silently weaken later tests.
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
  const dir = mkdtempSync(join(tmpdir(), 'models-response-test-'));
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

/**
 * A logger that records the messages it is told, so a reader whose catch-all
 * absorbs a failure can still be held to reporting it.
 */
function captureLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = [];
  const logger: Logger = {
    traceEnabled: false,
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error(_requestId: string, message: string) { errors.push(message); },
  };
  return { logger, errors };
}

/** An OpenAI-shaped model list whose `ids` are the caller's. */
function modelPayload(ids: string[]): Record<string, unknown> {
  return {
    object: 'list',
    data: ids.map((id, index) => ({ id, object: 'model', created: 1700000000, owned_by: 'upstream', index })),
  };
}

/** A `GET /v1/models` client request, unpaginated so the cache path is exercised. */
function modelsRequest(): Request {
  return new Request('https://proxy.test/v1/models');
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
}

interface Sourced {
  stream: ReadableStream<Uint8Array>;
  cancelled: boolean;
}

/**
 * An upstream body we can watch being cancelled, and whose receive we can inspect
 * chunk by chunk. `onPull(i)` runs when the proxy asks for chunk `i`, i.e. after
 * chunks `0…i-1` have been read and written to the spill.
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

/** Stub global fetch, counting calls and answering with `respond()`. */
function stubUpstream(respond: () => Response): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return respond();
  }) as typeof fetch;
  return { calls: () => calls };
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

/** A streamed upstream body carrying `payload`, as a `Response`. */
function streamedResponse(payload: string): Response {
  return new Response(source(twoChunks(payload)).stream, { headers: { 'Content-Type': 'application/json' } });
}

/**
 * Count `Response.prototype.clone()` calls while `run` executes: a bounded
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

/** A reader's answer in a comparable shape: a `Response` becomes its status and text. */
async function settle(value: unknown): Promise<unknown> {
  if (value instanceof Response) return { status: value.status, body: await value.text() };
  return value;
}

// ---------------------------------------------------------------------------
// The three readers
// ---------------------------------------------------------------------------

interface Site {
  name: string;
  /** Model ids for a payload whose bare marker is `marker`. */
  ids: (marker: string) => string[];
  invoke: () => Promise<unknown>;
  /** Assert the reader answered `marker`'s payload intact. */
  assertAnswer: (answer: unknown, marker: string) => void;
  /**
   * How a receive failure the reader does *not* absorb reaches the client, or
   * `null` when the reader's catch-all absorbs every failure into a count of 0.
   */
  failure: { status: number; type: string } | null;
}

const SITES: Site[] = [
  {
    name: 'getModelCount',
    ids: (marker) => [`model-a-${marker}`, 'model-b'],
    invoke: () => getModelCount(MODELS_TARGET, AUTH, REQUEST_ID, LOGGER, ENV),
    assertAnswer: (answer) => {
      // The count is the reader's whole output: a dropped or truncated body could
      // not have parsed, so the number is the tell that it arrived.
      assert.deepEqual(answer, { count: 2, cached: false });
    },
    failure: null,
  },
  {
    name: 'handleModelsRequest',
    ids: (marker) => [`model-a-${marker}`, 'model-b'],
    invoke: () => handleModelsRequest(modelsRequest(), MODELS_TARGET, AUTH, REQUEST_ID, LOGGER, ENV),
    assertAnswer: (answer, marker) => {
      const { status, body } = answer as { status: number; body: string };
      assert.equal(status, 200);
      assert.ok(body.includes(marker), 'the large model id must survive the bounded read');
      assert.equal((JSON.parse(body).data as unknown[]).length, 2);
    },
    failure: { status: 500, type: 'processing_error' },
  },
  {
    name: 'handleAnthropicModelsDiscovery',
    ids: (marker) => [`claude-${marker}`, 'claude-model-b', 'gpt-ignored'],
    invoke: () => handleAnthropicModelsDiscovery(modelsRequest(), MODELS_TARGET, AUTH, REQUEST_ID, LOGGER, DISCOVERY_ENV),
    assertAnswer: (answer, marker) => {
      const { status, body } = answer as { status: number; body: string };
      assert.equal(status, 200);
      const ids = (JSON.parse(body).data as Array<{ id: string }>).map((model) => model.id);
      // The transform and the claude/anthropic filter are downstream of the read:
      // this pins that both still ran on a body that came off the spill.
      assert.deepEqual(ids, [`claude-${marker}`, 'claude-model-b']);
    },
    failure: { status: 500, type: 'processing_error' },
  },
];

// ---------------------------------------------------------------------------
// §5.7: bounded receive, spill, cap
// ---------------------------------------------------------------------------

for (const site of SITES) {
  describe(`${site.name} model list (§5.7)`, () => {
    it('answers a body above threshold_bytes exactly as the spool-disabled path does', async () => {
      const marker = 'x'.repeat(400);
      const payload = modelPayload(site.ids(marker));

      configureSpool({ enabled: false });
      stubUpstream(() => jsonResponse(payload));
      const baseline = await settle(await site.invoke());
      site.assertAnswer(baseline, marker);

      // A fresh config, so this is the directory the spooled run's spill lands in.
      clearModelCache();
      const config = configureSpool();
      assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength > config.thresholdBytes);
      stubUpstream(() => jsonResponse(payload));

      const { result: answered, clones } = await countClones(() => site.invoke());
      // Settled once: a `Response` body can only be read once, and both the answer
      // assertion and the comparison below need it.
      const spooled = await settle(answered);

      site.assertAnswer(spooled, marker);
      assert.deepEqual(spooled, baseline, 'the spool must not change the answer');
      assert.deepEqual(spillFiles(config), [], 'the spill is released before the reader answers');
      assert.equal(getLiveSpillBytes(), 0);
      assert.equal(clones, 0, 'the proxy must not hold a second copy of the body');
    });

    it("holds the received prefix on this response's spill while the body streams in", async () => {
      const config = configureSpool();
      const payload = JSON.stringify(modelPayload(site.ids('y'.repeat(400))));
      const chunks = twoChunks(payload);
      assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the first chunk must cross the threshold');

      const seen: Array<{ files: number; bytes: number }> = [];
      const src = source(chunks, (index) => {
        seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
        if (index > 2) throw new Error(`receive asked for too many chunks: ${index}`);
      });
      stubUpstream(() => new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }));

      await site.invoke();

      // The spill is the live body while it is received: by the time the proxy asks
      // for the second chunk, the first is on disk and charged.
      assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'the received prefix must be on disk, charged');
      // And it is gone before the reader answers: none of the three keeps the body.
      assert.deepEqual(spillFiles(config), [], 'the reader releases its spill before answering');
      assert.equal(getLiveSpillBytes(), 0);
    });

    it('fails the receive past max_response_bytes and cancels the upstream body', async () => {
      const config = configureSpool({ maxResponseBytes: 256 });
      const payload = JSON.stringify(modelPayload(site.ids('z'.repeat(400))));
      // 160-byte slices: the first crosses `threshold_bytes` (64) but not the cap,
      // so a spill file really exists when the second slice breaches it — the state
      // the failure path has to clean up.
      const chunks = slices(payload, 160);
      assert.ok(chunks[0].byteLength > config.thresholdBytes && chunks[0].byteLength <= config.maxResponseBytes);
      assert.ok(chunks[0].byteLength + chunks[1].byteLength > config.maxResponseBytes);
      const src = source(chunks);
      const { calls } = stubUpstream(() => new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }));

      const answer = await site.invoke();

      assert.equal(calls(), 1);
      assert.equal(src.cancelled, true, 'the upstream body must be cancelled, not left flowing');
      assert.deepEqual(spillFiles(config), [], 'a rejected response removes its partial spill');
      assert.equal(getLiveSpillBytes(), 0);

      if (site.failure === null) {
        // `getModelCount`'s catch-all takes every failure, so a cap breach reaches
        // the client as the same empty count an empty upstream list would. Pinned as
        // the disclosed degradation it is — its caller answers 0 with its usual 404
        // (`src/index.ts:1013`), and the cap did stop the body being materialized.
        assert.deepEqual(answer, { count: 0, cached: false });
      } else {
        const response = answer as Response;
        assert.equal(response.status, site.failure.status, 'the cap is a proxy limit, and the client is told so');
        assert.equal(response.headers.get('x-request-id'), REQUEST_ID);
        const body = await response.json() as { type: string; error: { type: string; message: string } };
        assert.equal(body.type, 'error');
        assert.equal(body.error.type, site.failure.type);
        assert.match(body.error.message, /too large/);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// §5.7: what each catch-all is still allowed to absorb
// ---------------------------------------------------------------------------

describe('handleModelsRequest degradation split (§5.7)', () => {
  it('keeps its config-only list for a malformed upstream body, as before the bounded read', async () => {
    const config = configureSpool();
    const payload = '{"object":"list","data":[' + 'x'.repeat(200);
    assert.ok(new TextEncoder().encode(payload).byteLength > config.thresholdBytes, 'the fixture must spill');
    stubUpstream(() => streamedResponse(payload));

    const response = await handleModelsRequest(modelsRequest(), MODELS_TARGET, AUTH, REQUEST_ID, LOGGER, ENV);

    // A body that is not JSON is the one failure this endpoint still answers with a
    // 200 and the models it knows from config: the pre-existing contract, kept.
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-cache'), 'MISS');
    assert.deepEqual(await response.json(), { object: 'list', data: [] });
    assert.deepEqual(spillFiles(config), [], 'a failed parse still releases its spill');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('reports a §5.9 refusal as itself rather than as a smaller model list', async () => {
    const payload = modelPayload(['model-a', 'model-b']);
    const bodyBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    const config = configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2) - 1 });
    stubUpstream(() => jsonResponse(payload));

    const response = await handleModelsRequest(modelsRequest(), MODELS_TARGET, AUTH, REQUEST_ID, LOGGER, ENV);

    // 503 over_limit_error, never the 200 config-only list: the body may be
    // perfectly good JSON, so degrading here would hide a proxy limit behind a
    // smaller answer (rule #8).
    assert.equal(response.status, 503);
    const body = await response.json() as { type: string; error: { type: string; message: string } };
    assert.equal(body.type, 'error');
    assert.equal(body.error.type, 'over_limit_error');
    assert.match(body.error.message, /exceed max_materialized_body_bytes/);
    assert.deepEqual(spillFiles(config), [], 'a refused body must not leave its bytes on disk');
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(getAdmittedBytes(), 0, 'a refusal must not keep its queue slot');
  });
});

describe('handleAnthropicModelsDiscovery degradation split (§5.7)', () => {
  it('keeps its 500 internal_error for a malformed upstream body, as before the bounded read', async () => {
    const config = configureSpool();
    const payload = '{"object":"list","data":[' + 'x'.repeat(200);
    assert.ok(new TextEncoder().encode(payload).byteLength > config.thresholdBytes, 'the fixture must spill');
    stubUpstream(() => streamedResponse(payload));

    const response = await handleAnthropicModelsDiscovery(modelsRequest(), MODELS_TARGET, AUTH, REQUEST_ID, LOGGER, DISCOVERY_ENV);

    // Discovery deliberately does not degrade to a possibly-empty list: a body it
    // cannot read stays the 500 it already was.
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('x-request-id'), REQUEST_ID);
    assert.deepEqual(await response.json(), {
      error: { type: 'internal_error', message: 'Model discovery failed' },
    });
    assert.deepEqual(spillFiles(config), [], 'a failed parse still releases its spill');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('reports a §5.9 refusal as itself rather than as 500 internal_error', async () => {
    const payload = modelPayload(['claude-model-a', 'claude-model-b']);
    const bodyBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    const config = configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2) - 1 });
    stubUpstream(() => jsonResponse(payload));

    const response = await handleAnthropicModelsDiscovery(modelsRequest(), MODELS_TARGET, AUTH, REQUEST_ID, LOGGER, DISCOVERY_ENV);

    assert.equal(response.status, 503);
    const body = await response.json() as { type: string; error: { type: string; message: string } };
    assert.equal(body.error.type, 'over_limit_error', 'not the 500 that claims the upstream broke');
    assert.match(body.error.message, /exceed max_materialized_body_bytes/);
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getAdmittedBytes(), 0);
  });
});

describe('getModelCount degradation (§5.7)', () => {
  it('answers a count of 0 for a body past the cap and logs the real error', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const payload = modelPayload([`model-a-${'z'.repeat(400)}`]);
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength > config.maxResponseBytes);
    stubUpstream(() => jsonResponse(payload));
    const { logger, errors } = captureLogger();

    const answer = await getModelCount(MODELS_TARGET, AUTH, REQUEST_ID, logger, ENV);

    // Disclosed, not endorsed: the catch-all predates this receive, and its caller
    // turns 0 into a 404. The failure is at least reported — a silent 0 here would
    // make a cap breach indistinguishable from an empty upstream in the logs too.
    assert.deepEqual(answer, { count: 0, cached: false });
    assert.equal(errors.length, 1, 'the cap must be reported exactly once, not swallowed');
    assert.match(errors[0], /too large/);
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });
});

// ---------------------------------------------------------------------------
// §5.7: the upstream error body is bounded too
// ---------------------------------------------------------------------------

/**
 * Both handlers' `!response.ok` branch read `response.text()` — the last whole-body
 * read in the file. They differ in where the text lands: `handleModelsRequest`
 * hands it to `handleTargetApiError`, whose throw the handler's own catch-all
 * absorbs into the config-only list; `handleAnthropicModelsDiscovery` embeds it in
 * its `upstream_error` message. Neither may absorb the proxy's own cap.
 */
describe('upstream error bodies (§5.7)', () => {
  /** A 400 answer whose body is large enough to spill, as a stream we can watch. */
  function errorUpstream(marker: string): { src: Sourced; chunks: Uint8Array[]; body: string } {
    const body = JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `upstream said ${marker}` } });
    const chunks = twoChunks(body);
    return { src: source(chunks), chunks, body };
  }

  it('handleModelsRequest still answers its config-only list, having spilled the error body', async () => {
    const config = configureSpool();
    const body = JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `upstream said ${'x'.repeat(200)}` } });
    const chunks = twoChunks(body);
    assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the fixture must spill');
    const seen: Array<{ files: number; bytes: number }> = [];
    const src = source(chunks, (index) => {
      seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
      if (index > 2) throw new Error(`receive asked for too many chunks: ${index}`);
    });
    stubUpstream(() => new Response(src.stream, { status: 400, headers: { 'Content-Type': 'application/json' } }));

    const response = await handleModelsRequest(modelsRequest(), MODELS_TARGET, AUTH, REQUEST_ID, LOGGER, ENV);

    // The body really went through the spill, or this test would pass on a
    // whole-body read too.
    assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'the error body must have been on disk mid-receive');
    // The pre-existing contract, unchanged: `handleTargetApiError` throws, the
    // handler's catch-all turns any upstream failure into the list it knows from
    // config. Bounding the read must not change that answer.
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-cache'), 'MISS');
    assert.deepEqual(await response.json(), { object: 'list', data: [] });
    assert.deepEqual(spillFiles(config), [], 'the spill is released before the answer');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('handleModelsRequest answers an over-cap error body as itself, not as a smaller list', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const body = JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'z'.repeat(400) } });
    const chunks = slices(body, 160);
    assert.ok(chunks[0].byteLength > config.thresholdBytes && chunks[0].byteLength <= config.maxResponseBytes);
    assert.ok(chunks[0].byteLength + chunks[1].byteLength > config.maxResponseBytes);
    const src = source(chunks);
    stubUpstream(() => new Response(src.stream, { status: 404, headers: { 'Content-Type': 'application/json' } }));

    const response = await handleModelsRequest(modelsRequest(), MODELS_TARGET, AUTH, REQUEST_ID, LOGGER, ENV);

    // The catch-all below the read would have answered 200 with the config-only
    // list — a smaller success standing in for a proxy limit (rule #8).
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('x-request-id'), REQUEST_ID);
    const payload = await response.json() as { type: string; error: { type: string; message: string } };
    assert.equal(payload.type, 'error');
    assert.equal(payload.error.type, 'processing_error');
    assert.match(payload.error.message, /too large/);
    assert.equal(src.cancelled, true, 'the upstream body must be cancelled, not left flowing');
    assert.deepEqual(spillFiles(config), [], 'a rejected error body removes its partial spill');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('handleAnthropicModelsDiscovery embeds the spilled error body in its own envelope', async () => {
    const config = configureSpool();
    const marker = 'y'.repeat(200);
    const { src, chunks } = errorUpstream(marker);
    assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the fixture must spill');
    stubUpstream(() => new Response(src.stream, { status: 400, headers: { 'Content-Type': 'application/json' } }));

    const response = await handleAnthropicModelsDiscovery(modelsRequest(), MODELS_TARGET, AUTH, REQUEST_ID, LOGGER, DISCOVERY_ENV);

    // The upstream status and the body text both reach the client on this branch,
    // so the marker is the tell that the spilled bytes were kept, not dropped.
    assert.equal(response.status, 400);
    const payload = await response.json() as { error: { type: string; message: string } };
    assert.equal(payload.error.type, 'upstream_error');
    assert.ok(payload.error.message.includes(marker), 'the error body must survive the bounded read');
    assert.deepEqual(spillFiles(config), [], 'the spill is released before the answer');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('handleAnthropicModelsDiscovery answers an over-cap error body as itself, not as internal_error', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const body = JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'z'.repeat(400) } });
    const chunks = slices(body, 160);
    assert.ok(chunks[0].byteLength > config.thresholdBytes && chunks[0].byteLength <= config.maxResponseBytes);
    const src = source(chunks);
    stubUpstream(() => new Response(src.stream, { status: 404, headers: { 'Content-Type': 'application/json' } }));

    const response = await handleAnthropicModelsDiscovery(modelsRequest(), MODELS_TARGET, AUTH, REQUEST_ID, LOGGER, DISCOVERY_ENV);

    assert.equal(response.status, 500);
    const payload = await response.json() as { type: string; error: { type: string; message: string } };
    assert.equal(payload.error.type, 'processing_error', 'not the 500 that claims the upstream broke');
    assert.match(payload.error.message, /too large/);
    assert.equal(src.cancelled, true);
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });
});
