/**
 * Unit tests for the POST /decision handler.
 *
 * The wire format under test is docs/api/decision/clef-schema-input.json and
 * clef-schema-output.json: request { model, state, questions, images? } and
 * response { model, answers, usage }. The proxy is a pure pass-through — it
 * validates only the top-level envelope (per-question shapes belong to the
 * upstream) and forwards the body verbatim — so the tests below check the
 * envelope validation, the `images` gate that separates the two backends, that
 * the body really is forwarded byte-for-byte, and that a bad upstream response
 * is reported as 502 rather than presented as a success.
 *
 * Run with: npx tsx --test tests/unit/decision.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import type { ProxyConfig } from '../../src/utils/config-loader.js';
import { handleDecisionRequest } from '../../src/handlers/decision.js';
import { createLogger } from '../../src/utils/logger.js';

const logger = createLogger({});
const realFetch = globalThis.fetch;

/** A [decision] config with the two required keys and test-friendly defaults. */
function proxyConfig(
  decision?: Partial<NonNullable<ProxyConfig['decision']>> | null,
): ProxyConfig {
  if (decision === null) return {} as ProxyConfig;
  return {
    decision: {
      backend: 'laya',
      url: 'http://127.0.0.1:8765/decision',
      ...decision,
    },
  } as ProxyConfig;
}

/** A minimal valid Clef request body. */
function clefBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'laya',
    state: 'the user asked to trim a log file',
    questions: { keep: { type: 'noul', instructions: 'Is this tool relevant?' } },
    ...overrides,
  });
}

/** A minimal valid Clef response body. */
function clefAnswer(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    model: 'laya',
    answers: { keep: { type: 'noul', noul: 0.83 } },
    usage: { input_tokens: 120, output_tokens: 0 },
    ...overrides,
  });
}

interface FetchCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  rawBody: string;
  signal: AbortSignal | null | undefined;
}

/** Capture the upstream calls the handler makes, answered by `respond`. */
function stubFetch(respond: (call: FetchCall, callIndex: number) => Response | Promise<Response>): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const call: FetchCall = {
      url: String(input),
      method: init?.method,
      headers,
      rawBody: String(init?.body ?? ''),
      signal: init?.signal,
    };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
}

function upstreamJson(text: string, status = 200): Response {
  return new Response(text, { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * The handler builds its abort signal from `[decision] timeout_ms`, so the
 * meaningful property is the exact delay handed to AbortSignal.timeout.
 */
function spyAbortSignalTimeout(): { delays: number[]; restore: () => void } {
  const delays: number[] = [];
  const descriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout');
  const real = AbortSignal.timeout;
  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    writable: true,
    value: (delay: number) => {
      delays.push(delay);
      return real.call(AbortSignal, delay);
    },
  });
  return {
    delays,
    restore: () => {
      if (descriptor) Object.defineProperty(AbortSignal, 'timeout', descriptor);
      else delete (AbortSignal as { timeout?: unknown }).timeout;
    },
  };
}

beforeEach(() => {
  globalThis.fetch = realFetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

// ---------------------------------------------------------------------------
// Not configured
// ---------------------------------------------------------------------------

describe('decision: [decision] not configured', () => {
  it('answers 503 and never calls an upstream when the section is absent', async () => {
    const calls = stubFetch(() => upstreamJson(clefAnswer()));
    const response = await handleDecisionRequest(clefBody(), proxyConfig(null), 'req-1', logger);

    assert.equal(response.status, 503);
    assert.equal(calls.length, 0, 'no upstream may be contacted without a configured url');
    const body = await response.json() as { error: { message: string } };
    assert.match(body.error.message, /not configured/i);
    assert.match(body.error.message, /backend/);
    assert.match(body.error.message, /url/);
  });

  it('answers 503 when backend is set but url is missing', async () => {
    const calls = stubFetch(() => upstreamJson(clefAnswer()));
    const response = await handleDecisionRequest(
      clefBody(),
      proxyConfig({ url: undefined }),
      'req-1',
      logger,
    );

    assert.equal(response.status, 503);
    assert.equal(calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Envelope validation (input)
// ---------------------------------------------------------------------------

describe('decision: request envelope validation', () => {
  it('rejects a malformed JSON body with 400 and no upstream call', async () => {
    const calls = stubFetch(() => upstreamJson(clefAnswer()));
    const response = await handleDecisionRequest('{"model":', proxyConfig(), 'req-1', logger);

    assert.equal(response.status, 400);
    const body = await response.json() as { error: { message: string } };
    assert.equal(body.error.message, 'Invalid JSON body');
    assert.equal(calls.length, 0);
  });

  it('rejects a JSON body that is not an object', async () => {
    const calls = stubFetch(() => upstreamJson(clefAnswer()));
    for (const raw of ['"a string"', '42', '[1,2]', 'null']) {
      const response = await handleDecisionRequest(raw, proxyConfig(), 'req-1', logger);
      assert.equal(response.status, 400, `expected 400 for ${raw}`);
      const body = await response.json() as { error: { message: string } };
      assert.equal(body.error.message, 'Request body must be a JSON object');
    }
    assert.equal(calls.length, 0);
  });

  it('rejects a missing or non-string model with 400 naming the field', async () => {
    const calls = stubFetch(() => upstreamJson(clefAnswer()));
    for (const model of [undefined, '', 42, null, { name: 'laya' }]) {
      const response = await handleDecisionRequest(
        clefBody({ model }),
        proxyConfig(),
        'req-1',
        logger,
      );
      assert.equal(response.status, 400, `expected 400 for model=${JSON.stringify(model)}`);
      const body = await response.json() as { error: { message: string } };
      assert.equal(body.error.message, 'Missing required field: model');
    }
    assert.equal(calls.length, 0);
  });

  it('rejects a missing state but accepts an empty object or array state', async () => {
    const calls = stubFetch(() => upstreamJson(clefAnswer()));

    for (const state of [undefined, null]) {
      const response = await handleDecisionRequest(
        clefBody({ state }),
        proxyConfig(),
        'req-1',
        logger,
      );
      assert.equal(response.status, 400, `expected 400 for state=${String(state)}`);
      const body = await response.json() as { error: { message: string } };
      assert.equal(body.error.message, 'Missing required field: state');
    }
    assert.equal(calls.length, 0, 'no upstream call for an invalid envelope');

    // {} and [] are legal "structured data" states and must reach the upstream.
    for (const state of [{}, [], '']) {
      const response = await handleDecisionRequest(
        clefBody({ state }),
        proxyConfig(),
        'req-1',
        logger,
      );
      assert.equal(response.status, 200, `expected 200 for state=${JSON.stringify(state)}`);
    }
    assert.equal(calls.length, 3);
  });

  it('rejects missing, empty, non-object and array questions with 400', async () => {
    const calls = stubFetch(() => upstreamJson(clefAnswer()));
    for (const questions of [undefined, null, {}, [], 'noul', 7]) {
      const response = await handleDecisionRequest(
        clefBody({ questions }),
        proxyConfig(),
        'req-1',
        logger,
      );
      assert.equal(response.status, 400, `expected 400 for questions=${JSON.stringify(questions)}`);
      const body = await response.json() as { error: { message: string } };
      assert.equal(body.error.message, 'Missing required field: questions (non-empty object)');
    }
    assert.equal(calls.length, 0);
  });

  it('leaves per-question shape validation to the upstream', async () => {
    // The proxy checks only the envelope. A question with an unknown `type` is
    // forwarded so the upstream (which owns the schema) reports it.
    const calls = stubFetch(() => upstreamJson(clefAnswer()));
    const response = await handleDecisionRequest(
      clefBody({ questions: { bad: { type: 'bogus' } } }),
      proxyConfig(),
      'req-1',
      logger,
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1, 'an envelope-valid question reaches the upstream unvalidated');
    assert.deepEqual(
      (JSON.parse(calls[0].rawBody) as { questions: unknown }).questions,
      { bad: { type: 'bogus' } },
    );
  });
});

// ---------------------------------------------------------------------------
// The images gate — the one place the two backends differ
// ---------------------------------------------------------------------------

describe('decision: images gate', () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';

  it('rejects images on the laya backend with 400 and no upstream call', async () => {
    const calls = stubFetch(() => upstreamJson(clefAnswer()));
    const response = await handleDecisionRequest(
      clefBody({ images: [image] }),
      proxyConfig({ backend: 'laya' }),
      'req-1',
      logger,
    );

    assert.equal(response.status, 400);
    assert.equal(calls.length, 0, 'the sidecar must not be contacted with images at all');
    const body = await response.json() as { error: { message: string } };
    assert.match(body.error.message, /not supported by the "laya" backend/i);
    assert.match(body.error.message, /cloudflare/, 'the message names the backend that does support it');
  });

  it('accepts an empty images array on the laya backend', async () => {
    const calls = stubFetch(() => upstreamJson(clefAnswer()));
    const response = await handleDecisionRequest(
      clefBody({ images: [] }),
      proxyConfig({ backend: 'laya' }),
      'req-1',
      logger,
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1, 'an empty images array carries no image');
  });

  it('forwards images untouched on the cloudflare backend', async () => {
    const calls = stubFetch(() => upstreamJson(clefAnswer()));
    const images = [image, { content_type: 'image/jpeg', base64: '/9j/4AAQ' }];
    const response = await handleDecisionRequest(
      clefBody({ images }),
      proxyConfig({ backend: 'cloudflare' }),
      'req-1',
      logger,
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.deepEqual(
      (JSON.parse(calls[0].rawBody) as { images: unknown }).images,
      images,
      'both data-URL and {content_type, base64} image forms survive the proxy',
    );
  });
});

// ---------------------------------------------------------------------------
// The "clef" spelling of the cloudflare backend
// ---------------------------------------------------------------------------

describe('decision: "clef" is an equivalent spelling of "cloudflare"', () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';

  it('forwards images on the clef backend instead of applying the laya gate', async () => {
    const calls = stubFetch(() => upstreamJson(clefAnswer()));
    const images = [image];
    const response = await handleDecisionRequest(
      clefBody({ images }),
      proxyConfig({ backend: 'clef' }),
      'req-1',
      logger,
    );

    assert.equal(response.status, 200, 'clef must not be treated as the text-only backend');
    assert.equal(calls.length, 1);
    assert.deepEqual(
      (JSON.parse(calls[0].rawBody) as { images: unknown }).images,
      images,
    );
  });

  it('uses the cloudflare timeout default, not the laya one', async () => {
    stubFetch(() => upstreamJson(clefAnswer()));
    const spy = spyAbortSignalTimeout();
    try {
      await handleDecisionRequest(clefBody(), proxyConfig({ backend: 'clef' }), 'req-1', logger);
    } finally {
      spy.restore();
    }

    assert.deepEqual(spy.delays, [30000]);
  });
});

// ---------------------------------------------------------------------------
// Upstream transport
// ---------------------------------------------------------------------------

describe('decision: upstream transport', () => {
  it('POSTs to the configured url with the body forwarded byte-for-byte', async () => {
    const calls = stubFetch(() => upstreamJson(clefAnswer()));
    // Deliberately odd whitespace and key order: the proxy must not re-encode.
    const bodyText = '{\n  "questions": {"a": {"type": "noul", "instructions": "i"}},\n  "state": "s",\n  "model": "laya"\n}';

    const response = await handleDecisionRequest(
      bodyText,
      proxyConfig({ url: 'https://clef.example.test/v1/decision' }),
      'req-1',
      logger,
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://clef.example.test/v1/decision');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].rawBody, bodyText, 'the request body is forwarded verbatim');
    assert.equal(calls[0].headers['content-type'], 'application/json');
  });

  it('sends Authorization: Bearer only when api_key is set', async () => {
    const calls = stubFetch(() => upstreamJson(clefAnswer()));

    await handleDecisionRequest(clefBody(), proxyConfig({ api_key: 'sk-test-123' }), 'req-1', logger);
    await handleDecisionRequest(clefBody(), proxyConfig({ api_key: '' }), 'req-1', logger);
    await handleDecisionRequest(clefBody(), proxyConfig(), 'req-1', logger);

    assert.equal(calls[0].headers['authorization'], 'Bearer sk-test-123');
    assert.equal(calls[1].headers['authorization'], undefined, 'an empty api_key sends no header');
    assert.equal(calls[2].headers['authorization'], undefined, 'an absent api_key sends no header');
  });

  it('returns the upstream success body verbatim with the Clef content type', async () => {
    const answerText = '{"model":"clef","answers":{},"usage":{"input_tokens":1,"output_tokens":0}}';
    stubFetch(() => upstreamJson(answerText));

    const response = await handleDecisionRequest(clefBody(), proxyConfig(), 'req-1', logger);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'application/json');
    assert.equal(response.headers.get('x-request-id'), 'req-1');
    assert.equal(await response.text(), answerText, 'the upstream body is not re-encoded');
  });

  it('forwards an upstream error status and body verbatim', async () => {
    const errorText = '{"detail":"questions must have at least 1 property"}';
    stubFetch(() => upstreamJson(errorText, 422));

    const response = await handleDecisionRequest(clefBody(), proxyConfig(), 'req-1', logger);

    assert.equal(response.status, 422);
    assert.equal(await response.text(), errorText);
    assert.equal(response.headers.get('x-request-id'), 'req-1');
  });
});

// ---------------------------------------------------------------------------
// Envelope validation (output)
// ---------------------------------------------------------------------------

describe('decision: upstream response validation', () => {
  it('reports a non-JSON upstream body as 502 Invalid upstream response', async () => {
    stubFetch(() => new Response('<html>gateway error</html>', { status: 200 }));

    const response = await handleDecisionRequest(clefBody(), proxyConfig(), 'req-1', logger);

    assert.equal(response.status, 502);
    const body = await response.json() as { error: { message: string } };
    assert.equal(body.error.message, 'Invalid upstream response');
  });

  it('reports an upstream body missing Clef envelope fields as 502', async () => {
    const incomplete = [
      clefAnswer({ model: undefined }),
      clefAnswer({ model: 7 }),
      clefAnswer({ answers: undefined }),
      clefAnswer({ answers: null }),
      clefAnswer({ answers: [] }),
      clefAnswer({ usage: undefined }),
      clefAnswer({ usage: null }),
      clefAnswer({ usage: [] }),
      // The laya sidecar's own /judge shape has no envelope at all.
      '{"decision":{"type":"noul"}}',
    ];

    for (const text of incomplete) {
      stubFetch(() => upstreamJson(text));
      const response = await handleDecisionRequest(clefBody(), proxyConfig(), 'req-1', logger);
      assert.equal(response.status, 502, `expected 502 for ${text}`);
      const body = await response.json() as { error: { message: string } };
      assert.equal(body.error.message, 'Invalid upstream response');
    }
  });

  it('accepts a minimal but complete Clef envelope', async () => {
    const text = clefAnswer({ answers: {}, usage: {} });
    stubFetch(() => upstreamJson(text));

    const response = await handleDecisionRequest(clefBody(), proxyConfig(), 'req-1', logger);

    assert.equal(response.status, 200, 'empty answers/usage objects are still a valid envelope');
    assert.equal(await response.text(), text);
  });
});

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

describe('decision: upstream timeout', () => {
  it('defaults to 5000ms for laya and 30000ms for cloudflare', async () => {
    stubFetch(() => upstreamJson(clefAnswer()));
    const spy = spyAbortSignalTimeout();
    try {
      await handleDecisionRequest(clefBody(), proxyConfig({ backend: 'laya' }), 'req-1', logger);
      await handleDecisionRequest(clefBody(), proxyConfig({ backend: 'cloudflare' }), 'req-1', logger);
    } finally {
      spy.restore();
    }

    assert.deepEqual(spy.delays, [5000, 30000]);
  });

  it('lets an explicit timeout_ms override the per-backend default', async () => {
    stubFetch(() => upstreamJson(clefAnswer()));
    const spy = spyAbortSignalTimeout();
    try {
      await handleDecisionRequest(clefBody(), proxyConfig({ timeout_ms: 250 }), 'req-1', logger);
      await handleDecisionRequest(
        clefBody(),
        proxyConfig({ backend: 'cloudflare', timeout_ms: 60000 }),
        'req-1',
        logger,
      );
    } finally {
      spy.restore();
    }

    assert.deepEqual(spy.delays, [250, 60000]);
  });

  it('passes an abort signal on every upstream call', async () => {
    const calls = stubFetch(() => upstreamJson(clefAnswer()));
    await handleDecisionRequest(clefBody(), proxyConfig(), 'req-1', logger);

    assert.ok(calls[0].signal instanceof AbortSignal, 'the upstream call is abortable');
    assert.equal(calls[0].signal?.aborted, false);
  });
});
