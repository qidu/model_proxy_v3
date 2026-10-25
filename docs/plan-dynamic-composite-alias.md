# Plan: Dynamic Composite Alias Target Selection via `/decision` API

## Overview

Enable dynamic model selection for composite aliases (fusion, coordinator, fallback, share) by integrating the `/decision` API from `submodules/laya-mlx`. Instead of static config-based routing (share weights, fallback priority), the proxy will query a local Laya model to pick the best target for each request based on conversation context.

## Current State

- **Composite aliases** defined in `proxy_config.toml` with static `share`, `fallback`, `primary` weights
- **Routing logic** in `src/index.ts:1565-1660` — `getCompositeRouteCandidates` → `orderCompositeCandidatesForRuntimeShare` → first candidate wins
- **No semantic awareness** — same model tried first regardless of task type

## Target Architecture

```
Request → getCompositeRouteCandidates() → [NEW] selectTargetViaDecision() → ordered candidates → attempt loop
                ↓                              ↑
         Static candidate list          /decision API call
         (from config)                  (Laya model)
```

## Implementation Plan

### 1. New Utility: `src/utils/decision-router.ts`

```typescript
// Core function
async function selectTargetViaDecision(
  alias: string,
  candidates: CompositeRouteCandidate[],
  requestBody: RequestBody,
  proxyConfig: ProxyConfig,
  requestId: string,
  logger: Logger
): Promise<CompositeRouteCandidate | null>
```

**Responsibilities:**
- Build decision request state from incoming request (system prompt + recent messages)
- Format candidate descriptions for Laya
- Call `/decision` endpoint with `choice` + `score` questions
- Parse response, validate chosen model exists in candidates
- Return chosen candidate or `null` on failure/timeout

### 2. Config Schema Extension (`src/utils/config-loader.ts`)

Add to `CompositeTargetConfig`:

```typescript
interface CompositeTargetConfig {
  // existing fields...
  decision_routing?: boolean;  // NEW: enable dynamic selection for this alias
}
```

Add global decision config:

```typescript
interface ProxyConfig {
  // existing...
  decision?: {
    backend: 'laya' | 'cloudflare';
    url: string;
    api_key?: string;
    timeout_ms?: number;
    cache_ttl_ms?: number;  // optional: cache recent decisions
  };
}
```

### 3. Integration Point (`src/index.ts`)

**Location:** After line 1566 (`getCompositeRouteCandidates`), before line 1588 (`orderCompositeCandidatesForRuntimeShare`)

```typescript
const compositeCandidates = getCompositeRouteCandidates(modelName, proxyConfig);

let routeCandidates: CompositeRouteCandidate[];
const compositeConfig = proxyConfig.composite?.[modelName];

if (compositeConfig?.decision_routing && proxyConfig.decision?.url) {
  const dynamicChoice = await selectTargetViaDecision(
    modelName,
    compositeCandidates,
    body,
    proxyConfig,
    requestId,
    logger
  );
  if (dynamicChoice) {
    routeCandidates = [dynamicChoice, ...compositeCandidates.filter(c => c !== dynamicChoice)];
  } else {
    routeCandidates = orderCompositeCandidatesForRuntimeShare(modelName, compositeCandidates);
  }
} else {
  routeCandidates = orderCompositeCandidatesForRuntimeShare(modelName, compositeCandidates);
}
```

### 4. Decision Request Format

**Endpoint:** `POST {decision.url}/decision`

```json
{
  "model": "laya",
  "state": {
    "system_prompt": "You are a coding assistant...",
    "messages": [
      {"role": "user", "content": "Write a React component..."},
      {"role": "assistant", "content": "Here's a component..."},
      {"role": "user", "content": "Now add TypeScript types"}
    ],
    "candidate_models": [
      {"name": "codestrong", "desc": "Deep reasoning, 32k context"},
      {"name": "codesmall", "desc": "Fast, cost-efficient, 8k context"}
    ]
  },
  "questions": {
    "best_model": {
      "type": "choice",
      "instructions": "Select the best model for the current request given conversation context",
      "criteria": {
        "codestrong": "Deep reasoning, 32k context - best for complex architecture",
        "codesmall": "Fast, cost-efficient - best for simple edits"
      }
    },
    "confidence": {
      "type": "score",
      "instructions": "Rate confidence the chosen model will succeed",
      "criteria": ["low", "medium", "high", "very high"]
    }
  }
}
```

**Response parsing:**
```typescript
const choice = result.answers?.best_model?.choice;
const confidence = result.answers?.confidence?.score ?? 0;
if (confidence >= 0.7 && choice) { /* use it */ }
```

### 5. State Input Strategy

| Alias Type | State Input | Rationale |
|------------|-------------|-----------|
| General coding (`code-*`) | System + last 8 messages | Task evolves across turns |
| Cost-optimized | Recent prompt only | Simple classification |
| Specialist routing | Full conversation (last 15) | Nuanced task detection |

**Default:** System prompt + last 8 messages (configurable via `decision.context_messages`)

### 6. Config Example (`proxy_config.toml`)

```toml
[decision]
backend = "laya"
url = "http://localhost:8081/decision"
timeout_ms = 3000
cache_ttl_ms = 60000  # optional: cache decisions for 1 min

[composite]
"code-selector" = {
  decision_routing = true
  token_limit = {num = 400000000, duration = "1w"}
  "codestrong" = {share = 100, fallback = 0}
  "codesmall" = {share = 1, fallback = 1}
  "or-nemotron-3-ultra-550b-a55b" = {share = 1, fallback = 2}
}

"cheap-fallback" = {
  decision_routing = false  # use static ordering
  token_limit = {num = 100000000, duration = "1d"}
  "codesmall" = {share = 100, fallback = 0}
  "codestrong" = {share = 1, fallback = 1}
}
```

### 7. Error Handling & Fallbacks

| Failure Mode | Behavior |
|--------------|----------|
| `/decision` timeout | Fall back to static ordering, log warning |
| `/decision` returns invalid model | Fall back to static ordering |
| `/decision` returns low confidence (<0.7) | Fall back to static ordering |
| Network error | Fall back to static ordering |
| Laya not running | Fall back to static ordering (no crash) |

### 8. Observability

- Log: `[decision-router] alias=code-selector chose=codestrong confidence=0.92`
- Metrics: decision latency, fallback rate, confidence distribution
- Debug: include decision reasoning in response headers (optional)

## Testing Strategy

### Unit Tests (`src/utils/__tests__/decision-router.test.ts`)

- Build state from various request shapes
- Parse choice/score responses correctly
- Handle missing/invalid responses
- Timeout handling

### Integration Tests

- Composite alias with `decision_routing = true` routes to Laya
- Fallback to static ordering when Laya unavailable
- Confidence threshold respected

### Manual Verification

```bash
# Start Laya
cd submodules/laya-mlx && python serve_judge.py --port 8081

# Test composite alias
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "code-selector", "messages": [{"role": "user", "content": "Write a complex React architecture"}]}'

# Verify codestrong chosen (check logs)
```

## Rollout Plan

1. **Phase 1:** Implement `decision-router.ts` with unit tests
2. **Phase 2:** Add config schema, integrate into `index.ts`
3. **Phase 3:** Add config example, update docs
4. **Phase 4:** Test with Laya running locally
5. **Phase 5:** Optional — add decision caching for latency reduction

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Added latency (~50-200ms) | Low timeout (3s), optional caching, skip for single-candidate aliases |
| Laya unavailable | Graceful fallback to static — no request failure |
| Wrong model chosen | Confidence threshold, fallback on actual error |
| Config complexity | Optional feature, disabled by default |

## Future Enhancements

- **Per-request caching:** Cache decisions keyed by `(alias, task_embedding)` for repeated similar tasks
- **Feedback loop:** Track success/failure per model per task type, feed back to decision prompt
- **Multi-criteria:** Add `score` questions for latency, cost, quality tradeoffs
- **Fusion integration:** Use `/decision` for judge model selection in fusion pipeline

---

## Relation to Tool Judge Sidecar (`/judge`)

| Aspect | Tool Judge Sidecar | Composite Alias `/decision` |
|--------|-------------------|----------------------------|
| **Target** | Individual tools | Whole model alias |
| **When** | Pre-inference (filters tools) | Pre-inference (picks model) |
| **Endpoint** | `POST {judge_url}/judge` | `POST {decision.url}/decision` |
| **Question Type** | `choice` / `noul` (keep vs discard) | `choice` / `score` (model A vs B) |
| **Config Section** | `tool_judge_sidecar` | `decision` (new) |
| **Fail-open** | Keep all tools | Static ordering fallback |
| **State Input** | User prompt + tool schemas + recent context | System prompt + messages + candidate models |

### How They Compose

```
Request
    │
    ├─► tool-judge-sidecar (/judge)
    │       │
    │       └─► Filters tool list (erases irrelevant tools)
    │
    ├─► decision-router (/decision)  [if composite alias has decision_routing=true]
    │       │
    │       └─► Picks best model from alias candidates
    │
    ▼
Upstream inference (chosen model, filtered tools)
```

Both run **before upstream call**, are **optional**, and **fail open**. They operate on different axes:
- **Sidecar** = "Which tools are relevant?"
- **Decision router** = "Which model is best for this task?"

Config example with both enabled:
```toml
[tool_judge_sidecar]
judge_url = "http://127.0.0.1:8081"
timeout_ms = 50
mode = "noul"
threshold = 0.5

[decision]
backend = "laya"
url = "http://localhost:8081/decision"
timeout_ms = 3000

[composite]
"code-selector" = {
  decision_routing = true
  "codestrong" = {share = 100, fallback = 0}
  "codesmall" = {share = 1, fallback = 1}
}
```

---

## Files to Modify

| File | Change Type |
|------|-------------|
| `src/utils/decision-router.ts` | NEW |
| `src/utils/config-loader.ts` | ADD types |
| `src/index.ts` | INTEGRATE routing logic |
| `proxy_config.toml` | EXAMPLE config |
| `docs/api/composite-aliases.md` | UPDATE docs |

## Acceptance Criteria

- [ ] Composite alias with `decision_routing = true` calls `/decision` API
- [ ] Chosen model from Laya is tried first
- [ ] Fallback to static ordering on any decision failure
- [ ] Configurable timeout prevents request blocking
- [ ] Works with existing fallback/share logic unchanged
- [ ] Unit tests cover happy path + all error cases