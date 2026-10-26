import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  handleResponsesCompactRequest,
  handleResponsesInputTokensRequest,
  handleResponsesRequest,
} from '../../src/handlers/responses.js';

const TARGET_URL = 'https://upstream.example/v1/responses';
const ENV = { LOG_LEVEL: 'error' } as any;
const realFetch = globalThis.fetch;

let upstreamBody: Record<string, unknown>;
let upstreamCalls: Array<{
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}>;

function responsesRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://proxy${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function callHandler(
  handler: typeof handleResponsesRequest,
  path: string,
  body: Record<string, unknown>,
  upstreamMode?: string,
): Promise<Response> {
  return handler(
    responsesRequest(path, body),
    TARGET_URL,
    { Authorization: 'Bearer upstream-key' },
    'req-responses',
    'resolved-model',
    ENV,
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

describe('Responses endpoint handlers', () => {
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
    upstreamBody = {};
  });

  it('converts input_tokens requests and returns upstream prompt usage', async () => {
    upstreamBody = {
      id: 'chatcmpl-count',
      object: 'chat.completion',
      created: 1700000000,
      model: 'resolved-model',
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 37, completion_tokens: 1, total_tokens: 38 },
    };

    const response = await callHandler(handleResponsesInputTokensRequest, '/v1/responses/input_tokens', {
      model: 'client-model',
      instructions: 'Count exactly',
      input: 'How many tokens?',
      max_output_tokens: 50,
      temperature: 0.25,
    }, 'openai-completions');

    assertUpstreamBody({
      model: 'resolved-model',
      messages: [
        { role: 'system', content: 'Count exactly' },
        { role: 'user', content: 'How many tokens?' },
      ],
      stream: false,
      temperature: 0.25,
      max_tokens: 1,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'req-responses');
    assert.deepEqual(await response.json(), {
      object: 'response.input_tokens',
      input_tokens: 37,
    });
  });

  it('returns zero input tokens when a converted upstream response has no usage', async () => {
    upstreamBody = {
      id: 'chatcmpl-no-usage',
      object: 'chat.completion',
      created: 1700000000,
      model: 'resolved-model',
      choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
    };

    const response = await callHandler(handleResponsesInputTokensRequest, '/v1/responses/input_tokens', {
      model: 'client-model',
      input: 'No usage returned',
    }, 'openai-completions');

    assertUpstreamBody({
      model: 'resolved-model',
      messages: [{ role: 'user', content: 'No usage returned' }],
      stream: false,
      max_tokens: 1,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      object: 'response.input_tokens',
      input_tokens: 0,
    });
  });

  it('passes input_tokens requests and responses through unchanged', async () => {
    const requestBody = {
      model: 'client-model',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'Count this' }] }],
      max_output_tokens: 64,
    };
    upstreamBody = { object: 'response.input_tokens', input_tokens: 91 };

    const response = await callHandler(
      handleResponsesInputTokensRequest,
      '/v1/responses/input_tokens',
      requestBody,
      'openai-responses',
    );

    assertUpstreamBody(requestBody);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('x-request-id'), 'req-responses');
    assert.deepEqual(await response.json(), upstreamBody);
  });

  it('converts compact requests and wraps the completion as a compaction', async () => {
    upstreamBody = {
      id: 'compact-1',
      object: 'chat.completion',
      created: 1700000002,
      model: 'resolved-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Compacted conversation' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 19,
        completion_tokens: 4,
        total_tokens: 23,
        prompt_cache_hit_tokens: 6,
      },
    };

    const response = await callHandler(handleResponsesCompactRequest, '/v1/responses/compact', {
      model: 'client-model',
      instructions: 'Compact this conversation',
      input: 'Long conversation',
      max_output_tokens: 100,
    }, 'openai-completions');

    assertUpstreamBody({
      model: 'resolved-model',
      messages: [
        { role: 'system', content: 'Compact this conversation' },
        { role: 'user', content: 'Long conversation' },
      ],
      stream: false,
      max_tokens: 100,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'req-responses');
    const body = await response.json() as any;
    assert.match(body.output[0].id, /^msg_[a-f0-9]{12}$/);
    assert.deepEqual(body, {
      id: 'resp_compact-1',
      object: 'response.compaction',
      created_at: 1700000002,
      output: [{
        id: body.output[0].id,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Compacted conversation', annotations: [] }],
      }],
      usage: {
        input_tokens: 19,
        output_tokens: 4,
        total_tokens: 23,
        input_tokens_details: { cached_tokens: 6 },
      },
    });
  });

  it('passes compact requests and responses through unchanged', async () => {
    const requestBody = {
      model: 'client-model',
      input: 'Compact verbatim',
      stream: false,
    };
    upstreamBody = {
      id: 'resp-compact-upstream',
      object: 'response.compaction',
      created_at: 1700000003,
      output: [{ type: 'message', role: 'assistant', content: [] }],
      usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
    };

    const response = await callHandler(
      handleResponsesCompactRequest,
      '/v1/responses/compact',
      requestBody,
      'openai-responses',
    );

    assertUpstreamBody(requestBody);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'req-responses');
    assert.deepEqual(await response.json(), upstreamBody);
  });

  it('passes default Responses requests and responses through unchanged', async () => {
    const requestBody = {
      model: 'client-model',
      input: 'Leave this untouched',
      instructions: 'No conversion',
      max_output_tokens: 32,
      store: false,
    };
    upstreamBody = {
      id: 'resp-passthrough',
      object: 'response',
      created_at: 1700000004,
      status: 'completed',
      model: 'client-model',
      output: [],
      store: false,
    };

    const response = await callHandler(handleResponsesRequest, '/v1/responses', requestBody);

    assertUpstreamBody(requestBody);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('x-request-id'), 'req-responses');
    assert.deepEqual(await response.json(), upstreamBody);
  });

  it('converts Anthropic tool-use responses and preserves cache usage', async () => {
    upstreamBody = {
      id: 'msg-anthropic',
      type: 'message',
      role: 'assistant',
      model: 'claude-upstream',
      content: [
        { type: 'text', text: 'I will look that up.' },
        {
          type: 'tool_use',
          id: 'toolu-weather',
          name: 'get_weather',
          input: { city: 'Paris' },
        },
      ],
      stop_reason: 'tool_use',
      usage: {
        input_tokens: 21,
        output_tokens: 8,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
      },
    };

    const response = await callHandler(handleResponsesRequest, '/v1/responses', {
      model: 'client-model',
      instructions: 'Use tools when needed',
      input: 'What is the weather in Paris?',
      max_output_tokens: 128,
      tools: [{
        type: 'function',
        name: 'get_weather',
        description: 'Get current weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      }],
    }, 'anthropic-messages');

    assertUpstreamBody({
      model: 'resolved-model',
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      max_tokens: 128,
      stream: false,
      system: 'Use tools when needed',
      tools: [{
        name: 'get_weather',
        description: 'Get current weather',
        input_schema: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      }],
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'req-responses');
    const body = await response.json() as any;
    assert.match(body.id, /^resp_[a-f0-9]{32}$/);
    assert.match(body.output[0].id, /^msg_[a-f0-9]{12}$/);
    assert.equal(typeof body.created_at, 'number');
    assert.deepEqual(body, {
      id: body.id,
      object: 'response',
      created_at: body.created_at,
      status: 'completed',
      model: 'claude-upstream',
      output: [
        {
          id: body.output[0].id,
          type: 'message',
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'I will look that up.', annotations: [] }],
        },
        {
          id: 'toolu-weather',
          type: 'function_call',
          status: 'completed',
          name: 'get_weather',
          arguments: '{"city":"Paris"}',
          call_id: 'toolu-weather',
        },
      ],
      usage: {
        input_tokens: 21,
        output_tokens: 8,
        total_tokens: 29,
        input_tokens_details: { cached_tokens: 5 },
      },
    });
  });
});
