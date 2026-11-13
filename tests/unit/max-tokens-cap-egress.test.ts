/**
 * The per-entry `maxTokens` cap must fire on every egress that puts a max-output-tokens
 * field on the body.
 *
 * The cap lives inside `runHook('before_upstream')` (`applyMaxTokensCap`,
 * `src/utils/request-transform.ts`), so an egress that builds a body and posts it
 * without calling that hook accepts the cap and silently ignores it — the client's
 * `max_output_tokens` reaches the upstream unclamped. Three egresses did exactly that:
 * `messages.ts`'s two openai-responses branches and `openai.ts`'s
 * `forwardCompletionsAsAnthropicMessages`, which called no hook at all (its sibling
 * `forwardCompletionsAsOpenAIResponses` calls both).
 *
 * These cases drive the real handlers and assert on the bytes the upstream fetch
 * received, which is the only place the clamp is observable. `beta-passthrough-pairs`
 * covers the clamps themselves as a unit; this file covers the wiring.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { handleOpenAIRequest } from '../../src/handlers/openai.js';
import { handleMessagesRequest } from '../../src/handlers/messages.js';
import { createLogger } from '../../src/utils/logger.js';

const ENV = { LOG_LEVEL: 'error' } as any;
const LOGGER = createLogger({});
const TARGET = 'https://upstream.example/v1/x';
const AUTH = { Authorization: 'Bearer upstream-key' };
const CAP = 4096;

let upstreamBodies: string[] = [];
const realFetch = globalThis.fetch;

before(() => {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const sent = init?.body;
    upstreamBodies.push(
      typeof sent === 'string' ? sent : await new Response(sent as ReadableStream).text(),
    );
    // One shape that parses as a Responses body, a Chat Completions body and a Claude
    // body, so every egress under test can read its own response and finish.
    return new Response(JSON.stringify({
      id: 'resp_1', object: 'response', created_at: 0, status: 'completed', model: 'm',
      output: [{
        id: 'msg_1', type: 'message', status: 'completed', role: 'assistant',
        content: [{ type: 'output_text', text: 'ok', annotations: [] }],
      }],
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      content: [],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

after(() => { globalThis.fetch = realFetch; });

function routeFor(upstreamMode: string, maxTokens?: number) {
  return { targetUrl: TARGET, upstreamMode, transforms: [], maxTokens } as any;
}

function requestFor(path: string, body: unknown): Request {
  return new Request(`http://proxy${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** A `/v1/interactions` body asking for `maxOutputTokens` output tokens. */
const interactions = (maxOutputTokens: number) => ({
  model: 'm',
  input: [{ type: 'user_input', content: 'hi' }],
  generation_config: { max_output_tokens: maxOutputTokens },
});

/** A `/v1/messages` body asking for `maxTokens` output tokens. */
const messages = (maxTokens: number) => ({
  model: 'm', max_tokens: maxTokens, messages: [{ role: 'user', content: 'hi' }],
});

/** The max-output-tokens value the upstream actually received, in either spelling. */
async function sentMaxTokens(
  clientPath: '/v1/interactions' | '/v1/messages',
  body: Record<string, unknown>,
  upstreamMode: string,
  maxTokens?: number,
): Promise<unknown> {
  upstreamBodies = [];
  const request = requestFor(clientPath, body);
  const route = routeFor(upstreamMode, maxTokens);
  const response = clientPath === '/v1/messages'
    ? await handleMessagesRequest(request, TARGET, AUTH, 'r-cap', 'm', ENV, LOGGER, undefined, upstreamMode, route)
    : await handleOpenAIRequest(request, TARGET, AUTH, 'r-cap', 'm', ENV, LOGGER, false, undefined, upstreamMode, route);
  await response.text();
  assert.equal(upstreamBodies.length, 1, `${clientPath} → ${upstreamMode}: exactly one upstream call`);
  const sent = JSON.parse(upstreamBodies[0]);
  return sent.max_output_tokens ?? sent.max_tokens;
}

describe('per-entry maxTokens cap fires on every egress', () => {
  it('clamps /v1/interactions → openai-responses', async () => {
    assert.equal(await sentMaxTokens('/v1/interactions', interactions(32000), 'openai-responses', CAP), CAP);
  });

  it('clamps /v1/interactions → anthropic-messages', async () => {
    // The egress that called no hook at all before this change.
    assert.equal(await sentMaxTokens('/v1/interactions', interactions(32000), 'anthropic-messages', CAP), CAP);
  });

  it('clamps /v1/messages → openai-responses', async () => {
    assert.equal(await sentMaxTokens('/v1/messages', messages(32000), 'openai-responses', CAP), CAP);
  });

  it('clamps /v1/messages → anthropic-messages', async () => {
    assert.equal(await sentMaxTokens('/v1/messages', messages(32000), 'anthropic-messages', CAP), CAP);
  });

  it('passes a client value below the cap through untouched, on each egress', async () => {
    assert.equal(await sentMaxTokens('/v1/interactions', interactions(100), 'openai-responses', CAP), 100);
    assert.equal(await sentMaxTokens('/v1/interactions', interactions(100), 'anthropic-messages', CAP), 100);
    assert.equal(await sentMaxTokens('/v1/messages', messages(100), 'openai-responses', CAP), 100);
    assert.equal(await sentMaxTokens('/v1/messages', messages(100), 'anthropic-messages', CAP), 100);
  });

  it('leaves the client value alone when the route declares no cap', async () => {
    assert.equal(await sentMaxTokens('/v1/interactions', interactions(32000), 'openai-responses', undefined), 32000);
    assert.equal(await sentMaxTokens('/v1/messages', messages(32000), 'openai-responses', undefined), 32000);
  });
});
