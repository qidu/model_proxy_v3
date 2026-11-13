/**
 * `/v1/interactions` request-level fields, carried end to end by the real handler.
 *
 * `tests/unit/gemini-interactions-to-openai.test.ts` pins each field's mapping in the
 * two converters as pure functions. This file pins the other half: that the fields
 * survive the whole `handleOpenAIRequest` run — the `before_upstream` hook, the
 * spool/ref egress, the header handling — and appear in the bytes the upstream fetch
 * actually receives.
 *
 * Every field here is one the Interactions API declares and a Completions body can
 * spell, so all of them ride the intermediate rather than a side channel. That is the
 * point of the in-band design: an `openai-completions` upstream receives fields it
 * already has (`store`), and the `openai-responses` hop re-targets the rest. See
 * `docs/api/review-interactions-to-openai-responses-hops.md`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { handleOpenAIRequest } from '../../src/handlers/openai.js';
import { createLogger } from '../../src/utils/logger.js';

const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});
const TARGET = 'https://upstream.example/v1/responses';
const AUTH = { Authorization: 'Bearer upstream-key' };

let upstreamBodies: string[] = [];
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const sent = init?.body;
    upstreamBodies.push(
      typeof sent === 'string' ? sent : await new Response(sent as ReadableStream).text(),
    );
    // Carries both response shapes: the openai-completions row reads `choices`, the
    // openai-responses rows read `output`. Neither read is under test — the request
    // body the mock received is — but both must parse for the handler to finish.
    return new Response(JSON.stringify({
      id: 'resp_1', object: 'response', created_at: 0, status: 'completed', model: 'gemini-test',
      output: [{
        id: 'msg_1', type: 'message', status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      }],
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

after(() => { globalThis.fetch = realFetch; });

/** Send `body` to `clientPath` on `upstreamMode`; return the parsed upstream body. */
async function send(
  body: Record<string, unknown>,
  upstreamMode: string,
  clientPath = '/v1/interactions',
): Promise<Record<string, unknown>> {
  upstreamBodies = [];
  const response = await handleOpenAIRequest(
    new Request(`http://proxy${clientPath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    TARGET, AUTH, 'r-fields', 'gemini-test', ENV, LOGGER, false, undefined, upstreamMode,
  );
  await response.text();
  assert.equal(upstreamBodies.length, 1, 'the handler must have made exactly one upstream call');
  return JSON.parse(upstreamBodies[0]);
}

const minimalBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model: 'gemini-test',
  input: [{ type: 'user_input', content: 'hi' }],
  ...extra,
});

describe('/v1/interactions → openai-responses: request fields reach the upstream', () => {
  it('carries the sampling knobs as the Responses spellings', async () => {
    const upstream = await send(minimalBody({
      generation_config: { temperature: 0.3, top_p: 0.9, max_output_tokens: 1234, thinking_level: 'minimal' },
    }), 'openai-responses');

    assert.equal(upstream.temperature, 0.3);
    assert.equal(upstream.top_p, 0.9);
    // Renamed across the hop: `max_tokens` on the intermediate, `max_output_tokens` here.
    assert.equal(upstream.max_output_tokens, 1234);
    // The Completions scalar becomes the Responses nested object, and `minimal`
    // survives because the Responses effort enum has it.
    assert.deepEqual(upstream.reasoning, { effort: 'minimal' });
  });

  it('carries store, in both directions of the flag', async () => {
    assert.equal((await send(minimalBody({ store: false }), 'openai-responses')).store, false);
    assert.equal((await send(minimalBody({ store: true }), 'openai-responses')).store, true);
  });

  it('carries a JSON-schema response_format as the Responses text.format', async () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } } };
    const upstream = await send(minimalBody({ response_format: schema }), 'openai-responses');

    assert.deepEqual(upstream.text, {
      format: { type: 'json_schema', name: 'response', schema },
    });
  });

  it('carries response_mime_type application/json as the schema-less JSON mode', async () => {
    const upstream = await send(minimalBody({ response_mime_type: 'application/json' }), 'openai-responses');

    assert.deepEqual(upstream.text, { format: { type: 'json_object' } });
  });

  it('invents nothing when the client sent none of them', async () => {
    const upstream = await send(minimalBody(), 'openai-responses');

    for (const key of ['temperature', 'top_p', 'max_output_tokens', 'reasoning', 'text', 'store']) {
      assert.equal(key in upstream, false, `${key} must not be invented`);
    }
  });

  it('leaves a mime type with no JSON equivalent alone', async () => {
    const upstream = await send(minimalBody({ response_mime_type: 'text/plain' }), 'openai-responses');

    assert.equal('text' in upstream, false);
  });

  it('sends store to an openai-completions upstream too, since it is a Completions field', async () => {
    // The in-band design's deliberate consequence: `store` is declared on
    // OpenAIRequest (`docs/api/list_of_api_and_schema.md:203`), so a Completions
    // upstream receives a field it already has rather than a new wire value.
    const upstream = await send(minimalBody({ store: false, generation_config: { temperature: 0.3 } }), 'openai-completions');

    assert.equal(upstream.store, false);
    assert.equal(upstream.temperature, 0.3);
  });

  it('still does not carry them from a :generateContent body, which never declared them', async () => {
    // Pinned, not fixed: the generateContent converter has the same gap and is out of
    // this change's scope. `store` is not a generateContent field in the first place.
    const upstream = await send(
      {
        model: 'gemini-test',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        store: false,
        generation_config: { temperature: 0.3 },
      },
      'openai-responses',
      '/v1beta/models/gemini-test:generateContent',
    );

    assert.equal('store' in upstream, false);
    assert.equal('temperature' in upstream, false);
  });
});
