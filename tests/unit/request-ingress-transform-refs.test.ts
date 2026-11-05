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
 *     `[spool] enabled`) and the hook runs later, inside `runAttempt`
 *     (`src/index.ts:2388`), on a clone of that same body. The hook does not
 *     rehydrate, so the ops in the last block below are operating on refs.
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
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
 */
function openaiUrlBody(): string {
  return JSON.stringify({
    model: 'test-model',
    max_tokens: 32,
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE}` } }],
    }],
  });
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

function writeConfig({ enabled, set }: { enabled: boolean; set: string }): void {
  const spoolKeys = [`enabled = ${enabled}`, enabled ? `dir = ${JSON.stringify(join(tempDir, 'spool'))}` : '']
    .filter((line) => line !== '');

  writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"

[spool]
${spoolKeys.join('\n')}

[transforms.default]
openai-completions = ["${set}"]

[transforms.${set}]
schema = "openai-completions"
request_ingress.ops = [${OPS[set]}]
`, 'utf8');
  clearProxyConfigCache();
}

function env(): Record<string, string> {
  return { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' };
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
