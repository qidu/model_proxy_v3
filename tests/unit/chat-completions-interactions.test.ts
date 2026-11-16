import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';

const realFetch = globalThis.fetch;
let configPath = '';
let upstreamUrl = '';
let upstreamBody: Record<string, unknown> | undefined;
let upstreamHeaders: Headers | undefined;
let upstreamResponse: () => Response;

function interactionResponse(outputs: Array<Record<string, unknown>>, status = 'completed'): Response {
  return new Response(JSON.stringify({
    id: 'int_1',
    model: 'gemini-test',
    status,
    object: 'interaction',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:01.000Z',
    role: 'model',
    outputs,
    usage: { total_input_tokens: 11, total_output_tokens: 5, total_cached_tokens: 3, total_tokens: 16 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function interactionStream(events: Array<Record<string, unknown>>): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function sendChat(body: Record<string, unknown>): Promise<Response> {
  return handler.fetch(new Request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer client-key' },
    body: JSON.stringify({ model: 'gemini-test', messages: [{ role: 'user', content: 'hi' }], ...body }),
  }), { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any);
}

function parseChatSse(text: string): Array<Record<string, unknown>> {
  const frames = text.split('\n\n').filter(frame => frame.startsWith('data: ')).map(frame => frame.slice(6));
  assert.equal(frames.at(-1), '[DONE]');
  return frames.filter(frame => frame !== '[DONE]').map(frame => JSON.parse(frame));
}

describe('/v1/chat/completions -> native gemini-interactions', () => {
  beforeEach(() => {
    configPath = join(tmpdir(), `proxy_chat_interactions_${Date.now()}_${Math.random().toString(36).slice(2)}.toml`);
    writeFileSync(configPath, `
[models.default]
upstream_mode = "gemini-interactions"
base_url = "https://upstream.test/v1beta"
api_key = "upstream-key"
`, 'utf-8');
    clearProxyConfigCache();
    upstreamUrl = '';
    upstreamBody = undefined;
    upstreamHeaders = undefined;
    upstreamResponse = () => interactionResponse([{ type: 'text', text: 'hello' }]);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      upstreamHeaders = new Headers(init?.headers);
      upstreamBody = JSON.parse(await new Response(init?.body as BodyInit).text());
      return upstreamResponse();
    }) as typeof fetch;
  });

  afterEach(() => {
    clearProxyConfigCache();
    globalThis.fetch = realFetch;
    if (configPath) unlinkSync(configPath);
    configPath = '';
  });

  it('uses the native URL and converts function tools and the JSON response directly', async () => {
    upstreamResponse = () => interactionResponse([
      { type: 'function_call', id: 'call_1', name: 'get_weather', arguments: { city: 'SF' } },
    ], 'requires_action');
    const response = await sendChat({
      messages: [
        { role: 'system', content: 'be concise' },
        { role: 'user', content: 'weather?' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Read weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      }],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      max_tokens: 64,
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamUrl, 'https://upstream.test/v1beta/interactions');
    assert.equal(upstreamHeaders?.get('x-goog-api-key'), 'client-key');
    assert.equal(upstreamHeaders?.get('authorization'), null);
    assert.deepEqual(upstreamBody, {
      model: 'gemini-test',
      input: [{ type: 'user_input', content: [{ type: 'text', text: 'weather?' }] }],
      system_instruction: 'be concise',
      generation_config: {
        max_output_tokens: 64,
        tool_choice: { allowed_tools: { mode: 'validated', tools: ['get_weather'] } },
      },
      tools: [{
        type: 'function',
        name: 'get_weather',
        description: 'Read weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      }],
    });

    const completion = await response.json() as any;
    assert.equal(completion.object, 'chat.completion');
    assert.equal(completion.id, 'int_1');
    assert.equal(completion.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(completion.choices[0].message.tool_calls, [{
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"SF"}' },
    }]);
    assert.deepEqual(completion.usage, {
      prompt_tokens: 11,
      completion_tokens: 5,
      total_tokens: 16,
      prompt_tokens_details: { cached_tokens: 3 },
    });
  });

  it('converts native Interactions SSE to Chat Completions chunks with usage', async () => {
    upstreamResponse = () => interactionStream([
      { event_type: 'interaction.created', interaction: { id: 'int_stream', model: 'gemini-test', created: '2026-01-01T00:00:00.000Z' } },
      { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'hello' } },
      { event_type: 'step.start', index: 1, step: { type: 'function_call', id: 'call_1', name: 'get_weather', arguments: { city: 'SF' } } },
      { event_type: 'interaction.completed', interaction: { id: 'int_stream', status: 'requires_action', usage: { total_input_tokens: 7, total_output_tokens: 2, total_tokens: 9 } } },
    ]);
    const response = await sendChat({ stream: true, stream_options: { include_usage: true } });
    const chunks = parseChatSse(await response.text());

    assert.equal(upstreamUrl, 'https://upstream.test/v1beta/interactions');
    assert.equal(upstreamBody?.stream, true);
    assert.ok(chunks.every(chunk => chunk.object === 'chat.completion.chunk'));
    assert.ok(chunks.every(chunk => chunk.id === 'int_stream'));
    assert.equal(chunks.find(chunk => chunk.choices[0]?.delta?.content)?.choices[0].delta.content, 'hello');
    assert.deepEqual(chunks.find(chunk => chunk.choices[0]?.delta?.tool_calls)?.choices[0].delta.tool_calls[0], {
      index: 0,
      id: 'call_1',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"SF"}' },
    });
    assert.equal(chunks.find(chunk => chunk.choices[0]?.finish_reason)?.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(chunks.at(-1)?.usage, { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 });
  });

  it('aborts a truncated native stream instead of emitting a clean finish', async () => {
    upstreamResponse = () => interactionStream([
      { event_type: 'interaction.created', interaction: { id: 'int_truncated' } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'partial' } },
    ]);
    const response = await sendChat({ stream: true });

    await assert.rejects(() => response.text());
  });
});
