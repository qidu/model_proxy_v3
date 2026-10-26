import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { handleEmbeddingsRequest } from '../../src/handlers/embeddings.js';
import type { Env, Logger } from '../../src/types/shared.js';

const silentLogger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

const originalFetch = globalThis.fetch;
const targetUrl = 'https://upstream.test/v1/embeddings';
const requestId = 'req-embeddings';
const authHeaders = { Authorization: 'Bearer upstream-key' };

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeRequest(body: string, headers: Record<string, string> = {}): Request {
  return new Request('http://proxy.test/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
}

function stubFetch(response: Response | (() => Response)): () => number {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return typeof response === 'function' ? response() : response;
  }) as typeof fetch;
  return () => calls;
}

async function handle(body: string, headers?: Record<string, string>): Promise<Response> {
  return handleEmbeddingsRequest(
    makeRequest(body, headers),
    targetUrl,
    authHeaders,
    requestId,
    silentLogger,
    {} as Env,
  );
}

describe('handleEmbeddingsRequest', () => {
  it('rejects malformed JSON without calling upstream', async () => {
    const calls = stubFetch(new Response('{}'));

    const response = await handle('{not-json');

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      type: 'error',
      error: { type: 'error', message: 'Invalid JSON body' },
    });
    assert.equal(calls(), 0);
  });

  it('rejects missing, empty, and non-string models without calling upstream', async () => {
    const calls = stubFetch(new Response('{}'));

    for (const model of [undefined, null, '', 42]) {
      const response = await handle(JSON.stringify({ model, input: 'text' }));
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        type: 'error',
        error: { type: 'error', message: 'Missing required field: model' },
      });
    }
    assert.equal(calls(), 0);
  });

  it('rejects missing and null input without calling upstream', async () => {
    const calls = stubFetch(new Response('{}'));

    for (const body of [{ model: 'text-embedding-3-small' }, { model: 'text-embedding-3-small', input: null }]) {
      const response = await handle(JSON.stringify(body));
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), {
        type: 'error',
        error: { type: 'error', message: 'Missing required field: input' },
      });
    }
    assert.equal(calls(), 0);
  });

  it('accepts valid falsy inputs and forwards each one unchanged', async () => {
    const inputs: unknown[] = ['', 0, false, []];
    const forwarded: unknown[] = [];
    globalThis.fetch = (async (_url, init) => {
      forwarded.push(JSON.parse(String(init?.body)).input);
      return new Response('{"data":[]}', { status: 200 });
    }) as typeof fetch;

    for (const input of inputs) {
      const response = await handle(JSON.stringify({ model: 'text-embedding-3-small', input }));
      assert.equal(response.status, 200);
    }

    assert.deepEqual(forwarded, inputs);
  });

  it('forwards the exact method, URL, auth, client IP, and JSON body upstream', async () => {
    const body = {
      model: 'text-embedding-3-small',
      input: ['first', 'second'],
      encoding_format: 'float',
      dimensions: 256,
    };
    let capturedUrl: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response('{"data":[]}', { status: 200 });
    }) as typeof fetch;

    const response = await handleEmbeddingsRequest(
      makeRequest(JSON.stringify(body), {
        'cf-connecting-ip': '203.0.113.9',
        'x-forwarded-for': '198.51.100.4',
      }),
      targetUrl,
      { Authorization: 'Bearer exact-key', 'x-api-key': 'secondary-key' },
      requestId,
      silentLogger,
      { UPSTREAM_BODY_TIMEOUT_MS: '1000' } as Env,
    );

    assert.equal(response.status, 200);
    assert.equal(capturedUrl, targetUrl);
    assert.ok(capturedInit);
    assert.equal(capturedInit.method, 'POST');
    assert.deepEqual(capturedInit.headers, {
      'Content-Type': 'application/json',
      Authorization: 'Bearer exact-key',
      'x-api-key': 'secondary-key',
      'x-forwarded-for': '203.0.113.9',
    });
    assert.equal(capturedInit.body, JSON.stringify(body));
  });

  it('removes only the provider field from a successful upstream response', async () => {
    stubFetch(new Response(JSON.stringify({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.25] }],
      model: 'text-embedding-3-small',
      provider: 'upstream-provider',
      usage: { prompt_tokens: 2, total_tokens: 2 },
    }), { status: 200 }));

    const response = await handle(JSON.stringify({ model: 'text-embedding-3-small', input: 'hi' }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), requestId);
    assert.deepEqual(await response.json(), {
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.25] }],
      model: 'text-embedding-3-small',
      usage: { prompt_tokens: 2, total_tokens: 2 },
    });
  });

  it('forwards a non-OK upstream status and body unchanged', async () => {
    const upstreamBody = JSON.stringify({ error: { message: 'quota exceeded' } });
    stubFetch(new Response(upstreamBody, { status: 429 }));

    const response = await handle(JSON.stringify({ model: 'text-embedding-3-small', input: 'hi' }));

    assert.equal(response.status, 429);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('x-request-id'), requestId);
    assert.equal(await response.text(), upstreamBody);
  });

  it('returns 502 for malformed successful upstream JSON', async () => {
    stubFetch(new Response('<html>not json</html>', { status: 200 }));

    const response = await handle(JSON.stringify({ model: 'text-embedding-3-small', input: 'hi' }));

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), {
      type: 'error',
      error: { type: 'error', message: 'Invalid upstream response' },
    });
  });

  it('propagates an upstream fetch rejection', async () => {
    const failure = new Error('upstream unavailable');
    globalThis.fetch = (async () => {
      throw failure;
    }) as typeof fetch;

    await assert.rejects(
      handle(JSON.stringify({ model: 'text-embedding-3-small', input: 'hi' })),
      (error: unknown) => error === failure,
    );
  });
});

// ---------------------------------------------------------------------------
// upstream_mode "ollama-embed": Ollama's native POST /api/embed
// ---------------------------------------------------------------------------

const ollamaTargetUrl = 'http://ollama.test:11434/api/embed';

const ollamaResponse = {
  model: 'nomic-embed-text',
  embeddings: [[0.1, 0.2], [0.3, 0.4]],
  total_duration: 1234567,
  load_duration: 890,
  prompt_eval_count: 11,
};

async function handleOllama(
  body: string,
  upstreamMode: string | undefined = 'ollama-embed',
): Promise<Response> {
  return handleEmbeddingsRequest(
    makeRequest(body),
    ollamaTargetUrl,
    authHeaders,
    requestId,
    silentLogger,
    {} as Env,
    upstreamMode,
  );
}

/** Like stubFetch, but records every parsed request body sent upstream. */
function stubFetchRecording(response: Response | (() => Response)): Record<string, unknown>[] {
  const bodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return typeof response === 'function' ? response() : response;
  }) as typeof fetch;
  return bodies;
}

describe('handleEmbeddingsRequest with upstream_mode "ollama-embed"', () => {
  it('converts the request to the /api/embed shape, dropping OpenAI-only fields', async () => {
    const bodies = stubFetchRecording(new Response(JSON.stringify(ollamaResponse), { status: 200 }));

    const response = await handleOllama(JSON.stringify({
      model: 'nomic-embed-text',
      input: ['first', 'second'],
      encoding_format: 'float',
      dimensions: 256,
      user: 'user-1',
    }));

    assert.equal(response.status, 200);
    assert.deepEqual(bodies, [{
      model: 'nomic-embed-text',
      input: ['first', 'second'],
      dimensions: 256,
    }]);
  });

  it('forwards the Ollama-native truncate, keep_alive, and options fields', async () => {
    const bodies = stubFetchRecording(new Response(JSON.stringify(ollamaResponse), { status: 200 }));

    await handleOllama(JSON.stringify({
      model: 'nomic-embed-text',
      input: 'hi',
      truncate: false,
      keep_alive: '5m',
      options: { num_ctx: 8192 },
    }));

    assert.deepEqual(bodies, [{
      model: 'nomic-embed-text',
      input: 'hi',
      truncate: false,
      keep_alive: '5m',
      options: { num_ctx: 8192 },
    }]);
  });

  it('converts the /api/embed response to the OpenAI shape, dropping the timing fields', async () => {
    stubFetch(new Response(JSON.stringify(ollamaResponse), { status: 200 }));

    const response = await handleOllama(JSON.stringify({ model: 'nomic-embed-text', input: ['a', 'b'] }));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('x-request-id'), requestId);
    assert.deepEqual(await response.json(), {
      object: 'list',
      data: [
        { object: 'embedding', embedding: [0.1, 0.2], index: 0 },
        { object: 'embedding', embedding: [0.3, 0.4], index: 1 },
      ],
      model: 'nomic-embed-text',
      usage: { prompt_tokens: 11, total_tokens: 11 },
    });
  });

  it('reports zero usage when the upstream omits prompt_eval_count', async () => {
    stubFetch(new Response(JSON.stringify({ model: 'nomic-embed-text', embeddings: [[0.5]] }), { status: 200 }));

    const response = await handleOllama(JSON.stringify({ model: 'nomic-embed-text', input: 'hi' }));

    assert.equal(response.status, 200);
    assert.deepEqual((await response.json() as { usage: unknown }).usage, {
      prompt_tokens: 0,
      total_tokens: 0,
    });
  });

  it('falls back to the requested model when the upstream omits it', async () => {
    stubFetch(new Response(JSON.stringify({ embeddings: [[0.5]] }), { status: 200 }));

    const response = await handleOllama(JSON.stringify({ model: 'nomic-embed-text', input: 'hi' }));

    assert.equal((await response.json() as { model: unknown }).model, 'nomic-embed-text');
  });

  it('rejects encoding_format "base64" without calling upstream', async () => {
    const calls = stubFetch(new Response(JSON.stringify(ollamaResponse), { status: 200 }));

    const response = await handleOllama(JSON.stringify({
      model: 'nomic-embed-text',
      input: 'hi',
      encoding_format: 'base64',
    }));

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      type: 'error',
      error: {
        type: 'error',
        message: 'encoding_format "base64" is not supported by the "ollama-embed" upstream: Ollama\'s POST /api/embed returns float arrays only',
      },
    });
    assert.equal(calls(), 0);
  });

  it('returns 502 when the upstream returns no usable embeddings array', async () => {
    for (const upstreamBody of [{}, { embeddings: 'nope' }, { embeddings: [1, 2] }]) {
      stubFetch(new Response(JSON.stringify(upstreamBody), { status: 200 }));

      const response = await handleOllama(JSON.stringify({ model: 'nomic-embed-text', input: 'hi' }));

      assert.equal(response.status, 502, `expected 502 for ${JSON.stringify(upstreamBody)}`);
      assert.deepEqual(await response.json(), {
        type: 'error',
        error: {
          type: 'error',
          message: 'Invalid upstream response: POST /api/embed returned no usable "embeddings" array',
        },
      });
    }
  });

  it('accepts an empty embeddings array as a successful empty result', async () => {
    stubFetch(new Response(JSON.stringify({ model: 'nomic-embed-text', embeddings: [], prompt_eval_count: 0 }), { status: 200 }));

    const response = await handleOllama(JSON.stringify({ model: 'nomic-embed-text', input: [] }));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      object: 'list',
      data: [],
      model: 'nomic-embed-text',
      usage: { prompt_tokens: 0, total_tokens: 0 },
    });
  });

  it('forwards a non-OK upstream status and body unchanged', async () => {
    const upstreamBody = JSON.stringify({ error: 'model "nomic-embed-text" not found' });
    stubFetch(new Response(upstreamBody, { status: 404 }));

    const response = await handleOllama(JSON.stringify({ model: 'nomic-embed-text', input: 'hi' }));

    assert.equal(response.status, 404);
    assert.equal(response.headers.get('x-request-id'), requestId);
    assert.equal(await response.text(), upstreamBody);
  });

  it('leaves the body byte-identical when upstream_mode is absent or "openai-completions"', async () => {
    const body = {
      model: 'text-embedding-3-small',
      input: ['a', 'b'],
      encoding_format: 'base64',
      user: 'user-1',
    };

    // 6-arg call: `upstream_mode` absent from [models.EMBEDDING].
    const absentBodies = stubFetchRecording(new Response('{"data":[]}', { status: 200 }));
    const absentResponse = await handleEmbeddingsRequest(
      makeRequest(JSON.stringify(body)),
      ollamaTargetUrl,
      authHeaders,
      requestId,
      silentLogger,
      {} as Env,
    );
    assert.equal(absentResponse.status, 200);
    assert.deepEqual(absentBodies, [body], 'an absent upstream_mode must not reshape the body');

    const explicitBodies = stubFetchRecording(new Response('{"data":[]}', { status: 200 }));
    const explicitResponse = await handleOllama(JSON.stringify(body), 'openai-completions');
    assert.equal(explicitResponse.status, 200);
    assert.deepEqual(explicitBodies, [body], '"openai-completions" must not reshape the body');
  });
});
