import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { geminiToClaudeBody } from '../../src/converters/gemini-to-claude-request.js';
import { handleOpenAIRequest } from '../../src/handlers/openai.js';
import { createLogger } from '../../src/utils/logger.js';

const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});
const TARGET = 'https://upstream.test/v1/messages';
const realFetch = globalThis.fetch;

function json(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function claudeSse(events: Array<Record<string, unknown>>): Response {
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  });
}

function parseGeminiSse(raw: string): Array<Record<string, any>> {
  return raw.split('\n\n').filter(Boolean).map(frame => {
    const data = frame.split('\n').find(line => line.startsWith('data: '));
    assert.ok(data, `frame has data: ${frame}`);
    return JSON.parse(data.slice(6));
  });
}

function generateRequest(body: Record<string, unknown>, streaming = false): Request {
  return new Request(`http://proxy/v1beta/models/client:${streaming ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function send(body: Record<string, unknown>, streaming = false): Promise<Response> {
  return handleOpenAIRequest(
    generateRequest(body, streaming), TARGET, { 'x-api-key': 'upstream-key', Authorization: 'Bearer remove-me' },
    streaming ? 'r7-stream' : 'r7-json', 'resolved-model', ENV, LOGGER,
    undefined, undefined, 'anthropic-messages',
  );
}

describe('generateContent → Claude direct request conversion', () => {
  it('carries native tools, generation controls, documents, and signed tool history', async () => {
    const body = await geminiToClaudeBody({
      model: 'client-model',
      systemInstruction: { parts: [{ text: 'be precise' }] },
      contents: [
        { role: 'user', parts: [
          { text: 'read and lookup' },
          { inlineData: { mimeType: 'application/pdf', data: 'JVBERi0=' } },
        ] },
        { role: 'model', parts: [
          { thought: true, text: 'use lookup', thoughtSignature: 'sig-1' },
          { functionCall: { id: 'call_1', name: 'lookup', args: { q: 'x' } } },
        ] },
        { role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'lookup', response: { answer: 'found' } } }] },
      ],
      tools: [
        { functionDeclarations: [
          { name: 'lookup', parameters: { type: 'OBJECT', properties: { q: { type: 'STRING' } } } },
          { name: 'other', parameters: { type: 'OBJECT' } },
        ] },
        { googleSearch: {} },
        { codeExecution: {} },
      ],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup', 'other'] } },
      generationConfig: {
        maxOutputTokens: 512, temperature: 0.2, topP: 0.8, topK: 20,
        stopSequences: ['STOP'], thinkingConfig: { thinkingLevel: 'high', includeThoughts: true, thinkingBudget: 1024 },
        responseMimeType: 'application/json', responseJsonSchema: { type: 'OBJECT', properties: { answer: { type: 'STRING' } } },
      },
    }, 'resolved-model');

    assert.equal(body.model, 'resolved-model');
    assert.equal(body.system, 'be precise');
    assert.equal(body.max_tokens, 512);
    assert.equal(body.temperature, 0.2);
    assert.equal(body.top_p, 0.8);
    assert.equal(body.top_k, 20);
    assert.deepEqual(body.stop_sequences, ['STOP']);
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 1024 });
    assert.deepEqual(body.output_config, {
      effort: 'high', format: { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } } } },
    });
    assert.deepEqual(body.tool_choice, { type: 'any' });
    assert.deepEqual(body.tools, [
      { name: 'lookup', input_schema: { type: 'object', properties: { q: { type: 'string' } } } },
      { name: 'other', input_schema: { type: 'object' } },
      { type: 'web_search_20250305', name: 'web_search' },
      { type: 'code_execution_20250522', name: 'code_execution' },
    ]);
    assert.deepEqual(body.messages, [
      { role: 'user', content: [
        { type: 'text', text: 'read and lookup' },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' } },
      ] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'use lookup', signature: 'sig-1' },
        { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '{"answer":"found"}' }] },
    ]);
    assert.equal(JSON.stringify(body).includes('tool_calls'), false);
  });

  it('adds the existing DeepSeek thinking compatibility block to unsigned tool history', async () => {
    const body = await geminiToClaudeBody({
      contents: [{ role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'lookup', args: {} } }] }],
    }, 'resolved-model');
    assert.deepEqual(body.messages[0].content[0], { type: 'thinking', thinking: '' });
  });
});

describe('R7 routed direct JSON and SSE', () => {
  afterEach(() => { globalThis.fetch = realFetch; });

  it('uses Claude tools directly and enforces the Gemini function allow-list on JSON output', async () => {
    let upstreamBody: Record<string, unknown>;
    let upstreamHeaders: Record<string, string>;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = JSON.parse(await new Response(init?.body as BodyInit).text());
      upstreamHeaders = Object.fromEntries(new Headers(init?.headers).entries());
      return json({
        id: 'msg_1', model: 'claude-upstream', stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 'checking', signature: 'claude-sig' },
          { type: 'text', text: 'calling' },
          { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
          { type: 'tool_use', id: 'call_2', name: 'other', input: {} },
        ],
        usage: { input_tokens: 8, output_tokens: 4, cache_read_input_tokens: 2 },
      });
    }) as typeof fetch;
    const response = await send({
      contents: [{ role: 'user', parts: [{ text: 'lookup' }] }],
      tools: [{ functionDeclarations: [{ name: 'lookup' }, { name: 'other' }, { name: 'third' }] }, { googleSearch: {} }],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup', 'third'] } },
      generationConfig: { maxOutputTokens: 64, temperature: 0.4 },
    });

    assert.equal(upstreamBody!.max_tokens, 64);
    assert.equal(upstreamBody!.temperature, 0.4);
    assert.deepEqual(upstreamBody!.tools, [
      { name: 'lookup', input_schema: { type: 'object', properties: {} } },
      { name: 'other', input_schema: { type: 'object', properties: {} } },
      { name: 'third', input_schema: { type: 'object', properties: {} } },
      { type: 'web_search_20250305', name: 'web_search' },
    ]);
    assert.equal(upstreamHeaders!['authorization'], undefined);
    assert.equal(upstreamHeaders!['x-api-key'], 'upstream-key');
    const answer = await response.json() as any;
    assert.deepEqual(answer.candidates[0].content.parts, [
      { thought: true, text: 'checking', thoughtSignature: 'claude-sig' },
      { text: 'calling' },
      { functionCall: { id: 'call_1', name: 'lookup', args: { q: 'x' } } },
    ]);
    assert.equal(answer.candidates[0].finishReason, 'STOP');
    assert.deepEqual(answer.usageMetadata, {
      promptTokenCount: 10, candidatesTokenCount: 4, totalTokenCount: 14, cachedContentTokenCount: 2,
    });
  });

  it('converts Claude SSE directly into signed thoughts, text, complete calls, and usage', async () => {
    globalThis.fetch = (async () => claudeSse([
      { type: 'message_start', message: { model: 'claude-upstream', content: [], usage: { input_tokens: 9, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reasoning' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-stream' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'answer' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call_1', name: 'lookup', input: {} } },
      { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"q":"x"}' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ])) as typeof fetch;
    const response = await send({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, true);
    const chunks = parseGeminiSse(await response.text());
    const parts = chunks.flatMap(chunk => chunk.candidates?.[0]?.content?.parts ?? []);
    assert.deepEqual(parts, [
      { thought: true, text: 'reasoning', thoughtSignature: 'sig-stream' },
      { text: 'answer' },
      { functionCall: { id: 'call_1', name: 'lookup', args: { q: 'x' } } },
    ]);
    assert.equal(chunks.at(-1).candidates[0].finishReason, 'STOP');
    assert.deepEqual(chunks.at(-1).usageMetadata, { promptTokenCount: 9, candidatesTokenCount: 5, totalTokenCount: 14 });
    assert.equal(chunks.some(chunk => chunk.object === 'chat.completion.chunk'), false);
  });

  it('aborts a Claude stream that ends without a terminal stop_reason', async () => {
    globalThis.fetch = (async () => claudeSse([
      { type: 'message_start', message: { content: [], usage: { input_tokens: 2, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } },
    ])) as typeof fetch;
    const response = await send({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }, true);
    await assert.rejects(() => response.text());
  });
});
