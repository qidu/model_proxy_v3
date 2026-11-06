/**
 * §12 measurement: what the spool buys, per window, before and after.
 *
 * Run: node --expose-gc --experimental-global-webcrypto --import tsx tests/perf/spool-memory.ts
 *
 * The plan's evidence line asks for "before/after memory and latency numbers for
 * slow upload, upstream request send, downstream JSON response, and
 * long/large-event SSE response". "Before" is the same build with
 * `[spool] enabled = false` — §9.1's contract is that a disabled spool is the
 * pre-spool path (`receiveSpooledBody`'s `spillable = config.enabled`, and every
 * extraction and admission site gates on it), so the toggle isolates the change
 * without a second checkout to build.
 *
 * Measured is `heapUsed + arrayBuffers`, always *after a forced collection*, at
 * named window boundaries. Both halves of that matter:
 *
 *  - `heapUsed` alone misses the base64 `Buffer`s — in Node those live outside
 *    the V8 heap, and this change is mostly about them — while RSS is dominated
 *    by GC timing and allocator retention (§7).
 *  - a 1 ms *sampler* of allocated bytes is the wrong instrument, and this
 *    harness used one until it produced a false result. Every simulated stream
 *    here allocates a chunk per pull, and `arrayBuffers` counts a backing store
 *    until a collection reclaims it, so the sampler read the harness's own
 *    garbage as if the proxy were holding it (a flat ~12 MiB "floor" in both
 *    modes), while a real but sub-millisecond spike was aliased away entirely:
 *    with the spool off, 63.87 MiB was live at the send boundary yet the sampler
 *    never saw more than 13.90 MiB, and with the spool on the same spike did
 *    last a few samples, which is how the spool came to be reported as 639 %
 *    *worse*. Collecting first and reading points instead measures what the
 *    request actually holds.
 *
 * What that cannot see: a transient *between* two checkpoints, released before
 * the next one is taken. §7 expects exactly there to be no change — the full
 * parse still peaks at O(N×B), and the spool buys bounded streaming outside it —
 * so the windows are the claim, and the parse-time transient is not one.
 *
 * Every checkpoint forces a collection, so a window's wall clock includes it
 * (a few ms). Both modes pay it, and the upload window contains no checkpoint of
 * its own, so it is the clean latency figure.
 *
 * Every deliberate slowness is byte-proportional — a simulated bandwidth, not a
 * delay per chunk — so a path that happens to emit more, smaller chunks does not
 * read as slower than the same bytes in fewer chunks.
 *
 * A scenario with an 8 MiB *inline image* and one with the same number of bytes
 * as *non-allowlisted text* are both here (§7 asks for the non-allowlisted case
 * separately): the pair separates "the spool carries the same bytes
 * differently" from "the spool extracted an allowlisted payload", which is the
 * only way to attribute a window that moves in the wrong direction.
 *
 * The harness's own fixtures are live copies in both modes — one reused upload
 * slice, one response string — so they cancel in each comparison while making
 * the absolute figures an upper bound.
 *
 * Not measured here: per-payload-family response bodies (Gemini `inlineData`,
 * Responses generated images), full-parse concurrency, and p50/p95/p99 latency.
 * Those are the next §12 lines, not this one.
 *
 * The numbers are evidence, not a gate: this script is not part of
 * `npm run test:unit`. It does fail loudly (non-zero exit) when a request does
 * not succeed, when a run leaves spill bytes behind, when a window was never
 * reached, or when the upload window with the spool on is not smaller than with
 * it off — the one shape Phase 1 promises. A *later* window that is larger with
 * the spool on is printed as a `worse` line and explained rather than gated: the
 * plan buys bounded streaming outside the parse, not a smaller full-parse peak
 * (§7).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MiB = 1 << 20;

/** Heap plus external buffers — the base64 payloads are not on the V8 heap. */
function used(): number {
  const { heapUsed, arrayBuffers } = process.memoryUsage();
  return heapUsed + arrayBuffers;
}

/** Live bytes: buffers nothing can reach any more are dropped first. */
function live(): number {
  (globalThis as unknown as { gc: () => void }).gc();
  return used();
}

function fmt(bytes: number): string {
  return `${(bytes / MiB).toFixed(2)} MiB`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The unit a simulated link is specified in: `perChunkMs` per 64 KiB. */
const SIM_UNIT = 64 * 1024;

function simDelay(bytes: number, perChunkMs: number): Promise<void> {
  if (perChunkMs <= 0) return Promise.resolve();
  const ms = Math.round((bytes / SIM_UNIT) * perChunkMs);
  return ms > 0 ? sleep(ms) : Promise.resolve();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A multiple of 3, so base64 slices concatenate into one valid payload. */
const SLICE_BYTES = 65_472;
/** The plan's unit `B`: one raw image. */
const IMAGE_BYTES = 8 * MiB;
const RESPONSE_BYTES = 8 * MiB;
const SSE_EVENTS = 100;
const SSE_EVENT_BYTES = 256 * 1024;

const IMAGE_SLICE = Buffer.alloc(SLICE_BYTES, 0x61).toString('base64');
const TEXT_SLICE = 'a'.repeat(SLICE_BYTES);

const IMAGE_PREFIX = `{"model":"test","messages":[{"role":"user","content":[{"type":"text","text":"describe"},{"type":"image_url","image_url":{"url":"data:image/png;base64,`;
const IMAGE_SUFFIX = `"}}]}],"max_tokens":8}`;
const TEXT_PREFIX = `{"model":"test","messages":[{"role":"user","content":"`;
const TEXT_SUFFIX = `"}],"max_tokens":8}`;

/**
 * The image's base64 body on the wire, and the same number of bytes again as
 * plain text: matched wire sizes are what make the pair a control, so the text
 * filler is trimmed to a whole number of its own slices rather than left at a
 * round MiB.
 */
const IMAGE_FILLER = Math.ceil((IMAGE_BYTES * 4) / 3 / IMAGE_SLICE.length) * IMAGE_SLICE.length;
const TEXT_FILLER = Math.floor(IMAGE_FILLER / TEXT_SLICE.length) * TEXT_SLICE.length;

interface Upload {
  name: string;
  prefix: string;
  slice: string;
  /** Bytes of filler sent, a whole number of slices. */
  fillerBytes: number;
  suffix: string;
}

const IMAGE_UPLOAD: Upload = {
  name: `8 MiB inline image (${fmt(IMAGE_FILLER)} of base64 on the wire)`,
  prefix: IMAGE_PREFIX,
  slice: IMAGE_SLICE,
  fillerBytes: IMAGE_FILLER,
  suffix: IMAGE_SUFFIX,
};

const TEXT_UPLOAD: Upload = {
  name: `non-allowlisted text body (${fmt(TEXT_FILLER)} on the wire)`,
  prefix: TEXT_PREFIX,
  slice: TEXT_SLICE,
  fillerBytes: TEXT_FILLER,
  suffix: TEXT_SUFFIX,
};

/**
 * A streamed JSON body, one slice per pull. The filler is emitted from a single
 * reused slice — the whole body is never a string in this process, or the
 * harness's own copy would sit in both modes' windows and flatten the difference
 * it is measuring. `mark` fires once, when the last piece of the body is handed
 * over, which is the end of the upload window.
 */
function dripBody(upload: Upload, perChunkMs: number, mark: () => void): ReadableStream<Uint8Array> {
  if (upload.fillerBytes % upload.slice.length !== 0) {
    throw new Error(`[spool-memory] ${upload.name}: filler is not a whole number of slices`);
  }
  const encoder = new TextEncoder();
  let sent = 0;
  let stage = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (stage === 0) {
        stage = 1;
        await simDelay(upload.prefix.length, perChunkMs);
        controller.enqueue(encoder.encode(upload.prefix));
        return;
      }
      if (sent < upload.fillerBytes) {
        await simDelay(upload.slice.length, perChunkMs);
        controller.enqueue(encoder.encode(upload.slice));
        sent += upload.slice.length;
        return;
      }
      mark();
      controller.enqueue(encoder.encode(upload.suffix));
      controller.close();
    },
  });
}

/** A completion whose `content` is `textBytes` long. */
function bigCompletion(textBytes: number): string {
  return JSON.stringify({
    id: 'chat-perf', object: 'chat.completion', created: 1, model: 'test',
    choices: [{ index: 0, message: { role: 'assistant', content: 'x'.repeat(textBytes) }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
  });
}

/**
 * `text` handed over one slice per pull, so the *upstream* is on a simulated
 * link rather than materializing the whole body in the proxy's face at once.
 * `sent` fires when the last slice has been taken — the point at which the proxy
 * holds everything the upstream produced.
 */
function sliceStream(text: string, perChunkMs: number, sent: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= text.length) {
        sent();
        controller.close();
        return;
      }
      const piece = text.slice(offset, offset + SLICE_BYTES);
      offset += piece.length;
      await simDelay(piece.length, perChunkMs);
      controller.enqueue(encoder.encode(piece));
    },
  });
}

/** `events` SSE events of `eventBytes` each, built one event per pull. */
function bigSseStream(events: number, eventBytes: number, perChunkMs: number, sent: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = 'y'.repeat(eventBytes);
  let written = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (written >= events) {
        sent();
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
        return;
      }
      await simDelay(eventBytes, perChunkMs);
      written += 1;
      const chunk = { id: `c${written}`, object: 'chat.completion.chunk', model: 'test', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    },
  });
}

const SMALL_COMPLETION = JSON.stringify({
  id: 'chat-perf', object: 'chat.completion', created: 1, model: 'test',
  choices: [{ index: 0, message: { role: 'assistant', content: 'seen' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
});

function jsonResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

type Mode = 'off' | 'on';

/** Records a window boundary: live bytes over the baseline, and when it was reached. */
type Checkpoint = (name: string) => void;

interface Point {
  name: string;
  /** Live bytes over the pre-request baseline. */
  bytes: number;
  /** Milliseconds since the request was handed to the handler. */
  ms: number;
}

interface Measure {
  baseline: number;
  points: Point[];
  ms: number;
}

interface Run {
  requestBody: (mark: () => void) => ReadableStream<Uint8Array>;
  upstream: (init: RequestInit | undefined, cp: Checkpoint) => Promise<Response>;
  readResponse: (response: Response) => Promise<number>;
}

async function withProxy(mode: Mode, run: Run, spoolDir: string): Promise<Measure> {
  const tempDir = mkdtempSync(join(tmpdir(), 'mpv3-spool-memory-'));
  const configPath = join(tempDir, 'proxy.toml');
  writeFileSync(configPath, `
[models.default]
upstream_mode = "openai-completions"
base_url = "https://upstream.example"
api_key = "upstream-key"

[spool]
enabled = ${mode === 'on'}
dir = ${JSON.stringify(spoolDir)}
threshold_bytes = 65536
max_request_bytes = 67108864
max_response_bytes = 67108864
max_total_bytes = 134217728
# The L1 blob cache holds payloads in RAM by design; at its default it would
# hide the extraction the spool just did, so the measurement runs it minimal.
max_blob_cache_bytes = 65536
`, 'utf8');

  const { default: handler } = await import('../../src/index.js');
  const { clearProxyConfigCache } = await import('../../src/utils/config-loader.js');
  const { clearModelCache } = await import('../../src/handlers/models.js');
  const { resetBlobStore } = await import('../../src/utils/blob-store.js');
  const { resetAdmission } = await import('../../src/utils/spool-admission.js');
  const { getLiveSpillBytes } = await import('../../src/utils/spool-body.js');
  const { setSpoolConfig, SPOOL_DEFAULTS } = await import('../../src/utils/spool.js');

  clearProxyConfigCache();
  clearModelCache();
  resetBlobStore();
  resetAdmission();

  const realFetch = globalThis.fetch;

  const baseline = live();
  const started = performance.now();
  const points: Point[] = [];
  const cp: Checkpoint = (name) => {
    points.push({ name, bytes: live() - baseline, ms: performance.now() - started });
  };
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => run.upstream(init, cp)) as typeof fetch;

  const env = { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' };
  try {
    const request = new Request('http://proxy/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
      body: run.requestBody(() => cp('upload-end')),
      // A streamed request body needs half-duplex mode on the web Request.
      duplex: 'half',
    } as RequestInit);
    const response = await handler.fetch(request, env as never);
    if (response.status !== 200) {
      throw new Error(`[spool-memory] request failed: ${response.status} ${await response.text()}`);
    }
    const read = await run.readResponse(response);
    if (read === 0) throw new Error('[spool-memory] response body was empty');
    // Every spill this exchange opened has to be released by the time its
    // response is drained: a leak here is budget an operator loses per request.
    if (getLiveSpillBytes() !== 0) {
      throw new Error(`[spool-memory] ${fmt(getLiveSpillBytes())} of spill bytes are still live after the exchange`);
    }
    cp('response-drained');
    return { baseline, points, ms: performance.now() - started };
  } finally {
    globalThis.fetch = realFetch;
    clearProxyConfigCache();
    clearModelCache();
    setSpoolConfig(SPOOL_DEFAULTS);
    resetBlobStore();
    resetAdmission();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Reads a body one chunk per `simDelay` — a downstream client on a slow link.
 * The delay is per *byte*, so a mode that streams the same bytes in more chunks
 * is not charged more wall clock for it.
 */
async function drainSlowly(response: Response, perChunkMs: number): Promise<number> {
  const reader = response.body!.getReader();
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    await simDelay(value.byteLength, perChunkMs);
  }
  return total;
}

/** Reads the request body the handler is sending, on the same simulated link. */
async function upstreamReadsSlowly(init: RequestInit | undefined, perChunkMs: number): Promise<void> {
  const body = init?.body as BodyInit | undefined;
  if (!body) return;
  const source = body instanceof ReadableStream ? body : new Response(body).body!;
  const reader = (source as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) await simDelay(value.byteLength, perChunkMs);
  }
}

/** A stub upstream that swallows the request body and answers small JSON. */
async function swallowThenAnswer(init: RequestInit | undefined, cp: Checkpoint): Promise<Response> {
  cp('request-sent');
  const body = init?.body as BodyInit | undefined;
  if (body) await new Response(body).arrayBuffer();
  cp('request-read');
  return jsonResponse(SMALL_COMPLETION);
}

/**
 * One throwaway exchange per mode before anything is measured. The first
 * request in a process lazily compiles and initializes the whole request path,
 * and that memory is *live*, so it lands inside whichever window is measured
 * first (it read as +2.2 MiB on the first scenario's upload before this).
 */
const WARMUP_RUN: Run = {
  requestBody: () => new Response('{"model":"test","messages":[{"role":"user","content":"warm"}]}').body!,
  upstream: swallowThenAnswer,
  readResponse: (response) => drainSlowly(response, 0),
};

// ---------------------------------------------------------------------------
// The scenarios
// ---------------------------------------------------------------------------

/** 4 ms per 64 KiB ≈ 16 MiB/s of client upload. */
const UPLOAD_LINK = 4;
/** 8 ms per 64 KiB ≈ 8 MiB/s of upstream request send. */
const SEND_LINK = 8;
/** 2 ms per 64 KiB ≈ 32 MiB/s of upstream response. */
const RESPONSE_LINK = 2;
/** 1 ms per 64 KiB ≈ 64 MiB/s of client download. */
const CLIENT_LINK = 1;

interface Scenario {
  name: string;
  note: string;
  run: () => Run;
  /** Phase 1's promise applies to this scenario's upload window. */
  gateUpload: boolean;
  /** A window that is expected to grow with the spool on, and why. */
  onIsWorse?: string;
}

const scenarios: Scenario[] = [
  {
    name: 'A. slow upload — 8 MiB inline image, client dribbles at 16 MiB/s',
    note: "request-sent is the send boundary: the body has been parsed and the image extracted",
    run: () => ({
      requestBody: (mark) => dripBody(IMAGE_UPLOAD, UPLOAD_LINK, mark),
      upstream: swallowThenAnswer,
      readResponse: (response) => drainSlowly(response, 0),
    }),
    gateUpload: true,
  },
  {
    name: 'A2. slow upload — same bytes as non-allowlisted text (the control)',
    note: 'no allowlisted payload, so this isolates the ingress spool from the extraction',
    run: () => ({
      requestBody: (mark) => dripBody(TEXT_UPLOAD, UPLOAD_LINK, mark),
      upstream: swallowThenAnswer,
      readResponse: (response) => drainSlowly(response, 0),
    }),
    gateUpload: true,
  },
  {
    name: 'B. slow upstream send — 8 MiB inline image, upstream reads at 8 MiB/s',
    note: "the client's own upload is instantaneous here, so its window is not meaningful",
    run: () => ({
      requestBody: (mark) => dripBody(IMAGE_UPLOAD, 0, mark),
      upstream: async (init, cp) => {
        cp('request-sent');
        await upstreamReadsSlowly(init, SEND_LINK);
        cp('request-read');
        return jsonResponse(SMALL_COMPLETION);
      },
      readResponse: (response) => drainSlowly(response, 0),
    }),
    gateUpload: false,
  },
  {
    name: 'C. downstream JSON response — 8 MiB completion, client reads at 64 MiB/s',
    note: 'response-sent is when the upstream has handed over the whole body',
    run: () => ({
      requestBody: () => new Response('{"model":"test","messages":[{"role":"user","content":"hi"}]}').body!,
      upstream: async (_init, cp) => {
        cp('request-sent');
        return new Response(sliceStream(bigCompletion(RESPONSE_BYTES), RESPONSE_LINK, () => cp('response-sent')), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
      readResponse: (response) => drainSlowly(response, CLIENT_LINK),
    }),
    gateUpload: false,
  },
  {
    name: 'D. long SSE response — 100 × 256 KiB events, client reads at 64 MiB/s',
    note: 'non-binary SSE events are not spilled per event (§5.7 spills binary payloads only), so this is near a wash',
    run: () => ({
      requestBody: () => new Response('{"model":"test","stream":true,"messages":[{"role":"user","content":"hi"}]}').body!,
      upstream: async (_init, cp) => {
        cp('request-sent');
        return new Response(bigSseStream(SSE_EVENTS, SSE_EVENT_BYTES, RESPONSE_LINK, () => cp('response-sent')), {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      },
      readResponse: (response) => drainSlowly(response, CLIENT_LINK),
    }),
    gateUpload: false,
  },
];

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const spoolDir = mkdtempSync(join(tmpdir(), 'mpv3-spool-memory-spool-'));
const failures: string[] = [];
const regressions: string[] = [];

/** Below this, a window's figure is baseline drift rather than a difference. */
const NOISE = 1 * MiB;

/** One table row: a window's live bytes in both modes, with the on/off ratio. */
function pointRow(label: string, off: Point, on: Point): string {
  let pct: string;
  if (off.bytes < NOISE && on.bytes < NOISE) {
    pct = '    ~0';
  } else if (off.bytes <= 0) {
    pct = '   n/a';
  } else {
    pct = `${((on.bytes / off.bytes) * 100).toFixed(0).padStart(4)}%`;
  }
  return `   ${label.padEnd(16)}  ${fmt(off.bytes).padStart(10)}  ${fmt(on.bytes).padStart(10)}  ${pct}` +
    `  ${`${Math.round(off.ms)}`.padStart(6)}  ${`${Math.round(on.ms)}`.padStart(6)}`;
}

try {
  console.log(`\n§12 spool memory/latency measurement — spool dir under ${spoolDir}`);
  console.log(`   live bytes = heapUsed + arrayBuffers after a forced collection, over a post-GC baseline`);
  console.log(`   "upload-end" = the last body chunk was handed over; every later point is post-parse`);
  console.log(`   a window under ${fmt(NOISE)} is at the noise floor, where the ratio is printed as ~0`);
  console.log(`   uploads: ${fmt(IMAGE_FILLER)} on the wire both ways (image vs non-allowlisted text), response: ${fmt(RESPONSE_BYTES)}, SSE: ${SSE_EVENTS} × ${fmt(SSE_EVENT_BYTES)}`);

  for (const mode of ['off', 'on'] as Mode[]) {
    await withProxy(mode, WARMUP_RUN, spoolDir);
  }

  for (const scenario of scenarios) {
    const results: Record<Mode, Measure> = {} as Record<Mode, Measure>;
    for (const mode of ['off', 'on'] as Mode[]) {
      results[mode] = await withProxy(mode, scenario.run(), spoolDir);
    }
    const off = results.off;
    const on = results.on;

    console.log(`\n${scenario.name}`);
    console.log(`   baseline ${fmt(off.baseline)} (off) / ${fmt(on.baseline)} (on); total exchange ${Math.round(off.ms)} ms (off) / ${Math.round(on.ms)} ms (on)`);
    console.log(`   ${'window'.padEnd(16)}  ${'off'.padStart(10)}  ${'on'.padStart(10)}  on/off   offms    onms`);
    const names = [...new Set([...off.points, ...on.points].map((p) => p.name))];
    for (const name of names) {
      const offPoint = off.points.find((p) => p.name === name);
      const onPoint = on.points.find((p) => p.name === name);
      if (!offPoint || !onPoint) {
        console.log(`   ${name.padEnd(16)}  ${'—'.padStart(10)}  ${'—'.padStart(10)}  (reached in one mode only)`);
        failures.push(`${scenario.name}: "${name}" was reached in ${offPoint ? 'off' : 'on'} mode only`);
        continue;
      }
      console.log(pointRow(name, offPoint, onPoint));
      if (onPoint.bytes - offPoint.bytes >= NOISE) {
        regressions.push(
          `${scenario.name}: "${name}" holds more with the spool on (off ${fmt(offPoint.bytes)}, on ${fmt(onPoint.bytes)}, +${fmt(onPoint.bytes - offPoint.bytes)})`,
        );
      }
    }
    if (scenario.note) console.log(`   note: ${scenario.note}`);

    const offUpload = off.points.find((p) => p.name === 'upload-end');
    const onUpload = on.points.find((p) => p.name === 'upload-end');
    if (off.points.length === 0 || on.points.length === 0) {
      failures.push(`${scenario.name}: no window was measured — the workload never reached the path`);
    }
    if (scenario.gateUpload) {
      if (!offUpload || !onUpload) {
        failures.push(`${scenario.name}: the upload window was not measured in both modes`);
      } else if (onUpload.bytes >= offUpload.bytes) {
        failures.push(
          `${scenario.name}: the upload window is not smaller with the spool on (off ${fmt(offUpload.bytes)}, on ${fmt(onUpload.bytes)})`,
        );
      }
    }
  }
} finally {
  rmSync(spoolDir, { recursive: true, force: true });
}

console.log('');
for (const regression of regressions) console.log(`worse: ${regression}`);
if (failures.length > 0) {
  console.error('\nFAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exitCode = 1;
} else {
  console.log('\nEvery scenario completed 200, released its spills, and reached every window in both modes.\n');
}
