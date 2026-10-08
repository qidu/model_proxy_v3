/**
 * Unit tests for the stateful Responses API mode (CONVERSATION_STATE=true).
 *
 * Covers the three layers of src/handlers/responses.ts + src/utils/conversation-store.ts:
 *   1. Store layer — conversation threads, stored response objects.
 *   2. Retrieval handler — handleResponsesRetrievalRequest (GET /v1/responses/{id}
 *      and /{id}/input_items) directly.
 *   3. Request handler — handleResponsesRequest with upstreamMode
 *      'openai-completions' against a mocked fetch: previous_response_id
 *      continuation, conversation threads (string and {id} forms),
 *      mutual exclusion (400), store:false, streaming persistence, and
 *      instructions not carried across turns (Responses API spec).
 *   4. Routing layer — the full index handler: GET retrieval endpoints behind
 *      the auth-header check, and the gated-drop behavior when
 *      CONVERSATION_STATE is unset.
 *
 * Run with: npx tsx --test tests/unit/responses-conversation-state.test.ts
 * (also part of `npm run test:unit`)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';
import {
  saveConversation,
  getConversation,
  getConversationThreadItems,
  appendConversationThreadItems,
} from '../../src/utils/conversation-store.js';
import {
  handleResponsesRequest,
  handleResponsesRetrievalRequest,
} from '../../src/handlers/responses.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STATE_ENV = { CONVERSATION_STATE: 'true', LOG_LEVEL: 'error' } as Record<string, string>;
const NO_STATE_ENV = { LOG_LEVEL: 'error' } as Record<string, string>;

/** Upstream request bodies captured by the mock fetch (parsed JSON). */
let upstreamBodies: Array<Record<string, any>> = [];

/** Upstream response to serve for the next model call. */
let upstreamResponseBody: string = '';

/** Unique per call — convertCompletionsToResponses derives the response id from it,
 *  and the conversation store is module-global, so ids must not collide across tests. */
let mockCompletionSeq = 0;
const CHAT_COMPLETION = (text: string) => JSON.stringify({
  id: `cc_${++mockCompletionSeq}`,
  object: 'chat.completion',
  created: 1234,
  model: 'test-model',
  choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
});

/** Chat Completions SSE stream yielding `text` then [DONE]. */
const CHAT_COMPLETION_SSE = (text: string) =>
  `data: ${JSON.stringify({ id: 'cc_s', model: 'test-model', choices: [{ index: 0, delta: { content: text } }] })}\n\n` +
  `data: ${JSON.stringify({ id: 'cc_s', model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n` +
  'data: [DONE]\n\n';

const realFetch = globalThis.fetch;

function installMockFetch() {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    assert.ok(init?.body, 'upstream call must carry a JSON body');
    upstreamBodies.push(JSON.parse(init.body as string));
    return new Response(upstreamResponseBody, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

function responsesRequest(body: Record<string, unknown>): Request {
  return new Request('http://proxy/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'test-key' },
    body: JSON.stringify(body),
  });
}

/** POST /v1/responses through handleResponsesRequest (openai-completions mode). */
async function postResponses(body: Record<string, unknown>, env: Record<string, string> = STATE_ENV) {
  upstreamBodies = [];
  upstreamResponseBody = CHAT_COMPLETION('pong');
  return handleResponsesRequest(
    responsesRequest(body), 'http://up.example.com/v1/chat/completions', {}, 'req', 'gpt', env as any, undefined, 'openai-completions'
  );
}

/** Extract the payload of the last `event: <name>` SSE frame with that name. */
async function sseEvent(resp: Response, name: string): Promise<Record<string, any>> {
  const text = await resp.text();
  for (const frame of text.split('\n\n')) {
    if (frame.startsWith(`event: ${name}\n`)) {
      return JSON.parse(frame.slice(`event: ${name}\n`.length).replace(/^data: /, ''));
    }
  }
  throw new Error(`no SSE event ${name} in stream:\n${text}`);
}

/** Parse an SSE stream and run the assertions on the completed response. */

function makeConfigPath(toml: string): string {
  const p = join(tmpdir(), `proxy_test_${Date.now()}_${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(p, toml, 'utf-8');
  return p;
}

const TOML = `
[models.gpt]
upstream_mode = "openai-completions"
base_url = "http://up.example.com"
api_key = "sk-test"
"gpt-*" = {}
`;

// ---------------------------------------------------------------------------
// 1. Store layer
// ---------------------------------------------------------------------------

describe('conversation-store threads', () => {
  it('accumulates items across appends in order', () => {
    appendConversationThreadItems('cv_ut_1', [{ type: 'message', role: 'user', content: 'a' }]);
    appendConversationThreadItems('cv_ut_1', [{ type: 'message', role: 'assistant', content: 'b' }]);
    const items = getConversationThreadItems('cv_ut_1');
    assert.ok(items, 'thread should exist');
    assert.equal(items.length, 2);
    assert.equal(items[0].role, 'user');
    assert.equal(items[1].role, 'assistant');
  });

  it('returns undefined for an unknown thread', () => {
    assert.equal(getConversationThreadItems('cv_ut_never'), undefined);
  });

  it('stores and returns the serialized response object', () => {
    const resp = { id: 'resp_ut_1', object: 'response', output: [] };
    saveConversation('resp_ut_1', [{ type: 'message', role: 'user', content: 'q' }], [{ type: 'message', role: 'assistant', content: 'a' }], resp);
    const entry = getConversation('resp_ut_1');
    assert.ok(entry, 'entry should exist');
    assert.equal(entry!.response, resp);
    assert.equal(entry!.inputItems.length, 1);
    assert.equal(entry!.outputItems.length, 1);
  });

  it('keeps legacy saves (no response object) backward compatible', () => {
    saveConversation('resp_ut_2', [], []);
    assert.equal(getConversation('resp_ut_2')?.response, undefined);
  });
});

// ---------------------------------------------------------------------------
// 2. Retrieval handler
// ---------------------------------------------------------------------------

describe('handleResponsesRetrievalRequest', () => {
  it('returns the stored response object', async () => {
    const resp = handleResponsesRetrievalRequest('resp_ut_1', false, 'r', STATE_ENV as any);
    assert.equal(resp.status, 200);
    assert.equal((await resp.json()).id, 'resp_ut_1');
  });

  it('returns the merged input items as response.input_items.list', async () => {
    const resp = handleResponsesRetrievalRequest('resp_ut_1', true, 'r', STATE_ENV as any);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.object, 'response.input_items.list');
    assert.equal(body.data.length, 1);
    assert.equal(body.data[0].content, 'q');
  });

  it('returns 404 for an unknown response id', () => {
    assert.equal(handleResponsesRetrievalRequest('resp_ut_missing', false, 'r', STATE_ENV as any).status, 404);
  });

  it('returns 404 when CONVERSATION_STATE is not enabled', () => {
    assert.equal(handleResponsesRetrievalRequest('resp_ut_1', false, 'r', NO_STATE_ENV as any).status, 404);
  });

  it('returns 404 for a stored entry without a response object', () => {
    assert.equal(handleResponsesRetrievalRequest('resp_ut_2', false, 'r', STATE_ENV as any).status, 404);
  });
});

// ---------------------------------------------------------------------------
// 3. Request handler (openai-completions, mocked upstream)
// ---------------------------------------------------------------------------

describe('handleAsCompletions stateful mode', () => {
  before(() => installMockFetch());
  after(() => restoreFetch());

  it('stores a plain response for retrieval and continuation', async () => {
    const resp = await postResponses({ model: 'gpt', input: 'ping' });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.output[0].content[0].text, 'pong');
    assert.equal(upstreamBodies[0].messages.length, 1, 'no history expected on first turn');
    const got = handleResponsesRetrievalRequest(body.id, false, 'r', STATE_ENV as any);
    assert.equal(got.status, 200);
    assert.equal((await got.json()).id, body.id);
  });

  it('prepends prior input+output for previous_response_id', async () => {
    const first = await (await postResponses({ model: 'gpt', input: 'q1' })).json();
    const resp = await postResponses({ model: 'gpt', input: 'q2', previous_response_id: first.id });
    assert.equal(resp.status, 200);
    const msgs = upstreamBodies[0].messages;
    // [user q1, assistant pong, user q2]
    assert.equal(msgs.length, 3);
    assert.deepEqual(msgs.map((m: any) => `${m.role}:${m.content}`), ['user:q1', 'assistant:pong', 'user:q2']);
    // stateful field must not reach the upstream
    assert.equal(upstreamBodies[0].previous_response_id, undefined);
  });

  it('does not carry instructions from the prior turn (spec: swap-in allowed)', async () => {
    const first = await (await postResponses({ model: 'gpt', instructions: 'SYS-A', input: 'q1' })).json();
    const msgs1 = upstreamBodies[0].messages;
    assert.equal(msgs1[0].role, 'system');
    assert.equal(msgs1[0].content, 'SYS-A');

    const resp = await postResponses({ model: 'gpt', instructions: 'SYS-B', input: 'q2', previous_response_id: first.id });
    assert.equal(resp.status, 200);
    const msgs2 = upstreamBodies[0].messages;
    const systemMsgs = msgs2.filter((m: any) => m.role === 'system');
    assert.equal(systemMsgs.length, 1, 'exactly one system message — prior instructions must not be re-prepended');
    assert.equal(systemMsgs[0].content, 'SYS-B');
    assert.equal(msgs2.length, 4, '[system, user q1, assistant, user q2]');
  });

  it('threads conversation items across turns (string and {id} forms) and echoes the id', async () => {
    const r1 = await postResponses({ model: 'gpt', input: 'cv1', conversation: 'cv_ut_e2e' });
    const b1 = await r1.json();
    assert.equal(b1.conversation, 'cv_ut_e2e', 'conversation id echoed in response');
    assert.equal(getConversationThreadItems('cv_ut_e2e')?.length, 2, 'new input + output appended');

    const r2 = await postResponses({ model: 'gpt', input: 'cv2', conversation: { id: 'cv_ut_e2e' } });
    assert.equal(r2.status, 200);
    const msgs = upstreamBodies[0].messages;
    assert.deepEqual(msgs.map((m: any) => `${m.role}:${m.content}`), ['user:cv1', 'assistant:pong', 'user:cv2']);
    assert.equal(getConversationThreadItems('cv_ut_e2e')?.length, 4);
  });

  it('rejects previous_response_id + conversation with 400', async () => {
    const first = await (await postResponses({ model: 'gpt', input: 'q' })).json();
    const resp = await postResponses({ model: 'gpt', input: 'x', previous_response_id: first.id, conversation: 'cv_ut_e2e' });
    assert.equal(resp.status, 400);
    assert.match(JSON.stringify(await resp.json()), /cannot be used together/);
    assert.equal(upstreamBodies.length, 0, 'rejected before any upstream call');
  });

  it('skips saving when store:false (non-streaming)', async () => {
    const resp = await postResponses({ model: 'gpt', input: 'nostore', store: false });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(getConversation(body.id), undefined);
    assert.equal(handleResponsesRetrievalRequest(body.id, false, 'r', STATE_ENV as any).status, 404);
  });

  it('persists the completed response for streaming requests', async () => {
    upstreamBodies = [];
    upstreamResponseBody = CHAT_COMPLETION_SSE('hello');
    const resp = await handleResponsesRequest(
      responsesRequest({ model: 'gpt', input: 'stream-q', stream: true }),
      'http://up.example.com/v1/chat/completions', {}, 'req', 'gpt', STATE_ENV as any, undefined, 'openai-completions'
    );
    assert.equal(resp.status, 200);
    const completed = await sseEvent(resp, 'response.completed');
    const rid: string = completed.response.id;
    assert.equal(completed.response.status, 'completed');

    // Retrieval must serve the same response object (with output items).
    const got = handleResponsesRetrievalRequest(rid, false, 'r', STATE_ENV as any);
    assert.equal(got.status, 200);
    const stored = await got.json();
    assert.equal(stored.id, rid);
    assert.equal(stored.output.length, 1, 'text message item');
    assert.equal(stored.output[0].content[0].text, 'hello');
  });

  it('skips saving for streaming store:false', async () => {
    upstreamBodies = [];
    upstreamResponseBody = CHAT_COMPLETION_SSE('bye');
    const resp = await handleResponsesRequest(
      responsesRequest({ model: 'gpt', input: 'stream-nostore', stream: true, store: false }),
      'http://up.example.com/v1/chat/completions', {}, 'req', 'gpt', STATE_ENV as any, undefined, 'openai-completions'
    );
    const completed = await sseEvent(resp, 'response.completed');
    assert.equal(getConversation(completed.response.id), undefined);
  });

  it('drops previous_response_id silently when CONVERSATION_STATE is unset', async () => {
    const resp = await postResponses({ model: 'gpt', input: 'solo', previous_response_id: 'resp_unknown' }, NO_STATE_ENV);
    assert.equal(resp.status, 200);
    assert.equal(upstreamBodies[0].messages.length, 1, 'no history prepended with state disabled');
  });
});

// ---------------------------------------------------------------------------
// 4. Routing layer (full index handler)
// ---------------------------------------------------------------------------

describe('GET /v1/responses/{id} routing', () => {
  let configPath: string;

  before(() => {
    configPath = makeConfigPath(TOML);
    installMockFetch();
  });

  after(() => {
    restoreFetch();
    unlinkSync(configPath);
    clearProxyConfigCache();
  });

  beforeEach(() => {
    clearProxyConfigCache();
    upstreamBodies = [];
    upstreamResponseBody = CHAT_COMPLETION('pong');
  });

  // Resolved per call: the describe body runs at collection time, before the
  // `before()` hook assigns configPath, so a captured object would freeze
  // PROXY_CONFIG_PATH as undefined and route every request to the default
  // (base_url-less) route.
  const stateEnv = () => ({ PROXY_CONFIG_PATH: configPath, CONVERSATION_STATE: 'true', LOG_LEVEL: 'error' });

  it('serves a stored response through the full routing + auth path', async () => {
    // Seed a stored entry via a real POST through the index handler.
    const post = await handler.fetch(responsesRequest({ model: 'gpt', input: 'route-q' }), stateEnv() as any);
    assert.equal(post.status, 200);
    const { id } = await post.json();
    assert.ok(getConversation(id), 'POST must have stored the conversation entry');

    const get = await handler.fetch(new Request(`http://proxy/v1/responses/${id}`, {
      method: 'GET',
      headers: { 'x-api-key': 'test-key' },
    }), stateEnv() as any);
    assert.equal(get.status, 200);
    assert.equal((await get.json()).id, id);
  });

  it('serves input_items through the full routing path', async () => {
    const post = await handler.fetch(responsesRequest({ model: 'gpt', input: 'route-q2' }), stateEnv() as any);
    const { id } = await post.json();
    const get = await handler.fetch(new Request(`http://proxy/v1/responses/${id}/input_items`, {
      method: 'GET',
      headers: { 'x-api-key': 'test-key' },
    }), stateEnv() as any);
    assert.equal(get.status, 200);
    const body = await get.json();
    assert.equal(body.object, 'response.input_items.list');
    assert.equal(body.data[0].content, 'route-q2');
  });

  it('requires auth headers on retrieval', async () => {
    const post = await handler.fetch(responsesRequest({ model: 'gpt', input: 'auth-q' }), stateEnv() as any);
    const { id } = await post.json();
    const get = await handler.fetch(new Request(`http://proxy/v1/responses/${id}`, { method: 'GET' }), stateEnv() as any);
    assert.equal(get.status, 401);
  });

  it('returns 404 for unknown ids through routing', async () => {
    const get = await handler.fetch(new Request('http://proxy/v1/responses/resp_route_missing', {
      method: 'GET',
      headers: { 'x-api-key': 'test-key' },
    }), stateEnv() as any);
    assert.equal(get.status, 404);
  });
});
