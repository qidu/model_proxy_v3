/**
 * Unit tests for src/utils/provider-quota.ts
 *
 * Covers: provider detection by route host, all five response parsers
 * (fixture schemas ported from the dsh musage plugin), auth header style
 * (Bearer vs zhipu raw), error classification, and cache behavior.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { detectProvider, getModelQuota, formatQuota, formatQuotaLeft, clearQuotaCache, recordUpstreamRateLimit, getUpstreamRateLimitLeft, getUpstreamRateLimitLeftForUrl } from '../../src/utils/provider-quota.js';

const realFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; headers: Record<string, string> }> = [];
let mockResponse: { status: number; body: string } = { status: 200, body: '{}' };

function installFetchMock(): void {
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    fetchCalls.push({
      url: String(_url),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return new Response(mockResponse.body, {
      status: mockResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  clearQuotaCache();
  fetchCalls = [];
  mockResponse = { status: 200, body: '{}' };
  installFetchMock();
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('detectProvider', () => {
  test('maps each provider host', () => {
    assert.equal(detectProvider('https://api.minimaxi.com/v1'), 'minimax');
    assert.equal(detectProvider('https://api.minimax.io/v1'), 'minimax-en');
    assert.equal(detectProvider('https://api.deepseek.com/chat/completions'), 'deepseek');
    assert.equal(detectProvider('https://api.kimi.com/coding/v1'), 'kimi');
    assert.equal(detectProvider('https://openrouter.ai/api/v1/chat/completions'), 'openrouter');
    assert.equal(detectProvider('https://open.bigmodel.cn/api/paas/v4'), 'zhipu');
    assert.equal(detectProvider('https://api.qnaigc.com/v1'), 'qnaigc');
  });

  test('returns undefined for unknown hosts and bad URLs', () => {
    assert.equal(detectProvider('https://api.openai.com/v1'), undefined);
    assert.equal(detectProvider('not a url'), undefined);
  });
});

describe('getModelQuota — minimax', () => {
  test('percent schema (2026-06-01): 5h + weekly windows', async () => {
    mockResponse.body = JSON.stringify({
      base_resp: { status_code: 0, status_msg: '' },
      model_remains: [{
        model_name: 'general',
        current_interval_remaining_percent: 58,
        current_interval_status: 1,
        end_time: 3600,
        current_weekly_remaining_percent: 90,
        current_weekly_status: 1,
        weekly_end_time: 400000,
      }],
    });
    const result = await getModelQuota({ targetUrl: 'https://api.minimaxi.com/v1', apiKey: 'sk-mm' });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'minimax');
    assert.equal(result.windows?.fiveHour?.usedPercent, 42);
    assert.equal(result.windows?.fiveHour?.remainingPercent, 58);
    assert.equal(result.windows?.weekly?.usedPercent, 10);
    assert.ok(result.windows?.fiveHour?.resetsAt && result.windows.fiveHour.resetsAt > Date.now());
    // EN host maps to api.minimax.io endpoint
    assert.equal(fetchCalls[0]?.url, 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains');
  });

  test('legacy count schema: used% derived from total/usage counts', async () => {
    mockResponse.body = JSON.stringify({
      base_resp: { status_code: 0, status_msg: '' },
      model_remains: [{
        model_name: 'general',
        current_interval_total_count: 100,
        current_interval_usage_count: 70,
      }],
    });
    const result = await getModelQuota({ targetUrl: 'https://api.minimax.io/v1', apiKey: 'sk-mm' });
    assert.equal(result.ok, true);
    assert.equal(result.windows?.fiveHour?.usedPercent, 30);
    assert.equal(fetchCalls[0]?.url, 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains');
  });

  test('base_resp error → server_error', async () => {
    mockResponse.body = JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'invalid api key' } });
    const result = await getModelQuota({ targetUrl: 'https://api.minimaxi.com/v1', apiKey: 'sk-mm' });
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'server_error');
    assert.match(result.message ?? '', /invalid api key/);
  });
});

describe('getModelQuota — deepseek', () => {
  test('balance CNY', async () => {
    mockResponse.body = JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '43.97' }],
    });
    const result = await getModelQuota({ targetUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-ds' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.balance, { amount: 43.97, currency: 'CNY' });
    assert.equal(fetchCalls[0]?.headers.Authorization, 'Bearer sk-ds');
  });

  test('is_available=false → server_error', async () => {
    mockResponse.body = JSON.stringify({ is_available: false });
    const result = await getModelQuota({ targetUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-ds' });
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'server_error');
  });
});

describe('getModelQuota — kimi', () => {
  test('5h + 7d windows from limits[0].detail and usage', async () => {
    mockResponse.body = JSON.stringify({
      limits: [{ detail: { limit: 100, remaining: 72, resetTime: '2026-08-28T00:00:00Z' } }],
      usage: { limit: 1000, remaining: 742, resetTime: 1749840000 },
    });
    const result = await getModelQuota({ targetUrl: 'https://api.kimi.com/coding', apiKey: 'sk-kimi' });
    assert.equal(result.ok, true);
    assert.equal(result.windows?.fiveHour?.usedPercent, 28);
    assert.equal(result.windows?.fiveHour?.remaining, 72);
    assert.equal(result.windows?.weekly?.usedPercent, 26);
    assert.equal(result.windows?.weekly?.resetsAt, 1749840000000);
  });

  test('error body {"code":"permission_denied"} → server_error', async () => {
    mockResponse.body = JSON.stringify({ code: 'permission_denied', msg: 'no plan' });
    const result = await getModelQuota({ targetUrl: 'https://api.kimi.com/coding', apiKey: 'sk-kimi' });
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'server_error');
    assert.match(result.message ?? '', /permission_denied/);
  });
});

describe('getModelQuota — openrouter', () => {
  test('remaining = total_credits - total_usage (USD)', async () => {
    mockResponse.body = JSON.stringify({ data: { total_credits: 10, total_usage: 3.5 } });
    const result = await getModelQuota({ targetUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or' });
    assert.equal(result.ok, true);
    assert.deepEqual(result.balance, { amount: 6.5, currency: 'USD' });
  });

  test('missing data field → parse error', async () => {
    mockResponse.body = JSON.stringify({ error: 'nope' });
    const result = await getModelQuota({ targetUrl: 'https://openrouter.ai/api/v1', apiKey: 'sk-or' });
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'parse');
  });
});

describe('getModelQuota — zhipu', () => {
  test('unit=3 (5h) and unit=6 (weekly) limits; raw Authorization (no Bearer)', async () => {
    mockResponse.body = JSON.stringify({
      code: 200,
      success: true,
      data: {
        limits: [
          { type: 'CREDIT_LIMIT', unit: 3, usage: 2000, remaining: 500, percentage: 75, nextResetTime: 1786969101067 },
          { unit: 6, usage: 10000, remaining: 2000, percentage: 80 },
        ],
      },
    });
    const result = await getModelQuota({ targetUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-zp' });
    assert.equal(result.ok, true);
    assert.equal(result.windows?.fiveHour?.usedPercent, 75);
    assert.equal(result.windows?.weekly?.usedPercent, 80);
    assert.equal(result.windows?.fiveHour?.resetsAt, 1786969101067);
    // Zhipu special: Authorization header is the raw key without "Bearer "
    assert.equal(fetchCalls[0]?.headers.Authorization, 'sk-zp');
  });

  test('success=false → server_error', async () => {
    mockResponse.body = JSON.stringify({ success: false, msg: 'quota api error' });
    const result = await getModelQuota({ targetUrl: 'https://open.bigmodel.cn/api/paas/v4', apiKey: 'sk-zp' });
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'server_error');
  });
});

describe('getModelQuota — qnaigc', () => {
  test('5h + monthly windows: limit from subscription.credit_limit_per_*, usedPercent = consumed/(consumed+remaining)', async () => {
    mockResponse.body = JSON.stringify({
      status: true,
      data: [{
        subscription: { config_key: 'pro:max', level: 3, models: ['qwen/qwen-max', 'deepseek/deepseek-v3'], credit_limit_per_4h: 1000000, credit_limit_per_month: 30000000 },
        // limit_credits deliberately differs from subscription.credit_limit_per_* to prove the
        // subscription field wins, and consumed+remaining deliberately != limit_credits to prove
        // usedPercent is derived from consumed/(consumed+remaining), not consumed/limit_credits.
        usage_4h: { window_start: '2026-08-31T12:00:00+08:00', window_end: '2026-08-31T16:00:00+08:00', limit_credits: 999, consumed_credits: 250000, remaining_credits: 750000 },
        usage_month: { window_start: '2026-08-14T00:00:00+08:00', window_end: '2026-09-14T00:00:00+08:00', limit_credits: 999, consumed_credits: 24800000, remaining_credits: 5200000 },
      }],
    });
    const result = await getModelQuota({ targetUrl: 'https://api.qnaigc.com/v1', apiKey: 'sk-qn' });
    assert.equal(result.ok, true);
    assert.equal(result.provider, 'qnaigc');
    assert.equal(result.windows?.fiveHour?.usedPercent, 25);
    assert.equal(result.windows?.fiveHour?.remaining, 750000);
    assert.equal(result.windows?.fiveHour?.limit, 1000000);
    assert.equal(result.windows?.weekly?.usedPercent, 83);
    assert.equal(result.windows?.weekly?.remaining, 5200000);
    assert.equal(result.windows?.weekly?.limit, 30000000);
    assert.equal(fetchCalls[0]?.url, 'https://api.qnaigc.com/v1/subscription/usage');
    assert.equal(fetchCalls[0]?.headers.Authorization, 'Bearer sk-qn');
  });

  test('status=false → server_error', async () => {
    mockResponse.body = JSON.stringify({ status: false, message: 'invalid token' });
    const result = await getModelQuota({ targetUrl: 'https://api.qnaigc.com/v1', apiKey: 'sk-qn' });
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'server_error');
  });

  test('empty data array → parse error', async () => {
    mockResponse.body = JSON.stringify({ status: true, data: [] });
    const result = await getModelQuota({ targetUrl: 'https://api.qnaigc.com/v1', apiKey: 'sk-qn' });
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'parse');
  });
});

describe('getModelQuota — error paths & cache', () => {
  test('unknown host → unsupported without fetching', async () => {
    const result = await getModelQuota({ targetUrl: 'https://api.unknown.com/v1', apiKey: 'sk' });
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'unsupported');
    assert.equal(fetchCalls.length, 0);
  });

  test('missing api key → unconfigured without fetching', async () => {
    const result = await getModelQuota({ targetUrl: 'https://api.deepseek.com/v1' });
    assert.equal(result.ok, false);
    assert.equal(result.kind, 'unconfigured');
    assert.equal(fetchCalls.length, 0);
  });

  test('HTTP 401 → auth_failed; HTTP 429 → rate_limited', async () => {
    mockResponse = { status: 401, body: 'unauthorized' };
    const r401 = await getModelQuota({ targetUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-bad' });
    assert.equal(r401.kind, 'auth_failed');
    assert.equal(r401.httpStatus, 401);

    clearQuotaCache();
    mockResponse = { status: 429, body: 'slow down' };
    const r429 = await getModelQuota({ targetUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-bad' });
    assert.equal(r429.kind, 'rate_limited');
  });

  test('success cached for TTL — second call does not refetch', async () => {
    mockResponse.body = JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '1.00' }],
    });
    await getModelQuota({ targetUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-ds' });
    await getModelQuota({ targetUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-ds' });
    assert.equal(fetchCalls.length, 1);
  });

  test('different api keys are cached separately', async () => {
    mockResponse.body = JSON.stringify({
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: '1.00' }],
    });
    await getModelQuota({ targetUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-a' });
    await getModelQuota({ targetUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-b' });
    assert.equal(fetchCalls.length, 2);
  });
});

describe('formatQuota', () => {
  test('balance rendering', () => {
    assert.equal(
      formatQuota({ ok: true, provider: 'deepseek', balance: { amount: 43.97, currency: 'CNY' }, fetchedAt: 0 }),
      'deepseek ¥43.97',
    );
    assert.equal(
      formatQuota({ ok: true, provider: 'openrouter', balance: { amount: 6.5, currency: 'USD' }, fetchedAt: 0 }),
      'openrouter $6.50',
    );
  });

  test('window rendering with reset time', () => {
    const resetsAt = Date.now() + 72 * 60 * 1000; // 1h12m
    const text = formatQuota({
      ok: true,
      provider: 'minimax',
      windows: { fiveHour: { usedPercent: 42, resetsAt }, weekly: { usedPercent: 71 } },
      fetchedAt: 0,
    });
    assert.match(text, /^minimax 5h .* \| 7d 71%$/);
  });

  test('error rendering includes kind and message', () => {
    const text = formatQuota({ ok: false, provider: 'deepseek', kind: 'auth_failed', message: 'HTTP 401', fetchedAt: 0 });
    assert.match(text, /deepseek quota ⚠ auth_failed: HTTP 401/);
  });
});

describe('formatQuotaLeft', () => {
  test('balance providers → currency amount', () => {
    assert.equal(formatQuotaLeft({ ok: true, provider: 'deepseek', balance: { amount: 43.97, currency: 'CNY' }, fetchedAt: 0 }), '¥43.97');
    assert.equal(formatQuotaLeft({ ok: true, provider: 'openrouter', balance: { amount: 6.5, currency: 'USD' }, fetchedAt: 0 }), '$6.50');
  });

  test('percent schema → remainingPercent; count schema → remaining/limit (5h preferred)', () => {
    assert.equal(formatQuotaLeft({
      ok: true, provider: 'minimax', fetchedAt: 0,
      windows: { fiveHour: { usedPercent: 42, remainingPercent: 58 }, weekly: { usedPercent: 10, remaining: 900, limit: 1000 } },
    }), '58%');
    // No 5h window → falls back to weekly; counts render with used percent
    assert.equal(formatQuotaLeft({
      ok: true, provider: 'kimi', fetchedAt: 0,
      windows: { fiveHour: null, weekly: { usedPercent: 26, remaining: 742, limit: 1000 } },
    }), '742/1000, 26%');
    // Count without a known limit → bare remaining
    assert.equal(formatQuotaLeft({
      ok: true, provider: 'zhipu', fetchedAt: 0,
      windows: { fiveHour: { usedPercent: 63, remaining: 7472, limit: 0 } },
    }), '7472');
  });

  test('error results and empty windows → null', () => {
    assert.equal(formatQuotaLeft({ ok: false, provider: 'deepseek', kind: 'auth_failed', fetchedAt: 0 }), null);
    assert.equal(formatQuotaLeft({ ok: true, provider: 'minimax', windows: {}, fetchedAt: 0 }), null);
  });
});

describe('anthropic rate-limit header tracking', () => {
  const HDR = 'anthropic-ratelimit-unified-5h-utilization';

  test('records utilization and derives left percent', () => {
    recordUpstreamRateLimit('claude-sonnet', (name) => name === HDR ? '0.42' : null);
    assert.equal(getUpstreamRateLimitLeft('claude-sonnet'), '58%');
  });

  test('latest recording wins per model', () => {
    recordUpstreamRateLimit('claude-haiku', (name) => name === HDR ? '0.1' : null);
    recordUpstreamRateLimit('claude-haiku', (name) => name === HDR ? '0.95' : null);
    assert.equal(getUpstreamRateLimitLeft('claude-haiku'), '5%');
  });

  test('utilization > 1 clamps left at 0%', () => {
    recordUpstreamRateLimit('claude-opus', (name) => name === HDR ? '1.4' : null);
    assert.equal(getUpstreamRateLimitLeft('claude-opus'), '0%');
  });

  test('missing header, invalid value, undefined model, and unknown model are no-ops', () => {
    recordUpstreamRateLimit('m-no-header', () => null);
    recordUpstreamRateLimit('m-bad-value', (name) => name === HDR ? 'not-a-number' : null);
    recordUpstreamRateLimit(undefined, (name) => name === HDR ? '0.5' : null);
    assert.equal(getUpstreamRateLimitLeft('m-no-header'), null);
    assert.equal(getUpstreamRateLimitLeft('m-bad-value'), null);
    assert.equal(getUpstreamRateLimitLeft('never-seen'), null);
  });

  test('sourceUrl additionally keys by upstream host (for the dashboard base-URL column)', () => {
    recordUpstreamRateLimit('claude-sonnet', (name) => name === HDR ? '0.25' : null, 'https://code-strong.example.com/v1/messages');
    assert.equal(getUpstreamRateLimitLeftForUrl('https://code-strong.example.com'), '75%');
    // Non-URL sourceUrl and unknown hosts are safe no-ops for the host map
    recordUpstreamRateLimit('m-x', (name) => name === HDR ? '0.5' : null, 'not a url');
    assert.equal(getUpstreamRateLimitLeftForUrl('https://code-strong.example.com'), '75%');
    assert.equal(getUpstreamRateLimitLeftForUrl('https://unknown.example.com'), null);
    assert.equal(getUpstreamRateLimitLeftForUrl('not a url'), null);
  });
});
