/**
 * Logger utility with configurable log levels for Cloudflare Workers
 * Log levels: trace=-1, debug=0, info=1, warn=2, error=3, silent=4
 */

import { Env } from '../types/shared.js';

export interface Logger {
  /**
   * True when the configured log level admits trace output. Callers that must
   * build an expensive trace argument first (logPipelineStage stringifies a
   * whole request/response body) check this before doing the work; `trace`
   * still gates on its own, so an unchecked call is only wasteful, not wrong.
   */
  traceEnabled: boolean;
  trace: (requestId: string, message: string, ...args: unknown[]) => void;
  debug: (requestId: string, message: string, ...args: unknown[]) => void;
  info: (requestId: string, message: string, ...args: unknown[]) => void;
  warn: (requestId: string, message: string, ...args: unknown[]) => void;
  error: (requestId: string, message: string, ...args: unknown[]) => void;
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LOG_LEVELS: Record<LogLevel, number> = {
  trace: -1,
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4, // above every emit threshold, so every level is suppressed
};

/**
 * Shorten a request id for log display only: keep the last 8 digits of the
 * `req_<unix_ms>_` timestamp and the first 6 chars of the UUID's final group.
 * e.g. req_1783840535295_2a042b05-4d3f-4411-a808-5266bdbac7f1
 *   →  req_40535295_5266bd
 *
 * Dropping the timestamp's leading digits discards multiples of 1e8 ms, so the
 * displayed value repeats every ~27.8 hours — enough to time and correlate
 * requests in a live/recent log, but NOT a full date. Recover the original as
 * `<dropped prefix> * 1e8 + <shown digits>`; over a window longer than ~27.8h
 * two distinct requests can display the same digits. The 6-char UUID fragment is
 * 24 bits (~16.7M values), so concurrent requests within the same displayed ms
 * can collide far more readily than the full id — fine for eyeballing a log,
 * not a unique key. The full id is unchanged everywhere else (it's what upstream
 * correlation uses) — this is display only.
 *
 * Non-matching ids are logged unchanged.
 */
function shortRequestId(requestId: string): string {
  const m = /^req_(\d+)_(.+)$/.exec(requestId);
  if (!m) return requestId;
  return `req_${m[1].slice(-8)}_${m[2].slice(-12, -6)}`;
}

/** Pipeline stage at which a message body is being logged. */
export type PipelineStage =
  | 'inbound'           // 1) raw body as received at the endpoint, before conversion
  | 'upstream-request'  // 2) body after conversion, about to be sent upstream
  | 'upstream-response' // 3) raw body received back from upstream
  | 'outbound';         // 4) body after conversion, about to be returned to the client

export const PIPELINE_STAGE_LABEL: Record<PipelineStage, string> = {
  inbound: 'IN',
  'upstream-request': 'UPSTREAM-REQ',
  'upstream-response': 'UPSTREAM-RESP',
  outbound: 'OUT',
};

/**
 * Log a message body at one of the four proxy pipeline stages:
 *   1. inbound            — body as received at the endpoint (pre-conversion)
 *   2. upstream-request   — body after conversion, sent to the upstream
 *   3. upstream-response  — raw body received back from the upstream
 *   4. outbound           — body after conversion, returned to the client
 *
 * Returns immediately unless the logger admits trace output: stringifying a
 * multi-megabyte request/response body (or a converted object graph holding
 * one) at every pipeline stage costs a full copy per stage even when trace
 * logging is off, so the gate has to come before the `JSON.stringify`, not
 * only inside `logger.trace`.
 */
export function logPipelineStage(
  logger: Logger,
  requestId: string,
  stage: PipelineStage,
  endpoint: string,
  body: unknown,
  maxLen = 2000000,
): void {
  if (!logger.traceEnabled) return;
  const text = typeof body === 'string' ? body : (() => { try { return JSON.stringify(body); } catch { return String(body); } })();
  const preview = text.length > maxLen ? `${text.slice(0, maxLen)}... (${text.length} bytes total)` : text;
  logger.trace(requestId, `[${PIPELINE_STAGE_LABEL[stage]}] ${endpoint}: ${preview}`);
}

/**
 * Observe a response stream for pipeline trace logging, in a single pass.
 *
 * Plan §5.7: "remove response `tee()` branches used only for logging and replace
 * them with single-pass observation". A `tee()` gives the logging branch its own
 * reader that runs as fast as it can, so whenever the client is slower than the
 * upstream the tee's unread queue holds the whole remaining response in RAM — for
 * a log line that the default log level discards anyway. Tapping the one path the
 * client already drives costs no extra copy, and `traceEnabled` is read before any
 * decode, so outside trace logging this is a plain pass-through.
 *
 * `format` is required rather than defaulted because the call sites it replaces
 * hold two different conventions: `'sse-lines'` logs one entry per complete
 * `data: ` line (skipping `[DONE]`), `'chunks'` logs each chunk as it decodes.
 * Each site keeps the one it had.
 *
 * A trace failure becomes one debug line and nothing more: this sits on the
 * client's only path, where a throw would abort a response that the tee'd branch
 * could not have touched.
 */
export function observeStream(
  logger: Logger,
  requestId: string,
  stage: PipelineStage,
  endpoint: string,
  format: 'sse-lines' | 'chunks',
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  let pending = '';

  const logLine = (line: string): void => {
    if (!line.startsWith('data: ')) return;
    const data = line.slice(6);
    if (data.trim() === '[DONE]') return;
    logPipelineStage(logger, requestId, stage, endpoint, data);
  };

  const safely = (work: () => void): void => {
    try {
      work();
    } catch (err) {
      logger.debug(requestId, `Stream observation failed: ${(err as Error).message}`);
    }
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (!logger.traceEnabled) return;
      safely(() => {
        if (format === 'chunks') {
          logPipelineStage(logger, requestId, stage, endpoint, decoder.decode(chunk, { stream: true }));
          return;
        }
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) logLine(line);
      });
    },
    // An event whose terminating newline never arrives — a stream cut off, or a
    // body with no trailing newline at all — is logged rather than left in
    // `pending` to vanish when the stream closes.
    flush() {
      if (format !== 'sse-lines' || pending === '') return;
      const tail = pending + decoder.decode();
      pending = '';
      safely(() => logLine(tail));
    },
  });
}

// AGENT=true runs the interactive agent-session.ts TUI, which already dims its
// own status output (see the dim() helper there) so it reads as background
// chatter behind the agent's streamed reply. The shared proxy logger below has
// no such treatment normally (server.ts/tui.ts want it plain) — but interleaved
// into an agent session it's the same kind of background noise, so it's dimmed
// the same way there, and startup-only config diagnostics (requestId 'config')
// are dropped outright since they have no ongoing value once the session is running.
const AGENT_MODE = process.env.AGENT === 'true' || process.env.AGENT === '1';

function dim(text: string): string {
  return `\x1b[90m${text}\x1b[0m`;
}

const AUTH_HEADER_KEYS = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'anthropic-beta']);

/**
 * Log request/response headers at one of the four proxy pipeline stages.
 * Auth headers (Authorization, x-api-key, x-goog-api-key, anthropic-beta) are stripped entirely.
 * No-op unless LOG_LEVEL=trace.
 */
export function logPipelineHeaders(
  logger: Logger,
  requestId: string,
  stage: PipelineStage,
  endpoint: string,
  headers: Headers | Record<string, string>,
): void {
  const entries: Record<string, string> = {};
  if (headers instanceof Headers) {
    headers.forEach((v, k) => { if (!AUTH_HEADER_KEYS.has(k.toLowerCase())) entries[k] = v; });
  } else {
    for (const [k, v] of Object.entries(headers)) {
      if (!AUTH_HEADER_KEYS.has(k.toLowerCase())) entries[k] = v;
    }
  }
  logger.trace(requestId, `[${PIPELINE_STAGE_LABEL[stage]}-HEADERS] ${endpoint}: ${JSON.stringify(entries)}`);
}

export function createLogger(env: Env | Record<string, unknown>): Logger {
  const logLevelRaw = (env.LOG_LEVEL ?? process.env.LOG_LEVEL) as string | undefined;
  const logLevel = (['trace', 'debug', 'info', 'warn', 'error', 'silent'].includes(logLevelRaw ?? '') ? logLevelRaw : 'info') as LogLevel;
  const minLevel = LOG_LEVELS[logLevel];

  function emit(level: string, requestId: string, message: string, args: unknown[]): void {
    if (AGENT_MODE && requestId === 'config') return; // startup-only diagnostics, not useful mid-session
    const line = AGENT_MODE
      ? `[${level}] ${message}`
      : `[${shortRequestId(requestId)}] [${level}] ${message}`;
    console.log(AGENT_MODE ? dim(line) : line, ...args);
  }

  return {
    traceEnabled: minLevel <= -1,
    trace: (requestId: string, message: string, ...args: unknown[]) => {
      if (minLevel <= -1) emit('TRACE', requestId, message, args);
    },
    debug: (requestId: string, message: string, ...args: unknown[]) => {
      if (minLevel <= 0) emit('DEBUG', requestId, message, args);
    },
    info: (requestId: string, message: string, ...args: unknown[]) => {
      if (minLevel <= 1) emit('INFO', requestId, message, args);
    },
    warn: (requestId: string, message: string, ...args: unknown[]) => {
      if (minLevel <= 2) emit('WARN', requestId, message, args);
    },
    error: (requestId: string, message: string, ...args: unknown[]) => {
      if (minLevel <= 3) emit('ERROR', requestId, message, args);
    },
  };
}
