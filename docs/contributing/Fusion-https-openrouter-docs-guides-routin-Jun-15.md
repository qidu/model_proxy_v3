Based on the comprehensive analysis of the OpenRouter Fusion Router, here's a complete design for a similar multi-model deliberation router:

---

# Multi-Model Deliberation Router Design

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT REQUEST                            │
│  { model: "fusion", messages: [...], tools?: [...], ... }       │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      ROUTER GATEWAY                              │
│  • Alias resolution: "fusion" → outer_model (e.g., claude-opus) │
│  • Inject fusion tool definition                                │
│  • Track recursion depth via header                             │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      OUTER MODEL (LLM-as-Router)                │
│  • Sees user prompt + available tools (including fusion)        │
│  • Decides: call fusion? call other tool? answer directly?      │
│  • Conditional invocation by default; forced via tool_choice   │
└────────────────────────────┬────────────────────────────────────┘
                             │
              ┌──────────────┴──────────────┐
              ▼                             ▼
    ┌─────────────────────┐       ┌─────────────────────┐
    │   PANEL DISPATCHER  │       │  (no fusion call)   │
    │  (async fan-out)    │       │  Direct answer      │
    └──────────┬──────────┘       └─────────────────────┘
               │
       ┌───────┼───────┬───────┬───────┐
       ▼       ▼       ▼       ▼       ▼
  ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐
  │Model│ │Model│ │Model│ │Model│ │Model│  (1–8 models, parallel)
  │  A  │ │  B  │ │  C  │ │  D  │ │  E  │  Each with web_search/fetch
  └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘ └──┬──┘
     └────────┴───────┴───────┴───────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                      JUDGE MODEL                                 │
│  • Receives ALL panel responses + original prompt               │
│  • Outputs STRUCTURED JSON analysis (schema-enforced)           │
│  • Has web_search/fetch for fact-checking                       │
│  • Fields: consensus, contradictions, partial_coverage,         │
│    unique_insights, blind_spots                                 │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      OUTER MODEL (Final Synthesis)              │
│  • Receives structured analysis JSON                            │
│  • Writes user-facing final answer                              │
│  • Can stream output                                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                        RESPONSE                                  │
│  { choices: [{ message: {...} }], router: "fusion", ... }       │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Core Components

### 2.1 Fusion Tool Definition (Injected into Outer Model)

```json
{
  "type": "function",
  "function": {
    "name": "multi_model_deliberate",
    "description": "Invoke a multi-model deliberation panel for complex queries requiring diverse perspectives, expert critique, research synthesis, or high-confidence answers. Use when: research questions, compare/contrast, expert analysis, factually disputed topics, or when being wrong is costlier than extra compute.",
    "parameters": {
      "type": "object",
      "properties": {
        "prompt": {
          "type": "string",
          "description": "The original user prompt to send to the panel"
        },
        "analysis_models": {
          "type": "array",
          "items": { "type": "string" },
          "minItems": 1,
          "maxItems": 8,
          "description": "Panel models (provider-diverse recommended). Defaults to quality preset."
        },
        "judge_model": {
          "type": "string",
          "description": "Model for structured comparative analysis. Defaults to outer model."
        },
        "max_tool_calls": {
          "type": "integer",
          "minimum": 1,
          "maximum": 16,
          "default": 8,
          "description": "Max web tool calls per panel/judge model"
        },
        "max_completion_tokens": {
          "type": "integer",
          "description": "Token cap per inner completion"
        },
        "reasoning": {
          "type": "object",
          "properties": {
            "effort": { "type": "string", "enum": ["low", "medium", "high"] },
            "max_tokens": { "type": "integer" }
          },
          "description": "Reasoning config forwarded to panel/judge"
        },
        "temperature": {
          "type": "number",
          "minimum": 0,
          "maximum": 2,
          "description": "Sampling temperature for panel/judge"
        }
      },
      "required": ["prompt"]
    }
  }
}
```

### 2.2 Judge Output Schema (Strict JSON)

```json
{
  "type": "object",
  "properties": {
    "consensus": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Points agreed on by most/all panel models — higher confidence"
    },
    "contradictions": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "topic": { "type": "string" },
          "stances": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "model": { "type": "string" },
                "stance": { "type": "string" }
              },
              "required": ["model", "stance"]
            }
          }
        },
        "required": ["topic", "stances"]
      },
      "description": "Direct disagreements with per-model positions"
    },
    "partial_coverage": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "models": { "type": "array", "items": { "type": "string" } },
          "point": { "type": "string" }
        },
        "required": ["models", "point"]
      },
      "description": "Valid points raised by only a subset of models"
    },
    "unique_insights": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "model": { "type": "string" },
          "insight": { "type": "string" }
        },
        "required": ["model", "insight"]
      },
      "description": "Notable points raised by only one model"
    },
    "blind_spots": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Important angles NO panel model addressed"
    }
  },
  "required": ["consensus", "contradictions", "partial_coverage", "unique_insights", "blind_spots"],
  "additionalProperties": false
}
```

---

## 3. Panel Composition Strategy

### Default Presets

```yaml
presets:
  quality:                    # Default — best epistemic diversity
    - "~anthropic/claude-opus-latest"
    - "~openai/gpt-latest"
    - "~google/gemini-pro-latest"
  
  balanced:                   # Cost/quality trade-off
    - "~anthropic/claude-sonnet-latest"
    - "~openai/gpt-4o-latest"
    - "~google/gemini-flash-latest"
  
  budget:                     # Maximum throughput
    - "~anthropic/claude-haiku-latest"
    - "~openai/gpt-4o-mini-latest"
    - "~google/gemini-flash-8b-latest"
  
  coding:                     # Specialized for code tasks
    - "~anthropic/claude-opus-latest"
    - "~openai/o1-latest"
    - "~google/gemini-pro-latest"
    - "~deepseek/deepseek-coder-latest"

custom:
  max_size: 8
  min_size: 1
```

**Selection Principle**: Prioritize **provider diversity** (different RLHF, data, architecture) over raw benchmark scores. One model per major provider family maximizes epistemic independence.

---

## 4. API Interface

### 4.1 Simple Alias Usage (Auto-injection)

```bash
curl https://api.router.ai/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -d '{
    "model": "fusion",
    "messages": [{"role": "user", "content": "Compare the strongest arguments for and against nuclear energy"}]
  }'
```

### 4.2 Explicit Tool Declaration (Full Control)

```json
{
  "model": "~anthropic/claude-opus-latest",
  "messages": [{"role": "user", "content": "Design a distributed consensus algorithm"}],
  "tools": [{
    "type": "fusion",
    "parameters": {
      "analysis_models": [
        "~anthropic/claude-opus-latest",
        "~openai/gpt-latest",
        "~google/gemini-pro-latest",
        "~deepseek/deepseek-coder-latest"
      ],
      "judge_model": "~openai/o1-latest",
      "max_tool_calls": 8,
      "max_completion_tokens": 4000,
      "reasoning": { "effort": "high", "max_tokens": 2000 },
      "temperature": 0.3
    }
  }],
  "tool_choice": "required"
}
```

### 4.3 Forced Fusion

```json
{ "model": "fusion", "tool_choice": "required", "messages": [...] }
```

---

## 5. Implementation Patterns

### 5.1 Core Pipeline (Pseudocode)

```python
import asyncio
from typing import List, Dict, Any
from dataclasses import dataclass

@dataclass
class FusionConfig:
    analysis_models: List[str]
    judge_model: str
    max_tool_calls: int = 8
    max_completion_tokens: int = 4000
    reasoning: Dict = None
    temperature: float = 0.7

class FusionRouter:
    def __init__(self, client, presets: Dict[str, List[str]]):
        self.client = client
        self.presets = presets
        self.JUDGE_SCHEMA = {...}  # From section 2.2
    
    async def route(self, request: ChatRequest, depth: int = 0) -> ChatResponse:
        # Recursion guard
        if depth > 0:
            return await self.client.complete(request)  # No tool injection
        
        outer_model = self.resolve_alias(request.model) or request.model
        fusion_tool = self.build_fusion_tool()
        
        # Stage 1: Outer model decides
        decision = await self.client.complete(
            model=outer_model,
            messages=request.messages,
            tools=[fusion_tool] + (request.tools or []),
            tool_choice=request.tool_choice or "auto"
        )
        
        if not self.is_fusion_call(decision):
            return decision  # Direct answer
        
        # Parse fusion invocation
        config = self.parse_fusion_args(decision.tool_calls[0].arguments)
        
        # Stage 2: Parallel panel
        panel_responses = await self.run_panel(
            prompt=request.messages[-1].content,
            models=config.analysis_models,
            max_tool_calls=config.max_tool_calls,
            max_tokens=config.max_completion_tokens,
            reasoning=config.reasoning,
            temperature=config.temperature
        )
        
        # Stage 3: Judge with structured output
        analysis = await self.run_judge(
            prompt=request.messages[-1].content,
            responses=panel_responses,
            judge_model=config.judge_model or outer_model,
            max_tool_calls=config.max_tool_calls,
            max_tokens=config.max_completion_tokens
        )
        
        # Stage 4: Final synthesis
        final = await self.client.complete(
            model=outer_model,
            messages=[
                *request.messages[:-1],
                {"role": "user", "content": self.build_synthesis_prompt(
                    request.messages[-1].content, analysis
                )}
            ],
            stream=request.stream
        )
        
        final.router = "fusion"
        return final
    
    async def run_panel(self, prompt: str, models: List[str], **kwargs) -> List[Dict]:
        tasks = [
            self.client.complete(
                model=m,
                messages=[{"role": "user", "content": prompt}],
                tools=["web_search", "web_fetch"],
                max_tool_calls=kwargs["max_tool_calls"],
                max_completion_tokens=kwargs["max_completion_tokens"],
                reasoning=kwargs.get("reasoning"),
                temperature=kwargs.get("temperature")
            )
            for m in models
        ]
        results = await asyncio.gather(*tasks, return_exceptions=True)
        return [
            {"model": m, "content": r.content if not isinstance(r, Exception) else None,
             "error": str(r) if isinstance(r, Exception) else None}
            for m, r in zip(models, results)
        ]
    
    async def run_judge(self, prompt: str, responses: List[Dict], judge_model: str, **kwargs) -> Dict:
        judge_prompt = self.build_judge_prompt(prompt, responses)
        return await self.client.complete(
            model=judge_model,
            messages=[{"role": "user", "content": judge_prompt}],
            tools=["web_search", "web_fetch"],
            response_format={"type": "json_schema", "json_schema": self.JUDGE_SCHEMA},
            max_completion_tokens=kwargs["max_completion_tokens"],
            max_tool_calls=kwargs["max_tool_calls"]
        )
```

### 5.2 Judge Prompt Template

```markdown
You are a meta-analyst comparing responses from multiple expert models.

ORIGINAL PROMPT:
{{prompt}}

PANEL RESPONSES:
{{#each responses}}
---
MODEL: {{this.model}}
{{#if this.error}}
ERROR: {{this.error}}
{{else}}
CONTENT: {{this.content}}
{{/if}}
{{/each}}

TASK: Produce a structured comparative analysis. Output ONLY valid JSON matching the schema.

ANALYSIS FRAMEWORK:
1. CONSENSUS: What do most/all models agree on? (High confidence)
2. CONTRADICTIONS: Direct disagreements — quote each model's stance
3. PARTIAL_COVERAGE: Valid points only some models raised
4. UNIQUE_INSIGHTS: Notable ideas from only one model
5. BLIND_SPOTS: Important angles NO model addressed

Use web_search/web_fetch to verify contested factual claims before finalizing.
```

### 5.3 Synthesis Prompt Template

```markdown
You are writing the final answer for the user.

ORIGINAL PROMPT: {{prompt}}

STRUCTURED ANALYSIS FROM EXPERT PANEL:
{{analysis_json}}

INSTRUCTIONS:
- Lead with CONSENSUS as the confident baseline
- Present CONTRADICTIONS as nuanced disagreement with attribution
- Include PARTIAL_COVERAGE points with appropriate caveats
- Highlight UNIQUE_INSIGHTS as minority/expert perspectives
- Explicitly address BLIND_SPOTS — note what's missing
- Write naturally; don't just list the analysis fields
- Cite specific models when presenting divergent views
```

---

## 6. Failure Handling & Degradation

| Scenario | Status | Response |
|----------|--------|----------|
| All panel succeed, judge succeeds | `ok` | Full analysis + responses |
| Some panel fail | `ok` | Analysis from successful models; `failed_models` array |
| Panel succeed, judge fails | `ok` | Raw `responses` returned; `analysis` omitted |
| All panel fail | `error` | `failure_reason: "all_panels_failed"` |
| Insufficient credits | `error` | `failure_reason: "insufficient_credits"` |
| Rate limited | `error` | `failure_reason: "rate_limited"` |
| Recursion attempt | `error` | `failure_reason: "fusion_invocation_capped"` |
| Unexpected error | `error` | `failure_reason: "unexpected_error"` |

**Outer model fallback**: If `analysis` missing, synthesize from raw `responses` directly.

---

## 7. Recursion Protection

```python
# Header propagated to all inner calls
headers = {
    "x-fusion-depth": str(depth + 1)
}

# In router gateway:
def inject_fusion_tool(request, depth):
    if depth > 0:
        return request  # Don't inject at depth > 0
    request.tools.append(FUSION_TOOL)
    return request
```

---

## 8. Observability & Metadata

```json
{
  "id": "gen-...",
  "model": "anthropic/claude-opus-4.5",
  "router": "fusion",
  "fusion_metadata": {
    "panel_models": ["claude-opus", "gpt-4", "gemini-pro"],
    "judge_model": "gpt-4",
    "panel_latency_ms": {"claude-opus": 1200, "gpt-4": 1400, "gemini-pro": 1100},
    "judge_latency_ms": 800,
    "synthesis_latency_ms": 600,
    "total_tokens": {"panel": 15000, "judge": 3000, "synthesis": 2000},
    "total_cost_usd": 0.045,
    "panel_errors": [],
    "analysis_present": true
  }
}
```

---

## 9. Cost & Latency Model

| Component | Calls | Cost Multiplier | Latency |
|-----------|-------|-----------------|---------|
| Outer model (decision) | 1 | 1× | t₁ |
| Panel (N models, parallel) | N | N× | max(t_panel) |
| Judge | 1 | 1× | t_judge |
| Outer model (synthesis) | 1 | 1× | t_synthesis |
| **Total (N=3)** | **5–6** | **~4–5×** | **max(t_panel) + t_judge + t_synthesis** |

**Optimization**: Panel parallelization keeps latency ~2–3× single call, not 5×.

---

## 10. When to Use vs. Avoid

| Use Fusion When | Avoid Fusion When |
|-----------------|-------------------|
| Research requiring multi-perspective synthesis | Simple factual lookup |
| Expert critique / peer review simulation | Latency-critical interactive use |
| Compare/contrast tasks | High-volume, low-margin workloads |
| High-stakes decisions (wrong > expensive) | Single-model confidence is sufficient |
| Factually disputed/controversial topics | Creative tasks where diversity = noise |
| Blind spot detection needed | Tasks where models give near-identical answers |

---

## 11. Advanced Enhancements (Future)

1. **Hierarchical Fusion** — Sub-panels per topic → meta-judge
2. **Weighted Consensus** — Weight by model confidence/benchmarks
3. **Iterative Fusion** — Judge's blind spots → new panel queries
4. **Human-in-the-Loop** — Surface contradictions for clarification
5. **Citation Graph** — Map claims → panel responses → web sources
6. **Streaming Status** — "Consulting panel..." → "Analyzing..." → stream answer

---

This design captures the Fusion Router's key innovation: **separating deliberation (panel), meta-analysis (judge), and communication (outer model)** — each handled by the model best suited for it, with structured data flowing between stages.