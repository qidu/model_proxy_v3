/**
 * Phase-3 gate measurement (plan §9.2): is the full-parse transient still the
 * top allocator under inline-binary traffic after Phases 1–2?
 *
 * Run: node --expose-gc --experimental-global-webcrypto --import tsx tests/perf/parse-transient.ts
 *
 * Three measurements, one process, real modules:
 *
 *   A. The parse window itself: heap delta of `JSON.parse(bodyText)` for a
 *      body carrying one inline image — the window Phase 3 would remove.
 *   B. What §5.4 extraction leaves behind: the same body after
 *      `extractInlineBlobs`, once the parsed tree is dropped and GC has run —
 *      the refs-plus-skeleton steady state Phase 2 already reaches *after*
 *      the parse.
 *   C. End to end through the real request handler: a burst of concurrent
 *      inline-binary requests with the spool on, heap sampled at 1 ms — the
 *      peak the proxy actually reaches per concurrent exchange.
 *
 * If A ≈ C per body and both dwarf B, the parse window is still the top
 * allocator and §9.2's reopen condition is met. If C tracks B instead, Phase 2
 * already flattened the window and Phase 3 stays deferred for good.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MiB = 1 << 20;

function heapUsed(): number {
  return process.memoryUsage().heapUsed;
}

function gc(): void {
  (globalThis as unknown as { gc: () => void }).gc();
}

function fmt(bytes: number): string {
  return `${(bytes / MiB).toFixed(2)} MiB`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A /v1/chat/completions body carrying one `imageBytes`-byte inline image. */
function binaryBody(imageBytes: number, fill = 0x61): { text: string; payload: string } {
  const payload = Buffer.alloc(imageBytes, fill).toString('base64');
  const text = JSON.stringify({
    model: 'test',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${payload}` } },
      ],
    }],
  });
  return { text, payload };
}

// ---------------------------------------------------------------------------
// A. The parse window, and the serialize chain around it
// ---------------------------------------------------------------------------

async function measureParseWindow(bodyBytes: number): Promise<{ bodyBytes: number; transient: number; retained: number; withStringify: number }> {
  const { text } = binaryBody(bodyBytes);
  gc();
  const base = heapUsed();
  const parsed: unknown = JSON.parse(text);
  const transient = heapUsed() - base; // text + parsed tree both live, as in the handler
  // The handler then serializes the (mutated) body again — effective body, and
  // per-rung attempt bodies. Add one stringify to attribute that copy too.
  const reserialized = JSON.stringify(parsed);
  const withStringify = heapUsed() - base;
  void reserialized;
  gc();
  const retained = heapUsed() - base;
  void parsed;
  return { bodyBytes, transient, retained, withStringify };
}

// ---------------------------------------------------------------------------
// B. The post-extraction steady state
// ---------------------------------------------------------------------------

async function measurePostExtraction(bodyBytes: number, spoolDir: string): Promise<{ bodyBytes: number; retained: number; l1: number }> {
  const { resolveSpoolConfig, setSpoolConfig, SPOOL_DEFAULTS } = await import('../../src/utils/spool.js');
  const { extractInlineBlobs, releaseExtractedBlobs } = await import('../../src/utils/blob-refs.js');
  const { getBlobStoreStats, resetBlobStore } = await import('../../src/utils/blob-store.js');

  setSpoolConfig(resolveSpoolConfig({ enabled: true, dir: spoolDir }));
  resetBlobStore();

  const { text } = binaryBody(bodyBytes);
  const parsed = JSON.parse(text) as Record<string, unknown>;
  gc();
  const base = heapUsed();

  const extraction = await extractInlineBlobs(parsed);
  // The handler keeps the ref-bearing skeleton through dispatch; the payloads
  // are on disk (and, per §5.4's cache policy, in the bounded L1).
  const skeletonRetained = heapUsed() - base;
  const l1 = getBlobStoreStats().cacheBytes;

  releaseExtractedBlobs(extraction);
  gc();
  setSpoolConfig(SPOOL_DEFAULTS);
  resetBlobStore();
  return { bodyBytes, retained: skeletonRetained, l1 };
}

// ---------------------------------------------------------------------------
// C. End to end through the real handler
// ---------------------------------------------------------------------------

async function measureEndToEnd(bodyBytes: number, concurrency: number, spoolDir: string): Promise<{ bodyBytes: number; concurrency: number; peak: number; baseline: number }> {
  const tempDir = mkdtempSync(join(tmpdir(), 'mpv3-parse-transient-'));
  const configPath = join(tempDir, 'proxy.toml');
  writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"

[spool]
enabled = true
dir = ${JSON.stringify(spoolDir)}
threshold_bytes = 65536
`, 'utf8');

  const { default: handler } = await import('../../src/index.js');
  const { clearProxyConfigCache } = await import('../../src/utils/config-loader.js');
  const { clearModelCache } = await import('../../src/handlers/models.js');
  const { resetBlobStore } = await import('../../src/utils/blob-store.js');
  const { resetAdmission } = await import('../../src/utils/spool-admission.js');

  clearProxyConfigCache();
  clearModelCache();
  resetBlobStore();
  resetAdmission();

  const completion = JSON.stringify({
    id: 'chat-perf', object: 'chat.completion', created: 1, model: 'test',
    choices: [{ index: 0, message: { role: 'assistant', content: 'seen' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
    // Drain the request body like a real upstream would.
    const body = init?.body;
    if (typeof body !== 'string' && body) await new Response(body as BodyInit).text();
    return new Response(completion, { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;

  let peak = heapUsed();
  const sampler = setInterval(() => {
    const now = heapUsed();
    if (now > peak) peak = now;
  }, 1);

  try {
    gc();
    const baseline = heapUsed();
    peak = baseline;
    const env = { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' };
    const requests = Array.from({ length: concurrency }, (_, i) =>
      handler.fetch(
        new Request('http://proxy/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
          // A distinct payload per request: no cross-request dedupe flatters the
          // per-exchange number.
          body: binaryBody(bodyBytes, 0x61 + i).text,
        }),
        env as never,
      ),
    );
    const responses = await Promise.all(requests);
    for (const response of responses) {
      if (response.status !== 200) throw new Error(`request failed: ${response.status} ${await response.text()}`);
      await response.arrayBuffer();
    }
    return { bodyBytes, concurrency, peak, baseline };
  } finally {
    clearInterval(sampler);
    globalThis.fetch = realFetch;
    resetAdmission();
    resetBlobStore();
    clearProxyConfigCache();
    clearModelCache();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const BODY_BYTES = 4 * MiB;
const CONCURRENCY = 4;
const spoolDir = mkdtempSync(join(tmpdir(), 'mpv3-parse-transient-spool-'));

try {
  console.log(`\nPhase-3 gate measurement (§9.2) — body size ${fmt(BODY_BYTES)}, burst ${CONCURRENCY} concurrent\n`);

  const a = await measureParseWindow(BODY_BYTES);
  console.log(`A. full-parse window (one body):`);
  console.log(`     parse transient heap delta:  ${fmt(a.transient)}  (${(a.transient / a.bodyBytes).toFixed(2)}× body)`);
  console.log(`     + one re-serialize:          ${fmt(a.withStringify)}  (${(a.withStringify / a.bodyBytes).toFixed(2)}× body)`);
  console.log(`     retained after GC:           ${fmt(a.retained)}  (${(a.retained / a.bodyBytes).toFixed(2)}× body)`);

  const b = await measurePostExtraction(BODY_BYTES, spoolDir);
  console.log(`B. post-extraction steady state (one body, spool on):`);
  console.log(`     skeleton + refs retained:    ${fmt(b.retained)}  (${(b.retained / b.bodyBytes).toFixed(3)}× body)`);
  console.log(`     L1 cache holding payload:    ${fmt(b.l1)}  (bounded by l1 cap, not by concurrency)`);

  const c = await measureEndToEnd(BODY_BYTES, CONCURRENCY, spoolDir);
  const perBody = (c.peak - c.baseline) / CONCURRENCY;
  console.log(`C. end-to-end burst through the handler (${CONCURRENCY} concurrent, spool on):`);
  console.log(`     peak delta over baseline:    ${fmt(c.peak - c.baseline)}`);
  console.log(`     per concurrent exchange:     ${fmt(perBody)}  (${(perBody / c.bodyBytes).toFixed(2)}× body)`);

  console.log(`\nGate (§9.2): reopen Phase 3 iff the full-parse transient is still the top allocator.`);
  console.log(`  parse transient per body:      ${(a.transient / a.bodyBytes).toFixed(2)}× body`);
  console.log(`  end-to-end peak per body:      ${(perBody / c.bodyBytes).toFixed(2)}× body`);
  console.log(`  post-extraction steady state:  ${(b.retained / b.bodyBytes).toFixed(3)}× body`);
  console.log(`  → parse is ${(a.transient / perBody * 100).toFixed(0)}% of the per-exchange peak; the serialize/copy chain and receive buffers make up the rest.`);
} finally {
  rmSync(spoolDir, { recursive: true, force: true });
}
