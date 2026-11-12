import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleChatCompletionsPassthrough } from '../../src/handlers/chat-completions.js';
import { createLogger } from '../../src/utils/logger.js';

/**
 * The `openai-responses` cross-mode route in the chat-completions handler.
 *
 * Before this route converted its answer, a streamed request came back as the
 * upstream's own Responses SSE — `response.output_text.delta` and friends, with
 * no `chat.completion.chunk` and no `[DONE]` — so an OpenAI client saw a stream
 * it could not parse. The converter is unit-tested in
 * `responses-completions-roundtrip.test.ts`; what is pinned here is the wiring:
 * what actually reaches the client, in what order, and what happens when the
 * upstream stream is broken or truncated.
 */

const testLogger = createLogger({});

const env = {} as any;

const RESPONSES_URL = 'https://upstream/v1/responses';

function makeRequest(body: Record<string, unknown>, stream = true): Request {
  return new Request('https://proxy.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hi' }], stream, ...body }),
  });
}

/** A Responses SSE answer, one `data:` frame per event, split when asked. */
function responsesStreamResponse(events: Array<Record<string, unknown>>, splitAt?: number): Response {
  const encoder = new TextEncoder();
  const frames = events.map(e => encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
  const chunks = splitAt === undefined
    ? frames
    : [
      // Cut the first frame in half, so the handler's frame reassembly is on the
      // path: an SSE frame is not guaranteed to arrive in one read.
      ...(() => {
        const head = frames[0];
        const cut = splitAt;
        return [head.subarray(0, cut), head.subarray(cut), ...frames.slice(1)];
      })(),
    ];
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(c);
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function textAnswer(text: string): Array<Record<string, unknown>> {
  return [
    { type: 'response.created', response: { id: 'resp_stream', created_at: 1700000123, model: 'gpt-upstream' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1' } },
    {
      type: 'response.completed',
      response: { id: 'resp_stream', created_at: 1700000123, model: 'gpt-upstream', usage: { input_tokens: 19, output_tokens: 7, total_tokens: 26 } },
    },
  ];
}

describe('handleChatCompletionsPassthrough — openai-responses streaming conversion', () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  async function run(events: Array<Record<string, unknown>>, body: Record<string, unknown> = {}, splitAt?: number): Promise<{ response: Response; chunks: any[] }> {
    globalThis.fetch = (async () => responsesStreamResponse(events, splitAt)) as typeof fetch;
    const response = await handleChatCompletionsPassthrough(
      makeRequest(body), RESPONSES_URL, { Authorization: 'Bearer k' }, 'rid', testLogger, env, 'gpt-test', 'openai-responses',
    );
    return { response, chunks: await readChunks(response) };
  }

  async function readChunks(response: Response): Promise<any[]> {
    const text = await response.text();
    const frames = text.split('\n\n').filter(s => s.startsWith('data: ')).map(s => s.slice(6));
    assert.equal(frames[frames.length - 1], '[DONE]', 'the client stream must end with [DONE]');
    return frames.filter(s => s !== '[DONE]').map(s => JSON.parse(s));
  }

  /**
   * Drive a stream the handler is expected to abort, and return the bytes the
   * client saw before the failure. The read itself must reject — an aborted
   * stream that resolves would look like a completed answer to the client.
   */
  async function runFailing(events: Array<Record<string, unknown>>): Promise<string> {
    globalThis.fetch = (async () => responsesStreamResponse(events)) as typeof fetch;
    const response = await handleChatCompletionsPassthrough(
      makeRequest({}), RESPONSES_URL, { Authorization: 'Bearer k' }, 'rid', testLogger, env, 'gpt-test', 'openai-responses',
    );

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let seen = '';
    await assert.rejects(async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        seen += decoder.decode(value, { stream: true });
      }
    });
    return seen;
  }

  /**
   * An aborted stream may have delivered whole chunks before it failed; what it
   * must never deliver is the terminal evidence — a non-null `finish_reason`
   * frame or `[DONE]` — that tells the client the answer is complete.
   */
  function assertNoTerminalFrame(partial: string): void {
    assert.equal(partial.includes('[DONE]'), false, 'an aborted answer must not be terminated like a complete one');
    const parsed = partial.split('\n\n')
      .filter(s => s.startsWith('data: '))
      .map(s => JSON.parse(s.slice(6)));
    const finished = parsed.filter(c => c.choices[0]?.finish_reason != null);
    assert.deepEqual(finished, [], 'no chunk may carry a finish_reason');
  }

  it('frames the answer as chat.completion.chunk and ends with [DONE]', async () => {
    const { response, chunks } = await run(textAnswer('hello there'));

    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(response.headers.get('x-request-id'), 'rid');
    assert.deepEqual(chunks.map(c => c.object), chunks.map(() => 'chat.completion.chunk'));
    // id/created/model are adopted from response.created, so every frame names
    // the upstream response the client is reading.
    assert.deepEqual(chunks.map(c => c.id), chunks.map(() => 'resp_stream'));
    assert.deepEqual(chunks.map(c => c.created), chunks.map(() => 1700000123));
    assert.deepEqual(chunks.map(c => c.model), chunks.map(() => 'gpt-upstream'));
    assert.deepEqual(chunks.map(c => c.choices[0].delta.content).filter(Boolean), ['hello there']);
    const last = chunks[chunks.length - 1];
    assert.deepEqual(last.choices[0], { index: 0, delta: {}, finish_reason: 'stop' });
    assert.equal(last.usage, undefined, 'usage is only reported when the client asks for it');
  });

  it('reassembles a frame split across two reads', async () => {
    const { chunks } = await run(textAnswer('split'), {}, 20);
    assert.deepEqual(chunks.map(c => c.choices[0].delta.content).filter(Boolean), ['split']);
    assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'stop');
  });

  it('emits the empty-choices usage chunk only when stream_options.include_usage is set', async () => {
    const { chunks } = await run(textAnswer('x'), { stream_options: { include_usage: true } });

    const last = chunks[chunks.length - 1];
    assert.deepEqual(last.choices, []);
    assert.deepEqual(last.usage, { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 });
    assert.equal(chunks[chunks.length - 2].choices[0].finish_reason, 'stop', 'usage follows the finish_reason frame');
  });

  it('converts a tool-calling answer without inventing text', async () => {
    const { chunks } = await run([
      { type: 'response.created', response: { id: 'resp_tool', created_at: 1700000123, model: 'gpt-upstream' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"SF"}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' } },
      { type: 'response.completed', response: { id: 'resp_tool', usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } },
    ]);

    const toolDeltas = chunks.flatMap(c => c.choices[0].delta.tool_calls ?? []);
    assert.deepEqual(toolDeltas[0], { index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } });
    assert.equal(toolDeltas.slice(1).map(t => t.function.arguments).join(''), '{"city":"SF"}');
    assert.equal(chunks.some(c => c.choices[0].delta.content), false, 'no empty-string content frames');
    assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'tool_calls');
  });

  it('aborts the client stream on response.failed instead of closing it as a success', async () => {
    const partial = await runFailing([
      { type: 'response.created', response: { id: 'resp_fail' } },
      { type: 'response.output_text.delta', delta: 'partial' },
      { type: 'response.failed', response: { error: { message: 'upstream blew up' } } },
    ]);

    assert.match(partial, /partial/, 'the frames before the failure did reach the client');
    assertNoTerminalFrame(partial);
  });

  it('aborts a stream that ends without the terminal event', async () => {
    const partial = await runFailing([
      { type: 'response.created', response: { id: 'resp_cut' } },
      { type: 'response.output_text.delta', delta: 'partial' },
    ]);

    // Truncation must not look like a completed answer: no finish_reason, no [DONE].
    assert.match(partial, /partial/);
    assertNoTerminalFrame(partial);
  });

  it('relays an upstream error body unchanged, under the upstream status', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const response = await handleChatCompletionsPassthrough(
      makeRequest({}), RESPONSES_URL, { Authorization: 'Bearer k' }, 'rid', testLogger, env, 'gpt-test', 'openai-responses',
    );

    assert.equal(response.status, 401);
    assert.equal(response.headers.get('x-request-id'), 'rid');
    assert.deepEqual(await response.json(), { error: { message: 'bad key' } });
  });
});
