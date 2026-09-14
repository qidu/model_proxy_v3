/**
 * Pure, injectable pieces for the remote target-retry ladder.
 *
 * The ladder itself lives in the request handler (`src/index.ts`) because
 * `buildRouteAttempt` / `runAttempt` are closures there. This module only
 * holds the parts that need no request state: parsing the auth `targets`
 * array, per-entry validation, descriptor → self-contained `ModelRouteConfig`,
 * and outcome classification.
 *
 * See `docs/plan-remote-target-retry-dispatch.md` (Phase 1: auth targets
 * failover).
 */

import type { ProxyConfig, ModelRouteConfig } from './config-loader.js';
import { resolveTransforms } from './config-loader.js';
import { ClaudeProxyError, classifyTransportError } from './errors.js';
import { UPSTREAM_MODES } from './upstream-modes.js';

/** Cap on the remote-supplied `targets[]` ladder length when `[remote] max_targets` is unset. */
export const DEFAULT_MAX_TARGETS = 4;
/** Same-target (axis 2) retries per entry when `[remote] max_target_retries` is unset. 0 disables. */
export const DEFAULT_MAX_TARGET_RETRIES = 1;

/**
 * One entry of a remote `targets[]` array. `target` and `base` are REQUIRED
 * (self-contained — a model with no `[models.*]` entry has nothing to inherit
 * a destination from, and the config fallback is `http://localhost`).
 */
export interface RemoteTargetDescriptor {
  /** Upstream model id. */
  target: string;
  /** Upstream base URL. */
  base: string;
  /** Upstream wire mode; absent ⇒ `[default_upstream].upstream_mode` → `openai-completions`. */
  mode?: string;
  /** API key; absent/empty ⇒ normal client-key passthrough. */
  key?: string;
  /** Replaces `modelUsageOneTimeAuthCode` for this rung. */
  otac?: string;
  /** Comma-separated `[transforms.*]` names. */
  transforms?: string;
  /** Per-route abort deadline, ms. */
  timeout?: number;
  /** Axis 2 only: statuses worth re-hitting THIS target on. */
  retry_on?: number[];
}

/** A raw, unvalidated `targets[]` element. */
export type RawTargetEntry = Record<string, unknown>;

export interface DroppedEntry {
  entry: RawTargetEntry;
  reason: string;
}

export interface ValidatedTargets {
  valid: RemoteTargetDescriptor[];
  dropped: DroppedEntry[];
}

/**
 * Extract the `targets` array from an auth `200` body. Accepts either
 * `{ "targets": [...] }` or a bare array. Returns only object entries; a
 * missing/empty/malformed body yields `[]` (⇒ normal config resolution).
 */
export function parseAuthTargets(rawBody: string | undefined | null): RawTargetEntry[] {
  if (!rawBody) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return [];
  }

  const arr = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { targets?: unknown }).targets)
      ? (parsed as { targets: unknown[] }).targets
      : [];

  return arr.filter(
    (item): item is RawTargetEntry => item !== null && typeof item === 'object' && !Array.isArray(item),
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validate raw `targets[]` entries into descriptors. Each entry failing a
 * check is dropped with a reason (the caller logs it) and the ladder continues
 * with the rest — including when the offending entry is `targets[0]`.
 *
 * A rung's `base` host is NOT checked against the config allowlist: the auth
 * server is a trusted routing authority, and a self-contained descriptor's
 * destination host need not appear as a configured model base_url.
 */
export function validateDescriptorEntries(raw: RawTargetEntry[]): ValidatedTargets {
  const valid: RemoteTargetDescriptor[] = [];
  const dropped: DroppedEntry[] = [];

  for (const entry of raw) {
    const reason = validateEntry(entry);
    if (reason) {
      dropped.push({ entry, reason });
      continue;
    }

    const descriptor: RemoteTargetDescriptor = {
      target: entry.target as string,
      base: entry.base as string,
    };
    if (isNonEmptyString(entry.mode)) descriptor.mode = entry.mode;
    if (isNonEmptyString(entry.key)) descriptor.key = entry.key;
    if (isNonEmptyString(entry.otac)) descriptor.otac = entry.otac;
    if (typeof entry.transforms === 'string' && entry.transforms.trim()) descriptor.transforms = entry.transforms;
    if (typeof entry.timeout === 'number') descriptor.timeout = entry.timeout;
    if (Array.isArray(entry.retry_on)) descriptor.retry_on = entry.retry_on as number[];

    valid.push(descriptor);
  }

  return { valid, dropped };
}

/** Returns a human-readable reason when `entry` is invalid, else `undefined`. */
function validateEntry(entry: RawTargetEntry): string | undefined {
  if (!isNonEmptyString(entry.target)) return 'target must be a non-empty string';

  if (!isNonEmptyString(entry.base)) return 'base must be a non-empty string (required; no inherit-from-config)';

  try {
    new URL(entry.base);
  } catch {
    return `base is not a valid URL: ${entry.base}`;
  }

  if (entry.mode !== undefined && entry.mode !== null) {
    if (typeof entry.mode !== 'string' || !(UPSTREAM_MODES as readonly string[]).includes(entry.mode)) {
      return `unknown mode '${String(entry.mode)}' (expected one of: ${UPSTREAM_MODES.join(', ')})`;
    }
  }

  for (const field of ['key', 'otac', 'transforms'] as const) {
    const value = entry[field];
    if (value !== undefined && value !== null && typeof value !== 'string') {
      return `${field} must be a string`;
    }
  }

  if (entry.timeout !== undefined && entry.timeout !== null) {
    if (typeof entry.timeout !== 'number' || !Number.isFinite(entry.timeout) || entry.timeout <= 0) {
      return 'timeout must be a finite positive number';
    }
  }

  if (entry.retry_on !== undefined && entry.retry_on !== null) {
    const r = entry.retry_on;
    if (!Array.isArray(r) || !r.every(n => typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n))) {
      return 'retry_on must be an array of finite integers';
    }
  }

  return undefined;
}

/**
 * Drop duplicate entries (key `target@base@key` — two entries differing only by
 * key are a legitimate rotation pair and are kept) then cap the ladder length.
 * Order matters: dedupe before cap so a repeated entry cannot consume a slot.
 */
export function dedupeAndCap(
  entries: RemoteTargetDescriptor[],
  maxTargets: number = DEFAULT_MAX_TARGETS,
): RemoteTargetDescriptor[] {
  const seen = new Set<string>();
  const out: RemoteTargetDescriptor[] = [];
  for (const entry of entries) {
    const key = `${entry.target}@${entry.base}@${entry.key ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }

  if (Number.isFinite(maxTargets) && maxTargets > 0) {
    return out.slice(0, Math.floor(maxTargets));
  }
  return out;
}

/**
 * Build a self-contained `ModelRouteConfig` from a descriptor — no config
 * resolution, no inheritance chain. `target` becomes `modelAlias` so
 * `buildRouteAttempt` sends it as the upstream model id.
 *
 * When a `key` is present, `explicitApiKey` is set so `buildRouteAttempt`
 * applies it unconditionally — that is the returned key overriding the caller's
 * credential even when the client did not opt into
 * `auth_passthrough_with = "config_key"`.
 */
export function descriptorToRoute(descriptor: RemoteTargetDescriptor, proxyConfig: ProxyConfig): ModelRouteConfig {
  const mode = descriptor.mode || proxyConfig.default_upstream?.upstream_mode || 'openai-completions';
  return {
    targetUrl: descriptor.base,
    apiKey: descriptor.key,
    upstreamMode: mode,
    modelAlias: descriptor.target,
    explicitApiKey: !!descriptor.key,
    transforms: resolveTransforms(mode, undefined, descriptor.transforms, proxyConfig),
    timeout: descriptor.timeout,
  };
}

/**
 * Outcome of one attempt. `status` is the HTTP status when a Response was
 * obtained, or a synthetic status for a thrown error (transport → 502,
 * timeout/abort → 504); `0` marks an unclassifiable error (never retryable).
 */
export interface AttemptOutcome {
  ok: boolean;
  status: number;
  response?: Response;
  error?: unknown;
}

/** Classify a returned Response. `status >= 400` is a failure. */
export function outcomeFromResponse(response: Response): AttemptOutcome {
  return { ok: response.status < 400, status: response.status, response };
}

/** Classify a caught error via its status, or `classifyTransportError`. */
export function outcomeFromError(error: unknown): AttemptOutcome {
  if (error instanceof ClaudeProxyError) {
    return { ok: false, status: error.status, error };
  }
  const classified = classifyTransportError(error);
  if (classified) {
    return { ok: false, status: classified.status, error };
  }
  return { ok: false, status: 0, error };
}

/**
 * Axis 1 trigger set. `classifyTransportError` already maps transport failures
 * to 502 and timeouts to 504 before this runs, so only two comparisons are
 * needed: 429 and any 5xx are worth trying a different target; deterministic
 * 4xx terminal responses are not.
 */
export function isRetryableOutcome(outcome: AttemptOutcome): boolean {
  return outcome.status === 429 || outcome.status >= 500;
}
