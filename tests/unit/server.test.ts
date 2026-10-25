import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  buildNodeEnv,
  createNodeRequestHandler,
  nodeResponseHeaders,
  type NodeEnv,
} from '../../src/server.js';
import { attachActiveRequestRelease, getActiveRequestCount, incrementActiveRequests } from '../../src/utils/dashboard-stats.js';

type FetchHandler = (request: Request, env: NodeEnv) => Promise<Response>;

async function withServer(fetchHandler: FetchHandler, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer(createNodeRequestHandler(buildNodeEnv({}), fetchHandler));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const { port } = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeAllConnections();
    });
  }
}

describe('buildNodeEnv', () => {
  it('applies proxy defaults', () => {
    const env = buildNodeEnv({});
    assert.equal(env.NODE_ENV, 'production');
    assert.equal(env.VERSION, 'dev');
    assert.equal(env.ALLOWED_ORIGINS, '*');
    assert.equal(env.ALLOWED_HOSTS, '127.0.0.1,localhost');
    assert.equal(env.PORT, '8788');
    assert.equal(env.LOG_LEVEL, 'info');
    assert.equal(env.MESSAGES_UPSTREAM_MODE, 'openai-completions');
    assert.equal(env.INTERACTIONS_UPSTREAM_MODE, 'native');
    assert.equal(env.GENERATE_CONTENT_UPSTREAM_MODE, 'native');
    assert.equal(env.DEV_NO_KEY, 'false');
  });

  it('preserves explicit values and derives the test config path', () => {
    const env = buildNodeEnv({
      NODE_ENV: 'test',
      VERSION: '1.2.3',
      PORT: '9000',
      ALLOWED_ORIGINS: 'https://example.com',
      TEST_CONFIG: 'integration/',
      AGENT: 'true',
      PROXY_CLIENT_API_KEY: 'client-key',
    });
    assert.equal(env.NODE_ENV, 'test');
    assert.equal(env.VERSION, '1.2.3');
    assert.equal(env.PORT, '9000');
    assert.equal(env.ALLOWED_ORIGINS, 'https://example.com');
    assert.equal(env.PROXY_CONFIG_PATH, './integration/proxy_config.toml');
    assert.equal(env.AGENT, 'true');
    assert.equal(env.PROXY_CLIENT_API_KEY, 'client-key');
    assert.equal(env.LOG_LEVEL, 'warn');
  });

  it('prefers an explicit log level and config path', () => {
    const env = buildNodeEnv({
      AGENT: '1',
      LOG_LEVEL: 'debug',
      PROXY_CONFIG_PATH: '/tmp/custom.toml',
    });
    assert.equal(env.LOG_LEVEL, 'debug');
    assert.equal(env.PROXY_CONFIG_PATH, '/tmp/custom.toml');
  });
});

describe('nodeResponseHeaders', () => {
  it('removes hop-specific body headers and preserves other headers', () => {
    const response = new Response('ok', {
      headers: {
        'Content-Type': 'text/plain',
        'Content-Encoding': 'gzip',
        'Content-Length': '999',
        'X-Request-Id': 'request-1',
      },
    });
    assert.deepEqual(nodeResponseHeaders(response), {
      'content-type': 'text/plain',
      'x-request-id': 'request-1',
    });
  });
});

describe('createNodeRequestHandler', () => {
  it('adapts POST requests and writes non-streaming responses', async () => {
    let seenRequest: Request | undefined;
    let seenEnv: NodeEnv | undefined;
    let releaseCount = 0;

    await withServer(async (request, env) => {
      seenRequest = request;
      seenEnv = env;
      assert.equal(await request.text(), '{"prompt":"hello"}');
      const response = new Response('created', {
        status: 201,
        headers: {
          'Content-Type': 'text/plain',
          'Content-Encoding': 'gzip',
          'Content-Length': '1000',
        },
      });
      attachActiveRequestRelease(response, () => { releaseCount += 1; });
      return response;
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/messages?api=1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Custom': 'present' },
        body: '{"prompt":"hello"}',
      });
      assert.equal(response.status, 201);
      assert.equal(await response.text(), 'created');
      assert.equal(response.headers.get('content-encoding'), null);
      assert.equal(response.headers.get('x-custom'), null);
    });

    assert.ok(seenRequest);
    assert.equal(seenRequest.method, 'POST');
    assert.equal(seenRequest.url, `${new URL(seenRequest.url).origin}/v1/messages?api=1`);
    assert.equal(seenRequest.headers.get('x-custom'), 'present');
    assert.ok(seenRequest.headers.get('x-client-address'));
    assert.match(seenRequest.headers.get('x-client-port') || '', /^\d+$/);
    assert.equal(seenEnv?.PORT, '8788');
    assert.equal(releaseCount, 1);
  });

  it('does not attach a body to GET requests and releases after the response', async () => {
    let releaseCount = 0;
    await withServer(async (request) => {
      assert.equal(request.method, 'GET');
      assert.equal(request.body, null);
      const response = new Response('listed');
      attachActiveRequestRelease(response, () => { releaseCount += 1; });
      return response;
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/models`);
      assert.equal(await response.text(), 'listed');
    });
    assert.equal(releaseCount, 1);
  });

  it('streams SSE bodies and releases when streaming completes', async () => {
    const initialActiveRequests = getActiveRequestCount();

    await withServer(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: first\n\n'));
          controller.enqueue(new TextEncoder().encode('data: second\n\n'));
          controller.close();
        },
      });
      const response = new Response(body, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
      attachActiveRequestRelease(response, incrementActiveRequests());
      return response;
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/stream`);
      assert.equal(response.headers.get('content-type'), 'text/event-stream');
      assert.equal(await response.text(), 'data: first\n\ndata: second\n\n');
    });

    assert.equal(getActiveRequestCount(), initialActiveRequests);
  });

  it('returns a JSON 500 response when the fetch handler throws', async () => {
    const originalError = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      await withServer(async () => {
        throw new Error('upstream failed');
      }, async (baseUrl) => {
        const response = await fetch(`${baseUrl}/v1/failure`);
        assert.equal(response.status, 500);
        assert.equal(response.headers.get('content-type'), 'application/json');
        assert.deepEqual(await response.json(), { error: 'Internal server error' });
      });
    } finally {
      console.error = originalError;
    }
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][1]), /upstream failed/);
  });
});
