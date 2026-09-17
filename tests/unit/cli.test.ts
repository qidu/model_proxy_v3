/**
 * Unit tests for the server CLI subcommands (src/cli.ts) and the shared
 * pi-ai model builder (src/utils/pi-model-catalog.ts).
 *
 * Run with:
 *   npx tsx --test tests/unit/cli.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from '../../src/cli.js';
import { PROXY_PROVIDER_ID, buildProxyPiModel, proxyLoopbackBaseUrl } from '../../src/utils/pi-model-catalog.js';
import type { Env } from '../../src/types/shared.js';

const GOOD_CONFIG = `
[general]
global_token_limit = "10B 1w"

[models.claude]
upstream_mode = "anthropic-messages"
base_url = "http://localhost:3000"
fable5 = {target = "claude-fable-5"}
sonnet = {target = "claude-sonnet-5"}

[models.free]
upstream_mode = "openai-completions"
base_url = "http://localhost:3000"
"ds-qn" = {target = "deepseek/deepseek-v4.1-flash", base_url = "https://api.qnaigc.com", api_key = "SECRET_KEY_VALUE"}

[composite]
"smart" = {"fable5" = {share = 10, primary = true}, "sonnet" = {share = 100, fallback = 0}, token_limit = {num = 200000000, duration = "1d"}}

[schedule]
"dddsg" = {"fable5" = [{from = 0, to = 24}]}
`;

// Every target's base_url is empty and unset in the category, plus a
// self-referencing composite target — both are hard errors.
const BAD_CONFIG = `
[models.broken]
base_url = ""
empty = {target = ""}

[composite]
"self" = {"self" = {share = 1}}
`;

let tempDir: string;
let goodPath: string;
let badPath: string;

before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'mpv3-cli-test-'));
  goodPath = join(tempDir, 'good.toml');
  badPath = join(tempDir, 'bad.toml');
  writeFileSync(goodPath, GOOD_CONFIG);
  writeFileSync(badPath, BAD_CONFIG);
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
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

function envFor(configPath: string, extra: Partial<Env> = {}): Partial<Env> {
  return { PROXY_CONFIG_PATH: configPath, ...extra };
}

// ---------------------------------------------------------------------------
// Argument parsing / dispatch
// ---------------------------------------------------------------------------

describe('runCli argument handling', () => {
  it('returns null and writes nothing when given no arguments', () => {
    const result = capture([], envFor(goodPath));
    assert.equal(result.code, null, 'no args must mean "start the server"');
    assert.equal(result.out, '');
    assert.equal(result.err, '');
  });

  it('--help exits 0 and documents every command', () => {
    const result = capture(['--help'], envFor(goodPath));
    assert.equal(result.code, 0);
    for (const command of ['--list-models', '--export-pi-models', '--validate-config', '--default-model']) {
      assert.ok(result.out.includes(command), `help must mention ${command}`);
    }
    assert.ok(result.out.includes('~/.pi/agent/models.json'), 'help must point --export-pi-models at the pi models file');
    assert.ok(result.out.includes('~/.pi/agent/settings.json'), 'help must point the default* fields at the pi settings file');
  });

  it('rejects an unknown argument with exit code 2', () => {
    const result = capture(['--bogus'], envFor(goodPath));
    assert.equal(result.code, 2);
    assert.match(result.err, /Unknown argument: --bogus/);
  });

  it('rejects more than one command with exit code 2', () => {
    const result = capture(['--validate-config', '--list-models'], envFor(goodPath));
    assert.equal(result.code, 2);
    assert.match(result.err, /Only one command may be given/);
  });

  it('rejects --json without --list-models', () => {
    for (const argv of [['--validate-config', '--json'], ['--export-pi-models', '--json']]) {
      const result = capture(argv, envFor(goodPath));
      assert.equal(result.code, 2, `${argv.join(' ')} must be a usage error`);
      assert.match(result.err, /--json is only supported with --list-models/);
    }
  });

  it('rejects a flags-only invocation with exit code 2', () => {
    const result = capture(['--json'], envFor(goodPath));
    assert.equal(result.code, 2);
    assert.match(result.err, /No command given \(only flags were supplied\)/);
  });

  it('rejects --default-model without a value', () => {
    const result = capture(['--export-pi-models', '--default-model'], envFor(goodPath));
    assert.equal(result.code, 2);
    assert.match(result.err, /--default-model requires a model id/);
  });

  it('rejects --default-model without --export-pi-models', () => {
    const result = capture(['--list-models', '--default-model', 'fable5'], envFor(goodPath));
    assert.equal(result.code, 2);
    assert.match(result.err, /--default-model is only supported with --export-pi-models/);
  });

  it('does not mistake the --default-model value for an unknown argument or a command', () => {
    const result = capture(['--export-pi-models', '--default-model', '--validate-config'], envFor(goodPath));
    assert.equal(result.code, 2, 'a flag-shaped value must be rejected, not treated as a command');
    assert.match(result.err, /--default-model requires a model id/);
  });
});

// ---------------------------------------------------------------------------
// --export-pi-models
// ---------------------------------------------------------------------------

describe('--export-pi-models', () => {
  it('emits a single-provider models file with one entry per target model and alias', () => {
    const result = capture(['--export-pi-models'], envFor(goodPath));
    assert.equal(result.code, 0);

    const file = JSON.parse(result.out) as {
      defaultProvider: string;
      defaultModel: string;
      providers: Record<string, { api: string; apiKey: string; baseUrl: string; models: Array<Record<string, unknown>> }>;
    };
    assert.equal(file.defaultProvider, PROXY_PROVIDER_ID);
    assert.equal(file.defaultModel, 'fable5', 'defaultModel defaults to the first configured model');
    assert.deepEqual(Object.keys(file.providers), [PROXY_PROVIDER_ID]);

    const provider = file.providers[PROXY_PROVIDER_ID];
    assert.equal(provider.api, 'anthropic-messages');
    assert.equal(provider.apiKey, 'sk-hi');
    assert.equal(provider.baseUrl, 'http://127.0.0.1:8788');

    // 3 target models (fable5, sonnet, ds-qn) + 1 composite + 1 schedule alias
    assert.deepEqual(provider.models.map((m) => m.id), ['fable5', 'sonnet', 'ds-qn', 'smart', 'dddsg']);
    assert.deepEqual(provider.models[0], {
      id: 'fable5',
      name: 'fable5',
      api: 'anthropic-messages',
      provider: PROXY_PROVIDER_ID,
      baseUrl: 'http://127.0.0.1:8788',
      reasoning: true,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200_000,
      maxTokens: 8_192,
    });
  });

  it('never leaks a configured api_key into the exported provider', () => {
    const result = capture(['--export-pi-models'], envFor(goodPath));
    assert.equal(result.code, 0);
    assert.ok(!result.out.includes('SECRET_KEY_VALUE'), 'target api_key must never be exported');
  });

  it('uses the PORT env for the loopback baseUrl on the provider and every model', () => {
    const result = capture(['--export-pi-models'], envFor(goodPath, { PORT: '9001' }));
    const file = JSON.parse(result.out) as {
      providers: Record<string, { baseUrl: string; models: Array<{ baseUrl: string }> }>;
    };
    const provider = file.providers[PROXY_PROVIDER_ID];
    assert.equal(provider.baseUrl, 'http://127.0.0.1:9001');
    assert.equal(provider.models.length, 5);
    for (const model of provider.models) {
      assert.equal(model.baseUrl, 'http://127.0.0.1:9001');
    }
  });

  it('names the --default-model alias as defaultModel', () => {
    const result = capture(['--export-pi-models', '--default-model', 'smart'], envFor(goodPath));
    assert.equal(result.code, 0);

    const file = JSON.parse(result.out) as { defaultProvider: string; defaultModel: string };
    assert.equal(file.defaultProvider, PROXY_PROVIDER_ID);
    assert.equal(file.defaultModel, 'smart');
  });

  it('rejects a --default-model that is not a configured model or alias', () => {
    const result = capture(['--export-pi-models', '--default-model', 'nope'], envFor(goodPath));
    assert.equal(result.code, 2);
    assert.match(result.err, /--default-model "nope" is not a configured model or alias/);
    assert.match(result.err, /fable5/, 'the error must list ids that would have worked');
  });
});

// ---------------------------------------------------------------------------
// --list-models
// ---------------------------------------------------------------------------

describe('--list-models', () => {
  it('renders every target model and alias without leaking api_key values', () => {
    const result = capture(['--list-models'], envFor(goodPath));
    assert.equal(result.code, 0);

    for (const id of ['fable5', 'sonnet', 'ds-qn', 'smart', 'dddsg']) {
      assert.ok(result.out.includes(id), `table must list ${id}`);
    }
    assert.ok(result.out.includes('https://api.qnaigc.com'), 'target base_url must be shown');
    assert.ok(!result.out.includes('SECRET_KEY_VALUE'), 'api_key value must never be printed');
  });

  it('--json emits the sanitized dashboard shape with api_key stripped', () => {
    const result = capture(['--list-models', '--json'], envFor(goodPath));

    const payload = JSON.parse(result.out) as {
      models: Record<string, Record<string, unknown>>;
      composite: Record<string, unknown>;
      schedule: Record<string, unknown>;
    };
    assert.deepEqual(payload.models.free['ds-qn'], ['deepseek/deepseek-v4.1-flash', 'https://api.qnaigc.com', '']);
    assert.deepEqual(Object.keys(payload.composite), ['smart']);
    assert.deepEqual(Object.keys(payload.schedule), ['dddsg']);
    assert.ok(!result.out.includes('SECRET_KEY_VALUE'));

    const smart = payload.composite.smart as Record<string, unknown>;
    assert.deepEqual(smart.token_limit, { num: 200000000, duration: '1d' });
    assert.deepEqual(smart.fable5, { share: 10, primary: true });
  });

  it('gives each aliased target its own line instead of one comma-joined cell', () => {
    const result = capture(['--list-models'], envFor(goodPath));
    assert.equal(result.code, 0);

    // No single line carries both composite targets...
    const lines = result.out.split('\n');
    const first = lines.find((line) => line.includes('fable5 (primary, share=10)'));
    assert.ok(first, 'the first composite target must be listed');
    assert.ok(!first.includes('sonnet'), 'each composite target must get its own line');
    assert.ok(!result.out.includes('fable5 (primary, share=10), sonnet'), 'composite targets must not be comma-joined');

    // ...and the same holds for the schedule alias.
    const schedule = lines.find((line) => line.includes('fable5@0-24'));
    assert.ok(schedule, 'the schedule target must be listed');
    assert.ok(!result.out.includes('fable5@0-24, '), 'schedule targets must not be comma-joined');
  });
});

// ---------------------------------------------------------------------------
// --validate-config
// ---------------------------------------------------------------------------

describe('--validate-config', () => {
  it('exits 0 with no output on stderr for a valid config', () => {
    const result = capture(['--validate-config'], envFor(goodPath));
    assert.equal(result.code, 0);
    assert.equal(result.err, '', 'a valid config must not log parser errors');
    assert.match(result.out, /0 errors, 0 warnings — config is valid/);
    assert.match(result.out, /3 target models, 1 composite aliases, 1 schedule aliases/);
  });

  it('exits 1 and reports each error for an invalid config', () => {
    const result = capture(['--validate-config'], envFor(badPath));
    assert.equal(result.code, 1);
    assert.match(result.out, /config is INVALID/);
    // Errors are emitted by the parser itself (stderr), not re-printed as a list.
    assert.match(result.err, /models\.broken\.empty: target cannot be empty/);
    assert.match(result.err, /composite\.self\.self: composite alias "self" cannot list itself as a target/);
  });

  it('exits 1 when the config file is missing', () => {
    const missing = join(tempDir, 'does-not-exist.toml');
    for (const command of ['--validate-config', '--list-models', '--export-pi-models']) {
      const result = capture([command], envFor(missing));
      assert.equal(result.code, 1, `${command} must fail on a missing config`);
      assert.match(result.err, /Failed to load config|Cannot read config file/);
    }
  });
});

// ---------------------------------------------------------------------------
// pi-model-catalog
// ---------------------------------------------------------------------------

describe('proxyLoopbackBaseUrl', () => {
  it('defaults to 8788 for undefined, empty, and non-numeric ports', () => {
    for (const port of [undefined, '', 'abc', '0', '-1']) {
      assert.equal(proxyLoopbackBaseUrl(port), 'http://127.0.0.1:8788');
    }
  });

  it('accepts numeric strings and numbers', () => {
    assert.equal(proxyLoopbackBaseUrl('9001'), 'http://127.0.0.1:9001');
    assert.equal(proxyLoopbackBaseUrl(9001), 'http://127.0.0.1:9001');
  });
});

describe('buildProxyPiModel', () => {
  it('keys every pi Model field off the alias and the given baseUrl', () => {
    const model = buildProxyPiModel('some-alias', 'http://127.0.0.1:1234');
    assert.equal(model.id, 'some-alias');
    assert.equal(model.name, 'some-alias');
    assert.equal(model.baseUrl, 'http://127.0.0.1:1234');
    assert.equal(model.api, 'anthropic-messages');
    assert.equal(model.provider, PROXY_PROVIDER_ID);
  });
});
