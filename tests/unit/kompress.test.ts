/**
 * Unit tests for utils/kompress.ts
 *
 * Covers: getKompressConfig (disabled / URL validation / env knobs),
 * shouldCompressPath (bare path, query strings, /v1beta/models prefix),
 * isCjkHeavy (CJK ranges, non-ASCII threshold, pure ASCII), and compressBody
 * (compressible ref collection — user/tool text only, system/assistant/schema
 * untouched — minChars / CJK / maxChars guards, fail-open vs fail-closed,
 * saved-chars accounting, skipped non-shrinking fragments, and the per-reason
 * reporting of every fragment the sidecar did not compress).
 *
 * The §5.7 bounded read of the sidecar's answer — the cap, the spill, §5.9 and
 * what the reasons must never contain — is covered separately in
 * `tests/unit/kompress-response-spool.test.ts`.
 *
 * Run with: npx tsx --test tests/unit/kompress.test.ts
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  getKompressConfig,
  shouldCompressPath,
  isCjkHeavy,
  compressBody,
  type KompressConfig,
} from '../../src/utils/kompress.js';

// ---------------------------------------------------------------------------
// getKompressConfig
// ---------------------------------------------------------------------------

describe('getKompressConfig', () => {
  it('returns null when KOMPRESS_URL is unset', () => {
    assert.equal(getKompressConfig({} as any), null);
  });

  it('builds defaults from a valid internal URL and strips trailing slashes', () => {
    const cfg = getKompressConfig({ KOMPRESS_URL: 'http://localhost:8900//' } as any);
    assert.ok(cfg);
    assert.equal(cfg!.url, 'http://localhost:8900');
    assert.deepEqual([...cfg!.endpoints], ['/v1/messages', '/v1/chat/completions', '/v1/responses']);
    assert.equal(cfg!.failOpen, true);
    assert.equal(cfg!.timeoutMs, 40000);
    assert.equal(cfg!.maxChars, 1024000);
    assert.equal(cfg!.keepRatio, 0.5);
    assert.equal(cfg!.minChars, 200);
    assert.equal(cfg!.maxLength, 2048);
  });

  it('rejects a non-internal sidecar host', () => {
    assert.throws(
      () => getKompressConfig({ KOMPRESS_URL: 'http://kompress.example.com' } as any),
      /localhost or a private\/LAN address/,
    );
  });

  it('rejects a non-http(s) protocol', () => {
    assert.throws(
      () => getKompressConfig({ KOMPRESS_URL: 'file://localhost' } as any),
      /must use http or https/,
    );
  });

  it('rejects an unparseable URL', () => {
    assert.throws(
      () => getKompressConfig({ KOMPRESS_URL: 'not a url' } as any),
      /not a valid URL/,
    );
  });

  it('parses endpoint list, fail-open override, and numeric knobs', () => {
    const cfg = getKompressConfig({
      KOMPRESS_URL: 'http://127.0.0.1:8900',
      KOMPRESS_ENDPOINTS: '/v1/messages, /custom',
      KOMPRESS_FAIL_OPEN: 'false',
      KOMPRESS_TIMEOUT_MS: '1500',
      KOMPRESS_MAX_CHARS: '500',
      KOMPRESS_KEEP_RATIO: '0.8',
      KOMPRESS_MIN_CHARS: '10',
    } as any);
    assert.ok(cfg);
    assert.deepEqual([...cfg!.endpoints], ['/v1/messages', '/custom']);
    assert.equal(cfg!.failOpen, false);
    assert.equal(cfg!.timeoutMs, 1500);
    assert.equal(cfg!.maxChars, 500);
    assert.equal(cfg!.keepRatio, 0.8);
    assert.equal(cfg!.minChars, 10);
  });

  it('rejects out-of-range keep ratio (>1)', () => {
    const cfg = getKompressConfig({ KOMPRESS_URL: 'http://localhost:1', KOMPRESS_KEEP_RATIO: '1.5' } as any);
    assert.equal(cfg!.keepRatio, 0.5, 'falls back to default');
  });
});

// ---------------------------------------------------------------------------
// shouldCompressPath
// ---------------------------------------------------------------------------

describe('shouldCompressPath', () => {
  const cfg = (endpoints: string[]): KompressConfig => {
    const base = getKompressConfig({ KOMPRESS_URL: 'http://localhost:8900' } as any)!;
    return { ...base, endpoints: new Set(endpoints) };
  };

  it('matches a bare configured path and ignores query strings', () => {
    const c = cfg(['/v1/messages']);
    assert.equal(shouldCompressPath(c, '/v1/messages'), true);
    assert.equal(shouldCompressPath(c, '/v1/messages?beta=true'), true);
    assert.equal(shouldCompressPath(c, '/v1/responses'), false);
  });

  it('maps /v1beta/models/{model}:generateContent to the /v1beta/models endpoint', () => {
    const c = cfg(['/v1beta/models']);
    assert.equal(shouldCompressPath(c, '/v1beta/models/gemini:generateContent'), true);
    assert.equal(shouldCompressPath(c, '/v1beta/models/gemini:streamGenerateContent?alt=sse'), true);
    assert.equal(shouldCompressPath(c, '/v1/messages'), false);
  });

  it('maps /v1/models/{model}:... to the /v1/models endpoint', () => {
    const c = cfg(['/v1/models']);
    assert.equal(shouldCompressPath(c, '/v1/models/gemini:countTokens'), true);
    // NOTE: the /v1beta/models/ and /v1/models/ prefixes are interchangeable —
    // configuring either endpoint key matches BOTH prefixed paths.
    assert.equal(shouldCompressPath(c, '/v1beta/models/gemini:generateContent'), true);
  });
});

// ---------------------------------------------------------------------------
// isCjkHeavy
// ---------------------------------------------------------------------------

describe('isCjkHeavy', () => {
  it('returns false for empty text', () => {
    assert.equal(isCjkHeavy(''), false);
  });

  it('returns false for pure ASCII', () => {
    assert.equal(isCjkHeavy('plain english text'), false);
  });

  it('immediately flags any CJK ideograph / kana / hangul / fullwidth codepoint', () => {
    assert.equal(isCjkHeavy('hello 世界'), true);
    assert.equal(isCjkHeavy('hello カタカナ'), true);
    assert.equal(isCjkHeavy('hello 한글'), true);
    assert.equal(isCjkHeavy('hello ！'), true); // fullwidth
  });

  it('flags mixed text only above the 20% non-ASCII threshold', () => {
    // 1 of 6 chars non-ASCII (~17%) → below threshold, not flagged
    assert.equal(isCjkHeavy('abcdeé'), false);
    // 3 of 6 chars non-ASCII (50%, non-CJK range) → above threshold, flagged
    assert.equal(isCjkHeavy('abcéüß'), true);
  });
});

// ---------------------------------------------------------------------------
// compressBody
// ---------------------------------------------------------------------------

describe('compressBody', () => {
  const realFetch = globalThis.fetch;
  after(() => { globalThis.fetch = realFetch; });

  const config = (over: Partial<KompressConfig> = {}): KompressConfig => ({
    ...getKompressConfig({ KOMPRESS_URL: 'http://localhost:8900' } as any)!,
    ...over,
  });

  /** English fragment above the default minChars of 200. */
  const LONG = 'lorem ipsum '.repeat(30).trim(); // ~359 chars
  const SHORTENED = LONG.slice(0, 100);

  const okSidecar = async (compressed: string) =>
    new Response(
      JSON.stringify({ compressed }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );

  it('compresses user string content and reports saved stats', async () => {
    let seen: any;
    globalThis.fetch = (async (_u: any, init: any) => {
      seen = JSON.parse(init.body);
      return okSidecar(SHORTENED);
    }) as any;

    const body = { messages: [{ role: 'user', content: LONG }] };
    const result = await compressBody(config(), body);
    assert.equal((body.messages as any)[0].content, SHORTENED);
    assert.equal(result.fragments, 1);
    assert.equal(result.savedChars, LONG.length - SHORTENED.length);
    assert.ok(result.savedPct > 0);
    // sidecar receives keep_ratio and max_length from the config
    assert.equal(seen.keep_ratio, 0.5);
    assert.equal(seen.max_length, 2048);
  });

  it('compresses only user/tool text — leaves system, assistant, and schemas untouched', async () => {
    globalThis.fetch = (async () => okSidecar(SHORTENED)) as any;
    const body = {
      system: LONG,
      messages: [
        { role: 'assistant', content: LONG },
        { role: 'tool', content: LONG },              // OpenAI tool result → compressed
        { role: 'user', content: [{ type: 'text', text: LONG }] },
      ],
      tools: [
        { name: 't', description: LONG, input_schema: { type: 'object' } },       // Anthropic description → compressed
        { type: 'function', function: { name: 'f', description: LONG } },          // OpenAI description → compressed
      ],
    };
    const result = await compressBody(config(), body);
    assert.equal(body.system, LONG, 'system prompt untouched');
    assert.equal((body.messages as any)[0].content, LONG, 'assistant content untouched');
    assert.equal((body.messages as any)[1].content, SHORTENED, 'tool result compressed');
    assert.equal((body.messages as any)[2].content[0].text, SHORTENED);
    assert.equal((body.tools as any)[0].description, SHORTENED);
    assert.equal((body.tools as any)[0].input_schema.type, 'object', 'schema untouched');
    assert.equal((body.tools as any)[1].function.description, SHORTENED);
    // 4 compressible refs: OpenAI tool msg, user text block, and both tool descriptions.
    assert.equal(result.fragments, 4);
  });

  it('compresses nested text blocks inside Anthropic tool_result content', async () => {
    globalThis.fetch = (async () => okSidecar(SHORTENED)) as any;
    const body = {
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'c', content: [{ type: 'text', text: LONG }] }],
      }],
    };
    const result = await compressBody(config(), body);
    assert.equal((body.messages as any)[0].content[0].content[0].text, SHORTENED);
    assert.equal(result.fragments, 1);
  });

  it('skips fragments below minChars', async () => {
    globalThis.fetch = (async () => okSidecar('xx')) as any;
    const body = { messages: [{ role: 'user', content: 'short text' }] };
    const result = await compressBody(config({ minChars: 200 }), body);
    assert.equal(result.fragments, 0);
    assert.equal((body.messages as any)[0].content, 'short text');
  });

  it('skips CJK-heavy fragments even when long', async () => {
    const cjk = ('这是一段中文文本。' + ' abcdefghij ').repeat(30);
    globalThis.fetch = (async () => okSidecar('compressed')) as any;
    const body = { messages: [{ role: 'user', content: cjk }] };
    const result = await compressBody(config(), body);
    assert.equal(result.fragments, 0);
    assert.equal((body.messages as any)[0].content, cjk, 'CJK fragment forwarded verbatim');
  });

  it('skips everything when combined text exceeds maxChars, and reports the limit', async () => {
    globalThis.fetch = (async () => okSidecar('xx')) as any;
    const body = { messages: [{ role: 'user', content: LONG }, { role: 'tool', content: LONG }] };
    const result = await compressBody(config({ maxChars: 100 }), body);
    assert.equal(result.fragments, 0);
    assert.equal((body.messages as any)[0].content, LONG);
    // Rule #8: the cap that suppressed the batch is reported, not a silent no-op.
    assert.deepEqual(result.uncompressed, [{
      reason: `combined text ${LONG.length * 2} chars over maxChars 100`,
      count: 2,
    }]);
  });

  it('fails open: a sidecar outage forwards the original text — and says why', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as any;
    const body = { messages: [{ role: 'user', content: LONG }] };
    const result = await compressBody(config({ failOpen: true }), body);
    assert.equal(result.fragments, 0);
    assert.equal((body.messages as any)[0].content, LONG);
    // Rule #8: failing open is not failing silently — the reason is reported.
    assert.deepEqual(result.uncompressed, [{ reason: 'sidecar unreachable: ECONNREFUSED', count: 1 }]);
  });

  it('fails closed: throws with the sidecar\'s own reason when failOpen=false', async () => {
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as any;
    const body = { messages: [{ role: 'user', content: LONG }] };
    await assert.rejects(
      compressBody(config({ failOpen: false }), body),
      /kompress sidecar unavailable: sidecar returned 500/,
    );
  });

  it('keeps the original when the sidecar result is not shorter', async () => {
    globalThis.fetch = (async () => okSidecar(LONG + 'padding')) as any;
    const body = { messages: [{ role: 'user', content: LONG }] };
    const result = await compressBody(config(), body);
    assert.equal(result.fragments, 0);
    assert.equal((body.messages as any)[0].content, LONG);
  });

  it('treats a malformed sidecar payload as a fragment failure', async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ unexpected: true }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as any;
    const body = { messages: [{ role: 'user', content: LONG }] };
    const result = await compressBody(config(), body);
    assert.equal(result.fragments, 0);
    assert.equal((body.messages as any)[0].content, LONG);
    assert.deepEqual(result.uncompressed, [{ reason: 'answer carried no "compressed" string', count: 1 }]);
  });

  it('returns zero stats when there is nothing compressible', async () => {
    const body = { model: 'x', messages: [{ role: 'assistant', content: LONG }] };
    const result = await compressBody(config(), body);
    assert.deepEqual(result, { body, fragments: 0, savedChars: 0, savedPct: 0, uncompressed: [] });
  });
});
