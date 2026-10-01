/**
 * Unit tests for dashboard-stats.ts windowing helpers and composite alias
 * token-limit storage.
 *
 * Covers: parseWindowSpec, getWindowCutoff (sliding + calendar month/week),
 * recordCompositeTokenUsage + getCompositeAliasTokenUsage (event-log based,
 * sliding and calendar boundary semantics), pruning.
 *
 * Run with: npx tsx --test tests/unit/dashboard-stats.test.ts
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseWindowSpec,
  getWindowCutoff,
  setWeekStartDay,
  setCompositeLimit,
  clearCompositeLimit,
  recordCompositeTokenUsage,
  getCompositeAliasTokenUsage,
  compositeAliasStates,
  type WindowSpec,
} from '../../src/utils/dashboard-stats.js';

// ---------------------------------------------------------------------------
// parseWindowSpec
// ---------------------------------------------------------------------------

describe('parseWindowSpec', () => {
  it('classifies Nh/Nd tokens as sliding', () => {
    assert.deepEqual(parseWindowSpec('1h'), { kind: 'sliding', ms: 60 * 60 * 1000 });
    assert.deepEqual(parseWindowSpec('23h'), { kind: 'sliding', ms: 23 * 60 * 60 * 1000 });
    assert.deepEqual(parseWindowSpec('1d'), { kind: 'sliding', ms: 24 * 60 * 60 * 1000 });
    assert.deepEqual(parseWindowSpec('6d'), { kind: 'sliding', ms: 6 * 24 * 60 * 60 * 1000 });
  });

  it('classifies 1w as calendar week', () => {
    assert.deepEqual(parseWindowSpec('1w'), { kind: 'calendar', unit: 'week' });
  });

  it('classifies 1m as calendar month', () => {
    assert.deepEqual(parseWindowSpec('1m'), { kind: 'calendar', unit: 'month' });
  });
});

// ---------------------------------------------------------------------------
// getWindowCutoff — sliding
// ---------------------------------------------------------------------------

describe('getWindowCutoff (sliding)', () => {
  it('returns now - ms for sliding specs', () => {
    const now = 1_700_000_000_000;
    const cutoff = getWindowCutoff({ kind: 'sliding', ms: 60 * 60 * 1000 }, now);
    assert.equal(cutoff, now - 60 * 60 * 1000);
  });
});

// ---------------------------------------------------------------------------
// getWindowCutoff — calendar month
// ---------------------------------------------------------------------------

describe('getWindowCutoff (calendar month)', () => {
  it('returns first-of-month 00:00 local', () => {
    // 2026-08-15T13:45:00 local — cutoff should be 2026-08-01T00:00:00 local.
    const now = new Date(2026, 7, 15, 13, 45, 0).getTime();
    const expected = new Date(2026, 7, 1, 0, 0, 0).getTime();
    const cutoff = getWindowCutoff({ kind: 'calendar', unit: 'month' }, now);
    assert.equal(cutoff, expected);
  });

  it('handles January (rollover from December)', () => {
    const now = new Date(2026, 0, 5, 9, 0, 0).getTime();
    const expected = new Date(2026, 0, 1, 0, 0, 0).getTime();
    assert.equal(getWindowCutoff({ kind: 'calendar', unit: 'month' }, now), expected);
  });
});

// ---------------------------------------------------------------------------
// getWindowCutoff — calendar week
// ---------------------------------------------------------------------------

describe('getWindowCutoff (calendar week)', () => {
  // 2026-08-12 is a Wednesday. Monday-based week start = 2026-08-10.
  // Sunday-based week start = 2026-08-09.
  const wednesday = new Date(2026, 7, 12, 13, 45, 0).getTime();
  const mondayStart = new Date(2026, 7, 10, 0, 0, 0).getTime();
  const sundayStart = new Date(2026, 7, 9, 0, 0, 0).getTime();

  it('uses Monday as default week start', () => {
    setWeekStartDay('monday');
    assert.equal(
      getWindowCutoff({ kind: 'calendar', unit: 'week' }, wednesday),
      mondayStart,
    );
  });

  it('honors setWeekStartDay("sunday")', () => {
    setWeekStartDay('sunday');
    assert.equal(
      getWindowCutoff({ kind: 'calendar', unit: 'week' }, wednesday),
      sundayStart,
    );
    // restore default for subsequent tests
    setWeekStartDay('monday');
  });

  it('handles Sunday "day 0" with Monday-start offset (treats as prior Monday)', () => {
    // 2026-08-16 is a Sunday. Monday-start week = 2026-08-10.
    const sunday = new Date(2026, 7, 16, 5, 0, 0).getTime();
    const expected = new Date(2026, 7, 10, 0, 0, 0).getTime();
    setWeekStartDay('monday');
    assert.equal(getWindowCutoff({ kind: 'calendar', unit: 'week' }, sunday), expected);
  });
});

// ---------------------------------------------------------------------------
// Composite alias token storage (event log + sliding/calendar readout)
// ---------------------------------------------------------------------------

describe('composite alias token storage', () => {
  beforeEach(() => {
    // Enable mode flags so recordCompositeTokenUsage / recordTokenHeatmapEvent
    // will record events (they're gated by --dashboard/--tui/--agent/--rpc).
    process.env.DASHBOARD = 'true';
    // Isolation: clear known test aliases.
    clearCompositeLimit('__test_sliding__');
    clearCompositeLimit('__test_calendar__');
  });

  it('sums events within a sliding window and excludes aged-out events', () => {
    setCompositeLimit('__test_sliding__', 1_000_000, '1h');
    const now = Date.now();
    // Inject events at controlled timestamps: one inside the 1h window,
    // one outside (2h ago). getCompositeAliasTokenUsage must only count
    // the in-window event.
    const state = compositeAliasStates.get('__test_sliding__')!;
    state.events = [
      { ts: now - 2 * 60 * 60 * 1000, tokens: 999 }, // 2h ago — out of window
      { ts: now - 5 * 60 * 1000, tokens: 100 },       // 5m ago — in window
      { ts: now - 60 * 1000, tokens: 200 },           // 1m ago — in window
    ];
    const used = getCompositeAliasTokenUsage('__test_sliding__', ['m1']);
    assert.equal(used, 300, 'events older than the 1h sliding cutoff must be excluded');
  });

  it('calendar-month duration only sums events on/after the 1st of current month', () => {
    setCompositeLimit('__test_calendar__', 1_000_000, '1m');
    const now = Date.now();
    // Build a timestamp clearly before this month started.
    const dt = new Date(now);
    const lastMonth = new Date(dt.getFullYear(), dt.getMonth() - 1, 15, 12, 0, 0).getTime();
    const thisMonth = new Date(dt.getFullYear(), dt.getMonth(), 2, 12, 0, 0).getTime();
    const state = compositeAliasStates.get('__test_calendar__')!;
    state.events = [
      { ts: lastMonth, tokens: 999 },  // before current month — excluded
      { ts: thisMonth, tokens: 50 },   // this month — included
    ];
    const used = getCompositeAliasTokenUsage('__test_calendar__', ['m1']);
    assert.equal(used, 50, 'calendar-month cutoff must drop prior-month events');
  });

  it('falls back to all-time model totals when no state is set', () => {
    // No setCompositeLimit call — should fall back to getModelTotalTokens.
    // We can't easily seed modelStats here, so just assert it returns 0 for
    // an unknown model rather than throwing.
    const used = getCompositeAliasTokenUsage('__unknown_alias__', ['__unknown_model__']);
    assert.equal(used, 0);
  });

  it('preserves event log across setCompositeLimit (config reload)', () => {
    setCompositeLimit('__test_sliding__', 1_000, '1h');
    recordCompositeTokenUsage('__test_sliding__', 'm1', 100);
    // Simulate a config reload — limit changes but events should persist.
    setCompositeLimit('__test_sliding__', 5_000, '1h');
    const used = getCompositeAliasTokenUsage('__test_sliding__', ['m1']);
    assert.equal(used, 100, 'events should survive setCompositeLimit reload');
  });

  it('clearCompositeLimit drops state', () => {
    setCompositeLimit('__test_sliding__', 1_000, '1h');
    recordCompositeTokenUsage('__test_sliding__', 'm1', 100);
    clearCompositeLimit('__test_sliding__');
    // After clear, falls back to all-time model total (0 for unknown model).
    const used = getCompositeAliasTokenUsage('__test_sliding__', ['__unknown_model__']);
    assert.equal(used, 0);
  });
});
