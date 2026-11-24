import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';
import { createLogger } from '../../src/utils/logger.js';
import {
  createTrajectoryRequest,
  recordTrajectoryResponse,
  resolveTrajectorySessionId,
  TRAJECTORY_LOG_FILE,
  type TrajectoryRecord,
} from '../../src/utils/trajectory.js';

const logger = createLogger({ LOG_LEVEL: 'silent' });
const realFetch = globalThis.fetch;
const originalCwd = process.cwd();
let tempDir = '';
let logFile = '';

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mpv3-trajectory-'));
  logFile = join(tempDir, 'trajectory.jsonl');
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearProxyConfigCache();
  if (process.cwd() === tempDir) process.chdir(originalCwd);
  rmSync(tempDir, { recursive: true, force: true });
});

function records(file = logFile): TrajectoryRecord[] {
  return readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

async function capture(
  path: string,
  requestId: string,
  sessionId: string | null,
  requestBody: Record<string, unknown>,
  response: Response,
): Promise<{ body: string; record: TrajectoryRecord }> {
  const context = createTrajectoryRequest(path, requestId, sessionId, requestBody);
  assert.ok(context);
  const recorded = recordTrajectoryResponse(response, context, logger, logFile);
  const body = await recorded.text();
  return { body, record: records()[0] };
}

describe('trajectory JSONL recorder', () => {
  it('records Anthropic client messages, reasoning, tool calls, tool results, and usage', async () => {
    const responseBody = {
      id: 'msg_1', type: 'message', role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Need to inspect the file.', signature: 'sig' },
        { type: 'text', text: 'I will read it.' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a.ts' } },
      ],
      usage: { input_tokens: 12, output_tokens: 8 },
    };
    const requestBody = {
      messages: [
        { role: 'user', content: 'Inspect a.ts' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_0', content: 'old result' }] },
      ],
    };
    const { body, record } = await capture(
      '/v1/messages', 'req_claude', 'agent-claude', requestBody,
      new Response(JSON.stringify(responseBody), { headers: { 'Content-Type': 'application/json' } }),
    );

    assert.equal(body, JSON.stringify(responseBody));
    assert.equal(record.session_id, 'agent-claude');
    assert.equal(record.request_id, 'req_claude');
    assert.equal(record.sequence, 1);
    assert.equal(record.type, 'action');
    assert.equal(record.status, 'completed');
    assert.deepEqual(record.request_messages, requestBody.messages);
    assert.deepEqual(record.tool_results, [requestBody.messages[1].content[0]]);
    assert.deepEqual(record.reasoning, [responseBody.content[0]]);
    assert.deepEqual(record.tool_calls, [responseBody.content[2]]);
    assert.equal(record.assistant_text, 'I will read it.');
    assert.deepEqual(record.usage, responseBody.usage);
    assert.ok(!Number.isNaN(Date.parse(record.timestamp)));
  });

  it('reassembles fragmented Chat Completions SSE without changing the streamed bytes', async () => {
    const chunks = [
      { choices: [{ index: 0, delta: { reasoning_content: 'plan ', content: 'Hel', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"' } }] } }] },
      { choices: [{ index: 0, delta: { reasoning_content: 'then act', content: 'lo', tool_calls: [{ index: 0, function: { arguments: 'ls"}' } }] } }] },
      { choices: [], usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 } },
    ];
    const sse = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    const { body, record } = await capture(
      '/v1/chat/completions', 'req_chat', 'agent-chat',
      { messages: [{ role: 'tool', tool_call_id: 'call_0', content: 'prior output' }] },
      new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }),
    );

    assert.equal(body, sse);
    assert.equal(record.assistant_text, 'Hello');
    assert.deepEqual(record.reasoning, [{ type: 'reasoning', reasoning_content: 'plan then act' }]);
    assert.deepEqual(record.tool_calls, [{
      type: 'function', id: 'call_1', function: { name: 'bash', arguments: '{"cmd":"ls"}' },
    }]);
    assert.deepEqual(record.tool_results, [{ role: 'tool', tool_call_id: 'call_0', content: 'prior output' }]);
    assert.deepEqual(record.usage, chunks[2].usage);
  });

  it('uses the terminal Responses resource so streamed text and output items are not duplicated', async () => {
    const terminalResponse = {
      id: 'resp_1', status: 'completed',
      output: [
        { id: 'rs_1', type: 'reasoning', summary: [{ type: 'summary_text', text: 'summary' }] },
        { id: 'msg_1', type: 'message', content: [{ type: 'output_text', text: 'Hello' }] },
        { id: 'fc_1', type: 'function_call', call_id: 'call_1', name: 'f', arguments: '{"x":1}' },
      ],
      usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 },
    };
    const sse = [
      'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"Hel"}\n\n',
      'data: {"type":"response.output_text.delta","item_id":"msg_1","delta":"lo"}\n\n',
      `data: ${JSON.stringify({ type: 'response.completed', response: terminalResponse })}\n\n`,
    ].join('');
    const { record } = await capture(
      '/v1/responses', 'req_responses', 'agent-responses',
      { input: [{ type: 'function_call_output', call_id: 'call_0', output: 'done' }] },
      new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }),
    );

    assert.equal(record.assistant_text, 'Hello');
    assert.deepEqual(record.reasoning, [terminalResponse.output[0]]);
    assert.deepEqual(record.tool_calls, [terminalResponse.output[2]]);
    assert.deepEqual(record.tool_results, [{ type: 'function_call_output', call_id: 'call_0', output: 'done' }]);
    assert.deepEqual(record.usage, terminalResponse.usage);
    assert.equal(record.status, 'completed');
  });

  it('normalizes Gemini Generate Content parts at the client boundary', async () => {
    const responseBody = {
      candidates: [{ content: { parts: [
        { thought: true, text: 'considering' },
        { text: 'answer' },
        { functionCall: { id: 'g1', name: 'lookup', args: { q: 'x' } } },
      ] } }],
      usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 4, totalTokenCount: 10 },
    };
    const { record } = await capture(
      '/v1beta/models/gemini-test:generateContent', 'req_gemini', 'agent-gemini',
      { contents: [{ role: 'user', parts: [{ functionResponse: { name: 'lookup', response: { value: 1 } } }] }] },
      new Response(JSON.stringify(responseBody), { headers: { 'Content-Type': 'application/json' } }),
    );

    assert.equal(record.assistant_text, 'answer');
    assert.deepEqual(record.reasoning, [responseBody.candidates[0].content.parts[0]]);
    assert.deepEqual(record.tool_calls, [responseBody.candidates[0].content.parts[2]]);
    assert.deepEqual(record.tool_results, [{ functionResponse: { name: 'lookup', response: { value: 1 } } }]);
    assert.deepEqual(record.usage, responseBody.usageMetadata);
  });

  it('normalizes Interactions steps and their status', async () => {
    const responseBody = {
      object: 'interaction', id: 'int_1', status: 'requires_action',
      steps: [
        { type: 'thought', summary: [{ type: 'text', text: 'thinking' }] },
        { type: 'model_output', content: [{ type: 'text', text: 'working' }] },
        { type: 'function_call', id: 'i1', name: 'f', arguments: { x: 1 } },
      ],
      usage: { total_input_tokens: 3, total_output_tokens: 2, total_tokens: 5 },
    };
    const { record } = await capture(
      '/v1/interactions', 'req_interactions', 'agent-interactions',
      { input: [{ type: 'function_result', call_id: 'i0', result: 'ok' }] },
      new Response(JSON.stringify(responseBody), { headers: { 'Content-Type': 'application/json' } }),
    );

    assert.equal(record.assistant_text, 'working');
    assert.deepEqual(record.reasoning, [responseBody.steps[0]]);
    assert.deepEqual(record.tool_calls, [responseBody.steps[2]]);
    assert.deepEqual(record.tool_results, [{ type: 'function_result', call_id: 'i0', result: 'ok' }]);
    assert.equal(record.status, 'requires_action');
  });

  it('retains partial Responses deltas when cancelled before a terminal resource', async () => {
    const context = createTrajectoryRequest('/v1/responses', 'req_response_cancel', 'agent-response-cancel', { input: 'hi' });
    assert.ok(context);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          'data: {"type":"response.created","response":{"id":"resp_partial","status":"in_progress","output":[]}}\n\n' +
          'data: {"type":"response.output_text.delta","item_id":"msg_partial","delta":"partial"}\n\n',
        ));
      },
    });
    const response = recordTrajectoryResponse(new Response(source, {
      headers: { 'Content-Type': 'text/event-stream' },
    }), context, logger, logFile);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel('test cancellation');

    const record = records()[0];
    assert.equal(record.status, 'cancelled');
    assert.equal(record.assistant_text, 'partial');
  });

  it('resolves generic, harness, plugin, and client-specific session headers', () => {
    const cases = [
      ['x-agent-session-id', 'generic-session'],
      ['x-session-id', 'plugin-session'],
      ['x-deepseek-harness-session-id', 'deepseek-harness-session'],
      ['x-opencode-session', 'opencode-session'],
      ['x-claude-code-session-id', 'claude-session'],
      ['x-cursor-session-id', 'cursor-session'],
      ['session-id', 'codex-session'],
      ['session_id', 'codex-underscore-session'],
      ['thread-id', 'codex-thread'],
      ['conversation_id', 'codex-conversation'],
      ['X-Hermes-Session-Id', 'hermes-session'],
    ] as const;
    for (const [name, value] of cases) {
      assert.equal(resolveTrajectorySessionId(new Headers({ [name]: value })), value, name);
    }

    const precedence = new Headers({
      'x-claude-code-session-id': 'claude-session',
      'x-agent-session-id': 'generic-override',
    });
    assert.equal(resolveTrajectorySessionId(precedence), 'generic-override');
    assert.equal(resolveTrajectorySessionId(new Headers({
      'x-agent-session-id': '   ',
      'x-cursor-session-id': ' cursor-after-blank ',
    })), 'cursor-after-blank');
    assert.equal(resolveTrajectorySessionId(new Headers()), null);
  });

  it('assigns increasing sequence numbers to a supplied session and one to an anonymous request', () => {
    const first = createTrajectoryRequest('/v1/messages', 'req_seq_1', 'agent-sequence', { messages: [] });
    const second = createTrajectoryRequest('/v1/messages', 'req_seq_2', 'agent-sequence', { messages: [] });
    const anonymous = createTrajectoryRequest('/v1/messages', 'req_anonymous', null, { messages: [] });
    assert.equal(first?.sequence, 1);
    assert.equal(second?.sequence, 2);
    assert.equal(anonymous?.sessionId, 'req_anonymous');
    assert.equal(anonymous?.sequence, 1);
  });

  it('records cancellation while preserving the partial response', async () => {
    const context = createTrajectoryRequest('/v1/messages', 'req_cancel', 'agent-cancel', { messages: [] });
    assert.ok(context);
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n'));
      },
    });
    const response = recordTrajectoryResponse(new Response(source, {
      headers: { 'Content-Type': 'text/event-stream' },
    }), context, logger, logFile);
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel('test cancellation');

    const record = records()[0];
    assert.equal(record.status, 'cancelled');
    assert.equal(record.assistant_text, 'partial');
  });
});

describe('proxy trajectory integration', () => {
  it('enables recording from [general] and uses a client-specific session header', async () => {
    const configPath = join(tempDir, 'proxy.toml');
    writeFileSync(configPath, `
[general]
trajectory = true

[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"
`, 'utf8');
    clearProxyConfigCache();
    process.chdir(tempDir);
    globalThis.fetch = (async () => new Response(JSON.stringify({
      id: 'chatcmpl-1', object: 'chat.completion',
      choices: [{ index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { headers: { 'Content-Type': 'application/json' } })) as typeof fetch;

    const response = await handler.fetch(new Request('http://proxy/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer client-key',
        'Content-Type': 'application/json',
        'x-claude-code-session-id': 'agent-e2e',
      },
      body: JSON.stringify({ model: 'test', messages: [{ role: 'user', content: 'ping' }] }),
    }), { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'silent' });
    assert.equal(response.status, 200);
    await response.text();

    const outputFile = join(tempDir, TRAJECTORY_LOG_FILE.replace(/^\.\//, ''));
    assert.ok(existsSync(outputFile));
    const record = records(outputFile)[0];
    assert.equal(record.session_id, 'agent-e2e');
    assert.equal(record.sequence, 1);
    assert.deepEqual(record.request_messages, [{ role: 'user', content: 'ping' }]);
    assert.equal(record.assistant_text, 'pong');
    assert.deepEqual(record.usage, { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 });
    assert.equal(record.status, 'completed');
  });
});
