/**
 * Unit tests for the §5.7 response reads of the three small passthrough
 * handlers: `src/handlers/embeddings.ts`, `src/handlers/decision.ts` and
 * `src/handlers/token-counting.ts`.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.7, §5.9.
 *
 * Each of the three read its upstream body whole with `response.text()` and then
 * parsed it, so nothing bounded what the upstream could send on:
 *  - `POST /v1/embeddings` — the OpenAI-shaped answer, or Ollama's `/api/embed`
 *    answer converted from it;
 *  - `POST /decision` — the Clef answer, returned to the client verbatim;
 *  - `POST /v1/messages/count_tokens` — the API-based counting branch, which
 *    reads `usage.prompt_tokens` out of a Completions-shaped answer.
 * The first and the third now go through `receiveJsonResponse` like the converting
 * egresses; `/decision` goes through its primitive `withResponseText`, because
 * its answer is the upstream body verbatim and its envelope validation parses
 * the text it keeps.
 *
 * The three differ in what the client receives and in what a malformed body has
 * to produce, so each is pinned on its own converted shape and on its own
 * malformed-body outcome; the properties under test are otherwise the same for
 * all three, so the assertions below are written once against a site table.
 *
 * What these tests pin, and why each assertion is worth its space:
 *  - the answer each client receives is unchanged, both under `threshold_bytes`
 *    and above it (the spool must not change an answer);
 *  - a body over `threshold_bytes` really did live on disk while it was being
 *    received — captured mid-receive, because this path releases the spill
 *    before it returns, so the end state alone cannot tell the two paths apart;
 *  - a body past `max_response_bytes` fails explicitly and cancels the upstream
 *    body rather than handing a truncated body to `JSON.parse`;
 *  - the cap applies with `[spool] enabled = false` too. This is the
 *    repository's stated rule (CHANGELOG: `max_response_bytes` bounds the body;
 *    `enabled` only decides whether disk is used), applied here as on the other
 *    egresses. It is asserted rather than assumed so that a future change of
 *    that rule fails here loudly;
 *  - a malformed upstream body keeps the answer each handler already gave for
 *    one — 502 `Invalid upstream response` on `/v1/embeddings` and `/decision`,
 *    the bare parse error on token counting — with the spill released, and *not*
 *    any other failure's status;
 *  - a §5.9 refusal is reported as itself (503 `over_limit_error`), never as
 *    that handler's 502;
 *  - `Response.prototype.clone()` is never called: the whole point of the
 *    bounded receive is that no second copy of the body exists;
 *  - §5.9 admission is charged the received byte count, and a refusal releases
 *    the spill without keeping a reservation.
 *
 * `withResponseText` is also driven directly, because one of its properties is
 * invisible from the handler level: `consume` — the parse the budget exists for
 * — runs while the lease and the spill are still held.
 *
 * The upstream *error* reads beside these sites are bounded too: `!response.ok`
 * in `/v1/embeddings` and `/decision` used to call `response.text()`, so an
 * upstream error body was the one part of these handlers nothing bounded. Both
 * now receive it through the same `withResponseText`, and a cap breach, a write
 * failure or a §5.9 refusal propagates as itself instead of being forwarded as
 * the upstream's own error. `/v1/messages/count_tokens` reads nothing on that
 * branch, so it is unchanged and out of scope here.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleEmbeddingsRequest } from '../../src/handlers/embeddings.js';
import { handleDecisionRequest } from '../../src/handlers/decision.js';
import { handleTokenCountingRequest } from '../../src/handlers/token-counting.js';
import type { Env } from '../../src/types/shared.js';
import type { ProxyConfig } from '../../src/utils/config-loader.js';
import { SpoolResponseTooLargeError, withResponseText } from '../../src/utils/spool-response.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { SPOOL_DEFAULTS, responseSpillDir, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';
import { AdmissionOverBudgetError, getAdmittedBytes } from '../../src/utils/spool-admission.js';
import { createLogger } from '../../src/utils/logger.js';

const realFetch = globalThis.fetch;
const REQUEST_ID = 'req-aux-response';
const AUTH = { Authorization: 'Bearer upstream-key' };
const ENV = { LOG_LEVEL: 'error' } as unknown as Env;
const LOGGER = createLogger({});

const EMBEDDINGS_TARGET = 'https://upstream.test/v1/embeddings';
const DECISION_TARGET = 'http://127.0.0.1:8765/decision';
const TOKEN_COUNT_TARGET = 'https://upstream.test/v1/messages/count_tokens';

afterEach(() => {
  globalThis.fetch = realFetch;
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
  const dir = mkdtempSync(join(tmpdir(), 'aux-response-test-'));
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
 * A deterministic embedding vector of `length` dimensions. Length rather than
 * content carries the fixture's size: a real embeddings answer is one long float
 * array, so this is the field that has to grow to cross the threshold.
 */
function vector(length: number): number[] {
  return Array.from({ length }, (_, i) => i);
}

/** A `POST /v1/embeddings` client request with a valid body. */
function embeddingsClient(): Request {
  return new Request('http://proxy.test/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-test', input: 'hello' }),
  });
}

/** A minimal valid Clef request body. */
function clefBody(): string {
  return JSON.stringify({
    model: 'laya',
    state: 'the user asked to trim a log file',
    questions: { keep: { type: 'noul', instructions: 'Is this tool relevant?' } },
  });
}

/** A `[models.decision]` config, URLed at the target this suite stubs. */
function decisionConfig(): ProxyConfig {
  return { decision: { backend: 'laya', url: DECISION_TARGET } } as ProxyConfig;
}

/** A `POST /v1/messages/count_tokens` client request with a valid body. */
function tokenCountClient(): Request {
  return new Request('http://proxy.test/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-sonnet-test', messages: [{ role: 'user', content: 'Hello' }] }),
  });
}

/**
 * One bounded reader: how to call it, and what it must answer.
 *
 * `invoke` takes no request: `/decision` receives its body as a string, not as a
 * `Request`, so the table cannot require one.
 */
interface Site {
  name: string;
  invoke: () => Promise<Response>;
  /** An upstream body whose size marker is `marker`. */
  payload: (marker: string) => Record<string, unknown>;
  /** The answer for `marker`. */
  expected: (marker: string) => Record<string, unknown>;
  /**
   * The answer's tell that the large payload survived the read, or `undefined`
   * when the answer echoes nothing (token counting reads a number and drops the
   * body).
   */
  textOf: (body: Record<string, any>) => string | undefined;
  /**
   * What a body that is not JSON must produce: the handler's own 502
   * `Invalid upstream response`, or the parse error it already let through.
   */
  malformedIs502: boolean;
}

const SITES: Site[] = [
  {
    name: 'embeddings',
    invoke: () => handleEmbeddingsRequest(embeddingsClient(), EMBEDDINGS_TARGET, AUTH, REQUEST_ID, LOGGER, ENV),
    // `provider` is stripped before the answer is sent (the API spec note in the
    // handler), so it is here to pin that the strip still happens on this path.
    payload: (marker) => ({
      object: 'list',
      data: [{ object: 'embedding', embedding: vector(marker.length), index: 0 }],
      model: 'text-embedding-test',
      usage: { prompt_tokens: 4, total_tokens: 4 },
      provider: 'openai',
    }),
    expected: (marker) => ({
      object: 'list',
      data: [{ object: 'embedding', embedding: vector(marker.length), index: 0 }],
      model: 'text-embedding-test',
      usage: { prompt_tokens: 4, total_tokens: 4 },
    }),
    textOf: (body) => String(body.data[0].embedding.length),
    malformedIs502: true,
  },
  {
    name: 'decision',
    invoke: () => handleDecisionRequest(clefBody(), decisionConfig(), REQUEST_ID, LOGGER),
    // The handler forwards the upstream body verbatim, so the marker rides in an
    // extra field it does not own and must not touch.
    payload: (marker) => ({
      model: 'laya',
      answers: { keep: { type: 'noul', noul: 0.83 } },
      usage: { input_tokens: 120, output_tokens: 0 },
      note: marker,
    }),
    expected: (marker) => ({
      model: 'laya',
      answers: { keep: { type: 'noul', noul: 0.83 } },
      usage: { input_tokens: 120, output_tokens: 0 },
      note: marker,
    }),
    textOf: (body) => body.note,
    malformedIs502: true,
  },
  {
    name: 'token-counting',
    invoke: () => handleTokenCountingRequest(tokenCountClient(), TOKEN_COUNT_TARGET, AUTH, REQUEST_ID, ENV, LOGGER),
    payload: (marker) => ({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: marker }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 37, completion_tokens: 1, total_tokens: 38 },
    }),
    expected: () => ({ type: 'token_count', input_tokens: 37 }),
    textOf: () => undefined,
    // No try/catch on this path: `JSON.parse` threw before and still throws.
    malformedIs502: false,
  },
];

interface Sourced {
  stream: ReadableStream<Uint8Array>;
  cancelled: boolean;
}

/**
 * An upstream body we can watch being cancelled, and whose receive we can
 * inspect chunk by chunk. `onPull(i)` runs when the proxy asks for chunk `i`,
 * i.e. after chunks `0…i-1` have been read and written to the spill.
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

/** Run `run` and return whatever it threw, so an assertion can name the error. */
async function caughtFrom(run: () => Promise<unknown>): Promise<any> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
}

// ---------------------------------------------------------------------------
// §5.7: bounded receive, spill, cap
// ---------------------------------------------------------------------------

for (const site of SITES) {
  describe(`${site.name} non-SSE response (§5.7)`, () => {
    it('answers a body under threshold_bytes without touching the spool or cloning it', async () => {
      const config = configureSpool({ thresholdBytes: 4096 });
      const payload = site.payload('ok');
      assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength < config.thresholdBytes);
      stubUpstream(() => jsonResponse(payload));

      const { result: response, clones } = await countClones(() => site.invoke());

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-request-id'), REQUEST_ID);
      assert.deepEqual(await response.json(), site.expected('ok'));
      assert.deepEqual(spillFiles(config), [], 'a body under the threshold leaves no spill');
      assert.equal(clones, 0, 'the proxy must not hold a second copy of the body');
    });

    it('spills a body above threshold_bytes, answers identically, and frees the spill before answering', async () => {
      const marker = 'x'.repeat(400);
      const payload = site.payload(marker);
      const chunks = twoChunks(JSON.stringify(payload));

      // The reference is the same request with spooling off: the two runs differ
      // in nothing but the spool, so equal answers mean the spool changed nothing.
      configureSpool({ enabled: false });
      stubUpstream(() => jsonResponse(payload));
      const baseline = await (await site.invoke()).text();
      assert.deepEqual(JSON.parse(baseline), site.expected(marker));
      // For the readers that echo something of the body, the large payload must
      // have survived, or the comparison above would hold for a body quietly
      // dropped at some smaller size.
      assert.equal(site.textOf(JSON.parse(baseline)), site.textOf(site.expected(marker)));

      // Captured after the baseline run, because every `configureSpool` call makes
      // a fresh directory: this is the config whose `responses/` the spill lands in.
      const config = configureSpool();
      assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the first chunk must cross the threshold');

      const seen: Array<{ files: number; bytes: number }> = [];
      const src = source(chunks, (index) => {
        seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
        if (index > 2) throw new Error(`receive asked for too many chunks: ${index}`);
      });
      stubUpstream(() => new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }));

      const { result: response, clones } = await countClones(() => site.invoke());

      // The spill is the live body while it is received: by the time the proxy
      // asks for the second chunk, the first is on disk and charged.
      assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'the received prefix must be on disk, charged');
      // And it is gone before the handler answers: this path reads once and sends
      // the converted body, so holding the spool past that point would leak.
      assert.deepEqual(spillFiles(config), [], 'the spill must be released before the response is returned');
      assert.equal(getLiveSpillBytes(), 0);
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(await response.text()), JSON.parse(baseline), 'the spool must not change the answer');
      assert.equal(clones, 0);
    });

    it('fails loudly past max_response_bytes and cancels the upstream body', async () => {
      const config = configureSpool({ maxResponseBytes: 256 });
      const payload = site.payload('z'.repeat(400));
      // 160-byte slices: the first crosses `threshold_bytes` (64) but not the cap,
      // so a spill file really exists when the second slice breaches it — the
      // state the failure path has to clean up.
      const chunks = slices(JSON.stringify(payload), 160);
      assert.ok(chunks[0].byteLength > config.thresholdBytes && chunks[0].byteLength <= config.maxResponseBytes);
      assert.ok(chunks[0].byteLength + chunks[1].byteLength > config.maxResponseBytes);
      const seen: Array<{ files: number; bytes: number }> = [];
      const src = source(chunks, (index) => {
        seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
      });
      const { calls } = stubUpstream(() => new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }));

      const caught = await caughtFrom(() => site.invoke());

      assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'a spill must have been live when the cap was breached');
      assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
      assert.equal(caught.status, 500, 'the client sent a legal request: not a 4xx');
      assert.equal(caught.type, 'processing_error');
      assert.match(caught.message, /too large/);
      assert.equal(calls(), 1);
      assert.equal(src.cancelled, true, 'the upstream body must be cancelled, not left flowing');
      assert.deepEqual(spillFiles(config), [], 'a rejected response removes its partial spill');
      assert.equal(getLiveSpillBytes(), 0);
    });

    it('enforces max_response_bytes with the spool disabled, as the other egresses do', async () => {
      const config = configureSpool({ enabled: false, maxResponseBytes: 256 });
      const payload = site.payload('c'.repeat(400));
      assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength > config.maxResponseBytes);
      stubUpstream(() => jsonResponse(payload));

      const caught = await caughtFrom(() => site.invoke());

      // Deliberate: this receive replaced the whole-body read outright, so the cap
      // bounds that read and is not part of the spilling feature. Serving the body
      // would mean holding it twice in RAM — the cost the cap exists to refuse.
      assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
      assert.equal(caught.status, 500);
      assert.equal(caught.type, 'processing_error');
      assert.deepEqual(spillFiles(config), [], 'nothing may reach disk when spilling is off');
      assert.equal(getLiveSpillBytes(), 0);
    });

    it('reports a malformed upstream body the way this handler already did, holding no spill', async () => {
      const config = configureSpool();
      const payload = '{"id":"broken",' + 'x'.repeat(200);
      assert.ok(new TextEncoder().encode(payload).byteLength > config.thresholdBytes, 'the fixture must spill');
      const src = source(twoChunks(payload));
      stubUpstream(() => new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }));

      if (site.malformedIs502) {
        const response = await site.invoke();
        assert.equal(response.status, 502, 'a body that is not JSON is still "Invalid upstream response"');
        assert.deepEqual(await response.json(), {
          type: 'error',
          error: { type: 'error', message: 'Invalid upstream response' },
        });
      } else {
        const caught = await caughtFrom(() => site.invoke());
        assert.ok(caught instanceof SyntaxError, `expected SyntaxError, got ${String(caught)}`);
      }
      assert.deepEqual(spillFiles(config), [], 'a failed parse still releases its spill');
      assert.equal(getLiveSpillBytes(), 0);
    });

    it('refuses a body one nominal byte past the §5.9 budget, leaving no spill and no reservation', async () => {
      const upstream = site.payload('b'.repeat(400));
      const bodyBytes = new TextEncoder().encode(JSON.stringify(upstream)).byteLength;
      const config = configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2) - 1 });
      assert.ok(bodyBytes > config.thresholdBytes, 'the fixture must spill, so a leak here would be visible on disk');
      const { calls } = stubUpstream(() => jsonResponse(upstream));

      const caught = await caughtFrom(() => site.invoke());

      // A refused body is a spool limit, never this handler's own 502: the body
      // may be perfectly good JSON.
      assert.ok(caught instanceof AdmissionOverBudgetError, `expected AdmissionOverBudgetError, got ${String(caught)}`);
      assert.equal(caught.status, 503);
      assert.equal(caught.type, 'over_limit_error', 'the type the client switches on');
      assert.match(caught.message, /exceed max_materialized_body_bytes/);
      assert.equal(calls(), 1, 'the charge is the received byte count, so the body was received first');
      assert.deepEqual(spillFiles(config), [], 'a refused body must not leave its bytes on disk');
      assert.equal(getLiveSpillBytes(), 0);
      assert.equal(getAdmittedBytes(), 0, 'a refusal must not keep its queue slot');
    });

    it('admits the body that fits and answers with the converted body', async () => {
      const upstream = site.payload('ok');
      const bodyBytes = new TextEncoder().encode(JSON.stringify(upstream)).byteLength;
      configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2) });
      stubUpstream(() => jsonResponse(upstream));

      const response = await site.invoke();

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), site.expected('ok'));
      assert.equal(getAdmittedBytes(), 0, 'the lease is given back before the body is sent');
    });
  });
}

// ---------------------------------------------------------------------------
// §5.7: the upstream error body is bounded the same way
// ---------------------------------------------------------------------------

/**
 * The two handlers whose `!response.ok` branch reads a body at all. Both forward
 * the upstream error body verbatim, so one table covers them; token counting
 * reads nothing on that branch (it warns and falls back to the character count).
 */
const ERROR_SITES = SITES.filter((site) => site.name !== 'token-counting');

for (const site of ERROR_SITES) {
  describe(`${site.name} upstream error body (§5.7)`, () => {
    it('forwards an upstream error body verbatim, having spilled it on the way', async () => {
      const config = configureSpool();
      const status = 429;
      const errorBody = JSON.stringify({
        error: { type: 'rate_limit_error', message: `upstream says ${'x'.repeat(300)}` },
      });
      const chunks = twoChunks(errorBody);
      assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the fixture must spill');
      const seen: Array<{ files: number; bytes: number }> = [];
      const src = source(chunks, (index) => {
        seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
        if (index > 2) throw new Error(`receive asked for too many chunks: ${index}`);
      });
      stubUpstream(() => new Response(src.stream, { status, headers: { 'Content-Type': 'application/json' } }));

      const { result: response, clones } = await countClones(() => site.invoke());

      // The error body really went through the spill: reverting to `response.text()`
      // would leave nothing on disk and no charge part-way through the receive.
      assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'the error body must have been on disk mid-receive');
      assert.equal(response.status, status, 'the upstream status must reach the client unedited');
      assert.equal(response.headers.get('x-request-id'), REQUEST_ID);
      assert.equal(await response.text(), errorBody, 'the error body must be forwarded byte for byte');
      assert.deepEqual(spillFiles(config), [], 'the spill must be released before the response is returned');
      assert.equal(clones, 0, 'the proxy must not hold a second copy of the body');
    });

    it('fails loudly when the error body is past max_response_bytes, forwarding nothing', async () => {
      const config = configureSpool({ maxResponseBytes: 256 });
      const errorBody = JSON.stringify({ error: { type: 'rate_limit_error', message: 'z'.repeat(400) } });
      const chunks = slices(errorBody, 160);
      assert.ok(chunks[0].byteLength > config.thresholdBytes && chunks[0].byteLength <= config.maxResponseBytes);
      assert.ok(chunks[0].byteLength + chunks[1].byteLength > config.maxResponseBytes);
      const seen: Array<{ files: number; bytes: number }> = [];
      const src = source(chunks, (index) => {
        seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
      });
      const { calls } = stubUpstream(() => new Response(src.stream, { status: 429, headers: { 'Content-Type': 'application/json' } }));

      const caught = await caughtFrom(() => site.invoke());

      // The upstream status is never handed on here: the client is told about the
      // proxy's cap, not about an error body it is not going to receive (rule #8).
      assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'a spill must have been live when the cap was breached');
      assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
      assert.equal(caught.status, 500, 'the proxy limit is a 500, not the upstream\'s status');
      assert.equal(caught.type, 'processing_error');
      assert.match(caught.message, /too large/);
      assert.equal(calls(), 1);
      assert.equal(src.cancelled, true, 'the upstream body must be cancelled, not left flowing');
      assert.deepEqual(spillFiles(config), [], 'a rejected error body removes its partial spill');
      assert.equal(getLiveSpillBytes(), 0);
    });

    it('reports a §5.9 refusal on an error body as itself, leaving no spill and no reservation', async () => {
      const errorBody = JSON.stringify({ error: { type: 'rate_limit_error', message: 'b'.repeat(400) } });
      const bodyBytes = new TextEncoder().encode(errorBody).byteLength;
      const config = configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2) - 1 });
      assert.ok(bodyBytes > config.thresholdBytes, 'the fixture must spill, so a leak here would be visible on disk');
      const { calls } = stubUpstream(() => new Response(errorBody, { status: 429, headers: { 'Content-Type': 'application/json' } }));

      const caught = await caughtFrom(() => site.invoke());

      assert.ok(caught instanceof AdmissionOverBudgetError, `expected AdmissionOverBudgetError, got ${String(caught)}`);
      assert.equal(caught.status, 503);
      assert.equal(caught.type, 'over_limit_error', 'not the upstream\'s own error type');
      assert.match(caught.message, /exceed max_materialized_body_bytes/);
      assert.equal(calls(), 1, 'the charge is the received byte count, so the body was received first');
      assert.deepEqual(spillFiles(config), [], 'a refused body must not leave its bytes on disk');
      assert.equal(getLiveSpillBytes(), 0);
      assert.equal(getAdmittedBytes(), 0, 'a refusal must not keep its queue slot');
    });
  });
}

// ---------------------------------------------------------------------------
// §5.9: what `withResponseText` holds while `consume` runs
// ---------------------------------------------------------------------------

describe('withResponseText (§5.9 lease and spill around consume)', () => {
  it('runs consume with the spill written and the materialization still charged', async () => {
    const config = configureSpool({ maxMaterializedBodyBytes: 1 << 20 });
    const payload = JSON.stringify({ text: 'y'.repeat(400) });
    const chunks = twoChunks(payload);
    assert.ok(chunks[0].byteLength > config.thresholdBytes);
    const src = source(chunks);

    const observed = await withResponseText(
      new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }),
      REQUEST_ID,
      LOGGER,
      'https://upstream.test/x',
      (text) => ({
        text,
        files: spillFiles(config).length,
        spillBytes: getLiveSpillBytes(),
        admittedBytes: getAdmittedBytes(),
      }),
    );

    // `consume` is the parse the §5.9 budget exists for: it must see the body's
    // bytes still on the spill and its materialization still charged, or the
    // budget would only ever count bytes nobody is holding.
    assert.equal(observed.text, payload);
    assert.equal(observed.files, 1, 'the spill is still held while consume runs');
    assert.equal(observed.spillBytes, chunks[0].byteLength + chunks[1].byteLength);
    assert.ok(observed.admittedBytes > 0, 'the materialization is charged while consume runs');
    assert.deepEqual(spillFiles(config), [], 'the spill is released once consume returns');
  });

  it('releases the lease and the spill when consume throws', async () => {
    const config = configureSpool({ maxMaterializedBodyBytes: 1 << 20 });
    const payload = '{"broken",' + 'y'.repeat(400);
    const src = source(twoChunks(payload));

    const caught = await caughtFrom(() => withResponseText(
      new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }),
      REQUEST_ID,
      LOGGER,
      'https://upstream.test/x',
      (text) => JSON.parse(text),
    ));

    assert.ok(caught instanceof SyntaxError, `expected SyntaxError, got ${String(caught)}`);
    assert.deepEqual(spillFiles(config), [], 'a throwing consume still releases its spill');
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(getAdmittedBytes(), 0, 'a throwing consume still releases its lease');
  });
});
