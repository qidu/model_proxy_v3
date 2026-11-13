import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleMessagesRequest } from '../../src/handlers/messages.js';
import { countClaudeRequestTokens } from '../../src/utils/token-counting.js';
import { ClaudeProxyError } from '../../src/utils/errors.js';
import type { Logger } from '../../src/utils/logger.js';

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

function recordingLogger(traceEnabled: boolean): Logger & { traces: string[] } {
  const traces: string[] = [];
  return {
    traceEnabled,
    traces,
    // Gates like the real logger does, so a trace-off run records nothing even
    // though `logPipelineHeaders` does not check `traceEnabled` itself.
    trace(_requestId: string, message: string) {
      if (traceEnabled) traces.push(message);
    },
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function messagesRequest(body: Record<string, unknown>): Request {
  return new Request('http://proxy/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postMessages(
  body: Record<string, unknown>,
  upstreamMode = 'openai-completions',
  logger?: Logger,
): Promise<Response> {
  return handleMessagesRequest(
    messagesRequest(body),
    TARGET_URL,
    { Authorization: 'Bearer upstream-key' },
    'req-messages',
    'gpt-test',
    ENV,
    logger,
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
      stop_sequence: null,
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
      stop_sequence: null,
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
        type: 'message',
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
      stop_sequence: null,
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
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check Paris' }] },
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'I need the weather tool.' }] },
      { type: 'function_call', call_id: 'call-weather', name: 'get_weather', arguments: '{"city":"Paris"}' },
      { type: 'function_call_output', call_id: 'call-weather', output: 'sunny' },
    ]);
  });

  it('preserves assistant image content alongside tool calls in Responses history', async () => {
    const response = await postMessages({
      model: 'gpt-test',
      messages: [{
        role: 'assistant',
        content: [{
          type: 'image_url',
          image_url: { url: 'https://example.com/cat.png', detail: 'high' },
        }],
        tool_calls: [{
          id: 'call-lookup',
          type: 'function',
          function: { name: 'lookup', arguments: '{"q":"cat"}' },
        }],
      }],
    }, 'openai-responses');

    assert.equal(response.status, 200);
    assert.equal(upstreamCalls.length, 1);
    assert.deepEqual(upstreamCalls[0].body.input, [
      { type: 'function_call', call_id: 'call-lookup', name: 'lookup', arguments: '{"q":"cat"}' },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'input_image', image_url: 'https://example.com/cat.png', detail: 'high' }],
      },
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
      const requestBody = {
        model: 'gpt-test',
        stream: true,
        messages: [{ role: 'user', content: 'Weather?' }],
      };
      const response = await postMessages(requestBody, 'openai-responses');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-type'), 'text/event-stream');
      const text = await response.text();
      const parsed = text.split('\n\n').filter(Boolean).map((frame) => {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        return JSON.parse(data!.slice(6));
      });

      assert.equal(parsed[0].type, 'message_start');
      // §5.3: the pre-stream estimate over the request body is reported up front,
      // before the response stream exists — not the upstream usage (8) that only
      // arrives later on response.completed.
      assert.equal(
        parsed[0].message.usage.input_tokens,
        countClaudeRequestTokens(requestBody as any, { useLocalCounting: true, tokenizer: null }),
      );
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

  it('ends a truncated Responses stream with stop_reason max_tokens instead of aborting it', async () => {
    const previousFetch = globalThis.fetch;
    const events = [
      { type: 'response.output_text.delta', delta: 'The sea ' },
      { type: 'response.output_text.delta', delta: 'is vast' },
      { type: 'response.output_text.done', text: 'The sea is vast' },
      {
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 37, output_tokens: 256 },
        },
      },
      // After the terminal event: must not reach the client.
      { type: 'response.output_text.delta', delta: 'never forwarded' },
    ];
    globalThis.fetch = (async () => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as typeof fetch;

    try {
      const response = await postMessages({
        model: 'gpt-test', stream: true, messages: [{ role: 'user', content: 'essay' }],
      }, 'openai-responses');

      // Resolves rather than rejecting: the client gets a terminated message.
      const text = await response.text();
      const parsed = text.split('\n\n').filter(Boolean).map((frame) => {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        return JSON.parse(data!.slice(6));
      });

      assert.deepEqual(parsed.map((p: any) => p.type), [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);
      assert.deepEqual(parsed[2].delta, { type: 'text_delta', text: 'The sea ' });
      assert.deepEqual(parsed[5].delta, { stop_reason: 'max_tokens', stop_sequence: null });
      // Usage comes from the incomplete event's response, not the pre-stream estimate.
      assert.deepEqual(parsed[5].usage, { input_tokens: 37, output_tokens: 256 });
      assert.equal(text.includes('never forwarded'), false);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('reports a truncated tool call as max_tokens, never as tool_use', async () => {
    const previousFetch = globalThis.fetch;
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-weather', name: 'get_weather' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"city":' },
      {
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 8, output_tokens: 16 },
        },
      },
    ];
    globalThis.fetch = (async () => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as typeof fetch;

    try {
      const response = await postMessages({
        model: 'gpt-test', stream: true, messages: [{ role: 'user', content: 'Weather?' }],
      }, 'openai-responses');
      const text = await response.text();
      const parsed = text.split('\n\n').filter(Boolean).map((frame) => {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        return JSON.parse(data!.slice(6));
      });

      const messageDelta = parsed.find((p: any) => p.type === 'message_delta');
      assert.deepEqual(messageDelta!.delta, { stop_reason: 'max_tokens', stop_sequence: null });
      // The truncated tool block is closed before the stop event, not left open.
      const stopIndex = parsed.findIndex((p: any) => p.type === 'content_block_stop');
      assert.deepEqual(parsed[stopIndex], { type: 'content_block_stop', index: 0 });
      assert.ok(stopIndex < parsed.indexOf(messageDelta!));
      assert.deepEqual(parsed[parsed.length - 1], { type: 'message_stop' });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('closes a content block the truncated stream left open, exactly once', async () => {
    const previousFetch = globalThis.fetch;
    // No `response.output_text.done`: upstream truncates with the block still open.
    const events = [
      { type: 'response.output_text.delta', delta: 'The sea ' },
      {
        type: 'response.incomplete',
        response: {
          status: 'incomplete',
          incomplete_details: { reason: 'max_output_tokens' },
          usage: { input_tokens: 37, output_tokens: 256 },
        },
      },
    ];
    globalThis.fetch = (async () => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as typeof fetch;

    try {
      const response = await postMessages({
        model: 'gpt-test', stream: true, messages: [{ role: 'user', content: 'essay' }],
      }, 'openai-responses');
      const text = await response.text();
      const parsed = text.split('\n\n').filter(Boolean).map((frame) => {
        const data = frame.split('\n').find((line) => line.startsWith('data: '));
        return JSON.parse(data!.slice(6));
      });

      assert.deepEqual(parsed.map((p: any) => p.type), [
        'message_start',
        'content_block_start',
        'content_block_delta',
        'content_block_stop',
        'message_delta',
        'message_stop',
      ]);
      assert.deepEqual(parsed[3], { type: 'content_block_stop', index: 0 });
      assert.deepEqual(parsed[4].delta, { stop_reason: 'max_tokens', stop_sequence: null });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('traces the upstream Responses SSE at TRACE and stays silent below it', async () => {
    const previousFetch = globalThis.fetch;
    const events = [
      { type: 'response.output_text.delta', delta: 'The sea ' },
      { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 } } },
    ];
    globalThis.fetch = (async () => new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as typeof fetch;

    try {
      const traced = recordingLogger(true);
      const response = await postMessages({
        model: 'gpt-test', stream: true, messages: [{ role: 'user', content: 'essay' }],
      }, 'openai-responses', traced);
      // The trace must not consume the stream the client reads.
      const text = await response.text();
      assert.equal(text.includes('"type":"message_stop"'), true);

      const upstream = traced.traces.filter((line) => line.startsWith('[UPSTREAM-RESP]'));
      assert.equal(upstream.length, 2);
      // Each line carries one upstream event, verbatim.
      assert.deepEqual(
        JSON.parse(upstream[0].slice(upstream[0].indexOf(': ') + 2)),
        events[0],
      );
      assert.deepEqual(
        JSON.parse(upstream[1].slice(upstream[1].indexOf(': ') + 2)),
        events[1],
      );

      const quiet = recordingLogger(false);
      const quietResponse = await postMessages({
        model: 'gpt-test', stream: true, messages: [{ role: 'user', content: 'essay' }],
      }, 'openai-responses', quiet);
      await quietResponse.text();
      assert.deepEqual(quiet.traces, []);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('aborts a Responses SSE stream that ends before response.completed', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as typeof fetch;

    try {
      const response = await postMessages({
        model: 'gpt-test', stream: true, messages: [{ role: 'user', content: 'hello' }],
      }, 'openai-responses');
      await assert.rejects(response.text(), /Responses stream ended before response\.completed/);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('aborts on malformed Responses SSE JSON instead of skipping it and reporting success', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(
      'data: {bad json}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )) as typeof fetch;

    try {
      const response = await postMessages({
        model: 'gpt-test', stream: true, messages: [{ role: 'user', content: 'hello' }],
      }, 'openai-responses');
      await assert.rejects(response.text(), /Invalid JSON in Responses SSE data/);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it('propagates a Responses upstream read failure instead of closing cleanly', async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"partial"}\n\n'));
        controller.error(new Error('upstream reset'));
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch;

    try {
      const response = await postMessages({
        model: 'gpt-test', stream: true, messages: [{ role: 'user', content: 'hello' }],
      }, 'openai-responses');
      await assert.rejects(response.text(), /upstream reset/);
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
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Use a tool' }] }],
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
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What did you find?' }] },
      ],
      stream: false,
    });
  });
});
