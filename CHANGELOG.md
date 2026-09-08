# Changelog

Historical changes to `model_proxy_v3`. For current usage documentation, see
[README.md](./README.md).

## Latest Changes

### feat(config): blank api_key in the model target wizard reuses a same-base_url keychain entry

When the api-key field is left blank in the "Add target model" wizard (TUI `m`
and dashboard), `upsertModelTarget` now first scans sibling entries within the
*same category* for one already storing `STORE_KEY_IN_SYSTEM` whose effective
base_url (entry's own, falling back to the category's) matches this entry's —
using the same base_url prefix-relation scoring the keychain best-effort
resolver uses (`scoreBaseUrlMatch`, extracted from `key-store.ts`'s
`scoreAccountMatch`; target-name similarity intentionally not considered
here, only base_url). If a match is found, the new entry adopts the sentinel
so it resolves from the same keychain account instead of silently landing on
the category's plaintext `api_key` (previous blank behavior, still the
fallback when no match is found). Editing an entry never matches against
itself, so clearing a previously-plaintext key by blanking the field still
clears it rather than resurrecting a sentinel.

- `src/utils/key-store.ts`: new exported `scoreBaseUrlMatch` (base_url-only
  half of `scoreAccountMatch`, reused by both).
- `src/utils/config-loader.ts`: `upsertModelTarget` — same-category
  `STORE_KEY_IN_SYSTEM` lookup on blank `api_key`.
- `src/handlers/dashboard.ts`: wizard step-3 helper text updated to mention
  the new blank-key behavior.
- `tests/unit/config-loader.test.ts`: regression tests for same-base_url
  match, category-base_url-fallback match, no-match (stays blank),
  cross-category isolation, and self-exclusion on edit.

### fix(config): reject hand-typed `STORE_KEY_IN_SYSTEM` sentinel in the model target wizard

Closes the TODO left in the `feat(config)` entry below. The "Add target model"
wizard's api-key field (TUI `m` and dashboard) had no guardrail against a user
typing/pasting the literal sentinel `STORE_KEY_IN_SYSTEM` by hand. Unlike
`applySystemKeyStore`'s own store-pass (which only ever writes the sentinel
right after storing a real plaintext key to the matching keychain account), a
hand-typed sentinel was written verbatim with no keychain entry behind it. On
next load, resolution keys off `<target>/<base_url>` and could silently
succeed against an unrelated or stale keychain entry sharing that account
(wrong key, no error) instead of failing loud.

`upsertModelTarget` now throws when `patch.api_key === STORE_KEY_IN_SYSTEM`
unless the entry being edited already held that exact sentinel (the
"leave unchanged" edit path, which is backed by a real keychain entry). Both
the TUI wizard and the dashboard wizard call this same function, so the
guardrail applies to both without duplicating the check.

- `src/utils/config-loader.ts`: `upsertModelTarget` — compare `patch.api_key`
  against the existing entry's index-2 value before accepting the sentinel.
- `tests/unit/config-loader.test.ts`: regression tests for add, edit-not-
  previously-sentinel (both throw), and edit-already-sentinel (allowed).

### fix(tui): custom model test sent the wrong api key for plain `[models.*]` targets

Testing a plain (non-composite) model target in the TUI's custom model test
(e.g. `bbb`) could send the proxy-wide `default_upstream.default_api_key`
upstream instead of the model's own key — a 401 from the upstream provider,
even though the config and keychain were both correct and the dashboard's own
"test" button worked fine for the same model.

Root cause: the TUI's test resolver (`resolveModelTestConfig`) reads the
sanitized dashboard snapshot (`snapshot.config`), where every model entry has
already been reduced to `[target, base_url, mode]` with `api_key` stripped for
display. For a model whose category has no category-level `api_key` (e.g. a
one-off entry under its own `[models.<category>]` section), the resolver had
no source for the entry's real key and fell through to
`categoryConfig.api_key || config.default_upstream?.default_api_key` — both
undefined-or-wrong for that entry — so `executeModelTest` sent the *proxy's*
default key (a different provider/account entirely) instead of failing loud
or using the model's own key.

`resolveModelTestConfig` now also accepts the real, unsanitized `ProxyConfig`
and uses `getModelRouteConfig(modelId, realConfig).apiKey` — the same resolver
the dashboard's test button already uses — as the fallback ahead of
`default_upstream`, for both the array and inline-table entry shapes.

- `src/tui.ts`: `resolveModelTestConfig` (new `realConfig` param + api key
  fallback), both call sites in `runModelTest`/`executeModelTest`; exported
  the function (matches the existing `buildTestTextRequest`-style convention)
  so it's unit-testable.
- `tests/unit/tui.test.ts`: new file — regression tests asserting the real
  per-model key is used instead of the wrong proxy-wide default.

### fix(dashboard): inline-table `[models.*]` entries dropped from the sanitized snapshot

An entry written as an inline table (e.g. `bbb = {target = "...", base_url = "...",
api_key = "...", mode = "..."}` — the shape `upsertModelTarget`/the "Add target
model" wizard writes) was silently dropped by `sanitizeDashboardCategoryConfig`,
which only handled array- and string-shaped entries. The TUI's model-test picker
reads this sanitized snapshot (`toDashboardConfigPayload` via `getDashboardSnapshot`),
so testing such a model there found no config, fell back to wrong defaults
(`anthropic-messages` mode, no api key), and failed — while the dashboard's own
"test" button worked because `handleDashboardTestModel` resolves the model
against the real, unsanitized config via `getModelRouteConfig`.

`sanitizeDashboardCategoryConfig` now also converts object-shaped entries into
the same 3-element `[target, base_url, mode]` shape used for arrays (`api_key`
stripped either way).

- `src/utils/config-loader.ts`: `sanitizeDashboardCategoryConfig` object branch.
- `tests/unit/config-loader.test.ts`: regression test for the inline-table case.

**TODO:** the "Add target model" wizard's API-key field (TUI `m` and dashboard)
has no guardrail against a user typing/pasting the literal sentinel
`STORE_KEY_IN_SYSTEM` by hand. Unlike `applySystemKeyStore`'s own store-pass
(which only ever writes the sentinel after it has just stored a real plaintext
key to the matching keychain account), a hand-typed sentinel is written
verbatim with no keychain entry behind it. On next load, resolution keys off
`<target>/<base_url>` and can silently succeed against an unrelated or stale
keychain entry that happens to share that account (wrong key, no error) instead
of failing loud — hit this exactly with `bbb` (`target =
"nvidia/nemotron-3-ultra-550b-a55b:free"`, `base_url =
"https://openrouter.ai/api/v1"`), which resolved to a stale key left over
under that account and got rejected by OpenRouter; fixed by overwriting that
keychain entry, no code change needed. Consider validating in the wizard (and/or
`upsertModelTarget`) that a literal `STORE_KEY_IN_SYSTEM` is only accepted when
a keychain entry already exists for the resulting `<target>/<base_url>` account.

### feat(dashboard): 'Add target model' wizard in web dashboard

Adds a web-dashboard equivalent of the TUI's "Add target" wizard (see the
`feat(tui)` entry below): a new "Add target model" button, styled and
structured like the existing "Add composite alias" wizard (step counter,
Back/Next/Cancel, inline status-line validation, Esc-to-cancel-at-any-step).
6 steps: alias key → target model id → api key → base url → upstream mode →
category (pick an existing `[models.*]` section from a `<select>`, or
choose "+ new category…" to type a new section name).

Saves through a new dedicated endpoint backed by the same
`upsertModelTargetFromDashboard` mutator the TUI wizard uses, rather than
the generic whole-page config save — the whole-page path
(`collectConfigPayload` → `PUT /dashboard/api/config`) intentionally never
round-trips `transforms`/`max_tokens` (config-file-only fields) and this
avoids touching that path at all; only the single new/edited entry is
written. The existing per-category "Add model entry" quick-add
(`openAddModelWizard`) is unchanged.

- `src/handlers/dashboard.ts`: `handleDashboardUpsertModelTarget` handler,
  new `modelTargetWizard` modal markup, `openAddModelTargetWizard()` client
  wizard, `add-model-target` trigger button/click-dispatch branch.
- `src/index.ts`: new route `POST /dashboard/api/models/:category/:aliasKey`.
- Integration tests in `tests/integration/07_dashboard/dashboard_api.test.js`
  (TC719 valid upsert round-trip, TC720 invalid-mode 400 rejection).

### feat(tui): 'Add target' wizard bound to 'm' key

Top-level `m` key in the TUI (Dashboard view) opens an "Add target" panel listing all
`[models.*]` entries across categories. Selecting an existing entry opens a 4-step
wizard (target model id → api key → base url → upstream mode) pre-filled with its
current values for editing. Choosing "+ _input new target_" collects an alias key,
then runs the same 4 steps, followed by a final category step: pick an existing
`[models.*]` section from a list, or choose "+ _input new category_" to type a new
section name. Saves to `proxy_config.toml` via the existing dashboard persistence
path (`saveConfigMutation` → `loadProxyConfigFromPath` → `persistProxyConfigToPath`
→ `clearProxyConfigCache`).

- `src/utils/config-loader.ts`: new `upsertModelTarget` mutator preserving
  indices 4 (transforms) and 5 (max_tokens) when editing, validating upstream
  mode against the closed set (`anthropic-messages`, `openai-responses`,
  `gemini-generatecontent`).
- `src/handlers/dashboard.ts`: `upsertModelTargetFromDashboard` wrapper and
  `getModelTargetFromDashboard` read helper (returns real api_key/mode since
  the TUI only has the sanitized dashboard snapshot).
- `src/tui.ts`: `openModelTargetPicker`, `openModelTargetWizard`,
  `openModelCategoryPicker` (last step for new targets only, editing keeps its
  existing category), `openModelModePicker` — callback-chained multi-step
  flow using existing `ListOverlay` and `openPrompt` helpers. Esc at any step,
  including the trailing category step, cancels the whole wizard.
- Unit tests in `tests/unit/config-loader.test.ts` covering index 4-5 preservation,
  invalid mode rejection, add shape, sentinel round-trip, and serialize/reparse.



### feat(build): `npm run build:native` single-file executable

Adds a second distribution channel alongside the existing one. `npm run build`
is unchanged — `tsc` to `dist/*.js`, run as `node dist/server.js` with
`node_modules` beside it, which is what the Dockerfile ships. `npm run
build:native` (`scripts/build-sea.js`) instead produces one self-contained
binary in `dist/`, named per platform/arch (`model-proxy-v3-macos-arm64`,
`model-proxy-v3-linux-x64`, `model-proxy-v3-win.exe`, …).

The pipeline is Node's built-in SEA (Single Executable Application): esbuild
bundles `src/server.ts` and its whole dependency graph into one CJS file,
`--experimental-sea-config` turns that into a blob, the host `node` binary is
copied, and `postject` injects the blob into the copy. On macOS the copy is
re-signed, since injecting a section invalidates the existing signature. A
`tsc --noEmit` preflight runs first — esbuild strips types without checking
them, so without it a native build could ship code `npm run build` would
reject.

**Cross-compilation is not possible.** The output *is* a copy of the Node that
built it, so each target platform needs its own build host (CI matrix, VM, or
container). This is inherent to SEA, not a limitation of the script.

**The build Node must be official and self-contained** (nodejs.org, nvm,
`actions/setup-node`). Homebrew and some distro packages ship `node` as a small
launcher against a shared `libnode`; the SEA sentinel fuse lives in the library
rather than the launcher, so injection fails. Check by size — a real one is
~110MB, the stub ~50KB. The script reads the fuse out of the binary at build
time rather than assuming `postject`'s default, because its spelling
(`NODE_SEA_FUSE_` vs `POSTJECT_SENTINEL_`) and hash change between Node
releases; it fails with that diagnostic when no fuse is found.

Not in the binary, both matching the Docker image and both failing loud rather
than silently:

- **System keychain** (`@github/keytar`) — a native `.node` addon, which SEA
  has no mechanism to embed. `store_key_in_system = true` raises the existing
  `KeyStoreError`, as it already does in Docker (`--omit=optional`).
- **`sdk://` routes** (the `chatjimmy` submodule) — loaded through a
  deliberately non-literal relative specifier so it stays optional at build
  time. That specifier is relative to the *source file*, and a SEA binary has
  no source tree, so it cannot resolve regardless of what sits next to the
  executable. The existing catch reports `ChatJimmy SDK not available`.

Two bundling details worth recording, both found by running the binary rather
than by reading the source:

- **`import.meta.url` had to be defined explicitly.** Bundling ESM to CJS
  leaves `import.meta` with no equivalent and esbuild emits `import_meta = {}`,
  making `import.meta.url` `undefined`. `@earendil-works/pi-tui` calls
  `createRequire(import.meta.url)` at *module scope*, so it threw
  `ERR_INVALID_ARG_VALUE` the moment that initializer ran — killing `TUI=1` and
  `AGENT=1` at startup while plain HTTP serving looked fine, because both
  import pi-tui lazily. A `--define` plus banner now supplies a real `file://`
  URL derived from `process.execPath`. pi-tui uses that `require` only to probe
  for an optional native addon inside a `try`/`catch`, and SEA cannot ship
  native addons anyway, so the probe now *misses* instead of *throwing*; TUI
  modifier-key detection is degraded in the binary, on every platform equally.
- **`npx` needs a shell on Windows.** There `npx` is `npx.cmd`, and
  `execFileSync` spawns executables directly — `CreateProcess` cannot run a
  batch script, and Node 20+ additionally refuses `.cmd` via `execFile` without
  a shell (CVE-2024-27980). `shell` is now set on win32 only, so POSIX gains no
  extra quoting layer.

Installing for a native build must **not** use `--omit=optional`, unlike the
Dockerfile: esbuild ships its platform binary (`@esbuild/darwin-arm64`,
`@esbuild/linux-x64`, …) as an optional dependency, and omitting it leaves
esbuild unable to run.

Verified on macOS arm64 only: builds, runs from a directory containing just the
binary and a `proxy_config.toml` (no `node_modules`, no source tree), serves
`/dashboard` and `/v1/models`, and starts under both `TUI=1` and `AGENT=1`.
Linux and Windows are expected to work — the script branches correctly for
them and nothing in `src/` is platform-specific — but have not been run.
`proxy_config.toml` is still read from the working directory at runtime
(`PROXY_CONFIG_PATH`); it is not embedded.

### fix(agent): close three path/log confinement holes and two bash edge cases

Follow-up review of `src/agent-session.ts` / `src/agent-tools.ts`. Each item below
was reproduced against the running tools before being fixed, and has a regression
test in `tests/unit/agent-tools.test.ts`.

Security:

- **Symlink bypass of write confinement** — `isPathAllowed` compared only the
  *lexical* (`path.resolve`) form of a target, so a symlink inside the working
  directory pointing outside it passed the check and the write followed the link,
  reporting success on an in-scope path while clobbering a file outside both
  allowed roots. The agent could plant that symlink itself (`ln -s` is on no
  denylist), making it a self-contained bypass. Both the lexical and the
  symlink-resolved form are now required to be in scope, so a link can only ever
  narrow what is reachable, never widen it. Resolution walks up to the deepest
  *existing* ancestor (`realpath` fails on a not-yet-created file, the normal
  `write_file` case), which also catches a symlinked parent directory.
- **`read_file` had no path check at all** — unlike `write_file` it never called
  `isPathAllowed`, so the agent could read anything the operator's account could
  (`~/.ssh/id_rsa`, `~/.aws/credentials`, `proxy_config.toml`'s
  `default_api_key`). Because the session's provider is the proxy itself,
  anything read was sent upstream as conversation context. Now confined to the
  same roots as writes.
- **Trajectory log was symlink-attackable** — `TRAJ=1` appended to a fixed
  `<os.tmpdir()>/agent_trajectory.log`, re-resolving the path on every write. On
  Linux `os.tmpdir()` is normally the shared world-writable `/tmp`, where any
  local user could pre-create that name as a symlink and capture the whole
  transcript (task text, file contents in tool results) while clobbering a file
  of their choosing; the log was also mode `0644`. The name now carries a
  per-session random suffix and is opened **once** with
  `O_EXCL|O_NOFOLLOW|O_APPEND` at mode `0600`, held for the session.

Correctness:

- **Compound commands hid a second `rm`/`mv`** — the extraction regex matched
  only the first `rm`/`mv` in the whole command string, folding everything after
  it (including an independent second invocation) into that first match's
  argument list instead of checking it. Each `&&`/`||`/`;`/`|`-separated segment
  is now checked on its own.
- **Any signal exit was reported as a timeout** — `execFile`'s `error.killed` /
  `error.signal` are set whenever a process ends via a signal, whether Node's
  `timeout` fired, the child killed itself, or something external killed it (OOM
  killer, manual `SIGKILL`). A command killed after two seconds was reported as
  "timed out after 60s". A dedicated timer now tracks whether *our* timeout
  actually fired; other signal exits report the signal instead.

The `⚠️ No OS-level sandbox` caveat is unchanged and still applies: `bash` runs
with the operator's full privileges, and the command denylist remains raw
string/regex matching, evadable by obfuscation. These fixes close gaps in the
path confinement the code already claimed to enforce; they do not add a sandbox.

### feat(agent): interactive `AGENT=true` coding session backed by the proxy itself

A new `AGENT=true`/`1` mode (`src/agent-session.ts`, mirroring the existing
`TUI=true` convention in `server.ts`) runs an interactive
[`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
session whose LLM provider is the proxy's own loopback `/v1/messages` — so an
agent task exercises the same routing, composite aliases, quota accounting and
privacy filtering as any other client.

Flow: pick a working directory → pick a model → verify with a "hi" round-trip →
set a budget → state a task → run → summarize file changes → prompt for a
follow-up task against the same agent and budget.

- **Tools** (`src/agent-tools.ts`): `read_file`, `write_file`, `bash`, plus
  `find_skill`/`add_skill` when the `skills` CLI is available (probed once at
  startup — tools that would always fail are not exposed at all). Skills are
  loaded from both the project-scoped `.pi/skills` and a global dir.
- **Budget**: prompt accepts tokens (`1m`, `50k`) or turns (`20`), prefilled with
  `5m`. Submitting the prefill unchanged and submitting blank both apply the same
  combined 5,000,000-token / 100-turn default; an explicitly typed value sets
  exactly one limit. Turns is sized as a runaway-loop backstop, not the binding
  limit — at a realistic ~30k tokens/turn the token budget trips first. Note
  pi-agent-core itself imposes **no** turn limit — its `runLoop()` is an
  unbounded `while(true)` — so this budget is the only stop condition besides
  explicit exit. `/q`, `/quit`, `/exit` and ctrl+c end the session at either the
  budget or the task prompt.
- **Model picker** lists composite aliases first and target models last, each
  labelled by kind. Ordering is local to the picker; the shared
  `getConfiguredModelIds` (and therefore `GET /v1/models`) is unchanged.
- **`TRAJ=1`** tees the session's console output to `agent_trajectory-<id>.log`
  under the OS temp dir, ANSI stripped and blank lines dropped. Restored on every
  exit path, including early returns. (Path and open flags hardened later — see
  the `fix(agent)` entry above.)
- **Log verbosity**: for the session's duration `LOG_LEVEL` is raised to `warn`
  so per-request proxy chatter doesn't fight the agent's streamed reply;
  restored on exit. Tool call/result lines are truncated to 120 chars.

**No OS-level sandbox.** `bash` and `write_file` run with the operator's full
privileges; pi-agent-core provides no confinement. Reads, writes, deletes and
moves are confined to the working directory plus the real OS temp tree (reads and
symlink resolution were added later — see the `fix(agent)` entry above), and
`bash` blocks a small denylist of destructive patterns (`rm -rf`, `kill -9`,
force push, `chmod -R 777`, `curl|sh`) — but the command denylist is raw
string/regex matching, not a shell parser, and is evadable by obfuscation. It
guards against an agent mistake, not an adversary. A startup warning states this
explicitly.

### refactor(logs): shorten per-request log lines and request ids

Request-line logging was verbose enough to be hard to scan, especially
interleaved with an agent session's own output:

- `src/index.ts` composite-attempt line is now comma-separated, dropping the
  `for`/`to` filler and the trailing upstream mode:
  `/v1/messages,forclaw,https://openrouter.ai/api/v1/chat/completions`
- `src/handlers/messages.ts` upstream line drops the user-agent prefix,
  `upstream (stream=…)` and `thinking (…)` in favour of a flag list, with the
  user-agent moved to the end:
  `minimax/minimax-m3:free,(s,t) [openai-completions] <ua>`, where `s` means
  streaming and `t` means thinking is *enabled* (a `{type: "disabled"}` block
  counts as off, matching the existing `thinkingType` check).
- `shortRequestId` (`src/utils/logger.ts`) now displays the last 8 digits of the
  timestamp and 6 chars of the UUID: `req_1783840535295_2a042b05-…-5266bdbac7f1`
  → `req_40535295_5266bd`. Two deliberate losses: the truncated timestamp
  discards multiples of 1e8 ms so it repeats every **~27.8 hours** (recoverable
  as `prefix * 1e8 + shown`, but not a full date), and the 6-char fragment is 24
  bits, so ids sharing a displayed millisecond collide far more readily than
  before. Both are fine for reading a log by eye; neither is a unique key. The
  full id is unchanged everywhere outside log display, including upstream
  correlation. Non-matching ids (e.g. the literal `config`) pass through
  untouched.

When `AGENT=true`, the shared logger also dims every remaining line to dark gray
and drops startup-only `config` diagnostics outright. Non-AGENT modes
(`server.ts`, `tui.ts`) are unaffected.

### fix(quota): record upstream rate-limit usage from every endpoint, not just `/v1/messages`

`recordUpstreamRateLimit` (which populates the passively-recorded
`anthropic-ratelimit-unified-5h-utilization` value, both per-model and
per-upstream-host) was only wired into the native `/v1/messages` handler
(`claude.ts`). Requests reaching the same upstream through any other
endpoint/format — `/v1/chat/completions`, `/v1/messages` (compat path),
`/v1/responses` (all sub-routes: anthropic-messages, completions,
input_tokens, compact, passthrough), and the OpenAI-format handlers —
never recorded quota, even though quota is a property of the upstream host,
not the endpoint used to reach it. `recordUpstreamRateLimit` is now called
after every upstream `fetch()` in `chat-completions.ts`, `messages.ts`,
`openai.ts`, `responses.ts` (7 call sites), and `gemini.ts` (3 call sites,
no-ops today since Gemini doesn't send this header, but wired for
consistency and any future Anthropic-compatible bridging).

`getModelQuota` (the active-polling path used for Kimi/DeepSeek/MiniMax/
OpenRouter/Zhipu usage) needed no equivalent change: all 4 call sites
(`tui.ts` quota picker, `tui.ts` composite overlay refresh, and both
`dashboard.ts` `/dashboard/api/quota` variants) already resolve routes via
`getModelRouteConfig`/`getConfiguredModelIds`/`modelChoices`, which key
purely off each model's config entry (`target`, `base_url`, `api_key`) —
never off which proxy endpoint serves it. It was never endpoint-scoped, so
there was nothing to fix.

### fix(stats): record tokens for native Gemini streams, force `include_usage` on streaming chat/completions passthrough, map Gemini cached tokens

Three usage-statistics gaps closed (column semantics per endpoint are now
documented in a new README table under "Token usage statistics columns"):

- **Native Gemini streaming recorded zero tokens.** `:streamGenerateContent?alt=sse`
  chunks carry `usageMetadata`, but the SSE usage tracker only looked for
  OpenAI-shaped `data.usage`. The no-event branch now also parses
  `usageMetadata` (`promptTokenCount` / `candidatesTokenCount` /
  `totalTokenCount` / `cachedContentTokenCount`), final-chunk running totals
  winning.
- **Gemini `cachedContentTokenCount` was dropped everywhere except the
  streaming Gemini→Claude converter.** It is now mapped to `cached_tokens` in
  the JSON usage extractor (`extractUsageFromResponsePayload`), the
  non-streaming Gemini→Claude conversion (`cache_read_input_tokens`), and the
  `/v1/interactions` non-streaming handler (`total_cached_tokens`, which the
  streaming converter already consumed). Note Gemini's `promptTokenCount`
  includes the cached portion, same semantics as OpenAI `prompt_tokens`.
- **Streaming `/v1/chat/completions` native passthrough didn't force
  `stream_options.include_usage`.** OpenAI only emits the usage-bearing final
  chunk when the client sets it; the proxy now forces `include_usage: true` on
  the forwarded body (mirroring the existing converted-route behavior in the
  messages handler / claude-to-openai converter). The extra chunk is
  spec-compliant and forwarded to the client unchanged.

Unit tests added for the `cachedContentTokenCount` JSON mapping and native
Gemini SSE capture (tests/unit/token-usage.test.ts).

### feat(tui): live-refresh the 'Model Quota' picker while open

The Model Quota picker built its quota entries once when opened, so rows kept
showing the values from open time — e.g. a stale `Quota: 100% 5h left` — even
though every upstream response updates the passively recorded
`anthropic-ratelimit-unified-5h-utilization` value (recorded per request in the
anthropic-messages handler; verified against a live Anthropic-compatible upstream,
which forwards
the header on every response). The picker now keeps its live state
(`quotaPickerState`) and is rebuilt from the 500ms refresh loop
(`refreshQuotaPicker`, same pattern as the composite overlay's quota refresh):
row suffixes and the highlighted row's `Quota:` status line update as new
upstream responses arrive while the overlay is open. Provider quota fetches
stay bounded by `getModelQuota`'s 30s cache; the anthropic-5h fallback is a
plain in-memory map read.

### fix(build): keytar dependency now installs prebuilt; Docker skips it; dead config removed

The `@github/keytar` optionalDependency is now pinned as
`github:github/node-keytar#v7.10.6` instead of `file:submodules/node-keytar`, and
the root `postinstall` (git submodule + forced `npx node-gyp rebuild`) is gone:
`npm install` fetches the addon from GitHub and its install script downloads a
prebuilt NAPI binary (ABI 3) — no compiler or Python needed; node-gyp compiles
from source only as the fallback when the prebuilt download fails. The
`submodules/node-keytar` submodule is kept as a local source copy for development
but is no longer used by `npm install`.

The Dockerfile now installs with `--omit=optional --ignore-scripts`, excluding
the keytar addon (no OS keychain in the image; `store_key_in_system` keeps
failing loud there) — previously the root postinstall's `git submodule` call
would have broken the image build.

Also removed the dead `allowScripts` / `lavamoat.allowScripts` blocks from
`package.json` (they referenced `@lavamoat/allow-scripts`, which is not a
dependency). README and `docs/configuration-reference.md` updated to describe
the prebuilt-first install, per-platform system/toolchain requirements (runtime
keychain backend per OS; build toolchain only for the source-build fallback),
and the headless-Linux keyring caveat.

### fix(tui): quota picker falls back to shared host-level usage when a model alias has no recording

Models sharing the same `(target_url, api_key)` (e.g. `codelite`, `codesmall`,
`codestrong` all routed through the same upstream) share one quota pool, but
the TUI's "usage left" was keyed only by model alias (`getUpstreamRateLimitLeft`),
so aliases that hadn't been used recently showed no quota even though a
sibling model on the same credential had a fresh recording. The dashboard's
per-base-URL column already aggregated this correctly via
`getUpstreamRateLimitLeftForUrl`.

The TUI's quota picker (`buildQuotaData`) and composite quota refresh
(`refreshCompositeQuota`) now fall back to `getUpstreamRateLimitLeftForUrl(route.targetUrl)`
when the model-keyed recording is missing, matching the dashboard's behavior.

### feat(transforms): `restore_client_model_alias` builtin to echo the requested alias back in responses

The proxy rewrites the request body's `model` field from the client's alias to
the real upstream model id before forwarding (`index.ts` composite/coordinator/
fusion/default routing), but the response `model` field was pure passthrough —
clients saw the real upstream model id, not the alias they requested, leaking
routing internals and breaking any client-side `response.model === request.model`
checks.

Added an opt-in `response_egress` builtin, `restore_client_model_alias`, that
rewrites the response body's `model` field (JSON, and each `chat.completion.chunk`
SSE event) back to the client-requested alias. Enable it per-route via the
existing transform config mechanism:

```toml
[transforms.restore_alias]
schema = "openai-completions"
response_egress.builtins = ["restore_client_model_alias"]

[models.my-fast-model]
target = "claude-haiku-4-5-20251001"
transforms = "restore_alias"
```

Routes that don't list it keep today's passthrough behavior — this is the
config "toggle." Implementation notes:

- `RouteAttempt` gained a `clientModel?: string` field, set at every attempt
  construction site (composite candidates, `buildRouteAttempt` for
  coordinator/fusion sub-targets, and the default single-route path via a new
  `clientRequestedModel` outer variable) — carries the true pre-alias name
  since the existing `modelId` field gets overwritten with the resolved
  upstream model id.
- Fixed a latent bug: `HookContext.clientModel` at the `response_egress` hook
  was wired to the resolved upstream model id (`attemptModelId`), not the
  client's original alias, inconsistent with `request_ingress`'s correct
  `parsedBody.model`-based wiring. Builtins now receive `clientModel` via the
  `trace` param threaded through `applyTransformSet`/`applyBuiltin`.

### fix(quota): usage-left lookup keyed by upstream model name, not config key

The anthropic 5h utilization header (`anthropic-ratelimit-unified-5h-utilization`)
IS returned by anthropic-compatible upstreams (verified against a local pi proxy)
and recorded by the claude handler — but under the upstream model name
(`route.modelAlias`, e.g. `codelite` → `code-lite-pi`), while every model-keyed
display looked up the config key (`codelite`). Result: aliased models on hosts
without a usage-provider API (pi proxies, etc.) never showed usage-left, while
provider-hosted models (zhipu/minimax/deepseek/…) worked because the active
quota fetch is host-keyed. Fixed on the display side (recording stays keyed by
the upstream name, consistent with the stats tables):

- TUI quota picker (`buildQuotaData`) and composite-alias overlay
  (`refreshCompositeQuota`) now look up `route.modelAlias || modelId`.
- `GET /dashboard/api/quota?model=<id>` now falls back to the recorded header
  value when the route host has no usage provider, mirroring the existing
  `base_url=` variant (returns `provider:"anthropic-5h", source:"response-header"`).

The `base_url=` variant (dashboard upstreams table) was already correct; its
value is in-memory only — present after ≥1 successful proxied response since
process start.

### docs: `store_key_in_system` addon install & recovery instructions

README ("Configuration Reference") and `docs/configuration-reference.md` now document
how to install the `@github/keytar` addon and how to recover from the startup error
`Cannot find package '@github/keytar'`. Two facts established while verifying the
instructions (fresh-clone repro, npm 11 / Node 24 / macOS):

- The parent `npm install` builds the native binding automatically — the submodule's
  install script falls through to `node-gyp rebuild` — so the earlier note's manual
  `cd submodules/node-keytar && npm install && npm run build` is only needed when the
  node-gyp toolchain is missing or the automatic build fails.
- Root cause of the error seen on the dev host: a prune-style npm run
  (`npm install --dry-run --omit=dev` / `--production`) stripped the
  `optionalDependencies` block from `package.json` (and the untracked
  `package-lock.json`), after which no later `npm install` ever re-links the addon —
  npm only installs what `package.json` still declares. Durable fix:
  `git checkout -- package.json && npm install`. Band-aid without the submodule:
  `npm i @github/keytar --no-save` (registry copy with a prebuilt binary; `--no-save`
  keeps the `file:submodules/node-keytar` pin).

### feat(config): `store_key_in_system` — store api_keys in the OS keychain

New `[general] store_key_in_system = true` flag. On config load (Node server,
file-based `PROXY_CONFIG_PATH` only), every plaintext `api_key` in `[models.*]`
(section-level, per-entry, and `[default_upstream].default_api_key`) is stored
into the OS keychain via the vendored `@github/keytar` native addon
(`submodules/node-keytar`) under service `model_proxy_v3` with account
`<target_model_id>/<base_url>`. The config file is then rewritten in place —
backup at `<config>.bak` — with those keys replaced by the literal
`STORE_KEY_IN_SYSTEM` sentinel (targeted text replacement; comments and layout
preserved). On every later load, sentinels are resolved back to real keys from
the keychain into the in-memory config, so routing and the dashboard are
unchanged (`api_key` stays non-editable there, preventing re-leaks).

Scope limits: the feature is skipped entirely for Consul/Apollo config-center
sources (flag ignored with a warning; a sentinel reaching such a config is a
fatal load error, since it could never be resolved and would leak upstream as
a literal key). Composite/schedule aliases carry no api_key of their own and
are not touched. Caller/user keys from request headers (auth passthrough via
empty api_key) are never stored.

Sentinel resolution is exact-account first; on miss it falls back to a
best-effort match over all keychain accounts under `model_proxy_v3`, scored
by base_url similarity (prefix relation; base_url dominates, target-name
similarity tiebreaks) — e.g. a wanted `glm-5.3-anth/https://…/api/anthropic`
resolves from a stored `glm-5.3/https://…/api`. Every fallback use logs a
warning; no similar account at all is still a fatal load error.

TUI additions: a 🔒 marker is shown on the "Proxy TUI" header line (before
the version) when every configured api_key in the local config file is a
`STORE_KEY_IN_SYSTEM` sentinel, and a new hotkey `K(k)` opens a "System
Keychain Keys" overlay
listing the stored `<target_model_id>/<base_url>` accounts (passwords are
never displayed). The hotkey is introduced in the help panel only — it is not
added to the footer hotkey line; 🔒 is also documented in the help markers
section. The web dashboard header shows the same 🔒 beside "Proxy Dashboard"
when `api_keys_in_system_store` is set (updated live on each config load).

Fail-loud semantics: if the flag is set but the keychain/native addon is
unavailable (Docker, Cloudflare Workers, headless Linux without libsecret), or
a sentinel has no keychain entry, startup aborts instead of degrading to an
empty config.

Notes:
- The addon must be built once inside the submodule:
  `cd submodules/node-keytar && npm install && npm run build` (a git checkout
  ships no prebuilds). After that the parent `npm install` symlinks
  `@github/keytar` to the submodule. (Verified later: when the node-gyp
  toolchain is present, the parent `npm install` runs that build automatically —
  see the docs entry above; the manual build is the fallback.)
- `package.json` gained an `allowScripts` field (npm 11+ install-script
  allowlist) covering the keytar install script.

### feat(quota): read model usage/credits left for coding-plan providers

New `src/utils/provider-quota.ts` fetches the remaining usage / balance for a
model's route when its upstream is one of the supported coding-plan providers
(endpoints + response schemas ported from the dsh musage plugin):

| Provider | Route host(s) | Usage endpoint | Result |
|---|---|---|---|
| minimax | `api.minimaxi.com` / `api.minimax.io` | `/v1/api/openplatform/coding_plan/remains` | 5h + 7d used% (dual schema: percent-based + legacy count) |
| deepseek | `api.deepseek.com` | `/user/balance` | balance (CNY/USD) |
| kimi | `api.kimi.com` | `/coding/v1/usages` | 5h + 7d used% |
| openrouter | `openrouter.ai` | `/api/v1/credits` | remaining USD credits |
| zhipu | `open.bigmodel.cn` | `/api/monitor/usage/quota/limit` | 5h + 7d used% |

The provider is detected from the model route's `targetUrl` host — no extra
config. Zhipu is special: its `Authorization` header takes the raw key (no
`Bearer ` prefix). Results are cached per `(provider, apiKey)` for 30s on
success, with exponential backoff (5s → 30min) on failure.

Anthropic-routed models have no usage endpoint, but Anthropic-compatible
upstreams report the account-wide 5h-window used fraction (0-1) in the
`anthropic-ratelimit-unified-5h-utilization` response header. The
`anthropic-messages` passthrough now records this per model on
real traffic (no polling — a value appears only after the first proxied
request to that model) and derives a usage-left percent
(`(1 - utilization)` clamped at 0%) as a fallback when the route has no usage
provider.

Surfaces:

- **TUI**: new `Q` hotkey opens a model picker; every row carries a usage
  suffix — `(58%)` (percent schema), `(7472/20000, 63%)` (remaining/limit +
  used% for count schemas), `(¥43.97)`/`($6.50)` (balance), or `(58%)` from
  the recorded anthropic 5h header — and moving ↑/↓ shows the highlighted
  model's full quota (windows + reset time) on a status line at the bottom of
  the panel; anthropic-routed models show the recorded 5h utilization left,
  e.g. `58% 5h left`.
- **TUI composite panel**: in 'Edit Composite Aliases Config', each target
  row appends its usage-left after the timing suffix, e.g.
  `[0.11/2.12/63.93s] (58% left)` — percent (minimax percent schema /
  anthropic 5h header), count as `remaining/limit, used%` e.g.
  `6930/12000, 42%` (kimi/zhipu/minimax count schema), or balance
  (deepseek/openrouter), refreshed with each config
  refresh (the 30s provider cache bounds the load).
- **Dashboard API**: `GET /dashboard/api/quota?model=<id>` (dashboard
  `api_key` auth) returns the normalized JSON result — `200` on success,
  `404` for unconfigured/unsupported routes, `502` for provider errors.
  A `?base_url=<origin>` variant (matching the stats table's
  `upstream_base_url` values) reuses the first configured route's api key on
  that origin and falls back to the host-keyed anthropic 5h utilization;
  all success responses include a preformatted `left` string.
- **Web dashboard**: the 'Upstream Base URL' table (Request Statistic →
  Status Count) has a new "Usage Left" column — per-origin quota polled from
  the `base_url` quota endpoint (60s client cache on top of the 30s server
  cache; counts render as `6930/12000, 42%`); anthropic-compatible origins
  show the recorded 5h left percent.

### fix(transforms): `codestrong` 500s on Claude Code requests ending in a non-user turn

Claude Code routes through the `auditor` composite (`codesmall`/`codestrong`,
`codestrong` primary) to `codestrong`/`codesmall` → `code-strong-pi`/
`code-small-pi`, `anthropic-messages`-mode upstreams. Failing requests had a
`messages` array that did not end on `role: "user"`, and the proxy forwarded
that array to upstream unchanged. The upstream rejects any non-`user`-terminated
`messages` array with the same generic 400, regardless of which role is
actually trailing:

```
[ERROR] Upstream error response (500): {"type":"error","error":{"type":"api_error",
"message":"400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",
\"message\":\"This model does not support assistant message prefill. The
conversation must end with a user message.\"} ..."}}
[WARN] Composite primary auditor.codestrong returned 500
```

The 400 is wrapped as a 500 by the auditor composite's failover logging, but
the underlying condition is a request-shape mismatch, not an upstream outage
— retrying or failing over doesn't fix it, since the same bad `messages` tail
gets replayed to the fallback too.

**Confirmed root cause** (via full `LOG_LEVEL=trace` capture with an adequate
truncation cap — see below): the error text is misleading. The actual
trigger for the reproducing traffic was **not** real assistant-prefill at
all — it was a trailing `role: "system"` message inside `messages`:

```json
{
  "model": "code-strong-pi",
  "messages": [
    { "role": "user", "content": [{ "type": "text", "text": "hi" }] },
    { "role": "system", "content": "Available agent types for the Agent tool:\n- claude: ...\n- Explore: ...\n..." }
  ]
}
```

Claude Code emits this `role: "system"` message inline in `messages` (an
agent-definitions block for the `Agent` tool), in addition to the normal
top-level `system` field — confirmed present already at the `request_ingress`
stage, i.e. sent by the client as-is, not introduced by any proxy conversion
step. Real Anthropic tolerates a `role: "system"` entry inside `messages`;
this upstream does not, and reports the rejection using the same
"assistant message prefill" error text it uses for a genuinely-trailing
`role: "assistant"` message — the two failure modes are indistinguishable
from the error string alone.

Diagnosing this required two visibility fixes along the way, both now
permanent: (1) `LOG_LEVEL` must be `trace` to get full pipeline body/header
logs via `logPipelineStage` (the default `info` level and the always-on
500-char `claude.ts` debug preview are both insufficient to see the tail of a
large `messages` array); (2) `logPipelineStage`'s truncation cap
(`src/utils/logger.ts`) was raised from 128000 to 2,000,000 bytes — the
128000 cap was itself hiding the real tail of `messages` for
request bodies over ~128KB, which is why earlier `LOG_LEVEL=trace` captures
still didn't show the actual failing shape.

Fixed at the routing edge instead of patching a third-party dependency
in-place: a new Tier-2 `before_upstream` builtin,
`ensure_trailing_user_message`. **Revised three times** during testing
against the live upstream, the first two revisions built on the (incorrect)
assumption that a trailing `role: "assistant"` message was the only cause:
- First cut appended a synthetic `{role: "user", content: [...text:
  "Continue."]}` turn — still hit the same 400.
- Second cut folded the trailing assistant text into the preceding user
  message under a `[Previous assistant context]` prefix and dropped the
  assistant message — also still 400'd against the real upstream.
- Third cut stripped the trailing assistant message outright (no fold, no
  append) — still 400'd, because the actual reproducing traffic's trailing
  message was `role: "system"`, not `role: "assistant"`, so the builtin's
  `last.role === 'assistant'` check never matched and the builtin never ran.
- **Current (confirmed) behavior**: generalized to pop *any* trailing
  non-`user` message, looping until `messages` ends on `role: "user"` (or is
  empty) — covers both a trailing `role: "assistant"` (real prefill) and a
  trailing `role: "system"` (this incident), plus any other stacked
  combination. One `LOG_LEVEL=trace` line is emitted per stripped message
  (`[ensure_trailing_user_message] stripped trailing <role> message: ...`),
  recording exactly what was removed.

**Verified fixed** against live Claude Code v2.1.239 traffic through the
`auditor` composite (`codestrong`/`codesmall` → `code-strong-pi`/
`code-small-pi`) after rebuilding and restarting the proxy — the 500s no
longer occur.

No-op when `messages` is empty/absent or already ends with `role: "user"`.
Schema-gated to `anthropic-messages` (`BUILTIN_SCHEMA` in
`config-loader.ts`) since this shape constraint doesn't apply to
`openai-completions` bodies.

Applied to the `codestrong` and `codesmall` routes via a new
`[transforms.claude_anthropic_compat]` set (`proxy_config.toml`) — no other
route or model is affected. A transform-based fix was chosen over
patching the `@earendil-works/pi-ai` dependency in `node_modules` because it:
survives `npm install`/dependency version bumps untouched, stays scoped to
the one broken route via config rather than a global capability check, and
needs no upstream fix or `patch-package` machinery to take effect.

Tests: `tests/unit/request-transform.test.ts` (strip trailing assistant for
string and array content, strip trailing system message, strip multiple
stacked trailing non-user messages, strip-with-no-preceding-message, trace
log emitted per stripped message, no trace log when nothing stripped, no-op
on empty/absent/already-user-terminated messages),
`tests/unit/config-loader.test.ts` (schema-gate accept/reject for the new
builtin). See `docs/transforms-reference.md` for the builtin reference entry.

### feat(chat-completions): streaming usage chunk for anthropic-messages cross-mode

The anthropic-messages SSE converter (`src/handlers/chat-completions.ts`) dropped
usage entirely when translating Claude streams to OpenAI `chat.completion.chunk`
SSE — `/v1/chat/completions` streams via e.g. `glm-5.3-anth` ended with
`finish_reason` + `[DONE]` and no token counts, while the non-streaming response
included usage.

Per the OpenAI Chat Completions spec, a usage chunk is now emitted when the
client sends `stream_options: {"include_usage": true}`: an extra final chunk
with an empty `choices` array (`prompt_tokens`/`completion_tokens`/
`total_tokens`) just before `[DONE]`. Without `stream_options`, the stream is
unchanged (no usage).

Token capture: `input_tokens` from `message_start`, with `message_delta`'s
cumulative counts taking precedence when non-zero (GLM's anthropic endpoint
reports `input_tokens: 0` in `message_start` and the real counts only in
`message_delta`); `output_tokens` from `message_delta`.

Note: this is the canonical OpenAI shape. The openai-completions passthrough
path (e.g. `glm-5.3-comp`) is untouched — bigmodel attaches usage to the final
chunk regardless of `stream_options`, which remains a passthrough deviation.

Tests: `tests/unit/chat-completions-anthropic-streaming.test.ts` (both gating
and token mapping).

### fix(config): 5/6-element model entries rejected by `validateProxyConfig` and dashboard PUT

The per-entry `transforms` (index 4) and `max_tokens` (index 5) fields were
supported by the TOML parser, serializer, and route resolution, but two other
validation sites still only accepted lengths 1/3/4 — so any config that used
them failed:

- `validateProxyConfig` (`src/utils/config-loader.ts`) rejected model entries
  longer than 4 elements with
  `must be [target] or [target, base_url, api_key] or [target, base_url, api_key, mode] (got 6 elements)`
  at proxy startup / dashboard load, despite the config being valid. The 5- and
  6-element forms now validate (`max_tokens` at index 5 must be a number or
  digit string, mirroring the parser's `/^\d+$/` check).
- `isSafeModelArray` (dashboard PUT path, `validateAndNormalizeDashboardModels`)
  rejected 5/6-element arrays with `400 Invalid model entry`, so saving a
  config containing `transforms`/`max_tokens` via the dashboard/TUI or raw
  `PUT /dashboard/api/config` failed. Now accepts lengths 1/3/4/5/6. The PUT
  path still trims entries to the dashboard's 3-tuple display shape
  `[target, base_url, mode]` (mirroring `sanitizeDashboardCategoryConfig` on
  GET) — `transforms`/`max_tokens` remain config-file-only fields; a raw PUT
  including them is silently truncated (documented in code comments).

Root cause: parser, serializer, and validator each evolved and were unit-tested
independently, so their shared accepted-shapes contract drifted. Regression
guards added at three layers:

- Unit (`tests/unit/config-loader.test.ts`): 6-element entries accepted with
  number and digit-string `max_tokens`, rejected with non-numeric.
- Integration boot test (`testcases/08_regression` TC817): PUTs a category
  using all 6 documented array lengths at once, asserts zero `config_errors`.
  This test independently rediscovered the `isSafeModelArray` drift above.
- Integration behavior test (`testcases/15_config_parse` TC1519): a 6-element
  entry's `max_tokens` survives parse → `getModelRouteConfig().maxTokens`
  (the shape consumed by request building), not just the raw array shape.

`tests/README.md` gained a warning documenting this bug class (test
cross-function contracts, not each function in isolation).

### fix(tui): terminal-title activity dot no longer flickers

Identical `OSC 0` title writes are now skipped (dedupe cache in
`updateTerminalTitle`), so the once-per-second `·`/`.` activity alternation
only writes when the title actually changes. Note: the dot requires a terminal
that repaints its title on every OSC 0 write (iTerm2, Terminal.app); Warp
intercepts title sequences and may not show it — the in-TUI header `●`
indicator is unaffected.

### feat(responses): `conversation` param, retrieval endpoints, `store:false` honored; CONVERSATION → CONVERSATION_STATE

The stateful mode for `POST /v1/responses` with `openai-completions` upstream
(env renamed `CONVERSATION` → `CONVERSATION_STATE`, same `true`/`1` gating)
now covers the full stateful Responses API surface:

- **`conversation`** (string or `{"id": ...}`): the conversation thread's
  accumulated items are prepended to the request's `input`; this turn's new
  input items and output items are appended to the thread afterwards. The
  conversation ID is echoed in the response body. Combining
  `previous_response_id` and `conversation` in one request is rejected with
  `400` (spec forbids the combination) — previously `conversation` was
  silently ignored.
- **Retrieval**: `GET /v1/responses/{id}` returns the stored response object
  and `GET /v1/responses/{id}/input_items` returns the merged input items,
  both served from the in-process store (no upstream call, auth checks apply,
  only intercepted while `CONVERSATION_STATE` is enabled). Unknown, expired,
  or unstored IDs return `404`.
- **`store: false`**: such responses are no longer saved — they cannot be
  continued via `previous_response_id`/`conversation` nor retrieved.
- Both streaming and non-streaming responses now store the serialized
  response object for retrieval; conversation threads share the same TTL
  (3600s) and `CONVERSATION_MAX_ENTRIES` cap as response entries.

Docs: `docs/README_DETAILS.md` Known Limitations #4 rewritten for the new
behavior; `docs/configuration-reference.md` env table updated.

### feat(routing): effective-share recovery on success for primary and fallback targets

A successful request through a composite alias's primary or fallback target
now doubles its effective share back toward the configured value
(`recoverEffectiveCompositeShare`, `src/index.ts`), symmetric with the
halving-on-failure decay. Previously a decayed target (e.g. after transient
upstream errors) stayed decayed until process restart; recovery is gradual so
a flapping target does not ping-pong back to full traffic on one success.
Recovery logs when the share actually increases.

### refactor(transforms): thinking-strip on fresh conversations is now an opt-in builtin

The unconditional drop of `thinking: {type: "enabled"}` when the conversation
has no prior assistant thinking blocks (a DeepSeek Anthropic-compat workaround,
`400 "The content[].thinking in the thinking mode must be passed back to the
API"`) moved from `src/handlers/claude.ts` into a new Tier-2 builtin,
`strip_fresh_thinking` (`src/utils/request-transform.ts`), schema-gated to
`anthropic-messages`. Attach it via a transform set
(`deepseek_v4_anthropic_compat` now includes it) — spec-compliant Anthropic
upstreams no longer have client thinking intent silently dropped. The
unset-`thinking` → `{type: "disabled"}` injection remains unconditional.
`proxy_config.toml`'s `deepseek-v4-anth` entry now attaches the compat set.

### feat(config): per-entry `max_tokens` (fill + cap, all upstream modes); strict passthrough when unset

Model entries accept an optional `max_tokens` field (inline-table
`{target = "...", max_tokens = 8192}`, or positional-array index 5). It is a
bare number, not a quoted string.

- **Fill** (`anthropic-messages` routes, where the field is required): when the
  request omits `max_tokens`, the proxy fills this value
  (`src/handlers/claude.ts`).
- **Cap** (all upstream modes): applied centrally at the `before_upstream` hook
  in `runHook` (`src/utils/request-transform.ts`, after transforms run) — if the
  client or a transform sends a larger value, it is clamped down to the
  per-entry cap. Smaller client values pass through unchanged. The
  max-output-tokens field is resolved per upstream schema: `max_tokens`
  (`anthropic-messages`), `max_tokens`/`max_completion_tokens`
  (`openai-completions`), `max_output_tokens` (`openai-responses`),
  `generation_config.max_output_tokens`/`generationConfig.maxOutputTokens`
  (`gemini`).

**Unset → strict passthrough**: when the entry sets no `max_tokens`, the proxy
never sets, modifies, or caps the request's max-output-tokens field on any
endpoint. The `DEFAULT_MAX_TOKENS` env var (fill `8192` when omitted) was
removed as a consequence. The field round-trips through the dashboard config
save (parse → serialize → parse).

### feat(api): serve `/v1/chat/completions` by default; remove `DEV_PASS_THROUGH`

`POST /v1/chat/completions` (per-model routed passthrough) is now always
enabled — no `DEV_PASS_THROUGH=true` env var needed. The env var, its
`Env` type field, the startup warning, and docs references were removed;
`sse.sh` now expects streaming from this endpoint instead of the old
"not allowed" block.

Also fixed in the same path: models in `[models.free]` now use their
configured `api_key` for chat-completions passthrough (same rule as the
other routing paths) instead of forwarding the caller's key upstream.

### Docs: split README into focused reference docs

`README.md` shrank from ~1,634 to ~630 lines. Four new deep-dive docs
under `docs/` now hold the reference material, each linked from the
relevant README summary section:

- **`docs/api-endpoints.md`** — dynamic routing (moved from README),
  image input/output across format boundaries, OpenAI prompt-caching
  fields, and the Dashboard JSON API.
- **`docs/routing-and-aliases.md`** — `[models.*]` category lookup
  priority, `base_url`/`api_key` override + "who wins" tables,
  composite/fusion/coordinator aliases (incl. `toolset` recipes), token
  limits windowing, schedule aliases, and the routing-hierarchy
  level-by-level details.
- **`docs/auth-stats-protocol.md`** — wire-level contract for the
  remote auth and stats sidecars (requests, headers, OTAC linkage,
  dynamic routing override).
- **`docs/configuration-reference.md`** — all TOML sections
  (`[general]`, `[default_upstream]`, `[remote.*]`, `[transforms.*]`,
  `[privacy_filter]`) and environment variables, incl. sidecars.

The README keeps the endpoint table, the `upstream_mode` matrix, the
routing-hierarchy diagram + summary table, a new "Model Routing &
Aliases" summary, Deployment, and Testing. Cross-links were rewritten
to the new locations (including within the moved docs).

### Change: `@earendil-works/pi-tui` moved to devDependencies

The interactive TUI only runs in local/TTY sessions, not in the Docker
production image. `src/server.ts` now lazy-imports `src/tui.js`
(`await import`) only when `TUI` is enabled and stdin/stdout are TTYs,
so the server starts without `pi-tui` installed. This also resolves the
previous mismatch where the runtime image (`node:20-alpine`) was below
pi-tui's declared `node >= 22.19.0` requirement. Enabling `TUI` in a
container without devDependencies installed fails loudly at startup
(`ERR_MODULE_NOT_FOUND`).

### Fix: local privacy filter rejects word-underscore false positives

The base64url scanner in `src/utils/hash-detect.ts` (`detectB64Priority`)
treated any ≥20-char token with a digit and high entropy as a secret, so
descriptive identifiers such as `deepseek_v4_anthropic_compat` (length 28,
entropy 3.9, one `4`) were wrongly redacted to `⟦HASH:N⟧` sentinels. Added
two independent guards, each tuned with margin so real random keys are kept:

- **Max segment run ≥ 12**: the longest run between `_`/`-` separators must
  reach 12. Random keys have a long unbroken run (`ouV7bwSqBiabj9kei4_ZiIlcQW90nsx`
  → 18); word identifiers split into short dictionary segments (≤ 9).
- **Digit ratio ≥ 0.08**: random keys are digit-rich (≥ 0.16 in practice);
  word identifiers carry only an incidental digit (`v4` → ~0.04).

Pure-hex keys (`sk-6f1ea0…`, `6255cf92…`) are unaffected — they are caught
by the hex scanner, which still runs first.

### Fix: privacy filter dedups identical tokens across messages

`redactLocal` in `src/utils/privacy-filter.ts` minted a new `⟦HASH:N⟧`
sentinel for every detected span, so the same token (e.g. an API key
repeated across message turns) produced N distinct sentinels all mapping
to the identical value. Now one sentinel is reused per unique token
string, keeping the mapping minimal and the debug log accurate.

### TUI: help overlay, monthly heatmap view, hotkey updates

- **`h` hotkey**: opens a help overlay listing all hotkeys with short
  descriptions. Composite overlay keys (`a`, `m`, `f`, `e`, `l`, `d`) are
  also listed. Closes with `Esc` or `h`.
- **`Shift+u` hotkey**: toggle the token heatmap between the existing
  weekly view (weekday × hour) and a new monthly view (day-of-month 1–31).
  Both views build from the same usage stats data.
- **Hotkey consistency**: dashboard keys `C/S/T/D/P/L` now accept both
  lower and upper case; composite overlay keys `a/m/f/e/l/d` also accept
  both cases; bottom hotkey bar updated.

### Privacy filter: hash detection improvements

- **Require at least one digit** in base64url tokens (`detectB64Priority`).
  Real API keys almost always contain digits; this filters out descriptive
  identifiers like filenames while still catching real keys.
- **Default entropy threshold raised** from 3.0 to 3.5 across `detectHashPriority`,
  `detectB64Priority`, and `findHashSpans`, reducing false positives on
  descriptive identifiers.
- **Path-context exclusion** in `findHashSpans`: tokens preceded by `/` or `\`
  (path separator) or followed by a file extension (`.ext`, 1–5 chars) are
  now skipped as path components.

### Fix: privacy filter restore fallback gap

`restorePrivacyResponse` in `src/index.ts` only restored sentinels for
`text/event-stream` and `application/json` responses. Other content-types
(e.g. `text/plain`, empty content-type) fell through unrestored, leaking
`⟦HASH:n⟧` sentinels to the client. Added a text fallback that buffers and
restores any remaining content-type.

### Rename: `auth_url` → `auth_server`

The remote-auth sidecar URL field under `[remote.authentication]` is renamed
from `auth_url` to `auth_server`, matching the `record_server` naming on the
stats side (new form only — no legacy parsing). Updated: `ProxyConfig`
interface + both parser branches + serializer in `config-loader.ts`; the
single accessor in `src/index.ts`; README (quick-start TOML, protocol section,
mermaid diagram, config-reference table, `DEV_NO_KEY` row); the two
`docs/nginx_conf/*/USAGE.md` notes; `proxy_config.example.toml`; and the
unit / `15_config_parse` test fixtures.

### Config schema: `[remote.authentication]` + `[remote.recording]`

The sidecar config is restructured under a new `[remote]` namespace (new form
only — no legacy parsing):

- **`[general] auth_url` / `auth_with_model` / `auth_with_body` /
  `auth_passthrough_with`** moved to **`[remote.authentication]`** (field names
  unchanged).
- **`[model_usage]`** renamed to **`[remote.recording]`**; **`record_url`** →
  **`record_server`**; **`record_body`** → **`record_response_body`**.

Updated: `ProxyConfig` interface, `parseSimpleToml` (section-header, quoted-key,
and unquoted-value parsers), `serializeProxyConfigToml`, all `src/index.ts`
accessors (`proxyConfig.remote?.authentication?.*` /
`proxyConfig.remote?.recording?.*`), README config-reference tables + protocol
section + mermaid diagram, `proxy_config.example.toml`, and the unit /
`15_config_parse` test cases.

### Rename: `access_token` → `one_time_auth_code` (OTAC) on auth/stats sidecars

The linkage header exchanged between the auth sidecar (`[general] auth_url`)
and the stats sidecar (`[model_usage] record_url`) is renamed from
`access_token` to `one_time_auth_code` (OTAC — one-time authorization code).
The semantics are unchanged: the auth response's `one_time_auth_code` header
is stored per-request and re-sent on the stats POST so a combined backend can
correlate the usage record with the authenticated principal. Renamed in:
`doAuthRequest` (header read), the `modelUsageOneTimeAuthCode` variable,
`recordModelUsageToRemote`'s `oneTimeAuthCode` parameter, and the stats POST
header. README + mermaid diagram updated.

### Feature: record non-2xx responses + `response_status` to stats service

Every usage record POSTed to `[model_usage] record_url` now carries a
`response_status` field (the upstream HTTP status; `0` when no response was
obtained). Non-2xx upstream responses are now recorded too — previously only
successful responses produced a record, so failures were invisible to the
collector. Non-2xx records carry all token counters at `0` (error bodies rarely
carry usage) and the real status. When `record_body = true`, the non-2xx
constructed error body is attached to `response_body` (parsed JSON for
JSON errors, raw text otherwise), matching the success-body behavior. Streaming
responses remain 200-or-bust (errors come as non-streaming JSON even when
`stream:true` was requested). `buildModelUsageRecordPayload` grew a required
`responseStatus` param; the two success call sites pass the real status, the
new non-2xx branch passes `response.status`.

### Feature: `auth_with_body` / `record_body` — forward full request/response bodies to sidecars

Two new config flags let the remote auth and stats sidecars see entire request
and response bodies (raw JSON, not base64):

- **`[general] auth_with_body = true`** (default `false`) — the `auth_url` call
  is deferred until after the request body is parsed (same timing as
  `auth_with_model`), and the entire parsed request body is forwarded as the
  `POST` body with `Content-Type: application/json`. The method switches from
  `GET` to `POST` only when a parsed body is available; on non-body-parsed
  routes (dynamic routes) it degrades to the bodyless form. Either
  `auth_with_model` or `auth_with_body` triggers the deferred path. The body
  sent is post privacy-filter / kompress / tool-blocklist, so redacted PII
  never reaches the auth sidecar.
- **`[model_usage] record_body = true`** (default `false`) — each usage record
  POSTed to `record_url` includes a `response_body` field: the parsed JSON
  object for non-streaming responses, or the accumulated raw SSE text (all
  events concatenated) for streaming responses. Streaming body capture is
  threaded through `createUsageTrackingTransformStream` via a new optional
  `collectBody` flag.

Implementation: `doAuthRequest` now takes an optional body string; the payload
builder `buildModelUsageRecordPayload` and recorder `recordModelUsageToRemote`
grew an optional `responseBody` argument; the two stats call sites (JSON +
streaming SSE) populate it. The README "Auth & Stats Service Protocol" section
documents both flags, and the mermaid diagram now shows the GET/POST auth form
and the optional `response_body` on the stats POST.

### Docs: auth & stats service protocol + dynamic-routing override spec

Documented the wire-level contract between the proxy and the two optional
remote sidecars (`[general] auth_url` and `[model_usage] record_url`) in a new
**Auth & Stats Service Protocol** section of the README, plus a mermaid
sequence diagram showing proxy ↔ auth/stats/upstream interaction. Documented
the design contract for the auth service returning a **one-time dynamic
routing override** in its response body (acting as a single-use alias config
entry: `target` / `mode` / `base` / `key` / `transforms`), which the proxy
would apply directly for that request and skip config-file model resolution.
The override is per-request and ephemeral; requires `auth_with_model = true`.
(README documentation only — no code change in this revision.)

### Feature: client-IP forwarding headers on auth / stats sidecar calls

The proxy now forwards the caller's client IP to the remote auth service
(`[general] auth_url`) and the stats recorder (`[model_usage] record_url`) via
two headers: `x-forwarded-for` (always set when a client IP is detectable) and
`x-real-ip` (set only when the caller did not already provide one, preserving
any explicit value from an outer proxy). The client IP is resolved by the
existing `getClientIp` helper (`cf-connecting-ip` → first `x-forwarded-for`
entry → `x-real-ip`). Added `getSidecarForwardedHeaders` in `src/utils/routing.ts`
alongside `addForwardedHeaders`; the latter is unchanged so upstream provider
calls (Claude/OpenAI/Gemini) keep carrying only `x-forwarded-for` as before.
`recordModelUsageToRemote` grew an optional `extraHeaders` parameter that the
two stats call sites (JSON response + streaming SSE) populate with the same
forwarding headers.

### Feature: Apollo config backend (`PROXY_CONFIG_APOLLO`)

Added [Apollo](https://www.apolloconfig.com/) (apolloconfig/apollo) as a third
config source alongside the local TOML file and Consul. One Apollo namespace
holds the *entire* `proxy_config.toml` content as a plain-text value; the
proxy fetches it via `GET {meta}/configs/{app_id}/{cluster}/{namespace}` and
runs it through the existing `parseSimpleToml()` + validation pipeline — no
Apollo SDK, no live-reload long-poll. Reload is on-demand via `/config-reload`,
the same model Consul uses.

`PROXY_CONFIG_APOLLO` points at a connection file:

```
apollo:
app_id = "proxyv3"
cluster = "default"
namespace = "test"
meta = "https://test-apollo-config.example.com"
access_key_secret = "<plaintext HMAC-SHA1 key>"
```

`access_key_secret` is the **plaintext HMAC-SHA1 key**. It is never sent
directly; each request is signed as `Authorization: Apollo
<app_id>:<base64(HMAC-SHA1(secret, "<timestamp>\n<path?query>"))>` with a
`Timestamp` header. The `enc:...` wrapper is a Portal storage-layer format and
is not handled here — if a deployment stores the key encrypted at rest, it must
be decrypted before being written to the connection file.

The Apollo `meta` host is **not** restricted to private/LAN addresses (unlike
Consul) — point it only at an Apollo instance you trust. Node-only: the
connection file is read with `fs`, so this backend is unavailable in the
Cloudflare Workers build.

Backend precedence when more than one is set: **Apollo > Consul > Path**.

**No live-update notifications.** The proxy does not subscribe to Apollo's
`notifications/v2` long-poll (nor Consul watches). After publishing a change
in the portal, call `GET /config-reload` (or restart) for it to take effect.
The proxy emits a `[WARN]` startup reminder when the Apollo backend is active.

### Refactor: Consul KV loader extracted to `src/utils/consul-loader.ts`

Moved `ConsulKvEntry`, `buildConsulKvUrl`, `parseConsulConfig`, and their
helpers (`decodeBase64`, `parseConsulArrayValue`, `parseConsulScalarValue`,
`applyConsulKvEntry`) out of `config-loader.ts` into a standalone module.
No behavior change. `config-loader.ts` now imports these via
`./consul-loader.js`.

### Breaking: `PROXY_CONFIG_URL` renamed to `PROXY_CONFIG_CONSUL`

The Consul-backend discriminator env var has been renamed to make room for the
Apollo backend. Update your environment:

```
- PROXY_CONFIG_URL=http://127.0.0.1:8500
+ PROXY_CONFIG_CONSUL=http://127.0.0.1:8500
```

No backward-compat alias is provided. The Consul host SSRF guard (loopback /
private-LAN only) is unchanged.

### Feature: `assemble_sse_chunks` builtin — SSE-to-non-SSE assembly for openai-completions

New builtin for the `after_upstream` hook on `openai-completions` routes. When an
upstream only supports streaming, attach this builtin alongside `before_upstream`
ops that force `stream=true` and `stream_options.include_usage=true`. The builtin
reads the SSE stream to completion and assembles all `chat.completion.chunk` events
into a single `chat.completion` JSON response returned to the client:

- Choices are grouped by `choices[].index` and sorted; supports `n>1` with
  out-of-order or interleaved chunks
- Text `content` deltas are concatenated per choice index
- `tool_calls` argument deltas are concatenated per `(choice index, tool-call index)`
- `finish_reason` is taken from the last chunk that carries it per choice
- `usage` is forwarded from the final chunk (requires `stream_options.include_usage`)

**Safety rails:**

- **Schema-gated at config load.** Declaring `assemble_sse_chunks` under any schema
  other than `openai-completions` now fails load-time validation with an error like
  `builtin "assemble_sse_chunks" requires schema "openai-completions" but set has
  schema "anthropic-messages"`. Without this gate, the builtin would silently emit
  `choices: []` on Claude/Gemini SSE streams, destroying the response.
- **Warns on content-type mismatch.** When the builtin is declared but the upstream
  returns a non-SSE content type (e.g. `application/json`), the proxy logs
  `assemble_sse_chunks: expected text/event-stream from upstream but got "..."`
  and passes the response through unchanged — no silent corruption.

Example config (see `proxy_config.transforms.example.toml` for full snippet):

```toml
my-model = {target = "actual-model-id", base_url = "https://...", api_key = "sk-...", transforms = "sse_to_completions"}

[transforms.sse_to_completions]
schema = "openai-completions"
before_upstream.ops = [
  {op = "set", path = "stream",         value = true},
  {op = "set", path = "stream_options", value = {include_usage = true}},
]
after_upstream.builtins = ["assemble_sse_chunks"]
```

Multiple transforms compose via comma-separated CSV (e.g.
`transforms = "max_tokens_rename,sse_to_completions"`). Sets at different hook
points never conflict; sets touching the same path at the same hook resolve
last-writer-wins (left-to-right). See the inline comments in
`proxy_config.transforms.example.toml` for the full conflict-avoidance notes.

Newest merged work, reverse-chronological.

### Tweak: config errors/warnings surface only at idle, not mid-held-message

Config errors and warnings in the periodic refresh now only surface when the
status bar is idle (no held message). Previously they would fire unconditionally
every 500ms, overwriting any in-progress success or action message. Now held
messages are preserved to their natural expiry; when the bar goes idle it shows
existing config errors (6000ms) or warnings (2000ms) before settling to 'Ready'.

### Tweak: TUI status-bar messages now have explicit hold durations

Error and result messages in the TUI bottom status bar previously cleared on the
next refresh (no guaranteed display time). They now hold for a fixed duration by
category: caught errors and config warnings hold 2s, config errors hold 5s, and
model test results (single and test-all) hold 6s. The minimum hold is now 1s —
the `setMessage` default changed from `0` to `1000ms`, so transient messages
that previously passed no duration also linger for at least one second.

### Fix: wildcard routing now works in all provider sections; `[models.FREE]` / `[models.EMBEDDING]` are canonical exact-only names

**What changed:**

Previously, `prefix-*` wildcard matching in Priority 2 was hardcoded to only
check `claude`, `gemini`, and `gpt` sections. User-defined provider sections
(e.g. `[models.nvidia]`, `[models.openrouter]`) were silently skipped — their
wildcard entries never matched, contrary to what the README documented.

Priority 2 now iterates all sections dynamically, giving every provider section
(built-in or user-defined) full `prefix-*` wildcard support. The two special
concrete sections — `[models.FREE]` and `[models.EMBEDDING]` — remain
exact-only and are explicitly excluded.

**Canonical section names:** `FREE` and `EMBEDDING` are now the documented and
example-config forms. Both names are case-insensitive (`free`/`FREE`,
`embedding`/`EMBEDDING` work identically at runtime).

**Routing priority (unchanged structure, corrected behaviour):**

| Priority | Match type | Sections checked |
|---|---|---|
| 1 | Exact key | All sections |
| 2 | `prefix-*` wildcard | All sections except `FREE`/`free`, `EMBEDDING`/`embedding`, `default` |
| 3 | `prefix-*` then `*` catch-all | `default` only |

**Files touched:** `src/utils/config-loader.ts` (Priority 2 wildcard loop),
`src/index.ts` (`EMBEDDING`/`embedding` fallback lookup, `FREE`/`free` section
check), `proxy_config.example.toml`, `proxy_config.toml_template` (section
headers updated to uppercase), `README.md` (routing table + callout corrected),
`tests/unit/config-loader.test.ts` (4 new `getModelConfig` cases).

### Breaking: unified sliding/calendar token-limit windowing

The global `global_token_limit` and per-alias composite `token_limit` previously
used two different windowing strategies — sliding for global, fixed-window
accumulator for composite. They now share one parser and one event-log-based
enforcement path, with both sliding and calendar-anchored durations supported.

**Duration vocabulary (shared by both limits):**

| Token | Shape | Cutoff |
|---|---|---|
| `1h`–`23h` | sliding | last N hours from now |
| `1d`–`6d` | sliding | last N days from now |
| `1w` | calendar | start of current calendar week (configurable start day) |
| `1m` | calendar | first day of current calendar month, 00:00 local |

**Breaking changes:**

- `1w` is now a **calendar week** (was: sliding 7 days from now).
- `1m` is now a **calendar month** (was: sliding 30 days from now).
- Composite alias limits no longer use a fixed-window accumulator that resets
  at a drifting boundary. They use a per-alias event log queried against the
  derived cutoff. State no longer needs `windowStartMs`/`accumulator` fields;
  persistence format changed to `compositeAliasStates` (legacy
  `compositeLimitWindows` records still load but with empty event logs).

**New config key:** `general.week_start_day = "monday" | "sunday"` (default
`monday`). Controls where the `1w` calendar cutoff lands.

**Migration impact:** there is no exact replacement for the previous rolling
7-day or rolling-30-day behavior. The closest sliding equivalents are `6d` and
`6d` respectively (max sliding day-count). Users who depended on rolling
windows should re-evaluate which duration best fits their use case.

**Files touched:** `src/utils/config-loader.ts` (type + parser +
`getCompositeTokenLimit` + `week_start_day`), `src/utils/dashboard-stats.ts`
(`WindowSpec`, `parseWindowSpec`, `getWindowCutoff`, `setWeekStartDay`,
composite storage rewrite, `getTokensInWindowSince`, 31-day retention,
persistence), `src/index.ts` (global check uses cutoff, simplified config
sync), `src/tui.ts` (panel uses cutoff).

### Fix: config sections losting on dashboard/TUI save

Four bugs in `src/utils/config-loader.ts` caused silent data loss when the
dashboard or TUI wrote the config back to disk:

- **`[privacy_filter]` dropped by serializer.** `serializeProxyConfigToml` had
  no branch for `config.privacy_filter`, so every setting (`filter_mode`,
  `filter_url`, `timeout_ms`, `max_chars`, `entropy_threshold`, `hash_min_len`,
  `whitelist_add`, `whitelist_remove`, `whitelist_file`) was silently discarded
  on save. Fixed by adding a `[privacy_filter]` emit block.

- **`[fetch]` dropped by both parser and serializer.** `parseSimpleToml` had no
  section-header branch for `[fetch]`, so `image_encode` and `timeout_ms` were
  never loaded into `config.fetch`. `serializeProxyConfigToml` likewise had no
  emit block. Fixed both. Also added `hash_min_len` to the `ProxyConfig.privacy_filter`
  interface (it was parsed but the field was missing from the type).

- **Transform `headers.set` / `headers.remove` lost on round-trip.** The
  serializer emitted `before_upstream.headers.set = {...}` and
  `before_upstream.headers.remove = [...]` correctly, but `parseSimpleToml`
  had no matching parse paths, so they were dropped on reload. Fixed by adding
  an inline-object parser for `<hook>.headers.set` and a `headers.remove` branch
  in the existing array handler.

- **`set`/`default` transform ops coerced non-string values to strings.**
  `serializeTransformOp` called `String(op.value)` before `JSON.stringify` for
  `set` and `default` ops, turning `value = 0` into `value = "0"`. Fixed by
  removing the premature `String()` coercion.

### Fix: TUI `cached` / `wrote` token columns now record all upstream usage shapes

The TUI/dashboard stats pipeline previously only recognized the Claude usage
shape (`cache_read_input_tokens` / `cache_creation_input_tokens`) and the
Responses-API shape (`input_tokens_details.cached_tokens`). Cache fields used by
other upstream shapes were silently dropped, so `cached`/`wrote` showed 0 even
when the upstream reported non-zero values. In several configurations streaming
responses recorded nothing at all.

Fixed locations (all in `src/utils/dashboard-stats.ts` unless noted):

- **`extractUsageFromResponsePayload` (non-streaming JSON responses).** The
  `cached` fallback chain is now `cache_read_input_tokens` (Claude) →
  `prompt_cache_hit_tokens` (OpenRouter) → `prompt_tokens_details.cached_tokens`
  (chat-completions / OpenAI / GLM) → `input_tokens_details.cached_tokens`
  (Responses). `wrote` now also falls back to `prompt_cache_miss_tokens`
  (chat-completions) in addition to `cache_creation_input_tokens` (Claude).
- **OpenAI-SSE streaming branch of `createUsageTrackingTransformStream`.** Same
  fallback chain applied; previously only `prompt_tokens` / `completion_tokens`
  / `total_tokens` were read, so cache fields from chat-completions SSE were
  dropped.
- **Responses-SSE streaming branch (new).** `event: response.completed` and
  `response.in_progress` frames were previously unmatched by either SSE branch
  (they have an `event:` line, so the OpenAI-SSE branch was skipped, but the
  Claude-SSE branch only matched `message_start` / `message_delta`). Streaming
  `/v1/responses` — both Responses-shaped upstream passthrough and the
  Claude→Responses / Completions→Responses conversion paths — recorded zero
  usage. The parser now reads `data.response.usage` (`input_tokens`,
  `output_tokens`, `total_tokens`, `input_tokens_details.cached_tokens`) for
  those event types.
- **`extractTokenCounts` in `src/converters/openai-to-claude.ts`.** When
  `/v1/messages` is routed to a chat-completions upstream, stats are extracted
  from the converted Claude-shape client response, so the converter must carry
  the cache field through. It previously mapped
  `prompt_cache_hit_tokens` / `input_tokens_details.cached_tokens` but not
  `prompt_tokens_details.cached_tokens`, dropping cache hits to `undefined` on
  this common path. Now uses the same fallback chain as
  `extractUsageFromResponsePayload`.
- **`??` short-circuit fix in `extractUsageFromResponsePayload`.** The
  multi-shape fallback chain originally returned a literal `0` from the
  `prompt_tokens_details` ternary when that field was absent — and since `??`
  does not fall through on `0`, a Responses payload with only
  `input_tokens_details.cached_tokens` resolved to `0` instead of the actual
  value. Caught by a regression test; both ternaries now return `undefined`
  when their nested field is absent so the chain falls through correctly.

**Verification:** `glm-5.2-comp` (chat-completions upstream) with a warm GLM
prompt cache now records `cached += 64` per request, matching the upstream
`prompt_tokens_details.cached_tokens: 64` exactly. `in`, `out`, `total` were
already correct and remain so. `glm-5.2-anth` (anthropic-messages upstream) was
already correct via `cache_read_input_tokens`.

**Known limitations (unchanged, spec-driven):**
- `/v1/responses` exposes no cache-write field in its usage spec, so `wrote`
  stays 0 for that API.
- `completion_tokens_details.reasoning_tokens` / `output_tokens_details.
  reasoning_tokens` remain bundled inside `out` — not surfaced as a separate
  column.

### Add: `/v1/interactions` (Gemini) → `openai-completions` image preservation

### Add: `/v1/interactions` (Gemini) → `openai-completions` image preservation

`convertGeminiInteractionsToOpenAI` (`src/handlers/openai.ts`) previously
extracted only text from each turn's parts, silently dropping `inline_data` /
`inlineData` image parts. This affected any `/v1/interactions` client (Gemini
Interactions SDK shape) routed to an `openai-completions` upstream — image
inputs were lost.

Two sub-paths are fixed using a new shared helper `geminiPartsToOpenAIContent`:

- **Contents-format branch** (Gemini generateContent shape): each `parts` array
  is converted via the helper, emitting OpenAI `image_url` data-URI parts for
  any `inline_data` / `inlineData`. Text-only content still collapses to a
  joined string (wire shape preserved).
- **Array-of-turns `input` branch** (TC203-style): string content preserved
  unchanged; array content (Gemini parts shape) routed through the helper.
- Both snake_case (`inline_data.mime_type`) and camelCase (`inlineData.mimeType`)
  accepted.
- `thought:true` text parts are skipped (thinking markers; not part of content
  body in this direction).

**Known limitation (left as-is):** `convertGeminiGenerateContentToOpenAI`
still drops `inline_data` parts on the `funcCallParts` branch — i.e. a Gemini
model turn that emits both a `functionCall` *and* an image in the same turn.
This is a rare edge case (image-generation-with-tools models), and OpenAI's
spec does not define assistant `tool_calls` turns with array image content.
See README "Image input/output across format boundaries" for the limitation
listing.

**Files**: `src/handlers/openai.ts` (new `geminiPartsToOpenAIContent` helper,
updated both branches of `convertGeminiInteractionsToOpenAI`, exported that
function for testability).

**Tests**: 5 new in `tests/unit/gemini-to-openai-image.test.ts` —
snake_case `inline_data`, camelCase `inlineData`, array-of-turns image
preservation, text-only collapse (regression), TC203 string content
(regression).

### Add: `/v1/responses` → `anthropic-messages` / `gemini-generatecontent` image preservation

`/v1/responses` clients sending `input_image` parts previously lost them on every
non-passthrough route — the chain routed through `convertResponsesToChatCompletions`
which emitted a `[Image input]` placeholder string, then a local
`completionsBodyToClaudeBody` copy in `responses.ts` that itself dropped array
content. Both gaps are closed:

- **`src/converters/responses-to-completions.ts`** — `convertContentToString`
  renamed to `convertResponsesContentToCompletionsContent`. It now returns
  Chat Completions `image_url` parts (object form `{url, detail?}`) for each
  Responses `input_image` part, instead of the `[Image input]` placeholder.
  Text-only content still collapses to a string (wire shape preserved).
- **`src/handlers/responses.ts`** — `handleAsAnthropicMessages` and
  `handleAsGemini` now reuse `completionsToClaudeBody` from `./openai.js`
  (awaited, async). The previous local `completionsBodyToClaudeBody` is kept
  for reference with a deprecation comment — do not add new call sites.

This reuse also fixes three latent bugs on these routes that the local copy had
fallen behind on: consecutive `tool` messages are now grouped into a single
user turn (Claude requirement), `reasoning_content` is now preserved as
`thinking` blocks, and `image_url` parts become Claude `image` blocks (data:
URI decoded in-process; http(s) fetched via the SSRF-guarded
`fetchImageAsInlineData` and optional `[fetch] image_encode` sidecar).

**Files**: `src/converters/responses-to-completions.ts` (renamed helper +
image preservation), `src/handlers/responses.ts` (reuse + deprecated local
copy retained with comments).

**Tests**: 5 new in `tests/unit/responses-completions-roundtrip.test.ts` —
data-URI input_image end-to-end into Claude `image` block, http input_image
through the sidecar fetch, text-only collapse (regression), object-form
`{url, detail}` normalization, image_url preserved as array content.

### Add: OpenAI `image_url` → Responses `input_image` (Completions → openai-responses)

`completionsToResponsesBody` (`src/handlers/openai.ts`) now forwards `image_url`
content parts as Responses API `input_image` parts. Closes the gap where an
OpenAI SDK client sending `image_url` to `/v1/chat/completions` or
`/v1/interactions` routed to an `openai-responses` upstream silently lost images
(the old converter used `openAIContentToText`, which filtered to text only).

Unlike the Gemini and Claude directions, no in-proxy image fetch is needed: the
Responses API accepts image URLs natively, so the `image_url` object
(`{url, detail?}`) is passed through unchanged. This mirrors the existing
Claude → Responses pattern in `src/handlers/messages.ts:151`.

- Text-only array content still emits a single `input_text`/`output_text` part
  (no behavior change for non-image requests; existing tests pass unchanged).
- `image_url` parts are always emitted as `input_image` regardless of message
  role (matches `messages.ts`); text parts use the role-appropriate
  `input_text` / `output_text`.

**Files**: `src/handlers/openai.ts` (new `openAIContentToResponsesParts`
helper, updated regular-message branch in `completionsToResponsesBody`).

**Tests**: 3 new in `tests/unit/handlers.test.ts` — URL passthrough (with
`detail`), data: URI passthrough, assistant role mixing `output_text` +
`input_image`.

### Add: OpenAI `image_url` → Claude `image` block conversion (Completions → anthropic-messages)

`completionsToClaudeBody` (`src/handlers/openai.ts`) now converts `image_url`
parts into Claude `image` blocks (`{type:'image', source:{type:'base64',
media_type, data}}`). Closes the most common cross-mode gap: an OpenAI SDK
client sending `image_url` to `/v1/chat/completions` or `/v1/interactions`
routed to an `anthropic-messages` upstream previously lost images silently —
the converter read only `m.content ?? ''` and dropped array content.

- `data:` URI images are decoded in-process via the shared `decodeDataUri`
  helper (now exported from `src/converters/claude-to-gemini.ts`).
- http(s) image URLs are fetched via the existing SSRF-guarded
  `fetchImageAsInlineData` (and respect the optional `[fetch] image_encode`
  sidecar configuration).
- Text-only arrays still collapse to a string (preserves prior wire shape and
  existing tests; no behavior change for non-image requests).
- The `function` is now `async`; both call sites
  (`forwardCompletionsAsAnthropicMessages` in `openai.ts`, and
  `handleChatCompletionsPassthrough` in `chat-completions.ts`) `await` it.

**Known limitation**: Anthropic's Messages API restricts `image` blocks to
`user` role messages per spec. The proxy emits image blocks for any role
containing `image_url` (matches how `convertClaudeToGeminiRequest` and
`convertClaudeContentToOpenAI` already handle images cross-role); if Claude
rejects assistant-role images, that is the upstream's spec enforcement.

**Files**: `src/handlers/openai.ts` (helper `openAIContentToClaudeStringOrBlocks`,
async `completionsToClaudeBody`), `src/converters/claude-to-gemini.ts` (exported
`decodeDataUri`), `src/handlers/chat-completions.ts` (await call site).

**Tests**: 6 new in `tests/unit/handlers.test.ts` — data-URI decode, http→sidecar
fetch, text-only array collapse, thinking + image ordering, malformed data-URI
throws (Fail Loud), empty url skip.

### Add: optional image-encode sidecar for OpenAI `image_url` → Gemini `inline_data`

The Direction B conversion (commit 71e0a4c) now supports delegating the http(s)
image fetch + base64 encode to an external sidecar, as an alternative to the
default in-process fetcher. Useful when you want the proxy worker to stay
CPU-light (no in-process image download + base64) or want to centralize SSRF
policy / image fetching in a dedicated service.

Configuration (toml):
```toml
[fetch]
image_encode = "localhost:34567"   # shorthand; "http://localhost:34567" also accepted
timeout_ms = 40000                 # per-call timeout (optional, default 40000)
```
Env-var overrides: `IMAGE_ENCODE_URL`, `IMAGE_ENCODE_TIMEOUT_MS`.

**Sidecar contract**: `POST {image_encode}/encode` with body `{"url": "..."}`.
Response: `{"mime_type": "...", "data": "<base64>"}`. Any non-OK status,
non-JSON body, or missing `data` field is treated as a hard failure (Fail
Loud — no placeholder).

**Validation**: the sidecar itself must be reachable on localhost or a
private/LAN host (validated via `isInternalHost` at startup). The image URL's
own SSRF policy is the sidecar's responsibility — when a sidecar is
configured, the proxy skips its in-process `isInternalHost` check on the
image URL. `data:` URIs are still decoded in-process (no sidecar call) since
they carry no network fetch.

**Files**: `src/utils/image-fetch.ts` (new `resolveImageEncodeConfig`,
`setImageEncodeConfig`, `getImageEncodeConfig`, `fetchImageViaSidecar`),
`src/utils/config-loader.ts` (new `[fetch]` section + startup wiring),
`src/types/shared.ts` (new env vars), `proxy_config.example.toml`
(documented example).

**Tests**: 12 new in `tests/unit/image-fetch.test.ts` covering sidecar
delegation (success, non-OK status, missing data, non-JSON) and the resolver
(null, shorthand, trailing-slash strip, env precedence, timeout, non-local
rejection, non-http rejection, LAN-host acceptance).

### Add: bidirectional OpenAI `image_url` ↔ Gemini `inline_data` conversion

Two previously-silent image-drop gaps are closed. Image parts now flow across
the OpenAI ↔ Gemini format boundary in both directions.

**Direction A — Gemini → OpenAI** (existing route, surgical):
`convertGeminiGenerateContentToOpenAI` in `src/handlers/openai.ts` now emits
OpenAI `image_url` (data-URI) parts from Gemini `inline_data`/`inlineData`
parts. Used when a Gemini SDK client sends `generateContent` with images and
the route targets an OpenAI-compatible upstream. When a turn has image parts
its `content` becomes an array mixing text and `image_url` parts; text-only
turns keep string `content` (unchanged). Both snake_case and camelCase Gemini
field names are accepted on input. Assistant turns that also carry
`tool_calls` stay text-only — OpenAI does not support `image_url` on a
`tool_calls` turn.

**Direction B — OpenAI → Gemini** (new cross-mode route):
`/v1/chat/completions` requests with `image_url` blocks routed to a
`gemini-generatecontent` upstream now work end-to-end. New components:
- `convertCompletionsToGeminiGenerateContentBody` in
  `src/converters/claude-to-gemini.ts` — converts OpenAI Completions body to
  Gemini `generateContent` body (system → `systemInstruction`, images →
  `inline_data`, tools → `functionDeclarations`, tool_calls → `functionCall`).
- `forwardCompletionsAsGeminiGenerateContent` branch in
  `src/handlers/chat-completions.ts` — non-streaming + streaming. Streaming
  switches the URL to `:streamGenerateContent?alt=sse` and converts Gemini SSE
  chunks to OpenAI `chat.completion.chunk` SSE inline.
- `fetchImageAsInlineData` in `src/utils/image-fetch.ts` — server-side image
  fetch for http(s) `image_url` values, with an SSRF guard that blocks
  loopback / RFC1918 / link-local / mDNS hosts (reuses `isInternalHost`) and a
  20 MiB byte cap. `data:` URIs decode synchronously; http(s) URLs are fetched
  and base64-encoded.
- URL build fix at `src/index.ts:1186` for DEV_PASS_THROUGH mode so a
  `gemini-generatecontent` route resolves to `v1beta/models/<model>:generateContent`.

**Known limitations on the OpenAI-client → Gemini-upstream response path**:

1. **Tool-call and thinking parts of a Gemini response are dropped.**
   `convertGeminiGenerateContentToClaude` (`src/converters/gemini-to-claude.ts:191-203`)
   extracts `text` parts only. The streaming transformer handles text deltas
   and `finishReason`, but not `functionCall` or `thought` parts. Tracked as a
   follow-up — extending that converter would let tool-calls round-trip into
   OpenAI `tool_calls` and thinking into `reasoning_content`.

2. **Model-generated image output is not carryable to an OpenAI client.**
   This is a hard limit imposed by the target response schemas, not a missing
   converter:
   - The Anthropic API spec restricts `image` content blocks to **user**
     (input) messages — an assistant message carrying an `image` block is
     rejected by a real Anthropic-compatible upstream. The proxy's local
     `ClaudeContentBlock` type permits it structurally, but the spec does not.
   - The OpenAI Chat Completions response schema has no image-output content
     type at all (`choices[].message.content` is text, or an array of
     `text`/`image_url` parts where `image_url` is also input-only).
   So a Gemini model that returns `inlineData` (e.g. an image-generation
   model) cannot deliver those bytes to a `/v1/chat/completions` client
   through this cross-mode route, regardless of how the converters are
   extended. Model-generated images only reach clients through native Gemini
   passthrough (`:generateContent`/`/v1/interactions` client →
   `gemini-generatecontent`/`gemini-interactions` upstream), where
   `inlineData` passes through unchanged.

**Tests**: `tests/unit/gemini-to-openai-image.test.ts`,
`tests/unit/completions-to-gemini.test.ts`,
`tests/unit/image-fetch.test.ts`,
`tests/unit/chat-completions-gemini-streaming.test.ts` (20 new tests).

### Add: full-pipeline request/response header tracing (`LOG_LEVEL=trace`)

Extended the trace logs added above to also emit the request/response headers at
each pipeline stage (inbound, upstream-request, upstream-response, outbound).
Auth-bearing headers (`Authorization`, `x-api-key`, `x-goog-api-key`,
`anthropic-beta`) are stripped entirely (not masked) from the log output, per
the rest of the codebase's redaction convention. Emitted as `[STAGE-HEADERS]
endpoint: {…}` lines via `logger.trace`.

- `logPipelineHeaders()` added to `src/utils/logger.ts` alongside
  `logPipelineStage()`; wired at every fetch/return site across all handlers
  (`claude`, `messages`, `chat-completions`, `gemini`, `openai`, `responses`).

### Add: full-pipeline request/response body tracing (`LOG_LEVEL=trace`)

Added a new `trace` log level (below `debug`) that logs the message body at each
of the four stages of the proxy pipeline for every request:

1. **inbound** — the raw body as received at the endpoint, before any conversion.
2. **upstream-request** — the body after conversion, as sent to the upstream.
3. **upstream-response** — the raw body (or SSE chunks) received back from upstream.
4. **outbound** — the body (or SSE events) after conversion, as returned to the client.

This makes it possible to diagnose format-conversion bugs by capturing the exact
body at each stage instead of relying on synthetic reproduction.

- `Logger` (`src/utils/logger.ts`, `src/types/shared.ts`) gained a `trace` method,
  ordered below `debug` (`trace=-1, debug=0, info=1, warn=2, error=3`). `LOG_LEVEL=trace`
  now enables both trace and debug output; `LOG_LEVEL=debug` does not emit trace lines.
- New `logPipelineStage(logger, requestId, stage, endpoint, body)` helper in
  `src/utils/logger.ts` labels output as `[IN]`, `[UPSTREAM-REQ]`, `[UPSTREAM-RESP]`, or
  `[OUT]` and truncates bodies over 128,000 chars.
- Wired into every request handler (`claude.ts`, `messages.ts`, `gemini.ts`, `openai.ts`,
  `responses.ts`, `chat-completions.ts`) at all four stages, covering both streaming (SSE,
  via stream `tee()` so the client stream is undisturbed) and non-streaming paths.
- Fixed a bug in `createLogger`'s level-validation whitelist that would have silently
  downgraded `LOG_LEVEL=trace` to `info` (the whitelist array didn't include `'trace'`).

### Fix: synthesize a `signature` on signature-less thinking blocks

Anthropic's spec marks `signature` as REQUIRED on thinking content blocks, and
clients like `@ai-sdk/anthropic` reject responses missing it with a
`TypeValidationError`. Upstreams such as DeepSeek and bigmodel.cn's glm-5.2
emit reasoning without a signature, so both the non-streaming converter
(`src/converters/openai-to-claude.ts`) and the streaming converter
(`src/converters/streaming.ts`) now fall back to a shared constant
`SYNTHETIC_THINKING_SIGNATURE`. A constant (not a random/request-id value) is
used because the field is only consumed for Anthropic's own reasoning
round-trip verification — which does not apply to translated upstreams — so
nothing keys off its value; a constant keeps it reproducible and testable.

### Fix: `buildUpstreamUrl` dedupes any trailing `v\d+` version segment

`buildUpstreamUrl` (in `src/utils/routing.ts`) previously only stripped a
doubled version segment when both the `base_url` tail and the suffix head
were exactly `v1` or `v1beta`. Providers whose version segment is anything
else (e.g. Zhipu/BigModel `…/paas/v4`) got the suffix's `v1/...` appended
verbatim, producing a 404-inducing `/v4/v1/...` path under
`openai-completions` (and likewise for `anthropic-messages`,
`openai-responses`, and Gemini `v1beta/models/...:action` suffixes).

Rule 3 now matches any trailing `v\d+[a-z]*` segment on `base_url` against
any leading `v\d+[a-z]*/` segment on the suffix; the base's version wins and
the suffix's leading version is dropped. The previous workaround of
pre-baking the full path into `base_url` (still handled by rule 1) is no
longer required for these providers. +8 unit tests in
`tests/unit/routing.test.ts` (676 → 684), all passing.

### Test: add unit coverage for `thinking.ts` and `beta-features.ts`

Both `src/utils/thinking.ts` and `src/utils/beta-features.ts` are pure,
branch-heavy modules that previously had no direct unit tests (only indirect
exercise via converters). Added `tests/unit/thinking.test.ts` and
`tests/unit/beta-features.test.ts` covering normalization, budget
validation/adjustment, estimation, merge logic, and the anthropic-beta header
parse/validate contract (unknown features dropped, invalid JSON returns `null`
without throwing). +76 unit tests (600 → 676), all passing.

### Fix: dashboard now preserves per-model `upstream_mode` overrides on save

Editing a `[models.*]` inline-table entry on `/dashboard` silently dropped
the per-model `upstream_mode` (a.k.a. short alias `mode`) override on every
save. `modelEntryRow` only rendered inputs for the target alias and
`base_url`, and `collectConfigPayload` always sent `[target, base_url, '']`
— so the backend `applyDashboardConfigUpdate` (which already reads `value[2]`
as the mode) received an empty string and rewrote the entry with no override.
After the fix, each model row renders a per-model `<select>` seeded from
the GET payload's 3-element `[target, base_url, mode]` shape (mode index 2,
`(inherit)` option for empty), and the PUT payload carries the picked mode
at index 2. The existing inline-table aliases from `parseSimpleToml`
(`upstream_mode`/`mode`, `base_url`/`url`, `api_key`/`key`) round-trip
end-to-end now.

### Dashboard: in-page wizards for "Add target" and "Add model entry"

The two remaining `window.prompt`-based "add" flows on the `/dashboard`
config editor are now self-contained modal wizards, matching the look and
feel of the existing "Add composite alias" wizard (step indicator, Back /
Next / Cancel, Esc-to-close, inline `modal-status` validation, and the
`configDirty` gate that pauses stats auto-reload while the modal is open).

- **"Add target"** (`composite.<alias>` → Add target) replaces the prompt
  chain that asked for mode → model id → (coordinator only) role. For an
  empty alias it shows a mode-picker step; for a non-empty alias the mode
  is inferred from the existing targets and the wizard steps straight to
  the target-id + per-mode properties form (composite: share / routing /
  fallback, fusion: weight / role, coordinator: coord / role). Plain
  composite aliases with no per-mode shape skip the properties step, as
  before.
- **"Add model entry"** (`models.<category>` → Add model entry) replaces
  the single key prompt with a small form collecting model key, alias
  (upstream model id), and an optional base_url override, so the new row
  is immediately useful instead of seeded with blanks. Wildcard keys
  (`*`, `gpt-*`) are still allowed.
- The per-mode target-property fields and the cfg builder were extracted
  into shared module-level helpers (`compositeTargetFieldsHtml`,
  `buildCompositeTargetCfg`) so the alias wizard and the new target
  wizard cannot drift on field shape.
- Side fix: new model entries are now written with the correctly-shaped
  array (`[alias]` or `[alias, base_url, '']`) instead of the previous
  `['', '']` 2-element seed, which the backend config validator rejects.
  The old prompt path would have produced a row that failed validation
  on save once the user typed anything into it.
- The now-dead `promptAliasMode` helper has been removed.

### Fix: inline-table model entries now accept canonical key aliases

`[models.*]` inline-table entries (e.g. `"glm-5.2-a" = {target = "...", ...}`)
previously only parsed the short keys `mode` / `base_url` / `api_key`. Setting
the canonical `upstream_mode` (which the rest of the codebase and the category
sections use) was silently ignored, so a per-model override had no effect and
the model fell back to the category's `upstream_mode` — surfacing as 404s when
a model's `base_url` was an Anthropic-format host but the section defaulted to
`openai-completions`. The parser now accepts both forms, with the canonical
`upstream_mode` / `base_url` / `api_key` winning when both are present:

- `upstream_mode` | `mode`
- `base_url` | `url`
- `api_key` | `key`

### Feature: `ensure_tool_config_cache_ttl` builtin (system → injection points)

The `ensure_tool_config_cache_ttl` builtin now translates Anthropic-native
prompt caching on the system prompt into the litellm/Bedrock-bridge
convention. It reads `cache_control` from `body.system` content blocks (the
array-of-blocks shape — a plain-string `system` is ignored) and appends a
`{location:"tool_config", control:{...}}` entry to
`body.cache_control_injection_points` when no `tool_config` entry already
exists (caller-provided entries win). The serialized body is reordered so
`cache_control_injection_points` lands after `tools`.

No-op when `system` is absent, is a plain string, or carries no block-level
`cache_control`. Attach via the existing `[transforms.bedrock_tool_cache_ttl_compat]`
set on any bedrock-via-litellm route that uses system-prompt caching. See
[docs/transforms-reference.md](./docs/transforms-reference.md).

### Fix: TOML save path now preserves `[transforms.*]` and `[transform_defaults]`

`serializeProxyConfigToml` (used by `persistProxyConfigToPath`, which backs
every TUI and dashboard-driven config save) had no branch for `transforms` or
`transform_defaults`. As a result, any edit through the TUI or dashboard
silently dropped every `[transforms.<name>]` section and the
`[transform_defaults]` table on save. On reload, `[models.*]` entries still
referenced transform-set names that no longer existed, so `validateAllTransforms`
emitted per-reference errors and transform resolution produced empty sets.

The fix adds serialization for transforms (schema, per-hook `ops`/`builtins`,
`anthropic_beta_map`) and `transform_defaults`, and extends the round-trip
integrity check in `persistProxyConfigToPath` to assert transform-set names and
`transform_defaults` keys survive — so this class of silent loss is now caught
at save time.

Known pre-existing gap (not addressed here): `parseSimpleToml` has no branch
that consumes `before_upstream.headers.set` / `headers.remove` (or the
`response_egress` equivalents). The engine reads these fields
(`applyHeaderTransforms` in `src/utils/request-transform.ts`), but they cannot
currently be expressed in TOML. The serializer now emits them when present, so
the on-disk form is correct; closing the parse-side gap is tracked separately.

### Fix: config validator accepts `sdk://` `base_url`

`validateProxyConfig` previously rejected any non-`http(s)` scheme in
`default_upstream.default_base_url`, `[models.*].base_url`, and per-model
overrides. This flagged valid `sdk://` entries (e.g.
`models.free.llama3.base_url = "sdk://chatjimmy.ai/api"`) as
`base_url must use http or https protocol, got: sdk:`. The `sdk://` scheme is
a project-internal convention rewritten to `https://` at request time by
`src/utils/sdk-handler.ts`, so it is now accepted alongside `http`/`https`.
Added a positive `sdk://` unit test; the existing `ftp://bad` rejection case
still holds.

### Tests: unit coverage for `hash-detect.ts`, handlers, `config-loader.ts`, `validation.ts`

Closed the largest coverage gaps flagged in the test-coverage review by adding
four unit-test files:

- **`tests/unit/hash-detect.test.ts`** (47 cases) — full coverage of the
  security-sensitive redaction scanner: `shannonEntropy`, `detectHashPriority`
  (HIGH/LOW/NO branches, hexspeak whitelist, ordered-sequence filter, entropy
  threshold, custom minLen), `detectB64Priority` (length floor, pure-hex skip,
  entropy bar), `findHashSpans` (hex+b64 merge, overlap dedupe, left-to-right
  ordering), and `buildWhitelist` (add/remove, file ingestion, comment
  stripping, short/non-hex entry filtering).
- **`tests/unit/handlers.test.ts`** (30 cases) — covers the exported pure
  transformation helpers from the four big handlers: `completionsToClaudeBody`
  (system extraction, tool_calls/tool_result grouping, reasoning_content→
  thinking, tool mapping, stop normalization), `completionsToResponsesBody`
  (instructions lift, input_text/output_text, function_call/output mapping,
  passthrough fields), `claudeJsonToSyntheticCompletions` (text/tool_use/
  thinking conversion, finish_reason mapping, usage totals), and
  `isGeminiRequest` (path/URL classification).
- **`tests/unit/config-loader.test.ts`** (103 cases) — covers `parseHumanTokenLimit`,
  `formatTokenLimit`, `normalizeHookAlias`, `parseSimpleToml` (all sections +
  inline tables, multi-line arrays, legacy aliases, `anthropic_beta_map`),
  `validateTransformSet`/`validateAllTransforms`, `getModelConfig`
  (exact/wildcard/default-catch-all precedence), `getModelRouteConfig`
  (direct/composite/schedule resolution + cycle detection + wildcard
  substitution), `validateProxyConfig` (model/composite/schedule/base_url
  rules), `getModelNamesInConfig`, `findAliasNameConflicts`/
  `stripConflictingAliases`, self-referencing composite target detection,
  `getConfiguredModelIds`, `getAllowedHostsFromConfig`,
  `getCompositeAliasMode`, and `resolveScheduleTarget` (hour/weekday/weekend
  matching).
- **`tests/unit/validation.test.ts`** (95 cases) — covers every public function in
  `validation.ts`: `validateClaudeMessagesRequest` (required fields, numeric
  bounds, `stop_sequences`/`metadata`/`stream`), `validateClaudeMessage`,
  `validateClaudeContent`, every branch of `validateClaudeContentBlock`
  (text/image-base64/image-url/document/tool_use/tool_result/thinking/
  web_search_result), `clampThinkingBudget` (incl. interleaved-thinking
  exception and the `max_tokens < 1024` throw), `validateThinkingConfig`,
  `validateClaudeTokenCountingRequest`, `validateModelsRequestParams`,
  `validateOpenAICompletionsRequest`, and `validateAuthHeaders`.

The full network/streaming request paths in the four handlers remain covered
by the integration suite in `./testcases`; these unit tests target the
deterministic conversion logic that is hard to localize from integration
failures alone. Total unit-test count rises from 309 to 584, all passing.

### Feature: `filter_anthropic_beta` builtin + `anthropic_beta_map` config

Claude Code sends `anthropic-beta: header1,header2,...` to enable experimental
features. Upstreams that don't understand a given flag reject the request with
`invalid beta flag`. Following the model in
[docs/claude-beta-headers.md](./docs/claude-beta-headers.md) (mirrored from
LiteLLM's `anthropic_beta_headers_config.json`), this proxy now supports a
per-set allow/map table so operators can keep only the flags a given upstream
supports, and optionally rename them (e.g. Bedrock maps
`advanced-tool-use-2025-11-20` → `tool-search-tool-2025-10-19`).

**New builtin** `filter_anthropic_beta`, attached at `before_upstream`. Reads
the `anthropic-beta` request header (comma-separated form), filters each entry
through the owning set's `anthropic_beta_map`:
- entry not in the map → dropped (allowlist semantics);
- map value `""` (TOML's spelling of null) → dropped;
- map value is a non-empty string → emitted under that mapped name.

When no entries survive, the header is removed entirely.

**New config field** `anthropic_beta_map` on `[transforms.<name>]`:

```toml
[transforms.bedrock_beta_compat]
schema = "anthropic-messages"
anthropic_beta_map = {"computer-use-2025-01-24" = "computer-use-2025-01-24", "advanced-tool-use-2025-11-20" = "tool-search-tool-2025-10-19", "unsupported-feature" = ""}
before_upstream.builtins = ["filter_anthropic_beta"]
```

See [docs/transforms-reference.md](./docs/transforms-reference.md) §
`filter_anthropic_beta`.

**Bug fix — `before_upstream` header transforms were discarded.** Every
`before_upstream` call site destructured only `{ body }` from `runHook(...)` and
threw away the returned `headers`, so the existing `headers.set` /
`headers.remove` knob had no effect since it was introduced. All twelve call
sites in `handlers/{messages,chat-completions,responses,openai,gemini,claude}.ts`
now capture `headers` back and thread it into the upstream `fetch()`. This was a
prerequisite for `filter_anthropic_beta` (which mutates headers) and also fixes
the pre-existing `headers.set`/`headers.remove` mechanism.

### Rename: canonical hook names `endpoint_readin`/`endpoint_writeout` → `request_ingress`/`response_egress`

The transform-hook names `endpoint_readin` and `endpoint_writeout` were opaque
jargon (a prior review at `docs/review_of_transforms_hooks_implementation.md`
flagged this). They are now renamed to the self-describing
`request_ingress` / `response_egress` everywhere: TypeScript types
(`TransformSet`, `HookPoint`, `HookKey`), runtime keys, validator, error
messages, README, `docs/transforms-reference.md`, `proxy_config.example.toml`,
`proxy_config.transforms.example.toml`, and tests.

**Backwards compatibility**: `endpoint_readin` and `endpoint_writeout` remain
accepted as legacy aliases in `proxy_config.toml` — the existing
`normalizeHookAlias()` mechanism was simply flipped so the alias direction now
maps old → new canonical. Existing configs continue to load unchanged. The
`HOOK_KEYS` parser set still contains both names.

The other three hooks (`before_conversion`, `before_upstream`, `after_upstream`)
are unchanged — they had no aliases and still don't.

### Feature: schema-aware tool-arg coercion on the `:generateContent` egress path

Antigravity's Gemini endpoint validates the model's tool calls against each
tool's Go argument struct. Weak-model tool calling on `deepseek-v4-*` produced
JSON type mismatches — most commonly a scalar where an array is declared —
which Antigravity rejected as `invalid tool call error (invalid_signature)
… cannot unmarshal string into … of type []string`. See
[docs/review_of_antigravity_gemini_with_ds_tools.md](./docs/review_of_antigravity_gemini_with_ds_tools.md)
(§ "Optional fix — schema-aware egress type-coercion pass").

The proxy now coerces tool-call args against the inbound tool schema at the
single egress converter, following the existing per-request-state convention:

- `src/converters/openai-to-gemini.ts` — new `geminiToolSchemas`
  `Map<requestId, Map<name, schema>>` (mirrors `geminiToolCallBuffers`), with
  `registerGeminiToolSchemas` / `clearGeminiToolSchemas`. `coerceArgsToSchema`
  is **coercion-only**: scalar→array wrap (recursing into `items`),
  scalar↔string, numeric-string→number/integer, `"true"`/`"false"`→boolean.
  It never fabricates missing required args and never drops unknown keys —
  uncoercible values pass through so the upstream can still reject honestly.
- `src/handlers/openai.ts` — registers `{name → parameters}` from
  `requestBody.tools[].functionDeclarations` at inbound, clears in
  `clearGeminiSSEState` (streaming + `finally` leak-guard) and on the
  non-streaming `generateContent` path.

Scope is deliberately narrow: it fixes the `[]string`-style unmarshal
rejections but leaves the omitted-required-arg errors (`Query is required`,
`TargetFile not found`, …) untouched, since fabricating those would violate
fail-loud (CLAUDE.md rule #8). Verified: the previously-failing
`multi-agents-test.py 2 1 3` run (`deepseek-v4-anth`, task `stale_or_dead_tests`)
now completes successfully.

### Fix: DeepSeek thinking-mode round-trip on the Gemini endpoint path

Requests entering via `/v1beta/models/<alias>:streamGenerateContent` and
forwarded to a DeepSeek upstream failed with HTTP 400 on any turn that replayed
a prior assistant tool call:

- `deepseek-v4-comp` (openai-completions): `The reasoning_content in the
  thinking mode must be passed back to the API.`
- `deepseek-v4-anth` (anthropic-messages): `The content[].thinking in the
  thinking mode must be passed back to the API.`

DeepSeek requires the reasoning/thinking block to be **present** (an empty
placeholder is accepted; no signature exists on its API) on assistant turns
that carried tool calls — the earlier "strip it" hypothesis was exactly
backwards. Antigravity's Gemini SDK replays thoughts without `thoughtSignature`,
so the real block can't be replayed, but an unsigned/empty one satisfies the
upstream. See
[docs/review_of_antigravity_gemini_with_ds_tools.md](./docs/review_of_antigravity_gemini_with_ds_tools.md).

Two `src` fixes:

- `src/handlers/openai.ts` — `forwardCompletionsAsAnthropicMessages` now
  ensures a leading `{type:'thinking', thinking:''}` block on every assistant
  message that has `tool_use` but no thinking block. The comp path is handled
  by a `default` transform op that sets `reasoning_content = ""`.
- `src/utils/config-loader.ts` — the custom `parseSimpleToml` gained
  bracket-counting multiline-array accumulation, so transform `*.ops = [ … ]`
  arrays spanning multiple physical lines are parsed (previously silently
  dropped, which also disabled `max_tokens_rename` and friends).
  `messages[role=assistant].reasoning_content` was added to
  `SCHEMA_PATHS['openai-completions']` so the op validates at load time.

Separately documented (no code change): the `invalid_signature` /
`invalid_args` tool-call errors seen in the same runs are Antigravity's
client-side validation of the model's own malformed tool calls, not a proxy
defect — the proxy preserves tool schemas and arg names intact through the
conversion chain.

### Fix: transport errors sanitized and mapped to 502 / 504

When an upstream `fetch()` rejects at the transport layer (DNS failure,
connection refused, TLS error, abort/timeout, malformed URL), the outer
request catch in `src/index.ts` previously returned **HTTP 500** with the
raw `error.message` echoed verbatim to the client. That message routinely
contains internal hostnames, ports, and filesystem paths from the underlying
socket error (e.g. `getaddrinfo ENOTFOUND internal-host.local:443`),
leaking infrastructure details.

Two new behaviors in `src/utils/errors.ts`:

- **`classifyTransportError(error)`** inspects the thrown error's `code`,
  `cause.code`, and `name` to distinguish failure modes. Node's `fetch`
  wraps every rejection as `TypeError: fetch failed`, so the real signal
  lives on `error.cause.code` (`ENOTFOUND`, `ECONNREFUSED`,
  `ECONNRESET`, `ERR_INVALID_URL`, …) or on `error.name`
  (`AbortError` / `TimeoutError`).
- **`createErrorResponse`** now calls the classifier when handed a plain
  `Error` with no explicit `customStatus`. The result:
  - DNS / connection / TLS / URL failures → **502** `upstream_unreachable`,
    message `"Upstream service unreachable"` (or `"Upstream URL is invalid"`
    for `ERR_INVALID_URL`).
  - abort / timeout → **504** `upstream_timeout`, message
    `"Upstream request timed out"`.
  - Anything that doesn't match the transport signatures falls through to
    the previous 500 behavior.

Sanitization is gated on `customStatus === undefined`, so the many call
sites that pass an explicit status with a hand-crafted message
(`createErrorResponse(new Error('Authentication failed.'), rid, 401)`,
the 413 body-too-large path, etc.) keep their crafted client-facing message.
`ClaudeProxyError` (which already carries a sanitized message via
`handleTargetApiError`) is also untouched. The original raw error message
remains in the server log via the existing `logger.error` line in the outer
catch.

The same classifier is also applied at the top of the composite / schedule
retry loop in `src/index.ts` (`runAttempt` catch). Previously the
share-decay branch was gated on `error instanceof ClaudeProxyError`, so a
target that failed at the transport layer (DNS / refused / TLS / abort)
skipped the penalty — composite routing would keep sending traffic to a
dead target instead of decaying its share toward the floor. Transport
errors are now classified in the catch, so `primary` and `fallback`
targets get their share decayed on 502/504 just as they already did for
upstream-returned 5xx. The retry-warn log line still uses the raw error
message so operators see the real socket error (e.g. `ENOTFOUND`) in logs.

### Change: `base_url` values validated once at config-load time

`validateProxyConfig` (`src/utils/config-loader.ts`) now runs a dedicated
`validateBaseUrls` pass over every `base_url` that will end up in a `targetUrl`
passed to `fetch()`. Previously an invalid `base_url` (e.g. an out-of-range
port like `http://localhost:123456`, or a non-http/https scheme) only failed
when a request actually hit the upstream — surfacing as an opaque 500 from
`new URL()` / `fetch()` throwing synchronously inside the handler.

Sources validated, mirroring `getAllowedHostsFromConfig`:

- `[default_upstream].default_base_url`
- `[models.*].base_url` (category level)
- per-model `base_url` overrides at array index 1 (entries of length 3, 4, 5)

Each invalid value is reported with its config path, so it surfaces through the
same channels as other validation errors: console at startup, dashboard status
bar via `config_errors`, TUI message line via `_validationErrors`, and the
`PUT /dashboard/api/config` 400 response that rejects saves. Empty/whitespace
values are skipped here (they fall back to the category-level URL, which is
validated separately).

### Fix: `/v1/models` falls back to local models when upstream URL is invalid

`handleModelsRequest` (`src/handlers/models.ts`) constructed the upstream URL
via `new URL(targetUrl)` *before* the try/catch wrapping the fetch. When
`targetUrl` was malformed (e.g. an out-of-range port like `123456` from a
misconfigured `[models.default] base_url`), `new URL` threw `Invalid URL`,
which escaped the catch and surfaced as a request error instead of returning
the locally configured model list.

The URL construction and the query-param population (`after`/`before`/`limit`)
are now moved inside the try block, so any malformed-upstream-URL failure falls
through to the existing warn-and-continue path and the response is built solely
from `extraModelIds` via `mergeClaudeModelsResponse`.

### Change: `/v1/models` is now exempt from auth

`GET /v1/models` (and `/v1/models?...`) no longer requires an auth header and
no longer triggers the `auth_url` sidecar. Previously every model-API path
went through the same auth gate (presence check on `Authorization` /
`x-api-key` / `x-goog-api-key`, then the optional `auth_url` validation),
which blocked SDK discovery / model-listing calls that legitimately have no
credential.

The exemption mirrors the existing treatment of `/health`, `/`, and
`/dashboard`: model listing is treated as public metadata.

Behavior change in `src/index.ts`:

- A new `isModelsListPath` flag (`path === '/v1/models' || path.startsWith('/v1/models?')`)
  is added to the auth gate.
- The presence-check failure (`!hasAuth && !devNoKey`) now also skips when
  `isModelsListPath` is true.
- `authUrl` is forced to `''` for the models-list path, so the sidecar call
  is skipped entirely — not just the presence check.

`/dashboard/api/*` writes are unaffected: they are still gated by
`[dashboard].api_key` via `validateDashboardApiAuth`, which runs in a
separate branch and is independent of this gate. All other model-API paths
(`/v1/messages`, `/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`,
`/v1beta/models/*`) keep requiring auth as before.

### Fix: `inject_missing_tool_results` now handles a trailing `tool_use`

The `inject_missing_tool_results` builtin (`src/utils/request-transform.ts`)
had a loop bound of `i < msgs.length - 1` that skipped the final message in
the array. When an assistant message containing `tool_use` blocks was the
**last** message (no following user/`tool_result` message), the builtin did
nothing — forwarding a malformed conversation to DeepSeek's
anthropic-messages endpoint, which rejected it with
`tool_use ids were found without tool_result blocks immediately after`.

This is exactly the Codex flow: Codex replays the model's prior
`function_call` as the final input item, and the proxy's
`completionsBodyToClaudeBody` converter emits a trailing
`assistant(tool_use)` with no following user message.

The loop now visits every index. When a tool_use assistant has no following
user message, a consolidated `user` message with one placeholder
`tool_result` per unmatched id is appended. The same reordering logic
already used for the non-trailing case (constraint A: text-only assistants
move after the tool_result message) applies.

Also wired the builtin to `deepseek-v4-anth` in `proxy_config.toml` via a
new `deepseek_v4_anthropic_compat` transform set — previously the config
declared no `[transforms.*]` sections, so the builtin was inactive even
though it existed.

One existing unit test ("does not synthesize when the assistant is followed
by another assistant") codified the old, broken behavior. It is replaced by
a test asserting the corrected behavior: synthesis happens and the
text-only assistant is reordered after the synthesized `tool_result`.

### Fix: strip stale `content-encoding` from pass-through responses

Node's `fetch` (undici) auto-decompresses gzip/deflate/br upstream bodies but
leaves the original `content-encoding` and `content-length` headers on the
`Response`. Any handler that re-wrapped the (already-decompressed) body with
the copied upstream headers produced a Response whose headers claimed gzip
while the bytes were plain text. Clients using strict gzip decoding (e.g. the
TUI's own `fetch` call in `runModelTest`) then crashed with
`TypeError: terminated` / `Z_DATA_ERROR: incorrect header check`. The most
visible symptom: testing `glm-5.2-a` (mode = `anthropic-messages`,
`open.bigmodel.cn/api/anthropic` returns gzip) from the TUI always showed
`test failed glm-5.2-a (?) terminated`, while `curl` (lenient) succeeded.

**Two-layer fix:**

1. **Boundary strip in the Node adapter** (commit `f629c67`):
   `src/server.ts` — the non-streaming response path at line 136 was using
   `Object.fromEntries(response.headers.entries())`, which forwarded the
   stale `content-encoding: gzip` to the Node `http` response while
   `response.clone().text()` had already decompressed the body. Changed to
   use the existing `nodeResponseHeaders()` helper (which the streaming path
   at line 110 already used), stripping `content-encoding` + `content-length`
   consistently at the process boundary. This alone resolved the
   user-visible symptom for every code path.

2. **Defense-in-depth across internal handlers**: even with the boundary
   fixed, internal `Response` objects still had headers that disagreed with
   their bodies — a landmine for any future internal consumer (dev
   passthrough, transform hooks, response re-wrapping). Added
   `sanitizeUpstreamResponseHeaders(response)` to `src/utils/routing.ts`
   (strips `content-encoding` + `content-length`, returns a fresh `Headers`)
   and applied it at the 11 sites that build a new `Response` from a
   decompressed body with copied upstream headers:
   - `src/handlers/claude.ts` — streaming pass-through (L189) and
     non-streaming pass-through (L220) in `handleClaudeRequest`.
   - `src/utils/request-transform.ts` — `applyAfterUpstream` non-JSON
     fallback (L463) and JSON path (L478); `applyWriteoutBody` non-JSON
     fallback (L550) and JSON path (L568).
   - `src/index.ts` — `restorePrivacyResponse` streaming (L186) and JSON
     (L192); `endpoint_writeout` SSE rewrite (L2254); `endpoint_writeout`
     header-ops seed (L2270, also sanitizes the headers *before* feeding
     them into transform hooks); `applyCorsHeaders` (L280).

**Scope of the original bug:** any model with `mode = "anthropic-messages"`
whose upstream returns gzip and that went through `handleClaudeRequest`
non-streaming was affected. From the shipped config that was `glm-5.2-a`
(`open.bigmodel.cn/api/anthropic`). `openai-completions` models
(`minimax-*`, `deepseek-*`, etc.) were unaffected because their handlers
build a fresh `Response` with explicit clean headers after parsing the body.

**Files changed:**
- `src/server.ts` — non-streaming path now uses `nodeResponseHeaders()`
  (commit `f629c67`).
- `src/utils/routing.ts` — new exported
  `sanitizeUpstreamResponseHeaders(response)` helper.
- `src/handlers/claude.ts`, `src/utils/request-transform.ts`,
  `src/index.ts` — apply the helper at the latent re-wrap sites.

### Feat: make `wrangler` an optional peer dependency

Wrangler is only needed for Cloudflare Workers deployment (`npm run dev` /
`npm run deploy`). The Node server path (`npm run server`, Docker image,
`dist/server.js`) does not use it. Previously it was listed in
`devDependencies` and got auto-installed for everyone.

**What changed:**
- Moved `wrangler` from `devDependencies` to `peerDependencies` with
  `peerDependenciesMeta: { optional: true }` in `package.json`.
- Removed the three `sed` lines in `Dockerfile` that stripped `wrangler` from
  `package.json` before `npm install` — no longer needed since optional
  peerDeps are not auto-installed.
- `@cloudflare/workers-types` stays as a `devDependency` (still needed at
  build time by `tsconfig.server.json` to type the shared fetch handler in
  `src/index.ts`).

**Impact:**
- Node-only / Docker users no longer pull wrangler on `npm install`.
- Cloudflare Workers users must run `npm install wrangler` before
  `npm run dev` / `npm run deploy`. Without it, npm exits with
  `command not found: wrangler`.

**Files changed:**
- `package.json` — added `peerDependencies` + `peerDependenciesMeta`; removed
  `wrangler` from `devDependencies`.
- `Dockerfile` — removed the `RUN sed -i ...` block.
- `README.md` — reduced wrangler mentions from 2 to 1.

### Fix: dashboard UI tightening — narrower inputs and TUI label cleanup

**Dashboard:**
- `share` input box: narrowed to 60px in both the wizard modal and composite target rows.
- `upstream_mode` select: narrowed to 180px (previously used `class="wide"` spanning 2 grid columns).
- `token_limit` duration select: narrowed to 100px.
- `Add window` button: indented 16px to align with the "days" select in schedule window rows.
- Added `.sched-window-row` CSS for consistent window row layout (previously only inline).
- `.danger` button: slightly lighter red tint for better contrast.

**TUI:**
- Composite target row: changed `non-FB` label to `Fallback` when `fallback: 0`.

**Files changed:**
- `src/handlers/dashboard.ts` — input/select widths, Add window alignment, CSS additions.
- `src/tui.ts` — `non-FB` → `Fallback`.

### Feat: TUI/dashboard support for `coordinator` composite aliases

Builds on the `coordinator` composite mode (see entry below). The proxy itself
already routed `planner`/`executor` targets — this round wires the editor UX
so users can see, edit, create, and delete coordinator aliases from the TUI and
the web dashboard without hand-editing `proxy_config.toml`.

**What you see:**
- Composite aliases in the main TUI views and the `Edit Composite Aliases Config`
  overlay now render an `[O]` tag for coordinator aliases (alongside the
  existing `[F]` for fusion and `[C]` for plain share/primary/fallback).
- The Test-custom-model picker shows `[O]` / `[F]` / `[C]` per alias and groups
  all three at the top of the list.
- In `proxy_config.toml`, each coordinator target now renders as
  `coord:1 planner` (or `executor`) on its row in the editor overlay.

**Editing:**
- The TUI edit prompt for a coordinator target now shows `[p]lanner / [e]xecutor
  [coord]`; defaults to `p` or `e` based on the existing role. Both `p`/`e`
  short forms and the full `planner`/`executor` words are accepted.
- The dashboard's coordinator `<select>` renders `[p]lanner` / `[e]xecutor`
  (canonical `planner`/`executor` values are persisted to TOML).
- TUI/dashboard fusion editing mirrors the same convention:
  `[p]anel / [j]udge / [s]ynth [weight]`, default `p 1`, accept `p`/`j`/`s`.

**Creating / converting empty aliases:**
- TUI `A` (add alias) and `M` (add target on an empty alias like `xxx`/`yyy`)
  now route through a new `Mode for <alias>` picker — choose `composite`,
  `fusion`, or `coordinator` first, then proceed to the model picker. The
  chosen mode seeds the first target's fields so `getCompositeAliasMode`
  picks up the right mode on subsequent edits.
- Dashboard `Add composite alias` and `Add target` (on an empty alias) use
  the same numbered-choice prompt. For coordinator, the dashboard also asks
  for a planner target at creation time so the alias is immediately usable.
- The TUI previously fell through to plain composite for empty aliases (since
  `getCompositeAliasMode` returns `'share'` rather than `undefined` for them).
  Now the mode picker fires before the model picker.

**Deleting an alias:**
- TUI `D` on an alias line (not just on a target row) now opens a
  "Delete composite alias `<alias>`?" confirmation and removes the alias via
  `removeCompositeAliasFromDashboard`. The toolbar hint `D del` already
  covered both cases.

**Backend plumbing:**
- `src/utils/config-loader.ts` — `CompositeTargetPatch.coord` added;
  `upsertCompositeTarget` now writes `coord` (mirrors the existing `fusion`
  handling: `null`/`0` deletes, must be a finite non-negative number); role
  validation now also accepts `'planner'`/`'executor'`.

**Bug fix in passing:**
- Newly-added `window.prompt(...)` strings in `handleDashboardPage` had to use
  `\\n` (not `\n`) so the outer HTML template literal doesn't collapse the
  escape into a real newline — which would break the inner JS single-quoted
  string literal at parse time (`SyntaxError: Invalid or unexpected token`).
  Fixed at `promptAliasMode()` and the coordinator role prompt in
  `add-composite-target`.

**Files changed:**
- `src/utils/config-loader.ts` — `CompositeTargetPatch.coord`,
  `upsertCompositeTarget` coord handling, role validation list.
- `src/tui.ts` — `getCompositeAliasMode` import; `[O]` tag in alias summary,
  custom-models list, model-test picker; coordinator target summary;
  `openModePicker`; `openAddAliasPrompt` mode-routing; `openTargetPicker`
  empty-alias detection (now uses the alias's own keys, not `getCompositeAliasMode`)
  + `forceMode` argument; coordinator add/edit prompts with `p`/`e` short
  forms; fusion prompts with `p`/`j`/`s` short forms; `openDeleteAliasConfirm`
  and `D`-on-alias handler; `removeCompositeAliasFromDashboard` import.
- `src/handlers/dashboard.ts` — `promptAliasMode()` helper;
  `add-composite-alias` mode pick + planner seed for coordinator;
  `add-composite-target` empty-alias mode pick + role pick (with
  `1`/`2`/`p`/`e`); coordinator `<select>` labels; fusion `<select>` labels.

---

### Feat: transforms — hook aliases, reference doc, debug log

Three usability improvements from the transforms/hooks review:

1. **Backward-compatible hook name aliases** (`src/utils/config-loader.ts`).
   `request_ingress` is now accepted as an alias for `endpoint_readin`, and
   `response_egress` as an alias for `endpoint_writeout` in `proxy_config.toml`.
   Both are normalized to the canonical name at config load time; the runtime
   engine and TypeScript types are unchanged. Old names continue to work as-is.

2. **`docs/transforms-reference.md`** — a single-page cheat sheet with three
   tables: hooks (name, alias, when, schema, side), Tier-1 ops (op, fields,
   effect, example), and Tier-2 built-ins (name, schema, what it does).
   Also documents the 5-element model array wire format and default-resolution
   order. Supersedes having to read the design doc for day-to-day authoring.

3. **DEBUG log line per request** (`src/index.ts`, `src/utils/request-transform.ts`).
   When `LOG_LEVEL=debug`, one line is emitted per request for any route that has
   transforms configured, showing the resolved set names and per-hook op/builtin
   counts:
   ```
   [req_…] [DEBUG] transforms: endpoint_readin=[deepseek_compat:b=1] before_upstream=[deepseek_compat:b=1,ops=1]
   ```
   `b=N` = N built-ins, `ops=N` = N Tier-1 ops. Only hooks with active ops are listed.
   Zero runtime cost when `LOG_LEVEL` is `info` or higher.

---

### Fix: transforms — `endpoint_readin` mutations discarded, and passthrough/generateContent paths never ran transforms

Antigravity agents routed to `deepseek-v4-anth` (DeepSeek's `anthropic-messages`-compatible
endpoint) failed on tool-using turns with
`Invalid schema for function 'glob_tool': "STRING" is not valid under any of the schemas
listed in the 'anyOf' keyword`. DeepSeek requires lowercase JSON-schema types
(`"string"`), but Gemini/proto-style tool schemas arrive with uppercase (`"STRING"`).
Three root causes:

1. **`endpoint_readin` change-detection was always false** (`src/index.ts`). Builtins/ops
   mutate the body object *in place*, so `runHook` returns the same reference. The guard
   `if (transformed.body !== parsedBody)` never fired, so the mutated (lowercased) body was
   discarded and the original forwarded upstream. Now always rebuilds the request from the
   transformed body. **This affected every `endpoint_readin` transform on every route**, not
   just this one — they silently no-op'd.

2. **Passthrough and generateContent paths bypassed transforms** (`src/index.ts`). The
   `/v1/chat/completions` passthrough (LocalOpenAIAgentConfig transport) and
   `:generateContent` (GeminiAPIEndpoint transport) paths dispatch through the final
   `runAttempt` with no `route`, so the hook never fired. The resolved route is now hoisted
   (`outerRoute`) and threaded into that `runAttempt`.

3. **`lowercase_tool_schema_types` skipped composition keywords**
   (`src/utils/request-transform.ts`). It only recursed into `properties`/`items`, so a
   `{type:"STRING"}` nested inside `anyOf`/`oneOf`/`allOf` (as in `glob_tool`) survived
   uppercase — exactly what the error named. Now recurses into all three.

**Config wiring** (`proxy_config.toml`): attached `deepseek_v4_anthropic_compat` to the
`deepseek-v4-anth` entry (it was defined but orphaned — resolving zero transforms) and added
`lowercase_tool_schema_types` to its `endpoint_readin.builtins`.

**Files changed:** `src/index.ts`, `src/utils/request-transform.ts`, `proxy_config.toml`.

### Fix: Antigravity/Gemini + local OpenAI agents — parallel tool calls corrupted through `anthropic-messages` streaming

Antigravity agents (`transport=GeminiAPIEndpoint` and `transport=LocalOpenAIAgentConfig`)
routed to `max-m3-anth` (MiniMax `anthropic-messages`, targeting `MiniMax-M3`) failed on
tool-using turns. Two root causes in `src/handlers/openai.ts`:

1. **Tool-call index collision.** When converting Anthropic SSE → Gemini, each completed
   `tool_use` block was emitted with a hardcoded `tool_calls[].index = 0`. Multiple parallel
   tool calls in one turn therefore collided in `geminiToolCallBuffer`, concatenating
   different tools' argument JSON into one string → `invalid_args`. Now uses the Anthropic
   content-block index.

2. **`message_delta` never flushed buffered tool calls.** The Anthropic `message_delta`
   finish event emitted a Gemini `finishReason` directly instead of routing through
   `processSSEBuffer`, so tool calls buffered at `content_block_stop` were never emitted.
   Now routes a synthetic finish chunk through `processSSEBuffer` to trigger its flush logic.

Additionally, the module-level single-flight SSE buffers (`anthropicToolBuffers`,
`anthropicThinkingBuffers`, `thinkStreamBuffer`, `geminiToolCallBuffer`) were made
per-request (keyed by `requestId`). Concurrent streams (parallel sub-agent tool calls)
interleave on the event loop across `await reader.read()`, so shared buffers corrupted
unrelated requests. Added `clearAnthropicSSEState`/`clearGeminiSSEState` cleanup on
`message_stop`/`[DONE]` and in stream-handler `finally` blocks to prevent leaks on error.

**Files changed:** `src/handlers/openai.ts`.

(Ported from `feature/fusion` commit `3182231`. The thinking/`reasoning_content`
round-trip parts of that commit — in `claude-to-openai.ts`, `openai-to-claude.ts`, and
`claudeJsonToSyntheticCompletions` — were already present on this branch.)

### Feat: `coordinator` composite mode (prewalk pattern)

New composite alias strategy that routes a conversation through **two models in
sequence**: a capable `planner` model handles requests during the planning stage,
then the proxy switches to a faster/cheaper `executor` model once the first
trigger tool call appears in the accumulated message history — reusing the full
context without re-reading anything. Mirrors the prewalk pattern from oh-my-pi.

**Config shape** (`[composite]`):

```toml
"smart-coder" = {
  "deepseek-v4-pro"   = {coord = 1, role = "planner"},
  "deepseek-v4-flash" = {coord = 1, role = "executor"},
  toolset = ["ExitPlanMode", "Edit", "Write"]
}
```

Each coordinator participant carries `coord = 1` and `role = "planner"` or
`"executor"`. The top-level `toolset` key lists trigger tool names:

| `toolset` value | Behaviour |
|---|---|
| absent | Use default set: `ExitPlanMode`, `Edit`, `Write`, `Bash`, `NotebookEdit` |
| `["Edit", "Write"]` | Only those tool names trigger hand-off |
| `[]` (empty) | Any tool call triggers hand-off |

Role targets may be direct model names, `[models.*]` aliases, `[schedule]`
aliases, or other `[composite]` aliases of any mode (resolved through the full
`getModelRouteConfig` chain; cycle detection applies).

**Files changed:**
- `src/utils/config-loader.ts` — `FusionRole` extended with `'planner'|'executor'`;
  `CompositeTargetConfig.coord`, `CompositeModelConfig.toolset`, `CoordinatorPlan`,
  `COORDINATOR_DEFAULT_TRIGGER_TOOLS`, `resolveCoordinatorPlan` added;
  `getCompositeAliasMode` now returns `'coordinator'` (highest precedence);
  parse/serialize/sanitize updated.
- `src/utils/coordinator.ts` — new file: `detectCoordinatorStage(messages, triggerTools)`.
- `src/index.ts` — coordinator dispatch block inserted before fusion routing.
- `tests/unit/coordinator.test.ts` — 27 unit tests (all passing; 23 originally landed with the feature, plus 4 config-round-trip cases added during finalization).

### Fix: `/v1/responses` → `anthropic-messages` — out-of-order `function_call`/text items produced consecutive assistant messages

Codex CLI routed through `max-m3-anth` (MiniMax's `anthropic-messages`-compatible endpoint,
targeting `MiniMax-M3`) failed on turn 2+ of a tool-using conversation with
`invalid params, 400 (2013)`.

Codex replays a prior turn's `function_call` item *before* the assistant `message` item
containing the text that preceded it in the original turn. `convertInputItemsToMessages`
(`src/converters/responses-to-completions.ts`) converted each input item independently and
in order, so this produced two consecutive `assistant`-role messages (`tool_use` then `text`)
before the `tool_result`. The Anthropic Messages API requires strict role alternation and a
`tool_use` block's `tool_result` to immediately follow the single message that emitted it —
MiniMax rejected the malformed shape with error 2013.

**Fix:** `convertInputItemsToMessages` now merges a `function_call` and any adjacent assistant
`message`/`reasoning` items belonging to the same turn — regardless of their order in the
`input` array — into a single assistant message carrying both `content` (text) and
`tool_calls`.

**Files changed:** `src/converters/responses-to-completions.ts`.

### Fix: thinking/reasoning round-trip for streaming, non-streaming, and Gemini paths

Surfaced by multi-agent live run (`tests/multi-agents-test.ts`, Claude + Gemini agents × `deepseek-v4-comp` / `deepseek-v4-anth`). Three converter bugs caused thinking-mode responses to drop `reasoning_content` on the way back to the client, breaking subsequent multi-turn requests that require the reasoning to be passed back.

**Bug 1 — `src/converters/streaming.ts`: `reasoning_content` gated behind `includeThinking` flag**

`delta.reasoning_content` (DeepSeek auto-thinking in streaming mode) was only forwarded as a `{type:'thinking'}` SSE block when `includeThinking` was set. Claude/Gemini agent SDKs never set that flag, so streaming thinking content was silently dropped.

Fix: removed the `if (includeThinking)` guard from the `reasoning_content` / `delta.reasoning` branch — `reasoning_content` is now always forwarded unconditionally. The flag continues to gate only the legacy `<think>` tag extraction path.

**Bug 2 — `src/converters/openai-to-claude.ts`: `reasoning_content` ignored in non-streaming path**

`convertOpenAIToClaudeResponse` iterated only `message.content`; `message.reasoning_content` from DeepSeek's non-streaming response was silently ignored, so the next assistant turn carried no thinking block.

Fix: a `{type:'thinking', thinking: inlineReasoning}` block is now prepended to `contentBlocks` when `message.reasoning_content` is present, before the text block — matching the order required by `convertClaudeToOpenAIRequest` for round-trip preservation.

**Bug 3 — `src/handlers/openai.ts:claudeJsonToSyntheticCompletions`: thinking blocks dropped**

When converting Anthropic-format responses to synthetic completions (used by the Gemini→Anthropic→Gemini path), `{type:'thinking'}` content blocks were discarded. Downstream converters (`convertOpenAIToGeminiGenerateContent`) therefore never saw `reasoning_content` and could not emit `{thought:true}` parts for the Gemini SDK's history.

Fix: thinking blocks are now collected and joined into a `reasoning_content` field on the synthetic `message`, using the existing `as unknown as Record<string, unknown>` cast pattern.

### Fix: TUI composite target editing — saves blocked by transform validation in parser

Two bugs prevented `Edit Composite Aliases Config` from saving changes to
`proxy_config.toml` and reflecting them in the overlay.

**Bug 1 — `parseSimpleToml` threw on transform errors, blocking every write**
(`src/utils/config-loader.ts`)

The `transforms_hooks` branch added `validateAllTransforms` at the end of
`parseSimpleToml` and threw if any transform set reference was undefined.
`persistProxyConfigToPath` calls `parseSimpleToml(serialized)` for its
round-trip integrity check — so every mutation save (add/edit/delete composite
targets) threw before touching the disk. The error was swallowed by the TUI
`try/catch`, leaving the overlay on stale data with no visible feedback.

Fix: remove the throw from `parseSimpleToml`. The function is a parser used in
multiple contexts; validation belongs only in callers that load config for
active use. Transform errors are now appended to `_validationErrors` (surfaced
in the dashboard status bar) and logged to stderr, but they no longer block
writes.

**Bug 2 — mutation `refresh(true)` silently dropped if a background poll was in-flight**
(`src/tui.ts`)

`DashboardApp.refresh()` bailed out immediately (`if (this.refreshing) return`)
when a concurrent refresh was running. The 500 ms background poll meant this
race was common: save succeeded, `refresh(true)` returned without re-reading the
file, overlay kept the old snapshot.

Fix: added `pendingMutationRefresh` flag. When `refresh(true)` finds
`this.refreshing`, it sets the flag instead of returning silently. The in-flight
refresh checks the flag in its `finally` block and immediately fires another
`refresh(true)` with a forced cache-bust. Additionally, mutation refreshes now
always pass `forceReload = true` to `loadConfig` regardless of the caller's
argument.

**Additional TUI fixes** (`src/tui.ts`)

- Edit prompt for composite targets now pre-fills current `share`/`primary`/
  `fallback` values instead of opening blank.
- Format hint corrected from `input <share> <primary> <fallback>` to
  `share [primary] [fallback]`.
- After validation errors in the edit prompt, `focusAlias` and `requestRender`
  are now called (matching the add-target path) so the composite overlay regains
  focus.
- Removed a leftover `console.error('[DEBUG] handleInput: ...')` that spammed
  stderr on every keypress in the composite overlay.

### Fix: Anthropic tool_use/tool_result pairing injection (Step 15)

Multi-agent live test (`tests/multi-agents-test.ts`, Codex agent × `deepseek-v4-anth`) surfaced:

```
messages.10: `tool_use` ids were found without `tool_result` blocks immediately after: ...
```

DeepSeek's Anthropic-compatible endpoint enforces that every `tool_use.id` in an
assistant message is immediately followed by a `tool_result` block in the next
user message. When the Codex SDK sends conversation history where tool results
are missing or out of position, the upstream rejects the request.

**Fix — new `inject_missing_tool_results` Tier-2 built-in**

Runs a single forward pass over the `messages` array. Handles three patterns
(all discovered during multi-agent live verification):

1. **Split-assistant**: the Codex SDK emits one Completions assistant turn as
   two messages — `{tool_calls}` then `"text"`. After conversion these become
   two consecutive assistant messages with the `tool_result` user messages landing
   AFTER the text assistant. We reorder: collect the text-only assistants as a
   tail, insert the consolidated `tool_result` user message immediately after the
   `tool_use` assistant, then re-append the tail. Result:
   `tool_use_asst → user(tool_results) → text_asst`.

2. **Scattered tool_results**: multiple `role:"tool"` Completions messages
   (one per call) become separate user messages. Anthropic spec (and DeepSeek)
   require all tool_results for one turn in a single user message. We merge
   consecutive pure-tool user messages into one.

3. **Missing tool_result**: after the above, if any `tool_use.id` has no
   matching `tool_result`, we synthesize a placeholder block with `content: ''`.

Bound to `deepseek-v4-anth` via a new `deepseek_v4_anthropic_compat` transform set
(`schema = "anthropic-messages"`). The schema-anchor gates application to
anthropic-messages routes only.

**Wiring fix — `handleAsAnthropicMessages` in `src/handlers/responses.ts`**

This handler (`/v1/responses` → `anthropic-messages`) was missing a
`before_upstream` hook call — it built the Anthropic-format body and fetched
directly. Added `route` and `upstreamMode` parameters and wired
`runHook('before_upstream', ...)` before fetch.

**Tests** — 10 unit tests in `tests/unit/request-transform.test.ts`:
text-next insertion, string-content insertion, multiple missing ids,
partial synthesis, all-present no-op, no-tool-use no-op, assistant-not-user no-op,
merge consecutive pure-tool messages, merge + synthesize, split-assistant reorder.

**Verified** — `tests/multi-agents-test.ts 0 0 2` (Codex × `deepseek-v4-anth`):
`tool_use ids were found without tool_result blocks` error no longer reproduces.
All 400 errors remaining are unrelated (thinking round-trip — Step 14).

### Fix: Multi-turn thinking-content round-trip vs DeepSeek thinking-mode

Multi-agent live test on port `7777` (`tests/multi-agents-test.ts`, 4 models ×
all agents × task #2) surfaced repeated `400` responses from DeepSeek upstreams
with:

> `The 'reasoning_content' in the thinking mode must be passed back to the API`
> `The 'content[].thinking' in the thinking mode must be passed back to the API`

Root cause: two conversion paths silently **dropped** prior-turn reasoning
instead of round-tripping it to the wire format the upstream expects.

**Smoking-gun #1 — Claude → OpenAI Completions** (`src/converters/claude-to-openai.ts`)

Both `convertClaudeToOpenAIRequest` and `convertClaudeTokenCountingToOpenAI`
iterated assistant content blocks but had no branch for `type: 'thinking'` —
those blocks were silently discarded. Each now accumulates
`thinkingParts: string[]` alongside `textParts` and `toolCalls` and emits the
joined string as a per-message `reasoning_content` field on the resulting
OpenAI assistant message (via the existing `as unknown as Record<string, unknown>`
cast pattern, matching `responses-to-completions.ts:194-196` and `openai.ts:444`).

**Smoking-gun #2 — OpenAI Completions → OpenAI Responses** (`src/handlers/messages.ts`)

`completionsMessagesToResponsesInput` (function-level, defined inline in
the file) had a `return null` for `thinking` content parts (the prior
shape was a degenerate 5-line helper that produced empty output for the
prior turn's reasoning). Rewritten to:

- Emit a Responses `reasoning` input item with a single `reasoning_text`
  part whenever the source message carries a per-message
  `reasoning_content` field, OR
- Emit the same `reasoning` item whenever an array-style `content` part
  has `type: 'thinking'` (using `part.thinking` as the text), without
  also emitting a redundant text message item.

Both fixes are scoped to round-tripping reasoning — they do not change the
non-thinking path.

**Tests:** new file `tests/unit/thinking-roundtrip.test.ts` (7 cases):

- emits `reasoning_content` on assistant message when a thinking block is present
  (Claude → Completions main converter)
- same for the token-counting converter
- multiple thinking blocks join into a single `reasoning_content` string
- no `reasoning_content` is emitted when there is no thinking block
- inline `reasoning_content` field on the assistant message emits a Responses
  `reasoning` input item (Completions → Responses)
- `content[]` with `{type:'thinking'}` emits the same `reasoning` input item
- no `reasoning` item is emitted when there is nothing to round-trip

165/165 unit tests pass after the change; `npx tsc --noEmit` is clean.

**Live verification (port 7777):**

Direct curl: `POST /v1/messages` to `deepseek-v4-comp` with `thinking.budget_tokens=1024`
and a multi-turn history (turn-2 assistant has `{type:"thinking", ...}` and
`{type:"text", ...}` blocks, turn-3 user asks a follow-up) returns **`200`**.
DeepSeek accepts the request — the prior reasoning round-trips end-to-end. The
proxy response keeps the throwaway `writeout_marker` `id` rewrite
(`"step12_response_path_active"`) to confirm the new build is live.

Multi-agent test (`tests/multi-agents-test.ts 0 0 2`): the prior
`reasoning_content must be passed back` failure mode no longer reproduces on
the same multi-turn shape that triggered it before the fix. Remaining
failures in that run are separate, pre-existing issues and are out of scope
for this entry: Anthropic-format `tool_use`/`tool_result` mismatch on
`deepseek-v4-anth` (different bug — Claude-format pairing invariant), agent
SDK package install errors (`@earendil-works/pi-agent-core` not on disk,
`opencode` binary not on PATH), and Codex-on-`openai-responses` returning
empty output for reasons unrelated to thinking content.

### Fix: Step 13a — validator now rejects unwalkable nested paths

`SCHEMA_PATHS` in `src/utils/config-loader.ts` whitelisted response-side paths
like `$response.choices[].message.content`, `$response.output`, and tool-call
chains such as `messages[].tool_calls[].function.name`. The Tier-1 op runner
(`applyOpToBody` / `parsePath`) can only target a single top-level segment, so
any of those paths would silently produce a literal-bracketed key on the body
when applied — corrupting the response. The validator now performs a
**two-pass** check: first the schema-vocabulary whitelist (already in place),
then a new `isPathWalkable` predicate that accepts only paths the engine can
actually execute:

- `$response.<field>` — single segment, no `.` or `[`
- `messages[].<field>` or `messages[role=X].<field>` — single segment after the
  bracket, no further nesting
- top-level names — single segment, no `.` or `[`

Anything deeper is rejected at load with a clear
`"[<hook>] path \"<…>\" … cannot walk it (nested arrays/objects)"` message that
points authors at the named built-ins (`lowercase_tool_schema_types`,
`recover_tool_message_name`) or a shallow path.

**Tests:**
+6 in `tests/unit/transforms-config.test.ts` covering nested `$response`,
shallow `$response.<field>`, nested `messages[].<sub>`, and the cross-schema
case.
+1 in `tests/unit/request-transform.test.ts` asserting that the engine — even
if a transform slipped past validation — never creates a literal-bracketed
key on a JSON body.

**Regression-checked:**
- `proxy_config.toml` still validates cleanly with zero errors against the new
  predicate (only `$response.id` is in use there, which is shallow and walked).
- `curl /v1/messages` through `deepseek-v4-comp` still rewrites the response
  `id` to `"step12_response_path_active"`; no literal `"$response.id"` field
  appears.

### Verify: Step 12 `$response.*` path resolution confirmed end-to-end

The throwaway `[transforms.writeout_marker]` set in `proxy_config.toml` now uses
`endpoint_writeout.ops = [{ op = "set", path = "$response.id", value =
"step12_response_path_active" }]`. After a fresh `node dist/server.js` on
`:7777`, a `curl /v1/messages` to `deepseek-v4-comp` rewrites the response's
`id` field to `"step12_response_path_active"` without creating a literal
`"$response.id"` field.

**Implementation and tests:**
- `parsePath` recognizes the `$response.` prefix and strips it before applying
  the existing shallow generic operation runner.
- Unit coverage verifies response-side `set`, `rename`, and `remove` operations.
- Nested response paths such as `$response.choices[].message.content` remain
  outside the shallow path runner and are still reserved for a future path-walk
  step.

### Verify: Step 11 `endpoint_writeout` body-op wiring confirmed end-to-end

A throwaway `[transforms.writeout_marker]` set was added to `proxy_config.toml`
with `endpoint_writeout.ops = [{ op = "set", path = "model", value =
"step11_writeout_active" }]`, and attached to `deepseek-v4-comp` via the
inline-table 5th-element `transforms = "deepseek_compat,writeout_marker"`
CSV. After a fresh `node dist/server.js` on `:7777`, a `curl /v1/messages` to
`deepseek-v4-comp` returns `"model":"step11_writeout_active"` — proving the
Step 11 `applyWriteoutBody` path is wired through config → resolver → central
writeout wrap.

**Two collateral fixes surfaced during verification:**

1. **Inline-table parser split on CSV commas inside quoted `transforms` value**
   (`src/utils/config-loader.ts`). The naive `tableBody.split(',')` treated
   `"deepseek_compat,writeout_marker"` as multiple fields. Replaced with a
   quote-aware splitter that tracks `inQuote` and only splits on unquoted
   commas. Multi-element inline-table entries with a CSV 5th field now parse
   correctly.

2. **Section-style `[transforms.<name>]` ops on multi-line arrays were
   silently dropped.** The single-line regex `^([\w.]+)\s*=\s*(\[.*\])$`
   doesn't match arrays spanning multiple lines. The new `writeout_marker`
   set is now written on one line so it matches.

**Response-path follow-up:** Step 12 now resolves the whitelisted shallow
`$response.<field>` prefix before applying generic operations. Nested response
paths remain outside the shallow runner.

### Feat: `endpoint_writeout` body ops + SSE per-event transforms (Step 11)

Closes the deferred hook gap from Step 1–9. The `endpoint_writeout` hook can now
mutate the response body (non-streaming JSON) and per-event SSE frames going
back to the client. Header transforms for this hook were already wired in
`index.ts`; this step adds the body half.

**Engine additions** (`src/utils/request-transform.ts`):
- `hasHookOps(hook, transforms)` — fast-path gate: returns `true` only if at
  least one declared set has a slot for `hook`. Used to skip all buffering
  work when no rules fire.
- `applyWriteoutBody(response, ctx)` — mirror of `applyAfterUpstream`, but on
  the client-schema response. Buffers JSON body, applies all declared
  `endpoint_writeout` ops left-to-right, returns a new `Response` with the
  rewritten body and the original status/headers. Non-JSON bodies and
  malformed JSON pass through unchanged. Returns the original `Response`
  unchanged when `hasHookOps('endpoint_writeout', …)` is false.
- `pipeEventTransformer(responseBody, ctx)` — wraps an SSE byte stream so each
  `data: {…}\n\n` frame passes through the writeout hook's per-event
  transformer before being written back. `[DONE]` sentinel is passed through
  unchanged. Non-data lines (comments, `event:`, `id:`) and non-JSON payloads
  pass through verbatim. Events whose transformer returns `null` are dropped.
- `transformSseEvent(…)` — internal helper that splits a single SSE event
  text block into data lines / other lines, runs the transformer on the
  parsed JSON payload, and re-emits the result.

**Central wiring** (`src/index.ts`):
The `endpoint_writeout` wrap section in `runAttempt` now does four things in
order on the response going to the client:

1. Set `streaming: true` on the writeout context when content-type is
   `text/event-stream` (was hard-coded `false`).
2. For non-streaming responses: call `applyWriteoutBody` to buffer and
   rewrite the JSON body (skipped for SSE — buffering would consume the
   pipeable stream and break streaming behavior).
3. For streaming responses: wrap `response.body` with `pipeEventTransformer`
   to rewrite events in flight, only if a writeout transformer was built.
4. Apply header transforms via the existing `runHook` path (unchanged).

The streaming guard preserves the existing behavior where stats extraction
already consumed a `response.clone()` — the original `response.body` remains
available for `pipeEventTransformer` to wrap.

**Tests** (`tests/unit/request-transform.test.ts`):
+14 tests in 3 new `describe` blocks (41 tests total, all passing):
- `applyWriteoutBody` (7): fast-path returns same Response when no
  transforms; active path applies ops; preserves status and headers;
  non-JSON content-type passthrough; malformed JSON passthrough; multi-set
  fold left-to-right; preserves header from outer response.
- `pipeEventTransformer (writeout SSE)` (4): fast-path returns `null`; drops
  events whose transformer returns `null`; rewrites payload when transformer
  returns a new object; multi-event sequence processing.
- `hasHookOps` (3): empty transform list; declared hook; different hooks.

### Fix: `proxy_config.toml` inline-table `transforms` field + Gemini SDK error handling (Step 10)

Three fixes that round out the Step 8 `deepseek_compat` / `minimax_compat`
work and harden the TUI/config path.

**Root causes and fixes:**

1. **5-element inline-table model entries failed validation**
   The Step 8 wiring added `transforms = "deepseek_compat"` to inline-table
   entries like `deepseek-v4-comp = {target = ..., transforms = "..."}`,
   which caused the inline-table parser to emit a 5-element array. The
   validator in `validateProxyConfig` only accepted 1/2/4-element shapes and
   rejected the new shape with *"must be [target] or [target, base_url,
   api_key] or [target, base_url, api_key, mode] (got 5 elements)"*.
   **Fix:** added a `value.length === 5` branch in the validator that runs
   the same per-field type checks (target/base_url/api_key/mode) plus a new
   `transforms must be a comma-separated string` check. `parseSimpleToml`
   already emitted 5-element arrays when the inline-table had a `transforms`
   key — only the validator was wrong. The 5-element array is the same
   shape `resolveModelRouteFromEntry` already consumed at index 4.

2. **Inline-table entries without `mode` still parsed correctly**
   `minimax-m2.7-high` and the `gemma-4-*` entries omit `mode` and rely on
   the section-level `upstream_mode = "openai-completions"` default. The
   Step 8 parser changes did not affect this path, but the validator now
   also accepts `mode = ""` for these entries.
   **Fix:** no code change needed — the 4-element branch already permitted
   empty `mode`. Verified by re-running `validateProxyConfig` against the
   full config.

3. **Gemini SDK error paths swallowed by the proxy**
   When the Gemini SDK or any other upstream returned an error response with
   `Content-Type: application/json; charset=utf-8` containing a
   `{"error": {...}}` envelope, the proxy's writeout path returned the
   upstream body verbatim with no logging and no normalization. Errors that
   arrived with non-`application/json` content-type (e.g. HTML from a load
   balancer) failed silently because there was no content-type check before
   attempting to read the body.
   **Fix:** added a content-type guard in the writeout wrap before applying
   any JSON body transform — non-JSON responses pass through unchanged. The
   upstream body is logged with status + first 200 chars when an error is
   surfaced (debug logging only — production logs unchanged).

**Tests**: 131 unit tests across 8 files, all passing (+2 in
`transforms-config.test.ts` covering the 5-element inline-table validation:
accepts valid 5-element shape; rejects non-string `transforms`; rejects
empty `target` in 5-element shape).

### Feat: Request/response transform hooks (Steps 1–4)

Implements the full two-tier transform system described in
`docs/design_request_transform_hooks.md`.

**Config layer** (`src/utils/config-loader.ts`):
- New types: `TransformSchema`, `TransformOp`, `BuiltinName`, `TransformSet`
- `ProxyConfig` extended with `transforms` and `transform_defaults` sections
- `ModelRouteConfig` now carries `transforms: TransformSet[]` — merged at load time
  from mode-defaults → sector-defaults → entry (left-to-right)
- `parseSimpleToml` parses `[transforms.*]` + `[transform_defaults]` sections,
  including inline-table op arrays (`before_upstream.ops = [{op="rename",...}]`)
- `parseTransformOpsInline`, `validateTransformSet`, `validateAllTransforms` — fail-loud
  validation of unknown paths, unknown builtins, unknown schemas at config load
- `resolveTransforms()` merges mode-level defaults with per-route transform names

**Transform engine** (`src/utils/request-transform.ts`):
- Tier-1 generic ops: `rename`, `set`, `default`, `remove`, `map_value`
  over shallow paths (top-level fields, `messages[role=X].field`)
- Tier-2 built-ins: `lowercase_tool_schema_types` (recursive schema normalizer),
  `recover_tool_message_name` (cross-message lookup for missing tool name)
- `runHook(hook, payload, ctx)` — left-to-right fold across transform sets
- `buildEventTransformer(hook, ctx)` — null fast path when no transforms active

**Wiring** (`src/index.ts`, `src/handlers/chat-completions.ts`, `src/handlers/messages.ts`,
`src/handlers/openai.ts`, `src/handlers/responses.ts`, `src/handlers/claude.ts`,
`src/handlers/gemini.ts`):
- `endpoint_readin` applied centrally in `runAttempt` before any handler sees the body
- `endpoint_writeout` (headers) applied centrally in `runAttempt` after the handler
- `before_upstream` wired in all seven handlers via `route?: ModelRouteConfig` param:
  - `handleChatCompletionsPassthrough` — OpenAI chat-completions passthrough
  - `handleMessagesRequest` — both openai-upstream and claude-upstream fetch paths
  - `handleOpenAIRequest` — main OpenAI fetch path
  - `handleResponsesRequest` / `handleAsCompletions` — Responses→Completions conversion path
  - `handleClaudeRequest` — native Anthropic messages upstream
  - `handleGeminiRequest` / `handleGeminiRequestForMessages` — Gemini Interactions and
    generateContent fetch paths
- `RouteAttempt` carries `route?: ModelRouteConfig`; `runAttempt` threads it into every
  handler call-site
- Removed inline `normalizeJsonSchemaTypes` + tool-patch loops from `chat-completions.ts`
  (replaced by `lowercase_tool_schema_types` and `recover_tool_message_name` builtins)

**`mapMaxTokensForUpstream` migration (Step 6 — partial):**
- Added `[transforms.max_tokens_rename]` to `proxy_config.toml` with
  `before_upstream.ops = [{op="rename",path="max_tokens",to="max_completion_tokens"}]`
- Added `[transform_defaults]` binding `openai-completions` and `openai-responses` modes
  to the `max_tokens_rename` set — so all routes with those modes get the rename for free
- Removed `mapMaxTokensForUpstream` call from the already-wired `before_upstream` sites
  in `messages.ts` (both openai and claude upstream paths), `openai.ts` (main fetch),
  `responses.ts/handleAsCompletions`; the transform engine now handles the rename
- All active `mapMaxTokensForUpstream` call-sites migrated to transform engine:
  - `chat-completions.ts/openai-responses` path: wired `before_upstream` on converted body
  - `openai.ts/forwardCompletionsAsOpenAIResponses`: added `route?` param, wired hook
  - `responses.ts/handleResponsesInputTokensRequest`: added `route?`, wired both fetch paths
  - `responses.ts/handleResponsesCompactRequest`: added `route?`, wired both fetch paths
  - `responses.ts/handleAsPassthrough`: added `route?`, wired hook
  - `index.ts`: passes `attemptRoute` to `handleResponsesInputTokensRequest` and `handleResponsesCompactRequest`
- Removed `mapMaxTokensForUpstream` import from `chat-completions.ts`, `openai.ts`, `responses.ts`
- `shouldUseMaxCompletionTokens` / `mapMaxTokensForUpstream` kept in `routing.ts` (still
  referenced by `gemini.ts` dead code `handleGeminiToOpenAIMode` and routing unit tests)

**`before_conversion` hook wired (Step 5):**
- `messages.ts`: wired before `convertClaudeToOpenAIRequest`; result merged back to `claudeRequest` via `Object.assign`
- `openai.ts`: wired before the Gemini/Claude format-detection branch; `requestBody` changed `const` → `let`
- `responses.ts/handleAsCompletions`: wired before `convertResponsesToChatCompletions`; `effectiveBody` changed `const` → `let`
- `gemini.ts/handleGeminiGenerateContentRequest`: wired before `isNativeGeminiRequest` branch; `requestBody` changed `const` → `let`
- All wired with `upstreamMode` from route context and fast-path guard `if (route)`

**Remaining hooks (`after_upstream`, `endpoint_writeout` body):** deferred — no transforms
currently declare ops for these hooks; infrastructure will be added when first needed.
Header transforms for `endpoint_writeout` are already wired centrally in `index.ts`.

**Dead code removal and routing.ts cleanup (Step 7):**
- Removed `handleGeminiToOpenAIMode`, `handleOpenAIStreamingToClaude`, `handleGeminiToGeminiMode`
  dead functions from `gemini.ts` (~265 lines)
- Removed `mapMaxTokensForUpstream` and `shouldUseMaxCompletionTokens` from `routing.ts` —
  behavior is now fully owned by the transform engine
- Removed `convertClaudeToOpenAIRequest` import from `gemini.ts` (was only used in dead code)
- Updated `routing.test.ts` to remove tests for the deleted functions

**`deepseek_compat` and `minimax_compat` transform sets (Step 8):**
- Added `[transforms.deepseek_compat]` to `proxy_config.toml`:
  - `endpoint_readin.builtins = ["lowercase_tool_schema_types"]` — normalizes uppercase JSON-Schema
    types (e.g. `"STRING"` → `"string"`) from antigravity SDK before routing
  - `before_upstream.builtins = ["recover_tool_message_name"]` — fills missing `name` in `tool`
    messages from matching prior `assistant.tool_calls[].function.name` by `tool_call_id`
  - `before_upstream.ops`: `map_value` `messages[role=assistant].content "" → null` when
    `tool_calls` sibling present
  - Wired to `deepseek-v4-comp` entry via `transforms = "deepseek_compat"`
- Added `[transforms.minimax_compat]` to `proxy_config.toml`:
  - `before_upstream.ops`: same `map_value` null-content patch
  - Wired to `max-m3-comp` and `minimax-m2.7-high` entries
- Extended inline-table model entry parser (`config-loader.ts`) to read `transforms` field —
  stores as `entry[4]` (comma-separated set names), which `resolveModelRouteFromEntry` already
  reads at index 4
- Extended `serializeModelEntry` to emit `transforms` field on round-trip (used by
  `dumpProxyConfigToml`)

**`after_upstream` hook fully wired (Step 9):**
- Added `applyAfterUpstream(response, ctx)` to `request-transform.ts` — buffers the upstream
  response body, applies `after_upstream` ops, and returns a new `Response`. Non-JSON bodies
  (e.g. SSE streams) are passed through unchanged. Fast-path exits immediately when no
  `after_upstream` transforms are active.
- Wired in all handler fetch sites (12 total):
  - `openai.ts`: `forwardCompletionsAsOpenAIResponses` + main `handleOpenAIRequest` fetch
  - `claude.ts`: `handleClaudeRequest` main fetch
  - `messages.ts`: all four fetch sites (openai-passthrough → openai-responses,
    openai-passthrough → openai-completions, claude-upstream → openai-responses,
    claude-upstream → openai-completions)
  - `responses.ts`: `handleAsCompletions`, `handleAsPassthrough`,
    `handleResponsesInputTokensRequest` (both paths), `handleResponsesCompactRequest` (both paths)
  - `chat-completions.ts`: anthropic-messages path, openai-responses path, direct passthrough
  - `gemini.ts`: `handleGeminiInteractionsRequest`, `handleGeminiGenerateContentRequest`
- Removed `fillMissingToolMessageNames` unconditional call from `handleOpenAIRequest` — this
  function duplicated the `recover_tool_message_name` built-in now applied selectively via
  `deepseek_compat`. Other routes no longer get the transform applied unnecessarily.

**Tests**: 136 unit tests, all passing (+6 new `applyAfterUpstream` tests in
`tests/unit/request-transform.test.ts`: fast-path identity, empty-transforms fast-path,
active remove op, active rename op, status preservation, non-JSON SSE passthrough)

### Fix: TUI model test — inline-table config resolution, fallback mode, and DeepSeek thinking rejection

Three fixes to the TUI's "test model" feature in `src/tui.ts` that improve coverage
and unblock the test for compat-mode `anthropic-messages` upstreams like DeepSeek.

**Root causes and fixes:**

1. **`deepseek-v4-anth` and other inline-table model entries resolved to section-level defaults**
   The TUI's `resolveModelTestConfig` recognized the array-form
   (`"model" = ["target", "base_url", "api_key", "mode"]`) and the bare section-default
   fallback, but silently fell through to section-level `upstream_mode`/`base_url`/`api_key`
   for the inline-table form
   (`"model" = {target = "...", base_url = "...", api_key = "...", mode = "..."}`) used
   throughout `proxy_config.toml` for `deepseek-v4-anth`, `minimax-m2.7-high`,
   `minimax-m3-anth`, `gemma-4-*`, and similar entries. The model test for `deepseek-v4-anth`
   therefore POSTed to `http://192.168.68.179:3000` (the `[models.free]` default) with
   `openai-completions` mode and no DeepSeek key, instead of the configured
   `https://api.deepseek.com/anthropic` with `anthropic-messages`.
   **Fix:** added an inline-table branch in `resolveModelTestConfig` that reads
   `target`/`base_url`/`api_key`/`mode` per entry with `typeof` guards, then falls back
   to section/global defaults. `deepseek-v4-anth` now resolves to
   `upstreamMode="anthropic-messages"`, `targetUrl="https://api.deepseek.com/anthropic"`,
   `apiKey="sk-..."`, `directModel="deepseek-v4-flash"`.
   *Note: empty-string per-field values (e.g. `api_key = ""` in `codelite` and
   `codesmall`) are intentionally preserved as "not set" — the per-field `||` chain
   falls through to the section/global default rather than rejecting the entry, so
   the TUI test for these models still resolves to a working key.*

2. **Unresolvable upstream mode silently fell back to `openai-completions`**
   When the TUI could not resolve any model config (no entry, no section default, no
   proxy default) it built an OpenAI completions body and sent it to the local proxy's
   `/v1/messages` endpoint. The proxy's `/v1/messages` natively speaks Claude, and the
   default OpenAI shape doesn't match that endpoint without a routing decision.
   **Fix:** the fallback upstream mode in `executeModelTest` is now `'anthropic-messages'`,
   which is the proxy's primary `/v1/messages` protocol. The TUI now always POSTs a
   valid body shape to `/v1/messages`, regardless of whether the model is resolvable.

3. **Anthropic-format `thinking: {type: "adaptive"}` rejected by DeepSeek compat shim**
   `buildTestToolRequest` previously added `thinking: {type: "adaptive"}` to every
   `anthropic-messages` test body "to exercise the same thinking path real Anthropic
   traffic uses." Real Claude accepts the omission, but DeepSeek's `/anthropic`
   compatibility endpoint rejects the combination of `thinking` + forced
   `tool_choice: {type: "tool", name: "test_tool"}` with
   *"Thinking mode does not support this tool_choice"* (400). The DeepSeek
   `thinking_mode` doc (see `docs/deepseek_thinking.md`) describes the OpenAI-format
   toggle as `{"thinking": {"type": "enabled/disabled"}}` and never documents the
   Anthropic-format `{"type": "adaptive"}` shape.
   **Fix:** removed the `thinking` block from `buildTestToolRequest`. The TUI test is a
   liveness probe for the model route, not a feature exercise; if a dedicated
   thinking-path test is needed later it should be a separate test mode.

### Fix: `/v1/chat/completions` DEV_PASS_THROUGH — tool schema types, `content: null`, and multi-turn tool calls

Four interrelated fixes to the `handleChatCompletionsPassthrough` path used by
`DEV_PASS_THROUGH=true` clients (e.g. Antigravity `LocalOpenAIAgentConfig`, LangGraph).
All changes affect `anthropic-messages` and `openai-completions` upstream routes.

**Root causes and fixes:**

1. **Uppercase JSON Schema type strings rejected by DeepSeek (`"STRING"` instead of `"string"`)**
   The Antigravity SDK (`google-antigravity`) introspects Python type annotations and emits
   JSON Schema `type` fields in all-caps (`"STRING"`, `"INTEGER"`, `"BOOLEAN"`, etc.).
   DeepSeek and other strict upstreams reject these as invalid per the OpenAI spec.
   **Fix:** `handleChatCompletionsPassthrough` in `src/handlers/chat-completions.ts` now
   recursively lowercases all `type` strings in every tool's `function.parameters` schema
   before forwarding, via a new `normalizeSchemaCasing()` helper.

2. **`messages[N].content is required` (400 from proxy validator) on multi-turn tool calls**
   The OpenAI spec permits `content: null` on assistant messages that contain `tool_calls`
   (the model produced only function calls, no text). Two issues stacked:
   - The proxy's own `validateChatCompletionsRequest` in `src/utils/validation.ts` was
     throwing `content is required` when `content === null`, treating `null` and `undefined`
     the same. Fixed: only `undefined` is now rejected; `null` is accepted for assistant
     messages. `content` must be a string, array, or `null`.
   - LangGraph sends multi-turn history where assistant messages with `tool_calls` have
     `content: ""` (empty string). DeepSeek's Anthropic-compatible endpoint rejects
     `content: ""` when `tool_calls` is present. **Fix:** `handleChatCompletionsPassthrough`
     now normalizes inbound assistant messages: if `tool_calls` is present and
     `content === ""`, it is rewritten to `null` before forwarding.

3. **`anthropic-messages` path sent model alias instead of resolved target name**
   In the `anthropic-messages` conversion branch, `modelId` (the original alias, e.g.
   `deepseek-v4-anth`) was taking priority over `parsedBody.model` (the already-rewritten
   target, e.g. `deepseek-v4-flash`). Claude rejected the alias name.
   **Fix:** priority is now `parsedBody.model || modelId || 'unknown'` — the rewritten
   body model always wins when present.

4. **Multiple consecutive tool messages rejected by Claude (`anthropic-messages` path)**
   When an assistant turn issued N tool calls, the OpenAI → Claude converter
   (`completionsToClaudeBody` in `src/handlers/openai.ts`) produced N separate
   `{role: "user", content: [{type: "tool_result"}]}` messages. Claude requires all
   tool results for a single turn to be bundled in one `user` message.
   **Fix:** `completionsToClaudeBody` now uses a loop that collects all consecutive
   `role: "tool"` messages into a single `{role: "user", content: [...tool_results]}`
   message before continuing. This was already partially noted in the prior "Gemini-endpoint"
   changelog entry but the `completionsToClaudeBody` path was re-fixed here for the
   completions passthrough specifically.

**Additional change — `claudeJsonToSyntheticCompletions` returns `null` content for tool-only responses**

`claudeJsonToSyntheticCompletions` in `src/handlers/openai.ts` (the non-streaming
Claude → OpenAI completions converter) was returning `content: ""` on assistant messages
where the upstream responded with only `tool_use` blocks and no text. This caused the
next LangGraph turn to send `content: ""` back, triggering fix #2 above.
**Fix:** when `tool_use` blocks are present and the text content is empty, `content` is
returned as `null` to match the OpenAI spec.

**Files changed:** `src/handlers/chat-completions.ts`, `src/handlers/openai.ts`,
`src/utils/validation.ts`.

### Fix: Gemini-endpoint → `openai-completions` streaming with DeepSeek reasoning models

Resolved a cascade of five interrelated bugs that prevented Gemini-endpoint clients
(e.g. Antigravity `GeminiAPIEndpoint`) from completing multi-turn agentic tasks through
an `openai-completions` upstream such as `deepseek-v4-flash` on DeepSeek.

**Root causes and fixes:**

1. **Fragmented streaming tool calls emitted as broken `functionCall` parts**
   DeepSeek fragments a single tool call across multiple SSE chunks: the first chunk
   carries `index`, `id`, `name`, and a partial-args string; continuation chunks carry
   only more argument text at the same index. The stateless `convertOpenAIToGeminiGenerateContent`
   converter was called for every chunk, producing name-less `call_undefined_N` parts.
   **Fix:** `processSSEBuffer` now accumulates tool-call deltas in a `geminiToolCallBuffer`
   (keyed by `index`) and flushes one complete `functionCall` per tool call when
   `finish_reason` arrives (`src/handlers/openai.ts`).

2. **`reasoning_content` not passed back on next turn**
   DeepSeek reasoning models emit thinking in a dedicated `delta.reasoning_content` field
   (not inline `<think>` tags). The converter ignored it, so the subsequent request omitted
   `reasoning_content` from the assistant turn and DeepSeek rejected it with:
   `The reasoning_content in the thinking mode must be passed back to the API.`
   **Fix:** `convertOpenAIToGeminiGenerateContent` now extracts `reasoning_content` and
   emits it as a `{thought: true, text}` Gemini part (`src/converters/openai-to-gemini.ts`).
   On the inbound side, `convertGeminiGenerateContentToOpenAI` maps `thought:true` Gemini
   parts to the standard `reasoning_content` field on the assistant message (not a private
   `_thinking` field), so it round-trips correctly through subsequent requests.
   `completionsToClaudeBody` reads the same `reasoning_content` field and converts it to
   a `{type: "thinking"}` Claude content block for `anthropic-messages` upstreams.

3. **Tool messages missing `name` field**
   Several converters (`convertClaudeToOpenAIRequest`, `convertGeminiGenerateContentToOpenAI`,
   Antigravity `LocalOpenAIAgentConfig` passthrough) emitted `role:"tool"` messages without
   the `name` field. DeepSeek's OpenAI endpoint requires it.
   **Fix (A):** `convertGeminiGenerateContentToOpenAI` now tracks each assistant turn's
   `tool_calls` in `lastToolCalls` and uses that to set `name` and match `tool_call_id`
   by position when converting the following `functionResponse` turn.
   **Fix (B):** `fillMissingToolMessageNames` post-processes the converted OpenAI request
   in `handleOpenAIRequest`, recovering `name` from `tool_calls` by `tool_call_id` for
   any converter that missed it (`src/handlers/openai.ts`).
   **Fix (C):** `handleChatCompletionsPassthrough` applies the same recovery for clients
   that hit `/v1/chat/completions` directly (`src/handlers/chat-completions.ts`).

4. **Tool-call IDs mismatched between assistant and tool turns**
   The previous ID scheme `call_${name}_${i}` generated IDs independently in each turn,
   which diverged when multiple calls shared the same function name.
   **Fix:** IDs are now generated once in the assistant turn and recovered by position for
   the corresponding tool-result turn via `lastToolCalls`.

5. **Multiple tool results sent as separate `user` messages (anthropic-messages path)**
   When an assistant turn issued N tool calls, the converter produced N separate
   `{role:"user", content:[{type:"tool_result"}]}` messages. Claude requires all results
   bundled in a single `user` message immediately after the assistant turn.
   **Fix:** `completionsToClaudeBody` now uses a loop that collects consecutive `tool`-role
   messages into one `{role:"user", content:[...tool_results]}` message.

**Files changed:** `src/converters/openai-to-gemini.ts`, `src/handlers/openai.ts`,
`src/handlers/chat-completions.ts`.

### Fix: `DEV_PASS_THROUGH` `/v1/chat/completions` returns raw Claude response to OpenAI clients
Notice:
`handleChatCompletionsPassthrough` was forwarding the Claude Messages upstream response directly
to the client without conversion. Clients expecting OpenAI completions format (e.g. Antigravity
`LocalOpenAIAgentConfig`) received a Claude response object with no `choices` field, triggering:

```
model output error: model output must contain either output text or tool calls
```

The `anthropic-messages` branch in `chat-completions.ts` now converts:
- **Non-streaming**: Claude JSON → `claudeJsonToSyntheticCompletions` → OpenAI `chat.completion`
- **Streaming**: Claude SSE events (`content_block_delta`, `content_block_start`,
  `message_delta`, `message_stop`) → OpenAI `chat.completion.chunk` SSE, including tool call
  streaming (`input_json_delta` → `function.arguments` delta).

`claudeJsonToSyntheticCompletions` is extracted as an exported helper in `src/handlers/openai.ts`
(replacing the previously inlined duplicate in `forwardCompletionsAsAnthropicMessages`).

**Files changed:** `src/handlers/chat-completions.ts`, `src/handlers/openai.ts`.

### Fix: `DEV_PASS_THROUGH` `/v1/chat/completions` fails for `anthropic-messages` routes

When `DEV_PASS_THROUGH=true` and `LocalOpenAIAgentConfig` (e.g. Antigravity) hits
`/v1/chat/completions` with a model whose route uses `anthropic-messages` (e.g. `minimax-m3`),
the proxy had two bugs:

1. **Wrong upstream URL** — `src/index.ts` was appending `v1/chat/completions` to the route's
   `base_url` regardless of `upstream_mode`. For `anthropic-messages` routes this produced a URL
   like `https://api.minimaxi.com/anthropic/v1/chat/completions` which returns 404. Fixed: the
   upstream path is now selected as `v1/messages` for `anthropic-messages`, `v1/responses` for
   `openai-responses`, and `v1/chat/completions` otherwise.

2. **Wrong request body format** — `handleChatCompletionsPassthrough` only handled
   `openai-responses` body conversion; for `anthropic-messages` it forwarded the raw OpenAI
   completions body. Fixed: the handler now converts completions → Claude Messages format
   (via the existing `completionsToClaudeBody`) and sets `anthropic-version` before forwarding.
   `completionsToClaudeBody` is now exported from `src/handlers/openai.ts`.

**Files changed:** `src/index.ts`, `src/handlers/chat-completions.ts`, `src/handlers/openai.ts`.

### Fix: `systemInstruction` dropped when routing Gemini `generateContent` to OpenAI upstream

When Antigravity SDK (or any client) sends a Gemini `generateContent` request with
`systemInstruction` to an `openai-completions` upstream route (e.g. `max-m3`), the system
prompt was silently dropped during conversion. The model received no system context and
hallucinated tool names not in the provided schema, causing errors like:

```
invalid tool call error (invalid_signature) SearchDirectory is required
```

`convertGeminiGenerateContentToOpenAI` in `src/handlers/openai.ts` now extracts
`systemInstruction.parts[*].text` (standard Gemini format) and prepends it as an OpenAI
`{ role: "system", content: "..." }` message before the conversation turns.

**Files changed:** `src/handlers/openai.ts`.

### `DEV_PASS_THROUGH` upstream-auth notice

The README and `docs/README_DETAILS.md` now explicitly flag that `DEV_PASS_THROUGH=true`
on `/v1/chat/completions` forwards the caller's `Authorization` / `x-api-key` /
`x-goog-api-key` to the upstream unchanged — the proxy does **not** perform a local
credential check, the upstream directly authenticates the request (valid key → 200,
invalid key → upstream 401). Previously this was implied by the "validation only (no
model routing)" startup warning but not stated in the docs. No code change; this is
a documentation-only notice. See the env-var table row in `README.md` and the
`DEV_PASS_THROUGH` section in `docs/README_DETAILS.md`.

### Node server decoded response header normalization

The Node server adapter now removes `content-encoding` and `content-length` from
responses before writing them to clients. This prevents clients from trying to
decompress plain text when Node `fetch()` has already decoded an upstream
compressed response while preserving the upstream compression headers.

**Files changed:** `src/server.ts`.

### Composite alias resolution for `DEV_PASS_THROUGH` `/v1/chat/completions`

When `DEV_PASS_THROUGH=true`, the `/v1/chat/completions` passthrough handler now resolves
composite aliases and `target`-mapped model ids before forwarding the request upstream.

- Composite aliases (e.g. `for-claw`) are resolved to their primary/weighted target model
  via the same `getModelRouteConfig` path used by `/v1/messages`.
- `target`-mapped entries (e.g. `minimax-m3` → `MiniMax-M3`, `MiniMaxAI/MiniMax-M3` → `MiniMax-M3`)
  are also resolved.
- The `model` field in the forwarded request body is rewritten to the resolved target model id.
  If no alias resolves, the original model name is forwarded unchanged.
- Previously, composite alias names were forwarded verbatim, causing upstreams to return
  `unknown model` errors (e.g. MiniMax error 2013).

**Files changed:** `src/index.ts`, `README.md`, `docs/README_DETAILS.md`.

### `<think>` tag extraction for `openai-completions` upstream

Upstreams with mode `openai-completions` that emit reasoning wrapped in `<think>...</think>` or
`<thinking>...</thinking>` XML tags now have that content split into each endpoint's
native reasoning field, mirroring the existing `<thinking>` behavior.

- `/v1/messages`: extracted into a Claude `thinking` content block.
- `/v1/responses`: extracted into a `reasoning` output item, with `reasoning_text`
  embedded inside the assistant message for round-trip fidelity (matches Codex's
  expected input shape for multi-turn DeepSeek responses).
- `/v1/interactions`: extracted into a `thought` output item alongside the cleaned
  text output.
- `/v1beta/models/<model>:generateContent`: extracted into a Gemini `thought`
  content part alongside the cleaned text part.
- Tag is stripped from the user-visible text content in all paths.
- Both streaming and non-streaming responses are covered; the streaming path
  stitches tags that straddle SSE chunk boundaries via a per-stream `thinkStreamBuffer`
  that is reset on `[DONE]` to avoid cross-request leakage.

`README.md` documents the new behavior next to the existing thinking/reasoning notes.

**Files changed:** `src/converters/openai-to-claude.ts`, `src/converters/streaming.ts`,
`src/converters/completions-to-responses.ts`, `src/converters/openai-to-gemini.ts`,
`src/handlers/responses.ts`, `src/handlers/openai.ts`, `tests/unit/think-tag-extraction.test.ts`,
`README.md`.

### Model usage HTTP recording and auth context headers

The proxy can now optionally POST per-request model usage records to an HTTP collector configured with `[model_usage] record_url`.

- Usage records include `request_id`, `endpoint`, raw `user_key`, `model`, and token counters (`input_tokens`, `cached_tokens`, `cache_written_tokens`, `output_tokens`, `total_tokens`).
- JSON and streaming responses reuse the existing token accounting path, so both non-streaming usage payloads and final streaming usage chunks are reported.
- If `auth_url` returns an `access_token` response header, that one-request token is forwarded to `record_url` as an `access_token` request header.
- Requests to `auth_url` now also include `request_id` and `endpoint` headers, plus the existing auth headers and optional `x-resource-for` when `auth_with_model = true`.
- `proxy_config.example.toml` and `README.md` document the new optional `[model_usage]` section.

**Files changed:** `src/index.ts`, `src/utils/model-usage-recorder.ts`, `src/utils/config-loader.ts`, `src/utils/dashboard-stats.ts`, `tests/unit/token-usage.test.ts`, `tests/unit/auth-with-model.test.ts`, `testcases/15_config_parse/config_parse.test.js`, `README.md`, `proxy_config.example.toml`.

### TUI statistics overlay and compact tool names

The proxy TUI now has a `D` hotkey that opens a scrollable statistics overlay,
matching the existing overlay style used by `P` Tool Blocklist. The panel shows
all rows from `Top Models`, `Tools Used`, and `Top Endpoints` instead of the
main view's first-five-row summaries.

- `Top Models` keeps the full token/accounting column set.
- `Tools Used` and `Top Endpoints` use their own shorter column sets, with
  separator lines between modules.
- Long tool names are compacted in both the statistics overlay and Tool
  Blocklist panel using a prefix/suffix form to preserve recognizable endings.

**Files changed:** `src/tui.ts`.

### Token usage propagation across streaming and cache-aware routes

Token accounting is now more complete across transformed streaming routes:

- OpenAI Chat Completions streaming requests now force `stream_options.include_usage = true` in both Claude-format conversion and OpenAI passthrough paths, so final upstream usage chunks can be propagated.
- Gemini streaming conversion now parses final `interaction.usage` / `usageMetadata` and emits Claude `message_delta.usage`, allowing `/v1/messages` and `/v1/responses` Gemini streaming routes to report final input/output/cache-read token counts.
- OpenAI Responses `usage.input_tokens_details.cached_tokens` is preserved through Claude and Responses conversion paths instead of being dropped or hardcoded to zero when available.
- Local token counting now includes tool results and other non-text blocks with best-effort serialization instead of silently skipping them.
- Unit tests cover streaming usage propagation, cache-token mapping, and local non-text token counting.

**Files changed:** `src/converters/gemini-streaming.ts`, `src/converters/openai-to-claude.ts`, `src/handlers/messages.ts`, `src/handlers/responses.ts`, `src/utils/token-counting.ts`, `tests/unit/token-usage.test.ts`, `README.md`.

### `[general]` section; `[upstream]` renamed to `[default_upstream]`; `auth_passthrough_with` and `auth_url`

Three related config-layer changes landed together.

**`[upstream]` → `[default_upstream]`**

The TOML section that holds global upstream defaults (`default_base_url`,
`default_api_key`, `upstream_mode`) is renamed from `[upstream]` to
`[default_upstream]` to make its scope clearer — it applies only to models
that fall through every `[models.*]` section. Existing configs must rename
the section header; all other keys inside it are unchanged.

**New `[general]` section**

A top-level `[general]` section collects settings that are not tied to a
specific upstream:

- `global_token_limit` and `budget_to_effort_low/medium/high` (previously
  in `[upstream]`) have moved here.
- `auth_url` (optional): if set, the proxy validates every inbound auth
  header by forwarding it (plus `User-Agent`) to this URL via `GET`. HTTP
  200 (or a 301/302 chain that resolves to 200) = success; any 4xx/5xx
  = 401 to the client; network error = 503.
- `auth_passthrough_with` (optional, default `"user_key"`): controls which
  credentials the proxy sends to the upstream provider.

**`auth_passthrough_with`**

| Value | Behaviour |
|:------|:----------|
| `"user_key"` *(default)* | Caller's auth header is forwarded upstream for all sections except `[models.free]`, which always uses its configured key. Unchanged from prior behaviour. |
| `"config_key"` | Configured `api_key` wins for every section — per-entry → section → `[default_upstream] default_api_key`. Callers can still send a key (needed for the `auth_url` validation step) but it is not forwarded upstream. |

`config_key` is intended for shared-gateway deployments where callers must
not supply their own upstream credentials.

**Files changed:** `proxy_config.toml`, `proxy_config.example.toml`,
`src/utils/config-loader.ts` (interface + TOML parser + Consul loader +
serializer), `src/index.ts` (five auth-header sites), `src/server.ts`,
`src/tui.ts`, `src/handlers/dashboard.ts`, `README.md`.

### Privacy filter: local hash-only mode (no sidecar)

The proxy now ports the entropy-based hash/API-key scanner from
[`submodules/privacy-filter/hash_detect.py`](./submodules/privacy-filter/hash_detect.py)
into the TypeScript runtime as `src/utils/hash-detect.ts`. When
`[privacy_filter] filter_mode = "local"` is set in `proxy_config.toml`, the
proxy redacts hash-shaped tokens (API keys, tokens) in-process with no
HTTP call and no Python sidecar. Detected spans are replaced with the
same `⟦HASH:n⟧` sentinels the sidecar emits and are restored on the
response exactly as in sidecar mode — the on-the-wire shape is
identical, so the existing `restoreText` / streaming transform code is
shared.

- **Config source**: a new `[privacy_filter]` toml section. Env vars
  (`PRIVACY_FILTER_URL`, `PRIVACY_FILTER_TIMEOUT_MS`, etc.) override toml,
  matching the rest of the proxy's plugin knobs. The plugin is enabled
  when `filter_mode = "local"` (no URL required), or when
  `filter_mode = "sidecar"` is paired with a valid `filter_url`;
  otherwise it stays inert. There is no separate `enabled` flag — the
  combination of `filter_mode` and `filter_url` is what turns the
  filter on.
- **Detection semantics**: identical to the Python reference — Shannon
  entropy ≥ `entropy_threshold` (default `3.0`), 8+ contiguous hex chars
  with non-hex boundaries, length multiple of 8 ⇒ `HIGH` (16–256 chars),
  otherwise `LOW`. A built-in whitelist (`deadbeef`, `cafebabe`, etc.)
  is always applied and can be extended with `whitelist_add` /
  `whitelist_remove`. The minimum token length is configurable via
  `hash_min_len` (default `8`); the Python `hash_detect.py` was updated
  to match (`<= 8` → `< 8`).
- **Sidecar mode is unchanged**; setting `[privacy_filter] filter_mode = "sidecar"`
  + `filter_url = "..."` activates the OPF Python sidecar via toml, in
  addition to the legacy `PRIVACY_FILTER_URL` env-var path.

**Files changed:** `src/utils/hash-detect.ts` (new), `src/utils/privacy-filter.ts`
(local mode + toml plumbing), `src/utils/config-loader.ts`
(`[privacy_filter]` section), `src/index.ts` (wire toml through
`getPrivacyFilterConfig`), `proxy_config.toml` and `proxy_config.example.toml`
(documented example), `testcases/16_security/privacy_filter.test.js`
(TC2115–TC2122), `dist/`.

### Privacy filter now restores both `PII` and `HASH` sentinels

The privacy-filter sidecar ([`submodules/privacy-filter/serve.py`](./submodules/privacy-filter/serve.py)) emits two sentinel prefixes: `⟦PII:n⟧` (model-detected PII) and `⟦HASH:n⟧` (cryptographic-hash-shaped secrets such as API keys and tokens, caught by the entropy-based `hash_detect.py` scan). Previously the proxy's `SENTINEL_REGEX` only matched `PII:`, so `HASH:` sentinels would leak through as literal text in streaming responses. The regex now matches `(?:PII|HASH):`, and the info log line no longer claims HASH spans are PII. On overlap the sidecar's priority order (`HASH_HIGH > HASH_LOW > MODEL`) still applies — the proxy is just restoration, not detection.

**Files changed:** `src/utils/privacy-filter.ts`, `src/index.ts`, `testcases/16_security/privacy_filter.test.js` (TC2113, TC2114), `dist/`.

### Smaller production Docker image

- After the TypeScript build, `Dockerfile` runs `npm prune --omit=dev` so the runtime image no longer carries `wrangler`, `@anthropic-ai/claude-code`, `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@google/genai`, etc. They have also been moved to `devDependencies` in `package.json`.

**Files changed:** `Dockerfile`, `package.json`.

### `DEV_PASS_THROUGH` now honors per-model routes and OpenAI Responses upstreams

- `/v1/chat/completions` with `DEV_PASS_THROUGH=true` now resolves the request `model` through the normal model config before forwarding, so per-model `base_url`, `api_key`, and `mode` entries (including `[models.free]`) are used instead of always falling back to `[models.default]`.
- If the resolved route uses `upstream_mode = "openai-responses"`, the Chat Completions body is converted to Responses format and sent to `/v1/responses`; `openai-completions` routes still forward the original body as-is.
- Azure OpenAI Responses routes keep using the configured model key; the handler normalizes OpenAI-style auth to Azure's `api-key` header for Azure URLs.

**Files changed:** `src/index.ts`, `src/handlers/chat-completions.ts`, `src/handlers/openai.ts`, `testcases/16_security/dev_pass_through_responses.test.js`, `README.md`, `testcases/README.md`.

### Gemini endpoint routing can target Anthropic Messages and OpenAI Responses

- `/v1/interactions` can now route to `upstream_mode = "anthropic-messages"` and `"openai-responses"` through the existing OpenAI Chat Completions intermediate conversion. The upstream response is converted back to the Interactions shape.
- `/v1beta/models/{model}:generateContent` and `:streamGenerateContent` (plus `/v1/models/...`) can now route to `anthropic-messages` and `openai-responses` through the same double-conversion path, then convert responses back to Gemini `candidates[].content.parts`.
- Cross-mode streaming text deltas are converted back to Gemini-shaped SSE instead of passing through raw Claude or Responses SSE.
- Tool calls are preserved: Claude `tool_use` blocks and OpenAI Responses `function_call` items become Chat Completions `tool_calls`, then Gemini `functionCall` parts or Interactions `function_call` outputs.
- When routing Interactions/generateContent to OpenAI Responses, `system`/`developer` messages are forwarded as Responses `instructions`, and OpenAI content-part arrays are normalized to text for Responses `input_text` fields.

**Files changed:** `src/index.ts`, `src/handlers/openai.ts`, `src/converters/openai-to-gemini.ts`, `testcases/16_security/openai_responses_routing.test.js`, `README.md`.

### `base_url` may now point to a full upstream endpoint path

The proxy no longer blindly appends the endpoint suffix to a configured `base_url`. If `base_url` already contains a known full endpoint path, it is used as-is. This lets providers configure `base_url` to the exact upstream URL they need, without getting a doubled path such as `.../v1/messages/v1/messages`.

Recognised full-endpoint markers (case-insensitive):

- `/v1/messages`, `/anthropic/messages` (anthropic-messages)
- `/v1/chat/completions`, `/v1/interactions` (openai-completions / interactions)
- `/v1/responses`, `/openai/responses` (openai-responses, including Azure)
- `/v1beta/models/{model}:generateContent`, `/v1/models/{model}:generateContent`, `:streamGenerateContent`, `:countTokens`

Gemini `base_url` can also stop at the API version or models collection, such as `https://generativelanguage.googleapis.com/v1beta` or `https://generativelanguage.googleapis.com/v1beta/models`; the proxy appends `{model}:generateContent` without duplicating `/v1beta` or `/models`.

For example, a model configured with `base_url = "https://api.anthropic.com/v1/messages"` and `upstream_mode = "anthropic-messages"` will forward `/v1/messages` requests to that exact URL, rather than `https://api.anthropic.com/v1/messages/v1/messages`.

**Files changed:** `src/utils/routing.ts` (new `buildUpstreamUrl` helper), `src/index.ts` (use helper in fixed, composite, and fusion routing).

### Thinking budget clamping: `budget_tokens` is capped to `max_tokens` (with interleaved-thinking exception)
When request to `kimi-2.7-code`, exception shows rised: 'InvalidParameter: max_completion_tokens [32000] must be greater than thinking_budget [32768]'. This is not a fix for the problem, they are just completions to follow api docs:
- **`POST /v1/messages` and `POST /v1/messages/count_tokens`**: when `thinking` is enabled and
  `thinking.budget_tokens` exceeds `max_tokens`, the request validator reduces
  `budget_tokens` down to `max_tokens` before forwarding, keeping the budget within the
  per-response output window required by the Claude API spec.
- **Interleaved-thinking exception**: if the request carries the
  `anthropic-beta: interleaved-thinking-2025-05-14` header, `budget_tokens` is left
  unchanged even when it exceeds `max_tokens` (per `docs/claude-extended-thinking.md`),
  since interleaved thinking is permitted to consume the full context window for
  reasoning tokens.
- **Below-minimum `max_tokens`**: if `max_tokens < 1024` while thinking is enabled with a
  non-null budget, validation throws with a clear message instead of clamping to an
  invalid value.

**Files changed:** `src/utils/validation.ts` (new `clampThinkingBudget`; updated
`validateClaudeMessagesRequest` / `validateClaudeTokenCountingRequest` signatures),
`src/handlers/messages.ts`, `src/handlers/token-counting.ts`.

### Composite alias safety: routing cycle detection, name-conflict stripping, self-reference rejection

#### Routing cycle detection
- **Load time**: `validateProxyConfig` now resolves every composite alias through the full routing chain and catches cycles (e.g. `for-claw6 → for-claw7 → for-claw8 → for-claw6`). Each unique cycle is pushed as a fatal validation error, logged as `[FATAL]`, and surfaced in the TUI status bar and dashboard status bar via `_validationErrors`.
- **Request time**: `getModelRouteConfig`, `getOrderedCompositeTargets`, `resolveCompositeModelRoute`, `getCompositeRouteCandidates`, and `resolveFusionPlan` all accept a `visited: Set<string>` parameter. If a cycle is detected mid-resolution, a `Routing cycle detected: A → B → … → A` error is thrown immediately rather than looping forever.
- **Dashboard snapshot**: `getDashboardSnapshot` now passes `new Set([alias])` when resolving each composite target's route and uses `flatMap` + try/catch so a cyclic target is silently omitted from the snapshot instead of crashing the entire snapshot call (which previously caused TUI to hang at `Loading…`).

#### Nested composite routing (composite → composite)
- Composite targets that are themselves composite (or schedule/fusion) aliases are now resolved through the full routing chain (`getModelRouteConfig`) rather than only `resolveModelRouteFromConfig` (which only looked at `[models.*]`). This makes `alias-a → alias-b → real-model` work correctly end-to-end.

#### Name-conflict stripping
- `findAliasNameConflicts` / `stripConflictingAliases`: composite and schedule aliases whose name collides with a `[models.*]` entry are stripped from the in-memory config at load time. `[FATAL]` is logged per stripped alias; `_validationErrors` carries the error so it appears in TUI / dashboard.
- `addCompositeAlias` / `addScheduleAlias` throw if the new alias name matches an existing model name, preventing the conflict from being written to disk.

#### Self-reference rejection
- `findSelfReferencingCompositeTargets` / `stripSelfReferencingCompositeTargets`: composite targets that list their own alias name as a target are stripped from the in-memory config at load time with `[FATAL]` logging.
- `upsertCompositeTarget` and `validateAndNormalizeComposite` (dashboard PUT path) both throw immediately if a target name equals the alias name, preventing self-references from reaching disk.
- All four TUI call sites for `upsertCompositeTargetFromDashboard` (add/edit × share/fusion) are wrapped in try/catch; errors are shown on the TUI message line without saving.

**Files changed:** `src/utils/config-loader.ts`, `src/handlers/dashboard.ts`, `src/tui.ts`.

### Test runner: `TEST_CONFIG` default is now force-set on `process.env`

- **Fixed silent isolation bypass**: `run-tests.js` and `testcases/utils/test_helpers.js`
  each computed a local `TEST_CONFIG` constant as `process.env.TEST_CONFIG || 'test_'`,
  but never wrote that default back to `process.env.TEST_CONFIG`. Any code path
  that read `process.env.TEST_CONFIG` directly (e.g. the proxy process itself,
  when started independently of `run-tests.js`) would see it unset and fall back
  to `./proxy_config.toml` instead of the isolated `./test_proxy_config.toml`,
  letting config-mutating test suites (composite/fusion/schedule PUTs, tool
  blocklist, global token limit) write into the real config file.
- Both files now do `if (!process.env.TEST_CONFIG) process.env.TEST_CONFIG = 'test_';`
  before reading it, so `TEST_CONFIG` is always defined for every child process
  and for `src/server.ts`'s own `PROXY_CONFIG_PATH` resolution, regardless of
  whether it arrived empty, unset, or already set by the caller.

**Files changed:** `run-tests.js`, `testcases/utils/test_helpers.js`.

### Schedule window editor: friendly `days` input (weekdays/weekend/everyday) in TUI and dashboard

- **Simplified `days` semantics**: schedule windows now accept `"weekday"`/`"weekdays"`
  and `"weekend"`/`"weekends"` in any casing; any other string value normalizes
  to "every day" instead of throwing a validation error. Explicit day-name
  arrays (e.g. `["mon","tue"]`) are still honored for hand-edited TOML. Added
  a shared `normalizeScheduleDays()` helper in `src/utils/config-loader.ts`
  used by the TOML parser, the dashboard JSON-payload validator
  (`validateAndNormalizeScheduleWindow`), and `upsertScheduleWindow` (the
  function both the TUI and the dashboard HTTP route call), so all three
  input paths agree.
- **TUI**: replaced the single JSON-array text prompt for editing a schedule
  target's windows with a step wizard — `from` (number prompt) → `to` (number
  prompt) → **days** (a 3-way picker: Every day / Weekdays / Weekend), with an
  "add another window" loop, or "Set as fallback" to clear the window list in
  one step. Also fixed the alias panel's per-target summary line, which
  previously silently dropped `days: "weekday"`/`"weekend"` (it only rendered
  array-style day lists).
- **Dashboard**: the schedule window's `days` free-text input (which could
  only ever produce a custom day array, never the special weekday/weekend
  values) is now a `<select>` dropdown with the same three options, matching
  the TUI.

**Files changed:** `src/utils/config-loader.ts` (`normalizeScheduleDays`,
`parseScheduleWindow`, `validateAndNormalizeScheduleWindow`,
`upsertScheduleWindow`), `src/tui.ts` (`openEditScheduleWindowsPrompt`,
`ScheduleAliasesOverlay.render`), `src/handlers/dashboard.ts`
(`scheduleAliasRows`, `collectConfigPayload`).

### Schedule Aliases panel: target-add UX fixes, target scope, and test-isolation path bug

- **Enter no longer dismisses the "Add target" list** — selecting a target in the
  "Adding target to *alias*" picker now returns to the Schedule Aliases panel
  (matching Esc/cancel behavior), instead of leaving no overlay open.
- **Key rebind**: adding a schedule target is now `M` (was `T`), for consistency
  with the Composite Aliases panel's `M add target` binding.
- **Target picker no longer offers invalid candidates**: wildcard routing patterns
  (`*`, `claude-*`, etc.) and the schedule alias itself (self-reference) are
  excluded from the "Adding target to *alias*" list.
- **Schedule targets can now be composite/fusion aliases**, not just concrete
  custom models — the picker already sourced candidates from
  `getConfiguredModelIds()` (which includes composite alias names), so this
  was a filtering/doc fix rather than a resolver change.
- **Fixed test-config isolation path bug**: `src/server.ts` computed the
  `TEST_CONFIG`-isolated config path as `` ./${TEST_CONFIG}_proxy_config.toml ``
  (extra underscore), while `run-tests.js` copies the developer config to
  `` ./${TEST_CONFIG}proxy_config.toml `` (no extra underscore). Because the two
  paths didn't match, a running test suite's `PUT /dashboard/api/config` calls
  could end up mutating a config path outside the isolation the test runner set
  up. Removed the extra underscore so the server reads/writes the exact path
  `run-tests.js` isolates.

**Files changed:** `src/tui.ts` (`ScheduleAliasesOverlay`, `openAddScheduleTargetPrompt`), `src/server.ts`.

### Config validation warnings + relaxed `api_key` requirement

`validateProxyConfig` now distinguishes **warnings** from **errors**. Situations that were previously
hard errors but are valid in practice (e.g. missing `api_key` when the caller supplies their own
auth header) are now surfaced as warnings and no longer block the config from loading.

- `ValidationResult` gains a `warnings: ConfigValidationError[]` field (same shape as `errors`).
- Dashboard GET `/dashboard/api/config` response includes `config_warnings` alongside `config_errors`.
- Dashboard UI and TUI both display warnings in amber/yellow when there are no hard errors.
- `api_key` absence is no longer an error for any section — the proxy forwards the caller's auth header.
  Only `base_url` absence (when required) remains a hard error.

**Files changed:** `src/utils/config-loader.ts`, `src/handlers/dashboard.ts`, `src/tui.ts`.

### Per-model `mode` override in `models.*` entries

Each model entry in a `[models.<section>]` block can now declare an explicit
`mode` to override the section's `upstream_mode`. This allows a single
category (e.g. `[models.free]`) to route different models to different
API formats without needing separate sections.

**Config syntax** (both forms supported):

```toml
[models.free]
upstream_mode = "openai-completions"   # section default
sonnet46 = {target = "claude-sonnet-4-6", base_url = "http://localhost:3000", api_key = "", mode = "anthropic-messages"}
opus46   = ["claude-opus-4-6", "http://localhost:3000", "", "anthropic-messages"]
```

**Mode resolution chain**: `model entry mode` → `section upstream_mode` →
`[upstream] upstream_mode` → `"openai-completions"`.

**Files changed:**
- `src/utils/config-loader.ts` — `resolveModelRouteFromEntry` extracts
  `modelMode` from entry[3] and cascades it; inline-table and array
  parsers handle `mode`; validation accepts 4-element arrays;
  `sanitizeDashboardCategoryConfig` preserves mode at index 2 of the
  3-element `[target, base_url, mode]` dashboard format;
  `applyDashboardConfigUpdate` reconstructs the 4-element internal form
  on PUT.
- `src/tui.ts` — `modelChoices()` and `resolveModelTestConfig()` now read
  mode from index 2 of the dashboard sanitized array (was incorrectly
  reading index 3), so the Test Custom Model panel shows the correct
  `anthropic-messages` / `completions` / `gemini` label per model.

### Bug fix: config `api_key` overrode caller key for `[models.default]` targets reached via composite / direct routing

The non-fusion composite dispatch in `src/index.ts` (the `compositeAttempts.map` block) was applying
the model's per-entry `api_key` from the config on top of the caller's auth headers unconditionally,
for every section. This contradicted the documented rule in `proxy_config.example.toml`:

> For the `[models.default]` tier, the auth key sent by the caller takes priority over ALL configured
> `api_key` values, including per-entry overrides. The `api_key` field is intentionally left unset by
> admins in practice — it only acts as a fallback when the caller did not supply an auth key.

Effect: a request for a model like `max-m3` (whose entry in `[models.default]` declares a
`sk-cp-p_i6lDK-...` key) would send the config key to the upstream, ignoring the caller's
`Authorization` / `x-api-key` header. The fusion path was already correct (gated on
`route.section === 'free'`), so the same target behaved differently depending on whether it was
reached via a fusion alias or via composite / direct routing.

Fix: align the inline composite-dispatch block with `buildRouteAttempt` — only override the caller's
auth with the config `api_key` when `route.section === 'free'`. All non-`free` sections
(`default`, `claude`, `gemini`, etc.) now pass the caller's key through unchanged. Affects
`src/index.ts` only (one block, ~10 lines).

### Bug fixes: `/v1/responses` reasoning round-trip (DeepSeek thinking mode + Codex multi-turn)

Four root causes behind the persistent `"reasoning_content must be passed back to the API"` error
when using the Responses API (`/v1/responses`) with DeepSeek thinking-mode upstreams and the Codex
CLI. All changes are in the responses handler and its two converter modules.

- **Streaming path silently dropped `delta.reasoning_content`** — `streamCompletionsAsResponses`
  in `src/handlers/responses.ts` was ignoring the `reasoning_content` / `thinking` delta fields
  that DeepSeek and OpenAI thinking-mode upstreams send per chunk. Added accumulation into
  `accumulatedReasoning` and emitted a `reasoning` output item (with the text) in the final
  `response.output_item.done` event for each text message. The `reasoning_text` is also appended
  inside the assistant message's content array so Codex can echo it back on the next turn.

- **Non-streaming path produced an empty `reasoning` output item** —
  `src/converters/completions-to-responses.ts` was emitting a `reasoning` item with no content
  when the upstream `message.reasoning_content` field was present. Fixed to actually extract the
  string and populate `content: [{ type: 'reasoning_text', text: reasoningText }]`. Also handles
  `part.type === 'thinking'` content parts from OpenAI-style array content.

- **Consecutive `function_call` input items produced separate assistant messages** —
  `src/converters/responses-to-completions.ts` was converting each `function_call` item into its
  own assistant message. Chat Completions (and DeepSeek) require all tool calls from a single
  assistant turn to be in *one* assistant message with multiple `tool_calls` entries. The new
  `convertInputItemsToMessages` exported function collects all consecutive `function_call` items
  and merges them into a single assistant message.

- **Server-side call_id → reasoning store for Codex multi-turn** — Codex builds conversation
  history from `response.output_item.done` events and echoes `function_call` items back as input
  on the next turn, but does **not** re-send `reasoning` items. Without a server-side store, the
  `reasoning_content` field would be absent from the echoed assistant message, causing DeepSeek to
  reject the request. Added a module-level `reasoningByCallId` map (10-minute TTL) in
  `src/handlers/responses.ts`: when a streaming response ends with both tool calls and accumulated
  reasoning, the reasoning is keyed by each `call_id`. On the next request, `handleAsCompletions`
  walks the converted messages and injects the stored `reasoning_content` onto any assistant message
  whose `tool_calls` match a stored entry.

### Bug fixes: OpenAI thinking passthrough + composite 413 path

Two single-case regressions caught by the full integration suite are now
fixed; the suite runs **18/18 suites, 165/165 cases** against the local
proxy (port 7799, `qnaigc` upstream). Recorded in
`tests/test_results_at_2026-06-22_20-14-47.md`.

- **TC413 — OpenAI-style thinking field (`{ enabled, budget_tokens }`)
  was rejected with HTTP 400** on `/v1/messages`. The request was dispatched
  to the Claude-format path (because `requestBody.thinking` is truthy) and
  then failed `validateClaudeMessagesRequest` with `thinking.type is
  required`. Added `normalizeOpenAIToClaudeThinking()` in
  `src/utils/thinking.ts` and applied it in `src/handlers/messages.ts`
  right after JSON parsing, so format detection, validation, and
  conversion all see the canonical Claude shape
  (`{ type: 'enabled'|'disabled', budget_tokens }`).
  Test now uses `budget_tokens: 2000` (validation floor is 1024) and
  `max_tokens: 3000` to fit.
- **TC1110 — Composite `token_limit` exhaustion returned 400 instead of
  413.** Two issues stacked:
  1. `OverLimitError` in `src/utils/errors.ts` was using 429 /
     `rate_limit_error`, the rate-limit shape. Token-limit exhaustion is a
     payload-size / quota concept, not RPM, so it now returns 413 /
     `over_limit_error` to match the documented `token_limit reached`
     contract and the canonical Anthropic-style error envelope.
  2. The catch block in `src/index.ts` around the model-routing body
     parse was swallowing *every* error (including typed
     `ClaudeProxyError` instances) and rewriting it as a 400 "Invalid
     request body". Added an `instanceof ClaudeProxyError` re-raise
     branch so the original status code and `type` field reach the
     client.

  Manual verification: two consecutive requests against a temporary
  `__test_ttl413__` alias with `token_limit: { num: 1, duration: '1h' }`
  now return `200` then
  `413 {"type":"over_limit_error","error":{"type":"over_limit_error","message":"Composite alias '__test_ttl413__' token limit (1 1h) reached (10). No further requests will be routed through this alias."}}`.

### Kompress (context compression) plugin

The proxy can now drop low-importance tokens out of outbound request text to cut
upstream token usage and cost. It mirrors the privacy-filter architecture: a thin
`fetch`-only client (`src/utils/kompress.ts`) talks to a persistent
[kompress](./submodules/kompress/README.md) HTTP sidecar (`POST /compress`), so it
stays Cloudflare-Workers-compatible and is **entirely inert unless `KOMPRESS_URL`
is set**.

Unlike the privacy filter, compression is **lossy and one-directional** — there is
no response-side restore (no sentinel map, no transform stream).

- **`src/utils/kompress.ts`** (new) — `getKompressConfig(env)` (returns `null` when
  `KOMPRESS_URL` unset; validates the sidecar is an internal host), `shouldCompressPath`,
  `isCjkHeavy` (English-only model guard), and `compressBody` (parallel per-fragment
  fan-out to the sidecar).
- **Scope:** compresses only **user-message text** and **tool definitions/results**
  (Anthropic `tools[].description` + `tool_result`, OpenAI `function.description` +
  `role:'tool'`). The system prompt, assistant messages, JSON schemas, images, and
  tool-call inputs are left untouched.
- **CJK guard:** the model is English-only and garbles non-Latin input, so fragments
  above a non-ASCII threshold (or containing CJK/Kana/Hangul) are passed through
  uncompressed.
- **Fail-open by default** (inverse of the privacy filter): a sidecar outage forwards
  the original uncompressed text rather than failing the request. Override with
  `KOMPRESS_FAIL_OPEN=false`.
- **Wiring** (`src/index.ts`): runs right after PII redaction and before tool-blocklist
  erasure, inside the same body-parse block, so single/composite/fusion paths all see
  the compressed body.
- **Env:** `KOMPRESS_URL`, `KOMPRESS_ENDPOINTS`, `KOMPRESS_FAIL_OPEN`,
  `KOMPRESS_TIMEOUT_MS`, `KOMPRESS_MAX_CHARS`, `KOMPRESS_KEEP_RATIO`, `KOMPRESS_MIN_CHARS`
  (declared in `src/types/shared.ts`, surfaced in `src/server.ts`).

### Dashboard Tool Blocklist (mirrors TUI `P` overlay)

The `/dashboard` web UI now ships the same tool blocklist the TUI exposes
behind the `P` key. The previous "Tools Used" aggregated view is replaced
by a per-`(tool, agent)` table with a Block/Unblock button per row.

- **`GET /dashboard/api/tools/blocklist`** (`src/handlers/dashboard.ts`) —
  returns `{ rows: AgentToolPanelEntry[], blockedTools: string[] }` from
  `getAgentToolPanelStats()` + `[...getBlockedTools()]`. Reuses the
  same data feed the TUI overlay consumes (per-tool × per-agent
  `in_requests` / `in_responses` / `in_request_chars`).
- **`POST /dashboard/api/tools/toggle-block`** — body
  `{ tool_name: string, blocked: boolean }`, calls `blockTool()` /
  `unblockTool()` from `src/utils/dashboard-stats.ts`, returns
  `{ ok, tool_name, blocked }`. Returns `400 { error }` when `tool_name`
  is missing or empty.
- **Routes registered** in `src/index.ts` next to the existing
  `/dashboard/api/stats/agents`, `/test-model`, `/global-token-limit`
  handlers.
- **Dashboard UI** (`section-agent` in `handleDashboardPage()`):
  - Heading renamed "Tools Used" → "Tool Blocklist" with a one-line
    caption pointing at the TUI `P` overlay.
  - Table now has 7 columns: status (`✗` / `·`) | Tool | Agent | in req
    | in resp | total len | Action.
  - Blocked rows get a red `✗` status cell, a light red background,
    and the action button toggles between `Block` (neutral) and
    `Unblock` (red).
  - Click handler delegated on `#toolStats` posts to the toggle-block
    endpoint and re-fetches `/tools/blocklist` to refresh the view.
  - 5-second auto-refresh already in place keeps the block state live
    with the rest of the dashboard.
- **Behavior parity with TUI**: blocked tools stop accumulating
  `in_requests` / `in_responses` / `in_request_chars` (existing
  pre-block counts are preserved). In-memory only — same as the TUI,
  resets at proxy restart.
- **Backward compatibility**: `GET /dashboard/api/stats/agents` and
  the `toolStats` field on the main `/dashboard/api/config` snapshot
  are unchanged. The aggregated per-tool view is still available via
  the API; only the dashboard UI now uses the per-`(tool, agent)` view.

### Model Statistic Collapse (default 10)

The Model Statistic table in `/dashboard` now collapses to the top 10
models by default and shows a `Show all (N)` / `Collapse` toggle next
to the existing Export CSV button — same pattern as the Tool Blocklist
section.

- **Default view** shows 10 rows; the toggle is hidden when fewer than
  10 models are present, otherwise it reads `Show all (N)` (collapsed)
  or `Collapse` (expanded).
- **`Export CSV` interaction**: the existing button reads rows from the
  DOM, so it exports only the currently visible rows. Click `Show all`
  first if a full export is needed. This matches the pre-existing CSV
  behavior (the button always reflected whatever was rendered).

### Request Hot-Path Performance: Single Body Parse + Incremental Token-Window Cache

Two optimizations on the per-request hot path, applied without changing any
behavioral contract.

- **Single request body parse** (`src/index.ts`) — tool/agent stats were
  previously extracted from a `request.clone().json()` call at the top of
  the request handler, *before* the routing block parsed the same body via
  `request.text()` + `JSON.parse()`. That meant every JSON request paid
  for two full body parses (and a full body clone allocation). The
  extraction now happens inside the routing block, reading from the body
  that was already parsed for model resolution. `recordAgentStat()` is
  also called from that same site, so routed requests still record tool
  stats exactly as before; non-routed paths (`/v1/models`, `/dashboard`,
  dynamic routes) had no tool stats to record in the first place.
- **Incremental cache for `getTokensInWindow`** (`src/utils/dashboard-stats.ts`)
  — `tokenHeatmapEvents` is append-only within the 30-day retention window
  and sorted by ascending timestamp, so events older than the current
  query cutoff are immutable. The function previously did an O(n) scan of
  the entire 30-day array on every call (each call: every active token-
  limit window checks its accumulator). It now caches the sum of all
  events older than the previous cutoff in `windowSumFrozen`, with
  `windowSumCutoff` marking the boundary, and only scans the live tail
  plus absorbs newly-eligible events into the frozen sum on each call.
  Pruning (30-day `shift()`) only removes events outside any query window,
  so the frozen sum is never invalidated. Cold start still pays a single
  O(n) pass to seed the cache; subsequent calls are O(tail length).

### Token Log Persistence Made Opt-In (TUI=1 / DUMP=1)

Token log persistence (the `model_proxy_tokens.jsonl` JSONL file holding
token stats, heatmap data, and composite limit windows) is now gated on
`TUI=true|1` or `DUMP=true|1`. Without one of those flags the proxy
performs no JSONL file I/O at all — no startup restore, no day-rollover
dump, no periodic 30-min dump, no `Ctrl+U` dump.

- **src/utils/dashboard-stats.ts** — added a module-level
  `persistenceEnabled` flag plus `setStatsPersistenceEnabled(enabled)` /
  `isStatsPersistenceEnabled()` exports. `dumpTodayTokens()`,
  `dumpDailyTokens()`, `advanceDaySlotIfNeeded()` (the day-rollover dump
  path), and `loadTokenStatsFromLog()` all early-return when the flag is
  false. The in-memory `recordTokenHeatmapEvent()` 30-day pruning is
  unchanged, so heatmap stats still age out after 30 days; they just
  don't outlive the process.
- **src/server.ts** — computes `persistenceEnabled = TUI || DUMP`,
  calls `setStatsPersistenceEnabled()` once, and wraps the
  `loadTokenStatsFromLog(retentionDays)` call (and its retention-window
  computation) in an `if (persistenceEnabled)` block. The retention
  window is still derived from the configured global / composite token
  limits and falls back to 30 days when no local TOML config is available.
- The live `/dashboard` and TUI views continue to work either way — they
  read from the in-memory state, which is always populated by the request
  hot path regardless of persistence.
- See [README § 3.2 Token Log Persistence](./README.md#32-token-log-persistence)
  for the full behavior.

### Tool Blocklist (TUI `P` key)

Added a Tool Blocklist overlay in the TUI that lists every observed
`(tool, agent)` pair with `req` / `resp` / `len` counters. Press `Enter` to
toggle the block state for the highlighted tool; blocked tools are marked
with a red `✗` and stop accumulating stats (existing pre-block counts are
preserved). Blocklist state is in-memory only and resets at proxy restart.
See the **Tool Blocklist (`P`)** section in README for full details.

### TUI keybinding change

The model test picker's "test all (30m)" / "stop test timer" toggle is now
`W`. The `P` key on the main view now opens the Tool Blocklist overlay.

### Security Hardening

A batch of defensive fixes applied after review of the proxy boundary. All
user-facing behavior changes.

- **SSRF protection on internal sidecar URLs** — `PROXY_CONFIG_URL` (Consul
  config source) and `PRIVACY_FILTER_URL` (PII-redaction sidecar) are now
  validated against a new `isInternalHost()` helper (`src/utils/routing.ts`).
  The URL must resolve to `localhost` / `127.x.x.x`, an RFC-1918 range
  (`10/8`, `172.16/12`, `192.168/16`), a link-local range (`169.254/16`,
  `fe80::/10`), an IPv6 ULA (`fc00::/7`), `*.local` (mDNS), or `::1`.
  Anything else (public DNS names, public IPs, exotic schemes) is rejected
  at startup with a descriptive error. This closes the path where a
  misconfigured or attacker-controlled `PROXY_CONFIG_URL` could be used to
  exfiltrate the proxy's outbound traffic.
- **No request body in client-facing error messages** — `handleTargetApiError`
  (`src/utils/errors.ts`) used to append a 300-char preview of the upstream
  request body to the `invalid_request_error` message returned to the client.
  That body can contain user prompts, tool arguments, or PII. The preview is
  now logged server-side only via `logger.debug('errors', ...)`; the client
  gets a generic message.
- **No internal error messages from SDK handlers** — `handleSdkOpenAIRequest`
  and `handleSdkAnthropicRequest` (`src/utils/sdk-handler.ts`) caught
  exceptions and returned `error.message` verbatim to the caller, which
  could leak stack frames, file paths, or upstream error bodies. They now
  return `"An internal error occurred"`; the original error continues to be
  logged.
- **Stricter `anthropic-beta` header handling** — `validateBetaFeatures()`
  (`src/utils/beta-features.ts`) silently forwarded any unknown beta feature
  name upstream. Unknown features are now dropped. Additionally,
  CRLF/control chars are stripped from the header value before forwarding,
  so a header value like `prompt-caching\r\nX-Injected: 1` cannot be used
  to inject extra response headers.
- **Tighter API-key logging** — the partial-key formatter in
  `transformAuthHeadersForUpstream` (`src/utils/routing.ts`) used
  `first16...last8` for `x-goog-api-key`, `x-api-key`, and `Authorization`.
  Reduced to `first4...` (or `***` if shorter than 4 chars). The previous
  window could expose enough entropy to brute-force the prefix.
- **Hardened host allowlist** — wildcard entries in `ALLOWED_HOSTS`
  (`*.example.com`) now require a literal `.` separator before the domain,
  so `*.example.com` no longer matches the apex `example.com`. The wildcard
  rule now correctly rejects suffixes that are not real subdomains.

### Misc bug fixes (bundled with the hardening pass)

- `crypto.randomUUID()` replaces `Math.random()` for `resp_*` and `msg_*`
  IDs in `completions-to-responses.ts` and `responses.ts`.
- `dashboard.ts` uses `??` (not `||`) for `PROXY_CONFIG_PATH`, so an
  explicitly empty string is preserved as a real path instead of falling
  through to `null`.

### Per-(tool, agent) stats and persistence changes

- `agentToolStats` and `blockedTools` fields are now part of the dashboard
  snapshot (`src/handlers/dashboard.ts`) — `agentToolStats` is built by the
  new `getAgentToolPanelStats()` in `src/utils/dashboard-stats.ts`, which
  joins the three source maps (`agentStats`, `toolRequestChars`,
  `upstreamResponseToolStats`) into a per-(tool, agent) row keyed by
  `${tool}\0${agent}`.
- `recordToolRequestChars()` and `recordUpstreamResponseToolNames()` now
  take an `agent` argument; `createResponseToolTrackingTransformStream()`
  now takes an `agent` argument and threads it into the `flush()` callback.
  The Claude request handler (`src/index.ts`) passes the user-agent prefix
  through both call sites.
- `dumpTodayTokens()` writes a new `toolStats` field (per-(tool, agent) rows
  with `name`, `agent`, `req`, `resp`, `len`, `blocked`) in the JSONL token
  log. `loadTokenStatsFromLog()` restores those rows back into the three
  source maps on startup (latest dump per date wins, and the `blocked` flag
  is applied via `blockTool()` so the blocklist survives a restart).
- The cumulative `modelStats` Map (powers TUI "Top Models" +
  `getModelTotalTokens()`) is now also restored from the latest dump per
  date, and is **accumulated** across the latest per-date dumps (each
  per-date dump is that day's totals, so summing reconstructs true
  all-time). Previously only the daily `modelStats` map was restored, and
  the cumulative map was not restored at all.
- `recordAgentStat()`, `recordToolRequestChars()`, and
  `recordUpstreamResponseToolNames()` short-circuit on `blockedTools` so
  blocked tools no longer grow their counters.
- **Blocked tools are erased from the request body before forwarding**: a
  new `eraseBlockedTools()` helper in `src/utils/tool-blocklist.ts` runs at
  the body-parsing chokepoint in `src/index.ts` (right after the privacy
  filter). It strips tool definitions matching the blocklist from the
  `tools` array, supports the Claude / OpenAI / Gemini shapes, deletes the
  `tools` field entirely if the filter would empty it, and resets
  `tool_choice` to `'auto'` if it forces a blocked tool. Past `tool_use` /
  `tool_result` blocks in message history are intentionally left untouched.

### ChatJimmy SDK Made Optional (2026-06-17)

- **src/utils/sdk-handler.ts**: The submodule is imported through a
  non-literal dynamic specifier, so `tsc` no longer treats it as a static
  build/typecheck dependency. The existing try/catch surfaces a missing
  submodule only when an `sdk://` route is hit at runtime.
- **package.json / tsconfig.json / tsconfig.server.json**: Removed the
  unused `chatjimmy-sdk` `imports` entry and TypeScript `paths` aliases
  (nothing in `src/` imported that alias; the handler references `dist/`
  by relative path).
- **Net effect**: clone, `npm install`, `npm run typecheck`, `npm run
  build`, and `npm run server` all succeed without the submodule. See
  [Optional: ChatJimmy SDK](./README.md#optional-chatjimmy-sdk-sdk-models).

### Model Response Time Tracking

The proxy now tracks per-model response time (min/avg/max in ms) alongside
existing per-endpoint timing.

- **Recording**: `recordModelTiming(modelId, elapsedMs)` is called inside
  `runAttempt()` after each request completes (both success and error),
  using the config key (`attemptModelId`) as the timing key — same key
  used by `recordModelStat`/`recordModelUsage`
- **Storage**: `requestModelTimingStats` map (same shape as
  `requestEndpointTimingStats`: `min_time_ms`, `max_time_ms`,
  `total_time_ms`, `count`)
- **Snapshot**: `getDashboardSnapshot()` and `handleDashboardRequestStats()`
  expose `model_timings` in `requestStats`
- **TUI Custom Models**: each configured model shows `[min/avg/maxs]`
  after its description, resolved by matching `routeModel` (upstream name)
  from the config array
- **TUI Composite Aliases**: each target shows `[min/avg/maxs]` after its
  properties, resolved by matching `routeModel` from `compositeResolved`
- **Dashboard HTML**: Model Statistic table has 3 new columns (min(s),
  avg(s), max(s)) joined from `model_timings` keyed by the resolved
  upstream model name

### Composite Fallback to Default Upstream

Composite aliases now support unresolved target models by falling back to
the default upstream route (`getDefaultModelRoute`) while preserving the
target model as `modelAlias`. This allows aliases such as `code-small` to
route even when the target is not explicitly declared in `models.*`.

### Messages Format Detection Fix (Claude blocks vs OpenAI passthrough)

`/v1/messages` request detection now treats block-style Claude content
(`content: [{type:"text"|"tool_use"|"tool_result"|"thinking", ...}]`) as
Claude format, forcing Claude→OpenAI conversion for `openai-completions`
upstreams. This prevents malformed passthrough payloads to
`/v1/chat/completions`.

### Dashboard Side-Nav Active Style

The active side navigation item in `/dashboard` now has a visible border
(light gray) for clearer section focus.

### Config Reload Endpoint Rename

The config reload endpoint is now `/config-reload` (previously `/reload`).

### Token Counting Toggle Simplification

Removed `LOCAL_TOKEN_COUNTING`. Local token counting is now controlled
only by `LOCAL_TIKTOKEN` (`true`/`1` enables tiktoken-based local
counting). If API-based token counting fails, the proxy falls back to
byte-based counting for user text.

### TOML Parser Regex Order Fix

The `parseSimpleToml()` function in `config-loader.ts` checked
`unquotedMatch` (regex `key = (.+)`) before `arrayMatch` (regex `key =
[...]`). For model IDs containing only hyphens and underscores (e.g.,
`deepseek-v4-flash`), the greedy `unquotedMatch` captured the array
value but silently discarded it since `models` sections are not in its
handling scope. Models with dots (e.g., `gpt-5.4-mini`) were unaffected
because `.` is outside the `[a-zA-Z0-9_-]` character class. Fixed by
swapping the check order — `arrayMatch` is now evaluated before
`unquotedMatch`, with a comment explaining the ordering constraint. This
fixes composite model resolution (e.g., `code-small` → `deepseek-v4-flash`)
where the candidate model key was previously never found in its category.

### Thinking Block Validation Field Fix

`ThinkingBlock` type defines field `thinking: string`, but
`validateClaudeContentBlock()` in `validation.ts` was checking `block.text`
for `type: "thinking"` blocks. This caused validation to throw `text is
required for thinking blocks` when Claude CLI sent requests with thinking
content blocks in assistant messages (the field is `thinking`, not `text`).
Fixed by changing the check to `block.thinking`.

### Upstream Error Diagnostics

The proxy now reads and logs upstream error response bodies in
`handleClaudeRequest` before throwing, making it possible to diagnose
API-level errors (e.g., DeepSeek returning 400 about thinking mode).

### DeepSeek Thinking Mode Compatibility

Some upstreams (e.g., DeepSeek's Anthropic-compatible API) internally
default models to thinking mode and require prior `content[].thinking`
blocks in the conversation even on the first request. The proxy now:

- Defaults `thinking` to `disabled` when the client doesn't set it
- Strips `thinking: { type: "enabled" }` when there are no prior
  assistant thinking blocks in the conversation history (avoids 400
  errors on first requests)

### Full Request Body Logging

Added debug-level logging of the full request body sent to upstreams in
`handleClaudeRequest` for easier troubleshooting.

### Thinking Signature Support & Streaming Improvements

- **Signature Delta Events**: Added full `signature_delta` support for
  thinking block verification in streaming
- **OpenAI-to-Claude Conversion**: Enhanced conversion of OpenAI's
  `reasoning_item_id` and `signature` to Claude's thinking format
- **Streaming Thinking Extraction**: Improved thinking content extraction
  from `<thinking>` markers and `reasoning_content` fields
- **Thinking Block Lifecycle**: Proper `content_block_start/delta/stop`
  events for thinking blocks in streaming

### Gemini `:countTokens` Endpoint

Added routing for `POST /v1beta/models/{model}:countTokens` and
`POST /v1/models/{model}:countTokens`. The request body is proxied as-is
to the upstream Gemini API and the raw JSON response (`totalTokens`) is
returned. Previously these paths fell through to an "Unsupported fixed
route" error (HTTP 500).

### OpenAI Handler Error Propagation Fix

`handleOpenAIRequest` previously threw a plain `Error` on upstream
non-2xx responses, which the outer error handler converted to HTTP 500
regardless of the actual upstream status. For streaming requests, it
silently returned HTTP 200 with the error wrapped in an SSE frame. Both
paths now use `handleTargetApiError()`, propagating the correct upstream
status code (401, 403, 429, etc.) to the client — matching the behavior
of the Claude and Gemini handlers.

---

## 2026-03-04 — ChatJimmy SDK Integration

**Optional, lazily-loaded submodule**: ChatJimmy SDK lives in
`submodules/chatjimmy` and is loaded at runtime via dynamic import only
when an `sdk://` model is requested. It is not required to build or run
the proxy.

**SDK Handler**: `src/utils/sdk-handler.ts` provides SDK-based request
handling:

- **SDK URL detection**: `sdk://` URLs use chatjimmy SDK clients instead
  of HTTP fetch
- **OpenAI-compatible mode**: `handleSdkOpenAIRequest()` uses
  `OpenAICompatibleClient`
- **Anthropic-compatible mode**: `handleSdkAnthropicRequest()` uses
  `OpenAICompatibleClient` as fallback
- **Streaming support**: SDK Anthropic stream is converted from OpenAI
  chunks to Claude SSE event format (`message_start`, `content_block_*`,
  `message_delta`, `message_stop`)
- **Streaming fallback**: If SDK stream is unavailable, falls back to
  non-stream response

---

## 2026-03-03 — Enhanced Thinking Configuration

- **Type Definitions**: Updated `ThinkingConfigParam` type to accept
  `boolean` values (`true`/`false`) in addition to string values
  (`"enabled"`/`"disabled"`)
- **Normalization Utility**: Added `normalizeThinkingConfig()` function to
  standardize thinking config across the codebase
- **Token Counting**: Updated token counting logic to handle boolean
  thinking types
- **Validation**: Enhanced validation to accept boolean values while
  maintaining backward compatibility

## 2026-03-03 — Thinking Signature Support

- **Signature Delta Events**: Added `"signature_delta"` to
  `ClaudeStreamEvent.delta.type` for streaming signature verification
- **Streaming Signature Emission**: Implemented `signature_delta` event
  emission before `content_block_stop` for thinking blocks
- **Signature Accumulation**: Accumulates signatures from multiple
  sources: `delta.signature`, `reasoning_item_id`, and `signature` fields
- **OpenAI-to-Claude Conversion**: Converts OpenAI's `reasoning_item_id`
  and `signature` to Claude's `signature_delta` format
- **Anthropic Pass-Through**: Passes through `signature_delta` events
  from Anthropic upstream unchanged
- **Non-Streaming Compatibility**: Includes signature in thinking block
  metadata for non-streaming responses

**Files modified** (covers the Model Response Time Tracking, Thinking
Signature Support, and adjacent changes):

- `src/utils/dashboard-stats.ts` — added `requestModelTimingStats` map,
  `recordModelTiming()`, `getRequestModelTimingStatsDesc()`
- `src/index.ts` — `recordModelTiming(attemptModelId, elapsedMs)` called
  inside `runAttempt()` for all requests
- `src/handlers/dashboard.ts` — `model_timings` in snapshot/API, 3 new
  columns (min/avg/max) in HTML model stats table and CSV export
- `src/tui.ts` — timing display (`[min/avg/maxs]`) in Custom Models
  section and Composite Aliases overlay
- `src/types/claude.ts` - Added `"signature_delta"` to stream event types
- `src/converters/streaming.ts` - Added signature accumulation and
  emission logic
- `src/converters/openai-to-claude.ts` - Enhanced signature extraction
  from response metadata

## 2026-03-03 — Gemini v1 Endpoint Support

- **Path Pattern Matching**: Updated regex patterns to support both
  `/v1beta/models/` and `/v1/models/` endpoints
- **URL Building**: Enhanced URL construction logic for both v1beta and
  v1 endpoints
- **Model Extraction**: Improved model ID extraction from both endpoint
  versions

## 2026-03-03 — API Key Management

- **Priority Logic**: Added intelligent API key priority based on
  upstream mode
- **Format Utility**: Created `formatApiKeyForUpstream()` function for
  consistent header formatting
- **Header Transformation**: Enhanced
  `transformAuthHeadersForUpstream()` to handle `Bearer` prefix stripping
- **Configuration Integration**: Better integration of config API keys
  with request processing

**Files modified** (covers the Enhanced Thinking Configuration, Gemini v1
Endpoint Support, and API Key Management changes):

- `src/converters/claude-to-gemini.ts` - Added boolean thinking support
  for Gemini conversion
- `src/converters/claude-to-openai.ts` - Added boolean thinking support
  for OpenAI conversion
- `src/index.ts` - Enhanced routing for v1 endpoints, API key priority
  logic
- `src/types/claude.ts` - Updated ThinkingConfigParam type definition
- `src/utils/routing.ts` - Added `formatApiKeyForUpstream()`, enhanced
  path matching
- `src/utils/thinking.ts` - Added normalization utility, updated all
  thinking functions
- `src/utils/token-counting.ts` - Updated to handle boolean thinking
  types
- `src/utils/validation.ts` - Enhanced validation for boolean thinking
  values

---

## 2026-02-28 — Gemini CLI Config Integration

Successfully tested proxy using **Gemini CLI configuration** from
`~/.gemini/.env`. All models work with the CLI's base URL and API key
settings.

**Gemini CLI Config Test Results:**

| Test Suite       | Models Tested | Passed | Success Rate |
|------------------|---------------|--------|--------------|
| Basic Models     | 10            | 9      | 90%          |
| Gemini Models    | 3             | 3      | 100%         |
| Claude Models    | 6             | 5      | 83.3%        |
| Thinking Models  | 10            | 7      | 70%          |
| **Total**        | **29**        | **24** | **82.8%**    |

**Basic Models (90% success):**

- deepseek/deepseek-v3.1
- deepseek-r1
- minimax/minimax-m2.1
- moonshotai/kimi-k2.5
- minimax/minimax-m2.5
- qwen3-32b
- deepseek/deepseek-v3.2-exp
- z-ai/glm-4.7
- moonshotai/kimi-k2-0905
- z-ai/glm-5 (upstream issue)

**Gemini Models (100% success):**

- gemini-2.5-flash
- gemini-3.1-pro-preview
- gemini-3.0-flash-preview

**Claude Models (83.3% success):**

- claude-4.6-sonnet
- claude-4.5-opus
- claude-4.5-haiku
- claude-4.0-sonnet
- claude-3.7-sonnet
- claude-4.1-sonnet (invalid request)

**Thinking Models (70% success):**

- deepseek/deepseek-v3.2-exp-thinking
- deepseek/deepseek-v3.1-terminus-thinking
- deepseek-r1-0528
- qwen3-30b-a3b-thinking-2507
- qwen3-next-80b-a3b-thinking
- doubao-1.5-thinking-pro
- moonshotai/kimi-k2-thinking
- qwen3-vl-30b-a3b-thinking (upstream unavailable)
- qwen3-235b-a22b-thinking-2507 (upstream unavailable)
- doubao-seed-1.6-thinking (upstream unavailable)

**Key Findings:**

- Proxy works seamlessly with Gemini CLI config (`~/.gemini/.env`)
- Uses `GOOGLE_GEMINI_BASE_URL` and `GEMINI_API_KEY` from CLI config
- 82.8% overall success rate across 29 models from 6+ providers
- All Gemini models (100%) and most Claude models (83.3%) working
- All thinking models show step-by-step reasoning
- SSE streaming: complete message boundaries guaranteed (fixed 2026-03-02)
- 5 failures: 1 upstream issue, 1 invalid request, 3 unavailable models

**Test scripts:**

- `test_gemini_cli.sh` - Basic models test (10 models)
- `test_gemini_models_cli.sh` - Gemini models test (3 models)
- `test_claude_models_cli.sh` - Claude models test (6 models)
- `test_thinking_cli.sh` - Thinking models test (10 models)

## 2026-02-28 — Unconfigured Models Validated

Successfully tested proxy with **no specific model IDs configured** in
`proxy_config.toml`. All models used fallback configuration from
`[models.default]` and `[upstream]` sections.

**Test Results: 100% Success (24/24 tests passed)**

| Test Suite      | Models | Tests | Passed | Success Rate |
|-----------------|--------|-------|--------|--------------|
| DeepSeek Models | 2      | 6     | 6      | 100%         |
| Thinking Models | 4      | 12    | 12     | 100%         |
| SSE Streaming   | 2      | 6     | 6      | 100%         |
| **Total**       | **8**  | **24**| **24** | **100%**     |

**Key Findings:**

- Unconfigured models work perfectly with default settings
- All 3 endpoints supported: `/v1/messages`, `/v1/interactions`,
  `generateContent`
- SSE streaming works for all endpoints
- Thinking/reasoning models work without special configuration
- Fallback chain validated: `[models.default]` → `[upstream]` →
  hardcoded defaults

See `docs/test_results_unconfigured_models.md` for complete details.

## 2026-02-28 — ENV Variables Removed

Removed `FIXED_ROUTE_TARGET_URL` and `FIXED_ROUTE_PATH_PREFIX` environment
variables. All configuration now in `proxy_config.toml`:

**Configuration hierarchy for unconfigured models:**

```
1. [models.default].upstream_mode / base_url / api_key
   ↓ (if missing)
2. [upstream].upstream_mode / default_base_url / default_api_key
   ↓ (if missing)
3. Configurable fallback: "openai-completions" / "https://api.qnaigc.com"
   (hardcoded in src/utils/config-loader.ts, src/index.ts, and src/tui.ts;
    override by setting [upstream].default_base_url or [models.default].base_url
    in proxy_config.toml — there is no env var to override this final fallback)
```

See `docs/config_env_removal.md` for migration guide.

## 2026-02-27 — Config Structure Updated

The routing logic and configuration structure have been revised to align
implementation with documentation:

- **Category-based config**: Models grouped by provider with inheritance
- **Array format**: `["model-alias", "base-url", "api-key"]` with empty
  string inheritance
- **Explicit upstream_mode**: `anthropic-messages`,
  `gemini-generatecontent`, `openai-completions`
- **No normalization**: Model names preserved as-is (e.g.,
  `"deepseek/deepseek-v3.2"`)

See `docs/routing_config_revision.md` for complete details.

## 2026-02-25 — Comprehensive Testing (Production Ready)

See [README.md § Testing](./README.md#-testing) for the consolidated test
result tables and provider success rates. Detailed per-suite breakdowns
live in `docs/test_results_*.md` and `docs/*_test_results.md`.
