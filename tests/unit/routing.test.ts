/**
 * Unit tests for routing helpers that can be run offline.
 *
 * Run with:
 *   npx tsx --test tests/unit/routing.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildTargetUrl, buildUpstreamUrl, getHandlerType, parseDynamicRoute, transformAuthHeadersForUpstream } from '../../src/utils/routing.js';
import { decayEffectiveCompositeShare, getEffectiveCompositeShare, recoverEffectiveCompositeShare, resetEffectiveCompositeSharesForTest } from '../../src/index.js';

describe('composite primary effective share decay', () => {
  it('halves primary share down to one tenth of configured share', () => {
    resetEffectiveCompositeSharesForTest();

    assert.deepEqual(decayEffectiveCompositeShare('alias', 'primary', 10), { previous: 10, next: 5, floor: 1 });
    assert.deepEqual(decayEffectiveCompositeShare('alias', 'primary', 10), { previous: 5, next: 2.5, floor: 1 });
    assert.deepEqual(decayEffectiveCompositeShare('alias', 'primary', 10), { previous: 2.5, next: 1.25, floor: 1 });
    assert.deepEqual(decayEffectiveCompositeShare('alias', 'primary', 10), { previous: 1.25, next: 1, floor: 1 });
    assert.deepEqual(decayEffectiveCompositeShare('alias', 'primary', 10), { previous: 1, next: 1, floor: 1 });
  });

  it('uses 0.1 as the floor when configured share defaults to 1', () => {
    resetEffectiveCompositeSharesForTest();

    let result = decayEffectiveCompositeShare('alias', 'primary', 1);
    assert.equal(result.next, 0.5);
    result = decayEffectiveCompositeShare('alias', 'primary', 1);
    assert.equal(result.next, 0.25);
    result = decayEffectiveCompositeShare('alias', 'primary', 1);
    assert.equal(result.next, 0.125);
    result = decayEffectiveCompositeShare('alias', 'primary', 1);
    assert.equal(result.next, 0.1);
    result = decayEffectiveCompositeShare('alias', 'primary', 1);
    assert.equal(result.next, 0.1);
  });

  it('keeps runtime state separate from configured share input', () => {
    resetEffectiveCompositeSharesForTest();
    const targetConfig = { share: 10, primary: true };

    decayEffectiveCompositeShare('alias', 'primary', targetConfig.share);

    assert.deepEqual(targetConfig, { share: 10, primary: true });
    assert.equal(getEffectiveCompositeShare('alias', 'primary', targetConfig.share), 5);
    assert.equal(getEffectiveCompositeShare('alias', 'other', targetConfig.share), 10);
  });
});

describe('composite fallback effective share decay', () => {
  it('halves fallback share down to one tenth of configured share', () => {
    resetEffectiveCompositeSharesForTest();

    assert.deepEqual(decayEffectiveCompositeShare('alias', 'fallback1', 10), { previous: 10, next: 5, floor: 1 });
    assert.deepEqual(decayEffectiveCompositeShare('alias', 'fallback1', 10), { previous: 5, next: 2.5, floor: 1 });
    assert.deepEqual(decayEffectiveCompositeShare('alias', 'fallback1', 10), { previous: 2.5, next: 1.25, floor: 1 });
    assert.deepEqual(decayEffectiveCompositeShare('alias', 'fallback1', 10), { previous: 1.25, next: 1, floor: 1 });
    assert.deepEqual(decayEffectiveCompositeShare('alias', 'fallback1', 10), { previous: 1, next: 1, floor: 1 });
  });

  it('uses 0.1 as the floor when configured share defaults to 1', () => {
    resetEffectiveCompositeSharesForTest();

    let result = decayEffectiveCompositeShare('alias', 'fallback1', 1);
    assert.equal(result.next, 0.5);
    result = decayEffectiveCompositeShare('alias', 'fallback1', 1);
    assert.equal(result.next, 0.25);
    result = decayEffectiveCompositeShare('alias', 'fallback1', 1);
    assert.equal(result.next, 0.125);
    result = decayEffectiveCompositeShare('alias', 'fallback1', 1);
    assert.equal(result.next, 0.1);
    result = decayEffectiveCompositeShare('alias', 'fallback1', 1);
    assert.equal(result.next, 0.1);
  });

  it('decays each fallback target independently', () => {
    resetEffectiveCompositeSharesForTest();

    decayEffectiveCompositeShare('alias', 'fallback1', 10);
    // fallback2 should be unaffected
    assert.equal(getEffectiveCompositeShare('alias', 'fallback2', 10), 10);
    assert.equal(getEffectiveCompositeShare('alias', 'fallback1', 10), 5);
  });

  it('does not affect primary decay state for the same alias', () => {
    resetEffectiveCompositeSharesForTest();

    decayEffectiveCompositeShare('alias', 'fallback1', 10);
    // primary target in the same alias should be unaffected
    assert.equal(getEffectiveCompositeShare('alias', 'primary-model', 10), 10);
  });

  it('keeps decay state separate across different aliases', () => {
    resetEffectiveCompositeSharesForTest();

    decayEffectiveCompositeShare('alias-a', 'fallback1', 10);
    // same target name in a different alias must not be affected
    assert.equal(getEffectiveCompositeShare('alias-b', 'fallback1', 10), 10);
    assert.equal(getEffectiveCompositeShare('alias-a', 'fallback1', 10), 5);
  });

  it('keeps runtime state separate from configured share input', () => {
    resetEffectiveCompositeSharesForTest();
    const targetConfig = { share: 10, fallback: 1 };

    decayEffectiveCompositeShare('alias', 'fallback1', targetConfig.share);

    assert.deepEqual(targetConfig, { share: 10, fallback: 1 });
    assert.equal(getEffectiveCompositeShare('alias', 'fallback1', targetConfig.share), 5);
  });
});

describe('composite primary effective share recovery', () => {
  it('doubles primary share back up to the configured share', () => {
    resetEffectiveCompositeSharesForTest();
    decayEffectiveCompositeShare('alias', 'primary', 10);
    decayEffectiveCompositeShare('alias', 'primary', 10);
    assert.equal(getEffectiveCompositeShare('alias', 'primary', 10), 2.5);

    assert.deepEqual(recoverEffectiveCompositeShare('alias', 'primary', 10), { previous: 2.5, next: 5, cap: 10 });
    assert.deepEqual(recoverEffectiveCompositeShare('alias', 'primary', 10), { previous: 5, next: 10, cap: 10 });
    // capped at configured share
    assert.deepEqual(recoverEffectiveCompositeShare('alias', 'primary', 10), { previous: 10, next: 10, cap: 10 });
    assert.equal(getEffectiveCompositeShare('alias', 'primary', 10), 10);
  });

  it('is a no-op when the primary has never decayed', () => {
    resetEffectiveCompositeSharesForTest();

    const result = recoverEffectiveCompositeShare('alias', 'primary', 10);
    assert.deepEqual(result, { previous: 10, next: 10, cap: 10 });
    assert.equal(getEffectiveCompositeShare('alias', 'primary', 10), 10);
  });

  it('recovers from the 0.1 floor when configured share defaults to 1', () => {
    resetEffectiveCompositeSharesForTest();
    for (let i = 0; i < 5; i++) decayEffectiveCompositeShare('alias', 'primary', 1);
    assert.equal(getEffectiveCompositeShare('alias', 'primary', 1), 0.1);

    let result = recoverEffectiveCompositeShare('alias', 'primary', 1);
    assert.equal(result.next, 0.2);
    result = recoverEffectiveCompositeShare('alias', 'primary', 1);
    assert.equal(result.next, 0.4);
    result = recoverEffectiveCompositeShare('alias', 'primary', 1);
    assert.equal(result.next, 0.8);
    result = recoverEffectiveCompositeShare('alias', 'primary', 1);
    assert.equal(result.next, 1);
    assert.equal(getEffectiveCompositeShare('alias', 'primary', 1), 1);
  });

  it('recovers a fully decayed primary back to the configured share', () => {
    resetEffectiveCompositeSharesForTest();
    for (let i = 0; i < 5; i++) decayEffectiveCompositeShare('alias', 'primary', 10);
    assert.equal(getEffectiveCompositeShare('alias', 'primary', 10), 1);

    for (let i = 0; i < 4; i++) recoverEffectiveCompositeShare('alias', 'primary', 10);
    assert.equal(getEffectiveCompositeShare('alias', 'primary', 10), 10);
  });

  it('keeps recovery state separate per alias and target', () => {
    resetEffectiveCompositeSharesForTest();
    decayEffectiveCompositeShare('alias-a', 'primary', 10);
    decayEffectiveCompositeShare('alias-a', 'primary', 10);

    recoverEffectiveCompositeShare('alias-a', 'primary', 10);
    recoverEffectiveCompositeShare('alias-a', 'other', 10);

    assert.equal(getEffectiveCompositeShare('alias-a', 'primary', 10), 5);
    assert.equal(getEffectiveCompositeShare('alias-b', 'primary', 10), 10);
  });
});

describe('buildUpstreamUrl', () => {
  it('appends the suffix when baseUrl is a plain host', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com', 'v1/messages'),
      'https://api.example.com/v1/messages'
    );
  });

  it('does not duplicate /v1/messages', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/v1/messages', 'v1/messages'),
      'https://api.example.com/v1/messages'
    );
  });

  it('recognises /anthropic/messages as a full endpoint', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/anthropic/messages', 'v1/messages'),
      'https://api.example.com/anthropic/messages'
    );
  });

  it('recognises /v1/chat/completions as a full endpoint', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/v1/chat/completions', 'v1/chat/completions'),
      'https://api.example.com/v1/chat/completions'
    );
  });

  it('recognises /v1/interactions as a full endpoint', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/v1/interactions', 'v1/chat/completions'),
      'https://api.example.com/v1/interactions'
    );
  });

  it('recognises /v1/responses as a full endpoint', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/v1/responses', 'v1/responses'),
      'https://api.example.com/v1/responses'
    );
  });

  it('recognises Azure /openai/responses as a full endpoint', () => {
    assert.equal(
      buildUpstreamUrl('https://my-resource.openai.azure.com/openai/responses?api-version=2025-04-01-preview', 'v1/responses'),
      'https://my-resource.openai.azure.com/openai/responses?api-version=2025-04-01-preview'
    );
  });

  it('recognises Gemini /v1beta/models/{model}:generateContent as a full endpoint', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent', 'v1beta/models/gemini-pro:generateContent'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent'
    );
  });

  it('recognises Gemini /v1beta/models/{model}:streamGenerateContent as a full endpoint', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent?alt=sse', 'v1beta/models/gemini-pro:streamGenerateContent?alt=sse'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent?alt=sse'
    );
  });

  it('recognises Gemini /v1beta/models/{model}:countTokens as a full endpoint', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:countTokens', 'v1beta/models/gemini-pro:countTokens'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:countTokens'
    );
  });

  it('still appends to a bare Gemini base path without a generative action', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1beta/models', 'gemini-pro:generateContent'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent'
    );
  });

  it('does not duplicate version for Gemini generateContent suffixes', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1beta', 'v1beta/models/gemini-pro:generateContent'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent'
    );
  });

  it('does not duplicate version for Gemini streamGenerateContent suffixes', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1beta', 'v1beta/models/gemini-pro:streamGenerateContent?alt=sse'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent?alt=sse'
    );
  });

  it('does not duplicate version for Gemini countTokens suffixes', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1beta', 'v1beta/models/gemini-pro:countTokens'),
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:countTokens'
    );
  });

  it('keeps matching Gemini API versions when base is already versioned', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1', 'v1/models/gemini-pro:generateContent'),
      'https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent'
    );
  });

  it('collapses the suffix version to the base version when they differ', () => {
    assert.equal(
      buildUpstreamUrl('https://generativelanguage.googleapis.com/v1', 'v1beta/models/gemini-pro:generateContent'),
      'https://generativelanguage.googleapis.com/v1/models/gemini-pro:generateContent'
    );
  });

  it('performs case-insensitive matching', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/V1/Messages', 'v1/messages'),
      'https://api.example.com/V1/Messages'
    );
  });

  it('dedupes a trailing v4 segment on baseUrl (BigModel-style)', () => {
    assert.equal(
      buildUpstreamUrl('https://open.bigmodel.cn/api/coding/paas/v4', 'v1/chat/completions'),
      'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions'
    );
  });

  it('dedupes a trailing v2 segment on baseUrl', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/v2', 'v1/chat/completions'),
      'https://api.example.com/v2/chat/completions'
    );
  });

  it('dedupes any v\\d+ suffix segment when baseUrl ends with a version', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/v3', 'v2/responses'),
      'https://api.example.com/v3/responses'
    );
  });

  it('does not dedupe when baseUrl ends with a non-version segment', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/openai', 'v1/chat/completions'),
      'https://api.example.com/openai/v1/chat/completions'
    );
  });

  it('dedupes v4 with a v1/messages suffix (anthropic-messages schema)', () => {
    assert.equal(
      buildUpstreamUrl('https://open.bigmodel.cn/api/paas/v4', 'v1/messages'),
      'https://open.bigmodel.cn/api/paas/v4/messages'
    );
  });

  it('dedupes v2 with a v1/interactions suffix (interactions schema)', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/v2', 'v1/interactions'),
      'https://api.example.com/v2/interactions'
    );
  });

  it('dedupes v2 with a v1beta/models/:generateContent suffix', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/v2', 'v1beta/models/gemini-pro:generateContent'),
      'https://api.example.com/v2/models/gemini-pro:generateContent'
    );
  });

  it('dedupes v2 with a v1beta/models/:streamGenerateContent suffix', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/v2', 'v1beta/models/gemini-pro:streamGenerateContent?alt=sse'),
      'https://api.example.com/v2/models/gemini-pro:streamGenerateContent?alt=sse'
    );
  });

  it('defensively avoids duplicating the exact suffix even when not a known marker', () => {
    assert.equal(
      buildUpstreamUrl('https://api.example.com/v1/models', 'v1/models'),
      'https://api.example.com/v1/models'
    );
  });
});

describe('parseDynamicRoute', () => {
  it('splits a bare host and endpoint into an empty prefix and no model id', () => {
    const route = parseDynamicRoute('/https/api.qnaigc.com/v1/messages');

    assert.equal(route.targetConfig.targetUrl, 'https://api.qnaigc.com');
    assert.equal(route.targetConfig.targetPathPrefix, '');
    assert.equal(route.modelId, undefined);
    assert.equal(route.claudeEndpoint, 'v1/messages');
  });

  it('takes the scheme from the route instead of assuming https', () => {
    const route = parseDynamicRoute('/http/localhost:8788/v1/messages');

    assert.equal(route.targetConfig.targetUrl, 'http://localhost:8788');
    assert.equal(route.claudeEndpoint, 'v1/messages');
  });

  it('reads the segment before the endpoint as the model id', () => {
    const route = parseDynamicRoute('/https/api.qnaigc.com/abc/v1/messages');

    assert.equal(route.targetConfig.targetPathPrefix, '');
    assert.equal(route.modelId, 'abc');
    assert.equal(route.claudeEndpoint, 'v1/messages');
  });

  it('keeps the path prefix when a model id follows it', () => {
    const route = parseDynamicRoute('/https/api.qnaigc.com/openai/v1/abc/v1/messages');

    assert.equal(route.targetConfig.targetPathPrefix, '/openai/v1');
    assert.equal(route.modelId, 'abc');
    assert.equal(route.claudeEndpoint, 'v1/messages');
  });

  it('does not mistake a version segment inside the prefix for a model id', () => {
    const route = parseDynamicRoute('/https/api.qnaigc.com/openai/v1/v1/messages');

    assert.equal(route.targetConfig.targetPathPrefix, '/openai/v1');
    assert.equal(route.modelId, undefined);
    assert.equal(route.claudeEndpoint, 'v1/messages');
  });

  it('collapses a doubled slash to an empty prefix rather than a slash', () => {
    const route = parseDynamicRoute('/https/api.qnaigc.com//abc/v1/messages');

    assert.equal(route.targetConfig.targetPathPrefix, '');
    assert.equal(route.modelId, 'abc');
    assert.equal(route.claudeEndpoint, 'v1/messages');
  });

  it('locates a v1beta Gemini endpoint and leaves the model inside the endpoint', () => {
    const route = parseDynamicRoute(
      '/https/generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent'
    );

    assert.equal(route.targetConfig.targetUrl, 'https://generativelanguage.googleapis.com');
    assert.equal(route.targetConfig.targetPathPrefix, '');
    assert.equal(route.modelId, undefined);
    assert.equal(route.claudeEndpoint, 'v1beta/models/gemini-2.5-pro:generateContent');
  });

  it('locates the interactions and count_tokens endpoints', () => {
    assert.equal(
      parseDynamicRoute('/https/api.qnaigc.com/v1/interactions').claudeEndpoint,
      'v1/interactions'
    );
    assert.equal(
      parseDynamicRoute('/https/api.qnaigc.com/v1/messages/count_tokens').claudeEndpoint,
      'v1/messages/count_tokens'
    );
  });

  it('rejects a url with too few segments', () => {
    assert.throws(() => parseDynamicRoute('/v1/messages'), /Invalid URL format/);
  });

  it('rejects a protocol other than http or https', () => {
    assert.throws(
      () => parseDynamicRoute('/ftp/api.example.com/v1/messages'),
      /Invalid protocol: ftp/
    );
  });

  it('rejects an endpoint it does not recognise instead of guessing', () => {
    // chat/completions is served by the fixed-route and model-route dialects;
    // dynamic routing only locates models, messages and interactions.
    assert.throws(
      () => parseDynamicRoute('/https/api.openai.com/v1/chat/completions'),
      /Could not locate Claude endpoint/
    );
  });
});

describe('getHandlerType', () => {
  it('maps each supported endpoint to its handler', () => {
    assert.equal(getHandlerType('v1/models'), 'models');
    assert.equal(getHandlerType('v1/messages'), 'messages');
    assert.equal(getHandlerType('v1/interactions'), 'interactions');
    assert.equal(getHandlerType('v1beta/interactions'), 'interactions');
  });

  it('classifies count_tokens as token-counting rather than messages', () => {
    assert.equal(getHandlerType('v1/messages/count_tokens'), 'token-counting');
  });

  it('accepts a generateContent endpoint under either api version', () => {
    assert.equal(getHandlerType('v1beta/models/gemini-pro:generateContent'), 'generateContent');
    assert.equal(getHandlerType('v1/models/gemini-pro:generateContent'), 'generateContent');
  });

  it('throws for a models endpoint that carries no generative action', () => {
    // parseDynamicRoute can emit this endpoint, so it reaches getHandlerType in
    // production and currently surfaces as an error rather than a handler.
    assert.throws(() => getHandlerType('v1/models/gemini-2.5-pro'), /Unknown Claude endpoint/);
  });

  it('classifies v1beta interactions paths with sub-resources as interactions', () => {
    assert.equal(getHandlerType('v1beta/interactions/session-1'), 'interactions');
  });

  it('still throws for models paths without a generative action after unification', () => {
    assert.throws(() => getHandlerType('v1beta/models/gemini-2.5:streamGenerateContent'), /Unknown Claude endpoint/);
    assert.throws(() => getHandlerType('v1/models/'), /Unknown Claude endpoint/);
    assert.throws(() => getHandlerType('v1beta/models'), /Unknown Claude endpoint/);
  });
});

describe('buildTargetUrl', () => {
  it('inserts the model id between the prefix and the endpoint', () => {
    assert.equal(
      buildTargetUrl(
        { targetUrl: 'https://api.qnaigc.com', targetPathPrefix: '' },
        'v1/messages',
        'abc'
      ),
      'https://api.qnaigc.com/abc/v1/messages'
    );
  });

  it('omits the model segment when no model id is given', () => {
    assert.equal(
      buildTargetUrl(
        { targetUrl: 'https://api.qnaigc.com', targetPathPrefix: '' },
        'v1/messages',
        undefined
      ),
      'https://api.qnaigc.com/v1/messages'
    );
  });

  it('omits the model segment for an empty model id', () => {
    assert.equal(
      buildTargetUrl(
        { targetUrl: 'https://api.qnaigc.com', targetPathPrefix: '' },
        'v1/messages',
        ''
      ),
      'https://api.qnaigc.com/v1/messages'
    );
  });

  it('keeps the path prefix ahead of the model id', () => {
    assert.equal(
      buildTargetUrl(
        { targetUrl: 'https://api.qnaigc.com', targetPathPrefix: '/openai/v1' },
        'v1/messages',
        'abc'
      ),
      'https://api.qnaigc.com/openai/v1/abc/v1/messages'
    );
  });

  it('round-trips parsed routes back to their absolute url', () => {
    const cases: Array<[string, string]> = [
      ['/https/api.qnaigc.com/abc/v1/messages', 'https://api.qnaigc.com/abc/v1/messages'],
      ['/https/api.qnaigc.com//abc/v1/messages', 'https://api.qnaigc.com/abc/v1/messages'],
      [
        '/https/api.qnaigc.com/openai/v1/abc/v1/messages',
        'https://api.qnaigc.com/openai/v1/abc/v1/messages',
      ],
      [
        '/https/api.qnaigc.com/openai/v1/v1/messages',
        'https://api.qnaigc.com/openai/v1/v1/messages',
      ],
      [
        '/https/generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent',
      ],
    ];

    for (const [route, expected] of cases) {
      const parsed = parseDynamicRoute(route);
      assert.equal(
        buildTargetUrl(parsed.targetConfig, parsed.claudeEndpoint, parsed.modelId),
        expected,
        `round-trip failed for ${route}`
      );
    }
  });
});


describe('transformAuthHeadersForUpstream', () => {
  const makeRequest = (path: string, headers: Record<string, string>) =>
    new Request(`http://localhost${path}`, { headers });

  it('prefers Authorization over x-goog-api-key for the /v1/models list in anthropic-messages mode', () => {
    const headers = transformAuthHeadersForUpstream(
      makeRequest('/v1/models', {
        Authorization: 'Bearer sk-anthropic',
        'x-goog-api-key': 'goog-key',
      }),
      'anthropic-messages',
      '/v1/models'
    );
    assert.equal(headers['x-api-key'], 'sk-anthropic');
    assert.equal(headers['x-goog-api-key'], undefined);
  });

  it('still prefers x-goog-api-key for genuine Gemini native calls', () => {
    const headers = transformAuthHeadersForUpstream(
      makeRequest('/v1beta/models/gemini-2.5:generateContent', {
        Authorization: 'Bearer sk-anthropic',
        'x-goog-api-key': 'goog-key',
      }),
      'gemini-generatecontent',
      '/v1beta/models/gemini-2.5:generateContent'
    );
    assert.equal(headers['x-goog-api-key'], 'goog-key');
    assert.equal(headers['x-api-key'], undefined);
  });

  it('falls through to x-goog-api-key for the /v1/models list when it is the only credential', () => {
    const headers = transformAuthHeadersForUpstream(
      makeRequest('/v1/models', { 'x-goog-api-key': 'goog-key' }),
      'anthropic-messages',
      '/v1/models'
    );
    assert.equal(headers['x-api-key'], 'goog-key');
  });

  it('prefers x-goog-api-key for v1beta interactions paths in gemini-interactions mode', () => {
    const headers = transformAuthHeadersForUpstream(
      makeRequest('/v1beta/interactions/session-1', {
        Authorization: 'Bearer sk-x',
        'x-goog-api-key': 'goog-key',
      }),
      'gemini-interactions',
      '/v1beta/interactions/session-1'
    );
    assert.equal(headers['x-goog-api-key'], 'goog-key');
    assert.equal(headers['Authorization'], undefined);
  });

  it('still authenticates a v1beta interactions path when only Authorization is present', () => {
    const headers = transformAuthHeadersForUpstream(
      makeRequest('/v1beta/interactions/session-1', { Authorization: 'Bearer sk-x' }),
      'gemini-interactions',
      '/v1beta/interactions/session-1'
    );
    assert.equal(headers['x-goog-api-key'], 'sk-x');
  });
});
