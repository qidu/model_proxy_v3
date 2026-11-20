import { after, afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { geminiToResponsesBody } from '../../src/converters/gemini-to-responses.js';
import { responsesToGeminiBody } from '../../src/converters/responses-to-gemini-request.js';
import { handleOpenAIRequest } from '../../src/handlers/openai.js';
import { handleResponsesRequest } from '../../src/handlers/responses.js';
import { createLogger, type Logger } from '../../src/utils/logger.js';

const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});
const realFetch = globalThis.fetch;

function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    traceEnabled: false, warnings,
    trace() {}, debug() {}, info() {}, error() {},
    warn(_id: string, message: string) { warnings.push(message); },
  };
}

function json(body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function geminiSse(chunks: Array<Record<string, unknown>>): Response {
  return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join(''), {
    status: 200, headers: { 'Content-Type': 'text/event-stream' },
  });
}

function parseSse(raw: string): Array<Record<string, any>> {
  return raw.split('\n\n').filter(Boolean).filter(frame => !frame.includes('data: [DONE]')).map(frame => {
    const data = frame.split('\n').find(line => line.startsWith('data: '));
    assert.ok(data, `frame has data: ${frame}`);
    return JSON.parse(data.slice(6));
  });
}

describe('generateContent → Responses direct request conversion', () => {
  it('preserves rich history, native tools, function allow-lists, reasoning, media, and schemas', () => {
    const logger = recordingLogger();
    const body = geminiToResponsesBody({
      model: 'client-model',
      systemInstruction: { parts: [{ text: 'be precise' }] },
      contents: [
        { role: 'user', parts: [{ text: 'weather?' }] },
        { role: 'model', parts: [
          { thought: true, text: 'use both tools', thoughtSignature: 'gemini-secret' },
          { functionCall: { id: 'call_1', name: 'get_weather', args: { city: 'SF' } } },
        ] },
        { role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'get_weather', response: { temperature: 20 } } }] },
        { role: 'user', parts: [
          { text: 'read the report' },
          { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
          { inline_data: { mime_type: 'application/pdf', data: 'JVBERi0=' } },
        ] },
      ],
      tools: [
        { functionDeclarations: [
          { name: 'get_weather', parameters: { type: 'OBJECT', properties: { city: { type: 'STRING' } } } },
          { name: 'get_time', parameters: { type: 'OBJECT' } },
        ] },
        { googleSearch: {} },
        { codeExecution: {} },
      ],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['get_weather', 'get_time'] } },
      generationConfig: {
        maxOutputTokens: 256, temperature: 0.2, topP: 0.9,
        thinkingConfig: { thinkingLevel: 'high', includeThoughts: true },
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'OBJECT', properties: { answer: { type: 'STRING' } } },
        stopSequences: ['STOP'],
      },
    }, 'resolved-model', { logger, requestId: 'r6-convert' });

    assert.equal(body.model, 'resolved-model');
    assert.equal(body.instructions, 'be precise');
    assert.deepEqual(body.input, [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
      { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'use both tools' }] },
      { type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' },
      { type: 'function_call_output', call_id: 'call_1', output: '{"temperature":20}' },
      { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'read the report' },
        { type: 'input_image', image_url: 'data:image/png;base64,aW1hZ2U=' },
        { type: 'input_file', file_data: 'data:application/pdf;base64,JVBERi0=', filename: 'document' },
      ] },
    ]);
    assert.deepEqual(body.tools, [
      { type: 'function', name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } },
      { type: 'function', name: 'get_time', parameters: { type: 'object' } },
      { type: 'web_search' },
      { type: 'code_interpreter', container: { type: 'auto' } },
    ]);
    assert.deepEqual(body.tool_choice, {
      type: 'allowed_tools', mode: 'required',
      tools: [{ type: 'function', name: 'get_weather' }, { type: 'function', name: 'get_time' }],
    });
    assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' });
    assert.deepEqual(body.text, {
      format: { type: 'json_schema', name: 'response', schema: { type: 'object', properties: { answer: { type: 'string' } } } },
    });
    assert.equal(body.max_output_tokens, 256);
    assert.equal(body.stop, undefined);
    assert.ok(logger.warnings.some(message => message.includes('thoughtSignature')));
    assert.ok(logger.warnings.some(message => message.includes('stopSequences')));
    assert.equal(JSON.stringify(body).includes('"messages"'), false);
  });
});

describe('Responses → generateContent direct request conversion', () => {
  it('maps native tools, namespaces, files, reasoning, and structured output without intermediate messages', async () => {
    const body = await responsesToGeminiBody({
      model: 'client-model',
      instructions: 'be precise',
      input: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'lookup first' }] },
        { type: 'function_call', call_id: 'call_1', name: 'lookup', namespace: 'crm', arguments: '{"q":"x"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'found' },
        { type: 'message', role: 'user', content: [
          { type: 'input_text', text: 'read this' },
          { type: 'input_file', file_data: 'data:application/pdf;base64,JVBERi0=', filename: 'spec.pdf' },
        ] },
      ],
      tools: [
        { type: 'namespace', name: 'crm', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] },
        { type: 'function', name: 'other', parameters: { type: 'object' } },
        { type: 'web_search' },
        { type: 'code_interpreter', container: { type: 'auto' } },
      ],
      tool_choice: {
        type: 'allowed_tools', mode: 'required',
        tools: [{ type: 'function', name: 'lookup', namespace: 'crm' }, { type: 'function', name: 'other' }],
      },
      reasoning: { effort: 'high', summary: 'auto' },
      text: { format: { type: 'json_schema', name: 'answer', schema: { type: 'object' } } },
      max_output_tokens: 128,
    }, 'resolved-model');

    assert.equal(body.model, 'resolved-model');
    assert.deepEqual(body.systemInstruction, { parts: [{ text: 'be precise' }] });
    assert.deepEqual(body.contents, [
      { role: 'model', parts: [
        { thought: true, text: 'lookup first' },
        { functionCall: { id: 'call_1', name: 'crm_Z_lookup', args: { q: 'x' } } },
      ] },
      { role: 'user', parts: [
        { functionResponse: { id: 'call_1', name: 'crm_Z_lookup', response: { content: 'found' } } },
        { text: 'read this' },
        { inline_data: { mime_type: 'application/pdf', data: 'JVBERi0=' } },
      ] },
    ]);
    assert.deepEqual(body.tools, [
      { functionDeclarations: [
        { name: 'crm_Z_lookup', parameters: { type: 'object' } },
        { name: 'other', parameters: { type: 'object' } },
      ] },
      { googleSearch: {} },
      { codeExecution: {} },
    ]);
    assert.deepEqual(body.toolConfig, {
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['crm_Z_lookup', 'other'] },
    });
    assert.deepEqual(body.generationConfig, {
      maxOutputTokens: 128,
      thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true },
      responseMimeType: 'application/json', responseJsonSchema: { type: 'object' },
    });
    assert.equal(JSON.stringify(body).includes('__namespaceMap'), false);
    assert.equal(JSON.stringify(body).includes('"messages"'), false);
  });

  it('folds max and xhigh reasoning efforts to Gemini HIGH', async () => {
    for (const effort of ['max', 'xhigh']) {
      const body = await responsesToGeminiBody({ input: 'hi', reasoning: { effort } }, 'resolved-model');
      assert.deepEqual(body.generationConfig, { thinkingConfig: { thinkingLevel: 'HIGH' } });
    }
  });
});

describe('R4/R6 routed direct conversion', () => {
  afterEach(() => { globalThis.fetch = realFetch; });
  after(() => { globalThis.fetch = realFetch; });

  it('routes generateContent tools directly to Responses and returns direct Gemini JSON', async () => {
    let upstreamBody: Record<string, unknown>;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = JSON.parse(await new Response(init?.body as BodyInit).text());
      return json({
        id: 'resp_1', status: 'completed', model: 'gpt-upstream',
        output: [{ type: 'function_call', call_id: 'call_1', name: 'get_weather', arguments: '{"city":"SF"}' }],
        usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
      });
    }) as typeof fetch;
    const response = await handleOpenAIRequest(
      new Request('http://proxy/v1beta/models/client:generateContent', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: 'weather?' }] }],
          tools: [{ functionDeclarations: [{ name: 'get_weather', parameters: { type: 'OBJECT' } }] }, { googleSearch: {} }],
        }),
      }),
      'https://upstream.test/v1/responses', { Authorization: 'Bearer key' }, 'r6-route', 'resolved-model',
      ENV, LOGGER, false, undefined, 'openai-responses',
    );

    assert.deepEqual(upstreamBody!.tools, [
      { type: 'function', name: 'get_weather', parameters: { type: 'object' } },
      { type: 'web_search' },
    ]);
    const answer = await response.json() as any;
    assert.deepEqual(answer.candidates[0].content.parts, [
      { functionCall: { id: 'call_1', name: 'get_weather', args: { city: 'SF' } } },
    ]);
    assert.equal(answer.candidates[0].finishReason, 'STOP');
    assert.deepEqual(answer.usageMetadata, { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 });
  });

  it('routes Responses directly to Gemini JSON and restores only allowed namespaced calls', async () => {
    let upstreamUrl = '';
    let upstreamBody: Record<string, unknown>;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamUrl = String(input);
      upstreamBody = JSON.parse(await new Response(init?.body as BodyInit).text());
      return json({
        modelVersion: 'gemini-upstream',
        candidates: [{ content: { role: 'model', parts: [
          { thought: true, text: 'checking' },
          { text: 'done' },
          { functionCall: { id: 'call_1', name: 'crm_Z_lookup', args: { q: 'x' } } },
          { functionCall: { id: 'call_2', name: 'other', args: {} } },
        ] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4, thoughtsTokenCount: 2, cachedContentTokenCount: 3, totalTokenCount: 16 },
      });
    }) as typeof fetch;
    const response = await handleResponsesRequest(
      new Request('http://proxy/v1/responses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'client', input: 'lookup', tools: [
            { type: 'namespace', name: 'crm', tools: [{ type: 'function', name: 'lookup', parameters: { type: 'object' } }] },
            { type: 'function', name: 'other', parameters: { type: 'object' } },
          ],
          tool_choice: { type: 'allowed_tools', mode: 'required', tools: [{ type: 'function', name: 'lookup', namespace: 'crm' }] },
        }),
      }),
      'https://upstream.test/v1beta', { 'x-goog-api-key': 'key' }, 'r4-json', 'gemini-resolved',
      ENV, LOGGER, 'gemini-generatecontent',
    );

    assert.equal(upstreamUrl, 'https://upstream.test/v1beta/models/gemini-resolved:generateContent');
    assert.equal('stream' in upstreamBody!, false);
    assert.equal(upstreamBody!.messages, undefined);
    assert.deepEqual(upstreamBody!.toolConfig, { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['crm_Z_lookup'] } });
    const answer = await response.json() as any;
    assert.equal(answer.status, 'completed');
    assert.deepEqual(answer.output.map((item: any) => [item.type, item.name, item.namespace]), [
      ['reasoning', undefined, undefined], ['message', undefined, undefined], ['function_call', 'lookup', 'crm'],
    ]);
    assert.equal(answer.output_text, 'done');
    assert.deepEqual(answer.usage, {
      input_tokens: 10, output_tokens: 6, total_tokens: 16,
      input_tokens_details: { cached_tokens: 3 }, output_tokens_details: { reasoning_tokens: 2 },
    });
  });

  it('streams Gemini chunks directly as Responses reasoning, text, calls, and terminal usage', async () => {
    let upstreamUrl = '';
    let upstreamBody: Record<string, unknown>;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamUrl = String(input);
      upstreamBody = JSON.parse(await new Response(init?.body as BodyInit).text());
      return geminiSse([
        { candidates: [{ content: { role: 'model', parts: [{ thought: true, text: 'thinking' }] } }] },
        { candidates: [{ content: { role: 'model', parts: [{ text: 'answer' }] } }] },
        { candidates: [{ content: { role: 'model', parts: [{ functionCall: { id: 'call_1', name: 'lookup', args: { q: 'x' } } }] } }] },
        {
          candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 2, totalTokenCount: 12 },
        },
      ]);
    }) as typeof fetch;
    const response = await handleResponsesRequest(
      new Request('http://proxy/v1/responses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'client', input: 'hi', stream: true }),
      }),
      'https://upstream.test/v1beta', { 'x-goog-api-key': 'key' }, 'r4-stream', 'gemini-resolved',
      ENV, LOGGER, 'gemini-generatecontent',
    );

    assert.equal(upstreamUrl, 'https://upstream.test/v1beta/models/gemini-resolved:streamGenerateContent?alt=sse');
    assert.equal('stream' in upstreamBody!, false);
    const events = parseSse(await response.text());
    assert.equal(events[0].type, 'response.created');
    assert.ok(events.some(event => event.type === 'response.reasoning_summary_text.delta' && event.delta === 'thinking'));
    assert.ok(events.some(event => event.type === 'response.output_text.delta' && event.delta === 'answer'));
    const call = events.find(event => event.type === 'response.output_item.done' && event.item.type === 'function_call');
    assert.deepEqual(call?.item.arguments, '{"q":"x"}');
    const completed = events.at(-1);
    assert.equal(completed.type, 'response.completed');
    assert.deepEqual(completed.response.output.map((item: any) => item.type), ['reasoning', 'message', 'function_call']);
    assert.deepEqual(completed.response.usage, {
      input_tokens: 7, output_tokens: 5, total_tokens: 12,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 2 },
    });
    assert.equal(events.some(event => event.type === 'message_start'), false);
  });

  it('reports Gemini output-cap truncation as response.incomplete', async () => {
    globalThis.fetch = (async () => geminiSse([
      { candidates: [{ content: { role: 'model', parts: [{ text: 'partial' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MAX_TOKENS' }] },
    ])) as typeof fetch;
    const response = await handleResponsesRequest(
      new Request('http://proxy/v1/responses', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'client', input: 'hi', stream: true }),
      }),
      'https://upstream.test/v1beta', {}, 'r4-cut', 'gemini-resolved', ENV, LOGGER, 'gemini-generatecontent',
    );
    const events = parseSse(await response.text());
    const terminal = events.at(-1);
    assert.equal(terminal.type, 'response.incomplete');
    assert.equal(terminal.response.status, 'incomplete');
    assert.deepEqual(terminal.response.incomplete_details, { reason: 'max_output_tokens' });
  });
});
