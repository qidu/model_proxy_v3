/**
 * `/v1/interactions` (and `/v1/messages`) over a Gemini `:streamGenerateContent`
 * upstream: the client gets the dialect it asked in.
 *
 * These are the regression pins for the streaming egress, which had no working
 * conversion at all: the handler wrapped a `TransformStream` in a second
 * `TransformStream`, and since an instance exposes only `readable`/`writable`,
 * the wrapper had no `transform` and passed every byte through. Both a
 * `/v1/interactions` client and a Claude client therefore received the upstream's
 * own `{candidates:[…]}` chunks, whatever they had asked for.
 *
 * So each of the three dialects is pinned here, because they are the reason the
 * egress cannot be a single transformer: a native client reads generateContent
 * framing, a `/v1/messages` client reads Claude events, and this one reads
 * `event_type` events. The last two blocks pin the events themselves — the
 * sequence, the indices, and that a stream ending without a `finishReason` fails
 * loudly rather than closing as a finished interaction.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleGeminiRequest, handleGeminiRequestForMessages } from '../../src/handlers/gemini.js';
import { createInteractionsStreamTransformer } from '../../src/converters/gemini-streaming.js';

const ENV = { LOG_LEVEL: 'error' } as any;
const STREAM_URL = 'https://upstream.example/v1beta/models/gemini-test:streamGenerateContent?alt=sse';
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** The upstream chunks: text split across two, then a call and a finish reason. */
const UPSTREAM_SSE = [
  'data: {"responseId":"UPSTREAM-ID","candidates":[{"content":{"role":"model","parts":[{"text":"Hi"}]}}]}',
  'data: {"candidates":[{"content":{"role":"model","parts":[{"text":" there"},{"functionCall":{"id":"c1","name":"f","args":{"a":1}}}]},"finishReason":"MAX_TOKENS"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"totalTokenCount":7}}',
].join('\n\n') + '\n\n';

function stubSse(sse: string): void {
  globalThis.fetch = (async () => new Response(sse, {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  })) as typeof fetch;
}

/** Send a streaming `/v1/interactions` request and return the client's SSE text. */
async function interactionsStream(): Promise<string> {
  const response = await handleGeminiRequest(
    new Request('http://proxy/v1/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-test', input: 'hi', stream: true }),
    }),
    STREAM_URL, { 'x-goog-api-key': 'k' }, 'req-stream', 'gemini-test', ENV,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  return await response.text();
}

/** The parsed payloads of an SSE body, in order. */
function eventsOf(sse: string): any[] {
  return sse.split('\n\n')
    .map(message => message.split('\n').find(line => line.startsWith('data: ')))
    .filter((line): line is string => line !== undefined)
    .map(line => JSON.parse(line.slice(6)));
}

describe('/v1/interactions streaming → Interactions events', () => {
  it('renders the upstream chunks as event_type events, not as candidates chunks', async () => {
    stubSse(UPSTREAM_SSE);
    const events = eventsOf(await interactionsStream());

    assert.deepEqual(
      events.map(event => event.event_type),
      ['interaction.start', 'content.start', 'content.delta', 'content.delta', 'content.stop',
        'content.start', 'content.stop', 'interaction.complete'],
    );
    // The pin for the wrapper bug: none of the upstream's own framing may survive.
    assert.equal(JSON.stringify(events).includes('"candidates"'), false, 'a raw upstream chunk reached the client');
  });

  it('streams text as deltas into one content, then the call as its own content', async () => {
    stubSse(UPSTREAM_SSE);
    const events = eventsOf(await interactionsStream());

    assert.deepEqual(events.filter(e => e.event_type === 'content.delta'), [
      { event_type: 'content.delta', index: 0, delta: { type: 'text', text: 'Hi' } },
      { event_type: 'content.delta', index: 0, delta: { type: 'text', text: ' there' } },
    ]);
    // The call is one content that opens and closes at once, at the next index.
    assert.deepEqual(events[5], {
      event_type: 'content.start',
      index: 1,
      content: { type: 'function_call', name: 'f', arguments: { a: 1 }, id: 'c1' },
    });
    assert.deepEqual(events[6], { event_type: 'content.stop', index: 1 });
  });

  it('closes with the interaction the non-streaming egress would have produced', async () => {
    stubSse(UPSTREAM_SSE);
    const events = eventsOf(await interactionsStream());
    const complete = events.at(-1);

    assert.equal(complete.event_type, 'interaction.complete');
    // The upstream's own id identifies the interaction from start to completion.
    assert.equal(events[0].interaction.id, 'UPSTREAM-ID');
    assert.equal(complete.interaction.id, events[0].interaction.id);
    assert.deepEqual(complete.interaction.outputs, [
      { type: 'text', text: 'Hi there' },
      { type: 'function_call', name: 'f', arguments: { a: 1 }, id: 'c1' },
    ]);
    assert.equal(complete.interaction.status, 'failed');
    assert.match(complete.interaction.error.code, /#FinishReason\.MAX_TOKENS$/);
    assert.deepEqual(complete.interaction.usage, {
      total_input_tokens: 3, total_output_tokens: 4, total_tokens: 7,
    });
  });

  it('names a minted call once, in the streamed content and in the closing interaction', async () => {
    // The closing conversion runs over the accumulated parts again, at their own
    // indices, so a call the upstream sent without an id (Gemini omits one often)
    // used to be announced as `call_0` and then reported as `call_1` — and two of
    // them were announced as `call_0` twice. The thought part puts the calls at
    // positions 1 and 2.
    stubSse([
      'data: {"candidates":[{"content":{"role":"model","parts":[{"thought":true,"text":"hmm"}]}}]}',
      'data: {"candidates":[{"content":{"role":"model","parts":[{"functionCall":{"name":"f","args":{"a":1}}},{"functionCall":{"name":"g","args":{"b":2}}}]},"finishReason":"STOP"}]}',
    ].join('\n\n') + '\n\n');
    const events = eventsOf(await interactionsStream());

    const announced = events
      .filter(e => e.event_type === 'content.start' && e.content.type === 'function_call')
      .map(e => e.content.id);
    const complete = events.at(-1).interaction.outputs
      .filter((o: any) => o.type === 'function_call')
      .map((o: any) => o.id);

    assert.deepEqual(announced, ['call_1', 'call_2'], 'a minted id is the call’s position in the answer');
    assert.deepEqual(complete, announced, 'the stream and the closing interaction must agree');
  });

  it('states a withheld answer as a failed interaction', async () => {
    stubSse('data: {"candidates":[{"finishReason":"SAFETY"}],"promptFeedback":{"blockReason":"SAFETY"}}\n\n');
    const events = eventsOf(await interactionsStream());
    const complete = events.at(-1);

    assert.equal(complete.interaction.status, 'failed');
    assert.match(complete.interaction.error.code, /#BlockReason\.SAFETY$/);
    assert.deepEqual(complete.interaction.outputs, []);
  });
});

describe('/v1/interactions streaming — the other two dialects are unaffected', () => {
  it('renders Claude events for a /v1/messages client', async () => {
    stubSse(UPSTREAM_SSE);
    const response = await handleGeminiRequestForMessages(
      new Request('http://proxy/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'm', max_tokens: 16, stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      }),
      STREAM_URL, {}, 'req-messages-stream', 'gemini-test', ENV,
    );
    const text = await response.text();

    assert.ok(text.includes('event: message_start'), 'a Claude client must receive Claude framing');
    assert.ok(text.includes('event: message_stop'));
    assert.equal(text.includes('"candidates"'), false, 'a raw upstream chunk reached a Claude client');
  });

  it('relays the upstream framing unchanged for a native client', async () => {
    stubSse(UPSTREAM_SSE);
    const response = await handleGeminiRequest(
      new Request('http://proxy/v1beta/models/gemini-test:streamGenerateContent?alt=sse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], stream: true }),
      }),
      STREAM_URL, { 'x-goog-api-key': 'k' }, 'req-native-stream', 'gemini-test', ENV,
    );

    const events = eventsOf(await response.text());
    assert.equal(events[0].candidates[0].content.parts[0].text, 'Hi');
    assert.equal('event_type' in events[0], false);
  });
});

describe('createInteractionsStreamTransformer — a truncated upstream stream', () => {
  it('fails loudly when the stream ends without a finishReason', async () => {
    // A finished interaction is announced by `interaction.complete`; an EOF before
    // one is a truncated stream, and reporting it as complete would hide the loss.
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"partial"}]}}]}\n\n',
        ));
        controller.close();
      },
    });

    await assert.rejects(
      () => new Response(source.pipeThrough(createInteractionsStreamTransformer('m', 'req-eof'))).text(),
      /ended before a finishReason/,
    );
  });
});
