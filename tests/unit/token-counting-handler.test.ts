import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { handleTokenCountingRequest } from '../../src/handlers/token-counting.js';
import type { Logger } from '../../src/types/shared.js';
import {
  countClaudeRequestTokens,
  getTiktokenTokenizer,
} from '../../src/utils/token-counting.js';

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const originalFetch = globalThis.fetch;
const targetUrl = 'https://upstream.test/v1/messages/count_tokens';
const requestId = 'req-token-counting';
const authHeaders = { Authorization: 'Bearer upstream-key' };

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function validBody(): Record<string, unknown> {
  return {
    model: 'claude-sonnet-test',
    messages: [{ role: 'user', content: 'Hello' }],
  };
}

function makeRequest(body: Record<string, unknown>): Request {
  return new Request('http://proxy.test/v1/messages/count_tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function handle(
  body: Record<string, unknown>,
  options: {
    targetUrl?: string;
    authHeaders?: Record<string, string>;
    env?: Record<string, string>;
  } = {},
): Promise<Response> {
  return handleTokenCountingRequest(
    makeRequest(body),
    options.targetUrl ?? targetUrl,
    options.authHeaders ?? authHeaders,
    requestId,
    options.env as never,
    silentLogger,
  );
}

function stubFetch(response: Response): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return response;
  }) as typeof fetch;
  return () => calls;
}

describe('handleTokenCountingRequest API counting', () => {
  it('converts the request, calls chat completions, and returns prompt token usage', async () => {
    const body = {
      ...validBody(),
      system: 'Be concise.',
    };
    let capturedUrl: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'Hi' } }],
        usage: { prompt_tokens: 37, completion_tokens: 1, total_tokens: 38 },
      }), { status: 200 });
    }) as typeof fetch;

    const response = await handle(body);

    assert.equal(capturedUrl, 'https://upstream.test/v1/chat/completions');
    assert.ok(capturedInit);
    assert.equal(capturedInit.method, 'POST');
    assert.deepEqual(capturedInit.headers, {
      'Content-Type': 'application/json',
      Authorization: 'Bearer upstream-key',
    });
    assert.deepEqual(JSON.parse(String(capturedInit.body)), {
      model: 'claude-sonnet-test',
      messages: [
        { role: 'system', content: 'Be concise.' },
        { role: 'user', content: 'Hello' },
      ],
      max_tokens: 1,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), requestId);
    assert.equal(response.headers.get('x-token-counting'), 'api');
    assert.deepEqual(await response.json(), { type: 'token_count', input_tokens: 37 });
  });

  it('uses a custom target URL unchanged', async () => {
    const customUrl = 'https://upstream.test/custom/token-count';
    let capturedUrl: string | URL | Request | undefined;
    globalThis.fetch = (async (url) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ usage: { prompt_tokens: 11 } }), { status: 200 });
    }) as typeof fetch;

    const response = await handle(validBody(), { targetUrl: customUrl });

    assert.equal(capturedUrl, customUrl);
    assert.deepEqual(await response.json(), { type: 'token_count', input_tokens: 11 });
  });

  it('returns zero when a successful upstream response has no usage', async () => {
    stubFetch(new Response(JSON.stringify({ choices: [] }), { status: 200 }));

    const response = await handle(validBody());

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-token-counting'), 'api');
    assert.deepEqual(await response.json(), { type: 'token_count', input_tokens: 0 });
  });

  it('falls back on non-OK responses using only user string and text-block characters', async () => {
    stubFetch(new Response('upstream failed', { status: 503 }));
    const body = {
      model: 'claude-sonnet-test',
      system: 'S'.repeat(90),
      messages: [
        { role: 'user', content: 'abcdef' },
        { role: 'assistant', content: 'A'.repeat(90) },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'abcde' },
            { type: 'image', source: { type: 'url', url: 'https://images.test/ignored.png' } },
          ],
        },
      ],
    };

    const response = await handle(body);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), requestId);
    assert.equal(response.headers.get('x-token-counting'), 'chars-fallback');
    assert.deepEqual(await response.json(), { type: 'token_count', input_tokens: 3 });
  });

  it('validates the request and auth before any upstream fetch', async () => {
    const calls = stubFetch(new Response(JSON.stringify({ usage: { prompt_tokens: 99 } }), { status: 200 }));
    const cases: Array<{
      body: Record<string, unknown>;
      authHeaders?: Record<string, string>;
      message: string;
    }> = [
      {
        body: { messages: [{ role: 'user', content: 'Hello' }] },
        message: 'model field is required',
      },
      {
        body: { model: 'claude-sonnet-test', messages: [] },
        message: 'messages array must not be empty',
      },
      {
        body: validBody(),
        authHeaders: {},
        message: 'Either Authorization header or x-api-key header is required',
      },
    ];

    for (const testCase of cases) {
      await assert.rejects(
        handle(testCase.body, { authHeaders: testCase.authHeaders }),
        { name: 'ValidationError', message: testCase.message },
      );
    }
    assert.equal(calls(), 0);
  });
});

describe('handleTokenCountingRequest local tiktoken counting', () => {
  it('returns the real tokenizer count without fetching upstream', async () => {
    const body = {
      model: 'claude-sonnet-test',
      system: 'Count this prompt exactly.',
      messages: [
        { role: 'user', content: 'The quick brown fox jumps over the lazy dog.' },
        { role: 'assistant', content: [{ type: 'text', text: 'A deterministic answer.' }] },
      ],
    };
    const tokenizer = await getTiktokenTokenizer('cl100k_base');
    const expected = countClaudeRequestTokens(body, {
      useLocalCounting: true,
      tokenizer,
      countWhitespace: true,
    });
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      throw new Error('local counting must not call upstream');
    }) as typeof fetch;

    const response = await handle(body, {
      env: { LOCAL_TIKTOKEN: 'true', TIKTOKEN_MODEL: 'cl100k_base' },
    });

    assert.equal(calls, 0);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-token-counting'), 'tiktoken');
    assert.equal(response.headers.get('x-request-id'), requestId);
    assert.deepEqual(await response.json(), { type: 'token_count', input_tokens: expected });
  });
});
