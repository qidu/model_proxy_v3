/**
 * Unit tests for the §5.4/§9.3 ref layer (src/utils/blob-refs.ts): extraction of
 * allowlisted inline binary into BlobRefs, and rehydration back to exact bytes.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.2, §5.4,
 * §9.3, §10 ("Binary allowlist round-trip matrix", "Predicate negatives and
 * scope boundary").
 *
 * The matrix test runs a payload above the §5.6 spill threshold (`threshold_bytes`)
 * for every predicate, as §10 asks. It asserts the in-memory baseline at this
 * layer — refs in, original bytes out — so it stays a test of the ref layer rather
 * than of any one send. The *streamed* upstream-bytes comparison §10 also asks for
 * lives one layer up, where the §5.3 egress paths exist:
 * `tests/unit/request-ref-matrix.test.ts` compares every front-door × upstream-mode
 * combination's streamed body against its spool-disabled baseline, and covers the
 * above-threshold dimension for a payload several read chunks wide.
 *
 * Covered: all eleven allowlisted positions (both Gemini spellings and both
 * Responses `input_image` spellings), the surviving data-URL prefix, kind and
 * byte accounting, idempotency, every §9.3 negative with nothing stored, the
 * §5.3 shape-3 eligibility rule (a payload JSON would escape stays inline and is
 * counted in `skipped`), dedup as one blob under two leases, the §5.2
 * attempt-body clone (one shared lease per blob, independent objects,
 * all-or-nothing retain), all-or-nothing rollback with the leases released, and
 * loud refusal of a forged or dangling ref.
 *
 * The §5.7 response allowlist is covered too: its own positions (a Gemini
 * candidate's parts, a completed Responses payload, an SSE output-item event
 * object) round-trip, and the request predicates it deliberately omits stay
 * untouched — with the request pass over the same body as the contrast. Those
 * payloads go to a per-response scratch store (`ResponseBlobStore`), so the same
 * tests assert the cross-request cache is the one place they must *not* land.
 */

import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BlobCapacityError, BlobStoreError, blobRootDir, evictIdleBlobs, getBlobStoreStats, putBlob, releaseBlob, resetBlobStore, retainBlob } from '../../src/utils/blob-store.js';
import {
  BLOB_REF_MARKER,
  cloneInlineBlobs,
  collectBlobRefs,
  extractInlineBlobs,
  extractResponseBlobs,
  isBlobRef,
  rehydrateInlineBlobs,
  releaseExtractedBlobs,
  releaseInlineBlobs,
  type BlobRef,
  type BlobRefKind,
} from '../../src/utils/blob-refs.js';
import { RESPONSE_BLOB_SCOPE, ResponseBlobStore } from '../../src/utils/response-blobs.js';
import { SPOOL_DEFAULTS, resolveSpoolConfig, setSpoolConfig, type SpoolConfig, type SpoolTomlConfig } from '../../src/utils/spool.js';

const scratchDirs: string[] = [];

/** A fresh temp directory that the test cleanup removes afterwards. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'blob-refs-test-'));
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

/**
 * A distinct, valid base64 payload of exactly `chars` bytes, with a repeating
 * byte pattern so the encoding has no padding and the length is exact.
 */
function payload(seed: string, chars: number): string {
  assert.equal(chars % 4, 0, 'base64 length must be a multiple of 4 for an exact size');
  const text = Buffer.alloc((chars / 4) * 3, seed.charCodeAt(0)).toString('base64');
  assert.equal(text.length, chars, 'payload helper must produce the requested byte count');
  return text;
}

/** Above `threshold_bytes` (1 MiB), so these are payloads the spool would spill. */
const MATRIX_CHARS = SPOOL_DEFAULTS.thresholdBytes + 4096;

/** Small payloads, for tests whose arithmetic depends on the exact byte count. */
const SMALL_CHARS = 48;

/**
 * A live enabled spool rooted in a fresh scratch directory, with the store reset.
 *
 * Overrides are TOML spellings, as in `proxy_config.toml`: `resolveSpoolConfig`
 * reads `[spool]` keys, and a camelCase override would be ignored in silence —
 * a test that means to shrink a cap would then be measuring the default.
 */
function useConfig(overrides: Partial<SpoolTomlConfig> = {}): SpoolConfig {
  const config = resolveSpoolConfig({ enabled: true, dir: scratch(), ...overrides });
  setSpoolConfig(config);
  resetBlobStore();
  return config;
}

beforeEach(() => {
  resetBlobStore();
});

/** Every file name under `<spool_dir>/blobs`, i.e. every stored blob. */
function blobFiles(config: SpoolConfig): string[] {
  const root = blobRootDir(config);
  if (!existsSync(root)) return [];
  const names: string[] = [];
  for (const aa of readdirSync(root)) {
    for (const bb of readdirSync(join(root, aa))) {
      names.push(...readdirSync(join(root, aa, bb)));
    }
  }
  return names;
}

/** Every file name directly inside one swept spill directory (§5.5). */
function spillFiles(config: SpoolConfig, subdir: string): string[] {
  const dir = join(config.dir, subdir);
  return existsSync(dir) ? readdirSync(dir) : [];
}

/** Read a path out of a parsed body, so an assertion names the exact position. */
function at(root: unknown, ...path: (string | number)[]): unknown {
  let node = root as Record<string | number, unknown>;
  for (const key of path) node = node[key] as Record<string | number, unknown>;
  return node;
}

/** A structurally independent copy, for comparing a body before and after. */
function snapshot(body: unknown): unknown {
  return structuredClone(body);
}

/** Awaitable variant of `assertBlobThrows`: assert a rejection's type and message. */
async function rejectsWith(
  promise: Promise<unknown>,
  kind: new (message: string) => Error,
  needle: string,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof kind, `expected ${kind.name}, got ${String(error)}`);
    assert.match((error as Error).message, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return true;
  });
}

/** The ref at `path`, asserting the position really holds one. */
function refAt(body: unknown, ...path: (string | number)[]): BlobRef {
  const value = at(body, ...path);
  assert.ok(isBlobRef(value), `expected a ref at ${path.join('.')}, got ${JSON.stringify(value)}`);
  return value;
}

/**
 * One request body holding every §5.4 predicate position, with a distinct
 * payload at each. The payloads are above the spill threshold, so this is the
 * shape the spool exists to keep off the heap.
 */
function matrixBody(): Record<string, unknown> {
  const bytes = (seed: string): string => payload(seed, MATRIX_CHARS);
  return {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: bytes('a') } },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: bytes('b') } },
          { type: 'text', text: 'describe these' },
        ],
      },
    ],
    chat: [
      { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes('c')}` } },
      { type: 'input_audio', input_audio: { data: bytes('d'), format: 'wav' } },
      { type: 'file', file: { filename: 'report.pdf', file_data: bytes('e') } },
      { type: 'file', file: { filename: 'url.pdf', file_data: `data:application/pdf;base64,${bytes('f')}` } },
    ],
    gemini: [
      { inline_data: { mime_type: 'video/mp4', data: bytes('g') } },
      { inlineData: { mimeType: 'audio/mp3', data: bytes('h') } },
    ],
    interactions: [
      { type: 'image', data: bytes('m'), mime_type: 'image/png' },
    ],
    responses: [
      { type: 'input_image', image_url: `data:image/jpeg;base64,${bytes('i')}` },
      { type: 'input_image', image_url: { url: `data:image/jpeg;base64,${bytes('j')}` } },
      { type: 'input_file', file_data: bytes('k') },
      { type: 'inline', source: { type: 'base64', media_type: 'application/zip', data: bytes('l') } },
    ],
  };
}

describe('§5.4 allowlist round-trip matrix', () => {
  it('turns every allowlisted inline payload into a ref and restores the exact bytes', async () => {
    const config = useConfig();
    const body = matrixBody();
    const before = snapshot(body);

    const result = await extractInlineBlobs(body);

    // Thirteen positions, thirteen refs, and the byte total is what left the body.
    assert.equal(result.refs, 13, 'every allowlisted position must hold a ref');
    assert.equal(result.bytes, 13 * MATRIX_CHARS);
    assert.equal(collectBlobRefs(body).length, 13);
    assert.equal(blobFiles(config).length, 13, 'each distinct payload is one L2 file');
    assert.equal(getBlobStoreStats().diskBytes, 13 * MATRIX_CHARS);

    // The parse tree is small now: no field at an extracted position holds bytes.
    const skeleton = JSON.stringify(body);
    assert.ok(skeleton.length < 4096, `a ref skeleton must be small, got ${skeleton.length} bytes for 13 MiB of payload`);
    for (const ref of collectBlobRefs(body)) {
      assert.equal(ref.size, MATRIX_CHARS);
    }

    // Rehydration reproduces the input exactly — same values, same key order.
    // It runs on a clone because that is what a conversion path does (§5.2 keeps
    // one body per attempt); the original body keeps its refs and its leases.
    const copy = snapshot(body);
    const expanded = await rehydrateInlineBlobs(copy);
    assert.equal(expanded, 13);
    assert.deepStrictEqual(copy, before);
    assert.equal(JSON.stringify(copy), JSON.stringify(before), 'wire bytes must match the input exactly');

    // The body owner gives back one lease per ref; nothing stays leased.
    assert.equal(releaseInlineBlobs(body), 13);
    assert.equal((await evictIdleBlobs(Date.now() + (config.ttlSeconds * 1000) + 1000)), 13);
    assert.equal(getBlobStoreStats().diskEntries, 0);
  });

  it('records the source kind and the original data-URL prefix per position', async () => {
    const config = useConfig();
    const body = matrixBody();

    await extractInlineBlobs(body);

    const expected: Array<[(string | number)[], BlobRefKind, string]> = [
      [['messages', 0, 'content', 0, 'source', 'data'], 'claude-source-data', ''],
      [['messages', 0, 'content', 1, 'source', 'data'], 'claude-source-data', ''],
      [['chat', 0, 'image_url', 'url'], 'chat-image-url', 'data:image/png;base64,'],
      [['chat', 1, 'input_audio', 'data'], 'chat-input-audio', ''],
      [['chat', 2, 'file', 'file_data'], 'chat-file-data', ''],
      [['chat', 3, 'file', 'file_data'], 'chat-file-data', 'data:application/pdf;base64,'],
      [['gemini', 0, 'inline_data', 'data'], 'gemini-inline-data', ''],
      [['gemini', 1, 'inlineData', 'data'], 'gemini-inline-data', ''],
      [['interactions', 0, 'data'], 'interactions-media-data', ''],
      [['responses', 0, 'image_url'], 'responses-input-image', 'data:image/jpeg;base64,'],
      [['responses', 1, 'image_url', 'url'], 'responses-input-image', 'data:image/jpeg;base64,'],
      [['responses', 2, 'file_data'], 'responses-input-file', ''],
      [['responses', 3, 'source', 'data'], 'responses-inline-skill', ''],
    ];

    for (const [path, kind, prefix] of expected) {
      const ref = refAt(body, ...path);
      assert.equal(ref.kind, kind, `kind at ${path.join('.')}`);
      assert.equal(ref.prefix, prefix, `data-URL prefix at ${path.join('.')}`);
      assert.equal(ref[BLOB_REF_MARKER], true);
    }

    // Only the payload went to the blob, so the rehydrated field is the original
    // string — prefix included — rather than a rewritten data URL.
    const refs = collectBlobRefs(body);
    assert.equal(await rehydrateInlineBlobs(body), 13);
    assert.equal(at(body, 'chat', 0, 'image_url', 'url'), `data:image/png;base64,${payload('c', MATRIX_CHARS)}`);
    assert.equal(at(body, 'responses', 3, 'source', 'data'), payload('l', MATRIX_CHARS));

    for (const ref of refs) releaseBlob(ref.hash);
    assert.equal(blobFiles(config).length, 13, 'a released blob file is still there until it is idle-evicted');
    assert.equal(await evictIdleBlobs(Date.now() + (SPOOL_DEFAULTS.ttlSeconds * 1000) + 1000), 13);
    assert.equal(blobFiles(config).length, 0);
    assert.equal(getBlobStoreStats().cacheEntries, 0, 'an idle-evicted blob must leave L1 too');
  });

  it('is idempotent — a body that already holds refs extracts nothing', async () => {
    useConfig();
    const body: Record<string, unknown> = {
      chat: [{ type: 'file', file: { file_data: payload('m', SMALL_CHARS) } }],
    };

    const first = await extractInlineBlobs(body);
    assert.equal(first.refs, 1);
    const afterFirst = JSON.stringify(body);

    const second = await extractInlineBlobs(body);

    assert.deepStrictEqual(second, { refs: 0, bytes: 0, skipped: 0, hashes: [], blobs: [] }, 'a second pass must not re-extract or re-lease');
    assert.equal(JSON.stringify(body), afterFirst, 'the refs must be untouched by a second pass');
    assert.equal(getBlobStoreStats().diskEntries, 1);
    assert.equal(releaseInlineBlobs(body), 1);
  });
});

describe('§9.3 predicate negatives and scope boundary', () => {
  it('leaves every non-allowlisted position byte-identical and stores nothing', async () => {
    const config = useConfig();
    const inline = payload('n', SMALL_CHARS);
    const dataUrlText = 'data:text/plain,' + 'hello%20world'.repeat(40);
    const body = {
      messages: [
        { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'plain text document' } },
        { type: 'document', source: { type: 'url', url: 'https://example.com/a.pdf' } },
        { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 42 } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'https://example.com/a.png' } },
      ],
      chat: [
        { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        { type: 'image_url', image_url: { url: dataUrlText } },
        { type: 'file', file: { file_id: 'file-abc123' } },
        { type: 'file', file: { file_data: 'https://example.com/a.pdf' } },
        { type: 'input_audio', input_audio: { format: 'wav' } },
      ],
      gemini: [
        { file_data: { mime_type: 'application/pdf', file_uri: 'https://example.com/a.pdf' } },
        { fileData: { mimeType: 'application/pdf', fileUri: 'files/abc123' } },
        { inline_data: { mime_type: 'image/png' } },
        { inlineData: { mimeType: 'image/png', data: 'https://example.com/a.png' } },
        { text: inline },
        { data: inline },
      ],
      responses: [
        { type: 'input_image', image_url: 'https://example.com/a.png' },
        { type: 'input_file', file_id: 'file-abc123' },
        { type: 'input_file', file_data: 'https://example.com/a.pdf' },
        { type: 'inline', source: { type: 'base64', media_type: 'text/plain', data: inline } },
        { type: 'inline', source: { type: 'text', text: 'skill text' } },
        { type: 'image_generation_call', result: inline },
      ],
      unknown: { some_field: inline, data: inline },
      text: inline,
    };
    const before = snapshot(body);

    const result = await extractInlineBlobs(body);

    assert.deepStrictEqual(result, { refs: 0, bytes: 0, skipped: 0, hashes: [], blobs: [] }, 'no negative position may become a ref');
    assert.deepStrictEqual(body, before, 'forwarded values must be unchanged');
    assert.equal(getBlobStoreStats().diskEntries, 0, 'nothing may reach the blob store');
    assert.equal(blobFiles(config).length, 0);
  });

  it('does not re-encode a data URL that is not base64', async () => {
    useConfig();
    // A URL-encoded data URL is a payload this layer cannot store as base64, so
    // it is left exactly as the client sent it (never decoded and re-encoded).
    const encoded = 'data:image/png,' + encodeURIComponent('not base64 é');
    const body = { chat: [{ type: 'image_url', image_url: { url: encoded } }] };

    await extractInlineBlobs(body);

    assert.equal(at(body, 'chat', 0, 'image_url', 'url'), encoded);
  });
});

/**
 * One response body holding every §5.7 response-allowlist position: a Gemini
 * candidate's content parts, a completed Responses payload, and one SSE
 * output-item event object, each with a distinct payload above the spill
 * threshold. Nothing here is in the request allowlist except the Gemini part.
 */
function responseMatrixBody(): Record<string, unknown> {
  const bytes = (seed: string): string => payload(seed, MATRIX_CHARS);
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            { inlineData: { mimeType: 'image/png', data: bytes('A') } },
            { inline_data: { mime_type: 'audio/wav', data: bytes('B') } },
            { text: 'here is the generated image' },
          ],
        },
        finishReason: 'STOP',
      },
    ],
    output: [
      { type: 'image_generation_call', id: 'ig_1', status: 'completed', result: bytes('C') },
      { type: 'message', content: [{ type: 'output_text', text: 'done' }] },
    ],
    event: {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'image_generation_call', id: 'ig_2', status: 'completed', result: bytes('D') },
    },
    // The Interactions `outputs` shape an `/v1/interactions` client is served: the
    // one response schema that is also a request schema, so its media content is
    // the single position both allowlists read.
    outputs: [
      { type: 'text', text: 'here is the generated image' },
      { type: 'image', data: bytes('E'), mime_type: 'image/png' },
    ],
  };
}

describe('§5.7 response allowlist', () => {
  it('turns every response-allowlist payload into a ref and restores the exact bytes', async () => {
    const config = useConfig();
    const body = responseMatrixBody();
    const before = snapshot(body);
    const store = new ResponseBlobStore(RESPONSE_BLOB_SCOPE);

    const result = await extractResponseBlobs(body, store);

    // Three Gemini parts (both spellings), two generated images — the second in
    // a nested SSE event object, which the walk reaches without a special case —
    // and the Interactions media content an `/v1/interactions` client is served.
    assert.equal(result.refs, 5);
    assert.equal(result.bytes, 5 * MATRIX_CHARS);
    assert.equal(result.skipped, 0);
    assert.equal(store.size, 5, 'the scratch store holds all five payloads');
    assert.equal(spillFiles(config, RESPONSE_BLOB_SCOPE.subdir).length, 5, 'one scratch file per payload');
    assert.equal(
      JSON.stringify(body).length < 4096,
      true,
      'a ref skeleton must be small next to 2 MiB of payload',
    );

    // §5.7: no response payload may populate the cross-request cache.
    assert.deepStrictEqual(getBlobStoreStats(), { cacheBytes: 0, cacheEntries: 0, diskBytes: 0, diskEntries: 0 });
    assert.equal(blobFiles(config).length, 0, 'a response blob must never reach the cache directory');

    const expected: Array<[(string | number)[], BlobRefKind]> = [
      [['candidates', 0, 'content', 'parts', 0, 'inlineData', 'data'], 'gemini-inline-data'],
      [['candidates', 0, 'content', 'parts', 1, 'inline_data', 'data'], 'gemini-inline-data'],
      [['output', 0, 'result'], 'responses-image-generation-result'],
      [['event', 'item', 'result'], 'responses-image-generation-result'],
      [['outputs', 1, 'data'], 'interactions-media-data'],
    ];
    for (const [path, kind] of expected) {
      const ref = refAt(body, ...path);
      assert.equal(ref.kind, kind, `kind at ${path.join('.')}`);
      assert.equal(ref.size, MATRIX_CHARS, `size at ${path.join('.')}`);
      assert.equal(ref.prefix, '', `a response field holds bare base64, so there is no prefix at ${path.join('.')}`);
    }

    // Rehydration reproduces the response the upstream sent, byte for byte, and
    // reads the scratch store — the hashes exist nowhere else.
    const copy = snapshot(body);
    assert.equal(await rehydrateInlineBlobs(copy, store), 5);
    assert.deepStrictEqual(copy, before);
    assert.equal(JSON.stringify(copy), JSON.stringify(before));

    // §5.7: a response's blobs are per-response scratch, released when the client
    // write finishes. The final release schedules deletion; `dispose` awaits it.
    assert.equal(releaseExtractedBlobs(result, store), 5);
    assert.equal(store.size, 0, 'no payload stays readable after its last lease');
    assert.deepStrictEqual(await store.dispose(), { deleted: 5, failed: [], leaked: 0 });
    assert.equal(spillFiles(config, RESPONSE_BLOB_SCOPE.subdir).length, 0, 'the files are gone from disk');
    assert.deepStrictEqual(getBlobStoreStats(), { cacheBytes: 0, cacheEntries: 0, diskBytes: 0, diskEntries: 0 });
  });

  it('leaves the request-side positions alone and extracts them only through the request allowlist', async () => {
    const config = useConfig();
    const inline = payload('E', SMALL_CHARS);
    // A response that carries the assistant-side positions the request allowlist
    // reads. §5.7 names two of them explicitly — Claude assistant image blocks and
    // Chat Completions assistant image parts — because reusing their predicate
    // here would extract fields the documented response schemas never carry.
    const body = {
      messages: [
        { role: 'assistant', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: inline } }] },
      ],
      choices: [
        { message: { role: 'assistant', content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${inline}` } }] } },
      ],
      output: [
        { type: 'input_image', image_url: `data:image/jpeg;base64,${inline}` },
        { type: 'image_generation_call', id: 'ig_1', status: 'in_progress', result: null },
        { type: 'image_generation_call', id: 'ig_2', result: '' },
        { type: 'image_generation_call', id: 'ig_3', result: 42 },
        { type: 'image_generation_call', id: 'ig_4', result: 'https://example.com/result.png' },
      ],
    };
    const before = snapshot(body);
    const store = new ResponseBlobStore(RESPONSE_BLOB_SCOPE);

    const asResponse = await extractResponseBlobs(body, store);

    assert.deepStrictEqual(asResponse, { refs: 0, bytes: 0, skipped: 0, hashes: [], blobs: [] }, 'no request position may become a response ref');
    assert.deepStrictEqual(body, before, 'the response must be forwarded unchanged');
    assert.equal(store.size, 0, 'nothing may reach the scratch store');
    assert.equal(spillFiles(config, RESPONSE_BLOB_SCOPE.subdir).length, 0);
    assert.equal(blobFiles(config).length, 0, 'nothing may reach the blob store');
    assert.equal(at(body, 'output', 1, 'result'), null, 'an in-progress call has no result yet');

    // The same body through the request allowlist is the contrast: it takes the
    // three request positions and still not the generated-image results, so the
    // two allowlists are genuinely different sets rather than one of the other.
    const asRequest = await extractInlineBlobs(body);

    assert.equal(asRequest.refs, 3);
    assert.equal(refAt(body, 'messages', 0, 'content', 0, 'source', 'data').kind, 'claude-source-data');
    assert.equal(refAt(body, 'choices', 0, 'message', 'content', 0, 'image_url', 'url').kind, 'chat-image-url');
    assert.equal(refAt(body, 'output', 0, 'image_url').kind, 'responses-input-image');
    assert.equal(refAt(body, 'output', 0, 'image_url').prefix, 'data:image/jpeg;base64,', 'a request ref keeps its data-URL prefix');
    assert.equal(blobFiles(config).length, 1, 'the one distinct payload is one cache blob, as on the request path');
    assert.equal(releaseExtractedBlobs(asRequest), 3);
    assert.deepStrictEqual(await store.dispose(), { deleted: 0, failed: [], leaked: 0 });
  });

  it('reads a Gemini part through either allowlist, because the part is the shape on both sides', async () => {
    useConfig();
    // The one position the two allowlists share (§5.4 and §5.7 spell the same
    // rule): a Gemini content part declares no discriminator, so `inline_data`
    // identifies it in a request and in a response alike.
    const part = { inline_data: { mime_type: 'video/mp4', data: payload('F', SMALL_CHARS) } };
    const viaRequest = { contents: [{ role: 'model', parts: [snapshot(part)] }] };
    const viaResponse = { candidates: [{ content: { parts: [snapshot(part)] } }] };
    const store = new ResponseBlobStore(RESPONSE_BLOB_SCOPE);

    assert.equal((await extractInlineBlobs(viaRequest)).refs, 1);
    assert.equal((await extractResponseBlobs(viaResponse, store)).refs, 1);

    const refs = [...collectBlobRefs(viaRequest), ...collectBlobRefs(viaResponse)];
    assert.deepStrictEqual(refs.map((ref) => ref.kind), ['gemini-inline-data', 'gemini-inline-data']);
    assert.equal(
      refs[0].hash,
      refs[1].hash,
      'both stores address the payload by the same sha256, but each holds its own copy (§5.7)',
    );
    assert.equal(await rehydrateInlineBlobs(viaResponse, store), 1);
    assert.deepStrictEqual(at(viaResponse, 'candidates', 0, 'content', 'parts', 0), part);
    releaseBlob(refs[0].hash);
    store.release(refs[1].hash);
    assert.deepStrictEqual(await store.dispose(), { deleted: 1, failed: [], leaked: 0 });
  });
});

describe('§5.3 shape-3 eligibility — a payload JSON would escape stays inline', () => {
  it('leaves the ineligible payloads of a body untouched, counted, and unfetched', async () => {
    const config = useConfig();
    const quote = payload('q', SMALL_CHARS).slice(0, 8) + '"quote';
    const backslash = payload('r', SMALL_CHARS).slice(0, 8) + '\\slash';
    const control = payload('s', SMALL_CHARS).slice(0, 8) + '\u0007bell';
    const del = payload('t', SMALL_CHARS).slice(0, 8) + '\u007fdel';
    const nonAscii = payload('u', SMALL_CHARS).slice(0, 8) + 'café';
    const eligible = payload('v', SMALL_CHARS);
    const body = {
      messages: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: quote } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: backslash } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: control } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: del } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: nonAscii } },
      ],
      // The prefix is checked too, and a URL-safe payload is data the provider
      // really sends: both are exercised below.
      chat: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${quote}` } }],
      gemini: [{ inline_data: { mime_type: 'image/png', data: eligible } }],
    };

    const result = await extractInlineBlobs(body);

    assert.equal(result.refs, 1, 'only a payload JSON copies verbatim may become a ref');
    assert.equal(result.skipped, 6, 'every refused payload must be reported, not passed over in silence');
    assert.equal(result.bytes, SMALL_CHARS, 'the byte total counts only what was actually stored');
    assert.equal(at(body, 'messages', 0, 'source', 'data'), quote, 'a refused payload keeps its exact bytes');
    assert.equal(at(body, 'messages', 1, 'source', 'data'), backslash);
    assert.equal(at(body, 'messages', 2, 'source', 'data'), control);
    assert.equal(at(body, 'messages', 3, 'source', 'data'), del);
    assert.equal(at(body, 'messages', 4, 'source', 'data'), nonAscii);
    assert.equal(at(body, 'chat', 0, 'image_url', 'url'), `data:image/png;base64,${quote}`);
    assert.equal(blobFiles(config).length, 1, 'the refused payloads must never reach the disk');
    assert.equal(getBlobStoreStats().diskEntries, 1);
    assert.deepEqual(result.hashes, [refAt(body, 'gemini', 0, 'inline_data', 'data').hash]);

    // Refusing a payload is per payload: the rest of the body is still extracted.
    await rehydrateInlineBlobs(body);
    assert.equal(at(body, 'gemini', 0, 'inline_data', 'data'), eligible, 'the eligible payload round-trips');
  });

  it('extracts a URL-safe base64 payload, which needs no escaping, and restores it exactly', async () => {
    useConfig();
    // `-`, `_` and `~` are all characters `JSON.stringify` copies verbatim, so the
    // rule is about JSON, not about which base64 alphabet a provider used.
    const urlSafe = '-_'.repeat(SMALL_CHARS / 2 - 1) + '~-';
    assert.equal(urlSafe.length, SMALL_CHARS);
    assert.equal(urlSafe.indexOf('+'), -1, 'a URL-safe payload holds no `+`, `/` or `=`');
    const body = { gemini: [{ inline_data: { mime_type: 'image/png', data: urlSafe } }] };

    const result = await extractInlineBlobs(body);

    assert.equal(result.refs, 1);
    assert.equal(result.skipped, 0);
    assert.equal(refAt(body, 'gemini', 0, 'inline_data', 'data').size, SMALL_CHARS);
    await rehydrateInlineBlobs(body);
    assert.equal(at(body, 'gemini', 0, 'inline_data', 'data'), urlSafe);
  });
});

describe('leases and dedup', () => {
  it('takes one lease per ref, so a repeated payload is one blob under two leases', async () => {
    useConfig();
    const shared = payload('o', SMALL_CHARS);
    const body = {
      messages: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: shared } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: shared } },
      ],
    };

    const result = await extractInlineBlobs(body);

    assert.equal(result.refs, 2, 'two positions are two refs even when they dedup to one blob');
    assert.equal(result.bytes, 2 * SMALL_CHARS, 'bytes counts what left the body, not what is on disk');
    assert.equal(getBlobStoreStats().diskEntries, 1);
    assert.equal(getBlobStoreStats().diskBytes, SMALL_CHARS);
    assert.equal(refAt(body, 'messages', 0, 'source', 'data').hash, refAt(body, 'messages', 1, 'source', 'data').hash);

    // Releasing is per ref: two releases for one blob, and only then is it idle.
    assert.equal(releaseInlineBlobs(body), 2);
    assert.equal(await evictIdleBlobs(Date.now()), 0, 'a fresh release is not yet idle-expired');
    assert.equal(await evictIdleBlobs(Date.now() + (SPOOL_DEFAULTS.ttlSeconds * 1000) + 1000), 1);
  });

  it('keeps a blob alive while another owner still holds a lease', async () => {
    const config = useConfig();
    const shared = payload('p', SMALL_CHARS);
    const body = { chat: [{ type: 'file', file: { file_data: shared } }] };

    await extractInlineBlobs(body);
    const hash = refAt(body, 'chat', 0, 'file', 'file_data').hash;
    const extra = retainBlob(hash); // a cloned attempt ref sharing the lease (§5.5)

    releaseInlineBlobs(body); // the body's owner is done; one owner remains
    assert.equal(extra.size, SMALL_CHARS);
    assert.equal(await evictIdleBlobs(Date.now() + (config.ttlSeconds * 1000) + 1000), 0, 'a leased blob is pinned');

    // The remaining owner can still read it, and the last release ends the lease.
    const again = { chat: [{ type: 'file', file: { file_data: { [BLOB_REF_MARKER]: true, kind: 'chat-file-data', hash, size: SMALL_CHARS, prefix: '' } } }] };
    const survivors = collectBlobRefs(again);
    assert.equal(await rehydrateInlineBlobs(again), 1);
    assert.equal(at(again, 'chat', 0, 'file', 'file_data'), shared);

    for (const ref of survivors) releaseBlob(ref.hash);
    assert.equal(await evictIdleBlobs(Date.now() + (config.ttlSeconds * 1000) + 1000), 1);
  });
});

describe('the effective body release list', () => {
  it('lists one lease per ref, repeats included, and releases exactly those', async () => {
    const config = useConfig();
    const shared = payload('q', SMALL_CHARS);
    const body = {
      messages: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: shared } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: shared } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: payload('r', SMALL_CHARS) } },
      ],
    };

    const extraction = await extractInlineBlobs(body);

    assert.equal(extraction.refs, 3);
    assert.deepStrictEqual(
      extraction.hashes,
      [
        refAt(body, 'messages', 0, 'source', 'data').hash,
        refAt(body, 'messages', 1, 'source', 'data').hash,
        refAt(body, 'messages', 2, 'source', 'data').hash,
      ],
      'the release list is the applied refs in application order',
    );
    assert.deepStrictEqual(
      extraction.blobs,
      [
        { hash: extraction.hashes[0], size: SMALL_CHARS },
        { hash: extraction.hashes[2], size: SMALL_CHARS },
      ],
      'the §5.8 upload list names each distinct object once, in first-lease order',
    );
    assert.equal(
      extraction.hashes[0],
      extraction.hashes[1],
      'two refs to one payload are two leases of one hash, not one entry',
    );
    assert.equal(getBlobStoreStats().diskEntries, 2);

    assert.equal(releaseExtractedBlobs(extraction), 3, 'every lease the extraction took is given back');
    assert.equal(
      await evictIdleBlobs(Date.now() + (config.ttlSeconds * 1000) + 1000),
      2,
      'both blobs are idle once the extraction is released',
    );
  });

  it('releases its own leases even when the body holds a ref it never leased', async () => {
    const config = useConfig();
    const real = payload('s', SMALL_CHARS);
    // A ref forged into a field of the client's own: extraction reads only the
    // §5.4 positions, so it never leased this hash.
    const forged = { [BLOB_REF_MARKER]: true, kind: 'messages-image-data', hash: 'f'.repeat(64), size: SMALL_CHARS, prefix: '' };
    const body = {
      messages: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: real } }],
      metadata: { ...forged },
    };

    const extraction = await extractInlineBlobs(body);
    assert.equal(extraction.refs, 1);
    assert.deepStrictEqual(
      collectBlobRefs(body).map((ref) => ref.hash),
      [refAt(body, 'messages', 0, 'source', 'data').hash, forged.hash],
      'the forged ref is visible to a walk of the body',
    );

    // The extraction's own list, not a walk: the forged hash is never handed to
    // the store, so the release is exact.
    assert.equal(releaseExtractedBlobs(extraction), 1);
    assert.equal(
      await evictIdleBlobs(Date.now() + (config.ttlSeconds * 1000) + 1000),
      1,
      'the one real lease was released, so the blob is idle',
    );
  });

  it('shows why that walk is the wrong release: a forged ref derails it halfway', async () => {
    const config = useConfig();
    const real = payload('y', SMALL_CHARS);
    const forged = { [BLOB_REF_MARKER]: true, kind: 'messages-image-data', hash: 'f'.repeat(64), size: SMALL_CHARS, prefix: '' };
    const body = {
      messages: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: real } }],
      metadata: { ...forged },
    };
    await extractInlineBlobs(body);

    assert.throws(() => releaseInlineBlobs(body), /is not in the cache index/);

    // The walk gave back the real lease on its way to the forged one, so the
    // blob it just released expired while the body still holds its ref: an
    // owner that released this way would leave a dangling ref and a leaked
    // reservation behind. This is the failure the extraction's list avoids.
    assert.equal(
      await evictIdleBlobs(Date.now() + (config.ttlSeconds * 1000) + 1000),
      1,
      'the real lease was already consumed by the derailed walk',
    );
    await rejectsWith(
      rehydrateInlineBlobs(body),
      BlobStoreError,
      'is not in the cache index',
    );
  });

  it('releases nothing for an extraction that took no lease', async () => {
    useConfig();
    const body = { chat: [{ type: 'input_audio', input_audio: { format: 'wav' } }] };

    const extraction = await extractInlineBlobs(body);

    assert.deepStrictEqual(extraction, { refs: 0, bytes: 0, skipped: 0, hashes: [], blobs: [] });
    assert.equal(releaseExtractedBlobs(extraction), 0);
  });

  it('refuses a second release of the same extraction rather than undercounting', async () => {
    useConfig();
    const body = { chat: [{ type: 'file', file: { file_data: payload('x', SMALL_CHARS) } }] };
    const extraction = await extractInlineBlobs(body);

    assert.equal(releaseExtractedBlobs(extraction), 1);
    assert.throws(
      () => releaseExtractedBlobs(extraction),
      (error: unknown) => {
        assert.ok(error instanceof BlobStoreError);
        assert.match((error as Error).message, /has no active lease to release/);
        return true;
      },
      'a double release is a lease-accounting bug, not a no-op',
    );
  });
});

describe('§5.2 attempt body clones', () => {
  it('gives a cloned attempt body its own lease over the same blob', async () => {
    const config = useConfig();
    const shared = payload('x', SMALL_CHARS);
    const body = {
      messages: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: shared } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: shared } },
      ],
    };
    await extractInlineBlobs(body);

    const clone = cloneInlineBlobs(body);

    // Same value, its own objects: an attempt body is a copy, not an alias.
    assert.deepStrictEqual(clone, body);
    assert.notStrictEqual(at(clone, 'messages', 0), at(body, 'messages', 0));
    assert.notStrictEqual(
      refAt(clone, 'messages', 0, 'source', 'data'),
      refAt(body, 'messages', 0, 'source', 'data'),
      'the clone must not hand out the body\'s own ref objects',
    );
    assert.equal(
      refAt(clone, 'messages', 0, 'source', 'data').hash,
      refAt(body, 'messages', 0, 'source', 'data').hash,
      'a clone shares the lease, so it names the same blob',
    );

    // Sharing the lease means the clone stored nothing: one file, one entry.
    assert.equal(blobFiles(config).length, 1);
    assert.equal(getBlobStoreStats().diskBytes, SMALL_CHARS);

    // The body's two releases leave the clone's two in place, so the blob is
    // still pinned — this is what one shared lease under two owners means.
    assert.equal(releaseInlineBlobs(body), 2);
    assert.equal(await evictIdleBlobs(Date.now() + (config.ttlSeconds * 1000) + 1000), 0, 'the clone still holds the blob');

    // The clone can still read the exact bytes, and its own releases end the lease.
    const refs = collectBlobRefs(clone);
    assert.equal(await rehydrateInlineBlobs(clone), 2);
    assert.equal(at(clone, 'messages', 0, 'source', 'data'), shared);
    assert.equal(at(clone, 'messages', 1, 'source', 'data'), shared);

    for (const ref of refs) releaseBlob(ref.hash);
    assert.equal(await evictIdleBlobs(Date.now() + (config.ttlSeconds * 1000) + 1000), 1);
    assert.equal(blobFiles(config).length, 0);
  });

  it('copies the body rather than aliasing it', async () => {
    useConfig();
    const body: Record<string, unknown> = {
      model: 'claude',
      chat: [{ type: 'file', file: { file_data: payload('y', SMALL_CHARS) } }],
    };
    await extractInlineBlobs(body);

    const clone = cloneInlineBlobs(body);
    refAt(clone, 'chat', 0, 'file', 'file_data').kind = 'gemini-inline-data';
    (at(clone, 'chat', 0, 'file') as Record<string, unknown>).filename = 'clone-only.pdf';
    clone.model = 'gemini';

    assert.notStrictEqual(clone, body);
    assert.equal(refAt(body, 'chat', 0, 'file', 'file_data').kind, 'chat-file-data', 'the body keeps its own ref');
    assert.equal((at(body, 'chat', 0, 'file') as Record<string, unknown>).filename, undefined, 'a nested write must not show through');
    assert.equal(body.model, 'claude');

    // Two owners, two leases: both bodies release their own exactly once.
    assert.equal(releaseInlineBlobs(body), 1);
    assert.equal(releaseInlineBlobs(clone), 1);
  });

  it('is a plain deep copy for a body with nothing to clone', () => {
    useConfig();
    const body = { model: 'claude', messages: [{ role: 'user', content: 'hi' }] };

    const clone = cloneInlineBlobs(body);

    assert.deepStrictEqual(clone, body);
    assert.notStrictEqual(clone, body);
    assert.notStrictEqual(at(clone, 'messages', 0), at(body, 'messages', 0));
    assert.deepStrictEqual(getBlobStoreStats(), { cacheBytes: 0, cacheEntries: 0, diskBytes: 0, diskEntries: 0 });
  });

  it('takes no lease when the body cannot be cloned at all', async () => {
    const config = useConfig();
    const body: Record<string, unknown> = { chat: [{ type: 'file', file: { file_data: payload('z', SMALL_CHARS) } }] };
    await extractInlineBlobs(body);

    // `structuredClone` refuses a function (`DataCloneError`), and the copy is
    // made before any retain(): a refusal here has nothing to give back (§5.5).
    const uncopyable = { ...body, fn: () => 'not cloneable' };
    assert.throws(
      () => cloneInlineBlobs(uncopyable),
      (error: unknown) => {
        assert.ok(error instanceof DOMException, `expected DataCloneError, got ${String(error)}`);
        assert.equal(error.name, 'DataCloneError');
        assert.match(error.message, /could not be cloned/);
        return true;
      },
    );

    assert.equal(releaseInlineBlobs(body), 1);
    assert.equal(
      await evictIdleBlobs(Date.now() + (config.ttlSeconds * 1000) + 1000),
      1,
      'a failed clone must not have left a lease behind',
    );
  });

  it('refuses a body holding a ref that names no blob, releasing what it retained', async () => {
    const config = useConfig();
    const body: Record<string, unknown> = {
      chat: [
        { type: 'file', file: { file_data: payload('0', SMALL_CHARS) } },
        {
          type: 'file',
          // A client can send a ref-shaped object; the parse tree then holds one
          // real ref (first in traversal order, so it is retained first) and this
          // one, which names no blob.
          file: { file_data: { [BLOB_REF_MARKER]: true, kind: 'chat-file-data', hash: 'b'.repeat(64), size: SMALL_CHARS, prefix: '' } },
        },
      ],
    };
    await extractInlineBlobs(body);
    const real = refAt(body, 'chat', 0, 'file', 'file_data');
    assert.equal(collectBlobRefs(body).length, 2, 'one real ref and one forged ref in the tree');

    assert.throws(
      () => cloneInlineBlobs(body),
      (error: unknown) => {
        assert.ok(error instanceof BlobStoreError, `expected BlobStoreError, got ${String(error)}`);
        assert.match((error as Error).message, /cannot lease blob b{64}: it is not in the cache index/);
        return true;
      },
      'a ref that names no blob must refuse the clone',
    );

    // The real ref's retain was given back: releasing the body leaves nothing
    // pinned, which is exactly what a leaked lease from the clone would prevent.
    releaseBlob(real.hash);
    assert.equal(await evictIdleBlobs(Date.now() + (config.ttlSeconds * 1000) + 1000), 1);
    assert.equal(blobFiles(config).length, 0);
  });
});

describe('failure and refusal', () => {
  it('rolls back an all-or-nothing extraction and releases the leases it took', async () => {
    // Two 48-byte payloads fit; the third cannot, and the first two are leased,
    // so the store refuses rather than exceed the cap (§5.4).
    const config = useConfig({ max_blob_disk_bytes: 2 * SMALL_CHARS });
    const body = {
      messages: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: payload('q', SMALL_CHARS) } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: payload('r', SMALL_CHARS) } },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: payload('s', SMALL_CHARS) } },
      ],
    };
    const before = snapshot(body);

    await rejectsWith(extractInlineBlobs(body), BlobCapacityError, 'no idle blob can be freed');

    assert.deepStrictEqual(body, before, 'a failed extraction must leave the whole body as it was');
    assert.equal(collectBlobRefs(body).length, 0);
    assert.equal(getBlobStoreStats().diskEntries, 2);
    assert.equal(getBlobStoreStats().diskBytes, 2 * SMALL_CHARS, 'the cap must not be exceeded');

    // Both partial leases were given back: the entries are idle, not pinned.
    assert.equal(await evictIdleBlobs(Date.now() + (config.ttlSeconds * 1000) + 1000), 2);
    assert.equal(blobFiles(config).length, 0);
    assert.equal(getBlobStoreStats().diskBytes, 0);
  });

  it('refuses a ref whose hash is not a blob hash instead of building a path from it', async () => {
    useConfig();
    const body = {
      chat: [{ type: 'file', file: { file_data: { [BLOB_REF_MARKER]: true, kind: 'chat-file-data', hash: '../../../etc/passwd', size: 8, prefix: '' } } }],
    };

    await rejectsWith(rehydrateInlineBlobs(body), BlobStoreError, 'not a blob hash');
    assert.throws(
      () => releaseInlineBlobs(body),
      (error: unknown) => {
        assert.ok(error instanceof BlobStoreError);
        assert.match((error as Error).message, /not a blob hash/);
        return true;
      },
      'a forged hash must be refused on release too',
    );
  });

  it('treats the marker, not a hash-shaped field, as what makes a value a ref', async () => {
    useConfig();
    const inline = payload('w', SMALL_CHARS);
    const leased = await putBlob(inline);
    const fields = { kind: 'chat-file-data', hash: leased.hash, size: SMALL_CHARS, prefix: '' };

    // A request body is not a trusted producer of refs: the same fields without
    // the marker are client data, and both passes must leave them alone. A
    // marker without a hash is not a ref either, so no field is ever read as a
    // blob name on the strength of its shape.
    const body = {
      chat: [{ type: 'file', file: { file_data: { ...fields } } }],
      markerOnly: { [BLOB_REF_MARKER]: true, kind: 'chat-file-data' },
      numericHash: { [BLOB_REF_MARKER]: true, ...fields, hash: 42 },
    };
    const before = snapshot(body);

    assert.deepStrictEqual(await extractInlineBlobs(body), { refs: 0, bytes: 0, skipped: 0, hashes: [], blobs: [] }, 'a non-string field is no payload');
    assert.equal(await rehydrateInlineBlobs(body), 0);
    assert.deepStrictEqual(body, before);
    assert.deepStrictEqual(collectBlobRefs(body), []);
    assert.equal(releaseInlineBlobs(body), 0, 'nothing was recognized, so nothing is released');
    assert.equal(getBlobStoreStats().diskEntries, 1, 'the only blob is the one this test stored');

    // The marker is the whole difference: the same value with it is a ref, and
    // expands to the bytes the blob holds.
    const reader = { chat: [{ type: 'file', file: { file_data: { [BLOB_REF_MARKER]: true, ...fields } } }] };
    assert.equal(await rehydrateInlineBlobs(reader), 1);
    assert.equal(at(reader, 'chat', 0, 'file', 'file_data'), inline);
  });

  it('refuses a ref that does not match its blob, rather than sending wrong bytes', async () => {
    useConfig();
    const body = { chat: [{ type: 'file', file: { file_data: payload('t', SMALL_CHARS) } }] };
    await extractInlineBlobs(body);
    const ref = refAt(body, 'chat', 0, 'file', 'file_data');

    ref.size += SMALL_CHARS;
    await rejectsWith(rehydrateInlineBlobs(body), BlobStoreError, `records ${2 * SMALL_CHARS} bytes but the blob holds ${SMALL_CHARS}`);

    // A malformed ref must not be glued into a value: `undefined` has no prefix.
    delete (ref as Partial<BlobRef>).prefix;
    await rejectsWith(rehydrateInlineBlobs(body), BlobStoreError, 'malformed ref');
  });

  it('refuses a ref whose blob is gone instead of substituting an empty payload', async () => {
    useConfig();
    const body = {
      chat: [{ type: 'file', file: { file_data: { [BLOB_REF_MARKER]: true, kind: 'chat-file-data', hash: 'a'.repeat(64), size: 8, prefix: 'data:application/pdf;base64,' } } }],
    };

    await rejectsWith(rehydrateInlineBlobs(body), BlobStoreError, 'is not in the cache index');
  });

  it('refuses to extract while the spool is disabled, and leaves the body untouched', async () => {
    setSpoolConfig(resolveSpoolConfig({ ...SPOOL_DEFAULTS, enabled: false, dir: scratch() }));
    resetBlobStore();
    const body = { chat: [{ type: 'file', file: { file_data: payload('u', SMALL_CHARS) } }] };
    const before = snapshot(body);

    await assert.rejects(extractInlineBlobs(body), /\[spool\] blob store used while \[spool\] enabled = false/);

    assert.deepStrictEqual(body, before);
    // Nothing to extract is a no-op either way, so a disabled spool only matters
    // for a body that really carries an allowlisted payload.
    assert.deepStrictEqual(await extractInlineBlobs({ chat: [{ type: 'input_audio', input_audio: { format: 'wav' } }] }), { refs: 0, bytes: 0, skipped: 0, hashes: [], blobs: [] });
  });

  it('stores nothing for a payload that is already a blob hit', async () => {
    const config = useConfig();
    const shared = payload('v', SMALL_CHARS);
    const owner = await putBlob(shared); // an existing owner, e.g. another request's ref
    const body = { chat: [{ type: 'file', file: { file_data: shared } }] };

    const result = await extractInlineBlobs(body);

    assert.equal(result.refs, 1);
    assert.equal(blobFiles(config).length, 1, 'a hit must not write a second file');
    assert.equal(getBlobStoreStats().diskEntries, 1);
    assert.equal(getBlobStoreStats().diskBytes, SMALL_CHARS);
    assert.equal(refAt(body, 'chat', 0, 'file', 'file_data').hash, owner.hash);

    // The body's lease is one of the two, so giving it back does not free the blob.
    assert.equal(releaseInlineBlobs(body), 1);
    assert.equal(await evictIdleBlobs(Date.now() + (config.ttlSeconds * 1000) + 1000), 0, 'the other owner still holds it');

    // The surviving owner can still read it, and the last release ends its life.
    const reader = { chat: [{ type: 'file', file: { file_data: { [BLOB_REF_MARKER]: true, kind: 'chat-file-data', hash: owner.hash, size: SMALL_CHARS, prefix: '' } } }] };
    assert.equal(await rehydrateInlineBlobs(reader), 1);
    assert.equal(at(reader, 'chat', 0, 'file', 'file_data'), shared);

    releaseBlob(owner.hash);
    assert.equal(await evictIdleBlobs(Date.now() + (config.ttlSeconds * 1000) + 1000), 1);
  });
});
