# Configuration Guide

Minimal `proxy_config.toml` walkthrough and thinking/reasoning behavioral notes.
Split out of the [README Quick Start](../README.md#2-configure). For the field-by-field
reference see [configuration-reference.md](./configuration-reference.md), and for the
full routing rules see [routing-and-aliases.md](./routing-and-aliases.md).

## Minimal config

Copy the example config and edit it:

```bash
cp proxy_config.example.toml proxy_config.toml
```

> **Note — inline `#` comments are supported.** `proxy_config.toml` is parsed
> by a hand-rolled TOML reader (`src/utils/config-loader.ts → parseSimpleToml`)
> that strips trailing comments before matching values. Comments must be preceded
> by at least one space (standard TOML convention), e.g.
> `filter_mode = "local"  # sidecar | local`. A bare `#` with no leading space
> inside a quoted value (e.g. `api_key = "abc#def"`) is preserved correctly.
> Standalone `#`-only lines are always fine.

A minimal `proxy_config.toml` looks like this (shipped as
[`proxy_config.minimal.toml`](../proxy_config.minimal.toml)):

```toml
# Remote sidecars — one flat [remote] table (keys prefixed by role).
# [remote]
# --- auth role: validates proxy endpoint auth headers before routing ---
# auth_server = "https://auth.example.com/validate"
# auth_with_model = false          # when true, defers auth until after body parsing
                                   # and forwards requested model id as x-resource-for
# auth_with_body = false           # when true, POSTs the parsed request body to auth_server
# auth_passthrough_with = "user_key"   # controls which key is passed upstream:
                                       # "user_key" (default) or "config_key"
# max_targets = 16                 # cap on the auth targets[] failover ladder attempts
# max_target_retries = 1           # per-descriptor retry_on re-hits (0 disables);
                                   # a rung's own `retry` field overrides this for that rung
# --- recording role: POSTs per-request usage records to an HTTP collector ---
# Includes request_id, endpoint, raw user_key, model, response_status, and token counters.
# record_server = "http://127.0.0.1:8080/model-usage"
# record_response_body = false     # when true, each record also includes the constructed response body

# Global upstream defaults — applied ONLY to models that are NOT claimed by
# any `[models.*]` category section below. A model name that falls through
# every section's exact / wildcard / catch-all lookup gets routed here.
[default_upstream]
default_base_url = "https://api.your-provider.com"
# default_api_key = "your-key"   # used in config_key mode or as fallback for [models.FREE]

# Claude models, spoken to in native Anthropic format
[models.claude]
upstream_mode = "anthropic-messages"
base_url = "https://api.anthropic.com"
api_key = "your-claude-key"
"claude-sonnet-4-6" = {}                    # exact entry; inline table {target, base_url, api_key, mode} — empty fields inherit from section
"claude-*" = {}                             # prefix wildcard — catch-all for every other claude-* model

# Gemini models, spoken to in native Gemini format
[models.gemini]
upstream_mode = "gemini-generatecontent"
base_url = "https://generativelanguage.googleapis.com"
api_key = "your-gemini-key"
"gemini-*" = {}

# Everything else goes here (OpenAI-compatible). Empty entry fields inherit
# from the section, then from `[default_upstream]` defaults.
[models.default]
upstream_mode = "openai-completions"
base_url = "https://api.your-provider.com"   # section base_url overrides [default_upstream].default_base_url
"*" = {}                                     # final catch-all for this section
"deepseek/deepseek-v3.2" = {}

# /v1/embeddings — OpenAI-compatible. The proxy appends `v1/embeddings` to
# `base_url`, so set the **API root** (e.g. `https://integrate.api.nvidia.com`,
# NOT `…/v1`). When `api_key` is set, it always overrides any caller-supplied
# header on `/v1/embeddings` — see the "Who wins" tables in
# docs/routing-and-aliases.md. Model entries are exact-match only; bare model names without
# the upstream's required prefix (e.g. `nvidia/`) will fail at the upstream.
[models.EMBEDDING]
upstream_mode = "openai-completions"   # value is informational — the proxy hardcodes this for /v1/embeddings
base_url = "https://integrate.api.nvidia.com"
api_key = "nvapi-..."
"nvidia/nemotron-3-embed-1b" = {}
```

Key ideas:

- **Categories** group models by provider: `[models.claude]`, `[models.gemini]`,
  `[models.default]`, etc.
- **`upstream_mode`** picks the protocol: `anthropic-messages`, `gemini-generatecontent`,
  `gemini-interactions`, `openai-completions`, or `openai-responses`.
- **`sdk://` target URLs** route supported Claude/OpenAI upstream calls through the
  local SDK handler instead of plain HTTP fetch, while still using the configured
  `upstream_mode` for request/response shape.
- **Per-model overrides** use an inline table: `"my-model" = {target = "real-name", base_url = "...", api_key = "..."}`.
  Empty fields inherit from the category. Both the canonical keys (`upstream_mode`, `base_url`,
  `api_key`) and the short aliases (`mode`, `url`, `key`) are accepted; when both are present
  the canonical form wins.

## Notes on thinking / reasoning

> **Note — `anthropic-messages` and extended thinking:**
> When `upstream_mode = "anthropic-messages"` is used with a third-party Anthropic-compatible
> endpoint (e.g. MiniMax at `api.minimaxi.com/anthropic`), the proxy passes the client's
> `thinking` field through as-is. If the client sends `{"type": "adaptive"}` the upstream
> model will respond with thinking blocks; if the client omits `thinking` entirely, the proxy
> injects `{"type": "disabled"}` as a safe default (needed for DeepSeek-compatible endpoints
> that otherwise default to thinking mode). DeepSeek's Anthropic-compatible endpoint also
> **rejects a client-sent `{"type": "enabled"}` on a fresh conversation** (no prior assistant
> turns containing thinking blocks) — attach the `strip_fresh_thinking` builtin (part of the
> `deepseek_v4_anthropic_compat` set) to such targets to drop the flag in that case, or use
> `"adaptive"` client-side, which the model handles autonomously.

> **Note — synthetic thinking-block signatures (Claude→OpenAI→Claude only):**
> Anthropic's spec marks `signature` as REQUIRED on thinking content blocks, and clients such
> as `@ai-sdk/anthropic` reject responses missing it. Upstreams reached via the conversion
> paths (`openai-completions` / `openai-responses`, and the `sdk://` handler) emit reasoning
> without a signature, so the proxy synthesizes a constant placeholder
> (`SYNTHETIC_THINKING_SIGNATURE` = 'synthetic'). This **only** applies to the Claude→OpenAI→Claude
> round-trip: the reverse converter round-trips reasoning via `reasoning_content` and drops the
> signature before the upstream call, so the placeholder is never verified. For
> `upstream_mode = "anthropic-messages"` the proxy does **not** synthesize anything — it is a
> pure pass-through in both directions, so the upstream's own signature is preserved:
>   - Client enables thinking + provides prior thinking blocks → forwarded as-is; signature passes through. ✓
>   - Client enables thinking + provides prior thinking blocks but the signature is missing/garbage → forwarded as-is; a real Anthropic/Bedrock upstream rejects with HTTP 400.

> **Note — `thinking.budget_tokens` vs `max_tokens`:** on `POST /v1/messages` and
> `POST /v1/messages/count_tokens`, when `thinking` is enabled the validator reduces
> `thinking.budget_tokens` down to `max_tokens` if the budget would otherwise exceed it.
> If you send `anthropic-beta: interleaved-thinking-2025-05-14`, the budget is left
> unchanged (interleaved thinking may consume the full context window). If `max_tokens`
> is below `1024` with thinking enabled and a non-null budget, validation throws with
> a message explaining the minimum.

> **Note — `kimi-k2.7-code` and `thinking_budget` collision:** Moonshot's
> `kimi-k2.7-code` maps `reasoning_effort: "medium"` to a fixed
> `thinking_budget = 32768`, so any request with `max_tokens ≤ 32768` fails with
> `InvalidParameter: max_completion_tokens [N] must be greater than thinking_budget [32768]`.
> Under `[general]`, set `budget_to_effort_high = 0` — the proxy then emits
> `reasoning_effort: "high"` for any thinking budget. if set
> `budget_to_effort_low = 32768`
> `budget_to_effort_medium = 65536`
> `budget_to_effort_high = 128000`
> map `reasoning_effort: "low"` would avoid the limit of `kimi-k2.7-code`.
- **Tag-based reasoning extraction (`openai-completions` only):** when an upstream replies
  with reasoning wrapped in `<think>...</think>` or `<thinking>...</thinking>` tags, the proxy splits
  the content into the endpoint's native reasoning field. `/v1/messages` returns it as a
  Claude `thinking` block; `/v1/responses` returns it as a `reasoning` output item plus an
  embedded `reasoning_text` part for round-trip; `/v1/interactions` returns it as a
  `thought` output item; `/v1beta/models/<model>:generateContent` returns it as a Gemini
  `thought` part. The tag itself is stripped from the user-visible text. This applies to
  both streaming and non-streaming responses; the streaming path stitches tags that cross
  SSE chunk boundaries before extraction.
- **`reasoning_content` field round-trip (`openai-completions`, Gemini endpoints):** reasoning
  models such as DeepSeek emit thinking as a dedicated `reasoning_content` field on the delta
  rather than inline tags. The proxy extracts it the same way as tag-based reasoning (emitted as
  a Gemini `thought` part, Claude `thinking` block, etc.) and ensures it is replayed on the
  assistant turn in subsequent requests — required by DeepSeek-compatible upstreams that reject
  conversations where a prior thinking turn omits `reasoning_content`. Tool-call streaming is
  also handled: DeepSeek fragments a single tool call across multiple SSE chunks (first chunk
  carries `id`+`name`+partial args, continuation chunks carry only more arg text). The proxy
  accumulates these fragments and flushes one complete `functionCall` part per tool call when
  `finish_reason` arrives, avoiding name-less `call_undefined` entries in the client's history.
- **Wildcards** (`claude-*`) apply only in the provider/default sections listed in
  [Model Routing & Aliases](./routing-and-aliases.md); the **catch-all** (`*`) is only the final
  `[models.default]` fallback for anything not claimed earlier.

See [`proxy_config.example.toml`](../proxy_config.example.toml) for a fully commented config
covering every section and option.
