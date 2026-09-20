#!/usr/bin/env node
/**
 * Node.js HTTP server adapter for running in containers
 * Wraps the Workers fetch handler with a native HTTP server
 */

import { createServer } from 'http';
import type { Env } from './types/shared.js';
import { loadProxyConfig, clearProxyConfigCache, loadProxyConfigFromPath, parseHumanTokenLimit } from './utils/config-loader.js';
import { consumeActiveRequestRelease, loadTokenStatsFromLog, getWindowMs, setStatsPersistenceEnabled } from './utils/dashboard-stats.js';
import { runCli } from './cli.js';

const port = parseInt(process.env.PORT || '8788', 10);

// Import the Workers fetch handler
import handler from './index.js';

// Extend Env interface for Node.js environment
interface NodeEnv extends Env {
  NODE_ENV: string;
}

function nodeResponseHeaders(response: Response): Record<string, string> {
  const headers = new Headers(response.headers);
  headers.delete('content-encoding');
  headers.delete('content-length');
  return Object.fromEntries(headers.entries());
}

const env: NodeEnv = {
  NODE_ENV: process.env.NODE_ENV || 'production',
  VERSION: process.env.VERSION || 'dev',
  ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || '*',
  LOCAL_TIKTOKEN: process.env.LOCAL_TIKTOKEN || 'false',
  ALLOWED_HOSTS: process.env.ALLOWED_HOSTS || '127.0.0.1,localhost',
  IMAGE_BLOCK_DATA_MAX_SIZE: process.env.IMAGE_BLOCK_DATA_MAX_SIZE || '10485760',
  // AGENT=true's interactive TUI is noisy at the default 'info' level (every
  // proxy request logs its own line) — default to 'warn' in that mode unless
  // the user explicitly set LOG_LEVEL.
  LOG_LEVEL: process.env.LOG_LEVEL || ((process.env.AGENT === 'true' || process.env.AGENT === '1') ? 'warn' : 'info'),
  GEMINI_API_VERSION: process.env.GEMINI_API_VERSION || 'v1beta',
  MESSAGES_UPSTREAM_MODE: (process.env.MESSAGES_UPSTREAM_MODE as 'native' | 'openai-completions') || 'openai-completions',
  INTERACTIONS_UPSTREAM_MODE: (process.env.INTERACTIONS_UPSTREAM_MODE as 'native' | 'openai-completions') || 'native',
  GENERATE_CONTENT_UPSTREAM_MODE: (process.env.GENERATE_CONTENT_UPSTREAM_MODE as 'native' | 'openai-completions') || 'native',
  PROXY_CONFIG_PATH: process.env.PROXY_CONFIG_PATH || (process.env.TEST_CONFIG ? `./${process.env.TEST_CONFIG}proxy_config.toml` : './proxy_config.toml'),
  PROXY_CONFIG_CONSUL: process.env.PROXY_CONFIG_CONSUL,
  PROXY_CONFIG_APOLLO: process.env.PROXY_CONFIG_APOLLO,
  PORT: process.env.PORT || '8788',
  DEV_NO_KEY: process.env.DEV_NO_KEY || 'false',
  PROXY_CLIENT_API_KEY: process.env.PROXY_CLIENT_API_KEY,
  AGENT: process.env.AGENT,
  CONVERSATION_STATE: process.env.CONVERSATION_STATE || 'false',
  PRIVACY_FILTER_URL: process.env.PRIVACY_FILTER_URL,
  PRIVACY_FILTER_TIMEOUT_MS: process.env.PRIVACY_FILTER_TIMEOUT_MS,
  PRIVACY_FILTER_MAX_CHARS: process.env.PRIVACY_FILTER_MAX_CHARS,
  KOMPRESS_URL: process.env.KOMPRESS_URL,
  KOMPRESS_ENDPOINTS: process.env.KOMPRESS_ENDPOINTS,
  KOMPRESS_FAIL_OPEN: process.env.KOMPRESS_FAIL_OPEN,
  KOMPRESS_TIMEOUT_MS: process.env.KOMPRESS_TIMEOUT_MS,
  KOMPRESS_MAX_CHARS: process.env.KOMPRESS_MAX_CHARS,
  KOMPRESS_KEEP_RATIO: process.env.KOMPRESS_KEEP_RATIO,
  KOMPRESS_MIN_CHARS: process.env.KOMPRESS_MIN_CHARS,
};

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

// CLI subcommands exit before the server starts. No args (runCli returns null)
// preserves the previous behavior of starting the HTTP server.
const cliExitCode = runCli(process.argv.slice(2), env);
if (cliExitCode !== null) {
  process.exit(cliExitCode);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);

    const bodyStream = ['GET', 'HEAD'].includes(req.method || '')
      ? undefined
      : new ReadableStream({
          start(controller) {
            req.on('data', (chunk) => controller.enqueue(chunk));
            req.on('end', () => controller.close());
            req.on('error', (err) => controller.error(err));
          },
        });

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
      body: bodyStream,
    };
    if (bodyStream) {
      requestInit.duplex = 'half';
    }
    const request = new Request(url.toString(), requestInit);

    const response = await handler.fetch(request, env);

    // Release the in-flight request counter once the body has fully streamed to
    // the client (or immediately for non-streaming responses). The release is
    // once-guarded in dashboard-stats, so wiring it to several completion paths
    // (stream close/abort, pipe error, client disconnect) can't double-count.
    const release = consumeActiveRequestRelease(response) ?? (() => {});

    // Handle streaming vs non-streaming responses differently.
    // For streaming, tee the stream so we can pipe one branch to the client
    // while leaving the other available for reading (e.g. .text()).
    // For non-streaming, read the full body and write all at once.
    const contentType = response.headers.get('content-type') || '';
    const isStreaming = contentType.includes('text/event-stream');

    if (isStreaming && response.body) {
      // For streaming responses (text/event-stream), pipe directly to the Node.js
      // response without consuming the body via .text(), which avoids the
      // "headers already sent" error when the stream body was already locked.
      res.writeHead(response.status, nodeResponseHeaders(response));
      const { PassThrough } = await import('stream');
      const passthrough = new PassThrough();
      passthrough.pipe(res);
      // Safety net: if the client disconnects mid-stream, release here too.
      res.on('close', release);
      response.body.pipeTo(new WritableStream({
        write(chunk) {
          passthrough.write(chunk);
        },
        close() {
          passthrough.end();
          release();
        },
        abort(err) {
          passthrough.end();
          release();
        },
      })).catch(() => {
        passthrough.end();
        release();
      });
      return;
    }

    const responseBody = await response.clone().text();
    res.writeHead(response.status, nodeResponseHeaders(response));
    res.end(responseBody);
    release();
  } catch (error) {
    console.error('Server error:', error);
    // Only write headers if they haven't been sent yet
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal server error' }));
    }
  }
});

let stopTui: (() => void) | undefined;
let agentSessionPromise: Promise<void> | undefined;

server.listen(port, '0.0.0.0', async () => {
  console.log(`Server running on http://0.0.0.0:${port} (version: ${env.VERSION})`);
  console.log(` and dashboard at http://0.0.0.0:${port}/dashboard`);

  if (env.DEV_NO_KEY === 'true' || env.DEV_NO_KEY === '1') {
    console.warn('[WARN] DEV_NO_KEY is enabled: model requests may omit authentication headers. Do not use in production.');
  }

  // Token stats persistence (JSONL dump + restore) is opt-in: it only runs
  // when the TUI dashboard or the standalone DUMP timer is active. Without
  // it, stats live purely in memory, capped at the 30d retention window by
  // recordTokenHeatmapEvent.
  let tuiEnabled = process.env.TUI === 'true' || process.env.TUI === '1';
  const agentEnabled = process.env.AGENT === 'true' || process.env.AGENT === '1';
  const dumpEnabled = process.env.DUMP === 'true' || process.env.DUMP === '1';
  const persistenceEnabled = tuiEnabled || dumpEnabled;
  setStatsPersistenceEnabled(persistenceEnabled);

  if (agentEnabled && tuiEnabled) {
    console.warn('[WARN] Both AGENT and TUI are set; AGENT takes precedence and the dashboard TUI will not start.');
    tuiEnabled = false;
  }

  if (persistenceEnabled) {
    // Restore token stats from log with a retention window sized to fit the
    // largest configured token-limit duration. Falls back to 30 days when no
    // local TOML config is available (e.g. PROXY_CONFIG_CONSUL / PROXY_CONFIG_APOLLO mode).
    let retentionDays = 30;
    const configPath = env.PROXY_CONFIG_PATH;
    if (configPath && !env.PROXY_CONFIG_CONSUL && !env.PROXY_CONFIG_APOLLO) {
      try {
        const cfg = loadProxyConfigFromPath(configPath);
        const durationDays = (d: string): number => Math.ceil(getWindowMs(d as '1h' | '1d' | '1w' | '1m') / (24 * 60 * 60 * 1000));
        let maxDays = 7; // 7d heatmap baseline
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
  server.close(() => process.exit(0));
  server.closeAllConnections();
}
process.on('SIGINT', shutdown);
