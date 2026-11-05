/**
 * Unit tests for §5.9's optional byte admission (src/utils/spool-admission.ts).
 *
 * These tests are the module's only consumer so far: §5.9's reservation has to be
 * threaded through the request path before anything in `src/index.ts` calls it,
 * and that threading is its own change. What is pinned here is the accounting the
 * wiring will rely on — the nominal reservation, the hard cap, arrival order and
 * head-of-line fairness, the bounded queue and wait, the refusal classes, and the
 * exactly-once release under abort, timeout and reset.
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  AdmissionOverBudgetError,
  AdmissionQueueFullError,
  AdmissionTimeoutError,
  admitMaterialization,
  getAdmissionQueueDepth,
  getAdmittedBytes,
  resetAdmission,
} from '../../src/utils/spool-admission.js';
import { SPOOL_DEFAULTS, setSpoolConfig, type SpoolConfig } from '../../src/utils/spool.js';

/**
 * Install a test config globally. The wait is short so a timing-out case does not
 * hold the test run; no directory is created because admission never touches
 * disk, whatever `enabled` says.
 */
function configure(overrides: Partial<SpoolConfig> = {}): SpoolConfig {
  const config: SpoolConfig = { ...SPOOL_DEFAULTS, admissionTimeoutMs: 1000, ...overrides };
  setSpoolConfig(config);
  return config;
}

afterEach(() => {
  const leakedBytes = getAdmittedBytes();
  const queuedWaiters = getAdmissionQueueDepth();
  resetAdmission();
  setSpoolConfig(SPOOL_DEFAULTS);
  assert.equal(leakedBytes, 0, 'every lease must be released');
  assert.equal(queuedWaiters, 0, 'no test may leave a body queued');
});

/** Let every pending microtask and timer callback so far run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** What a promise did, observable without awaiting it. */
interface Tracked<T> {
  settled: () => boolean;
  value: () => T | undefined;
  error: () => unknown;
}

/** Watch a promise settle, so a test can assert that it has *not* settled yet. */
function track<T>(promise: Promise<T>): Tracked<T> {
  let settled = false;
  let value: T | undefined;
  let error: unknown;
  promise.then(
    (result) => {
      settled = true;
      value = result;
    },
    (failure) => {
      settled = true;
      error = failure;
    },
  );
  return { settled: () => settled, value: () => value, error: () => error };
}

/**
 * Assert a refusal is the expected admission error, carrying the documented
 * status and type and naming the limit it breached. Returns it for message checks.
 */
async function assertRefused(
  promise: Promise<unknown>,
  ErrorClass: new (message: string) => Error,
  status: number,
  type: string,
  messagePart: string,
): Promise<Error> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ErrorClass, `expected ${ErrorClass.name}, got ${String(caught)}`);
  const refusal = caught as Error & { status: number; type: string };
  assert.equal(refusal.status, status);
  assert.equal(refusal.type, type);
  assert.ok(refusal.message.includes(messagePart), `message ${JSON.stringify(refusal.message)} names ${messagePart}`);
  return refusal;
}

describe('spool admission (§5.9)', () => {
  it('with the default budget (0) admits everything, charges nothing, and queues nothing', async () => {
    configure({ maxMaterializedBodyBytes: 0 });

    const first = await admitMaterialization(1 << 30);
    const second = await admitMaterialization(1 << 30);

    assert.equal(first.nominalBytes, 0, 'a disabled budget holds no nominal bytes');
    assert.equal(second.nominalBytes, 0);
    assert.equal(getAdmittedBytes(), 0, 'a disabled budget has no ledger');
    assert.equal(getAdmissionQueueDepth(), 0, 'a disabled budget never queues, so both bodies are live at once');

    first.release();
    first.release();
    second.release();
    assert.equal(getAdmittedBytes(), 0);
  });

  it('reserves ceil(bytes × materialization_factor), not the byte count', async () => {
    configure({ maxMaterializedBodyBytes: 10_000, materializationFactor: 2.0 });
    const doubled = await admitMaterialization(1000);
    assert.equal(doubled.nominalBytes, 2000, 'the factor is charged, not the raw byte count');
    assert.equal(getAdmittedBytes(), 2000);
    doubled.release();

    configure({ maxMaterializedBodyBytes: 10_000, materializationFactor: 1.5 });
    const rounded = await admitMaterialization(101);
    assert.equal(rounded.nominalBytes, 152, 'a fractional reservation rounds up');
    assert.equal(getAdmittedBytes(), 152);
    rounded.release();
    assert.equal(getAdmittedBytes(), 0);
  });

  it('never admits more nominal bytes than the budget, and hands freed bytes to the queue', async () => {
    configure({ maxMaterializedBodyBytes: 1000, materializationFactor: 1, maxAdmissionQueue: 8 });

    const a = await admitMaterialization(600);
    assert.equal(getAdmittedBytes(), 600);
    const b = await admitMaterialization(400);
    assert.equal(getAdmittedBytes(), 1000, 'a reservation that fits exactly is admitted');

    const c = track(admitMaterialization(250));
    const d = track(admitMaterialization(250));
    await tick();
    assert.equal(getAdmittedBytes(), 1000, 'queued bodies materialize nothing');
    assert.equal(getAdmissionQueueDepth(), 2);
    assert.equal(c.settled(), false, 'no capacity has been freed');
    assert.equal(d.settled(), false);

    b.release();
    await tick();
    assert.equal(getAdmittedBytes(), 850, '600 held + 250 admitted — the ledger never exceeds the budget');
    assert.equal(c.value()?.nominalBytes, 250, 'the head of the queue is admitted first');
    assert.equal(getAdmissionQueueDepth(), 1, 'the next waiter does not fit yet');
    assert.equal(d.settled(), false);

    a.release();
    await tick();
    assert.equal(d.value()?.nominalBytes, 250);
    assert.equal(getAdmittedBytes(), 500);
    assert.equal(getAdmissionQueueDepth(), 0);

    c.value()?.release();
    d.value()?.release();
    assert.equal(getAdmittedBytes(), 0, 'every handed-out lease returns its bytes');
  });

  it('does not let a small body past a waiting large one', async () => {
    configure({ maxMaterializedBodyBytes: 1000, materializationFactor: 1, maxAdmissionQueue: 8 });
    const admitted: string[] = [];

    const a = await admitMaterialization(600);
    const large = admitMaterialization(900);
    const small = admitMaterialization(100);
    const largeSeen = track(large.then((lease) => { admitted.push('large'); return lease; }));
    const smallSeen = track(small.then((lease) => { admitted.push('small'); return lease; }));

    await tick();
    assert.equal(getAdmissionQueueDepth(), 2);
    assert.equal(smallSeen.settled(), false, '100 bytes would fit now, but arrival order is absolute');

    a.release();
    await tick();
    assert.deepEqual(admitted, ['large', 'small'], 'the queue drains from the head down');
    assert.equal(getAdmittedBytes(), 1000);

    largeSeen.value()?.release();
    smallSeen.value()?.release();
    assert.equal(getAdmittedBytes(), 0);
  });

  it('refuses a body whose nominal reservation exceeds the whole budget instead of queueing it', async () => {
    configure({ maxMaterializedBodyBytes: 1000, materializationFactor: 2 });

    await assertRefused(
      admitMaterialization(600), // nominal 1200
      AdmissionOverBudgetError,
      503,
      'over_limit_error',
      'max_materialized_body_bytes 1000',
    );
    assert.equal(getAdmissionQueueDepth(), 0, 'an impossible body must not occupy the queue');
    assert.equal(getAdmittedBytes(), 0, 'a refusal charges nothing');
  });

  it('refuses the waiter past max_admission_queue and leaves the queue intact', async () => {
    configure({ maxMaterializedBodyBytes: 1000, materializationFactor: 1, maxAdmissionQueue: 2 });

    const held = await admitMaterialization(1000);
    const first = track(admitMaterialization(300));
    const second = track(admitMaterialization(200));
    await tick();
    assert.equal(getAdmissionQueueDepth(), 2);

    await assertRefused(
      admitMaterialization(100),
      AdmissionQueueFullError,
      503,
      'over_limit_error',
      'max_admission_queue 2',
    );
    assert.equal(getAdmittedBytes(), 1000, 'an overflow refusal holds nothing');
    assert.equal(getAdmissionQueueDepth(), 2, 'the two waiters ahead are untouched');

    held.release();
    await tick();
    assert.equal(first.value()?.nominalBytes, 300);
    assert.equal(second.value()?.nominalBytes, 200);
    assert.equal(getAdmittedBytes(), 500);
    first.value()?.release();
    second.value()?.release();
    assert.equal(getAdmittedBytes(), 0);
  });

  it('times a waiter out, and the head it frees admits the waiter behind it', async () => {
    configure({ maxMaterializedBodyBytes: 1000, materializationFactor: 1, admissionTimeoutMs: 20, maxAdmissionQueue: 8 });

    const held = await admitMaterialization(100);
    const large = admitMaterialization(950); // 100 + 950 > 1000: queued
    const largeSeen = track(large);
    const small = admitMaterialization(50); // fits now, but waits behind `large`
    const smallSeen = track(small);
    await tick();
    assert.equal(getAdmissionQueueDepth(), 2);
    assert.equal(smallSeen.settled(), false, 'the small body waits behind the large one');

    await assertRefused(
      large,
      AdmissionTimeoutError,
      503,
      'over_limit_error',
      'admission timed out after 20 ms',
    );
    await tick();
    assert.equal(largeSeen.value(), undefined, 'a timed-out body is never admitted');
    assert.ok(largeSeen.error() instanceof AdmissionTimeoutError, 'the waiter itself sees the timeout');

    assert.equal(smallSeen.value()?.nominalBytes, 50, 'the freed head lets the next waiter through');
    assert.equal(getAdmissionQueueDepth(), 0, 'the timed-out waiter is out of the queue');
    assert.equal(getAdmittedBytes(), 150, 'only the held lease and the newly admitted body are charged');

    held.release();
    smallSeen.value()?.release();
    assert.equal(getAdmittedBytes(), 0);
  });

  it('drops a queued waiter on client abort, rejecting with the caller’s own reason', async () => {
    configure({ maxMaterializedBodyBytes: 1000, materializationFactor: 1, maxAdmissionQueue: 8 });

    const held = await admitMaterialization(1000);
    const controller = new AbortController();
    const reason = new Error('client disconnected');
    const waiting = track(admitMaterialization(400, controller.signal));
    await tick();
    assert.equal(getAdmissionQueueDepth(), 1);

    controller.abort(reason);
    await tick();
    assert.equal(waiting.error(), reason, 'the abort reason reaches the caller unchanged');
    assert.equal(waiting.value(), undefined);
    assert.equal(getAdmissionQueueDepth(), 0);
    assert.equal(getAdmittedBytes(), 1000, 'an aborted wait frees nothing to charge');

    held.release();
    await tick();
    assert.equal(getAdmittedBytes(), 0, 'the aborted waiter is not admitted by the release');
    assert.equal(waiting.value(), undefined);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort(reason);
    await assert.rejects(
      admitMaterialization(10, alreadyAborted.signal),
      (error: unknown) => error === reason,
      'an already-aborted signal rejects without queueing',
    );
    assert.equal(getAdmissionQueueDepth(), 0);
    assert.equal(getAdmittedBytes(), 0);
  });

  it('admits a zero-byte body immediately, even with a queue waiting', async () => {
    configure({ maxMaterializedBodyBytes: 1000, materializationFactor: 1, maxAdmissionQueue: 8 });

    const held = await admitMaterialization(1000);
    const waiting = track(admitMaterialization(500));
    await tick();
    assert.equal(getAdmissionQueueDepth(), 1);

    const empty = await admitMaterialization(0);
    assert.equal(empty.nominalBytes, 0, 'an empty body takes no bytes from anyone');
    assert.equal(getAdmissionQueueDepth(), 1, 'and holds no queue slot');
    assert.equal(getAdmittedBytes(), 1000);
    assert.equal(waiting.settled(), false);

    empty.release();
    held.release();
    await tick();
    assert.equal(waiting.value()?.nominalBytes, 500);
    waiting.value()?.release();
    assert.equal(getAdmittedBytes(), 0);
  });

  it('gives bytes back once, however many times a lease is released', async () => {
    configure({ maxMaterializedBodyBytes: 1000, materializationFactor: 1 });

    const a = await admitMaterialization(400);
    const b = await admitMaterialization(600);
    assert.equal(getAdmittedBytes(), 1000);

    a.release();
    a.release();
    assert.equal(getAdmittedBytes(), 600, 'a second release must not credit the ledger again');

    b.release();
    assert.equal(getAdmittedBytes(), 0);
  });

  it('voids outstanding leases and refuses stranded waiters on a reset', async () => {
    configure({ maxMaterializedBodyBytes: 1000, materializationFactor: 1, maxAdmissionQueue: 8 });

    const held = await admitMaterialization(1000);
    const waiting = track(admitMaterialization(100));
    await tick();
    assert.equal(getAdmissionQueueDepth(), 1);

    resetAdmission();
    await tick();
    assert.equal(getAdmittedBytes(), 0, 'a restart keeps no reservation');
    assert.equal(getAdmissionQueueDepth(), 0);
    const stranded = waiting.error();
    assert.ok(stranded instanceof Error, `expected a refusal, got ${String(stranded)}`);
    assert.ok((stranded as Error).message.includes('admission was reset with 100 nominal bytes'), (stranded as Error).message);

    held.release();
    assert.equal(getAdmittedBytes(), 0, 'a lease from before the reset gives nothing back');
  });

  it('enforces the budget whatever [spool] enabled says', async () => {
    configure({ enabled: false, maxMaterializedBodyBytes: 1000, materializationFactor: 1, maxAdmissionQueue: 8 });

    const held = await admitMaterialization(800);
    assert.equal(getAdmittedBytes(), 800, 'admission does not depend on bytes going to disk');

    const waiting = track(admitMaterialization(800));
    await tick();
    assert.equal(getAdmissionQueueDepth(), 1, 'the second body waits for capacity, not for a spill directory');

    held.release();
    await tick();
    assert.equal(waiting.value()?.nominalBytes, 800);
    assert.equal(getAdmittedBytes(), 800);
    waiting.value()?.release();
    assert.equal(getAdmittedBytes(), 0);
    assert.equal(getAdmissionQueueDepth(), 0);
  });
});
