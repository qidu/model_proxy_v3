#!/usr/bin/env node
/**
 * Standalone mock auth + stats sidecar for manual proxy testing.
 *
 * Implements the wire contract in docs/auth-stats-protocol.md so a proxy
 * configured with a `[remote]` auth_server / record_server can be driven
 * end-to-end without a real backend.
 *
 *   /v1/validate  (GET or POST)     → validates the CLIENT's original key (the
 *                                 one the proxy forwards under
 *                                 `auth_passthrough_with = "user_key"`) against
 *                                 the MOCK_USER_KEYS allowlist. A key matching
 *                                 none → 401. On success: 200 +
 *                                 `one_time_auth_code` header + a
 *                                 `{ targets: [...] }` failover ladder (see
 *                                 mock_targets.json). The request body's `model`
 *                                 then selects the ladder: rungs whose `alias`
 *                                 equals it win, else no targets are returned.
 *                                 (or MOCK_AUTH_STATUS to force a rejection).
 *   /v1/model-usage (POST)          → logs the ModelUsageRecordPayload, 200.
 *
 * The /v1/validate 200 response carries a `version` field (PROTOCOL_VERSION)
 * advertising the wire-contract era. The /v1/model-usage 200 body does not: the
 * proxy ignores the stats response body entirely.
 *
 * Everything the proxy sends (forwarded headers, usage record) is printed to
 * stdout so you can eyeball the exact on-the-wire shape. The /v1/validate request
 * body and the record's `response_body` are hidden — only their type/length is
 * shown.
 *
 * Run:
 *   node tests/scripts/mock-auth-stats-server.js
 *
 * Env:
 *   MOCK_HOST          bind host          (default 127.0.0.1)
 *   MOCK_PORT          bind port          (default 8989)
 *   MOCK_AUTH_STATUS   status for /v1/validate (default 200; e.g. 401 to test the
 *                      proxy's rejection path)
 *   MOCK_TARGETS_JSON  inline JSON array overriding mock_targets.json
 *   MOCK_USER_KEYS     comma-separated client-key allowlist /v1/validate accepts
 *                      (default "*" — any key). A key matching none → 401.
 *
 * NOTE on rung hosts: a ladder entry's `base` host is NOT validated against the
 * proxy's allowed-hosts set — the auth server is a trusted routing authority,
 * so a rung may target any well-formed host (only the `base` URL syntax is
 * checked). Invalid entries (missing/invalid `target`/`base`, bad `mode`, …) are
 * dropped and the proxy logs them at ERROR.
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

const HOST = process.env.MOCK_HOST || '127.0.0.1';
const PORT = Number(process.env.MOCK_PORT || 8989);
const AUTH_STATUS = Number(process.env.MOCK_AUTH_STATUS || 200);

// Wire-contract version advertised on the /v1/validate 200 response, so a
// caller can tell which era of the auth/stats contract the sidecar speaks.
const PROTOCOL_VERSION = 'v1';

// Allowlist of client keys /v1/validate accepts. The proxy forwards the CLIENT's
// original key (auth_passthrough_with = "user_key"), so this is the credential a
// real auth backend would check against its key store. A presented key matching
// none → 401. Override with e.g. MOCK_USER_KEYS="sk-test,sk-other".
const USER_KEYS = (process.env.MOCK_USER_KEYS || '*')
  .split(',')
  .map(k => k.trim())
  .filter(Boolean);

// "*" means allow-all: accept any presented key without consulting the list.
const ALLOW_ALL_KEYS = USER_KEYS.includes('*');

// Failover ladder served by /v1/validate, loaded from mock_targets.json (next to
// this script). Each rung carries an `alias`: the model name a client requests to
// be routed to that rung. When the request body's `model` equals an alias, only
// that alias's rungs are served; with no match (or no model in the request) no
// rungs are served. The proxy tries rung 0 first and advances down the list on a
// retryable upstream failure. This is a standalone test server — no key store is
// involved — so a rung's `key`, if present, is sent upstream verbatim and must be
// a real upstream key (omit `key` to forward the caller's credential instead).
//
// mock_targets.json example — an array of rungs; only target/base are required:
//   [
//     {
//       "alias": "code-small",            // client model name that selects this rung
//       "target": "vendor/model-id",      // upstream model id sent as `model`
//       "base": "https://host/api/v1",    // upstream base URL
//       "mode": "openai-completions",     // upstream mode (default openai-completions)
//       "key": "sk-...",                  // upstream key; omit to forward the caller's
//       "otac": "otac_...",               // per-rung one_time_auth_code override
//       "transforms": "set_a,set_b",      // [transforms.*] sets applied to the rung
//       "timeout": 20000,                 // whole-request abort deadline (ms)
//       "retry_on": [429, 503],           // statuses that re-hit this SAME rung
//       "retry": 2                        // max same-rung retries (overrides [remote] max_target_retries)
//     }
//   ]
const TARGETS_FILE = new URL('./mock_targets.json', import.meta.url);

let targets;
try {
  targets = JSON.parse(readFileSync(TARGETS_FILE, 'utf8'));
} catch (err) {
  console.error(`[mock] cannot load ${TARGETS_FILE.pathname}: ${err.message}`);
  process.exit(1);
}

// MOCK_TARGETS_JSON (an inline JSON array) overrides the file — handy for one-off
// ladders without editing mock_targets.json.
if (process.env.MOCK_TARGETS_JSON) {
  try {
    targets = JSON.parse(process.env.MOCK_TARGETS_JSON);
  } catch (err) {
    console.error(`[mock] MOCK_TARGETS_JSON is not valid JSON: ${err.message}`);
    process.exit(1);
  }
}

const AUTH_HEADERS_LOG = [
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'user-agent',
  'request_id',
  'endpoint',
  'x-resource-for',
  'x-forwarded-for',
  'x-real-ip',
  'content-type',
];

function ts() {
  return new Date().toISOString();
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body, null, 2);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(text);
}

function logForwardedHeaders(req) {
  for (const name of AUTH_HEADERS_LOG) {
    const value = req.headers[name];
    if (value !== undefined) console.log(`    ${name}: ${value}`);
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Read the client's original key back off the forwarded credential headers
// (auth_passthrough_with = "user_key"). Precedence mirrors the proxy's own
// header set: x-api-key, then a Bearer Authorization, then x-goog-api-key.
function readClientKey(req) {
  const xApiKey = req.headers['x-api-key'];
  if (typeof xApiKey === 'string' && xApiKey.trim()) return xApiKey.trim();

  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.replace(/^bearer\s+/i, '').trim()) {
    return auth.replace(/^bearer\s+/i, '').trim();
  }

  const goog = req.headers['x-goog-api-key'];
  if (typeof goog === 'string' && goog.trim()) return goog.trim();

  return undefined;
}

function maskKey(key) {
  if (!key) return '(none)';
  return key.length > 8 ? `${key.slice(0, 8)}...` : '***';
}

// Pick the rungs to serve. When `model` equals a rung's `alias`, only that
// alias's rungs are returned; otherwise the result is empty (no ladder), so the
// proxy falls back to normal config resolution. Returned rungs have the
// mock-only `alias` field stripped — the proxy contract only knows
// target/base/mode/key/… .
function selectRungs(model) {
  if (!model) return { rungs: [], note: 'no model in request' };
  const matched = targets.filter(rung => rung.alias === model);
  const note = matched.length ? `alias '${model}'` : `no alias '${model}'`;
  return { rungs: matched.map(({ alias, ...rung }) => rung), note };
}

async function handleValidate(req, res) {
  const rawBody = req.method === 'POST' ? await readBody(req) : '';
  const parsedBody = parseJson(rawBody);

  console.log(`\n[${ts()}] ── /v1/validate  ${req.method} ─────────────────────────────`);
  console.log('  forwarded headers:');
  logForwardedHeaders(req);
  if (parsedBody !== undefined) {
    console.log(`  body.model: ${parsedBody.model ?? '(none)'}`);
    console.log(`  body: (hidden, ${rawBody.length} chars)`);
  } else if (rawBody) {
    console.log(`  body: (hidden, non-JSON, ${rawBody.length} chars)`);
  } else {
    console.log('  body: (none)');
  }

  if (AUTH_STATUS !== 200) {
    console.log(`  → rejecting with ${AUTH_STATUS}`);
    sendJson(res, AUTH_STATUS, { error: { message: `mock rejection (HTTP ${AUTH_STATUS})` } });
    return;
  }

  const clientKey = readClientKey(req);
  if (!ALLOW_ALL_KEYS && (!clientKey || !USER_KEYS.includes(clientKey))) {
    const shown = clientKey ? `'${maskKey(clientKey)}'` : '(none)';
    console.log(`  → rejecting with 401 (client key ${shown} not in MOCK_USER_KEYS allowlist)`);
    sendJson(res, 401, { error: { message: 'invalid API key (mock user-key allowlist)' } });
    return;
  }

  const { rungs, note } = selectRungs(parsedBody?.model);
  const otac = `otac_${randomUUID()}`;
  console.log(`  → 200, key '${maskKey(clientKey)}' accepted, one_time_auth_code=${otac}, targets=${rungs.length} rung(s) [${note}]`);
  for (const [i, rung] of rungs.entries()) {
    console.log(`      rung[${i}] target=${rung.target} base=${rung.base} mode=${rung.mode ?? '(default)'} key=${rung.key ? maskKey(rung.key) : '(passthrough)'} timeout=${rung.timeout ?? '(default)'} retry=${rung.retry ?? '(config default)'}`);
  }
  sendJson(res, 200, { version: PROTOCOL_VERSION, targets: rungs }, { one_time_auth_code: otac });
}

async function handleModelUsage(req, res) {
  const rawBody = await readBody(req);
  const payload = parseJson(rawBody);

  console.log(`\n[${ts()}] ── /v1/model-usage  ${req.method} ───────────────────────────`);
  console.log(`  one_time_auth_code: ${req.headers['one_time_auth_code'] || '(none)'}`);
  if (req.headers['x-forwarded-for']) console.log(`  x-forwarded-for: ${req.headers['x-forwarded-for']}`);
  if (req.headers['x-real-ip']) console.log(`  x-real-ip: ${req.headers['x-real-ip']}`);

  if (payload === undefined) {
    console.log(`  body (non-JSON): ${rawBody.slice(0, 400)}`);
  } else {
    const { response_body, ...rest } = payload;
    console.log(`  version: ${payload.version ?? '(none)'}`);
    console.log(`  record: ${JSON.stringify(rest)}`);
    if (response_body !== undefined) {
      const size = typeof response_body === 'string'
        ? `${response_body.length} chars`
        : `${JSON.stringify(response_body).length} bytes`;
      console.log(`  response_body: (hidden, ${typeof response_body}, ${size})`);
    }
  }

  sendJson(res, 200, { ok: true });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || HOST}`);
  const route = url.pathname;

  if (route === '/v1/validate') {
    handleValidate(req, res).catch(err => {
      console.error(`[mock] /v1/validate error: ${err.stack || err}`);
      sendJson(res, 500, { error: { message: String(err) } });
    });
    return;
  }

  if (route === '/v1/model-usage') {
    handleModelUsage(req, res).catch(err => {
      console.error(`[mock] /v1/model-usage error: ${err.stack || err}`);
      sendJson(res, 500, { error: { message: String(err) } });
    });
    return;
  }

  console.log(`\n[${ts()}] ── ${req.method} ${route} → 404`);
  sendJson(res, 404, { error: { message: `no mock route for ${route}` } });
});

server.listen(PORT, HOST, () => {
  console.log('════════════════════════════════════════════════════════════');
  console.log(`mock auth + stats sidecar listening on http://${HOST}:${PORT}`);
  console.log('  POST/GET /v1/validate     client-key check → 200 + OTAC + targets[]');
  console.log('  POST     /v1/model-usage  usage record → 200');
  console.log(`  MOCK_AUTH_STATUS=${AUTH_STATUS}  targets=${targets.length}`);
  console.log(`  accepted client keys: ${ALLOW_ALL_KEYS ? '(any — "*")' : (USER_KEYS.join(', ') || '(none — all 401)')}`);
  console.log('────────────────────────────────────────────────────────────');
  console.log('Proxy config (note: BOTH http — one process cannot be https and');
  console.log('http on the same port):');
  console.log('');
  console.log('  [remote]');
  console.log(`  auth_server = "http://${HOST}:${PORT}/v1/validate"`);
  console.log('  auth_with_body = true');
  console.log('  auth_passthrough_with = "user_key"');
  console.log('  auth_with_model = true');
  console.log(`  record_server = "http://${HOST}:${PORT}/v1/model-usage"`);
  console.log('  record_response_body = true');
  console.log('');
  console.log(`Send the client key as x-api-key (or Authorization: Bearer) — it is`);
  console.log(ALLOW_ALL_KEYS
    ? 'accepted without an allowlist check (MOCK_USER_KEYS="*").'
    : `checked against MOCK_USER_KEYS=${process.env.MOCK_USER_KEYS || '*'}.`);
  console.log('Ladder rung hosts are not allowlist-checked — any well-formed base');
  console.log('URL is accepted. Edit tests/scripts/mock_targets.json to change the');
  console.log('ladder (MOCK_TARGETS_JSON overrides it inline).');
  console.log('════════════════════════════════════════════════════════════');

  for (const rung of targets) {
    const keyDisplay = rung.key ? maskKey(rung.key) : '(passthrough)';
    console.log(`  rung: alias=${rung.alias ?? '(none)'} target=${rung.target} base=${rung.base} mode=${rung.mode ?? '(default)'} key=${keyDisplay} timeout=${rung.timeout ?? '(default)'} retry=${rung.retry ?? '(config default)'}`);
  }
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n[mock] ${sig} received, shutting down.`);
    server.close(() => process.exit(0));
  });
}
