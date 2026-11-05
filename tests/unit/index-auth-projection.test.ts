import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';
import { clearModelCache } from '../../src/handlers/models.js';
import { evictIdleBlobs, getBlobStoreStats, resetBlobStore } from '../../src/utils/blob-store.js';
import { BLOB_REF_MARKER } from '../../src/utils/blob-refs.js';
import { getSpoolConfig } from '../../src/utils/spool.js';

// §5.8 external-link projection, wired into the request path: with an uploader
// configured, `auth_with_body` receives the projection built from the
// still-extracted body's leases — one PUT per distinct blob, then a link object
// where the inline payload was — while the upstream send still carries the
// original base64. These tests drive the real handler because the wiring lives
// in `src/index.ts`; the projection itself is covered by auth-projection.test.ts
// and the wire contract by external-upload.test.ts.

const realFetch = globalThis.fetch;
const UPLOAD_URL = 'https://upload.example/internal/blobs';
const AUTH_URL = 'https://auth.example/validate';
const UPSTREAM_BASE = 'https://upstream.example';
const TOKEN = 'upload-token';
const SIGNED_URL = 'https://objects.example.test/blobs/abc.b64?exp=1700000000&sig=deadbeef';
const LINK_LIFETIME_S = 900;
const TTL_SECONDS = 60;

const CHAT_COMPLETION = JSON.stringify({
  id: 'chat-projection', object: 'chat.completion', created: 1, model: 'test',
  choices: [{ index: 0, message: { role: 'assistant', content: 'seen' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
});

interface UploadCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  /** Whether the endpoint was handed a stream, not a buffered string. */
  streamed: boolean;
}

interface AuthCall {
  method: string;
  headers: Record<string, string>;
  /** `undefined` when the call carried no body at all. */
  body: string | undefined;
}

let tempDir = '';
let configPath = '';
let uploadCalls: UploadCall[] = [];
let authCalls: AuthCall[] = [];
let upstreamCalls = 0;
let upstreamText = '';
/**
 * Blobs the idle sweep could have removed *while a request was in flight*, one
 * sample per external call. §5.8 renews the lease across upload, auth fetch and
 * the upstream send; this is the observable that says whether it held.
 */
let evictionsDuringRequest: number[] = [];
/** The answer the upload endpoint gives, once per PUT. */
let uploadResponse: (headers: Record<string, string>) => Response;

/** A past-TTL clock, so an unleased blob is expired by the next sweep. */
function afterTtl(): number {
  return Date.now() + (TTL_SECONDS + 60) * 1000;
}

/** The headers a call carried, lowercased; the modules under test pass records. */
function headersOf(init: RequestInit | undefined): Record<string, string> {
  const raw = (init?.headers ?? {}) as Record<string, string>;
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

/** The text a call carried, whichever shape the sender chose. */
async function bodyTextOf(body: BodyInit | null | undefined): Promise<string> {
  if (typeof body === 'string') return body;
  assert.ok(body instanceof ReadableStream, `expected a string or streamed body, got ${Object.prototype.toString.call(body)}`);
  return await new Response(body).text();
}

/** The URL a stubbed call targeted. */
function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

/** Read a path out of a parsed body, so an assertion names the exact position. */
function at(root: unknown, ...path: (string | number)[]): unknown {
  let node = root as Record<string | number, unknown>;
  for (const key of path) node = node[key] as Record<string | number, unknown>;
  return node;
}

/** The `external_blob` link at `path`, asserting the position really holds one. */
function linkAt(body: unknown, ...path: (string | number)[]): Record<string, unknown> {
  const value = at(body, ...path) as Record<string, unknown>;
  assert.equal(value?.type, 'external_blob', `expected a link at ${path.join('.')}, got ${JSON.stringify(value)}`);
  return value;
}

interface AuthConfig {
  /** `[remote] auth_with_body` — the mode §5.8 projects into. */
  withBody?: boolean;
  /** `[remote] auth_with_model`. */
  withModel?: boolean;
  /** `[spool] external_upload_url` — absent keeps the full-body auth path. */
  uploader?: boolean;
}

function writeConfig({ withBody = true, withModel = false, uploader = true }: AuthConfig = {}): void {
  const spoolKeys = [
    'enabled = true',
    `dir = ${JSON.stringify(join(tempDir, 'spool'))}`,
    `ttl_seconds = ${TTL_SECONDS}`,
    uploader ? `external_upload_url = ${JSON.stringify(UPLOAD_URL)}` : '',
    uploader ? `external_upload_token = ${JSON.stringify(TOKEN)}` : '',
    uploader ? `external_url_min_lifetime_s = ${LINK_LIFETIME_S}` : '',
  ].filter((line) => line !== '');

  writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = ${JSON.stringify(UPSTREAM_BASE)}
api_key = "upstream-key"

[remote]
auth_server = ${JSON.stringify(AUTH_URL)}
auth_with_body = ${withBody}
auth_with_model = ${withModel}

[spool]
${spoolKeys.join('\n')}
`, 'utf8');
  clearProxyConfigCache();
}

function env(): Record<string, string> {
  return { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' };
}

/** A `/v1/messages` body holding one image per payload, in order. */
function messagesBody(images: string[], model = 'test'): string {
  return JSON.stringify({
    model,
    max_tokens: 32,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'what is this' },
        ...images.map((data) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data } })),
      ],
    }],
  });
}

function clientRequest(bodyText: string): Request {
  return new Request('http://proxy/v1/messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
    body: bodyText,
  });
}

beforeEach(() => {
  clearProxyConfigCache();
  clearModelCache();
  resetBlobStore();
  tempDir = mkdtempSync(join(tmpdir(), 'mpv3-index-auth-projection-'));
  configPath = join(tempDir, 'proxy.toml');
  uploadCalls = [];
  authCalls = [];
  upstreamCalls = 0;
  upstreamText = '';
  evictionsDuringRequest = [];
  uploadResponse = (headers) => new Response(JSON.stringify({
    url: SIGNED_URL,
    sha256: headers['x-blob-sha256'],
    size: Number(headers['x-blob-size']),
    expires_in: LINK_LIFETIME_S,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    if (url === new URL(UPLOAD_URL).toString()) {
      const headers = headersOf(init);
      uploadCalls.push({
        url,
        method: init?.method ?? 'GET',
        headers,
        body: await bodyTextOf(init?.body),
        streamed: init?.body instanceof ReadableStream,
      });
      evictionsDuringRequest.push(await evictIdleBlobs(afterTtl()));
      return uploadResponse(headers);
    }
    if (url === AUTH_URL) {
      authCalls.push({
        method: init?.method ?? 'GET',
        headers: headersOf(init),
        body: init?.body === undefined || init?.body === null ? undefined : await bodyTextOf(init.body),
      });
      evictionsDuringRequest.push(await evictIdleBlobs(afterTtl()));
      return new Response(JSON.stringify({ version: '1' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    upstreamCalls += 1;
    upstreamText = await bodyTextOf(init?.body);
    evictionsDuringRequest.push(await evictIdleBlobs(afterTtl()));
    return new Response(CHAT_COMPLETION, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  clearProxyConfigCache();
  clearModelCache();
  resetBlobStore();
  globalThis.fetch = realFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('§5.8 external-link projection in the request path', () => {
  it('uploads each distinct blob and hands auth a link where the payload was', async () => {
    const image = Buffer.alloc(600, 0xcd).toString('base64');
    const hash = createHash('sha256').update(image).digest('hex');
    writeConfig();

    const response = await handler.fetch(clientRequest(messagesBody([image])), env() as any);

    assert.equal(response.status, 200);

    // The upload: one PUT, the stored base64 text itself, named by the identity
    // the ref states (§5.4's sha256 of the base64 text, not of the raw bytes).
    assert.equal(uploadCalls.length, 1);
    const put = uploadCalls[0];
    assert.equal(put.url, new URL(UPLOAD_URL).toString());
    assert.equal(put.method, 'PUT');
    assert.ok(put.streamed, 'the payload is streamed to the endpoint, never buffered whole (§5.8)');
    assert.equal(put.headers['content-type'], 'application/octet-stream');
    assert.equal(put.headers['content-length'], String(image.length), 'the declared length is the exact stored text length');
    assert.equal(put.headers['x-blob-sha256'], hash);
    assert.equal(put.headers['x-blob-size'], String(image.length));
    assert.equal(put.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(put.body, image, 'the endpoint receives the stored base64 text byte for byte');

    // The auth request: the projection, at the ref's own field path, with the
    // surrounding metadata kept and no payload bytes left in it.
    assert.equal(authCalls.length, 1);
    const auth = authCalls[0];
    assert.equal(auth.method, 'POST', 'auth_with_body posts the body it is handed');
    assert.equal(auth.headers['content-type'], 'application/json');
    assert.equal(auth.body?.includes(image), false, 'the auth request carries no inline payload');
    const authBody = JSON.parse(auth.body as string) as unknown;
    assert.deepStrictEqual(
      at(authBody, 'messages', 0, 'content', 1),
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: {
            type: 'external_blob',
            url: SIGNED_URL,
            sha256: hash,
            size: image.length,
            media_type: 'image/png',
            encoding: 'base64',
          },
        },
      },
      'the link stands exactly where the payload was',
    );

    // The upstream send: the original inline bytes, and nothing of §5.8's.
    assert.equal(upstreamCalls, 1);
    assert.ok(upstreamText.includes(`data:image/png;base64,${image}`), 'the upstream still receives the inline payload (§5.3)');
    assert.equal(upstreamText.includes('external_blob'), false, 'no link object may reach a model API');
    assert.equal(upstreamText.includes(SIGNED_URL), false, 'the signed URL is the auth sidecar’s alone');

    // The lease: held across upload, auth and the upstream send, released at
    // request end (§5.8, §5.5).
    assert.deepStrictEqual(evictionsDuringRequest, [0, 0, 0], 'the blob stays leased through every external call');
    assert.equal(await evictIdleBlobs(afterTtl()), 1, 'the request-end release leaves it idle, so the sweep may expire it');
    assert.equal(getBlobStoreStats().diskEntries, 0);
  });

  it('fails auth on an upload the endpoint rejected, before auth or the upstream', async () => {
    const image = Buffer.alloc(600, 0xef).toString('base64');
    writeConfig();
    uploadResponse = () => new Response('{"error":"endpoint says no"}', { status: 503 });

    const response = await handler.fetch(clientRequest(messagesBody([image])), env() as any);

    assert.equal(response.status, 500);
    const payload = await response.json() as { type: string; error: { type: string; message: string } };
    assert.equal(payload.type, 'error');
    assert.equal(payload.error.type, 'processing_error');
    assert.match(payload.error.message, /external upload/);
    assert.match(payload.error.message, /HTTP 503/, 'the failure names the endpoint’s status');
    assert.equal(payload.error.message.includes('endpoint says no'), false, 'the endpoint’s body is never echoed');
    assert.equal(authCalls.length, 0, '§5.8: a failed upload fails auth explicitly rather than sending a broken link');
    assert.equal(upstreamCalls, 0, 'and prevents the upstream call');
    assert.equal(await evictIdleBlobs(afterTtl()), 1, 'the request-end release runs on the failure path too, so no lease leaks');
  });

  it('fails the request when the receipt names a different object', async () => {
    const image = Buffer.alloc(600, 0x11).toString('base64');
    writeConfig();
    uploadResponse = (headers) => new Response(JSON.stringify({
      url: SIGNED_URL,
      sha256: 'a'.repeat(64),
      size: Number(headers['x-blob-size']),
      expires_in: LINK_LIFETIME_S,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    const response = await handler.fetch(clientRequest(messagesBody([image])), env() as any);

    assert.equal(response.status, 500);
    const payload = await response.json() as { error: { type: string; message: string } };
    assert.equal(payload.error.type, 'processing_error');
    assert.match(payload.error.message, /stored a different object/, 'hash/size verification is what refuses the link (§5.8)');
    assert.equal(authCalls.length, 0);
    assert.equal(upstreamCalls, 0);
  });

  it('keeps the full inline body for auth when no uploader is configured', async () => {
    const image = Buffer.alloc(600, 0x22).toString('base64');
    writeConfig({ uploader: false });

    const response = await handler.fetch(clientRequest(messagesBody([image])), env() as any);

    assert.equal(response.status, 200);
    assert.equal(getSpoolConfig().externalUpload, null, 'this test is the no-uploader configuration');
    assert.equal(uploadCalls.length, 0, 'nothing leaves the host without an opt-in uploader');
    assert.equal(authCalls.length, 1);
    const authBody = JSON.parse(authCalls[0].body as string) as unknown;
    assert.equal(
      at(authBody, 'messages', 0, 'content', 1, 'source', 'data'),
      image,
      '§5.8: with no external uploader configured, auth keeps receiving the full body',
    );
    assert.equal(
      JSON.stringify(authBody).includes(BLOB_REF_MARKER),
      false,
      '§5.3 shape 2: auth gets the payloads themselves, not the refs the boundary now forwards',
    );
    // The auth body is expanded from a clone, so the clone must not hold a lease
    // of its own: one that leaked would keep the blob alive past the request.
    assert.deepStrictEqual(evictionsDuringRequest, [0, 0], 'the blob stays leased across auth and the upstream send');
    assert.equal(await evictIdleBlobs(afterTtl()), 1, 'the request-end release still leaves the blob idle, so no lease leaked from the clone');
    assert.equal(getBlobStoreStats().diskEntries, 0);
    assert.equal(upstreamCalls, 1, 'and the upstream send is unaffected either way');
  });

  it('does not upload or project when auth_with_body is off', async () => {
    const image = Buffer.alloc(600, 0x33).toString('base64');
    writeConfig({ withBody: false, withModel: true });

    const response = await handler.fetch(clientRequest(messagesBody([image])), env() as any);

    assert.equal(response.status, 200);
    assert.equal(uploadCalls.length, 0, 'auth_with_model forwards a header, not a body — there is nothing to project into');
    assert.equal(authCalls.length, 1);
    assert.equal(authCalls[0].method, 'GET');
    assert.equal(authCalls[0].body, undefined, 'the model-only mode sends no body at all');
    assert.equal(authCalls[0].headers['x-resource-for'], 'test');
    assert.ok(upstreamText.includes(`data:image/png;base64,${image}`));
  });

  it('uploads one object for two refs to one payload', async () => {
    const image = Buffer.alloc(600, 0x44).toString('base64');
    const hash = createHash('sha256').update(image).digest('hex');
    writeConfig();

    const response = await handler.fetch(clientRequest(messagesBody([image, image])), env() as any);

    assert.equal(response.status, 200);
    assert.equal(uploadCalls.length, 1, 'two refs to one payload are one stored object and one upload (§5.4)');
    const authBody = JSON.parse(authCalls[0].body as string) as unknown;
    const first = linkAt(authBody, 'messages', 0, 'content', 1, 'source', 'data');
    const second = linkAt(authBody, 'messages', 0, 'content', 2, 'source', 'data');
    assert.deepStrictEqual(second, first, 'both refs project to the one link');
    assert.equal(first.sha256, hash);
    assert.equal(upstreamText.split(`data:image/png;base64,${image}`).length - 1, 2, 'the upstream gets both payloads back');
  });

  it('refuses a client-forged ref instead of uploading it', async () => {
    const image = Buffer.alloc(600, 0x55).toString('base64');
    const forgedHash = 'f'.repeat(64);
    writeConfig();
    const bodyText = JSON.stringify({
      model: 'test',
      max_tokens: 32,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
          // A ref the client made up: the marker and a plausible shape, but no
          // blob this request ever leased.
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: { $spoolBlob: true, kind: 'claude-source-data', hash: forgedHash, size: 12, prefix: 'data:image/png;base64,' },
            },
          },
        ],
      }],
    });

    const response = await handler.fetch(clientRequest(bodyText), env() as any);

    assert.equal(response.status, 500);
    const payload = await response.json() as { error: { type: string; message: string } };
    assert.equal(payload.error.type, 'processing_error');
    assert.match(payload.error.message, new RegExp(`no external link for blob ${forgedHash}`));
    // The one PUT is this request's own lease, uploaded before the projection
    // refused: the forged hash names no lease, so it is never uploaded (§5.2).
    assert.equal(uploadCalls.length, 1);
    assert.notEqual(uploadCalls[0].headers['x-blob-sha256'], forgedHash);
    assert.equal(payload.error.message.includes(SIGNED_URL), false, 'a signed URL is never echoed');
    assert.equal(authCalls.length, 0);
    assert.equal(upstreamCalls, 0, 'a body with a forged ref never reaches an upstream');
    assert.equal(await evictIdleBlobs(afterTtl()), 1, 'the leased blob was released even though the request failed');
  });
});
