# Plan: Split Codebase into Cloudflare Worker Proxy and Local Proxy

## Date: 2026-08-28
## Status: Draft

## Motivation

The codebase is already dual-target: `src/index.ts` is a Workers-style fetch
handler and `src/server.ts` is a Node adapter wrapping it. Local-only features
(key store, file config, TUI, dashboard, data dump) are gated by
`isNodeEnvironment` checks scattered across shared modules. Problems:

- Gates hide coupling; a Worker deploy silently skips local features instead
  of the code living in the right package.
- Worker bundle carries dead code (fs imports, TUI-adjacent code, key store).
- Local features (keytar native module) make the Worker build fragile.

## Goal

Two deployables, one shared core:

1. **`worker`** — Cloudflare Worker proxy. Routing/transform core only.
   Config from Consul URL or a Worker-accessible source. No fs, no keychain,
   no TUI, no dashboard, no data dump.
2. **`local`** — Node proxy on user machines. Everything the project has
   today: file/Apollo/Consul config, OS key store (keytar), tiktoken local
   counting, TUI, web dashboard, token-log data dump, heatmap.

## Target Architecture

### Directory tree

```
model_proxy_v3/
├── package.json                  # npm workspaces root: ["packages/*"]
├── tsconfig.json                 # base TS config, extended by each package
├── tests/                        # unit tests (run against packages/core)
├── proxy_config*.toml            # user config lives at repo/user level, used by local only
├── docs/                         # unchanged
│
├── packages/
│   ├── core/                     # Runtime-agnostic shared library (NO fs/os/http/keytar imports)
│   │   ├── package.json          # name: @model-proxy/core; deps: js-tiktoken, safe-stable-stringify, fast-safe-stringify
│   │   ├── tsconfig.json
│   │   └── src/
│   │       ├── index.ts          # public API barrel (createProxyRouter, parsers, types)
│   │       ├── router.ts         # extracted from current src/index.ts: dispatch, auth,
│   │       │                     # pipeline, composite/fusion routing — everything except
│   │       │                     # dashboard/admin routes
│   │       ├── converters/       # claude-to-openai, openai-to-claude, claude-to-gemini,
│   │       │                     # gemini-to-claude, openai-to-gemini, gemini-streaming,
│   │       │                     # streaming, responses-to-completions, completions-to-responses
│   │       ├── handlers/         # messages, claude, gemini, openai, responses,
│   │       │                     # chat-completions, embeddings, models, token-counting
│   │       │                     # (dashboard.ts is NOT here)
│   │       ├── types/            # claude.ts, openai.ts, gemini.ts, shared.ts (incl. Env)
│   │       └── utils/
│   │           ├── routing.ts, errors.ts, validation.ts, thinking.ts
│   │           ├── token-counting.ts   # js-tiktoken/lite + rank tables
│   │           ├── logger.ts, stringify.ts, beta-features.ts
│   │           ├── fetch-timeout.ts, conversation-store.ts, sdk-handler.ts
│   │           ├── kompress.ts, privacy-filter.ts, image-fetch.ts
│   │           ├── coordinator.ts, provider-quota.ts, hash-detect.ts
│   │           ├── tool-blocklist.ts, model-usage-recorder.ts
│   │           ├── request-transform.ts
│   │           ├── consul-loader.ts     # pure fetch + parse (Worker-usable)
│   │           ├── key-sentinels.ts     # findSentinelApiKeys + KeyStoreError (from key-store.ts)
│   │           ├── config/
│   │           │   ├── parse.ts         # parseSimpleToml → ProxyConfig (SPLIT of config-loader.ts)
│   │           │   ├── validate.ts      # validateProxyConfig, alias stripping/validation
│   │           │   └── types.ts         # ProxyConfig, ModelRouteConfig, FusionPlan, ...
│   │           └── stats/
│   │               └── memory.ts        # in-memory counters/recorders (SPLIT of dashboard-stats.ts)
│   │
│   ├── worker/                   # Cloudflare Worker deployable
│   │   ├── package.json          # name: @model-proxy/worker; depends on @model-proxy/core
│   │   ├── wrangler.toml         # moved from repo root; LOCAL_TIKTOKEN=false; config via
│   │   │                         # PROXY_CONFIG_CONSUL / PROXY_CONFIG_URL; API keys as secrets
│   │   └── src/
│   │       ├── index.ts          # `export default { fetch }` — thin: env → config source →
│   │       │                     # core router; 404 for dashboard/admin paths
│   │       └── config-source.ts  # Consul-URL / fetch-URL config loader composing core parsers
│   │
│   └── local/                    # Node deployable on user machines ("model-proxy-v3" npm bin)
│       ├── package.json          # name: model-proxy-v3; depends on @model-proxy/core;
│       │                         # optionalDependencies: @github/keytar (file:../../submodules/node-keytar)
│       ├── tsconfig.server.json  # moved from repo root
│       ├── Dockerfile            # moved from repo root
│       ├── docker-compose.yml    # moved from repo root
│       └── src/
│           ├── server.ts         # Node http adapter wrapping core router (from src/server.ts)
│           │                     # + dashboard/admin route registration
│           ├── tui.ts            # unchanged (imports key-store, config, quota — all local)
│           ├── heatmap.ts
│           ├── handlers/
│           │   └── dashboard.ts  # /dashboard page + /dashboard/api/* (moved from core handlers)
│           └── utils/
│               ├── key-store.ts        # keytar + fs; consumes core key-sentinels
│               ├── apollo-loader.ts    # fs + os + crypto
│               ├── config-file-source.ts  # fs read/write proxy_config.toml, atomic rename,
│               │                         # homedir default, applySystemKeyStore
│               ├── stats-persistence.ts   # model_proxy_tokens.jsonl write/replay
│               └── admin-routes.ts        # /config-reload + dashboard auth (from src/index.ts)
```

### Package responsibilities

| Package | Runtime | Depends on | Contains |
|---|---|---|---|
| `@model-proxy/core` | Any (Node 19+ or Workers) | js-tiktoken, stringify libs only | Router, all endpoint handlers except dashboard, all converters, config parsing/validation, in-memory stats, fetch-based utils |
| `@model-proxy/worker` | Cloudflare Workers | core | Thin fetch entry + URL-based config source + wrangler.toml. Deployed with `wrangler deploy` |
| `model-proxy-v3` (local) | Node | core, keytar (optional) | Node server adapter, dashboard (web + TUI), heatmap, OS key store, file/Apollo config sources, token-log persistence, Docker |

### Structure rules

1. `core` imports only Web-standard APIs (`fetch`, `ReadableStream`, `crypto.subtle`, `TextEncoder`). No `fs`, `os`, `http`, `process`, `keytar`. Enforced in CI.
2. `worker` and `local` may import from `core`, never from each other.
3. Anything that reads/writes the user's machine (filesystem, keychain, terminal, homedir) belongs to `local` only.
4. Config flows in as plain parsed objects (`ProxyConfig`) — sources (file, Consul, Apollo, URL) are per-package adapters that produce TOML text for the single core parser.
5. Shared state (conversation store, stats memory, config cache) lives in core as in-process state; only `local` guarantees a single long-lived process, so `worker` documents per-isolate semantics.

## Module Assignment (current `./src`, file by file)

### `src/converters/` → `packages/core/src/converters/` (all unchanged)

| Current file | Destination | Notes |
|---|---|---|
| `claude-to-openai.ts` | core | also exports `budgetToReasoningEffort` used by sdk-handler |
| `openai-to-claude.ts` | core | uses local token counting as fallback |
| `claude-to-gemini.ts` | core | |
| `gemini-to-claude.ts` | core | |
| `openai-to-gemini.ts` | core | |
| `gemini-streaming.ts` | core | |
| `streaming.ts` | core | Web `ReadableStream` transformers |
| `responses-to-completions.ts` | core | |
| `completions-to-responses.ts` | core | |

### `src/types/` → `packages/core/src/types/` (all unchanged)

`claude.ts`, `openai.ts`, `gemini.ts`, `shared.ts` (incl. `Env`).

### `src/handlers/` → split

| Current file | Destination | Notes |
|---|---|---|
| `messages.ts` | core | imports sdk-handler, routing, request-transform (type-only config dep) |
| `claude.ts` | core | uses provider-quota (fetch-based) |
| `gemini.ts` | core | |
| `openai.ts` | core | |
| `responses.ts` | core | uses conversation-store (in-memory) |
| `chat-completions.ts` | core | |
| `embeddings.ts` | core | |
| `models.ts` | core | |
| `token-counting.ts` | core | js-tiktoken gated by `LOCAL_TIKTOKEN` |
| `dashboard.ts` | **local** `src/handlers/` | `/dashboard` page + `/dashboard/api/*` (config GET/PUT, stats, test-model, quota, schedule alias, tools blocklist) |

### `src/utils/` → split

| Current file | Destination | Notes |
|---|---|---|
| `routing.ts` | core | auth extraction, URL building, header sanitize |
| `errors.ts` | core | |
| `validation.ts` | core | |
| `thinking.ts` | core | |
| `beta-features.ts` | core | |
| `fetch-timeout.ts` | core | AbortSignal-based |
| `logger.ts` | core | |
| `stringify.ts` | core | JSON / safe-stable / fast-safe switch |
| `token-counting.ts` | core | `js-tiktoken/lite` + rank tables; see Bundle Size decision |
| `conversation-store.ts` | core | in-memory `Map`, env-gated (`CONVERSATION_STATE`) |
| `sdk-handler.ts` | core | fetch-based chatjimmy/SDK URL handling |
| `kompress.ts` | core | fetch-based |
| `privacy-filter.ts` | core | fetch-based |
| `image-fetch.ts` | core | fetch-based |
| `coordinator.ts` | core | |
| `provider-quota.ts` | core | |
| `hash-detect.ts` | core | |
| `tool-blocklist.ts` | core | |
| `model-usage-recorder.ts` | core | remote recording via fetch |
| `request-transform.ts` | core | hooks pipeline (`runHook`, `applyAfterUpstream`) |
| `consul-loader.ts` | core | pure fetch + parse — Worker-usable |
| `config-loader.ts` | **split** | parse/validate/alias-strip → `core/src/utils/config/{parse,validate,types}.ts`; fs read/write (atomic rename, homedir), Apollo branch, `applySystemKeyStore` call → `local/src/utils/config-file-source.ts` |
| `dashboard-stats.ts` | **split** | in-memory counters/recorders + window logic → `core/src/utils/stats/memory.ts`; `writeFileSync` to `model_proxy_tokens.jsonl` + `loadTokenStatsFromLog` + `setStatsPersistenceEnabled` → `local/src/utils/stats-persistence.ts` |
| `key-store.ts` | **split** | `findSentinelApiKeys`, `KeyStoreError`, `STORE_KEY_IN_SYSTEM` → `core/src/utils/key-sentinels.ts` (so Worker hard-fails on sentinels, current behavior at `config-loader.ts:2536-2542`); keytar + fs keychain logic → `local/src/utils/key-store.ts` |
| `apollo-loader.ts` | **local** `src/utils/` | `node:crypto` (HMAC), `node:os` (networkInterfaces), fs |

### `src/` root files → split

| Current file | Destination | Notes |
|---|---|---|
| `index.ts` | **split** | model-API router + dispatch + auth + composite/fusion pipeline → `core/src/router.ts` (used by worker entry); `/dashboard*`, `/config-reload`, dashboard auth (index.ts:705-895) → `local/src/utils/admin-routes.ts` |
| `server.ts` | **local** `src/server.ts` | Node `http` adapter; keeps env assembly + `setStatsPersistenceEnabled(true)` |
| `tui.ts` | **local** `src/tui.ts` | imports config-loader, key-store, provider-quota, heatmap directly — must live with them |
| `heatmap.ts` | **local** `src/heatmap.ts` | used only by TUI |

### Repo root files

| Current file | Destination | Notes |
|---|---|---|
| `wrangler.toml` | `packages/worker/wrangler.toml` | drop `LOCAL_TIKTOKEN=true`; config via `PROXY_CONFIG_CONSUL`/`PROXY_CONFIG_URL` |
| `worker.js` | delete (superseded by `packages/worker/src/index.ts`) | currently an unrelated OpenRouter free-model filter |
| `Dockerfile`, `docker-compose.yml`, `build_image.sh`, `tsconfig.server.json` | `packages/local/` | local deployment artifacts |
| `init-proxy-config-in-consul-server.sh` | repo root (unchanged) | publishes config to Consul for both packages |
| `discovery_openrouter.sh` | repo root (unchanged) | model discovery tool |
| `submodules/node-keytar` | unchanged | referenced by `local` optionalDependency |
| `proxy_config*.toml`, `model_proxy_tokens.jsonl` | repo/user level, used by `local` only | |
| `tests/` | repo root | runs against `packages/core` |

## Key Design Decisions

### 1. Config loader: parser in core, sources injected

Today `loadProxyConfig(env)` branches on Apollo (fs) / Consul (fetch) / file
(fs or fetch-by-URL). Split into:

- **core**: `parseProxyConfig(toml: string)`, `validateProxyConfig`, alias
  stripping/validation — pure functions over strings/objects.
- **local**: file source (read/write `proxy_config.toml`, atomic rename,
  homedir default), Apollo source, key-store application
  (`applySystemKeyStore`).
- **worker**: Consul source (already fetch-based) and/or a
  `PROXY_CONFIG_URL` fetch source; sentinels hard-fail (existing behavior).

`loadProxyConfig(env)` survives as a convenience wrapper in each package
composing core + its own sources.

### 2. Stats: in-memory in core, persistence in local

`dashboard-stats.ts` keeps its in-memory counters in core (handlers call
`recordModelStat` etc. per request). The `writeFileSync`/`readFileSync`
persistence behind `setStatsPersistenceEnabled` moves to a local-only
adapter. On Worker, stats remain per-isolate and best-effort — documented
limitation, no Durable Objects in this phase.

### 3. tiktoken / bundle size

`js-tiktoken` ranks (o200k, cl100k, p50k, gpt2) are multi-MB of bundled
data. Worker package defaults to `LOCAL_TIKTOKEN=false` (character
estimation); local package keeps full ranks. If accurate counting is later
needed on Worker, lazy-load a single encoding from a bundled asset or KV —
deferred.

### 4. Dashboard/admin routes are local-only

`/dashboard*`, `/config-reload` and dashboard auth (`index.ts:705-895`)
move to the local entry. On Worker these paths return 404. The TUI and web
dashboard are local features by definition (they edit the local config file
and read the local token log).

### 5. Dependency direction

`core` must not import from `worker`/`local`, and must contain no
`fs`/`os`/`http`/`keytar` imports. Enforced by a lint/CI check (e.g. a
grep-based guard or `dependency-cruiser` rule) so the gates do not
re-accumulate.

## Migration Plan

Each phase leaves the repo buildable and tests green.

### Phase 1 — Extract `packages/core` (mechanical)
1. Move converters, types, portable utils, non-dashboard handlers into
   `packages/core` with path-only changes.
2. Split `config-loader.ts` (parser vs sources) and `dashboard-stats.ts`
   (memory vs persistence) per decisions 1-2.
3. Root `src/` keeps thin re-export shims so `npm run server`,
   `wrangler dev`, and existing imports keep working.
4. Verify: `npm run typecheck`, `npm run test:unit`, local smoke test.

### Phase 2 — `packages/worker`
1. Move router/model-API pipeline out of `index.ts` into
   `packages/worker/src/index.ts`; exclude dashboard/admin routes.
2. Move `wrangler.toml`, set `LOCAL_TIKTOKEN=false`, add
   `PROXY_CONFIG_URL`/Consul source.
3. Verify: `wrangler dev` smoke (`/health`, `/v1/models`, streaming
   `/v1/messages`), `wrangler deploy` to a staging Worker, check bundle
   size report for fs/tui/key-store leakage.

### Phase 3 — `packages/local`
1. Move `server.ts`, `tui.ts`, `heatmap.ts`, `dashboard.ts`, `key-store.ts`,
   `apollo-loader.ts`, fs config source, stats persistence.
2. Wire dashboard/admin routes into the local entry (composition, not
   conditionals).
3. Move `Dockerfile`, `docker-compose.yml`, npm `bin` entry
   (`model-proxy-v3`) here.
4. Delete the now-unused root `src/` shims and root `wrangler.toml`.
5. Verify: Docker build, TUI run, dashboard config edit persists to
   `proxy_config.toml`, token log dump/replay works.

### Phase 4 — Tooling and docs
1. Workspace scripts at root: `dev:local`, `dev:worker`, `test`, `build`.
2. Update `README.md`, `CHANGELOG.md`, `../getting-started/configuration-guide.md`
   (which env vars exist on which package).
3. CI: core-import guard + `wrangler deploy --dry-run` + unit tests.

## Verification Plan

- **Unit tests** (`tests/unit`) run against `packages/core` — unchanged
  expectations, they already test parsing/conversion/routing.
- **Worker smoke**: `wrangler dev` → `/health` 200, `/v1/models` returns
  configured models, non-streaming + streaming `/v1/messages` against a real
  upstream, `/dashboard` returns 404, key sentinels in config hard-fail at
  load.
- **Local smoke**: `npm run server` + TUI, dashboard stats reflect
  requests, `/config-reload` picks up TOML edits, `model_proxy_tokens.jsonl`
  grows, restart replays token stats.
- **Bundle audit**: `wrangler deploy --dry-run --outdir` shows no
  `node:fs`/keytar/pi-tui modules in the Worker graph.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `index.ts` router and dashboard routes are interleaved in one function | Extract a route table / handler-registry in core; each entry registers its own routes (Phase 2's main refactor) |
| TUI imports config-loader/key-store directly | TUI lives in `local` where those live; no cross-package import |
| Sentinel detection duplicated | Keep `findSentinelApiKeys` in core; local key-store consumes it |
| Config semantics drift between packages | Single parser + validator in core; sources only produce TOML text |
| keytar postinstall breaks Worker CI installs | `@github/keytar` becomes optionalDependency of `local` only; Worker/CI never install it |
| Existing docs reference `src/` paths | Phase 4 sweep of docs/README |

## Success Criteria

1. `wrangler deploy` from `packages/worker` yields a working proxy with no
   local-only modules in the bundle.
2. `npm run server` from `packages/local` is feature-identical to today
   (config file, Apollo/Consul, key store, TUI, dashboard, token log,
   heatmap).
3. `packages/core` contains zero Node-only imports (CI-enforced).
4. All existing unit tests pass against core without modification.
5. Installing/running the Worker package requires no native modules.
