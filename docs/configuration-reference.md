# Configuration Reference

Most users only need `proxy_config.toml`. Optional environment variables tune behavior.
On the Node server (`npm run server` / `dist/server.js`) these come from the process
environment.

## `[general]` config fields

| Field | Example | Purpose |
|---|---|---|
| `global_token_limit` | `"1B 1d"` | Token cap across all models, queried against a sliding or calendar window. Format: `"<num><K/M/B/T> <duration>"`. Sliding durations: `1h`–`23h`, `1d`–`6d` (rolling from now). Calendar durations: `1w` (calendar week, anchored to `week_start_day`), `1m` (calendar month, anchored to first of month). Returns HTTP 413 when exceeded. |
| `week_start_day` | `"monday"` | Anchor day for `1w` calendar windows. `"monday"` (default) or `"sunday"`. Applies to both global and composite limits. |
| `budget_to_effort_low` | `32768` | Thinking-budget threshold (tokens) below which `reasoning_effort: "low"` is emitted for upstreams that use effort levels instead of token budgets. |
| `budget_to_effort_medium` | `65536` | Threshold above `low` and below this → `reasoning_effort: "medium"`. |
| `budget_to_effort_high` | `128000` | Threshold above `medium` → `reasoning_effort: "high"`. Set to `0` to always emit `"high"`. |
| `store_key_in_system` | `true` | Store config `api_key` values in the OS keychain (macOS Keychain / Windows Credential Vault / Linux Secret Service). Applies ONLY to configured api_keys of `[models.*]` targets (and `[default_upstream].default_api_key`) in the local `proxy_config.toml` file — not to Consul/Apollo config-center sources (flag ignored there; a `STORE_KEY_IN_SYSTEM` sentinel in a Consul/Apollo config is a fatal load error), not to composite/schedule aliases (they carry no api_key), and never to caller/user keys from request headers (empty api_key = auth passthrough is skipped). On config load, plaintext keys are saved under the `model_proxy_v3` service with account `<target_model_id>/<base_url>`, and the config file is rewritten (backup: `<config>.bak`) replacing each key with the literal `STORE_KEY_IN_SYSTEM` sentinel; sentinels are resolved back from the keychain on every later load. On an exact-account miss the resolve pass falls back to a best-effort match over all accounts under the service, scored by base_url similarity (prefix relation, e.g. `glm-5.3/https://…/api` can serve a wanted `glm-5.3-anth/https://…/api/anthropic`; base_url dominates, target-name similarity tiebreaks) and logs a warning per fallback; when nothing matches, that one slot is cleared (treated as unconfigured, so the normal api_key fallback chain applies) and reported as a config error in the TUI/dashboard/console — it is NOT fatal, so the remaining models still load and the proxy still starts. (The keychain itself being unavailable, or per-item access being denied, is still a fatal `KeyStoreError`.) Local/dev-host feature only — requires the `@github/keytar` native addon, pinned in `optionalDependencies` as `github:github/node-keytar#v7.10.6`: `npm install` fetches it from GitHub and its install script downloads a prebuilt NAPI binary (ABI 3 — works on any modern Node, no compiler or Python needed; node-gyp compiles from source only as the fallback when the prebuilt download fails, e.g. no network access to GitHub releases); if startup fails with `Cannot find package '@github/keytar'`, first check `git diff package.json` — npm prune-style runs (`--dry-run --omit=dev`, `--production`) can strip the `optionalDependencies` block, after which no `npm install` ever re-fetches the addon; restore with `git checkout -- package.json && npm install`. A source copy of the addon is kept at `submodules/node-keytar` for local development — it is NOT used by `npm install`. Fails loud (refuses to start) when the keychain is unavailable, e.g. in Docker or Cloudflare Workers (the Dockerfile installs with `--omit=optional --ignore-scripts`). Keychain access itself is silent — macOS grants read access per-item to whichever binary wrote it, so the same `node` binary/path resolves sentinels without a password prompt on every run. Upgrading Node (or invoking through a different binary path, e.g. `npx` vs. a global install) changes that code identity: macOS may show a one-time keychain access prompt for the new binary, or in stricter setups silently deny access — surfacing here as a fatal `KeyStoreError` rather than a prompt. |

## `[default_upstream]` config fields

| Field | Example | Purpose |
|---|---|---|
| `default_base_url` | `"https://api.example.com"` | Global upstream endpoint fallback when a route has no per-entry or section `base_url`, and for models not claimed by any `[models.*]` section. |
| `default_api_key` | `"sk-..."` | Global configured-key fallback. In `user_key` mode (default): wins only for `[models.FREE]`, acts as a fallback for other sections when the caller sends no key. In `config_key` mode: used for all models that have no per-entry or section `api_key`. Typically left unset in production. |
| `upstream_mode` | `"openai-completions"` | Default protocol for models not claimed by any `[models.*]` section. |

## `[remote.authentication]` config fields

| Field | Example | Purpose |
|---|---|---|
| `auth_server` | `"https://auth.example.com/validate"` | If set, every inbound request's proxy auth headers (`Authorization`, `x-api-key`, `x-goog-api-key`) plus `User-Agent` are validated by a `GET` to this URL before routing. HTTP 200 = pass; 4xx/5xx = 401 to client; network error = 503. **Exempt paths:** `/health`, `/`, `/dashboard`, and `/v1/models` (model listing is unauthenticated so SDKs can enumerate without a credential). |
| `auth_with_model` | `false` | When `true`, the `auth_server` call is deferred until after the request body is parsed so the requested model id can be forwarded as `x-resource-for` header. Allows the auth server to make per-model decisions. Default: `false` (auth runs before body parsing). |
| `auth_with_body` | `false` | When `true`, the `auth_server` call is deferred until after body parsing and the entire parsed request body is forwarded to the auth service as the `POST` body (raw JSON). Either `auth_with_model` or `auth_with_body` triggers the deferred path. See [Auth & Stats Service Protocol](./auth-stats-protocol.md). |
| `auth_passthrough_with` | `"user_key"` | Standalone upstream-auth setting, separate from `auth_server` / `auth_with_model`. Controls which key is passed to the upstream provider: `"user_key"` (default) forwards the caller's key; `"config_key"` uses the configured `api_key`. |

## `[remote.recording]` config fields

| Field | Example | Purpose |
|---|---|---|
| `record_server` | `"http://127.0.0.1:8080/model-usage"` | Optional HTTP collector. When set, the proxy POSTs per-request usage records with `request_id`, `endpoint`, raw `user_key`, `model`, `response_status`, and token counters (`input_tokens`, `cached_tokens`, `cache_written_tokens`, `output_tokens`, `total_tokens`). |
| `record_response_body` | `false` | When `true`, each usage record also includes the constructed `response_body` (parsed JSON for non-streaming responses; accumulated raw SSE text for streaming; the upstream error body for non-2xx). Sent raw, not base64. See [Auth & Stats Service Protocol](./auth-stats-protocol.md). |

## `[transforms.*]` and `[transform_defaults]` config fields

Per-model/per-upstream request and response rewriting. Each named set is declared as
`[transforms.<name>]` and referenced from model entries via `transforms = "set_name"` (CSV
string for multiple sets: `transforms = "set_a,set_b"`). **List form (`transforms = ["a","b"]`)
is not supported** — use a comma-separated string. See `docs/transforms-reference.md` for the
quick-reference cheat sheet and `docs/design_request_transform_hooks.md` for the design.

**Attaching a transform set to a model entry** — model entries accept two forms:

```toml
# Inline-table form (recommended for readability):
"deepseek-v4-anth" = {target = "deepseek-v4-flash", base_url = "https://...", api_key = "sk-...", mode = "anthropic-messages", transforms = "my_set", max_tokens = 8192}

# Positional-array form (legacy):
"deepseek-v4-anth" = ["deepseek-v4-flash", "https://...", "sk-...", "anthropic-messages", "my_set", "8192"]
#                      [0] target           [1] base_url   [2] api_key [3] upstream_mode   [4] transforms CSV  [5] max_tokens
```

In the positional form, every element is optional from the right — a 3-element array
`[target, base_url, api_key]` inherits `upstream_mode` from the section and attaches no
transforms. An empty element (`""`) falls back to the section/default value for that slot.
The `transforms` field (index 4) is always a comma-separated string of named set names.

**`max_tokens` (optional, inline-table `max_tokens = 8192` or positional index 5)** — a bare
integer, not a quoted string. Two effects:

- **Fill** (`anthropic-messages` only, where the field is required): when the request omits
  `max_tokens`, the proxy fills this value.
- **Cap** (all upstream modes): at the `before_upstream` hook — after transforms run — the
  upstream body's max-output-tokens field is clamped down to this value when the client (or a
  transform) sent a larger one. Smaller client values pass through unchanged. Field resolved
  per upstream schema: `max_tokens` (`anthropic-messages`), `max_tokens` /
  `max_completion_tokens` (`openai-completions`), `max_output_tokens` (`openai-responses`),
  `generation_config.max_output_tokens` / `generationConfig.maxOutputTokens` (`gemini`).

**Unset → strict passthrough**: the proxy never sets, modifies, or caps the request's
max-output-tokens field on any endpoint — a request that omits it is forwarded as-is (a
strictly-conformant Anthropic upstream will reject it with HTTP 400). The old
`DEFAULT_MAX_TOKENS` env var (fill `8192` when omitted) was removed.

**Default transforms** — the example config (`proxy_config.example.toml`) ships a
`[transform_defaults]` block that wires `max_tokens_rename` as a mode-level default for
`openai-completions` and `openai-responses`. This renames `max_tokens` →
`max_completion_tokens` automatically for every route on those modes, which is required by
most modern OpenAI-compatible upstreams (DeepSeek, MiniMax, etc.). There is **no code-level
default** — the wiring only takes effect when your `proxy_config.toml` contains the
`[transform_defaults]` block (copy it from the example file).
To opt a specific model entry out, attach `transforms = "no_max_completion_tokens"` to that
entry (renames `max_completion_tokens` back to `max_tokens`).

| Field | Values | Purpose |
|---|---|---|
| `schema` | `openai-completions` \| `anthropic-messages` \| `openai-responses` \| `gemini-generatecontent` | Schema the op paths resolve against. Required per set. |
| `request_ingress.builtins` / `.ops` | see below | Runs after inbound parse, before routing. Client schema. |
| `before_conversion.builtins` / `.ops` | see below | Runs in-handler after routing, before format conversion. Client schema. |
| `before_upstream.builtins` / `.ops` / `.headers` | see below | Runs just before the upstream fetch. Upstream schema. **Primary A/B seam.** |
| `after_upstream.builtins` / `.ops` | see below | Runs after upstream responds, before response conversion. |
| `response_egress.builtins` / `.ops` / `.headers` | see below | Runs before the client response is written. Client response schema. |

**Tier-1 ops** (generic field rewrites, declared under a hook's `.ops` array):

| Op | Effect |
|---|---|
| `{op="rename", path="max_tokens", to="max_completion_tokens"}` | Rename a field, preserving its value. |
| `{op="set", path="reasoning_effort", value="medium"}` | Force a field to a fixed value. |
| `{op="default", path="stream", value=false}` | Set a field only when absent. |
| `{op="remove", path="output_config"}` | Delete a field. |
| `{op="map_value", path="messages[role=assistant].content", when_sibling="tool_calls", from="", to=null}` | Replace a specific value (optional `when_sibling` guard). |

Paths: bare field name for top-level (`max_tokens`); `messages[].field` for all messages; `messages[role=X].field` for role-filtered; `$response.field` for response-body fields (`response_egress`/`after_upstream` hooks).

> **Legacy hook names**: `endpoint_readin` and `endpoint_writeout` are accepted as backwards-compatible aliases for `request_ingress` and `response_egress` respectively. They are normalized to the canonical names at config load time. New configs should use the canonical names.

**Tier-2 builtins** (deep/cross-message logic, declared under a hook's `.builtins` array):

| Builtin | What it does |
|---|---|
| `lowercase_tool_schema_types` | Recursively lowercases every `type` value in `tools[].function.parameters` / `tools[].input_schema`. Required for strict upstreams (e.g. DeepSeek) when the client sends uppercase `"STRING"`. |
| `recover_tool_message_name` | Backfills missing `name` on `role:"tool"` messages by looking up the matching `tool_call_id` in the preceding assistant turn's `tool_calls`. |
| `inject_missing_tool_results` | Synthesizes placeholder `tool_result` blocks for any `tool_use.id` that has no matching `tool_result` in the next user message, and appends a consolidated `user(tool_result)` message when an assistant `tool_use` is the **last** message in the array (e.g. when Codex replays the model's prior `function_call` as its final input item). Also merges consecutive per-call `tool` messages into one user message and reorders text-only assistant turns after the `tool_result`. Required by DeepSeek's Anthropic-format endpoint, which rejects trailing or unmatched `tool_use` with `tool_use ids were found without tool_result blocks immediately after`. |
| `strip_fresh_thinking` | Deletes `thinking` (enabled / `true` / adaptive) when the conversation history contains no prior assistant `thinking` blocks — e.g. the first request of a conversation. Required by DeepSeek's Anthropic-compatible endpoint, which rejects explicit thinking-enabled requests without prior thinking blocks with `400 "The content[].thinking in the thinking mode must be passed back to the API"`. Schema-gated to `anthropic-messages`. |
| `ensure_tool_config_cache_ttl` | Translates the Anthropic-native `system[]` block-level `cache_control` (e.g. `{type:"ephemeral", ttl?:"1h"}`) into the LiteLLM/Bedrock-bridge convention `cache_control_injection_points: [{location:"tool_config", control:{...}}]`. Reads the first usable `cache_control` from a `system` content-block array (plain-string `system` is ignored), appends a `{location:"tool_config"}` entry unless one already exists (caller-provided entries win), and rebuilds body key order so the injection-points field lands after `tools`. Use when forwarding to an upstream that expects the Bedrock-style injection shape. |
| `filter_anthropic_beta` | Filters and optionally renames entries in the `anthropic-beta` request header using the owning set's `anthropic_beta_map` (a `[name → mapped_name \| null]` table, mirroring LiteLLM's `anthropic_beta_headers_config.json` semantics). Input is the real Claude-Code comma-separated form (`a,b,c`), not the JSON-array form `beta-features.ts` handles. For each entry: not in map → drop; mapped to `null`/`""` → drop; mapped to a non-empty string → emit the mapped name. Requires an `anthropic_beta_map` field on the transform set; without one the header passes through unchanged. |

**Worked example — DeepSeek's Anthropic endpoint rejecting uppercase tool-schema types**

Antigravity/Gemini agents send tool schemas with proto-style uppercase types
(`"STRING"`), including nested inside `anyOf`. DeepSeek's `anthropic-messages` endpoint
rejects them:

```
HTTP 400: Invalid schema for function 'glob_tool':
"STRING" is not valid under any of the schemas listed in the 'anyOf' keyword
```

Fix by wiring `lowercase_tool_schema_types` at `request_ingress` and attaching the set to
the model entry:

```toml
[transforms.deepseek_v4_anthropic_compat]
schema = "anthropic-messages"
request_ingress.builtins = ["lowercase_tool_schema_types"]
before_upstream.builtins  = ["inject_missing_tool_results"]

[models.FREE]
upstream_mode = "openai-completions"
# attach the set via the entry's `transforms` field, or it resolves to nothing:
deepseek-v4-anth = {target = "deepseek-v4-flash", base_url = "https://api.deepseek.com/anthropic", api_key = "sk-...", mode = "anthropic-messages", transforms = "deepseek_v4_anthropic_compat"}
```

An inbound tool schema like this (uppercase, with `anyOf`):

```json
{"tools": [{"name": "glob_tool", "input_schema": {
  "type": "OBJECT",
  "properties": {
    "pattern": {"type": "STRING"},
    "path": {"anyOf": [{"type": "STRING"}, {"type": "NULL"}]}
  }
}}]}
```

is rewritten to lowercase (top-level, `properties`, `items`, **and `anyOf`/`oneOf`/`allOf`
branches**) before reaching the upstream:

```json
{"type": "object", "properties": {
  "pattern": {"type": "string"},
  "path": {"anyOf": [{"type": "string"}, {"type": "null"}]}
}}
```

The same set applies across all three entry paths — `/v1/messages`,
`/v1beta/models/{model}:generateContent`, and `/v1/chat/completions` passthrough —
so Antigravity's `GeminiAPIEndpoint` and `LocalOpenAIAgentConfig`
transports are both covered.

**Worked example — DeepSeek rejecting a trailing or unmatched `tool_use`**

DeepSeek's `anthropic-messages` endpoint enforces the Anthropic invariant that every
`tool_use.id` in an assistant message must be matched by a `tool_result.tool_use_id` in
the **immediately following** user message. Three shapes violate this and all surface as
the same upstream error:

```
HTTP 400: tool_use ids were found without tool_result blocks immediately after: call_01_xxx.
Each tool_use block must have a corresponding tool_result block in the next message
```

1. **Trailing `tool_use`** — the assistant `tool_use` is the *last* message in the array
   (no following user message at all). This is the Codex flow: the SDK replays the model's
   prior `function_call` as its final input item, and the proxy's
   `completionsBodyToClaudeBody` converter (`src/handlers/responses.ts`) emits a trailing
   `assistant(tool_use)` with no following user message.
2. **Split tool_results** — multiple `role:"tool"` messages (one per call) become separate
   `user(tool_result)` messages after conversion; DeepSeek requires all of them in ONE
   consolidated user message.
3. **Mixed-content assistant** — when an assistant turn has both text and `tool_use`, the
   text-only assistant that follows must be reordered *after* the `tool_result` user
   message.

The `inject_missing_tool_results` builtin (declared at `before_upstream`) fixes all three
by appending a consolidated `user(tool_result)` message for any unmatched id, merging
consecutive per-call tool messages, and reordering text-only assistant turns. Wire it as:

```toml
[transforms.deepseek_v4_anthropic_compat]
schema = "anthropic-messages"
before_upstream.builtins = ["inject_missing_tool_results"]

[models.FREE]
upstream_mode = "openai-completions"
deepseek-v4-anth = {target = "deepseek-v4-flash", base_url = "https://api.deepseek.com/anthropic", api_key = "sk-...", mode = "anthropic-messages", transforms = "deepseek_v4_anthropic_compat"}
```

With this set attached, an inbound Anthropic body ending in an assistant `tool_use` like:

```json
{"messages": [
  {"role": "user", "content": "list the ts files"},
  {"role": "assistant", "content": [{"type": "tool_use", "id": "call_01_xyz", "name": "Glob", "input": {"pattern": "tests/**/*.ts"}}]}
]}
```

is rewritten before the upstream fetch to append a placeholder `tool_result`:

```json
{"messages": [
  {"role": "user", "content": "list the ts files"},
  {"role": "assistant", "content": [{"type": "tool_use", "id": "call_01_xyz", "name": "Glob", "input": {"pattern": "tests/**/*.ts"}}]},
  {"role": "user", "content": [{"type": "tool_result", "tool_use_id": "call_01_xyz", "content": ""}]}
]}
```

## Core / server environment variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8788` | Listen port (Node server) |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `ALLOWED_ORIGINS` | `*` | CORS origins |
| `TUI` | unset | `true` launches the terminal dashboard + enables stat persistence |
| `DUMP` | unset | `true` enables token-log persistence without the TUI |
| `DEV_MODE` | unset | `true` enables development behaviors |
| `VERSION` | unset | Build identifier (commit id, tag, or branch) surfaced in the `/health` response. Set via the Docker `--build-arg VERSION=...` / `-e VERSION=...`, or `[vars]` in `wrangler.toml`. |

## Config source

The proxy loads its config from one of three backends. When more than one is
set, precedence is **Apollo > Consul > Path**. Setting any remote backend
(Apollo or Consul) makes the dashboard read-only; reload config with
`GET /config-reload`.

**No live-update from remote backends.** Neither Apollo nor Consul pushes
change notifications to the proxy — after editing/publishing in the portal
(or Consul KV), you must call `GET /config-reload` (or restart) for the change
to take effect. The proxy logs a `[WARN]` reminder at startup when Apollo is
active.

| Variable | Default | Purpose |
|---|---|---|
| `PROXY_CONFIG_PATH` | `./proxy_config.toml` | Path to the local TOML config file |
| `PROXY_CONFIG_CONSUL` | unset | Consul meta URL (e.g. `http://127.0.0.1:8500`); reads KV under the `model-proxy-v3/` prefix recursively. Host must be loopback or private/LAN (SSRF guard). Read-only dashboard. |
| `PROXY_CONFIG_APOLLO` | unset | Path to an [Apollo](https://www.apolloconfig.com/) connection file (see below). The named Apollo namespace holds the full `proxy_config.toml` content as a plain-text value. Read-only dashboard. Node-only. |

**Apollo connection file** (`PROXY_CONFIG_APOLLO` points here). All fields are required:

| Field | Purpose |
|---|---|
| `app_id` | Apollo application id |
| `cluster` | Apollo cluster name (commonly `default`) |
| `namespace` | Namespace name; non-properties namespaces carry their format suffix (e.g. `application.json`) |
| `meta` | Apollo Config Service base URL |
| `access_key_secret` | Plaintext HMAC-SHA1 key — **not** the `enc:...` Portal storage form; decode `enc:` externally first (see below, that is same with 3 sdk of apollo) |

```
apollo:
app_id = "proxyv3"
cluster = "default"
namespace = "test"
meta = "https://test-apollo-config.example.com"
access_key_secret = "<plaintext HMAC-SHA1 key>"
```

- The proxy reads the namespace via
  `GET {meta}/configs/{app_id}/{cluster}/{namespace}` and feeds the
  `configurations` payload through the same `parseSimpleToml()` + validation
  pipeline as the local file.
- `access_key_secret` is the **plaintext HMAC-SHA1 key**. It is never sent
  directly. Each request is signed:
  `Authorization: Apollo <app_id>:<base64(HMAC-SHA1(secret, "<ts>\n<path?query>"))>`
  with a `Timestamp` header. The `enc:...` wrapper is a Portal storage-layer
  format and is not handled here — if your key is stored encrypted at rest,
  decrypt it before writing it to this file.
- Unlike `PROXY_CONFIG_CONSUL`, the Apollo `meta` host is **not** restricted to
  private/LAN addresses — Apollo meta servers are typically public. Only point
  `meta` at an Apollo instance you trust.
- Node-only: the connection file is read with `fs`, so this backend is not
  available in the Cloudflare Workers build.

## Token counting & upstream

`sdk://...` model `base_url` values are handled by the local SDK adapter instead of
HTTP fetch for supported Claude/OpenAI-shaped upstream calls. For example, a model
entry can set `base_url = "sdk://chatjimmy.ai/api"` and keep the appropriate
`upstream_mode` for the client/upstream protocol shape.

| Variable | Default | Purpose |
|---|---|---|
| `LOCAL_TIKTOKEN` | `false` | Count tokens locally instead of calling upstream. Local counts are best-effort estimates and include text, tool results, tool use, images, documents, thinking, and web-search result blocks. |
| `TIKTOKEN_MODEL` | unset | tiktoken encoding to use, e.g. `o200k_base` |
| `UPSTREAM_BODY_TIMEOUT_MS` | `600000` | Upstream body timeout (also judge/synth timeout in fusion) |
| `MODELS_CACHE_TTL` | unset | Seconds to cache the upstream `/v1/models` list |
| `GEMINI_API_VERSION` | `v1beta` | Gemini API version segment used in upstream URLs (e.g. `/v1beta/models/...:generateContent`). Also accepts `v1` for the GA endpoint shape. |
| `MESSAGES_UPSTREAM_MODE` | `openai-completions` | Default `upstream_mode` for `POST /v1/messages` when neither the model entry nor section sets one. `native` = forward Claude Messages verbatim to `/v1/messages`; `openai-completions` = convert Claude ↔ Chat Completions. |
| `INTERACTIONS_UPSTREAM_MODE` | `native` | Default `upstream_mode` for `POST /v1/interactions`. `native` = forward to the Gemini-family Interactions endpoint; `openai-completions` = indirect transform via Chat Completions. |
| `GENERATE_CONTENT_UPSTREAM_MODE` | `native` | Default `upstream_mode` for `POST /v1beta/models/{model}:generateContent` (+ `:streamGenerateContent`, `:countTokens`). `native` = forward to Gemini; `openai-completions` = indirect transform via Chat Completions. |
| `JSON_STRINGIFY_METHOD` | `json` | Serialization method for outgoing bodies. Accepted: `json` (default, native `JSON.stringify`), `safe-stable` ([safe-stable-stringify](https://www.npmjs.com/package/safe-stable-stringify), deterministic key order), `fast-safe` ([fast-safe-stringify](https://www.npmjs.com/package/fast-safe-stringify), cycle-safe). |
| `DEV_NO_KEY` | `false` | `true` (or `1`) skips the auth-header presence check on non-exempt model API paths. Only the presence check is disabled — `auth_server` still applies, and `/v1/models` plus dashboard/admin paths remain exempt regardless. Intended for local development behind another gateway that has already authenticated the caller. |
| `CONVERSATION_STATE` | unset | `true` (or `1`) enables experimental in-process stateful conversation mode for `/v1/responses` with `openai-completions` upstream: stores each response and serves `previous_response_id` / `conversation` continuation plus `GET /v1/responses/{id}` and `GET /v1/responses/{id}/input_items` retrieval. Requests with `store: false` are not stored. |
| `CONVERSATION_MAX_ENTRIES` | `10000` | Cap on the in-process conversation store size (response entries + conversation threads per instance). Only meaningful when `CONVERSATION_STATE=true`. Eviction is lazy + opportunistic; no cross-process sharing. |
| `IMAGE_BLOCK_DATA_MAX_SIZE` | `10485760` | Max inline image bytes accepted |
| `ALLOWED_HOSTS` | `127.0.0.1,localhost` | SSRF allowlist for dynamic per-request upstream hosts |

## Privacy-filter sidecar

Inert unless `PRIVACY_FILTER_URL` is set.

| Variable | Default | Purpose |
|---|---|---|
| `PRIVACY_FILTER_URL` | unset | Sidecar base URL, e.g. `http://127.0.0.1:8799`. Unset = off |
| `PRIVACY_FILTER_TIMEOUT_MS` | `40000` | Per-call timeout to the sidecar |
| `PRIVACY_FILTER_MAX_CHARS` | `1024000` | Skip redaction above this total text size |

When the sidecar is `serve.py` from [`submodules/privacy-filter`](../submodules/privacy-filter/), it emits two sentinel prefixes: `⟦PII:n⟧` (model-detected PII) and `⟦HASH:n⟧` (cryptographic-hash-shaped secrets such as API keys and tokens, caught by the entropy-based `hash_detect.py` scan). The proxy restores both prefixes transparently on the response, including for streaming SSE. The sidecar mode covers broad PII — emails, addresses, phone numbers, names, and credit card numbers — in addition to hex-shaped secrets.

**Local hash-only mode** (in-process, no sidecar). If you only need to redact hash-shaped secrets (API keys, tokens) and want to skip the OPF PII model entirely, add a `[privacy_filter]` section to `proxy_config.toml` with `filter_mode = "local"`. This mode detects two token shapes by entropy analysis; emails, addresses, and other free-text PII are not redacted:
- **hex tokens** (`0–9`, `a–f`) — MD5, SHA-1, SHA-256 digests and similar
- **base64url tokens** (`A–Z`, `a–z`, `0–9`, `_`, `-`) — API keys such as `sk-…` or `ouV7bwSq…` that contain non-hex characters

The proxy runs an in-process TypeScript port of `hash_detect.py` (`src/utils/hash-detect.ts`) on every `text` fragment; no HTTP call, no Python sidecar. Non-text content blocks are never touched: Anthropic `image`/`document` (`source.data`), OpenAI `image_url` (`image_url.url`), and Gemini `inlineData` (`inlineData.data`) are skipped. Detected spans are replaced with `⟦HASH:n⟧` sentinels and restored on the response, exactly as in sidecar mode. The plugin is enabled when `filter_mode = "local"` (no URL needed), or when `filter_mode = "sidecar"` is paired with a valid `filter_url`; otherwise it stays inert. Env vars override toml values.

```toml
[privacy_filter]
filter_mode = "local"         # "sidecar" (default when a filter_url is configured) | "local"
# filter_url = "http://127.0.0.1:8799"  # required for sidecar mode
# timeout_ms = 40000          # sidecar only: per-call timeout
max_chars = 1024000           # skip redaction above this total text size
entropy_threshold = 3.0       # local mode only: Shannon entropy cutoff for hash detection
hash_min_len = 8              # local mode only: minimum hex token length to classify as a hash
whitelist_add = []            # hex tokens to add to the built-in skip-list
whitelist_remove = []         # built-in whitelist tokens to remove (so they get detected)
# whitelist_file = ""         # Node-only: path to a whitelist-override file
```

The `hash_min_len` and `entropy_threshold` knobs are also accepted by the Python sidecar via `--hash-min-len` and `--entropy-threshold` CLI flags (see [`submodules/privacy-filter/README.md`](../submodules/privacy-filter/README.md)).

> **Note — "filtered Keys" counter:** whenever the privacy filter redacts one or more
> spans from a request, the proxy increments an in-process cumulative counter.
> The total is shown in two places:
> - **TUI** — a `filtered Keys: N` line appears above the *Custom Models* section,
>   right-aligned to the Tokens Panel width. The line is hidden while the count is zero.
> - **Dashboard** — the *Request Statistic* card contains a *Privacy Filter* sub-table
>   with a "filtered Keys (total)" row, refreshed every 10 seconds alongside other stats.
>
> The counter is runtime-only and resets to zero when the proxy process restarts.
> Each redacted span (one `⟦HASH:n⟧` sentinel) counts as one key, so a single request
> carrying three API keys increments the counter by three.

## Compression sidecar

Inert unless `KOMPRESS_URL` is set.

| Variable | Default | Purpose |
|---|---|---|
| `KOMPRESS_URL` | unset | Sidecar base URL, e.g. `http://127.0.0.1:7777`. Unset = off |
| `KOMPRESS_ENDPOINTS` | `/v1/messages,/v1/chat/completions,/v1/responses` | Proxy paths to compress |
| `KOMPRESS_FAIL_OPEN` | `true` | `true` = fail-open (forward original text on sidecar error) |
| `KOMPRESS_TIMEOUT_MS` | `40000` | Per-call timeout to the sidecar |
| `KOMPRESS_MAX_CHARS` | `1024000` | Skip compression above this total text size |
| `KOMPRESS_KEEP_RATIO` | `0.5` | Fraction of tokens to keep (lower = more aggressive) |
| `KOMPRESS_MIN_CHARS` | `200` | Skip fragments shorter than this |

## Image-encode sidecar

Inert unless `IMAGE_ENCODE_URL` is set.

| Variable | Default | Purpose |
|---|---|---|
| `IMAGE_ENCODE_URL` | unset | Sidecar base URL for fetching + base64-encoding caller-supplied image URLs. Unset = in-process fetch. Must be localhost / private LAN. |
| `IMAGE_ENCODE_TIMEOUT_MS` | `40000` | Per-call timeout to the image-encode sidecar (distinct from `PRIVACY_FILTER_TIMEOUT_MS` / `KOMPRESS_TIMEOUT_MS`). |

The full list (including the Consul- and Apollo-backed config and hardcoded upstream-mode defaults)
is documented in [`docs/README_DETAILS.md`](./README_DETAILS.md).
