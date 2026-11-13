import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { handleChatCompletionsPassthrough } from '../../src/handlers/chat-completions.js';
import { createLogger } from '../../src/utils/logger.js';

/**
 * End-to-end coverage for the gemini-generatecontent cross-mode route in the
 * chat-completions handler. Exercises both the non-streaming response chain
 * and the streaming SSE transformer with a stubbed fetch returning canned
 * Gemini output.
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

function geminiNonStreamResponse(text: string, status = 200): Response {
  return new Response(JSON.stringify({
    candidates: [{
      content: { role: 'model', parts: [{ text }] },
      finishReason: 'STOP',
      index: 0,
    }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
  }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function geminiStreamResponse(textChunks: string[]): Response {
  const encoder = new TextEncoder();
  const parts = textChunks.map(t =>
    `data: ${JSON.stringify({
      candidates: [{ content: { role: 'model', parts: [{ text: t }] }, finishReason: null }],
    })}\n\n`,
  );
  parts.push(`data: ${JSON.stringify({
    candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
  })}\n\n`);
  const stream = new ReadableStream({
    start(controller) {
      for (const p of parts) controller.enqueue(encoder.encode(p));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/**
 * A Gemini SSE stream whose turn ends in a function call: one text chunk, then
 * a chunk carrying the complete functionCall together with finishReason STOP
 * and the turn's usageMetadata (the shape a real :streamGenerateContent emits).
 */
function geminiToolCallStreamResponse(callId?: string): Response {
  const encoder = new TextEncoder();
  const events = [
    { candidates: [{ content: { role: 'model', parts: [{ text: 'Checking.' }] }, finishReason: null }] },
    {
      candidates: [{
        content: {
          role: 'model',
          parts: [{ functionCall: { ...(callId ? { id: callId } : {}), name: 'get_weather', args: { city: 'sf' } } }],
        },
        finishReason: 'STOP',
      }],
      usageMetadata: { promptTokenCount: 31, candidatesTokenCount: 17, totalTokenCount: 48 },
    },
  ].map(e => `data: ${JSON.stringify(e)}\n\n`);
  const stream = new ReadableStream({
    start(controller) {
      for (const p of events) controller.enqueue(encoder.encode(p));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function parseSSE(text: string): { chunks: any[]; raw: string[] } {
  const raw = text.split('\n\n').filter(s => s.startsWith('data: ')).map(s => s.slice(6));
  return { chunks: raw.filter(s => s !== '[DONE]').map(s => JSON.parse(s)), raw };
}

/** A Gemini SSE stream with a thought part and a finishReason OpenAI has no name for. */
function geminiThoughtAndUnknownFinishStreamResponse(): Response {
  const encoder = new TextEncoder();
  const events = [
    { candidates: [{ content: { role: 'model', parts: [{ thought: true, text: 'thinking' }] }, finishReason: null }] },
    { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] },
  ].map(e => `data: ${JSON.stringify(e)}\n\n`);
  const stream = new ReadableStream({
    start(controller) {
      for (const p of events) controller.enqueue(encoder.encode(p));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Collects the handler's warnings so the fail-loud (Rule #8) path can be asserted. */
function recordingLogger(): { logger: any; warnings: string[] } {
  const warnings: string[] = [];
  const noop = () => {};
  return {
    warnings,
    logger: {
      traceEnabled: false,
      trace: noop, debug: noop, info: noop,
      warn: (_requestId: string, message: string) => { warnings.push(message); },
      error: (_requestId: string, message: string) => { warnings.push(message); },
    },
  };
}

describe('handleChatCompletionsPassthrough — gemini-generatecontent cross-mode', () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });

  it('non-streaming: converts OpenAI body to Gemini, response back to completions JSON', async () => {
    let capturedBody: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return geminiNonStreamResponse('hello world');
    }) as typeof fetch;

    const req = makeRequest({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const res = await handleChatCompletionsPassthrough(
      req, 'https://upstream/v1beta/models/gemini-2.0-flash:generateContent',
      { Authorization: 'Bearer k' }, 'rid-1', testLogger, env, 'gemini-2.0-flash', 'gemini-generatecontent',
    );

    assert.equal(res.status, 200);
    // Request to upstream carried x-goog-api-key, not Authorization.
    // (capture fetch headers not exposed here; assert body shape instead.)
    assert.deepEqual(capturedBody.contents, [{ role: 'user', parts: [{ text: 'hi' }] }]);

    const json = await res.json();
    assert.equal(json.choices[0].message.content, 'hello world');
  });

  it('non-streaming: data-URI image_url is converted to inline_data', async () => {
    let capturedBody: any;
    globalThis.fetch = (async (_url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return geminiNonStreamResponse('ok');
    }) as typeof fetch;

    const req = makeRequest({
      model: 'g',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,ABC' } },
        ],
      }],
    });
    await handleChatCompletionsPassthrough(
      req, 'https://upstream/v1beta/models/g:generateContent',
      { Authorization: 'Bearer k' }, 'rid-2', testLogger, env, 'g', 'gemini-generatecontent',
    );

    assert.deepEqual(capturedBody.contents[0].parts, [
      { text: 'look' },
      { inline_data: { mime_type: 'image/png', data: 'ABC' } },
    ]);
  });

  it('streaming: emits OpenAI chat.completion.chunk SSE with [DONE] terminator', async () => {
    let capturedUrl = '';
    globalThis.fetch = (async (url: any) => {
      capturedUrl = String(url);
      return geminiStreamResponse(['hel', 'lo']);
    }) as typeof fetch;

    const req = makeRequest({
      model: 'g', messages: [{ role: 'user', content: 'hi' }],
    }, true);
    const res = await handleChatCompletionsPassthrough(
      req, 'https://upstream/v1beta/models/g:generateContent',
      { Authorization: 'Bearer k' }, 'rid-3', testLogger, env, 'g', 'gemini-generatecontent',
    );

    assert.match(capturedUrl, /:streamGenerateContent/);
    assert.match(capturedUrl, /alt=sse/);
    assert.equal(res.headers.get('content-type'), 'text/event-stream');

    const text = await res.text();
    const chunks = text.split('\n\n').filter(s => s.startsWith('data: ')).map(s => s.slice(6));
    const parsed = chunks.filter(s => s !== '[DONE]').map(s => JSON.parse(s));
    const contents = parsed.map((c: any) => c.choices[0]?.delta?.content).filter(Boolean);
    assert.equal(contents.join(''), 'hello');
    // Final chunk carries a finish_reason; then [DONE].
    const lastChunk = parsed[parsed.length - 1];
    assert.equal(lastChunk.choices[0].finish_reason, 'stop');
    assert.equal(chunks[chunks.length - 1], '[DONE]');
  });

  it('streaming: a functionCall becomes an OpenAI tool_calls delta with finish_reason tool_calls', async () => {
    globalThis.fetch = (async () => geminiToolCallStreamResponse()) as typeof fetch;

    const req = makeRequest({
      model: 'g', messages: [{ role: 'user', content: 'weather in sf?' }],
    }, true);
    const res = await handleChatCompletionsPassthrough(
      req, 'https://upstream/v1beta/models/g:generateContent',
      { Authorization: 'Bearer k' }, 'rid-5', testLogger, env, 'g', 'gemini-generatecontent',
    );

    const { chunks, raw } = parseSSE(await res.text());

    // The text part still streams as content, ahead of the call.
    assert.equal(chunks[0].choices[0].delta.content, 'Checking.');

    const toolChunk = chunks.find(c => c.choices[0]?.delta?.tool_calls);
    assert.ok(toolChunk, 'expected a chunk carrying delta.tool_calls');
    const call = toolChunk.choices[0].delta.tool_calls[0];
    assert.equal(call.index, 0);
    assert.match(call.id, /^tool_\d+_0$/);
    assert.equal(call.type, 'function');
    assert.equal(call.function.name, 'get_weather');
    // arguments is the JSON string form of functionCall.args, not the object.
    assert.deepEqual(JSON.parse(call.function.arguments), { city: 'sf' });

    // Gemini says STOP here; the call is what makes this a tool turn.
    const finish = chunks.find(c => c.choices[0]?.finish_reason);
    assert.equal(finish.choices[0].finish_reason, 'tool_calls');
    assert.equal(raw[raw.length - 1], '[DONE]');
  });

  it("streaming: carries the upstream functionCall.id instead of minting one", async () => {
    globalThis.fetch = (async () => geminiToolCallStreamResponse('gemini-call-7')) as typeof fetch;

    const req = makeRequest({
      model: 'g', messages: [{ role: 'user', content: 'weather in sf?' }],
    }, true);
    const res = await handleChatCompletionsPassthrough(
      req, 'https://upstream/v1beta/models/g:generateContent',
      { Authorization: 'Bearer k' }, 'rid-5b', testLogger, env, 'g', 'gemini-generatecontent',
    );

    const { chunks } = parseSSE(await res.text());
    const toolChunk = chunks.find(c => c.choices[0]?.delta?.tool_calls);
    assert.ok(toolChunk, 'expected a chunk carrying delta.tool_calls');
    const call = toolChunk.choices[0].delta.tool_calls[0];
    assert.equal(call.id, 'gemini-call-7', "the upstream's own id wins over the minted one");
    assert.equal(call.function.name, 'get_weather');
  });

  it('streaming: emits the usage chunk when stream_options.include_usage is set', async () => {
    globalThis.fetch = (async () => geminiToolCallStreamResponse()) as typeof fetch;

    const req = makeRequest({
      model: 'g', messages: [{ role: 'user', content: 'hi' }],
      stream_options: { include_usage: true },
    }, true);
    const res = await handleChatCompletionsPassthrough(
      req, 'https://upstream/v1beta/models/g:generateContent',
      { Authorization: 'Bearer k' }, 'rid-6', testLogger, env, 'g', 'gemini-generatecontent',
    );

    const { chunks, raw } = parseSSE(await res.text());

    const usageChunk = chunks.find(c => c.usage);
    assert.ok(usageChunk, 'expected a final usage chunk');
    assert.deepEqual(usageChunk.choices, []);
    assert.deepEqual(usageChunk.usage, { prompt_tokens: 31, completion_tokens: 17, total_tokens: 48 });
    // Usage comes last, before the sentinel.
    assert.equal(chunks[chunks.length - 1], usageChunk);
    assert.equal(raw[raw.length - 1], '[DONE]');
  });

  it('streaming: no usage chunk when the client did not ask for one', async () => {
    globalThis.fetch = (async () => geminiToolCallStreamResponse()) as typeof fetch;

    const req = makeRequest({
      model: 'g', messages: [{ role: 'user', content: 'hi' }],
    }, true);
    const res = await handleChatCompletionsPassthrough(
      req, 'https://upstream/v1beta/models/g:generateContent',
      { Authorization: 'Bearer k' }, 'rid-7', testLogger, env, 'g', 'gemini-generatecontent',
    );

    const { chunks } = parseSSE(await res.text());
    assert.equal(chunks.filter(c => c.usage).length, 0);
    // The finish chunk still reaches the client.
    assert.equal(chunks.find(c => c.choices[0]?.finish_reason).choices[0].finish_reason, 'tool_calls');
  });

  it('streaming: warns with the dropped part kind and the raw unmapped finishReason', async () => {
    globalThis.fetch = (async () => geminiThoughtAndUnknownFinishStreamResponse()) as typeof fetch;
    const { logger, warnings } = recordingLogger();

    const req = makeRequest({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }, true);
    const res = await handleChatCompletionsPassthrough(
      req, 'https://upstream/v1beta/models/g:generateContent',
      { Authorization: 'Bearer k' }, 'rid-8', logger, env, 'g', 'gemini-generatecontent',
    );

    const { chunks } = parseSSE(await res.text());
    // The thought text is not answered as content, so its kind is what must be reported.
    assert.equal(chunks.filter(c => c.choices[0]?.delta?.content).length, 0);
    const log = warnings.join('\n');
    assert.match(log, /dropped thought reply part\(s\)/);
    assert.match(log, /unmapped finishReason "MALFORMED_FUNCTION_CALL", reported as "stop"/);
    // The turn still closes with a finish_reason, so the client is not left hanging.
    assert.equal(chunks.find(c => c.choices[0]?.finish_reason).choices[0].finish_reason, 'stop');
  });

  it('streaming: warns about nothing on a clean text stream', async () => {
    globalThis.fetch = (async () => geminiStreamResponse(['ok'])) as typeof fetch;
    const { logger, warnings } = recordingLogger();

    const req = makeRequest({ model: 'g', messages: [{ role: 'user', content: 'hi' }] }, true);
    await handleChatCompletionsPassthrough(
      req, 'https://upstream/v1beta/models/g:generateContent',
      { Authorization: 'Bearer k' }, 'rid-9', logger, env, 'g', 'gemini-generatecontent',
    );

    assert.deepEqual(warnings, []);
  });

  it('propagates upstream error status unchanged', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'bad' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      })
    ) as typeof fetch;

    const req = makeRequest({
      model: 'g', messages: [{ role: 'user', content: 'hi' }],
    });
    const res = await handleChatCompletionsPassthrough(
      req, 'https://upstream/v1beta/models/g:generateContent',
      { Authorization: 'Bearer k' }, 'rid-4', testLogger, env, 'g', 'gemini-generatecontent',
    );
    assert.equal(res.status, 400);
  });
});
