/**
 * Unit tests for the §5.7 response-body spool (src/utils/spool-response.ts).
 *
 * The receive loop itself is shared with ingress (`spool-body.ts`) and is
 * covered by spool-ingress.test.ts; these tests pin what the response direction
 * adds — the cap that applies, the spill layout, the errors, and the shared
 * budget across directions.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SpoolResponseTooLargeError, createConvertedResponseBody, receiveResponseBody } from '../../src/utils/spool-response.js';
import { SpoolCapacityError, getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { receiveIngressBody } from '../../src/utils/spool-ingress.js';
import { BLOB_REF_MARKER, collectBlobRefs, isBlobRef } from '../../src/utils/blob-refs.js';
import { BlobStoreError, getBlobStoreStats } from '../../src/utils/blob-store.js';
import { RESPONSE_BLOB_SCOPE } from '../../src/utils/response-blobs.js';
import { REQUEST_SPILL_SUBDIR, SPOOL_DEFAULTS, responseSpillDir, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';

const scratchDirs: string[] = [];

/** A fresh temp directory that the test cleanup removes afterwards. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spool-response-test-'));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratchDirs) {
    try {
      chmodSync(dir, 0o700); // a test may have left it read-only
    } catch { /* already writable or already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Install a test config globally. `thresholdBytes` is small so a few hundred
 * bytes cross it; `maxResponseBytes` is the documented 64 MiB scaled down to
 * something a test can breach in one chunk.
 */
function configure(overrides: Partial<SpoolConfig> = {}): SpoolConfig {
  const config: SpoolConfig = {
    ...SPOOL_DEFAULTS,
    enabled: true,
    dir: scratch(),
    thresholdBytes: 64,
    maxRequestBytes: 4096,
    maxResponseBytes: 4096,
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

function split(bytes: Uint8Array, chunkSize: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    out.push(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength)));
  }
  return out;
}

/** Names of the spill files currently on disk under `dir`. */
function spillFiles(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** Total bytes currently written to spill files under `dir`. */
function spilledBytes(dir: string): number {
  return spillFiles(dir).reduce((sum, name) => sum + statSync(join(dir, name)).size, 0);
}

interface Sourced {
  stream: ReadableStream<Uint8Array>;
  pulls: number;
  cancelled: boolean;
}

/**
 * A strictly demand-driven source: with highWaterMark 0 the stream pulls only
 * while a read is pending, so `pulls` counts reads the consumer actually asked
 * for — an upstream body that is drained to the end shows up as a pull count
 * well past the point where the cap should have stopped it.
 */
function source(chunks: Uint8Array[]): Sourced {
  let index = 0;
  const state: Sourced = { pulls: 0, cancelled: false, stream: null as unknown as ReadableStream<Uint8Array> };
  state.stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulls += 1;
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index++]);
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

describe('receiveResponseBody — the response cap (§5.7)', () => {
  it('bounds the body by max_response_bytes, not by the request limit', async () => {
    // The request limit is deliberately far below the body: a response path that
    // reused it would reject here.
    const config = configure({ maxRequestBytes: 16, maxResponseBytes: 150, thresholdBytes: 4096 });
    const body = pattern(150, 3);

    const spool = await receiveResponseBody(source(split(body, 40)).stream, { declaredLength: 150 });

    assert.equal(spool.size, 150, 'a body exactly at max_response_bytes is accepted');
    assert.equal(spool.spilled, false);
    assert.equal(sha256(await spool.readBytes()), sha256(body));
    assert.equal(spilledBytes(responseSpillDir(config)), 0);
    await spool.release();
  });

  it('rejects one byte past max_response_bytes by declared length and by byte count', async () => {
    const config = configure({ maxResponseBytes: 150 });

    const declared = await assertRejects(
      receiveResponseBody(source([pattern(151)]).stream, { declaredLength: 151 }),
      SpoolResponseTooLargeError,
      'Response body too large (Content-Length: 151 bytes exceeds 150)',
    );
    assert.equal(declared.status, 500, 'the client sent a legal request: not a 4xx');
    assert.equal(declared.type, 'processing_error');

    const counted = await assertRejects(
      receiveResponseBody(source(split(pattern(151), 50)).stream),
      SpoolResponseTooLargeError,
      'Response body too large: exceeded 150 bytes',
    );
    assert.equal(counted.status, 500);
    assert.equal(spilledBytes(responseSpillDir(config)), 0, 'a rejected body leaves no partial spill');
  });
});

describe('receiveResponseBody — spilling (§5.7)', () => {
  it('spills above threshold_bytes into the response directory, byte for byte', async () => {
    const config = configure();
    const body = pattern(300, 5);

    const spool = await receiveResponseBody(source(split(body, 64)).stream, { declaredLength: 300 });

    assert.equal(spool.spilled, true);
    assert.equal(spool.size, 300);
    assert.equal(spool.path?.startsWith(responseSpillDir(config)), true, `spill path outside responses/: ${spool.path}`);
    assert.match(spillFiles(responseSpillDir(config))[0], /^resp-[0-9a-f-]{36}\.body$/);
    assert.equal(sha256(readFileSync(spool.path as string)), sha256(body), 'the spill must hold the exact body');
    assert.equal(existsSync(join(config.dir, REQUEST_SPILL_SUBDIR)), false, 'a response spill must not touch requests/');
    assert.equal(getLiveSpillBytes(), 300);

    await spool.release();
    assert.deepEqual(spillFiles(responseSpillDir(config)), []);
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('preserves the prefix when an unknown-length body crosses the threshold', async () => {
    const config = configure();
    const body = pattern(300, 9);

    // No declared length: the first chunks stay in memory and must be written to
    // the file the moment the threshold is crossed, not dropped.
    const spool = await receiveResponseBody(source(split(body, 40)).stream);

    assert.equal(spool.spilled, true);
    assert.equal(spool.size, 300);
    assert.equal(sha256(readFileSync(spool.path as string)), sha256(body));
    assert.equal(spilledBytes(responseSpillDir(config)), 300, 'exactly the body is on disk, nothing double-written');
    await spool.release();
  });

  it('removes a partial spill and cancels the upstream body when the cap is breached mid-stream', async () => {
    const config = configure({ maxResponseBytes: 200 });
    const src = source(split(pattern(1000, 2), 100));

    const error = await assertRejects(
      receiveResponseBody(src.stream),
      SpoolResponseTooLargeError,
      'Response body too large: exceeded 200 bytes',
    );

    assert.equal(error.name, 'SpoolResponseTooLargeError');
    assert.ok(src.pulls <= 4, `the upstream body must be stopped at the breach, not drained (pulls: ${src.pulls})`);
    assert.equal(src.cancelled, true, 'the upstream body must be cancelled so the connection is not left flowing');
    assert.deepEqual(spillFiles(responseSpillDir(config)), [], 'the partial spill must be removed');
    assert.equal(getLiveSpillBytes(), 0, 'the partial reservation must be returned');
  });
});

describe('receiveResponseBody — the budget is shared with ingress (§5.6)', () => {
  it('refuses a response spill while a request spill holds max_total_bytes', async () => {
    const config = configure({ maxTotalBytes: 400 });
    const request = await receiveIngressBody(source(split(pattern(300, 11), 100)).stream, { declaredLength: 300 });
    assert.equal(request.spilled, true);
    assert.equal(getLiveSpillBytes(), 300);

    const src = source(split(pattern(300, 12), 100));
    const error = await assertRejects(
      receiveResponseBody(src.stream, { declaredLength: 300 }),
      SpoolCapacityError,
      'max_total_bytes 400',
    );

    assert.equal(error.status, 503);
    assert.equal(src.cancelled, true);
    assert.equal(getLiveSpillBytes(), 300, 'the refused response must not change the live total');
    assert.deepEqual(spillFiles(responseSpillDir(config)), [], 'no response spill may be left behind');

    await request.release();
    assert.equal(getLiveSpillBytes(), 0);
    assert.deepEqual(spillFiles(join(config.dir, REQUEST_SPILL_SUBDIR)), []);
  });
});

/** The §5.7 scratch directory a converted response writes its payloads into. */
function scratchFiles(config: SpoolConfig): string[] {
  return spillFiles(join(config.dir, RESPONSE_BLOB_SCOPE.subdir));
}

/** Base64 of `size` deterministic bytes — a payload a JSON string literal holds verbatim. */
function base64(size: number, seed = 13): string {
  return Buffer.from(pattern(size, seed)).toString('base64');
}

/** A Gemini Interactions response carrying one inline image, as §5.7's allowlist reads it. */
function geminiResponse(image: string): Record<string, any> {
  return {
    id: 'int_1',
    model: 'gemini-2.5-flash',
    status: 'completed',
    candidates: [{ content: { parts: [{ text: 'here' }, { inlineData: { mimeType: 'image/png', data: image } }] } }],
    usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
  };
}

/** The one image part of {@link geminiResponse}, as the value tree holds it after extraction. */
function imagePart(value: Record<string, any>): any {
  return value.candidates[0].content.parts[1];
}

/** Drain a converted body, counting the chunks it was handed over in. */
async function readBody(body: string | ReadableStream<Uint8Array>): Promise<{ bytes: Buffer; chunks: number }> {
  assert.notEqual(typeof body, 'string', 'expected the ref-aware stream, not the plain string');
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return { bytes: Buffer.concat(parts), chunks: parts.length };
}

describe('createConvertedResponseBody — the converted response egress (§5.7)', () => {
  it('streams the extracted image back byte for byte, then deletes the scratch file', async () => {
    const config = configure();
    const image = base64(200_000, 17);
    const value = geminiResponse(image);
    // What the same response serialized before extraction: the ref-aware emission
    // promises this exact byte count, so the two must be identical.
    const expected = JSON.stringify(value);
    const expectedLength = Buffer.byteLength(expected, 'utf8');

    const converted = await createConvertedResponseBody(value);

    assert.notEqual(typeof converted.body, 'string', 'a response with a payload streams');
    assert.equal(converted.contentLength, expectedLength, 'the declared length is the unextracted serialization');

    const ref = imagePart(value).inlineData.data;
    assert.equal(isBlobRef(ref), true, 'the payload left the value tree for a ref');
    assert.equal(ref.size, image.length, 'the ref records the payload, not the image');
    assert.equal(ref.hash, sha256(Buffer.from(image)), 'the ref is addressed by sha256 of the base64');
    assert.equal(ref.kind, 'gemini-inline-data');

    // On disk while the response is in flight: one file, named for its content.
    const files = scratchFiles(config);
    assert.equal(files.length, 1);
    assert.match(files[0], new RegExp(`^${RESPONSE_BLOB_SCOPE.filePrefix}[0-9a-f]{16}-${ref.hash}\\.blob$`));
    assert.equal(statSync(join(config.dir, RESPONSE_BLOB_SCOPE.subdir, files[0])).size, image.length);

    const { bytes, chunks } = await readBody(converted.body);
    assert.equal(bytes.length, expectedLength);
    assert.equal(sha256(bytes), sha256(Buffer.from(expected, 'utf8')), 'the client got the unextracted bytes');
    assert.ok(chunks > 1, `the payload must be streamed in chunks, saw ${chunks}`);
    const text = bytes.toString('utf8');
    assert.ok(text.includes(image), 'the payload is on the wire, not just a marker');
    assert.equal(text.includes(BLOB_REF_MARKER), false, 'the ref itself must never reach a client');

    assert.deepEqual(scratchFiles(config), [], 'the last byte deletes the scratch file');
    assert.deepEqual(getBlobStoreStats(), { cacheBytes: 0, cacheEntries: 0, diskBytes: 0, diskEntries: 0 },
      'a converted response must not populate the cross-request cache (§5.7)');
  });

  it('deletes the scratch file when the client cancels mid-payload', async () => {
    const config = configure();
    const image = base64(200_000, 19);
    const converted = await createConvertedResponseBody(geminiResponse(image));
    const scratchDir = join(config.dir, RESPONSE_BLOB_SCOPE.subdir);

    const reader = (converted.body as ReadableStream<Uint8Array>).getReader();
    const first = await reader.read();
    assert.equal(first.done, false);
    assert.equal(scratchFiles(config).length, 1, 'the payload is still needed: one chunk has been handed over');

    await reader.cancel('client gone');
    assert.deepEqual(scratchFiles(config), [], 'an abandoned response deletes its scratch file');
    assert.equal(existsSync(scratchDir), true, 'only the file goes, not the shared scope directory');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('leaves a payload-free response a plain string and writes nothing to disk', async () => {
    const config = configure();
    const value = { id: 'int_2', status: 'completed', outputs: [{ type: 'text', text: 'hi' }] };

    const converted = await createConvertedResponseBody(value);

    assert.equal(converted.body, JSON.stringify(value));
    assert.equal(converted.contentLength, undefined, 'a string body is measured by the runtime, not declared');
    assert.deepEqual(scratchFiles(config), []);
    assert.equal(spilledBytes(responseSpillDir(config)), 0);
  });

  it('stores two identical payloads once, and keeps the file until both refs drain', async () => {
    const config = configure();
    const image = base64(4096, 23);
    const value = geminiResponse(image);
    value.candidates[0].content.parts.push({ inlineData: { mimeType: 'image/jpeg', data: image } });
    const expected = JSON.stringify(value);

    const converted = await createConvertedResponseBody(value);

    const refs = collectBlobRefs(value);
    assert.equal(refs.length, 2, 'both parts are refs, so both lease the payload');
    assert.equal(refs[0].hash, refs[1].hash);
    assert.equal(refs[0].kind, 'gemini-inline-data');
    const files = scratchFiles(config);
    assert.equal(files.length, 1, 'identical payloads are one content-addressed file');
    assert.equal(statSync(join(config.dir, RESPONSE_BLOB_SCOPE.subdir, files[0])).size, image.length);

    const { bytes } = await readBody(converted.body);
    const text = bytes.toString('utf8');
    assert.equal(text, expected, 'both refs expand back to the text they replaced');
    assert.equal(text.split(image).length - 1, 2, 'the payload appears exactly twice');
    assert.deepEqual(scratchFiles(config), [], 'the file goes once the last lease is released');
  });

  it('fails the body rather than send bytes whose payload is gone', async () => {
    const config = configure();
    const image = base64(4096, 29);
    const value = geminiResponse(image);
    const converted = await createConvertedResponseBody(value);
    const files = scratchFiles(config);
    assert.equal(files.length, 1);
    rmSync(join(config.dir, RESPONSE_BLOB_SCOPE.subdir, files[0]));

    let delivered = '';
    await assertRejects(
      (async () => {
        const { bytes } = await readBody(converted.body);
        delivered = bytes.toString('utf8');
      })(),
      BlobStoreError,
      '[spool] response scratch blob',
    );

    assert.equal(delivered.includes(image), false, 'no partial response may claim to carry the payload');
    assert.deepEqual(scratchFiles(config), [], 'the failed response still cleans up');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('keeps an ineligible payload inline, rather than extracting what JSON must escape', async () => {
    const config = configure();
    // Base64 by schema, but a quote would need escaping — and the exact
    // Content-Length only holds for a payload the wire carries verbatim.
    const quoted = `${base64(64, 31)}"quote`;
    const value = geminiResponse(quoted);

    const converted = await createConvertedResponseBody(value);

    assert.equal(converted.body, JSON.stringify(value), 'the response is byte-identical to an unspooled one');
    assert.equal(converted.contentLength, undefined);
    assert.equal(isBlobRef(imagePart(value).inlineData.data), false, 'a refused payload stays in the tree');
    assert.equal((JSON.parse(converted.body as string) as any).candidates[0].content.parts[1].inlineData.data, quoted,
      'and survives the round trip unaltered');
    assert.deepEqual(scratchFiles(config), []);
  });

  it('returns the plain JSON string without touching the store while [spool] enabled = false', async () => {
    const config = configure({ enabled: false });
    const image = base64(4096, 37);
    const value = geminiResponse(image);

    // A scratch store cannot even be constructed while spooling is off; this path
    // must therefore never construct one (the store throws, loudly).
    const converted = await createConvertedResponseBody(value);

    assert.equal(converted.body, JSON.stringify(value));
    assert.equal(converted.contentLength, undefined);
    assert.equal(isBlobRef(imagePart(value).inlineData.data), false);
    assert.deepEqual(scratchFiles(config), []);
  });
});
