# Design: Using `/decision` API for Composite Alias Target Selection

Status: **Proposed**
Author: design doc
Date: 2026-01-14
Scope: Extend composite alias resolution to use the Clef `/decision` API for selecting among same-level targets when no `primary`/`fallback`/`share` is explicitly configured, using per-target `ability` declarations.

---

## 1. Problem

Today, composite aliases resolve to an ordered attempt list via `getCompositeRouteCandidates()`:

1. If any target has `primary: true` → it goes first
2. Else if any target has `fallback > 0` → sort ascending by `fallback`
3. Else keep declaration order, then weighted random pick (`share`) places winner first

When no `primary` is set and all targets are at the same priority level (same `fallback` or no `fallback`), the selection is **random by weight** (`share`). This doesn't account for the actual request context — some models are better at coding, others at reasoning, others at creative tasks.

The `/decision` endpoint (Clef protocol) provides a structured way to make this choice: given the request state and a set of candidates with declared abilities, ask a lightweight judge model to pick the best target.

---

## 2. Proposed Design

### 2.1 New Config Fields

Add an optional `decision` field to `CompositeModelConfig`, and a new `ability` field to `CompositeTargetConfig`:

```ts
export interface CompositeModelConfig {
  token_limit?: TokenLimitConfig;
  decision?: DecisionConfig;   // NEW
  [modelName: string]: CompositeTargetConfig | TokenLimitConfig | DecisionConfig | undefined;
}

export interface CompositeTargetConfig {
  primary?: boolean;
  fallback?: number;
  share?: number;
  ability?: string;            // NEW: comma-separated abilities, e.g. "coding,reasoning,analysis"
  // ... existing fields
}

export interface DecisionConfig {
  model: string;                 // "laya" | "clef" | "clef-flash" (decision backend model name)
  url: string;                   // full /decision endpoint URL (e.g., "http://localhost:8765/decision")
  api_key?: string;              // optional Authorization header
  threshold?: number;            // confidence threshold (default: 0.5)
  timeout_ms?: number;           // per-request budget (default: 50ms)
  context_prompts?: number;      // number of recent prompts to include (default: 1)
}
```

No `enabled`, `question_type`, `instructions`, `criteria` fields — these are fixed/derived:
- Always uses `choice` question type
- Instructions are fixed: "Select the best model for this task based on the user's prompt and each model's declared abilities."
- Criteria are auto-generated from each target's `ability` field

### 2.2 Trigger Logic: When to Use Decision API

The decision API is invoked **only when ALL of the following are true**:

1. No target has `primary: true`
2. No target has `fallback` set (or all have `fallback: 0`)
3. No target has `share` set (or all have `share: 0` / unset)
4. **At least one target has `ability` declared** (non-empty string)

If ANY target has `primary`, `fallback`, or `share` configured → use **existing static selection logic** (decision API skipped).

### 2.3 TOML Example

```toml
[composite]
"smart-assistant" = {
  "deepseek-v4-pro" = {ability = "reasoning,complex-coding,analysis"},
  "max-m3" = {ability = "fast-coding,simple-tasks,debugging"},
  "laya-flash" = {ability = "creative,summarization,qa"},
  decision = {
    model = "laya",
    url = "http://localhost:8765/decision",
    api_key = "optional-key",
    threshold = 0.6,
    timeout_ms = 100,
    context_prompts = 1
  }
}

# This composite uses static selection (share) — decision API NOT invoked
"code-assistant-static" = {
  "deepseek-v4-pro" = {share = 50},
  "max-m3" = {share = 50},
  decision = {model = "laya", url = "http://localhost:8765/decision"}  # ignored because share is set
}

# This composite uses static selection (primary) — decision API NOT invoked
"primary-example" = {
  "deepseek-v4-pro" = {primary = true},
  "max-m3" = {fallback = 1},
  decision = {model = "laya", url = "http://localhost:8765/decision"}  # ignored because primary is set
}
```

### 2.4 Resolution Flow

When resolving a composite alias:

1. **Check for `primary` target** — if exists, use existing logic (primary first, then fallbacks). Decision API is **not invoked**.

2. **Check for `fallback` or `share` on any target** — if present, use existing weighted/static logic. Decision API is **not invoked**.

3. **Check for `decision` config present AND at least one target has `ability`** — if both true:
   - Build `state` from request context:
     - Recent user prompt(s): last `context_prompts` messages (default: 1)
     - Available models + their declared `ability` strings
     - Tool list, conversation history summary
   - Build `questions` with one `choice` question: candidates are the composite targets, criteria derived from `ability` fields
   - Call `/decision` endpoint with Clef protocol (reuse `callDecisionApi` from decision client)
   - Parse `answers.target_selection.choice` → selected target name
   - Place selected target **first** in attempt list; remaining targets follow as fallbacks (preserving declaration order)

4. **Fallback** — if decision API fails, times out, returns invalid result, or confidence < `threshold`:
   - Log warning
   - Fall back to declaration order (first declared target first)

### 2.5 Clef Request Format

```json
{
  "model": "laya",
  "state": "User prompt: \"Write a recursive fibonacci in Rust\"\nAvailable models:\n- deepseek-v4-pro: reasoning,complex-coding,analysis\n- max-m3: fast-coding,simple-tasks,debugging\n- laya-flash: creative,summarization,qa\nTools: [read, write, bash]\nHistory: 3 messages",
  "questions": {
    "target_selection": {
      "type": "choice",
      "instructions": "Select the best model for this task based on the user's prompt and each model's declared abilities.",
      "criteria": {
        "deepseek-v4-pro": "Abilities: reasoning, complex-coding, analysis",
        "max-m3": "Abilities: fast-coding, simple-tasks, debugging",
        "laya-flash": "Abilities: creative, summarization, qa"
      }
    }
  }
}
```

### 2.6 Clef Response Format

```json
{
  "model": "laya",
  "answers": {
    "target_selection": {
      "type": "choice",
      "choice": "deepseek-v4-pro",
      "probabilities": { "deepseek-v4-pro": 0.72, "max-m3": 0.18, "laya-flash": 0.10 },
      "confidence": 0.72
    }
  },
  "usage": { "input_tokens": 156, "output_tokens": 0 }
}
```

The proxy extracts `answers.target_selection.choice` → `"deepseek-v4-pro"`.

---

## 3. Integration Points

### 3.1 Config Loader (`src/utils/config-loader.ts`)

- Extend `parseCompositeModelConfig` to parse `decision` block and `ability` field
- Extend `serializeCompositeModelConfig` to serialize `decision` and `ability`
- Add validation in `validateProxyConfig`:
  - If `decision` present, require `model` and `url`
  - Warn if `decision` coexists with `primary`/`fallback`/`share` on any target (static takes precedence)
  - Validate `context_prompts >= 1` if set

### 3.2 Resolution (`src/utils/config-loader.ts`)

Add a new `resolveCompositeWithDecision()` that reuses `callDecisionApi` from decision client:

```ts
import { callDecisionApi, adaptToClefRequest, adaptFromClefResponse } from './decision-client.js';

export async function resolveCompositeWithDecision(
  modelName: string,
  proxyConfig: ProxyConfig,
  requestContext: RequestContext  // prompt, tools, history summary
): Promise<ModelRouteConfig[]> {
  const composite = proxyConfig.composite?.[modelName];
  if (!composite || !composite.decision) {
    return getCompositeRouteCandidates(modelName, proxyConfig); // existing logic
  }
  
  // Check for primary first
  const primary = Object.entries(composite).find(([_, cfg]) => cfg.primary);
  if (primary) {
    return getCompositeRouteCandidates(modelName, proxyConfig);
  }
  
  // Check for fallback or share on ANY target
  const hasFallbackOrShare = Object.values(composite).some(
    cfg => (cfg.fallback ?? 0) > 0 || (cfg.share ?? 0) > 0
  );
  if (hasFallbackOrShare) {
    return getCompositeRouteCandidates(modelName, proxyConfig);
  }
  
  // Check for at least one ability
  const hasAbility = Object.values(composite).some(cfg => cfg.ability?.trim());
  if (!hasAbility) {
    return getCompositeRouteCandidates(modelName, proxyConfig);
  }
  
  // Build state and questions for Clef request
  const state = buildDecisionState(requestContext, composite);
  const questions = buildDecisionQuestions(composite);
  
  // Use existing callDecisionApi (requires DecisionClientConfig shape)
  const decisionConfig = {
    url: composite.decision.url,
    model: composite.decision.model,
    api_key: composite.decision.api_key,
    threshold: composite.decision.threshold ?? 0.5,
    timeout_ms: composite.decision.timeout_ms ?? 50,
  };
  
  const request = { state, questions };
  const response = await callDecisionApi(decisionConfig, request, `composite-${modelName}`);
  
  if (response?.target_selection?.choice && composite[response.target_selection.choice]) {
    const selected = response.target_selection.choice;
    const confidence = response.target_selection.confidence ?? 0;
    if (confidence >= (composite.decision.threshold ?? 0.5)) {
      // Reorder: selected first, rest as fallbacks (declaration order)
      return [composite[selected], ...others];
    }
  }
  
  // Fallback to declaration order
  return getCompositeRouteCandidates(modelName, proxyConfig);
}

function buildDecisionState(context: RequestContext, composite: CompositeModelConfig): string {
  // Build state similar to decision client: user prompt, model abilities, tools, history
}

function buildDecisionQuestions(composite: CompositeModelConfig): Record<string, ClefChoiceQuestion> {
  const criteria: Record<string, string> = {};
  for (const [name, cfg] of Object.entries(composite)) {
    if (typeof cfg === 'object' && cfg.ability) {
      criteria[name] = `Abilities: ${cfg.ability}`;
    }
  }
  return {
    target_selection: {
      type: 'choice',
      instructions: 'Select the best model for this task based on the user\'s prompt and each model\'s declared abilities.',
      criteria,
    },
  };
}
```

### 3.3 Execution (`src/index.ts`)

The existing retry loop (`runAttempt`) already handles ordered candidates. Just ensure the decision-aware resolution runs before the loop.

---

## 4. Fail-Open Behavior

- Decision API timeout / error / malformed response → log warning, use declaration order
- Confidence below `threshold` → treat as no clear winner, use declaration order
- Selected target not found in config → use declaration order
- No target has `ability` declared → use declaration order

This ensures **zero regression risk** — the decision API only *reorders* the attempt list; the existing fallback chain remains intact.

---

## 5. Relationship to Existing Features

| Feature | Interaction |
|---------|-------------|
| `primary` target | Takes absolute precedence; decision API skipped |
| `fallback` values | If ANY target has fallback, static logic used; decision API skipped |
| `share` weights | If ANY target has share, static logic used; decision API skipped |
| `ability` (NEW) | Required on at least one target for decision API to activate |
| `token_limit` | Applied at alias level (unchanged) |
| `fusion` mode | Mutually exclusive — fusion has its own judge/synth pipeline; this design is for simple share/fallback/ability aliases only |

---

## 6. Why `/decision` API (Clef)

- **Unified protocol**: Same endpoint serves tool judging, model selection, and any future typed decisions
- **Structured I/O**: `choice` question type natively returns `probabilities` and `confidence`
- **Shared backend**: Can use the same Laya/Cloudflare instance as tool judging
- **No separate sidecar process**: The `/decision` endpoint is already part of the proxy (when `[decision]` is configured) or can point to the same Laya backend
- **Code reuse**: Reuses `callDecisionApi`, `adaptToClefRequest`, `adaptFromClefResponse` from decision client

---

## 7. Future Extensions

- **`noul` mode for scoring**: Instead of single choice, score all targets independently
- **Per-request context injection**: Pass more state (file types, project language, user preferences)
- **Learning feedback loop**: Record decision outcomes (success/failure/latency) to improve future prompts
- **Multi-criteria**: Separate questions for "reasoning needed", "speed priority", "cost sensitivity"
- **Dynamic ability discovery**: Infer abilities from model benchmark data

---

## 8. Implementation Surface

1. **`src/utils/config-loader.ts`** — types, parsing, serialization, validation, resolution logic
2. **`src/utils/decision-client.ts`** — `callDecisionApi` (Clef protocol client)
3. **`src/index.ts`** — integrate decision-aware resolution before retry loop
4. **Dashboard** — render/edit `decision` block and `ability` field in composite alias editor