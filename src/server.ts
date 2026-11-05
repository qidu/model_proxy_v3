#!/usr/bin/env node
/**
 * Node.js HTTP server adapter for running in containers
 * Wraps the Workers fetch handler with a native HTTP server
 */

// Must stay the first import: it normalizes --tui/--agent/--dashboard into the
// TUI/AGENT/DASHBOARD env vars at import time, before utils/logger.ts freezes
// AGENT_MODE. See mode-flags.ts.
import { MODE_FLAGS } from './mode-flags.js';
import { createServer } from 'http';
import { pathToFileURL } from 'url';
import type { Env } from './types/shared.js';
import { loadProxyConfig, clearProxyConfigCache, loadProxyConfigFromPath, parseHumanTokenLimit, resolveDefaultProxyConfigPath } from './utils/config-loader.js';
import { consumeActiveRequestRelease, loadTokenStatsFromLog, getWindowMs, setStatsPersistenceEnabled, setTokenRetentionWindow, isEnvFlagEnabled } from './utils/dashboard-stats.js';
import { consumeStreamFailureReporter } from './utils/stream-failure.js';
import { runCli } from './cli.js';

// Import the Workers fetch handler
import handler from './index.js';

// Extend Env interface for Node.js environment
export interface NodeEnv extends Env {
  NODE_ENV: string;
}

export function nodeResponseHeaders(response: Response): Record<string, string> {
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return Object.fromEntries(headers.entries());
}

export function buildNodeEnv(source: NodeJS.ProcessEnv = process.env): NodeEnv {
  return {
    NODE_ENV: source.NODE_ENV || 'production',
    VERSION: source.VERSION || 'dev',
    ALLOWED_ORIGINS: source.ALLOWED_ORIGINS || '*',
    LOCAL_TIKTOKEN: source.LOCAL_TIKTOKEN || 'false',
    ALLOWED_HOSTS: source.ALLOWED_HOSTS || '127.0.0.1,localhost',
    ENABLE_DYNAMIC_ROUTING: source.ENABLE_DYNAMIC_ROUTING || 'false',
    IMAGE_BLOCK_DATA_MAX_SIZE: source.IMAGE_BLOCK_DATA_MAX_SIZE || '10485760',
    // AGENT=true's interactive TUI is noisy at the default 'info' level (every
    // proxy request logs its own line) — default to 'warn' in that mode unless
    // the user explicitly set LOG_LEVEL.
    LOG_LEVEL: source.LOG_LEVEL || ((source.AGENT === 'true' || source.AGENT === '1') ? 'warn' : 'info'),
    GEMINI_API_VERSION: source.GEMINI_API_VERSION || 'v1beta',
    MESSAGES_UPSTREAM_MODE: (source.MESSAGES_UPSTREAM_MODE as 'native' | 'openai-completions') || 'openai-completions',
    INTERACTIONS_UPSTREAM_MODE: (source.INTERACTIONS_UPSTREAM_MODE as 'native' | 'openai-completions') || 'native',
    GENERATE_CONTENT_UPSTREAM_MODE: (source.GENERATE_CONTENT_UPSTREAM_MODE as 'native' | 'openai-completions') || 'native',
    PROXY_CONFIG_PATH: source.PROXY_CONFIG_PATH || (source.TEST_CONFIG ? `./${source.TEST_CONFIG}proxy_config.toml` : resolveDefaultProxyConfigPath()),
    PROXY_CONFIG_CONSUL: source.PROXY_CONFIG_CONSUL,
    PROXY_CONFIG_APOLLO: source.PROXY_CONFIG_APOLLO,
    PORT: source.PORT || '8788',
    DEV_NO_KEY: source.DEV_NO_KEY || 'false',
    PROXY_CLIENT_API_KEY: source.PROXY_CLIENT_API_KEY,
    AGENT: source.AGENT,
    CONVERSATION_STATE: source.CONVERSATION_STATE || 'false',
    PRIVACY_FILTER_URL: source.PRIVACY_FILTER_URL,
    PRIVACY_FILTER_TIMEOUT_MS: source.PRIVACY_FILTER_TIMEOUT_MS,
    PRIVACY_FILTER_MAX_CHARS: source.PRIVACY_FILTER_MAX_CHARS,
    KOMPRESS_URL: source.KOMPRESS_URL,
    KOMPRESS_ENDPOINTS: source.KOMPRESS_ENDPOINTS,
    KOMPRESS_FAIL_OPEN: source.KOMPRESS_FAIL_OPEN,
    KOMPRESS_TIMEOUT_MS: source.KOMPRESS_TIMEOUT_MS,
    KOMPRESS_MAX_CHARS: source.KOMPRESS_MAX_CHARS,
    KOMPRESS_KEEP_RATIO: source.KOMPRESS_KEEP_RATIO,
    KOMPRESS_MIN_CHARS: source.KOMPRESS_MIN_CHARS,
  };
}

/**
 * The request body as a pull-driven stream, plus the drain that releases the
 * upload once the handler is done with it.
 *
 * Attaching a `data` listener on its own — the shape this replaced — puts Node's
 * readable into flowing mode, so a client can push its whole body into the
 * stream's queue no matter how slowly the handler reads it: no backpressure at
 * all (plan §5.1). Here the stream is paused again immediately and only `pull`
 * resumes the socket, so one chunk is released per read the handler makes and
 * the upload is bounded by the handler's consumption rather than by RAM.
 *
 * `drain()` stops delivering socket events into the stream and lets the rest of
 * the upload run into the void. It runs once the handler has returned, for the
 * paths that answer without ever reading the body (auth rejection, dashboard,
 * OPTIONS): a response can only reach a client that is not still blocked
 * writing a body nobody will read.
 */
export function createNodeBodyStream(
  req: import('http').IncomingMessage,
): { stream?: ReadableStream<Uint8Array>; drain: () => void } {
  if (['GET', 'HEAD'].includes(req.method || '')) {
    return { drain: () => {} };
  }

  let ended = false;
  let detached = false;
  let onData: ((chunk: Buffer) => void) | undefined;
  let onEnd: (() => void) | undefined;

  const drain = (): void => {
    if (detached) return;
    detached = true;
    if (onData) req.off('data', onData);
    if (onEnd) req.off('end', onEnd);
    // The 'error' listener stays attached: removing it would turn a late socket
    // error into an uncaught exception.
    req.resume();
  };

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      onData = (chunk: Buffer) => {
        if (ended || detached) return;
        controller.enqueue(chunk);
        // That chunk satisfies the read this was pulled for, so hold the socket
        // here until the handler asks for the next one.
        if (controller.desiredSize !== null && controller.desiredSize <= 0) req.pause();
      };
      onEnd = () => { ended = true; controller.close(); };
      const onError = (error: Error) => { ended = true; controller.error(error); };
      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
      // Attaching 'data' put the readable into flowing mode; pause it again so
      // the first chunk is released by the first `pull`, not before it.
      req.pause();
    },
    pull() {
      req.resume();
    },
    cancel() {
      drain();
    },
  }, { highWaterMark: 0 });

  return { stream, drain };
}

export function createNodeRequestHandler(
  env: NodeEnv,
  fetchHandler: (request: Request, env: NodeEnv) => Promise<Response> = handler.fetch,
) {
  return async (req: import('http').IncomingMessage, res: import('http').ServerResponse) => {
    const body = createNodeBodyStream(req);
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      // Get client connection info from Node.js socket
      const clientAddress = req.socket.remoteAddress || 'unknown';
      const clientPort = req.socket.remotePort?.toString() || 'unknown';

      // Create headers with client info
      const headers = { ...req.headers } as Record<string, string>;
      headers['x-client-address'] = clientAddress;
      headers['x-client-port'] = clientPort;

      const requestInit: any = {
        method: req.method,
        headers,
        body: body.stream,
      };
      if (body.stream) {
        requestInit.duplex = 'half';
      }
      const request = new Request(url.toString(), requestInit);

      const response = await fetchHandler(request, env);

      // Release the in-flight request counter once the body has fully streamed to
      // the client (or immediately when there is no body to send). The release is
      // once-guarded in dashboard-stats, so wiring it to several completion paths
      // (stream close/abort, pipe error, client disconnect) can't double-count.
      const release = consumeActiveRequestRelease(response) ?? (() => {});

      // §5.7: a body that fails after the headers are on the wire aborts the
      // connection, so this reporter is the only record of it. It is silent for
      // an ordinary client hang-up.
      const reportStreamFailure = consumeStreamFailureReporter(response);

      // Streaming vs non-streaming: both write the headers and pipe the body, so
      // the client's pace reaches the sender rather than a buffer. The SSE branch
      // additionally releases on client close (a safety net it has always had).
      const contentType = response.headers.get('content-type') || '';
      const isStreaming = contentType.includes('text/event-stream');

      if (isStreaming && response.body) {
        // For streaming responses (text/event-stream), pipe directly to the Node.js
        // response without consuming the body via .text(), which avoids the
        // "headers already sent" error when the stream body was already locked.
        res.writeHead(response.status, nodeResponseHeaders(response));
        // Plan §5.7: `pipeline()` is what makes the upstream feel the client's
        // pace. Writing into a PassThrough and ignoring the false it returns on a
        // full buffer let a slow client pull the whole remaining response into
        // memory, and on a client disconnect left the upstream body un-cancelled.
        const { Readable } = await import('stream');
        const { pipeline } = await import('stream/promises');
        // Safety net: if the client disconnects mid-stream, release here too.
        res.on('close', release);
        pipeline(Readable.fromWeb(response.body as any), res)
          // A genuine failure here surfaces to the client as a destroyed
          // connection instead of the silently truncated body the old
          // `passthrough.end()` produced, and the reporter logs it with the
          // request id and stage. A client disconnect is the ordinary case and
          // stays silent (see utils/stream-failure.ts).
          .catch((error) => reportStreamFailure?.(error))
          .finally(() => release());
        return;
      }

      res.writeHead(response.status, nodeResponseHeaders(response));

      if (!response.body) {
        res.end();
        release();
        return;
      }

      // Plan §5.7 requires the same `pipeline()` here as on the SSE path: the
      // old `await response.clone().text()` held a second full copy of every
      // non-SSE body (a spooled response included) for as long as the client
      // took to accept it. Piping gives the upstream — or the response spool —
      // the client's write pace instead.
      const { Readable } = await import('stream');
      const { pipeline } = await import('stream/promises');
      pipeline(Readable.fromWeb(response.body as any), res)
        .catch((error) => reportStreamFailure?.(error))
        .finally(() => release());
    } catch (error) {
      console.error('Server error:', error);
      // Only write headers if they haven't been sent yet
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    } finally {
      // The handler has already read whatever part of the body it wants (the
      // spool releases the raw body before it returns), so the remaining upload
      // is discarded from here on.
      body.drain();
    }
  };
}

function main(): void {
  const port = parseInt(process.env.PORT || '8788', 10);
  const env = buildNodeEnv();

  // Diagnostics go to stderr so stdout carries only machine-readable output: the
  // CLI subcommand payloads (src/cli.ts) and, in --rpc mode, the NDJSON JSON-RPC
  // control channel (docs/design_tauri_tray.md). Proxy logging funnels through
  // console.log (src/utils/logger.ts), with a few direct console.log/info/debug
  // call sites besides, so redirect the methods once here rather than at each
  // site — this covers console.log calls added later too. console.error/warn
  // already write to stderr. AGENT=true's interactive session is unaffected in
  // substance: its task output (streamed reply deltas, pi-tui prompts) is written
  // with process.stdout.write and stays on stdout, while its status/progress
  // lines go through console.log and land here on stderr alongside the proxy's
  // own logs. TUI=true overrides these methods again below.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  // The MODE_FLAGS (`--rpc`, `--tui`, `--agent`, `--dashboard`) are *modes*, not
  // runCli() commands: runCli() rejects unknown args and exits after every command,
  // so strip them before the scan. A real command beside them (`--rpc --list-models`)
  // still runs and exits as usual. mode-flags.ts already turned --tui/--agent/
  // --dashboard into the TUI/AGENT/DASHBOARD env vars that the rest of this file reads.
  const argv = process.argv.slice(2);
  const rpcEnabled = argv.includes('--rpc');

  // CLI subcommands exit before the server starts. No args (runCli returns null)
  // preserves the previous behavior of starting the HTTP server.
  const cliExitCode = runCli(argv.filter((arg) => !(MODE_FLAGS as readonly string[]).includes(arg)), env);
  if (cliExitCode !== null) {
    process.exit(cliExitCode);
  }

  // --rpc, TUI and AGENT all want stdout (RPC frames vs. TUI rendering vs. agent
  // output), so combining them is a startup error rather than a silent winner.
  if (rpcEnabled && (env.AGENT === 'true' || env.AGENT === '1' || process.env.TUI === 'true' || process.env.TUI === '1')) {
    console.error('[FATAL] --rpc cannot be combined with AGENT or TUI: all three own stdout.');
    process.exit(2);
  }

  // A stray rejection from a response stream must not kill the proxy. Node's
  // TransformStream clears its cancel algorithm when a transformer calls
  // `controller.terminate()` — which streaming.ts does on `[DONE]` — and any
  // later cancel of that readable then throws from inside `pipeTo`'s own
  // shutdown, where the throw is not ours to catch: it escapes as an unhandled
  // rejection, and under Node's default that is fatal. A client that hangs up
  // mid-stream is enough to reach it, so without this the whole proxy dies with
  // one client's disconnect. Report loudly and keep serving instead; the request
  // itself already failed on its own path.
  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
    process.stderr.write(`[ERROR] unhandled rejection, proxy kept running: ${detail}\n`);
  });

  const server = createServer(createNodeRequestHandler(env));
  let stopTui: (() => void) | undefined;
  let stopRpc: (() => void) | undefined;
  let agentSessionPromise: Promise<void> | undefined;

  server.listen(port, '0.0.0.0', async () => {
    console.log(`Server running on http://0.0.0.0:${port} (version: ${env.VERSION})`);
    console.log(` and dashboard at http://127.0.0.1:${port}/dashboard`);

    if (env.DEV_NO_KEY === 'true' || env.DEV_NO_KEY === '1') {
      console.warn('[WARN] DEV_NO_KEY is enabled: model requests may omit authentication headers. Do not use in production.');
    }

    // Token stats persistence (JSONL dump + restore) is opt-in: it only runs
    // when the dashboard is enabled (--dashboard, or --tui/--agent which imply
    // it) or the standalone DUMP timer is active. Without it, stats live purely
    // in memory, capped at the 30d retention window by recordTokenHeatmapEvent.
    let tuiEnabled = isEnvFlagEnabled(process.env.TUI);
    const agentEnabled = isEnvFlagEnabled(process.env.AGENT);
    const dumpEnabled = isEnvFlagEnabled(process.env.DUMP);
    const dashboardEnabled = isEnvFlagEnabled(process.env.DASHBOARD);
    const persistenceEnabled = dashboardEnabled || tuiEnabled || dumpEnabled;
    setStatsPersistenceEnabled(persistenceEnabled);

    // Retention window: 31 days when any mode flag is set (--dashboard/--tui/--agent/--rpc),
    // 1 day in plain proxy mode. This controls the in-memory tokenHeatmapEvents cap,
    // which feeds global token limit enforcement (1w/1m windows) and the dashboard heatmap.
    const anyModeFlag = dashboardEnabled || tuiEnabled || agentEnabled || rpcEnabled || dumpEnabled;
    setTokenRetentionWindow(anyModeFlag ? 31 : 1);

    if (agentEnabled && tuiEnabled) {
      console.warn('[WARN] Both AGENT and TUI are set; AGENT takes precedence and the dashboard TUI will not start.');
      tuiEnabled = false;
    }

    if (persistenceEnabled) {
      // Restore token stats from log with a retention window sized to fit the
      // largest of: the 31d monthly heatmap window, and the largest configured
      // token-limit duration. Falls back to 30 days when no local TOML config is
      // available (e.g. PROXY_CONFIG_CONSUL / PROXY_CONFIG_APOLLO mode).
      let retentionDays = 30;
      const configPath = env.PROXY_CONFIG_PATH;
      if (configPath && !env.PROXY_CONFIG_CONSUL && !env.PROXY_CONFIG_APOLLO) {
        try {
          const cfg = loadProxyConfigFromPath(configPath);
          const durationDays = (d: string): number => Math.ceil(getWindowMs(d as '1h' | '1d' | '1w' | '1m') / (24 * 60 * 60 * 1000));
          let maxDays = 31; // 31d monthly heatmap baseline (matches TOKEN_HEATMAP_MONTHLY_WINDOW_MS / event retention)
          const globalRaw = cfg.general?.global_token_limit;
          if (globalRaw) {
            const parsed = parseHumanTokenLimit(globalRaw.trim());
            if (parsed) maxDays = Math.max(maxDays, durationDays(parsed.duration));
          }
          const composite = cfg.composite ?? {};
          for (const aliasCfg of Object.values(composite)) {
            const lim = aliasCfg?.token_limit;
            if (lim?.duration) maxDays = Math.max(maxDays, durationDays(lim.duration));
          }
          retentionDays = maxDays;
        } catch {
          // keep default 30 on parse error
        }
      }
      loadTokenStatsFromLog(retentionDays);
    }

    if (agentEnabled && process.stdin.isTTY && process.stdout.isTTY) {
      // Lazy import: pi-agent-core/pi-tui/pi-ai are devDependencies, not shipped in the production image
      const { startAgentSession } = await import('./agent-session.js');
      agentSessionPromise = startAgentSession({
        env,
        loadConfig: async (forceReload?: boolean) => {
          if (forceReload) clearProxyConfigCache();
          return loadProxyConfig(env);
        },
        port,
      }).catch((err) => {
        console.error('Agent session failed:', (err as Error).message);
      }).finally(() => {
        // The agent session owns the terminal for its whole lifetime; once it
        // ends (clean exit, cancel, or error) there's no interactive use left
        // for this process, and nothing else was keeping the server open on
        // its behalf — shut down the same way SIGINT does instead of leaving
        // an orphaned server with no one attached to it.
        shutdown();
      });
    } else if (tuiEnabled && process.stdin.isTTY && process.stdout.isTTY) {
      console.log = () => {};
      console.info = () => {};
      console.warn = () => {};
      console.error = () => {};
      console.debug = () => {};

      // Lazy import: pi-tui is a devDependency, not shipped in the production image
      const { startTUI } = await import('./tui.js');
      stopTui = startTUI({
        env,
        loadConfig: async (forceReload?: boolean) => {
          if (forceReload) clearProxyConfigCache();
          return loadProxyConfig(env);
        },
        readOnly: !!env.PROXY_CONFIG_CONSUL || !!env.PROXY_CONFIG_APOLLO,
      });
    } else {
      // Non-TUI/non-agent mode: eagerly load config to validate and show errors in console
      loadProxyConfig(env).catch((err) => {
        console.error('Failed to load config at startup:', (err as Error).message);
      });

      if (rpcEnabled) {
        // Lazy import: pi-tui/pi-agent-core are devDependencies, but rpc.ts is
        // bundled into the SEA blob like tui.js/agent-session.js. Starting here,
        // inside the listen callback, means the port is bound before the first
        // request is read — a reply to status.get proves the socket is live.
        const { startRpc } = await import('./rpc.js');
        stopRpc = startRpc({
          env,
          loadConfig: async (forceReload?: boolean) => {
            if (forceReload) clearProxyConfigCache();
            return loadProxyConfig(env);
          },
          port,
          shutdown,
        });
      }
    }
  });

  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) {
      // Second shutdown trigger (e.g. Ctrl+C during close): force-quit without
      // waiting for in-flight requests
      process.exit(130);
    }
    shuttingDown = true;
    stopTui?.();
    stopRpc?.();
    server.close(() => process.exit(0));
    server.closeAllConnections();
  }
  process.on('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
