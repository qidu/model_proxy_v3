/**
 * SSD spool — the §5.7 per-response/per-event scratch blob store.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md (§5.4, §5.5,
 * §5.7, §9.2).
 *
 * §5.7 has a converted response fully parsed so its allowlisted binary payloads
 * can be streamed back to the client as blob chunks instead of being
 * re-serialized into one string. Those payloads must not become cache entries:
 *
 *   - "Response blobs are per-response scratch and do **not** populate the
 *     cross-request blob cache by default." A response payload is sent once, to
 *     one client; caching it would evict a *request* blob that a retry can still
 *     use, and would keep a generated image on disk past the response that asked
 *     for it.
 *   - §5.5: "for a per-response/event scratch blob, final release schedules
 *     deletion. Close file handles before unlink."
 *
 * So this store is an **instance**, created for one response body (or one SSE
 * event object) and thrown away with it, not a module-level singleton like
 * `blob-store.ts`. Two concurrent responses hold two stores and share nothing —
 * not an index, not a ref count, not a file.
 *
 * What it shares with the cross-request cache is the *addressing*: content-addressed
 * by the sha256 of the base64 text, so two identical payloads in one response are
 * one file under two leases, and a ref records the same `{hash, size}` shape the
 * ref layer and the §5.3 serializer already understand ({@link RefStorage}).
 *
 * Files live directly in an already-swept spill directory (`responses/`, `events/`
 * — §5.5's sweep walks them non-recursively), named
 * `<file-prefix><store-id>-<hash>.blob`. The store id is what keeps two live
 * responses from colliding on one payload: a shared cache may reuse the same file
 * for the same bytes, but a scratch store that deleted its file at the end of a
 * response must never delete another response's copy. A leftover file — a crash,
 * a killed process — is an ordinary old regular file in a swept directory, so the
 * startup sweep removes it without learning a second layout.
 *
 * Decisions baked in here:
 *   - Fail loud (repo rule #8): a write that fails removes its partial file and
 *     throws, a read of a file that is shorter than recorded throws instead of
 *     streaming a truncated payload, and a release with no lease to give back
 *     throws rather than silently under-counting. A failed deletion is reported
 *     and recorded for {@link ResponseBlobStore.dispose}, which reports what it
 *     could not clean up.
 *   - Deletion is *scheduled* by the final release (§5.5), so `release()` stays
 *     synchronous and can be driven from a `finally` through the same
 *     {@link RefStorage} contract the cache path uses; `dispose()` awaits those
 *     deletions, which is where a reader that still had the file open has closed
 *     it and the unlink can succeed.
 *   - No hash validation: unlike the cache index, a hash never becomes a path
 *     here. The path is built once, at `put`, from a hash this process computed,
 *     and every later call looks the hash up in this store's own map. A forged or
 *     foreign hash therefore finds nothing and is refused, which is stronger than
 *     validating a shape (contrast `blob-store.ts`'s `assertHash`).
 *   - `[spool] enabled = false` refuses construction: the store exists to keep
 *     payloads off the heap, and callers gate on the config (§9.1).
 */

import { createHash, randomBytes } from 'crypto';
import { readFile, rm, writeFile } from 'fs/promises';
import { join } from 'path';

import type { RefStorage } from './blob-refs.js';
import { BLOB_STREAM_CHUNK_BYTES, BlobStoreError } from './blob-store.js';
import { readSizedFileChunks } from './spool-chunks.js';
import { spillDir } from './spool-body.js';
import { EVENT_SPILL_SUBDIR, getSpoolConfig, RESPONSE_SPILL_SUBDIR } from './spool.js';

/** Where one store's files go: a swept spill directory and a file-name prefix. */
export interface ScratchScope {
  /** Subdirectory of `[spool] dir` — must be one the startup sweep walks (§5.5). */
  subdir: string;
  /** File-name prefix, so a leftover file names what wrote it. */
  filePrefix: string;
}

/** The scope for a non-SSE response body's scratch blobs. */
export const RESPONSE_BLOB_SCOPE: ScratchScope = {
  subdir: RESPONSE_SPILL_SUBDIR,
  filePrefix: 'resp-blob-',
};

/** The scope for one SSE event's scratch blobs. */
export const EVENT_BLOB_SCOPE: ScratchScope = {
  subdir: EVENT_SPILL_SUBDIR,
  filePrefix: 'evt-blob-',
};

/** One stored payload, and the owners sharing it within this store. */
interface ScratchEntry {
  /** Absolute path of the file holding the base64 text. */
  path: string;
  /** Payload byte count (= base64 character count, base64 being ASCII). */
  size: number;
  /** Owners holding this payload. Two identical payloads are one file, two leases. */
  refs: number;
}

/** A deletion the final release scheduled, and what became of it. */
export interface ScratchFailure {
  /** The file whose removal failed. */
  path: string;
  /** Why it failed. */
  reason: string;
}

/** What {@link ResponseBlobStore.dispose} found when it cleaned up. */
export interface ScratchDisposalReport {
  /** Files this store successfully removed. */
  deleted: number;
  /** Files it could not remove, each with the reason. */
  failed: ScratchFailure[];
  /**
   * Payloads still leased at disposal — the abort path, where a response ended
   * before every ref was released — one count per *lease*, not per payload, so a
   * payload held under two refs reports the two owners that never gave it back.
   * Their files are deleted anyway: the whole store is scratch for one exchange
   * that is over.
   */
  leaked: number;
}

/**
 * One response's (or one event's) scratch blobs.
 *
 * Implements {@link RefStorage}, so the ref layer's extraction, rehydration and
 * release all work unchanged against it — that is what keeps response payloads
 * out of the cross-request cache without a second extraction implementation.
 */
export class ResponseBlobStore implements RefStorage {
  private readonly dir: string;
  /** `<filePrefix><storeId>-`, so this store's files never collide with another's. */
  private readonly namePrefix: string;
  /** This store's payloads. Instance state by design: nothing outlives the response. */
  private readonly entries = new Map<string, ScratchEntry>();
  /** Deletions scheduled by a final release, awaited by {@link dispose}. */
  private readonly deletions: Promise<void>[] = [];
  private readonly failures: ScratchFailure[] = [];
  private deleted = 0;
  private leakedRefs = 0;
  private disposed = false;

  constructor(scope: ScratchScope = RESPONSE_BLOB_SCOPE) {
    const config = getSpoolConfig();
    if (!config.enabled) {
      throw new BlobStoreError('[spool] response scratch blob store used while [spool] enabled = false');
    }
    this.dir = spillDir(config, scope.subdir);
    this.namePrefix = `${scope.filePrefix}${randomBytes(8).toString('hex')}-`;
  }

  /**
   * Store a base64 payload and take its first lease, or take one more lease on a
   * payload this store already holds.
   *
   * The record is written before it is indexed, so a reader can never see a hash
   * whose file is not whole; a failed write removes its partial file and throws.
   * Unlike the cross-request cache this never evicts and never reuses another
   * response's file — there is no budget to defend, because the whole store is
   * deleted with the response it belongs to and its size is bounded by
   * `max_response_bytes` (§5.7).
   */
  async put(base64: string): Promise<{ hash: string; size: number }> {
    this.assertOpen('store into');
    const hash = createHash('sha256').update(base64, 'utf8').digest('hex');
    const existing = this.entries.get(hash);
    if (existing) {
      existing.refs += 1;
      return { hash, size: existing.size };
    }

    const size = Buffer.byteLength(base64, 'utf8');
    const path = join(this.dir, `${this.namePrefix}${hash}.blob`);
    try {
      await writeFile(path, base64, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      // A partial file must not survive a failed write: nothing indexes it, so
      // nothing would ever remove it.
      await discardScratchFile(path);
      throw new BlobStoreError(`[spool] cannot write response scratch blob ${path}: ${(error as Error).message}`);
    }
    this.entries.set(hash, { path, size, refs: 1 });
    return { hash, size };
  }

  /**
   * Give back one lease. The last release schedules the file's deletion (§5.5).
   *
   * Synchronous so that this store satisfies the same release contract as the
   * cache ({@link RefStorage}), which lets the ref layer release an extraction
   * from either store. The unlink itself runs asynchronously and is awaited by
   * {@link dispose} — the point at which every reader has closed its handle.
   *
   * Throws on a hash this store does not hold — never stored here, or already
   * released, which is the same accounting bug either way: a silent decrement
   * would hide a leaked lease, and a second delete would remove a file another
   * ref of this store still reads.
   */
  release(hash: string): void {
    const entry = this.entries.get(hash);
    if (!entry) {
      throw new BlobStoreError(`[spool] cannot release response scratch blob ${hash}: it is not in this store`);
    }
    entry.refs -= 1;
    if (entry.refs > 0) return;

    // Gone from the map before the unlink runs: after the final release the
    // payload is not readable any more, whether or not the file is still there.
    this.entries.delete(hash);
    this.scheduleRemoval(entry.path);
  }

  /**
   * The base64 payload, for the rehydrating read (§5.3 shape 2).
   *
   * Throws when the hash is not in this store (released, or another response's),
   * when the file cannot be read, and when it is not exactly the recorded length
   * — a partial payload must never be substituted for the real one (repo rule #8).
   */
  async read(hash: string): Promise<string> {
    const entry = this.live(hash);
    let bytes: Buffer;
    try {
      bytes = await readFile(entry.path);
    } catch (error) {
      throw new BlobStoreError(`[spool] cannot read response scratch blob ${hash}: ${(error as Error).message}`);
    }
    if (bytes.byteLength !== entry.size) {
      throw new BlobStoreError(
        `[spool] response scratch blob ${hash} is ${bytes.byteLength} bytes on disk but recorded as ${entry.size}`,
      );
    }
    return bytes.toString('utf8');
  }

  /**
   * The payload as bounded chunks, for a streamed egress (§5.7: "stream the JSON
   * skeleton interleaved with blob chunks").
   *
   * Never materializes the payload, and never yields a short one: the exact-length
   * read is shared with the cross-request cache (`spool-chunks.ts`). The generator
   * owns the file handle and closes it before the consumer resumes, which is the
   * "close file handles before unlink" ordering §5.5 asks for — a caller that
   * releases the ref as soon as the last chunk has been taken therefore deletes a
   * file no one is reading.
   */
  async *readChunks(hash: string, chunkBytes: number = BLOB_STREAM_CHUNK_BYTES): AsyncGenerator<Uint8Array> {
    const entry = this.live(hash);
    yield* readSizedFileChunks({
      path: entry.path,
      bytes: entry.size,
      chunkBytes,
      label: `response scratch blob ${hash}`,
      lengthLabel: 'recorded',
      error: (message) => new BlobStoreError(message),
    });
  }

  /** How many payloads this store currently holds, for assertions and reporting. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Delete everything this store still holds and await every scheduled deletion.
   *
   * This is the abort path (§5.7: "close file handles before deleting spills and
   * scratch blobs") and the belt to the last release's braces. Leases still held
   * here are counted in `leaked` — a response that ended before every ref was
   * released is worth saying out loud — and their files are removed anyway,
   * because nothing outside this store can hold a lease that outlives it.
   *
   * Never throws: it runs from `finally` paths, where it would mask the outcome
   * the request is reporting. Every failure is in the returned report.
   */
  async dispose(): Promise<ScratchDisposalReport> {
    if (this.disposed) return { deleted: this.deleted, failed: this.failures, leaked: this.leakedRefs };
    this.disposed = true;

    for (const entry of this.entries.values()) {
      this.leakedRefs += entry.refs;
      this.scheduleRemoval(entry.path);
    }
    this.entries.clear();
    await Promise.all(this.deletions);

    return { deleted: this.deleted, failed: this.failures, leaked: this.leakedRefs };
  }

  /** Queue one file removal, recording (never throwing on) a failure. */
  private scheduleRemoval(path: string): void {
    const removal = rm(path, { force: true }).then(
      () => {
        this.deleted += 1;
      },
      (error: unknown) => {
        // Opportunistic cleanup on a terminal path: the request's own outcome is
        // the report, and this says what was left on disk for the sweep.
        this.failures.push({ path, reason: (error as Error).message });
        console.warn(`[spool] failed to remove response scratch blob ${path}: ${(error as Error).message}`);
      },
    );
    this.deletions.push(removal);
  }

  /** The entry for `hash`, refusing one this store does not hold. */
  private live(hash: string): ScratchEntry {
    this.assertOpen('read from');
    const entry = this.entries.get(hash);
    if (!entry) {
      throw new BlobStoreError(`[spool] response scratch blob ${hash} is not in this store`);
    }
    return entry;
  }

  /** Refuse use of a disposed store instead of silently doing nothing with it. */
  private assertOpen(action: string): void {
    if (this.disposed) {
      throw new BlobStoreError(`[spool] cannot ${action} a disposed response scratch blob store`);
    }
  }
}

/**
 * Remove a file whose write failed. Reports a failure instead of throwing: the
 * write error is what the caller must see, and a leftover file is exactly what
 * the startup sweep exists for (§5.5).
 */
async function discardScratchFile(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (error) {
    console.warn(`[spool] failed to remove partial response scratch blob ${path}: ${(error as Error).message}`);
  }
}
