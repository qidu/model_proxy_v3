/**
 * CLI subcommands for the Node server entrypoint (dist/server.js).
 *
 * server.ts calls runCli() with process.argv.slice(2) before it starts
 * listening: a recognized command runs and the process exits with the
 * returned code, while null (no args) means "no command" and the server
 * starts as before.
 *
 * Config is read from the local TOML file only ($PROXY_CONFIG_PATH, default
 * resolved by resolveDefaultProxyConfigPath()) — Consul/Apollo remote sources
 * are not consulted here.
 */

import { readFileSync } from 'fs';
import type { Env } from './types/shared.js';
import {
  getConfiguredModelIds,
  getModelNamesInConfig,
  loadProxyConfigFromPath,
  parseSimpleToml,
  resolveDefaultProxyConfigPath,
  toDashboardConfigPayload,
  type ConfigValidationError,
  type OpenClawConfig,
  type OpenClawProviderModelConfig,
  type ProxyConfig,
} from './utils/config-loader.js';
import { PROXY_PROVIDER_ID, buildProxyPiModel, proxyLoopbackBaseUrl } from './utils/pi-model-catalog.js';

const USAGE = `Usage: model-proxy-v3 [command]

Run without a command to start the HTTP server.

Commands:
  --list-models                List configured target models and aliases
  --export-pi-models           Print a ~/.pi/agent/models.json provider entry for this proxy
  --export-openclaw-providers  Print a ~/.openclaw/openclaw.json models.providers entry for this proxy
  --validate-config            Validate the config file and report errors/warnings
  --help, -h                   Show this help

Modes:
  --rpc                        Serve the JSON-RPC 2.0 control channel on stdio
                               (newline-delimited JSON) alongside the HTTP server.
                               Mutually exclusive with the AGENT and TUI modes.

Options:
  --json               Machine-readable output for --list-models (dashboard config shape)
  --default-model <id> Model named as defaultModel in --export-pi-models (must be a
                       configured model or alias; defaults to the first one)

Config is read from the local TOML file at $PROXY_CONFIG_PATH. When unset, the
default is ./proxy_config.toml if it exists, else
~/.config/model-proxy-v3/proxy_config.toml.

--export-pi-models prints defaultProvider/defaultModel (for ~/.pi/agent/settings.json)
plus the providers block (for ~/.pi/agent/models.json).

--export-openclaw-providers prints the models.providers block (for ~/.openclaw/openclaw.json).

Exit codes:
  0  success (for --validate-config: no errors)
  1  command failed (unreadable config, or config with errors)
  2  usage error
`;

const COMMANDS = ['--list-models', '--export-pi-models', '--export-openclaw-providers', '--validate-config'] as const;
type Command = (typeof COMMANDS)[number];

/**
 * Parse argv and run the selected command.
 * Returns the process exit code, or null when there is no command to run
 * (the caller should then start the server normally).
 */
export function runCli(argv: string[], env: Env): number | null {
  if (argv.length === 0) {
    return null;
  }

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }

  // Pull `--default-model <id>` out first: its value is a model id, not a flag,
  // so it must not reach the unknown-argument scan below.
  const rest: string[] = [];
  let defaultModel: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== '--default-model') {
      rest.push(argv[i]);
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      return usageError('--default-model requires a model id');
    }
    defaultModel = value;
    i++;
  }

  const commands = rest.filter((arg): arg is Command => (COMMANDS as readonly string[]).includes(arg));
  const unknown = rest.filter((arg) => arg !== '--json' && !(COMMANDS as readonly string[]).includes(arg));
  if (unknown.length > 0) {
    return usageError(`Unknown argument: ${unknown.join(', ')}`);
  }
  if (commands.length === 0) {
    return usageError('No command given (only flags were supplied)');
  }
  if (commands.length > 1) {
    return usageError(`Only one command may be given, got: ${commands.join(', ')}`);
  }

  const command = commands[0];
  const json = rest.includes('--json');
  if (json && command !== '--list-models') {
    return usageError(`--json is only supported with --list-models`);
  }
  if (defaultModel !== undefined && command !== '--export-pi-models') {
    return usageError(`--default-model is only supported with --export-pi-models`);
  }

  const configPath = env.PROXY_CONFIG_PATH || resolveDefaultProxyConfigPath();

  switch (command) {
    case '--list-models':
      return listModels(configPath, json);
    case '--export-pi-models':
      return exportPiModels(configPath, proxyLoopbackBaseUrl(env.PORT), defaultModel);
    case '--export-openclaw-providers':
      return exportOpenClawProviders(configPath, proxyLoopbackBaseUrl(env.PORT));
    case '--validate-config':
      return validateConfig(configPath);
  }
}

function usageError(message: string): number {
  process.stderr.write(`${message}\n\n${USAGE}`);
  return 2;
}

/** Load the config, reporting a readable failure instead of throwing. */
function tryLoadConfig(configPath: string): ProxyConfig | null {
  try {
    return loadProxyConfigFromPath(configPath);
  } catch (err) {
    process.stderr.write(`Failed to load config from ${configPath}: ${(err as Error).message}\n`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// --list-models
// ---------------------------------------------------------------------------

function listModels(configPath: string, json: boolean): number {
  const config = tryLoadConfig(configPath);
  if (!config) return 1;

  // The dashboard payload is the sanitized view of the config (api_key
  // stripped, composite/schedule meta normalized) and is already the public
  // shape served by the dashboard config endpoint — reuse it rather than
  // walking the raw config again.
  const payload = toDashboardConfigPayload(config);
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }
  process.stdout.write(renderCatalog(configPath, payload, config));
  return 0;
}

interface CatalogSection {
  title: string;
  headers: string[];
  rows: string[][];
}

function renderCatalog(
  configPath: string,
  payload: ReturnType<typeof toDashboardConfigPayload>,
  config: ProxyConfig,
): string {
  const counts = {
    targets: getModelNamesInConfig(config).size,
    composite: Object.keys(config.composite ?? {}).length,
    schedule: Object.keys(config.schedule ?? {}).length,
  };

  const sections: CatalogSection[] = [];

  const modelRows: string[][] = [];
  for (const [category, categoryConfig] of Object.entries(payload.models)) {
    const categoryBaseUrl = typeof categoryConfig.base_url === 'string' ? categoryConfig.base_url : '';
    const categoryMode = typeof categoryConfig.upstream_mode === 'string' ? categoryConfig.upstream_mode : '';
    for (const [id, entry] of Object.entries(categoryConfig)) {
      if (id === 'base_url' || id === 'upstream_mode') continue;
      // Dashboard category entries are [target, base_url, mode]; an empty
      // base_url/mode means "inherit from the category", so show what the
      // router would actually use.
      const [target, baseUrl, mode] = Array.isArray(entry) ? entry : ['', '', ''];
      modelRows.push([category, id, target, baseUrl || categoryBaseUrl, mode || categoryMode]);
    }
  }
  sections.push({ title: 'Target models', headers: ['CATEGORY', 'ID', 'TARGET', 'BASE URL', 'MODE'], rows: modelRows });

  // Each aliased target gets its own line so a long target list stays readable.
  const compositeRows = Object.entries(payload.composite).map(([alias, targets]) => [
    alias,
    describeCompositeTargets(targets).join('\n'),
    describeCompositeLimit(targets),
  ]);
  sections.push({ title: 'Composite aliases', headers: ['ALIAS', 'TARGETS', 'TOKEN LIMIT'], rows: compositeRows });

  const scheduleRows = Object.entries(payload.schedule).map(([alias, targets]) => [
    alias,
    Object.entries(targets).map(([target, windows]) => `${target}${describeWindows(windows)}`).join('\n'),
  ]);
  sections.push({ title: 'Schedule aliases', headers: ['ALIAS', 'TARGETS (windows)'], rows: scheduleRows });

  const out: string[] = [
    `Config: ${configPath}`,
    `  ${counts.targets} target models, ${counts.composite} composite aliases, ${counts.schedule} schedule aliases`,
    '',
  ];
  for (const section of sections) {
    out.push(`${section.title} (${section.rows.length})`, '');
    out.push(section.rows.length === 0 ? '  (none)' : indent(renderTable(section.headers, section.rows)), '');
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

/** One line per target: ["or-nemotron3-550b (share=100, primary)", "grok46 (share=10)"] */
function describeCompositeTargets(targets: Record<string, unknown>): string[] {
  const lines: string[] = [];
  for (const [name, rawConfig] of Object.entries(targets)) {
    if (name === 'token_limit' || name === 'fusion_options' || name === 'toolset') continue;
    if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) continue;
    const cfg = rawConfig as Record<string, unknown>;
    const attrs: string[] = [];
    if (cfg.primary === true) attrs.push('primary');
    for (const key of ['share', 'fallback', 'fusion', 'coord'] as const) {
      if (typeof cfg[key] === 'number') attrs.push(`${key}=${cfg[key]}`);
    }
    if (typeof cfg.role === 'string') attrs.push(`role=${cfg.role}`);
    lines.push(attrs.length > 0 ? `${name} (${attrs.join(', ')})` : name);
  }
  return lines;
}

function describeCompositeLimit(targets: Record<string, unknown>): string {
  const limit = targets.token_limit as { num?: unknown; duration?: unknown } | undefined;
  if (!limit || typeof limit.num !== 'number' || typeof limit.duration !== 'string') return '';
  return `${limit.num} ${limit.duration}`;
}

/** "@0-24[weekday]" — empty for a fallback target with no windows. */
function describeWindows(windows: { from?: number; to?: number; days?: unknown }[]): string {
  if (windows.length === 0) return '@fallback';
  return windows
    .map((w) => {
      const range = `@${w.from ?? 0}-${w.to ?? 24}`;
      const days = w.days === undefined ? '' : Array.isArray(w.days) ? `[${w.days.join(',')}]` : `[${w.days}]`;
      return `${range}${days}`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// --export-pi-models
// ---------------------------------------------------------------------------

function exportPiModels(configPath: string, baseUrl: string, defaultModel: string | undefined): number {
  const config = tryLoadConfig(configPath);
  if (!config) return 1;

  // getConfiguredModelIds returns target models first, then composite and
  // schedule aliases — the same set /v1/models serves.
  const ids = getConfiguredModelIds(config);
  if (ids.length === 0) {
    process.stderr.write('Cannot export pi models: the config defines no models\n');
    return 1;
  }
  const chosen = defaultModel ?? ids[0];
  if (!ids.includes(chosen)) {
    return usageError(`--default-model "${chosen}" is not a configured model or alias. Available: ${ids.join(', ')}`);
  }

  const models = ids.map((id) => buildProxyPiModel(id, baseUrl));

  // Emit the pi models-file shape (one custom provider holding every alias),
  // so the output can be dropped straight into ~/.pi/agent/models.json, plus
  // the `defaultProvider`/`defaultModel` pair pi keeps in
  // ~/.pi/agent/settings.json to pick the default model.
  // `apiKey` is a dummy: the proxy's client auth is a presence check (any
  // non-empty value passes unless an auth_server is configured), so nothing
  // secret is written — the same convention agent-session.ts uses for its
  // own loopback calls.
  const modelsFile = {
    defaultProvider: PROXY_PROVIDER_ID,
    defaultModel: chosen,
    providers: {
      [PROXY_PROVIDER_ID]: {
        api: 'anthropic-messages',
        apiKey: 'sk-hi',
        baseUrl,
        models,
      },
    },
  };
  process.stdout.write(`${JSON.stringify(modelsFile, null, 2)}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// --export-openclaw-providers
// ---------------------------------------------------------------------------

function exportOpenClawProviders(configPath: string, baseUrl: string): number {
  const config = tryLoadConfig(configPath);
  if (!config) return 1;

  const ids = getConfiguredModelIds(config);
  if (ids.length === 0) {
    process.stderr.write('Cannot export OpenClaw providers: the config defines no models\n');
    return 1;
  }

  // OpenClaw keys providers by id under `models.providers` (an object, not an
  // array), so every alias goes into the single proxy provider entry.
  // `apiKey` is the same dummy --export-pi-models writes: the proxy's client
  // auth is a presence check, so nothing secret is written. The per-model
  // fields mirror the provider block's api/baseUrl rather than repeating them.
  const models: OpenClawProviderModelConfig[] = ids.map((id) => {
    const model = buildProxyPiModel(id, baseUrl);
    return {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    };
  });

  const openclaw: OpenClawConfig = {
    models: {
      mode: 'merge',
      providers: {
        [PROXY_PROVIDER_ID]: {
          baseUrl,
          apiKey: 'sk-hi',
          auth: 'api-key',
          api: 'anthropic-messages',
          models,
        },
      },
    },
  };
  process.stdout.write(`${JSON.stringify(openclaw, null, 2)}\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// --validate-config
// ---------------------------------------------------------------------------

function validateConfig(configPath: string): number {
  let content: string;
  try {
    content = readFileSync(configPath, 'utf-8');
  } catch (err) {
    process.stderr.write(`Cannot read config file ${configPath}: ${(err as Error).message}\n`);
    return 1;
  }

  // parseSimpleToml validates as it parses and logs each finding to
  // console.error/console.warn ([ERROR]/[WARN]/[FATAL] prefixed). It also
  // records them on the config object, which is what we count here — printing
  // the arrays again would just duplicate the lines the parser already wrote.
  const config = parseSimpleToml(content);
  const meta = config as unknown as {
    _validationErrors?: ConfigValidationError[];
    _validationWarnings?: ConfigValidationError[];
  };
  const errors = meta._validationErrors ?? [];
  const warnings = meta._validationWarnings ?? [];

  const counts =
    `${getModelNamesInConfig(config).size} target models, ` +
    `${Object.keys(config.composite ?? {}).length} composite aliases, ` +
    `${Object.keys(config.schedule ?? {}).length} schedule aliases`;

  process.stdout.write(
    `Config file: ${configPath}\n` +
      `  ${counts}\n` +
      `\nResult: ${errors.length} errors, ${warnings.length} warnings — ` +
      (errors.length > 0 ? 'config is INVALID' : 'config is valid') +
      '\n',
  );
  return errors.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

function renderTable(headers: string[], rows: string[][]): string {
  // A cell may hold several lines (one aliased target per line); such a row
  // spans as many output lines, with the other columns left blank beside it.
  const cells = rows.map((row) => row.map((cell) => (cell ?? '').split('\n')));
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...cells.map((row) => Math.max(...row[i].map((part) => part.length)))),
  );
  const line = (parts: string[]): string =>
    parts.map((part, i) => part.padEnd(widths[i])).join('  ').replace(/\s+$/, '');

  const out = [line(headers)];
  for (const row of cells) {
    const height = Math.max(...row.map((parts) => parts.length));
    for (let i = 0; i < height; i++) out.push(line(row.map((parts) => parts[i] ?? '')));
  }
  return out.join('\n');
}

function indent(block: string): string {
  return block
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
