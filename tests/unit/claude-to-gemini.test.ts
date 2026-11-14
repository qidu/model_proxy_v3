import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import { convertClaudeToGeminiRequest } from '../../src/converters/claude-to-gemini.js';
import type { ClaudeMessagesRequest } from '../../src/types/claude.js';

const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; });

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
 * Direct field-level coverage for the Claude -> Gemini generateContent request
 * converter. Only `convertClaudeToGeminiRequest` is exported from the module;
 * the remaining helpers are internal and are exercised through it.
 */

describe('convertClaudeToGeminiRequest', async () => {
  it('maps a string user message to a user content part', async () => {
    const req = {
      model: 'gemini',
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.contents, [
      { role: 'user', parts: [{ text: 'hello' }] },
    ]);
  });

  it("maps assistant role to 'model'", async () => {
    const req = {
      model: 'gemini',
      messages: [{ role: 'assistant', content: 'sure' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.equal(out.contents[0].role, 'model');
  });

  it('maps text and image blocks in array content', async () => {
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

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.contents[0].parts, [
      { text: 'look' },
      { inline_data: { mime_type: 'image/png', data: 'ABC' } },
    ]);
  });

  it('drops messages whose content produces no parts', async () => {
    const req = {
      model: 'gemini',
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] },
        { role: 'user', content: 'kept' },
      ],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.equal(out.contents.length, 1, 'the thinking-only message is skipped');
    assert.deepEqual(out.contents[0], { role: 'user', parts: [{ text: 'kept' }] });
  });

  it('fetches an http(s) image block into inline_data (a generateContent part has no URL slot)', async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: any) => {
      requested.push(String(input));
      return new Response(new Uint8Array([104, 105]), {
        status: 200,
        headers: { 'content-type': 'image/webp' },
      });
    }) as typeof fetch;

    const req = {
      model: 'gemini',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image', source: { type: 'url', url: 'https://example.com/cat.webp' } },
        ],
      }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(requested, ['https://example.com/cat.webp'], 'the URL is fetched server-side');
    assert.deepEqual(out.contents[0].parts, [
      { text: 'look' },
      { inline_data: { mime_type: 'image/webp', data: Buffer.from('hi').toString('base64') } },
    ]);
  });

  it('rejects a URL image block that carries no url, rather than sending an empty inline_data part', async () => {
    const req = {
      model: 'gemini',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url' } }] }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    await assert.rejects(
      async () => await convertClaudeToGeminiRequest(req),
      /no source\.url/,
    );
  });

  it('emits system_instruction from a string system prompt', async () => {
    const req = {
      model: 'gemini',
      system: 'be terse',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.system_instruction, { parts: [{ text: 'be terse' }] });
  });

  it('maps temperature and max_tokens into generation_config', async () => {
    const req = {
      model: 'gemini',
      temperature: 0.4,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.generation_config, {
      temperature: 0.4,
      max_output_tokens: 256,
    });
  });

  it('omits generation_config when neither temperature nor max_tokens is set', async () => {
    const req = {
      model: 'gemini',
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.equal(out.generation_config, undefined);
  });

  it('maps an enabled thinking budget to thinking_config with include_thoughts', async () => {
    const req = {
      model: 'gemini',
      thinking: { type: 'enabled', budget_tokens: 8192 },
      max_tokens: 16384,
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.generation_config, {
      max_output_tokens: 16384,
      thinking_config: { include_thoughts: true, thinking_budget: 8192 },
    });
  });

  it('omits thinking_budget for an enabled thinking config with no budget (upstream dynamic)', async () => {
    const req = {
      model: 'gemini',
      thinking: { type: 'enabled' },
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.generation_config, { thinking_config: { include_thoughts: true } });
  });

  it('sends no thinking_config for a disabled thinking config, and no config when nothing else is set', async () => {
    const req = {
      model: 'gemini',
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.equal(out.generation_config, undefined);
  });

  it('maps stop_sequences to generation_config.stop_sequences', async () => {
    const req = {
      model: 'gemini',
      stop_sequences: ['\n\nHuman:', 'END'],
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.generation_config, { stop_sequences: ['\n\nHuman:', 'END'] });
  });

  it('omits an empty stop_sequences list rather than sending stop_sequences: []', async () => {
    const req = {
      model: 'gemini',
      stop_sequences: [],
      messages: [{ role: 'user', content: 'hi' }],
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.equal(out.generation_config, undefined);
  });

  it('reports cache_control hints on tools, system blocks, and message content as ignored', async () => {
    const { logger, warnings } = recordingLogger();
    const req = {
      model: 'gemini',
      tools: [{
        name: 'get_weather',
        input_schema: { type: 'object', properties: {} },
        cache_control: { type: 'ephemeral' },
      }],
      system: [{ type: 'text', text: 'be terse', cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }],
      }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req, undefined, { logger, requestId: 'rid' }) as any;
    assert.equal(JSON.stringify(out).includes('cache_control'), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ignored 3 cache hint\(s\)/);
    assert.match(warnings[0], /tools\[0\]/);
    assert.match(warnings[0], /system\[0\]/);
    assert.match(warnings[0], /messages\[0\]\.content\[0\]/);
  });

  it('passes through cached_content as cachedContent', async () => {
    const req = {
      model: 'gemini',
      cached_content: 'cache-key',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.equal(out.cachedContent, 'cache-key');
  });
});

describe('convertClaudeToGeminiRequest — tools', async () => {
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

  it('maps Claude tools into one functionDeclarations group with a Gemini-clean schema', async () => {
    const req = {
      model: 'gemini',
      tools: [weatherTool],
      messages: [{ role: 'user', content: '杭州今天天气如何' }],
      max_tokens: 512,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
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

  it('omits tools entirely when the request has none', async () => {
    const req = {
      model: 'gemini',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.equal(out.tools, undefined);
    assert.equal(out.toolConfig, undefined);
  });

  it('defaults a missing description to an empty string and a missing schema to an empty object schema', async () => {
    const req = {
      model: 'gemini',
      tools: [{ name: 'ping' }],
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.tools[0].functionDeclarations[0], {
      name: 'ping',
      description: '',
      parameters: { type: 'object', properties: {} },
    });
  });

  it('throws rather than dropping a tool that has no name', async () => {
    const req = {
      model: 'gemini',
      tools: [{ description: 'nameless' }],
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    await assert.rejects(
      async () => await convertClaudeToGeminiRequest(req),
      /missing "name"/,
      'Rule #8 — a silently dropped tool leaves the model unable to call it',
    );
  });

  it('maps tool_choice auto/any/none to AUTO/ANY/NONE and tool to ANY + allowedFunctionNames', async () => {
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

      const out = await convertClaudeToGeminiRequest(req) as any;
      assert.deepEqual(out.toolConfig, { functionCallingConfig: expected });
    }
  });

  it('rejects a forced tool_choice that carries no name instead of widening to ANY', async () => {
    const req = {
      model: 'gemini',
      tools: [weatherTool],
      tool_choice: { type: 'tool' },
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    await assert.rejects(
      async () => await convertClaudeToGeminiRequest(req),
      /forced-tool form has no "name"/,
      'Rule #8 — ANY without an allow-list would let the model call a different tool',
    );
  });

  it('rejects an unrecognized tool_choice type instead of emitting no toolConfig at all', async () => {
    const req = {
      model: 'gemini',
      tools: [weatherTool],
      tool_choice: { type: 'sometimes' },
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    await assert.rejects(
      async () => await convertClaudeToGeminiRequest(req),
      /Cannot convert tool_choice .* to a Gemini functionCallingConfig/,
      'Rule #8 — no toolConfig means free choice for a client that asked to constrain it',
    );
  });

  it('reports tool_choice.disable_parallel_tool_use, which generateContent cannot express', async () => {
    const { logger, warnings } = recordingLogger();
    const req = {
      model: 'gemini',
      tools: [weatherTool],
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req, undefined, { logger, requestId: 'rid' }) as any;
    assert.deepEqual(out.toolConfig, { functionCallingConfig: { mode: 'AUTO' } });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /disable_parallel_tool_use has no generateContent equivalent/);
  });

  it('reports a Claude server tool, which is declared as a nameless-parameter function', async () => {
    const { logger, warnings } = recordingLogger();
    const req = {
      model: 'gemini',
      tools: [
        { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
        weatherTool,
      ],
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req, undefined, { logger, requestId: 'rid' }) as any;

    // Current behaviour, now reported rather than silent: the server tool is
    // declared as an ordinary function with an empty parameter schema.
    assert.deepEqual(out.tools[0].functionDeclarations[0], {
      name: 'web_search',
      description: '',
      parameters: { type: 'object', properties: {} },
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /server tool\(s\) have no generateContent equivalent .*: web_search\(web_search_20250305\)$/);
  });

  it('maps an assistant tool_use block to a functionCall part, carrying the tool_use id', async () => {
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

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.contents[1], {
      role: 'model',
      parts: [{ functionCall: { id: 'toolu_1', name: 'get_weather', args: { city: '杭州' } } }],
    });
  });

  it('maps a user tool_result block to a functionResponse carrying the matching tool_use id and name', async () => {
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

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.contents[2], {
      role: 'user',
      parts: [{ functionResponse: { id: 'toolu_1', name: 'get_weather', response: { content: '晴，26°C' } } }],
    });
  });

  it('omits empty tool_use and tool_result ids', async () => {
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

    const out = await convertClaudeToGeminiRequest(req) as any;
    const functionCall = out.contents[0].parts[0].functionCall;
    const functionResponse = out.contents[1].parts[0].functionResponse;
    assert.equal('id' in functionCall, false);
    assert.equal('id' in functionResponse, false);
  });

  it('stringifies a structured tool_result content array into the functionResponse text', async () => {
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

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.equal(
      out.contents[2].parts[0].functionResponse.response.content,
      JSON.stringify([{ type: 'text', text: 'part-a' }, { type: 'text', text: 'part-b' }]),
    );
  });

  it('throws on a tool_result whose tool_use_id is unknown', async () => {
    const req = {
      model: 'gemini',
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'x' }],
      }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    await assert.rejects(
      async () => await convertClaudeToGeminiRequest(req),
      /no preceding tool_use block carries that id/,
      'Rule #8 — Gemini rejects a nameless functionResponse anyway',
    );
  });
});
