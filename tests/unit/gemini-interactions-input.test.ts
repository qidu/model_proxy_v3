/**
 * `/v1/interactions` → native Gemini: the shapes an `input` array may take.
 *
 * The spec this repo bundles (`docs/api/interactions.md`) types `input` as an
 * array of Turns (`role`) or an array of Content (a part list). A client may
 * also send an array of *steps* discriminated by `type` — `user_input` and
 * `model_output` — where the step's `type` stands in for a Turn's `role`. A
 * `model_output` step is the model's own earlier turn, so it has to reach the
 * upstream as `role: 'model'`; before this it fell through to the array-of-Content
 * branch, which flattens every item into one `role: 'user'` content and thus
 * replays the model's turns as client input.
 *
 * The step and Turn shapes share one content extraction (string | parts array |
 * anything else stringified), and the Content shape must keep its single-content
 * output, so each shape is pinned here — the step cases fail on the old mapping,
 * the others would fail if the new branch hijacked their arrays.
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

/** Send `input` to `/v1/interactions` through the native Gemini handler. */
async function contentsFor(input: unknown): Promise<any[]> {
  const { bodies } = stubUpstream();

  const response = await handleGeminiRequest(
    new Request('http://proxy/v1/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gemini-test', input }),
    }),
    UPSTREAM_URL,
    { 'x-goog-api-key': 'upstream-key' },
    'req-interactions-input',
    'gemini-test',
    ENV,
  );

  assert.equal(response.status, 200);
  assert.equal(bodies.length, 1, 'the proxy must send exactly one upstream request');
  return bodies[0].contents;
}

describe('/v1/interactions input array shapes → generateContent contents', () => {
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

  it('does not throw on an empty input array', async () => {
    const contents = await contentsFor([]);

    assert.deepEqual(contents, [{ role: 'user', parts: [] }]);
  });
});
