/**
 * Regression test for the Claude Code gateway compliance review, item 8
 * (Feature Pass-Through Pairs — Header + Body Must Travel Together).
 *
 * On the anthropic-messages path the body is forwarded with no format
 * conversion, so the pairs travel together by construction — the risk is the
 * `before_upstream` transform hook chain mutating the body after the beta
 * header is already set. This test runs the full hook chain (builtins that
 * touch system/messages, plus the per-entry maxTokens cap) and asserts each
 * beta header's paired body field survives unchanged.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runHook, type HookContext } from '../../src/utils/request-transform.js';
import type { TransformSet, ModelRouteConfig } from '../../src/utils/config-loader.js';

const BETA_HEADER = 'interleaved-thinking-2025-05-14, tools-2025-01-15, output-128k-2025-02-19';

function makeBody(): Record<string, unknown> {
  return {
    model: 'claude-opus-4-6',
    max_tokens: 99999,
    // Adaptive reasoning (beta pair: no header)
    thinking: { type: 'adaptive' },
    // Context management (beta pair: no header)
    context_management: {
      edits: [{ type: 'clear_tool_uses_20250919', trigger: { type: 'input_tokens', value: 100000 } }],
    },
    // Prompt caching: cache_control markers must keep their position
    system: [
      { type: 'text', text: 'You are Claude Code.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'second block' },
    ],
    // A prior assistant thinking block so strip_fresh_thinking leaves
    // body.thinking alone (its documented contract).
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'hello' }] },
      { role: 'user', content: 'again' },
    ],
    // Beta tool fields (beta pair: tools-2025-01-15)
    tools: [
      { name: 'Read', input_schema: { type: 'object', strict: true, properties: {} }, defer_loading: true },
    ],
    // Effort / structured outputs (beta pair: output-128k-2025-02-19)
    output_config: { effort: 'high', format: { type: 'json' }, task_budget: 5000 },
  };
}

function makeRoute(transforms: TransformSet[], maxTokens?: number): ModelRouteConfig {
  return {
    targetUrl: 'https://api.anthropic.com/v1/messages',
    upstreamMode: 'anthropic-messages',
    transforms,
    maxTokens,
  };
}

function makeCtx(transforms: TransformSet[], maxTokens?: number): HookContext {
  return {
    hook: 'before_upstream',
    route: makeRoute(transforms, maxTokens),
    upstreamMode: 'anthropic-messages',
    clientModel: 'claude-opus-4-6',
    requestId: 'req-pairs',
    streaming: false,
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
  };
}

describe('beta feature pass-through pairs (anthropic-messages)', () => {
  // Builtins that touch system/messages/thinking, plus a header op, plus the
  // per-entry maxTokens cap — the full set of things the hook chain can
  // legitimately do on this path.
  const transforms: TransformSet[] = [
    {
      name: 'anthropic_native_touchers',
      schema: 'anthropic-messages',
      before_upstream: {
        builtins: ['strip_fresh_thinking', 'ensure_tool_config_cache_ttl'],
        headers: { set: { 'x-custom': 'yes' } },
      },
    },
  ];

  it('leaves every paired body field and the anthropic-beta header unchanged', () => {
    const body = makeBody();
    const headers = { 'anthropic-beta': BETA_HEADER, 'anthropic-version': '2023-06-01' };

    const result = runHook('before_upstream', { body, headers }, makeCtx(transforms, 4096));

    // Paired fields survive the full hook chain unchanged.
    assert.deepEqual(result.body.thinking, { type: 'adaptive' });
    assert.deepEqual(result.body.context_management, makeBody().context_management);
    assert.deepEqual(result.body.system, makeBody().system);
    assert.deepEqual(result.body.tools, makeBody().tools);
    assert.deepEqual(result.body.output_config, makeBody().output_config);

    // Positional integrity: the attribution block is still system[0].
    const system = result.body.system as Array<Record<string, unknown>>;
    assert.equal(system[0].text, 'You are Claude Code.');

    // The beta header itself is untouched (open-list forwarding).
    assert.equal(result.headers['anthropic-beta'], BETA_HEADER);
    assert.equal(result.headers['anthropic-version'], '2023-06-01');

    // The two intentional side effects of the chain, documented:
    // - maxTokens cap clamps max_tokens
    assert.equal(result.body.max_tokens, 4096);
    // - ensure_tool_config_cache_ttl derives cache_control_injection_points
    //   from the system cache_control marker without mutating the marker
    assert.deepEqual(result.body.cache_control_injection_points, [
      { location: 'tool_config', control: { type: 'ephemeral' } },
    ]);
    // The declared header op still applied.
    assert.equal(result.headers['x-custom'], 'yes');
  });

  it('is an identity pass when the route declares no transforms and no cap', () => {
    const body = makeBody();
    const headers = { 'anthropic-beta': BETA_HEADER };
    const result = runHook('before_upstream', { body, headers }, makeCtx([]));
    assert.deepEqual(result.body, body);
    assert.deepEqual(result.headers, headers);
  });
});
