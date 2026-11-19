import { after, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { responsesToClaudeBody } from '../../src/converters/responses-to-claude-request.js';
import { handleResponsesRequest } from '../../src/handlers/responses.js';
import { createLogger, type Logger } from '../../src/utils/logger.js';

const TARGET = 'https://upstream.example/v1/messages';
const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});
const realFetch = globalThis.fetch;
let upstreamBody: Record<string, unknown>;
let upstreamHeaders: Record<string, string>;
let upstreamResponse: () => Response;

function request(body: Record<string, unknown>): Request {
  return new Request('http://proxy/v1/responses', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function send(body: Record<string, unknown>, logger: Logger = LOGGER): Promise<Response> {
  return handleResponsesRequest(
    request(body), TARGET, { Authorization: 'Bearer upstream-key' }, 'req-r5', 'resolved-model', ENV,
    logger, 'anthropic-messages',
  );
}

/** Logger that records the exact message handed to `warn`. */
function recordingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const logger: Logger = {
    traceEnabled: false,
    trace() {},
    debug() {},
    info() {},
    warn(_requestId, message) { warnings.push(message); },
    error() {},
  };
  return { logger, warnings };
}

function claudeJson(content: Array<Record<string, unknown>>, stopReason?: string): Response {
  return new Response(JSON.stringify({
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-upstream', content,
    stop_reason: stopReason ?? (content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    usage: { input_tokens: 9, output_tokens: 3, cache_read_input_tokens: 2 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function claudeSse(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  });
}

function parseSse(raw: string): Array<Record<string, any>> {
  return raw.split('\n\n').filter(Boolean).filter(frame => !frame.includes('data: [DONE]')).map(frame => {
    const data = frame.split('\n').find(line => line.startsWith('data: '));
    assert.ok(data);
    return JSON.parse(data.slice(6));
  });
}

describe('Responses → Claude direct request conversion', () => {
  it('maps native tools, reasoning, structured output, and parallel-tool policy directly', () => {
    const body = responsesToClaudeBody({
      model: 'client-model', input: 'search and run', max_output_tokens: 128,
      reasoning: { effort: 'high' }, parallel_tool_calls: false,
      text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' } } },
      tools: [
        { type: 'function', name: 'lookup', parameters: { type: 'object' }, strict: true },
        { type: 'web_search', filters: { allowed_domains: ['example.com'] } },
        { type: 'code_interpreter', container: { type: 'auto' } },
        {
          type: 'mcp', server_label: 'catalog', server_url: 'https://mcp.example',
          headers: { Authorization: 'Bearer token' }, allowed_tools: ['search'],
        },
      ],
    }, 'resolved-model');

    assert.deepEqual(body.tools, [
      { name: 'lookup', input_schema: { type: 'object' }, strict: true },
      { type: 'web_search_20250305', name: 'web_search', allowed_domains: ['example.com'] },
      { type: 'code_execution_20250522', name: 'code_execution' },
    ]);
    assert.deepEqual(body.mcp_servers, [{
      type: 'url', name: 'catalog', url: 'https://mcp.example', authorization_token: 'Bearer token',
      tool_configuration: { allowed_tools: ['search'] },
    }]);
    assert.deepEqual(body.tool_choice, { type: 'auto', disable_parallel_tool_use: true });
    assert.deepEqual(body.output_config, {
      effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } },
    });
  });

  it('keeps reasoning, function calls, results, and text in input order without a Completions hub', () => {
    const body = responsesToClaudeBody({
      model: 'client-model',
      input: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'need lookup' }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'found' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      ],
    }, 'resolved-model');

    assert.deepEqual(body.messages, [
      {
        role: 'assistant', content: [
          { type: 'thinking', thinking: 'need lookup', signature: 'synthetic' },
          { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'found' }] },
      { role: 'assistant', content: 'done' },
    ]);
  });
});

describe('/v1/responses → anthropic-messages direct route', () => {
  beforeEach(() => {
    upstreamBody = undefined;
    upstreamHeaders = {};
    upstreamResponse = () => claudeJson([{ type: 'text', text: 'ok' }]);
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = JSON.parse(await new Response(init?.body as BodyInit).text());
      upstreamHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return upstreamResponse();
    }) as typeof fetch;
  });

  after(() => { globalThis.fetch = realFetch; });

  it('adds the MCP beta header and restores a namespaced function call in JSON', async () => {
    upstreamResponse = () => claudeJson([{ type: 'tool_use', id: 'call_1', name: 'crm_Z_lookup', input: { q: 'x' } }]);
    const response = await send({
      model: 'client-model', input: 'lookup',
      tools: [
        { type: 'namespace', name: 'crm', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] },
        { type: 'mcp', server_label: 'catalog', server_url: 'https://mcp.example' },
      ],
    });

    assert.equal(upstreamBody.tools[0].name, 'crm_Z_lookup');
    assert.equal(JSON.stringify(upstreamBody).includes('__namespaceMap'), false);
    assert.deepEqual(upstreamBody.mcp_servers, [{ type: 'url', name: 'catalog', url: 'https://mcp.example' }]);
    assert.equal(upstreamHeaders['anthropic-beta'], 'mcp-client-2025-04-04');
    const body = await response.json() as any;
    const call = body.output.find(item => item.type === 'function_call');
    assert.equal(call.name, 'lookup');
    assert.equal(call.namespace, 'crm');
    assert.deepEqual(body.usage, {
      input_tokens: 9, output_tokens: 3, total_tokens: 12, input_tokens_details: { cached_tokens: 2 },
    });
  });

  it('restores the same namespaced call throughout Responses SSE', async () => {
    upstreamResponse = () => claudeSse([
      { type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call_1', name: 'crm_Z_lookup', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]);
    const response = await send({
      model: 'client-model', input: 'lookup', stream: true,
      tools: [{ type: 'namespace', name: 'crm', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] }],
    });
    const events = parseSse(await response.text());

    const added = events.find(event => event.type === 'response.output_item.added');
    const done = events.find(event => event.type === 'response.output_item.done');
    const completed = events.find(event => event.type === 'response.completed');
    assert.equal(added?.item.name, 'lookup');
    assert.equal(added?.item.namespace, 'crm');
    assert.equal(done?.item.name, 'lookup');
    assert.equal(done?.item.namespace, 'crm');
    assert.equal(completed?.response.output[0].name, 'lookup');
    assert.equal(completed?.response.output[0].namespace, 'crm');
    assert.deepEqual(completed?.response.usage, {
      input_tokens: 4, output_tokens: 2, total_tokens: 6, input_tokens_details: { cached_tokens: 0 },
    });
  });

  it('projects a paused turn as incomplete/steered, and still reports max_tokens as max_output_tokens', async () => {
    const { logger, warnings } = recordingLogger();
    // `pause_turn` is a long-running turn the model paused; the client continues it
    // by resending this response as-is (`messages-create.md:4520`). Reporting
    // `completed` told the client the work was finished, and the spec's
    // `max_output_tokens` would have blamed a budget the model never hit.
    upstreamResponse = () => claudeJson([{ type: 'text', text: 'partial' }], 'pause_turn');
    const paused = await (await send({ model: 'client-model', input: 'go' }, logger)).json() as any;

    assert.equal(paused.status, 'incomplete');
    assert.deepEqual(paused.incomplete_details, { reason: 'steered' });
    assert.equal(paused.output[0].status, 'incomplete');
    assert.equal(paused.output[0].content[0].text, 'partial');
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /"pause_turn".*"incomplete"/);
    assert.match(warnings[0], /"steered"/);

    // The token cap keeps its own reason: the two causes share a status, not a cause.
    upstreamResponse = () => claudeJson([{ type: 'text', text: 'cut' }], 'max_tokens');
    const capped = await (await send({ model: 'client-model', input: 'go' }, logger)).json() as any;

    assert.equal(capped.status, 'incomplete');
    assert.deepEqual(capped.incomplete_details, { reason: 'max_output_tokens' });
    assert.equal(warnings.length, 1);
  });

  it('ends a paused stream with response.incomplete and reason steered', async () => {
    const { logger, warnings } = recordingLogger();
    upstreamResponse = () => claudeSse([
      { type: 'message_start', message: { usage: { input_tokens: 4, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'pause_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]);
    const events = parseSse(await (await send({ model: 'client-model', input: 'go', stream: true }, logger)).text());

    const terminal = events.at(-1) as any;
    assert.equal(terminal.type, 'response.incomplete');
    assert.equal(terminal.response.status, 'incomplete');
    assert.deepEqual(terminal.response.incomplete_details, { reason: 'steered' });
    assert.equal(terminal.response.output[0].status, 'incomplete');
    assert.equal(terminal.response.output[0].content[0].text, 'partial');
    // A paused turn must not also announce a clean completion.
    assert.equal(events.some(event => event.type === 'response.completed'), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /"pause_turn".*"incomplete"/);
  });
});
