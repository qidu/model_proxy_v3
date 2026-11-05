/**
 * SSD spool — the §5.4 blob store: the RAM + SSD two-level cache behind refs.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md (§5.4, §5.5, §10).
 *
 * A blob is content-addressed by the sha256 of its **base64 text**, not of the
 * decoded bytes: the base64 is what the wire needs, so a hit needs no re-encode
 * and exact-string dedup is enough (§5.4).
 *
 *   - L1 (RAM): `Map<hash, {b64, bytes, lastUsed}>` capped by total *bytes*
 *     (`max_blob_cache_bytes`), least-recently-used evicted first. Admission is
 *     best effort — a payload larger than the whole L1 budget is never promoted,
 *     and L1 eviction never touches the L2 file.
 *   - L2 (SSD): `<spool_dir>/blobs/<aa>/<bb>/<sha256>`, written under a temp name
 *     and renamed into place so the blob becomes visible only once it is whole,
 *     capped by `max_blob_disk_bytes`.
 *   - The L2 index is metadata only — `Map<hash, {size, lastUsed, refs}>` — and
 *     starts empty on every process start: nothing is scanned or deserialized,
 *     so a file from a previous run can never become a cache hit. Only
 *     {@link sweepStaleBlobs} reads those files, and only to delete them.
 *
 * This is the "RAM + SSD two-level cache" of §5.4, not a spill. A spill is one
 * request's own bytes (§5.1, `spool-ingress.ts`) and is never shared between
 * requests.
 *
 * Leases: the index counts the owners sharing a blob's lease (`refs`), and a
 * leased blob is never expired, evicted, or deleted. That count is the whole of
 * §5.5's lease accounting — there is no separate `leaseId`, because a ref's
 * `hash` already names the lease it holds, and no renewal timer, because
 * `lastUsed` only decides anything once `refs` reaches 0 (see `blob-refs.ts`).
 * The §5.4/§9.3 allowlist predicates that decide which inline payloads become
 * blobs, and the §5.2 attempt-body clone, live in `blob-refs.ts`. The
 * `/v1/messages` request path extracts through them — off unless `[spool]
 * enabled = true` (§9.1) — and the attempt-body clone has no caller yet. The
 * §5.3 shape-3 serializer that streams a ref-bearing body back into JSON sits in
 * `ref-serializer.ts`, over this module's {@link readBlobChunks}; it has no caller
 * yet either.
 *
 * Decisions baked in here:
 *   - Fail loud (repo rule #8): a disk cap that cannot be honoured without
 *     breaking a lease throws {@link BlobCapacityError} instead of exceeding the
 *     budget or deleting an active blob, and a blob that is indexed but missing
 *     or truncated throws {@link BlobStoreError} instead of sending a partial
 *     payload.
 *   - Eviction and expiry mirror `src/utils/conversation-store.ts` (insertion-
 *     ordered `Map`, evict on access + opportunistic evict on write) rather than
 *     introducing a second idiom, with one difference: the TTL is *idle* time
 *     measured from the last release (§5.4), so a live exchange holding a ref is
 *     never expired.
 *   - The store only runs with `[spool] enabled = true` (§9.1). With the spool
 *     disabled, {@link putBlob} throws: it exists to keep base64 payloads off
 *     the heap, and silently caching in RAM instead would be the opposite.
 */

import { createHash } from 'crypto';
import { readdirSync, statSync, unlinkSync, type Dirent } from 'fs';
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';

import { ClaudeProxyError } from './errors.js';
import { readSizedFileChunks } from './spool-chunks.js';
import { getSpoolConfig, SPOOL_SWEEP_MIN_AGE_MS, type SpoolConfig } from './spool.js';

/** The disk payload budget cannot be honoured without breaking a lease (§5.4). */
export class BlobCapacityError extends ClaudeProxyError {
  constructor(message: string) {
    super(message, 503, 'over_limit_error');
    this.name = 'BlobCapacityError';
  }
}

/** A blob file could not be written, read back, or trusted. */
export class BlobStoreError extends ClaudeProxyError {
  constructor(message: string) {
    super(message, 500, 'processing_error');
    this.name = 'BlobStoreError';
  }
}

/** A blob the caller holds an active lease on, and what a ref needs to record. */
export interface LeasedBlob {
  /** sha256 of the base64 text — the blob's identity and its file name. */
  hash: string;
  /** Payload byte count (= base64 character count, base64 being ASCII). */
  size: number;
  /** True when the payload was already in the cache; false when just written. */
  cached: boolean;
}

/**
 * The L2 index entry. Metadata only — never the payload.
 *
 * `size` is the blob's on-disk byte count, `lastUsed` drives idle LRU/TTL, and
 * `refs` counts the owners sharing the lease (cloned refs share one lease, §5.5).
 */
interface BlobIndexEntry {
  size: number;
  lastUsed: number;
  refs: number;
}

/** L1 entry: the hot tier, holding the base64 text itself. */
interface BlobCacheEntry {
  b64: string;
  bytes: number;
  lastUsed: number;
}

/** §5.4 index: process-memory only, empty at every start. Insertion order = LRU. */
const index = new Map<string, BlobIndexEntry>();

/** §5.4 L1: insertion-ordered, most recently used last, capped by payload bytes. */
const cache = new Map<string, BlobCacheEntry>();

/** Running L2 payload total, so eviction never needs to `stat` a file (§5.4). */
let diskBytes = 0;

/** Running L1 payload total. */
let cacheBytes = 0;

/** Subdirectory of `[spool] dir` holding the L2 blob payloads (§5.4). */
export const BLOB_SUBDIR = 'blobs';

/** Payload bytes per chunk for {@link readBlobChunks} (§5.3 shape 3 default). */
export const BLOB_STREAM_CHUNK_BYTES = 64 * 1024;

/** `<spool_dir>/blobs` — the root of the L2 tree. */
export function blobRootDir(config: SpoolConfig): string {
  return join(config.dir, BLOB_SUBDIR);
}

/** A blob hash is exactly the sha256 hex of the payload; anything else is a bug. */
const HASH_PATTERN = /^[0-9a-f]{64}$/;

/** A file the sweep owns: a blob, or a temp file from a write that never finished. */
const BLOB_FILE_PATTERN = /^[0-9a-f]{64}(\.tmp-[^/]*)?$/;

/**
 * Reject anything that is not a blob hash.
 *
 * A hash reaches this module from a ref, i.e. from request content, and it is
 * used to build a path. Validating the exact 64-hex shape is what keeps a
 * crafted ref from escaping `<spool_dir>/blobs` — no `..`, no separators, no
 * absolute paths (repo rule #8: refuse, do not sanitize into something else).
 */
function assertHash(hash: string): void {
  if (typeof hash !== 'string' || !HASH_PATTERN.test(hash)) {
    throw new BlobStoreError(`[spool] not a blob hash: ${JSON.stringify(hash)}`);
  }
}

/** `<spool_dir>/blobs/<aa>/<bb>/<sha256>` (§5.4). */
export function blobPath(hash: string): string {
  assertHash(hash);
  return join(blobRootDir(getSpoolConfig()), hash.slice(0, 2), hash.slice(2, 4), hash);
}

/** What the store currently holds. Byte totals are payload bytes, not heap size. */
export interface BlobStoreStats {
  /** L1 payload bytes. */
  cacheBytes: number;
  /** L1 entries. */
  cacheEntries: number;
  /** L2 payload bytes, from the index's running total. */
  diskBytes: number;
  /** L2 index entries (= live blobs). */
  diskEntries: number;
}

/** Read the store's byte/entry totals (tests, operator reporting). */
export function getBlobStoreStats(): BlobStoreStats {
  return {
    cacheBytes,
    cacheEntries: cache.size,
    diskBytes,
    diskEntries: index.size,
  };
}

/**
 * Drop all process-memory state: the L2 index, the L1 cache, and both byte
 * totals. Files are left alone.
 *
 * This is what a restart means for the store (§5.4/§5.5): the index is never
 * recovered from disk, so after a reset an old blob file cannot be a cache hit.
 * Tests use it to isolate cases that share one process.
 */
export function resetBlobStore(): void {
  index.clear();
  cache.clear();
  diskBytes = 0;
  cacheBytes = 0;
}

/** sha256 of the base64 *text* — what the wire carries, so no re-encode on a hit. */
function hashBlob(base64: string): string {
  return createHash('sha256').update(base64, 'utf8').digest('hex');
}

/** True when `entry` is idle and past `ttl_seconds`; leased entries never are. */
function isIdleExpired(entry: BlobIndexEntry, now: number): boolean {
  return entry.refs === 0 && now - entry.lastUsed > getSpoolConfig().ttlSeconds * 1000;
}

/** Move a cache key to the most-recently-used end and return its entry. */
function cacheGet(hash: string): BlobCacheEntry | undefined {
  const entry = cache.get(hash);
  if (!entry) return undefined;
  cache.delete(hash);
  cache.set(hash, entry);
  return entry;
}

/**
 * Promote a payload into L1, evicting least-recently-used entries first.
 *
 * Best effort by design: a payload larger than the whole L1 budget is not
 * promoted at all (§5.4 — "streamed egress should not need to promote a large
 * blob into L1 merely to send it once"), and running out of L1 room is never an
 * error, because the L2 file remains the source of truth.
 */
function cachePut(hash: string, b64: string, bytes: number): void {
  const limit = getSpoolConfig().maxBlobCacheBytes;
  if (bytes > limit) return;

  const existing = cache.get(hash);
  if (existing) {
    cache.delete(hash);
    cacheBytes -= existing.bytes;
  }
  while (cacheBytes + bytes > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    const evicted = cache.get(oldest);
    cache.delete(oldest);
    cacheBytes -= evicted?.bytes ?? 0;
  }
  cache.set(hash, { b64, bytes, lastUsed: Date.now() });
  cacheBytes += bytes;
}

/**
 * Remove a blob from both tiers. Throws when the file cannot be removed, leaving
 * the index untouched: an entry dropped without freeing its bytes would make the
 * running total — and therefore every later cap decision — wrong.
 */
async function dropBlobFile(hash: string): Promise<void> {
  const entry = index.get(hash);
  if (!entry) return;
  try {
    await rm(blobPath(hash), { force: true });
  } catch (error) {
    throw new BlobStoreError(`[spool] cannot remove blob ${hash}: ${(error as Error).message}`);
  }
  index.delete(hash);
  diskBytes -= entry.size;
  // The L1 copy goes too: an evicted blob is gone, not half-gone. L1 has its own
  // independent cap, which is the only path allowed to drop a leased blob's copy.
  const cached = cache.get(hash);
  if (cached) {
    cache.delete(hash);
    cacheBytes -= cached.bytes;
  }
}

/** Delete idle entries past their TTL, reporting (never throwing on) failures. */
async function evictIdle(now: number): Promise<number> {
  const expired = [...index].filter(([, entry]) => isIdleExpired(entry, now));
  let removed = 0;
  for (const [hash] of expired) {
    try {
      await dropBlobFile(hash);
      removed += 1;
    } catch (error) {
      // Opportunistic cleanup must not fail the caller's read: the entry stays
      // indexed with its bytes still counted, which is the honest accounting.
      console.warn(`[spool] cannot expire idle blob ${hash}: ${(error as Error).message}`);
    }
  }
  return removed;
}

/** Free idle L2 room for `size` more bytes, or refuse the write (§5.4). */
async function reserveDiskBytes(size: number, config: SpoolConfig): Promise<void> {
  if (diskBytes + size <= config.maxBlobDiskBytes) return;

  const idle = [...index]
    .filter(([, entry]) => entry.refs === 0)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [hash] of idle) {
    if (diskBytes + size <= config.maxBlobDiskBytes) return;
    await dropBlobFile(hash);
  }

  if (diskBytes + size > config.maxBlobDiskBytes) {
    throw new BlobCapacityError(
      `[spool] blob disk budget exceeded: ${diskBytes} + ${size} bytes > max_blob_disk_bytes ${config.maxBlobDiskBytes} ` +
        `and no idle blob can be freed (${index.size} blob(s) all leased)`,
    );
  }
}

/**
 * Write the payload under a temp name, then rename it into place.
 *
 * The rename is what makes a blob visible: a reader can never observe a
 * half-written file, and a crash leaves only a `.tmp-` name for the startup
 * sweep (§5.4/§5.5). The same tmp+rename pattern is used by
 * `src/utils/config-loader.ts`.
 */
async function writeBlobFile(hash: string, base64: string): Promise<void> {
  const path = blobPath(hash);
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new BlobStoreError(`[spool] cannot create blob dir for ${hash}: ${(error as Error).message}`);
  }

  const tempPath = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    await writeFile(tempPath, base64, { encoding: 'utf8', mode: 0o600 });
    await rename(tempPath, path);
  } catch (error) {
    try {
      await rm(tempPath, { force: true });
    } catch (cleanupError) {
      // The write error is the report; this only says a stray temp file is left
      // for the sweep rather than cleared.
      console.warn(`[spool] cannot clear temp blob ${tempPath}: ${(cleanupError as Error).message}`);
    }
    throw new BlobStoreError(`[spool] cannot write blob ${hash}: ${(error as Error).message}`);
  }
}

/**
 * Store a base64 payload and take its initial lease, returning the hash a ref
 * records.
 *
 * Lookup and lease are one operation (§5.5): an identical payload already in the
 * cache is a hit that only increments `refs`, so eviction cannot interleave
 * between "found it" and "leased it". The caller owns one ref from here on and
 * must call {@link releaseBlob} exactly once for it, plus once per call to
 * {@link retainBlob}.
 *
 * Throws {@link BlobCapacityError} when the disk budget cannot be met without
 * breaking a lease, and {@link BlobStoreError} when the file cannot be written.
 */
export async function putBlob(base64: string): Promise<LeasedBlob> {
  const config = getSpoolConfig();
  if (!config.enabled) {
    throw new Error('[spool] blob store used while [spool] enabled = false');
  }

  const hash = hashBlob(base64);
  const size = Buffer.byteLength(base64, 'utf8');
  const now = Date.now();
  await evictIdle(now);

  const existing = index.get(hash);
  if (existing) {
    existing.refs += 1;
    existing.lastUsed = now;
    // A recurring payload is the hit this cache exists for: promote it for the
    // rehydrating read that is about to follow.
    cachePut(hash, base64, existing.size);
    return { hash, size: existing.size, cached: true };
  }

  await reserveDiskBytes(size, config);
  await writeBlobFile(hash, base64);
  index.set(hash, { size, lastUsed: now, refs: 1 });
  diskBytes += size;
  cachePut(hash, base64, size);
  return { hash, size, cached: false };
}

/**
 * Take one more ref on an existing blob, for an owner that shares its lease
 * (a cloned attempt ref, §5.5). The caller must release it exactly once.
 */
export function retainBlob(hash: string): LeasedBlob {
  assertHash(hash);
  const entry = index.get(hash);
  if (!entry) {
    throw new BlobStoreError(`[spool] cannot lease blob ${hash}: it is not in the cache index`);
  }
  entry.refs += 1;
  entry.lastUsed = Date.now();
  return { hash, size: entry.size, cached: true };
}

/**
 * Give back one ref. The last release starts the blob's idle clock (§5.4): until
 * then nothing may expire or evict it.
 *
 * Throws on an unknown hash or a release with no ref to give back — both are
 * lease-accounting bugs, and a silent decrement would hide a leaked lease or a
 * double release that later deletes a blob someone is still reading.
 */
export function releaseBlob(hash: string): void {
  assertHash(hash);
  const entry = index.get(hash);
  if (!entry) {
    throw new BlobStoreError(`[spool] cannot release blob ${hash}: it is not in the cache index`);
  }
  if (entry.refs <= 0) {
    throw new BlobStoreError(`[spool] blob ${hash} has no active lease to release (refs already 0)`);
  }
  entry.refs -= 1;
  entry.lastUsed = Date.now();
}

/**
 * The base64 payload, from L1 when hot and from the L2 file otherwise, with the
 * tier it came from. A read refreshes the blob's `lastUsed`, which is what keeps
 * an actively re-read blob alive.
 *
 * Throws when the blob is not in the index (evicted, expired, or left by a
 * previous run) or when the file is missing, unreadable, or shorter than the
 * index says — a partial payload must never be substituted for the real one
 * (§5.5, repo rule #8).
 */
export async function readBlob(hash: string): Promise<{ base64: string; source: 'l1' | 'l2' }> {
  assertHash(hash);
  const entry = index.get(hash);
  if (!entry) {
    throw new BlobStoreError(`[spool] blob ${hash} is not in the cache index`);
  }
  if (isIdleExpired(entry, Date.now())) {
    // Lazy expiry on access, as in conversation-store: the entry is gone, so the
    // caller is told the bytes are gone rather than served something stale.
    await evictIdle(Date.now());
    throw new BlobStoreError(`[spool] blob ${hash} expired after ${getSpoolConfig().ttlSeconds}s idle`);
  }
  entry.lastUsed = Date.now();

  const cachedEntry = cacheGet(hash);
  if (cachedEntry) {
    return { base64: cachedEntry.b64, source: 'l1' };
  }

  let bytes: Buffer;
  try {
    bytes = await readFile(blobPath(hash));
  } catch (error) {
    throw new BlobStoreError(`[spool] blob ${hash} is indexed but its file cannot be read: ${(error as Error).message}`);
  }
  if (bytes.byteLength !== entry.size) {
    throw new BlobStoreError(
      `[spool] blob ${hash} is ${bytes.byteLength} bytes on disk but indexed as ${entry.size}`,
    );
  }
  const base64 = bytes.toString('utf8');
  cachePut(hash, base64, entry.size);
  return { base64, source: 'l2' };
}

/**
 * The base64 payload as a stream of chunks, read from the L2 file (§5.3 shape 3).
 *
 * {@link readBlob} materializes the whole payload, which is what rehydration
 * needs — one string to put back in the field. A ref-aware serializer only needs
 * the bytes at the ref's position, so it reads the file in `chunkBytes` pieces
 * and deliberately does *not* promote the blob into L1: §5.4, "streamed egress
 * should not need to promote a large blob into L1 merely to send it once". The L2
 * file is the source of truth for a live blob — L1 eviction drops only the memory
 * copy — so this is a complete read, not a cache-miss fallback.
 *
 * The generator owns the file handle: it closes it on completion, on an error,
 * and on the consumer's early `return()` (a cancelled send). Callers therefore
 * consume it with `for await` or call `return()` explicitly. The read loop itself
 * is shared with the §5.7 scratch store (`spool-chunks.ts`), which has the same
 * exact-length contract for its own files.
 *
 * Throws where {@link readBlob} throws (unknown hash, idle-expired blob, no
 * file) and also when the file is not exactly the indexed length, or ends early
 * mid-read: a partial payload must never be streamed as if it were whole (§5.5,
 * repo rule #8).
 */
export async function* readBlobChunks(
  hash: string,
  chunkBytes: number = BLOB_STREAM_CHUNK_BYTES,
): AsyncGenerator<Uint8Array> {
  assertHash(hash);
  const entry = index.get(hash);
  if (!entry) {
    throw new BlobStoreError(`[spool] blob ${hash} is not in the cache index`);
  }
  if (isIdleExpired(entry, Date.now())) {
    await evictIdle(Date.now());
    throw new BlobStoreError(`[spool] blob ${hash} expired after ${getSpoolConfig().ttlSeconds}s idle`);
  }
  entry.lastUsed = Date.now();

  yield* readSizedFileChunks({
    path: blobPath(hash),
    bytes: entry.size,
    chunkBytes,
    label: `blob ${hash}`,
    lengthLabel: 'indexed',
    error: (message) => new BlobStoreError(message),
  });
}

/**
 * Delete idle entries past their TTL, returning how many were removed. Exposed
 * because the check is otherwise only reached from inside a read or a write, and
 * because the caller that knows an idle period ended (an operator command, a
 * test with a simulated clock) should be able to drive it.
 *
 * Leased blobs are skipped however long they have been held: a slow upstream
 * send, a slow client write, or a pending retry keeps its blob (§5.5).
 */
export async function evictIdleBlobs(now: number = Date.now()): Promise<number> {
  return await evictIdle(now);
}

/** What a startup blob sweep did, including everything it refused to touch. */
export interface BlobSweepResult {
  /** Stale blob (and abandoned temp) files deleted. */
  removed: number;
  /** Files left alone because they are too recent to be crash leftovers. */
  keptRecent: number;
  /** Entries left in place, each with the reason it was not removed. */
  skipped: Array<{ path: string; reason: string }>;
  /** True when the blob root does not exist (nothing to sweep). */
  dirMissing: boolean;
}

/**
 * Delete blob files left behind by a previous run (§5.4/§5.5).
 *
 * The L2 index starts empty and is never reconstructed, so every file on disk at
 * startup belongs to a process that is gone — but only the *old* ones are surely
 * garbage: a worker starting alongside this one may be mid-write in the same
 * directory. The same age threshold as the request-spill sweep applies, and a
 * `.tmp-` file left by a write that never renamed is swept with the blobs.
 *
 * Only the exact `blobs/<aa>/<bb>/<name>` shape is touched: the walk never
 * recurses past two levels and never follows a symlink, so nothing outside the
 * tree can be reached through it. Anything else — a stray file, a nested
 * directory, a suspiciously shallow layout — is reported in the result rather
 * than passed over (repo rule #8). Empty `<aa>/<bb>` directories are left in
 * place: removing them could race a concurrent writer's rename, and the tree is
 * bounded by the 2×2 hex layout. The index is deliberately *not* consulted or
 * populated here.
 */
export function sweepStaleBlobs(
  config: SpoolConfig,
  minAgeMs: number = SPOOL_SWEEP_MIN_AGE_MS,
): BlobSweepResult {
  const root = blobRootDir(config);
  const result: BlobSweepResult = { removed: 0, keptRecent: 0, skipped: [], dirMissing: false };
  const cutoff = Date.now() - minAgeMs;

  let shards: Dirent[];
  try {
    shards = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      result.dirMissing = true;
      return result;
    }
    result.skipped.push({ path: root, reason: `cannot read directory: ${(error as Error).message}` });
    return result;
  }

  for (const shard of shards) {
    const shardPath = join(root, shard.name);
    if (!shard.isDirectory()) {
      result.skipped.push({ path: shardPath, reason: 'not a directory' });
      continue;
    }
    if (!/^[0-9a-f]{2}$/.test(shard.name)) {
      result.skipped.push({ path: shardPath, reason: 'not a blob shard directory' });
      continue;
    }

    let buckets: Dirent[];
    try {
      buckets = readdirSync(shardPath, { withFileTypes: true });
    } catch (error) {
      result.skipped.push({ path: shardPath, reason: `cannot read directory: ${(error as Error).message}` });
      continue;
    }

    for (const bucket of buckets) {
      const bucketPath = join(shardPath, bucket.name);
      if (!bucket.isDirectory()) {
        result.skipped.push({ path: bucketPath, reason: 'not a directory' });
        continue;
      }
      if (!/^[0-9a-f]{2}$/.test(bucket.name)) {
        result.skipped.push({ path: bucketPath, reason: 'not a blob bucket directory' });
        continue;
      }

      let files: Dirent[];
      try {
        files = readdirSync(bucketPath, { withFileTypes: true });
      } catch (error) {
        result.skipped.push({ path: bucketPath, reason: `cannot read directory: ${(error as Error).message}` });
        continue;
      }

      for (const file of files) {
        const path = join(bucketPath, file.name);
        // `isFile()` is false for a symlink, so a link planted here is reported
        // rather than followed — and not deleted either, since it is not ours.
        if (!file.isFile()) {
          result.skipped.push({ path, reason: file.isDirectory() ? 'not a regular file (directory)' : 'not a regular file (symlink or special)' });
          continue;
        }
        if (!BLOB_FILE_PATTERN.test(file.name)) {
          result.skipped.push({ path, reason: 'not a blob file name' });
          continue;
        }

        let mtimeMs: number;
        try {
          mtimeMs = statSync(path).mtimeMs;
        } catch (error) {
          result.skipped.push({ path, reason: `cannot stat: ${(error as Error).message}` });
          continue;
        }
        if (mtimeMs > cutoff) {
          result.keptRecent += 1;
          continue;
        }

        try {
          unlinkSync(path);
          result.removed += 1;
        } catch (error) {
          result.skipped.push({ path, reason: `cannot unlink: ${(error as Error).message}` });
        }
      }
    }
  }

  return result;
}
