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
 *    the spill and holds no reservation;
 *  - the `/tmp/test_model.log` debug capture observes that same single read
 *    instead of teeing a second reader, and reaches its line on either terminal
 *    path — the end of a body, and the cancel the SSE converter performs when it
 *    stops the upstream at `[DONE]`.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleMessagesRequest } from '../../src/handlers/messages.js';
import { ClaudeProxyError } from '../../src/utils/errors.js';
import { SpoolResponseTooLargeError } from '../../src/utils/spool-response.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { SPOOL_DEFAULTS, responseSpillDir, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';
import { AdmissionOverBudgetError, getAdmittedBytes } from '../../src/utils/spool-admission.js';

const realFetch = globalThis.fetch;
const COMPLETIONS_URL = 'https://upstream.example/v1/chat/completions';
const RESPONSES_URL = 'https://upstream.example/v1/responses';
const ENV = { LOG_LEVEL: 'error' } as any;
/** The level both capture sites are gated on. */
const DEBUG_ENV = { LOG_LEVEL: 'debug' } as any;

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

/**
 * The same already-OpenAI body, naming `test_tool`: the gate the passthrough
 * capture site reads off the client's own body. An OpenAI-format tool keeps
 * `hasClaudeFormatTools` false, so the request still takes the passthrough branch.
 */
function openaiToolRequest(stream = false): Request {
  return new Request('http://proxy/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-test',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'test_tool', description: 'test', parameters: { type: 'object' } } }],
      ...(stream ? { stream: true } : {}),
    }),
  });
}

/**
 * A Claude-format body naming `test_tool`: the converted capture site reads its
 * gate off the converted upstream body, so the tool has to survive the conversion.
 */
function claudeToolRequest(): Request {
  return new Request('http://proxy/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-test',
      max_tokens: 64,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [{ name: 'test_tool', description: 'test', input_schema: { type: 'object', properties: {} } }],
    }),
  });
}

/** The frames a Completions upstream answers a streaming request with, ending at `[DONE]`. */
function sseFrames(): string[] {
  const frame = (delta: Record<string, unknown>): string => `data: ${JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'gpt-test',
    choices: [{ index: 0, delta, finish_reason: null }],
  })}\n\n`;
  return [frame({ role: 'assistant', content: 's'.repeat(3000) }), frame({ content: '!' }), 'data: [DONE]\n\n'];
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
  env: Record<string, unknown> = ENV,
): Promise<Response> {
  return await handleMessagesRequest(
    request,
    upstreamMode === 'openai-responses' ? RESPONSES_URL : COMPLETIONS_URL,
    { Authorization: 'Bearer upstream-key' },
    'req-messages-response',
    'gpt-test',
    env as any,
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

// ---------------------------------------------------------------------------
// §5.7: the /tmp/test_model.log capture is single-pass too
// ---------------------------------------------------------------------------

/**
 * Run `body` with `os.tmpdir()` pointed at a fresh scratch directory, and hand it
 * the `/tmp/test_model.log` path inside it.
 *
 * `tmpdir()` reads `$TMPDIR` per call, so the redirect needs no seam in the
 * proxy — and it keeps the operator's own `/tmp/test_model.log` untouched. The
 * file does not exist until the proxy writes it, which is what makes "before the
 * body is consumed there is nothing" an assertion rather than a guess.
 */
async function withLogDir<T>(body: (logPath: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'messages-test-model-log-'));
  scratchDirs.push(dir);
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  try {
    return await body(join(dir, 'test_model.log'));
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}

interface Capture {
  label: string;
  url: string;
  status: string;
  body: string;
}

/**
 * The captures a `/tmp/test_model.log` holds, as structure rather than as text:
 * one record per `---`, so the count itself is pinned.
 */
function captures(log: string): Capture[] {
  return log
    .split('\n---\n')
    .filter((record) => record.trim() !== '')
    .map((record) => {
      const lines = record.split('\n');
      return {
        label: /^\[[^\]]+\] upstream response \((.+)\)$/.exec(lines[0])?.[1] ?? '',
        url: (lines[1] ?? '').replace('upstream url: ', ''),
        status: (lines[2] ?? '').replace('upstream status: ', ''),
        body: lines.slice(4).join('\n'),
      };
    });
}

/** Let the cancellation chain settle: the capture writes on its last hop. */
const settle = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });

describe('messages.ts /tmp/test_model.log capture (§5.7)', () => {
  it('captures the passthrough body once, in one pass, keeping 2000 characters and no clone', async () => {
    const config = configureSpool();
    const payload = JSON.stringify(completionsBody('p'.repeat(4000)));
    assert.ok(payload.length > 2000, 'the fixture must be longer than the capture, or the bound proves nothing');
    assert.ok(new TextEncoder().encode(payload).byteLength > config.thresholdBytes, 'the capture must survive the spill path');
    const { calls } = stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));
    const baseline = await (await post(openaiToolRequest(), 'openai-completions')).text();

    await withLogDir(async (logPath) => {
      const { result: response, clones } = await countClones(() => post(openaiToolRequest(), 'openai-completions', DEBUG_ENV));

      // This egress reads the upstream body to convert it before it answers, so the
      // capture is already written here — what must not have happened is the second
      // copy the old `clone()` held, and any change to the body the client reads.
      assert.equal(await response.text(), baseline, 'the capture must not change the body the client reads');

      const found = captures(readFileSync(logPath, 'utf8'));
      assert.equal(found.length, 1, 'one response, one capture');
      assert.deepEqual(found[0], {
        label: 'openai-passthrough',
        url: COMPLETIONS_URL,
        status: '200',
        body: payload.slice(0, 2000),
      });
      assert.equal(clones, 0, 'the capture must not have held a second copy of the body');
    });
    assert.equal(calls(), 2);
  });

  it('captures the converted body under its own label, and only when the request names test_tool', async () => {
    configureSpool();
    const payload = JSON.stringify(completionsBody('c'.repeat(3000)));
    stubUpstream(() => new Response(payload, { headers: { 'Content-Type': 'application/json' } }));

    await withLogDir(async (logPath) => {
      const { result: response, clones } = await countClones(() => post(claudeToolRequest(), 'openai-completions', DEBUG_ENV));
      const converted = await response.json() as { content: Array<{ text: string }> };
      assert.equal(converted.content[0].text, 'c'.repeat(3000));

      const found = captures(readFileSync(logPath, 'utf8'));
      assert.equal(found.length, 1);
      assert.deepEqual(found[0], {
        label: 'claude->openai',
        url: COMPLETIONS_URL,
        status: '200',
        body: payload.slice(0, 2000),
      });
      assert.equal(clones, 0);

      // The same site, twice: the gate is the request body, and the level is the
      // capture's. Neither run may add a line to the one already there.
      await (await post(claudeClientRequest(), 'openai-completions', DEBUG_ENV)).text();
      assert.equal(captures(readFileSync(logPath, 'utf8')).length, 1, 'a body not naming test_tool must not be captured');
      await (await post(claudeToolRequest(), 'openai-completions')).text();
      assert.equal(captures(readFileSync(logPath, 'utf8')).length, 1, 'a request outside LOG_LEVEL=debug must not be captured');
    });
  });

  it('captures a streamed body on the cancel the converter stops the upstream with at [DONE]', async () => {
    configureSpool();
    const frames = sseFrames();
    const wire = frames.join('');
    assert.ok(frames[0].length > 2000, 'the first frame on its own must exceed the capture');
    stubUpstream(() => new Response(wire, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
    const baseline = await (await post(openaiToolRequest(true), 'openai-completions')).text();

    // Frames past `[DONE]` that the converter never reads: the upstream body
    // cannot reach its end, so the capture has no closing path to land on — only
    // the cancel the converter performs, which is how every OpenAI stream ends.
    const encoder = new TextEncoder();
    const src = source([...frames, ...Array.from({ length: 6 }, () => 'data: {"ignored":true}\n\n')].map((f) => encoder.encode(f)));
    stubUpstream(() => new Response(src.stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));

    await withLogDir(async (logPath) => {
      const { result: response, clones } = await countClones(() => post(openaiToolRequest(true), 'openai-completions', DEBUG_ENV));
      assert.equal(await response.text(), baseline, 'the capture must not change the SSE bytes');
      await settle();

      assert.equal(src.cancelled, true, 'the converter must have stopped the upstream, or this test proves nothing');
      const found = captures(readFileSync(logPath, 'utf8'));
      assert.equal(found.length, 1);
      assert.deepEqual(found[0], {
        label: 'openai-passthrough',
        url: COMPLETIONS_URL,
        status: '200',
        body: frames[0].slice(0, 2000),
      });
      assert.equal(clones, 0);
    });
  });

  it('captures an upstream error body before the error is raised', async () => {
    configureSpool();
    const body = JSON.stringify({ error: { type: 'rate_limit_error', message: 'slow down' } });
    stubUpstream(() => new Response(body, { status: 429, headers: { 'Content-Type': 'application/json' } }));

    await withLogDir(async (logPath) => {
      let caught: unknown;
      try {
        await post(openaiToolRequest(), 'openai-completions', DEBUG_ENV);
      } catch (error) {
        caught = error;
      }

      assert.ok(caught instanceof ClaudeProxyError, `expected the upstream error, got ${String(caught)}`);
      assert.equal(caught.status, 429);
      assert.equal((caught as unknown as { upstreamBody?: string }).upstreamBody, body, 'the whole body was still read');
      const found = captures(readFileSync(logPath, 'utf8'));
      assert.equal(found.length, 1);
      assert.equal(found[0].status, '429');
      assert.equal(found[0].body, body);
    });
  });
});
