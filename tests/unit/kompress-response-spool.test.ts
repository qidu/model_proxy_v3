/**
 * Unit tests for the §5.7 bounded read of the kompress sidecar's answer
 * (`src/utils/kompress.ts`, `compressFragment`).
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.7, §5.9.
 *
 * `compressFragment` used to read the sidecar's answer with `resp.json()` inside
 * a `try { … } catch { return null }` that swallowed the reason: of every reader
 * in `src/`, this was the one that both buffered whatever the sidecar sent — the
 * answer is the compressed fragment, so it is derived from request text and grows
 * with it — and reported nothing when it failed. It now receives through
 * `consumeResponseText` (the same receive as `withResponseText` without its
 * `upstream-response` trace stage, because this body is never logged) and returns
 * a short reason per failure.
 *
 * What these tests pin, and why each assertion is worth its space:
 *  - a healthy answer still compresses, the read really was bounded (a spill
 *    existed *while* the body was being received, captured per pull because the
 *    spill is released before the call returns, and is gone afterwards), and the
 *    body was pulled once — one read, no second copy;
 *  - the cap (`max_response_bytes`) stops the read as the proxy's own limit,
 *    cancels the sidecar's body, leaves nothing on disk, and is reported as
 *    `proxy limit on the answer read: …` rather than as a broken sidecar — while
 *    the *request* still proceeds with the original text, which is the fail-open
 *    contract this plugin documents;
 *  - the same cap with `[spool] enabled = false` — the repository's stated rule is
 *    that `max_response_bytes` bounds the body and `enabled` only decides whether
 *    disk is used, asserted here rather than assumed;
 *  - with `failOpen = false` the throw carries that same reason, so the old
 *    generic `kompress sidecar unavailable` no longer mislabels a proxy limit;
 *  - a §5.9 refusal is reported as itself and releases the spill and the queue
 *    slot: a refused read leaves neither bytes nor a reservation;
 *  - failures are tallied by reason with their counts, one entry per distinct
 *    reason, so a log line says how many fragments were affected and why;
 *  - no failure reason ever carries answer text: a malformed answer quotes the
 *    input it rejected in `JSON.parse`'s own message, which is exactly the text
 *    that must never reach a log, so the reason is a fixed phrase instead.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compressBody, getKompressConfig, type KompressConfig } from '../../src/utils/kompress.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { SPOOL_DEFAULTS, responseSpillDir, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';
import {
  getAdmissionQueueDepth,
  getAdmittedBytes,
  resetAdmission,
} from '../../src/utils/spool-admission.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  setSpoolConfig(SPOOL_DEFAULTS);
  resetAdmission();
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
  const dir = mkdtempSync(join(tmpdir(), 'kompress-response-test-'));
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

const kompressConfig = (over: Partial<KompressConfig> = {}): KompressConfig => ({
  ...getKompressConfig({ KOMPRESS_URL: 'http://localhost:8900' } as any)!,
  ...over,
});

/** An English fragment above the default `minChars` of 200. */
const LONG = 'lorem ipsum '.repeat(30).trim(); // ~359 chars

/** A one-fragment body: the fragment is the only compressible text. */
function bodyWithOneFragment(text = LONG): Record<string, unknown> {
  return { messages: [{ role: 'user', content: text }] };
}

/** The sidecar's answer for one fragment, as the bytes it would send. */
function answerJson(compressed: string): string {
  return JSON.stringify({ compressed });
}

interface Sourced {
  stream: ReadableStream<Uint8Array>;
  cancelled: boolean;
  /** Chunk indices the receive asked for, so a second read would be visible. */
  pulls: number[];
}

/**
 * A sidecar answer we can watch being cancelled and pulled chunk by chunk.
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

/** Fixed-size slices of an encoded body, so a spill cannot be the declared-length path. */
function slices(payload: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(payload);
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    out.push(bytes.subarray(offset, offset + size));
  }
  return out;
}

/** Stand the sidecar up as a server returning `src` as its answer body. */
function serve(src: Sourced): void {
  globalThis.fetch = (async () =>
    new Response(src.stream, { status: 200, headers: { 'content-type': 'application/json' } })) as any;
}

// ---------------------------------------------------------------------------
// A healthy answer: unchanged result, bounded read
// ---------------------------------------------------------------------------

describe('compressFragment — the answer read is bounded', () => {
  it('compresses identically, spilled the answer while receiving it, and pulled it once', async () => {
    const config = configureSpool();
    const compressed = 'c'.repeat(300);
    const chunks = slices(answerJson(compressed), 100);
    const depths: number[] = [];
    const src = source(chunks, () => {
      depths.push(spillFiles(config).length);
    });
    serve(src);

    const body = bodyWithOneFragment();
    const result = await compressBody(kompressConfig(), body);

    // The compression itself is unchanged by the spool.
    assert.equal((body.messages as any)[0].content, compressed);
    assert.equal(result.fragments, 1);
    assert.equal(result.savedChars, LONG.length - compressed.length);
    assert.deepEqual(result.uncompressed, [], 'a healthy answer reports no failure');
    // Above `threshold_bytes` the answer really lived on disk mid-receive.
    assert.ok(depths.some((n) => n === 1), `expected one spill file mid-receive, saw ${JSON.stringify(depths)}`);
    // …and the spill is released before the caller gets its result back.
    assert.deepEqual(spillFiles(config), []);
    // The body was pulled once: no second copy of it was ever requested.
    assert.equal(
      src.pulls.length,
      chunks.length + 1,
      `expected one pull per chunk plus the close, saw ${JSON.stringify(src.pulls)}`,
    );
  });

  it('reads a small answer without spilling', async () => {
    const config = configureSpool({ thresholdBytes: 1 << 20 });
    const chunks = slices(answerJson('short'), 1024);
    const src = source(chunks);
    serve(src);

    const body = bodyWithOneFragment();
    const result = await compressBody(kompressConfig(), body);

    assert.equal((body.messages as any)[0].content, 'short');
    assert.equal(result.fragments, 1);
    assert.deepEqual(result.uncompressed, []);
    assert.deepEqual(spillFiles(config), []);
    assert.equal(src.pulls.length, chunks.length + 1);
  });
});

// ---------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------

describe('compressFragment — max_response_bytes', () => {
  const OVERSIZE = () => slices(answerJson('c'.repeat(2000)), 160);

  it('fails open on a breach, cancels the answer, and reports the proxy\'s own limit', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const src = source(OVERSIZE());
    serve(src);

    const body = bodyWithOneFragment();
    const result = await compressBody(kompressConfig({ failOpen: true }), body);

    // Fail-open: the request continues with the original text.
    assert.equal((body.messages as any)[0].content, LONG);
    assert.equal(result.fragments, 0);
    // Rule #8: the failure is reported, and the reason names the real cause — a
    // proxy limit — not a sidecar outage.
    assert.deepEqual(result.uncompressed, [{
      reason: 'proxy limit on the answer read: Response body too large: exceeded 256 bytes',
      count: 1,
    }]);
    // §5.7 pairs a breach with cancelling the upstream body rather than truncating it.
    assert.equal(src.cancelled, true, 'a breached body must be cancelled');
    assert.deepEqual(spillFiles(config), []);
  });

  it('throws that same reason when failOpen is false', async () => {
    configureSpool({ maxResponseBytes: 256 });
    const src = source(OVERSIZE());
    serve(src);

    await assert.rejects(
      compressBody(kompressConfig({ failOpen: false }), bodyWithOneFragment()),
      /kompress sidecar unavailable: proxy limit on the answer read: Response body too large: exceeded 256 bytes/,
    );
    assert.equal(src.cancelled, true);
  });

  it('applies the cap with the spool disabled too', async () => {
    const config = configureSpool({ enabled: false, maxResponseBytes: 256 });
    const src = source(OVERSIZE());
    serve(src);

    const result = await compressBody(kompressConfig(), bodyWithOneFragment());

    assert.equal(result.fragments, 0);
    assert.deepEqual(result.uncompressed, [{
      reason: 'proxy limit on the answer read: Response body too large: exceeded 256 bytes',
      count: 1,
    }]);
    assert.equal(src.cancelled, true);
    assert.deepEqual(spillFiles(config), []);
  });
});

// ---------------------------------------------------------------------------
// §5.9 admission
// ---------------------------------------------------------------------------

describe('compressFragment — §5.9 byte admission', () => {
  it('reports a refusal as itself and releases the spill and its slot', async () => {
    const config = configureSpool({ maxMaterializedBodyBytes: 64 });
    const src = source(slices(answerJson('c'.repeat(500)), 100));
    serve(src);

    const body = bodyWithOneFragment();
    const result = await compressBody(kompressConfig(), body);

    assert.equal((body.messages as any)[0].content, LONG, 'a refused read forwards the original text');
    assert.equal(result.uncompressed.length, 1);
    assert.match(result.uncompressed[0].reason, /^proxy limit on the answer read: /);
    assert.match(result.uncompressed[0].reason, /max_materialized_body_bytes/);
    // A refused read holds nothing: no bytes on disk, no reservation, no waiter.
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(getAdmittedBytes(), 0);
  });
});

// ---------------------------------------------------------------------------
// Failure reporting
// ---------------------------------------------------------------------------

describe('compressFragment — failures are tallied by reason', () => {
  it('counts one entry per distinct reason, in work order', async () => {
    configureSpool();
    let call = 0;
    globalThis.fetch = (async () => {
      // First two fragments: a 200 whose body is not JSON. Third: a 500.
      return ++call <= 2
        ? new Response('nonsense', { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('boom', { status: 500 });
    }) as any;

    const body = {
      messages: [
        { role: 'user', content: LONG },
        { role: 'user', content: `${LONG} A` },
        { role: 'user', content: `${LONG} B` },
      ],
    };
    const result = await compressBody(kompressConfig(), body);

    assert.equal(result.fragments, 0);
    assert.deepEqual(result.uncompressed, [
      { reason: 'answer was not JSON', count: 2 },
      { reason: 'sidecar returned 500', count: 1 },
    ]);
    // Fail-open leaves every fragment as the client sent it.
    assert.deepEqual((body.messages as any).map((m: any) => m.content), [LONG, `${LONG} A`, `${LONG} B`]);
  });

  it('reports the combined-text limit instead of silently compressing nothing', async () => {
    configureSpool();
    let called = 0;
    globalThis.fetch = (async () => { called++; return new Response(answerJson('x')); }) as any;

    const body = bodyWithOneFragment();
    const result = await compressBody(kompressConfig({ maxChars: 100 }), body);

    assert.equal(called, 0, 'an over-cap batch must not reach the sidecar at all');
    assert.equal(result.fragments, 0);
    assert.deepEqual(result.uncompressed, [{
      reason: `combined text ${LONG.length} chars over maxChars 100`,
      count: 1,
    }]);
    assert.equal((body.messages as any)[0].content, LONG);
  });

  it('never puts answer text into a reason', async () => {
    configureSpool();
    const MARKER = 'TOP-SECRET-PROMPT-TEXT';
    const src = source(slices(`${MARKER} is not json`, 8));
    serve(src);

    const result = await compressBody(kompressConfig(), bodyWithOneFragment());

    assert.equal(result.uncompressed.length, 1);
    // `JSON.parse`'s own message quotes the input it rejected; the reason must not.
    assert.equal(result.uncompressed[0].reason, 'answer was not JSON');
    assert.doesNotMatch(result.uncompressed[0].reason, /TOP-SECRET/);
  });
});
