/**
 * Unit tests for the §5.7 non-SSE response path in
 * `src/handlers/chat-completions.ts`.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.7, §5.9.
 *
 * `/v1/chat/completions` (and its `/v1/completions` alias) answers from three
 * upstream modes without streaming, and all three read the body unbounded
 * before the spool work: the two converted branches — an `anthropic-messages`
 * upstream, converted Claude JSON → Completions JSON, and a
 * `gemini-generatecontent` upstream, converted Gemini → Claude → Completions —
 * called `response.text()` and parsed it, and the `openai-responses` branch
 * piped the upstream body straight through with an `observeStream` transform but
 * no bound at all. The converted pair now goes through the same
 * `receiveJsonResponse` as `/v1/messages`; the `openai-responses` branch
 * receives into a spool and converts what it received (Responses `output[]` →
 * Completions `choices[]`), so it is bounded by the same cap while no longer
 * relaying upstream bytes.
 *
 * What these tests pin, and why each assertion is worth its space:
 *  - the converted body every client receives is unchanged, both under the
 *    threshold and above it (the spool must not change an answer);
 *  - a body over `threshold_bytes` really did live on disk while it was being
 *    received — captured mid-receive, because the converted path releases the
 *    spill before it returns, so the end state alone cannot tell the two paths
 *    apart;
 *  - a body past `max_response_bytes` fails explicitly and cancels the upstream
 *    body rather than handing a truncated body to `JSON.parse` or to the client;
 *  - the cap applies with `[spool] enabled = false` too. This is the
 *    repository's stated rule (CHANGELOG: `max_response_bytes` bounds the body;
 *    `enabled` only decides whether disk is used) and it is applied here the
 *    same way it is applied on the identity egresses. It is asserted rather than
 *    assumed so that a future change of that rule fails here loudly;
 *  - `Response.prototype.clone()` is never called: the whole point of the
 *    bounded receive is that no second copy of the body exists;
 *  - §5.9 admission is charged the received byte count on the converted paths,
 *    the `openai-responses` one included; a refusal releases the spill and holds
 *    no reservation;
 *  - the gemini branch still drops a response's `inline_data` part. That drop is
 *    pre-existing (`convertGeminiGenerateContentToClaude` keeps only text
 *    parts) and it is why this egress extracts no payloads: there is no
 *    converted position to extract from. Pinned here so the limitation cannot
 *    regress into a claim that images survive this path.
 *
 * The last section covers the same two branches' `!response.ok` reads (`:128`,
 * `:368`), which read the upstream's error body with `response.text()` and
 * returned it to the client. Both now use `withResponseText` on the identity
 * consumer, so the relayed bytes are unchanged while a cap breach or a §5.9
 * refusal propagates out of the handler instead of reaching the client as the
 * upstream's answer.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleChatCompletionsPassthrough } from '../../src/handlers/chat-completions.js';
import { SpoolResponseTooLargeError } from '../../src/utils/spool-response.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { SPOOL_DEFAULTS, responseSpillDir, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';
import { AdmissionOverBudgetError, getAdmittedBytes } from '../../src/utils/spool-admission.js';
import { createLogger, type Logger } from '../../src/utils/logger.js';

const realFetch = globalThis.fetch;
const ANTHROPIC_URL = 'https://upstream.example/v1/messages';
const RESPONSES_URL = 'https://upstream.example/v1/responses';
const GEMINI_URL = 'https://upstream.example/v1beta/models/gemini-test:generateContent';
const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});

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
  const dir = mkdtempSync(join(tmpdir(), 'chat-completions-response-test-'));
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

/** A native Gemini body, the answer a `gemini-generatecontent` upstream sends. */
function geminiBody(parts: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 },
  };
}

/** An upstream Responses body, for the `openai-responses` upstream mode. */
function responsesBody(filler = 'ok'): Record<string, unknown> {
  return {
    id: 'resp-test',
    object: 'response',
    created_at: 1700000000,
    model: 'gpt-test',
    status: 'completed',
    output: [{
      type: 'message',
      id: 'msg-test',
      role: 'assistant',
      content: [{ type: 'output_text', text: filler, annotations: [] }],
    }],
    usage: { input_tokens: 3, output_tokens: 1, total_tokens: 4 },
  };
}

/** An OpenAI-format client body, non-streaming: the handler converts it per mode. */
function clientRequest(): Request {
  return new Request('http://proxy/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] }),
  });
}

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
 * A converted body with its clock-derived fields masked.
 *
 * The Completions envelope carries `created` (a timestamp, in both branches) and
 * the gemini branch mints its id from the clock too, so two identical runs differ
 * there. Everything else must match exactly — that is the property under test.
 */
function stableBody(text: string): Record<string, unknown> {
  const parsed = JSON.parse(text) as Record<string, unknown>;
  return { ...parsed, id: undefined, created: undefined };
}

/** The upstream URL each mode under test is addressed at. */
function targetUrlFor(upstreamMode: string): string {
  if (upstreamMode === 'anthropic-messages') return ANTHROPIC_URL;
  if (upstreamMode === 'openai-responses') return RESPONSES_URL;
  return GEMINI_URL;
}

async function post(upstreamMode: string, logger: Logger = LOGGER): Promise<Response> {
  return await handleChatCompletionsPassthrough(
    clientRequest(),
    targetUrlFor(upstreamMode),
    { Authorization: 'Bearer upstream-key' },
    'req-chat-response',
    logger,
    ENV,
    'gpt-test',
    upstreamMode,
  );
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

// ---------------------------------------------------------------------------
// §5.7: bounded receive, spill, cap
// ---------------------------------------------------------------------------

describe('chat-completions.ts non-SSE response (§5.7)', () => {
  it('converts an anthropic-messages body under threshold_bytes without touching the spool', async () => {
    const config = configureSpool({ thresholdBytes: 4096 });
    const payload = claudeBody();
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength < config.thresholdBytes);
    stubUpstream(() => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));

    const { result: response, clones } = await countClones(() => post('anthropic-messages'));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'req-chat-response');
    const completions = await response.json() as Record<string, any>;
    // The Completions shape the client gets, unchanged by the way the body was
    // received. `created` is a wall-clock stamp, so it is checked as a type.
    assert.equal(typeof completions.created, 'number');
    assert.deepEqual({ ...completions, created: undefined }, {
      id: 'msg-test',
      object: 'chat.completion',
      created: undefined,
      model: 'gpt-test',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
    });
    assert.deepEqual(spillFiles(config), [], 'a body under the threshold leaves no spill');
    assert.equal(clones, 0, 'the proxy must not hold a second copy of the body');
  });

  it('spills an anthropic-messages body above threshold_bytes, converts identically, and frees the spill before answering', async () => {
    const payload = claudeBody('x'.repeat(400));
    const chunks = twoChunks(JSON.stringify(payload));

    // The reference is the same request with spooling off: the two runs differ in
    // nothing but the spool, so equal answers mean the spool changed nothing.
    configureSpool({ enabled: false });
    stubUpstream(() => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));
    const baseline = await (await post('anthropic-messages')).text();
    // Captured after the baseline run, because every `configureSpool` call makes a
    // fresh directory: this is the config whose `responses/` the spill lands in.
    const config = configureSpool();
    assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the first chunk must cross the threshold');

    const seen: Array<{ files: number; bytes: number }> = [];
    const src = source(chunks, (index) => {
      seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
      if (index > 2) throw new Error(`receive asked for too many chunks: ${index}`);
    });
    stubUpstream(() => new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }));

    const { result: response, clones } = await countClones(() => post('anthropic-messages'));

    // The spill is the live body while it is received: by the time the proxy
    // asks for the second chunk, the first is on disk and charged.
    assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'the received prefix must be on disk, charged');
    // And it is gone before the handler answers: this path parses once and sends
    // the converted body, so holding the spool past that point would be a leak.
    assert.deepEqual(spillFiles(config), [], 'the spill must be released before the response is returned');
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(await response.text(), baseline, 'the spool must not change the converted body');
    assert.equal(clones, 0);
  });

  it('fails loudly past max_response_bytes on the anthropic-messages egress, and cancels the upstream body', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const payload = claudeBody('z'.repeat(400));
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

    let caught: unknown;
    try {
      await post('anthropic-messages');
    } catch (error) {
      caught = error;
    }

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

  it('converts a gemini-generatecontent body identically above threshold_bytes, still dropping its inline_data part', async () => {
    configureSpool();
    const payload = geminiBody([
      { text: 'a picture: ' },
      { inlineData: { mimeType: 'image/png', data: 'A'.repeat(400) } },
    ]);
    const chunks = twoChunks(JSON.stringify(payload));

    configureSpool({ enabled: false });
    stubUpstream(() => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));
    const baseline = await (await post('gemini-generatecontent')).text();
    const config = configureSpool();

    const src = source(chunks);
    stubUpstream(() => new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }));

    const { result: response, clones } = await countClones(() => post('gemini-generatecontent'));

    assert.deepEqual(stableBody(await response.text()), stableBody(baseline), 'the spool must not change the converted body');
    assert.equal(clones, 0);
    assert.deepEqual(spillFiles(config), [], 'the spill must be released before the response is returned');

    // Pinned, not endorsed: the converter keeps only text parts, so the model's
    // image never reaches this client. That is why this egress extracts nothing —
    // there is no converted position holding the payload to extract.
    const completions = JSON.parse(baseline) as Record<string, any>;
    assert.equal(completions.choices[0].message.content, 'a picture: ');
    assert.ok(!baseline.includes('AAAAAAAAAA'), 'the upstream image bytes must not leak into the converted body');
  });

  it('fails loudly past max_response_bytes on the gemini-generatecontent egress', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const payload = geminiBody([{ text: 'g'.repeat(400) }]);
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength > config.maxResponseBytes);
    const src = source(twoChunks(JSON.stringify(payload)));
    stubUpstream(() => new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await post('gemini-generatecontent');
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.status, 500);
    assert.equal(caught.type, 'processing_error');
    assert.equal(src.cancelled, true, 'the upstream body must be cancelled, not left flowing');
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('enforces max_response_bytes on the converted egress with the spool disabled, as the other egresses do', async () => {
    const config = configureSpool({ enabled: false, maxResponseBytes: 256 });
    const payload = claudeBody('c'.repeat(400));
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength > config.maxResponseBytes);
    stubUpstream(() => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await post('anthropic-messages');
    } catch (error) {
      caught = error;
    }

    // Deliberate: this receive replaced the whole-body read outright, so the cap
    // bounds that read and is not part of the spilling feature. Serving the body
    // would mean holding it twice in RAM — the cost the cap exists to refuse.
    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.status, 500);
    assert.equal(caught.type, 'processing_error');
    assert.deepEqual(spillFiles(config), [], 'nothing may reach disk when spilling is off');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('converts an openai-responses body out of its spool, and frees the spill once the answer is built', async () => {
    const config = configureSpool();
    const payload = JSON.stringify(responsesBody('q'.repeat(400)));
    const chunks = twoChunks(payload);
    assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the fixture must spill, so the spool is really in the path');

    const seen: Array<{ files: number; bytes: number }> = [];
    const src = source(chunks, (index) => {
      seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
      if (index > 2) throw new Error(`receive asked for too many chunks: ${index}`);
    });
    stubUpstream(() => new Response(src.stream, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const { result: response, clones } = await countClones(() => post('openai-responses'));

    assert.equal(response.status, 200, 'the converted answer replaces the upstream status');
    assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'the received prefix must be on disk, charged');
    // Converted, not relayed: the client gets a `chat.completion` carrying the
    // upstream's answer, not the Responses object the upstream sent. The body
    // above `threshold_bytes` proves the conversion read the spill, not a buffer.
    const answer = JSON.parse(await response.text());
    assert.equal(answer.object, 'chat.completion');
    assert.equal(answer.choices[0].message.content, 'q'.repeat(400));
    assert.equal(answer.choices[0].finish_reason, 'stop');
    assert.deepEqual(answer.usage, { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 });
    // The converted read releases the spill itself, before the answer is serialized.
    assert.deepEqual(spillFiles(config), [], 'the spill must be released once the body has been read');
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(clones, 0);
  });

  it('bounds the openai-responses conversion at max_response_bytes with spooling off', async () => {
    const config = configureSpool({ enabled: false, maxResponseBytes: 256 });
    const payload = JSON.stringify(responsesBody('r'.repeat(400)));
    assert.ok(new TextEncoder().encode(payload).byteLength > config.maxResponseBytes);
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await post('openai-responses');
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.status, 500);
    assert.equal(caught.type, 'processing_error');
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });
});

// ---------------------------------------------------------------------------
// §5.9: byte admission around the converted read
// ---------------------------------------------------------------------------

describe('chat-completions.ts openai-responses conversion, admission (§5.9)', () => {
  const TRACE = createLogger({ LOG_LEVEL: 'trace' });

  it('refuses the converted read one nominal byte past the budget, leaving no spill and no reservation', async () => {
    const payload = JSON.stringify(responsesBody('b'.repeat(400)));
    const bodyBytes = new TextEncoder().encode(payload).byteLength;
    const config = configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2) - 1 });
    assert.ok(bodyBytes > config.thresholdBytes, 'the fixture must spill, so a leak here would be visible on disk');
    const { calls } = stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await post('openai-responses', TRACE);
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof AdmissionOverBudgetError, `expected AdmissionOverBudgetError, got ${String(caught)}`);
    assert.equal(caught.status, 503);
    assert.equal(caught.type, 'over_limit_error', 'the type the client switches on');
    assert.match(caught.message, /exceed max_materialized_body_bytes/);
    assert.equal(calls(), 1, 'the charge is the received byte count, so the body was received first');
    assert.deepEqual(spillFiles(config), [], 'a refused body must not leave its bytes on disk');
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(getAdmittedBytes(), 0, 'a refusal must not keep its queue slot');
  });

  it('admits the converted read that fits and answers with the converted body', async () => {
    const payload = JSON.stringify(responsesBody('f'.repeat(400)));
    const bodyBytes = new TextEncoder().encode(payload).byteLength;
    configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2) });
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    const response = await post('openai-responses', TRACE);

    const converted = JSON.parse(await response.text());
    assert.equal(converted.object, 'chat.completion');
    assert.equal(converted.choices[0].message.content, 'f'.repeat(400));
    assert.equal(getAdmittedBytes(), 0, 'the lease is given back once the body is materialized');
  });
});

// ---------------------------------------------------------------------------
// §5.7: the upstream *error* body
// ---------------------------------------------------------------------------

/**
 * The two converted branches' `!response.ok` reads (`:128` for an
 * `anthropic-messages` upstream, `:368` for `gemini-generatecontent`) called
 * `response.text()` and *returned* the text to the client, so an error answer was
 * the one body on this egress that no `max_response_bytes`, no spill and no §5.9
 * charge applied to. Both now go through `withResponseText` on the identity
 * consumer: the relayed bytes are unchanged, while a cap breach, a spill failure
 * or a §5.9 refusal propagates out of the handler instead of being handed to the
 * client as the upstream's own error. The handler has no enclosing try/catch, so
 * that propagation leaves it unmodified — the same path every other error on this
 * egress takes.
 */

const ERROR_SITES = [
  { name: 'anthropic-messages', mode: 'anthropic-messages' },
  { name: 'gemini-generatecontent', mode: 'gemini-generatecontent' },
];

function errorPayload(marker: string): string {
  return JSON.stringify({ error: { type: 'rate_limit_error', message: `upstream said ${marker}` } }, null, 2);
}

function errorResponse(body: ReadableStream<Uint8Array> | string): Response {
  return new Response(body, { status: 429, headers: { 'Content-Type': 'application/json' } });
}

/** Run `run`, require that it failed, and hand back the error. */
async function thrownBy(run: () => Promise<unknown>): Promise<Error> {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error, `expected an Error, got ${String(caught)}`);
  return caught;
}

for (const site of ERROR_SITES) {
  describe(`chat-completions.ts ${site.name} upstream error body (§5.7)`, () => {
    it('relays the error body through the spill, byte for byte', async () => {
      const payload = errorPayload('x'.repeat(400));

      // Baseline: spooling off, which is the `response.text()` behaviour this
      // replaces — the same request must still answer the same way.
      setSpoolConfig(SPOOL_DEFAULTS);
      stubUpstream(() => errorResponse(payload));
      const baseline = await post(site.mode);
      const baselineText = await baseline.text();
      assert.equal(baseline.status, 429);
      assert.equal(baselineText, payload);

      const chunks = twoChunks(payload);

      // Captured after the baseline run, because every `configureSpool` call makes
      // a fresh directory: this is the config whose `responses/` the spill lands in.
      const config = configureSpool();
      assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the first chunk must cross the threshold');

      const seen: Array<{ files: number; bytes: number }> = [];
      const src = source(chunks, (index) => {
        seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
        if (index > 2) throw new Error(`receive asked for too many chunks: ${index}`);
      });
      const { calls } = stubUpstream(() => errorResponse(src.stream));

      const { result: response, clones } = await countClones(() => post(site.mode));
      const text = await response.text();

      // The spill is the live body while it is received — and this path releases it
      // before it answers, so the end state alone could not tell it apart.
      assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'the received prefix must be on disk, charged');
      assert.equal(response.status, baseline.status, 'the upstream status is still the client’s');
      assert.equal(response.headers.get('x-request-id'), 'req-chat-response');
      assert.equal(text, baselineText, 'the relayed error body must be byte-identical');
      assert.equal(calls(), 1);
      assert.deepEqual(spillFiles(config), [], 'the spill must be released before the response is returned');
      assert.equal(getLiveSpillBytes(), 0);
      assert.equal(clones, 0, 'no `response.clone()` for an error body either');
    });

    it('fails loudly past max_response_bytes and cancels the upstream body', async () => {
      const config = configureSpool({ maxResponseBytes: 256 });
      // 160-byte slices: the first crosses `threshold_bytes` (64) but not the cap,
      // so a spill file really exists when the second slice breaches it.
      const chunks = slices(errorPayload('y'.repeat(400)), 160);
      assert.ok(chunks[0].byteLength > config.thresholdBytes && chunks[0].byteLength <= config.maxResponseBytes);
      assert.ok(chunks[0].byteLength + chunks[1].byteLength > config.maxResponseBytes);
      const seen: Array<{ files: number; bytes: number }> = [];
      const src = source(chunks, (index) => {
        seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
      });
      const { calls } = stubUpstream(() => errorResponse(src.stream));

      const caught = await thrownBy(() => post(site.mode));

      assert.deepEqual(seen[1], { files: 1, bytes: chunks[0].byteLength }, 'a spill must have been live when the cap was breached');
      // A `response.text()` here would have answered the client the upstream's 429;
      // the proxy's own limit must surface as itself (rule #8).
      assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
      assert.equal(caught.status, 500, 'the client sent a legal request: not a 4xx');
      assert.equal(caught.type, 'processing_error');
      assert.match(caught.message, /too large/);
      assert.equal(calls(), 1);
      assert.equal(src.cancelled, true, 'the upstream body must be cancelled, not left flowing');
      assert.deepEqual(spillFiles(config), [], 'a rejected response removes its partial spill');
      assert.equal(getLiveSpillBytes(), 0);
    });

    it('surfaces a §5.9 refusal instead of the upstream error, and holds no lease', async () => {
      const payload = errorPayload('z'.repeat(400));
      const bodyBytes = new TextEncoder().encode(payload).byteLength;
      const config = configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2) - 1 });
      assert.ok(bodyBytes > config.thresholdBytes, 'the body must spill, so a refusal has bytes to clean up');
      stubUpstream(() => errorResponse(payload));

      const caught = await thrownBy(() => post(site.mode));

      assert.ok(caught instanceof AdmissionOverBudgetError, `expected AdmissionOverBudgetError, got ${String(caught)}`);
      assert.equal(caught.status, 503);
      assert.equal(caught.type, 'over_limit_error', 'the type the client switches on');
      assert.match(caught.message, /exceed max_materialized_body_bytes/);
      assert.deepEqual(spillFiles(config), [], 'a refused error body must not leave its bytes on disk');
      assert.equal(getLiveSpillBytes(), 0, 'nor hold them against max_total_bytes');
      assert.equal(getAdmittedBytes(), 0);
    });
  });
}
