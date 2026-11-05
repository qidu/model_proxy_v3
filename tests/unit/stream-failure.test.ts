/**
 * Unit tests for §5.7's "Failure after response streaming begins".
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.7, §10, §12.
 *
 * The Node adapter's two response tails end in `pipeline(...)`. A rejection
 * there has two very different meanings and this file pins both:
 *
 *   - the response body itself failed after the headers were on the wire (here:
 *     a response spill truncated on disk mid-stream). The client must see an
 *     aborted connection rather than a silently truncated body, the failure must
 *     be logged with the request id and the failed pipeline stage, and the
 *     spill's file and reservation must both be gone afterwards.
 *   - the client hung up. That is the ordinary case and must stay silent.
 *
 * The reporting closure itself is built in `src/index.ts` (only it knows the
 * request id and the logger) and consumed by `src/server.ts`, so the wiring
 * tests below drive the real handler through the real adapter — the assertion
 * set that matters is what a client and the log see, not an internal call.
 */

import { after, afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import handler from '../../src/index.js';
import { buildNodeEnv, createNodeRequestHandler, type NodeEnv } from '../../src/server.js';
import {
  attachStreamFailureReporter,
  consumeStreamFailureReporter,
} from '../../src/utils/stream-failure.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';
import { clearModelCache } from '../../src/handlers/models.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { getSpoolConfig, responseSpillDir } from '../../src/utils/spool.js';
import { getAdmittedBytes, resetAdmission } from '../../src/utils/spool-admission.js';
import { resetBlobStore } from '../../src/utils/blob-store.js';
import { getActiveRequestCount } from '../../src/utils/dashboard-stats.js';
import type { Logger } from '../../src/types/shared.js';

const realFetch = globalThis.fetch;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
});

/**
 * A 16 MiB upstream body: far more than any socket buffer can absorb, so a
 * client that stops reading cannot have had the whole body pushed at it before
 * the test truncates the spill. The bytes vary with their offset, so the prefix
 * the client receives is real evidence about which bytes reached it.
 */
const BODY_BYTES = 16 * 1024 * 1024;

function bodyPattern(total = BODY_BYTES): Uint8Array {
  const bytes = new Uint8Array(total);
  for (let i = 0; i < total; i++) bytes[i] = ((i * 7 + 11) % 251) + 1; // never 0, never JSON
  return bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Names of the response spill files currently on disk. */
function spillFiles(): string[] {
  const dir = responseSpillDir(getSpoolConfig());
  return existsSync(dir) ? readdirSync(dir) : [];
}

function writeConfig({ upstreamMode = 'openai-completions' } = {}): { dir: string; configPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'stream-failure-test-'));
  scratchDirs.push(dir);
  const configPath = join(dir, 'proxy.toml');
  writeFileSync(configPath, `
[models.default]
upstream_mode = "${upstreamMode}"
base_url = "https://upstream.example"
api_key = "upstream-key"

[models.passthrough]
local = {base = "https://upstream.example", key = "upstream-key", mode = "anthropic-messages"}

[spool]
enabled = true
dir = ${JSON.stringify(join(dir, 'spool'))}
threshold_bytes = 64
`, 'utf8');
  clearProxyConfigCache();
  return { dir, configPath };
}

function envFor(configPath: string): NodeEnv {
  return buildNodeEnv({ PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' });
}

/** The real handler behind the real Node adapter, on an ephemeral port. */
async function withProxy(
  env: NodeEnv,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(createNodeRequestHandler(env, handler.fetch as never));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}

const MESSAGES_BODY = JSON.stringify({
  model: 'test',
  messages: [{ role: 'user', content: 'hi' }],
});

/** An upstream SSE body that yields one frame and then never completes. */
function openSse(chunks: string[]): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      // Deliberately never closed: the client hangs up while upstream is still
      // producing, which is the case §5.7's pipeline() must unwind.
    },
    cancel() { cancelled = true; },
  });
  return { stream, cancelled: () => cancelled };
}

function logsDuring(): { lines: string[]; restore: () => void } {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  return { lines, restore: () => { console.log = original; } };
}

beforeEach(() => {
  clearProxyConfigCache();
  clearModelCache();
  resetBlobStore();
  resetAdmission();
});

afterEach(() => {
  clearProxyConfigCache();
  clearModelCache();
  resetAdmission();
  resetBlobStore();
  globalThis.fetch = realFetch;
  // A leaked reservation or spill here would silently weaken every later test.
  assert.equal(getLiveSpillBytes(), 0, 'every spool must return its reservation');
  assert.equal(getAdmittedBytes(), 0, 'every lease must be released');
});

// ---------------------------------------------------------------------------
// The reporting closure
// ---------------------------------------------------------------------------

function recordingLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = [];
  return {
    errors,
    logger: {
      traceEnabled: false,
      trace() {},
      debug() {},
      info() {},
      warn() {},
      error(requestId: string, message: string) { errors.push(`${requestId} ${message}`); },
    },
  };
}

describe('mid-stream failure reporting (§5.7)', () => {
  it('reports the request id, stage, endpoint and cause, exactly once', () => {
    const { logger, errors } = recordingLogger();
    const response = new Response('body');
    attachStreamFailureReporter(response, logger, 'req_1', '/v1/messages');

    const report = consumeStreamFailureReporter(response);
    assert.ok(report, 'the adapter must be able to take the reporter off the response');
    report(new Error('[spool] spill /tmp/x/resp-1 ended at 65536 of 4096 bytes'));

    assert.deepEqual(errors, [
      'req_1 [OUT] /v1/messages: response stream failed after headers were sent: '
      + '[spool] spill /tmp/x/resp-1 ended at 65536 of 4096 bytes',
    ]);
    assert.equal(consumeStreamFailureReporter(response), undefined, 'a consumed reporter must not report twice');
  });

  it('stays silent when the client hung up — the ordinary mid-write disconnect', () => {
    const { logger, errors } = recordingLogger();
    const response = new Response('body');
    attachStreamFailureReporter(response, logger, 'req_1', '/v1/messages');

    const prematureClose = Object.assign(new Error('Premature close'), {
      code: 'ERR_STREAM_PREMATURE_CLOSE',
    });
    consumeStreamFailureReporter(response)!(prematureClose);

    assert.deepEqual(errors, [], 'an abandoned connection is not a failure');
  });

  it('reports a rejection that is not an Error rather than swallowing it', () => {
    const { logger, errors } = recordingLogger();
    const response = new Response('body');
    attachStreamFailureReporter(response, logger, 'req_2', '/v1/chat/completions');

    consumeStreamFailureReporter(response)!('socket tore down');

    assert.deepEqual(errors, [
      'req_2 [OUT] /v1/chat/completions: response stream failed after headers were sent: socket tore down',
    ]);
  });
});

// ---------------------------------------------------------------------------
// End to end: a response spill that ends short mid-stream
// ---------------------------------------------------------------------------

describe('§5.7 failure after response streaming begins', () => {
  it('aborts the client, logs the failure, and leaves no spill behind when the spill ends short', { timeout: 30000 }, async () => {
    const { configPath } = writeConfig();
    const env = envFor(configPath);
    const pattern = bodyPattern();
    const initialActive = getActiveRequestCount();

    globalThis.fetch = (async () => new Response(pattern, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })) as typeof fetch;

    const captured = logsDuring();
    interface Seen { status: number; received: Uint8Array[]; bytes: number; complete: boolean; error: string }
    let seen!: Seen;
    try {
      await withProxy(env, async (baseUrl) => {
        const url = new URL(baseUrl);
        const payload = Buffer.from(MESSAGES_BODY, 'utf8');
        seen = await new Promise<Seen>((resolve, reject) => {
          const chunks: Uint8Array[] = [];
          let bytes = 0;
          let truncated = false;
          let error = '';
          const request = httpRequest({
            host: url.hostname,
            port: url.port,
            method: 'POST',
            path: '/passthrough/v1/messages',
            headers: {
              'content-type': 'application/json',
              'content-length': String(payload.byteLength),
              authorization: 'Bearer client-key',
            },
          }, (incoming) => {
            incoming.on('data', (chunk: Buffer) => {
              chunks.push(chunk);
              bytes += chunk.byteLength;
              if (truncated) return;
              // Headers are out and one chunk of the spill has reached us: the
              // rest of the file is not on the wire yet, so emptying it makes
              // every later read from the spool come up short.
              truncated = true;
              incoming.pause();
              const files = spillFiles();
              assert.equal(files.length, 1, 'the 16 MiB body must have spilled to a responses/ file');
              truncateSync(join(responseSpillDir(getSpoolConfig()), files[0]), 0);
              incoming.resume();
            });
            // A destroyed connection is the expected outcome here, so the
            // socket error is evidence to record, not a reason to fail the test.
            incoming.on('error', (failure: Error) => { error = failure.message; });
            incoming.on('close', () => {
              resolve({
                status: incoming.statusCode ?? 0,
                received: chunks,
                bytes,
                complete: incoming.complete,
                error,
              });
            });
          });
          request.on('error', (failure) => reject(failure));
          request.end(payload);
        });
      });
    } finally {
      captured.restore();
    }

    assert.equal(seen.status, 200, 'the headers were already sent when the spill failed');
    assert.equal(seen.complete, false, 'the client must see an aborted connection, never a clean end');
    assert.match(seen.error, /aborted|ECONNRESET/, `the connection must be destroyed (saw "${seen.error}")`);
    assert.ok(seen.bytes > 0, 'the client received part of the body before the failure');
    assert.ok(
      seen.bytes < BODY_BYTES,
      `the truncated body must not have arrived whole (received ${seen.bytes} of ${BODY_BYTES})`,
    );
    // Identity forwarding: what did arrive is the leading bytes of the upstream
    // body itself, so the abort is the truncation and not a re-encode.
    assert.equal(
      sha256(Buffer.concat(seen.received as Buffer[])),
      sha256(pattern.subarray(0, seen.bytes)),
      'the bytes delivered before the abort are a prefix of the upstream body',
    );

    const failureLines = captured.lines.filter((line) => line.includes('[ERROR]'));
    assert.equal(failureLines.length, 1, `exactly one failure line, got ${JSON.stringify(captured.lines)}`);
    assert.match(
      failureLines[0],
      /^\[req_\d+_[0-9a-f]{6}\] \[ERROR\] \[OUT\] \/passthrough\/v1\/messages: response stream failed after headers were sent: \[spool\] spill .* ended at \d+ of \d+ bytes$/,
    );

    assert.deepEqual(spillFiles(), [], 'the failed spill file must be gone');
    assert.equal(getLiveSpillBytes(), 0, 'the failed spill must return its reserved bytes');
    assert.equal(getActiveRequestCount(), initialActive, 'the in-flight counter must not leak');
  });

  it('stays quiet when the client hangs up mid-stream, and still cancels upstream', { timeout: 30000 }, async () => {
    const { configPath } = writeConfig();
    const env = envFor(configPath);
    const initialActive = getActiveRequestCount();

    const upstream = openSse([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'seen' }, index: 0, finish_reason: null }] })}\n\n`,
    ]);
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) await new Response(init.body as BodyInit).text();
      return new Response(upstream.stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const captured = logsDuring();
    let sawBytes = false;
    let complete: boolean | null = null;
    try {
      await withProxy(env, async (baseUrl) => {
        const url = new URL(baseUrl);
        const payload = Buffer.from(JSON.stringify({
          model: 'test',
          max_tokens: 32,
          stream: true,
          messages: [{ role: 'user', content: 'stream please' }],
        }), 'utf8');
        await new Promise<void>((resolve) => {
          const request = httpRequest({
            host: url.hostname,
            port: url.port,
            method: 'POST',
            path: '/v1/messages',
            headers: {
              'content-type': 'application/json',
              'content-length': String(payload.byteLength),
              authorization: 'Bearer client-key',
            },
          }, (incoming) => {
            incoming.once('data', () => {
              sawBytes = true;
              request.destroy();
            });
            incoming.on('close', () => {
              complete = incoming.complete;
              resolve();
            });
          });
          request.on('error', () => {});
          request.end(payload);
        });
        // Let the server observe the hang-up and unwind the pipeline.
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
    } finally {
      captured.restore();
    }

    assert.equal(sawBytes, true, 'the first event must reach the client before it hangs up');
    assert.equal(complete, false, 'the client hung up mid-response');
    assert.deepEqual(
      captured.lines.filter((line) => line.includes('[ERROR]')),
      [],
      'an abandoned connection must not be logged as a failure',
    );
    assert.equal(upstream.cancelled(), true, 'the upstream body must be cancelled, not left draining');
    assert.equal(getActiveRequestCount(), initialActive, 'the release must still run for a silent disconnect');
  });
});
