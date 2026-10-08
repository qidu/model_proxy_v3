/**
 * Token Counting Integration Tests
 *
 * Verifies that the usage reported to the client and the usage recorded in the
 * dashboard's per-model stats agree — i.e. every request is counted exactly
 * once, not zero times and not twice.
 *
 * This is the regression guard for the duplicate recording that used to live in
 * src/handlers/claude.ts (native `anthropic-messages` upstream): it tapped the
 * response in addition to the central tracker in src/index.ts, so every token
 * was recorded twice on that path.
 *
 * Assertions are deltas on the sum of all models' total_tokens, so they do not
 * depend on which model ids the live config happens to use. Candidates are
 * discovered from the live config and tried in order, since which upstreams are
 * reachable varies by environment. A test with no usable candidate prints a
 * `(skipped: ...)` line naming what it tried rather than passing silently.
 *
 * TC numbers: TC4101–TC4105
 */

const {
  PROXY_URL,
  API_KEY,
  sendRequest,
  assert,
  runTestSuite
} = require('../utils/test_helpers');

const DASHBOARD_HEADERS = {
  'Authorization': `Bearer ${process.env.DASHBOARD_API_KEY || process.env.API_KEY || 'test'}`
};

const PROMPT = 'Reply with the single word: ok';

/**
 * Sum of total_tokens across every model the dashboard knows about. Read as a
 * delta around a single request, so pre-existing counters don't matter.
 */
async function totalTokensAcrossModels() {
  const res = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/stats/models',
    headers: DASHBOARD_HEADERS
  });
  assert(res.status === 200, `GET /dashboard/api/stats/models expected 200, got ${res.status}`);
  assert(Array.isArray(res.body?.data), 'GET /dashboard/api/stats/models should return a data array');
  return res.body.data.reduce((sum, row) => sum + (Number(row.total_tokens) || 0), 0);
}

/**
 * Map upstream mode -> client-facing model names that use it, read from the
 * live dashboard config. Model entries are [target, base_url, mode]; an empty
 * mode means the entry inherits the category's upstream_mode.
 */
async function discoverModelsByMode() {
  const res = await sendRequest({
    method: 'GET',
    endpoint: '/dashboard/api/config',
    headers: DASHBOARD_HEADERS
  });
  if (res.status !== 200) {
    console.log(`    (discovery: /dashboard/api/config returned ${res.status})`);
    return {};
  }

  const byMode = {};
  const categories = res.body?.config?.models || {};
  for (const category of Object.values(categories)) {
    if (!category || typeof category !== 'object') continue;
    const categoryMode = typeof category.upstream_mode === 'string' && category.upstream_mode
      ? category.upstream_mode
      : 'openai-completions';
    for (const [modelName, entry] of Object.entries(category)) {
      if (!Array.isArray(entry)) continue;
      const mode = entry[2] || categoryMode;
      (byMode[mode] ||= []).push(modelName);
    }
  }
  return byMode;
}

/**
 * POST a streaming request and return the parsed SSE frames with their event
 * names paired (the shared sendStreamingRequest helper flattens them apart).
 */
async function collectSse(endpoint, body) {
  const res = await fetch(`${PROXY_URL}${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`
    },
    body: JSON.stringify({ ...body, stream: true })
  });

  const frames = [];
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop();

    for (const part of parts) {
      const eventMatch = part.match(/^event: (.+)$/m);
      const dataMatch = part.match(/^data: ?(.+?)\r?$/m);
      if (!dataMatch) continue;
      let data;
      try {
        data = JSON.parse(dataMatch[1]);
      } catch {
        continue;
      }
      frames.push({ event: eventMatch ? eventMatch[1].trim() : undefined, data });
    }
  }

  return { status: res.status, frames };
}

/**
 * The total the proxy is expected to record for a usage object. Mirrors
 * extractUsageFromResponsePayload (src/utils/dashboard-stats.ts:1250): an
 * explicit total_tokens wins; otherwise Anthropic-shaped fields are summed
 * (input_tokens excludes the cache buckets) and OpenAI-shaped fields fall back
 * to prompt + completion.
 */
function expectedTotal(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  if (typeof usage.total_tokens === 'number') return usage.total_tokens;
  if (typeof usage.input_tokens === 'number' || typeof usage.output_tokens === 'number') {
    return (usage.input_tokens || 0)
      + (usage.cache_read_input_tokens || 0)
      + (usage.cache_creation_input_tokens || 0)
      + (usage.output_tokens || 0);
  }
  return (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);
}

/**
 * Usage as the Anthropic SSE tracker derives it (src/utils/dashboard-stats.ts:1513):
 * message_start seeds input/cache, message_delta overrides and supplies output.
 */
function usageFromClaudeSse(frames) {
  const usage = {};
  for (const frame of frames) {
    if (frame.event === 'message_start' && frame.data?.message?.usage) {
      const u = frame.data.message.usage;
      for (const key of ['input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
        if (typeof u[key] === 'number') usage[key] = u[key];
      }
    } else if (frame.event === 'message_delta' && frame.data?.usage) {
      const u = frame.data.usage;
      for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
        if (typeof u[key] === 'number') usage[key] = u[key];
      }
    }
  }
  return usage;
}

function assertCountedOnce(delta, expected, label, usage) {
  const hint = delta === expected * 2 ? ' (2x — the response is being counted twice)' : '';
  assert(
    delta === expected,
    `${label}: model stats total_tokens delta ${delta} != usage reported to the client ${expected}${hint}` +
    ` | usage=${JSON.stringify(usage)}`
  );
}

/**
 * Run `attempt(model)` against each candidate until one yields a usable usage
 * object, then assert the recorded delta for that single request.
 *
 * @param attempt resolves to `{ usage, delta }` for a usable candidate, or null
 *                to move on to the next one.
 */
async function assertFirstUsableCandidate(candidates, mode, label, attempt) {
  if (!candidates || candidates.length === 0) {
    console.log(`    (skipped: no ${mode} model in live config)`);
    return;
  }

  for (const model of candidates) {
    const result = await attempt(model);
    if (!result) continue;
    assertCountedOnce(result.delta, expectedTotal(result.usage), `${label} [${model}]`, result.usage);
    return;
  }

  console.log(`    (skipped: no usable ${mode} model — tried ${candidates.join(', ')})`);
}

/**
 * TC4101: Non-streaming /v1/messages usage is recorded exactly once.
 */
async function testMessagesNonStreamingCountedOnce() {
  const byMode = await discoverModelsByMode();

  await assertFirstUsableCandidate(
    byMode['anthropic-messages'], 'anthropic-messages', 'non-streaming /v1/messages',
    async (model) => {
      const before = await totalTokensAcrossModels();
      const res = await sendRequest({
        endpoint: '/v1/messages',
        body: { model, messages: [{ role: 'user', content: PROMPT }], max_tokens: 16 },
        retries: 0
      });
      const usage = res.status === 200 ? res.body?.usage : null;
      if (expectedTotal(usage) <= 0) return null;
      return { usage, delta: (await totalTokensAcrossModels()) - before };
    }
  );
}

/**
 * TC4102: Streaming /v1/messages usage is recorded exactly once.
 *
 * Targets an `anthropic-messages` upstream specifically: that is the native
 * handler path where usage used to be recorded twice (once by the handler's own
 * tee, once by the central tracker in src/index.ts).
 */
async function testMessagesStreamingCountedOnce() {
  const byMode = await discoverModelsByMode();

  await assertFirstUsableCandidate(
    byMode['anthropic-messages'], 'anthropic-messages', 'streaming /v1/messages',
    async (model) => {
      const before = await totalTokensAcrossModels();
      const { status, frames } = await collectSse('/v1/messages', {
        model,
        messages: [{ role: 'user', content: PROMPT }],
        max_tokens: 16
      });
      const usage = status === 200 ? usageFromClaudeSse(frames) : null;
      if (expectedTotal(usage) <= 0) return null;
      return { usage, delta: (await totalTokensAcrossModels()) - before };
    }
  );
}

/**
 * TC4103: Streaming /v1/chat/completions usage is recorded exactly once.
 *
 * The proxy force-injects stream_options.include_usage so the final chunk
 * carries usage even when the client did not ask for it; that chunk must be
 * recorded once, not dropped and not duplicated.
 */
async function testCompletionsStreamingCountedOnce() {
  const byMode = await discoverModelsByMode();

  await assertFirstUsableCandidate(
    byMode['openai-completions'], 'openai-completions', 'streaming /v1/chat/completions',
    async (model) => {
      const before = await totalTokensAcrossModels();
      const { status, frames } = await collectSse('/v1/chat/completions', {
        model,
        messages: [{ role: 'user', content: PROMPT }],
        max_tokens: 16
      });
      if (status !== 200) return null;
      const usageFrame = frames.find(f => f.data && f.data.usage);
      const usage = usageFrame ? usageFrame.data.usage : null;
      if (expectedTotal(usage) <= 0) return null;
      return { usage, delta: (await totalTokensAcrossModels()) - before };
    }
  );
}

/**
 * TC4104: Non-streaming /v1/chat/completions usage is recorded exactly once.
 */
async function testCompletionsNonStreamingCountedOnce() {
  const byMode = await discoverModelsByMode();

  await assertFirstUsableCandidate(
    byMode['openai-completions'], 'openai-completions', 'non-streaming /v1/chat/completions',
    async (model) => {
      const before = await totalTokensAcrossModels();
      const res = await sendRequest({
        endpoint: '/v1/chat/completions',
        body: { model, messages: [{ role: 'user', content: PROMPT }], max_tokens: 16 },
        retries: 0
      });
      const usage = res.status === 200 ? res.body?.usage : null;
      if (expectedTotal(usage) <= 0) return null;
      return { usage, delta: (await totalTokensAcrossModels()) - before };
    }
  );
}

/**
 * TC4105: Streaming Gemini generateContent usage is recorded exactly once.
 *
 * Exercises the usageMetadata branch of the SSE tracker, which is a different
 * frame shape from Claude and OpenAI.
 */
async function testGenerateContentStreamingCountedOnce() {
  const byMode = await discoverModelsByMode();

  await assertFirstUsableCandidate(
    byMode['gemini-generatecontent'], 'gemini-generatecontent', 'streaming :streamGenerateContent',
    async (model) => {
      const before = await totalTokensAcrossModels();
      const { status, frames } = await collectSse(
        `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        { contents: [{ role: 'user', parts: [{ text: PROMPT }] }] }
      );
      if (status !== 200) return null;
      // Running totals; the last chunk carrying usageMetadata is authoritative.
      const usageFrame = [...frames].reverse().find(f => f.data && f.data.usageMetadata);
      if (!usageFrame) return null;
      const metadata = usageFrame.data.usageMetadata;
      const usage = {
        input_tokens: Number(metadata.promptTokenCount) || 0,
        output_tokens: Number(metadata.candidatesTokenCount) || 0,
        total_tokens: Number(metadata.totalTokenCount) || 0
      };
      if (expectedTotal(usage) <= 0) return null;
      return { usage, delta: (await totalTokensAcrossModels()) - before };
    }
  );
}

module.exports = {
  testMessagesNonStreamingCountedOnce,
  testMessagesStreamingCountedOnce,
  testCompletionsStreamingCountedOnce,
  testCompletionsNonStreamingCountedOnce,
  testGenerateContentStreamingCountedOnce
};

if (require.main === module) {
  runTestSuite('Token Counting Tests', [
    { name: 'TC4101: /v1/messages non-streaming counted once', fn: testMessagesNonStreamingCountedOnce },
    { name: 'TC4102: /v1/messages streaming counted once', fn: testMessagesStreamingCountedOnce },
    { name: 'TC4103: /v1/chat/completions streaming counted once', fn: testCompletionsStreamingCountedOnce },
    { name: 'TC4104: /v1/chat/completions non-streaming counted once', fn: testCompletionsNonStreamingCountedOnce },
    { name: 'TC4105: :streamGenerateContent counted once', fn: testGenerateContentStreamingCountedOnce }
  ]);
}
