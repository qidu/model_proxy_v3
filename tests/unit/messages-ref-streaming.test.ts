/**
 * Unit tests for §5.3 shape 3 on the *converted* egress: `src/handlers/messages.ts`
 * keeps a Claude-format body's §5.4 refs across the Claude→OpenAI conversion and
 * streams each payload out of L2 at the position its ref ends up in, instead of
 * expanding the body first and sending one large string.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.3, §5.4.
 *
 * This is the path the plan calls the interesting one, because the conversion sits
 * between the ref and the send: the client's `source.data` ref is not the field the
 * upstream reads, so the converter has to carry the ref into `image_url.url` with
 * the data URL prefix rebuilt, and the serializer then emits it there. The
 * load-bearing assertion is byte identity against the same request sent by the
 * shape-2 string path — a converter or serializer that re-escaped, reordered,
 * dropped or truncated anything fails even though the JSON still parses.
 *
 * Both converted send sites are covered, because they are two separate call sites
 * with two different bodies: `openai-completions` (the Chat Completions body) and
 * `openai-responses` (the Responses body, where the ref has to survive a second
 * conversion in `completionsMessagesToResponsesInput`). The already-OpenAI branch
 * is covered too: it converts nothing, so its refs stay in the fields the client
 * used and its send streams them there like any other.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleMessagesRequest } from '../../src/handlers/messages.js';
import { BLOB_REF_MARKER, extractInlineBlobs } from '../../src/utils/blob-refs.js';
import { BlobStoreError, BLOB_STREAM_CHUNK_BYTES, resetBlobStore } from '../../src/utils/blob-store.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { createLogger } from '../../src/utils/logger.js';
import { resolveSpoolConfig, SPOOL_DEFAULTS, setSpoolConfig, type SpoolTomlConfig } from '../../src/utils/spool.js';

const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});
const CLIENT_URL = 'http://proxy';
const COMPLETIONS_URL = 'https://upstream.example/v1/chat/completions';
const RESPONSES_URL = 'https://upstream.example/v1/responses';

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
 * from `text` because it is half the point: a streamed body and a string body that
 * drain to the same bytes are still two different sends, and a case that only
 * checked `text` would pass on the shape-2 path by accident.
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

/** A well-formed response per upstream flavour, so the handler's converters run. */
function upstreamResponse(url: string): Response {
  const body = url.endsWith('/v1/responses')
    ? {
        id: 'resp-ok',
        created_at: 1,
        model: 'gpt-test',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      }
    : {
        id: 'chat-ok',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', logprobs: null }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

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
    return upstreamResponse(String(input));
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

/** A fresh, enabled spool directory — the extraction path's precondition (§9.1). */
function enableSpool(overrides: SpoolTomlConfig = {}): void {
  const dir = mkdtempSync(join(tmpdir(), 'messages-ref-streaming-'));
  scratchDirs.push(dir);
  setSpoolConfig(resolveSpoolConfig({ enabled: true, dir, ...overrides }));
  resetBlobStore();
}

/**
 * A Claude-format `/v1/messages` body whose image sources are `payloads`, in order.
 * `system` is what makes the handler read it as Claude format rather than pass it
 * through as an already-OpenAI body. Built fresh per case: extraction mutates the
 * body in place, so sharing one fixture between the two halves of a comparison
 * would compare a body against itself.
 */
function claudeImageBody(payloads: string[], text = 'what is this?'): Record<string, unknown> {
  return {
    model: 'claude-test',
    max_tokens: 16,
    system: 'be brief',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text },
        ...payloads.map((data) => ({
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data },
        })),
      ],
    }],
  };
}

/**
 * An already-OpenAI `/v1/messages` body: no `system` and no Claude content block,
 * so the handler passes it through instead of converting it, and the ref stays in
 * the field the client spelled. `user` carries multi-byte text because the payload
 * is ASCII, and the byte-count assertion needs a body where the two differ.
 */
function openaiImageBody(): Record<string, unknown> {
  return {
    model: 'gpt-test',
    max_tokens: 16,
    user: 'req — 😀',
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: DATA_URL } }],
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

/** Send `body` through the real handler for `upstreamMode` and return the single upstream send. */
async function send(body: Record<string, unknown>, upstreamMode: string): Promise<UpstreamCall> {
  upstreamCalls = [];
  const response = await handleMessagesRequest(
    new Request(`${CLIENT_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    upstreamMode === 'openai-responses' ? RESPONSES_URL : COMPLETIONS_URL,
    { Authorization: 'Bearer upstream-key' },
    'req-messages',
    'gpt-test',
    ENV,
    LOGGER,
    undefined,
    upstreamMode,
  );
  assert.equal(response.status, 200, 'the handler must return the converted upstream response');
  assert.equal(upstreamCalls.length, 1, 'the handler must have made exactly one upstream call');
  return upstreamCalls[0];
}

/** The reference bytes for `body`: the same request sent with spooling off. */
async function sendExpanded(body: Record<string, unknown>, upstreamMode: string): Promise<UpstreamCall> {
  setSpoolConfig(resolveSpoolConfig({ enabled: false }));
  resetBlobStore();
  const call = await send(body, upstreamMode);
  assert.equal(call.streamed, false, 'the reference send must be the expanded string, not a stream');
  assert.equal(call.headers['content-length'], undefined, 'the string path declares no length of its own');
  assert.equal(call.duplex, undefined, 'the string path needs no duplex');
  return call;
}

/**
 * Byte identity against the shape-2 reference, for one converted send site.
 *
 * The skeleton carries multi-byte text on purpose: `Content-Length` is a byte count
 * the serializer measured, and a fixture that is ASCII-only could not tell that
 * apart from a character count.
 */
async function assertStreamsWhatTheStringPathSends(upstreamMode: string): Promise<UpstreamCall> {
  const reference = await sendExpanded(claudeImageBody([PAYLOAD], 'what is this? — 😀'), upstreamMode);
  assert.ok(reference.text.includes(DATA_URL), 'the reference body must carry the payload inline as a data URL');
  assert.notEqual(
    reference.bytes,
    reference.text.length,
    'the fixture must be multi-byte, or a character count would pass as a byte count',
  );

  enableSpool();
  const body = claudeImageBody([PAYLOAD], 'what is this? — 😀');
  await extract(body, 1);
  const call = await send(body, upstreamMode);

  assert.equal(call.streamed, true, 'a ref-bearing converted body must be sent as a stream');
  assert.equal(call.text, reference.text, 'the streamed body must be byte-identical to the expanded one');
  assert.equal(call.headers['content-length'], String(call.bytes), 'the declared length must be the exact byte count');
  assert.equal(call.duplex, 'half');
  assert.ok(!call.text.includes(BLOB_REF_MARKER), 'no ref may reach the upstream');
  return call;
}

describe('messages.ts ref-aware converted egress (§5.3 shape 3)', () => {
  it('streams the converted Chat Completions body with the ref re-prefixed at image_url.url', async () => {
    const call = await assertStreamsWhatTheStringPathSends('openai-completions');

    const sent = JSON.parse(call.text);
    assert.equal(
      sent.messages[1].content[1].image_url.url,
      DATA_URL,
      'the ref must be rehydrated as the exact data URL the converter used to build',
    );
    assert.equal(sent.messages[1].content[1].type, 'image_url');
  });

  it('streams the converted Responses body, where the ref survives a second conversion', async () => {
    const call = await assertStreamsWhatTheStringPathSends('openai-responses');

    // The Responses body is built by `completionsMessagesToResponsesInput`, which
    // relays the Chat image part by reference — so this position is where the
    // converter's re-prefixed ref ends up, not where the client's ref started.
    // Responses spells `image_url` as a string (not the Chat `{url}` object), so
    // the ref lands one level shallower than on the Chat egress above.
    // (Item 0 is the system message the converter emits first.)
    const sent = JSON.parse(call.text);
    assert.equal(sent.input[1].content[1].type, 'input_image');
    assert.equal(sent.input[1].content[1].image_url, DATA_URL);
  });

  it('places each payload where its ref ended up, in order, with two refs in one body', async () => {
    const first = Buffer.alloc(48, 0x41).toString('base64');
    const second = Buffer.alloc(48, 0x42).toString('base64');
    assert.notEqual(first, second, 'the two payloads must be distinguishable');

    enableSpool();
    const body = claudeImageBody([first, second]);
    await extract(body, 2);
    const call = await send(body, 'openai-completions');

    const sent = JSON.parse(call.text);
    assert.equal(sent.messages[1].content[1].image_url.url, `data:image/png;base64,${first}`);
    assert.equal(sent.messages[1].content[2].image_url.url, `data:image/png;base64,${second}`);
  });

  it('reassembles a payload larger than the read chunk size against the expanded reference', async () => {
    const big = Buffer.alloc(BLOB_STREAM_CHUNK_BYTES, 0x5a).toString('base64');
    assert.ok(
      big.length > BLOB_STREAM_CHUNK_BYTES,
      'the fixture must exceed one L2 read chunk, or the chunk boundary is never crossed',
    );

    const reference = await sendExpanded(claudeImageBody([big]), 'openai-completions');
    assert.equal(Buffer.byteLength(reference.text) > BLOB_STREAM_CHUNK_BYTES, true);

    enableSpool();
    const body = claudeImageBody([big]);
    await extract(body, 1);
    const call = await send(body, 'openai-completions');

    assert.equal(call.streamed, true);
    assert.equal(call.text, reference.text, 'a payload spanning several chunks must arrive whole and in order');
    assert.equal(call.headers['content-length'], String(call.bytes));
  });

  it('leaves a body with no ref on the string path even with spooling enabled', async () => {
    enableSpool();
    const call = await send(claudeImageBody([PAYLOAD]), 'openai-completions');

    assert.equal(call.streamed, false, 'a ref-free body must not be streamed');
    assert.equal(call.duplex, undefined);
    assert.equal(call.headers['content-length'], undefined, 'the handler must not invent a length for a string body');
    const sent = JSON.parse(call.text);
    assert.equal(sent.messages[1].content[1].image_url.url, DATA_URL);
  });

  it('passes an Anthropic URL image source through as a string URL on both egresses', async () => {
    // Neither upstream format needs a fetch here: Chat Completions' `image_url.url`
    // and Responses' `image_url` both accept a fully qualified URL, so the only
    // correct conversion is passthrough. The regression this pins is the
    // `data:undefined;base64,undefined` the base64-only branch used to build for a
    // `source.type: 'url'` block, plus the Chat-shaped `{url}` object that used to
    // reach the Responses body.
    setSpoolConfig(resolveSpoolConfig({ enabled: false }));
    resetBlobStore();
    const url = 'https://example.com/cat.png';
    const body = {
      model: 'claude-test',
      max_tokens: 16,
      system: 'be brief',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'url', url } },
        ],
      }],
    };

    const chat = JSON.parse((await send(structuredClone(body), 'openai-completions')).text);
    assert.deepEqual(chat.messages[1].content[1], { type: 'image_url', image_url: { url } });

    const responses = JSON.parse((await send(structuredClone(body), 'openai-responses')).text);
    assert.deepEqual(responses.input[1].content[1], { type: 'input_image', image_url: url });
    assert.ok(!JSON.stringify(responses).includes('data:undefined'), 'no placeholder data URL may reach the upstream');
  });

  it('hoists a Chat `detail` to a sibling of `image_url` on the pass-through Responses path', async () => {
    // The already-OpenAI branch forwards the client's own Chat parts, which can
    // carry `detail` nested inside `image_url` — a position Responses does not have.
    setSpoolConfig(resolveSpoolConfig({ enabled: false }));
    resetBlobStore();
    const body = openaiImageBody();
    (body.messages as any)[0].content[0].image_url.detail = 'high';

    const sent = JSON.parse((await send(body, 'openai-responses')).text);
    assert.deepEqual(sent.input[0].content[0], { type: 'input_image', image_url: DATA_URL, detail: 'high' });
  });

  it('accepts a spooled image through validation, which sees the ref rather than a payload', async () => {
    // The ref is still in the body when `validateClaudeMessagesRequest` runs, so
    // this asserts the path completes at all: validating `source.data` as a string
    // would 400 the request before the conversion could carry the ref through.
    enableSpool();
    const body = claudeImageBody([PAYLOAD]);
    await extract(body, 1);

    const response = await handleMessagesRequest(
      new Request(`${CLIENT_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      COMPLETIONS_URL,
      { Authorization: 'Bearer upstream-key' },
      'req-validation',
      'gpt-test',
      ENV,
      LOGGER,
      undefined,
      'openai-completions',
    );
    assert.equal(response.status, 200, 'a ref at source.data must not read as a missing payload');
  });

  it('streams the already-OpenAI body too: no conversion, so its refs go out where the client put them', async () => {
    // An OpenAI-format body (no `system`, no Claude content block) is forwarded as
    // it stands, so there is no conversion to carry a ref into — the ref stays in
    // the field the client used. The token counter counts it there (§5.3's own
    // approximation for a block with no binary slot), so the branch needs no
    // expansion either, and the send decides its shape from the refs it is handed.
    const reference = await sendExpanded(openaiImageBody(), 'openai-completions');
    assert.ok(reference.text.includes(DATA_URL), 'the reference body must carry the payload inline as a data URL');
    assert.notEqual(
      reference.bytes,
      reference.text.length,
      'the fixture must be multi-byte, or a character count would pass as a byte count',
    );

    enableSpool();
    const body = openaiImageBody();
    await extract(body, 1);
    const call = await send(body, 'openai-completions');

    assert.equal(call.streamed, true, 'a ref-bearing pass-through body must be sent as a stream');
    assert.equal(call.text, reference.text, 'the streamed body must be byte-identical to the expanded one');
    assert.equal(call.headers['content-length'], String(call.bytes), 'the declared length must be the exact byte count');
    assert.equal(call.duplex, 'half');
    assert.ok(!call.text.includes(BLOB_REF_MARKER), 'no ref may reach the upstream');
    assert.equal(
      JSON.parse(call.text).messages[0].content[0].image_url.url,
      DATA_URL,
      'the payload must land back in the field the client spelled it in',
    );
  });

  it('spools a large non-ref converted attempt and sends the same bytes as the string path', async () => {
    const body = {
      model: 'claude-test',
      max_tokens: 16,
      system: 'be brief',
      messages: [{ role: 'user', content: `non-ref ${'x'.repeat(1024)}` }],
    };
    const reference = await sendExpanded(structuredClone(body), 'openai-completions');

    enableSpool({ threshold_bytes: 256 });
    const call = await send(structuredClone(body), 'openai-completions');

    assert.equal(call.streamed, true, 'the oversized converted body must come from its attempt spill');
    assert.equal(call.duplex, 'half');
    assert.equal(call.headers['content-length'], String(call.bytes), 'the spill declares the exact UTF-8 byte count');
    assert.equal(call.text, reference.text, 'disk-backed egress must send the same bytes as the in-memory baseline');
    assert.equal(getLiveSpillBytes(), 0, 'the attempt spill is gone once the upstream has taken the body');
  });

  it('fails the send loudly when a ref\'s blob is no longer in the store', async () => {
    enableSpool();
    const body = claudeImageBody([PAYLOAD]);
    await extract(body, 1);

    // The store the refs were leased from is gone — the exchange outlived its
    // blobs, or a restart lost the index. A stream that quietly sent the ref, an
    // empty payload or a truncated one would corrupt the upstream request
    // invisibly, so the send must reject instead (repo rule #8).
    const elsewhere = mkdtempSync(join(tmpdir(), 'messages-ref-streaming-'));
    scratchDirs.push(elsewhere);
    setSpoolConfig(resolveSpoolConfig({ enabled: true, dir: elsewhere }));
    resetBlobStore();

    upstreamCalls = [];
    await assert.rejects(
      () => send(body, 'openai-completions'),
      (error: unknown) => {
        assert.ok(error instanceof BlobStoreError, `expected a BlobStoreError, got ${String(error)}`);
        assert.match((error as Error).message, /is not in the cache index/);
        return true;
      },
    );
  });
});
