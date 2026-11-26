import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

if (process.platform !== 'win32') {
  throw new Error('This end-to-end test must run on Windows');
}

if (!process.argv[2]) {
  throw new Error('Usage: node tests/integration/windows-keytar-sea.js <packaged-executable>');
}

const executable = resolve(process.argv[2]);
const packageDir = dirname(executable);
const addonPath = join(packageDir, 'keytar.node');
assert.ok(existsSync(executable), `Missing packaged executable: ${executable}`);
assert.ok(existsSync(addonPath), `Missing packaged addon: ${addonPath}`);
assert.ok(existsSync(join(packageDir, 'keytar-LICENSE.md')), 'Missing keytar license');

const keytar = createRequire(import.meta.url)(addonPath);
const service = 'model_proxy_v3';
const bundleAccount = '__api_keys_v1__';
const runId = `windows-sea-${process.pid}-${Date.now()}`;
const account = `${runId}/https://example.invalid`;
const secret = `sk-test-${process.pid}-${Date.now()}`;
const tempDir = mkdtempSync(join(tmpdir(), 'windows-keytar-sea-'));
const configPath = join(tempDir, 'proxy_config.toml');
writeFileSync(
  configPath,
  `[general]\nstore_key_in_system = true\n\n[models.ci]\nbase_url = "https://example.invalid"\n"${runId}" = { target = "${runId}", api_key = "${secret}" }\n`,
);

let active = null;

async function unusedPort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const { port } = address;
  await new Promise((resolveClose) => server.close(resolveClose));
  return port;
}

function startApp(port) {
  const child = spawn(executable, [], {
    env: { ...process.env, PORT: String(port), PROXY_CONFIG_PATH: configPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  active = { child, output: () => output };
  return active;
}

async function stopApp() {
  if (!active) return;
  const { child } = active;
  active = null;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill();
  await Promise.race([
    exited,
    delay(10_000, undefined, { ref: false }).then(() => { throw new Error('Packaged executable did not stop within 10 seconds'); }),
  ]);
}

async function waitForConfigRewrite(run) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (run.child.exitCode !== null) {
      throw new Error(`Executable exited before storing the credential:\n${run.output()}`);
    }
    if (readFileSync(configPath, 'utf8').includes('__STORE_KEY_IN_SYSTEM__')) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for config sentinel rewrite:\n${run.output()}`);
}

async function waitForDashboard(run, port) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    if (run.child.exitCode !== null) {
      throw new Error(`Executable exited before serving the dashboard:\n${run.output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/dashboard/api/config`);
      if (response.ok) return await response.json();
      lastError = new Error(`Dashboard returned HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for dashboard: ${lastError}\n${run.output()}`);
}

function assertResolved(payload) {
  assert.equal(payload.config.api_keys_in_system_store, true, 'Credential was not resolved from the system store');
  assert.deepEqual(payload.config.config_errors, [], 'Config load reported credential errors');
  assert.ok(!JSON.stringify(payload).includes(secret), 'Dashboard exposed the test credential');
}

async function removeTestCredential() {
  const serialized = await keytar.getPassword(service, bundleAccount);
  if (serialized === null) return;
  const bundle = JSON.parse(serialized);
  delete bundle[account];
  if (Object.keys(bundle).length === 0) {
    await keytar.deletePassword(service, bundleAccount);
  } else {
    await keytar.setPassword(service, bundleAccount, JSON.stringify(bundle));
  }
}

try {
  const port = await unusedPort();

  let run = startApp(port);
  await waitForConfigRewrite(run);
  assertResolved(await waitForDashboard(run, port));
  assert.ok(!readFileSync(configPath, 'utf8').includes(secret), 'Plaintext credential remained in the config');
  const serialized = await keytar.getPassword(service, bundleAccount);
  assert.ok(serialized, 'Packaged app did not create a Credential Vault bundle');
  const stored = JSON.parse(serialized);
  assert.equal(stored[account], secret, 'Packaged app did not store the credential in Credential Vault');
  await stopApp();

  run = startApp(port);
  assertResolved(await waitForDashboard(run, port));
  await stopApp();
} finally {
  await stopApp();
  await removeTestCredential();
  rmSync(tempDir, { recursive: true, force: true });
}

const remaining = await keytar.getPassword(service, bundleAccount);
assert.ok(remaining === null || JSON.parse(remaining)[account] === undefined, 'Test credential was not deleted');
console.log('Windows Credential Vault package test passed: store, restart/retrieve, delete');
