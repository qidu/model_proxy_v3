/**
 * SSD spool — §5.9's optional byte admission: the nominal RAM budget around
 * full-body materialization.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md (§5.9, §10).
 *
 * Admission bounds materialization and nothing else:
 *
 *   - `max_materialized_body_bytes = 0` (the default) disables it completely —
 *     no ledger, no queue, no wait — so nothing changes unless an operator opts
 *     in. The budget is independent of `[spool] enabled`, exactly as the
 *     per-body caps are: `enabled` decides whether bytes go to disk, the budget
 *     decides how many of them may be materialized at once.
 *   - A caller reserves `ceil(bytes × materialization_factor)` *before* it reads
 *     or parses a body. The factor — not the byte count — is the conservative
 *     guess at decoded text plus parsed objects plus serialization copies.
 *   - No capacity → wait in arrival order. Nothing is materialized while
 *     waiting: the raw body stays on disk, which is the point of the budget.
 *   - The wait is bounded by `admission_timeout_ms` and the queue by
 *     `max_admission_queue`, and both refusals happen before the caller has read
 *     a byte, so the refusal can still be sent as a response.
 *   - A lease is released from the owner's own release point — for a request body
 *     the send boundary, once its binary has become refs, and the request's
 *     `finally` in every other case — and releasing is idempotent, so the later
 *     call is a backstop rather than a double-free. A release hands the bytes
 *     straight to the next waiter, in arrival order. Nothing here survives a
 *     restart.
 *
 * A waiter is admitted only from the head of its class's queue. A small body is
 * never admitted past a waiting large one, because "first body that fits" is how
 * a byte budget starves its own queue. For the same reason an empty body — 0
 * nominal bytes — is admitted immediately rather than queued: it takes no bytes
 * from anyone.
 *
 * Two waiter classes share the one budget. Request bodies wait in the request
 * class; response-side reads (the attempt loop's stats parse, the converting
 * handlers' response parses) wait in the response class, which is admitted and
 * drained first. The split exists for liveness, not priority: a response read
 * can run while its own exchange still holds a request-side lease (a non-ref
 * request keeps its reservation through the attempt loop), so a response read
 * queued *behind* request waiters is hold-and-wait deadlock — the waiters need
 * the lease the response's exchange is holding, and the exchange needs the
 * admission the waiters are blocking. Response-class jumping is bounded: only an
 * already-admitted exchange can produce one, each exchange produces few, and
 * the lease is held for a parse, so a waiting request body is delayed by the
 * in-flight exchanges' drains, not starved by new arrivals. The hard cap is
 * unchanged — a response that does not fit waits (ahead of the request queue),
 * and its timeout is the honest answer to a genuinely over-committed budget.
 *
 * This is not the best-effort L1 promotion that `blob-store.ts` also calls
 * "admission". That one asks whether a payload is worth caching and skips when
 * it does not fit; this one is a hard budget and refuses (§5.9).
 *
 * Decisions baked in here:
 *   - Every refusal is 503 `over_limit_error`, like `spool-body.ts`'s
 *     `SpoolCapacityError` and `blob-store.ts`'s `BlobCapacityError`. §5.9 allows 429 or 503; one status for the whole
 *     byte-budget family keeps the answer independent of the direction the body
 *     travels, since `max_materialized_body_bytes` covers requests, responses and
 *     SSE events alike — where the direction-dependent errors elsewhere are
 *     parameters (`spool-body.ts`'s `TooLargeError`) precisely because the
 *     direction changes the status.
 *   - A body whose nominal reservation exceeds the whole budget is refused
 *     immediately rather than queued: no wait can admit it, and reporting it as
 *     a timeout 30 s later would be a lie (§5.9's "never begin materialization
 *     after rejection").
 *   - Fail loud (repo rule #8): the ledger throws on underflow instead of
 *     clamping it, and {@link resetAdmission} rejects the waiters it strands
 *     instead of leaving their promises pending forever.
 *
 * Wiring status: `src/index.ts` reserves against the received request body before
 * it is parsed (`admitMaterialization(spool.size, request.signal)`) and returns the
 * reservation at the send boundary once the body's inline binary has been reduced
 * to refs — §5.9's "binary reduced to refs: release after extraction" — with the
 * request's `finally` as the backstop for every other path. The response-side
 * callers use {@link admitResponseMaterialization} (the response class, above):
 * `src/handlers/passthrough.ts`, `src/handlers/claude.ts`,
 * `src/handlers/chat-completions.ts`, `src/handlers/gemini.ts`,
 * `src/handlers/responses.ts` and `src/utils/spool-response.ts` around their
 * materialized response bodies, the attempt loop's JSON stats read in
 * `src/index.ts` — the one response parse that runs for every completed JSON
 * response — and the PII restore read in `src/index.ts`
 * (`restorePrivacyResponse`), which receives the client-facing body the handler
 * built. The stats read charges only when the spool is on: it is the spooled
 * receive path that §5.7 substitutes for `response.clone()`, and with the spool
 * off that path is the pre-spool one. §5.9's reservation *before the request path reads* is
 * otherwise still the ingress spool read into text. No send downstream of the
 * boundary re-materializes a payload the boundary already released: every send
 * decides its own §5.3 shape from the refs it is handed, and a body that still has
 * refs is streamed rather than expanded, so §5.9's per-rung re-acquisition has no
 * caller on the send path today. Two expansions exist outside that rule and both
 * are bounded: the `sdk://` branches of `src/handlers/claude.ts` and
 * `src/handlers/messages.ts` expand before their handler answers 501, and
 * `auth_with_body` expands a throwaway clone while the leased body keeps its refs.
 * The one response-side re-materialization is the PII restore above: it rebuilds
 * the client-facing body from the text it received, so that text takes its own
 * §5.9 charge — and, past `threshold_bytes`, its own spill.
 */

import { ClaudeProxyError } from './errors.js';
import { getSpoolConfig } from './spool.js';

/**
 * A body's nominal reservation is larger than the whole budget, so no wait can
 * ever admit it.
 */
export class AdmissionOverBudgetError extends ClaudeProxyError {
  constructor(message: string) {
    super(message, 503, 'over_limit_error');
    this.name = 'AdmissionOverBudgetError';
  }
}

/** The waiter queue already holds `max_admission_queue` bodies. */
export class AdmissionQueueFullError extends ClaudeProxyError {
  constructor(message: string) {
    super(message, 503, 'over_limit_error');
    this.name = 'AdmissionQueueFullError';
  }
}

/** A waiter exceeded `admission_timeout_ms` without capacity freeing up. */
export class AdmissionTimeoutError extends ClaudeProxyError {
  constructor(message: string) {
    super(message, 503, 'over_limit_error');
    this.name = 'AdmissionTimeoutError';
  }
}

/** Nominal bytes held against `max_materialized_body_bytes`. */
export interface AdmissionLease {
  /**
   * What this lease holds. `ceil(bytes × materialization_factor)`, or 0 when the
   * budget is disabled — admission is off, not "this body is free".
   */
  readonly nominalBytes: number;
  /** Give the bytes back and admit the next waiter, in arrival order. Idempotent. */
  release(): void;
}

/**
 * Which side of an exchange is asking. Response-class waiters are admitted and
 * drained first — see the module header's hold-and-wait note.
 */
type WaiterKind = 'request' | 'response';

/** One body waiting for capacity. */
interface Waiter {
  readonly kind: WaiterKind;
  readonly nominalBytes: number;
  /** Set once the waiter has been admitted, refused, or voided, so a late timer or abort is a no-op. */
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly signal: AbortSignal | undefined;
  onAbort: (() => void) | undefined;
  readonly resolve: (lease: AdmissionLease) => void;
  readonly reject: (error: Error) => void;
}

/**
 * Nominal bytes admitted. Process-wide, like the resolved config: the budget is
 * a limit for the whole proxy, not for one request.
 */
let admittedBytes = 0;

/** Request bodies waiting for capacity, oldest first. */
const requestWaiters: Waiter[] = [];

/**
 * Response-side reads waiting for capacity, oldest first. Drained first: they
 * complete the in-flight exchanges whose request leases the request queue is
 * waiting on.
 */
const responseWaiters: Waiter[] = [];

/** The queue one waiter class waits in. */
function queueOf(kind: WaiterKind): Waiter[] {
  return kind === 'response' ? responseWaiters : requestWaiters;
}

/**
 * Bumped by {@link resetAdmission}. A lease remembers the epoch it was made in,
 * so a reservation from before a reset — which for a running process means a
 * restart, where nothing survives (§5.9) — is a no-op to give back rather than an
 * underflow to throw.
 */
let epoch = 0;

/** Nominal bytes currently admitted, for assertions and operator reporting. */
export function getAdmittedBytes(): number {
  return admittedBytes;
}

/** Bodies waiting for capacity right now, across both classes. */
export function getAdmissionQueueDepth(): number {
  return requestWaiters.length + responseWaiters.length;
}

/**
 * Reserve `bytes` worth of materialization before reading or parsing a body.
 *
 * Resolves with a lease the caller must `release()` in a `finally`. Rejects with
 * {@link AdmissionOverBudgetError} when the body can never fit,
 * {@link AdmissionQueueFullError} when the queue is full, or
 * {@link AdmissionTimeoutError} when the wait was too long; an aborted `signal`
 * rejects with its own reason. The caller holds nothing on any rejection, so
 * there is nothing to release.
 *
 * This is the request-side entry: it queues behind every waiter of either
 * class, because a body that holds nothing yet can always wait safely.
 */
export async function admitMaterialization(bytes: number, signal?: AbortSignal): Promise<AdmissionLease> {
  return admit(bytes, signal, 'request');
}

/**
 * The response-side half of {@link admitMaterialization}: admitted ahead of
 * queued request bodies (and drained first) whenever the bytes fit, because a
 * response read can run while its own exchange still holds a request-side
 * lease — queueing it behind request waiters is hold-and-wait deadlock. The
 * hard cap is unchanged; a response that does not fit waits ahead of the
 * request queue and can still time out.
 */
export async function admitResponseMaterialization(bytes: number, signal?: AbortSignal): Promise<AdmissionLease> {
  return admit(bytes, signal, 'response');
}

async function admit(bytes: number, signal: AbortSignal | undefined, kind: WaiterKind): Promise<AdmissionLease> {
  if (!Number.isFinite(bytes) || bytes < 0) {
    throw new Error(`[spool] admission needs a non-negative byte count, got ${String(bytes)}`);
  }
  if (signal?.aborted) {
    throw abortReason(signal);
  }

  const config = getSpoolConfig();
  const budget = config.maxMaterializedBodyBytes;
  if (budget <= 0) {
    return makeLease(0); // §5.9 disabled: no accounting, no queue
  }

  const nominalBytes = Math.ceil(bytes * config.materializationFactor);
  if (nominalBytes <= 0) {
    return makeLease(0);
  }
  if (nominalBytes > budget) {
    throw new AdmissionOverBudgetError(
      `[spool] body cannot be materialized: ${nominalBytes} nominal bytes (${bytes} × ${config.materializationFactor}) ` +
        `exceed max_materialized_body_bytes ${budget}`,
    );
  }

  // Arrival order is absolute within a class: a waiter ahead of us means we
  // queue even if our own bytes happen to fit right now. A response-class read
  // is blocked only by response-class waiters — request bodies queued ahead of
  // it are exactly what its exchange's completion will unblock.
  const queue = queueOf(kind);
  const blockedByEarlierClass = kind === 'request' && responseWaiters.length > 0;
  if (!blockedByEarlierClass && queue.length === 0 && admittedBytes + nominalBytes <= budget) {
    admittedBytes += nominalBytes;
    return makeLease(nominalBytes);
  }

  if (requestWaiters.length + responseWaiters.length >= config.maxAdmissionQueue) {
    throw new AdmissionQueueFullError(
      `[spool] admission queue is full: ${requestWaiters.length + responseWaiters.length} bodies await max_admission_queue ${config.maxAdmissionQueue}`,
    );
  }

  return enqueue(nominalBytes, config.admissionTimeoutMs, signal, kind);
}

/**
 * Drop the ledger, void outstanding leases, and reject every waiter.
 *
 * This is what a restart means for admission (§5.9): reservations are memory
 * state, so none of them is recovered. Tests use it to isolate cases that share
 * one process.
 */
export function resetAdmission(): void {
  epoch += 1;
  admittedBytes = 0;
  for (const waiter of [...responseWaiters, ...requestWaiters]) {
    settle(waiter);
    waiter.reject(new Error(`[spool] admission was reset with ${waiter.nominalBytes} nominal bytes still queued`));
  }
}

/** Wait for capacity in arrival order, bounded by the timeout and the caller's abort. */
function enqueue(nominalBytes: number, timeoutMs: number, signal: AbortSignal | undefined, kind: WaiterKind): Promise<AdmissionLease> {
  return new Promise<AdmissionLease>((resolve, reject) => {
    const waiter: Waiter = { kind, nominalBytes, settled: false, timer: undefined, signal, onAbort: undefined, resolve, reject };

    // Not unref'd: a queued body is real pending work, and its client abort
    // clears the timer through the listener below.
    waiter.timer = setTimeout(() => {
      if (!settle(waiter)) return;
      // The head is gone: whoever queued behind it may fit now.
      drain();
      reject(
        new AdmissionTimeoutError(
          `[spool] admission timed out after ${timeoutMs} ms: ${admittedBytes} of ` +
            `${getSpoolConfig().maxMaterializedBodyBytes} nominal bytes admitted, ` +
            `${responseWaiters.length + requestWaiters.length} still waiting`,
        ),
      );
    }, timeoutMs);

    if (signal) {
      waiter.onAbort = () => {
        if (!settle(waiter)) return;
        drain();
        reject(abortReason(signal));
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }

    queueOf(kind).push(waiter);
  });
}

/**
 * Mark a waiter done, drop its timer and abort listener, and take it out of
 * its queue. Returns false when it was already settled, so a late timer or
 * abort cannot refuse a body that was admitted in the meantime. Removing it
 * here is what makes "queued" and "not settled" the same thing, so
 * {@link drain} never has to skip a waiter.
 */
function settle(waiter: Waiter): boolean {
  if (waiter.settled) return false;
  waiter.settled = true;
  if (waiter.timer !== undefined) {
    clearTimeout(waiter.timer);
    waiter.timer = undefined;
  }
  if (waiter.signal && waiter.onAbort) {
    waiter.signal.removeEventListener('abort', waiter.onAbort);
    waiter.onAbort = undefined;
  }
  const queue = queueOf(waiter.kind);
  const index = queue.indexOf(waiter);
  if (index >= 0) {
    queue.splice(index, 1);
  }
  return true;
}

/**
 * Hand freed bytes to the queues, response class first: those reads complete
 * in-flight exchanges, and a completed exchange releases the request lease its
 * holder may still hold. A response head that does not fit stops the drain for
 * both classes — admitting request bodies past it is the hold-and-wait this
 * ordering exists to prevent. Within a class, stop at the first waiter that
 * does not fit so arrival order holds.
 */
function drain(): void {
  if (!drainQueue(responseWaiters)) return;
  drainQueue(requestWaiters);
}

/** Admit from `queue`'s head down while the head fits. False when the head did not fit. */
function drainQueue(queue: Waiter[]): boolean {
  const budget = getSpoolConfig().maxMaterializedBodyBytes;
  while (queue.length > 0) {
    const head = queue[0];
    if (admittedBytes + head.nominalBytes > budget) return false;
    if (!settle(head)) {
      // Unreachable: settling a waiter takes it out of the queue, so a settled
      // waiter cannot be the head. Loud rather than a double-resolve that would
      // charge bytes no lease owns.
      throw new Error(`[spool] admission queue holds a settled waiter with ${queue.length} waiting`);
    }
    admittedBytes += head.nominalBytes;
    head.resolve(makeLease(head.nominalBytes));
  }
  return true;
}

function makeLease(nominalBytes: number): AdmissionLease {
  const leaseEpoch = epoch;
  let released = false;
  return {
    nominalBytes,
    release(): void {
      if (released) return;
      released = true;
      // A lease from before a reset, or one that was never charged because the
      // budget is disabled, holds nothing to give back.
      if (nominalBytes === 0 || leaseEpoch !== epoch) return;
      if (nominalBytes > admittedBytes) {
        // Only reachable if a lease is double-counted or fabricated; clamping
        // here would hide exactly that accounting bug.
        throw new Error(`[spool] admission ledger underflow: releasing ${nominalBytes} with ${admittedBytes} admitted`);
      }
      admittedBytes -= nominalBytes;
      drain();
    },
  };
}

/** The error an aborted wait rejects with: the caller's own reason, when it has one. */
function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error('[spool] admission wait aborted');
  error.name = 'AbortError';
  return error;
}
