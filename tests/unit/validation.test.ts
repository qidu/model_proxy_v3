/**
 * Unit tests for validation.ts
 *
 * Covers: validateClaudeMessagesRequest (top-level + numeric bounds),
 * validateClaudeMessage (role), validateClaudeContent/Block (every block type),
 * clampThinkingBudget, validateThinkingConfig,
 * validateClaudeTokenCountingRequest, validateModelsRequestParams,
 * validateOpenAICompletionsRequest, validateAuthHeaders.
 *
 * Run with: npx tsx --test tests/unit/validation.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateClaudeMessagesRequest,
  validateClaudeMessage,
  validateClaudeContent,
  validateClaudeContentBlock,
  clampThinkingBudget,
  validateThinkingConfig,
  validateClaudeTokenCountingRequest,
  validateModelsRequestParams,
  validateOpenAICompletionsRequest,
  validateAuthHeaders,
} from '../../src/utils/validation.js';
import { ValidationError } from '../../src/utils/errors.js';
import type { ClaudeMessagesRequest, ClaudeTokenCountingRequest } from '../../src/types/claude.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function baseRequest(overrides: Partial<ClaudeMessagesRequest> = {}): ClaudeMessagesRequest {
  return {
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

function expectValidationError(fn: () => void, messageFragment?: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof ValidationError, `expected ValidationError, got ${err?.constructor?.name}`);
    if (messageFragment) {
      assert.ok(
        (err as Error).message.includes(messageFragment),
        `expected message to include "${messageFragment}", got: "${(err as Error).message}"`,
      );
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// validateClaudeMessagesRequest — required + shape
// ---------------------------------------------------------------------------

describe('validateClaudeMessagesRequest', () => {
  it('accepts a minimal valid request', () => {
    assert.doesNotThrow(() => validateClaudeMessagesRequest(baseRequest()));
  });

  it('uses modelId from URL when request body has no model', () => {
    const r = baseRequest();
    delete (r as any).model;
    assert.doesNotThrow(() => validateClaudeMessagesRequest(r, 'claude-from-url'));
  });

  it('rejects when messages is missing', () => {
    const r = baseRequest();
    delete (r as any).messages;
    expectValidationError(() => validateClaudeMessagesRequest(r), 'messages field is required');
  });

  it('rejects when messages is not an array', () => {
    const r = baseRequest({ messages: 'nope' as any });
    expectValidationError(() => validateClaudeMessagesRequest(r), 'must be an array');
  });

  it('rejects empty messages array', () => {
    const r = baseRequest({ messages: [] });
    expectValidationError(() => validateClaudeMessagesRequest(r), 'must not be empty');
  });

  it('rejects when neither model nor modelId is provided', () => {
    const r = baseRequest();
    delete (r as any).model;
    expectValidationError(() => validateClaudeMessagesRequest(r), 'Either model');
  });

  it('rejects messages array exceeding 100000', () => {
    const r = baseRequest({
      messages: new Array(100001).fill({ role: 'user', content: 'x' }) as any,
    });
    expectValidationError(() => validateClaudeMessagesRequest(r), 'cannot exceed 100,000');
  });
});

// ---------------------------------------------------------------------------
// validateClaudeMessagesRequest — numeric bounds
// ---------------------------------------------------------------------------

describe('validateClaudeMessagesRequest — numeric bounds', () => {
  it('rejects max_tokens < 1', () => {
    expectValidationError(() => validateClaudeMessagesRequest(baseRequest({ max_tokens: 0 })), 'max_tokens must be at least 1');
  });

  it('rejects max_tokens > 100000', () => {
    expectValidationError(() => validateClaudeMessagesRequest(baseRequest({ max_tokens: 100001 })), 'cannot exceed 100,000');
  });

  it('rejects non-number max_tokens', () => {
    expectValidationError(() => validateClaudeMessagesRequest(baseRequest({ max_tokens: 'big' as any })), 'max_tokens must be a number');
  });

  it('rejects temperature < 0', () => {
    expectValidationError(() => validateClaudeMessagesRequest(baseRequest({ temperature: -0.1 })), 'temperature');
  });

  it('rejects temperature > 1', () => {
    expectValidationError(() => validateClaudeMessagesRequest(baseRequest({ temperature: 1.1 })), 'temperature');
  });

  it('rejects top_p out of [0,1]', () => {
    expectValidationError(() => validateClaudeMessagesRequest(baseRequest({ top_p: 2 })), 'top_p');
  });

  it('rejects top_k < 1', () => {
    expectValidationError(() => validateClaudeMessagesRequest(baseRequest({ top_k: 0 })), 'top_k');
  });

  it('rejects top_k > 1000', () => {
    expectValidationError(() => validateClaudeMessagesRequest(baseRequest({ top_k: 1001 })), 'top_k');
  });

  it('accepts boundary values for temperature (0 and 1)', () => {
    assert.doesNotThrow(() => validateClaudeMessagesRequest(baseRequest({ temperature: 0 })));
    assert.doesNotThrow(() => validateClaudeMessagesRequest(baseRequest({ temperature: 1 })));
  });
});

// ---------------------------------------------------------------------------
// validateClaudeMessagesRequest — stop_sequences + metadata + stream
// ---------------------------------------------------------------------------

describe('validateClaudeMessagesRequest — misc fields', () => {
  it('rejects non-array stop_sequences', () => {
    expectValidationError(() => validateClaudeMessagesRequest(baseRequest({ stop_sequences: 'x' as any })), 'stop_sequences must be an array');
  });

  it('rejects non-string element in stop_sequences', () => {
    expectValidationError(() => validateClaudeMessagesRequest(baseRequest({ stop_sequences: [1 as any] })), 'must be a string');
  });

  it('rejects non-object metadata', () => {
    expectValidationError(() => validateClaudeMessagesRequest(baseRequest({ metadata: 'x' as any })), 'metadata must be an object');
  });

  it('rejects non-string metadata.user_id', () => {
    expectValidationError(() => validateClaudeMessagesRequest(baseRequest({ metadata: { user_id: 5 as any } })), 'user_id');
  });

  it('rejects non-boolean stream', () => {
    expectValidationError(() => validateClaudeMessagesRequest(baseRequest({ stream: 'yes' as any })), 'stream must be a boolean');
  });

  it('accepts valid metadata + stream', () => {
    assert.doesNotThrow(() => validateClaudeMessagesRequest(baseRequest({ metadata: { user_id: 'u1' }, stream: true })));
  });
});

// ---------------------------------------------------------------------------
// validateClaudeMessage
// ---------------------------------------------------------------------------

describe('validateClaudeMessage', () => {
  it('rejects non-object', () => {
    expectValidationError(() => validateClaudeMessage(null as any), 'must be an object');
  });

  it('rejects missing role', () => {
    expectValidationError(() => validateClaudeMessage({ content: 'x' } as any), 'role');
  });

  it('rejects invalid role', () => {
    expectValidationError(() => validateClaudeMessage({ role: 'bot', content: 'x' } as any), 'role must be one of');
  });

  it('accepts user / assistant / system roles', () => {
    for (const role of ['user', 'assistant', 'system']) {
      assert.doesNotThrow(() => validateClaudeMessage({ role, content: 'x' } as any));
    }
  });
});

// ---------------------------------------------------------------------------
// validateClaudeContent
// ---------------------------------------------------------------------------

describe('validateClaudeContent', () => {
  it('accepts non-empty string content', () => {
    assert.doesNotThrow(() => validateClaudeContent('hello'));
  });

  it('rejects whitespace-only string content', () => {
    expectValidationError(() => validateClaudeContent('   '), 'must not be empty');
  });

  it('rejects non-string, non-array content', () => {
    expectValidationError(() => validateClaudeContent(42 as any), 'string or array');
  });

  it('rejects empty array', () => {
    expectValidationError(() => validateClaudeContent([]), 'must not be empty');
  });

  it('accepts an array of valid blocks', () => {
    assert.doesNotThrow(() => validateClaudeContent([{ type: 'text', text: 'hi' }]));
  });
});

// ---------------------------------------------------------------------------
// validateClaudeContentBlock — each type
// ---------------------------------------------------------------------------

describe('validateClaudeContentBlock', () => {
  it('rejects non-object', () => {
    expectValidationError(() => validateClaudeContentBlock('text' as any), 'must be an object');
  });

  it('rejects missing type', () => {
    expectValidationError(() => validateClaudeContentBlock({ text: 'x' } as any), 'type is required');
  });

  it('rejects unknown block type', () => {
    expectValidationError(() => validateClaudeContentBlock({ type: 'mystery' } as any), 'type must be one of');
  });

  // text
  it('text block requires string text', () => {
    expectValidationError(() => validateClaudeContentBlock({ type: 'text' } as any), 'text is required');
    assert.doesNotThrow(() => validateClaudeContentBlock({ type: 'text', text: 'hi' }));
  });

  // image — base64
  it('image base64 requires media_type + data', () => {
    expectValidationError(() => validateClaudeContentBlock({ type: 'image', source: { type: 'base64' } } as any), 'media_type');
    expectValidationError(
      () => validateClaudeContentBlock({ type: 'image', source: { type: 'base64', media_type: 'image/png' } } as any),
      'data is required',
    );
    assert.doesNotThrow(() => validateClaudeContentBlock({
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' },
    }));
  });

  it('image base64 rejects oversized data (default 10MB cap)', () => {
    const big = 'x'.repeat(10 * 1024 * 1024 + 1);
    expectValidationError(
      () => validateClaudeContentBlock({
        type: 'image', source: { type: 'base64', media_type: 'image/png', data: big },
      }, 'exceeds maximum size'),
    );
  });

  it('respects custom maxImageDataSize', () => {
    // 20 bytes exceeds a custom cap of 10
    assert.throws(
      () => validateClaudeContentBlock({
        type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'x'.repeat(20) },
      }, 'block', 10),
      /exceeds maximum size/,
    );
  });

  // image — url
  it('image url requires url string', () => {
    expectValidationError(
      () => validateClaudeContentBlock({ type: 'image', source: { type: 'url' } } as any),
      'url is required',
    );
    assert.doesNotThrow(() => validateClaudeContentBlock({
      type: 'image', source: { type: 'url', url: 'https://x/y.png' },
    }));
  });

  it('image rejects source.type other than base64/url', () => {
    expectValidationError(
      () => validateClaudeContentBlock({ type: 'image', source: { type: 'file' } } as any),
      "must be 'base64' or 'url'",
    );
  });

  it('accepts a §5.4 ref at source.data and bounds it by the size the ref records', () => {
    // §5.3 shape 3: the payload is on disk, so `source.data` holds metadata until
    // the send streams it. The size bound has to read the ref's own `size` — the
    // ref's JSON is a couple of hundred characters whatever the payload weighs, so
    // a bound that measured the field as text would pass every payload through.
    const ref = (size: number) => ({
      $spoolBlob: true, kind: 'claude-source-data', hash: 'a'.repeat(64), size, prefix: '',
    });

    assert.doesNotThrow(() => validateClaudeContentBlock({
      type: 'image', source: { type: 'base64', media_type: 'image/png', data: ref(48) },
    }));
    expectValidationError(
      () => validateClaudeContentBlock({
        type: 'image', source: { type: 'base64', media_type: 'image/png', data: ref(10 * 1024 * 1024 + 1) },
      }, 'exceeds maximum size'),
    );
    // A ref that does not record a size cannot be measured at all: it is refused
    // rather than read as a payload of no weight (repo rule #8).
    assert.throws(
      () => validateClaudeContentBlock({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: { $spoolBlob: true, kind: 'claude-source-data', hash: 'a'.repeat(64), prefix: '' } },
      } as any),
    );
  });

  it('accepts a §5.4 ref at a document source.data', () => {
    assert.doesNotThrow(() => validateClaudeContentBlock({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/pdf',
        data: { $spoolBlob: true, kind: 'claude-source-data', hash: 'b'.repeat(64), size: 12, prefix: '' },
      },
    } as any));
  });

  // document
  it('document requires source with base64 or text type + media_type + data', () => {
    expectValidationError(
      () => validateClaudeContentBlock({ type: 'document', source: { type: 'file' } } as any),
      "must be 'base64' or 'text'",
    );
    assert.doesNotThrow(() => validateClaudeContentBlock({
      type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'hi' },
    }));
  });

  // tool_use
  it('tool_use requires id, name, input', () => {
    expectValidationError(() => validateClaudeContentBlock({ type: 'tool_use', name: 'x', input: {} } as any), 'id is required');
    expectValidationError(() => validateClaudeContentBlock({ type: 'tool_use', id: '1', input: {} } as any), 'name is required');
    expectValidationError(() => validateClaudeContentBlock({ type: 'tool_use', id: '1', name: 'x' } as any), 'input is required');
    assert.doesNotThrow(() => validateClaudeContentBlock({ type: 'tool_use', id: '1', name: 'x', input: {} }));
  });

  // tool_result
  it('tool_result requires tool_use_id + content', () => {
    expectValidationError(() => validateClaudeContentBlock({ type: 'tool_result', content: 'x' } as any), 'tool_use_id is required');
    expectValidationError(() => validateClaudeContentBlock({ type: 'tool_result', tool_use_id: '1' } as any), 'content is required');
    assert.doesNotThrow(() => validateClaudeContentBlock({ type: 'tool_result', tool_use_id: '1', content: 'ok' }));
  });

  // thinking
  it('thinking block requires string thinking', () => {
    expectValidationError(() => validateClaudeContentBlock({ type: 'thinking' } as any), 'thinking is required');
    assert.doesNotThrow(() => validateClaudeContentBlock({ type: 'thinking', thinking: 'pondering' }));
  });

  // web_search_result
  it('web_search_result requires search_query + search_results array', () => {
    expectValidationError(
      () => validateClaudeContentBlock({ type: 'web_search_result', search_results: [] } as any),
      'search_query is required',
    );
    expectValidationError(
      () => validateClaudeContentBlock({ type: 'web_search_result', search_query: 'q' } as any),
      'search_results is required',
    );
    assert.doesNotThrow(() => validateClaudeContentBlock({
      type: 'web_search_result', search_query: 'q', search_results: [],
    }));
  });
});

// ---------------------------------------------------------------------------
// clampThinkingBudget
// ---------------------------------------------------------------------------

describe('clampThinkingBudget', () => {
  it('returns input unchanged when maxTokens is undefined', () => {
    const t = { type: 'enabled' as const, budget_tokens: 99999 };
    assert.equal(clampThinkingBudget(t, undefined), t);
  });

  it('returns input unchanged when thinking is disabled', () => {
    const t = { type: 'disabled' as const };
    assert.equal(clampThinkingBudget(t, 100), t);
  });

  it('returns input unchanged when budget <= maxTokens', () => {
    const t = { type: 'enabled' as const, budget_tokens: 500 };
    assert.equal(clampThinkingBudget(t, 1000), t);
  });

  it('clamps budget down to maxTokens when budget exceeds', () => {
    const t = { type: 'enabled' as const, budget_tokens: 5000 };
    const clamped = clampThinkingBudget(t, 2000);
    assert.equal(clamped.budget_tokens, 2000);
  });

  it('preserves budget when interleavedThinking is true even if budget exceeds maxTokens', () => {
    const t = { type: 'enabled' as const, budget_tokens: 5000 };
    const r = clampThinkingBudget(t, 2000, true);
    assert.equal(r.budget_tokens, 5000);
  });

  it('throws when maxTokens < 1024 and clamp is required', () => {
    const t = { type: 'enabled' as const, budget_tokens: 5000 };
    assert.throws(
      () => clampThinkingBudget(t, 500),
      /cannot be clamped/,
    );
  });

  it('returns input unchanged when thinking is not an object', () => {
    assert.equal(clampThinkingBudget(null as any, 1000), null);
  });

  it('returns input unchanged when budget_tokens is not a number', () => {
    const t = { type: 'enabled' as const };
    assert.equal(clampThinkingBudget(t, 1000), t);
  });

  it('clamps for boolean true thinking type', () => {
    const t = { type: true as const, budget_tokens: 5000 };
    const r = clampThinkingBudget(t, 2000);
    assert.equal(r.budget_tokens, 2000);
  });
});

// ---------------------------------------------------------------------------
// validateThinkingConfig
// ---------------------------------------------------------------------------

describe('validateThinkingConfig', () => {
  it('rejects non-object', () => {
    expectValidationError(() => validateThinkingConfig('x' as any), 'must be an object');
  });

  it('rejects missing type', () => {
    expectValidationError(() => validateThinkingConfig({ budget_tokens: 1024 } as any), 'type is required');
  });

  it('rejects invalid type', () => {
    expectValidationError(() => validateThinkingConfig({ type: 'maybe' as any }), 'type');
  });

  it('accepts enabled with valid budget_tokens', () => {
    assert.doesNotThrow(() => validateThinkingConfig({ type: 'enabled', budget_tokens: 2048 }));
  });

  it('accepts enabled with no budget_tokens', () => {
    assert.doesNotThrow(() => validateThinkingConfig({ type: 'enabled' }));
  });

  it('rejects budget_tokens < 1024', () => {
    expectValidationError(() => validateThinkingConfig({ type: 'enabled', budget_tokens: 500 }), 'at least 1,024');
  });

  it('rejects budget_tokens > 100000', () => {
    expectValidationError(() => validateThinkingConfig({ type: 'enabled', budget_tokens: 100001 }), 'cannot exceed 100,000');
  });

  it('rejects non-number budget_tokens', () => {
    expectValidationError(() => validateThinkingConfig({ type: 'enabled', budget_tokens: 'big' as any }), 'must be a number');
  });

  it('accepts disabled / false types without budget checks', () => {
    assert.doesNotThrow(() => validateThinkingConfig({ type: 'disabled' }));
    assert.doesNotThrow(() => validateThinkingConfig({ type: false }));
  });

  it('accepts boolean true type', () => {
    assert.doesNotThrow(() => validateThinkingConfig({ type: true, budget_tokens: 2048 }));
  });

  it('accepts adaptive type', () => {
    assert.doesNotThrow(() => validateThinkingConfig({ type: 'adaptive' }));
  });
});

// ---------------------------------------------------------------------------
// validateClaudeTokenCountingRequest
// ---------------------------------------------------------------------------

describe('validateClaudeTokenCountingRequest', () => {
  function baseToken(overrides: Partial<ClaudeTokenCountingRequest> = {}): ClaudeTokenCountingRequest {
    return {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }],
      ...overrides,
    };
  }

  it('accepts a minimal valid request', () => {
    assert.doesNotThrow(() => validateClaudeTokenCountingRequest(baseToken()));
  });

  it('rejects when model missing', () => {
    const r = baseToken();
    delete (r as any).model;
    expectValidationError(() => validateClaudeTokenCountingRequest(r), 'model field is required');
  });

  it('rejects when messages missing', () => {
    const r = baseToken();
    delete (r as any).messages;
    expectValidationError(() => validateClaudeTokenCountingRequest(r), 'messages field is required');
  });

  it('rejects empty messages', () => {
    expectValidationError(() => validateClaudeTokenCountingRequest(baseToken({ messages: [] })), 'must not be empty');
  });

  it('rejects messages array over 100000', () => {
    expectValidationError(
      () => validateClaudeTokenCountingRequest(baseToken({ messages: new Array(100001).fill({ role: 'user', content: 'x' }) as any })),
      'cannot exceed 100,000',
    );
  });

  it('clamps + validates thinking config when present', () => {
    // budget > max_tokens gets clamped (token counting request has no max_tokens field → no clamp)
    assert.doesNotThrow(() => validateClaudeTokenCountingRequest(baseToken({ thinking: { type: 'enabled', budget_tokens: 2048 } })));
  });
});

// ---------------------------------------------------------------------------
// validateModelsRequestParams
// ---------------------------------------------------------------------------

describe('validateModelsRequestParams', () => {
  it('accepts empty params', () => {
    assert.doesNotThrow(() => validateModelsRequestParams({}));
  });

  it('rejects non-string after_id', () => {
    expectValidationError(() => validateModelsRequestParams({ after_id: 5 as any }), 'after_id must be a string');
  });

  it('rejects non-string before_id', () => {
    expectValidationError(() => validateModelsRequestParams({ before_id: 5 as any }), 'before_id must be a string');
  });

  it('rejects non-number limit', () => {
    expectValidationError(() => validateModelsRequestParams({ limit: '10' as any }), 'limit must be a number');
  });

  it('rejects limit < 1', () => {
    expectValidationError(() => validateModelsRequestParams({ limit: 0 }), 'limit must be between 1 and 1000');
  });

  it('rejects limit > 1000', () => {
    expectValidationError(() => validateModelsRequestParams({ limit: 1001 }), 'limit must be between 1 and 1000');
  });

  it('accepts boundary limits', () => {
    assert.doesNotThrow(() => validateModelsRequestParams({ limit: 1 }));
    assert.doesNotThrow(() => validateModelsRequestParams({ limit: 1000 }));
  });
});

// ---------------------------------------------------------------------------
// validateOpenAICompletionsRequest
// ---------------------------------------------------------------------------

describe('validateOpenAICompletionsRequest', () => {
  function baseOA(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      ...overrides,
    };
  }

  it('accepts a minimal valid request', () => {
    assert.doesNotThrow(() => validateOpenAICompletionsRequest(baseOA()));
  });

  it('rejects missing model', () => {
    expectValidationError(() => validateOpenAICompletionsRequest(baseOA({ model: undefined })), 'model is required');
  });

  it('rejects non-string model', () => {
    expectValidationError(() => validateOpenAICompletionsRequest(baseOA({ model: 5 })), 'model is required and must be a string');
  });

  it('rejects missing messages', () => {
    expectValidationError(() => validateOpenAICompletionsRequest(baseOA({ messages: undefined })), 'messages is required');
  });

  it('rejects empty messages', () => {
    expectValidationError(() => validateOpenAICompletionsRequest(baseOA({ messages: [] })), 'must not be empty');
  });

  it('rejects non-object message element', () => {
    expectValidationError(() => validateOpenAICompletionsRequest(baseOA({ messages: ['x'] })), 'must be an object');
  });

  it('rejects invalid role', () => {
    expectValidationError(
      () => validateOpenAICompletionsRequest(baseOA({ messages: [{ role: 'boss', content: 'x' }] })),
      'role must be one of',
    );
  });

  it('accepts all valid OpenAI roles', () => {
    const msgs = ['system', 'user', 'assistant', 'tool', 'developer'].map(r => ({ role: r, content: 'x' }));
    assert.doesNotThrow(() => validateOpenAICompletionsRequest(baseOA({ messages: msgs })));
  });

  it('rejects undefined content (content is required, null is allowed for assistant tool_calls)', () => {
    expectValidationError(
      () => validateOpenAICompletionsRequest(baseOA({ messages: [{ role: 'user', content: undefined }] })),
      'content is required',
    );
  });

  it('accepts null content (assistant with tool_calls)', () => {
    assert.doesNotThrow(() => validateOpenAICompletionsRequest(baseOA({
      messages: [{ role: 'assistant', content: null, tool_calls: [] }],
    })));
  });

  it('rejects content of invalid type (number)', () => {
    expectValidationError(
      () => validateOpenAICompletionsRequest(baseOA({ messages: [{ role: 'user', content: 5 as any }] })),
      'content must be a string, array, or null',
    );
  });

  it('rejects max_tokens < 1', () => {
    expectValidationError(() => validateOpenAICompletionsRequest(baseOA({ max_tokens: 0 })), 'max_tokens must be a positive number');
  });

  it('rejects temperature out of [0,2]', () => {
    expectValidationError(() => validateOpenAICompletionsRequest(baseOA({ temperature: 3 })), 'temperature must be a number between 0 and 2');
  });

  it('rejects non-boolean stream', () => {
    expectValidationError(() => validateOpenAICompletionsRequest(baseOA({ stream: 'yes' })), 'stream must be a boolean');
  });
});

// ---------------------------------------------------------------------------
// validateAuthHeaders
// ---------------------------------------------------------------------------

describe('validateAuthHeaders', () => {
  it('accepts Authorization header', () => {
    assert.doesNotThrow(() => validateAuthHeaders({ Authorization: 'Bearer x' }));
  });

  it('accepts x-api-key header', () => {
    assert.doesNotThrow(() => validateAuthHeaders({ 'x-api-key': 'k' }));
  });

  it('rejects when neither header is present', () => {
    expectValidationError(() => validateAuthHeaders({}), 'Either Authorization header or x-api-key');
  });
});
