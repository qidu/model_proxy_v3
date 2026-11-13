/**
 * Unit tests for the pure transformation helpers exported from the four big
 * handlers (claude.ts, openai.ts, gemini.ts, responses.ts).
 *
 * The full request/response cycles in these handlers are exercised end-to-end
 * by ./tests/integration (integration). Here we cover the exported pure functions
 * that contain the testable conversion/decision logic:
 *   - openai.ts: completionsToClaudeBody, completionsToResponsesBody,
 *                claudeJsonToSyntheticCompletions, convertGeminiGenerateContentToOpenAI
 *   - gemini.ts: isGeminiRequest
 *
 * Run with: npx tsx --test tests/unit/handlers.test.ts
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  completionsToClaudeBody,
  completionsToResponsesBody,
  claudeJsonToSyntheticCompletions,
  convertGeminiGenerateContentToOpenAI,
} from '../../src/handlers/openai.js';
import { isGeminiRequest } from '../../src/handlers/gemini.js';
import type { Logger } from '../../src/types/shared.js';

// ---------------------------------------------------------------------------
// completionsToClaudeBody
// ---------------------------------------------------------------------------

describe('completionsToClaudeBody', () => {
  it('converts a basic user message', async () => {
    const body = await completionsToClaudeBody({
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    }, 'claude-target');
    assert.equal(body.model, 'claude-target');
    assert.equal(body.max_tokens, 100);
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  });

  it('defaults max_tokens to 4096 when missing', async () => {
    const body = await completionsToClaudeBody({
      messages: [{ role: 'user', content: 'hi' }],
    } as any, 'm');
    assert.equal(body.max_tokens, 4096);
  });

  it('reads max_completion_tokens when max_tokens is absent', async () => {
    const body = await completionsToClaudeBody({
      messages: [{ role: 'user', content: 'hi' }],
      max_completion_tokens: 1234,
    } as any, 'm');
    assert.equal(body.max_tokens, 1234);
  });

  it('prefers max_tokens over max_completion_tokens when both are present', async () => {
    const body = await completionsToClaudeBody({
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 777,
      max_completion_tokens: 1234,
    } as any, 'm');
    assert.equal(body.max_tokens, 777);
  });

  it('extracts the system message into top-level system field', async () => {
    const body = await completionsToClaudeBody({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'q' },
      ],
    } as any, 'm');
    assert.equal(body.system, 'be brief');
    assert.equal((body.messages as any[]).length, 1);
    assert.equal((body.messages as any[])[0].role, 'user');
  });

  it('maps tool_calls + tool results into Claude tool_use / tool_result blocks', async () => {
    const body = await completionsToClaudeBody({
      messages: [
        { role: 'user', content: 'do thing' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{
            id: 'call_1', type: 'function',
            function: { name: 'do_thing', arguments: '{"x":1}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'result-text' },
      ],
    } as any, 'm');

    const msgs = body.messages as any[];
    // [user, assistant(tool_use), user(tool_result)]
    assert.equal(msgs.length, 3);
    assert.deepEqual(msgs[1], {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'call_1', name: 'do_thing', input: { x: 1 } }],
    });
    assert.deepEqual(msgs[2], {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'result-text' }],
    });
  });

  it('groups consecutive tool messages into a single user message', async () => {
    const body = await completionsToClaudeBody({
      messages: [
        {
          role: 'assistant', content: '',
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'r1' },
        { role: 'tool', tool_call_id: 'c2', content: 'r2' },
      ],
    } as any, 'm');
    const msgs = body.messages as any[];
    // assistant with both tool_use blocks, then ONE user with both tool_results
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].content.length, 2);
    assert.equal(msgs[1].role, 'user');
    assert.equal(msgs[1].content.length, 2);
  });

  it('preserves reasoning_content as a thinking block on assistant turns', async () => {
    const body = await completionsToClaudeBody({
      messages: [{
        role: 'assistant', content: 'answer',
        reasoning_content: 'pondering',
      }],
    } as any, 'm');
    const m = (body.messages as any[])[0];
    assert.equal(m.role, 'assistant');
    assert.deepEqual(m.content, [
      { type: 'thinking', thinking: 'pondering' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('maps OpenAI tools array to Claude tools', async () => {
    const body = await completionsToClaudeBody({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{
        type: 'function',
        function: { name: 'search', description: 'search the web', parameters: { type: 'object' } },
      }],
    } as any, 'm');
    assert.deepEqual(body.tools, [{
      name: 'search',
      description: 'search the web',
      input_schema: { type: 'object' },
    }]);
  });

  it('maps stop (string or array) to stop_sequences', async () => {
    const a = await completionsToClaudeBody({
      messages: [{ role: 'user', content: 'x' }], stop: 'END',
    } as any, 'm');
    assert.deepEqual(a.stop_sequences, ['END']);

    const b = await completionsToClaudeBody({
      messages: [{ role: 'user', content: 'x' }], stop: ['A', 'B'],
    } as any, 'm');
    assert.deepEqual(b.stop_sequences, ['A', 'B']);
  });

  it('forwards temperature and top_p when present', async () => {
    const body = await completionsToClaudeBody({
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.5, top_p: 0.9,
    } as any, 'm');
    assert.equal(body.temperature, 0.5);
    assert.equal(body.top_p, 0.9);
  });

  it('parses tool_call arguments JSON; invalid falls back gracefully', async () => {
    const body = await completionsToClaudeBody({
      messages: [{
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'a', arguments: 'not-json' },
        }],
      }],
    } as any, 'm');
    // parseJsonObject returns {} on invalid JSON
    assert.deepEqual((body.messages as any[])[0].content[0].input, {});
  });
});

// ---------------------------------------------------------------------------
// completionsToClaudeBody — image_url -> Claude image blocks
// ---------------------------------------------------------------------------

describe('completionsToClaudeBody — image conversion', () => {
  const realFetch = globalThis.fetch;

  after(() => { globalThis.fetch = realFetch; });

  it('decodes data: URI image_url into a Claude image block', async () => {
    const body = await completionsToClaudeBody({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        ],
      }],
    } as any, 'm');
    const m = (body.messages as any[])[0];
    assert.equal(m.role, 'user');
    assert.deepEqual(m.content, [
      { type: 'text', text: 'look at this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ]);
  });

  it('collapses a text-only array back to a string (preserves wire shape)', async () => {
    const body = await completionsToClaudeBody({
      messages: [{
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      }],
    } as any, 'm');
    assert.deepEqual((body.messages as any[])[0], { role: 'user', content: 'hello' });
  });

  it('fetches http image_url via fetchImageAsInlineData (SSRF-guarded)', async () => {
    let capturedUrl = '';
    globalThis.fetch = (async (url: any) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ mime_type: 'image/jpeg', data: 'aGVsbG8=' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    // Use the sidecar path so SSRF guard on the image host is bypassed.
    const { setImageEncodeConfig } = await import('../../src/utils/image-fetch.js');
    const prior = (await import('../../src/utils/image-fetch.js')).getImageEncodeConfig();
    setImageEncodeConfig({ url: 'http://localhost:34567', timeoutMs: 5000 });
    try {
      const body = await completionsToClaudeBody({
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'see' },
            { type: 'image_url', image_url: { url: 'http://example.com/cat.jpg' } },
          ],
        }],
      } as any, 'm');
      assert.equal(capturedUrl, 'http://localhost:34567/encode');
      const m = (body.messages as any[])[0];
      assert.deepEqual(m.content, [
        { type: 'text', text: 'see' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aGVsbG8=' } },
      ]);
    } finally {
      setImageEncodeConfig(prior);
    }
  });

  it('emits thinking + text + image blocks in order on a thinking turn', async () => {
    const body = await completionsToClaudeBody({
      messages: [{
        role: 'assistant',
        reasoning_content: 'pondering',
        content: [
          { type: 'text', text: 'see this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
        ],
      }],
    } as any, 'm');
    const m = (body.messages as any[])[0];
    assert.deepEqual(m.content, [
      { type: 'thinking', thinking: 'pondering' },
      { type: 'text', text: 'see this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ]);
  });

  it('throws on a malformed data: URI (Fail Loud)', async () => {
    await assert.rejects(
      () => completionsToClaudeBody({
        messages: [{
          role: 'user',
          content: [{ type: 'image_url', image_url: { url: 'data:not-a-valid-uri' } }],
        }],
      } as any, 'm'),
      /Malformed image_url data URI/i,
    );
  });

  it('skips empty/missing image_url.url without throwing', async () => {
    const body = await completionsToClaudeBody({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'only text survives' },
          { type: 'image_url', image_url: { url: '' } },
        ],
      }],
    } as any, 'm');
    // No image block emitted; text-only collapses back to string.
    assert.deepEqual((body.messages as any[])[0], {
      role: 'user', content: 'only text survives',
    });
  });
});


describe('completionsToResponsesBody', () => {
  it('builds a responses body with model + input + stream', () => {
    const body = completionsToResponsesBody({
      messages: [{ role: 'user', content: 'hi' }],
    } as any, 'resp-model');
    assert.equal(body.model, 'resp-model');
    assert.equal(body.stream, false);
    assert.equal((body.input as any[]).length, 1);
  });

  it('lifts system + developer messages into instructions', () => {
    const body = completionsToResponsesBody({
      messages: [
        { role: 'system', content: 'rule one' },
        { role: 'developer', content: 'rule two' },
        { role: 'user', content: 'q' },
      ],
    } as any, 'm');
    assert.equal(body.instructions, 'rule one\nrule two');
    // System/developer messages are excluded from input
    assert.equal((body.input as any[]).length, 1);
    assert.equal((body.input as any[])[0].role, 'user');
  });

  it('maps user/assistant messages to input_text/output_text respectively', () => {
    const body = completionsToResponsesBody({
      messages: [
        { role: 'user', content: 'ask' },
        { role: 'assistant', content: 'reply' },
      ],
    } as any, 'm');
    const input = body.input as any[];
    assert.equal(input[0].content[0].type, 'input_text');
    assert.equal(input[1].content[0].type, 'output_text');
  });

  it('maps assistant tool_calls to function_call items', () => {
    const body = completionsToResponsesBody({
      messages: [{
        role: 'assistant', content: '',
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'do', arguments: '{"a":1}' },
        }],
      }],
    } as any, 'm');
    const input = body.input as any[];
    assert.equal(input[0].type, 'function_call');
    assert.equal(input[0].call_id, 'c1');
    assert.equal(input[0].arguments, '{"a":1}');
  });

  it('maps tool-role messages to function_call_output', () => {
    const body = completionsToResponsesBody({
      messages: [
        { role: 'tool', tool_call_id: 'c1', content: 'result' },
      ],
    } as any, 'm');
    const input = body.input as any[];
    assert.equal(input[0].type, 'function_call_output');
    assert.equal(input[0].call_id, 'c1');
    assert.equal(input[0].output, 'result');
  });

  it('forwards temperature, top_p, max_output_tokens, prompt_cache_key', () => {
    const body = completionsToResponsesBody({
      messages: [{ role: 'user', content: 'x' }],
      temperature: 0.3, top_p: 0.8, max_tokens: 500,
      prompt_cache_key: 'cache-1',
    } as any, 'm');
    assert.equal(body.temperature, 0.3);
    assert.equal(body.top_p, 0.8);
    assert.equal(body.max_output_tokens, 500);
    assert.equal(body.prompt_cache_key, 'cache-1');
  });

  it('maps tools array to responses-style function tools', () => {
    const body = completionsToResponsesBody({
      messages: [{ role: 'user', content: 'x' }],
      tools: [{
        type: 'function',
        function: { name: 't', description: 'd', parameters: { type: 'object' } },
      }],
    } as any, 'm');
    assert.deepEqual(body.tools, [{
      type: 'function', name: 't', description: 'd', parameters: { type: 'object' },
    }]);
  });

  it('assistant with both tool_calls and text emits function_call + message', () => {
    const body = completionsToResponsesBody({
      messages: [{
        role: 'assistant', content: 'explanation',
        tool_calls: [{
          id: 'c1', type: 'function',
          function: { name: 'do', arguments: '{}' },
        }],
      }],
    } as any, 'm');
    const input = body.input as any[];
    // function_call first, then message with output_text
    assert.equal(input.length, 2);
    assert.equal(input[0].type, 'function_call');
    assert.equal(input[1].type, 'message');
    assert.equal(input[1].content[0].type, 'output_text');
  });

  it('forwards image_url parts as input_image with URL passthrough', () => {
    const body = completionsToResponsesBody({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'https://example.com/cat.png', detail: 'high' } },
        ],
      }],
    } as any, 'm');
    const input = body.input as any[];
    assert.equal(input.length, 1);
    assert.equal(input[0].type, 'message');
    assert.deepEqual(input[0].content, [
      { type: 'input_text', text: 'look' },
      { type: 'input_image', image_url: { url: 'https://example.com/cat.png', detail: 'high' } },
    ]);
  });

  it('forwards a data: URI image_url as input_image unchanged', () => {
    const body = completionsToResponsesBody({
      messages: [{
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } }],
      }],
    } as any, 'm');
    const input = body.input as any[];
    assert.deepEqual(input[0].content, [
      { type: 'input_image', image_url: { url: 'data:image/png;base64,QUJD' } },
    ]);
  });

  it('assistant with image content emits output_text + input_image parts', () => {
    // Mirrors messages.ts behavior: image_url is always forwarded as input_image
    // regardless of role; text uses the role-appropriate type.
    const body = completionsToResponsesBody({
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: 'note' },
          { type: 'image_url', image_url: { url: 'https://example.com/x.jpg' } },
        ],
      }],
    } as any, 'm');
    const input = body.input as any[];
    assert.deepEqual(input[0].content, [
      { type: 'output_text', text: 'note' },
      { type: 'input_image', image_url: { url: 'https://example.com/x.jpg' } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// claudeJsonToSyntheticCompletions
// ---------------------------------------------------------------------------

describe('claudeJsonToSyntheticCompletions', () => {
  it('converts a text-only Claude response to a chat.completion', () => {
    const out = claudeJsonToSyntheticCompletions({
      id: 'msg_1',
      model: 'claude-x',
      content: [{ type: 'text', text: 'hello' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    }, 'fallback-model');
    assert.equal(out.object, 'chat.completion');
    assert.equal(out.model, 'claude-x');
    const choice = (out.choices as any[])[0];
    assert.equal(choice.message.content, 'hello');
    assert.equal(choice.message.role, 'assistant');
    assert.equal(choice.finish_reason, 'stop');
    assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('converts tool_use blocks to tool_calls and sets finish_reason=tool_calls', () => {
    const out = claudeJsonToSyntheticCompletions({
      content: [
        { type: 'tool_use', id: 't1', name: 'search', input: { q: 'x' } },
      ],
      stop_reason: 'tool_use',
    }, 'm');
    const msg = (out.choices as any[])[0].message;
    assert.deepEqual(msg.tool_calls, [{
      id: 't1', type: 'function',
      function: { name: 'search', arguments: '{"q":"x"}' },
    }]);
    assert.equal((out.choices as any[])[0].finish_reason, 'tool_calls');
    // content null when only tool_calls + empty text
    assert.equal(msg.content, null);
  });

  it('maps stop_reason=max_tokens to finish_reason=length', () => {
    const out = claudeJsonToSyntheticCompletions({
      content: [{ type: 'text', text: 'partial' }],
      stop_reason: 'max_tokens',
    }, 'm');
    assert.equal((out.choices as any[])[0].finish_reason, 'length');
  });

  it('preserves thinking blocks as reasoning_content', () => {
    const out = claudeJsonToSyntheticCompletions({
      content: [
        { type: 'thinking', thinking: 'step 1' },
        { type: 'thinking', thinking: 'step 2' },
        { type: 'text', text: 'answer' },
      ],
    }, 'm');
    const msg = (out.choices as any[])[0].message;
    assert.equal(msg.reasoning_content, 'step 1\nstep 2');
  });

  it('falls back to the provided model when Claude response has no model field', () => {
    const out = claudeJsonToSyntheticCompletions({
      content: [{ type: 'text', text: 'x' }],
    }, 'fallback');
    assert.equal(out.model, 'fallback');
  });

  it('returns usage undefined when Claude response has no usage block', () => {
    const out = claudeJsonToSyntheticCompletions({
      content: [{ type: 'text', text: 'x' }],
    }, 'm');
    assert.equal(out.usage, undefined);
  });

  it('keeps text content alongside tool_calls (both present)', () => {
    const out = claudeJsonToSyntheticCompletions({
      content: [
        { type: 'text', text: 'calling tool' },
        { type: 'tool_use', id: 't1', name: 'f', input: {} },
      ],
    }, 'm');
    const msg = (out.choices as any[])[0].message;
    assert.equal(msg.content, 'calling tool');
    assert.ok(msg.tool_calls?.length === 1);
  });
});

// ---------------------------------------------------------------------------
// convertGeminiGenerateContentToOpenAI — toolConfig.functionCallingConfig
// ---------------------------------------------------------------------------

describe('convertGeminiGenerateContentToOpenAI — toolConfig', () => {
  const weatherTool = { functionDeclarations: [{ name: 'get_weather', parameters: { type: 'OBJECT', properties: {} } }] };

  function geminiRequest(toolConfig: Record<string, unknown>, tools: unknown[] = [weatherTool]): Record<string, unknown> {
    return {
      model: 'gpt-target',
      contents: [{ role: 'user', parts: [{ text: 'count to 10' }] }],
      tools,
      toolConfig,
    };
  }

  it('maps a single-name ANY allow-list to the forced function form', () => {
    const out = convertGeminiGenerateContentToOpenAI(
      geminiRequest({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } }),
    );
    assert.deepEqual(out.tool_choice, { type: 'function', function: { name: 'get_weather' } });
  });

  // Pinned, not fixed: Gemini's "must call some function" has no faithful
  // Completions string, so ANY without an allow-list goes out as 'auto'.
  it("maps ANY with no allow-list to 'auto'", () => {
    const out = convertGeminiGenerateContentToOpenAI(geminiRequest({ functionCallingConfig: { mode: 'ANY' } }));
    assert.equal(out.tool_choice, 'auto');
  });

  it("maps NONE to 'none' and AUTO to 'auto'", () => {
    assert.equal(
      convertGeminiGenerateContentToOpenAI(geminiRequest({ functionCallingConfig: { mode: 'NONE' } })).tool_choice,
      'none',
    );
    assert.equal(
      convertGeminiGenerateContentToOpenAI(geminiRequest({ functionCallingConfig: { mode: 'AUTO' } })).tool_choice,
      'auto',
    );
  });

  // Pinned, not fixed: Completions cannot express "one of these two, and no
  // other tool", so a 2+ name allow-list collapses to the looser 'required'.
  it("collapses a multi-name allow-list to 'required' (looser)", () => {
    const out = convertGeminiGenerateContentToOpenAI(
      geminiRequest({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather', 'get_time'] } }),
    );
    assert.equal(out.tool_choice, 'required');
  });

  it('omits tool_choice when toolConfig is absent or unrecognized', () => {
    assert.equal('tool_choice' in convertGeminiGenerateContentToOpenAI({ ...geminiRequest({}), toolConfig: undefined }), false);
    assert.equal(
      'tool_choice' in convertGeminiGenerateContentToOpenAI(geminiRequest({ functionCallingConfig: { mode: 'WHATEVER' } })),
      false,
    );
  });

  it('omits tool_choice when no functionDeclaration survived the conversion', () => {
    const out = convertGeminiGenerateContentToOpenAI(
      geminiRequest({ functionCallingConfig: { mode: 'ANY' } }, [{ google_search: {} }]),
    );
    assert.equal('tools' in out, false);
    assert.equal('tool_choice' in out, false);
  });

  it('carries a forced function to both cross-mode upstreams', async () => {
    const completions = convertGeminiGenerateContentToOpenAI(
      geminiRequest({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } }),
    );
    const claudeBody = await completionsToClaudeBody(completions as any, 'claude-target');
    const responsesBody = completionsToResponsesBody(completions as any, 'gpt-target');

    assert.deepEqual(claudeBody.tool_choice, { type: 'tool', name: 'get_weather' });
    assert.deepEqual(responsesBody.tool_choice, { type: 'function', name: 'get_weather' });
  });

  it("carries a multi-name allow-list to both cross-mode upstreams as 'required' / {type:'any'}", async () => {
    const completions = convertGeminiGenerateContentToOpenAI(
      geminiRequest({ functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather', 'get_time'] } }),
    );
    const claudeBody = await completionsToClaudeBody(completions as any, 'claude-target');
    const responsesBody = completionsToResponsesBody(completions as any, 'gpt-target');

    assert.deepEqual(claudeBody.tool_choice, { type: 'any' });
    assert.equal(responsesBody.tool_choice, 'required');
  });
});

// ---------------------------------------------------------------------------
// convertGeminiGenerateContentToOpenAI — functionCall / functionResponse ids
// ---------------------------------------------------------------------------

describe('convertGeminiGenerateContentToOpenAI — tool-call ids', () => {
  /** One user turn, a model turn with two calls, then the client's results. */
  function withResponses(responseParts: unknown[]): Record<string, unknown> {
    return {
      model: 'gpt-target',
      contents: [
        { role: 'user', parts: [{ text: 'go' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'gid_A', name: 'read_file', args: { path: 'a.ts' } } },
            { functionCall: { id: 'gid_B', name: 'read_file', args: { path: 'b.ts' } } },
          ],
        },
        { role: 'user', parts: responseParts },
      ],
    };
  }

  it("carries the client's functionCall.id onto the assistant tool_calls", () => {
    const out = convertGeminiGenerateContentToOpenAI(withResponses([
      { functionResponse: { id: 'gid_A', name: 'read_file', response: { output: 'A' } } },
      { functionResponse: { id: 'gid_B', name: 'read_file', response: { output: 'B' } } },
    ]) as any);

    const asst = (out.messages as any[])[1];
    assert.deepEqual(asst.tool_calls.map((tc: any) => tc.id), ['gid_A', 'gid_B']);
  });

  // Parallel tool results arrive in completion order, which need not match call
  // order — the id is the only thing that pairs them correctly.
  it('pairs out-of-order functionResponses by id, not by position', () => {
    const out = convertGeminiGenerateContentToOpenAI(withResponses([
      { functionResponse: { id: 'gid_B', name: 'read_file', response: { output: 'B' } } },
      { functionResponse: { id: 'gid_A', name: 'read_file', response: { output: 'A' } } },
    ]) as any);

    const toolMsgs = (out.messages as any[]).filter(m => m.role === 'tool');
    assert.deepEqual(
      toolMsgs.map(m => [m.tool_call_id, JSON.parse(m.content).output]),
      [['gid_B', 'B'], ['gid_A', 'A']],
    );
  });

  it('mints the positional id when the client carries none', () => {
    const out = convertGeminiGenerateContentToOpenAI({
      model: 'gpt-target',
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'A' } } }] },
      ],
    } as any);

    const asst = (out.messages as any[])[0];
    const toolMsgs = (out.messages as any[]).filter(m => m.role === 'tool');
    assert.equal(asst.tool_calls[0].id, 'call_read_file_0');
    assert.equal(toolMsgs[0].tool_call_id, 'call_read_file_0');
  });

  /** Collects `logger.warn` messages — the only level this converter emits. */
  function capturingLogger(warnings: string[]): Logger {
    return {
      traceEnabled: false,
      trace() { },
      debug() { },
      info() { },
      error() { },
      warn: (_requestId: string, message: string) => { warnings.push(message); },
    };
  }

  // Rule #8: an id the client supplied that matches no call is evidence position
  // is not the pairing. It must be reported, not applied in silence.
  it('warns — naming the id and the candidates — when a supplied id matches no call', () => {
    const warnings: string[] = [];
    const out = convertGeminiGenerateContentToOpenAI(withResponses([
      { functionResponse: { id: 'UNKNOWN', name: 'read_file', response: { output: 'R' } } },
    ]) as any, { requestId: 'rid-unmatched', logger: capturingLogger(warnings) });

    assert.equal(warnings.length, 1, 'exactly one warning for the one unmatched id');
    assert.match(warnings[0], /UNKNOWN/, 'names the id the client supplied');
    assert.match(warnings[0], /gid_A, gid_B/, 'names the calls it could have belonged to');
    // Positional pairing is deliberately retained — the warning is what makes it
    // honest, and this pins that the fallback still happened.
    const toolMsgs = (out.messages as any[]).filter(m => m.role === 'tool');
    assert.equal(toolMsgs[0].tool_call_id, 'gid_A');
  });

  it('stays silent when every supplied id matches, and when no id is supplied', () => {
    const warnings: string[] = [];
    const logger = capturingLogger(warnings);

    const matched = convertGeminiGenerateContentToOpenAI(withResponses([
      { functionResponse: { id: 'gid_B', name: 'read_file', response: { output: 'B' } } },
      { functionResponse: { id: 'gid_A', name: 'read_file', response: { output: 'A' } } },
    ]) as any, { requestId: 'rid-matched', logger });

    const idless = convertGeminiGenerateContentToOpenAI({
      model: 'gpt-target',
      contents: [
        { role: 'model', parts: [{ functionCall: { name: 'read_file', args: {} } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'read_file', response: { output: 'A' } } }] },
      ],
    } as any, { requestId: 'rid-idless', logger });

    assert.deepEqual(warnings, [], 'no warning when the id matches, or when none was supplied');
    // Both of those requests still pair correctly, so silence is the right answer.
    assert.equal(((matched.messages as any[])[2]).tool_call_id, 'gid_B');
    assert.equal(((idless.messages as any[])[1]).tool_call_id, 'call_read_file_0');
  });
});


// ---------------------------------------------------------------------------
// convertGeminiGenerateContentToOpenAI — generationConfig.stopSequences
// ---------------------------------------------------------------------------

describe('convertGeminiGenerateContentToOpenAI — stopSequences', () => {
  function geminiRequest(generationConfig: Record<string, unknown>): Record<string, unknown> {
    return {
      model: 'gpt-target',
      contents: [{ role: 'user', parts: [{ text: 'count to 10' }] }],
      generationConfig,
    };
  }

  it('maps generationConfig.stopSequences to the Completions stop array', () => {
    const out = convertGeminiGenerateContentToOpenAI(geminiRequest({ stopSequences: ['5.', 'END'] }));
    assert.deepEqual(out.stop, ['5.', 'END']);
    // The rest of the conversion is unchanged.
    assert.equal(out.model, 'gpt-target');
    assert.deepEqual(out.messages, [{ role: 'user', content: 'count to 10' }]);
  });

  it('normalizes a bare-string stopSequences to a one-element array', () => {
    const out = convertGeminiGenerateContentToOpenAI(geminiRequest({ stopSequences: 'END' }));
    assert.deepEqual(out.stop, ['END']);
  });

  it('omits stop when stopSequences is absent', () => {
    const out = convertGeminiGenerateContentToOpenAI(geminiRequest({ temperature: 0.3 }));
    assert.equal('stop' in out, false);
  });

  it('omits stop for an empty stopSequences list', () => {
    const out = convertGeminiGenerateContentToOpenAI(geminiRequest({ stopSequences: [] }));
    assert.equal('stop' in out, false);
  });

  it('carries the sequences to an anthropic-messages upstream as stop_sequences', async () => {
    const completions = convertGeminiGenerateContentToOpenAI(
      geminiRequest({ stopSequences: ['5.', 'END'] }),
    );
    const claudeBody = await completionsToClaudeBody(completions as any, 'claude-target');
    assert.deepEqual(claudeBody.stop_sequences, ['5.', 'END']);
  });

  // Pinned, not fixed: the Responses API has no stop-sequence field, so the
  // openai-responses hop drops what the Completions body carries. This test
  // exists so that drop stays visible instead of being silently assumed.
  it('still drops the sequences at the openai-responses hop', () => {
    const completions = convertGeminiGenerateContentToOpenAI(
      geminiRequest({ stopSequences: ['5.', 'END'] }),
    );
    const responsesBody = completionsToResponsesBody(completions as any, 'gpt-target');
    assert.equal('stop' in responsesBody, false);
    assert.equal('stop_sequences' in responsesBody, false);
  });
});

// ---------------------------------------------------------------------------
// isGeminiRequest
// ---------------------------------------------------------------------------

describe('isGeminiRequest', () => {
  function req(path: string): Request {
    return new Request(`https://proxy.example${path}`);
  }

  it('returns true for /v1/interactions paths', () => {
    assert.equal(isGeminiRequest(req('/v1/interactions'), 'https://up'), true);
    assert.equal(isGeminiRequest(req('/v1/interactions?x=1'), 'https://up'), true);
  });

  it('returns true for /v1beta/interactions paths', () => {
    assert.equal(isGeminiRequest(req('/v1beta/interactions'), 'https://up'), true);
  });

  it('returns true when targetUrl contains generativelanguage.googleapis.com', () => {
    assert.equal(
      isGeminiRequest(req('/v1/messages'), 'https://generativelanguage.googleapis.com/v1beta'),
      true,
    );
  });

  it('returns true when targetUrl contains "gemini"', () => {
    assert.equal(isGeminiRequest(req('/v1/foo'), 'https://gemini-upstream.example'), true);
  });

  it('returns false for ordinary OpenAI/Claude paths and URLs', () => {
    assert.equal(isGeminiRequest(req('/v1/messages'), 'https://api.openai.com'), false);
    assert.equal(isGeminiRequest(req('/v1/chat/completions'), 'https://api.anthropic.com'), false);
  });
});
