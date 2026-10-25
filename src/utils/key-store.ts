/**
 * System keychain API-key store (`[general] store_key_in_system = true`).
 *
 * When enabled, plaintext `api_key` values in the proxy config are extracted
 * on config load, stored into the OS keychain (macOS Keychain / Windows
 * Credential Vault / Linux Secret Service via `@github/keytar`), and the
 * config file on disk is rewritten to the literal sentinel
 * `STORE_KEY_IN_SYSTEM`. On every later load, sentinel values are resolved
 * back from the keychain into the in-memory config, so the synchronous
 * routing code keeps working with real keys.
 *
 * Keychain format: one JSON object under the reserved `__api_keys_v1__`
 * account in the `model_proxy_v3` service. Its properties map the logical
 * `<target_model_id>/<base_url>` accounts to api_keys, so a normal load reads
 * one keychain item regardless of key count. Legacy per-account items are
 * migrated only when no bundle exists, then left untouched.
 *
 * This is a local/dev-host feature: the keytar native addon requires an OS
 * keychain (no Docker/distroless, no Cloudflare Workers). When the feature is
 * enabled but the keychain itself is unavailable, the error is fatal — no
 * silent fallback (it would affect every key).
 *
 * Exception — the win32 single-executable build: `@github/keytar` needs too
 * many dependencies on Windows (Visual Studio Build Tools with the C++ workload
 * + Python 3, via node-gyp) to be worth carrying into a self-contained
 * single-file distribution, so that build stores the keys in the executable's
 * own file body instead (body-key-store.ts, addressed by `process.execPath`).
 * That store is PLAINTEXT inside the exe — a deliberate portability-for-secrecy
 * trade, only used where an OS keychain is not practical. macOS and Linux keep
 * the OS keychain via `@github/keytar`; Docker, Cloudflare Workers and
 * macOS/Linux SEA binaries keep the fatal error above.
 *
 * An individual sentinel that has no matching keychain entry is NOT fatal:
 * that one slot is cleared to
 * `''` (== "not configured", so the normal api_key fallback chain applies) and
 * reported, so the rest of the config still loads and the proxy still starts.
 *
 * Scope: ONLY configured api_key values of `[models.*]` targets,
 * `[models.default].api_key`, and `[models.passthrough]` target `key`s in the
 * local `proxy_config.toml` file. Not applied to Consul/Apollo config-center
 * sources; composite/schedule aliases carry no api_key of their own; and
 * caller/user keys from request headers are never stored — an empty api_key
 * (auth passthrough) is skipped.
 */

import { copyFileSync, readFileSync, writeFileSync } from 'fs';
import { tryBodyKeyStore } from './body-key-store.js';
import type { ModelCategoryConfig, ProxyConfig } from './config-loader.js';

export const KEY_STORE_SERVICE = 'model_proxy_v3';
export const KEY_STORE_BUNDLE_ACCOUNT = '__api_keys_v1__';
export const STORE_KEY_IN_SYSTEM = 'STORE_KEY_IN_SYSTEM';

/** Minimal keytar surface used here (subset of @github/keytar's API). */
export interface KeytarLike {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  /** Optional — enables the best-effort base_url fallback on exact-miss. */
  findCredentials?(service: string): Promise<Array<{ account: string; password: string }>>;
}

/** Fatal error: loadProxyConfig must rethrow instead of degrading to `{}`. */
export class KeyStoreError extends Error {
  fatal = true;
}

type KeyBundle = Map<string, string>;

async function readKeyBundle(keytar: KeytarLike): Promise<KeyBundle | null> {
  const serialized = await keytar.getPassword(KEY_STORE_SERVICE, KEY_STORE_BUNDLE_ACCOUNT);
  if (serialized === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch (err) {
    throw new KeyStoreError(`system keychain bundle "${KEY_STORE_BUNDLE_ACCOUNT}" is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new KeyStoreError(`system keychain bundle "${KEY_STORE_BUNDLE_ACCOUNT}" must be a JSON object`);
  }

  const bundle: KeyBundle = new Map();
  for (const [account, key] of Object.entries(parsed)) {
    if (typeof key !== 'string') {
      throw new KeyStoreError(`system keychain bundle "${KEY_STORE_BUNDLE_ACCOUNT}" has a non-string key for account "${account}"`);
    }
    bundle.set(account, key);
  }
  return bundle;
}

const isNodeEnvironment = typeof process !== 'undefined' && process.versions?.node;

export function keychainAccount(targetModelId: string, baseUrl: string): string {
  return `${targetModelId}/${baseUrl}`;
}

/** A single api_key slot in the config plus the keychain account it maps to. */
interface KeySlot {
  /** Human-readable location for error/log messages, e.g. `models.claude.gpt-5`. */
  location: string;
  account: string;
  get(): string | undefined;
  set(value: string): void;
}

/**
 * Enumerate every api_key slot relevant for keychain storage:
 * - category-level `api_key` → account `<category>/<category base_url>`
 * - entry-level `api_key` (index 2) → account `<target>/<entry or category base_url>`
 * - `[models.default].api_key` → account `default/<default_base_url>`
 * - `[models.passthrough].<name>.key` → account `passthrough.<name>/<base>`
 */
function collectKeySlots(config: ProxyConfig): KeySlot[] {
  const slots: KeySlot[] = [];

  for (const [categoryName, categoryConfig] of Object.entries(config.models ?? {})) {
    if (Array.isArray(categoryConfig)) continue;
    const category = categoryConfig as ModelCategoryConfig;
    const categoryBaseUrl = category.base_url ?? '';

    if (category.api_key !== undefined) {
      const holder = category as { api_key?: string };
      slots.push({
        location: `models.${categoryName}.api_key`,
        account: keychainAccount(categoryName, categoryBaseUrl),
        get: () => holder.api_key,
        set: (v) => { holder.api_key = v; },
      });
    }

    for (const [modelName, entry] of Object.entries(category)) {
      if (!Array.isArray(entry) || entry.length < 3) continue;
      const [target, entryBaseUrl, entryApiKey] = entry as string[];
      if (entryApiKey === undefined || target === undefined) continue;
      const account = keychainAccount(target, entryBaseUrl || categoryBaseUrl);
      slots.push({
        location: `models.${categoryName}.${modelName}[2]`,
        account,
        get: () => (entry as string[])[2],
        set: (v) => { (entry as string[])[2] = v; },
      });
    }
  }

  // Passthrough targets have no model id, so the account is namespaced by the
  // `[models.passthrough]` target name instead.
  for (const [name, target] of Object.entries(config.passthrough ?? {})) {
    if (target.key === undefined) continue;
    const holder = target as { key?: string };
    slots.push({
      location: `passthrough.${name}.key`,
      account: keychainAccount(`passthrough.${name}`, target.base ?? ''),
      get: () => holder.key,
      set: (v) => { holder.key = v; },
    });
  }

  return slots;
}

/**
 * Locations of every api_key slot currently holding the `STORE_KEY_IN_SYSTEM`
 * sentinel. Used by the loader to refuse Consul/Apollo configs carrying
 * sentinels (they cannot be resolved without the local file + keychain).
 */
export function findSentinelApiKeys(config: ProxyConfig): string[] {
  return collectKeySlots(config).filter((slot) => slot.get() === STORE_KEY_IN_SYSTEM).map((slot) => slot.location);
}

/** Module specifier kept non-literal on purpose: tsc must not require the
 *  keytar addon to be linked at build time (fresh checkouts / Docker don't
 *  build the submodule); absence is a runtime KeyStoreError instead. */
const KEYTAR_MODULE = '@github/keytar';

/** findCredentials (broad keychain enumeration, as opposed to the scoped
 *  getPassword lookup) has been observed to hang indefinitely rather than
 *  resolve or reject — bound it so a stuck call fails loud after
 *  FIND_CREDENTIALS_TIMEOUT_MS instead of hanging the process forever. */
const FIND_CREDENTIALS_TIMEOUT_MS = 60_000;

/** Exported for direct unit testing with a short timeout — the 60s production
 *  value would make a real timeout-firing test too slow to run routinely. */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolvePromise(value); },
      (err) => { clearTimeout(timer); rejectPromise(err); },
    );
  });
}

async function loadKeytar(opts: { keytarImpl?: KeytarLike }): Promise<KeytarLike> {
  if (opts.keytarImpl) return opts.keytarImpl;
  try {
    const mod = await import(KEYTAR_MODULE);
    return ((mod as { default?: KeytarLike }).default ?? mod) as KeytarLike;
  } catch (err) {
    // win32 SEA fallback: keytar needs too many dependencies on Windows (VS
    // Build Tools + Python 3, via node-gyp), so the win32 single-executable
    // build stores the keys in the executable's own file body instead (see
    // body-key-store.ts). Null on every other platform, and on any binary that
    // is not a real SEA whose execPath basename is not node/node.exe — so a
    // plain Node install is never a target.
    const body = await tryBodyKeyStore();
    if (body) return body;
    throw new KeyStoreError(
      `store_key_in_system = true but the system keychain is unavailable: ${(err as Error).message}` +
      ` (requires the @github/keytar native addon and an OS keychain — not available in Docker/Workers;` +
      ` on win32, a single-executable build substitutes an in-binary body store automatically)`,
    );
  }
}

export interface ApplySystemKeyStoreOptions {
  /** Path of the on-disk config file; enables the migration rewrite. */
  configPath?: string;
  /** Injectable keytar implementation (tests). */
  keytarImpl?: KeytarLike;
}

/** One api_key slot whose sentinel could not be resolved from the keychain
 *  (location + reason), recorded instead of thrown so config load can skip
 *  just that slot and keep going. */
export interface UnresolvedKeySentinel {
  location: string;
  message: string;
}

/**
 * Apply the system key store to a freshly parsed config (mutates in place):
 *
 * 1. Read the single JSON bundle once. Plaintext api_keys are added under
 *    their logical `<target_model_id>/<base_url>` property.
 * 2. Resolve every `STORE_KEY_IN_SYSTEM` sentinel from the bundle, using the
 *    existing best-effort account match on an exact miss. If no bundle exists,
 *    legacy per-account items are read and migrated into the bundle. A slot
 *    whose sentinel cannot be resolved is cleared to `''` and reported without
 *    blocking the rest of the config.
 * 3. Write the bundle at most once, then rewrite plaintext file values to
 *    sentinels (with a `<configPath>.bak` backup). Keeping the bundle in one
 *    keychain item avoids one macOS permission prompt per logical api_key.
 *
 * No-op when `store_key_in_system` is not true or outside Node.js.
 */
export async function applySystemKeyStore(
  config: ProxyConfig,
  opts: ApplySystemKeyStoreOptions = {},
): Promise<{ config: ProxyConfig; unresolved: UnresolvedKeySentinel[] }> {
  if (!isNodeEnvironment || config.general?.store_key_in_system !== true) {
    return { config, unresolved: [] };
  }

  const keytar = await loadKeytar(opts);
  const slots = collectKeySlots(config);
  const storedBundle = await readKeyBundle(keytar);
  const bundle: KeyBundle = new Map(storedBundle ?? []);
  let bundleDirty = false;

  const storedRawKeys: string[] = [];
  const storedSlots: KeySlot[] = [];
  for (const slot of slots) {
    const raw = slot.get();
    if (!raw || raw === STORE_KEY_IN_SYSTEM) continue;
    bundle.set(slot.account, raw);
    bundleDirty = true;
    storedRawKeys.push(raw);
    storedSlots.push(slot);
  }

  let resolvedCount = 0;
  const unresolved: UnresolvedKeySentinel[] = [];
  for (const slot of slots) {
    if (slot.get() !== STORE_KEY_IN_SYSTEM) continue;

    const bundled = bundle.get(slot.account);
    let resolved: { key: string; account: string } | null = bundled === undefined
      ? null
      : { key: bundled, account: slot.account };

    if (!resolved && storedBundle === null) {
      const exact = await keytar.getPassword(KEY_STORE_SERVICE, slot.account);
      if (exact !== null) resolved = { key: exact, account: slot.account };
    }

    if (!resolved) {
      resolved = findBestCredential(
        [...bundle].map(([account, password]) => ({ account, password })),
        slot.account,
      );
    }

    if (!resolved && storedBundle === null) {
      // Legacy migration only. findCredentials reads every old item's data and
      // can therefore produce one macOS permission dialog per legacy item.
      console.log(`[key-store] no exact keychain match for "${slot.account}" — searching all stored keys` +
        ' (if this pauses, check for a macOS Keychain Access permission dialog and click "Always Allow")');
      resolved = await findBestEffortKey(keytar, slot.account);
    }

    if (!resolved) {
      const message = `${slot.location} is "${STORE_KEY_IN_SYSTEM}" but no key was found in the system keychain` +
        ` (service "${KEY_STORE_SERVICE}", account "${slot.account}" — exact and best-effort base_url match)`;
      console.error(`[key-store] ${message}`);
      slot.set('');
      unresolved.push({ location: slot.location, message });
      continue;
    }

    if (storedBundle === null && bundle.get(slot.account) !== resolved.key) {
      bundle.set(slot.account, resolved.key);
      bundleDirty = true;
    }
    if (resolved.account !== slot.account) {
      console.warn(`[key-store] exact keychain account "${slot.account}" not found — using best-effort match "${resolved.account}"`);
    }
    slot.set(resolved.key);
    resolvedCount++;
  }

  if (bundleDirty) {
    await keytar.setPassword(
      KEY_STORE_SERVICE,
      KEY_STORE_BUNDLE_ACCOUNT,
      JSON.stringify(Object.fromEntries(bundle)),
    );
    for (const slot of storedSlots) {
      console.info(`[key-store] stored ${slot.location} → keychain bundle entry "${slot.account}"`);
    }
  }

  if (opts.configPath && storedRawKeys.length > 0) {
    const content = readFileSync(opts.configPath, 'utf-8');
    copyFileSync(opts.configPath, `${opts.configPath}.bak`);
    let rewritten = content;
    for (const raw of new Set(storedRawKeys)) {
      rewritten = rewritten.split(JSON.stringify(raw)).join(JSON.stringify(STORE_KEY_IN_SYSTEM));
    }
    writeFileSync(opts.configPath, rewritten);
    console.info(`[key-store] replaced ${storedRawKeys.length} api_key(s) with "${STORE_KEY_IN_SYSTEM}" in ${opts.configPath} (backup: ${opts.configPath}.bak)`);
  }

  // Internal marker (underscore-prefixed, like _validationErrors) consumed by
  // toDashboardConfigPayload → TUI 🔒 indicator. True when the feature ran and
  // the config had at least one api_key (after the passes above, every
  // plaintext key has been stored and rewritten to a sentinel in the file).
  if (storedRawKeys.length > 0 || resolvedCount > 0) {
    (config as ProxyConfig & { _api_keys_in_system_store?: boolean })._api_keys_in_system_store = true;
  }

  return { config, unresolved };
}

/**
 * List every logical account (`<target_model_id>/<base_url>`) stored under the
 * proxy's service — used by the TUI 'K' overlay. A bundled store needs only
 * the single bundle read; findCredentials is just the legacy fallback.
 */
export async function listSystemKeychainAccounts(
  opts: { keytarImpl?: KeytarLike } = {},
): Promise<string[]> {
  try {
    const keytar = await loadKeytar(opts);
    const bundle = await readKeyBundle(keytar);
    if (bundle !== null) {
      return [...bundle.keys()].sort((a, b) => a.localeCompare(b));
    }
    if (!keytar.findCredentials) {
      throw new Error('keytar build does not support findCredentials');
    }
    const credentials = await withTimeout(
      keytar.findCredentials(KEY_STORE_SERVICE),
      FIND_CREDENTIALS_TIMEOUT_MS,
      `keytar.findCredentials("${KEY_STORE_SERVICE}") did not respond within ${FIND_CREDENTIALS_TIMEOUT_MS / 1000}s` +
        ' (check for a stuck macOS Keychain Access permission dialog)',
    );
    return credentials
      .filter((c) => c.account !== KEY_STORE_BUNDLE_ACCOUNT)
      .map((c) => c.account)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    throw new Error(`Cannot list system keychain keys: ${(err as Error).message}`);
  }
}

/** Split a keychain account into `<target_model_id>` / `<base_url>` parts. */
function splitAccount(account: string): { target: string; baseUrl: string } {
  const idx = account.indexOf('/');
  if (idx === -1) return { target: account, baseUrl: '' };
  return { target: account.slice(0, idx), baseUrl: account.slice(idx + 1) };
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

/**
 * base_url-only compatibility score between two base_urls: exact match beats
 * a prefix relation (e.g. "https://x/api" vs "https://x/api/anthropic",
 * longer shared prefix ranks higher); -1 when unrelated. Shared by
 * scoreAccountMatch (adds target-name tiebreak, for keychain account lookup)
 * and upsertModelTarget's same-category STORE_KEY_IN_SYSTEM base_url match
 * (target-name intentionally not considered there).
 */
export function scoreBaseUrlMatch(wantedBaseUrl: string, candidateBaseUrl: string): number {
  const bw = normalizeBaseUrl(wantedBaseUrl);
  const bc = normalizeBaseUrl(candidateBaseUrl);
  if (bw === bc) {
    return 1_000_000;
  }
  if (bw.startsWith(bc) || bc.startsWith(bw)) {
    return 100_000 + Math.min(bw.length, bc.length);
  }
  return -1;
}

/**
 * Compatibility score between a wanted account and a candidate account.
 * Returns -1 when the base_urls are unrelated (no fallback allowed);
 * otherwise base_url match dominates and target-name similarity tiebreaks.
 */
function scoreAccountMatch(wanted: string, candidate: string): number {
  const w = splitAccount(wanted);
  const c = splitAccount(candidate);
  const baseScore = scoreBaseUrlMatch(w.baseUrl, c.baseUrl);
  if (baseScore < 0) {
    return -1;
  }

  let targetScore = 0;
  if (w.target === c.target) {
    targetScore = 10_000;
  } else if (w.target.startsWith(c.target) || c.target.startsWith(w.target)) {
    targetScore = 5_000 + Math.min(w.target.length, c.target.length);
  }

  return baseScore + targetScore;
}

function findBestCredential(
  credentials: Array<{ account: string; password: string }>,
  wantedAccount: string,
): { key: string; account: string } | null {
  let best: { key: string; account: string; score: number } | null = null;
  for (const { account, password } of credentials) {
    const score = scoreAccountMatch(wantedAccount, account);
    if (score < 0) continue;
    if (!best || score > best.score || (score === best.score && account < best.account)) {
      best = { key: password, account, score };
    }
  }
  return best ? { key: best.key, account: best.account } : null;
}

/** Legacy best-effort key lookup: enumerate all per-account items. */
async function findBestEffortKey(keytar: KeytarLike, wantedAccount: string): Promise<{ key: string; account: string } | null> {
  if (!keytar.findCredentials) return null;
  let credentials: Array<{ account: string; password: string }>;
  try {
    credentials = await withTimeout(
      keytar.findCredentials(KEY_STORE_SERVICE),
      FIND_CREDENTIALS_TIMEOUT_MS,
      `keytar.findCredentials("${KEY_STORE_SERVICE}") did not respond within ${FIND_CREDENTIALS_TIMEOUT_MS / 1000}s` +
        ' (check for a stuck macOS Keychain Access permission dialog)',
    );
  } catch (err) {
    console.warn(`[key-store] best-effort lookup for "${wantedAccount}" failed: ${(err as Error).message}`);
    return null;
  }
  return findBestCredential(
    credentials.filter((c) => c.account !== KEY_STORE_BUNDLE_ACCOUNT),
    wantedAccount,
  );
}
