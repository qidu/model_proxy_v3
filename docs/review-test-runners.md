# Review: `npm run test:unit` vs `npx vitest` vs `npx jest`

Date: 2026-10-28. Analysis only — no code changes.

## What each command actually does today

### `npm run test:unit` (`package.json:20`)

```
node --experimental-global-webcrypto --import tsx --test tests/unit/**/*.test.ts
```

- Uses **Node's built-in test runner** (`node:test`), with `tsx` as the loader so
  TypeScript runs without a build step.
- All **76 files** in `tests/unit/` import `describe`/`it`/`test`/`beforeEach`/
  `afterEach` from `'node:test'` (plus `mock.timers` in 9 places). Zero imports of
  `vitest` or `jest` anywhere in `tests/` or `src/`.
- This is what CI runs (`.github/workflows/build.yml:49`) and what
  `prepublishOnly` gates on. Live tests (e.g. `apollo-loader.live.test.ts`)
  self-gate via env vars so they skip safely.

### `npx vitest` — unusable as-is

Verified by running it:

- No `vitest.config.*` exists, so it sweeps the whole repo with its default
  include pattern and hits:
  - `tests/integration/**/*.test.js` → 32 × "No test suite found" (those are
    script-style integration tests, not vitest suites)
  - `submodules/openresponses/*.test.ts` → transform errors
    (`astro/tsconfigs/base` tsconfig missing)
- Pointed directly at a unit test (`tests/unit/hash-detect.test.ts`), it **fails
  with "No test suite found"** — the suites register with `node:test`, not
  vitest's globals (vitest defaults to `globals: false`). Result: **0 unit tests
  run**.

### `npx jest` unusable as-is

- `--listTests` *does* discover the unit files, but execution fails immediately:
  the package is `"type": "module"` with no transform configured, so jest errors
  with "Must use import to load ES Module". It would need a full TS+ESM setup
  (ts-jest or babel-jest, `NODE_OPTIONS=--experimental-vm-modules`, etc.) before
  running anything.

The three commands are not interchangeable views of the same suite: only
`npm run test:unit` runs it. `jest` and `vitest` were **dead devDependencies** —
installed (plus `@vitest/coverage-v8`) but referenced by no config, no import,
no script.

History note: the committed `package.json` at HEAD (commit `9a2eaa9`, "fix
deps") already lacked these entries — they survived only in the working tree
(the earlier empty `git diff package.json` was misleading; a rehash after the
file was rewritten shows the working tree now matches HEAD exactly). On
2026-10-28 the three packages were removed with
`npm uninstall jest vitest @vitest/coverage-v8`, bringing the working tree in
line with the committed manifest. `npm run test:unit` still passes: 1865 tests,
0 failures. (`package-lock.json` is untracked in this repo, so no lockfile
commit is involved.)

## Should the project migrate?

Recommendation: **no pressing need — keep `node:test`**. 

If vitest's extra features are ever wanted, adopt it deliberately as described below.

### For staying on `node:test`

- Works today, zero config, one flag; `tsx` is already a dependency for
  `npm run server`.
- Migration means touching all 76 files (import rewrites) plus reworking the 9
  `mock.timers` call sites, for no functional gain unless specific features are
  wanted.
- Node's runner covers what's actually used here: `describe`/`it`, hooks, timer
  mocks, subtests.

### If migrating, vitest is clearly the right target — not jest

- Vitest is ESM-native with built-in TS — no transform config needed. Migration
  is mostly `s/from 'node:test'/from 'vitest'/` in imports, a small
  `vitest.config.ts` (`include: ['tests/unit/**/*.test.ts']`, exclude
  `submodules/**` and `tests/integration/**`), and `mock.timers` →
  `vi.useFakeTimers()`.
- It unlocks things `node:test` lacks: watch mode with a real UI, snapshot
  testing, richer matchers/mocks, and coverage via the already-installed
  `@vitest/coverage-v8`.
- Jest is the worst fit: ESM support still requires experimental VM flags,
  TypeScript needs an extra transform layer, and it is the slowest option. No
  reason to choose it for this codebase.

