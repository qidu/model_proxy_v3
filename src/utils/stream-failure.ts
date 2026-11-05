/**
 * Mid-stream failure reporting — plan §5.7, "Failure after response streaming
 * begins".
 *
 * Both response tails of `createNodeRequestHandler` end in
 * `pipeline(Readable.fromWeb(response.body), res)`, and a rejection there is one
 * of two very different events:
 *
 *   - the client hung up mid-response. `pipeline` reports
 *     `ERR_STREAM_PREMATURE_CLOSE`, the source is cancelled, and nothing is
 *     wrong: a client that closes a tab is the ordinary case, and logging it
 *     once per abandoned SSE connection would bury the real failures.
 *   - the response body itself failed after the headers were already on the
 *     wire — a spill that ends short, a disk error, a renewal that could not be
 *     served, an upstream reset mid-body. The client sees an aborted connection
 *     (never a clean end), so from the proxy's side this is the only surviving
 *     record of what happened, and §5.7 requires it to be logged with the
 *     request id and the failed stage rather than swallowed.
 *
 * The adapter has neither a logger nor a request id — only `src/index.ts` knows
 * them. They reach it the same way the in-flight release does (see
 * `dashboard-stats.ts`): a symbol hung on the response and consumed once by the
 * server. Two paths share that mechanism rather than a shared metadata map
 * because they have nothing in common beyond "the server needs a closure the
 * handler owns".
 */

import { PIPELINE_STAGE_LABEL, type Logger } from './logger.js';

const STREAM_FAILURE_REPORTER = Symbol('streamFailureReporter');

/**
 * The one rejection `pipeline` reports for an ordinary client disconnect.
 * Deliberately minimal: every other error is reported, because silently
 * swallowing a genuine upstream or disk failure (repo rule #8) is the worse
 * outcome, and a false log line is far cheaper than a missing one.
 */
const CLIENT_DISCONNECT_CODE = 'ERR_STREAM_PREMATURE_CLOSE';

export type StreamFailureReporter = (error: unknown) => void;

/**
 * Hang a reporter on the response for the Node adapter, which is the only place
 * that sees the response body's pipeline fail.
 */
export function attachStreamFailureReporter(
  response: Response,
  logger: Logger,
  requestId: string,
  endpoint: string,
): void {
  (response as unknown as Record<symbol, unknown>)[STREAM_FAILURE_REPORTER] = (error: unknown) => {
    if ((error as { code?: unknown } | null | undefined)?.code === CLIENT_DISCONNECT_CODE) return;
    // A non-Error rejection is not a reason to log nothing: `String(error)` at
    // least names it. The spill's own failures carry their path and byte counts
    // in the message, which is the part an operator needs.
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(
      requestId,
      `[${PIPELINE_STAGE_LABEL.outbound}] ${endpoint}: response stream failed after headers were sent: ${detail}`,
    );
  };
}

/**
 * Take the reporter off the response. Once — the adapter runs it from a
 * `catch`, and the safety-net `release` may be reached by a second path; a
 * second consume must not yield a second report.
 */
export function consumeStreamFailureReporter(response: Response): StreamFailureReporter | undefined {
  const holder = response as unknown as Record<symbol, unknown>;
  const reporter = holder[STREAM_FAILURE_REPORTER] as StreamFailureReporter | undefined;
  if (reporter) delete holder[STREAM_FAILURE_REPORTER];
  return reporter;
}
