/**
 * Unit tests for the shared tool-shape walker (src/utils/tool-shapes.ts).
 *
 * These tests moved here from tool-judge-sidecar.test.ts when the judge and the
 * dashboard stopped each carrying their own copy of the tool-name rule. The
 * Gemini wire key is `functionDeclarations` (camelCase) — the judge previously
 * read `function_declarations`, so on a Gemini-native request it extracted no
 * tools at all, kept every tool, and logged nothing. The last test here pins
 * that spelling so the silent no-op cannot come back.
 *
 * Run with: npx tsx --test tests/unit/tool-shapes.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { extractToolRecords, toolNameOf } from '../../src/utils/tool-shapes.js';

const readTool = { name: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } };

// ---------------------------------------------------------------------------
// extractToolRecords
// ---------------------------------------------------------------------------

describe('extractToolRecords', () => {
  it('reads the Claude shape (name + input_schema)', () => {
    assert.deepEqual(extractToolRecords({ tools: [readTool] }), [
      { name: 'Read', schema: { type: 'object', properties: { path: { type: 'string' } } } },
    ]);
  });

  it('reads the OpenAI shape (type: function)', () => {
    const tools = [{ type: 'function', function: { name: 'grep', parameters: { type: 'object' } } }];
    assert.deepEqual(extractToolRecords({ tools }), [{ name: 'grep', schema: { type: 'object' } }]);
  });

  it('reads an OpenAI-shaped entry that omits the type tag', () => {
    // Not gated on type === 'function': an entry that names a function is a
    // tool, and skipping it dropped it from the judge and the dashboard alike.
    const tools = [{ function: { name: 'grep', parameters: { type: 'object' } } }];
    assert.deepEqual(extractToolRecords({ tools }), [{ name: 'grep', schema: { type: 'object' } }]);
  });

  it('reads the flat Responses shape (name + parameters)', () => {
    const tools = [{ name: 'grep', parameters: { type: 'object', properties: { q: {} } } }];
    assert.deepEqual(extractToolRecords({ tools }), [
      { name: 'grep', schema: { type: 'object', properties: { q: {} } } },
    ]);
  });

  it('reads every Gemini functionDeclaration in a single entry', () => {
    const tools = [
      {
        functionDeclarations: [
          { name: 'ls', parameters: { type: 'object' } },
          { name: 'cat', parameters: { type: 'object' } },
        ],
      },
    ];
    assert.deepEqual(extractToolRecords({ tools }), [
      { name: 'ls', schema: { type: 'object' } },
      { name: 'cat', schema: { type: 'object' } },
    ]);
  });

  it('prefers name over function.name, and takes the schema from the same branch', () => {
    const tools = [
      {
        name: 'flat',
        input_schema: { from: 'flat' },
        function: { name: 'nested', parameters: { from: 'nested' } },
      },
    ];
    assert.deepEqual(extractToolRecords({ tools }), [{ name: 'flat', schema: { from: 'flat' } }]);
  });

  it('does not pair a flat name with the nested schema', () => {
    const tools = [{ name: 'flat', function: { name: 'nested', parameters: { from: 'nested' } } }];
    assert.deepEqual(extractToolRecords({ tools }), [{ name: 'flat', schema: {} }]);
  });

  it('collapses duplicate names to their first occurrence, preserving order', () => {
    const tools = [
      { name: 'b', input_schema: { first: true } },
      { name: 'a', input_schema: {} },
      { name: 'b', input_schema: { first: false } },
    ];
    const found = extractToolRecords({ tools });
    assert.deepEqual(found.map((t) => t.name), ['b', 'a']);
    assert.deepEqual(found[0].schema, { first: true });
  });

  it('defaults a missing or non-object schema to {}', () => {
    assert.deepEqual(extractToolRecords({ tools: [{ name: 'bare' }] }), [{ name: 'bare', schema: {} }]);
    assert.deepEqual(extractToolRecords({ tools: [{ name: 'odd', input_schema: 'nope' }] }), [
      { name: 'odd', schema: {} },
    ]);
  });

  it('keeps names untrimmed (trimming is left to the callers)', () => {
    assert.deepEqual(extractToolRecords({ tools: [{ name: ' Read ' }] }), [
      { name: ' Read ', schema: {} },
    ]);
  });

  it('skips malformed entries and returns [] when tools is absent or not an array', () => {
    assert.deepEqual(extractToolRecords({}), []);
    assert.deepEqual(extractToolRecords(undefined), []);
    assert.deepEqual(extractToolRecords({ tools: 'Read' }), []);
    assert.deepEqual(
      extractToolRecords({ tools: [null, 42, { type: 'function' }, { name: '' }] }),
      [],
    );
  });

  it('reads the camelCase Gemini key, not the snake_case one', () => {
    const camel = { tools: [{ functionDeclarations: [{ name: 'ls', parameters: { type: 'object' } }] }] };
    assert.deepEqual(extractToolRecords(camel), [{ name: 'ls', schema: { type: 'object' } }]);

    // Gemini's real wire format is camelCase; a snake_case body is not a shape
    // the proxy ever forwards, so it names no tools (and callers report that).
    const snake = { tools: [{ function_declarations: [{ name: 'ls', parameters: { type: 'object' } }] }] };
    assert.deepEqual(extractToolRecords(snake), []);
  });

  it('skips a Gemini declaration with no usable name but keeps its siblings', () => {
    const tools = [
      { functionDeclarations: [{ parameters: { type: 'object' } }, { name: 'cat' }, { name: '' }] },
    ];
    assert.deepEqual(extractToolRecords({ tools }), [{ name: 'cat', schema: {} }]);
  });
});

// ---------------------------------------------------------------------------
// toolNameOf
// ---------------------------------------------------------------------------

describe('toolNameOf', () => {
  it('returns the Claude/flat name', () => {
    assert.equal(toolNameOf({ name: 'Read', input_schema: {} }), 'Read');
    assert.equal(toolNameOf({ name: 'Read', parameters: {} }), 'Read');
  });

  it('falls back to function.name', () => {
    assert.equal(toolNameOf({ type: 'function', function: { name: 'grep' } }), 'grep');
  });

  it('prefers name over function.name', () => {
    assert.equal(toolNameOf({ name: 'flat', function: { name: 'nested' } }), 'flat');
  });

  it('returns undefined for an unnamed, malformed or Gemini-wrapper entry', () => {
    assert.equal(toolNameOf(null), undefined);
    assert.equal(toolNameOf(42), undefined);
    assert.equal(toolNameOf({ name: '' }), undefined);
    assert.equal(toolNameOf({ type: 'function' }), undefined);
    assert.equal(toolNameOf({ function: { name: '' } }), undefined);
    assert.equal(toolNameOf({ functionDeclarations: [{ name: 'ls' }] }), undefined);
  });

  it('does not trim — a padded name comes back padded', () => {
    assert.equal(toolNameOf({ name: ' Read ' }), ' Read ');
  });
});
