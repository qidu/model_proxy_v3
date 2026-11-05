/**
 * Keeps the proxy's own log lines out of the unit suite's TAP output.
 *
 * Without this the proxy interleaves its lines into the run, so a green run
 * still prints `[ERROR]`/`[WARN]` lines produced by deliberate fixtures (a 500
 * stub, a chmod 0o500 blob dir) and the log alone cannot be told apart from a
 * real failure. Two writers have to be handled, not one:
 *
 * 1. `createLogger` output. `node --test` runs each test file in its own
 *    process and `--import` runs before the file's own imports, so the default
 *    below reaches every suite (and child processes that inherit this env).
 *    `??=` keeps an operator override working: `LOG_LEVEL=debug npm run test:unit`.
 *
 * 2. Everything written to `console.*` directly — `config-loader`, `key-store`,
 *    the blob store, the dashboard — plus the ~20 suites that pin
 *    `LOG_LEVEL: 'error'` in their env object (which beats the default above).
 *    Those shapes are dropped here. A suite that asserts on log content is
 *    unaffected: it installs its own `console.*` hook on top of this one, and
 *    replacing the function means it sees every line.
 *
 * Both steps are skipped when the operator picks a level other than `silent`,
 * so `LOG_LEVEL=debug npm run test:unit` still shows the full log.
 */
process.env.LOG_LEVEL ??= 'silent';

/** Shapes the proxy writes: `<LEVEL> ...`, `<id> <LEVEL> ...`, `<module-tag> ...`. */
const PROXY_LINE_PREFIXES: readonly RegExp[] = [
  /^\[(?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\] /,
  /^\[[^\]\s]+\] \[(?:TRACE|DEBUG|INFO|WARN|ERROR)\] /,
  /^\[(?:spool|key-store|coordinator|PII-RESTORE|config|SKIP|dashboard-test-model)\] /,
];

type ConsoleMethod = 'log' | 'info' | 'debug' | 'warn' | 'error';

const sink = console as unknown as Record<ConsoleMethod, (...args: unknown[]) => void>;

if (process.env.LOG_LEVEL === 'silent') {
  for (const method of ['log', 'info', 'debug', 'warn', 'error'] as const) {
    const original = sink[method].bind(console);
    sink[method] = (...args: unknown[]) => {
      const [first] = args;
      if (typeof first === 'string' && PROXY_LINE_PREFIXES.some((prefix) => prefix.test(first))) return;
      original(...args);
    };
  }
}
