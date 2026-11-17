/**
 * `/v1/responses` → every accepted upstream mode: the sampling knobs the client
 * sent must arrive, under the spelling that target's wire uses.
 *
 * `/v1/responses` declares `temperature` and `top_p`; `top_k` is not in OpenAI's
 * Responses schema, but this front door has always accepted it
 * (`responses-to-gemini-request.ts` reads it) and a target that can express it
 * should receive it rather than have it discarded. Discarded is what the Claude
 * and Completions conversions did — the fix that added `top_k` to both is what
 * these rows pin, so a converter that drops it again fails here instead of
 * leaving the upstream to answer with its own defaults.
 *
 * Each row drives the real `/v1/responses` handler with one config, captures the
 * upstream request body, and asserts the *value* in that target's position. The
 * two OpenAI-Responses modes are verbatim passthroughs, so their row is what the
 * client sent; the Gemini rows read `generationConfig`'s camelCase spelling.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';
import { UPSTREAM_MODES } from '../../src/utils/upstream-modes.js';

const realFetch = globalThis.fetch;

const TEMPERATURE = 0.3;
const TOP_P = 0.5;
const TOP_K = 40;

/**
 * One row per upstream mode: where its wire puts a generation knob (`body`, or
 * Gemini's `generationConfig`) and how that wire spells the two top-* knobs.
 */
const MODES: Array<{
  mode: string;
  baseUrl: string;
  container: 'body' | 'generationConfig';
  pKey: string;
  kKey: string;
}> = [
  { mode: 'openai-completions', baseUrl: 'https://api.example.com/v1', container: 'body', pKey: 'top_p', kKey: 'top_k' },
  { mode: 'anthropic-messages', baseUrl: 'https://api.example.com', container: 'body', pKey: 'top_p', kKey: 'top_k' },
  { mode: 'openai-responses', baseUrl: 'https://api.example.com/v1', container: 'body', pKey: 'top_p', kKey: 'top_k' },
  { mode: 'open-responses', baseUrl: 'https://api.example.com/v1', container: 'body', pKey: 'top_p', kKey: 'top_k' },
  {
    mode: 'gemini-generatecontent', baseUrl: 'https://generativelanguage.googleapis.com',
    container: 'generationConfig', pKey: 'topP', kKey: 'topK',
  },
  {
    mode: 'gemini-interactions', baseUrl: 'https://generativelanguage.googleapis.com',
    container: 'generationConfig', pKey: 'topP', kKey: 'topK',
  },
];

let configPath = '';
let upstreamBody: Record<string, any> | undefined;

beforeEach(() => {
  clearProxyConfigCache();
  upstreamBody = undefined;
  configPath = '';
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    upstreamBody = JSON.parse(await new Response(init?.body as BodyInit).text());
    // The reply's shape is not what these rows assert; each handler converts it or
    // relays it, and the request body is captured by the time it is read.
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearProxyConfigCache();
  if (configPath) {
    unlinkSync(configPath);
    configPath = '';
  }
});

function writeConfig(mode: string, baseUrl: string): string {
  const path = join(tmpdir(), `responses_knobs_${mode.replace(/\W/g, '_')}_${Date.now()}_${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(path, `
[models.default]
upstream_mode = "${mode}"
base_url = "${baseUrl}"
api_key = "knob-key"
`, 'utf-8');
  return path;
}

async function postResponses(body: Record<string, unknown>): Promise<Response> {
  return handler.fetch(new Request('http://localhost/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer knob-key' },
    body: JSON.stringify(body),
  }), { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any);
}

it('has a row for every accepted upstream mode', () => {
  assert.deepEqual(
    MODES.map(row => row.mode).sort(),
    [...UPSTREAM_MODES].sort(),
    'a new upstream mode needs its knob placement declared here',
  );
});

for (const { mode, baseUrl, container, pKey, kKey } of MODES) {
  it(`${mode} receives temperature, ${pKey} and ${kKey}`, async () => {
    configPath = writeConfig(mode, baseUrl);

    const response = await postResponses({
      model: 'client-model',
      input: 'Introduce Shanghai in one sentence',
      temperature: TEMPERATURE,
      top_p: TOP_P,
      top_k: TOP_K,
    });
    await response.text();

    assert.equal(response.status, 200);
    assert.ok(upstreamBody, 'the upstream must have been called');
    const knobs = container === 'body' ? upstreamBody : upstreamBody[container];
    assert.ok(knobs, `${container} must be present on the upstream request`);
    assert.equal(knobs.temperature, TEMPERATURE);
    assert.equal(knobs[pKey], TOP_P);
    assert.equal(knobs[kKey], TOP_K);
  });
}
