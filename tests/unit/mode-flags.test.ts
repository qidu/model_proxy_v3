/**
 * Unit tests for the --tui / --agent mode flags (src/mode-flags.ts), plus the
 * invariant that forces server.ts to strip MODE_FLAGS before calling runCli().
 *
 * Run with:
 *   npx tsx --test tests/unit/mode-flags.test.ts
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MODE_FLAGS, applyModeFlags } from '../../src/mode-flags.js';
import { runCli } from '../../src/cli.js';
import type { Env } from '../../src/types/shared.js';

const GOOD_CONFIG = `
[general]
global_token_limit = "1B 1d"

[models.claude]
upstream_mode = "anthropic-messages"
base_url = "http://localhost:3000"
sonnet = {target = "claude-sonnet-5"}
`;

let tempDir: string;
let goodPath: string;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mpv3-mode-flags-test-'));
  goodPath = join(tempDir, 'good.toml');
  writeFileSync(goodPath, GOOD_CONFIG);
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// applyModeFlags writes to the real process.env, so snapshot and restore the two
// vars it owns around every case to keep the rest of the file's assertions honest.
let savedTui: string | undefined;
let savedAgent: string | undefined;

beforeEach(() => {
  savedTui = process.env.TUI;
  savedAgent = process.env.AGENT;
});

afterEach(() => {
  if (savedTui === undefined) delete process.env.TUI;
  else process.env.TUI = savedTui;
  if (savedAgent === undefined) delete process.env.AGENT;
  else process.env.AGENT = savedAgent;
});

/** Run runCli with stdout/stderr redirected, returning the captured streams. */
function capture(argv: string[], env: Partial<Env>): { code: number | null; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write;
  const origErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    return { code: runCli(argv, env as Env), out: out.join(''), err: err.join('') };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

// ---------------------------------------------------------------------------
// argv -> process.env normalization
// ---------------------------------------------------------------------------

describe('applyModeFlags', () => {
  it('--agent sets AGENT=true and leaves TUI unset', () => {
    delete process.env.AGENT;
    delete process.env.TUI;

    applyModeFlags(['--agent']);

    assert.equal(process.env.AGENT, 'true', '--agent must set the exact value the six AGENT readers compare against');
    assert.equal(process.env.TUI, undefined, '--agent must not enable the dashboard TUI');
  });

  it('--tui sets TUI=true and leaves AGENT unset', () => {
    delete process.env.AGENT;
    delete process.env.TUI;

    applyModeFlags(['--tui']);

    assert.equal(process.env.TUI, 'true', '--tui must set the exact value the TUI readers compare against');
    assert.equal(process.env.AGENT, undefined, '--tui must not enable the agent session');
  });

  it('both flags set both vars, leaving precedence to server.ts', () => {
    delete process.env.AGENT;
    delete process.env.TUI;

    applyModeFlags(['--tui', '--agent']);

    assert.equal(process.env.TUI, 'true');
    assert.equal(process.env.AGENT, 'true');
  });

  it('argv without a mode flag leaves both vars exactly as they were', () => {
    process.env.TUI = '1';
    process.env.AGENT = '0';

    applyModeFlags(['--list-models', '--json']);

    assert.equal(process.env.TUI, '1', 'an unrelated command must not touch TUI');
    assert.equal(process.env.AGENT, '0', 'an unrelated command must not touch AGENT');
  });

  it('an empty argv leaves both vars exactly as they were', () => {
    process.env.TUI = '1';
    process.env.AGENT = '0';

    applyModeFlags([]);

    assert.equal(process.env.TUI, '1');
    assert.equal(process.env.AGENT, '0');
  });

  it('a flag overrides a contradicting env var (the command line is the more specific request)', () => {
    process.env.AGENT = '0';
    process.env.TUI = '0';

    applyModeFlags(['--agent', '--tui']);

    assert.equal(process.env.AGENT, 'true');
    assert.equal(process.env.TUI, 'true');
  });

  it('preserves an agreeing env var rather than clobbering it with a different spelling', () => {
    process.env.AGENT = '1';

    applyModeFlags(['--agent']);

    assert.equal(process.env.AGENT, 'true', 'normalized to the canonical spelling; both are truthy to every reader');
  });

  it('matches flags exactly, not by prefix', () => {
    delete process.env.AGENT;
    delete process.env.TUI;

    applyModeFlags(['--agent-mode', '--tuix', '--rpc']);

    assert.equal(process.env.AGENT, undefined, 'a lookalike flag must not enable the agent session');
    assert.equal(process.env.TUI, undefined, 'a lookalike flag must not enable the dashboard TUI');
  });

  it('ignores a mode flag appearing after a command', () => {
    delete process.env.AGENT;

    applyModeFlags(['--list-models', '--agent']);

    assert.equal(process.env.AGENT, 'true', 'position must not matter; runCli still exits on the command');
  });
});

// ---------------------------------------------------------------------------
// MODE_FLAGS and the strip-before-runCli invariant
// ---------------------------------------------------------------------------

describe('MODE_FLAGS', () => {
  it('lists exactly the three stdout-owning startup modes', () => {
    assert.deepEqual([...MODE_FLAGS], ['--rpc', '--tui', '--agent']);
  });

  it('every mode flag is rejected by runCli, which is why server.ts must strip them', () => {
    for (const flag of MODE_FLAGS) {
      const result = capture([flag], { PROXY_CONFIG_PATH: goodPath });
      assert.equal(result.code, 2, `${flag} alone must be a usage error inside runCli`);
      assert.match(
        result.err,
        new RegExp(`Unknown argument: ${flag.replace(/[-]/g, '\\-')}`),
        `${flag} must reach runCli's unknown-argument scan when not stripped`,
      );
    }
  });

  it('stripping MODE_FLAGS from argv lets a real command through and prints its output', () => {
    const argv = ['--tui', '--agent', '--list-models'];

    const stripped = argv.filter((arg) => !(MODE_FLAGS as readonly string[]).includes(arg));
    assert.deepEqual(stripped, ['--list-models'], 'only the mode flags are removed');

    const result = capture(stripped, { PROXY_CONFIG_PATH: goodPath });
    assert.equal(result.code, 0);
    assert.match(result.out, /sonnet/, 'the command must actually run against the config');
    assert.equal(result.err, '', 'a successful command must not write to stderr');
  });

  it('stripping every mode flag leaves argv empty, so runCli returns null and the server starts', () => {
    const argv = ['--tui', '--agent'];

    const stripped = argv.filter((arg) => !(MODE_FLAGS as readonly string[]).includes(arg));
    assert.deepEqual(stripped, []);

    const result = capture(stripped, { PROXY_CONFIG_PATH: goodPath });
    assert.equal(result.code, null, 'null means "no command": start the server in the requested mode');
    assert.equal(result.out, '');
    assert.equal(result.err, '');
  });
});
