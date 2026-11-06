/**
 * Unit tests for the §5.7 bounded read of the tool judge sidecar's answer
 * (`src/utils/tool-judge-sidecar.ts`, `readJudgeAnswer` behind both callers).
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.7, §5.9.
 *
 * `callJudgeSidecar` and `callDecisionApi` both read the answer with
 * `await resp.text()` — the last unbounded request-path read in `src/` — and both
 * wrapped the read in the same `try` as the parse, so a cap breach, a spill
 * failure or a §5.9 refusal came out as `Tool judge … error: …`, indistinguishable
 * from a broken sidecar. The read now goes through `consumeResponseText` (the
 * no-trace variant: the answer is derived from the tools and the user's prompt,
 * and both callers already log the body at their own level) and a proxy limit is
 * logged as a proxy limit.
 *
 * What these tests pin, and where they are deliberately weak:
 *  - the healthy path is unchanged: the same answer is parsed from a body that
 *    really did live on disk mid-receive and was pulled once — one read, no copy;
 *  - a cap breach and a §5.9 refusal both fail *open* — the sidecar answer is
 *    discarded, the answer body is cancelled on a breach, and nothing is left on
 *    disk or reserved — and `judgeTools` accounts every tool as unjudged rather
 *    than erasing tools on a read it could not finish;
 *  - `max_response_bytes` applies with `[spool] enabled = false` too, which is the
 *    repository's stated rule (`enabled` only decides whether disk is used).
 *
 * Weakness, stated rather than hidden: the *log line* that separates a proxy limit
 * from a sidecar fault cannot be asserted here. This module builds its logger at
 * import time (`createLogger` snapshots `LOG_LEVEL` then) and
 * `tests/setup/silent-logs.ts` silences it before any import, so what these tests
 * pin is the observable contract — a failed read never yields a partial or an
 * erased answer — not the message text.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProxyConfig } from '../../src/utils/config-loader.js';
import {
  callDecisionApi,
  callJudgeSidecar,
  judgeTools,
  type JudgeRequest,
  type JudgeResponse,
} from '../../src/utils/tool-judge-sidecar.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { SPOOL_DEFAULTS, responseSpillDir, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';
import {
  getAdmissionQueueDepth,
  getAdmittedBytes,
  resetAdmission,
} from '../../src/utils/spool-admission.js';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  setSpoolConfig(SPOOL_DEFAULTS);
  resetAdmission();
  // Both ledgers are process-wide: a leak here would silently weaken later tests.
  assert.equal(getLiveSpillBytes(), 0, 'every spool must return its reservation');
  assert.equal(getAdmittedBytes(), 0, 'every §5.9 lease must be released');
  assert.equal(getAdmissionQueueDepth(), 0, 'no waiter may outlive its test');
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) {
    try {
      chmodSync(dir, 0o700);
    } catch { /* already writable or already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Spool enabled with a small threshold, so a few hundred bytes spill. */
function configureSpool(overrides: Partial<SpoolConfig> = {}): SpoolConfig {
  const dir = mkdtempSync(join(tmpdir(), 'tool-judge-response-test-'));
  scratchDirs.push(dir);
  const config: SpoolConfig = {
    ...SPOOL_DEFAULTS,
    enabled: true,
    dir,
    thresholdBytes: 64,
    maxResponseBytes: 1 << 20,
    maxTotalBytes: 1 << 22,
    ...overrides,
  };
  setSpoolConfig(config);
  return config;
}

/** Names of the response spill files currently on disk. */
function spillFiles(config: SpoolConfig): string[] {
  return existsSync(responseSpillDir(config)) ? readdirSync(responseSpillDir(config)) : [];
}

function sidecar(
  over: Partial<NonNullable<ProxyConfig['tool_judge_sidecar']>> = {},
): NonNullable<ProxyConfig['tool_judge_sidecar']> {
  return {
    judge_url: 'http://127.0.0.1:8081',
    model: 'clef-1',
    timeoutMs: 2000,
    threshold: 0.5,
    mode: 'noul',
    maxBatchTools: 50,
    ...over,
  };
}

function proxyConfig(over: Partial<NonNullable<ProxyConfig['tool_judge_sidecar']>> = {}): ProxyConfig {
  return { tool_judge_sidecar: sidecar(over) } as ProxyConfig;
}

/** A §2.5 noul answer for one tool. */
function noulAnswer(noul: number): JudgeResponse[string] {
  return { type: 'noul', confidence: 0.9, action: { act_probability: 0.7 }, noul };
}

/** The answer a noul-mode judge sends back for the two tools below. */
function judgeAnswerJson(): string {
  return JSON.stringify({ Bash: noulAnswer(0.1), Read: noulAnswer(0.9) });
}

const toolJudgeBody = {
  messages: [{ role: 'user', content: 'trim the logs' }],
  tools: [
    { name: 'Bash', input_schema: { type: 'object' } },
    { name: 'Read', input_schema: { type: 'object' } },
  ],
};

function noulRequest(toolNames: string[]): JudgeRequest {
  const questions: JudgeRequest['questions'] = {};
  for (const name of toolNames) {
    questions[name] = { type: 'noul', criterion: 'is this tool needed for the prompt?' };
  }
  return { state: 'trim the logs', questions };
}

interface Sourced {
  stream: ReadableStream<Uint8Array>;
  cancelled: boolean;
  /** Chunk indices the receive asked for, so a second read would be visible. */
  pulls: number[];
}

/**
 * An answer we can watch being cancelled and pulled chunk by chunk. `onPull(i)`
 * runs when the proxy asks for chunk `i`, i.e. after chunks `0…i-1` were read and
 * written to the spill.
 */
function source(chunks: Uint8Array[], onPull?: (index: number) => void): Sourced {
  let index = 0;
  const state: Sourced = { cancelled: false, pulls: [], stream: null as unknown as ReadableStream<Uint8Array> };
  state.stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        state.pulls.push(index);
        onPull?.(index);
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index++]);
      },
      cancel() {
        state.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return state;
}

/** Fixed-size slices of an encoded body, so a spill cannot be the declared-length path. */
function slices(payload: string, size: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(payload);
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    out.push(bytes.subarray(offset, offset + size));
  }
  return out;
}

/** Stand the sidecar up as a server returning `src` as its answer body. */
function serve(src: Sourced, status = 200): void {
  globalThis.fetch = (async () =>
    new Response(src.stream, { status, headers: { 'content-type': 'application/json' } })) as any;
}

// ---------------------------------------------------------------------------
// The healthy path: unchanged answer, bounded read
// ---------------------------------------------------------------------------

describe('judge answer read — bounded, and the answer still parses', () => {
  it('judges from a body that lived on disk mid-receive, pulled once', async () => {
    const config = configureSpool();
    const chunks = slices(judgeAnswerJson(), 40);
    const depths: number[] = [];
    const src = source(chunks, () => {
      depths.push(spillFiles(config).length);
    });
    serve(src);

    const result = await judgeTools(toolJudgeBody, proxyConfig({ mode: 'noul' }), 'req-1');

    // The judgement itself is unchanged by the spool.
    assert.deepEqual(result.eraseNames, ['Bash']);
    assert.deepEqual(result.judgedNames, ['Bash', 'Read']);
    assert.deepEqual(result.unjudgedNames, []);
    assert.deepEqual(result.rawResponse, JSON.parse(judgeAnswerJson()));
    // Above `threshold_bytes` the answer really lived on disk mid-receive…
    assert.ok(depths.some((n) => n === 1), `expected one spill file mid-receive, saw ${JSON.stringify(depths)}`);
    // …and the spill is released before the call returns.
    assert.deepEqual(spillFiles(config), []);
    // The body was pulled once: no second copy of it was ever requested.
    assert.equal(
      src.pulls.length,
      chunks.length + 1,
      `expected one pull per chunk plus the close, saw ${JSON.stringify(src.pulls)}`,
    );
  });

  it('reads the decision API\'s answer the same way', async () => {
    const config = configureSpool();
    const clef = JSON.stringify({ answers: { Bash: { type: 'noul', noul: 0.1 } } });
    const chunks = slices(clef, 24);
    const src = source(chunks);
    serve(src);

    const answer = await callDecisionApi(sidecar(), noulRequest(['Bash']), 'req-2');

    assert.deepEqual(answer, { Bash: { type: 'noul', noul: 0.1 } });
    assert.equal(src.pulls.length, chunks.length + 1);
    assert.deepEqual(spillFiles(config), []);
  });
});

// ---------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------

describe('judge answer read — max_response_bytes', () => {
  /**
   * A well-formed answer past a 256-byte cap: the cap, not a parse error, is what
   * has to stop this read.
   */
  const OVERSIZE = () =>
    slices(
      JSON.stringify({
        Bash: noulAnswer(0.1),
        Read: { ...noulAnswer(0.9), reason: 'x'.repeat(400) },
      }),
      64,
    );

  it('fails open on a breach, cancels the answer, and erases nothing', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const src = source(OVERSIZE());
    serve(src);

    const result = await judgeTools(toolJudgeBody, proxyConfig({ mode: 'noul' }), 'req-1');

    // Fail open: a reader that could not finish must not erase a tool.
    assert.equal(result.called, true);
    assert.deepEqual(result.eraseNames, []);
    assert.deepEqual(result.judgedNames, []);
    assert.deepEqual(result.unjudgedNames, ['Bash', 'Read']);
    assert.match(result.error ?? '', /judged none of 2 tools/i);
    // §5.7 pairs a breach with cancelling the upstream body rather than truncating it.
    assert.equal(src.cancelled, true, 'a breached body must be cancelled');
    assert.deepEqual(spillFiles(config), []);
  });

  it('returns null from the sidecar call on a breach, with nothing left behind', async () => {
    const config = configureSpool({ maxResponseBytes: 256 });
    const src = source(OVERSIZE());
    serve(src);

    const answer = await callJudgeSidecar(sidecar(), noulRequest(['Bash']), 'req-1');

    assert.equal(answer, null);
    assert.equal(src.cancelled, true);
    assert.deepEqual(spillFiles(config), []);
  });

  it('applies the cap with the spool disabled too', async () => {
    const config = configureSpool({ enabled: false, maxResponseBytes: 256 });
    const src = source(OVERSIZE());
    serve(src);

    const answer = await callJudgeSidecar(sidecar(), noulRequest(['Bash']), 'req-1');

    assert.equal(answer, null);
    assert.equal(src.cancelled, true);
    assert.deepEqual(spillFiles(config), []);
  });
});

// ---------------------------------------------------------------------------
// §5.9 admission
// ---------------------------------------------------------------------------

describe('judge answer read — §5.9 byte admission', () => {
  it('fails open on a refusal and releases the spill and its slot', async () => {
    const config = configureSpool({ maxMaterializedBodyBytes: 64 });
    const src = source(slices(judgeAnswerJson(), 32));
    serve(src);

    const result = await judgeTools(toolJudgeBody, proxyConfig({ mode: 'noul' }), 'req-1');

    assert.deepEqual(result.eraseNames, [], 'a refused read erases nothing');
    assert.deepEqual(result.unjudgedNames, ['Bash', 'Read']);
    // A refused read holds nothing: no bytes on disk, no reservation, no waiter.
    assert.deepEqual(spillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(getAdmittedBytes(), 0);
    assert.equal(getAdmissionQueueDepth(), 0);
  });
});

// ---------------------------------------------------------------------------
// The read failure the callers already had
// ---------------------------------------------------------------------------

describe('judge answer read — a fault still fails open', () => {
  it('treats an answer body that errors mid-stream as no answer', async () => {
    configureSpool();
    const broken = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"Bash":'));
        controller.error(new TypeError('terminated'));
      },
    });
    globalThis.fetch = (async () => new Response(broken, { status: 200 })) as any;

    const answer = await callJudgeSidecar(sidecar(), noulRequest(['Bash']), 'req-1');

    assert.equal(answer, null, 'a truncated answer is not an answer');
    assert.equal(getLiveSpillBytes(), 0);
  });
});
