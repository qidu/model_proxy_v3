import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createGeminiStreamTransformer } from '../../src/converters/gemini-streaming.js';

/**
 * Native generateContent SSE -> Claude SSE coverage for thought parts.
 *
 * Gemini reports reasoning as a part with the same `text` field as the answer plus
 * `thought: true`. Before this file's change the transformer streamed such a part
 * to a `/v1/messages` client as `text_delta`, i.e. the reasoning arrived as part of
 * the answer, with no thinking block and no warning. `handleNativeGeminiChunk` is
 * internal; it is exercised through the exported transform stream.
 */

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

function parseSse(text: string): Array<{ event: string; data: any }> {
  return text.trim().split('\n\n').map(message => {
    let event = '';
    let data = '';
    for (const line of message.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      if (line.startsWith('data: ')) data = line.slice(6);
    }
    return { event, data: JSON.parse(data) };
  });
}

function sseStream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const body = chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
}

async function convert(chunks: unknown[]) {
  return parseSse(await streamToText(
    sseStream(chunks).pipeThrough(createGeminiStreamTransformer('gemini-test', 'req-test')),
  ));
}

describe('createGeminiStreamTransformer — thought parts', () => {
  it('counts the model\'s thoughts as output tokens', async () => {
    // Finding #19, streaming half: the thought count reached no Claude client, so a
    // `message_delta` reported less output than the turn billed. Summed for the same
    // reason as the non-streaming egress (`gemini-to-claude.test.ts`).
    const events = await convert([
      {
        candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 41 },
      },
    ]);

    const delta = events.find(e => e.event === 'message_delta')!;
    assert.equal(events.find(e => e.event === 'message_start')!.data.message.stop_sequence, null);
    assert.equal(delta.data.delta.stop_sequence, null);
    assert.deepEqual(delta.data.usage, { input_tokens: 7, output_tokens: 44 });
  });

  it('counts the thoughts too when the upstream reports the Interactions usage shape', async () => {
    // The same helper reads the Interactions `Usage`, where the thought count has a
    // field of its own (`total_thought_tokens`) and must fold the same way.
    const events = await convert([
      {
        event_type: 'interaction.completed',
        interaction: { usage: { total_input_tokens: 11, total_output_tokens: 4, total_thought_tokens: 50 } },
      },
    ]);

    const delta = events.find(e => e.event === 'message_delta')!;
    assert.equal(delta.data.delta.stop_sequence, null);
    assert.deepEqual(delta.data.usage, { input_tokens: 11, output_tokens: 54 });
  });

  it('streams a thought part as a thinking block ahead of the answer', async () => {
    const events = await convert([
      {
        candidates: [{
          content: {
            role: 'model',
            parts: [
              { thought: true, text: 'weighing options', thoughtSignature: 'sig-1' },
              { text: 'answer' },
            ],
          },
          finishReason: 'STOP',
        }],
      },
    ]);

    // The thinking block comes first, at index 0, and is closed — signature
    // before stop — before the answer opens at index 1.
    const starts = events.filter(e => e.event === 'content_block_start');
    assert.deepEqual(starts.map(e => [e.data.index, e.data.content_block.type]), [[0, 'thinking'], [1, 'text']]);

    const deltas = events.filter(e => e.event === 'content_block_delta');
    assert.deepEqual(deltas.map(e => [e.data.index, e.data.delta.type]), [
      [0, 'thinking_delta'],
      [0, 'signature_delta'],
      [1, 'text_delta'],
    ]);
    assert.equal(deltas[0].data.delta.thinking, 'weighing options');
    assert.equal(deltas[1].data.delta.signature, 'sig-1', "the upstream's own thoughtSignature is replayed");
    assert.equal(deltas[2].data.delta.text, 'answer');

    // Every block that opened was closed, in order.
    assert.deepEqual(events.filter(e => e.event === 'content_block_stop').map(e => e.data.index), [0, 1]);
    assert.equal(events.find(e => e.event === 'message_delta')!.data.delta.stop_reason, 'end_turn');
  });

  it('synthesizes a signature when the thought part carries none', async () => {
    const events = await convert([
      {
        candidates: [{
          content: { role: 'model', parts: [{ thought: true, text: 'hmm' }] },
          finishReason: 'STOP',
        }],
      },
    ]);

    const signature = events.find(e => e.data?.delta?.type === 'signature_delta');
    assert.ok(signature, 'Anthropic requires a signature on a thinking block');
    assert.equal(signature!.data.delta.signature, 'synthetic');
  });

  it('closes the thinking block before a tool_use block and reports stop_reason tool_use', async () => {
    const events = await convert([
      {
        candidates: [{
          content: {
            role: 'model',
            parts: [
              { thought: true, text: 'need the weather' },
              { functionCall: { name: 'get_weather', args: { city: '杭州' } } },
            ],
          },
          finishReason: 'STOP',
        }],
      },
    ]);

    const starts = events.filter(e => e.event === 'content_block_start');
    assert.deepEqual(starts.map(e => [e.data.index, e.data.content_block.type]), [[0, 'thinking'], [1, 'tool_use']]);
    assert.deepEqual(events.filter(e => e.event === 'content_block_stop').map(e => e.data.index), [0, 1]);
    assert.equal(events.find(e => e.event === 'message_delta')!.data.delta.stop_reason, 'tool_use');
  });

  it('emits no thinking block for a chunk with no thought parts', async () => {
    const events = await convert([
      {
        candidates: [{
          content: { role: 'model', parts: [{ text: 'plain' }] },
          finishReason: 'STOP',
        }],
      },
    ]);

    const starts = events.filter(e => e.event === 'content_block_start');
    assert.deepEqual(starts.map(e => e.data.content_block.type), ['text']);
  });

  it('warns when STOP may hide a requested stop-sequence match', async () => {
    const warnings: string[] = [];
    const logger = {
      warn: (_requestId: string, message: string) => { warnings.push(message); },
    };
    const events = parseSse(await streamToText(
      sseStream([{
        candidates: [{
          content: { role: 'model', parts: [{ text: 'done' }] },
          finishReason: 'STOP',
        }],
      }]).pipeThrough(createGeminiStreamTransformer('gemini-test', 'req-test', {
        logger: logger as any,
        stopSequences: ['END'],
      })),
    ));

    assert.equal(events.find(e => e.event === 'message_delta')!.data.delta.stop_reason, 'end_turn');
    assert.equal(events.find(e => e.event === 'message_delta')!.data.delta.stop_sequence, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Gemini STOP is ambiguous for a request with stop_sequences/);
    assert.match(warnings[0], /returning stop_reason "end_turn" with stop_sequence null/);
  });
});
