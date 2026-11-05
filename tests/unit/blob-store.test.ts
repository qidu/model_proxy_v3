/**
 * Unit tests for the §5.4 blob store (src/utils/blob-store.ts): the RAM + SSD
 * two-level cache behind refs.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.4, §5.5, §10.
 *
 * Covers: content-addressing by the sha256 of the base64 text and the
 * `<blobs>/<aa>/<bb>/<hash>` layout, dedup as a hit with no rewrite, the L1 byte
 * cap and its LRU order, the L2 disk cap with LRU eviction of unleased entries
 * and leased entries pinned, the explicit capacity failure when nothing can be
 * freed, loud failure on a missing or truncated blob file, lease
 * retain/release accounting, idle-TTL expiry with leases protected, the
 * disabled-spool refusal, restart as discard-only, the path-traversal guard, the
 * startup sweep's age threshold and reporting, and the chunked L2 read
 * (`readBlobChunks`) that a shape-3 send serializes over.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BLOB_STREAM_CHUNK_BYTES,
  BLOB_SUBDIR,
  BlobCapacityError,
  BlobStoreError,
  blobPath,
  blobRootDir,
  evictIdleBlobs,
  getBlobStoreStats,
  putBlob,
  readBlob,
  readBlobChunks,
  releaseBlob,
  resetBlobStore,
  retainBlob,
  sweepStaleBlobs,
} from '../../src/utils/blob-store.js';
import { SPOOL_DEFAULTS, SPOOL_SWEEP_MIN_AGE_MS, resolveSpoolConfig, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';

const scratchDirs: string[] = [];

/** A fresh temp directory that the test cleanup removes afterwards. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blob-store-test-'));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratchDirs) {
    try {
      chmodSync(dir, 0o700); // a read-only-dir test may have left it unwritable
    } catch { /* already writable or already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A distinct, valid base64 payload of exactly `chars` bytes.
 *
 * `chars` must be a multiple of 4 so the encoding is exact (no padding, no
 * rounding), which is what makes the byte-cap arithmetic in these tests exact.
 */
function payload(seed: string, chars = 48): string {
  assert.equal(chars % 4, 0, 'base64 length must be a multiple of 4 for an exact size');
  const text = Buffer.alloc((chars / 4) * 3, seed.charCodeAt(0)).toString('base64');
  assert.equal(text.length, chars, 'payload helper must produce the requested byte count');
  return text;
}

/** The sha256 of the base64 *text*, computed independently of the module. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** A live enabled spool rooted in a fresh scratch directory, with the store reset. */
function useConfig(overrides: Partial<SpoolConfig> = {}): SpoolConfig {
  const config = resolveSpoolConfig({ ...SPOOL_DEFAULTS, enabled: true, dir: scratch(), ...overrides });
  setSpoolConfig(config);
  resetBlobStore();
  return config;
}

beforeEach(() => {
  resetBlobStore();
});

/** Assert `fn` throws `kind` whose message mentions `needle`. */
function assertBlobThrows(fn: () => unknown, kind: new (message: string) => Error, needle: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof kind, `expected ${kind.name}, got ${String(caught)}`);
  assert.match((caught as Error).message, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

/** Assert `fn` rejects with `kind` whose message matches `needle`. */
async function assertBlobRejects(fn: () => Promise<unknown>, kind: new (message: string) => Error, needle: RegExp): Promise<Error> {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof kind, `expected ${kind.name}, got ${String(caught)}`);
  assert.match((caught as Error).message, needle);
  return caught as Error;
}

/** Sum the payload bytes of every regular file under `dir`, recursively. */
function onDiskBytes(dir: string): number {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += onDiskBytes(path);
    else if (entry.isFile()) total += statSync(path).size;
  }
  return total;
}

/**
 * Drain an async generator the way a `for await` consumer would, so a test can
 * assert on the chunks themselves rather than only on the bytes they add up to.
 */
async function collect<T>(source: AsyncGenerator<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of source) items.push(item);
  return items;
}

/** Every blob file path currently on disk, relative to the blob root. */
function blobFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name), join(prefix, entry.name));
      else found.push(join(prefix, entry.name));
    }
  };
  if (existsSync(root)) walk(root, '');
  return found.sort();
}

describe('putBlob / readBlob — content addressing and byte identity', () => {
  it('stores the base64 text at <blobs>/<aa>/<bb>/<sha256> and reads it back byte-identical', async () => {
    const config = useConfig({ max_blob_cache_bytes: 16 }); // too small to promote: every read comes from L2
    const b64 = payload('a', 100);

    const stored = await putBlob(b64);

    assert.equal(stored.hash, sha256(b64), 'the hash must be the sha256 of the base64 text, not of the decoded bytes');
    assert.equal(stored.size, 100);
    assert.equal(stored.cached, false, 'a first store is a miss');

    const path = join(config.dir, BLOB_SUBDIR, stored.hash.slice(0, 2), stored.hash.slice(2, 4), stored.hash);
    assert.equal(blobPath(stored.hash), path, 'blobPath must reproduce the documented layout');
    assert.equal(readFileSync(path, 'utf8'), b64, 'the file holds the base64 text itself, so a hit needs no re-encode');
    assert.equal(statSync(path).mode & 0o777, 0o600, 'blob payloads are written 0600');
    assert.equal(statSync(join(config.dir, BLOB_SUBDIR, stored.hash.slice(0, 2), stored.hash.slice(2, 4))).mode & 0o777, 0o700);

    const read = await readBlob(stored.hash);
    assert.equal(read.base64, b64);
    assert.equal(read.source, 'l2', 'with an L1 budget below one payload the read must come from disk');
    assert.equal(read.base64.length, stored.size, 'the recorded size is the payload byte count');
  });

  it('is one file and one write for a repeated payload, with refs counted instead', async () => {
    const config = useConfig({ max_blob_cache_bytes: 16 });
    const b64 = payload('b', 100);

    const first = await putBlob(b64);
    const path = blobPath(first.hash);
    const mtimeBefore = statSync(path).mtimeMs;

    const second = await putBlob(b64);
    assert.equal(second.hash, first.hash);
    assert.equal(second.size, first.size);
    assert.equal(second.cached, true, 'an identical payload is a cache hit');

    assert.deepEqual(blobFiles(blobRootDir(config)), [join(first.hash.slice(0, 2), first.hash.slice(2, 4), first.hash)]);
    assert.equal(statSync(path).mtimeMs, mtimeBefore, 'a hit must not rewrite the file');
    assert.deepEqual(getBlobStoreStats(), { cacheBytes: 0, cacheEntries: 0, diskBytes: 100, diskEntries: 1 });

    // Two puts took two refs, so releasing both is fine and a third is a bug.
    releaseBlob(first.hash);
    releaseBlob(first.hash);
    assertBlobThrows(() => releaseBlob(first.hash), BlobStoreError, 'no active lease to release');
  });

  it('writes through a temp name so a half-written blob is never visible', async () => {
    const config = useConfig();
    const b64 = payload('c', 48);
    await putBlob(b64);

    const names = blobFiles(blobRootDir(config));
    assert.equal(names.length, 1, 'the temp file must be renamed away, not left behind');
    assert.match(names[0], /^[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/);
  });

  it('refuses a hash that is not exactly a sha256 hex, so a ref cannot escape the blob tree', async () => {
    useConfig();
    for (const bad of ['../../etc/passwd', '/etc/passwd', 'a'.repeat(63), 'A'.repeat(64), `${'a'.repeat(64)}/../x`, '']) {
      assertBlobThrows(() => blobPath(bad), BlobStoreError, 'not a blob hash');
      assertBlobThrows(() => retainBlob(bad), BlobStoreError, 'not a blob hash');
      assertBlobThrows(() => releaseBlob(bad), BlobStoreError, 'not a blob hash');
      await assertBlobRejects(() => readBlob(bad), BlobStoreError, /not a blob hash/);
    }
  });

  it('refuses to store anything while [spool] is disabled, and creates no directory', async () => {
    const dir = scratch();
    setSpoolConfig(resolveSpoolConfig({ ...SPOOL_DEFAULTS, enabled: false, dir }));

    let caught: unknown;
    try {
      await putBlob(payload('d'));
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error, 'storing with the spool disabled must fail, not degrade to a RAM-only cache');
    assert.match((caught as Error).message, /\[spool\] enabled = false/);
    assert.equal(caught instanceof BlobStoreError, false, 'this is a wiring bug, not a store (500) failure');
    assert.equal(existsSync(join(dir, BLOB_SUBDIR)), false, 'a disabled spool must not create the blob tree');
  });
});

describe('L1 — the RAM tier', () => {
  it('caps by payload bytes and evicts least-recently-used, leaving the L2 file as the source', async () => {
    const config = useConfig({ max_blob_cache_bytes: 96 });
    const a = payload('e', 48);
    const b = payload('f', 48);
    const c = payload('g', 48);

    const hashA = (await putBlob(a)).hash;
    const hashB = (await putBlob(b)).hash;
    const hashC = (await putBlob(c)).hash;

    // 96-byte budget, 48-byte payloads: two fit, so the first is the one to go.
    assert.deepEqual(getBlobStoreStats(), { cacheBytes: 96, cacheEntries: 2, diskBytes: 144, diskEntries: 3 });
    assert.equal((await readBlob(hashA)).source, 'l2', 'A must have been evicted from L1');
    assert.equal(existsSync(blobPath(hashA)), true, 'L1 eviction must never delete the L2 file');

    // That read promoted A and pushed the then-oldest entry (B) out.
    assert.equal((await readBlob(hashA)).source, 'l1', 'the L2 read promoted A into the hot tier');
    assert.equal((await readBlob(hashC)).source, 'l1', 'C was still hot and reading it refreshes it');
    assert.equal((await readBlob(hashB)).source, 'l2', 'B was evicted by A promoting back in');
    assert.equal((await readBlob(hashA)).source, 'l2', 'reading B pushed A out again');

    const stats = getBlobStoreStats();
    assert.ok(stats.cacheBytes <= 96, `L1 must stay within its byte cap, saw ${stats.cacheBytes}`);
    assert.equal(stats.diskEntries, 3, 'L1 churn must not touch the L2 index');
    assert.equal(stats.diskBytes, 144);
    assert.equal(onDiskBytes(blobRootDir(config)), 144, 'every blob file is still byte-intact');
  });

  it('never promotes a payload larger than the whole L1 budget', async () => {
    useConfig({ max_blob_cache_bytes: 64 });
    const b64 = payload('h', 128);

    const stored = await putBlob(b64);
    assert.deepEqual(getBlobStoreStats(), { cacheBytes: 0, cacheEntries: 0, diskBytes: 128, diskEntries: 1 });
    assert.equal((await readBlob(stored.hash)).source, 'l2');
    assert.equal((await readBlob(stored.hash)).source, 'l2');
    assert.equal(getBlobStoreStats().cacheEntries, 0, 'a streamed one-shot blob must not be hoisted into RAM');
  });

  it('may evict the RAM copy of a leased blob, whose L2 file keeps it readable', async () => {
    useConfig({ max_blob_cache_bytes: 48 });
    const leased = await putBlob(payload('i', 48)); // refs = 1: still leased
    const other = await putBlob(payload('j', 48)); // its promotion evicts the leased RAM copy

    assert.equal((await readBlob(leased.hash)).source, 'l2', 'L1 eviction is independent of leases (§5.4)');
    assert.deepEqual(
      { leased: leased.hash === other.hash, l2: existsSync(blobPath(leased.hash)) },
      { leased: false, l2: true },
    );
    // The lease is intact: this release is the one and only one owed for the put.
    releaseBlob(leased.hash);
    assertBlobThrows(() => releaseBlob(leased.hash), BlobStoreError, 'no active lease to release');
  });
});

describe('L2 — the disk tier and its in-memory index', () => {
  it('evicts idle entries in LRU order once the disk cap would be exceeded', async () => {
    const config = useConfig({ max_blob_disk_bytes: 300, max_blob_cache_bytes: 16 });
    const idleA = await putBlob(payload('k', 100));
    releaseBlob(idleA.hash); // idle, and the oldest
    const pinned = await putBlob(payload('l', 100));
    releaseBlob(pinned.hash); // idle, released after A
    const live = await putBlob(payload('m', 100)); // stays leased

    // 300 bytes exactly fits, so the cap is not yet reached.
    assert.equal(getBlobStoreStats().diskBytes, 300);
    assert.equal(blobFiles(blobRootDir(config)).length, 3);

    const overflow = await putBlob(payload('n', 100));

    assert.equal(existsSync(blobPath(idleA.hash)), false, 'the least recently used unleased blob must go first');
    assert.equal(existsSync(blobPath(pinned.hash)), true, 'a newer unleased blob stays');
    assert.equal(existsSync(blobPath(live.hash)), true, 'a leased blob is never evicted');
    assert.equal(existsSync(blobPath(overflow.hash)), true);

    const stats = getBlobStoreStats();
    assert.equal(stats.diskBytes, 300, 'the running total must reflect exactly one eviction plus one write');
    assert.ok(stats.diskBytes <= config.maxBlobDiskBytes);
    assert.equal(stats.diskEntries, 3);
    assert.equal(onDiskBytes(blobRootDir(config)), stats.diskBytes, 'the index total must match the bytes actually on disk');

    await assertBlobRejects(() => readBlob(idleA.hash), BlobStoreError, /not in the cache index/);
    assert.equal((await readBlob(live.hash)).base64, payload('m', 100), 'the leased blob is untouched and readable');
    assert.equal((await readBlob(pinned.hash)).base64, payload('l', 100));
  });

  it('fails the new write explicitly when every indexed blob is leased, without breaking the cap or a lease', async () => {
    const config = useConfig({ max_blob_disk_bytes: 200, max_blob_cache_bytes: 16 });
    const first = await putBlob(payload('o', 100));
    const second = await putBlob(payload('p', 100));
    const rejected = payload('q', 100);

    const error = (await assertBlobRejects(() => putBlob(rejected), BlobCapacityError, /no idle blob can be freed/)) as BlobCapacityError;
    assert.equal(error.status, 503);
    assert.equal(error.type, 'over_limit_error');

    const stats = getBlobStoreStats();
    assert.equal(stats.diskBytes, 200, 'the rejected write must not be accounted');
    assert.ok(stats.diskBytes <= config.maxBlobDiskBytes, 'the cap must hold even in failure');
    assert.equal(stats.diskEntries, 2, 'no entry may be dropped to make room');
    assert.equal(existsSync(blobPath(sha256(rejected))), false, 'nothing may be written for a refused store');
    assert.equal((await readBlob(first.hash)).base64, payload('o', 100), 'both leases are still honoured');
    assert.equal((await readBlob(second.hash)).base64, payload('p', 100));
  });

  it('throws rather than serving a blob whose file is missing or truncated', async () => {
    const config = useConfig({ max_blob_cache_bytes: 16 });
    const gone = await putBlob(payload('r', 100));
    const cut = await putBlob(payload('s', 100));

    rmSync(blobPath(gone.hash));
    await assertBlobRejects(() => readBlob(gone.hash), BlobStoreError, /cannot be read/);
    // The index is unchanged: only a successful delete may move the byte total.
    assert.equal(getBlobStoreStats().diskBytes, 200, 'a failed read must not rewrite the accounting');

    writeFileSync(blobPath(cut.hash), payload('s', 100).slice(0, 40));
    await assertBlobRejects(() => readBlob(cut.hash), BlobStoreError, /40 bytes on disk but indexed as 100/);
  });

  it('does not resurrect a fresh-process blob from a stale file (restart is discard-only)', async () => {
    const config = useConfig({ max_blob_disk_bytes: 200, max_blob_cache_bytes: 16 });
    const b64 = payload('t', 100);
    const stored = await putBlob(b64);
    releaseBlob(stored.hash);

    resetBlobStore(); // what a restart does to the index (§5.4/§5.5)

    assert.deepEqual(getBlobStoreStats(), { cacheBytes: 0, cacheEntries: 0, diskBytes: 0, diskEntries: 0 });
    assert.equal(existsSync(blobPath(stored.hash)), true, 'nothing but the startup sweep deletes old files');
    await assertBlobRejects(() => readBlob(stored.hash), BlobStoreError, /not in the cache index/);

    const again = await putBlob(b64);
    assert.equal(again.cached, false, 'a previous run\'s file is never a cache hit');
    assert.equal(again.hash, stored.hash, 'the hash is content-derived, so it is stable across runs');
    assert.deepEqual(getBlobStoreStats(), { cacheBytes: 0, cacheEntries: 0, diskBytes: 100, diskEntries: 1 });
    assert.equal(onDiskBytes(blobRootDir(config)), 100, 'one file, counted once');
  });

  it('reports usage totals that follow writes, releases, and resets', async () => {
    useConfig({ max_blob_disk_bytes: 200, max_blob_cache_bytes: 100 });
    const stored = await putBlob(payload('u', 48));
    assert.deepEqual(getBlobStoreStats(), { cacheBytes: 48, cacheEntries: 1, diskBytes: 48, diskEntries: 1 });

    releaseBlob(stored.hash);
    assert.deepEqual(getBlobStoreStats(), { cacheBytes: 48, cacheEntries: 1, diskBytes: 48, diskEntries: 1 }, 'a release changes refs, not sizes');

    resetBlobStore();
    assert.deepEqual(getBlobStoreStats(), { cacheBytes: 0, cacheEntries: 0, diskBytes: 0, diskEntries: 0 });
  });
});

describe('leases', () => {
  it('retains a shared ref and refuses to retain or release an unindexed blob', async () => {
    useConfig();
    const stored = await putBlob(payload('v', 48));

    const clone = retainBlob(stored.hash);
    assert.deepEqual(clone, { hash: stored.hash, size: 48, cached: true }, 'a clone shares the payload and records the same hash and size');

    const unknown = sha256(payload('w', 48));
    assertBlobThrows(() => retainBlob(unknown), BlobStoreError, 'it is not in the cache index');
    assertBlobThrows(() => releaseBlob(unknown), BlobStoreError, 'it is not in the cache index');

    releaseBlob(stored.hash);
    releaseBlob(clone.hash); // the shared lease needs one release per owner
    assertBlobThrows(() => releaseBlob(stored.hash), BlobStoreError, 'no active lease to release');
  });

  it('expires idle blobs past the TTL and never an idle one that is still leased', async () => {
    useConfig({ ttl_seconds: 600 });
    const idle = await putBlob(payload('x', 48));
    releaseBlob(idle.hash);
    const leased = await putBlob(payload('y', 48)); // refs = 1

    const before = Date.now();
    assert.equal(await evictIdleBlobs(before + 599_000), 0, 'inside the TTL nothing expires');
    assert.equal(await evictIdleBlobs(before + 601_000), 1, 'past the TTL the unleased blob expires');

    assert.equal(existsSync(blobPath(idle.hash)), false);
    assert.equal(existsSync(blobPath(leased.hash)), true, 'a lease outlives the idle TTL (§5.5)');
    assert.deepEqual(getBlobStoreStats(), { cacheBytes: 48, cacheEntries: 1, diskBytes: 48, diskEntries: 1 });
    assert.equal((await readBlob(leased.hash)).base64, payload('y', 48), 'the leased blob is served as normal');
    await assertBlobRejects(() => readBlob(idle.hash), BlobStoreError, /not in the cache index/);
  });

  it('keeps the idle clock off the blob while it is leased, starting it at the last release', async () => {
    useConfig({ ttl_seconds: 600 });
    const stored = await putBlob(payload('z', 48));
    const heldFor = Date.now();

    // Leased the whole time: no amount of elapsed idle time may expire it.
    assert.equal(await evictIdleBlobs(heldFor + 60 * 60 * 1000), 0);
    const clone = retainBlob(stored.hash);
    releaseBlob(clone.hash);
    assert.equal(await evictIdleBlobs(heldFor + 60 * 60 * 1000), 0, 'still leased by the original owner');

    const releasedAt = Date.now();
    releaseBlob(stored.hash);
    assert.equal(await evictIdleBlobs(releasedAt + 599_000), 0, 'the idle clock starts at the final release');
    assert.equal(await evictIdleBlobs(releasedAt + 601_000), 1);
    assert.equal(existsSync(blobPath(stored.hash)), false);
  });

  it('reports an idle expiry whose unlink fails instead of claiming it was removed', { skip: typeof process.getuid === 'function' && process.getuid() === 0 ? 'running as root: permission checks do not apply' : false }, async () => {
    const config = useConfig({ ttl_seconds: 600 });
    const stored = await putBlob(payload('1', 48));
    releaseBlob(stored.hash);
    const bucket = join(config.dir, BLOB_SUBDIR, stored.hash.slice(0, 2), stored.hash.slice(2, 4));
    chmodSync(bucket, 0o500); // read + traverse, no write: unlink must fail

    try {
      assert.equal(await evictIdleBlobs(Date.now() + 601_000), 0, 'a file that survived must never be counted as removed');
      assert.equal(existsSync(blobPath(stored.hash)), true);
      assert.equal(getBlobStoreStats().diskBytes, 48, 'the entry stays indexed with its bytes still counted');
      assert.equal(getBlobStoreStats().diskEntries, 1);
    } finally {
      chmodSync(bucket, 0o700);
    }
  });
});

describe('sweepStaleBlobs — the startup sweep (§5.4/§5.5)', () => {
  const HOUR = 60 * 60 * 1000;

  /** Lay out `<root>/blobs/<aa>/<bb>/` for `hash` and return the bucket path. */
  function blobTree(hash: string): { root: string; bucket: string } {
    const root = scratch();
    const bucket = join(root, BLOB_SUBDIR, hash.slice(0, 2), hash.slice(2, 4));
    mkdirSync(bucket, { recursive: true });
    return { root, bucket };
  }

  /** Write a file whose mtime is `ageMs` in the past; returns its path. */
  function writeAged(dir: string, name: string, ageMs: number, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
    return path;
  }

  it('removes aged blobs and abandoned temp files, keeps recent ones, and reports both counts', () => {
    const hash = sha256(payload('2', 48));
    const { root, bucket } = blobTree(hash);
    const stale = writeAged(bucket, hash, 2 * HOUR, payload('2', 48));
    const temp = writeAged(bucket, `${hash}.tmp-${process.pid}-crashed`, 2 * HOUR, 'half-written');
    const fresh = writeAged(bucket, sha256(payload('3', 48)), 10 * 60 * 1000, payload('3', 48));

    const result = sweepStaleBlobs(resolveSpoolConfig({ enabled: true, dir: root }));

    assert.equal(result.removed, 2);
    assert.equal(result.keptRecent, 1);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.dirMissing, false);
    assert.equal(existsSync(stale), false);
    assert.equal(existsSync(temp), false, 'a temp file from a write that never renamed is swept with the blobs');
    assert.equal(readFileSync(fresh, 'utf8'), payload('3', 48), 'a blob recent enough to belong to a live worker survives intact');
    assert.equal(existsSync(bucket), true, 'the shard directories are left in place: removing them races a live writer');
  });

  it('treats the threshold as a minimum age and reports a missing blob root without creating it', () => {
    const hash = sha256(payload('4', 48));
    const { root, bucket } = blobTree(hash);
    const justUnder = writeAged(bucket, hash, HOUR - 60_000, payload('4', 48));
    const justOver = writeAged(bucket, sha256(payload('5', 48)), HOUR + 60_000, payload('5', 48));

    const result = sweepStaleBlobs(resolveSpoolConfig({ enabled: true, dir: root }), HOUR);
    assert.equal(result.removed, 1);
    assert.equal(result.keptRecent, 1);
    assert.equal(existsSync(justOver), false);
    assert.equal(existsSync(justUnder), true);
    assert.ok(SPOOL_SWEEP_MIN_AGE_MS > 10 * 60 * 1000 && SPOOL_SWEEP_MIN_AGE_MS <= 2 * HOUR, `default sweep age out of the documented band: ${SPOOL_SWEEP_MIN_AGE_MS}`);

    const empty = scratch();
    const missing = sweepStaleBlobs(resolveSpoolConfig({ enabled: true, dir: empty }));
    assert.deepEqual(missing, { removed: 0, keptRecent: 0, skipped: [], dirMissing: true });
    assert.equal(existsSync(join(empty, BLOB_SUBDIR)), false);
    assert.deepEqual(readdirSync(empty), []);
  });

  it('touches nothing outside the exact blob layout and reports everything it skips', () => {
    const hash = sha256(payload('6', 48));
    const { root, bucket } = blobTree(hash);
    const outside = writeAged(root, 'unrelated.txt', 2 * HOUR, 'not ours');
    const stray = writeAged(join(root, BLOB_SUBDIR), sha256(payload('7', 48)), 2 * HOUR, 'a blob file at the root is not a blob file');
    const oddName = writeAged(bucket, 'notes.txt', 2 * HOUR, 'not a blob name');
    const nested = join(bucket, 'nested');
    mkdirSync(nested);
    const linkTarget = writeAged(root, 'link-target', 2 * HOUR, 'reachable through a symlink');
    const link = join(bucket, sha256(payload('8', 48)));
    symlinkSync(linkTarget, link);
    const badShard = join(root, BLOB_SUBDIR, 'zz');
    mkdirSync(badShard);
    const badBucket = join(root, BLOB_SUBDIR, hash.slice(0, 2), 'zz');
    mkdirSync(badBucket);
    const stale = writeAged(bucket, sha256(payload('9', 48)), 2 * HOUR, payload('9', 48));

    const result = sweepStaleBlobs(resolveSpoolConfig({ enabled: true, dir: root }));

    assert.equal(result.removed, 1, 'a genuine stale blob is still removed alongside the oddities');
    assert.equal(existsSync(stale), false);
    assert.equal(result.keptRecent, 0);
    assert.equal(readFileSync(outside, 'utf8'), 'not ours', 'a sibling of the blob tree (a spill, say) must not be reached either');
    assert.equal(readFileSync(linkTarget, 'utf8'), 'reachable through a symlink', 'a symlink target must survive');
    assert.equal(existsSync(link), true, 'the link itself is not ours to delete');
    assert.equal(existsSync(nested), true, 'the walk never descends past the bucket level');

    const reasons = new Map(result.skipped.map((entry) => [entry.path, entry.reason]));
    assert.equal(result.skipped.length, 6, `unexpected skip set: ${[...reasons].map(([p, r]) => `${p}: ${r}`).join(' | ')}`);
    assert.equal(reasons.get(stray), 'not a directory');
    assert.equal(reasons.get(badShard), 'not a blob shard directory');
    assert.equal(reasons.get(badBucket), 'not a blob bucket directory');
    assert.equal(reasons.get(oddName), 'not a blob file name');
    assert.equal(reasons.get(nested), 'not a regular file (directory)');
    assert.match(reasons.get(link) ?? '', /symlink or special/);
  });

  it('is a startup operation only: it never reads or writes the in-memory index', async () => {
    const config = useConfig({ max_blob_cache_bytes: 16 }); // keep L1 empty so the deleted file is the only copy
    const stored = await putBlob(payload('0', 48));
    const path = blobPath(stored.hash);
    const when = new Date(Date.now() - 2 * HOUR);
    utimesSync(path, when, when);

    const result = sweepStaleBlobs(config);
    assert.equal(result.removed, 1);
    assert.equal(existsSync(path), false);
    // The sweep deleted a file the running process still has indexed, which is
    // exactly why it must only run at startup, before any blob exists. The index
    // is untouched — the later read fails loudly rather than serving nothing.
    assert.deepEqual(getBlobStoreStats(), { cacheBytes: 0, cacheEntries: 0, diskBytes: 48, diskEntries: 1 });
    await assertBlobRejects(() => readBlob(stored.hash), BlobStoreError, /cannot be read/);
  });
});

describe('readBlobChunks — the chunked L2 read shape 3 serializes over (§5.3)', () => {
  it('yields the stored payload, in order and in chunks of at most chunkBytes', async () => {
    const config = useConfig({ max_blob_cache_bytes: 16 });
    const b64 = payload('w', 200);
    const stored = await putBlob(b64);

    const chunks = await collect(readBlobChunks(stored.hash, 64));

    assert.deepEqual(
      chunks.map((chunk) => chunk.byteLength),
      [64, 64, 64, 8],
      'every chunk but the tail is exactly chunkBytes',
    );
    assert.equal(
      Buffer.concat(chunks).toString('utf8'),
      b64,
      'the chunk sizes plus this concatenation pin down each chunk as a slice of the stored text',
    );
    assert.equal(readFileSync(blobPath(stored.hash), 'utf8'), b64, 'a read must leave the file alone');
    assert.equal(onDiskBytes(blobRootDir(config)), 200, 'and leave no temp or partial file behind');

    // The default chunk size is the streaming one: a small payload arrives whole.
    assert.equal(BLOB_STREAM_CHUNK_BYTES, 64 * 1024);
    const whole = await collect(readBlobChunks(stored.hash));
    assert.equal(whole.length, 1);
    assert.equal(whole[0].byteLength, 200);
  });

  it('reads a non-resident blob without promoting it into L1', async () => {
    useConfig({ max_blob_cache_bytes: 48 }); // exactly one 48-byte payload fits at a time
    const hashA = (await putBlob(payload('x', 48))).hash;
    const hashB = (await putBlob(payload('y', 48))).hash; // this store evicts A: only one fits
    assert.equal(getBlobStoreStats().cacheBytes, 48, 'A must be out of L1 before the chunked read');

    const chunks = await collect(readBlobChunks(hashA, 16));

    assert.equal(Buffer.concat(chunks).toString('utf8'), payload('x', 48), 'the L2 file is the whole payload');
    assert.equal(getBlobStoreStats().cacheBytes, 48, 'a chunked read must not add anything to the RAM tier');
    assert.equal(
      (await readBlob(hashB)).source,
      'l1',
      'B is still the resident payload, so the chunked read did not promote A in its place',
    );
    assert.equal(existsSync(blobPath(hashA)), true, 'and never evicts the blob it just read');

    // The contrast shape 3 exists for: the plain read does promote, and displaces B.
    assert.equal((await readBlob(hashA)).source, 'l2');
    assert.equal((await readBlob(hashB)).source, 'l2', 'readBlob promoted A, so B went back to L2');
  });

  it('refuses an unindexed, unopenable, truncated or shrunken blob instead of streaming part of it', async () => {
    useConfig({ max_blob_cache_bytes: 16 });
    const b64 = payload('1', 200);
    const stored = await putBlob(b64);

    await assertBlobRejects(() => collect(readBlobChunks(sha256(payload('2', 48)), 32)), BlobStoreError, /not in the cache index/);
    await assertBlobRejects(() => collect(readBlobChunks('not-a-hash', 32)), BlobStoreError, /not a blob hash/);
    // A chunk size is validated before anything is opened, like every other argument here.
    for (const bad of [0, -64, 1.5, Number.NaN]) {
      const error = await assertBlobRejects(
        () => collect(readBlobChunks(stored.hash, bad)),
        BlobStoreError,
        /chunk size must be a positive integer/,
      );
      assert.match(error.message, new RegExp(`got ${bad}`));
    }

    const gone = await putBlob(payload('3', 48));
    rmSync(blobPath(gone.hash));
    await assertBlobRejects(
      () => collect(readBlobChunks(gone.hash, 32)),
      BlobStoreError,
      /cannot be opened/,
    );

    // Truncated on disk: refused on the first pull, so not one byte of a payload
    // the index disagrees with can reach the upstream.
    writeFileSync(blobPath(stored.hash), b64.slice(0, 40));
    const truncated = readBlobChunks(stored.hash, 32);
    await assertBlobRejects(() => truncated.next(), BlobStoreError, /40 bytes on disk but indexed as 200/);
    assert.equal((await truncated.next()).done, true, 'a refused read must not then start yielding bytes');

    // Shrunk *after* that check: the read stops at the short file rather than
    // padding it, and what it already handed over was real file content.
    const shrinking = payload('4', 200);
    const shrunk = await putBlob(shrinking);
    const reader = readBlobChunks(shrunk.hash, 64);
    const first = await reader.next();
    assert.equal((first.value as Uint8Array).byteLength, 64);
    writeFileSync(blobPath(shrunk.hash), ''); // truncate under the still-open handle
    await assertBlobRejects(() => reader.next(), BlobStoreError, /ended at 64 of 200/);
    assert.equal(Buffer.concat([first.value as Uint8Array]).toString('utf8'), shrinking.slice(0, 64));
  });
});
