/**
 * Unit tests for §5.3 shape 3 in `src/handlers/responses.ts`: the native
 * `/v1/responses` passthrough send keeps the body's §5.4 refs and streams each
 * payload out of L2 at the offset its ref occupies, instead of expanding the body
 * first.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.2, §5.3, §5.4.
 *
 * The property under test is that the graduate path is invisible upstream. Every
 * case here drives the real handler against a live spool (so the refs are real
 * shared ones and the payloads really come out of the blob store) and asserts on
 * what the fetch call actually carried: the bytes, the declared `Content-Length`,
 * and `duplex`. The byte-identity case is the load-bearing one — it compares the
 * streamed send against the same request sent by the shape-2 string path, so a
 * serializer that dropped, re-escaped, reordered or truncated a payload fails
 * even though the JSON still parses.
 *
 * This handler decides its shape per sub-path rather than at the top, so every
 * sub-path is measured here: the passthrough streams (driven below with the native
 * mode, its alias and no mode at all), and so does each of the four converting
 * modes — byte-identical to the same request sent with no ref in it. Their
 * converters carry the ref (`isBlobRef`) rather than reading the payload field as a
 * string, which is what lets the send stream through them; a converter that read or
 * dropped the payload would leave no ref behind and that branch would take the
 * ordinary string path. The passthrough never converts: it is this handler's
 * default branch, so a mode value this handler does not know would still take it.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleResponsesRequest } from '../../src/handlers/responses.js';
import { BLOB_REF_MARKER, extractInlineBlobs } from '../../src/utils/blob-refs.js';
import { BlobStoreError, BLOB_STREAM_CHUNK_BYTES, resetBlobStore } from '../../src/utils/blob-store.js';
import { createLogger } from '../../src/utils/logger.js';
import { resolveSpoolConfig, setSpoolConfig } from '../../src/utils/spool.js';

const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});
const CLIENT_URL = 'http://proxy';
const UPSTREAM_URL = 'https://upstream.example/v1/responses';

/** The four modes whose branch below converts this body and returns before the passthrough send. */
const CONVERTING_MODES = ['openai-completions', 'anthropic-messages', 'gemini-generatecontent', 'gemini-interactions'];

/** The values that must all reach the passthrough: the native mode, its alias, and no mode at all. */
const PASSTHROUGH_MODES: Array<string | undefined> = ['openai-responses', 'open-responses', undefined];

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
    // A superset of the three upstream shapes this handler's branches read back:
    // Claude `content` (anthropic-messages), Chat `choices` (openai-completions)
    // and Gemini `candidates`. The passthrough relays the bytes untouched; the
    // converting branches parse them, and a response shaped for only one of them
    // would fail inside a branch whose wire body is what the case is about.
    return new Response(
      JSON.stringify({
        id: 'upstream-ok',
        object: 'chat.completion',
        model: 'gpt-test',
        content: [{ type: 'text', text: 'ok' }],
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usage: {
          input_tokens: 1, output_tokens: 1,
          prompt_tokens: 1, completion_tokens: 1, total_tokens: 2,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

/** A fresh, enabled spool directory — the extraction path's precondition (§9.1). */
function enableSpool(): void {
  const dir = mkdtempSync(join(tmpdir(), 'responses-ref-streaming-'));
  scratchDirs.push(dir);
  setSpoolConfig(resolveSpoolConfig({ enabled: true, dir }));
  resetBlobStore();
}

/**
 * A `/v1/responses` body whose `input_image` parts are `payloads`, in order, in
 * the direct-string spelling. Built fresh per case: extraction mutates the body in
 * place, so sharing one fixture between the two halves of a comparison would
 * compare a body against itself.
 */
function imageBody(payloads: string[], text = 'describe this — 😀'): Record<string, unknown> {
  return {
    model: 'gpt-test',
    stream: false,
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text },
        ...payloads.map((data) => ({ type: 'input_image', image_url: `data:image/png;base64,${data}` })),
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
async function sendRaw(
  body: Record<string, unknown>,
  upstreamMode: string | undefined = 'openai-responses',
  targetUrl = UPSTREAM_URL,
): Promise<UpstreamCall> {
  upstreamCalls = [];
  const response = await handleResponsesRequest(
    new Request(`${CLIENT_URL}/v1/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    targetUrl,
    { Authorization: 'Bearer upstream-key' },
    'req-responses',
    'gpt-test',
    ENV,
    LOGGER,
    upstreamMode,
  );
  assert.equal(response.status, 200, 'the handler must return the upstream response');
  assert.equal(upstreamCalls.length, 1, 'the handler must have made exactly one upstream call');
  return upstreamCalls[0];
}

/** `sendRaw`, for the calls that must reach the URL the caller named. */
async function send(
  body: Record<string, unknown>,
  upstreamMode: string | undefined = 'openai-responses',
  targetUrl = UPSTREAM_URL,
): Promise<UpstreamCall> {
  const call = await sendRaw(body, upstreamMode, targetUrl);
  assert.equal(call.url, targetUrl);
  return call;
}

/**
 * The reference bytes for `body`: the same request sent with spooling off, so
 * there is no ref in it at all and the branch sees only the inline payload.
 */
async function sendExpanded(
  body: Record<string, unknown>,
  upstreamMode: string | undefined = 'openai-responses',
): Promise<UpstreamCall> {
  setSpoolConfig(resolveSpoolConfig({ enabled: false }));
  resetBlobStore();
  const call = await sendRaw(body, upstreamMode);
  assert.equal(call.streamed, false, 'the reference send must be the expanded string, not a stream');
  assert.equal(call.headers['content-length'], undefined, 'the string path declares no length of its own');
  assert.equal(call.duplex, undefined, 'the string path needs no duplex');
  return call;
}

describe('responses.ts ref-aware egress (§5.3 shape 3)', () => {
  it('streams exactly the bytes the expanded string path sends, with a matching Content-Length', async () => {
    // The skeleton carries multi-byte text on purpose: `Content-Length` is a byte
    // count the serializer measured, and a fixture that is ASCII-only could not
    // tell that apart from a character count.
    const reference = await sendExpanded(imageBody([PAYLOAD]));
    assert.ok(reference.text.includes(PAYLOAD), 'the reference body must carry the payload inline');
    assert.notEqual(
      reference.bytes,
      reference.text.length,
      'the fixture must be multi-byte, or a character count would pass as a byte count',
    );

    enableSpool();
    const body = imageBody([PAYLOAD]);
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

  it('places each payload where its ref sat, across both input_image spellings and a bare input_file', async () => {
    const first = Buffer.alloc(48, 0x41).toString('base64');
    const second = Buffer.alloc(48, 0x42).toString('base64');
    const third = Buffer.alloc(48, 0x43).toString('base64');
    assert.equal(new Set([first, second, third]).size, 3, 'the three payloads must be distinguishable');

    // The two `input_image` spellings the §5.4 allowlist reads — the URL directly
    // on the part, and the Chat-style object form the Responses converters relay —
    // plus a bare `input_file`, which shares the `either` form with `image_url`.
    enableSpool();
    const body: Record<string, unknown> = {
      model: 'gpt-test',
      stream: false,
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'describe these' },
          { type: 'input_image', image_url: `data:image/png;base64,${first}` },
          { type: 'input_image', image_url: { url: `data:image/png;base64,${second}` } },
          { type: 'input_file', file_data: third },
        ],
      }],
    };
    await extract(body, 3);
    const call = await send(body);

    const sent = JSON.parse(call.text);
    const content = sent.input[0].content;
    assert.equal(content[1].image_url, `data:image/png;base64,${first}`, 'the direct-string ref must hold its own payload, data URL and all');
    assert.equal(content[2].image_url.url, `data:image/png;base64,${second}`, 'the object-form ref must hold its own payload in place');
    assert.equal(content[3].file_data, third, 'a bare payload must be restored bare, without a prefixed data URL');
    assert.equal(content[0].text, 'describe these');
    assert.equal(call.headers['content-length'], String(call.bytes));
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
    assert.equal(sent.input[0].content[1].image_url, DATA_URL);
  });

  it('fails the send loudly when a ref\'s blob is no longer in the store', async () => {
    enableSpool();
    const body = imageBody([PAYLOAD]);
    await extract(body, 1);

    // The store the refs were leased from is gone — the exchange outlived its
    // blobs, or a restart lost the index. A stream that quietly sent the ref, an
    // empty payload or a truncated one would corrupt the upstream request
    // invisibly, so the send must reject instead (repo rule #8).
    const elsewhere = mkdtempSync(join(tmpdir(), 'responses-ref-streaming-'));
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

  it('streams for the native mode, its alias and no mode at all — the passthrough is the default branch', async () => {
    for (const mode of PASSTHROUGH_MODES) {
      enableSpool();
      const body = imageBody([PAYLOAD]);
      await extract(body, 1);
      const call = await send(body, mode);

      assert.equal(call.streamed, true, `${mode}: the passthrough must stream a ref-bearing body`);
      assert.equal(call.headers['content-length'], String(call.bytes), `${mode}: exact length expected`);
      assert.ok(!call.text.includes(BLOB_REF_MARKER), `${mode}: no ref may reach the upstream`);
    }
  });

  it('streams each converting mode when its converter preserves the payload ref', async () => {
    for (const mode of CONVERTING_MODES) {
      // These branches go through `sendRaw`, not `send`: the gemini one rewrites
      // the URL it was handed (it appends `/v1/models/{model}:generateContent`),
      // so the URL is compared against the reference's instead.
      const reference = await sendExpanded(imageBody([PAYLOAD]), mode);

      enableSpool();
      const body = imageBody([PAYLOAD]);
      await extract(body, 1);
      const call = await sendRaw(body, mode);

      assert.equal(call.url, reference.url, `${mode}: the ref path must not change the target`);
      assert.equal(call.streamed, true, `${mode}: a preserved ref must stream through the conversion`);
      assert.equal(call.duplex, 'half', `${mode}: a streamed send needs duplex: half`);
      assert.equal(call.headers['content-length'], String(call.bytes), `${mode}: the streamed body declares exact bytes`);
      assert.ok(!call.text.includes(BLOB_REF_MARKER), `${mode}: no ref may reach the upstream`);
      assert.ok(call.text.includes(PAYLOAD), `${mode}: the converter must emit the real payload`);
      assert.equal(call.text, reference.text, `${mode}: the streamed body must equal the no-ref one`);
    }
  });
});
