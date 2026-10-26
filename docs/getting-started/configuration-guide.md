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
[`proxy_config.minimal.toml`](./proxy_config.minimal.toml)):

```toml
# Remote sidecars — one flat [remote] table (keys prefixed by role).
# [remote]
# --- auth role: validates proxy endpoint auth headers before routing ---
# auth_server = "https://auth.example.com/validate"
                                   # a 200 body MUST carry `version` (missing -> 401);
                                   # it MAY also carry a `targets[]` failover ladder
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

# Everything else goes here (OpenAI-compatible). This section is also the global
# default: empty entry fields inherit from their section, then from
# `[models.default]`, and a model claimed by no other section is routed here.
# There is no separate `[default_upstream]` section — it was removed, and a config
# still carrying one is warned about at load time with its keys ignored.
[models.default]
upstream_mode = "openai-completions"
base_url = "https://api.your-provider.com"   # inherited by other sections' entries that set no base_url of their own
"*" = {}                                     # final catch-all for this section
"deepseek/deepseek-v3.2" = {}

# /v1/embeddings — OpenAI-compatible by default. The proxy appends `v1/embeddings`
# to `base_url`, so set the **API root** (e.g. `https://integrate.api.nvidia.com`,
# NOT `…/v1`). `base_url` is **required** here and is not inherited from
# `[models.default].base_url`: this route never resolves a model entry, so only the
# section-level `base_url` is used and a missing one returns `500` without calling an
# upstream. When `api_key` is set, it always overrides any caller-supplied
# header on `/v1/embeddings` — see the "Who wins" tables in
# ../reference/routing-and-aliases.md. Model entries are exact-match only; bare model names without
# the upstream's required prefix (e.g. `nvidia/`) will fail at the upstream.
[models.EMBEDDING]
upstream_mode = "openai-completions"   # "ollama-embed" switches the upstream to Ollama's native /api/embed
base_url = "https://integrate.api.nvidia.com"
api_key = "nvapi-..."
"nvidia/nemotron-3-embed-1b" = {}
```

Unlike every other category, `[models.EMBEDDING].upstream_mode` selects the
upstream's **wire shape**, not an inference request converter — the route is fixed,
so there is no target list to pick a mode per target. Two values are accepted:

| Value | Upstream call | Notes |
| --- | --- | --- |
| `openai-completions` (default) | `POST {base_url}/v1/embeddings` | Body and response are forwarded as-is. |
| `ollama-embed` | `POST {base_url}/api/embed` | Both directions are converted by the proxy. |

With `ollama-embed`:

```toml
[models.EMBEDDING]
upstream_mode = "ollama-embed"
base_url = "http://localhost:11434"   # Ollama root — the proxy appends `api/embed`
"nomic-embed-text" = {}
```

- Set `base_url` to the Ollama **root**. A `base_url` already ending in `/v1` would
  produce `/v1/api/embed`.
- The request is reduced to what `/api/embed` accepts: `model`, `input`, and, when
  present, `dimensions`, `truncate`, `keep_alive`, and `options`. `user` and
  `encoding_format` are dropped.
- `encoding_format: "base64"` is rejected with `400` — `/api/embed` returns float
  arrays only, and returning floats to a caller that asked for base64 would be a
  silent correctness bug.
- `usage.prompt_tokens` / `total_tokens` come from Ollama's `prompt_eval_count`, as
  they do on Ollama's own `/v1/embeddings`.
- Anything else — including a typo such as `ollama-embedd` — logs a config warning
  and falls back to `openai-completions`.

Key ideas:

- **Categories** group models by provider: `[models.claude]`, `[models.gemini]`,
  `[models.default]`, etc.
- **`upstream_mode`** picks the protocol: `anthropic-messages`, `gemini-generatecontent`,
  `gemini-interactions`, `openai-completions`, or `openai-responses`. In
  `[models.EMBEDDING]` it instead picks the upstream wire shape — see the table above.
- **Per-model overrides** use an inline table: `"my-model" = {target = "real-name", base_url = "...", api_key = "..."}`.
  Empty fields inherit from the category. Both the canonical keys (`upstream_mode`, `base_url`,
  `api_key`) and the short aliases (`mode`, `base`, `key`) are accepted; when both are present
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
> paths (`openai-completions` / `openai-responses`) emit reasoning
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

See [`proxy_config.example.toml`](./proxy_config.example.toml) for a fully commented config
covering every section and option.
