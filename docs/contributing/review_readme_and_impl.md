# README ↔ Implementation Review

Review date: 2026-08-10
Reviewer: automated pass over `README.md` vs `src/`
Scope: API endpoints, config fields, routing/aliases, converters/transforms, dashboard/stats.

Legend: CORRECT · MISSING_IN_IMPL · MISSING_IN_README · BEHAVIOR_MISMATCH · DEFAULT_MISMATCH · NAME_MISMATCH

---

## 1. API Endpoints

All documented endpoints exist in the implementation.

| README claim | Implementation | Status | Notes |
|---|---|---|---|
| `POST /v1/messages` (L321) | `src/index.ts:364` | CORRECT | |
| `POST /v1/messages/count_tokens` (L322) | `src/index.ts:544` | CORRECT | |
| `POST /v1/responses` (L323) | `src/index.ts:591` | CORRECT | |
| `POST /v1beta/models/{model}:generateContent` (+ `:streamGenerateContent`, `:countTokens`) (L324) | `src/index.ts:437,465` | CORRECT | |
| `POST /v1/models/{model}:generateContent` variant (L330) | `src/index.ts:437,465` (both `/v1beta/models/` and `/v1/models/` accepted) | CORRECT | |
| `POST /v1/interactions` (L325) | `src/index.ts:401` | CORRECT | |
| `POST /v1/embeddings` (L326) | `src/index.ts:638,1595` | CORRECT | |
| `GET /v1/models` (L327) | `src/index.ts:629,897` | CORRECT | |
| `GET /dashboard` (L328) | `src/index.ts:762` | CORRECT | |
| `POST /v1/chat/completions` (matrix L345, gated by `DEV_PASS_THROUGH`) | `src/index.ts:523,1087,1174` | CORRECT | |
| Dashboard API `GET/PUT /dashboard/api/config` (L442-443) | `src/index.ts:773,782` | CORRECT | |
| `POST /dashboard/api/global-token-limit` (L444) | `src/index.ts:813` | CORRECT | |
| `POST /dashboard/api/schedule/alias` (L445) | `src/index.ts:818` | CORRECT | |
| `DELETE /dashboard/api/schedule/alias/:alias` (L446) | `src/index.ts:824` | CORRECT | |
| `POST /dashboard/api/schedule/alias/:alias/target` (L447) | `src/index.ts:833` | CORRECT | |
| `DELETE /dashboard/api/schedule/alias/:alias/target/:target` (L448) | `src/index.ts:842` | CORRECT | |
| `POST /dashboard/api/test-model` (L449) | `src/index.ts:808` | CORRECT | |
| `GET /dashboard/api/stats/models` (L450) | `src/index.ts:787` | CORRECT | |
| `GET /dashboard/api/stats/agents` (L451) | `src/index.ts:791` | CORRECT | |
| `GET /dashboard/api/stats/requests` (L452) | `src/index.ts:804` | CORRECT | |
| `GET /dashboard/api/tools/blocklist` (L453) | `src/index.ts:795` | CORRECT | |
| `POST /dashboard/api/tools/toggle-block` (L454) | `src/index.ts:799` | CORRECT | |

### MISSING_IN_README — endpoints registered but not documented

| Endpoint | Implementation | Notes |
|---|---|---|
| `POST /v1/responses/input_tokens` | `src/index.ts:553,1449,1743` | sibling of `/v1/responses`; not in the API Endpoints table. |
| `POST /v1/responses/compact` | `src/index.ts:572,1458,1752` | sibling of `/v1/responses`; not in the API Endpoints table. |
| `GET /config-reload` | `src/index.ts:687` | reloads config from `PROXY_CONFIG_URL`; only meaningful when remote config is used. Not documented. |
| `GET /health` and `GET /` (root) | `src/index.ts:859` | health check; only referenced obliquely in the `auth_url` exempt-paths note (L959). Not listed as an endpoint. |
| `GET /favicon.ico` | `src/index.ts:854` | returns 204; plumbing, but undocumented. |
| Dynamic routes `/http/...` and `/https/...` | `src/index.ts:338` (`isDynamicRoute`), `src/utils/routing.ts:121` (`parseDynamicRoute`) | the entire dynamic-routing feature is absent from the README. |

---

## 2. Configuration Fields & Environment Variables

All documented `[general]`, `[default_upstream]`, `[model_usage]`, `[transforms.*]`, `[dashboard]`, `[privacy_filter]`, `[fetch]`, and `[kompress]` fields are parsed by `src/utils/config-loader.ts` and consumed in code.

| README claim | Implementation | Status | Notes |
|---|---|---|---|
| `[general] auth_url` (L959) | `config-loader.ts:21,2771` | CORRECT | |
| `[general] auth_with_model` (L960) | `config-loader.ts:22,2773` | CORRECT | |
| `[general] auth_passthrough_with` `"user_key"`/`"config_key"` (L961) | `config-loader.ts:23`; consumed `src/index.ts:959` (`=== 'config_key'`) | CORRECT | Only the two documented values are honoured. |
| `[general] global_token_limit` `<num><K/M/B/T> <duration>` (L962) | `config-loader.ts:356` (`parseHumanTokenLimit`); `dashboard-stats.ts:215` (`parseWindowSpec`) | CORRECT | K/M/B/T suffixes and 1h–23h / 1d–6d sliding, 1w / 1m calendar all confirmed. |
| `[general] week_start_day` `"monday"`/`"sunday"` (L963) | `config-loader.ts:28,2775`; `src/index.ts:720` | CORRECT | |
| `[general] budget_to_effort_low/medium/high` (L964-966) | `config-loader.ts:24-26,1067`; `converters/claude-to-openai.ts:193-217` | CORRECT | `budget_to_effort_high = 0` special-cases "always high" (line 210). Threshold of `0` for low/medium also forces that level (line 213). The example values `32768/65536/128000` in the README (L191-194) are illustrative, not code defaults — when unset, the legacy fallback is `4096/2048` (line 207). |
| `[default_upstream] default_base_url / default_api_key / upstream_mode` (L972-974) | `config-loader.ts:31-33,535-543,741-749` | CORRECT | |
| `[model_usage] record_url` (L980) | `config-loader.ts:47,2791`; `src/utils/model-usage-recorder.ts:42` | CORRECT | |
| `[dashboard] api_key` bearer auth on `/dashboard/api/*`, `GET /dashboard` open (L427-438) | `src/index.ts:766-771` (api auth gate), `src/index.ts:762` (page bypass) | CORRECT | |
| `[privacy_filter]` fields (L1208-1219) | `config-loader.ts:72-80,3057-3066,2421-2429` | CORRECT | All 9 documented fields parsed. |
| `[fetch] image_encode` / `IMAGE_ENCODE_URL` (L386) | `config-loader.ts:84-92,2800,3067-3072`; `src/utils/image-fetch.ts:65-98` | CORRECT | Sidecar contract `POST {url}/encode {"url":"..."}` → `{"mime_type","data"}` confirmed; must be localhost/private LAN (`image-fetch.ts:88`). |
| 5 transform hooks + `endpoint_readin`/`endpoint_writeout` legacy aliases (L982-1034) | `request-transform.ts:21-25`; `config-loader.ts:184-192` (`HOOK_ALIASES`) | CORRECT | |
| 5 Tier-1 ops `rename/set/default/remove/map_value` (L1022-1030) | `request-transform.ts:398-420` | CORRECT | `map_value` `when_sibling` guard implemented (line 420-421). |
| Tier-2 builtins table lists 3 (L1036-1042) | `request-transform.ts:90,106,128,260,319`; `config-loader.ts:175` | **MISSING_IN_README** | Code implements **5** builtins. `filter_anthropic_beta` and `ensure_tool_config_cache_ttl` are real (`request-transform.ts:260,319`) but absent from the README table. |
| `max_tokens_rename` "wired as a mode-level default for openai-completions and openai-responses via `[transform_defaults]`" (L1006-1009) | `config-loader.ts:523` reads `transform_defaults` purely from user config | **BEHAVIOR_MISMATCH (wording)** | The phrase "the proxy ships with `max_tokens_rename` wired as a mode-level default" is misleading. There is **no code-level default**; the wiring only takes effect when the user's `proxy_config.toml` contains the `[transform_defaults]` block. The example file (`proxy_config.example.toml:435-437`) ships it, but a user writing a config from scratch would not get it automatically. |
| `no_max_completion_tokens` opt-out set (L1010-1011) | honoured as an ordinary user-defined transform set; no special-casing in code | CORRECT | Works as documented (it's just a user-defined set that does the reverse rename). |
| Positional-array form `[target, base_url, api_key, mode, transforms]` (L996-1004) | `config-loader.ts:1694,2033-2059` | CORRECT | 1/3/4/5-element arrays all accepted; empty string falls back. |
| Env `PORT/LOG_LEVEL/ALLOWED_ORIGINS/DEFAULT_MAX_TOKENS/TUI/DUMP/DEV_MODE` (L1156-1164) | `src/server.ts:12,36,166-167`; `src/handlers/claude.ts:48`; `src/index.ts:232` | CORRECT | `DEFAULT_MAX_TOKENS` default `8192` confirmed (`claude.ts:48`). |
| Env `PROXY_CONFIG_PATH/PROXY_CONFIG_URL` (L1170-1171) | `src/server.ts:41-42` | CORRECT | |
| Env `LOCAL_TIKTOKEN/TIKTOKEN_MODEL/UPSTREAM_BODY_TIMEOUT_MS/MODELS_CACHE_TTL` (L1182-1185) | `src/server.ts:33`; `src/utils/token-counting.ts:390`; `src/utils/fetch-timeout.ts:1-13`; `src/handlers/models.ts:31` | CORRECT | |
| Env `JSON_STRINGIFY_METHOD` default `json` (L1186) | `src/utils/stringify.ts:6-25` | **MISSING_IN_README** | Code accepts `json`, `safe-stable`, `fast-safe`. The README does not document the accepted values. |
| Env `DEV_PASS_THROUGH` (L1187) | `src/server.ts:44`; gated throughout `src/index.ts` | CORRECT | |
| Env `CONVERSATION` (L1188) | `src/handlers/responses.ts:615`; `src/utils/conversation-store.ts` | CORRECT | Also accepts `CONVERSATION_MAX_ENTRIES` (undocumented in README). |
| Env `IMAGE_BLOCK_DATA_MAX_SIZE` default `10485760` (L1189) | `src/server.ts:35` | CORRECT | |
| Env `ALLOWED_HOSTS` default `127.0.0.1,localhost`, "does not apply to image URLs" (L1190, L385) | `src/server.ts:34`; `src/utils/routing.ts:78-81`; `src/utils/image-fetch.ts` (uses `isInternalHost`, not `ALLOWED_HOSTS`) | CORRECT | |
| Env `PRIVACY_FILTER_*` (L1194-1198) | `src/server.ts:46-48`; `src/utils/privacy-filter.ts:159-170` | CORRECT | Defaults match (timeout 40000, max_chars 1024000). |
| Env `KOMPRESS_*` (L1237-1245) | `src/server.ts:49-55`; `src/utils/kompress.ts:67-82` | CORRECT | All defaults match (fail_open true, timeout 40000, max_chars 1024000, keep_ratio 0.5, min_chars 200). |

### MISSING_IN_README — env vars consumed but not documented

| Env var | Implementation | Notes |
|---|---|---|
| `CONVERSATION_MAX_ENTRIES` | `src/utils/conversation-store.ts:15` | Caps the experimental conversation cache size; default 10000. |
| `GEMINI_API_VERSION` | `src/server.ts:37`; used `src/index.ts:404,441,473,610,1442,1736` | Defaults to `v1beta`. README mentions Gemini API versioning only in passing (L346). |
| `MESSAGES_UPSTREAM_MODE` | `src/server.ts:38` | Defaults to `openai-completions`. Not documented. |
| `INTERACTIONS_UPSTREAM_MODE` | `src/server.ts:39` | Defaults to `native`. Not documented. |
| `GENERATE_CONTENT_UPSTREAM_MODE` | `src/server.ts:40` | Defaults to `native`. Not documented. |
| `DEV_NO_KEY` | `src/server.ts:45,158-159`; `src/index.ts:904` | Allows model requests to omit auth headers. Not documented. |
| `IMAGE_ENCODE_TIMEOUT_MS` | `src/utils/image-fetch.ts:92` | Sidecar timeout (distinct from `PRIVACY_FILTER_TIMEOUT_MS`). Not documented. |

---

## 3. Routing, Composite, Fusion, Coordinator, Schedule, Token Limits

| README claim | Implementation | Status | Notes |
|---|---|---|---|
| Category lookup priority: exact > `prefix-*` > `*` catch-all (L474-489) | `config-loader.ts:3114-3175` (`getModelConfig`) | CORRECT | Exact first (3117-3130), then wildcard (3132-3147), then `default` catch-all (3149-3172). |
| Wildcard sections checked in order `models.claude` → `models.gemini` → `models.gpt` (L479) | `config-loader.ts:3134` (`providerWildcardOrder = ['claude','gemini','gpt']`) | CORRECT | |
| User-defined provider sections (`[models.nvidia]`, etc.) "inherit the same exact / `prefix-*` / `*` catch-all routing surface" (L499-505, the "Section flavors" note) | `config-loader.ts:3134` hardcodes only `['claude','gemini','gpt']` plus the literal `default` category at priority 3 | **BEHAVIOR_MISMATCH** | The README's "Section flavors" note claims user-defined sections like `[models.nvidia]` get wildcard matching. The code does **not** implement this: only the three hardcoded categories (`claude`, `gemini`, `gpt`) plus the literal `default` section are checked for wildcards. A `[models.nvidia]` section with `"nvidia-*" = {}` would **not** match — its wildcards are silently inert. Either the README is wrong, or the code is missing a feature it claims to have. (The auto-memory note `proxy_config_section_inheritance.md` also asserts user-defined sections inherit wildcards — same discrepancy.) |
| `models.free` / `models.embedding` are exact-only (L484-486, L495-497) | `config-loader.ts:3134` (only `claude/gemini/gpt` are in the wildcard order); `free`/`embedding` not special-cased, so they only get exact-match via Priority 1 | CORRECT | |
| `base_url` inheritance: per-entry → section → `[default_upstream] default_base_url` → `http://localhost` (L512-514) | `config-loader.ts:535-542,741-749` | CORRECT | (the `http://localhost` terminal fallback is applied at the URL-build step) |
| `api_key` inheritance: per-entry → section → `[default_upstream] default_api_key` (L514-515) | `config-loader.ts:542-543,748-749` | CORRECT | |
| `upstream_mode` inheritance: per-entry → section → `[default_upstream] upstream_mode` → `"openai-completions"` (L516-517) | `config-loader.ts:535-536,741-742` | CORRECT | |
| `auth_passthrough_with = "user_key"` (default): caller's key wins except for `free` (L542-548) | `src/index.ts:959` (`useConfigKey = ... === 'config_key'`) | CORRECT | Default-`user_key` branch is the negation. |
| `auth_passthrough_with = "config_key"`: configured key always wins except `free` (L551-558) | `src/index.ts:959` | CORRECT | |
| `[models.embedding].api_key` always wins regardless of mode (L560-569) | `src/index.ts:1534` (spread `{ ...modelAuthHeaders, ...formatApiKeyForUpstream(embeddingApiKey, …) }`) | CORRECT | Comment confirms intentional override. |
| `base_url` may include the full endpoint path (L526-537) | `src/utils/routing.ts:255-292` (`buildUpstreamUrl`) | CORRECT | All listed markers recognized; version-dedupe logic also present (line 281-284). |
| Composite share decay: halved on failure, floor = configured/10 (L593-594) | `src/index.ts:105-111` (`decayEffectiveCompositeShare`): `next = max(floor, previous/2)`, `floor = configured/10` | CORRECT | Runtime-only — TOML never modified. |
| Detected composite mode derived from targets (primary/fallback/share) (L603-612) | `config-loader.ts:695-697,657-660` | CORRECT | |
| Fusion synth falls back to judge, then first panel (L617-618) | `config-loader.ts:862-864` (`synth = judge ?? panel[0]`) | CORRECT | |
| `fusion_options` fields: `min_panel`, `panel_timeout_ms`, `judge_required`, `expose_metadata`, `max_concurrent` (L861-862) | `config-loader.ts:401-410,870,3256-3260` | CORRECT | |
| Coordinator `coord = 1, role = "planner"/"executor"`, exactly one each (L656) | `src/utils/coordinator.ts`; `config-loader.ts:430-440` | CORRECT | |
| Coordinator default `toolset`: `ExitPlanMode, Edit, Write, Bash, NotebookEdit` (L668, L684) | `config-loader.ts:434-440` (`COORDINATOR_DEFAULT_TRIGGER_TOOLS`) | CORRECT | Absent → default set; `[]` → null (any tool triggers); list → Set (line 925-928). |
| Coordinator `toolset` matching scans `messages[]` history (L658) | `src/utils/coordinator.ts:21-50` | CORRECT | One-way switch (line 49: returns `'executing'` on first match). |
| Composite cycle detection at load with `[FATAL]` log (L696-699) | `config-loader.ts:3081` (`err.message.includes('Routing cycle detected') ? '[FATAL]' : '[ERROR]'`) | CORRECT | |
| Schedule window syntax `{from, to, days}` with defaults 0/24/everyday (L773-776) | `config-loader.ts:450-457,955-958,1610-1615` | CORRECT | |
| "Any other string normalizes to 'everyday' rather than raising an error" (L776) | `config-loader.ts:3518-3525` (`normalizeScheduleDays`) | CORRECT | Unknown strings leave `days` unset = everyday. |
| Schedule fallback = `windows = []`; first-listed wins on multiple fallbacks (L778-779) | `config-loader.ts` schedule resolution; first-empty-window-target used | CORRECT | |
| Token windows: `1h-23h` sliding, `1d-6d` sliding, `1w` calendar week, `1m` calendar month (L714-719) | `config-loader.ts:336-348` (`isSlidingDuration`); `dashboard-stats.ts:215-220` (`parseWindowSpec`) | CORRECT | |
| Token magnitude suffixes K/M/B/T (L721) | `config-loader.ts:359-367` | CORRECT | |
| Migration note: pre-3.x `1w`/`1m` were sliding, now calendar (L749-751) | n/a (historical) | CORRECT | Documentation-only; no code claim. |
| Token limit is pre-request admission, not hard cap (L741-747) | `src/index.ts:966,1095,1252` (cutoff checked before upstream fetch) | CORRECT | |
| Stats keyed by resolved upstream model id, not alias key (L459-467) | `src/index.ts:1311,1617,2202` use `route.modelAlias || candidateName`; `modelAlias` is the resolved target (`config-loader.ts:546-572`) | CORRECT | |

---

## 4. Converters & Transform Hooks

| README claim | Implementation | Status | Notes |
|---|---|---|---|
| `upstream_mode` matrix — Native passthrough cells (diagonal) | `src/handlers/{messages,openai,gemini,chat-completions,embeddings}.ts` | CORRECT | Each native route forwards the body without format conversion. |
| `/v1/messages` + `openai-completions` = "Direct transform" Claude↔Chat Completions (L343) | `src/handlers/messages.ts:569` (`convertClaudeToOpenAIRequests`) + `openai-to-claude.ts` | CORRECT | |
| `/v1/messages` + `openai-responses` relabeled to "Indirect transform via `openai-completions`": "Claude Messages → Chat Completions → Responses `input` → Claude Messages" (L349) | `src/handlers/messages.ts:569,582-639` | **RESOLVED (2026-08-10)** | Previously BEHAVIOR_MISMATCH (labeling). The code path is Claude body → OpenAI Chat Completions request (line 569) → Responses `input` (line 589) → upstream; response side synthesises a Completions response then converts back to Claude. This is an indirect transform via the Chat Completions shape. README L349 now labels the cell "Indirect transform via `openai-completions`", and the definition note at README L361 was widened to cover both Gemini endpoints and the `/v1/messages` → `openai-responses` route. |
| `/v1/messages` + `gemini-generatecontent` / `gemini-interactions` = "Direct transform" (L343) | `src/handlers/messages.ts` (gemini branches); `src/converters/claude-to-gemini.ts`, `gemini-to-claude.ts` | CORRECT | |
| `/v1/responses` + `anthropic-messages` = "Direct transform via Claude Messages" (L344) | `src/handlers/responses.ts` (uses Claude as bridge, not openai-completions) | CORRECT | |
| `/v1/responses` + `openai-completions` = "Direct transform" (L344) | `src/handlers/responses.ts`; `src/converters/{responses-to-completions,completions-to-responses}.ts` | CORRECT | |
| Gemini `:generateContent` + `anthropic-messages` = "Indirect transform via `openai-completions`" (L346) | `src/handlers/gemini.ts` + `openai.ts` (generateContent → Chat Completions → Claude Messages → generateContent) | CORRECT | |
| `/v1/embeddings` only supported in `openai-completions` mode (L349) | `src/index.ts:1595` (hardcoded to OpenAI embeddings) | CORRECT | |
| `/v1/chat/completions` gated by `DEV_PASS_THROUGH` (L345, L1187) | `src/index.ts:1087,1174` | CORRECT | |
| `SYNTHETIC_THINKING_SIGNATURE = 'synthetic'`, used only on Claude→OpenAI→Claude (L168-176) | `src/converters/openai-to-claude.ts:19` (`= "synthetic"`); applied at lines 152, 251; `streaming.ts:269,508` | CORRECT | Reverse converter drops signature before upstream call (not re-verified). |
| Tag-based reasoning extraction: `<think>` and `<thinking>` tags (L195-203) | Implemented in streaming + non-streaming paths (cross-chunk stitching confirmed in `src/converters/streaming.ts`) | CORRECT | |
| `reasoning_content` round-trip for DeepSeek-style models (L204-213) | Implemented in streaming/converters | CORRECT | Tool-call fragment accumulation for DeepSeek-style fragmented tool calls also present. |
| `thinking.budget_tokens` capped to `max_tokens` unless `anthropic-beta: interleaved-thinking-2025-05-14` (L177-183) | `src/utils/validation.ts` (validator); `src/utils/beta-features.ts` | CORRECT | (validation logic confirmed present) |
| Image input/output cross-boundary wire shapes (L363-369) | `src/converters/{claude-to-gemini,openai-to-gemini,claude-to-openai,openai-to-claude}.ts`; `src/utils/image-fetch.ts` | CORRECT | Gemini `inline_data`, OpenAI `image_url` data-URI, Claude `image.source.base64` all match. |
| OpenAI→OpenAI Responses route passes `image_url` through unchanged (no SSRF guard) (L383, L395) | confirmed in `src/handlers/openai.ts` / `responses.ts` conversion paths | CORRECT | |
| `ALLOWED_HOSTS` does not apply to image URLs; image SSRF uses `isInternalHost` (L385, L393) | `src/utils/routing.ts:37-62` (`isInternalHost`); `src/utils/image-fetch.ts` (uses `isInternalHost`, not `ALLOWED_HOSTS`) | CORRECT | 20 MiB byte cap (`image-fetch.ts:23`). |
| OpenAI prompt-caching fields preservation table (L413-418) | converter-specific field handling | CORRECT | (per-cell behaviour matches the converters) |
| Known limitation: Gemini `generateContent` → OpenAI drops `inline_data` when `functionCall` present (L407) | `src/handlers/openai.ts` (`convertGeminiGenerateContentToOpenAI`) | CORRECT | Documented as intentional trade-off. |
| Image output from Gemini not carryable to Claude/OpenAI clients (L398-405) | response-side `convertGeminiGenerateContentToClaude` extracts text only | CORRECT | Hard schema limit, as documented. |

---

## 5. Dashboard, Usage Stats, Sidecars

| README claim | Implementation | Status | Notes |
|---|---|---|---|
| `model_proxy_tokens.jsonl` written when `TUI=true` OR `DUMP=true` (L257-258) | `src/utils/dashboard-stats.ts:392` (`TOKEN_LOG_FILE = './model_proxy_tokens.jsonl'`); `src/server.ts:166-167` (gate); `dashboard-stats.ts:2265` (`if (!process.env.DUMP) return;`) | CORRECT | |
| JSONL dump fields: `date, timestamp, lastDumpTs, modelStats, toolStats, heatmapEvents, compositeAliasStates` (L260-305) | `src/utils/dashboard-stats.ts:515-523` (write), `637-760` (read) | CORRECT | All field shapes match. |
| `heatmapEvents` compact shape `{models, sequences}` with `{ts, values, id}` (L295-298) | `dashboard-stats.ts:704-728` (reads both shapes); `484-490` (writes compact) | CORRECT | Legacy `[{timestamp, values, model}]` still accepted. |
| `compositeAliasStates` shape `{limit, duration, events: [{ts, tokens}]}`, 31-day prune (L299-305) | `dashboard-stats.ts:506-513` (write); `109` (`TOKEN_RETENTION_WINDOW_MS = 31d`); `674` (prune cutoff) | CORRECT | Legacy `compositeLimitWindows` accumulator shape accepted but restores with empty event log. |
| Startup dedup: latest dump per date for cumulative; sum across days for all-time; heatmapEvents from all rows with dedup by `timestamp:values:modelId` (L307-316) | `dashboard-stats.ts:691-756` | CORRECT | Dedup key at line 741: `` `${event.timestamp}:${event.values}:${event.id ?? ''}` ``. |
| TUI keybindings: `c` composite, `s` schedule, `t` test, `r` reload, `l` token limit, `d` stats, `p` tools block, `Ctrl+U` dump usage, `Ctrl+C` quit (L253-256) | `src/tui.ts:1174` (help line); handlers at `tui.ts:1011-1044,584,830,1266` | **RESOLVED (2026-08-10)** | Previously MISSING_IN_README. README L253-256 now lists all 9 hotkeys (`c`, `s`, `t`, `r`, `l`, `d`, `p`, `Ctrl+U`, `Ctrl+C`), matching the TUI help line at `tui.ts:1174` and the input dispatcher. |
| Dashboard `api_key` bearer auth on `/dashboard/api/*`, page open to loopback (L431-438) | `src/index.ts:762` (page bypass), `766-771` (api gate) | CORRECT | |
| Stats keyed by resolved target id (L459-467) | see Section 3 | CORRECT | |
| "filtered Keys" counter increments per redacted span; TUI shows `filtered Keys: N`; hidden while zero (L1263-1271) | `src/utils/dashboard-stats.ts:2124-2131` (`privacyKeysDetectedTotal`); `src/tui.ts:1119-1126`; dashboard HTML at `src/handlers/dashboard.ts:641` | **RESOLVED (2026-08-10)** | Previously NAME_MISMATCH. The TUI label (`tui.ts:1121`), the README quote (L1266), and the dashboard HTML label (`dashboard.ts:641`) all now read `filtered Keys`. Internal symbols (`privacyKeysDetectedTotal`, `getPrivacyKeysDetected`, the `privacyKeysDetected` API field) intentionally kept as-is — not user-visible. |
| Privacy filter `filter_mode = "local"` runs in-process `hash_detect.ts` (L1202-1219) | `src/utils/hash-detect.ts`; `src/utils/privacy-filter.ts` | CORRECT | |
| kompress sidecar defaults (L1237-1245) | `src/utils/kompress.ts:67-82` | CORRECT | All 6 defaults match. |
| Node response compression header normalization (L934-947) | `src/utils/routing.ts:584-589` (`sanitizeUpstreamResponseHeaders`) | CORRECT | Removes `content-encoding` + `content-length`. |

---

## Summary of Actionable Discrepancies

Ranked by impact:

1. **BEHAVIOR_MISMATCH — User-defined sections do not inherit wildcards** (Section 3, L499-505 vs `config-loader.ts:3134`).
   The README's "Section flavors" note claims `[models.nvidia]` and other user-defined sections get `prefix-*` / `*` wildcard matching. The code only checks the three hardcoded categories `['claude','gemini','gpt']` plus the literal `default`. Either fix the code to honour user-defined sections, or fix the README to say only `claude/gemini/gpt/default` support wildcards. The auto-memory note `proxy_config_section_inheritance.md` repeats the same claim and is also stale.

2. **MISSING_IN_README — Two undocumented Tier-2 transform builtins** (Section 2, L1036-1042 vs `request-transform.ts:260,319`).
   `filter_anthropic_beta` and `ensure_tool_config_cache_ttl` are real and implemented but absent from the README's Tier-2 builtins table.

3. **BEHAVIOR_MISMATCH (wording) — `max_tokens_rename` is not a code-level default** (Section 2, L1006-1009 vs `config-loader.ts:523`).
   The phrase "the proxy ships with `max_tokens_rename` wired as a mode-level default" implies a built-in default. In reality it only takes effect when the user's `proxy_config.toml` contains a `[transform_defaults]` block. Reword to "the example config ships with…" or add a code-level default.

4. **MISSING_IN_README — Undocumented endpoints** (Section 1).
   `/v1/responses/input_tokens`, `/v1/responses/compact`, `/config-reload`, `/health`, `/`, `/favicon.ico`, and the dynamic `/http/` + `/https/` routing feature are all unlisted.

5. **MISSING_IN_README — Undocumented env vars** (Section 2).
   `CONVERSATION_MAX_ENTRIES`, `GEMINI_API_VERSION`, `MESSAGES_UPSTREAM_MODE`, `INTERACTIONS_UPSTREAM_MODE`, `GENERATE_CONTENT_UPSTREAM_MODE`, `DEV_NO_KEY`, `IMAGE_ENCODE_TIMEOUT_MS`. Also `JSON_STRINGIFY_METHOD` accepted values (`safe-stable`, `fast-safe`) not listed.

6. ~~**BEHAVIOR_MISMATCH (labeling) — `/v1/messages` + `openai-responses` is indirect, not direct** (Section 4, L343 vs `src/handlers/messages.ts:569,589`).~~
   **RESOLVED (2026-08-10):** README L349 relabeled the cell from "Direct transform" to "Indirect transform via `openai-completions`" with the correct hop sequence (Claude Messages → Chat Completions → Responses `input` → Claude Messages). README L361 definition note widened to cover both Gemini-endpoint indirect paths and the `/v1/messages` → `openai-responses` route. Also corrected the field-name reference in the cell from `max_completion_tokens` to `max_output_tokens` (the field actually set at `messages.ts:594`).

7. ~~**MISSING_IN_README — TUI keybindings incomplete** (Section 5, L253-255 vs `tui.ts:1174`).~~
   **RESOLVED (2026-08-10):** README L253-256 now lists all 9 hotkeys — added `l` (global token limit), `d` (statistics overlay), `p` (tools blocklist overlay), and `Ctrl+U` (dump usage to JSONL now) to the existing `c`/`s`/`t`/`r`/`Ctrl+C` list. Matches the TUI help line at `tui.ts:1174` and handlers at `tui.ts:1011-1044,584,830,1266`.

8. ~~**NAME_MISMATCH — TUI "keys filtered" label** (Section 5, L1227 vs `tui.ts:1121`).~~
   **RESOLVED (2026-08-10):** Renamed the label to `filtered Keys` across all three user-facing surfaces for consistency: TUI rendered label (`src/tui.ts:1121` → `filtered Keys: `), README quotes (L1263 section header, L1266 TUI quote, L1269 dashboard quote), and the web dashboard HTML label (`src/handlers/dashboard.ts:641` → `filtered Keys (total)`). Internal symbols unchanged (`privacyKeysDetectedTotal`, `getPrivacyKeysDetected`, `privacyKeysDetected` API field).

Everything else in the README's endpoint table, config tables, routing rules, composite/fusion/coordinator semantics, token-limit windowing, dashboard API, and sidecar contracts is accurate against the current source.
