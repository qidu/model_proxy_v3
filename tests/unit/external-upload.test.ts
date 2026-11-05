/**
 * Unit tests for the §5.8 external upload (src/utils/external-upload.ts): the
 * streaming L2 → auth-store upload that feeds the `external_blob` link.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.8, §10.
 *
 * Covers: the exact request (one PUT per distinct blob, the stored base64 text
 * as the body, exact Content-Length, the identity headers, the bearer token and
 * its absence), the returned hash→url map, rejection of every receipt field that
 * disagrees with what was uploaded (sha256, size, lifetime, URL scheme,
 * embedded credentials, non-JSON, non-2xx), redaction of the signed URL and of
 * an endpoint's error body, the per-blob timeout, transport classification,
 * the unconfigured-uploader refusal, an unreadable blob failing before any
 * request is opened, and the same wire framing observed by a real HTTP server.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BlobStoreError, putBlob, resetBlobStore, type LeasedBlob } from '../../src/utils/blob-store.js';
import { ExternalUploadError, uploadBlobsForAuth } from '../../src/utils/external-upload.js';
import {
  SPOOL_DEFAULTS,
  setSpoolConfig,
  type SpoolConfig,
  type SpoolExternalUploadConfig,
} from '../../src/utils/spool.js';

const UPLOAD_URL = 'https://auth.example/internal/blobs';
const TEXT_A = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TEXT_B = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const realFetch = globalThis.fetch;
const scratchDirs: string[] = [];
const servers: Server[] = [];

afterEach(() => {
  globalThis.fetch = realFetch;
  resetBlobStore();
});

after(() => {
  for (const server of servers) server.close();
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temp spool directory, removed after the suite. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'external-upload-test-'));
  scratchDirs.push(dir);
  return dir;
}

/** Install the spool and its uploader; returns the config that was installed. */
function installUploader(overrides: Partial<SpoolExternalUploadConfig> = {}): SpoolConfig {
  const config: SpoolConfig = {
    ...SPOOL_DEFAULTS,
    enabled: true,
    dir: scratch(),
    externalUpload: {
      uploadUrl: UPLOAD_URL,
      token: 's3cret',
      uploadTimeoutMs: 5000,
      urlMinLifetimeSeconds: 60,
      ...overrides,
    },
  };
  setSpoolConfig(config);
  return config;
}

/** Store a blob in the (already configured) spool. */
async function stored(text: string): Promise<LeasedBlob> {
  return await putBlob(text);
}

interface Call {
  url: string;
  init: RequestInit;
}

/** Replace `fetch`, recording every call and delegating to `handler`. */
function stubFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return await handler(call);
  }) as typeof fetch;
  return calls;
}

/** A receipt that agrees with `blob` on every field. */
function receiptFor(blob: LeasedBlob, overrides: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      url: `https://store.example/blobs/${blob.hash}?sig=abc`,
      sha256: blob.hash,
      size: blob.size,
      expires_in: 900,
      ...overrides,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/** Drain a request body stream into its text. */
async function bodyText(init: RequestInit): Promise<string> {
  const reader = (init.body as ReadableStream<Uint8Array>).getReader();
  const parts: Buffer[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts).toString('utf8');
}

/** The rejection of `promise`, or a failed assertion when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  assert.fail('expected the upload to fail, but it resolved');
}

/** Run an upload expected to fail, returning the asserted error. */
async function assertUploadError(promise: Promise<unknown>, needle: RegExp): Promise<ExternalUploadError> {
  const error = await rejection(promise);
  assert.ok(
    error instanceof ExternalUploadError,
    `expected ExternalUploadError, got ${error.name}: ${error.message}`,
  );
  assert.match(error.message, needle);
  return error;
}

describe('uploadBlobsForAuth — request', () => {
  it('PUTs each distinct blob once and maps its hash to the signed URL', async () => {
    installUploader();
    const a = await stored(TEXT_A);
    const b = await stored(TEXT_B);
    const calls = stubFetch((call) => {
      const hash = (call.init.headers as Record<string, string>)['x-blob-sha256'];
      return receiptFor(hash === a.hash ? a : b);
    });

    const links = await uploadBlobsForAuth([a, b, { hash: a.hash, size: a.size }]);

    assert.equal(calls.length, 2, 'a repeated hash is one stored object, so one upload');
    assert.equal(links.size, 2);
    assert.equal(links.get(a.hash), `https://store.example/blobs/${a.hash}?sig=abc`);
    assert.equal(links.get(b.hash), `https://store.example/blobs/${b.hash}?sig=abc`);

    const first = calls[0];
    assert.equal(first.url, UPLOAD_URL);
    assert.equal(first.init.method, 'PUT');
    assert.deepEqual(first.init.headers, {
      'content-type': 'application/octet-stream',
      'content-length': String(a.size),
      'x-blob-sha256': a.hash,
      'x-blob-size': String(a.size),
      authorization: 'Bearer s3cret',
    });
    // A streamed body is half-duplex; without this Node's fetch refuses it.
    assert.equal((first.init as RequestInit & { duplex?: string }).duplex, 'half');
    assert.ok(first.init.signal instanceof AbortSignal);
    assert.equal(await bodyText(first.init), TEXT_A);
    assert.equal(await bodyText(calls[1].init), TEXT_B);
  });

  it('omits the Authorization header when no token is configured', async () => {
    installUploader({ token: null });
    const a = await stored(TEXT_A);
    const calls = stubFetch(() => receiptFor(a));

    const links = await uploadBlobsForAuth([a]);

    assert.equal(links.size, 1);
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal('authorization' in headers, false);
  });

  it('returns an empty map for no blobs and opens no request', async () => {
    installUploader();
    const calls = stubFetch(() => assert.fail('no blob means no request'));

    const links = await uploadBlobsForAuth([]);

    assert.equal(links.size, 0);
    assert.equal(calls.length, 0);
  });

  it('refuses to upload when no external uploader is configured', async () => {
    setSpoolConfig({ ...SPOOL_DEFAULTS, enabled: true, dir: scratch(), externalUpload: null });
    const calls = stubFetch(() => assert.fail('an unconfigured uploader must not send anything'));

    const error = await assertUploadError(uploadBlobsForAuth([{ hash: 'a'.repeat(64), size: 4 }]), /not configured/);

    assert.equal(error.status, 500);
    assert.equal(calls.length, 0);
  });

  it('refuses two sizes for one blob instead of picking one', async () => {
    installUploader();
    const a = await stored(TEXT_A);
    stubFetch(() => receiptFor(a));

    await assertUploadError(
      uploadBlobsForAuth([a, { hash: a.hash, size: a.size + 10 }]),
      new RegExp(`sizes ${a.size} and ${a.size + 10}`),
    );
  });

  it('fails before any request when a blob cannot be read, never returning a partial map', async () => {
    installUploader();
    const a = await stored(TEXT_A);
    const calls = stubFetch(() => receiptFor(a));

    const error = await rejection(
      uploadBlobsForAuth([a, { hash: 'b'.repeat(64), size: 4 }]),
    );

    assert.ok(error instanceof BlobStoreError, `expected BlobStoreError, got ${error.name}: ${error.message}`);
    assert.match(error.message, /is not in the cache index/);
    // The readable blob went first; the unreadable one was refused before its
    // own request existed, and the caller got nothing back.
    assert.equal(calls.length, 1);
  });
});

describe('uploadBlobsForAuth — receipt verification (§5.8)', () => {
  it('rejects a receipt for a different object by hash', async () => {
    installUploader();
    const a = await stored(TEXT_A);
    stubFetch(() => receiptFor(a, { sha256: 'f'.repeat(64) }));

    const error = await assertUploadError(
      uploadBlobsForAuth([a]),
      new RegExp(`blob ${a.hash} stored a different object: it answered sha256 ${'f'.repeat(64)}`),
    );
    assert.equal(error.message.includes('sig=abc'), false, 'the signed URL must not be echoed');
  });

  it('rejects a receipt whose size is not the uploaded length', async () => {
    installUploader();
    const a = await stored(TEXT_A);
    stubFetch(() => receiptFor(a, { size: a.size + 1 }));

    await assertUploadError(
      uploadBlobsForAuth([a]),
      new RegExp(`stored ${a.size + 1} of ${a.size} bytes`),
    );
  });

  it('takes a hash echo in either case but not an empty one', async () => {
    installUploader();
    const a = await stored(TEXT_A);
    stubFetch(() => receiptFor(a, { sha256: a.hash.toUpperCase() }));

    const links = await uploadBlobsForAuth([a]);
    assert.equal(links.get(a.hash), `https://store.example/blobs/${a.hash}?sig=abc`);

    stubFetch(() => receiptFor(a, { sha256: '' }));
    await assertUploadError(uploadBlobsForAuth([a]), /stored a different object/);
  });

  it('rejects a link lifetime below the configured floor and accepts one at it', async () => {
    installUploader({ urlMinLifetimeSeconds: 60 });
    const a = await stored(TEXT_A);

    stubFetch(() => receiptFor(a, { expires_in: 59 }));
    await assertUploadError(uploadBlobsForAuth([a]), /lifetime of 59 s, below the 60 s minimum/);

    stubFetch(() => receiptFor(a, { expires_in: 60 }));
    const links = await uploadBlobsForAuth([a]);
    assert.equal(links.size, 1);

    stubFetch(() => receiptFor(a, { expires_in: '900' }));
    await assertUploadError(uploadBlobsForAuth([a]), /lifetime of 900 s, below the 60 s minimum/);
  });

  it('rejects a non-2xx answer without echoing its body', async () => {
    installUploader();
    const a = await stored(TEXT_A);
    stubFetch(() => new Response(
      JSON.stringify({ url: 'https://store.example/leak?sig=leak' }),
      { status: 500, headers: { 'content-type': 'application/json' } },
    ));

    const error = await assertUploadError(uploadBlobsForAuth([a]), /answered HTTP 500/);
    assert.equal(error.message.includes('leak'), false, 'an endpoint error body may quote a signed URL');
  });

  it('rejects an answer that is not JSON', async () => {
    installUploader();
    const a = await stored(TEXT_A);
    stubFetch(() => new Response('ok', { status: 200 }));

    await assertUploadError(uploadBlobsForAuth([a]), /did not answer JSON/);
  });

  it('rejects an answer that is not a link object', async () => {
    installUploader();
    const a = await stored(TEXT_A);
    stubFetch(() => new Response(JSON.stringify(['https://store.example/b']), { status: 200 }));

    await assertUploadError(uploadBlobsForAuth([a]), /answered an array instead of a link object/);
  });

  it('rejects a link that is not HTTPS, not a URL, or carries credentials', async () => {
    installUploader();
    const a = await stored(TEXT_A);

    stubFetch(() => receiptFor(a, { url: 'http://store.example/b?sig=abc' }));
    await assertUploadError(uploadBlobsForAuth([a]), /returned a http: link, not https:/);

    stubFetch(() => receiptFor(a, { url: 'not a url' }));
    await assertUploadError(uploadBlobsForAuth([a]), /link that is not a URL/);

    stubFetch(() => receiptFor(a, { url: 'https://user:hunter2@store.example/b?sig=abc' }));
    const error = await assertUploadError(uploadBlobsForAuth([a]), /link with embedded credentials/);
    assert.equal(error.message.includes('hunter2'), false, 'the credential must not be echoed');

    stubFetch(() => receiptFor(a, { url: '   ' }));
    await assertUploadError(uploadBlobsForAuth([a]), /answered no url/);
  });
});

describe('uploadBlobsForAuth — failures', () => {
  it('times out one blob after the configured budget and does not retry it', async () => {
    installUploader({ uploadTimeoutMs: 25 });
    const a = await stored(TEXT_A);
    const calls = stubFetch((call) => new Promise<Response>((_resolve, reject) => {
      // A stub holds no socket, and the uploader's own budget timer is unref'd
      // (deliberately: it must not outlive a settled request), so this ref'd
      // timer is what keeps the event loop alive while the fetch is "in flight".
      const inFlight = setTimeout(() => {}, 5000);
      call.init.signal?.addEventListener('abort', () => {
        clearTimeout(inFlight);
        reject(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
      });
    }));

    const error = await assertUploadError(uploadBlobsForAuth([a]), /timed out after 25 ms/);

    assert.equal(error.status, 504);
    assert.equal(error.type, 'upstream_timeout');
    assert.equal(calls.length, 1);
  });

  it('classifies a transport failure without leaking the endpoint', async () => {
    installUploader();
    const a = await stored(TEXT_A);
    stubFetch(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    });

    const error = await assertUploadError(uploadBlobsForAuth([a]), /failed: Upstream service unreachable/);

    assert.equal(error.status, 502);
    assert.equal(error.type, 'upstream_unreachable');
    assert.equal(error.message.includes('auth.example'), false, 'the configured endpoint stays out of errors');
    assert.equal(error.message.includes('s3cret'), false);
  });
});

describe('uploadBlobsForAuth — against a real endpoint', () => {
  it('streams the stored bytes with the declared length and headers', async () => {
    // The config URL is HTTPS at load time; this test points the uploader at a
    // local HTTP server to observe the actual wire framing (undici accepts a
    // stream body with an explicit Content-Length, which a stubbed fetch cannot
    // prove).
    const received: { method: string; headers: IncomingHttpHeaders; body: string }[] = [];
    const server = createServer((request, response) => {
      const parts: Buffer[] = [];
      request.on('data', (chunk: Buffer) => parts.push(chunk));
      request.on('end', () => {
        const body = Buffer.concat(parts).toString('utf8');
        received.push({ method: request.method ?? '', headers: request.headers, body });
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({
          url: `https://store.example/blobs/${request.headers['x-blob-sha256']}?sig=abc`,
          sha256: request.headers['x-blob-sha256'],
          size: Buffer.byteLength(body),
          expires_in: 900,
        }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');

    installUploader({ uploadUrl: `http://127.0.0.1:${address.port}/upload` });
    const a = await stored(TEXT_A);

    const links = await uploadBlobsForAuth([a]);

    assert.equal(links.get(a.hash), `https://store.example/blobs/${a.hash}?sig=abc`);
    assert.equal(received.length, 1);
    const seen = received[0];
    assert.equal(seen.method, 'PUT');
    assert.equal(seen.body, TEXT_A);
    assert.equal(seen.headers['content-length'], String(a.size));
    assert.equal(seen.headers['content-type'], 'application/octet-stream');
    assert.equal(seen.headers['x-blob-sha256'], a.hash);
    assert.equal(seen.headers['x-blob-size'], String(a.size));
    assert.equal(seen.headers.authorization, 'Bearer s3cret');
  });
});
