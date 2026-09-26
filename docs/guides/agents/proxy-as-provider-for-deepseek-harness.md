# Using model_proxy_v3 as an LLM provider for deepseek-harness (dsh)

How to wire this proxy into deepseek-harness (`dsh`) as an LLM backend.

## How dsh's LLM layer is structured

`packages/llm/` contains the plugin chain:

- **`llm`** — core: defines the adapter/registration interfaces (`AdapterRegistrationHandle`, `LlmConfigurableProvider`) that all LLM plugins implement.
- **`llm-pi-ai`** — the generic adapter: turns `providers:` config entries into pi-ai `Provider` routes. Supports hand-declared gateways over 3 protocols: `openai-completions`, `openai-responses`, `anthropic-messages` (`packages/llm/llm-pi-ai/src/provider.ts:46-51`).
- **`llm-deepseek`**, **`llm-retry`**, **`token-meter`** — specialized adapters.

## What model_proxy_v3 serves (`src/index.ts`)

| Endpoint | Status |
|---|---|
| `/v1/messages` | Primary — Anthropic protocol in, converts to any upstream mode |
| `/v1/models` | Model listing, **auth-exempt** (`src/index.ts:920`) |
| `/v1/chat/completions` | Served by default (per-model routed passthrough) |
| `/v1beta/models/*:generateContent`, count_tokens, embeddings | Supported |

## Integration options

### 1. Provider route in settings (recommended)

`llm-pi-ai` is explicitly designed for gateways pi-ai doesn't know (its own doc header shows an "acme-gateway" example). Add a route to `~/.dsh/settings.yaml` on the dsh host.

#### OpenAI-compatible (recommended)

Uses the proxy's `/v1/chat/completions` (served by default, per-model routed passthrough) and `/v1/models`:

```yaml
llm-pi-ai:
  providers:
    proxyv3:
      apiKeyEnv: PROXYV3_API_KEY   # dummy value in the env; pi-ai refuses keyless routes
      api: openai-completions
      baseURL: http://100.100.81.175:8788/v1   # MUST include /v1 — the client appends /chat/completions
      models:
        - id: glm-5.2-comp
        - id: glm-5.3-anth
agent-default-model:
  provider: proxyv3
  model: glm-5.3-anth
```

Notes:

- `baseURL` **includes `/v1`**: dsh builds chat requests as `{baseURL}/chat/completions` and model discovery as `{baseURL}/models` — both hit the proxy correctly.
- **Model auto-discovery works** (verified by invoking dsh's `discoverModels` from `packages/llm/llm-pi-ai/src/discovery.ts` against the proxy): the "fetch available models" action interrogates OpenAI-compatible routes via `GET {baseURL}/models`. The proxy's listing returns every configured id — concrete models (`glm-5.2-anth`, …), composite/fusion/coordinator aliases (`code-small`, …), and schedule aliases — and dsh's parser reads `data[].id` (+ `display_name` as the model name), so all of them come back as candidates.
- **Discovery is a manual UI action, not a sync.** In the dsh web UI's Models page, the "fetch available models" button interrogates the route and offers the listing as candidates for adoption into the draft config. Nothing is stored automatically — `settings.yaml` remains the only thing that decides what a route serves, so picked candidates must be saved there explicitly.
- Any model id in `proxy_config.toml` is usable. Declare `contextWindow` / `maxTokens` per model if the defaults (262k / 32k) are wrong — the listing carries no capacity fields.
- Models in `[models.free]` use their **configured** `api_key` upstream — the dummy client key is never forwarded.

#### Anthropic-messages (alternative)

Uses the proxy's primary `/v1/messages` endpoint instead:

```yaml
llm-pi-ai:
  providers:
    proxyv3:
      apiKeyEnv: PROXYV3_API_KEY   # dummy value; pi-ai refuses keyless routes
      api: anthropic-messages
      baseURL: http://100.100.81.175:8788   # NO /v1 — the client appends /v1/messages
      models:
        - id: glm-5.2-comp
agent-default-model:
  provider: proxyv3
  model: glm-5.2-comp
```

This route cannot use model auto-discovery (dsh only interrogates OpenAI-compatible protocols), so models must be hand-listed.

### 2. Profile patch layer

Put the same `providers` config under the `llm` row in `~/.dsh/profiles/<name>/cordis.patch.yml` instead of `settings.yaml` — per-profile and shareable. Same mechanism, different scope.

### 3. Dedicated Cordis plugin

Write a plugin like `llm-deepseek`. Only justified if you need proxy-specific behavior *inside* the adapter — composite/fusion routing awareness, transform negotiation, dashboard stats. None of that requires a plugin: the proxy handles it all server-side transparently. For the current need this is over-engineering.

## Caveats

- **Keyless routes are refused.** pi-ai requires a key, so `apiKeyEnv: PROXYV3_API_KEY` with a dummy value in the env is required even though the proxy is unauthenticated.
- **`baseURL` `/v1` handling differs by protocol**: OpenAI-compatible routes include `/v1` in `baseURL`; `anthropic-messages` routes omit it.

## Bottom line

No new plugin is needed — `llm-pi-ai`'s hand-declared gateway route *is* the plugin mechanism, and the OpenAI-compatible route gets model discovery for free.
