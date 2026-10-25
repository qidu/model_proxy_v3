import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  convertOpenAIToGeminiGenerateContent,
  convertOpenAIToGeminiInteractions,
  registerGeminiToolSchemas,
  clearGeminiToolSchemas,
} from '../../src/converters/openai-to-gemini.js';

/**
 * Direct field-level coverage for the OpenAI -> Gemini egress converters.
 * The two exported shapes (generateContent and Interactions) each need
 * coverage of: text, tool_calls, thinking content, streaming vs. non-streaming
 * deltas, empty content, usage mapping, and the schema-aware coercion path.
 */

describe('convertOpenAIToGeminiGenerateContent', () => {
  it('converts a basic non-streaming response with text content', () => {
    const out = convertOpenAIToGeminiGenerateContent(
      {
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop', index: 0 }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      },
      'gemini-proxy',
      'req-1',
    ) as any;

    assert.equal(out.model, 'gemini-proxy');
    assert.equal(out.candidates.length, 1);
    assert.deepEqual(out.candidates[0].content.parts, [{ text: 'hello' }]);
    assert.equal(out.candidates[0].content.role, 'model');
    assert.equal(out.candidates[0].finishReason, 'STOP');
    assert.deepEqual(out.usageMetadata, {
      promptTokenCount: 5,
      candidatesTokenCount: 3,
      totalTokenCount: 8,
    });
  });

  it('converts a streaming delta with content', () => {
    const out = convertOpenAIToGeminiGenerateContent(
      { choices: [{ delta: { content: 'chunk' }, index: 0 }] },
      'm',
      'r',
    ) as any;

    assert.equal(out.candidates[0].content.parts[0].text, 'chunk');
    assert.equal(out.candidates[0].finishReason, undefined, 'no finishReason for mid-stream');
  });

  it('drops candidates for empty content chunks (streaming keepalive)', () => {
    const out = convertOpenAIToGeminiGenerateContent(
      { choices: [{ delta: { content: '' }, index: 0 }] },
      'm',
      'r',
    ) as any;

    assert.equal(out.candidates, undefined, 'candidates must be absent');
    assert.ok(out.usageMetadata, 'usageMetadata is still present');
  });

  it('maps lowercase OpenAI finish_reason values to the uppercase Gemini enum', () => {
    const cases: Array<[string, string]> = [
      ['stop', 'STOP'],
      ['tool_calls', 'STOP'],
      ['function_call', 'STOP'],
      ['length', 'MAX_TOKENS'],
      ['content_filter', 'SAFETY'],
    ];
    for (const [openaiReason, geminiReason] of cases) {
      const out = convertOpenAIToGeminiGenerateContent(
        { choices: [{ message: { content: 'x' }, finish_reason: openaiReason, index: 0 }] },
        'm',
        'r',
      ) as any;
      assert.equal(out.candidates[0].finishReason, geminiReason, `${openaiReason} -> ${geminiReason}`);
    }
  });

  it('passes through finish_reason values that already use the Gemini enum', () => {
    const out = convertOpenAIToGeminiGenerateContent(
      { choices: [{ message: { content: 'x' }, finish_reason: 'RECITATION', index: 0 }] },
      'm',
      'r',
    ) as any;

    assert.equal(out.candidates[0].finishReason, 'RECITATION');
  });

  it('maps an unknown lowercase finish_reason to OTHER instead of leaking it', () => {
    const out = convertOpenAIToGeminiGenerateContent(
      { choices: [{ message: { content: 'x' }, finish_reason: 'some_new_reason', index: 0 }] },
      'm',
      'r',
    ) as any;

    assert.equal(out.candidates[0].finishReason, 'OTHER');
  });

  it('emits a finish-only chunk as a candidate with finishReason instead of dropping it', () => {
    // OpenAI upstreams end streams with an empty-delta chunk carrying only
    // finish_reason. Dropping it leaves strict Gemini clients (@google/genai)
    // without any finishReason — they throw "stream ended without a finish reason".
    const out = convertOpenAIToGeminiGenerateContent(
      { choices: [{ delta: {}, finish_reason: 'stop', index: 0 }] },
      'm',
      'r',
    ) as any;

    assert.equal(out.candidates.length, 1, 'finish-only chunk must keep candidates');
    assert.deepEqual(out.candidates[0].content.parts, []);
    assert.equal(out.candidates[0].finishReason, 'STOP');
  });

  it('extracts <thinking> tags into thought parts', () => {
    const out = convertOpenAIToGeminiGenerateContent(
      {
        choices: [
          { message: { content: '<thinking>deep thought</thinking>answer' }, finish_reason: 'stop', index: 0 },
        ],
      },
      'm',
      'r',
    ) as any;

    const parts = out.candidates[0].content.parts;
    assert.equal(parts.length, 2, 'must have thought part + text part');
    assert.deepEqual(parts[0], { thought: true, text: 'deep thought' });
    assert.equal(parts[1].text, 'answer');
  });

  it('maps reasoning_content into a thought part', () => {
    const out = convertOpenAIToGeminiGenerateContent(
      {
        choices: [
          {
            message: { content: 'answer', reasoning_content: 'internal reasoning' },
            finish_reason: 'stop',
            index: 0,
          },
        ],
      },
      'm',
      'r',
    ) as any;

    const parts = out.candidates[0].content.parts;
    assert.equal(parts[0].thought, true);
    assert.equal(parts[0].text, 'internal reasoning');
    assert.equal(parts[1].text, 'answer');
  });

  it('converts tool_calls into functionCall parts', () => {
    const out = convertOpenAIToGeminiGenerateContent(
      {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { id: 'tc_1', function: { name: 'search', arguments: '{"q":"test"}' } },
              ],
            },
            finish_reason: 'tool_calls',
            index: 0,
          },
        ],
      },
      'm',
      'r',
    ) as any;

    const fnPart = out.candidates[0].content.parts[0];
    assert.deepEqual(fnPart.functionCall, { name: 'search', args: { q: 'test' } });
  });

  it('handles an empty choices array gracefully', () => {
    const out = convertOpenAIToGeminiGenerateContent(
      { choices: [], usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 } },
      'm',
      'r',
    ) as any;

    assert.deepEqual(out.candidates, []);
    assert.equal(out.usageMetadata.promptTokenCount, 1);
  });

  it('defaults usage counts to zero when usage is absent', () => {
    const out = convertOpenAIToGeminiGenerateContent(
      { choices: [{ message: { content: 'x' }, finish_reason: 'stop', index: 0 }] },
      'm',
      'r',
    ) as any;

    assert.deepEqual(out.usageMetadata, {
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      totalTokenCount: 0,
    });
  });
});

describe('convertOpenAIToGeminiGenerateContent: schema-aware coercion', () => {
  const REQ_ID = 'coerce-test';

  beforeEach(() => {
    const schemas = new Map<string, Record<string, unknown>>();
    schemas.set('set_alarm', {
      type: 'object',
      properties: {
        hour: { type: 'integer' },
        label: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        enabled: { type: 'boolean' },
      },
    });
    registerGeminiToolSchemas(REQ_ID, schemas);
  });

  afterEach(() => {
    clearGeminiToolSchemas(REQ_ID);
  });

  it('coerces a numeric string to integer, scalar to array, and string to boolean', () => {
    const out = convertOpenAIToGeminiGenerateContent(
      {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'tc',
                  function: {
                    name: 'set_alarm',
                    arguments: JSON.stringify({
                      hour: '7',
                      label: 123,
                      tags: 'urgent',
                      enabled: 'true',
                    }),
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
            index: 0,
          },
        ],
      },
      'm',
      REQ_ID,
    ) as any;

    const args = out.candidates[0].content.parts[0].functionCall.args;
    assert.strictEqual(args.hour, 7, 'numeric string -> integer');
    assert.strictEqual(args.label, '123', 'number -> string');
    assert.deepEqual(args.tags, ['urgent'], 'scalar wrapped into array');
    assert.strictEqual(args.enabled, true, 'string "true" -> boolean');
  });
});

describe('convertOpenAIToGeminiInteractions', () => {
  it('converts a basic response with text output', () => {
    const out = convertOpenAIToGeminiInteractions(
      {
        choices: [{ message: { content: 'response text' }, finish_reason: 'stop', index: 0 }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
      'model-x',
      'req-42',
    ) as any;

    assert.equal(out.model, 'model-x');
    assert.equal(out.status, 'completed');
    assert.equal(out.object, 'interaction');
    assert.equal(out.role, 'model');
    assert.ok(out.id.includes('req-42'), 'id must embed the requestId');
    assert.equal(out.outputs.length, 1);
    assert.deepEqual(out.outputs[0], { type: 'text', text: 'response text' });
    assert.deepEqual(out.usage, {
      total_input_tokens: 10,
      total_output_tokens: 5,
      total_tokens: 15,
    });
  });

  it('converts tool_calls into function_call outputs', () => {
    const out = convertOpenAIToGeminiInteractions(
      {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [
                { id: 'call_A', function: { name: 'run', arguments: '{"cmd":"ls"}' } },
              ],
            },
            finish_reason: 'tool_calls',
            index: 0,
          },
        ],
      },
      'm',
      'r',
    ) as any;

    assert.equal(out.outputs.length, 1);
    const fc = out.outputs[0];
    assert.equal(fc.type, 'function_call');
    assert.equal(fc.id, 'call_A');
    assert.equal(fc.call_id, 'call_A');
    assert.equal(fc.name, 'run');
    assert.deepEqual(fc.arguments, { cmd: 'ls' });
  });

  it('extracts <think> content into a thought output', () => {
    const out = convertOpenAIToGeminiInteractions(
      {
        choices: [
          { message: { content: '<think>thinking...</think>final' }, finish_reason: 'stop', index: 0 },
        ],
      },
      'm',
      'r',
    ) as any;

    assert.equal(out.outputs.length, 2);
    assert.deepEqual(out.outputs[0], { type: 'thought', text: 'thinking...' });
    assert.deepEqual(out.outputs[1], { type: 'text', text: 'final' });
  });

  it('strips outputs key for empty content chunks', () => {
    const out = convertOpenAIToGeminiInteractions(
      { choices: [{ delta: { content: '' }, index: 0 }] },
      'm',
      'r',
    ) as any;

    assert.equal(out.outputs, undefined);
  });
});
