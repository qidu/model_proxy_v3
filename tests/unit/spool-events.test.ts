/**
 * Unit tests for the §5.7 per-event SSE spool (src/utils/spool-events.ts).
 *
 * The receive loop and the ledger are shared with the body directions and are
 * covered by spool-ingress.test.ts / spool-response.test.ts; these tests pin
 * what the event direction adds — the framing (byte-exact, no boundary lost to a
 * chunk split), the per-event spill, the cap that applies to one event, the
 * response-allowlist extraction a spilled event goes through, and the
 * backpressure the returned stream is supposed to provide.
 */

import { describe, it, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { streamResponseEvents } from '../../src/utils/spool-events.js';
import { AdmissionOverBudgetError, getAdmittedBytes, resetAdmission } from '../../src/utils/spool-admission.js';
import { getLiveSpillBytes } from '../../src/utils/spool-body.js';
import { SpoolResponseTooLargeError } from '../../src/utils/spool-response.js';
import {
  SPOOL_DEFAULTS,
  eventSpillDir,
  requestSpillDir,
  setSpoolConfig,
  type SpoolConfig,
} from '../../src/utils/spool.js';

const scratchDirs: string[] = [];
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** A fresh temp directory that the test cleanup removes afterwards. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spool-events-test-'));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratchDirs) {
    try {
      chmodSync(dir, 0o700); // a test may have left it read-only
    } catch { /* already writable or already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * Install a test config globally. `thresholdBytes` is small enough that one
 * event crosses it; `maxResponseBytes` is the documented 64 MiB scaled down to
 * something a test can breach with a single event.
 */
function configure(overrides: Partial<SpoolConfig> = {}): SpoolConfig {
  const config: SpoolConfig = {
    ...SPOOL_DEFAULTS,
    enabled: true,
    dir: scratch(),
    thresholdBytes: 64,
    maxRequestBytes: 4096,
    maxResponseBytes: 4096,
    maxTotalBytes: 1 << 20,
    ...overrides,
  };
  setSpoolConfig(config);
  return config;
}

afterEach(() => {
  setSpoolConfig(SPOOL_DEFAULTS);
  // Both are process-wide: a leak here would silently weaken later tests.
  resetAdmission();
  assert.equal(getLiveSpillBytes(), 0, 'every spool must return its reservation');
  assert.equal(getAdmittedBytes(), 0, 'every admitted event must return its lease');
});

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Names of the event spill files currently on disk. */
function eventSpillFiles(config: SpoolConfig): string[] {
  const dir = eventSpillDir(config);
  return existsSync(dir) ? readdirSync(dir) : [];
}

function spilledBytes(config: SpoolConfig): number {
  return eventSpillFiles(config).reduce((sum, name) => sum + statSync(join(eventSpillDir(config), name)).size, 0);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Sourced {
  stream: ReadableStream<Uint8Array>;
  pulls: () => number;
  cancelReason: () => unknown;
  cancelled: () => boolean;
}

/**
 * A strictly demand-driven source that counts how many times it is read and
 * records why it was cancelled. With `highWaterMark: 0` a read happens only
 * while someone actually asks for a chunk, so the count is the plan's
 * §5.7 evidence: reads stop when the client stops reading, and stop at a breach.
 */
function source(chunks: Array<string | Uint8Array>): Sourced {
  let index = 0;
  let pulls = 0;
  let wasCancelled = false;
  let cancelled: unknown;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        pulls += 1;
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        const chunk = chunks[index++];
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      },
      cancel(reason) {
        wasCancelled = true;
        cancelled = reason;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, pulls: () => pulls, cancelReason: () => cancelled, cancelled: () => wasCancelled };
}

/** The chunks concatenated into one buffer. */
function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Bytes emitted before an error, plus the error — for a stream that must not close cleanly. */
async function collect(stream: ReadableStream<Uint8Array>): Promise<{ bytes: Uint8Array; error?: unknown }> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } catch (error) {
    return { bytes: concat(chunks, total), error };
  }
  return { bytes: concat(chunks, total) };
}

/** Everything a stream emits, concatenated. Rethrows whatever the stream errored with. */
async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const { bytes, error } = await collect(stream);
  if (error) throw error;
  return bytes;
}

/** Drain the rest of a reader already in use, concatenated. */
async function drainRest(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.byteLength;
    }
  }
  return concat(chunks, total);
}

/** Split `bytes` into fixed-size chunks; `1` reaches every boundary placement. */
function split(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    out.push(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength)));
  }
  return out;
}

/** Await `promise`, asserting it rejects with `ctor` and a message containing `needle`. */
async function assertRejects(promise: Promise<unknown>, ctor: typeof Error, needle: string): Promise<Error> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ctor, `expected ${ctor.name}, got ${String(caught)}`);
  assert.match((caught as Error).message, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  return caught as Error;
}

/**
 * A small SSE conversation with every framing case the forwarder has to survive:
 * a comment keep-alive, an event with `event:`/`id:` lines, a multi-line data
 * event, a `[DONE]` sentinel, and a final event the stream never terminated.
 */
const CONVERSATION = [
  ': ping\n\n',
  'event: message_start\nid: 7\ndata: {"type":"message_start"}\n\n',
  'data: {"a":1}\ndata: {"b":2}\n\n',
  'data: [DONE]\n\n',
  'data: unterminated tail',
].join('');

/** `bytes` raw bytes as base64, deterministically — the shape a generated image arrives in. */
function imageBase64(bytes: number, fill: number): string {
  return Buffer.alloc(bytes, fill).toString('base64');
}

/**
 * One Gemini streaming chunk carrying a generated image, as the REST API frames
 * it: a bare base64 `inlineData.data` inside the parts array. Built with
 * `JSON.stringify`, so the event the extractor reassembles is expected back
 * byte-for-byte.
 */
function geminiImageEvent(data: string): string {
  const chunk = {
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data } }], role: 'model' } }],
    usageMetadata: { promptTokenCount: 9, totalTokenCount: 9 },
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * One Responses streaming event carrying a generated image
 * (`image_generation_call.result`, bare base64). It has both an `event:` line
 * and a `data:` line, so the envelope either side of the payload is exercised
 * too — only the payload's own span may be replaced.
 */
function responsesImageEvent(result: string): string {
  const event = {
    type: 'response.output_item.done',
    output_index: 0,
    item: { id: 'ig_1', type: 'image_generation_call', status: 'completed', result },
  };
  return `event: response.output_item.done\ndata: ${JSON.stringify(event)}\n\n`;
}

/** The scratch blobs an event's extraction wrote, as `<dir>`-relative names. */
function scratchBlobs(config: SpoolConfig): string[] {
  return eventSpillFiles(config).filter((name) => name.startsWith('evt-blob-'));
}

/** The size on disk of one file in the event spill directory. */
function spillFileSize(config: SpoolConfig, name: string): number {
  return statSync(join(eventSpillDir(config), name)).size;
}

describe('streamResponseEvents — framing (§5.7)', () => {
  it('relays every event byte-exactly, whatever the upstream chunk boundaries are', async () => {
    const config = configure();
    const expected = encoder.encode(CONVERSATION);

    // Chunk size 1 puts a chunk boundary between the two `\n`s of every blank
    // line, which is the case a framing loop gets wrong by losing the boundary
    // (never closing an event, or closing one early).
    for (const size of [1, 2, 3, 7, 40, expected.byteLength]) {
      const src = source(split(expected, size));
      const out = await drain(streamResponseEvents(src.stream));

      assert.equal(out.byteLength, expected.byteLength, `chunk size ${size}: length changed`);
      assert.equal(sha256(out), sha256(expected), `chunk size ${size}: bytes changed`);
      assert.equal(decoder.decode(out), CONVERSATION, `chunk size ${size}: text changed`);
    }

    assert.deepEqual(eventSpillFiles(config), [], 'nothing needed spilling at the default threshold');
    assert.equal(existsSync(requestSpillDir(config)), false, 'an event spill must never touch requests/');
  });

  it('frames even when spilling is disabled, and writes nothing to disk', async () => {
    // Disk use is opt-in (§9.1): `enabled = false` means no spill, not "no
    // framing". Pinned so the decision is visible if the SSE handler wiring ever
    // gates this primitive on the config instead.
    const config: SpoolConfig = { ...SPOOL_DEFAULTS, dir: scratch(), thresholdBytes: 64, maxResponseBytes: 4096 };
    setSpoolConfig(config);
    const expected = encoder.encode(CONVERSATION);

    const out = await drain(streamResponseEvents(source(split(expected, 5)).stream));

    assert.equal(sha256(out), sha256(expected));
    assert.equal(existsSync(eventSpillDir(config)), false, 'a disabled spool must not create the event directory');
  });

  it('carries an event the upstream never terminated rather than dropping it', async () => {
    const src = source(['data: one\n\ndata: two without a blank line']);

    const out = await drain(streamResponseEvents(src.stream));

    assert.equal(decoder.decode(out), 'data: one\n\ndata: two without a blank line');
  });
});

describe('streamResponseEvents — per-event spill (§5.7)', () => {
  it('spills only the event above threshold_bytes, and deletes it once it is written', async () => {
    const config = configure();
    const large = `data: ${'x'.repeat(1000)}\n\n`;
    const src = source(['data: small\n\n', large, 'data: 3\n\n']);
    const reader = streamResponseEvents(src.stream).getReader();

    const first = await reader.read();
    assert.equal(decoder.decode(first.value), 'data: small\n\n');
    assert.deepEqual(eventSpillFiles(config), [], 'an event below the threshold must not touch the disk');

    // The large event is received in full before any of its bytes are handed
    // over — that is what "spill it while receiving it" means — so at the moment
    // its bytes arrive the spill is on disk and charged to max_total_bytes.
    const second = await reader.read();
    assert.equal(decoder.decode(second.value), large);
    assert.match(eventSpillFiles(config)[0] ?? '', /^evt-[0-9a-f-]{36}\.body$/);
    assert.equal(spilledBytes(config), large.length, 'exactly the event is on disk, nothing double-written');
    assert.equal(getLiveSpillBytes(), large.length, 'an event on disk must be charged to the shared budget');

    const rest = await drainRest(reader);
    assert.equal(decoder.decode(rest), 'data: 3\n\n');
    assert.deepEqual(eventSpillFiles(config), [], 'the spill must be deleted once the client has taken the bytes');
    assert.equal(getLiveSpillBytes(), 0);
    assert.equal(src.pulls(), 4, 'three events, then the read that reports the end of the stream');
  });

  it('holds at most one event on disk at a time', async () => {
    // Stream length must not set disk use: that is the difference between a
    // per-event spool and accumulating the whole SSE response on disk, which
    // §9.5 rejects.
    const config = configure({ thresholdBytes: 32 });
    const events = Array.from({ length: 4 }, (_, i) => `data: ${String(i).repeat(200)}\n\n`);
    const reader = streamResponseEvents(source(events).stream).getReader();

    let seen = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += value?.byteLength ?? 0;
      if (seen < events.join('').length) {
        assert.equal(eventSpillFiles(config).length, 1, `exactly one event may be spilled, saw ${eventSpillFiles(config).length}`);
      }
    }

    assert.equal(seen, events.join('').length);
    assert.deepEqual(eventSpillFiles(config), []);
  });

  it('cancels the upstream and releases the spill when the client disconnects mid-event', async () => {
    const config = configure();
    const large = `data: ${'y'.repeat(500)}\n\n`;
    const src = source([large, 'data: never\n\n']);
    const reader = streamResponseEvents(src.stream).getReader();

    const first = await reader.read();
    assert.equal(decoder.decode(first.value), large);
    assert.equal(getLiveSpillBytes(), large.length, 'the event being written is on disk');

    const reason = new Error('client went away');
    await reader.cancel(reason);

    assert.equal(src.cancelReason(), reason, 'a client disconnect must reach the upstream, not leave it flowing');
    assert.deepEqual(eventSpillFiles(config), [], 'the spill of an abandoned event must be removed');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('cancels upstream and cleans up when a spilled event ends short during delivery', async () => {
    const config = configure({ maxResponseBytes: 200000 });
    const large = `data: ${'x'.repeat(100000)}\n\n`;
    const src = source([large, 'data: must-not-arrive\n\n']);
    const reader = streamResponseEvents(src.stream).getReader();

    const first = await reader.read();
    assert.equal(first.value?.byteLength, 64 * 1024, 'the large event is delivered in bounded chunks');
    const [spill] = eventSpillFiles(config);
    assert.ok(spill, 'the event must still be live on disk while it is being read');
    truncateSync(join(eventSpillDir(config), spill), 0);

    await assert.rejects(drainRest(reader), /ended at 65536 of 100008 bytes/);

    assert.equal(src.cancelled(), true, 'a spill read failure must cancel the producer, not only the client stream');
    assert.deepEqual(eventSpillFiles(config), [], 'the failed event spill is removed');
    assert.equal(getLiveSpillBytes(), 0);
  });
});

describe('streamResponseEvents — the cap applies to one event (§5.7)', () => {
  it('accepts an event exactly at max_response_bytes and rejects one byte past it', async () => {
    configure({ maxResponseBytes: 100, thresholdBytes: 4096 });
    const exact = `data: ${'a'.repeat(92)}\n\n`; // 6 + 92 + 2 = 100
    assert.equal(exact.length, 100);

    const out = await drain(streamResponseEvents(source(split(encoder.encode(exact), 33)).stream));
    assert.equal(decoder.decode(out), exact);

    const over = `data: ${'a'.repeat(93)}\n\n`;
    const error = await assertRejects(
      drain(streamResponseEvents(source([over]).stream)),
      SpoolResponseTooLargeError,
      'SSE event body too large: exceeded 100 bytes',
    );
    assert.equal(error.status, 500, 'the client sent a legal request: not a 4xx');
    assert.equal(error.type, 'processing_error');
  });

  it('aborts instead of truncating when an event breaches the cap mid-stream', async () => {
    const config = configure({ maxResponseBytes: 200 });
    const oversized = `data: ${'z'.repeat(800)}\n\n`;
    // The `[DONE]` sits after the event that breaches the cap, in the same
    // upstream chunk: §5.7 forbids emitting a terminal `[DONE]` once the failure
    // lands, so the client must see the error and not the sentinel.
    const src = source(['data: kept\n\n', oversized, 'data: [DONE]\n\n']);
    const { bytes, error } = await collect(streamResponseEvents(src.stream));

    assert.ok(error instanceof SpoolResponseTooLargeError, `expected the cap error, got ${String(error)}`);
    const delivered = decoder.decode(bytes);
    assert.equal(delivered, 'data: kept\n\n', 'only the event that fits may be delivered');
    assert.equal(delivered.includes('[DONE]'), false, 'a failed stream must not be terminated as if it succeeded');
    assert.ok(src.pulls() <= 3, `the upstream must stop at the breach, not drain (pulls: ${src.pulls()})`);
    // The receive loop cancels without a reason, so only the fact of the cancel
    // is observable here; the reason-carrying case is the client disconnect below.
    assert.equal(src.cancelled(), true, 'the upstream must be cancelled at the breach');
    assert.deepEqual(eventSpillFiles(config), [], 'the partial event spill must be removed');
    assert.equal(getLiveSpillBytes(), 0, 'the partial reservation must be returned');
  });
});

describe('streamResponseEvents — backpressure (§5.7)', () => {
  it('reads upstream only while the client is asking for bytes', async () => {
    configure();
    const src = source(['data: 1\n\n', 'data: 2\n\n', 'data: 3\n\n']);
    const reader = streamResponseEvents(src.stream).getReader();

    const first = await reader.read();
    assert.equal(decoder.decode(first.value), 'data: 1\n\n');
    assert.equal(src.pulls(), 1, 'one event needed exactly one upstream read');

    // A client that stops reading must stop the upstream: with a push-based
    // loop the remaining events would already be queued in RAM by now.
    await delay(50);
    assert.equal(src.pulls(), 1, 'a stalled client must not pull the stream into this process');

    const rest = await drainRest(reader);
    assert.equal(decoder.decode(rest), 'data: 2\n\ndata: 3\n\n');
    assert.equal(src.pulls(), 4, 'three events, then the read that reports the end of the stream');
  }, { timeout: 15000 });
});

describe('streamResponseEvents — binary payload extraction (§5.7)', () => {
  it('extracts a large Gemini inline image among ordinary events and emits it back unchanged', async () => {
    const config = configure({ thresholdBytes: 1024, maxResponseBytes: 200_000 });
    const data = imageBase64(4096, 7);
    const small = 'event: message_start\ndata: {"type":"message_start"}\n\n';
    const image = geminiImageEvent(data);
    const done = 'data: [DONE]\n\n';
    const expected = encoder.encode(image + done);

    const reader = streamResponseEvents(source([small, image, done]).stream).getReader();

    const first = await reader.read();
    assert.equal(decoder.decode(first.value), small, 'an event below the threshold still passes through untouched');
    assert.deepEqual(scratchBlobs(config), [], 'nothing allowlisted, so no scratch blob');

    // The event itself is spilled, and its payload is on disk as a scratch blob
    // while the event is still being written: the plan's "skeleton interleaved
    // with blob chunks", not a re-serialized event held on the heap.
    const second = await reader.read();
    const blobs = scratchBlobs(config);
    assert.equal(blobs.length, 1, `one extracted payload, saw ${blobs.length} scratch blob(s)`);
    assert.match(blobs[0], new RegExp(`^evt-blob-[0-9a-f]{16}-${sha256(encoder.encode(data))}\\.blob$`));
    assert.equal(spillFileSize(config, blobs[0]), data.length, 'the blob is exactly the base64 payload');
    assert.equal(decoder.decode(second.value), 'data: ', 'the envelope up to the payload is copied from the event, verbatim');
    assert.equal(getLiveSpillBytes(), image.length, 'only the event spill is charged; the scratch blob is not a cache entry');

    const rest = await drainRest(reader);
    const chunks = [second.value!, rest];
    const reassembled = concat(chunks, chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
    assert.equal(
      sha256(reassembled),
      sha256(expected),
      'the extracted event, and the `[DONE]` after it, must be the bytes upstream sent',
    );
    assert.equal(decoder.decode(reassembled).startsWith(image), true, 'the extracted event reassembles in place');
    assert.equal(spilledBytes(config), 0, 'the event spill and its scratch blob are gone once the event is delivered');
    assert.equal(decoder.decode(reassembled).includes('[[ref:'), false, 'no ref may reach the client');

    assert.deepEqual(eventSpillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('extracts a large Responses image_generation_call result and keeps its event: envelope', async () => {
    const config = configure({ thresholdBytes: 1024, maxResponseBytes: 200_000 });
    const result = imageBase64(4096, 11);
    const event = responsesImageEvent(result);
    const src = source([event]);

    const reader = streamResponseEvents(src.stream).getReader();
    const first = await reader.read();
    assert.equal(scratchBlobs(config).length, 1, 'the result payload must be extracted');
    assert.equal(spillFileSize(config, scratchBlobs(config)[0]), result.length);
    assert.equal(
      decoder.decode(first.value),
      'event: response.output_item.done\ndata: ',
      'the event name and the JSON before the payload are copied from the event, not re-serialized',
    );

    const rest = await drainRest(reader);
    const reassembled = concat([first.value!, rest], (first.value?.byteLength ?? 0) + rest.byteLength);
    assert.equal(sha256(reassembled), sha256(encoder.encode(event)));
    assert.deepEqual(eventSpillFiles(config), []);
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('replays a spilled event with nothing allowlisted from its spill, byte for byte', async () => {
    const config = configure({ thresholdBytes: 1024, maxResponseBytes: 200_000 });
    // Over the threshold, valid JSON, and nothing the response allowlist names.
    const event = `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 5 }, note: 'n'.repeat(4096) })}\n\n`;

    const reader = streamResponseEvents(source([event]).stream).getReader();
    const first = await reader.read();

    assert.deepEqual(scratchBlobs(config), [], 'no allowlisted payload — nothing may be extracted');
    assert.equal(eventSpillFiles(config).length, 1, 'the event itself is still spilled while it is read');
    assert.match(first.value ? decoder.decode(first.value) : '', /^data: \{"type":"message_delta"/);

    const rest = await drainRest(reader);
    const reassembled = concat([first.value!, rest], (first.value?.byteLength ?? 0) + rest.byteLength);
    assert.equal(sha256(reassembled), sha256(encoder.encode(event)), 'an unread event must replay its own bytes');
    assert.deepEqual(eventSpillFiles(config), []);
  });

  it('disposes the scratch store when the client disconnects mid-extracted-event', async () => {
    const config = configure({ thresholdBytes: 1024, maxResponseBytes: 200_000 });
    const src = source([geminiImageEvent(imageBase64(4096, 3)), 'data: never\n\n']);
    const reader = streamResponseEvents(src.stream).getReader();

    await reader.read(); // the envelope chunk: the payload is still on disk
    assert.equal(scratchBlobs(config).length, 1);

    const reason = new Error('client went away');
    await reader.cancel(reason);

    assert.equal(src.cancelReason(), reason, 'a disconnect must reach the upstream');
    assert.deepEqual(eventSpillFiles(config), [], 'the abandoned event spill and its scratch blob are both removed');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('refuses to parse an event the materialization budget cannot admit, and aborts', async () => {
    const config = configure({
      thresholdBytes: 1024,
      maxResponseBytes: 200_000,
      maxMaterializedBodyBytes: 4096,
      materializationFactor: 2,
    });
    const src = source(['data: kept\n\n', geminiImageEvent(imageBase64(4096, 5)), 'data: [DONE]\n\n']);

    const { bytes, error } = await collect(streamResponseEvents(src.stream));

    assert.ok(error instanceof AdmissionOverBudgetError, `expected the admission refusal, got ${String(error)}`);
    assert.equal(error.status, 503, 'a budget refusal is a backpressure answer, not a client error');
    assert.equal(decoder.decode(bytes), 'data: kept\n\n', 'the events already delivered stand; the rest is refused');
    assert.equal(decoder.decode(bytes).includes('[DONE]'), false, 'a stream aborted before its end has no sentinel');
    assert.equal(src.cancelled(), true, 'the upstream must be cancelled, not left flowing');
    assert.deepEqual(eventSpillFiles(config), [], 'the refused event leaves no spill and no scratch blob behind');
    assert.equal(getLiveSpillBytes(), 0);
  });
});

