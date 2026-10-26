import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { convertCompletionsToResponses, convertCompletionsToCompactedResponse } from '../../src/converters/completions-to-responses.js';
import { convertResponsesToChatCompletions, convertInputItemsToMessages, getNamespaceMap, extractAllowedTools } from '../../src/converters/responses-to-completions.js';
import { completionsToClaudeBody } from '../../src/handlers/openai.js';
import type { OpenAIResponse } from '../../src/types/openai.js';

/**
 * Round-trip tests for the completions <-> responses converters.
 * These converters had only indirect HTTP coverage through tests/integration/11_responses.
 */

function baseCompletion(overrides: Partial<OpenAIResponse> = {}): OpenAIResponse {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 1700000000,
    model: 'gpt-4o',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'hello world' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    ...overrides,
  };
}

// ─── completions → responses ───────────────────────────────────────────────

describe('convertCompletionsToResponses', () => {
  it('converts a basic text completion into a responses-format response', () => {
    const out = convertCompletionsToResponses(baseCompletion(), 'gpt-4o');

    assert.ok(out.id.startsWith('resp_'), 'id must have resp_ prefix');
    assert.equal(out.object, 'response');
    assert.equal(out.status, 'completed');
    assert.equal(out.model, 'gpt-4o');
    assert.equal(out.output_text, 'hello world');

    const msgItem = out.output.find(o => o.type === 'message');
    assert.ok(msgItem, 'must have a message output item');
    assert.equal(msgItem!.role, 'assistant');
    assert.equal(msgItem!.content![0].type, 'output_text');
    assert.equal(msgItem!.content![0].text, 'hello world');
  });

  it('maps usage fields correctly', () => {
    const out = convertCompletionsToResponses(baseCompletion(), 'gpt-4o');

    assert.deepEqual(out.usage, {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 15,
      input_tokens_details: { cached_tokens: 0 },
    });
  });

  it('converts tool_calls into function_call output items', () => {
    const out = convertCompletionsToResponses(
      baseCompletion({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null as unknown as string,
              tool_calls: [
                { id: 'tc_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
      'gpt-4o',
    );

    const fnItem = out.output.find(o => o.type === 'function_call');
    assert.ok(fnItem, 'must have a function_call output item');
    assert.equal(fnItem!.name, 'search');
    assert.equal(fnItem!.arguments, '{"q":"x"}');
    assert.equal(fnItem!.call_id, 'tc_1');
  });

  it('emits a reasoning output item from reasoning_content', () => {
    const out = convertCompletionsToResponses(
      baseCompletion({
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'answer',
              reasoning_content: 'thinking...',
            } as any,
            finish_reason: 'stop',
          },
        ],
      }),
      'model',
    );

    const reasoningItem = out.output.find(o => o.type === 'reasoning') as any;
    assert.ok(reasoningItem, 'must emit a reasoning output item');
    assert.equal(reasoningItem.content[0].type, 'reasoning_text');
    assert.equal(reasoningItem.content[0].text, 'thinking...');
  });

  it('strips <thinking> tags from content and emits a reasoning item', () => {
    const out = convertCompletionsToResponses(
      baseCompletion({
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: '<thinking>hmm</thinking>final' },
            finish_reason: 'stop',
          },
        ],
      }),
      'model',
    );

    assert.equal(out.output_text, 'final');
    const reasoningItem = out.output.find(o => o.type === 'reasoning') as any;
    assert.ok(reasoningItem);
    assert.equal(reasoningItem.content[0].text, 'hmm');
  });

  it('returns a fallback message item when choices is empty', () => {
    const out = convertCompletionsToResponses(
      baseCompletion({ choices: [] }),
      'model',
    );

    assert.equal(out.output.length, 1);
    assert.equal(out.output[0].type, 'message');
    assert.equal(out.output[0].content![0].text, '');
  });
});

describe('convertCompletionsToCompactedResponse', () => {
  it('returns object: response.compaction', () => {
    const out = convertCompletionsToCompactedResponse(baseCompletion(), 'gpt-4o');
    assert.equal(out.object, 'response.compaction');
    assert.ok(out.output.length > 0);
  });
});

// ─── responses → completions ───────────────────────────────────────────────

describe('convertResponsesToChatCompletions', () => {
  it('converts a simple string input to a user message', () => {
    const out = convertResponsesToChatCompletions(
      { model: 'gpt-4o', input: 'hello' },
      'gpt-4o',
    );

    assert.equal(out.model, 'gpt-4o');
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].role, 'user');
    assert.equal(out.messages[0].content, 'hello');
  });

  it('maps instructions to a system message prepended before input', () => {
    const out = convertResponsesToChatCompletions(
      { instructions: 'be concise', input: 'hi' },
      'model',
    );

    assert.equal(out.messages[0].role, 'system');
    assert.equal(out.messages[0].content, 'be concise');
    assert.equal(out.messages[1].role, 'user');
  });

  it('copies optional parameters (temperature, max_output_tokens, top_p, stop)', () => {
    const out = convertResponsesToChatCompletions(
      { input: 'hi', temperature: 0.5, max_output_tokens: 100, top_p: 0.9, stop: ['END'] },
      'model',
    );

    assert.equal(out.temperature, 0.5);
    assert.equal(out.max_tokens, 100);
    assert.equal(out.top_p, 0.9);
    assert.deepEqual(out.stop, ['END']);
  });

  it('converts flat responses-API tool format to nested completions format', () => {
    const out = convertResponsesToChatCompletions(
      {
        input: 'hi',
        tools: [
          { type: 'function', name: 'search', description: 'Search', parameters: { type: 'object' } },
        ],
      },
      'model',
    );

    assert.equal(out.tools!.length, 1);
    assert.equal(out.tools![0].type, 'function');
    assert.equal((out.tools![0] as any).function.name, 'search');
    assert.equal((out.tools![0] as any).function.description, 'Search');
  });

  it('drops non-function tools', () => {
    const out = convertResponsesToChatCompletions(
      {
        input: 'hi',
        tools: [
          { type: 'web_search_preview' },
          { type: 'function', name: 'fn', parameters: {} },
        ],
      },
      'model',
    );

    assert.equal(out.tools!.length, 1);
  });

  it('merges tools from an `additional_tools` input item into the request tools', () => {
    const out = convertResponsesToChatCompletions(
      {
        input: [
          {
            type: 'additional_tools',
            role: 'developer',
            tools: [
              { type: 'function', name: 'lookup', description: 'Lookup', parameters: { type: 'object' } },
            ],
          },
          { type: 'message', role: 'user', content: 'hi' },
        ],
      },
      'model',
    );

    assert.equal(out.tools!.length, 1);
    assert.equal(out.tools![0].type, 'function');
    assert.equal((out.tools![0] as any).function.name, 'lookup');
    // The additional_tools item itself must not produce a message.
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].role, 'user');
  });

  it('combines top-level tools with additional_tools tools, and still drops non-function ones', () => {
    const out = convertResponsesToChatCompletions(
      {
        input: [
          { type: 'additional_tools', role: 'developer', tools: [{ type: 'function', name: 'extra', parameters: {} }] },
          { type: 'message', role: 'user', content: 'hi' },
        ],
        tools: [
          { type: 'function', name: 'search', parameters: {} },
          { type: 'web_search_preview' },
        ],
      },
      'model',
    );

    assert.equal(out.tools!.length, 2);
    const names = out.tools!.map(t => (t as any).function.name).sort();
    assert.deepEqual(names, ['extra', 'search']);
  });

  it('ignores an additional_tools item with a missing or non-array tools field', () => {
    const out = convertResponsesToChatCompletions(
      {
        input: [
          { type: 'additional_tools', role: 'developer' },
          { type: 'message', role: 'user', content: 'hi' },
        ],
      },
      'model',
    );

    assert.equal(out.tools, undefined);
    assert.equal(out.messages.length, 1);
  });

  it('flattens namespace-wrapped tools (recursively), prefixing names with the namespace path', () => {
    const out = convertResponsesToChatCompletions(
      {
        input: [
          {
            type: 'additional_tools',
            role: 'developer',
            tools: [
              {
                type: 'namespace',
                name: 'outer',
                description: '',
                tools: [
                  { type: 'function', name: 'inner_fn', parameters: { type: 'object' } },
                  {
                    type: 'namespace',
                    name: 'nested',
                    description: '',
                    tools: [{ type: 'function', name: 'deep_fn', parameters: {} }],
                  },
                ],
              },
            ],
          },
          { type: 'message', role: 'user', content: 'hi' },
        ],
      },
      'model',
    );

    const names = out.tools!.map(t => (t as any).function.name).sort();
    assert.deepEqual(names, ['outer_Z_inner_fn', 'outer_Z_nested_Z_deep_fn']);

    const namespaceMap = getNamespaceMap(out);
    assert.deepEqual(namespaceMap?.get('outer_Z_inner_fn'), { name: 'inner_fn', namespace: 'outer' });
    assert.deepEqual(namespaceMap?.get('outer_Z_nested_Z_deep_fn'), { name: 'deep_fn', namespace: 'outer.nested' });
  });

  it('shortens a flattened name over the 64-char function.name limit and round-trips it', () => {
    const ns = 'a'.repeat(40);
    const toolName = 'b'.repeat(40);
    const out = convertResponsesToChatCompletions(
      {
        tools: [
          { type: 'namespace', name: ns, description: '', tools: [{ type: 'function', name: toolName, parameters: { type: 'object' } }] },
        ],
        input: [{ type: 'message', role: 'user', content: 'hi' }],
      },
      'model',
    );

    const flatName = (out.tools![0] as any).function.name as string;
    assert.equal(flatName.length, 64, `expected a 64-char shortened name, got ${flatName.length}`);
    const namespaceMap = getNamespaceMap(out);
    assert.deepEqual(namespaceMap?.get(flatName), { name: toolName, namespace: ns });

    const completion = {
      id: 'chatcmpl-long', object: 'chat.completion' as const, created: 1700000000, model: 'model',
      choices: [{
        index: 0,
        message: { role: 'assistant' as const, content: null, tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: flatName, arguments: '{}' } }] },
        finish_reason: 'tool_calls' as const,
      }],
    };
    const responsesResponse = convertCompletionsToResponses(completion, 'model', namespaceMap);
    const fnCall = responsesResponse.output.find(o => o.type === 'function_call')!;
    assert.equal(fnCall.name, toolName);
    assert.equal((fnCall as any).namespace, ns);
  });

  it('restores the original name/namespace split on the function_call output item', () => {
    const out = convertResponsesToChatCompletions(
      {
        tools: [
          {
            type: 'namespace',
            name: 'crm',
            description: '',
            tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }],
          },
        ],
        input: [{ type: 'message', role: 'user', content: 'hi' }],
      },
      'model',
    );
    const namespaceMap = getNamespaceMap(out);

    const completion = {
      id: 'chatcmpl-ns', object: 'chat.completion' as const, created: 1700000000, model: 'model',
      choices: [{
        index: 0,
        message: { role: 'assistant' as const, content: null, tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'crm_Z_lookup', arguments: '{}' } }] },
        finish_reason: 'tool_calls' as const,
      }],
    };

    const responsesResponse = convertCompletionsToResponses(completion, 'model', namespaceMap);
    const fnCall = responsesResponse.output.find(o => o.type === 'function_call')!;
    assert.equal(fnCall.name, 'lookup');
    assert.equal((fnCall as any).namespace, 'crm');
  });

  it('leaves non-namespaced tool call names unaffected when namespaceMap is empty/omitted', () => {
    const completion = {
      id: 'chatcmpl-plain', object: 'chat.completion' as const, created: 1700000000, model: 'model',
      choices: [{
        index: 0,
        message: { role: 'assistant' as const, content: null, tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'plain_fn', arguments: '{}' } }] },
        finish_reason: 'tool_calls' as const,
      }],
    };

    const responsesResponse = convertCompletionsToResponses(completion, 'model');
    const fnCall = responsesResponse.output.find(o => o.type === 'function_call')!;
    assert.equal(fnCall.name, 'plain_fn');
    assert.equal((fnCall as any).namespace, undefined);
  });

  it('best-effort converts a custom tool to a function tool and warns', () => {
    const warnings: string[] = [];
    const logger = {
      trace: () => {}, debug: () => {}, info: () => {}, error: () => {},
      warn: (_requestId: string, message: string) => { warnings.push(message); },
    } as any;

    const out = convertResponsesToChatCompletions(
      {
        input: [
          {
            type: 'additional_tools',
            role: 'developer',
            tools: [
              {
                type: 'namespace',
                name: 'functions',
                description: '',
                tools: [{ type: 'custom', name: 'exec', description: 'Run a command' }],
              },
            ],
          },
          { type: 'message', role: 'user', content: 'hi' },
        ],
      },
      'model',
      { logger, requestId: 'req-1' },
    );

    assert.equal(out.tools!.length, 1);
    const tool = out.tools![0] as any;
    assert.equal(tool.type, 'function');
    assert.equal(tool.function.name, 'functions_Z_exec');
    assert.equal(tool.function.description, 'Run a command');
    assert.deepEqual(tool.function.parameters, {
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
    });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /best-effort converting custom tool 'functions_Z_exec'/);
    assert.deepEqual(getNamespaceMap(out)?.get('functions_Z_exec'), { name: 'exec', namespace: 'functions' });
  });

  it('maps tool_choice { type: "function", name: "fn" } to nested format', () => {
    const out = convertResponsesToChatCompletions(
      { input: 'hi', tool_choice: { type: 'function', name: 'fn' } },
      'model',
    );

    assert.deepEqual(out.tool_choice, { type: 'function', function: { name: 'fn' } });
  });

  it('passes through string tool_choice (auto, none, required)', () => {
    const out = convertResponsesToChatCompletions(
      { input: 'hi', tool_choice: 'required' },
      'model',
    );

    assert.equal(out.tool_choice, 'required');
  });

  it('copies thinking and reasoning_effort', () => {
    const out = convertResponsesToChatCompletions(
      { input: 'hi', thinking: { enabled: true, budget_tokens: 1024 }, reasoning_effort: 'high' },
      'model',
    );

    assert.deepEqual(out.thinking, { enabled: true, budget_tokens: 1024 });
    assert.equal(out.reasoning_effort, 'high');
  });

  it('preserves input_image parts as image_url array content', () => {
    const out = convertResponsesToChatCompletions({
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'look' },
          { type: 'input_image', image_url: 'https://example.com/x.png' },
        ],
      }],
    }, 'model');

    assert.equal(out.messages.length, 1);
    const content = out.messages[0].content as any[];
    assert.ok(Array.isArray(content), 'content should be array when image present');
    assert.deepEqual(content, [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
    ]);
  });

  it('normalizes input_image object-form image_url to {url, detail?}', () => {
    const out = convertResponsesToChatCompletions({
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: { url: 'https://example.com/x.png', detail: 'high' } },
        ],
      }],
    }, 'model');

    const content = out.messages[0].content as any[];
    assert.deepEqual(content, [
      { type: 'image_url', image_url: { url: 'https://example.com/x.png', detail: 'high' } },
    ]);
  });

  it('collapses text-only content back to a string when no image present', () => {
    const out = convertResponsesToChatCompletions({
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'line one' },
          { type: 'input_text', text: 'line two' },
        ],
      }],
    }, 'model');

    // Text-only stays a string (preserves wire shape; regression guard).
    assert.equal(typeof out.messages[0].content, 'string');
    assert.equal(out.messages[0].content, 'line one\nline two');
  });
});

// ─── /v1/responses → Claude chain (image preservation) ─────────────────────

describe('Responses → Claude chain (image preservation)', () => {
  it('end-to-end: input_image -> image_url -> Claude image block', async () => {
    const completionsRequest = convertResponsesToChatCompletions({
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'see' },
          { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
        ],
      }],
    }, 'm');

    const claudeBody = await completionsToClaudeBody(
      completionsRequest as unknown as Record<string, unknown>,
      'm',
    );

    const msgs = claudeBody.messages as any[];
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0].content, [
      { type: 'text', text: 'see' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ]);
  });

  it('end-to-end: http image_url routes through fetchImageAsInlineData', async () => {
    const realFetch = globalThis.fetch;
    const { setImageEncodeConfig, getImageEncodeConfig } = await import('../../src/utils/image-fetch.js');
    const prior = getImageEncodeConfig();
    setImageEncodeConfig({ url: 'http://localhost:34567', timeoutMs: 5000 });
    globalThis.fetch = (async (url: any) => new Response(
      JSON.stringify({ mime_type: 'image/jpeg', data: 'aGVsbG8=' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as typeof fetch;
    try {
      const completionsRequest = convertResponsesToChatCompletions({
        input: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'see' },
            { type: 'input_image', image_url: 'http://example.com/cat.jpg' },
          ],
        }],
      }, 'm');

      const claudeBody = await completionsToClaudeBody(
        completionsRequest as unknown as Record<string, unknown>,
        'm',
      );

      const msgs = claudeBody.messages as any[];
      assert.deepEqual(msgs[0].content, [
        { type: 'text', text: 'see' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'aGVsbG8=' } },
      ]);
    } finally {
      globalThis.fetch = realFetch;
      setImageEncodeConfig(prior);
    }
  });
});

// ─── convertInputItemsToMessages ───────────────────────────────────────────

describe('convertInputItemsToMessages', () => {
  it('converts function_call and function_call_output items', () => {
    const msgs = convertInputItemsToMessages([
      { type: 'function_call', call_id: 'c1', name: 'search', arguments: '{"q":"x"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'result' },
    ]);

    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'assistant');
    assert.ok(msgs[0].tool_calls);
    assert.equal(msgs[0].tool_calls![0].id, 'c1');
    assert.equal(msgs[0].tool_calls![0].function.name, 'search');
    assert.equal(msgs[1].role, 'tool');
    assert.equal(msgs[1].content, 'result');
    assert.equal(msgs[1].tool_call_id, 'c1');
  });

  it('tolerates a function_call_output with a caller field and no call_id (new spec fields)', () => {
    // OpenAI's spec now allows `caller` (Direct/Program attribution) on
    // function_call_output, and call_id is now optional/nullable. Neither is
    // read by the converter, so this just locks in that unknown/absent fields
    // don't break conversion.
    const msgs = convertInputItemsToMessages([
      { type: 'function_call', call_id: 'c1', name: 'search', arguments: '{"q":"x"}' },
      {
        type: 'function_call_output',
        call_id: 'c1',
        output: 'result',
        caller: { type: 'direct' },
      },
    ]);

    assert.equal(msgs.length, 2);
    assert.equal(msgs[1].role, 'tool');
    assert.equal(msgs[1].content, 'result');
    assert.equal(msgs[1].tool_call_id, 'c1');
  });

  it('converts array-form function_call_output text parts to a string', () => {
    const msgs = convertInputItemsToMessages([
      {
        type: 'function_call_output',
        call_id: 'c1',
        output: [{ type: 'input_text', text: 'result' }],
      },
    ]);

    assert.equal(msgs[0].role, 'tool');
    assert.equal(msgs[0].content, 'result');
  });

  it('converts array-form function_call_output with an image to content parts', () => {
    const msgs = convertInputItemsToMessages([
      {
        type: 'function_call_output',
        call_id: 'c1',
        output: [
          { type: 'input_text', text: 'see image' },
          { type: 'input_image', image_url: 'https://example.com/x.png' },
        ],
      },
    ]);

    assert.equal(msgs[0].role, 'tool');
    assert.ok(Array.isArray(msgs[0].content));
    const parts = msgs[0].content as Array<Record<string, unknown>>;
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[0].text, 'see image');
    assert.equal(parts[1].type, 'image_url');
    assert.deepEqual(parts[1].image_url, { url: 'https://example.com/x.png' });
  });

  it('attaches pending reasoning_content to the next assistant turn', () => {
    const msgs = convertInputItemsToMessages([
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'deep thought' }] },
      { type: 'message', role: 'assistant', content: 'answer' },
    ]);

    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'assistant');
    assert.equal((msgs[0] as any).reasoning_content, 'deep thought');
    assert.equal(msgs[0].content, 'answer');
  });

  it('merges consecutive function_call and assistant message items into one assistant message', () => {
    const msgs = convertInputItemsToMessages([
      { type: 'function_call', call_id: 'c1', name: 'fn1', arguments: '{}' },
      { type: 'message', role: 'assistant', content: 'text' },
    ]);

    assert.equal(msgs.length, 1, 'must merge into a single assistant message');
    assert.ok(msgs[0].tool_calls);
    assert.equal(msgs[0].tool_calls!.length, 1);
    // The text from the assistant message is merged in
    assert.equal(msgs[0].content, 'text');
  });

  it('converts a user message item', () => {
    const msgs = convertInputItemsToMessages([
      { type: 'message', role: 'user', content: 'hello' },
    ]);

    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'user');
    assert.equal(msgs[0].content, 'hello');
  });

  it('maps developer role to system', () => {
    const msgs = convertInputItemsToMessages([
      { type: 'message', role: 'developer', content: 'instructions' },
    ]);

    assert.equal(msgs[0].role, 'system');
  });

  it('rejects an unrecognized item type with a 400 ValidationError rather than dropping it', () => {
    // The Responses API item union keeps growing. An item this converter does
    // not know must fail loudly: answering from partial context while the client
    // believes the full input was used is worse than refusing — CLAUDE.md rule 8.
    assert.throws(
      () => convertInputItemsToMessages(
        [{ type: 'computer_call_output', id: 'x1', call_id: 'c1', output: {} }],
        { requestId: 'req-1' },
      ),
      (err: any) => {
        assert.equal(err.name, 'ValidationError');
        assert.equal(err.status, 400, 'surfaces to the client as a 400, not a 500');
        assert.match(err.message, /computer_call_output/);
        assert.match(err.message, /openai-responses/, 'points at the passthrough upstream as the fix');
        return true;
      },
    );
  });

  it('rejects a program item with a 400 ValidationError rather than degrading it', () => {
    // `program` carries a flat `code` string plus an opaque `fingerprint` the
    // spec says must be round-tripped. Chat Completions can carry neither, so
    // converting would silently break program replay upstream. Refuse instead.
    assert.throws(
      () => convertInputItemsToMessages([
        { type: 'program', id: 'p1', call_id: 'c1', code: 'console.log(1)', fingerprint: 'fp-abc' },
      ]),
      (err: any) => {
        assert.equal(err.name, 'ValidationError');
        assert.equal(err.status, 400, 'surfaces to the client as a 400, not a 500');
        assert.equal(err.type, 'invalid_request_error');
        assert.match(err.message, /program/);
        assert.match(err.message, /openai-responses/, 'points at the passthrough upstream as the fix');
        return true;
      },
    );
  });

  it('rejects a program_output item with a 400 ValidationError', () => {
    assert.throws(
      () => convertInputItemsToMessages([
        { type: 'program_output', id: 'o1', call_id: 'c1', result: '42', status: 'completed' },
      ]),
      (err: any) => {
        assert.equal(err.name, 'ValidationError');
        assert.equal(err.status, 400);
        assert.match(err.message, /program_output/);
        return true;
      },
    );
  });

  it('rejects a program item even when it is buried among valid items', () => {
    // The reject must not depend on position — a mid-conversation program item
    // is exactly the replay case that would otherwise be silently flattened.
    assert.throws(
      () => convertInputItemsToMessages([
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'program', id: 'p1', call_id: 'c1', code: 'x()', fingerprint: 'fp' },
        { type: 'message', role: 'assistant', content: 'done' },
      ]),
      (err: any) => err.name === 'ValidationError' && err.status === 400,
    );
  });

  it('does not warn for recognized item types that intentionally emit nothing', () => {
    // `additional_tools` and `reasoning` are consumed elsewhere and emit no
    // message by design — they must not be reported as dropped.
    const warnings: string[] = [];
    const logger = {
      trace: () => {}, debug: () => {}, info: () => {}, error: () => {},
      warn: (_requestId: string, message: string) => { warnings.push(message); },
    } as any;

    convertInputItemsToMessages(
      [
        { type: 'additional_tools', role: 'developer', tools: [] },
        { type: 'message', role: 'user', content: 'hi' },
      ],
      { logger, requestId: 'req-2' },
    );

    assert.deepEqual(warnings, [], 'no warnings for recognized types');
  });
});

describe('request parameter forwarding (spec item 10)', () => {
  it('forwards service_tier, metadata, and parallel_tool_calls', () => {
    const out = convertResponsesToChatCompletions({
      model: 'm',
      input: 'hi',
      service_tier: 'priority',
      metadata: { tenant: 't1' },
      parallel_tool_calls: false,
    }, 'm');

    assert.equal(out.service_tier, 'priority');
    assert.deepEqual(out.metadata, { tenant: 't1' });
    assert.equal(out.parallel_tool_calls, false);
  });

  it('maps text.format json_schema to response_format', () => {
    const schema = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
    const out = convertResponsesToChatCompletions({
      model: 'm',
      input: 'hi',
      text: { format: { type: 'json_schema', name: 'answer_schema', schema, strict: true } },
    }, 'm');

    assert.deepEqual(out.response_format, {
      type: 'json_schema',
      json_schema: { name: 'answer_schema', schema, strict: true },
    });
  });

  it('maps text.format json_object to response_format', () => {
    const out = convertResponsesToChatCompletions({
      model: 'm',
      input: 'hi',
      text: { format: { type: 'json_object' } },
    }, 'm');

    assert.deepEqual(out.response_format, { type: 'json_object' });
  });

  it('text.format wins over a directly-passed response_format', () => {
    const out = convertResponsesToChatCompletions({
      model: 'm',
      input: 'hi',
      response_format: { type: 'text' },
      text: { format: { type: 'json_object' } },
    }, 'm');

    assert.deepEqual(out.response_format, { type: 'json_object' });
  });

  it('rejects an unknown text.format type', () => {
    assert.throws(
      () => convertResponsesToChatCompletions({
        model: 'm',
        input: 'hi',
        text: { format: { type: 'xml' } },
      }, 'm'),
      (err: any) => err.name === 'ValidationError' && err.status === 400 && /xml/.test(err.message),
    );
  });

  it('accepts and drops truncation: auto and disabled (completions upstreams fail on overflow)', () => {
    for (const truncation of ['auto', 'disabled']) {
      const out = convertResponsesToChatCompletions({ model: 'm', input: 'hi', truncation }, 'm');
      assert.equal((out as Record<string, unknown>).truncation, undefined);
    }
  });

  it('rejects an invalid truncation value', () => {
    assert.throws(
      () => convertResponsesToChatCompletions({ model: 'm', input: 'hi', truncation: 'sometimes' }, 'm'),
      (err: any) => err.name === 'ValidationError' && err.status === 400,
    );
  });
});

describe('allowed_tools (spec item 3)', () => {
  it('translates tool_choice allowed_tools to auto and keeps the full tools list', () => {
    const out = convertResponsesToChatCompletions({
      model: 'm',
      input: 'hi',
      tools: [
        { type: 'function', name: 'allowed_fn', parameters: { type: 'object', properties: {} } },
        { type: 'function', name: 'blocked_fn', parameters: { type: 'object', properties: {} } },
      ],
      tool_choice: { type: 'allowed_tools', tools: [{ type: 'function', name: 'allowed_fn' }] },
    }, 'm');

    assert.equal(out.tool_choice, 'auto', 'completions cannot express a subset — enforce response-side');
    assert.deepEqual(out.tools?.map(t => t.function.name), ['allowed_fn', 'blocked_fn'], 'full tools list still goes upstream');
  });

  it('maps an empty allowed_tools subset to tool_choice none', () => {
    const out = convertResponsesToChatCompletions({
      model: 'm',
      input: 'hi',
      tools: [{ type: 'function', name: 'fn', parameters: { type: 'object', properties: {} } }],
      tool_choice: { type: 'allowed_tools', tools: [] },
    }, 'm');

    assert.equal(out.tool_choice, 'none');
  });

  it('extractAllowedTools reads the tool_choice form', () => {
    const allowed = extractAllowedTools({
      tool_choice: { type: 'allowed_tools', tools: [{ type: 'function', name: 'a' }, { type: 'function', name: 'b' }] },
    });
    assert.deepEqual(allowed, new Set(['a', 'b']));
  });

  it('extractAllowedTools reads the top-level field', () => {
    const allowed = extractAllowedTools({ allowed_tools: [{ type: 'function', name: 'a' }] });
    assert.deepEqual(allowed, new Set(['a']));
  });

  it('extractAllowedTools returns null when unconstrained, empty set when nothing is allowed', () => {
    assert.equal(extractAllowedTools({ tool_choice: 'auto' }), null);
    assert.equal(extractAllowedTools({}), null);
    assert.deepEqual(extractAllowedTools({ allowed_tools: [] }), new Set());
  });

  it('non-streaming: suppresses disallowed tool calls and reports the count', () => {
    const warnings: string[] = [];
    const logger = {
      trace: () => {}, debug: () => {}, info: () => {}, error: () => {},
      warn: (_requestId: string, message: string) => { warnings.push(message); },
    } as any;
    const completions = baseCompletion({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null as unknown as string,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'allowed_fn', arguments: '{}' } },
            { id: 'c2', type: 'function', function: { name: 'blocked_fn', arguments: '{}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    });

    const out = convertCompletionsToResponses(completions, 'm', undefined, {
      allowedTools: new Set(['allowed_fn']), logger, requestId: 'req-1',
    });

    const functionCalls = out.output.filter(it => it.type === 'function_call');
    assert.deepEqual(functionCalls.map(it => it.name), ['allowed_fn']);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /suppressed 1 tool call/);
  });

  it('non-streaming: suppressing the only tool call falls back to a direct-reply message', () => {
    const completions = baseCompletion({
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null as unknown as string,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: 'blocked_fn', arguments: '{}' } },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    });

    const out = convertCompletionsToResponses(completions, 'm', undefined, { allowedTools: new Set(['other_fn']) });

    assert.equal(out.output.length, 1);
    assert.equal(out.output[0].type, 'message', 'output must never be empty — direct-reply fallback');
    assert.deepEqual(out.output[0].content, [{ type: 'output_text', text: '', annotations: [] }]);
  });
});

describe('unknown input item types (spec item 12)', () => {
  it('rejects provider-slug-prefixed extension types too', () => {
    assert.throws(
      () => convertInputItemsToMessages([{ type: 'acme:search_result', id: 'x1' }]),
      (err: any) => err.name === 'ValidationError' && err.status === 400 && /acme:search_result/.test(err.message),
    );
  });

  it('still converts the known item types', () => {
    const msgs = convertInputItemsToMessages([
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'thinking' }] },
      { type: 'function_call', call_id: 'c1', name: 'fn', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ]);
    assert.deepEqual(msgs.map(m => m.role), ['user', 'assistant', 'tool']);
  });
});
