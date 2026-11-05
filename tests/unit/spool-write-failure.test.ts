import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getLiveSpillBytes, SpoolWriteError } from '../../src/utils/spool-body.js';
import { streamResponseEvents } from '../../src/utils/spool-events.js';
import { receiveIngressBody } from '../../src/utils/spool-ingress.js';
import { receiveResponseBody } from '../../src/utils/spool-response.js';
import { eventSpillDir, requestSpillDir, responseSpillDir, SPOOL_DEFAULTS, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';

const scratchDirs: string[] = [];

function configure(): SpoolConfig {
  const dir = mkdtempSync(join(tmpdir(), 'spool-write-failure-test-'));
  scratchDirs.push(dir);
  const config: SpoolConfig = {
    ...SPOOL_DEFAULTS,
    enabled: true,
    dir,
    thresholdBytes: 64,
    maxRequestBytes: 4096,
    maxResponseBytes: 4096,
  };
  setSpoolConfig(config);
  return config;
}

afterEach(() => {
  setSpoolConfig(SPOOL_DEFAULTS);
  for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  assert.equal(getLiveSpillBytes(), 0, 'a failed write must return every reserved byte');
});

interface Sourced {
  stream: ReadableStream<Uint8Array>;
  cancelled: () => boolean;
}

function source(chunks: Uint8Array[]): Sourced {
  let index = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index++]);
    },
    cancel() {
      cancelled = true;
    },
  }, { highWaterMark: 0 });
  return { stream, cancelled: () => cancelled };
}

async function failSecondWrite(work: () => Promise<unknown>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'spool-write-failure-probe-'));
  scratchDirs.push(dir);
  const handle = await open(join(dir, 'probe'), 'w');
  const prototype = Object.getPrototypeOf(handle) as FileHandle;
  await handle.close();

  const original = prototype.write;
  let calls = 0;
  prototype.write = async function (this: FileHandle, ...args: any[]) {
    calls += 1;
    if (calls === 2) throw new Error('injected mid-write failure');
    return await original.apply(this, args);
  } as typeof original;
  try {
    await assert.rejects(work(), (error: unknown) => {
      assert.ok(error instanceof SpoolWriteError, `expected SpoolWriteError, got ${String(error)}`);
      assert.match(error.message, /injected mid-write failure/);
      return true;
    });
  } finally {
    prototype.write = original;
  }
}

function files(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe('spill write-failure accounting', () => {
  it('releases the in-flight request chunk reservation and removes the partial spill', async () => {
    const config = configure();
    const src = source([new Uint8Array(100).fill(1), new Uint8Array(100).fill(2)]);

    await failSecondWrite(() => receiveIngressBody(src.stream, { declaredLength: 200 }));

    assert.equal(src.cancelled(), true, 'the client upload is cancelled');
    assert.deepEqual(files(requestSpillDir(config)), [], 'the partial request spill is removed');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('releases the in-flight response chunk reservation and removes the partial spill', async () => {
    const config = configure();
    const src = source([new Uint8Array(100).fill(3), new Uint8Array(100).fill(4)]);

    await failSecondWrite(() => receiveResponseBody(src.stream, { declaredLength: 200 }));

    assert.equal(src.cancelled(), true, 'the upstream response is cancelled');
    assert.deepEqual(files(responseSpillDir(config)), [], 'the partial response spill is removed');
    assert.equal(getLiveSpillBytes(), 0);
  });

  it('releases the in-flight SSE-event chunk reservation and removes the partial spill', async () => {
    const config = configure();
    const src = source([
      new TextEncoder().encode(`data: ${'x'.repeat(100)}`),
      new TextEncoder().encode(`${'y'.repeat(100)}\n\n`),
    ]);

    await failSecondWrite(() => new Response(streamResponseEvents(src.stream)).text());

    assert.equal(src.cancelled(), true, 'the upstream SSE body is cancelled');
    assert.deepEqual(files(eventSpillDir(config)), [], 'the partial event spill is removed');
    assert.equal(getLiveSpillBytes(), 0);
  });
});
