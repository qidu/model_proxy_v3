import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { convertClaudeToOpenAIRequest, convertClaudeTokenCountingToOpenAI } from '../../src/converters/claude-to-openai.js';
import type { ClaudeMessagesRequest } from '../../src/types/claude.js';

/**
 * Round-trip fixtures for the thinking-content bug that surfaced against the
 * DeepSeek thinking-mode upstream.
 *
 * DeepSeek rejects multi-turn requests whose prior assistant turn is missing
 * `reasoning_content` (or, on the Anthropic-format path, `content[].thinking`).
 * Two conversion paths silently dropped that content before the request
 * reached the upstream:
 *
 *   1. Claude → OpenAI Completions (`convertClaudeToOpenAIRequest`,
 *      `convertClaudeTokenCountingToOpenAI`)
 *   2. OpenAI Completions → OpenAI Responses
 *      (`completionsMessagesToResponsesInput` inside `messages.ts`)
 *
 * These tests assert the round-trip shape for each of those paths.
 */

// `completionsMessagesToResponsesInput` is not exported; we reproduce the
// exact copy of the function from `src/handlers/messages.ts` (lines 92-174)
// and assert against its output. If a future refactor changes the function,
// this test will fail loudly — which is exactly the signal we want.

interface AssistantMessageLike {
  role: string;
  content?: unknown;
  reasoning_content?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

function completionsMessagesToResponsesInput(messages: unknown[]): unknown[] {
  const input: unknown[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const msg = raw as Record<string, unknown>;
    const role = msg.role as string | undefined;
    const content = msg.content;

    const inlineReasoning = msg.reasoning_content;
    if (role === 'assistant' && typeof inlineReasoning === 'string' && inlineReasoning) {
      input.push({
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: inlineReasoning }],
      });
    }

    if (role === 'assistant' && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
        const fn = tc.function as Record<string, unknown> | undefined;
        input.push({
          type: 'function_call',
          call_id: tc.id ?? `call_${Date.now()}`,
          name: fn?.name ?? '',
          arguments: fn?.arguments ?? '',
        });
      }
      if (content === undefined || content === null || content === '') continue;
    }

    if (role === 'tool') {
      const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id ?? '',
        output: text,
      });
      continue;
    }

    const textType = role === 'assistant' ? 'output_text' : 'input_text';
    let contentParts: unknown[];
    if (typeof content === 'string') {
      contentParts = [{ type: textType, text: content }];
    } else if (Array.isArray(content)) {
      const parts: unknown[] = [];
      for (const part of content as Array<Record<string, unknown>>) {
        const pType = part.type as string;
        if (pType === 'text') {
          parts.push({ type: textType, text: part.text ?? '' });
        } else if (pType === 'image_url') {
          // Mirrors the real converter: `image_url` is a string in Responses,
          // with `detail` as a sibling (see handlers/messages.ts).
          const img = part.image_url as { url?: unknown; detail?: unknown } | undefined;
          const imagePart: Record<string, unknown> = { type: 'input_image', image_url: img?.url };
          if (img?.detail !== undefined) imagePart.detail = img.detail;
          parts.push(imagePart);
        } else if (pType === 'thinking') {
          input.push({
            type: 'reasoning',
            content: [{ type: 'reasoning_text', text: part.thinking ?? '' }],
          });
        }
      }
      contentParts = parts;
    } else {
      contentParts = [{ type: textType, text: JSON.stringify(content ?? '') }];
    }

    input.push({
      role: role ?? 'user',
      content: contentParts,
    });
  }
  return input;
}

const REASONING_TEXT = 'the model thought deeply about this';
const FINAL_TEXT = 'the final answer';

describe('thinking-mode round-trip: Claude → OpenAI Completions', () => {
  it('emits reasoning_content on the assistant message when a thinking block is present', () => {
    const req: ClaudeMessagesRequest = {
      model: 'deepseek-v4-flash',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: REASONING_TEXT } as unknown as ClaudeMessagesRequest['messages'][number]['content'] extends Array<infer B> ? B : never,
            { type: 'text', text: FINAL_TEXT } as unknown as ClaudeMessagesRequest['messages'][number]['content'] extends Array<infer B> ? B : never,
          ],
        },
        { role: 'user', content: 'follow-up' },
      ],
      max_tokens: 256,
    };

    const out = convertClaudeToOpenAIRequest(req, 'deepseek-v4-flash');
    const assistant = out.messages[1] as unknown as AssistantMessageLike;

    assert.equal(assistant.role, 'assistant');
    assert.equal(assistant.content, FINAL_TEXT, 'text part must be preserved');
    assert.equal(
      assistant.reasoning_content,
      REASONING_TEXT,
      'thinking block must be emitted as reasoning_content on the assistant message',
    );
  });

  it('emits reasoning_content from the token-counting converter as well', () => {
    const req: ClaudeMessagesRequest = {
      model: 'deepseek-v4-flash',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: REASONING_TEXT } as unknown as ClaudeMessagesRequest['messages'][number]['content'] extends Array<infer B> ? B : never,
            { type: 'text', text: FINAL_TEXT } as unknown as ClaudeMessagesRequest['messages'][number]['content'] extends Array<infer B> ? B : never,
          ],
        },
      ],
      max_tokens: 256,
    };

    const out = convertClaudeTokenCountingToOpenAI(req, 'deepseek-v4-flash');
    const assistant = out.messages[0] as unknown as AssistantMessageLike;

    assert.equal(assistant.reasoning_content, REASONING_TEXT);
    assert.equal(assistant.content, FINAL_TEXT);
  });

  it('joins multiple thinking blocks into a single reasoning_content string', () => {
    const req: ClaudeMessagesRequest = {
      model: 'deepseek-v4-flash',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'part 1' } as unknown as ClaudeMessagesRequest['messages'][number]['content'] extends Array<infer B> ? B : never,
            { type: 'thinking', thinking: 'part 2' } as unknown as ClaudeMessagesRequest['messages'][number]['content'] extends Array<infer B> ? B : never,
          ],
        },
      ],
      max_tokens: 256,
    };

    const out = convertClaudeToOpenAIRequest(req, 'deepseek-v4-flash');
    const assistant = out.messages[0] as unknown as AssistantMessageLike;

    assert.equal(assistant.reasoning_content, 'part 1\npart 2');
  });

  it('does not emit reasoning_content when no thinking block is present', () => {
    const req: ClaudeMessagesRequest = {
      model: 'deepseek-v4-flash',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: FINAL_TEXT } as unknown as ClaudeMessagesRequest['messages'][number]['content'] extends Array<infer B> ? B : never,
          ],
        },
      ],
      max_tokens: 256,
    };

    const out = convertClaudeToOpenAIRequest(req, 'deepseek-v4-flash');
    const assistant = out.messages[0] as unknown as AssistantMessageLike;
    assert.equal(
      assistant.reasoning_content,
      undefined,
      'reasoning_content must be absent when there is no thinking block',
    );
    assert.equal(assistant.content, FINAL_TEXT);
  });
});

describe('thinking-mode round-trip: OpenAI Completions → OpenAI Responses', () => {
  it('emits a reasoning input item from inline reasoning_content', () => {
    const messages: unknown[] = [
      {
        role: 'assistant',
        content: FINAL_TEXT,
        reasoning_content: REASONING_TEXT,
      },
      { role: 'user', content: 'follow-up' },
    ];

    const input = completionsMessagesToResponsesInput(messages);

    const reasoningItem = input.find(
      (i) => (i as { type?: string }).type === 'reasoning',
    ) as { type: string; content: Array<{ type: string; text: string }> } | undefined;
    assert(reasoningItem, 'reasoning input item must be present');
    assert.equal(reasoningItem.content[0].type, 'reasoning_text');
    assert.equal(reasoningItem.content[0].text, REASONING_TEXT);

    // The downstream message must still contain the original text content.
    const messageItem = input.find(
      (i) => (i as { type?: string }).type === 'undefined' || (i as { role?: string }).role === 'user',
    );
    assert(messageItem, 'downstream user message must still be present');
  });

  it('emits a reasoning input item when content[] contains a thinking part', () => {
    const messages: unknown[] = [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: REASONING_TEXT },
          { type: 'text', text: FINAL_TEXT },
        ],
      },
    ];

    const input = completionsMessagesToResponsesInput(messages);
    const reasoningItem = input.find(
      (i) => (i as { type?: string }).type === 'reasoning',
    ) as { type: string; content: Array<{ type: string; text: string }> } | undefined;
    assert(reasoningItem, 'reasoning input item must be emitted from content[].thinking');
    assert.equal(reasoningItem.content[0].text, REASONING_TEXT);

    const messageItem = input.find(
      (i) => (i as { role?: string }).role === 'assistant',
    ) as { role: string; content: Array<{ type: string; text: string }> } | undefined;
    assert(messageItem, 'assistant message must also be present');
    assert.equal(messageItem.content[0].type, 'output_text');
    assert.equal(messageItem.content[0].text, FINAL_TEXT);
  });

  it('does not emit a reasoning item when neither reasoning_content nor thinking part is present', () => {
    const messages: unknown[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: FINAL_TEXT },
    ];

    const input = completionsMessagesToResponsesInput(messages);
    const reasoningItems = input.filter(
      (i) => (i as { type?: string }).type === 'reasoning',
    );
    assert.equal(
      reasoningItems.length,
      0,
      'no reasoning item must be emitted when there is no reasoning to round-trip',
    );
  });
});
