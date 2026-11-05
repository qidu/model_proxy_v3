/**
 * SSE keep-alive for upstream streams that never emit their own ping events.
 *
 * Claude Code aborts a stream after 5 minutes without any bytes. Pingless
 * upstreams (Bedrock `application/vnd.amazon.eventstream`, many
 * OpenAI-compatible gateways) can stay silent longer than that during long
 * thinking/tool phases, tripping the client abort. This wrapper relays the
 * source stream unchanged and injects an SSE comment line (`: ping\n\n`) when
 * no chunk has been forwarded for `intervalMs`. SSE comment lines are ignored
 * by event parsers, so downstream usage/tool tracking transforms are
 * unaffected.
 *
 * Plan §5.7: "Keep-alive injection and all response transforms must likewise
 * wait for downstream demand rather than unconditionally enqueueing." So this
 * is a pull-driven stream with `highWaterMark: 0`: the previous version read
 * upstream from a detached `start()` loop and enqueued every chunk as it
 * arrived, so when the client was slower than the upstream the wrapper's own
 * queue held the rest of the response in RAM (pings included), and the read
 * loop never paused. Now a pull produces exactly one thing — the next upstream
 * chunk if it arrives within the remaining silence window, otherwise a ping —
 * which means the client's read pace is what reads upstream, and a ping is only
 * ever produced while a consumer is actually waiting for one.
 */

const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * One read of the upstream, with a rejection folded into a value: a read parked
 * across a ping whose source then fails has nobody awaiting it, and an unobserved
 * rejection would take the process down before the consumer asked for anything.
 * The error is handed to the stream by the pulling `pull` instead.
 */
type ReadOutcome =
  | { kind: 'chunk'; value: Uint8Array }
  | { kind: 'done' }
  | { kind: 'error'; error: unknown };

export function wrapSseStreamWithKeepAlive(
  source: ReadableStream<Uint8Array>,
  intervalMs: number = DEFAULT_KEEPALIVE_INTERVAL_MS,
): ReadableStream<Uint8Array> {
  const pingBytes = new TextEncoder().encode(': ping\n\n');
  const reader = source.getReader();
  let lastChunkAt = Date.now();
  let cancelled = false;
  let pending: Promise<ReadOutcome> | null = null;

  const nextChunk = (): Promise<ReadOutcome> => {
    if (!pending) {
      pending = reader.read().then(
        (result) => (result.done
          ? { kind: 'done' as const }
          : { kind: 'chunk' as const, value: result.value }),
        (error) => ({ kind: 'error' as const, error }),
      );
    }
    return pending;
  };

  /**
   * Resolves `null` when the silence deadline passes before the upstream has
   * anything to send. A chunk the source has already queued wins the race: it
   * settles in a microtask, the deadline in a timer.
   *
   * The timer is deliberately left ref'd, unlike the background pollers in
   * `src/rpc.ts`: it is the only thing that can settle a read this pull is
   * already holding, so an idle event loop must not be allowed to walk away
   * from it. It never outlives one interval — cleared as soon as the read wins
   * — so it cannot keep a process up on its own.
   */
  const chunkOrDeadline = (ms: number): Promise<ReadOutcome | null> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), ms);
      nextChunk().then((outcome) => {
        clearTimeout(timer);
        resolve(outcome);
      });
    });

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const waitMs = Math.max(0, lastChunkAt + intervalMs - Date.now());
      const outcome = await chunkOrDeadline(waitMs);
      // The consumer withdrew while this pull was parked: enqueueing or closing
      // now would throw on a stream that is already cancelled.
      if (cancelled) return;
      if (outcome === null) {
        lastChunkAt = Date.now();
        controller.enqueue(pingBytes);
        return;
      }
      pending = null;
      if (outcome.kind === 'error') {
        controller.error(outcome.error);
        return;
      }
      if (outcome.kind === 'done') {
        controller.close();
        return;
      }
      lastChunkAt = Date.now();
      controller.enqueue(outcome.value);
    },
    cancel(reason) {
      cancelled = true;
      return reader.cancel(reason);
    },
  }, { highWaterMark: 0 });
}
