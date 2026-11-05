/**
 * Unit tests for the §5.3 shape-3 serializer (src/utils/ref-serializer.ts): a
 * ref-bearing body streamed back out as ordinary JSON.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.3, §5.4.
 *
 * The central property is *sameness*: the streamed text must be byte-for-byte
 * what the same body expands to — `JSON.stringify` of the rehydrated body, which
 * is the shape-2 answer — while the blobs are read from L2 in chunks and never
 * held whole. So the assertions here are mostly equalities against the builtin
 * and against `rehydrateInlineBlobs`, plus the exact `contentLength` arithmetic
 * that only holds because extraction refuses to ref a payload JSON would escape.
 *
 * Not covered here, and why: that `cancel()` closes the open L2 file handle is
 * structural (the async generator's `finally`), not observable on POSIX.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BlobStoreError, blobPath, getBlobStoreStats, resetBlobStore } from '../../src/utils/blob-store.js';
import {
  BLOB_REF_MARKER,
  extractInlineBlobs,
  isBlobRef,
  rehydrateInlineBlobs,
  type BlobRef,
} from '../../src/utils/blob-refs.js';
import { RefSerializerError, createRefAwareJsonBody } from '../../src/utils/ref-serializer.js';
import { SPOOL_DEFAULTS, resolveSpoolConfig, setSpoolConfig, type SpoolConfig, type SpoolTomlConfig } from '../../src/utils/spool.js';

const scratchDirs: string[] = [];

/** A fresh temp directory that the test cleanup removes afterwards. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ref-serializer-test-'));
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

/** A live enabled spool rooted in a fresh scratch directory, with the store reset. */
function useConfig(overrides: Partial<SpoolTomlConfig> = {}): SpoolConfig {
  const config = resolveSpoolConfig({ ...SPOOL_DEFAULTS, enabled: true, dir: scratch(), ...overrides });
  setSpoolConfig(config);
  resetBlobStore();
  return config;
}

beforeEach(() => {
  resetBlobStore();
});

/** Consume a body stream entirely, keeping the chunk sizes as well as the text. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<{ sizes: number[]; text: string }> {
  const reader = stream.getReader();
  const sizes: number[] = [];
  const parts: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    sizes.push(value.byteLength);
    parts.push(Buffer.from(value));
  }
  return { sizes, text: Buffer.concat(parts).toString('utf8') };
}

/** Assert that consuming `stream` errors with `kind` mentioning `needle`. */
async function rejectsStream(
  stream: ReadableStream<Uint8Array>,
  kind: new (message: string) => Error,
  needle: RegExp,
): Promise<Error> {
  const reader = stream.getReader();
  let caught: unknown;
  try {
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof kind, `expected ${kind.name}, got ${String(caught)}`);
  assert.match((caught as Error).message, needle);
  return caught as Error;
}

/** Assert `fn` throws `kind` whose message matches `needle`. */
function throwsWith(fn: () => unknown, kind: new (message: string) => Error, needle: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof kind, `expected ${kind.name}, got ${String(caught)}`);
  assert.match((caught as Error).message, needle);
}

/** The ref at `key` of a body, asserting the position really holds one. */
function refAt(body: Record<string, unknown>, key: string): BlobRef {
  const value = body[key];
  assert.ok(isBlobRef(value), `expected a ref at ${key}, got ${JSON.stringify(value)}`);
  return value;
}

/**
 * A body whose only payload sits at a Claude base64 image source — a real §5.4
 * position, so extraction will actually replace it with a ref.
 */
function imageBody(data: string): Record<string, unknown> {
  return {
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }],
  };
}

/** The `source` object of that body, where the ref lands. */
function imageSource(body: Record<string, unknown>): Record<string, unknown> {
  const messages = body.messages as { content: { source: Record<string, unknown> }[] }[];
  return messages[0].content[0].source;
}

describe('§5.3 shape 3 — a ref-bearing body streamed as JSON', () => {
  it('streams the same bytes the expanded body would, with an exact Content-Length', async () => {
    useConfig();
    const data = payload('a', 4096);
    const body: Record<string, unknown> = {
      model: 'claude-sonnet-5-5',
      max_tokens: 16,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
            { type: 'text', text: 'what is in this image?' },
          ],
        },
      ],
    };
    const expanded = Buffer.byteLength(JSON.stringify(body), 'utf8');
    const extraction = await extractInlineBlobs(body);
    assert.equal(extraction.refs, 1, 'the payload must become a ref for this test to mean anything');
    assert.equal(extraction.skipped, 0);

    const { body: stream, contentLength } = createRefAwareJsonBody(body, { chunkBytes: 1024 });
    assert.equal(JSON.stringify(body).includes(data), false, 'the payload is out of the body while the ref is in it');

    const { sizes, text } = await drain(stream);

    assert.equal(contentLength, expanded, 'skeleton bytes plus the ref size must be the expanded body length');
    assert.equal(text.includes(BLOB_REF_MARKER), false, 'the ref and its metadata never reach the wire');
    assert.equal(Buffer.byteLength(text, 'utf8'), contentLength, 'and exactly as many bytes as were declared');
    assert.deepEqual(sizes.filter((size) => size === 1024), [1024, 1024, 1024, 1024], 'a 4096-byte blob arrives in four reads');

    // The reference answer: shape 2's expansion of the same body.
    await rehydrateInlineBlobs(body);
    assert.equal(JSON.stringify(body).includes(data), true, 'rehydration puts the payload back');
    assert.equal(text, JSON.stringify(body), 'shape 3 must send what shape 2 would have sent');
  });

  it('reproduces every JSON rule with the builtin as the reference', async () => {
    useConfig();
    const holes: unknown[] = [undefined, () => 1, Symbol('s'), 1];
    holes[6] = 2; // holes and unrepresentable values are both `null` inside an array
    const value = {
      'quote"back\\slash': 'newline\nand tab\tand café and 🎉 and \u0000',
      numbers: [0, -0, 1.5, -2.25, 1e21, 5e-7],
      notNumbers: [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
      null: null,
      booleans: [true, false],
      empty: [{}, [], ''],
      array: holes,
      omitted: { undefined: undefined, fn: () => 1, symbol: Symbol('t'), kept: 1 },
      // `JSON.stringify`'s own key order: integer-like keys first, ascending.
      order: { b: 1, 2: 'two', a: 2, 1: 'one', 10: 'ten' },
      hook: { toJSON: () => ({ replaced: true }), dropped: 'never seen' },
      nested: { deep: [[[{ leaf: 'x' }]]] },
    };
    const expected = JSON.stringify(value);

    const { body, contentLength } = createRefAwareJsonBody(value);
    const { sizes, text } = await drain(body);

    assert.equal(text, expected, 'escapes, key order, -0, NaN, Infinity, holes and toJSON must be the builtin\'s answers');
    assert.equal(contentLength, Buffer.byteLength(expected, 'utf8'));
    assert.ok(sizes.length > 1, 'the text is emitted piece by piece, never as one whole-body string');
    assert.equal(text.includes('never seen'), false, 'a toJSON hook replaces the value it sits on');
    assert.equal(text.includes('"kept":1'), true, 'the keepless members go, the kept one stays');
    assert.equal(text.includes('"undefined"'), false, 'an object omits a key JSON has no text for');
    assert.equal(text.includes('"fn"'), false);
    assert.equal(text.includes('"symbol"'), false);
    assert.equal(text.includes('"dropped"'), false);
  });

  it('refuses a malformed ref, a cycle, a BigInt and a non-object root before emitting a byte', async () => {
    useConfig();
    // A ref missing its size, pointing at a blob that is not even indexed: the
    // shape is what must be refused, so no blob lookup may have happened.
    const dangling = { [BLOB_REF_MARKER]: true, kind: 'claude-source-data', hash: 'a'.repeat(64), prefix: '', size: 8 };
    throwsWith(
      () => createRefAwareJsonBody({ messages: [{ content: { type: 'base64', data: { ...dangling, size: undefined } } }] }),
      BlobStoreError,
      /malformed ref/,
    );
    throwsWith(() => createRefAwareJsonBody({ x: { ...dangling, prefix: 42 } }), BlobStoreError, /malformed ref/);
    assert.equal(getBlobStoreStats().diskEntries, 0, 'a refused body must not have touched the store');

    const cyclic: Record<string, unknown> = { x: 1 };
    cyclic.self = cyclic;
    throwsWith(() => createRefAwareJsonBody(cyclic), RefSerializerError, /contains a cycle/);
    throwsWith(() => createRefAwareJsonBody({ n: BigInt(7) }), RefSerializerError, /BigInt/);
    throwsWith(() => createRefAwareJsonBody([1, [2, [BigInt(3)]]]), RefSerializerError, /BigInt/);
    throwsWith(() => createRefAwareJsonBody('a request body'), RefSerializerError, /must be a JSON object or array, got string/);
    throwsWith(() => createRefAwareJsonBody(null), RefSerializerError, /must be a JSON object or array, got object/);
    throwsWith(() => createRefAwareJsonBody({}, { chunkBytes: 0 }), RefSerializerError, /chunk size must be a positive integer/);
    throwsWith(() => createRefAwareJsonBody({}, { chunkBytes: 1.5 }), RefSerializerError, /chunk size must be a positive integer/);
  });

  it('errors the stream when a ref and its blob disagree, instead of sending a short body', async () => {
    useConfig();
    const data = payload('b', 4096);
    const body = imageBody(data);
    await extractInlineBlobs(body);
    const ref = refAt(imageSource(body), 'data');

    // The blob is 4096 bytes; a ref claiming 4000 would cut the payload short.
    ref.size -= 96;
    const { body: stream, contentLength } = createRefAwareJsonBody(body, { chunkBytes: 1024 });
    assert.equal(
      contentLength,
      Buffer.byteLength(JSON.stringify(imageBody(data.slice(0, 4000))), 'utf8'),
      'the declared length is the expansion of the truncated payload the ref claims',
    );

    await rejectsStream(stream, RefSerializerError, /streamed 4096 bytes but its ref records 4000/);
  });

  it('errors the stream when the body changes under it, rather than forwarding the stale length', async () => {
    useConfig();
    // A getter is the one way a body can answer differently on the measuring walk
    // and the emitting walk. The declared Content-Length is then a promise the
    // emission cannot keep, which must fail loudly (repo rule #8).
    const short = 'a'.repeat(4);
    const long = 'b'.repeat(40);
    let reads = 0;
    const value: Record<string, unknown> = {};
    Object.defineProperty(value, 'x', { enumerable: true, get: () => (reads++ === 0 ? short : long) });

    const declared = Buffer.byteLength(JSON.stringify({ x: short }), 'utf8');
    const emitted = Buffer.byteLength(JSON.stringify({ x: long }), 'utf8');
    const { body, contentLength } = createRefAwareJsonBody(value);
    assert.equal(contentLength, declared, 'the measuring walk saw the first answer');

    await rejectsStream(body, RefSerializerError, new RegExp(`emitted ${emitted} of ${declared} declared body bytes`));
    assert.equal(reads, 2, 'one read per walk');
  });

  it('reports a dangling ref as a stream error, having already declared its length', async () => {
    useConfig();
    const body = imageBody(payload('c', 64));
    await extractInlineBlobs(body);
    const ref = refAt(imageSource(body), 'data');
    rmSync(blobPath(ref.hash));

    const { body: stream, contentLength } = createRefAwareJsonBody(body);

    assert.ok(contentLength > 0, 'the length comes from the index, not from reading the blob');
    await rejectsStream(stream, BlobStoreError, /cannot be opened/);
  });

  it('cancels mid-blob without erroring, and leaves the blob in place', async () => {
    useConfig();
    const body = imageBody(payload('d', 262144));
    await extractInlineBlobs(body);
    const ref = refAt(imageSource(body), 'data');

    const { body: stream } = createRefAwareJsonBody(body, { chunkBytes: 1024 });
    const reader = stream.getReader();
    const first = await reader.read();
    assert.equal(first.done, false, 'the first read is the start of the JSON, and the blob has not been read yet');

    await reader.cancel();
    // The caller owns the lease, so a cancelled send must not release or delete
    // anything. That the L2 handle is closed with the generator is structural
    // (its `finally`), not observable here.
    assert.equal((await reader.read()).done, true, 'a cancelled stream is closed, not errored');
    assert.equal(existsSync(blobPath(ref.hash)), true, 'the blob survives the cancelled send');
  });
});
