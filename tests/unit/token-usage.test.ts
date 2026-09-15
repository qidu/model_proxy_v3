import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { convertClaudeToOpenAIRequest } from '../../src/converters/claude-to-openai.js';
import { createStreamTransformer } from '../../src/converters/streaming.js';
import { createGeminiStreamTransformer } from '../../src/converters/gemini-streaming.js';
import { extractTokenCounts } from '../../src/converters/openai-to-claude.js';
import { countClaudeRequestTokens } from '../../src/utils/token-counting.js';
import { handleMessagesRequest } from '../../src/handlers/messages.js';
import { createUsageTrackingTransformStream, extractUsageFromResponsePayload } from '../../src/utils/dashboard-stats.js';
import { buildModelUsageRecordPayload, recordModelUsageToRemote, PROTOCOL_VERSION } from '../../src/utils/model-usage-recorder.js';

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

function parseSse(text: string): Array<{ event?: string; data: any }> {
  return text.trim().split('\n\n').map(message => {
    let event: string | undefined;
    let data = '';
    for (const line of message.split('\n')) {
      if (line.startsWith('event: ')) event = line.slice(7);
      if (line.startsWith('data: ')) data = line.slice(6);
    }
    return { event, data: data === '[DONE]' ? data : JSON.parse(data) };
  });
}

function sseStream(body: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
}

describe('streaming usage propagation', () => {
  it('adds stream_options.include_usage for Claude-format OpenAI streaming', () => {
    const request = convertClaudeToOpenAIRequest({
      model: 'claude-test',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'hello' }],
    }, 'gpt-test');

    assert.deepEqual(request.stream_options, { include_usage: true });
  });

  it('adds and merges stream_options.include_usage for OpenAI passthrough streaming', async () => {
    const originalFetch = globalThis.fetch;
    let upstreamBody: any;
    globalThis.fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
      upstreamBody = JSON.parse(init?.body as string);
      return new Response(sseStream([
        'data: {"choices":[{"delta":{"content":"ok"},"index":0}]}',
        '',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n')), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    };

    try {
      const response = await handleMessagesRequest(
        new Request('http://localhost/v1/messages', {
          method: 'POST',
          body: JSON.stringify({
            model: 'gpt-test',
            stream: true,
            messages: [{ role: 'user', content: 'hello' }],
            stream_options: { include_usage: false },
          }),
        }),
        'https://example.com/v1/chat/completions',
        { Authorization: 'Bearer test' },
        'req-test',
      );
      await streamToText(response.body!);
      assert.deepEqual(upstreamBody.stream_options, { include_usage: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('emits OpenAI final stream usage including cached tokens', async () => {
    const input = sseStream([
      'data: {"choices":[{"delta":{"content":"hi"},"index":0}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18,"prompt_tokens_details":{"cached_tokens":4}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'));

    const output = await streamToText(input.pipeThrough(new TransformStream(createStreamTransformer('gpt-test', 'req-test'))));
    const messageDelta = parseSse(output).find(e => e.event === 'message_delta')?.data;

    assert.equal(messageDelta.usage.input_tokens, 11);
    assert.equal(messageDelta.usage.output_tokens, 7);
    assert.equal(messageDelta.usage.cache_read_input_tokens, 4);
  });

  it('emits Gemini interaction final usage', async () => {
    const input = sseStream([
      'data: {"event_type":"interaction.start","interaction":{"id":"int_1","role":"model"}}',
      '',
      'data: {"event_type":"content.start","index":0,"content":{"type":"text"}}',
      '',
      'data: {"event_type":"content.delta","index":0,"delta":{"type":"text","text":"hello"}}',
      '',
      'data: {"event_type":"content.stop","index":0}',
      '',
      'data: {"event_type":"interaction.complete","interaction":{"id":"int_1","status":"completed","object":"interaction","created":"now","updated":"now","role":"model","usage":{"total_input_tokens":13,"total_output_tokens":8,"total_cached_tokens":5,"total_tokens":26}}}',
      '',
    ].join('\n'));

    const output = await streamToText(input.pipeThrough(createGeminiStreamTransformer('gemini-test', 'req-test')));
    const messageDelta = parseSse(output).find(e => e.event === 'message_delta')?.data;

    assert.equal(messageDelta.usage.input_tokens, 13);
    assert.equal(messageDelta.usage.output_tokens, 8);
    assert.equal(messageDelta.usage.cache_read_input_tokens, 5);
  });
});

describe('remote usage recording', () => {
  it('builds payload with raw user key and all token counters', () => {
    const payload = buildModelUsageRecordPayload('req-1', '/v1/messages', 'sk-user', 'claude-test', {
      input_tokens: 11,
      cached_tokens: 3,
      cache_written_tokens: 5,
      output_tokens: 7,
      total_tokens: 26,
    }, 200);

    assert.equal(payload.request_id, 'req-1');
    assert.equal(payload.endpoint, '/v1/messages');
    assert.equal(payload.version, PROTOCOL_VERSION);
    assert.equal(payload.user_key, 'sk-user');
    assert.equal(payload.model, 'claude-test');
    assert.equal(payload.input_tokens, 11);
    assert.equal(payload.cached_tokens, 3);
    assert.equal(payload.cache_written_tokens, 5);
    assert.equal(payload.output_tokens, 7);
    assert.equal(payload.total_tokens, 26);
    assert.equal(payload.response_status, 200);
    assert.match(payload.timestamp, /^\d{4}-\d{2}-\d{2}T/);
  });

  it('posts payload only when record_server is configured', async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        headers: init?.headers as Record<string, string>,
        body: JSON.parse(init?.body as string),
      });
      return new Response('{}', { status: 204 });
    }) as typeof fetch;

    try {
      const payload = buildModelUsageRecordPayload('req-2', '/v1/messages', 'sk-user', 'gpt-test', { total_tokens: 9 }, 200);
      recordModelUsageToRemote(undefined, payload);
      recordModelUsageToRemote('http://collector.test/usage', payload, undefined, 'one-time-token');
      await new Promise(resolve => setTimeout(resolve, 0));

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'http://collector.test/usage');
      assert.equal(calls[0].headers.one_time_auth_code, 'one-time-token');
      assert.equal(calls[0].body.user_key, 'sk-user');
      assert.equal(calls[0].body.total_tokens, 9);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('invokes streaming usage callback with final counters', async () => {
    let captured: any;
    const input = sseStream([
      'event: message_start',
      'data: {"message":{"usage":{"input_tokens":10,"cache_read_input_tokens":4,"cache_creation_input_tokens":2}}}',
      '',
      'event: message_delta',
      'data: {"usage":{"output_tokens":6}}',
      '',
      '',
    ].join('\n'));

    await streamToText(input.pipeThrough(createUsageTrackingTransformStream('claude-test', undefined, usage => {
      captured = usage;
    })));

    assert.equal(captured.input_tokens, 10);
    assert.equal(captured.cached_tokens, 4);
    assert.equal(captured.cache_written_tokens, 2);
    assert.equal(captured.output_tokens, 6);
    assert.equal(captured.total_tokens, 22);
  });
});

describe('cache token mapping', () => {
  it('maps OpenAI Responses cached tokens to Claude cache_read_input_tokens', async () => {
    const usage = await extractTokenCounts({
      prompt_tokens: 20,
      completion_tokens: 10,
      total_tokens: 30,
      input_tokens_details: { cached_tokens: 6 },
    });

    assert.equal(usage.input_tokens, 20);
    assert.equal(usage.output_tokens, 10);
    assert.equal(usage.cache_read_input_tokens, 6);
  });

  it('maps chat-completions prompt_tokens_details.cached_tokens (OpenAI/GLM shape)', async () => {
    const usage = await extractTokenCounts({
      prompt_tokens: 128,
      completion_tokens: 10,
      total_tokens: 138,
      prompt_tokens_details: { cached_tokens: 64 },
      completion_tokens_details: { reasoning_tokens: 9 },
    });

    assert.equal(usage.input_tokens, 128);
    assert.equal(usage.output_tokens, 10);
    assert.equal(usage.cache_read_input_tokens, 64);
  });

  it('maps OpenRouter prompt_cache_hit_tokens / prompt_cache_miss_tokens', async () => {
    const usage = await extractTokenCounts({
      prompt_tokens: 200,
      completion_tokens: 5,
      total_tokens: 205,
      prompt_cache_hit_tokens: 150,
      prompt_cache_miss_tokens: 50,
    });

    assert.equal(usage.input_tokens, 200);
    assert.equal(usage.cache_read_input_tokens, 150);
    assert.equal(usage.cache_creation_input_tokens, 50);
  });

  it('prefers prompt_cache_hit_tokens over prompt_tokens_details.cached_tokens', async () => {
    // Both fields present — OpenRouter shorthand wins per the fallback chain.
    const usage = await extractTokenCounts({
      prompt_tokens: 100,
      completion_tokens: 1,
      prompt_cache_hit_tokens: 30,
      prompt_tokens_details: { cached_tokens: 99 },
    });

    assert.equal(usage.cache_read_input_tokens, 30);
  });
});

describe('extractUsageFromResponsePayload (non-streaming stats extraction)', () => {
  it('reads Claude shape (cache_read_input_tokens / cache_creation_input_tokens)', () => {
    const stats = extractUsageFromResponsePayload({
      usage: {
        input_tokens: 14,
        output_tokens: 3,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: 4,
      },
    });

    assert.deepEqual(stats, {
      input_tokens: 14,
      cached_tokens: 7,
      cache_written_tokens: 4,
      output_tokens: 3,
      total_tokens: 28, // 14 + 7 + 4 + 3
    });
  });

  it('reads chat-completions shape (prompt_tokens_details.cached_tokens)', () => {
    const stats = extractUsageFromResponsePayload({
      usage: {
        prompt_tokens: 128,
        completion_tokens: 10,
        total_tokens: 138,
        prompt_tokens_details: { cached_tokens: 64 },
        completion_tokens_details: { reasoning_tokens: 9 },
      },
    });

    assert.equal(stats?.input_tokens, 128);
    assert.equal(stats?.cached_tokens, 64);
    assert.equal(stats?.cache_written_tokens, 0);
    assert.equal(stats?.output_tokens, 10);
    assert.equal(stats?.total_tokens, 138);
  });

  it('reads OpenRouter shape (prompt_cache_hit_tokens / prompt_cache_miss_tokens)', () => {
    const stats = extractUsageFromResponsePayload({
      usage: {
        prompt_tokens: 200,
        completion_tokens: 5,
        total_tokens: 205,
        prompt_cache_hit_tokens: 150,
        prompt_cache_miss_tokens: 50,
      },
    });

    assert.equal(stats?.cached_tokens, 150);
    assert.equal(stats?.cache_written_tokens, 50);
  });

  it('reads Responses shape (input_tokens_details.cached_tokens)', () => {
    const stats = extractUsageFromResponsePayload({
      usage: {
        input_tokens: 40,
        output_tokens: 8,
        total_tokens: 48,
        input_tokens_details: { cached_tokens: 12 },
        output_tokens_details: { reasoning_tokens: 4 },
      },
    });

    assert.equal(stats?.input_tokens, 40);
    assert.equal(stats?.cached_tokens, 12);
    assert.equal(stats?.output_tokens, 8);
    assert.equal(stats?.total_tokens, 48);
  });

  it('reads Gemini usageMetadata shape (no cache fields)', () => {
    const stats = extractUsageFromResponsePayload({
      usageMetadata: {
        promptTokenCount: 33,
        candidatesTokenCount: 11,
        totalTokenCount: 44,
      },
    });

    assert.deepEqual(stats, {
      input_tokens: 33,
      cached_tokens: 0,
      cache_written_tokens: 0,
      output_tokens: 11,
      total_tokens: 44,
    });
  });

  it('reads Gemini cachedContentTokenCount into cached_tokens', () => {
    const stats = extractUsageFromResponsePayload({
      usageMetadata: {
        promptTokenCount: 100, // includes the cached portion
        cachedContentTokenCount: 60,
        candidatesTokenCount: 20,
        totalTokenCount: 120,
      },
    });

    assert.deepEqual(stats, {
      input_tokens: 100,
      cached_tokens: 60,
      cache_written_tokens: 0,
      output_tokens: 20,
      total_tokens: 120,
    });
  });

  it('returns undefined when no usage can be parsed', () => {
    assert.equal(extractUsageFromResponsePayload({ foo: 'bar' }), undefined);
    assert.equal(extractUsageFromResponsePayload({ usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }), undefined);
  });
});

describe('Responses-SSE streaming usage', () => {
  it('captures usage from event: response.completed', async () => {
    let captured: any;
    const input = sseStream([
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"r1"}}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"r1","status":"completed","usage":{"input_tokens":40,"output_tokens":8,"total_tokens":48,"input_tokens_details":{"cached_tokens":12}}}}',
      '',
      '',
    ].join('\n'));

    await streamToText(input.pipeThrough(createUsageTrackingTransformStream('gpt-resp-test', undefined, usage => {
      captured = usage;
    })));

    assert.equal(captured.input_tokens, 40);
    assert.equal(captured.cached_tokens, 12);
    assert.equal(captured.output_tokens, 8);
    assert.equal(captured.total_tokens, 48);
  });

  it('captures usage from native Gemini streamGenerateContent?alt=sse chunks', async () => {
    let captured: any;
    const input = sseStream([
      'data: {"candidates":[{"content":{"parts":[{"text":"he"}]}}],"usageMetadata":{"promptTokenCount":50,"candidatesTokenCount":1,"totalTokenCount":51}}',
      '',
      'data: {"candidates":[{"content":{"parts":[{"text":"llo"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":100,"cachedContentTokenCount":60,"candidatesTokenCount":20,"totalTokenCount":120}}',
      '',
      '',
    ].join('\n'));

    await streamToText(input.pipeThrough(createUsageTrackingTransformStream('gemini-test', undefined, usage => {
      captured = usage;
    })));

    // Final chunk wins (running totals)
    assert.equal(captured.input_tokens, 100);
    assert.equal(captured.cached_tokens, 60);
    assert.equal(captured.output_tokens, 20);
    assert.equal(captured.total_tokens, 120);
  });
});


describe('local token counting for non-text content', () => {
  it('counts tool_result content instead of skipping it', () => {
    const base = countClaudeRequestTokens({
      model: 'claude-test',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    });
    const withToolResult = countClaudeRequestTokens({
      model: 'claude-test',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'hello' },
          { type: 'tool_result', tool_use_id: 'tool_1', content: 'the tool returned a detailed result' },
        ],
      }],
    } as any);

    assert.ok(withToolResult > base);
  });

  it('counts nested tool_result content blocks', () => {
    const count = countClaudeRequestTokens({
      model: 'claude-test',
      messages: [{
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: 'tool_1',
          content: [{ type: 'text', text: 'nested result text' }, { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }],
        }],
      }],
    } as any);

    assert.ok(count > 0);
  });
});
