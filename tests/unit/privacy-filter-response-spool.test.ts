/**
 * Unit tests for the §5.7 bounded read of the privacy-filter sidecar's answer
 * (`src/utils/privacy-filter.ts`, `redactSidecar`).
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.7, §5.9.
 *
 * `redactSidecar` used to read the sidecar's answer with `resp.json()`, which
 * buffers whatever the sidecar sends. That body is the redacted prompt text — as
 * large as the request the filter accepted (`maxChars`, 1 024 000 by default), so
 * it is prompt-proportional and, near that cap, larger than
 * `SPOOL_DEFAULTS.thresholdBytes` (1 MiB): the one remaining request-path read
 * whose body grows with the request. It now goes through
 * `consumeResponseText` — the same receive as `withResponseText` without its
 * `upstream-response` trace stage, because this body is the user's own text and
 * is never logged.
 *
 * What these tests pin, and why each assertion is worth its space:
 *  - a healthy answer still redacts, with the same mapping and the same applied
 *    texts, and the read really was bounded: above `threshold_bytes` a spill
 *    existed *while the body was being received* (captured per pull, because the
 *    spill is released before the call returns) and is gone afterwards;
 *  - the body is pulled once and never cloned: the receive exists so that no
 *    second copy is held, which the pull count proves and a clone counter could
 *    not;
 *  - a body past `max_response_bytes` fails as the proxy's own limit
 *    (`SpoolResponseTooLargeError`, 500 `processing_error`) rather than as
 *    "privacy filter unavailable", cancels the upstream body, and leaves nothing
 *    on disk. Rule #8: the reason reported is the real one;
 *  - the cap applies with `[spool] enabled = false` as well — the repository's
 *    stated rule (`max_response_bytes` bounds the body; `enabled` only decides
 *    whether disk is used), asserted here rather than assumed;
 *  - a §5.9 refusal is reported as itself too, and releases the spill and the
 *    queue slot — a refused read leaves neither bytes nor a reservation;
 *  - a plain sidecar fault is still wrapped as `privacy filter unavailable`, so
 *    the split of the two failure kinds did not lose the ordinary one. Every one
 *    of these is a rejection: the filter is fail-closed, and no path here returns
 *    the unredacted body.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getPrivacyFilterConfig,
  redactBody,
  type PrivacyFilterConfig,
} from '../../src/utils/privacy-filter.js';
import { ClaudeProxyError } from '../../src/utils/errors.js';
import { SpoolResponseTooLargeError } from '../../src/utils/spool-response.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { SPOOL_DEFAULTS, responseSpillDir, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';
import {
  AdmissionOverBudgetError,
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
  const dir = mkdtempSync(join(tmpdir(), 'privacy-filter-response-test-'));
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

const sidecarConfig = (): PrivacyFilterConfig =>
  getPrivacyFilterConfig({ PRIVACY_FILTER_URL: 'http://localhost:9999' } as any, null)!;

/** A request body with exactly one text ref, of `chars` characters. */
function bodyWithText(chars: number): Record<string, unknown> {
  return { messages: [{ role: 'user', content: 'a'.repeat(chars) }] };
}

/** The sidecar's answer for `bodyWithText`, as the bytes it would send. */
function answerJson(redacted: string): string {
  return JSON.stringify({ redacted: [redacted], mapping: { '⟦PII:0⟧': 'Alice' } });
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

/** The error `redactBody` rejects with; fails the test if it resolves instead. */
async function rejection(config: PrivacyFilterConfig, body: Record<string, unknown>): Promise<unknown> {
  try {
    await redactBody(config, body);
  } catch (error) {
    return error;
  }
  assert.fail('redactBody must reject — the privacy filter is fail-closed');
}

// ---------------------------------------------------------------------------
// A healthy answer: unchanged result, bounded read
// ---------------------------------------------------------------------------

describe('redactSidecar — the answer read is bounded', () => {
  it('redacts identically and spilled the body while receiving it', async () => {
    const config = configureSpool();
    const redacted = 'b'.repeat(300);
    const chunks = slices(answerJson(redacted), 100);
    const depths: number[] = [];
    const src = source(chunks, () => {
      depths.push(spillFiles(config).length);
    });
    serve(src);

    const body = bodyWithText(10);
    const { mapping } = await redactBody(sidecarConfig(), body);

    // The redaction itself is unchanged by the spool.
    assert.equal((body.messages as any)[0].content, redacted);
    assert.deepEqual(mapping, { '⟦PII:0⟧': 'Alice' });
    // Above `threshold_bytes` the answer really lived on disk mid-receive.
    assert.ok(depths.some((n) => n === 1), `expected one spill file mid-receive, saw ${JSON.stringify(depths)}`);
    // …and the spill is released before the caller gets its mapping back.
    assert.deepEqual(spillFiles(config), []);
    // The body was pulled once: no second copy of it was ever requested.
    assert.equal(
      src.pulls.length,
      chunks.length + 1,
      `expected one pull per chunk plus the close, saw ${JSON.stringify(src.pulls)}`
    );
  });

  it('reads a small answer without spilling and still applies it', async () => {
    const config = configureSpool({ thresholdBytes: 1 << 20 });
    const chunks = slices(answerJson('clean text'), 1024);
    const src = source(chunks);
    serve(src);

    const body = bodyWithText(5);
    const { mapping } = await redactBody(sidecarConfig(), body);

    assert.equal((body.messages as any)[0].content, 'clean text');
    assert.deepEqual(mapping, { '⟦PII:0⟧': 'Alice' });
    assert.deepEqual(spillFiles(config), []);
    // One pull serves a body that fits in a single chunk, plus the closing pull.
    assert.equal(src.pulls.length, chunks.length + 1);
  });
});

// ---------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------

describe('redactSidecar — max_response_bytes', () => {
  it('fails as the proxy\'s own limit, cancels the body, and leaves no spill', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const src = source(slices(answerJson('c'.repeat(2000)), 160));
    serve(src);

    const error = await rejection(sidecarConfig(), bodyWithText(10));

    assert.ok(error instanceof SpoolResponseTooLargeError, `expected a cap breach, got ${String(error)}`);
    assert.ok(error instanceof ClaudeProxyError);
    assert.equal(error.status, 500);
    assert.equal(error.type, 'processing_error');
    // The message names the cap and its value: this site is the response label,
    // bounded by `max_response_bytes`, not the request side's `max_body_bytes`.
    assert.equal(error.message, 'Response body too large: exceeded 256 bytes');
    // Rule #8: the sidecar was healthy — the proxy's cap is not the sidecar's fault.
    assert.doesNotMatch(error.message, /privacy filter unavailable/);
    // §5.7 pairs a breach with cancelling the upstream body rather than truncating it.
    assert.equal(src.cancelled, true, 'a breached body must be cancelled');
    assert.deepEqual(spillFiles(config), []);
  });

  it('applies the cap with the spool disabled too', async () => {
    const config = configureSpool({ enabled: false, maxResponseBytes: 256 });
    const src = source(slices(answerJson('c'.repeat(2000)), 160));
    serve(src);

    const error = await rejection(sidecarConfig(), bodyWithText(10));

    assert.ok(error instanceof SpoolResponseTooLargeError, `expected a cap breach, got ${String(error)}`);
    assert.equal(error.message, 'Response body too large: exceeded 256 bytes');
    assert.equal(src.cancelled, true);
    assert.deepEqual(spillFiles(config), []);
  });
});

// ---------------------------------------------------------------------------
// §5.9 admission
// ---------------------------------------------------------------------------

describe('redactSidecar — §5.9 byte admission', () => {
  it('reports a refusal as itself and releases the spill and its slot', async () => {
    const config = configureSpool({ maxMaterializedBodyBytes: 64 });
    const src = source(slices(answerJson('d'.repeat(500)), 100));
    serve(src);

    const error = await rejection(sidecarConfig(), bodyWithText(10));

    assert.ok(error instanceof AdmissionOverBudgetError, `expected a §5.9 refusal, got ${String(error)}`);
    assert.match(error.message, /max_materialized_body_bytes/);
    assert.doesNotMatch(error.message, /privacy filter unavailable/);
    // A refused read holds nothing: no bytes on disk, no reservation, no waiter.
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(getAdmittedBytes(), 0);
  });

  it('charges the budget for a read it admits, and gives the lease back', async () => {
    configureSpool({ maxMaterializedBodyBytes: 1 << 20 });
    const src = source(slices(answerJson('clean text'), 1024));
    serve(src);

    const body = bodyWithText(5);
    await redactBody(sidecarConfig(), body);

    assert.equal((body.messages as any)[0].content, 'clean text');
    assert.equal(getAdmittedBytes(), 0, 'the lease must be released before redactBody returns');
  });
});

// ---------------------------------------------------------------------------
// The ordinary failure kind is still wrapped
// ---------------------------------------------------------------------------

describe('redactSidecar — an ordinary sidecar fault', () => {
  it('still reports an unparseable answer as the sidecar being unavailable', async () => {
    configureSpool();
    const src = source(slices('not json at all', 4));
    serve(src);

    const error = await rejection(sidecarConfig(), bodyWithText(10));

    assert.ok(!(error instanceof ClaudeProxyError), 'a malformed answer is the sidecar\'s fault, not a proxy limit');
    assert.match((error as Error).message, /privacy filter unavailable/);
  });
});
