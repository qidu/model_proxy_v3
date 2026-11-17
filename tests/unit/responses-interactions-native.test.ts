import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { responsesToInteractionsBody } from '../../src/converters/responses-to-interactions-request.js';
import { handleResponsesRequest } from '../../src/handlers/responses.js';
import { createLogger } from '../../src/utils/logger.js';

const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});
const TARGET = 'https://upstream.test/v1beta/interactions';
const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

function interaction(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify({
    id: 'int_1', model: 'gemini-test', status: 'completed', object: 'interaction',
    created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z',
    steps: [{ type: 'model_output', content: [{ type: 'text', text: 'native answer' }] }],
    usage: { total_input_tokens: 8, total_output_tokens: 3, total_tokens: 11 },
    ...body,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function interactionSse(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map(event => `event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  });
}

function parseSse(raw: string): Array<Record<string, any>> {
  return raw.split('\n\n').filter(Boolean).flatMap(frame => {
    const data = frame.split('\n').find(line => line.startsWith('data: '))?.slice(6);
    return data && data !== '[DONE]' ? [JSON.parse(data)] : [];
  });
}

describe('Responses request → native Interactions body', () => {
  it('carries input history, native tools, generation fields, and structured output', () => {
    const body = responsesToInteractionsBody({
      model: 'client', instructions: 'be precise',
      input: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'lookup first' }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'found' },
        { type: 'message', role: 'user', content: [
          { type: 'input_text', text: 'read this' },
          { type: 'input_file', file_data: 'data:application/pdf;base64,JVBERi0=', filename: 'spec.pdf' },
        ] },
      ],
      tools: [
        { type: 'function', name: 'lookup', parameters: { type: 'object' } },
        { type: 'web_search', search_content_types: ['text', 'image'] },
        { type: 'code_interpreter' },
        { type: 'mcp', server_label: 'docs', server_url: 'https://mcp.example', allowed_tools: ['search'] },
      ],
      tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'lookup' }] },
      reasoning: { effort: 'high', summary: 'auto' },
      text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' } } },
      max_output_tokens: 128, temperature: 0.2, top_p: 0.9, seed: 7,
      store: false, background: true,
    }, 'resolved-model');

    assert.deepEqual(body, {
      model: 'resolved-model',
      input: [
        { type: 'thought', summary: [{ type: 'text', text: 'lookup first' }] },
        { type: 'function_call', id: 'call_1', name: 'lookup', arguments: { q: 'x' } },
        { type: 'function_result', call_id: 'call_1', result: 'found' },
        { type: 'user_input', content: [
          { type: 'text', text: 'read this' },
          { type: 'document', mime_type: 'application/pdf', data: 'JVBERi0=' },
        ] },
      ],
      system_instruction: 'be precise',
      tools: [
        { type: 'function', name: 'lookup', parameters: { type: 'object' } },
        { type: 'google_search', search_types: ['web_search', 'image_search'] },
        { type: 'code_execution' },
        { type: 'mcp_server', name: 'docs', url: 'https://mcp.example', allowed_tools: { tools: ['search'] } },
      ],
      generation_config: {
        max_output_tokens: 128, temperature: 0.2, top_p: 0.9, seed: 7,
        thinking_level: 'high', thinking_summaries: 'auto',
        tool_choice: { allowed_tools: { mode: 'validated', tools: ['lookup'] } },
      },
      store: false,
      background: true,
      response_format: { type: 'object' },
    });
  });
});

describe('/v1/responses → native gemini-interactions route', () => {
  it('sends an Interactions JSON body and converts the stepped response', async () => {
    let upstreamUrl = '';
    let upstreamBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamUrl = String(input);
      upstreamBody = JSON.parse(await new Response(init?.body as BodyInit).text());
      return interaction({});
    }) as typeof fetch;

    const response = await handleResponsesRequest(new Request('http://proxy/v1/responses', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'client', input: 'hi', max_output_tokens: 64, store: false }),
    }), TARGET, { 'x-goog-api-key': 'key' }, 'responses-interactions-json', 'gemini-test', ENV, LOGGER, 'gemini-interactions');

    assert.equal(response.status, 200);
    assert.equal(upstreamUrl, TARGET);
    assert.deepEqual(upstreamBody, {
      model: 'gemini-test',
      input: [{ type: 'user_input', content: [{ type: 'text', text: 'hi' }] }],
      generation_config: { max_output_tokens: 64 },
      store: false,
    });
    const answer = await response.json() as any;
    assert.equal(answer.object, 'response');
    assert.equal(answer.output[0].content[0].text, 'native answer');
    assert.deepEqual(answer.usage, {
      input_tokens: 8, output_tokens: 3, total_tokens: 11,
      input_tokens_details: { cached_tokens: 0 },
    });
  });

  it('converts native Interactions SSE into Responses events with terminal usage', async () => {
    globalThis.fetch = (async () => interactionSse([
      { event_type: 'interaction.created', interaction: { id: 'int_stream', model: 'gemini-test', created: '2026-01-01T00:00:00.000Z' } },
      { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'streamed answer' } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction: {
        id: 'int_stream', status: 'completed',
        usage: { total_input_tokens: 5, total_output_tokens: 2, total_tokens: 7 },
      } },
    ])) as typeof fetch;

    const response = await handleResponsesRequest(new Request('http://proxy/v1/responses', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'client', input: 'hi', stream: true }),
    }), TARGET, { 'x-goog-api-key': 'key' }, 'responses-interactions-stream', 'gemini-test', ENV, LOGGER, 'gemini-interactions');

    const events = parseSse(await response.text());
    assert.equal(events[0].type, 'response.created');
    assert.equal(events.find(event => event.type === 'response.output_text.delta')?.delta, 'streamed answer');
    const completed = events.find(event => event.type === 'response.completed');
    assert.equal(completed?.response.output[0].content[0].text, 'streamed answer');
    assert.deepEqual(completed?.response.usage, {
      input_tokens: 5, output_tokens: 2, total_tokens: 7, input_tokens_details: { cached_tokens: 0 },
    });
  });
});
