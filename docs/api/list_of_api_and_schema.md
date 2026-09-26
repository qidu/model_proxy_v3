---
generated_by: pi-agent-core inside proxy v3 for testing
audience: public reviewer
status: agent-test material
---

<!--
  NOTE — provenance & audience
  ----------------------------
  This document is generated material produced during internal **pi-agent testing**
  of the model proxy. It is NOT a hand-curated public-facing reference.

  Audience: internal engineers and the pi-agent test harness only.
  Do not publish or link to this file from public docs (README, GitHub Pages,
  release notes) without review.

  It complements (but does not replace) the hand-maintained reference docs:
    - api-endpoints.md             (narrative endpoint details)
    - configuration-reference.md   (full proxy_config.toml schema)
    - transforms-reference.md      (rewrite DSL)
    - routing-and-aliases.md       (composite / fallback / fusion / schedule)
    - interactions.md              (Gemini Interactions wire shape)

  Regenerate / re-verify after any of:
    - src/server.ts route mounting changes
    - src/types/*.ts schema additions or renames
    - src/converters/*.ts direction table changes
    - src/handlers/*.ts handler reshuffles
    - proxy_config.toml top-level section additions
-->

# API Endpoints & Schemas — Complete Listing

> **Internal pi-agent test material.** Generated for pi-agent testing of the
> model proxy. Hand-curated public references live in `api-endpoints.md`,
> `configuration-reference.md`, `transforms-reference.md`, `routing-and-aliases.md`,
> and `interactions.md` — link to those instead in user-facing docs.

A consolidated reference of every API endpoint exposed by the model proxy and every
TypeScript schema (request/response shapes, content blocks, tool types) the proxy
recognizes internally. This complements the more narrative [`api-endpoints.md`](./api-endpoints.md)
and the type definitions under `src/types/`.

---

## 1. Public HTTP Endpoints

All endpoints are mounted by `src/server.ts`. Auth is normally forwarded from the
caller (no local credential check) unless `dashboard.api_key` is configured for
dashboard routes.

### 1.1 LLM API endpoints

| Endpoint | Handler | Purpose | Auth |
|---|---|---|---|
| `POST /v1/messages` | `src/handlers/messages.ts` | Claude Messages API (streaming + non-streaming) | Forwarded (`Authorization`, `x-api-key`, `x-goog-api-key`) |
| `POST /v1/messages/count_tokens` | `src/handlers/token-counting.ts` | Count tokens for a Claude Messages request | Forwarded |
| `POST /v1/responses` | `src/handlers/responses.ts` | OpenAI Responses API | Forwarded |
| `POST /v1/responses/input_tokens` | `src/handlers/token-counting.ts` | Count input tokens for a Responses request | Forwarded |
| `POST /v1/responses/compact` | `src/handlers/responses.ts` | Compact a Responses conversation | Forwarded |
| `POST /v1/chat/completions` | `src/handlers/chat-completions.ts` | OpenAI Chat Completions (also `/v1/completions`) | Forwarded |
| `POST /v1/completions` | alias | OpenAI legacy completions (alias of `/v1/chat/completions`) | Forwarded |
| `POST /v1beta/models/{model}:generateContent` | `src/handlers/gemini.ts` | Gemini generateContent (non-stream) | Forwarded |
| `POST /v1beta/models/{model}:streamGenerateContent` | `src/handlers/gemini.ts` | Gemini streamGenerateContent (`alt=sse`) | Forwarded |
| `POST /v1beta/models/{model}:countTokens` | `src/handlers/gemini.ts` | Gemini countTokens | Forwarded |
| `POST /v1/models/{model}:generateContent` | `src/handlers/gemini.ts` | Same as above, `v1` API path | Forwarded |
| `POST /v1/models/{model}:streamGenerateContent` | `src/handlers/gemini.ts` | Same as above, `v1` API path | Forwarded |
| `POST /v1/models/{model}:countTokens` | `src/handlers/gemini.ts` | Same as above, `v1` API path | Forwarded |
| `POST /v1/interactions` | `src/handlers/messages.ts` | Gemini Interactions API | Forwarded |
| `POST /v1/embeddings` | `src/handlers/embeddings.ts` | OpenAI-compatible embeddings | Forwarded |

### 1.2 Model listing & meta

| Endpoint | Handler | Purpose | Auth |
|---|---|---|---|
| `GET /v1/models` | `src/handlers/models.ts` | List available models | None |
| `GET /v1/models/{model}` | `src/handlers/models.ts` | Single model lookup | None |
| `GET /v1/messages/models` | `src/handlers/models.ts` | Claude-style alias of `/v1/models` | None |

### 1.3 Operational endpoints

| Endpoint | Handler | Purpose | Auth |
|---|---|---|---|
| `GET /health` (also `GET /`) | `src/server.ts` | Health check; probes default upstream `/v1/models` | None |
| `GET /favicon.ico` | `src/server.ts` | Returns `204 No Content` | None |
| `GET /config-reload` | `src/server.ts` | Reload config from `PROXY_CONFIG_CONSUL` / `PROXY_CONFIG_APOLLO` | Loopback |

### 1.4 Dashboard endpoints

| Endpoint | Handler | Purpose | Auth |
|---|---|---|---|
| `GET /dashboard` | `src/handlers/dashboard.ts` | Web dashboard HTML | Loopback (+ optional `dashboard.api_key` bearer) |
| `GET /dashboard/api/config` | `src/handlers/dashboard.ts` | Read config snapshot; `?reload=1` re-reads TOML | Loopback + optional bearer |
| `PUT /dashboard/api/config` | `src/handlers/dashboard.ts` | Replace whole config (auto-saves TOML) | Loopback + optional bearer |
| `POST /dashboard/api/global-token-limit` | `src/handlers/dashboard.ts` | Set global token cap (sliding or calendar) | Loopback + optional bearer |
| `POST /dashboard/api/schedule/alias` | `src/handlers/dashboard.ts` | Add a `[schedule]` alias (body `{alias}`) | Loopback + optional bearer |
| `DELETE /dashboard/api/schedule/alias/:alias` | `src/handlers/dashboard.ts` | Remove a `[schedule]` alias | Loopback + optional bearer |
| `POST /dashboard/api/schedule/alias/:alias/target` | `src/handlers/dashboard.ts` | Upsert a target's window list (body `{target, windows}`) | Loopback + optional bearer |
| `DELETE /dashboard/api/schedule/alias/:alias/target/:target` | `src/handlers/dashboard.ts` | Remove a target from an alias | Loopback + optional bearer |
| `POST /dashboard/api/test-model` | `src/handlers/dashboard.ts` | Send a test request through a configured model | Loopback + optional bearer |
| `GET /dashboard/api/stats/models` | `src/handlers/dashboard.ts` | Per-model token and request stats | Loopback + optional bearer |
| `GET /dashboard/api/stats/agents` | `src/handlers/dashboard.ts` | Per-agent request stats | Loopback + optional bearer |
| `GET /dashboard/api/stats/requests` | `src/handlers/dashboard.ts` | Endpoint/upstream/status/timing/tool stats | Loopback + optional bearer |
| `GET /dashboard/api/stats/render` | `src/handlers/dashboard.ts` | Render stats snapshot for the dashboard | Loopback + optional bearer |
| `GET /dashboard/api/tools/blocklist` | `src/handlers/dashboard.ts` | Read the current tool blocklist | Loopback + optional bearer |
| `POST /dashboard/api/tools/toggle-block` | `src/handlers/dashboard.ts` | Block or unblock a tool by name | Loopback + optional bearer |
| `GET /dashboard/api/quota?model=<id>` | `src/handlers/dashboard.ts` | Remaining usage/credits for a model's route | Loopback + optional bearer |

### 1.5 Dynamic routing

In addition to the fixed endpoints above, the proxy accepts per-request dynamic
routes of the form `/{protocol}/{host}/{path_prefix}/{model_id?}/{claude_endpoint}`,
e.g. `/https/api.qnaigc.com/openai/v1/models/deepseek-v3.1/v1/messages`. These are
**passthrough** — the body is forwarded verbatim and auth headers are forwarded
as-is. Hosts are checked against `ALLOWED_HOSTS` (env, default
`127.0.0.1,localhost`) plus any host derived from `[models.*]` / `[default_upstream]`
config (`getAllowedHostsFromConfig`); out-of-allowlist hosts are rejected with `403`.

---

## 2. Client Endpoint → Upstream `upstream_mode` Matrix

Each client endpoint can be routed to one or more upstream API families. The mode
is selected by the route's `defaultMode` / model config.

| Client endpoint | `anthropic-messages` | `openai-completions` | `openai-responses` | `gemini-generatecontent` | `gemini-interactions` |
|---|---|---|---|---|---|
| `POST /v1/messages` | Native passthrough | Direct transform (via Chat Completions) | Indirect transform via `openai-completions` | Direct transform | Direct transform |
| `POST /v1/responses` | Direct transform | Direct transform | Native passthrough | Direct transform via Claude Messages | Direct transform via Claude Messages |
| `POST /v1/chat/completions` | Convert passthrough | Native passthrough | Transform passthrough | Transform passthrough | Same as `gemini-generatecontent` (not wired today) |
| `POST /v1beta/models/{model}:generateContent` / `:streamGenerateContent` | Indirect transform via `openai-completions` | Direct transform | Indirect transform via `openai-completions` | Native passthrough | Native Gemini-family |
| `POST /v1/interactions` | Indirect transform via `openai-completions` | Direct transform | Indirect transform via `openai-completions` | Native Gemini-family | Native Gemini-family |
| `GET /v1/models` | Passthrough | Passthrough | Passthrough | Passthrough | Passthrough |
| `POST /v1/embeddings` | Not supported | Only supported mode | Not supported | Not supported | Not supported |

**Mode semantics:**
- **Native passthrough** — client endpoint and upstream family match; body is not converted.
- **Direct transform** — request body is converted directly to the upstream family and response directly back.
- **Direct transform via Claude Messages** — Responses → Claude Messages → Gemini → Claude Messages → Responses.
- **Indirect transform via `openai-completions`** — body routes through Chat Completions as an intermediate shape.
- **Convert passthrough** — Chat Completions is converted to Claude Messages format, forwarded, then converted back.

---

## 3. Claude Messages Schemas (`src/types/claude.ts`)

### 3.1 Tools & content blocks

| Type | Shape | Notes |
|---|---|---|
| `ClaudeTool` | `{name, description?, input_schema}` | Tool descriptor |
| `ThinkingConfigParam` | `{type: "enabled"\|"disabled", budget_tokens?}` | Adaptive thinking toggle |
| `ClaudeTextBlock` | `{type: "text", text, cache_control?}` | Text part |
| `ClaudeImageBlock` | `{type: "image", source: {type: "base64", media_type, data}}` | Inline base64 image |
| `ClaudeDocumentBlock` | `{type: "document", source: {type, media_type?, data?, url?}}` | PDF / document part |
| `ClaudeToolUseBlock` | `{type: "tool_use", id, name, input}` | Assistant tool call |
| `ClaudeToolResultBlock` | `{type: "tool_result", tool_use_id, content, is_error?}` | Tool result |
| `ThinkingBlock` | `{type: "thinking", thinking, signature?}` | Extended thinking |
| `WebSearchToolResultBlock` | `{type: "web_search_tool_result", tool_use_id, content, error_code?}` | Web search tool result |
| `Citation` | `{type, cited_text, title?, url?}` | Inline citation |
| `ClaudeContent` | `string \| ClaudeContentBlock[]` | Message content union |
| `ClaudeContentBlock` | union of all block types above | Discriminated by `type` |

### 3.2 Request / response

| Type | Shape |
|---|---|
| `ClaudeMessage` | `{role: "user"\|"assistant", content: ClaudeContent}` |
| `ClaudeMessagesRequest` | `{model, messages, max_tokens, system?, tools?, tool_choice?, temperature?, top_p?, top_k?, stop_sequences?, stream?, metadata?, thinking?, service_tier?}` |
| `ClaudeTokenCountingRequest` | `{model, messages, system?, tools?, tool_choice?, thinking?}` |
| `ClaudeMessagesResponse` | `{id, type: "message", role: "assistant", content, model, stop_reason, stop_sequence?, usage: {input_tokens, output_tokens, cache_creation_input_tokens?, cache_read_input_tokens?}}` |
| `ClaudeTokenCountingResponse` | `{input_tokens}` |
| `ClaudeModelsResponse` | `{data: ClaudeModel[]}` |
| `ClaudeModel` | `{type: "model", id, display_name, created_at?}` |
| `ClaudeStreamEvent` | union of `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`, `ping`, `error` |

---

## 4. OpenAI Chat Completions / Responses Schemas (`src/types/openai.ts`)

### 4.1 Content parts & messages

| Type | Shape | Notes |
|---|---|---|
| `OpenAITextPart` | `{type: "text", text}` | Text part |
| `OpenAIThinkingPart` | `{type: "reasoning", text}` (or similar) | Reasoning content |
| `OpenAIImagePart` | `{type: "image_url", image_url: {url: string, detail?}}` | `url` may be a `data:` URI or `https://` |
| `OpenAIToolCall` | `{id, type: "function", function: {name, arguments}}` | Assistant tool call |
| `OpenAIContentPart` | union of the above | Discriminated by `type` |
| `OpenAIContent` | `string \| OpenAIContentPart[]` | Message content union |
| `OpenAIRole` | `"system"\|"user"\|"assistant"\|"tool"\|"developer"` | |
| `OpenAIMessage` | `{role, content?, name?, tool_call_id?, tool_calls?, refusal?, audio?, reasoning_content?}` | |

### 4.2 Requests

| Type | Shape |
|---|---|
| `OpenAIRequest` | `{model, messages, temperature?, top_p?, n?, stream?, stop?, max_tokens?, max_completion_tokens?, presence_penalty?, frequency_penalty?, logit_bias?, user?, tools?, tool_choice?, response_format?, seed?, reasoning_effort?, modalities?, audio?, prediction?, metadata?, prompt_cache_key?, prompt_cache_options?, prompt_cache_breakpoint?, parallel_tool_calls?, service_tier?, store?}` |
| `OpenAITokenCountingRequest` | `{model, messages, tools?, tool_choice?}` |

### 4.3 Responses

| Type | Shape |
|---|---|
| `OpenAIResponse` | `{id, object: "chat.completion", created, model, choices: [{index, message, finish_reason, logprobs?}], usage: {prompt_tokens, completion_tokens, total_tokens, prompt_tokens_details?, completion_tokens_details?}, system_fingerprint?}` |
| `OpenAITokenCountingResponse` | `{input_tokens, total_tokens?}` |
| `OpenAIModelsResponse` | `{object: "list", data: OpenAIModel[]}` |
| `OpenAIModel` | `{id, object: "model", created, owned_by?}` |
| `OpenAIStreamChunk` | `{id, object: "chat.completion.chunk", created, model, choices: [{index, delta, finish_reason?, logprobs?}], usage?}` |

---

## 5. Gemini Schemas (`src/types/gemini.ts`)

### 5.1 Content parts (`GeminiContent` union)

| Type | Shape | Notes |
|---|---|---|
| `GeminiTextContent` | `{text}` | Plain text |
| `GeminiImageContent` | `{inlineData: {mimeType, data}}` or `{inline_data: ...}` | Inline base64 image |
| `GeminiAudioContent` | `{inlineData: {mimeType: "audio/...", data}}` | Inline audio |
| `GeminiVideoContent` | `{inlineData: {mimeType: "video/...", data}}` or `{fileData}` | Inline video |
| `GeminiDocumentContent` | `{inlineData: {mimeType: "application/pdf", data}}` or `{fileData}` | PDF / file |
| `GeminiFunctionCallContent` | `{functionCall: {name, args}}` or `{function_call: ...}` | Tool call |
| `GeminiFunctionResultContent` | `{functionResponse: {name, response}}` or `{function_response: ...}` | Tool result |
| `GeminiThoughtContent` | `{thought: true, text}` | Thinking part |
| `GeminiCodeExecutionCallContent` | `{executableCode: {language, code}}` | Code execution |
| `GeminiCodeExecutionResultContent` | `{codeExecutionResult: {outcome, output}}` | Code execution result |

`GeminiInput = string | GeminiContent | GeminiContent[] | GeminiTurn[]`

### 5.2 Tooling & config

| Type | Shape | Notes |
|---|---|---|
| `GeminiToolType` | `"function"\|"google_search"\|"code_execution"\|"url_context"\|"computer_use"\|"mcp_server"\|"file_search"` | |
| `GeminiTool` | `{functionDeclarations?, googleSearch?, codeExecution?, urlContext?, computerUse?, mcpServer?, fileSearch?}` | |
| `GeminiGenerationConfig` | `{temperature?, topP?, topK?, maxOutputTokens?, candidateCount?, stopSequences?, responseMimeType?, responseSchema?, thinkingConfig?, seed?}` | |
| `GeminiAgentConfig` | `{type: "deep-research-pro-preview-12-2025"}` | Agent preset |

### 5.3 Usage, interactions & streaming

| Type | Shape |
|---|---|
| `GeminiUsage` | `{promptTokenCount, candidatesTokenCount?, totalTokenCount, cachedContentTokenCount?, thoughtsTokenCount?, toolUsePromptTokenCount?}` |
| `GeminiInteractionRequest` | `{input, model, systemInstruction?, tools?, toolConfig?, generationConfig?, cachedContent?, agent?, previousInteractionId?, conversationId?, responseModalities?, safetySettings?, stream?}` |
| `GeminiInteractionStatus` | `"in_progress"\|"requires_action"\|"completed"\|"failed"\|"cancelled"` |
| `GeminiInteractionResponse` | `{id, object: "interaction", status, model, output: GeminiContent[], usage, created, updated, previousInteractionId?, conversationId?, error?}` |
| `GeminiSSEEvent` | union of `interaction.start`, `interaction.in_progress`, `interaction.completed`, `interaction.failed`, `content.start`, `content.delta`, `content.stop`, `tool_use`, `tool_result`, `error` |

### 5.4 Model & agent option enums

| Type | Allowed values |
|---|---|
| `GeminiModelOption` | enumerated set of Gemini model ids the proxy recognizes |
| `GeminiAgentOption` | currently `"deep-research-pro-preview-12-2025"` |

---

## 6. Shared / Internal Schemas (`src/types/shared.ts`)

Holds cross-cutting types that aren't tied to a single provider: routing
decisions, resolved-route records, composite-alias results, schedule-window
records, request/response lifecycle objects used by the dashboard and stats
sidecar. Source of truth for these is `src/types/shared.ts`.

---

## 7. Configuration Schema (`proxy_config.toml`)

`src/utils/config-loader.ts` implements a hand-written TOML parser
(`parseSimpleToml`); see `proxy_config.example.toml` for a full example.

### 7.1 Top-level TOML sections

| Section | Required | Purpose |
|---|---|---|
| `[general]` | no | global knobs (limits, week-start, keychain) |
| `[default_upstream]` | no | default `base_url`, `upstream_mode`, `api_key` |
| `[models.<category>]` | no | category of model entries (`claude`, `gemini`, `gpt`, `free`, `default`, user-defined) |
| `[composite]` | no | share/fallback/fusion/coordinator aliases |
| `[schedule]` | no | time-of-day aliases |
| `[transforms.<name>]` | no | named sets of request/response rewrites |
| `[transform_defaults]` | no | per-upstream-mode default transform set list |
| `[dashboard]` | no | optional `api_key` for dashboard bearer auth |
| `[fetch]` | no | optional image-encode sidecar URL (`image_encode`) |

### 7.2 `[general]` keys (selected)

`global_token_limit`, `global_token_window`, `agent_aggregations`,
`max_body_bytes`, `allowed_hosts`, `log_level`, `tui`, `week_start`,
`keychain_service`, etc. (Full reference: [`configuration-reference.md`](./configuration-reference.md).)

### 7.3 `[models.<category>]` entry keys

`base_url`, `upstream_mode`, `api_key`, `target`, `route`, `composite`,
`share`, `fallback`, `fusion`, `coordinator`, `schedule`, `transforms`,
`limits`, `aliases`, etc. (See [`proxy_config.example.toml`](../getting-started/proxy_config.example.toml).)

### 7.4 `[composite]` and `[schedule]`

- **`[composite.<alias>]`** — declares a composite route combining multiple
  model entries; values may be `share`, `fallback`, `fusion`, or `coordinator`.
- **`[schedule.<alias>] target.<target> = [window, ...]`** — time-of-day
  routing windows (`{day, start, end}` shape).

### 7.5 `[transforms.<name>]`

Named bundles of request/response rewrites applied per upstream mode or
per-model. See [`transforms-reference.md`](./transforms-reference.md) for the
rewrite DSL.

### 7.6 `[dashboard]`

`api_key = "..."` — when set, every `/dashboard/api/*` route requires
`Authorization: Bearer <dashboard.api_key>`; `GET /dashboard` HTML remains
loadable from loopback without auth.

### 7.7 `[fetch]`

`image_encode = "http://localhost:port"` (or `IMAGE_ENCODE_URL` env) —
delegates `image_url` http(s) fetching to an external sidecar. The sidecar
receives `POST {url}/encode` with `{"url":"..."}` and returns
`{"mime_type","data"}`. The proxy still applies SSRF guards; the sidecar
applies its own policy.

---

## 8. Cross-Mode Conversion Notes

The proxy ships with direct and indirect request/response converters in
`src/converters/`:

| Converter | Direction |
|---|---|
| `claude-to-gemini.ts` | Claude Messages ↔ Gemini generateContent |
| `claude-to-openai.ts` | Claude Messages ↔ Chat Completions |
| `openai-to-claude.ts` | Chat Completions → Claude Messages |
| `openai-to-gemini.ts` | Chat Completions → Gemini generateContent |
| `gemini-to-claude.ts` | Gemini generateContent → Claude Messages |
| `completions-to-responses.ts` | Chat Completions ↔ OpenAI Responses |
| `responses-to-completions.ts` | OpenAI Responses → Chat Completions |
| `gemini-streaming.ts` | Gemini SSE → OpenAI / Claude streaming events |
| `streaming.ts` | shared SSE helpers (delta coalescing, finishReason mapping) |

### 8.1 Image input across format boundaries

| Source shape | Decoded in-process by | Sent upstream as |
|---|---|---|
| Caller sent `data:` URI | `decodeDataUri` | inline bytes (in target shape) |
| Caller sent raw base64 (Gemini `inline_data` / Claude `image`) | re-wrap | inline bytes |
| Caller sent `https://...` URL | SSRF-guarded fetch in-process, or sidecar `POST {url}/encode` | inline bytes — except on OpenAI → OpenAI Responses route, which passes `{url, detail?}` through unchanged |

`isInternalHost` blocks loopback / RFC1918 / link-local / mDNS hosts. 20 MiB
byte cap. `ALLOWED_HOSTS` does **not** apply to image URLs.

### 8.2 Image output

Model-generated images only reach clients through native Gemini passthrough.
Cross-mode response converters drop `inline_data` / image parts:

- **Claude Messages**: assistant `image` blocks are rejected by spec.
- **OpenAI Chat Completions**: no field for model-generated images in a
  completion response.
- **Known limitation — Gemini → OpenAI with mixed `functionCall` + `inline_data`**:
  `convertGeminiGenerateContentToOpenAI` drops `inline_data` when a single
  turn contains both; only `tool_calls` and text are emitted.

### 8.3 OpenAI prompt caching fields

| Client endpoint | `upstream_mode` | `prompt_cache_key` | `prompt_cache_options` | `prompt_cache_breakpoint` |
|---|---|---|---|---|
| `POST /v1/responses` | `openai-responses` | Preserved | Preserved | Preserved |
| `POST /v1/responses` | `openai-completions` | Preserved | Dropped | Dropped |
| `POST /v1/chat/completions` | `openai-completions` | Preserved | Preserved | Preserved |
| `POST /v1/chat/completions` | `openai-responses` | Preserved | Dropped | Dropped |

---

## 9. Auth Header Forwarding

The proxy is transparent to upstream authentication. The following request
headers are forwarded verbatim to whichever upstream the model resolved to:

- `Authorization: Bearer <token>` (OpenAI / OpenAI-compatible)
- `x-api-key: <key>` (Anthropic)
- `x-goog-api-key: <key>` (Google Gemini)

Plus plumbing headers (`user-agent`, request id, optionally `x-forwarded-for`,
`x-real-ip`, `x-resource-for`) preserved by the auth-server / record-server
flows. When `dashboard.api_key` is configured, dashboard routes additionally
require `Authorization: Bearer <dashboard.api_key>`.

---

## 10. See Also

- [`api-endpoints.md`](./api-endpoints.md) — narrative details for dynamic
  routing, image I/O, prompt caching, dashboard JSON API.
- [`configuration-reference.md`](./configuration-reference.md) — full
  `proxy_config.toml` schema.
- [`transforms-reference.md`](./transforms-reference.md) — request/response
  rewrite DSL.
- [`routing-and-aliases.md`](./routing-and-aliases.md) — composite, fallback,
  fusion, coordinator, schedule semantics.
- [`interactions.md`](./interactions.md) — Gemini Interactions wire shape.
