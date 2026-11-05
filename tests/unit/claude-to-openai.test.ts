/**
 * Unit tests for converters/claude-to-openai.ts
 *
 * Covers: recursivelyCleanSchema, convertClaudeToOpenAIRequest (messages, tools,
 * tool_choice, thinking → reasoning_effort, streaming usage), the token-counting
 * variant, and the exported budgetToReasoningEffort / convertClaudeThinkingToOpenAI
 * helpers.
 *
 * Run with: npx tsx --test tests/unit/claude-to-openai.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  recursivelyCleanSchema,
  convertClaudeToOpenAIRequest,
  convertClaudeTokenCountingToOpenAI,
  convertClaudeThinkingToOpenAI,
  budgetToReasoningEffort,
} from '../../src/converters/claude-to-openai.js';
import type { ClaudeMessagesRequest, ClaudeTokenCountingRequest } from '../../src/types/claude.js';

// ---------------------------------------------------------------------------
// recursivelyCleanSchema
// ---------------------------------------------------------------------------

describe('recursivelyCleanSchema', () => {
  it('drops $schema and additionalProperties at every depth', () => {
    const input = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      additionalProperties: false,
      properties: {
        nested: { type: 'object', additionalProperties: true, properties: {} },
      },
    };
    const out = recursivelyCleanSchema(input);
    assert.equal('$schema' in out, false);
    assert.equal('additionalProperties' in out, false);
    assert.equal('additionalProperties' in out.properties.nested, false);
    assert.equal(out.type, 'object');
  });

  it('strips unsupported string format but keeps date-time / enum', () => {
    assert.equal(recursivelyCleanSchema({ type: 'string', format: 'uuid' }).format, undefined);
    assert.equal(recursivelyCleanSchema({ type: 'string', format: 'date-time' }).format, 'date-time');
    assert.equal(recursivelyCleanSchema({ type: 'string', format: 'enum' }).format, 'enum');
  });

  it('recurses through arrays and passes primitives through', () => {
    assert.equal(recursivelyCleanSchema(null), null);
    assert.equal(recursivelyCleanSchema(42), 42);
    const out = recursivelyCleanSchema([{ $schema: 'x', type: 'number' }]);
    assert.deepEqual(out, [{ type: 'number' }]);
  });
});

// ---------------------------------------------------------------------------
// convertClaudeToOpenAIRequest — messages
// ---------------------------------------------------------------------------

describe('convertClaudeToOpenAIRequest — messages', () => {
  it('puts system first and maps a string user message', () => {
    const req = {
      model: 'm',
      system: 'be terse',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToOpenAIRequest(req, 'gpt');
    assert.deepEqual(out.messages[0], { role: 'system', content: 'be terse' });
    assert.deepEqual(out.messages[1], { role: 'user', content: 'hi' });
    assert.equal(out.model, 'gpt');
    assert.equal(out.max_tokens, 100);
  });

  it('joins array system blocks with newlines', () => {
    const req = {
      model: 'm',
      system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToOpenAIRequest(req, 'gpt');
    assert.equal(out.messages[0].content, 'a\nb');
  });

  it('maps an image block to image_url data-URI', () => {
    const req = {
      model: 'm',
      max_tokens: 1,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'ABC' } },
        ],
      }],
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToOpenAIRequest(req, 'gpt');
    assert.deepEqual(out.messages[0].content, [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,ABC' } },
    ]);
  });

  it('carries a §5.4 ref through as a re-prefixed ref instead of stringifying it', () => {
    // §5.3 shape 3: the converted position has to hold something the serializer
    // recognizes. The ref's own `prefix` is `''` (a Claude `source.data` is bare
    // base64), so the conversion has to rebuild the data URL it used to
    // interpolate — otherwise this field would be `[object Object]` upstream.
    const ref = {
      $spoolBlob: true, kind: 'claude-source-data', hash: 'a'.repeat(64), size: 48, prefix: '',
    };
    const req = {
      model: 'm',
      max_tokens: 1,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: ref } },
        ],
      }],
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToOpenAIRequest(req, 'gpt');
    assert.deepEqual((out.messages[0].content as any)[1], {
      type: 'image_url',
      image_url: { url: { $spoolBlob: true, kind: 'claude-source-data', hash: 'a'.repeat(64), size: 48, prefix: 'data:image/png;base64,' } },
    });
  });

  it('emits tool_result as a preceding tool message, other content as user', () => {
    const req = {
      model: 'm',
      max_tokens: 1,
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'call_1', content: 'ok' },
          { type: 'text', text: 'thanks' },
        ],
      }],
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToOpenAIRequest(req, 'gpt');
    assert.deepEqual(out.messages[0], { role: 'tool', tool_call_id: 'call_1', content: 'ok' });
    assert.deepEqual(out.messages[1], { role: 'user', content: [{ type: 'text', text: 'thanks' }] });
  });

  it('stringifies non-string tool_result content', () => {
    const req = {
      model: 'm',
      max_tokens: 1,
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c', content: [{ type: 'text', text: 'x' }] }],
      }],
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToOpenAIRequest(req, 'gpt');
    assert.equal(out.messages[0].role, 'tool');
    assert.equal(typeof out.messages[0].content, 'string');
    assert.match(out.messages[0].content as string, /"type":"text"/);
  });

  it('maps assistant tool_use to tool_calls with stringified args and empty content', () => {
    const req = {
      model: 'm',
      max_tokens: 1,
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_9', name: 'search', input: { q: 'cats' } }],
      }],
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToOpenAIRequest(req, 'gpt');
    const asst = out.messages[0] as any;
    assert.equal(asst.role, 'assistant');
    assert.equal(asst.content, '');
    assert.deepEqual(asst.tool_calls, [{
      id: 'call_9',
      type: 'function',
      function: { name: 'search', arguments: '{"q":"cats"}' },
    }]);
  });

  it('preserves assistant thinking as reasoning_content', () => {
    const req = {
      model: 'm',
      max_tokens: 1,
      messages: [{
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'let me think' },
          { type: 'text', text: 'answer' },
        ],
      }],
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToOpenAIRequest(req, 'gpt');
    const asst = out.messages[0] as any;
    assert.equal(asst.content, 'answer');
    assert.equal(asst.reasoning_content, 'let me think');
  });
});

// ---------------------------------------------------------------------------
// convertClaudeToOpenAIRequest — tools / tool_choice / streaming
// ---------------------------------------------------------------------------

describe('convertClaudeToOpenAIRequest — tools, tool_choice, streaming', () => {
  const withTool = {
    model: 'm',
    max_tokens: 1,
    tools: [{ name: 'get', description: 'd', input_schema: { type: 'object', additionalProperties: false } }],
    messages: [{ role: 'user', content: 'hi' }],
  } as unknown as ClaudeMessagesRequest;

  it('converts tools and cleans their schema', () => {
    const out = convertClaudeToOpenAIRequest(withTool, 'gpt');
    assert.equal(out.tools![0].type, 'function');
    assert.equal(out.tools![0].function.name, 'get');
    assert.equal('additionalProperties' in out.tools![0].function.parameters, false);
  });

  it('defaults tool_choice to auto when tools present and no choice given', () => {
    const out = convertClaudeToOpenAIRequest(withTool, 'gpt');
    assert.equal(out.tool_choice, 'auto');
  });

  it('maps tool_choice type=any → auto, type=none → none, type=tool → function', () => {
    const mk = (tc: any) => convertClaudeToOpenAIRequest({ ...withTool, tool_choice: tc } as any, 'gpt').tool_choice;
    assert.equal(mk({ type: 'any' }), 'auto');
    assert.equal(mk({ type: 'none' }), 'none');
    assert.deepEqual(mk({ type: 'tool', name: 'get' }), { type: 'function', function: { name: 'get' } });
  });

  it('sets stream_options.include_usage only when streaming', () => {
    const streamed = convertClaudeToOpenAIRequest({ ...withTool, stream: true } as any, 'gpt');
    assert.deepEqual(streamed.stream_options, { include_usage: true });
    const plain = convertClaudeToOpenAIRequest(withTool, 'gpt');
    assert.equal(plain.stream_options, undefined);
  });

  it('passes through temperature, top_p and stop sequences', () => {
    const req = {
      model: 'm', max_tokens: 1, temperature: 0.2, top_p: 0.9, stop_sequences: ['END'],
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ClaudeMessagesRequest;
    const out = convertClaudeToOpenAIRequest(req, 'gpt');
    assert.equal(out.temperature, 0.2);
    assert.equal(out.top_p, 0.9);
    assert.deepEqual(out.stop, ['END']);
  });
});

// ---------------------------------------------------------------------------
// thinking / reasoning_effort
// ---------------------------------------------------------------------------

describe('convertClaudeThinkingToOpenAI', () => {
  it('returns empty object when thinking is undefined', () => {
    assert.deepEqual(convertClaudeThinkingToOpenAI(undefined), {});
  });

  it('maps disabled thinking to { enabled: false }', () => {
    assert.deepEqual(convertClaudeThinkingToOpenAI({ type: 'disabled' } as any), { thinking: { enabled: false } });
    assert.deepEqual(convertClaudeThinkingToOpenAI({ type: false } as any), { thinking: { enabled: false } });
  });

  it('enables thinking and carries budget_tokens', () => {
    const out = convertClaudeThinkingToOpenAI({ type: 'enabled', budget_tokens: 3000 } as any);
    assert.deepEqual(out.thinking, { enabled: true, budget_tokens: 3000 });
  });

  it('prefers explicit_reasoning_effort over thresholds', () => {
    const out = convertClaudeThinkingToOpenAI(
      { type: 'enabled', budget_tokens: 100 } as any,
      { explicit_reasoning_effort: 'high', budget_to_effort_high: 999999 },
    );
    assert.equal(out.reasoning_effort, 'high');
  });

  it('maps budget to effort via configured thresholds', () => {
    const out = convertClaudeThinkingToOpenAI(
      { type: 'enabled', budget_tokens: 5000 } as any,
      { budget_to_effort_high: 4000, budget_to_effort_medium: 2000 },
    );
    assert.equal(out.reasoning_effort, 'high');
  });

  it('falls back to task_budget_total when budget_tokens omitted', () => {
    const out = convertClaudeThinkingToOpenAI(
      { type: 'enabled' } as any,
      { task_budget_total: 8000 },
    );
    assert.equal(out.thinking!.budget_tokens, 8000);
  });
});

describe('budgetToReasoningEffort', () => {
  it('uses legacy cutoffs 4096/2048 when no thresholds configured', () => {
    assert.equal(budgetToReasoningEffort(5000), 'high');
    assert.equal(budgetToReasoningEffort(3000), 'medium');
    assert.equal(budgetToReasoningEffort(100), 'low');
  });

  it('treats a zero high-threshold as force-high', () => {
    assert.equal(budgetToReasoningEffort(1, { budget_to_effort_high: 0 }), 'high');
  });

  it('applies configured high/medium thresholds and floors at low', () => {
    const opts = { budget_to_effort_high: 4000, budget_to_effort_medium: 2000 };
    assert.equal(budgetToReasoningEffort(4000, opts), 'high');
    assert.equal(budgetToReasoningEffort(2500, opts), 'medium');
    assert.equal(budgetToReasoningEffort(500, opts), 'low');
  });
});

describe('convertClaudeToOpenAIRequest — reasoning_effort wiring', () => {
  it('derives reasoning_effort from request.reasoning_effort (normalized)', () => {
    const req = {
      model: 'm', max_tokens: 1, thinking: { type: 'enabled', budget_tokens: 100 },
      reasoning_effort: 'xhigh',
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ClaudeMessagesRequest;
    const out = convertClaudeToOpenAIRequest(req, 'gpt');
    assert.equal(out.reasoning_effort, 'max');
  });
});

// ---------------------------------------------------------------------------
// convertClaudeTokenCountingToOpenAI
// ---------------------------------------------------------------------------

describe('convertClaudeTokenCountingToOpenAI', () => {
  it('builds a max_tokens=1 request with converted messages and tools', () => {
    const req = {
      system: 'sys',
      tools: [{ name: 't', description: '', input_schema: { type: 'object' } }],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 't', input: {} }] },
      ],
    } as unknown as ClaudeTokenCountingRequest;

    const out = convertClaudeTokenCountingToOpenAI(req, 'gpt');
    assert.equal(out.model, 'gpt');
    assert.equal(out.max_tokens, 1);
    assert.equal(out.messages[0].content, 'sys');
    assert.equal(out.tools!.length, 1);
    const asst = out.messages[out.messages.length - 1] as any;
    assert.equal(asst.tool_calls[0].id, 'c');
  });
});
