/**
 * Unit tests for the Phase 1 ingress spool (src/utils/spool-ingress.ts).
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.1, §5.2, §5.5, §10.
 *
 * Covers: the in-memory path (and that it writes nothing), early rejection from
 * a declared Content-Length, the authoritative byte counter for unknown-length
 * bodies, spill-from-start, prefix preservation when an unknown-length body
 * crosses the threshold, disk-before-next-pull backpressure, the max_total_bytes
 * ledger (including a mid-upload breach), release ownership, and loud failure
 * when the spill directory is unusable. Also the raw-body ref of §5.1: attached,
 * lost on reconstruction, read without consuming the request body, and loud when
 * the spool behind it is already released.
 *
 * Bodies are compared by sha256 rather than by decoded text: the fixtures are
 * arbitrary bytes, so a text round-trip would compare UTF-8 mangling, not the
 * spool.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  IngressSpool,
  SpoolCapacityError,
  SpoolRequestTooLargeError,
  SpoolWriteError,
  attachIngressSpool,
  getIngressSpool,
  getLiveSpillBytes,
  readIngressSpoolText,
  receiveIngressBody,
} from '../../src/utils/spool-ingress.js';
import { SPOOL_DEFAULTS, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';

const scratchDirs: string[] = [];

/** A fresh temp directory that the test cleanup removes afterwards. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spool-ingress-test-'));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratchDirs) {
    try {
      chmodSync(dir, 0o700); // the unwritable-dir test may have left it read-only
    } catch { /* already writable or already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Install a test config globally. Defaults keep bodies small so a test can cross
 * the threshold with a few hundred bytes; the byte budgets are generous so that
 * one test's leak cannot make the next one fail for the wrong reason.
 */
function configure(overrides: Partial<SpoolConfig> = {}): SpoolConfig {
  const config: SpoolConfig = {
    ...SPOOL_DEFAULTS,
    enabled: true,
    dir: scratch(),
    thresholdBytes: 64,
    maxRequestBytes: 4096,
    maxTotalBytes: 1 << 20,
    ...overrides,
  };
  setSpoolConfig(config);
  return config;
}

afterEach(() => {
  setSpoolConfig(SPOOL_DEFAULTS);
  // The ledger is process-wide: a leak here would silently weaken later tests.
  assert.equal(getLiveSpillBytes(), 0, 'every spool must return its reservation');
});

/** Deterministic, position-dependent bytes: a dropped or reordered byte changes the hash. */
function pattern(size: number, seed = 7): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + seed) % 251;
  return out;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fileSha256(path: string): string {
  return sha256(readFileSync(path));
}

function split(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    out.push(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
  }
  return out;
}

function spillDirOf(config: SpoolConfig): string {
  return join(config.dir, 'requests');
}

/** Names of the spill files currently on disk. */
function spillFiles(config: SpoolConfig): string[] {
  const dir = spillDirOf(config);
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** Total bytes currently written to spill files under `config`. */
function spilledBytes(config: SpoolConfig): number {
  return spillFiles(config).reduce((sum, name) => sum + statSync(join(spillDirOf(config), name)).size, 0);
}

interface Sourced {
  stream: ReadableStream<Uint8Array>;
  pulls: number;
  cancelled: boolean;
  /** Bytes handed to the stream minus bytes already on disk, sampled at each pull. */
  lag: number[];
}

/**
 * A strictly demand-driven source: with highWaterMark 0 the stream pulls only
 * while a read is pending, so `pulls` counts reads the consumer actually asked
 * for and `lag` measures how far the reader runs ahead of the spill file.
 */
function source(chunks: Uint8Array[], config: SpoolConfig, delayMs = 0): Sourced {
  let index = 0;
  let produced = 0;
  const state: Sourced = {
    pulls: 0,
    cancelled: false,
    lag: [],
    stream: null as unknown as ReadableStream<Uint8Array>,
  };
  state.stream = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        state.pulls += 1;
        state.lag.push(produced - spilledBytes(config));
        if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        const chunk = chunks[index++];
        produced += chunk.byteLength;
        controller.enqueue(chunk);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return state;
}

/** Await `promise`, asserting it rejects with `ctor` and a message containing `needle`. */
async function assertRejects(promise: Promise<unknown>, ctor: typeof Error, needle: string): Promise<Error> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ctor, `expected ${ctor.name}, got ${String(caught)}`);
  assert.match((caught as Error).message, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return caught as Error;
}

describe('receiveIngressBody — in-memory path', () => {
  it('keeps a body at or below threshold_bytes in memory and writes nothing', async () => {
    const config = configure();
    const body = pattern(64);
    const spool = await receiveIngressBody(source(split(body, 24), config).stream, { declaredLength: 64 });

    assert.equal(spool.spilled, false);
    assert.equal(spool.path, undefined);
    assert.equal(spool.size, 64);
    assert.equal(sha256(await spool.readBytes()), sha256(body));
    assert.equal(existsSync(spillDirOf(config)), false, 'a below-threshold body must not create a spill directory');
    assert.equal(getLiveSpillBytes(), 0);
    await spool.release();
  });

  it('returns the same in-memory buffer on repeated reads instead of re-copying', async () => {
    const config = configure();
    const body = pattern(50);
    const spool = await receiveIngressBody(source(split(body, 10), config).stream);

    const first = await spool.readBytes();
    const second = await spool.readBytes();
    assert.equal(first, second, 'the in-memory path holds one representation');
    assert.equal(sha256(first), sha256(body));
    await spool.release();
  });

  it('decodes text across chunk boundaries without corrupting multi-byte characters', async () => {
    const config = configure();
    const text = '{"m":"é😀ü"}';
    const body = new TextEncoder().encode(text);
    // Split inside the emoji: a per-chunk decode would produce replacement characters.
    const at = new TextEncoder().encode(text.slice(0, text.indexOf('😀'))).byteLength + 2;
    const spool = await receiveIngressBody(source([body.subarray(0, at), body.subarray(at)], config).stream);

    assert.equal(await spool.readText(), text);
    assert.equal(spool.size, body.byteLength);
    await spool.release();
  });

  it('accepts an absent body as an empty spool', async () => {
    configure();
    const spool = await receiveIngressBody(null);
    assert.equal(spool.size, 0);
    assert.equal(spool.spilled, false);
    assert.equal(await spool.readText(), '');
    await spool.release();
  });

  it('does not touch the disk when the spool is disabled', async () => {
    const config = configure({ enabled: false });
    const body = pattern(512); // above threshold_bytes, below max_request_bytes
    const spool = await receiveIngressBody(source(split(body, 128), config).stream, { declaredLength: 512 });

    assert.equal(spool.spilled, false);
    assert.equal(spool.size, 512);
    assert.equal(sha256(await spool.readBytes()), sha256(body));
    assert.equal(existsSync(spillDirOf(config)), false, 'enabled = false must not write anything');
    await spool.release();
  });
});

describe('receiveIngressBody — caps', () => {
  it('rejects a declared Content-Length above max_request_bytes without reading a byte', async () => {
    const config = configure();
    const src = source([pattern(4097)], config);

    const error = await assertRejects(
      receiveIngressBody(src.stream, { declaredLength: 4097 }),
      SpoolRequestTooLargeError,
      'Content-Length: 4097 bytes exceeds 4096',
    );

    assert.equal((error as SpoolRequestTooLargeError).status, 413);
    assert.equal((error as SpoolRequestTooLargeError).type, 'invalid_request_error');
    assert.equal(src.pulls, 0, 'the declared length is an early-rejection hint: nothing is pulled');
    assert.equal(src.cancelled, true, 'the upload is cancelled so the adapter stops flowing the socket');
    assert.equal(spilledBytes(config), 0);
  });

  it('enforces max_request_bytes by byte count for an unknown length and cancels the upload', async () => {
    const config = configure();
    const src = source(split(pattern(5000), 1000), config, 1);

    const error = await assertRejects(
      receiveIngressBody(src.stream),
      SpoolRequestTooLargeError,
      'Request body too large: exceeded 4096 bytes',
    );

    assert.equal((error as SpoolRequestTooLargeError).status, 413);
    assert.equal(src.cancelled, true, 'the client upload must be cancelled');
    assert.deepEqual(spillFiles(config), [], 'the partial spill must be removed');
    assert.equal(getLiveSpillBytes(), 0, 'the partial reservation must be returned');
  });

  it('charges spilled bytes to max_total_bytes and refuses the next upload', async () => {
    const config = configure({ maxTotalBytes: 400 });
    const firstBody = pattern(300);
    const first = await receiveIngressBody(source(split(firstBody, 100), config).stream, { declaredLength: 300 });

    assert.equal(first.spilled, true);
    assert.equal(getLiveSpillBytes(), 300);

    const secondSrc = source(split(pattern(300, 11), 100), config);
    const error = await assertRejects(
      receiveIngressBody(secondSrc.stream, { declaredLength: 300 }),
      SpoolCapacityError,
      'max_total_bytes 400',
    );

    assert.equal((error as SpoolCapacityError).status, 503);
    assert.equal(getLiveSpillBytes(), 300, 'the refused upload must not change the live total');
    assert.deepEqual(spillFiles(config), [first.path?.split(/[/\\]/).pop()], 'only the first spill may remain');

    await first.release();
    assert.equal(getLiveSpillBytes(), 0);
    assert.deepEqual(spillFiles(config), []);
  });

  it('refuses an upload mid-stream once the budget is exhausted', async () => {
    const config = configure({ maxTotalBytes: 200 });
    const src = source(split(pattern(1000), 100), config, 1);

    const error = await assertRejects(
      receiveIngressBody(src.stream),
      SpoolCapacityError,
      'live spill budget exceeded',
    );

    assert.equal((error as SpoolCapacityError).status, 503);
    assert.ok(src.pulls <= 4, `the upload must be refused before the whole body arrives (pulls: ${src.pulls})`);
    assert.equal(src.cancelled, true);
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('fails loudly when the spill directory is unusable', async () => {
    const config = configure();
    chmodSync(config.dir, 0o500); // the `requests` subdirectory cannot be created

    const error = await assertRejects(
      receiveIngressBody(source(split(pattern(300), 100), config).stream, { declaredLength: 300 }),
      SpoolWriteError,
      'spill directory unusable',
    );

    assert.equal((error as SpoolWriteError).status, 500);
    assert.equal(spilledBytes(config), 0);
    assert.equal(getLiveSpillBytes(), 0);
  });
});

describe('receiveIngressBody — spilling', () => {
  it('spills from the first byte when Content-Length exceeds threshold_bytes', async () => {
    const config = configure();
    const body = pattern(300);
    const spool = await receiveIngressBody(source(split(body, 60), config).stream, { declaredLength: 300 });

    assert.equal(spool.spilled, true);
    assert.equal(spool.size, 300);
    const path = spool.path as string;
    assert.match(path, /requests[/\\]req-.*\.body$/);
    assert.equal(statSync(path).mode & 0o777, 0o600, 'spill files are owner-only');
    assert.equal(statSync(path).size, 300);
    assert.equal(fileSha256(path), sha256(body), 'the spilled file must be byte-identical to the body');
    assert.equal(getLiveSpillBytes(), 300);

    await spool.release();
    assert.equal(existsSync(path), false);
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('preserves the prefix already received when an unknown-length body crosses the threshold', async () => {
    const config = configure(); // threshold 64: the crossing happens on the second 40-byte chunk
    const body = pattern(200);
    const spool = await receiveIngressBody(source(split(body, 40), config).stream);

    assert.equal(spool.spilled, true);
    assert.equal(spool.size, 200);
    assert.equal(statSync(spool.path as string).size, 200, 'prefix and suffix must both be on disk');
    // Byte-identical: the memory-to-file transition dropped nothing.
    assert.equal(fileSha256(spool.path as string), sha256(body));
    await spool.release();
  });

  it('writes each chunk to disk before pulling the next one', async () => {
    const config = configure({ thresholdBytes: 1024, maxRequestBytes: 1 << 20 });
    const chunkSize = 16 * 1024;
    const body = pattern(chunkSize * 16);
    const src = source(split(body, chunkSize), config, 1);

    const spool = await receiveIngressBody(src.stream, { declaredLength: body.byteLength });

    assert.equal(spool.size, body.byteLength);
    assert.equal(spilledBytes(config), body.byteLength);
    assert.equal(src.pulls, 17, 'one pull per chunk plus the closing pull');
    // At every pull the reader must be within a bounded number of chunks of the
    // file. A buffer-then-write implementation would instead grow to body size.
    const maxLag = Math.max(...src.lag);
    assert.ok(maxLag <= 2 * chunkSize, `reader ran ${maxLag} bytes ahead of the spill file (limit ${2 * chunkSize})`);
    assert.equal(fileSha256(spool.path as string), sha256(body));
    await spool.release();
  });

  it('reads a spilled body back from the file at each call', async () => {
    const config = configure();
    const body = pattern(300);
    const spool = await receiveIngressBody(source(split(body, 100), config).stream, { declaredLength: 300 });

    assert.equal((await spool.readBytes()).byteLength, 300);
    // The file is the live source for a spilled body, not a snapshot taken once.
    appendFileSync(spool.path as string, 'X');
    assert.equal((await spool.readBytes()).byteLength, 301);
    assert.equal(spool.size, 300, 'size stays the received byte count');

    await spool.release();
  });

  it('removes the spill file and returns its reservation exactly once', async () => {
    const config = configure();
    const spool = await receiveIngressBody(source(split(pattern(200), 50), config).stream, { declaredLength: 200 });
    const path = spool.path as string;

    await spool.release();
    assert.equal(existsSync(path), false);
    assert.equal(getLiveSpillBytes(), 0);

    await spool.release(); // idempotent: no ledger underflow, no error
    assert.equal(getLiveSpillBytes(), 0);

    await assertRejects(spool.readText(), Error, 'was released');
  });

  it('is an IngressSpool on both paths', async () => {
    const config = configure();
    const small = await receiveIngressBody(source(split(pattern(20), 10), config).stream);
    const large = await receiveIngressBody(source(split(pattern(200), 50), config).stream, { declaredLength: 200 });
    assert.ok(small instanceof IngressSpool);
    assert.ok(large instanceof IngressSpool);
    await small.release();
    await large.release();
  });
});

describe('raw-body ref (§5.1)', () => {
  it('carries the spool across request reconstruction', async () => {
    const config = configure();
    const text = `{"model":"claude-sonnet-5-5","padding":"${'x'.repeat(260)}"}`;
    const bytes = new TextEncoder().encode(text);
    const spool = await receiveIngressBody(source(split(bytes, 100), config).stream, {
      declaredLength: bytes.byteLength,
    });
    assert.equal(spool.spilled, true, 'the fixture must take the spilled path');

    // The adapter re-wraps the raw bytes onto a fresh Request, so the ref has to
    // be re-attached there — `new Request` copies neither properties nor symbols.
    const original = new Request('http://localhost/v1/messages', {
      method: 'POST',
      body: bytes.slice(),
      duplex: 'half',
    } as RequestInit);
    const rebuilt = new Request(original, { body: await spool.readBytes(), duplex: 'half' } as RequestInit);
    assert.equal(getIngressSpool(rebuilt), undefined, 'reconstruction drops the ref, which is why it is re-attached');

    attachIngressSpool(rebuilt, spool);
    assert.equal(getIngressSpool(rebuilt), spool);
    assert.equal(await readIngressSpoolText(rebuilt), text);

    await spool.release();
  });

  it('reads the spool without consuming the request body', async () => {
    const config = configure();
    const text = '{"model":"claude-sonnet-5-5","stream":true}';
    const bytes = new TextEncoder().encode(text);
    const spool = await receiveIngressBody(source([bytes], config).stream, { declaredLength: bytes.byteLength });
    const request = new Request('http://localhost/v1/messages', {
      method: 'POST',
      body: bytes.slice(),
      duplex: 'half',
    } as RequestInit);
    attachIngressSpool(request, spool);

    assert.equal(await readIngressSpoolText(request), text);
    // The routed handlers still call request.json() on some paths (§5.2), so the
    // re-wrapped body must stay readable after the spool read it.
    assert.deepEqual(await request.json(), { model: 'claude-sonnet-5-5', stream: true });

    await spool.release();
  });

  it('falls back to the request body when no ref is attached', async () => {
    const request = new Request('http://localhost/v1/messages', {
      method: 'POST',
      body: '{"a":1}',
      duplex: 'half',
    } as RequestInit);

    assert.equal(await readIngressSpoolText(request), '{"a":1}');
  });

  it('fails loudly when the attached spool was already released', async () => {
    const config = configure();
    const text = `{"model":"claude-sonnet-5-5","padding":"${'y'.repeat(200)}"}`;
    const bytes = new TextEncoder().encode(text);
    const spool = await receiveIngressBody(source([bytes], config).stream, { declaredLength: bytes.byteLength });
    const request = new Request('http://localhost/v1/messages', {
      method: 'POST',
      body: bytes.slice(),
      duplex: 'half',
    } as RequestInit);
    attachIngressSpool(request, spool);

    await spool.release();
    // Not a silent fallback to the (still readable) request body: a body read
    // after the spool is released would return stale bytes for a request the
    // proxy already answered (repo rule #8).
    await assertRejects(readIngressSpoolText(request), Error, 'was released');
  });
});
