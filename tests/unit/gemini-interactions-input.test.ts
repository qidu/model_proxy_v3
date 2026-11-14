/**
 * `/v1/interactions` → native Gemini: the shapes an `input` array may take, and
 * the shapes that have no `contents` at all.
 *
 * The spec this repo bundles (`docs/api/interactions.md`) types `input` as a
 * single Content, an array of Turns (`role`) or an array of Content (a part
 * list). A client may also send an array of *steps* discriminated by `type` —
 * `user_input` and `model_output` — where the step's `type` stands in for a
 * Turn's `role`. A `model_output` step is the model's own earlier turn, so it has
 * to reach the upstream as `role: 'model'`; before the step branch existed it
 * fell through to the array-of-Content branch, which flattens every item into one
 * `role: 'user'` content and thus replays the model's turns as client input.
 *
 * The mapping moved out of the handler into `converters/interactions-to-gemini.ts`
 * when the empty-`contents` cases were fixed: an unrecognized shape used to be
 * sent upstream as `contents: []`, and `input: []` as a content with an empty
 * `parts` array, so the client received the upstream's complaint about a field it
 * never wrote. Both are refused here now with a 400 naming the field, which is
 * what the last two cases below pin.
 *
 * The converter's own tables (tools, `generation_config`, part kinds) are pinned
 * in `tests/unit/interactions-to-gemini.test.ts`; this file keeps the front-door
 * shapes on the real handler.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleGeminiRequest } from '../../src/handlers/gemini.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const ENV = { LOG_LEVEL: 'error' } as any;
const UPSTREAM_URL = 'https://upstream.example/v1beta/models/gemini-test:generateContent';

/** Stub the upstream, keeping the body of every request the proxy sent. */
function stubUpstream(): { bodies: any[] } {
  const bodies: any[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    // A real fetch consumes the request body; the egress body is a stream even
    // when the spool is disabled, so read it rather than assume a string.
    const body = init?.body;
    const text = body instanceof ReadableStream
      ? await new Response(body).text()
      : typeof body === 'string' ? body : '';
    bodies.push(text === '' ? undefined : JSON.parse(text));
    return new Response(JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  return { bodies };
}

/** Send `body` to `/v1/interactions` through the native Gemini handler. */
async function send(body: Record<string, unknown>): Promise<{ status: number; clientBody: any; upstream: any[] }> {
  const { bodies } = stubUpstream();

  const response = await handleGeminiRequest(
    new Request('http://proxy/v1/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-test', ...body }),
    }),
    UPSTREAM_URL,
    { 'x-goog-api-key': 'upstream-key' },
    'req-interactions-input',
    'gemini-test',
    ENV,
  );

  return { status: response.status, clientBody: await response.json(), upstream: bodies };
}

/** The `contents` the proxy sent upstream, for a request that must succeed. */
async function contentsFor(input: unknown): Promise<any[]> {
  const { status, upstream } = await send({ input });
  assert.equal(status, 200);
  assert.equal(upstream.length, 1, 'the proxy must send exactly one upstream request');
  return upstream[0].contents;
}

describe('/v1/interactions input shapes → generateContent contents', () => {
  it('maps input steps one content per step, model_output to the model role', async () => {
    const contents = await contentsFor([
      { type: 'user_input', content: [{ type: 'text', text: 'hi' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'hello' }] },
      { type: 'user_input', content: [{ type: 'text', text: 'again' }] },
    ]);

    assert.deepEqual(contents, [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
      { role: 'user', parts: [{ text: 'again' }] },
    ]);
  });

  it('takes a step whose content is a bare string', async () => {
    const contents = await contentsFor([{ type: 'model_output', content: 'hello' }]);

    assert.deepEqual(contents, [{ role: 'model', parts: [{ text: 'hello' }] }]);
  });

  it('leaves the Turn array shape alone', async () => {
    const contents = await contentsFor([
      { role: 'user', content: 'hi' },
      { role: 'model', content: 'hello' },
    ]);

    assert.deepEqual(contents, [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ]);
  });

  it('leaves the Content array shape as a single user content', async () => {
    const contents = await contentsFor([
      { type: 'text', text: 'hi' },
      { type: 'text', text: 'there' },
    ]);

    assert.deepEqual(contents, [{ role: 'user', parts: [{ text: 'hi' }, { text: 'there' }] }]);
  });

  it('takes a single Content as one user content', async () => {
    // The spec's union allows a bare Content (`docs/api/interactions.md:24`); it
    // used to fall through every branch and reach the upstream as `contents: []`.
    const contents = await contentsFor({ type: 'text', text: 'hi' });

    assert.deepEqual(contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);
  });

  it('takes a single Turn as one content of its own role', async () => {
    const contents = await contentsFor({ role: 'model', content: 'hello' });

    assert.deepEqual(contents, [{ role: 'model', parts: [{ text: 'hello' }] }]);
  });

  it('sends an image part as inline_data, keeping its declared mime type', async () => {
    const contents = await contentsFor([
      { type: 'text', text: 'what is this?' },
      { type: 'image', data: 'aGk=', mime_type: 'image/png' },
    ]);

    assert.deepEqual(contents, [{
      role: 'user',
      parts: [
        { text: 'what is this?' },
        { inline_data: { mime_type: 'image/png', data: 'aGk=' } },
      ],
    }]);
  });

  it('sends a function_call part as functionCall, keeping its id and arguments', async () => {
    const contents = await contentsFor([
      { type: 'function_call', id: 'call_1', name: 'get_weather', arguments: { location: 'Boston' } },
    ]);

    assert.deepEqual(contents, [{
      role: 'user',
      parts: [{ functionCall: { id: 'call_1', name: 'get_weather', args: { location: 'Boston' } } }],
    }]);
  });

  it('refuses an input array that carries no content', async () => {
    // Pinned as a 400 rather than `[{role:'user', parts:[]}]`: the empty content
    // is what the upstream answers with an error naming `contents`, a field the
    // client never wrote.
    await assert.rejects(
      () => contentsFor([]),
      (error: Error) => error.name === 'ValidationError' && /input.*at least one content/.test(error.message),
    );
  });

  it('refuses an unrecognized `input`, naming the plural field a client may have sent', async () => {
    // `inputs` is not this API's field name, and reading only `input` used to send
    // an empty `contents` upstream. It now fails here, where the message can say so.
    await assert.rejects(
      () => contentsFor(undefined),
      (error: Error) => error.name === 'ValidationError' && /`input` must be/.test(error.message),
    );

    await assert.rejects(
      () => send({ inputs: 'hi' }),
      (error: Error) => error.name === 'ValidationError' && /`input` must be/.test(error.message),
    );
  });
});
