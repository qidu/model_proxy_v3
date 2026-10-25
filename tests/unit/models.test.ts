import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  clearModelCache,
  getCachedModelCount,
  getCachedModels,
  getModelCount,
  handleAnthropicModelsDiscovery,
  handleModelsRequest,
  isAnthropicModelDiscoveryEnabled,
  setCachedModels,
} from '../../src/handlers/models.js';
import type { Logger } from '../../src/utils/logger.js';
import { ValidationError } from '../../src/utils/errors.js';
import type { OpenAIModel, OpenAIModelsResponse } from '../../src/types/openai.js';

const TARGET_URL = 'https://upstream.example/v1/models';
const REQUEST_ID = 'req_models_test';
const realFetch = globalThis.fetch;

const logger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function model(id: string, ownedBy = 'upstream'): OpenAIModel {
  return { id, object: 'model', created: 123, owned_by: ownedBy };
}

function modelList(...ids: string[]): OpenAIModelsResponse {
  return { object: 'list', data: ids.map((id) => model(id)) };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function mockFetch(handler: (call: FetchCall) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

function modelsRequest(query = '', headers?: Record<string, string>): Request {
  return new Request(`https://proxy.example/v1/models${query}`, { headers });
}

function discoveryRequest(headers?: Record<string, string>): Request {
  return modelsRequest('?limit=20', headers);
}

async function expectHeaders(response: Response, requestId = REQUEST_ID, cache?: 'HIT' | 'MISS'): Promise<void> {
  assert.equal(response.headers.get('Content-Type'), 'application/json');
  assert.equal(response.headers.get('x-request-id'), requestId);
  assert.equal(response.headers.get('x-cache'), cache ?? null);
}

describe('models handlers', () => {
  beforeEach(() => {
    clearModelCache();
    globalThis.fetch = (async () => {
      throw new Error('unexpected unmocked fetch');
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    clearModelCache();
  });

  describe('model cache and counts', () => {
    it('reports an empty cache for both models and counts', () => {
      assert.equal(getCachedModels(1000), null);
      assert.equal(getCachedModelCount(), null);
      assert.equal(getCachedModelCount({ MODELS_CACHE_TTL: '1' }), null);
    });

    it('returns cached data and counts until the cache is cleared', () => {
      const cached = modelList('one', 'two');
      setCachedModels(cached);

      assert.equal(getCachedModels(300000), cached);
      assert.equal(getCachedModelCount(), 2);
      assert.equal(getCachedModelCount({ MODELS_CACHE_TTL: '300' }), 2);

      clearModelCache();
      assert.equal(getCachedModels(300000), null);
      assert.equal(getCachedModelCount(), null);
    });

    it('expires cached models and counts at the configured TTL boundary', (t) => {
      t.mock.timers.enable({ apis: ['Date'], now: 1000 });
      setCachedModels(modelList('expiring'));

      t.mock.timers.tick(999);
      assert.deepEqual(getCachedModels(1000)?.data.map(({ id }) => id), ['expiring']);
      assert.equal(getCachedModelCount({ MODELS_CACHE_TTL: '1' }), 1);

      t.mock.timers.tick(1);
      assert.equal(getCachedModels(1000), null);
      assert.equal(getCachedModelCount({ MODELS_CACHE_TTL: '1' }), null);
    });

    it('returns zero for a cached empty model list', () => {
      setCachedModels(modelList());
      assert.equal(getCachedModelCount(), 0);
    });
  });

  describe('getModelCount', () => {
    it('fetches with auth, caches the merged response, and returns its count', async () => {
      const calls = mockFetch(() => jsonResponse(modelList('one', 'two')));

      const result = await getModelCount(
        TARGET_URL,
        { Authorization: 'Bearer secret', 'x-api-key': 'key' },
        REQUEST_ID,
        logger,
      );

      assert.deepEqual(result, { count: 2, cached: false });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, TARGET_URL);
      assert.equal(calls[0].init?.method, 'GET');
      assert.deepEqual(calls[0].init?.headers, {
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret',
        'x-api-key': 'key',
      });
      assert.ok(calls[0].init?.signal instanceof AbortSignal);
      assert.equal(getCachedModelCount(), 2);
    });

    it('uses the cache without fetching upstream', async () => {
      const calls = mockFetch(() => jsonResponse(modelList('unexpected')));
      setCachedModels(modelList('cached-one', 'cached-two', 'cached-three'));

      assert.deepEqual(
        await getModelCount(TARGET_URL, {}, REQUEST_ID, logger),
        { count: 3, cached: true },
      );
      assert.equal(calls.length, 0);
    });

    it('returns zero and does not cache a non-OK upstream response', async () => {
      const calls = mockFetch(() => jsonResponse({ error: 'unavailable' }, 503));

      assert.deepEqual(
        await getModelCount(TARGET_URL, {}, REQUEST_ID, logger),
        { count: 0, cached: false },
      );
      assert.equal(calls.length, 1);
      assert.equal(getCachedModelCount(), null);
    });

    it('returns zero for network failures and malformed JSON without caching', async () => {
      for (const response of [
        () => Promise.reject(new Error('network down')),
        () => new Response('not-json', { status: 200 }),
      ]) {
        const calls = mockFetch(response);
        assert.deepEqual(
          await getModelCount(TARGET_URL, {}, REQUEST_ID, logger),
          { count: 0, cached: false },
        );
        assert.equal(calls.length, 1);
        assert.equal(getCachedModelCount(), null);
      }
    });
  });

  describe('handleModelsRequest', () => {
    it('merges and deduplicates upstream/config models on a cache MISS', async () => {
      const calls = mockFetch(() => jsonResponse(modelList('shared', 'upstream-only')));
      const request = modelsRequest('', { 'cf-connecting-ip': '203.0.113.9' });

      const response = await handleModelsRequest(
        request,
        TARGET_URL,
        { Authorization: 'Bearer upstream-key' },
        REQUEST_ID,
        logger,
        undefined,
        ['shared', 'config-only'],
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      await expectHeaders(response, REQUEST_ID, 'MISS');
      assert.equal(body.object, 'list');
      assert.deepEqual(body.data.map(({ id }: OpenAIModel) => id), ['shared', 'upstream-only', 'config-only']);
      assert.equal(body.data[0].owned_by, 'upstream');
      assert.equal(body.data[2].owned_by, 'system');
      assert.equal(body.data[2].object, 'model');
      assert.ok(Number.isInteger(body.data[2].created));
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, TARGET_URL);
      assert.deepEqual(calls[0].init?.headers, {
        'Content-Type': 'application/json',
        Authorization: 'Bearer upstream-key',
        'x-forwarded-for': '203.0.113.9',
      });
      assert.equal(getCachedModelCount(), 2);
    });

    it('serves a cache HIT without fetching and merges new config models', async () => {
      const calls = mockFetch(() => jsonResponse(modelList('unexpected')));
      setCachedModels(modelList('cached', 'shared'));

      const response = await handleModelsRequest(
        modelsRequest(), TARGET_URL, {}, 'cached-request', logger, undefined, ['shared', 'configured'],
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      await expectHeaders(response, 'cached-request', 'HIT');
      assert.deepEqual(body, {
        object: 'list',
        data: [
          model('cached'),
          model('shared'),
          {
            ...model('configured', 'system'),
            created: body.data[2].created,
            context_length: 262144,
            max_tokens: 65536,
          },
        ],
      });
      assert.equal(calls.length, 0);
    });

    it('forwards pagination parameters and bypasses both reading and writing cache', async () => {
      setCachedModels(modelList('must-not-be-used'));
      const calls = mockFetch(() => jsonResponse(modelList('page-model')));

      const response = await handleModelsRequest(
        modelsRequest('?after_id=model-a&before_id=model-z&limit=25'),
        `${TARGET_URL}?existing=yes`,
        {},
        REQUEST_ID,
        logger,
        undefined,
        ['configured'],
      );
      const body = await response.json();
      const upstreamUrl = new URL(calls[0].url);

      assert.equal(response.status, 200);
      await expectHeaders(response, REQUEST_ID, 'MISS');
      assert.deepEqual(body.data.map(({ id }: OpenAIModel) => id), ['page-model', 'configured']);
      assert.equal(upstreamUrl.searchParams.get('existing'), 'yes');
      assert.equal(upstreamUrl.searchParams.get('after'), 'model-a');
      assert.equal(upstreamUrl.searchParams.get('before'), 'model-z');
      assert.equal(upstreamUrl.searchParams.get('limit'), '25');
      assert.equal(upstreamUrl.searchParams.has('after_id'), false);
      assert.equal(upstreamUrl.searchParams.has('before_id'), false);
      assert.deepEqual(getCachedModels(300000), modelList('must-not-be-used'));
      assert.equal(calls.length, 1);
    });

    it('rejects invalid limits before calling upstream', async () => {
      const calls = mockFetch(() => jsonResponse(modelList('unexpected')));

      for (const limit of ['0', '-1', '1001']) {
        await assert.rejects(
          handleModelsRequest(modelsRequest(`?limit=${limit}`), TARGET_URL, {}, REQUEST_ID, logger),
          (error: unknown) => {
            assert.ok(error instanceof ValidationError);
            assert.equal(error.message, 'limit must be between 1 and 1000');
            return true;
          },
        );
      }
      assert.equal(calls.length, 0);
    });

    it('falls back to config-only models on non-OK upstream responses', async () => {
      const calls = mockFetch(() => jsonResponse({ error: { message: 'denied' } }, 401));

      const response = await handleModelsRequest(
        modelsRequest(), TARGET_URL, {}, REQUEST_ID, logger, undefined, ['fallback-model'],
      );
      const body = await response.json();

      assert.equal(response.status, 200);
      await expectHeaders(response, REQUEST_ID, 'MISS');
      assert.equal(body.object, 'list');
      assert.deepEqual(body.data.map(({ id }: OpenAIModel) => id), ['fallback-model']);
      assert.equal(calls.length, 1);
      assert.equal(getCachedModelCount(), null);
    });

    it('falls back to config-only models on network and JSON failures', async () => {
      for (const upstream of [
        () => Promise.reject(new Error('connection refused')),
        () => new Response('{broken', { status: 200 }),
      ]) {
        const calls = mockFetch(upstream);
        const response = await handleModelsRequest(
          modelsRequest(), TARGET_URL, {}, REQUEST_ID, logger, undefined, ['fallback-model'],
        );
        const body = await response.json();

        assert.equal(response.status, 200);
        await expectHeaders(response, REQUEST_ID, 'MISS');
        assert.deepEqual(body.data.map(({ id }: OpenAIModel) => id), ['fallback-model']);
        assert.equal(calls.length, 1);
        assert.equal(getCachedModelCount(), null);
      }
    });
  });

  describe('isAnthropicModelDiscoveryEnabled', () => {
    it('accepts only the exact strings 1 and true', () => {
      assert.equal(isAnthropicModelDiscoveryEnabled({ CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: '1' }), true);
      assert.equal(isAnthropicModelDiscoveryEnabled({ CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: 'true' }), true);

      for (const value of [undefined, '', '0', 'false', 'TRUE', 'True', ' true ', '01', 'yes', 1, true]) {
        assert.equal(
          isAnthropicModelDiscoveryEnabled({ CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: value }),
          false,
          `expected ${String(value)} to be disabled`,
        );
      }
      assert.equal(isAnthropicModelDiscoveryEnabled(), false);
      assert.equal(isAnthropicModelDiscoveryEnabled({}), false);
    });
  });

  describe('handleAnthropicModelsDiscovery', () => {
    const enabled = { CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: 'true' };

    it('returns an empty list without fetching when disabled', async () => {
      const calls = mockFetch(() => jsonResponse({ data: [{ id: 'claude-unexpected' }] }));

      const response = await handleAnthropicModelsDiscovery(
        discoveryRequest(), TARGET_URL, {}, 'disabled-request', logger, {},
      );

      assert.equal(response.status, 200);
      await expectHeaders(response, 'disabled-request');
      assert.deepEqual(await response.json(), { object: 'list', data: [] });
      assert.equal(calls.length, 0);
    });

    it('maps and filters OpenAI-shaped responses and forwards request auth', async () => {
      const calls = mockFetch(() => jsonResponse({
        object: 'list',
        data: [
          { id: 'Claude-Sonnet-4', display_name: 'Claude Sonnet', description: 'Reasoning model' },
          { id: 'vendor/ANTHROPIC-opus' },
          { id: 'gpt-5', display_name: 'Not Claude' },
          { id: 42 },
          { display_name: 'missing id' },
        ],
      }));

      const response = await handleAnthropicModelsDiscovery(
        discoveryRequest({ Authorization: 'Bearer incoming', 'x-api-key': 'incoming-key' }),
        `${TARGET_URL}?api-version=1`,
        { Authorization: 'Bearer fallback', 'x-api-key': 'fallback-key' },
        REQUEST_ID,
        logger,
        enabled,
      );

      assert.equal(response.status, 200);
      await expectHeaders(response);
      assert.deepEqual(await response.json(), {
        object: 'list',
        data: [
          { id: 'Claude-Sonnet-4', display_name: 'Claude Sonnet', description: 'Reasoning model' },
          { id: 'vendor/ANTHROPIC-opus', display_name: 'vendor/ANTHROPIC-opus' },
        ],
      });
      assert.equal(calls.length, 1);
      const url = new URL(calls[0].url);
      assert.equal(url.searchParams.get('api-version'), '1');
      assert.equal(url.searchParams.get('limit'), '1000');
      assert.equal(calls[0].init?.method, 'GET');
      assert.equal(calls[0].init?.redirect, 'error');
      assert.ok(calls[0].init?.signal instanceof AbortSignal);
      assert.deepEqual(calls[0].init?.headers, {
        'Content-Type': 'application/json',
        Authorization: 'Bearer incoming',
        'x-api-key': 'incoming-key',
      });
    });

    it('accepts a direct array response', async () => {
      mockFetch(() => jsonResponse([
        { id: 'claude-array', display_name: 'Array Claude' },
        { id: 'other-model' },
      ]));

      const response = await handleAnthropicModelsDiscovery(
        discoveryRequest(), TARGET_URL, {}, REQUEST_ID, logger, enabled,
      );

      assert.equal(response.status, 200);
      await expectHeaders(response);
      assert.deepEqual(await response.json(), {
        object: 'list',
        data: [{ id: 'claude-array', display_name: 'Array Claude' }],
      });
    });

    it('accepts a models-wrapped response', async () => {
      mockFetch(() => jsonResponse({
        models: [
          { id: 'anthropic-wrapped', description: 'Wrapped response' },
          { id: 'unrelated' },
        ],
      }));

      const response = await handleAnthropicModelsDiscovery(
        discoveryRequest(), TARGET_URL, {}, REQUEST_ID, logger, enabled,
      );

      assert.equal(response.status, 200);
      await expectHeaders(response);
      assert.deepEqual(await response.json(), {
        object: 'list',
        data: [{
          id: 'anthropic-wrapped',
          display_name: 'anthropic-wrapped',
          description: 'Wrapped response',
        }],
      });
    });

    it('falls back to pre-extracted auth headers when the request has none', async () => {
      const calls = mockFetch(() => jsonResponse({ data: [] }));

      const response = await handleAnthropicModelsDiscovery(
        discoveryRequest(),
        TARGET_URL,
        { Authorization: 'Bearer extracted', 'x-api-key': 'extracted-key' },
        REQUEST_ID,
        logger,
        enabled,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(calls[0].init?.headers, {
        'Content-Type': 'application/json',
        Authorization: 'Bearer extracted',
        'x-api-key': 'extracted-key',
      });
    });

    it('preserves non-OK status and returns the upstream error details', async () => {
      mockFetch(() => new Response('temporarily unavailable', { status: 503 }));

      const response = await handleAnthropicModelsDiscovery(
        discoveryRequest(), TARGET_URL, {}, 'upstream-failure', logger, enabled,
      );

      assert.equal(response.status, 503);
      await expectHeaders(response, 'upstream-failure');
      assert.deepEqual(await response.json(), {
        error: {
          type: 'upstream_error',
          message: 'Model discovery failed: 503 temporarily unavailable',
        },
      });
    });

    it('maps AbortError to a 504 timeout response', async () => {
      mockFetch(() => Promise.reject(new DOMException('aborted', 'AbortError')));

      const response = await handleAnthropicModelsDiscovery(
        discoveryRequest(), TARGET_URL, {}, 'timeout-request', logger, enabled,
      );

      assert.equal(response.status, 504);
      await expectHeaders(response, 'timeout-request');
      assert.deepEqual(await response.json(), {
        error: { type: 'timeout', message: 'Model discovery timed out after 3 seconds' },
      });
    });

    it('maps redirect failures to a 502 response', async () => {
      mockFetch(() => Promise.reject(new TypeError('fetch failed because redirect mode is error')));

      const response = await handleAnthropicModelsDiscovery(
        discoveryRequest(), TARGET_URL, {}, 'redirect-request', logger, enabled,
      );

      assert.equal(response.status, 502);
      await expectHeaders(response, 'redirect-request');
      assert.deepEqual(await response.json(), {
        error: { type: 'redirect_failed', message: 'Model discovery redirect not allowed' },
      });
    });

    it('maps generic errors to a 500 response without exposing internals', async () => {
      mockFetch(() => Promise.reject(new Error('sensitive socket detail')));

      const response = await handleAnthropicModelsDiscovery(
        discoveryRequest(), TARGET_URL, {}, 'generic-error', logger, enabled,
      );

      assert.equal(response.status, 500);
      await expectHeaders(response, 'generic-error');
      assert.deepEqual(await response.json(), {
        error: { type: 'internal_error', message: 'Model discovery failed' },
      });
    });
  });
});
