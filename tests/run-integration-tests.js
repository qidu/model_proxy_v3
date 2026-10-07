import { spawn, execSync } from 'child_process';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';
import readline from 'readline';
import { suites } from './integration/suites.js';

// -------------------------------------------------------------------
// Required environment variables
// -------------------------------------------------------------------
// PORT=7777        — bind the proxy to port 7777 (the test convention).
// TEST_CONFIG=test_— prefix the isolated test config file; the proxy
//                    loads ./${TEST_CONFIG}proxy_config.toml instead of
//                    ./proxy_config.toml (see src/server.ts).
// API_KEY=xxx      — bearer token the test runner uses to talk to the
//                    proxy (matches the API_KEY the proxy is started with,
//                    typically the one configured at `default_base_url`).
// These three are ALWAYS required when running tests in tests/integration/.
// PROXY_URL / TEST_TIMEOUT have sensible defaults below.
// -------------------------------------------------------------------

// Start testing proxy server WITH PORT=7777
// NEVER use 'pkill', use 'lsof -ni :7777' alternatively to find the process id (pid), then use 'kill -p ${pid}`
const PROXY_URL = process.env.PROXY_URL || 'http://localhost:7777';
const API_KEY = process.env.API_KEY || 'sk-***13145'; // set a testing api_key for models at `default_base_url`
const TEST_TIMEOUT = process.env.TEST_TIMEOUT || '30000';

// TEST_CONFIG is the prefix for the isolated test config file.
// The proxy (src/server.ts:34) reads this env var and loads
// ./${TEST_CONFIG}proxy_config.toml instead of ./proxy_config.toml.
// Always force it into process.env so every spawned child (proxy + test
// suites) sees the same isolated prefix, even if it was unset/empty.
if (!process.env.TEST_CONFIG) process.env.TEST_CONFIG = 'test_';
const TEST_CONFIG = process.env.TEST_CONFIG;
const CONFIG_PATH = `./${TEST_CONFIG}proxy_config.toml`;
const NORMAL_CONFIG_PATH = './proxy_config.toml';
const TEST_DIR = './tests/integration';

// -------------------------------------------------------------------
// Test suite registry + CLI: --list / -l
// -------------------------------------------------------------------
// The registry lives in ./integration/suites.js (shared with the loop
// wrapper) and is imported above so `--list` can print and exit *before* we
// copy the test config or spawn the proxy. Otherwise running `node
// run-integration-tests.js -l` on a stale port-7777 would crash with
// EADDRINUSE.

// Parse CLI:
//   node run-integration-tests.js            → show help
//   node run-integration-tests.js --all      → test all suites
//   node run-integration-tests.js 5          → only suites[5]
//   node run-integration-tests.js 0,3,7      → suites[0], suites[3], suites[7]
//   node run-integration-tests.js -help      → show helps and examples
//   node run-integration-tests.js -h         → shorthand for --help
function printHelp() {
  console.log('[cli] Examples:');
  console.log('  node run-integration-tests.js          # show this help');
  console.log('  node run-integration-tests.js --help   # show this help');
  console.log('  node run-integration-tests.js --list   # list all suites');
  console.log('  node run-integration-tests.js --all    # run all suites');
  console.log('  node run-integration-tests.js 5        # only suites[5]');
  console.log('  node run-integration-tests.js 0,3      # suites[0] and suites[3]');
}

if (process.argv.length <= 2 || process.argv.includes('--help') || process.argv.includes('-h')) {
  printHelp();
  process.exit(0);
}

//   node run-integration-tests.js --list     → print each suite's index + path, then exit
//   node run-integration-tests.js -l         → shorthand for --list
if (process.argv.includes('--list') || process.argv.includes('-l')) {
  console.log('[cli] Available suites:');
  const pad = String(suites.length - 1).length;
  suites.forEach((p, i) => console.log(`  ${String(i).padStart(pad, ' ')}  ${p}`));
  console.log('');
  printHelp();
  process.exit(0);
}

// -------------------------------------------------------------------
// Config isolation
// -------------------------------------------------------------------
// Copy the developer's config into the test config slot at startup.
// PUT mutations during the run stay in the test config; the original
// proxy_config.toml is never touched.
if (fs.existsSync(NORMAL_CONFIG_PATH)) {
  fs.copyFileSync(NORMAL_CONFIG_PATH, CONFIG_PATH);
  console.log(`[isolation] ${NORMAL_CONFIG_PATH} → ${CONFIG_PATH}`);
} else {
  console.warn(`[isolation] ${NORMAL_CONFIG_PATH} not found; ${CONFIG_PATH} may be stale`);
}

let configBackup = fs.existsSync(CONFIG_PATH) ? fs.readFileSync(CONFIG_PATH) : null;

function restoreConfig() {
  if (configBackup !== null) {
    try {
      fs.writeFileSync(CONFIG_PATH, configBackup);
      console.log(`[isolation] Restored ${CONFIG_PATH}`);
    } catch (err) {
      console.error(`[isolation] Failed to restore: ${err.message}`);
    }
  }
  try {
    fs.rmSync(CONFIG_PATH, { force: true });
    console.log(`[isolation] Removed ${CONFIG_PATH}`);
  } catch (err) {
    console.error(`[isolation] Failed to remove: ${err.message}`);
  }
}
process.on('exit', restoreConfig);
process.on('SIGINT', () => { restoreConfig(); process.exit(130); });
process.on('SIGTERM', () => { restoreConfig(); process.exit(143); });
process.on('uncaughtException', (err) => { console.error(err); restoreConfig(); process.exit(1); });

// -------------------------------------------------------------------
// Spawn the proxy server with TEST_CONFIG so it loads the isolated config
// -------------------------------------------------------------------
// Pre-flight: if port 7777 is already taken, the spawned child crashes
// with EADDRINUSE *inside its own process* — the parent's `child.on('error')`
// is never called, so we have to detect the busy port ourselves before
// spawning. We then prompt the user (10s timeout, default = reuse).
function isPortBusy(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const tester = net.createServer()
      .once('error', (err) => resolve(err.code === 'EADDRINUSE'))
      .once('listening', () => tester.close(() => resolve(false)))
      .listen(port, host);
  });
}

// Ask the user a question on stdin. Falls back to `defaultChoice` after
// `timeoutMs` (or immediately if stdin is not a TTY, e.g. CI).
async function promptUser(question, defaultChoice, timeoutMs) {
  if (!process.stdin.isTTY) return defaultChoice;
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    const finish = (value) => {
      if (answered) return;
      answered = true;
      clearTimeout(timer);
      rl.close();
      resolve(value);
    };
    const timer = setTimeout(() => {
      console.log(`\n[proxy] No response after ${timeoutMs / 1000}s — defaulting to '${defaultChoice}'`);
      finish(defaultChoice);
    }, timeoutMs);
    rl.question(question, (answer) => {
      finish(answer.trim().toLowerCase() || defaultChoice);
    });
  });
}

// Find pids listening on `port` via lsof and SIGTERM them. Waits up to
// 5s for the port to free. Returns true on success. Per project rules we
// use `lsof -ni` + `kill`, never `pkill`.
async function killProcessOnPort(port) {
  let pids;
  try {
    const out = execSync(`lsof -ni :${port} -t`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    pids = out.split('\n').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isInteger(n) && n > 0);
  } catch (err) {
    console.error(`[proxy] lsof failed: ${err.message}`);
    return false;
  }
  if (pids.length === 0) return !(await isPortBusy(port));
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      console.error(`[proxy] Sent SIGTERM to pid ${pid}`);
    } catch (err) {
      console.error(`[proxy] kill failed for pid ${pid}: ${err.message}`);
    }
  }
  for (let i = 0; i < 10; i++) {
    if (!(await isPortBusy(port))) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return !(await isPortBusy(port));
}

let proxy = null;
let proxyReady = false;
let proxyFailed = false;
// True when we reuse a pre-existing proxy on :7777 instead of spawning
// our own. Teardown checks this to skip reload + kill (we don't own it).
let proxyReused = false;

// Poll /v1/models for up to maxAttempts × interval ms.
// Returns true as soon as the proxy responds with 200 + a valid API_KEY.
async function waitForProxy(maxAttempts, interval = 1000) {
  for (let i = 1; i <= maxAttempts; i++) {
    if (proxyFailed) return false;
    try {
      const res = await fetch(`${PROXY_URL}/v1/models`, {
        headers: { 'Authorization': `Bearer ${API_KEY}` },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return true;
    } catch {}
    if (i < maxAttempts) await new Promise((r) => setTimeout(r, interval));
  }
  return false;
}

// If port 7777 is busy, ask the user: reuse (default after 10s) or kill.
// Returns true if we should proceed to spawn (i.e. port is free or was
// just freed by killing); sets `proxyReused`/`proxyReady` if we reused.
async function resolvePortConflict() {
  if (!(await isPortBusy(7777))) return true; // port free, proceed to spawn
  console.error('[proxy] Port 7777 is already in use.');
  console.error('[proxy] To inspect: lsof -ni :7777');
  console.error('[proxy] (NEVER use `pkill` per project rules)');
  const choice = await promptUser(
    '[proxy] [U]se existing proxy / [k]ill existing process? ',
    'u',
    10000, // 10s timeout — defaults to 'use'
  );
  if (choice === 'k') {
    console.error('[proxy] Killing process on port 7777...');
    const freed = await killProcessOnPort(7777);
    if (!freed) {
      console.error('[proxy] Failed to free port 7777; aborting.');
      console.error('[proxy] Try manually: lsof -ni :7777 → kill <pid>');
      return false;
    }
    console.error('[proxy] Port 7777 freed; will spawn a fresh proxy.');
    return true; // proceed to spawn
  }
  // 'u' (or default): try to reuse the existing process
  console.error('[proxy] Checking if existing process is a usable proxy (max 10s)...');
  const reusable = await waitForProxy(10, 1000);
  if (reusable) {
    proxyReused = true;
    proxyReady = true;
    console.log(`[proxy] Reusing existing proxy at ${PROXY_URL}`);
    return false; // no need to spawn
  }
  console.error('[proxy] Existing process on :7777 is not responding to /v1/models.');
  console.error('[proxy] Re-run and choose [k] to free the port, or manually:');
  console.error('[proxy]   lsof -ni :7777 → kill <pid>');
  return false;
}

if (await resolvePortConflict()) {
  console.log('[proxy] Starting proxy server...');
  const proxyEnv = {
    ...process.env,
    TEST_CONFIG,
    PORT: '7777',
    PROXY_URL,
    API_KEY,
    TEST_TIMEOUT,
    // 16_security/ssrf_dynamic_route.test.js exercises the dynamic-route SSRF
    // guard, which is opt-in and off by default.
    ENABLE_DYNAMIC_ROUTING: 'true',
  };

  proxy = spawn('node', ['dist/server.js'], {
    env: proxyEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // Pipe proxy stdout/stderr to this process so the user can see startup logs
  proxy.stdout.on('data', (d) => process.stdout.write(d));
  proxy.stderr.on('data', (d) => process.stderr.write(d));

  proxy.on('error', (err) => {
    console.error(`[proxy] Failed to start: ${err.message}`);
    proxyFailed = true;
  });

  proxy.on('close', (code) => {
    if (code !== 0 && !proxyReady) {
      console.error(`[proxy] Exited unexpectedly with code ${code} before tests ran`);
      proxyFailed = true;
    }
  });

  const proxyUp = await waitForProxy(30, 1000); // 30s for normal cold start
  if (!proxyUp) {
    console.error('[proxy] Timed out waiting for proxy to start');
    proxy.kill();
    restoreConfig();
    process.exit(1);
  }
  proxyReady = true;
}

// -------------------------------------------------------------------
// Set up temp directory and helpers
// -------------------------------------------------------------------
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-proxy-tests-'));

const helperFiles = ['test_helpers.js', 'model_config.js'];
const helperPaths = {};
for (const hf of helperFiles) {
  const src = path.join(TEST_DIR, 'utils', hf);
  const dst = path.join(tempDir, hf.replace('.js', '.cjs'));
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    helperPaths[hf] = dst;
  }
}

function replaceRequire(src, baseName, dstPath) {
  const escaped = dstPath.replace(/\\/g, '\\\\');
  src = src.split(`require('../utils/${baseName}')`).join(`require('${escaped}')`);
  src = src.split(`require("../utils/${baseName}")`).join(`require('${escaped}')`);
  return src;
}

const cliArg = process.argv[2];
let selectedIndices = null;
if (cliArg !== undefined && cliArg !== '--all') {
  selectedIndices = cliArg.split(',').map((s) => {
    const n = Number(s.trim());
    if (!Number.isInteger(n) || n < 0 || n >= suites.length) {
      console.error(`[cli] Invalid suite index: "${s.trim()}". Valid range: 0..${suites.length - 1}`);
      console.error('[cli] Available suites:');
      suites.forEach((p, i) => console.error(`  ${i}: ${p}`));
      restoreConfig();
      process.exit(2);
    }
    return n;
  });
  console.log(`[cli] Running ${selectedIndices.length} suite(s) by index: ${selectedIndices.join(', ')}`);
}

let passed = 0, failed = 0;

for (let i = 0; i < suites.length; i++) {
  if (selectedIndices && !selectedIndices.includes(i)) continue;
  const suite = suites[i];
  const src = fs.readFileSync(path.join(TEST_DIR, suite), 'utf8');

  let adjusted = src;
  for (const [hf, dstPath] of Object.entries(helperPaths)) {
    const baseName = hf.replace('.js', '');
    adjusted = replaceRequire(adjusted, baseName, dstPath);
  }

  const tempFile = path.join(tempDir, suite.replace('.test.js', '.test.cjs').replace('/', '_'));
  fs.writeFileSync(tempFile, adjusted);

  const child = spawn('node', [tempFile], {
    env: { ...process.env, PROXY_URL, API_KEY, TEST_TIMEOUT, TEST_CONFIG },
    stdio: 'inherit',
  });

  await new Promise((resolve) => child.on('close', (code) => {
    if (code === 0) passed++;
    else failed++;
    resolve();
  }));
}

// -------------------------------------------------------------------
// Tear down
// -------------------------------------------------------------------
try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}

if (proxyReused) {
  // The proxy on :7777 belongs to another process; do not reload its
  // config or kill it. We still restore our own test_config.toml below.
  console.log('[proxy] Skipping reload/stop — reused existing proxy at :7777');
} else {
  // Trigger a config reload in the proxy so its in-memory state clears
  // test mutations, then stop the proxy.
  try {
    await fetch(`${PROXY_URL}/dashboard/api/config?reload=1`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    console.log('[proxy] Triggered config reload');
  } catch (err) {
    console.error(`[proxy] Could not reload: ${err.message}`);
  }

  console.log('[proxy] Stopping proxy server...');
  proxy.kill('SIGTERM');

  // Wait up to 5s for the proxy to exit cleanly
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    proxy.once('close', () => { clearTimeout(timer); resolve(); });
  });
}

// Restore / remove the test config file.
restoreConfig();

console.log(`\n${'='.repeat(60)}`);
console.log(`Total: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

// -------------------------------------------------------------------
// Logs
// -------------------------------------------------------------------
// Record testing results in file `test_results_at_<date>-<time>.md` to directory `./tests/logs/results/`.
