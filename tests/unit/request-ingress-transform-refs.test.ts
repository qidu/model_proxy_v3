/**
 * §5.4 "consumer contracts" — the half `transform-ref-matrix.test.ts` forwards to:
 * what a transform can name at load time, and what `request_ingress` actually
 * runs on when the body already holds spool refs.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.4, §10.
 *
 * The matrix pins what each door *sends* once a transform has run on a ref-bearing
 * body. It takes two things for granted that nothing else pins:
 *
 *  1. the load-time schema that decides which paths a transform may name at all.
 *     `SCHEMA_PATHS` (config-loader.ts) lists shallow positions only, so an op
 *     that would reach *into* a payload — `messages[].content[].source.data` and
 *     its Gemini/OpenAI spellings — is refused by `validateTransformSet` with
 *     `unknown path`, and a path the schema does list but the engine cannot walk
 *     is refused separately. Refused is not the same as blocked: the refusal is
 *     an error record, not a thrown load (see the third block below), so the op
 *     reaches the engine anyway and lands somewhere the author did not name.
 *
 *  2. that `request_ingress` runs on a body that is *already* refs. Extraction
 *     happens in the router's body-parse block (`src/index.ts:1424`, gated on
 *     `[spool] enabled`) and the hook runs later, inside `runAttempt` (the
 *     `request_ingress` block), on the same body read through the request-side
 *     spool (`receiveIngressBody`, bounded by `max_request_bytes`, spilled above
 *     `threshold_bytes`) rather than on a `Request.clone()` — a clone tees the
 *     body, so the branch nobody reads stays resident while the read runs, which
 *     is the second full copy of an image-bearing body §5.7 rules out. The hook
 *     does not rehydrate, so the ops in the last block below are operating on
 *     refs.
 *
 * ## What block 4 can and cannot prove
 *
 * From outside the process, a hypothetical pre-hook rehydration is
 * indistinguishable from running the hook on refs: either way the op sees a
 * walkable body and either way the payload reaches the upstream. The ordering
 * therefore rests on two observations rather than on a black-box difference —
 * the call sites above, and the store's own count sampled at the moment of the
 * send (`diskEntries === 1` while the request is in flight). Stated here so the
 * cases are not read as a proof they cannot be.
 *
 * The fifth block pins the read itself, which the rest of this file takes for
 * granted: that it is a *bounded receive* (so a tight `max_total_bytes` counts
 * it) and that reading it that way changes none of the bytes it forwards.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import handler from '../../src/index.js';
import {
  clearProxyConfigCache,
  parseSimpleToml,
  validateAllTransforms,
  validateTransformSet,
  type ModelRouteConfig,
  type ProxyConfig,
  type TransformSet,
} from '../../src/utils/config-loader.js';
import { clearModelCache } from '../../src/handlers/models.js';
import { getBlobStoreStats, resetBlobStore } from '../../src/utils/blob-store.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { getSpoolConfig, requestSpillDir } from '../../src/utils/spool.js';
import {
  runHook,
  type HookBodyPayload,
  type HookContext,
} from '../../src/utils/request-transform.js';

const realFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Helpers (mirroring request-transform.test.ts)
// ---------------------------------------------------------------------------

function makeRoute(transforms: TransformSet[]): ModelRouteConfig {
  return { targetUrl: 'https://example.com', upstreamMode: 'openai-completions', transforms };
}

function makeCtx(transforms: TransformSet[]): HookContext {
  return {
    hook: 'request_ingress',
    route: makeRoute(transforms),
    upstreamMode: 'openai-completions',
    clientModel: 'test-model',
    requestId: 'req-1',
    streaming: false,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
  };
}

function payload(body: Record<string, unknown>): HookBodyPayload {
  return { body, headers: {} };
}

/** Parse TOML text into a config the same way the loader does at start-up. */
function parse(toml: string): ProxyConfig {
  return parseSimpleToml(toml) as ProxyConfig;
}

function setNamed(config: ProxyConfig, name: string): TransformSet {
  const set = config.transforms?.[name];
  assert.ok(set, `the loader did not produce a transform set named "${name}"`);
  return set;
}

function messagesOf(error: { set: string; message: string }[]): string[] {
  return error.map((e) => `${e.set}: ${e.message}`);
}

// ---------------------------------------------------------------------------
// 1. The load-time schema: a payload position is not nameable
// ---------------------------------------------------------------------------

/**
 * Six sets, one per position under test. The payload positions are the three
 * spellings a ref can occupy in a request (§5.3's extraction allowlist):
 * Anthropic `source.data`, the OpenAI data-URL `image_url.url`, and Gemini
 * `inline_data.data`. `messages[].content` and `max_tokens` are the nearest
 * legal neighbours — the subtree that *contains* a ref, and a scalar beside it.
 */
const SCHEMA_PROBE = `
[transforms.anthropic_payload]
schema = "anthropic-messages"
request_ingress.ops = [{op="remove",path="messages[].content[].source.data"}]

[transforms.openai_payload]
schema = "openai-completions"
request_ingress.ops = [{op="remove",path="messages[].content[].image_url.url"}]

[transforms.gemini_payload]
schema = "gemini-generatecontent"
request_ingress.ops = [{op="remove",path="contents[].parts[].inline_data.data"}]

[transforms.anthropic_container]
schema = "anthropic-messages"
request_ingress.ops = [{op="remove",path="messages[].content"}]

[transforms.openai_scalar]
schema = "openai-completions"
request_ingress.ops = [{op="remove",path="max_tokens"}]

[transforms.openai_unwalkable]
schema = "openai-completions"
request_ingress.ops = [{op="remove",path="$response.choices[].message.role"}]
`;

describe('§5.4 load-time schema: a payload position is not a nameable transform path', () => {
  it('refuses each schema\'s payload position as an unknown path', () => {
    const config = parse(SCHEMA_PROBE);

    const cases: Array<[string, string]> = [
      ['anthropic_payload', 'messages[].content[].source.data'],
      ['openai_payload', 'messages[].content[].image_url.url'],
      ['gemini_payload', 'contents[].parts[].inline_data.data'],
    ];

    for (const [name, path] of cases) {
      const errors = validateTransformSet(name, setNamed(config, name));
      assert.deepEqual(
        messagesOf(errors),
        [`${name}: [request_ingress] unknown path "${path}" for schema "${setNamed(config, name).schema}"`],
        `${path} must be refused, and by its own position — not by an incidental error`,
      );
    }
  });

  it('accepts the subtree that holds a payload and a scalar beside it', () => {
    const config = parse(SCHEMA_PROBE);

    assert.deepEqual(validateTransformSet('anthropic_container', setNamed(config, 'anthropic_container')), []);
    assert.deepEqual(validateTransformSet('openai_scalar', setNamed(config, 'openai_scalar')), []);
  });

  it('refuses a listed path the engine cannot walk, with the second message kind', () => {
    const config = parse(SCHEMA_PROBE);

    // `$response.choices[].message.role` *is* in openai-completions' SCHEMA_PATHS,
    // so it clears the first check and is stopped by isPathWalkable instead. Both
    // branches of validateTransformSet are therefore live, and a reader of an
    // error line can tell which one fired.
    const errors = validateTransformSet('openai_unwalkable', setNamed(config, 'openai_unwalkable'));
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /is declared for schema "openai-completions" but the engine cannot walk it/);
  });

  it('reports rather than refuses: the operation survives the load and reaches the engine', () => {
    const config = parse(SCHEMA_PROBE);

    // The three refusals above do not block the config. `parseSimpleToml` records
    // them (they surface to the dashboard as `config_errors`) and the proxy serves
    // anyway — deliberately, because the same parser runs the serialization
    // round-trip that every config mutation depends on. The consequence is pinned
    // in the next block: an op on a refused path is not inert.
    const op = setNamed(config, 'anthropic_payload').request_ingress?.ops?.[0];
    assert.equal(op?.path, 'messages[].content[].source.data');
    assert.equal(validateAllTransforms(config).length, 4, 'three unknown paths and one unwalkable path');
  });
});

// ---------------------------------------------------------------------------
// 2. What the engine does with a refused path
// ---------------------------------------------------------------------------

describe('§5.4 engine behaviour: a refused deep path degrades to a literal key', () => {
  it('writes a literal key beside the payload instead of reaching it', () => {
    const config = parse(`
[transforms.deep]
schema = "anthropic-messages"
request_ingress.ops = [{op="set",path="messages[].content[].source.data",value="FORGED"}]
`);
    const set = setNamed(config, 'deep');
    const body = {
      model: 'test-model',
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
      }],
    };

    const out = runHook('request_ingress', payload(body), makeCtx([set]));
    const message = (out.body.messages as any[])[0];

    // `parsePath` matches the `messages[...]` prefix and hands `applyOpToObject`
    // the remainder as one literal key, so `set` adds a key nobody will read...
    assert.equal(message['content[].source.data'], 'FORGED');
    // ...and the payload the author meant to replace is untouched. A transform can
    // therefore neither read nor write a payload — which is the §5.4 property, and
    // it holds by degradation rather than by enforcement.
    assert.equal((message.content as any[])[0].source.data, 'AAAA');
  });

  it('reaches the container of the payload when the path is legal, ref and all', () => {
    const config = parse(`
[transforms.container]
schema = "anthropic-messages"
request_ingress.ops = [{op="set",path="messages[role=user].content",value="rewritten"}]
`);
    const set = setNamed(config, 'container');
    const body = {
      model: 'test-model',
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
      }],
    };

    const out = runHook('request_ingress', payload(body), makeCtx([set]));
    const message = (out.body.messages as any[])[0];

    // One level up is legal, and replacing the container takes the payload with it.
    assert.equal(message.content, 'rewritten');
    assert.equal(Object.keys(message).includes('content'), true);
  });
});

// ---------------------------------------------------------------------------
// 3. The ordering: the hook runs on a body of refs, through the real proxy
// ---------------------------------------------------------------------------

const IMAGE = Buffer.alloc(4096, 0x5a).toString('base64');

const CHAT_COMPLETION = JSON.stringify({
  id: 'chat-ingress', object: 'chat.completion', created: 1, model: 'test',
  choices: [{ index: 0, message: { role: 'assistant', content: 'seen' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
});

/**
 * A `/v1/messages` body the client already spelled as OpenAI — the rung that
 * converts nothing, so the ref stays in the field the client wrote and the send
 * re-detects it on the outgoing body (`messages.ts:468`). Its `image_url.url` is
 * one of the positions the extraction pass rewrites (§5.3).
 *
 * `pad` appends that many characters of ordinary text. Extraction replaces the
 * image with a ref, so the attempt body handed to `request_ingress` is the
 * scaffolding, the ref, and whatever text the body carries — with no text it is
 * a few hundred bytes and therefore *below* `threshold_bytes`, which is why the
 * read's own spill needs the pad to be observable (see block 5).
 */
function openaiUrlBody(pad = 0): string {
  const messages: Array<Record<string, unknown>> = [{
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE}` } }],
  }];
  if (pad > 0) messages.push({ role: 'user', content: 'x'.repeat(pad) });
  return JSON.stringify({ model: 'test-model', max_tokens: 32, messages });
}

/** The ingress op each case installs; `set` values are quoted, as TOML requires. */
const OPS: Record<string, string> = {
  // Legal shallow scalar: proves the hook ran, without going near the ref.
  ingress_keep: '{op="set",path="prompt_cache_key",value="ingress-probe"}',
  // Legal container: discards the only ref in the body.
  ingress_drop: '{op="set",path="messages[role=user].content",value="[image omitted by transform]"}',
};

let tempDir = '';
let configPath = '';
let upstreamCalls = 0;
/** One entry per upstream send, sampled while the request is still in flight. */
let sent: Array<{ text: string; streamed: boolean; disk: number }> = [];

/**
 * `set: null` installs no `request_ingress` transform at all. Block 6 needs that:
 * the ledger's window for the dump's read is only its own once the hook's read
 * (block 5) is out of the way, and both peak at the same three charges.
 */
function writeConfig({ enabled, set, spool = {} }: { enabled: boolean; set: string | null; spool?: Record<string, number> }): void {
  const spoolKeys = [
    `enabled = ${enabled}`,
    enabled ? `dir = ${JSON.stringify(join(tempDir, 'spool'))}` : '',
    ...Object.entries(spool).map(([key, value]) => `${key} = ${value}`),
  ].filter((line) => line !== '');
  const transforms = set === null ? '' : `
[transforms.default]
openai-completions = ["${set}"]

[transforms.${set}]
schema = "openai-completions"
request_ingress.ops = [${OPS[set]}]
`;

  writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"

[spool]
${spoolKeys.join('\n')}
${transforms}`, 'utf8');
  clearProxyConfigCache();
}

function env(logLevel = 'error'): Record<string, string> {
  return { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: logLevel };
}

function clientRequest(bodyText: string): Request {
  return new Request('http://proxy/v1/messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
    body: bodyText,
  });
}

async function sentBodyText(init: RequestInit | undefined): Promise<string> {
  const body = init?.body;
  if (typeof body === 'string') return body;
  assert.ok(body instanceof ReadableStream, `expected a string or streamed body, got ${Object.prototype.toString.call(body)}`);
  return await new Response(body).text();
}

/** The request-side spill directory as the live config points at it. */
function spillFiles(): string[] {
  const dir = requestSpillDir(getSpoolConfig());
  return existsSync(dir) ? readdirSync(dir) : [];
}

beforeEach(() => {
  clearProxyConfigCache();
  clearModelCache();
  resetBlobStore();
  tempDir = mkdtempSync(join(tmpdir(), 'mpv3-ingress-transform-'));
  configPath = join(tempDir, 'proxy.toml');
  upstreamCalls = 0;
  sent = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    upstreamCalls += 1;
    sent.push({
      text: await sentBodyText(init),
      streamed: typeof init?.body !== 'string',
      disk: getBlobStoreStats().diskEntries,
    });
    return new Response(CHAT_COMPLETION, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  clearProxyConfigCache();
  clearModelCache();
  resetBlobStore();
  globalThis.fetch = realFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('§5.4 request_ingress runs on a body that is already refs', () => {
  it('applies a legal op to the ref-bearing body and still delivers the payload upstream', async () => {
    const bodyText = openaiUrlBody();

    writeConfig({ enabled: false, set: 'ingress_keep' });
    const off = await handler.fetch(clientRequest(bodyText), env() as any);
    assert.equal(off.status, 200);

    writeConfig({ enabled: true, set: 'ingress_keep' });
    const on = await handler.fetch(clientRequest(bodyText), env() as any);
    assert.equal(on.status, 200);

    assert.equal(upstreamCalls, 2);
    const [baseline, live] = sent;

    // The op ran on both runs — so the byte comparison below compares the same
    // logical body, and the only variable is whether refs were in it.
    assert.ok(baseline.text.includes('"prompt_cache_key":"ingress-probe"'), 'the op ran with spooling off');
    assert.ok(live.text.includes('"prompt_cache_key":"ingress-probe"'), 'and it ran on the ref-bearing body too');

    assert.ok(baseline.text.includes(IMAGE), 'with spooling off the payload is inline all the way');
    assert.ok(live.text.includes(IMAGE), 'with spooling on the ref was streamed back in at the send, not dropped');
    assert.ok(!live.text.includes('$spoolBlob'), 'no ref marker may reach the upstream');

    assert.equal(live.text, baseline.text, 'the ref round-trip is lossless: the two runs agree byte for byte');
    assert.equal(live.streamed, true, 'the op left the ref in the body it moved, so the send streams the payload at its offset');
    assert.equal(baseline.disk, 0, 'nothing is extracted with spooling off');
    assert.equal(live.disk, 1, 'the payload was already in the store when the ingress op ran');
    assert.equal(getBlobStoreStats().diskEntries, 1);
  });

  it('lets an op discard the ref\'s container entirely, leaving nothing behind', async () => {
    const bodyText = openaiUrlBody();

    writeConfig({ enabled: false, set: 'ingress_drop' });
    const off = await handler.fetch(clientRequest(bodyText), env() as any);
    assert.equal(off.status, 200);

    writeConfig({ enabled: true, set: 'ingress_drop' });
    const on = await handler.fetch(clientRequest(bodyText), env() as any);
    assert.equal(on.status, 200);

    assert.equal(upstreamCalls, 2);
    const [baseline, live] = sent;

    assert.ok(baseline.text.includes('[image omitted by transform]'), 'the op replaced the content');
    assert.ok(!baseline.text.includes('data:image/png;base64,'), 'and with it the only payload in the body');

    assert.equal(live.text, baseline.text, 'a dropped ref container leaves nothing behind: byte for byte the same');
    assert.ok(!live.text.includes('$spoolBlob'), 'in particular no orphaned ref, though the body carried one into the hook');
    // The send re-detects refs on the *outgoing* body, so with the only ref gone
    // it degrades to a plain string — the one call site where the matrix header's
    // Rule-B-with-a-dropped-ref cell is measured. Still, this is not the evidence
    // of the drop; the byte equality above is. What it adds is that the ref the
    // body carried into the hook is neither expanded nor streamed out again: the
    // op took it and nothing downstream went looking for it.
    assert.equal(live.streamed, false, 'with the ref gone the egress is a string, not a stream');
    assert.equal(baseline.disk, 0);
    assert.equal(live.disk, 1, 'the payload was extracted before the op ran');
    assert.equal(
      getBlobStoreStats().diskEntries,
      1,
      'and it stays in the store, unreferenced by this request, until the store\'s own sweep',
    );
  });
});

// ---------------------------------------------------------------------------
// 5. The read itself: a bounded receive, not a clone
// ---------------------------------------------------------------------------

/**
 * The block above takes the hook's read of the attempt body for granted. Here it
 * is the subject. `request_ingress` used to read `attemptRequest.clone().text()`;
 * a clone tees the body, so the branch nobody reads stays resident for as long as
 * the read runs — the second full copy of an image-bearing body §5.7 exists to
 * avoid. The block now consumes `attemptRequest.body` through `receiveIngressBody`
 * instead, which is observable in exactly one way from outside: the read is
 * charged to the spill ledger like any other materialization.
 *
 * The third case is therefore the discriminating one — the budget admits both
 * spills that precede the read and is breached *by the read itself*. Under the
 * clone the ledger never saw that read at all, and the same request at the same
 * budget returned 200 (measured by reverting the read to `clone().text()` and
 * re-running this case).
 *
 * The budget is only observable when the read actually spills, and the read's
 * subject is the *attempt* body — the body after §5.4 extraction replaced the
 * image with a ref. That is why each case pads: with an image alone the attempt
 * body is a few hundred bytes, below `threshold_bytes`, and nothing spills. With
 * a 4000-character pad the three charges are, measured:
 *
 *   ingress receive      9638   (the raw body, `max_request_bytes`-bounded)
 *   ladder rebuild       4313   (the ref-bearing body the router sends the rung)
 *   the ingress read     4313   (this block's subject)
 *                        ----
 *   peak                18264   against a clone path's 13951
 *
 * so `1.5x` the raw body (14457) sits inside the window `(13951, 18264)` and
 * splits the two implementations. The request-side spill is a *second* spill of a
 * body the ingress already spilled: above `threshold_bytes` the read costs disk
 * churn where it used to cost RAM. That trade is the point, and it is why a tight
 * `max_total_bytes` can now refuse a request it previously served.
 */
describe('§5.1/§5.7 the request_ingress body read is a bounded receive', () => {
  it('charges the read to max_total_bytes and reports the refusal as a spill budget error', async () => {
    const bodyText = openaiUrlBody(4000);
    const bytes = Buffer.byteLength(bodyText, 'utf8');

    // Both spills before the read fit (9638 + 4313 = 13951); the read's own copy
    // (another 4313) does not.
    writeConfig({
      enabled: true,
      set: 'ingress_keep',
      spool: { threshold_bytes: 1024, max_total_bytes: Math.floor(bytes * 1.5) },
    });

    const resp = await handler.fetch(clientRequest(bodyText), env() as any);

    assert.equal(resp.status, 503);
    const payload = await resp.json() as { type: string; error: { type: string; message: string } };
    assert.equal(payload.type, 'error');
    assert.equal(payload.error.type, 'over_limit_error');
    assert.match(payload.error.message, /live spill budget exceeded/);

    // The refusal is the read's own, not the upstream's: the body never left.
    assert.equal(upstreamCalls, 0, 'a refused read must not reach the upstream');
    // Rule #8: a refusal that leaves its reservation behind holds the budget
    // forever. Both the failed read and the ingress copy are accounted for.
    assert.equal(getLiveSpillBytes(), 0, 'the refusals return every reservation they took');
    assert.deepEqual(spillFiles(), [], 'and the partial file is removed, not merely unreferenced');
  });

  it('reads above threshold without changing one byte of the body it forwards', async () => {
    const bodyText = openaiUrlBody(4000);
    const bytes = Buffer.byteLength(bodyText, 'utf8');

    writeConfig({ enabled: false, set: 'ingress_keep' });
    const off = await handler.fetch(clientRequest(bodyText), env() as any);
    assert.equal(off.status, 200);

    // The same transforms, on the same body, with the read spilled to disk and a
    // budget that admits all three charges (2x = 19276 > 18264) — so this case
    // also pins that the read's reservation is released before the post-hook
    // egress rebuild asks for a fourth.
    writeConfig({
      enabled: true,
      set: 'ingress_keep',
      spool: { threshold_bytes: 1024, max_total_bytes: Math.floor(bytes * 2) },
    });
    const on = await handler.fetch(clientRequest(bodyText), env() as any);
    assert.equal(on.status, 200);

    assert.equal(upstreamCalls, 2);
    const [baseline, live] = sent;

    assert.ok(live.text.includes('"prompt_cache_key":"ingress-probe"'), 'the hook still ran on the received body');
    assert.equal(live.text, baseline.text, 'a spooled read of the attempt body is byte-identical to the cloned one');
    assert.ok(live.text.includes(IMAGE), 'and the ref was expanded at the send, as before');
    assert.ok(
      Buffer.byteLength(live.text, 'utf8') > 1024,
      'the read\'s subject really was above threshold, so this exercise covered the spilling path',
    );

    assert.equal(getLiveSpillBytes(), 0, 'both spills — the ingress one and the read\'s — return their reservations');
    assert.deepEqual(spillFiles(), [], 'and neither is left on disk after the response completes');
    assert.equal(getBlobStoreStats().diskEntries, 1, 'the payload itself is still the blob store\'s, untouched by the read');
  });
});

// ---------------------------------------------------------------------------
// 6. The other clone of the attempt body: the LOG_LEVEL=debug dump
// ---------------------------------------------------------------------------

/**
 * `runAttempt` held a second `attemptRequest.clone()`: the debug dump, gated on
 * `path === '/v1/messages' && LOG_LEVEL === 'debug'`. Same defect as block 5's
 * read and worse consequence — this one runs right before dispatch, so the
 * handler's own read is the branch held in RAM while the dump is written.
 *
 * Unlike block 5's read, the body cannot be consumed and dropped: the handler
 * sends it a few lines later. The block therefore hands the request a stream
 * over the same spool it just read (`new Request(attemptRequest, { body:
 * received.readStream() })`, the idiom of the ingress receive at `src/index.ts`
 * — the dump would otherwise log the body and forward an empty one, which is
 * what the byte-equality case below is for.
 *
 * The dump also shows, without being designed to, what a ref looks like at that
 * point in the pipeline: with spooling on the payload is already a `$spoolBlob`
 * ref, so `test_model.log` holds the marker and not the base64. Pinned because
 * it is the honest reading of the file an operator opens when debugging, and
 * because a future rehydrate-before-dump would show up here as a difference.
 */

/** Scratch `$TMPDIR` so the operator's own `/tmp/test_model.log` is untouched. */
const logDirs: string[] = [];

async function withLogDir<T>(body: (logPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'mpv3-debug-log-'));
  logDirs.push(dir);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    return await body(join(dir, 'test_model.log'));
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

/** The body section of the dump, as JSON, as the dump wrote it. */
function dumpedBody(log: string): unknown {
  const marker = 'request body:\n';
  const at = log.indexOf(marker);
  assert.notEqual(at, -1, `the dump carried no body section:\n${log}`);
  return JSON.parse(log.slice(at + marker.length));
}

describe('§5.1/§5.7 the LOG_LEVEL=debug dump reads the attempt body without a clone', () => {
  afterEach(() => {
    for (const dir of logDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('forwards every byte of the body it just logged, and leaves no spill behind', async () => {
    const bodyText = openaiUrlBody(4000);
    const bytes = Buffer.byteLength(bodyText, 'utf8');

    writeConfig({ enabled: false, set: null });
    const off = await handler.fetch(clientRequest(bodyText), env() as any);
    assert.equal(off.status, 200);

    // Above threshold and with a budget that admits every charge the dump's
    // read makes, so the spill and its release are exercised without a refusal:
    // 2x = 19276, above the 18264 peak the read reaches on this body.
    writeConfig({
      enabled: true,
      set: null,
      spool: { threshold_bytes: 1024, max_total_bytes: Math.floor(bytes * 2) },
    });

    const logText = await withLogDir(async (logPath) => {
      const on = await handler.fetch(clientRequest(bodyText), env('debug') as any);
      assert.equal(on.status, 200);
      assert.ok(existsSync(logPath), 'the dump is still written');
      return readFileSync(logPath, 'utf8');
    });

    assert.equal(upstreamCalls, 2);
    const [baseline, live] = sent;

    // The dump must not have eaten the body: the handler still sends it whole.
    assert.equal(live.text, baseline.text, 'a logged body is forwarded byte for byte');
    assert.ok(live.text.includes(IMAGE), 'the ref was expanded at the send, as before');
    assert.ok(!live.text.includes('$spoolBlob'), 'no ref marker reaches the upstream');

    // And the dump logged the same body it forwarded — at the stage it is
    // written in, i.e. before the send re-expands the ref. Only the payload
    // position differs from the forwarded body, and it differs the way the
    // pipeline says it must: a ref, not the base64.
    type Body = { messages: Array<{ content: Array<{ image_url: { url: unknown } }> }> };
    const dumped = dumpedBody(logText) as Body;
    const forwarded = JSON.parse(baseline.text) as Body;
    const dumpedUrl = dumped.messages[0]?.content[0]?.image_url.url as { $spoolBlob?: boolean };
    assert.equal(dumpedUrl.$spoolBlob, true, 'the payload was already a ref when the dump ran — the base64 is the blob store\'s, not the log\'s');
    if (dumped.messages[0]?.content[0]?.image_url) dumped.messages[0].content[0].image_url.url = forwarded.messages[0]?.content[0]?.image_url.url;
    assert.deepEqual(dumped, forwarded, 'apart from the payload position the dump is the body that was sent');
    assert.ok(!logText.includes(IMAGE.slice(0, 64)), 'in particular the dump does not carry the payload');

    // The re-wrapped stream owns the spool: the handler drains it, the spill goes.
    assert.equal(getLiveSpillBytes(), 0, 'every reservation is returned once the response completes');
    assert.deepEqual(spillFiles(), [], 'and no spill file outlives the request');
    assert.equal(getBlobStoreStats().diskEntries, 1, 'the payload itself is still the blob store\'s');
  });

  it('charges the dump\'s read to max_total_bytes and answers the refusal instead of forwarding an empty body', async () => {
    const bodyText = openaiUrlBody(4000);
    const bytes = Buffer.byteLength(bodyText, 'utf8');

    // No `request_ingress` transform here: block 5's read would take the same
    // third charge the dump does and breach this budget first, making the
    // dump's own charge unobservable. Without it the charges are the ingress
    // receive (9638) and the rung's rebuild (4313) — a peak of 13951 — and the
    // dump's own copy (another 4313) is the charge that breaches: 14457 sits
    // above 13951 and below the 18264 peak the dump's read reaches. So the
    // request is refused here only because the dump read the body.
    writeConfig({
      enabled: true,
      set: null,
      spool: { threshold_bytes: 1024, max_total_bytes: Math.floor(bytes * 1.5) },
    });

    const resp = await withLogDir(async () => handler.fetch(clientRequest(bodyText), env('debug') as any));

    assert.equal(resp.status, 503);
    const payload = await resp.json() as { type: string; error: { type: string; message: string } };
    assert.equal(payload.type, 'error');
    assert.equal(payload.error.type, 'over_limit_error');
    assert.match(payload.error.message, /live spill budget exceeded/);

    // The refusal is the dump's, and it is answered rather than swallowed into
    // the failure line: the consumed body never went anywhere.
    assert.equal(upstreamCalls, 0, 'a refused dump must not send an empty body upstream');
    assert.equal(getLiveSpillBytes(), 0, 'the refusal returns every reservation it took');
    assert.deepEqual(spillFiles(), [], 'and no partial file is left behind');
  });

  it('leaves the debug path alone when it is off', async () => {
    const bodyText = openaiUrlBody(4000);
    const bytes = Buffer.byteLength(bodyText, 'utf8');

    writeConfig({
      enabled: true,
      set: null,
      spool: { threshold_bytes: 1024, max_total_bytes: Math.floor(bytes * 1.5) },
    });

    // Same body, same budget as the refusal above, `LOG_LEVEL=error`: the dump
    // does not run, so the 4313-byte charge that breached it is absent, the
    // peak stays at 13951 and the request is served. That is what makes the
    // refusal the dump's own rather than a cost every request at this budget
    // pays.
    const off = await withLogDir(async (logPath) => {
      const resp = await handler.fetch(clientRequest(bodyText), env() as any);
      assert.equal(existsSync(logPath), false, 'no dump is written when the debug gate is closed');
      return resp;
    });

    assert.equal(off.status, 200, 'the read under test is the dump\'s own, not a cost every request pays');
    assert.equal(upstreamCalls, 1);
    assert.equal(getLiveSpillBytes(), 0);
    assert.deepEqual(spillFiles(), []);
  });
});
