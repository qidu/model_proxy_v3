/**
 * Unit tests for body-key-store.ts (the win32 SEA in-binary keytar fallback).
 *
 * Covers: set/get round-trip, a miss returning null, last-write-wins for the
 * same account, findCredentials returning the latest password per account
 * filtered by service, fail-loud on a malformed record, and the
 * tryBodyKeyStore gate returning null on a non-win32 host.
 *
 * The gate's win32 + SEA + basename conditions cannot be exercised off
 * Windows; here only the "returns null" branch is observable.
 *
 * Run with: npx tsx --test tests/unit/body-key-store.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBodyKeyStore, tryBodyKeyStore } from '../../src/utils/body-key-store.js';
import { appendRecord } from '../../src/utils/body-record.js';

const SERVICE = 'model_proxy_v3';

function tempBinary(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'body-key-store-test-')), 'app.exe');
  writeFileSync(file, 'binary body');
  return file;
}

describe('createBodyKeyStore', () => {
  it('round-trips a password through the binary body', async () => {
    const file = tempBinary();
    const store = createBodyKeyStore(file);
    await store.setPassword(SERVICE, 'claude/https://api.claude.dev', 'sk-abc');
    assert.equal(await store.getPassword(SERVICE, 'claude/https://api.claude.dev'), 'sk-abc');
  });

  it('returns null for a missing account or a different service', async () => {
    const file = tempBinary();
    const store = createBodyKeyStore(file);
    await store.setPassword(SERVICE, 'claude/https://api.claude.dev', 'sk-abc');
    assert.equal(await store.getPassword(SERVICE, 'other/https://api.other.dev'), null);
    assert.equal(await store.getPassword('another-service', 'claude/https://api.claude.dev'), null);
  });

  it('returns null when the binary holds no records', async () => {
    const store = createBodyKeyStore(tempBinary());
    assert.equal(await store.getPassword(SERVICE, 'claude/https://api.claude.dev'), null);
  });

  it('last write wins for the same account', async () => {
    const file = tempBinary();
    const store = createBodyKeyStore(file);
    await store.setPassword(SERVICE, 'claude/https://api.claude.dev', 'sk-old');
    await store.setPassword(SERVICE, 'claude/https://api.claude.dev', 'sk-new');
    assert.equal(await store.getPassword(SERVICE, 'claude/https://api.claude.dev'), 'sk-new');
  });

  it('findCredentials returns the latest password per account, filtered by service', async () => {
    const file = tempBinary();
    const store = createBodyKeyStore(file);
    await store.setPassword(SERVICE, 'claude/https://a.dev', 'sk-a1');
    await store.setPassword(SERVICE, 'gpt/https://b.dev', 'sk-b1');
    await store.setPassword('other-service', 'x/https://c.dev', 'sk-c1');
    await store.setPassword(SERVICE, 'claude/https://a.dev', 'sk-a2');

    const creds = await store.findCredentials(SERVICE);
    assert.deepEqual(
      creds.sort((x, y) => x.account.localeCompare(y.account)),
      [
        { account: 'claude/https://a.dev', password: 'sk-a2' },
        { account: 'gpt/https://b.dev', password: 'sk-b1' },
      ],
    );
  });

  it('throws loud on a malformed record instead of silently dropping it', async () => {
    const file = tempBinary();
    // A valid record whose payload is not a credential JSON object.
    await appendRecord(file, 'not json');
    const store = createBodyKeyStore(file);
    await assert.rejects(() => store.getPassword(SERVICE, 'claude/https://a.dev'), /malformed record/);
  });
});

describe('tryBodyKeyStore gate', () => {
  it('returns null on a non-win32 host', async () => {
    if (process.platform === 'win32') return; // asserted below only off Windows
    assert.equal(await tryBodyKeyStore(), null);
  });
});