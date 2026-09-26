# Proposal: Zod as the Schema Validation Layer for Model Proxy v3

Status: **Draft / Proposal** — not yet approved for implementation.
Owner: (unassigned)
Last updated: 2026-08-07

---

## 1. Goals

Bring all inbound request validation and all upstream response parsing in the proxy
under a single, declarative schema layer using [Zod](https://zod.dev/api). Today
the proxy relies on hand-rolled `if`/`throw` checks (see `src/utils/validation.ts`)
plus ad-hoc `as Record<string, unknown>` casts in handlers. This proposal replaces
that with Zod schemas that are:

1. **Authoritative** — one schema per endpoint/upstream is the single source of truth
   for the shape; the TypeScript types in `src/types/*.ts` are derived from the
   schemas (`z.infer<typeof ...>`), not maintained separately.
2. **Bidirectional** — every endpoint has both an **inbound request schema** (validate
   what the client sends) and the relevant **upstream response schemas** (safe-parse
   what the provider returns before conversion).
3. **Conversion-aware** — the converter boundary (`claude→openai`, `openai→claude`,
   `responses↔completions`, `*→gemini`, `gemini→*`) is guarded by schemas on both
   sides so a bug in one converter cannot silently emit malformed input to the next.

### Non-goals

- Replacing the **streaming SSE delta** parser wholesale with Zod. SSE deltas are
  incremental and high-frequency; full per-event parsing is too costly. We validate
  the *envelope* and the *first/last* events only (see §7).
- Validating **sidecar** (privacy-filter, kompress, image-encode) request/response
  bodies. Those are out of scope for this pass.
- Validating the **dashboard/admin** API surface. Those are internal; leave as-is.

---

## 2. Current-state gap analysis

| Surface | Today | Gap |
|---|---|---|
| `/v1/messages` request | `validateClaudeMessagesRequest` (hand-rolled, ~300 LOC) | Duplicates the `ClaudeMessagesRequest` type; rules drift from spec |
| `/v1/messages/count_tokens` | `validateClaudeTokenCountingRequest` | Same |
| `/v1/chat/completions` (passthrough) | `validateOpenAICompletionsRequest` | Fires on the always-on passthrough path (formerly `DEV_PASS_THROUGH`-gated); conversion path is unchecked |
| `/v1/responses`, `/v1/responses/compact`, `/v1/responses/input_tokens` | none — `await request.json() as Record<string, unknown>` | No validation at all |
| `/v1/interactions` (Gemini) | none | Relies entirely on upstream rejection |
| `/v1beta/.../generateContent`, `streamGenerateContent` | none | Same |
| `/v1/embeddings` | none | Same |
| `/v1/models` | `validateModelsRequestParams` (query only) | OK; minor |
| Upstream **responses** (all providers) | none — converters assume well-formed input | A malformed upstream response crashes the converter with an opaque stack trace |
| Converter **outputs** | none | A bug in `claude→openai` can produce a body the OpenAI upstream rejects — surfaced as upstream error, not proxy error |
| `thinking` config (budget clamping, interleaved exception) | `clampThinkingBudget` + `validateThinkingConfig` | Logic is correct but tangled with validation; Zod `.refine`/`.transform` can host it declaratively |

Key files: `src/utils/validation.ts`, `src/handlers/messages.ts`, `src/handlers/responses.ts`,
`src/handlers/openai.ts`, `src/handlers/gemini.ts`, `src/handlers/chat-completions.ts`,
`src/handlers/token-counting.ts`, `src/handlers/embeddings.ts`,
`src/converters/*.ts`, `src/types/{claude,gemini,openai,shared}.ts`.

---

## 3. Zod feature inventory relevant to this proxy

Selected from <https://zod.dev/api>; mapped to proxy needs.

| Zod feature | Where we use it |
|---|---|
| `z.object`, `z.array`, `z.string`, `z.number`, `z.boolean` | Everywhere — basic shape |
| `z.discriminatedUnion` (on `type`) | All content-block unions: Claude `ClaudeContentBlock`, Gemini `GeminiContent`, OpenAI `OpenAIContentPart`, all SSE event unions |
| `z.union` | Tool-choice shapes (`auto | any | tool | none`) where there is no clean discriminator |
| `z.literal`, `z.enum` | Roles (`user|assistant|system|tool|developer`), finish reasons, modality enums, mime types |
| `.passthrough()` / `z.looseObject()` | Upstream-response parsing: keep unknown keys so provider-specific extras survive conversion |
| `.strict()` / `z.strictObject()` | Inbound-request parsing for fields we own: reject unknown keys that would silently be dropped |
| `.optional()`, `.default()`, `.catch()` | Defaults (e.g. `max_tokens` from `DEFAULT_MAX_TOKENS`), safe fallbacks for flaky upstream fields |
| `.refine()`, `.superRefine()` | Cross-field rules: `thinking.budget_tokens < max_tokens`, message-array non-empty, tool-call id uniqueness |
| `.transform()` | `clampThinkingBudget` becomes a transform; `system: string | ClaudeTextBlock[]` normalisation |
| `.preprocess()` | Coercion of query-string params (`limit` string→number) in `/v1/models` |
| `.brand()` | Optional: brand validated upstream URLs to prevent raw strings leaking into `fetch()` |
| `.catchall()` | `metadata`-style catch-all maps |
| Recursive schemas (getter) | Not needed today (no recursive content), but available if Anthropic adds nested tool results |

**Zod version:** pin `zod@^4.1` (current line; `.check()` / codecs land there). The proxy
targets Node ≥19 and Cloudflare Workers — both supported.

---

## 4. Endpoint inventory and per-endpoint plan

Endpoints are taken from `src/index.ts` (route dispatch).

Legend:
- **Inbound schema** = validate the client's JSON body / query.
- **Upstream modes** = the protocols the proxy may forward to from this endpoint
  (each mode needs its own *request* and *response* schema — see §5).
- **Strictness** = `strict` (reject unknown keys) for inbound, `loose` (keep unknown keys)
  for upstream responses.

### 4.1 `/v1/messages` (Claude Messages)

- **Inbound**: `ClaudeMessagesRequestSchema` (strict on owned fields, but allow
  provider-extension keys under a `.catchall(z.unknown())` so Anthropic beta headers
  like `anthropic-beta`-gated fields don't bounce).
- **Upstream modes** (`MESSAGES_UPSTREAM_MODE`):
  - `native` → forward Claude body verbatim; parse upstream response with
    `ClaudeMessagesResponseSchema` (loose).
  - `openai-completions` → convert via `claude→openai`; parse upstream with
    `OpenAIResponseSchema` / `OpenAIStreamChunkSchema` (loose).
- **Subtleties** to encode:
  - `system` is `string | ClaudeTextBlock[]` — use `z.union([z.string(), z.array(...)])`.
  - `thinking` clamping: `.transform()` that folds in `max_tokens` and the
    `interleaved-thinking` beta flag (currently `clampThinkingBudget`).
  - Role enum currently allows `system` in `validateClaudeMessage` but the Claude
    spec puts `system` at top level. **Surface conflict to resolve before coding**
    (see §9 Q1).

### 4.2 `/v1/messages/count_tokens`

- **Inbound**: `ClaudeTokenCountingRequestSchema` (subset of messages; no `max_tokens`).
- **Upstream**: native Anthropic `/v1/messages/count_tokens` OR local tiktoken.

### 4.3 `/v1/responses`, `/v1/responses/compact`, `/v1/responses/input_tokens`

- **Inbound**: `OpenAIResponsesRequestSchema` — currently **unvalidated**. The Responses
  API `input` field is polymorphic (string | item | item array), a good fit for
  `z.union` with a discriminator on `type`.
- **Upstream modes** (per `handleResponsesRequest`):
  - passthrough (OpenAI Responses native)
  - `openai-completions` (Responses → Completions → upstream)
  - `anthropic-messages` (Responses → Completions → Claude body → upstream)
  - `gemini-generateContent` / `gemini-interactions`
- **Compact** variant shares the input schema, differs only on the output transform.

### 4.4 `/v1/chat/completions`

- **Inbound**: `OpenAIRequestSchema` (already partly specified in
  `validateOpenAICompletionsRequest`; extend to cover `tools`, `tool_choice`,
  `response_format`, `reasoning_effort`).
- **Upstream**: usually passthrough (`/v1/chat/completions`, always on since `DEV_PASS_THROUGH` was removed) or converted to Claude/Gemini.
- **Streaming**: chunk schema is `loose` — OpenAI-compatible providers emit many
  proprietary keys (`reasoning_content`, `prompt_filter_results`, …).

### 4.5 `/v1/interactions` (Gemini Interactions)

- **Inbound**: `GeminiInteractionRequestSchema` — currently unvalidated. Polymorphic
  `input` (string | `Content` | `Content[]` | `Turn[]`) is a four-way union.
- **Sub-actions** (different HTTP verbs/methods on the same path prefix):
  - `POST /v1/interactions` — create
  - `GET /v1/interactions/{id}` — retrieve (with optional `stream`, `last_event_id`)
  - `DELETE /v1/interactions/{id}` — delete
  - `POST /v1/interactions/{id}/cancel` — cancel
- **Upstream modes** (`INTERACTIONS_UPSTREAM_MODE`): `native` (Gemini) or
  `openai-completions`.
- **Response**: `GeminiInteractionResponseSchema` (loose) — `status` enum, `outputs`
  as `z.array(GeminiContentSchema)`, `usage` with the modality-breakdown sub-arrays.

### 4.6 `/v1beta/models/{model}:generateContent` and `:streamGenerateContent`

- **Inbound**: `GeminiGenerateContentRequestSchema` (the classic Gemini shape —
  `contents`, `system_instruction`, `tools`, `generationConfig`). The proxy
  historically uses the Interactions types; confirm whether generateContent still
  flows through (see §9 Q2).
- **Upstream modes** (`GENERATE_CONTENT_UPSTREAM_MODE`): `native` or `openai-completions`.

### 4.7 `/v1/embeddings`

- **Inbound**: `OpenAIEmbeddingsRequestSchema` — `model`, `input` (string | string[]),
  optional `encoding_format`, `dimensions`.

### 4.8 `/v1/models` (GET)

- **Inbound (query)**: `ModelsListQuerySchema` via `.preprocess()` to coerce
  `limit` string→number. Already mostly covered by `validateModelsRequestParams`.

---

## 5. Upstream inventory and per-upstream plan

Each upstream has two schemas: the **request** we send to it (validated *after*
conversion, before `fetch`) and the **response** we get back (safe-parsed before
the reverse converter runs).

| Upstream | Request schema (post-conversion) | Response schema (loose) | Streaming envelope |
|---|---|---|---|
| Anthropic Messages | `ClaudeMessagesRequestSchema` (strict) | `ClaudeMessagesResponseSchema` | `ClaudeStreamEventSchema` (discriminated on `type`) |
| OpenAI Chat Completions | `OpenAIRequestSchema` (strict) | `OpenAIResponseSchema` | `OpenAIStreamChunkSchema` |
| OpenAI Responses | `OpenAIResponsesRequestSchema` (strict) | `OpenAIResponsesResponseSchema` | responses SSE event union |
| Gemini GenerateContent | `GeminiGenerateContentRequestSchema` | `GeminiGenerateContentResponseSchema` | array of candidates |
| Gemini Interactions | `GeminiInteractionRequestSchema` | `GeminiInteractionResponseSchema` | `GeminiSSEEventSchema` (discriminated on `event_type`) |
| Embeddings | `OpenAIEmbeddingsRequestSchema` | `OpenAIEmbeddingsResponseSchema` | n/a |

**Strict/loose rule of thumb:**
- Schemas applied **before** `fetch` (inbound client request, post-conversion
  upstream request) are **strict** — unknown keys mean a bug and should fail loud
  (project rule §8 Fail Loud).
- Schemas applied **after** `fetch` (upstream response, converter input) are **loose**
  (`.passthrough()` / `z.looseObject()`) — providers add fields; we must not break.

---

## 6. Conversion-boundary guards

Every converter in `src/converters/` currently takes `unknown`-ish input and returns
an untyped object. Wrap each converter call site:

```ts
// pseudo-code — shape only, not a commitment to names
const result = convertClaudeToOpenai(
  ClaudeMessagesRequestSchema.parse(inbound)        // validated input
);
OpenAIRequestSchema.parse(result);                  // validated output
```

Failure of the *output* schema is a proxy bug (Fail Loud → 500 with a clear internal
error). Failure of the *input* schema is a client error (400).

Converter files to wrap:
`claude-to-gemini.ts`, `claude-to-openai.ts`, `openai-to-claude.ts`,
`openai-to-gemini.ts`, `gemini-to-claude.ts`, `completions-to-responses.ts`,
`responses-to-completions.ts`, plus the streaming variants
(`streaming.ts`, `gemini-streaming.ts`).

---

## 7. Streaming strategy

SSE is the highest-volume path; per-event Zod parsing is too expensive.

**Approach:**
1. **Envelope only, per event.** Validate that each SSE chunk decodes to a JSON
   object with a recognised discriminator key (`type` for Claude/OpenAI,
   `event_type` for Gemini). Do **not** deeply validate delta fields.
2. **Full validation on terminal events.** `message_stop` / `interaction.complete`
   / `[DONE]` carry the final `usage`; validate those fully so token accounting
   (`dashboard-stats.ts → createUsageTrackingTransformStream`) reads trustworthy
   numbers.
3. **Safe-parse, never throw.** Use `.safeParse()`; on failure, log with
   `requestId` and pass the raw event through. Streaming must never abort mid-stream
   because of one malformed event (project rule §8 — but here the loud failure is
   the log line + a metric counter, not a thrown error, because tearing down an
   in-flight stream is worse for the client).

---

## 8. Error mapping

`ZodError` → proxy error response. Add a single mapper in
`src/utils/errors.ts` (or a new `src/utils/zod-errors.ts`):

| Inbound failure | HTTP | Body shape |
|---|---|---|
| Client request schema | 400 | Provider-appropriate error envelope: Claude `{"type":"invalid_request_error", ...}` / OpenAI `{"error":{"type":"invalid_request_error",...}}` / Gemini `{ "error": { "code": 400, ... } }` — pick by inbound path |
| Post-conversion (converter output) | 500 | "proxy internal conversion error", `requestId` included |
| Upstream response safe-parse | pass through, log warn | Do **not** error the request; the upstream said it |

The mapper must flatten `ZodError.issues` (`path`, `message`, `code`) into the
provider's error envelope so SDK clients see a native-looking error.

---

## 9. Open questions / conflicts to surface

Per project rule §5 (Surface Conflicts, Don't Blend):

- **Q1 — `system` role.** `validateClaudeMessage` accepts `role: 'system'` inside
  `messages[]` (`validation.ts:137`), but the Claude spec and
  `ClaudeMessage.role` (`types/claude.ts:105`) restrict messages to
  `user | assistant` and put `system` at top level. Which is authoritative for the
  new schema? *(The current code blends both.)*
- **Q2 — generateContent routing.** `types/gemini.ts` defines Interactions types
  only; the README claims a `/v1beta/...:generateContent` inbound path and a
  `GENERATE_CONTENT_UPSTREAM_MODE` exists in `Env`. Is generateContent actually
  served, or is it upstream-only? This decides whether §4.6 needs an inbound schema.
- **Q3 — Responses-API streaming envelope.** OpenAI Responses streaming uses a
  different event taxonomy than Chat Completions (`response.created`,
  `response.output_item.added`, …). Confirm we want a full discriminated union or
  just envelope+terminal.
- **Q4 — `as any` audits.** `validateClaudeMessagesRequest` reads
  `(request as any).metadata` (`validation.ts:105`). Should metadata be in the
  schema officially or stay as passthrough?
- **Q5 — Bundle size / Workers.** Zod adds ~50 KB to the Worker bundle. Confirm
  acceptable; if not, evaluate `zod-mini`.

---

## 10. Phased migration plan

Each phase is independently shippable; each ends green on `npm run test:unit` and
`npm run typecheck`.

**Phase 0 — dependency & scaffold (no behavior change)**
- Add `zod@^4.1` to `dependencies`.
- Create `src/schemas/` with one file per API family (`claude.ts`, `openai.ts`,
  `gemini.ts`, `shared.ts`). Re-export `z.infer` types that **replace** the
  hand-written interfaces in `src/types/*.ts` (delete the old interfaces in the
  same PR per family — no dual sources of truth).

**Phase 1 — inbound request validation (replace `validation.ts`)**
- Implement inbound schemas for `/v1/messages`, `/v1/messages/count_tokens`,
  `/v1/chat/completions`, `/v1/responses*`, `/v1/interactions`, `/v1/embeddings`,
  `/v1/models`.
- Wire `Schema.safeParse()` at the top of each handler; route failures through
  the §8 error mapper.
- Delete `validateClaudeMessagesRequest`, `validateClaudeTokenCountingRequest`,
  `validateOpenAICompletionsRequest`, `validateModelsRequestParams`,
  `validateClaudeMessage`, `validateClaudeContent`, `validateClaudeContentBlock`.
- Keep `clampThinkingBudget` logic, but move it into a `.transform()` on the
  `thinking` field.
- **Tests:** for each endpoint, golden-file tests: (a) valid body parses, (b) each
  required-field omission returns a 400 with a structured error, (c) boundary
  numeric ranges (e.g. `max_tokens=0`, `temperature=2.1`) fail.

**Phase 2 — upstream response safe-parsing**
- Add loose response schemas (§5 table). Apply inside the existing
  `createUsageTrackingTransformStream` / response-handling code via `.safeParse()`.
- Log + count parse failures; never fail the request.
- **Tests:** record real upstream payloads (already have fixtures under
  `testcases/` and `config-dumps/`); replay through the schemas.

**Phase 3 — converter output guards**
- Wrap each converter (§6) with a strict `.parse()` of its declared output type.
- **Tests:** property-ish tests — for each converter, generate representative
  inputs (from the inbound schemas' examples) and assert the output parses.

**Phase 4 — streaming envelope + terminal-event validation (§7).**

**Phase 5 — docs & changelog.** Update `README.md`, `CHANGELOG.md`,
`proxy_impementation.md` per rule §3.

---

## 11. Zod version choice — v4 (recommended), v3 (fallback), Zod Mini (sub-option)

The proxy currently has no direct `zod` dependency. We are picking a major line,
not migrating an existing one — so the choice is wide open. Three candidates,
drawn from <https://zod.dev/v4> (release notes) and <https://zod.dev/api>:

### 11.1 Zod 4 (`zod@^4`, `"zod/v4"`)

**Status:** stable. The release notes describe it as closing 9 of the 10 most-upvoted
Zod 3 issues and redesigning the `ZodObject` generics to avoid instantiation
explosions.

**Pros (specific to this proxy):**

- **Performance where it hurts.** 14× faster string parsing, 7× array, 6.5× object.
  Our hottest path parses large message arrays (`messages: [...]` with hundreds of
  content blocks) on every inbound request and every upstream response — exactly
  the workload that benefits. The proxy already does format conversion on the hot
  path; a faster validator keeps added latency in single-digit ms (see §11/Risks).
- **`tsc` instantiation count.** A simple file drops from >25 000 instantiations
  on `zod/v3` to ~175 on `zod/v4`. The proxy compiles with `tsc -p tsconfig.server.json`
  for the Node build *and* `wrangler` for the Workers build; cheaper generics speed
  both, and the editor stays responsive as `src/schemas/` grows.
- **`.extend()`/`.omit()` chains.** 10× faster to compile and no longer trip
  "Possibly infinite" errors. The proxy's schemas will share a lot of partial
  content-block schemas (text/image/tool_use/...) picked and omitted per endpoint,
  so this matters day-to-day.
- **Refinements live inside the schema.** In v4, `.refine()` interleaves with
  `.min()`/`.max()` — v3 wrapped in `ZodEffects` and broke method chaining. This
  is directly useful for `thinking.budget_tokens < max_tokens` (a refine that must
  coexist with numeric constraints on the same object).
- **`.overwrite()`** — a type-preserving transform. Good fit for
  `clampThinkingBudget` (fold budget into `max_tokens` without changing the
  inferred type), which `.transform()` could not do cleanly because it makes the
  output non-introspectable.
- **Composable discriminated unions.** v4 lets a discriminated union be a member
  of another. The proxy's content-block unions are nested (e.g. Gemini
  `ThoughtContent.summary.content` is itself a `TextContent | ImageContent`
  union), and SSE event unions contain sub-unions of deltas — v4 models this
  naturally.
- **`z.toJSONSchema()` first-party.** Relevant for the out-of-scope follow-up
  (§13): advertising JSON Schemas on `/v1/models` or `/.well-known`. v3 needed
  `zod-to-json-schema`.
- **`z.prettifyError()`** — official pretty-printer; saves us pulling
  `zod-validation-error` or writing our own for log lines.
- **`z.stringbool()`** — env-style boolean coercion. Maps neatly onto
  `Env` parsing (the `DEV_MODE`, `CONVERSATION`, etc. flags
  in `src/types/shared.ts` are all "true"/"1"-style strings).

**Cons / migration friction:**

- **Breaking change in error-customisation API.** v4 replaces `message`,
  `invalid_type_error`, `required_error`, and `errorMap` with a single `error`
  parameter. Since we have *no* existing Zod code, this costs us nothing — but
  any copied snippet from v3-era blog posts will need translating. Mitigation:
  treat the v4 docs as canonical; do not cargo-cult v3 examples.
- **Method-based string formats deprecated.** `z.string().email()` works but is
  deprecated in favour of `z.email()`. We just adopt the functional form from
  day one; no migration cost.
- **`zod/v4/core` split.** Only relevant if we were building a library on top;
  we are not.
- **Adoption recency.** v4 is stable but newer than v3. For a proxy talking to
  paid upstream APIs, the risk is low (we control the schemas, and `.safeParse`
  with a loose fallback means a schema bug degrades to "log + pass through",
  not a hard outage).

### 11.2 Zod 3 (`zod@^3`, `"zod/v3"`)

**Pros:** most blog posts, tutorials, and third-party integrations target v3.
`zod-to-json-schema` is mature. If a future dependency of the proxy ever peer-depends
`zod@3`, staying on v3 avoids dual-version issues.

**Cons:** slower parsing, much heavier `tsc` cost, method-chaining limits around
refinements, no composable discriminated unions, no first-party JSON Schema.
For this codebase — Worker bundle, large unions, lots of `.pick()`/`.omit()` on
shared block schemas — v3's costs are felt immediately.

**Verdict:** v3 is the fallback only if a concrete blocker forces it. None is
known today.

### 11.3 Zod Mini (`"zod/mini"`, ships inside the `zod@4` package)

A functional, tree-shakable variant of v4. Same parsing semantics; method-based
API is replaced by wrapper functions (`optional(s)`, `array(s)`, …).

**Bundle-size numbers (gzip, from the release notes):**

| Variant | Core bundle (gzip) |
|---|---|
| `zod@3` | 12.47 kb |
| `zod@4` (regular) | 5.36 kb |
| `zod@4/mini` | 1.88 kb |

**Why we might want it:** the proxy runs on Cloudflare Workers (see `wrangler.toml`,
`src/index.ts` → `fetch(request, env, ctx)`). Worker bundles have a soft size budget
and every KB matters for cold start. Regular Zod 4 at ~5.4 KB gzip is already fine;
Mini at ~1.9 KB is better if the bundle ever approaches the limit.

**Why we probably won't start there:**

- The method API (`.optional()`, `.array()`, `.transform()`, `.refine()`) is more
  readable for the large, nested schemas this proxy needs, and the README's
  "Follow Convention" rule (§3) favours the better-known API.
- Mini's parsing semantics are identical to regular Zod 4, so **switching later
  is a mechanical, per-file rewrite** — no semantic rework. We can defer Mini to
  "only if a Worker bundle-size budget forces it".
- Mini lacks some ergonomics (method chaining), which hurts readability in
  `src/schemas/claude.ts` where the content-block unions are non-trivial.

**Decision rule:** default to **regular `zod@^4`**. Re-evaluate Mini after
Phase 1 if `wrangler deploy` reports the Worker bundle above an agreed threshold
(e.g. > 500 KB uncompressed). Track as the open question Q5 in §9.

### 11.4 Recommendation

Adopt **`zod@^4`** (regular, not Mini). Pin in `package.json`:

```json
"dependencies": {
  "zod": "^4.1"
}
```

Rationale: we have no v3 legacy to protect; v4's parsing speed, `tsc` cost,
composable discriminated unions, and `.overwrite()` directly serve the proxy's
patterns (large message arrays, nested content-block unions, `thinking` budget
clamping). Mini stays available as a drop-in escape hatch if Worker bundle size
ever forces it.

## 12. Risks

- **Behavior drift.** The hand-rolled validators have accumulated edge cases
  (e.g. the `interleaved-thinking` exception in `clampThinkingBudget`). The
  migration must preserve them; covered by Phase 1 tests, but the test corpus
  must be built from the *current* validator's accepted/rejected set, not from
  the spec alone.
- **Strictness regressions.** Switching inbound to strict rejection could break
  clients currently sending extra keys. Mitigation: Phase 1 starts with
  `.passthrough()` on request schemas (matching today's behavior), tightens to
  strict in a follow-up after a telemetry window.
- **Cloudflare Workers bundle.** See Q5.
- **Performance.** Zod parse on every request adds single-digit-ms; acceptable
  for a proxy already doing format conversion. Validate with a `review-of-performace`
  style check (see existing `../contributing/review-of-performace-1.md`) after Phase 1.

---

## 12. Out-of-scope follow-ups (not part of this proposal)

- Generating JSON Schemas from the Zod schemas (`z.toJSONSchema()`) and advertising
  them on the `/v1/models` endpoint or a new `/.well-known` path.
- Using Zod to validate `proxy_config.toml` itself (currently `parseSimpleToml`).
- Replacing the dashboard API's ad-hoc handlers with Zod.

---

## Appendix A — Sketch: Claude inbound schema (illustrative, not final)

```ts
// src/schemas/claude.ts
import { z } from "zod";

const ClaudeTextBlock = z.object({
  type: z.literal("text"),
  text: z.string().min(1),
  citations: z.array(z.object({
    type: z.literal("char_location"),
    cited_text: z.string(),
    document_index: z.number().int(),
    document_title: z.string(),
    start_char_index: z.number().int(),
    end_char_index: z.number().int(),
  })).optional(),
  cache_control: z.object({
    type: z.literal("ephemeral"),
    ttl: z.enum(["5m", "1h"]),
  }).optional(),
});

// ... other blocks ...

export const ClaudeContentBlock = z.discriminatedUnion("type", [
  ClaudeTextBlock,
  ClaudeImageBlock,
  ClaudeDocumentBlock,
  ClaudeToolUseBlock,
  ClaudeToolResultBlock,
  WebSearchToolResultBlock,
  ThinkingBlock,
]);

export const ClaudeContent = z.union([
  z.string().min(1),
  z.array(ClaudeContentBlock).min(1),
]);

const ThinkingConfig = z.discriminatedUnion("type", [
  z.object({
    type: z.union([z.literal("enabled"), z.literal("adaptive"), z.literal(true)]),
    budget_tokens: z.number().int().min(1024).max(100000).optional(),
  }),
  z.object({
    type: z.union([z.literal("disabled"), z.literal(false)]),
  }),
]).transform((t, ctx) => {
  // host clampThinkingBudget here: fold budget down to max_tokens unless
  // interleaved-thinking is active. ctx.addIssue() for the max_tokens<1024 case.
  return t;
});

export const ClaudeMessagesRequest = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),     // see §9 Q1
    content: ClaudeContent,
  })).min(1).max(100000),
  system: z.union([z.string(), z.array(ClaudeTextBlock)]).optional(),
  max_tokens: z.number().int().min(1).max(100000),
  stop_sequences: z.array(z.string()).optional(),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(1).optional(),
  top_p: z.number().min(0).max(1).optional(),
  top_k: z.number().int().min(1).max(1000).optional(),
  tools: z.array(ClaudeTool).optional(),
  tool_choice: ToolChoice.optional(),
  thinking: ThinkingConfig.optional(),
  reasoning_effort: z.enum(["low", "medium", "high", "max"]).optional(),
  metadata: z.object({ user_id: z.string() }).optional(),
}).passthrough();   // Phase 1: stay permissive; tighten later

export type ClaudeMessagesRequest = z.infer<typeof ClaudeMessagesRequest>;
```

## Appendix B — Sketch: upstream-response safe-parse (illustrative)

```ts
// inside responses.ts, after fetching from OpenAI-compatible upstream
const parsed = OpenAIResponseSchema.loose().safeParse(raw);
if (!parsed.success) {
  logger.warn(requestId, `upstream response schema miss: ${
    parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; ")
  }`);
  // fall through with `raw`; do NOT fail the request
}
```

---

*End of proposal.*
