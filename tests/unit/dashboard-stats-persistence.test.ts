import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearCompositeLimit,
  dumpTodayTokens,
  getBlockedTools,
  getCompositeAliasTokenUsage,
  getModelTotalTokens,
  getTokenHeatmapStatsMonthly,
  getToolUsageDumpDesc,
  isStatsPersistenceEnabled,
  loadTokenStatsFromLog,
  recordModelUsage,
  setStatsPersistenceEnabled,
  unblockTool,
} from '../../src/utils/dashboard-stats.js';

const originalCwd = process.cwd();
const originalPersistence = isStatsPersistenceEnabled();
const originalDashboard = process.env.DASHBOARD;
let tempDir = '';

function localDate(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mpv3-stats-persistence-'));
  process.chdir(tempDir);
  process.env.DASHBOARD = 'true';
  setStatsPersistenceEnabled(true);
});

afterEach(() => {
  process.chdir(originalCwd);
  setStatsPersistenceEnabled(originalPersistence);
  if (originalDashboard === undefined) delete process.env.DASHBOARD;
  else process.env.DASHBOARD = originalDashboard;
  for (const name of getBlockedTools()) unblockTool(name);
  clearCompositeLimit('__restored_composite__');
  rmSync(tempDir, { recursive: true, force: true });
});

describe('dashboard stats JSONL persistence', () => {
  it('restores the latest model/tool snapshot and deduplicated current heatmap events', () => {
    const nowMs = Date.now();
    const nowSec = Math.floor(nowMs / 1000);
    const today = localDate(nowMs);
    const modelEntry = {
      model: '__restored_model__', requests: 2, failed_requests: 1,
      input_tokens: 8, cached_tokens: 1, cache_written_tokens: 0,
      output_tokens: 4, total_tokens: 13,
    };
    const current = {
      date: today,
      timestamp: nowSec,
      lastDumpTs: 0,
      modelStats: [modelEntry],
      toolStats: [{ name: '__restored_tool__', agent: 'agent', req: 2, resp: 3, len: 40, blocked: 1 }],
      heatmapEvents: {
        models: { restored: '__restored_model__' },
        sequences: [{ ts: nowSec, values: 5, id: 'restored' }],
      },
      compositeAliasStates: {
        __restored_composite__: { limit: 100, duration: '1h', events: [{ ts: nowSec, tokens: 5 }] },
      },
    };
    writeFileSync('model_proxy_tokens.jsonl', [
      '{malformed',
      JSON.stringify({ date: '2000-01-01', timestamp: 1, modelStats: [{ ...modelEntry, total_tokens: 999 }] }),
      JSON.stringify({ ...current, timestamp: nowSec - 10, modelStats: [{ ...modelEntry, total_tokens: 999 }] }),
      JSON.stringify(current),
      JSON.stringify({ date: today, timestamp: nowSec, lastDumpTs: 0, heatmapEvents: current.heatmapEvents }),
      '',
    ].join('\n'), 'utf8');

    loadTokenStatsFromLog(30);

    assert.equal(getModelTotalTokens('__restored_model__'), 13);
    assert.equal(getCompositeAliasTokenUsage('__restored_composite__', []), 5);
    assert.equal(getBlockedTools().has('__restored_tool__'), true);
    const tool = getToolUsageDumpDesc().find((row) => row.name === '__restored_tool__');
    assert.ok(tool);
    assert.equal(tool.req, 2);
    assert.equal(tool.resp, 3);
    assert.equal(tool.len, 40);
    const heatmap = getTokenHeatmapStatsMonthly().filter((row) => row.values === 5);
    assert.equal(heatmap.length, 1);
  });

  it('appends a full current-day snapshot with model, tool, and heatmap data', () => {
    recordModelUsage('__dump_model__', { input_tokens: 7, output_tokens: 3, total_tokens: 10 });
    dumpTodayTokens();

    const lines = readFileSync('model_proxy_tokens.jsonl', 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.date, localDate(Date.now()));
    assert.equal(typeof record.timestamp, 'number');
    assert.ok(record.modelStats.some((row: any) => row.model === '__dump_model__' && row.total_tokens === 10));
    assert.ok(Array.isArray(record.toolStats));
    assert.ok(record.heatmapEvents.sequences.some((row: any) => row.values === 10));
    const dumpedEvent = record.heatmapEvents.sequences.find((row: any) => row.values === 10);
    assert.equal(record.heatmapEvents.models[dumpedEvent.id], '__dump_model__');
  });
});
