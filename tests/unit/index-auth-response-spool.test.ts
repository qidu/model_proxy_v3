/**
 * Unit tests for the §5.7 bound on the remote auth server's response body
 * (`src/index.ts`, `doAuthRequest`).
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.7, §5.9.
 *
 * `doAuthRequest` read that body with `await authResp.text()` — the last
 * unbounded remote-body read in `src/index.ts`. Everything downstream of it
 * (the 401 reason, the wire-contract `version` gate, the `targets[]` ladder) is
 * unchanged; what changes is that the body is received through
 * `receiveResponseBody` like every other remote body this file reads, so
 * `max_response_bytes` bounds it and a breach cancels the body instead of
 * buffering it whole.
 *
 * What these tests pin, and why each assertion is worth its space:
 *  - a body under the cap is read and used exactly as before — the request
 *    still succeeds and the client still receives the upstream's bytes
 *    verbatim (the spool must not change an answer);
 *  - a body past `max_response_bytes` fails explicitly as a 500
 *    `processing_error` naming the response cap, cancels the auth body, leaves
 *    no spill file behind, and never reaches the upstream. Crucially it is
 *    *not* the 503 "Authentication service unavailable: could not reach remote
 *    auth server" that the surrounding `catch` produces — the fetch and the
 *    body read are separate `try` blocks for exactly that reason (rule #8: a
 *    proxy-side limit must not be reported as the auth server being down);
 *  - the cap applies with `[spool] enabled = false` too. This is the
 *    repository's stated rule (CHANGELOG: `max_response_bytes` bounds the body;
 *    `enabled` only decides whether disk is used), applied here as on the other
 *    egresses. It is asserted rather than assumed so that a future change of
 *    that rule fails here loudly;
 *  - a §5.9 refusal is reported as itself (503 `over_limit_error`) and names the
 *    *auth* body's byte count, which is what distinguishes it from the ingress
 *    body's own admission a few lines later in the same request;
 *  - the auth body is never written to the log, not even with trace on. This is
 *    the one place the read deliberately does *not* go through
 *    `withResponseText`: that primitive's trace stage echoes the text it
 *    receives, and this body carries `targets[].key`/`otac` — upstream
 *    credentials (see `src/utils/target-retry.ts`). The `key` field is
 *    documented here rather than exercised, because a `targets[]` entry is
 *    validated and then used as a routing ladder; a marker planted in it would
 *    change what the request does and the point of the test is the log.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { getAdmittedBytes } from '../../src/utils/spool-admission.js';
import { RESPONSE_SPILL_SUBDIR } from '../../src/utils/spool.js';

const realFetch = globalThis.fetch;
const realLog = console.log;

const AUTH_URL = 'https://auth.example.test/validate';
const UPSTREAM_URL = 'https://api.example.test/v1/messages';

/** The upstream's own answer; the client must receive these exact bytes. */
const UPSTREAM_BODY = JSON.stringify({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  content: [{ type: 'text', text: 'ok' }],
  model: 'claude-sonnet-4-6',
  stop_reason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

/** A scratch spool root plus a config file that points `[spool]` at it. */
function makeConfig(spoolOverrides: string[]): { configPath: string; spoolDir: string } {
  const spoolDir = mkdtempSync(join(tmpdir(), 'auth-response-spool-'));
  scratchDirs.push(spoolDir);
  const configPath = join(tmpdir(), `proxy_auth_spool_${Date.now()}_${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(
    configPath,
    `
[dashboard]
api_key = "dash"

[remote]
auth_server = "${AUTH_URL}"

[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.example.test"
api_key = "sk-test"
"claude-*" = {}

[spool]
dir = "${spoolDir}"
${spoolOverrides.join('\n')}
`,
    'utf-8',
  );
  return { configPath, spoolDir };
}

function makeRequest(): Request {
  return new Request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-key' },
    body: JSON.stringify({ model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
  });
}

type Recorded = { authCalls: number; upstreamCalls: number; authBodies: string[] };

/**
 * Install a fetch mock: `authUrl` answers `authResponse`, anything else is the
 * upstream model call. Every call is counted, so "the upstream was never
 * reached" is assertable rather than inferred.
 */
function installMockFetch(authResponse: () => Response): Recorded {
  const recorded: Recorded = { authCalls: 0, upstreamCalls: 0, authBodies: [] };
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    if (url === AUTH_URL) {
      recorded.authCalls += 1;
      return authResponse();
    }
    recorded.upstreamCalls += 1;
    assert.ok(url.startsWith('https://api.example.test'), `unexpected upstream url: ${url}`);
    return new Response(UPSTREAM_BODY, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return recorded;
}

/** Spill files still on disk under the configured `[spool] dir`. */
function spillFiles(spoolDir: string): string[] {
  const dir = join(spoolDir, RESPONSE_SPILL_SUBDIR);
  return existsSync(dir) ? readdirSync(dir) : [];
}

const configPaths: string[] = [];

before(() => { clearProxyConfigCache(); });

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = realLog;
  clearProxyConfigCache();
  // Both ledgers are process-wide: a leak here would silently weaken later tests.
  assert.equal(getLiveSpillBytes(), 0, 'every spool must return its reservation');
  assert.equal(getAdmittedBytes(), 0, 'every §5.9 lease must be released');
});

after(() => {
  for (const p of configPaths) {
    try { unlinkSync(p); } catch { /* already gone */ }
  }
  for (const dir of scratchDirs) {
    try { chmodSync(dir, 0o700); } catch { /* already writable or already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

function trackConfig(configPath: string): string {
  configPaths.push(configPath);
  return configPath;
}

const ENV = (configPath: string, logLevel = 'error') => ({ PROXY_CONFIG_PATH: configPath, LOG_LEVEL: logLevel }) as never;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('auth response body under the cap', () => {
  it('is read as before: the request succeeds and the upstream bytes reach the client unchanged', async () => {
    const { configPath, spoolDir } = makeConfig([
      'enabled = true',
      'threshold_bytes = 64',
      'max_response_bytes = 65536',
    ]);
    trackConfig(configPath);
    const recorded = installMockFetch(() => new Response(
      JSON.stringify({ version: 'v1' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    const resp = await handler.fetch(makeRequest(), ENV(configPath));
    const body = await resp.text();

    assert.equal(resp.status, 200);
    assert.equal(body, UPSTREAM_BODY, 'the spool must not change the bytes the client receives');
    assert.equal(recorded.authCalls, 1);
    assert.equal(recorded.upstreamCalls, 1);
    assert.deepEqual(spillFiles(spoolDir), [], 'the auth body and the upstream body are both released');
  });

  it('still gates on the wire-contract version it read from that body', async () => {
    const { configPath } = makeConfig(['enabled = true', 'threshold_bytes = 64', 'max_response_bytes = 65536']);
    trackConfig(configPath);
    const recorded = installMockFetch(() => new Response(
      JSON.stringify({ targets: [] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    const resp = await handler.fetch(makeRequest(), ENV(configPath));

    assert.equal(resp.status, 401, 'a 200 body with no `version` is still rejected');
    const body = JSON.parse(await resp.text());
    assert.match(body.error.message, /missing the required "version" field/);
    assert.equal(recorded.upstreamCalls, 0);
  });
});

describe('auth response body past max_response_bytes', () => {
  const AUTH_BODY = JSON.stringify({ version: 'v1', padding: 'x'.repeat(4096) });

  it('fails explicitly as a 500 processing_error naming the response cap, not as an unreachable auth server', async () => {
    const { configPath, spoolDir } = makeConfig([
      'enabled = true',
      'threshold_bytes = 64',
      'max_response_bytes = 512',
    ]);
    trackConfig(configPath);
    const recorded = installMockFetch(() => new Response(AUTH_BODY, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const resp = await handler.fetch(makeRequest(), ENV(configPath));
    const body = JSON.parse(await resp.text());

    assert.equal(resp.status, 500);
    assert.equal(body.error.type, 'processing_error');
    assert.match(body.error.message, /Response body too large/);
    assert.match(body.error.message, /exceeded 512 bytes/);
    assert.doesNotMatch(
      body.error.message,
      /unavailable|could not reach remote auth server/,
      'a proxy-side limit must never be reported as the auth server being down (rule #8)',
    );
    assert.equal(recorded.upstreamCalls, 0, 'the request must not proceed past a failed auth read');
    assert.deepEqual(spillFiles(spoolDir), [], 'a breach leaves no partial spill behind');
  });

  it('applies the cap with [spool] enabled = false too', async () => {
    const { configPath, spoolDir } = makeConfig([
      'enabled = false',
      'max_response_bytes = 512',
    ]);
    trackConfig(configPath);
    const recorded = installMockFetch(() => new Response(AUTH_BODY, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const resp = await handler.fetch(makeRequest(), ENV(configPath));
    const body = JSON.parse(await resp.text());

    assert.equal(resp.status, 500, '`enabled` decides whether disk is used, not whether the body is bounded');
    assert.equal(body.error.type, 'processing_error');
    assert.match(body.error.message, /Response body too large/);
    assert.equal(recorded.upstreamCalls, 0);
    assert.deepEqual(spillFiles(spoolDir), []);
  });
});

describe('§5.9 refusal on the auth read', () => {
  it('is reported as itself, charged the auth body\'s own byte count', async () => {
    const { configPath } = makeConfig([
      'enabled = true',
      'threshold_bytes = 64',
      'max_response_bytes = 65536',
      // Below the auth body × materialization_factor (2.0), so the auth read is
      // what the budget refuses — the ingress body a few lines later is ~90
      // bytes and would have fit.
      'max_materialized_body_bytes = 512',
    ]);
    trackConfig(configPath);
    const authBody = JSON.stringify({ version: 'v1', padding: 'y'.repeat(400) });
    const recorded = installMockFetch(() => new Response(authBody, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));

    const resp = await handler.fetch(makeRequest(), ENV(configPath));
    const body = JSON.parse(await resp.text());

    assert.equal(resp.status, 503);
    assert.equal(body.error.type, 'over_limit_error');
    assert.match(
      body.error.message,
      new RegExp(`\\(${Buffer.byteLength(authBody)} × `),
      'the refusal must name the auth body\'s own byte count, not the ingress body\'s',
    );
    assert.equal(recorded.upstreamCalls, 0);
    assert.equal(getAdmittedBytes(), 0, 'a refusal must hold no reservation');
  });
});

describe('the auth body is never logged', () => {
  it('stays out of the trace output even with trace on, while other pipeline bodies are logged', async () => {
    const { configPath } = makeConfig(['enabled = true', 'threshold_bytes = 64', 'max_response_bytes = 65536']);
    trackConfig(configPath);
    installMockFetch(() => new Response(
      JSON.stringify({ version: 'v1', note: 'AUTH-BODY-SECRET-MARKER' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    const lines: string[] = [];
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };

    const request = new Request('http://localhost/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-key' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        messages: [{ role: 'user', content: 'CLIENT-BODY-MARKER' }],
        max_tokens: 10,
      }),
    });
    const resp = await handler.fetch(request, ENV(configPath, 'trace'));
    assert.equal(resp.status, 200);
    // Drain the client response before the ledger check in `afterEach`: the
    // upstream body's spool reservation is returned as the stream is read, so
    // an unread response would leave it live and fail the next test's hook, not
    // this test's assertions.
    const upstreamBytes = await resp.text();
    assert.equal(upstreamBytes, UPSTREAM_BODY, 'the response itself is untouched by the auth read');

    const logged = lines.join('\n');
    // Positive control: trace really is on for this request and pipeline bodies
    // really are echoed, so the absence below is a property of the auth read and
    // not a dead capture.
    assert.match(logged, /CLIENT-BODY-MARKER/, 'the inbound body is echoed at trace, so the capture works');
    assert.doesNotMatch(logged, /AUTH-BODY-SECRET-MARKER/, 'the auth response body must not be echoed');
  });
});
