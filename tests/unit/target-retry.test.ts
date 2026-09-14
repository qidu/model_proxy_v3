/**
 * Unit tests for the pure pieces of the remote target-retry ladder.
 *
 * Run with:
 *   npx tsx --test tests/unit/target-retry.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAuthTargets,
  validateDescriptorEntries,
  dedupeAndCap,
  descriptorToRoute,
  outcomeFromResponse,
  outcomeFromError,
  isRetryableOutcome,
  DEFAULT_MAX_TARGETS,
} from '../../src/utils/target-retry.js';
import { UPSTREAM_MODES } from '../../src/utils/upstream-modes.js';
import { ClaudeProxyError } from '../../src/utils/errors.js';
import type { ProxyConfig } from '../../src/utils/config-loader.js';

// ---------------------------------------------------------------------------
// parseAuthTargets
// ---------------------------------------------------------------------------

describe('parseAuthTargets', () => {
  it('returns [] for undefined / null / empty input', () => {
    assert.deepEqual(parseAuthTargets(undefined), []);
    assert.deepEqual(parseAuthTargets(null), []);
    assert.deepEqual(parseAuthTargets(''), []);
  });

  it('returns [] for malformed JSON', () => {
    assert.deepEqual(parseAuthTargets('not json {'), []);
  });

  it('accepts a bare array', () => {
    const out = parseAuthTargets('[{"target":"m","base":"http://localhost"}]');
    assert.deepEqual(out, [{ target: 'm', base: 'http://localhost' }]);
  });

  it('accepts a { targets: [...] } wrapper', () => {
    const out = parseAuthTargets('{"targets":[{"target":"m","base":"http://localhost"}]}');
    assert.deepEqual(out, [{ target: 'm', base: 'http://localhost' }]);
  });

  it('returns [] when the wrapper has no targets array', () => {
    assert.deepEqual(parseAuthTargets('{"other":[1,2]}'), []);
    assert.deepEqual(parseAuthTargets('{"targets":"nope"}'), []);
  });

  it('filters out non-object entries (null, primitives, nested arrays)', () => {
    const out = parseAuthTargets('[null, 1, "x", [1], {"target":"m","base":"http://localhost"}]');
    assert.deepEqual(out, [{ target: 'm', base: 'http://localhost' }]);
  });
});

// ---------------------------------------------------------------------------
// validateDescriptorEntries
// ---------------------------------------------------------------------------

describe('validateDescriptorEntries', () => {
  it('keeps a valid entry and captures optional fields', () => {
    const { valid, dropped } = validateDescriptorEntries([
      {
        target: 'gpt-4o',
        base: 'http://localhost',
        mode: 'openai-completions',
        key: 'sk-a',
        otac: 'otac-1',
        transforms: 't1,t2',
        timeout: 1500,
        retry_on: [429, 503],
      },
    ]);
    assert.equal(dropped.length, 0);
    assert.equal(valid.length, 1);
    assert.deepEqual(valid[0], {
      target: 'gpt-4o',
      base: 'http://localhost',
      mode: 'openai-completions',
      key: 'sk-a',
      otac: 'otac-1',
      transforms: 't1,t2',
      timeout: 1500,
      retry_on: [429, 503],
    });
  });

  it('omits optional keys that are absent or empty', () => {
    const { valid } = validateDescriptorEntries([{ target: 'm', base: 'http://localhost', key: '', otac: '', transforms: '' }]);
    assert.deepEqual(valid[0], { target: 'm', base: 'http://localhost' });
  });

  it('rejects a present-but-empty mode as unknown (fail loud)', () => {
    const { valid, dropped } = validateDescriptorEntries([{ target: 'm', base: 'http://localhost', mode: '  ' }]);
    assert.equal(valid.length, 0);
    assert.match(dropped[0].reason, /unknown mode/);
  });

  it('drops entries missing target or base, with a reason', () => {
    const { valid, dropped } = validateDescriptorEntries([
      { base: 'http://localhost' },
      { target: 'm' },
      { target: '   ', base: 'http://localhost' },
    ]);
    assert.equal(valid.length, 0);
    assert.equal(dropped.length, 3);
    assert.match(dropped[0].reason, /target/);
    assert.match(dropped[1].reason, /base/);
    assert.match(dropped[2].reason, /target/);
  });

  it('drops an unparseable base URL', () => {
    const { valid, dropped } = validateDescriptorEntries([{ target: 'm', base: 'not a url' }]);
    assert.equal(valid.length, 0);
    assert.match(dropped[0].reason, /not a valid URL/);
  });

  it('accepts any well-formed host — the config allowlist does not gate rungs', () => {
    // A self-contained descriptor's destination need not appear as a configured
    // model base_url; the auth server is a trusted routing authority.
    for (const base of [
      'https://api.example.com',
      'https://api.example.com/v1',
      'http://localhost:8080',
      'http://127.0.0.1',
      'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    ]) {
      const { valid, dropped } = validateDescriptorEntries([{ target: 'm', base }]);
      assert.equal(dropped.length, 0, `${base} should not be dropped`);
      assert.equal(valid.length, 1, `${base} should be accepted`);
    }
  });

  it('drops an unknown mode but accepts every UPSTREAM_MODE', () => {
    const bad = validateDescriptorEntries([{ target: 'm', base: 'http://localhost', mode: 'bogus' }]);
    assert.equal(bad.valid.length, 0);
    assert.match(bad.dropped[0].reason, /unknown mode/);

    for (const mode of UPSTREAM_MODES) {
      const ok = validateDescriptorEntries([{ target: 'm', base: 'http://localhost', mode }]);
      assert.equal(ok.valid.length, 1, `mode ${mode} should be accepted`);
      assert.equal(ok.valid[0].mode, mode);
    }
  });

  it('drops non-string key / otac / transforms', () => {
    const { valid, dropped } = validateDescriptorEntries([
      { target: 'm', base: 'http://localhost', key: 123 },
      { target: 'm', base: 'http://localhost', otac: {} },
      { target: 'm', base: 'http://localhost', transforms: [] },
    ]);
    assert.equal(valid.length, 0);
    assert.equal(dropped.length, 3);
    assert.match(dropped[0].reason, /key must be a string/);
    assert.match(dropped[1].reason, /otac must be a string/);
    assert.match(dropped[2].reason, /transforms must be a string/);
  });

  it('drops a non-positive or non-finite timeout', () => {
    for (const timeout of [0, -5, Infinity, NaN]) {
      const { valid, dropped } = validateDescriptorEntries([{ target: 'm', base: 'http://localhost', timeout }]);
      assert.equal(valid.length, 0, `timeout ${timeout} should be dropped`);
      assert.match(dropped[0].reason, /timeout/);
    }
  });

  it('drops a retry_on that is not an array of finite integers', () => {
    for (const retry_on of ['429', [429.5], [NaN], [{}], ['429']]) {
      const { valid, dropped } = validateDescriptorEntries([{ target: 'm', base: 'http://localhost', retry_on }]);
      assert.equal(valid.length, 0, `retry_on ${JSON.stringify(retry_on)} should be dropped`);
      assert.match(dropped[0].reason, /retry_on/);
    }
  });

  it('drops only the offending entry and keeps valid ones (order preserved)', () => {
    const { valid, dropped } = validateDescriptorEntries([
      { target: 'a', base: 'http://localhost' },
      { target: 'b' },
      { target: 'c', base: 'http://127.0.0.1' },
    ]);
    assert.deepEqual(valid.map(v => v.target), ['a', 'c']);
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].entry.target, 'b');
  });
});

// ---------------------------------------------------------------------------
// dedupeAndCap
// ---------------------------------------------------------------------------

describe('dedupeAndCap', () => {
  const e = (target: string, base = 'http://localhost', key?: string) => ({ target, base, key });

  it('drops exact duplicates (target@base@key)', () => {
    const out = dedupeAndCap([e('a'), e('a'), e('b')]);
    assert.deepEqual(out.map(x => x.target), ['a', 'b']);
  });

  it('keeps entries that differ only by key (rotation pair)', () => {
    const out = dedupeAndCap([e('a', 'http://localhost', 'k1'), e('a', 'http://localhost', 'k2')]);
    assert.equal(out.length, 2);
  });

  it('keeps entries that differ by base', () => {
    const out = dedupeAndCap([e('a', 'http://localhost'), e('a', 'http://127.0.0.1')]);
    assert.equal(out.length, 2);
  });

  it('dedupes before capping so a repeat cannot consume a slot', () => {
    const out = dedupeAndCap([e('a'), e('a'), e('b'), e('c')], 3);
    assert.deepEqual(out.map(x => x.target), ['a', 'b', 'c']);
  });

  it('caps at DEFAULT_MAX_TARGETS by default', () => {
    const many = Array.from({ length: DEFAULT_MAX_TARGETS + 3 }, (_, i) => e(`m${i}`));
    assert.equal(dedupeAndCap(many).length, DEFAULT_MAX_TARGETS);
  });

  it('does not cap when maxTargets is non-positive', () => {
    const many = Array.from({ length: 6 }, (_, i) => e(`m${i}`));
    assert.equal(dedupeAndCap(many, 0).length, 6);
  });
});

// ---------------------------------------------------------------------------
// descriptorToRoute
// ---------------------------------------------------------------------------

describe('descriptorToRoute', () => {
  const cfg = (over: Partial<ProxyConfig> = {}): ProxyConfig =>
    ({ default_upstream: { upstream_mode: 'gemini-generatecontent' }, ...over }) as ProxyConfig;

  it('maps target/base/key into a self-contained route', () => {
    const route = descriptorToRoute({ target: 'gpt-4o', base: 'https://api.up', key: 'sk-x' }, cfg());
    assert.equal(route.targetUrl, 'https://api.up');
    assert.equal(route.apiKey, 'sk-x');
    assert.equal(route.modelAlias, 'gpt-4o');
    assert.equal(route.upstreamMode, 'gemini-generatecontent');
  });

  it('sets explicitApiKey only when a key is present (not via section)', () => {
    const withKey = descriptorToRoute({ target: 'm', base: 'https://api.up', key: 'sk-x' }, cfg());
    const noKey = descriptorToRoute({ target: 'm', base: 'https://api.up' }, cfg());
    assert.equal(withKey.explicitApiKey, true);
    assert.equal(noKey.explicitApiKey, false);
    assert.equal(withKey.section, undefined, 'section is no longer abused by descriptors');
  });

  it('prefers descriptor.mode over default_upstream, falling back to openai-completions', () => {
    const explicit = descriptorToRoute({ target: 'm', base: 'https://api.up', mode: 'anthropic-messages' }, cfg());
    assert.equal(explicit.upstreamMode, 'anthropic-messages');

    const fallback = descriptorToRoute({ target: 'm', base: 'https://api.up' }, {} as ProxyConfig);
    assert.equal(fallback.upstreamMode, 'openai-completions');
  });

  it('carries the per-route timeout', () => {
    const route = descriptorToRoute({ target: 'm', base: 'https://api.up', timeout: 2500 }, cfg());
    assert.equal(route.timeout, 2500);
  });

  it('resolves entry transforms against the config transform table', () => {
    const config = cfg({
      transforms: { t1: { name: 't1' } as any },
    });
    const route = descriptorToRoute({ target: 'm', base: 'https://api.up', transforms: 't1,missing' }, config);
    assert.deepEqual(route.transforms, [{ name: 't1' }]);
  });
});

// ---------------------------------------------------------------------------
// outcome classification
// ---------------------------------------------------------------------------

describe('outcomeFromResponse', () => {
  it('marks < 400 ok and >= 400 not ok, carrying the status', () => {
    assert.deepEqual(
      (({ ok, status }) => ({ ok, status }))(outcomeFromResponse(new Response(null, { status: 200 }))),
      { ok: true, status: 200 },
    );
    assert.deepEqual(
      (({ ok, status }) => ({ ok, status }))(outcomeFromResponse(new Response(null, { status: 429 }))),
      { ok: false, status: 429 },
    );
    assert.deepEqual(
      (({ ok, status }) => ({ ok, status }))(outcomeFromResponse(new Response(null, { status: 500 }))),
      { ok: false, status: 500 },
    );
  });
});

describe('outcomeFromError', () => {
  it('uses the status of a ClaudeProxyError', () => {
    const out = outcomeFromError(new ClaudeProxyError('nope', 429, 'rate_limit_error'));
    assert.equal(out.ok, false);
    assert.equal(out.status, 429);
  });

  it('classifies a transport error to 502', () => {
    const err = new Error('fetch failed') as Error & { cause?: { code: string } };
    err.cause = { code: 'ECONNREFUSED' };
    assert.equal(outcomeFromError(err).status, 502);
  });

  it('classifies an abort/timeout error to 504', () => {
    const err = new Error('aborted');
    err.name = 'AbortError';
    assert.equal(outcomeFromError(err).status, 504);
  });

  it('maps an unclassifiable error to status 0 (never retryable)', () => {
    const out = outcomeFromError(new Error('plain bug'));
    assert.equal(out.status, 0);
    assert.equal(isRetryableOutcome(out), false);
  });
});

describe('isRetryableOutcome', () => {
  it('retries 429 and any 5xx', () => {
    for (const status of [429, 500, 502, 503, 504]) {
      assert.equal(isRetryableOutcome({ ok: false, status }), true, `status ${status} should be retryable`);
    }
  });

  it('does not retry 2xx / deterministic 4xx / status 0', () => {
    for (const status of [200, 400, 401, 403, 404, 422, 0]) {
      assert.equal(isRetryableOutcome({ ok: false, status }), false, `status ${status} should not be retryable`);
    }
  });
});
