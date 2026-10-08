# `pi-agent-core` skills feature: relative-path crash on Windows

**Status:** Workaround shipped in this repo (`src/agent-session.ts`); real fix
belongs upstream in `@earendil-works/pi-agent-core`. This doc records the root
cause and a concrete patch proposal for that package.

**Affected package:** `@earendil-works/pi-agent-core@0.81.1`
**Affected file:** `dist/harness/skills.js` (compiled; no `.ts` source is
shipped in the installed package — see "Where to apply" below)
**Symptom surface in this repo:** `src/agent-session.ts`'s
`gatherSkillCandidates` / `loadSelectedSkills`, which call the package's
`loadSkills()`.

## Symptom

On Windows, any call to `loadSkills()` against a directory that actually
contains skill files throws:

```
RangeError [Error]: path should be a `path.relative()`d string, but got
"C:\Users\teric\AppData\Local\Temp\agent-session-test-global-ljHE0F\global-skill/"
    at throwError (node_modules/ignore/index.js:557:9)
```

This is **not** limited to edge cases (e.g. a malformed lock file) — it
reproduces on the very first real skill directory `loadSkills()` walks. In
this repo's test suite, it took down 9 of 9 tests in
`tests/unit/agent-session.test.ts` that exercise real skill loading; only the
"no directories exist" cases were unaffected.

## Root cause

`loadSkills()` (`skills.js`) accepts an `env: ExecutionEnv` and walks
directories via `env.fileInfo()` / `env.listDir()`. This repo passes
`NodeExecutionEnv` (`@earendil-works/pi-agent-core/node`), whose `fileInfo`/
`listDir` resolve paths with Node's `node:path` `resolve`/`join`:

```js
// dist/harness/env/nodejs.js
import { isAbsolute, join, resolve } from "node:path";
...
async fileInfo(path) {
    const resolved = resolvePath(this.cwd, path);   // <- backslashes on win32
    ...
}
```

On win32, `node:path` produces **backslash-separated** absolute paths (e.g.
`C:\Users\...\global-skill`).

Inside `skills.js`, every file/directory visited during the walk is turned
into an "ignore-relative" path via a hand-rolled helper — **not**
`node:path`'s `path.relative()`:

```js
// dist/harness/skills.js
function relativeEnvPath(root, path) {
    const normalizedRoot = root.replace(/\/+$/, "");
    const normalizedPath = path.replace(/\/+$/, "");
    if (normalizedPath === normalizedRoot)
        return "";
    return normalizedPath.startsWith(`${normalizedRoot}/`)   // <- forward slash only
        ? normalizedPath.slice(normalizedRoot.length + 1)
        : normalizedPath.replace(/^\/+/, "");
}
```

`relativeEnvPath` assumes both `root` and `path` are `/`-joined. On win32
they're `\`-joined, so:

1. `normalizedPath.startsWith(`${normalizedRoot}/`)` is always `false`
   (there's no `/` in either string to match against).
2. It falls through to `normalizedPath.replace(/^\/+/, "")`, which is a
   no-op on a string with no leading `/` — so the function returns the
   **entire raw absolute Windows path**, unchanged, instead of a path
   relative to `root`.

That mis-relativized path is then handed straight to the `ignore` package
(both for `SKILL.md` matching, `skills.js:94-95`, and for directory/file
ignore-rule matching, `skills.js:110-112`, with a trailing `/` appended for
directories):

```js
const relPath = relativeEnvPath(rootDir, fullPath);
if (ignoreMatcher.ignores(relPath))   // relPath is a raw absolute Windows path
    continue;
```

`ignore`'s `.ignores()` explicitly rejects any non-relative / absolute-looking
input (`node_modules/ignore/index.js:557`, `throwError` — the same guard that
protects against accidentally ignoring paths outside the ignore root) and
throws the `RangeError` seen above.

Same bug also affects `addIgnoreRules`'s use of `relativeEnvPath` for
`.gitignore`/`.ignore` scoping (`skills.js:130`), independent of skill-file
matching.

## Why this is upstream's bug, not this repo's

- This repo's call site (`src/agent-session.ts`, `gatherSkillCandidates`)
  passes directories and an `env` exactly as the package's public API
  expects — no bespoke path handling on this repo's side triggers the crash.
- The bug is entirely inside `relativeEnvPath`'s string manipulation, which
  never delegates to `node:path.relative()` and assumes POSIX separators
  unconditionally, regardless of which `ExecutionEnv` produced the paths.
- `NodeExecutionEnv` is the package's own "use real Node fs" environment
  implementation — it's expected to hand back platform-native paths on
  win32, so the bug is in `skills.js` not normalizing before treating paths
  as POSIX-relative, not in `NodeExecutionEnv` for returning backslash paths.

## Patch proposal

Minimal, POSIX-preserving fix: normalize backslashes to forward slashes
*before* the relative-path computation, using `node:path` semantics instead
of ad hoc string slicing. This keeps the function's existing "cheap string
op, no filesystem access" character (`relativeEnvPath` currently doesn't
import `node:path` at all) while making it correct on both separators.

```diff
--- a/dist/harness/skills.js
+++ b/dist/harness/skills.js
@@ -1,4 +1,5 @@
 import ignore from "ignore";
+import { posix, sep } from "node:path";
 import { parse } from "yaml";
 import { toError } from "./types.js";
 const MAX_NAME_LENGTH = 64;
@@ -299,13 +300,20 @@ function basenameEnvPath(path) {
     const slashIndex = normalized.lastIndexOf("/");
     return slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
 }
+/** Converts a platform-native path (win32 backslashes or POSIX forward
+ * slashes) to a forward-slash form, so downstream "/"-based logic (this
+ * file's own helpers, and the `ignore` package, which requires a
+ * `path.relative()`-style POSIX-relative string) works regardless of the
+ * ExecutionEnv's host platform. */
+function toPosixSeparators(path) {
+    return sep === "\\" ? path.split(sep).join("/") : path;
+}
 function relativeEnvPath(root, path) {
-    const normalizedRoot = root.replace(/\/+$/, "");
-    const normalizedPath = path.replace(/\/+$/, "");
+    const normalizedRoot = toPosixSeparators(root).replace(/\/+$/, "");
+    const normalizedPath = toPosixSeparators(path).replace(/\/+$/, "");
     if (normalizedPath === normalizedRoot)
         return "";
-    return normalizedPath.startsWith(`${normalizedRoot}/`)
-        ? normalizedPath.slice(normalizedRoot.length + 1)
-        : normalizedPath.replace(/^\/+/, "");
+    return normalizedPath.startsWith(`${normalizedRoot}/`)
+        ? posix.relative(normalizedRoot, normalizedPath)
+        : normalizedPath.replace(/^\/+/, "");
 }
```

Notes on the patch:

- `toPosixSeparators` only touches `\` when `node:path`'s `sep` is `\`
  (i.e., on win32), so POSIX hosts are byte-for-byte unaffected — no
  behavior change on macOS/Linux.
- Swapping the final branch to `posix.relative(normalizedRoot,
  normalizedPath)` (rather than the original manual `.slice()`) makes the
  "known prefix" case robust to any residual double-slash/edge segments,
  matching the intent the function's name (`relativeEnvPath`) already
  implies — it should behave like `path.relative()`, just on the env's
  logical (POSIX-style) path representation instead of the OS's.
- `dirnameEnvPath`/`basenameEnvPath` (used by `formatSkillInvocation` for
  the `Skill.filePath` shown to the agent) have the same forward-slash
  assumption but don't feed into `ignore()`, so they don't throw — only
  `relativeEnvPath`'s callers do. They're left out of this minimal patch to
  keep it scoped to the actual crash; if `filePath` display also needs to
  read naturally on Windows, that's a separate, non-crashing follow-up.

## Where to apply

The installed package only ships compiled `dist/*.js` (no `.ts` source), so:

- **As an upstream contribution:** the equivalent change should be made in
  `pi-agent-core`'s TypeScript source (`src/harness/skills.ts` by the
  `dist/**/*.d.ts.map` `sourceRoot` references), then released as a patch
  version bump.
- **As a local, non-upstream stopgap** (if needed before an upstream release
  lands): apply the `dist/harness/skills.js` diff above via
  [`patch-package`](https://www.npmjs.com/package/patch-package) (or `pnpm
  patch`), checked into this repo, and re-verify the patch on every
  `@earendil-works/pi-agent-core` version bump. This repo does **not**
  currently carry that patch — see the win32 runtime guard below instead.

## Current mitigation in this repo (until upstream ships a fix)

Rather than patching `node_modules`, `src/agent-session.ts`'s
`gatherSkillCandidates` disables the `loadSkills()` call path
(pi-scoped skill discovery) on `process.platform === 'win32'`, logging why,
and leaves lock-file-based other-agent candidates
(`gatherOtherAgentCandidates`, which never calls `loadSkills()`) enabled:

```diff
--- a/src/agent-session.ts
+++ b/src/agent-session.ts
@@ -414,16 +414,32 @@ export async function gatherSkillCandidates(
   globalSkillsDir: string = GLOBAL_SKILLS_DIR,
   lockPath: string = SKILL_LOCK_PATH,
 ): Promise<SkillCandidate[]> {
-  const env = new NodeExecutionEnv({ cwd: workDir });
-  const projectSkillsDir = resolve(workDir, '.pi/skills');
-  const { skills, diagnostics } = await loadSkills(env, [projectSkillsDir, globalSkillsDir]);
-  for (const diag of diagnostics) {
-    console.log(dim(`[skills] ${diag.code}: ${diag.message} (${diag.path})`));
+  // @earendil-works/pi-agent-core's loadSkills() walks directories via
+  // NodeExecutionEnv, which resolves paths with node:path (backslashes on
+  // win32), then hands them to its internal relativeEnvPath() — that function
+  // does naive "/"-string slicing instead of path.relative(), so on win32 it
+  // never strips the root prefix and passes a raw absolute Windows path into
+  // the `ignore` package, which throws `RangeError: path should be a
+  // path.relative()d string`. This reproduces on any real skill directory,
+  // not just edge cases, so pi-scoped skill loading is disabled on win32
+  // until upstream fixes it (lock-file-based other-agent candidates below
+  // don't go through loadSkills(), so they're unaffected and stay enabled).
+  // Tracked upstream against pi-agent-core.
+  let piScoped: SkillCandidate[] = [];
+  if (process.platform === 'win32') {
+    console.log(dim('[skills] pi-scoped skill loading disabled on win32 (upstream pi-agent-core bug: relativeEnvPath mishandles backslash paths) — see agent-session.ts gatherSkillCandidates.'));
+  } else {
+    const env = new NodeExecutionEnv({ cwd: workDir });
+    const projectSkillsDir = resolve(workDir, '.pi/skills');
+    const { skills, diagnostics } = await loadSkills(env, [projectSkillsDir, globalSkillsDir]);
+    for (const diag of diagnostics) {
+      console.log(dim(`[skills] ${diag.code}: ${diag.message} (${diag.path})`));
+    }
+    piScoped = skills.map((skill) => ({
+      item: { value: skill.name, label: skill.name, description: 'pi' },
+      skill,
+    }));
   }
-  const piScoped: SkillCandidate[] = skills.map((skill) => ({
-    item: { value: skill.name, label: skill.name, description: 'pi' },
-    skill,
-  }));
   const otherAgent = await gatherOtherAgentCandidates(new Set(piScoped.map((c) => c.item.value)), lockPath);
   return [...piScoped, ...otherAgent];
 }
```

Corresponding test changes: `tests/unit/agent-session.test.ts` gained an
`IS_WIN32` check so tests that load a real pi-scoped skill assert the
disabled-on-win32 (`[]`) behavior on that platform and the real-loading
behavior elsewhere; the lock-file-only test (other-agent candidates, no
`loadSkills()` involved) is unconditional since it's unaffected on any
platform. See `CHANGELOG.md` ("fix(agent-session): disable pi-scoped skill
loading on win32 (upstream `ignore` crash)") for the full narrative.

**This mitigation is a feature gate, not a fix** — it removes Windows users'
ability to load `pi`-scoped skills (global `~/.pi/agent/skills` and
project-scoped `<workDir>/.pi/skills`) entirely until the upstream patch
above (or equivalent) ships in a `@earendil-works/pi-agent-core` release.
Revisit this doc and the guard in `src/agent-session.ts` once that happens.
