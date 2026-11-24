/**
 * Unit tests for the anthropic-beta header helpers in src/utils/beta-features.ts.
 *
 * Run with: npx tsx --test tests/unit/beta-features.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  VALID_BETA_FEATURES,
  validateBetaFeatures,
  hasBetaFeature,
  createBetaHeader,
  validateBetaFeaturesForEndpoint,
} from '../../src/utils/beta-features.js';

describe('validateBetaFeatures', () => {
  it('returns null for null / empty header', () => {
    assert.equal(validateBetaFeatures(null), null);
    assert.equal(validateBetaFeatures(''), null);
  });

  it('parses comma-separated features and trims whitespace', () => {
    assert.deepEqual(
      validateBetaFeatures('prompt-caching-2024-07-31, interleaved-thinking-2025-05-14,pdfs-2024-09-25'),
      ['prompt-caching-2024-07-31', 'interleaved-thinking-2025-05-14', 'pdfs-2024-09-25'],
    );
  });

  it('preserves unknown features instead of allowlisting values', () => {
    assert.deepEqual(
      validateBetaFeatures('future-oauth-capability,made-up-feature-9999'),
      ['future-oauth-capability', 'made-up-feature-9999'],
    );
  });

  it('skips empty entries', () => {
    assert.deepEqual(validateBetaFeatures('prompt-caching-2024-07-31, ,pdfs-2024-09-25,'), [
      'prompt-caching-2024-07-31',
      'pdfs-2024-09-25',
    ]);
    assert.deepEqual(validateBetaFeatures(' , '), []);
  });

  it('accepts every feature in VALID_BETA_FEATURES', () => {
    assert.deepEqual(validateBetaFeatures(VALID_BETA_FEATURES.join(',')), [...VALID_BETA_FEATURES]);
  });
});

describe('hasBetaFeature', () => {
  it('detects interleaved thinking in a normal comma-separated header', () => {
    const features = validateBetaFeatures('future-feature,interleaved-thinking-2025-05-14');
    assert.equal(hasBetaFeature(features, 'interleaved-thinking-2025-05-14'), true);
  });

  it('false when the feature is absent', () => {
    assert.equal(hasBetaFeature(['prompt-caching-2024-07-31'], 'pdfs-2024-09-25'), false);
  });

  it('false when the feature list is null', () => {
    assert.equal(hasBetaFeature(null, 'pdfs-2024-09-25'), false);
  });

  it('false for an empty feature list', () => {
    assert.equal(hasBetaFeature([], 'pdfs-2024-09-25'), false);
  });
});

describe('createBetaHeader', () => {
  it('serializes features to a comma-separated string', () => {
    assert.equal(
      createBetaHeader(['prompt-caching-2024-07-31', 'pdfs-2024-09-25']),
      'prompt-caching-2024-07-31,pdfs-2024-09-25',
    );
  });

  it('round-trips through validateBetaFeatures', () => {
    const features = ['token-counting-2024-11-01', 'files-api-2025-04-14'];
    assert.deepEqual(validateBetaFeatures(createBetaHeader(features)), features);
  });

  it('serializes an empty list to an empty string', () => {
    assert.equal(createBetaHeader([]), '');
  });
});

describe('validateBetaFeaturesForEndpoint', () => {
  it('does not throw for null features', () => {
    assert.doesNotThrow(() => validateBetaFeaturesForEndpoint(null, 'v1/messages/count_tokens'));
  });

  it('does not throw for the token-counting endpoint with/without the feature', () => {
    assert.doesNotThrow(() =>
      validateBetaFeaturesForEndpoint(['token-counting-2024-11-01'], 'v1/messages/count_tokens'),
    );
    assert.doesNotThrow(() =>
      validateBetaFeaturesForEndpoint(['pdfs-2024-09-25'], 'v1/messages/count_tokens'),
    );
  });

  it('does not throw for files / skills endpoints', () => {
    assert.doesNotThrow(() => validateBetaFeaturesForEndpoint([], 'v1/files/abc'));
    assert.doesNotThrow(() => validateBetaFeaturesForEndpoint([], 'v1/skills/xyz'));
  });

  it('returns undefined (void)', () => {
    assert.equal(validateBetaFeaturesForEndpoint(null, 'v1/messages'), undefined);
  });
});
