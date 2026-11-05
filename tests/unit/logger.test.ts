/**
 * Unit tests for the trace-level gate in utils/logger.ts (Plan §6, Phase 0
 * item 1).
 *
 * The property that matters is not "no output" but "no work": the pipeline
 * helpers must not build the body text at all when trace is off, because
 * `JSON.stringify` of a multi-megabyte request body costs a full copy per
 * stage. The tests therefore count `toJSON` invocations (the caller-visible
 * work) and captured console output (the observable behavior) together —
 * asserting only the absence of output would pass even if the stringify still
 * ran and was thrown away.
 */

import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { createLogger, logPipelineStage, observeStream } from '../../src/utils/logger.js';
import type { Logger } from '../../src/utils/logger.js';

/** A body that records how many times it was serialized. */
function countingBody(payload: string): { body: unknown; serialized: () => number } {
  let count = 0;
  const body = {
    model: 'test-model',
    payload,
    toJSON() {
      count += 1;
      return { model: 'test-model', payload };
    },
  };
  return { body, serialized: () => count };
}

const realLog = console.log;
let logged: string[] = [];

function captureLog(): void {
  logged = [];
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
}

afterEach(() => {
  console.log = realLog;
});

// createLogger({}) falls back to process.env.LOG_LEVEL, so an inherited
// LOG_LEVEL=trace in the developer's shell would flip the "unset" case.
const priorLogLevel = process.env.LOG_LEVEL;
before(() => { delete process.env.LOG_LEVEL; });
after(() => {
  if (priorLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = priorLogLevel;
});

describe('createLogger traceEnabled', () => {
  it('is false for every level above trace and true for trace', () => {
    assert.equal(createLogger({ LOG_LEVEL: 'trace' }).traceEnabled, true);
    for (const level of ['debug', 'info', 'warn', 'error', 'silent']) {
      assert.equal(createLogger({ LOG_LEVEL: level }).traceEnabled, false, `level=${level}`);
    }
  });

  it('is false when LOG_LEVEL is unset or unrecognised (the logger falls back to info)', () => {
    assert.equal(createLogger({}).traceEnabled, false);
    assert.equal(createLogger({ LOG_LEVEL: 'verbose' }).traceEnabled, false);
  });
});

/**
 * `silent` exists so the unit suite can run without the logger interleaving its
 * lines into TAP output. The property that matters is that it suppresses the
 * highest level too — a `warn`-style cap would leave `[ERROR]` fixture noise in
 * the run — and that it is admitted by the level whitelist instead of falling
 * back to `info`.
 */
describe('silent level', () => {
  it('suppresses every level, error included', () => {
    captureLog();
    const silent = createLogger({ LOG_LEVEL: 'silent' });
    silent.trace('req_1', 't');
    silent.debug('req_1', 'd');
    silent.info('req_1', 'i');
    silent.warn('req_1', 'w');
    silent.error('req_1', 'e');
    assert.deepEqual(logged, [], 'silent must emit nothing at any level');

    // Positive control: the same capture records an ERROR at the next level up,
    // so the empty array above proves suppression rather than a dead hook.
    createLogger({ LOG_LEVEL: 'error' }).error('req_1', 'kept');
    assert.equal(logged.length, 1);
    assert.match(logged[0], /\[ERROR\] kept$/);
  });

  it('applies via process.env when the env object does not set LOG_LEVEL', () => {
    // The unit setup module sets this var, so the precedence it depends on is
    // part of the contract: env object first, then process.env, then `info`.
    process.env.LOG_LEVEL = 'silent';
    try {
      captureLog();
      createLogger({}).error('req_1', 'e');
      assert.deepEqual(logged, [], 'process.env.LOG_LEVEL=silent must suppress output');
    } finally {
      delete process.env.LOG_LEVEL;
    }
  });
});

describe('logPipelineStage body gating', () => {
  it('does not serialize the body and emits nothing when trace is off', () => {
    captureLog();
    const logger = createLogger({ LOG_LEVEL: 'info' });
    const { body, serialized } = countingBody('x'.repeat(1024));

    logPipelineStage(logger, 'req-1', 'inbound', '/v1/messages', body);

    assert.equal(serialized(), 0, 'JSON.stringify must not run when trace is disabled');
    assert.deepEqual(logged, [], 'nothing may be logged when trace is disabled');
  });

  it('serializes once and logs the body with its stage label and endpoint when trace is on', () => {
    captureLog();
    const logger = createLogger({ LOG_LEVEL: 'trace' });
    const { body, serialized } = countingBody('hello-spool');

    logPipelineStage(logger, 'req-2', 'upstream-request', 'https://upstream.test/v1/messages', body);

    assert.equal(serialized(), 1, 'the body must be serialized exactly once when trace is enabled');
    assert.equal(logged.length, 1);
    assert.match(logged[0], /\[UPSTREAM-REQ\] https:\/\/upstream\.test\/v1\/messages: /);
    assert.match(logged[0], /"payload":"hello-spool"/);
  });

  it('passes a string body through verbatim without a second serialization', () => {
    captureLog();
    const logger = createLogger({ LOG_LEVEL: 'trace' });

    logPipelineStage(logger, 'req-3', 'outbound', '/v1/messages', '{"a":1}');

    assert.equal(logged.length, 1);
    assert.match(logged[0], /\[OUT\] \/v1\/messages: \{"a":1\}$/);
  });

  it('truncates over-long bodies and reports the true total length', () => {
    captureLog();
    const logger = createLogger({ LOG_LEVEL: 'trace' });
    const text = 'y'.repeat(50);

    logPipelineStage(logger, 'req-4', 'inbound', '/v1/messages', text, 10);

    assert.match(logged[0], /\[IN\] \/v1\/messages: y{10}\.\.\. \(50 bytes total\)$/);
  });
});

/**
 * observeStream replaces seven `tee()` branches that existed only to log a
 * response twice (Plan §5.7). The properties asserted here are the ones the
 * tee could not offer: the client's bytes are untouched and no decode happens
 * unless trace is on, the two line/chunk conventions survive verbatim, a line
 * split across chunks is logged once in full, and a trace failure cannot
 * disturb the stream the client is reading.
 */

const ENDPOINT = 'https://upstream.test/v1/messages';

/** Logger that records the exact message handed to `trace`. */
function recordingLogger(traceEnabled: boolean): { logger: Logger; traces: string[] } {
  const traces: string[] = [];
  const logger: Logger = {
    traceEnabled,
    trace(_requestId, message) { traces.push(message); },
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  return { logger, traces };
}

/** Push `chunks` through the observer and collect what the client would read. */
async function observe(
  chunks: (string | Uint8Array)[],
  logger: Logger,
  format: 'sse-lines' | 'chunks',
): Promise<Buffer[]> {
  const transform = observeStream(logger, 'req-observe', 'upstream-response', ENDPOINT, format);
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  const out: Buffer[] = [];
  const draining = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(Buffer.from(value));
    }
  })();
  const encoder = new TextEncoder();
  for (const chunk of chunks) {
    await writer.write(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
  }
  await writer.close();
  await draining;
  return out;
}

/** Count TextDecoder.decode calls made while `work` runs. */
async function countingDecodes<T>(work: () => Promise<T>): Promise<{ result: T; decodes: number }> {
  const RealDecoder = globalThis.TextDecoder;
  let decodes = 0;
  class CountingDecoder extends RealDecoder {
    decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string {
      decodes += 1;
      return super.decode(input, options);
    }
  }
  globalThis.TextDecoder = CountingDecoder as unknown as typeof TextDecoder;
  try {
    return { result: await work(), decodes };
  } finally {
    globalThis.TextDecoder = RealDecoder;
  }
}

describe('observeStream pass-through', () => {
  it('forwards every chunk byte-for-byte, with boundaries intact, when trace is off', async () => {
    const { logger, traces } = recordingLogger(false);
    // Invalid UTF-8 would be mangled by any decode/re-encode round trip, so
    // these bytes prove the chunk itself reaches the client unaltered.
    const invalid = new Uint8Array([0xff, 0xfe, 0x20, 0x6e, 0x6f, 0x74, 0x20, 0x75, 0x74, 0x66, 0x2d, 0x38, 0x0a]);
    const chunks: Uint8Array[] = [new TextEncoder().encode('data: {"a":1}\n\n'), invalid];

    const out = await observe(chunks, logger, 'sse-lines');

    assert.equal(out.length, chunks.length, 'one output chunk per input chunk');
    assert.deepEqual(Buffer.concat(out), Buffer.concat(chunks.map((c) => Buffer.from(c))));
    assert.deepEqual(traces, [], 'nothing may be logged when trace is disabled');
  });

  it('decodes nothing when trace is off, even for a stream full of data: lines', async () => {
    const { logger, traces } = recordingLogger(false);

    const { decodes } = await countingDecodes(() =>
      observe(['data: {"a":1}\n', 'data: {"b":2}\n'], logger, 'sse-lines'),
    );

    assert.equal(decodes, 0, 'the chunk must not be decoded when trace is disabled');
    assert.deepEqual(traces, []);
  });
});

describe('observeStream sse-lines format', () => {
  it('logs one trace per complete data: line, skipping other lines and [DONE]', async () => {
    const { logger, traces } = recordingLogger(true);

    await observe(
      ['event: message_start\n', 'data: {"type":"message_start"}\n', 'data: [DONE]\n', ': keep-alive\n'],
      logger,
      'sse-lines',
    );

    assert.deepEqual(traces, [`[UPSTREAM-RESP] ${ENDPOINT}: {"type":"message_start"}`]);
  });

  it('holds a data: line split across chunks until it terminates, then logs it once in full', async () => {
    const { logger, traces } = recordingLogger(true);
    const transform = observeStream(logger, 'req-5', 'upstream-response', ENDPOINT, 'sse-lines');
    const writer = transform.writable.getWriter();
    const reader = transform.readable.getReader();
    const draining = (async () => { while (!(await reader.read()).done) { /* drain */ } })();
    const encoder = new TextEncoder();

    await writer.write(encoder.encode('data: {"content":"hel'));
    assert.deepEqual(traces, [], 'an unterminated line must not be logged');

    await writer.write(encoder.encode('lo"}\n'));
    await writer.close();
    await draining;

    assert.deepEqual(traces, [`[UPSTREAM-RESP] ${ENDPOINT}: {"content":"hello"}`]);
  });

  it('logs a final data: line that never receives a newline', async () => {
    const { logger, traces } = recordingLogger(true);

    await observe(['data: {"tail":true}'], logger, 'sse-lines');

    assert.deepEqual(traces, [`[UPSTREAM-RESP] ${ENDPOINT}: {"tail":true}`], 'the flush must log the tail');
  });
});

describe('observeStream chunks format', () => {
  it('logs each chunk verbatim, one trace per chunk, with no line filtering', async () => {
    const { logger, traces } = recordingLogger(true);

    await observe(['event: message_start\n', 'data: [DONE]\n'], logger, 'chunks');

    assert.deepEqual(traces, [
      `[UPSTREAM-RESP] ${ENDPOINT}: event: message_start\n`,
      `[UPSTREAM-RESP] ${ENDPOINT}: data: [DONE]\n`,
    ]);
  });
});

describe('observeStream failure isolation', () => {
  it('keeps the client stream intact and reports the failure when the trace logger throws', async () => {
    const debugged: string[] = [];
    const logger: Logger = {
      traceEnabled: true,
      trace() { throw new Error('trace sink is gone'); },
      debug(_requestId, message) { debugged.push(message); },
      info() {},
      warn() {},
      error() {},
    };
    const chunks = ['data: {"a":1}\n', 'data: {"b":2}\n'];

    const out = await observe(chunks, logger, 'sse-lines');

    assert.deepEqual(
      Buffer.concat(out).toString('utf8'),
      chunks.join(''),
      'the client must still receive every byte',
    );
    assert.equal(debugged.length, 2, 'each swallowed trace failure is reported once');
    assert.match(debugged[0], /Stream observation failed: trace sink is gone/);
  });
});
