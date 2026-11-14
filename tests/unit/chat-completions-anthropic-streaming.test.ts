import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { handleChatCompletionsPassthrough } from '../../src/handlers/chat-completions.js';
import { createLogger } from '../../src/utils/logger.js';

/**
 * Coverage for the anthropic-messages cross-mode route in the
 * chat-completions handler: streaming SSE conversion, including the
 * spec-shaped usage chunk gated on stream_options.include_usage.
 */

const testLogger = createLogger({});

const env = {} as any;

function makeRequest(body: Record<string, unknown>, stream = false): Request {
  return new Request('https://proxy.test/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, stream }),
  });
}

function anthropicStreamResponse(inputTokens: number, outputTokens: number, text = 'hi'): Response {
  const encoder = new TextEncoder();
  // GLM-style: message_start reports input_tokens: 0; real counts arrive in message_delta.
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 0, output_tokens: 0 } } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
    { type: 'message_stop' },
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function anthropicToolStreamResponse(): Response {
  const encoder = new TextEncoder();
  const events = [
    { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"city":"sf"}' } },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } },
    { type: 'message_stop' },
  ];
  const stream = new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('handleChatCompletionsPassthrough — anthropic-messages cross-mode streaming', () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });

  async function runStream(
    body: Record<string, unknown>,
    responder: () => Response = () => anthropicStreamResponse(19, 7),
    onUpstream?: (init?: RequestInit) => void,
  ): Promise<any[]> {
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      onUpstream?.(init);
      return responder();
    }) as typeof fetch;
    const res = await handleChatCompletionsPassthrough(
      makeRequest({ model: 'a', messages: [{ role: 'user', content: 'hi' }], ...body }, true),
      'https://upstream/v1/messages',
      { Authorization: 'Bearer k' }, 'rid', testLogger, env, 'a', 'anthropic-messages',
    );
    assert.equal(res.headers.get('content-type'), 'text/event-stream');
    const text = await res.text();
    const chunks = text.split('\n\n').filter(s => s.startsWith('data: ')).map(s => s.slice(6));
    assert.equal(chunks[chunks.length - 1], '[DONE]');
    return chunks.filter(s => s !== '[DONE]').map(s => JSON.parse(s));
  }

  it('without stream_options: no usage chunk, finish_reason stop', async () => {
    const parsed = await runStream({});
    const contents = parsed.map((c: any) => c.choices[0]?.delta?.content).filter(Boolean);
    assert.equal(contents.join(''), 'hi');
    const last = parsed[parsed.length - 1];
    assert.equal(last.choices[0].finish_reason, 'stop');
    assert.equal(last.usage, undefined);
  });

  it('with stream_options.include_usage: final empty-choices chunk carries usage', async () => {
    const parsed = await runStream({ stream_options: { include_usage: true } });
    const last = parsed[parsed.length - 1];
    assert.deepEqual(last.choices, []);
    assert.deepEqual(last.usage, { prompt_tokens: 19, completion_tokens: 7, total_tokens: 26 });
    // The finish_reason chunk comes right before the usage chunk.
    assert.equal(parsed[parsed.length - 2].choices[0].finish_reason, 'stop');
  });

  it('opens with one role chunk and never repeats it', async () => {
    const parsed = await runStream({});

    const withRole = parsed.filter((c: any) => c.choices[0]?.delta?.role !== undefined);
    assert.equal(withRole.length, 1, 'role must appear on exactly one chunk');
    assert.deepEqual(withRole[0].choices[0].delta, { role: 'assistant', content: '' });
    // It is the first chunk on the wire, ahead of any content.
    assert.equal(parsed[0], withRole[0]);
    // Content chunks carry content only — the role no longer rides along on each.
    const contentChunks = parsed.filter((c: any) => c.choices[0]?.delta?.content);
    assert.equal(contentChunks.length, 1);
    assert.deepEqual(contentChunks[0].choices[0].delta, { content: 'hi' });
  });

  it('names the speaker on a tool-call-only stream, which previously sent no role', async () => {
    const parsed = await runStream({}, anthropicToolStreamResponse);

    assert.deepEqual(parsed[0].choices[0].delta, { role: 'assistant', content: '' });
    // Every chunk after the opening one must carry no role, tool calls included.
    for (const chunk of parsed.slice(1)) {
      assert.equal('role' in chunk.choices[0].delta, false);
    }
    const toolChunk = parsed.find((c: any) => c.choices[0]?.delta?.tool_calls);
    assert.ok(toolChunk, 'expected a chunk carrying delta.tool_calls');
    assert.equal(toolChunk.choices[0].delta.tool_calls[0].function.name, 'get_weather');
    assert.equal(parsed[parsed.length - 1].choices[0].finish_reason, 'tool_calls');
  });

  it('pairs a converted structured-output body with its beta header', async () => {
    let upstreamHeaders: Headers | undefined;
    let upstreamBody: Record<string, any> | undefined;
    await runStream(
      { response_format: { type: 'json_object' } },
      undefined,
      (init) => {
        upstreamHeaders = new Headers(init?.headers);
        upstreamBody = JSON.parse(String(init?.body));
      },
    );

    assert.equal(upstreamHeaders?.get('anthropic-beta'), 'structured-outputs-2025-11-13');
    assert.deepEqual(upstreamBody?.output_config, {
      format: { type: 'json_schema', schema: { type: 'object' } },
    });
  });
});

/**
 * `tool_calls[].index` is the call's position in the message's own list: dense
 * from 0, and the *same* index on the announcement chunk and on every argument
 * delta that belongs to it, because a client folds deltas into
 * `message.tool_calls[index]` by that number alone.
 *
 * Claude's `content_block` index is a different number — it also counts text and
 * thinking blocks, so a turn that speaks before it calls a tool opens its first
 * call at block 1, and two calls sit at blocks 1 and 2.
 *
 * Pins finding #2 of `review_fixes.md`, which is unfixed at the time of writing:
 * the announcement passed Claude's block index through while every
 * `input_json_delta` hardcoded 0, so each call's arguments were appended to an
 * index no announcement ever named — leaving one bogus call holding every
 * argument concatenated, and the announced calls with `arguments: ""`.
 */
describe('handleChatCompletionsPassthrough — anthropic-messages tool_calls indices', () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });

  /** A turn that speaks first (block 0), then calls two tools in blocks 1 and 2. */
  function anthropicTwoToolStream(): Response {
    const encoder = new TextEncoder();
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Let me check.' } },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"city":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"sf"}' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_2', name: 'get_time' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"tz":"PST"}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } },
      { type: 'message_stop' },
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const e of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }

  async function runTwoToolStream(): Promise<any[]> {
    globalThis.fetch = (async () => anthropicTwoToolStream()) as typeof fetch;
    const res = await handleChatCompletionsPassthrough(
      makeRequest({ model: 'a', messages: [{ role: 'user', content: 'hi' }] }, true),
      'https://upstream/v1/messages', { Authorization: 'Bearer k' }, 'rid-two-tools',
      testLogger, env, 'a', 'anthropic-messages',
    );
    const text = await res.text();
    return text.split('\n\n').filter(s => s.startsWith('data: ')).map(s => s.slice(6))
      .filter(s => s !== '[DONE]').map(s => JSON.parse(s));
  }

  /**
   * Fold `delta.tool_calls` the way a client does: by index, appending argument
   * fragments and taking id/name from whichever chunk carries them.
   */
  function foldToolCalls(chunks: any[]): Map<number, { id?: string; name?: string; arguments: string }> {
    const calls = new Map<number, { id?: string; name?: string; arguments: string }>();
    for (const chunk of chunks) {
      for (const delta of chunk.choices[0]?.delta?.tool_calls ?? []) {
        const call = calls.get(delta.index) ?? { arguments: '' };
        if (delta.id !== undefined) call.id = delta.id;
        if (delta.function?.name !== undefined) call.name = delta.function.name;
        call.arguments += delta.function?.arguments ?? '';
        calls.set(delta.index, call);
      }
    }
    return calls;
  }

  it('keeps each call\'s arguments with its own index, numbered densely from 0', async () => {
    const calls = foldToolCalls(await runTwoToolStream());

    // Dense from 0: the client addresses `message.tool_calls[i]` by this number,
    // so a gap makes it look for a call the message does not have.
    assert.deepEqual([...calls.keys()].sort((a, b) => a - b), [0, 1],
      'tool_calls indices must be dense from 0 — review_fixes.md #2 (Claude blocks 1 and 2 leaked through)');

    assert.equal(calls.get(0)?.id, 'toolu_1');
    assert.equal(calls.get(0)?.name, 'get_weather');
    assert.equal(calls.get(1)?.id, 'toolu_2');
    assert.equal(calls.get(1)?.name, 'get_time');

    // The decisive property: each call's arguments are its own and parse.
    assert.deepEqual(JSON.parse(calls.get(0)!.arguments), { city: 'sf' },
      'the first call must hold its own arguments, not every delta merged at index 0');
    assert.deepEqual(JSON.parse(calls.get(1)!.arguments), { tz: 'PST' },
      'the second call must hold its own arguments');
  });

  it('never announces or feeds an index beyond the calls it announced', async () => {
    const chunks = await runTwoToolStream();
    const indices = chunks.flatMap(c => (c.choices[0]?.delta?.tool_calls ?? []).map((d: any) => d.index));

    // Every index on the wire is one the stream announced, so the two calls above
    // are the whole list: no phantom call, and no call left without arguments.
    assert.equal(indices.every((index: number) => index === 0 || index === 1), true,
      `an unannounced tool_calls index reached the client: ${JSON.stringify(indices)}`);
    assert.equal(chunks[chunks.length - 1].choices[0].finish_reason, 'tool_calls');
  });
});
