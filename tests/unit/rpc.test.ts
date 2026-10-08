/**
 * Unit tests for the JSON-RPC 2.0 control channel (src/rpc.ts).
 *
 * These assert the observable wire output — the exact JSON lines written to the
 * output sink — rather than internals, so a change to framing, error codes or
 * the notification payload shape fails here.
 *
 * Run with:
 *   npx tsx --test tests/unit/rpc.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startRpc, type RpcSource } from '../../src/rpc.js';
import { loadProxyConfigFromPath } from '../../src/utils/config-loader.js';
import type { Env } from '../../src/types/shared.js';

const GOOD_CONFIG = `
[models.claude]
upstream_mode = "anthropic-messages"
base_url = "http://localhost:3000"
fable5 = {target = "claude-fable-5"}

[composite]
"smart" = {"fable5" = {share = 10, primary = true}}

[schedule]
"dddsg" = {"fable5" = [{from = 0, to = 24}]}
`;

let tempDir: string;
let goodPath: string;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mpv3-rpc-test-'));
  goodPath = join(tempDir, 'good.toml');
  writeFileSync(goodPath, GOOD_CONFIG);
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/** A source whose loadConfig fails unless a path is given, plus a shutdown counter. */
function makeSource(overrides: Partial<RpcSource> = {}): { source: RpcSource; shutdownCalls: () => number } {
  let shutdowns = 0;
  const source: RpcSource = {
    env: { VERSION: 'test-version', PROXY_CONFIG_PATH: goodPath } as unknown as Env,
    loadConfig: async () => loadProxyConfigFromPath(goodPath),
    port: 8788,
    shutdown: () => { shutdowns += 1; },
    ...overrides,
  };
  return { source, shutdownCalls: () => shutdowns };
}

interface Collected {
  messages: Array<Record<string, unknown>>;
  lines: string[];
}

/**
 * Feed NDJSON lines into a fresh RPC session and collect what it writes back.
 * `expected` is the number of output lines to wait for before stopping.
 */
async function runRpc(
  lines: string[],
  source: RpcSource,
  { expected = lines.length, end = false, settleMs = 0 }: { expected?: number; end?: boolean; settleMs?: number } = {},
): Promise<Collected> {
  const input = new PassThrough();
  const chunks: string[] = [];
  const output = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(String(chunk));
      cb();
    },
  });

  const stop = startRpc(source, { input, output });
  for (const line of lines) input.write(`${line}\n`);
  if (end) input.end();

  const text = () => chunks.join('');
  const countLines = () => text().split('\n').filter((l) => l.length > 0).length;
  const deadline = Date.now() + 3000;
  while (countLines() < expected && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (settleMs > 0) await new Promise((r) => setTimeout(r, settleMs));
  // Let the setImmediate( shutdown ) scheduled by a shutdown request run.
  await new Promise((r) => setImmediate(r));

  stop();
  const collected = text().split('\n').filter((l) => l.length > 0);
  return { messages: collected.map((l) => JSON.parse(l) as Record<string, unknown>), lines: collected };
}

const req = (method: string, params: Record<string, unknown> = {}, id: number | string = 1): string =>
  JSON.stringify({ jsonrpc: '2.0', method, params, id });

// ---------------------------------------------------------------------------
// Framing and error paths
// ---------------------------------------------------------------------------

describe('rpc framing and errors', () => {
  it('answers malformed JSON with -32700 and a null id', async () => {
    const { source } = makeSource();
    const { messages } = await runRpc(['{not json'], source);
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0], {
      jsonrpc: '2.0',
      error: { code: -32700, message: 'Parse error' },
      id: null,
    });
  });

  it('answers valid JSON that is not a Request with -32600 and a null id', async () => {
    const { source } = makeSource();
    const { messages } = await runRpc(['123', '{"jsonrpc":"2.0"}', '[]'], source);
    assert.equal(messages.length, 3);
    for (const message of messages) {
      assert.equal((message.error as { code: number }).code, -32600);
      assert.equal(message.id, null);
    }
  });

  it('answers an unknown method with -32601 and echoes the id', async () => {
    const { source } = makeSource();
    const { messages } = await runRpc([req('does.not.exist', {}, 42)], source);
    assert.equal(messages.length, 1);
    assert.equal((messages[0].error as { code: number }).code, -32601);
    assert.equal(messages[0].id, 42);
  });

  it('maps a handler 400 to -32602 invalid params', async () => {
    const { source } = makeSource();
    // The toggle-block handler 400s without tool_name.
    const { messages } = await runRpc([req('tools.toggleBlock', {}, 7)], source);
    assert.equal(messages.length, 1);
    assert.equal((messages[0].error as { code: number }).code, -32602);
    assert.match((messages[0].error as { message: string }).message, /tool_name is required/);
    assert.equal(messages[0].id, 7);
  });

  it('ignores blank lines instead of treating them as parse errors', async () => {
    const { source } = makeSource();
    const { messages } = await runRpc(['', '   ', req('status.get', {}, 1)], source, { expected: 1 });
    assert.equal(messages.length, 1);
    assert.equal(messages[0].id, 1);
  });
});

// ---------------------------------------------------------------------------
// Methods
// ---------------------------------------------------------------------------

describe('rpc methods', () => {
  it('status.get reports the live port, version, pid and active request count', async () => {
    const { source } = makeSource();
    const { messages } = await runRpc([req('status.get', {}, 1)], source);
    const result = messages[0].result as Record<string, unknown>;
    assert.equal(result.running, true);
    assert.equal(result.port, 8788);
    assert.equal(result.version, 'test-version');
    assert.equal(result.pid, process.pid);
    assert.equal(result.activeRequests, 0);
    assert.equal(typeof result.uptimeMs, 'number');
  });

  it('models.list returns the sanitized dashboard payload', async () => {
    const { source } = makeSource();
    const { messages } = await runRpc([req('models.list', {}, 1)], source);
    const result = messages[0].result as {
      models: Record<string, unknown>;
      composite: Record<string, unknown>;
      schedule: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(result.composite), ['smart']);
    assert.deepEqual(Object.keys(result.schedule), ['dddsg']);
    assert.ok(result.models.claude, 'the configured model category must be present');
  });

  it('config.reload forces a reload and reports ok', async () => {
    const calls: Array<boolean | undefined> = [];
    const { source } = makeSource({
      loadConfig: async (forceReload?: boolean) => {
        calls.push(forceReload);
        return loadProxyConfigFromPath(goodPath);
      },
    });
    const { messages } = await runRpc([req('config.reload', {}, 1)], source);
    assert.deepEqual(calls, [true], 'reload must force the config cache to be cleared');
    assert.deepEqual(messages[0].result, { ok: true });
  });

  it('maps a config load failure to -32002', async () => {
    const { source } = makeSource({ loadConfig: async () => { throw new Error('ENOENT: no such file'); } });
    const { messages } = await runRpc([req('config.get', {}, 1)], source);
    assert.equal((messages[0].error as { code: number }).code, -32002);
    assert.match((messages[0].error as { message: string }).message, /ENOENT/);
  });

  it('shutdown replies {ok:true} and then shuts the proxy down', async () => {
    const { source, shutdownCalls } = makeSource();
    const { messages } = await runRpc([req('shutdown', {}, 9)], source);
    assert.deepEqual(messages[0], { jsonrpc: '2.0', result: { ok: true }, id: 9 });
    assert.equal(shutdownCalls(), 1);
  });

  it('answers a notification with no reply but still acts on it', async () => {
    const { source, shutdownCalls } = makeSource();
    const notification = JSON.stringify({ jsonrpc: '2.0', method: 'shutdown', params: {} });
    const { messages } = await runRpc([notification], source, { expected: 0, settleMs: 30 });
    assert.equal(messages.length, 0, 'a notification must never get a reply');
    assert.equal(shutdownCalls(), 1, 'the notification must still be acted on');
  });
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

describe('rpc lifecycle', () => {
  it('shuts the proxy down when stdin reaches EOF', async () => {
    const { source, shutdownCalls } = makeSource();
    await runRpc([], source, { end: true, expected: 0, settleMs: 30 });
    assert.equal(shutdownCalls(), 1, 'stdin EOF must prevent an orphaned proxy');
  });

  it('emits a stats.tick notification on the first poll', async () => {
    const { source } = makeSource();
    const { messages } = await runRpc([], source, { expected: 1 });
    const tick = messages.find((m) => m.method === 'stats.tick');
    assert.ok(tick, 'a stats.tick notification must be emitted');
    const params = tick.params as Record<string, unknown>;
    assert.equal(params.activeRequests, 0);
    assert.equal(typeof params.tokensTotal, 'number');
    assert.equal(params.requestsTotal, undefined, 'requestsTotal has no source and must not be emitted');
  });
});
