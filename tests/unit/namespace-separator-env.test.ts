import { test } from 'node:test';
import assert from 'node:assert/strict';

// This file must be the only importer of responses-to-completions in its
// process: the module reads NAMESPACE_SEPARATOR once at load time, so the env
// var has to be set before the (dynamic) import runs. `node --test` executes
// each test file in its own process, so the static imports in other test files
// don't load it first here.
test('rejects an out-of-charset NAMESPACE_SEPARATOR at module load', async () => {
  process.env.NAMESPACE_SEPARATOR = '.';
  await assert.rejects(
    () => import('../../src/converters/responses-to-completions.js'),
    /Invalid NAMESPACE_SEPARATOR/,
  );
});
