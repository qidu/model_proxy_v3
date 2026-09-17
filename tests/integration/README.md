# Test Suite

## Test runner: custom lightweight

This suite uses a **custom lightweight test runner — no Jest/Mocha/Vitest.** Tests are plain async functions exported from `.test.js` files; the runner at `run-integration-tests.js` walks the `tests/integration/` tree, spawns each file as a child `node` process, and aggregates pass/fail counts. Shared helpers live in `tests/integration/utils/`.

Why custom: the suite is integration-heavy (talks to a live proxy over HTTP), needs config isolation (copy `proxy_config.toml` → `test_proxy_config.toml` and clean it up on exit), and does not benefit from Jest/Vitest features (no mocking, no fixtures, no DOM). A bespoke runner keeps the test files dependency-free and trivial to run individually.

## Running All Tests

The single entry point is **`run-integration-tests.js`** at the project root — it spawns the proxy, isolates the config, runs every `*.test.js` under `tests/integration/`, and tears everything down on exit. Use `--all` for a full run; bare `node run-integration-tests.js` only prints help.

```bash
# Start testing proxy server WITH PORT=7777
# NEVER use 'pkill -f "node dist/server.js"' , use 'lsof -ni:7777' to find process id (pid), and use 'kill -p ${pid}`
# DO NOT modify `proxy_config.toml`, modify the testing config at `${TEST_CONFIG}proxy_config.toml`

# Single pass (all suites)
node run-integration-tests.js --all

# With custom proxy URL and API key
PROXY_URL=http://localhost:7777 API_KEY=sk-test node run-integration-tests.js --all
```

### Running a subset by index

Pass one or more comma-separated indices as the first positional argument to run only those suites (by their position in the `suites` array in `run-integration-tests.js`). Useful for fast iteration on a single file without editing source.

```bash
# Run only suites[5]
node run-integration-tests.js 5

# Run suites[0], suites[3], suites[7]
node run-integration-tests.js 0,3,7

# An invalid index prints the full list and exits with code 2
node run-integration-tests.js 99
# [cli] Invalid suite index: "99". Valid range: 0..26
# [cli] Available suites:
#   0: 01_endpoints/messages.test.js
#   1: 01_endpoints/messages_streaming.test.js
#   ...
```

The proxy still spawns, config isolation still applies, and teardown still runs — only the set of suites that get executed is filtered.

### Config Isolation

The runner automatically isolates the proxy config so tests NEVER modify `proxy_config.toml`:

1. At startup, `proxy_config.toml` is **copied** to `test_proxy_config.toml`.
2. `TEST_CONFIG=test_` is passed to the proxy and to all child test processes, directing the proxy to load `test_proxy_config.toml`.
3. Any `PUT /dashboard/api/config` mutations during the run target only the test file.
4. At exit (including Ctrl-C and crashes), `test_proxy_config.toml` is **deleted**.

The proxy is started by the runner itself with `TEST_CONFIG=test_` and `PORT=7777`. You do **not** need to launch it manually — `run-integration-tests.js` does that and pipes its logs to your terminal.

```bash
# Single command — runner spawns the proxy, runs all suites, restores config
node run-integration-tests.js --all
```

## Running Tests Individually

Use the index flag on `run-integration-tests.js` (see [Running a subset by index](#running-a-subset-by-index) above). The runner spawns the proxy, copies `proxy_config.toml` → `test_proxy_config.toml` for isolation, runs the selected suites sequentially, and restores the config on exit — so individual runs get the same lifecycle as the full pass.

```bash
# Just suite 0
node run-integration-tests.js 0

# A handful of suites by index
node run-integration-tests.js 0,7,12

# With custom proxy URL / API key
PROXY_URL=http://localhost:7777 API_KEY=sk-test node run-integration-tests.js 0
```

**Why you can't just `node tests/integration/.../X.test.js`:** the project root `package.json` declares `"type": "module"`, so plain `node` treats `.js` as ESM and the test files (which use `require()`) would throw `ReferenceError: require is not defined`. The runner works around this by copying each test file into a temp directory with a `.test.cjs` extension and rewriting its `require('../utils/...')` paths to absolute temp-dir paths before spawning it — so it only runs correctly when launched through `run-integration-tests.js` (or with a similar `.cjs` copy step).

Environment variables honored by the runner:

| Variable | Default | Description |
|---|---|---|
| `PROXY_URL` | `http://localhost:7777` | Proxy base URL |
| `API_KEY` | `sk-test-key` | Bearer token sent in `Authorization` header |
| `TEST_TIMEOUT` | `30000` | Per-request timeout in milliseconds |

## Structure

| Directory | Description |
|---|---|
| `01_endpoints/` | Core API endpoint tests |
| `02_features/` | Feature-specific tests |
| `03_errors/` | Validation and error handling |
| `04_models/` | Multi-model smoke tests |
| `05_upstream_modes/` | Cross-format/conversion tests |
| `06_integration/` | Multi-component integration |
| `07_dashboard/` | Dashboard API and TUI backend |
| `08_regression/` | Previously fixed bugs and edge cases |
| `09_composite/` | Composite alias behaviors (primary, fallback, share, token_limit) |
| `10_auth/` | Auth header flows (x-api-key, x-goog-api-key, Bearer, config priority) |
| `11_responses/` | Responses API coverage (input_tokens, compact, openai-responses mode, documented limitations) |
| `12_config_validation/` | Config schema validation via PUT /dashboard/api/config |
| `13_fusion/` | Fusion composite alias (parallel fan-out → judge → synthesis) |
| `14_routing/` | Wildcard and catch-all routing priority (exact → prefix-* → bare *) |
| `15_config_parse/` | Config parse / serialize / route-resolution unit tests (no proxy required) |
| `16_security/` | Security-specific tests: SSRF guard, privacy filter, kompress, conversation store, free-tier fan-out bound, prototype-pollution denylist, schedule routing, /v1/chat/completions passthrough validation, reasoning_effort conversion |
| `17_token_counting/` | Token-usage accounting: client-reported usage vs. dashboard per-model stats agree exactly (regression guard for double-counted streams) |
| `utils/` | Shared test helpers |

## Test Files

### 01_endpoints

- `messages.test.js` — POST /v1/messages, system prompts, multi-turn, parameters (temperature, top_p, top_k, stop_sequences), metadata, array content blocks
- `messages_streaming.test.js` — SSE streaming, event types, content deltas, streaming with system/multi-turn
- `interactions.test.js` — POST /v1/interactions, text/object input, multi-turn, system instruction, generation config, streaming, tools, thinking_level
- `generateContent.test.js` — POST /v1beta/models/{model}:generateContent and /v1/models/{model}:generateContent, generation config, safety settings, system instruction, tools, streaming, multi-turn, v1beta/v1 streamGenerateContent (with SSE validation), :countTokens

### 02_features

- `thinking.test.js` — Thinking/reasoning: enabled/disabled, boolean format, adaptive, reasoning_effort, output_config.effort, budget tokens, streaming, output_config.task_budget.total, xhigh effort normalization, OpenAI thinking format, signature_delta events, custom budget_to_effort_* thresholds
- `tool_use.test.js` — Tool/function calling: basic tool use, tool_choice variants (auto/any/none/specific), multiple tools, streaming, round-trip, OpenAI format
- `image_input.test.js` — Image content: base64, URL, text+image, multiple images, PNG, WebP

### 03_errors

- `validation.test.js` — Missing/invalid parameters, authentication, malformed JSON, content-type mismatch, invalid tool definitions, rate limiting, blocked endpoints

### 04_models

- `models.test.js` — DeepSeek, Qwen, MiniMax, Moonshot/Kimi models, thinking models, custom NVIDIA models, composite aliases, multi-endpoint routing, streaming

### 05_upstream_modes

- `upstream_modes.test.js` — Claude/OpenAI/Gemini format conversion, token counting (with thinking), Responses API, embeddings, models list, mode conversion, /v1/responses/input_tokens, /v1/responses/compact, /config-reload, openai-responses mode

### 06_integration

- `integration.test.js` — Config load on startup, sequential stats accumulation, health check, CORS headers, models list, token counting, request timeout, timing stats, error format, streaming/non-streaming coexistence, model_timings field, api_key redaction, Access-Control-* CORS headers, PUT config persistence, /tmp/model_proxy_tokens.log persistence

### 07_dashboard

- `dashboard_api.test.js` — GET/PUT /dashboard/api/config, /stats/models, /stats/agents, /stats/requests, POST /test-model (standard + composite alias), HTML page rendering, auth handling

### 08_regression

- `regression.test.js` — Header write crash on exception (fix 3e05fb7), tool_choice auto (fix fdad843), config schema validation (fix 18a1db8), heatmap structure, malformed JSON, empty content, long system prompts, unicode, rapid requests/rate limiting, OpenAI format system, mixed content blocks, zero max_tokens, all documented model-entry array lengths (1/3/4/5/6) boot clean via dashboard PUT with zero config_errors (TC817 — 5/6-element `transforms`/`max_tokens` drift regression)

### 09_composite

- `composite.test.js` — Composite alias behaviors: basic routing, primary routing, fallback ordering, share-weighted distribution (alias discovered dynamically from live config), token_limit config presence, fallback to default upstream for unresolved targets, all configured aliases smoke test, same-name-as-model, share:0 exclusion, token_limit 413 path (creates a temporary alias with limit:1 via PUT then removes it)

### 10_auth

- `auth_headers.test.js` — Auth header flows: x-api-key for /v1/messages, x-goog-api-key for /v1/interactions and generateContent, Authorization: Bearer, API key priority (config over headers), x-api-key as Bearer for openai-completions upstream, missing auth 401

### 11_responses

- `responses_api.test.js` — Responses API: basic, /v1/responses/input_tokens, /v1/responses/compact, image input handling, developer role, stateful fields dropped, streaming, tool use, stateless usage pattern

### 12_config_validation

- `config_validation.test.js` — Config schema validation via PUT /dashboard/api/config: config_errors shape, non-array model value rejected, non-object composite target rejected, 2-element model array rejected, 4-element model array rejected, non-boolean primary rejected, non-finite share/fallback/total_token_limit rejected, non-object composite target value rejected, empty composite target `{}` accepted, non-object models payload rejected, api_key in models payload rejected, empty composite alias `{}` round-trips (survives parse/serialize — the state right after adding an alias via the TUI before targets are chosen)

### 13_fusion

- `fusion.test.js` — Fusion composite alias: TC1301 alias discovery in dashboard, TC1302 non-streaming response shape (id/content/usage), TC1303 streaming SSE event sequence, TC1304 recursion guard (x-fusion-depth: 1 rejected), TC1305 min_panel enforcement (99 > actual panel size fails), TC1306 config round-trip (fusion_options + role survive PUT/GET), TC1307 no-judge degrade (judge_required: false proceeds to synth), TC1308 expose_metadata field present in non-streaming response

### 14_routing

- `routing.test.js` — Wildcard and catch-all routing priority: TC1401 exact match in models.free beats wildcard, TC1402 exact match in models.default, TC1403 `claude-*` wildcard routes to models.claude, TC1404 `gemini-*` wildcard routes to models.gemini, TC1405 bare `*` catch-all in models.default for unknown models, TC1406 exact key ≠ wildcard (different model names are not interchangeable)

### 15_config_parse

- `config_parse.test.js` — Config parse / serialize / route-resolution unit tests (no proxy required; imports `dist/utils/config-loader.js` directly): TC1501 `"*"={}` catch-all parses and routes unknown model as passthrough, TC1502 `"*"={target="*"}` is equivalent, TC1503 `"claude-*"={}` wildcard routes any `claude-X` model to itself, TC1504 `"claude-*"={target="claude-*"}` is equivalent, TC1505 rename alias (`claude-1-2={target="claude-4-5-haiku"}`) routes to different upstream model, TC1506–TC1508 round-trip (serialize → reparse) preserves all three forms, TC1509–TC1510 empty `{}` and explicit `{target=key}` produce identical parsed entries and routes, TC1519 6-element entry's `max_tokens` (index 5) survives parse → `getModelRouteConfig().maxTokens` (the shape consumed by request building)

### 16_security

- `ssrf_dynamic_route.test.js` — SSRF guard on dynamic routing (`/https/host/path`): TC2001 rejects `evil.example.com` with 403 `"Target host not allowed."`, TC2002 dynamically discovers an allowed host from the live config and confirms a route to it is NOT rejected, TC2003 rejects `/https/onlyonesegment` with 400 `"Invalid dynamic route."`, TC2004 substring-bypass attempt (`api.qnaigc.com.evil.com`) still returns 403 confirming exact/wildcard-suffix host matching is not fooled by dot-contained substrings. Guard is `isHostAllowed` from `src/utils/config-loader.ts` (derived from `[models.*].base_url` / `[upstream].default_base_url`, NOT the `ALLOWED_HOSTS` env var which is never read in `src/`).
- `privacy_filter.test.js` — Privacy filter (`src/utils/privacy-filter.ts`) request-side PII redaction unit tests: TC2101 `getPrivacyFilterConfig` returns `null` when `PRIVACY_FILTER_URL` unset (inert by default), TC2102/2104/2105 rejects public host / malformed URL / non-http(s) protocol, TC2103 accepts localhost and asserts defaults (`timeoutMs:40000`, `maxChars:1024000`), TC2106/2107 `restoreText` sentinel substitution and no-op when absent, TC2108 `redactBody` no-op when no extractable refs, TC2109 live test confirms no sentinel artifacts leak into response (inert environment default), TC2110–2120 round-trip, normalization, and recovery branches for sentinel restoration. Privacy filter is fail-closed by construction (no `fail_open` opt-out), and there is no `endpoints` config (path gating was removed 2026-07-17 since `redactBody` no-ops on bodies without extractable refs). 20 tests total; no live sidecar required for TC2101–2120 (pure dist-import unit tests).
- `kompress.test.js` — Kompress (`src/utils/kompress.ts`) request-side context-compression unit tests: TC2201 `getKompressConfig` returns `null` when `KOMPRESS_URL` unset (inert by default), TC2202 rejects public host, TC2203 accepts localhost and asserts defaults (notably **`failOpen:true`** — opposite of the privacy filter's fail-closed default, since "compression is an optimization, not a correctness boundary" per the source comment, `timeoutMs:40000`, `maxChars:1024000`, `keepRatio:0.5`, `minChars:200`, `maxLength:2048` fixed, default 3-endpoint set **excluding `/v1/interactions`**), TC2204 `KOMPRESS_FAIL_OPEN=false`/`'0'` disables fail-open, TC2205 `shouldCompressPath` matches default endpoints and excludes `/v1/interactions`, TC2206 `isCjkHeavy` classification, TC2207/2208 fail-open vs fail-closed behavior when sidecar unreachable, TC2209/2210 `compressBody` skips short and CJK-heavy fragments, TC2211 `compressBody` no-op when no compressible refs, TC2212 live test confirms inert-by-default wiring doesn't break requests. No live sidecar required for TC2201–2211 (pure dist-import unit tests).
- `conversation_store.test.js` — Conversation store (`src/utils/conversation-store.ts`) unit tests: TC2301/2302 `saveConversation`/`getConversation` round-trip, TC2303/b/c/d all four `normalizeInputToItems` branches (string → user-message item, array passthrough, object → JSON-stringified item, null/undefined → `[]`), TC2304 re-saving same key overwrites (not append), TC2305 `CONVERSATION_MAX_ENTRIES`-driven oldest-first eviction. Note: the `CONVERSATION==='true'||'1'` gate lives in `src/handlers/responses.ts`, not the store itself — that gated-drop path when `CONVERSATION` is unset is already covered by `11_responses/responses_api.test.js` TC1906.
- `free_fanout.test.js` — models.free auth-passthrough / fusion fan-out bound tests: TC2401/2402 live proxy confirms bogus client bearer token succeeds for `models.free` models (`opus48`) but 401s for non-free models — the `api_key` override is scoped to `route.section === 'free'`, not global. TC2403 `resolveFusionPlan` produces deterministic 1:1 panel call count (50 targets → 52 total calls, no multiplication). TC2404 nested alias-as-panel-target is NOT expanded (route resolution only looks in `models.*`, never `composite`). TC2405 self-referential panel target resolves flatly. TC2406 `route.section` is `'free'` only for entries under `[models.free]` in config.
- `config_loader_pollution.test.js` — Config-loader prototype-pollution denylist unit tests: TC2501–2503 `__proto__`/`constructor`/`prototype` rejected as composite alias names, TC2504–2506 same three keys rejected as composite target keys, TC2507–2509 same three keys rejected as models category names, TC2510–2512 same three keys rejected as models entry keys — all via `applyDashboardConfigUpdate` from `dist/utils/config-loader.js` using `JSON.parse`-constructed payloads (matching real HTTP request-body semantics where `JSON.parse` creates genuine own enumerable `"__proto__"` properties, unlike JS object-literal syntax which invokes the setter and produces no own property). TC2513 control payload accepted. TC2514/2515 live `PUT /dashboard/api/config` with raw JSON string bodies cross-validates dist results against the actual HTTP handler.
- `schedule_routing.test.js` — Schedule CRUD & resolution unit tests: TC2601–2605 `addScheduleAlias`/`removeScheduleAlias` basics, TC2606–2612 `upsertScheduleWindow` validation (from===to, from>to, from>24, to>24, empty-array fallback, unknown-target allowlist), TC2613–2615 `removeScheduleTarget`, TC2616–2620 `resolveScheduleTarget` (unknown alias, window match, fallback, no-match-no-fallback, days array), TC2621–2623 `applyDashboardConfigUpdate` schedule preservation/replacement/`__proto__` rejection. TC2628–2630 (live, `PROXY_RUN_LIVE=1`) round-trip the four dashboard schedule routes.
- `dev_pass_through.test.js` — /v1/chat/completions passthrough (always on; formerly gated by DEV_PASS_THROUGH, removed 2026-08) validation unit tests: TC2801–2806 exercise `validateOpenAICompletionsRequest` (`src/utils/validation.ts:439`), the only proxy-owned logic on the `/v1/chat/completions` passthrough path before the plain-`fetch()` forward (`src/index.ts:922-939`). Covers valid request, missing `model`, missing/empty `messages`, invalid role, `max_tokens:0`. Live e2e passthrough isn't tested because it needs a reachable upstream for the forwarded fetch; the served (formerly blocked) path is covered by `03_errors/validation.test.js` TC311.
- `reasoning_effort_conversion.test.js` — Claude `thinking.budget_tokens` → OpenAI `reasoning_effort` conversion unit tests: TC2901–2903 legacy cutoffs (4096→high, 2048→medium, else low) via `budgetToReasoningEffort`, TC2904 `explicit_reasoning_effort` override, TC2905 disabled thinking → no effort, TC2906 undefined → empty, TC2907 custom thresholds, TC2908 `budget_to_effort_high:0` force-high special case, TC2909 adaptive behaves like enabled, TC2910 no-thresholds fallback returns thinking only (no `reasoning_effort`). Exercises `convertClaudeThinkingToOpenAI` and `budgetToReasoningEffort` from `dist/converters/claude-to-openai.js` directly — the functions wired into the live path at `src/handlers/messages.ts:132-134`.
- `openai_responses_routing.test.js` — OpenAI Responses routing/conversion unit tests with `globalThis.fetch` stubbed (no live upstream): TC3001 `/v1/messages` Claude-format → `openai-responses` body (`input`, `max_output_tokens`, no `messages`), TC3002 Chat tools/tool_choice flatten to Responses shape, TC3003 Chat tool-call history → `function_call`/`function_call_output` input items, TC3004 upstream Responses SSE → Claude SSE events, TC3005/TC3006 handler wiring for `max_tokens` → `max_completion_tokens` except `api.qnaigc.com`, TC3007 TUI test requests choose the correct token field by upstream mode.
- `dev_pass_through_responses.test.js` — /v1/chat/completions passthrough (formerly DEV_PASS_THROUGH) + `openai-responses` upstream unit tests with `globalThis.fetch` stubbed: TC3101 `handleChatCompletionsPassthrough` with `upstreamMode='openai-responses'` converts the completions body to Responses format (`input` array, `max_output_tokens`, no `messages`) and forwards to the model-specific Azure URL; TC3102 `upstreamMode='openai-completions'` still forwards the body as-is (no conversion, `messages` preserved); TC3103 `completionsToResponsesBody` extracts `system` message to `instructions` and excludes it from `input`; TC3104 `completionsToResponsesBody` flattens `tools[].function` to top-level `name`/`description`/`parameters` (Responses tool shape). Exercises the path fixed by the per-model routing bug where `/v1/chat/completions` passthrough was ignoring per-model `base_url`/`api_key`/`mode` from `[models.free]` and always using `[models.default]`.

### 17_token_counting

- `token_counting.test.js` — Live token-accounting tests. Each test takes the sum of `total_tokens` across all rows of `GET /dashboard/api/stats/models` before and after one request, and asserts the delta equals the usage the client was told about — exactly once, so a 2× delta fails. TC4101 non-streaming `/v1/messages`, TC4102 streaming `/v1/messages` against an `anthropic-messages` model (the regression guard for the duplicate recorder that lived in `src/handlers/claude.ts`), TC4103/TC4104 streaming and non-streaming `/v1/chat/completions` (covers the force-injected `stream_options.include_usage` final chunk), TC4105 `:streamGenerateContent?alt=sse` (the `usageMetadata` frame shape). Models are discovered from the live config by upstream mode; a test whose model or endpoint is unavailable prints `(skipped: ...)`.

## Prerequisites

Tests run against a live proxy instance. The proxy must be started beforehand with all required upstream API keys and features configured.

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PROXY_URL` | `http://localhost:7777` | Proxy base URL |
| `API_KEY` | `sk-test-key` | Bearer token sent in `Authorization` header |
| `TEST_TIMEOUT` | `30000` | Per-request timeout in milliseconds |
| `TEST_CONFIG` | _(set by runner)_ | Config file prefix; proxy loads `./${TEST_CONFIG}proxy_config.toml`. Set to `test_` by the runners automatically. |

### Per-Suite Requirements

#### `01_endpoints`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `messages.test.js` | `POST /v1/messages` | `deepseek/deepseek-v3.2`, `qwen3-32b` | Claude-format request/response, system prompts, temperature/top_p/top_k, stop_sequences, metadata |
| `messages_streaming.test.js` | `POST /v1/messages` (stream: true) | `deepseek/deepseek-v3.2`, `qwen3-32b` | SSE events (`message_start`, `content_block_delta`, `message_stop`) |
| `interactions.test.js` | `POST /v1/interactions` | `gemini-2.5-flash` | Gemini-format input, system_instruction, generation_config, tools, thinking_level, streaming |
| `generateContent.test.js` | `POST /v1beta/models/{model}:generateContent`, `POST /v1/models/{model}:generateContent`, streaming variant | `gemini-2.5-flash` | Gemini generateContent format, safety_settings, tools, multi-turn |

#### `02_features`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `thinking.test.js` | `POST /v1/messages` | `deepseek-r1`, `deepseek/deepseek-v3.2` | thinking.type (enabled/disabled/adaptive), boolean format, reasoning_effort, output_config.effort, budget_tokens, streaming |
| `tool_use.test.js` | `POST /v1/messages` | `deepseek/deepseek-v3.2`, `qwen3-32b` | All tool_choice variants (auto/any/tool/none), multiple tools, tool result round-trip, OpenAI-format tools, streaming |
| `image_input.test.js` | `POST /v1/messages` | `qwen3-32b` (vision-capable) | Image content blocks (base64 + URL), JPEG/PNG/WebP media types, multiple images |

#### `03_errors`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `validation.test.js` | `POST /v1/messages`, `POST /v1/chat/completions` (must return 4xx) | `deepseek/deepseek-v3.2` | Validation errors (missing model, empty messages, etc.), missing auth → 401, malformed JSON → 400, rate limiting |

#### `04_models`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `models.test.js` | `POST /v1/messages`, `POST /v1/interactions`, `POST /v1beta/models/{model}:generateContent` | `deepseek/deepseek-v3.2`, `deepseek-r1`, `qwen3-32b`, `qwen-max-2025-01-25`, `minimax/minimax-m2.1`, `minimax/minimax-m2.5`, `moonshotai/kimi-k2.5`, `moonshotai/kimi-k2-0905`, `nvidia/nemotron-3-ultra-550b-a55b`, `nvidia/nemotron-3-super-120b-a12b`, `deepseek/deepseek-v3.2-exp-thinking`, composite alias `code-small` | Upstream API keys for **DeepSeek, Qwen, MiniMax, Moonshot, NVIDIA** providers; composite aliases; multi-endpoint routing |

#### `05_upstream_modes`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `upstream_modes.test.js` | `POST /v1/messages`, `POST /v1/interactions`, `POST /v1/messages/count_tokens`, `POST /v1/responses`, `POST /v1/embeddings`, `GET /v1/models` | `deepseek/deepseek-v3.2`, `deepseek-r1`, `gemini-2.5-flash`, `qwen/qwen3-embedding-4b` | Token counting (with thinking), format conversion (Claude/OpenAI/Gemini), models list, embeddings, Responses API |

#### `06_integration`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `integration.test.js` | `GET /dashboard/api/config`, `GET /dashboard/api/stats/models`, `GET /dashboard/api/stats/requests`, `POST /v1/messages`, `GET /v1/models`, `POST /v1/messages/count_tokens` | `deepseek/deepseek-v3.2`, `qwen3-32b` | Stats accumulation, CORS headers, health check, client-side timeout handling, error format consistency |

#### `07_dashboard`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `dashboard_api.test.js` | `GET/PUT /dashboard/api/config`, `GET /dashboard/api/stats/models`, `GET /dashboard/api/stats/agents`, `GET /dashboard/api/stats/requests`, `POST /dashboard/api/test-model`, `GET /dashboard` | `deepseek/deepseek-v3.2`, any configured composite alias | Dashboard config read/write, stats endpoints, real upstream test-model, HTML page rendering, auth validation |

#### `08_regression`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `regression.test.js` | `POST /v1/messages` (non-streaming + streaming), `GET /dashboard/api/config`, `GET /dashboard/api/stats/requests` | `deepseek/deepseek-v3.2`, `qwen3-32b` | Header-write crash guard, tool_choice auto/any, config validation schema, heatmap/request stats structure, malformed JSON, empty content, unicode, rapid requests, OpenAI system format, mixed content blocks, zero max_tokens |

#### `09_composite`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `composite.test.js` | `POST /v1/messages`, `GET /dashboard/api/config`, `PUT /dashboard/api/config` | Any configured composite aliases (discovered dynamically from live config) | Composite alias routing (primary, fallback, share, token_limit, fallback to default upstream); TC1110 temporarily creates a low-limit alias via PUT and cleans it up |

#### `10_auth`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `auth_headers.test.js` | `POST /v1/messages`, `POST /v1/interactions`, `POST /v1beta/models/{model}:generateContent`, `POST /v1/responses`, `POST /v1/embeddings` | any configured model | x-api-key, x-goog-api-key, Authorization: Bearer, config API key priority |

#### `11_responses`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `responses_api.test.js` | `POST /v1/responses`, `POST /v1/responses/input_tokens`, `POST /v1/responses/compact` | `gpt-5.4-mini` (or any configured model) | Responses API basic, input_tokens, compact, image input handling, developer role, stateful fields silently dropped, streaming, tool use, stateless usage pattern |

#### `12_config_validation`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `config_validation.test.js` | `GET /dashboard/api/config`, `PUT /dashboard/api/config` | none (validation is purely schema-level, no upstream calls) | Dashboard config read/write, config schema validation (array length, field types, api_key rejection) |

#### `13_fusion`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `fusion.test.js` | `POST /v1/messages` (stream + non-stream), `GET /dashboard/api/config`, `PUT /dashboard/api/config` | `max-m3`, `max-m2.7-high` (or any two models available via the default upstream) | Fusion composite alias routing (fan-out, judge, synthesis), `fusion_options` config round-trip, recursion guard, `expose_metadata`, streaming SSE |

#### `15_config_parse`

| File | Endpoints | Models Required | Features Required |
|---|---|---|---|
| `config_parse.test.js` | none (unit tests; no proxy required) | none | `dist/utils/config-loader.js` must be built (`npm run build`) |

### Provider API Keys Required

The proxy configuration must have upstream API keys for all of the following providers (tests will 401/500 without them):

- **DeepSeek** — used by messages, thinking, tool_use, models, upstream_modes, integration, regression, auth, responses suites
- **Qwen (Alibaba)** — used by messages, streaming, tool_use, image_input, models, regression suites
- **MiniMax** — used by models suite (or minimax-m3 in active config for composite)
- **Moonshot/Kimi** — used by models suite (or kimi-2.7 in active config for composite)
- **Gemini (Google)** — used by interactions, generateContent, upstream_modes suites
- **NVIDIA** — used by models suite

### Proxy Features That Must Be Enabled

- Auth/API key validation (Bearer token on all endpoints)
- SSE streaming on `/v1/messages`
- Tool/function calling with all `tool_choice` variants (auto, any, tool, none)
- Thinking/reasoning parameter support (Claude-style and OpenAI-compatible formats)
- Image content blocks (base64 and URL sources)
- Multi-format conversion (Claude ↔ OpenAI ↔ Gemini)
- Stats accumulation (model-level, agent-level, request-level, timing data)
- Dashboard config read/write
- Composite/alias model routing
- Rate limiting (or graceful handling of rapid requests)
- CORS headers
- Token counting endpoint (`/v1/messages/count_tokens`)
- Embeddings endpoint (`/v1/embeddings`)
- Responses API endpoint (`/v1/responses`)
- `POST /v1/chat/completions` explicitly blocked (returns 4xx error)
- Graceful error handling (no crash on invalid input, header-write-after-exception guard)

## Utilities (`utils/`)

- `test_helpers.js` — `sendRequest`, `sendStreamingRequest`, `assert`, `assertResponse`, `assertStreamingResponse`, `runTest`, `runTestSuite`, `testModelEndpoints`, `sleep`
- `model_config.js` — Model registries by provider (DeepSeek, Qwen, MiniMax, Moonshot, GLM, Gemini, NVIDIA), thinking models, tool-capable models, composite aliases, priority tiers

## Notes

- Tests hit `localhost:7777` by default (configurable via `PROXY_URL`)
- Tests are sequential — no parallelization or test isolation
- Some tests accept both 200 and >=400 as valid (graceful degradation)
- Composite tests discover aliases dynamically from the live config; no alias names are hard-coded
- Config-mutating tests (09_composite TC1110, 12_config_validation) restore original state after each test case
- TUI interactive features are tested via the dashboard API they call; interactive TTY testing requires manual testing or a terminal automation tool

## Coverage Summary

31 test files, ~380 test functions across 16 numbered suites. Most suites are **HTTP integration** (they talk to a live proxy on `localhost:7777`); a subset load `dist/` modules **in-process** and need no running proxy.

### HTTP integration vs. in-process

| Mode | Suites |
|---|---|
| **HTTP integration** (live proxy required) | `01_endpoints`, `02_features`, `03_errors`, `04_models`, `05_upstream_modes`, `06_integration`, `07_dashboard`, `08_regression`, `09_composite`, `10_auth`, `11_responses`, `12_config_validation`, `13_fusion`, `14_routing`, `16_security` (most files) |
| **In-process** (`dist/`-import, no proxy) | `15_config_parse`, `16_security/conversation_store`, `16_security/dev_pass_through_responses`, `16_security/openai_responses_routing`, `16_security/reasoning_effort_conversion` |

The in-process subset is CI-friendly: it only needs `npm run build` and stubs `globalThis.fetch` where an upstream call would otherwise happen. The HTTP suites require the proxy plus real upstream provider keys (see [Provider API Keys Required](#provider-api-keys-required)).

### Source surface exercised by the suites

| Source area | Primary suites |
|---|---|
| `handlers/messages.ts`, `claude.ts` (Claude Messages path) | `01_endpoints/messages`, `01_endpoints/messages_streaming`, `02_features/*`, `08_regression`, `16_security/openai_responses_routing` |
| `handlers/gemini.ts` (Interactions + generateContent) | `01_endpoints/interactions`, `01_endpoints/generateContent` |
| `handlers/openai.ts`, `chat-completions.ts` | `05_upstream_modes`, `16_security/dev_pass_through`, `16_security/dev_pass_through_responses` |
| `handlers/responses.ts` (Responses API) | `11_responses`, `16_security/dev_pass_through_responses` |
| `handlers/models.ts`, `embeddings.ts`, `token-counting.ts`, `dashboard.ts` | `04_models`, `05_upstream_modes`, `07_dashboard` |
| `utils/config-loader.ts` (parse, serialize, routing, schedules, prototype-pollution denylist) | `14_routing`, `15_config_parse`, `12_config_validation`, `16_security/config_loader_pollution`, `16_security/schedule_routing` |
| `utils/validation.ts` | `03_errors/validation`, `16_security/dev_pass_through` |
| `utils/privacy-filter.ts`, `kompress.ts` | `16_security/privacy_filter`, `16_security/kompress` |
| `utils/conversation-store.ts` | `16_security/conversation_store` (+ `11_responses` for the gated-drop path) |
| `utils/hash-detect.ts` (SSRF guard surface) | `16_security/ssrf_dynamic_route` |
| `utils/coordinator.ts` (fusion planning) | `13_fusion`, `16_security/free_fanout` |
| Converters (`claude-to-openai`, `gemini-*`, `responses↔completions`) | indirect via `01_endpoints`, `05_upstream_modes`, `16_security/reasoning_effort_conversion`; field-level coverage lives in `tests/unit/` |

### Relationship to `tests/unit/`

The unit suite (`tests/unit/*.test.ts`, see `tests/README.md`) provides field-level coverage of the converters, transform engine, config parser, error classes, and token accounting — the parts that HTTP integration tests can't pin precisely because they round-trip through a live upstream. The two suites are complementary: `tests/unit/` for exact shape correctness, `tests/integration/` for end-to-end wiring and behavioral regressions. Modules with **no** direct unit coverage (UI-bound `tui.ts`/`heatmap.ts`, IO-bound `logger.ts`/`fetch-timeout.ts`) are exercised here only implicitly through HTTP paths.

## Logs

- Record testing results in file `test_results_at_<date>-<time>.md` to directory `./tests/logs/results/`.
