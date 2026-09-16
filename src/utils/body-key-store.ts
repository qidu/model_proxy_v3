/**
 * In-binary key store for the win32 single-executable build.
 *
 * `@github/keytar` needs too many dependencies on Windows (Visual Studio Build
 * Tools with the "Desktop development with C++" workload + Python 3, via
 * node-gyp) to be worth carrying into a self-contained single-file
 * distribution, so the win32 SEA binary marks it `--external` and
 * `store_key_in_system = true` is fatal there. This module supplies the
 * replacement for that one platform: a `KeytarLike` implementation
 * whose backing store is the executable's own file body
 * (`process.execPath`): each `setPassword` appends one record via
 * body-record.ts, and reads walk the record chain backwards. macOS and Linux
 * keep the OS keychain through `@github/keytar`.
 *
 * SECURITY: records are plaintext inside the exe. That is NOT secrecy — anyone
 * who can read the binary can read the keys. The gain is a self-contained
 * single-file distribution whose keys travel with the binary instead of
 * sitting in `proxy_config.toml`; it is a downgrade from an OS keychain and is
 * only used where an OS keychain is not the packaging choice. Keys also do not survive a
 * rebuild (a fresh blob is injected into a fresh copy of node).
 *
 * Scope is deliberately narrow (see tryBodyKeyStore): win32 + a real SEA
 * binary + an execPath basename that is not `node`/`node.exe`. Any gate
 * failing returns null and lets the caller keep its existing fatal error, so
 * the body store can never be pointed at a plain `node` install.
 */

import { basename } from 'path';
import { appendRecord, readRecords, sweepStaleSwapFiles } from './body-record.js';
import type { KeytarLike } from './key-store.js';

/** Record payload shape: one keytar credential per record. */
interface StoredKey {
  service: string;
  account: string;
  password: string;
}

async function readStoredKeys(binaryPath: string): Promise<StoredKey[]> {
  const payloads = await readRecords(binaryPath);
  return payloads.map((payload) => {
    let parsed: Partial<StoredKey> | null = null;
    try {
      parsed = JSON.parse(payload) as Partial<StoredKey> | null;
    } catch {
      parsed = null;
    }
    if (
      parsed === null ||
      typeof parsed.service !== 'string' ||
      typeof parsed.account !== 'string' ||
      typeof parsed.password !== 'string'
    ) {
      // Records are only ever written by setPassword below, and readRecords
      // already validated each tail's CRC — a payload that is not a well-formed
      // credential means the record area is corrupted, not merely absent.
      throw new Error(`body key store: malformed record in ${binaryPath}`);
    }
    return parsed as StoredKey;
  });
}

/**
 * A `KeytarLike` whose store is `binaryPath`'s own record chain. Records are
 * newest-last, so lookups scan backwards and "latest per account" wins.
 */
export function createBodyKeyStore(binaryPath: string): KeytarLike {
  return {
    async getPassword(service: string, account: string): Promise<string | null> {
      const stored = await readStoredKeys(binaryPath);
      for (let i = stored.length - 1; i >= 0; i--) {
        if (stored[i].service === service && stored[i].account === account) {
          return stored[i].password;
        }
      }
      return null;
    },

    async setPassword(service: string, account: string, password: string): Promise<void> {
      const record: StoredKey = { service, account, password };
      await appendRecord(binaryPath, JSON.stringify(record));
    },

    async findCredentials(service: string): Promise<Array<{ account: string; password: string }>> {
      const stored = await readStoredKeys(binaryPath);
      // Oldest → newest, so a later record overwrites an earlier one.
      const latest = new Map<string, string>();
      for (const record of stored) {
        if (record.service === service) latest.set(record.account, record.password);
      }
      return [...latest.entries()].map(([account, password]) => ({ account, password }));
    },
  };
}

/** SEA detection via a non-literal specifier: bundlers must not statically
 *  resolve `node:sea`, and older Node without the module yields false. */
const SEA_MODULE = 'node:sea';

async function isSea(): Promise<boolean> {
  try {
    const sea = (await import(SEA_MODULE)) as { isSea?: () => boolean };
    return typeof sea.isSea === 'function' && sea.isSea();
  } catch {
    return false;
  }
}

/**
 * Build the in-binary key store when this process is a win32 SEA executable;
 * otherwise null (caller keeps its fatal `KeyStoreError`). Also sweeps swap
 * files left over from a previous copy+rename append.
 */
export async function tryBodyKeyStore(): Promise<KeytarLike | null> {
  if (typeof process === 'undefined' || !process.execPath) return null;
  if (process.platform !== 'win32') return null;

  const selfPath = process.execPath;
  const selfName = basename(selfPath).toLowerCase();
  // Never let the body store target a real Node install.
  if (selfName === 'node' || selfName === 'node.exe') return null;

  if (!(await isSea())) return null;

  try {
    await sweepStaleSwapFiles(selfPath);
  } catch {
    // Cleanup only — a leftover swap file must not block key store creation.
  }

  return createBodyKeyStore(selfPath);
}
