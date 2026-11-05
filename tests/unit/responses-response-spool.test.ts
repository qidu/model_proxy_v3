/**
 * Unit tests for the four §5.7 converted non-SSE response reads in
 * `src/handlers/responses.ts`.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.7, §5.9.
 *
 * Every openai-completions or anthropic-messages upstream answered a Responses
 * client with a body read whole by `response.text()` and then parsed, so nothing
 * bounded what the upstream could send. The four readers are:
 *  - `handleAsAnthropicMessages` — `POST /v1/responses` answered from a Claude
 *    upstream;
 *  - `handleAsCompletions` — `POST /v1/responses` answered from a Completions
 *    upstream;
 *  - `handleResponsesInputTokensRequest`'s completions branch —
 *    `POST /v1/responses/input_tokens`;
 *  - `handleResponsesCompactRequest`'s completions branch —
 *    `POST /v1/responses/compact`.
 * All four now go through the same `receiveJsonResponse` as `/v1/messages`,
 * `/v1/chat/completions` and `openai.ts`'s cross-mode egresses: one bounded
 * receive, one parse, spill and §5.9 lease released before the client is
 * answered.
 *
 * The four differ in what the client receives, so each is pinned on its own
 * converted shape; the properties under test are the same for all four, so the
 * assertions below are written once against a site table.
 *
 * What these tests pin, and why each assertion is worth its space:
 *  - the converted body each client receives is unchanged, both under the
 *    threshold and above it (the spool must not change an answer);
 *  - a body over `threshold_bytes` really did live on disk while it was being
 *    received — captured mid-receive, because this path releases the spill
 *    before it returns, so the end state alone cannot tell the two paths apart;
 *  - a body past `max_response_bytes` fails explicitly and cancels the upstream
 *    body rather than handing a truncated body to `JSON.parse`;
 *  - the cap applies with `[spool] enabled = false` too. This is the
 *    repository's stated rule (CHANGELOG: `max_response_bytes` bounds the body;
 *    `enabled` only decides whether disk is used), applied here as on the other
 *    egresses. It is asserted rather than assumed so that a future change of
 *    that rule fails here loudly;
 *  - a malformed upstream body surfaces as the parse failure it is, with the
 *    spill released — a bounded receive must not turn a broken upstream into a
 *    hang or a silent empty answer;
 *  - `Response.prototype.clone()` is never called: the whole point of the
 *    bounded receive is that no second copy of the body exists;
 *  - §5.9 admission is charged the received byte count; a refusal releases the
 *    spill, holds no reservation, and never answers with a partial body.
 *
 * Deliberately out of scope, and left as they are: the four upstream *error*
 * reads beside these sites (`!response.ok` → `response.text()`) and the
 * in-process `claudeResponse.json()` in `handleAsGemini` (an already bounded
 * body). Each is a separate increment. The two identity forwards on the
 * passthrough halves of `/input_tokens` and `/compact` used to be listed here;
 * they are bounded now and pinned in `responses-response-egress.test.ts`.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  handleResponsesRequest,
  handleResponsesInputTokensRequest,
  handleResponsesCompactRequest,
} from '../../src/handlers/responses.js';
import { SpoolResponseTooLargeError } from '../../src/utils/spool-response.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { SPOOL_DEFAULTS, responseSpillDir, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';
import { AdmissionOverBudgetError, getAdmittedBytes } from '../../src/utils/spool-admission.js';
import { createLogger } from '../../src/utils/logger.js';

const realFetch = globalThis.fetch;
const REQUEST_ID = 'req-responses-response';
const AUTH = { 'x-api-key': 'upstream-key', Authorization: 'Bearer upstream-key' };
const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});

/** Every converted Responses body shares this usage block. */
function usage(): Record<string, unknown> {
  return {
    input_tokens: 3,
    output_tokens: 1,
    total_tokens: 4,
    input_tokens_details: { cached_tokens: 0 },
  };
}

/** The single assistant message both converted envelopes carry. */
function message(text: string): Record<string, unknown> {
  return {
    id: undefined,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
  setSpoolConfig(SPOOL_DEFAULTS);
  // Both ledgers are process-wide: a leak here would silently weaken later tests.
  assert.equal(getLiveSpillBytes(), 0, 'every spool must return its reservation');
  assert.equal(getAdmittedBytes(), 0, 'every §5.9 lease must be released');
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) {
    try {
      chmodSync(dir, 0o700);
    } catch { /* already writable or already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Spool enabled with a small threshold, so a few hundred bytes spill. */
function configureSpool(overrides: Partial<SpoolConfig> = {}): SpoolConfig {
  const dir = mkdtempSync(join(tmpdir(), 'responses-response-test-'));
  scratchDirs.push(dir);
  const config: SpoolConfig = {
    ...SPOOL_DEFAULTS,
    enabled: true,
    dir,
    thresholdBytes: 64,
    maxResponseBytes: 1 << 20,
    maxTotalBytes: 1 << 22,
    ...overrides,
  };
  setSpoolConfig(config);
  return config;
}

/** Names of the response spill files currently on disk. */
function spillFiles(config: SpoolConfig): string[] {
  return existsSync(responseSpillDir(config)) ? readdirSync(responseSpillDir(config)) : [];
}

/** A `POST /v1/responses` client request. */
function responsesClient(): Request {
  return new Request('http://proxy/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-test', input: 'hello' }),
  });
}

/** A `POST /v1/responses/input_tokens` client request. */
function inputTokensClient(): Request {
  return new Request('http://proxy/v1/responses/input_tokens', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-test', input: 'hello' }),
  });
}

/** A `POST /v1/responses/compact` client request. */
function compactClient(): Request {
  return new Request('http://proxy/v1/responses/compact', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-test', input: 'hello' }),
  });
}

/** A Claude-format upstream body, the answer an `anthropic-messages` upstream sends. */
function claudeBody(filler = 'ok'): Record<string, unknown> {
  return {
    id: 'msg-test',
    type: 'message',
    role: 'assistant',
    model: 'gpt-test',
    content: [{ type: 'text', text: filler }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 1 },
  };
}

/** An upstream Completions body, the answer an `openai-completions` upstream sends. */
function completionsBody(filler = 'ok'): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-test',
    choices: [{ index: 0, message: { role: 'assistant', content: filler }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  };
}

/**
 * A Claude-shaped answer mints `id`, `created_at` and the message id from the
 * clock and the CSPRNG, so those three are masked; every other value is asserted.
 */
function stableFromClaude(text: string): Record<string, unknown> {
  const body = JSON.parse(text) as Record<string, any>;
  body.id = undefined;
  body.created_at = undefined;
  for (const item of body.output ?? []) item.id = undefined;
  return body;
}

/**
 * A Completions-shaped answer echoes the upstream's own `id` and `created`, so
 * only the synthesized message id is masked.
 */
function stableFromCompletions(text: string): Record<string, unknown> {
  const body = JSON.parse(text) as Record<string, any>;
  for (const item of body.output ?? []) {
    if (item.id !== undefined) item.id = undefined;
  }
  return body;
}

/** The answer with no clock-minted fields at all: it is compared verbatim. */
function stableAsIs(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

/** One converted non-SSE reader: how to call it, and what it must answer. */
interface Site {
  name: string;
  /** The client request this reader answers. */
  client: () => Request;
  /** The upstream URL the response comes from. */
  target: string;
  /** Invoke the reader with `client()` against the stubbed upstream. */
  invoke: (request: Request) => Promise<Response>;
  /** An upstream body carrying `filler` as the assistant's text. */
  payload: (filler: string) => Record<string, unknown>;
  /** The answer for `filler`, clock-minted fields already masked to `undefined`. */
  expected: (filler: string) => Record<string, unknown>;
  /** The assistant text in the answer, or `undefined` when it echoes none. */
  textOf: (body: Record<string, any>) => string | undefined;
  /** The answer with its clock-minted fields masked, for before/after comparison. */
  stable: (text: string) => Record<string, unknown>;
}

const RESPONSES_TARGET = 'https://upstream.example/v1/responses';
const COMPLETIONS_TARGET = 'https://upstream.example/v1/chat/completions';

const SITES: Site[] = [
  {
    name: 'responses <- anthropic-messages',
    client: responsesClient,
    target: RESPONSES_TARGET,
    invoke: (request) => handleResponsesRequest(
      request, RESPONSES_TARGET, AUTH, REQUEST_ID, 'gpt-test', undefined, LOGGER, 'anthropic-messages',
    ),
    payload: claudeBody,
    expected: (filler) => ({
      id: undefined,
      object: 'response',
      created_at: undefined,
      status: 'completed',
      model: 'gpt-test',
      output: [message(filler)],
      usage: usage(),
    }),
    textOf: (body) => body.output[0].content[0].text,
    stable: stableFromClaude,
  },
  {
    name: 'responses <- openai-completions',
    client: responsesClient,
    target: COMPLETIONS_TARGET,
    invoke: (request) => handleResponsesRequest(
      request, COMPLETIONS_TARGET, AUTH, REQUEST_ID, 'gpt-test', undefined, LOGGER, 'openai-completions',
    ),
    payload: completionsBody,
    expected: (filler) => ({
      id: 'resp_chatcmpl-test',
      object: 'response',
      created_at: 1700000000,
      status: 'completed',
      model: 'gpt-test',
      output_text: filler,
      output: [message(filler)],
      usage: usage(),
    }),
    textOf: (body) => body.output[0].content[0].text,
    stable: stableFromCompletions,
  },
  {
    name: 'responses/input_tokens <- openai-completions',
    client: inputTokensClient,
    target: COMPLETIONS_TARGET,
    invoke: (request) => handleResponsesInputTokensRequest(
      request, COMPLETIONS_TARGET, AUTH, REQUEST_ID, 'gpt-test', undefined, LOGGER, 'openai-completions',
    ),
    payload: completionsBody,
    // The only reader whose answer carries no text: the count is read from
    // `usage.prompt_tokens` and the received body is not echoed at all.
    expected: () => ({ object: 'response.input_tokens', input_tokens: 3 }),
    textOf: () => undefined,
    stable: stableAsIs,
  },
  {
    name: 'responses/compact <- openai-completions',
    client: compactClient,
    target: COMPLETIONS_TARGET,
    invoke: (request) => handleResponsesCompactRequest(
      request, COMPLETIONS_TARGET, AUTH, REQUEST_ID, 'gpt-test', undefined, LOGGER, 'openai-completions',
    ),
    payload: completionsBody,
    expected: (filler) => ({
      id: 'resp_chatcmpl-test',
      object: 'response.compaction',
      created_at: 1700000000,
      output: [message(filler)],
      usage: usage(),
    }),
    textOf: (body) => body.output[0].content[0].text,
    stable: stableFromCompletions,
  },
];

interface Sourced {
  stream: ReadableStream<Uint8Array>;
  cancelled: boolean;
}

/**
 * An upstream body we can watch being cancelled, and whose receive we can
 * inspect chunk by chunk. `onPull(i)` runs when the proxy asks for chunk `i`,
 * i.e. after chunks `0…i-1` have been read and written to the spill.
 */
function source(chunks: Uint8Array[], onPull?: (index: number) => void): Sourced {
  let index = 0;
  const state: Sourced = { cancelled: false, stream: null as unknown as ReadableStream<Uint8Array> };
  state.stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        onPull?.(index);
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index++]);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return state;
}

/**
 * Stub global fetch, counting calls and answering with `respond()`.
 *
 * The request body is drained first, as a real fetch does: draining is what
 * releases the §5.3 request egress spill, and a stub that ignored the body would
 * leave that reservation held and make the ledger assertions below measure the
 * stub instead of the proxy.
 */
function stubUpstream(respond: () => Response): { calls: () => number } {
  let calls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls += 1;
    const body = init?.body;
    if (body instanceof ReadableStream) {
      const reader = body.getReader();
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
    return respond();
  }) as typeof fetch;
  return { calls: () => calls };
}

/** Split an encoded body in two, so a spill cannot be the declared-length path. */
function twoChunks(payload: string): Uint8Array[] {
  const bytes = new TextEncoder().encode(payload);
  const half = Math.floor(bytes.byteLength / 2);
  return [bytes.subarray(0, half), bytes.subarray(half)];
}

/**
 * Fixed-size slices of an encoded body. A body that first crosses
 * `threshold_bytes` (so a spill really is created) and only then breaches
 * `max_response_bytes` needs more than two chunks to arrange.
 */
function slices(payload: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(payload);
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    out.push(bytes.subarray(offset, offset + size));
  }
  return out;
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

async function post(site: Site): Promise<Response> {
  return await site.invoke(site.client());
}

/** Run `run` and return whatever it threw, so an assertion can name the error. */
async function caughtFrom(run: () => Promise<unknown>): Promise<any> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// §5.7: bounded receive, spill, cap
// ---------------------------------------------------------------------------

for (const site of SITES) {
  describe(`responses.ts ${site.name} non-SSE response (§5.7)`, () => {
    it('converts a body under threshold_bytes without touching the spool or cloning it', async () => {
      const config = configureSpool({ thresholdBytes: 4096 });
      const payload = site.payload();
      assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength < config.thresholdBytes);
      stubUpstream(() => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));

      const { result: response, clones } = await countClones(() => post(site));

      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-request-id'), REQUEST_ID);
      assert.deepEqual(site.stable(await response.text()), site.expected('ok'));
      assert.deepEqual(spillFiles(config), [], 'a body under the threshold leaves no spill');
      assert.equal(clones, 0, 'the proxy must not hold a second copy of the body');
    });

    it('spills a body above threshold_bytes, converts identically, and frees the spill before answering', async () => {
      const filler = 'x'.repeat(400);
      const payload = site.payload(filler);
      const chunks = twoChunks(JSON.stringify(payload));

      // The reference is the same request with spooling off: the two runs differ
      // in nothing but the spool, so equal answers mean the spool changed nothing.
      configureSpool({ enabled: false });
      stubUpstream(() => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));
      const baseline = await (await post(site)).text();
      assert.deepEqual(site.stable(baseline), site.expected(filler));
      // For the three readers that echo the upstream text, the large text must
      // have survived the conversion, or the comparison above would hold for a
      // body that was quietly dropped.
      assert.equal(site.textOf(JSON.parse(baseline)), site.textOf(site.expected(filler)));

      // Captured after the baseline run, because every `configureSpool` call makes
      // a fresh directory: this is the config whose `responses/` the spill lands in.
      const config = configureSpool();
      assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the first chunk must cross the threshold');

      const seen: Array<{ files: number; bytes: number }> = [];
      const src = source(chunks, (index) => {
        seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
        if (index > 2) throw new Error(`receive asked for too many chunks: ${index}`);
      });
      stubUpstream(() => new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }));

      const { result: response, clones } = await countClones(() => post(site));

      // The spill is the live body while it is received: by the time the proxy
      // asks for the second chunk, the first is on disk and charged.
      assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'the received prefix must be on disk, charged');
      // And it is gone before the handler answers: this path parses once and
      // sends the converted body, so holding the spool past that point would leak.
      assert.deepEqual(spillFiles(config), [], 'the spill must be released before the response is returned');
      assert.equal(getLiveSpillBytes(), 0);
      assert.deepEqual(site.stable(await response.text()), site.stable(baseline), 'the spool must not change the converted body');
      assert.equal(clones, 0);
    });

    it('fails loudly past max_response_bytes and cancels the upstream body', async () => {
      const config = configureSpool({ maxResponseBytes: 256 });
      const payload = site.payload('z'.repeat(400));
      // 160-byte slices: the first crosses `threshold_bytes` (64) but not the cap,
      // so a spill file really exists when the second slice breaches it — the
      // state the failure path has to clean up.
      const chunks = slices(JSON.stringify(payload), 160);
      assert.ok(chunks[0].byteLength > config.thresholdBytes && chunks[0].byteLength <= config.maxResponseBytes);
      assert.ok(chunks[0].byteLength + chunks[1].byteLength > config.maxResponseBytes);
      const seen: Array<{ files: number; bytes: number }> = [];
      const src = source(chunks, (index) => {
        seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
      });
      const { calls } = stubUpstream(() => new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }));

      const caught = await caughtFrom(() => post(site));

      assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'a spill must have been live when the cap was breached');
      assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
      assert.equal(caught.status, 500, 'the client sent a legal request: not a 4xx');
      assert.equal(caught.type, 'processing_error');
      assert.match(caught.message, /too large/);
      assert.equal(calls(), 1);
      assert.equal(src.cancelled, true, 'the upstream body must be cancelled, not left flowing');
      assert.deepEqual(spillFiles(config), [], 'a rejected response removes its partial spill');
      assert.equal(getLiveSpillBytes(), 0);
    });

    it('enforces max_response_bytes with the spool disabled, as the other egresses do', async () => {
      const config = configureSpool({ enabled: false, maxResponseBytes: 256 });
      const payload = site.payload('c'.repeat(400));
      assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength > config.maxResponseBytes);
      stubUpstream(() => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));

      const caught = await caughtFrom(() => post(site));

      // Deliberate: this receive replaced the whole-body read outright, so the cap
      // bounds that read and is not part of the spilling feature. Serving the body
      // would mean holding it twice in RAM — the cost the cap exists to refuse.
      assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
      assert.equal(caught.status, 500);
      assert.equal(caught.type, 'processing_error');
      assert.deepEqual(spillFiles(config), [], 'nothing may reach disk when spilling is off');
      assert.equal(getLiveSpillBytes(), 0);
    });

    it('reports a malformed upstream body as the parse failure it is, holding no spill', async () => {
      const config = configureSpool();
      const payload = '{"id":"broken",' + 'x'.repeat(200);
      assert.ok(new TextEncoder().encode(payload).byteLength > config.thresholdBytes, 'the fixture must spill');
      const src = source(twoChunks(payload));
      stubUpstream(() => new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }));

      const caught = await caughtFrom(() => post(site));

      assert.ok(caught instanceof SyntaxError, `expected SyntaxError, got ${String(caught)}`);
      assert.deepEqual(spillFiles(config), [], 'a failed parse still releases its spill');
      assert.equal(getLiveSpillBytes(), 0);
    });

    it('refuses a body one nominal byte past the §5.9 budget, leaving no spill and no reservation', async () => {
      const payload = JSON.stringify(site.payload('b'.repeat(400)));
      const bodyBytes = new TextEncoder().encode(payload).byteLength;
      const config = configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2) - 1 });
      assert.ok(bodyBytes > config.thresholdBytes, 'the fixture must spill, so a leak here would be visible on disk');
      const { calls } = stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

      const caught = await caughtFrom(() => post(site));

      assert.ok(caught instanceof AdmissionOverBudgetError, `expected AdmissionOverBudgetError, got ${String(caught)}`);
      assert.equal(caught.status, 503);
      assert.equal(caught.type, 'over_limit_error', 'the type the client switches on');
      assert.match(caught.message, /exceed max_materialized_body_bytes/);
      assert.equal(calls(), 1, 'the charge is the received byte count, so the body was received first');
      assert.deepEqual(spillFiles(config), [], 'a refused body must not leave its bytes on disk');
      assert.equal(getLiveSpillBytes(), 0);
      assert.equal(getAdmittedBytes(), 0, 'a refusal must not keep its queue slot');
    });

    it('admits the body that fits and answers with the converted body', async () => {
      const payload = JSON.stringify(site.payload());
      const bodyBytes = new TextEncoder().encode(payload).byteLength;
      configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2) });
      stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

      const response = await post(site);

      assert.equal(response.status, 200);
      assert.deepEqual(site.stable(await response.text()), site.expected('ok'));
      assert.equal(getAdmittedBytes(), 0, 'the lease is given back before the body is sent');
    });
  });
}
