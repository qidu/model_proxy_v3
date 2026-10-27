import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';
import { clearModelCache } from '../../src/handlers/models.js';
import { convertCompletionsToResponses } from '../../src/converters/completions-to-responses.js';
import type { Env } from '../../src/types/shared.js';

const realFetch = globalThis.fetch;
let tempDir = '';
let configPath = '';

function env(extra: Partial<Env> = {}): Env {
  return {
    PROXY_CONFIG_PATH: configPath,
    LOG_LEVEL: 'error',
    VERSION: 'stream-events-test',
    ...extra,
  };
}

function writeConfig(upstreamMode: string): void {
  writeFileSync(configPath, `
[models.default]
upstream_mode = "${upstreamMode}"
base_url = "https://upstream.example"
api_key = "upstream-key"
`, 'utf8');
  clearProxyConfigCache();
}

/** Mock the upstream fetch with a scripted SSE body (or a stream that errors). */
function mockUpstreamSse(chunks: string[], errorAfter = false): void {
  globalThis.fetch = (async () => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
          if (errorAfter && chunk === chunks[chunks.length - 1]) {
            controller.error(new Error('upstream boom'));
            return;
          }
        }
        if (errorAfter) {
          controller.error(new Error('upstream boom'));
          return;
        }
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
}

interface SseEvent {
  event: string;
  data: Record<string, unknown> | null; // null for the [DONE] sentinel
}

async function readSse(response: Response): Promise<SseEvent[]> {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const text = await response.text();
  const events: SseEvent[] = [];
  for (const block of text.split('\n\n')) {
    if (!block.trim()) continue;
    const eventLine = block.split('\n').find((l) => l.startsWith('event: '));
    const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
    if (dataLine?.slice(6).trim() === '[DONE]') {
      events.push({ event: '[DONE]', data: null });
      continue;
    }
    assert.ok(eventLine, `SSE block missing event field: ${block}`);
    assert.ok(dataLine, `SSE block missing data field: ${block}`);
    events.push({ event: eventLine!.slice(7), data: JSON.parse(dataLine!.slice(6)) as Record<string, unknown> });
  }
  return events;
}

function postResponses(body: Record<string, unknown>): Promise<Response> {
  return handler.fetch(new Request('http://proxy/v1/responses', {
    method: 'POST',
    headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }), env());
}

function completionsChunk(delta: Record<string, unknown>, finishReason?: string): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'm',
    choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
  })}\n\n`;
}

beforeEach(() => {
  clearProxyConfigCache();
  clearModelCache();
  tempDir = mkdtempSync(join(tmpdir(), 'mpv3-stream-events-'));
  configPath = join(tempDir, 'proxy.toml');
});

afterEach(() => {
  clearProxyConfigCache();
  clearModelCache();
  globalThis.fetch = realFetch;
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Responses SSE event shape — completions upstream', () => {
  it('emits the full content-part lifecycle and ends with response.completed', async () => {
    writeConfig('openai-completions');
    mockUpstreamSse([
      completionsChunk({ role: 'assistant' }),
      completionsChunk({ content: 'Hel' }),
      completionsChunk({ content: 'lo' }),
      completionsChunk({}, 'stop'),
      'data: [DONE]\n\n',
    ]);

    const events = await readSse(await postResponses({ model: 'test', input: 'hi', stream: true }));
    assert.deepEqual(events.map((e) => e.event), [
      'response.created',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
      '[DONE]',
    ]);

    // event: field must match the body's type field
    for (const e of events) {
      if (e.data) assert.equal(e.data.type, e.event);
    }

    const partDone = events.find((e) => e.event === 'response.content_part.done');
    assert.deepEqual(partDone?.data?.part, { type: 'output_text', text: 'Hello', annotations: [] });

    const completed = events.find((e) => e.event === 'response.completed');
    const responseObj = completed?.data?.response as Record<string, unknown>;
    assert.equal(responseObj.status, 'completed');
  });

  it('emits response.failed when the upstream stream errors mid-flight', async () => {
    writeConfig('openai-completions');
    mockUpstreamSse([
      completionsChunk({ role: 'assistant' }),
      completionsChunk({ content: 'Hel' }),
    ], true);

    const events = await readSse(await postResponses({ model: 'test', input: 'hi', stream: true }));
    const names = events.map((e) => e.event);
    assert.ok(names.includes('response.created'));
    assert.equal(names[names.length - 2], 'response.failed');
    assert.equal(names[names.length - 1], '[DONE]');

    const failed = events.find((e) => e.event === 'response.failed');
    const responseObj = failed?.data?.response as Record<string, unknown>;
    assert.equal(responseObj.status, 'failed');
    assert.deepEqual(
      { code: (responseObj.error as Record<string, unknown>).code, message: (responseObj.error as Record<string, unknown>).message },
      { code: 'server_error', message: 'upstream boom' },
    );
  });

  it('ends with response.incomplete when finish_reason is length', async () => {
    writeConfig('openai-completions');
    mockUpstreamSse([
      completionsChunk({ role: 'assistant' }),
      completionsChunk({ content: 'truncat' }),
      completionsChunk({}, 'length'),
      'data: [DONE]\n\n',
    ]);

    const events = await readSse(await postResponses({ model: 'test', input: 'hi', stream: true }));
    const names = events.map((e) => e.event);
    assert.equal(names[names.length - 2], 'response.incomplete');
    assert.equal(names[names.length - 1], '[DONE]');

    const terminal = events.find((e) => e.event === 'response.incomplete');
    const responseObj = terminal?.data?.response as Record<string, unknown>;
    assert.equal(responseObj.status, 'incomplete');
    assert.deepEqual(responseObj.incomplete_details, { reason: 'max_output_tokens' });
    const output = responseObj.output as Array<Record<string, unknown>>;
    assert.equal(output[0].status, 'incomplete');
  });
});

describe('Responses SSE event shape — anthropic upstream', () => {
  const claudeTextEvents = (stopReason: string) => [
    `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10 } } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } })}\n\n`,
    `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 5 } })}\n\n`,
    `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ];

  it('emits the full content-part lifecycle and ends with response.completed', async () => {
    writeConfig('anthropic-messages');
    mockUpstreamSse(claudeTextEvents('end_turn'));

    const events = await readSse(await postResponses({ model: 'test', input: 'hi', stream: true }));
    assert.deepEqual(events.map((e) => e.event), [
      'response.created',
      'response.output_item.added',
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
      '[DONE]',
    ]);

    const partDone = events.find((e) => e.event === 'response.content_part.done');
    assert.deepEqual(partDone?.data?.part, { type: 'output_text', text: 'Hi', annotations: [] });
  });

  it('ends with response.incomplete when stop_reason is max_tokens', async () => {
    writeConfig('anthropic-messages');
    mockUpstreamSse(claudeTextEvents('max_tokens'));

    const events = await readSse(await postResponses({ model: 'test', input: 'hi', stream: true }));
    const names = events.map((e) => e.event);
    assert.equal(names[names.length - 2], 'response.incomplete');
    assert.equal(names[names.length - 1], '[DONE]');

    const terminal = events.find((e) => e.event === 'response.incomplete');
    const responseObj = terminal?.data?.response as Record<string, unknown>;
    assert.equal(responseObj.status, 'incomplete');
    assert.deepEqual(responseObj.incomplete_details, { reason: 'max_output_tokens' });
  });

  it('emits response.failed when the upstream stream errors mid-flight', async () => {
    writeConfig('anthropic-messages');
    mockUpstreamSse([
      `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10 } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
    ], true);

    const events = await readSse(await postResponses({ model: 'test', input: 'hi', stream: true }));
    const names = events.map((e) => e.event);
    assert.equal(names[names.length - 2], 'response.failed');
    assert.equal(names[names.length - 1], '[DONE]');
  });
});

describe('Responses error envelope', () => {
  const mockUpstreamError = (status: number, message: string) => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message } }), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })) as typeof fetch;
  };

  it('forwards the upstream error body unmodified for /v1/responses upstream errors', async () => {
    writeConfig('openai-completions');
    mockUpstreamError(429, 'slow down');

    const response = await postResponses({ model: 'test', input: 'hi' });
    assert.equal(response.status, 429);
    // CRITICAL compliance: the upstream error body reaches the client verbatim
    // (Claude Code matches upstream error wording for capability-rejection
    // recovery), so the proxy does NOT rewrap it into the spec envelope.
    assert.deepEqual(await response.json(), { error: { message: 'slow down' } });
    // ...but the proxy still emits the retry headers Claude Code reads.
    assert.match(response.headers.get('retry-after') ?? '', /^\d+$/);
    assert.equal(response.headers.get('x-should-retry'), 'true');
  });

  it('forwards the upstream error body unmodified for /v1/responses upstream 400s', async () => {
    writeConfig('openai-completions');
    mockUpstreamError(400, 'bad input');

    const response = await postResponses({ model: 'test', input: 'hi' });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.message, 'bad input');
    assert.equal(body.type, undefined, 'no Anthropic top-level type field');
  });

  it('forwards the upstream error body unmodified on /v1/messages', async () => {
    writeConfig('openai-completions');
    mockUpstreamError(429, 'slow down');

    const response = await handler.fetch(new Request('http://proxy/v1/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer client-key', 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'test', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    }), env());
    assert.equal(response.status, 429);
    // Raw upstream body, not a proxy-synthesized Anthropic envelope.
    assert.deepEqual(await response.json(), { error: { message: 'slow down' } });
  });
});

describe('Responses non-streaming conversion', () => {
  it('maps finish_reason length to status incomplete', () => {
    const completions = {
      id: 'chatcmpl-1',
      created: 1,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'truncat' }, finish_reason: 'length' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    } as unknown as Parameters<typeof convertCompletionsToResponses>[0];

    const response = convertCompletionsToResponses(completions, 'm');
    assert.equal(response.status, 'incomplete');
    assert.deepEqual(response.incomplete_details, { reason: 'max_output_tokens' });
    assert.equal(response.output[0].status, 'incomplete');
    const content = response.output[0].content as Array<Record<string, unknown>>;
    assert.deepEqual(content[0].annotations, []);
  });

  it('keeps status completed for a normal stop', () => {
    const completions = {
      id: 'chatcmpl-2',
      created: 1,
      model: 'm',
      choices: [{ index: 0, message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    } as unknown as Parameters<typeof convertCompletionsToResponses>[0];

    const response = convertCompletionsToResponses(completions, 'm');
    assert.equal(response.status, 'completed');
    assert.equal(response.incomplete_details, undefined);
  });
});

describe('allowed_tools enforcement — streaming (spec item 3)', () => {
  const tools = [
    { type: 'function', name: 'allowed_fn', parameters: { type: 'object', properties: {} } },
    { type: 'function', name: 'blocked_fn', parameters: { type: 'object', properties: {} } },
  ];
  const toolChoice = { type: 'allowed_tools', tools: [{ type: 'function', name: 'allowed_fn' }] };

  it('suppresses a disallowed tool call entirely — no events, no output entry', async () => {
    writeConfig('openai-completions');
    mockUpstreamSse([
      completionsChunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'allowed_fn', arguments: '{}' } }] }),
      completionsChunk({ tool_calls: [{ index: 1, id: 'c2', type: 'function', function: { name: 'blocked_fn', arguments: '{}' } }] }),
      completionsChunk({}, 'tool_calls'),
      'data: [DONE]\n\n',
    ]);

    const events = await readSse(await postResponses({
      model: 'test', input: 'hi', stream: true, tools, tool_choice: toolChoice,
    }));

    const itemAdded = events.filter((e) => e.event === 'response.output_item.added');
    assert.equal(itemAdded.length, 1, 'only the allowed call is announced');
    assert.equal((itemAdded[0].data?.item as Record<string, unknown>).name, 'allowed_fn');

    const completed = events.find((e) => e.event === 'response.completed');
    const output = (completed?.data?.response as Record<string, unknown>).output as Array<Record<string, unknown>>;
    assert.deepEqual(output.map((it) => it.name), ['allowed_fn']);
  });

  it('translates the tool_choice form to auto on the upstream request', async () => {
    writeConfig('openai-completions');
    let upstreamBody: Record<string, unknown> = {};
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      upstreamBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({
        id: 'chatcmpl-1', object: 'chat.completion', created: 1, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;

    const response = await postResponses({ model: 'test', input: 'hi', tools, tool_choice: toolChoice });
    assert.equal(response.status, 200);
    assert.equal(upstreamBody.tool_choice, 'auto');
    assert.equal(upstreamBody.allowed_tools, undefined, 'Responses-only field never reaches the upstream');
    assert.deepEqual(
      (upstreamBody.tools as Array<Record<string, unknown>>).map((t) => (t.function as Record<string, unknown>).name),
      ['allowed_fn', 'blocked_fn'],
      'full tools list still goes upstream',
    );
  });

  it('suppresses a disallowed tool_use block on the anthropic path', async () => {
    writeConfig('anthropic-messages');
    mockUpstreamSse([
      `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10 } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'blocked_fn' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ]);

    const events = await readSse(await postResponses({
      model: 'test', input: 'hi', stream: true, tools, tool_choice: toolChoice,
    }));

    assert.ok(!events.some((e) => e.event === 'response.function_call_arguments.delta'), 'no argument deltas for the suppressed call');
    const completed = events.find((e) => e.event === 'response.completed');
    const output = (completed?.data?.response as Record<string, unknown>).output as Array<Record<string, unknown>>;
    assert.ok(!output.some((it) => it.type === 'function_call'), 'suppressed call never appears in output');
    assert.equal(output[0].type, 'message', 'fallback direct-reply message keeps output non-empty');
    // The fallback message is announced with a full lifecycle, not just in the payload
    assert.ok(events.some((e) => e.event === 'response.output_item.added'
      && (e.data?.item as Record<string, unknown>).type === 'message'));
    assert.ok(events.some((e) => e.event === 'response.output_item.done'
      && (e.data?.item as Record<string, unknown>).type === 'message'));
  });
});

describe('synthesized item lifecycle (spec item 8)', () => {
  it('announces the reasoning item with a full lifecycle before the message item', async () => {
    writeConfig('openai-completions');
    mockUpstreamSse([
      completionsChunk({ role: 'assistant' }),
      completionsChunk({ reasoning_content: 'thinking ' }),
      completionsChunk({ reasoning_content: 'hard' }),
      completionsChunk({ content: 'answer' }),
      completionsChunk({}, 'stop'),
      'data: [DONE]\n\n',
    ]);

    const events = await readSse(await postResponses({ model: 'test', input: 'hi', stream: true }));
    assert.deepEqual(events.map((e) => e.event), [
      'response.created',
      'response.output_item.added',   // reasoning
      'response.content_part.added',  // reasoning_text
      'response.content_part.done',   // reasoning closes before text opens
      'response.output_item.done',
      'response.output_item.added',   // message
      'response.content_part.added',
      'response.output_text.delta',
      'response.output_text.done',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
      '[DONE]',
    ]);

    const reasoningAdded = events[1];
    assert.equal((reasoningAdded.data?.item as Record<string, unknown>).type, 'reasoning');
    assert.equal(reasoningAdded.data?.output_index, 0);
    const reasoningDone = events.find((e) => e.event === 'response.output_item.done'
      && (e.data?.item as Record<string, unknown>).type === 'reasoning');
    assert.deepEqual((reasoningDone?.data?.item as Record<string, unknown>).content,
      [{ type: 'reasoning_text', text: 'thinking hard' }]);

    // Terminal output positions match the output_index the events carried
    const completed = events.find((e) => e.event === 'response.completed');
    const output = (completed?.data?.response as Record<string, unknown>).output as Array<Record<string, unknown>>;
    assert.deepEqual(output.map((it) => it.type), ['reasoning', 'message']);
  });

  it('gives the reasoning-only fallback message a full lifecycle', async () => {
    writeConfig('openai-completions');
    mockUpstreamSse([
      completionsChunk({ role: 'assistant' }),
      completionsChunk({ reasoning_content: 'only thinking' }),
      completionsChunk({}, 'stop'),
      'data: [DONE]\n\n',
    ]);

    const events = await readSse(await postResponses({ model: 'test', input: 'hi', stream: true }));
    const names = events.map((e) => e.event);
    assert.deepEqual(names, [
      'response.created',
      'response.output_item.added',   // reasoning
      'response.content_part.added',
      'response.content_part.done',
      'response.output_item.done',
      'response.output_item.added',   // fallback message
      'response.content_part.added',
      'response.content_part.done',
      'response.output_item.done',
      'response.completed',
      '[DONE]',
    ]);

    const fallbackAdded = events[5];
    assert.equal((fallbackAdded.data?.item as Record<string, unknown>).type, 'message');
    const completed = events.find((e) => e.event === 'response.completed');
    const output = (completed?.data?.response as Record<string, unknown>).output as Array<Record<string, unknown>>;
    assert.deepEqual(output.map((it) => it.type), ['reasoning', 'message']);
  });
});

describe('logprobs on deltas (spec item 13)', () => {
  it('passes upstream logprobs through on output_text.delta', async () => {
    writeConfig('openai-completions');
    const lp = [{ token: 'Hel', logprob: -0.1, bytes: [72, 101, 108], top_logprobs: [] }];
    mockUpstreamSse([
      `data: ${JSON.stringify({
        id: 'chatcmpl-1', object: 'chat.completion.chunk', model: 'm',
        choices: [{ index: 0, delta: { content: 'Hel' }, finish_reason: null, logprobs: { content: lp } }],
      })}\n\n`,
      completionsChunk({ content: 'lo' }),
      completionsChunk({}, 'stop'),
      'data: [DONE]\n\n',
    ]);

    const events = await readSse(await postResponses({ model: 'test', input: 'hi', stream: true }));
    const deltas = events.filter((e) => e.event === 'response.output_text.delta');
    assert.deepEqual(deltas[0].data?.logprobs, lp, 'upstream logprobs forwarded');
    assert.deepEqual(deltas[1].data?.logprobs, [], 'absent upstream logprobs become an empty array');
  });

  it('emits empty logprobs on the anthropic path', async () => {
    writeConfig('anthropic-messages');
    mockUpstreamSse([
      `data: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 10 } } })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })}\n\n`,
      `data: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ]);

    const events = await readSse(await postResponses({ model: 'test', input: 'hi', stream: true }));
    const delta = events.find((e) => e.event === 'response.output_text.delta');
    assert.deepEqual(delta?.data?.logprobs, []);
  });
});

describe('unknown input item types (spec item 12)', () => {
  it('fails the request with a 400 spec-envelope error instead of dropping the item', async () => {
    writeConfig('openai-completions');
    // No upstream mock: the request must fail before any upstream call.
    globalThis.fetch = (async () => { throw new Error('upstream must not be called'); }) as typeof fetch;

    const response = await postResponses({
      model: 'test',
      input: [{ type: 'computer_call_output', id: 'x1', call_id: 'c1', output: {} }],
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.type, 'invalid_request');
    assert.match(body.error.message, /computer_call_output/);
  });
});
