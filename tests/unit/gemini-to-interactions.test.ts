/**
 * `convertGenerateContentToInteraction`: the upstream's own outcome, as the
 * Interactions API states it.
 *
 * The two defects this converter was written to fix are the two things a client
 * switches on:
 *
 * 1. `finishReason` reached nothing. `status` was the literal `'completed'`, so a
 *    `MAX_TOKENS` answer claimed to be complete and a `SAFETY` block with no
 *    content claimed to be a completed answer with an empty `outputs`. Blocked
 *    and truncated answers are now `failed` with the upstream's reason, while a
 *    cleanly stopped function call is `requires_action`.
 * 2. Parts were relayed in the upstream's dialect. A generateContent
 *    `{inlineData}`/`{functionCall}` has no `type` (required by the Interactions
 *    `Content`), and a `{thought:true, text}` part became `{type:'text'}` — the
 *    model's reasoning served as its answer.
 *
 * The `id` case is the third: the upstream's `responseId` is the real identifier,
 * and the one a client would send back as `previous_interaction_id`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { convertGenerateContentToInteraction } from '../../src/converters/gemini-to-interactions.js';

/** Convert an upstream body and return the interaction, asserting nothing dropped. */
function interaction(response: Record<string, unknown>): any {
  const { interaction: out, dropped } = convertGenerateContentToInteraction(response, 'gemini-3-flash-preview', 'req-1');
  assert.deepEqual(dropped, [], 'this fixture must project every part it carries');
  return out;
}

/** An upstream response whose single candidate holds `parts` and `finishReason`. */
const upstream = (parts: unknown[], finishReason = 'STOP') => ({
  responseId: 'UPSTREAM-ID',
  candidates: [{ content: { role: 'model', parts }, finishReason }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 },
});

describe('convertGenerateContentToInteraction — identity', () => {
  it("takes the upstream's own responseId as the interaction id", () => {
    assert.equal(interaction(upstream([{ text: 'hi' }])).id, 'UPSTREAM-ID');
  });

  it('mints one only when the upstream supplies none', () => {
    const out = interaction({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] });

    assert.match(out.id, /^v1_\d+_req-1$/);
  });

  it('states the client’s model, not the upstream version it answered with', () => {
    const out = interaction({ ...upstream([{ text: 'hi' }]), modelVersion: 'gemini-3-flash-preview-001' });

    assert.equal(out.model, 'gemini-3-flash-preview');
  });
});

describe('convertGenerateContentToInteraction — finishReason', () => {
  it('reports a clean stop as completed, with no error', () => {
    const out = interaction(upstream([{ text: 'hi' }], 'STOP'));

    assert.equal(out.status, 'completed');
    assert.equal('error' in out, false);
  });

  it('reports truncation as failed with the reason stated, keeping the partial answer', () => {
    const out = interaction(upstream([{ text: 'truncated…' }], 'MAX_TOKENS'));

    assert.equal(out.status, 'failed');
    assert.equal(out.outputs[0].text, 'truncated…');
    assert.match(out.error.code, /#FinishReason\.MAX_TOKENS$/);
    assert.match(out.error.message, /stopped the answer early/);
  });

  it('requires action for a function call that stopped cleanly', () => {
    const out = interaction(upstream([{ functionCall: { id: 'call_1', name: 'f', args: {} } }], 'STOP'));

    assert.equal(out.status, 'requires_action');
    assert.equal(out.outputs[0].type, 'function_call');
    assert.equal('error' in out, false);
  });

  it('reports a withheld answer as failed, and does not call it an empty success', () => {
    const out = interaction(upstream([], 'SAFETY'));

    assert.equal(out.status, 'failed');
    assert.deepEqual(out.outputs, []);
    assert.match(out.error.code, /#FinishReason\.SAFETY$/);
    assert.match(out.error.message, /withheld the answer/);
  });

  it('reports a blocked prompt as failed, naming the block reason', () => {
    const out = interaction({
      candidates: [{ finishReason: 'SAFETY' }],
      promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
      usageMetadata: { promptTokenCount: 1, totalTokenCount: 1 },
    });

    assert.equal(out.status, 'failed');
    assert.match(out.error.code, /#BlockReason\.PROHIBITED_CONTENT$/);
  });

  it('treats an unspecified reason as a clean stop', () => {
    const out = interaction(upstream([{ text: 'hi' }], 'FINISH_REASON_UNSPECIFIED'));

    assert.equal(out.status, 'completed');
    assert.equal('error' in out, false);
  });
});

describe('convertGenerateContentToInteraction — outputs', () => {
  it('translates every part kind into the Interactions Content that expresses it', () => {
    const out = interaction(upstream([
      { text: 'look' },
      { inlineData: { mimeType: 'image/png', data: 'aW1n' } },
      { inlineData: { mimeType: 'audio/mp3', data: 'YXVk' } },
      { inlineData: { mimeType: 'video/mp4', data: 'dmlk' } },
      { inlineData: { mimeType: 'application/pdf', data: 'cGRm' } },
      { functionCall: { id: 'call_1', name: 'get_weather', args: { location: 'Boston' } } },
      { executableCode: { language: 'PYTHON', code: 'print(1)' } },
      { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '1' } },
    ]));

    assert.deepEqual(out.outputs, [
      { type: 'text', text: 'look' },
      { type: 'image', data: 'aW1n', mime_type: 'image/png' },
      { type: 'audio', data: 'YXVk', mime_type: 'audio/mp3' },
      { type: 'video', data: 'dmlk', mime_type: 'video/mp4' },
      { type: 'document', data: 'cGRm', mime_type: 'application/pdf' },
      { type: 'function_call', name: 'get_weather', arguments: { location: 'Boston' }, id: 'call_1' },
      { type: 'code_execution_call', arguments: { language: 'PYTHON', code: 'print(1)' } },
      { type: 'code_execution_result', result: '1', is_error: false },
    ]);
  });

  it('serves a thought part as a thought, not as the answer', () => {
    // `{thought:true, text}` used to match the text branch and reach the client
    // as `{type:'text'}` — reasoning presented as the model's answer.
    const out = interaction(upstream([{ thought: true, text: 'reasoning…', thoughtSignature: 'sig' }]));

    assert.deepEqual(out.outputs, [{
      type: 'thought',
      summary: { content: { type: 'text', text: 'reasoning…' } },
      signature: 'sig',
    }]);
  });

  it('mints a call id only when the upstream supplied none, since the schema requires one', () => {
    const out = interaction(upstream([{ functionCall: { name: 'f', args: {} } }]));

    assert.equal(out.outputs[0].id, 'call_0');
  });

  it('reports a part with no Interactions projection instead of relaying it untyped', () => {
    const { interaction: out, dropped } = convertGenerateContentToInteraction(
      upstream([{ text: 'hi' }, { inlineData: { mimeType: 'application/x-unknown', data: 'eA==' } }]),
      'm', 'req-1',
    );

    assert.deepEqual(dropped, ['inlineData(application/x-unknown)']);
    assert.deepEqual(out.outputs, [{ type: 'text', text: 'hi' }]);
  });

  it('accepts a response with no candidate content at all', () => {
    const out = interaction({ responseId: 'r', candidates: [{ finishReason: 'STOP' }] });

    assert.deepEqual(out.outputs, []);
    assert.equal(out.status, 'completed');
  });
});

describe('convertGenerateContentToInteraction — usage', () => {
  it('carries the totals and the counts the Interactions type declares', () => {
    const out = interaction({
      ...upstream([{ text: 'hi' }]),
      usageMetadata: {
        promptTokenCount: 7, candidatesTokenCount: 11, totalTokenCount: 20,
        cachedContentTokenCount: 4, thoughtsTokenCount: 9, toolUsePromptTokenCount: 2,
      },
    });

    assert.deepEqual(out.usage, {
      total_input_tokens: 7,
      total_output_tokens: 11,
      total_tokens: 20,
      total_cached_tokens: 4,
      total_thought_tokens: 9,
      total_tool_use_tokens: 2,
    });
  });

  it('omits an absent count rather than reporting a zero it did not receive', () => {
    const out = interaction({ ...upstream([{ text: 'hi' }]), usageMetadata: { promptTokenCount: 1, totalTokenCount: 1 } });

    assert.deepEqual(out.usage, { total_input_tokens: 1, total_output_tokens: 0, total_tokens: 1 });
  });
});

describe('convertGenerateContentToInteraction — an unreadable upstream body', () => {
  it('fails loudly rather than reporting an empty interaction', () => {
    // A JSON array or scalar is a JSON body the route cannot read; defaulting to
    // `completed` with no outputs is the silent success Rule #8 forbids.
    assert.throws(
      () => convertGenerateContentToInteraction([], 'm', 'req-1'),
      (error: Error) => error.name === 'ProcessingError' && /not a JSON object/.test(error.message),
    );
  });
});
