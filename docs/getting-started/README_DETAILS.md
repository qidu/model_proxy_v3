# Model Proxy v3

A complete Claude and Gemini API Proxy and also Reponses Endpoints that supports multiple AI models and providers with Claude, Gemini, Interactions and Responses API schema.
It also supports models composite, alias, fusion, compress, and models, tokens, tools, requests counting and tokens limit with duration. 

## ✨ Features

- **Unified API Format**:
  - `GET /v1/models` - List available models
  - `POST /v1/messages` - Process claude messages (supports 49+ models)
  - `POST /v1/responses` - OpenAI Responses API (passthrough or convert to chat completions)
  - `POST /v1/responses/input_tokens` - Count input tokens for a Responses API request
  - `POST /v1/responses/compact` - Compact a conversation (returns `response.compaction` object)
  - `POST /v1/interactions` -  Process gemini interactions messages
  - `POST /v1beta/models/{model}:generateContent` - Process gemini content messages
  - `POST /v1beta/models/{model}:streamGenerateContent` - Process gemini content messages with SSE
  - `POST /v1beta/models/{model}:countTokens` - Count tokens via Gemini API (proxied to upstream; returns `totalTokens`)
  - `POST /v1/models/{model}:generateContent` - Alternative Gemini v1 endpoint (added 2026-03-03)
  - `POST /v1/models/{model}:streamGenerateContent` - Alternative Gemini v1 endpoint with SSE (added 2026-03-03)
  - `POST /v1/models/{model}:countTokens` - Alternative Gemini v1 countTokens endpoint
  - `POST /v1/messages/count_tokens` - Count tokens in messages (Claude/OpenAI format)
  - `POST /v1/embeddings` - Generate embeddings (proxied to upstream OpenAI-compatible API)
  - `GET /dashboard` - Web dashboard for config and runtime statistics
  - `GET /dashboard/api/config` - Read sanitized editable config (`models.*`, `composite`; hides `api_key`). Add `?reload=1` to clear the in-memory config cache and re-read the config file first (used by the dashboard "Reload" button and the TUI `r` key, so externally edited config — e.g. new models — shows up without restarting)
  - `PUT /dashboard/api/config` - Save dashboard config edits, persist them, and reload the updated config back into `/dashboard` and the TUI (file mode only; read-only when `PROXY_CONFIG_CONSUL` or `PROXY_CONFIG_APOLLO` is set)
  - `GET /dashboard/api/stats/models` - Model request + token stats
  - Dashboard "Export CSV" button reads table data from the DOM and triggers a download; it does **not** change the in-memory stats data.
  - `GET /dashboard/api/stats/agents` - Combined tool usage stats by tool (`in requests` is aggregated across UA prefixes; `in responses` is by tool)
  - **Tool Blocklist** (TUI `P`): per-(tool, agent) panel in the TUI with `Enter` to toggle block; blocked tools stop accumulating `in_requests` / `in_responses` / `in_request_chars` stats (existing pre-block counts are preserved). Snapshot fields: `agentToolStats` (per-(tool, agent) rows) and `blockedTools` (string array of currently-blocked tool names).
  - `GET /dashboard/api/stats/requests` - Request/response stats by endpoint, upstream, and status code, plus **model timing** (min/avg/max ms per model)
  - **model_timings** field: tracks per-model response time (`min_time_ms`, `avg_time_ms`, `max_time_ms`, `count`) — keyed by the resolved upstream model name (e.g., `moonshotai/kimi-k2.6` for config key `kimi-k2.6`)
  - **endpoint_timings** field: tracks per-endpoint response time (existing)
  - `TUI=true npm run server` - Terminal dashboard for live stats and composite alias editing

- **Extended Thinking Support**: Full Claude-style thinking with signature verification
  - **Model Support**: DeepSeek R1 series, Doubao Thinking, Qwen Thinking variants, Gemini reasoning models
  - **Thinking Modes**: Supports `enabled` (manual) and `adaptive` (Claude 4.6+) thinking types
  - **Boolean Support**: Accepts boolean values (`true`/`false`) in addition to string values (`"enabled"`/`"disabled"`)
  - **Flexible Request Fields**: `/v1/messages` accepts `thinking: { type: "enabled" }` with or without `budget_tokens`, plus `reasoning_effort: "low" | "medium" | "high" | "max"` and `output_config.effort` (including non-standard `xhigh` normalization), and `output_config.task_budget.total` can supply the thinking budget when `budget_tokens` is omitted (request-supplied effort takes priority over budget-based thresholds)
  - **OpenAI Upstream Passthrough**: For `openai-completions` upstreams, the proxy derives `reasoning_effort` from `thinking.budget_tokens` and strips the `thinking` field (OpenAI chat completions schema does not support it)
  - **Signature Verification**: Full signature_delta streaming events for thinking block verification
  - **Streaming Support**: Proper thinking_delta and signature_delta events in SSE streams
  - **Token Counting**: Accurate token counting for thinking content with budget validation

- **Token Usage Accounting** (TUI `Top Models` / dashboard stats), per upstream mode:
  - `openai-completions`: the proxy adds `stream_options: { include_usage: true }` to converted streaming requests and prefers the upstream-reported `usage` (`prompt_tokens` / `completion_tokens`, plus OpenAI `prompt_tokens_details.cached_tokens` and DeepSeek `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` cache fields) over local tiktoken estimates; local counting is the fallback when the upstream omits usage
  - `anthropic-messages` (pass-through): the upstream SSE stream is teed and the usage-tracking branch parses `message_start.message.usage` and `message_delta.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`); non-streaming JSON responses are parsed for the `usage` object and any tool names used in the response. The client always receives the upstream bytes unmodified
  - **Note**: pass-through accounting can only record what the upstream puts on the wire — if an Anthropic-compatible upstream hardcodes `input_tokens: 0` in `message_start` and omits input/cache fields from `message_delta.usage`, the `token in` column stays 0 until the upstream is fixed to emit them

- **Flexible Configuration**:
  - File-based config: `proxy_config.toml`
  - URL-based config: Eureka service discovery support
  - Model-specific routing with per-model upstreams
  - Composite model routing with weighted, primary/fallback, or default ordering
  - Per-model API keys
  - Native and OpenAI-compatible modes

- **Model-based Routing**: Route requests based on model name via `proxy_config.toml` categories
- **TypeScript First**: Full type safety with comprehensive type definitions
- **Cloudflare Workers Ready**: Optimized for edge deployment

## 🚀 Quick Start

### 1. Clone and Install

```bash
cd model_proxy_v3
npm install
```

### 2. Configure

#### Basic Configuration (`wrangler.toml`):
```toml
[vars]
LOCAL_TIKTOKEN = "false"
PROXY_CONFIG_PATH = "./proxy_config.toml"
```

#### Model Configuration (`proxy_config.toml`):
```toml
[upstream]
upstream_mode = "openai-completions"
default_base_url = "https://api.qnaigc.com"
default_api_key = "your-api-key"

# Claude models with native API
[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.anthropic.com"
api_key = "your-claude-key"
"claude-*" = {}                                                            # Wildcard: catch-all for all claude-* models
"claude-4.6-sonnet" = {target = "claude-opus-4-1-20250805-thinking"}      # Explicit override

# Gemini models with native API
[models.gemini]
upstream_mode = "gemini-generatecontent"
base_url = "https://api.example.com"
api_key = "your-gemini-key"
"gemini-*" = {}                                                            # Wildcard: catch-all for all gemini-* models
"gemini-3.0-flash-preview" = {target = "gemini-3-flash-preview"}          # Explicit override

# OpenAI-compatible models (default category)
[models.default]
upstream_mode = "openai-completions"
# Inherits base_url and api_key from [upstream]
"*" = {}                                                       # Catch-all: routes any unmatched model to default config
"deepseek/deepseek-v3.2" = {}
"gpt-oss-120b" = {}
```

**Configuration Structure**:
- **Category-based**: Group models by provider (`[models.gemini]`, `[models.claude]`, `[models.default]`)
- **Inline-table format**: `{target = "model-alias", base_url = "url-or-empty", api_key = "key-or-empty"}` — empty strings inherit from the category
- **Per-model `mode`**: add `mode = "anthropic-messages"` (or `"openai-completions"` / `"gemini-generatecontent"`) to any inline-table or array entry to override the section's `upstream_mode` for just that model. Array form: `["target", "base_url", "api_key", "mode"]`.
- **upstream_mode**: Explicit mode per category (`anthropic-messages`, `gemini-generatecontent`, `openai-completions`)
- **Model names**: Preserve original names (no normalization) - `"deepseek/deepseek-v3.2"`, `"gemini-2.5-flash"`
- **Inheritance chain**: Model entry `mode` → Category `upstream_mode` → `[upstream] upstream_mode` → `"openai-completions"`
- **Wildcard routing**: `prefix-*` patterns (e.g. `claude-*`, `gemini-*`) in `models.claude`/`models.gemini` catch unmatched models; `*` in `models.default` is the catch-all safety net. See [Model Routing Priority](#model-routing-priority) for full lookup order.

**Note**: Each model supports one upstream. Composite aliases can route across multiple configured models, and a composite alias may also define a shared `token_limit` across all of its targets.

#### API key priority (caller vs. config)

When a per-model `api_key` is configured in the TOML, whether the proxy uses it or the caller's
auth header depends on the **section** the model lives in. This is the rule the proxy enforces
during dispatch:

| Section | Caller header wins? | Config `api_key` usage |
| --- | --- | --- |
| `[models.free]` | **No** | Section-level and per-entry `api_key` override the caller's header. This is what enables the FREE tier — the proxy authenticates to the upstream on the caller's behalf, so users can hit these models without bringing their own upstream API key. |
| `[models.default]` | **Yes** | Per-entry `api_key` is only a fallback when the caller did not supply `Authorization` / `x-api-key` / `x-goog-api-key`. Callers are expected to bring their own upstream credentials. |
| `[models.claude]`, `[models.gemini]` | **Yes** | Same as `default` — caller's key passes through; config keys are fallbacks. |
| `[models.embedding]` | **Yes** | Same — caller's key wins; configured `api_key` is the fallback. |

The rule applies uniformly across direct routing, composite aliases, and fusion aliases — the
fusion dispatch path and the non-fusion composite dispatch path both check `route.section === 'free'`
before applying the config key.

See the per-section comments in [`./proxy_config.example.toml`](./proxy_config.example.toml) for the
full design notes on each section (model array format, `upstream_mode`, per-entry `base_url` /
`api_key` overrides, wildcard patterns, fusion roles, and the explicit auth-priority rules per
section).

#### Global token limit

A global token limit applies to **all requests** regardless of model. Configure it in the `[upstream]` section:

```toml
[upstream]
global_token_limit = "1.1B 1d"   # 1.1 billion tokens per day
```

Format: `<num>[K|M|B|T] <1h|1d|1w|1m>` — e.g. `50K 1h`, `1.5M 1d`, `1.1B 1w`. Once the rolling-window total reaches the limit, all incoming requests return **HTTP 429** until the window expires.

The TUI shows the current window total alongside the limit in the Tokens Panel header:

```
Tokens Panel [572.9M L 1.1B/1d]
```

The `L limit/duration` indicator turns yellow at ≥80% and red at ≥100%. Press `l` in the main TUI view to set or clear the global limit interactively.

The global limit is checked first on every request, before any alias-level `token_limit` check.

#### Composite aliases

```toml
[composite]
"gpt-all" = {token_limit = {num = 120000, duration = "1d"}, "gpt-5.4-mini" = {share = 50}, "gpt-5-mini" = {share = 20}, "nvidia/nemotron-3-super-120b-a12b-free" = {}}
"gpt-5" = {token_limit = {num = 80000, duration = "1h"}, "gpt-5.4-mini" = {fallback = 1}, "gpt-5-mini" = {primary = true}, "nvidia/nemotron-3-super-120b-a12b-free" = {fallback = 2}}
"llama" = {token_limit = {num = 40000, duration = "1w"}, llama3 = {}, "g5-mini" = {}}
```

Composite behavior:
- `token_limit`: time-bounded token cap for the alias. Format: `{"num": <number>, "duration": "1h"|"1d"|"1w"|"1m"}`. The proxy tracks accumulated tokens in a sliding window; once the window total reaches `num`, subsequent requests return **HTTP 429** and are not forwarded upstream. The window resets automatically after `duration` expires. Durations: `1h` (1 hour), `1d` (1 day), `1w` (1 week), `1m` (1 month). If `token_limit` is omitted, no limit is enforced. The limit counter and window state are persisted in the token log and restored on proxy restart (if the window hasn't expired). On TUI and dashboard, enter limits as `<num>[k|m|b|t]> <1h|1d|1w|1m>` — e.g. `50k 1d`, `1.5m 1h`, `100000 1w`.
- `primary: true`: always try this target first, then fail over to others (ignores `share`).
- `fallback: N`: lower number = higher retry priority when primary is absent (ignores `share`). Use `0` to disable fallback for that target; the UI shows this as `no FB`.
- `share`: when no `primary`/`fallback` is set, each request picks a target via **weighted random selection**. Total weight = sum of all targets' `share` (defaults to 1 if unset). Each request independently rolls the dice — e.g. `{"a": {"share": 70}, "b": {"share": 30}}` routes ~70% of requests to a and ~30% to b. Set `share: 0` to exclude a target from random selection.
- if one upstream fails, the proxy automatically retries the next candidate in the order determined by `primary`/`fallback`, or weighted selection for the first attempt then remaining targets as fallbacks.
- a composite alias may have **no targets** (`"my-alias" = {}`) — this is the state right after adding an alias in the TUI (press `a`) before any target is chosen. Empty aliases are preserved across config parse/serialize round-trips, so the TUI can add the alias first and then open the target picker.

#### Fusion mode

Fusion is a composite mode that fans a single request out to multiple **panel** models simultaneously, optionally sends a **judge** model to analyze the panel responses, then routes to a **synth** model that writes the final answer to the client.

```toml
[composite]
"smart-answer" = {opus46 = {fusion = 1}, sonnet46 = {fusion = 1}, "max-m3" = {role = "judge"}, "max-m2.7-high" = {role = "synth"}, fusion_options = {min_panel = 1, judge_required = false, panel_timeout_ms = 30000}}
```

Per-target fields:

| Field | Description |
|---|---|
| `fusion: N` | Marks this target as a panel member (`N > 0`). All `fusion`-marked targets are called in parallel. |
| `role: "judge"` | The judge model. Receives all panel responses and returns a structured JSON analysis. |
| `role: "synth"` | The synthesis model. Receives the analysis (or raw panel if judge absent/skipped) and streams the final answer to the client. Exactly one synth is required. |
| `role: "panel"` | Explicit panel membership (equivalent to `fusion: 1`). |

`fusion_options` block (alias-level):

| Field | Default | Description |
|---|---|---|
| `min_panel` | `1` | Minimum successful panel responses required to proceed. If fewer succeed, the request fails. |
| `panel_timeout_ms` | `60000` | Per-panel-call wall-clock timeout in ms. Timed-out panel calls count as failures. |
| `judge_required` | `false` | If `true`, a judge failure aborts the request. If `false`, synth runs on raw panel responses when the judge is absent or fails. |
| `expose_metadata` | `true` | Attach a `fusion_metadata` object to non-streaming responses with `panel_models`, `judge_model`, `synth_model`, `panel_errors`, and `analysis_present`. |
| `max_concurrent` | panel size | Maximum simultaneous panel calls. Full fan-out by default. Note: on CPU-constrained runtimes, synchronous JSON aggregation of large panel responses may cause brief stalls. |

Pipeline:

1. **Panel** — all `fusion`-marked targets called in parallel (windowed by `max_concurrent`), always non-streaming so responses can be aggregated. Calls exceeding `panel_timeout_ms` are treated as failures.
2. **Judge** — if configured and `>= min_panel` responses succeeded, the judge receives all panel text plus the original user prompt and returns a structured JSON analysis (consensus, contradictions, unique insights, blind spots). If the judge fails and `judge_required` is `false`, synthesis proceeds on raw panel text.
3. **Synth** — receives the structured analysis (or raw panel in degraded mode) and the original user prompt. The client's `stream` flag is forwarded, so the synth response is streamed or buffered as requested.

Timeouts:

| Stage | Timeout | Default | Config |
|---|---|---|---|
| **Panel** | `panel_timeout_ms` | 60,000 ms (60 s) | `fusion_options.panel_timeout_ms` |
| **Judge** | `UPSTREAM_BODY_TIMEOUT_MS` | 600,000 ms (10 min) | env var |
| **Synth** | `UPSTREAM_BODY_TIMEOUT_MS` | 600,000 ms (10 min) | env var |
| **Privacy filter** | `PRIVACY_FILTER_TIMEOUT_MS` | 40,000 ms (40 s) | env var |

Importance: **Synth > Judge > Panel**

- **Synth** is the most critical — it writes the final answer the user sees. A synth failure fails the entire request. Use the best/most expensive model here.
- **Judge** is optional and degrades gracefully (`judge_required: false`, the default). A judge failure falls back to raw panel text. A medium-tier model is sufficient.
- **Panel** generates diverse perspectives. Multiple models call in parallel, so absolute cost per request is high, but each individual call can use a cheaper model. The panel timeout only guards against hung calls; successful panels are always used regardless.

Latency: the three stages run **sequentially**, so total time is the sum of the stages:

```
T_total ≈ max(T_panel...)  +  T_judge  +  T_synth
```

Only the panel stage is parallel — all panel models fan out at once, so it takes about as long as the **slowest** panel model (bounded by `panel_timeout_ms`). Judge and synth are then two more back-to-back model round-trips. In practice fusion costs roughly three full round-trips end-to-end (slowest panel → judge → synth); with typical per-call latencies this is on the order of ~1–2 minutes, with a hard ceiling of `panel_timeout_ms` plus the judge and synth durations. `panel_timeout_ms` is only a guard against a hung panel call — the stage returns as soon as all panels settle.

Recursion guard: the proxy injects `x-fusion-depth: 1` on all internal panel/judge/synth calls. Any request arriving at a fusion alias with `x-fusion-depth >= 1` is rejected to prevent recursive fan-out.

`token_limit` works identically to other composite modes and covers all targets under the alias.

##### Editing fusion aliases in the TUI

Open the composite panel with `c` (or however your TUI binding shows it), then use these keys on a fusion alias:

| Key | Selection | Action |
|---|---|---|
| `F` | alias selected | Edit `fusion_options` — prompts for `key=value` pairs |
| `M` | alias selected | Add a target — opens model picker, then prompts for `role` and optional `fusion` weight |
| `E` | target selected | Edit a target's `role` and `fusion` weight |
| `L` | alias selected | Set/clear the alias-level `token_limit` (same as normal composite) |
| `D` | target selected | Delete a target |

**Setting `fusion_options` (`F` key)**

Opens 5 sequential prompts, each pre-filled with the current value. Press Enter to keep it unchanged, or type a new value:

```
[1/5]  min_panel          number ≥ 1       blank → default (1)
[1b/5] panel_timeout_ms   number ms > 0    blank → default (60000)
[2/5]  judge_required     true / false     blank → default (false)
[3/5]  expose_metadata    true / false     blank → default (true)
[4/5]  max_concurrent     number ≥ 1       blank → default (all)
```

A bad value shows an error and stays on the same step. Blanking every field removes `fusion_options` from the alias.

**Adding/editing targets (`M` / `E` keys)**

When a fusion alias is selected (`fusion_options` is set), the prompt expects:

```
panel|judge|synth [weight]
```

Examples:
- `panel 1` — add as a panel member with weight 1
- `panel` — panel with default weight (equivalent to `fusion: 1`)
- `judge` — designate as judge
- `synth` — designate as synth (exactly one required)

**Full example workflow** — building the `smart-answer` alias from scratch:

```
# 1. Add alias
Press a → type "smart-answer" → Enter

# 2. Set fusion_options (alias must be selected)
Press F → type "min_panel=1 judge_required=false panel_timeout_ms=30000" → Enter

# 3. Add panel members
Press M → select "opus46"   → "panel 1" → Enter
Press M → select "sonnet46" → "panel 1" → Enter

# 4. Add judge
Press M → select "max-m3" → "judge" → Enter

# 5. Add synth (required)
Press M → select "max-m2.7-high" → "synth" → Enter
```

The TUI displays fusion targets with `role:weight` instead of the usual `share P FB` summary — e.g. `panel:1`, `judge`, `synth`.

#### Consul-backed config

`PROXY_CONFIG_CONSUL` can point to a Consul server address, and the proxy will read the KV prefix `model-proxy-v3/`.

**Notice**: `wrangler.toml` vars are loaded by Wrangler/Cloudflare at runtime. The Node server (`npm run server` / `dist/server.js`) uses process environment variables instead.

Example:

```toml
# wrangler.toml
PROXY_CONFIG_CONSUL = "http://localhost:8500"
```

Put config into Consul KV using the `model-proxy-v3/` prefix:

```bash
consul kv put model-proxy-v3/upstream/default_base_url "https://api.qnaigc.com"
consul kv put model-proxy-v3/upstream/budget_to_effort_low "8000"
consul kv put model-proxy-v3/upstream/budget_to_effort_medium "20000"
consul kv put model-proxy-v3/upstream/budget_to_effort_high "0"

consul kv put model-proxy-v3/models/claude/upstream_mode "anthropic-messages"
consul kv put model-proxy-v3/models/claude/base_url "http://localhost:4000"
consul kv put model-proxy-v3/models/claude/api_key "sk-..."
consul kv put model-proxy-v3/models/claude/claude-opus-4-6 '["claude-opus-4-6", "", ""]'

consul kv put model-proxy-v3/models/free/upstream_mode "openai-completions"
consul kv put model-proxy-v3/models/free/base_url "http://localhost:4000"
consul kv put model-proxy-v3/models/free/api_key "sk-hello"
consul kv put model-proxy-v3/models/free/gpt-5.4-mini '["gpt-5.4-mini", "", ""]'
```

List the keys under a prefix with:

```bash
consul kv get -recurse -keys model-proxy-v3/models/free/
```

List all values of all keys:
```
for KEY in $(consul kv get -recurse -keys model-proxy-v3); do consul kv get $KEY; done
```

Watch if a key changed:
```
consul watch -type=key -key=model-proxy-v3/models/free/api_key
```

After updating Consul KV, trigger a reload:

```bash
curl http://localhost:8788/config-reload
```

On success, the proxy also dumps the reloaded config to `./config-dumps/` as a timestamped TOML file.

### 3. Develop Locally

```bash
npm run dev
```

or
```bash
npm run build
cp proxy_config.example.toml proxy_config.toml
PROXY_CONFIG_PATH=./proxy_config.toml npx tsx dist/server.js
```

#### Optional: ChatJimmy SDK (`sdk://` models)

The ChatJimmy SDK is an **optional** dependency, shipped as the git submodule
`submodules/chatjimmy`. It is **only** needed if your config routes a model to an
`sdk://` upstream (see [ChatJimmy SDK Integration](#chatjimmy-sdk-integration-2026-03-04)). The submodule is loaded
lazily at runtime via a dynamic import, so:

- **Not using `sdk://` models?** Skip it entirely. A plain `git clone` (without
  `--recurse-submodules`) leaves the submodule absent, and `npm install`,
  `npm run typecheck`, `npm run build`, and `npm run server` all work normally.
  Only `sdk://` routes would return an `SDK_ERROR` at request time.
- **Using `sdk://` models?** Fetch and build the submodule once:

  ```bash
  git submodule update --init --recursive
  git submodule update --remote --merge
  npm run build-chatjimmy        # builds submodules/chatjimmy/dist
  ```

  The SDK handler imports the built output from `submodules/chatjimmy/dist/`, so
  re-run `npm run build-chatjimmy` after updating the submodule.

#### Routing a model through the SDK

Any model entry can be routed through the ChatJimmy SDK by setting its
`base_url` slot to an `sdk://host/path` URL. The handler rewrites the scheme
(`sdk://host/path` → `https://host/path`) when building the SDK client, so the
third-party endpoint is fully configurable per model — no code change needed to
point at a different host, path, or vendor.

```toml
[models.free]
upstream_mode = "openai-completions"
api_key = "WELCOME_TO_USE"

# Chatjimmy (default example)
llama3 = {target = "llama3.1-8B", base_url = "sdk://chatjimmy.ai/api", api_key = "-"}    # target != alias, overrides set → full form
```

Leave the `api_key` slot empty to use the per-request `Authorization` /
`x-api-key` header from the caller; set it to a literal key (or
`x-api-key: sk-...` form) to force a specific upstream credential.

### 3.1 Terminal Dashboard

Run the server with `TUI=true` to open the terminal dashboard in the same process:

```bash
cp proxy_config.example.toml proxy_config.toml
TUI=true PROXY_CONFIG_PATH=./proxy_config.toml npx tsx dist/server.js
```

The TUI shows live:
- **Custom Models**: configured models with live response time (min/avg/max in seconds) shown as `[min/avg/maxs]` after each model, keyed by resolved route model name
- model token stats
- combined tool usage stats by tool (`req` aggregates across UA prefixes; `resp` is by tool)
- composite alias summaries with live token usage (`used / L limit/duration` for aliases with `token_limit`) and per-target response time
- `Tokens Panel [total L limit/duration]` — shows rolling-window token total alongside the global limit; turns yellow at ≥80%, red at ≥100%
- `Top Models` shows just the model id suffix, not the full routed upstream string

Keyboard shortcuts (main view):
- `c` open composite alias editor
- `t` open test model picker
- `r` reload config
- `l` set/clear the **global** token limit (applies to all models; format: `<num>[K|M|B|T]> <1h|1d|1w|1m>`, e.g. `1.1B 1d`, `50K 1h`, blank clears)
- `p` open the **Tool Blocklist** overlay (per-(tool, agent) panel — `Enter` toggles a tool's block state, `↑/↓` moves, `P`/`Esc` closes; blocked tools are marked with a red `✗` at the left of each row and stop accumulating stats)
- `Ctrl+U` dump today's tokens to log file (TUI mode)
- `Ctrl+C` quit

Keyboard shortcuts (composite alias editor):
- `↑/↓` or `j/k` to move
- `a` add a composite alias
- `L` (shift-l) set/clear the **alias-level** token limit (format: `<num>[K|M|B|T]> <1h|1d|1w|1m>`, e.g. `50K 1d`, `1.5M 1h`, blank clears)
- `F` (shift-f) edit fusion_options for the selected alias (fusion aliases only)
- `M` (shift-m) add a target to the selected alias
- `E` (shift-e) edit the selected target
- `D` (shift-d) delete the selected target

> For fusion aliases (`fusion_options` is set), the `M`/`E` target prompts use `panel|judge|synth [weight]` instead of the usual `share [primary] [fallback]`. See [Editing fusion aliases in the TUI](#editing-fusion-aliases-in-the-tui) below.

**Test custom model**: Press `T` to open the model picker. Each model shows its **category**, **upstream mode** (postfix only, e.g. `completions`/`messages`), and **base URL** (without `https://` prefix). Select a model and press Enter to send a test request — the result displays the response's `message`/`content`/`error` fields (IDs excluded).

**Test composite aliases**: Composite aliases are also listed in the picker (shown with `→ target1, target2, ...` as description). If a composite alias shares the same name with a model (e.g. `code-small`), the composite appears as `code-small [C]` so both can be selected for testing independently.

**Test fusion aliases** (`[F]`): the test is sent **directly to one of the panel target models** (a plain text request, no judge/synth stages). This avoids the full fusion pipeline (which would fail the test format check) while still exercising that panel member's route and API key. The chosen panel target is the first one in config order with `role: panel` or `fusion > 0`.

**Tool Blocklist (`P`)**: opens a per-(tool, agent) panel sourced from the dashboard snapshot's `agentToolStats`. Each row shows the tool name, agent (user-agent prefix), and three counters (`req`, `resp`, `len`). The leftmost column shows the current block state:
- `·` (green) — tool is allowed; stats continue to be recorded.
- `✗` (red) — tool is blocked; future stat recording is skipped. Existing pre-block counts are preserved.

Press `Enter` to toggle the block state for the highlighted tool. The blocklist is in-memory only (lives in `blockedTools` inside `src/utils/dashboard-stats.ts`); it is not persisted across proxy restarts and is not exposed via the dashboard edit API. Subtitle shows `↑↓ move  Enter toggle block  P/Esc close`.

> **Important**: When a model name has **both** a `[models.*]` config entry and a `[composite]` alias with the same name, selecting the model **without** `[C]` does **not** use the model entry's specific `base_url` or `api_key` — it routes through the composite alias instead. The composite routing resolves each target model independently, and the model entry's URL/key is only used for the picker display label. The `[C]` suffix is the actual way to test the composite alias routing; selecting the base name effectively bypasses the model's own config. To test a model entry's own base URL and API key in isolation, either remove the conflicting composite alias or test a model that doesn't share a name with a composite alias.

### 3.2 Token Log Persistence

Token log persistence is **opt-in**. It only runs when the proxy is started
with `TUI=true` (or `TUI=1`) or `DUMP=true` (or `DUMP=1`). Without one of
those flags, the proxy keeps all stats in memory only — heatmap events are
capped at the 30-day in-memory retention window (`recordTokenHeatmapEvent`
in `src/utils/dashboard-stats.ts`), and the JSONL log file is neither read
at startup nor written at day rollover. In-memory stats feed the live
`/dashboard` and TUI views exactly the same way; only restart-survival
requires the log.

When persistence is enabled, the proxy writes token stats, heatmap data,
and composite limit windows to `./model_proxy_tokens.jsonl` (JSONL format)
for recovery after restart.

**Log file format** (one JSON object per line):
```json
{"date":"2026-06-05","timestamp":1750000009,"lastDumpTs":0,"modelStats":[{"model":"deepseek-v4-flash","requests":53,"failed_requests":1,"input_tokens":333034,"cached_tokens":0,"cache_written_tokens":0,"output_tokens":4664,"total_tokens":337698},{"model":"gpt-5-mini","requests":12,"failed_requests":0,"input_tokens":80000,"cached_tokens":10000,"cache_written_tokens":5000,"output_tokens":12000,"total_tokens":97000}],"toolStats":[{"name":"Bash","agent":"claude-cli","req":12,"resp":10,"len":43821,"blocked":0}],"heatmapEvents":{"models":{"a3f1":"deepseek-v4-flash","b7c2":"gpt-5-mini"},"sequences":[{"ts":1750000001,"values":24223,"id":"a3f1"},{"ts":1750000005,"values":8100,"id":"b7c2"}]},"compositeLimitWindows":{"gpt-all":{"limit":120000,"duration":"1d","windowStartMs":1750000000000,"accumulator":8400}}}
```
> Note: `lastDumpTs: 0` = full snapshot (day rollover); `lastDumpTs: 1750000000` = delta row (events newer than the previous dump). `timestamp` is Unix seconds in new-format dumps. `heatmapEvents` uses `ts` in seconds with model ids (`a3f1`, `b7c2`) referencing the `models` lookup map.

Fields:
- `date` / `timestamp`: date string and Unix seconds timestamp of the dump (new format); legacy dumps may use ISO string
- `lastDumpTs`: unix ms timestamp of the previous dump. `0` = full snapshot (daily rollover). Used to write delta-only events and to filter events on load (backward compatible with old rows without this field).
- `modelStats`: cumulative daily token stats per model (written every dump). Fields: `model`, `requests`, `failed_requests`, `input_tokens`, `cached_tokens`, `cache_written_tokens`, `output_tokens`, `total_tokens`. **Format evolution**: old dumps wrote 1 entry per record with an ISO `timestamp`; new dumps write all active models in a single record with `timestamp` as Unix seconds and the new `lastDumpTs`, `toolStats`, and restructured `heatmapEvents` top-level fields. Both shapes are accepted on load.
- `toolStats`: per-(tool, agent) cumulative usage rows (`name`, `agent`, `req`, `resp`, `len`, `blocked`). Example row: `{"name":"Bash","agent":"claude-cli","req":12,"resp":10,"len":43821,"blocked":0}`. Rows are sorted by `(req+resp+len)` desc with `req` desc as a tiebreak. `agent` defaults to `all` for legacy single-tenant rows. `blocked` is a snapshot of the in-memory `blockedTools` set at dump time (1 = blocked, 0 = not blocked) — it is informational only and **not** restored on load; the blocklist itself is in-memory and resets at startup.
- `heatmapEvents`: same-day heatmap events only. Each dump writes **delta-only** — events newer than `lastDumpTs`. Day rollover writes a full same-day snapshot. Stored as `{ models: { <hex-id>: <model-name> }, sequences: [{ ts, values, id? }] }`. Model ids are 4 hex chars (16 bits, 65k ids) — more than enough for any realistic model fleet. Only models referenced by this row's `sequences` are included in `models`, so each row is self-contained.
- `compositeLimitWindows`: persisted composite alias limit windows

**Persistence gate (opt-in):**
- `TUI=true` or `DUMP=true` — enables JSONL persistence. The flag must be set
  for both the periodic 30-min dump, the manual `Ctrl+U` dump (TUI), the
  day-rollover dump, and the startup restore. Without it, none of these
  touch the filesystem.
- The flag is computed once at startup (`setStatsPersistenceEnabled()` in
  `src/utils/dashboard-stats.ts`) and read by every dump function. Day
  rollover still clears the in-memory daily bucket so the live dashboard
  resets correctly — only the file write is skipped.

**Dump triggers (only active when persistence is enabled):**
- **TUI=1** — automatic dump every 30 min (skipped if total tokens unchanged since last dump)
- **DUMP=1** (non-TUI/server mode) — automatic dump every 30 min (skipped if total tokens unchanged)
- **Ctrl+U** — manual dump at any time in TUI
- **Day transition** — when a new day begins, previous day's data is dumped before clearing

**Startup restore (only runs when persistence is enabled; backward compatible with all existing log files):**
- On proxy startup, `loadTokenStatsFromLog()` reads the last 30 days from the log
- **modelStats** (dashboard daily map): loaded from the latest dump per date only (later dumps overwrite earlier). The cumulative `modelStats` Map that powers the TUI "Top Models" panel and `getModelTotalTokens()` is **accumulated** across the latest dump per date — each per-date dump is that day's totals (the day-rollover dump is the authoritative end-of-day snapshot), so summing them reconstructs true all-time totals. `dailyTokenStats` is cleared at every day rollover, so each dump covers exactly one day with no overlap — no double-counting. This is also the fallback used by composite `token_limit` when the rolling window has expired and no duration was configured.
- **toolStats**: loaded from the latest dump per date only (later dumps overwrite earlier). Each row is split back into the three source maps consumed by the dashboard:
  - `agentStats` (key = `${agent} / ${tool}`) — restored only when `req > 0`
  - `upstreamResponseToolStats` (key = `${tool}\0${agent}`) — restored only when `resp > 0`
  - `toolRequestChars` (key = `${tool}\0${agent}`) — restored only when `len > 0`
  Rows from older dump files that lack the `agent` field (or have an empty `agent`) are loaded under `agent = 'all'`. The `blocked` field is **not** restored — the in-memory `blockedTools` set always starts empty.
- **heatmapEvents**: loaded from **all rows** across all dates, deduplicated by `ts:values:id`
  - For rows without `lastDumpTs` (old format): all events included
  - For rows with `lastDumpTs > 0` (new delta rows): only events newer than `lastDumpTs` are included
  - Both the legacy array shape (`[{timestamp, values, model}]`) and the current object shape (`{models, sequences}`) are accepted; legacy rows are converted to the in-memory id form on load
  - **Timestamp unit**: on-disk timestamps in sequences are always in **seconds** (e.g., `ts: 1750000001`). Legacy array timestamps were in **milliseconds** (e.g., `timestamp: 1750000001000`) — these are converted to seconds (`* 1000` → ms) on load so they land in the correct range for `getTokensInWindow` to scan correctly. After running the transform script (`tests/transform_dump_data_precise_size.py`) to convert legacy rows to the new format, timestamps are always seconds and no unit conversion is needed.
  - 30-day retention cutoff always applied
- **compositeLimitWindows**: restored if the window has not expired. If `windowStartMs + durationMs > now`, the accumulator is restored and enforcement continues from where it left off. If the window has expired, the window is NOT restored (fresh window starts).

**Token limit enforcement and reload behavior**: There are two independent limit mechanisms:

- **Composite alias `token_limit`** (e.g., `"gpt-all" = {"token_limit": {"num": 120000, "duration": "1d"}, ...}`): uses the `compositeLimitWindows` rolling window accumulator. On reload, if `windowStartMs + durationMs > now`, the accumulator is restored and enforcement picks up where it left off. If the window has expired, the window is dropped and a fresh window starts at 0.
- **Global `global_token_limit`** (e.g., `global_token_limit = "1.1B 1d"`): uses `getTokensInWindow(durationMs)` which scans the full `tokenHeatmapEvents[]` array with a `windowSumFrozen`/`windowSumCutoff` optimization — events older than the window boundary are cached in a frozen sum and excluded from repeated scans. After reload, all restored heatmap events (within the 30d retention window) are available for the global scan, so the limit is enforced accurately from the first request.

### 4. Deploy

#### Docker
```bash
# export VERSION=$(git log -n 1 --pretty=format:"%h")
cp proxy_config.example.toml proxy_config.toml
docker build --build-arg VERSION=$(git log -n 1 --pretty=format:"%h") -t model-proxy-v3 .
docker run -p 8788:8788 -v $(pwd)/proxy_config.toml:/app/proxy_config.toml model-proxy-v3
```

#### PM2 (High Performance)
```bash
npm run build
pm2 start dist/server.js -i 4
```

### 5. Test

#### Agent testing
refer to [tests/multi-agents-test.t](tests/multi-agents-test.ts)

#### Test cases for coverage testing
refer to [testcases/README.md](testcases/README.md)

#### Other testing
refer to files in `./tests`.

### 6. Docs
- `../architecture/routing_refactor.md` - Routing architecture and implementation
- `../architecture/routing_config_revision.md` - Latest config structure revision (2026-02-27)
- `../reference/config_loader.md` - Configuration loading guide
- `../../tests/logs/results/test_results_after_refactoring.md` - Comprehensive test results (42 models tested)
- `../../tests/logs/results/test_guideline.md` - Testing guide and configuration reference
- `../contributing/CONSOLIDATION.md` - Consolidated test scripts documentation

## 📚 API Reference

## API Specifications
this proxy implements claude and gemini API formats for multiple models:
- **Claude Messages API**: See `../api/claude_api_docs/messages-api.md`
- **OpenAI Responses API**: See `../api/openai-response.md` (passthrough or convert to chat completions)
- **Gemini Interactions API**: See `../api/interactions.md`
- **Gemini GenerateContent API**: See `../api/vertex-ai-gemini-api.md`
- **OpenAI Chat Completions**: Standard `/v1/chat/completions` format not for endpoints, just for upstream to Compatible API

For detailed routing behavior, see `../architecture/routing_refactor.md`.

#### `/v1/chat/completions` — always-on passthrough

`POST /v1/chat/completions` is **always served** as a per-model routed passthrough — the
`DEV_PASS_THROUGH` env var was removed (2026-08); the endpoint behaves as if
`DEV_PASS_THROUGH=true` were always set. The request body is forwarded to the resolved
upstream with no format conversion.

What is **bypassed**:
- **Schema conversion** — the client speaks raw OpenAI chat-completions; no Claude→OpenAI conversion runs.
- **Local credential check** — the proxy forwards the caller's `Authorization` / `x-api-key` / `x-goog-api-key` to the upstream without validating it. The upstream performs authentication, so a key valid on the upstream returns 200 and an invalid one returns the upstream's 401. The configured `[models.*].api_key` is only sent on top when `auth_passthrough_with = "config_key"` is set globally. Do not expose this endpoint on a public network.

What **applies** for routing:
- **Per-model routing** — `[models.*]` category lookup runs. Per-model `base_url`, `api_key`, and `upstream_mode` overrides apply; the correct upstream is selected based on the model in the request body.
- **Composite/alias resolution** — composite aliases (e.g. `for-claw`) and `target`-mapped entries (e.g. `minimax-m3` → `MiniMax-M3`) are resolved. The `model` field in the forwarded body is rewritten to the resolved target model id. If no alias resolves, the original model name is forwarded unchanged.
- **Falls back** to `parseFixedRoute` / `[upstream] default_base_url` only when no per-model route is found.

What still **applies**: request validation (openai-completions schema), privacy-filter / Kompress
/ blocked-tool erasure, upstream auth-header transformation, and dashboard stats.

### Models API

**Endpoint**: `GET /v1/models`

List available models from the target API.

**Example URL**:
```
GET /v1/models
```

**Response**:
```json
{
  "data": [
    {
      "id": "deepseek-v3.1",
      "type": "model",
      "created_at": "2024-01-01T00:00:00Z",
      "display_name": "DeepSeek V3.1"
    }
  ],
  "first_id": "deepseek-v3.1",
  "has_more": false,
  "last_id": "deepseek-v3.1"
}
```

### Messages API

**Endpoint**: `POST /v1/messages`

Send messages with optional thinking configuration.

**Example URL**:
```
POST /v1/messages
```

**Request with Thinking (String Format)**:
```json
{
  "model": "deepseek-v3.1",
  "messages": [
    {
      "role": "user",
      "content": "What is the capital of France?"
    }
  ],
  "max_tokens": 1000,
  "thinking": {
    "type": "enabled",
    "budget_tokens": 10000
  }
}
```

**Request with Thinking (Boolean Format - New)**:
```json
{
  "model": "deepseek-v3.1",
  "messages": [
    {
      "role": "user",
      "content": "What is the capital of France?"
    }
  ],
  "max_tokens": 1000,
  "thinking": {
    "type": true,
    "budget_tokens": 10000
  }
}
```

**Request with Thinking Disabled (Boolean Format)**:
```json
{
  "model": "deepseek-v3.1",
  "messages": [
    {
      "role": "user",
      "content": "What is the capital of France?"
    }
  ],
  "max_tokens": 1000,
  "thinking": {
    "type": false
  }
}
```

**Response**:
```json
{
  "id": "msg_123456789",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "The capital of France is Paris."
    }
  ],
  "model": "deepseek-v3.1",
  "stop_reason": "end_turn",
  "usage": {
    "input_tokens": 10,
    "output_tokens": 5
  }
}
```

#### Tool Use / Tool Result Pairing

When a conversation involves tool calling, the `messages` array must keep each `tool_result`
paired with the `tool_use` that produced it. The Anthropic Messages API enforces this rule:

> Each `tool_result` block must have a corresponding `tool_use` block in the previous message.

Concretely, a `user` message that contains a `tool_result` block **must** be immediately
preceded by an `assistant` message that contains a `tool_use` block whose `id` equals the
`tool_result.tool_use_id`:

```json
{
  "model": "claude-3-5-sonnet",
  "max_tokens": 1024,
  "messages": [
    { "role": "user", "content": "What's the weather in Paris?" },
    {
      "role": "assistant",
      "content": [
        { "type": "tool_use", "id": "toolu_01ABC", "name": "get_weather", "input": { "city": "Paris" } }
      ]
    },
    {
      "role": "user",
      "content": [
        { "type": "tool_result", "tool_use_id": "toolu_01ABC", "content": "18°C, clear" }
      ]
    }
  ]
}
```

For the `anthropic-messages` upstream mode the request body is forwarded to the upstream as-is
(the `messages` array is never rewritten by the proxy), so any pairing problem in the client's
request is passed straight through to the upstream.

**Common error**

```
unexpected `tool_use_id` found in `tool_result` blocks: toolu_01PhkfNN2JKwWFR8D4amDHi4.
Each `tool_result` block must have a corresponding `tool_use` block in the previous message.
```

This is returned by the upstream (HTTP 400) when a `tool_result` references a `tool_use_id`
that has no matching `tool_use` in the preceding `assistant` message.

**Notice**: the tool use error is first observed when using `claude-fable-5` with `v2.1.89 (Claude Code)` on linux.
But when using `claude-opus-4-8` on same tool and OS (enven same upstreaming proxy) for excuting same task, there is 
no tool use errors occur.

**Typical causes**

- The client sent a follow-up request containing only the `tool_result` and dropped the prior
  `assistant` `tool_use` turn (e.g. client-side history truncation or context compression).
- The preceding message is not an `assistant` message, or is an `assistant` message without a
  `tool_use` block.
- The `tool_use_id` was altered between turns so it no longer matches the original `tool_use.id`.

**How to fix**

- Always include the full conversation history, keeping the `assistant` `tool_use` turn directly
  before the `user` `tool_result` turn that answers it. This is the standard Anthropic Messages
  API contract and the most reliable fix.
- Verify the `tool_use_id` in each `tool_result` exactly matches the `id` of a `tool_use` block
  in the immediately preceding `assistant` message.
- If you suspect the client is dropping turns, enable debug logging and inspect the outgoing
  request body to confirm the last two messages form a valid `tool_use` → `tool_result` pair
  before it reaches the upstream.

---

## 🧠 Thinking and Reasoning

The proxy provides full Claude-style extended thinking support, bridging thinking/reasoning across Claude, OpenAI, and Gemini upstream modes. All upstream thinking formats are normalized to Claude's `thinking_delta` / `signature_delta` streaming events.

### Supported Thinking Modes

| Mode | Config | Supported Models | Behavior |
|:-----|:-------|:-----------------|:---------|
| **Manual** | `thinking: { type: "enabled", budget_tokens: N }` | All models with thinking support | Fixed token budget for reasoning |
| **Adaptive** | `thinking: { type: "adaptive" }` | Claude Opus 4.6, Sonnet 4.6 | Claude decides when/how much to think |
| **Disabled** | Omit `thinking` or set `type: "disabled"` / `false` | All models | Standard response, no thinking |
| **Boolean** | `thinking: { type: true, budget_tokens: N }` | All models | Shorthand for `"enabled"` |

### Effort Parameter

Claude-style `output_config.effort` and `reasoning_effort` are accepted on `/v1/messages`:

- `"low"` — minimize thinking (fastest)
- `"medium"` — moderate thinking depth
- `"high"` — always think deeply (default for adaptive)
- `"max"` — no constraints on thinking depth (Opus 4.6 only)
- `"xhigh"` — normalized to `"max"` (non-standard input support)

When both `reasoning_effort` and budget thresholds are present, effort takes priority.

### Provider-Specific Handling

**Claude Native (`anthropic-messages`)** — Passthrough:
- `thinking: { type: "enabled" | "adaptive", budget_tokens }` forwarded as-is
- `output_config.effort`, `reasoning_effort` forwarded as-is
- `thinking_delta` / `signature_delta` events passthrough in streaming

**OpenAI-Compatible (`openai-completions`)** — Thinking to reasoning mapping:
- `thinking` field is **stripped** (not in OpenAI chat completions schema)
- `budget_tokens` → `reasoning_effort` via budget thresholds or defaults
- Default mapping: ≥4096 → `"high"`, ≥2048 → `"medium"`, else `"low"`
- Explicit thresholds via `[upstream].budget_to_effort_*` override defaults
- Upstream response: `<thinking>` markers, `reasoning_content`, or `delta.thinking` parts are extracted and converted to Claude `thinking_delta` events
- `reasoning_item_id` / `delta.signature` → `signature_delta` events

**Gemini (`gemini-generatecontent` / `gemini-interactions`)**:
- Claude `thinking` → Gemini `thinking_level: "medium"` + `max_output_tokens` budget
- Gemini response `thought` blocks → Claude `thinking` content blocks with signature

**SDK Handler (`sdk://`)**:
- Same `thinking` → `reasoning_effort` mapping as `openai-completions`
- Handles both Claude-format and OpenAI-format `thinking` objects

### Thinking Configuration Request Formats

The proxy accepts both Claude and OpenAI format on the `/v1/messages` endpoint:

**Claude Format**:
```json
{
  "thinking": { "type": "enabled", "budget_tokens": 10000 }
}
```

**OpenAI Format** (passthrough before conversion):
```json
{
  "thinking": { "enabled": true, "budget_tokens": 10000 }
}
```

**Adaptive Format**:
```json
{
  "thinking": { "type": "adaptive" },
  "output_config": { "effort": "medium" }
}
```

### Streaming Events

For SSE streaming, the proxy normalizes all upstream formats to Claude's streaming events:

| Event | Description | Source |
|:------|:------------|:-------|
| `content_block_start` / `type: "thinking"` | Thinking block begins | All upstreams |
| `thinking_delta` | Incremental thinking tokens | `<thinking>` markers, `reasoning_content`, `delta.thinking` parts |
| `signature_delta` | Thinking signature for verification | `delta.signature`, `reasoning_item_id`, `signature` metadata |
| `content_block_stop` | Thinking block ends | All upstreams |

### Signature Verification

Thinking signatures are accumulated across multiple sources and emitted as `signature_delta` before `content_block_stop`:

- **Non-streaming**: Signature embedded in thinking block metadata
- **Streaming**: `signature_delta` event before `content_block_stop`
- **Sources**: `delta.signature`, `reasoning_item_id`, `response.signature`

### Known Limitations

1. Some upstreams (e.g., DeepSeek's Anthropic-compatible API) internally default models to thinking mode regardless of the request's `thinking` parameter. The proxy handles this by stripping `thinking` config when no prior assistant thinking blocks exist in the conversation.

2. For `openai-completions` upstreams, Gemini `thought` content is dropped during conversion.

3. `thinking: { type: "disabled" }` is stripped entirely for all upstreams.

4. When `openai-completions` upstream returns thinking in the response, the conversion is lossless for streaming (real-time `thinking_delta`), but depends on `<thinking>` markers or `reasoning_content` for non-streaming responses.

### `reasoning: true` Compatibility Notes (qnaigc / deepseek)

Test observations for model config using `"reasoning": true`:

- ✅ Proxy → qnaigc: **ok**
- ✅ Proxy → deepseek/anthropic-compatible endpoint: **ok**
- ❌ Direct deepseek/openai-compatible: **failed**

### Supported Models

- **DeepSeek**: R1, R1-0528, V3.2-exp-thinking, V3.1-terminus-thinking
- **Qwen**: Thinking variants (vl-30b, 30b-2507, next-80b, 235b-2507)
- **Doubao**: seed-1.6-thinking, 1.5-thinking-pro
- **Moonshot/Kimi**: kimi-k2-thinking
- **Gemini**: 2.5-pro-preview, 3.1-pro-preview (includes reasoning_content)
- **Claude**: All 4.x models (Opus, Sonnet, Haiku)

### thinking to reasoning_effort Conversion (for openai-completions)

When forwarding requests to `openai-completions` upstreams, the proxy converts Claude-style `thinking` to OpenAI `reasoning_effort` in all code paths (direct passthrough, claude→openai converter, and SDK handler) because the OpenAI `/v1/chat/completions` schema does not support a `thinking` field.

**Default mapping** (no explicit thresholds):
```
budget_tokens >= 4096 → "high"
budget_tokens >= 2048 → "medium"
< 2048               → "low"
```

**Optional explicit thresholds** (`proxy_config.toml`):
```toml
[upstream]
budget_to_effort_low = 8000       # < 8000 tokens → "low"
budget_to_effort_medium = 20000   # < 20000 tokens → "medium"
budget_to_effort_high = 0         # >= threshold or 0 = always "high"
```

**Behavior**:
- `thinking: { enabled: true, budget_tokens: N }` or Claude `thinking: { type: "enabled", budget_tokens: N }` → `reasoning_effort` derived from budget, `thinking` stripped
- `thinking: { enabled: false }` or `thinking: { type: "disabled" }` → stripped entirely, no `reasoning_effort`
- No `thinking` in request → nothing changed
- If `reasoning_effort` is already set by the request → budget mapping skipped, `thinking` stripped, existing effort preserved

### Responses API

**Endpoint**: `POST /v1/responses`

OpenAI Responses API support with format conversion to/from Chat Completions.

**Request Example**:
```json
{
  "model": "gpt-4o",
  "input": "What is the capital of France?",
  "background": false
}
```

**Response Example**:
```json
{
  "id": "resp_chatcmpl-abc123",
  "object": "response",
  "created": 1773286630,
  "status": "completed",
  "model": "gpt-4o",
  "output_items": [
    {
      "id": "msg_123",
      "type": "message",
      "status": "completed",
      "content": [{"type": "output_text", "text": "The capital of France is Paris."}]
    }
  ],
  "usage": {
    "input_tokens": 14,
    "output_tokens": 8,
    "total_tokens": 22
  }
}
```

**How It Works**:
- When `upstream_mode = "openai-completions"` (default): Converts Responses API request → Chat Completions → sends to upstream → converts response back to Responses API format
- When `upstream_mode = "openai-responses"`: Passes through directly to OpenAI Responses API upstream

**OpenAI prompt caching fields**:

| Client endpoint | `upstream_mode` | `prompt_cache_key` | `prompt_cache_options` | `prompt_cache_breakpoint` |
|---|---|---|---|---|
| `/v1/responses` | `openai-responses` | Preserved | Preserved | Preserved |
| `/v1/responses` | `openai-completions` | Preserved | Dropped | Dropped during `input` → `messages` conversion |
| `/v1/chat/completions` | `openai-completions` | Preserved | Preserved | Preserved |
| `/v1/chat/completions` | `openai-responses` | Preserved | Dropped | Dropped during `messages` → Responses `input` / `instructions` conversion |

**Key Differences from Chat Completions**:
- Uses `input` instead of `messages`
- Response contains `output_items` array instead of `choices`
- Uses `status: "completed"` instead of `finish_reason`
- Does NOT support streaming (use `background: true` for async processing)

**Known Limitations** (`openai-completions` conversion mode):

1. **Image inputs dropped**: `input_image` content parts are converted to a `[Image input]` string placeholder rather than forwarded as multipart `image_url` content to the upstream Chat Completions API (`responses-to-completions.ts`).

2. **Reasoning content discarded**: When the upstream returns a `thinking` content block, a `reasoning` output item is emitted in the response but without any content — the reasoning text is silently lost (`completions-to-responses.ts`).

3. **`developer` role may cause upstream errors**: The `developer` role is passed through as-is; most OpenAI-compatible upstreams do not support it and will return a validation error (`responses-to-completions.ts`).

4. **Stateful conversation (`previous_response_id`, `conversation`, `store`)**: By default the proxy is stateless — `previous_response_id` is silently dropped; the upstream receives only the current `input` with no prior history. This applies to both `openai-completions` and `openai-responses` modes (in the latter, the field is forwarded to the upstream, but non-OpenAI upstreams such as LiteLLM also have no conversation store and will silently ignore it).

**Notice**: set `CONVERSATION_STATE=true` (or `1`) in environment to enable the stateful conversation experimental feature for `openai-completions` upstream mode. The proxy then caches each response in memory (TTL 3600s, single process instance) and:
   - `previous_response_id`: prior input + output items are prepended to the new request's `input`.
   - `conversation` (string or `{ "id": ... }`): the conversation's accumulated items are prepended; this turn's new input items and output items are appended to the conversation afterwards. Using both `previous_response_id` and `conversation` in one request is rejected with `400` (spec forbids the combination).
   - `store: false`: the response is not stored (no continuation, not retrievable).
   - Retrieval: `GET /v1/responses/{id}` returns the stored response object; `GET /v1/responses/{id}/input_items` returns the merged input items. Unknown/expired/unstored IDs return `404`.

   **Required client-side fix**: set `store: false` and pass the full conversation history in `input` on every request. This is the correct stateless usage pattern per the Responses API spec:
   ```json
   {
     "model": "gpt-4o",
     "store": false,
     "input": [
       {"type": "message", "role": "user",      "content": "What is the capital of France?"},
       {"type": "message", "role": "assistant",  "content": [{"type": "output_text", "text": "Paris."}]},
       {"type": "message", "role": "user",       "content": "And Germany?"}
     ]
   }
   ```
   Tool call turns use `function_call` / `function_call_output` items in the same array. See the [OpenAI Responses API docs](https://platform.openai.com/docs/api-reference/responses) for the full item schema.

   Other silently dropped fields: `background`, `context_management`.

5. **Streaming tool call name latency**: In SSE mode, the `response.output_item.added` event for a function call may emit an empty `name` field if the tool name arrives in a later chunk from the upstream (`handlers/responses.ts`).

**Configuration**:
```toml
[models.default]
upstream_mode = "openai-completions"  # Default: converts to chat completions
# upstream_mode = "openai-responses"   # Alternative: pass through to Responses API
```

### Token Counting API

**Endpoint**: `POST /v1/messages/count_tokens`

Count tokens in messages, including thinking configuration.

**Example URL**:
```
POST /v1/messages/count_tokens
```

**Request**:
```json
{
  "model": "deepseek-v3.1",
  "messages": [
    {
      "role": "user",
      "content": "What is the capital of France?"
    }
  ],
  "thinking": {
    "type": "enabled",  // or "type": true
    "budget_tokens": 10000
  }
}
```

**Response**:
```json
{
  "type": "token_count",
  "input_tokens": 10,
  "cache_creation_input_tokens": 0,
  "cache_read_input_tokens": 0
}
```

### Embeddings API

**Endpoint**: `POST /v1/embeddings`

Generate vector embeddings for text input. Proxied to the upstream OpenAI-compatible API (`{defaultBaseUrl}/v1/embeddings`). The `provider` field is stripped from the upstream response.

**Example Request**:
```bash
curl http://localhost:8788/v1/embeddings \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen/qwen3-embedding-4b",
    "input": "Your text string goes here",
    "encoding_format": "float"
  }'
```

The `input` field also supports batch processing with arrays:
```json
{
  "model": "qwen/qwen3-embedding-4b",
  "input": ["text1", "text2", "text3"]
}
```

**Response**:
```json
{
  "object": "list",
  "data": [
    {
      "object": "embedding",
      "embedding": [0.000136, 0.001807, ...],
      "index": 0
    }
  ],
  "model": "Qwen/Qwen3-Embedding-4B",
  "usage": {
    "prompt_tokens": 6,
    "total_tokens": 6
  }
}
```

**Configuration**:
```toml
[models.embedding]
upstream_mode = "anthropic-messages"
#base_url = "https://api.qnaigc.com"
#base_url = "https://openrouter.ai/api"
#api_key = "sk-..."
```

The embedding endpoint checks `[models.embedding]` in the proxy config first. If `base_url` and `api_key` are configured there, they take priority over defaults. Falls back to `[models.default]` / `[upstream]` when not set in `[models.embedding]`.

See `../../tests/logs/results/test_embeding.md` for more details.

### Dashboard API

The proxy includes a built-in web dashboard for config editing and runtime stats.

**Page**:
- `GET /dashboard`

**Config APIs**:
- `GET /dashboard/api/config`
  - Returns sanitized config for dashboard editing (`models.*`, `composite`)
  - `api_key` values are never returned
  - Includes `read_only: true` when `PROXY_CONFIG_CONSUL` or `PROXY_CONFIG_APOLLO` is configured
- `PUT /dashboard/api/config`
  - Applies dashboard edits to local `proxy_config.toml`
  - Available only when using file config mode
  - Read-only/disabled when `PROXY_CONFIG_CONSUL` or `PROXY_CONFIG_APOLLO` is configured

**Stats APIs**:
- `GET /dashboard/api/stats/models`
  - Requests, input tokens, output tokens by model (DESC)
- `GET /dashboard/api/stats/agents`
  - Requests by `user-agent-prefix / tool-name`
- The full `/dashboard` snapshot includes:
  - `agentToolStats`: per-(tool, agent) rows from `getAgentToolPanelStats()` — `{ tool_name, agent, in_requests, in_responses, in_request_chars }`. Keys are composite (`${tool}\0${agent}`) so the same tool used by different agents is reported as separate rows. Powers the TUI Tool Blocklist overlay (`P` key).
  - `blockedTools`: array of currently-blocked tool names (snapshot of the in-memory `blockedTools` set). Empty on a fresh proxy — the set is not persisted across restarts.
- `GET /dashboard/api/stats/requests`
  - Requests by endpoint
  - Responses by upstream base URL
  - Response status codes split into:
    - from upstreams
    - to endpoints
  - **endpoint_timings**: per-endpoint min/avg/max response time (ms), request count
  - **model_timings**: per-model min/avg/max response time (ms), request count. Key = resolved upstream model name (e.g. `moonshotai/kimi-k2.6`). Timing is recorded for all requests (success and error). Config key resolution: for `[models.*]` entries, the config key `row.modelId` is matched against `routeModel` (the upstream model name in the config array); for composite targets, `routeModel` from `compositeResolved` is used.

### Token Stats (Normalized Mapping)

Dashboard/API token stats can be normalized to a single shape:

- `input_tokens`
- `cached_tokens`
- `cache_written_tokens`
- `output_tokens`
- `total_tokens`

| Endpoint family | input_tokens | cached_tokens | cache_writen_tokens | output_tokens | total_tokens |
|---|---:|---:|---:|---:|---:|
| Claude `/v1/messages` | `usage.input_tokens` | `usage.cache_read_input_tokens` | `usage.cache_creation_input_tokens` | `usage.output_tokens` | `input + cached + cache_writen + output` |
| OpenAI `/v1/chat/completions` | `usage.prompt_tokens` | `0` | `0` | `usage.completion_tokens` | `usage.total_tokens` |
| OpenAI `/v1/responses` | `usage.input_tokens` | `usage.input_tokens_details.cached_tokens` | `0` | `usage.output_tokens` | `usage.total_tokens` |
| Gemini `generateContent` | `usageMetadata.promptTokenCount` | `0` | `0` | `usageMetadata.candidatesTokenCount` *(or `responseTokenCount` in SSE)* | `usageMetadata.totalTokenCount` |
| Gemini `/v1/interactions` | `usage.total_input_tokens` | sum of `usage.cached_tokens_by_modality[*].token_count` *(if present)* | `0` | `usage.total_output_tokens` | `input_tokens + output_tokens` |
| Embeddings `/v1/embeddings` | `usage.prompt_tokens` | `0` | `0` | `0` | `usage.total_tokens` |
| Count-tokens endpoints (`/v1/messages/count_tokens`, `:countTokens`) | endpoint-specific input count | `0` | `0` | `0` | same as input |

Fallback rules:
- Missing fields are treated as `0`.
- Prefer provider-returned `total_tokens`; otherwise derive from normalized fields.

**Anthropic usage semantics (disjoint input fields):** for Claude `/v1/messages`, the three input-side fields never overlap:

- `input_tokens` — only the **uncached** part of the prompt
- `cache_read_input_tokens` (`cached`) — prompt tokens served from the prompt cache
- `cache_creation_input_tokens` (`wrote`) — prompt tokens written to the cache

Real prompt size = `in + cached + wrote`. With prompt caching active (e.g. Claude Code clients), `input_tokens` is typically tiny while `cached`/`wrote` carry almost the whole prompt — a small `token in` next to large `wrote`/`cached` values in the TUI/dashboard is normal, not a bug. For streaming responses, `cached`/`wrote` are captured from the `message_start`/`message_delta` SSE usage frames.

**Streaming usage for converted (Claude→OpenAI) upstreams:** when the proxy converts a streaming `/v1/messages` request to an OpenAI-compatible upstream, it sends `stream_options: { include_usage: true }` so the upstream reports usage in its final SSE chunk. The Claude SSE emitted back has:

- `message_start.usage.input_tokens` — local tiktoken estimate of the request (available immediately)
- final `message_delta.usage` — upstream-reported `prompt_tokens`/`completion_tokens` (preferred over local estimates when present), plus `cache_read_input_tokens` (from `prompt_tokens_details.cached_tokens` or DeepSeek `prompt_cache_hit_tokens`) and `cache_creation_input_tokens` (from DeepSeek `prompt_cache_miss_tokens`)

The TUI/dashboard stats tracker reads the final `message_delta` values, so streamed requests get real `token in`/`cached`/`wrote` numbers instead of `0`.

## 🔧 Configuration

### Environment Variables

All configuration is driven through `wrangler.toml` `[vars]`. When running via the Node.js server (`npm run server` / `dist/server.js`), set the same vars as `process.env` — `wrangler.toml` is **not** read by `server.ts`.

```toml
# wrangler.toml
# This file serves as a reference for all available environment variables.
# When using wrangler (npm run dev / npm run deploy), vars are injected automatically.
# When using Node.js server, set them as process.env instead.

[vars]
# ─── Required ───────────────────────────────────────────────────────────────────

# Config file path OR Consul server address (pick one)
# File mode:
PROXY_CONFIG_PATH = "./proxy_config.toml"
# Consul mode (comment out PROXY_CONFIG_PATH):
# PROXY_CONFIG_CONSUL = "http://localhost:8500"

# ─── Optional ───────────────────────────────────────────────────────────────────

# Enable local tiktoken-based token counting (no API call needed)
# Set to "true" for faster, offline token counting
LOCAL_TIKTOKEN = "true"
TIKTOKEN_MODEL = "o200k_base"

# JSON serialization method for format converters
# "json"         - built-in JSON.stringify (fastest, default)
# "safe-stable"  - safe-stable-stringify (handles circular refs)
# "fast-safe"    - fast-safe-stringify (balanced)
JSON_STRINGIFY_METHOD = "json"

# Models list cache TTL in seconds (default: 300 = 5 minutes)
# Set to "0" to disable caching
MODELS_CACHE_TTL = "300"

# Upstream body fetch timeout in milliseconds (default: 600000 = 10 minutes)
UPSTREAM_BODY_TIMEOUT_MS = "600000"

# Allowed target hosts for SSRF protection on dynamic routes (comma-separated).
# ⚠️ DYNAMIC ROUTES ONLY: `isHostAllowed()` (src/utils/routing.ts) is invoked from
# src/index.ts when a request hits a `/https/{host}/...` dynamic-route path; the
# parsed host is matched against `getAllowedHostsFromConfig(proxyConfig)`
# (hosts derived from `[upstream].default_base_url`, every `[models.*].base_url`,
# and per-model array overrides in proxy_config.toml), with `ALLOWED_HOSTS` here
# serving as an additional fallback list. Wildcards are supported (e.g.,
# `*.example.com` — note the literal `.` separator; the apex `example.com` does
# not match). Fixed routes (`/v1/messages`, `/v1/responses`, etc.) do not consult
# this list — they resolve their upstream from `proxy_config.toml` directly, so
# SSRF protection for them depends on the config being trustworthy.
ALLOWED_HOSTS = "127.0.0.1,localhost,api.qnaigc.com,api.example1.com,api.example2-ai.com,api.yoosheen.com,api.wenwen-ai.com"

# Development mode - allows all CORS origins
DEV_MODE = "true"

# Allowed CORS origins (comma-separated, or "*" for all)
ALLOWED_ORIGINS = "*"

# Max size for image block base64 data in bytes (default: 10485760 = 10MB)
IMAGE_BLOCK_DATA_MAX_SIZE = "10485760"

# Log level: "debug" | "info" | "warn" | "error"
LOG_LEVEL = "info"

# Default max_tokens for requests that don't include it (default: 8192)
# Some upstreams (e.g. DeepSeek Anthropic-compatible API) require max_tokens
# DEFAULT_MAX_TOKENS = "8192"

# Stateful conversation mode for /v1/responses (experimental)
# When "true", stores each response in memory and auto-prepends history
# for requests with previous_response_id / conversation. Also serves
# GET /v1/responses/{id} and /input_items retrieval. Requests with
# store:false are not stored. TTL: 3600s. In-memory only.
# CONVERSATION_STATE = "false"

# Privacy Filter (PII redaction) plugin — see "Privacy Filter" section below.
# Entirely inert unless PRIVACY_FILTER_URL is set (points at the local sidecar).
# PRIVACY_FILTER_URL = "http://127.0.0.1:8799"
# PRIVACY_FILTER_TIMEOUT_MS = "40000"
# PRIVACY_FILTER_MAX_CHARS = "1024000"

# Kompress (context compression) plugin — see "Kompress" section below.
# Entirely inert unless KOMPRESS_URL is set (points at the local sidecar).
# Lossy and one-directional: drops low-importance tokens to save upstream tokens.
# KOMPRESS_URL = "http://127.0.0.1:7777"
# KOMPRESS_ENDPOINTS = "/v1/messages,/v1/chat/completions,/v1/responses"
# KOMPRESS_FAIL_OPEN = "true"          # true = fail-open (forward original text on sidecar error)
# KOMPRESS_TIMEOUT_MS = "40000"
# KOMPRESS_MAX_CHARS = "1024000"
# KOMPRESS_KEEP_RATIO = "0.5"          # fraction of tokens to keep
# KOMPRESS_MIN_CHARS = "200"           # skip fragments shorter than this
```

For local Node.js runs, either pass inline or export them:

```bash
cp proxy_config.example.toml proxy_config.toml
# Inline (all vars)
LOCAL_TIKTOKEN=true LOG_LEVEL=debug PROXY_CONFIG_PATH=./proxy_config.toml node dist/server.js

# Or export first
export LOCAL_TIKTOKEN="true"
export LOG_LEVEL="debug"
export PROXY_CONFIG_PATH="./proxy_config.toml"
node dist/server.js
```

**Env var to `Env` field mapping** (`src/types/shared.ts` → `src/server.ts`):

| Env field | wrangler.toml var | Default |
|---|---|---|
| `LOCAL_TIKTOKEN` | `LOCAL_TIKTOKEN` | `"false"` |
| `ALLOWED_ORIGINS` | `ALLOWED_ORIGINS` | `"*"` |
| `DEV_MODE` | `DEV_MODE` | unset |
| `ALLOWED_HOSTS` | `ALLOWED_HOSTS` | `"127.0.0.1,localhost"` |
| `IMAGE_BLOCK_DATA_MAX_SIZE` | `IMAGE_BLOCK_DATA_MAX_SIZE` | `"10485760"` |
| `LOG_LEVEL` | `LOG_LEVEL` | `"info"` |
| `GEMINI_API_VERSION` | — (hardcoded) | `"v1beta"` |
| `MESSAGES_UPSTREAM_MODE` | — (hardcoded) | `"openai-completions"` |
| `INTERACTIONS_UPSTREAM_MODE` | — (hardcoded) | `"native"` |
| `GENERATE_CONTENT_UPSTREAM_MODE` | — (hardcoded) | `"native"` |
| `PROXY_CONFIG_PATH` | `PROXY_CONFIG_PATH` | `"./proxy_config.toml"` |
| `PROXY_CONFIG_CONSUL` | `PROXY_CONFIG_CONSUL` | unset |
| `PROXY_CONFIG_APOLLO` | `PROXY_CONFIG_APOLLO` | unset |
| `PORT` | — (Node.js only) | `"8788"` |
| `DEFAULT_MAX_TOKENS` | `DEFAULT_MAX_TOKENS` | unset |
| `CONVERSATION_STATE` | `CONVERSATION_STATE` | unset |
| `UPSTREAM_BODY_TIMEOUT_MS` | `UPSTREAM_BODY_TIMEOUT_MS` | unset |
| `MODELS_CACHE_TTL` | `MODELS_CACHE_TTL` | unset |
| `JSON_STRINGIFY_METHOD` | `JSON_STRINGIFY_METHOD` | unset |
| `TIKTOKEN_MODEL` | `TIKTOKEN_MODEL` | unset |
| `PRIVACY_FILTER_URL` | `PRIVACY_FILTER_URL` | unset (plugin off) |
| `PRIVACY_FILTER_TIMEOUT_MS` | `PRIVACY_FILTER_TIMEOUT_MS` | `"40000"` |
| `PRIVACY_FILTER_MAX_CHARS` | `PRIVACY_FILTER_MAX_CHARS` | `"1024000"` |
| `KOMPRESS_URL` | `KOMPRESS_URL` | unset (plugin off) |
| `KOMPRESS_ENDPOINTS` | `KOMPRESS_ENDPOINTS` | `"/v1/messages,/v1/chat/completions,/v1/responses"` |
| `KOMPRESS_FAIL_OPEN` | `KOMPRESS_FAIL_OPEN` | `"true"` |
| `KOMPRESS_TIMEOUT_MS` | `KOMPRESS_TIMEOUT_MS` | `"40000"` |
| `KOMPRESS_MAX_CHARS` | `KOMPRESS_MAX_CHARS` | `"1024000"` |
| `KOMPRESS_KEEP_RATIO` | `KOMPRESS_KEEP_RATIO` | `"0.5"` |
| `KOMPRESS_MIN_CHARS` | `KOMPRESS_MIN_CHARS` | `"200"` |

### Privacy Filter (PII redaction) plugin

The proxy can redact personally identifiable information (PII) **out of every outbound
request before it leaves the machine**, then restore the original values in the response
returned to the client. The client sees correct, un-redacted data; the upstream model
provider never sees the PII. The plugin is **entirely inert unless `PRIVACY_FILTER_URL`
is set**, so default behavior is unchanged.

It is built on [OpenAI Privacy Filter](https://huggingface.co/openai/privacy-filter)
(`opf`) — a ~1.5B-param bidirectional token classifier that detects 8 PII categories
(emails, phone numbers, names, addresses, account numbers, URLs, dates, secrets).

#### How it works (reversible redact → restore)

```
endpoint  →  proxy  →  filter sidecar  →  proxy (replace sentinels)  →  upstream LLM
                ↑                                                            │
                └──────── proxy (restore originals)  ←  response  ←  ────────┘
```

1. The proxy parses the request body and collects every user-visible text fragment
   (Anthropic `system` + `messages[].content`, OpenAI `messages[].content`; both string
   and `{type:'text'}` block shapes).
2. It batches them in a single `POST /redact` call to the local sidecar.
3. The sidecar runs `opf` and replaces each detected span with a **unique sentinel**
   (`⟦PII:0⟧`, `⟦PII:1⟧`, …). It returns the redacted texts plus a `sentinel → original`
   mapping. (Sentinels are unique — unlike `opf`'s bare `<PRIVATE_EMAIL>` placeholders —
   so the substitution is reversible.)
4. The proxy sends the redacted body upstream.
5. On the response, every sentinel is replaced back with its original value — for JSON
   responses via string replace, for `text/event-stream` (SSE) via a `TransformStream`
   that buffers across chunk boundaries so a sentinel split across two chunks is still
   matched. For **fusion**, intermediate panel/judge stages stay redacted; only the final
   synthesized response is restored.

Because the model is heavy to load, it runs in a **persistent Python HTTP sidecar** that
keeps the model resident in memory. The proxy only talks to it over `fetch`, so the plugin
stays compatible with both the Node server and Cloudflare Workers (only the sidecar is
host-side).

#### Start the sidecar

The sidecar lives in the `privacy-filter` submodule:

```bash
git submodule update --init submodules/privacy-filter

# --device auto probes mps (Apple Silicon) → cuda → cpu, with a warmup-based
# fallback to cpu if the chosen backend fails to load.
# --timeout bounds each /redact call (default 100s; 0 disables) so a stalled
# inference returns 504 instead of hanging the caller.
# --timeout should be longer than the proxy's PRIVACY_FILTER_TIMEOUT_MS so the proxy
# gives up first (returning 504 to the client) rather than aborting mid-inference
# (which would leave the sidecar thread hanging after writing to a closed socket).
OPF_MOE_TRITON=0 python submodules/privacy-filter/serve.py --device auto --port 8799 --timeout 100
```

> **Note:** the sidecar requires a Python where `torch` is installed. On this machine the
> working interpreter is Python 3.13 (`/Users/chris/dev/ai/bin/python3.13`); the bare
> `python` in the venv is 3.14 and lacks torch. Invoke the torch-enabled interpreter
> explicitly if `import torch` fails.

Then run the proxy pointed at it:

```bash
PRIVACY_FILTER_URL=http://127.0.0.1:8799 npm run server
```

Quick sidecar check:

```bash
curl -s localhost:8799/redact -d '{"texts":["email test@abc.com, NO.123 Sunset BLVD, LA"]}'
# → {"redacted":["⟦PII:0⟧, ⟦PII:1⟧, ⟦PII:2⟧, ⟦PII:3⟧"],"mapping":{"⟦PII:0⟧":"test@abc.com","⟦PII:1⟧":"123","⟦PII:2⟧":"Sunset BLVD","⟦PII:3⟧":"LA"},"span_count":4}
```

**Proxy → sidecar request/response flow (one text):**

```bash
curl -s localhost:8799/redact -d '{"text":"Send to test@abc.com, Street No.123, LA"}'
```

Sidecar response — the model detected 2 PII spans and replaced them with sentinels:

```json
{
  "redacted": ["⟦PII:0⟧, Street No.⟦PII:1⟧, LA"],
  "mapping": {
    "⟦PII:0⟧": "test@abc.com",
    "⟦PII:1⟧": "123"
  },
  "span_count": 2
}
```

| Field | Description |
|-------|-------------|
| `redacted` | Array of input texts with PII replaced by sentinels. Each sentinel (`⟦PII:N⟧`) is unique per-span so the mapping is reversible. |
| `mapping` | Map of sentinel → original PII value. Used by the proxy to restore the response on the way back to the client. |
| `span_count` | Total number of PII spans detected across all input texts. |

#### Configuration

| Var | Default | Meaning |
|-----|---------|---------|
| `PRIVACY_FILTER_URL` | unset | Sidecar base URL, e.g. `http://127.0.0.1:8799`. **Unset = plugin off.** |
| `PRIVACY_FILTER_TIMEOUT_MS` | `40000` | Per-call timeout to the sidecar. A larger value is needed because AI agents (e.g. Claude Code) use long contexts — a full conversation history with dozens of messages and code files can easily reach 100K+ characters, which takes the OPF model several seconds to scan. The sidecar's `--timeout` should always be longer than this value so the proxy aborts first (clean 504 to the client) rather than closing the socket mid-inference (which would crash the sidecar thread). |
| `PRIVACY_FILTER_MAX_CHARS` | `1024000` | Skip redaction above this total text size (safety cap). |

Timeouts are enforced on **both** ends: the proxy aborts the `fetch` after
`PRIVACY_FILTER_TIMEOUT_MS`, and the sidecar's `--timeout` independently bounds each
inference (returning `504`) so a stalled call can't tie up the serialized worker.

#### Limitations

- v1 covers the **text content** of chat endpoints only. Tool-call arguments, embeddings
  input, and image blocks are out of scope.
- `opf` is a redaction aid, not an anonymization guarantee — it can over- or under-redact.
  See the submodule's README and model card for details.

### Kompress (context compression) plugin

The proxy can **drop low-importance tokens out of outbound request text** to reduce the
number of tokens the upstream model is billed for. Unlike the privacy filter this is
**lossy and one-directional** — there is nothing to restore on the response side. The
plugin is **entirely inert unless `KOMPRESS_URL` is set**, so default behavior is
unchanged.

It is built on [kompress](./submodules/kompress/README.md)
([`chopratejas/kompress-v2-base`](https://huggingface.co/chopratejas/kompress-v2-base)) —
a ModernBERT-based token-importance scorer that keeps the top-N% most important tokens.

#### How it works (one-directional compress)

```
endpoint  →  proxy (compress text)  →  kompress sidecar  →  proxy  →  upstream LLM
                                                                         │
                       (response passes straight through, unchanged)  ←──┘
```

1. The proxy parses the request body and collects the fragments it is allowed to
   compress: **user-message text** (Anthropic/OpenAI string and `{type:'text'}` blocks)
   and **tool definitions/results** (Anthropic `tools[].description` + `tool_result`,
   OpenAI `function.description` + `role:'tool'` content). The system prompt, assistant
   messages, JSON schemas, images, and tool-call inputs are **never** touched.
2. Tiny fragments (below `KOMPRESS_MIN_CHARS`) and **non-English / CJK-heavy** fragments
   are skipped — the model is English-only and would garble non-Latin input.
3. Remaining fragments are sent in parallel, one `POST /compress` each (`{text,
   keep_ratio, max_length}`), and the returned `compressed` text is written back in place
   when it is shorter than the original.
4. The (smaller) body is sent upstream. The response is returned to the client unchanged.

Because the model is heavy to load, it runs in a **persistent Python HTTP sidecar** that
keeps the model resident in memory. The proxy only talks to it over `fetch`, so the plugin
stays compatible with both the Node server and Cloudflare Workers (only the sidecar is
host-side).

#### Start the sidecar

The sidecar lives in the `kompress` submodule:

```bash
git submodule update --init submodules/kompress

# See submodules/kompress/README.md for install + model download.
kompress-api-server --port 7777
```

Then run the proxy pointed at it:

```bash
KOMPRESS_URL=http://127.0.0.1:7777 npm run server
```

Quick sidecar check:

```bash
curl -s localhost:7777/compress \
  -d '{"text":"The quick brown fox jumps over the lazy dog.","keep_ratio":0.5,"max_length":512}'
# → {"compressed":" quick brown fox over lazy dog","n_total":12,"n_kept":8,"kept_pct":66.7}
```

#### Configuration

| Var | Default | Meaning |
|-----|---------|---------|
| `KOMPRESS_URL` | unset | Sidecar base URL, e.g. `http://127.0.0.1:7777`. **Unset = plugin off.** |
| `KOMPRESS_ENDPOINTS` | `/v1/messages,/v1/chat/completions,/v1/responses` | Comma list of proxy paths to compress. |
| `KOMPRESS_FAIL_OPEN` | `true` | `true` = **fail-open** (on sidecar error, forward the original uncompressed text — compression is an optimization, not a correctness boundary). Set `false`/`0` to fail-closed (error the request). |
| `KOMPRESS_TIMEOUT_MS` | `40000` | Per-call timeout to the sidecar. |
| `KOMPRESS_MAX_CHARS` | `1024000` | Skip compression above this total compressible-text size (safety cap). |
| `KOMPRESS_KEEP_RATIO` | `0.5` | Fraction of tokens to keep, passed to the sidecar. Lower = more aggressive compression. |
| `KOMPRESS_MIN_CHARS` | `200` | Per-fragment floor: fragments shorter than this are skipped (compression saves nothing meaningful). |

When both plugins are enabled, **redaction runs first** and compression operates on the
already-redacted text.

#### Limitations

- Compression is **lossy by design** — dropped tokens are gone. Tune `KOMPRESS_KEEP_RATIO`
  to trade savings against fidelity.
- **English-only.** CJK / non-Latin fragments are auto-skipped to avoid garbling.
- JSON schemas (`input_schema` / `function.parameters`) are intentionally left intact;
  only human-language tool `description` fields are compressed.

#### Test results

The plugin logic is covered by a self-contained suite that runs against a **mock
sidecar** (no model download or running server required). Latest run: **29 passed,
0 failed**.

| Group | Checks | What it verifies |
|-------|--------|------------------|
| `isCjkHeavy` guard | 5 | English passes; Chinese/Japanese and CJK-heavy text flagged; isolated accents ignored; empty string safe. |
| `getKompressConfig` | 6 | `null` when `KOMPRESS_URL` unset; `failOpen` defaults true and is overridable; `keepRatio`/`minChars` defaults; rejects non-internal sidecar hosts. |
| `shouldCompressPath` | 2 | `/v1/messages` active, `/v1/embeddings` inactive. |
| `compressBody` (Anthropic) | 11 | Compresses user text + `tool_result` + tool `description`; leaves `system`, assistant, CJK, tiny (`< minChars`), and JSON schemas untouched; sidecar never receives skipped text. |
| Fail modes | 3 | Sidecar down → fail-open (original text preserved); `KOMPRESS_FAIL_OPEN=false` + sidecar 500 → throws. |
| `compressBody` (OpenAI) | 2 | `role:'tool'` content + `function.description` compressed; `parameters` schema left intact. |

`npm run typecheck` is also clean.

### Performance Benchmark

Run `npx tsx tests/test_performance_benchmark.ts` to get current results.

Results on Node.js v24.6.0 (linux x64):

| Module | Time |
|--------|------|
| **Stringify — JSON.stringify** (built-in) | **0.17 µs/op** baseline |
| **Stringify — fast-safe-stringify** | 0.31 µs/op (1.8×) |
| **Stringify — safe-stable-stringify** | 0.57 µs/op (3.4×) |
| **claude→openai** converter | 0.11–0.63 µs/op |
| **openai→claude** converter | 0.67–1.64 µs/op |
| **Token counting** | 0.13–0.21 µs/op |
| **Round-trip** (both converters) | 0.53 µs/op (~1.9M ops/sec) |
| **Dashboard stats** per-request overhead | ~0.69 µs/1M ops |

> Built-in `JSON.stringify` is fastest for normal JSON. Use `fast-safe-stringify` if your payloads may contain circular references. The proxy's own processing overhead is negligible — real latency comes from upstream LLM inference and network I/O.

#### Request Hot-Path Optimizations

- **Single body parse per request** (`src/index.ts`) — tool/agent stats are
  extracted from the same parsed body that the routing block uses for
  model resolution, instead of a separate `request.clone().json()` call
  before routing. Each JSON request now pays for one body parse instead
  of two.
- **Incremental `getTokensInWindow` cache** (`src/utils/dashboard-stats.ts`)
  — the function used to scan the full 30-day heatmap array on every
  call (called once per active composite / global token-limit window per
  request). It now caches the immutable prefix sum
  (`windowSumFrozen` / `windowSumCutoff`) and only walks the live tail
  on each call. Cold start is one O(n) pass; subsequent calls are
  O(events added since the previous cutoff).

### Model Configuration

#### Minimal Configuration (Unconfigured Models)

For models without specific configuration, use this minimal setup:

```toml
# proxy_config.toml
[upstream]
default_base_url = "https://api.qnaigc.com"
default_api_key = "sk-..."
upstream_mode = "openai-completions"

[models.default]
upstream_mode = "openai-completions"
```

All unconfigured models will automatically use these defaults. No need to list every model explicitly.

#### Full Configuration Example

```toml
# proxy_config.toml
[upstream]
upstream_mode = "openai-completions"
default_base_url = "https://api.qnaigc.com"
default_api_key = "sk-your-api-key"

[models.gemini]
upstream_mode = "gemini-generatecontent"
base_url = "https://api.example.com"
api_key = "sk-gemini-key"
"gemini-2.5-flash" = {}

[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.anthropic.com"
api_key = "sk-claude-key"
"claude-4.6-sonnet" = {target = "claude-opus-4-1-20250805-thinking"}

[models.default]
upstream_mode = "openai-completions"
"deepseek/deepseek-v3.2" = {}
```

**Configuration Structure**:
- **Category-based**: Group models by provider (`[models.gemini]`, `[models.claude]`, `[models.default]`)
- **Inline-table format**: `{target = "model-alias", base_url = "url-or-empty", api_key = "key-or-empty"}` — empty strings inherit from the category
- **upstream_mode**: Explicit mode per category (`anthropic-messages`, `gemini-generatecontent`, `gemini-interactions`, `openai-completions`)
- **Model names**: Preserve original names (no normalization) - `"deepseek/deepseek-v3.2"`, `"gemini-2.5-flash"`
- **Inheritance chain**: Model entry → Category defaults → [upstream] defaults

#### Model Routing Priority

Model lookup follows three priority levels (highest first):

| Priority | Lookup | Categories checked |
|:--------:|:-------|:------------------|
| 1 | Exact key match | All `[models.*]` sections |
| 2 | `prefix-*` wildcard | `models.claude` → `models.gemini` |
| 3 | `*` catch-all | `models.default` |

**Wildcard patterns**: Only **`prefix-*`** (with hyphen before `*`) is recognized. `claude-*` matches `claude-sonnet-4-6`; the `*` is substituted so upstream sees the real model name. Bare `*` as key means "catch-all" — routes to that category's config while preserving the original model name.

**Exact entries override wildcards** within the same category. An explicit `claude-sonnet-4-6` in `models.claude` is found by Priority 1 before any wildcard in Priority 2 is checked.

| Section | Exact entries | `prefix-*` wildcards | `*` catch-all |
|:--------|:-------------:|:--------------------:|:-------------:|
| `models.claude` | ✅ | ✅ | ❌ |
| `models.gemini` | ✅ | ✅ | ❌ |
| `models.free` | ✅ | ❌ | ❌ |
| `models.default` | ✅ | ✅ (optional) | ✅ (recommended) |
| `models.embedding` | ✅ | ❌ | ❌ |

**Example routing flow**:
```
"claude-haiku-4-5"  → Priority 1: not found → Priority 2: "claude-*" matches → api.anthropic.com ✅
"claude-sonnet-4-6" → Priority 1: exact in models.free → localhost:3000 ✅ (exact wins)
"unknown-model"     → Priority 1: not found → Priority 2: not found → Priority 3: "*" in default → api.minimaxi.com ✅
```

#### Full Configuration Example with Wildcards

```toml
[upstream]
default_base_url = "https://api.qnaigc.com"
default_api_key = "sk-..."
upstream_mode = "openai-completions"

[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.anthropic.com"
api_key = "sk-claude-key"
# Wildcard: catch-all for any claude-* model not explicitly listed below
"claude-*" = {}
# Explicit overrides take priority over the wildcard above
claude-opus-4-8 = {}
claude-sonnet-4-6 = {}

[models.gemini]
upstream_mode = "gemini-generatecontent"
base_url = "https://api.example.com"
api_key = "sk-gemini-key"
"gemini-*" = {}
gemini-3.0-flash-preview = {target = "gemini-3-flash-preview"}

[models.free]
upstream_mode = "anthropic-messages"
base_url = "http://localhost:3000"
api_key = "invalid-sk-..."
# Short aliases for composite configs (not wildcards)
opus48 = {target = "claude-opus-4-8"}
deepseek-v4 = {target = "deepseek-v4-flash"}

[models.default]
upstream_mode = "openai-completions"
base_url = "https://api.minimaxi.com"
# Catch-all: routes any unmatched model to default config, preserving model name
"*" = {}
max-m3 = {target = "MiniMax-M3"}
deepseek-v4-flash = {base_url = "https://api.deepseek.com", api_key = "sk-..."}
```

**Note**: Each model supports one upstream. Composite aliases can route across multiple configured models, and a composite alias may also define a shared `token_limit` across all of its targets.

**TOML syntax note**: All examples in this README are fully spec-compliant TOML 1.0. The proxy's hand-rolled parser also accepts two legacy forms for backward compatibility with existing configs: bare wildcard keys (`claude-*` instead of `"claude-*"`) and JSON-style `:` separators in composite inline tables (`{"share": 1}` instead of `{share = 1}`). New configs should use the spec forms shown above.

### Configuration Loading

The proxy supports three config sources (precedence: Apollo > Consul > Path):

1. **Local File**: `PROXY_CONFIG_PATH=./proxy_config.toml`
2. **Consul KV**: `PROXY_CONFIG_CONSUL=http://localhost:8500` (reads KV prefix `model-proxy-v3/`)
3. **Apollo**: `PROXY_CONFIG_APOLLO=/path/to/apollo.toml` (namespace holds the full TOML; see [README.md](../README.md#config-source))

Config is loaded on startup and validated against the schema. Errors are printed to console (`[ERROR]`) and surfaced in the TUI status bar and dashboard status indicator.

#### Config Schema Validation

##### Custom Model Entries (`[models.<category>.<model-id>]`)

Two forms are accepted:

| Form | Example | base_url source | api_key source |
|:-----|:--------|:----------------|:---------------|
| alias self-route | `gpt-5.4-mini = {}` | category `base_url` | category `api_key` |
| renamed target | `opus48 = {target = "claude-opus-4-8"}` | category `base_url` | category `api_key` |
| with overrides | `max-m3 = {target = "MiniMax-M3", base_url = "https://...", api_key = "sk-..."}` | per-model `base_url` | per-model `api_key` |

`{}` means "use the alias name as the upstream target and inherit everything from the category." Omit only the fields that should fall back to the category defaults. The old array forms `["gpt-5.4-mini"]` and `["gpt-5.4-mini", "https://...", "sk-..."]` are still accepted for backward compatibility.

**Validation rules:**
- `target` cannot be empty — `*` is allowed for the catch-all pattern
- Target-only form: **both** `base_url` **and** `api_key` must be set in the category (otherwise error)
- Full form: empty `base_url`/`api_key` falls back to category values

##### Composite Alias Entries (`[composite.<alias>.<target-model>]`)

Each target model config must be an object with optional numeric/boolean fields:

| Field | Type | Description |
|:------|:-----|:------------|
| `share` | `number` ≥ 0 | Weight for random selection |
| `primary` | `boolean` | Always try first |
| `fallback` | `number` ≥ 0 | Retry priority (lower = higher priority) |
| `token_limit` | `object` | Time-bounded token cap: `{"num": <number>, "duration": "1h"\|"1d"\|"1w"\|"1m"}` |

**Validation rules:**
- `share` must be a finite number (e.g., `10`, `0`) — strings or non-numbers error
- `primary` must be `true` or `false` — other values error
- `fallback` must be a finite number (e.g., `1`, `0`) — strings or non-numbers error
- `token_limit` must be an object with `num` (finite number ≥ 0) and `duration` (`"1h"`, `"1d"`, `"1w"`, or `"1m"`) — missing fields or invalid duration error. In TUI/dashboard, input format is `<num>[K|M|B|T]> <1h|1d|1w|1m>` — e.g. `50K 1d`, `1.5M 1h`, `100000 1w`
- Empty target `{}` is valid (all fields optional)
- Non-object values error: `invalid target config`

##### Error Display

Errors appear in three places:

1. **Console** — on startup (non-TUI mode) and on config reload:
   ```
   [ERROR] models.free.code-small-pi: must be [target] or [target, base_url, api_key] (got 4 elements)
   [ERROR] composite.bad-alias.model1: share must be a number
   ```

2. **TUI status bar** — shows the first error with path and message in yellow

3. **Dashboard `#configStatus`** — shows all errors in red with path and message

### Authentication

Forward authentication headers from the original request:
- `Authorization: Bearer <token>`
- `x-api-key: <key>`
- `x-goog-api-key: <key>` (for Gemini endpoints)

#### API Key Priority (Enhanced 2026-03-03)

The proxy now intelligently prioritizes API keys based on upstream mode:

1. **For `openai-completions` upstream mode**:
   - Configuration API keys take priority over client-provided headers
   - This ensures compatibility with OpenAI-compatible APIs when clients send Gemini/Claude API keys
   - Uses `Authorization: Bearer <api-key>` header format

2. **For other upstream modes** (`anthropic-messages`, `gemini-generatecontent`, `gemini-interactions`):
   - Configuration API keys override request headers when available
   - Falls back to client-provided headers when no config API key is set

#### Gemini API Authentication
For Gemini API endpoints, authentication headers are automatically mapped:
- **OpenAI-Compatible Mode**: Uses `Authorization: Bearer <api-key>` header
- **Native Interactions Mode**: Uses `x-goog-api-key: <api-key>` header
- **Native GenerateContent Mode**: Uses `x-goog-api-key: <api-key>` header
- API keys can be provided via:
  - Request headers: `Authorization: Bearer <key>`, `x-api-key: <key>`, or `x-goog-api-key: <key>`
  - Configuration file: `api_key` in model or category config

#### Client IP Forwarding
The proxy forwards the client's real IP to upstream APIs via the `x-forwarded-for` header. Supports:
- **Cloudflare Workers**: Uses `cf-connecting-ip` header
- **Standard Proxies**: Uses `x-forwarded-for` header (takes first IP if multiple)
- **Nginx**: Uses `x-real-ip` header

## 🏗️ Architecture

### Project Structure

```
src/
├── converters/
│   ├── claude-to-gemini.ts         # Claude to Gemini conversion
│   ├── claude-to-openai.ts         # Request conversion
│   ├── completions-to-responses.ts # Chat Completions to Responses API
│   ├── gemini-streaming.ts         # Gemini streaming transformer
│   ├── gemini-to-claude.ts         # Gemini to Claude conversion
│   ├── openai-to-claude.ts         # Response conversion
│   ├── openai-to-gemini.ts         # OpenAI response to Gemini generateContent format
│   ├── responses-to-completions.ts # Responses API to Chat Completions
│   └── streaming.ts                # Streaming response conversion
├── handlers/
│   ├── chat-completions.ts         # OpenAI /v1/chat/completions passthrough handler
│   ├── claude.ts                   # Claude native API handler (anthropic-messages passthrough)
│   ├── dashboard.ts                # Dashboard API handler (config editing and stats)
│   ├── embeddings.ts               # Embeddings API handler
│   ├── gemini.ts                   # Gemini API handler (dual-mode)
│   ├── messages.ts                 # Messages API handler (openai-completions conversion)
│   ├── models.ts                   # Models API handler
│   ├── openai.ts                   # OpenAI completions handler
│   ├── responses.ts                # Responses API handler
│   └── token-counting.ts           # Token counting handler
├── heatmap.ts                      # Heatmap rendering for the TUI
├── index.ts                        # Main router and middleware
├── server.ts                       # Node.js HTTP server adapter
├── tui.ts                          # Terminal dashboard UI
├── types/
│   ├── claude.ts                   # Claude API types
│   ├── gemini.ts                   # Gemini API types
│   ├── openai.ts                   # OpenAI API types
│   └── shared.ts                   # Shared types
└── utils/
    ├── beta-features.ts            # Beta feature validation
    ├── config-loader.ts            # Proxy config TOML loader
    ├── conversation-store.ts       # In-memory store for Responses API stateful mode
    ├── dashboard-stats.ts          # Token/usage stats aggregation for the dashboard
    ├── errors.ts                   # Error handling
    ├── fetch-timeout.ts            # Upstream request timeout
    ├── kompress.ts                 # Context compression plugin (proxy to sidecar)
    ├── logger.ts                   # Logging utilities
    ├── privacy-filter.ts           # PII redaction plugin (proxy to sidecar)
    ├── routing.ts                  # Auth header handling and URL building
    ├── sdk-handler.ts              # SDK-based request handling
    ├── stringify.ts                # Configurable JSON stringifier (safe-stable / fast-safe / native)
    ├── thinking.ts                 # Thinking utilities
    ├── token-counting.ts           # Token counting utilities
    └── validation.ts               # Request validation
```

### Key Components

1. **Router Middleware**: Parses URLs, handles authentication, routes to handlers
2. **Converters**: Convert between Claude, OpenAI, and Gemini API formats
3. **Validation**: Comprehensive request validation with Claude API error formats
4. **Error Handling**: Claude API-compatible error responses
5. **Gemini Dual-Mode Handler**: Supports both native Interactions API and OpenAI-compatible endpoints with automatic format detection

## 🧪 Testing

### Type Checking

```bash
npm run typecheck
```

### Integration Test Suite (testcases/)

The full integration suite lives under `testcases/` and is driven by
`run-tests-loop-wrapper.js`. It starts a local proxy (port 7799 by
default), copies `proxy_config.toml` → `test_proxy_config.toml` so the
run never mutates the live config, executes 18 suites across
`01_endpoints` / `02_features` / `03_errors` / `04_models` /
`05_upstream_modes` / `06_integration` / `07_dashboard` /
`08_regression` / `09_composite` / `10_auth` / `11_responses` /
`12_config_validation` / `13_fusion`, and writes a timestamped markdown
report to `tests/test_results_at_<date>_<time>.md`.

```bash
PORT=7799 TEST_CONFIG=test_ \
  PROXY_URL=http://localhost:7799 \
  API_KEY=<your-upstream-key> \
  node run-tests-loop-wrapper.js
```

**Latest run (2026-06-22 20:14 UTC):** 18/18 suites pass,
165/165 cases pass — see
`tests/test_results_at_2026-06-22_20-14-47.md`.

### Example Requests

```bash
# List models
curl http://localhost:8788/v1/models \
  -H "Authorization: Bearer your-api-key"

# Send message
curl http://localhost:8788/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "deepseek-v3.1",
    "messages": [{"role": "user", "content": "Hello"}],
    "max_tokens": 100
  }'

# Test with different models
curl http://localhost:8788/v1/messages \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "qwen-max-2025-01-25",
    "messages": [{"role": "user", "content": "Capital of France?"}],
    "max_tokens": 50
  }'
```

### Test Results

**Latest Revision (2026-03-03):** ✅ Enhanced Thinking Config & API Key Priority

**Key Enhancements:**

1. **Boolean Thinking Config Support**: Thinking configuration now accepts boolean values (`true`/`false`) in addition to string values (`"enabled"`/`"disabled"`), providing more intuitive API usage.

2. **Gemini `/v1/models/` Endpoint Support**: Added support for Gemini `/v1/models/{model}:generateContent` endpoints (in addition to existing `/v1beta/models/` support).

3. **API Key Priority for OpenAI-Compatible Upstream**: For `openai-completions` upstream mode, the proxy now prioritizes API keys from configuration over client-provided headers, ensuring compatibility with OpenAI-compatible APIs.

4. **Enhanced Auth Header Handling**: Added `formatApiKeyForUpstream()` utility for consistent API key formatting across different upstream modes.

**Thinking Config Examples:**
```json
// String format (existing)
"thinking": {
  "type": "enabled",
  "budget_tokens": 10000
}

// Boolean format (new)
"thinking": {
  "type": true,
  "budget_tokens": 10000
}
```
See [CHANGELOG.md](./CHANGELOG.md) for historical changes.

**Comprehensive Testing (2026-02-25):** ✅ Production Ready

#### Endpoints Validated: All 3 endpoints (100% coverage)

**1. `/v1/messages` - Claude API format**
- ✅ 50+ models tested
- ✅ Native mode: Gemini, Claude (pass-through)
- ✅ OpenAI mode: All models (format conversion)
- ✅ Streaming: SSE support validated

**2. `/v1/interactions` - Interactions API format**
- ✅ 50+ models tested
- ✅ Native mode: Gemini (with limitations)
- ✅ OpenAI mode: All models (format conversion)
- ✅ Streaming: SSE support validated

**3. `/v1beta/models/{model}:generateContent` - Gemini format**
- ✅ 50+ models tested
- ✅ Native mode: Gemini (direct)
- ✅ OpenAI mode: All models (format conversion)
- ✅ Streaming: SSE support validated

#### SSE Streaming Support: ✅ Fully Implemented

**All 5 upstream handlers support SSE streaming:**
- ✅ handleClaudeRequest (Native Claude)
- ✅ handleMessagesRequest (OpenAI-compatible)
- ✅ handleOpenAIRequest (Interactions/OpenAI)
- ✅ handleGeminiGenerateContentRequest (Native Gemini)
- ✅ handleGeminiInteractionsRequest (Native Gemini)

**Streaming Test Results:**
- ✅ /v1/messages: SSE works (100% - all modes)
- ✅ /v1/interactions: SSE works (100% - OpenAI mode)
- ✅ /v1beta/models/*:generateContent: SSE works (100% - all modes)
- ✅ /v1beta/models/*:streamGenerateContent: SSE works (100% - all modes)

**SSE Implementation Details:**
- **Multi-token chunking**: Efficient batched streaming (recommended)
- **Complete message boundaries**: Proper `data: {...}\n\n` formatting
- **Buffer handling**: Ensures no partial SSE messages sent to clients
- **No `[DONE]` marker**: Streams end naturally via connection close (standard behavior)

**Note:** OpenAI-compatible mode provides consistent 100% SSE streaming across all endpoints.

#### Mode Comparison

**Native Mode:**
- ✅ Gemini: 100% success (6/6 tests)
  - All non-streaming: 100%
  - All streaming: 100%
  - All endpoints work perfectly
- ✅ Claude: 33% success (1/3 endpoints - /v1/messages only)
- ✅ Direct API access, preserves native features

**OpenAI-Compatible Mode:**
- ✅ All models: 100% success (6/6 tests)
- ✅ Full SSE streaming support (all endpoints)
- ✅ Consistent behavior across providers
- ✅ Recommended for production

#### Features Validated

1. ✅ **Category-based config** - Models grouped by provider with inheritance
2. ✅ **Model-specific routing** - Per-model upstreams with array format
3. ✅ **model_alias feature** - Maps client names to upstream names
4. ✅ **upstream_mode detection** - Explicit mode per category
5. ✅ **API key parsing** - Handles "x-api-key: sk-..." format
6. ✅ **Format conversions** - Claude↔OpenAI↔Gemini
7. ✅ **SSE streaming** - All endpoints, all modes (100%)
8. ✅ **Thinking models** - Natural reasoning support
9. ✅ **Vision models** - Image input support
10. ✅ **Multiple providers** - 30+ models from 6+ providers
11. ✅ **Gemini 3.x preview** - Latest experimental models
12. ✅ **Config inheritance** - Model → Category → Upstream defaults
13. ✅ **Unconfigured models** - Automatic fallback to defaults

#### Provider Success Rates

| Provider | Success Rate | Models Tested |
|----------|--------------|---------------|
| DeepSeek | 100% | 5 models |
| Moonshot/Kimi | 100% | 2 models |
| Qwen | 93.3% | 15 models |
| MiniMax | 100% | 3 models |
| GLM/Z-AI | 66.7% | 3 models |
| Gemini | 100% | 4 models (2.0/2.5/3.0/3.1) |

## 📄 License

MIT

## Multi-Agent SDK Test (`tests/multi-agents-test.ts`)

`tests/multi-agents-test.ts` exercises three official AI agent SDKs simultaneously against the
local proxy on port 7777, using the same natural-language task prompt. It verifies that the proxy's
three major API surfaces — Responses API, Claude messages API, and Gemini generateContent — all
work end-to-end through a single server. Envs bellow are **important**, refer to `tests/README.md` for more.

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | For Claude | API key for the proxy. Used by Claude Agent. |
| `CODEX_API_KEY` | For Codex | API key for Codex Agent (uncomment `runCodexAgent` to enable). |
| `GEMINI_API_KEY` | For Gemini | API key for Gemini Agent (uncomment `runGeminiAgent` to enable). |
| `API_KEY` | For all them | API key for all Agents. |

### How to run

```bash
# Install SDKs (one-time)
npm install @openai/codex-sdk @anthropic-ai/claude-agent-sdk @google/genai

# Ensure the proxy is running on port 7777
PORT=7777 node dist/server.js &

# Run the test
npx tsx tests/multi-agents-test.ts
```

### Agents tested

| Agent | SDK | Proxy surface | Model |
|-------|-----|---------------|-------|
| OpenAI Codex | `@openai/codex-sdk` 0.142.2 | `/v1/responses` (Responses API) | `deepseek-v4-pro` via `localproxy` in `~/.codex/config.toml` |
| Anthropic Claude | `@anthropic-ai/claude-agent-sdk` | `/v1/messages` (Claude messages) | `deepseek-v4-pro` |
| Google Gemini | `@google/genai` 2.10.0 | `/v1beta/models/:model:generateContent` (Gemini native) | `gemini-2.5-flash` |

### Implementation notes

- **Codex**: The SDK's `openai_base_url` config key is silently ignored by codex-cli 0.107.0, so
  routing is handled via `~/.codex/config.toml` written at runtime. `modelReasoningEffort:
  "minimal"` is used to keep thinking-mode overhead low.
- **Claude agent**: The `query()` stream is iterated for `assistant` and `result` events.
  `allowedTools: ["Glob", "Read"]` restricts the agent to read-only workspace operations.
- **Gemini**: `httpOptions.baseUrl` overrides the default Google endpoint so all traffic flows
  through the local proxy. The SDK imports are dynamic (`await import(...)`) so missing SDKs only
  fail the individual function, not the whole file.

### Results (2026-06-25, proxy port 7777, upstream `anthropic.qnaigc.com`)

| Agent | Outcome | Notes |
|-------|---------|-------|
| **Codex** | `Codex Final Output: ` (empty string) | Success — empty output is expected because the `bwrap` Linux namespace sandbox blocks exec commands; the agent loop completes without error |
| **Claude** | `Claude Done. Status: success` | Full analysis returned: correctly read the real `./tests/` directory (128 files, flat layout) and produced a detailed reorganization proposal |
| **Gemini** | Output returned | Response delivered successfully; the model produced a generic Python test-layout analysis rather than inspecting the actual directory (no tool use) |

All three SDKs connected to the proxy, authenticated, and received valid responses. No proxy-side
errors.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## Models and Tools
### Models Involved
1. `DeepSeek-R1`, `V3.2`, `V4-Flash`, `V4-Pro`
2. `Minimax-M2.6`, `M2.7-highspeed`, `M3`
4. `Kimi-K2.6`, `K2.7-Code`
5. `GPT-5.4-Mini`, `GPT-5.4`, `GPT-5.5`
6. `Gemini-2.5-Flash`, `3.0-Preview`, `3.1-Flash`
7. `Claude-Sonnet-4.5`, `Sonnet-4.6`, `Opus 4.6`, `Opus 4.8`, `Fable 5`
8. `Nemotron-3-Super-120b`, `gpt-oss-120b`
9. `GLM-5.2`

### Tools Involved
1. `Claude Code`
2. `Kiro`
3. `Gemini-Cli`
4. `Pi`
5. `Codex`

## 🔗 Links

- [Claude API Documentation](https://docs.anthropic.com/claude/reference/)
- [OpenAI API Completions](https://platform.openai.com/docs/api-reference)
- [OpenAI API Responses](https://developers.openai.com/api/reference/resources/responses/index.md)
- [Google Gemini API Documentation](https://ai.google.dev/gemini-api/docs)
