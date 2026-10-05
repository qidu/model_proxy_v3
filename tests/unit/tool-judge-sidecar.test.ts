/**
 * Unit tests for the tool judge sidecar client.
 *
 * The wire format under test is docs/architecture/design_tool_judge_sidecar_protocol.md:
 * request { state, questions: { <qid>: <question> } } (§2.2/§2.3) and response
 * { <qid>: <answer> } (§2.4/§2.5, a top-level map). The sidecar is fail-open, so
 * the tests below check both the decisions on the happy path AND that every
 * failure mode is reported (eraseNames stays empty, the tool lands in
 * unjudgedNames/skippedNames, and JudgeResult.error says so) rather than being
 * silently swallowed.
 *
 * Run with: npx tsx --test tests/unit/tool-judge-sidecar.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { ProxyConfig } from '../../src/utils/config-loader.js';
import {
  buildStateText,
  buildChoiceRequest,
  buildNoulRequest,
  parseChoiceResponse,
  parseNoulResponse,
  judgeTools,
  requestTimeoutMs,
  type JudgeResponse,
} from '../../src/utils/tool-judge-sidecar.js';

const realFetch = globalThis.fetch;

/** A sidecar config with everything the client reads. */
function proxyConfig(sidecar: Partial<NonNullable<ProxyConfig['tool_judge_sidecar']>>): ProxyConfig {
  return {
    tool_judge_sidecar: { judge_url: 'http://127.0.0.1:8081', ...sidecar },
  } as ProxyConfig;
}

/** Capture the fetch calls the client makes, answered by `respond`. */
function stubFetch(
  respond: (url: string, request: Record<string, unknown>, callIndex: number) => Response | Promise<Response>,
): Array<{ url: string; request: Record<string, unknown> }> {
  const calls: Array<{ url: string; request: Record<string, unknown> }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ url: String(input), request });
    return respond(String(input), request, calls.length - 1);
  }) as typeof fetch;
  return calls;
}

/**
 * A fetch that never answers, rejecting on abort instead — so the client's own
 * timeout is the only thing that ever settles the call, and the wall-clock time
 * to fail open measures the budget it was actually given.
 */
function hangingFetch(): Array<{ url: string; request: Record<string, unknown>; signal?: AbortSignal }> {
  const calls: Array<{ url: string; request: Record<string, unknown>; signal?: AbortSignal }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      request: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      signal: init?.signal ?? undefined,
    });
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  }) as typeof fetch;
  return calls;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** A §2.4 choice answer. */
function choiceAnswer(keep: number): JudgeResponse {
  return {
    decision: {
      type: 'choice',
      confidence: 0.9,
      action: { act_probability: 0.7 },
      choice: keep > 0.5 ? 'keep' : 'discard',
      probabilities: { keep, discard: 1 - keep },
    },
  };
}

/** A §2.5 noul answer. */
function noulAnswer(noul: number): JudgeResponse[string] {
  return { type: 'noul', confidence: 0.9, action: { act_probability: 0.7 }, noul };
}

const readTool = { name: 'Read', input_schema: { type: 'object', properties: { path: { type: 'string' } } } };

/** buildStateText takes the already-extracted form (name + schema), not the wire form. */
const readJudgeTool = { name: 'Read', schema: readTool.input_schema };

// ---------------------------------------------------------------------------
// buildStateText
// ---------------------------------------------------------------------------

describe('buildStateText', () => {
  it('emits the doc §4.1 sections: prompt, numbered tools, recent context', () => {
    const body = {
      messages: [
        { role: 'user', content: 'what time is it' },
        { role: 'assistant', content: [{ type: 'tool_use', name: 'clock', input: { tz: 'UTC' } }] },
        { role: 'user', content: [{ type: 'text', text: 'now trim the log' }] },
      ],
    };
    const text = buildStateText(body, [readJudgeTool]);

    const lines = text.split('\n');
    assert.equal(lines[0], 'User prompt: "now trim the log"');
    assert.equal(lines[1], '');
    assert.equal(lines[2], 'Tools to evaluate:');
    assert.ok(lines[3].startsWith('1. Read: {"type":"object"'), `schema line was: ${lines[3]}`);
    assert.ok(text.includes('Recent context:'), text);
    assert.ok(text.includes('- User: "what time is it"'), text);
    assert.ok(text.includes('- Assistant called: clock({"tz":"UTC"})'), text);
  });

  it('uses the last user message as the prompt, not the first', () => {
    const body = {
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
      ],
    };
    const text = buildStateText(body, [readJudgeTool]);
    assert.match(text, /^User prompt: "second"/);
    assert.ok(text.includes('- User: "first"'), 'the earlier message is context');
    assert.ok(!text.includes('User prompt: "first"'));
  });

  it('reads OpenAI assistant tool_calls and parses their JSON arguments', () => {
    const body = {
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ function: { name: 'grep', arguments: '{"q":"x"}' } }],
        },
        { role: 'user', content: 'again' },
      ],
    };
    assert.ok(buildStateText(body, []).includes('- Assistant called: grep({"q":"x"})'));
  });

  it('omits the context section when there is nothing to report', () => {
    const text = buildStateText({ messages: [{ role: 'user', content: 'only' }] }, [readJudgeTool]);
    assert.ok(!text.includes('Recent context:'), text);
  });

  it('truncates a schema past the token budget rather than emitting it whole', () => {
    const huge = { type: 'object', description: 'x'.repeat(1000) };
    const text = buildStateText({ messages: [{ role: 'user', content: 'p' }] }, [
      { name: 'huge', schema: huge },
    ]);
    const line = text.split('\n')[3];
    assert.ok(line.endsWith('…'), `expected truncation marker, got: ${line.slice(-40)}`);
    assert.ok(line.length < JSON.stringify(huge).length);
    assert.ok(line.length <= '1. huge: '.length + 600 + 1, 'capped at 600 chars + ellipsis');
  });

  it('caps the number of context messages and tool calls', () => {
    const messages: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10; i++) messages.push({ role: 'user', content: `msg-${i}` });
    for (let i = 0; i < 10; i++) {
      messages.push({ role: 'assistant', content: [{ type: 'tool_use', name: `tool-${i}`, input: {} }] });
    }
    messages.push({ role: 'user', content: 'the prompt' });
    const text = buildStateText({ messages }, []);

    for (const i of [0, 1, 2, 3, 4, 5, 6]) {
      assert.ok(!text.includes(`- User: "msg-${i}"`), `msg-${i} should be outside the context window`);
    }
    assert.ok(text.includes('- User: "msg-7"'));
    assert.ok(!text.includes('tool-4'), 'only the last 5 tool calls are kept');
    assert.ok(text.includes('tool-5') && text.includes('tool-9'));
  });

  it('reads Gemini native `contents`, where the assistant turn is `model` and content is `parts`', () => {
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'trim the log' }] },
        { role: 'model', parts: [{ functionCall: { name: 'clock', args: { tz: 'UTC' } } }] },
      ],
    };
    const text = buildStateText(body, [readJudgeTool]);

    assert.match(text, /^User prompt: "trim the log"/, text);
    assert.ok(text.includes('- Assistant called: clock({"tz":"UTC"})'), text);
  });

  it('keeps a trailing Gemini functionResponse turn from becoming the prompt', () => {
    const body = {
      contents: [
        { role: 'user', parts: [{ text: 'what is the weather in Paris' }] },
        { role: 'model', parts: [{ functionCall: { name: 'get_weather', args: { city: 'Paris' } } }] },
        { role: 'user', parts: [{ functionResponse: { name: 'get_weather', response: { temp: 18 } } }] },
      ],
    };
    const text = buildStateText(body, [readJudgeTool]);

    assert.match(text, /^User prompt: "what is the weather in Paris"/, text);
    assert.ok(!text.includes('User prompt: ""'), 'a tool result is not the prompt');
  });

  it('prefers `messages` when a body carries both `messages` and `contents`', () => {
    const body = {
      messages: [{ role: 'user', content: 'from messages' }],
      contents: [{ role: 'user', parts: [{ text: 'from contents' }] }],
    };
    const text = buildStateText(body, []);

    assert.match(text, /^User prompt: "from messages"/, text);
    assert.ok(!text.includes('from contents'), text);
  });
});

// ---------------------------------------------------------------------------
// Request builders
// ---------------------------------------------------------------------------

describe('buildChoiceRequest', () => {
  it('emits exactly one `decision` question with the doc criteria', () => {
    const request = buildChoiceRequest('state text');
    assert.equal(request.state, 'state text');
    assert.deepEqual(Object.keys(request.questions), ['decision']);
    assert.deepEqual(request.questions.decision, {
      type: 'choice',
      instructions: 'Should this tool be kept or discarded based on the user prompt and context?',
      criteria: ['keep', 'discard'],
    });
  });
});

describe('buildNoulRequest', () => {
  it('emits one noul question per tool, keyed by tool name', () => {
    const request = buildNoulRequest('state text', ['Read', 'grep']);
    assert.deepEqual(Object.keys(request.questions), ['Read', 'grep']);
    assert.deepEqual(request.questions.Read, { type: 'noul', instructions: 'Keep Read tool?' });
    assert.deepEqual(request.questions.grep, { type: 'noul', instructions: 'Keep grep tool?' });
  });

  it('emits no questions for an empty tool list', () => {
    assert.deepEqual(buildNoulRequest('s', []).questions, {});
  });
});

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

describe('parseChoiceResponse', () => {
  it('keeps when the keep probability is above the threshold', () => {
    const decision = parseChoiceResponse(choiceAnswer(0.75), 'Read', 0.5);
    assert.equal(decision.action, 'keep');
    assert.equal(decision.factor, 0.75);
    assert.equal(decision.toolName, 'Read');
    assert.match(decision.reason, /keep=0\.75/);
  });

  it('erases when the keep probability is below the threshold', () => {
    assert.equal(parseChoiceResponse(choiceAnswer(0.2), 'Read', 0.5).action, 'erase');
  });

  it('erases at exactly the threshold — keep requires strictly greater', () => {
    assert.equal(parseChoiceResponse(choiceAnswer(0.5), 'Read', 0.5).action, 'erase');
    assert.equal(parseChoiceResponse(choiceAnswer(0.51), 'Read', 0.5).action, 'keep');
  });

  it('throws when the response has no `decision` choice answer', () => {
    assert.throws(() => parseChoiceResponse({}, 'Read', 0.5), /Invalid choice response/);
    assert.throws(
      () => parseChoiceResponse({ decision: noulAnswer(0.9) }, 'Read', 0.5),
      /Invalid choice response/,
    );
  });

  it('treats missing probabilities as keep=0, so the tool is erased', () => {
    const decision = parseChoiceResponse(
      { decision: { type: 'choice', confidence: 0.9, action: { act_probability: 0.5 } } },
      'Read',
      0.5,
    );
    assert.equal(decision.factor, 0);
    assert.equal(decision.action, 'erase');
  });
});

describe('parseNoulResponse', () => {
  it('keeps above the threshold and erases at or below it', () => {
    const response: JudgeResponse = { Read: noulAnswer(0.8), grep: noulAnswer(0.5), ls: noulAnswer(0.1) };
    const decisions = parseNoulResponse(response, ['Read', 'grep', 'ls'], 0.5);
    assert.deepEqual(
      decisions.map((d) => [d.toolName, d.factor, d.action]),
      [
        ['Read', 0.8, 'keep'],
        ['grep', 0.5, 'erase'],
        ['ls', 0.1, 'erase'],
      ],
    );
  });

  it('keeps a tool missing from the response instead of erasing it', () => {
    const decisions = parseNoulResponse({ Read: noulAnswer(0.1) }, ['Read', 'absent'], 0.5);
    const absent = decisions[1];
    assert.deepEqual(absent, {
      toolName: 'absent',
      factor: 1.0,
      action: 'keep',
      reason: 'missing from response',
    });
  });

  it('keeps a tool whose answer is the wrong type', () => {
    const response = { Read: { type: 'choice', confidence: 0.9, action: { act_probability: 0.5 } } };
    const decisions = parseNoulResponse(response as JudgeResponse, ['Read'], 0.5);
    assert.equal(decisions[0].action, 'keep');
    assert.equal(decisions[0].reason, 'missing from response');
  });
});

// ---------------------------------------------------------------------------
// judgeTools
// ---------------------------------------------------------------------------

describe('judgeTools', () => {
  const body = {
    messages: [{ role: 'user', content: 'trim the logs' }],
    tools: [
      { name: 'Bash', input_schema: { type: 'object' } },
      { name: 'Read', input_schema: { type: 'object' } },
    ],
  };

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('does not call the sidecar when judge_url is unset', async () => {
    const calls = stubFetch(() => json({}));
    const result = await judgeTools(body, { tool_judge_sidecar: {} } as ProxyConfig, 'req-1');
    assert.deepEqual(calls, []);
    assert.deepEqual(result, {
      eraseNames: [],
      judgedNames: [],
      unjudgedNames: [],
      skippedNames: [],
      called: false,
    });
  });

  it('does not call the sidecar when the request has no tools', async () => {
    const calls = stubFetch(() => json({}));
    const result = await judgeTools({ messages: [] }, proxyConfig({}), 'req-1');
    assert.deepEqual(calls, []);
    assert.equal(result.called, false);
  });

  it('choice mode: one request per tool, each carrying only its own schema', async () => {
    const calls = stubFetch(() => json(choiceAnswer(0.9)));
    const result = await judgeTools(body, proxyConfig({ mode: 'choice' }), 'req-1');

    assert.equal(calls.length, 2, 'one request per tool in choice mode');
    assert.deepEqual(
      calls.map((c) => c.url),
      ['http://127.0.0.1:8081/judge', 'http://127.0.0.1:8081/judge'],
    );
    for (const call of calls) {
      assert.deepEqual(Object.keys(call.request.questions), ['decision']);
    }
    // Each state names its own tool and only its own tool — the point of §2.2.
    assert.match(String(calls[0].request.state), /1\. Bash:/);
    assert.ok(!String(calls[0].request.state).includes('Read:'), 'tool 2 must not leak into tool 1');
    assert.match(String(calls[1].request.state), /1\. Read:/);

    assert.deepEqual(result.judgedNames, ['Bash', 'Read']);
    assert.deepEqual(result.eraseNames, []);
    assert.equal(result.error, undefined);
  });

  it('choice mode: erases the tools the sidecar scored below the threshold', async () => {
    stubFetch((_url, request) =>
      json(choiceAnswer(String(request.state).includes('Bash') ? 0.1 : 0.9)),
    );
    const result = await judgeTools(body, proxyConfig({ mode: 'choice', threshold: 0.5 }), 'req-1');
    assert.deepEqual(result.eraseNames, ['Bash']);
    assert.deepEqual(result.judgedNames, ['Bash', 'Read'], 'both were judged; only Bash was erased');
  });

  it('choice mode: keeps every tool and reports them when the fetch fails', async () => {
    stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const result = await judgeTools(body, proxyConfig({ mode: 'choice' }), 'req-1');
    assert.deepEqual(result.eraseNames, [], 'fail open');
    assert.deepEqual(result.unjudgedNames, ['Bash', 'Read']);
    assert.deepEqual(result.judgedNames, []);
    assert.match(result.error ?? '', /judged none of 2 tools/i);
  });

  it('choice mode: a non-2xx response is unjudged, not erased', async () => {
    stubFetch(() => new Response('boom', { status: 500 }));
    const result = await judgeTools(body, proxyConfig({ mode: 'choice' }), 'req-1');
    assert.deepEqual(result.eraseNames, []);
    assert.deepEqual(result.unjudgedNames, ['Bash', 'Read']);
  });

  it('choice mode: malformed JSON is unjudged, not erased', async () => {
    stubFetch(() => new Response('{not json', { status: 200 }));
    const result = await judgeTools(body, proxyConfig({ mode: 'choice' }), 'req-1');
    assert.deepEqual(result.unjudgedNames, ['Bash', 'Read']);
    assert.deepEqual(result.eraseNames, []);
  });

  it('choice mode: reports a partial failure rather than claiming success', async () => {
    stubFetch((_url, _request, callIndex) =>
      callIndex === 0 ? json(choiceAnswer(0.1)) : json({ decision: noulAnswer(0.9) }),
    );
    const result = await judgeTools(body, proxyConfig({ mode: 'choice' }), 'req-1');
    assert.deepEqual(result.eraseNames, ['Bash']);
    assert.deepEqual(result.judgedNames, ['Bash']);
    assert.deepEqual(result.unjudgedNames, ['Read']);
    assert.match(result.error ?? '', /1 of 2 tools unjudged/);
  });

  it('noul mode: one request with a question per tool, parsed from the top-level map', async () => {
    const calls = stubFetch(() => json({ Bash: noulAnswer(0.2), Read: noulAnswer(0.9) }));
    const result = await judgeTools(body, proxyConfig({ mode: 'noul' }), 'req-1');

    assert.equal(calls.length, 1, 'noul mode batches every tool into one request');
    assert.deepEqual(Object.keys(calls[0].request.questions), ['Bash', 'Read']);
    assert.deepEqual(result.eraseNames, ['Bash']);
    assert.deepEqual(result.judgedNames, ['Bash', 'Read'], 'both were judged; only Bash was erased');
    assert.deepEqual(result.unjudgedNames, []);
    assert.deepEqual(result.rawResponse, { Bash: noulAnswer(0.2), Read: noulAnswer(0.9) });
  });

  it('noul mode: a tool the sidecar omits is reported unjudged and kept', async () => {
    stubFetch(() => json({ Bash: noulAnswer(0.1) }));
    const result = await judgeTools(body, proxyConfig({ mode: 'noul' }), 'req-1');
    assert.deepEqual(result.eraseNames, ['Bash']);
    assert.deepEqual(result.unjudgedNames, ['Read']);
    assert.match(result.error ?? '', /1 of 2 tools unjudged/);
  });

  it('caps the batch at max_batch_tools and reports the overflow as kept', async () => {
    const calls = stubFetch(() => json(choiceAnswer(0.9)));
    const manyTools = {
      messages: [{ role: 'user', content: 'x' }],
      tools: ['t1', 't2', 't3', 't4'].map((name) => ({ name, input_schema: {} })),
    };
    const result = await judgeTools(manyTools, proxyConfig({ mode: 'choice', max_batch_tools: 2 }), 'req-1');

    assert.equal(calls.length, 2, 'only the first two tools are sent');
    assert.deepEqual(result.judgedNames, ['t1', 't2']);
    assert.deepEqual(result.skippedNames, ['t3', 't4']);
    assert.deepEqual(result.eraseNames, []);
    assert.match(result.error ?? '', /2 tools over max_batch_tools=2 \(kept\)/);
  });

  it('appends /judge to the base URL but does not double it up', async () => {
    const calls = stubFetch(() => json(choiceAnswer(0.9)));
    await judgeTools(
      { tools: [{ name: 'Bash', input_schema: {} }], messages: [] },
      proxyConfig({ judge_url: 'http://127.0.0.1:8081/judge/' }),
      'req-1',
    );
    assert.deepEqual(
      calls.map((c) => c.url),
      ['http://127.0.0.1:8081/judge'],
    );
  });

  it('sends the api key as a bearer token when configured', async () => {
    const headers: Array<Record<string, string>> = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      headers.push((init?.headers ?? {}) as Record<string, string>);
      return json(choiceAnswer(0.9));
    }) as typeof fetch;

    await judgeTools(
      { tools: [{ name: 'Bash', input_schema: {} }], messages: [] },
      proxyConfig({ api_key: 'secret' }),
      'req-1',
    );
    assert.equal(headers[0].Authorization, 'Bearer secret');
  });

  it('aborts on the configured timeout and fails open', async () => {
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as typeof fetch;

    const result = await judgeTools(
      { tools: [{ name: 'Bash', input_schema: {} }], messages: [] },
      proxyConfig({ timeout_ms: 10 }),
      'req-1',
    );
    assert.equal(signal?.aborted, true, 'the timeout aborts the request');
    assert.deepEqual(result.eraseNames, []);
    assert.deepEqual(result.unjudgedNames, ['Bash']);
    assert.equal(result.called, true);
  });

  it('gives a noul batch one request whose budget covers every tool in it', async () => {
    const calls = hangingFetch();

    const tools = ['Bash', 'Read', 'Grep', 'Glob'].map((name) => ({ name, input_schema: {} }));
    const started = Date.now();
    const result = await judgeTools({ tools, messages: [] }, proxyConfig({ timeout_ms: 10, mode: 'noul' }), 'req-1');
    const elapsed = Date.now() - started;

    assert.equal(calls.length, 1, 'noul mode batches every tool into a single request');
    assert.equal(Object.keys(calls[0].request.questions as object).length, 4);
    assert.ok(elapsed >= 30, `4 tools × 10ms should hold the request open ~40ms, not ~10ms (waited ${elapsed}ms)`);
    assert.deepEqual(result.eraseNames, []);
    assert.deepEqual(result.unjudgedNames, tools.map((t) => t.name));
  });

  it('leaves a choice request on the single-question budget', async () => {
    const calls = hangingFetch();
    const started = Date.now();
    const result = await judgeTools(
      { tools: [{ name: 'Bash', input_schema: {} }, { name: 'Read', input_schema: {} }], messages: [] },
      proxyConfig({ timeout_ms: 10 }),
      'req-1',
    );
    const elapsed = Date.now() - started;

    // Choice mode asks one question per request, so each gets the plain budget.
    assert.equal(calls.length, 2, 'choice mode issues one request per tool');
    assert.ok(elapsed >= 13, `two 10ms budgets should take ~20ms (took ${elapsed}ms)`);
    assert.ok(elapsed < 60, `the per-request budget must not scale with tool count (took ${elapsed}ms)`);
    assert.deepEqual(result.eraseNames, []);
    assert.deepEqual(result.unjudgedNames, ['Bash', 'Read']);
  });
});

// ---------------------------------------------------------------------------
// requestTimeoutMs
// ---------------------------------------------------------------------------

describe('requestTimeoutMs', () => {
  const config = (timeoutMs: number) => ({
    judge_url: 'http://127.0.0.1:8081',
    timeoutMs,
    threshold: 0.5,
    mode: 'noul' as const,
    maxBatchTools: 50,
  });

  it('scales a request budget with the number of questions it carries', () => {
    assert.equal(requestTimeoutMs(config(50), 1), 50);
    assert.equal(requestTimeoutMs(config(50), 3), 150);
    assert.equal(requestTimeoutMs(config(25), 4), 100);
  });

  it('treats an empty request as one question', () => {
    assert.equal(requestTimeoutMs(config(50), 0), 50);
  });

  it('caps the total at 2000ms', () => {
    // The default worst case: 50 tools × 50ms would be 2500ms uncapped.
    assert.equal(requestTimeoutMs(config(50), 40), 2000);
    assert.equal(requestTimeoutMs(config(50), 50), 2000);
    assert.equal(requestTimeoutMs(config(50), 500), 2000);
  });

  it('does not shrink a base budget that already exceeds the cap', () => {
    // A caller who asked for 5s per question keeps it; the cap only bounds scaling.
    assert.equal(requestTimeoutMs(config(5000), 1), 5000);
    assert.equal(requestTimeoutMs(config(5000), 10), 5000);
  });
});
