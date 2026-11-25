import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatBuildVersion } from '../../scripts/build-version.js';

describe('formatBuildVersion', () => {
  it('formats the tag, ordinal commit distance, commit, and dirty suffix', () => {
    const cases = [
      ['v2.8.6-0-g529ff1a', 'v2.8.6-0th-g529ff1a'],
      ['v2.8.6-1-g529ff1a', 'v2.8.6-1st-g529ff1a'],
      ['v2.8.6-2-g529ff1a', 'v2.8.6-2nd-g529ff1a'],
      ['v2.8.6-3-g529ff1a', 'v2.8.6-3rd-g529ff1a'],
      ['v2.8.6-8-g529ff1a-dirty', 'v2.8.6-8th-g529ff1a-dirty'],
      ['v2.8.6-11-g529ff1a', 'v2.8.6-11th-g529ff1a'],
      ['v2.8.6-12-g529ff1a', 'v2.8.6-12th-g529ff1a'],
      ['v2.8.6-13-g529ff1a', 'v2.8.6-13th-g529ff1a'],
      ['v2.8.6-21-g529ff1a', 'v2.8.6-21st-g529ff1a'],
    ];
    for (const [input, expected] of cases) {
      assert.equal(formatBuildVersion(input), expected);
    }
  });

  it('keeps the commit-only fallback used without tags unchanged', () => {
    assert.equal(formatBuildVersion('529ff1a'), '529ff1a');
  });
});
