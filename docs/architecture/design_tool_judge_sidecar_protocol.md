# Protocol: Proxy ↔ Tool Judge Sidecar

Status: draft / for review
Scope: Network protocol between proxy and local sidecar for per-tool judging

---

## 1. Requirements

- **Latency budget**: 50ms p99 (sidecar SLA)
- **Timeout behavior**: Fail-open — if sidecar doesn't respond in time, proxy keeps the tool
- **Input**: User prompt + tool schema + optional conversation context
- **Output**: Per-tool decision via LLM-as-judge format (`choice` with probabilities or `noul` score)
- **Transport**: Local HTTP (sidecar runs on same host, e.g., `http://127.0.0.1:8081`)
- **Protocol**: JSON over HTTP/1.1 matching the judge API schema

---

## 2. HTTP API

### 2.1 Endpoint

```
POST http://{sidecar_host}:{sidecar_port}/judge
Content-Type: application/json
```

### 2.2 Request (Single Tool - `choice` type)

```json
{
  "state": "User prompt: \"Please create a new file called hello.py with a hello world function\"\n\nTool: file_write\nSchema: {\"type\": \"object\", \"properties\": {\"path\": {\"type\": \"string\"}, \"content\": {\"type\": \"string\"}}, \"required\": [\"path\", \"content\"]}\n\nRecent context:\n- User: \"I need to write a Python script\"\n- User: \"Can you help me create a file?\"\n- Assistant called: file_read(main.py)",
  "questions": {
    "decision": {
      "type": "choice",
      "instructions": "Should this tool be kept or discarded based on the user prompt and context?",
      "criteria": ["keep", "discard"]
    }
  }
}
```

### 2.3 Request (Batch - Multiple Tools - `noul` type)

```json
{
  "state": "Evaluate each tool for relevance to the user prompt:\n\nUser prompt: \"Please create a new file called hello.py with a hello world function\"\n\nRecent context:\n- User: \"I need to write a Python script\"\n- User: \"Can you help me create a file?\"\n- Assistant called: file_read(main.py)\n\nTools to evaluate:\n1. file_write: {\"type\": \"object\", \"properties\": {\"path\": {\"type\": \"string\"}, \"content\": {\"type\": \"string\"}}, \"required\": [\"path\", \"content\"]}\n2. bash: {\"type\": \"object\", \"properties\": {\"command\": {\"type\": \"string\"}}, \"required\": [\"command\"]}\n3. web_search: {\"type\": \"object\", \"properties\": {\"query\": {\"type\": \"string\"}}, \"required\": [\"query\"]}",
  "questions": {
    "file_write": { "type": "noul", "instructions": "Keep file_write tool?" },
    "bash": { "type": "noul", "instructions": "Keep bash tool?" },
    "web_search": { "type": "noul", "instructions": "Keep web_search tool?" }
  }
}
```

**Request Field Definitions:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `state` | string | Yes | Full evaluation context — user prompt, tool schemas, recent conversation |
| `questions` | object | Yes | Map of question_id → question spec |
| `questions.<id>.type` | string | Yes | `"choice"` (single, with criteria) or `"noul"` (batch, simple score) |
| `questions.<id>.instructions` | string | Yes | Human-readable instruction for the judge |
| `questions.<id>.criteria` | string[] | For `choice` | Array of allowed choices: `["keep", "discard"]` |

**Batch vs Single:**
- **Single (`choice`)**: One tool per request, returns `probabilities.keep` + explicit `choice`
- **Batch (`noul`)**: Multiple tools in one request, returns `noul` score per tool (more efficient)

### 2.4 Response (Single - `choice`)

```json
{
  "decision": {
    "type": "choice",
    "confidence": 0.87,
    "action": { "act_probability": 1.0 },
    "choice": "keep",
    "probabilities": { "keep": 0.87, "discard": 0.13 }
  }
}
```

### 2.5 Response (Batch - `noul`)

```json
{
  "file_write": {
    "type": "noul",
    "confidence": 0.91,
    "action": { "act_probability": 1.0 },
    "noul": 0.91
  },
  "bash": {
    "type": "noul",
    "confidence": 0.82,
    "action": { "act_probability": 1.0 },
    "noul": 0.12
  },
  "web_search": {
    "type": "noul",
    "confidence": 0.78,
    "action": { "act_probability": 1.0 },
    "noul": 0.05
  }
}
```

**Response Field Definitions:**

| Field | Type | Description |
|-------|------|-------------|
| `decision` / `<tool_name>` | object | For `choice`: single `decision` object. For `noul`: map of tool_name → result |
| `type` | string | Echoes request type (`"choice"` or `"noul"`) |
| `confidence` | number | Model confidence in the decision (0.0–1.0) |
| `action.act_probability` | number | Always 1.0 (reserved for future use) |
| `choice` | string | For `choice`: `"keep"` or `"discard"` |
| `probabilities` | object | For `choice`: `{ "keep": 0.87, "discard": 0.13 }` |
| `noul` | number | For `noul`: relevance score 0.0–1.0 (1.0 = highly relevant) |

---

## 3. Decision Logic

The proxy interprets sidecar responses using these thresholds:

| Approach | Threshold | Keep Condition |
|----------|-----------|----------------|
| `choice` + probabilities | `probabilities.keep > 0.5` | `probabilities.keep > threshold` |
| `noul` | `noul > 0.5` (tunable: 0.7 for strict) | `noul > threshold` |

**Proxy Config (thresholds):**
```toml
[tool_judge_sidecar]
enabled = true
url = "http://127.0.0.1:8081/judge"
timeout_ms = 50
mode = "noul"              # "choice" (single) or "noul" (batch) — matches sidecap capability
threshold = 0.5            # noul threshold (or probabilities.keep threshold)
# thresholds = { "bash" = 0.7, "file_delete" = 0.8, "file_write" = 0.3 }
```

---

## 4. Proxy Request Building

### 4.1 State Construction

The proxy builds `state` from the request:

```typescript
function buildJudgeState(
  userPrompt: string,
  tools: Array<{ name: string; schema: object }>,
  context: { recentUserMessages: string[]; recentToolCalls: Array<{ name: string; args: object }> }
): string {
  const lines = [
    `User prompt: "${userPrompt}"`,
    "",
    "Tools to evaluate:",
  ];
  
  tools.forEach((tool, i) => {
    lines.push(`${i + 1}. ${tool.name}: ${JSON.stringify(tool.schema)}`);
  });
  
  if (context.recentUserMessages.length > 0) {
    lines.push("", "Recent context:");
    context.recentUserMessages.forEach(msg => lines.push(`- User: "${msg}"`));
  }
  if (context.recentToolCalls.length > 0) {
    context.recentToolCalls.forEach(tc => lines.push(`- Assistant called: ${tc.name}(${JSON.stringify(tc.args)})`));
  }
  
  return lines.join("\n");
}
```

### 4.2 Questions Construction

**Batch mode (`noul`):**
```typescript
function buildNoulQuestions(tools: Array<{ name: string }>): Record<string, object> {
  const questions: Record<string, object> = {};
  for (const tool of tools) {
    questions[tool.name] = {
      type: "noul",
      instructions: `Keep ${tool.name} tool?`
    };
  }
  return questions;
}
```

**Single mode (`choice`):**
```typescript
function buildChoiceQuestion(toolName: string): object {
  return {
    decision: {
      type: "choice",
      instructions: `Should this tool be kept or discarded based on the user prompt and context?`,
      criteria: ["keep", "discard"]
    }
  };
}
```

---

## 5. Proxy Response Parsing

### 5.1 Parse `choice` Response

```typescript
function parseChoiceResponse(response: object, toolName: string, threshold: number): JudgeDecision {
  const decision = response.decision;
  if (!decision || decision.type !== "choice") {
    throw new Error("Invalid choice response");
  }
  const keepProb = decision.probabilities?.keep ?? 0;
  return {
    toolName,
    factor: keepProb,
    action: keepProb > threshold ? "keep" : "erase",
    reason: `choice: keep=${keepProb.toFixed(2)}, choice=${decision.choice}`
  };
}
```

### 5.2 Parse `noul` Response

```typescript
function parseNoulResponse(response: object, tools: string[], threshold: number): JudgeDecision[] {
  const decisions: JudgeDecision[] = [];
  for (const toolName of tools) {
    const result = response[toolName];
    if (!result || result.type !== "noul") {
      decisions.push({ toolName, factor: 1.0, action: "keep", reason: "missing from response" });
      continue;
    }
    const noul = result.noul ?? 0;
    decisions.push({
      toolName,
      factor: noul,
      action: noul > threshold ? "keep" : "erase",
      reason: `noul=${noul.toFixed(2)}`
    });
  }
  return decisions;
}
```

---

## 6. Proxy Integration

### 6.1 Call Site

In `src/index.ts`, after `before_upstream` transforms, before `eraseBlockedTools`:

```typescript
const judgeResult = await callToolJudgeSidecar({
  requestId,
  route,
  upstreamMode,
  body,
  userPrompt: extractUserPrompt(body),
  tools: extractToolRecords(body),
  context: buildContext(requestId),
});

// Merge: tool erased if (static_blocked OR sidecar_action === "erase")
const erasedTools = mergeDecisions(staticBlocklist, judgeResult);
body = eraseToolsFromBody(body, erasedTools);
```

### 6.2 Timeout Handling (Fail-Open)

```typescript
async function callToolJudgeSidecar(input: JudgeInput): Promise<JudgeDecision[] | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.timeout_ms);

  try {
    // Build request per config.mode ("noul" | "choice")
    const requestBody = config.mode === "noul"
      ? buildBatchRequest(input)
      : buildSingleRequest(input); // would loop per tool

    const response = await fetch(config.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      logger.warn(requestId, `Sidecar HTTP ${response.status}, failing open`);
      return null;
    }
    const json = await response.json();
    return config.mode === "noul"
      ? parseNoulResponse(json, input.tools.map(t => t.name), config.threshold)
      : parseChoiceResponse(json, input.tools[0].name, config.threshold); // single
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === 'AbortError') {
      logger.warn(requestId, `Sidecar timeout (${config.timeout_ms}ms), failing open`);
    } else {
      logger.warn(requestId, `Sidecar error: ${e.message}, failing open`);
    }
    return null; // fail-open → keep all tools
  }
}
```

### 6.3 Fail-Open Behavior

| Scenario | Proxy Behavior |
|----------|----------------|
| Sidecar returns 200 with valid response | Parse decisions, apply threshold |
| Sidecar returns 5xx / 4xx | Log warning, **keep all tools** |
| Sidecar timeout (50ms) | Log warning, **keep all tools** |
| Sidecar returns malformed JSON | Log error, **keep all tools** |
| Sidecar missing tool in batch response | Default `factor=1.0` (keep) for missing |
| Network error (ECONNREFUSED) | Log warning, **keep all tools** |

---

## 7. Sidecar Implementation Notes

### 7.1 Expected Latency Profile

- Target: **< 50ms p99** including network (localhost RTT ~0.1ms)
- Sidecar should aim for **< 30ms** processing
- Batch (`noul`) preferred — single forward pass for all tools

### 7.2 Health Check Endpoint

```
GET http://{host}:{port}/health
→ 200 OK { "status": "healthy", "model_version": "v1.2.3", "mode": "noul" }
```

### 7.3 Reference Sidecar (Python/FastAPI)

```python
# sidecar/judge.py
from fastapi import FastAPI
from pydantic import BaseModel, Field
from typing import Dict, Any, List, Optional
import time

app = FastAPI()

class ChoiceQuestion(BaseModel):
    type: str = "choice"
    instructions: str
    criteria: List[str] = ["keep", "discard"]

class NoulQuestion(BaseModel):
    type: str = "noul"
    instructions: str

class JudgeRequest(BaseModel):
    state: str
    questions: Dict[str, ChoiceQuestion | NoulQuestion]

class ChoiceDecision(BaseModel):
    type: str = "choice"
    confidence: float
    action: Dict[str, float] = Field(default_factory=lambda: {"act_probability": 1.0})
    choice: str  # "keep" | "discard"
    probabilities: Dict[str, float]  # {"keep": 0.87, "discard": 0.13}

class NoulDecision(BaseModel):
    type: str = "noul"
    confidence: float
    action: Dict[str, float] = Field(default_factory=lambda: {"act_probability": 1.0})
    noul: float

# Batch endpoint (noul)
@app.post("/judge")
async def judge_batch(req: JudgeRequest):
    start = time.perf_counter()
    
    # Detect mode from first question
    first_q = next(iter(req.questions.values()))
    is_noul = first_q.type == "noul"
    
    results = {}
    for tool_name, question in req.questions.items():
        # TODO: Replace with actual LLM/classifier call
        # For now, simple keyword heuristic
        noul_score = heuristic_score(req.state, tool_name)
        confidence = 0.8 + noul_score * 0.2  # mock confidence
        
        if is_noul:
            results[tool_name] = NoulDecision(
                confidence=confidence,
                noul=noul_score
            )
        else:
            choice = "keep" if noul_score > 0.5 else "discard"
            results["decision"] = ChoiceDecision(
                confidence=confidence,
                choice=choice,
                probabilities={"keep": noul_score, "discard": 1 - noul_score}
            )
    
    processing_ms = int((time.perf_counter() - start) * 1000)
    # Add processing_ms to response if needed
    return results

@app.get("/health")
async def health():
    return {"status": "healthy", "model_version": "heuristic-v1", "mode": "noul"}

def heuristic_score(state: str, tool_name: str) -> float:
    """Simple keyword heuristic - replace with real model."""
    prompt_lower = state.lower()
    keywords = {
        "file_write": ["create", "write", "save", "new file", "make a file"],
        "file_read": ["read", "show", "view", "cat", "open"],
        "bash": ["run", "execute", "command", "shell", "terminal"],
        "web_search": ["search", "find", "look up", "google"],
    }
    kw = keywords.get(tool_name, [])
    matches = sum(1 for k in kw if k in prompt_lower)
    return min(0.95, 0.1 + matches * 0.3)
```

---

## 8. Config Schema (proxy_config.toml)

```toml
[tool_judge_sidecar]
enabled = true
url = "http://127.0.0.1:8081/judge"
timeout_ms = 50
mode = "noul"              # "noul" (batch) or "choice" (single)
threshold = 0.5            # noul threshold or probabilities.keep threshold

# Optional per-tool threshold overrides (higher = stricter)
# thresholds = { "bash" = 0.7, "file_delete" = 0.8, "file_write" = 0.3 }

# Optional: send conversation context
send_context = true
context_window = 3         # number of recent messages/tool_calls to include
```

> **Implementation status (proxy v3).** The shipped `[tool_judge_sidecar]` schema
> differs from the block above; `src/utils/config-loader.ts` is authoritative:
>
> | Key | Shipped |
> |---|---|
> | `judge_url` | yes — **base URL** (`http://127.0.0.1:8081`); the client appends `/judge`. Its presence alone activates the feature |
> | `timeout_ms` | yes (default 50) |
> | `mode` | yes (default `"choice"`) |
> | `threshold` | yes (default 0.5) |
> | `max_batch_tools` | yes (default 50) — tools past the cap are kept and counted in the log |
> | `api_key` | yes — sent as `Authorization: Bearer` |
> | `enabled` | **not implemented** — activation is by `judge_url` |
> | `url` | **not implemented** — the key is `judge_url` |
> | `thresholds` | **not implemented** — a single global `threshold` |
> | `send_context`, `context_window` | **not implemented** — context is always sent, capped by the constants in `src/utils/tool-judge-sidecar.ts` |
>
> The wrapper serving this protocol for the Laya model lives in
> `submodules/laya-mlx/serve_judge.py`.

---

## 9. Observability

### 9.1 Proxy Logs

```
[INFO]  req-abc123  Sidecar judge (noul): 3 tools, 23ms, kept=1 erased=2
[WARN]  req-def456  Sidecar timeout (50ms), failing open - keeping all 4 tools
[WARN]  req-ghi789  Sidecar HTTP 503, failing open
```

### 9.2 Metrics

| Metric | Type | Labels |
|--------|------|--------|
| `tool_judge_sidecar_requests_total` | Counter | `result` (success, timeout, error, http_error) |
| `tool_judge_sidecar_latency_ms` | Histogram | — |
| `tool_judge_sidecar_tools_judged_total` | Counter | `action` (keep, erase) |
| `tool_judge_sidecar_noul` | Histogram | `tool_name` |
| `tool_judge_sidecar_confidence` | Histogram | — |

### 9.3 Dashboard API

```
GET /dashboard/api/tool-judge-sidecar/status
→ { "enabled": true, "url": "...", "healthy": true, "last_latency_ms": 23, "last_error": null, "mode": "noul" }

POST /dashboard/api/tool-judge-sidecar/toggle
→ { "enabled": false }
```

---

## 10. Future Extensions

| Feature | Protocol Change |
|---------|-----------------|
| Streaming judgment | WebSocket/SSE for progressive results |
| Sidecar-side threshold | Add `threshold` to request, sidecar returns only `action` |
| Tool choice judgment | Extend to judge `tool_choice` parameter |
| Response-side judging | New endpoint `/judge-response` for output filtering |
| Multi-model sidecar | `model` field in request to select judge model |