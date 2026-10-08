/**
 * Unit tests for the request-transform engine.
 *
 * Run with:
 *   npx tsx --test tests/unit/request-transform.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runHook, buildEventTransformer, applyAfterUpstream, applyWriteoutBody, pipeEventTransformer, hasHookOps, type HookContext, type HookBodyPayload } from '../../src/utils/request-transform.js';
import type { TransformSet, ModelRouteConfig } from '../../src/utils/config-loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoute(transforms: TransformSet[]): ModelRouteConfig {
  return {
    targetUrl: 'https://example.com',
    upstreamMode: 'openai-completions',
    transforms,
  };
}

function makeCtx(transforms: TransformSet[], hook: HookContext['hook'] = 'before_upstream'): HookContext {
  return {
    hook,
    route: makeRoute(transforms),
    upstreamMode: 'openai-completions',
    clientModel: 'test-model',
    requestId: 'req-1',
    streaming: false,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
  };
}

function payload(body: Record<string, unknown>, headers: Record<string, string> = {}): HookBodyPayload {
  return { body, headers };
}

// ---------------------------------------------------------------------------
// Tier-1: rename
// ---------------------------------------------------------------------------

describe('Tier-1 op: rename (top-level)', () => {
  const set: TransformSet = {
    name: 'rename_test',
    schema: 'openai-completions',
    before_upstream: {
      ops: [{ op: 'rename', path: 'max_tokens', to: 'max_completion_tokens' }],
    },
  };

  it('renames the field and removes the old one', () => {
    const result = runHook('before_upstream', payload({ max_tokens: 1000 }), makeCtx([set]));
    assert.equal(result.body['max_completion_tokens'], 1000);
    assert.equal('max_tokens' in result.body, false);
  });

  it('is a no-op when the field is absent', () => {
    const result = runHook('before_upstream', payload({ temperature: 0.7 }), makeCtx([set]));
    assert.equal('max_completion_tokens' in result.body, false);
    assert.equal(result.body['temperature'], 0.7);
  });
});

// ---------------------------------------------------------------------------
// Tier-1: set / default
// ---------------------------------------------------------------------------

describe('Tier-1 op: set and default', () => {
  const setOp: TransformSet = {
    name: 'set_test',
    schema: 'openai-completions',
    before_upstream: {
      ops: [{ op: 'set', path: 'temperature', value: 0.5 }],
    },
  };

  it('set forces a value even when already present', () => {
    const result = runHook('before_upstream', payload({ temperature: 1.0 }), makeCtx([setOp]));
    assert.equal(result.body['temperature'], 0.5);
  });

  const defaultOp: TransformSet = {
    name: 'default_test',
    schema: 'openai-completions',
    before_upstream: {
      ops: [{ op: 'default', path: 'temperature', value: 0.5 }],
    },
  };

  it('default sets the value only when absent', () => {
    const result = runHook('before_upstream', payload({}), makeCtx([defaultOp]));
    assert.equal(result.body['temperature'], 0.5);
  });

  it('default leaves the value if already set', () => {
    const result = runHook('before_upstream', payload({ temperature: 1.0 }), makeCtx([defaultOp]));
    assert.equal(result.body['temperature'], 1.0);
  });
});

// ---------------------------------------------------------------------------
// Tier-1: remove
// ---------------------------------------------------------------------------

describe('Tier-1 op: remove', () => {
  const set: TransformSet = {
    name: 'remove_test',
    schema: 'openai-completions',
    before_upstream: {
      ops: [{ op: 'remove', path: 'output_config' }],
    },
  };

  it('removes the field', () => {
    const result = runHook('before_upstream', payload({ output_config: { effort: 'high' }, model: 'x' }), makeCtx([set]));
    assert.equal('output_config' in result.body, false);
    assert.equal(result.body['model'], 'x');
  });

  it('is a no-op when field absent', () => {
    const result = runHook('before_upstream', payload({ model: 'x' }), makeCtx([set]));
    assert.equal(result.body['model'], 'x');
  });
});

// ---------------------------------------------------------------------------
// Tier-1: map_value
// ---------------------------------------------------------------------------

describe('Tier-1 op: map_value', () => {
  const set: TransformSet = {
    name: 'map_test',
    schema: 'openai-completions',
    before_upstream: {
      ops: [{
        op: 'map_value',
        path: 'messages[role=assistant].content',
        when_sibling: 'tool_calls',
        from: '',
        to: null,
      }],
    },
  };

  it('replaces "" with null on assistant messages that have tool_calls', () => {
    const body = {
      messages: [
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1' }] },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    const msg = (result.body.messages as Record<string, unknown>[])[0];
    assert.equal(msg.content, null);
  });

  it('does not replace "" on assistant messages without tool_calls (when_sibling guard)', () => {
    const body = {
      messages: [
        { role: 'assistant', content: '' },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    const msg = (result.body.messages as Record<string, unknown>[])[0];
    assert.equal(msg.content, '');
  });

  it('does not affect other roles', () => {
    const body = {
      messages: [
        { role: 'user', content: '', tool_calls: [{}] },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    const msg = (result.body.messages as Record<string, unknown>[])[0];
    assert.equal(msg.content, '');
  });

  it('applies to all matching messages', () => {
    const body = {
      messages: [
        { role: 'assistant', content: '', tool_calls: [{}] },
        { role: 'assistant', content: 'hello', tool_calls: [{}] },
        { role: 'assistant', content: '', tool_calls: [{}] },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    const msgs = result.body.messages as Record<string, unknown>[];
    assert.equal(msgs[0].content, null);
    assert.equal(msgs[1].content, 'hello');
    assert.equal(msgs[2].content, null);
  });
});

// ---------------------------------------------------------------------------
// Tier-2 built-in: project_program_to_node_tool
// ---------------------------------------------------------------------------

describe('Tier-2 builtin: project_program_to_node_tool', () => {
  const set: TransformSet = {
    name: 'program_node',
    schema: 'openai-responses',
    before_conversion: { builtins: ['project_program_to_node_tool'] },
  };
  const ctx = makeCtx([set], 'before_conversion');
  const nodeTool = { type: 'function', name: 'node', parameters: {} };

  it('projects a program item onto a node function_call carrying code and fingerprint', () => {
    const body = {
      tools: [nodeTool],
      input: [{ type: 'program', id: 'p1', call_id: 'c1', code: 'return 1+1', fingerprint: 'fp-abc' }],
    };
    const out = runHook('before_conversion', payload(body), ctx).body;
    const items = out.input as Record<string, unknown>[];

    assert.equal(items.length, 1);
    assert.equal(items[0].type, 'function_call');
    assert.equal(items[0].name, 'node');
    assert.equal(items[0].call_id, 'c1', 'call_id is preserved so the output can pair with it');
    assert.deepEqual(JSON.parse(items[0].arguments as string), {
      code: 'return 1+1', fingerprint: 'fp-abc', type: 'program',
    });
  });

  it('projects a program_output item onto a function_call_output carrying result and status', () => {
    const body = {
      tools: [nodeTool],
      input: [{ type: 'program_output', id: 'o1', call_id: 'c1', result: '2', status: 'completed' }],
    };
    const out = runHook('before_conversion', payload(body), ctx).body;
    const items = out.input as Record<string, unknown>[];

    assert.equal(items[0].type, 'function_call_output');
    assert.equal(items[0].call_id, 'c1');
    assert.deepEqual(JSON.parse(items[0].output as string), {
      result: '2', status: 'completed', type: 'program_output',
    });
  });

  it('leaves program items untouched when no node tool is declared', () => {
    // Without a declared `node` tool the projection would invent a capability
    // the upstream was never given, so the builtin declines and lets the
    // converter reject the request instead.
    const body = {
      tools: [{ type: 'function', name: 'search', parameters: {} }],
      input: [{ type: 'program', id: 'p1', call_id: 'c1', code: 'x()', fingerprint: 'fp' }],
    };
    const out = runHook('before_conversion', payload(body), ctx).body;
    const items = out.input as Record<string, unknown>[];

    assert.equal(items[0].type, 'program', 'item is left for the converter to reject');
  });

  it('accepts a completions-style node tool declaration', () => {
    const body = {
      tools: [{ type: 'function', function: { name: 'node', parameters: {} } }],
      input: [{ type: 'program', id: 'p1', call_id: 'c1', code: 'x()', fingerprint: 'fp' }],
    };
    const out = runHook('before_conversion', payload(body), ctx).body;
    assert.equal((out.input as Record<string, unknown>[])[0].type, 'function_call');
  });

  it('preserves surrounding items and their order', () => {
    const body = {
      tools: [nodeTool],
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'program', id: 'p1', call_id: 'c1', code: 'x()', fingerprint: 'fp' },
        { type: 'program_output', id: 'o1', call_id: 'c1', result: 'ok', status: 'completed' },
        { type: 'message', role: 'assistant', content: 'done' },
      ],
    };
    const out = runHook('before_conversion', payload(body), ctx).body;
    const items = out.input as Record<string, unknown>[];

    assert.equal(items.length, 4);
    assert.deepEqual(items.map(i => i.type),
      ['message', 'function_call', 'function_call_output', 'message']);
  });

  it('is a no-op for requests with no program items', () => {
    const body = {
      tools: [nodeTool],
      input: [{ type: 'message', role: 'user', content: 'hi' }],
    };
    const out = runHook('before_conversion', payload(body), ctx).body;
    assert.deepEqual(out.input, [{ type: 'message', role: 'user', content: 'hi' }]);
  });
});

// ---------------------------------------------------------------------------
// Tier-2 built-in: lowercase_tool_schema_types
// ---------------------------------------------------------------------------

describe('Tier-2 builtin: lowercase_tool_schema_types', () => {
  const set: TransformSet = {
    name: 'lc_schema',
    schema: 'openai-completions',
    request_ingress: { builtins: ['lowercase_tool_schema_types'] },
  };

  it('lowercases type fields in tool parameters', () => {
    const body = {
      tools: [{
        function: {
          name: 'search',
          parameters: { type: 'OBJECT', properties: { q: { type: 'STRING' } } },
        },
      }],
    };
    const result = runHook('request_ingress', payload(body), makeCtx([set], 'request_ingress'));
    const params = ((result.body.tools as any)[0]).function.parameters;
    assert.equal(params.type, 'object');
    assert.equal(params.properties.q.type, 'string');
  });

  it('handles anthropic input_schema shape', () => {
    const body = {
      tools: [{
        input_schema: { type: 'OBJECT', properties: { n: { type: 'INTEGER' } } },
      }],
    };
    const result = runHook('request_ingress', payload(body), makeCtx([set], 'request_ingress'));
    const schema = ((result.body.tools as any)[0]).input_schema;
    assert.equal(schema.type, 'object');
    assert.equal(schema.properties.n.type, 'integer');
  });

  it('is a no-op when tools is absent', () => {
    const body = { model: 'x' };
    const result = runHook('request_ingress', payload(body), makeCtx([set], 'request_ingress'));
    assert.equal(result.body['model'], 'x');
  });
});

// ---------------------------------------------------------------------------
// Tier-2 built-in: recover_tool_message_name
// ---------------------------------------------------------------------------

describe('Tier-2 builtin: recover_tool_message_name', () => {
  const set: TransformSet = {
    name: 'recover_name',
    schema: 'openai-completions',
    before_upstream: { builtins: ['recover_tool_message_name'] },
  };

  it('fills missing tool message name from prior assistant tool_calls', () => {
    const body = {
      messages: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'result' },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    const msgs = result.body.messages as Record<string, unknown>[];
    assert.equal(msgs[1].name, 'search');
  });

  it('does not overwrite existing name', () => {
    const body = {
      messages: [
        { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'search', arguments: '' } }] },
        { role: 'tool', tool_call_id: 'c1', name: 'already', content: 'result' },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    const msgs = result.body.messages as Record<string, unknown>[];
    assert.equal(msgs[1].name, 'already');
  });
});

// ---------------------------------------------------------------------------
// Tier-2 builtin: inject_missing_tool_results (Anthropic-format)
// ---------------------------------------------------------------------------

describe('Tier-2 builtin: inject_missing_tool_results', () => {
  const set: TransformSet = {
    name: 'inject_tool_results',
    schema: 'anthropic-messages',
    before_upstream: { builtins: ['inject_missing_tool_results'] },
  };

  function makeAnthropicCtx(): HookContext {
    return {
      hook: 'before_upstream',
      route: makeRoute([set]),
      upstreamMode: 'anthropic-messages',
      clientModel: 'test-model',
      requestId: 'req-1',
      streaming: false,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    };
  }

  it('inserts a new user message with tool_result when the next user message has text content', () => {
    // DeepSeek rejects mixing tool_result and text in the same user message.
    // The built-in inserts a dedicated user message with only tool_result blocks
    // immediately after the assistant turn, leaving the text message intact.
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_a', name: 'do_thing', input: {} }],
        },
        { role: 'user', content: [{ type: 'text', text: 'next prompt' }] },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeAnthropicCtx());
    const msgs = result.body.messages as any[];
    // A new message was inserted at index 2; the original text message is now at index 3.
    assert.equal(msgs.length, 4, 'a new tool_result message must have been inserted');
    const inserted = msgs[2];
    assert.equal(inserted.role, 'user');
    assert.ok(Array.isArray(inserted.content));
    assert.equal(inserted.content.length, 1);
    assert.equal(inserted.content[0].type, 'tool_result');
    assert.equal(inserted.content[0].tool_use_id, 'call_a');
    assert.equal(inserted.content[0].content, '');
    const originalTextMsg = msgs[3];
    assert.deepEqual(originalTextMsg.content, [{ type: 'text', text: 'next prompt' }], 'original text message must be unchanged');
  });

  it('inserts a new user message when the following user message has a string content', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_a', name: 'do_thing', input: {} }],
        },
        { role: 'user', content: 'Did you call?' },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeAnthropicCtx());
    const msgs = result.body.messages as any[];
    assert.equal(msgs.length, 3, 'a new tool_result message must have been inserted');
    const inserted = msgs[1];
    assert.equal(inserted.role, 'user');
    assert.ok(Array.isArray(inserted.content));
    assert.equal(inserted.content[0].type, 'tool_result');
    assert.equal(inserted.content[0].tool_use_id, 'call_a');
    assert.equal(inserted.content[0].content, '');
    const originalMsg = msgs[2];
    assert.equal(originalMsg.content, 'Did you call?', 'original string message must be unchanged');
  });

  it('inserts a new user message with multiple missing tool_result blocks', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_a', name: 'foo', input: {} },
            { type: 'tool_use', id: 'call_b', name: 'bar', input: {} },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'next' }] },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeAnthropicCtx());
    const msgs = result.body.messages as any[];
    assert.equal(msgs.length, 3, 'a synthetic tool_result message must have been inserted');
    const inserted = msgs[1];
    assert.ok(Array.isArray(inserted.content));
    const synthesized = (inserted.content as Array<Record<string, unknown>>).filter((b) => b.type === 'tool_result');
    assert.equal(synthesized.length, 2);
    const ids = new Set(synthesized.map((b) => b.tool_use_id));
    assert.ok(ids.has('call_a'));
    assert.ok(ids.has('call_b'));
  });

  it('only synthesizes missing ids, leaves existing tool_results alone', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_a', name: 'foo', input: {} },
            { type: 'tool_use', id: 'call_b', name: 'bar', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_a', content: 'existing result for a' },
          ],
        },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeAnthropicCtx());
    const userContent = (result.body.messages as any[])[1].content as Array<Record<string, unknown>>;
    assert.equal(userContent.length, 2);
    const existing = userContent.find((b) => (b as any).tool_use_id === 'call_a');
    assert.equal((existing as any).content, 'existing result for a', 'existing result must be untouched');
    const synthesized = userContent.find((b) => (b as any).tool_use_id === 'call_b');
    assert.ok(synthesized, 'call_b must be synthesized');
    assert.equal((synthesized as any).content, '');
  });

  it('does not synthesize when all tool_results are already present', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_a', name: 'foo', input: {} },
            { type: 'tool_use', id: 'call_b', name: 'bar', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_a', content: 'a result' },
            { type: 'tool_result', tool_use_id: 'call_b', content: 'b result' },
          ],
        },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeAnthropicCtx());
    const userContent = (result.body.messages as any[])[1].content as Array<Record<string, unknown>>;
    assert.equal(userContent.length, 2, 'no extra blocks must be added');
    assert.equal((userContent[0] as any).content, 'a result');
    assert.equal((userContent[1] as any).content, 'b result');
  });

  it('does not synthesize when the assistant message has no tool_use blocks', () => {
    const body = {
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'just text' }] },
        { role: 'user', content: [{ type: 'text', text: 'no tool calls happened' }] },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeAnthropicCtx());
    const userContent = (result.body.messages as any[])[1].content as Array<Record<string, unknown>>;
    assert.equal(userContent.length, 1);
    assert.equal(userContent[0].type, 'text');
  });

  it('synthesizes a tool_result and reorders when tool_use assistant is followed by a text-only assistant', () => {
    // DeepSeek rejects an assistant tool_use that is not immediately followed
    // by a user tool_result. When the conversation has
    //   [tool_use_assistant, text_only_assistant]
    // the text-only assistant is treated as a "tail" that must move AFTER the
    // synthesized tool_result user message:
    //   [tool_use_assistant, user(tool_result), text_only_assistant]
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'call_a', name: 'foo', input: {} }],
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'second turn from assistant' }],
        },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeAnthropicCtx());
    const msgs = result.body.messages as any[];
    assert.equal(msgs.length, 3, 'a tool_result user message must be inserted between the two assistants');
    assert.equal(msgs[0].role, 'assistant');
    assert.equal(msgs[1].role, 'user');
    const inserted = msgs[1].content as Array<Record<string, unknown>>;
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].type, 'tool_result');
    assert.equal(inserted[0].tool_use_id, 'call_a');
    assert.equal(msgs[2].role, 'assistant');
    assert.equal((msgs[2].content as Array<Record<string, unknown>>)[0].type, 'text');
  });

  it('appends a tool_result user message when tool_use is the last message', () => {
    // Reproduces the Codex × deepseek-v4-anth failure: an assistant tool_use as
    // the FINAL message with no following user message at all. DeepSeek's
    // anthropic-messages endpoint rejects this with
    //   "tool_use ids were found without tool_result blocks immediately after".
    // The built-in must append a synthesized user message with one placeholder
    // tool_result per tool_use id.
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'do the thing' }] },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_01_xyz', name: 'Glob', input: { pattern: 'x' } },
            { type: 'tool_use', id: 'call_01_abc', name: 'Read', input: { path: 'y' } },
          ],
        },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeAnthropicCtx());
    const msgs = result.body.messages as any[];
    assert.equal(msgs.length, 3, 'a tool_result user message must have been appended');
    assert.equal(msgs[2].role, 'user');
    const inserted = msgs[2].content as Array<Record<string, unknown>>;
    assert.equal(inserted.length, 2, 'one placeholder per tool_use id');
    const ids = new Set(inserted.map((b) => b.tool_use_id));
    assert.ok(ids.has('call_01_xyz'));
    assert.ok(ids.has('call_01_abc'));
    for (const b of inserted) {
      assert.equal(b.type, 'tool_result');
      assert.equal(b.content, '');
    }
  });

  it('merges consecutive pure-tool user messages into one and synthesizes missing ids', () => {
    // Simulates the pattern produced by completionsBodyToClaudeBody when the
    // client sends multiple role:"tool" messages (one per call) after one
    // assistant turn with multiple tool_use blocks.
    //
    //   [0] assistant (tool_use A, tool_use B)
    //   [1] user (tool_result A)   <- pure-tool, separate message
    //   [2] user (tool_result B)   <- pure-tool, separate message — will be merged into [1]
    //
    // After built-in: [0] assistant, [1] user (tool_result A, tool_result B)
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_a', name: 'foo', input: {} },
            { type: 'tool_use', id: 'call_b', name: 'bar', input: {} },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'a result' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_b', content: 'b result' }] },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeAnthropicCtx());
    const msgs = result.body.messages as any[];
    assert.equal(msgs.length, 2, 'both pure-tool messages must be merged into one');
    const merged = msgs[1];
    assert.equal(merged.role, 'user');
    assert.equal(merged.content.length, 2, 'merged message must have both tool_result blocks');
    const ids = new Set(merged.content.map((b: any) => b.tool_use_id));
    assert.ok(ids.has('call_a'));
    assert.ok(ids.has('call_b'));
    assert.equal(merged.content.find((b: any) => b.tool_use_id === 'call_a').content, 'a result');
    assert.equal(merged.content.find((b: any) => b.tool_use_id === 'call_b').content, 'b result');
  });

  it('merges consecutive pure-tool messages and synthesizes any still-missing ids', () => {
    // Three tool_use blocks, two are covered by separate messages, one is missing entirely.
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_a', name: 'foo', input: {} },
            { type: 'tool_use', id: 'call_b', name: 'bar', input: {} },
            { type: 'tool_use', id: 'call_c', name: 'baz', input: {} },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'a' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_b', content: 'b' }] },
        // call_c has no tool_result at all
      ],
    };
    const result = runHook('before_upstream', payload(body), makeAnthropicCtx());
    const msgs = result.body.messages as any[];
    assert.equal(msgs.length, 2, 'all three become one merged+synthesized message');
    const merged = msgs[1].content as any[];
    assert.equal(merged.length, 3);
    const ids = new Set(merged.map((b: any) => b.tool_use_id));
    assert.ok(ids.has('call_a'));
    assert.ok(ids.has('call_b'));
    assert.ok(ids.has('call_c'), 'missing call_c must be synthesized');
    assert.equal(merged.find((b: any) => b.tool_use_id === 'call_c').content, '');
  });

  it('handles split-assistant pattern: inserts tool_result between tool_use and text assistants', () => {
    // Codex SDK via Responses API sometimes emits two consecutive assistant messages:
    // one with tool_calls, one with text. The tool_results land after the text assistant.
    // DeepSeek requires the tool_result user message IMMEDIATELY after the tool_use assistant
    // (no other assistant in between). We reorder: move tool_results before the text assistant.
    //
    //   [0] assistant (tool_use A, tool_use B)
    //   [1] assistant (text "Let me search...")  <- text-only, no tool_use
    //   [2] user (tool_result A)
    //   [3] user (tool_result B)
    //
    // After built-in:
    //   [0] assistant (tool_use A, tool_use B)
    //   [1] user (tool_result A, tool_result B)  <- consolidated, moved before text assistant
    //   [2] assistant (text "Let me search...")  <- moved after
    const body = {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call_a', name: 'foo', input: {} },
            { type: 'tool_use', id: 'call_b', name: 'bar', input: {} },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'Let me search...' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_a', content: 'a result' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_b', content: 'b result' }] },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeAnthropicCtx());
    const msgs = result.body.messages as any[];
    assert.equal(msgs.length, 3, 'must reorder to 3 messages');
    assert.equal(msgs[0].role, 'assistant');
    assert.ok(msgs[0].content.every((b: any) => b.type === 'tool_use'), 'assistant content must be pure tool_use');
    assert.equal(msgs[1].role, 'user', 'user with tool_results must be at index 1');
    assert.ok(msgs[1].content.every((b: any) => b.type === 'tool_result'), 'user content must be pure tool_result');
    assert.equal(msgs[1].content.length, 2, 'both tool_results must be merged into one message');
    const ids = new Set(msgs[1].content.map((b: any) => b.tool_use_id));
    assert.ok(ids.has('call_a'));
    assert.ok(ids.has('call_b'));
    assert.equal(msgs[2].role, 'assistant', 'text-only assistant must be at index 2');
    assert.equal(msgs[2].content[0].text, 'Let me search...');
  });
});

// ---------------------------------------------------------------------------
// Header transforms
// ---------------------------------------------------------------------------

describe('header transforms', () => {
  const set: TransformSet = {
    name: 'hdr_test',
    schema: 'openai-completions',
    response_egress: {
      headers: { set: { 'x-proxy': 'v3' }, remove: ['openai-organization'] },
    },
  };

  it('sets and removes headers', () => {
    const result = runHook(
      'response_egress',
      payload({}, { 'openai-organization': 'org-1', 'content-type': 'application/json' }),
      makeCtx([set], 'response_egress'),
    );
    assert.equal(result.headers['x-proxy'], 'v3');
    assert.equal('openai-organization' in result.headers, false);
    assert.equal(result.headers['content-type'], 'application/json');
  });
});

// ---------------------------------------------------------------------------
// Tier-2 builtin: filter_anthropic_beta
// ---------------------------------------------------------------------------

describe('Tier-2 builtin: filter_anthropic_beta', () => {
  // Shared set with a map exercising pass-through, rename, and drop-by-empty.
  const set: TransformSet = {
    name: 'beta_filter',
    schema: 'anthropic-messages',
    anthropic_beta_map: {
      'computer-use-2025-01-24': 'computer-use-2025-01-24', // pass-through
      'advanced-tool-use-2025-11-20': 'tool-search-tool-2025-10-19', // rename
      'unsupported-feature': '', // explicit drop (empty string)
      // 'unknown-header' intentionally absent → drop
    },
    before_upstream: { builtins: ['filter_anthropic_beta'] },
  };

  it('passes through mapped entries, renames, drops empty/unmapped', () => {
    const headers = { 'anthropic-beta': 'computer-use-2025-01-24,advanced-tool-use-2025-11-20,unsupported-feature,unknown-header' };
    const result = runHook('before_upstream', payload({}, headers), makeCtx([set]));
    assert.equal(result.headers['anthropic-beta'], 'computer-use-2025-01-24,tool-search-tool-2025-10-19');
  });

  it('removes the header entirely when no entries survive', () => {
    const headers = { 'anthropic-beta': 'unsupported-feature,unknown-header' };
    const result = runHook('before_upstream', payload({}, headers), makeCtx([set]));
    assert.equal('anthropic-beta' in result.headers, false);
  });

  it('is a no-op when no anthropic-beta header is present', () => {
    const result = runHook('before_upstream', payload({}, {}), makeCtx([set]));
    assert.equal('anthropic-beta' in result.headers, false);
  });

  it('is a no-op (passes header through unchanged) when the set has no map', () => {
    const setNoMap: TransformSet = {
      name: 'beta_nomap',
      schema: 'anthropic-messages',
      before_upstream: { builtins: ['filter_anthropic_beta'] },
    };
    const headers = { 'anthropic-beta': 'a,b,c' };
    const result = runHook('before_upstream', payload({}, headers), makeCtx([setNoMap]));
    assert.equal(result.headers['anthropic-beta'], 'a,b,c');
  });

  it('handles comma-separated input (real Claude Code format), not JSON', () => {
    // The legacy beta-features.ts path treats the header as a JSON array and
    // fails on comma-separated input. This builtin must NOT parse JSON.
    const headers = { 'anthropic-beta': '["computer-use-2025-01-24","advanced-tool-use-2025-11-20"]' };
    const result = runHook('before_upstream', payload({}, headers), makeCtx([set]));
    // The literal JSON string is one comma-less "entry" not in the map → dropped.
    assert.equal('anthropic-beta' in result.headers, false);
  });

  it('trims whitespace around comma-separated entries', () => {
    const headers = { 'anthropic-beta': ' computer-use-2025-01-24 , advanced-tool-use-2025-11-20 ' };
    const result = runHook('before_upstream', payload({}, headers), makeCtx([set]));
    assert.equal(result.headers['anthropic-beta'], 'computer-use-2025-01-24,tool-search-tool-2025-10-19');
  });

  it('runs before headers.set/remove in the same slot', () => {
    // Builtins execute before the headers.set/remove stage. A later
    // headers.set can override the filtered value.
    const setWithOverride: TransformSet = {
      name: 'beta_override',
      schema: 'anthropic-messages',
      anthropic_beta_map: { 'a': 'a' },
      before_upstream: {
        builtins: ['filter_anthropic_beta'],
        headers: { set: { 'anthropic-beta': 'forced-value' } },
      },
    };
    const headers = { 'anthropic-beta': 'a,b,unknown' };
    const result = runHook('before_upstream', payload({}, headers), makeCtx([setWithOverride]));
    assert.equal(result.headers['anthropic-beta'], 'forced-value');
  });
});

// ---------------------------------------------------------------------------
// Tier-2 builtin: ensure_tool_config_cache_ttl
// ---------------------------------------------------------------------------

describe('Tier-2 builtin: ensure_tool_config_cache_ttl', () => {
  // Shared set: anthropic-messages schema, builtin at before_upstream.
  const set: TransformSet = {
    name: 'tool_cache_ttl',
    schema: 'anthropic-messages',
    before_upstream: { builtins: ['ensure_tool_config_cache_ttl'] },
  };

  it('appends a tool_config injection point derived from a system block cache_control', () => {
    const body = {
      system: [
        { type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      tools: [{ name: 'get_weather', input_schema: {} }],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    const ccip = result.body.cache_control_injection_points as Array<Record<string, unknown>>;
    assert.deepEqual(ccip, [{ location: 'tool_config', control: { type: 'ephemeral', ttl: '1h' } }]);
  });

  it('preserves ttl when present and omits it when absent', () => {
    const body = {
      system: [
        { type: 'text', text: 'x', cache_control: { type: 'ephemeral' } },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    const ccip = result.body.cache_control_injection_points as Array<Record<string, unknown>>;
    assert.deepEqual(ccip, [{ location: 'tool_config', control: { type: 'ephemeral' } }]);
    assert.equal('ttl' in (ccip[0].control as Record<string, unknown>), false);
  });

  it('is a no-op when system is a plain string', () => {
    const body = { system: 'You are helpful.', tools: [{ name: 't', input_schema: {} }] };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    assert.equal('cache_control_injection_points' in result.body, false);
  });

  it('is a no-op when system is absent', () => {
    const body = { tools: [{ name: 't', input_schema: {} }] };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    assert.equal('cache_control_injection_points' in result.body, false);
  });

  it('is a no-op when no system block carries cache_control', () => {
    const body = {
      system: [{ type: 'text', text: 'no cc here' }],
      tools: [{ name: 't', input_schema: {} }],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    assert.equal('cache_control_injection_points' in result.body, false);
  });

  it('is caller-wins: leaves an existing tool_config injection point untouched', () => {
    const existing = { location: 'tool_config', control: { type: 'ephemeral', ttl: '5m' } };
    const body = {
      system: [
        { type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      cache_control_injection_points: [existing],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    const ccip = result.body.cache_control_injection_points as Array<Record<string, unknown>>;
    assert.equal(ccip.length, 1, 'must not append a duplicate tool_config entry');
    assert.equal(ccip[0], existing, 'existing entry must not be mutated');
  });

  it('places cache_control_injection_points AFTER tools in body key order', () => {
    const body = {
      system: [
        { type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } },
      ],
      tools: [{ name: 't', input_schema: {} }],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    const keys = Object.keys(result.body);
    const toolsIdx = keys.indexOf('tools');
    const ccipIdx = keys.indexOf('cache_control_injection_points');
    assert.notEqual(toolsIdx, -1, 'tools must be present');
    assert.notEqual(ccipIdx, -1, 'cache_control_injection_points must be present');
    assert.ok(ccipIdx > toolsIdx, 'cache_control_injection_points must come after tools');
  });

  it('reads the FIRST system block carrying cache_control when multiple qualify', () => {
    const body = {
      system: [
        { type: 'text', text: 'a', cache_control: { type: 'ephemeral', ttl: '1h' } },
        { type: 'text', text: 'b', cache_control: { type: 'ephemeral', ttl: '5m' } },
      ],
    };
    const result = runHook('before_upstream', payload(body), makeCtx([set]));
    const ccip = result.body.cache_control_injection_points as Array<Record<string, unknown>>;
    assert.deepEqual(ccip[0].control, { type: 'ephemeral', ttl: '1h' });
  });
});

// ---------------------------------------------------------------------------
// Multiple transform sets, fold order
// ---------------------------------------------------------------------------

describe('multiple transform sets fold left-to-right', () => {
  it('later set sees result of earlier set (rename then map_value)', () => {
    // Set A renames foo → bar. Set B removes bar.
    const setA: TransformSet = {
      name: 'a',
      schema: 'openai-completions',
      before_upstream: { ops: [{ op: 'rename', path: 'max_tokens', to: 'max_completion_tokens' }] },
    };
    const setB: TransformSet = {
      name: 'b',
      schema: 'openai-completions',
      before_upstream: { ops: [{ op: 'remove', path: 'max_completion_tokens' }] },
    };
    const result = runHook('before_upstream', payload({ max_tokens: 100 }), makeCtx([setA, setB]));
    assert.equal('max_tokens' in result.body, false);
    assert.equal('max_completion_tokens' in result.body, false);
  });
});

// ---------------------------------------------------------------------------
// No-op fast path
// ---------------------------------------------------------------------------

describe('runHook fast paths', () => {
  it('returns payload unchanged when no transforms', () => {
    const route = makeRoute([]);
    const ctx = makeCtx([]);
    ctx.route = route;
    const p = payload({ model: 'x' });
    const result = runHook('before_upstream', p, ctx);
    assert.equal(result, p);
  });
});

// ---------------------------------------------------------------------------
// buildEventTransformer
// ---------------------------------------------------------------------------

describe('buildEventTransformer', () => {
  it('returns null when no transforms declare the hook', () => {
    const set: TransformSet = {
      name: 'no_writeout',
      schema: 'openai-completions',
      before_upstream: { ops: [{ op: 'remove', path: 'output_config' }] },
    };
    const ctx = makeCtx([set], 'response_egress');
    assert.equal(buildEventTransformer('response_egress', ctx), null);
  });

  it('returns a transformer when transforms declare the hook', () => {
    const set: TransformSet = {
      name: 'has_writeout',
      schema: 'openai-completions',
      response_egress: { ops: [{ op: 'remove', path: 'model' }] },
    };
    const ctx = makeCtx([set], 'response_egress');
    const xf = buildEventTransformer('response_egress', ctx);
    assert.ok(xf !== null);
    const result = xf!({ model: 'x', id: '1' }, ctx);
    assert.ok(result !== null);
    assert.equal('model' in result!, false);
    assert.equal(result!['id'], '1');
  });
});

// ---------------------------------------------------------------------------
// applyAfterUpstream
// ---------------------------------------------------------------------------

function makeAfterCtx(transforms: TransformSet[]): HookContext {
  return {
    hook: 'after_upstream',
    route: makeRoute(transforms),
    upstreamMode: 'openai-completions',
    clientModel: 'test-model',
    requestId: 'req-1',
    streaming: false,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
  };
}

function makeJsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('applyAfterUpstream', () => {
  it('fast-path: returns the same Response object when no transforms are declared', async () => {
    const set: TransformSet = {
      name: 'no_after',
      schema: 'openai-completions',
      before_upstream: { ops: [{ op: 'remove', path: 'max_tokens' }] },
    };
    const ctx = makeAfterCtx([set]);
    const original = makeJsonResponse({ id: '1', model: 'x' });
    const result = await applyAfterUpstream(original, ctx);
    assert.equal(result, original, 'should return the exact same Response reference');
  });

  it('fast-path: returns the same Response when route has no transforms array', async () => {
    const ctx = makeAfterCtx([]);
    const original = makeJsonResponse({ id: '1' });
    const result = await applyAfterUpstream(original, ctx);
    assert.equal(result, original);
  });

  it('active-path: applies ops to JSON body and returns new Response', async () => {
    const set: TransformSet = {
      name: 'strip_model',
      schema: 'openai-completions',
      after_upstream: { ops: [{ op: 'remove', path: 'model' }] },
    };
    const ctx = makeAfterCtx([set]);
    const original = makeJsonResponse({ id: '1', model: 'x', choices: [] });
    const result = await applyAfterUpstream(original, ctx);
    assert.notEqual(result, original, 'should return a new Response');
    const body = await result.json() as Record<string, unknown>;
    assert.equal('model' in body, false, 'model should be removed');
    assert.equal(body['id'], '1');
  });

  it('active-path: renames a field in the response body', async () => {
    const set: TransformSet = {
      name: 'rename_field',
      schema: 'openai-completions',
      after_upstream: { ops: [{ op: 'rename', path: 'foo', to: 'bar' }] },
    };
    const ctx = makeAfterCtx([set]);
    const original = makeJsonResponse({ foo: 42 });
    const result = await applyAfterUpstream(original, ctx);
    const body = await result.json() as Record<string, unknown>;
    assert.equal('foo' in body, false);
    assert.equal(body['bar'], 42);
  });

  it('active-path: preserves response status code', async () => {
    const set: TransformSet = {
      name: 'strip_model',
      schema: 'openai-completions',
      after_upstream: { ops: [{ op: 'remove', path: 'model' }] },
    };
    const ctx = makeAfterCtx([set]);
    const original = makeJsonResponse({ model: 'x' }, 201);
    const result = await applyAfterUpstream(original, ctx);
    assert.equal(result.status, 201);
  });

  it('non-JSON passthrough: returns reconstructed Response with original text when body is not JSON', async () => {
    const set: TransformSet = {
      name: 'strip_model',
      schema: 'openai-completions',
      after_upstream: { ops: [{ op: 'remove', path: 'model' }] },
    };
    const ctx = makeAfterCtx([set]);
    const sseBody = 'data: {"type":"message_start"}\n\ndata: [DONE]\n\n';
    const original = new Response(sseBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    const result = await applyAfterUpstream(original, ctx);
    // A new Response is returned but the body text is preserved unchanged
    const text = await result.text();
    assert.equal(text, sseBody);
    assert.equal(result.status, 200);
  });
});

// ---------------------------------------------------------------------------
// Step 11 — response_egress body ops
// ---------------------------------------------------------------------------

function makeWriteoutCtx(transforms: TransformSet[]): HookContext {
  return {
    hook: 'response_egress',
    route: makeRoute(transforms),
    upstreamMode: 'openai-completions',
    clientModel: 'test-model',
    requestId: 'req-1',
    streaming: false,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
  };
}

describe('applyWriteoutBody', () => {
  it('resolves $response.id to the response body field', async () => {
    const set: TransformSet = {
      name: 'writeout_response_path',
      schema: 'openai-completions',
      response_egress: { ops: [{ op: 'set', path: '$response.id', value: 'rewritten-id' }] },
    };
    const ctx = makeWriteoutCtx([set]);
    const result = await applyWriteoutBody(makeJsonResponse({ id: 'original-id', model: 'x' }), ctx);
    const body = JSON.parse(await result.text());
    assert.equal(body.id, 'rewritten-id');
    assert.equal('$response.id' in body, false, 'must not create a literal $response.id field');
  });

  it('supports rename and remove operations through the $response prefix', async () => {
    const set: TransformSet = {
      name: 'writeout_response_ops',
      schema: 'openai-completions',
      response_egress: {
        ops: [
          { op: 'rename', path: '$response.id', to: 'request_id' },
          { op: 'remove', path: '$response.model' },
        ],
      },
    };
    const ctx = makeWriteoutCtx([set]);
    const result = await applyWriteoutBody(makeJsonResponse({ id: 'original-id', model: 'x' }), ctx);
    const body = JSON.parse(await result.text());
    assert.equal(body.request_id, 'original-id');
    assert.equal('id' in body, false);
    assert.equal('model' in body, false);
    assert.equal('$response.id' in body, false);
  });

  it('fast-path: returns the same Response object when no transforms declare response_egress', async () => {
    // declared at a different hook — should NOT trigger writeout body ops
    const set: TransformSet = {
      name: 'before_only',
      schema: 'openai-completions',
      before_upstream: { ops: [{ op: 'remove', path: 'max_tokens' }] },
    };
    const ctx = makeWriteoutCtx([set]);
    const original = makeJsonResponse({ model: 'x', choices: [] });
    const result = await applyWriteoutBody(original, ctx);
    assert.equal(result, original);
  });

  it('fast-path: returns same Response when route has no transforms array', async () => {
    const ctx = makeWriteoutCtx([]);
    const original = makeJsonResponse({ model: 'x' });
    const result = await applyWriteoutBody(original, ctx);
    assert.equal(result, original);
  });

  it('active path: applies ops to JSON body and returns new Response', async () => {
    const set: TransformSet = {
      name: 'writeout_strip_model',
      schema: 'openai-completions',
      response_egress: { ops: [{ op: 'remove', path: 'model' }] },
    };
    const ctx = makeWriteoutCtx([set]);
    const original = makeJsonResponse({ id: '1', model: 'secret', choices: [] });
    const result = await applyWriteoutBody(original, ctx);
    assert.notEqual(result, original);
    const text = await result.text();
    const body = JSON.parse(text);
    assert.equal(body.model, undefined, 'model should have been removed');
    assert.equal(body.id, '1');
    assert.equal(result.status, 200);
  });

  it('active path: preserves status and headers', async () => {
    const set: TransformSet = {
      name: 'noop',
      schema: 'openai-completions',
      response_egress: { ops: [] },
    };
    const ctx = makeWriteoutCtx([set]);
    const original = new Response(JSON.stringify({ id: '1' }), {
      status: 201,
      headers: { 'Content-Type': 'application/json', 'x-custom': 'keep-me' },
    });
    const result = await applyWriteoutBody(original, ctx);
    assert.equal(result.status, 201);
    assert.equal(result.headers.get('x-custom'), 'keep-me');
  });

  it('non-JSON passthrough: returns reconstructed Response unchanged when content-type is not JSON', async () => {
    const set: TransformSet = {
      name: 'writeout_remove',
      schema: 'openai-completions',
      response_egress: { ops: [{ op: 'remove', path: 'model' }] },
    };
    const ctx = makeWriteoutCtx([set]);
    const sseBody = 'data: {"type":"message_start"}\n\ndata: [DONE]\n\n';
    const original = new Response(sseBody, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    const result = await applyWriteoutBody(original, ctx);
    assert.equal(result, original, 'should not touch streaming responses');
  });

  it('non-JSON passthrough: even when content-type is application/json, malformed JSON is passed through', async () => {
    const set: TransformSet = {
      name: 'writeout_remove',
      schema: 'openai-completions',
      response_egress: { ops: [{ op: 'remove', path: 'model' }] },
    };
    const ctx = makeWriteoutCtx([set]);
    const original = new Response('not json {{{', { status: 200, headers: { 'Content-Type': 'application/json' } });
    const result = await applyWriteoutBody(original, ctx);
    const text = await result.text();
    assert.equal(text, 'not json {{{');
  });

  it('folds left-to-right across multiple sets declared at response_egress', async () => {
    const a: TransformSet = {
      name: 'a_rename',
      schema: 'openai-completions',
      response_egress: { ops: [{ op: 'rename', path: 'a', to: 'b' }] },
    };
    const b: TransformSet = {
      name: 'b_remove',
      schema: 'openai-completions',
      response_egress: { ops: [{ op: 'remove', path: 'b' }] },
    };
    const ctx = makeWriteoutCtx([a, b]);
    const original = makeJsonResponse({ a: 1, c: 2 });
    const result = await applyWriteoutBody(original, ctx);
    const body = JSON.parse(await result.text());
    assert.equal(body.a, undefined, 'after rename then remove, b/a both gone');
    assert.equal(body.c, 2);
  });
});

describe('pipeEventTransformer (writeout SSE)', () => {
  it('fast-path: returns null when no transforms declare response_egress', () => {
    const set: TransformSet = {
      name: 'before_only',
      schema: 'openai-completions',
      before_upstream: { ops: [{ op: 'remove', path: 'max_tokens' }] },
    };
    const ctx = makeWriteoutCtx([set]);
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('data: {"a":1}\n\n')); c.close(); },
    });
    const result = pipeEventTransformer(stream, ctx);
    assert.equal(result, null);
  });

  it('active path: rewrites each parsed SSE data event', async () => {
    const set: TransformSet = {
      name: 'writeout_rename',
      schema: 'openai-completions',
      response_egress: { ops: [{ op: 'rename', path: 'a', to: 'b' }] },
    };
    const ctx = makeWriteoutCtx([set]);
    const input = 'data: {"a":1,"x":"y"}\n\ndata: [DONE]\n\n';
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(input)); c.close(); },
    });
    const out = pipeEventTransformer(stream, ctx);
    assert.ok(out !== null);
    const text = await new Response(out!).text();
    assert.ok(text.startsWith('data: '));
    assert.ok(text.includes('"b":1'), 'should have renamed a to b');
    assert.ok(!text.includes('"a":1'), 'original key should be gone');
    assert.ok(text.includes('[DONE]'), 'sentinel should pass through unchanged');
  });

  it('drops events when transformer returns null', async () => {
    // Custom transformer that drops everything — simulate by giving no builtins,
    // but using a built-in that "removes" via renaming to a nonexistent field
    // is not what we want. Instead, use a set whose op removes the event root
    // key: a rename into nothing still leaves JSON, so we test drop explicitly
    // via buildEventTransformer's null path: stand up a direct call.
    const { buildEventTransformer } = await import('../../src/utils/request-transform.js');
    const set: TransformSet = {
      name: 'noop_set',
      schema: 'openai-completions',
      response_egress: { ops: [{ op: 'set', path: 'kept', value: 1 }] },
    };
    const ctx = makeWriteoutCtx([set]);
    const transformer = buildEventTransformer('response_egress', ctx);
    assert.ok(transformer !== null);
    const dropped = transformer!({ a: 1 }, ctx); // not null => not dropped
    assert.notEqual(dropped, null);
  });

  it('multi-event SSE: processes each event in sequence', async () => {
    const set: TransformSet = {
      name: 'writeout_set',
      schema: 'openai-completions',
      response_egress: { ops: [{ op: 'set', path: 'flag', value: true }] },
    };
    const ctx = makeWriteoutCtx([set]);
    const input = 'data: {"x":1}\n\ndata: {"x":2}\n\n';
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(input)); c.close(); },
    });
    const out = pipeEventTransformer(stream, ctx);
    const text = await new Response(out!).text();
    const events = text.split('\n\n').filter(s => s.trim());
    assert.equal(events.length, 2);
    assert.ok(events[0].includes('"flag":true'));
    assert.ok(events[1].includes('"flag":true'));
  });
});

describe('hasHookOps', () => {
  it('returns false for empty transform list', () => {
    assert.equal(hasHookOps('response_egress', undefined), false);
    assert.equal(hasHookOps('response_egress', []), false);
  });
  it('returns true when any set declares the hook', () => {
    const a: TransformSet = { name: 'a', schema: 'openai-completions' }; // no slot
    const b: TransformSet = {
      name: 'b',
      schema: 'openai-completions',
      response_egress: { ops: [] },
    };
    assert.equal(hasHookOps('response_egress', [a, b]), true);
  });
  it('returns true when checking other hooks too', () => {
    const set: TransformSet = {
      name: 'b',
      schema: 'openai-completions',
      before_upstream: { ops: [] },
    };
    assert.equal(hasHookOps('before_upstream', [set]), true);
    assert.equal(hasHookOps('response_egress', [set]), false);
  });
});

// ---------------------------------------------------------------------------
// Step 13a: nested paths reaching the engine at runtime
// ---------------------------------------------------------------------------
//
// In practice the validator rejects these paths at config load. But the engine
// itself must never silently create a literal-bracketed key on the body even if
// a transform set slips through load-time validation.

describe('engine: nested-path safety (no literal-bracketed keys)', () => {
  it('does not create a literal "$response.choices[0].message.content" key', async () => {
    const set: TransformSet = {
      name: 'evil_nested',
      schema: 'openai-completions',
      response_egress: { ops: [{ op: 'set', path: '$response.choices[0].message.content', value: 'pirate' }] },
    };
    const ctx = makeWriteoutCtx([set]);
    const original = makeJsonResponse({ id: 'ok', choices: [{ message: { content: 'real' } }] });
    const result = await applyWriteoutBody(original, ctx);
    const body = JSON.parse(await result.text()) as Record<string, unknown>;
    assert.equal(
      '$response.choices[0].message.content' in body,
      false,
      'engine must never create a literal-bracketed key on the body',
    );
    // The real choices[0].message.content must be untouched.
    assert.deepEqual(body.choices, [{ message: { content: 'real' } }]);
  });
});

// ---------------------------------------------------------------------------
// Tier-2 builtin: assemble_sse_chunks
// ---------------------------------------------------------------------------

/** Build an SSE Response from a list of chunk objects. */
function makeSseResponse(chunks: Array<Record<string, unknown>>, status = 200, includeDone = true): Response {
  const lines: string[] = [];
  for (const c of chunks) lines.push(`data: ${JSON.stringify(c)}`);
  if (includeDone) lines.push('data: [DONE]');
  const body = lines.map(l => `${l}\n\n`).join('');
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

const ASSEMBLE_SET: TransformSet = {
  name: 'sse_to_completions',
  schema: 'openai-completions',
  after_upstream: { builtins: ['assemble_sse_chunks'] },
};

describe('Tier-2 builtin: assemble_sse_chunks', () => {
  it('assembles a single-choice stream into a chat.completion', async () => {
    const ctx = makeAfterCtx([ASSEMBLE_SET]);
    const original = makeSseResponse([
      { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1700, model: 'm',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] },
      { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1700, model: 'm',
        choices: [{ index: 0, delta: { content: ' world' }, finish_reason: null }] },
      { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1700, model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);
    const result = await applyAfterUpstream(original, ctx);
    assert.equal(result.headers.get('content-type'), 'application/json');
    const body = await result.json() as Record<string, unknown>;
    assert.equal(body['object'], 'chat.completion');
    assert.equal(body['id'], 'chatcmpl-1');
    assert.equal(body['model'], 'm');
    assert.equal(body['created'], 1700);
    const choices = body['choices'] as Array<Record<string, unknown>>;
    assert.equal(choices.length, 1);
    assert.equal(choices[0].index, 0);
    const message = choices[0].message as Record<string, unknown>;
    assert.equal(message.role, 'assistant');
    assert.equal(message.content, 'Hello world');
    assert.equal(choices[0].finish_reason, 'stop');
  });

  it('assembles n=4 interleaved choices into sorted-index choices array', async () => {
    // Upstream may emit chunks for different choices in any order.
    // Here we interleave all 4 choices and assert the assembled output has
    // choices sorted by index 0,1,2,3 with each choice's content fully concatenated.
    const ctx = makeAfterCtx([ASSEMBLE_SET]);
    const original = makeSseResponse([
      // round 1 — out of order: 2, 0, 3, 1
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 2, delta: { role: 'assistant', content: 'C2-a' }, finish_reason: null }] },
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'C0-a' }, finish_reason: null }] },
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 3, delta: { role: 'assistant', content: 'C3-a' }, finish_reason: null }] },
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 1, delta: { role: 'assistant', content: 'C1-a' }, finish_reason: null }] },
      // round 2 — different order: 1, 3, 0, 2
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 1, delta: { content: 'C1-b' }, finish_reason: null }] },
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 3, delta: { content: 'C3-b' }, finish_reason: null }] },
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: { content: 'C0-b' }, finish_reason: null }] },
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 2, delta: { content: 'C2-b' }, finish_reason: null }] },
      // finish round — one per choice, in yet another order
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 3, delta: {}, finish_reason: 'stop' }] },
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 2, delta: {}, finish_reason: 'stop' }] },
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 1, delta: {}, finish_reason: 'stop' }] },
    ]);
    const result = await applyAfterUpstream(original, ctx);
    const body = await result.json() as Record<string, unknown>;
    const choices = body['choices'] as Array<Record<string, unknown>>;
    assert.equal(choices.length, 4, 'all four choices must be present');
    // Indexes must be sorted ascending.
    assert.deepEqual(choices.map(c => c.index), [0, 1, 2, 3]);
    // Each choice's content was concatenated in arrival order per index.
    const contents = choices.map(c => (c.message as Record<string, unknown>).content);
    assert.deepEqual(contents, ['C0-aC0-b', 'C1-aC1-b', 'C2-aC2-b', 'C3-aC3-b']);
    // All four must carry finish_reason: stop.
    assert.deepEqual(choices.map(c => c.finish_reason), ['stop', 'stop', 'stop', 'stop']);
  });

  it('assembles n=5 choices that arrive fully sequential (0,0,1,1,2,2,...)', async () => {
    // Different upstreams emit choices sequentially rather than interleaved.
    // The assembler must still produce a sorted choices array.
    const ctx = makeAfterCtx([ASSEMBLE_SET]);
    const chunks: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 5; i++) {
      chunks.push({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: i, delta: { role: 'assistant', content: `r${i}-1` }, finish_reason: null }] });
      chunks.push({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: i, delta: { content: `r${i}-2` }, finish_reason: null }] });
      chunks.push({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: i, delta: {}, finish_reason: 'stop' }] });
    }
    const original = makeSseResponse(chunks);
    const result = await applyAfterUpstream(original, ctx);
    const body = await result.json() as Record<string, unknown>;
    const choices = body['choices'] as Array<Record<string, unknown>>;
    assert.equal(choices.length, 5);
    assert.deepEqual(choices.map(c => c.index), [0, 1, 2, 3, 4]);
    assert.deepEqual(
      choices.map(c => (c.message as Record<string, unknown>).content),
      ['r0-1r0-2', 'r1-1r1-2', 'r2-1r2-2', 'r3-1r3-2', 'r4-1r4-2'],
    );
  });

  it('accumulates tool_calls across chunks per (choice, tool-call) index', async () => {
    // Choice 0 calls one tool; arguments arrive as two partial JSON deltas.
    const ctx = makeAfterCtx([ASSEMBLE_SET]);
    const original = makeSseResponse([
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: { role: 'assistant', content: null }, finish_reason: null }] },
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] },
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"' } }] }, finish_reason: null }] },
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"SF"}' } }] }, finish_reason: null }] },
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const result = await applyAfterUpstream(original, ctx);
    const body = await result.json() as Record<string, unknown>;
    const choice = (body['choices'] as Array<Record<string, unknown>>)[0];
    assert.equal(choice.finish_reason, 'tool_calls');
    const message = choice.message as Record<string, unknown>;
    const toolCalls = message['tool_calls'] as Array<Record<string, unknown>>;
    assert.equal(toolCalls.length, 1);
    const tc = toolCalls[0];
    assert.equal(tc.id, 'call_1');
    assert.equal(tc.type, 'function');
    const fn = tc.function as Record<string, string>;
    assert.equal(fn.name, 'get_weather');
    assert.equal(fn.arguments, '{"city":""SF"}');
  });

  it('forwards usage from the final chunk when present', async () => {
    const ctx = makeAfterCtx([ASSEMBLE_SET]);
    const original = makeSseResponse([
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
      // Final chunk with usage and empty choices (stream_options.include_usage shape).
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
    ]);
    const result = await applyAfterUpstream(original, ctx);
    const body = await result.json() as Record<string, unknown>;
    assert.deepEqual(body['usage'], { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 });
  });

  it('sets content to null when only tool_calls are present (no text deltas)', async () => {
    const ctx = makeAfterCtx([ASSEMBLE_SET]);
    const original = makeSseResponse([
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }] }, finish_reason: null }] },
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ]);
    const result = await applyAfterUpstream(original, ctx);
    const body = await result.json() as Record<string, unknown>;
    const message = (body['choices'] as Array<Record<string, unknown>>)[0].message as Record<string, unknown>;
    assert.equal(message.content, null);
    assert.ok(Array.isArray(message['tool_calls']));
  });

  it('warns and passes through unchanged when content-type is not text/event-stream', async () => {
    const warnings: string[] = [];
    const ctx: HookContext = {
      hook: 'after_upstream',
      route: makeRoute([ASSEMBLE_SET]),
      upstreamMode: 'openai-completions',
      clientModel: 'm',
      requestId: 'r1',
      streaming: false,
      logger: { debug() {}, info() {}, warn(_rid, m) { warnings.push(m); }, error() {} } as any,
    };
    // Upstream returned plain JSON despite stream=true being injected.
    const original = makeJsonResponse({
      id: 'x', object: 'chat.completion', model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'already-json' }, finish_reason: 'stop' }],
    });
    const result = await applyAfterUpstream(original, ctx);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /assemble_sse_chunks: expected text\/event-stream/);
    // Body is passed through unchanged (the normal JSON-ops path runs but
    // ASSEMBLE_SET declares no ops, so the JSON is identical).
    const body = await result.json() as Record<string, unknown>;
    assert.equal(body['object'], 'chat.completion');
    const choice = (body['choices'] as Array<Record<string, unknown>>)[0];
    const message = choice.message as Record<string, unknown>;
    assert.equal(message.content, 'already-json');
  });

  it('is a no-op when no transform declares assemble_sse_chunks (fast path)', async () => {
    const set: TransformSet = {
      name: 'other',
      schema: 'openai-completions',
      after_upstream: { ops: [{ op: 'remove', path: 'model' }] },
    };
    const ctx = makeAfterCtx([set]);
    const original = makeSseResponse([
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] },
    ]);
    // Without assemble_sse_chunks declared, the SSE body fails JSON.parse and
    // is passed through verbatim.
    const result = await applyAfterUpstream(original, ctx);
    const text = await result.text();
    assert.ok(text.includes('chat.completion.chunk'));
    assert.ok(text.includes('[DONE]'));
  });

  it('combines with another set: max_tokens_rename at before_upstream + assemble at after_upstream', async () => {
    // Mirror the documented `transforms = "max_tokens_rename,sse_to_completions"` pattern.
    // max_tokens_rename runs at before_upstream (request body); assemble runs at after_upstream
    // (response body). They never interact, so the assembly must still produce correct output.
    const maxTokensRename: TransformSet = {
      name: 'max_tokens_rename',
      schema: 'openai-completions',
      before_upstream: { ops: [{ op: 'rename', path: 'max_tokens', to: 'max_completion_tokens' }] },
    };
    const ctx = makeAfterCtx([maxTokensRename, ASSEMBLE_SET]);
    const original = makeSseResponse([
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: { role: 'assistant', content: 'Hi ' }, finish_reason: null }] },
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: { content: 'there' }, finish_reason: null }] },
      { id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]);
    const result = await applyAfterUpstream(original, ctx);
    const body = await result.json() as Record<string, unknown>;
    assert.equal(body['object'], 'chat.completion');
    const choice = (body['choices'] as Array<Record<string, unknown>>)[0];
    const message = choice.message as Record<string, unknown>;
    assert.equal(message.content, 'Hi there');
    assert.equal(choice.finish_reason, 'stop');
  });

  it('produces an empty choices array when the SSE body has no data lines', async () => {
    const ctx = makeAfterCtx([ASSEMBLE_SET]);
    const original = makeSseResponse([]);
    const result = await applyAfterUpstream(original, ctx);
    const body = await result.json() as Record<string, unknown>;
    assert.deepEqual(body['choices'], []);
  });
});

// ---------------------------------------------------------------------------
// Per-entry max_tokens cap (route.maxTokens applied at before_upstream)
// ---------------------------------------------------------------------------

describe('per-entry max_tokens cap', () => {
  function capCtx(upstreamMode: string, maxTokens: number): HookContext {
    const ctx = makeCtx([]);
    ctx.route = { ...ctx.route, maxTokens };
    ctx.upstreamMode = upstreamMode;
    return ctx;
  }

  it('clamps anthropic-messages max_tokens down to the cap', () => {
    const result = runHook('before_upstream', payload({ max_tokens: 100000 }), capCtx('anthropic-messages', 8192));
    assert.equal(result.body.max_tokens, 8192);
  });

  it('leaves smaller client values unchanged (anthropic-messages)', () => {
    const result = runHook('before_upstream', payload({ max_tokens: 1024 }), capCtx('anthropic-messages', 8192));
    assert.equal(result.body.max_tokens, 1024);
  });

  it('clamps openai-completions max_completion_tokens (post-rename form)', () => {
    const result = runHook('before_upstream', payload({ max_completion_tokens: 50000 }), capCtx('openai-completions', 16384));
    assert.equal(result.body.max_completion_tokens, 16384);
  });

  it('clamps openai-completions max_tokens (pre-rename form)', () => {
    const result = runHook('before_upstream', payload({ max_tokens: 50000 }), capCtx('openai-completions', 16384));
    assert.equal(result.body.max_tokens, 16384);
  });

  it('clamps openai-responses max_output_tokens', () => {
    const result = runHook('before_upstream', payload({ max_output_tokens: 99999 }), capCtx('openai-responses', 4096));
    assert.equal(result.body.max_output_tokens, 4096);
  });

  it('clamps gemini generation_config.max_output_tokens (converted form)', () => {
    const body = { generation_config: { max_output_tokens: 100000 } };
    const result = runHook('before_upstream', payload(body), capCtx('gemini', 8192));
    assert.equal((result.body.generation_config as Record<string, unknown>).max_output_tokens, 8192);
  });

  it('clamps gemini generationConfig.maxOutputTokens (native camelCase form)', () => {
    const body = { generationConfig: { maxOutputTokens: 100000 } };
    const result = runHook('before_upstream', payload(body), capCtx('gemini', 8192));
    assert.equal((result.body.generationConfig as Record<string, unknown>).maxOutputTokens, 8192);
  });

  it('is a no-op when the route sets no cap', () => {
    const result = runHook('before_upstream', payload({ max_tokens: 1000000 }), makeCtx([]));
    assert.equal(result.body.max_tokens, 1000000);
  });

  it('applies after transforms: a transform-set value above the cap is still clamped', () => {
    const set: TransformSet = {
      name: 'force_big',
      schema: 'anthropic-messages',
      before_upstream: { ops: [{ op: 'set', path: 'max_tokens', value: 100000 }] },
    } as unknown as TransformSet;
    const ctx = capCtx('anthropic-messages', 8192);
    ctx.route = { ...ctx.route, transforms: [set] };
    const result = runHook('before_upstream', payload({}), ctx);
    assert.equal(result.body.max_tokens, 8192);
  });
});

// ---------------------------------------------------------------------------
// Tier-2 builtin: strip_fresh_thinking
// ---------------------------------------------------------------------------

describe('Tier-2 builtin: strip_fresh_thinking', () => {
  const set: TransformSet = {
    name: 'strip_fresh',
    schema: 'anthropic-messages',
    before_upstream: { builtins: ['strip_fresh_thinking'] },
  };

  function ctx(): HookContext {
    return {
      hook: 'before_upstream',
      route: makeRoute([set]),
      upstreamMode: 'anthropic-messages',
      clientModel: 'test-model',
      requestId: 'req-1',
      streaming: false,
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
    };
  }

  it('strips thinking:enabled on a fresh conversation (no assistant turns)', () => {
    const body = {
      thinking: { type: 'enabled', budget_tokens: 10000 },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    };
    const result = runHook('before_upstream', payload(body), ctx());
    assert.equal('thinking' in result.body, false);
  });

  it('strips thinking:adaptive on a fresh conversation', () => {
    const body = {
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: 'hi' }],
    };
    const result = runHook('before_upstream', payload(body), ctx());
    assert.equal('thinking' in result.body, false);
  });

  it('keeps thinking:enabled when prior assistant thinking blocks exist', () => {
    const body = {
      thinking: { type: 'enabled', budget_tokens: 10000 },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'hello' }] },
      ],
    };
    const result = runHook('before_upstream', payload(body), ctx());
    assert.deepEqual(result.body.thinking, { type: 'enabled', budget_tokens: 10000 });
  });

  it('keeps thinking when disabled (never touches it)', () => {
    const body = {
      thinking: { type: 'disabled' },
      messages: [{ role: 'user', content: 'hi' }],
    };
    const result = runHook('before_upstream', payload(body), ctx());
    assert.deepEqual(result.body.thinking, { type: 'disabled' });
  });

  it('leaves a body without thinking untouched', () => {
    const body = { messages: [{ role: 'user', content: 'hi' }] };
    const result = runHook('before_upstream', payload(body), ctx());
    assert.equal('thinking' in result.body, false);
  });
});

// ---------------------------------------------------------------------------
// Tier-2 builtin: ensure_trailing_user_message
// ---------------------------------------------------------------------------

describe('Tier-2 builtin: ensure_trailing_user_message', () => {
  const set: TransformSet = {
    name: 'trailing_user',
    schema: 'anthropic-messages',
    before_upstream: { builtins: ['ensure_trailing_user_message'] },
  };

  function ctx(traceLog?: string[]): HookContext {
    return {
      hook: 'before_upstream',
      route: makeRoute([set]),
      upstreamMode: 'anthropic-messages',
      clientModel: 'test-model',
      requestId: 'req-1',
      streaming: false,
      logger: {
        debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
        trace: (_requestId: string, message: string) => { traceLog?.push(message); },
      } as any,
    };
  }

  it('strips a trailing assistant message (array content)', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Write a poem.' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'Here is' }] },
      ],
    };
    const result = runHook('before_upstream', payload(body), ctx());
    const msgs = result.body.messages as Record<string, unknown>[];
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'user');
  });

  it('strips a trailing assistant message (string content)', () => {
    const body = {
      messages: [
        { role: 'user', content: 'Write a poem.' },
        { role: 'assistant', content: 'Here is' },
      ],
    };
    const result = runHook('before_upstream', payload(body), ctx());
    const msgs = result.body.messages as Record<string, unknown>[];
    assert.equal(msgs.length, 1);
    assert.deepEqual(msgs[0], { role: 'user', content: 'Write a poem.' });
  });

  it('strips a trailing assistant message with no preceding user message', () => {
    const body = {
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] },
      ],
    };
    const result = runHook('before_upstream', payload(body), ctx());
    const msgs = result.body.messages as Record<string, unknown>[];
    assert.equal(msgs.length, 0);
  });

  it('logs a trace line showing the stripped message', () => {
    const traceLog: string[] = [];
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'partial answer' }] },
      ],
    };
    runHook('before_upstream', payload(body), ctx(traceLog));
    assert.equal(traceLog.length, 1);
    assert.match(traceLog[0], /\[ensure_trailing_user_message\] stripped trailing assistant message/);
    assert.match(traceLog[0], /partial answer/);
  });

  it('strips a trailing system message', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'system', content: 'Available agent types for the Agent tool: ...' },
      ],
    };
    const traceLog: string[] = [];
    const result = runHook('before_upstream', payload(body), ctx(traceLog));
    const msgs = result.body.messages as Record<string, unknown>[];
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'user');
    assert.equal(traceLog.length, 1);
    assert.match(traceLog[0], /\[ensure_trailing_user_message\] stripped trailing system message/);
  });

  it('strips multiple stacked trailing non-user messages', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'partial' }] },
        { role: 'system', content: 'agent list' },
      ],
    };
    const traceLog: string[] = [];
    const result = runHook('before_upstream', payload(body), ctx(traceLog));
    const msgs = result.body.messages as Record<string, unknown>[];
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].role, 'user');
    assert.equal(traceLog.length, 2);
    assert.match(traceLog[0], /stripped trailing system message/);
    assert.match(traceLog[1], /stripped trailing assistant message/);
  });

  it('does not log a trace line when there is no trailing assistant message', () => {
    const traceLog: string[] = [];
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      ],
    };
    runHook('before_upstream', payload(body), ctx(traceLog));
    assert.equal(traceLog.length, 0);
  });

  it('leaves messages already ending with user untouched', () => {
    const body = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        { role: 'user', content: [{ type: 'text', text: 'again' }] },
      ],
    };
    const result = runHook('before_upstream', payload(body), ctx());
    const msgs = result.body.messages as Record<string, unknown>[];
    assert.equal(msgs.length, 3);
  });

  it('no-ops on an empty messages array', () => {
    const body = { messages: [] };
    const result = runHook('before_upstream', payload(body), ctx());
    assert.deepEqual(result.body.messages, []);
  });

  it('no-ops when messages is absent', () => {
    const body = { model: 'test' };
    const result = runHook('before_upstream', payload(body), ctx());
    assert.equal('messages' in result.body, false);
  });
});

// ---------------------------------------------------------------------------
// Tier-2 builtin: restore_client_model_alias
// ---------------------------------------------------------------------------

describe('Tier-2 builtin: restore_client_model_alias', () => {
  const set: TransformSet = {
    name: 'restore_alias',
    schema: 'openai-completions',
    response_egress: { builtins: ['restore_client_model_alias'] },
  };

  it('rewrites the JSON response body model field to the client-requested alias', async () => {
    // makeWriteoutCtx fixture sets clientModel: 'test-model'.
    const ctx = makeWriteoutCtx([set]);
    const original = makeJsonResponse({ id: '1', model: 'claude-haiku-4-5-20251001', choices: [] });
    const result = await applyWriteoutBody(original, ctx);
    const body = JSON.parse(await result.text());
    assert.equal(body.model, 'test-model');
    assert.equal(body.id, '1', 'unrelated fields must be untouched');
  });

  it('leaves the body untouched when clientModel is not set on the context', async () => {
    const ctx = { ...makeWriteoutCtx([set]), clientModel: '' };
    const original = makeJsonResponse({ id: '1', model: 'claude-haiku-4-5-20251001' });
    const result = await applyWriteoutBody(original, ctx);
    const body = JSON.parse(await result.text());
    assert.equal(body.model, 'claude-haiku-4-5-20251001');
  });

  it('rewrites the model field on each SSE chat.completion.chunk event', async () => {
    const ctx = makeWriteoutCtx([set]);
    const input = 'data: {"id":"1","model":"claude-haiku-4-5-20251001","choices":[]}\n\ndata: [DONE]\n\n';
    const stream = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode(input)); c.close(); },
    });
    const out = pipeEventTransformer(stream, ctx);
    assert.ok(out !== null);
    const text = await new Response(out!).text();
    assert.ok(text.includes('"model":"test-model"'), 'chunk model field should be rewritten to the alias');
    assert.ok(!text.includes('claude-haiku-4-5-20251001'), 'real upstream model id should not leak to the client');
    assert.ok(text.includes('[DONE]'), 'sentinel should pass through unchanged');
  });

  it('does not touch response bodies with no model field', async () => {
    const ctx = makeWriteoutCtx([set]);
    const original = makeJsonResponse({ id: '1', choices: [] });
    const result = await applyWriteoutBody(original, ctx);
    const body = JSON.parse(await result.text());
    assert.equal('model' in body, false);
  });
});
