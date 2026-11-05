/**
 * Unit tests for the §5.7 non-SSE response path in `src/handlers/messages.ts`.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.7, §5.9.
 *
 * `/v1/messages` reads an upstream JSON body whole on three egresses — the
 * already-OpenAI client against an `openai-responses` upstream
 * (`handleMessagesRequest`'s passthrough branch), the Claude client against the
 * same upstream (its converted branch), and both clients against an
 * `openai-completions` upstream (`handleNonStreamingResponse`). All three used
 * `response.text()`, so nothing bounded what the upstream sent. They now share
 * `receiveJsonResponse`: received with bounded memory (§5.7's threshold and
 * cap), parsed once, and the spill released before the client is answered.
 *
 * What these tests pin, and why each assertion is worth its space:
 *  - the converted body every client receives is unchanged, both under the
 *    threshold and above it (the spool must not change an answer);
 *  - a body over `threshold_bytes` really did live on disk while it was being
 *    received — captured mid-receive, because this path releases the spill
 *    before it returns, so the end state alone cannot tell the two paths apart;
 *  - a body past `max_response_bytes` fails explicitly and cancels the upstream
 *    body rather than handing a truncated body to `JSON.parse`;
 *  - the cap applies with `[spool] enabled = false` too. This is the
 *    repository's stated rule (CHANGELOG: `max_response_bytes` bounds the body;
 *    `enabled` only decides whether disk is used) and it is applied here the
 *    same way it is applied on the identity egresses. It is asserted rather than
 *    assumed so that a future change of that rule fails here loudly;
 *  - `Response.prototype.clone()` is never called: the whole point of the
 *    bounded receive is that no second copy of the body exists;
 *  - §5.9 admission is charged the received byte count, and a refusal releases
 *    the spill and holds no reservation.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleMessagesRequest } from '../../src/handlers/messages.js';
import { SpoolResponseTooLargeError } from '../../src/utils/spool-response.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { SPOOL_DEFAULTS, responseSpillDir, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';
import { AdmissionOverBudgetError, getAdmittedBytes } from '../../src/utils/spool-admission.js';

const realFetch = globalThis.fetch;
const COMPLETIONS_URL = 'https://upstream.example/v1/chat/completions';
const RESPONSES_URL = 'https://upstream.example/v1/responses';
const ENV = { LOG_LEVEL: 'error' } as any;

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
  const dir = mkdtempSync(join(tmpdir(), 'messages-response-test-'));
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

/** An upstream `chat.completion`, the body a Completions upstream answers with. */
function completionsBody(filler = 'ok'): Record<string, unknown> {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-test',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: filler },
      finish_reason: 'stop',
    }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
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

/** A Claude-format client body: real content blocks, so the handler converts it. */
function claudeClientRequest(): Request {
  return new Request('http://proxy/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-test',
      max_tokens: 64,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    }),
  });
}

/** An already-OpenAI client body: the handler forwards it without converting. */
function openaiClientRequest(): Request {
  return new Request('http://proxy/v1/messages', {
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

async function post(
  request: Request,
  upstreamMode: 'openai-completions' | 'openai-responses',
): Promise<Response> {
  return await handleMessagesRequest(
    request,
    upstreamMode === 'openai-responses' ? RESPONSES_URL : COMPLETIONS_URL,
    { Authorization: 'Bearer upstream-key' },
    'req-messages-response',
    'gpt-test',
    ENV,
    undefined,
    undefined,
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

describe('messages.ts non-SSE response (§5.7)', () => {
  it('converts a response under threshold_bytes without touching the spool', async () => {
    const config = configureSpool({ thresholdBytes: 4096 });
    const payload = completionsBody();
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength < config.thresholdBytes);
    stubUpstream(() => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));

    const { result: response, clones } = await countClones(() => post(openaiClientRequest(), 'openai-completions'));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'req-messages-response');
    // The client-schema answer, unchanged by the way the body was received.
    assert.deepEqual(await response.json(), {
      id: 'chatcmpl-test',
      type: 'message',
      role: 'assistant',
      model: 'gpt-test',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 3, output_tokens: 1 },
    });
    assert.deepEqual(spillFiles(config), [], 'a body under the threshold leaves no spill');
    assert.equal(clones, 0, 'the proxy must not hold a second copy of the body');
  });

  it('spills above threshold_bytes, still converts identically, and frees the spill before answering', async () => {
    const config = configureSpool();
    const payload = completionsBody('x'.repeat(400));
    const chunks = twoChunks(JSON.stringify(payload));
    assert.ok(chunks[0].byteLength > config.thresholdBytes, 'the first chunk must cross the threshold');

    // What the client gets is captured before the receive is instrumented, so
    // the baseline and the spilled run differ in nothing but the spool.
    stubUpstream(() => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));
    const baseline = await (await post(claudeClientRequest(), 'openai-completions')).text();

    const seen: Array<{ files: number; bytes: number }> = [];
    const src = source(chunks, (index) => {
      seen.push({ files: spillFiles(config).length, bytes: getLiveSpillBytes() });
      if (index > 2) throw new Error(`receive asked for too many chunks: ${index}`);
    });
    stubUpstream(() => new Response(src.stream, { headers: { 'Content-Type': 'application/json' } }));

    const { result: response, clones } = await countClones(() => post(claudeClientRequest(), 'openai-completions'));

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

  it('fails loudly past max_response_bytes instead of truncating, and cancels the upstream body', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const payload = completionsBody('z'.repeat(400));
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
      await post(claudeClientRequest(), 'openai-completions');
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

  it('enforces max_response_bytes with the spool disabled, as the other egresses do', async () => {
    const config = configureSpool({ enabled: false, maxResponseBytes: 256 });
    const payload = completionsBody('c'.repeat(400));
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength > config.maxResponseBytes);
    stubUpstream(() => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await post(claudeClientRequest(), 'openai-completions');
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

  it('reports a malformed upstream body as a parse failure, holding no spill', async () => {
    const config = configureSpool();
    const broken = `{"id":"chatcmpl-test",${'x'.repeat(200)}`;
    assert.ok(new TextEncoder().encode(broken).byteLength > config.thresholdBytes);
    stubUpstream(() => new Response(broken, { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await post(claudeClientRequest(), 'openai-completions');
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof SyntaxError, `expected the parse error, got ${String(caught)}`);
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('bounds the openai-responses upstream egress for an OpenAI-format client', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const payload = responsesBody('r'.repeat(400));
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength > config.maxResponseBytes);
    stubUpstream(() => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await post(openaiClientRequest(), 'openai-responses');
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.type, 'processing_error');
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('bounds the openai-responses upstream egress for a Claude-format client', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const payload = responsesBody('r'.repeat(400));
    assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength > config.maxResponseBytes);
    stubUpstream(() => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await post(claudeClientRequest(), 'openai-responses');
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof SpoolResponseTooLargeError, `expected SpoolResponseTooLargeError, got ${String(caught)}`);
    assert.equal(caught.type, 'processing_error');
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });
});

// ---------------------------------------------------------------------------
// §5.9: byte admission around the parse
// ---------------------------------------------------------------------------

describe('messages.ts non-SSE response, byte admission (§5.9)', () => {
  it('refuses a body one nominal byte past the budget, leaving no spill and no reservation', async () => {
    const payload = completionsBody('b'.repeat(400));
    const bodyBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    const config = configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2) - 1 });
    assert.ok(bodyBytes > config.thresholdBytes, 'the fixture must spill, so a leak here would be visible on disk');
    const { calls } = stubUpstream(() => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));

    let caught: unknown;
    try {
      await post(claudeClientRequest(), 'openai-completions');
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
    assert.equal(getAdmittedBytes(), 0);
  });

  it('admits a body that fits and serves it unchanged', async () => {
    const payload = completionsBody('f'.repeat(400));
    const bodyBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
    configureSpool({ maxMaterializedBodyBytes: Math.ceil(bodyBytes * 2) });
    stubUpstream(() => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } }));

    const response = await post(claudeClientRequest(), 'openai-completions');

    assert.equal(response.status, 200);
    const converted = await response.json() as { content: Array<{ text: string }> };
    assert.equal(converted.content[0].text, 'f'.repeat(400), 'the body was admitted and converted, not dropped');
    assert.equal(getAdmittedBytes(), 0, 'the lease is given back once the parse is done');
  });
});
