/**
 * Unit tests for the input-usage number the two SSE egresses of
 * `src/handlers/messages.ts` report when the request body's binary was extracted
 * (§5.4) and upstream reports no usage of its own.
 *
 * Both egresses resolve that number *before* their stream exists and hand the
 * stream a scalar (§5.3) — the transformer at `handleStreamingResponse`, the
 * pump at `handleResponsesStreamAsClaude` — so it is the only input usage the
 * client can see on a stream that carries none. For a ref-bearing request the
 * plan documents what that number is: `ceil(base64Length / 4)` per ref, with the
 * block's own fixed costs dropped, and upstream-reported usage preferred when
 * the stream does carry it.
 *
 * An exact *differential* is the load-bearing assertion, not a shape check: two
 * payloads of 4000 and 8000 base64 characters differ by exactly 1000 tokens,
 * because the ref's JSON (`hash`, `kind`, `prefix`, and a `size` that is four
 * digits either way) is the same length at both sizes. A counter that leaked a
 * per-block cost, counted the payload inline as well, or read the ref's own text
 * into the count would move by something other than 1000. Measuring both against
 * a payload-free body of the same text pins the absolute value too, and pins
 * that nothing fixed survives alongside the payload.
 *
 * The two sites are covered separately because they are two different code paths
 * with two different gates: `handleStreamingResponse` counts only when local
 * token counting is enabled, while `handleResponsesStreamAsClaude` counts
 * whenever it is handed a body and never consults the config. Their callers for
 * an already-OpenAI body are not re-covered here — they reach these same two
 * sites with the same estimator, and the counting branch that body takes is
 * pinned at the primitive level in `token-counting.test.ts`.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.3, §12.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleMessagesRequest } from '../../src/handlers/messages.js';
import { extractInlineBlobs } from '../../src/utils/blob-refs.js';
import { resetBlobStore } from '../../src/utils/blob-store.js';
import { createLogger } from '../../src/utils/logger.js';
import { resolveSpoolConfig, setSpoolConfig } from '../../src/utils/spool.js';

/** Counting on: the `handleStreamingResponse` site is gated on this. */
const ENV = { LOG_LEVEL: 'error', LOCAL_TIKTOKEN: 'true', TIKTOKEN_MODEL: 'o200k_base' } as any;
/** Counting off: the Responses site must count anyway (it never consults the config). */
const ENV_NO_COUNTING = { LOG_LEVEL: 'error' } as any;

const LOGGER = createLogger({});
const CLIENT_URL = 'http://proxy';
const COMPLETIONS_URL = 'https://upstream.example/v1/chat/completions';
const RESPONSES_URL = 'https://upstream.example/v1/responses';
const TEXT = 'what is this?';

const scratchDirs: string[] = [];

after(() => {
  for (const dir of scratchDirs) {
    try {
      chmodSync(dir, 0o700);
    } catch { /* already writable or already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A base64 payload of exactly `chars` characters, no padding. The length is
 * asserted because every number below is stated in characters.
 */
function payload(chars: number): string {
  const encoded = Buffer.alloc((chars / 4) * 3, 0x5a).toString('base64');
  assert.equal(encoded.length, chars, 'the payload helper must produce the exact fixture length');
  return encoded;
}

const PAYLOAD_4000 = payload(4000);
const PAYLOAD_8000 = payload(8000);
assert.notEqual(PAYLOAD_4000, PAYLOAD_8000, 'the two payload sizes must differ');

/**
 * A Claude-format `/v1/messages` body. `system` is what makes the handler read
 * it as Claude format rather than pass it through as an already-OpenAI body;
 * `payloadChars` null gives the payload-free baseline the refs are measured
 * against. Built fresh per case: extraction mutates the body in place.
 */
function claudeBody(payloadChars: number | null): Record<string, unknown> {
  const content: unknown[] = [{ type: 'text', text: TEXT }];
  if (payloadChars !== null) {
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: payload(payloadChars) },
    });
  }
  return {
    model: 'claude-test',
    max_tokens: 16,
    system: 'be brief',
    stream: true,
    messages: [{ role: 'user', content }],
  };
}

/** Replace the allowlisted payload with a real ref, loudly (see the sibling suite). */
async function extract(body: Record<string, unknown>, expected: number): Promise<void> {
  const extraction = await extractInlineBlobs(body);
  assert.equal(extraction.refs, expected, 'the fixture must hold exactly the refs under test');
  assert.equal(extraction.skipped, 0, 'a fixture payload must be shape-3 eligible');
}

// ---------------------------------------------------------------------------
// Upstream SSE, one flavour per mode. The usage blocks are set per case: a case
// that wants to read the *estimate* must send none, because the Responses pump
// overwrites the estimate with whatever `response.completed` carries — including
// a zero.
// ---------------------------------------------------------------------------

let completionsUsage: Record<string, number> | undefined;
let responsesUsage: Record<string, number> | undefined;
let upstreamSends = 0;

function completionsSse(): Response {
  const lines = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, index: 0, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: 'stop' }], usage: completionsUsage })}\n\n`,
    'data: [DONE]\n\n',
  ];
  return new Response(lines.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function responsesSse(): Response {
  const completed: Record<string, unknown> = { type: 'response.completed', response: {} };
  if (responsesUsage) {
    (completed.response as Record<string, unknown>).usage = responsesUsage;
  }
  const lines = [
    `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok', output_index: 0 })}\n\n`,
    `data: ${JSON.stringify(completed)}\n\n`,
  ];
  return new Response(lines.join(''), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    upstreamSends += 1;
    // Drain the send either way: a shape-3 body is a stream the handler is
    // waiting to be taken, and a mock that ignored it would leave it spilled.
    return String(input).endsWith('/v1/responses') ? responsesSse() : completionsSse();
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

interface ClaudeEvent { event: string; data: any; }

function parseClaudeSse(raw: string): ClaudeEvent[] {
  const events: ClaudeEvent[] = [];
  for (const block of raw.split('\n\n')) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    let event = '';
    let dataStr = '';
    for (const line of trimmed.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      else if (line.startsWith('data: ')) dataStr = line.slice(6);
    }
    if (dataStr) events.push({ event, data: JSON.parse(dataStr) });
  }
  return events;
}

/** A fresh, enabled spool directory — the extraction path's precondition (§9.1). */
function enableSpool(): void {
  const dir = mkdtempSync(join(tmpdir(), 'ref-input-usage-'));
  scratchDirs.push(dir);
  setSpoolConfig(resolveSpoolConfig({ enabled: true, dir }));
  resetBlobStore();
}

/** Drive one streaming request through the real handler and parse the Claude SSE it returns. */
async function sendStream(
  body: Record<string, unknown>,
  upstreamMode: string,
  env: any = ENV,
): Promise<ClaudeEvent[]> {
  upstreamSends = 0;
  const response = await handleMessagesRequest(
    new Request(`${CLIENT_URL}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    upstreamMode === 'openai-responses' ? RESPONSES_URL : COMPLETIONS_URL,
    { Authorization: 'Bearer upstream-key' },
    'req-usage',
    'gpt-test',
    env,
    LOGGER,
    undefined,
    upstreamMode,
  );
  assert.equal(response.status, 200, 'the handler must stream the converted upstream response');
  assert.equal(upstreamSends, 1, 'the handler must have made exactly one upstream call');
  assert.match(
    response.headers.get('content-type') ?? '',
    /text\/event-stream/,
    'the response must be Claude SSE for usage to be read from an event',
  );
  return parseClaudeSse(await response.text());
}

/** The input tokens reported before any upstream usage is known. */
function startInputTokens(events: ClaudeEvent[]): number {
  const start = events.find(e => e.event === 'message_start');
  assert.ok(start, 'the stream must open with message_start');
  return start!.data.message.usage.input_tokens;
}

/** The usage reported by the closing message_delta. */
function deltaUsage(events: ClaudeEvent[]): Record<string, number> {
  const delta = events.find(e => e.event === 'message_delta');
  assert.ok(delta, 'the stream must close with message_delta');
  return delta!.data.usage;
}

// ---------------------------------------------------------------------------

describe('ref-aware input usage — converted Chat Completions SSE (§5.3, messages.ts handleStreamingResponse)', () => {
  const MODE = 'openai-completions';

  it('reports exactly the payload-length estimate per ref, and nothing fixed alongside it', async () => {
    completionsUsage = undefined;

    // The payload-free baseline: same text, same message, no ref.
    enableSpool();
    const baseline = startInputTokens(await sendStream(claudeBody(null), MODE));

    enableSpool();
    const small = claudeBody(4000);
    await extract(small, 1);
    const smallTokens = startInputTokens(await sendStream(small, MODE));

    enableSpool();
    const large = claudeBody(8000);
    await extract(large, 1);
    const largeTokens = startInputTokens(await sendStream(large, MODE));

    // 4000 -> 8000 base64 characters is 1000 tokens at 4 characters per token.
    // A per-block cost leaking in, the payload being counted inline as well, or
    // the ref's own JSON text entering the count would each move this.
    assert.equal(smallTokens - baseline, 1000, 'the 4000-character ref must add exactly 4000/4 tokens');
    assert.equal(largeTokens - baseline, 2000, 'the 8000-character ref must add exactly 8000/4 tokens');
    assert.equal(largeTokens - smallTokens, 1000, 'the two refs must differ by exactly the payload difference');
  });

  it('reports the same estimate on the closing message_delta when upstream reports no usage', async () => {
    completionsUsage = undefined;

    enableSpool();
    const body = claudeBody(8000);
    await extract(body, 1);
    const events = await sendStream(body, MODE);

    const start = startInputTokens(events);
    assert.ok(start > 2000, 'the fixture must be large enough for the ref to be visible');
    assert.equal(
      deltaUsage(events).input_tokens,
      start,
      'with no upstream usage the estimate must survive to the final usage',
    );
  });

  it('reports upstream-reported usage in place of the estimate, for a ref-bearing request', async () => {
    completionsUsage = { prompt_tokens: 4242, completion_tokens: 7 };

    enableSpool();
    const body = claudeBody(8000);
    await extract(body, 1);
    const events = await sendStream(body, MODE);

    assert.notEqual(startInputTokens(events), 4242, 'the estimate is not the upstream count by construction');
    assert.deepEqual(
      deltaUsage(events),
      { input_tokens: 4242, output_tokens: 7 },
      'upstream-reported usage must win exactly, not be blended with the estimate',
    );
  });

  it('counts nothing when local token counting is disabled, ref or no ref', async () => {
    completionsUsage = undefined;

    enableSpool();
    const body = claudeBody(8000);
    await extract(body, 1);
    const events = await sendStream(body, MODE, ENV_NO_COUNTING);

    // The site is gated on the config; a ref in the body must not turn the
    // count on, and must not be reported as some other non-zero number.
    assert.equal(startInputTokens(events), 0, 'the disabled config must report no input usage at all');
    assert.equal(deltaUsage(events).input_tokens, 0);
  });
});

describe('ref-aware input usage — converted Responses SSE (§5.3, messages.ts handleResponsesStreamAsClaude)', () => {
  const MODE = 'openai-responses';

  it('reports exactly the payload-length estimate per ref even with token counting disabled', async () => {
    responsesUsage = undefined;

    // No LOCAL_TIKTOKEN: this site never consulted the config, and the estimate
    // must not start depending on it.
    enableSpool();
    const baseline = startInputTokens(await sendStream(claudeBody(null), MODE, ENV_NO_COUNTING));

    enableSpool();
    const small = claudeBody(4000);
    await extract(small, 1);
    const smallTokens = startInputTokens(await sendStream(small, MODE, ENV_NO_COUNTING));

    enableSpool();
    const large = claudeBody(8000);
    await extract(large, 1);
    const largeTokens = startInputTokens(await sendStream(large, MODE, ENV_NO_COUNTING));

    assert.equal(smallTokens - baseline, 1000, 'the 4000-character ref must add exactly 4000/4 tokens');
    assert.equal(largeTokens - baseline, 2000, 'the 8000-character ref must add exactly 8000/4 tokens');
    assert.equal(largeTokens - smallTokens, 1000, 'the two refs must differ by exactly the payload difference');
  });

  it('reports upstream-reported usage from response.completed in place of the estimate', async () => {
    responsesUsage = { input_tokens: 4242, output_tokens: 7 };

    enableSpool();
    const body = claudeBody(8000);
    await extract(body, 1);
    const events = await sendStream(body, MODE, ENV_NO_COUNTING);

    assert.notEqual(startInputTokens(events), 4242, 'the estimate is not the upstream count by construction');
    assert.deepEqual(
      deltaUsage(events),
      { input_tokens: 4242, output_tokens: 7 },
      'response.completed usage must win exactly, not be blended with the estimate',
    );
  });
});
