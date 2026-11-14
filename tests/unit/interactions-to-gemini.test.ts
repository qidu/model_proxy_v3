/**
 * `convertInteractionsToGenerateContent`: the Interactions request surface as a
 * generateContent body.
 *
 * The four defects this converter was written to fix all lived in what the old
 * inline mapping did not translate, so each is pinned here at the seam:
 *
 * 1. `contents` is built for every shape the spec's `input` union allows, and a
 *    shape that yields no content is refused (400) instead of sent as `[]`.
 * 2. Every part type is translated, not only `text`.
 * 3. `tools` reaches the upstream as `functionDeclarations` / a predefined
 *    family, not as the flat Interactions `Tool`.
 * 4. `generation_config`'s knobs reach `generationConfig` / `toolConfig` under
 *    the names generateContent declares — an unmapped name is a 400 from the
 *    upstream naming a field the client never wrote, so nothing is passed through
 *    unread.
 *
 * The front-door half — that these bodies are what the handler actually sends —
 * is in `tests/unit/gemini-interactions-input.test.ts`.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { convertInteractionsToGenerateContent } from '../../src/converters/interactions-to-gemini.js';

const body = (request: Record<string, unknown>) => convertInteractionsToGenerateContent(request);
const userTurn = { input: [{ role: 'user', content: 'hi' }] };

/** Assert the converter refuses `request`, and that the message names `needle`. */
function assertRefused(request: Record<string, unknown>, needle: RegExp): void {
  assert.throws(
    () => body(request),
    (error: Error) => error.name === 'ValidationError' && needle.test(error.message),
  );
}

describe('convertInteractionsToGenerateContent — input → contents', () => {
  it('hoists a system message out of input.messages instead of refuting the role', () => {
    const out = body({
      input: {
        messages: [
          { role: 'system', content: 'be terse' },
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      },
    }).body as any;

    assert.deepEqual(out.systemInstruction, { parts: [{ text: 'be terse' }] });
    assert.deepEqual(out.contents, [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'hello' }] },
    ]);
  });

  it('joins the top-level system_instruction with a hoisted system message', () => {
    const out = body({
      system_instruction: 'be terse',
      input: { messages: [{ role: 'developer', content: 'and precise' }, { role: 'user', content: 'hi' }] },
    }).body as any;

    assert.deepEqual(out.systemInstruction, { parts: [{ text: 'be terse\n\nand precise' }] });
  });

  it('refuses input.messages that yields no user or model content', () => {
    assertRefused(
      { input: { messages: [] } },
      /input\.messages.*at least one user or model message/,
    );
    assertRefused(
      { input: { messages: [{ role: 'system', content: 'be terse' }] } },
      /input\.messages.*at least one user or model message/,
    );
  });

  it('refuses a role generateContent cannot express, naming where it came from', () => {
    assertRefused(
      { input: { messages: [{ role: 'critic', content: 'hi' }] } },
      /input\.messages\[0\]\.role must be "user" or "model"/,
    );
  });

  it('refuses a message whose content is neither a string nor a part list', () => {
    assertRefused(
      { input: { messages: [{ role: 'user', content: { text: 'hi' } }] } },
      /input\.messages\[0\]\.content must be a string or an array/,
    );
  });

  it('takes the scalar form of an input step, whose `type` stands in for a role', () => {
    const out = body({ input: { type: 'model_output', content: 'hello' } }).body as any;

    assert.deepEqual(out.contents, [{ role: 'model', parts: [{ text: 'hello' }] }]);
  });

  it('reads the system prompt in the spellings this front door is served', () => {
    const wrapper = body({ system_instruction: { parts: [{ text: 'be ' }, { text: 'terse' }] }, ...userTurn }).body as any;
    assert.deepEqual(wrapper.systemInstruction, { parts: [{ text: 'be terse' }] });

    const alias = body({ systemInstruction: { text: 'be terse' }, ...userTurn }).body as any;
    assert.deepEqual(alias.systemInstruction, { parts: [{ text: 'be terse' }] });

    assertRefused({ system_instruction: 42, ...userTurn }, /`system_instruction` must be a string/);
  });
});

describe('convertInteractionsToGenerateContent — parts', () => {
  it('translates every declared part type to its generateContent part', () => {
    const out = body({
      input: {
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'document', data: 'JVBERi0=', mime_type: 'application/pdf' },
            { type: 'audio', uri: 'files/abc', mime_type: 'audio/mp3' },
            { type: 'function_result', call_id: 'call_1', name: 'f', result: { ok: true } },
            { type: 'thought', signature: 'sig', summary: { content: { type: 'text', text: 'reasoning' } } },
            { type: 'code_execution_call', arguments: { language: 'python', code: 'print(1)' } },
            { type: 'code_execution_result', result: '1', is_error: false },
          ],
        }],
      },
    }).body as any;

    assert.deepEqual(out.contents[0].parts, [
      { text: 'look' },
      { inline_data: { mime_type: 'application/pdf', data: 'JVBERi0=' } },
      { file_data: { file_uri: 'files/abc', mime_type: 'audio/mp3' } },
      { functionResponse: { id: 'call_1', name: 'f', response: { content: '{"ok":true}' } } },
      { thought: true, text: 'reasoning', thoughtSignature: 'sig' },
      { executableCode: { language: 'python', code: 'print(1)' } },
      { codeExecutionResult: { outcome: 'OUTCOME_OK', output: '1' } },
    ]);
  });

  it('relays a part already in the upstream dialect, type key and all', () => {
    // A body a `before_conversion`/`request_ingress` transform reshaped, or a
    // native client's: rebuilding it would only move §5.4's ref positions.
    const part = { inlineData: { mimeType: 'image/png', data: 'aGk=' } };
    const out = body({ input: [{ role: 'user', content: [part] }] }).body as any;

    assert.deepEqual(out.contents[0].parts, [part]);
  });

  it('refuses a snake_case part key generateContent does not declare, rather than relaying it', () => {
    // generateContent spells these `functionCall` / `executableCode`; the snake
    // twin has no reader anywhere in this repo, so relaying it would carry a field
    // name the upstream rejects into the request — an error naming a field the
    // client never wrote, which is what this converter exists to prevent.
    assertRefused({ input: [{ function_call: { name: 'f', args: {} } }] }, /is not a Content part/);
    assertRefused({ input: [{ executable_code: { language: 'python', code: '1' } }] }, /is not a Content part/);
  });

  it('rebinds an extracted Interactions media ref to its generateContent position', () => {
    const ref = {
      $spoolBlob: true,
      kind: 'interactions-media-data',
      hash: 'a'.repeat(64),
      size: 4,
      prefix: '',
    };
    const out = body({
      input: [{ type: 'image', data: ref, mime_type: 'image/png' }],
    }).body as any;

    assert.deepEqual(out.contents[0].parts, [{
      inline_data: {
        mime_type: 'image/png',
        data: { ...ref, kind: 'gemini-inline-data' },
      },
    }]);
  });

  it('reads a Claude-style base64 source as an inline_data payload', () => {
    const out = body({
      input: { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } }] }] },
    }).body as any;

    assert.deepEqual(out.contents[0].parts, [{ inline_data: { mime_type: 'image/png', data: 'aGk=' } }]);
  });

  it('refuses a Claude-style url source, which would need a server-side fetch', () => {
    assertRefused(
      { input: { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }] } },
      /only `base64` has a generateContent equivalent/,
    );
  });

  it('refuses a media part that carries no bytes and an unknown part type', () => {
    assertRefused({ input: [{ type: 'image', mime_type: 'image/png' }] }, /neither `data` nor `uri`/);
    assertRefused({ input: [{ type: 'video_note', data: 'x' }] }, /is not a Content part/);
  });

  it('reads a call’s arguments from the JSON-string spelling, and refuses a broken one', () => {
    const out = body({ input: [{ type: 'function_call', name: 'f', arguments: '{"a":1}' }] }).body as any;
    assert.deepEqual(out.contents[0].parts, [{ functionCall: { name: 'f', args: { a: 1 } } }]);

    // `{}` would be a silent loss of the call's arguments, so a string that is not
    // a JSON object is refused instead.
    assertRefused({ input: [{ type: 'function_call', name: 'f', arguments: 'not json' }] },
      /arguments is a string that is not JSON/);
  });

  it('carries an empty text part as it stands rather than dropping the part', () => {
    const out = body({ input: [{ role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: 'hi' }] }] }).body as any;

    assert.deepEqual(out.contents[0].parts, [{ text: '' }, { text: 'hi' }]);
    assertRefused({ input: [{ type: 'text' }] }, /\.text must be a string/);
  });
});

describe('convertInteractionsToGenerateContent — tools', () => {
  it('groups the flat function tools into one functionDeclarations entry, schema cleaned', () => {
    const out = body({
      ...userTurn,
      tools: [{
        type: 'function',
        name: 'get_weather',
        description: 'w',
        parameters: {
          $schema: 'http://json-schema.org/draft-07/schema#',
          type: 'object',
          additionalProperties: false,
          properties: { when: { type: 'string', format: 'date' } },
        },
      }],
    }).body as any;

    assert.deepEqual(out.tools, [{
      functionDeclarations: [{
        name: 'get_weather',
        description: 'w',
        // The same OpenAPI-subset cleaning the Claude and Completions paths apply.
        parameters: { type: 'object', properties: { when: { type: 'string' } } },
      }],
    }]);
  });

  it('maps each predefined family to the field that selects it', () => {
    const out = body({
      ...userTurn,
      tools: [
        { type: 'google_search' },
        { type: 'code_execution' },
        { type: 'url_context' },
        { type: 'computer_use', environment: 'browser', excludedPredefinedFunctions: ['open_url'] },
        { type: 'file_search', file_search_store_names: ['s1'], top_k: 3, metadata_filter: 'a=b' },
      ],
    }).body as any;

    assert.deepEqual(out.tools, [
      { googleSearch: {} },
      { codeExecution: {} },
      { urlContext: {} },
      { computerUse: { environment: 'browser', excludedPredefinedFunctions: ['open_url'] } },
      { fileSearch: { fileSearchStoreNames: ['s1'], topK: 3, metadataFilter: 'a=b' } },
    ]);
  });

  it('relays a tool already in the upstream dialect, functionDeclarations and all', () => {
    // A native client's or a transform's output: the Interactions front door is
    // also served the generateContent spelling (the sibling converter reads both
    // in the other direction, and the integration suite's TC207 sends this one).
    const tool = { functionDeclarations: [{ name: 'get_weather', description: 'w', parameters: { type: 'object' } }] };
    const out = body({ ...userTurn, tools: [tool, { googleSearch: {} }] }).body as any;

    assert.deepEqual(out.tools, [tool, { googleSearch: {} }]);
  });

  it('refuses the families and tools it cannot express, rather than dropping them', () => {
    // A dropped tool leaves the model unable to call something the client asked
    // for, and a guessed MCP shape earns an upstream error naming it.
    assertRefused({ ...userTurn, tools: [{ type: 'google_search' }, { type: 'mcp_server', url: 'https://x/mcp' }] },
      /`mcp_server` tools have no pinned generateContent equivalent/);
    assertRefused({ ...userTurn, tools: [{ type: 'function', description: 'no name' }] }, /tools\[0\]\.name/);
    assertRefused({ ...userTurn, tools: [{ type: 'telepathy' }] }, /tools\[0\] carries an unsupported type/);
  });

  it('invents no tools key when the client sent none', () => {
    assert.equal('tools' in body(userTurn).body, false);
  });
});

describe('convertInteractionsToGenerateContent — generation_config', () => {
  it('renames the sampling knobs to the names generateContent declares', () => {
    const out = body({
      ...userTurn,
      generation_config: {
        temperature: 0.3,
        top_p: 0.9,
        seed: 7,
        max_output_tokens: 1234,
        stop_sequences: ['END'],
      },
    }).body as any;

    assert.deepEqual(out.generationConfig, {
      temperature: 0.3,
      topP: 0.9,
      seed: 7,
      maxOutputTokens: 1234,
      stopSequences: ['END'],
    });
  });

  it('maps the thinking knobs into thinkingConfig, re-casing the level', () => {
    const level = body({ ...userTurn, generation_config: { thinking_level: 'minimal' } }).body as any;
    assert.deepEqual(level.generationConfig.thinkingConfig, { thinkingLevel: 'MINIMAL' });

    const summaries = body({ ...userTurn, generation_config: { thinking_summaries: 'auto' } }).body as any;
    assert.deepEqual(summaries.generationConfig.thinkingConfig, { includeThoughts: true });

    const none = body({ ...userTurn, generation_config: { thinking_summaries: 'none' } }).body as any;
    assert.deepEqual(none.generationConfig.thinkingConfig, { includeThoughts: false });
  });

  it('maps tool_choice to toolConfig, keeping a forced function and an allow-list', () => {
    const auto = body({ ...userTurn, generation_config: { tool_choice: 'auto' } }).body as any;
    assert.deepEqual(auto.toolConfig, { functionCallingConfig: { mode: 'AUTO' } });

    const any = body({ ...userTurn, generation_config: { tool_choice: 'any' } }).body as any;
    assert.deepEqual(any.toolConfig, { functionCallingConfig: { mode: 'ANY' } });

    const none = body({ ...userTurn, generation_config: { tool_choice: 'none' } }).body as any;
    assert.deepEqual(none.toolConfig, { functionCallingConfig: { mode: 'NONE' } });

    // The object forms: a forced single function, and an allow-list.
    const forced = body({ ...userTurn, generation_config: { tool_choice: { type: 'function', function: { name: 'f' } } } }).body as any;
    assert.deepEqual(forced.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['f'] } });

    const listed = body({ ...userTurn, generation_config: { tool_choice: { mode: 'any', tools: ['f', 'g'] } } }).body as any;
    assert.deepEqual(listed.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['f', 'g'] } });
  });

  it('refuses a tool_choice it cannot honour instead of letting the model choose freely', () => {
    assertRefused({ ...userTurn, generation_config: { tool_choice: 'sometimes' } }, /has no generateContent mode/);
  });

  it('maps the knobs declared beside generation_config', () => {
    const out = body({
      ...userTurn,
      response_mime_type: 'application/json',
      response_format: { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false },
      response_modalities: ['text', 'image'],
    }).body as any;

    assert.equal(out.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(out.generationConfig.responseSchema, {
      type: 'object',
      properties: { a: { type: 'string' } },
    });
    assert.deepEqual(out.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
  });

  it('maps image_config to imageConfig', () => {
    const out = body({
      ...userTurn,
      generation_config: { image_config: { aspect_ratio: '16:9', image_size: '2K' } },
    }).body as any;

    assert.deepEqual(out.generationConfig.imageConfig, { aspectRatio: '16:9', imageSize: '2K' });
  });

  it('reports the knobs it has no equivalent for, rather than shipping them upstream', () => {
    const { body: out, dropped } = body({
      ...userTurn,
      store: true,
      previous_interaction_id: 'v1_abc',
      generation_config: { temperature: 0.3, speech_config: { voice: 'Aoede' } },
    });

    assert.deepEqual(dropped, ['generation_config.speech_config', 'previous_interaction_id', 'store']);
    assert.deepEqual((out as any).generationConfig, { temperature: 0.3 });
  });

  it('invents no generationConfig or toolConfig when the client sent neither', () => {
    const out = body(userTurn).body as any;

    for (const key of ['generationConfig', 'toolConfig', 'systemInstruction', 'cachedContent', 'stream']) {
      assert.equal(key in out, false, `${key} must not be invented`);
    }
  });

  it('carries cached_content and stream as the upstream spells them', () => {
    const out = body({ ...userTurn, cached_content: 'caches/1', stream: true }).body as any;

    assert.equal(out.cachedContent, 'caches/1');
    assert.equal(out.stream, true);
  });
});
