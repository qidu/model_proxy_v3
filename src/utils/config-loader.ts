/**
 * Proxy configuration loader
 * Loads config from file or URL
 * Compatible with both Node.js and Cloudflare Workers environments
 */

import { Env } from '../types/shared.js';
import { mkdirSync, readFileSync, writeFileSync, renameSync, copyFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { getPrivacyFilterConfig } from './privacy-filter.js';
import { resolveImageEncodeConfig, setImageEncodeConfig } from './image-fetch.js';
import { buildConsulKvUrl, parseConsulConfig } from './consul-loader.js';
import type { ConsulKvEntry } from './consul-loader.js';
import { parseApolloFile, fetchApolloConfig } from './apollo-loader.js';
import { createLogger } from './logger.js';
import { applySystemKeyStore, findSentinelApiKeys, KeyStoreError, scoreBaseUrlMatch, STORE_KEY_IN_SYSTEM } from './key-store.js';

// Check if we're running in Node.js environment
const isNodeEnvironment = (typeof process !== 'undefined' && process.versions?.node) ||
                          (typeof globalThis !== 'undefined' && (globalThis as any).process?.versions?.node);

export interface ProxyConfig {
  general?: {
    budget_to_effort_low?: number | string;
    budget_to_effort_medium?: number | string;
    budget_to_effort_high?: number | string;
    global_token_limit?: string;
    week_start_day?: 'monday' | 'sunday';
    /** Store config api_keys in the OS keychain (see src/utils/key-store.ts). */
    store_key_in_system?: boolean;
  };
  remote?: {
    authentication?: {
      auth_server?: string;
      auth_with_model?: boolean;
      auth_with_body?: boolean;
      auth_passthrough_with?: 'user_key' | 'config_key';
    };
    recording?: {
      record_server?: string;
      record_response_body?: boolean;
    };
  };
  default_upstream?: {
    upstream_mode?: string;
    default_base_url?: string;
    default_api_key?: string;
  };
  models?: Record<string, ModelCategoryConfig | ModelArrayConfig>;
  composite?: Record<string, CompositeModelConfig>;
  schedule?: Record<string, ScheduleConfig>;
  transforms?: Record<string, TransformSet>;
  transform_defaults?: Record<string, string[]>;
  defaults?: {
    upstream_mode?: string;
  };
  dashboard?: {
    api_key?: string;
  };
  /**
   * Privacy filter plugin configuration. When omitted, the plugin is inert
   * (no env-var sidecar URL set either).
   *
   * `mode`:
   *   - "sidecar" (default when `PRIVACY_FILTER_URL` env var is set): redact
   *     by calling the OPF privacy-filter sidecar over HTTP. The sidecar
   *     handles both PII and HASH detection.
   *   - "local": redact in-process using the TypeScript `hash-detect` port.
   *     Useful when you only need hash/key detection (no PII model) and want
   *     to skip the sidecar entirely.
   *
   * `enabled`: explicit on/off switch (default: true when `mode` is set or
   *   any redact-related knob is configured).
   *
   * `whitelist_add` / `whitelist_remove`: extend or trim the built-in
   *   hexspeak whitelist. See `submodules/privacy-filter/hash_detect.py`
   *   for the format (one entry per line, `#` comments, `-token` to remove).
   *
   * `whitelist_file`: path to a whitelist override file (Node-only; ignored
   *   on Cloudflare Workers).
   */
  privacy_filter?: {
    filter_mode?: 'sidecar' | 'local';
    filter_url?: string;
    timeout_ms?: number;
    max_chars?: number;
    entropy_threshold?: number;
    hash_min_len?: number;
    whitelist_add?: string[];
    whitelist_remove?: string[];
    whitelist_file?: string;
  };
  /**
   * Image-encode sidecar for OpenAI image_url -> Gemini inline_data
   * conversion. When `image_encode` is set (or `IMAGE_ENCODE_URL` env var),
   * http(s) image URLs are POSTed to `{image_encode}/encode` with body
   * `{"url": "..."}` and the sidecar returns `{"mime_type","data"}` with
   * base64-encoded bytes. The sidecar must be on localhost or a private/LAN
   * host (validated against `isInternalHost`). When unset, the proxy does
   * the fetch + base64 in-process with its own SSRF guard.
   */
  fetch?: {
    image_encode?: string;
    timeout_ms?: number;
  };
}

// ---------------------------------------------------------------------------
// Transform types
// ---------------------------------------------------------------------------

export type TransformSchema =
  | 'openai-completions'
  | 'anthropic-messages'
  | 'openai-responses'
  | 'gemini-generatecontent';

export type TransformOp =
  | { op: 'rename';    path: string; to: string }
  | { op: 'set';       path: string; value: unknown }
  | { op: 'default';   path: string; value: unknown }
  | { op: 'remove';    path: string }
  | { op: 'map_value'; path: string; from: unknown; to: unknown; when_sibling?: string };

export type BuiltinName = 'lowercase_tool_schema_types' | 'recover_tool_message_name' | 'inject_missing_tool_results' | 'strip_fresh_thinking' | 'filter_anthropic_beta' | 'ensure_tool_config_cache_ttl' | 'ensure_trailing_user_message' | 'assemble_sse_chunks' | 'restore_client_model_alias' | 'project_program_to_node_tool';

/** A named transform set declared under [transforms.<name>] */
export interface TransformSet {
  name: string;
  schema: TransformSchema;
  /**
   * Beta-header allow/map table consumed by the `filter_anthropic_beta` builtin.
   * Keys: input anthropic-beta entries (comma-separated header value).
   * Values: the upstream header name to emit, or null to drop. Entries not
   * present in the map are also dropped. Mirrors LiteLLM's
   * anthropic_beta_headers_config.json (see docs/claude-beta-headers.md).
   */
  anthropic_beta_map?: Record<string, string | null>;
  // ops/builtins may be scoped to a hook or declared at the top level (apply to all hooks)
  request_ingress?: { ops?: TransformOp[]; builtins?: BuiltinName[] };
  before_conversion?: { ops?: TransformOp[]; builtins?: BuiltinName[] };
  before_upstream?: { ops?: TransformOp[]; builtins?: BuiltinName[]; headers?: { set?: Record<string, string>; remove?: string[] } };
  after_upstream?: { ops?: TransformOp[]; builtins?: BuiltinName[] };
  response_egress?: { ops?: TransformOp[]; builtins?: BuiltinName[]; headers?: { set?: Record<string, string>; remove?: string[] } };
}

// Legal shallow paths per schema (used for load-time validation)
const SCHEMA_PATHS: Record<TransformSchema, Set<string>> = {
  'openai-completions': new Set([
    // top-level params
    'model', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'stop',
    'stream', 'stream_options', 'response_format', 'tools', 'tool_choice',
    'frequency_penalty', 'presence_penalty', 'logit_bias', 'seed', 'logprobs',
    'top_logprobs', 'thinking', 'reasoning_effort', 'prompt_cache_key', 'output_config',
    // message fields (bare)
    'messages[].content', 'messages[].name', 'messages[].tool_calls', 'messages[].tool_call_id', 'messages[].role',
    // role-filtered
    'messages[role=system].content', 'messages[role=user].content',
    'messages[role=assistant].content', 'messages[role=assistant].tool_calls',
    'messages[role=assistant].reasoning_content',
    'messages[role=tool].content', 'messages[role=tool].name', 'messages[role=tool].tool_call_id',
    // response-side ($response prefix)
    '$response.id', '$response.model', '$response.choices[].message.content',
    '$response.choices[].message.role', '$response.choices[].finish_reason', '$response.usage',
  ]),
  'anthropic-messages': new Set([
    'model', 'max_tokens', 'system', 'temperature', 'top_p', 'top_k', 'stop_sequences',
    'stream', 'tools', 'tool_choice', 'thinking', 'reasoning_effort', 'output_config',
    'service_tier', 'metadata', 'cached_content',
    'messages[].content', 'messages[].role',
    'messages[role=user].content', 'messages[role=assistant].content',
    '$response.id', '$response.model', '$response.content', '$response.stop_reason', '$response.usage',
  ]),
  'openai-responses': new Set([
    'model', 'input', 'max_output_tokens', 'temperature', 'top_p', 'tools',
    'tool_choice', 'reasoning', 'stream', 'previous_response_id', 'metadata',
    '$response.id', '$response.model', '$response.output', '$response.usage',
  ]),
  'gemini-generatecontent': new Set([
    'model', 'contents', 'systemInstruction', 'generationConfig', 'tools',
    'toolConfig', 'safetySettings', 'cachedContent',
    '$response.candidates', '$response.usageMetadata',
  ]),
};

const BUILTIN_NAMES: Set<BuiltinName> = new Set(['lowercase_tool_schema_types', 'recover_tool_message_name', 'inject_missing_tool_results', 'strip_fresh_thinking', 'filter_anthropic_beta', 'ensure_tool_config_cache_ttl', 'ensure_trailing_user_message', 'assemble_sse_chunks', 'restore_client_model_alias', 'project_program_to_node_tool']);

/**
 * Backward-compatible hook name aliases.
 * `endpoint_readin` is a legacy alias for `request_ingress`.
 * `endpoint_writeout` is a legacy alias for `response_egress`.
 * Aliases are normalized to canonical names at parse time; the runtime engine
 * always sees canonical names only.
 */
const HOOK_ALIASES: Record<string, 'request_ingress' | 'response_egress'> = {
  endpoint_readin: 'request_ingress',
  endpoint_writeout: 'response_egress',
};

/** Normalize an alias to its canonical HookPoint name; returns input unchanged if not an alias. */
export function normalizeHookAlias(key: string): string {
  return HOOK_ALIASES[key] ?? key;
}

export interface TransformValidationError {
  set: string;
  message: string;
}

/**
 * Engine-walkable path predicate.
 *
 * The Tier-1 op runner (`applyOpToBody` → `parsePath`) can only target:
 *   - top-level fields with a name containing neither `.` nor `[` (e.g. `max_tokens`)
 *   - role-filtered message fields (`messages[role=assistant].content`) — single
 *     segment, no further nesting
 *   - shallow response fields (`$response.id`) — single segment, no `.` or `[`
 *
 * Anything else (e.g. `$response.choices[].message.content`, `tools[0].function`)
 * would silently create literal-bracketed/dotted keys on the body, so it must be
 * rejected at load time (CLAUDE.md §8 Fail Loud). The validator consults this
 * helper *after* checking `SCHEMA_PATHS` so a path can be both known-to-the-schema
 * and not-yet-walkable by the engine.
 *
 * Named built-ins (`lowercase_tool_schema_types`, `recover_tool_message_name`)
 * cover the deep-field cases that shallow paths can't reach.
 */
function isPathWalkable(path: string): boolean {
  if (path.startsWith('$response.')) {
    const rest = path.slice('$response.'.length);
    return !rest.includes('.') && !rest.includes('[');
  }
  if (path.startsWith('messages[')) {
    // messages[] or messages[role=X] — never nested beyond one segment
    const rest = path.slice('messages['.length);
    // rest must be "]" or "role=X].<field>" with no further dots/brackets in <field>
    const m = rest.match(/^(?:role=(\w+))?\]\.([^.\[]+)$/);
    return m !== null;
  }
  // top-level: single name, no dots, no brackets
  return !path.includes('.') && !path.includes('[');
}

export function validateTransformSet(name: string, set: TransformSet): TransformValidationError[] {
  const errs: TransformValidationError[] = [];
  const legalPaths = SCHEMA_PATHS[set.schema];
  if (!legalPaths) {
    errs.push({ set: name, message: `unknown schema "${set.schema}"` });
    return errs;
  }

  // Validate anthropic_beta_map if present.
  if (set.anthropic_beta_map !== undefined) {
    for (const [k, v] of Object.entries(set.anthropic_beta_map)) {
      if (typeof k !== 'string' || k.length === 0) {
        errs.push({ set: name, message: `anthropic_beta_map has a non-string or empty key` });
      }
      if (v !== null && typeof v !== 'string') {
        errs.push({ set: name, message: `anthropic_beta_map["${k}"] must be a string or null, got ${typeof v}` });
      }
    }
  }

  const hookNames = ['request_ingress', 'before_conversion', 'before_upstream', 'after_upstream', 'response_egress'] as const;
  for (const hook of hookNames) {
    const slot = set[hook];
    if (!slot) continue;
    for (const op of slot.ops ?? []) {
      if (!legalPaths.has(op.path)) {
        errs.push({ set: name, message: `[${hook}] unknown path "${op.path}" for schema "${set.schema}"` });
        continue;
      }
      if (!isPathWalkable(op.path)) {
        errs.push({
          set: name,
          message:
            `[${hook}] path "${op.path}" is declared for schema "${set.schema}" but the engine ` +
            `cannot walk it (nested arrays/objects). Use a named builtin or a shallow ` +
            `(single-segment) path instead.`,
        });
      }
    }
    for (const b of slot.builtins ?? []) {
      if (!BUILTIN_NAMES.has(b)) {
        errs.push({ set: name, message: `[${hook}] unknown builtin "${b}"` });
      }
      // Schema-gated builtins: each entry maps a builtin to the only schema(s)
      // where it is safe to run. Attaching a builtin outside its allowed
      // schema silently corrupts the response, so fail loud at load time.
      const BUILTIN_SCHEMA: Partial<Record<BuiltinName, TransformSchema[]>> = {
        'assemble_sse_chunks': ['openai-completions'],
        'strip_fresh_thinking': ['anthropic-messages'],
        'ensure_trailing_user_message': ['anthropic-messages'],
      };
      const allowed = BUILTIN_SCHEMA[b];
      if (allowed && !allowed.includes(set.schema)) {
        errs.push({
          set: name,
          message: `[${hook}] builtin "${b}" requires schema ${allowed.map(s => `"${s}"`).join(' or ')} but set has schema "${set.schema}"`,
        });
      }
    }
  }
  return errs;
}

export function validateAllTransforms(config: ProxyConfig): TransformValidationError[] {
  const errs: TransformValidationError[] = [];
  const defined = config.transforms ?? {};

  // Validate each declared transform set
  for (const [name, set] of Object.entries(defined)) {
    errs.push(...validateTransformSet(name, set));
  }

  // Validate transform_defaults references
  for (const [mode, names] of Object.entries(config.transform_defaults ?? {})) {
    for (const n of names) {
      if (!defined[n]) {
        errs.push({ set: `transform_defaults.${mode}`, message: `references undefined transform set "${n}"` });
      }
    }
  }

  // Validate per-model entry transform references
  if (config.models) {
    for (const [catName, catConfig] of Object.entries(config.models)) {
      if (Array.isArray(catConfig)) continue;
      const cat = catConfig as ModelCategoryConfig;
      for (const [key, val] of Object.entries(cat)) {
        if (!Array.isArray(val)) continue;
        const entry = val as string[];
        // entry[4] is transforms CSV if present (index 4 in the 5-element form)
        const transformsCsv = entry[4];
        if (transformsCsv) {
          for (const n of transformsCsv.split(',').map(s => s.trim()).filter(Boolean)) {
            if (!defined[n]) {
              errs.push({ set: `models.${catName}.${key}`, message: `references undefined transform set "${n}"` });
            }
          }
        }
      }
    }
  }

  return errs;
}

// ---------------------------------------------------------------------------

export interface ModelCategoryConfig {
  upstream_mode?: string;
  base_url?: string;
  api_key?: string;
  [modelId: string]: string | string[] | undefined;
}

export type ModelArrayConfig = [string, string, string]; // [model_alias, base_url, api_key]

// Sliding tokens (Nh, Nd) roll continuously from "now".
// Calendar tokens (1w, 1m) anchor to wall-clock boundaries.
export const TOKEN_LIMIT_DURATIONS = [
  '1h','2h','3h','4h','5h','6h','7h','8h','9h','10h','11h','12h',
  '13h','14h','15h','16h','17h','18h','19h','20h','21h','22h','23h',
  '1d','2d','3d','4d','5d','6d',
  '1w', '1m',
] as const;
export type TokenLimitDuration = typeof TOKEN_LIMIT_DURATIONS[number];

// True if duration rolls continuously from `now` (e.g. 1h, 6h, 1d, 6d).
// False for calendar-anchored durations (1w, 1m).
export function isSlidingDuration(d: string): boolean {
  return /^([1-9]|1[0-9]|2[0-3])h$/.test(d) || /^([1-6])d$/.test(d);
}

/**
 * Parse a human-readable token limit string into a number.
 * Supports raw numbers ("50000"), whole-number suffixes ("100k", "1.5M"),
 * and suffix-only with multiplier ("k", "M", "B", "T").
 * Examples: "50k 1d" → {num: 50000, duration: "1d"}, "1.5M 1h" → {num: 1500000, duration: "1h"}
 */
export function parseHumanTokenLimit(raw: string): { num: number; duration: TokenLimitDuration } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^([\d.]+)\s*([kKmMbBtT]?)\s+(\d{1,2})([hHdDwWmM])$/);
  if (!match) return null;
  let num = parseFloat(match[1]);
  if (!Number.isFinite(num) || num < 0) return null;
  const suffix = match[2].toLowerCase();
  if (suffix === 'k') num *= 1_000;
  else if (suffix === 'm') num *= 1_000_000;
  else if (suffix === 'b') num *= 1_000_000_000;
  else if (suffix === 't') num *= 1_000_000_000_000;
  if (num < 0 || !Number.isFinite(num)) return null;
  const count = parseInt(match[3], 10);
  const unit = match[4].toLowerCase();
  // Validate count ranges per unit. w/m are calendar tokens and only accept 1.
  if (unit === 'h' && (count < 1 || count > 23)) return null;
  if (unit === 'd' && (count < 1 || count > 6)) return null;
  if ((unit === 'w' || unit === 'm') && count !== 1) return null;
  const duration = `${count}${unit}` as TokenLimitDuration;
  return { num, duration };
}

/**
 * Format a token limit as a human-readable string. Units are always uppercase
 * (K/M/B/T) per the project convention.
 * Examples: 50000 → "50K", 1500000 → "1.5M"
 */
export function formatTokenLimit(num: number): string {
  if (num >= 1_000_000_000_000) return (num / 1_000_000_000_000).toFixed(1).replace(/\.0$/, '') + 'T';
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1).replace(/\.0$/, '') + 'B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1).replace(/\.0$/, '') + 'K';
  return String(num);
}

export interface TokenLimitConfig {
  num: number;
  duration: TokenLimitDuration;
}

export type FusionRole = 'panel' | 'judge' | 'synth' | 'planner' | 'executor';

export interface FusionOptions {
  min_panel?: number;        // min successful panel responses to proceed (default 1)
  panel_timeout_ms?: number; // per-panel-call wall clock ms (default 60000)
  judge_required?: boolean;  // if false, synth runs on raw panel if judge fails (default false)
  expose_metadata?: boolean; // attach fusion_metadata to response (default true)
  max_concurrent?: number;   // max simultaneous panel calls; default = panel size (full fan-out)
}

export interface CompositeTargetConfig {
  share?: number;
  primary?: boolean;
  fallback?: number;
  fusion?: number;           // > 0 marks target as panel member (weight reserved for future use)
  coord?: number;            // > 0 marks target as coordinator participant (planner or executor)
  role?: FusionRole;         // explicit stage: 'panel' | 'judge' | 'synth' | 'planner' | 'executor'
}

export interface CompositeModelConfig {
  token_limit?: TokenLimitConfig;
  fusion_options?: FusionOptions;
  toolset?: string[];        // coordinator trigger tool names; absent = default set; [] = any tool
  [modelName: string]: CompositeTargetConfig | TokenLimitConfig | FusionOptions | string[] | undefined;
}

export interface CoordinatorPlan {
  alias: string;
  plannerName: string;
  plannerRoute: ModelRouteConfig;
  executorName: string;
  executorRoute: ModelRouteConfig;
  /** null = any tool_use triggers hand-off; Set<string> = only listed tool names */
  triggerTools: Set<string> | null;
}

/** Applied when `toolset` key is absent — curated default for Claude Code plan-mode sessions. */
export const COORDINATOR_DEFAULT_TRIGGER_TOOLS = new Set([
  'ExitPlanMode',   // explicit Claude Code plan-mode exit
  'Edit',           // file mutation
  'Write',          // file creation
  'Bash',           // shell execution
  'NotebookEdit',   // notebook mutation
]);

export interface FusionPlan {
  alias: string;
  panel: Array<{ modelName: string; route: ModelRouteConfig }>;
  judge: { modelName: string; route: ModelRouteConfig } | undefined;
  synth: { modelName: string; route: ModelRouteConfig };
  options: Required<FusionOptions>;
}

// 'weekday' = Mon-Fri (day 1-5), 'weekend' = Sat/Sun (day 0,6), string[] = lowercase 3-letter day
// names (e.g. ['mon','tue']). Default (undefined) = every day.
export type ScheduleDaysSpec = 'weekday' | 'weekend' | string[];

export interface ScheduleWindow {
  from?: number; // hour 0-24, default 0
  to?: number;   // hour 0-24, default 24
  days?: ScheduleDaysSpec;
}

// alias -> target model/alias name -> list of windows. Empty array = fallback
// (always eligible, used when no other target's windows match "now").
export type ScheduleConfig = Record<string, ScheduleWindow[]>;

const COMPOSITE_META_KEYS = new Set(['token_limit', 'fusion_options', 'toolset']);

function getCompositeTargetEntries(config: CompositeModelConfig | undefined): Array<[string, CompositeTargetConfig]> {
  return Object.entries(config || {}).filter(([key]) => !COMPOSITE_META_KEYS.has(key)) as Array<[string, CompositeTargetConfig]>;
}

function getCompositeTokenLimit(config: CompositeModelConfig | undefined): TokenLimitConfig | undefined {
  const limit = config?.token_limit;
  if (!limit || typeof limit !== 'object' || limit === null) return undefined;
  const l = limit as unknown as Record<string, unknown>;
  if (typeof l.num !== 'number' || !Number.isFinite(l.num)) return undefined;
  if (typeof l.duration !== 'string') return undefined;
  if (!(TOKEN_LIMIT_DURATIONS as readonly string[]).includes(l.duration)) return undefined;
  return limit as TokenLimitConfig;
}

export interface ModelRouteConfig {
  targetUrl: string;
  apiKey?: string;
  upstreamMode: string;
  modelAlias?: string;
  section?: string;
  transforms: TransformSet[];  // resolved & merged: mode-defaults → sector-defaults → entry
  maxTokens?: number;  // per-entry default max_tokens; falls back to DEFAULT_MAX_TOKENS when unset
}

export interface CompositeRouteSelection {
  selectedModelName: string;
  route: ModelRouteConfig;
  skippedTargets: string[];
}

export interface CompositeRouteCandidate {
  modelName: string;
  route: ModelRouteConfig;
  targetConfig: CompositeTargetConfig;
}

interface CompositeResolvedTarget {
  targetModelName: string;
  targetConfig: CompositeTargetConfig;
  route: ModelRouteConfig;
  index: number;
}

/**
 * Resolve the merged transform list for a route.
 * Order (design doc §3b / open-question #8): mode-defaults → sector-defaults → entry transforms.
 * Each level's names are looked up from proxyConfig.transforms.
 */
function resolveTransforms(
  upstreamMode: string,
  categoryTransforms: string | undefined,
  entryTransforms: string | undefined,
  proxyConfig: ProxyConfig,
): TransformSet[] {
  const defined = proxyConfig.transforms ?? {};
  const lookup = (csv: string | undefined): TransformSet[] =>
    (csv ?? '').split(',').map(n => n.trim()).filter(Boolean).map(n => defined[n]).filter((s): s is TransformSet => s !== undefined);

  const modeNames = proxyConfig.transform_defaults?.[upstreamMode] ?? [];
  const modeSets = modeNames.map(n => defined[n]).filter((s): s is TransformSet => s !== undefined);
  return [...modeSets, ...lookup(categoryTransforms), ...lookup(entryTransforms)];
}

function resolveModelRouteFromEntry(
  modelEntry: string | string[],
  categoryConfig: ModelCategoryConfig,
  proxyConfig: ProxyConfig,
  modelName?: string,
  sectionName?: string,
): ModelRouteConfig {
  const categoryUpstreamMode = categoryConfig.upstream_mode ||
                               proxyConfig.default_upstream?.upstream_mode ||
                               'openai-completions';
  const categoryBaseUrl = categoryConfig.base_url ||
                          proxyConfig.default_upstream?.default_base_url ||
                          'http://localhost';

  const categoryApiKey = categoryConfig.api_key ||
                        proxyConfig.default_upstream?.default_api_key;

  if (Array.isArray(modelEntry)) {
    const [modelAlias, modelBaseUrl, modelApiKey, modelMode] = modelEntry;
    let resolvedTarget = modelAlias;

    // Case 1: Prefix wildcard — e.g. "claude-*" matches "claude-sonnet-4-6"
    // Substitute * so upstream sees "claude-sonnet-4-6" instead of the literal "claude-*"
    if (modelName && modelAlias?.endsWith('*') && modelAlias.includes('-')) {
      const asteriskIdx = modelAlias.indexOf('*');
      const prefix = modelAlias.slice(0, asteriskIdx); // "claude-" from "claude-*"
      if (modelName.startsWith(prefix)) {
        resolvedTarget = prefix + modelName.slice(prefix.length);
      }
    }

    // Case 2: Bare catch-all — "*" means "route to default config, keep model name unchanged"
    // resolvedTarget stays as "*" only when modelName is unavailable; otherwise passthrough.
    if (resolvedTarget === '*' && modelName) {
      resolvedTarget = modelName;
    }

    const resolvedMode = modelMode || categoryUpstreamMode;
    const entryTransformsCsv = modelEntry[4]; // index 4: comma-separated transform set names
    const entryMaxTokensRaw = modelEntry[5]; // index 5: optional per-entry max_tokens
    const entryMaxTokens = entryMaxTokensRaw !== undefined && /^\d+$/.test(entryMaxTokensRaw)
      ? parseInt(entryMaxTokensRaw, 10)
      : undefined;
    const categoryTransformsCsv = (categoryConfig as Record<string, unknown>)['transforms'] as string | undefined;
    return {
      targetUrl: modelBaseUrl || categoryBaseUrl,
      apiKey: parseApiKey(modelApiKey || categoryApiKey),
      upstreamMode: resolvedMode,
      modelAlias: resolvedTarget || undefined,
      section: sectionName,
      transforms: resolveTransforms(resolvedMode, categoryTransformsCsv, entryTransformsCsv, proxyConfig),
      ...entryMaxTokens !== undefined ? { maxTokens: entryMaxTokens } : {},
    };
  }

  return {
    targetUrl: categoryBaseUrl,
    apiKey: parseApiKey(categoryApiKey),
    upstreamMode: categoryUpstreamMode,
    modelAlias: modelEntry || undefined,
    section: sectionName,
    transforms: resolveTransforms(categoryUpstreamMode, undefined, undefined, proxyConfig),
  };
}

function resolveModelRouteFromConfig(
  modelName: string,
  proxyConfig: ProxyConfig
): ModelRouteConfig | undefined {
  const modelConfig = getModelConfig(proxyConfig, modelName);
  if (!modelConfig) {
    return undefined;
  }

  const entry = modelConfig.entry;
  if (entry === undefined) {
    return undefined;
  }

  return resolveModelRouteFromEntry(entry, modelConfig.categoryConfig, proxyConfig, modelName, modelConfig.category);
}

function getOrderedCompositeTargets(
  modelName: string,
  proxyConfig: ProxyConfig,
  visited: Set<string> = new Set(),
): { orderedTargets: CompositeResolvedTarget[]; skippedTargets: string[] } | undefined {
  const compositeConfig = proxyConfig.composite?.[modelName];
  if (!compositeConfig) {
    return undefined;
  }

  // We are about to recurse into each target with full routing (schedule →
  // composite → direct → default), so push `modelName` onto the visited
  // chain first. If a target ever references a composite alias that's already
  // on the stack (e.g. A → B → A), getModelRouteConfig throws a cycle error.
  const nextVisited = new Set(visited);
  nextVisited.add(modelName);

  const skippedTargets: string[] = [];
  const resolvedTargets = getCompositeTargetEntries(compositeConfig)
    .map(([targetModelName, targetConfig], index) => {
      // Use the full routing chain so a composite / schedule / fusion target
      // resolves to a leaf model's route (not the broken default-route
      // fallback with the alias name passed as `model:`). Cycle detection
      // happens inside getModelRouteConfig.
      const route = getModelRouteConfig(targetModelName, proxyConfig, nextVisited);

      return {
        targetModelName,
        targetConfig: targetConfig || {},
        route,
        index,
      };
    })
    .filter((candidate): candidate is CompositeResolvedTarget => candidate !== undefined);

  if (resolvedTargets.length === 0) {
    return { orderedTargets: [], skippedTargets };
  }

  // Filter out targets with share === 0 (they should not be visited via composite)
  const eligible = resolvedTargets.filter((c) => {
    if (c.targetConfig.share === 0) {
      skippedTargets.push(c.targetModelName);
      return false;
    }
    return true;
  });

  if (eligible.length === 0) {
    return { orderedTargets: [], skippedTargets };
  }

  const primaryCandidate = eligible.find((candidate) => candidate.targetConfig.primary);
  const orderedTargets = primaryCandidate
    ? [primaryCandidate, ...eligible.filter((candidate) => candidate !== primaryCandidate)]
    : eligible
        .slice()
        .sort((left, right) => {
          const leftFallback = left.targetConfig.fallback;
          const rightFallback = right.targetConfig.fallback;

          if ((leftFallback !== undefined && leftFallback > 0) || (rightFallback !== undefined && rightFallback > 0)) {
            const normalizedLeft = leftFallback && leftFallback > 0 ? leftFallback : Number.POSITIVE_INFINITY;
            const normalizedRight = rightFallback && rightFallback > 0 ? rightFallback : Number.POSITIVE_INFINITY;
            if (normalizedLeft !== normalizedRight) {
              return normalizedLeft - normalizedRight;
            }
          }

          return left.index - right.index;
        });

  return { orderedTargets, skippedTargets };
}

function resolveCompositeModelRoute(
  modelName: string,
  proxyConfig: ProxyConfig,
  visited: Set<string> = new Set(),
): CompositeRouteSelection | undefined {
  const orderedComposite = getOrderedCompositeTargets(modelName, proxyConfig, visited);
  if (!orderedComposite) {
    return undefined;
  }

  const { orderedTargets, skippedTargets } = orderedComposite;
  if (orderedTargets.length === 0) {
    return undefined;
  }

  const selectedCandidate = orderedTargets.some(candidate => candidate.targetConfig.primary || (candidate.targetConfig.fallback !== undefined && candidate.targetConfig.fallback > 0))
    ? orderedTargets[0]
    : selectWeightedCompositeCandidate(orderedTargets);

  if (!selectedCandidate) {
    return undefined;
  }

  return {
    selectedModelName: selectedCandidate.targetModelName,
    route: {
      ...selectedCandidate.route,
      modelAlias: selectedCandidate.route.modelAlias || selectedCandidate.targetModelName,
    },
    skippedTargets,
  };
}

function selectWeightedCompositeCandidate<T extends { targetConfig: CompositeTargetConfig }>(candidates: T[]): T | undefined {
  if (candidates.length === 0) {
    return undefined;
  }

  const weights = candidates.map(candidate => candidate.targetConfig.share ?? 1);
  const totalWeight = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (totalWeight <= 0) {
    return candidates[0];
  }

  let remaining = Math.random() * totalWeight;
  for (let i = 0; i < candidates.length; i++) {
    remaining -= Math.max(0, weights[i]);
    if (remaining <= 0) {
      return candidates[i];
    }
  }

  return candidates[candidates.length - 1];
}

/**
 * Get model-specific routing config with category inheritance
 */
function getDefaultModelRoute(proxyConfig: ProxyConfig): ModelRouteConfig {
  const defaultCategory = proxyConfig.models?.default;
  const defaultCategoryConfig = defaultCategory && !Array.isArray(defaultCategory) ? defaultCategory : undefined;
  const defaultMode = defaultCategoryConfig?.upstream_mode ||
                     proxyConfig.default_upstream?.upstream_mode ||
                     'openai-completions';
  const defaultBaseUrl = defaultCategoryConfig?.base_url ||
                        proxyConfig.default_upstream?.default_base_url ||
                        'http://localhost';

  const defaultApiKey = defaultCategoryConfig?.api_key ||
                       proxyConfig.default_upstream?.default_api_key;

  return {
    targetUrl: defaultBaseUrl,
    apiKey: parseApiKey(defaultApiKey),
    upstreamMode: defaultMode,
    transforms: resolveTransforms(defaultMode, undefined, undefined, proxyConfig),
  };
}

export function getCompositeRouteCandidates(
  modelName: string,
  proxyConfig: ProxyConfig,
  visited: Set<string> = new Set(),
): CompositeRouteCandidate[] {
  if (!proxyConfig.models) {
    return [];
  }

  const orderedComposite = getOrderedCompositeTargets(modelName, proxyConfig, visited);
  if (!orderedComposite) {
    return [];
  }

  const { orderedTargets } = orderedComposite;
  const hasPriorityOrder = orderedTargets.some(candidate => candidate.targetConfig.primary || (candidate.targetConfig.fallback !== undefined && candidate.targetConfig.fallback > 0));

  let attemptOrder = orderedTargets;
  if (!hasPriorityOrder) {
    const firstCandidate = selectWeightedCompositeCandidate(orderedTargets);
    if (firstCandidate) {
      attemptOrder = [firstCandidate, ...orderedTargets.filter(candidate => candidate !== firstCandidate)];
    }
  }

  return attemptOrder.map(candidate => ({
    modelName: candidate.targetModelName,
    route: {
      ...candidate.route,
      modelAlias: candidate.route.modelAlias || candidate.targetModelName,
    },
    targetConfig: candidate.targetConfig,
  }));
}

export type CompositeAliasMode = 'coordinator' | 'fusion' | 'fallback' | 'share';

export function getCompositeAliasMode(
  modelName: string,
  proxyConfig: ProxyConfig
): CompositeAliasMode | undefined {
  const compositeConfig = proxyConfig.composite?.[modelName];
  if (!compositeConfig) return undefined;

  const entries = getCompositeTargetEntries(compositeConfig);

  // Coordinator takes precedence — detected first
  const isCoordinator = entries.some(([, cfg]) => typeof cfg.coord === 'number' && cfg.coord > 0);
  if (isCoordinator) return 'coordinator';

  const isFusion = entries.some(([, cfg]) =>
    cfg.role === 'panel' || cfg.role === 'judge' || cfg.role === 'synth' ||
    (typeof cfg.fusion === 'number' && cfg.fusion > 0)
  );
  if (isFusion) return 'fusion';

  const hasPriority = entries.some(([, cfg]) =>
    cfg.primary === true || (typeof cfg.fallback === 'number' && cfg.fallback > 0)
  );
  if (hasPriority) return 'fallback';

  return 'share';
}

export function resolveFusionPlan(
  modelName: string,
  proxyConfig: ProxyConfig,
  visited: Set<string> = new Set(),
): FusionPlan | undefined {
  const compositeConfig = proxyConfig.composite?.[modelName];
  if (!compositeConfig) return undefined;

  // Push `modelName` onto the chain before resolving panel / judge / synth
  // targets. If a target references a composite alias that's already on the
  // stack, getModelRouteConfig throws a cycle error.
  const nextVisited = new Set(visited);
  nextVisited.add(modelName);

  const entries = getCompositeTargetEntries(compositeConfig);

  const panel: Array<{ modelName: string; route: ModelRouteConfig }> = [];
  let judge: { modelName: string; route: ModelRouteConfig } | undefined;
  let synth: { modelName: string; route: ModelRouteConfig } | undefined;

  for (const [targetName, cfg] of entries) {
    // Use the full routing chain so a composite / schedule / fusion target
    // resolves to a leaf model's route. Cycle detection happens inside
    // getModelRouteConfig.
    const route = getModelRouteConfig(targetName, proxyConfig, nextVisited);
    const resolvedRoute = { ...route, modelAlias: route.modelAlias || targetName };

    if (cfg.role === 'judge') {
      judge = { modelName: targetName, route: resolvedRoute };
    } else if (cfg.role === 'synth') {
      synth = { modelName: targetName, route: resolvedRoute };
    } else {
      // role === 'panel', or fusion > 0 with no role, or no role/fusion (treated as panel in fusion mode)
      panel.push({ modelName: targetName, route: resolvedRoute });
    }
  }

  if (panel.length === 0) return undefined;

  // Defaults: synth falls back to judge, then first panel
  if (!synth) {
    synth = judge ?? panel[0];
  }

  const rawOpts = compositeConfig.fusion_options as FusionOptions | undefined;
  const options: Required<FusionOptions> = {
    min_panel: rawOpts?.min_panel ?? 1,
    panel_timeout_ms: rawOpts?.panel_timeout_ms ?? 60000,
    judge_required: rawOpts?.judge_required ?? false,
    expose_metadata: rawOpts?.expose_metadata ?? true,
    max_concurrent: rawOpts?.max_concurrent ?? panel.length,
  };

  return { alias: modelName, panel, judge, synth, options };
}

export function resolveCoordinatorPlan(
  modelName: string,
  proxyConfig: ProxyConfig,
  visited: Set<string> = new Set(),
): CoordinatorPlan | undefined {
  const compositeConfig = proxyConfig.composite?.[modelName];
  if (!compositeConfig) return undefined;

  const entries = getCompositeTargetEntries(compositeConfig);
  const coordEntries = entries.filter(([, cfg]) => typeof cfg.coord === 'number' && cfg.coord > 0);
  if (coordEntries.length === 0) return undefined;

  const plannerEntries = coordEntries.filter(([, cfg]) => cfg.role === 'planner');
  const executorEntries = coordEntries.filter(([, cfg]) => cfg.role === 'executor');

  if (plannerEntries.length === 0) throw new Error(`Coordinator alias "${modelName}" is missing a target with role = "planner"`);
  if (executorEntries.length === 0) throw new Error(`Coordinator alias "${modelName}" is missing a target with role = "executor"`);
  if (plannerEntries.length > 1) throw new Error(`Coordinator alias "${modelName}" has multiple planner targets; only one is allowed`);
  if (executorEntries.length > 1) throw new Error(`Coordinator alias "${modelName}" has multiple executor targets; only one is allowed`);

  // Check for coord+fusion conflict
  const hasFusion = entries.some(([, cfg]) =>
    cfg.role === 'panel' || cfg.role === 'judge' || cfg.role === 'synth' ||
    (typeof cfg.fusion === 'number' && cfg.fusion > 0)
  );
  if (hasFusion) throw new Error(`Coordinator alias "${modelName}" mixes coord and fusion entries; these modes are incompatible`);

  const nextVisited = new Set(visited);
  nextVisited.add(modelName);

  const [plannerName] = plannerEntries[0];
  const [executorName] = executorEntries[0];

  const plannerRoute = getModelRouteConfig(plannerName, proxyConfig, nextVisited);
  const executorRoute = getModelRouteConfig(executorName, proxyConfig, nextVisited);

  // Warn if planner and executor resolve to the same upstream (coordinator is a no-op)
  if (
    plannerRoute.targetUrl === executorRoute.targetUrl &&
    (plannerRoute.modelAlias || plannerName) === (executorRoute.modelAlias || executorName)
  ) {
    console.warn(`[coordinator] alias="${modelName}" planner and executor resolve to the same model; hand-off will be a no-op`);
  }

  // Resolve triggerTools: absent → default; [] → null (any tool); list → Set
  const rawToolset = compositeConfig.toolset;
  const triggerTools: Set<string> | null =
    rawToolset === undefined ? new Set(COORDINATOR_DEFAULT_TRIGGER_TOOLS) :
    rawToolset.length === 0  ? null :
    new Set(rawToolset);

  return {
    alias: modelName,
    plannerName,
    plannerRoute: { ...plannerRoute, modelAlias: plannerRoute.modelAlias || plannerName },
    executorName,
    executorRoute: { ...executorRoute, modelAlias: executorRoute.modelAlias || executorName },
    triggerTools,
  };
}

export function isScheduleAlias(modelName: string, proxyConfig: ProxyConfig): boolean {
  return !!proxyConfig.schedule?.[modelName];
}

function windowMatches(window: ScheduleWindow, hour: number, day: number): boolean {
  const from = window.from ?? 0;
  const to = window.to ?? 24;
  if (!(hour >= from && hour < to)) {
    return false;
  }

  const days = window.days;
  if (days === undefined) {
    return true;
  }
  if (days === 'weekday') {
    return day >= 1 && day <= 5;
  }
  if (days === 'weekend') {
    return day === 0 || day === 6;
  }
  if (Array.isArray(days)) {
    const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const todayName = dayNames[day];
    return days.some((d) => typeof d === 'string' && d.toLowerCase().slice(0, 3) === todayName);
  }
  return true;
}

/**
 * Resolve a schedule alias to the concrete target alias/model name that should
 * serve "now" (server-local time). Returns undefined if `modelName` is not a
 * schedule alias, or if no window matched and no fallback (empty-window) target
 * is configured — callers should fall through to normal/default routing.
 */
export function resolveScheduleTarget(
  modelName: string,
  proxyConfig: ProxyConfig,
  now: Date = new Date()
): string | undefined {
  const scheduleConfig = proxyConfig.schedule?.[modelName];
  if (!scheduleConfig) {
    return undefined;
  }

  const hour = now.getHours();
  const day = now.getDay();
  let fallback: string | undefined;

  for (const [target, windows] of Object.entries(scheduleConfig)) {
    if (!windows || windows.length === 0) {
      if (fallback === undefined) {
        fallback = target;
      }
      continue;
    }
    if (windows.some((w) => windowMatches(w, hour, day))) {
      return target;
    }
  }

  return fallback;
}

export function getModelRouteConfig(
  modelName: string,
  proxyConfig: ProxyConfig,
  visited: Set<string> = new Set(),
): ModelRouteConfig {
  if (!proxyConfig.models) {
    return getDefaultModelRoute(proxyConfig);
  }

  // Schedule resolves to another alias name (single hop; if the resolved name
  // is itself a schedule alias it is treated as a literal name, not re-resolved).
  const scheduledTarget = resolveScheduleTarget(modelName, proxyConfig);
  const effectiveName = scheduledTarget ?? modelName;

  // Cycle detection: if we're already in the middle of expanding `effectiveName`,
  // throwing is better than recursing forever. The chain includes every
  // composite / fusion alias currently on the recursion stack.
  if (visited.has(effectiveName)) {
    const chain = [...visited, effectiveName].join(' → ');
    throw new Error(
      `Routing cycle detected: ${chain}. Composite aliases cannot reference each other in a cycle — rename or restructure the involved aliases.`,
    );
  }

  const compositeRoute = resolveCompositeModelRoute(effectiveName, proxyConfig, visited);
  if (compositeRoute) {
    return compositeRoute.route;
  }

  const directRoute = resolveModelRouteFromConfig(effectiveName, proxyConfig);
  if (directRoute) {
    return directRoute;
  }

  return getDefaultModelRoute(proxyConfig);
}

/**
 * Parse API key from config (handles "x-api-key: sk-..." format)
 */
function parseApiKey(apiKey: string | undefined): string | undefined {
  if (!apiKey) return undefined;

  // Parse API key if it contains header format (e.g., "x-api-key: sk-...")
  if (apiKey.includes(':')) {
    const parts = apiKey.split(':');
    if (parts.length >= 2) {
      // Extract the key part after the colon, trim whitespace
      return parts.slice(1).join(':').trim();
    }
  }

  return apiKey;
}

function normalizeUpstreamThresholdValue(key: string, rawValue: string | number): string | number {
  if (key !== 'budget_to_effort_low' && key !== 'budget_to_effort_medium' && key !== 'budget_to_effort_high') {
    return rawValue;
  }

  if (typeof rawValue === 'number') {
    return rawValue;
  }

  const numericMatch = rawValue.match(/-?\d+/);
  if (!numericMatch) {
    return rawValue;
  }

  const parsed = Number(numericMatch[0]);
  return Number.isNaN(parsed) ? rawValue : parsed;
}

function parseCompositeTargetConfig(value: string): CompositeTargetConfig {
  const config: CompositeTargetConfig = {};
  const cleaned = value.replace(/[{}]/g, '');
  const fields = cleaned.split(',');

  for (const field of fields) {
    const trimmed = field.trim().replace(/^,/, '').replace(/,$/, '');
    if (!trimmed) {
      continue;
    }

    const match = trimmed.match(/^"?([^"=]+)"?\s*[=:]\s*(.+)$/);
    if (!match) {
      continue;
    }

    const key = match[1].trim().replace(/^"|"$/g, '');
    const rawValue = match[2].trim().replace(/,$/, '');

    if (key === 'share') {
      const numeric = Number(rawValue);
      if (!Number.isNaN(numeric) && numeric >= 0) {
        (config as any).share = numeric;
      } else if (rawValue !== '') {
        (config as any)._invalidShare = true;
      }
      continue;
    }

    if (key === 'fallback') {
      const numeric = Number(rawValue);
      if (!Number.isNaN(numeric) && numeric >= 0) {
        (config as any).fallback = numeric;
      } else if (rawValue !== '') {
        (config as any)._invalidFallback = true;
      }
      continue;
    }

    if (key === 'primary') {
      if (rawValue === 'true') {
        config.primary = true;
      } else if (rawValue === 'false') {
        config.primary = false;
      } else {
        (config as any)._invalidPrimary = true;
      }
      continue;
    }

    if (key === 'fusion') {
      const numeric = Number(rawValue);
      if (!Number.isNaN(numeric) && numeric >= 0) {
        (config as any).fusion = numeric;
      } else if (rawValue !== '') {
        (config as any)._invalidFusion = true;
      }
      continue;
    }

    if (key === 'coord') {
      const numeric = Number(rawValue);
      if (!Number.isNaN(numeric) && numeric >= 0) {
        (config as any).coord = numeric;
      } else if (rawValue !== '') {
        (config as any)._invalidCoord = true;
      }
      continue;
    }

    if (key === 'role') {
      const v = rawValue.replace(/^"|"$/g, '');
      if (v === 'panel' || v === 'judge' || v === 'synth' || v === 'planner' || v === 'executor') {
        (config as any).role = v;
      } else {
        (config as any)._invalidRole = true;
      }
      continue;
    }
  }

  return config;
}

// ---------------------------------------------------------------------------
// Transform parsing helpers
// ---------------------------------------------------------------------------

type TransformHookSlot = NonNullable<TransformSet['before_upstream']>;
type HookKey = 'request_ingress' | 'before_conversion' | 'before_upstream' | 'after_upstream' | 'response_egress';
// HOOK_KEYS includes legacy aliases so the TOML parser accepts them; normalizeHookAlias() maps them to canonical keys before use.
const HOOK_KEYS = new Set<string>(['request_ingress', 'before_conversion', 'before_upstream', 'after_upstream', 'response_egress', 'endpoint_readin', 'endpoint_writeout']);

/**
 * Parse a TOML array of quoted strings into a string[].
 * Input example: `["a", "b"]` → already split by the parser into elements.
 * Here `elements` is already split by the array parser.
 */
function parseTransformArrayField(set: TransformSet, cleanKey: string, elements: string[]): void {
  // cleanKey may be "builtins", "before_upstream.builtins", "request_ingress.ops", etc.
  const dotIdx = cleanKey.indexOf('.');
  if (dotIdx === -1) {
    // top-level (no hook scope): treat "builtins" as applying to all hooks isn't supported;
    // only "schema" is valid at top level (handled in string branch). Ignore unknowns.
    return;
  }
  const rawHook = cleanKey.slice(0, dotIdx);
  const fieldPart = cleanKey.slice(dotIdx + 1);
  if (!HOOK_KEYS.has(rawHook)) return;
  const hookPart = normalizeHookAlias(rawHook) as HookKey;

  if (!set[hookPart]) set[hookPart] = {} as TransformHookSlot;
  const slot = set[hookPart] as TransformHookSlot;

  if (fieldPart === 'builtins') {
    slot.builtins = elements as BuiltinName[];
  }
  // ops and headers are complex objects — handled by the inline-object branch below
}

/**
 * Parse a hook-scoped ops array from an inline TOML array of inline tables.
 * Input: `[{op="rename",path="max_tokens",to="max_completion_tokens"}]`
 * Returns parsed TransformOp[].
 */
export function parseTransformOpsInline(raw: string): TransformOp[] {
  const ops: TransformOp[] = [];
  // Strip outer [ ]
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (!inner) return ops;

  // Split on top-level commas between } and {
  const tableStrs: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of inner) {
    if (ch === '{') { depth++; cur += ch; }
    else if (ch === '}') { depth--; cur += ch; if (depth === 0) { tableStrs.push(cur.trim()); cur = ''; } }
    else if (ch === ',' && depth === 0) { /* separator between tables */ }
    else { cur += ch; }
  }

  for (const tableStr of tableStrs) {
    const body = tableStr.replace(/^\{/, '').replace(/\}$/, '').trim();
    const fields: Record<string, string> = {};
    // Parse key = "value" pairs (values always quoted in our schema)
    for (const m of body.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) {
      fields[m[1]] = m[2];
    }
    // Also handle null value: to = null
    const nullMatch = body.match(/\bto\s*=\s*null\b/);
    const toIsNull = nullMatch !== null;

    const op = fields['op'];
    const path = fields['path'];
    if (!op || !path) continue;

    if (op === 'rename' && fields['to']) {
      ops.push({ op: 'rename', path, to: fields['to'] });
    } else if (op === 'set' && 'value' in fields) {
      ops.push({ op: 'set', path, value: fields['value'] });
    } else if (op === 'default' && 'value' in fields) {
      ops.push({ op: 'default', path, value: fields['value'] });
    } else if (op === 'remove') {
      ops.push({ op: 'remove', path });
    } else if (op === 'map_value') {
      const from = fields['from'] ?? '';
      const to: unknown = toIsNull ? null : (fields['to'] ?? '');
      const when_sibling = fields['when_sibling'];
      ops.push({ op: 'map_value', path, from, to, ...(when_sibling ? { when_sibling } : {}) });
    }
  }
  return ops;
}

// ---------------------------------------------------------------------------

function parseCompositeModelConfig(rawValue: string): CompositeModelConfig {
  const config: CompositeModelConfig = {};
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return config;
  }

  const inner = trimmed.slice(1, -1);
  const entries: string[] = [];
  let current = '';
  let depth = 0;
  let inQuotes = false;

  for (let i = 0; i < inner.length; i++) {
    const char = inner[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if (!inQuotes) {
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth -= 1;
      } else if (char === ',' && depth === 0) {
        if (current.trim()) {
          entries.push(current.trim());
        }
        current = '';
        continue;
      }
    }

    current += char;
  }

  if (current.trim()) {
    entries.push(current.trim());
  }

  for (const entry of entries) {
    const match = entry.match(/^"?([^"=]+)"?\s*[=:]\s*(\{.*\})$/) || entry.match(/^"([^"]+)"\s*[=:]\s*(\{.*\})$/);
    if (match) {
      if (match[1].trim() === 'fusion_options') {
        // Parse fusion_options object: {min_panel, panel_timeout_ms, judge_required, expose_metadata, max_concurrent}
        try {
          const inner = match[2].trim().slice(1, -1);
          const opts: FusionOptions = {};
          const fields: string[] = [];
          let cur = ''; let d = 0; let iq = false;
          for (let i = 0; i < inner.length; i++) {
            const c = inner[i];
            if (c === '"') { iq = !iq; cur += c; continue; }
            if (!iq) { if (c === '{') d++; else if (c === '}') d--; else if (c === ',' && d === 0) { if (cur.trim()) fields.push(cur.trim()); cur = ''; continue; } }
            cur += c;
          }
          if (cur.trim()) fields.push(cur.trim());
          for (const f of fields) {
            const kv = f.match(/^"?(\w+)"?\s*[=:]\s*(.+)$/);
            if (!kv) continue;
            const k = kv[1]; const rv = kv[2].trim().replace(/,$/, '').replace(/^"|"$/g, '');
            if (k === 'min_panel' || k === 'panel_timeout_ms' || k === 'max_concurrent') {
              const n = Number(rv); if (Number.isFinite(n) && n >= 0) (opts as any)[k] = n;
            } else if (k === 'judge_required' || k === 'expose_metadata') {
              if (rv === 'true') (opts as any)[k] = true;
              else if (rv === 'false') (opts as any)[k] = false;
            }
          }
          config.fusion_options = opts;
        } catch { /* ignore malformed fusion_options */ }
      } else if (match[1].trim() === 'token_limit') {
        // Parse the nested token_limit object: {num = ..., duration = "..."} or {"num": ..., "duration": "..."}
        const inner = match[2].trim().slice(1, -1);
        const fields: string[] = [];
        let current = '';
        let depth = 0;
        let inQuotes = false;
        // Quote-aware split by comma (handles both JSON-style {"num": 50000} and TOML-style {num = 50000})
        for (let i = 0; i < inner.length; i++) {
          const char = inner[i];
          if (char === '"') { inQuotes = !inQuotes; current += char; continue; }
          if (!inQuotes) {
            if (char === '{') { depth += 1; } else if (char === '}') { depth -= 1; } else if (char === ',' && depth === 0) {
              if (current.trim()) fields.push(current.trim());
              current = ''; continue;
            }
          }
          current += char;
        }
        if (current.trim()) fields.push(current.trim());
        let num: number | undefined;
        let duration: string | undefined;
        for (const field of fields) {
          // Support both JSON-style "num": 50000 and TOML-style num = 50000
          const numMatch = field.match(/^"?num"?\s*[=:]\s*([\d.]+)/);
          if (numMatch) { const n = Number(numMatch[1]); if (Number.isFinite(n) && n >= 0) num = n; }
          // Support both JSON-style "duration": "1d" and TOML-style duration = "1d"
          const durMatch = field.match(/^"?duration"?\s*[=:]\s*"([^"]+)"/);
          if (durMatch) { duration = durMatch[1]; }
        }
        if (num !== undefined && duration !== undefined && ['1h', '1d', '1w', '1m'].includes(duration)) {
          config.token_limit = { num, duration: duration as TokenLimitDuration };
        } else {
          (config as any)._invalidLimit = true;
        }
      } else {
        config[match[1].trim()] = parseCompositeTargetConfig(match[2]);
      }
      continue;
    }

    // Parse toolset = ["Tool1", "Tool2"] (coordinator trigger tools)
    const toolsetMatch = entry.match(/^"?toolset"?\s*[=:]\s*(\[.*\])$/);
    if (toolsetMatch) {
      const arr = toolsetMatch[1].trim();
      // Extract quoted strings from the array
      const items: string[] = [];
      for (const m of arr.matchAll(/"([^"]+)"/g)) {
        items.push(m[1]);
      }
      config.toolset = items;
      continue;
    }

    // Backwards compatibility: parse old "total_token_limit" as number
    const limitMatch = entry.match(/^"?(total_token_limit)"?\s*[=:]\s*(.+)$/);
    if (limitMatch) {
      const numeric = Number(limitMatch[2].trim().replace(/,$/, ''));
      if (!Number.isNaN(numeric) && numeric >= 0) {
        // Treat as token_limit with a synthetic duration (stored as-is for migration)
        (config as any).token_limit = { num: numeric, duration: '1m' as TokenLimitDuration };
      } else {
        (config as any)._invalidLimit = true;
      }
    }
  }

  return config;
}

/**
 * Split a string on top-level commas, respecting quotes and {}/[] nesting depth.
 * Used for both composite-style and schedule-style inline structures.
 */
function splitTopLevel(input: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }

    if (!inQuotes) {
      if (char === '{' || char === '[') {
        depth += 1;
      } else if (char === '}' || char === ']') {
        depth -= 1;
      } else if (char === ',' && depth === 0) {
        if (current.trim()) {
          parts.push(current.trim());
        }
        current = '';
        continue;
      }
    }

    current += char;
  }

  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts;
}

function parseScheduleWindow(value: string): ScheduleWindow {
  const window: ScheduleWindow = {};
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return window;
  }

  const inner = trimmed.slice(1, -1);
  const fields = splitTopLevel(inner);

  for (const field of fields) {
    const match = field.match(/^"?(\w+)"?\s*[=:]\s*(.+)$/);
    if (!match) continue;
    const key = match[1];
    const rawValue = match[2].trim().replace(/,$/, '');

    if (key === 'from' || key === 'to') {
      const numeric = Number(rawValue);
      if (Number.isFinite(numeric) && numeric >= 0 && numeric <= 24) {
        window[key] = numeric;
      }
      continue;
    }

    if (key === 'days') {
      if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
        const arrayInner = rawValue.slice(1, -1);
        const dayValues = splitTopLevel(arrayInner).map((d) => d.trim().replace(/^"|"$/g, ''));
        window.days = dayValues;
      } else {
        const v = rawValue.replace(/^"|"$/g, '').trim().toLowerCase();
        if (v === 'weekday' || v === 'weekdays') {
          window.days = 'weekday';
        } else if (v === 'weekend' || v === 'weekends') {
          window.days = 'weekend';
        }
        // else: leave window.days unset (everyday)
      }
      continue;
    }
  }

  return window;
}

/**
 * Parse a `[schedule]` alias value: an inline table mapping each target name
 * to an array of window inline-tables, e.g.
 * {"maxplan" = [{from=9,to=12}], "code-small" = [{from=0,to=9,days="weekday"}], "fallback" = []}
 */
function parseScheduleConfig(rawValue: string): ScheduleConfig {
  const config: ScheduleConfig = {};
  const trimmed = rawValue.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return config;
  }

  const inner = trimmed.slice(1, -1);
  const entries = splitTopLevel(inner);

  for (const entry of entries) {
    const match = entry.match(/^"?([^"=]+)"?\s*[=:]\s*(\[.*\])$/);
    if (!match) continue;

    const targetName = match[1].trim().replace(/^"|"$/g, '');
    const arrayContent = match[2].trim();
    const arrayInner = arrayContent.slice(1, -1);
    const windowEntries = splitTopLevel(arrayInner);
    const windows = windowEntries
      .filter((w) => w.trim().startsWith('{'))
      .map((w) => parseScheduleWindow(w));

    config[targetName] = windows;
  }

  return config;
}

function quoteTomlString(value: string): string {
  return JSON.stringify(value);
}

/** Quote a TOML key if it contains characters outside the bare-key charset [A-Za-z0-9_-]. */
function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function serializeTomlValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => serializeTomlValue(item)).join(', ')}]`;
  }

  if (typeof value === 'string') {
    return quoteTomlString(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return quoteTomlString(String(value));
}

function serializeTomlSection(section: Record<string, unknown>): string[] {
  return Object.entries(section).map(([key, value]) => `${tomlKey(key)} = ${serializeTomlValue(value)}`);
}

/**
 * Serialize a model entry as the shortest valid TOML inline table.
 * - `{}` when target equals the alias key and all overrides (base_url, api_key, mode) are empty
 * - `{target = "..."}` when only the target differs from the alias key
 * - `{target = "...", base_url = "...", api_key = "...", mode = "..."}` when any override is set
 * The alias key is passed so target-equals-alias can be omitted entirely.
 */
function serializeModelEntry(entry: string[], aliasKey: string): string {
  const [target = '', base_url = '', api_key = '', mode = '', transforms = '', max_tokens = ''] = entry;
  const hasOverrides = base_url !== '' || api_key !== '' || mode !== '';
  const targetIsAlias = target === aliasKey || target === '';
  const transformsSuffix = transforms ? `, transforms = ${JSON.stringify(transforms)}` : '';
  // max_tokens is a bare number (unquoted); appended last to keep index 5.
  const maxTokensSuffix = max_tokens !== '' ? `, max_tokens = ${max_tokens}` : '';
  const suffix = transformsSuffix + maxTokensSuffix;
  if (!hasOverrides && targetIsAlias) {
    return suffix ? `{${suffix.slice(2)}}` : `{}`;
  }
  if (!hasOverrides) {
    return `{target = ${JSON.stringify(target)}${suffix}}`;
  }
  if (targetIsAlias) {
    if (mode !== '') {
      return `{base_url = ${JSON.stringify(base_url)}, api_key = ${JSON.stringify(api_key)}, mode = ${JSON.stringify(mode)}${suffix}}`;
    }
    return `{base_url = ${JSON.stringify(base_url)}, api_key = ${JSON.stringify(api_key)}${suffix}}`;
  }
  if (mode !== '') {
    return `{target = ${JSON.stringify(target)}, base_url = ${JSON.stringify(base_url)}, api_key = ${JSON.stringify(api_key)}, mode = ${JSON.stringify(mode)}${suffix}}`;
  }
  return `{target = ${JSON.stringify(target)}, base_url = ${JSON.stringify(base_url)}, api_key = ${JSON.stringify(api_key)}${suffix}}`;
}

/** Serialize a model category section, emitting model entries as inline tables. */
function serializeModelCategorySection(section: Record<string, unknown>): string[] {
  const reserved = new Set(['upstream_mode', 'base_url', 'api_key']);
  return Object.entries(section).map(([key, value]) => {
    if (!reserved.has(key) && Array.isArray(value)) {
      return `${tomlKey(key)} = ${serializeModelEntry(value as string[], key)}`;
    }
    return `${tomlKey(key)} = ${serializeTomlValue(value)}`;
  });
}

function serializeCompositeTargetConfig(config: CompositeTargetConfig): string {
  const fields: string[] = [];
  if (config.share !== undefined) {
    fields.push(`share = ${config.share}`);
  }
  if (config.primary !== undefined) {
    fields.push(`primary = ${config.primary}`);
  }
  if (config.fallback !== undefined) {
    fields.push(`fallback = ${config.fallback}`);
  }
  if (config.fusion !== undefined) {
    fields.push(`fusion = ${config.fusion}`);
  }
  if (config.coord !== undefined) {
    fields.push(`coord = ${config.coord}`);
  }
  if (config.role !== undefined) {
    fields.push(`role = "${config.role}"`);
  }
  return `{${fields.join(', ')}}`;
}

function serializeFusionOptions(opts: FusionOptions): string {
  const fields: string[] = [];
  if (opts.min_panel !== undefined) fields.push(`min_panel = ${opts.min_panel}`);
  if (opts.panel_timeout_ms !== undefined) fields.push(`panel_timeout_ms = ${opts.panel_timeout_ms}`);
  if (opts.judge_required !== undefined) fields.push(`judge_required = ${opts.judge_required}`);
  if (opts.expose_metadata !== undefined) fields.push(`expose_metadata = ${opts.expose_metadata}`);
  if (opts.max_concurrent !== undefined) fields.push(`max_concurrent = ${opts.max_concurrent}`);
  return `{${fields.join(', ')}}`;
}

function serializeCompositeModelConfig(config: CompositeModelConfig): string {
  const entries: string[] = [];
  if (config.token_limit && typeof config.token_limit === 'object') {
    entries.push(`token_limit = {num = ${config.token_limit.num}, duration = ${JSON.stringify(config.token_limit.duration)}}`);
  }
  if (config.fusion_options && typeof config.fusion_options === 'object') {
    entries.push(`fusion_options = ${serializeFusionOptions(config.fusion_options as FusionOptions)}`);
  }
  if (Array.isArray(config.toolset)) {
    entries.push(`toolset = [${config.toolset.map(t => JSON.stringify(t)).join(', ')}]`);
  }
  for (const [modelName, targetConfig] of getCompositeTargetEntries(config)) {
    const serializedTarget = serializeCompositeTargetConfig((targetConfig || {}) as CompositeTargetConfig);
    entries.push(`${JSON.stringify(modelName)} = ${serializedTarget}`);
  }
  return `{${entries.join(', ')}}`;
}

function serializeScheduleWindow(window: ScheduleWindow): string {
  const fields: string[] = [];
  if (window.from !== undefined) {
    fields.push(`from = ${window.from}`);
  }
  if (window.to !== undefined) {
    fields.push(`to = ${window.to}`);
  }
  if (window.days !== undefined) {
    if (Array.isArray(window.days)) {
      fields.push(`days = [${window.days.map((d) => JSON.stringify(d)).join(', ')}]`);
    } else {
      fields.push(`days = ${JSON.stringify(window.days)}`);
    }
  }
  return `{${fields.join(', ')}}`;
}

function serializeScheduleConfig(config: ScheduleConfig): string {
  const entries = Object.entries(config).map(([target, windows]) => {
    const serializedWindows = (windows || []).map((w) => serializeScheduleWindow(w));
    return `${JSON.stringify(target)} = [${serializedWindows.join(', ')}]`;
  });
  return `{${entries.join(', ')}}`;
}

/**
 * Config validation
 */
export interface ConfigValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  errors: ConfigValidationError[];
  warnings: ConfigValidationError[];
  valid: boolean;
}

/**
 * Returns the set of model names defined under [models.*] — i.e. concrete
 * keys declared in any model category, excluding reserved category-level
 * keys (upstream_mode/base_url/api_key) and internal `_`-prefixed markers.
 *
 * Used to detect name collisions with alias names: a composite/fusion/
 * schedule alias whose name is also a model name makes routing ambiguous,
 * so the loader strips those aliases (fatal) and add-alias helpers refuse
 * to create them.
 */
export function getModelNamesInConfig(config: ProxyConfig): Set<string> {
  const reservedKeys = new Set(['upstream_mode', 'base_url', 'api_key']);
  const names = new Set<string>();
  if (!config.models) return names;
  for (const [categoryName, categoryConfig] of Object.entries(config.models)) {
    // models.list is a special list-shaped entry, not a category with model names
    if (categoryName === 'list' || Array.isArray(categoryConfig)) continue;
    const typedCategory = categoryConfig as Record<string, unknown>;
    for (const key of Object.keys(typedCategory)) {
      if (reservedKeys.has(key)) continue;
      if (key.startsWith('_')) continue; // internal markers (e.g. _comment, _invalid)
      names.add(key);
    }
  }
  return names;
}

/**
 * Returns alias names (composite or schedule) whose name collides with a
 * model name under [models.*]. Used by the loader to strip those aliases
 * from the in-memory config and by validateProxyConfig to emit fatal
 * errors that surface in the dashboard status bar / TUI message line.
 */
export function findAliasNameConflicts(config: ProxyConfig): { composite: string[]; schedule: string[] } {
  const modelNames = getModelNamesInConfig(config);
  const composite: string[] = [];
  const schedule: string[] = [];
  if (modelNames.size === 0) return { composite, schedule };
  if (config.composite) {
    for (const alias of Object.keys(config.composite)) {
      if (modelNames.has(alias)) composite.push(alias);
    }
  }
  if (config.schedule) {
    for (const alias of Object.keys(config.schedule)) {
      if (modelNames.has(alias)) schedule.push(alias);
    }
  }
  return { composite, schedule };
}

/**
 * Returns a copy of `config` with conflicting composite/schedule aliases
 * removed. The on-disk file is NOT modified — this is purely a runtime
 * filter so the proxy refuses to route on an alias whose name is also a
 * concrete model. `_validationErrors` / `_validationWarnings` (if present)
 * are copied to the returned object so the dashboard status bar still
 * shows the original fatal errors after stripping.
 */
export function stripConflictingAliases(
  config: ProxyConfig,
): { config: ProxyConfig; stripped: { composite: string[]; schedule: string[] } } {
  const stripped = findAliasNameConflicts(config);
  if (stripped.composite.length === 0 && stripped.schedule.length === 0) {
    return { config, stripped };
  }
  const next: ProxyConfig = { ...config };
  if (stripped.composite.length > 0 && config.composite) {
    next.composite = { ...config.composite };
    for (const alias of stripped.composite) delete next.composite[alias];
    if (Object.keys(next.composite).length === 0) delete next.composite;
  }
  if (stripped.schedule.length > 0 && config.schedule) {
    next.schedule = { ...config.schedule };
    for (const alias of stripped.schedule) delete next.schedule[alias];
    if (Object.keys(next.schedule).length === 0) delete next.schedule;
  }
  // Carry over validation metadata so the dashboard status bar / TUI keep
  // showing the original fatal errors even after the conflicting aliases
  // are stripped from the active config.
  const meta = config as unknown as {
    _validationErrors?: ConfigValidationError[];
    _validationWarnings?: ConfigValidationError[];
  };
  if (meta._validationErrors) {
    (next as unknown as { _validationErrors?: ConfigValidationError[] })._validationErrors = meta._validationErrors;
  }
  if (meta._validationWarnings) {
    (next as unknown as { _validationWarnings?: ConfigValidationError[] })._validationWarnings = meta._validationWarnings;
  }
  return { config: next, stripped };
}

/**
 * Returns a map of composite alias → self-referencing target name for any
 * alias that lists itself as one of its own targets (e.g.
 * "for-claw2" = {"for-claw2" = {share = 1}, ...}). Such self-references
 * are always wrong: they make the routing step refer back to the alias
 * itself. Surfaced via:
 *   - console.error in loadProxyConfig / loadProxyConfigFromPath (fatal)
 *   - validateProxyConfig (dashboard status bar / TUI message line)
 *   - upsertCompositeTarget + applyDashboardConfigUpdate (rejects save)
 */
export function findSelfReferencingCompositeTargets(config: ProxyConfig): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!config.composite) return result;
  for (const [alias, targets] of Object.entries(config.composite)) {
    if (!targets || typeof targets !== 'object' || Array.isArray(targets)) continue;
    if (Object.prototype.hasOwnProperty.call(targets, alias)) {
      result[alias] = [alias];
    }
  }
  return result;
}

/**
 * Returns a copy of `config` with self-referencing composite targets removed
 * from in-memory config (the alias itself is preserved, only the bad target
 * entry is dropped). The on-disk file is NOT modified — this is a runtime
 * filter so the proxy refuses to route on a target that points back at its
 * own alias. The next config save will persist the cleaned-up form.
 */
export function stripSelfReferencingCompositeTargets(
  config: ProxyConfig,
): { config: ProxyConfig; stripped: Record<string, string[]> } {
  const stripped = findSelfReferencingCompositeTargets(config);
  if (Object.keys(stripped).length === 0) {
    return { config, stripped };
  }
  const next: ProxyConfig = { ...config };
  if (config.composite) {
    next.composite = { ...config.composite };
    for (const [alias, badTargets] of Object.entries(stripped)) {
      const existing = next.composite[alias];
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) continue;
      const nextTargets: Record<string, unknown> = { ...existing };
      for (const target of badTargets) delete nextTargets[target];
      next.composite[alias] = nextTargets as CompositeModelConfig;
    }
  }
  return { config: next, stripped };
}

export function validateProxyConfig(config: ProxyConfig): ValidationResult {
  const errors: ConfigValidationError[] = [];
  const warnings: ConfigValidationError[] = [];
  const reservedKeys = new Set(['upstream_mode', 'base_url', 'api_key']);

  if (config.models) {
    for (const [categoryName, categoryConfig] of Object.entries(config.models)) {
      if (categoryName === 'list' || Array.isArray(categoryConfig)) {
        continue;
      }
      const typedCategory = categoryConfig as Record<string, unknown>;
      const categoryBaseUrl = typeof typedCategory.base_url === 'string' ? typedCategory.base_url : undefined;

      for (const [key, value] of Object.entries(categoryConfig)) {
        if (reservedKeys.has(key)) continue;
        if (value === undefined) continue;

        if (!Array.isArray(value)) {
          errors.push({ path: `models.${categoryName}.${key}`, message: `must be [target, base_url, api_key]` });
          continue;
        }
        if (value.length === 1) {
          // 1 element = target only (base_url/api_key from category)
          const target = value[0] as unknown;
          if (typeof target !== 'string' || (target.trim() === '' && !String(target).includes('*'))) {
            errors.push({ path: `models.${categoryName}.${key}`, message: `target cannot be empty` });
          }
          if (!categoryBaseUrl) {
            errors.push({ path: `models.${categoryName}.${key}`, message: `base_url must be set in category when target is the only element` });
          }
          // api_key absence is fine — proxy uses the caller's auth header
        } else if (value.length === 3) {
          // 3 elements = target + optional overrides (empty = use category fallback)
          const target = value[0] as unknown;
          const baseUrl = value[1] as unknown;
          const apiKey = value[2] as unknown;

          if (typeof target !== 'string' || (target.trim() === '' && !String(target).includes('*'))) {
            errors.push({ path: `models.${categoryName}.${key}`, message: `target cannot be empty` });
          }
          if (typeof baseUrl !== 'string') {
            errors.push({ path: `models.${categoryName}.${key}`, message: `base_url must be a string` });
          } else if (baseUrl.trim() === '' && !categoryBaseUrl) {
            errors.push({ path: `models.${categoryName}.${key}`, message: `base_url is empty and not set in category` });
          }
          if (typeof apiKey !== 'string') {
            errors.push({ path: `models.${categoryName}.${key}`, message: `api_key must be a string` });
          }
          // Empty api_key is fine — proxy uses the caller's auth header
        } else if (value.length === 4) {
          // 4 elements = target + optional overrides + mode (empty = use category fallback)
          const target = value[0] as unknown;
          const baseUrl = value[1] as unknown;
          const apiKey = value[2] as unknown;
          const mode = value[3] as unknown;

          if (typeof target !== 'string' || (target.trim() === '' && !String(target).includes('*'))) {
            errors.push({ path: `models.${categoryName}.${key}`, message: `target cannot be empty` });
          }
          if (typeof baseUrl !== 'string') {
            errors.push({ path: `models.${categoryName}.${key}`, message: `base_url must be a string` });
          } else if (baseUrl.trim() === '' && !categoryBaseUrl) {
            errors.push({ path: `models.${categoryName}.${key}`, message: `base_url is empty and not set in category` });
          }
          if (typeof apiKey !== 'string') {
            errors.push({ path: `models.${categoryName}.${key}`, message: `api_key must be a string` });
          }
          // Empty api_key is fine — proxy uses the caller's auth header
          if (typeof mode !== 'string') {
            errors.push({ path: `models.${categoryName}.${key}`, message: `mode must be a string` });
          }
        } else if (value.length === 5 || value.length === 6) {
          // 5 elements = target + base_url + api_key + mode + transforms CSV
          // 6 elements = ... + per-entry max_tokens (bare number, index 5)
          const target = value[0] as unknown;
          const baseUrl = value[1] as unknown;
          const apiKey = value[2] as unknown;
          const mode = value[3] as unknown;
          const transformsCsv = value[4] as unknown;

          if (typeof target !== 'string' || (target.trim() === '' && !String(target).includes('*'))) {
            errors.push({ path: `models.${categoryName}.${key}`, message: `target cannot be empty` });
          }
          if (typeof baseUrl !== 'string') {
            errors.push({ path: `models.${categoryName}.${key}`, message: `base_url must be a string` });
          } else if (baseUrl.trim() === '' && !categoryBaseUrl) {
            errors.push({ path: `models.${categoryName}.${key}`, message: `base_url is empty and not set in category` });
          }
          if (typeof apiKey !== 'string') {
            errors.push({ path: `models.${categoryName}.${key}`, message: `api_key must be a string` });
          }
          // Empty api_key is fine — proxy uses the caller's auth header
          if (typeof mode !== 'string') {
            errors.push({ path: `models.${categoryName}.${key}`, message: `mode must be a string` });
          }
          if (typeof transformsCsv !== 'string') {
            errors.push({ path: `models.${categoryName}.${key}`, message: `transforms must be a comma-separated string` });
          }
          if (value.length === 6) {
            const maxTokens = value[5] as unknown;
            // max_tokens is a bare number (unquoted) in TOML, but tolerant of digit strings
            if (typeof maxTokens !== 'number' && !(typeof maxTokens === 'string' && /^\d+$/.test(maxTokens))) {
              errors.push({ path: `models.${categoryName}.${key}`, message: `max_tokens must be a number` });
            }
          }
        } else {
          errors.push({ path: `models.${categoryName}.${key}`, message: `must be [target] or [target, base_url, api_key] or [target, base_url, api_key, mode] or [target, base_url, api_key, mode, transforms] or [target, base_url, api_key, mode, transforms, max_tokens] (got ${value.length} elements)` });
        }
      }
    }
  }

  if (config.composite) {
    for (const [alias, targets] of Object.entries(config.composite)) {
      if (!targets || typeof targets !== 'object') {
        errors.push({ path: `composite.${alias}`, message: `invalid composite config` });
        continue;
      }
      if ('_invalidLimit' in (targets as Record<string, unknown>)) {
        errors.push({ path: `composite.${alias}.token_limit`, message: `token_limit must be {num: <number>, duration: "1h"|"1d"|"1w"|"1m"}` });
      }
      for (const [targetModel, targetValue] of Object.entries(targets)) {
        if (targetModel.startsWith('_')) continue; // skip internal markers
        if (targetModel === 'token_limit') continue; // validated separately above
        if (!targetValue || typeof targetValue !== 'object' || Array.isArray(targetValue)) {
          errors.push({ path: `composite.${alias}.${targetModel}`, message: `invalid target config` });
          continue;
        }
        const typedTarget = targetValue as Record<string, unknown>;
        if ('_invalidShare' in typedTarget) {
          errors.push({ path: `composite.${alias}.${targetModel}`, message: `share must be a number` });
        }
        // Self-reference: a composite alias listing itself as a target is
        // always wrong (and would be rejected by upsertCompositeTarget /
        // validateAndNormalizeComposite at save time). Surface the error
        // here so it shows up in the dashboard status bar / TUI message line
        // for any existing config that already contains this mistake.
        if (targetModel === alias) {
          errors.push({
            path: `composite.${alias}.${targetModel}`,
            message: `composite alias "${alias}" cannot list itself as a target — remove the self-reference`,
          });
        }
        if ('_invalidPrimary' in typedTarget) {
          errors.push({ path: `composite.${alias}.${targetModel}`, message: `primary must be boolean` });
        }
        if ('_invalidFallback' in typedTarget) {
          errors.push({ path: `composite.${alias}.${targetModel}`, message: `fallback must be a number` });
        }
      }
    }
  }

  if (config.schedule) {
    for (const [alias, scheduleConfig] of Object.entries(config.schedule)) {
      if (!scheduleConfig || typeof scheduleConfig !== 'object') {
        errors.push({ path: `schedule.${alias}`, message: `invalid schedule config` });
        continue;
      }
      let hasFallback = false;
      for (const [target, windows] of Object.entries(scheduleConfig)) {
        if (!Array.isArray(windows)) {
          errors.push({ path: `schedule.${alias}.${target}`, message: `must be an array of windows` });
          continue;
        }
        if (windows.length === 0) {
          hasFallback = true;
          continue;
        }
        for (let i = 0; i < windows.length; i++) {
          const window = windows[i];
          const windowPath = `schedule.${alias}.${target}[${i}]`;
          if (!window || typeof window !== 'object') {
            errors.push({ path: windowPath, message: `invalid window` });
            continue;
          }
          const from = window.from ?? 0;
          const to = window.to ?? 24;
          if (typeof from !== 'number' || from < 0 || from > 24) {
            errors.push({ path: windowPath, message: `from must be between 0 and 24` });
          }
          if (typeof to !== 'number' || to < 0 || to > 24) {
            errors.push({ path: windowPath, message: `to must be between 0 and 24` });
          }
          if (typeof from === 'number' && typeof to === 'number' && from >= to) {
            errors.push({ path: windowPath, message: `from must be less than to` });
          }
          if (window.days !== undefined) {
            if (Array.isArray(window.days)) {
              const validDays = new Set(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);
              for (const d of window.days) {
                if (typeof d !== 'string' || !validDays.has(d.toLowerCase().slice(0, 3))) {
                  errors.push({ path: windowPath, message: `invalid day name "${d}"` });
                }
              }
            } else if (window.days !== 'weekday' && window.days !== 'weekend') {
              errors.push({ path: windowPath, message: `days must be "weekday", "weekend", or an array of day names` });
            }
          }
          if (from === 0 && to === 24 && window.days === undefined) {
            hasFallback = true; // '{from = 0, to = 24}' equals to 'fallback'
          }
        }
      }
      if (!hasFallback && Object.keys(scheduleConfig).length > 0) {
        warnings.push({ path: `schedule.${alias}`, message: `no fallback target (empty window list) configured — requests outside all windows will fall through to default routing` });
      }
    }
  }

  // Reject same-name collisions between alias names (composite/fusion/schedule)
  // and any model name defined under [models.*]. A collision makes routing
  // ambiguous — the proxy cannot tell whether the caller meant the concrete
  // model entry or the alias. Surfaced via:
  //   - console.error in loadProxyConfig / parseSimpleToml (and via the
  //     load-time stripper `stripConflictingAliases` that REMOVES the
  //     conflicting alias from the in-memory config)
  //   - dashboard status bar via toDashboardConfigPayload.config_errors
  //   - TUI message line via _validationErrors read in src/tui.ts:refresh
  //   - PUT /dashboard/api/config 400 response (rejects save in handleDashboardPutConfig)
  const conflicts = findAliasNameConflicts(config);
  for (const alias of conflicts.composite) {
    errors.push({
      path: `composite.${alias}`,
      message: `alias name "${alias}" conflicts with a model defined under [models.*] — alias and model names must be unique (this alias will be skipped at load time)`,
    });
  }
  for (const alias of conflicts.schedule) {
    errors.push({
      path: `schedule.${alias}`,
      message: `alias name "${alias}" conflicts with a model defined under [models.*] — alias and model names must be unique (this alias will be skipped at load time)`,
    });
  }

  // Detect routing cycles among composite aliases. Try resolving each alias
  // through the full routing chain; a thrown cycle error means the alias (or
  // one of its transitive targets) forms a cycle. Reported as a fatal error so
  // it surfaces in the dashboard status bar and TUI message line.
  const seenCycles = new Set<string>();
  for (const alias of Object.keys(config.composite ?? {})) {
    try {
      getModelRouteConfig(alias, config, new Set());
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('Routing cycle detected') && !seenCycles.has(msg)) {
        seenCycles.add(msg);
        errors.push({ path: `composite.${alias}`, message: msg });
      }
    }
  }

  // Validate every base_url that will be used to build an upstream fetch URL.
  // An invalid URL (e.g. out-of-range port like "http://localhost:123456")
  // throws TypeError synchronously inside fetch() / new URL() at request time,
  // which previously surfaced as an opaque 500. Catch it here at load time so
  // the misconfiguration is visible in the dashboard status bar / TUI.
  validateBaseUrls(config, errors);

  return { errors, warnings, valid: errors.length === 0 };
}

/**
 * Validate every `base_url` value that ends up in a `targetUrl` passed to
 * `fetch()`. Mirrors the sources covered by `getAllowedHostsFromConfig`:
 *   - `[default_upstream].default_base_url`
 *   - `[models.*].base_url` (category level)
 *   - per-model `base_url` overrides (array element at index 1)
 *
 * Empty / whitespace-only values are skipped here — they fall back to the
 * category-level URL at request time, which is validated separately.
 */
function validateBaseUrls(config: ProxyConfig, errors: ConfigValidationError[]): void {
  const check = (url: string, path: string): void => {
    const trimmed = url.trim();
    if (trimmed === '') return;
    try {
      const parsed = new URL(trimmed);
      // sdk:// is a project-internal scheme rewritten to https:// at request
      // time by the SDK handler (see src/utils/sdk-handler.ts).
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'sdk:') {
        errors.push({ path, message: `base_url must use http, https, or sdk protocol, got: ${parsed.protocol}` });
      }
    } catch {
      errors.push({ path, message: `base_url is not a valid URL: ${trimmed}` });
    }
  };

  if (config.default_upstream?.default_base_url) {
    check(config.default_upstream.default_base_url, 'default_upstream.default_base_url');
  }

  if (config.models) {
    for (const [categoryName, categoryConfig] of Object.entries(config.models)) {
      if (categoryName === 'list' || Array.isArray(categoryConfig)) continue;
      const typedCategory = categoryConfig as Record<string, unknown>;
      if (typeof typedCategory.base_url === 'string') {
        check(typedCategory.base_url, `models.${categoryName}.base_url`);
      }
      for (const [key, value] of Object.entries(typedCategory)) {
        if (['upstream_mode', 'base_url', 'api_key'].includes(key)) continue;
        if (!Array.isArray(value) || value.length < 2) continue;
        if (typeof value[1] === 'string') {
          check(value[1], `models.${categoryName}.${key}.base_url`);
        }
      }
    }
  }
}

/**
 * Serialize a single TransformOp as a TOML inline table. Mirrors the syntax
 * accepted by parseTransformOpsInline (regex /(\w+)\s*=\s*"([^"]*)"/g plus a
 * `to = null` special case). Non-string `value`/`to`/`from` are coerced via
 * String() because the parser only reads quoted-string fields.
 */
function serializeTransformOp(op: TransformOp): string {
  switch (op.op) {
    case 'rename':
      return `{op = "rename", path = ${JSON.stringify(op.path)}, to = ${JSON.stringify(op.to)}}`;
    case 'set':
      return `{op = "set", path = ${JSON.stringify(op.path)}, value = ${JSON.stringify(op.value)}}`;
    case 'default':
      return `{op = "default", path = ${JSON.stringify(op.path)}, value = ${JSON.stringify(op.value)}}`;
    case 'remove':
      return `{op = "remove", path = ${JSON.stringify(op.path)}}`;
    case 'map_value': {
      const to = op.to === null ? 'null' : JSON.stringify(String(op.to));
      const tail = op.when_sibling ? `, when_sibling = ${JSON.stringify(op.when_sibling)}` : '';
      return `{op = "map_value", path = ${JSON.stringify(op.path)}, from = ${JSON.stringify(String(op.from))}, to = ${to}${tail}}`;
    }
  }
}

/**
 * Serialize one hook slot (e.g. before_upstream) as dotted-key TOML lines.
 * Emits ops / builtins / headers.set / headers.remove only when present and
 * non-empty, matching the parser's accepted dotted-key forms at lines 2736+.
 *
 * Note: headers.set / headers.remove are emitted when present even though
 * parseSimpleToml does not yet parse them back — the round-trip loss is
 * unchanged from today and documented in CHANGELOG.
 */
function serializeTransformHookSlot(slot: NonNullable<TransformSet['before_upstream']>, hookName: string): string[] {
  const out: string[] = [];
  if (slot.ops?.length) {
    out.push(`${hookName}.ops = [${slot.ops.map(serializeTransformOp).join(', ')}]`);
  }
  if (slot.builtins?.length) {
    out.push(`${hookName}.builtins = [${slot.builtins.map((b) => JSON.stringify(b)).join(', ')}]`);
  }
  if (slot.headers?.set) {
    const entries = Object.entries(slot.headers.set);
    if (entries.length) {
      out.push(`${hookName}.headers.set = {${entries.map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`).join(', ')}}`);
    }
  }
  if (slot.headers?.remove?.length) {
    out.push(`${hookName}.headers.remove = [${slot.headers.remove.map((h) => JSON.stringify(h)).join(', ')}]`);
  }
  return out;
}

/**
 * Serialize a [transforms.<name>] section. Hook order is fixed so output is
 * deterministic; matches the canonical HookKey order used throughout the file.
 */
function serializeTransformSet(set: TransformSet): string[] {
  const out: string[] = [];
  out.push(`schema = ${JSON.stringify(set.schema)}`);
  if (set.anthropic_beta_map) {
    const entries = Object.entries(set.anthropic_beta_map);
    if (entries.length) {
      // Parser convention: empty string value means "drop" (line 2706).
      out.push(`anthropic_beta_map = {${entries.map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v === null ? '' : v)}`).join(', ')}}`);
    }
  }
  const hookOrder: Array<'request_ingress' | 'before_conversion' | 'before_upstream' | 'after_upstream' | 'response_egress'> =
    ['request_ingress', 'before_conversion', 'before_upstream', 'after_upstream', 'response_egress'];
  for (const hook of hookOrder) {
    const slot = set[hook];
    if (slot) out.push(...serializeTransformHookSlot(slot, hook));
  }
  return out;
}

export function serializeProxyConfigToml(config: ProxyConfig): string {
  const lines: string[] = [];

  if (config.general) {
    lines.push('[general]');
    lines.push(...serializeTomlSection(config.general as Record<string, unknown>));
    lines.push('');
  }

  if (config.default_upstream) {
    lines.push('[default_upstream]');
    lines.push(...serializeTomlSection(config.default_upstream as Record<string, unknown>));
    lines.push('');
  }

  if (config.dashboard) {
    lines.push('[dashboard]');
    lines.push(...serializeTomlSection(config.dashboard as Record<string, unknown>));
    lines.push('');
  }

  if (config.remote?.authentication) {
    lines.push('[remote.authentication]');
    lines.push(...serializeTomlSection(config.remote.authentication as Record<string, unknown>));
    lines.push('');
  }

  if (config.remote?.recording) {
    lines.push('[remote.recording]');
    lines.push(...serializeTomlSection(config.remote.recording as Record<string, unknown>));
    lines.push('');
  }

  if (config.models) {
    for (const [categoryName, categoryConfig] of Object.entries(config.models)) {
      if (Array.isArray(categoryConfig)) {
        continue;
      }

      lines.push(`[models.${categoryName}]`);
      const { composite, ...categoryRest } = categoryConfig as Record<string, unknown>;
      lines.push(...serializeModelCategorySection(categoryRest));
      if (composite && typeof composite === 'object' && !Array.isArray(composite)) {
        lines.push(`composite = ${serializeCompositeModelConfig(composite as CompositeModelConfig)}`);
      }
      lines.push('');
    }
  }

  if (config.composite) {
    lines.push('[composite]');
    lines.push(...Object.entries(config.composite).map(([modelName, targetConfig]) => `${JSON.stringify(modelName)} = ${serializeCompositeModelConfig(targetConfig)}`));
    lines.push('');
  }

  if (config.schedule) {
    lines.push('[schedule]');
    lines.push(...Object.entries(config.schedule).map(([alias, scheduleConfig]) => `${JSON.stringify(alias)} = ${serializeScheduleConfig(scheduleConfig)}`));
    lines.push('');
  }

  if (config.defaults) {
    lines.push('[defaults]');
    lines.push(...serializeTomlSection(config.defaults as Record<string, unknown>));
    lines.push('');
  }

  if (config.transforms) {
    for (const [name, set] of Object.entries(config.transforms)) {
      lines.push(`[transforms.${name}]`);
      lines.push(...serializeTransformSet(set));
      lines.push('');
    }
  }

  if (config.transform_defaults) {
    const entries = Object.entries(config.transform_defaults);
    if (entries.length) {
      lines.push('[transform_defaults]');
      for (const [mode, names] of entries) {
        lines.push(`${tomlKey(mode)} = [${names.map((n) => JSON.stringify(n)).join(', ')}]`);
      }
      lines.push('');
    }
  }

  if (config.privacy_filter) {
    const pf = config.privacy_filter;
    lines.push('[privacy_filter]');
    if (pf.filter_mode !== undefined) lines.push(`filter_mode = ${JSON.stringify(pf.filter_mode)}`);
    if (pf.filter_url !== undefined) lines.push(`filter_url = ${JSON.stringify(pf.filter_url)}`);
    if (pf.timeout_ms !== undefined) lines.push(`timeout_ms = ${pf.timeout_ms}`);
    if (pf.max_chars !== undefined) lines.push(`max_chars = ${pf.max_chars}`);
    if (pf.entropy_threshold !== undefined) lines.push(`entropy_threshold = ${pf.entropy_threshold}`);
    if (pf.hash_min_len !== undefined) lines.push(`hash_min_len = ${pf.hash_min_len}`);
    if (pf.whitelist_add?.length) lines.push(`whitelist_add = [${pf.whitelist_add.map((s) => JSON.stringify(s)).join(', ')}]`);
    if (pf.whitelist_remove?.length) lines.push(`whitelist_remove = [${pf.whitelist_remove.map((s) => JSON.stringify(s)).join(', ')}]`);
    if (pf.whitelist_file !== undefined) lines.push(`whitelist_file = ${JSON.stringify(pf.whitelist_file)}`);
    lines.push('');
  }

  if (config.fetch) {
    const fe = config.fetch;
    lines.push('[fetch]');
    if (fe.image_encode !== undefined) lines.push(`image_encode = ${JSON.stringify(fe.image_encode)}`);
    if (fe.timeout_ms !== undefined) lines.push(`timeout_ms = ${fe.timeout_ms}`);
    lines.push('');
  }

  return lines.join('\n').replace(/\n$/, '');
}

export function getConfiguredModelIds(config: ProxyConfig): string[] {
  const ids = new Set<string>();
  const reservedKeys = new Set(['upstream_mode', 'base_url', 'api_key']);

  if (!config.models) {
    return [];
  }

  for (const [categoryName, categoryConfig] of Object.entries(config.models)) {
    if (categoryName === 'list' || Array.isArray(categoryConfig)) {
      continue;
    }

    for (const [key, value] of Object.entries(categoryConfig)) {
      if (reservedKeys.has(key) || key.endsWith('_list')) {
        continue;
      }

      if (value !== undefined) {
        ids.add(key);
      }
    }
  }

  // Include composite alias names
  if (config.composite) {
    for (const alias of Object.keys(config.composite)) {
      ids.add(alias);
    }
  }

  // Include schedule alias names
  if (config.schedule) {
    for (const alias of Object.keys(config.schedule)) {
      ids.add(alias);
    }
  }

  return [...ids];
}

/**
 * Extract all hostnames (host[:port]) from base_url values configured in proxy_config.toml.
 * Used to restrict dynamic route targets to pre-approved upstream hosts (SSRF protection).
 */
export function getAllowedHostsFromConfig(config: ProxyConfig): string[] {
  const hosts = new Set<string>();

  // [upstream].default_base_url
  if (config.default_upstream?.default_base_url) {
    try { hosts.add(new URL(config.default_upstream.default_base_url).host); } catch { /* ignore */ }
  }

  // [models.*].base_url and per-model base_url overrides in array entries
  if (config.models) {
    for (const categoryConfig of Object.values(config.models)) {
      if (Array.isArray(categoryConfig)) continue;
      if (categoryConfig.base_url) {
        try { hosts.add(new URL(categoryConfig.base_url).host); } catch { /* ignore */ }
      }
      // Array entries: [model_alias, base_url, api_key]
      for (const [key, value] of Object.entries(categoryConfig)) {
        if (['upstream_mode', 'base_url', 'api_key'].includes(key)) continue;
        if (Array.isArray(value) && value.length >= 2 && typeof value[1] === 'string' && value[1]) {
          try { hosts.add(new URL(value[1]).host); } catch { /* ignore */ }
        }
      }
    }
  }

  return [...hosts].filter(h => h.length > 0);
}

export function dumpProxyConfigToml(config: ProxyConfig, directory = './config-dumps'): string | null {
  if (!isNodeEnvironment) {
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = join(directory, `proxy_config_${timestamp}.toml`);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, serializeProxyConfigToml(config), 'utf-8');
  return filePath;
}

let cachedConfig: ProxyConfig | null = null;

export function clearProxyConfigCache(): void {
  cachedConfig = null;
}

/**
 * Load proxy config from file or URL
 */
export async function loadProxyConfig(env: Env): Promise<ProxyConfig> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const configPath = env.PROXY_CONFIG_PATH;
  const configConsul = env.PROXY_CONFIG_CONSUL;
  const configApollo = env.PROXY_CONFIG_APOLLO;

  createLogger(env).info('config', `Config source: apollo=${configApollo ?? '-'}, consul=${configConsul ?? '-'}, path=${configPath ?? '-'}`);
  if (configApollo) {
    // No Apollo long-poll / notification subscription: portal changes are
    // picked up only when /config-reload is called (or the process restarts).
    console.warn('[WARN] Apollo backend has no live-update notification — call /config-reload after publishing portal changes');
  }

  try {
    let config: ProxyConfig;

    if (configApollo) {
      // Apollo: the named namespace holds the full proxy_config.toml content
      // as a plain-text value. Node-only — the connection file is read with
      // fs, so this branch is not available in the Cloudflare Workers build.
      if (!isNodeEnvironment) {
        throw new Error('PROXY_CONFIG_APOLLO is not supported in non-Node (Cloudflare Workers) environments');
      }
      const fs = await import('fs');
      const apolloFileContent = fs.readFileSync(configApollo, 'utf-8');
      const ap = parseApolloFile(apolloFileContent);
      const toml = await fetchApolloConfig(ap);
      config = parseSimpleToml(toml);
    } else if (configConsul) {
      const response = await fetch(buildConsulKvUrl(configConsul));
      if (!response.ok) {
        throw new Error(`Failed to fetch config from Consul at ${configConsul}: ${response.status}`);
      }

      const kvEntries = (await response.json()) as ConsulKvEntry[];
      if (!Array.isArray(kvEntries)) {
        throw new Error(`Invalid Consul KV response from ${configConsul}`);
      }
      config = parseConsulConfig(kvEntries);
      const validation = validateProxyConfig(config);
      for (const err of validation.errors) {
        const level = err.message.includes('Routing cycle detected') ? '[FATAL]' : '[ERROR]';
        console.error(`${level} ${err.path}: ${err.message}`);
      }
      for (const warn of validation.warnings) {
        console.warn(`[WARN] ${warn.path}: ${warn.message}`);
      }
      (config as unknown as { _validationErrors?: ConfigValidationError[]; _validationWarnings?: ConfigValidationError[] })._validationErrors = validation.errors;
      (config as unknown as { _validationWarnings?: ConfigValidationError[] })._validationWarnings = validation.warnings;
    } else if (configPath) {
      // Load from file - handle both Node.js and Cloudflare Workers environments
      let configContent: string;
      if (isNodeEnvironment) {
        // Node.js environment - use fs module
        const fs = await import('fs');
        configContent = fs.readFileSync(configPath, 'utf-8');
      } else {
        // Cloudflare Workers environment - fetch from relative URL
        // In Workers, configPath should be a relative path that can be fetched
        const response = await fetch(configPath);
        if (!response.ok) {
          throw new Error(`Failed to fetch config from ${configPath}: ${response.status}`);
        }
        configContent = await response.text();
      }
      config = parseSimpleToml(configContent);
    } else {
      // No config specified, return empty config
      return {};
    }

    // System keychain store ([general] store_key_in_system): store plaintext
    // api_keys into the OS keychain, rewrite the config file to sentinels,
    // and resolve existing sentinels back to real keys. LOCAL FILE SOURCE
    // ONLY (PROXY_CONFIG_PATH) — the feature is skipped for Consul/Apollo
    // configs, which cannot be rewritten and must not touch the keychain.
    // Throws a fatal error when the keychain itself is unavailable (affects
    // every sentinel); an individual sentinel that can't be resolved is
    // instead cleared to '' and reported below — one bad key must not block
    // every other model from loading (Rule 8: fail loud, not fail everything).
    if (configPath && !configConsul && !configApollo) {
      const keyStoreResult = await applySystemKeyStore(config, { configPath });
      config = keyStoreResult.config;
      if (keyStoreResult.unresolved.length > 0) {
        const meta = config as unknown as { _validationErrors?: ConfigValidationError[] };
        meta._validationErrors = [
          ...(meta._validationErrors ?? []),
          ...keyStoreResult.unresolved.map((u) => ({ path: u.location, message: u.message })),
        ];
      }
    } else {
      if (config.general?.store_key_in_system === true) {
        console.warn('[key-store] store_key_in_system is only supported for local PROXY_CONFIG_PATH configs — ignoring it (Consul/Apollo source)');
      }
      // A sentinel reaching this point could never be resolved and would be
      // forwarded upstream as a literal key — refuse to load instead.
      const sentinels = findSentinelApiKeys(config);
      if (sentinels.length > 0) {
        throw new KeyStoreError(
          `api_key sentinel "${STORE_KEY_IN_SYSTEM}" found at ${sentinels.join(', ')} ` +
          `in a Consul/Apollo config — sentinels can only be resolved from a local PROXY_CONFIG_PATH file`,
        );
      }
    }

    // Strip conflicting aliases (composite/schedule names that collide with
    // a [models.*] entry). Log a fatal error for each stripped alias and
    // cache the stripped config so the proxy refuses to route on it. The
    // on-disk file is NOT modified — only the in-memory config is filtered.
    const { config: strippedConfig, stripped } = stripConflictingAliases(config);
    if (stripped.composite.length > 0 || stripped.schedule.length > 0) {
      for (const alias of stripped.composite) {
        console.error(`[FATAL] Refusing to load composite alias "${alias}" — alias name conflicts with a model defined under [models.*]`);
      }
      for (const alias of stripped.schedule) {
        console.error(`[FATAL] Refusing to load schedule alias "${alias}" — alias name conflicts with a model defined under [models.*]`);
      }
    }

    // Strip self-referencing composite targets (an alias that lists itself
    // as one of its own targets). Log a fatal per stripped target so TUI /
    // dashboard operators see the cause; the alias itself is preserved with
    // its other valid targets intact.
    const { config: cleanedConfig, stripped: selfRef } = stripSelfReferencingCompositeTargets(strippedConfig);
    for (const [alias, badTargets] of Object.entries(selfRef)) {
      for (const target of badTargets) {
        console.error(`[FATAL] Refusing to load composite target "${alias}.${target}" — composite alias cannot list itself as a target`);
      }
    }

    cachedConfig = cleanedConfig;

    const startupLogger = createLogger(env);
    // Privacy filter activation summary (once, at startup). Per-request
    // redaction events are still logged separately by index.ts.
    {
      const startupPrivacy = getPrivacyFilterConfig(env, cleanedConfig.privacy_filter);
      if (startupPrivacy) {
        const modeDetail = startupPrivacy.mode === 'sidecar'
          ? `url=${startupPrivacy.url}`
          : `entropyThreshold=${startupPrivacy.entropyThreshold}`;
        startupLogger.info('config', `Privacy filter active: mode=${startupPrivacy.mode} ${modeDetail}`);
      }
    }

    // Image-encode sidecar resolution (once, at startup). When configured,
    // OpenAI image_url -> Gemini inline_data http(s) fetches are delegated to
    // the sidecar; otherwise they happen in-process with the SSRF guard.
    {
      const startupImageEncode = resolveImageEncodeConfig(env, cleanedConfig.fetch);
      setImageEncodeConfig(startupImageEncode);
      if (startupImageEncode) {
        startupLogger.info('config', `Image-encode sidecar active: url=${startupImageEncode.url} timeoutMs=${startupImageEncode.timeoutMs}`);
      }
    }

    return cachedConfig;
  } catch (error) {
    // Fatal errors (e.g. system-keychain failures) must not degrade to an
    // empty config — rethrow so startup fails loud.
    if ((error as { fatal?: boolean }).fatal) {
      throw error;
    }
    console.warn(`Failed to load proxy config: ${(error as Error).message}`);
    return {};
  }
}

/**
 * Simple TOML parser for category-based structure
 */
export function parseSimpleToml(content: string): ProxyConfig {
  const config: ProxyConfig = {};
  const lines = content.split('\n');
  let currentSection: string | null = null;
  let currentCategory: string | null = null;
  const seenSections = new Set<string>();
  // Track seen keys per section+category, e.g. "models.gemini/api_key"
  const seenKeys = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    let trimmed = line.trim();

    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Multiline array accumulation: a `key = [` whose bracket is not closed on
    // this physical line (e.g. transform ops spanning several lines) is folded
    // into one logical line so the single-line array/ops regexes below can match.
    // Bracket counting is safe here because in-value strings like
    // "messages[role=assistant].content" carry balanced [] on their own line.
    if (/=\s*\[/.test(trimmed)) {
      let depth = (trimmed.match(/\[/g) || []).length - (trimmed.match(/\]/g) || []).length;
      while (depth > 0 && i + 1 < lines.length) {
        i++;
        const next = lines[i];
        line += '\n' + next;
        depth += (next.match(/\[/g) || []).length - (next.match(/\]/g) || []).length;
      }
      // Collapse to a single logical line for downstream single-line matchers.
      trimmed = line.split('\n').map(s => s.trim()).filter(Boolean).join(' ');
    }

    // Section headers: [upstream], [models.gemini], [defaults]
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const section = trimmed.slice(1, -1);
      const parts = section.split('.');

      if (seenSections.has(section)) {
        console.warn(`[config] duplicate section header [${section}] at line ${i + 1} — earlier entries in this section are overwritten`);
      }
      seenSections.add(section);

      if (parts[0] === 'general') {
        currentSection = 'general';
        currentCategory = null;
        config.general = {};
      } else if (parts[0] === 'default_upstream') {
        currentSection = 'default_upstream';
        currentCategory = null;
        config.default_upstream = {};
      } else if (parts[0] === 'models') {
        currentSection = 'models';
        currentCategory = parts[1] || null;
        if (!config.models) config.models = {};
        if (currentCategory) {
          config.models[currentCategory] = {};
        }
      } else if (parts[0] === 'composite') {
        currentSection = 'composite';
        currentCategory = null;
        config.composite = {};
      } else if (parts[0] === 'schedule') {
        currentSection = 'schedule';
        currentCategory = null;
        config.schedule = {};
      } else if (parts[0] === 'defaults') {
        currentSection = 'defaults';
        currentCategory = null;
        config.defaults = {};
      } else if (parts[0] === 'dashboard') {
        currentSection = 'dashboard';
        currentCategory = null;
        config.dashboard = {};
      } else if (parts[0] === 'remote' && (parts[1] === 'authentication' || parts[1] === 'recording')) {
        currentSection = 'remote';
        currentCategory = parts[1];
        if (!config.remote) config.remote = {};
        if (currentCategory === 'authentication') {
          config.remote.authentication = {};
        } else {
          config.remote.recording = {};
        }
      } else if (parts[0] === 'privacy_filter') {
        currentSection = 'privacy_filter';
        currentCategory = null;
        config.privacy_filter = {};
      } else if (parts[0] === 'fetch') {
        currentSection = 'fetch';
        currentCategory = null;
        config.fetch = {};
      } else if (parts[0] === 'transforms' && parts[1]) {
        currentSection = 'transforms';
        currentCategory = parts[1];
        if (!config.transforms) config.transforms = {};
        config.transforms[currentCategory] = { name: currentCategory, schema: 'openai-completions' };
      } else if (parts[0] === 'transform_defaults') {
        currentSection = 'transform_defaults';
        currentCategory = null;
        if (!config.transform_defaults) config.transform_defaults = {};
      }
      continue;
    }

    // Key-value pairs
    // Strip inline comments before matching. TOML inline comments always start
    // with whitespace + '#'. Using \s+# (rather than bare #) avoids corrupting
    // values that contain '#' with no preceding space (e.g. api_key = "abc#def").
    // e.g. `filter_mode = "local"  # "sidecar" | "local"` → `filter_mode = "local"`
    const trimmedNoComment = trimmed.replace(/\s+#.*$/, '');
    // Handle simple strings: key = "value"
    const stringMatch = trimmedNoComment.match(/^"?([^"=]+)"?\s*=\s*(["'])(.*?)\2$/);
    if (stringMatch) {
      const [, key, , value] = stringMatch;
      const cleanKey = key.trim().replace(/^"|"$/g, '');
      const seenKeyId = `${currentSection}/${currentCategory}/${cleanKey}`;
      if (seenKeys.has(seenKeyId)) {
        console.warn(`[config] duplicate key "${cleanKey}" in [${currentSection}${currentCategory ? '.' + currentCategory : ''}] at line ${i + 1} — earlier value is overwritten`);
      }
      seenKeys.add(seenKeyId);

      if (currentSection === 'general' && config.general) {
        if (cleanKey === 'global_token_limit') {
          (config.general as any)[cleanKey] = value;
        } else if (cleanKey === 'week_start_day') {
          (config.general as any)[cleanKey] = value === 'sunday' ? 'sunday' : 'monday';
        }
      } else if (currentSection === 'remote' && currentCategory === 'authentication' && config.remote?.authentication) {
        if (cleanKey === 'auth_server' || cleanKey === 'auth_passthrough_with') {
          (config.remote.authentication as any)[cleanKey] = value;
        } else if (cleanKey === 'auth_with_model' || cleanKey === 'auth_with_body') {
          (config.remote.authentication as any)[cleanKey] = value === 'true';
        }
      } else if (currentSection === 'remote' && currentCategory === 'recording' && config.remote?.recording) {
        if (cleanKey === 'record_server') {
          config.remote.recording.record_server = value;
        } else if (cleanKey === 'record_response_body') {
          config.remote.recording.record_response_body = value === 'true';
        }
      } else if (currentSection === 'default_upstream' && config.default_upstream) {
        (config.default_upstream as any)[cleanKey] = normalizeUpstreamThresholdValue(cleanKey, value);
      } else if (currentSection === 'models' && currentCategory && config.models) {
        const category = config.models[currentCategory] as ModelCategoryConfig;
        if (cleanKey === 'upstream_mode' || cleanKey === 'base_url' || cleanKey === 'api_key') {
          category[cleanKey] = value;
        }
      } else if (currentSection === 'composite' && config.composite) {
        config.composite[cleanKey] = parseCompositeModelConfig(value);
      } else if (currentSection === 'defaults' && config.defaults) {
        (config.defaults as any)[cleanKey] = value;
      } else if (currentSection === 'dashboard' && config.dashboard && cleanKey === 'api_key') {
        config.dashboard.api_key = value;
      } else if (currentSection === 'privacy_filter' && config.privacy_filter) {
        // filter_mode, filter_url, whitelist_file are stored as strings;
        // numeric thresholds are coerced in the unquoted branch below.
        if (cleanKey === 'filter_mode' || cleanKey === 'filter_url' || cleanKey === 'whitelist_file') {
          (config.privacy_filter as any)[cleanKey] = value;
        }
      } else if (currentSection === 'fetch' && config.fetch) {
        if (cleanKey === 'image_encode') {
          config.fetch.image_encode = value;
        }
      } else if (currentSection === 'transforms' && currentCategory && config.transforms) {
        const set = config.transforms[currentCategory];
        if (cleanKey === 'schema') {
          set.schema = value as TransformSchema;
        }
      }
      continue;
    }

    // Handle model inline-table entries: "model-id" = {target="...", base_url="...", api_key="..."}
    // This is the spec-compliant replacement for the old array form.
    // Must be checked before compositeObjectMatch so [models.*] sections take priority.
    if (currentSection === 'models' && currentCategory && config.models) {
      const modelTableMatch = trimmedNoComment.match(/^"?([^"=]+)"?\s*=\s*(\{[^{}]*\})$/);
      if (modelTableMatch) {
        const cleanKey = modelTableMatch[1].trim().replace(/^"|"$/g, '');
        const seenKeyIdTable = `${currentSection}/${currentCategory}/${cleanKey}`;
        if (seenKeys.has(seenKeyIdTable)) {
          console.warn(`[config] duplicate key "${cleanKey}" in [${currentSection}.${currentCategory}] at line ${i + 1} — earlier value is overwritten`);
        }
        seenKeys.add(seenKeyIdTable);
        const tableBody = modelTableMatch[2].slice(1, -1); // strip outer braces
        const fields: Record<string, string> = {};
        // Split on top-level commas only — must not split inside quoted values,
        // since `transforms = "a,b,c"` carries a CSV.
        const fieldParts: string[] = [];
        let buf = '';
        let inQuote = false;
        for (let ci = 0; ci < tableBody.length; ci++) {
          const ch = tableBody[ci];
          if (ch === '"') inQuote = !inQuote;
          if (ch === ',' && !inQuote) {
            fieldParts.push(buf);
            buf = '';
          } else {
            buf += ch;
          }
        }
        if (buf.trim()) fieldParts.push(buf);
        for (const field of fieldParts) {
          // Values are quoted strings, or bare numbers (max_tokens = 8192).
          const kv = field.trim().match(/^(\w+)\s*=\s*(?:"([^"]*)"|(\d+))$/);
          if (kv) fields[kv[1]] = kv[2] !== undefined ? kv[2] : kv[3];
        }
        // Inline model tables accept both canonical and short aliases:
        //   target; upstream_mode | mode; base_url | url; api_key | key.
        // Canonical (upstream_mode/base_url/api_key) wins when both are present.
        const target = fields['target'] ?? cleanKey;
        const mode = fields['upstream_mode'] ?? fields['mode'] ?? '';
        const baseUrl = fields['base_url'] ?? fields['url'] ?? '';
        const apiKey = fields['api_key'] ?? fields['key'] ?? '';
        const entry: string[] = [target, baseUrl, apiKey, mode];
        if (fields['transforms']) entry.push(fields['transforms']);
        // index 5: optional per-entry max_tokens (used when the request omits it)
        if (fields['max_tokens'] !== undefined) {
          while (entry.length < 5) entry.push('');
          entry.push(fields['max_tokens']);
        }
        const category = config.models[currentCategory] as ModelCategoryConfig;
        category[cleanKey] = entry as [string, string, string, string, string];
        continue;
      }
    }

    // Handle transforms anthropic_beta_map inline table:
    //   anthropic_beta_map = { "header-a" = "mapped-a", "header-b" = "" }
    // Empty-string value means "drop" (TOML has no null scalar).
    if (currentSection === 'transforms' && currentCategory && config.transforms) {
      const betaMapMatch = trimmedNoComment.match(/^anthropic_beta_map\s*=\s*(\{.*\})$/);
      if (betaMapMatch) {
        const set = config.transforms[currentCategory];
        const tableBody = betaMapMatch[1].slice(1, -1);
        const map: Record<string, string | null> = {};
        // Reuse the top-level-comma split that respects quoted strings.
        const parts: string[] = [];
        let buf = '';
        let inQuote = false;
        for (let ci = 0; ci < tableBody.length; ci++) {
          const ch = tableBody[ci];
          if (ch === '"') inQuote = !inQuote;
          if (ch === ',' && !inQuote) { parts.push(buf); buf = ''; }
          else buf += ch;
        }
        if (buf.trim()) parts.push(buf);
        for (const part of parts) {
          const kv = part.trim().match(/^"?([^"=]+?)"?\s*=\s*"([^"]*)"$/);
          if (kv) {
            const k = kv[1].trim().replace(/^"|"$/g, '');
            // Empty string → null (drop). Otherwise the literal mapped name.
            map[k] = kv[2] === '' ? null : kv[2];
          }
        }
        set.anthropic_beta_map = map;
        continue;
      }

      // Handle transforms headers.set inline object: before_upstream.headers.set = {"X-Foo" = "bar"}
      const headersSetMatch = trimmedNoComment.match(/^([\w]+)\.headers\.set\s*=\s*(\{.*\})$/);
      if (headersSetMatch) {
        const rawHook = headersSetMatch[1];
        if (HOOK_KEYS.has(rawHook)) {
          const set = config.transforms[currentCategory];
          const hookPart = normalizeHookAlias(rawHook) as HookKey;
          if (!set[hookPart]) set[hookPart] = {} as TransformHookSlot;
          const slot = set[hookPart] as TransformHookSlot;
          if (!slot.headers) slot.headers = {};
          const tableBody = headersSetMatch[2].slice(1, -1);
          const headerMap: Record<string, string> = {};
          const parts: string[] = [];
          let buf = '';
          let inQuote = false;
          for (let ci = 0; ci < tableBody.length; ci++) {
            const ch = tableBody[ci];
            if (ch === '"') inQuote = !inQuote;
            if (ch === ',' && !inQuote) { parts.push(buf); buf = ''; }
            else buf += ch;
          }
          if (buf.trim()) parts.push(buf);
          for (const part of parts) {
            const kv = part.trim().match(/^"([^"]+)"\s*=\s*"([^"]*)"$/);
            if (kv) headerMap[kv[1]] = kv[2];
          }
          slot.headers.set = headerMap;
          continue;
        }
      }
    }

    // Handle composite inline object values: "alias" = {"m1": {...}, "m2": {...}}
    // Note: allow an empty object {} (newly added alias with no targets yet) by
    // using .* instead of .+ so the alias is preserved on round-trip.
    const compositeObjectMatch = trimmedNoComment.match(/^"?([^"=]+)"?\s*=\s*(\{.*\})$/);
    if (compositeObjectMatch && currentSection === 'composite' && config.composite) {
      const [, key, value] = compositeObjectMatch;
      const cleanKey = key.trim().replace(/^"|"$/g, '');
      config.composite[cleanKey] = parseCompositeModelConfig(value.trim());
      continue;
    }

    // Handle schedule inline object values: "saver" = {"target1" = [{from=..,to=..}], "target2" = []}
    const scheduleObjectMatch = trimmedNoComment.match(/^"?([^"=]+)"?\s*=\s*(\{.*\})$/);
    if (scheduleObjectMatch && currentSection === 'schedule' && config.schedule) {
      const [, key, value] = scheduleObjectMatch;
      const cleanKey = key.trim().replace(/^"|"$/g, '');
      config.schedule[cleanKey] = parseScheduleConfig(value.trim());
      continue;
    }

    // Handle transforms hook-scoped ops/builtins arrays (may contain nested {} tables)
    if (currentSection === 'transforms' && currentCategory && config.transforms) {
      const transformsArrMatch = trimmed.match(/^([\w.]+)\s*=\s*(\[.*\])$/);
      if (transformsArrMatch) {
        const cleanKey = transformsArrMatch[1].trim();
        const rawArr = transformsArrMatch[2];
        const set = config.transforms[currentCategory];
        const dotIdx = cleanKey.indexOf('.');
        if (dotIdx !== -1) {
          const rawHook = cleanKey.slice(0, dotIdx);
          const fieldPart = cleanKey.slice(dotIdx + 1);
          if (HOOK_KEYS.has(rawHook)) {
            const hookPart = normalizeHookAlias(rawHook) as HookKey;
            if (!set[hookPart]) set[hookPart] = {} as TransformHookSlot;
            const slot = set[hookPart] as TransformHookSlot;
            if (fieldPart === 'ops') {
              slot.ops = parseTransformOpsInline(rawArr);
            } else if (fieldPart === 'builtins') {
              // simple string array
              slot.builtins = rawArr
                .replace(/^\[/, '').replace(/\]$/, '')
                .split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean) as BuiltinName[];
            } else if (fieldPart === 'headers.remove') {
              if (!slot.headers) slot.headers = {};
              slot.headers.remove = rawArr
                .replace(/^\[/, '').replace(/\]$/, '')
                .split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);
            }
          }
        }
        continue;
      }
    }

    // Handle arrays: "model-id" = ["alias", "url", "key"]
    // Must be checked before unquotedMatch to avoid greedy (.+) capture stealing array values.
    const arrayMatch = trimmedNoComment.match(/^"?([^"=]+)"?\s*=\s*\[([^\]]*)\]/);
    if (arrayMatch) {
      const [, key, arrayContent] = arrayMatch;
      const cleanKey = key.trim().replace(/^"|"$/g, '');
      const seenKeyIdArr = `${currentSection}/${currentCategory}/${cleanKey}`;
      if (seenKeys.has(seenKeyIdArr)) {
        console.warn(`[config] duplicate key "${cleanKey}" in [${currentSection}${currentCategory ? '.' + currentCategory : ''}] at line ${i + 1} — earlier value is overwritten`);
      }
      seenKeys.add(seenKeyIdArr);

      // Parse array elements
      const elements: string[] = [];
      let current = '';
      let inQuotes = false;

      for (let j = 0; j < arrayContent.length; j++) {
        const char = arrayContent[j];
        if (char === '"') {
          inQuotes = !inQuotes;
        } else if (char === ',' && !inQuotes) {
          elements.push(current.trim().replace(/^"|"$/g, ''));
          current = '';
        } else {
          current += char;
        }
      }
      // Always push the last element (even if empty string like "")
      elements.push(current.trim().replace(/^"|"$/g, ''));

      if (currentSection === 'models' && currentCategory && config.models) {
        const category = config.models[currentCategory] as ModelCategoryConfig;
        // Store raw array (1-4 elements: target, base_url, api_key, mode), no padding
        category[cleanKey] = elements as [string, string, string, string];
      } else if (currentSection === 'privacy_filter' && config.privacy_filter) {
        if (cleanKey === 'whitelist_add' || cleanKey === 'whitelist_remove') {
          (config.privacy_filter as any)[cleanKey] = elements;
        }
      } else if (currentSection === 'transform_defaults' && config.transform_defaults) {
        // transform_defaults: openai-completions = ["set_a", "set_b"]
        config.transform_defaults[cleanKey] = elements;
      } else if (currentSection === 'transforms' && currentCategory && config.transforms) {
        // transforms.<name>: builtins = ["lowercase_tool_schema_types"]
        const set = config.transforms[currentCategory];
        parseTransformArrayField(set, cleanKey, elements);
      }
      continue;
    }

    // Handle unquoted numbers and other values: key = value
    const unquotedMatch = trimmedNoComment.match(/^([a-zA-Z0-9_-]+)\s*=\s*(.+)$/);
    if (unquotedMatch) {
      const [, key, value] = unquotedMatch;
      const cleanKey = key.trim();
      const seenKeyIdUnquoted = `${currentSection}/${currentCategory}/${cleanKey}`;
      if (seenKeys.has(seenKeyIdUnquoted)) {
        console.warn(`[config] duplicate key "${cleanKey}" in [${currentSection}${currentCategory ? '.' + currentCategory : ''}] at line ${i + 1} — earlier value is overwritten`);
      }
      seenKeys.add(seenKeyIdUnquoted);
      let cleanValue: string | number = value.trim();

      // Try to parse as boolean or number
      let cleanValueAny: string | number | boolean = cleanValue;
      if (cleanValue === 'true') {
        cleanValueAny = true;
      } else if (cleanValue === 'false') {
        cleanValueAny = false;
      } else if (!isNaN(Number(cleanValue)) && cleanValue !== '') {
        cleanValueAny = Number(cleanValue);
      }

      if (currentSection === 'general' && config.general) {
        (config.general as any)[cleanKey] = typeof cleanValueAny === 'boolean' ? cleanValueAny : normalizeUpstreamThresholdValue(cleanKey, cleanValueAny as string | number);
      } else if (currentSection === 'default_upstream' && config.default_upstream) {
        (config.default_upstream as any)[cleanKey] = normalizeUpstreamThresholdValue(cleanKey, cleanValue);
      } else if (currentSection === 'defaults' && config.defaults) {
        (config.defaults as any)[cleanKey] = cleanValue;
      } else if (currentSection === 'privacy_filter' && config.privacy_filter) {
        if (typeof cleanValueAny === 'number') {
          if (cleanKey === 'entropy_threshold' || cleanKey === 'max_chars' || cleanKey === 'timeout_ms' || cleanKey === 'hash_min_len') {
            (config.privacy_filter as any)[cleanKey] = cleanValueAny;
          }
        } else if (typeof cleanValueAny === 'string') {
          if (cleanKey === 'filter_mode' || cleanKey === 'filter_url' || cleanKey === 'whitelist_file') {
            (config.privacy_filter as any)[cleanKey] = cleanValueAny;
          }
        }
      } else if (currentSection === 'fetch' && config.fetch) {
        if (cleanKey === 'timeout_ms' && typeof cleanValueAny === 'number') {
          config.fetch.timeout_ms = cleanValueAny;
        } else if (cleanKey === 'image_encode' && typeof cleanValueAny === 'string') {
          config.fetch.image_encode = cleanValueAny;
        }
      } else if (currentSection === 'remote' && currentCategory === 'recording' && config.remote?.recording) {
        if (cleanKey === 'record_server' && typeof cleanValueAny === 'string') {
          config.remote.recording.record_server = cleanValueAny;
        } else if (cleanKey === 'record_response_body' && typeof cleanValueAny === 'boolean') {
          config.remote.recording.record_response_body = cleanValueAny;
        }
      } else if (currentSection === 'remote' && currentCategory === 'authentication' && config.remote?.authentication) {
        if ((cleanKey === 'auth_with_model' || cleanKey === 'auth_with_body') && typeof cleanValueAny === 'boolean') {
          (config.remote.authentication as any)[cleanKey] = cleanValueAny;
        } else if (cleanKey === 'auth_server' || cleanKey === 'auth_passthrough_with') {
          (config.remote.authentication as any)[cleanKey] = cleanValueAny;
        }
      }
      continue;
    }
  }

  // Validate config and log errors/warnings
  const validation = validateProxyConfig(config);
  for (const err of validation.errors) {
    const level = err.message.includes('Routing cycle detected') ? '[FATAL]' : '[ERROR]';
    console.error(`${level} ${err.path}: ${err.message}`);
  }
  for (const warn of validation.warnings) {
    console.warn(`[WARN] ${warn.path}: ${warn.message}`);
  }
  (config as unknown as { _validationErrors?: ConfigValidationError[]; _validationWarnings?: ConfigValidationError[] })._validationErrors = validation.errors;
  (config as unknown as { _validationWarnings?: ConfigValidationError[] })._validationWarnings = validation.warnings;

  // Log transform errors — do NOT throw here. parseSimpleToml is called both
  // for normal config loading and for the integrity round-trip inside
  // persistProxyConfigToPath. Throwing in the round-trip path blocks every
  // mutation save (add/edit/delete composite targets) when any transform set
  // reference is invalid. Transform errors are surfaced via _validationErrors
  // in loadProxyConfig where they can be shown in the dashboard status bar.
  const transformErrs = validateAllTransforms(config);
  for (const err of transformErrs) {
    console.error(`[ERROR] transforms.${err.set}: ${err.message}`);
  }
  if (transformErrs.length > 0) {
    const existing = (config as unknown as { _validationErrors?: ConfigValidationError[] })._validationErrors ?? [];
    (config as unknown as { _validationErrors?: ConfigValidationError[] })._validationErrors = [
      ...existing,
      ...transformErrs.map((e) => ({ path: `transforms.${e.set}`, message: e.message })),
    ];
  }

  return config;
}

/**
 * Get model config
 */
export function getModelConfig(config: ProxyConfig, modelName: string) {
  if (!config.models) return undefined;

  // Priority 1: Exact key match across all categories.
  // Exact entries in models.claude / models.gemini always override wildcards.
  for (const [categoryName, categoryConfig] of Object.entries(config.models)) {
    if (Array.isArray(categoryConfig)) continue;

    const modelEntry = categoryConfig[modelName];
    if (modelEntry !== undefined) {
      return {
        category: categoryName,
        entry: modelEntry,
        categoryConfig,
      };
    }
  }

  // Priority 2: Wildcard pattern match — all sections except those handled elsewhere.
  // Skipped here for different reasons:
  //   - models.FREE / models.free, models.EMBEDDING / models.embedding: exact-only, never match wildcards.
  //   - models.default: supports wildcards AND catch-all "*", but must be checked LAST (Priority 3).
  // All other sections (built-in: claude, gemini, gpt; user-defined: nvidia, openrouter, etc.) support wildcards.
  const skipInPriority2 = new Set(['free', 'FREE', 'embedding', 'EMBEDDING', 'default']);
  for (const [cat, categoryConfig] of Object.entries(config.models)) {
    if (skipInPriority2.has(cat) || Array.isArray(categoryConfig)) continue;
    const wildcardMatch = findWildcardPatternMatch(categoryConfig, modelName);
    if (wildcardMatch) {
      return {
        category: cat,
        entry: wildcardMatch.entry,
        categoryConfig: wildcardMatch.categoryConfig,
      };
    }
  }

  // Priority 3: Catch-all via models.default (* pattern). Must be checked LAST.
  const defaultConfig = config.models['default'];
  if (defaultConfig && !Array.isArray(defaultConfig)) {
    // models.default: exact match checked already in Priority 1.
    // Check for wildcard patterns (if any) first, then fall through to the catch-all.
    const wildcardMatch = findWildcardPatternMatch(defaultConfig, modelName);
    if (wildcardMatch) {
      return {
        category: 'default',
        entry: wildcardMatch.entry,
        categoryConfig: defaultConfig,
      };
    }
    // Catch-all: any model not matched by exact or wildcard goes to models.default.
    // A "*" entry in models.default (e.g. "* = ["*", "", ""]") means "use default config".
    const catchAllEntry = defaultConfig['*'];
    if (catchAllEntry !== undefined) {
      return {
        category: 'default',
        entry: catchAllEntry,
        categoryConfig: defaultConfig,
      };
    }
  }

  return undefined;
}

/**
 * Find a wildcard pattern entry in a category that matches a model name.
 * Matches "prefix-*" against "prefix-suffix" (suffix may contain hyphens).
 * Checks each key ending with "-*" to see if modelName starts with the prefix.
 */
function findWildcardPatternMatch(
  categoryConfig: ModelCategoryConfig,
  modelName: string,
): { entry: [string, string, string, string]; categoryConfig: ModelCategoryConfig } | undefined {
  for (const [key, value] of Object.entries(categoryConfig)) {
    if (key.endsWith('-*') && Array.isArray(value) && value.length >= 1) {
      const prefix = key.slice(0, -2); // strip "-*"
      if (modelName.startsWith(prefix)) {
        return { entry: value as [string, string, string, string], categoryConfig };
      }
    }
  }
  return undefined;
}

export type DashboardModelArrayConfig = [string, string, string]; // [target, base_url, mode]

export interface DashboardModelCategoryConfig {
  upstream_mode?: string;
  base_url?: string;
  [modelId: string]: string | DashboardModelArrayConfig | undefined;
}

export interface DashboardConfigPayload {
  models: Record<string, DashboardModelCategoryConfig>;
  composite: Record<string, CompositeModelConfig>;
  schedule: Record<string, ScheduleConfig>;
  config_errors: ConfigValidationError[];
  config_warnings: ConfigValidationError[];
  global_token_limit?: string;
  remote_auth_active: boolean;
  remote_recording_active: boolean;
  privacy_filter_active: boolean;
  /** True when every configured api_key in the local file is a STORE_KEY_IN_SYSTEM sentinel. */
  api_keys_in_system_store?: boolean;
}

/**
 * sanitizeDashboardCategoryConfig (the GET side) maps the internal model-entry
 * array [target, base_url, api_key, mode, transforms, max_tokens] to the
 * dashboard's 3-tuple display shape [target, base_url, mode] — index 2
 * (api_key) is skipped and indices 4/5 (transforms/max_tokens) are never
 * surfaced to the dashboard UI; they are config-file-only fields.
 */
function sanitizeDashboardCategoryConfig(categoryConfig: ModelCategoryConfig): DashboardModelCategoryConfig {
  const sanitized: DashboardModelCategoryConfig = {};

  for (const [key, value] of Object.entries(categoryConfig)) {
    if (key === 'api_key') {
      continue;
    }

    if (Array.isArray(value)) {
      sanitized[key] = [value[0] || '', value[1] || '', value[3] || ''];
    } else if (typeof value === 'string') {
      sanitized[key] = value;
    } else if (value && typeof value === 'object') {
      // Inline-table entry (e.g. `bbb = {target = "...", base_url = "...", api_key = "...", mode = "..."}`).
      // Same shape as the array case: [target, base_url, mode], api_key stripped.
      const entry = value as Record<string, unknown>;
      sanitized[key] = [
        typeof entry.target === 'string' ? entry.target : '',
        typeof entry.base_url === 'string' ? entry.base_url : '',
        typeof entry.mode === 'string' ? entry.mode : '',
      ];
    }
  }

  return sanitized;
}

function sanitizeCompositeConfig(composite: ProxyConfig['composite']): Record<string, CompositeModelConfig> {
  if (!composite) {
    return {};
  }

  const result: Record<string, CompositeModelConfig> = {};
  for (const [alias, targets] of Object.entries(composite)) {
    const safeTargets: CompositeModelConfig = {};
    const aliasLimit = getCompositeTokenLimit(targets as CompositeModelConfig);
    if (aliasLimit !== undefined) {
      safeTargets.token_limit = aliasLimit;
    }

    // Preserve toolset (coordinator trigger tools)
    const rawToolset = (targets as CompositeModelConfig).toolset;
    if (Array.isArray(rawToolset)) {
      safeTargets.toolset = rawToolset.filter((t): t is string => typeof t === 'string');
    }

    // Preserve fusion_options
    const rawFusionOpts = (targets as CompositeModelConfig).fusion_options;
    if (rawFusionOpts && typeof rawFusionOpts === 'object' && !Array.isArray(rawFusionOpts)) {
      const fo = rawFusionOpts as Record<string, unknown>;
      const opts: FusionOptions = {};
      if (typeof fo.min_panel === 'number') opts.min_panel = fo.min_panel;
      if (typeof fo.panel_timeout_ms === 'number') opts.panel_timeout_ms = fo.panel_timeout_ms;
      if (typeof fo.judge_required === 'boolean') opts.judge_required = fo.judge_required;
      if (typeof fo.expose_metadata === 'boolean') opts.expose_metadata = fo.expose_metadata;
      if (typeof fo.max_concurrent === 'number') opts.max_concurrent = fo.max_concurrent;
      safeTargets.fusion_options = opts;
    }

    for (const [targetModel, config] of Object.entries(targets || {})) {
      if (COMPOSITE_META_KEYS.has(targetModel)) {
        continue;
      }
      if (targetModel.startsWith('_')) {
        continue; // skip internal validation markers
      }

      // Only process CompositeTargetConfig (skip TokenLimitConfig / FusionOptions objects)
      if (typeof config !== 'object' || config === null || Array.isArray(config)) {
        continue;
      }
      const targetCfg = config as Record<string, unknown>;
      if ('num' in targetCfg && 'duration' in targetCfg) {
        // This is a TokenLimitConfig, not a target model — skip
        continue;
      }
      if ('min_panel' in targetCfg || 'panel_timeout_ms' in targetCfg) {
        // This is a FusionOptions block — skip
        continue;
      }

      const safeTarget: CompositeTargetConfig = {};
      if (typeof targetCfg.share === 'number' && Number.isFinite(targetCfg.share)) {
        safeTarget.share = targetCfg.share;
      }
      if (typeof targetCfg.primary === 'boolean') {
        safeTarget.primary = targetCfg.primary;
      }
      if (typeof targetCfg.fallback === 'number' && Number.isFinite(targetCfg.fallback)) {
        safeTarget.fallback = targetCfg.fallback;
      }
      if (typeof targetCfg.fusion === 'number' && Number.isFinite(targetCfg.fusion)) {
        safeTarget.fusion = targetCfg.fusion;
      }
      if (typeof targetCfg.coord === 'number' && Number.isFinite(targetCfg.coord)) {
        safeTarget.coord = targetCfg.coord;
      }
      if (
        targetCfg.role === 'panel' || targetCfg.role === 'judge' || targetCfg.role === 'synth' ||
        targetCfg.role === 'planner' || targetCfg.role === 'executor'
      ) {
        safeTarget.role = targetCfg.role as FusionRole;
      }
      safeTargets[targetModel] = safeTarget;
    }
    result[alias] = safeTargets;
  }
  return result;
}

function sanitizeScheduleConfig(schedule: ProxyConfig['schedule']): Record<string, ScheduleConfig> {
  if (!schedule) {
    return {};
  }

  const result: Record<string, ScheduleConfig> = {};
  for (const [alias, targets] of Object.entries(schedule)) {
    const safeTargets: ScheduleConfig = {};
    for (const [target, windows] of Object.entries(targets || {})) {
      if (!Array.isArray(windows)) {
        continue;
      }
      safeTargets[target] = windows.map((w) => {
        const safeWindow: ScheduleWindow = {};
        if (typeof w?.from === 'number' && Number.isFinite(w.from)) {
          safeWindow.from = w.from;
        }
        if (typeof w?.to === 'number' && Number.isFinite(w.to)) {
          safeWindow.to = w.to;
        }
        if (w?.days === 'weekday' || w?.days === 'weekend') {
          safeWindow.days = w.days;
        } else if (Array.isArray(w?.days)) {
          safeWindow.days = w.days.filter((d): d is string => typeof d === 'string');
        }
        return safeWindow;
      });
    }
    result[alias] = safeTargets;
  }
  return result;
}

export function toDashboardConfigPayload(config: ProxyConfig): DashboardConfigPayload {
  const models: Record<string, DashboardModelCategoryConfig> = {};

  if (config.models) {
    for (const [categoryName, categoryConfig] of Object.entries(config.models)) {
      if (Array.isArray(categoryConfig)) {
        continue;
      }
      models[categoryName] = sanitizeDashboardCategoryConfig(categoryConfig);
    }
  }

  return {
    models,
    composite: sanitizeCompositeConfig(config.composite),
    schedule: sanitizeScheduleConfig(config.schedule),
    config_errors: (config as unknown as { _validationErrors?: ConfigValidationError[] })._validationErrors ?? [],
    config_warnings: (config as unknown as { _validationWarnings?: ConfigValidationError[] })._validationWarnings ?? [],
    global_token_limit: config.general?.global_token_limit,
    api_keys_in_system_store: !!(config as ProxyConfig & { _api_keys_in_system_store?: boolean })._api_keys_in_system_store,
    remote_auth_active: !!config.remote?.authentication?.auth_server,
    remote_recording_active: !!config.remote?.recording?.record_server,
    privacy_filter_active: !!config.privacy_filter?.filter_mode,
  };
}

function isSafeModelArray(value: unknown): value is DashboardModelArrayConfig {
  // Accept 1, 3, 4, 5, or 6 elements. Dashboard GET returns 3-element arrays
  // (api_key stripped, mode preserved). PUT callers normalize to 1 or 3 elements
  // before sending (see TC1214), 4 elements when mode is included, 5 with
  // transforms, and 6 with per-entry max_tokens — the same lengths the TOML
  // parser emits and validateProxyConfig accepts.
  if (!Array.isArray(value) || ![1, 3, 4, 5, 6].includes(value.length)) {
    return false;
  }
  return typeof value[0] === 'string' && value[0].trim() !== '';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// Denylist for keys copied from untrusted request-body payloads into plain
// objects via bracket assignment (obj[key] = value). JSON.parse makes
// "__proto__" an own, non-magic property, so this isn't currently
// exploitable — but assigning through a variable key (rather than a literal)
// still invokes the Object.prototype.__proto__ setter and could reintroduce
// pollution if this code is ever refactored into a generic/recursive merge.
// Reject these keys explicitly as defense in depth.
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assertSafeKey(key: string, context: string): void {
  if (DANGEROUS_KEYS.has(key)) {
    throw new Error(`Invalid key '${key}' in ${context}`);
  }
}

function validateAndNormalizeComposite(payload: unknown): Record<string, CompositeModelConfig> {
  if (!isPlainObject(payload)) {
    throw new Error('Invalid composite payload');
  }

  const result: Record<string, CompositeModelConfig> = {};
  for (const [alias, targetValue] of Object.entries(payload)) {
    assertSafeKey(alias, 'composite alias');
    if (!isPlainObject(targetValue)) {
      throw new Error(`Invalid composite targets for alias: ${alias}`);
    }
    // Defense-in-depth for the dashboard PUT bulk-save path: reject any alias
    // that lists itself as a target (e.g. "for-claw2" = {"for-claw2" = ...}).
    // Mirrors upsertCompositeTarget's runtime guard so a partial save that
    // bypasses upsertCompositeTarget still can't persist a self-reference.
    if (Object.prototype.hasOwnProperty.call(targetValue, alias)) {
      throw new Error(
        `Composite alias "${alias}" cannot list itself as a target — remove the self-reference before saving`,
      );
    }

    const targetConfig: CompositeModelConfig = {};
    for (const [key, rawValue] of Object.entries(targetValue)) {
      assertSafeKey(key, `composite.${alias}`);
      if (key === 'fusion_options') {
        if (!isPlainObject(rawValue)) throw new Error(`Invalid fusion_options for alias: ${alias}`);
        const fo = rawValue as Record<string, unknown>;
        const opts: FusionOptions = {};
        if ('min_panel' in fo) { if (typeof fo.min_panel !== 'number') throw new Error(`Invalid fusion_options.min_panel for: ${alias}`); opts.min_panel = fo.min_panel; }
        if ('panel_timeout_ms' in fo) { if (typeof fo.panel_timeout_ms !== 'number') throw new Error(`Invalid fusion_options.panel_timeout_ms for: ${alias}`); opts.panel_timeout_ms = fo.panel_timeout_ms; }
        if ('judge_required' in fo) { if (typeof fo.judge_required !== 'boolean') throw new Error(`Invalid fusion_options.judge_required for: ${alias}`); opts.judge_required = fo.judge_required; }
        if ('expose_metadata' in fo) { if (typeof fo.expose_metadata !== 'boolean') throw new Error(`Invalid fusion_options.expose_metadata for: ${alias}`); opts.expose_metadata = fo.expose_metadata; }
        if ('max_concurrent' in fo) { if (typeof fo.max_concurrent !== 'number' || fo.max_concurrent < 1) throw new Error(`Invalid fusion_options.max_concurrent for: ${alias} — must be >= 1`); opts.max_concurrent = fo.max_concurrent; }
        targetConfig.fusion_options = opts;
        continue;
      }
      if (key === 'token_limit') {
        // Support both new format {num, duration} and old format (number)
        if (typeof rawValue === 'object' && rawValue !== null && !Array.isArray(rawValue)) {
          const obj = rawValue as Record<string, unknown>;
          if (typeof obj.num !== 'number' || !Number.isFinite(obj.num)) {
            throw new Error(`Invalid token_limit.num for alias: ${alias}`);
          }
          if (typeof obj.duration !== 'string' || !(['1h', '1d', '1w', '1m'] as string[]).includes(obj.duration)) {
            throw new Error(`Invalid token_limit.duration for alias: ${alias} — must be 1h, 1d, 1w, or 1m`);
          }
          targetConfig.token_limit = { num: obj.num, duration: obj.duration as TokenLimitDuration };
        } else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
          // Backwards compat: old number-only format → treat as 30d
          targetConfig.token_limit = { num: rawValue, duration: '1m' as TokenLimitDuration };
        } else {
          throw new Error(`Invalid token_limit for alias: ${alias}`);
        }
        continue;
      }
      if (key === 'total_token_limit') {
        // Backwards compat: old format → treat as 30d
        if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
          targetConfig.token_limit = { num: rawValue, duration: '1m' as TokenLimitDuration };
        } else {
          throw new Error(`Invalid total_token_limit for alias: ${alias}`);
        }
        continue;
      }

      if (!isPlainObject(rawValue)) {
        throw new Error(`Invalid composite target config for: ${alias}.${key}`);
      }

      const entry: CompositeTargetConfig = {};
      if ('share' in rawValue) {
        if (typeof rawValue.share !== 'number' || !Number.isFinite(rawValue.share)) {
          throw new Error(`Invalid share for: ${alias}.${key}`);
        }
        entry.share = rawValue.share;
      }
      if ('primary' in rawValue) {
        if (typeof rawValue.primary !== 'boolean') {
          throw new Error(`Invalid primary for: ${alias}.${key}`);
        }
        entry.primary = rawValue.primary;
      }
      if ('fallback' in rawValue) {
        if (typeof rawValue.fallback !== 'number' || !Number.isFinite(rawValue.fallback)) {
          throw new Error(`Invalid fallback for: ${alias}.${key}`);
        }
        entry.fallback = rawValue.fallback;
      }
      if ('fusion' in rawValue) {
        if (typeof rawValue.fusion !== 'number' || !Number.isFinite(rawValue.fusion)) {
          throw new Error(`Invalid fusion for: ${alias}.${key}`);
        }
        entry.fusion = rawValue.fusion;
      }
      if ('role' in rawValue) {
        if (!(['panel', 'judge', 'synth', 'planner', 'executor'] as string[]).includes(rawValue.role as string)) {
          throw new Error(`Invalid role for: ${alias}.${key} — must be 'panel', 'judge', 'synth', 'planner', or 'executor'`);
        }
        entry.role = rawValue.role as FusionRole;
      }

      targetConfig[key] = entry;
    }

    result[alias] = targetConfig;
  }

  return result;
}

/**
 * Normalize a raw `days` value into a ScheduleDaysSpec, or undefined for
 * "everyday". Accepts "weekday"/"weekdays" and "weekend"/"weekends" in any
 * casing, or an explicit array of day-name strings (for hand-edited configs).
 * Any other value (including unrecognized strings) normalizes to undefined
 * ("everyday") rather than rejecting the update — this keeps the friendly
 * TUI/dashboard editors (which only offer weekdays/weekend/everyday) simple
 * while still round-tripping custom day arrays typed directly into TOML.
 */
function normalizeScheduleDays(days: unknown): ScheduleDaysSpec | undefined {
  const normalized = typeof days === 'string' ? days.trim().toLowerCase() : undefined;
  if (normalized === 'weekday' || normalized === 'weekdays') {
    return 'weekday';
  }
  if (normalized === 'weekend' || normalized === 'weekends') {
    return 'weekend';
  }
  if (Array.isArray(days) && days.every((d) => typeof d === 'string')) {
    return days as string[];
  }
  return undefined;
}

function validateAndNormalizeScheduleWindow(rawValue: unknown, context: string): ScheduleWindow {
  if (!isPlainObject(rawValue)) {
    throw new Error(`Invalid schedule window for: ${context}`);
  }

  const window: ScheduleWindow = {};
  if ('from' in rawValue) {
    if (typeof rawValue.from !== 'number' || !Number.isFinite(rawValue.from) || rawValue.from < 0 || rawValue.from > 24) {
      throw new Error(`Invalid from for: ${context} — must be between 0 and 24`);
    }
    window.from = rawValue.from;
  }
  if ('to' in rawValue) {
    if (typeof rawValue.to !== 'number' || !Number.isFinite(rawValue.to) || rawValue.to < 0 || rawValue.to > 24) {
      throw new Error(`Invalid to for: ${context} — must be between 0 and 24`);
    }
    window.to = rawValue.to;
  }
  if (window.from !== undefined && window.to !== undefined && window.from >= window.to) {
    throw new Error(`Invalid window for: ${context} — from must be less than to`);
  }
  if ('days' in rawValue) {
    const normalizedDays = normalizeScheduleDays(rawValue.days);
    if (normalizedDays !== undefined) {
      window.days = normalizedDays;
    }
    // else: leave window.days unset (everyday)
  }

  return window;
}

function validateAndNormalizeSchedule(payload: unknown): Record<string, ScheduleConfig> {
  if (!isPlainObject(payload)) {
    throw new Error('Invalid schedule payload');
  }

  const result: Record<string, ScheduleConfig> = {};
  for (const [alias, targetsValue] of Object.entries(payload)) {
    assertSafeKey(alias, 'schedule alias');
    if (!isPlainObject(targetsValue)) {
      throw new Error(`Invalid schedule targets for alias: ${alias}`);
    }

    const scheduleConfig: ScheduleConfig = {};
    for (const [targetName, windowsValue] of Object.entries(targetsValue)) {
      assertSafeKey(targetName, `schedule.${alias}`);
      if (!Array.isArray(windowsValue)) {
        throw new Error(`Invalid windows for: ${alias}.${targetName} — must be an array`);
      }
      scheduleConfig[targetName] = windowsValue.map((w, i) =>
        validateAndNormalizeScheduleWindow(w, `${alias}.${targetName}[${i}]`)
      );
    }

    result[alias] = scheduleConfig;
  }

  return result;
}

function validateAndNormalizeDashboardModels(payload: unknown): Record<string, DashboardModelCategoryConfig> {
  if (!isPlainObject(payload)) {
    throw new Error('Invalid models payload');
  }

  const result: Record<string, DashboardModelCategoryConfig> = {};

  for (const [categoryName, rawCategory] of Object.entries(payload)) {
    assertSafeKey(categoryName, 'models category');
    if (!isPlainObject(rawCategory)) {
      throw new Error(`Invalid models category: ${categoryName}`);
    }

    const category: DashboardModelCategoryConfig = {};
    for (const [key, value] of Object.entries(rawCategory)) {
      assertSafeKey(key, `models.${categoryName}`);
      if (key === 'api_key') {
        throw new Error(`api_key is not editable in dashboard (${categoryName})`);
      }

      if (key === 'upstream_mode' || key === 'base_url') {
        if (typeof value !== 'string') {
          throw new Error(`Invalid value for ${categoryName}.${key}`);
        }
        category[key] = value;
        continue;
      }

      if (typeof value === 'string') {
        category[key] = value;
        continue;
      }

      if (isSafeModelArray(value)) {
        // On PUT in validateAndNormalizeDashboardModels: accepts 1/3/4/5/6-element
        // arrays (same lengths as the TOML parser / validateProxyConfig) but
        // trims to the dashboard's 3-tuple display shape [target, base_url, mode]
        // (mirroring sanitizeDashboardCategoryConfig on GET). Dashboard/TUI
        // clients PUT back the same 3-element tuples they GET, so the trim is a
        // no-op for them; a raw PUT that includes index 4/5 (transforms /
        // max_tokens) is silently truncated — those fields are config-file-only.
        category[key] = value.slice(0, 3) as DashboardModelArrayConfig;
        continue;
      }

      throw new Error(`Invalid model entry for ${categoryName}.${key}`);
    }

    result[categoryName] = category;
  }

  return result;
}

export function applyDashboardConfigUpdate(baseConfig: ProxyConfig, payload: unknown): ProxyConfig {
  if (!isPlainObject(payload)) {
    throw new Error('Invalid dashboard config payload');
  }

  const modelsPayload = validateAndNormalizeDashboardModels(payload.models);
  const compositePayload = validateAndNormalizeComposite(payload.composite ?? {});
  const schedulePayload = validateAndNormalizeSchedule(payload.schedule ?? {});

  const nextConfig: ProxyConfig = {
    ...baseConfig,
    models: { ...(baseConfig.models || {}) },
    composite: compositePayload,
    schedule: payload.schedule === undefined
      ? cloneScheduleConfig(baseConfig.schedule)
      : schedulePayload,
  };

  for (const [categoryName, dashboardCategory] of Object.entries(modelsPayload)) {
    const existingCategory = nextConfig.models?.[categoryName];
    const preservedApiKey = !existingCategory || Array.isArray(existingCategory)
      ? undefined
      : existingCategory.api_key;

    const rebuiltCategory: ModelCategoryConfig = {};
    if (dashboardCategory.upstream_mode !== undefined) {
      rebuiltCategory.upstream_mode = dashboardCategory.upstream_mode;
    }
    if (dashboardCategory.base_url !== undefined) {
      rebuiltCategory.base_url = dashboardCategory.base_url;
    }
    if (preservedApiKey !== undefined) {
      rebuiltCategory.api_key = preservedApiKey;
    }

    for (const [key, value] of Object.entries(dashboardCategory)) {
      assertSafeKey(key, `models.${categoryName}`);
      if (key === 'upstream_mode' || key === 'base_url') {
        continue;
      }

      if (typeof value === 'string') {
        rebuiltCategory[key] = value;
      } else if (Array.isArray(value)) {
        const existingEntry = !existingCategory || Array.isArray(existingCategory)
          ? undefined
          : existingCategory[key];
        const preservedModelApiKey = Array.isArray(existingEntry) ? (existingEntry[2] || '') : '';
        const modelMode = value[2] || ''; // dashboard sends [target, base_url, mode]
        rebuiltCategory[key] = [value[0] || '', value[1] || '', preservedModelApiKey, modelMode];
      }
    }

    if (!nextConfig.models) {
      nextConfig.models = {};
    }
    nextConfig.models[categoryName] = rebuiltCategory;
  }

  return nextConfig;
}

export interface CompositeTargetPatch {
  share?: number | null;
  fallback?: number | null;
  primary?: boolean;
  fusion?: number | null;
  coord?: number | null;
  role?: FusionRole | null;
}

function cloneCompositeConfig(composite: ProxyConfig['composite']): Record<string, CompositeModelConfig> {
  const nextComposite: Record<string, CompositeModelConfig> = {};

  for (const [alias, targets] of Object.entries(composite || {})) {
    const nextTargets: CompositeModelConfig = {};
    if (targets && typeof targets === 'object' && !Array.isArray(targets)) {
      const aliasLimit = getCompositeTokenLimit(targets as CompositeModelConfig);
      if (aliasLimit !== undefined) {
        nextTargets.token_limit = aliasLimit;
      }
      const fusionOpts = (targets as CompositeModelConfig).fusion_options;
      if (fusionOpts && typeof fusionOpts === 'object') {
        nextTargets.fusion_options = { ...(fusionOpts as FusionOptions) };
      }
      for (const [targetModel, config] of Object.entries(targets as Record<string, unknown>)) {
        if (COMPOSITE_META_KEYS.has(targetModel)) {
          continue;
        }
        if (targetModel.startsWith('_')) {
          continue; // skip internal validation markers
        }
        if (config && typeof config === 'object' && !Array.isArray(config)) {
          nextTargets[targetModel] = { ...(config as Record<string, unknown>) } as CompositeTargetConfig;
        }
      }
    }
    nextComposite[alias] = nextTargets;
  }

  return nextComposite;
}

function assertNonEmptyCompositeName(kind: 'alias' | 'target model', value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${kind} is required`);
  }
  return trimmed;
}

export function addCompositeAlias(baseConfig: ProxyConfig, alias: string): ProxyConfig {
  const aliasName = assertNonEmptyCompositeName('alias', alias);
  // Same-name-with-model is a routing-ambiguity fatal: refuse to add the
  // alias even though the alias slot is free, so TUI / dashboard users see
  // the error and the on-disk file is never written with a conflicting name.
  if (getModelNamesInConfig(baseConfig).has(aliasName)) {
    throw new Error(
      `Composite alias name "${aliasName}" conflicts with a model defined under [models.*] — alias and model names must be unique`,
    );
  }
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    composite: cloneCompositeConfig(baseConfig.composite),
  };

  if (nextConfig.composite?.[aliasName]) {
    throw new Error(`Composite alias already exists: ${aliasName}`);
  }

  nextConfig.composite ??= {};
  nextConfig.composite[aliasName] = {};
  return nextConfig;
}

export function removeCompositeAlias(baseConfig: ProxyConfig, alias: string): ProxyConfig {
  const aliasName = assertNonEmptyCompositeName('alias', alias);
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    composite: cloneCompositeConfig(baseConfig.composite),
  };

  if (!nextConfig.composite?.[aliasName]) {
    throw new Error(`Composite alias not found: ${aliasName}`);
  }

  delete nextConfig.composite[aliasName];
  return nextConfig;
}

export function upsertCompositeAliasLimit(
  baseConfig: ProxyConfig,
  alias: string,
  tokenLimit: { num: number; duration: string } | null
): ProxyConfig {
  const aliasName = assertNonEmptyCompositeName('alias', alias);
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    composite: cloneCompositeConfig(baseConfig.composite),
  };

  const existingTargets = nextConfig.composite?.[aliasName];
  if (!existingTargets) {
    throw new Error(`Composite alias not found: ${aliasName}`);
  }

  if (tokenLimit === null) {
    delete existingTargets.token_limit;
  } else {
    const num = Number(tokenLimit.num);
    const duration = tokenLimit.duration;
    if (!Number.isFinite(num)) {
      throw new Error(`Invalid token limit num for ${aliasName}`);
    }
    if (!(['1h', '1d', '1w', '1m'] as string[]).includes(duration)) {
      throw new Error(`Invalid token limit duration for ${aliasName} — must be 1h, 1d, 1w, or 1m`);
    }
    existingTargets.token_limit = { num, duration: duration as TokenLimitDuration };
  }

  return nextConfig;
}

export function upsertGlobalTokenLimit(
  baseConfig: ProxyConfig,
  rawLimit: string | null,
): ProxyConfig {
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    general: { ...baseConfig.general },
  };
  if (rawLimit === null || rawLimit.trim() === '') {
    delete nextConfig.general!.global_token_limit;
  } else {
    nextConfig.general!.global_token_limit = normalizeHumanTokenLimit(rawLimit.trim());
  }
  return nextConfig;
}

/**
 * Normalize a raw `<num>[K|M|B|T] <1h|1d|1w|1m>` string so the unit suffix is
 * always uppercase. Preserves the duration as-is. Returns the trimmed input
 * unchanged if it doesn't match the expected shape — the parser will reject
 * invalid input elsewhere, so this is a best-effort cosmetic pass.
 */
export function normalizeHumanTokenLimit(raw: string): string {
  const m = raw.match(/^([\d.]+)\s*([kKmMbBtT]?)\s+(\d{1,2})([hHdDwWmM])$/);
  if (!m) return raw.trim();
  const [, num, suffix, count, unit] = m;
  const upperSuffix = suffix ? suffix.toUpperCase() : '';
  return `${num}${upperSuffix} ${count}${unit}`;
}

export function upsertFusionOptions(
  baseConfig: ProxyConfig,
  alias: string,
  options: FusionOptions | null,
): ProxyConfig {
  const aliasName = assertNonEmptyCompositeName('alias', alias);
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    composite: cloneCompositeConfig(baseConfig.composite),
  };

  const existingTargets = nextConfig.composite?.[aliasName];
  if (!existingTargets) {
    throw new Error(`Composite alias not found: ${aliasName}`);
  }

  if (options === null) {
    delete existingTargets.fusion_options;
  } else {
    existingTargets.fusion_options = { ...(existingTargets.fusion_options ?? {}), ...options };
  }

  return nextConfig;
}

export function upsertCompositeTarget(
  baseConfig: ProxyConfig,
  alias: string,
  targetModel: string,
  patch: CompositeTargetPatch = {},
  configuredModelIds: string[] = [],
): ProxyConfig {
  const aliasName = assertNonEmptyCompositeName('alias', alias);
  const targetName = assertNonEmptyCompositeName('target model', targetModel);
  // A composite alias must not list itself as one of its targets — that's a
  // routing self-reference and is always wrong. Rejected here so TUI /
  // dashboard save paths (and the dashboard PUT path via applyDashboardConfigUpdate)
  // never persist this kind of cycle.
  if (targetName === aliasName) {
    throw new Error(
      `Composite alias "${aliasName}" cannot list itself as a target — remove the self-reference before saving`,
    );
  }
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    composite: cloneCompositeConfig(baseConfig.composite),
  };

  nextConfig.composite ??= {};
  const existingTargets = nextConfig.composite[aliasName] ?? {};
  const targetExists = !!existingTargets[targetName];
  if (!targetExists && configuredModelIds.length > 0 && !configuredModelIds.includes(targetName)) {
    throw new Error(`Unknown target model: ${targetName}`);
  }

  const nextTargets: CompositeModelConfig = {};
  const existingLimit = getCompositeTokenLimit(existingTargets);
  if (existingLimit !== undefined) {
    nextTargets.token_limit = existingLimit;
  }
  for (const [name, config] of Object.entries(existingTargets)) {
    if (name === 'token_limit') {
      continue;
    }
    if (config && typeof config === 'object' && !Array.isArray(config)) {
      nextTargets[name] = { ...(config as Record<string, unknown>) } as CompositeTargetConfig;
    }
  }

  const currentTarget = nextTargets[targetName];
  const nextTarget: CompositeTargetConfig = (currentTarget && typeof currentTarget === 'object' && !Array.isArray(currentTarget))
    ? { ...(currentTarget as Record<string, unknown>) } as CompositeTargetConfig
    : {};

  if (patch.share !== undefined) {
    if (patch.share === null) {
      delete nextTarget.share;
    } else if (!Number.isFinite(patch.share)) {
      throw new Error(`Invalid share for ${aliasName}.${targetName}`);
    } else {
      nextTarget.share = patch.share;
    }
  }

  if (patch.fallback !== undefined) {
    if (patch.fallback === null || patch.fallback === 0) {
      delete nextTarget.fallback;
    } else if (!Number.isFinite(patch.fallback)) {
      throw new Error(`Invalid fallback for ${aliasName}.${targetName}`);
    } else {
      nextTarget.fallback = patch.fallback;
    }
  }

  if (patch.primary === true) {
    for (const [name, config] of Object.entries(nextTargets)) {
      // Skip token_limit and non-object configs; also skip if it has 'num'/'duration' (TokenLimitConfig)
      if (name === 'token_limit' || !config || typeof config !== 'object' || Array.isArray(config)) {
        continue;
      }
      const cfg = config as Record<string, unknown>;
      if ('num' in cfg || 'duration' in cfg) continue; // TokenLimitConfig
      delete cfg.primary;
    }
    nextTarget.primary = true;
    nextTarget.fallback = 0;
  } else if (patch.primary === false) {
    delete nextTarget.primary;
  }

  if (patch.fusion !== undefined) {
    if (patch.fusion === null || patch.fusion === 0) {
      delete nextTarget.fusion;
    } else if (!Number.isFinite(patch.fusion) || patch.fusion < 0) {
      throw new Error(`Invalid fusion weight for ${aliasName}.${targetName}`);
    } else {
      nextTarget.fusion = patch.fusion;
    }
  }

  if (patch.coord !== undefined) {
    if (patch.coord === null || patch.coord === 0) {
      delete nextTarget.coord;
    } else if (!Number.isFinite(patch.coord) || patch.coord < 0) {
      throw new Error(`Invalid coord for ${aliasName}.${targetName}`);
    } else {
      nextTarget.coord = patch.coord;
    }
  }

  if (patch.role !== undefined) {
    if (patch.role === null) {
      delete nextTarget.role;
    } else if (!(['panel', 'judge', 'synth', 'planner', 'executor'] as string[]).includes(patch.role)) {
      throw new Error(`Invalid role for ${aliasName}.${targetName} — must be panel, judge, synth, planner, or executor`);
    } else {
      nextTarget.role = patch.role;
    }
  }

  nextTargets[targetName] = nextTarget;
  nextConfig.composite[aliasName] = nextTargets;
  return nextConfig;
}

export function removeCompositeTarget(baseConfig: ProxyConfig, alias: string, targetModel: string): ProxyConfig {
  const aliasName = assertNonEmptyCompositeName('alias', alias);
  const targetName = assertNonEmptyCompositeName('target model', targetModel);
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    composite: cloneCompositeConfig(baseConfig.composite),
  };

  const existingTargets = nextConfig.composite?.[aliasName];
  if (!existingTargets) {
    throw new Error(`Composite alias not found: ${aliasName}`);
  }
  if (!existingTargets[targetName]) {
    throw new Error(`Composite target not found: ${aliasName}.${targetName}`);
  }

  delete existingTargets[targetName];
  return nextConfig;
}

const MODEL_TARGET_UPSTREAM_MODES: TransformSchema[] = ['openai-completions', 'anthropic-messages', 'openai-responses', 'gemini-generatecontent'];

export interface ModelTargetPatch {
  target: string;
  base_url: string;
  api_key: string;
  mode: string;
}

/**
 * Add or update a `[models.<category>]` entry. `aliasKey` is the client-facing
 * name the entry is keyed under; `patch.target` is the upstream model id
 * (index 0 of the on-disk array). Internal entries are
 * `[target, base_url, api_key, mode, transforms, max_tokens]` — this function
 * only owns indices 0-3 and carries indices 4-5 over unchanged when editing.
 */
export function upsertModelTarget(
  baseConfig: ProxyConfig,
  category: string,
  aliasKey: string,
  patch: ModelTargetPatch,
): ProxyConfig {
  const categoryName = assertNonEmptyCompositeName('alias', category);
  const key = assertNonEmptyCompositeName('target model', aliasKey);
  const target = patch.target.trim();
  if (!target) {
    throw new Error('Target model id is required');
  }
  if (!MODEL_TARGET_UPSTREAM_MODES.includes(patch.mode as TransformSchema)) {
    throw new Error(`Invalid upstream mode: ${patch.mode} — must be one of ${MODEL_TARGET_UPSTREAM_MODES.join(', ')}`);
  }

  const nextModels: Record<string, ModelCategoryConfig | ModelArrayConfig> = { ...(baseConfig.models || {}) };
  const existingCategory = nextModels[categoryName];
  const nextCategory: ModelCategoryConfig = (existingCategory && !Array.isArray(existingCategory))
    ? { ...existingCategory }
    : {};

  const existingEntry = nextCategory[key];
  const [, , existingApiKey, , transforms, max_tokens] = Array.isArray(existingEntry) ? existingEntry : [];
  // The sentinel is only ever safe when it already sat in this exact slot
  // (edit, left untouched) — applySystemKeyStore backs it with a real
  // keychain entry in that case. A hand-typed sentinel (add, or edit where
  // it wasn't already that value) has no such entry and would resolve
  // against whatever stale/unrelated keychain item happens to share the
  // account (wrong key, no error) instead of failing loud. See CHANGELOG.
  if (patch.api_key === STORE_KEY_IN_SYSTEM && existingApiKey !== STORE_KEY_IN_SYSTEM) {
    throw new Error(
      `api_key cannot be the literal "${STORE_KEY_IN_SYSTEM}" — that sentinel is only written by the system key store` +
      ` after it stores a real key; type the actual key instead.`,
    );
  }
  // Blank api_key: before falling through to empty (→ category api_key at
  // resolve time), check sibling entries in this same category for one
  // already backed by the system keychain (STORE_KEY_IN_SYSTEM) whose
  // effective base_url (entry base_url, falling back to the category's)
  // matches this entry's — same base_url-only scoring the keychain
  // best-effort resolver uses, target name intentionally not considered.
  // If found, adopt the sentinel so this entry resolves from the same
  // keychain account instead of silently landing on category api_key.
  let apiKey = patch.api_key;
  if (!apiKey.trim()) {
    const categoryBaseUrl = nextCategory.base_url ?? '';
    const wantedBaseUrl = patch.base_url || categoryBaseUrl;
    let bestScore = -1;
    for (const [siblingKey, siblingEntry] of Object.entries(nextCategory)) {
      if (siblingKey === key || !Array.isArray(siblingEntry) || siblingEntry.length < 3) continue;
      if (siblingEntry[2] !== STORE_KEY_IN_SYSTEM) continue;
      const siblingBaseUrl = (siblingEntry[1] as string) || categoryBaseUrl;
      const score = scoreBaseUrlMatch(wantedBaseUrl, siblingBaseUrl);
      if (score > bestScore) bestScore = score;
    }
    if (bestScore >= 0) {
      apiKey = STORE_KEY_IN_SYSTEM;
    }
  }
  const nextEntry: string[] = [target, patch.base_url, apiKey, patch.mode];
  if (transforms !== undefined || max_tokens !== undefined) {
    nextEntry.push(transforms ?? '', max_tokens ?? '');
  }

  nextCategory[key] = nextEntry;
  nextModels[categoryName] = nextCategory;

  return { ...baseConfig, models: nextModels };
}

function cloneScheduleConfig(schedule: ProxyConfig['schedule']): Record<string, ScheduleConfig> {
  const nextSchedule: Record<string, ScheduleConfig> = {};

  for (const [alias, targets] of Object.entries(schedule || {})) {
    const nextTargets: ScheduleConfig = {};
    for (const [targetName, windows] of Object.entries(targets || {})) {
      if (Array.isArray(windows)) {
        nextTargets[targetName] = windows.map((w) => ({ ...w }));
      }
    }
    nextSchedule[alias] = nextTargets;
  }

  return nextSchedule;
}

function assertNonEmptyScheduleName(kind: 'alias' | 'target', value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`schedule ${kind} is required`);
  }
  return trimmed;
}

export function addScheduleAlias(baseConfig: ProxyConfig, alias: string): ProxyConfig {
  const aliasName = assertNonEmptyScheduleName('alias', alias);
  // Same-name-with-model is a routing-ambiguity fatal: refuse to add the
  // alias even though the alias slot is free. See addCompositeAlias for the
  // matching composite-side rationale.
  if (getModelNamesInConfig(baseConfig).has(aliasName)) {
    throw new Error(
      `Schedule alias name "${aliasName}" conflicts with a model defined under [models.*] — alias and model names must be unique`,
    );
  }
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    schedule: cloneScheduleConfig(baseConfig.schedule),
  };

  if (nextConfig.schedule?.[aliasName]) {
    throw new Error(`Schedule alias already exists: ${aliasName}`);
  }

  nextConfig.schedule ??= {};
  nextConfig.schedule[aliasName] = {};
  return nextConfig;
}

export function removeScheduleAlias(baseConfig: ProxyConfig, alias: string): ProxyConfig {
  const aliasName = assertNonEmptyScheduleName('alias', alias);
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    schedule: cloneScheduleConfig(baseConfig.schedule),
  };

  if (!nextConfig.schedule?.[aliasName]) {
    throw new Error(`Schedule alias not found: ${aliasName}`);
  }

  delete nextConfig.schedule[aliasName];
  return nextConfig;
}

/**
 * Add or replace the full window list for a target within a schedule alias.
 * Pass an empty array to mark the target as the fallback (always-eligible)
 * entry, matching the `[]` convention used in the TOML config.
 */
export function upsertScheduleWindow(
  baseConfig: ProxyConfig,
  alias: string,
  targetModel: string,
  windows: ScheduleWindow[],
  configuredModelIds: string[] = [],
): ProxyConfig {
  const aliasName = assertNonEmptyScheduleName('alias', alias);
  const targetName = assertNonEmptyScheduleName('target', targetModel);
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    schedule: cloneScheduleConfig(baseConfig.schedule),
  };

  nextConfig.schedule ??= {};
  const existingTargets = nextConfig.schedule[aliasName] ?? {};
  const targetExists = !!existingTargets[targetName];
  if (!targetExists && configuredModelIds.length > 0 && !configuredModelIds.includes(targetName)) {
    throw new Error(`Unknown target model: ${targetName}`);
  }

  if (!Array.isArray(windows)) {
    throw new Error(`Invalid windows for ${aliasName}.${targetName}`);
  }
  for (const w of windows) {
    if (w.from !== undefined && (!Number.isFinite(w.from) || w.from < 0 || w.from > 24)) {
      throw new Error(`Invalid from for ${aliasName}.${targetName}`);
    }
    if (w.to !== undefined && (!Number.isFinite(w.to) || w.to < 0 || w.to > 24)) {
      throw new Error(`Invalid to for ${aliasName}.${targetName}`);
    }
    if (w.from !== undefined && w.to !== undefined && w.from >= w.to) {
      throw new Error(`Invalid window for ${aliasName}.${targetName} — from must be less than to`);
    }
  }

  existingTargets[targetName] = windows.map((w) => {
    const normalized: ScheduleWindow = { ...w };
    if ('days' in w) {
      const normalizedDays = normalizeScheduleDays(w.days);
      if (normalizedDays !== undefined) {
        normalized.days = normalizedDays;
      } else {
        delete normalized.days;
      }
    }
    return normalized;
  });
  nextConfig.schedule[aliasName] = existingTargets;
  return nextConfig;
}

export function removeScheduleTarget(baseConfig: ProxyConfig, alias: string, targetModel: string): ProxyConfig {
  const aliasName = assertNonEmptyScheduleName('alias', alias);
  const targetName = assertNonEmptyScheduleName('target', targetModel);
  const nextConfig: ProxyConfig = {
    ...baseConfig,
    schedule: cloneScheduleConfig(baseConfig.schedule),
  };

  const existingTargets = nextConfig.schedule?.[aliasName];
  if (!existingTargets) {
    throw new Error(`Schedule alias not found: ${aliasName}`);
  }
  if (!existingTargets[targetName]) {
    throw new Error(`Schedule target not found: ${aliasName}.${targetName}`);
  }

  delete existingTargets[targetName];
  return nextConfig;
}

export function persistProxyConfigToPath(configPath: string, config: ProxyConfig): void {
  const serialized = serializeProxyConfigToml(config);

  // Integrity check: the serialized form must round-trip back to the same
  // composite/model structure. A lossy serialize would otherwise silently
  // erase config (e.g. composite aliases) on the next reload.
  const reparsed = parseSimpleToml(serialized);
  const expectedComposite = Object.keys(config.composite || {}).sort();
  const actualComposite = Object.keys(reparsed.composite || {}).sort();
  if (expectedComposite.length !== actualComposite.length ||
      expectedComposite.some((k, i) => k !== actualComposite[i])) {
    throw new Error(
      `Config serialization integrity check failed: composite aliases changed on round-trip ` +
      `(expected [${expectedComposite.join(', ')}], got [${actualComposite.join(', ')}])`
    );
  }

  const expectedSchedule = Object.keys(config.schedule || {}).sort();
  const actualSchedule = Object.keys(reparsed.schedule || {}).sort();
  if (expectedSchedule.length !== actualSchedule.length ||
      expectedSchedule.some((k, i) => k !== actualSchedule[i])) {
    throw new Error(
      `Config serialization integrity check failed: schedule aliases changed on round-trip ` +
      `(expected [${expectedSchedule.join(', ')}], got [${actualSchedule.join(', ')}])`
    );
  }

  if ((config.dashboard?.api_key || '') !== (reparsed.dashboard?.api_key || '')) {
    throw new Error('Config serialization integrity check failed: dashboard.api_key changed on round-trip');
  }

  const expectedTransforms = Object.keys(config.transforms || {}).sort();
  const actualTransforms = Object.keys(reparsed.transforms || {}).sort();
  if (expectedTransforms.length !== actualTransforms.length ||
      expectedTransforms.some((k, i) => k !== actualTransforms[i])) {
    throw new Error(
      `Config serialization integrity check failed: transforms set names changed on round-trip ` +
      `(expected [${expectedTransforms.join(', ')}], got [${actualTransforms.join(', ')}])`
    );
  }

  const expectedTransformDefaults = Object.keys(config.transform_defaults || {}).sort();
  const actualTransformDefaults = Object.keys(reparsed.transform_defaults || {}).sort();
  if (expectedTransformDefaults.length !== actualTransformDefaults.length ||
      expectedTransformDefaults.some((k, i) => k !== actualTransformDefaults[i])) {
    throw new Error(
      `Config serialization integrity check failed: transform_defaults keys changed on round-trip ` +
      `(expected [${expectedTransformDefaults.join(', ')}], got [${actualTransformDefaults.join(', ')}])`
    );
  }

  // Atomic write: write to a temp file, back up the existing config, then rename.
  const tempPath = `${configPath}.tmp`;
  writeFileSync(tempPath, serialized, 'utf-8');
  if (existsSync(configPath)) {
    copyFileSync(configPath, `${configPath}.bak`);
  }
  renameSync(tempPath, configPath);
}

export function loadProxyConfigFromPath(configPath: string): ProxyConfig {
  const content = readFileSync(configPath, 'utf-8');
  const config = parseSimpleToml(content);
  const { config: strippedConfig, stripped } = stripConflictingAliases(config);
  if (stripped.composite.length > 0 || stripped.schedule.length > 0) {
    for (const alias of stripped.composite) {
      console.error(`[FATAL] Refusing to load composite alias "${alias}" — alias name conflicts with a model defined under [models.*]`);
    }
    for (const alias of stripped.schedule) {
      console.error(`[FATAL] Refusing to load schedule alias "${alias}" — alias name conflicts with a model defined under [models.*]`);
    }
  }
  const { config: cleanedConfig, stripped: selfRef } = stripSelfReferencingCompositeTargets(strippedConfig);
  for (const [alias, badTargets] of Object.entries(selfRef)) {
    for (const target of badTargets) {
      console.error(`[FATAL] Refusing to load composite target "${alias}.${target}" — composite alias cannot list itself as a target`);
    }
  }
  return cleanedConfig;
}

export interface OpenClawProviderModelConfig {
  id: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  [key: string]: unknown;
}

export interface OpenClawProviderConfig {
  id: string;
  baseUrl?: string;
  apiKey?: string;
  apiSchema?: 'anthropic-messages' | 'openai-completions';
  models?: OpenClawProviderModelConfig[];
  [key: string]: unknown;
}

export interface OpenClawConfig {
  models?: {
    providers?: OpenClawProviderConfig[];
    [key: string]: unknown;
  };
  agents?: {
    defaults?: {
      models?: string[];
      model?: {
        primary?: string;
        fallback?: string;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export const DEFAULT_OPENCLAW_CONFIG_PATH = join(homedir(), '.openclaw', 'openclaw.json');

export function resolveOpenClawConfigPath(configPath?: string | null): string {
  const trimmed = configPath?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_OPENCLAW_CONFIG_PATH;
}

export function loadOpenClawConfigFromPath(configPath = DEFAULT_OPENCLAW_CONFIG_PATH): OpenClawConfig {
  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content);
    return isPlainObject(parsed) ? (parsed as OpenClawConfig) : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

export function persistOpenClawConfigToPath(configPath: string, config: OpenClawConfig): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}
