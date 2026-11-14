import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { convertGeminiGenerateContentToOpenAI, convertGeminiInteractionsToOpenAI } from '../../src/converters/gemini-to-openai.js';

/**
 * Coverage for image-part handling in the Gemini generateContent request ->
 * OpenAI Completions request converter. Gemini inline_data/inlineData parts
 * must become OpenAI image_url data-URI parts; text-only turns must keep
 * their string content (regression guard).
 */
describe('convertGeminiGenerateContentToOpenAI — image parts', () => {
  it('emits image_url data-URI parts for inline_data (snake_case)', () => {
    const req = {
      model: 'gemini',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'look' },
            { inline_data: { mime_type: 'image/png', data: 'ABC' } },
          ],
        },
      ],
    };

    const out = convertGeminiGenerateContentToOpenAI(req) as any;
    const msg = out.messages[0];
    assert.equal(msg.role, 'user');
    assert.deepEqual(msg.content, [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,ABC' } },
    ]);
  });

  it('emits image_url data-URI parts for inlineData (camelCase)', () => {
    const req = {
      model: 'gemini',
      contents: [
        {
          role: 'user',
          parts: [
            { inlineData: { mimeType: 'image/jpeg', data: 'XYZ' } },
          ],
        },
      ],
    };

    const out = convertGeminiGenerateContentToOpenAI(req) as any;
    assert.deepEqual(out.messages[0].content, [
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,XYZ' } },
    ]);
  });

  it('defaults missing mime to image/jpeg', () => {
    const req = {
      model: 'gemini',
      contents: [{ role: 'user', parts: [{ inline_data: { data: 'Q' } }] }],
    };
    const out = convertGeminiGenerateContentToOpenAI(req) as any;
    assert.equal(
      out.messages[0].content[0].image_url.url,
      'data:image/jpeg;base64,Q',
    );
  });

  it('drops an image part whose data is missing rather than emitting an empty image_url', () => {
    const req = {
      model: 'gemini',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'hi' },
            { inline_data: { mime_type: 'image/png' } }, // no data
          ],
        },
      ],
    };
    const out = convertGeminiGenerateContentToOpenAI(req) as any;
    // No image parts survived -> content stays a plain string.
    assert.equal(typeof out.messages[0].content, 'string');
    assert.equal(out.messages[0].content, 'hi');
  });

  it('keeps string content for text-only turns (regression guard)', () => {
    const req = {
      model: 'gemini',
      contents: [{ role: 'user', parts: [{ text: 'plain' }] }],
    };
    const out = convertGeminiGenerateContentToOpenAI(req) as any;
    assert.equal(out.messages[0].content, 'plain');
  });
});

describe('convertGeminiInteractionsToOpenAI — image parts', () => {
  it('preserves inline_data as image_url in the contents format branch', () => {
    const req = {
      model: 'gemini',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'look' },
            { inline_data: { mime_type: 'image/png', data: 'ABC' } },
          ],
        },
      ],
    };
    const out = convertGeminiInteractionsToOpenAI(req) as any;
    assert.equal(out.messages.length, 1);
    assert.deepEqual(out.messages[0].content, [
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,ABC' } },
    ]);
  });

  it('accepts camelCase inlineData in the contents format branch', () => {
    const req = {
      contents: [{
        role: 'user',
        parts: [{ inlineData: { mimeType: 'image/jpeg', data: 'aGVsbG8=' } }],
      }],
    };
    const out = convertGeminiInteractionsToOpenAI(req) as any;
    assert.deepEqual(out.messages[0].content, [
      { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,aGVsbG8=' } },
    ]);
  });

  it('preserves inline_data in the array-of-turns input branch', () => {
    const req = {
      model: 'gemini',
      input: [
        {
          role: 'user',
          content: [
            { text: 'see' },
            { inline_data: { mime_type: 'image/png', data: 'QUJD' } },
          ],
        },
      ],
    };
    const out = convertGeminiInteractionsToOpenAI(req) as any;
    assert.deepEqual(out.messages[0].content, [
      { type: 'text', text: 'see' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ]);
  });

  it('reads the Interactions media spelling ({type:image, data, mime_type}) in a step', () => {
    // The spelling `docs/api/interactions.md` declares for a multimodal input.
    // It was dropped: only `inline_data`/`inlineData` was read, so an
    // Interactions client's image never reached the upstream.
    const req = {
      model: 'gemini',
      input: [{
        type: 'user_input',
        content: [
          { type: 'text', text: 'see' },
          { type: 'image', data: 'QUJD', mime_type: 'image/png' },
        ],
      }],
    };
    const out = convertGeminiInteractionsToOpenAI(req) as any;
    assert.deepEqual(out.messages[0].content, [
      { type: 'text', text: 'see' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ]);
  });

  it('reads it in a bare Content[] input (one turn part list)', () => {
    const req = {
      model: 'gemini',
      input: [
        { type: 'text', text: 'see' },
        { type: 'image', data: 'QUJD', mime_type: 'image/png' },
      ],
    };
    const out = convertGeminiInteractionsToOpenAI(req) as any;
    assert.deepEqual(out.messages, [{
      role: 'user',
      content: [
        { type: 'text', text: 'see' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      ],
    }]);
  });

  it('accepts the camelCase mimeType on an Interactions media part', () => {
    const req = {
      model: 'gemini',
      input: [{ type: 'image', data: 'QUJD', mimeType: 'image/webp' }],
    };
    const out = convertGeminiInteractionsToOpenAI(req) as any;
    assert.deepEqual(out.messages[0].content, [
      { type: 'image_url', image_url: { url: 'data:image/webp;base64,QUJD' } },
    ]);
  });

  it('collapses text-only parts to a string (preserves wire shape)', () => {
    const req = {
      contents: [{
        role: 'user',
        parts: [{ text: 'hello' }, { text: 'world' }],
      }],
    };
    const out = convertGeminiInteractionsToOpenAI(req) as any;
    assert.equal(typeof out.messages[0].content, 'string');
    assert.equal(out.messages[0].content, 'helloworld');
  });

  it('preserves string content in the array-of-turns branch (TC203 regression)', () => {
    const req = {
      input: [
        { role: 'user', content: 'My name is Bob' },
        { role: 'model', content: 'Hello Bob!' },
      ],
    };
    const out = convertGeminiInteractionsToOpenAI(req) as any;
    assert.equal(out.messages[0].content, 'My name is Bob');
    assert.equal(out.messages[0].role, 'user');
    assert.equal(out.messages[1].role, 'assistant');
    assert.equal(out.messages[1].content, 'Hello Bob!');
  });
});
