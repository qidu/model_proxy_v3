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
let upstreamResponse: () => Response;

function jsonResponse(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function sseResponse(raw: string): Response {
  return new Response(raw, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function responsesSse(events: Array<Record<string, unknown>>): Response {
  return sseResponse(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
}

async function send(mode: string, body: Record<string, unknown>): Promise<Response> {
  writeFileSync(configPath, `
[models.default]
upstream_mode = "${mode}"
base_url = "https://upstream.test"
api_key = "upstream-key"
`, 'utf-8');
  clearProxyConfigCache();
  return handler.fetch(new Request('http://localhost/v1/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'client-key' },
    body: JSON.stringify(body),
  }), { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any);
}

function parseInteractionSse(raw: string): Array<Record<string, unknown>> {
  return raw.split('\n\n').filter(Boolean).map(frame => {
    const data = frame.split('\n').find(line => line.startsWith('data: '));
    assert.ok(data, `frame has data: ${frame}`);
    return JSON.parse(data.slice(6));
  });
}

describe('native and direct Responses Interactions routes', () => {
  beforeEach(() => {
    configPath = join(tmpdir(), `proxy_interactions_native_${Date.now()}_${Math.random().toString(36).slice(2)}.toml`);
    upstreamUrl = '';
    upstreamBody = undefined;
    upstreamResponse = () => jsonResponse({
      id: 'int_native', model: 'gemini-test', status: 'completed', object: 'interaction',
      created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z',
      role: 'model', outputs: [{ type: 'text', text: 'native answer' }],
    });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
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

  it('passes the Interactions body and JSON response through natively', async () => {
    const nativeResponse = {
      id: 'int_native', model: 'gemini-test', status: 'completed', object: 'interaction',
      created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z',
      role: 'model', outputs: [{ type: 'text', text: 'native answer' }],
      previous_interaction_id: 'int_previous', store: false,
    };
    upstreamResponse = () => jsonResponse(nativeResponse);
    const body = {
      model: 'gemini-test',
      input: [{ type: 'user_input', content: [{ type: 'text', text: 'hi' }] }],
      previous_interaction_id: 'int_previous',
      store: false,
      background: true,
    };
    const response = await send('gemini-interactions', body);

    assert.equal(response.status, 200);
    assert.equal(upstreamUrl, 'https://upstream.test/v1beta/interactions');
    assert.deepEqual(upstreamBody, body);
    assert.deepEqual(await response.json(), nativeResponse);
  });

  it('relays native Interactions SSE bytes unchanged', async () => {
    const raw = [
      'event: interaction.created\ndata: {"event_type":"interaction.created","interaction":{"id":"int_1"}}\n\n',
      'event: step.delta\ndata: {"event_type":"step.delta","index":0,"delta":{"type":"text","text":"hi"}}\n\n',
      'event: interaction.completed\ndata: {"event_type":"interaction.completed","interaction":{"id":"int_1","status":"completed"}}\n\n',
    ].join('');
    upstreamResponse = () => sseResponse(raw);
    const response = await send('gemini-interactions', {
      model: 'gemini-test', input: 'hi', stream: true,
    });

    assert.equal(await response.text(), raw);
    assert.equal(upstreamUrl, 'https://upstream.test/v1beta/interactions');
  });

  it('converts directly to Responses without losing the function allow-list', async () => {
    upstreamResponse = () => jsonResponse({
      id: 'resp_1', model: 'gpt-test', status: 'completed', created_at: 1767225600,
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'checking weather' }] },
        { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' },
      ],
      usage: {
        input_tokens: 12, output_tokens: 4, total_tokens: 16,
        input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 1 },
      },
    });
    const response = await send('openai-responses', {
      model: 'gpt-test',
      input: [{ type: 'user_input', content: [{ type: 'text', text: 'weather?' }] }],
      system_instruction: 'be concise',
      background: true,
      labels: { source: 'test' },
      generation_config: {
        thinking_level: 'high', thinking_summaries: 'auto',
        tool_choice: { allowed_tools: { mode: 'validated', tools: ['get_weather', 'get_time'] } },
      },
      tools: [
        { type: 'function', name: 'get_weather', parameters: { type: 'object' } },
        { type: 'function', name: 'get_time', parameters: { type: 'object' } },
        { type: 'google_search' },
        { type: 'code_execution' },
        { type: 'mcp_server', name: 'docs', url: 'https://mcp.example' },
      ],
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamUrl, 'https://upstream.test/v1/responses');
    assert.deepEqual(upstreamBody?.tool_choice, {
      type: 'allowed_tools', mode: 'required',
      tools: [{ type: 'function', name: 'get_weather' }, { type: 'function', name: 'get_time' }],
    });
    assert.deepEqual(upstreamBody?.tools, [
      { type: 'function', name: 'get_weather', parameters: { type: 'object' } },
      { type: 'function', name: 'get_time', parameters: { type: 'object' } },
      { type: 'web_search' },
      { type: 'code_interpreter', container: { type: 'auto' } },
      { type: 'mcp', server_label: 'docs', server_url: 'https://mcp.example' },
    ]);
    assert.equal(upstreamBody?.background, true);
    assert.deepEqual(upstreamBody?.metadata, { source: 'test' });
    assert.deepEqual(upstreamBody?.reasoning, { effort: 'high', summary: 'auto' });
    assert.equal(JSON.stringify(upstreamBody).includes('"messages"'), false);

    const interaction = await response.json() as any;
    assert.match(interaction.id, /^v1_\d+_/);
    assert.equal(interaction.status, 'requires_action');
    assert.deepEqual(interaction.outputs, [
      { type: 'thought', summary: { content: { type: 'text', text: 'checking weather' } } },
      { type: 'function_call', id: 'call_1', name: 'get_weather', arguments: { city: 'SF' } },
    ]);
    assert.deepEqual(interaction.usage, {
      total_input_tokens: 12, total_output_tokens: 4, total_tokens: 16,
      total_cached_tokens: 2, total_thought_tokens: 1,
    });
  });

  it('maps Responses SSE directly to Interactions steps and terminal usage', async () => {
    upstreamResponse = () => responsesSse([
      { type: 'response.created', response: { id: 'resp_stream', created_at: 1767225600 } },
      { type: 'response.output_text.delta', delta: 'checking' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'get_weather' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"city":' },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: '"SF"}' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' } },
      { type: 'response.completed', response: { id: 'resp_stream', status: 'completed', usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } } },
    ]);
    const response = await send('openai-responses', { model: 'gpt-test', input: 'hi', stream: true });
    const events = parseInteractionSse(await response.text());

    assert.deepEqual(events.map(event => event.event_type), [
      'interaction.created', 'step.start', 'step.delta', 'step.stop', 'step.start', 'step.stop', 'interaction.completed',
    ]);
    assert.equal(events.some(event => event.object === 'chat.completion.chunk'), false);
    const callStart = events.find(event => event.event_type === 'step.start' && event.step?.type === 'function_call');
    assert.deepEqual(callStart?.step, {
      type: 'function_call', id: 'call_1', name: 'get_weather', arguments: { city: 'SF' },
    });
    const completed = events.at(-1);
    assert.equal(completed?.interaction.id, 'resp_stream');
    assert.equal(completed?.interaction.status, 'requires_action');
    assert.deepEqual(completed?.interaction.usage, { total_input_tokens: 8, total_output_tokens: 3, total_tokens: 11 });
  });

  it('aborts a direct stream when Responses ends without a terminal event', async () => {
    upstreamResponse = () => responsesSse([
      { type: 'response.created', response: { id: 'resp_truncated' } },
      { type: 'response.output_text.delta', delta: 'partial' },
    ]);
    const response = await send('openai-responses', { model: 'gpt-test', input: 'hi', stream: true });

    await assert.rejects(() => response.text());
  });
});
