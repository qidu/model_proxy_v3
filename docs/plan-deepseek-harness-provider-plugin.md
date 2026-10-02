# Plan: Develop model_proxy_v3 as a Model Provider Plugin for deepseek-harness

> **Status**: PHASE 0 COMPLETE — decision: **DEFER PLUGIN DEVELOPMENT** (see §3 Decision Point).
> **Proxy capability update**: `/v1/models` now returns `context_length` and `max_tokens` in OpenAI format (implemented in src).
>
> **Summary**: deepseek-harness cloned and inspected. Current `llm-pi-ai` integration works fully. Gateway tier does not exist. No external plugin registration mechanism exists. Plugin only adds value if/when dsh implements proposed gateway tier.

## Executive Summary

This plan outlined the development of a dedicated deepseek-harness (dsh) provider plugin for model_proxy_v3.

**Current State (verified)**: Integration works via `llm-pi-ai` hand-declared gateway routes (no plugin needed). See `docs/guides/agents/proxy-as-provider-for-deepseek-harness.md`.  
**Target State (deferred)**: A dedicated `@model-proxy-v3/dsh-provider` plugin — only viable if/when dsh implements the proposed "gateway tier" and external provider registration.

**Proposal Context**: The architecture proposal (`docs/architecture/proposal-deepseek-harness-llm-split.md`) *proposes* splitting `packages/llm` to support external provider plugins and a "gateway" tier. This has **not been implemented** in dsh (as of commit inspected in cloned repo).

---

## 1. Verified Architecture (from existing docs)

### 1.1 deepseek-harness LLM Layer (from proposal doc)

```
packages/llm/
├── llm/           # Core contract: AdapterRegistrationHandle, LlmConfigurableProvider
├── llm-pi-ai/     # Generic adapter: turns providers config into pi-ai Provider routes
├── llm-deepseek/  # Specialized DeepSeek adapter
├── llm-retry/     # Retry adapter
└── token-meter/   # Token metering adapter
```

### 1.2 Current Working Integration (from integration guide)

**OpenAI-compatible route** (recommended, enables model discovery):
```yaml
llm-pi-ai:
  providers:
    proxyv3:
      apiKeyEnv: PROXYV3_API_KEY   # dummy value; pi-ai refuses keyless routes
      api: openai-completions
      baseURL: http://<proxy>:8788/v1   # MUST include /v1
      models:
        - id: glm-5.2-comp
        - id: glm-5.3-anth
agent-default-model:
  provider: proxyv3
  model: glm-5.3-anth
```

**Anthropic-messages route** (alternative, no discovery):
```yaml
llm-pi-ai:
  providers:
    proxyv3:
      apiKeyEnv: PROXYV3_API_KEY
      api: anthropic-messages
      baseURL: http://<proxy>:8788   # NO /v1
      models:
        - id: glm-5.2-comp
```

### 1.3 model_proxy_v3 `/v1/models` Response (VERIFIED from code)

**Source**: `src/handlers/models.ts`, `src/converters/openai-to-claude.ts`, `src/types/openai.ts`

**Format**: OpenAI-compatible (since v3 update)

```json
{
  "object": "list",
  "data": [
    {
      "id": "glm-5.2-comp",
      "object": "model",
      "created": 1736937000,
      "owned_by": "system",
      "context_length": 262144,
      "max_tokens": 65536
    }
  ]
}
```

**Critical fields**:
- ✅ `id` — model identifier
- ✅ `object` — always `"model"`
- ✅ `created` — Unix timestamp
- ✅ `owned_by` — provider identifier (e.g., `"system"`)
- ✅ `context_length` — context window size (default: 262144)
- ✅ `max_tokens` — max output tokens (default: 65536)

**Source of models**: Upstream OpenAI-compatible `/v1/models` + config-defined models (`extraModelIds`) — merged in OpenAI format. Composite/fusion/coordinator/schedule aliases appear as regular model entries.

### 1.4 Proxy Config — Not a Monorepo (VERIFIED)

`package.json` has no `workspaces` field. There is no `packages/` directory. The plugin would be a **separate npm package**, not a workspace.

---

## 2. Critical Review of Assumptions (FAIL LOUD)

| # | Assumption in Prior Draft | Reality | Verdict |
|---|---------------------------|---------|---------|
| 1 | `/v1/models` returns `context_window`, `max_output_tokens` | **NOW TRUE** — Returns `context_length`, `max_tokens` in OpenAI format | **Implemented** |
| 2 | `LlmDiscoveredModel` includes `capabilities` object | **UNVERIFIED** — Invented interface; dsh-llm contract not inspected | **Fabricated** |
| 3 | dsh has a "gateway" provider tier (`type: 'gateway'`) | **FALSE** — Only *proposed*, not implemented | **Proposal ≠ reality** |
| 4 | Plugin contract interfaces (`AdapterRegistrationHandle`, etc.) | **PARTIALLY REAL** — Names exist in proposal doc, but exact shapes invented | **Partly fabricated** |
| 5 | model_proxy_v3 is a monorepo with `packages/` | **FALSE** — No workspaces, no packages dir | **Contradicts code** |
| 6 | Week-based timeline estimates | **UNREQUESTED** — User didn't ask for estimates | **Speculative** |
| 7 | Plugin is recommended path | **CONTRADICTED** — Integration guide: "For the current need this is over-engineering" | **Contradicts docs** |

**Conclusion**: The prior plan drafted a plugin for a dsh that doesn't exist yet, against a contract I haven't read, with response fields the proxy doesn't emit. Any implementation must start by:
1. Cloning dsh and reading `@deepseek-ai/dsh-llm` actual types
2. Checking if the proposal has been implemented (gateway tier, generalized discovery)
3. Deciding if plugin is still warranted given `llm-pi-ai` works today

---

## 3. Phase 0 Investigation Results (COMPLETE — 2026-02-XX)

**Repository**: `C:/dev/deepseek-harness` (shallow clone, `--depth 1`, GitHub `deepseek-ai/deepseek-harness`)

### 3.1 The Actual `@deepseek-ai/dsh-llm` Contract (VERIFIED)

Read from `packages/llm/llm/src/index.ts` and `types.ts`:

```typescript
// Adapter registration — the ONLY way to add a provider
registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle
interface AdapterRegistrationHandle {
  (): void                                    // dispose
  replace(providers: string[]): void          // change owned routes
}

// Provider directory (picker entries) — NOT a gateway tier
registerConfigurableProviders(entries: readonly LlmConfigurableProvider[]): DirectoryRegistrationHandle
interface LlmConfigurableProvider {
  provider: string
  displayName: string
  settingsNs: string                          // settings namespace owning this provider
  settingsPath: readonly string[]             // path within that namespace
  declared?: boolean
  error?: string
}

// Model discovery — registered PER SETTINGS NAMESPACE
registerModelDiscovery(
  settingsNs: string,
  discover: (operation: LlmModelDiscoveryOperation) => Promise<readonly LlmDiscoveredModel[]>,
): () => void
interface LlmModelDiscoveryRequest {
  provider?: string
  baseURL?: string
  api?: string
  apiKey?: string
}
interface LlmModelDiscoveryOperation {
  request: LlmModelDiscoveryRequest
  signal: AbortSignal
}
interface LlmDiscoveredModel {
  id: string
  name?: string
  contextWindow?: number        // ← capabilities DO exist here
  maxTokens?: number            // ← (contrary to prior draft's assumption)
  inputModalities?: readonly string[]
}

// Adapter abstract base class
abstract class LlmAdapter {
  providerInfo(provider: string): LlmProviderInfo
  providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined
  listModels(provider: string): Promise<readonly LlmModelInfo[]>
  resolveModel(provider, model, signal?): Promise<LlmResolvedModelInfo>
  prepareCall(provider, model, signal?): Promise<PreparedAdapterCall>
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>
}
```

### 3.2 Findings Against the Decision Matrix

| # | Question | Finding | Evidence |
|---|----------|---------|----------|
| 1 | Does a "gateway" provider tier exist? | **NO** | No `type: gateway` in `LlmConfigurableProvider`; only proposed in `proposal-deepseek-harness-llm-split.md` |
| 2 | Can an external package register an adapter? | **NO** | `registerAdapter` is a method on `LlmRuntime`, reached via `ctx.llm` (Cordis DI) — requires being an in-tree dsh plugin, not an npm package |
| 3 | Does `LlmDiscoveredModel` carry capabilities? | **YES** | `contextWindow?`, `maxTokens?`, `inputModalities?` — **prior draft's assumption #2 was wrong in the opposite direction** |
| 4 | Does discovery work for Anthropic-shaped listings? | **NO** | `llm-pi-ai/src/discovery.ts` gates on `openai-completions` / `openai-responses` only |
| 5 | Is `llm-pi-ai` sufficient today? | **YES** | Hand-declared route + `GET /models` discovery works end-to-end; guide confirms |
| 6 | Would a plugin need dsh source changes? | **YES** | No plugin seam exists below `packages/llm`; would need `registerAdapter` exposed to external packages, or the gateway tier |

### 3.3 How the Existing Adapters Register (the pattern a plugin would have to follow)

`packages/llm/llm-deepseek/src/host.ts:39` — registration is an **in-tree** Cordis plugin:

```typescript
export function registerDeepSeekProvider<C extends DeepSeekConnectionOptions>(
  ctx: Context, provider: string, dependencies: Pick<...>): void {
  const adapter = new DeepSeekAdapter({ ...dependencies, /* ... */ })
  const registration = ctx.llm.registerAdapter([provider], adapter)   // ← needs ctx
  ctx.on('loader/volatile-update', () => { registration.replace([provider]) })
}
```

`ctx` comes from the Cordis plugin loader. There is **no exported entry point** by which an out-of-tree npm package can obtain a `ctx` and call `registerAdapter` for a new provider without dsh loading it as a plugin from its own composition.

### 3.4 What `llm-pi-ai` Already Does (and its gaps)

`packages/llm/llm-pi-ai/src/adapter.ts` (`PiAiAdapter extends LlmAdapter`) + `config.ts` (`resolveProfiles`) + `discovery.ts`:

- **Route declaration**: `providers` dict keyed by route name; a route naming no installed pi-ai provider is "the whole provider declaration" (needs `api` + `baseURL`). ✅ works for the proxy today.
- **Capabilities per model**: `models[].contextWindow`, `models[].maxTokens`, `models[].input` — manually declared; route-level `defaultContextWindow` (262,144) and `defaultMaxTokens` (32,768) silently mis-size anything not declared.
- **Discovery**: `openai-completions` + `openai-responses` only; reads `data[].id`, `data[].context_length`, `data[].max_tokens`. Cannot interrogate an `anthropic-messages` route.
- **Proxy capability support**: model_proxy_v3 now returns `context_length` and `max_tokens` in `/v1/models` (OpenAI format), which `llm-pi-ai` discovery can consume if updated to read those fields.

### 3.5 Decision Point

| Finding | Action | **Chosen** |
|---------|--------|-----------|
| Gateway tier exists + full contract available | Proceed with plugin development | |
| Provider registration works externally | Build thin wrapper | |
| dsh changes needed first | Document required changes; contribute upstream; pause plugin work | ✅ |
| `llm-pi-ai` fully sufficient | Close: no plugin needed | ✅ (near-term) |

**DECISION: NO-GO on plugin development now.** Two conditions gate it:

1. **Near-term (no dsh changes)**: `llm-pi-ai` + the integration guide is the recommended path. A plugin would have to reimplement `PiAiAdapter`'s snapshot/profile machinery to achieve parity, with no mechanism to register it.
2. **Trigger for revisiting**: dsh lands the proposal's items — external provider registration *or* a gateway tier *or* Anthropic-shaped discovery. At that point the plugin's value (live model sync, capability reporting, one picker entry) becomes real.

**Actionable now (proxy-side, independent of dsh)**: the proxy could emit `context_window` / `max_output_tokens` in `/v1/models`. This is a proxy enhancement that benefits every client (and would be read by a future dsh gateway tier), not plugin work. See Appendix.

---

## 4. IF Plugin Proceeds (After dsh Changes): Technical Requirements

*Only valid after dsh implements external registration or gateway tier.*

### 4.1 Actual Contract (VERIFIED from dsh source)

```typescript
// From @deepseek-ai/dsh-llm (packages/llm/llm/src/index.ts + types.ts)

interface AdapterRegistrationHandle {
  (): void;
  replace(providers: string[]): void;
}

interface LlmConfigurableProvider {
  provider: string;
  displayName: string;
  settingsNs: string;
  settingsPath: readonly string[];
  declared?: boolean;
  error?: string;
  // NO 'type' field — no gateway tier exists
}

interface LlmDiscoveredModel {
  id: string;
  name?: string;
  contextWindow?: number;     // ← exists!
  maxTokens?: number;         // ← exists!
  inputModalities?: readonly string[];
}

interface LlmModelDiscoveryRequest {
  provider?: string;
  baseURL?: string;
  api?: string;
  apiKey?: string;
}

interface LlmModelDiscoveryOperation {
  request: LlmModelDiscoveryRequest;
  signal: AbortSignal;
}

// Adapter registration (requires Cordis ctx, NOT available to external packages)
function registerAdapter(providers: string[], adapter: LlmAdapter): AdapterRegistrationHandle

// Discovery registration (requires Cordis ctx)
function registerModelDiscovery(
  settingsNs: string,
  discover: (op: LlmModelDiscoveryOperation) => Promise<readonly LlmDiscoveredModel[]>
): () => void

// LlmAdapter abstract class — must extend
abstract class LlmAdapter {
  providerInfo(provider: string): LlmProviderInfo;
  providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined;
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;
}
```

### 4.2 Discovery Implementation (based on ACTUAL proxy response)

```typescript
async function discoverModels(config: ProviderConfig): Promise<LlmDiscoveredModel[]> {
  const baseURL = config.baseURL.replace(/\/+$/, '');
  const url = `${baseURL}/v1/models`;  // Auth-exempt per src/index.ts:920
  
  const response = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(config.timeoutMs ?? 30000)
  });
  
  if (!response.ok) {
    logger.warn(`Model discovery failed: ${response.status}`);
    return [];
  }
  
  // Proxy returns OpenAI format: { object: "list", data: [...] }
  const data: { object: "list"; data: Array<{ 
    id: string; 
    object: "model";
    created: number;
    owned_by: string;
    context_length?: number;
    max_tokens?: number;
  }> } = await response.json();
  
  return data.data.map(model => ({
    id: model.id,
    name: model.id,  // display_name == id in proxy
    contextWindow: model.context_length,
    maxTokens: model.max_tokens,
    inputModalities: ['text']  // proxy doesn't expose modalities
  }));
}
```

### 4.3 Configuration Schema (actual needs)

```json
{
  "baseURL": "string (required) — e.g., http://localhost:8788",
  "apiKey": "string (required, dummy) — pi-ai requires it",
  "protocol": "enum: openai-completions | anthropic-messages (default: openai-completions)",
  "timeoutMs": "number (optional, default: 30000)"
}
```

**Protocol handling**:
- `openai-completions`: dsh calls `{baseURL}/chat/completions`, discovers via `{baseURL}/models` → **baseURL must include `/v1`**
- `anthropic-messages`: dsh calls `{baseURL}/v1/messages`, no discovery → **baseURL must NOT include `/v1`**

---

## 5. Documentation References (Verified)

| Document | Path | Status |
|----------|------|--------|
| Integration Guide (current working method) | `docs/guides/agents/proxy-as-provider-for-deepseek-harness.md` | ✅ Verified |
| Architecture Proposal (future direction) | `docs/architecture/proposal-deepseek-harness-llm-split.md` | ✅ Verified |
| Agent Guides Index | `docs/guides/agents/README.md` | ✅ Verified |
| Proxy `/v1/models` handler | `src/handlers/models.ts` | ✅ Verified |
| Model type definitions | `src/types/claude.ts`, `src/types/openai.ts` | ✅ Verified |
| OpenAI→Claude conversion | `src/converters/openai-to-claude.ts` | ✅ Verified |

---

## 6. Next Steps (Concrete)

**Phase 0 investigation is COMPLETE.** The decision is made:

1. **Near-term (no dsh changes)**: Use the existing `llm-pi-ai` integration guide — it works fully today. No plugin needed. The guide is at `docs/guides/agents/proxy-as-provider-for-deepseek-harness.md`.

2. **Proxy-side enhancement (optional, independent of dsh)**: If the proxy emits `context_window` / `max_output_tokens` in `/v1/models`, *any* client that reads those fields (including a future dsh gateway tier) benefits. See Appendix.

3. **Trigger to revisit**: Watch the dsh repo for:
   - External provider registration seam (`registerAdapter` exposed outside Cordis DI)
   - "Gateway" provider tier in configuration surface
   - Anthropic-shaped listing support in `llm-pi-ai` discovery
   When any of these land, reassess plugin viability.

4. **If contributing to dsh**: The proposal (`proposal-deepseek-harness-llm-split.md`) is a solid starting PR description. The smallest high-impact change would be:
   - Generalize `discovery.ts` to accept `anthropic-messages` and read `data[].id` + `display_name`
   - Add `context_window` / `max_output_tokens` to discovered model parsing

---

## Appendix: What Would Need to Change in model_proxy_v3 for Full Plugin Support

If plugin development proceeds (after dsh implements gateway tier/external registration) and we want capability reporting:

| Change | File | Effort | Note |
|--------|------|--------|------|
| ~~Add `context_window`/`max_output_tokens` to model config~~ | ~~`src/utils/config-loader.ts` (ModelEntry)~~ | ~~Medium~~ | ~~dsh's `LlmDiscoveredModel` **does have** `contextWindow?`, `maxTokens?` fields~~ | **DONE** — proxy returns `context_length`/`max_tokens` in OpenAI format |
| ~~Extend `/v1/models` response with capacity fields~~ | ~~`src/converters/openai-to-claude.ts`, `src/handlers/models.ts`~~ | ~~Medium~~ | ~~Upstream OpenAI-compatible `/v1/models` often lacks these; may need proxy-side defaults~~ | **DONE** — returns OpenAI format with defaults (262144/65536) |
| ~~Add capability fields to Claude model type~~ | ~~`src/types/claude.ts` (ClaudeModel)~~ | ~~Low~~ | ~~Add `context_window?`, `max_output_tokens?` to `ClaudeModel`~~ | **DONE** — `context_length?`, `max_tokens?` already present |

These are **proxy enhancements**, not plugin work. They would benefit all clients, not just dsh.

**Status**: All three proxy-side capability changes are **IMPLEMENTED** in the current codebase:
- `/v1/models` returns OpenAI format with `context_length` and `max_tokens`
- Upstream models merged with defaults (262144 / 65536)
- `ClaudeModel` type includes `context_length?` and `max_tokens?` for internal use
- `OpenAIModel` type includes `context_length?` and `max_tokens?` for upstream compatibility

**Correction from prior draft**: The dsh contract *does* carry `contextWindow`/`maxTokens` in discovered models (contrary to assumption #2 in §2). The gap was on the **proxy side** — the proxy's `/v1/models` did not emit them before this update. **That gap is now closed.**

---

*End of plan. Phase 0 complete — decision: defer plugin development; use `llm-pi-ai` integration guide.*