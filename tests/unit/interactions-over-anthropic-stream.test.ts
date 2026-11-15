/**
 * `/v1/interactions` served by an `anthropic-messages` upstream — the streaming
 * seam (`handleOpenAIRequest` → `forwardCompletionsAsAnthropicMessages` →
 * `handleCrossModeStreamingResponse`, source `anthropic-messages`).
 *
 * This route had **no** streaming test at all: `gemini-responses-cross-mode-stream`
 * drives the `openai-responses` source only, and `interactions-stream-events`
 * exercises the emitter directly. Both defects pinned here live exactly in that
 * gap, which is why they shipped.
 *
 * - Finding #3: the terminal frames (`step.stop` + `interaction.completed` +
 *   usage) are never written, because `message_stop` deletes the per-request
 *   Interactions state and `finishInteractionsStream` is the only writer of those
 *   frames.
 * - Finding #4: a stream truncated before its finish reason is announced as
 *   `status: "completed"` whenever a frame happened to carry usage, because
 *   `interactionStreamEnded` — the sole input to the truncation guard — is driven
 *   by any usage-bearing frame rather than by the finish reason.
 *
 * Both are unfixed at the time of writing, so the first and second case below are
 * expected to fail until they are; the third pins the half that is already right.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleOpenAIRequest } from '../../src/handlers/openai.js';
import { createLogger, type Logger } from '../../src/utils/logger.js';

const LOGGER = createLogger({});
const ENV = {} as any;
const TARGET = 'https://upstream.example/v1/messages';
const AUTH = { 'x-api-key': 'upstream-key' };
const MODEL = 'gemini-3-flash-preview';

/** The Interactions front door; this endpoint reads `stream` off the body. */
function interactionsRequest(): Request {
  return new Request('https://proxy.test/v1/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      input: [{ type: 'user_input', content: 'hi' }],
      stream: true,
    }),
  });
}

/** An Anthropic SSE answer, one `data:` frame per event. */
function anthropicStream(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A complete Anthropic turn: thinking-free text, a finish reason, the sentinel. */
function textTurn(): Array<Record<string, unknown>> {
  return [
    { type: 'message_start', message: { id: 'msg_01ABC', usage: { input_tokens: 5, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi there' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } },
    { type: 'message_stop' },
  ];
}

/** The same turn cut off before `message_delta` — the upstream never stated a finish reason. */
function truncatedTurn(withUsage: boolean): Array<Record<string, unknown>> {
  return [
    { type: 'message_start', message: { id: 'msg_01ABC', ...(withUsage ? { usage: { input_tokens: 11, output_tokens: 1 } } : {}) } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
  ];
}

/** Every outbound SSE frame, parsed, with its `event:` line checked against `event_type`. */
function parseFrames(text: string): Array<Record<string, any>> {
  return text.split('\n\n').filter(block => block.trim() !== '').map(block => {
    const lines = block.split('\n');
    const dataLine = lines.find(line => line.startsWith('data: '));
    assert.ok(dataLine, `every outbound frame must carry data, got: ${block}`);
    const frame = JSON.parse(dataLine.slice(6));
    assert.equal(lines[0], `event: ${frame.event_type}`,
      `an Interactions frame must be announced by its own event_type, got: ${block}`);
    return frame;
  });
}

describe('/v1/interactions ← anthropic-messages: the SSE egress', () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  async function run(
    events: Array<Record<string, unknown>>,
    logger: Logger = LOGGER,
  ): Promise<Array<Record<string, any>>> {
    globalThis.fetch = (async () => anthropicStream(events)) as typeof fetch;
    const response = await handleOpenAIRequest(
      interactionsRequest(), TARGET, AUTH, 'r-interactions', MODEL, ENV, logger,
      undefined, undefined, 'anthropic-messages',
    );
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    return parseFrames(await response.text());
  }

  /**
   * Read a stream that is expected to be aborted, returning whatever whole frames
   * reached the client before the failure.
   */
  async function readUntilAborted(events: Array<Record<string, unknown>>, requestId: string): Promise<string> {
    globalThis.fetch = (async () => anthropicStream(events)) as typeof fetch;
    const response = await handleOpenAIRequest(
      interactionsRequest(), TARGET, AUTH, requestId, MODEL, ENV, LOGGER,
      undefined, undefined, 'anthropic-messages',
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

  it('closes the interaction: step.stop and interaction.completed, both carrying the usage', async () => {
    const frames = await run(textTurn());

    // The answer's two terminal frames, in order. Nothing may follow the completed
    // interaction, which is why the pair — not just the last frame — is asserted.
    assert.deepEqual(frames.slice(-2).map(frame => frame.event_type), ['step.stop', 'interaction.completed'],
      'a finished Anthropic turn must end the interaction — review_fixes.md #3 (message_stop deleted the state first)');

    // Anthropic reports `input_tokens` with both cache fields excluded, so the
    // mapped total is the sum of the three; here there are no cache fields.
    const expectedUsage = { total_input_tokens: 5, total_output_tokens: 12, total_tokens: 17 };
    assert.deepEqual(frames[frames.length - 2].usage, expectedUsage, 'the closing step carries the usage');
    assert.deepEqual(frames[frames.length - 1].interaction.usage, expectedUsage, 'so does the completed interaction');

    // The step the deltas built is the one the closing interaction publishes.
    assert.equal(frames[frames.length - 1].interaction.status, 'completed');
    assert.deepEqual(frames[frames.length - 1].interaction.steps, [
      { type: 'model_output', content: [{ type: 'text', text: 'hi there' }] },
    ]);
  });

  it('still carries the answer text before the terminal frames', async () => {
    const frames = await run(textTurn());

    const textDeltas = frames.filter(frame => frame.event_type === 'step.delta')
      .map(frame => frame.delta)
      .filter(delta => delta?.type === 'text');
    assert.deepEqual(textDeltas, [{ type: 'text', text: 'hi there' }],
      'the fix for #3 must not come at the cost of the answer frames');
    assert.equal(frames[0].event_type, 'interaction.created');
  });

  it('refuses a truncated turn that never stated a finish reason, even when it carried usage', async () => {
    // This is the #4 case: `message_start` reports usage, so `ended` is set before
    // any finish reason exists and the truncation guard passes. A stream whose only
    // difference from the next test is the presence of a usage object must not end
    // any differently.
    const seen = await readUntilAborted(truncatedTurn(true), 'r-truncated-with-usage');

    assert.equal(seen.includes('interaction.completed'), false,
      'a truncated answer must not be announced as a completed interaction — review_fixes.md #4');
    assert.equal(seen.includes('"status":"completed"'), false,
      'nor may any frame claim the interaction completed');
  });

  it('refuses the same truncated turn when no usage was reported', async () => {
    // Already correct today: with no usage object, `ended` stays unset and the guard
    // throws. Pinned so the two truncation cases cannot diverge again.
    const seen = await readUntilAborted(truncatedTurn(false), 'r-truncated-no-usage');

    assert.equal(seen.includes('interaction.completed'), false);
    assert.equal(seen.includes('"status":"completed"'), false);
  });

  it('reports a tool call the upstream sent without a name, and still closes the interaction', async () => {
    // #17: the nameless call was skipped with no log, so this dialect sent the
    // client nothing at all — HTTP 200, a clean close, and no way to tell the model
    // had asked for a tool.
    const warnings: string[] = [];
    const noop = (): void => {};
    const logger: Logger = {
      traceEnabled: false,
      trace: noop, debug: noop, info: noop, error: noop,
      warn: (_requestId: string, message: string) => { warnings.push(message); },
    };

    const frames = await run([
      { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 5, output_tokens: 0 } } },
      {
        type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'toolu_9', name: '', input: {} },
      },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' },
    ], logger);

    // No call is announced — a `function_call` step needs a name (the SDK declares
    // it Required) — and the stream is not left empty: it closes the interaction.
    assert.equal(frames.some(frame => frame.step?.type === 'function_call'), false);
    assert.equal(frames.some(frame => frame.delta?.type === 'function_call'), false);
    assert.equal(frames.at(-1)?.event_type, 'interaction.completed',
      'the client must still get a terminal frame, not an empty stream');
    assert.equal(frames.at(-1)?.interaction?.status, 'completed');

    assert.match(warnings.join('\n'), /toolu_9/, 'the dropped call must be reported by id');
  });

  it('emits thought_signature deltas and keeps each signature on its closing thought step', async () => {
    const frames = await run([
      { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'first thought' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-a' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'signature_delta', signature: 'sig-b' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'answer' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } },
      { type: 'message_stop' },
    ]);

    assert.deepEqual(
      frames.filter(frame => frame.delta?.type === 'thought_signature').map(frame => ({
        index: frame.index, delta: frame.delta,
      })),
      [
        { index: 0, delta: { type: 'thought_signature', signature: 'sig-a' } },
        { index: 1, delta: { type: 'thought_signature', signature: 'sig-b' } },
      ],
    );
    assert.deepEqual(frames.at(-1)?.interaction.steps, [
      { type: 'thought', summary: [{ type: 'text', text: 'first thought' }], signature: 'sig-a' },
      { type: 'thought', summary: [], signature: 'sig-b' },
      { type: 'model_output', content: [{ type: 'text', text: 'answer' }] },
    ]);
  });
});
