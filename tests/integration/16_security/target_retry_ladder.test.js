/**
 * Remote target-retry ladder integration tests.
 *
 * These drive the default export's `fetch` against `dist/index.js` with
 * `globalThis.fetch` stubbed, so the auth `targets[]` failover ladder runs
 * end-to-end without a real auth server or upstream. The ladder is an inline
 * closure inside the default-export handler, so it can only be reached through
 * `fetch` — not by importing a helper.
 *
 * Coverage:
 * - TC4001: auth `targets: [A, B]`, A returns 503 → ladder rescues on B; every
 *           rung's URL is the descriptor's `base` (never the `http://localhost`
 *           config fallback) and its key is the descriptor's `key`.
 * - TC4002: a terminal 4xx on A does NOT advance the ladder (B never fetched);
 *           the client sees A's status.
 * - TC4003: axis-2 `retry_on` re-hits the SAME rung before advancing.
 * - TC4004: ladder short-circuits config resolution — a composite alias's
 *           primary target is never fetched and its share is not decayed.
 * - TC4005: a returned-Response failure (chat-completions passthrough shape)
 *           fails over like a thrown error; the rescued body reaches the client
 *           verbatim over the /v1/chat/completions ladder path.
 * - TC4006: an exhausted ladder returns the LAST rung's Response verbatim —
 *           status and error body intact.
 * - TC4007: request bodies are single-use, so the same prompt is re-serialized
 *           for each rung while the model id tracks the rung's target.
 * - TC4008: an auth array longer than `[remote] max_targets` is truncated.
 * - TC4009: axis-2 miss — a status absent from `retry_on` advances the ladder
 *           immediately (the rung is fetched exactly once).
 *
 * Reference: docs/plan-remote-target-retry-dispatch.md (Testing).
 */

const path = require('path');
const fs = require('fs');
const os = require('os');

const {
  assert,
  runTestSuite,
} = require('../utils/test_helpers');

let proxyFetch;
let clearProxyConfigCache;
let getEffectiveCompositeShare;
let resetEffectiveCompositeSharesForTest;

async function loadModule() {
  const index = await import(path.join(process.cwd(), 'dist/index.js'));
  proxyFetch = index.default.fetch;
  getEffectiveCompositeShare = index.getEffectiveCompositeShare;
  resetEffectiveCompositeSharesForTest = index.resetEffectiveCompositeSharesForTest;
  const configLoader = await import(path.join(process.cwd(), 'dist/utils/config-loader.js'));
  clearProxyConfigCache = configLoader.clearProxyConfigCache;
}

const LADDER_CONFIG = `
[remote]
auth_server = "http://127.0.0.1/auth"
`;

// Same as LADDER_CONFIG plus a composite alias whose only target (`model-x`)
// resolves through the normal chain. If the ladder did NOT own routing, this
// alias would route to `model-x` and decay its effective share.
const COMPOSITE_CONFIG = `
[remote]
auth_server = "http://127.0.0.1/auth"

[models.model-x]
base_url = "http://127.0.0.1"
api_key = "sk-model-x"
upstream_mode = "anthropic-messages"

[composite]
"comp-alias" = {"model-x" = {share = 100, primary = true, fallback = 0}}
`;

// Bounds the ladder at 2 attempts even when the auth server returns 3 entries.
const BOUNDED_CONFIG = `
[remote]
auth_server = "http://127.0.0.1/auth"
max_targets = 2
`;

const CONFIG_FILES = [];

function writeConfig(contents) {
  const file = path.join(
    os.tmpdir(),
    `proxyv3_ladder_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.toml`,
  );
  fs.writeFileSync(file, contents, 'utf8');
  CONFIG_FILES.push(file);
  return file;
}

function cleanupConfigFiles() {
  for (const file of CONFIG_FILES) {
    try { fs.unlinkSync(file); } catch { /* best-effort */ }
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function claudeJson(text) {
  return {
    id: `msg_${text}`,
    type: 'message',
    role: 'assistant',
    model: 'stub',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  };
}

function makeRequest(model) {
  return new Request('http://localhost:7777/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'sk-client' },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
}

function makeChatRequest(model) {
  return new Request('http://localhost:7777/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer sk-client' },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });
}

function openaiJson(text) {
  return {
    id: `chatcmpl_${text}`,
    object: 'chat.completion',
    model: 'stub',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function descriptor(target, key, extra = {}) {
  return { target, base: 'http://127.0.0.1', mode: 'anthropic-messages', key, ...extra };
}

/**
 * Stub `globalThis.fetch`. `rungResponders` maps upstream `body.model` to a
 * factory returning a Response; the auth GET is answered from `authTargets`.
 * An unexpected model yields a distinctive 200 body (rather than throwing) so
 * a wrongly-taken code path is observable in the recorded calls.
 */
async function withStub(authTargets, rungResponders, fn) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const bodyText = typeof init.body === 'string' ? init.body : undefined;
    const call = {
      url: String(url),
      method: init.method || 'GET',
      headers: init.headers || {},
      body: bodyText ? JSON.parse(bodyText) : undefined,
    };
    calls.push(call);

    if (call.url.endsWith('/auth')) {
      return jsonResponse({ targets: authTargets }, 200);
    }
    const model = call.body && call.body.model;
    const responder = rungResponders[model];
    return responder ? responder() : jsonResponse(claudeJson(`unexpected:${model}`), 200);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function upstreamCalls(calls) {
  return calls.filter(c => !c.url.endsWith('/auth'));
}

async function testFailoverRescuesOnNextTarget() {
  resetEffectiveCompositeSharesForTest();
  const configPath = writeConfig(LADDER_CONFIG);
  clearProxyConfigCache();

  const targets = [descriptor('model-a', 'sk-desc-a'), descriptor('model-b', 'sk-desc-b')];
  await withStub(
    targets,
    {
      'model-a': () => jsonResponse({ error: { message: 'boom' } }, 503),
      'model-b': () => jsonResponse(claudeJson('from-b'), 200),
    },
    async (calls) => {
      const response = await proxyFetch(makeRequest('claude-x'), { PROXY_CONFIG_PATH: configPath });

      assert(calls[0] && calls[0].url.endsWith('/auth'), `auth must run first, got ${calls[0] && calls[0].url}`);
      assert(response.status === 200, `client should see rung B's 200, got ${response.status}`);
      const body = await response.json();
      assert(body.content && body.content[0] && body.content[0].text === 'from-b', `client should see rung B's body, got ${JSON.stringify(body)}`);

      const upstreams = upstreamCalls(calls);
      assert(upstreams.length === 2, `expected exactly 2 upstream calls, got ${upstreams.length}`);
      assert(upstreams[0].body.model === 'model-a' && upstreams[1].body.model === 'model-b', `expected [model-a, model-b], got ${JSON.stringify(upstreams.map(c => c.body.model))}`);
      assert(upstreams[0].headers['x-api-key'] === 'sk-desc-a' && upstreams[1].headers['x-api-key'] === 'sk-desc-b', `expected descriptor keys, got ${JSON.stringify(upstreams.map(c => c.headers['x-api-key']))}`);
      for (const call of upstreams) {
        assert(call.url === 'http://127.0.0.1/v1/messages', `upstream URL must be the descriptor base, never localhost; got ${call.url}`);
      }
    },
  );
}

async function testTerminal4xxStopsLadder() {
  resetEffectiveCompositeSharesForTest();
  const configPath = writeConfig(LADDER_CONFIG);
  clearProxyConfigCache();

  const targets = [descriptor('model-a', 'sk-desc-a'), descriptor('model-b', 'sk-desc-b')];
  await withStub(
    targets,
    {
      'model-a': () => jsonResponse({ error: { type: 'invalid_request_error', message: 'bad input' } }, 400),
      'model-b': () => jsonResponse(claudeJson('from-b'), 200),
    },
    async (calls) => {
      const response = await proxyFetch(makeRequest('claude-x'), { PROXY_CONFIG_PATH: configPath });

      assert(response.status === 400, `client should see A's 400, got ${response.status}`);
      const upstreams = upstreamCalls(calls);
      assert(upstreams.length === 1, `a terminal 4xx must not fetch rung B, got ${upstreams.length} upstream calls`);
      assert(upstreams[0].body.model === 'model-a', `only rung A should be hit, got ${JSON.stringify(upstreams.map(c => c.body.model))}`);
    },
  );
}

async function testRetryOnRehitsSameTarget() {
  resetEffectiveCompositeSharesForTest();
  const configPath = writeConfig(LADDER_CONFIG);
  clearProxyConfigCache();

  const targets = [
    descriptor('model-a', 'sk-desc-a', { retry_on: [503] }),
    descriptor('model-b', 'sk-desc-b'),
  ];
  await withStub(
    targets,
    {
      'model-a': () => jsonResponse({ error: { message: 'boom' } }, 503),
      'model-b': () => jsonResponse(claudeJson('from-b'), 200),
    },
    async (calls) => {
      const response = await proxyFetch(makeRequest('claude-x'), { PROXY_CONFIG_PATH: configPath });

      assert(response.status === 200, `client should see rung B's 200, got ${response.status}`);
      const upstreams = upstreamCalls(calls);
      assert(upstreams.length === 3, `expected A retried once then B (3 calls), got ${upstreams.length}`);
      assert(
        upstreams[0].body.model === 'model-a' && upstreams[1].body.model === 'model-a' && upstreams[2].body.model === 'model-b',
        `expected [model-a, model-a, model-b], got ${JSON.stringify(upstreams.map(c => c.body.model))}`,
      );
    },
  );
}

async function testLadderBypassesCompositeLoop() {
  resetEffectiveCompositeSharesForTest();
  const configPath = writeConfig(COMPOSITE_CONFIG);
  clearProxyConfigCache();

  const targets = [descriptor('model-a', 'sk-desc-a'), descriptor('model-b', 'sk-desc-b')];
  await withStub(
    targets,
    {
      'model-a': () => jsonResponse({ error: { message: 'boom' } }, 503),
      'model-b': () => jsonResponse(claudeJson('from-b'), 200),
    },
    async (calls) => {
      const response = await proxyFetch(makeRequest('comp-alias'), { PROXY_CONFIG_PATH: configPath });

      assert(response.status === 200, `client should see rung B's 200, got ${response.status}`);
      const models = upstreamCalls(calls).map(c => c.body.model);
      assert(
        !models.includes('model-x'),
        `composite primary must never be fetched when the ladder owns routing; got ${JSON.stringify(models)}`,
      );
      assert(
        models.join(',') === 'model-a,model-b',
        `ladder must own routing for the composite alias; got ${JSON.stringify(models)}`,
      );
      // Decay only runs in the composite loop; a rescued ladder attempt must not touch it.
      assert(
        getEffectiveCompositeShare('comp-alias', 'model-x', 100) === 100,
        `composite share must not be decayed by a ladder request; got ${getEffectiveCompositeShare('comp-alias', 'model-x', 100)}`,
      );
    },
  );
}

// A returned-Response failure (the chat-completions passthrough shape) must
// fail over exactly like a thrown ClaudeProxyError, and the rescued rung's body
// must reach the client verbatim.
async function testChatCompletionsResponseFailureFailsOver() {
  resetEffectiveCompositeSharesForTest();
  const configPath = writeConfig(LADDER_CONFIG);
  clearProxyConfigCache();

  const targets = [
    descriptor('model-a', 'sk-desc-a', { mode: 'openai-completions' }),
    descriptor('model-b', 'sk-desc-b', { mode: 'openai-completions' }),
  ];
  await withStub(
    targets,
    {
      'model-a': () => jsonResponse({ error: { message: 'a-down' } }, 503),
      'model-b': () => jsonResponse(openaiJson('from-b'), 200),
    },
    async (calls) => {
      const response = await proxyFetch(makeChatRequest('claude-x'), { PROXY_CONFIG_PATH: configPath });

      assert(response.status === 200, `client should see rung B's 200, got ${response.status}`);
      const body = await response.json();
      assert(
        body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content === 'from-b',
        `rung B's body must reach the client verbatim, got ${JSON.stringify(body)}`,
      );

      const upstreams = upstreamCalls(calls);
      assert(upstreams.length === 2, `expected exactly 2 upstream calls, got ${upstreams.length}`);
      assert(
        upstreams[0].body.model === 'model-a' && upstreams[1].body.model === 'model-b',
        `expected [model-a, model-b], got ${JSON.stringify(upstreams.map(c => c.body.model))}`,
      );
      for (const call of upstreams) {
        assert(call.url === 'http://127.0.0.1/v1/chat/completions', `chat-completions rung URL must be base + v1/chat/completions, got ${call.url}`);
      }
      assert(
        upstreams[0].headers['Authorization'] === 'Bearer sk-desc-a' && upstreams[1].headers['Authorization'] === 'Bearer sk-desc-b',
        `expected per-rung Bearer keys, got ${JSON.stringify(upstreams.map(c => c.headers['Authorization']))}`,
      );
    },
  );
}

// When every rung fails, the ladder returns the LAST rung's Response verbatim —
// the status and error body the client sees are that rung's, not a synthesised one.
async function testExhaustedLadderPreservesLastError() {
  resetEffectiveCompositeSharesForTest();
  const configPath = writeConfig(LADDER_CONFIG);
  clearProxyConfigCache();

  const targets = [
    descriptor('model-a', 'sk-desc-a', { mode: 'openai-completions' }),
    descriptor('model-b', 'sk-desc-b', { mode: 'openai-completions' }),
  ];
  await withStub(
    targets,
    {
      'model-a': () => jsonResponse({ error: { message: 'a-down' } }, 503),
      'model-b': () => jsonResponse({ error: { message: 'b-down' } }, 503),
    },
    async (calls) => {
      const response = await proxyFetch(makeChatRequest('claude-x'), { PROXY_CONFIG_PATH: configPath });

      assert(response.status === 503, `client should see the last rung's 503, got ${response.status}`);
      const body = await response.json();
      assert(body.error && body.error.message === 'b-down', `last rung's verbatim error body must survive exhaustion, got ${JSON.stringify(body)}`);

      const upstreams = upstreamCalls(calls);
      assert(upstreams.length === 2, `expected the whole ladder to be walked (2 calls), got ${upstreams.length}`);
      assert(
        upstreams.map(c => c.body.model).join(',') === 'model-a,model-b',
        `expected [model-a, model-b], got ${JSON.stringify(upstreams.map(c => c.body.model))}`,
      );
    },
  );
}

// Request bodies are single-use, so the ladder re-serializes the parsed body per
// rung. Assert the SAME prompt (and params) is sent every rung while the model
// id changes to the rung's target.
async function testBodyReuseAcrossRungs() {
  resetEffectiveCompositeSharesForTest();
  const configPath = writeConfig(LADDER_CONFIG);
  clearProxyConfigCache();

  const targets = [
    descriptor('model-a', 'sk-desc-a'),
    descriptor('model-b', 'sk-desc-b'),
    descriptor('model-c', 'sk-desc-c'),
  ];
  await withStub(
    targets,
    {
      'model-a': () => jsonResponse(claudeJson('a-fail'), 503),
      'model-b': () => jsonResponse(claudeJson('b-fail'), 500),
      'model-c': () => jsonResponse(claudeJson('from-c'), 200),
    },
    async (calls) => {
      const response = await proxyFetch(makeRequest('claude-x'), { PROXY_CONFIG_PATH: configPath });

      assert(response.status === 200, `client should see rung C's 200, got ${response.status}`);
      const body = await response.json();
      assert(body.content && body.content[0] && body.content[0].text === 'from-c', `client should see rung C's body, got ${JSON.stringify(body)}`);

      const upstreams = upstreamCalls(calls);
      assert(upstreams.length === 3, `expected 3 rungs walked, got ${upstreams.length}`);
      assert(
        upstreams.map(c => c.body.model).join(',') === 'model-a,model-b,model-c',
        `expected [model-a, model-b, model-c], got ${JSON.stringify(upstreams.map(c => c.body.model))}`,
      );
      for (const call of upstreams) {
        assert(
          call.body.messages && call.body.messages[0] && call.body.messages[0].content === 'hi',
          `the same prompt must be resent to every rung, got ${JSON.stringify(call.body.messages)}`,
        );
        assert(call.body.max_tokens === 16, `the same params must be resent to every rung, got max_tokens=${call.body.max_tokens}`);
      }
    },
  );
}

// An auth array longer than `[remote] max_targets` is truncated, not walked.
async function testLadderTruncatedAtMaxTargets() {
  resetEffectiveCompositeSharesForTest();
  const configPath = writeConfig(BOUNDED_CONFIG);
  clearProxyConfigCache();

  const targets = [
    descriptor('model-a', 'sk-desc-a'),
    descriptor('model-b', 'sk-desc-b'),
    descriptor('model-c', 'sk-desc-c'),
  ];
  await withStub(
    targets,
    {
      'model-a': () => jsonResponse({ error: { message: 'a-down' } }, 503),
      'model-b': () => jsonResponse({ error: { message: 'b-down' } }, 503),
      'model-c': () => jsonResponse(claudeJson('from-c'), 200),
    },
    async (calls) => {
      const response = await proxyFetch(makeRequest('claude-x'), { PROXY_CONFIG_PATH: configPath });

      assert(response.status === 503, `client should see rung B's 503 (cap reached), got ${response.status}`);
      const upstreams = upstreamCalls(calls);
      assert(upstreams.length === 2, `max_targets=2 must cap attempts at 2, got ${upstreams.length}`);
      assert(
        upstreams.map(c => c.body.model).join(',') === 'model-a,model-b',
        `rung C must never be fetched; got ${JSON.stringify(upstreams.map(c => c.body.model))}`,
      );
    },
  );
}

// Axis 2 miss: a status not listed in `retry_on` advances immediately — the
// rung is fetched exactly once even though it is retryable on axis 1.
async function testRetryOnMissAdvancesImmediately() {
  resetEffectiveCompositeSharesForTest();
  const configPath = writeConfig(LADDER_CONFIG);
  clearProxyConfigCache();

  const targets = [
    descriptor('model-a', 'sk-desc-a', { retry_on: [429] }),
    descriptor('model-b', 'sk-desc-b'),
  ];
  await withStub(
    targets,
    {
      'model-a': () => jsonResponse({ error: { message: 'a-down' } }, 503),
      'model-b': () => jsonResponse(claudeJson('from-b'), 200),
    },
    async (calls) => {
      const response = await proxyFetch(makeRequest('claude-x'), { PROXY_CONFIG_PATH: configPath });

      assert(response.status === 200, `client should see rung B's 200, got ${response.status}`);
      const upstreams = upstreamCalls(calls);
      assert(upstreams.length === 2, `503 is not in retry_on [429], so A must be fetched exactly once; got ${upstreams.length} calls`);
      assert(
        upstreams.map(c => c.body.model).join(',') === 'model-a,model-b',
        `expected [model-a, model-b], got ${JSON.stringify(upstreams.map(c => c.body.model))}`,
      );
    },
  );
}

if (require.main === module) {
  loadModule().then(() => runTestSuite('Remote Target-Retry Ladder', [
    { name: 'TC4001: auth targets A(503) fails over to B, descriptor base+key used', fn: testFailoverRescuesOnNextTarget },
    { name: 'TC4002: terminal 4xx does not advance the ladder', fn: testTerminal4xxStopsLadder },
    { name: 'TC4003: retry_on re-hits the same target before advancing', fn: testRetryOnRehitsSameTarget },
    { name: 'TC4004: ladder short-circuits the composite loop', fn: testLadderBypassesCompositeLoop },
    { name: 'TC4005: chat-completions returned-Response failure (503) fails over to B', fn: testChatCompletionsResponseFailureFailsOver },
    { name: 'TC4006: exhausted ladder preserves the last rung status + verbatim error body', fn: testExhaustedLadderPreservesLastError },
    { name: 'TC4007: the same body is reused across a 3-rung ladder (per-rung model id)', fn: testBodyReuseAcrossRungs },
    { name: 'TC4008: an array longer than max_targets is truncated, not walked', fn: testLadderTruncatedAtMaxTargets },
    { name: 'TC4009: a retry_on miss advances immediately (rung fetched once)', fn: testRetryOnMissAdvancesImmediately },
  ])).then(cleanupConfigFiles).catch((error) => {
    cleanupConfigFiles();
    console.error(error);
    process.exitCode = 1;
  });
}
