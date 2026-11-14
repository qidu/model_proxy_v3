/**
 * A `/v1/responses` request with `stream: true` must be addressed to the Gemini
 * upstream's *streaming* endpoint, and a streaming request the upstream answers
 * with a non-SSE body must fail loudly.
 *
 * `constructGeminiUrl` addresses `:generateContent` for every target that carries
 * no action of its own — the `/v1/responses` and `/v1/interactions` roots
 * (`<base>/v1beta`) and `/v1/messages`'s `v1beta/models` collection — because it
 * only ever had the model to append, never the endpoint choice. Left that way, a
 * `/v1/responses` streaming request asked Gemini for one JSON body, and
 * `streamClaudeAsResponses` parsed it as Claude SSE: zero events, so the model's
 * answer was discarded and `response.completed` reported an empty message item.
 *
 * What is pinned here: the URL the upstream is asked for, that the answer reaches
 * the client (the symptom in the report), that a non-streaming request is left on
 * `:generateContent`, and that the mismatch now fails instead of emptying quietly.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';

const realFetch = globalThis.fetch;
let configPath = '';
let upstreamUrls: string[] = [];

/** The Gemini SSE chunks for the answer "Shanghai is big.", with usage on the last. */
function geminiSseFrames(): Uint8Array[] {
  const encoder = new TextEncoder();
  return [
    { candidates: [{ content: { parts: [{ text: 'Shanghai ' }] } }] },
    {
      candidates: [{ content: { parts: [{ text: 'is big.' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
    },
  ].map(chunk => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
}

function sseResponse(): Response {
  return new Response(new ReadableStream({
    start(controller) {
      for (const frame of geminiSseFrames()) controller.enqueue(frame);
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function jsonResponse(): Response {
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: 'Shanghai is a big city.' }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A faithful Gemini upstream: SSE for `:streamGenerateContent`, a single JSON body
 * for `:generateContent`. `forceJson` models the upstream that ignores `?alt=sse`
 * (a Gemini-compatible third party, or Google answering without it and sending an
 * array of chunks instead of SSE frames).
 */
function installMockFetch(options: { forceJson?: boolean } = {}) {
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    upstreamUrls.push(url);
    if (url.includes(':streamGenerateContent') && !options.forceJson) return sseResponse();
    return jsonResponse();
  }) as typeof fetch;
}

function makeConfigPath(baseUrl: string): string {
  const p = join(tmpdir(), `gemini_stream_endpoint_${Date.now()}_${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(p, `
[models.default]
upstream_mode = "gemini-generatecontent"
base_url = "${baseUrl}"
api_key = "gemini-key2"
`, 'utf-8');
  return p;
}

function env() {
  return { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any;
}

async function post(path: string, body: Record<string, unknown>): Promise<Response> {
  return handler.fetch(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer gemini-key2' },
    body: JSON.stringify(body),
  }), env());
}

/**
 * The outbound Responses SSE payloads. Each frame is `event: <name>` followed by
 * `data: <json>`, so the payload is the block's `data:` line.
 */
function framesOf(text: string): Array<Record<string, any>> {
  return text.split('\n\n')
    .map(block => block.split('\n').find(line => line.startsWith('data: ')))
    .filter((line): line is string => line !== undefined && line !== 'data: [DONE]')
    .map(line => JSON.parse(line.slice(6)));
}

describe('Gemini upstream endpoint for a streaming request', () => {
  beforeEach(() => {
    clearProxyConfigCache();
    upstreamUrls = [];
  });
  afterEach(() => {
    clearProxyConfigCache();
    globalThis.fetch = realFetch;
    if (configPath) unlinkSync(configPath);
    configPath = '';
  });

  it('asks for :streamGenerateContent?alt=sse and delivers the answer to the client', async () => {
    configPath = makeConfigPath('https://generativelanguage.googleapis.com');
    installMockFetch();

    const response = await post('/v1/responses', { model: 'gemini-model2', input: 'tell me shanghai', stream: true });
    const text = await response.text();

    assert.deepEqual(upstreamUrls, [
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-model2:streamGenerateContent?alt=sse',
    ]);

    // The symptom: no `response.output_text.delta` at all, and an empty part. The
    // deltas are what a Responses client rebuilds the answer from.
    const frames = framesOf(text);
    const deltas = frames.filter(f => f.type === 'response.output_text.delta').map(f => f.delta);
    assert.deepEqual(deltas, ['Shanghai ', 'is big.']);

    const completed = frames.find(f => f.type === 'response.completed');
    assert.equal(completed?.response.output[0].content[0].text, 'Shanghai is big.');
    // Usage is zero when the answer was dropped on the floor; it is the upstream's
    // own counts when the SSE actually flowed.
    assert.deepEqual(completed?.response.usage, {
      input_tokens: 5, output_tokens: 7, total_tokens: 12, input_tokens_details: { cached_tokens: 0 },
    });
  });

  it('leaves a non-streaming request on :generateContent', async () => {
    configPath = makeConfigPath('https://generativelanguage.googleapis.com');
    installMockFetch();

    const response = await post('/v1/responses', { model: 'gemini-model2', input: 'tell me shanghai' });

    // The upgrade is the streaming decision: it must not fire for a client that
    // asked for one JSON answer.
    assert.deepEqual(upstreamUrls, [
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-model2:generateContent',
    ]);
    const body = await response.json() as Record<string, any>;
    assert.equal(body.output[0].content[0].text, 'Shanghai is a big city.');
  });

  it('fails loudly when a streaming request is answered with a non-SSE body', async () => {
    configPath = makeConfigPath('https://generativelanguage.googleapis.com');
    installMockFetch({ forceJson: true });

    const response = await post('/v1/responses', { model: 'gemini-model2', input: 'tell me shanghai', stream: true });

    // Before the guard this was a 200 whose whole answer was discarded — a
    // successful-looking empty turn (rule #8).
    assert.equal(response.status, 500);
    const body = await response.json() as Record<string, any>;
    assert.match(body.error.message, /'application\/json' instead of text\/event-stream/);
  });

  it('adds ?alt=sse to a target that names the streaming action without it', async () => {
    configPath = makeConfigPath(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-model2:streamGenerateContent',
    );
    installMockFetch();

    const response = await post('/v1/responses', { model: 'gemini-model2', input: 'tell me shanghai', stream: true });
    const text = await response.text();

    // Without `alt=sse` the upstream answers an array of chunks, not SSE frames —
    // the same empty answer by another route.
    assert.deepEqual(upstreamUrls, [
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-model2:streamGenerateContent?alt=sse',
    ]);
    assert.deepEqual(framesOf(text).filter(f => f.type === 'response.output_text.delta').map(f => f.delta),
      ['Shanghai ', 'is big.']);
  });

  it('keeps a target query intact and appends alt=sse with &', async () => {
    configPath = makeConfigPath(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-model2:generateContent?key=abc',
    );
    installMockFetch();

    const response = await post('/v1/responses', { model: 'gemini-model2', input: 'tell me shanghai', stream: true });
    const text = await response.text();

    // The action is replaced and the query survives: one `?`, and `alt=sse` joined
    // with `&` rather than a second `?`.
    assert.deepEqual(upstreamUrls, [
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-model2:streamGenerateContent?key=abc&alt=sse',
    ]);
    assert.deepEqual(framesOf(text).filter(f => f.type === 'response.output_text.delta').map(f => f.delta),
      ['Shanghai ', 'is big.']);
  });

  it('does not disturb a target that already streams with ?alt=sse', async () => {
    configPath = makeConfigPath(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-model2:streamGenerateContent?alt=sse',
    );
    installMockFetch();

    const response = await post('/v1/responses', { model: 'gemini-model2', input: 'tell me shanghai', stream: true });
    const text = await response.text();

    // Exactly one action and exactly one `alt=sse`: the rewrite must not append a
    // second either.
    assert.deepEqual(upstreamUrls, [
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-model2:streamGenerateContent?alt=sse',
    ]);
    assert.deepEqual(framesOf(text).filter(f => f.type === 'response.output_text.delta').map(f => f.delta),
      ['Shanghai ', 'is big.']);
  });
});
