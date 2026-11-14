/**
 * The Gemini front doors on an `openai-responses` upstream — `handleOpenAIRequest`'s
 * `forwardCompletionsAsOpenAIResponses` stream egress.
 *
 * `processResponsesSSEBuffer` used to hand-map `response.output_text.delta` and
 * nothing else, so a Gemini client on this route got text deltas and then a plain
 * end of stream: no `finishReason` (it lives on `response.completed` /
 * `response.incomplete`, which were dropped), no `functionCall` parts, no thought
 * parts, and `usageMetadata` of three zeros on every frame. It now defers the whole
 * Responses event vocabulary to `responsesStreamEventToChatChunks` — the converter
 * the `/v1/chat/completions` egress uses — whose mapping is unit-tested in
 * `responses-completions-roundtrip.test.ts`. What is pinned here is the wiring:
 * what actually reaches a Gemini client, and what happens when the upstream stream
 * is broken, failed, or truncated.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleOpenAIRequest } from '../../src/handlers/openai.js';
import { createLogger, type Logger } from '../../src/utils/logger.js';

const LOGGER = createLogger({});
const ENV = {} as any;
const TARGET = 'https://upstream.example/v1/responses';
const AUTH = { Authorization: 'Bearer upstream-key' };
const MODEL = 'openai-model';

/**
 * A Gemini front-door request — `:streamGenerateContent?alt=sse` by default, which
 * is the request in the report.
 */
function geminiRequest(
  path = `/v1beta/models/${MODEL}:streamGenerateContent?alt=sse`,
  body: Record<string, unknown> = { contents: [{ role: 'user', parts: [{ text: 'say hi' }] }] },
): Request {
  return new Request(`https://proxy.test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A Responses SSE answer, one `data:` frame per event, split when asked. */
function responsesStreamResponse(events: Array<Record<string, unknown>>, splitAt?: number, trailing = ''): Response {
  const encoder = new TextEncoder();
  const frames = events.map(e => encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
  const chunks = splitAt === undefined
    ? frames
    : [...(() => {
      // An SSE frame is not guaranteed to arrive in one read; the first frame is
      // cut in half so the driver's reassembly is on the path.
      const head = frames[0];
      return [head.subarray(0, splitAt), head.subarray(splitAt)];
    })(), ...frames.slice(1)];
  if (trailing !== '') {
    // Delivered in the same read as the event before it, the way a cut stream
    // actually ends.
    const last = chunks.pop()!;
    const tail = encoder.encode(trailing);
    const joined = new Uint8Array(last.length + tail.length);
    joined.set(last);
    joined.set(tail, last.length);
    chunks.push(joined);
  }
  return new Response(new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function textAnswer(text: string): Array<Record<string, unknown>> {
  return [
    { type: 'response.created', response: { id: 'resp_stream', created_at: 1700000123, model: 'gpt-upstream' } },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'msg_1' } },
    {
      type: 'response.completed',
      response: { id: 'resp_stream', usage: { input_tokens: 19, output_tokens: 7, total_tokens: 26 } },
    },
  ];
}

/** Every outbound SSE data frame, parsed. Gemini frames carry no event name. */
async function readFrames(response: Response): Promise<Array<Record<string, any>>> {
  const text = await response.text();
  return text.split('\n\n').filter(block => block.trim() !== '').map(block => {
    assert.ok(block.startsWith('data: '), `every outbound frame must be a data frame, got: ${block}`);
    return JSON.parse(block.slice(6));
  });
}

/** The Gemini parts the client received, in order, across all candidates. */
function partsOf(frames: Array<Record<string, any>>): Array<Record<string, any>> {
  return frames.flatMap(frame => (frame.candidates ?? []).flatMap((c: any) => c.content?.parts ?? []));
}

/** Every `finishReason` the client received. A complete answer carries one. */
function finishReasonsOf(frames: Array<Record<string, any>>): string[] {
  return frames.flatMap(frame => (frame.candidates ?? [])
    .map((c: any) => c.finishReason)
    .filter((reason: unknown) => reason !== undefined));
}

/** The frame that ends the answer — the only one allowed to carry real usage. */
function terminalFrame(frames: Array<Record<string, any>>): Record<string, any> | undefined {
  return frames.find(frame => (frame.candidates ?? []).some((c: any) => c.finishReason !== undefined));
}

/**
 * An aborted stream may have delivered whole frames before it failed; what it must
 * never deliver is the terminal evidence — a `finishReason` — that tells a Gemini
 * client the answer is complete.
 */
function assertNoTerminalFrame(partial: string): void {
  const frames = partial.split('\n\n').filter(b => b.startsWith('data: ')).map(b => JSON.parse(b.slice(6)));
  assert.deepEqual(finishReasonsOf(frames), [], 'an aborted answer must not carry a finishReason');
}

describe('Gemini front door → openai-responses: the SSE egress', () => {
  const realFetch = globalThis.fetch;
  let upstreamBodies: string[] = [];
  after(() => { globalThis.fetch = realFetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  async function run(
    events: Array<Record<string, unknown>>,
    options: { splitAt?: number; path?: string; body?: Record<string, unknown>; logger?: Logger; trailing?: string } = {},
  ): Promise<{ response: Response; frames: Array<Record<string, any>> }> {
    upstreamBodies = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBodies.push(typeof init?.body === 'string' ? init.body : '');
      return responsesStreamResponse(events, options.splitAt, options.trailing);
    }) as typeof fetch;
    const response = await handleOpenAIRequest(
      geminiRequest(options.path, options.body), TARGET, AUTH, 'r-stream', MODEL, ENV,
      options.logger ?? LOGGER, undefined, undefined, 'openai-responses',
    );
    return { response, frames: await readFrames(response) };
  }

  async function runFailing(events: Array<Record<string, unknown>>): Promise<string> {
    globalThis.fetch = (async () => responsesStreamResponse(events)) as typeof fetch;
    const response = await handleOpenAIRequest(
      geminiRequest(), TARGET, AUTH, 'r-stream', MODEL, ENV, LOGGER,
      undefined, undefined, 'openai-responses',
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

  it('streams the text and ends with a finishReason carrying the upstream usage', async () => {
    const { response, frames } = await run(textAnswer('hi there'));

    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.deepEqual(partsOf(frames).filter(part => part.text !== undefined), [{ text: 'hi there' }]);
    // The finish_reason the client used to never see: `response.completed` is the
    // only place a Responses upstream states it.
    assert.deepEqual(finishReasonsOf(frames), ['STOP']);

    // Usage rides on the terminal Gemini frame — the only frame whose counts are
    // real. The upstream request was streamed, so this is the SSE path.
    const terminal = terminalFrame(frames);
    assert.deepEqual(terminal?.usageMetadata, {
      promptTokenCount: 19, candidatesTokenCount: 7, totalTokenCount: 26,
    });
    const upstream = JSON.parse(upstreamBodies[0]);
    assert.equal(upstream.stream, true, 'a Responses upstream must be asked to stream');
    assert.deepEqual(upstream.input[0].content, [{ type: 'input_text', text: 'say hi' }]);
  });

  it('reassembles a frame split across two reads', async () => {
    const { frames } = await run(textAnswer('split'), { splitAt: 20 });
    assert.deepEqual(partsOf(frames).filter(part => part.text !== undefined), [{ text: 'split' }]);
    assert.deepEqual(finishReasonsOf(frames), ['STOP']);
  });

  it('delivers a tool call as a functionCall part instead of dropping it', async () => {
    const { frames } = await run([
      { type: 'response.created', response: { id: 'resp_tool' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"SF"}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' } },
      { type: 'response.completed', response: { id: 'resp_tool', usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 } } },
    ]);

    // The fragments are accumulated by `processSSEBuffer` and flushed once, as a
    // complete part — never as a name-less partial call.
    assert.deepEqual(partsOf(frames).filter(part => part.functionCall !== undefined), [{
      functionCall: { id: 'call_1', name: 'get_weather', args: { city: 'SF' } },
    }]);
    assert.deepEqual(finishReasonsOf(frames), ['STOP']);
  });

  it('reports a truncated answer as MAX_TOKENS rather than STOP', async () => {
    const { frames } = await run([
      { type: 'response.created', response: { id: 'resp_cut' } },
      { type: 'response.output_text.delta', delta: 'partial' },
      {
        type: 'response.incomplete',
        response: { id: 'resp_cut', status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } },
      },
    ]);

    assert.deepEqual(partsOf(frames).filter(part => part.text !== undefined), [{ text: 'partial' }]);
    assert.deepEqual(finishReasonsOf(frames), ['MAX_TOKENS']);
  });

  it('delivers upstream reasoning as thought parts', async () => {
    const { frames } = await run([
      { type: 'response.created', response: { id: 'resp_think' } },
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'weighing it up' },
      { type: 'response.output_text.delta', delta: 'answer' },
      { type: 'response.completed', response: { id: 'resp_think' } },
    ]);

    assert.deepEqual(partsOf(frames).filter(part => part.thought === true), [{ thought: true, text: 'weighing it up' }]);
    assert.deepEqual(partsOf(frames).filter(part => part.text !== undefined && part.thought === undefined), [{ text: 'answer' }]);
  });

  it('reports a dropped output item and still ends the answer', async () => {
    const warnings: string[] = [];
    const spy: Logger = { ...LOGGER, warn: (_id: string, message: string) => { warnings.push(message); } };
    const { frames } = await run([
      { type: 'response.created', response: { id: 'resp_img' } },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'image_generation_call', id: 'ig_1' } },
      { type: 'response.output_text.delta', delta: 'here you go' },
      { type: 'response.completed', response: { id: 'resp_img' } },
    ], { logger: spy });

    // A silent drop is forbidden (rule #8): the only place the loss can be
    // reported is the log.
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /dropped 1 output item\(s\) of type 'image_generation_call'/);
    assert.match(warnings[0], /^:generateContent /, 'the report names the client endpoint');
    assert.deepEqual(finishReasonsOf(frames), ['STOP'], 'a dropped item must not cost the answer its ending');
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
      { type: 'response.created', response: { id: 'resp_truncated' } },
      { type: 'response.output_text.delta', delta: 'partial' },
    ]);

    // Truncation must not look like a completed answer: a Gemini client would read
    // the bare end of stream as a finished turn.
    assert.match(partial, /partial/);
    assertNoTerminalFrame(partial);
  });

  it('serves the /v1/interactions front door from the same conversion', async () => {
    const { frames } = await run([
      { type: 'response.created', response: { id: 'resp_int' } },
      { type: 'response.output_text.delta', delta: 'interaction answer' },
      { type: 'response.completed', response: { id: 'resp_int', usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 } } },
    ], {
      path: '/v1/interactions',
      // This endpoint reads `stream` off the body; only the generateContent path
      // forces it from `?alt=sse`.
      body: { input: [{ type: 'user_input', content: 'hi' }], stream: true },
    });

    const outputs = frames.flatMap(frame => frame.outputs ?? []);
    assert.deepEqual(outputs.filter((o: any) => o.type === 'text'), [{ type: 'text', text: 'interaction answer' }]);
  });

  it('closes cleanly when a partial frame trails the terminal event', async () => {
    // A cut upstream ends mid-frame. The answer already ended — the trailing
    // fragment must not be converted (it would repeat the ending) or parsed (it
    // would throw and abort a stream whose finishReason the client already has).
    const { frames } = await run(textAnswer('done'), {
      trailing: 'data: {"type":"response.output_text.del',
    });

    assert.deepEqual(partsOf(frames).filter(part => part.text !== undefined), [{ text: 'done' }]);
    assert.deepEqual(finishReasonsOf(frames), ['STOP']);
  });
});

/**
 * The same route without streaming (`:generateContent`). The answer is converted by
 * `convertResponsesToChatCompletionsAnswer` — the function the `/v1/chat/completions`
 * egress uses — where a hand-built substitute used to read `output_text` and
 * `function_call` items and then report `finish_reason: 'stop'` for every answer
 * that called no tool, so a truncated turn arrived as STOP.
 */
describe('Gemini front door → openai-responses: the non-streaming egress', () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  async function runJson(
    json: Record<string, unknown>,
    options: { path?: string; logger?: Logger } = {},
  ): Promise<Record<string, any>> {
    globalThis.fetch = (async () => new Response(JSON.stringify(json), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const response = await handleOpenAIRequest(
      geminiRequest(options.path ?? `/v1beta/models/${MODEL}:generateContent`),
      TARGET, AUTH, 'r-json', MODEL, ENV, options.logger ?? LOGGER,
      undefined, undefined, 'openai-responses',
    );
    return await response.json() as Record<string, any>;
  }

  it('reports a truncated answer as MAX_TOKENS instead of STOP', async () => {
    const out = await runJson({
      id: 'resp_cut', object: 'response', status: 'incomplete', model: 'gpt-upstream',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial answer' }] }],
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    });

    assert.deepEqual(out.candidates[0].content.parts, [{ text: 'partial answer' }]);
    assert.equal(out.candidates[0].finishReason, 'MAX_TOKENS');
    assert.deepEqual(out.usageMetadata, { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 });
  });

  it('reports a content-filtered answer as SAFETY', async () => {
    const out = await runJson({
      id: 'resp_filtered', status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output: [],
    });

    assert.equal(out.candidates[0].finishReason, 'SAFETY');
  });

  it('keeps upstream reasoning as a thought part, ahead of the answer text', async () => {
    const out = await runJson({
      id: 'resp_think', status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'weighing it up' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
      ],
    });

    assert.deepEqual(out.candidates[0].content.parts, [
      { thought: true, text: 'weighing it up' },
      { text: 'answer' },
    ]);
    assert.equal(out.candidates[0].finishReason, 'STOP');
  });

  it('converts tool calls in output order and reports them as tool_calls → STOP', async () => {
    const out = await runJson({
      id: 'resp_tool', status: 'completed',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' },
      ],
    });

    assert.deepEqual(out.candidates[0].content.parts, [
      { text: 'checking' },
      { functionCall: { id: 'call_1', name: 'get_weather', args: { city: 'SF' } } },
    ]);
    assert.equal(out.candidates[0].finishReason, 'STOP');
  });

  it('reports an output item with no Gemini position instead of dropping it silently', async () => {
    const warnings: string[] = [];
    const spy: Logger = { ...LOGGER, warn: (_id: string, message: string) => { warnings.push(message); } };
    await runJson({
      id: 'resp_img', status: 'completed',
      output: [
        { type: 'image_generation_call', id: 'ig_1' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'here you go' }] },
      ],
    }, { logger: spy });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /dropped 1 output item\(s\) of type 'image_generation_call'/);
    assert.match(warnings[0], new RegExp(`^/v1beta/models/${MODEL}:generateContent `));
  });
});
