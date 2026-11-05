/**
 * Unit tests for §5.3 shape 3 in `src/handlers/chat-completions.ts`: the native
 * `/v1/chat/completions` send keeps the body's §5.4 refs and streams each payload
 * out of L2 at the offset its ref occupies, instead of expanding the body first.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.2, §5.3, §5.4.
 *
 * The property under test is that the graduate path is invisible upstream. Every
 * case here drives the real handler against a live spool (so the refs are real
 * leased ones and the payloads really come out of the blob store) and asserts on
 * what the fetch call actually carried: the bytes, the declared `Content-Length`,
 * and `duplex`. The byte-identity case is the load-bearing one — it compares the
 * streamed send against the same request sent by the shape-2 string path, so a
 * serializer that dropped, re-escaped, reordered or truncated a payload fails
 * even though the JSON still parses.
 *
 * This handler picks its shape once, in one expression, so both branches are
 * asserted here: the native send streams (the first five cases) and so do the
 * three converting modes, whose converters now re-emit the ref into their own
 * envelope instead of reading the field as a string (the last case). That is the
 * property the last case exists to hold: when those converters were ref-blind,
 * a ref left in the body cost the image — `completionsToResponsesBody` forwarded
 * the ref object itself as `image_url.url`, while `completionsToClaudeBody` and
 * `convertCompletionsToGeminiGenerateContentBody` failed to decode it as a data
 * URI and dropped the part, so the client's image reached the upstream as
 * nothing at all. `tests/unit/request-ref-matrix.test.ts` pins the same
 * conversions end to end through the front-door handlers.
 * `/v1/completions` is deliberately absent: it is an alias onto this handler but
 * is not in the §5.4 extraction gate in `src/index.ts`, so a request on that path
 * can never carry a ref.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleChatCompletionsPassthrough } from '../../src/handlers/chat-completions.js';
import { BLOB_REF_MARKER, extractInlineBlobs } from '../../src/utils/blob-refs.js';
import { BlobStoreError, BLOB_STREAM_CHUNK_BYTES, resetBlobStore } from '../../src/utils/blob-store.js';
import { createLogger } from '../../src/utils/logger.js';
import { resolveSpoolConfig, setSpoolConfig } from '../../src/utils/spool.js';

const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});
const CLIENT_URL = 'http://proxy';
const UPSTREAM_URL = 'https://upstream.example/v1/chat/completions';
const GEMINI_UPSTREAM_URL = 'https://upstream.example/v1beta/models/gemini-test:generateContent';

/** The three modes whose branch below converts this body and returns before the native send. */
const CONVERTING_MODES = ['anthropic-messages', 'openai-responses', 'gemini-generatecontent'];

/** A distinct, valid base64 payload: 48 bytes, 64 characters, no padding. */
const PAYLOAD = Buffer.alloc(48, 0x5a).toString('base64');
assert.equal(PAYLOAD.length, 64, 'the payload helper must produce the fixture length');
const DATA_URL = `data:image/png;base64,${PAYLOAD}`;

const scratchDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) {
    try {
      chmodSync(dir, 0o700);
    } catch { /* already writable or already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * One upstream send, as the fetch mock saw it. `streamed` is recorded separately
 * from `text` because it is half the point: a streamed body and a string body
 * that drain to the same bytes are still two different sends, and a case that
 * only checked `text` would pass on the shape-2 path by accident.
 */
interface UpstreamCall {
  url: string;
  streamed: boolean;
  text: string;
  bytes: number;
  headers: Record<string, string>;
  duplex: string | undefined;
}

let upstreamCalls: UpstreamCall[] = [];
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const sent = init?.body;
    const text = typeof sent === 'string' ? sent : await new Response(sent as ReadableStream).text();
    upstreamCalls.push({
      url: String(input),
      streamed: typeof sent !== 'string',
      text,
      bytes: Buffer.byteLength(text),
      // `Headers` lower-cases, and it is the only way to see what the handler set:
      // the mock is handed the handler's own headers object.
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      duplex: (init as { duplex?: string } | undefined)?.duplex,
    });
    // Shaped for the anthropic-messages branch, which parses the body on the way
    // back in; the native and openai-responses branches pass the bytes straight
    // through, and the gemini branch tolerates the missing `candidates`.
    return new Response(
      JSON.stringify({ id: 'upstream-ok', content: [], usage: { input_tokens: 1, output_tokens: 1 } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

/** A fresh, enabled spool directory — the extraction path's precondition (§9.1). */
function enableSpool(): void {
  const dir = mkdtempSync(join(tmpdir(), 'chat-ref-streaming-'));
  scratchDirs.push(dir);
  setSpoolConfig(resolveSpoolConfig({ enabled: true, dir }));
  resetBlobStore();
}

/**
 * A `/v1/chat/completions` body whose `image_url` parts are `payloads`, in order.
 * Built fresh per case: extraction mutates the body in place, so sharing one
 * fixture between the two halves of a comparison would compare a body against
 * itself.
 */
function imageBody(payloads: string[], text = 'what is this?'): Record<string, unknown> {
  return {
    model: 'gpt-test',
    max_tokens: 16,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text },
        ...payloads.map((data) => ({ type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } })),
      ],
    }],
  };
}

/**
 * Replace the allowlisted payloads with real refs, loudly: a fixture the §5.4
 * allowlist did not match (`refs`) or that the §5.3 eligibility rule rejected
 * (`skipped`) would otherwise let every assertion below pass vacuously.
 */
async function extract(body: Record<string, unknown>, expected: number): Promise<void> {
  const extraction = await extractInlineBlobs(body);
  assert.equal(extraction.refs, expected, 'the fixture must hold exactly the refs under test');
  assert.equal(extraction.skipped, 0, 'a fixture payload must be shape-3 eligible');
}

/** Send `body` through the real handler and return the single upstream send. */
async function send(
  body: Record<string, unknown>,
  upstreamMode = 'openai-completions',
  targetUrl = UPSTREAM_URL,
): Promise<UpstreamCall> {
  upstreamCalls = [];
  const response = await handleChatCompletionsPassthrough(
    new Request(`${CLIENT_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    targetUrl,
    { Authorization: 'Bearer upstream-key' },
    'req-chat',
    LOGGER,
    ENV,
    'gpt-test',
    upstreamMode,
  );
  assert.equal(response.status, 200, 'the handler must return the upstream response');
  assert.equal(upstreamCalls.length, 1, 'the handler must have made exactly one upstream call');
  assert.equal(upstreamCalls[0].url, targetUrl);
  return upstreamCalls[0];
}

/** The reference bytes for `body`: the same request sent with spooling off. */
async function sendExpanded(body: Record<string, unknown>): Promise<UpstreamCall> {
  setSpoolConfig(resolveSpoolConfig({ enabled: false }));
  resetBlobStore();
  const call = await send(body);
  assert.equal(call.streamed, false, 'the reference send must be the expanded string, not a stream');
  assert.equal(call.headers['content-length'], undefined, 'the string path declares no length of its own');
  assert.equal(call.duplex, undefined, 'the string path needs no duplex');
  return call;
}

describe('chat-completions.ts ref-aware egress (§5.3 shape 3)', () => {
  it('streams exactly the bytes the expanded string path sends, with a matching Content-Length', async () => {
    // The skeleton carries multi-byte text on purpose: `Content-Length` is a byte
    // count the serializer measured, and a fixture that is ASCII-only could not
    // tell that apart from a character count.
    const reference = await sendExpanded(imageBody([PAYLOAD], 'what is this? — 😀'));
    assert.ok(reference.text.includes(PAYLOAD), 'the reference body must carry the payload inline');
    assert.notEqual(
      reference.bytes,
      reference.text.length,
      'the fixture must be multi-byte, or a character count would pass as a byte count',
    );

    enableSpool();
    const body = imageBody([PAYLOAD], 'what is this? — 😀');
    await extract(body, 1);
    const call = await send(body);

    assert.equal(call.streamed, true, 'a ref-bearing body must be sent as a stream');
    assert.equal(call.text, reference.text, 'the streamed body must be byte-identical to the expanded one');
    assert.equal(
      call.headers['content-length'],
      String(call.bytes),
      'the declared length must be the exact byte count, not the skeleton\'s or the client\'s',
    );
    assert.equal(call.duplex, 'half');
    assert.ok(!call.text.includes(BLOB_REF_MARKER), 'no ref may reach the upstream');
  });

  it('places each payload where its ref sat, in order, with two refs in one body', async () => {
    const first = Buffer.alloc(48, 0x41).toString('base64');
    const second = Buffer.alloc(48, 0x42).toString('base64');
    assert.notEqual(first, second, 'the two payloads must be distinguishable');

    enableSpool();
    const body = imageBody([first, second]);
    await extract(body, 2);
    const call = await send(body);

    const sent = JSON.parse(call.text);
    assert.equal(sent.messages[0].content[1].image_url.url, `data:image/png;base64,${first}`, 'the first ref\'s position must hold its own payload, data URL and all');
    assert.equal(sent.messages[0].content[2].image_url.url, `data:image/png;base64,${second}`, 'the second ref\'s position must hold its own payload');
    assert.equal(sent.messages[0].content[0].text, 'what is this?');
  });

  it('reassembles a payload larger than the read chunk size against the expanded reference', async () => {
    const big = Buffer.alloc(BLOB_STREAM_CHUNK_BYTES, 0x5a).toString('base64');
    assert.ok(
      big.length > BLOB_STREAM_CHUNK_BYTES,
      'the fixture must exceed one L2 read chunk, or the chunk boundary is never crossed',
    );

    const reference = await sendExpanded(imageBody([big]));
    assert.equal(Buffer.byteLength(reference.text) > BLOB_STREAM_CHUNK_BYTES, true);

    enableSpool();
    const body = imageBody([big]);
    await extract(body, 1);
    const call = await send(body);

    assert.equal(call.streamed, true);
    assert.equal(call.text, reference.text, 'a payload spanning several chunks must arrive whole and in order');
    assert.equal(call.headers['content-length'], String(call.bytes));
  });

  it('leaves a body with no ref on the string path even with spooling enabled', async () => {
    enableSpool();
    const call = await send(imageBody([PAYLOAD]));

    assert.equal(call.streamed, false, 'a ref-free body must not be streamed');
    assert.equal(call.duplex, undefined);
    assert.equal(call.headers['content-length'], undefined, 'the handler must not invent a length for a string body');
    const sent = JSON.parse(call.text);
    assert.equal(sent.messages[0].content[1].image_url.url, DATA_URL);
  });

  it('fails the send loudly when a ref\'s blob is no longer in the store', async () => {
    enableSpool();
    const body = imageBody([PAYLOAD]);
    await extract(body, 1);

    // The store the refs were leased from is gone — the exchange outlived its
    // blobs, or a restart lost the index. A stream that quietly sent the ref, an
    // empty payload or a truncated one would corrupt the upstream request
    // invisibly, so the send must reject instead (repo rule #8).
    const elsewhere = mkdtempSync(join(tmpdir(), 'chat-ref-streaming-'));
    scratchDirs.push(elsewhere);
    setSpoolConfig(resolveSpoolConfig({ enabled: true, dir: elsewhere }));
    resetBlobStore();

    upstreamCalls = [];
    await assert.rejects(
      () => send(body),
      (error: unknown) => {
        assert.ok(error instanceof BlobStoreError, `expected a BlobStoreError, got ${String(error)}`);
        assert.match((error as Error).message, /is not in the cache index/);
        return true;
      },
    );
  });

  it('streams each converting mode when its converter preserves the payload ref', async () => {
    for (const mode of CONVERTING_MODES) {
      const targetUrl = mode === 'gemini-generatecontent' ? GEMINI_UPSTREAM_URL : UPSTREAM_URL;
      // The reference: the same request with the payload inline and no ref at
      // all, converted by the same branch. Equality against it says the ref path
      // produced the converter's real output rather than something merely
      // payload-shaped.
      setSpoolConfig(resolveSpoolConfig({ enabled: false }));
      resetBlobStore();
      const reference = await send(imageBody([PAYLOAD]), mode, targetUrl);
      assert.equal(reference.streamed, false, `${mode}: the reference send must be the expanded string`);

      enableSpool();
      const body = imageBody([PAYLOAD]);
      await extract(body, 1);
      const call = await send(body, mode, targetUrl);

      assert.equal(call.streamed, true, `${mode}: a preserved ref must stream through the conversion`);
      assert.equal(call.duplex, 'half', `${mode}: a streamed send needs duplex: half`);
      assert.equal(call.headers['content-length'], String(call.bytes), `${mode}: the streamed body declares exact bytes`);
      assert.ok(!call.text.includes(BLOB_REF_MARKER), `${mode}: no ref may reach the upstream`);
      assert.ok(call.text.includes(PAYLOAD), `${mode}: the converter must emit the real payload`);
      assert.equal(call.text, reference.text, `${mode}: the streamed body must equal the no-ref one`);
    }
  });
});
