# Routing Transform Review

This note reviews the current cross-mode routing strategy for Gemini-style client endpoints, especially `/v1/interactions` routed to `anthropic-messages` or `openai-responses`.

## Summary

Direct transforms are better long-term for `/v1/interactions` → `anthropic-messages` and `/v1/interactions` → `openai-responses`.

The current indirect path through `openai-completions` is still a reasonable short-term implementation because it reuses existing conversion code and already supports text, basic tool calls, and streaming text deltas.

## Current indirect paths

| Route | Current path |
|---|---|
| `/v1/interactions` → `anthropic-messages` | Interactions → Chat Completions → Claude Messages → Interactions |
| `/v1/interactions` → `openai-responses` | Interactions → Chat Completions → Responses → Interactions |

In both routes, `openai-completions` / Chat Completions is used as a middle mode.

## Preferred direct paths

| Route | Preferred path |
|---|---|
| `/v1/interactions` → `anthropic-messages` | Interactions → Claude Messages → Interactions |
| `/v1/interactions` → `openai-responses` | Interactions → Responses → Interactions |

These direct paths avoid forcing Interactions semantics through Chat Completions first.

## Why direct transforms are better

### 1. Less semantic loss

Chat Completions is not a perfect middle format for Interactions.

Using it as a bridge can flatten or drop endpoint-specific fields, including:

- Interactions metadata
- Gemini-style content parts
- multimodal content
- structured output fields
- provider-specific tool-call details
- richer streaming event types

A direct converter can preserve the client endpoint's semantics more accurately.

### 2. Cleaner tool-call mapping

Direct mapping is simpler:

- Interactions tool call → Claude `tool_use`
- Interactions tool result → Claude `tool_result`
- Interactions tool call → Responses `function_call`
- Interactions tool result → Responses `function_call_output`

The current indirect route adds another translation step:

- Interactions tool call → Chat Completions `tool_calls` → Claude/Responses tool format

That extra hop creates more places where IDs, argument JSON, function names, or tool-result records can drift.

### 3. Better streaming correctness

A direct streaming converter can map upstream events straight back to Interactions events:

- Claude Messages SSE → Interactions SSE
- OpenAI Responses SSE → Interactions SSE

The current indirect implementation converts streaming text deltas through a synthetic Chat Completions chunk. That is enough for text deltas, but it is less suitable for richer stream events such as tool-call deltas, reasoning deltas, multimodal parts, or provider-specific lifecycle events.

### 4. Fewer conversions and easier debugging

Direct transform has one conceptual boundary:

```text
Interactions ↔ target upstream format
```

Indirect transform has two:

```text
Interactions ↔ Chat Completions ↔ target upstream format
```

When a field is missing or malformed, the indirect path makes it harder to identify which conversion caused the issue.

### 5. More accurate API model

If `/v1/interactions` is treated as a first-class client endpoint, it should eventually have first-class converters to each upstream family.

The indirect bridge is useful for implementation speed, but it should not be treated as the ideal architecture for high-fidelity Interactions support.

## Why the indirect path is acceptable now

The current indirect implementation is acceptable for the current feature scope because it:

- reuses existing Chat Completions conversion code
- avoids adding a parallel converter stack immediately
- supports simple text requests
- supports basic tool calls
- supports streaming text deltas
- preserves the original client endpoint response shape
- has regression tests for the supported behavior

For mostly text-based and basic tool-use workloads, this is likely sufficient.

## Recommendation

Keep the current indirect path if the goal is working cross-mode routing with minimal code duplication.

Prefer direct transforms when `/v1/interactions` needs stronger endpoint fidelity, especially for:

- richer tool-call streaming
- multimodal content
- structured output
- provider-specific metadata
- reasoning/thinking deltas
- exact Interactions event semantics

Suggested future routes:

| Route | Recommendation |
|---|---|
| `/v1/interactions` → `anthropic-messages` | Add direct Interactions ↔ Claude Messages converters |
| `/v1/interactions` → `openai-responses` | Add direct Interactions ↔ OpenAI Responses converters |
| `:generateContent` → `anthropic-messages` | Consider direct generateContent ↔ Claude Messages converters if Gemini fidelity becomes important |
| `:generateContent` → `openai-responses` | Consider direct generateContent ↔ Responses converters if Gemini fidelity becomes important |

## Documentation wording

Recommended wording for the current implementation:

> `/v1/interactions` to `anthropic-messages` / `openai-responses` currently uses an indirect transform via `openai-completions` for code reuse. This supports text, basic tool calls, and streaming text deltas, but a future direct transform would preserve endpoint semantics more accurately.
