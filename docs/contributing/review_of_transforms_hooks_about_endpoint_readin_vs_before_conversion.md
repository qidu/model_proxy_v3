# `endpoint_readin` vs `before_conversion` — Names are Inverted vs. Reality

## Summary

The names are **inverted** vs. what they actually describe:

| Hook | Name implies | Reality |
|------|-------------|---------|
| `endpoint_readin` | "this endpoint's input" | fires **for all endpoints** — it's the universal first seam, central in `index.ts` |
| `before_conversion` | "generic, before the format converter" | fires **only inside specific handlers** — it only exists where a handler decides to call it, meaning it's endpoint-aware by placement |

## The Reality

- **`endpoint_readin`** — fires at the *start of the request pipe* (no endpoint semantics), then the rebuilt `Request` continues to whichever handler gets dispatched. The "endpoint" in the name is misleading — it's **endpoint-agnostic**.
- **`before_conversion`** — fires *inside the chosen handler*, right before that handler calls its format converter. Which handler fires it depends on the route/dispatch. It's **endpoint-aware by construction**.

## Better Naming Options

The current names encode **mechanics** (read-in vs. before-conversion) rather than **semantics** (universal-first vs. handler-local). Suggested alternatives:

```
client_ingress          # fires once, centrally, before routing/handler decision
  ↓
[dispatch to handler]
  ↓
handler_pre_conversion   # fires inside handler, before that handler's format converter
  ↓
[handler calls completionsToXxxBody / etc.]
  ↓
upstream_ingress        # (before_upstream — already accurate)
```

Or more simply:

```
pre_handler             # endpoint_readin — before any handler is chosen
in_handler              # before_conversion — inside the chosen handler, before conversion
```

## Source Evidence

**`endpoint_readin`** — wired centrally in `src/index.ts:2020–2044` inside `runAttempt()`, once per route attempt, before any handler dispatch:

```ts
// endpoint_readin: apply transforms to the inbound body before any handler sees it.
if (attemptRoute && attemptRoute.transforms.length > 0) {
  const bodyText = await attemptRequest.clone().text();
  // ...
  const transformed = runHook('endpoint_readin', { body: parsedBody, headers }, hookCtx);
  // Rebuild the Request so the transformed body propagates downstream
  attemptRequest = new Request(attemptRequest.url, {
    body: JSON.stringify(transformed.body),
  });
}
```

This runs regardless of which handler will ultimately handle the request.

**`before_conversion`** — wired inside specific handlers, before each handler's own format converter call:

- `src/handlers/responses.ts:621` — before `convertResponsesToChatCompletions`
- `src/handlers/openai.ts:940` — before the `isGeminiInteractionsRequest` check and format detection
- `src/handlers/messages.ts:556` — before `convertClaudeToOpenAIRequest`
- `src/handlers/gemini.ts:381` — before the Gemini format conversion

It is **not wired** in the other 4 handlers: `chat-completions.ts`, `claude.ts`, `openai.ts` (main passthrough paths), `messages.ts` (openai-passthrough paths). Its existence depends on which handler branch is taken.

## Practical Decision Guide

Write a rule in `endpoint_readin` when:

- The fix is target-agnostic (any path → any upstream).
- A `Request`-level JSON round-trip is acceptable.
- The rule must apply to every handler and retry loop.

Write a rule in `before_conversion` when:

- The fix depends on the handler's typed view (e.g. parsed `system` field in Claude shape, pre-conversion).
- You want the rule to skip for specific handler modes (e.g. `openai.ts:940` only fires for OpenAI inbound, `gemini.ts:381` only for Gemini).
- You want to mutate without the fidelity loss of JSON round-tripping.

For the vast majority of cases — uppercase types, max_tokens rename, content-empty-to-null, schema quirks — `endpoint_readin` and/or `before_upstream` are the right place. `before_conversion` is a niche seam for rare per-handler "massage the typed body right before the converter runs" cases.
