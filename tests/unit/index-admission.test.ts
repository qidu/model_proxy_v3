import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';
import { clearModelCache } from '../../src/handlers/models.js';
import { getBlobStoreStats, resetBlobStore } from '../../src/utils/blob-store.js';
import { getSpoolConfig } from '../../src/utils/spool.js';
import { getAdmissionQueueDepth, getAdmittedBytes, resetAdmission } from '../../src/utils/spool-admission.js';

// §5.9 byte admission, wired into the request path: the reservation is taken once
// the body has been received and before it is read, held across the parse and the
// sidecars, and returned early — at the send boundary — when the body's binary has
// become refs; otherwise it is held until the request `finally`, in both cases
// before the response body streams to the client. The response-side half of §5.9
// admits into the same ledger, which is what the request lease competes with, so
// the last two cases here drive a body all the way through both. These tests drive
// the real handler because the wiring lives in `src/index.ts`; the ledger itself is
// covered by spool-admission.test.ts.

const realFetch = globalThis.fetch;
let tempDir = '';
let configPath = '';
let upstreamCalls = 0;
let upstreamText = '';

const CHAT_COMPLETION = JSON.stringify({
  id: 'chat-admission', object: 'chat.completion', created: 1, model: 'test',
  choices: [{ index: 0, message: { role: 'assistant', content: 'seen' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
});

const GEMINI_COMPLETION = JSON.stringify({
  candidates: [{ content: { parts: [{ text: 'seen' }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
});

const SSE_BODY = [
  `data: ${JSON.stringify({ choices: [{ delta: { content: 'seen' }, index: 0, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }] })}\n\n`,
  'data: [DONE]\n\n',
].join('');

/** The text the upstream actually received, whichever egress shape carried it. */
async function sentBodyText(init: RequestInit | undefined): Promise<string> {
  const body = init?.body;
  if (typeof body === 'string') return body;
  assert.ok(body instanceof ReadableStream, `expected a streamed upstream body, got ${Object.prototype.toString.call(body)}`);
  return await new Response(body).text();
}

interface AdmissionConfig {
  /** `max_materialized_body_bytes`: 0/unset leaves admission off (§5.9). */
  maxBytes?: number;
  factor?: number;
  queue?: number;
  timeoutMs?: number;
  /** `[spool] enabled`, which gates the blob store only — never admission. */
  enabled?: boolean;
  /** The route's `upstream_mode`; the default is the OpenAI-compatible one. */
  upstreamMode?: string;
}

function writeConfig({ maxBytes, factor, queue, timeoutMs, enabled = false, upstreamMode = 'openai-completions' }: AdmissionConfig): void {
  const spoolKeys = [
    `enabled = ${enabled}`,
    enabled ? `dir = ${JSON.stringify(join(tempDir, 'spool'))}` : '',
    maxBytes === undefined ? '' : `max_materialized_body_bytes = ${maxBytes}`,
    factor === undefined ? '' : `materialization_factor = ${factor}`,
    queue === undefined ? '' : `max_admission_queue = ${queue}`,
    timeoutMs === undefined ? '' : `admission_timeout_ms = ${timeoutMs}`,
  ].filter((line) => line !== '');

  writeFileSync(configPath, `
[models.default]
upstream_mode = "${upstreamMode}"
base_url = "https://upstream.example"
api_key = "upstream-key"

[spool]
${spoolKeys.join('\n')}
`, 'utf8');
  clearProxyConfigCache();
}

function env(): Record<string, string> {
  return { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' };
}

function clientRequest(bodyText: string, path = '/v1/messages'): Request {
  return new Request(`http://proxy${path}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
    body: bodyText,
  });
}

/** Nominal charge §5.9 puts on a body of `bytes` raw bytes. */
function nominal(bytes: number, factor: number): number {
  return Math.ceil(bytes * factor);
}

/**
 * §5.9 charge on the JSON response every non-streaming case here gets back, at the
 * factor of 2 those cases configure. The non-SSE `/v1/messages` response is received
 * into a spool and then admitted under the same ledger as the request (§5.7/§5.9:
 * "large non-ref responses use the same rule"), ungated by `[spool] enabled` the way
 * the request's own charge is. So a budget that fits only the request leaves this
 * response queued until it times out.
 */
const RESPONSE_CHARGE = nominal(Buffer.byteLength(CHAT_COMPLETION, 'utf8'), 2);

beforeEach(() => {
  clearProxyConfigCache();
  clearModelCache();
  resetBlobStore();
  resetAdmission();
  tempDir = mkdtempSync(join(tmpdir(), 'mpv3-index-admission-'));
  configPath = join(tempDir, 'proxy.toml');
  upstreamCalls = 0;
  upstreamText = '';
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    upstreamCalls += 1;
    upstreamText = await sentBodyText(init);
    return new Response(CHAT_COMPLETION, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  clearProxyConfigCache();
  clearModelCache();
  resetAdmission();
  resetBlobStore();
  globalThis.fetch = realFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('§5.9 byte admission in the request path', () => {
  it('refuses a body over the budget before it is materialized', async () => {
    const image = Buffer.alloc(4096, 0xab).toString('base64');
    const bodyText = JSON.stringify({
      model: 'test',
      max_tokens: 32,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
        ],
      }],
    });
    const bytes = Buffer.byteLength(bodyText, 'utf8');
    // One nominal byte short of this body's charge, with the blob store on: a body
    // that got as far as extraction would have written its payload to the store.
    writeConfig({ maxBytes: nominal(bytes, 2) - 1, factor: 2, enabled: true });

    const response = await handler.fetch(clientRequest(bodyText), env() as any);

    assert.equal(response.status, 503);
    const payload = await response.json() as { type: string; error: { type: string; message: string } };
    assert.equal(payload.type, 'error', 'the refusal uses the standard error envelope');
    assert.equal(payload.error.type, 'over_limit_error', 'the type the client switches on comes from the error itself');
    assert.match(payload.error.message, /exceed max_materialized_body_bytes/);
    assert.equal(upstreamCalls, 0, 'a refused body is never sent upstream');
    assert.equal(getBlobStoreStats().diskEntries, 0, 'nothing was extracted: the refusal precedes materialization');
    assert.equal(getAdmittedBytes(), 0, 'a refused body holds no reservation');
    assert.equal(getAdmissionQueueDepth(), 0);
  });

  it('holds the configured charge across the sidecars and returns it before the response', async () => {
    const bodyText = JSON.stringify({
      model: 'test',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'x'.repeat(2048) }],
    });
    const bytes = Buffer.byteLength(bodyText, 'utf8');
    // This body keeps its reservation across the send, so its own response has to
    // fit beside it: with the spool on, the router's stats read materializes the
    // response under the same §5.9 ledger (`index.ts`). The budget is the request's
    // charge plus exactly the response's — one byte less and the response queues.
    const responseNominal = nominal(Buffer.byteLength(CHAT_COMPLETION, 'utf8'), 3);
    writeConfig({ maxBytes: nominal(bytes, 3) + responseNominal, factor: 3, queue: 1, enabled: true });

    let admittedAtSend = -1;
    let queuedAtSend = -1;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamCalls += 1;
      upstreamText = await sentBodyText(init);
      // Sampled while the request is in flight: the parsed body and the text
      // serialized from it are both live, so the reservation must still be held.
      admittedAtSend = getAdmittedBytes();
      queuedAtSend = getAdmissionQueueDepth();
      return new Response(CHAT_COMPLETION, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const response = await handler.fetch(clientRequest(bodyText), env() as any);

    assert.equal(response.status, 200);
    assert.equal(upstreamCalls, 1);
    assert.equal(admittedAtSend, nominal(bytes, 3), 'the charge is ceil(body bytes × materialization_factor)');
    assert.equal(queuedAtSend, 0);
    assert.equal(getAdmittedBytes(), 0, 'the request-end release returned the reservation, the response one already went back to the ledger');
  });

  it('charges the same way with the blob store disabled', async () => {
    const bodyText = JSON.stringify({
      model: 'test',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'y'.repeat(1024) }],
    });
    const bytes = Buffer.byteLength(bodyText, 'utf8');
    // No `enabled` key: §9.1 keeps the store off, and admission must not care —
    // the receive path materializes the body either way. The budget therefore has
    // to hold this body's charge and its own response's, which are live together.
    writeConfig({ maxBytes: nominal(bytes, 2) + RESPONSE_CHARGE, factor: 2 });

    let admittedAtSend = -1;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamCalls += 1;
      upstreamText = await sentBodyText(init);
      admittedAtSend = getAdmittedBytes();
      return new Response(CHAT_COMPLETION, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const response = await handler.fetch(clientRequest(bodyText), env() as any);

    assert.equal(getSpoolConfig().enabled, false);
    assert.equal(response.status, 200);
    assert.equal(admittedAtSend, nominal(bytes, 2), 'the default factor of 2 charges the body with the store off');
    assert.equal(getAdmittedBytes(), 0);
  });

  it('queues a body while the budget is taken, refuses it on timeout, and admits again after the release', async () => {
    const bodyText = JSON.stringify({
      model: 'test',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'z'.repeat(512) }],
    });
    const bytes = Buffer.byteLength(bodyText, 'utf8');
    // The room this body's own response needs is part of the budget, so the only
    // thing the second body can be waiting on is the first body's charge.
    writeConfig({ maxBytes: nominal(bytes, 2) + RESPONSE_CHARGE, factor: 2, queue: 1, timeoutMs: 60 });

    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => { openGate = resolve; });
    let reachedUpstream!: () => void;
    const atUpstream = new Promise<void>((resolve) => { reachedUpstream = resolve; });

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamCalls += 1;
      upstreamText = await sentBodyText(init);
      if (upstreamCalls === 1) {
        reachedUpstream();
        await gate;
      }
      return new Response(CHAT_COMPLETION, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const first = handler.fetch(clientRequest(bodyText), env() as any);
    await atUpstream;
    assert.equal(getAdmittedBytes(), nominal(bytes, 2), 'the in-flight body holds its charge');
    assert.equal(getAdmissionQueueDepth(), 0);

    const refused = await handler.fetch(clientRequest(bodyText), env() as any);
    assert.equal(refused.status, 503);
    const payload = await refused.json() as { type: string; error: { type: string; message: string } };
    assert.equal(payload.type, 'error');
    assert.equal(payload.error.type, 'over_limit_error', 'a queued body that gives up is refused the same way as one over budget');
    assert.match(payload.error.message, /admission timed out after 60 ms/);
    assert.equal(upstreamCalls, 1, 'the queued body never reached the upstream');
    assert.equal(getAdmittedBytes(), nominal(bytes, 2), 'a queued body that timed out holds nothing');
    assert.equal(getAdmissionQueueDepth(), 0, 'the timed-out waiter left the queue');

    openGate();
    const admitted = await first;
    assert.equal(admitted.status, 200);
    assert.equal(getAdmittedBytes(), 0, 'the released bytes are free for the next body');
  });

  it('returns the reservation when the body never parses, so the next body still fits', async () => {
    const good = JSON.stringify({ model: 'test', max_tokens: 32, messages: [{ role: 'user', content: 'ok' }] });
    const goodBytes = Buffer.byteLength(good, 'utf8');
    // The budget is exactly the good body's charge plus its own response's: any
    // reservation leaked by the failed request below eats into that second half, so
    // the good request queues behind it and times out.
    writeConfig({ maxBytes: nominal(goodBytes, 2) + RESPONSE_CHARGE, factor: 2, queue: 1, timeoutMs: 60 });

    const broken = '{"model": "test", "messages": [';
    const failed = await handler.fetch(clientRequest(broken), env() as any);

    assert.equal(failed.status, 400);
    const payload = await failed.json() as { error: { message: string } };
    assert.equal(payload.error.message, 'Invalid request body');
    assert.equal(upstreamCalls, 0);
    assert.equal(getAdmittedBytes(), 0, 'the failed body released its reservation');

    const next = await handler.fetch(clientRequest(good), env() as any);
    assert.equal(next.status, 200, 'the budget is fully available again');
    assert.equal(upstreamCalls, 1);
    assert.equal(getAdmittedBytes(), 0);
  });

  it('holds nothing while the response body streams to the client', async () => {
    const bodyText = JSON.stringify({
      model: 'test',
      max_tokens: 32,
      stream: true,
      messages: [{ role: 'user', content: 'stream please' }],
    });
    const bytes = Buffer.byteLength(bodyText, 'utf8');
    writeConfig({ maxBytes: nominal(bytes, 2), factor: 2, queue: 1, timeoutMs: 60 });

    let admittedAtSend = -1;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamCalls += 1;
      upstreamText = await sentBodyText(init);
      admittedAtSend = getAdmittedBytes();
      return new Response(SSE_BODY, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;

    const response = await handler.fetch(clientRequest(bodyText), env() as any);

    assert.equal(response.status, 200);
    assert.equal(admittedAtSend, nominal(bytes, 2), 'the upstream call happened while the body was admitted');
    // Headers are in hand and not one event has been read yet (§5.9: admission is
    // released before slow client streaming, so it does not cap SSE connections).
    assert.equal(getAdmittedBytes(), 0);
    assert.equal(getAdmissionQueueDepth(), 0);

    const streamed = await response.text();
    assert.ok(streamed.includes('event: message_start'), 'the response stream is intact after the release');
    assert.ok(streamed.includes('event: message_stop'), 'the stream terminated normally');
  });

  it('gives up the charge once the binary is refs, and keeps it for a body with none', async () => {
    const image = Buffer.alloc(4096, 0xab).toString('base64');
    const imageBody = JSON.stringify({
      model: 'test',
      max_tokens: 32,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'what is this' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
        ],
      }],
    });
    const bytes = Buffer.byteLength(imageBody, 'utf8');
    // The budget is exactly this body's own charge, so nothing but a release
    // during the request can free room for anything else while it is open.
    writeConfig({ maxBytes: nominal(bytes, 2), factor: 2, queue: 1, timeoutMs: 60, enabled: true });

    const sampled: Array<{ admitted: number; disk: number; text: string }> = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamCalls += 1;
      const text = await sentBodyText(init);
      sampled.push({ admitted: getAdmittedBytes(), disk: getBlobStoreStats().diskEntries, text });
      return new Response(CHAT_COMPLETION, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const withRefs = await handler.fetch(clientRequest(imageBody), env() as any);

    assert.equal(withRefs.status, 200);
    assert.equal(sampled[0].disk, 1, 'the payload was extracted to the store, not left inline');
    assert.equal(sampled[0].admitted, 0, 'refs replaced the payloads before the send, so this request holds nothing');
    assert.ok(sampled[0].text.includes(image), 'the payload still reached the upstream — the charge went away, the bytes did not');
    assert.equal(getAdmittedBytes(), 0);

    const plainBody = JSON.stringify({
      model: 'test',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'x'.repeat(4096) }],
    });
    const plainBytes = Buffer.byteLength(plainBody, 'utf8');
    assert.ok(nominal(plainBytes, 2) <= nominal(bytes, 2), 'the contrast body has to fit the same budget');

    const noRefs = await handler.fetch(clientRequest(plainBody), env() as any);

    assert.equal(noRefs.status, 200);
    assert.equal(upstreamCalls, 2);
    assert.equal(sampled[1].admitted, nominal(plainBytes, 2), 'a body with nothing to extract keeps its charge for the whole request');
    assert.equal(getAdmittedBytes(), 0, 'and the request-end release returns it');
  });

  it('admits a binary request\'s own response under a budget of exactly one request', async () => {
    const image = Buffer.alloc(4096, 0xcd).toString('base64');
    const bodyText = JSON.stringify({
      model: 'gemini-test',
      input: {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: image } },
          ],
        }],
      },
    });
    const bytes = Buffer.byteLength(bodyText, 'utf8');
    // §5.9's response admission (`gemini.ts`, the /v1/interactions egress) draws on
    // the same ledger. With the budget set to this request's own charge, it can be
    // admitted only if the request gave its reservation back at the boundary.
    writeConfig({
      maxBytes: nominal(bytes, 2), factor: 2, queue: 1, timeoutMs: 60,
      enabled: true, upstreamMode: 'gemini-generatecontent',
    });

    let admittedAtSend = -1;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamCalls += 1;
      upstreamText = await sentBodyText(init);
      admittedAtSend = getAdmittedBytes();
      return new Response(GEMINI_COMPLETION, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const response = await handler.fetch(clientRequest(bodyText, '/v1/interactions'), env() as any);

    assert.equal(response.status, 200, 'the request released its charge, so its own response fits the budget');
    assert.equal(upstreamCalls, 1);
    assert.equal(admittedAtSend, 0);
    assert.ok(upstreamText.includes(image), 'the binary reached the upstream from the ref-bearing body');
    const payload = await response.json() as { object: string; outputs: Array<{ type: string; text: string }> };
    assert.equal(payload.object, 'interaction');
    assert.deepEqual(payload.outputs, [{ type: 'text', text: 'seen' }]);
    assert.equal(getAdmittedBytes(), 0, 'the response lease is returned before the client body streams');
    assert.equal(getAdmissionQueueDepth(), 0, 'nothing was left waiting on the ledger');
  });

  it('refuses that response when the body has nothing to extract', async () => {
    // Padded so this body's own charge covers the response's: with a smaller budget
    // the response admission would be refused outright for being over budget, and
    // what is under test — a charge still held at send time — is what has to push
    // it into the queue instead.
    const bodyText = JSON.stringify({ model: 'gemini-test', input: 'plain text, no payload '.repeat(8) });
    const bytes = Buffer.byteLength(bodyText, 'utf8');
    const responseNominal = nominal(Buffer.byteLength(GEMINI_COMPLETION, 'utf8'), 2);
    assert.ok(nominal(bytes, 2) >= responseNominal, 'the fixture must leave the response admission queued, not over budget');
    writeConfig({
      maxBytes: nominal(bytes, 2), factor: 2, queue: 1, timeoutMs: 60,
      enabled: true, upstreamMode: 'gemini-generatecontent',
    });

    let admittedAtSend = -1;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      upstreamCalls += 1;
      upstreamText = await sentBodyText(init);
      admittedAtSend = getAdmittedBytes();
      return new Response(GEMINI_COMPLETION, { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const response = await handler.fetch(clientRequest(bodyText, '/v1/interactions'), env() as any);

    assert.equal(admittedAtSend, nominal(bytes, 2), 'a non-ref body holds its charge across the send');
    assert.equal(response.status, 503);
    const payload = await response.json() as { type: string; error: { type: string; message: string } };
    assert.equal(payload.type, 'error');
    assert.equal(payload.error.type, 'over_limit_error');
    assert.match(payload.error.message, /admission timed out after 60 ms/);
    assert.equal(upstreamCalls, 1, 'the request itself was admitted — the refusal is the response admission');
    assert.equal(getAdmittedBytes(), 0);
    assert.equal(getAdmissionQueueDepth(), 0);
  });
});
