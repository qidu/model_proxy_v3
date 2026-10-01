/**
 * `--tui`, `--agent` and `--dashboard` are argv spellings of the TUI, AGENT and
 * DASHBOARD env vars. They are normalized into process.env here so the places
 * that already read those vars (server.ts's env literal + LOG_LEVEL default +
 * rpc conflict check + mode dispatch + stats-persistence gate, dashboard-stats.ts's
 * dump timer, agent-session.ts's agentMode, logger.ts's AGENT_MODE) keep one
 * source of truth and need no changes.
 *
 * This module MUST stay server.ts's first import, and the normalization MUST run
 * at import time rather than from a function server.ts calls:
 *   - logger.ts captures `process.env.AGENT` into a module-scope AGENT_MODE, and
 *     server.ts reaches logger.ts through its first project import
 *     (utils/config-loader.ts -> utils/logger.ts);
 *   - ESM evaluates every static import before server.ts's own body runs, so argv
 *     parsed anywhere in that body lands after AGENT_MODE is already frozen.
 * Only a module evaluated ahead of the rest can normalize the env in time.
 *
 * A flag and its env var normally agree; when they contradict (`AGENT=0 --agent`)
 * the flag wins, being the more specific request.
 *
 * `--tui` and `--agent` imply `--dashboard`: both render the same token stats the
 * dashboard serves, so asking for either is asking for stats persistence. The
 * implication runs flag -> flag only. The bare `TUI=true` / `AGENT=true` env vars
 * keep their previous behavior, so a supervisor that sets them does not silently
 * start dumping `model_proxy_tokens.jsonl` (DUMP=true remains the env-only way to
 * get persistence without a UI).
 */

/**
 * Startup modes rather than runCli() commands: runCli() rejects unknown args, so
 * server.ts strips these before scanning argv. `--rpc`, `--tui` and `--agent`
 * also each own stdout, which is why server.ts refuses to combine them;
 * `--dashboard` claims no output and composes with any of them.
 */
export const MODE_FLAGS = ['--rpc', '--tui', '--agent', '--dashboard'] as const;

export function applyModeFlags(argv: readonly string[]): void {
  if (argv.includes('--tui')) {
    process.env.TUI = 'true';
  }
  if (argv.includes('--agent')) {
    process.env.AGENT = 'true';
  }
  // --dashboard is stated outright by its own flag, and implied by the two modes
  // that display the stats it persists.
  if (argv.includes('--dashboard') || argv.includes('--tui') || argv.includes('--agent')) {
    process.env.DASHBOARD = 'true';
  }
}

applyModeFlags(process.argv.slice(2));
