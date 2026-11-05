/**
 * §10 "Binary allowlist round-trip matrix" — the request half, driven through the
 * real front-door handlers.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.3, §5.4, §10.
 *
 * The per-handler suites each prove one send's shape-3 mechanics. This file proves
 * the *cross-product*: every §5.4 position the client can send, on every front door
 * that accepts it, against every upstream mode it can be converted to, plus the SSE
 * variants §10 names (`:streamGenerateContent` and `/v1/interactions`). Each row
 * runs the same request twice through the same handler — once with the payloads
 * spilled to real refs, once with spooling off so the payloads stay inline — and
 * asserts the two upstream sends are byte-identical. Equality against the
 * in-memory baseline is the load-bearing assertion: it is what §10 asks for
 * ("streamed upstream bytes equal the in-memory conversion baseline") and it fails
 * on a serializer that dropped, re-escaped, reordered or truncated a payload even
 * though the JSON still parses.
 *
 * Each row also declares the shape it is *expected* to take, so a row that silently
 * regressed from streaming to expanding (or the reverse) fails here rather than
 * passing as "the bytes arrived somehow".
 *
 * Fixtures carry small payloads on purpose; the §10 dimension of "a payload above
 * the spill threshold" is covered for all twelve positions by
 * `tests/unit/blob-refs.test.ts`'s allowlist matrix, and end to end above the
 * threshold by the final case here. Six rows are `dropped` — payloads a converter
 * throws away before any send, identically with spooling off (Claude `document`
 * blocks, Chat `input_audio`/`file`, Responses `input_file` on some targets, and
 * the Interactions parts on the two OpenAI-family targets). Those are asserted to
 * be absent in *both* runs, so the drop is pinned as the converter's behaviour and
 * cannot start hiding behind the spool — but they are not this change's to fix
 * (repo rule #8: reported, not silently skipped).
 *
 * Coverage: Claude image + base64 PDF, Chat image + audio + file, Gemini
 * `inline_data` + `inlineData` (image and audio MIME — the predicate is
 * MIME-agnostic, and `blob-refs.test.ts` covers video/PDF), Responses image in both
 * spellings + file + inline skill ZIP. That is every §5.4 request position.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleClaudeRequest } from '../../src/handlers/claude.js';
import { handleChatCompletionsPassthrough } from '../../src/handlers/chat-completions.js';
import { handleGeminiRequest, handleGeminiRequestForMessages } from '../../src/handlers/gemini.js';
import { handleMessagesRequest } from '../../src/handlers/messages.js';
import { handleOpenAIRequest } from '../../src/handlers/openai.js';
import {
  handleResponsesCompactRequest,
  handleResponsesInputTokensRequest,
  handleResponsesRequest,
} from '../../src/handlers/responses.js';
import { BLOB_REF_MARKER, extractInlineBlobs, releaseExtractedBlobs } from '../../src/utils/blob-refs.js';
import { BLOB_STREAM_CHUNK_BYTES, resetBlobStore } from '../../src/utils/blob-store.js';
import { createLogger } from '../../src/utils/logger.js';
import { SPOOL_DEFAULTS, resolveSpoolConfig, setSpoolConfig } from '../../src/utils/spool.js';

const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});
const CLIENT_URL = 'http://proxy';
const AUTH = { Authorization: 'Bearer upstream-key' };
const TARGET = 'https://upstream.example/v1/x';
const TARGET_STREAM = 'https://upstream.example/v1beta/models/gemini-test:streamGenerateContent?alt=sse';
/**
 * Gemini's native front doors treat the configured target as an API *base* and
 * append the model path (`constructGeminiUrl`, src/handlers/gemini.ts), so what
 * those rows actually route to is not the base they were handed. The streaming
 * target already carries `:streamGenerateContent?alt=sse`, so it is routed as given.
 */
const TARGET_GEMINI = `${TARGET}/v1/models/gemini-test:generateContent`;

/** A distinct, valid base64 payload: 48 bytes, 64 characters, no padding. */
const P = (seed: string) => Buffer.alloc(48, seed.charCodeAt(0)).toString('base64');
const CLAUDE_IMAGE = P('a');
const CLAUDE_PDF = P('b');
const CHAT_IMAGE = P('c');
const CHAT_AUDIO = P('d');
const CHAT_FILE = P('e');
const GEM_SNAKE = P('g');
const GEM_CAMEL = P('h');
const RESP_IMAGE = P('i');
const RESP_IMAGE_OBJ = P('j');
const RESP_FILE = P('k');
const RESP_SKILL = P('l');
assert.equal(new Set([
  CLAUDE_IMAGE, CLAUDE_PDF, CHAT_IMAGE, CHAT_AUDIO, CHAT_FILE, GEM_SNAKE, GEM_CAMEL,
  RESP_IMAGE, RESP_IMAGE_OBJ, RESP_FILE, RESP_SKILL,
]).size, 11, 'every fixture payload must be distinguishable from the others');

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
 * from `text` because the shape is half the claim: a stream and a string that drain
 * to the same bytes are still two different sends.
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
let sseResponse = false;
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const sent = init?.body;
    const text = typeof sent === 'string'
      ? sent
      : sent instanceof ReadableStream
        ? await new Response(sent).text()
        : String(sent ?? '');
    upstreamCalls.push({
      url: String(input),
      streamed: typeof sent !== 'string',
      text,
      bytes: Buffer.byteLength(text),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      duplex: (init as { duplex?: string } | undefined)?.duplex,
    });
    // The SSE rows drive the handler's streaming *response* path, so the mock has
    // to answer in kind — a JSON body there would exercise a path that does not
    // exist in production. The frame is the smallest one the Gemini transformers
    // accept; the request has already been sent by the time it is read.
    if (sseResponse) {
      const frame = JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
      });
      return new Response(`data: ${frame}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    // Shaped for the anthropic-messages and claude-format branches, which parse the
    // body on the way back in; the passthrough branches return it unread.
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
  const dir = mkdtempSync(join(tmpdir(), 'request-ref-matrix-'));
  scratchDirs.push(dir);
  setSpoolConfig(resolveSpoolConfig({ enabled: true, dir }));
  resetBlobStore();
}

/** The §5.4 allowlist's own fixtures, one per inbound schema. */
const CLAUDE_BODY = () => ({
  model: 'claude-test',
  max_tokens: 16,
  messages: [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: CLAUDE_IMAGE } },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: CLAUDE_PDF } },
      { type: 'text', text: 'describe' },
    ],
  }],
});

const CHAT_BODY = () => ({
  model: 'gpt-test',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${CHAT_IMAGE}` } },
      { type: 'input_audio', input_audio: { data: CHAT_AUDIO, format: 'wav' } },
      { type: 'file', file: { filename: 'report.pdf', file_data: CHAT_FILE } },
    ],
  }],
});

const GEMINI_BODY = () => ({
  model: 'gemini-test',
  contents: [{
    role: 'user',
    parts: [
      { inline_data: { mime_type: 'image/png', data: GEM_SNAKE } },
      { inlineData: { mimeType: 'audio/mp3', data: GEM_CAMEL } },
      { text: 'describe' },
    ],
  }],
});

const INTERACTIONS_BODY = () => ({
  model: 'gemini-test',
  input: {
    messages: [{
      role: 'user',
      content: [
        { inline_data: { mime_type: 'image/png', data: GEM_SNAKE } },
        { inlineData: { mimeType: 'audio/mp3', data: GEM_CAMEL } },
        { text: 'describe' },
      ],
    }],
  },
});

const RESPONSES_BODY = () => ({
  model: 'gpt-test',
  input: [{
    role: 'user',
    content: [
      { type: 'input_text', text: 'describe' },
      { type: 'input_image', image_url: `data:image/jpeg;base64,${RESP_IMAGE}` },
      { type: 'input_image', image_url: { url: `data:image/jpeg;base64,${RESP_IMAGE_OBJ}` } },
      { type: 'input_file', file_data: RESP_FILE },
      { type: 'inline', source: { type: 'base64', media_type: 'application/zip', data: RESP_SKILL } },
    ],
  }],
});

const ALL_CLAUDE = [CLAUDE_IMAGE, CLAUDE_PDF];
const ALL_CHAT = [CHAT_IMAGE, CHAT_AUDIO, CHAT_FILE];
const ALL_GEMINI = [GEM_SNAKE, GEM_CAMEL];
const ALL_RESPONSES = [RESP_IMAGE, RESP_IMAGE_OBJ, RESP_FILE, RESP_SKILL];

interface Row {
  name: string;
  clientPath: string;
  body: () => Record<string, unknown>;
  upstreamUrl: string;
  /** Payloads this fixture must spill, i.e. the §5.4 positions it holds. */
  refs: number;
  /** Payloads the conversion must still put upstream, and the send must stream. */
  carried: string[];
  /** Payloads the conversion drops in both runs — a converter property, not the spool's. */
  dropped: string[];
  /** The measured egress shape: `true` = §5.3 shape 3, `false` = the expanded string. */
  streamed: boolean;
  sse?: boolean;
  call: (request: Request) => Promise<Response>;
}

const ROWS: Row[] = [
  { name: 'messages→anthropic-messages', clientPath: '/v1/messages', body: CLAUDE_BODY, upstreamUrl: TARGET,
    refs: 2, carried: ALL_CLAUDE, dropped: [], streamed: true,
    call: (r) => handleClaudeRequest(r, TARGET, {}, 'r1', 'claude-test', ENV, LOGGER) },
  { name: 'messages→gemini-generatecontent', clientPath: '/v1/messages', body: CLAUDE_BODY, upstreamUrl: TARGET_GEMINI,
    refs: 2, carried: [CLAUDE_IMAGE], dropped: [CLAUDE_PDF], streamed: true,
    call: (r) => handleGeminiRequestForMessages(r, TARGET, {}, 'r2', 'gemini-test', ENV, LOGGER) },
  { name: 'messages→openai-completions', clientPath: '/v1/messages', body: CLAUDE_BODY, upstreamUrl: TARGET,
    refs: 2, carried: [CLAUDE_IMAGE], dropped: [CLAUDE_PDF], streamed: true,
    call: (r) => handleMessagesRequest(r, TARGET, AUTH, 'r3', 'gpt-test', ENV, LOGGER, undefined, 'openai-completions') },
  { name: 'messages→openai-responses', clientPath: '/v1/messages', body: CLAUDE_BODY, upstreamUrl: TARGET,
    refs: 2, carried: [CLAUDE_IMAGE], dropped: [CLAUDE_PDF], streamed: true,
    call: (r) => handleMessagesRequest(r, TARGET, AUTH, 'r4', 'gpt-test', ENV, LOGGER, undefined, 'openai-responses') },

  { name: 'chat-completions→openai-completions', clientPath: '/v1/chat/completions', body: CHAT_BODY, upstreamUrl: TARGET,
    refs: 3, carried: ALL_CHAT, dropped: [], streamed: true,
    call: (r) => handleChatCompletionsPassthrough(r, TARGET, AUTH, 'r5', LOGGER, ENV, 'gpt-test', 'openai-completions') },
  { name: 'chat-completions→anthropic-messages', clientPath: '/v1/chat/completions', body: CHAT_BODY, upstreamUrl: TARGET,
    refs: 3, carried: [CHAT_IMAGE], dropped: [CHAT_AUDIO, CHAT_FILE], streamed: true,
    call: (r) => handleChatCompletionsPassthrough(r, TARGET, AUTH, 'r6', LOGGER, ENV, 'gpt-test', 'anthropic-messages') },
  { name: 'chat-completions→openai-responses', clientPath: '/v1/chat/completions', body: CHAT_BODY, upstreamUrl: TARGET,
    refs: 3, carried: [CHAT_IMAGE], dropped: [CHAT_AUDIO, CHAT_FILE], streamed: true,
    call: (r) => handleChatCompletionsPassthrough(r, TARGET, AUTH, 'r7', LOGGER, ENV, 'gpt-test', 'openai-responses') },
  { name: 'chat-completions→gemini-generatecontent', clientPath: '/v1/chat/completions', body: CHAT_BODY, upstreamUrl: TARGET,
    refs: 3, carried: [CHAT_IMAGE], dropped: [CHAT_AUDIO, CHAT_FILE], streamed: true,
    call: (r) => handleChatCompletionsPassthrough(r, TARGET, AUTH, 'r8', LOGGER, ENV, 'gpt-test', 'gemini-generatecontent') },

  { name: ':generateContent→gemini', clientPath: '/v1beta/models/gemini-test:generateContent', body: GEMINI_BODY, upstreamUrl: TARGET_GEMINI,
    refs: 2, carried: ALL_GEMINI, dropped: [], streamed: true,
    call: (r) => handleGeminiRequest(r, TARGET, {}, 'r9', 'gemini-test', ENV, LOGGER) },
  { name: ':generateContent→anthropic-messages', clientPath: '/v1beta/models/gemini-test:generateContent', body: GEMINI_BODY, upstreamUrl: TARGET,
    refs: 2, carried: ALL_GEMINI, dropped: [], streamed: true,
    call: (r) => handleOpenAIRequest(r, TARGET, AUTH, 'r10', 'gemini-test', ENV, LOGGER, false, undefined, 'anthropic-messages') },
  { name: ':generateContent→openai-responses', clientPath: '/v1beta/models/gemini-test:generateContent', body: GEMINI_BODY, upstreamUrl: TARGET,
    refs: 2, carried: ALL_GEMINI, dropped: [], streamed: true,
    call: (r) => handleOpenAIRequest(r, TARGET, AUTH, 'r11', 'gemini-test', ENV, LOGGER, false, undefined, 'openai-responses') },
  { name: ':generateContent→openai-completions', clientPath: '/v1beta/models/gemini-test:generateContent', body: GEMINI_BODY, upstreamUrl: TARGET,
    refs: 2, carried: ALL_GEMINI, dropped: [], streamed: true,
    call: (r) => handleOpenAIRequest(r, TARGET, AUTH, 'r12', 'gemini-test', ENV, LOGGER, false, undefined, 'openai-completions') },

  { name: 'interactions→gemini', clientPath: '/v1/interactions', body: INTERACTIONS_BODY, upstreamUrl: TARGET_GEMINI,
    refs: 2, carried: ALL_GEMINI, dropped: [], streamed: true,
    call: (r) => handleGeminiRequest(r, TARGET, {}, 'r13', 'gemini-test', ENV, LOGGER) },
  { name: 'interactions→openai-completions', clientPath: '/v1/interactions', body: INTERACTIONS_BODY, upstreamUrl: TARGET,
    refs: 2, carried: ALL_GEMINI, dropped: [], streamed: true,
    call: (r) => handleOpenAIRequest(r, TARGET, AUTH, 'r14', 'gemini-test', ENV, LOGGER, false, undefined, 'openai-completions') },
  { name: 'interactions→anthropic-messages', clientPath: '/v1/interactions', body: INTERACTIONS_BODY, upstreamUrl: TARGET,
    refs: 2, carried: [], dropped: ALL_GEMINI, streamed: false,
    call: (r) => handleOpenAIRequest(r, TARGET, AUTH, 'r15', 'gemini-test', ENV, LOGGER, false, undefined, 'anthropic-messages') },
  { name: 'interactions→openai-responses', clientPath: '/v1/interactions', body: INTERACTIONS_BODY, upstreamUrl: TARGET,
    refs: 2, carried: [], dropped: ALL_GEMINI, streamed: false,
    call: (r) => handleOpenAIRequest(r, TARGET, AUTH, 'r16', 'gemini-test', ENV, LOGGER, false, undefined, 'openai-responses') },

  { name: 'responses→passthrough', clientPath: '/v1/responses', body: RESPONSES_BODY, upstreamUrl: TARGET,
    refs: 4, carried: ALL_RESPONSES, dropped: [], streamed: true,
    call: (r) => handleResponsesRequest(r, TARGET, AUTH, 'r17', 'gpt-test', ENV, LOGGER) },
  { name: 'responses→anthropic-messages', clientPath: '/v1/responses', body: RESPONSES_BODY, upstreamUrl: TARGET,
    refs: 4, carried: [RESP_IMAGE, RESP_IMAGE_OBJ], dropped: [RESP_FILE, RESP_SKILL], streamed: true,
    call: (r) => handleResponsesRequest(r, TARGET, AUTH, 'r18', 'gpt-test', ENV, LOGGER, 'anthropic-messages') },
  { name: 'responses→openai-completions', clientPath: '/v1/responses', body: RESPONSES_BODY, upstreamUrl: TARGET,
    refs: 4, carried: [RESP_IMAGE, RESP_IMAGE_OBJ], dropped: [RESP_FILE, RESP_SKILL], streamed: true,
    call: (r) => handleResponsesRequest(r, TARGET, AUTH, 'r19', 'gpt-test', ENV, LOGGER, 'openai-completions') },
  { name: 'responses→gemini-generatecontent', clientPath: '/v1/responses', body: RESPONSES_BODY, upstreamUrl: `${TARGET}/v1/models/gpt-test:generateContent`,
    refs: 4, carried: [RESP_IMAGE, RESP_IMAGE_OBJ], dropped: [RESP_FILE, RESP_SKILL], streamed: true,
    call: (r) => handleResponsesRequest(r, TARGET, AUTH, 'r20', 'gpt-test', ENV, LOGGER, 'gemini-generatecontent') },
  { name: 'responses/compact→passthrough', clientPath: '/v1/responses/compact', body: RESPONSES_BODY, upstreamUrl: TARGET,
    refs: 4, carried: ALL_RESPONSES, dropped: [], streamed: true,
    call: (r) => handleResponsesCompactRequest(r, TARGET, AUTH, 'r21', 'gpt-test', ENV, LOGGER) },
  { name: 'responses/input_tokens→passthrough', clientPath: '/v1/responses/input_tokens', body: RESPONSES_BODY, upstreamUrl: TARGET,
    refs: 4, carried: ALL_RESPONSES, dropped: [], streamed: true,
    call: (r) => handleResponsesInputTokensRequest(r, TARGET, AUTH, 'r22', 'gpt-test', ENV, LOGGER) },

  { name: 'messages→gemini `:streamGenerateContent`', clientPath: '/v1/messages', body: CLAUDE_BODY, upstreamUrl: TARGET_STREAM,
    refs: 2, carried: [CLAUDE_IMAGE], dropped: [CLAUDE_PDF], streamed: true, sse: true,
    call: (r) => handleGeminiRequestForMessages(r, TARGET_STREAM, {}, 'r23', 'gemini-test', ENV, LOGGER) },
  { name: 'chat-completions→gemini `:streamGenerateContent`', clientPath: '/v1/chat/completions', body: () => ({ ...CHAT_BODY(), stream: true }), upstreamUrl: TARGET_STREAM,
    refs: 3, carried: [CHAT_IMAGE], dropped: [CHAT_AUDIO, CHAT_FILE], streamed: true, sse: true,
    call: (r) => handleChatCompletionsPassthrough(r, TARGET_STREAM, AUTH, 'r24', LOGGER, ENV, 'gpt-test', 'gemini-generatecontent') },
  { name: '`streamGenerateContent`→gemini', clientPath: '/v1beta/models/gemini-test:streamGenerateContent?alt=sse', body: () => ({ ...GEMINI_BODY(), stream: true }), upstreamUrl: TARGET_STREAM,
    refs: 2, carried: ALL_GEMINI, dropped: [], streamed: true, sse: true,
    call: (r) => handleGeminiRequest(r, TARGET_STREAM, {}, 'r25', 'gemini-test', ENV, LOGGER) },
  { name: 'interactions-stream→gemini', clientPath: '/v1/interactions', body: () => ({ ...INTERACTIONS_BODY(), stream: true }), upstreamUrl: TARGET_STREAM,
    refs: 2, carried: ALL_GEMINI, dropped: [], streamed: true, sse: true,
    call: (r) => handleGeminiRequest(r, TARGET_STREAM, {}, 'r26', 'gemini-test', ENV, LOGGER) },
];

/** The request a handler receives: a ref is plain JSON, so it survives this trip. */
function handlerRequest(row: Row, body: Record<string, unknown>, expectRefs: boolean): Request {
  const text = JSON.stringify(body);
  assert.equal(
    text.includes(BLOB_REF_MARKER),
    expectRefs,
    'the request under test must carry exactly the refs the fixture spilled',
  );
  return new Request(`${CLIENT_URL}${row.clientPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: text,
  });
}

/** Send `body` through the row's handler and return the one upstream send it made. */
async function send(row: Row, body: Record<string, unknown>, expectRefs: boolean): Promise<UpstreamCall> {
  upstreamCalls = [];
  sseResponse = row.sse === true;
  const response = await row.call(handlerRequest(row, body, expectRefs));
  // A streamed response must be drained: leaving it unread would let the handler's
  // own pipeline outlive the case and report its failure in the next one.
  const text = await response.text();
  assert.equal(response.status, 200, `${row.name}: the handler must return the upstream response`);
  assert.equal(upstreamCalls.length, 1, `${row.name}: the handler must have made exactly one upstream call`);
  const call = upstreamCalls[0];
  assert.equal(call.url, row.upstreamUrl, `${row.name}: the request must go to the routed target`);
  if (!row.sse) assert.ok(text.length > 0, `${row.name}: the client response must not be empty`);
  return call;
}

/** Run one row: the ref-bearing send, its expanded baseline, and every claim between. */
async function check(row: Row): Promise<void> {
  // The ref run: a live spool, the real extraction pass, and a loud assertion that
  // the fixture holds exactly the §5.4 positions this row claims.
  enableSpool();
  const body = row.body();
  const extraction = await extractInlineBlobs(body);
  assert.equal(extraction.refs, row.refs, `${row.name}: the fixture must spill exactly its §5.4 positions`);
  assert.equal(extraction.skipped, 0, `${row.name}: no fixture payload may be shape-3 ineligible`);
  let spilled: UpstreamCall;
  try {
    spilled = await send(row, body, true);
  } finally {
    // The send has drained the ref body, so the request is over and its leases go
    // back now — the baseline below resets the store, and §5.4's reset drops the
    // index, which would make a lease still held unreleasable.
    releaseExtractedBlobs(extraction);
  }

  // The baseline: the same request with spooling off, so nothing spills and the
  // converter sees the client's own bytes. §10's "streamed upstream bytes equal
  // the in-memory conversion baseline".
  setSpoolConfig(resolveSpoolConfig({ enabled: false }));
  resetBlobStore();
  const expanded = await send(row, row.body(), false);

  assert.equal(expanded.streamed, false, `${row.name}: the baseline must be the expanded string, not a stream`);
  assert.equal(expanded.headers['content-length'], undefined, `${row.name}: the string path declares no length`);
  assert.equal(expanded.duplex, undefined, `${row.name}: the string path needs no duplex`);

  assert.equal(spilled.text, expanded.text, `${row.name}: the streamed body must be byte-identical to the expanded one`);
  assert.ok(!spilled.text.includes(BLOB_REF_MARKER), `${row.name}: no ref may reach the upstream`);

  for (const payload of row.carried) {
    assert.ok(
      spilled.text.includes(payload),
      `${row.name}: the payload the client sent must reach the upstream at its own position`,
    );
  }
  // The documented drops: absent in both runs, so this file cannot start
  // attributing a converter's data loss to the spool.
  for (const payload of row.dropped) {
    assert.ok(!expanded.text.includes(payload), `${row.name}: expected converter-level drop is missing from the baseline too`);
    assert.ok(!spilled.text.includes(payload), `${row.name}: expected converter-level drop is missing from the ref run too`);
  }

  assert.equal(spilled.streamed, row.streamed, `${row.name}: the egress shape must be the measured one`);
  if (row.streamed) {
    assert.equal(spilled.headers['content-length'], String(spilled.bytes), `${row.name}: the declared length must be the exact byte count`);
    assert.equal(spilled.duplex, 'half', `${row.name}: a streamed send needs duplex: half`);
  } else {
    assert.equal(spilled.headers['content-length'], undefined, `${row.name}: an expanded send declares no length`);
    assert.equal(spilled.duplex, undefined, `${row.name}: an expanded send needs no duplex`);
  }
}

describe('§10 request-predicate round-trip matrix (ref egress vs in-memory baseline)', () => {
  for (const row of ROWS) {
    it(row.name, async () => {
      await check(row);
    });
  }

  it('carries a payload above the spill threshold, across several read chunks, through a conversion', async () => {
    // §10 asks for the matrix "with a payload above the spill threshold", and the
    // round-trip above `blob-refs.test.ts` does is conversion-free. This case is the
    // two together: a payload that would have spilled at ingress, on a front door
    // whose converter rewrites the envelope (`claude-to-openai` re-emits the Claude
    // `source.data` as an OpenAI `data:` URL), so the emitted JSON has to hold a
    // prefix the ref does not, one chunk at a time.
    const size = Math.max(SPOOL_DEFAULTS.thresholdBytes, BLOB_STREAM_CHUNK_BYTES * 2) + 4096;
    const big = Buffer.alloc(size, 0x5a).toString('base64');
    const body = () => ({
      model: 'claude-test',
      max_tokens: 16,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } },
        ],
      }],
    });
    const row: Row = {
      name: 'messages→openai-completions (above threshold)',
      clientPath: '/v1/messages',
      body,
       upstreamUrl: TARGET,
      refs: 1,
      carried: [big],
      dropped: [],
      streamed: true,
      call: (r) => handleMessagesRequest(r, TARGET, AUTH, 'r27', 'gpt-test', ENV, LOGGER, undefined, 'openai-completions'),
    };

    await check(row);
  });
});
