/**
 * Unit tests for the §5.7 per-response/per-event scratch blob store
 * (src/utils/response-blobs.ts).
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.4, §5.5,
 * §5.7, §10.
 *
 * What this layer has to prove, beyond "a round trip works":
 *   - Completion: a payload is readable until its last lease is released, and the
 *     file is gone once `dispose` has awaited the deletions the final release
 *     scheduled.
 *   - Abort: a response that ends before every ref was released still leaves
 *     nothing on disk, and the leaked leases are *reported* rather than counted as
 *     deletes (repo rule #8).
 *   - Disk failure: a write that fails leaves neither an index entry nor a partial
 *     file, a file shorter than recorded is refused instead of streamed, and a
 *     deletion that fails is reported in `dispose`'s `failed` list.
 *   - Handle-close ordering (§5.5): the chunked read owns the file handle and
 *     closes it before control returns to the consumer, so the release that
 *     follows the last chunk deletes a file nobody is reading.
 *   - Isolation: two stores never share an index or a file, so one response's
 *     cleanup cannot remove another's payload — and none of it reaches the §5.4
 *     cross-request cache.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BlobStoreError, getBlobStoreStats, resetBlobStore } from '../../src/utils/blob-store.js';
import {
  EVENT_BLOB_SCOPE,
  RESPONSE_BLOB_SCOPE,
  ResponseBlobStore,
  type ScratchScope,
} from '../../src/utils/response-blobs.js';
import { resolveSpoolConfig, setSpoolConfig, type SpoolConfig, type SpoolTomlConfig } from '../../src/utils/spool.js';

const scratchDirs: string[] = [];

/** A fresh temp directory that the test cleanup removes afterwards. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'response-blobs-test-'));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratchDirs) {
    try {
      chmodSync(dir, 0o700);
    } catch { /* already writable or already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A distinct, valid base64 payload of exactly `chars` bytes. */
function payload(seed: string, chars: number): string {
  assert.equal(chars % 4, 0, 'base64 length must be a multiple of 4 for an exact size');
  const text = Buffer.alloc((chars / 4) * 3, seed.charCodeAt(0)).toString('base64');
  assert.equal(text.length, chars, 'payload helper must produce the requested byte count');
  return text;
}

/** A live enabled spool rooted in a fresh scratch directory. */
function useConfig(overrides: Partial<SpoolTomlConfig> = {}): SpoolConfig {
  const config = resolveSpoolConfig({ enabled: true, dir: scratch(), ...overrides });
  setSpoolConfig(config);
  resetBlobStore();
  return config;
}

/** Every file name directly inside one swept spill directory (§5.5). */
function spillFiles(config: SpoolConfig, scope: ScratchScope = RESPONSE_BLOB_SCOPE): string[] {
  const dir = join(config.dir, scope.subdir);
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** The single file a one-payload store wrote. */
function onlyFile(config: SpoolConfig, scope: ScratchScope = RESPONSE_BLOB_SCOPE): string {
  const files = spillFiles(config, scope);
  assert.equal(files.length, 1, `expected exactly one scratch file, saw ${files.join(', ')}`);
  return join(config.dir, scope.subdir, files[0]);
}

/** Collect a chunk generator, so a streamed read can be compared to the payload. */
async function collect(chunks: AsyncGenerator<Uint8Array>): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts).toString('utf8');
}

beforeEach(() => {
  resetBlobStore();
});

describe('the completion path — leases, reads and deletion', () => {
  it('holds a payload until its last lease is released, then deletes the file', async () => {
    const config = useConfig();
    const base64 = payload('a', 200);
    const store = new ResponseBlobStore();

    const first = await store.put(base64);
    const second = await store.put(base64);

    // Content-addressed within the store: one file, two leases (§5.4, per response).
    assert.equal(first.hash, second.hash, 'the same payload is the same scratch blob');
    assert.equal(first.size, 200);
    assert.equal(second.size, 200);
    assert.equal(store.size, 1);
    assert.match(
      spillFiles(config)[0],
      /^resp-blob-[0-9a-f]{16}-[0-9a-f]{64}\.blob$/,
      'a scratch file names its store id and the payload hash',
    );
    assert.equal(readFileSync(onlyFile(config), 'utf8'), base64, 'the file holds exactly the base64 text');

    assert.equal(await store.read(first.hash), base64);

    // The first release leaves the payload readable: one lease remains.
    store.release(first.hash);
    assert.equal(store.size, 1);
    assert.equal(await store.read(first.hash), base64);

    // The last release schedules the deletion and makes the payload unreadable.
    store.release(second.hash);
    assert.equal(store.size, 0);
    await assert.rejects(store.read(first.hash), (error: unknown) => {
      assert.ok(error instanceof BlobStoreError, `expected BlobStoreError, got ${String(error)}`);
      assert.match((error as Error).message, /is not in this store/);
      return true;
    });

    assert.deepStrictEqual(await store.dispose(), { deleted: 1, failed: [], leaked: 0 });
    assert.deepStrictEqual(spillFiles(config), [], 'the scratch file is gone once dispose awaited the deletion');
    assert.deepStrictEqual(getBlobStoreStats(), { cacheBytes: 0, cacheEntries: 0, diskBytes: 0, diskEntries: 0 });
  });

  it('streams the payload in exact chunks and closes the handle before the last chunk is acknowledged', async () => {
    const config = useConfig();
    const base64 = payload('b', 200);
    const store = new ResponseBlobStore();
    const stored = await store.put(base64);

    const chunks: Uint8Array[] = [];
    const reader = store.readChunks(stored.hash, 64);
    for (let step = await reader.next(); !step.done; step = await reader.next()) chunks.push(step.value);

    assert.deepStrictEqual(chunks.map((chunk) => chunk.byteLength), [64, 64, 64, 8], 'every chunk but the last is full');
    assert.equal(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'), base64);

    // §5.5 ordering: the generator has closed its handle by the time it reports
    // done, so releasing here deletes a file no reader holds open.
    store.release(stored.hash);
    assert.deepStrictEqual(await store.dispose(), { deleted: 1, failed: [], leaked: 0 });
    assert.deepStrictEqual(spillFiles(config), []);
  });

  it('refuses a released or foreign hash instead of under-counting the release', async () => {
    useConfig();
    const store = new ResponseBlobStore();
    const stored = await store.put(payload('c', 48));
    const other = new ResponseBlobStore();
    const elsewhere = await other.put(payload('d', 48));

    assert.throws(() => other.release(stored.hash), (error: unknown) => {
      assert.ok(error instanceof BlobStoreError, `expected BlobStoreError, got ${String(error)}`);
      assert.match((error as Error).message, /not in this store/);
      return true;
    });

    store.release(stored.hash);
    assert.throws(() => store.release(stored.hash), /not in this store/, 'a second release is an accounting bug');

    other.release(elsewhere.hash);
    await store.dispose();
    assert.deepStrictEqual(await other.dispose(), { deleted: 1, failed: [], leaked: 0 });
  });
});

describe('the abort path — a response that ends before its refs are released', () => {
  it('deletes every remaining payload and reports the leases it had to break', async () => {
    const config = useConfig();
    const store = new ResponseBlobStore();
    const kept = await store.put(payload('e', 48));
    await store.put(payload('f', 48));
    const duplicated = await store.put(payload('g', 48));
    await store.put(payload('g', 48));

    store.release(kept.hash);
    assert.equal(store.size, 2, 'the released payload is gone; the other two are still leased');

    const report = await store.dispose();

    // Two payloads were still held, under three leases (one of them twice). All
    // three files are deleted — the released one when it was released, the other
    // two by dispose — and the three broken leases are named as leaked.
    assert.deepStrictEqual(report, { deleted: 3, failed: [], leaked: 3 });
    assert.deepStrictEqual(spillFiles(config), [], 'nothing is left on disk for the sweep to find');
    assert.equal(duplicated.size, 48);
  });

  it('is idempotent and refuses further use rather than silently doing nothing', async () => {
    useConfig();
    const store = new ResponseBlobStore();
    const stored = await store.put(payload('h', 48));

    const first = await store.dispose();
    assert.deepStrictEqual(first, { deleted: 1, failed: [], leaked: 1 });
    assert.deepStrictEqual(await store.dispose(), first, 'a second dispose reports the same outcome');

    await assert.rejects(store.put(payload('i', 48)), /disposed response scratch blob store/);
    await assert.rejects(store.read(stored.hash), /disposed response scratch blob store/);
    await assert.rejects(collect(store.readChunks(stored.hash)), /disposed response scratch blob store/);
    assert.throws(() => store.release(stored.hash), /not in this store/);
  });
});

describe('disk failures', () => {
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it('never indexes a payload whose write failed, and leaves no partial file', { skip: asRoot ? 'running as root: permission checks do not apply' : false }, async () => {
    const config = useConfig();
    const store = new ResponseBlobStore();
    const dir = join(config.dir, RESPONSE_BLOB_SCOPE.subdir);
    chmodSync(dir, 0o500); // read + traverse, no write

    try {
      await assert.rejects(store.put(payload('j', 48)), (error: unknown) => {
        assert.ok(error instanceof BlobStoreError, `expected BlobStoreError, got ${String(error)}`);
        assert.match((error as Error).message, /cannot write response scratch blob/);
        return true;
      });
      assert.equal(store.size, 0, 'a payload that was not written must not be readable or releasable');
    } finally {
      chmodSync(dir, 0o700);
    }

    assert.deepStrictEqual(spillFiles(config), [], 'the failed write left no file behind');
    assert.deepStrictEqual(await store.dispose(), { deleted: 0, failed: [], leaked: 0 });
  });

  it('refuses a file shorter than recorded instead of serving a truncated payload', async () => {
    const config = useConfig();
    const store = new ResponseBlobStore();
    const stored = await store.put(payload('k', 200));
    truncateSync(onlyFile(config), 64);

    await assert.rejects(store.read(stored.hash), /is 64 bytes on disk but recorded as 200/);
    await assert.rejects(collect(store.readChunks(stored.hash, 32)), /is 64 bytes on disk but recorded as 200/);

    store.release(stored.hash);
    assert.deepStrictEqual(await store.dispose(), { deleted: 1, failed: [], leaked: 0 });
  });

  it('reports a deletion it could not perform, and never counts it as removed', { skip: asRoot ? 'running as root: permission checks do not apply' : false }, async () => {
    const config = useConfig();
    const store = new ResponseBlobStore();
    const stored = await store.put(payload('l', 48));
    const path = onlyFile(config);
    const dir = join(config.dir, RESPONSE_BLOB_SCOPE.subdir);
    chmodSync(dir, 0o500);

    try {
      store.release(stored.hash);
      const report = await store.dispose();
      assert.equal(report.deleted, 0, 'a file that survived must never be counted as removed');
      assert.equal(report.leaked, 0);
      assert.equal(report.failed.length, 1);
      assert.equal(report.failed[0].path, path);
      assert.notEqual(report.failed[0].reason, '', 'the report says why the deletion failed');
      assert.equal(existsSync(path), true, 'the file a failed deletion left behind stays on disk for the sweep');
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});

describe('scope and isolation', () => {
  it('writes into the directory its scope names, so no new sweep layout is introduced', async () => {
    const config = useConfig();
    const response = new ResponseBlobStore(RESPONSE_BLOB_SCOPE);
    const event = new ResponseBlobStore(EVENT_BLOB_SCOPE);
    const fromResponse = await response.put(payload('m', 48));
    const fromEvent = await event.put(payload('n', 48));

    assert.equal(fromResponse.hash === fromEvent.hash, false);
    assert.match(spillFiles(config, RESPONSE_BLOB_SCOPE)[0], /^resp-blob-[0-9a-f]{16}-[0-9a-f]{64}\.blob$/);
    assert.match(spillFiles(config, EVENT_BLOB_SCOPE)[0], /^evt-blob-[0-9a-f]{16}-[0-9a-f]{64}\.blob$/);
    assert.equal(statSync(onlyFile(config, EVENT_BLOB_SCOPE)).size, 48);

    await response.dispose();
    await event.dispose();
    assert.deepStrictEqual(spillFiles(config, RESPONSE_BLOB_SCOPE), []);
    assert.deepStrictEqual(spillFiles(config, EVENT_BLOB_SCOPE), []);
  });

  it('keeps two live responses apart: one cleanup cannot delete another response payload', async () => {
    const config = useConfig();
    const first = new ResponseBlobStore();
    const second = new ResponseBlobStore();
    const shared = payload('o', 48);

    const a = await first.put(shared);
    const b = await second.put(shared);

    // The same base64 text, addressed identically — but two files, because each
    // response owns its own copy and deletes it at a different time (§5.7).
    assert.equal(a.hash, b.hash);
    assert.equal(spillFiles(config).length, 2);

    first.release(a.hash);
    assert.deepStrictEqual(await first.dispose(), { deleted: 1, failed: [], leaked: 0 });
    assert.equal(spillFiles(config).length, 1, 'the other response still holds its file');
    assert.equal(await second.read(b.hash), shared);

    second.release(b.hash);
    assert.deepStrictEqual(await second.dispose(), { deleted: 1, failed: [], leaked: 0 });
    assert.deepStrictEqual(spillFiles(config), []);
    assert.deepStrictEqual(getBlobStoreStats(), { cacheBytes: 0, cacheEntries: 0, diskBytes: 0, diskEntries: 0 });
  });

  it('refuses to exist while [spool] enabled = false, rather than caching on the heap', () => {
    setSpoolConfig(resolveSpoolConfig({ enabled: false, dir: scratch() }));
    assert.throws(
      () => new ResponseBlobStore(),
      (error: unknown) => {
        assert.ok(error instanceof BlobStoreError, `expected BlobStoreError, got ${String(error)}`);
        assert.match((error as Error).message, /\[spool\] enabled = false/);
        return true;
      },
    );
  });
});
