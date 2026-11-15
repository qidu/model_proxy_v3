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

  it('emits system_instruction from an array system prompt, concatenated exactly', async () => {
    // The array form is the canonical shape for a client that marks a cache
    // breakpoint (`{type:'text', text, cache_control}`). It used to be dropped
    // whole, so the upstream answered a conversation with no system prompt.
    const req = {
      model: 'gemini',
      system: [
        { type: 'text', text: 'be ', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'terse' },
      ],
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    // Concatenated with no separator: the exact prompt the client wrote, not one
    // with a newline the model never saw.
    assert.deepEqual(out.system_instruction, { parts: [{ text: 'be terse' }] });
    assert.equal(JSON.stringify(out.system_instruction).includes('cache_control'), false);
  });

  it('refuses a non-text system block instead of dropping it', async () => {
    // Claude's `system` declares text blocks only, so this body is malformed —
    // and a silently shortened system prompt changes the answer (rule #8).
    const req = {
      model: 'gemini',
      system: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    await assert.rejects(
      async () => await convertClaudeToGeminiRequest(req),
      /system\[0\] of type "image"/,
    );
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

  it('counts the top-level cache_control, which marks the last cacheable block', async () => {
    // review_fixes.md #25: the request-level field (`messages-create.md:2372`) applies
    // a marker to the last cacheable block, and the sweep looked only at tools,
    // system blocks and message content — so it was dropped without a mention.
    const { logger, warnings } = recordingLogger();
    const req = {
      model: 'gemini',
      cache_control: { type: 'ephemeral' },
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    await convertClaudeToGeminiRequest(req, undefined, { logger, requestId: 'rid' });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ignored 1 cache hint\(s\) at top-level cache_control/);
  });

  it('counts and strips the cache markers nested inside a tool_result', async () => {
    // review_fixes.md #25: `ToolResultBlockParam.content` is an array of blocks, each
    // with its own marker (`messages-create.md:771-779`). The sweep did not descend,
    // and the blocks were stringified into `functionResponse` as they stood — so a
    // marker the log called "ignored" reached the upstream.
    const { logger, warnings } = recordingLogger();
    const req = {
      model: 'gemini',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} }] },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            content: [
              { type: 'text', text: 'sunny', cache_control: { type: 'ephemeral' } },
              { type: 'text', text: '22C', cache_control: { type: 'ephemeral' } },
            ],
          }],
        },
      ],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req, undefined, { logger, requestId: 'rid' }) as any;

    const serialized = out.contents[1].parts[0].functionResponse.response.content;
    assert.deepEqual(JSON.parse(serialized), [{ type: 'text', text: 'sunny' }, { type: 'text', text: '22C' }],
      'the result text must survive the marker strip');
    assert.equal(serialized.includes('cache_control'), false,
      'a marker the log calls "ignored" must not reach the upstream');

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /ignored 2 cache hint\(s\)/);
    assert.match(warnings[0], /messages\[1\]\.content\[0\]\.content\[0\]/);
    assert.match(warnings[0], /messages\[1\]\.content\[0\]\.content\[1\]/);
  });

  it('does not report a custom client tool as a server tool', async () => {
    // review_fixes.md #25: `Tool.type` is `optional "custom"` on an ordinary client
    // tool (`messages-create.md:2823`), so the "declares a `type` and no
    // input_schema" test caught every tool the spec lets a client declare that way
    // and told the operator a loss had occurred where there is none.
    const { logger, warnings } = recordingLogger();
    const req = {
      model: 'gemini',
      tools: [{
        type: 'custom',
        name: 'get_weather',
        description: 'weather',
        input_schema: { type: 'object', properties: { city: { type: 'string' } } },
      }],
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req, undefined, { logger, requestId: 'rid' }) as any;

    assert.deepEqual(out.tools[0].functionDeclarations[0], {
      name: 'get_weather',
      description: 'weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    });
    assert.deepEqual(warnings, [], 'a custom client tool is a plain function here — nothing was lost');
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

  /**
   * Findings #7 of `review_fixes.md`: every Content block outside
   * text/image/tool_use/tool_result fell into `// Skip other block types`, with no
   * count and no log — and when a turn was made only of those, the turn itself
   * disappeared, so the upstream answered a conversation the client never sent.
   */
  it('reports the blocks it cannot project, by kind and count', async () => {
    const { logger, warnings } = recordingLogger();
    const req = {
      model: 'gemini',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'summarise this' },
            { type: 'search_result', source: 'a', title: 'A', content: [] },
            { type: 'search_result', source: 'b', title: 'B', content: [] },
          ],
        },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'weighing it up', signature: 'sig' }] },
      ],
    } as unknown as ClaudeMessagesRequest;

    // The thinking-only turn has nothing left, so it cannot be sent. That is
    // reported rather than refused — see the case below — and the report must name
    // what went, per kind and per turn.
    const out = await convertClaudeToGeminiRequest(req, undefined, { logger, requestId: 'rid' }) as any;
    assert.deepEqual(out.contents, [{ role: 'user', parts: [{ text: 'summarise this' }] }]);

    const report = warnings.find(w => /no generateContent equivalent/.test(w));
    assert.ok(report, `expected a drop report, got: ${JSON.stringify(warnings)}`);
    assert.match(report!, /search_result ×2/);
    assert.match(report!, /thinking ×1/);
    // And a second line for the turn that could not be sent at all.
    assert.match(warnings.join('\n'), /messages\[1\] would carry nothing \(thinking ×1\)/);
  });

  it('keeps the parts it can project when a turn mixes known and unknown blocks', async () => {
    const { logger, warnings } = recordingLogger();
    const req = {
      model: 'gemini',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'summarise this' },
          { type: 'thinking', thinking: 'weighing it up', signature: 'sig' },
        ],
      }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req, undefined, { logger, requestId: 'rid' }) as any;
    assert.deepEqual(out.contents, [{ role: 'user', parts: [{ text: 'summarise this' }] }]);
    assert.match(warnings.join('\n'), /thinking ×1/);
  });

  it('reports a turn it has to omit, naming the index and the kinds it lost', async () => {
    // The turn used to disappear with nothing said. It still cannot be sent — but
    // the omission is now recorded, so a shorter conversation than the client wrote
    // is visible in the log (rule #8). Reported rather than refused: a
    // thinking-only turn contributes nothing visible, and failing the whole request
    // over one would turn a degradation into a 400 on live Claude Code traffic.
    const { logger, warnings } = recordingLogger();
    const req = {
      model: 'gemini',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'answer' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm', signature: 'sig' }] },
        { role: 'user', content: 'still here' },
      ],
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req, undefined, { logger, requestId: 'rid' }) as any;
    assert.deepEqual(out.contents.map((c: any) => c.parts[0]), [{ text: 'hi' }, { text: 'answer' }, { text: 'still here' }],
      'the three turns that can be projected are still sent, in order');

    assert.match(warnings.join('\n'), /messages\[2\] would carry nothing \(thinking ×1\) — the turn is omitted/,
      'the omitted turn must be reported by index and by kind');
  });

  /**
   * Finding #7b: a `document` block was one of the kinds the report above counted,
   * and it was the wrong call — generateContent's own document form *is*
   * `inline_data` with the file's MIME type (`list_of_api_and_schema.md:230`), so
   * three of the API's four sources project exactly.
   */
  it('projects a base64 document as inline_data, the shape generateContent declares', async () => {
    const req = {
      model: 'gemini',
      messages: [{
        role: 'user',
        content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } }],
      }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    // The turn whose only block this was used to be omitted entirely.
    assert.deepEqual(out.contents, [{
      role: 'user',
      parts: [{ inline_data: { mime_type: 'application/pdf', data: 'JVBERi0=' } }],
    }]);
  });

  it('keeps a §5.4 ref at the inline_data position rather than reading it as base64', async () => {
    const ref = {
      $spoolBlob: true,
      kind: 'claude-source-data',
      hash: 'a'.repeat(64),
      size: 8,
      prefix: '',
    };
    const req = {
      model: 'gemini',
      messages: [{
        role: 'user',
        content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: ref } }],
      }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    const data = out.contents[0].parts[0].inline_data.data;
    assert.equal(data.hash, ref.hash, 'the payload must not be expanded here');
    assert.equal(data.kind, 'gemini-inline-data', 'the ref is rebound to the position it now occupies');
  });

  it('projects a text document as a text part, not as a file', async () => {
    const req = {
      model: 'gemini',
      messages: [{
        role: 'user',
        content: [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'the whole report' } }],
      }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(out.contents, [{ role: 'user', parts: [{ text: 'the whole report' }] }]);
  });

  it('fetches a document URL through the same SSRF-guarded fetch the image path uses', async () => {
    const requested: string[] = [];
    globalThis.fetch = (async (input: any) => {
      requested.push(String(input));
      return new Response(new Uint8Array([37, 80, 68, 70]), {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    }) as typeof fetch;

    const req = {
      model: 'gemini',
      messages: [{
        role: 'user',
        content: [{ type: 'document', source: { type: 'url', url: 'https://example.com/report.pdf' } }],
      }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    const out = await convertClaudeToGeminiRequest(req) as any;
    assert.deepEqual(requested, ['https://example.com/report.pdf'], 'the URL is fetched server-side');
    assert.deepEqual(out.contents, [{
      role: 'user',
      parts: [{ inline_data: { mime_type: 'application/pdf', data: Buffer.from('%PDF').toString('base64') } }],
    }]);
  });

  it('refuses a document composed from content blocks, which has no position here', async () => {
    // The fourth source form. Unlike the other three it is not a file at all — it is
    // a document the client assembled — and generateContent has no part that means
    // "a document made of these blocks", so flattening it into its parts would send
    // something the client did not ask for.
    const req = {
      model: 'gemini',
      messages: [{
        role: 'user',
        content: [{
          type: 'document',
          source: { type: 'content', content: [{ type: 'text', text: 'assembled' }] },
        }],
      }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    await assert.rejects(
      async () => await convertClaudeToGeminiRequest(req),
      /ContentBlockSource source.*no position for a document composed from other content blocks/,
    );
  });

  it('refuses a document source the API does not declare, naming it', async () => {
    const req = {
      model: 'gemini',
      messages: [{
        role: 'user',
        content: [{ type: 'document', source: { type: 'ftp', url: 'ftp://x/y.pdf' } }],
      }],
      max_tokens: 10,
    } as unknown as ClaudeMessagesRequest;

    await assert.rejects(
      async () => await convertClaudeToGeminiRequest(req),
      /source\.type "ftp"/,
    );
  });
});
