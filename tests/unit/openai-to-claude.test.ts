/**
 * Unit tests for converters/openai-to-claude.ts
 *
 * Covers: extractTokenCounts (standard/QNAIGC/cache fields), the response
 * converter (text, <think> extraction, reasoning_content, tool_calls,
 * stop_reason fixups, empty choices, synthetic signature), and the models /
 * token-count converters.
 *
 * Run with: npx tsx --test tests/unit/openai-to-claude.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  SYNTHETIC_THINKING_SIGNATURE,
  extractTokenCounts,
  convertOpenAIToClaudeResponse,
  convertOpenAITokenCountingToClaude,
  convertOpenAIModelsToClaude,
  mergeOpenAIModelsResponse,
} from '../../src/converters/openai-to-claude.js';
import type { OpenAIResponse } from '../../src/types/openai.js';

// ---------------------------------------------------------------------------
// extractTokenCounts
// ---------------------------------------------------------------------------

describe('extractTokenCounts', () => {
  it('returns zeros when usage is undefined', async () => {
    assert.deepEqual(await extractTokenCounts(undefined), { input_tokens: 0, output_tokens: 0 });
  });

  it('reads standard prompt_tokens / completion_tokens', async () => {
    const out = await extractTokenCounts({ prompt_tokens: 12, completion_tokens: 5 });
    assert.equal(out.input_tokens, 12);
    assert.equal(out.output_tokens, 5);
  });

  it('reads QNAIGC non-standard input / output fields', async () => {
    const out = await extractTokenCounts({ input: 7, output: 3 });
    assert.equal(out.input_tokens, 7);
    assert.equal(out.output_tokens, 3);
  });

  it('maps cache fields (details cached + deepseek hit/miss)', async () => {
    const out = await extractTokenCounts({
      prompt_tokens: 10,
      completion_tokens: 1,
      prompt_tokens_details: { cached_tokens: 4 },
      prompt_cache_miss_tokens: 6,
    });
    assert.equal(out.cache_read_input_tokens, 4);
    assert.equal(out.cache_creation_input_tokens, 6);
  });

  it('prefers prompt_cache_hit_tokens for cache-read when present', async () => {
    const out = await extractTokenCounts({ prompt_tokens: 10, completion_tokens: 1, prompt_cache_hit_tokens: 9 });
    assert.equal(out.cache_read_input_tokens, 9);
  });
});

// ---------------------------------------------------------------------------
// convertOpenAIToClaudeResponse
// ---------------------------------------------------------------------------

function resp(choice: any, extra: Record<string, unknown> = {}): OpenAIResponse {
  return {
    id: 'resp_1',
    object: 'chat.completion',
    created: 0,
    model: 'gpt',
    choices: [choice],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
    ...extra,
  } as unknown as OpenAIResponse;
}

describe('convertOpenAIToClaudeResponse', () => {
  it('returns empty content for an empty choices array', async () => {
    const out = await convertOpenAIToClaudeResponse(
      { id: 'x', choices: [], usage: { prompt_tokens: 2, completion_tokens: 0 } } as any,
      'model-a', 'req-1',
    );
    assert.deepEqual(out.content, []);
    assert.equal(out.stop_reason, null);
    assert.equal(out.id, 'x');
    assert.equal(out.usage.input_tokens, 2);
  });

  it('converts a plain text message', async () => {
    const out = await convertOpenAIToClaudeResponse(
      resp({ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }),
      'model-a', 'req-1',
    );
    assert.deepEqual(out.content, [{ type: 'text', text: 'hello' }]);
    assert.equal(out.stop_reason, 'end_turn');
    assert.equal(out.role, 'assistant');
  });

  it('extracts <think> markers into a thinking block and strips them from text', async () => {
    const out = await convertOpenAIToClaudeResponse(
      resp({ message: { role: 'assistant', content: '<think>reasoning</think>answer' }, finish_reason: 'stop' }),
      'model-a', 'req-1',
    );
    const thinking = out.content.find(b => (b as any).type === 'thinking') as any;
    const text = out.content.find(b => (b as any).type === 'text') as any;
    assert.equal(thinking.thinking, 'reasoning');
    assert.equal(thinking.signature, SYNTHETIC_THINKING_SIGNATURE);
    assert.equal(text.text, 'answer');
  });

  it('emits a leading thinking block for inline reasoning_content', async () => {
    const out = await convertOpenAIToClaudeResponse(
      resp({ message: { role: 'assistant', content: 'final', reasoning_content: 'deepseek thoughts' }, finish_reason: 'stop' }),
      'model-a', 'req-1',
    );
    assert.equal((out.content[0] as any).type, 'thinking');
    assert.equal((out.content[0] as any).thinking, 'deepseek thoughts');
    assert.equal((out.content[0] as any).signature, SYNTHETIC_THINKING_SIGNATURE);
    assert.equal((out.content[1] as any).type, 'text');
  });

  it('converts tool_calls into tool_use blocks with parsed input', async () => {
    const out = await convertOpenAIToClaudeResponse(
      resp({
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } }],
        },
        finish_reason: 'tool_calls',
      }),
      'model-a', 'req-1',
    );
    const tu = out.content.find(b => (b as any).type === 'tool_use') as any;
    assert.equal(tu.id, 'call_1');
    assert.equal(tu.name, 'search');
    assert.deepEqual(tu.input, { q: 'x' });
    assert.equal(out.stop_reason, 'tool_use');
  });

  it('upgrades stop_reason to tool_use when tool_calls present but finish_reason=stop', async () => {
    const out = await convertOpenAIToClaudeResponse(
      resp({
        message: {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'c', type: 'function', function: { name: 'n', arguments: '{}' } }],
        },
        finish_reason: 'stop',
      }),
      'model-a', 'req-1',
    );
    assert.equal(out.stop_reason, 'tool_use');
  });

  it('maps finish_reason=length → max_tokens', async () => {
    const out = await convertOpenAIToClaudeResponse(
      resp({ message: { role: 'assistant', content: 'x' }, finish_reason: 'length' }),
      'model-a', 'req-1',
    );
    assert.equal(out.stop_reason, 'max_tokens');
  });

  it('uses a response-level signature for extracted thinking when available', async () => {
    const out = await convertOpenAIToClaudeResponse(
      resp(
        { message: { role: 'assistant', content: '<think>t</think>a' }, finish_reason: 'stop' },
        { signature: 'sig-xyz' },
      ),
      'model-a', 'req-1',
    );
    const thinking = out.content.find(b => (b as any).type === 'thinking') as any;
    assert.equal(thinking.signature, 'sig-xyz');
  });
});

// ---------------------------------------------------------------------------
// token-count + models converters
// ---------------------------------------------------------------------------

describe('convertOpenAITokenCountingToClaude', () => {
  it('maps prompt_tokens to input_tokens', () => {
    assert.deepEqual(
      convertOpenAITokenCountingToClaude({ prompt_tokens: 42 } as any),
      { type: 'token_count', input_tokens: 42 },
    );
  });
});

describe('convertOpenAIModelsToClaude', () => {
  it('maps model ids and converts created unix time to RFC3339', () => {
    const out = convertOpenAIModelsToClaude({
      object: 'list',
      data: [{ id: 'gpt-x', object: 'model', created: 0, owned_by: 'o' }],
    } as any);
    assert.equal(out.data[0].id, 'gpt-x');
    assert.equal(out.data[0].type, 'model');
    assert.equal(out.data[0].created_at, '1970-01-01T00:00:00.000Z');
    assert.equal(out.first_id, 'gpt-x');
    assert.equal(out.has_more, false);
  });

  it('appends extra model ids that are not already present', () => {
    const out = convertOpenAIModelsToClaude(
      { object: 'list', data: [{ id: 'a', object: 'model', created: 0, owned_by: 'o' }] } as any,
      ['a', 'b'],
    );
    const ids = out.data.map(m => m.id);
    assert.deepEqual(ids, ['a', 'b']);
  });
});

describe('mergeOpenAIModelsResponse', () => {
  it('dedupes existing ids, passes them through unchanged, and adds the rest with defaults', () => {
    const existing = { id: 'a', object: 'model', created: 5, owned_by: 'upstream' };
    const out = mergeOpenAIModelsResponse({ object: 'list', data: [existing] } as any, ['a', 'z']);
    assert.equal(out.object, 'list');
    assert.deepEqual(out.data.map(m => m.id), ['a', 'z']);
    assert.equal(out.data[0], existing, 'an already-present model must be reused, not re-created');
    assert.equal(out.data[1].owned_by, 'system');
    assert.equal(out.data[1].context_length, 262144);
    assert.equal(out.data[1].max_tokens, 65536);
  });
});
