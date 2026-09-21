/**
 * JSON-RPC 2.0 control channel over stdio (`--rpc` mode).
 *
 * Implements the server side of the protocol in docs/design_tauri_tray.md: one
 * JSON-RPC object per line on stdin, responses and notifications on stdout.
 * Every method is a thin wrapper over a function the proxy already exposes, so
 * this layer adds no new state — see the doc's §3 method table for the contract.
 *
 * The HTTP socket is already bound by the time startRpc() runs (it is called
 * from inside the server.listen callback in server.ts), so a reply to
 * `status.get` proves the port is live and no readiness probe is needed.
 * Stdin EOF calls shutdown() so the proxy cannot outlive the core that spawned
 * it (an orphan would hold port 8788).
 *
 * stdout is the wire: this module is its only writer in --rpc mode. That is why
 * `models.list` calls toDashboardConfigPayload() directly rather than reusing
 * cli.ts's listModels(), which writes to stdout itself.
 */

import readline from 'readline';
import { statSync } from 'fs';
import type { Env } from './types/shared.js';
import type { ProxyConfig } from './utils/config-loader.js';
import { toDashboardConfigPayload } from './utils/config-loader.js';
import { getActiveRequestCount, getTokensInWindow } from './utils/dashboard-stats.js';
import {
  handleDashboardAddScheduleAlias,
  handleDashboardAgentStats,
  handleDashboardGetConfig,
  handleDashboardGlobalTokenLimit,
  handleDashboardModelQuota,
  handleDashboardModelStats,
  handleDashboardPutConfig,
  handleDashboardRequestStats,
  handleDashboardTestModel,
  handleDashboardToggleToolBlock,
  handleDashboardToolBlocklist,
} from './handlers/dashboard.js';

export interface RpcSource {
  env: Env;
  /** The same closure server.ts hands to TUI/AGENT; forceReload clears the cache. */
  loadConfig: (forceReload?: boolean) => Promise<ProxyConfig>;
  port: number;
  shutdown: () => void;
}

/** Streams the framer reads from and writes to. Injectable so tests need no real stdio. */
export interface RpcIo {
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
}

/** Window for the `stats.tick` token figure — a sliding 24h sum, not a lifetime total. */
const TOKEN_WINDOW_MS = 24 * 60 * 60 * 1000;
const NOTIFY_INTERVAL_MS = 1000;

// JSON-RPC reserved codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
// Implementation-defined server range.
const CONFIG_INVALID = -32001;
const CONFIG_NOT_FOUND = -32002;
const MODEL_NOT_FOUND = -32003;
const UPSTREAM_ERROR = -32004;

interface RpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  id?: unknown;
}

/** The Tier-2 handlers only read the body or the query string, never headers or method. */
function syntheticRequest(body?: unknown, query = ''): Request {
  return new Request(`http://rpc/dashboard/api/x${query}`, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Map a handler's HTTP outcome onto a JSON-RPC error. */
function errorFromResponse(status: number, body: unknown): { code: number; message: string } {
  const message =
    (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${status}`);
  if (status === 404) return { code: MODEL_NOT_FOUND, message };
  if (status === 502) return { code: UPSTREAM_ERROR, message };
  if (status === 400) {
    const hasConfigErrors = !!body && typeof body === 'object' && 'config_errors' in (body as object);
    return { code: hasConfigErrors ? CONFIG_INVALID : INVALID_PARAMS, message };
  }
  return { code: INTERNAL_ERROR, message };
}

/** Read a handler Response as the RPC result, or throw an RpcError-shaped object. */
async function unwrap(response: Response | Promise<Response>): Promise<unknown> {
  const res = await response;
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const { code, message } = errorFromResponse(res.status, body);
    throw { rpcCode: code, rpcMessage: message };
  }
  return body;
}

/** Load the config, turning a load failure into -32002 rather than a generic internal error. */
async function loadConfigOrThrow(source: RpcSource): Promise<ProxyConfig> {
  try {
    return await source.loadConfig();
  } catch (err) {
    throw { rpcCode: CONFIG_NOT_FOUND, rpcMessage: (err as Error).message };
  }
}

function statusGet(source: RpcSource): unknown {
  return {
    running: true,
    port: source.port,
    version: source.env.VERSION,
    pid: process.pid,
    uptimeMs: Math.round(process.uptime() * 1000),
    activeRequests: getActiveRequestCount(),
  };
}

/** Dispatch one request. Returns the result, or throws {rpcCode, rpcMessage}. */
async function dispatch(source: RpcSource, method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'status.get':
      return statusGet(source);

    case 'models.list':
      return toDashboardConfigPayload(await loadConfigOrThrow(source));

    case 'config.get':
      return unwrap(handleDashboardGetConfig(await loadConfigOrThrow(source), source.env));

    case 'config.put':
      return unwrap(handleDashboardPutConfig(syntheticRequest(params.payload), source.env, await loadConfigOrThrow(source)));

    case 'config.reload':
      // Reload from the local file: the same closure TUI/AGENT use. /config-reload
      // is not reused — it requires a Consul/Apollo source and refuses otherwise.
      await source.loadConfig(true);
      return { ok: true };

    case 'stats.models':
      return unwrap(handleDashboardModelStats());

    case 'stats.agents':
      return unwrap(handleDashboardAgentStats());

    case 'stats.requests': {
      const data = await unwrap(handleDashboardRequestStats()) as Record<string, unknown>;
      const limit = params.limit;
      if (typeof limit === 'number' && Number.isInteger(limit) && limit >= 0) {
        for (const [key, value] of Object.entries(data)) {
          if (Array.isArray(value)) data[key] = value.slice(0, limit);
        }
      }
      return data;
    }

    case 'quota.get': {
      const query = typeof params.model === 'string'
        ? `?model=${encodeURIComponent(params.model)}`
        : typeof params.baseUrl === 'string'
          ? `?base_url=${encodeURIComponent(params.baseUrl)}`
          : '';
      return unwrap(handleDashboardModelQuota(syntheticRequest(undefined, query), await loadConfigOrThrow(source)));
    }

    case 'tools.blocklist':
      return unwrap(handleDashboardToolBlocklist());

    case 'tools.toggleBlock':
      return unwrap(handleDashboardToggleToolBlock(syntheticRequest(params)));

    case 'model.test':
      return unwrap(handleDashboardTestModel(syntheticRequest({ modelId: params.modelId }), source.env, await loadConfigOrThrow(source)));

    case 'tokenLimit.set':
      return unwrap(handleDashboardGlobalTokenLimit(syntheticRequest({ value: params.value ?? null }), source.env));

    case 'schedule.alias':
      return unwrap(handleDashboardAddScheduleAlias(syntheticRequest(params), source.env));

    case 'shutdown':
      // handleLine() calls source.shutdown() once the reply has been written.
      return { ok: true };

    default:
      throw { rpcCode: METHOD_NOT_FOUND, rpcMessage: `Method not found: ${method}` };
  }
}

function isRpcRequest(value: unknown): value is RpcRequest {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    typeof (value as { method?: unknown }).method === 'string'
  );
}

/**
 * Start the RPC reader and notification poller.
 * Returns a stop handle that detaches the reader without triggering shutdown.
 */
export function startRpc(source: RpcSource, io: RpcIo = { input: process.stdin, output: process.stdout }): () => void {
  const write = (message: unknown): void => {
    io.output.write(`${JSON.stringify(message)}\n`);
  };
  const errorReply = (code: number, message: string, id: unknown): void => {
    write({ jsonrpc: '2.0', error: { code, message }, id });
  };

  let stopped = false;

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (trimmed === '') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      errorReply(PARSE_ERROR, 'Parse error', null);
      return;
    }

    if (!isRpcRequest(parsed)) {
      errorReply(INVALID_REQUEST, 'Invalid Request', null);
      return;
    }

    // A request without an id is a notification: act on it but never reply.
    const isNotification = !('id' in parsed);
    try {
      const result = await dispatch(source, parsed.method, parsed.params ?? {});
      if (!isNotification) write({ jsonrpc: '2.0', result, id: parsed.id });
      if (parsed.method === 'shutdown') {
        // Reply first, then let the event loop flush stdout before exiting.
        setImmediate(() => source.shutdown());
      }
    } catch (err) {
      const { rpcCode, rpcMessage } = err as { rpcCode?: number; rpcMessage?: string };
      const code = rpcCode ?? INTERNAL_ERROR;
      const message = rpcMessage ?? (err as Error).message ?? 'Internal error';
      if (!isNotification) errorReply(code, message, parsed.id);
    }
  };

  const rl = readline.createInterface({ input: io.input, terminal: false });
  rl.on('line', (line) => { void handleLine(line); });
  // Stdin EOF means the core that spawned us is gone.
  rl.on('close', () => { if (!stopped) source.shutdown(); });

  // Poll-and-diff: read existing getters, emit only on change. Keeping this
  // here (rather than instrumenting the request hot path) is what leaves
  // index.ts and dashboard-stats.ts untouched.
  let prevActive = -1;
  let prevTokens = -1;
  let prevMtime = -1;
  const timer = setInterval(() => {
    const activeRequests = getActiveRequestCount();
    const tokensTotal = getTokensInWindow(TOKEN_WINDOW_MS);
    if (activeRequests !== prevActive || tokensTotal !== prevTokens) {
      prevActive = activeRequests;
      prevTokens = tokensTotal;
      write({ jsonrpc: '2.0', method: 'stats.tick', params: { activeRequests, tokensTotal } });
    }

    const configPath = source.env.PROXY_CONFIG_PATH;
    if (configPath) {
      try {
        const mtime = statSync(configPath).mtimeMs;
        if (mtime !== prevMtime) {
          prevMtime = mtime;
          write({ jsonrpc: '2.0', method: 'config.changed', params: { path: configPath, mtime } });
        }
      } catch {
        // File missing/unreadable: nothing to report, and failing loud here
        // would spam the wire once a second. The next successful stat reports.
      }
    }
  }, NOTIFY_INTERVAL_MS);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
    rl.close();
  };
}
