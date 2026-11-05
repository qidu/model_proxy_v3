/**
 * Unit tests for utils/token-counting.ts
 *
 * Covers: estimateTokenCount (overhead, whitespace, charactersPerToken),
 * countTokensWithTiktoken (real tokenizer + estimate fallback), per-message /
 * per-messages / system counting, content-block counting across every block
 * type, countClaudeRequestTokens (model/system/messages/tools/tool_choice/
 * thinking), getLocalTokenCountingConfig env parsing, and getTiktokenTokenizer
 * caching. These counts feed usage accounting and the 413 token-limit engine.
 *
 * Run with: npx tsx --test tests/unit/token-counting.test.ts
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  estimateTokenCount,
  countTokensWithTiktoken,
  countMessageTokens,
  countMessagesTokens,
  countSystemTokens,
  countClaudeRequestTokens,
  getLocalTokenCountingConfig,
  getTiktokenTokenizer,
} from '../../src/utils/token-counting.js';
import type { Tiktoken } from 'js-tiktoken/lite';
import { BLOB_REF_MARKER, extractInlineBlobs, isBlobRef, type BlobRef, type BlobRefKind } from '../../src/utils/blob-refs.js';
import { BlobStoreError, resetBlobStore } from '../../src/utils/blob-store.js';
import { resolveSpoolConfig, setSpoolConfig } from '../../src/utils/spool.js';

// ---------------------------------------------------------------------------
// estimateTokenCount
// ---------------------------------------------------------------------------

describe('estimateTokenCount', () => {
  it('returns 0 for empty text', () => {
    assert.equal(estimateTokenCount(''), 0);
  });

  it('adds the 5-token overhead: ceil(len/4) + 5', () => {
    // 8 chars / 4 = 2, + 5 overhead
    assert.equal(estimateTokenCount('abcdefgh'), 7);
    // 9 chars → ceil(9/4)=3, + 5
    assert.equal(estimateTokenCount('abcdefghi'), 8);
  });

  it('honors a custom charactersPerToken', () => {
    // 8 chars / 2 = 4, + 5 overhead
    assert.equal(estimateTokenCount('abcdefgh', { charactersPerToken: 2 }), 9);
  });

  it('collapses whitespace when countWhitespace is false', () => {
    // "a   b" (5 chars) → collapsed "a b" (3 chars) → ceil(3/4)=1, +5
    assert.equal(estimateTokenCount('a   b', { countWhitespace: false }), 6);
  });
});

// ---------------------------------------------------------------------------
// countTokensWithTiktoken (with a real tokenizer)
// ---------------------------------------------------------------------------

describe('countTokensWithTiktoken', () => {
  let tokenizer: Tiktoken;
  before(async () => { tokenizer = await getTiktokenTokenizer('cl100k_base'); });

  it('returns 0 for empty text', () => {
    assert.equal(countTokensWithTiktoken('', { tokenizer }), 0);
  });

  it('matches the tokenizer.encode length exactly', () => {
    const text = 'The quick brown fox jumps over the lazy dog.';
    assert.equal(countTokensWithTiktoken(text, { tokenizer }), tokenizer.encode(text).length);
  });

  it('falls back to estimation when no tokenizer is provided', () => {
    assert.equal(countTokensWithTiktoken('abcdefgh'), estimateTokenCount('abcdefgh'));
  });
});

// ---------------------------------------------------------------------------
// countMessageTokens / countMessagesTokens / countSystemTokens
// ---------------------------------------------------------------------------

describe('countMessageTokens', () => {
  it('counts role + string content + 2 type-indicator tokens (estimate mode)', () => {
    const roleTokens = estimateTokenCount('role: user');
    const contentTokens = estimateTokenCount('hello');
    assert.equal(
      countMessageTokens({ role: 'user', content: 'hello' }),
      roleTokens + contentTokens + 2,
    );
  });

  it('sums content-block tokens for array content', () => {
    const n = countMessageTokens({
      role: 'user',
      content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
    });
    // role + block(a) + block(b) + 2; strictly greater than a bare role count.
    assert.ok(n > estimateTokenCount('role: user') + 2);
  });
});

describe('countMessagesTokens', () => {
  it('adds a 3-token separator overhead on top of per-message counts', () => {
    const msgs = [
      { role: 'user' as const, content: 'hi' },
      { role: 'assistant' as const, content: 'yo' },
    ];
    const expected = countMessageTokens(msgs[0]) + countMessageTokens(msgs[1]) + 3;
    assert.equal(countMessagesTokens(msgs), expected);
  });
});

describe('countSystemTokens', () => {
  it('returns 0 for empty / undefined system', () => {
    assert.equal(countSystemTokens(''), 0);
    assert.equal(countSystemTokens(undefined as any), 0);
  });

  it('counts a string system prompt via estimation', () => {
    assert.equal(countSystemTokens('be terse'), estimateTokenCount('be terse'));
  });

  it('sums block tokens for an array system prompt', () => {
    const n = countSystemTokens([{ type: 'text', text: 'be terse' }]);
    assert.equal(n, estimateTokenCount('be terse'));
  });
});

// ---------------------------------------------------------------------------
// content-block coverage via countMessageTokens
// ---------------------------------------------------------------------------

describe('content-block token counting', () => {
  const count = (block: any) =>
    countMessageTokens({ role: 'user', content: [block] }) - estimateTokenCount('role: user') - 2;

  it('adds a +20 surcharge for image blocks', () => {
    const img = count({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } });
    const doc = count({ type: 'document', source: { media_type: 'application/pdf', type: 'base64', data: 'AAAA' } });
    // Image surcharge (20) exceeds document surcharge (10) for comparable data.
    assert.ok(img > doc);
  });

  it('counts tool_use blocks including serialized input', () => {
    const n = count({ type: 'tool_use', id: 'c', name: 'search', input: { q: 'cats' } });
    assert.ok(n > 0);
  });

  it('counts tool_result with string content', () => {
    const n = count({ type: 'tool_result', tool_use_id: 'c', content: 'result body' });
    assert.ok(n >= estimateTokenCount('tool_result: c\nresult body'));
  });

  it('counts nested tool_result content blocks', () => {
    const n = count({ type: 'tool_result', tool_use_id: 'c', content: [{ type: 'text', text: 'nested' }] });
    assert.ok(n > 0);
  });

  it('counts thinking blocks', () => {
    const n = count({ type: 'thinking', thinking: 'reasoning', signature: 'sig' });
    assert.ok(n > 0);
  });

  it('falls back to JSON.stringify for unknown block types', () => {
    const block = { type: 'mystery', foo: 'bar' };
    const n = count(block);
    assert.equal(n, estimateTokenCount(JSON.stringify(block)));
  });
});

// ---------------------------------------------------------------------------
// ref-aware counting (plan §5.3, §9.3)
// ---------------------------------------------------------------------------

describe('counting a payload the spool extracted (plan §5.3)', () => {
  /**
   * One block's contribution, by subtracting an empty-content message counted
   * with the same options. Unlike the delta above this stays exact when a
   * tokenizer is supplied, because the role text is then counted both times.
   */
  const count = (block: any, options?: any) =>
    countMessageTokens({ role: 'user', content: [block] }, options) -
    countMessageTokens({ role: 'user', content: [] }, options);

  /** A ref for `size` base64 chars. The hash deliberately names no stored blob. */
  const refFor = (kind: BlobRefKind, size: number, prefix = 'data:image/png;base64,'): BlobRef => ({
    [BLOB_REF_MARKER]: true,
    kind,
    hash: 'f'.repeat(64),
    size,
    prefix,
  });

  it('counts an extracted image as ceil(base64 length / 4), with no surcharge', () => {
    const n = count({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: refFor('claude-source-data', 4000) } });
    assert.equal(n, 1000, 'exactly 4000/4, so neither the +20 surcharge nor the field labels survive');
  });

  it('counts an extracted document identically, so the +20/+10 split is gone', () => {
    const image = count({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: refFor('claude-source-data', 4000) } });
    const document = count({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: refFor('claude-source-data', 4000, 'data:application/pdf;base64,') } });
    assert.equal(document, 1000);
    assert.equal(document, image, 'same payload length, same count, whatever the block type');
  });

  it('honours charactersPerToken and adds no fixed overhead', () => {
    const block = { type: 'image', source: { data: refFor('claude-source-data', 1000) } };
    assert.equal(count(block, { charactersPerToken: 4 }), 250);
    assert.equal(count(block, { charactersPerToken: 10 }), 100);
    // The text path keeps its 5-token overhead, so the two differ by more than the divisor.
    assert.equal(count({ type: 'text', text: 'x'.repeat(1000) }, { charactersPerToken: 10 }), 105);
  });

  it('never reads the blob: a ref whose hash names no stored blob still counts', () => {
    resetBlobStore(); // an empty store, so any read would throw
    assert.equal(count({ type: 'image', source: { data: refFor('claude-source-data', 4004) } }), 1001);
  });

  it('bypasses the tiktoken tokenizer for the payload', () => {
    // One token per character: 4000 chars read as text would count 4000 tokens.
    const tokenizer = { encode: (text: string) => Array.from(text) };
    const options = { tokenizer } as any;
    assert.equal(count({ type: 'text', text: 'x'.repeat(4000) }, options), 4000);
    assert.equal(count({ type: 'image', source: { data: refFor('claude-source-data', 4000) } }, options), 1000);
  });

  it('refuses a malformed ref instead of counting NaN', () => {
    const fractional = { ...refFor('claude-source-data', 4000), size: 1.5 };
    assert.throws(
      () => count({ type: 'image', source: { data: fractional } }),
      (error: any) => error instanceof BlobStoreError && /malformed ref/.test(error.message),
    );
    const noPrefix = { ...refFor('claude-source-data', 4000), prefix: undefined };
    assert.throws(() => count({ type: 'image', source: { data: noPrefix } }), BlobStoreError);
  });

  it('counts a ref in a block with no Claude block type as the payload, wherever it sits', () => {
    // A §5.4 allowlisted Chat position, a Gemini one, and a Responses one nested
    // two levels deep: none is a Claude block, so all three are counted by their
    // JSON text plus the payload each ref stands for.
    const positions: Record<string, any> = {
      chat: { type: 'image_url', image_url: { url: refFor('chat-image-url', 4000) } },
      gemini: { inline_data: { mime_type: 'image/png', data: refFor('gemini-inline-data', 4000, '') } },
      responses: { type: 'inline', source: { type: 'base64', data: refFor('responses-input-image', 4000) } },
    };
    for (const [name, block] of Object.entries(positions)) {
      assert.equal(
        count(block),
        1000 + estimateTokenCount(JSON.stringify(block)),
        `${name}: ceil(4000 / 4) for the payload, on top of the block's own text and nothing else`,
      );
    }
  });

  it('grows with the payload it stands for, not with the ref object', () => {
    // 4000 -> 4004 keeps the JSON text the same length, so the whole delta is the
    // payload: ceil(4004/4) - ceil(4000/4) = 1.
    const wide = { type: 'image_url', image_url: { url: refFor('chat-image-url', 4004) } };
    const narrow = { type: 'image_url', image_url: { url: refFor('chat-image-url', 4000) } };
    assert.equal(JSON.stringify(wide).length, JSON.stringify(narrow).length);
    assert.equal(count(wide) - count(narrow), 1);
  });

  it('still refuses a malformed ref in a block with no Claude block type', () => {
    const fractional = { type: 'image_url', image_url: { url: { ...refFor('chat-image-url', 4000), size: 1.5 } } };
    assert.throws(
      () => count(fractional),
      (error: any) => error instanceof BlobStoreError && /malformed ref/.test(error.message),
    );
  });

  it('counts a ref nested in tool_result content as binary', () => {
    const nested = { type: 'image', source: { data: refFor('claude-source-data', 4000) } };
    const withRef = count({ type: 'tool_result', tool_use_id: 'c', content: [nested] });
    const without = count({ type: 'tool_result', tool_use_id: 'c', content: [] });
    assert.equal(withRef - without, 1000);
  });

  it('contributes the same amount to a whole Claude request', () => {
    const withRef = countClaudeRequestTokens({
      messages: [{ role: 'user', content: [{ type: 'image', source: { data: refFor('claude-source-data', 8000) } }] }],
    });
    const without = countClaudeRequestTokens({ messages: [{ role: 'user', content: [] }] });
    assert.equal(withRef - without, 2000);
  });

  it('counts a payload that extraction actually recorded by the same rule', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'token-counting-spool-'));
    try {
      setSpoolConfig(resolveSpoolConfig({ enabled: true, dir }));
      resetBlobStore();

      const data = Buffer.alloc(48, 0x41).toString('base64');
      assert.equal(data.length, 64);
      const body: any = {
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data } }] }],
      };
      assert.equal((await extractInlineBlobs(body)).refs, 1);

      const block = body.messages[0].content[0];
      const ref = block.source.data;
      assert.ok(isBlobRef(ref));
      assert.equal(ref.size, data.length, 'size is the base64 character count');
      assert.equal(count(block), 16, 'ceil(64 / 4)');
    } finally {
      resetBlobStore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// countClaudeRequestTokens
// ---------------------------------------------------------------------------

describe('countClaudeRequestTokens', () => {
  it('counts a minimal request (messages only)', () => {
    const n = countClaudeRequestTokens({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(n, countMessagesTokens([{ role: 'user', content: 'hi' }]));
  });

  it('adds model, system, tools, tool_choice, and thinking contributions', () => {
    const base = countClaudeRequestTokens({ messages: [{ role: 'user', content: 'hi' }] });
    const full = countClaudeRequestTokens({
      model: 'claude-x',
      system: 'be terse',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'search', description: 'find', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'search' },
      thinking: { type: 'enabled', budget_tokens: 2048 } as any,
    });
    assert.ok(full > base, 'every extra section increases the count');
  });

  it('maps boolean thinking.type to enabled/disabled strings without throwing', () => {
    const enabled = countClaudeRequestTokens({
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: true } as any,
    });
    const disabled = countClaudeRequestTokens({
      messages: [{ role: 'user', content: 'hi' }],
      thinking: { type: false } as any,
    });
    assert.ok(enabled > 0 && disabled > 0);
  });
});

// ---------------------------------------------------------------------------
// getLocalTokenCountingConfig
// ---------------------------------------------------------------------------

describe('getLocalTokenCountingConfig', () => {
  it('is disabled by default', () => {
    const cfg = getLocalTokenCountingConfig({});
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.useTiktoken, false);
    assert.equal(cfg.modelName, 'o200k_base');
  });

  it('enables via LOCAL_TIKTOKEN="true" or "1"', () => {
    assert.equal(getLocalTokenCountingConfig({ LOCAL_TIKTOKEN: 'true' }).enabled, true);
    assert.equal(getLocalTokenCountingConfig({ LOCAL_TIKTOKEN: '1' }).enabled, true);
    assert.equal(getLocalTokenCountingConfig({ LOCAL_TIKTOKEN: 'yes' }).enabled, false);
  });

  it('reads TIKTOKEN_MODEL and TIKTOKEN_BPE_URL overrides', () => {
    const cfg = getLocalTokenCountingConfig({
      LOCAL_TIKTOKEN: '1',
      TIKTOKEN_MODEL: 'cl100k_base',
      TIKTOKEN_BPE_URL: 'http://x/bpe',
    });
    assert.equal(cfg.modelName, 'cl100k_base');
    assert.equal(cfg.bpeUrl, 'http://x/bpe');
  });
});

// ---------------------------------------------------------------------------
// getTiktokenTokenizer caching
// ---------------------------------------------------------------------------

describe('getTiktokenTokenizer', () => {
  it('returns the same cached instance for a repeated model name', async () => {
    const a = await getTiktokenTokenizer('cl100k_base');
    const b = await getTiktokenTokenizer('cl100k_base');
    assert.equal(a, b);
  });

  it('rebuilds the tokenizer when the model name changes', async () => {
    const a = await getTiktokenTokenizer('cl100k_base');
    const c = await getTiktokenTokenizer('o200k_base');
    assert.notEqual(a, c);
  });
});
