import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { claudeToInteractionsBody } from '../../src/converters/claude-to-interactions-request.js';
import { handleGeminiInteractionsForMessages } from '../../src/handlers/gemini.js';
import type { ClaudeMessagesRequest } from '../../src/types/claude.js';
import { createLogger } from '../../src/utils/logger.js';

const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});
const TARGET = 'https://upstream.test/v1beta/interactions';
const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

function interaction(events?: Array<Record<string, unknown>>): Response {
  if (events) {
    return new Response(events.map(event => `event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    });
  }
  return new Response(JSON.stringify({
    id: 'int_1', model: 'gemini-test', status: 'completed', object: 'interaction',
    created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z',
    steps: [{ type: 'model_output', content: [{ type: 'text', text: 'native answer' }] }],
    usage: { total_input_tokens: 8, total_output_tokens: 3, total_tokens: 11 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('Claude Messages request → native Interactions body', () => {
  it('carries rich messages, tools, MCP, thinking, and structured output', () => {
    const request = {
      model: 'client', max_tokens: 256, system: 'be precise', stream: false,
      messages: [
        { role: 'user', content: [
          { type: 'text', text: 'read and search' },
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
        ] },
        { role: 'assistant', content: [
          { type: 'thinking', thinking: 'use lookup', signature: 'sig-1' },
          { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
        ] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'found', is_error: false }] },
      ],
      tools: [
        { name: 'lookup', input_schema: { type: 'object' } },
        { type: 'web_search_20250305', name: 'web_search' },
      ],
      mcp_servers: [{ type: 'url', name: 'docs', url: 'https://mcp.example', authorization_token: 'Bearer token', tool_configuration: { allowed_tools: ['search'] } }],
      tool_choice: { type: 'tool', name: 'lookup' },
      thinking: { type: 'enabled', budget_tokens: 1000 },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } },
      temperature: 0.2, top_p: 0.9, stop_sequences: ['STOP'],
    } as unknown as ClaudeMessagesRequest;
    const body = claudeToInteractionsBody(request, 'resolved-model');

    assert.deepEqual(body, {
      model: 'resolved-model',
      input: [
        { type: 'user_input', content: [
          { type: 'text', text: 'read and search' },
          { type: 'document', data: 'JVBERi0=', mime_type: 'application/pdf' },
        ] },
        { type: 'thought', summary: [{ type: 'text', text: 'use lookup' }], signature: 'sig-1' },
        { type: 'function_call', id: 'call_1', name: 'lookup', arguments: { q: 'x' } },
        { type: 'function_result', call_id: 'call_1', result: 'found', is_error: false },
      ],
      system_instruction: 'be precise',
      tools: [
        { type: 'function', name: 'lookup', parameters: { type: 'object' } },
        { type: 'google_search' },
        { type: 'mcp_server', name: 'docs', url: 'https://mcp.example', headers: { Authorization: 'Bearer token' }, allowed_tools: { tools: ['search'] } },
      ],
      generation_config: {
        max_output_tokens: 256, temperature: 0.2, top_p: 0.9, stop_sequences: ['STOP'],
        thinking_level: 'high', thinking_summaries: 'auto',
        tool_choice: { allowed_tools: { mode: 'validated', tools: ['lookup'] } },
      },
      response_format: { type: 'object' },
    });
  });
});

describe('/v1/messages → native gemini-interactions route', () => {
  it('sends native Interactions JSON and returns a Claude Messages response', async () => {
    let upstreamUrl = '';
    let upstreamBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamUrl = String(input);
      upstreamBody = JSON.parse(await new Response(init?.body as BodyInit).text());
      return interaction();
    }) as typeof fetch;
    const response = await handleGeminiInteractionsForMessages(new Request('http://proxy/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'client', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 }),
    }), TARGET, { 'x-goog-api-key': 'key' }, 'messages-interactions-json', 'gemini-test', ENV, LOGGER);

    assert.equal(response.status, 200);
    assert.equal(upstreamUrl, TARGET);
    assert.deepEqual(upstreamBody, {
      model: 'gemini-test',
      input: [{ type: 'user_input', content: [{ type: 'text', text: 'hi' }] }],
      generation_config: { max_output_tokens: 64 },
    });
    const answer = await response.json() as any;
    assert.equal(answer.type, 'message');
    assert.equal(answer.role, 'assistant');
    assert.equal(answer.content[0].text, 'native answer');
    assert.deepEqual(answer.usage, { input_tokens: 8, output_tokens: 3 });
  });

  it('converts native Interactions SSE to Claude Messages events', async () => {
    globalThis.fetch = (async () => interaction([
      { event_type: 'interaction.created', interaction: { id: 'int_stream', model: 'gemini-test', created: '2026-01-01T00:00:00.000Z' } },
      { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'streamed answer' } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction: {
        id: 'int_stream', status: 'completed', usage: { total_input_tokens: 5, total_output_tokens: 2, total_tokens: 7 },
      } },
    ])) as typeof fetch;
    const response = await handleGeminiInteractionsForMessages(new Request('http://proxy/v1/messages', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'client', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64, stream: true }),
    }), TARGET, { 'x-goog-api-key': 'key' }, 'messages-interactions-stream', 'gemini-test', ENV, LOGGER);

    const raw = await response.text();
    const events = raw.split('\n\n').filter(Boolean).flatMap(frame => {
      const data = frame.split('\n').find(line => line.startsWith('data: '))?.slice(6);
      return data ? [JSON.parse(data)] : [];
    });
    assert.equal(events[0].type, 'message_start');
    assert.equal(events.find(event => event.type === 'content_block_delta')?.delta?.text, 'streamed answer');
    assert.ok(events.some(event => event.type === 'message_delta'));
  });
});
