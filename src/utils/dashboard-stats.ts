import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { dirname } from 'path';
import { stringify } from './stringify.js';
import type { TokenLimitDuration } from './config-loader.js';
import { isSlidingDuration } from './config-loader.js';

export type UsageStats = {
  input_tokens?: number;
  cached_tokens?: number;
  cache_written_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

export type ModelStatsEntry = {
  model: string;
  requests: number;
  failed_requests: number;
  input_tokens: number;
  cached_tokens: number;
  cache_written_tokens: number;
  output_tokens: number;
  total_tokens: number;
};

type AgentStatsEntry = {
  key: string;
  uses: number;
};

type ToolUsageStatsEntry = {
  tool_name: string;
  in_requests: number;
  in_responses: number;
  in_request_chars: number;
};

// On-disk dump shape: per (tool, agent) row with shortened keys and a
// `blocked` flag (1 = currently in blockedTools set, 0 = not blocked).
type DumpedToolStatsEntry = {
  name: string;
  agent: string;
  req: number;
  resp: number;
  len: number;
  blocked: number;
};

type ToolRequestStatsEntry = {
  tool_name: string;
  request_chars: number;
};

type RequestEndpointStatsEntry = {
  endpoint: string;
  requests: number;
};

type RequestUpstreamStatsEntry = {
  upstream_base_url: string;
  responses: number;
};

type RequestStatusCodeStatsEntry = {
  status_code: number;
  responses: number;
};

type UpstreamResponseToolStatsEntry = {
  tool_name: string;
  tools: number;
};

type RequestEndpointTimingStatsEntry = {
  endpoint: string;
  max_time_ms: number;
  min_time_ms: number;
  total_time_ms: number;
  count: number;
};

// NOTE: timestamp is stored in SECONDS precision in the JSONL file (saves 3 chars/entry),
// but kept in MILLISECONDS precision in memory — callers must convert accordingly.
type TokenHeatmapEvent = {
  timestamp: number;
  values: number;
  id?: string;
};

// ── Heatmap model id registry ──────────────────────────────────────────────────
// Model names are stored in the JSONL as compact hex ids; the `models` map
// on each row maps the id back to the name. We use 4 hex chars (16 bits) —
// enough for 65k unique ids, far more than any realistic model fleet.
const modelIdByName = new Map<string, string>();
const modelNameById = new Map<string, string>();
const MODEL_ID_HEX_LEN = 4;

function getOrAssignModelId(model: string): string {
  const existing = modelIdByName.get(model);
  if (existing) return existing;
  const id = createHash('sha256').update(model).digest('hex').slice(0, MODEL_ID_HEX_LEN);
  modelIdByName.set(model, id);
  modelNameById.set(id, model);
  return id;
}

const TOKEN_HEATMAP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;   // heatmap rendering: 7 days
const TOKEN_RETENTION_WINDOW_MS = 31 * 24 * 60 * 60 * 1000; // event retention for enforcement: 31d (covers max calendar month)

// Tools in this set are blocked: future stat recording is skipped for them.
// Existing (pre-block) counts are preserved but stop growing.
const blockedTools = new Set<string>();

export function blockTool(toolName: string): void {
  blockedTools.add(toolName);
}

export function unblockTool(toolName: string): void {
  blockedTools.delete(toolName);
}

export function isToolBlocked(toolName: string): boolean {
  return blockedTools.has(toolName);
}

export function getBlockedTools(): Set<string> {
  return blockedTools;
}

// These must be declared before the daily token helpers that reference dailyTokenStats
const modelStats = new Map<string, ModelStatsEntry>();
const agentStats = new Map<string, AgentStatsEntry>();
const toolRequestChars = new Map<string, number>();
const requestEndpointStats = new Map<string, RequestEndpointStatsEntry>();
const requestUpstreamStats = new Map<string, RequestUpstreamStatsEntry>();
const requestStatusCodeToEndpointStats = new Map<number, RequestStatusCodeStatsEntry>();
const requestStatusCodeFromUpstreamStats = new Map<number, RequestStatusCodeStatsEntry>();
const upstreamResponseToolStats = new Map<string, UpstreamResponseToolStatsEntry>();
const requestEndpointTimingStats = new Map<string, RequestEndpointTimingStatsEntry>();
const requestModelTimingStats = new Map<string, RequestEndpointTimingStatsEntry>();
const tokenHeatmapEvents: TokenHeatmapEvent[] = [];
// Tracks the in-memory event timestamp when last heatmap delta was written.
// Used to write only new events since last dump (delta-only).
let lastHeatmapDumpTs = 0;

// ── getTokensInWindow incremental cache ────────────────────────────────────────
// tokenHeatmapEvents is append-only and sorted by ascending timestamp.
// Events before `windowSumCutoff` never change, so their total is cached in
// `windowSumFrozen`. getTokensInWindow only needs to scan the live tail
// (events after windowSumCutoff) plus add windowSumFrozen.
// windowSumCutoff is stored in milliseconds, matching tokenHeatmapEvents.timestamp.
let windowSumFrozen = 0;
let windowSumCutoff = 0; // ms; 0 = cache is empty, rebuild on first call

// ── Composite token limit windows ───────────────────────────────────────────────

/**
 * Internal runtime state for a composite alias limit. The cutoff is derived
 * from `duration` + the current time (via parseWindowSpec/getWindowCutoff),
 * so we do not persist a `windowStartMs` or `accumulator` — we keep the
 * per-alias event log and compute the in-window sum on read.
 */
interface CompositeAliasState {
  limit: number;
  duration: TokenLimitDuration;
  events: Array<{ ts: number; tokens: number }>; // ascending by ts
}

// Retention bound for per-alias event arrays. Must be >= the longest possible
// calendar window (31d for `1m`).
const COMPOSITE_RETENTION_MS = 31 * 24 * 60 * 60 * 1000;

export const compositeAliasStates = new Map<string, CompositeAliasState>();

// Reverse map: target model name → composite alias names that include it
const modelToCompositeAliases = new Map<string, Set<string>>();

export function getWindowMs(duration: TokenLimitDuration): number {
  // Sliding-equivalent duration used for retention sizing and "max possible span"
  // calculations. For calendar tokens (1w, 1m) we return the longest span the
  // window could cover so callers retain enough history.
  const m = duration.match(/^(\d+)([hdwm])$/);
  if (!m) return 0;
  const count = parseInt(m[1], 10);
  const unit = m[2];
  if (unit === 'h') return count * 60 * 60 * 1000;
  if (unit === 'd') return count * 24 * 60 * 60 * 1000;
  if (unit === 'w') return 7 * 24 * 60 * 60 * 1000;
  if (unit === 'm') return 31 * 24 * 60 * 60 * 1000; // worst-case calendar month
  return 0;
}

// ── Window spec & cutoff (sliding vs calendar) ──────────────────────────────────

export type WindowSpec =
  | { kind: 'sliding'; ms: number }
  | { kind: 'calendar'; unit: 'week' | 'month' };

let weekStartDay: 'monday' | 'sunday' = 'monday';

export function setWeekStartDay(d: 'monday' | 'sunday'): void {
  weekStartDay = d;
}

export function getWeekStartDay(): 'monday' | 'sunday' {
  return weekStartDay;
}

/**
 * Convert a duration token into a WindowSpec. Sliding tokens (Nh, Nd) roll
 * continuously from `now`; calendar tokens (1w, 1m) anchor to wall-clock
 * boundaries (week_start_day 00:00, first-of-month 00:00).
 */
export function parseWindowSpec(d: TokenLimitDuration): WindowSpec {
  if (isSlidingDuration(d)) {
    return { kind: 'sliding', ms: getWindowMs(d) };
  }
  if (d === '1w') return { kind: 'calendar', unit: 'week' };
  return { kind: 'calendar', unit: 'month' };
}

/**
 * Compute the inclusive lower-bound cutoff timestamp for a window spec.
 * Events with `timestamp >= cutoff` are in-window.
 */
export function getWindowCutoff(spec: WindowSpec, now: number = Date.now()): number {
  if (spec.kind === 'sliding') return now - spec.ms;
  const dt = new Date(now);
  if (spec.unit === 'month') {
    return new Date(dt.getFullYear(), dt.getMonth(), 1).getTime();
  }
  // Calendar week: offset back to the configured week_start_day at 00:00 local.
  const day = dt.getDay(); // 0=Sun..6=Sat
  const offset = weekStartDay === 'monday'
    ? (day === 0 ? 6 : day - 1)
    : day;
  return new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - offset).getTime();
}

/**
 * Update the reverse model→alias map when composite config changes.
 * Call this from index.ts after a config reload.
 */
export function updateCompositeAliasReverseMap(
  aliases: Record<string, { token_limit?: { num: number; duration: TokenLimitDuration } }>
): void {
  modelToCompositeAliases.clear();
  for (const [alias, targets] of Object.entries(aliases)) {
    if (!targets.token_limit) continue;
    for (const model of Object.keys(targets).filter((k) => k !== 'token_limit')) {
      if (!modelToCompositeAliases.has(model)) {
        modelToCompositeAliases.set(model, new Set());
      }
      modelToCompositeAliases.get(model)!.add(alias);
    }
  }
}

/**
 * Set or update the token limit for a composite alias. Preserves any existing
 * per-alias event log (so config reloads do not wipe in-flight usage history).
 */
export function setCompositeLimit(alias: string, limit: number, duration: TokenLimitDuration): void {
  const existing = compositeAliasStates.get(alias);
  compositeAliasStates.set(alias, {
    limit,
    duration,
    events: existing?.events ?? [],
  });
}

/**
 * Clear the token limit for a composite alias.
 */
export function clearCompositeLimit(alias: string): void {
  compositeAliasStates.delete(alias);
}

/**
 * Get the current token usage for a composite alias (tokens in current window).
 * Falls back to all-time sum of targets if no duration limit is set.
 */
export function getCompositeAliasTokenUsage(alias: string, targets: string[]): number {
  const state = compositeAliasStates.get(alias);
  if (!state) {
    // No duration limit — fall back to all-time sum (backwards compat for
    // configs that set token_limit without duration, e.g. migrated total_token_limit)
    return targets.reduce((sum, m) => sum + getModelTotalTokens(m), 0);
  }
  return sumCompositeEventsSince(state, getWindowCutoff(parseWindowSpec(state.duration)));
}

/** Helper: sum events with ts >= cutoff using binary search (events sorted ascending). */
function sumCompositeEventsSince(state: CompositeAliasState, cutoff: number): number {
  const events = state.events;
  let lo = 0, hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (events[mid].ts < cutoff) lo = mid + 1;
    else hi = mid;
  }
  let total = 0;
  for (let i = lo; i < events.length; i++) total += events[i].tokens;
  return total;
}

/**
 * Record token usage for a composite alias's window.
 * Also updates windows for all aliases that include the same model.
 */
export function recordCompositeTokenUsage(alias: string, _targetModel: string, tokenCount: number): void {
  const state = compositeAliasStates.get(alias);
  if (!state) return;
  const now = Date.now();
  state.events.push({ ts: now, tokens: tokenCount });
  // Prune head while oldest event is older than the retention bound.
  const pruneBefore = now - COMPOSITE_RETENTION_MS;
  while (state.events.length > 0 && state.events[0].ts < pruneBefore) {
    state.events.shift();
  }
}

/**
 * Record token usage for a model, updating all composite alias windows that include it.
 */
export function recordModelUsageForComposites(modelName: string, tokenCount: number): void {
  const aliases = modelToCompositeAliases.get(modelName);
  if (!aliases) return;
  for (const alias of aliases) {
    recordCompositeTokenUsage(alias, modelName, tokenCount);
  }
}

/**
 * Returns a snapshot of all composite limit windows as a plain object.
 * For each alias: `windowStartMs` is the current cutoff (derived from now),
 * `windowMs` is the full period span, `remainingMs` is ms until the next
 * boundary (0 for sliding, since sliding has no fixed reset), and
 * `accumulator` is the in-window token sum.
 *
 * Field names are retained for backwards compatibility with dashboard consumers.
 */
export function getCompositeLimitWindowsSnapshot(): Record<string, {
  limit: number;
  duration: string;
  windowStartMs: number;
  windowMs: number;
  remainingMs: number;
  accumulator: number;
}> {
  const result: Record<string, {
    limit: number;
    duration: string;
    windowStartMs: number;
    windowMs: number;
    remainingMs: number;
    accumulator: number;
  }> = {};
  const now = Date.now();
  for (const [alias, state] of compositeAliasStates) {
    const spec = parseWindowSpec(state.duration);
    const cutoff = getWindowCutoff(spec, now);
    const windowMs = getWindowMs(state.duration);
    // For calendar windows: remainingMs = ms until next boundary.
    // For sliding windows: no fixed reset point; report 0.
    let remainingMs = 0;
    if (spec.kind === 'calendar') {
      const dt = new Date(now);
      if (spec.unit === 'month') {
        const nextBoundary = new Date(dt.getFullYear(), dt.getMonth() + 1, 1).getTime();
        remainingMs = Math.max(0, nextBoundary - now);
      } else {
        const day = dt.getDay();
        const offset = weekStartDay === 'monday' ? (day === 0 ? 6 : day - 1) : day;
        const weekStart = new Date(dt.getFullYear(), dt.getMonth(), dt.getDate() - offset).getTime();
        remainingMs = Math.max(0, weekStart + 7 * 24 * 60 * 60 * 1000 - now);
      }
    }
    result[alias] = {
      limit: state.limit,
      duration: state.duration,
      windowStartMs: cutoff,
      windowMs,
      remainingMs,
      accumulator: sumCompositeEventsSince(state, cutoff),
    };
  }
  return result;
}

export const TOKEN_LOG_FILE = './model_proxy_tokens.jsonl';

// ── In-flight request tracking ─────────────────────────────────────────────────
// Tracks the number of proxy requests currently being handled. Used by the TUI
// header / terminal title to show an activity indicator. Incremented in
// src/index.ts's fetch handler after the dashboard/health preflight checks. The
// decrement is deferred until the response body has fully streamed to the client
// (handled in src/server.ts), so the count reflects true client-facing duration
// rather than just the time to obtain the upstream Response object.
let activeRequestCount = 0;

// Symbol used to smuggle the per-request release callback on the Response object
// from the fetch handler (src/index.ts) to the HTTP adapter (src/server.ts),
// which calls it once the response body has finished streaming.
const ACTIVE_REQUEST_RELEASE = Symbol('activeRequestRelease');

// Marks a request as in-flight and returns a release callback. The callback is
// guarded so it only ever decrements once, no matter how many times it's called
// (e.g. both a stream `close` and a `res` `close` firing for the same request).
export function incrementActiveRequests(): () => void {
  activeRequestCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (activeRequestCount > 0) activeRequestCount -= 1;
  };
}

export function attachActiveRequestRelease(response: Response, release: () => void): void {
  (response as unknown as Record<symbol, unknown>)[ACTIVE_REQUEST_RELEASE] = release;
}

// Returns and detaches the release callback previously attached to a response,
// or undefined if the request was never counted as in-flight.
export function consumeActiveRequestRelease(response: Response): (() => void) | undefined {
  const holder = response as unknown as Record<symbol, unknown>;
  const release = holder[ACTIVE_REQUEST_RELEASE] as (() => void) | undefined;
  if (release) delete holder[ACTIVE_REQUEST_RELEASE];
  return release;
}

export function getActiveRequestCount(): number {
  return activeRequestCount;
}

// ── Live in-flight token snapshot ──────────────────────────────────────────────
// Tracks input/output tokens for one active streaming request so the TUI can
// display them in the Tokens Panel header. Last-write-wins when multiple
// requests are in flight; cleared when the stream ends.
let liveTokens: { input: number; output: number } | null = null;

export function setLiveTokens(input: number, output: number): void {
  liveTokens = { input, output };
}

export function clearLiveTokens(): void {
  liveTokens = null;
}

export function getLiveTokens(): { input: number; output: number } | null {
  return liveTokens;
}

const dailyTokenStats = new Map<string, ModelStatsEntry>();

let currentDaySlot = getTodayDateStr();

function getTodayDateStr(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function getLocalDateStr(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function ensureTokenLogDir(filePath: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

type HeatmapDump = {
  models: Record<string, string>;
  sequences: Array<{ ts: number; values: number; id?: string }>;
};

function buildHeatmapDump(events: TokenHeatmapEvent[]): HeatmapDump {
  const models: Record<string, string> = {};
  const sequences: Array<{ ts: number; values: number; id?: string }> = [];
  for (const e of events) {
    if (e.id) {
      const name = modelNameById.get(e.id);
      if (name) models[e.id] = name;
    }
    sequences.push({ ts: Math.floor(e.timestamp / 1000), values: e.values, id: e.id });
  }
  return { models, sequences };
}

function dumpDailyTokens(dateStr: string): void {
  if (!persistenceEnabled) return;
  ensureTokenLogDir(TOKEN_LOG_FILE);
  const timestampSec = Math.floor(Date.now() / 1000);
  const cutoff = Date.now() - TOKEN_HEATMAP_WINDOW_MS;
  const recentEvents = tokenHeatmapEvents.filter((e) => {
    return getLocalDateStr(e.timestamp) === dateStr && e.timestamp >= cutoff;
  });

  // Serialize composite alias states (keyed by alias → {limit, duration, events}).
  // Events are persisted in second precision to match the heatmap format.
  const statesObj: Record<string, { limit: number; duration: string; events: Array<{ ts: number; tokens: number }> }> = {};
  for (const [alias, state] of compositeAliasStates) {
    statesObj[alias] = {
      limit: state.limit,
      duration: state.duration,
      events: state.events.map((e) => ({ ts: Math.floor(e.ts / 1000), tokens: e.tokens })),
    };
  }

  const logLine = JSON.stringify({
    date: dateStr,
    timestamp: timestampSec, // Unix seconds (matching heatmapEvents timestamps)
    lastDumpTs: 0, // 0 = full snapshot, load treats missing/0 as full
    modelStats: [...dailyTokenStats.values()],
    heatmapEvents: buildHeatmapDump(recentEvents),
    compositeAliasStates: statesObj,
  }) + '\n';
  writeFileSync(TOKEN_LOG_FILE, logLine, { flag: 'a' });
  // Reset: next delta dump starts from now (day rollover = fresh start)
  lastHeatmapDumpTs = timestampSec;
}

function getOrCreateDailyModelStat(model: string): ModelStatsEntry {
  return dailyTokenStats.get(model) || {
    model,
    requests: 0,
    failed_requests: 0,
    input_tokens: 0,
    cached_tokens: 0,
    cache_written_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
}

function advanceDaySlotIfNeeded(): void {
  const today = getTodayDateStr();
  if (today !== currentDaySlot) {
    // Persist the previous day only when persistence is enabled. With
    // persistence disabled the in-memory map is still cleared so today's
    // bucket starts fresh — the daily stats feed the live dashboard.
    if (persistenceEnabled) dumpDailyTokens(currentDaySlot);
    dailyTokenStats.clear();
    currentDaySlot = today;
  }
}

function recordDailyToken(model: string, usage?: UsageStats, failed = false): void {
  advanceDaySlotIfNeeded();
  const stat = getOrCreateDailyModelStat(model);
  stat.requests += 1;
  if (failed) stat.failed_requests += 1;
  stat.input_tokens += toSafeNumber(usage?.input_tokens);
  stat.cached_tokens += toSafeNumber(usage?.cached_tokens);
  stat.cache_written_tokens += toSafeNumber(usage?.cache_written_tokens);
  stat.output_tokens += toSafeNumber(usage?.output_tokens);
  stat.total_tokens += toSafeNumber(usage?.total_tokens);
  dailyTokenStats.set(model, stat);
}

export function dumpTodayTokens(): void {
  if (!persistenceEnabled) return;
  const today = getTodayDateStr();

  // Handle day rollover — persist the old day's data and reset for the new day
  if (today !== currentDaySlot) {
    dumpDailyTokens(currentDaySlot);
    dailyTokenStats.clear();
    currentDaySlot = today;
  }

  ensureTokenLogDir(TOKEN_LOG_FILE);
  const timestampSec = Math.floor(Date.now() / 1000);

  const modelEntries = [...dailyTokenStats.values()];

  // Collect heatmap events from today only, delta-only (after last dump)
  const cutoff = Date.now() - TOKEN_HEATMAP_WINDOW_MS;
  const deltaEvents = tokenHeatmapEvents.filter((e) => {
    return getLocalDateStr(e.timestamp) === today && e.timestamp > lastHeatmapDumpTs * 1000 && e.timestamp >= cutoff;
  });

  const logLine = JSON.stringify({
    date: today,
    timestamp: timestampSec, // Unix seconds (matching heatmapEvents timestamps)
    lastDumpTs: lastHeatmapDumpTs,
    modelStats: modelEntries,
    toolStats: getToolUsageDumpDesc(),
    heatmapEvents: buildHeatmapDump(deltaEvents),
  }) + '\n';
  writeFileSync(TOKEN_LOG_FILE, logLine, { flag: 'a' });
  lastHeatmapDumpTs = timestampSec;
}

type PersistedCompositeState = {
  limit: number;
  duration: string;
  events: Array<{ ts: number; tokens: number }>;
};

// Legacy shape (pre-refactor). Accepted on restore for backwards compat only —
// we cannot reconstruct an event log from an accumulator, so legacy entries
// initialize an empty event log.
type PersistedLimitWindowLegacy = {
  limit: number;
  duration: string;
  windowStartMs: number;
  accumulator: number;
};

// Stats persistence (dump to JSONL + restore from JSONL) is opt-in:
// the Node entry point calls `setStatsPersistenceEnabled(true)` when either
// TUI=1 or DUMP=1 is set. With persistence disabled, stats live only in
// memory (capped at the 30d retention window by recordTokenHeatmapEvent)
// and no file I/O happens on the hot path or at day rollover.
let persistenceEnabled = false;

export function setStatsPersistenceEnabled(enabled: boolean): void {
  persistenceEnabled = enabled;
}

export function isStatsPersistenceEnabled(): boolean {
  return persistenceEnabled;
}

let statsLoaded = false;

export function loadTokenStatsFromLog(retentionDays = 30): void {
  if (statsLoaded) return;
  statsLoaded = true;
  if (!persistenceEnabled) return;
  if (!existsSync(TOKEN_LOG_FILE)) return;
  try {
    const content = readFileSync(TOKEN_LOG_FILE, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    // Build set of last N days (YYYY-MM-DD) for efficient lookup
    // N = max(7d heatmap, global token limit window, max composite token limit window)
    const lastNDays = new Set<string>();
    for (let i = 0; i < retentionDays; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      lastNDays.add(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }

    // First pass: find the latest timestamp per date (stored as Unix seconds)
    const latestPerDate = new Map<string, number>();
    for (const line of lines) {
      try {
        const record = JSON.parse(line) as { date: string; timestamp?: string | number };
        if (!lastNDays.has(record.date)) continue;
        const ts =
          typeof record.timestamp === 'number'
            ? record.timestamp
            : typeof record.timestamp === 'string'
              ? Math.floor(new Date(record.timestamp).getTime() / 1000)
              : 0;
        const existing = latestPerDate.get(record.date);
        if (!existing || ts > existing) {
          latestPerDate.set(record.date, ts);
        }
      } catch {
        // skip malformed lines
      }
    }

    // Second pass: load data only from the latest dump per date
    const seenHeatmap = new Set<string>();
    const cutoffSec = Math.floor((Date.now() - TOKEN_RETENTION_WINDOW_MS) / 1000); // event timestamps are in sec

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as {
          date: string;
          timestamp?: string | number;
          lastDumpTs?: number;
          entries?: ModelStatsEntry[];
          modelStats?: ModelStatsEntry[];
          toolStats?: unknown;
          heatmapEvents?: unknown;
          compositeAliasStates?: Record<string, PersistedCompositeState>;
          compositeLimitWindows?: Record<string, PersistedLimitWindowLegacy>; // legacy
        };
        if (!lastNDays.has(record.date)) continue;

        // Load heatmap events from ALL rows — deduplication prevents duplicates.
        // This must come before the latest-only guard below so that a second
        // proxy instance starting on a different port (and writing a new dump
        // for today with an empty heatmap) does not cause earlier events from
        // the first instance to be skipped because they no longer live in the
        // "latest" dump for that date.
        // Backward compat:
        //   - missing / 0 lastDumpTs: include all events (old cumulative rows or new full snapshots)
        //   - > 0 lastDumpTs: delta row, include only events newer than lastDumpTs
        // The 30-day cutoff always applies.
        // Two on-disk shapes are accepted:
        //   - legacy: array of { timestamp, values, model }
        //   - current: { models: { id: name }, sequences: [{ ts, values, id }] }
        const rawEvents = record.heatmapEvents;
        type NormEvent = { timestamp: number; values: number; id?: string };
        const normalized: NormEvent[] = [];

        if (Array.isArray(rawEvents)) {
          for (const ev of rawEvents as Array<Record<string, unknown>>) {
            if (typeof ev?.timestamp !== 'number' || typeof ev?.values !== 'number') continue;
            const modelName = typeof ev.model === 'string' && ev.model ? ev.model : undefined;
            const id = modelName ? getOrAssignModelId(modelName) : undefined;
            normalized.push({ timestamp: ev.timestamp, values: ev.values, id });
          }
        } else if (rawEvents && typeof rawEvents === 'object' && Array.isArray((rawEvents as { sequences?: unknown }).sequences)) {
          const dump = rawEvents as { models?: Record<string, string>; sequences: Array<Record<string, unknown>> };
          const rowModels = dump.models ?? {};
          for (const [id, name] of Object.entries(rowModels)) {
            if (typeof id === 'string' && id && typeof name === 'string' && name) {
              modelIdByName.set(name, id);
              modelNameById.set(id, name);
            }
          }
          for (const ev of dump.sequences) {
            if (typeof ev?.ts !== 'number' || typeof ev?.values !== 'number') continue;
            const id = typeof ev.id === 'string' && ev.id ? ev.id : undefined;
            normalized.push({ timestamp: ev.ts, values: ev.values, id });
          }
        }

        if (normalized.length > 0) {
          // lastDumpTs was stored in ms (old data) or sec (new data); convert to sec for comparison
          const rawLastDumpTs = record.lastDumpTs ?? 0;
          const eventCutoffSec =
            rawLastDumpTs > 1e11 // likely ms (e.g. 1781765466424) — convert to sec
              ? Math.floor(rawLastDumpTs / 1000)
              : rawLastDumpTs;
          for (const event of normalized) {
            if (event.timestamp < cutoffSec) continue;
            if (eventCutoffSec > 0 && event.timestamp <= eventCutoffSec) continue;
            const key = `${event.timestamp}:${event.values}:${event.id ?? ''}`;
            if (seenHeatmap.has(key)) continue;
            seenHeatmap.add(key);
            tokenHeatmapEvents.push({ ...event, timestamp: event.timestamp * 1000 }); // sec → ms in memory
          }
        }

        // Load model stats, tool stats, and composite limit windows from the
        // latest dump per date only. These are cumulative snapshots; loading
        // from an earlier dump would double-count.
        const latestTs = latestPerDate.get(record.date);
        const recTs =
          typeof record.timestamp === 'number'
            ? record.timestamp
            : typeof record.timestamp === 'string'
              ? Math.floor(new Date(record.timestamp).getTime() / 1000)
              : 0;
        if (recTs !== latestTs) continue; // not the latest dump for this date, skip

        const modelEntries = record.modelStats ?? record.entries ?? [];
        for (const entry of modelEntries) {
          dailyTokenStats.set(entry.model, entry);
          // Restore the cumulative modelStats Map by ACCUMULATING across
          // the latest dump per date. Each per-date dump represents that
          // day's totals (the day-rollover dump is the authoritative
          // end-of-day snapshot), so summing them reconstructs true
          // all-time totals. Powers the TUI "Top Models" panel via
          // getModelStatsDesc(), and is also read by getModelTotalTokens()
          // for the legacy total_token_limit fallback path in
          // getCompositeAliasTokenUsage() (used when an alias has
          // token_limit but no compositeAliasStates entry — e.g. an
          // empty event log at restore time).
          const existing = modelStats.get(entry.model);
          if (existing) {
            existing.requests += toSafeNumber(entry.requests);
            existing.failed_requests += toSafeNumber(entry.failed_requests);
            existing.input_tokens += toSafeNumber(entry.input_tokens);
            existing.cached_tokens += toSafeNumber(entry.cached_tokens);
            existing.cache_written_tokens += toSafeNumber(entry.cache_written_tokens);
            existing.output_tokens += toSafeNumber(entry.output_tokens);
            existing.total_tokens += toSafeNumber(entry.total_tokens);
          } else {
            modelStats.set(entry.model, { ...entry });
          }
        }

        // Restore tool stats from the latest dump per date (full snapshot —
        // toolStats rows are cumulative, no delta tracking needed). Splits
        // each row back into the three source maps consumed by the dashboard.
        const toolEntries = record.toolStats;
        if (Array.isArray(toolEntries)) {
          for (const row of toolEntries as Array<Record<string, unknown>>) {
            const name = typeof row?.name === 'string' ? row.name.trim() : '';
            if (!name) continue;
            const agent = typeof row.agent === 'string' && row.agent ? row.agent : 'unknown';
            const req = toSafeNumber(row.req);
            const resp = toSafeNumber(row.resp);
            const len = toSafeNumber(row.len);
            if (toSafeNumber(row.blocked) === 1) {
              blockTool(name);
            }
            if (req > 0) {
              const key = `${agent} / ${name}`;
              agentStats.set(key, { key, uses: req });
            }
            if (resp > 0) {
              upstreamResponseToolStats.set(`${name}\0${agent}`, { tool_name: name, tools: resp });
            }
            if (len > 0) {
              toolRequestChars.set(`${name}\0${agent}`, len);
            }
          }
        }

        // Restore composite alias states from the latest dump per date.
        // Two on-disk shapes are accepted:
        //   - current: record.compositeAliasStates = { alias: { limit, duration, events: [{ts, tokens}] } }
        //   - legacy:  record.compositeLimitWindows = { alias: { limit, duration, windowStartMs, accumulator } }
        // For legacy entries we cannot reconstruct an event log from an accumulator,
        // so they restore with an empty events array (current window starts fresh).
        const persistedStates = record.compositeAliasStates;
        if (persistedStates && typeof persistedStates === 'object') {
          const nowMs = Date.now();
          const pruneBefore = nowMs - COMPOSITE_RETENTION_MS;
          for (const [alias, s] of Object.entries(persistedStates)) {
            const duration = s.duration as TokenLimitDuration;
            if (!(typeof s.limit === 'number') || typeof duration !== 'string') continue;
            if (!Array.isArray(s.events)) continue;
            const events = (s.events as Array<Record<string, unknown>>)
              .filter((e) => typeof e?.ts === 'number' && typeof e?.tokens === 'number')
              .map((e) => ({ ts: (e.ts as number) * 1000, tokens: e.tokens as number })) // sec → ms
              .filter((e) => e.ts >= pruneBefore)
              .sort((a, b) => a.ts - b.ts);
            compositeAliasStates.set(alias, { limit: s.limit, duration, events });
          }
        } else {
          const legacyWindows = record.compositeLimitWindows;
          if (legacyWindows && typeof legacyWindows === 'object') {
            for (const [alias, win] of Object.entries(legacyWindows)) {
              const duration = win.duration as TokenLimitDuration;
              if (!(typeof win.limit === 'number') || typeof duration !== 'string') continue;
              compositeAliasStates.set(alias, { limit: win.limit, duration, events: [] });
            }
          }
        }
      } catch {
        // skip malformed lines
      }
    }

    // Re-apply window pruning on heatmap after merge (retain N days for enforcement)
    const pruneCutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    while (tokenHeatmapEvents.length > 0 && tokenHeatmapEvents[0].timestamp < pruneCutoff) {
      tokenHeatmapEvents.shift();
    }

    currentDaySlot = getTodayDateStr();
  } catch {
    // file read error, start fresh
  }
}

function toSafeNumber(value: unknown): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 0;
  }
  return value;
}

export function extractUserAgentPrefix(userAgent: string | null): string {
  if (!userAgent) {
    return 'unknown';
  }

  const firstToken = userAgent.trim().split(/\s+/)[0] || '';
  if (!firstToken) {
    return 'unknown';
  }

  const slashIndex = firstToken.indexOf('/');
  if (slashIndex <= 0) {
    return firstToken.toLowerCase();
  }

  return firstToken.slice(0, slashIndex).toLowerCase();
}

export function extractToolNamesFromBody(body: Record<string, unknown> | undefined): string[] {
  if (!body) {
    return ['none'];
  }

  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return ['none'];
  }

  const names = new Set<string>();
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      continue;
    }

    const claudeToolName = (tool as Record<string, unknown>).name;
    if (typeof claudeToolName === 'string' && claudeToolName.trim()) {
      names.add(claudeToolName.trim());
      continue;
    }

    const openAiFunction = (tool as Record<string, unknown>).function;
    if (openAiFunction && typeof openAiFunction === 'object') {
      const openAiName = (openAiFunction as Record<string, unknown>).name;
      if (typeof openAiName === 'string' && openAiName.trim()) {
        names.add(openAiName.trim());
      }
    }
  }

  return names.size > 0 ? [...names] : ['none'];
}

function extractSystemText(body: Record<string, unknown>): string {
  const system = body.system;
  if (typeof system === 'string') {
    return system;
  }
  if (Array.isArray(system)) {
    return system
      .map((block) => (block && typeof block === 'object' ? (block as Record<string, unknown>).text : ''))
      .filter((text) => typeof text === 'string' && text.length > 0)
      .join('\n');
  }
  return '';
}

/**
 * Summarise a request body to a stable agent name by taking a short prefix of
 * the `system` content. The system prompt is the closest thing to a stable,
 * human-meaningful identifier across providers — different clients
 * (Cline/Continue/Roo/etc.) ship distinctive system prompts, so a 16-char
 * prefix is enough to tell them apart while staying compact for stat keys.
 *
 * Returns 'unknown' when the system content is missing or empty so callers
 * always have a non-empty key for the stats map.
 */
export function extractSystemAgentName(body: Record<string, unknown> | undefined, prefixLength: number = 16): string {
  if (!body) {
    return 'unknown';
  }
  const systemText = extractSystemText(body);
  // Collapse internal whitespace so a 16-char slice doesn't land mid-token
  // and so multi-line system prompts reduce to a meaningful leading fragment.
  const normalized = systemText.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return 'unknown';
  }
  return normalized.slice(0, prefixLength);
}

/**
 * Map a system-content prefix to a stable, human-friendly agent identifier.
 * The raw prefix is too noisy to display ("You are Herm..."), so we match
 * leading fragments against known client system prompts and return a tag
 * like "openclaw/hermes" when a match hits.
 *
 * Each matcher is `(prefix) => matched | null`. Order matters — first hit wins.
 * Unrecognised prefixes fall through to the User-Agent prefix (and finally
 * to the raw system prefix as a last resort) so we never lose information.
 */
type SystemPrefixMatcher = (prefix: string) => string | null;

const SYSTEM_AGENT_MATCHERS: SystemPrefixMatcher[] = [
  // OpenClaw framework — "openclaw" anywhere in the prefix.
  (prefix) => (prefix.toLowerCase().includes('openclaw') ? 'openclaw' : null),
  // Hermes client — "hermes" anywhere in the prefix.
  (prefix) => (prefix.toLowerCase().includes('hermes') ? 'hermes' : null),
  // Add more known clients here. Each matcher returns a stable tag.
  (prefix) => (prefix.toLowerCase().includes('opencode') ? 'opencode' : null),
  (prefix) => (prefix.toLowerCase().includes('deepcode') ? 'deepcode' : null),
  (prefix) => (prefix.toLowerCase().includes('nanobot') ? 'nanobot' : null),
  (prefix) => (/pi[- ]/i.test(prefix) ? 'pi' : null),
  (prefix) => (prefix.toLowerCase().includes('omp') ? 'omp' : null),
  (prefix) => (prefix.toLowerCase().includes('buddy') ? 'buddy' : null),
];

/**
 * Resolved agent identifier split into its two contributing pieces so callers
 * can display them separately (e.g. "<prefix>/<ua>" in the TUI Tool Blocklist)
 * or aggregate by either dimension.
 *
 * - `prefix` is the matched client tag from the system-content matchers
 *   (`openclaw`, `hermes`, ...). Falls back to the raw 16-char system
 *   fragment, then to the User-Agent prefix. Always non-empty.
 * - `ua` is the User-Agent prefix from the request headers. May be
 *   `'unknown'` when no User-Agent was sent.
 */
export type ResolvedAgent = {
  prefix: string;
  ua: string;
};

/**
 * Render a {@link ResolvedAgent} as `"<prefix>/<ua>"`. Empty / `unknown`
 * halves are dropped so we don't show `"unknown/unknown"` or `"openclaw/"`
 * for requests missing one side.
 */
export function formatAgentLabel(agent: ResolvedAgent): string {
  const { prefix, ua } = agent;
  const p = prefix && prefix !== 'unknown' ? prefix : '';
  const u = ua && ua !== 'unknown' ? ua : '';
  if (p && u && p !== u) return `${p}/${u}`;
  return p || u || 'unknown';
}

/**
 * Coerce either a {@link ResolvedAgent} or a legacy single-string agent into
 * the `{ prefix, ua }` shape. Legacy strings (older callers, on-disk dumps
 * restored from before the split) are treated as the `prefix` half with
 * `ua: 'unknown'`. Used by the record* helpers to keep the public API
 * backwards-compatible while the new code paths pass the structured form.
 */
export function normaliseAgent(agent: ResolvedAgent | string): ResolvedAgent {
  if (typeof agent === 'string') {
    return { prefix: agent || 'unknown', ua: 'unknown' };
  }
  return {
    prefix: agent.prefix || 'unknown',
    ua: agent.ua || 'unknown',
  };
}

export function resolveAgentName(
  body: Record<string, unknown> | undefined,
  userAgentPrefix: string,
  prefixLength: number = 16,
): ResolvedAgent {
  const systemPrefix = extractSystemAgentName(body, prefixLength);
  const ua = userAgentPrefix && userAgentPrefix !== 'unknown' ? userAgentPrefix : 'unknown';

  if (systemPrefix !== 'unknown') {
    for (const matcher of SYSTEM_AGENT_MATCHERS) {
      const tag = matcher(systemPrefix);
      if (tag) {
        return { prefix: tag, ua };
      }
    }
  }

  // No system-content match — fall back to the User-Agent prefix on the
  // prefix side so we still have a meaningful tag, and keep the UA on `ua`.
  if (ua !== 'unknown') {
    return { prefix: ua, ua };
  }

  // Last resort: the raw system prefix is still more informative than nothing.
  return { prefix: systemPrefix, ua: 'unknown' };
}

export function extractToolRequestCharLengthsFromBody(body: Record<string, unknown> | undefined): Array<{ tool_name: string; request_chars: number }> {
  if (!body) {
    return [];
  }

  const tools = body.tools;
  if (!Array.isArray(tools) || tools.length === 0) {
    return [];
  }

  const systemText = extractSystemText(body);
  const totals = new Map<string, number>();

  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') {
      continue;
    }

    const record = tool as Record<string, unknown>;
    const claudeToolName = typeof record.name === 'string' && record.name.trim()
      ? record.name.trim()
      : undefined;
    const openAiFunction = record.function && typeof record.function === 'object'
      ? (record.function as Record<string, unknown>)
      : undefined;
    const openAiName = typeof openAiFunction?.name === 'string' && openAiFunction.name.trim()
      ? openAiFunction.name.trim()
      : undefined;
    const toolName = claudeToolName || openAiName;
    if (!toolName) {
      continue;
    }

    let requestChars = stringify(record).length;
    if (systemText && systemText.includes(toolName)) {
      requestChars += systemText.length;
    }
    totals.set(toolName, (totals.get(toolName) ?? 0) + requestChars);
  }

  return [...totals.entries()].map(([tool_name, request_chars]) => ({ tool_name, request_chars }));
}

function addToolName(names: string[], value: unknown): boolean {
  if (typeof value === 'string' && value.trim()) {
    names.push(value.trim());
    return true;
  }

  return false;
}

function collectToolNamesFromResponseNode(node: unknown, names: string[]): void {
  if (!node || typeof node !== 'object') {
    return;
  }

  const record = node as Record<string, unknown>;

  if (Array.isArray(record.tool_calls)) {
    for (const toolCall of record.tool_calls) {
      if (!toolCall || typeof toolCall !== 'object') {
        continue;
      }
      const fn = (toolCall as Record<string, unknown>).function;
      if (fn && typeof fn === 'object') {
        addToolName(names, (fn as Record<string, unknown>).name);
      }
    }
  }

  if (Array.isArray(record.content)) {
    for (const block of record.content) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      if ((block as Record<string, unknown>).type === 'tool_use') {
        addToolName(names, (block as Record<string, unknown>).name);
      }
    }
  }

  if (Array.isArray(record.output)) {
    for (const item of record.output) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const outputItem = item as Record<string, unknown>;
      if (outputItem.type === 'function_call') {
        addToolName(names, outputItem.name);
      }
      if (outputItem.type === 'message') {
        collectToolNamesFromResponseNode(outputItem, names);
      }
    }
  }

  if (record.message && typeof record.message === 'object') {
    collectToolNamesFromResponseNode(record.message, names);
  }

  if (Array.isArray(record.choices)) {
    for (const choice of record.choices) {
      if (!choice || typeof choice !== 'object') {
        continue;
      }
      collectToolNamesFromResponseNode((choice as Record<string, unknown>).message, names);
    }
  }

  if (record.response && typeof record.response === 'object') {
    collectToolNamesFromResponseNode(record.response, names);
  }
}

export function extractToolNamesFromResponsePayload(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') {
    return ['none'];
  }

  const names: string[] = [];
  collectToolNamesFromResponseNode(payload, names);
  return names.length > 0 ? names : ['none'];
}

function countToolOccurrencesFromResponseNode(node: unknown): number {
  if (!node || typeof node !== 'object') {
    return 0;
  }

  const record = node as Record<string, unknown>;
  let count = 0;

  if (Array.isArray(record.tool_calls)) {
    count += record.tool_calls.filter((toolCall) => toolCall && typeof toolCall === 'object').length;
  }

  if (Array.isArray(record.content)) {
    for (const block of record.content) {
      if (!block || typeof block !== 'object') {
        continue;
      }
      if ((block as Record<string, unknown>).type === 'tool_use') {
        count += 1;
      }
    }
  }

  if (Array.isArray(record.output)) {
    for (const item of record.output) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const outputItem = item as Record<string, unknown>;
      if (outputItem.type === 'function_call') {
        count += 1;
      }
      if (outputItem.type === 'message') {
        count += countToolOccurrencesFromResponseNode(outputItem);
      }
    }
  }

  if (record.message && typeof record.message === 'object') {
    count += countToolOccurrencesFromResponseNode(record.message);
  }

  if (Array.isArray(record.choices)) {
    for (const choice of record.choices) {
      if (!choice || typeof choice !== 'object') {
        continue;
      }
      count += countToolOccurrencesFromResponseNode((choice as Record<string, unknown>).message);
    }
  }

  if (record.response && typeof record.response === 'object') {
    count += countToolOccurrencesFromResponseNode(record.response);
  }

  return count;
}

export function extractToolCountFromResponsePayload(payload: unknown): number {
  if (!payload || typeof payload !== 'object') {
    return 0;
  }

  return countToolOccurrencesFromResponseNode(payload);
}

export function extractUsageFromResponsePayload(payload: unknown): UsageStats | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const root = payload as Record<string, unknown>;

  // Claude / OpenAI / Interactions usage object
  const usage = root.usage;
  if (usage && typeof usage === 'object') {
    const usageRecord = usage as Record<string, unknown>;

    const input_tokens = toSafeNumber(
      usageRecord.input_tokens ?? usageRecord.total_input_tokens ?? usageRecord.prompt_tokens
    );

    const cached_tokens = toSafeNumber(
      usageRecord.cache_read_input_tokens ??
      usageRecord.prompt_cache_hit_tokens ??
      (usageRecord.prompt_tokens_details && typeof usageRecord.prompt_tokens_details === 'object'
        ? (usageRecord.prompt_tokens_details as Record<string, unknown>).cached_tokens
        : undefined) ??
      (usageRecord.input_tokens_details && typeof usageRecord.input_tokens_details === 'object'
        ? (usageRecord.input_tokens_details as Record<string, unknown>).cached_tokens
        : undefined)
    );

    const cache_written_tokens = toSafeNumber(
      usageRecord.cache_creation_input_tokens ??
      usageRecord.prompt_cache_miss_tokens
    );

    const output_tokens = toSafeNumber(
      usageRecord.output_tokens ?? usageRecord.total_output_tokens ?? usageRecord.completion_tokens
    );

    const total_tokens = toSafeNumber(
      usageRecord.total_tokens ?? (input_tokens + cached_tokens + cache_written_tokens + output_tokens)
    );

    if (input_tokens === 0 && cached_tokens === 0 && cache_written_tokens === 0 && output_tokens === 0 && total_tokens === 0) {
      return undefined;
    }

    return { input_tokens, cached_tokens, cache_written_tokens, output_tokens, total_tokens };
  }

  // Gemini usageMetadata object
  const usageMetadata = root.usageMetadata;
  if (usageMetadata && typeof usageMetadata === 'object') {
    const metadata = usageMetadata as Record<string, unknown>;
    const input_tokens = toSafeNumber(metadata.promptTokenCount);
    // Gemini's promptTokenCount INCLUDES the cached portion; cachedContentTokenCount is a subset of it.
    const cached_tokens = toSafeNumber(metadata.cachedContentTokenCount);
    const output_tokens = toSafeNumber(metadata.candidatesTokenCount ?? metadata.responseTokenCount);
    const total_tokens = toSafeNumber(metadata.totalTokenCount ?? (input_tokens + output_tokens));

    if (input_tokens === 0 && cached_tokens === 0 && output_tokens === 0 && total_tokens === 0) {
      return undefined;
    }

    return {
      input_tokens,
      cached_tokens,
      cache_written_tokens: 0,
      output_tokens,
      total_tokens,
    };
  }

  return undefined;
}

function normalizeModelStatKey(model: string): string {
  const suffixMatch = model.match(/^(.*?):\s+https?:\/\/.+$/);
  return suffixMatch ? suffixMatch[1] : model;
}

function getOrCreateModelStat(model: string): ModelStatsEntry {
  const normalizedModel = normalizeModelStatKey(model);
  return modelStats.get(normalizedModel) || {
    model: normalizedModel,
    requests: 0,
    failed_requests: 0,
    input_tokens: 0,
    cached_tokens: 0,
    cache_written_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
  };
}

/**
 * Get accumulated total_tokens for a model (0 if no usage recorded yet).
 */
export function getModelTotalTokens(model: string | undefined): number {
  if (!model) return 0;
  const entry = modelStats.get(normalizeModelStatKey(model));
  return entry ? entry.total_tokens : 0;
}

export function recordModelFailedRequest(model: string | undefined): void {
  if (!model) {
    return;
  }

  const normalizedModel = normalizeModelStatKey(model);
  const current = getOrCreateModelStat(normalizedModel);
  current.failed_requests += 1;
  modelStats.set(normalizedModel, current);
  recordDailyToken(normalizedModel, undefined, true);
}

export function recordModelStat(model: string | undefined, usage?: UsageStats): void {
  if (!model) {
    return;
  }

  const normalizedModel = normalizeModelStatKey(model);
  const current = getOrCreateModelStat(normalizedModel);
  current.requests += 1;
  current.input_tokens += toSafeNumber(usage?.input_tokens);
  current.cached_tokens += toSafeNumber(usage?.cached_tokens);
  current.cache_written_tokens += toSafeNumber(usage?.cache_written_tokens);
  current.output_tokens += toSafeNumber(usage?.output_tokens);
  current.total_tokens += toSafeNumber(usage?.total_tokens);
  modelStats.set(normalizedModel, current);
  recordDailyToken(normalizedModel, usage);
}

function recordTokenHeatmapEvent(values: number, timestamp = Date.now(), model?: string): void {
  if (!Number.isFinite(values) || values <= 0) {
    return;
  }

  // Truncate to second precision so events with the same model+values+second are deduplicable
  const secTimestamp = Math.floor(timestamp / 1000) * 1000;
  const id = model ? getOrAssignModelId(model) : undefined;
  tokenHeatmapEvents.push({ timestamp: secTimestamp, values, id });
  const cutoff = secTimestamp - TOKEN_RETENTION_WINDOW_MS;
  while (tokenHeatmapEvents.length > 0 && tokenHeatmapEvents[0].timestamp < cutoff) {
    tokenHeatmapEvents.shift();
  }
}

export function recordModelUsage(model: string | undefined, usage?: UsageStats): void {
  if (!model || !usage) {
    return;
  }

  const normalizedModel = normalizeModelStatKey(model);
  const current = getOrCreateModelStat(normalizedModel);
  current.input_tokens += toSafeNumber(usage.input_tokens);
  current.cached_tokens += toSafeNumber(usage.cached_tokens);
  current.cache_written_tokens += toSafeNumber(usage.cache_written_tokens);
  current.output_tokens += toSafeNumber(usage.output_tokens);
  current.total_tokens += toSafeNumber(usage.total_tokens);
  modelStats.set(normalizedModel, current);
  recordTokenHeatmapEvent(toSafeNumber(usage.total_tokens), Date.now(), normalizedModel);
  recordDailyToken(normalizedModel, usage);
}

export function recordAgentStat(agent: ResolvedAgent | string, toolNames: string[]): void {
  const { prefix, ua } = normaliseAgent(agent);
  const effectiveTools = toolNames.length > 0 ? toolNames : ['none'];

  for (const toolName of effectiveTools) {
    if (blockedTools.has(toolName)) continue;
    // \0 separator keeps prefix and ua independently recoverable from the key.
    const key = `${prefix}\0${ua} / ${toolName}`;
    const current = agentStats.get(key) || { key, uses: 0 };
    current.uses += 1;
    agentStats.set(key, current);
  }
}

export function recordToolRequestChars(
  toolChars: Array<{ tool_name: string; request_chars: number }>,
  agent: ResolvedAgent | string = { prefix: '', ua: '' },
): void {
  if (!Array.isArray(toolChars) || toolChars.length === 0) {
    return;
  }

  const { prefix, ua } = normaliseAgent(agent);
  const agentPart = prefix || ua ? `\0${prefix}\0${ua}` : '';

  for (const entry of toolChars) {
    if (!entry || typeof entry.tool_name !== 'string' || !entry.tool_name.trim()) {
      continue;
    }
    const toolName = entry.tool_name.trim();
    if (blockedTools.has(toolName)) continue;
    const requestChars = Number.isFinite(entry.request_chars) ? Math.max(0, Math.floor(entry.request_chars)) : 0;
    const key = agentPart ? `${toolName}${agentPart}` : toolName;
    toolRequestChars.set(key, (toolRequestChars.get(key) ?? 0) + requestChars);
  }
}


export function getModelStatsDesc(): ModelStatsEntry[] {
  return [...modelStats.values()].sort((a, b) => {
    if (b.requests !== a.requests) {
      return b.requests - a.requests;
    }

    const aTokens = a.total_tokens;
    const bTokens = b.total_tokens;
    if (bTokens !== aTokens) {
      return bTokens - aTokens;
    }

    return a.model.localeCompare(b.model);
  });
}

/**
 * Create a TransformStream that intercepts SSE streaming data to capture
 * token usage from Claude SSE events (message_start.usage.input_tokens
 * and message_delta.usage.output_tokens). Records usage via recordModelUsage
 * when the stream ends. Also records composite alias window tokens if compositeAlias is set.
 */
export function createUsageTrackingTransformStream(
  model: string,
  compositeAlias?: string,
  onUsage?: (usage: UsageStats, responseBody?: string) => void,
  collectBody?: boolean,
): TransformStream<Uint8Array, Uint8Array> {
  let inputTokens = 0;
  let cachedTokens = 0;
  let cacheWrittenTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let foundUsage = false;
  let remainder = '';
  const decoder = new TextDecoder();
  // When record_response_body is enabled, accumulate the decoded SSE text so the full
  // response body can be forwarded to the stats sidecar in flush().
  let collectedBody = '';
  const shouldCollect = collectBody === true;

  return new TransformStream({
    transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
      // Normalize CRLF -> LF so SSE frames delimited by "\r\n\r\n" (the
      // spec-compliant form used by many Anthropic-compatible upstreams)
      // are split correctly. Without this, a trailing "\r" ends up inside
      // the data line and JSON.parse silently throws in the catch below,
      // dropping the message_start frame (so input_tokens stays 0 while
      // message_delta's output_tokens still records).
      const decoded = decoder.decode(chunk, { stream: true });
      if (shouldCollect) collectedBody += decoded;
      const text = (remainder + decoded).replace(/\r\n/g, '\n');
      const parts = text.split('\n\n');
      remainder = parts.pop() || '';

      for (const part of parts) {
        // Match Claude SSE event name
        const eventLine = part.match(/^event: (.+)$/m);
        const dataLine = part.match(/^data: ?(.+?)\r?$/m);
        if (eventLine && dataLine) {
          const eventType = eventLine[1];
          try {
            const data = JSON.parse(dataLine[1]);
            if (eventType === 'message_start' && data.message?.usage) {
              const usage = data.message.usage;
              if (typeof usage.input_tokens === 'number') {
                inputTokens = usage.input_tokens;
                foundUsage = true;
              }
              if (typeof usage.cache_read_input_tokens === 'number') {
                cachedTokens = usage.cache_read_input_tokens;
                foundUsage = true;
              }
              if (typeof usage.cache_creation_input_tokens === 'number') {
                cacheWrittenTokens = usage.cache_creation_input_tokens;
                foundUsage = true;
              }
              if (inputTokens > 0 || outputTokens > 0) setLiveTokens(inputTokens, outputTokens);
            } else if (eventType === 'message_delta' && data.usage) {
              const usage = data.usage;
              if (typeof usage.output_tokens === 'number') {
                outputTokens = usage.output_tokens;
                foundUsage = true;
              }
              if (typeof usage.input_tokens === 'number') {
                inputTokens = usage.input_tokens;
                foundUsage = true;
              }
              if (typeof usage.cache_read_input_tokens === 'number') {
                cachedTokens = usage.cache_read_input_tokens;
                foundUsage = true;
              }
              if (typeof usage.cache_creation_input_tokens === 'number') {
                cacheWrittenTokens = usage.cache_creation_input_tokens;
                foundUsage = true;
              }
              if (inputTokens > 0 || outputTokens > 0) setLiveTokens(inputTokens, outputTokens);
            } else if (
              (eventType === 'response.completed' || eventType === 'response.in_progress') &&
              data.response?.usage
            ) {
              // Responses API SSE — usage lives under data.response.usage
              const usage = data.response.usage;
              if (typeof usage.input_tokens === 'number') {
                inputTokens = usage.input_tokens;
                foundUsage = true;
              }
              if (typeof usage.output_tokens === 'number') {
                outputTokens = usage.output_tokens;
                foundUsage = true;
              }
              if (typeof usage.total_tokens === 'number') {
                totalTokens = usage.total_tokens;
                foundUsage = true;
              }
              const details = usage.input_tokens_details;
              if (details && typeof details === 'object' && typeof details.cached_tokens === 'number') {
                cachedTokens = details.cached_tokens;
                foundUsage = true;
              }
              if (inputTokens > 0 || outputTokens > 0) setLiveTokens(inputTokens, outputTokens);
            }
          } catch {
            // Not JSON data, skip
          }
        } else if (dataLine && !eventLine) {
          // OpenAI-style SSE (no event: line) — check data for usage
          try {
            const dataText = dataLine[1].trim();
            if (dataText === '[DONE]') {
              continue;
            }
            const data = JSON.parse(dataText);
            if (data.usageMetadata) {
              // Gemini :streamGenerateContent?alt=sse chunks — usage lives in
              // usageMetadata (running totals; the final chunk is authoritative).
              const metadata = data.usageMetadata as Record<string, unknown>;
              const pt = toSafeNumber(metadata.promptTokenCount);
              const ct = toSafeNumber(metadata.candidatesTokenCount);
              if (pt > 0 || ct > 0) {
                inputTokens = pt;
                outputTokens = ct;
                totalTokens = toSafeNumber(metadata.totalTokenCount);
                const cached = toSafeNumber(metadata.cachedContentTokenCount);
                if (cached > 0) cachedTokens = cached;
                foundUsage = true;
                setLiveTokens(inputTokens, outputTokens);
              }
            } else if (data.usage) {
              const usage = data.usage as Record<string, unknown>;
              const pt = toSafeNumber(usage.prompt_tokens);
              const ct = toSafeNumber(usage.completion_tokens);
              const tt = toSafeNumber(usage.total_tokens);
              const pch = toSafeNumber(usage.prompt_cache_hit_tokens);
              const pcm = toSafeNumber(usage.prompt_cache_miss_tokens);
              const ptd = usage.prompt_tokens_details;
              const ptdCached = ptd && typeof ptd === 'object'
                ? toSafeNumber((ptd as Record<string, unknown>).cached_tokens)
                : 0;
              const itd = usage.input_tokens_details;
              const itdCached = itd && typeof itd === 'object'
                ? toSafeNumber((itd as Record<string, unknown>).cached_tokens)
                : 0;
              if (pt > 0 || ct > 0) {
                inputTokens = pt;
                outputTokens = ct;
                totalTokens = tt;
                const cached = pch || ptdCached || itdCached;
                if (cached > 0) cachedTokens = cached;
                if (pcm > 0) cacheWrittenTokens = pcm;
                foundUsage = true;
                setLiveTokens(inputTokens, outputTokens);
              }
            }
          } catch {
            // Not JSON data, skip
          }
        }
      }

      controller.enqueue(chunk);
    },
    flush() {
      if (foundUsage) {
        const computedTotal = inputTokens + cachedTokens + cacheWrittenTokens + outputTokens;
        const usageObj = {
          input_tokens: inputTokens > 0 ? inputTokens : undefined,
          cached_tokens: cachedTokens > 0 ? cachedTokens : undefined,
          cache_written_tokens: cacheWrittenTokens > 0 ? cacheWrittenTokens : undefined,
          output_tokens: outputTokens > 0 ? outputTokens : undefined,
          total_tokens: totalTokens > 0 ? totalTokens : (computedTotal > 0 ? computedTotal : undefined),
        };
        recordModelUsage(model, usageObj);
        onUsage?.(usageObj, shouldCollect ? collectedBody : undefined);
        if (compositeAlias && usageObj.total_tokens) {
          recordCompositeTokenUsage(compositeAlias, model, usageObj.total_tokens);
        }
      }
    },
  });
}

export function recordRequestEndpoint(endpoint: string): void {
  if (!endpoint) {
    return;
  }

  const current = requestEndpointStats.get(endpoint) || { endpoint, requests: 0 };
  current.requests += 1;
  requestEndpointStats.set(endpoint, current);
}

export function recordRequestTiming(endpoint: string, elapsedMs: number): void {
  if (!endpoint || typeof elapsedMs !== 'number' || elapsedMs < 0) {
    return;
  }

  const current: RequestEndpointTimingStatsEntry = requestEndpointTimingStats.get(endpoint) || { endpoint, max_time_ms: 0, min_time_ms: Infinity, total_time_ms: 0, count: 0 };
  if (elapsedMs > current.max_time_ms) {
    current.max_time_ms = elapsedMs;
  }
  if (elapsedMs < current.min_time_ms) {
    current.min_time_ms = elapsedMs;
  }
  current.total_time_ms += elapsedMs;
  current.count += 1;
  requestEndpointTimingStats.set(endpoint, current);
}

export function getRequestEndpointTimingStatsDesc(): (RequestEndpointTimingStatsEntry & { avg_time_ms: number })[] {
  return [...requestEndpointTimingStats.values()].sort((a, b) => {
    if (b.max_time_ms !== a.max_time_ms) {
      return b.max_time_ms - a.max_time_ms;
    }
    return a.endpoint.localeCompare(b.endpoint);
  }).map((entry) => ({
    ...entry,
    avg_time_ms: entry.count > 0 ? Math.round(entry.total_time_ms / entry.count) : 0,
  }));
}

export function recordModelTiming(model: string | undefined, elapsedMs: number): void {
  if (!model || typeof elapsedMs !== 'number' || elapsedMs < 0) {
    return;
  }

  const normalizedModel = normalizeModelStatKey(model);
  const current: RequestEndpointTimingStatsEntry = requestModelTimingStats.get(normalizedModel) || { endpoint: normalizedModel, max_time_ms: 0, min_time_ms: Infinity, total_time_ms: 0, count: 0 };
  if (elapsedMs > current.max_time_ms) {
    current.max_time_ms = elapsedMs;
  }
  if (elapsedMs < current.min_time_ms) {
    current.min_time_ms = elapsedMs;
  }
  current.total_time_ms += elapsedMs;
  current.count += 1;
  requestModelTimingStats.set(normalizedModel, current);
}

export function getRequestModelTimingStatsDesc(): (RequestEndpointTimingStatsEntry & { avg_time_ms: number })[] {
  return [...requestModelTimingStats.values()].sort((a, b) => {
    if (b.max_time_ms !== a.max_time_ms) {
      return b.max_time_ms - a.max_time_ms;
    }
    return a.endpoint.localeCompare(b.endpoint);
  }).map((entry) => ({
    ...entry,
    avg_time_ms: entry.count > 0 ? Math.round(entry.total_time_ms / entry.count) : 0,
  }));
}

export function getTokenHeatmapStatsDesc(): Array<{ weekday: number; hour: number; values: number }> {
  const cutoff = Date.now() - TOKEN_HEATMAP_WINDOW_MS;
  const buckets = new Map<string, { weekday: number; hour: number; values: number }>();

  for (const event of tokenHeatmapEvents) {
    if (event.timestamp < cutoff) {
      continue;
    }

    const date = new Date(event.timestamp);
    const weekday = date.getDay();
    const hour = date.getHours();
    const key = `${weekday}:${hour}`;
    const current = buckets.get(key) || { weekday, hour, values: 0 };
    current.values += event.values;
    buckets.set(key, current);
  }

  return [...buckets.values()].sort((a, b) => {
    if (a.weekday !== b.weekday) {
      return a.weekday - b.weekday;
    }
    if (a.hour !== b.hour) {
      return a.hour - b.hour;
    }
    return a.values - b.values;
  });
}

export function getTokenHeatmapStatsMonthly(): Array<{ day: number; values: number }> {
  const cutoff = Date.now() - TOKEN_HEATMAP_WINDOW_MS;
  const buckets = new Map<number, number>();

  for (const event of tokenHeatmapEvents) {
    if (event.timestamp < cutoff) {
      continue;
    }

    const day = new Date(event.timestamp).getDate();
    buckets.set(day, (buckets.get(day) ?? 0) + event.values);
  }

  return [...buckets.entries()]
    .map(([day, values]) => ({ day, values }))
    .sort((a, b) => a.day - b.day);
}

/**
 * Sum tokens from events with `timestamp >= cutoffMs`. Uses the same
 * incremental cache as getTokensInWindow — events aged out of the window
 * are absorbed into `windowSumFrozen` so subsequent calls only scan the
 * live tail. Supports both sliding cutoffs (`now - ms`) and calendar
 * cutoffs (start-of-week / start-of-month).
 */
export function getTokensInWindowSince(cutoff: number): number {
  // tokenHeatmapEvents is append-only (within the 31d retention window) and
  // sorted by ascending timestamp.  Events before `cutoff` are immutable —
  // their sum is cached in `windowSumFrozen` / `windowSumCutoff` so we only
  // need to scan the live tail on each call instead of the full array.
  //
  // Pruning (shift) only removes events older than 31d, which are always
  // outside any query window (max duration is `1m` ≈ 31d), so the frozen
  // sum is never invalidated by pruning.

  if (windowSumCutoff > 0) {
    // Binary-search for the first event at or after the previous boundary so
    // we only walk events added since the last call.
    let lo = 0;
    let hi = tokenHeatmapEvents.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (tokenHeatmapEvents[mid].timestamp < windowSumCutoff) lo = mid + 1;
      else hi = mid;
    }
    // Absorb events in [lo, ...) that are now before the new cutoff into the frozen sum.
    let i = lo;
    for (; i < tokenHeatmapEvents.length; i++) {
      if (tokenHeatmapEvents[i].timestamp >= cutoff) break;
      windowSumFrozen += tokenHeatmapEvents[i].values;
    }
    windowSumCutoff = cutoff;
    // Sum the remaining live tail.
    let total = windowSumFrozen;
    for (let j = i; j < tokenHeatmapEvents.length; j++) {
      total += tokenHeatmapEvents[j].values;
    }
    return total;
  }

  // Cold start: split the array at cutoff, cache the frozen portion.
  let i = 0;
  for (; i < tokenHeatmapEvents.length; i++) {
    if (tokenHeatmapEvents[i].timestamp >= cutoff) break;
    windowSumFrozen += tokenHeatmapEvents[i].values;
  }
  windowSumCutoff = cutoff;
  let total = windowSumFrozen;
  for (let j = i; j < tokenHeatmapEvents.length; j++) {
    total += tokenHeatmapEvents[j].values;
  }
  return total;
}

/**
 * Sliding-window convenience: sum tokens in the last `durationMs`.
 * Equivalent to getTokensInWindowSince(Date.now() - durationMs).
 */
export function getTokensInWindow(durationMs: number): number {
  return getTokensInWindowSince(Date.now() - durationMs);
}

function normalizeUpstreamBaseUrl(urlLike: string): string {
  try {
    const parsed = new URL(urlLike);
    return parsed.origin;
  } catch {
    return urlLike;
  }
}

export function recordResponseUpstream(upstreamBaseUrl: string): void {
  if (!upstreamBaseUrl) {
    return;
  }

  const normalized = normalizeUpstreamBaseUrl(upstreamBaseUrl);
  const current = requestUpstreamStats.get(normalized) || { upstream_base_url: normalized, responses: 0 };
  current.responses += 1;
  requestUpstreamStats.set(normalized, current);
}

export function recordResponseStatusCodeToEndpoint(statusCode: number): void {
  if (!Number.isInteger(statusCode)) {
    return;
  }

  const current = requestStatusCodeToEndpointStats.get(statusCode) || { status_code: statusCode, responses: 0 };
  current.responses += 1;
  requestStatusCodeToEndpointStats.set(statusCode, current);
}

export function recordResponseStatusCodeFromUpstream(statusCode: number): void {
  if (!Number.isInteger(statusCode)) {
    return;
  }

  const current = requestStatusCodeFromUpstreamStats.get(statusCode) || { status_code: statusCode, responses: 0 };
  current.responses += 1;
  requestStatusCodeFromUpstreamStats.set(statusCode, current);
}

export function recordUpstreamResponseToolNames(
  toolNames: string[],
  agent: ResolvedAgent | string = { prefix: 'unknown', ua: 'unknown' },
): void {
  if (!Array.isArray(toolNames) || toolNames.length === 0) {
    return;
  }

  const { prefix, ua } = normaliseAgent(agent);
  const agentPart = prefix || ua ? `\0${prefix}\0${ua}` : '';

  for (const toolName of toolNames) {
    if (blockedTools.has(toolName)) continue;
    const key = agentPart ? `${toolName}${agentPart}` : toolName;
    const current = upstreamResponseToolStats.get(key) || { tool_name: toolName, tools: 0 };
    current.tools += 1;
    upstreamResponseToolStats.set(key, current);
  }
}

export function recordUpstreamResponseToolCount(_upstreamMode: string | undefined, _toolCount = 0): void {
  void _upstreamMode;
  void _toolCount;
}

export function getAgentStatsDesc(): AgentStatsEntry[] {
  return [...agentStats.values()].sort((a, b) => {
    if (b.uses !== a.uses) {
      return b.uses - a.uses;
    }
    return a.key.localeCompare(b.key);
  });
}

type AgentToolPanelEntry = {
  tool_name: string;
  /** Combined display label `"<prefix>/<ua>"`. Kept for backwards-compat
   *  with the dashboard HTML which renders this directly. */
  agent: string;
  /** Matched client tag from system-content (e.g. `openclaw`, `hermes`). */
  agent_prefix: string;
  /** User-Agent prefix from the request header (e.g. `cline`). */
  agent_ua: string;
  in_requests: number;
  in_responses: number;
  in_request_chars: number;
};

/**
 * Parse a `${prefix}\0${ua} / ${tool}` key back into its parts. The `\0`
 * separator is intentional — neither prefix nor ua should ever contain it
 * for real requests. Falls back to treating the whole agent half as a
 * legacy prefix when no `\0` is present (old keys from before the split).
 */
function parseAgentKey(agentHalf: string): { prefix: string; ua: string } {
  const sepIdx = agentHalf.indexOf('\0');
  if (sepIdx < 0) {
    return { prefix: agentHalf, ua: 'unknown' };
  }
  return {
    prefix: agentHalf.slice(0, sepIdx),
    ua: agentHalf.slice(sepIdx + 1),
  };
}

export function getAgentToolPanelStats(): AgentToolPanelEntry[] {
  // Build per-(tool, agent) entries from agentStats + toolRequestChars + upstreamResponseToolStats
  // agentStats key = "${prefix}\0${ua} / ${tool}"
  // toolRequestChars / upstreamResponseToolStats key = "${tool}\0${prefix}\0${ua}"
  const combined = new Map<string, AgentToolPanelEntry>();

  for (const entry of agentStats.values()) {
    const sepIdx = entry.key.lastIndexOf(' / ');
    if (sepIdx < 0) continue;
    const { prefix, ua } = parseAgentKey(entry.key.slice(0, sepIdx));
    const tool_name = entry.key.slice(sepIdx + 3);
    if (tool_name === 'none') continue;
    const rowKey = `${tool_name}\0${prefix}\0${ua}`;
    const agent = formatAgentLabel({ prefix, ua });
    const current = combined.get(rowKey) || { tool_name, agent, agent_prefix: prefix, agent_ua: ua, in_requests: 0, in_responses: 0, in_request_chars: 0 };
    current.in_requests += entry.uses;
    combined.set(rowKey, current);
  }

  // request chars are keyed by `${tool}\0${prefix}\0${ua}` (or plain `tool` for legacy)
  for (const [key, request_chars] of toolRequestChars.entries()) {
    let tool_name = key;
    let prefix = 'unknown';
    let ua = 'unknown';
    // Find the first \0 — everything before is tool_name, the rest is the
    // agent half. handle both legacy `${tool}\0${prefix}` and new
    // `${tool}\0${prefix}\0${ua}` forms.
    const firstSep = key.indexOf('\0');
    if (firstSep >= 0) {
      tool_name = key.slice(0, firstSep);
      const agentHalf = key.slice(firstSep + 1);
      const parsed = parseAgentKey(agentHalf);
      prefix = parsed.prefix;
      ua = parsed.ua;
    }
    const rowKey = `${tool_name}\0${prefix}\0${ua}`;
    const agent = formatAgentLabel({ prefix, ua });
    const current = combined.get(rowKey) || { tool_name, agent, agent_prefix: prefix, agent_ua: ua, in_requests: 0, in_responses: 0, in_request_chars: 0 };
    current.in_request_chars += request_chars;
    combined.set(rowKey, current);
  }

  // upstream response tools are keyed by `${tool}\0${prefix}\0${ua}` (or plain `tool` for legacy)
  for (const [key, entry] of upstreamResponseToolStats.entries()) {
    let tool_name = entry.tool_name;
    let prefix = 'unknown';
    let ua = 'unknown';
    const firstSep = key.indexOf('\0');
    if (firstSep >= 0) {
      tool_name = key.slice(0, firstSep);
      const agentHalf = key.slice(firstSep + 1);
      const parsed = parseAgentKey(agentHalf);
      prefix = parsed.prefix;
      ua = parsed.ua;
    }
    const rowKey = `${tool_name}\0${prefix}\0${ua}`;
    const agent = formatAgentLabel({ prefix, ua });
    const current = combined.get(rowKey) || { tool_name, agent, agent_prefix: prefix, agent_ua: ua, in_requests: 0, in_responses: 0, in_request_chars: 0 };
    current.in_responses += entry.tools;
    combined.set(rowKey, current);
  }

  return [...combined.values()].sort((a, b) => {
    const aTotal = a.in_requests + a.in_responses;
    const bTotal = b.in_requests + b.in_responses;
    if (bTotal !== aTotal) return bTotal - aTotal;
    const toolCmp = a.tool_name.localeCompare(b.tool_name);
    if (toolCmp !== 0) return toolCmp;
    const prefixCmp = a.agent_prefix.localeCompare(b.agent_prefix);
    if (prefixCmp !== 0) return prefixCmp;
    return a.agent_ua.localeCompare(b.agent_ua);
  });
}

export function getToolUsageStatsDesc(): ToolUsageStatsEntry[] {
  const combined = new Map<string, ToolUsageStatsEntry>();

  for (const entry of agentStats.values()) {
    const tool_name = entry.key.includes(' / ') ? entry.key.slice(entry.key.lastIndexOf(' / ') + 3) : entry.key;
    const current = combined.get(tool_name) || { tool_name, in_requests: 0, in_responses: 0, in_request_chars: 0 };
    current.in_requests += entry.uses;
    combined.set(tool_name, current);
  }

  // toolRequestChars keys are `${tool}\0${agent}` (or plain `tool` for legacy) — strip agent suffix
  for (const [key, request_chars] of toolRequestChars.entries()) {
    const sepIdx = key.indexOf('\0');
    const tool_name = sepIdx >= 0 ? key.slice(0, sepIdx) : key;
    const current = combined.get(tool_name) || { tool_name, in_requests: 0, in_responses: 0, in_request_chars: 0 };
    current.in_request_chars += request_chars;
    combined.set(tool_name, current);
  }

  // upstreamResponseToolStats keys are `${tool}\0${agent}` (or plain `tool` for legacy) — strip agent suffix
  for (const [key, entry] of upstreamResponseToolStats.entries()) {
    const sepIdx = key.indexOf('\0');
    const tool_name = sepIdx >= 0 ? key.slice(0, sepIdx) : entry.tool_name;
    const current = combined.get(tool_name) || { tool_name, in_requests: 0, in_responses: 0, in_request_chars: 0 };
    current.in_responses += entry.tools;
    combined.set(tool_name, current);
  }

  return [...combined.values()].sort((a, b) => {
    const aTotal = a.in_requests + a.in_responses + a.in_request_chars;
    const bTotal = b.in_requests + b.in_responses + b.in_request_chars;
    if (bTotal !== aTotal) {
      return bTotal - aTotal;
    }
    if (b.in_requests !== a.in_requests) {
      return b.in_requests - a.in_requests;
    }
    return a.tool_name.localeCompare(b.tool_name);
  });
}

/**
 * On-disk dump view of tool usage: per-(tool, agent) row with shortened keys
 * and a `blocked` flag derived from the current blockedTools set (1=blocked, 0=not).
 * Used only by `dumpTodayTokens` — the dashboard continues to consume
 * `getToolUsageStatsDesc()` for its existing field shape.
 *
 * The `agent` field is preserved in the internal `${prefix}\0${ua}` form so
 * the restore path can round-trip the split without loss. The on-disk JSON
 * encodes `\0` verbatim — harmless since real agent/ua strings won't contain
 * NUL bytes.
 */
export function getToolUsageDumpDesc(): DumpedToolStatsEntry[] {
  const combined = new Map<string, DumpedToolStatsEntry>();

  for (const entry of agentStats.values()) {
    const sepIdx = entry.key.lastIndexOf(' / ');
    if (sepIdx < 0) continue;
    const agent = entry.key.slice(0, sepIdx); // already in `${prefix}\0${ua}` form
    const name = entry.key.slice(sepIdx + 3);
    const rowKey = `${name}\0${agent}`;
    const current = combined.get(rowKey) || {
      name,
      agent,
      req: 0,
      resp: 0,
      len: 0,
      blocked: isToolBlocked(name) ? 1 : 0,
    };
    current.req += entry.uses;
    combined.set(rowKey, current);
  }

  // toolRequestChars keys are `${tool}\0${prefix}\0${ua}` (or plain `tool` for legacy)
  for (const [key, request_chars] of toolRequestChars.entries()) {
    const firstSep = key.indexOf('\0');
    const name = firstSep >= 0 ? key.slice(0, firstSep) : key;
    const agent = firstSep >= 0 ? key.slice(firstSep + 1) : 'all';
    const rowKey = `${name}\0${agent}`;
    const current = combined.get(rowKey) || {
      name,
      agent,
      req: 0,
      resp: 0,
      len: 0,
      blocked: isToolBlocked(name) ? 1 : 0,
    };
    current.len += request_chars;
    combined.set(rowKey, current);
  }

  // upstreamResponseToolStats keys are `${tool}\0${prefix}\0${ua}` (or plain `tool` for legacy)
  for (const [key, entry] of upstreamResponseToolStats.entries()) {
    const firstSep = key.indexOf('\0');
    const name = firstSep >= 0 ? key.slice(0, firstSep) : entry.tool_name;
    const agent = firstSep >= 0 ? key.slice(firstSep + 1) : 'all';
    const rowKey = `${name}\0${agent}`;
    const current = combined.get(rowKey) || {
      name,
      agent,
      req: 0,
      resp: 0,
      len: 0,
      blocked: isToolBlocked(name) ? 1 : 0,
    };
    current.resp += entry.tools;
    combined.set(rowKey, current);
  }

  return [...combined.values()].sort((a, b) => {
    const aTotal = a.req + a.resp + a.len;
    const bTotal = b.req + b.resp + b.len;
    if (bTotal !== aTotal) return bTotal - aTotal;
    if (b.req !== a.req) return b.req - a.req;
    const nameCmp = a.name.localeCompare(b.name);
    if (nameCmp !== 0) return nameCmp;
    return a.agent.localeCompare(b.agent);
  });
}

export function getRequestEndpointStatsDesc(): RequestEndpointStatsEntry[] {
  return [...requestEndpointStats.values()].sort((a, b) => {
    if (b.requests !== a.requests) {
      return b.requests - a.requests;
    }
    return a.endpoint.localeCompare(b.endpoint);
  });
}

export function getRequestUpstreamStatsDesc(): RequestUpstreamStatsEntry[] {
  return [...requestUpstreamStats.values()].sort((a, b) => {
    if (b.responses !== a.responses) {
      return b.responses - a.responses;
    }
    return a.upstream_base_url.localeCompare(b.upstream_base_url);
  });
}

function sortStatusCodeStatsDesc(entries: RequestStatusCodeStatsEntry[]): RequestStatusCodeStatsEntry[] {
  return [...entries].sort((a, b) => {
    if (b.responses !== a.responses) {
      return b.responses - a.responses;
    }
    return a.status_code - b.status_code;
  });
}

export function getRequestStatusCodeToEndpointStatsDesc(): RequestStatusCodeStatsEntry[] {
  return sortStatusCodeStatsDesc([...requestStatusCodeToEndpointStats.values()]);
}

export function getRequestStatusCodeFromUpstreamStatsDesc(): RequestStatusCodeStatsEntry[] {
  return sortStatusCodeStatsDesc([...requestStatusCodeFromUpstreamStats.values()]);
}

let privacyKeysDetectedTotal = 0;

export function recordPrivacyKeysDetected(count: number): void {
  privacyKeysDetectedTotal += count;
}

export function getPrivacyKeysDetected(): number {
  return privacyKeysDetectedTotal;
}

export function getUpstreamResponseToolStatsDesc(): UpstreamResponseToolStatsEntry[] {
  return [...upstreamResponseToolStats.values()].sort((a, b) => {
    if (b.tools !== a.tools) {
      return b.tools - a.tools;
    }
    return a.tool_name.localeCompare(b.tool_name);
  });
}

export function createResponseToolTrackingTransformStream(
  onNames: (toolNames: string[], agent: ResolvedAgent) => void,
  agent: ResolvedAgent | string = { prefix: 'unknown', ua: 'unknown' },
): TransformStream<Uint8Array, Uint8Array> {
  const resolved = normaliseAgent(agent);
  const decoder = new TextDecoder();
  let remainder = '';
  const toolNames: string[] = [];

  function collectToolNamesFromPayload(payload: unknown): void {
    if (!payload || typeof payload !== 'object') {
      return;
    }

    const root = payload as Record<string, unknown>;

    if (Array.isArray(root.choices)) {
      for (const choice of root.choices) {
        if (!choice || typeof choice !== 'object') continue;
        const delta = (choice as Record<string, unknown>).delta as Record<string, unknown> | undefined;
        if (delta && Array.isArray(delta.tool_calls)) {
          for (const toolCall of delta.tool_calls) {
            if (!toolCall || typeof toolCall !== 'object') continue;
            const fn = (toolCall as Record<string, unknown>).function;
            if (fn && typeof fn === 'object') {
              addToolName(toolNames, (fn as Record<string, unknown>).name);
            }
          }
        }
        const message = (choice as Record<string, unknown>).message;
        if (message && typeof message === 'object') {
          collectToolNamesFromPayload(message);
        }
      }
    }

    if (Array.isArray(root.output)) {
      for (const item of root.output) {
        if (!item || typeof item !== 'object') continue;
        const outputItem = item as Record<string, unknown>;
        if (outputItem.type === 'function_call') {
          addToolName(toolNames, outputItem.name);
        }
        if (outputItem.type === 'message') {
          collectToolNamesFromPayload(outputItem);
        }
      }
    }

    if (Array.isArray(root.content)) {
      for (const block of root.content) {
        if (!block || typeof block !== 'object') continue;
        if ((block as Record<string, unknown>).type === 'tool_use') {
          addToolName(toolNames, (block as Record<string, unknown>).name);
        }
      }
    }

    if (root.content_block && typeof root.content_block === 'object') {
      const contentBlock = root.content_block as Record<string, unknown>;
      if (contentBlock.type === 'tool_use') {
        addToolName(toolNames, contentBlock.name);
      }
    }

    if (root.item && typeof root.item === 'object') {
      const item = root.item as Record<string, unknown>;
      if (item.type === 'function_call') {
        addToolName(toolNames, item.name);
      }
    }
  }

  return new TransformStream({
    transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
      const text = remainder + decoder.decode(chunk, { stream: true });
      const lines = text.split('\n');
      remainder = lines.pop() || '';

      let currentEvent: string | undefined;
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          currentEvent = line.slice(7).trim();
          continue;
        }
        if (!line.startsWith('data: ')) {
          continue;
        }

        const dataText = line.slice(6).trim();
        if (dataText === '[DONE]') {
          continue;
        }

        try {
          const payload = JSON.parse(dataText);
          if (currentEvent === 'content_block_start' || currentEvent === 'response.output_item.added' || currentEvent === 'response.output_item.done' || !currentEvent) {
            collectToolNamesFromPayload(payload);
          }
        } catch {
          // ignore parse failures
        }
      }

      controller.enqueue(chunk);
    },
    flush() {
      if (toolNames.length > 0) {
        onNames(toolNames, resolved);
      }
    },
  });
}

// loadTokenStatsFromLog() is now invoked explicitly by the Node entry point
// (server.ts) after the proxy config is loaded, with a retention window
// derived from the configured token-limit durations.

// Periodic delta dump every 30 min — only runs when DUMP=1 (non-TUI mode).
// (TUI=1 mode uses the TUI's own timer instead.)
try {
  void (() => {
    if (!process.env.DUMP) return;
    let lastDumpTokenCount = 0;
    setInterval(() => {
      const totalTokens = [...dailyTokenStats.values()].reduce((sum, m) => sum + m.total_tokens, 0);
      if (totalTokens === lastDumpTokenCount) return;
      dumpTodayTokens();
      lastDumpTokenCount = totalTokens;
    }, 30 * 60 * 1000);
  })();
} catch {
  // noop in Workers runtime
}
