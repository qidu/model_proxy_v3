import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import handler from '../../src/index.js';
import { clearProxyConfigCache } from '../../src/utils/config-loader.js';

function makeConfigPath(baseUrl: string, upstreamMode = 'gemini-generatecontent'): string {
  const p = join(tmpdir(), `proxy_responses_gemini_${Date.now()}_${Math.random().toString(36).slice(2)}.toml`);
  writeFileSync(p, `
[models.default]
upstream_mode = "${upstreamMode}"
base_url = "${baseUrl}"
api_key = "gemini-test-key"
`, 'utf-8');
  return p;
}

const realFetch = globalThis.fetch;
let configPath = '';
let upstreamUrls: string[] = [];

function installMockFetch() {
  globalThis.fetch = async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    upstreamUrls.push(url);
    if (url.includes(':countTokens')) {
      return new Response(JSON.stringify({ totalTokens: 2 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    // The streaming action frames its answer as SSE — the only content type the
    // proxy's streaming egress accepts, and what the real upstream sends for this
    // URL. Answering JSON here would make the four `:streamGenerateContent` cases
    // below pass on a body the handler now refuses (see gemini-stream-endpoint.test.ts).
    if (url.includes(':streamGenerateContent')) {
      return new Response(`data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
      })}\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

function env() {
  return { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error' } as any;
}

async function sendResponsesRequest() {
  return handler.fetch(new Request('http://localhost/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'client-key' },
    body: JSON.stringify({ model: 'gemini-pro', input: 'hi' }),
  }), env());
}

async function sendMessagesRequest() {
  return handler.fetch(new Request('http://localhost/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'client-key' },
    body: JSON.stringify({ model: 'gemini-pro', messages: [{ role: 'user', content: 'hi' }], max_tokens: 10 }),
  }), env());
}

async function sendInteractionsRequest() {
  return handler.fetch(new Request('http://localhost/v1/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'client-key' },
    body: JSON.stringify({ model: 'gemini-pro', input: 'hi' }),
  }), env());
}

async function sendGenerateContentRequest(endpoint: string) {
  return handler.fetch(new Request(`http://localhost${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': 'client-key' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hi' }] }] }),
  }), env());
}

describe('Gemini native upstream URL construction', () => {
  beforeEach(() => {
    clearProxyConfigCache();
    upstreamUrls = [];
    installMockFetch();
  });

  afterEach(() => {
    clearProxyConfigCache();
    globalThis.fetch = realFetch;
    if (configPath) unlinkSync(configPath);
    configPath = '';
  });

  for (const upstreamMode of ['gemini-generatecontent', 'gemini-interactions']) {
    for (const baseUrl of ['https://generativelanguage.googleapis.com', 'https://generativelanguage.googleapis.com/v1beta']) {
      it(`builds the correct /v1/responses Gemini URL from ${baseUrl} in ${upstreamMode} mode`, async () => {
        configPath = makeConfigPath(baseUrl, upstreamMode);
        const resp = await sendResponsesRequest();

        assert.equal(resp.status, 200);
        assert.deepEqual(upstreamUrls, ['https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent']);
      });

      it(`builds the correct /v1/messages Gemini URL from ${baseUrl} in ${upstreamMode} mode`, async () => {
        configPath = makeConfigPath(baseUrl, upstreamMode);
        const resp = await sendMessagesRequest();

        assert.equal(resp.status, 200);
        assert.deepEqual(upstreamUrls, ['https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent']);
      });

      it(`builds the correct /v1/interactions Gemini URL from ${baseUrl} in ${upstreamMode} mode`, async () => {
        configPath = makeConfigPath(baseUrl, upstreamMode);
        const resp = await sendInteractionsRequest();

        assert.equal(resp.status, 200);
        assert.deepEqual(upstreamUrls, ['https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent']);
      });

      it(`builds the correct generateContent Gemini URL from ${baseUrl} in ${upstreamMode} mode`, async () => {
        configPath = makeConfigPath(baseUrl, upstreamMode);
        const resp = await sendGenerateContentRequest('/v1beta/models/gemini-pro:generateContent');

        assert.equal(resp.status, 200);
        assert.deepEqual(upstreamUrls, ['https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent']);
      });

      it(`builds the correct streamGenerateContent Gemini URL from ${baseUrl} in ${upstreamMode} mode`, async () => {
        configPath = makeConfigPath(baseUrl, upstreamMode);
        const resp = await sendGenerateContentRequest('/v1beta/models/gemini-pro:streamGenerateContent');

        assert.equal(resp.status, 200);
        assert.deepEqual(upstreamUrls, ['https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:streamGenerateContent?alt=sse']);
      });

      it(`builds the correct countTokens Gemini URL from ${baseUrl} in ${upstreamMode} mode`, async () => {
        configPath = makeConfigPath(baseUrl, upstreamMode);
        const resp = await sendGenerateContentRequest('/v1beta/models/gemini-pro:countTokens');

        assert.equal(resp.status, 200);
        assert.deepEqual(upstreamUrls, ['https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:countTokens']);
      });
    }
  }
});
