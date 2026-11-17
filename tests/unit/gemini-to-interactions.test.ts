/**
 * `convertGenerateContentToInteraction`: the upstream's own outcome, as the
 * Interactions API states it.
 *
 * The two defects this converter was written to fix are the two things a client
 * switches on:
 *
 * 1. `finishReason` reached nothing. `status` was the literal `'completed'`, so a
 *    `MAX_TOKENS` answer claimed to be complete and a `SAFETY` block with no
 *    content claimed to be a completed answer with an empty `outputs`. A
 *    `MAX_TOKENS` answer is now `incomplete`; blocked and otherwise truncated
 *    answers are `failed` with the upstream's reason, while a cleanly stopped
 *    function call is `requires_action`.
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
    assert.equal('errors' in out, false);
  });

  it('reports token-limit truncation as incomplete with the reason stated, keeping the partial answer', () => {
    const out = interaction(upstream([{ text: 'truncated…' }], 'MAX_TOKENS'));

    assert.equal(out.status, 'incomplete');
    assert.equal(out.outputs[0].text, 'truncated…');
    assert.match(out.errors[0].code, /#FinishReason\.MAX_TOKENS$/);
    assert.match(out.errors[0].message, /stopped the answer early/);
  });

  it('requires action for a function call that stopped cleanly', () => {
    const out = interaction(upstream([{ functionCall: { id: 'call_1', name: 'f', args: {} } }], 'STOP'));

    assert.equal(out.status, 'requires_action');
    assert.equal(out.outputs[0].type, 'function_call');
    assert.equal('errors' in out, false);
  });

  it('reports a withheld answer as failed, and does not call it an empty success', () => {
    const out = interaction(upstream([], 'SAFETY'));

    assert.equal(out.status, 'failed');
    assert.deepEqual(out.outputs, []);
    assert.match(out.errors[0].code, /#FinishReason\.SAFETY$/);
    assert.match(out.errors[0].message, /withheld the answer/);
  });

  it('reports a blocked prompt as failed, naming the block reason', () => {
    const out = interaction({
      candidates: [{ finishReason: 'SAFETY' }],
      promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
      usageMetadata: { promptTokenCount: 1, totalTokenCount: 1 },
    });

    assert.equal(out.status, 'failed');
    assert.match(out.errors[0].code, /#BlockReason\.PROHIBITED_CONTENT$/);
  });

  it('treats an unspecified reason as a clean stop', () => {
    const out = interaction(upstream([{ text: 'hi' }], 'FINISH_REASON_UNSPECIFIED'));

    assert.equal(out.status, 'completed');
    assert.equal('errors' in out, false);
  });

  it('never reports a completed interaction that also carries an error', () => {
    // review_fixes.md #11: `status` was derived from two hand-maintained sets while
    // `errors` was derived from "outside the clean values", so every reason in neither
    // set (`NO_IMAGE`, `IMAGE_OTHER`, …) produced `status: "completed"` *and* an
    // error — a contradiction a client cannot act on. Pinned as an invariant over
    // the whole enum, plus a value the SDK does not declare yet, so a reason added
    // later cannot regress the same way.
    const reasons = [
      'FINISH_REASON_UNSPECIFIED', 'STOP', 'MAX_TOKENS', 'SAFETY', 'RECITATION', 'LANGUAGE', 'OTHER',
      'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'MALFORMED_FUNCTION_CALL', 'IMAGE_SAFETY',
      'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS', 'IMAGE_PROHIBITED_CONTENT', 'NO_IMAGE',
      'IMAGE_RECITATION', 'IMAGE_OTHER',
      'A_REASON_THE_SDK_DOES_NOT_DECLARE_YET',
    ];

    for (const reason of reasons) {
      const out = interaction(upstream([{ text: 'hi' }], reason));
      if (out.errors?.length > 0) {
        assert.notEqual(out.status, 'completed', `${reason} carried an error, so it cannot be a clean answer`);
      }
    }
  });

  it('reports an image generation that produced no image as failed, naming the reason', () => {
    // The two reasons the sets missed, pinned by value so the classification stays
    // what the upstream means: the answer is missing what was asked for.
    for (const reason of ['NO_IMAGE', 'IMAGE_OTHER']) {
      const out = interaction(upstream([{ text: 'hi' }], reason));

      assert.equal(out.status, 'failed', `${reason} is not a completed answer`);
      assert.match(out.errors[0].code, new RegExp(`#FinishReason\\.${reason}$`));
    }
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
      { type: 'code_execution_call', arguments: { language: 'python', code: 'print(1)' } },
      { type: 'code_execution_result', result: '1', is_error: false },
    ]);
  });

  it('re-cases a code execution language into the Interactions lower-case enum', () => {
    // review_fixes.md #10, the other direction: generateContent's `Language` enum
    // is upper case (`PYTHON`), the Interactions one lower case
    // (`interactions.md:1006`), and the upstream spelling was forwarded as-is —
    // a value the Interactions enum does not declare.
    const language = (executableCode: Record<string, unknown>) =>
      (interaction(upstream([{ executableCode }])).outputs[0] as any).arguments.language;

    assert.equal(language({ language: 'PYTHON', code: 'print(1)' }), 'python');
    // An absent language keeps the default it had.
    assert.equal(language({ code: 'print(1)' }), 'python');
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
    // review_fixes.md #12: the three totals were defaulted to 0 while the optional
    // counts were omitted, so this case pinned the very zero its own name denied.
    const out = interaction({ ...upstream([{ text: 'hi' }]), usageMetadata: { promptTokenCount: 1, totalTokenCount: 1 } });

    assert.deepEqual(out.usage, { total_input_tokens: 1, total_tokens: 1 });
  });

  it('omits usage entirely when the upstream reported none', () => {
    // Every field of `Usage` is optional in the SDK's declaration, so an empty
    // object is not a safer default — it is a token count of nothing.
    const out = interaction({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] });

    assert.equal('usage' in out, false);
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
