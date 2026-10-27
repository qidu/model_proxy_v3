import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { wrapSseStreamWithKeepAlive } from '../../src/utils/sse-keepalive.js';

function streamFromChunks(chunks: string[], delayMs = 0): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      for (const chunk of chunks) {
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe('wrapSseStreamWithKeepAlive', () => {
  it('relays chunks unchanged when they arrive faster than the interval', async () => {
    const source = streamFromChunks([
      'event: message_start\ndata: {}\n\n',
      'event: message_stop\ndata: {}\n\n',
    ]);
    const text = await streamToText(wrapSseStreamWithKeepAlive(source, 60_000));
    assert.equal(text, 'event: message_start\ndata: {}\n\nevent: message_stop\ndata: {}\n\n');
  });

  it('injects a ping comment after the silence interval', async () => {
    // One chunk, then silence long enough for at least one ping, then close.
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(encoder.encode('data: first\n\n'));
        await new Promise(resolve => setTimeout(resolve, 150));
        controller.enqueue(encoder.encode('data: second\n\n'));
        controller.close();
      },
    });
    const text = await streamToText(wrapSseStreamWithKeepAlive(source, 50));
    assert.ok(text.includes('data: first\n\n'), 'first chunk forwarded');
    assert.ok(text.includes('data: second\n\n'), 'second chunk forwarded');
    assert.ok(text.includes(': ping\n\n'), 'ping injected during silence');
    // The ping must land between the two data chunks.
    assert.ok(text.indexOf('data: first') < text.indexOf(': ping'));
    assert.ok(text.indexOf(': ping') < text.indexOf('data: second'));
  });

  it('closes when the source closes and stops the timer', async () => {
    const source = streamFromChunks(['data: x\n\n']);
    const text = await streamToText(wrapSseStreamWithKeepAlive(source, 20));
    assert.equal(text, 'data: x\n\n');
  });

  it('propagates source errors to the consumer', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('upstream died'));
      },
    });
    await assert.rejects(streamToText(wrapSseStreamWithKeepAlive(source, 20)), /upstream died/);
  });
});
