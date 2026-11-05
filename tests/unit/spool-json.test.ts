import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BLOB_REF_MARKER, extractInlineBlobs, rehydrateInlineBlobs, releaseExtractedBlobs } from '../../src/utils/blob-refs.js';
import { resetBlobStore } from '../../src/utils/blob-store.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { SpoolRequestTooLargeError } from '../../src/utils/spool-ingress.js';
import { createJsonEgressBody, createTextEgressBody, postJsonWithSpool } from '../../src/utils/spool-json.js';
import { requestSpillDir, SPOOL_DEFAULTS, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';

const scratchDirs: string[] = [];
const realFetch = globalThis.fetch;

function configure(overrides: Partial<SpoolConfig> = {}): SpoolConfig {
  const dir = mkdtempSync(join(tmpdir(), 'spool-json-test-'));
  scratchDirs.push(dir);
  const config: SpoolConfig = {
    ...SPOOL_DEFAULTS,
    enabled: true,
    dir,
    thresholdBytes: 64,
    maxRequestBytes: 4096,
    ...overrides,
  };
  setSpoolConfig(config);
  return config;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  setSpoolConfig(SPOOL_DEFAULTS);
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  assert.equal(getLiveSpillBytes(), 0, 'the egress spool must return its reservation');
});

function spillFiles(config: SpoolConfig): string[] {
  const dir = requestSpillDir(config);
  return existsSync(dir) ? readdirSync(dir) : [];
}

async function readBody(body: string | ReadableStream<Uint8Array>): Promise<Uint8Array> {
  if (typeof body === 'string') return new TextEncoder().encode(body);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

describe('JSON egress spool', () => {
  it('keeps a body at or below threshold_bytes as the existing string path', async () => {
    const config = configure();
    const egress = await createTextEgressBody('{"small":true}', 'eff-');

    assert.equal(egress.body, '{"small":true}');
    assert.equal(egress.spilled, false);
    assert.equal(egress.contentLength, undefined);
    assert.deepEqual(spillFiles(config), []);
  });

  it('spills oversized final text, streams it byte-identically, and cleans up after the send', async () => {
    const config = configure();
    const text = JSON.stringify({ model: 'm', padding: '日本語' + 'x'.repeat(300) });
    const egress = await createTextEgressBody(text, 'att-');
    const expected = new TextEncoder().encode(text);

    assert.equal(egress.spilled, true);
    assert.ok(egress.body instanceof ReadableStream);
    assert.equal(egress.contentLength, expected.byteLength, 'the declared length is UTF-8 bytes, not characters');
    assert.equal(getLiveSpillBytes(), expected.byteLength);

    const sent = await readBody(egress.body);
    assert.equal(createHash('sha256').update(sent).digest('hex'), createHash('sha256').update(expected).digest('hex'));
    assert.deepEqual(spillFiles(config), [], 'the last read deletes the attempt spill');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('enforces max_request_bytes on the final attempt body and leaves nothing behind', async () => {
    const config = configure({ maxRequestBytes: 100 });

    await assert.rejects(
      createTextEgressBody('x'.repeat(101), 'att-'),
      (error: unknown) => {
        assert.ok(error instanceof SpoolRequestTooLargeError, `expected SpoolRequestTooLargeError, got ${String(error)}`);
        assert.equal(error.status, 413);
        return true;
      },
    );
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('releases an unused oversized body when its reader cancels before any byte', async () => {
    const config = configure();
    const egress = await createTextEgressBody('y'.repeat(200), 'att-');
    assert.ok(egress.body instanceof ReadableStream);
    assert.equal(spillFiles(config).length, 1);

    await egress.body.cancel(new Error('send aborted before it started'));

    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('serializes a final object exactly once at the egress boundary', async () => {
    configure();
    const value = { count: 1 };
    let stringified = 0;
    Object.defineProperty(value, 'count', {
      enumerable: true,
      get() {
        stringified += 1;
        return 1;
      },
    });

    const egress = await createJsonEgressBody(value, 'att-');
    assert.equal(stringified, 1);
    assert.deepEqual(await readBody(egress.body), new TextEncoder().encode('{"count":1}'));
  });

  it('posts an oversized attempt from its spill with an exact length and the caller\'s signal', async () => {
    const config = configure();
    const value = { model: 'm', padding: 'z'.repeat(300) };
    const expected = new TextEncoder().encode(JSON.stringify(value));
    const controller = new AbortController();
    let seen: { headers: Headers; body: unknown; signal: AbortSignal | null | undefined } | undefined;

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = { headers: new Headers(init?.headers), body: init?.body, signal: init?.signal };
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    const response = await postJsonWithSpool('https://upstream.test/v1/messages', value, {
      headers: { 'Content-Type': 'application/json', 'x-test': 'kept' },
      signal: controller.signal,
    });

    assert.equal(response.status, 200);
    assert.ok(seen);
    assert.equal(seen.headers.get('x-test'), 'kept');
    assert.equal(seen.headers.get('content-length'), String(expected.byteLength));
    assert.equal(seen.signal, controller.signal);
    assert.ok(seen.body instanceof ReadableStream, 'the oversized attempt must stream from disk');
    assert.equal(createHash('sha256').update(await readBody(seen.body)).digest('hex'), createHash('sha256').update(expected).digest('hex'));
    assert.deepEqual(spillFiles(config), [], 'the completed send removes the attempt spill');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('cancels an unconsumed attempt spill when fetch rejects before sending it', async () => {
    const config = configure();
    const value = { model: 'm', padding: 'z'.repeat(300) };
    globalThis.fetch = (async () => {
      throw new Error('connection refused before request body');
    }) as typeof fetch;

    await assert.rejects(
      postJsonWithSpool('https://upstream.test/v1/messages', value, {
        headers: { 'Content-Type': 'application/json' },
      }),
      /connection refused before request body/,
    );

    assert.deepEqual(spillFiles(config), [], 'the unread attempt spill is removed');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('streams every request-allowlist predicate byte-identically through the shared POST path', async () => {
    configure();
    resetBlobStore();
    const payload = (seed: number) => Buffer.alloc(72, seed).toString('base64');
    const body: Record<string, unknown> = {
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: payload(1) } },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: payload(2) } },
      ] }],
      chat: [
        { type: 'image_url', image_url: { url: `data:image/png;base64,${payload(3)}` } },
        { type: 'input_audio', input_audio: { data: payload(4), format: 'wav' } },
        { type: 'file', file: { filename: 'bare.pdf', file_data: payload(5) } },
        { type: 'file', file: { filename: 'url.pdf', file_data: `data:application/pdf;base64,${payload(6)}` } },
      ],
      gemini: [
        { inline_data: { mime_type: 'video/mp4', data: payload(7) } },
        { inlineData: { mimeType: 'audio/mp3', data: payload(8) } },
      ],
      responses: [
        { type: 'input_image', image_url: `data:image/jpeg;base64,${payload(9)}` },
        { type: 'input_image', image_url: { url: `data:image/jpeg;base64,${payload(10)}` } },
        { type: 'input_file', file_data: payload(11) },
        { type: 'inline', source: { type: 'base64', media_type: 'application/zip', data: payload(12) } },
      ],
    };
    const expanded = structuredClone(body);
    const extraction = await extractInlineBlobs(body);
    assert.equal(extraction.refs, 12, 'the fixture must cover every implemented request predicate');
    assert.ok(JSON.stringify(body).includes(BLOB_REF_MARKER));
    await rehydrateInlineBlobs(expanded);
    const expected = JSON.stringify(expanded);

    let seen: { text: string; headers: Headers } | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = { text: await new Response(init?.body as BodyInit).text(), headers: new Headers(init?.headers) };
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    try {
      await postJsonWithSpool('https://upstream.test/v1/messages', body, {
        headers: { 'Content-Type': 'application/json' },
      });
      assert.ok(seen);
      assert.equal(seen.text, expected, 'every ref position must round-trip to the same JSON bytes');
      assert.equal(seen.text.includes(BLOB_REF_MARKER), false, 'no ref metadata may reach upstream');
      assert.equal(seen.headers.get('content-length'), String(Buffer.byteLength(expected)));
    } finally {
      assert.equal(releaseExtractedBlobs(extraction), 12);
    }
  });
});
