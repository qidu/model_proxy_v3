import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { convertClaudeToGeminiRequest } from '../../src/converters/claude-to-gemini.js';
import type { ClaudeMessagesRequest } from '../../src/types/claude.js';

/**
 * Direct field-level coverage for the Claude -> Gemini generateContent request
 * converter. Only `convertClaudeToGeminiRequest` is exported from the module;
 * the remaining helpers are internal and are exercised through it.
 */

describe('convertClaudeToGeminiRequest', () => {
  it('maps a string user message to a user content part', () => {
    const req = {
      model: 'gemini',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.contents, [
      { role: 'user', parts: [{ text: 'hello' }] },
    ]);
  });

  it("maps assistant role to 'model'", () => {
    const req = {
      model: 'gemini',
      messages: [{ role: 'assistant', content: 'sure' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.equal(out.contents[0].role, 'model');
  });

  it('maps text and image blocks in array content', () => {
    const req = {
      model: 'gemini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'ABC' },
            },
          ],
        },
      ],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.contents[0].parts, [
      { text: 'look' },
      { inline_data: { mime_type: 'image/png', data: 'ABC' } },
    ]);
  });

  it('drops messages whose content produces no parts', () => {
    const req = {
      model: 'gemini',
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
        { role: 'user', content: 'kept' },
      ],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.equal(out.contents.length, 1, 'the thinking-only message is skipped');
    assert.deepEqual(out.contents[0], { role: 'user', parts: [{ text: 'kept' }] });
  });

  it('emits system_instruction from a string system prompt', () => {
    const req = {
      model: 'gemini',
      system: 'be terse',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.system_instruction, { parts: [{ text: 'be terse' }] });
  });

  it('maps temperature and max_tokens into generation_config', () => {
    const req = {
      model: 'gemini',
      temperature: 0.4,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.generation_config, {
      temperature: 0.4,
      max_output_tokens: 256,
    });
  });

  it('omits generation_config when neither temperature nor max_tokens is set', () => {
    const req = {
      model: 'gemini',
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.equal(out.generation_config, undefined);
  });

  it('passes through cached_content as cachedContent', () => {
    const req = {
      model: 'gemini',
      cached_content: 'cache-key',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.equal(out.cachedContent, 'cache-key');
  });
});

describe('convertClaudeToGeminiRequest — tools', () => {
  const weatherTool = {
    name: 'get_weather',
    description: '查询天气',
    input_schema: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { city: { type: 'string', format: 'uri' } },
      required: ['city'],
    },
  };

  it('maps Claude tools into one functionDeclarations group with a Gemini-clean schema', () => {
    const req = {
      model: 'gemini',
      tools: [weatherTool],
      messages: [{ role: 'user', content: '杭州今天天气如何' }],
      max_tokens: 512,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.tools, [{
      functionDeclarations: [{
        name: 'get_weather',
        description: '查询天气',
        parameters: {
          type: 'object',
          // $schema and the unsupported string `format` are stripped.
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      }],
    }]);
  });

  it('omits tools entirely when the request has none', () => {
    const req = {
      model: 'gemini',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.equal(out.tools, undefined);
    assert.equal(out.toolConfig, undefined);
  });

  it('defaults a missing description to an empty string and a missing schema to an empty object schema', () => {
    const req = {
      model: 'gemini',
      tools: [{ name: 'ping' }],
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.tools[0].functionDeclarations[0], {
      name: 'ping',
      description: '',
      parameters: { type: 'object', properties: {} },
    });
  });

  it('throws rather than dropping a tool that has no name', () => {
    const req = {
      model: 'gemini',
      tools: [{ description: 'nameless' }],
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    assert.throws(
      () => convertClaudeToGeminiRequest(req),
      /missing "name"/,
      'Rule #8 — a silently dropped tool leaves the model unable to call it',
    );
  });

  it('maps tool_choice auto/any/none to AUTO/ANY/NONE and tool to ANY + allowedFunctionNames', () => {
    const cases: Array<[unknown, unknown]> = [
      [{ type: 'auto' }, { mode: 'AUTO' }],
      [{ type: 'any' }, { mode: 'ANY' }],
      [{ type: 'none' }, { mode: 'NONE' }],
      [{ type: 'tool', name: 'get_weather' }, { mode: 'ANY', allowedFunctionNames: ['get_weather'] }],
    ];

    for (const [toolChoice, expected] of cases) {
      const req = {
        model: 'gemini',
        tools: [weatherTool],
        tool_choice: toolChoice,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 10,
      } as unknown as ClaudeMessagesRequest;

      const out = convertClaudeToGeminiRequest(req) as any;
      assert.deepEqual(out.toolConfig, { functionCallingConfig: expected });
    }
  });

  it('maps an assistant tool_use block to a functionCall part, carrying the tool_use id', () => {
    const req = {
      model: 'gemini',
      messages: [
        { role: 'user', content: '杭州今天天气如何' },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '杭州' } }],
        },
      ],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.contents[1], {
      role: 'model',
      parts: [{ functionCall: { id: 'toolu_1', name: 'get_weather', args: { city: '杭州' } } }],
    });
  });

  it('maps a user tool_result block to a functionResponse carrying the matching tool_use id and name', () => {
    const req = {
      model: 'gemini',
      messages: [
        { role: 'user', content: '杭州今天天气如何' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'let me check' },
            { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: '杭州' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: '晴，26°C' }],
        },
      ],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.contents[2], {
      role: 'user',
      parts: [{ functionResponse: { id: 'toolu_1', name: 'get_weather', response: { content: '晴，26°C' } } }],
    });
  });

  it('omits empty tool_use and tool_result ids', () => {
    const req = {
      model: 'gemini',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: '', name: 'get_weather', input: {} }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: '', content: 'sunny' }],
        },
      ],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    const functionCall = out.contents[0].parts[0].functionCall;
    const functionResponse = out.contents[1].parts[0].functionResponse;
    assert.equal('id' in functionCall, false);
    assert.equal('id' in functionResponse, false);
  });

  it('stringifies a structured tool_result content array into the functionResponse text', () => {
    const req = {
      model: 'gemini',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tid', name: 'f', input: {} }] },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tid',
            content: [{ type: 'text', text: 'part-a' }, { type: 'text', text: 'part-b' }],
          }],
        },
      ],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = convertClaudeToGeminiRequest(req) as any;
    assert.equal(
      out.contents[2].parts[0].functionResponse.response.content,
      JSON.stringify([{ type: 'text', text: 'part-a' }, { type: 'text', text: 'part-b' }]),
    );
  });

  it('throws on a tool_result whose tool_use_id is unknown', () => {
    const req = {
      model: 'gemini',
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'x' }],
      }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    assert.throws(
      () => convertClaudeToGeminiRequest(req),
      /no preceding tool_use block carries that id/,
      'Rule #8 — Gemini rejects a nameless functionResponse anyway',
    );
  });
});
