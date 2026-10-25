import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  stripBearerPrefix,
  pickRawApiKey,
  extractRawCredential,
  resolveIncomingAuthorization,
  repackBearerCredential,
  normalizeOpenAIAuthHeaders,
} from '../../src/utils/auth-headers.js';

/**
 * Tests for auth header credential extraction / repack utilities.
 */

describe('stripBearerPrefix', () => {
  it('returns a plain value unchanged', () => {
    assert.equal(stripBearerPrefix('sk-abc123'), 'sk-abc123');
  });

  it('strips a `Bearer ` prefix', () => {
    assert.equal(stripBearerPrefix('Bearer sk-abc123'), 'sk-abc123');
  });

  it('strips a lowercase `bearer ` prefix', () => {
    assert.equal(stripBearerPrefix('bearer sk-abc123'), 'sk-abc123');
  });

  it('strips multiple spaces after the prefix', () => {
    assert.equal(stripBearerPrefix('Bearer   sk-abc123'), 'sk-abc123');
  });

  it('returns empty string for undefined and null', () => {
    assert.equal(stripBearerPrefix(undefined), '');
    assert.equal(stripBearerPrefix(null), '');
  });
});

describe('pickRawApiKey', () => {
  it('returns null when every source is null or undefined', () => {
    assert.equal(pickRawApiKey([null, undefined, null]), null);
    assert.equal(pickRawApiKey([]), null);
  });

  it('first present source wins even when a later source also exists', () => {
    assert.equal(pickRawApiKey(['first-key', 'second-key']), 'first-key');
    assert.equal(pickRawApiKey([null, 'second-key', 'third-key']), 'second-key');
  });

  it('strips a `Bearer ` prefix from the picked source', () => {
    assert.equal(pickRawApiKey(['Bearer first-key', 'Bearer second-key']), 'first-key');
  });

  it('strips a lowercase `bearer ` prefix from the picked source', () => {
    assert.equal(pickRawApiKey(['bearer lower-key', 'plain-key']), 'lower-key');
  });

  it('strips multiple spaces after the prefix from the picked source', () => {
    assert.equal(pickRawApiKey(['Bearer   spaced-key']), 'spaced-key');
  });

  it('returns the picked source raw when it has no prefix', () => {
    assert.equal(pickRawApiKey(['plain-key', 'Bearer other-key']), 'plain-key');
  });

  it('a non-empty source that strips to empty string still wins (intentional: the caller\'s guard then emits no auth)', () => {
    assert.equal(pickRawApiKey(['Bearer ', 'real-key']), '');
  });

  it('an empty preferred header falls back to the next credential (regression: empty x-api-key + valid Authorization)', () => {
    assert.equal(pickRawApiKey(['', 'valid-key']), 'valid-key');
  });

  it('passes non-Bearer values through untouched', () => {
    assert.equal(pickRawApiKey(['sk-abc123', null]), 'sk-abc123');
  });
});

describe('extractRawCredential', () => {
  it('authorization-first strips the Authorization bearer token', () => {
    assert.equal(
      extractRawCredential({ Authorization: 'Bearer sk-abc' }, 'authorization-first'),
      'sk-abc',
    );
  });

  it('authorization-first falls back to x-goog-api-key unstripped when no Authorization', () => {
    assert.equal(
      extractRawCredential({ 'x-goog-api-key': 'Bearer goog-key' }, 'authorization-first'),
      'Bearer goog-key',
    );
  });

  it('authorization-first matches a lowercase authorization header', () => {
    assert.equal(
      extractRawCredential({ authorization: 'Bearer sk-lower' }, 'authorization-first'),
      'sk-lower',
    );
  });

  it('goog-api-key-first strips the x-goog-api-key bearer token', () => {
    assert.equal(
      extractRawCredential({ 'x-goog-api-key': 'Bearer goog-key' }, 'goog-api-key-first'),
      'goog-key',
    );
  });

  it('goog-api-key-first prefers x-goog-api-key over Authorization', () => {
    assert.equal(
      extractRawCredential(
        { 'x-goog-api-key': 'goog-key', Authorization: 'Bearer auth-key' },
        'goog-api-key-first',
      ),
      'goog-key',
    );
  });

  it('goog-api-key-first falls back to bearer-stripped Authorization', () => {
    assert.equal(
      extractRawCredential({ Authorization: 'Bearer auth-key' }, 'goog-api-key-first'),
      'auth-key',
    );
  });

  it('returns undefined when no credential is present', () => {
    assert.equal(extractRawCredential({}, 'authorization-first'), undefined);
    assert.equal(extractRawCredential({}, 'goog-api-key-first'), undefined);
  });

  it('defaults to authorization-first order', () => {
    assert.equal(extractRawCredential({ Authorization: 'Bearer sk-def' }), 'sk-def');
  });
});

describe('resolveIncomingAuthorization', () => {
  it('prefers bearer-stripped Authorization over x-api-key and x-goog-api-key', () => {
    const headers = new Headers({
      Authorization: 'Bearer auth-key',
      'x-api-key': 'api-key',
      'x-goog-api-key': 'goog-key',
    });
    assert.equal(resolveIncomingAuthorization(headers), 'auth-key');
  });

  it('falls back to raw x-api-key when Authorization is absent', () => {
    const headers = new Headers({
      'x-api-key': 'api-key',
      'x-goog-api-key': 'Bearer goog-key',
    });
    assert.equal(resolveIncomingAuthorization(headers), 'api-key');
  });

  it('falls back to bearer-stripped x-goog-api-key when the others are absent', () => {
    const headers = new Headers({ 'x-goog-api-key': 'Bearer goog-key' });
    assert.equal(resolveIncomingAuthorization(headers), 'goog-key');
  });

  it('returns empty string when no credential header is present', () => {
    assert.equal(resolveIncomingAuthorization(new Headers()), '');
  });
});

describe('repackBearerCredential', () => {
  it('repacks Authorization into the target header and deletes Authorization', () => {
    const headers: Record<string, string> = { Authorization: 'Bearer sk-abc' };
    repackBearerCredential(headers, 'x-api-key');
    assert.deepEqual(headers, { 'x-api-key': 'sk-abc' });
  });

  it('leaves the target header untouched when already present', () => {
    const headers: Record<string, string> = {
      Authorization: 'Bearer sk-abc',
      'x-api-key': 'existing-key',
    };
    repackBearerCredential(headers, 'x-api-key');
    assert.deepEqual(headers, {
      Authorization: 'Bearer sk-abc',
      'x-api-key': 'existing-key',
    });
  });

  it('does nothing when there is no Authorization header', () => {
    const headers: Record<string, string> = { 'x-api-key': 'existing-key' };
    repackBearerCredential(headers, 'x-api-key');
    assert.deepEqual(headers, { 'x-api-key': 'existing-key' });
  });
});

describe('normalizeOpenAIAuthHeaders', () => {
  it('returns headers unchanged for a non-Azure URL', () => {
    const headers: Record<string, string> = { Authorization: 'Bearer sk-abc' };
    assert.equal(normalizeOpenAIAuthHeaders(headers, 'https://api.openai.com/v1'), headers);
  });

  it('folds bearer-stripped Authorization into api-key for an Azure URL', () => {
    const headers: Record<string, string> = { Authorization: 'Bearer azure-key' };
    const normalized = normalizeOpenAIAuthHeaders(headers, 'https://x.openai.azure.com/openai/v1');
    assert.deepEqual(normalized, { 'api-key': 'azure-key' });
  });

  it('prefers api-key over x-api-key over Authorization', () => {
    const withApiKey: Record<string, string> = {
      'api-key': 'api-key-val',
      'x-api-key': 'x-api-key-val',
      Authorization: 'Bearer auth-val',
    };
    assert.deepEqual(
      normalizeOpenAIAuthHeaders(withApiKey, 'https://x.cognitiveservices.azure.com/v1'),
      { 'api-key': 'api-key-val' },
    );

    const withXApiKey: Record<string, string> = {
      'x-api-key': 'x-api-key-val',
      Authorization: 'Bearer auth-val',
    };
    assert.deepEqual(
      normalizeOpenAIAuthHeaders(withXApiKey, 'https://x.cognitiveservices.azure.com/v1'),
      { 'api-key': 'x-api-key-val' },
    );
  });

  it('matches Azure URLs case-insensitively and deletes folded headers', () => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      authorization: 'Bearer lower-auth',
      'x-api-key': 'x-api-key-val',
    };
    const normalized = normalizeOpenAIAuthHeaders(headers, 'https://X.OPENAI.AZURE.COM/v1');
    assert.deepEqual(normalized, {
      'Content-Type': 'application/json',
      'api-key': 'x-api-key-val',
    });
  });
});
