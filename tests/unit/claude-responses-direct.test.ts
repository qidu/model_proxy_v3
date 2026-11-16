/**
 * The direct `/v1/messages` → `openai-responses` pair:
 * `claude-to-responses.ts` + `responses-to-claude.ts`.
 *
 * Two levels, on purpose:
 *
 * 1. The converters, asserted on exact structure — every field this pair exists to
 *    carry is checked by value (the mcp tool, `tools[].strict`, `instructions`,
 *    item order, the reasoning/thinking round-trip), and every field it deliberately
 *    drops is checked to be *both* absent and reported (rule #8: a drop that leaves
 *    no trace is the failure mode these tests exist for).
 * 2. The handler, driven end to end through a `fetch` mock, so the wiring in
 *    `messages.ts` is what is under test — not just the converters in isolation.
 *
 * The route previously reached the Responses API through Chat Completions, which
 * dropped the first two of those by construction, so these assertions fail on the
 * old bridge.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { claudeToResponsesBody } from '../../src/converters/claude-to-responses.js';
import { responsesToClaudeResponse } from '../../src/converters/responses-to-claude.js';
import { SYNTHETIC_THINKING_SIGNATURE } from '../../src/converters/openai-to-claude.js';
import { handleMessagesRequest } from '../../src/handlers/messages.js';
import type { Logger } from '../../src/utils/logger.js';

const TARGET_URL = 'https://upstream.example/v1/responses';
const ENV = { LOG_LEVEL: 'error' } as any;
const realFetch = globalThis.fetch;

/** A logger that records warnings, so a reported drop can be asserted. */
function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    traceEnabled: false,
    warnings,
    trace() {},
    debug() {},
    info() {},
    warn(_requestId: string, message: string) { warnings.push(message); },
    error() {},
  };
}

function warningsMatching(logger: { warnings: string[] }, needle: string): string[] {
  return logger.warnings.filter(message => message.includes(needle));
}

describe('claudeToResponsesBody', () => {
  it('carries mcp_servers as Responses mcp tools and keeps tools[].strict', () => {
    const logger = recordingLogger();
    const body = claudeToResponsesBody({
      model: 'claude-x',
      max_tokens: 1024,
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'lookup', description: 'look things up', input_schema: { type: 'object' }, strict: true }],
      mcp_servers: [{
        type: 'url',
        url: 'https://mcp.example/sse',
        name: 'catalog',
        authorization_token: 'secret-token',
        tool_configuration: { allowed_tools: ['search', 'fetch'] },
      }],
    } as any, 'claude-x', { logger, requestId: 'r1' });

    assert.deepEqual(body.tools, [
      {
        type: 'function',
        name: 'lookup',
        description: 'look things up',
        parameters: { type: 'object' },
        strict: true,
      },
      {
        type: 'mcp',
        server_label: 'catalog',
        server_url: 'https://mcp.example/sse',
        headers: { Authorization: 'secret-token' },
        allowed_tools: ['search', 'fetch'],
      },
    ]);
    // The two fields the old Completions bridge had nowhere to put, now present.
    assert.equal(body.instructions, undefined, 'no system field means no instructions key at all');
  });

  it('sends status text as instructions and reports a non-text system block', () => {
    const logger = recordingLogger();
    const body = claudeToResponsesBody({
      model: 'claude-x',
      max_tokens: 16,
      system: [{ type: 'text', text: 'be terse' }, { type: 'image', source: { type: 'url', url: 'x' } }],
      messages: [{ role: 'user', content: 'hi' }],
    } as any, 'claude-x', { logger, requestId: 'r1' });

    assert.equal(body.instructions, 'be terse');
    assert.equal(warningsMatching(logger, 'system[1] type').length, 1);
  });

  it('keeps a document block as an input_file item and an image as a data URI', () => {
    const body = claudeToResponsesBody({
      model: 'claude-x',
      max_tokens: 16,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'read this' },
          { type: 'document', title: 'spec.pdf', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0=' } },
        ],
      }],
    } as any, 'claude-x');

    // `claude-to-openai.ts:82` skips `document` blocks outright, so the bridged route
    // dropped the PDF before it was ever sent. Here it is an item.
    assert.deepEqual(body.input, [{
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'read this' },
        { type: 'input_file', file_data: 'data:application/pdf;base64,JVBERi0=', filename: 'spec.pdf' },
        { type: 'input_image', image_url: 'data:image/png;base64,iVBORw0=' },
      ],
    }]);
  });

  it('encodes a Unicode plain-text document as UTF-8 base64', () => {
    const text = '你好，Responses 👋';
    const body = claudeToResponsesBody({
      model: 'claude-x', max_tokens: 16,
      messages: [{
        role: 'user',
        content: [{ type: 'document', title: 'note.txt', source: { type: 'text', data: text } }],
      }],
    } as any, 'claude-x');

    const part = (body.input as any[])[0].content[0];
    const encoded = part.file_data.replace('data:text/plain;base64,', '');
    assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), text);
  });

  it('keeps item order: reasoning before the call it explains, output after it', () => {
    const logger = recordingLogger();
    const body = claudeToResponsesBody({
      model: 'claude-x',
      max_tokens: 16,
      system: 'sys',
      messages: [
        { role: 'user', content: 'find it' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'the tool to use is lookup', signature: 'anthropic-sig' },
            { type: 'text', text: 'calling' },
            { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'x' } },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'found it' }] },
      ],
    } as any, 'claude-x', { logger, requestId: 'r1' });

    assert.deepEqual(body.input, [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'find it' }] },
      // Thinking text survives as a reasoning item; the signature does not, and it
      // is reported rather than presented as carried.
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'the tool to use is lookup' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'calling' }] },
      { type: 'function_call', call_id: 'toolu_1', name: 'lookup', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'toolu_1', output: 'found it' },
    ]);
    const signatureWarnings = warningsMatching(logger, 'thinking.signature');
    assert.equal(signatureWarnings.length, 1);
    assert.match(signatureWarnings[0], /not mapped to Responses reasoning\.encrypted_content/);
  });

  it('maps thinking to a reasoning object with an effort and a summary request', () => {
    const body = claudeToResponsesBody({
      model: 'claude-x',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: 'enabled', budget_tokens: 8192 },
    } as any, 'claude-x');

    // 8192 clears the legacy high cutoff, so the effort is `high` — the same
    // threshold mapping every other egress uses.
    assert.deepEqual(body.reasoning, { summary: 'auto', effort: 'high' });
  });

  it('maps tool_choice and states disable_parallel_tool_use one level up', () => {
    const tools = [{ name: 'lookup', input_schema: { type: 'object' } }];
    const choice = (tool_choice: unknown): Record<string, unknown> => claudeToResponsesBody({
      model: 'claude-x',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      tools,
      tool_choice,
    } as any, 'claude-x');

    assert.equal(choice({ type: 'any' }).tool_choice, 'required');
    assert.equal(choice({ type: 'none' }).tool_choice, 'none');
    assert.equal(choice({ type: 'auto' }).tool_choice, 'auto');
    assert.deepEqual(choice({ type: 'tool', name: 'lookup' }).tool_choice, { type: 'function', name: 'lookup' });
    // Re-asserted through the three shapes above: no tools means no tool_choice.
    assert.equal(claudeToResponsesBody({
      model: 'claude-x',
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: { type: 'any' },
    } as any, 'claude-x').tool_choice, undefined);

    const parallel = choice({ type: 'auto', disable_parallel_tool_use: true });
    assert.equal(parallel.parallel_tool_calls, false);
    assert.equal(choice({ type: 'auto' }).parallel_tool_calls, undefined);
  });

  it('carries metadata.user_id, structured output, and max_tokens, and reports what it cannot carry', () => {
    const logger = recordingLogger();
    const body = claudeToResponsesBody({
      model: 'claude-x',
      max_tokens: 512,
      temperature: 0.3,
      top_p: 0.9,
      top_k: 40,
      stop_sequences: ['STOP'],
      service_tier: 'auto',
      cached_content: 'cache_1',
      cache_control: { type: 'ephemeral' },
      metadata: { user_id: 'user-7' },
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } }, task_budget: { type: 'tokens', total: 10 } },
      messages: [{ role: 'user', content: 'hi' }],
    } as any, 'claude-x', { logger, requestId: 'r1' });

    assert.equal(body.max_output_tokens, 512);
    assert.equal(body.temperature, 0.3);
    assert.equal(body.top_p, 0.9);
    assert.deepEqual(body.metadata, { user_id: 'user-7' });
    assert.deepEqual(body.text, { format: { type: 'json_schema', name: 'response', schema: { type: 'object' } } });

    // Absent from the wire, and each one named in a warning.
    assert.equal(body.stop_sequences, undefined);
    assert.equal(body.top_k, undefined);
    assert.equal(body.service_tier, 'auto');
    assert.equal(body.cached_content, undefined);
    for (const field of ['stop_sequences', 'top_k', 'cached_content', 'cache_control', 'output_config.task_budget']) {
      assert.equal(warningsMatching(logger, field).length, 1, `${field} must be reported as dropped`);
    }
    assert.equal(warningsMatching(logger, 'service_tier').length, 0);

    claudeToResponsesBody({
      model: 'claude-x', max_tokens: 16, service_tier: 'standard_only',
      messages: [{ role: 'user', content: 'hi' }],
    } as any, 'claude-x', { logger, requestId: 'r-standard-only' });
    assert.equal(warningsMatching(logger, 'service_tier "standard_only"').length, 1);
  });
});

describe('responsesToClaudeResponse', () => {
  const tokenConfig = { enabled: false, modelName: 'claude-x' };

  it('maps reasoning, message text, and function calls into ordered Claude blocks', async () => {
    const response = await responsesToClaudeResponse({
      id: 'resp_1',
      status: 'completed',
      output: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'weighed it' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'the answer' }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', arguments: '{"q":"x"}' },
      ],
      usage: { input_tokens: 11, output_tokens: 5, total_tokens: 16, input_tokens_details: { cached_tokens: 3 } },
    }, 'claude-x', 'req-1', undefined, tokenConfig);

    assert.equal(response.id, 'resp_1');
    assert.equal(response.type, 'message');
    assert.equal(response.role, 'assistant');
    assert.equal(response.stop_sequence, null);
    // A thinking block needs a signature; a Responses upstream issues no Anthropic
    // one, so the shared synthetic placeholder stands in.
    assert.deepEqual(response.content, [
      { type: 'thinking', thinking: 'weighed it', signature: SYNTHETIC_THINKING_SIGNATURE },
      { type: 'text', text: 'the answer' },
      { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
    ]);
    assert.equal(response.stop_reason, 'tool_use');
    assert.deepEqual(response.usage, {
      input_tokens: 11,
      output_tokens: 5,
      cache_creation_input_tokens: undefined,
      cache_read_input_tokens: 3,
    });
  });

  it('reports a refusal instead of passing the withheld answer off as text', async () => {
    const logger = recordingLogger();
    const response = await responsesToClaudeResponse({
      id: 'resp_2',
      status: 'completed',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'refusal', refusal: 'I cannot help with that.' }] }],
      usage: { input_tokens: 4, output_tokens: 1 },
    }, 'claude-x', 'req-2', undefined, tokenConfig, { logger, requestId: 'req-2' });

    // Messages has no refusal block: emitting the text would present a withheld
    // answer as a normal one.
    assert.deepEqual(response.content, []);
    assert.equal(response.stop_reason, 'refusal');
    assert.equal(warningsMatching(logger, 'refused the request').length, 1);
  });

  it('distinguishes output-cap truncation from a content filter', async () => {
    const logger = recordingLogger();
    const truncated = await responsesToClaudeResponse({
      id: 'resp_3',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'half an ans' }] }],
      usage: { input_tokens: 2, output_tokens: 9 },
    }, 'claude-x', 'req-3', undefined, tokenConfig, { logger, requestId: 'req-3' });

    assert.equal(truncated.stop_reason, 'max_tokens');
    // The declared reason has a Messages spelling, so nothing is reported.
    assert.equal(warningsMatching(logger, 'incomplete reason').length, 0);

    const filtered = await responsesToClaudeResponse({
      id: 'resp_4',
      status: 'incomplete',
      incomplete_details: { reason: 'content_filter' },
      output: [],
      usage: {},
    }, 'claude-x', 'req-4', undefined, tokenConfig, { logger, requestId: 'req-4' });

    assert.equal(filtered.stop_reason, 'refusal');
    assert.equal(warningsMatching(logger, 'incomplete reason').length, 0);
  });

  it('reports a server-tool item it cannot project', async () => {
    const logger = recordingLogger();
    const response = await responsesToClaudeResponse({
      id: 'resp_5',
      status: 'completed',
      output: [
        { type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search' } },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
      ],
      usage: { input_tokens: 3, output_tokens: 1 },
    }, 'claude-x', 'req-5', undefined, tokenConfig, { logger, requestId: 'req-5' });

    assert.deepEqual(response.content, [{ type: 'text', text: 'done' }]);
    assert.equal(warningsMatching(logger, 'web_search_call').length, 1);
    assert.equal(response.stop_reason, 'end_turn');
  });
});

describe('/v1/messages → openai-responses, end to end', () => {
  let upstreamCalls: Array<{ url: string; body: Record<string, unknown> }>;

  before(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      assert.ok(init?.body, 'upstream call must carry a JSON body');
      upstreamCalls.push({ url: String(input), body: JSON.parse(init.body as string) });
      return new Response(JSON.stringify({
        id: 'resp_live',
        object: 'response',
        status: 'completed',
        model: 'claude-x',
        output: [
          { type: 'reasoning', summary: [{ type: 'summary_text', text: 'checked the catalog' }] },
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'two matches' }] },
        ],
        usage: { input_tokens: 21, output_tokens: 7, total_tokens: 28 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  after(() => { globalThis.fetch = realFetch; });
  beforeEach(() => { upstreamCalls = []; });

  it('sends a direct Responses body and returns a Claude response with thinking', async () => {
    const response = await handleMessagesRequest(
      new Request('http://proxy/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-x',
          max_tokens: 256,
          system: 'be terse',
          stop_sequences: ['STOP'],
          mcp_servers: [{ type: 'url', url: 'https://mcp.example/sse', name: 'catalog' }],
          tools: [{ name: 'lookup', input_schema: { type: 'object' } }],
          messages: [{ role: 'user', content: 'find two things' }],
        }),
      }),
      TARGET_URL,
      { Authorization: 'Bearer upstream-key' },
      'req-e2e',
      'claude-x',
      ENV,
      undefined,
      undefined,
      'openai-responses',
    );

    assert.equal(upstreamCalls.length, 1);
    assert.equal(upstreamCalls[0].url, TARGET_URL);
    const sent = upstreamCalls[0].body;
    assert.equal(sent.instructions, 'be terse');
    assert.deepEqual(sent.input, [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'find two things' }] }]);
    assert.equal(sent.max_output_tokens, 256);
    // The connector declaration reaches the upstream, which the Completions bridge
    // could not do.
    assert.deepEqual(sent.tools, [
      { type: 'function', name: 'lookup', parameters: { type: 'object' } },
      { type: 'mcp', server_label: 'catalog', server_url: 'https://mcp.example/sse' },
    ]);
    assert.equal(sent.stop_sequences, undefined);

    assert.equal(response.status, 200);
    const answer = await response.json() as Record<string, any>;
    assert.equal(answer.type, 'message');
    assert.deepEqual(answer.content, [
      { type: 'thinking', thinking: 'checked the catalog', signature: SYNTHETIC_THINKING_SIGNATURE },
      { type: 'text', text: 'two matches' },
    ]);
    assert.equal(answer.stop_reason, 'end_turn');
    assert.equal(answer.usage.input_tokens, 21);
    assert.equal(answer.usage.output_tokens, 7);
  });
});

describe('/v1/messages → openai-responses, reasoning SSE lifecycle', () => {
  after(() => { globalThis.fetch = realFetch; });

  async function run(events: Array<Record<string, unknown>>): Promise<Array<Record<string, any>>> {
    globalThis.fetch = (async () => new Response(
      events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as typeof fetch;
    const response = await handleMessagesRequest(
      new Request('http://proxy/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'claude-x', max_tokens: 32, messages: [{ role: 'user', content: 'hi' }], stream: true }),
      }),
      TARGET_URL, { Authorization: 'Bearer upstream-key' }, 'req-stream', 'claude-x', ENV,
      undefined, undefined, 'openai-responses',
    );
    return (await response.text()).split('\n\n').filter(Boolean).map(frame => {
      const data = frame.split('\n').find(line => line.startsWith('data: '));
      assert.ok(data);
      return JSON.parse(data.slice(6));
    });
  }

  it('emits a complete reasoning summary supplied on output_item.done', async () => {
    const events = await run([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', summary: [] } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'whole thought' }] } },
      { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 1 } } },
    ]);

    const deltas = events.filter(event => event.type === 'content_block_delta');
    assert.deepEqual(deltas.map(event => event.delta), [
      { type: 'thinking_delta', thinking: 'whole thought' },
      { type: 'signature_delta', signature: SYNTHETIC_THINKING_SIGNATURE },
    ]);
  });

  it('does not invent a thinking block for encrypted-only reasoning', async () => {
    const events = await run([
      { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning' } },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', encrypted_content: 'ciphertext' } },
      { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 1 } } },
    ]);

    assert.equal(events.some(event => event.type === 'content_block_start'), false);
    assert.equal(events.at(-1)?.type, 'message_stop');
  });

  it('does not repeat delta text when the completed item repeats the full summary', async () => {
    const events = await run([
      { type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'streamed thought' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'streamed thought' }] } },
      { type: 'response.completed', response: { usage: { input_tokens: 2, output_tokens: 1 } } },
    ]);

    const thinking = events.filter(event => event.delta?.type === 'thinking_delta');
    assert.deepEqual(thinking.map(event => event.delta.thinking), ['streamed thought']);
  });
});
