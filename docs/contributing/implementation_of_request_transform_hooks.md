# Implementation: Request/Response Transform Hooks

Status: **complete** (as of 2026-07-26)
Design doc: [`../architecture/design_request_transform_hooks.md`](../architecture/design_request_transform_hooks.md)

---

## What was built

A two-tier, config-driven transform engine that rewrites request and response bodies at five
hook points in the proxy lifecycle. Per-model transform rules live in `proxy_config.toml`
— no handler code edits needed to add a new quirk for a new model.

---

## Architecture

### Five hook points

| Hook | Fires | Body shape | Where wired |
|------|-------|-----------|-------------|
| `request_ingress` | after inbound JSON parse, before routing | client schema | `src/index.ts` — centrally, once |
| `before_conversion` | inside handler, after routing, before format conversion | client schema | per-handler |
| `before_upstream` | inside handler, after format conversion, before `fetch` | upstream schema | per-handler |
| `after_upstream` | after `fetch` returns, before `!response.ok` check | upstream response schema | per-handler |
| `response_egress` | before returning `Response` to client | client response schema | `src/index.ts` (central, all four sub-steps) |

### Two-tier transform engine

**Tier 1 — generic ops** over shallow paths (top-level fields, `messages[role=X].field`):

| Op | Effect |
|----|--------|
| `rename` | rename a field, preserving value |
| `set` | force a field to a literal value |
| `default` | set only when field is absent |
| `remove` | delete a field |
| `map_value` | replace a specific value (supports `when_sibling` guard) |

**Tier 2 — named built-ins** for deep/cross-message logic:

| Built-in | What it does |
|----------|-------------|
| `lowercase_tool_schema_types` | recursively lowercases `type` values in `tools[].function.parameters` / `tools[].input_schema` |
| `recover_tool_message_name` | fills missing `name` in `tool` messages by looking up the matching `assistant.tool_calls[].function.name` via `tool_call_id` |

### Transform resolution order

Per-route effective transforms = **mode-defaults → sector-defaults → entry transforms**,
concatenated left-to-right. Within each set: `builtins` run before `ops`, `ops` run in
declaration order. A later op sees results of earlier ops.

---

## Key files

| File | Role |
|------|------|
| `src/utils/request-transform.ts` | Engine: `runHook`, `applyAfterUpstream`, `buildEventTransformer`, built-in implementations |
| `src/utils/config-loader.ts` | Types (`TransformSet`, `TransformOp`, `BuiltinName`), parsing (`parseTransformOpsInline`), validation (`validateTransformSet`, `validateAllTransforms`), resolution (`resolveTransforms`) |
| `proxy_config.toml` | Declared transform sets: `deepseek_compat`, `minimax_compat`, `max_tokens_rename`; `[transform_defaults]` binding mode defaults |
| `src/index.ts` | `request_ingress` and `response_egress` (all four sub-steps: streaming flag, body for JSON, SSE event transformer for streams, headers) applied centrally in `runAttempt` |
| `src/handlers/*.ts` | `before_conversion`, `before_upstream`, `after_upstream` wired per-handler |
| `tests/unit/request-transform.test.ts` | Engine unit tests |
| `tests/unit/transforms-config.test.ts` | Config parsing and validation tests |

---

## Config example

```toml
[transforms.deepseek_compat]
schema = "openai-completions"
request_ingress.builtins = ["lowercase_tool_schema_types"]
before_upstream.builtins = ["recover_tool_message_name"]
before_upstream.ops = [
  { op = "map_value", path = "messages[role=assistant].content", when_sibling = "tool_calls", from = "", to = null },
]

[transforms.minimax_compat]
schema = "openai-completions"
before_upstream.ops = [
  { op = "map_value", path = "messages[role=assistant].content", when_sibling = "tool_calls", from = "", to = null },
]

[transforms.max_tokens_rename]
schema = "openai-completions"
before_upstream.ops = [{ op = "rename", path = "max_tokens", to = "max_completion_tokens" }]

[transform_defaults]
openai-completions = ["max_tokens_rename"]
openai-responses   = ["max_tokens_rename"]

[models.free]
deepseek-v4-comp = { target = "deepseek-v4-flash", base_url = "https://api.deepseek.com", api_key = "…", transforms = "deepseek_compat" }
max-m3-comp      = { target = "MiniMax-M3",        base_url = "https://api.minimaxi.com", api_key = "…", transforms = "minimax_compat" }
```

---

## What was migrated / removed

| Was | Now |
|-----|-----|
| Inline `normalizeJsonSchemaTypes` + tool-patch loops in `chat-completions.ts` | `lowercase_tool_schema_types` + `recover_tool_message_name` builtins in `deepseek_compat` |
| `mapMaxTokensForUpstream` / `shouldUseMaxCompletionTokens` in `routing.ts` (hostname `includes` check) | `max_tokens_rename` transform set, bound as mode-default for `openai-completions` / `openai-responses` |
| `fillMissingToolMessageNames` unconditional call in `handleOpenAIRequest` (applied to all routes) | `recover_tool_message_name` builtin in `deepseek_compat` (applied only to DeepSeek routes) |
| Dead functions in `gemini.ts`: `handleGeminiToOpenAIMode`, `handleOpenAIStreamingToClaude`, `handleGeminiToGeminiMode` (~265 lines) | Deleted |

---

## `after_upstream` wiring (12 fetch sites)

`applyAfterUpstream(response, ctx)` buffers the upstream JSON body, applies `after_upstream`
ops, and returns a new `Response`. Non-JSON bodies (SSE streams) are passed through unchanged.
Fast-path: exits immediately when no `after_upstream` transforms are declared.

Wired at every non-streaming fetch site:

- `openai.ts`: `forwardCompletionsAsOpenAIResponses`, main `handleOpenAIRequest`
- `claude.ts`: `handleClaudeRequest`
- `messages.ts`: openai-passthrough→openai-responses, openai-passthrough→openai-completions, claude-upstream→openai-responses, claude-upstream→openai-completions
- `responses.ts`: `handleAsCompletions`, `handleAsPassthrough`, `handleResponsesInputTokensRequest` (completions path + passthrough path), `handleResponsesCompactRequest` (completions path + passthrough path)
- `chat-completions.ts`: anthropic-messages path, openai-responses path, direct passthrough
- `gemini.ts`: `handleGeminiInteractionsRequest`, `handleGeminiGenerateContentRequest`

---

## Tests

165 unit tests across 9 files, all passing. `npx tsc --noEmit` is clean.

- `tests/unit/request-transform.test.ts` — Tier-1 ops, built-ins, `runHook` fast-path, `buildEventTransformer`, `applyAfterUpstream`, `applyWriteoutBody`, `pipeEventTransformer`, `hasHookOps`
- `tests/unit/transforms-config.test.ts` — config parsing, two-pass validation, resolution, inline-table transform field, `$response.*` path rules
- `tests/unit/routing.test.ts` — routing and mode resolution
- `tests/unit/think-tag-extraction.test.ts` — `think`-tag extraction into the three response shapes (Claude / Responses / Gemini)
- `tests/unit/thinking-roundtrip.test.ts` — multi-turn thinking-content preservation (Step 14)
- (plus 4 unrelated test files for handlers, validations, SDK URL handling, and the Claude-OAuth tokenizer)

---

## `response_egress` body ops (Step 11)

Closes the deferred gap from the original design. `applyWriteoutBody`
(mirrors `applyAfterUpstream`, but on the client-schema response) and
`pipeEventTransformer` (wraps an SSE byte stream so each event passes through
the writeout hook's per-event transformer before being written back) are both
implemented in `src/utils/request-transform.ts` and wired centrally in
`src/index.ts`'s `runAttempt`.

`hasHookOps(hook, transforms)` provides a fast-path gate so the streaming and
JSON-buffering work is skipped entirely when no set declares ops for a given
hook. A throwaway `writeout_marker` transform (in `proxy_config.toml`, attached to
`deepseek-v4-comp`) was used to verify end-to-end wiring: a `curl /v1/messages`
returns the response with `id` rewritten to `"step12_response_path_active"` via
`$response.id`, without creating a literal `"$response.id"` field.

### `$response.*` path prefix (Step 12)

The `$response.<field>` prefix is supported for shallow response-body fields.
The prefix is stripped before the generic op runs, so `$response.id` targets the
body's `id` field for `set`, `default`, `remove`, `rename`, and `map_value`.
Response paths with nested array/object traversal (for example,
`$response.choices[].message.content`) remain outside the shallow path runner.

### Step 13a — validator rejects unwalkable nested paths

The schema-vocabulary whitelist (`SCHEMA_PATHS`) accepted nested response
paths that the Tier-1 op runner cannot actually execute (`parsePath` only
handles single-segment targets). A nested path like
`$response.choices[].message.content` would have produced a *literal-bracketed*
key on the response body — silent corruption rather than a no-op, violating
CLAUDE.md §8. The fix was a two-pass validator: schema-whitelist first, then a
new `isPathWalkable(path)` predicate that accepts only paths the engine can
resolve. Anything deeper is now a hard config-load error pointing authors at
the named built-ins or a shallow path.

Tests cover: nested `$response`, shallow `$response.<field>`, nested
`messages[].<sub>`, cross-schema rejection, and a belt-and-suspenders test in
the engine that asserts a defensive transform never produces a literal-bracketed
key even if the validator were bypassed.

---

## Multi-turn thinking-content round-trip (Step 14)

Surfaced by the same `tests/multi-agents-test.ts` (4 models × all agents ×
task #2) live run on port `7777` that exercises the engine end-to-end. DeepSeek
thinking-mode rejects multi-turn requests whose prior assistant turn is missing
the reasoning it originally produced:

```
The 'reasoning_content' in the thinking mode must be passed back to the API
The 'content[].thinking' in the thinking mode must be passed back to the API
```

The transform engine is **not** the cause — Tier-1 ops and the existing built-ins
never touch `reasoning_content` or `content[].thinking`. The bug was in the
pre-existing conversion code that the engine operates on. Two patching sites
were fixed, both inside the existing conversion layer rather than the engine
itself (the engine's contract is "you'll hand me a target-format body; I rewrite
shallow fields"). This keeps the engine simple and avoids teaching it
format-vocabulary distinctions.

### Smoking-gun #1 — `convertClaudeToOpenAIRequest` and `convertClaudeTokenCountingToOpenAI` (`src/converters/claude-to-openai.ts`)

Both functions iterated assistant content blocks but had no branch for
`type: 'thinking'`. The thinking block was silently dropped on the way to the
`openai-completions` upstream. Each now accumulates a `thinkingParts: string[]`
alongside `textParts` / `toolCalls` and emits the joined string as a per-message
`reasoning_content` field, using the existing
`as unknown as Record<string, unknown>` cast pattern established in
`responses-to-completions.ts:194-196` and `openai.ts:444`.

### Smoking-gun #2 — `completionsMessagesToResponsesInput` (`src/handlers/messages.ts`)

The previous helper had a `return null` for `thinking` content parts in the
Completions → Responses conversion path, dropping the prior turn's reasoning on
`/v1/messages` → `openai-responses`. Rewritten to emit a Responses-side
`reasoning` input item with a single `reasoning_text` content part whenever the
source carries either a per-message `reasoning_content` field or an array-style
`{type:'thinking'}` content part.

### Tests

`tests/unit/thinking-roundtrip.test.ts` (7 cases): covers both smoking guns
plus negative cases (no spurious `reasoning_content` / `reasoning` item when
there's nothing to round-trip) and the multi-thinking-block join. The
`completionsMessagesToResponsesInput` helper is not exported, so the test file
contains a verbatim copy with a comment asserting that a divergence should be
treated as a failure — the goal is to detect a future refactor that silently
breaks the round-trip.

### Why not make this a transform-engine built-in?

Considered, rejected. The reasoning fields exist on different layers of two
different upstream-format vocabularies (`reasoning_content` is a per-message
field on Completions; `content[].thinking` is a content part on Anthropic
format; `input[]` items on Responses). Forcing those distinct representations
through a single shallow-path Tier-1 op would require either (a) flattening
across formats first (which the converter already does) or (b) introducing
format-aware path semantics into the engine. Both options expand the engine's
surface area for a single upstream's quirk. Patching the converter keeps the
concern at the layer where the format vocabulary already lives.

### Live verification

Direct curl against `PORT=7777 DEV_NO_KEY=true` (/v1/chat/completions passthrough is always on; the former `DEV_PASS_THROUGH=true` flag was removed):

- `POST /v1/messages` to `deepseek-v4-comp` with `thinking.budget_tokens=1024`
  and a 3-turn history (turn-2 assistant has `{type:"thinking"}` and
  `{type:"text"}` blocks, turn-3 user asks a follow-up) returns **200**.
  DeepSeek accepts the request — prior reasoning round-trips end-to-end.
  The proxy response also shows the throwaway `writeout_marker` rewrite
  (`id → "step12_response_path_active"`), confirming the new build is live.

Multi-agent run (`npx tsx tests/multi-agents-test.ts 0 0 2`) post-fix:

- The `reasoning_content must be passed back` failure mode no longer
  reproduces on the multi-turn shape that triggered it before the fix.
- Residual failures observed in the same run are **separate, pre-existing
  bugs explicitly out of scope for this entry**:
  - Anthropic-format `tool_use`/`tool_result` pairing invariant on
    `deepseek-v4-anth` (different bug — Claude-format pairing invariant,
    not a thinking-content issue). **Fixed in Step 15 below.**
  - Agent SDK package not on disk: `@earendil-works/pi-agent-core`.
  - CLI not on PATH: `opencode`.
  - Codex returning empty output on `openai-responses` for reasons
    unrelated to thinking content.

---

## Anthropic tool_use/tool_result pairing injection (Step 15)

Surfaced by the same `tests/multi-agents-test.ts 0 0 2` run: Codex agent
against `deepseek-v4-anth` failed with:

```
messages.10:`tool_use` ids were found without `tool_result` blocks
immediately after: call_01_03Gzqg0ZesbKUPXLqCUP0307,
call_02_eiiMJfdmKVzoCro2OGCk3825. Each `tool_use` block must have a
corresponding `tool_result` block in the next message.
```

DeepSeek's Anthropic-compatible endpoint enforces that every `tool_use.id`
in an assistant message is followed by a matching `tool_result.tool_use_id`
in the immediately following user message. When the client (Codex SDK via the
OpenAI Responses API) truncates or omits tool results from conversation
history, the upstream rejects the request.

### Why a new built-in (not Tier-1 ops or a converter patch)

Tier-1 ops can only modify a single shallow field — they cannot walk adjacent
message pairs. A converter patch would only fix one entry point. A new Tier-2
built-in mirrors the existing `recover_tool_message_name` pattern and is
gated by schema (`anthropic-messages`), so it only fires on the one upstream
that enforces the invariant.

### Algorithm

`inject_missing_tool_results` runs a single forward pass over `body.messages`.
For each assistant message with `tool_use` blocks:

**Step A — skip interleaved text-only assistant messages** (the Codex SDK via
Responses API sometimes emits the same turn as two consecutive Completions
messages: one with `tool_calls`, one with text content). These become two
consecutive `assistant` messages in the Anthropic body with the `tool_result`
user messages landing AFTER the text assistant. DeepSeek requires the
`tool_result` user message to be IMMEDIATELY after the `tool_use` assistant.
We collect the text-only assistants into a tail list, then re-insert them
after the consolidated `tool_result` message.

**Step B — merge consecutive pure-tool user messages**: when multiple
`role:"tool"` Completions messages follow one assistant turn (one per call),
each becomes its own `user` message. Anthropic spec requires all tool_results
for one turn in a single user message. We merge all consecutive pure-tool user
messages into one by collecting their blocks.

**Step C — synthesize missing tool_result blocks**: after merging, if any
`tool_use.id` still lacks a matching `tool_result`, synthesize a placeholder
block with `content: ''`.

**Restructure**: the three steps are combined — after collecting all
`tool_result` blocks (existing + synthesized), the slice `[i+1 .. j+k-1]` is
replaced with `[consolidated_user_msg, ...tail_text_assistants]`. This ensures
DeepSeek sees `tool_use_assistant → user(only tool_results) → text_assistant`.

### Wiring gap found during verification

`handleAsAnthropicMessages` in `src/handlers/responses.ts` was missing a
`before_upstream` hook call — it built the Anthropic-format body and fetched
directly without applying transforms. Added `route` and `upstreamMode`
parameters and wired `runHook('before_upstream', ...)` before fetch (mirrors
the existing pattern in `handleAsCompletions` in the same file).

### Config

```toml
[transforms.deepseek_v4_anthropic_compat]
schema = "anthropic-messages"
before_upstream.builtins = ["inject_missing_tool_results"]

# in [models.free]:
deepseek-v4-anth = { ..., mode = "anthropic-messages", transforms = "deepseek_v4_anthropic_compat" }
```

### Tests

10 unit tests in `tests/unit/request-transform.test.ts`:

1. Inserts new user message with tool_result when next user message has
   text content array (pure-insert path).
2. Inserts new user message when next user message has string content.
3. Inserts new user message with multiple missing tool_result blocks.
4. Appends synthesized missing block to existing pure-tool_result user message.
5. No-op when all tool_results already present in single message.
6. No-op when assistant has no tool_use blocks.
7. No-op when assistant is followed by another assistant (no user follows).
8. Merges consecutive pure-tool user messages into one.
9. Merges consecutive pure-tool messages and synthesizes still-missing ids.
10. Split-assistant: moves consolidated tool_results before text-only assistant.

### Live verification

`POST /v1/responses` with model `deepseek-v4-anth` and a 3-item input
containing a `function_call` item followed by a user message (no
`function_call_output`) → **HTTP 200**. The proxy inserted a synthetic
`tool_result` user message before the text user message; DeepSeek accepted
and returned a valid response.

Multi-agent run `tests/multi-agents-test.ts 0 0 2` post-fix: the
`tool_use ids were found without tool_result blocks` error no longer
reproduces for Codex agent against `deepseek-v4-anth`. The fix required
three iterations to handle all patterns the Codex SDK emits.

