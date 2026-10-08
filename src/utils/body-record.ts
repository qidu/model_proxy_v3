/**
 * In-binary record store: appends self-describing records into a file's own
 * body (used by the win32 SEA fallback in body-key-store.ts to keep
 * keychain-style secrets inside the single-file executable's body, since
 * @github/keytar needs too many dependencies on Windows).
 *
 * Format is byte-compatible with ../store-in-body: each record is
 * `payload || RecTail` where RecTail is 40 bytes —
 *
 *   off 0   magic       9   ASCII "$ReCorDeR"
 *   off 9   pad         3   zero-fill
 *   off 12  version     2   REC_VERSION
 *   off 14  tailSize    2   always 40
 *   off 16  payloadLen  8   u64 LE
 *   off 24  prevTailOff 8   u64 LE offset of the previous tail; 0 = chain end
 *   off 32  payloadCrc32 4  CRC32 of the payload
 *   off 36  tailCrc32   4   CRC32 of bytes 0..35
 *
 * Tails form a backwards-linked list, so a read walks from the newest tail at
 * EOF back to the oldest. Reads stop at the first record that fails validation
 * (magic/version/tailSize/CRC) — a truncated or corrupted tail degrades to
 * "show what is still valid" rather than throwing.
 *
 * CRC32 is hand-rolled rather than `node:zlib`'s `crc32` to avoid a new
 * builtin dependency (and its node >=20.15 floor) in a module graph that also
 * targets Workers' nodejs_compat. The implementation is the standard
 * ISO-HDLC/gzip CRC-32, so records stay byte-compatible with the reference.
 */

import fs from 'fs';
import type { FileHandle } from 'fs/promises';
import path from 'path';

export const REC_MAGIC = '$ReCorDeR';
export const REC_VERSION = 1;
export const REC_TAIL_SIZE = 40;

const MAGIC_BUF = Buffer.from(REC_MAGIC, 'utf8');

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/** Standard CRC-32 (ISO-HDLC, same value as `node:zlib`'s `crc32`). */
export function crc32Buf(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

interface RecTail {
  payloadLen: number;
  prevTailOff: bigint;
  payloadCrc32: number;
}

/** Serialize a tail; tailCrc32 is computed here (the caller passes 0). */
function serializeTail(payloadLen: number, prevTailOff: bigint, payloadCrc32: number): Buffer {
  const buf = Buffer.allocUnsafe(REC_TAIL_SIZE);
  MAGIC_BUF.copy(buf, 0);
  // allocUnsafe does not zero-fill, so bytes 9..11 must be written explicitly.
  buf.fill(0, MAGIC_BUF.length, 12);
  buf.writeUInt16LE(REC_VERSION, 12);
  buf.writeUInt16LE(REC_TAIL_SIZE, 14);
  buf.writeBigUInt64LE(BigInt(payloadLen), 16);
  buf.writeBigUInt64LE(prevTailOff, 24);
  buf.writeUInt32LE(payloadCrc32, 32);
  buf.writeUInt32LE(crc32Buf(buf.subarray(0, 36)), 36);
  return buf;
}

/** Validate and decode a tail; null when magic/version/tailSize/tailCrc32 mismatch. */
function deserializeTail(buf: Buffer): RecTail | null {
  if (buf.length < REC_TAIL_SIZE) return null;
  if (!buf.subarray(0, MAGIC_BUF.length).equals(MAGIC_BUF)) return null;

  const version = buf.readUInt16LE(12);
  const tailSize = buf.readUInt16LE(14);
  if (version !== REC_VERSION || tailSize !== REC_TAIL_SIZE) return null;

  // tailCrc32 covers bytes 0..35, with the CRC field itself zeroed.
  const copy = Buffer.from(buf.subarray(0, REC_TAIL_SIZE));
  copy.writeUInt32LE(0, 36);
  if (crc32Buf(copy.subarray(0, 36)) !== buf.readUInt32LE(36)) return null;

  return {
    payloadLen: Number(buf.readBigUInt64LE(16)),
    prevTailOff: buf.readBigUInt64LE(24),
    payloadCrc32: buf.readUInt32LE(32),
  };
}

/**
 * Read every valid record from `filePath`, oldest → newest. Stops at the first
 * invalid record; returns `[]` when the file is smaller than a tail.
 */
export async function readRecords(filePath: string): Promise<string[]> {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const size = (await fd.stat()).size;
    if (size < REC_TAIL_SIZE) return [];

    const payloads: string[] = [];
    let tailOff = BigInt(size - REC_TAIL_SIZE);

    while (tailOff > 0n) {
      const tailBuf = Buffer.allocUnsafe(REC_TAIL_SIZE);
      await fd.read(tailBuf, 0, REC_TAIL_SIZE, Number(tailOff));

      const tail = deserializeTail(tailBuf);
      if (!tail) break;
      // The payload must fit before this tail.
      if (BigInt(tail.payloadLen) > tailOff) break;

      const payloadOff = tailOff - BigInt(tail.payloadLen);
      const payloadBuf = Buffer.allocUnsafe(tail.payloadLen);
      await fd.read(payloadBuf, 0, tail.payloadLen, Number(payloadOff));
      if (crc32Buf(payloadBuf) !== tail.payloadCrc32) break;

      payloads.push(payloadBuf.toString('utf8'));

      // Loop guard: prevTailOff must strictly decrease.
      if (tail.prevTailOff >= tailOff) break;
      tailOff = tail.prevTailOff;
    }

    return payloads.reverse();
  } finally {
    await fd.close();
  }
}

/** Append one record at EOF of an already-open r+ handle, then fsync. */
async function appendToOpenFile(fd: FileHandle, text: string): Promise<void> {
  const oldSize = (await fd.stat()).size;

  let prevTailOff = 0n;
  if (oldSize >= REC_TAIL_SIZE) {
    const tailBuf = Buffer.allocUnsafe(REC_TAIL_SIZE);
    await fd.read(tailBuf, 0, REC_TAIL_SIZE, oldSize - REC_TAIL_SIZE);
    // Only link to the previous tail when it is a valid record; a corrupt or
    // foreign tail means this is the first record of the chain.
    if (deserializeTail(tailBuf)) {
      prevTailOff = BigInt(oldSize - REC_TAIL_SIZE);
    }
  }

  const payload = Buffer.from(text, 'utf8');
  const tail = serializeTail(payload.length, prevTailOff, crc32Buf(payload));

  await fd.write(payload, 0, payload.length, oldSize);
  await fd.write(tail, 0, REC_TAIL_SIZE, oldSize + payload.length);
  await fd.sync();
}

/**
 * Tier 1 (win32 preferred): append directly to `filePath` in place. Returns
 * false (without throwing) when the running image cannot be opened for write,
 * so the caller can fall back to the swap path. Returns true once the record
 * is written and fsync'd.
 */
async function appendInPlace(filePath: string, text: string): Promise<boolean> {
  let fd: fs.promises.FileHandle;
  try {
    fd = await fs.promises.open(filePath, 'r+');
  } catch {
    return false;
  }
  try {
    await appendToOpenFile(fd, text);
  } finally {
    await fd.close();
  }
  return true;
}

/**
 * Copy → append to the copy → fsync → replace the original.
 *
 * `swapAwaySelf` selects the win32 Tier 2 dance: on Windows a running .exe
 * cannot be replaced by name, so the original is first renamed aside to a
 * unique `.old` name (a fixed name would be un-renamable-over — the first
 * `.old` is the still-mapped original) and the copy is renamed into place.
 * The `.old` may be undeletable while the process that maps it runs; a stale
 * one is swept on the next start by sweepStaleSwapFiles. On POSIX the plain
 * rename-over is used (safe over a running image).
 */
async function appendViaTempFile(filePath: string, text: string, swapAwaySelf: boolean): Promise<void> {
  const dir = path.dirname(filePath);
  const uniq = `${Date.now()}-${process.pid}`;
  const tmpPath = path.join(dir, `.sea-append-${uniq}.tmp`);
  const oldPath = `${filePath}.${uniq}.old`;

  await fs.promises.copyFile(filePath, tmpPath);
  const mode = (await fs.promises.stat(filePath)).mode;

  try {
    const fd = await fs.promises.open(tmpPath, 'r+');
    try {
      await appendToOpenFile(fd, text);
    } finally {
      await fd.close();
    }
    await fs.promises.chmod(tmpPath, mode);

    if (!swapAwaySelf) {
      await fs.promises.rename(tmpPath, filePath);
      return;
    }

    await fs.promises.rename(filePath, oldPath);
    try {
      await fs.promises.rename(tmpPath, filePath);
    } catch (err) {
      // Half-completed swap: put the original back before surfacing the error.
      try { await fs.promises.rename(oldPath, filePath); } catch {}
      throw err;
    }
    // Best-effort: the freshly-renamed-aside original is often still mapped by
    // this very process on Windows and cannot be removed yet.
    try { await fs.promises.unlink(oldPath); } catch {}
  } catch (err) {
    try { await fs.promises.unlink(tmpPath); } catch {}
    throw err;
  }
}

export interface AppendRecordOptions {
  /**
   * Force the win32 copy+rename swap path instead of the in-place append.
   * Defaults to `process.platform === 'win32'`; tests set it explicitly to
   * exercise the swap control flow.
   */
  windowsSwap?: boolean;
}

/**
 * Append one record to `filePath`. On win32 the in-place append is tried first
 * and the copy+rename swap is the fallback; elsewhere the copy+rename path
 * runs directly.
 */
export async function appendRecord(filePath: string, text: string, opts: AppendRecordOptions = {}): Promise<void> {
  const windowsSwap = opts.windowsSwap ?? process.platform === 'win32';
  if (windowsSwap && (await appendInPlace(filePath, text))) {
    return;
  }
  await appendViaTempFile(filePath, text, windowsSwap);
}

/**
 * Remove leftover `<binaryPath>.<uniq>.old` swap files. The original image
 * renamed aside during a Tier 2 append cannot be deleted while the process
 * that maps it still runs, so it is cleaned up on a later start.
 */
export async function sweepStaleSwapFiles(binaryPath: string): Promise<void> {
  const dir = path.dirname(binaryPath);
  const prefix = `${path.basename(binaryPath)}.`;
  let entries: string[];
  try {
    entries = await fs.promises.readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.old')) continue;
    try { await fs.promises.unlink(path.join(dir, name)); } catch {}
  }
}
