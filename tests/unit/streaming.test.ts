/**
 * Unit tests for converters/streaming.ts (OpenAI SSE -> Claude SSE).
 *
 * Drives createStreamTransformer through a real TransformStream, feeding OpenAI
 * chat.completions delta chunks and asserting on the emitted Claude event
 * sequence: message_start, content_block_start/delta/stop, tool_use blocks,
 * reasoning_content thinking blocks (with synthetic signature), stop_reason
 * mapping, upstream usage capture, and loud upstream/parse/EOF failures.
 *
 * Run with: npx tsx --test tests/unit/streaming.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createStreamTransformer } from '../../src/converters/streaming.js';
import { SYNTHETIC_THINKING_SIGNATURE, TokenCountingConfig } from '../../src/converters/openai-to-claude.js';
import { countTokensWithTiktoken, getTiktokenTokenizer } from '../../src/utils/token-counting.js';

interface ClaudeEvent { event: string; data: any; }

/** Feed OpenAI SSE lines through the transformer and collect parsed Claude events. */
async function runTransformer(sseLines: string[], opts?: {
  requestId?: string;
  includeThinking?: boolean;
  flushInsteadOfDone?: boolean;
  inputTokens?: number;
  tokenCounting?: TokenCountingConfig;
}): Promise<ClaudeEvent[]> {
  const transformer = createStreamTransformer(
    'model-a',
    opts?.requestId ?? 'req-1',
    opts?.inputTokens,
    opts?.tokenCounting,
    opts?.includeThinking ?? false,
  );
  const stream = new TransformStream<Uint8Array, Uint8Array>(transformer as any);
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();

  let raw = '';
  const readAll = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      raw += dec.decode(value, { stream: true });
    }
  })();

  // The transformer calls controller.terminate() on [DONE], which closes the
  // writable side out from under us. Swallow the resulting "already closed"
  // errors on write/close — the readable side still drains every event.
  const writeAll = (async () => {
    try {
      for (const line of sseLines) await writer.write(enc.encode(line));
      await writer.close();
    } catch (e: any) {
      if (e?.code !== 'ERR_INVALID_STATE') throw e;
    }
  })();

  // A transform failure rejects both sides. Settling both promises before
  // rethrowing keeps the expected failure from escaping as test-process activity.
  const [writeOutcome, readOutcome] = await Promise.allSettled([writeAll, readAll]);
  if (readOutcome.status === 'rejected') throw readOutcome.reason;
  if (writeOutcome.status === 'rejected') throw writeOutcome.reason;

  return parseClaudeSse(raw);
}

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

function oa(delta: any, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ choices: [{ delta, index: 0, finish_reason: null }], ...extra })}\n\n`;
}
function oaFinal(finishReason: string | null, usage?: any): string {
  return `data: ${JSON.stringify({ choices: [{ delta: {}, index: 0, finish_reason: finishReason }], usage })}\n\n`;
}
const DONE = 'data: [DONE]\n\n';

/**
 * Convenience: the finish chunk and [DONE] in one write. The transformer no
 * longer depends on that framing — it records `finish_reason` as the chunks
 * stream by — so the tests below that matter emit them as separate writes.
 */
function finalThenDone(finishReason: string | null, usage?: any): string {
  return oaFinal(finishReason, usage) + DONE;
}

// ---------------------------------------------------------------------------

describe('createStreamTransformer — lifecycle framing', () => {
  it('emits message_start + content_block_start before any delta', async () => {
    const events = await runTransformer([oa({ content: 'hi' }), DONE]);
    assert.equal(events[0].event, 'message_start');
    assert.equal(events[0].data.message.id, 'req-1');
    assert.equal(events[0].data.message.model, 'model-a');
    assert.equal(events[1].event, 'content_block_start');
    assert.equal(events[1].data.index, 0);
    assert.equal(events[1].data.content_block.type, 'text');
  });

  it('emits message_stop last and terminates on [DONE]', async () => {
    const events = await runTransformer([oa({ content: 'hi' }), DONE]);
    assert.equal(events[events.length - 1].event, 'message_stop');
  });
});

describe('createStreamTransformer — text content', () => {
  it('forwards a plain text delta as text_delta on block 0', async () => {
    const events = await runTransformer([oa({ content: 'hello' }), DONE]);
    const delta = events.find(e => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta');
    assert.ok(delta);
    assert.equal(delta!.data.index, 0);
    assert.equal(delta!.data.delta.text, 'hello');
  });

  it('maps finish_reason=stop to end_turn in message_delta', async () => {
    const events = await runTransformer([oa({ content: 'x' }), finalThenDone('stop')]);
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.delta.stop_reason, 'end_turn');
  });

  it('maps finish_reason=length to max_tokens', async () => {
    const events = await runTransformer([oa({ content: 'x' }), finalThenDone('length')]);
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.delta.stop_reason, 'max_tokens');
  });

  // The frame layout a real upstream produces for a streaming request: the
  // finish chunk, then the `choices: []` usage chunk that
  // `stream_options.include_usage` (set by the handlers) forces, then [DONE] —
  // each flushed as its own network chunk.
  it('keeps finish_reason=length across chunk boundaries and a trailing usage chunk', async () => {
    const usageChunk = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } })}\n\n`;
    const events = await runTransformer([oa({ content: 'x' }), oaFinal('length'), usageChunk, DONE]);
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.delta.stop_reason, 'max_tokens');
    assert.equal(md!.data.usage.input_tokens, 11);
    assert.equal(md!.data.usage.output_tokens, 3);
  });

  it('keeps finish_reason when writes split the finish chunk and [DONE] mid-line', async () => {
    const combined = oaFinal('length') + DONE;
    const cut = combined.indexOf('"finish_reason"') + 3;
    const doneCut = combined.indexOf('[DONE]') + 3;
    const events = await runTransformer([
      oa({ content: 'x' }),
      combined.slice(0, cut),
      combined.slice(cut, doneCut),
      combined.slice(doneCut),
    ]);
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.delta.stop_reason, 'max_tokens');
  });
});

describe('createStreamTransformer — tool calls', () => {
  it('opens a tool_use block once id+name are known and streams input_json_delta', async () => {
    const events = await runTransformer([
      oa({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q"' } }] }),
      oa({ tool_calls: [{ index: 0, function: { arguments: ':"cats"}' } }] }),
      finalThenDone('tool_calls'),
    ]);

    const start = events.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'tool_use');
    assert.ok(start, 'tool_use content_block_start emitted');
    assert.equal(start!.data.content_block.id, 'call_1');
    assert.equal(start!.data.content_block.name, 'search');
    assert.equal(start!.data.index, 1, 'tool block sits at index 1 after text block 0');

    const jsonDeltas = events
      .filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta')
      .map(e => e.data.delta.partial_json)
      .join('');
    assert.equal(jsonDeltas, '{"q":"cats"}');

    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.delta.stop_reason, 'tool_use');
  });

  it('forces stop_reason=tool_use when tool calls exist but finish_reason=stop', async () => {
    const events = await runTransformer([
      oa({ tool_calls: [{ index: 0, id: 'c', function: { name: 'n', arguments: '{}' } }] }),
      finalThenDone('stop'),
    ]);
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.delta.stop_reason, 'tool_use');
  });
});

describe('createStreamTransformer — reasoning / thinking', () => {
  it('emits a thinking block for reasoning_content with a synthetic signature at DONE', async () => {
    const events = await runTransformer([
      oa({ reasoning_content: 'step one ' }),
      oa({ reasoning_content: 'step two' }),
      oa({ content: 'final' }),
      finalThenDone('stop'),
    ]);

    const thinkStart = events.find(e => e.event === 'content_block_start' && e.data.content_block.type === 'thinking');
    assert.ok(thinkStart, 'thinking content_block_start emitted');

    const thinkDeltas = events
      .filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'thinking_delta')
      .map(e => e.data.delta.thinking)
      .join('');
    assert.equal(thinkDeltas, 'step one step two');

    const sig = events.find(e => e.event === 'content_block_delta' && e.data.delta.type === 'signature_delta');
    assert.ok(sig, 'signature_delta emitted for thinking block');
    assert.equal(sig!.data.delta.signature, SYNTHETIC_THINKING_SIGNATURE);
  });

  it('uses an upstream signature when one is streamed', async () => {
    const events = await runTransformer([
      oa({ reasoning_content: 'r' }),
      oa({ signature: 'real-sig' }),
      oa({ content: 'a' }),
      finalThenDone('stop'),
    ]);
    const sig = events.find(e => e.event === 'content_block_delta' && e.data.delta.type === 'signature_delta');
    assert.equal(sig!.data.delta.signature, 'real-sig');
  });

  it('extracts inline <think> tags into a thinking block', async () => {
    const events = await runTransformer([
      oa({ content: '<think>hidden</think>' }),
      oa({ content: 'visible' }),
      finalThenDone('stop'),
    ], { includeThinking: true });

    const thinkDeltas = events
      .filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'thinking_delta')
      .map(e => e.data.delta.thinking)
      .join('');
    assert.equal(thinkDeltas, 'hidden');

    const textDeltas = events
      .filter(e => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta')
      .map(e => e.data.delta.text)
      .join('');
    assert.equal(textDeltas, 'visible');
  });
});

describe('createStreamTransformer — usage', () => {
  it('captures upstream usage from an include_usage chunk (empty choices)', async () => {
    const usageChunk = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`;
    const events = await runTransformer([oa({ content: 'x' }), usageChunk, finalThenDone('stop')]);
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.usage.input_tokens, 100);
    assert.equal(md!.data.usage.output_tokens, 20);
  });

  it('surfaces cache-read tokens from prompt_tokens_details.cached_tokens', async () => {
    const usageChunk = `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 50, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 30 } },
    })}\n\n`;
    const events = await runTransformer([oa({ content: 'x' }), usageChunk, finalThenDone('stop')]);
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.usage.cache_read_input_tokens, 30);
  });
});

describe('createStreamTransformer — input usage from the caller (§5.3)', () => {
  it('carries the caller-supplied input tokens into message_start and message_delta', async () => {
    // The transformer holds no request body: the input count arrives as a
    // scalar parameter and must be reported verbatim when upstream reports none.
    const events = await runTransformer([oa({ content: 'x' }), finalThenDone('stop')], {
      inputTokens: 4242,
    });
    const ms = events.find(e => e.event === 'message_start');
    assert.equal(ms!.data.message.usage.input_tokens, 4242);
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.usage.input_tokens, 4242);
  });

  it('defaults to 0 input tokens when the caller supplies none', async () => {
    const events = await runTransformer([oa({ content: 'x' }), finalThenDone('stop')]);
    const ms = events.find(e => e.event === 'message_start');
    assert.equal(ms!.data.message.usage.input_tokens, 0);
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.usage.input_tokens, 0);
  });

  it('still prefers upstream-reported prompt tokens over the caller estimate', async () => {
    const usageChunk = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`;
    const events = await runTransformer([oa({ content: 'x' }), usageChunk, finalThenDone('stop')], {
      inputTokens: 4242,
    });
    // message_start is emitted before any upstream usage is known, so it reports
    // the estimate; the final message_delta reports the authoritative upstream count.
    const ms = events.find(e => e.event === 'message_start');
    assert.equal(ms!.data.message.usage.input_tokens, 4242);
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.usage.input_tokens, 100);
    assert.equal(md!.data.usage.output_tokens, 20);
  });

  it('counts output tokens with tiktoken when counting is enabled, without a request body', async () => {
    // Output counting used to be gated on a request body being present as well
    // as on the config; the body is gone, so the config alone must suffice.
    const events = await runTransformer([oa({ content: 'hello world' }), finalThenDone('stop')], {
      inputTokens: 7,
      tokenCounting: { enabled: true, modelName: 'o200k_base' },
    });
    const tokenizer = await getTiktokenTokenizer('o200k_base');
    const expected = countTokensWithTiktoken('hello world', { tokenizer, useLocalCounting: true });
    assert.ok(expected > 0, 'tokenizer produced a non-zero reference count');
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.usage.output_tokens, expected);
    assert.equal(md!.data.usage.input_tokens, 7);
  });

  it('leaves output tokens at 0 when counting is disabled', async () => {
    // A modelName is supplied deliberately: the disabled flag alone must gate
    // output counting, not a failure to resolve a tokenizer.
    const events = await runTransformer([oa({ content: 'hello world' }), finalThenDone('stop')], {
      inputTokens: 7,
      tokenCounting: { enabled: false, modelName: 'o200k_base' },
    });
    const md = events.find(e => e.event === 'message_delta');
    assert.equal(md!.data.usage.output_tokens, 0);
  });
});

describe('createStreamTransformer — upstream failure', () => {
  it('errors instead of emitting message_delta/message_stop when stream ends without [DONE]', async () => {
    await assert.rejects(
      runTransformer([oa({ content: 'partial' })]),
      /Upstream SSE stream ended before \[DONE\]/,
    );
  });

  it('errors on unexpected EOF even when a tool call was in progress', async () => {
    await assert.rejects(
      runTransformer([oa({ tool_calls: [{ index: 0, id: 'c', function: { name: 'n', arguments: '{}' } }] })]),
      /Upstream SSE stream ended before \[DONE\]/,
    );
  });

  it('errors on malformed upstream JSON instead of skipping it and reporting success', async () => {
    await assert.rejects(
      runTransformer(['data: {bad json}\n\n', DONE]),
      /Invalid JSON in upstream SSE data/,
    );
  });

  it('propagates an upstream read failure without finalizing the Claude stream', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(oa({ content: 'partial' })));
        controller.error(new Error('upstream reset'));
      },
    });
    const transformed = source.pipeThrough(new TransformStream(
      createStreamTransformer('model-a', 'req-1') as any,
    ));

    await assert.rejects(new Response(transformed).text(), /upstream reset/);
  });
});
