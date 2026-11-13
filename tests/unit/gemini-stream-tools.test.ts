import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createGeminiStreamTransformer } from '../../src/converters/gemini-streaming.js';

/**
 * Native generateContent SSE -> Claude SSE coverage for tool calls.
 * `handleNativeGeminiChunk` is internal; it is exercised through the exported
 * transform stream with canned Gemini chunks.
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

describe('createGeminiStreamTransformer — native functionCall', () => {
  it('emits a complete tool_use block and stops the turn for tool_use', async () => {
    const events = await convert([
      {
        candidates: [{
          content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: '杭州' } } }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8 },
      },
    ]);

    const start = events.find(e => e.event === 'content_block_start')!;
    assert.equal(start.data.index, 0);
    assert.equal(start.data.content_block.type, 'tool_use');
    assert.equal(start.data.content_block.name, 'get_weather');
    assert.deepEqual(start.data.content_block.input, {}, 'input arrives through input_json_delta');
    assert.match(start.data.content_block.id, /^tool_\d+_0$/);

    const delta = events.find(e => e.event === 'content_block_delta')!;
    assert.equal(delta.data.index, 0);
    assert.equal(delta.data.delta.type, 'input_json_delta');
    assert.deepEqual(JSON.parse(delta.data.delta.partial_json), { city: '杭州' });

    const stops = events.filter(e => e.event === 'content_block_stop');
    assert.deepEqual(stops.map(e => e.data.index), [0], 'exactly one stop, for the tool block');

    const messageDelta = events.find(e => e.event === 'message_delta')!;
    assert.equal(messageDelta.data.delta.stop_reason, 'tool_use');
    assert.deepEqual(messageDelta.data.usage, { input_tokens: 20, output_tokens: 8 });
  });

  it('does not open a spurious text block for a tool-only chunk', async () => {
    const events = await convert([
      {
        candidates: [{
          content: { role: 'model', parts: [{ functionCall: { name: 'f', args: {} } }] },
          finishReason: 'STOP',
        }],
      },
    ]);

    const startTypes = events
      .filter(e => e.event === 'content_block_start')
      .map(e => e.data.content_block.type);
    assert.deepEqual(startTypes, ['tool_use']);
  });

  it("carries the upstream functionCall.id instead of minting one", async () => {
    const events = await convert([
      {
        candidates: [{
          content: { role: 'model', parts: [{ functionCall: { id: 'gemini-call-7', name: 'get_weather', args: { city: 'sf' } } }] },
          finishReason: 'STOP',
        }],
      },
    ]);

    const start = events.find(e => e.event === 'content_block_start')!;
    assert.equal(start.data.content_block.type, 'tool_use');
    assert.equal(start.data.content_block.id, 'gemini-call-7', "the upstream's own id wins over the minted one");
  });

  it('closes the open text block, then places the tool block at the next index', async () => {
    const events = await convert([
      {
        candidates: [{
          content: { role: 'model', parts: [{ text: 'checking' }] },
          finishReason: null,
        }],
      },
      {
        candidates: [{
          content: { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: '杭州' } } }] },
          finishReason: 'STOP',
        }],
      },
    ]);

    const blocks = events
      .filter(e => e.event === 'content_block_start')
      .map(e => ({ index: e.data.index, type: e.data.content_block.type }));
    assert.deepEqual(blocks, [
      { index: 0, type: 'text' },
      { index: 1, type: 'tool_use' },
    ]);

    const textDelta = events.find(e => e.event === 'content_block_delta')!;
    assert.equal(textDelta.data.index, 0);
    assert.deepEqual(textDelta.data.delta, { type: 'text_delta', text: 'checking' });

    const toolDelta = events.filter(e => e.event === 'content_block_delta')[1];
    assert.equal(toolDelta.data.index, 1);
    assert.equal(toolDelta.data.delta.type, 'input_json_delta');

    const stops = events.filter(e => e.event === 'content_block_stop').map(e => e.data.index);
    assert.deepEqual(stops, [0, 1], 'text block closes before the tool block starts');

    const messageDelta = events.find(e => e.event === 'message_delta')!;
    assert.equal(messageDelta.data.delta.stop_reason, 'tool_use');
  });

  it('still reports end_turn and a single text block for a plain text stream', async () => {
    const events = await convert([
      {
        candidates: [{ content: { role: 'model', parts: [{ text: 'hel' }] }, finishReason: null }],
      },
      {
        candidates: [{ content: { role: 'model', parts: [{ text: 'lo' }] }, finishReason: 'STOP' }],
      },
    ]);

    const starts = events.filter(e => e.event === 'content_block_start');
    assert.equal(starts.length, 1, 'the text block opens once and stays open across chunks');
    const textDeltas = events.filter(e => e.event === 'content_block_delta');
    assert.deepEqual(textDeltas.map(e => e.data.delta.text), ['hel', 'lo']);

    const stops = events.filter(e => e.event === 'content_block_stop');
    assert.deepEqual(stops.map(e => e.data.index), [0]);

    const messageDelta = events.find(e => e.event === 'message_delta')!;
    assert.equal(messageDelta.data.delta.stop_reason, 'end_turn');
  });

  it('reports max_tokens when MAX_TOKENS arrives with no tool call', async () => {
    const events = await convert([
      { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' }] },
    ]);
    const messageDelta = events.find(e => e.event === 'message_delta')!;
    assert.equal(messageDelta.data.delta.stop_reason, 'max_tokens');
  });
});
