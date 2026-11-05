/**
 * Unit tests for the handler-level half of §5.3: a body that arrives at a
 * dispatch handler still carrying §5.4 refs must be dealt with *before*
 * validation, the hooks and conversion, and no ref may reach the upstream.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.3, §5.4.
 *
 * The send boundary in `src/index.ts` no longer rehydrates, so a handler that
 * parses a ref-bearing endpoint must deal with the refs itself: carry them through
 * validation, the hooks and conversion to a send that streams them (§5.3 shape 3),
 * or resolve them before anything reads the body. A handler that did neither would
 * forward `{"$spoolBlob":…}` in place of the base64 payload. These tests drive each
 * such handler directly with a ref-bearing `Request` (built by the real
 * `extractInlineBlobs` against a live spool, so the ref is a real leased one) and
 * assert on the bytes the handler actually sent upstream: the client's payload
 * present, and no ref whatsoever.
 *
 * What these cases do *not* pin is the egress shape: the fetch mock drains either
 * a string or a stream into the same `body` string, so a shape-2 expansion and a
 * shape-3 stream are indistinguishable here — and every ref-bearing case below
 * now takes the stream (measured; the last case, whose body carries no ref, keeps
 * the string fallback). The shape is asserted per endpoint instead, by
 * `tests/unit/request-ref-matrix.test.ts` and the per-handler `*-ref-streaming`
 * suites. What is asserted here is the ordering property above, which is
 * shape-independent and which those suites do not cover.
 *
 * Covered sites: gemini.ts (Interactions and generateContent), openai.ts
 * (`:generateContent` → OpenAI upstream), and responses.ts (create, input_tokens,
 * compact). `/v1/messages/count_tokens` is deliberately absent: it is not in the
 * §5.4 extraction gate in `src/index.ts`, so its handler can never receive a ref.
 *
 * The sends that own their own ref handling are deliberately absent, having their
 * own suites: the converted Claude-format sends in messages.ts
 * (`tests/unit/messages-ref-streaming.test.ts`, including the already-OpenAI
 * branch, which streams a body it did not convert), claude.ts's native
 * `/v1/messages` send (`tests/unit/claude-ref-streaming.test.ts`),
 * chat-completions.ts's native `/v1/chat/completions` send
 * (`tests/unit/chat-completions-ref-streaming.test.ts`), and responses.ts's native
 * `/v1/responses` passthrough (`tests/unit/responses-ref-streaming.test.ts`).
 * The whole cross-product, shapes included, is in
 * `tests/unit/request-ref-matrix.test.ts`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleClaudeRequest } from '../../src/handlers/claude.js';
import { handleGeminiRequest } from '../../src/handlers/gemini.js';
import { handleOpenAIRequest } from '../../src/handlers/openai.js';
import {
  handleResponsesCompactRequest,
  handleResponsesInputTokensRequest,
  handleResponsesRequest,
} from '../../src/handlers/responses.js';
import { BLOB_REF_MARKER, extractInlineBlobs } from '../../src/utils/blob-refs.js';
import { resetBlobStore } from '../../src/utils/blob-store.js';
import { createLogger } from '../../src/utils/logger.js';
import { resolveSpoolConfig, setSpoolConfig } from '../../src/utils/spool.js';

const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});
const CLIENT_URL = 'http://proxy';

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

let upstreamCalls: Array<{ url: string; body: string }>;
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const sent = init?.body;
    const body = typeof sent === 'string'
      ? sent
      : sent instanceof ReadableStream
        ? await new Response(sent).text()
        : String(sent ?? '');
    upstreamCalls.push({ url: String(input), body });
    return new Response(JSON.stringify({ id: 'upstream-ok', usage: { input_tokens: 1, output_tokens: 1 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

/**
 * Turn `body` into a ref-bearing body, as the send boundary would hand it to a
 * handler: a live enabled spool, the real extraction pass, and a loud assertion
 * that the fixture produced exactly `expected` refs — a fixture the allowlist
 * does not match would otherwise let every assertion below pass vacuously.
 */
async function extract(body: Record<string, unknown>, expected = 1): Promise<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'handler-ref-expansion-'));
  scratchDirs.push(dir);
  setSpoolConfig(resolveSpoolConfig({ enabled: true, dir }));
  resetBlobStore();

  const extraction = await extractInlineBlobs(body);
  assert.equal(extraction.refs, expected, 'the fixture must hold exactly the refs under test');
  assert.equal(extraction.skipped, 0, 'a fixture payload must be shape-3 eligible');
  upstreamCalls = [];
  return body;
}

/** The request a handler receives: refs are plain JSON, so they survive this. */
function handlerRequest(url: string, body: Record<string, unknown>): Request {
  const text = JSON.stringify(body);
  assert.ok(text.includes(BLOB_REF_MARKER), 'the request under test must carry a ref');
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: text,
  });
}

/**
 * What every handler-level case asserts: the handler called upstream, no ref
 * reached it anywhere, and the client's payload did.
 */
function assertRefResolvedUpstream(): void {
  assert.ok(upstreamCalls.length > 0, 'the handler must have forwarded the body upstream');
  for (const call of upstreamCalls) {
    assert.ok(!call.body.includes(BLOB_REF_MARKER), `a ref reached ${call.url}`);
  }
  assert.ok(
    upstreamCalls.some((call) => call.body.includes(PAYLOAD)),
    'the payload the client sent must reach the upstream',
  );
}

describe('handler-side ref handling before validation (§5.3)', () => {
  it('gemini.ts forwards the payload for an Interactions request', async () => {
    const body = await extract({
      model: 'gemini-test',
      input: {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PAYLOAD } },
          ],
        }],
      },
    });

    const response = await handleGeminiRequest(
      handlerRequest(`${CLIENT_URL}/v1/interactions`, body),
      'https://upstream.example/v1beta/models/gemini-test:generateContent',
      { 'x-goog-api-key': 'upstream-key' },
      'req-interactions',
      'gemini-test',
      ENV,
      LOGGER,
    );
    assert.equal(response.status, 200);
    assertRefResolvedUpstream();
  });

  it('gemini.ts forwards the payload at its exact position for :generateContent', async () => {
    const body = await extract({
      contents: [{
        role: 'user',
        parts: [
          { text: 'what is this?' },
          { inline_data: { mime_type: 'image/png', data: PAYLOAD } },
        ],
      }],
    });

    const response = await handleGeminiRequest(
      handlerRequest(`${CLIENT_URL}/v1beta/models/gemini-test:generateContent`, body),
      'https://upstream.example/v1beta/models/gemini-test:generateContent',
      { 'x-goog-api-key': 'upstream-key' },
      'req-generate-content',
      'gemini-test',
      ENV,
      LOGGER,
    );
    assert.equal(response.status, 200);

    assert.equal(upstreamCalls.length, 1);
    const sent = JSON.parse(upstreamCalls[0].body);
    assert.equal(sent.contents[0].parts[1].inline_data.data, PAYLOAD);
    assert.equal(sent.contents[0].parts[1].inline_data.mime_type, 'image/png');
  });

  it('openai.ts carries a :generateContent request\'s inline bytes through the conversion to an OpenAI upstream', async () => {
    const body = await extract({
      contents: [{
        role: 'user',
        parts: [
          { text: 'what is this?' },
          { inline_data: { mime_type: 'image/png', data: PAYLOAD } },
        ],
      }],
    });

    const response = await handleOpenAIRequest(
      handlerRequest(`${CLIENT_URL}/v1beta/models/gemini-test:generateContent`, body),
      'https://upstream.example/v1/chat/completions',
      { Authorization: 'Bearer upstream-key' },
      'req-openai',
      'gemini-test',
      ENV,
      LOGGER,
      false,
      undefined,
      'openai-completions',
    );
    assert.equal(response.status, 200);

    assert.ok(
      upstreamCalls.some((call) => call.body.includes(DATA_URL)),
      'the converted upstream body must carry the Gemini inline bytes the client sent',
    );
    assertRefResolvedUpstream();
  });

  it('responses.ts forwards the payload for /v1/responses', async () => {
    const body = await extract({
      model: 'gpt-test',
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'what is this?' },
          { type: 'input_image', image_url: DATA_URL },
        ],
      }],
    });

    const response = await handleResponsesRequest(
      handlerRequest(`${CLIENT_URL}/v1/responses`, body),
      'https://upstream.example/v1/chat/completions',
      { Authorization: 'Bearer upstream-key' },
      'req-responses',
      'gpt-test',
      ENV,
      LOGGER,
      'openai-completions',
    );
    assert.equal(response.status, 200);
    assertRefResolvedUpstream();
  });

  it('responses.ts forwards the payload for /v1/responses/input_tokens', async () => {
    const body = await extract({
      model: 'gpt-test',
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'what is this?' },
          { type: 'input_image', image_url: DATA_URL },
        ],
      }],
    });

    const response = await handleResponsesInputTokensRequest(
      handlerRequest(`${CLIENT_URL}/v1/responses/input_tokens`, body),
      'https://upstream.example/v1/chat/completions',
      { Authorization: 'Bearer upstream-key' },
      'req-input-tokens',
      'gpt-test',
      ENV,
      LOGGER,
      'openai-completions',
    );
    assert.equal(response.status, 200);
    assertRefResolvedUpstream();
  });

  it('responses.ts forwards the payload for /v1/responses/compact', async () => {
    const body = await extract({
      model: 'gpt-test',
      input: [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'what is this?' },
          { type: 'input_image', image_url: DATA_URL },
        ],
      }],
    });

    const response = await handleResponsesCompactRequest(
      handlerRequest(`${CLIENT_URL}/v1/responses/compact`, body),
      'https://upstream.example/v1/chat/completions',
      { Authorization: 'Bearer upstream-key' },
      'req-compact',
      'gpt-test',
      ENV,
      LOGGER,
      'openai-completions',
    );
    assert.equal(response.status, 200);
    assertRefResolvedUpstream();
  });

  it('leaves a ref-free body untouched — the expansion is a no-op off the extraction path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'handler-ref-expansion-'));
    scratchDirs.push(dir);
    setSpoolConfig(resolveSpoolConfig({ enabled: true, dir }));
    resetBlobStore();
    upstreamCalls = [];

    const body = {
      model: 'claude-test',
      max_tokens: 16,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PAYLOAD } },
        ],
      }],
    };

    const response = await handleClaudeRequest(
      new Request(`${CLIENT_URL}/v1/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      'https://upstream.example/v1/messages',
      { 'x-api-key': 'upstream-key' },
      'req-inline',
      'claude-test',
      ENV,
      LOGGER,
    );
    assert.equal(response.status, 200);

    assert.equal(upstreamCalls.length, 1);
    const sent = JSON.parse(upstreamCalls[0].body);
    assert.equal(sent.messages[0].content[1].source.data, PAYLOAD);
    assert.ok(!upstreamCalls[0].body.includes(BLOB_REF_MARKER));
  });
});
