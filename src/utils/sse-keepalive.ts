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
 */

const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000;

export function wrapSseStreamWithKeepAlive(
  source: ReadableStream<Uint8Array>,
  intervalMs: number = DEFAULT_KEEPALIVE_INTERVAL_MS,
): ReadableStream<Uint8Array> {
  const pingBytes = new TextEncoder().encode(': ping\n\n');
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  return new ReadableStream<Uint8Array>({
    start(controller) {
      reader = source.getReader();
      let lastChunkAt = Date.now();
      let settled = false;

      const stop = () => {
        settled = true;
        if (timer !== undefined) {
          clearInterval(timer);
          timer = undefined;
        }
      };

      // Check more often than the interval so a ping lands close to the
      // silence deadline rather than up to one full interval late.
      timer = setInterval(() => {
        if (settled) return;
        if (Date.now() - lastChunkAt >= intervalMs) {
          try {
            controller.enqueue(pingBytes);
            lastChunkAt = Date.now();
          } catch {
            // Stream already closed/errored by the consumer.
            stop();
          }
        }
      }, Math.min(intervalMs, 5_000));
      // Never let the keep-alive timer hold the event loop open on its own.
      (timer as unknown as { unref?: () => void }).unref?.();

      (async () => {
        try {
          for (;;) {
            const { done, value } = await reader!.read();
            if (done) break;
            lastChunkAt = Date.now();
            controller.enqueue(value);
          }
          stop();
          try {
            controller.close();
          } catch {
            // already closed
          }
        } catch (err) {
          stop();
          try {
            controller.error(err);
          } catch {
            // already closed
          }
        }
      })();
    },
    cancel(reason) {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      return reader?.cancel(reason);
    },
  });
}
