import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer, request as httpRequest, type IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import {
  buildNodeEnv,
  createNodeBodyStream,
  createNodeRequestHandler,
  nodeResponseHeaders,
  type NodeEnv,
} from '../../src/server.js';
import { attachActiveRequestRelease, getActiveRequestCount, incrementActiveRequests } from '../../src/utils/dashboard-stats.js';
import { wrapSseStreamWithKeepAlive } from '../../src/utils/sse-keepalive.js';

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

  it('streams a keep-alive-wrapped SSE body to a reader that pauses mid-response', { timeout: 15000 }, async () => {
    await withServer(async () => {
      // The shape `src/index.ts` hands to the server: a pull-driven keep-alive
      // wrapper (highWaterMark 0) as the response body.
      const body = wrapSseStreamWithKeepAlive(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: first\n\n'));
          controller.enqueue(new TextEncoder().encode('data: second\n\n'));
          controller.close();
        },
      }), 60_000);
      return new Response(body, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
    }, async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/stream`);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();

      // Read in stages. The wrapper reads upstream only while a consumer waits,
      // so a reader that pauses must not make `pipeline()` drop, reorder or
      // deadlock on the remaining frames. Frames may arrive coalesced in one
      // socket read, so only the accumulated text is asserted.
      const first = await reader.read();
      assert.ok(first.value && first.value.byteLength > 0, 'the first frame must arrive');
      let text = decoder.decode(first.value, { stream: true });
      await delay(150);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }

      // Equality also rules out a stray ping: the 60s interval never elapses.
      assert.equal(text, 'data: first\n\ndata: second\n\n');
    });
  });

  it('cancels the upstream body when the client disconnects mid-stream', async () => {
    const initialActiveRequests = getActiveRequestCount();
    let cancelled = false;

    await withServer(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: first\n\n'));
          // Deliberately never closed: the client hangs up while upstream is
          // still producing, which is the case §5.7's pipeline() must unwind.
        },
        cancel() { cancelled = true; },
      });
      const response = new Response(body, {
        headers: { 'Content-Type': 'text/event-stream' },
      });
      attachActiveRequestRelease(response, incrementActiveRequests());
      return response;
    }, async (baseUrl) => {
      await new Promise<void>((resolve) => {
        const request = httpRequest(`${baseUrl}/v1/stream`, (incoming) => {
          incoming.once('data', () => {
            request.destroy();
            resolve();
          });
        });
        request.on('error', () => resolve());
        request.end();
      });
      // Let the server observe the hang-up and unwind the pipeline.
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    assert.equal(cancelled, true, 'the upstream web stream must be cancelled, not left draining');
    assert.equal(getActiveRequestCount(), initialActiveRequests, 'the in-flight counter must not leak');
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

describe('createNodeBodyStream', () => {
  /**
   * A stand-in for `IncomingMessage`: the adapter only uses `method`, the event
   * API, and `pause`/`resume`, and counting those two is the whole point — the
   * Node module's own socket cannot be observed from a unit test.
   */
  class FakeUpload extends EventEmitter {
    method = 'POST';
    pauses = 0;
    resumes = 0;
    pause(): this {
      this.pauses += 1;
      return this;
    }
    resume(): this {
      this.resumes += 1;
      return this;
    }
  }

  function open(method = 'POST'): { upload: FakeUpload; stream: ReadableStream<Uint8Array>; drain: () => void } {
    const upload = new FakeUpload();
    upload.method = method;
    const { stream, drain } = createNodeBodyStream(upload as unknown as IncomingMessage);
    assert.ok(stream, `${method} must get a body stream`);
    return { upload, stream, drain };
  }

  it('releases one chunk per read and holds the socket in between', async () => {
    const { upload, stream } = open();
    assert.equal(upload.pauses, 1, "attaching 'data' put the readable in flowing mode, so the adapter pauses it again");
    assert.equal(upload.resumes, 0, 'nothing is released before a read is pending (highWaterMark 0)');
    assert.equal(upload.listenerCount('data'), 1);

    const reader = stream.getReader();
    const first = reader.read();
    // `pull` runs only once the controller has finished starting, so the socket
    // is resumed a microtask after the read, not inside it.
    await delay(0);
    assert.equal(upload.resumes, 1, 'the pending read releases exactly one chunk');
    upload.emit('data', Buffer.from('abc'));
    assert.equal(upload.pauses, 2, 'the chunk that satisfied the read holds the socket again');
    assert.equal(new TextDecoder().decode((await first).value), 'abc');

    const second = reader.read();
    await delay(0);
    assert.equal(upload.resumes, 2, 'the next read resumes the socket again');
    upload.emit('data', Buffer.from('def'));
    assert.equal(upload.pauses, 3);
    assert.equal(new TextDecoder().decode((await second).value), 'def');

    upload.emit('end');
    assert.equal((await reader.read()).done, true, 'the upload end closes the stream');
    await delay(0);
    assert.equal(upload.resumes, 2, 'a closed stream needs nothing more from the socket');
  });

  it('drain() detaches the socket, discards the rest, and is idempotent', () => {
    const { upload, drain } = open();
    drain();
    assert.equal(upload.listenerCount('data'), 0, 'no more chunks reach the stream');
    assert.equal(upload.listenerCount('end'), 0);
    assert.equal(
      upload.listenerCount('error'),
      1,
      "the 'error' listener stays attached: dropping it would turn a late socket error into an uncaught exception",
    );
    assert.equal(upload.resumes, 1, 'the rest of the upload runs into the void');

    drain();
    assert.equal(upload.resumes, 1, 'a second drain must not resume twice');
  });

  it('cancel() on the body stream drains instead of leaving the socket flowing', async () => {
    const { upload, stream } = open();
    await stream.getReader().cancel();

    assert.equal(upload.listenerCount('data'), 0);
    assert.equal(upload.listenerCount('error'), 1);
    assert.equal(upload.resumes, 1);
  });

  it('gives GET and HEAD no body stream', () => {
    for (const method of ['GET', 'HEAD']) {
      const upload = new FakeUpload();
      upload.method = method;
      const { stream, drain } = createNodeBodyStream(upload as unknown as IncomingMessage);
      assert.equal(stream, undefined, `${method} carries no body`);
      assert.equal(upload.listenerCount('data'), 0, `${method} must not touch the socket`);
      drain();
      assert.equal(upload.resumes, 0, `${method} has nothing to drain`);
    }
  });
});

/** Bytes handed to the kernel, sampled while the upload is in flight. */
interface Upload {
  socket: import('node:net').Socket | undefined;
  /** Bytes passed to `write()`. Unbounded in JS, so only backpressure stops it. */
  sent: number;
  response: Promise<{ status: number; body: string }>;
}

/**
 * POST `totalBytes` of a fixed pattern, honoring `drain` like a real client.
 *
 * A raw `http.request` rather than `fetch` because the test needs the socket:
 * `socket.bytesWritten` is the only client-side observable of whether the server
 * is applying backpressure. Errors after the response arrived are ignored — a
 * server may answer an early return while the upload is still in flight.
 */
function upload(baseUrl: string, totalBytes: number, path = '/v1/upload'): Upload {
  const url = new URL(baseUrl);
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const state = { socket: undefined, sent: 0, response: undefined } as unknown as Upload;

  state.response = new Promise((resolve, reject) => {
    const req = httpRequest({
      host: url.hostname,
      port: url.port,
      method: 'POST',
      path,
      headers: { 'content-length': String(totalBytes), 'content-type': 'application/octet-stream' },
    });
    req.on('socket', (socket) => { state.socket = socket; });
    let answered = false;
    req.on('error', (error) => { if (!answered) reject(error); });
    req.on('response', (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (piece: string) => { body += piece; });
      res.on('end', () => {
        answered = true;
        resolve({ status: res.statusCode ?? 0, body });
      });
    });

    const pump = (): void => {
      while (state.sent < totalBytes) {
        const remaining = totalBytes - state.sent;
        const piece = remaining >= chunk.byteLength ? chunk : chunk.subarray(0, remaining);
        state.sent += piece.byteLength;
        if (!req.write(piece)) {
          req.once('drain', pump);
          return;
        }
      }
      req.end();
    };
    pump();
  });

  return state;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('createNodeRequestHandler — request upload', () => {
  it('stops the client upload until the handler reads, then delivers every byte', { timeout: 15000 }, async () => {
    const totalBytes = 16 * 1024 * 1024;
    const expected = createHash('sha256');
    for (let written = 0; written < totalBytes; written += 64 * 1024) {
      expected.update(Buffer.alloc(Math.min(64 * 1024, totalBytes - written), 0x61));
    }

    const received = createHash('sha256');
    let receivedBytes = 0;
    let openedFirstRead: () => void = () => {};
    const firstRead = new Promise<void>((resolve) => { openedFirstRead = resolve; });
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseGate = resolve; });

    await withServer(async (request) => {
      assert.ok(request.body, 'the upload must arrive as a stream');
      const reader = request.body.getReader();
      const first = await reader.read();
      assert.ok(first.value && first.value.byteLength > 0, 'the first read must yield bytes');
      received.update(first.value);
      receivedBytes += first.value.byteLength;
      openedFirstRead(); // the client samples the socket only once the handler has one chunk
      await gate;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received.update(value);
        receivedBytes += value.byteLength;
      }
      return new Response('read');
    }, async (baseUrl) => {
      const sent = upload(baseUrl, totalBytes);
      await firstRead;

      // The handler is not reading, so the socket must stop draining: sample
      // until two consecutive reads agree, then confirm it stays put.
      let previous = -1;
      let stalled = 0;
      for (let i = 0; i < 50 && previous !== stalled; i++) {
        previous = stalled;
        await delay(100);
        stalled = sent.socket?.bytesWritten ?? 0;
      }
      assert.ok(
        stalled > 0 && stalled < totalBytes / 4,
        `backpressure must hold the upload far below its ${totalBytes} bytes (stalled at ${stalled})`,
      );
      assert.ok(
        sent.sent < totalBytes / 4,
        `the client must not have queued the body either (queued ${sent.sent} bytes)`,
      );
      await delay(200);
      assert.equal(sent.socket?.bytesWritten, stalled, 'no further byte leaves the client while the handler waits');

      releaseGate();
      const response = await sent.response;
      assert.equal(response.status, 200);
      assert.equal(response.body, 'read');
      assert.equal(receivedBytes, totalBytes, 'every byte of the upload must arrive after the handler resumes');
      assert.equal(received.digest('hex'), expected.digest('hex'), 'the body must arrive intact');
    });
  });

  it('answers a request whose body the handler never reads', { timeout: 15000 }, async () => {
    const totalBytes = 4 * 1024 * 1024;
    let drained = false;

    await withServer(async () => {
      // The dashboard / auth-rejection / OPTIONS shape: respond without touching
      // the body. The adapter must discard the upload instead of stalling it.
      drained = true;
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }, async (baseUrl) => {
      const sent = upload(baseUrl, totalBytes);
      const response = await sent.response;
      assert.equal(response.status, 401);
      assert.deepEqual(JSON.parse(response.body), { error: 'unauthorized' });
      assert.equal(drained, true);
    });
  });
});
