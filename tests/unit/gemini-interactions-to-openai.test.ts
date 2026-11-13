import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  convertGeminiInteractionsToOpenAI,
  completionsToClaudeBody,
  completionsToResponsesBody,
} from '../../src/handlers/openai.js';

/**
 * Request-level fields of the Gemini Interactions body (`system_instruction`,
 * `tools`, `generation_config.stop_sequences`, `generation_config.tool_choice`)
 * must survive the conversion to an OpenAI Completions body, because that body
 * is then re-targeted to an openai-completions / anthropic-messages /
 * openai-responses upstream. Each case pins the field at the Completions hop,
 * and the cross-mode cases pin where it lands (or is still lost) at the second
 * hop.
 */

const userTurn = { input: [{ role: 'user', content: 'hi' }] };

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

  // Pinned, not fixed: Gemini's `any` ("must call some function") has no
  // faithful Completions string — a client asking for "any tool" is not asking
  // for "a tool call and no prose", and the upstream vocabularies disagree on
  // which one `required` means. `any` therefore stays `'auto'`.
  it("maps 'any' to 'auto', not to 'required'", () => {
    assert.equal(withChoice('any').tool_choice, 'auto');
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
      (err: Error) => err instanceof Error && err.message === 'Invalid Gemini Interactions request format',
    );
  });
});
