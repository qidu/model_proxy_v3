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

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

  it('reads upstream only while the consumer is reading', async () => {
    const encoder = new TextEncoder();
    let produced = 0;
    // highWaterMark 0: the source hands over a chunk only when it is read, so the
    // counter is exactly the number of upstream reads the wrapper asked for.
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        produced += 1;
        if (produced > 5) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`data: ${produced}\n\n`));
      },
    }, { highWaterMark: 0 });
    const reader = wrapSseStreamWithKeepAlive(source, 50).getReader();

    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), 'data: 1\n\n');
    assert.equal(produced, 1, 'one upstream chunk per consumer read');

    // A stalled consumer must stop upstream reads (plan §5.7): an unconditional
    // read loop would have pulled the whole remaining response into this queue.
    await delay(200);
    assert.equal(produced, 1, 'no upstream read while no consumer read is pending');

    const rest: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const { value } = await reader.read();
      rest.push(new TextDecoder().decode(value));
    }
    assert.deepEqual(
      rest,
      ['data: 2\n\n', 'data: 3\n\n', 'data: 4\n\n', 'data: 5\n\n'],
      'resuming delivers the remaining frames in order, unchanged and without pings',
    );
    assert.equal(produced, 5, 'the source was drained one read at a time, not eagerly');

    const end = await reader.read();
    assert.equal(end.done, true, 'the wrapper closes when the source closes');
  });

  it('queues at most one ping per silence interval, and only for a waiting consumer', async () => {
    const encoder = new TextEncoder();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: only\n\n'));
      },
      // No close and no pull: stays open and silent, like a pingless upstream
      // between events.
    });
    const reader = wrapSseStreamWithKeepAlive(source, 200).getReader();

    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), 'data: only\n\n');

    // Nobody reads for two and a half intervals. A timer that enqueues pings
    // regardless of demand would have left two of them sitting in the queue.
    await delay(500);

    const ping = await reader.read();
    assert.equal(new TextDecoder().decode(ping.value), ': ping\n\n', 'a due ping is produced on demand');

    const startedAt = Date.now();
    const next = await reader.read();
    const waitedMs = Date.now() - startedAt;
    assert.equal(new TextDecoder().decode(next.value), ': ping\n\n');
    assert.ok(
      waitedMs >= 100,
      `the next ping had to wait a fresh interval (${waitedMs}ms); an immediate read means pings were queued while nobody was reading`,
    );

    await reader.cancel();
  });

  it('delivers an upstream error that arrives while the consumer is stalled', async () => {
    let failUpstream: (error: Error) => void = () => {};
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        failUpstream = error => controller.error(error);
      },
    });
    const reader = wrapSseStreamWithKeepAlive(source, 30).getReader();

    // Nothing to forward: the pull parks an upstream read and emits a ping, so the
    // read outlives the pull that started it.
    const ping = await reader.read();
    assert.equal(new TextDecoder().decode(ping.value), ': ping\n\n');

    await delay(50);
    failUpstream(new Error('upstream died mid-stream'));

    await assert.rejects(reader.read(), /upstream died mid-stream/);
  });
});
