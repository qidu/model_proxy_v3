import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';
import { clearModelCache } from '../../src/handlers/models.js';
import { evictIdleBlobs, resetBlobStore } from '../../src/utils/blob-store.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { getAdmissionQueueDepth, getAdmittedBytes, resetAdmission } from '../../src/utils/spool-admission.js';

// §12 end-to-end evidence: concurrent binary and non-ref traffic through the
// real request path, with §5.9 admission enabled and disabled. Binary bodies
// carry §5.4 payloads that become refs; non-ref bodies carry large plain text
// that stays materialized. The claims: every request is answered, every
// upstream body carries exactly its own request's payload — no ref marker, no
// neighbour's bytes — and both ledgers (admission, spill) return to zero once
// the burst is over.

const realFetch = globalThis.fetch;
let tempDir = '';
let configPath = '';
let upstreamBodies: string[] = [];

const CHAT_COMPLETION = JSON.stringify({
  id: 'chat-concurrent', object: 'chat.completion', created: 1, model: 'test',
  choices: [{ index: 0, message: { role: 'assistant', content: 'seen' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
});

/** The text the upstream actually received, whichever egress shape carried it. */
async function sentBodyText(init: RequestInit | undefined): Promise<string> {
  const body = init?.body;
  if (typeof body === 'string') return body;
  assert.ok(body instanceof ReadableStream, `expected a streamed upstream body, got ${Object.prototype.toString.call(body)}`);
  return await new Response(body).text();
}

function writeConfig(maxMaterializedBodyBytes: number): void {
  writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"

[spool]
enabled = true
dir = ${JSON.stringify(join(tempDir, 'spool'))}
threshold_bytes = 64
max_materialized_body_bytes = ${maxMaterializedBodyBytes}
materialization_factor = 2
max_admission_queue = 32
admission_timeout_ms = 10000
`, 'utf8');
  clearProxyConfigCache();
}

function env(): Record<string, string> {
  return { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' };
}

/** A distinct, valid base64 payload per request — 2 KiB of `seed` bytes. */
function imagePayload(seed: number): string {
  return Buffer.alloc(2048, seed).toString('base64');
}

/** A chat body with one §5.4 image payload and a unique marker text. */
function binaryBody(index: number): string {
  return JSON.stringify({
    model: 'test',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `binary-${index}` },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${imagePayload(index)}` } },
      ],
    }],
  });
}

/** A chat body with a large plain-text field and a unique marker text. */
function nonRefBody(index: number): string {
  return JSON.stringify({
    model: 'test',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: `nonref-${index} ${'t'.repeat(4096)}` },
      ],
    }],
  });
}

function clientRequest(bodyText: string): Request {
  return new Request('http://proxy/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
    body: bodyText,
  });
}

beforeEach(() => {
  clearProxyConfigCache();
  clearModelCache();
  resetBlobStore();
  resetAdmission();
  tempDir = mkdtempSync(join(tmpdir(), 'mpv3-concurrent-traffic-'));
  configPath = join(tempDir, 'proxy.toml');
  upstreamBodies = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const text = await sentBodyText(init);
    upstreamBodies.push(text);
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

const BINARY_COUNT = 8;
const NONREF_COUNT = 8;

/**
 * Fire the mixed burst and assert every request is answered and every upstream
 * body carries exactly its own request's payload.
 */
async function runBurst(): Promise<void> {
  const responses = await Promise.all([
    ...Array.from({ length: BINARY_COUNT }, (_, i) => handler.fetch(clientRequest(binaryBody(i)), env() as any)),
    ...Array.from({ length: NONREF_COUNT }, (_, i) => handler.fetch(clientRequest(nonRefBody(i)), env() as any)),
  ]);

  for (const [index, response] of responses.entries()) {
    if (response.status !== 200) {
      assert.fail(`request ${index} must be answered, got ${response.status}: ${await response.text()}`);
    }
    await response.arrayBuffer();
  }
  assert.equal(upstreamBodies.length, BINARY_COUNT + NONREF_COUNT, 'every request reached the upstream exactly once');

  for (let i = 0; i < BINARY_COUNT; i++) {
    const matches = upstreamBodies.filter((text) => text.includes(`binary-${i}`));
    assert.equal(matches.length, 1, `exactly one upstream body may carry binary request ${i}`);
    assert.ok(
      matches[0].includes(`data:image/png;base64,${imagePayload(i)}`),
      `binary request ${i}'s payload must reach the upstream intact`,
    );
    assert.equal(matches[0].includes('$spoolBlob'), false, 'no ref marker may reach the upstream');
  }
  for (let i = 0; i < NONREF_COUNT; i++) {
    const matches = upstreamBodies.filter((text) => text.includes(`nonref-${i}`));
    assert.equal(matches.length, 1, `exactly one upstream body may carry non-ref request ${i}`);
    assert.ok(matches[0].includes('t'.repeat(4096)), `non-ref request ${i}'s text must reach the upstream intact`);
  }
  // No cross-contamination: a body that is not request i's must not hold i's payload.
  for (let i = 0; i < BINARY_COUNT; i++) {
    const foreign = upstreamBodies.filter((text) => !text.includes(`binary-${i}`) && text.includes(imagePayload(i)));
    assert.equal(foreign.length, 0, `binary request ${i}'s payload must not leak into a neighbour's body`);
  }
}

describe('concurrent binary and non-ref traffic (§12)', () => {
  it('serves a mixed burst correctly with §5.9 admission enabled and contended', async () => {
    // A budget that fits roughly two bodies, so the burst really queues.
    writeConfig(24_000);
    await runBurst();

    assert.equal(getAdmittedBytes(), 0, 'every admission is released once the burst is over');
    assert.equal(getAdmissionQueueDepth(), 0, 'no waiter is stranded');
    assert.equal(getLiveSpillBytes(), 0, 'every spill reservation is returned');
    // The extracted blobs stay as idle cache entries until their TTL; nothing
    // is still leased, so the sweep can take all of them.
    const evicted = await evictIdleBlobs(Date.now() + 3_600_000);
    assert.equal(evicted, BINARY_COUNT, 'each binary request’s payload is idle-releasable after its request');
  });

  it('serves the same burst with §5.9 admission disabled', async () => {
    writeConfig(0);
    await runBurst();

    assert.equal(getAdmittedBytes(), 0, 'a disabled budget charges nothing');
    assert.equal(getLiveSpillBytes(), 0);
    const evicted = await evictIdleBlobs(Date.now() + 3_600_000);
    assert.equal(evicted, BINARY_COUNT, 'each binary request’s payload is idle-releasable after its request');
  });

  it('dedupes concurrent identical payloads without losing a lease', async () => {
    // Regression: concurrent `putBlob` of the same *new* hash used to race the
    // index check past the write's awaits, so every racer set `refs: 1` (last
    // write won) and the extra releases threw `refs already 0` in the request
    // `finally` — a 500 for traffic that should dedupe to one stored blob.
    writeConfig(0);
    const identical = binaryBody(0);
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => handler.fetch(clientRequest(identical), env() as any)),
    );

    for (const response of responses) {
      if (response.status !== 200) {
        assert.fail(`every identical request must be answered, got ${response.status}: ${await response.text()}`);
      }
      await response.arrayBuffer();
    }
    assert.equal(upstreamBodies.length, 8, 'every request still reached the upstream');
    for (const text of upstreamBodies) {
      assert.ok(text.includes(`data:image/png;base64,${imagePayload(0)}`), 'each upstream body carries the shared payload');
      assert.equal(text.includes('$spoolBlob'), false);
    }
    // One stored object, no lease left behind — a lost ref would pin it, a
    // double release would have thrown above.
    const evicted = await evictIdleBlobs(Date.now() + 3_600_000);
    assert.equal(evicted, 1, 'the eight requests deduped to one blob, and every lease came back');
    assert.equal(getLiveSpillBytes(), 0);
  });
});
