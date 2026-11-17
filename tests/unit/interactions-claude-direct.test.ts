import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { interactionsToClaudeBody } from '../../src/converters/interactions-to-claude.js';
import { handleOpenAIRequest } from '../../src/handlers/openai.js';
import { createLogger } from '../../src/utils/logger.js';

const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});
const TARGET = 'https://upstream.test/v1/messages';
const realFetch = globalThis.fetch;

function json(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function claudeSse(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  });
}

function parseSse(raw: string): Array<Record<string, any>> {
  return raw.split('\n\n').filter(Boolean).map(frame => {
    const data = frame.split('\n').find(line => line.startsWith('data: '));
    assert.ok(data);
    return JSON.parse(data.slice(6));
  });
}

async function send(body: Record<string, unknown>, stream = false): Promise<Response> {
  return handleOpenAIRequest(
    new Request('http://proxy/v1/interactions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, ...(stream ? { stream: true } : {}) }),
    }),
    TARGET, { 'x-api-key': 'upstream-key' }, stream ? 'int-claude-stream' : 'int-claude-json',
    'resolved-model', ENV, LOGGER, undefined, undefined, 'anthropic-messages',
  );
}

describe('Interactions → Claude direct request conversion', () => {
  it('carries MCP/native tools, strict functions, generation settings, and native history', () => {
    const body = interactionsToClaudeBody({
      model: 'client-model', system_instruction: 'be precise',
      input: [
        { type: 'user_input', content: [
          { type: 'text', text: 'read and search' },
          { type: 'document', mime_type: 'application/pdf', data: 'JVBERi0=' },
        ] },
        { type: 'thought', summary: [{ type: 'text', text: 'use lookup' }], signature: 'sig-1' },
        { type: 'function_call', id: 'call_1', name: 'lookup', arguments: { q: 'x' } },
        { type: 'function_result', call_id: 'call_1', result: { answer: 'found' } },
        { type: 'mcp_server_tool_call', id: 'mcp_1', server_name: 'catalog', name: 'search', arguments: { q: 'x' } },
        { type: 'mcp_server_tool_result', call_id: 'mcp_1', server_name: 'catalog', result: 'done' },
      ],
      tools: [
        { type: 'function', name: 'lookup', parameters: { type: 'object' }, strict: true },
        { type: 'google_search' },
        { type: 'code_execution' },
        {
          type: 'mcp_server', name: 'catalog', url: 'https://mcp.example', headers: { Authorization: 'Bearer token' },
          allowed_tools: [{ name: 'search' }],
        },
      ],
      generation_config: {
        max_output_tokens: 256, temperature: 0.2, top_p: 0.9, stop_sequences: ['STOP'],
        thinking_level: 'high', thinking_summaries: 'auto',
        tool_choice: { allowed_tools: { mode: 'validated', tools: ['lookup'] } },
      },
      response_format: { type: 'object', properties: { answer: { type: 'string' } } },
      labels: { user_id: 'user-1' },
    }, 'resolved-model');

    assert.equal(body.model, 'resolved-model');
    assert.equal(body.system, 'be precise');
    assert.equal(body.max_tokens, 256);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.top_p, 0.9);
    assert.deepEqual(body.stop_sequences, ['STOP']);
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.deepEqual(body.output_config, {
      effort: 'high',
      format: { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } } } },
    });
    assert.deepEqual(body.metadata, { user_id: 'user-1' });
    assert.deepEqual(body.tool_choice, { type: 'tool', name: 'lookup' });
    assert.deepEqual(body.tools, [
      { name: 'lookup', input_schema: { type: 'object' }, strict: true },
      { type: 'web_search_20250305', name: 'web_search' },
      { type: 'code_execution_20250522', name: 'code_execution' },
    ]);
    assert.deepEqual(body.mcp_servers, [{
      type: 'url', name: 'catalog', url: 'https://mcp.example', authorization_token: 'Bearer token',
      tool_configuration: { allowed_tools: ['search'] },
    }]);
    assert.deepEqual(body.messages, [
      { role: 'user', content: [
        { type: 'text', text: 'read and search' },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
      ] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'use lookup', signature: 'sig-1' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"answer":"found"}' }] },
      { role: 'assistant', content: [{ type: 'mcp_tool_use', id: 'mcp_1', name: 'search', server_name: 'catalog', input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'mcp_tool_result', tool_use_id: 'mcp_1', content: 'done', server_name: 'catalog' }] },
    ]);
    assert.equal(JSON.stringify(body).includes('tool_calls'), false);
  });
});

describe('/v1/interactions ↔ anthropic-messages direct route', () => {
  afterEach(() => { globalThis.fetch = realFetch; });

  it('adds the MCP beta header and returns native tool/thought steps with filtered functions', async () => {
    let upstreamBody: Record<string, unknown>;
    let upstreamHeaders: Record<string, string>;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = JSON.parse(await new Response(init?.body as BodyInit).text());
      upstreamHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return json({
        id: 'msg_1', model: 'claude-upstream', stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 'checking', signature: 'claude-sig' },
          { type: 'server_tool_use', id: 'search_1', name: 'web_search', input: { queries: ['weather'] } },
          { type: 'mcp_tool_use', id: 'mcp_1', server_name: 'catalog', name: 'search', input: { q: 'x' } },
          { type: 'mcp_tool_result', tool_use_id: 'mcp_1', server_name: 'catalog', content: 'found' },
          { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
          { type: 'tool_use', id: 'call_2', name: 'other', input: {} },
        ],
        usage: { input_tokens: 9, output_tokens: 5, cache_read_input_tokens: 2 },
      });
    }) as typeof fetch;
    const response = await send({
      model: 'client', input: 'lookup', tools: [
        { type: 'function', name: 'lookup', parameters: { type: 'object' } },
        { type: 'function', name: 'other', parameters: { type: 'object' } },
        { type: 'mcp_server', name: 'catalog', url: 'https://mcp.example' },
      ],
      generation_config: { tool_choice: { allowed_tools: { mode: 'any', tools: ['lookup'] } } },
    });

    assert.deepEqual(upstreamBody!.mcp_servers, [{ type: 'url', name: 'catalog', url: 'https://mcp.example' }]);
    assert.equal(upstreamHeaders!['anthropic-beta'], 'mcp-client-2025-04-04');
    assert.equal(JSON.stringify(upstreamBody).includes('tool_calls'), false);
    const answer = await response.json() as any;
    assert.match(answer.id, /^v1_\d+_int-claude-json$/);
    assert.equal(answer.status, 'requires_action');
    assert.deepEqual(answer.outputs, [
      { type: 'thought', summary: { content: { type: 'text', text: 'checking' } }, signature: 'claude-sig' },
      { type: 'google_search_call', id: 'search_1', arguments: { queries: ['weather'] }, search_type: 'web_search' },
      { type: 'mcp_server_tool_call', id: 'mcp_1', name: 'search', server_name: 'catalog', arguments: { q: 'x' } },
      { type: 'mcp_server_tool_result', call_id: 'mcp_1', result: 'found', server_name: 'catalog' },
      { type: 'function_call', id: 'call_1', name: 'lookup', arguments: { q: 'x' } },
    ]);
    assert.deepEqual(answer.usage, {
      total_input_tokens: 11, total_output_tokens: 5, total_cached_tokens: 2, total_tokens: 16,
    });
  });

  it('streams native MCP calls and signed thoughts directly with terminal usage', async () => {
    globalThis.fetch = (async () => claudeSse([
      { type: 'message_start', message: { id: 'msg_stream', content: [], usage: { input_tokens: 7, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reasoning' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-stream' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'mcp_tool_use', id: 'mcp_1', server_name: 'catalog', name: 'search', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ])) as typeof fetch;
    const response = await send({ model: 'client', input: 'search' }, true);
    const events = parseSse(await response.text());
    const call = events.find(event => event.step?.type === 'mcp_server_tool_call');
    assert.deepEqual(call?.step, {
      type: 'mcp_server_tool_call', id: 'mcp_1', name: 'search', server_name: 'catalog', arguments: { q: 'x' },
    });
    const signature = events.find(event => event.delta?.type === 'thought_signature');
    assert.equal(signature?.delta.signature, 'sig-stream');
    const terminal = events.at(-1);
    assert.equal(terminal.event_type, 'interaction.completed');
    assert.match(terminal.interaction.id, /^v1_\d+_int-claude-stream$/);
    assert.equal(terminal.interaction.status, 'completed');
    assert.deepEqual(terminal.interaction.usage, {
      total_input_tokens: 7, total_output_tokens: 4, total_tokens: 11,
    });
    assert.equal(events.some(event => event.object === 'chat.completion.chunk'), false);
  });
});
