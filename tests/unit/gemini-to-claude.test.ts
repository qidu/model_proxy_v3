import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  convertGeminiToClaudeResponse,
  convertGeminiGenerateContentToClaude,
} from '../../src/converters/gemini-to-claude.js';
import type { GeminiInteractionResponse } from '../../src/types/gemini.js';

/** Collects the converter's warnings so the fail-loud (Rule #8) path can be asserted. */
function recordingLogger(): { logger: any; warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    logger: {
      warn: (_requestId: string, message: string) => { warnings.push(message); },
    },
  };
}

/**
 * Direct field-level coverage for the Gemini -> Claude response converters.
 * Previously these were only exercised indirectly through the HTTP
 * generateContent / interactions integration testcases, which cannot pin the
 * exact converted shape.
 */

function baseInteraction(
  overrides: Partial<GeminiInteractionResponse>,
): GeminiInteractionResponse {
  return {
    id: 'int_123',
    status: 'completed',
    object: 'interaction',
    created: '2024-01-01T00:00:00Z',
    updated: '2024-01-01T00:00:00Z',
    role: 'model',
    ...overrides,
  };
}

describe('convertGeminiToClaudeResponse', () => {
  it('maps id, model, role and a text output', () => {
    const resp = convertGeminiToClaudeResponse(
      baseInteraction({
        outputs: [{ type: 'text', text: 'hello' } as any],
        usage: {
          total_input_tokens: 12,
          total_output_tokens: 7,
          total_cached_tokens: 0,
          total_thought_tokens: 0,
          total_tool_use_tokens: 0,
          total_tokens: 19,
        },
      }),
      'gemini-model',
      'req-1',
    );

    assert.equal(resp.id, 'int_123');
    assert.equal(resp.type, 'message');
    assert.equal(resp.role, 'assistant', "role 'model' must map to 'assistant'");
    assert.equal(resp.model, 'gemini-model');
    assert.equal(resp.stop_reason, 'end_turn', "status 'completed' -> end_turn");
    assert.deepEqual(resp.content, [{ type: 'text', text: 'hello' }]);
    assert.deepEqual(resp.usage, { input_tokens: 12, output_tokens: 7 });
  });

  it('maps a function_call output to a tool_use block', () => {
    const resp = convertGeminiToClaudeResponse(
      baseInteraction({
        status: 'requires_action',
        outputs: [
          {
            type: 'function_call',
            id: 'call_1',
            name: 'get_weather',
            arguments: { city: 'SF' },
          } as any,
        ],
      }),
      'gemini-model',
      'req-2',
    );

    assert.equal(resp.stop_reason, 'tool_use', "requires_action -> tool_use");
    assert.equal(resp.content.length, 1);
    const block = resp.content[0] as any;
    assert.equal(block.type, 'tool_use');
    assert.equal(block.id, 'call_1');
    assert.equal(block.name, 'get_weather');
    assert.deepEqual(block.input, { city: 'SF' });
  });

  it('maps a function_result output to a tool_result block', () => {
    const resp = convertGeminiToClaudeResponse(
      baseInteraction({
        outputs: [
          {
            type: 'function_result',
            call_id: 'call_1',
            result: 'sunny',
          } as any,
        ],
      }),
      'gemini-model',
      'req-3',
    );

    const block = resp.content[0] as any;
    assert.equal(block.type, 'tool_result');
    assert.equal(block.tool_use_id, 'call_1');
    assert.equal(block.content, 'sunny');
  });

  it('maps an image output to a base64 image block with the given mime type', () => {
    const resp = convertGeminiToClaudeResponse(
      baseInteraction({
        outputs: [
          { type: 'image', mime_type: 'image/webp', data: 'BASE64DATA' } as any,
        ],
      }),
      'gemini-model',
      'req-4',
    );

    const block = resp.content[0] as any;
    assert.equal(block.type, 'image');
    assert.deepEqual(block.source, {
      type: 'base64',
      media_type: 'image/webp',
      data: 'BASE64DATA',
    });
  });

  it('maps a thought output to a thinking block preserving signature', () => {
    const resp = convertGeminiToClaudeResponse(
      baseInteraction({
        outputs: [{ type: 'thought', signature: 'sig-abc' } as any],
      }),
      'gemini-model',
      'req-5',
    );

    const block = resp.content[0] as any;
    assert.equal(block.type, 'thinking');
    assert.equal(block.signature, 'sig-abc');
    assert.equal(block.thinking, 'sig-abc');
  });

  it('attaches citations from text annotations', () => {
    const resp = convertGeminiToClaudeResponse(
      baseInteraction({
        outputs: [
          {
            type: 'text',
            text: 'cited',
            annotations: [
              { source: 'doc.pdf', start_index: 0, end_index: 5 },
            ],
          } as any,
        ],
      }),
      'gemini-model',
      'req-6',
    );

    const block = resp.content[0] as any;
    assert.equal(block.type, 'text');
    assert.equal(block.citations.length, 1);
    assert.deepEqual(block.citations[0], {
      type: 'char_location',
      cited_text: '',
      document_index: 0,
      document_title: 'doc.pdf',
      start_char_index: 0,
      end_char_index: 5,
    });
  });

  it('returns empty content and zeroed usage when outputs/usage are absent', () => {
    const resp = convertGeminiToClaudeResponse(
      baseInteraction({}),
      'gemini-model',
      'req-7',
    );
    assert.deepEqual(resp.content, []);
    assert.deepEqual(resp.usage, { input_tokens: 0, output_tokens: 0 });
  });

  it("maps status 'in_progress' and 'failed' to a null stop_reason", () => {
    const inProgress = convertGeminiToClaudeResponse(
      baseInteraction({ status: 'in_progress' }),
      'm',
      'r',
    );
    const failed = convertGeminiToClaudeResponse(
      baseInteraction({ status: 'failed' }),
      'm',
      'r',
    );
    assert.equal(inProgress.stop_reason, null);
    assert.equal(failed.stop_reason, null);
  });

  it("maps status 'cancelled' to stop_sequence", () => {
    const resp = convertGeminiToClaudeResponse(
      baseInteraction({ status: 'cancelled' }),
      'm',
      'r',
    );
    assert.equal(resp.stop_reason, 'stop_sequence');
  });
});

describe('convertGeminiGenerateContentToClaude', () => {
  it('joins multiple text parts and maps STOP -> end_turn', () => {
    const resp = convertGeminiGenerateContentToClaude(
      {
        candidates: [
          {
            content: { parts: [{ text: 'foo' }, { text: 'bar' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 },
      },
      'gemini-2',
      'reqid-abcdef12',
    );

    assert.equal(resp.type, 'message');
    assert.equal(resp.role, 'assistant');
    assert.equal(resp.model, 'gemini-2');
    assert.deepEqual(resp.content, [{ type: 'text', text: 'foobar' }]);
    assert.equal(resp.stop_reason, 'end_turn');
    assert.deepEqual(resp.usage, { input_tokens: 3, output_tokens: 2 });
    assert.ok(resp.id.startsWith('msg_'), 'id must carry msg_ prefix');
  });

  it('maps MAX_TOKENS -> max_tokens', () => {
    const resp = convertGeminiGenerateContentToClaude(
      {
        candidates: [
          { content: { parts: [{ text: 'x' }] }, finishReason: 'MAX_TOKENS' },
        ],
      },
      'm',
      'r',
    );
    assert.equal(resp.stop_reason, 'max_tokens');
  });

  it('maps SAFETY and RECITATION -> stop_sequence', () => {
    const safety = convertGeminiGenerateContentToClaude(
      { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'SAFETY' }] },
      'm',
      'r',
    );
    const recitation = convertGeminiGenerateContentToClaude(
      { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'RECITATION' }] },
      'm',
      'r',
    );
    assert.equal(safety.stop_reason, 'stop_sequence');
    assert.equal(recitation.stop_reason, 'stop_sequence');
  });

  it('returns empty content, null stop_reason and zeroed usage with no candidates', () => {
    const resp = convertGeminiGenerateContentToClaude({}, 'm', 'r');
    assert.deepEqual(resp.content, []);
    assert.equal(resp.stop_reason, null);
    assert.deepEqual(resp.usage, { input_tokens: 0, output_tokens: 0 });
  });

  it('leaves stop_reason null for an unknown finishReason', () => {
    const resp = convertGeminiGenerateContentToClaude(
      { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'OTHER' }] },
      'm',
      'r',
    );
    assert.equal(resp.stop_reason, null);
  });

  it('maps a functionCall part to a tool_use block and stop_reason tool_use', () => {
    const resp = convertGeminiGenerateContentToClaude(
      {
        candidates: [{
          content: { parts: [{ functionCall: { name: 'get_weather', args: { city: '杭州' } } }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8 },
      },
      'gemini-2',
      'reqid-abcdef12',
    );

    assert.equal(resp.content.length, 1);
    const block = resp.content[0] as any;
    assert.equal(block.type, 'tool_use');
    assert.equal(block.name, 'get_weather');
    assert.deepEqual(block.input, { city: '杭州' });
    assert.match(block.id, /^tool_\d+_0$/, 'a call id is minted because this functionCall carries none');
    // Gemini reports a tool call as finishReason STOP — the block must win.
    assert.equal(resp.stop_reason, 'tool_use');
  });

  it("carries the upstream functionCall.id instead of minting one", () => {
    const resp = convertGeminiGenerateContentToClaude(
      {
        candidates: [{
          content: { parts: [{ functionCall: { id: 'gemini-call-7', name: 'get_weather', args: { city: '杭州' } } }] },
          finishReason: 'STOP',
        }],
        usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8 },
      },
      'gemini-2',
      'reqid-abcdef12',
    );

    assert.equal(resp.content.length, 1);
    const block = resp.content[0] as any;
    assert.equal(block.type, 'tool_use');
    assert.equal(block.id, 'gemini-call-7', "the upstream's own id wins over the minted one");
    assert.equal(block.name, 'get_weather');
  });

  it('keeps text and emits one tool_use block per functionCall, minting distinct ids', () => {
    const resp = convertGeminiGenerateContentToClaude(
      {
        candidates: [{
          content: {
            parts: [
              { text: 'checking' },
              { functionCall: { name: 'a', args: { x: 1 } } },
              { functionCall: { name: 'b', args: {} } },
            ],
          },
          finishReason: 'STOP',
        }],
      },
      'm',
      'r',
    );

    assert.deepEqual(resp.content.map((b: any) => b.type), ['text', 'tool_use', 'tool_use']);
    assert.deepEqual((resp.content[0] as any).text, 'checking');
    assert.deepEqual((resp.content[1] as any).input, { x: 1 });
    assert.deepEqual((resp.content[2] as any).input, {}, 'a missing args object becomes {}');
    assert.notEqual((resp.content[1] as any).id, (resp.content[2] as any).id);
    assert.equal(resp.stop_reason, 'tool_use');
  });

  it('defaults a functionCall without args to an empty input object', () => {
    const resp = convertGeminiGenerateContentToClaude(
      { candidates: [{ content: { parts: [{ functionCall: { name: 'noargs' } }] }, finishReason: 'STOP' }] },
      'm',
      'r',
    );
    assert.equal(resp.content.length, 1);
    assert.deepEqual((resp.content[0] as any).input, {});
    assert.equal(resp.stop_reason, 'tool_use');
  });

  it('warns with the raw finishReason it cannot map, and still leaves stop_reason null', () => {
    const { logger, warnings } = recordingLogger();
    const resp = convertGeminiGenerateContentToClaude(
      { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] },
      'm',
      'rid',
      { logger },
    );

    assert.equal(resp.stop_reason, null);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /unmapped Gemini finishReason "MALFORMED_FUNCTION_CALL"/);
  });

  it('reports each dropped reply-part kind instead of shortening the answer silently', () => {
    const { logger, warnings } = recordingLogger();
    const resp = convertGeminiGenerateContentToClaude(
      {
        candidates: [{
          content: {
            parts: [
              { text: 'here' },
              { inlineData: { mimeType: 'image/png', data: 'AAA' } },
              { inline_data: { mime_type: 'image/png', data: 'BBB' } },
            ],
          },
          finishReason: 'STOP',
        }],
      },
      'm',
      'rid',
      { logger },
    );

    assert.deepEqual(resp.content, [{ type: 'text', text: 'here' }]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /no Claude Messages projection: inline_data×2$/);
  });

  it('reports thought parts, which this path folds into the answer text', () => {
    const { logger, warnings } = recordingLogger();
    const resp = convertGeminiGenerateContentToClaude(
      {
        candidates: [{
          content: { parts: [{ thought: true, text: 'considering' }, { text: 'answer' }] },
          finishReason: 'STOP',
        }],
      },
      'm',
      'rid',
      { logger },
    );

    // Current behaviour, now reported rather than silent: both parts land in one
    // text block, because this path has no thinking projection.
    assert.deepEqual(resp.content, [{ type: 'text', text: 'consideringanswer' }]);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /folded 1 thought part\(s\) into the answer text/);
  });

  it('warns about nothing on a clean text response with a mapped finishReason', () => {
    const { logger, warnings } = recordingLogger();
    const resp = convertGeminiGenerateContentToClaude(
      { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] },
      'm',
      'rid',
      { logger },
    );

    assert.deepEqual(resp.content, [{ type: 'text', text: 'ok' }]);
    assert.deepEqual(warnings, []);
  });
});
