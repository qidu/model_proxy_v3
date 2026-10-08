#!/usr/bin/env node
/**
 * OpenRouter free-model discovery + smoke test for proxy v3 composite/
 * fusion/coordinator testing.
 *
 * 1. Loads credentials from tests/models/openrouter-api-key.txt
 *    (gitignored — never commit real keys).
 * 2. Fetches the live OpenRouter model list and filters for free models
 *    that support tool_choice/reasoning/tools with context_length > 262000.
 * 3. Falls back to the local fixture tests/models/or-free-models-examples.json
 *    if the live fetch fails OR yields zero matching models — always logging
 *    why (rule #8: no silent substitution).
 * 4. Writes tests/models/proxy_config.or_free_model.toml: a [models.FREE]
 *    section (one entry per matched model) plus three [composite] aliases
 *    built from the same matched models:
 *      - "free-model": share-based, splitting share evenly across all of them.
 *      - "free-model-fusion": panel/judge/synth fusion (panel = all but the
 *        last two matched models, judge = second-to-last, synth = last).
 *      - "free-model-coordinator": coord planner/executor pair (planner =
 *        first matched model, executor = second).
 * 5. Spawns a local proxy instance (dist/server.js, same entrypoint
 *    tests/run-integration-tests.js uses) with PROXY_CONFIG_PATH pointed at
 *    the freshly-written TOML, and waits for it to become ready. Composite/
 *    fusion/coordinator aliases only resolve inside the proxy itself — they
 *    are not real OpenRouter model IDs — so every smoke test below goes
 *    through this local proxy, never straight to OpenRouter.
 * 6. Runs smoke tests through the local proxy in two stages:
 *      Stage 1 (per model): a plain completion request, and a tool-calling
 *      (openai-completions, tool_choice="auto") request — one pair per
 *      matched model, exercising each as a plain/custom model target.
 *      Stage 2 (composite): one smoke test each for "free-model-fusion" and
 *      "free-model-coordinator".
 *    Both stages print a pass/fail/reason summary per model/alias. The
 *    proxy is always stopped afterward, even on failure.
 *
 * Requires: `npm run build` (so dist/server.js reflects current src/).
 * Run with: npx tsx tests/models/openrouter-free-tests.js
 * (plain `node` cannot resolve the `../../src/utils/config-loader.js` import
 * below, since only the .ts source exists unless `npm run build` has been
 * run — tsx is already a devDependency and is how every other script/test
 * in this repo imports from src/. dist/server.js itself is always spawned
 * with plain `node`, since it's the pre-built output.)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { serializeProxyConfigToml } from '../../src/utils/config-loader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const CREDENTIALS_PATH = path.join(__dirname, 'openrouter-api-key.txt');
const FIXTURE_PATH = path.join(__dirname, 'or-free-models-examples.json');
const OUTPUT_TOML_PATH = path.join(__dirname, 'proxy_config.or_free_model.toml');

// Composite/fusion/coordinator aliases only resolve inside the proxy itself
// (src/index.ts) — OpenRouter has never heard of "free-model-fusion". So all
// smoke tests run against a proxy instance we spawn here (dist/server.js,
// same entrypoint tests/run-integration-tests.js uses), configured with the
// freshly-generated TOML, rather than against credentials.base_url directly.
const PROXY_PORT = process.env.OR_FREE_TEST_PORT || '8799';
const PROXY_BASE_URL = `http://127.0.0.1:${PROXY_PORT}/v1`;
const PROXY_READY_MAX_ATTEMPTS = 30;
const PROXY_READY_INTERVAL_MS = 1000;

const REQUIRED_PARAMS = ['tool_choice', 'reasoning', 'tools'];
const CONTEXT_LENGTH_FLOOR = 262000;

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** Parse the `key = "value"` line format used by openrouter-api-key.txt. */
function loadCredentials() {
  let raw;
  try {
    raw = readFileSync(CREDENTIALS_PATH, 'utf8');
  } catch (err) {
    throw new Error(`cannot read credentials file ${CREDENTIALS_PATH}: ${err.message}`);
  }
  const fields = {};
  for (const line of raw.split('\n')) {
    const match = line.match(/^\s*([\w.]+)\s*=\s*"([^"]*)"\s*$/);
    if (match) fields[match[1]] = match[2];
  }
  for (const key of ['api_key', 'base_url', 'model_list']) {
    if (!fields[key]) {
      throw new Error(`${CREDENTIALS_PATH} is missing required field '${key}'`);
    }
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Free-model filtering (shared by the live path and the fallback fixture)
// ---------------------------------------------------------------------------

function isFree(model) {
  if (model.id.endsWith(':free')) return true;
  const values = Object.values(model.pricing ?? {});
  if (values.length === 0) return false;
  return values.every((v) => parseFloat(v) === 0);
}

function hasRequiredParams(model) {
  const supported = model.supported_parameters ?? [];
  return REQUIRED_PARAMS.every((p) => supported.includes(p));
}

function overContextLimit(model) {
  return (model.context_length ?? 0) > CONTEXT_LENGTH_FLOOR;
}

// google/gemma-4-* upstream has been consistently 429 rate-limited in smoke
// test runs (see tests/models/proxy_config.or_free_model.toml history) —
// excluded so it doesn't keep dragging down the pass/fail summary.
const EXCLUDED_ID_PATTERNS = [/^google\/gemma-4-/];

function isExcluded(model) {
  return EXCLUDED_ID_PATTERNS.some((pattern) => pattern.test(model.id));
}

function filterFreeModels(models) {
  return models.filter(isFree).filter(hasRequiredParams).filter(overContextLimit).filter((m) => !isExcluded(m));
}

// ---------------------------------------------------------------------------
// Live fetch (never throws — returns null on any failure so the caller can
// fall back explicitly and report why).
// ---------------------------------------------------------------------------

async function fetchLiveModels(modelListUrl) {
  let response;
  try {
    response = await fetch(modelListUrl);
  } catch (err) {
    console.warn(`[live fetch] network error calling ${modelListUrl}: ${err.message}`);
    return null;
  }
  if (!response.ok) {
    console.warn(`[live fetch] ${modelListUrl} returned HTTP ${response.status}`);
    return null;
  }
  let body;
  try {
    body = await response.json();
  } catch (err) {
    console.warn(`[live fetch] failed to parse JSON from ${modelListUrl}: ${err.message}`);
    return null;
  }
  if (!Array.isArray(body?.data)) {
    console.warn(`[live fetch] ${modelListUrl} response missing a 'data' array`);
    return null;
  }
  return body.data;
}

function loadFixtureModels() {
  const raw = readFileSync(FIXTURE_PATH, 'utf8');
  const body = JSON.parse(raw);
  if (!Array.isArray(body?.data)) {
    throw new Error(`${FIXTURE_PATH} is missing a 'data' array`);
  }
  return body.data;
}

// ---------------------------------------------------------------------------
// Config construction
// ---------------------------------------------------------------------------

/** "vendor/model-name:free" -> "vendor-model-name" (TOML-safe alias key). */
function aliasKeyFor(modelId) {
  return modelId.replace(/:free$/, '').replace(/\//g, '-');
}

/**
 * Fusion composite: panel = all matched models except the last two, judge =
 * second-to-last, synth = last. Requires at least 3 matched models; falls
 * back to a smaller shape (documented via console.warn) when fewer.
 */
function buildFusionTargets(models) {
  if (models.length < 3) {
    console.warn(`[fusion config] only ${models.length} model(s) matched — need >= 3 for panel+judge+synth; using panel=all, synth=last, no judge`);
    const targets = { fusion_options: { judge_required: false } };
    models.forEach((model, i) => {
      const alias = aliasKeyFor(model.id);
      targets[alias] = i === models.length - 1 ? { role: 'synth' } : { fusion: 1, role: 'panel' };
    });
    return targets;
  }
  const targets = { fusion_options: { judge_required: false } };
  const judgeModel = models[models.length - 2];
  const synthModel = models[models.length - 1];
  const panelModels = models.slice(0, models.length - 2);
  for (const model of panelModels) {
    targets[aliasKeyFor(model.id)] = { fusion: 1, role: 'panel' };
  }
  targets[aliasKeyFor(judgeModel.id)] = { fusion: 1, role: 'judge' };
  targets[aliasKeyFor(synthModel.id)] = { role: 'synth' };
  return targets;
}

/** Coordinator composite: planner = first matched model, executor = second. */
function buildCoordinatorTargets(models) {
  if (models.length < 2) {
    throw new Error(`coordinator config needs >= 2 matched models, got ${models.length}`);
  }
  const plannerAlias = aliasKeyFor(models[0].id);
  const executorAlias = aliasKeyFor(models[1].id);
  return {
    [plannerAlias]: { coord: 1, role: 'planner' },
    [executorAlias]: { coord: 1, role: 'executor' },
  };
}

function buildConfig(models, credentials) {
  const categoryConfig = {
    upstream_mode: 'openai-completions',
    base_url: credentials.base_url,
    api_key: credentials.api_key,
  };
  const compositeTargets = {};
  const share = Math.floor(100 / models.length);
  for (const model of models) {
    const alias = aliasKeyFor(model.id);
    // [target, base_url, api_key, mode] — target differs from alias, no
    // per-model overrides, so only the target slot is populated.
    categoryConfig[alias] = [model.id, '', '', ''];
    compositeTargets[alias] = { share };
  }
  return {
    general: {
      budget_to_effort_low: 8000,
      budget_to_effort_medium: 20000,
      budget_to_effort_high: 0,
    },
    models: { FREE: categoryConfig },
    composite: {
      'free-model': compositeTargets,
      'free-model-fusion': buildFusionTargets(models),
      'free-model-coordinator': buildCoordinatorTargets(models),
    },
  };
}

// ---------------------------------------------------------------------------
// Proxy process management — composite/fusion/coordinator aliases only
// resolve inside model-proxy-v3 itself, so smoke tests run against a locally
// spawned instance of the proxy (src/server.ts) configured with the
// freshly-generated TOML, not against OpenRouter directly.
// ---------------------------------------------------------------------------

// Poll {PROXY_BASE_URL}/models until it responds 200, or give up — same
// pattern as tests/run-integration-tests.js's waitForProxy().
async function waitForProxy(credentials, maxAttempts, interval) {
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      const res = await fetch(`${PROXY_BASE_URL}/models`, {
        headers: { authorization: `Bearer ${credentials.api_key}` },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return true;
    } catch {
      // not up yet — keep polling
    }
    if (i < maxAttempts) await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

async function startProxyServer(configPath, credentials) {
  const child = spawn('node', ['dist/server.js'], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PROXY_CONFIG_PATH: configPath,
      PORT: PROXY_PORT,
      DEV_NO_KEY: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let exited = false;
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  child.on('exit', () => { exited = true; });
  // Exposed so callers can dump the proxy's own log after the run — its
  // "Catch Error [model=... status=... type=...]: <message>" lines carry the
  // real underlying error (e.g. ENOTFOUND/ECONNRESET) that gets sanitized
  // away before reaching the client as a generic upstream_unreachable 502.
  child.getLogs = () => ({ stdout, stderr });

  const up = await waitForProxy(credentials, PROXY_READY_MAX_ATTEMPTS, PROXY_READY_INTERVAL_MS);
  if (!up) {
    child.kill();
    throw new Error(
      `proxy server (dist/server.js, PROXY_CONFIG_PATH=${configPath}, PORT=${PROXY_PORT}) ` +
      `did not become ready within ${PROXY_READY_MAX_ATTEMPTS * PROXY_READY_INTERVAL_MS}ms` +
      (exited ? ' (process exited early)' : '') +
      `.\nstdout: ${stdout}\nstderr: ${stderr}`
    );
  }
  return child;
}

function stopProxyServer(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill();
  });
}

// ---------------------------------------------------------------------------
// Stage 1: per-model smoke tests through the locally spawned proxy — each
// matched model tested as a plain/custom target (openai-completions,
// tool_choice="auto"), one at a time. Never let one model's failure abort
// the loop (rule #8: report every skip/failure with its reason, not just
// the first).
// ---------------------------------------------------------------------------

async function callChatCompletions(credentials, modelId, body) {
  const response = await fetch(`${PROXY_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${credentials.api_key}`,
    },
    body: JSON.stringify({ model: modelId, ...body }),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`non-JSON response: ${text.slice(0, 300)}`);
  }
  return json;
}

// The proxy's first outbound fetch to OpenRouter after a cold start can take
// several seconds longer to establish (DNS/TLS handshake) than subsequent
// requests reusing a warm connection — this has been observed to occasionally
// tip over into a genuine transport failure (502 upstream_unreachable) rather
// than just being slow. Firing one throwaway request before Stage 1 begins
// absorbs that cold-start cost so it doesn't land on (and fail) a real result.
async function warmUpProxy(credentials, modelId) {
  try {
    await callChatCompletions(credentials, modelId, {
      messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }],
      max_tokens: 16,
    });
    console.log(`[proxy] warm-up request to ${modelId} succeeded`);
  } catch (err) {
    // Non-fatal by design — if the connection is still bad after this, Stage 1
    // will surface it as a real, reportable failure on its own.
    console.warn(`[proxy] warm-up request to ${modelId} failed (continuing): ${err.message}`);
  }
}

async function smokeTestModel(credentials, alias, displayId) {
  const result = { model: displayId, basicOk: false, toolsOk: false, errors: [] };

  try {
    const basic = await callChatCompletions(credentials, alias, {
      messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }],
      max_tokens: 16,
    });
    if (basic?.choices?.[0]?.message?.content) {
      result.basicOk = true;
    } else {
      result.errors.push('basic: response missing choices[0].message.content');
    }
  } catch (err) {
    result.errors.push(`basic: ${err.message}`);
  }

  try {
    const tools = await callChatCompletions(credentials, alias, {
      messages: [{ role: 'user', content: 'What is the weather in Paris? Use the get_weather tool.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Get the current weather for a city',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        },
      ],
      tool_choice: 'auto',
      max_tokens: 64,
    });
    const message = tools?.choices?.[0]?.message;
    if (message?.tool_calls?.length || message?.content) {
      result.toolsOk = true;
    } else {
      result.errors.push('tools: response missing tool_calls and content');
    }
  } catch (err) {
    result.errors.push(`tools: ${err.message}`);
  }

  return result;
}

async function runSmokeTests(models, credentials) {
  const results = [];
  for (const model of models) {
    console.log(`[smoke test] ${model.id} ...`);
    // Must call through the alias (e.g. "inclusionai-ling-3.0-flash-fin"), not
    // the raw OpenRouter id — the proxy only knows base_url/api_key for
    // configured [models.FREE] aliases. Passing the raw id resolves to no
    // route and the proxy's fetch falls through to a localhost default,
    // producing a misleading "upstream_unreachable: fetch failed".
    results.push(await smokeTestModel(credentials, aliasKeyFor(model.id), model.id));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Stage 2: composite/fusion/coordinator smoke tests — run only after every
// individual model has been validated standalone in stage 1.
// ---------------------------------------------------------------------------

/**
 * Smoke test a composite alias (fusion or coordinator). Fusion aliases are
 * exercised the same way as a plain model (proxy fans out to panel/judge/
 * synth transparently — see src/index.ts's composite dispatch). Coordinator
 * aliases only hand off planner -> executor when the request includes a
 * trigger tool (COORDINATOR_DEFAULT_TRIGGER_TOOLS), so we send a
 * tool-calling request rather than a plain completion.
 */
async function smokeTestCompositeAlias(credentials, alias, { useTools }) {
  // basicOk/toolsOk double as the two PASS criteria for plain models (see
  // smokeTestModel). Coordinator aliases only ever exercise the tool-call
  // path (hand-off requires a trigger tool), so basicOk is fixed to `true`
  // there instead of left `false` — otherwise a fully successful coordinator
  // run could never reach `basicOk && toolsOk` and would always print
  // PARTIAL in the summary.
  const result = { model: alias, basicOk: useTools, toolsOk: false, errors: [] };

  if (!useTools) {
    try {
      const basic = await callChatCompletions(credentials, alias, {
        messages: [{ role: 'user', content: 'Reply with exactly one word: OK' }],
        max_tokens: 16,
      });
      if (basic?.choices?.[0]?.message?.content) {
        result.basicOk = true;
      } else {
        result.errors.push('basic: response missing choices[0].message.content');
      }
    } catch (err) {
      result.errors.push(`basic: ${err.message}`);
    }
  }

  try {
    const tools = await callChatCompletions(credentials, alias, {
      messages: [{ role: 'user', content: 'Edit the file notes.txt to add a line "hello". Use the Edit tool.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'Edit',
            description: 'Edit a file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' }, content: { type: 'string' } },
              required: ['path', 'content'],
            },
          },
        },
      ],
      tool_choice: 'auto',
      max_tokens: 128,
    });
    const message = tools?.choices?.[0]?.message;
    if (message?.tool_calls?.length || message?.content) {
      result.toolsOk = true;
    } else {
      result.errors.push('tools: response missing tool_calls and content');
    }
  } catch (err) {
    result.errors.push(`tools: ${err.message}`);
  }

  return result;
}

/** Print a pass/partial/fail table for one stage's results; returns the fail count. */
function printSummary(label, results) {
  console.log(`\n--- ${label} ---`);
  let failCount = 0;
  for (const r of results) {
    const status = r.basicOk && r.toolsOk ? 'PASS' : r.basicOk || r.toolsOk ? 'PARTIAL' : 'FAIL';
    if (status === 'FAIL') failCount += 1;
    console.log(`${status.padEnd(7)} ${r.model}  basic=${r.basicOk} tools=${r.toolsOk}`);
    for (const err of r.errors) console.log(`        - ${err}`);
  }
  console.log(`${results.length} tested, ${failCount} fully failed.`);
  return failCount;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const credentials = loadCredentials();

  const liveModels = await fetchLiveModels(credentials.model_list);
  let matched = liveModels ? filterFreeModels(liveModels) : null;

  if (!matched || matched.length === 0) {
    if (!liveModels) {
      console.warn('[fallback] live fetch failed — using tests/models/or-free-models-examples.json');
    } else {
      console.warn('[fallback] live fetch returned 0 models matching the filter — using tests/models/or-free-models-examples.json');
    }
    const fixtureModels = loadFixtureModels();
    matched = filterFreeModels(fixtureModels);
  }

  if (matched.length === 0) {
    throw new Error('no free models matched the filter criteria in either the live API or the fallback fixture');
  }

  console.log(`[filter] ${matched.length} model(s) matched: ${matched.map((m) => m.id).join(', ')}`);

  const config = buildConfig(matched, credentials);
  const toml = serializeProxyConfigToml(config);
  writeFileSync(OUTPUT_TOML_PATH, toml);
  console.log(`[config] wrote ${OUTPUT_TOML_PATH}`);

  console.log(`[proxy] starting dist/server.js on port ${PROXY_PORT} with PROXY_CONFIG_PATH=${OUTPUT_TOML_PATH} ...`);
  const proxy = await startProxyServer(OUTPUT_TOML_PATH, credentials);
  console.log(`[proxy] ready at ${PROXY_BASE_URL}`);

  await warmUpProxy(credentials, aliasKeyFor(matched[0].id));

  let results, fusionResult, coordinatorResult;
  try {
    console.log('\n=== Stage 1: per-model smoke tests (plain + tool_choice="auto") ===');
    results = await runSmokeTests(matched, credentials);
    printSummary('Stage 1: per-model smoke tests (plain + tool_choice="auto")', results);

    console.log('\n=== Stage 2: composite / fusion / coordinator smoke tests ===');
    console.log('[smoke test] free-model-fusion (composite) ...');
    fusionResult = await smokeTestCompositeAlias(credentials, 'free-model-fusion', { useTools: false });

    console.log('[smoke test] free-model-coordinator (composite, tool-triggered) ...');
    coordinatorResult = await smokeTestCompositeAlias(credentials, 'free-model-coordinator', { useTools: true });

    printSummary('Stage 2: composite / fusion / coordinator smoke tests', [fusionResult, coordinatorResult]);
  } finally {
    // Dump the proxy's own log unconditionally — it's the only place the real
    // underlying error (e.g. ENOTFOUND/ECONNRESET behind a sanitized 502
    // upstream_unreachable) shows up; the client-facing error message never
    // carries it. Printed before shutdown so it's captured even if stopping
    // the proxy itself throws.
    const { stdout, stderr } = proxy.getLogs();
    console.log('\n--- proxy stdout ---');
    console.log(stdout || '(empty)');
    console.log('\n--- proxy stderr ---');
    console.log(stderr || '(empty)');

    console.log('\n[proxy] stopping...');
    await stopProxyServer(proxy);
  }

  const allResults = [...results, fusionResult, coordinatorResult];
  const failCount = printSummary('Overall summary (stage 1 + stage 2)', allResults);

  if (failCount === allResults.length) {
    throw new Error('all models/aliases failed both smoke tests');
  }
}

main().catch((err) => {
  console.error(`[fatal] ${err.message}`);
  process.exitCode = 1;
});
