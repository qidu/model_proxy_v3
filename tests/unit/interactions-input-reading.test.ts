/**
 * One `input`, two front doors — the reading has to agree.
 *
 * `/v1/interactions` is served by both `gemini-to-openai.ts` (→ an
 * openai-completions / anthropic-messages / openai-responses upstream) and
 * `interactions-to-gemini.ts` (→ a gemini-generatecontent one). Each door owns
 * its own dialect, but the *reading* of the body belongs to neither: which
 * element is a turn, which is a step, and which is a part that merges with the
 * parts beside it. Both used to decide that from `input[0]` alone, and they did
 * not even decide it the same way (finding #5):
 *
 *   - `[{text}, {function_call}]` — the openai door read the array as one part
 *     list and refused the call ("needs a message of its own"); the gemini door
 *     read it the same way and filed the model's call in the *user* turn.
 *   - `[{thought}, {text}]` — the openai door read the array as a step list, so
 *     the `text` after the thought was refused as a step that "has no Completions
 *     equivalent", a message about the wrong element; the gemini door read it as
 *     parts and put both in one user turn.
 *
 * The cases below are the shapes `docs/api/interactions.md:22-24` declares
 * (`Content | Content[] | Turn[] | string`), run through both doors, and asserted
 * to produce the same turns: same count, same order, same role, same text. A
 * door is a rendering of the same reading, so a shape the two render differently
 * is a defect in one of them.
 *
 * `thought` is deliberately absent: it is the one element the two wires hold
 * differently rather than read differently — Completions has message-level
 * `reasoning_content`, while generateContent carries a `thought` *part* — so it
 * is pinned per door, in each converter's own suite.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { convertGeminiInteractionsToOpenAI } from '../../src/converters/gemini-to-openai.js';
import { convertInteractionsToGenerateContent } from '../../src/converters/interactions-to-gemini.js';

/** A turn as both dialects can be reduced to for comparison. */
type Turn = [role: 'user' | 'assistant', text: string];

/** The Completions messages, as `[role, text]` — `tool` files on the user side. */
function openaiTurns(input: unknown): Turn[] {
  const { messages } = convertGeminiInteractionsToOpenAI({ model: 'm', input }) as any;
  return messages.map((m: any): Turn => [
    m.role === 'assistant' ? 'assistant' : 'user',
    typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('')
        : '',
  ]);
}

/** The generateContent contents, as `[role, text]` — `model` reads as assistant. */
function geminiTurns(input: unknown): Turn[] {
  const { body } = convertInteractionsToGenerateContent({ model: 'm', input });
  return ((body as any).contents as any[]).map((c): Turn => [
    c.role === 'model' ? 'assistant' : 'user',
    // A tool result's text rides `response.content`, which is this wire's position
    // for the same string Completions puts in the `role:'tool'` message.
    (c.parts ?? [])
      .map((p: any) => (typeof p?.text === 'string' ? p.text : typeof p?.functionResponse?.response?.content === 'string' ? p.functionResponse.response.content : ''))
      .join(''),
  ]);
}

describe('the `input` reading both front doors share', () => {
  const SHAPES: Array<{ name: string; input: unknown[]; turns: Turn[] }> = [
    {
      name: 'one bare Content part',
      input: [{ type: 'text', text: 'hi' }],
      turns: [['user', 'hi']],
    },
    {
      name: 'two adjacent Content parts — one turn, not two',
      input: [{ type: 'text', text: 'hi' }, { type: 'text', text: ' there' }],
      turns: [['user', 'hi there']],
    },
    {
      name: 'a Content part followed by a function_call',
      input: [
        { type: 'text', text: 'q' },
        { type: 'function_call', id: 'c1', name: 'f', arguments: { a: 1 } },
      ],
      turns: [['user', 'q'], ['assistant', '']],
    },
    {
      name: 'a function_call followed by its result',
      input: [
        { type: 'function_call', id: 'c1', name: 'f', arguments: {} },
        { type: 'function_result', call_id: 'c1', name: 'f', result: 'ok' },
      ],
      turns: [['assistant', ''], ['user', 'ok']],
    },
    {
      name: 'a step standing in for a role, then a bare Content part',
      input: [{ type: 'user_input', content: 'q' }, { type: 'text', text: 'stray' }],
      turns: [['user', 'q'], ['user', 'stray']],
    },
    {
      name: 'a Turn list',
      input: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }],
      turns: [['user', 'q'], ['assistant', 'a']],
    },
    {
      name: 'a step list',
      input: [
        { type: 'user_input', content: 'q' },
        { type: 'model_output', content: 'a' },
      ],
      turns: [['user', 'q'], ['assistant', 'a']],
    },
  ];

  for (const shape of SHAPES) {
    it(`reads ${shape.name} the same way on both doors`, () => {
      assert.deepEqual(openaiTurns(shape.input), shape.turns, 'the openai door');
      assert.deepEqual(geminiTurns(shape.input), shape.turns, 'the gemini door');
    });
  }
});

describe('a shape neither door can express is refused by name on both', () => {
  it('names the step, and which door refused it', () => {
    // `google_maps_call` is a step type in the SDK's `Step` union and a Content
    // type in neither OpenAI dialect — so both doors refuse it, and both name the
    // element rather than the array.
    const input = [{ type: 'google_maps_call', id: 'x', arguments: {} }];

    assert.throws(
      () => convertGeminiInteractionsToOpenAI({ model: 'm', input }),
      (error: any) => error.name === 'ValidationError' && /google_maps_call/.test(error.message)
        && /Completions/.test(error.message),
    );
    assert.throws(
      () => convertInteractionsToGenerateContent({ model: 'm', input }),
      (error: Error) => error.name === 'ValidationError' && /google_maps_call/.test(error.message)
        && /generateContent/.test(error.message),
    );
  });
});
