import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  attachActiveRequestRelease,
  clearCompositeLimit,
  clearLiveTokens,
  consumeActiveRequestRelease,
  extractSystemAgentName,
  extractToolCountFromResponsePayload,
  extractToolNamesFromResponsePayload,
  extractUsageFromResponsePayload,
  extractUserAgentPrefix,
  formatAgentLabel,
  getActiveRequestCount,
  getCompositeAliasTokenUsage,
  getCompositeLimitWindowsSnapshot,
  getLiveTokens,
  getModelStatsDesc,
  getModelTotalTokens,
  getWeekStartDay,
  getWindowMs,
  incrementActiveRequests,
  isStatsPersistenceEnabled,
  normaliseAgent,
  recordModelFailedRequest,
  recordModelStat,
  recordModelUsageForComposites,
  resolveAgentName,
  setCompositeLimit,
  setLiveTokens,
  setStatsPersistenceEnabled,
  setWeekStartDay,
  updateCompositeAliasReverseMap,
} from '../../src/utils/dashboard-stats.js';

const originalDashboard = process.env.DASHBOARD;
const originalPersistence = isStatsPersistenceEnabled();

beforeEach(() => {
  process.env.DASHBOARD = 'true';
});

afterEach(() => {
  if (originalDashboard === undefined) delete process.env.DASHBOARD;
  else process.env.DASHBOARD = originalDashboard;
  setStatsPersistenceEnabled(originalPersistence);
  setWeekStartDay('monday');
  clearCompositeLimit('__lifecycle_sliding__');
  clearCompositeLimit('__lifecycle_calendar__');
  clearLiveTokens();
});

describe('active request and live token lifecycle', () => {
  it('releases active requests once and detaches the callback on consumption', () => {
    const initial = getActiveRequestCount();
    const release = incrementActiveRequests();
    assert.equal(getActiveRequestCount(), initial + 1);
    const response = new Response('ok');
    attachActiveRequestRelease(response, release);

    const consumed = consumeActiveRequestRelease(response);
    assert.equal(typeof consumed, 'function');
    assert.equal(consumeActiveRequestRelease(response), undefined);
    consumed!();
    consumed!();
    release();
    assert.equal(getActiveRequestCount(), initial);
  });

  it('stores and clears the current streaming token snapshot', () => {
    assert.equal(getLiveTokens(), null);
    setLiveTokens(123, 45);
    assert.deepEqual(getLiveTokens(), { input: 123, output: 45 });
    clearLiveTokens();
    assert.equal(getLiveTokens(), null);
  });

  it('reports the persistence toggle', () => {
    setStatsPersistenceEnabled(true);
    assert.equal(isStatsPersistenceEnabled(), true);
    setStatsPersistenceEnabled(false);
    assert.equal(isStatsPersistenceEnabled(), false);
  });
});

describe('window and composite lifecycle', () => {
  it('computes retention durations and rejects invalid duration tokens', () => {
    assert.equal(getWindowMs('2h'), 7_200_000);
    assert.equal(getWindowMs('3d'), 259_200_000);
    assert.equal(getWindowMs('1w'), 604_800_000);
    assert.equal(getWindowMs('1m'), 2_678_400_000);
    assert.equal(getWindowMs('bad' as any), 0);
    assert.equal(getWindowMs('2y' as any), 0);
  });

  it('updates model-to-alias routing and reports sliding window state', () => {
    setCompositeLimit('__lifecycle_sliding__', 500, '1h');
    updateCompositeAliasReverseMap({
      __lifecycle_sliding__: {
        '__lifecycle_model__': {},
        token_limit: { num: 500, duration: '1h' },
      },
    });
    recordModelUsageForComposites('__lifecycle_model__', 125);
    recordModelUsageForComposites('__unmapped_model__', 999);

    assert.equal(getCompositeAliasTokenUsage('__lifecycle_sliding__', []), 125);
    const snapshot = getCompositeLimitWindowsSnapshot().__lifecycle_sliding__;
    assert.equal(snapshot.limit, 500);
    assert.equal(snapshot.duration, '1h');
    assert.equal(snapshot.windowMs, 3_600_000);
    assert.equal(snapshot.remainingMs, 0);
    assert.equal(snapshot.accumulator, 125);
  });

  it('reports calendar month boundaries and week-start state', (t) => {
    const now = new Date(2026, 7, 15, 12).getTime();
    t.mock.timers.enable({ apis: ['Date'], now });
    setCompositeLimit('__lifecycle_calendar__', 900, '1m');
    recordModelUsageForComposites('__none__', 0);
    setWeekStartDay('sunday');
    assert.equal(getWeekStartDay(), 'sunday');

    const snapshot = getCompositeLimitWindowsSnapshot().__lifecycle_calendar__;
    assert.equal(snapshot.windowStartMs, new Date(2026, 7, 1).getTime());
    assert.equal(snapshot.remainingMs, new Date(2026, 8, 1).getTime() - now);
    assert.equal(snapshot.accumulator, 0);
  });
});

describe('agent identification', () => {
  it('extracts user-agent prefixes and normalizes system text', () => {
    assert.equal(extractUserAgentPrefix(null), 'unknown');
    assert.equal(extractUserAgentPrefix('   '), 'unknown');
    assert.equal(extractUserAgentPrefix('ClaudeCode/1.2 other'), 'claudecode');
    assert.equal(extractUserAgentPrefix('curl'), 'curl');
    assert.equal(extractSystemAgentName({ system: [{ text: ' You   are\nOpenClaw ' }, { text: 'agent' }] }), 'You are OpenClaw');
    assert.equal(extractSystemAgentName({}), 'unknown');
  });

  it('resolves, formats, and normalizes structured agent identities', () => {
    assert.deepEqual(resolveAgentName({ system: 'You are Hermes' }, 'claudecode'), { prefix: 'hermes', ua: 'claudecode' });
    assert.deepEqual(resolveAgentName({}, 'claudecode'), { prefix: 'claudecode', ua: 'claudecode' });
    assert.deepEqual(resolveAgentName({ system: 'Custom system' }, 'unknown'), { prefix: 'Custom system', ua: 'unknown' });
    assert.equal(formatAgentLabel({ prefix: 'hermes', ua: 'claudecode' }), 'hermes/claudecode');
    assert.equal(formatAgentLabel({ prefix: 'same', ua: 'same' }), 'same');
    assert.equal(formatAgentLabel({ prefix: 'unknown', ua: 'unknown' }), 'unknown');
    assert.deepEqual(normaliseAgent('legacy'), { prefix: 'legacy', ua: 'unknown' });
    assert.deepEqual(normaliseAgent({ prefix: '', ua: '' }), { prefix: 'unknown', ua: 'unknown' });
  });
});

describe('response payload and model stats', () => {
  it('extracts tool names/counts and Claude usage from nested responses', () => {
    const payload = {
      content: [{ type: 'tool_use', name: 'claude_tool' }],
      choices: [{ message: { tool_calls: [{ function: { name: 'openai_tool' } }] } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 3 },
        prompt_cache_miss_tokens: 2,
      },
    };
    assert.deepEqual(extractToolNamesFromResponsePayload(payload).sort(), ['claude_tool', 'openai_tool']);
    assert.equal(extractToolCountFromResponsePayload(payload), 2);
    assert.deepEqual(extractUsageFromResponsePayload(payload), {
      input_tokens: 10,
      cached_tokens: 3,
      cache_written_tokens: 2,
      output_tokens: 4,
      total_tokens: 19,
    });
    assert.deepEqual(extractToolNamesFromResponsePayload(null), ['none']);
    assert.equal(extractUsageFromResponsePayload({ usage: {} }), undefined);
  });

  it('extracts Gemini usage including cache metadata', () => {
    assert.deepEqual(extractUsageFromResponsePayload({
      usageMetadata: { promptTokenCount: 8, cachedContentTokenCount: 2, candidatesTokenCount: 3 },
    }), { input_tokens: 8, cached_tokens: 2, cache_written_tokens: 0, output_tokens: 3, total_tokens: 11 });
  });

  it('walks nested Responses items and alternate usage/cache fields', () => {
    const payload = {
      response: {
        output: [
          { type: 'function_call', name: 'responses_tool' },
          { type: 'message', content: [{ type: 'tool_use', name: 'nested_claude_tool' }] },
        ],
        message: { tool_calls: [{ function: { name: 'nested_openai_tool' } }] },
      },
      usage: {
        total_input_tokens: 7,
        total_output_tokens: 3,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 1,
      },
    };
    assert.deepEqual(extractToolNamesFromResponsePayload(payload).sort(), [
      'nested_claude_tool', 'nested_openai_tool', 'responses_tool',
    ]);
    assert.equal(extractToolCountFromResponsePayload(payload), 3);
    assert.deepEqual(extractUsageFromResponsePayload(payload), {
      input_tokens: 7, cached_tokens: 2, cache_written_tokens: 1,
      output_tokens: 3, total_tokens: 13,
    });
  });

  it('normalizes model keys and accumulates usage and failures', () => {
    const model = '__lifecycle_stats_model__';
    recordModelStat(`${model}: https://upstream.example`, {
      input_tokens: 10,
      cached_tokens: 2,
      cache_written_tokens: 1,
      output_tokens: 5,
      total_tokens: 18,
    });
    recordModelFailedRequest(model);
    assert.equal(getModelTotalTokens(model), 18);
    const row = getModelStatsDesc().find((entry) => entry.model === model);
    assert.ok(row);
    assert.equal(row.requests, 1);
    assert.equal(row.failed_requests, 1);
    assert.equal(row.total_tokens, 18);
  });

  it('ignores malformed response nodes and deduplicates names without losing occurrences', () => {
    const payload = {
      tool_calls: [null, { function: { name: ' alpha ' } }, { function: { name: 'alpha' } }, {}],
      content: [null, { type: 'tool_use', name: ' beta ' }, { type: 'text', text: 'ignore' }],
      output: [
        null,
        { type: 'function_call', name: 'gamma' },
        { type: 'message', content: [{ type: 'tool_use', name: 'beta' }] },
      ],
      choices: [null, { message: { tool_calls: [{ function: { name: 'delta' } }] } }],
    };

    assert.deepEqual(extractToolNamesFromResponsePayload(payload), ['alpha', 'beta', 'gamma', 'delta']);
    assert.equal(extractToolCountFromResponsePayload(payload), 7);
    assert.equal(extractToolCountFromResponsePayload('not-an-object'), 0);
  });

  it('aggregates request characters for duplicate tools and skips invalid definitions', async () => {
    const { extractToolRequestCharLengthsFromBody } = await import('../../src/utils/dashboard-stats.js');
    const systemText = 'Use alpha and beta';
    const alphaDirect = { name: 'alpha', description: 'direct' };
    const alphaOpenAI = { type: 'function', function: { name: 'alpha', parameters: { type: 'object' } } };
    const betaOpenAI = { type: 'function', function: { name: 'beta' } };

    const result = extractToolRequestCharLengthsFromBody({
      system: [{ text: systemText }],
      tools: [null, alphaDirect, alphaOpenAI, betaOpenAI, { type: 'function', function: {} }],
    });

    assert.deepEqual(result, [
      {
        tool_name: 'alpha',
        request_chars: JSON.stringify(alphaDirect).length + JSON.stringify(alphaOpenAI).length + systemText.length * 2,
      },
      { tool_name: 'beta', request_chars: JSON.stringify(betaOpenAI).length + systemText.length },
    ]);
    assert.deepEqual(extractToolRequestCharLengthsFromBody({ tools: [] }), []);
  });
});
