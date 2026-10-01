/**
 * `--tui` and `--agent` are argv spellings of the TUI and AGENT env vars. They are
 * normalized into process.env here so the six places that already read those vars
 * (server.ts's env literal + LOG_LEVEL default + rpc conflict check + mode
 * dispatch, agent-session.ts's agentMode, logger.ts's AGENT_MODE) keep one source
 * of truth and need no changes.
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
 */

/**
 * Startup modes rather than runCli() commands: each owns stdout, and runCli()
 * rejects unknown args, so server.ts strips these before scanning argv.
 */
export const MODE_FLAGS = ['--rpc', '--tui', '--agent'] as const;

export function applyModeFlags(argv: readonly string[]): void {
  if (argv.includes('--tui')) {
    process.env.TUI = 'true';
  }
  if (argv.includes('--agent')) {
    process.env.AGENT = 'true';
  }
}

applyModeFlags(process.argv.slice(2));
