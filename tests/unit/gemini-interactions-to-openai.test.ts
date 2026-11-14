import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  convertGeminiGenerateContentToOpenAI,
  convertGeminiInteractionsToOpenAI,
} from '../../src/converters/gemini-to-openai.js';
import { completionsToClaudeBody } from '../../src/converters/completions-to-claude.js';
import { completionsToResponsesBody } from '../../src/converters/completions-to-responses.js';

/**
 * Request-level fields of the Gemini Interactions body (`system_instruction`,
 * `tools`, `generation_config.stop_sequences`, `generation_config.tool_choice`,
 * the `generation_config` sampling knobs, `store`, `response_format` /
 * `response_mime_type`) must survive the conversion to an OpenAI Completions
 * body, because that body is then re-targeted to an openai-completions /
 * anthropic-messages / openai-responses upstream. Each case pins the field at
 * the Completions hop, and the cross-mode cases pin where it lands (or is still
 * lost) at the second hop.
 *
 * The end-to-end half of the same claim — that these survive the whole handler
 * and reach the bytes the upstream receives — is in
 * `tests/unit/interactions-request-field-carry.test.ts`.
 */

const userTurn = { input: [{ role: 'user', content: 'hi' }] };

/**
 * An `input` this hop cannot express is refused with a 400 naming the field,
 * rather than reaching the upstream half-read (or 500-ing, as an unrecognized
 * shape used to).
 */
function assertRefused(input: unknown, needle: RegExp): void {
  assert.throws(
    () => convertGeminiInteractionsToOpenAI({ model: 'm', input }),
    (error: any) => error.name === 'ValidationError'
      && error.status === 400
      && needle.test(error.message),
  );
}

describe('convertGeminiInteractionsToOpenAI — system_instruction', () => {
  it('prepends system_instruction (Interactions string form) as a system message', () => {
    const out = convertGeminiInteractionsToOpenAI({
      model: 'm',
      system_instruction: 'be terse',
      ...userTurn,
    }) as any;

    assert.equal(out.messages.length, 2);
    assert.deepEqual(out.messages[0], { role: 'system', content: 'be terse' });
    assert.deepEqual(out.messages[1], { role: 'user', content: 'hi' });
  });

  it('accepts the generateContent shape {parts:[{text}]} and joins the parts', () => {
    const out = convertGeminiInteractionsToOpenAI({
      model: 'm',
      systemInstruction: { parts: [{ text: 'be ' }, { text: 'terse' }, { inline_data: { data: 'X' } }] },
      ...userTurn,
    }) as any;

    assert.deepEqual(out.messages[0], { role: 'system', content: 'be terse' });
  });

  it('adds no system message when system_instruction is absent', () => {
    const out = convertGeminiInteractionsToOpenAI({ model: 'm', ...userTurn }) as any;

    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].role, 'user');
  });

  it("does not mutate the caller's input.messages array", () => {
    const inputMessages = [{ role: 'user', content: 'hi' }];
    const out = convertGeminiInteractionsToOpenAI({
      model: 'm',
      system_instruction: 'be terse',
      input: { messages: inputMessages },
    }) as any;

    assert.equal(inputMessages.length, 1);
    assert.equal(out.messages.length, 2);
    assert.notEqual(out.messages, inputMessages);
  });
});

describe('convertGeminiInteractionsToOpenAI — tools', () => {
  it('maps a flat Interactions function tool to an OpenAI function tool', () => {
    const out = convertGeminiInteractionsToOpenAI({
      model: 'm',
      tools: [{
        type: 'function',
        name: 'get_weather',
        description: 'Weather lookup',
        parameters: { type: 'OBJECT', properties: { city: { type: 'STRING' } } },
      }],
      ...userTurn,
    }) as any;

    // Parameters go through normalizeGeminiSchema, so Gemini's uppercase type
    // names are lowercased for the OpenAI-compatible upstream.
    assert.deepEqual(out.tools, [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Weather lookup',
        parameters: { type: 'object', properties: { city: { type: 'string' } } },
      },
    }]);
  });

  it('maps a native {functionDeclarations:[...]} tool wrapper', () => {
    const out = convertGeminiInteractionsToOpenAI({
      model: 'm',
      tools: [{ functionDeclarations: [{ name: 'get_time', parameters: { type: 'object', properties: {} } }] }],
      ...userTurn,
    }) as any;

    assert.deepEqual(out.tools, [{
      type: 'function',
      function: { name: 'get_time', description: undefined, parameters: { type: 'object', properties: {} } },
    }]);
  });

  it('emits no tools key when the only tool has no Completions equivalent', () => {
    const out = convertGeminiInteractionsToOpenAI({
      model: 'm',
      tools: [{ type: 'google_search' }],
      ...userTurn,
    }) as any;

    assert.equal('tools' in out, false);
  });

  it('emits no tools key when tools is absent or not an array', () => {
    assert.equal('tools' in (convertGeminiInteractionsToOpenAI({ model: 'm', ...userTurn }) as any), false);
    assert.equal('tools' in (convertGeminiInteractionsToOpenAI({ model: 'm', tools: 'nope', ...userTurn }) as any), false);
  });
});

describe('convertGeminiInteractionsToOpenAI — generation_config.stop_sequences', () => {
  it('maps the snake_case stop_sequences to the Completions stop array', () => {
    const out = convertGeminiInteractionsToOpenAI({
      model: 'm',
      generation_config: { stop_sequences: ['5.', 'END'] },
      ...userTurn,
    }) as any;

    assert.deepEqual(out.stop, ['5.', 'END']);
  });

  it('accepts camelCase generationConfig.stopSequences', () => {
    const out = convertGeminiInteractionsToOpenAI({
      model: 'm',
      generationConfig: { stopSequences: ['END'] },
      ...userTurn,
    }) as any;

    assert.deepEqual(out.stop, ['END']);
  });

  it('omits stop for an empty or absent list', () => {
    assert.equal('stop' in (convertGeminiInteractionsToOpenAI({
      model: 'm', generation_config: { stop_sequences: [] }, ...userTurn,
    }) as any), false);
    assert.equal('stop' in (convertGeminiInteractionsToOpenAI({ model: 'm', ...userTurn }) as any), false);
  });
});

describe('convertGeminiInteractionsToOpenAI — generation_config.tool_choice', () => {
  // A tool must survive for tool_choice to be emitted at all: upstreams reject
  // a tool_choice that names no declared function.
  const weatherTool = { type: 'function', name: 'get_weather', parameters: { type: 'OBJECT', properties: {} } };
  const withChoice = (toolChoice: unknown, tools: unknown[] = [weatherTool]) =>
    convertGeminiInteractionsToOpenAI({
      model: 'm',
      tools,
      generation_config: { tool_choice: toolChoice },
      ...userTurn,
    }) as any;

  it('maps the bare enums auto / none to the same Completions strings', () => {
    assert.equal(withChoice('auto').tool_choice, 'auto');
    assert.equal(withChoice('none').tool_choice, 'none');
  });

  // Gemini's `any` means "constrained to always predicting a function call",
  // which is Completions' `'required'` — the same conclusion the reverse
  // converters reach (`claude-to-gemini.ts`: `required` → ANY, no allow-list).
  it("maps 'any' to 'required'", () => {
    assert.equal(withChoice('any').tool_choice, 'required');
  });

  it("maps the undocumented 'dynamic' to 'auto'", () => {
    assert.equal(withChoice('dynamic').tool_choice, 'auto');
  });

  it("maps 'validated' to 'required'", () => {
    assert.equal(withChoice('validated').tool_choice, 'required');
  });

  it('maps {type:auto} to auto', () => {
    assert.equal(withChoice({ type: 'auto' }).tool_choice, 'auto');
  });

  it('passes a forced function through as the Completions function form', () => {
    assert.deepEqual(withChoice({ type: 'function', function: { name: 'get_weather' } }).tool_choice, {
      type: 'function',
      function: { name: 'get_weather' },
    });
  });

  it('maps a single-name allow-list to the forced function form', () => {
    assert.deepEqual(withChoice({ mode: 'any', tools: ['get_weather'] }).tool_choice, {
      type: 'function',
      function: { name: 'get_weather' },
    });
  });

  // Pinned, not fixed: Completions cannot express "one of these two, and no
  // other tool", so an allow-list of 2+ collapses to the looser 'required'.
  it("collapses a multi-name allow-list to 'required' (looser)", () => {
    assert.equal(withChoice({ mode: 'any', tools: ['get_weather', 'get_time'] }).tool_choice, 'required');
  });

  it('accepts the generateContent toolConfig.functionCallingConfig spelling', () => {
    const out = convertGeminiInteractionsToOpenAI({
      model: 'm',
      tools: [weatherTool],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather'] } },
      ...userTurn,
    }) as any;

    assert.deepEqual(out.tool_choice, { type: 'function', function: { name: 'get_weather' } });
  });

  it('omits tool_choice for an unrecognized value', () => {
    assert.equal('tool_choice' in withChoice('nope'), false);
  });

  it('omits tool_choice when no tool survived the conversion', () => {
    // google_search has no Completions equivalent, so the body carries no tools
    // and a tool_choice would name a function the upstream does not have.
    assert.equal('tool_choice' in withChoice('required', [{ type: 'google_search' }]), false);
    assert.equal('tool_choice' in withChoice('auto', []), false);
  });
});

describe('convertGeminiInteractionsToOpenAI — cross-mode tool_choice', () => {
  const weatherTool = { type: 'function', name: 'get_weather', parameters: { type: 'OBJECT', properties: {} } };
  const body = (toolChoice: unknown) => ({
    model: 'm',
    tools: [weatherTool],
    generation_config: { tool_choice: toolChoice },
    input: [{ role: 'user', content: 'hi' }],
  });

  it("reaches an anthropic-messages upstream as {type:'any'} for 'validated'", async () => {
    const claude = await completionsToClaudeBody(convertGeminiInteractionsToOpenAI(body('validated')), 'claude-target') as any;

    assert.deepEqual(claude.tool_choice, { type: 'any' });
  });

  it("reaches an anthropic-messages upstream as {type:'any'} for 'any'", async () => {
    const claude = await completionsToClaudeBody(convertGeminiInteractionsToOpenAI(body('any')), 'claude-target') as any;

    assert.deepEqual(claude.tool_choice, { type: 'any' });
  });

  it("keeps 'none' as {type:'none'} at the anthropic-messages hop", async () => {
    const claude = await completionsToClaudeBody(convertGeminiInteractionsToOpenAI(body('none')), 'claude-target') as any;

    assert.deepEqual(claude.tool_choice, { type: 'none' });
  });

  it("reaches an anthropic-messages upstream as {type:'tool', name} for a forced function", async () => {
    const claude = await completionsToClaudeBody(
      convertGeminiInteractionsToOpenAI(body({ type: 'function', function: { name: 'get_weather' } })),
      'claude-target',
    ) as any;

    assert.deepEqual(claude.tool_choice, { type: 'tool', name: 'get_weather' });
  });

  it("reaches an openai-responses upstream as 'required' for 'validated'", () => {
    const responses = completionsToResponsesBody(convertGeminiInteractionsToOpenAI(body('validated')), 'responses-target') as any;

    assert.equal(responses.tool_choice, 'required');
  });

  it("reaches an openai-responses upstream as 'required' for 'any'", () => {
    const responses = completionsToResponsesBody(convertGeminiInteractionsToOpenAI(body('any')), 'responses-target') as any;

    assert.equal(responses.tool_choice, 'required');
  });

  it("reaches an openai-responses upstream as {type:'function', name} for a forced function", () => {
    const responses = completionsToResponsesBody(
      convertGeminiInteractionsToOpenAI(body({ type: 'function', function: { name: 'get_weather' } })),
      'responses-target',
    ) as any;

    assert.deepEqual(responses.tool_choice, { type: 'function', name: 'get_weather' });
  });

  it('is dropped at the anthropic-messages hop when the Completions body carries no tools', async () => {
    // Belt-and-braces: hop 1 already gates on tools, but the hop-2 gate must
    // hold on its own — Claude rejects a tool_choice with an empty tools list.
    const claude = await completionsToClaudeBody({
      messages: [{ role: 'user', content: 'hi' }],
      tool_choice: 'required',
    }, 'claude-target') as any;

    assert.equal('tool_choice' in claude, false);
  });
});

describe('convertGeminiInteractionsToOpenAI — cross-mode carry-through', () => {
  const interactionsBody = {
    model: 'm',
    system_instruction: 'be terse',
    tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'OBJECT', properties: {} } }],
    generation_config: { stop_sequences: ['END'] },
    input: [{ role: 'user', content: 'hi' }],
  };

  it('reaches an anthropic-messages upstream as system + tools + stop_sequences', async () => {
    const completions = convertGeminiInteractionsToOpenAI(interactionsBody);
    const claude = await completionsToClaudeBody(completions, 'claude-target') as any;

    assert.equal(claude.system, 'be terse');
    assert.deepEqual(claude.stop_sequences, ['END']);
    assert.deepEqual(claude.tools, [{
      name: 'get_weather',
      description: undefined,
      input_schema: { type: 'object', properties: {} },
    }]);
    assert.deepEqual(claude.messages, [{ role: 'user', content: 'hi' }]);
  });

  it('reaches an openai-responses upstream as instructions + tools, and still drops stop', () => {
    const completions = convertGeminiInteractionsToOpenAI(interactionsBody);
    const responses = completionsToResponsesBody(completions, 'responses-target') as any;

    assert.equal(responses.instructions, 'be terse');
    assert.deepEqual(responses.tools, [{
      type: 'function',
      name: 'get_weather',
      description: undefined,
      parameters: { type: 'object', properties: {} },
    }]);
    // Pinned, not fixed: the Responses API has no stop-sequence field, so the
    // hop-1 mapping cannot reach this upstream. A future fix shows up here.
    assert.equal('stop' in responses, false);
    assert.equal('stop_sequences' in responses, false);
  });
});

describe('convertGeminiInteractionsToOpenAI — input shapes', () => {
  it('passes input.messages through unchanged', () => {
    const out = convertGeminiInteractionsToOpenAI({
      model: 'm',
      input: { messages: [{ role: 'user', content: 'hi' }] },
      stream: true,
    }) as any;

    assert.deepEqual(out, { model: 'm', messages: [{ role: 'user', content: 'hi' }], stream: true });
  });

  const stepBody = {
    model: 'm',
    input: [
      { type: 'user_input', content: [{ type: 'text', text: 'hi' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'hello' }] },
      { type: 'user_input', content: [{ type: 'text', text: 'again' }] },
    ],
  };

  it('resolves each input step role from its own type', () => {
    // A step carries `type` where a Turn carries `role`, and the role of every
    // item is decided by that item — not by the array's first entry.
    const out = convertGeminiInteractionsToOpenAI(stepBody) as any;

    assert.deepEqual(out.messages, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'again' },
    ]);
  });

  it('carries a model_output step to an anthropic-messages upstream as assistant', async () => {
    const claude = await completionsToClaudeBody(
      convertGeminiInteractionsToOpenAI(stepBody),
      'claude-target',
    ) as any;

    assert.deepEqual(claude.messages.map((m: any) => m.role), ['user', 'assistant', 'user']);
  });

  it('throws on a body with no recognizable input', () => {
    assert.throws(
      () => convertGeminiInteractionsToOpenAI({ model: 'm' }),
      (err: any) => err.name === 'ValidationError'
        && err.status === 400
        && err.message === 'Invalid Gemini Interactions request format',
    );
  });

  it('reads a bare Content[] as one turn part list, not one message per part', () => {
    // The shape `docs/api/interactions.md`'s multimodal example uses, and the one
    // this hop used to mis-read as Turns: each part became a message whose role
    // and content had both been dropped.
    const out = convertGeminiInteractionsToOpenAI({
      model: 'm',
      input: [{ type: 'text', text: 'hi' }, { type: 'text', text: ' again' }],
    }) as any;

    assert.deepEqual(out.messages, [{ role: 'user', content: 'hi again' }]);
  });

  it('carries that Content[] turn to an anthropic-messages upstream as a user message', async () => {
    const claude = await completionsToClaudeBody(
      convertGeminiInteractionsToOpenAI({ model: 'm', input: [{ type: 'text', text: 'hi' }] }),
      'claude-target',
    ) as any;

    assert.deepEqual(claude.messages, [{ role: 'user', content: 'hi' }]);
  });

  it('reads a lone Turn, step or Content as one message', () => {
    const one = (input: unknown) =>
      (convertGeminiInteractionsToOpenAI({ model: 'm', input }) as any).messages;

    assert.deepEqual(one({ role: 'user', content: 'hi' }), [{ role: 'user', content: 'hi' }]);
    assert.deepEqual(one({ type: 'user_input', content: 'hi' }), [{ role: 'user', content: 'hi' }]);
    assert.deepEqual(one({ type: 'text', text: 'hi' }), [{ role: 'user', content: 'hi' }]);
  });

  it("maps a Turn's generateContent model role to assistant", () => {
    const out = convertGeminiInteractionsToOpenAI({
      model: 'm',
      input: [{ role: 'user', content: 'hi' }, { role: 'model', content: 'hello' }],
    }) as any;

    assert.deepEqual(out.messages.map((m: any) => m.role), ['user', 'assistant']);
  });

  it('keeps passing input.messages through, role-less entries included', () => {
    // Deliberately not the native-Gemini converter's behaviour, which refuses a
    // role it cannot express: on this hop a role the client left out is defaulted
    // to `user` further down, on an openai-completions route
    // (pinned in `openai-gemini-role-default.test.ts`).
    const out = convertGeminiInteractionsToOpenAI({
      model: 'm',
      input: { messages: [{ content: 'hi' }] },
    }) as any;

    assert.deepEqual(out.messages, [{ content: 'hi' }]);
  });

  it('refuses an input shape that carries no message, naming the field', () => {
    assertRefused([], /`input` array must carry at least one content/);
    assertRefused({ messages: [] }, /`input\.messages` must contain at least one user or model message/);
    assertRefused(5, /`input` must be a string, a Content, an array of Content or Turn/);
    assertRefused({ nope: true }, /`input` must be a string, a Content, an array of Content or Turn/);
  });

  it('refuses a Turn/step content that is neither a string nor a part list', () => {
    // `String(content)` used to put `[object Object]` — or `42` — in the prompt.
    assertRefused(
      [{ type: 'user_input', content: { type: 'text', text: 'hi' } }],
      /input step "user_input"\.content must be a string or an array of Content parts/,
    );
    assertRefused(
      [{ type: 'user_input', content: 42 }],
      /\.content must be a string or an array of Content parts/,
    );
    assertRefused([{ type: 'user_input', content: [] }], /\.content must carry at least one part/);
  });
});

describe('convertGeminiGenerateContentToOpenAI — system_instruction spellings', () => {
  // The same field, and the same reader: the Interactions spelling is snake_case
  // and a bare string, generateContent's is camelCase and `{parts:[…]}`. A
  // snake_case system prompt used to be dropped here in silence.
  const contents = [{ role: 'user', parts: [{ text: 'hi' }] }];
  const systemText = (extra: Record<string, unknown>) =>
    (convertGeminiGenerateContentToOpenAI({ model: 'm', contents, ...extra }) as any).messages[0];

  it('reads the Interactions system_instruction (snake_case string)', () => {
    assert.deepEqual(systemText({ system_instruction: 'be terse' }), { role: 'system', content: 'be terse' });
  });

  it('reads a snake_case text part list', () => {
    assert.deepEqual(
      systemText({ system_instruction: { parts: [{ text: 'be ' }, { text: 'terse' }] } }),
      { role: 'system', content: 'be terse' },
    );
  });

  it('still reads the generateContent systemInstruction spellings', () => {
    assert.deepEqual(systemText({ systemInstruction: 'be terse' }), { role: 'system', content: 'be terse' });
    assert.deepEqual(
      systemText({ systemInstruction: { parts: [{ text: 'be terse' }] } }),
      { role: 'system', content: 'be terse' },
    );
  });

  it('refuses an unrecognized system prompt shape rather than dropping it', () => {
    assert.throws(
      () => convertGeminiGenerateContentToOpenAI({ model: 'm', contents, system_instruction: 42 }),
      (err: any) => err.name === 'ValidationError' && err.status === 400
        && /`system_instruction` must be a string or a text part list/.test(err.message),
    );
  });
});

describe('convertGeminiInteractionsToOpenAI — sampling knobs, retention and structured output', () => {
  const body = (extra: Record<string, unknown> = {}) => ({ model: 'm', input: 'hi', ...extra });

  it('maps the generation_config sampling knobs to their Completions spellings', () => {
    const out = convertGeminiInteractionsToOpenAI(body({
      generation_config: { temperature: 0.3, top_p: 0.9, max_output_tokens: 1234 },
    })) as any;

    assert.equal(out.temperature, 0.3);
    assert.equal(out.top_p, 0.9);
    // Renamed across the hop: `max_output_tokens` is the Interactions spelling,
    // `max_tokens` the one the route cap and the Responses hop both read.
    assert.equal(out.max_tokens, 1234);
    assert.equal('max_output_tokens' in out, false);
  });

  it('maps thinking_level to reasoning_effort for all four levels', () => {
    // All four survive because the Responses effort enum carries `minimal` too, so
    // this is a rename rather than a clamp.
    for (const level of ['minimal', 'low', 'medium', 'high']) {
      const out = convertGeminiInteractionsToOpenAI(body({
        generation_config: { thinking_level: level },
      })) as any;

      assert.equal(out.reasoning_effort, level);
    }
  });

  it('accepts the camelCase thinkingLevel spelling', () => {
    const out = convertGeminiInteractionsToOpenAI(body({
      generation_config: { thinkingLevel: 'high' },
    })) as any;

    assert.equal(out.reasoning_effort, 'high');
  });

  it('carries store in both directions, and omits it when absent', () => {
    assert.equal((convertGeminiInteractionsToOpenAI(body({ store: false })) as any).store, false);
    assert.equal((convertGeminiInteractionsToOpenAI(body({ store: true })) as any).store, true);
    assert.equal('store' in (convertGeminiInteractionsToOpenAI(body()) as any), false);
  });

  it('ignores a non-boolean store', () => {
    const out = convertGeminiInteractionsToOpenAI(body({ store: 'yes' })) as any;

    assert.equal('store' in out, false);
  });

  it('wraps a JSON-schema response_format in the named Completions json_schema', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const out = convertGeminiInteractionsToOpenAI(body({ response_format: schema })) as any;

    assert.deepEqual(out.response_format, {
      type: 'json_schema',
      json_schema: { name: 'response', schema },
    });
  });

  it('maps response_mime_type application/json to the schema-less JSON mode', () => {
    const out = convertGeminiInteractionsToOpenAI(body({ response_mime_type: 'application/json' })) as any;

    assert.deepEqual(out.response_format, { type: 'json_object' });
  });

  it('prefers a response_format schema over response_mime_type', () => {
    const out = convertGeminiInteractionsToOpenAI(body({
      response_format: { type: 'object' },
      response_mime_type: 'application/json',
    })) as any;

    assert.equal(out.response_format.type, 'json_schema');
  });

  it('leaves a mime type with no Completions equivalent alone', () => {
    const out = convertGeminiInteractionsToOpenAI(body({ response_mime_type: 'text/plain' })) as any;

    assert.equal('response_format' in out, false);
  });

  it('invents no key when the client sent none of them', () => {
    const out = convertGeminiInteractionsToOpenAI(body()) as any;

    for (const key of ['temperature', 'top_p', 'max_tokens', 'reasoning_effort', 'store', 'response_format']) {
      assert.equal(key in out, false, `${key} must not be invented`);
    }
  });
});

describe('convertGeminiInteractionsToOpenAI — the sampling knobs at the second hop', () => {
  const body = {
    model: 'm',
    input: [{ role: 'user', content: 'hi' }],
    store: false,
    response_mime_type: 'application/json',
    generation_config: { temperature: 0.3, top_p: 0.9, max_output_tokens: 1234, thinking_level: 'minimal' },
  };

  it('reaches an openai-responses upstream as the Responses spellings', () => {
    const responses = completionsToResponsesBody(
      convertGeminiInteractionsToOpenAI(body), 'responses-target',
    ) as any;

    assert.equal(responses.temperature, 0.3);
    assert.equal(responses.top_p, 0.9);
    assert.equal(responses.max_output_tokens, 1234);
    assert.equal(responses.store, false);
    // The Completions scalar becomes the Responses nested object.
    assert.deepEqual(responses.reasoning, { effort: 'minimal' });
    assert.deepEqual(responses.text, { format: { type: 'json_object' } });
  });

  it('unwraps a json_schema response_format into the Responses text.format', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const responses = completionsToResponsesBody(
      convertGeminiInteractionsToOpenAI({ model: 'm', input: 'hi', response_format: schema }),
      'responses-target',
    ) as any;

    assert.deepEqual(responses.text, { format: { type: 'json_schema', name: 'response', schema } });
  });

  it('reaches an anthropic-messages upstream as temperature, top_p and max_tokens', async () => {
    const claude = await completionsToClaudeBody(
      convertGeminiInteractionsToOpenAI(body), 'claude-target',
    ) as any;

    assert.equal(claude.temperature, 0.3);
    assert.equal(claude.top_p, 0.9);
    assert.equal(claude.max_tokens, 1234);
  });
});
