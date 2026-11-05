/**
 * SSD spool — read a sized file back in bounded chunks (§5.3 shape 3, §5.7).
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md (§5.3, §5.4,
 * §5.7).
 *
 * Two stores keep a file whose exact length they recorded when they wrote it, and
 * both have to stream it back to the wire: the cross-request blob cache (§5.4,
 * `blob-store.ts`) and the per-response scratch store (§5.7,
 * `response-blobs.ts`). Neither may materialize the whole payload, and neither may
 * send a short file as if it were whole — a truncated blob streamed as a body is
 * precisely the silent corruption §5.5 rules out. So the loop lives here once,
 * and each store adds only its own lookup and its own error type.
 *
 * The generator owns the file handle: it closes it on completion, on an error,
 * and on the consumer's early `return()` (a cancelled send). Callers therefore
 * consume it with `for await` or call `return()` explicitly.
 */

import { open } from 'fs/promises';

/** What one sized file's chunked read needs to know. */
export interface ChunkedFileSpec {
  /** Absolute path of the file to read. */
  path: string;
  /** The byte count recorded when the file was written; the read must be exact. */
  bytes: number;
  /** Bytes per chunk. */
  chunkBytes: number;
  /**
   * How errors name the file — `blob <hash>`, `response scratch blob <hash>`.
   * The store owns the wording because it owns what the file is.
   */
  label: string;
  /** What the recorded length is called in the size-mismatch error. */
  lengthLabel: 'indexed' | 'recorded';
  /** Builds the error every failure is reported with (the store's own type). */
  error: (message: string) => Error;
}

/**
 * Yield a file's bytes in `chunkBytes` pieces, refusing a file that is not
 * exactly `bytes` long or that ends early.
 *
 * A zero-byte read before the recorded end is an error, not an ordinary
 * end-of-file: the recorded length is what every consumer's `Content-Length` or
 * ref `size` was computed from, so a file that stops short is a truncated
 * payload, and the only safe answer is to fail loudly (repo rule #8).
 */
export async function* readSizedFileChunks(spec: ChunkedFileSpec): AsyncGenerator<Uint8Array> {
  const { path, bytes, chunkBytes, label, lengthLabel, error } = spec;
  if (!Number.isInteger(chunkBytes) || chunkBytes <= 0) {
    throw error(`[spool] ${label} chunk size must be a positive integer, got ${chunkBytes}`);
  }

  let handle;
  try {
    handle = await open(path, 'r');
  } catch (cause) {
    throw error(`[spool] ${label} cannot be opened: ${(cause as Error).message}`);
  }

  try {
    let onDisk: number;
    try {
      onDisk = (await handle.stat()).size;
    } catch (cause) {
      throw error(`[spool] cannot read ${label}: ${(cause as Error).message}`);
    }
    if (onDisk !== bytes) {
      throw error(`[spool] ${label} is ${onDisk} bytes on disk but ${lengthLabel} as ${bytes}`);
    }

    let offset = 0;
    while (offset < onDisk) {
      const length = Math.min(chunkBytes, onDisk - offset);
      const buffer = Buffer.allocUnsafe(length);
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(buffer, 0, length, offset));
      } catch (cause) {
        throw error(`[spool] cannot read ${label}: ${(cause as Error).message}`);
      }
      if (bytesRead === 0) {
        throw error(`[spool] ${label} ended at ${offset} of ${onDisk} bytes`);
      }
      offset += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}
