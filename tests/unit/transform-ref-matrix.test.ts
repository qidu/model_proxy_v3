/**
 * §5.4 "consumer contracts" — the transform half: every named builtin and every
 * Tier-1 op, run against a body that carries real spool refs, at the hook that
 * actually runs it, through the real handler.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.4, §10.
 *
 * §5.4's mandate is that every consumer of a request body "either run[s] before
 * extraction or understand[s] refs", and that "rehydration must happen only where
 * original bytes are semantically required, not by default on every pass". The
 * extraction pass runs in the router's body-parse block (`src/index.ts:1424`,
 * gated on `[spool] enabled`), before the handler is reached and before the
 * `request_ingress` hook runs inside `runAttempt` (`:2388`); the engine's own
 * hooks (`before_upstream` / `before_conversion`) run later still, so the engine
 * is squarely on the "must understand refs" side of that line. The engine was
 * written before refs existed; `ref-serializer.ts` made a ref *position* opaque
 * to it by keeping the ref a plain JSON object. This file is the evidence for
 * that claim.
 *
 * What is proven, per row:
 *
 *  1. the transform's own effect still happens (the `effect` / `expectBeta`
 *     assertions — a row whose op silently stopped applying would otherwise pass
 *     as "the bytes arrived somehow");
 *  2. the payload's fate is unchanged by spooling — a payload the transform
 *     leaves in place reaches the upstream byte-for-byte, and a payload the
 *     transform *drops* is dropped identically with spooling off, so the loss is
 *     provably the transform's and not the spool's;
 *  3. the upstream bytes are byte-identical to the same run with spooling off
 *     (`transformed.text === expanded.text`);
 *  4. no ref marker ever reaches the upstream;
 *  5. the measured egress shape is the declared one;
 *  6. an inert transform is inert byte-for-byte against the untransformed
 *     baseline (`acts: false`), and an active one provably changed the bytes
 *     (`acts: true`).
 *
 * ## Why the ops address the *subtree* that holds the refs, not the payload field
 *
 * The tier-1 op grammar cannot address a §5.4 payload position, and that is a
 * load-time invariant, not an accident of these fixtures. `parsePath`
 * (request-transform.ts) recognises exactly three shapes: `messages[role=X].<field>`
 * with a single field segment, `$response.<field>` with a single field segment,
 * and everything else as a *literal top-level key*. `validateTransformSet`
 * (config-loader.ts) refuses any path the schema does not list (`unknown path`)
 * and, separately, any listed path the engine cannot walk (`the engine cannot
 * walk it (nested arrays/objects)`) — so `messages[].content[].source.data`,
 * `messages[].content[].image_url.url` and `contents[].parts[].inline_data.data`
 * are all refused by the schema. Refused is not blocked: the refusal is recorded
 * and surfaced (`config_errors`, `[ERROR] transforms.<set>` at load) rather than
 * thrown, so the config still serves and the op still reaches the engine, where
 * it degrades to a literal-key assignment. `request-ingress-transform-refs.test.ts`
 * pins both halves of that. The nearest legal positions are therefore the
 * subtrees that *contain* a ref (`messages[].content`, which is
 * legal in both `anthropic-messages` and `openai-completions`) and a scalar
 * beside them (`max_tokens`). Rows 8–12, 15, 16–17 and 18 exercise both: renaming
 * or deleting the ref's own container must relocate/remove the ref with it, and
 * an op on an unrelated scalar must not disturb it at all.
 *
 * `tests/unit/request-ingress-transform-refs.test.ts` pins the other half:
 * that the loader really does refuse the payload-level paths, and that the same
 * `request_ingress` op runs on a body that is already refs.
 *
 * ## Why the egress shape is declared per row, not computed
 *
 * Two rules are live in the handlers, and which one applies is a property of the
 * call site, not of the row. *Rule A* — `streamRefs` is computed on the body
 * *before* the hook runs and then drives a ternary whose true arm calls
 * `createRefAwareJsonBody` unconditionally, so a hook that strips every ref still
 * yields a stream (of the now blob-free skeleton) and `streamed: true`. It is the
 * send at `claude.ts:50 → :154`, the native `chat-completions.ts:68 → :464`, both
 * converted rungs of `messages.ts` (`:233 → :656`, `:233 → :781`) and the
 * `/v1/responses` passthrough (`responses.ts:1871 → :1889`). *Rule B* —
 * `postJsonWithSpool` is handed whatever value the code reached and re-detects
 * refs on it (`spool-json.ts:63`), falling back to `createJsonEgressBody` /
 * `createTextEgressBody` and the plain-string path (`streamed: false`) when it
 * finds none. It is the five converting sends (`chat-completions.ts:108`, `:254`,
 * `:335`; `messages.ts:379`, `:468`) and `responses.ts:693`, `:951`, `:1654`,
 * `:1701`, `:1775`, `:1822`. Under Rule A the egress shape is decided by the
 * *incoming* body; under Rule B by the *outgoing* one. Both are correct for their
 * call site; the matrix records which is which so a row cannot silently migrate.
 *
 * One cell of that 2×2 — **Rule B with a transform that itself drops every ref**,
 * where the re-detection finds nothing and the send degrades to `streamed: false`
 * — is measured for exactly one call site: the already-OpenAI Messages send
 * (`messages.ts:468`) under a `request_ingress` op that replaces the ref's
 * container, in `request-ingress-transform-refs.test.ts` block 3. The converting
 * Rule-B sends (`chat-completions.ts:108`/`:254`/`:335`, `responses.ts:951`) are
 * still unmeasured in that cell: each needs its own response fixture, and rows
 * 16–18 all carry their refs, so they cannot distinguish the two rules. Recorded
 * as a gap rather than implied to be covered.
 *
 * Coverage: all ten `BUILTIN_NAMES` and all five op kinds, across the three
 * hooks that can run on a ref-bearing body (`before_upstream` on the Anthropic,
 * Chat and already-OpenAI Messages rungs, `before_conversion` on the converted
 * Messages and Responses rungs).
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleClaudeRequest } from '../../src/handlers/claude.js';
import { handleChatCompletionsPassthrough } from '../../src/handlers/chat-completions.js';
import { handleMessagesRequest } from '../../src/handlers/messages.js';
import { handleResponsesRequest } from '../../src/handlers/responses.js';
import { BLOB_REF_MARKER, extractInlineBlobs, releaseExtractedBlobs } from '../../src/utils/blob-refs.js';
import { resetBlobStore } from '../../src/utils/blob-store.js';
import { validateTransformSet, type ModelRouteConfig, type TransformSet } from '../../src/utils/config-loader.js';
import { createLogger } from '../../src/utils/logger.js';
import { resolveSpoolConfig, setSpoolConfig } from '../../src/utils/spool.js';

const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});
const CLIENT_URL = 'http://proxy';
const AUTH = { Authorization: 'Bearer upstream-key' };
/** The `filter_anthropic_beta` row's input: kept, dropped-by-null, and unmapped. */
const BETA_AUTH = () => ({ ...AUTH, 'anthropic-beta': 'keep-me, drop-me, unknown' });
const TARGET = 'https://upstream.example/v1/x';

/** A distinct, valid base64 payload: 48 bytes, 64 characters, no padding. */
const P = (seed: string) => Buffer.alloc(48, seed.charCodeAt(0)).toString('base64');
const LC_IMAGE = P('1');
const TOOLRES_IMAGE = P('2');
const THINK_IMAGE = P('3');
const TRAIL_IMAGE = P('4');
const SYSTEM_IMAGE = P('5');
const BETA_IMAGE = P('6');
const ALIAS_IMAGE = P('7');
const RENAME_IMAGE = P('8');
const SET_IMAGE = P('9');
const REMOVE_IMAGE = P('A');
const DEFAULT_IMAGE = P('B');
const MAPVAL_IMAGE = P('C');
const CHAT_TOOL_IMAGE = P('D');
const SSE_IMAGE = P('E');
const CHAT_RENAME_IMAGE = P('F');
const MAXTOK_IMAGE = P('G');
const SETCONTENT_IMAGE = P('H');
const RESP_PROGRAM_IMAGE = P('I');
const OPENAI_URL_IMAGE = P('J');
const ALL_PAYLOADS = [
  LC_IMAGE, TOOLRES_IMAGE, THINK_IMAGE, TRAIL_IMAGE, SYSTEM_IMAGE, BETA_IMAGE, ALIAS_IMAGE,
  RENAME_IMAGE, SET_IMAGE, REMOVE_IMAGE, DEFAULT_IMAGE, MAPVAL_IMAGE, CHAT_TOOL_IMAGE,
  SSE_IMAGE, CHAT_RENAME_IMAGE, MAXTOK_IMAGE, SETCONTENT_IMAGE, RESP_PROGRAM_IMAGE,
  OPENAI_URL_IMAGE,
];
assert.equal(
  new Set(ALL_PAYLOADS).size,
  ALL_PAYLOADS.length,
  'every row payload must be distinguishable from the others, or a payload-fate assertion could pass on the wrong row',
);

const scratchDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) {
    try {
      chmodSync(dir, 0o700);
    } catch { /* already writable or already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * One upstream send, as the fetch mock saw it. `streamed` is recorded separately
 * from `text` because the shape is half the claim: a stream and a string that
 * drain to the same bytes are still two different sends.
 */
interface UpstreamCall {
  url: string;
  streamed: boolean;
  text: string;
  bytes: number;
  headers: Record<string, string>;
  duplex: string | undefined;
}

let upstreamCalls: UpstreamCall[] = [];
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const sent = init?.body;
    const text = typeof sent === 'string'
      ? sent
      : sent instanceof ReadableStream
        ? await new Response(sent).text()
        : String(sent ?? '');
    upstreamCalls.push({
      url: String(input),
      streamed: typeof sent !== 'string',
      text,
      bytes: Buffer.byteLength(text),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      duplex: (init as { duplex?: string } | undefined)?.duplex,
    });
    // Shaped for the anthropic-messages branch, which parses the body on the way
    // back in, and for the completions branches, which read it as an OpenAI
    // completion; each front door in this file only reads the fields it needs.
    return new Response(
      JSON.stringify({
        id: 'upstream-ok',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-test',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop', logprobs: null }],
        content: [],
        usage: { input_tokens: 1, output_tokens: 1, prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

/** A fresh, enabled spool directory — the extraction path's precondition (§9.1). */
function enableSpool(): void {
  const dir = mkdtempSync(join(tmpdir(), 'transform-ref-matrix-'));
  scratchDirs.push(dir);
  setSpoolConfig(resolveSpoolConfig({ enabled: true, dir }));
  resetBlobStore();
}

// ---------------------------------------------------------------------------
// Fixtures — one per row, each carrying exactly one §5.4 payload
// ---------------------------------------------------------------------------

const LC_BODY = () => ({
  model: 'claude-test',
  max_tokens: 16,
  tools: [{
    name: 'get_weather',
    description: 'weather',
    input_schema: { type: 'OBJECT', properties: { city: { type: 'STRING' } }, required: ['city'] },
  }],
  messages: [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: LC_IMAGE } },
      { type: 'text', text: 'describe' },
    ],
  }],
});

const TOOLRES_BODY = () => ({
  model: 'claude-test',
  max_tokens: 16,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TOOLRES_IMAGE } },
        { type: 'text', text: 'describe' },
      ],
    },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} }] },
  ],
});

const THINK_BODY = () => ({
  model: 'claude-test',
  max_tokens: 16,
  thinking: { type: 'enabled', budget_tokens: 1024 },
  messages: [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: THINK_IMAGE } },
      { type: 'text', text: 'describe' },
    ],
  }],
});

const TRAIL_BODY = () => ({
  model: 'claude-test',
  max_tokens: 16,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: TRAIL_IMAGE } },
        { type: 'text', text: 'describe' },
      ],
    },
    { role: 'assistant', content: [{ type: 'text', text: 'sure' }] },
  ],
});

/**
 * `cache_control_injection_points` is declared *before* `tools` on purpose: the
 * builtin's last act is to move that key after `tools`, so a fixture that
 * already had it last would let a broken reorder pass.
 */
const SYSTEM_BODY = () => ({
  model: 'claude-test',
  max_tokens: 16,
  system: [{ type: 'text', text: 'sys', cache_control: { type: 'ephemeral', ttl: '1h' } }],
  cache_control_injection_points: [{ location: 'message', control: { type: 'ephemeral' } }],
  tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
  messages: [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: SYSTEM_IMAGE } },
      { type: 'text', text: 'describe' },
    ],
  }],
});

/** The ref-bearing body the body-neutral rows share: only the payload differs. */
const REF_ONLY_BODY = (payload: string) => () => ({
  model: 'claude-test',
  max_tokens: 16,
  messages: [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: payload } },
      { type: 'text', text: 'describe' },
    ],
  }],
});

/**
 * The Messages door's *other* rung: a body the client already spelled as OpenAI,
 * so `messages.ts` forwards it without converting. There is deliberately no
 * `type: 'text'` part — a Claude content block of any known type would flip
 * `isOpenAIFormat` and divert the request to the conversion path instead.
 */
const MSGS_OPENAI_BODY = (payload: string) => () => ({
  model: 'gpt-test',
  max_tokens: 16,
  messages: [{
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${payload}` } }],
  }],
});

const CHAT_TOOL_BODY = () => ({
  model: 'gpt-test',
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'weather?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${CHAT_TOOL_IMAGE}` } },
      ],
    },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: 'sunny' },
  ],
});

const CHAT_SSE_BODY = () => ({
  model: 'gpt-test',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${SSE_IMAGE}` } },
    ],
  }],
});

const CHAT_RENAME_BODY = () => ({
  model: 'gpt-test',
  messages: [{
    role: 'user',
    content: [
      { type: 'text', text: 'describe' },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${CHAT_RENAME_IMAGE}` } },
    ],
  }],
});

/**
 * Programmatic tool calling, as the Responses API spells it, beside an ordinary
 * image. The `node` tool is declared because the builtin declines to project
 * without it (it will not invent a capability the upstream was never given).
 */
const RESPONSES_PROGRAM_BODY = () => ({
  model: 'gpt-test',
  tools: [{ type: 'function', name: 'node', parameters: {} }],
  input: [
    {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'describe' },
        { type: 'input_image', image_url: `data:image/png;base64,${RESP_PROGRAM_IMAGE}` },
      ],
    },
    { type: 'program', id: 'p1', call_id: 'c1', code: 'return 1+1', fingerprint: 'fp-abc' },
    { type: 'program_output', id: 'o1', call_id: 'c1', result: '2', status: 'completed' },
  ],
});

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** Reads a send's drained body as JSON — every row in this file emits JSON. */
function json(call: UpstreamCall): any {
  return JSON.parse(call.text);
}

interface Row {
  name: string;
  clientPath: string;
  /** The upstream mode `route.upstreamMode` reports; also the row's schema family. */
  upstreamMode: string;
  body: () => Record<string, unknown>;
  /** The single set this row declares. Its schema must be the row's mode family. */
  set: TransformSet;
  /** Payloads this fixture must spill, i.e. the §5.4 positions it holds. */
  refs: number;
  /** Payloads the transform must still put upstream, and the send must stream. */
  carried: string[];
  /** Payloads the transform drops in both runs — the transform's, not the spool's. */
  dropped: string[];
  /** The measured egress shape after the hook ran (see the header note). */
  streamedAfterTransform: boolean;
  /** `true` when the transform changes the upstream body bytes vs. no transforms at all. */
  acts: boolean;
  /** The untransformed baseline is expected to be *refused* rather than sent. */
  baselineRefuses?: boolean;
  effect?: (call: UpstreamCall) => void;
  /** Asserted on the untransformed baseline, to prove the transform is what changed it. */
  baselineEffect?: (call: UpstreamCall) => void;
  call: (request: Request, route: ModelRouteConfig) => Promise<Response>;
}

/** Shorthand: a one-set route for this row. */
const setOf = (name: string, schema: TransformSet['schema'], slot: keyof TransformSet, decl: object, extra?: Partial<TransformSet>): TransformSet =>
  ({ name, schema, [slot]: decl, ...extra }) as TransformSet;

const ROWS: Row[] = [
  // -- Anthropic door: `before_upstream` ----------------------------------
  {
    name: 'before_upstream: lowercase_tool_schema_types',
    clientPath: '/v1/messages', upstreamMode: 'anthropic-messages',
    body: LC_BODY, refs: 1, carried: [LC_IMAGE], dropped: [],
    streamedAfterTransform: true, acts: true,
    set: setOf('lc', 'anthropic-messages', 'before_upstream', { builtins: ['lowercase_tool_schema_types'] }),
    effect: (call) => {
      const schema = json(call).tools[0].input_schema;
      assert.equal(schema.type, 'object', 'the builtin must lowercase the schema root type');
      assert.equal(schema.properties.city.type, 'string', 'and the nested property types');
      assert.deepEqual(schema.required, ['city'], 'without touching unrelated schema keys');
    },
    call: (r, route) => handleClaudeRequest(r, TARGET, AUTH, 't1', 'claude-test', ENV, LOGGER, route),
  },
  {
    name: 'before_upstream: inject_missing_tool_results',
    clientPath: '/v1/messages', upstreamMode: 'anthropic-messages',
    body: TOOLRES_BODY, refs: 1, carried: [TOOLRES_IMAGE], dropped: [],
    streamedAfterTransform: true, acts: true,
    set: setOf('toolres', 'anthropic-messages', 'before_upstream', { builtins: ['inject_missing_tool_results'] }),
    effect: (call) => {
      const msgs = json(call).messages;
      assert.equal(msgs.length, 3, 'the missing tool_result must be synthesized as its own user message');
      assert.deepEqual(msgs[2], {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '' }],
      });
    },
    call: (r, route) => handleClaudeRequest(r, TARGET, AUTH, 't2', 'claude-test', ENV, LOGGER, route),
  },
  {
    name: 'before_upstream: strip_fresh_thinking',
    clientPath: '/v1/messages', upstreamMode: 'anthropic-messages',
    body: THINK_BODY, refs: 1, carried: [THINK_IMAGE], dropped: [],
    streamedAfterTransform: true, acts: true,
    set: setOf('stripthink', 'anthropic-messages', 'before_upstream', { builtins: ['strip_fresh_thinking'] }),
    effect: (call) => {
      assert.ok(!('thinking' in json(call)), 'a thinking-enabled request with no prior thinking block must lose the flag');
    },
    call: (r, route) => handleClaudeRequest(r, TARGET, AUTH, 't3', 'claude-test', ENV, LOGGER, route),
  },
  {
    name: 'before_upstream: ensure_trailing_user_message',
    clientPath: '/v1/messages', upstreamMode: 'anthropic-messages',
    body: TRAIL_BODY, refs: 1, carried: [TRAIL_IMAGE], dropped: [],
    streamedAfterTransform: true, acts: true,
    set: setOf('trailuser', 'anthropic-messages', 'before_upstream', { builtins: ['ensure_trailing_user_message'] }),
    effect: (call) => {
      const msgs = json(call).messages;
      assert.equal(msgs.length, 1, 'the trailing assistant prefill must be popped');
      assert.equal(msgs[0].role, 'user');
    },
    call: (r, route) => handleClaudeRequest(r, TARGET, AUTH, 't4', 'claude-test', ENV, LOGGER, route),
  },
  {
    name: 'before_upstream: ensure_tool_config_cache_ttl',
    clientPath: '/v1/messages', upstreamMode: 'anthropic-messages',
    body: SYSTEM_BODY, refs: 1, carried: [SYSTEM_IMAGE], dropped: [],
    streamedAfterTransform: true, acts: true,
    set: setOf('cachettl', 'anthropic-messages', 'before_upstream', { builtins: ['ensure_tool_config_cache_ttl'] }),
    effect: (call) => {
      const body = json(call);
      assert.deepEqual(body.cache_control_injection_points, [
        { location: 'message', control: { type: 'ephemeral' } },
        { location: 'tool_config', control: { type: 'ephemeral', ttl: '1h' } },
      ], 'the derived tool_config entry must be appended after the caller-provided one');
      const keys = Object.keys(body);
      assert.ok(
        keys.indexOf('cache_control_injection_points') > keys.indexOf('tools'),
        'field order must be enforced: cache_control_injection_points after tools',
      );
    },
    call: (r, route) => handleClaudeRequest(r, TARGET, AUTH, 't5', 'claude-test', ENV, LOGGER, route),
  },
  {
    name: 'before_upstream: filter_anthropic_beta (header-only, ref-neutral)',
    clientPath: '/v1/messages', upstreamMode: 'anthropic-messages',
    body: REF_ONLY_BODY(BETA_IMAGE), refs: 1, carried: [BETA_IMAGE], dropped: [],
    streamedAfterTransform: true, acts: false,
    set: setOf('betafilter', 'anthropic-messages', 'before_upstream', { builtins: ['filter_anthropic_beta'] },
      { anthropic_beta_map: { 'keep-me': 'x-mapped-beta', 'drop-me': null } }),
    effect: (call) => {
      assert.equal(
        call.headers['anthropic-beta'], 'x-mapped-beta',
        'the map must rename the kept entry and drop the null entry and the unmapped entry',
      );
    },
    // The transform is the only thing that can have filtered the header: with no
    // transforms at all, the client's own value goes up untouched.
    baselineEffect: (call) => {
      assert.equal(call.headers['anthropic-beta'], 'keep-me, drop-me, unknown');
    },
    // `BETA_AUTH` is a factory, not a constant: `filter_anthropic_beta` is handed
    // the caller's own header object and rewrites `anthropic-beta` in place, so a
    // single shared object would carry run A's result into run B and leave the
    // baseline with no header at all.
    call: (r, route) => handleClaudeRequest(r, TARGET, BETA_AUTH(), 't6', 'claude-test', ENV, LOGGER, route),
  },
  {
    name: 'before_upstream: restore_client_model_alias (inert at this hook)',
    clientPath: '/v1/messages', upstreamMode: 'anthropic-messages',
    body: REF_ONLY_BODY(ALIAS_IMAGE), refs: 1, carried: [ALIAS_IMAGE], dropped: [],
    streamedAfterTransform: true, acts: false,
    set: setOf('aliasrestore', 'anthropic-messages', 'before_upstream', { builtins: ['restore_client_model_alias'] }),
    // `clientModel` is derived from the same request body this hook rewrites, so
    // at `before_upstream` the builtin can only write back the value already
    // there. `acts: false` is the assertion; there is no separate effect to check.
    call: (r, route) => handleClaudeRequest(r, TARGET, AUTH, 't7', 'claude-test', ENV, LOGGER, route),
  },
  {
    name: 'before_upstream: op rename messages[].content → parts (ref relocates)',
    clientPath: '/v1/messages', upstreamMode: 'anthropic-messages',
    body: REF_ONLY_BODY(RENAME_IMAGE), refs: 1, carried: [RENAME_IMAGE], dropped: [],
    streamedAfterTransform: true, acts: true,
    set: setOf('renamemsg', 'anthropic-messages', 'before_upstream',
      { ops: [{ op: 'rename', path: 'messages[].content', to: 'parts' }] }),
    effect: (call) => {
      const msg = json(call).messages[0];
      assert.ok('parts' in msg && !('content' in msg), 'the rename must move the key, not copy it');
      assert.ok(Array.isArray(msg.parts), 'the ref\'s own subtree must move with the key');
    },
    call: (r, route) => handleClaudeRequest(r, TARGET, AUTH, 't8', 'claude-test', ENV, LOGGER, route),
  },
  {
    name: 'before_upstream: op set messages[].content (payload dropped, skeleton still streamed)',
    clientPath: '/v1/messages', upstreamMode: 'anthropic-messages',
    body: REF_ONLY_BODY(SET_IMAGE), refs: 1, carried: [], dropped: [SET_IMAGE],
    streamedAfterTransform: true, acts: true,
    set: setOf('setmsg', 'anthropic-messages', 'before_upstream',
      { ops: [{ op: 'set', path: 'messages[].content', value: 'rewritten' }] }),
    effect: (call) => assert.equal(json(call).messages[0].content, 'rewritten'),
    call: (r, route) => handleClaudeRequest(r, TARGET, AUTH, 't9', 'claude-test', ENV, LOGGER, route),
  },
  {
    name: 'before_upstream: op remove messages[].content (payload dropped, skeleton still streamed)',
    clientPath: '/v1/messages', upstreamMode: 'anthropic-messages',
    body: REF_ONLY_BODY(REMOVE_IMAGE), refs: 1, carried: [], dropped: [REMOVE_IMAGE],
    streamedAfterTransform: true, acts: true,
    set: setOf('removemsg', 'anthropic-messages', 'before_upstream',
      { ops: [{ op: 'remove', path: 'messages[].content' }] }),
    effect: (call) => assert.ok(!('content' in json(call).messages[0])),
    call: (r, route) => handleClaudeRequest(r, TARGET, AUTH, 't10', 'claude-test', ENV, LOGGER, route),
  },
  {
    name: 'before_upstream: op default messages[].content (cannot clobber a present ref)',
    clientPath: '/v1/messages', upstreamMode: 'anthropic-messages',
    body: REF_ONLY_BODY(DEFAULT_IMAGE), refs: 1, carried: [DEFAULT_IMAGE], dropped: [],
    streamedAfterTransform: true, acts: false,
    set: setOf('defaultmsg', 'anthropic-messages', 'before_upstream',
      { ops: [{ op: 'default', path: 'messages[].content', value: [{ type: 'text', text: 'defaulted' }] }] }),
    // `default` only writes when the key is absent, so a ref position can never be
    // replaced by it — that is what `acts: false` pins.
    call: (r, route) => handleClaudeRequest(r, TARGET, AUTH, 't11', 'claude-test', ENV, LOGGER, route),
  },
  {
    name: 'before_upstream: op map_value max_tokens (scalar beside the ref tree)',
    clientPath: '/v1/messages', upstreamMode: 'anthropic-messages',
    body: REF_ONLY_BODY(MAPVAL_IMAGE), refs: 1, carried: [MAPVAL_IMAGE], dropped: [],
    streamedAfterTransform: true, acts: true,
    set: setOf('mapmaxtok', 'anthropic-messages', 'before_upstream',
      { ops: [{ op: 'map_value', path: 'max_tokens', from: 16, to: 4096 }] }),
    effect: (call) => assert.equal(json(call).max_tokens, 4096),
    baselineEffect: (call) => assert.equal(json(call).max_tokens, 16),
    call: (r, route) => handleClaudeRequest(r, TARGET, AUTH, 't12', 'claude-test', ENV, LOGGER, route),
  },

  // -- Chat door: `before_upstream` ---------------------------------------
  {
    name: 'before_upstream: recover_tool_message_name',
    clientPath: '/v1/chat/completions', upstreamMode: 'openai-completions',
    body: CHAT_TOOL_BODY, refs: 1, carried: [CHAT_TOOL_IMAGE], dropped: [],
    streamedAfterTransform: true, acts: true,
    set: setOf('recovername', 'openai-completions', 'before_upstream', { builtins: ['recover_tool_message_name'] }),
    effect: (call) => {
      const msgs = json(call).messages;
      assert.equal(msgs[2].name, 'get_weather', 'the tool message must inherit the name from the assistant turn\'s tool_calls');
      assert.ok(!('name' in msgs[1]), 'and the assistant turn must not be given one');
    },
    call: (r, route) => handleChatCompletionsPassthrough(r, TARGET, AUTH, 't13', LOGGER, ENV, 'gpt-test', 'openai-completions', route),
  },
  {
    name: 'before_upstream: assemble_sse_chunks (request-side slot, inert)',
    clientPath: '/v1/chat/completions', upstreamMode: 'openai-completions',
    body: CHAT_SSE_BODY, refs: 1, carried: [SSE_IMAGE], dropped: [],
    streamedAfterTransform: true, acts: false,
    // The builtin operates on a Response stream and is handled in
    // `applyAfterUpstream`; `applyBuiltin` returns immediately for it outside
    // that path. Declaring it at a request hook is the case this row pins: the
    // request-side slot must not consume the ref on its way past.
    set: setOf('ssechunks', 'openai-completions', 'before_upstream', { builtins: ['assemble_sse_chunks'] }),
    call: (r, route) => handleChatCompletionsPassthrough(r, TARGET, AUTH, 't14', LOGGER, ENV, 'gpt-test', 'openai-completions', route),
  },
  {
    name: 'before_upstream: op rename messages[].content → parts (ref relocates)',
    clientPath: '/v1/chat/completions', upstreamMode: 'openai-completions',
    body: CHAT_RENAME_BODY, refs: 1, carried: [CHAT_RENAME_IMAGE], dropped: [],
    streamedAfterTransform: true, acts: true,
    set: setOf('renamechat', 'openai-completions', 'before_upstream',
      { ops: [{ op: 'rename', path: 'messages[].content', to: 'parts' }] }),
    effect: (call) => {
      const msg = json(call).messages[0];
      assert.ok('parts' in msg && !('content' in msg), 'the rename must move the key, not copy it');
    },
    call: (r, route) => handleChatCompletionsPassthrough(r, TARGET, AUTH, 't15', LOGGER, ENV, 'gpt-test', 'openai-completions', route),
  },

  // -- Messages door: `before_conversion` (converted egress) ---------------
  {
    name: 'before_conversion: op map_value max_tokens (payload carried through the converter)',
    clientPath: '/v1/messages', upstreamMode: 'openai-completions',
    body: REF_ONLY_BODY(MAXTOK_IMAGE), refs: 1, carried: [MAXTOK_IMAGE], dropped: [],
    streamedAfterTransform: true, acts: true,
    set: setOf('mapmaxtokconv', 'anthropic-messages', 'before_conversion',
      { ops: [{ op: 'map_value', path: 'max_tokens', from: 16, to: 4096 }] }),
    effect: (call) => assert.equal(json(call).max_tokens, 4096),
    baselineEffect: (call) => assert.equal(json(call).max_tokens, 16),
    call: (r, route) => handleMessagesRequest(r, TARGET, AUTH, 't16', 'gpt-test', ENV, LOGGER, undefined, 'openai-completions', route),
  },
  {
    name: 'before_conversion: op set messages[role=user].content (payload dropped, skeleton still streamed)',
    clientPath: '/v1/messages', upstreamMode: 'openai-completions',
    body: REF_ONLY_BODY(SETCONTENT_IMAGE), refs: 1, carried: [], dropped: [SETCONTENT_IMAGE],
    // `messages.ts:233` decides the egress shape from the *pre-hook* client body,
    // and `messages.ts:781` then calls `createRefAwareJsonBody` unconditionally on
    // the converted body. Once the op has replaced `messages[].content`, that body
    // holds no ref at all: the stream carries a 87-byte ref-free skeleton whose
    // bytes equal the string egress exactly, but the send is still `duplex: 'half'`
    // with a measured `Content-Length`. Measured, not assumed — see the header note.
    streamedAfterTransform: true, acts: true,
    set: setOf('setusercontent', 'anthropic-messages', 'before_conversion',
      { ops: [{ op: 'set', path: 'messages[role=user].content', value: 'rewritten' }] }),
    effect: (call) => {
      const user = json(call).messages.find((m: any) => m.role === 'user');
      assert.equal(user.content, 'rewritten', 'the converter must see the value the op wrote, not the ref it replaced');
    },
    call: (r, route) => handleMessagesRequest(r, TARGET, AUTH, 't17', 'gpt-test', ENV, LOGGER, undefined, 'openai-completions', route),
  },
  // -- Messages door: `before_upstream` (already-OpenAI rung, streams) -----
  {
    // This rung converts nothing and holds back nothing: the ref stays in the field
    // the client spelled it in, the op below moves only its *container* (by path,
    // so the ref rides along), and the send is Rule B — it re-detects refs on the
    // outgoing body and streams the payload at its own offset. The converted rung
    // above is Rule A: its `streamRefs` was fixed on the pre-hook body, so it
    // streams a skeleton even when the op has emptied it. Same door, same schema,
    // different call site — pair the two rows when reading either.
    name: 'before_upstream: op rename messages[].content → parts (already-OpenAI rung streams the ref the op carried)',
    clientPath: '/v1/messages', upstreamMode: 'openai-completions',
    body: MSGS_OPENAI_BODY(OPENAI_URL_IMAGE), refs: 1, carried: [OPENAI_URL_IMAGE], dropped: [],
    streamedAfterTransform: true, acts: true,
    set: setOf('renameopenai', 'openai-completions', 'before_upstream',
      { ops: [{ op: 'rename', path: 'messages[].content', to: 'parts' }] }),
    effect: (call) => {
      const msg = json(call).messages[0];
      assert.ok('parts' in msg && !('content' in msg), 'the rename must move the key, not copy it');
      assert.equal(
        (msg.parts as any[])[0].image_url.url,
        `data:image/png;base64,${OPENAI_URL_IMAGE}`,
        'the op moved the ref\'s container, so the ref survived the hook and the send streamed the payload back in',
      );
    },
    call: (r, route) => handleMessagesRequest(r, TARGET, AUTH, 't19', 'gpt-test', ENV, LOGGER, undefined, 'openai-completions', route),
  },

  // -- Responses door: `before_conversion` (refusal baseline) -------------
  {
    name: 'before_conversion: project_program_to_node_tool (baseline refuses)',
    clientPath: '/v1/responses', upstreamMode: 'openai-completions',
    body: RESPONSES_PROGRAM_BODY, refs: 1, carried: [RESP_PROGRAM_IMAGE], dropped: [],
    streamedAfterTransform: true, acts: true, baselineRefuses: true,
    set: setOf('programnode', 'openai-responses', 'before_conversion', { builtins: ['project_program_to_node_tool'] }),
    effect: (call) => {
      const body = json(call);
      const calls = (body.messages as any[]).flatMap(m => m.tool_calls ?? []);
      assert.equal(calls.length, 1, 'the program item must be projected onto one function call');
      assert.equal(calls[0].function.name, 'node');
      assert.deepEqual(JSON.parse(calls[0].function.arguments), {
        code: 'return 1+1', fingerprint: 'fp-abc', type: 'program',
      }, 'the projection\'s payload must survive the conversion intact');
      const outputs = (body.messages as any[]).filter(m => m.role === 'tool');
      assert.equal(outputs.length, 1, 'and the program_output item onto one tool result');
      assert.equal(outputs[0].tool_call_id, 'c1', 'paired with the call it belongs to');
    },
    call: (r, route) => handleResponsesRequest(r, TARGET, AUTH, 't18', 'gpt-test', ENV, LOGGER, 'openai-completions', route),
  },
];

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeRoute(row: Row, transforms: TransformSet[]): ModelRouteConfig {
  return { targetUrl: TARGET, upstreamMode: row.upstreamMode, transforms };
}

/** The request a handler receives: a ref is plain JSON, so it survives this trip. */
function handlerRequest(row: Row, body: Record<string, unknown>, expectRefs: boolean): Request {
  const text = JSON.stringify(body);
  assert.equal(
    text.includes(BLOB_REF_MARKER),
    expectRefs,
    'the request under test must carry exactly the refs the fixture spilled',
  );
  return new Request(`${CLIENT_URL}${row.clientPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: text,
  });
}

/** Send `body` through the row's handler; return the response and any upstream send. */
async function rawSend(
  row: Row,
  body: Record<string, unknown>,
  expectRefs: boolean,
  route: ModelRouteConfig,
): Promise<{ response: Response; call: UpstreamCall | undefined }> {
  upstreamCalls = [];
  const response = await row.call(handlerRequest(row, body, expectRefs), route);
  await response.text();
  return { response, call: upstreamCalls[0] };
}

/** Send `body` and assert the one upstream call it must have made. */
async function send(
  row: Row,
  body: Record<string, unknown>,
  expectRefs: boolean,
  route: ModelRouteConfig,
): Promise<UpstreamCall> {
  const { response, call } = await rawSend(row, body, expectRefs, route);
  assert.equal(response.status, 200, `${row.name}: the handler must return the upstream response`);
  assert.equal(upstreamCalls.length, 1, `${row.name}: the handler must have made exactly one upstream call`);
  assert.ok(call, `${row.name}: the upstream call must have been recorded`);
  assert.equal(call.url, TARGET, `${row.name}: the request must go to the routed target`);
  return call;
}

/** Run one row: refs + transform, transform without spool, and no transform at all. */
async function check(row: Row): Promise<void> {
  // Every set in this file must be one the loader accepts — otherwise the row
  // would be pinning the behaviour of a configuration no deployment can write.
  const setErrors = validateTransformSet(row.set.name, row.set);
  assert.deepEqual(
    setErrors, [],
    `${row.name}: the row's transform set must be load-legal, not just engine-legal`,
  );

  const route = makeRoute(row, [row.set]);
  const bareRoute = makeRoute(row, []);

  // A: the ref run — a live spool, the real extraction pass, the real hook.
  enableSpool();
  const body = row.body();
  const extraction = await extractInlineBlobs(body);
  assert.equal(extraction.refs, row.refs, `${row.name}: the fixture must spill exactly its §5.4 positions`);
  assert.equal(extraction.skipped, 0, `${row.name}: no fixture payload may be shape-3 ineligible`);
  let transformed: UpstreamCall;
  try {
    transformed = await send(row, body, true, route);
  } finally {
    // The send has drained the ref body, so the request is over and its leases go
    // back now — the baselines below reset the store, and §5.4's reset drops the
    // index, which would make a lease still held unreleasable.
    releaseExtractedBlobs(extraction);
  }

  for (const payload of row.carried) {
    assert.ok(
      transformed.text.includes(payload),
      `${row.name}: the transform left this payload in place, so it must reach the upstream at its own position`,
    );
  }
  for (const payload of row.dropped) {
    assert.ok(
      !transformed.text.includes(payload),
      `${row.name}: this payload must be gone from the ref run — the transform removed its container`,
    );
  }
  assert.ok(!transformed.text.includes(BLOB_REF_MARKER), `${row.name}: no ref may reach the upstream`);
  assert.equal(
    transformed.streamed, row.streamedAfterTransform,
    `${row.name}: the egress shape after the hook must be the measured one`,
  );
  if (transformed.streamed) {
    assert.equal(
      transformed.headers['content-length'], String(transformed.bytes),
      `${row.name}: the declared length must be the exact byte count`,
    );
    assert.equal(transformed.duplex, 'half', `${row.name}: a streamed send needs duplex: half`);
  } else {
    assert.equal(transformed.headers['content-length'], undefined, `${row.name}: an expanded send declares no length`);
    assert.equal(transformed.duplex, undefined, `${row.name}: an expanded send needs no duplex`);
  }
  row.effect?.(transformed);

  // B: the same transform with spooling off, so nothing spills and the converter
  // or hook sees the client's own bytes. §10's "streamed upstream bytes equal the
  // in-memory conversion baseline".
  setSpoolConfig(resolveSpoolConfig({ enabled: false }));
  resetBlobStore();
  const expanded = await send(row, row.body(), false, route);
  assert.equal(expanded.streamed, false, `${row.name}: the no-spool control must be the expanded string, not a stream`);
  assert.equal(
    transformed.text, expanded.text,
    `${row.name}: the ref-bearing send must be byte-identical to the same send with the payloads inline`,
  );

  // C: no transforms at all. `acts` says whether the hook changed the upstream
  // body; for the refusal row there is no baseline send to compare against, only
  // the converter's own refusal.
  if (row.baselineRefuses) {
    upstreamCalls = [];
    await assert.rejects(
      () => row.call(handlerRequest(row, row.body(), false), bareRoute),
      (err: unknown) => {
        assert.ok(err instanceof Error, `${row.name}: the baseline must fail with an Error`);
        assert.equal(err.name, 'ValidationError', `${row.name}: the baseline refusal must be a ValidationError`);
        assert.match(err.message, /Item type 'program'/, `${row.name}: and it must name the item type it refused`);
        return true;
      },
      `${row.name}: without the projection the converter must refuse the program item`,
    );
    assert.equal(upstreamCalls.length, 0, `${row.name}: a refused request must not reach the upstream`);
    return;
  }

  const bare = await send(row, row.body(), false, bareRoute);
  assert.equal(
    transformed.text !== bare.text, row.acts,
    row.acts
      ? `${row.name}: the transform is declared to change the body, but the bytes match the untransformed baseline`
      : `${row.name}: the transform is declared inert, but it changed the upstream bytes`,
  );
  row.baselineEffect?.(bare);
  // The payloads a transform dropped must be present in the untransformed
  // baseline: that is what makes the loss provably the transform's, not the
  // spool's — and it is the check that would catch a "drop" that is really a
  // ref that never expanded.
  for (const payload of row.dropped) {
    assert.ok(
      bare.text.includes(payload),
      `${row.name}: the untransformed baseline must carry the payload the transform drops, or the drop cannot be attributed to the transform`,
    );
  }
  // The payloads a transform *carried* must also be in the baseline: their
  // presence upstream must not depend on the transform having run.
  for (const payload of row.carried) {
    assert.ok(
      bare.text.includes(payload),
      `${row.name}: the untransformed baseline must carry this payload too — the transform cannot be what put it there`,
    );
  }
}

describe('§5.4 transform contracts against ref-bearing bodies', () => {
  for (const row of ROWS) {
    it(row.name, async () => {
      await check(row);
    });
  }

  it('covers every named builtin, so a new one cannot be added untested', async () => {
    // The list is repeated rather than imported from config-loader on purpose:
    // importing `BUILTIN_NAMES` would make this assertion vacuous (it would pass
    // for a name that was added to both places but never exercised here).
    const declared = [
      'lowercase_tool_schema_types', 'recover_tool_message_name', 'inject_missing_tool_results',
      'strip_fresh_thinking', 'filter_anthropic_beta', 'ensure_tool_config_cache_ttl',
      'ensure_trailing_user_message', 'assemble_sse_chunks', 'restore_client_model_alias',
      'project_program_to_node_tool',
    ];
    const covered = new Set(
      ROWS.flatMap(r => [
        ...(r.set.before_upstream?.builtins ?? []),
        ...(r.set.before_conversion?.builtins ?? []),
        ...(r.set.request_ingress?.builtins ?? []),
      ]),
    );
    for (const name of declared) {
      assert.ok(covered.has(name as never), `builtin "${name}" has no row in this matrix`);
    }
    // And every op kind is exercised at least once.
    const ops = new Set(
      ROWS.flatMap(r => [
        ...(r.set.before_upstream?.ops ?? []),
        ...(r.set.before_conversion?.ops ?? []),
        ...(r.set.request_ingress?.ops ?? []),
      ]).map(op => op.op),
    );
    for (const kind of ['rename', 'set', 'default', 'remove', 'map_value']) {
      assert.ok(ops.has(kind as never), `op kind "${kind}" has no row in this matrix`);
    }
  });
});
