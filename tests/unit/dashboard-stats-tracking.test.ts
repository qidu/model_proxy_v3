import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  blockTool,
  createResponseToolTrackingTransformStream,
  getAgentToolPanelStats,
  getBlockedTools,
  getRequestEndpointTimingStatsDesc,
  getRequestModelTimingStatsDesc,
  getUpstreamResponseToolStatsDesc,
  recordAgentStat,
  recordModelTiming,
  recordRequestTiming,
  recordToolRequestChars,
  recordUpstreamResponseToolNames,
  unblockTool,
} from '../../src/utils/dashboard-stats.js';

const originalDashboard = process.env.DASHBOARD;

beforeEach(() => {
  process.env.DASHBOARD = 'true';
});

afterEach(() => {
  if (originalDashboard === undefined) delete process.env.DASHBOARD;
  else process.env.DASHBOARD = originalDashboard;
  for (const name of getBlockedTools()) unblockTool(name);
});

describe('request timing aggregation', () => {
  it('tracks endpoint min/max/average/count and ignores invalid samples', () => {
    recordRequestTiming('__timing_endpoint__', 30);
    recordRequestTiming('__timing_endpoint__', 10);
    recordRequestTiming('__timing_endpoint__', 20);
    recordRequestTiming('__timing_endpoint__', -1);
    recordRequestTiming('__timing_endpoint__', Number.NaN);
    recordRequestTiming('', 100);

    const row = getRequestEndpointTimingStatsDesc().find((entry) => entry.endpoint === '__timing_endpoint__');
    assert.deepEqual(row, {
      endpoint: '__timing_endpoint__',
      min_time_ms: 10,
      max_time_ms: 30,
      total_time_ms: 60,
      count: 3,
      avg_time_ms: 20,
    });
  });

  it('normalizes model keys and computes model timing averages', () => {
    recordModelTiming('__timing_model__: https://upstream.example', 9);
    recordModelTiming('__timing_model__', 5);
    recordModelTiming(undefined, 100);
    recordModelTiming('__timing_model__', -2);

    const row = getRequestModelTimingStatsDesc().find((entry) => entry.endpoint === '__timing_model__');
    assert.deepEqual(row, {
      endpoint: '__timing_model__', min_time_ms: 5, max_time_ms: 9,
      total_time_ms: 14, count: 2, avg_time_ms: 7,
    });
  });
});

describe('response tool tracking', () => {
  it('records per-agent response tools and combines request/response panel stats', () => {
    recordAgentStat({ prefix: 'hermes', ua: 'claudecode' }, ['__tracking_tool__']);
    recordToolRequestChars([{ tool_name: '__tracking_tool__', request_chars: 42 }], { prefix: 'hermes', ua: 'claudecode' });
    recordUpstreamResponseToolNames(['__tracking_tool__', '__tracking_tool__'], { prefix: 'hermes', ua: 'claudecode' });
    blockTool('__blocked_response_tool__');
    recordUpstreamResponseToolNames(['__blocked_response_tool__']);

    const upstream = getUpstreamResponseToolStatsDesc().find((row) => row.tool_name === '__tracking_tool__');
    assert.deepEqual(upstream, { tool_name: '__tracking_tool__', tools: 2 });
    assert.equal(getUpstreamResponseToolStatsDesc().some((row) => row.tool_name === '__blocked_response_tool__'), false);
    const panel = getAgentToolPanelStats().find((row) => row.tool_name === '__tracking_tool__');
    assert.deepEqual(panel, {
      tool_name: '__tracking_tool__', agent: 'hermes/claudecode',
      agent_prefix: 'hermes', agent_ua: 'claudecode',
      in_requests: 1, in_responses: 2, in_request_chars: 42,
    });
  });

  it('extracts unique tools from fragmented SSE without changing streamed bytes', async () => {
    const frames = [
      'event: content_block_start\ndata: {"content_block":{"type":"tool_use","name":"claude_tool"}}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"openai_tool"}}]}}]}\n\n',
      'event: response.output_item.added\ndata: {"item":{"type":"function_call","name":"responses_tool"}}\n\n',
      'data: {"output":[{"type":"function_call","name":"openai_tool"}]}\n\n',
      'data: [DONE]\n\n',
    ];
    const wire = frames.join('');
    const encoded = new TextEncoder().encode(wire);
    let receivedNames: string[] | undefined;
    let receivedAgent: unknown;
    const stream = createResponseToolTrackingTransformStream((names, agent) => {
      receivedNames = names;
      receivedAgent = agent;
    }, { prefix: 'hermes', ua: 'claudecode' });
    const outputPromise = new Response(stream.readable).text();
    const writer = stream.writable.getWriter();
    await writer.write(encoded.slice(0, 43));
    await writer.write(encoded.slice(43, 137));
    await writer.write(encoded.slice(137));
    await writer.close();

    assert.equal(await outputPromise, wire);
    assert.deepEqual(receivedNames, ['claude_tool', 'openai_tool', 'responses_tool']);
    assert.deepEqual(receivedAgent, { prefix: 'hermes', ua: 'claudecode' });
  });

  it('does not report tools for malformed or tool-free streams', async () => {
    let calls = 0;
    const stream = createResponseToolTrackingTransformStream(() => { calls += 1; });
    const outputPromise = new Response(stream.readable).text();
    const writer = stream.writable.getWriter();
    await writer.write(new TextEncoder().encode('data: {bad json}\n\ndata: {"choices":[]}\n\n'));
    await writer.close();
    assert.equal(await outputPromise, 'data: {bad json}\n\ndata: {"choices":[]}\n\n');
    assert.equal(calls, 0);
  });
});
