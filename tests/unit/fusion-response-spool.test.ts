import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';
import { clearModelCache } from '../../src/handlers/models.js';
import { resetBlobStore } from '../../src/utils/blob-store.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { getAdmittedBytes, resetAdmission } from '../../src/utils/spool-admission.js';
import { SPOOL_DEFAULTS, setSpoolConfig } from '../../src/utils/spool.js';

// §5.7 for the fusion pipeline's own response reads (`src/index.ts`): the panel
// and judge bodies are read through one bounded receive instead of
// `resp.clone().json()`, and the synthesis body — the only one of the three the
// client ever sees — is received once, parsed for `fusion_metadata`, and handed
// back out of that same spool. These tests drive the real handler end to end
// against a stubbed upstream, so what they pin is the whole exchange:
//
//   1. `Response.prototype.clone()` is never called: no second copy of any of
//      the three bodies is ever held (§5.7: "do not call
//      `response.clone().text()` or buffer a second copy").
//   2. The client's answer is byte-identical with the spool on (tiny
//      `threshold_bytes`, so all three bodies spill) and off — the rebuilt
//      enriched body loses nothing — and the exchange leaves no spill bytes and
//      no §5.9 reservation behind.
//   3. A synthesis body advertised as JSON but not parseable is forwarded
//      unchanged, which is the branch that rebuilds the client's response from
//      the spool rather than from a materialized string.
//   4. A judge stage that breaches `max_response_bytes` fails the request
//      instead of degrading into a successful-looking answer; a judge that
//      merely answers with something other than an analysis still degrades.
//
// Deliberately out of scope: the fusion prompt construction and the panel /
// judge / synth ordering (index-routing.test.ts), and the config resolution of
// a fusion alias itself (config-loader). The cap cannot be used to prove which
// of the three reads saw a breach — the attempt loop's stats read and the
// egresses already bound every one of these bodies before fusion reads them —
// so case 4 pins the judge stage's *behaviour*, not the read that raised it.

const realFetch = globalThis.fetch;

const PANEL_ANSWER = 'four';
const SYNTH_ANSWER = 'The panel agrees: 4.';
const ANALYSIS = {
  consensus: ['four'],
  contradictions: [],
  partial_coverage: [],
  unique_insights: [],
  blind_spots: [],
};

/** An Anthropic-shaped upstream message, the shape all three targets answer in. */
function anthropicMessage(model: string, text: string): Record<string, unknown> {
  return {
    id: `msg-${model}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 3 },
  };
}

let tempDir = '';
let configPath = '';
let sentModels: string[] = [];
/** Per-target answer; each test may replace it. */
let responder: (model: string) => { status: number; body: string };

function defaultResponder(model: string): { status: number; body: string } {
  if (model === 'judge-b') return { status: 200, body: JSON.stringify(anthropicMessage(model, JSON.stringify(ANALYSIS))) };
  if (model === 'synth-c') return { status: 200, body: JSON.stringify(anthropicMessage(model, SYNTH_ANSWER)) };
  return { status: 200, body: JSON.stringify(anthropicMessage(model, PANEL_ANSWER)) };
}

function writeConfig({ enabled = true, thresholdBytes = 64, maxResponseBytes = 1 << 20 }): void {
  writeFileSync(configPath, `
[models.default]
upstream_mode = "anthropic-messages"
base_url = "https://upstream.example"
api_key = "upstream-key"

[composite]
"fusion-alias" = {fusion_options = {min_panel = 1, judge_required = false, expose_metadata = true}, "panel-a" = {role = "panel"}, "judge-b" = {role = "judge"}, "synth-c" = {role = "synth"}}

[spool]
enabled = ${enabled}
dir = ${JSON.stringify(join(tempDir, 'spool'))}
threshold_bytes = ${thresholdBytes}
max_response_bytes = ${maxResponseBytes}
`, 'utf8');
  clearProxyConfigCache();
}

/** The text the upstream received, whichever egress shape carried it. */
async function sentBodyText(init: RequestInit | undefined): Promise<string> {
  const body = init?.body;
  if (typeof body === 'string') return body;
  assert.ok(body instanceof ReadableStream, `expected a streamed upstream body, got ${Object.prototype.toString.call(body)}`);
  return await new Response(body).text();
}

function clientRequest(): Request {
  return new Request('http://proxy/v1/messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'fusion-alias',
      max_tokens: 64,
      messages: [{ role: 'user', content: 'what is 2+2?' }],
    }),
  });
}

/**
 * Count `Response.prototype.clone()` calls while `run` executes: a bounded
 * receive exists so that no second copy of the body is ever held.
 */
async function countClones<T>(run: () => Promise<T>): Promise<{ result: T; clones: number }> {
  const original = Response.prototype.clone;
  let clones = 0;
  Response.prototype.clone = function clone(this: Response) {
    clones += 1;
    return original.call(this);
  };
  try {
    return { result: await run(), clones };
  } finally {
    Response.prototype.clone = original;
  }
}

/** The client-visible answer body plus its status. */
async function runFusion(response: Response): Promise<{ status: number; text: string }> {
  return { status: response.status, text: await response.text() };
}

beforeEach(() => {
  clearProxyConfigCache();
  clearModelCache();
  resetBlobStore();
  resetAdmission();
  tempDir = mkdtempSync(join(tmpdir(), 'mpv3-fusion-spool-'));
  configPath = join(tempDir, 'proxy.toml');
  sentModels = [];
  responder = defaultResponder;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const sent = JSON.parse(await sentBodyText(init)) as { model: string };
    sentModels.push(sent.model);
    const answer = responder(sent.model);
    return new Response(answer.body, { status: answer.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearProxyConfigCache();
  clearModelCache();
  resetAdmission();
  resetBlobStore();
  setSpoolConfig(SPOOL_DEFAULTS);
  // Both ledgers are process-wide: a leak here would silently weaken later tests.
  assert.equal(getLiveSpillBytes(), 0, 'every spool must return its reservation');
  assert.equal(getAdmittedBytes(), 0, 'every §5.9 lease must be released');
  rmSync(tempDir, { recursive: true, force: true });
});

describe('§5.7 fusion response reads', () => {
  it('reads the panel, judge and synthesis bodies without a second copy', async () => {
    // The spool on is what makes this observable at all: with `enabled = false`
    // the attempt loop's stats read falls back to `response.clone().json()`, so
    // a clone count could not tell the fusion reads apart from it.
    writeConfig({ enabled: true, thresholdBytes: 64 });

    const { result: response, clones } = await countClones(() => handler.fetch(clientRequest(), { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any));
    const { status, text } = await runFusion(response);

    assert.equal(status, 200);
    assert.equal(clones, 0, 'no stage of the fusion pipeline may hold a second copy of a body');
    assert.deepEqual(sentModels, ['panel-a', 'judge-b', 'synth-c'], 'all three stages ran, in order');
    const payload = JSON.parse(text) as Record<string, any>;
    assert.equal(payload.content[0].text, SYNTH_ANSWER, 'the synthesis answer reaches the client unchanged');
    assert.deepEqual(payload.fusion_metadata, {
      alias: 'fusion-alias',
      panel_models: ['panel-a'],
      judge_model: 'judge-b',
      synth_model: 'synth-c',
      panel_errors: [],
      analysis_present: true,
    });
  });

  it('forwards a spilled synthesis body byte for byte, matching the spool-off baseline', async () => {
    writeConfig({ enabled: false });
    const off = await runFusion(await handler.fetch(clientRequest(), { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any));

    // 64 bytes: every one of the three bodies is past the threshold and lives in
    // a `responses/` spill while fusion reads it and while the client reads the
    // synthesis body back out of it.
    writeConfig({ enabled: true, thresholdBytes: 64 });
    const on = await runFusion(await handler.fetch(clientRequest(), { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any));

    assert.equal(off.status, 200);
    assert.equal(on.status, off.status);
    assert.equal(on.text, off.text, 'a spooled round-trip loses no byte of the enriched answer');
    assert.equal(getLiveSpillBytes(), 0, 'the exchange leaves no spill bytes behind');
  });

  it('deletes the stale upstream content-length from the enriched answer', async () => {
    writeConfig({ enabled: true, thresholdBytes: 64 });

    const response = await handler.fetch(clientRequest(), { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any);
    const text = await response.text();

    const payload = JSON.parse(text) as Record<string, unknown>;
    assert.ok('fusion_metadata' in payload, 'the fixture must exercise the enriched branch');
    assert.equal(response.headers.get('content-length'), null, 'the rebuilt body is longer than the upstream declared, so the upstream length would truncate the client read');
  });

  it('forwards a synthesis body advertised as JSON but not parseable, unchanged', async () => {
    writeConfig({ enabled: true, thresholdBytes: 64 });
    // 200 with a JSON content type and a body no parser accepts: the metadata
    // parse fails, so the answer must be forwarded from the spool as it arrived.
    const broken = '{"id":"msg-synth-c","content":[{"type":"text","text":"half an answ';
    responder = (model) => (model === 'synth-c'
      ? { status: 200, body: broken }
      : defaultResponder(model));

    const response = await handler.fetch(clientRequest(), { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any);
    const text = await response.text();

    assert.equal(response.status, 200);
    assert.equal(text, broken, 'an unparseable body is passed through rather than replaced by an empty one');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('fails the request when the judge stage breaches max_response_bytes', async () => {
    // The panel fits, the judge does not: `judge_required = false` is what makes
    // the outcome the judge catch's business — degrading here would answer 200
    // from the raw panel, hiding a proxy limit inside a successful-looking
    // answer (rule #8).
    writeConfig({ enabled: true, thresholdBytes: 64, maxResponseBytes: 512 });
    const padding = 'x'.repeat(1200);
    responder = (model) => (model === 'judge-b'
      ? { status: 200, body: JSON.stringify(anthropicMessage(model, JSON.stringify({ ...ANALYSIS, blind_spots: [padding] }))) }
      : defaultResponder(model));

    const response = await handler.fetch(clientRequest(), { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any);
    const payload = await response.json() as { type: string; error: { type: string; message: string } };

    assert.equal(response.status, 500);
    assert.equal(payload.type, 'error');
    assert.equal(payload.error.type, 'processing_error');
    assert.match(payload.error.message, /Response body too large/);
    assert.deepEqual(sentModels, ['panel-a', 'judge-b'], 'the breach stops the pipeline before synthesis');
    assert.equal(getLiveSpillBytes(), 0, 'the refused body leaves no spill behind');
  });

  it('still degrades to a 200 when the judge answers with something that is not an analysis', async () => {
    // The control for the case above: a judge that answers prose (no JSON
    // object) is a judge failure, not a proxy limit, and must keep degrading.
    writeConfig({ enabled: true, thresholdBytes: 64 });
    responder = (model) => (model === 'judge-b'
      ? { status: 200, body: JSON.stringify(anthropicMessage(model, 'I cannot compare these.')) }
      : defaultResponder(model));

    const response = await handler.fetch(clientRequest(), { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any);
    const text = await response.text();

    assert.equal(response.status, 200);
    const payload = JSON.parse(text) as Record<string, any>;
    assert.equal(payload.content[0].text, SYNTH_ANSWER);
    assert.equal(payload.fusion_metadata.analysis_present, false, 'the degraded synthesis ran without an analysis');
    assert.deepEqual(sentModels, ['panel-a', 'judge-b', 'synth-c']);
  });
});
