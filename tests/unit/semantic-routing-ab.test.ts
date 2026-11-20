import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  estimateCost,
  extractResponseText,
  extractUsage,
  parseBenchmarkConfig,
  parseJudgeResponse,
  runBenchmark,
  summarizeBenchmark,
  type BenchmarkSample,
} from '../perf/semantic-routing-ab.js';

function config() {
  return parseBenchmarkConfig({
    base_url: 'http://proxy.test/',
    decision_alias: 'bench-decision',
    random_alias: 'bench-random',
    prompts: [{ id: 'code-1', category: 'code', prompt: 'Write a function.', rubric: 'The function must work.' }],
    repeats: 2,
    prices_per_million: {
      'model-a': { input: 1, output: 2 },
      'model-b': { input: 1, output: 2 },
    },
    judge: { model: 'independent-judge' },
  });
}

function completion(model: string, content: string) {
  return {
    model,
    choices: [{ message: { role: 'assistant', content } }],
    usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
  };
}

describe('semantic routing A/B benchmark config', () => {
  it('applies defaults and validates the independent judge', () => {
    const parsed = parseBenchmarkConfig({
      base_url: 'http://127.0.0.1:8788',
      decision_alias: 'decision',
      random_alias: 'random',
      prompts: [{ id: 'one', prompt: 'Hello' }],
      judge: { model: 'judge' },
    });
    assert.equal(parsed.repeats, 1);
    assert.equal(parsed.max_tokens, 512);
    assert.equal(parsed.temperature, 0);
    assert.equal(parsed.request_timeout_ms, 120000);
    assert.equal(parsed.judge?.timeout_ms, 120000);
    assert.equal(parsed.prompts[0].category, 'general');
    assert.match(parsed.prompts[0].rubric, /correctness/i);

    assert.throws(() => parseBenchmarkConfig({
      base_url: 'http://127.0.0.1:8788',
      decision_alias: 'same',
      random_alias: 'same',
      prompts: [{ id: 'one', prompt: 'Hello' }],
    }), /must be different/);
    assert.throws(() => parseBenchmarkConfig({
      base_url: 'http://127.0.0.1:8788',
      decision_alias: 'decision',
      random_alias: 'random',
      prompts: [{ id: 'one', prompt: 'Hello' }],
      judge: { model: 'decision' },
    }), /fixed independent model/);
  });

  it('rejects duplicate prompts and invalid prices', () => {
    assert.throws(() => parseBenchmarkConfig({
      base_url: 'http://127.0.0.1:8788',
      decision_alias: 'decision',
      random_alias: 'random',
      prompts: [{ id: 'same', prompt: 'one' }, { id: 'same', prompt: 'two' }],
    }), /duplicate prompt id/);
    assert.throws(() => parseBenchmarkConfig({
      base_url: 'http://127.0.0.1:8788',
      decision_alias: 'decision',
      random_alias: 'random',
      prompts: [{ id: 'one', prompt: 'Hello' }],
      prices_per_million: { a: { input: -1, output: 1 } },
    }), /non-negative number/);
  });
});

describe('semantic routing A/B response accounting', () => {
  it('extracts content and usage and calculates token cost', () => {
    const payload = completion('model-a', 'answer');
    assert.equal(extractResponseText(payload), 'answer');
    assert.deepEqual(extractUsage(payload), { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 });
    assert.deepEqual(
      estimateCost('model-a', extractUsage(payload), { 'model-a': { input: 1, output: 2 } }),
      { cost_status: 'priced', cost_usd: 0.0002 },
    );
    assert.deepEqual(
      estimateCost('unknown', extractUsage(payload), { 'model-a': { input: 1, output: 2 } }),
      { cost_status: 'missing_price' },
    );
    assert.deepEqual(
      estimateCost('model-a', { total_tokens: 150 }, { 'model-a': { input: 1, output: 2 } }),
      { cost_status: 'usage_missing' },
    );
  });

  it('accepts only explicit judge scores from zero through one', () => {
    assert.deepEqual(parseJudgeResponse('{"score":0,"reason":"wrong"}'), { score: 0, reason: 'wrong' });
    assert.deepEqual(parseJudgeResponse('```json\n{"score":1,"reason":"correct"}\n```'), { score: 1, reason: 'correct' });
    assert.throws(() => parseJudgeResponse('{"score":1.1}'), /from 0 to 1/);
    assert.throws(() => parseJudgeResponse('{"score":"0.8"}'), /from 0 to 1/);
  });

  it('summarizes model mix, category quality, latency and failures', () => {
    const base = {
      type: 'sample', timestamp: '', alias: '', prompt_id: 'one', category: 'code', repeat: 1,
      latency_ms: 100, cost_status: 'priced',
    } as const;
    const samples: BenchmarkSample[] = [
      { ...base, arm: 'decision', status: 'success', selected_model: 'model-a', quality_score: 0.8, cost_usd: 0.2 },
      { ...base, arm: 'decision', status: 'success', selected_model: 'model-b', latency_ms: 300, quality_score: 0.4, cost_usd: 0.1 },
      { ...base, arm: 'random', status: 'error', error: 'HTTP 500' },
    ];
    const summary = summarizeBenchmark(samples);
    assert.deepEqual(summary.decision.selected_models, { 'model-a': 1, 'model-b': 1 });
    assert.equal(summary.decision.mean_latency_ms, 200);
    assert.equal(summary.decision.p95_latency_ms, 300);
    assert.ok(Math.abs(summary.decision.mean_quality_score! - 0.6) < 1e-12);
    assert.equal(summary.decision.total_cost_usd, 0.30000000000000004);
    assert.ok(Math.abs(summary.decision.by_category.code.mean_quality_score! - 0.6) < 1e-12);
    assert.equal(summary.random.failed, 1);
  });
});

describe('semantic routing A/B live runner', () => {
  it('runs paired arms, scores responses and writes raw JSONL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'semantic-routing-ab-'));
    try {
      const requestedModels: string[] = [];
      const fetchImpl: typeof fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        requestedModels.push(body.model);
        assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer test-key');
        if (body.model === 'independent-judge') {
          return new Response(JSON.stringify(completion('independent-judge', '{"score":0.8,"reason":"adequate"}')), { status: 200 });
        }
        const selected = body.model === 'bench-decision' ? 'model-a' : 'model-b';
        return new Response(JSON.stringify(completion(selected, 'candidate answer')), { status: 200 });
      };

      const outputPath = join(dir, 'results.jsonl');
      const { samples, summary } = await runBenchmark(config(), { outputPath, apiKey: 'test-key', fetchImpl });
      assert.equal(samples.length, 4);
      assert.equal(samples.filter(sample => sample.judge_error).length, 0);
      assert.deepEqual(summary.decision.selected_models, { 'model-a': 2 });
      assert.deepEqual(summary.random.selected_models, { 'model-b': 2 });
      assert.equal(summary.decision.quality_scored, 2);
      assert.equal(summary.decision.mean_quality_score, 0.8);
      assert.ok(Math.abs(summary.decision.total_cost_usd! - 0.0004) < 1e-12);

      const candidateCalls = requestedModels.filter(model => model !== 'independent-judge');
      assert.deepEqual(candidateCalls, ['bench-decision', 'bench-random', 'bench-random', 'bench-decision']);
      assert.equal(requestedModels.filter(model => model === 'independent-judge').length, 4);
      const lines = readFileSync(outputPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      assert.equal(lines[0].type, 'run');
      assert.equal(lines.filter(line => line.type === 'sample').length, 4);
      assert.equal(lines.at(-1).type, 'summary');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('records an arm failure and continues the other samples', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'semantic-routing-ab-error-'));
    try {
      const parsed = config();
      parsed.repeats = 1;
      delete parsed.judge;
      const fetchImpl: typeof fetch = async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer sk-test');
        if (body.model === 'bench-random') return new Response('{"error":"unavailable"}', { status: 503 });
        return new Response(JSON.stringify(completion('model-a', 'candidate answer')), { status: 200 });
      };
      const { samples, summary } = await runBenchmark(parsed, {
        outputPath: join(dir, 'results.jsonl'),
        fetchImpl,
      });
      assert.equal(samples.length, 2);
      assert.equal(summary.decision.successful, 1);
      assert.equal(summary.random.failed, 1);
      assert.match(samples.find(sample => sample.arm === 'random')?.error ?? '', /HTTP 503/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
