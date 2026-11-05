/**
 * Unit tests for the `[spool]` config surface (src/utils/spool.ts).
 *
 * Plan: docs/architecture/plan-ssd-spool-image-request-bodies.md §5.5, §5.6, §5.8.
 *
 * Covers: §5.6 defaults, per-key range/type validation (fail-loud), `~`
 * expansion, absolute-path requirement, directory creation with mode 0700,
 * the write probe, the tmpfs/ramfs magic-number mapping, the §5.5 startup
 * sweep (age threshold, blast radius across every spill directory, skip
 * reporting), the §5.8 external-upload keys (HTTPS-only, no embedded
 * credentials, the signed-URL lifetime floor, and the refusal to configure an
 * uploader on a disabled spool), and the invariant that a disabled spool never
 * touches the filesystem.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  EVENT_SPILL_SUBDIR,
  REQUEST_SPILL_SUBDIR,
  RESPONSE_SPILL_SUBDIR,
  SPOOL_DEFAULTS,
  SPOOL_SWEEP_MIN_AGE_MS,
  SpoolConfigError,
  ensureSpoolDir,
  getSpoolConfig,
  isRamBackedFsType,
  requestSpillDir,
  resolveSpoolConfig,
  setSpoolConfig,
  sweepStaleSpills,
} from '../../src/utils/spool.js';

const scratchDirs: string[] = [];

/** A fresh temp directory that the test cleanup removes afterwards. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spool-test-'));
  scratchDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of scratchDirs) {
    try {
      chmodSync(dir, 0o700); // a read-only-dir test may have left it unwritable
    } catch { /* already writable or already gone */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Assert `fn` throws a fatal SpoolConfigError whose message mentions `needle`. */
function assertSpoolError(fn: () => unknown, needle: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof SpoolConfigError, `expected SpoolConfigError, got ${String(caught)}`);
  assert.equal((caught as SpoolConfigError).fatal, true, 'spool config errors must be fatal to startup');
  assert.match((caught as SpoolConfigError).message, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
}

describe('resolveSpoolConfig — defaults', () => {
  it('is disabled with the §5.6 defaults when no [spool] section exists', () => {
    const cfg = resolveSpoolConfig(undefined);
    assert.deepEqual(cfg, SPOOL_DEFAULTS);
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.dir, join(homedir(), '.cache', 'model-proxy', 'spool'));
    // §5.6 numbers, spelled out so a silent default change is caught here.
    assert.equal(cfg.thresholdBytes, 1048576);
    assert.equal(cfg.maxRequestBytes, 10485760);
    assert.equal(cfg.maxResponseBytes, 67108864);
    assert.equal(cfg.maxTotalBytes, 2147483648);
    assert.equal(cfg.maxMaterializedBodyBytes, 0);
    assert.equal(cfg.materializationFactor, 2.0);
    assert.equal(cfg.maxAdmissionQueue, 64);
    assert.equal(cfg.admissionTimeoutMs, 30000);
    assert.equal(cfg.maxBlobCacheBytes, 67108864);
    assert.equal(cfg.maxBlobDiskBytes, 268435456);
    assert.equal(cfg.ttlSeconds, 600);
    assert.equal(cfg.externalUpload, null);
  });

  it('treats an empty [spool] section the same as no section', () => {
    assert.deepEqual(resolveSpoolConfig({}), SPOOL_DEFAULTS);
  });

  it('leaves externalUpload null when no uploader is configured, enabled or not', () => {
    const dir = scratch();
    assert.equal(resolveSpoolConfig({ enabled: true, dir }).externalUpload, null);
    assert.equal(resolveSpoolConfig({ enabled: false, dir }).externalUpload, null);
  });

  it('does not create the directory while disabled (config reads have no side effects)', () => {
    const target = join(scratch(), 'never-created');
    const cfg = resolveSpoolConfig({ enabled: false, dir: target });
    assert.equal(cfg.enabled, false);
    assert.equal(cfg.dir, target);
    assert.equal(existsSync(target), false, 'a disabled spool must not create its directory');
  });
});

describe('resolveSpoolConfig — validation', () => {
  const positiveIntegerKeys = [
    'threshold_bytes',
    'max_request_bytes',
    'max_response_bytes',
    'max_total_bytes',
    'max_admission_queue',
    'admission_timeout_ms',
    'max_blob_cache_bytes',
    'max_blob_disk_bytes',
    'ttl_seconds',
  ] as const;

  for (const key of positiveIntegerKeys) {
    it(`rejects ${key} = 0 (a zero limit means "spool nothing", which is what enabled=false says)`, () => {
      assertSpoolError(() => resolveSpoolConfig({ [key]: 0 }), `[spool] ${key} must be a positive integer`);
    });

    it(`rejects ${key} = -1`, () => {
      assertSpoolError(() => resolveSpoolConfig({ [key]: -1 }), `[spool] ${key} must be a positive integer`);
    });

    it(`rejects a fractional ${key}`, () => {
      assertSpoolError(() => resolveSpoolConfig({ [key]: 1.5 }), `[spool] ${key} must be an integer`);
    });
  }

  it('accepts max_materialized_body_bytes = 0 as "admission budget disabled"', () => {
    assert.equal(resolveSpoolConfig({ max_materialized_body_bytes: 0 }).maxMaterializedBodyBytes, 0);
  });

  it('rejects a negative max_materialized_body_bytes', () => {
    assertSpoolError(
      () => resolveSpoolConfig({ max_materialized_body_bytes: -1 }),
      '[spool] max_materialized_body_bytes must be a non-negative integer',
    );
  });

  it('rejects materialization_factor <= 0, non-finite values, and non-numbers', () => {
    for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      assertSpoolError(
        () => resolveSpoolConfig({ materialization_factor: bad }),
        '[spool] materialization_factor must be a positive number',
      );
    }
    // A fractional factor is the normal case (2.0, 1.5) — must be accepted.
    assert.equal(resolveSpoolConfig({ materialization_factor: 1.5 }).materializationFactor, 1.5);
  });

  it('rejects a non-boolean enabled', () => {
    assertSpoolError(
      () => resolveSpoolConfig({ enabled: 'true' as unknown as boolean }),
      '[spool] enabled must be a boolean',
    );
  });

  it('rejects a relative dir with an absolute path or ~/ hint', () => {
    assertSpoolError(() => resolveSpoolConfig({ dir: 'relative/path' }), 'must be an absolute path');
  });

  it('expands a leading ~ to the home directory', () => {
    assert.equal(resolveSpoolConfig({ dir: '~/spool-test' }).dir, join(homedir(), 'spool-test'));
    assert.equal(resolveSpoolConfig({ dir: '~' }).dir, homedir());
    // A ~ that is not a leading path segment is left alone.
    assert.equal(resolveSpoolConfig({ dir: '/mnt/~/spool' }).dir, '/mnt/~/spool');
  });

  it('applies overrides on top of the defaults for untouched keys', () => {
    const cfg = resolveSpoolConfig({ threshold_bytes: 4096, ttl_seconds: 5 });
    assert.equal(cfg.thresholdBytes, 4096);
    assert.equal(cfg.ttlSeconds, 5);
    assert.equal(cfg.maxRequestBytes, SPOOL_DEFAULTS.maxRequestBytes);
    assert.equal(cfg.maxTotalBytes, SPOOL_DEFAULTS.maxTotalBytes);
  });
});

describe('resolveSpoolConfig — external upload (§5.8)', () => {
  /** The configured endpoint every accepted case in this block uses. */
  const URL_VALUE = 'https://auth.example/internal/blobs';

  it('resolves the uploader from the URL alone, with the §5.8 defaults', () => {
    const cfg = resolveSpoolConfig({ enabled: true, dir: scratch(), external_upload_url: URL_VALUE });
    assert.deepEqual(cfg.externalUpload, {
      uploadUrl: URL_VALUE,
      token: null,
      uploadTimeoutMs: 30000,
      urlMinLifetimeSeconds: 900,
    });
  });

  it('normalizes the URL and trims the token, taking explicit numbers as given', () => {
    const cfg = resolveSpoolConfig({
      enabled: true,
      dir: scratch(),
      external_upload_url: `  ${URL_VALUE}/upload  `,
      external_upload_token: '  s3cret  ',
      external_upload_timeout_ms: 5000,
      external_url_min_lifetime_s: 60,
    });
    assert.deepEqual(cfg.externalUpload, {
      uploadUrl: `${URL_VALUE}/upload`,
      token: 's3cret',
      uploadTimeoutMs: 5000,
      urlMinLifetimeSeconds: 60,
    });
  });

  it('refuses a half-written uploader: no key is meaningful without the URL', () => {
    for (const key of ['external_upload_token', 'external_upload_timeout_ms', 'external_url_min_lifetime_s'] as const) {
      assertSpoolError(
        () => resolveSpoolConfig({ [key]: key === 'external_upload_token' ? 'token' : 60 }),
        'require external_upload_url',
      );
    }
  });

  it('refuses a non-https endpoint, naming the protocol it found', () => {
    assertSpoolError(
      () => resolveSpoolConfig({ external_upload_url: 'http://auth.example/blobs' }),
      '[spool] external_upload_url must use https, got: http:',
    );
  });

  it('refuses a value that is not an absolute URL or is empty', () => {
    assertSpoolError(() => resolveSpoolConfig({ external_upload_url: 'auth.example/blobs' }), 'must be a valid absolute URL');
    assertSpoolError(() => resolveSpoolConfig({ external_upload_url: '   ' }), 'must not be empty');
  });

  it('refuses embedded credentials and does not echo them into the error', () => {
    let caught: unknown;
    try {
      resolveSpoolConfig({ external_upload_url: 'https://user:hunter2@auth.example/blobs' });
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof SpoolConfigError, `expected SpoolConfigError, got ${String(caught)}`);
    assert.match((caught as SpoolConfigError).message, /must not embed credentials/);
    assert.doesNotMatch((caught as SpoolConfigError).message, /hunter2/, 'a credential must never reach the message');
  });

  it('refuses an empty token rather than sending an unauthenticated request', () => {
    assertSpoolError(
      () => resolveSpoolConfig({ external_upload_url: URL_VALUE, external_upload_token: '  ' }),
      '[spool] external_upload_token must not be empty',
    );
  });

  it('requires a positive integer upload timeout', () => {
    for (const bad of [0, -1, 1.5]) {
      assertSpoolError(
        () => resolveSpoolConfig({ external_upload_url: URL_VALUE, external_upload_timeout_ms: bad }),
        '[spool] external_upload_timeout_ms must be a positive integer',
      );
    }
  });

  it('enforces the signed-URL lifetime floor, accepting the floor itself', () => {
    for (const bad of [0, 59, 60.5]) {
      assertSpoolError(
        () => resolveSpoolConfig({ external_upload_url: URL_VALUE, external_url_min_lifetime_s: bad }),
        '[spool] external_url_min_lifetime_s must be an integer of at least 60 seconds',
      );
    }
    assert.equal(
      resolveSpoolConfig({ enabled: true, dir: scratch(), external_upload_url: URL_VALUE, external_url_min_lifetime_s: 61 })
        .externalUpload?.urlMinLifetimeSeconds,
      61,
    );
  });

  it('refuses an uploader on a disabled spool, before creating its directory', () => {
    const dir = join(scratch(), 'never-created');
    assertSpoolError(
      () => resolveSpoolConfig({ enabled: false, dir, external_upload_url: URL_VALUE }),
      '[spool] external_upload_url requires enabled = true',
    );
    assert.equal(existsSync(dir), false, 'the refusal must happen before any filesystem side effect');
  });
});

describe('ensureSpoolDir', () => {
  it('creates a missing directory with mode 0700 and leaves no probe file behind', () => {
    const target = join(scratch(), 'nested', 'spool');
    ensureSpoolDir(target);

    const stats = statSync(target);
    assert.equal(stats.isDirectory(), true);
    assert.equal(stats.mode & 0o777, 0o700, 'spool directory must be 0700 (§5.5)');
    assert.deepEqual(readdirSync(target), [], 'the write probe must be deleted');
  });

  it('forces mode 0700 on an existing directory created with a looser mode', () => {
    const target = join(scratch(), 'loose');
    ensureSpoolDir(target);
    chmodSync(target, 0o755);

    ensureSpoolDir(target);
    assert.equal(statSync(target).mode & 0o777, 0o700);
  });

  it('rejects a path that exists as a regular file', () => {
    const target = join(scratch(), 'a-file');
    writeFileSync(target, 'not a directory');
    assertSpoolError(() => ensureSpoolDir(target), 'exists but is not a directory');
  });

  it('rejects a directory it cannot write into instead of assuming it works', () => {
    // `mkdir` succeeding proves nothing about writability, so the probe must be
    // load-bearing. Abuse the probe path itself: a directory squatting on the
    // probe filename makes the write fail with EISDIR, which is exactly the
    // EACCES/EROFS/ENOSPC shape a real failure takes.
    const target = join(scratch(), 'blocked');
    ensureSpoolDir(target);
    mkdirSync(join(target, `.spool-write-probe-${process.pid}`));
    assertSpoolError(() => ensureSpoolDir(target), 'is not writable');
  });

  it('is exercised by resolveSpoolConfig only when enabled', () => {
    const target = join(scratch(), 'enabled-spool');
    const cfg = resolveSpoolConfig({ enabled: true, dir: target });
    assert.equal(cfg.enabled, true);
    assert.equal(statSync(target).isDirectory(), true);
    assert.equal(statSync(target).mode & 0o777, 0o700);
  });
});

describe('isRamBackedFsType', () => {
  it('recognises tmpfs and ramfs magic numbers', () => {
    assert.equal(isRamBackedFsType(0x01021994), true, 'tmpfs');
    assert.equal(isRamBackedFsType(0x858458f6), true, 'ramfs');
  });

  it('does not flag disk-backed filesystems', () => {
    assert.equal(isRamBackedFsType(0xef53), false, 'ext4');
    assert.equal(isRamBackedFsType(0x1a97), false, 'xfs');
    assert.equal(isRamBackedFsType(0), false);
  });
});

describe('setSpoolConfig / getSpoolConfig', () => {
  it('defaults to the disabled config before startup resolution runs', () => {
    assert.deepEqual(getSpoolConfig(), SPOOL_DEFAULTS);
  });

  it('returns exactly what startup resolution stored', () => {
    const resolved = resolveSpoolConfig({ enabled: false, dir: '/var/tmp/spool-roundtrip', threshold_bytes: 2048 });
    setSpoolConfig(resolved);
    assert.equal(getSpoolConfig(), resolved);
    assert.equal(getSpoolConfig().thresholdBytes, 2048);
    // Restore the pre-startup default for any later test file in this process.
    setSpoolConfig(SPOOL_DEFAULTS);
  });
});

describe('sweepStaleSpills (§5.5)', () => {
  const HOUR = 60 * 60 * 1000;

  /** A scratch spool root laid out like a live one: `<root>/requests/`. */
  function spillRoot(): { root: string; dir: string } {
    const root = scratch();
    const dir = join(root, REQUEST_SPILL_SUBDIR);
    mkdirSync(dir, { recursive: true });
    return { root, dir };
  }

  /** Write a file whose mtime is `ageMs` in the past; returns its path. */
  function writeAged(dir: string, name: string, ageMs: number, content: string): string {
    const path = join(dir, name);
    writeFileSync(path, content);
    const when = new Date(Date.now() - ageMs);
    utimesSync(path, when, when);
    return path;
  }

  it('removes only files older than the threshold, and reports both counts', () => {
    const { root, dir } = spillRoot();
    const stale = writeAged(dir, 'req-stale.body', 2 * HOUR, 'stale bytes');
    const fresh = writeAged(dir, 'req-fresh.body', 10 * 60 * 1000, 'in-flight bytes');
    // A file outside the spill subdirectory belongs to nobody's sweep: the
    // blast radius of a startup cleanup has to be exactly the spill files.
    const outsider = writeAged(root, 'unrelated.txt', 2 * HOUR, 'keep me');

    const result = sweepStaleSpills(resolveSpoolConfig({ enabled: true, dir: root }));

    assert.equal(result.removed, 1);
    assert.equal(result.keptRecent, 1);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.dirMissing, false);
    assert.equal(existsSync(stale), false, 'a spill older than the threshold must be deleted');
    assert.equal(existsSync(fresh), true, 'a spill recent enough to be in flight must survive');
    assert.equal(readFileSync(fresh, 'utf8'), 'in-flight bytes', 'the surviving spill must be byte-intact');
    assert.equal(existsSync(outsider), true, 'the sweep must not reach outside the spill directory');
  });

  it('treats the threshold as a minimum age, measured against an explicit cutoff', () => {
    // The exact boundary is a race against the wall clock, so the two files sit
    // a minute either side of the cutoff rather than on it.
    const { root, dir } = spillRoot();
    const justUnder = writeAged(dir, 'req-under.body', HOUR - 60_000, 'young');
    const justOver = writeAged(dir, 'req-over.body', HOUR + 60_000, 'old');

    const result = sweepStaleSpills(resolveSpoolConfig({ enabled: true, dir: root }), HOUR);

    assert.equal(result.removed, 1);
    assert.equal(result.keptRecent, 1);
    assert.equal(existsSync(justOver), false, 'past the cutoff means removable');
    assert.equal(existsSync(justUnder), true, 'inside the cutoff means protected');
    // The default is what startup actually uses, so pin the policy it encodes:
    // the ten-minute file above survived it and two hours is past it.
    assert.ok(SPOOL_SWEEP_MIN_AGE_MS > 10 * 60 * 1000 && SPOOL_SWEEP_MIN_AGE_MS <= 2 * HOUR, `default sweep age out of the documented band: ${SPOOL_SWEEP_MIN_AGE_MS}`);
  });

  it('reports a missing spill directory instead of creating one', () => {
    const root = scratch();
    const result = sweepStaleSpills(resolveSpoolConfig({ enabled: true, dir: root }));

    assert.deepEqual(result, { removed: 0, keptRecent: 0, skipped: [], dirMissing: true });
    assert.equal(existsSync(requestSpillDir(resolveSpoolConfig({ enabled: true, dir: root }))), false, 'the sweep must not create the spill directory');
    assert.deepEqual(readdirSync(root), [], 'sweeping must leave the spool root untouched');
  });

  it('sweeps every spill directory, with one aggregate count', () => {
    const root = scratch();
    const requests = join(root, REQUEST_SPILL_SUBDIR);
    const responses = join(root, RESPONSE_SPILL_SUBDIR);
    const events = join(root, EVENT_SPILL_SUBDIR);
    mkdirSync(requests, { recursive: true });
    mkdirSync(responses, { recursive: true });
    mkdirSync(events, { recursive: true });
    const staleRequest = writeAged(requests, 'req-stale.body', 2 * HOUR, 'stale request');
    const staleResponse = writeAged(responses, 'resp-stale.body', 2 * HOUR, 'stale response');
    const staleEvent = writeAged(events, 'evt-stale.body', 2 * HOUR, 'stale event');
    const freshResponse = writeAged(responses, 'resp-fresh.body', 10 * 60 * 1000, 'in-flight response');

    const result = sweepStaleSpills(resolveSpoolConfig({ enabled: true, dir: root }));

    assert.equal(result.removed, 3, 'every spill directory is swept');
    assert.equal(result.keptRecent, 1);
    assert.deepEqual(result.skipped, []);
    assert.equal(result.dirMissing, false);
    assert.equal(existsSync(staleRequest), false);
    assert.equal(existsSync(staleResponse), false, 'a leftover response spill is garbage like a request spill');
    assert.equal(existsSync(staleEvent), false, 'a leftover event spill is garbage like a request spill');
    assert.equal(readFileSync(freshResponse, 'utf8'), 'in-flight response', 'a response spill still in flight survives');
  });

  it('reports dirMissing only when no spill directory exists at all', () => {
    // Only the response directory exists, and it holds the stale file: "dir
    // missing" is about the spool as a whole, not about the request subdirectory
    // the sweep used to be the only caller of.
    const root = scratch();
    const responses = join(root, RESPONSE_SPILL_SUBDIR);
    mkdirSync(responses, { recursive: true });
    const stale = writeAged(responses, 'resp-stale.body', 2 * HOUR, 'stale response');

    const result = sweepStaleSpills(resolveSpoolConfig({ enabled: true, dir: root }));

    assert.equal(result.dirMissing, false);
    assert.equal(result.removed, 1);
    assert.equal(existsSync(stale), false);
  });

  it('never follows a symlink or descends into a directory inside the spill directory', () => {
    const { root, dir } = spillRoot();
    const outside = writeAged(root, 'outside.body', 2 * HOUR, 'not spooled');
    const link = join(dir, 'req-link.body');
    symlinkSync(outside, link);
    const nested = join(dir, 'nested');
    mkdirSync(nested);
    const stale = writeAged(dir, 'req-stale.body', 2 * HOUR, 'stale bytes');

    const result = sweepStaleSpills(resolveSpoolConfig({ enabled: true, dir: root }));

    assert.equal(result.removed, 1, 'a genuine stale spill is still removed alongside the oddities');
    assert.equal(existsSync(stale), false);
    assert.equal(readFileSync(outside, 'utf8'), 'not spooled', 'the symlink target must survive untouched');
    assert.equal(existsSync(link), true, 'only regular files are deleted, never the link itself');
    assert.equal(existsSync(nested), true, 'the sweep does not recurse');

    assert.equal(result.skipped.length, 2);
    const reasons = new Map(result.skipped.map((entry) => [entry.path, entry.reason]));
    assert.match(reasons.get(link) ?? '', /symlink or special/);
    assert.match(reasons.get(nested) ?? '', /directory/);
  });

  // Root bypasses directory permission checks, so the failure cannot be staged
  // there. A skip is reported in the runner output rather than passed over.
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it('reports a file it cannot remove instead of throwing or claiming success', { skip: asRoot ? 'running as root: permission checks do not apply' : false }, () => {
    const { root, dir } = spillRoot();
    const stale = writeAged(dir, 'req-stale.body', 2 * HOUR, 'stale bytes');
    chmodSync(dir, 0o500); // read + traverse, no write: unlink must fail
    try {
      const result = sweepStaleSpills(resolveSpoolConfig({ enabled: true, dir: root }));

      assert.equal(result.removed, 0, 'a file that survived must never be counted as removed');
      assert.equal(result.keptRecent, 0, 'it was old enough — this is a failure, not a keep');
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].path, stale);
      assert.match(result.skipped[0].reason, /^cannot unlink: /);
      assert.equal(existsSync(stale), true);
    } finally {
      chmodSync(dir, 0o700);
    }
  });
});
