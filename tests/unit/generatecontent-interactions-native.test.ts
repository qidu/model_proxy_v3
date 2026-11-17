import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateContentToInteractionsBody } from '../../src/converters/generatecontent-to-interactions-request.js';
import { handleGeminiInteractionsGenerateContentRequest } from '../../src/handlers/gemini.js';
import { createLogger } from '../../src/utils/logger.js';

const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});
const TARGET = 'https://upstream.test/v1beta/interactions';
const realFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = realFetch; });

function interaction(events?: Array<Record<string, unknown>>): Response {
  if (events) {
    return new Response(events.map(event => `event: ${event.event_type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
      status: 200, headers: { 'Content-Type': 'text/event-stream' },
    });
  }
  return new Response(JSON.stringify({
    id: 'int_1', model: 'gemini-test', status: 'completed', object: 'interaction',
    created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z',
    steps: [{ type: 'model_output', content: [{ type: 'text', text: 'native answer' }] }],
    usage: { total_input_tokens: 8, total_output_tokens: 3, total_tokens: 11 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

describe('generateContent request → native Interactions body', () => {
  it('carries contents, native tools, location, generation fields, and structured output', () => {
    const body = generateContentToInteractionsBody({
      contents: [
        { role: 'user', parts: [
          { text: 'look' },
          { inlineData: { mimeType: 'image/png', data: 'aW1n' }, mediaResolution: { level: 'MEDIA_RESOLUTION_HIGH' } },
        ] },
        { role: 'model', parts: [
          { thought: true, text: 'use lookup', thoughtSignature: 'sig-1' },
          { functionCall: { id: 'call_1', name: 'lookup', args: { q: 'x' } } },
        ] },
        { role: 'user', parts: [{ functionResponse: { id: 'call_1', name: 'lookup', response: { content: 'found' } } }] },
      ],
      systemInstruction: { parts: [{ text: 'be precise' }] },
      tools: [
        { functionDeclarations: [{ name: 'lookup', parameters: { type: 'OBJECT' } }] },
        { googleSearch: { searchTypes: { webSearch: {}, imageSearch: {} } } },
        { googleMaps: { enableWidget: true } },
        { retrieval: { vertexAiSearch: { engine: 'projects/p/engines/e', dataStoreSpecs: [{ dataStore: 'projects/p/dataStores/d' }] } } },
      ],
      toolConfig: {
        functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['lookup'] },
        retrievalConfig: { latLng: { latitude: 37.7, longitude: -122.4 } },
      },
      generationConfig: {
        maxOutputTokens: 128, temperature: 0.2, topP: 0.9, seed: 7, stopSequences: ['STOP'],
        thinkingConfig: { thinkingLevel: 'HIGH', includeThoughts: true },
        imageConfig: { aspectRatio: '16:9', imageSize: '2K' },
        responseMimeType: 'application/json', responseJsonSchema: { type: 'object' },
        responseModalities: ['TEXT', 'IMAGE'],
      },
    }, 'resolved-model');

    assert.deepEqual(body, {
      model: 'resolved-model',
      input: [
        { type: 'user_input', content: [
          { type: 'text', text: 'look' },
          { type: 'image', mime_type: 'image/png', resolution: 'high', data: 'aW1n' },
        ] },
        { type: 'thought', summary: [{ type: 'text', text: 'use lookup' }], signature: 'sig-1' },
        { type: 'function_call', id: 'call_1', name: 'lookup', arguments: { q: 'x' } },
        { type: 'function_result', call_id: 'call_1', name: 'lookup', result: 'found' },
      ],
      system_instruction: 'be precise',
      tools: [
        { type: 'function', name: 'lookup', parameters: { type: 'OBJECT' } },
        { type: 'google_search', search_types: ['web_search', 'image_search'] },
        { type: 'google_maps', enable_widget: true, latitude: 37.7, longitude: -122.4 },
        { type: 'retrieval', retrieval_types: ['vertex_ai_search'], vertex_ai_search_config: { engine: 'projects/p/engines/e', datastores: ['projects/p/dataStores/d'] } },
      ],
      generation_config: {
        temperature: 0.2, top_p: 0.9, seed: 7, max_output_tokens: 128, stop_sequences: ['STOP'],
        thinking_level: 'high', thinking_summaries: 'auto',
        image_config: { aspect_ratio: '16:9', image_size: '2K' },
        tool_choice: { allowed_tools: { mode: 'validated', tools: ['lookup'] } },
      },
      response_modalities: ['text', 'image'],
      response_format: { type: 'object' },
    });
  });
});

describe('generateContent → native gemini-interactions route', () => {
  it('sends Interactions JSON and returns generateContent JSON', async () => {
    let upstreamBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = JSON.parse(await new Response(init?.body as BodyInit).text());
      return interaction();
    }) as typeof fetch;
    const response = await handleGeminiInteractionsGenerateContentRequest(new Request('http://proxy/v1beta/models/client:generateContent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 64 } }),
    }), TARGET, { 'x-goog-api-key': 'key' }, 'generate-interactions-json', 'gemini-test', ENV, LOGGER);

    assert.equal(response.status, 200);
    assert.deepEqual(upstreamBody, {
      model: 'gemini-test',
      input: [{ type: 'user_input', content: [{ type: 'text', text: 'hi' }] }],
      generation_config: { max_output_tokens: 64 },
    });
    const answer = await response.json() as any;
    assert.equal(answer.candidates[0].content.parts[0].text, 'native answer');
    assert.deepEqual(answer.usageMetadata, { promptTokenCount: 8, candidatesTokenCount: 3, totalTokenCount: 11 });
  });

  it('converts native Interactions SSE to generateContent chunks', async () => {
    globalThis.fetch = (async () => interaction([
      { event_type: 'interaction.created', interaction: { id: 'int_stream', model: 'gemini-test', created: '2026-01-01T00:00:00.000Z' } },
      { event_type: 'step.start', index: 0, step: { type: 'model_output', content: [] } },
      { event_type: 'step.delta', index: 0, delta: { type: 'text', text: 'streamed answer' } },
      { event_type: 'step.stop', index: 0 },
      { event_type: 'interaction.completed', interaction: {
        id: 'int_stream', status: 'completed', usage: { total_input_tokens: 5, total_output_tokens: 2, total_tokens: 7 },
      } },
    ])) as typeof fetch;
    const response = await handleGeminiInteractionsGenerateContentRequest(new Request('http://proxy/v1beta/models/client:streamGenerateContent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
    }), TARGET, { 'x-goog-api-key': 'key' }, 'generate-interactions-stream', 'gemini-test', ENV, LOGGER);

    const chunks = (await response.text()).split('\n\n').filter(Boolean).map(frame => JSON.parse(frame.slice(5).trim()));
    assert.equal(chunks.find(chunk => chunk.candidates?.[0]?.content?.parts?.[0]?.text)?.candidates[0].content.parts[0].text, 'streamed answer');
    assert.equal(chunks.find(chunk => chunk.candidates?.[0]?.finishReason)?.candidates[0].finishReason, 'STOP');
    assert.deepEqual(chunks.at(-1).usageMetadata, { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 });
  });
});
