import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleMessagesRequest } from '../../src/handlers/messages.js';
import { ClaudeProxyError } from '../../src/utils/errors.js';

const TARGET_URL = 'https://upstream.example/v1/chat/completions';
const ENV = { LOG_LEVEL: 'error' } as any;
const realFetch = globalThis.fetch;

let upstreamBody: Record<string, unknown>;
let upstreamCalls: Array<{
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}>;

function jsonResponse(body: unknown): Record<string, unknown> {
  return body as Record<string, unknown>;
}

function messagesRequest(body: Record<string, unknown>): Request {
  return new Request('http://proxy/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postMessages(body: Record<string, unknown>, upstreamMode = 'openai-completions'): Promise<Response> {
  return handleMessagesRequest(
    messagesRequest(body),
    TARGET_URL,
    { Authorization: 'Bearer upstream-key' },
    'req-messages',
    'gpt-test',
    ENV,
    undefined,
    undefined,
    upstreamMode,
  );
}

function assertUpstreamBody(expected: Record<string, unknown>): void {
  assert.equal(upstreamCalls.length, 1);
  const call = upstreamCalls[0];
  assert.equal(call.url, TARGET_URL);
  assert.equal(call.method, 'POST');
  assert.deepEqual(call.headers, {
    'content-type': 'application/json',
    authorization: 'Bearer upstream-key',
  });
  assert.deepEqual(call.body, expected);
}

describe('handleMessagesRequest', () => {
  before(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      assert.ok(init?.body, 'upstream call must carry a JSON body');
      upstreamCalls.push({
        url: String(input),
        method: init?.method,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: JSON.parse(init.body as string),
      });
      return new Response(JSON.stringify(upstreamBody), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  beforeEach(() => {
    upstreamCalls = [];
    upstreamBody = {
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: 1700000000,
      model: 'gpt-test',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    };
  });

  it('normalizes OpenAI output_config.effort to reasoning_effort', async () => {
    const response = await postMessages({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      output_config: { effort: 'high' },
    });

    assertUpstreamBody({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      output_config: { effort: 'high' },
      reasoning_effort: 'high',
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'req-messages');
    assert.deepEqual(jsonResponse(await response.json()), {
      id: 'chatcmpl-test',
      type: 'message',
      role: 'assistant',
      model: 'gpt-test',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  });

  it('keeps explicit reasoning_effort ahead of output_config.effort', async () => {
    const response = await postMessages({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning_effort: 'low',
      output_config: { effort: 'high' },
    });

    assertUpstreamBody({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      reasoning_effort: 'low',
      output_config: { effort: 'high' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(jsonResponse(await response.json()), {
      id: 'chatcmpl-test',
      type: 'message',
      role: 'assistant',
      model: 'gpt-test',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 1 },
    });
  });

  it('converts a non-streaming Responses text and function_call result to Claude', async () => {
    upstreamBody = {
      id: 'resp-mixed',
      object: 'response',
      created_at: 1700000001,
      status: 'completed',
      model: 'gpt-test',
      output: [
        {
          id: 'msg-upstream',
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I will check the weather.' }],
        },
        {
          id: 'fc-upstream',
          type: 'function_call',
          status: 'completed',
          call_id: 'call-weather',
          name: 'get_weather',
          arguments: '{"city":"Paris","units":"celsius"}',
        },
      ],
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        total_tokens: 19,
        input_tokens_details: { cached_tokens: 3 },
      },
    };

    const response = await postMessages({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
    }, 'openai-responses');

    assertUpstreamBody({
      model: 'gpt-test',
      input: [{
        role: 'user',
        content: [{ type: 'input_text', text: 'What is the weather in Paris?' }],
      }],
      stream: false,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('x-request-id'), 'req-messages');
    assert.deepEqual(jsonResponse(await response.json()), {
      id: 'resp-mixed',
      type: 'message',
      role: 'assistant',
      model: 'gpt-test',
      content: [
        { type: 'text', text: 'I will check the weather.' },
        {
          type: 'tool_use',
          id: 'call-weather',
          name: 'get_weather',
          input: { city: 'Paris', units: 'celsius' },
        },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 12,
        output_tokens: 7,
        cache_read_input_tokens: 3,
      },
    });
  });

  it('round-trips reasoning and tool history into Responses input items', async () => {
    const response = await postMessages({
      model: 'gpt-test',
      messages: [
        { role: 'user', content: 'Check Paris' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'I need the weather tool.', signature: 'sig' },
            { type: 'tool_use', id: 'call-weather', name: 'get_weather', input: { city: 'Paris' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-weather', content: 'sunny' }],
        },
      ],
    }, 'openai-responses');

    assert.equal(response.status, 200);
    assert.equal(upstreamCalls.length, 1);
    assert.deepEqual(upstreamCalls[0].body.input, [
      { role: 'user', content: [{ type: 'input_text', text: 'Check Paris' }] },
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'I need the weather tool.' }] },
      { type: 'function_call', call_id: 'call-weather', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { type: 'function_call_output', call_id: 'call-weather', output: 'sunny' },
    ]);
  });

  it('converts Responses SSE tool calls and fragmented arguments to Claude SSE', async () => {
    const previousFetch = globalThis.fetch;
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-weather', name: 'get_weather' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city":' },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '"Paris"}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } },
      { type: 'response.completed', response: { usage: { input_tokens: 8, output_tokens: 4 } } },
    ];
    const wire = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        const encoded = new TextEncoder().encode(wire);
        controller.enqueue(encoded.slice(0, 37));
        controller.enqueue(encoded.slice(37));
        controller.close();
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;

    try {
      const response = await postMessages({
        model: 'gpt-test',
        stream: true,
        messages: [{ role: 'user', content: 'Weather?' }],
      }, 'openai-responses');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/event-stream');
      const text = await response.text();
      const parsed = text.split('\n\n').filter(Boolean).map((frame) => {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        return JSON.parse(data!.slice(6));
      });

      assert.equal(parsed[0].type, 'message_start');
      assert.deepEqual(parsed[1], {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'call-weather', name: 'get_weather', input: {} },
      });
      assert.deepEqual(parsed[2].delta, { type: 'input_json_delta', partial_json: '{"city":' });
      assert.deepEqual(parsed[3].delta, { type: 'input_json_delta', partial_json: '"Paris"}' });
      assert.equal(parsed[4].type, 'content_block_stop');
      assert.deepEqual(parsed[5], {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: { input_tokens: 8, output_tokens: 4 },
      });
      assert.deepEqual(parsed[6], { type: 'message_stop' });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('derives OpenAI reasoning effort from Claude thinking and removes thinking', async () => {
    const response = await postMessages({
      model: 'gpt-test',
      max_tokens: 8192,
      thinking: { type: 'enabled', budget_tokens: 4096 },
      messages: [{ role: 'user', content: 'Think carefully' }],
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamCalls[0].body.reasoning_effort, 'high');
    assert.equal('thinking' in upstreamCalls[0].body, false);
  });

  it('forwards Responses options and flattens tool schemas and forced choice', async () => {
    upstreamBody = {
      id: 'resp-options', object: 'response', created_at: 1, model: 'gpt-test',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
    };
    const response = await postMessages({
      model: 'gpt-test',
      max_tokens: 128,
      temperature: 0.2,
      top_p: 0.8,
      messages: [{ role: 'user', content: 'Use a tool' }],
      tools: [{ type: 'function', function: { name: 'test_tool', description: 'test', parameters: { type: 'object' } } }],
      tool_choice: { type: 'function', function: { name: 'test_tool' } },
    }, 'openai-responses');
    assert.equal(response.status, 200);
    assert.deepEqual(upstreamCalls[0].body, {
      model: 'gpt-test',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Use a tool' }] }],
      stream: false,
      temperature: 0.2,
      top_p: 0.8,
      max_output_tokens: 128,
      tools: [{ type: 'function', name: 'test_tool', description: 'test', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', name: 'test_tool' },
    });
  });

  it('converts OpenAI completion SSE text and final usage to Claude SSE', async () => {
    const previousFetch = globalThis.fetch;
    const chunks = [
      { id: 'chat-stream', object: 'chat.completion.chunk', created: 1, model: 'gpt-test', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello' }, finish_reason: null }] },
      { id: 'chat-stream', object: 'chat.completion.chunk', created: 1, model: 'gpt-test', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 6, completion_tokens: 2, total_tokens: 8 } },
    ];
    const wire = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
    globalThis.fetch = (async () => new Response(wire, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })) as typeof fetch;
    try {
      const response = await postMessages({
        model: 'gpt-test', stream: true,
        messages: [{ role: 'user', content: 'Say hello' }],
      });
      assert.equal(response.status, 200);
      const text = await response.text();
      const parsed = text.split('\n\n').filter(Boolean).map((frame) => {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        return JSON.parse(data!.slice(6));
      });
      assert.equal(parsed[0].type, 'message_start');
      assert.ok(parsed.some((event) => event.type === 'content_block_delta' && event.delta?.text === 'hello'));
      const delta = parsed.find((event) => event.type === 'message_delta');
      assert.deepEqual(delta.delta, { stop_reason: 'end_turn', stop_sequence: null });
      assert.deepEqual(delta.usage, { input_tokens: 6, output_tokens: 2 });
      assert.equal(parsed.at(-1).type, 'message_stop');
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('propagates Chat Completions rate-limit errors with their status and type', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'slow down' } }), {
      status: 429, headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
    try {
      await assert.rejects(
        postMessages({ model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] }),
        (error: any) => {
          // Upstream errors with a captured body surface as UpstreamApiError
          // (a ClaudeProxyError subclass carrying the raw upstream body).
          assert.ok(error instanceof ClaudeProxyError);
          assert.equal(error.type, 'rate_limit_error');
          assert.equal(error.status, 429);
          assert.match(error.message, /slow down/);
          assert.equal(JSON.parse(error.upstreamBody).error.message, 'slow down');
          return true;
        },
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('propagates Responses upstream failures instead of parsing them as success', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'bad gateway' } }), {
      status: 502, headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
    try {
      await assert.rejects(
        postMessages({ model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] }, 'openai-responses'),
        (error: any) => {
          assert.equal(error.status, 502);
          assert.match(error.message, /bad gateway/);
          return true;
        },
      );
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('derives reasoning effort from OpenAI-style thinking before removing it', async () => {
    const response = await postMessages({
      model: 'gpt-test',
      thinking: { enabled: true, budget_tokens: 4096 },
      messages: [{ role: 'user', content: 'Think carefully' }],
    });
    assert.equal(response.status, 200);
    assert.equal(upstreamCalls[0].body.reasoning_effort, 'high');
    assert.equal('thinking' in upstreamCalls[0].body, false);
  });

  it('converts OpenAI reasoning, tool calls, and tool results into Responses history', async () => {
    upstreamBody = {
      id: 'resp-history', object: 'response', created_at: 1, model: 'gpt-test',
      output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }],
    };
    const response = await postMessages({
      model: 'gpt-test',
      messages: [
        {
          role: 'assistant',
          reasoning_content: 'Use the lookup tool.',
          tool_calls: [{ id: 'call-lookup', type: 'function', function: { name: 'lookup', arguments: '{"q":"answer"}' } }],
        },
        { role: 'tool', tool_call_id: 'call-lookup', content: { answer: 42 } },
        { role: 'user', content: 'What did you find?' },
      ],
    }, 'openai-responses');

    assert.equal(response.status, 200);
    assertUpstreamBody({
      model: 'gpt-test',
      input: [
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'Use the lookup tool.' }] },
        { type: 'function_call', call_id: 'call-lookup', name: 'lookup', arguments: '{"q":"answer"}' },
        { type: 'function_call_output', call_id: 'call-lookup', output: '{"answer":42}' },
        { role: 'user', content: [{ type: 'input_text', text: 'What did you find?' }] },
      ],
      stream: false,
    });
  });
});
