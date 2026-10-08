/**
 * Provider usage/quota reader.
 *
 * Fetches remaining usage / credits / balance for the coding-plan providers
 * (MiniMax, DeepSeek, Kimi, OpenRouter, Zhipu) so the TUI and the dashboard
 * API can show "how much is left" for a given model's route. Endpoints and
 * response schemas are ported from the dsh musage plugin (index.js), which
 * reverse-engineered them from ccswitch / Musage:
 *
 *   minimax   GET {host}/v1/api/openplatform/coding_plan/remains   Bearer
 *             base_resp.status_code == 0; model_remains[] pick model_name
 *             "general"; dual schema (percent-based 2026-06-01 + legacy
 *             count-based), each with 5h (current_interval_*) and weekly
 *             (current_weekly_*) windows.
 *   deepseek  GET https://api.deepseek.com/user/balance             Bearer
 *             balance_infos[0].total_balance + currency.
 *   kimi      GET https://api.kimi.com/coding/v1/usages             Bearer
 *             limits[0].detail = 5h window; usage = 7d window.
 *   openrouter GET https://openrouter.ai/api/v1/credits             Bearer
 *             data.total_credits - data.total_usage = remaining USD.
 *   zhipu     GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *             Authorization: <key>   (raw, NO "Bearer " prefix)
 *             data.limits[]: unit==3 → 5h, unit==6 → weekly; percentage is
 *             the server-computed used %.
 *   qnaigc    GET https://api.qnaigc.com/v1/subscription/usage        Bearer
 *             data[0].usage_4h = 5h window; data[0].usage_month = monthly
 *             window (reported in the `weekly` slot). limit is
 *             subscription.credit_limit_per_4h / credit_limit_per_month;
 *             usedPercent = consumed_credits / (consumed_credits +
 *             remaining_credits); window_end is an ISO timestamp.
 *
 * Results are cached per (provider, apiKey) pair: 30s TTL on success,
 * exponential backoff 5s → 30min on failure (same policy as musage).
 */

import { createUpstreamAbortSignal } from './fetch-timeout.js';
import type { ModelRouteConfig } from './config-loader.js';

const CACHE_TTL_MS = 30_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;

export type QuotaErrorKind =
  | 'unconfigured'
  | 'unsupported'
  | 'auth_failed'
  | 'rate_limited'
  | 'server_error'
  | 'network'
  | 'parse';

export interface QuotaWindow {
  usedPercent: number | null;
  /** Remaining in the provider's native unit: a count (kimi/zhipu/minimax
   *  count schema) or, when remainingPercent is set, a percent (minimax
   *  percent schema). */
  limit?: number;
  remaining?: number;
  remainingPercent?: number;
  resetsAt?: number | null; // epoch ms
}

export interface QuotaResult {
  ok: boolean;
  provider: string;
  kind?: QuotaErrorKind;
  message?: string;
  httpStatus?: number;
  /** 5h / weekly usage windows (minimax, kimi, zhipu). */
  windows?: { fiveHour?: QuotaWindow | null; weekly?: QuotaWindow | null };
  /** Monetary balance (deepseek, openrouter). */
  balance?: { amount: number; currency: string };
  fetchedAt: number;
}

// ---------------------------------------------------------------------------
// Provider registry
// ---------------------------------------------------------------------------

interface ProviderSpec {
  hosts: string[];
  usageUrl: string;
  authStyle: 'bearer' | 'raw';
  parse: (json: unknown) => QuotaResult;
}

const PROVIDERS: Record<string, ProviderSpec> = {
  // MiniMax has two deployments (CN api.minimaxi.com / EN api.minimax.io)
  // sharing the same schema; the usage host matches the route host.
  minimax: {
    hosts: ['api.minimaxi.com'],
    usageUrl: 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
    authStyle: 'bearer',
    parse: parseMinimaxResponse,
  },
  'minimax-en': {
    hosts: ['api.minimax.io'],
    usageUrl: 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains',
    authStyle: 'bearer',
    parse: parseMinimaxResponse,
  },
  deepseek: {
    hosts: ['api.deepseek.com'],
    usageUrl: 'https://api.deepseek.com/user/balance',
    authStyle: 'bearer',
    parse: parseDeepseekBalance,
  },
  kimi: {
    hosts: ['api.kimi.com'],
    usageUrl: 'https://api.kimi.com/coding/v1/usages',
    authStyle: 'bearer',
    parse: parseKimiResponse,
  },
  openrouter: {
    hosts: ['openrouter.ai'],
    usageUrl: 'https://openrouter.ai/api/v1/credits',
    authStyle: 'bearer',
    parse: parseOpenrouterResponse,
  },
  zhipu: {
    hosts: ['open.bigmodel.cn'],
    usageUrl: 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    // Zhipu rejects "Bearer <key>" — the raw key goes in Authorization.
    authStyle: 'raw',
    parse: parseZhipuResponse,
  },
  qnaigc: {
    hosts: ['api.qnaigc.com'],
    usageUrl: 'https://api.qnaigc.com/v1/subscription/usage',
    authStyle: 'bearer',
    parse: parseQnaigcResponse,
  },
};

/** Resolve a provider id from a route's target URL host (exact match). */
export function detectProvider(targetUrl: string): string | undefined {
  let host: string;
  try {
    host = new URL(targetUrl).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  for (const [id, spec] of Object.entries(PROVIDERS)) {
    if (spec.hosts.includes(host)) return id;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

function parseJsonBody(body: string): { json?: unknown; error?: string } {
  try {
    return { json: JSON.parse(body) };
  } catch {
    return { error: 'JSON 解析失败' };
  }
}

function parseEndTime(v: unknown): number | null {
  if (typeof v !== 'number') return null;
  if (v >= 1e12 && v <= 4e12) return v; // already epoch ms
  return Date.now() + v * 1000; // seconds remaining
}

function parseResetTime(v: unknown): number | null {
  if (typeof v === 'number') {
    if (v >= 1e12 && v <= 4e12) return v;
    if (v > 1e9) return v * 1000;
    return null;
  }
  if (typeof v === 'string' && v.length > 0) {
    const t = Date.parse(v);
    return Number.isNaN(t) ? null : t;
  }
  return null;
}

function err(provider: string, kind: QuotaErrorKind, message: string): QuotaResult {
  return { ok: false, provider, kind, message, fetchedAt: Date.now() };
}

function parseMinimaxResponse(json: unknown): QuotaResult {
  const obj = json as Record<string, any> | null;
  const baseResp = obj && obj.base_resp;
  if (!baseResp || baseResp.status_code !== 0) {
    return err('minimax', 'server_error', (baseResp && baseResp.status_msg) || 'base_resp.status_code != 0');
  }
  const arr = obj && obj.model_remains;
  if (!Array.isArray(arr) || arr.length === 0) {
    return err('minimax', 'parse', 'model_remains 为空');
  }
  const entry = arr.find((r: any) => r && r.model_name === 'general') || arr[0];
  if (!entry) return err('minimax', 'parse', '找不到可用 model_remains 条目');

  const fiveHour = parseMinimaxWindow(entry, 'current_interval_', 'current_interval_usage_count', 'current_interval_total_count', 'end_time');
  const weekly = parseMinimaxWindow(entry, 'current_weekly_', 'current_weekly_usage_count', 'current_weekly_total_count', 'weekly_end_time');
  if (!fiveHour && !weekly) {
    return err('minimax', 'parse', 'MiniMax 响应字段都不认识');
  }
  return { ok: true, provider: 'minimax', windows: { fiveHour, weekly }, fetchedAt: Date.now() };
}

// Dual schema (2026-06-01): percent-based first, then legacy count-based.
function parseMinimaxWindow(entry: Record<string, any>, prefix: string, legacyRemaining: string, legacyTotal: string, endTimeKey: string): QuotaWindow | null {
  const newPercent = entry[prefix + 'remaining_percent'];
  const newStatus = entry[prefix + 'status'];
  if (typeof newPercent === 'number' && newStatus === 1) {
    return {
      usedPercent: Math.max(0, Math.round(100 - newPercent)),
      remainingPercent: newPercent,
      resetsAt: parseEndTime(entry[endTimeKey]),
    };
  }
  const total = entry[prefix + 'total_count'];
  const remaining = entry[legacyRemaining] ?? entry[prefix + 'usage_count'];
  if (typeof total === 'number' && total > 0 && typeof remaining === 'number') {
    return {
      usedPercent: Math.max(0, Math.round(((total - remaining) / total) * 100)),
      limit: total,
      remaining,
      resetsAt: parseEndTime(entry[endTimeKey]),
    };
  }
  return null;
}

function parseDeepseekBalance(json: unknown): QuotaResult {
  const obj = json as Record<string, any> | null;
  if (!obj || typeof obj !== 'object') return err('deepseek', 'parse', 'DeepSeek 响应不是对象');
  if (obj.is_available === false) return err('deepseek', 'server_error', 'DeepSeek 账号 is_available=false');
  const infos = obj.balance_infos;
  if (!Array.isArray(infos) || infos.length === 0) {
    return err('deepseek', 'parse', 'balance_infos 字段为空');
  }
  const first = infos[0];
  const balance = parseFloat(first && first.total_balance);
  if (!Number.isFinite(balance)) {
    return err('deepseek', 'parse', 'balance 解析失败: ' + (first && first.total_balance));
  }
  return {
    ok: true,
    provider: 'deepseek',
    balance: { amount: balance, currency: (first && first.currency) || 'USD' },
    fetchedAt: Date.now(),
  };
}

function parseKimiResponse(json: unknown): QuotaResult {
  const obj = json as Record<string, any> | null;
  if (!obj || typeof obj !== 'object') return err('kimi', 'parse', 'Kimi 响应不是对象');
  if (obj.code && obj.code !== 200 && obj.code !== '200') {
    return err('kimi', 'server_error', `Kimi 返错: ${obj.code} · ${obj.msg || ''}`);
  }
  const five = (Array.isArray(obj.limits) && obj.limits[0] && obj.limits[0].detail) || {};
  const week = obj.usage || {};
  const fiveHour: QuotaWindow | null = Number(five.limit) > 0 ? {
    usedPercent: Math.round((Number(five.limit) - Number(five.remaining)) / Number(five.limit) * 100),
    limit: Number(five.limit),
    remaining: Number(five.remaining),
    resetsAt: parseResetTime(five.resetTime),
  } : null;
  const weekly: QuotaWindow | null = Number(week.limit) > 0 ? {
    usedPercent: Math.round((Number(week.limit) - Number(week.remaining)) / Number(week.limit) * 100),
    limit: Number(week.limit),
    remaining: Number(week.remaining),
    resetsAt: parseResetTime(week.resetTime),
  } : null;
  if (!fiveHour && !weekly) return err('kimi', 'parse', 'Kimi 响应没有 5h/7d 限额');
  return { ok: true, provider: 'kimi', windows: { fiveHour, weekly }, fetchedAt: Date.now() };
}

function parseOpenrouterResponse(json: unknown): QuotaResult {
  const obj = json as Record<string, any> | null;
  const data = obj && obj.data;
  if (!data || typeof data !== 'object') return err('openrouter', 'parse', 'data 字段缺失');
  const total = Number(data.total_credits);
  const used = Number(data.total_usage);
  if (!Number.isFinite(total) || !Number.isFinite(used)) {
    return err('openrouter', 'parse', 'total_credits / total_usage 不是数字');
  }
  return {
    ok: true,
    provider: 'openrouter',
    balance: { amount: total - used, currency: 'USD' },
    fetchedAt: Date.now(),
  };
}

function parseZhipuResponse(json: unknown): QuotaResult {
  const obj = json as Record<string, any> | null;
  if (!obj || typeof obj !== 'object') return err('zhipu', 'parse', '智谱响应不是对象');
  if (obj.success === false) return err('zhipu', 'server_error', `智谱 success=false · ${obj.msg || ''}`);
  const data = obj.data;
  if (!data || !Array.isArray(data.limits)) return err('zhipu', 'parse', 'data.limits 缺失');
  // unit=3 → 5h window, unit=6 → weekly window
  const fiveHr = data.limits.find((l: any) => l && (l.unit === 3 || l.unit === '3'));
  const weekly = data.limits.find((l: any) => l && (l.unit === 6 || l.unit === '6'));
  if (!fiveHr && !weekly) return err('zhipu', 'parse', '找不到 unit=3 (5h) 或 unit=6 (周) 的 limit');
  const pick = (w: any): QuotaWindow | null => w ? {
    usedPercent: typeof w.percentage === 'number' ? w.percentage : (Number(w.usage) > 0 ? Math.round((Number(w.usage) - Number(w.remaining)) / Number(w.usage) * 100) : null),
    limit: Number(w.usage) || 0,
    remaining: Number(w.remaining) || 0,
    resetsAt: parseEndTime(w.nextResetTime),
  } : null;
  return { ok: true, provider: 'zhipu', windows: { fiveHour: pick(fiveHr), weekly: pick(weekly) }, fetchedAt: Date.now() };
}

function parseQnaigcResponse(json: unknown): QuotaResult {
  const obj = json as Record<string, any> | null;
  if (!obj || typeof obj !== 'object') return err('qnaigc', 'parse', 'qnaigc 响应不是对象');
  if (obj.status !== true) return err('qnaigc', 'server_error', 'qnaigc status!=true');
  const entry = Array.isArray(obj.data) ? obj.data[0] : undefined;
  if (!entry) return err('qnaigc', 'parse', 'data 字段为空');
  const sub = entry.subscription || {};
  const pick = (w: any, limitFromSub: number): QuotaWindow | null => {
    if (!w || typeof limitFromSub !== 'number' || limitFromSub <= 0) return null;
    const consumed = Number(w.consumed_credits) || 0;
    const remaining = Number(w.remaining_credits) || 0;
    const total = consumed + remaining;
    return {
      usedPercent: total > 0 ? Math.max(0, Math.round((consumed / total) * 100)) : null,
      limit: limitFromSub,
      remaining,
      resetsAt: parseResetTime(w.window_end),
    };
  };
  const fiveHour = pick(entry.usage_4h, sub.credit_limit_per_4h);
  const monthly = pick(entry.usage_month, sub.credit_limit_per_month);
  if (!fiveHour && !monthly) return err('qnaigc', 'parse', 'usage_4h / usage_month 都缺失');
  return { ok: true, provider: 'qnaigc', windows: { fiveHour, weekly: monthly }, fetchedAt: Date.now() };
}

// ---------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------

interface CacheEntry {
  value: QuotaResult;
  expiresAt: number;
  streak: number;
}

const cache = new Map<string, CacheEntry>();

function computeBackoffMs(streak: number): number {
  if (streak <= 0) return 0;
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, streak - 1));
}

function classifyHttpStatus(status: number): QuotaErrorKind {
  if (status === 429) return 'rate_limited';
  if (status === 401 || status === 403) return 'auth_failed';
  return 'server_error';
}

/**
 * Fetch the usage/quota for a model's route. The provider is detected from the
 * route's target URL host; models routed to unknown hosts return
 * kind='unsupported'. Results are cached per (provider, apiKey).
 */
export async function getModelQuota(route: Pick<ModelRouteConfig, 'targetUrl' | 'apiKey'>): Promise<QuotaResult> {
  const provider = detectProvider(route.targetUrl);
  if (!provider) {
    return err('unknown', 'unsupported', `no usage endpoint for ${route.targetUrl}`);
  }
  const spec = PROVIDERS[provider];
  if (!route.apiKey) {
    return err(provider, 'unconfigured', `${provider} route has no api_key configured`);
  }

  const cacheKey = `${provider}:${route.apiKey}`;
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let result: QuotaResult;
  try {
    const response = await fetch(spec.usageUrl, {
      method: 'GET',
      headers: {
        Authorization: spec.authStyle === 'raw' ? route.apiKey : `Bearer ${route.apiKey}`,
        Accept: 'application/json',
      },
      signal: createUpstreamAbortSignal(REQUEST_TIMEOUT_MS),
    });
    const body = await response.text();
    if (!response.ok) {
      result = {
        ok: false,
        provider,
        kind: classifyHttpStatus(response.status),
        httpStatus: response.status,
        message: `HTTP ${response.status} · ${body.slice(0, 200)}`,
        fetchedAt: Date.now(),
      };
    } else {
      const { json, error } = parseJsonBody(body);
      result = error ? err(provider, 'parse', error) : spec.parse(json);
    }
  } catch (e) {
    result = err(provider, 'network', (e as Error).message);
  }

  if (result.ok) {
    cache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS, streak: 0 });
  } else {
    const streak = (cached?.streak ?? 0) + 1;
    cache.set(cacheKey, { value: result, expiresAt: Date.now() + computeBackoffMs(streak), streak });
  }
  return result;
}

/** Drop cached results (e.g. after a config reload changed keys). */
export function clearQuotaCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// Anthropic 5h unified utilization (passive, from real traffic)
// ---------------------------------------------------------------------------
// Anthropic-compatible upstreams report the account-wide 5h-window used
// fraction (0-1) in the `anthropic-ratelimit-unified-5h-utilization` response
// header (same source as pi-proxy). Recorded per model on every upstream
// response that carries it; no active polling.

const ANTHROPIC_RATE_LIMIT_HEADER = 'anthropic-ratelimit-unified-5h-utilization';

const upstreamRateLimits = new Map<string, { utilization: number; recordedAt: number }>();
// Same recordings additionally keyed by upstream hostname, so the web
// dashboard's per-base-URL quota column can aggregate anthropic models.
const upstreamRateLimitsByHost = new Map<string, { utilization: number; recordedAt: number }>();

export function recordUpstreamRateLimit(
  model: string | undefined,
  getHeader: (name: string) => string | null | undefined,
  sourceUrl?: string,
): void {
  if (!model) return;
  const raw = getHeader(ANTHROPIC_RATE_LIMIT_HEADER);
  if (typeof raw !== 'string' || raw.length === 0) return;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n)) return;
  const rec = { utilization: n, recordedAt: Date.now() };
  upstreamRateLimits.set(model, rec);
  if (sourceUrl) {
    try {
      upstreamRateLimitsByHost.set(new URL(sourceUrl).hostname, rec);
    } catch { /* non-URL source — model-keyed entry only */ }
  }
}

/** Usage-left percent derived from the last recorded utilization header,
 *  e.g. "37%" — null when the model has no recorded value yet. */
export function getUpstreamRateLimitLeft(model: string): string | null {
  const rec = upstreamRateLimits.get(model);
  if (!rec) return null;
  return formatLeftPercent(rec.utilization);
}

/** Same, keyed by upstream base URL / host (for the dashboard's per-base-URL
 *  usage-left column). */
export function getUpstreamRateLimitLeftForUrl(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const rec = upstreamRateLimitsByHost.get(host);
  if (!rec) return null;
  return formatLeftPercent(rec.utilization);
}

function formatLeftPercent(utilization: number): string {
  return `${Math.max(0, Math.round((1 - utilization) * 100))}%`;
}

// ---------------------------------------------------------------------------
// Display formatting
// ---------------------------------------------------------------------------

export function formatResetsIn(resetsAt: number | null | undefined): string {
  if (typeof resetsAt !== 'number' || !resetsAt) return '';
  const ms = resetsAt - Date.now();
  if (ms <= 0) return '即将重置';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${m}m 重置` : `${m}m 重置`;
}

/** One-line quota summary for the TUI message line, e.g.
 *  "minimax 5h 42% (1h12m 重置) | 7d 71%" or "deepseek ¥43.97". */
export function formatQuota(result: QuotaResult): string {
  if (!result.ok) {
    return `${result.provider} quota ⚠ ${result.kind ?? 'error'}: ${result.message ?? ''}`;
  }
  if (result.balance) {
    const symbol = result.balance.currency === 'CNY' ? '¥' : result.balance.currency === 'USD' ? '$' : `${result.balance.currency} `;
    return `${result.provider} ${symbol}${result.balance.amount.toFixed(2)}`;
  }
  const parts: string[] = [];
  const w = result.windows ?? {};
  if (w.fiveHour) {
    parts.push(`5h ${w.fiveHour.usedPercent != null ? w.fiveHour.usedPercent + '%' : '—'}${formatResetsIn(w.fiveHour.resetsAt) ? ' (' + formatResetsIn(w.fiveHour.resetsAt) + ')' : ''}`);
  }
  if (w.weekly) {
    parts.push(`7d ${w.weekly.usedPercent != null ? w.weekly.usedPercent + '%' : '—'}`);
  }
  return `${result.provider}${parts.length ? ' ' + parts.join(' | ') : ''}`;
}

/** Compact "usage left" number for inline suffixes, e.g. "(58%)",
 *  "(6930/12000, 42%)", "(¥43.97)". Prefers the 5h window, falls back to
 *  weekly, then balance. Count-based windows render as remaining/limit plus
 *  the used percent when known.
 *  Returns null when nothing numeric is available. */
export function formatQuotaLeft(result: QuotaResult): string | null {
  if (!result.ok) return null;
  if (result.balance) {
    const symbol = result.balance.currency === 'CNY' ? '¥' : result.balance.currency === 'USD' ? '$' : `${result.balance.currency} `;
    return `${symbol}${result.balance.amount.toFixed(2)}`;
  }
  const w = result.windows?.fiveHour ?? result.windows?.weekly;
  if (!w) return null;
  if (w.remainingPercent != null) return `${w.remainingPercent}%`;
  if (w.remaining != null) {
    if (typeof w.limit !== 'number' || w.limit <= 0) return `${w.remaining}`;
    return w.usedPercent != null ? `${w.remaining}/${w.limit}, ${w.usedPercent}%` : `${w.remaining}/${w.limit}`;
  }
  return null;
}
