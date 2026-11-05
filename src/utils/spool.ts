/**
 * SSD spool — configuration surface.
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md (§5.5, §5.6, §5.8).
 *
 * This module owns the `[spool]` config resolution, the startup directory checks
 * and the §5.5 sweep of spills left by an earlier run. The §5.4 blob store lives
 * in `blob-store.ts` (with its own startup sweep); its leases, refs and the §9.3
 * inline-binary predicates land in later phases. The ingress keys gate the live
 * request path (§5.1) and `threshold_bytes`/`max_response_bytes` gate the
 * per-event response framing (§5.7), so an opt-in `[spool] enabled = true` spills
 * large request bodies and large SSE events to disk; `max_request_bytes` is
 * enforced on ingress and `max_total_bytes` against the live spill budget.
 *
 * The §5.8 external-upload keys (`external_upload_url` and friends) are parsed
 * and validated here. `externalUpload` stays `null` unless an operator opts in,
 * and that is the state in which `auth_with_body` keeps receiving the full inline
 * body; when it is set, the request path uploads the extracted blobs and projects
 * them into external links at the §5.3 shape-2 boundary (`src/index.ts`).
 *
 * Decisions baked in here:
 *   - Opt-in (`enabled = false` by default, §9.1): an operator who never writes
 *     a `[spool]` section gets exactly today's behavior.
 *   - Fail loud (repo rule #8): an unusable directory throws. A spool config
 *     that silently degrades to the in-memory path would move the memory
 *     backpressure problem somewhere invisible.
 *   - TOML-only for now. `SPOOL_*` env overrides are deliberately not
 *     implemented yet: `isEnvFlagEnabled` lives in dashboard-stats.ts, which
 *     already imports from config-loader.ts, so taking that dependency here
 *     would close a config-loader → spool → dashboard-stats → config-loader
 *     import cycle.
 */

import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, statfsSync, unlinkSync, writeFileSync, type Dirent } from 'fs';
import { homedir } from 'os';
import { isAbsolute, join } from 'path';

/** `[spool]` keys as written in proxy_config.toml (all optional). */
export interface SpoolTomlConfig {
  enabled?: boolean;
  dir?: string;
  threshold_bytes?: number;
  max_request_bytes?: number;
  max_response_bytes?: number;
  max_total_bytes?: number;
  max_materialized_body_bytes?: number;
  materialization_factor?: number;
  max_admission_queue?: number;
  admission_timeout_ms?: number;
  max_blob_cache_bytes?: number;
  max_blob_disk_bytes?: number;
  ttl_seconds?: number;
  external_upload_url?: string;
  external_upload_token?: string;
  external_upload_timeout_ms?: number;
  external_url_min_lifetime_s?: number;
}

/** Resolved `[spool]` config: every key present, `dir` absolute. */
export interface SpoolConfig {
  enabled: boolean;
  dir: string;
  /** Below this, a body stays on the bounded in-memory path. */
  thresholdBytes: number;
  /** One request body, in bytes. Preserves the current 10 MiB default. */
  maxRequestBytes: number;
  /** One JSON response body or one SSE event, in bytes. */
  maxResponseBytes: number;
  /** Live request/response/event spills — not L1/L2 cache bytes. */
  maxTotalBytes: number;
  /** Optional §5.9 nominal RAM budget; 0 disables the admission check. */
  maxMaterializedBodyBytes: number;
  /** Copy/object overhead multiplier for the §5.9 budget. */
  materializationFactor: number;
  /** Maximum waiting large bodies/events. */
  maxAdmissionQueue: number;
  /** Maximum admission wait before the body is refused. */
  admissionTimeoutMs: number;
  /** L1 payload bytes held in RAM. */
  maxBlobCacheBytes: number;
  /** L2 payload bytes on disk, excluding spills. */
  maxBlobDiskBytes: number;
  /** Idle TTL after the last lease release — not a send deadline. */
  ttlSeconds: number;
  /**
   * §5.8 external upload, or `null` when no uploader is configured.
   *
   * `null` is the state in which auth keeps receiving the full body, so the
   * resolver — not a caller — decides it: a stray token or lifetime without an
   * `external_upload_url` is a config error, never a silently inert uploader.
   */
  externalUpload: SpoolExternalUploadConfig | null;
}

/**
 * §5.8 external upload: the opt-in that lets user binary leave the proxy host.
 *
 * The proxy streams each L2 blob to `uploadUrl` and expects back a short-lived
 * signed download URL; it stores no object-store credentials and signs nothing
 * itself. Only an explicit `[spool] external_upload_url` produces this object.
 */
export interface SpoolExternalUploadConfig {
  /** HTTPS endpoint that receives the blob and answers with a signed URL. */
  uploadUrl: string;
  /** Optional bearer token for that endpoint. Never logged. */
  token: string | null;
  /** One blob upload, in milliseconds. */
  uploadTimeoutMs: number;
  /** Shortest signed-URL lifetime the uploader accepts, in seconds. */
  urlMinLifetimeSeconds: number;
}

/** Fatal error: loadProxyConfig must rethrow instead of degrading to `{}`. */
export class SpoolConfigError extends Error {
  fatal = true;
}

/** §5.6 defaults. Also the per-key fallback in {@link resolveSpoolConfig}. */
export const SPOOL_DEFAULTS = {
  enabled: false,
  dir: join(homedir(), '.cache', 'model-proxy', 'spool'),
  thresholdBytes: 1048576,
  maxRequestBytes: 10485760,
  maxResponseBytes: 67108864,
  maxTotalBytes: 2147483648,
  maxMaterializedBodyBytes: 0,
  materializationFactor: 2.0,
  maxAdmissionQueue: 64,
  admissionTimeoutMs: 30000,
  maxBlobCacheBytes: 67108864,
  maxBlobDiskBytes: 268435456,
  ttlSeconds: 600,
  externalUpload: null,
} as const satisfies SpoolConfig;

/**
 * §5.8 defaults for the external uploader, applied once `external_upload_url`
 * opts in. Mirrors {@link SPOOL_DEFAULTS}: every key has a fallback.
 */
export const EXTERNAL_UPLOAD_DEFAULTS = {
  uploadTimeoutMs: 30000,
  urlMinLifetimeSeconds: 900,
} as const;

/**
 * Lower bound for `external_url_min_lifetime_s`.
 *
 * §5.8 wants the signed URL to outlive the auth fetch it is handed to. The
 * proxy cannot check that: it has no auth timeout to compare against, so it
 * only refuses lifetimes short enough to be a mistake. A lifetime at or above
 * this floor is accepted on the operator's word, not verified.
 */
export const EXTERNAL_URL_MIN_LIFETIME_FLOOR_S = 60;

/**
 * Integer keys and whether 0 is a legal value.
 * `max_materialized_body_bytes = 0` disables the §5.9 admission budget; every
 * other limit has to be a positive byte/entry count — 0 there would mean "spool
 * nothing ever", which an operator means as `enabled = false`.
 */
const INTEGER_KEYS: ReadonlyArray<readonly [keyof SpoolTomlConfig, boolean]> = [
  ['threshold_bytes', false],
  ['max_request_bytes', false],
  ['max_response_bytes', false],
  ['max_total_bytes', false],
  ['max_materialized_body_bytes', true],
  ['max_admission_queue', false],
  ['admission_timeout_ms', false],
  ['max_blob_cache_bytes', false],
  ['max_blob_disk_bytes', false],
  ['ttl_seconds', false],
];

/** tmpfs / ramfs magic numbers from `statfs(2)` (linux). */
const RAM_BACKED_FS_MAGIC = new Set<number>([
  0x01021994, // TMPFS_MAGIC
  0x858458f6, // RAMFS_MAGIC
]);

/**
 * True when a `statfs` f_type denotes a RAM-backed filesystem, i.e. the spool
 * would compete with the process for the very memory it is meant to release.
 */
export function isRamBackedFsType(type: number): boolean {
  return RAM_BACKED_FS_MAGIC.has(type);
}

/**
 * Warn when the spool directory sits on tmpfs/ramfs. Never throws: an unknown
 * filesystem is reported (rule #8 — no silent "assume it is fine") and then
 * treated as disk-backed, since the alternative would be refusing to start on
 * platforms whose `statfs` does not exist.
 */
export function isRamBackedSpoolDir(dir: string): boolean {
  try {
    const stats = statfsSync(dir);
    return isRamBackedFsType(Number(stats.type));
  } catch (error) {
    console.warn(`[spool] cannot determine filesystem type of ${dir} (${(error as Error).message}) — assuming disk-backed`);
    return false;
  }
}

/**
 * Create the spool directory (mode 0700) and prove it is writable.
 *
 * The write+unlink probe is the part that matters: `mkdirSync` succeeding says
 * nothing about whether this process may write there (read-only mount, a full
 * filesystem, a directory owned by another user). Throws on any failure.
 */
export function ensureSpoolDir(dir: string): void {
  // Check the existing entry first: `mkdirSync` on a path that is already a
  // regular file fails with EEXIST, which reads like a race rather than "the
  // configured dir is a file".
  if (existsSync(dir)) {
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch (error) {
      throw new SpoolConfigError(`[spool] dir ${dir} cannot be stat'd: ${(error as Error).message}`);
    }
    if (!isDir) {
      throw new SpoolConfigError(`[spool] dir ${dir} exists but is not a directory`);
    }
  } else {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new SpoolConfigError(`[spool] dir ${dir} cannot be created: ${(error as Error).message}`);
    }
  }

  // `mkdirSync` honours the umask, so an existing directory (or a restrictive
  // umask) can leave the mode looser than 0700. Set it explicitly.
  try {
    chmodSync(dir, 0o700);
  } catch (error) {
    throw new SpoolConfigError(`[spool] dir ${dir} cannot be set to mode 0700: ${(error as Error).message}`);
  }

  const probe = join(dir, `.spool-write-probe-${process.pid}`);
  try {
    writeFileSync(probe, '');
    unlinkSync(probe);
  } catch (error) {
    throw new SpoolConfigError(`[spool] dir ${dir} is not writable: ${(error as Error).message}`);
  }
}

/** Subdirectory of `[spool] dir` holding request-body spills (§5.5). */
export const REQUEST_SPILL_SUBDIR = 'requests';

/** Subdirectory of `[spool] dir` holding response-body spills (§5.5, §5.7). */
export const RESPONSE_SPILL_SUBDIR = 'responses';

/** Subdirectory of `[spool] dir` holding per-SSE-event spills (§5.5, §5.7). */
export const EVENT_SPILL_SUBDIR = 'events';

/**
 * The directory a spilled request body is written to.
 *
 * The layout lives here rather than in the module that writes the files: the
 * startup sweep has to find them again, and a second copy of the literal is how
 * a sweep silently stops covering a payload kind. Every spill directory is
 * declared here and listed in {@link sweepStaleSpills}, so a new kind of spill
 * has to be added in both places.
 */
export function requestSpillDir(config: SpoolConfig): string {
  return join(config.dir, REQUEST_SPILL_SUBDIR);
}

/** The directory a spilled response body is written to. */
export function responseSpillDir(config: SpoolConfig): string {
  return join(config.dir, RESPONSE_SPILL_SUBDIR);
}

/** The directory a spilled SSE event is written to. */
export function eventSpillDir(config: SpoolConfig): string {
  return join(config.dir, EVENT_SPILL_SUBDIR);
}

/**
 * How old a spill file must be before the startup sweep may delete it.
 *
 * A crash leaves files no process will ever read again, but a *concurrently
 * starting* worker sharing this directory can be mid-upload, and its spill is
 * not distinguishable from a leftover by name or content. The threshold is
 * therefore a bound on a plausible in-flight request: an hour is far past any
 * real upload, and what too large a threshold costs is disk space only — never
 * bytes that are still wanted (§5.5).
 */
export const SPOOL_SWEEP_MIN_AGE_MS = 60 * 60 * 1000;

/** What a startup sweep did, including everything it refused to touch and why. */
export interface SpoolSweepResult {
  /** Stale spill files deleted. */
  removed: number;
  /** Files left alone because they are too recent to be crash leftovers. */
  keptRecent: number;
  /** Entries left in place, each with the reason it was not removed. */
  skipped: Array<{ path: string; reason: string }>;
  /** True when no spill directory existed at all (nothing to sweep). */
  dirMissing: boolean;
}

/**
 * Delete spill files left behind by a previous run (§5.5).
 *
 * A restart discards all spool state — no recovery manifest or replay metadata
 * is written — so the files are garbage, but only the old ones: a file newer
 * than `minAgeMs` may belong to a worker that is starting up alongside this one
 * and is still filling it. Sweeping is the portable answer here; `open()` +
 * `unlink()` (hiding an fd behind an unlinked name) is POSIX-only and the repo
 * ships a win32 SEA build.
 *
 * Every spill directory is swept — a kind of spill the sweep does not know about
 * is budget on disk that no run will ever release. Only regular files directly
 * inside them are candidates: the sweep does not recurse and never follows a
 * symlink, so a link planted in a spill directory cannot make it delete
 * something outside. Everything it declines to remove is reported in the result
 * rather than passed over silently (repo rule #8). A missing spill directory is
 * normal — each path creates its own on the first spill — and only an enabled
 * spool's directories may be swept (§9.1).
 */
export function sweepStaleSpills(
  config: SpoolConfig,
  minAgeMs: number = SPOOL_SWEEP_MIN_AGE_MS,
): SpoolSweepResult {
  const result: SpoolSweepResult = { removed: 0, keptRecent: 0, skipped: [], dirMissing: false };
  const cutoff = Date.now() - minAgeMs;
  let dirsSeen = 0;

  for (const dir of [requestSpillDir(config), responseSpillDir(config), eventSpillDir(config)]) {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // Reported, not fatal: a restart must still come up when a directory an
      // earlier run left unreadable cannot be swept. The leftover files stay on
      // disk, which is where they already were.
      result.skipped.push({ path: dir, reason: `cannot read directory: ${(error as Error).message}` });
      continue;
    }
    dirsSeen += 1;

    for (const entry of entries) {
      const path = join(dir, entry.name);

      // `Dirent.isFile()` is false for symlinks and directories alike, so a link
      // to an old file elsewhere is skipped rather than followed — and not
      // deleted either, since the link itself is not ours to remove.
      if (!entry.isFile()) {
        result.skipped.push({
          path,
          reason: entry.isDirectory() ? 'not a regular file (directory)' : 'not a regular file (symlink or special)',
        });
        continue;
      }

      let mtimeMs: number;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch (error) {
        result.skipped.push({ path, reason: `cannot stat: ${(error as Error).message}` });
        continue;
      }

      if (mtimeMs > cutoff) {
        result.keptRecent += 1;
        continue;
      }

      try {
        unlinkSync(path);
        result.removed += 1;
      } catch (error) {
        result.skipped.push({ path, reason: `cannot unlink: ${(error as Error).message}` });
      }
    }
  }

  result.dirMissing = dirsSeen === 0;
  return result;
}

/** Expand a leading `~` (or `~/…`) to the home directory; leave other paths alone. */
function expandHome(raw: string): string {
  if (raw === '~') return homedir();
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2));
  return raw;
}

/**
 * Resolve the effective `[spool]` config.
 *
 * Every key falls back to its §5.6 default when absent. When `enabled` is
 * true the directory is created, its mode forced to 0700, and its writability
 * proven; a RAM-backed directory is reported as a warning. When `enabled` is
 * false nothing touches the filesystem — a disabled spool must not create
 * directories as a side effect of reading config.
 *
 * Throws {@link SpoolConfigError} (fatal) on an invalid value or an unusable
 * directory.
 */
export function resolveSpoolConfig(toml: SpoolTomlConfig | null | undefined): SpoolConfig {
  const raw = toml ?? {};

  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') {
    throw new SpoolConfigError(`[spool] enabled must be a boolean, got: ${String(raw.enabled)}`);
  }
  const enabled = raw.enabled ?? SPOOL_DEFAULTS.enabled;

  const resolved: {
    -readonly [K in keyof SpoolConfig]: SpoolConfig[K];
  } = { ...SPOOL_DEFAULTS, enabled };

  for (const [key, allowZero] of INTEGER_KEYS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new SpoolConfigError(`[spool] ${key} must be an integer, got: ${String(value)}`);
    }
    if (value < 0 || (value === 0 && !allowZero)) {
      throw new SpoolConfigError(
        `[spool] ${key} must be ${allowZero ? 'a non-negative integer' : 'a positive integer'}, got: ${value}`,
      );
    }
    (resolved as Record<string, unknown>)[toCamel(key)] = value;
  }

  if (raw.materialization_factor !== undefined) {
    const factor = raw.materialization_factor;
    if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) {
      throw new SpoolConfigError(`[spool] materialization_factor must be a positive number, got: ${String(factor)}`);
    }
    resolved.materializationFactor = factor;
  }

  // Resolved before the directory is touched: a config error must not leave a
  // freshly-created spool dir behind as evidence of an attempt that never ran.
  resolved.externalUpload = resolveExternalUpload(raw);
  if (resolved.externalUpload !== null && !enabled) {
    throw new SpoolConfigError(
      '[spool] external_upload_url requires enabled = true — the uploader projects spooled blobs, and a disabled spool produces none',
    );
  }

  const dir = raw.dir === undefined ? SPOOL_DEFAULTS.dir : expandHome(raw.dir.trim());
  if (!dir) {
    throw new SpoolConfigError('[spool] dir must not be empty');
  }
  if (!isAbsolute(dir)) {
    throw new SpoolConfigError(`[spool] dir must be an absolute path (or start with ~/), got: ${dir}`);
  }
  resolved.dir = dir;

  if (enabled) {
    ensureSpoolDir(dir);
    if (isRamBackedSpoolDir(dir)) {
      console.warn(`[spool] dir ${dir} is RAM-backed (tmpfs/ramfs) — spooled bytes still consume memory`);
    }
  }

  return resolved;
}

/**
 * Resolve the §5.8 external uploader, or `null` when it is not configured.
 *
 * `null` is a load-bearing state — it is what makes auth keep receiving the full
 * body (§5.8: "If no external uploader is configured, preserve the existing
 * full-body auth behavior") — so it is only produced by the absence of
 * `external_upload_url`. A token, timeout, or lifetime on its own is a half-
 * written config and throws rather than quietly resolving to a null uploader.
 *
 * HTTPS-only: the blob and its signed URL travel to the auth service over the
 * public network. Embedded credentials are refused because they would land in
 * the config file's plaintext URL and in any error that echoes it; the token
 * key exists for that. Error messages name the key and, at most, the parsed
 * protocol or host — never the configured value.
 */
function resolveExternalUpload(raw: SpoolTomlConfig): SpoolExternalUploadConfig | null {
  const url = raw.external_upload_url;
  const token = raw.external_upload_token;
  const timeout = raw.external_upload_timeout_ms;
  const lifetime = raw.external_url_min_lifetime_s;

  if (url === undefined) {
    if (token !== undefined || timeout !== undefined || lifetime !== undefined) {
      throw new SpoolConfigError(
        '[spool] external_upload_token, external_upload_timeout_ms and external_url_min_lifetime_s require external_upload_url',
      );
    }
    return null;
  }

  if (typeof url !== 'string' || url.trim() === '') {
    throw new SpoolConfigError('[spool] external_upload_url must not be empty');
  }
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new SpoolConfigError('[spool] external_upload_url must be a valid absolute URL');
  }
  if (parsed.protocol !== 'https:') {
    throw new SpoolConfigError(
      `[spool] external_upload_url must use https, got: ${parsed.protocol} — the blob leaves this host`,
    );
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new SpoolConfigError(
      '[spool] external_upload_url must not embed credentials — use external_upload_token instead',
    );
  }

  let resolvedToken: string | null = null;
  if (token !== undefined) {
    if (typeof token !== 'string' || token.trim() === '') {
      throw new SpoolConfigError(
        '[spool] external_upload_token must not be empty — omit the key for an endpoint that needs no bearer token',
      );
    }
    resolvedToken = token.trim();
  }

  const uploadTimeoutMs = positiveIntegerSetting(
    timeout,
    'external_upload_timeout_ms',
    EXTERNAL_UPLOAD_DEFAULTS.uploadTimeoutMs,
  );

  if (
    lifetime !== undefined &&
    (typeof lifetime !== 'number' || !Number.isInteger(lifetime) || lifetime < EXTERNAL_URL_MIN_LIFETIME_FLOOR_S)
  ) {
    throw new SpoolConfigError(
      `[spool] external_url_min_lifetime_s must be an integer of at least ${EXTERNAL_URL_MIN_LIFETIME_FLOOR_S} seconds, got: ${String(lifetime)}`,
    );
  }

  return {
    uploadUrl: parsed.toString(),
    token: resolvedToken,
    uploadTimeoutMs,
    urlMinLifetimeSeconds: lifetime ?? EXTERNAL_UPLOAD_DEFAULTS.urlMinLifetimeSeconds,
  };
}

/**
 * A `[spool]` integer limit that must be positive, with a default.
 *
 * Shares the message shape of {@link INTEGER_KEYS} so an operator sees one
 * grammar for every numeric `[spool]` key.
 */
function positiveIntegerSetting(value: unknown, key: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new SpoolConfigError(`[spool] ${key} must be a positive integer, got: ${String(value)}`);
  }
  return value;
}

/** `threshold_bytes` -> `thresholdBytes`, etc. */
function toCamel(snake: keyof SpoolTomlConfig): string {
  return snake.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

/** Module-level config; global, set once at startup. */
let configuredSpool: SpoolConfig | null = null;

/** Set the global spool config. Called once at startup from loadProxyConfig. */
export function setSpoolConfig(config: SpoolConfig): void {
  configuredSpool = config;
}

/**
 * Read the global spool config. Falls back to the §5.6 defaults (disabled,
 * no filesystem access) so callers never need a null check.
 */
export function getSpoolConfig(): SpoolConfig {
  return configuredSpool ?? SPOOL_DEFAULTS;
}
