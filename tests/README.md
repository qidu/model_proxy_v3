# Tests

## Test order

Run tests in this order — each tier catches different classes of bugs:

### 1. Unit tests — `tests/unit/*.test.ts`

Fast, no proxy required. Covers the transform engine, config parsing, routing logic, and converters.

```bash
npm run test:unit           # runs tsx --test tests/unit/**/*.test.ts
```

> **⚠️ Warning: test cross-function contracts, not just each function in isolation.**
> When two functions must accept the same shapes (e.g. the config parser produces model-entry arrays and `validateProxyConfig` must accept every array the parser or serializer can emit), unit tests that pin each function separately will pass while the real pipeline is broken. Real incident (2026-08): the parser/serializer/roundtrip tests all covered the 6-element model entry (per-entry `max_tokens` at index 5), but `validateProxyConfig` tests only exercised lengths 1/2/3 — so any config using `max_tokens` failed at proxy startup with `must be [target] ... (got 6 elements)` while the whole unit suite was green. When you add a new config shape: update the parser, the serializer, **and** the validator together, and add a test that feeds the parsed/serialized output into `validateProxyConfig` (or whichever function consumes it next in the pipeline).
>
> **Guards now in place for this incident class** (each layer catches a different drift direction):
>
> | Guard | Where | Catches |
> |---|---|---|
> | `validateProxyConfig` length tests (1/3/4/5/6, `max_tokens` number / digit-string / non-numeric) | `tests/unit/config-loader.test.ts` | parser↔validator shape drift |
> | TC817 — PUT a category using all 6 documented array lengths, assert zero `config_errors` | `tests/integration/08_regression/regression.test.js` | any startup/dashboard-save-breaking divergence, whichever function drifted (this test independently rediscovered a second drift site, `isSafeModelArray` on the dashboard PUT path) |
> | TC1519 — 6-element entry's `max_tokens` survives parse → `getModelRouteConfig().maxTokens` | `tests/integration/15_config_parse/config_parse.test.js` | shape valid but value lost between parse and route resolution |

#### Unit test coverage map

36 files, 995 test cases. Every test imports `./src` directly (no HTTP). The table maps each source module to the unit tests that exercise it; "via handler" marks modules covered only through `index.ts`/handler entry points rather than a dedicated unit test.

| Source module | Direct unit coverage |
|---|---|
| `converters/claude-to-openai.ts` | `claude-to-openai` (schema cleaning, message/tool/tool_choice mapping, thinking→`reasoning_effort` thresholds, streaming usage flag, token-counting variant), `thinking-roundtrip`, `token-usage` |
| `converters/streaming.ts` | `streaming` (OpenAI→Claude SSE: lifecycle framing, text/tool/thinking deltas, split tool-arg stitching, stop_reason mapping, upstream+cache usage capture, unexpected-end flush), `token-usage` |
| `converters/gemini-streaming.ts` | `token-usage`, `chat-completions-gemini-streaming` (via handler) |
| `converters/openai-to-claude.ts` | `openai-to-claude` (usage extraction standard/QNAIGC/cache, `<think>` + `reasoning_content` blocks, tool_calls, stop_reason fixups, synthetic signature, models/token-count converters), `token-usage` |
| `converters/gemini-to-claude.ts` | `gemini-to-claude` (response + generateContent shapes, stop-reason mapping, citations, image/tool/thinking blocks) |
| `converters/claude-to-gemini.ts` | `claude-to-gemini` (role mapping, text/image blocks, system_instruction, generation_config, cached_content) |
| `converters/openai-to-gemini.ts` | `openai-to-gemini` (text/tool_calls/thinking/reasoning_content, schema-aware arg coercion, empty-chunk handling) |
| `converters/completions-to-responses.ts` | `responses-completions-roundtrip` (text/tool_calls/reasoning, compacted shape) |
| `converters/responses-to-completions.ts` | `responses-completions-roundtrip` (input→messages, tool format flattening, tool_choice mapping, reasoning threading) |
| `utils/request-transform.ts` | `request-transform` (hook plumbing, ops, builtins incl. `filter_anthropic_beta`) |
| `utils/config-loader.ts` | `transforms-config`, `coordinator`, `request-transform`, `config-loader` (incl. `validateProxyConfig` model-entry lengths 1/3/4/5/6 with `max_tokens` number/digit-string/non-numeric), plus in-process `tests/integration/15_config_parse` and `16_security/config_loader_pollution` |
| `utils/coordinator.ts` | `coordinator` |
| `utils/routing.ts` | `routing` (`buildUpstreamUrl`) |
| `utils/token-counting.ts` | `token-counting` (estimation overhead/whitespace, tiktoken exact counts + fallback, message/system/block counting for every block type, `countClaudeRequestTokens`, env config, tokenizer caching — feeds usage accounting and 413 limits), `token-usage` |
| `utils/dashboard-stats.ts` | `dashboard-stats` (token-limit windowing: `parseWindowSpec` sliding `Nh`/`Nd` vs calendar `1w`/`1m`, `getWindowCutoff`; composite alias token-limit event log, pruning), `token-usage` (usage-tracking stream) |
| `utils/model-usage-recorder.ts` | `token-usage` |
| `utils/conversation-store.ts` | `responses-conversation-state` (threads, stored response objects, retrieval, stateful `handleAsCompletions` + GET routing under `CONVERSATION_STATE=true`, mocked upstream), plus `tests/integration/16_security/conversation_store` (dist-import basics) |
| `utils/errors.ts` | `errors` (all 7 error classes, transport classification, validation helpers) |
| `utils/stringify.ts` | `stringify` |
| `utils/thinking.ts` | `thinking` (OpenAI↔Claude + boolean/string normalization, budget validate/adjust/estimate, merge, token-counting validation) |
| `utils/beta-features.ts` | `beta-features` (header parse/validate — unknown-feature drop, invalid-JSON→null, `hasBetaFeature`/`createBetaHeader` round-trip) |
| `utils/validation.ts` | `validation` |
| `utils/hash-detect.ts` | `hash-detect` |
| `utils/privacy-filter.ts` | `privacy-filter` (config precedence + sidecar URL/SSRF validation, local hash redaction with sentinel dedup, block-type skipping incl. Gemini `inlineData`, maxChars guard, fail-closed sidecar paths, `restoreText`, streaming split-sentinel restore) |
| `utils/kompress.ts` | `kompress` (config defaults/validation, endpoint-path matching, CJK detection, selective fragment compression — user/tool text + tool descriptions only, minChars/maxChars guards, fail-open vs fail-closed, saved-chars accounting) |
| `utils/tool-blocklist.ts` | `tests/infra/tool-blocklist.ts` (`eraseBlockedTools`) |
| `utils/sdk-handler.ts` | `sdk-handler` (`isSdkUrl` scheme recognition only; the two `sdk://` stubs reject with `ClaudeProxyError` 501 `not_implemented`) |
| `handlers/messages.ts`, `responses.ts`, `openai.ts` | via handler + `auth-with-model`, `responses-gemini-url`, `openai-gemini-role-default`, `think-tag-extraction` |
| `handlers/gemini.ts`, `chat-completions.ts`, `claude.ts`, `models.ts`, `embeddings.ts`, `dashboard.ts`, `token-counting.ts` | integration only (`tests/integration/`) |
| `index.ts` (handler entry) | `auth-with-model`, `routing`, `responses-gemini-url`, `think-tag-extraction`, `openai-gemini-role-default` |
| `tui.ts`, `heatmap.ts`, `utils/logger.ts`, `utils/fetch-timeout.ts` | not unit-tested (UI / IO-bound; low unit-test value) |

### 2. Integration / coverage testcases — `tests/integration/` via `run-integration-tests.js`

Scenario-level tests that spin up an isolated proxy process per suite. Run from the project root.

Note: some suites (`15_config_parse`, most of `16_security` in `integration`) are dist-import in-process tests with no live proxy — they stay here rather than in `tests/unit/` because they verify the **built** `dist/` output (catching tsc/emit drift that src-importing unit tests cannot) and share the `run-integration-tests.js` suite registration; several also mix in live-proxy tests that cross-validate the same invariants over HTTP.

```bash
node run-integration-tests.js           # show help
node run-integration-tests.js --list    # list all suites
node run-integration-tests.js --all     # run every suite
node run-integration-tests.js 5         # run suite index 5 only
node run-integration-tests.js 0,3       # run suites 0 and 3
```


### 3. Multi-agent SDK tests — `tests/multi-agents-test.ts` / `.py`

End-to-end: real agent SDKs talking to a running proxy. Requires the proxy to be started first.

```bash
# Start proxy (separate terminal)
PORT=7777 DEV_NO_KEY=true npx tsx src/index.ts

# TypeScript agents (Codex / Claude / Gemini / Pi / OpenCode)
npx tsx tests/multi-agents-test.ts              # list models, agents, tasks
npx tsx tests/multi-agents-test.ts --all        # run all
npx tsx tests/multi-agents-test.ts 0 2 1        # all models, Claude agent, first task

# Python agents (.venv → Antigravity + LangGraph; .venv-crewai → CrewAI)
.venv/bin/python tests/multi-agents-test.py              # list
.venv/bin/python tests/multi-agents-test.py --all        # run all
.venv-crewai/bin/python tests/multi-agents-test.py --all # CrewAI only (Python ≤ 3.13)
```

### 4. OpenRouter free-model smoke test — `tests/models/openrouter-free-tests.js`

Standalone script: fetches OpenRouter's live model list, filters for free models matching this proxy's testing criteria, generates a `[models.FREE]` + composite config, spawns its own local proxy instance, and smoke-tests every model plus the `free-model`/`free-model-fusion`/`free-model-coordinator` composite aliases. Requires `tests/models/openrouter-api-key.txt` (gitignored — `api_key`/`base_url`/`model_list` lines) with a valid, budget-limited OpenRouter key. Falls back to the local `tests/models/or-free-models-examples.json` fixture if the live fetch fails or matches zero models.

```bash
npx tsx tests/models/openrouter-free-tests.js
```

> Run via `tsx`, not `node` — the script imports directly from `src/utils/config-loader.ts` (TypeScript source, no compiled `.js` sibling unless you `npm run build` first).


---

## Multi-Agent SDK Test

### `multi-agents-test.ts`

Runs five agent SDKs against the local proxy (`127.0.0.1:7777` by default, override with `PROXY_BASE`).

Agent order (used by the CLI `agent` selector):

| # | Agent   | SDK package                          | Transport                       |
|---|---------|--------------------------------------|---------------------------------|
| 1 | Codex   | `@openai/codex-sdk`                  | OpenAI Responses (`/v1/responses`) via `~/.codex/config.toml` |
| 2 | Claude  | `@anthropic-ai/claude-agent-sdk`     | Anthropic Messages (`/v1/messages`) via `ANTHROPIC_BASE_URL` |
| 3 | Gemini  | `@google/genai`                      | Gemini (`/v1beta/...`) via `httpOptions.baseUrl` |
| 4 | Pi      | `@earendil-works/pi-agent-core`      | Anthropic Messages (`/v1/messages`) via `createProvider` |
| 5 | OpenCode| `@opencode-ai/sdk`                   | OpenAI-compatible (`/v1`) via `OPENCODE_CONFIG_CONTENT` → spawns `opencode serve` |

The full run is `len(USER_TASKS) * len(MODELS) * 5` = 8 × 9 × 5 = 360 invocations (modulated by the CLI selection below).

#### Environment Variables

`API_KEY` (or any one of the agent-specific keys below) is required for the agent to authenticate against the proxy. The key is the value the proxy itself accepts and forwards to its upstream — supply a key that is valid for the upstream provider you are targeting.

| Variable             | Used by agent | Notes |
|----------------------|---------------|-------|
| `API_KEY`            | all           | Fallback if a per-agent key is not set. |
| `CODEX_API_KEY`      | Codex         | Codex reads this via `~/.codex/config.toml` (`env_key = "CODEX_API_KEY"`). |
| `ANTHROPIC_API_KEY`  | Claude, Pi    | Claude passes it via `env.ANTHROPIC_API_KEY`; Pi's `envApiKeyAuth` falls back to it after `PI_API_KEY`. |
| `GEMINI_API_KEY`     | Gemini        | Passed to `GoogleGenAI({ apiKey })`. |
| `PI_API_KEY`         | Pi            | First preference for `envApiKeyAuth`; if unset, `ANTHROPIC_API_KEY` / `API_KEY` are tried in order. |
| `OPENCODE_API_KEY`   | OpenCode      | Injected into `OPENCODE_CONFIG_CONTENT` and read by the spawned `opencode serve`. |
| `PROXY_BASE`         | all           | Override the proxy origin (default `http://127.0.0.1:7777`). |

If you only want to exercise one agent, set just its key. Other agents will be skipped because their SDK constructors will fail.

#### Usage

```bash
# Start the proxy first (it must listen on PROXY_BASE; default 127.0.0.1:7777)
npm run dev

# Set at least one key (or API_KEY for all agents)
export API_KEY="sk-a-valid-key"
# export CODEX_API_KEY="$API_KEY"
# export ANTHROPIC_API_KEY="$API_KEY"
# export GEMINI_API_KEY="$API_KEY"
# export PI_API_KEY="$API_KEY"
# export OPENCODE_API_KEY="$API_KEY"

# No args — list available models, agents, and tasks; do not run
npx tsx tests/multi-agents-test.ts

# Run the full sweep
npx tsx tests/multi-agents-test.ts --all     # or -a / --run / -r

# Pick a subset: M A T (model, agent, task — 1-based, wraps with %; 0 = all in that dimension)
npx tsx tests/multi-agents-test.ts 1 1 1     # first model, first agent, first task
npx tsx tests/multi-agents-test.ts 9 4 0     # 9th model (wraps), Pi agent, all tasks
npx tsx tests/multi-agents-test.ts 0 4 0     # all models, Pi agent, all tasks
```

By default all 5 agents are enabled. To run a subset, comment the `runXxxAgent(task, model);` lines in `main()` for the agents you want to skip.

#### Per-agent notes

**Codex** — Writes `~/.codex/config.toml` with `base_url = ${PROXY_BASE}/v1` and `wire_api = "responses"`, then runs the prompt through `Codex().startThread(...).run(prompt)`. The proxy serves `/v1/chat/completions` (Codex's fallback) unconditionally.

**Claude** — Uses `claudeQuery()` with `allowedTools: ["Glob", "Read"]` and `maxTurns: 30`. `ANTHROPIC_BASE_URL` is set to the proxy origin (Claude SDK appends `/v1/messages`).

**Gemini** — A custom 20-turn tool-calling loop using `GoogleGenAI` with two `functionDeclarations` (`Glob`, `Read`) that call back into the shared `toolGlobSync` / `toolRead` helpers. Tools execute synchronously in the test process; results are appended as `functionResponse` parts.

**Pi (`@earendil-works/pi-agent-core`)** — Three subtleties:

1. The proxy only accepts `/v1/messages` for arbitrary models, so Pi is wired through `anthropicMessagesApi()` regardless of the underlying provider. A static model catalog is built from `MODELS` at startup (one entry per id, all routed through `provider: "anthropic"`).
2. Pi's anthropic client appends `/v1/messages` to `baseUrl` internally, so the provider's `baseUrl` must be the proxy origin **without** the `/v1` suffix — otherwise the request hits `/v1/v1/messages` and 404s.
3. `provider.auth` must be wrapped in an envelope (`{ apiKey: envApiKeyAuth(...) }`), not passed as the bare auth object — Pi looks for `auth.apiKey` and silently produces `"Provider is not configured"` if the envelope is missing. The `getApiKey` hook on the `Agent` also bypasses Pi's on-disk credential store (`~/.pi/agent/auth.json`) so a stale OAuth credential for another provider cannot shadow the env-supplied key.

**OpenCode (`@opencode-ai/sdk`)** — Three subtleties:

1. OpenCode's SDK does not speak to a provider directly — `createOpencode()` spawns `opencode serve`, which then forwards requests. Provider config is injected via `OPENCODE_CONFIG_CONTENT`; `baseURL` is `${PROXY_BASE}/v1`.
2. The `opencode` binary must be on `PATH` (not always installed alongside the SDK). The runner pre-checks `PATH` and logs `[OpenCode] 'opencode' binary not found on PATH — skipping. Install with: npm i -g opencode-ai` rather than timing out on the 5-second server-start wait. Install with `npm i -g opencode-ai` if you want this agent enabled.
3. Write-capable tools (`bash`, `edit`, `write`) are disabled in the session body so behavior stays read-only and comparable to the other workers; `read`, `grep`, `glob` are kept on.

#### OpenCode — example config & key requirements

A reference `~/.config/opencode/opencode.jsonc` for this proxy looks like:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "proxyv3": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "proxyv3",
      "options": {
        "baseURL": "http://localhost:7777/v1",
        "apiKey": "{env:API_KEY}",
        "headers": {
          "Authorization": "Bearer {env:API_KEY}"
        }
      },
      "models": {
        "minimax-m3": { "name": "minimax-m3" },
      }
    }
  },
  "model": "proxyv3/minimax-m3"
}
```

The two provider packages OpenCode can load — `@ai-sdk/anthropic` and `@ai-sdk/openai-compatible` — end up at different proxy endpoints with very different key requirements:

- **`@ai-sdk/anthropic`** → `/v1/messages`. The proxy's Anthropic Messages handler is open for the local test runner; any non-empty key is accepted (e.g. `API_KEY=sk-hi`). Use this when you just want to point OpenCode at the proxy and exercise the model catalog.
- **`@ai-sdk/openai-compatible`** → `/v1/chat/completions`. This path is served directly by the proxy. The proxy forwards the raw `Authorization: Bearer <key>` header to the upstream provider, so the key must be valid for the upstream you target (e.g. the dedicated `sk-cp-…` key for `minimax-m3`). A key that works for `/v1/messages` will be rejected with `401` here.
- In both cases the `options.apiKey` is what AI SDK uses to authenticate; the `options.headers.Authorization` entry is OpenCode's documented way to also stamp an explicit `Authorization: Bearer …` on the outgoing request and is required when the upstream does not infer auth from the URL.
- `promptCacheKey` is added by default by `@ai-sdk/openai-compatible`; some proxies/upstreams reject it. For `openai-compatible` on this proxy you can either add `options.setCacheKey = false` or set the header explicitly via the `headers` block above.

#### Result reference

For a sample run (1 model × all agents × all tasks), see `./logs/results/test_result_of_deepseek_v4_flash_all_agents_all_tasks.md`.

### `multi-agents-test.py`

Python counterpart of `multi-agents-test.ts`. Runs three Python-native agent SDKs against the same local proxy, exercising the same `MODELS` list and `USER_TASKS` set with the same CLI selection semantics.

Agent order (used by the CLI `agent` selector):

| # | Agent        | SDK package                                                                 | Transport                                                                                  |
|---|--------------|-----------------------------------------------------------------------------|--------------------------------------------------------------------------------------------|
| 1 | Antigravity  | `google-antigravity` (imports `Agent`, `LocalOpenAIAgentConfig` from `google.antigravity`) | OpenAI-compatible (`/v1/chat/completions`). `LocalOpenAIAgentConfig(base_url=PROXY_BASE, …)`; the SDK appends the route. |
| 2 | LangGraph    | `langgraph` (`create_react_agent`) + `langchain-openai` (`ChatOpenAI`)      | OpenAI-compatible (`/v1/chat/completions`). `ChatOpenAI(base_url={PROXY_BASE}/v1, …)`.     |
| 3 | CrewAI       | `crewai` (`Agent`, `Crew`, `Task`, `LLM`) + `pydantic` (`BaseTool` schemas) | OpenAI-compatible (`/v1/chat/completions`). `LLM(model="openai/<id>", base_url={PROXY_BASE}/v1, …)`. |

The full run is `len(USER_TASKS) * len(MODELS) * 3` = 8 × 10 × 3 = 240 invocations (modulated by the CLI selection below).

#### Prerequisites

The test suite mixes Python 3.13 and 3.14 packages that cannot share one venv. CrewAI 1.x declares `requires-python = ">=3.10, <3.14"` and transitively pulls in `tiktoken` whose `pyo3 0.20.3` build pin fails on Python 3.14. LangGraph / LangChain 1.x, on the other hand, work fine on 3.14. Use two venvs:

```bash
# Main stack — Python 3.14 (system or brew). Holds Antigravity + LangGraph.
python3 -m venv .venv
source .venv/bin/activate
pip install google-antigravity langgraph langchain langchain-openai langchain-core

# CrewAI only — must be Python 3.13 (no 3.14-compatible wheels).
python3.13 -m venv .venv-crewai
source .venv-crewai/bin/activate
pip install crewai pydantic
```

To run CrewAI:

```bash
.venv-crewai/bin/python tests/multi-agents-test.py --all          # all models × tasks
.venv-crewai/bin/python tests/multi-agents-test.py 1 3 1          # model 1, agent 3 (CrewAI), task 1
```

To run Antigravity or LangGraph, use the main venv:

```bash
.venv/bin/python tests/multi-agents-test.py --all                 # all models × tasks
.venv/bin/python tests/multi-agents-test.py 1 1 1                 # model 1, agent 1 (Antigravity), task 1
.venv/bin/python tests/multi-agents-test.py 1 2 1                 # model 1, agent 2 (LangGraph),  task 1
```

If you don't need CrewAI, a single `.venv` (3.13 or 3.14) with `pip install google-antigravity langgraph langchain langchain-openai langchain-core pydantic` is enough.

> **Note:** `google-antigravity` currently only ships macOS **arm64** wheels. On x86_64 Macs (or Linux/Windows) the Antigravity agent will be skipped with a clear "no matching distribution" message — the other two agents still run.

#### Environment Variables

| Variable          | Used by agent           | Notes                                                                          |
|-------------------|-------------------------|--------------------------------------------------------------------------------|
| `API_KEY`         | all                     | Fallback if a per-agent key is not set.                                         |
| `OPENAI_API_KEY`  | LangGraph, CrewAI       | Explicit API key for clients that can send authorization headers.               |
| `ANTIGRAVITY_USE_GEMINI_API` | Antigravity           | Set to `true` or `1` to use `LocalAgentConfig` plus `GeminiAPIEndpoint`; otherwise the runner uses `LocalOpenAIAgentConfig`. |
| `PROXY_BASE`      | all                     | Override the proxy origin (default `http://127.0.0.1:7777`).                   |

For Antigravity, start the proxy with both development-only switches:

```bash
DEV_NO_KEY=true npm run server
```

The active proxy TOML must provide the upstream credential because the installed `LocalOpenAIAgentConfig` cannot send an API key or custom authorization header:

```toml
[general]
auth_passthrough_with = "config_key"
```

The selected model route must define `api_key`, or an applicable unmatched model must have `default_api_key` under `[default_upstream]`. In `config_key` mode, the proxy injects that configured key instead of forwarding Antigravity's absent client key. `DEV_NO_KEY` must not be enabled in production.

For the Gemini transport, run the focused `max-m3` test with:

```bash
ANTIGRAVITY_USE_GEMINI_API=true \
PROXY_BASE=http://127.0.0.1:7777 \
API_KEY=xxx \
python tests/multi-agents-test.py 1 1 1
```

The SDK is expected to call `/v1beta/models/max-m3:generateContent` through the proxy. `GEMINI_API_KEY` is preferred over `API_KEY` for this mode.


```bash
# No args — list available models, agents, and tasks; do not run
# .venv for Antigravity + LangGraph; .venv-crewai for CrewAI
.venv/bin/python tests/multi-agents-test.py

# Run the full sweep
.venv/bin/python tests/multi-agents-test.py --all     # or -a / --run / -r

# Pick a subset: M A T (model, agent, task — 1-based, wraps with %; 0 = all in that dimension)
.venv/bin/python tests/multi-agents-test.py 1 1 1     # first model, first agent (Antigravity), first task
.venv/bin/python tests/multi-agents-test.py 9 3 0     # 9th model (wraps), CrewAI, all tasks
.venv/bin/python tests/multi-agents-test.py 0 2 0     # all models, LangGraph, all tasks

# CrewAI requires its own venv (Python ≤ 3.13)
.venv-crewai/bin/python tests/multi-agents-test.py 1 3 1   # model 1, CrewAI, task 1
```

By default all 3 agents are enabled. To run a subset, comment the entries in the `AGENTS` list at the bottom of the script.

#### Per-agent notes

**Antigravity (`google-antigravity`)** — Three subtleties:

1. Use `LocalOpenAIAgentConfig(model=..., base_url=PROXY_BASE)` for OpenAI-compatible `/v1/chat/completions` endpoints; the SDK appends `/v1/chat/completions` to the supplied origin. The installed SDK sends no API key or custom headers, so this proxy test requires `DEV_NO_KEY=true` plus `[general] auth_passthrough_with = "config_key"`. The proxy then injects the selected model route's configured `api_key`. Use `LocalAgentConfig` plus a `GeminiAPIEndpoint` for Gemini-compatible endpoints; the two transports are not interchangeable.
2. Tools are registered as plain Python callables with docstrings (`glob_tool`, `read_tool`); the SDK introspects them per the docs.
3. `Agent` is an async context manager; the runner `await`s `agent.chat(prompt)` and tries `await response.text()` first, falling back to `async for token in response` if `text()` is not available on the response object.

**LangGraph (`langgraph` + `langchain-openai`)** — Three subtleties:

1. `langgraph` is a low-level orchestrator (per its own docs) and does not ship its own chat client. The runner uses `langchain.agents.create_agent` (the ReAct tool-calling loop, the new home of `langgraph.prebuilt.create_react_agent` from pre-1.x) with `langchain_openai.ChatOpenAI`, which is the standard pairing for tool-calling agents.
2. `ChatOpenAI(base_url={PROXY_BASE}/v1)` routes through the proxy's `/v1/chat/completions` handler. This path is served unconditionally.
3. The runner imports `create_agent` aliased as `create_react_agent` so the call site stays readable; this sidesteps the `LangGraphDeprecatedSinceV10` warning emitted by the legacy `langgraph.prebuilt.create_react_agent` in langgraph 1.x.

**CrewAI (`crewai`)** — Four subtleties:

1. The LLM is configured via `LLM(model="openai/<id>", base_url={PROXY_BASE}/v1, api_key=…)`. The `openai/` prefix tells CrewAI to use the OpenAI-compatible chat-completions client; the proxy serves that path unconditionally.
2. CrewAI tools must subclass `BaseTool` and declare an `args_schema` (a `pydantic.BaseModel` with `Field(...)` descriptions). The runner wires `GlobTool`/`ReadTool` with explicit schemas so the model sees typed parameters, not raw JSON.
3. CrewAI's `kickoff()` is synchronous and blocks until the crew finishes; the runner surfaces the result's `raw` attribute (falling back to `str(result)`) and prints `chars=<len>` so silent empty responses are still detectable.
4. The CLI runner wraps all agents in `asyncio.run(...)`. Calling the sync `crew.kickoff()` from inside an active event loop raises `Agent execution was invoked synchronously from within a running event loop`. The dispatcher handles this by running the CrewAI agent via `asyncio.to_thread(runner, prompt, model)`; the async Antigravity agent and the sync LangGraph agent are invoked inline. Switching the dispatcher away from `asyncio.run` would lift this requirement.

#### Result reference

For a sample run (1 model × all agents × all tasks), see `./logs/results/test_result_of_deepseek_v4_flash_all_agents_all_tasks.md` (TS runner). The Python runner writes its output to stdout in the same shape (`--- <Agent> Agent | model=<id> ---` header + `<Agent> done. tool_calls=N, chars=M` summary); redirect with `python tests/multi-agents-test.py 1 2 1 > out.log` to capture.

**CrewAI × 4-model smoke test (2026-07-25, task=`codebase_layout`).** All four `MODELS` entries (with `auth_passthrough_with = "config_key"`) routed cleanly through CrewAI's `openai/{model}` path against the proxy at `127.0.0.1:7777`:

| CLI    | Model              | Upstream mode                                  | Chars  | Status |
|--------|--------------------|------------------------------------------------|--------|--------|
| `1 3 1`| `deepseek-v4-comp` | openai-completions → `api.deepseek.com`        | 16,569 | ✅     |
| `2 3 1`| `deepseek-v4-anth` | anthropic-messages → `api.deepseek.com/anthropic` |  8,022 | ✅     |
| `3 3 1`| `max-m3-comp`      | openai-completions → `api.minimaxi.com`        | 22,985 | ✅     |
| `4 3 1`| `max-m3-anth`      | anthropic-messages → `api.minimaxi.com/anthropic` | 14,782 | ✅     |

The two `-comp` variants exercise the proxy's OpenAI-compatible passthrough; the two `-auth` variants route the request as Anthropic-messages upstream and re-emit as OpenAI-compatible to CrewAI. Run with:

```bash
OPENAI_API_KEY=sk-agent-test-key .venv-crewai/bin/python tests/multi-agents-test.py <M> 3 1
```

---

## Multi-Agent SDK Coverage Summary

The two `multi-agents-test.*` runners exercise **8 distinct agent SDKs** end-to-end against a running proxy, distributed across the TS and Python runners. Each runner shares the same `MODELS` list (4 model routes) and `USER_TASKS` set (8 codebase-analysis tasks tuned to force real multi-glob + multi-read tool use), so a full sweep is `8 tasks × 4 models × N agents`.

### Agent → proxy surface coverage

| Runner | Agent | SDK package | Proxy endpoint exercised | Proxy source path covered |
|---|---|---|---|---|
| TS | **Codex** | `@openai/codex-sdk` | `/v1/responses` (primary) + `/v1/chat/completions` (fallback) | `handlers/responses.ts`, `handlers/chat-completions.ts`, `converters/completions-to-responses.ts` |
| TS | **Claude** | `@anthropic-ai/claude-agent-sdk` | `/v1/messages` | `handlers/messages.ts`, `handlers/claude.ts` |
| TS | **Gemini** | `@google/genai` | `/v1beta/.../generateContent` (+ custom tool-calling loop) | `handlers/gemini.ts`, `converters/gemini-*` |
| TS | **Pi** | `@earendil-works/pi-agent-core` | `/v1/messages` (via `anthropicMessagesApi()`) | `handlers/messages.ts`, `handlers/claude.ts` |
| TS | **OpenCode** | `@opencode-ai/sdk` | `/v1/chat/completions` + `/v1/messages` (provider-dependent) | `handlers/chat-completions.ts`, `handlers/messages.ts` |
| PY | **Antigravity** | `google-antigravity` | `/v1/chat/completions` (OpenAI cfg) or `/v1beta/.../generateContent` (Gemini cfg) | `handlers/chat-completions.ts`, `handlers/gemini.ts` |
| PY | **LangGraph** | `langgraph` + `langchain-openai` | `/v1/chat/completions` | `handlers/chat-completions.ts` |
| PY | **CrewAI** | `crewai` + `pydantic` | `/v1/chat/completions` | `handlers/chat-completions.ts` |

### What the matrix exercises

- **Endpoint breadth**: all four core inbound endpoints (`/v1/messages`, `/v1/chat/completions`, `/v1/responses`, `/v1beta/.../generateContent`) are hit by at least two distinct SDKs, so a regression in any one handler surfaces from multiple clients.
- **Format conversion**: the 4 model routes mix upstream modes (`deepseek-v4-comp`/`max-m3-comp` → openai-completions; `deepseek-v4-anth`/`max-m3-anth` → anthropic-messages), forcing Claude↔OpenAI and OpenAI↔Gemini conversion paths on every run.
- **Tool-calling loops**: every agent runs a real multi-turn tool loop (Glob/Read against `./tests/`), exercising streaming SSE, `tool_use`/`tool_result` round-trips, and `tool_choice` handling — the same surface the unit tests in `tests/unit/` cover field-by-field.
- **Auth flows**: the matrix implicitly covers `x-api-key` (Claude/Pi), `Authorization: Bearer` (Codex/LangGraph/CrewAI/OpenCode), `x-goog-api-key` (Gemini/Antigravity-Gemini), and `auth_passthrough_with = "config_key"` (Antigravity-OpenAI).

### Relationship to `tests/unit/` and `tests/integration/`

The multi-agent runners are **end-to-end smoke tests**, not regression suites: they prove the proxy composes correctly with real-world agent SDKs but cannot pin exact conversion shapes (an upstream model's free-form text is in the loop). Precise field-level coverage of the converters and handlers lives in `tests/unit/` (see [Unit test coverage map](#unit-test-coverage-map)); HTTP-level behavioral coverage of routing, validation, and error paths lives in `tests/integration/` (see `tests/integration/README.md` → Coverage Summary). A failing multi-agent run usually points at a wiring or format-conversion bug worth reproducing as a focused unit or testcase.

---

## Gemini API Tests

This directory contains tests for the Gemini handler with support for both Gemini Interactions API and OpenAI-compatible endpoints.

## Test Files

### `test_gemini_native.js`
Tests the native Gemini Interactions API (`GEMINI_ENDPOINT_TYPE=native`):
- Uses native Gemini format (`input` field)
- Requires `x-goog-api-key` header
- Targets `generativelanguage.googleapis.com/v1beta/interactions`

### `test_gemini_openai_compatible.js`
Tests OpenAI-compatible Gemini wrappers (`GEMINI_ENDPOINT_TYPE=openai-compatible`):
- Uses Claude/OpenAI format (`messages` array)
- Requires `Authorization: Bearer` or `x-api-key` header
- Targets `/v1/chat/completions` endpoint

### `test_gemini_simple.js`
Legacy test for native Gemini format (updated with warnings)

## Configuration

### Environment Variables
```bash
# For native Gemini API
export GEMINI_ENDPOINT_TYPE=native
export GEMINI_BASE_URL=https://generativelanguage.googleapis.com
export GEMINI_API_VERSION=v1beta
export GEMINI_API_KEY=your_gemini_api_key

# For OpenAI-compatible Gemini
export GEMINI_ENDPOINT_TYPE=openai-compatible
export GEMINI_BASE_URL=https://api.qnaigc.com/v1
export GEMINI_API_KEY=your_openai_compatible_api_key
```

## Running Tests

1. **Start the proxy**:
   ```bash
   npm run dev
   ```

2. **Set API key** in test files:
   - Replace `YOUR_GEMINI_API_KEY` with actual API key
   - Replace `YOUR_API_KEY` with actual API key

3. **Run tests**:
   ```bash
   # Native Gemini API
   GEMINI_ENDPOINT_TYPE=native node tests/test_gemini_native.js

   # OpenAI-compatible Gemini
   GEMINI_ENDPOINT_TYPE=openai-compatible node tests/test_gemini_openai_compatible.js

   # Legacy test (native format)
   GEMINI_ENDPOINT_TYPE=native node tests/test_gemini_simple.js
   ```

## Test Coverage

### Native Gemini API
- ✅ Claude format conversion (`messages` → `input`)
- ✅ Native Gemini format (`input` field)
- ✅ Streaming responses
- ✅ `x-goog-api-key` header support
- ✅ `Authorization: Bearer` fallback
- ✅ Environment variable API key

### OpenAI-compatible Gemini
- ✅ Claude to OpenAI format conversion
- ✅ Streaming responses
- ✅ `Authorization: Bearer` header support
- ✅ `x-api-key` header support
- ✅ Environment variable API key
- ✅ Tool support

## Endpoint Differences

### Native Gemini API
- Path: `/v1beta/interactions`
- Request format: `{ "input": "text" }`
- Response format: Gemini InteractionResponse
- Headers: `x-goog-api-key`
- Supports: GET, POST, DELETE, cancel operations

### OpenAI-compatible Gemini
- Path: `/v1/chat/completions`
- Request format: OpenAI format (`messages` array)
- Response format: OpenAI format
- Headers: `Authorization: Bearer` or `x-api-key`
- Supports: POST only (no GET/DELETE/cancel)

## Backward Compatibility

The refactoring maintains backward compatibility:
- Default `GEMINI_ENDPOINT_TYPE=openai-compatible`
- Existing `GEMINI_BASE_URL` and `GEMINI_API_VERSION` still work
- Auto-detection of request format for native endpoints
- Fallback header support
