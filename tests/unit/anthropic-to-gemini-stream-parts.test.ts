/**
 * `anthropic-messages` upstream → Gemini `:streamGenerateContent` egress: the
 * answer text and the usage both have to survive `processAnthropicSSEBuffer`
 * (`src/handlers/openai.ts`).
 *
 * Before this file's change, the converter recognized text in exactly one shape
 * — `content_block_delta` with `delta.type === 'text_delta'` — so an upstream
 * that carried the answer anywhere else produced a stream whose only event was
 * the terminal `finishReason: "STOP"` chunk with `parts: []`, and every
 * `usageMetadata` was three zeros because `message_delta.usage` was discarded.
 * Text carried three other ways (`content_block_start.content_block.text`, a
 * delta typed `text` or left untyped, and a whole message replayed inside
 * `message_start`) reproduced that byte-for-byte against a stub upstream.
 *
 * One test per shape, plus the standard Anthropic stream as the regression pin,
 * and the usage mapping at the converter seam.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { handleOpenAIRequest } from '../../src/handlers/openai.js';
import { createLogger } from '../../src/utils/logger.js';

const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});
const UPSTREAM = 'https://upstream.example/v1/messages';
const AUTH = { 'x-api-key': 'upstream-key' };

const encoder = new TextEncoder();
const realFetch = globalThis.fetch;

after(() => { globalThis.fetch = realFetch; });

/** One SSE event, framed the way Anthropic frames it. */
function event(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function messageStart(content: unknown[] = [], usage?: Record<string, number>): string {
  return event('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6',
      content, stop_reason: null,
      ...(usage ? { usage } : {}),
    },
  });
}

function messageDelta(usage?: Record<string, number>, stopReason = 'end_turn'): string {
  return event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    ...(usage ? { usage } : {}),
  });
}

const MESSAGE_STOP = event('message_stop', { type: 'message_stop' });

/** Serve `sse` as the upstream body, one write per array entry. */
function stubUpstream(writes: string[]): void {
  globalThis.fetch = (async (): Promise<Response> => new Response(new ReadableStream({
    start(controller) {
      for (const w of writes) controller.enqueue(encoder.encode(w));
      controller.close();
    },
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;
}

interface GeminiChunk {
  model: string;
  candidates?: Array<{
    content?: { role?: string; parts?: Array<Record<string, unknown>> };
    index?: number;
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

/** Run the handler for one canned upstream stream; return the Gemini chunks the client sees. */
async function convert(writes: string[], clientPath = '/v1beta/models/claude-model:streamGenerateContent?alt=sse'): Promise<GeminiChunk[]> {
  stubUpstream(writes);
  const response = await handleOpenAIRequest(
    new Request(`http://proxy.test${clientPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'say hi' }] }] }),
    }),
    UPSTREAM, AUTH, 'r-stream', 'claude-sonnet-4-6', ENV, LOGGER, true, undefined, 'anthropic-messages',
  );
  assert.equal(response.status, 200, 'the egress must answer 200');
  const text = await response.text();
  return text.split('\n\n')
    .filter(frame => frame.startsWith('data: '))
    .map(frame => JSON.parse(frame.slice(6)) as GeminiChunk);
}

/** Every text a client would assemble from the stream, in order. */
function answerText(chunks: GeminiChunk[]): string {
  return chunks
    .flatMap(c => c.candidates?.[0]?.content?.parts ?? [])
    .map(p => (typeof p.text === 'string' ? p.text : ''))
    .join('');
}

const USAGE = { input_tokens: 7, output_tokens: 2 };

describe('anthropic-messages → :streamGenerateContent: the answer reaches the client', () => {
  it('converts the documented `text_delta` stream (regression pin)', async () => {
    const chunks = await convert([
      messageStart([], { input_tokens: 7, output_tokens: 0 }),
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' there' } }),
      event('content_block_stop', { type: 'content_block_stop', index: 0 }),
      messageDelta(USAGE),
      MESSAGE_STOP,
    ]);

    assert.equal(answerText(chunks), 'Hi there', 'the answer must arrive verbatim, once');
    const finish = chunks.at(-1)!;
    assert.equal(finish.candidates?.[0]?.finishReason, 'STOP', 'the stream must end on a terminal chunk');
    assert.deepEqual(finish.candidates?.[0]?.content?.parts, [], 'a finish-only chunk carries empty parts');
  });

  it('converts text carried in a pre-filled `content_block_start` block', async () => {
    // Some gateways fill the block up front and send no text_delta at all; this
    // stream used to reach the client as an empty answer.
    const chunks = await convert([
      messageStart([], { input_tokens: 7, output_tokens: 0 }),
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Hi there' } }),
      event('content_block_stop', { type: 'content_block_stop', index: 0 }),
      messageDelta(USAGE),
      MESSAGE_STOP,
    ]);

    assert.equal(answerText(chunks), 'Hi there');
  });

  it('converts a text delta whose `type` is `text` or absent', async () => {
    const typedLess = await convert([
      messageStart([], { input_tokens: 7, output_tokens: 0 }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text', text: 'Hi' } }),
      messageDelta(USAGE),
      MESSAGE_STOP,
    ]);
    assert.equal(answerText(typedLess), 'Hi', 'a delta typed `text` carries text');

    const untyped = await convert([
      messageStart([], { input_tokens: 7, output_tokens: 0 }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { text: 'there' } }),
      messageDelta(USAGE),
      MESSAGE_STOP,
    ]);
    assert.equal(answerText(untyped), 'there', 'a delta with no type at all carries text');
  });

  it('converts a message replayed inside `message_start`, and stays silent for a standard one', async () => {
    const replayed = await convert([
      messageStart([{ type: 'text', text: 'Hi there' }], { input_tokens: 7, output_tokens: 2 }),
      messageDelta(USAGE),
      MESSAGE_STOP,
    ]);
    assert.equal(answerText(replayed), 'Hi there', 'a whole message dressed as a stream must not be lost');

    // Standard Anthropic sends `content: []`; the widened branch must not add a
    // chunk where there is nothing to convert.
    const standard = await convert([
      messageStart([], { input_tokens: 7, output_tokens: 0 }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }),
      messageDelta(USAGE),
      MESSAGE_STOP,
    ]);
    assert.equal(standard.length, 2, 'one text chunk + one finish chunk, no duplicate');
    assert.equal(answerText(standard), 'ok');
  });

  it('still wraps a thinking block into a thought part', async () => {
    const chunks = await convert([
      messageStart([], { input_tokens: 7, output_tokens: 0 }),
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'pondering' } }),
      event('content_block_stop', { type: 'content_block_stop', index: 0 }),
      messageDelta(USAGE),
      MESSAGE_STOP,
    ]);
    const thought = (chunks[0].candidates?.[0]?.content?.parts ?? []).find(p => p.thought === true);
    assert.equal(thought?.text, 'pondering', 'thinking must surface as a thought part');
  });

  it('still emits a complete functionCall for a tool turn', async () => {
    const chunks = await convert([
      messageStart([], { input_tokens: 31, output_tokens: 0 }),
      event('content_block_start', {
        type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} },
      }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"sf"}' } }),
      event('content_block_stop', { type: 'content_block_stop', index: 0 }),
      messageDelta({ input_tokens: 31, output_tokens: 9 }, 'tool_use'),
      MESSAGE_STOP,
    ]);
    const call = (chunks[0].candidates?.[0]?.content?.parts ?? []).find(p => p.functionCall !== undefined)?.functionCall;
    assert.deepEqual(call, { id: 'toolu_1', name: 'get_weather', args: { city: 'sf' } });
    assert.equal(chunks.at(-1)?.candidates?.[0]?.finishReason, 'STOP');
  });
});

describe('anthropic-messages → :streamGenerateContent: usageMetadata carries the counts', () => {
  it('reports the input side on the text chunk and the final counts on the finish chunk', async () => {
    const chunks = await convert([
      messageStart([], { input_tokens: 7, output_tokens: 0 }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
      messageDelta({ output_tokens: 2 }),
      MESSAGE_STOP,
    ]);

    // A running total, the way a native Gemini stream reports it: input known at
    // start, output only once the turn ends.
    assert.deepEqual(chunks[0].usageMetadata, { promptTokenCount: 7, candidatesTokenCount: 0, totalTokenCount: 7 });
    assert.deepEqual(chunks.at(-1)?.usageMetadata, { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 });
  });

  it('sums the cache fields into promptTokenCount, as Gemini counts the cached portion', async () => {
    const chunks = await convert([
      messageStart([], { input_tokens: 100, cache_read_input_tokens: 40, cache_creation_input_tokens: 10, output_tokens: 0 }),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
      messageDelta({ output_tokens: 5 }),
      MESSAGE_STOP,
    ]);
    assert.deepEqual(chunks.at(-1)?.usageMetadata, { promptTokenCount: 150, candidatesTokenCount: 5, totalTokenCount: 155 });
  });

  it('reports no usage it was not given, rather than a guess', async () => {
    const chunks = await convert([
      messageStart([]),
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
      messageDelta(),
      MESSAGE_STOP,
    ]);
    assert.deepEqual(chunks.at(-1)?.usageMetadata, { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 });
  });
});
