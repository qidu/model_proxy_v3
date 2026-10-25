import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  handleDashboardAgentStats,
  handleDashboardGetConfig,
  handleDashboardModelStats,
  handleDashboardPage,
  handleDashboardRequestStats,
  handleDashboardTestModel,
  handleDashboardToggleToolBlock,
  handleDashboardToolBlocklist,
} from '../../src/handlers/dashboard.js';
import {
  blockTool,
  getBlockedTools,
  recordAgentStat,
  recordModelStat,
  recordPrivacyKeysDetected,
  recordRequestEndpoint,
  recordRequestTiming,
  recordResponseStatusCodeFromUpstream,
  recordResponseStatusCodeToEndpoint,
  recordResponseUpstream,
  unblockTool,
} from '../../src/utils/dashboard-stats.js';
import type { ProxyConfig } from '../../src/utils/config-loader.js';
import type { Env } from '../../src/types/shared.js';

const realFetch = globalThis.fetch;
const env: Env = { PORT: '9123', LOG_LEVEL: 'error' };
const config: ProxyConfig = {
  models: {
    free: {
      upstream_mode: 'openai-completions',
      base_url: 'https://upstream.example/v1',
      alpha: ['vendor/alpha', 'https://alpha.example/v1', 'alpha-secret', 'anthropic-messages'],
      beta: ['vendor/beta', 'https://beta.example/v1', 'beta-secret', 'openai-completions'],
    },
  },
};

function jsonRequest(body: unknown): Request {
  return new Request('http://localhost/dashboard/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const originalDashboardFlag = process.env.DASHBOARD;

beforeEach(() => {
  process.env.DASHBOARD = 'true';
  globalThis.fetch = (async () => { throw new Error('unexpected fetch'); }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (originalDashboardFlag === undefined) delete process.env.DASHBOARD;
  else process.env.DASHBOARD = originalDashboardFlag;
  for (const name of getBlockedTools()) unblockTool(name);
});

describe('dashboard page and config endpoints', () => {
  it('sends a non-cacheable HTML application without exposing environment secrets', async () => {
    const response = handleDashboardPage({ ...env, PROXY_CLIENT_API_KEY: 'never-render-this-key' });
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, max-age=0');
    assert.ok(html.includes('<!doctype html>'));
    assert.ok(html.includes('id="configForm"'));
    assert.ok(html.includes('/dashboard/api/config'));
    assert.equal(html.includes('never-render-this-key'), false);
  });

  it('returns config snapshots and converts snapshot failures to 500 responses', async () => {
    const ok = handleDashboardGetConfig(config, env);
    assert.equal(ok.status, 200);
    const snapshot = await ok.json() as { config: { models: Record<string, unknown> } };
    assert.deepEqual(Object.keys(snapshot.config.models), ['free']);
    assert.equal(JSON.stringify(snapshot).includes('alpha-secret'), false);

    const broken = {} as ProxyConfig;
    Object.defineProperty(broken, 'models', { get() { throw new Error('snapshot boom'); } });
    const failure = handleDashboardGetConfig(broken, env);
    assert.equal(failure.status, 500);
    assert.deepEqual(await failure.json(), { error: 'snapshot boom' });
  });
});

describe('dashboard statistics endpoints', () => {
  it('returns model and agent usage records', async () => {
    recordModelStat('dashboard-unit-model', { input_tokens: 11, output_tokens: 7 });
    recordAgentStat('dashboard-unit-agent', ['dashboard_unit_tool']);

    const modelResponse = handleDashboardModelStats();
    const modelBody = await modelResponse.json() as { data: Array<Record<string, unknown>> };
    const model = modelBody.data.find((row) => row.model === 'dashboard-unit-model');
    assert.ok(model);
    assert.equal(model.input_tokens, 11);
    assert.equal(model.output_tokens, 7);

    const agentResponse = handleDashboardAgentStats();
    const agentBody = await agentResponse.json() as { data: Array<Record<string, unknown>> };
    assert.ok(agentBody.data.some((row) => row.tool_name === 'dashboard_unit_tool'));
  });

  it('returns request aggregates and sidecar defaults', async () => {
    recordRequestEndpoint('/dashboard-unit');
    recordRequestTiming('/dashboard-unit', 25);
    recordResponseUpstream('https://dashboard-unit.example');
    recordResponseStatusCodeFromUpstream(201);
    recordResponseStatusCodeToEndpoint(202);
    recordPrivacyKeysDetected(3);

    const response = handleDashboardRequestStats({});
    const body = await response.json() as Record<string, any>;
    assert.equal(response.status, 200);
    assert.ok(body.endpoints.some((row: any) => row.endpoint === '/dashboard-unit'));
    assert.ok(body.upstreams.some((row: any) => row.upstream_base_url === 'https://dashboard-unit.example'));
    assert.equal(body.privacy_keys_detected, 3);
    assert.deepEqual(body.toolJudgeSidecar, { enabled: false });
  });

  it('returns configured sidecar options', async () => {
    const response = handleDashboardRequestStats({
      tool_judge_sidecar: { judge_url: 'http://127.0.0.1:9999', mode: 'always', threshold: 0.8 },
    });
    const body = await response.json() as { toolJudgeSidecar: Record<string, unknown> };
    assert.deepEqual(body.toolJudgeSidecar, {
      enabled: true,
      judge_url: 'http://127.0.0.1:9999',
      mode: 'always',
      threshold: 0.8,
      timeout_ms: 50,
      max_batch_tools: 50,
    });
  });

  it('toggles blocked tools and validates tool names', async () => {
    blockTool('already_blocked');
    const initial = await handleDashboardToolBlocklist().json() as { blockedTools: string[] };
    assert.ok(initial.blockedTools.includes('already_blocked'));

    const blockedResponse = await handleDashboardToggleToolBlock(jsonRequest({ tool_name: '  new_tool  ', blocked: true }));
    assert.deepEqual(await blockedResponse.json(), { ok: true, tool_name: 'new_tool', blocked: true });
    assert.equal(getBlockedTools().has('new_tool'), true);

    const unblockedResponse = await handleDashboardToggleToolBlock(jsonRequest({ tool_name: 'new_tool', blocked: false }));
    assert.deepEqual(await unblockedResponse.json(), { ok: true, tool_name: 'new_tool', blocked: false });
    assert.equal(getBlockedTools().has('new_tool'), false);

    const invalid = await handleDashboardToggleToolBlock(jsonRequest({ tool_name: ' ', blocked: true }));
    assert.equal(invalid.status, 400);
    assert.deepEqual(await invalid.json(), { error: 'tool_name is required' });
  });
});

describe('handleDashboardTestModel', () => {
  it('posts an Anthropic tool test to the loopback proxy and extracts details', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(input);
      seenInit = init;
      return new Response(JSON.stringify({
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_use', name: 'test_tool', input: { message: 'hi' } },
        ],
        usage: { input_tokens: 5, output_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const response = await handleDashboardTestModel(jsonRequest({ modelId: 'alpha' }), env, config);
    const body = await response.json() as Record<string, unknown>;
    assert.equal(response.status, 200);
    assert.deepEqual(body, {
      success: true,
      modelId: 'alpha',
      status: 200,
      detail: 'msg: hello | tool: test_tool {"message":"hi"}',
      usage: '{"input_tokens":5,"output_tokens":2}',
    });
    assert.equal(seenUrl, 'http://127.0.0.1:9123/v1/messages');
    assert.equal(seenInit?.method, 'POST');
    assert.deepEqual(seenInit?.headers, { 'Content-Type': 'application/json', 'x-api-key': 'alpha-secret' });
    const upstream = JSON.parse(String(seenInit?.body));
    assert.equal(upstream.model, 'alpha');
    assert.equal(upstream.tool_choice.name, 'test_tool');
  });

  it('returns upstream errors and validates model IDs without fetching', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: 'bad key' } }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
    const failure = await handleDashboardTestModel(jsonRequest({ modelId: 'beta' }), env, config);
    assert.deepEqual(await failure.json(), {
      success: false,
      modelId: 'beta',
      status: 401,
      detail: 'error: bad key',
      usage: null,
    });

    const missing = await handleDashboardTestModel(jsonRequest({}), env, config);
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: 'modelId is required' });
  });

  it('reports loopback fetch failures instead of hiding them', async () => {
    const response = await handleDashboardTestModel(jsonRequest({ modelId: 'missing' }), env, config);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { success: false, modelId: '?', error: 'unexpected fetch' });
  });

  it('uses placeholder auth and extracts Responses output tool calls without a configured key', async () => {
    const keylessConfig: ProxyConfig = {
      models: {
        free: {
          upstream_mode: 'openai-completions',
          base_url: 'https://upstream.example/v1',
          keyless: ['vendor/keyless', 'https://keyless.example/v1', '', 'openai-responses'],
        },
      },
    };
    let headers: Headers | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify({
        outputs: [{ type: 'function_call', name: 'responses_tool', arguments: '{"x":1}' }],
        usage: { input_tokens: 1 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const response = await handleDashboardTestModel(jsonRequest({ modelId: 'keyless' }), env, keylessConfig);
    assert.deepEqual(await response.json(), {
      success: true, modelId: 'keyless', status: 200,
      detail: 'tool: responses_tool {"x":1}', usage: '{"input_tokens":1}',
    });
    assert.equal(headers?.get('authorization'), 'Bearer unconfigured-test-key');
  });

  it('returns plain-text loopback responses as detail without usage', async () => {
    globalThis.fetch = (async () => new Response('plain upstream text', {
      status: 200, headers: { 'Content-Type': 'text/plain' },
    })) as typeof fetch;
    const response = await handleDashboardTestModel(jsonRequest({ modelId: 'beta' }), env, config);
    assert.deepEqual(await response.json(), {
      success: true, modelId: 'beta', status: 200,
      detail: 'plain upstream text', usage: null,
    });
  });
});

describe('handleDashboardModelQuota validation', () => {
  it('requires a model or base_url query parameter', async () => {
    const { handleDashboardModelQuota } = await import('../../src/handlers/dashboard.js');
    const response = await handleDashboardModelQuota(new Request('http://localhost/dashboard/api/quota'), {});
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'model or base_url query parameter is required' });
  });
});

describe('dashboard defensive input and result formatting', () => {
  it('returns a 400 response for malformed tool-block JSON', async () => {
    const response = await handleDashboardToggleToolBlock(new Request('http://localhost/dashboard/api/tools/toggle-block', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not-json',
    }));
    assert.equal(response.status, 400);
    const body = await response.json() as { error: string };
    assert.match(body.error, /JSON|Unexpected/);
  });

  it('formats nested and fallback OpenAI tool calls in model-test results', async () => {
    let upstreamBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        tool_calls: [
          null,
          { name: 'fallback_tool', arguments: { x: 1 } },
          { function: { name: 'openai_tool', arguments: '{"city":"Paris"}' } },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const response = await handleDashboardTestModel(jsonRequest({ modelId: 'beta' }), env, config);

    assert.deepEqual(await response.json(), {
      success: true,
      modelId: 'beta',
      status: 200,
      detail: 'tool: fallback_tool {"x":1} | tool: openai_tool {"city":"Paris"}',
      usage: '{"prompt_tokens":4,"completion_tokens":2}',
    });
    assert.equal(upstreamBody.tool_choice, 'auto');
  });

  it('formats string errors and typed object errors without a message', async () => {
    const errors = [{ error: '  denied  ' }, { error: { type: 'upstream_type' } }];
    globalThis.fetch = (async () => new Response(JSON.stringify(errors.shift()), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;

    for (const detail of ['error: denied', 'error: upstream_type']) {
      const response = await handleDashboardTestModel(jsonRequest({ modelId: 'beta' }), env, config);
      assert.deepEqual(await response.json(), {
        success: false, modelId: 'beta', status: 400, detail, usage: null,
      });
    }
    assert.deepEqual(errors, []);
  });
});
