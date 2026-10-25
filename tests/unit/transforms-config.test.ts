/**
 * Unit tests for transform config types, TOML parsing, and validation.
 *
 * Run with:
 *   npx tsx --test tests/unit/transforms-config.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSimpleToml,
  parseTransformOpsInline,
  validateTransformSet,
  validateAllTransforms,
  getModelRouteConfig,
  serializeProxyConfigToml,
  type TransformSet,
  type ProxyConfig,
} from '../../src/utils/config-loader.js';
import { runHook, type HookContext } from '../../src/utils/request-transform.js';

// ---------------------------------------------------------------------------
// parseTransformOpsInline
// ---------------------------------------------------------------------------

describe('parseTransformOpsInline', () => {
  it('parses a rename op', () => {
    const ops = parseTransformOpsInline('[{op="rename",path="max_tokens",to="max_completion_tokens"}]');
    assert.equal(ops.length, 1);
    assert.deepEqual(ops[0], { op: 'rename', path: 'max_tokens', to: 'max_completion_tokens' });
  });

  it('parses a remove op', () => {
    const ops = parseTransformOpsInline('[{op="remove",path="output_config"}]');
    assert.equal(ops.length, 1);
    assert.deepEqual(ops[0], { op: 'remove', path: 'output_config' });
  });

  it('parses a map_value op with when_sibling and null target', () => {
    const ops = parseTransformOpsInline(
      '[{op="map_value",path="messages[role=assistant].content",when_sibling="tool_calls",from="",to=null}]',
    );
    assert.equal(ops.length, 1);
    const op = ops[0] as { op: string; path: string; from: unknown; to: unknown; when_sibling: string };
    assert.equal(op.op, 'map_value');
    assert.equal(op.path, 'messages[role=assistant].content');
    assert.equal(op.when_sibling, 'tool_calls');
    assert.equal(op.from, '');
    assert.equal(op.to, null);
  });

  it('parses multiple ops', () => {
    const ops = parseTransformOpsInline(
      '[{op="rename",path="max_tokens",to="max_completion_tokens"},{op="remove",path="output_config"}]',
    );
    assert.equal(ops.length, 2);
    assert.equal(ops[0].op, 'rename');
    assert.equal(ops[1].op, 'remove');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(parseTransformOpsInline('[]'), []);
  });

  it('skips malformed entries without op or path', () => {
    const ops = parseTransformOpsInline('[{foo="bar"}]');
    assert.equal(ops.length, 0);
  });
});

// ---------------------------------------------------------------------------
// validateTransformSet
// ---------------------------------------------------------------------------

describe('validateTransformSet', () => {
  it('passes a valid set', () => {
    const set: TransformSet = {
      name: 'test',
      schema: 'openai-completions',
      before_upstream: {
        ops: [{ op: 'rename', path: 'max_tokens', to: 'max_completion_tokens' }],
        builtins: ['recover_tool_message_name'],
      },
    };
    assert.deepEqual(validateTransformSet('test', set), []);
  });

  it('fails on unknown path', () => {
    const set: TransformSet = {
      name: 'bad',
      schema: 'openai-completions',
      before_upstream: { ops: [{ op: 'remove', path: 'nonexistent_field' }] },
    };
    const errs = validateTransformSet('bad', set);
    assert.equal(errs.length, 1);
    assert.ok(errs[0].message.includes('nonexistent_field'));
  });

  it('fails on unknown builtin', () => {
    const set: TransformSet = {
      name: 'bad',
      schema: 'openai-completions',
      before_upstream: { builtins: ['made_up_builtin' as never] },
    };
    const errs = validateTransformSet('bad', set);
    assert.equal(errs.length, 1);
    assert.ok(errs[0].message.includes('made_up_builtin'));
  });

  it('fails on unknown schema', () => {
    const set = { name: 'bad', schema: 'not-a-schema' } as unknown as TransformSet;
    const errs = validateTransformSet('bad', set);
    assert.equal(errs.length, 1);
    assert.ok(errs[0].message.includes('unknown schema'));
  });

  it('validates paths under anthropic-messages schema', () => {
    const set: TransformSet = {
      name: 'claude_set',
      schema: 'anthropic-messages',
      before_upstream: { ops: [{ op: 'remove', path: 'system' }] },
    };
    assert.deepEqual(validateTransformSet('claude_set', set), []);
  });

  it('rejects openai-completions-only path under anthropic-messages schema', () => {
    // frequency_penalty is openai-completions only, not in anthropic-messages
    const set: TransformSet = {
      name: 'bad',
      schema: 'anthropic-messages',
      before_upstream: { ops: [{ op: 'remove', path: 'frequency_penalty' }] },
    };
    const errs = validateTransformSet('bad', set);
    assert.equal(errs.length, 1);
    assert.ok(errs[0].message.includes('frequency_penalty'));
  });

  // Step 13a: nested response / message paths are whitelisted by the schema's
  // field vocabulary but cannot be walked by the Tier-1 op runner. The
  // validator must reject them so they never silently create literal-bracketed
  // keys on the body.
  it('rejects nested $response path that the engine cannot walk', () => {
    const set: TransformSet = {
      name: 'bad',
      schema: 'openai-completions',
      response_egress: { ops: [{ op: 'set', path: '$response.choices[].message.content', value: 'x' }] },
    };
    const errs = validateTransformSet('bad', set);
    assert.equal(errs.length, 1);
    assert.ok(errs[0].message.includes('cannot walk'));
    assert.ok(errs[0].message.includes('$response.choices[].message.content'));
  });

  it('accepts shallow $response.<field> paths', () => {
    const set: TransformSet = {
      name: 'good',
      schema: 'openai-completions',
      response_egress: { ops: [{ op: 'set', path: '$response.id', value: 'x' }] },
    };
    assert.deepEqual(validateTransformSet('good', set), []);
  });

  it('accepts filter_anthropic_beta builtin and a valid anthropic_beta_map', () => {
    const set: TransformSet = {
      name: 'beta_good',
      schema: 'anthropic-messages',
      anthropic_beta_map: { 'a': 'a', 'b': null },
      before_upstream: { builtins: ['filter_anthropic_beta'] },
    };
    assert.deepEqual(validateTransformSet('beta_good', set), []);
  });

  it('accepts filter_anthropic_beta with no map (no-op at runtime)', () => {
    const set: TransformSet = {
      name: 'beta_nomap',
      schema: 'anthropic-messages',
      before_upstream: { builtins: ['filter_anthropic_beta'] },
    };
    assert.deepEqual(validateTransformSet('beta_nomap', set), []);
  });

  it('rejects anthropic_beta_map with a non-string value', () => {
    const set: TransformSet = {
      name: 'bad',
      schema: 'anthropic-messages',
      anthropic_beta_map: { 'a': 123 as unknown as string },
      before_upstream: { builtins: ['filter_anthropic_beta'] },
    };
    const errs = validateTransformSet('bad', set);
    assert.ok(errs.some(e => e.message.includes('anthropic_beta_map') && e.message.includes('must be a string or null')));
  });

  it('rejects $response.<field> with further nesting under anthropic-messages', () => {
    const set: TransformSet = {
      name: 'bad',
      schema: 'anthropic-messages',
      response_egress: { ops: [{ op: 'set', path: '$response.content[0].text', value: 'x' }] },
    };
    // First, the schema check: $response.content[0].text is NOT in the
    // anthropic-messages whitelist, so the validator already fails for that
    // reason. The error must still surface — second-layer walkable check is
    // never reached.
    const errs = validateTransformSet('bad', set);
    assert.ok(errs.length >= 1);
  });

  it('accepts bare messages[].<field> path (no role filter)', () => {
    const set: TransformSet = {
      name: 'good',
      schema: 'openai-completions',
      before_upstream: { ops: [{ op: 'set', path: 'messages[].name', value: 'x' }] },
    };
    assert.deepEqual(validateTransformSet('good', set), []);
  });

  it('rejects messages[].<field>.<sub> nested object path', () => {
    const set: TransformSet = {
      name: 'bad',
      schema: 'openai-completions',
      before_upstream: { ops: [{ op: 'set', path: 'messages[].tool_calls[].function.name', value: 'x' }] },
    };
    const errs = validateTransformSet('bad', set);
    assert.ok(errs.length >= 1, 'must reject multi-segment tool_calls walk');
  });

  // Step 14: schema-gated builtins. assemble_sse_chunks parses OpenAI-shaped
  // chunks (choices[].index); on a Claude SSE stream it would silently emit
  // an empty choices array, destroying the response. Reject at load time.
  it('accepts assemble_sse_chunks under openai-completions schema', () => {
    const set: TransformSet = {
      name: 'ok',
      schema: 'openai-completions',
      after_upstream: { builtins: ['assemble_sse_chunks'] },
    };
    assert.deepEqual(validateTransformSet('ok', set), []);
  });

  it('rejects assemble_sse_chunks under anthropic-messages schema', () => {
    const set: TransformSet = {
      name: 'bad',
      schema: 'anthropic-messages',
      after_upstream: { builtins: ['assemble_sse_chunks'] },
    };
    const errs = validateTransformSet('bad', set);
    assert.equal(errs.length, 1);
    assert.ok(errs[0].message.includes('assemble_sse_chunks'));
    assert.ok(errs[0].message.includes('openai-completions'));
    assert.ok(errs[0].message.includes('anthropic-messages'));
  });

  it('rejects assemble_sse_chunks under openai-responses schema', () => {
    const set: TransformSet = {
      name: 'bad',
      schema: 'openai-responses',
      after_upstream: { builtins: ['assemble_sse_chunks'] },
    };
    const errs = validateTransformSet('bad', set);
    assert.equal(errs.length, 1);
    assert.ok(errs[0].message.includes('assemble_sse_chunks'));
  });

  it('rejects assemble_sse_chunks under gemini-generatecontent schema', () => {
    const set: TransformSet = {
      name: 'bad',
      schema: 'gemini-generatecontent',
      after_upstream: { builtins: ['assemble_sse_chunks'] },
    };
    const errs = validateTransformSet('bad', set);
    assert.equal(errs.length, 1);
    assert.ok(errs[0].message.includes('assemble_sse_chunks'));
  });
});

// ---------------------------------------------------------------------------
// validateAllTransforms
// ---------------------------------------------------------------------------

describe('validateAllTransforms', () => {
  it('passes a clean config with no transforms', () => {
    const config: ProxyConfig = {};
    assert.deepEqual(validateAllTransforms(config), []);
  });

  it('fails when transform_defaults references undefined set', () => {
    const config: ProxyConfig = {
      transform_defaults: { 'openai-completions': ['nonexistent'] },
    };
    const errs = validateAllTransforms(config);
    assert.equal(errs.length, 1);
    assert.ok(errs[0].message.includes('nonexistent'));
  });

  it('passes when transform_defaults references defined set', () => {
    const config: ProxyConfig = {
      transforms: {
        max_tokens_completion: {
          name: 'max_tokens_completion',
          schema: 'openai-completions',
          before_upstream: { ops: [{ op: 'rename', path: 'max_tokens', to: 'max_completion_tokens' }] },
        },
      },
      transform_defaults: { 'openai-completions': ['max_tokens_completion'] },
    };
    assert.deepEqual(validateAllTransforms(config), []);
  });
});

// ---------------------------------------------------------------------------
// parseSimpleToml — [transforms.*] and [transforms.default] sections
// ---------------------------------------------------------------------------

describe('parseSimpleToml — transforms sections', () => {
  it('parses [transforms.<name>] with schema', () => {
    const config = parseSimpleToml(`
[transforms.my_set]
schema = "openai-completions"
`);
    assert.ok(config.transforms?.['my_set']);
    assert.equal(config.transforms!['my_set'].schema, 'openai-completions');
  });

  it('parses before_upstream.builtins array', () => {
    const config = parseSimpleToml(`
[transforms.deepseek_compat]
schema = "openai-completions"
before_upstream.builtins = ["recover_tool_message_name"]
`);
    const set = config.transforms?.['deepseek_compat'];
    assert.ok(set);
    assert.deepEqual(set.before_upstream?.builtins, ['recover_tool_message_name']);
  });

  it('parses anthropic_beta_map inline table (empty-string value → null)', () => {
    const config = parseSimpleToml(`
[transforms.beta_compat]
schema = "anthropic-messages"
anthropic_beta_map = {"advanced-tool-use-2025-11-20" = "tool-search-tool-2025-10-19", "computer-use-2025-01-24" = "computer-use-2025-01-24", "unsupported" = ""}
before_upstream.builtins = ["filter_anthropic_beta"]
`);
    const set = config.transforms?.['beta_compat'];
    assert.ok(set);
    assert.deepEqual(set.anthropic_beta_map, {
      'advanced-tool-use-2025-11-20': 'tool-search-tool-2025-10-19',
      'computer-use-2025-01-24': 'computer-use-2025-01-24',
      'unsupported': null, // empty-string → null (drop)
    });
    assert.deepEqual(set.before_upstream?.builtins, ['filter_anthropic_beta']);
  });

  it('parses request_ingress.builtins array', () => {
    const config = parseSimpleToml(`
[transforms.tool_norm]
schema = "openai-completions"
request_ingress.builtins = ["lowercase_tool_schema_types"]
`);
    const set = config.transforms?.['tool_norm'];
    assert.deepEqual(set?.request_ingress?.builtins, ['lowercase_tool_schema_types']);
  });

  it('normalizes legacy endpoint_readin alias to request_ingress', () => {
    const config = parseSimpleToml(`
[transforms.tool_norm]
schema = "openai-completions"
endpoint_readin.builtins = ["lowercase_tool_schema_types"]
`);
    const set = config.transforms?.['tool_norm'];
    // Legacy alias `endpoint_readin` must normalize to canonical `request_ingress`.
    assert.deepEqual(set?.request_ingress?.builtins, ['lowercase_tool_schema_types']);
    assert.equal(set?.endpoint_readin, undefined);
  });

  it('parses before_upstream.ops array of inline tables', () => {
    const config = parseSimpleToml(`
[transforms.rename_set]
schema = "openai-completions"
before_upstream.ops = [{op="rename",path="max_tokens",to="max_completion_tokens"}]
`);
    const set = config.transforms?.['rename_set'];
    assert.equal(set?.before_upstream?.ops?.length, 1);
    assert.deepEqual(set!.before_upstream!.ops![0], {
      op: 'rename', path: 'max_tokens', to: 'max_completion_tokens',
    });
  });

  it('parses [transforms.default]', () => {
    const config = parseSimpleToml(`
[transforms.max_tokens_completion]
schema = "openai-completions"
before_upstream.ops = [{op="rename",path="max_tokens",to="max_completion_tokens"}]

[transforms.default]
openai-completions = ["max_tokens_completion"]
openai-responses = ["max_tokens_completion"]
`);
    assert.deepEqual(config.transform_defaults?.['openai-completions'], ['max_tokens_completion']);
    assert.deepEqual(config.transform_defaults?.['openai-responses'], ['max_tokens_completion']);
  });

  // [transform_defaults] → [transforms.default]: the old header was REMOVED and
  // now hits the unknown-section branch; the canonical header must NOT register
  // a transform set named "default" (the name is now reserved).

  const captureWarns = (fn: () => void): string[] => {
    const original = console.warn;
    const messages: string[] = [];
    console.warn = (...args: unknown[]) => { messages.push(args.map(String).join(' ')); };
    try {
      fn();
    } finally {
      console.warn = original;
    }
    return messages;
  };

  it('rejects the removed [transform_defaults] header as an unknown section and drops its keys', () => {
    const config = parseSimpleToml(`
[transforms.max_tokens_completion]
schema = "openai-completions"

[transform_defaults]
openai-completions = ["max_tokens_completion"]

[defaults]
max_tokens = "100"
`) as any;
    assert.equal(config.transform_defaults, undefined);
    assert.deepEqual(config.defaults, { max_tokens: '100' }, 'parsing continues after the rejected section');
    const warnings = config._validationWarnings ?? [];
    assert.ok(
      warnings.some((w: { path: string }) => w.path === 'transform_defaults'),
      `expected an unknown-section warning naming [transform_defaults], got ${JSON.stringify(warnings)}`
    );
  });

  it('parses the canonical [transforms.default] header without a deprecation warning and without a "default" transform set', () => {
    let config!: ReturnType<typeof parseSimpleToml>;
    const warns = captureWarns(() => {
      config = parseSimpleToml(`
[transforms.max_tokens_completion]
schema = "openai-completions"

[transforms.default]
openai-completions = ["max_tokens_completion"]
`);
    });
    assert.deepEqual(config.transform_defaults?.['openai-completions'], ['max_tokens_completion']);
    assert.ok(
      !warns.some((m) => m.includes('deprecated')),
      `unexpected deprecation warning: ${JSON.stringify(warns)}`
    );
    // Intercepted before the generic [transforms.<name>] branch: no "default" set.
    assert.equal(config.transforms?.['default'], undefined);
    assert.deepEqual(Object.keys(config.transforms ?? {}), ['max_tokens_completion']);
  });

  it('serializeProxyConfigToml writes the canonical [transforms.default] header', () => {
    const serialized = serializeProxyConfigToml({
      transform_defaults: { 'openai-completions': ['set_a'] },
    });
    assert.match(serialized, /^\[transforms\.default\]$/m);
    assert.doesNotMatch(serialized, /^\[transform_defaults\]$/m);
    // And it reparses into transform_defaults, not a transform set.
    const reparsed = parseSimpleToml(serialized);
    assert.deepEqual(reparsed.transform_defaults, { 'openai-completions': ['set_a'] });
    assert.equal(reparsed.transforms?.['default'], undefined);
  });

  it('parses multiple transforms and transform_defaults together', () => {
    const config = parseSimpleToml(`
[transforms.deepseek_compat]
schema = "openai-completions"
request_ingress.builtins = ["lowercase_tool_schema_types"]
before_upstream.builtins = ["recover_tool_message_name"]
before_upstream.ops = [{op="map_value",path="messages[role=assistant].content",when_sibling="tool_calls",from="",to=null}]

[transforms.max_tokens_completion]
schema = "openai-completions"
before_upstream.ops = [{op="rename",path="max_tokens",to="max_completion_tokens"}]

[transforms.default]
openai-completions = ["max_tokens_completion"]
`);
    const ds = config.transforms?.['deepseek_compat'];
    assert.ok(ds);
    assert.deepEqual(ds.request_ingress?.builtins, ['lowercase_tool_schema_types']);
    assert.deepEqual(ds.before_upstream?.builtins, ['recover_tool_message_name']);
    assert.equal(ds.before_upstream?.ops?.length, 1);

    const mt = config.transforms?.['max_tokens_completion'];
    assert.ok(mt);
    assert.equal(mt.before_upstream?.ops?.length, 1);

    assert.deepEqual(config.transform_defaults?.['openai-completions'], ['max_tokens_completion']);
  });
});

// ---------------------------------------------------------------------------
// max_tokens_rename: mode-default wiring + runHook end-to-end
// ---------------------------------------------------------------------------

const maxTokensToml = `
[transforms.max_tokens_rename]
schema = "openai-completions"
before_upstream.ops = [{op = "rename", path = "max_tokens", to = "max_completion_tokens"}]

[transforms.default]
"openai-completions" = ["max_tokens_rename"]
"openai-responses" = ["max_tokens_rename"]

[models.free]
upstream_mode = "openai-completions"
base_url = "https://api.example.com"
api_key = "k"
mymodel = {target = "real-model"}
`;

// ---------------------------------------------------------------------------
// inline-table transforms field parsing
// ---------------------------------------------------------------------------

const inlineTransformToml = `
[models.free]
upstream_mode = "openai-completions"
mymodel = {target = "real-model", base_url = "https://api.example.com", api_key = "key123", transforms = "deepseek_compat"}

[transforms.max_tokens_rename]
schema = "openai-completions"
before_upstream.ops = [{op = "rename", path = "max_tokens", to = "max_completion_tokens"}]

[transforms.deepseek_compat]
schema = "openai-completions"
request_ingress.builtins = ["lowercase_tool_schema_types"]
before_upstream.builtins = ["recover_tool_message_name"]
before_upstream.ops = [{op = "map_value", path = "messages[role=assistant].content", when_sibling = "tool_calls", from = "", to = null}]

[transforms.default]
"openai-completions" = ["max_tokens_rename"]
`;

describe('inline-table transforms field', () => {
  const config = parseSimpleToml(inlineTransformToml);
  const route = getModelRouteConfig('mymodel', config);
  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;

  it('resolves entry-level transforms from inline-table model entry', () => {
    assert.ok(route, 'route should resolve');
    // mode-default (max_tokens_rename) + entry-level (deepseek_compat) = 2 sets
    assert.equal(route!.transforms.length, 2);
    assert.equal(route!.transforms[0].name, 'max_tokens_rename');
    assert.equal(route!.transforms[1].name, 'deepseek_compat');
  });

  it('deepseek_compat: request_ingress has lowercase_tool_schema_types builtin', () => {
    assert.ok(route);
    const deepseek = route!.transforms.find(s => s.name === 'deepseek_compat');
    assert.ok(deepseek, 'deepseek_compat set should be present');
    assert.deepEqual(deepseek!.request_ingress?.builtins, ['lowercase_tool_schema_types']);
  });

  it('deepseek_compat: before_upstream lowercases tool schema types', () => {
    assert.ok(route);
    const ctx: HookContext = {
      hook: 'request_ingress',
      route: route!,
      upstreamMode: 'openai-completions',
      clientModel: 'mymodel',
      requestId: 'r1',
      streaming: false,
      logger,
    };
    const body = {
      tools: [{ function: { parameters: { type: 'OBJECT', properties: { x: { type: 'STRING' } } } } }],
    };
    const result = runHook('request_ingress', { body, headers: {} }, ctx);
    const fn = (result.body.tools as any[])[0].function;
    assert.equal(fn.parameters.type, 'object');
    assert.equal(fn.parameters.properties.x.type, 'string');
  });

  it('deepseek_compat: before_upstream maps assistant content empty string → null when tool_calls present', () => {
    assert.ok(route);
    const ctx: HookContext = {
      hook: 'before_upstream',
      route: route!,
      upstreamMode: 'openai-completions',
      clientModel: 'mymodel',
      requestId: 'r2',
      streaming: false,
      logger,
    };
    const body = {
      messages: [
        { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'fn' } }] },
        { role: 'assistant', content: 'hello' }, // no tool_calls — should not change
      ],
    };
    const result = runHook('before_upstream', { body, headers: {} }, ctx);
    const msgs = result.body.messages as any[];
    assert.equal(msgs[0].content, null, 'content should become null when tool_calls present');
    assert.equal(msgs[1].content, 'hello', 'content should remain unchanged when no tool_calls');
  });
});

// ---------------------------------------------------------------------------
// max_tokens_rename: mode-default wiring
// ---------------------------------------------------------------------------

describe('max_tokens_rename: mode-default wiring', () => {
  const config = parseSimpleToml(maxTokensToml);
  const route = getModelRouteConfig('mymodel', config);
  const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;

  it('resolves max_tokens_rename transform set for openai-completions routes', () => {
    assert.ok(route, 'route should resolve');
    assert.ok(route!.transforms.length > 0, 'transforms should be non-empty');
    assert.equal(route!.transforms[0].name, 'max_tokens_rename');
    assert.equal(route!.transforms[0].before_upstream?.ops?.length, 1);
  });

  it('runHook renames max_tokens → max_completion_tokens via mode-default', () => {
    assert.ok(route);
    const ctx: HookContext = {
      hook: 'before_upstream',
      route: route!,
      upstreamMode: 'openai-completions',
      clientModel: 'mymodel',
      requestId: 'r1',
      streaming: false,
      logger,
    };
    const result = runHook('before_upstream', { body: { max_tokens: 4096, temperature: 0.7 }, headers: {} }, ctx);
    assert.equal(result.body['max_completion_tokens'], 4096);
    assert.equal('max_tokens' in result.body, false);
    assert.equal(result.body['temperature'], 0.7);
  });

  it('runHook is a no-op when max_tokens is absent', () => {
    assert.ok(route);
    const ctx: HookContext = {
      hook: 'before_upstream',
      route: route!,
      upstreamMode: 'openai-completions',
      clientModel: 'mymodel',
      requestId: 'r2',
      streaming: false,
      logger,
    };
    const result = runHook('before_upstream', { body: { temperature: 0.5 }, headers: {} }, ctx);
    assert.equal('max_completion_tokens' in result.body, false);
    assert.equal(result.body['temperature'], 0.5);
  });
});

// ---------------------------------------------------------------------------
// serializeProxyConfigToml — transforms / transform_defaults round-trip
// ---------------------------------------------------------------------------

describe('serializeProxyConfigToml: transforms round-trip', () => {
  it('preserves transforms, ops, builtins, anthropic_beta_map, and transform_defaults through serialize → parse', () => {
    const config: ProxyConfig = {
      transforms: {
        set_a: {
          name: 'set_a',
          schema: 'openai-completions',
          before_upstream: {
            ops: [
              { op: 'rename', path: 'max_tokens', to: 'max_completion_tokens' },
              { op: 'set', path: 'temperature', value: '0.7' },
              { op: 'default', path: 'top_p', value: '0.9' },
              { op: 'remove', path: 'output_config' },
              { op: 'map_value', path: 'messages[role=assistant].content', from: '', to: null, when_sibling: 'tool_calls' },
              { op: 'map_value', path: 'messages[role=user].content', from: 'x', to: 'y' },
            ],
            builtins: ['inject_missing_tool_results'],
          },
          request_ingress: {
            builtins: ['lowercase_tool_schema_types'],
          },
        },
        set_b: {
          name: 'set_b',
          schema: 'anthropic-messages',
          anthropic_beta_map: {
            'computer-use-2025-01-24': 'computer-use-2025-01-24',
            'unsupported-feature': null,
          },
          before_upstream: {
            builtins: ['filter_anthropic_beta'],
          },
        },
      },
      transform_defaults: {
        'openai-completions': ['set_a'],
      },
    };

    const serialized = serializeProxyConfigToml(config);
    const reparsed = parseSimpleToml(serialized);

    // transforms set names
    assert.deepEqual(
      Object.keys(reparsed.transforms || {}).sort(),
      ['set_a', 'set_b'],
    );

    // set_a fields
    const setA = reparsed.transforms!['set_a'];
    assert.equal(setA.schema, 'openai-completions');
    assert.deepEqual(
      setA.before_upstream?.ops,
      [
        { op: 'rename', path: 'max_tokens', to: 'max_completion_tokens' },
        { op: 'set', path: 'temperature', value: '0.7' },
        { op: 'default', path: 'top_p', value: '0.9' },
        { op: 'remove', path: 'output_config' },
        { op: 'map_value', path: 'messages[role=assistant].content', from: '', to: null, when_sibling: 'tool_calls' },
        { op: 'map_value', path: 'messages[role=user].content', from: 'x', to: 'y' },
      ],
    );
    assert.deepEqual(setA.before_upstream?.builtins, ['inject_missing_tool_results']);
    assert.deepEqual(setA.request_ingress?.builtins, ['lowercase_tool_schema_types']);

    // set_b fields
    const setB = reparsed.transforms!['set_b'];
    assert.equal(setB.schema, 'anthropic-messages');
    assert.deepEqual(setB.anthropic_beta_map, {
      'computer-use-2025-01-24': 'computer-use-2025-01-24',
      'unsupported-feature': null,
    });
    assert.deepEqual(setB.before_upstream?.builtins, ['filter_anthropic_beta']);

    // transform_defaults
    assert.deepEqual(reparsed.transform_defaults, {
      'openai-completions': ['set_a'],
    });
  });

  it('omits transforms and transform_defaults sections when absent', () => {
    const serialized = serializeProxyConfigToml({});
    assert.ok(!serialized.includes('[transforms.'));
    assert.ok(!serialized.includes('[transform_defaults]'));
  });
});
