/**
 * Unit tests for body-record.ts (the in-binary record store).
 *
 * Covers the properties that matter: payload round-trip, oldest→newest order,
 * the backwards link chain, CRC32 byte-compatibility with node:zlib, CRC
 * corruption truncating the walk (older history becomes unreachable), a file
 * with no valid tail reading as empty, the win32 copy+rename swap flow, and
 * the stale-swap sweep.
 *
 * NOTE: the swap test exercises the control flow of the win32 path, not
 * Windows filesystem semantics (rename-a-running-exe is only observable on a
 * real Windows host).
 *
 * Run with: npx tsx --test tests/unit/body-record.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';

import {
  REC_TAIL_SIZE,
  appendRecord,
  crc32Buf,
  readRecords,
  sweepStaleSwapFiles,
} from '../../src/utils/body-record.js';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('crc32Buf', () => {
  it('matches node:zlib crc32 (records stay byte-compatible with the reference)', () => {
    for (const input of ['', 'a', 'hello', 'STORE_KEY_IN_SYSTEM', 'x'.repeat(1000)]) {
      assert.equal(crc32Buf(Buffer.from(input, 'utf8')), crc32(Buffer.from(input, 'utf8')) >>> 0, input.slice(0, 20));
    }
  });
});

describe('readRecords / appendRecord', () => {
  it('round-trips a single payload', async () => {
    const file = join(tempDir('body-record-test-'), 'bin');
    writeFileSync(file, 'not a record');
    await appendRecord(file, 'hello');
    assert.deepEqual(await readRecords(file), ['hello']);
  });

  it('returns records oldest → newest across many appends', async () => {
    const file = join(tempDir('body-record-test-'), 'bin');
    writeFileSync(file, 'seed');
    for (const p of ['first', 'second', 'third']) await appendRecord(file, p);
    assert.deepEqual(await readRecords(file), ['first', 'second', 'third']);
  });

  it('chains tails to the previous record (link chain spans all records)', async () => {
    const file = join(tempDir('body-record-test-'), 'bin');
    writeFileSync(file, 'seed');
    for (const p of ['aaa', 'bbb', 'ccc']) await appendRecord(file, p);
    // A broken chain would stop the walk early and return fewer records.
    assert.deepEqual(await readRecords(file), ['aaa', 'bbb', 'ccc']);
    assert.equal(readFileSync(file).length, 4 + 3 * (3 + REC_TAIL_SIZE)); // 'seed' + 3×(payload+tail)
  });

  it('returns [] when the file has no valid tail', async () => {
    const short = join(tempDir('body-record-test-'), 'short');
    writeFileSync(short, 'tiny');
    assert.deepEqual(await readRecords(short), [], 'file smaller than a tail');

    const garbage = join(tempDir('body-record-test-'), 'garbage');
    writeFileSync(garbage, Buffer.alloc(REC_TAIL_SIZE * 2, 0x41));
    assert.deepEqual(await readRecords(garbage), [], 'full-size file with no valid tail');
  });

  it('stops at a corrupted payload CRC, dropping the older records behind it', async () => {
    const file = join(tempDir('body-record-test-'), 'bin');
    writeFileSync(file, 'seed');
    for (const p of ['aaa', 'bbb', 'ccc']) await appendRecord(file, p);
    // Flip one byte of the middle record's payload.
    const buf = readFileSync(file);
    const middlePayloadOff = buf.indexOf('bbb');
    assert.ok(middlePayloadOff > 0, 'middle payload is present');
    buf[middlePayloadOff] = buf[middlePayloadOff] ^ 0xff;
    writeFileSync(file, buf);

    // Walk starts at the newest tail: 'ccc' is valid, then 'bbb' fails CRC.
    assert.deepEqual(await readRecords(file), ['ccc']);
  });

  it('stops at a corrupted tail, making every record unreachable', async () => {
    const file = join(tempDir('body-record-test-'), 'bin');
    writeFileSync(file, 'seed');
    for (const p of ['aaa', 'bbb']) await appendRecord(file, p);
    const buf = readFileSync(file);
    buf[buf.length - 1] = buf[buf.length - 1] ^ 0xff; // newest tail's CRC field
    writeFileSync(file, buf);

    assert.deepEqual(await readRecords(file), []);
  });

  it('does not link to a pre-existing tail it did not write', async () => {
    const file = join(tempDir('body-record-test-'), 'bin');
    // 40 bytes of 0xff: size is tail-sized, but never a valid record.
    writeFileSync(file, Buffer.alloc(REC_TAIL_SIZE, 0xff));
    await appendRecord(file, 'solo');
    assert.deepEqual(await readRecords(file), ['solo']);
  });

  it('runs the win32 copy+rename swap flow end-to-end', async () => {
    const dir = tempDir('body-record-test-');
    const file = join(dir, 'bin');
    writeFileSync(file, 'seed');

    await appendRecord(file, 'one', { windowsSwap: true });
    await appendRecord(file, 'two', { windowsSwap: true });

    assert.deepEqual(await readRecords(file), ['one', 'two']);
    // Swap artifacts are cleaned up and no temp file lingers.
    assert.deepEqual(readdirSync(dir), ['bin']);
  });

  it('sweepStaleSwapFiles removes leftover .old files and keeps the binary', async () => {
    const dir = tempDir('body-record-test-');
    const file = join(dir, 'bin');
    writeFileSync(file, 'seed');
    const stale = `${file}.1234-5678.old`;
    writeFileSync(stale, 'leftover original');

    await sweepStaleSwapFiles(file);

    assert.deepEqual(readdirSync(dir), ['bin']);
  });

  it('sweepStaleSwapFiles leaves unrelated .old files of other names alone', async () => {
    const dir = tempDir('body-record-test-');
    const file = join(dir, 'bin');
    writeFileSync(file, 'seed');
    const unrelated = join(dir, 'other.old');
    writeFileSync(unrelated, 'unrelated');

    await sweepStaleSwapFiles(file);

    assert.deepEqual(readdirSync(dir).sort(), ['bin', 'other.old']);
  });
});