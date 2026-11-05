/**
 * SSD spool — the body-spill machinery shared by request ingress and response
 * egress.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md (§5.1, §5.5, §5.7).
 *
 * §5.1 and §5.7 ask the same thing of a body, so the receive loop is written
 * once, here:
 *
 *   - A body at or below `threshold_bytes` stays in memory and is still pulled
 *     one chunk at a time, so a fast writer cannot run ahead of the reader.
 *   - A declared body above `threshold_bytes` spills from the first byte.
 *   - An unknown/chunked body buffers only until the threshold; on crossing it
 *     the prefix already received is written to the file before the rest of the
 *     body keeps flowing to the same file. The prefix is never dropped.
 *   - A declared length is only an early-rejection hint. The byte counter is
 *     authoritative and enforces the side's own cap for every encoding.
 *   - Bytes that reach disk are charged to `max_total_bytes` for as long as the
 *     spill lives. On breach the body is refused with an explicit error and the
 *     partial file is removed — never a silent truncation (repo rule #8).
 *
 * The two directions differ in four values only — the byte cap, the spill
 * subdirectory, the file-name prefix, and the error a cap breach throws — so
 * those are parameters ({@link SpooledBodySpec}); everything else, above all the
 * ledger, is shared. A second copy of the ledger is how one direction quietly
 * stops being charged to `max_total_bytes`.
 *
 * Disk use is opt-in (§9.1). With `enabled = false` nothing is written and the
 * in-memory path keeps the side's own bound, so a disabled spool behaves exactly
 * like the pre-spool proxy. Only spilled bytes are charged to `max_total_bytes`:
 * an in-memory body is bounded by `threshold_bytes` per live body, and §5.9's
 * optional admission budget is the knob for a nominal whole-process byte budget.
 *
 * A spool is a reader-owned handle. Callers that need the whole body read it at
 * the point of use (`readText()` / `readBytes()`); a handler that calls `.json()`
 * still materializes it there, as required by that consumer. Callers that only
 * forward bytes use {@link SpoolBody.readStream}, which reads in bounded chunks.
 * Every path calls `release()` on every terminal path (success, error, abort).
 *
 * {@link SpoolBody.readStream} therefore serves both §5.3 identity request
 * egress and §5.7 response egress: the upstream or client socket sets the pace
 * instead of a whole-body buffer.
 */

import { open, readFile, rm, type FileHandle } from 'fs/promises';
import { join } from 'path';

// The feature's streaming chunk size, reused rather than re-declared (rule #4).
import { BLOB_STREAM_CHUNK_BYTES } from './blob-store.js';
import { ClaudeProxyError } from './errors.js';
import { ensureSpoolDir, getSpoolConfig, type SpoolConfig } from './spool.js';

/** Live spills exceeded `max_total_bytes`; the caller should answer 503. */
export class SpoolCapacityError extends ClaudeProxyError {
  constructor(message: string) {
    super(message, 503, 'over_limit_error');
    this.name = 'SpoolCapacityError';
  }
}

/** The spill file could not be created, written, or read back. */
export class SpoolWriteError extends ClaudeProxyError {
  constructor(message: string) {
    super(message, 500, 'processing_error');
    this.name = 'SpoolWriteError';
  }
}

/**
 * Bytes reserved by live request/response/event spills. Process-wide, like the
 * resolved config: `max_total_bytes` is a budget for the whole proxy, not a
 * per-request limit.
 */
let liveSpillBytes = 0;

/** Current reservation total, for assertions and operator reporting. */
export function getLiveSpillBytes(): number {
  return liveSpillBytes;
}

function reserveSpillBytes(bytes: number): void {
  const limit = getSpoolConfig().maxTotalBytes;
  if (liveSpillBytes + bytes > limit) {
    throw new SpoolCapacityError(
      `[spool] live spill budget exceeded: ${liveSpillBytes} + ${bytes} bytes > max_total_bytes ${limit}`,
    );
  }
  liveSpillBytes += bytes;
}

function releaseSpillReservation(bytes: number): void {
  if (bytes > liveSpillBytes) {
    // Only reachable if a spool releases a reservation it never took; a silent
    // clamp here would hide exactly that accounting bug.
    throw new Error(`[spool] spill ledger underflow: releasing ${bytes} with ${liveSpillBytes} bytes reserved`);
  }
  liveSpillBytes -= bytes;
}

/** Spill directories already created and probed in this process. */
const ensuredSpillDirs = new Set<string>();

/**
 * `<spool_dir>/<subdir>`, created and probed on first use in this process.
 *
 * Exported because the §5.7 scratch blob store (`response-blobs.ts`) writes its
 * files into the same swept spill directories: one registry of ensured
 * directories, so the probe runs once per directory and a second copy of it
 * cannot quietly drift.
 */
export function spillDir(config: SpoolConfig, subdir: string): string {
  const dir = join(config.dir, subdir);
  if (!ensuredSpillDirs.has(dir)) {
    try {
      ensureSpoolDir(dir);
    } catch (error) {
      throw new SpoolWriteError(`[spool] spill directory unusable: ${(error as Error).message}`);
    }
    ensuredSpillDirs.add(dir);
  }
  return dir;
}

async function openSpillFile(
  config: SpoolConfig,
  subdir: string,
  filePrefix: string,
): Promise<{ path: string; handle: FileHandle }> {
  const path = join(spillDir(config, subdir), `${filePrefix}${crypto.randomUUID()}.body`);
  try {
    return { path, handle: await open(path, 'w', 0o600) };
  } catch (error) {
    throw new SpoolWriteError(`[spool] cannot create spill file ${path}: ${(error as Error).message}`);
  }
}

/**
 * Remove a spill file. Reports a failure instead of throwing: this runs from
 * `finally` paths and on the failure path, where replacing the original error
 * with "cleanup failed" would hide the cause. A leftover file is exactly what
 * the startup sweep exists for (§5.5).
 */
async function discardSpillFile(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch (error) {
    console.warn(`[spool] failed to remove spill file ${path}: ${(error as Error).message}`);
  }
}

/** What one direction's cap, spill layout, and cap-breach error are. */
export interface SpooledBodySpec {
  /** Subdirectory of `[spool] dir` for this direction's spills (§5.5). */
  subdir: string;
  /** Spill file-name prefix, so a leftover file names the direction that wrote it. */
  filePrefix: string;
  /** Bytes one body may reach before `TooLargeError` is thrown. */
  maxBytes: number;
  /** Names the body in the cap messages — "Request" or "Response". */
  bodyLabel: string;
  /** Thrown when the body exceeds `maxBytes`. */
  TooLargeError: new (message: string) => Error;
  /**
   * Declared length (`Content-Length`), when the transport sent one. Used only
   * to reject early and to decide whether to spill from the first byte; the byte
   * counter enforces `maxBytes` whatever this says.
   */
  declaredLength?: number | null;
}

/**
 * A received body. Holds either the in-memory bytes or the path of the spill
 * file; the bytes are only materialized when the caller reads them.
 */
export class SpoolBody {
  /** Bytes received. */
  readonly size: number;
  /** True when the body was written to the spill file instead of held in RAM. */
  readonly spilled: boolean;
  /** Spill file path; set only when `spilled`. */
  readonly path: string | undefined;

  private chunks: Uint8Array[] | null;
  private concatenated: Uint8Array | null = null;
  private readonly reserved: number;
  private done = false;

  constructor(init: {
    size: number;
    spilled: boolean;
    path?: string;
    chunks: Uint8Array[] | null;
    reserved: number;
  }) {
    this.size = init.size;
    this.spilled = init.spilled;
    this.path = init.path;
    this.chunks = init.chunks;
    this.reserved = init.reserved;
  }

  /**
   * The body bytes. For the in-memory path the same array is returned on every
   * call and the caller must not mutate it; for a spilled body the file is read
   * at each call, which is the point of use §5.1 asks for.
   */
  async readBytes(): Promise<Uint8Array> {
    this.assertLive();
    if (this.path) {
      return await readFile(this.path);
    }
    if (!this.concatenated) {
      const out = new Uint8Array(this.size);
      let offset = 0;
      for (const chunk of this.chunks ?? []) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      // Drop the chunk references: the concatenation replaces them, so a
      // multi-megabyte in-memory body is not held twice.
      this.chunks = null;
      this.concatenated = out;
    }
    return this.concatenated;
  }

  /** The body decoded as UTF-8 (request and JSON response bodies are text). */
  async readText(): Promise<string> {
    return new TextDecoder().decode(await this.readBytes());
  }

  /**
   * The body as a chunked stream, pulled no faster than the consumer drains it.
   *
   * Identity request egress (§5.3) and response egress (§5.7) send these bytes
   * straight to the peer socket instead of materializing a second whole body,
   * so a slow upstream or client cannot make the proxy hold the body in RAM.
   *
   * The stream takes ownership: it releases the spool — file removed, reservation
   * returned — when the last byte has been read or the stream is cancelled, so a
   * client that disconnects mid-body frees the disk as soon as the write stops.
   * `release()` stays idempotent, so a caller may also release on its own
   * terminal path.
   */
  readStream(): ReadableStream<Uint8Array> {
    this.assertLive();

    if (!this.path) {
      // In-memory: hand out the chunks as received, then free them. `readBytes()`
      // may already have concatenated them into a single array.
      const source = this.concatenated ? [this.concatenated] : this.chunks ?? [];
      let index = 0;
      return new ReadableStream<Uint8Array>(
        {
          pull: async (controller) => {
            if (index < source.length) {
              controller.enqueue(source[index++]);
              return;
            }
            // Release first: `close()` resolves the consumer's pending read, so
            // releasing after it would let the caller act on a finished response
            // while the spill was still reserved and still on disk.
            await this.release();
            controller.close();
          },
          cancel: () => this.release(),
        },
        { highWaterMark: 0 },
      );
    }

    const path = this.path;
    const total = this.size;
    let handle: FileHandle | null = null;
    let offset = 0;

    const openSpillForRead = async (): Promise<FileHandle> => {
      try {
        return await open(path, 'r');
      } catch (error) {
        throw new SpoolWriteError(`[spool] cannot read spill file ${path}: ${(error as Error).message}`);
      }
    };

    // Every terminal path — last byte, read error, cancel — closes the handle
    // before releasing, because `release()` removes the file.
    const finish = async (): Promise<void> => {
      const openHandle = handle;
      handle = null;
      if (openHandle) await openHandle.close();
      await this.release();
    };

    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          try {
            const file = handle ?? (handle = await openSpillForRead());
            if (offset >= total) {
              // As on the in-memory path: the spill is gone before the stream
              // reports completion.
              await finish();
              controller.close();
              return;
            }
            const length = Math.min(BLOB_STREAM_CHUNK_BYTES, total - offset);
            const buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await file.read(buffer, 0, length, offset);
            if (bytesRead === 0) {
              // A spill shorter than its byte count would be streamed as a whole
              // body (§5.7, repo rule #8): report it instead.
              throw new SpoolWriteError(`[spool] spill ${path} ended at ${offset} of ${total} bytes`);
            }
            offset += bytesRead;
            controller.enqueue(buffer.subarray(0, bytesRead));
          } catch (error) {
            await finish();
            throw error instanceof SpoolWriteError
              ? error
              : new SpoolWriteError(`[spool] cannot read spill file ${path}: ${(error as Error).message}`);
          }
        },
        cancel: () => finish(),
      },
      { highWaterMark: 0 },
    );
  }

  /**
   * Delete the spill file and return its reservation. Idempotent, and safe to
   * call from `finally`: after this the spool's bytes are gone and reading it
   * throws rather than silently returning an empty body.
   */
  async release(): Promise<void> {
    if (this.done) return;
    this.done = true;
    this.chunks = null;
    this.concatenated = null;
    if (this.path) {
      await discardSpillFile(this.path);
    }
    releaseSpillReservation(this.reserved);
  }

  private assertLive(): void {
    if (this.done) {
      throw new Error(`[spool] spill ${this.path ?? '(in-memory)'} was released; its bytes are gone`);
    }
  }
}

/**
 * Stop the writer. Cleanup only: the caller is already throwing the error that
 * explains why, so a cancel failure is reported and never masks it.
 */
async function cancelBody(body: ReadableStream<Uint8Array>): Promise<void> {
  try {
    await body.cancel();
  } catch (error) {
    console.warn(`[spool] failed to cancel the body: ${(error as Error).message}`);
  }
}

/**
 * Receive a body, spilling to disk when the configured threshold is crossed.
 * Throws `spec.TooLargeError` past `spec.maxBytes`, {@link SpoolCapacityError}
 * when the live spill budget is exhausted, and {@link SpoolWriteError} when the
 * file cannot be written; every failure path removes the partial file, returns
 * its reservation, cancels the writer, and rethrows.
 */
export async function receiveSpooledBody(
  body: ReadableStream<Uint8Array> | null | undefined,
  spec: SpooledBodySpec,
): Promise<SpoolBody> {
  const config = getSpoolConfig();
  const declared = spec.declaredLength ?? null;

  if (declared !== null && declared > spec.maxBytes) {
    // Rejected on the declared length alone: not one byte is read. Cancel the
    // writer anyway, so the adapter stops flowing the socket (or the upstream
    // response) instead of writing a body nobody will consume.
    if (body) await cancelBody(body);
    throw new spec.TooLargeError(
      `${spec.bodyLabel} body too large (Content-Length: ${declared} bytes exceeds ${spec.maxBytes})`,
    );
  }
  if (!body) {
    return new SpoolBody({ size: 0, spilled: false, chunks: [], reserved: 0 });
  }

  const spillable = config.enabled;
  const spillFromStart = spillable && declared !== null && declared > config.thresholdBytes;

  const reader = body.getReader();
  let spill: { path: string; handle: FileHandle } | null = null;
  let chunks: Uint8Array[] = [];
  // Bytes on disk and the file position for the next write.
  let written = 0;
  // Bytes charged to max_total_bytes. Unlike `written`, this includes the
  // in-flight chunk whose write has not completed yet.
  let reserved = 0;
  let total = 0;

  /** Write one chunk in full, charging its bytes to the spill budget first. */
  const writeChunk = async (chunk: Uint8Array): Promise<void> => {
    if (!spill) throw new Error('[spool] writeChunk called without a spill file');
    reserveSpillBytes(chunk.byteLength);
    reserved += chunk.byteLength;
    const start = written;
    let offset = 0;
    while (offset < chunk.byteLength) {
      let bytesWritten = 0;
      try {
        ({ bytesWritten } = await spill.handle.write(chunk, offset, chunk.byteLength - offset, start + offset));
      } catch (error) {
        throw new SpoolWriteError(`[spool] write to ${spill.path} failed: ${(error as Error).message}`);
      }
      if (bytesWritten === 0) {
        throw new SpoolWriteError(`[spool] write to ${spill.path} stalled at ${start + offset} bytes`);
      }
      offset += bytesWritten;
    }
    written = start + chunk.byteLength;
  };

  try {
    if (spillFromStart) {
      spill = await openSpillFile(config, spec.subdir, spec.filePrefix);
    }
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > spec.maxBytes) {
        throw new spec.TooLargeError(`${spec.bodyLabel} body too large: exceeded ${spec.maxBytes} bytes`);
      }
      if (!spill && spillable && total > config.thresholdBytes) {
        // Threshold crossing with an unknown length: the prefix is written
        // before any further read, so no byte received so far is lost.
        spill = await openSpillFile(config, spec.subdir, spec.filePrefix);
        const prefix = chunks;
        chunks = [];
        for (const chunk of prefix) {
          await writeChunk(chunk);
        }
      }
      if (spill) {
        await writeChunk(value);
      } else {
        chunks.push(value);
      }
    }
    if (spill) {
      try {
        await spill.handle.close();
      } catch (error) {
        throw new SpoolWriteError(`[spool] closing ${spill.path} failed: ${(error as Error).message}`);
      }
    }
  } catch (error) {
    // Every failure path: remove the partial file, return the reservation, and
    // stop the writer. A half-written spill left behind would hold budget that
    // nothing can release.
    if (spill) {
      try {
        await spill.handle.close();
      } catch { /* the error being propagated is the report */ }
      await discardSpillFile(spill.path);
    }
    if (reserved > 0) {
      releaseSpillReservation(reserved);
    }
    try {
      await reader.cancel();
    } catch { /* the error being propagated is the report */ }
    throw error;
  }

  return new SpoolBody({
    size: total,
    spilled: spill !== null,
    path: spill?.path,
    chunks: spill ? null : chunks,
    reserved,
  });
}
