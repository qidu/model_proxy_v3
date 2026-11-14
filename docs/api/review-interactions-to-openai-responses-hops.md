# Review: `/v1/interactions` → `openai-responses`, direct conversion vs. over the Completions intermediate

This review compares the two architectures available for routing a Gemini Interactions request to an
`openai-responses` upstream:

- **over `openai-completions`** — what the repo does today: Interactions → Chat Completions →
  Responses, two conversions, with the Completions body as the intermediate.
- **direct** — one conversion, Interactions → Responses.

The question it answers is the practical one: **which loses fewer fields?** All field claims below
were verified against the repo's own schema dumps and by running the real converters, not from memory
of the two APIs. Method is in [How the numbers were produced](#how-the-numbers-were-produced).

## SCOPE RULE

> `openai-responses` reached through the `/v1/responses` front door is a **verbatim pass-through**
> (`handleAsPassthrough`, `src/handlers/responses.ts:1942`, `upstreamBodyPassthrough = requestBody`).
> Nothing here is a defect on that path — it relays the client's bytes and loses nothing.

Everything below applies to the **converter** paths, which rebuild the body:

- `/v1/interactions` → `handleOpenAIRequest` (`src/handlers/openai.ts`) → `forwardCompletionsAsOpenAIResponses`
- `/v1/chat/completions` → `handleChatCompletionsPassthrough` (`src/handlers/chat-completions.ts:252`)
- `/v1/messages` → `handleMessagesRequest` (`src/handlers/messages.ts:381`, `:645`)
- `:generateContent` → `handleOpenAIRequest`

## There is no direct converter today

`grep` finds no Interactions→Responses converter in `src/`. The only Interactions request converter is
`convertGeminiInteractionsToOpenAI` (`src/handlers/openai.ts:155`). So "direct" is not a configuration
choice — it is new code, and it would need a converter in **both** directions (the response comes back
Responses → synthetic Completions → `convertOpenAIToGeminiInteractions`, `openai.ts:1313`).

## The intermediate is a strict superset of losses

The two-hop loss set is `(absent from Completions) ∪ (absent from Responses) ∪ (unmapped at hop 1)`.
The direct loss set is just `(absent from Responses)`. The two-hop therefore loses **everything a
direct converter would lose, plus more**.

### Field inventory, from the repo's own dumps

- **Completions** — `docs/api/list_of_api_and_schema.md:203`:
  `{model, messages, temperature?, top_p?, n?, stream?, stop?, max_tokens?, max_completion_tokens?,
  presence_penalty?, frequency_penalty?, logit_bias?, user?, tools?, tool_choice?, response_format?,
  seed?, reasoning_effort?, modalities?, audio?, prediction?, metadata?, prompt_cache_key?,
  prompt_cache_options?, prompt_cache_breakpoint?, parallel_tool_calls?, service_tier?, store?}`
- **Responses** — `docs/api/openai-response-methods-create.md` (top-level params):
  `background, context_management, conversation, include, input, instructions, max_output_tokens,
  max_tool_calls, metadata, model, moderation, parallel_tool_calls, previous_response_id, prompt,
  prompt_cache_key, prompt_cache_options, prompt_cache_retention, reasoning, safety_identifier,
  service_tier, store, stream, stream_options, temperature, text, tool_choice, tools, top_logprobs,
  top_p, truncation, user`

**Responses has no top-level `seed`, `stop`, or `modalities`** (verified by `grep -c '^- \`seed'` etc.
→ 0 each). Chat Completions has `seed` and `modalities`.

### The three buckets

| Bucket | Fields | Direct fixes it? |
|---|---|---|
| **Lost either way** — Responses cannot express them | `stop_sequences`, `seed`, `response_modalities`, `agent`, `agent_config`, `cached_content` | **No** (6) |
| **Only the two-hop loses** — no Completions spelling | `background`, `previous_interaction_id`, `thinking_summaries`, the 6 non-function tool families (`google_search`, `code_execution`, `url_context`, `computer_use`, `mcp_server`, `file_search`), `tool_choice` allow-list fidelity | **Yes** (~10) |
| **Unmapped at hop 1 though Completions has the field** | `store`, `temperature`, `top_p`, `max_output_tokens`, `response_format`, `response_mime_type`, `thinking_level` | Not an architecture issue — a hop-1 fix (7) |

Today the two-hop loses roughly **17** of the Interactions request surface. A direct converter would
lose roughly **6**.

## `labels` (2026-11-14) — bucket 3 at hop 1, a hop-2 gap after it

`labels` is a request-level map the Interactions API declares ("the labels with user-defined metadata
for the request"), typed `{[k: string]: string}` on `CreateModelInteraction` / `CreateAgentInteraction`
in `@google/genai`; `docs/api/interactions.md` predates the field, which is why it went unnoticed. It
became a bucket-3 hop-1 fix: hop 1 now emits it as the Completions `metadata`, so the in-band design
holds again — no side channel, no new wire value for a request that carried no labels.

What it lands on is the one place this review's architecture question bites, because `metadata` is
declared by **both** OpenAI APIs and by neither `anthropic-messages` nor a free-form map:

| target | outcome |
|---|---|
| `openai-completions` | receives `metadata` — the field it already has |
| `openai-responses` | **dropped**: `completionsToResponsesBody` maps no `metadata`, though the Responses API declares it. A direct converter would close this one — the field is present at the target, only the hop-2 mapping is missing |
| `anthropic-messages` | **dropped**: Claude's `metadata` accepts only `user_id`, which no free-form map can fill at any architecture — so this loss is not attributable to the intermediate |

`src/handlers/openai.ts` warns at both dropping hops rather than dropping in silence (rule #8), and
`tests/unit/gemini-interactions-to-openai.test.ts` pins each landing.

## Correction: `store` was never blocked by the intermediate

An earlier reading of this route — repeated in the code comment and the CHANGELOG entry for the `store`
change — held that `store` "cannot ride the intermediate Completions body" because a Completions
upstream "has no such field", and therefore needed out-of-band threading.

**That was wrong.** `docs/api/list_of_api_and_schema.md:203` declares `store?` on `OpenAIRequest`. Chat
Completions has it. What misled the earlier reading is that the **TS type under-declares**: `store` is
absent from `src/types/openai.ts:59-95`, so `grep -c store src/types/openai.ts` → 0 even though the
repo's own schema dump lists it.

Consequence: the in-band design was available all along — `convertGeminiInteractionsToOpenAI` emits
`store`, `completionsToResponsesBody` maps it, no side channel and no extra parameter, and the
`/v1/chat/completions` front door gets it for free. The out-of-band version is being replaced by that.

The same TS-vs-dump gap shows up for `seed`, `modalities`, `n`, `user`, `prediction`, `audio`,
`prompt_cache_options` — all present in the schema dump, all absent from `OpenAIRequest`.

## The one genuinely lossy mapping: `tool_choice`

Measured end to end (Interactions → Completions → Responses):

| Interactions input | → Completions | → Responses | effect |
|---|---|---|---|
| `{mode:'validated', tools:['f']}` | `{type:'function',function:{name:'f'}}` | `{type:'function',name:'f'}` | faithful |
| `{mode:'validated', tools:['f','g']}` | `'required'` | `'required'` | **allow-list lost** — model may call any tool |
| `{mode:'any'}` | `'required'` | `'required'` | faithful |
| `{mode:'none'}` | `'none'` | `'none'` | faithful |

The allow-list row is the only remaining loss, and it is pinned as intentional by
`tests/unit/gemini-interactions-to-openai.test.ts`: the Completions intermediate can say "a tool call"
(`'required'`) but cannot name a *set* of permitted functions. The Responses API can (`allowed_tools`),
which is the one thing a direct converter would still buy here — no longer a safety-relevant widening,
since the "must call a tool" half now survives.

`{mode:'any'}` used to ride out as `'auto'`, i.e. "may answer without a tool call": Gemini's `ANY` is
defined as the model being *constrained to always predicting a function call*, which is exactly what
`'required'` means, and the reverse direction (`claude-to-gemini.ts`) already maps the pair that way.
The earlier justification for the loosening — that the intermediate had "no spelling for
`required`-as-'must call'" — was wrong: `OpenAIRequest['tool_choice']` has carried `'required'` since
the same change that introduced this mapping. Fixed 2026-11-14.

The tool families are a separate loss and still argue for a direct converter: Responses spells
`web_search`, `file_search`, `code_interpreter`, `computer_use` and `mcp` natively, while Completions
`tools[]` only spells functions.

## The two-hop *was* two divergent implementations — now unified

**Status: settled.** At the time of this review, two implementations existed:

- `/v1/interactions` → openai-responses used `completionsToResponsesBody` (`src/handlers/openai.ts`).
- `/v1/messages` → openai-responses used private helpers in `src/handlers/messages.ts`
  (`completionsMessagesToResponsesInput`, `completionsToolsToResponsesTools`,
  `completionsToolChoiceToResponsesToolChoice`).

Same logical request (one system prompt, one user turn) through both front doors, captured at the
fetch mock — measured **before** the unification:

| | `/v1/interactions` | `/v1/messages` |
|---|---|---|
| system prompt | `instructions: "be terse"` | input message `{role:'system'}` — **no `instructions`** |
| input item envelope | `{type:'message', role, content}` | `{role, content}` — **no `type`** |
| `store` | `false` | absent |
| `reasoning_content` | dropped | → `reasoning` item |
| `prompt_cache_key` | carried | absent |

Both emitted valid Responses shapes, so nothing was broken — but the same logical request produced
different bytes depending on which front door carried it.

Both hops now call `completionsToResponsesBody` and the private copies are deleted. Measured
**after**: `instructions` and the `input[0]` envelope are byte-identical across the two doors; the
only key difference is `max_output_tokens`, driven by the input (`max_tokens` present on the
`/v1/messages` side), not by the converter.

Each divergence was resolved as follows:

| divergence | resolution |
|---|---|
| system prompt | top-level `instructions` — the canonical field, accepted by every upstream |
| item envelope | `{type:'message', …}` — the spec's explicit item type |
| assistant reasoning | the `reasoning` item is kept, and is now emitted on all three front doors |
| `store` / `response_format` / `reasoning_effort` / `prompt_cache_key` | carried on all three front doors |

Behaviour change: `/v1/messages` → `openai-responses` puts its system prompt in `instructions`
instead of `input[]`, so its `input[]` indices shift down one. Pinned in
`tests/unit/messages-ref-streaming.test.ts`.

### Two defects the merge surfaced

- **`input_image.image_url` was non-conformant on the `openai.ts` side.** It relayed the client's
  Chat-shaped `{url, detail}` object into the Responses body verbatim. The spec says
  `image_url: optional string or null` with `detail` a *sibling* on the item
  (`docs/api/openai-response-methods-create.md`) — the form `messages.ts` already emitted. Fixed by
  unwrapping, while still accepting a client that sends the string form. Three cases in
  `tests/unit/handlers.test.ts` had pinned the object shape and were rewritten; the comment claiming
  they mirrored `messages.ts` was backwards.
- **A tool result sent as an object was being dropped.** The shared `openAIContentToText` returns
  `''` for any non-array, non-string content, so `content: {answer: 42}` became `output: ''` where
  `messages.ts` had serialized it. The merged converter keeps the serialize branch. Caught by
  `tests/unit/messages-handler.test.ts` failing, and fixed rather than re-pinned.

## Trade-off

| | two-hop (today) | direct converter |
|---|---|---|
| new code | none | a request converter **and** a response converter |
| `store` | in-band mapping (being fixed) | native field |
| `tool_choice` allow-list fidelity | impossible | yes |
| `temperature` / `top_p` / `max_output_tokens` / `response_format` / `thinking_level` | hop-1 fix | yes |
| non-function tool families | impossible | yes |
| hooks / spool / ref egress | already works on the shared body | must be re-wired |
| implementations to maintain | 2 today, should be 1 | 3, unless unified first |

## Recommendation

Only the middle bucket is an architecture question. The bottom row — 7 fields including every sampling
knob — is a mapping gap in `convertGeminiInteractionsToOpenAI`, not a consequence of the intermediate,
and `completionsToResponsesBody` already carries `temperature`/`top_p`/`max_tokens`
(`completionsToResponsesBody` in `src/handlers/openai.ts`), so hop 2 was already waiting for them.

Therefore, in order:

1. ✅ **Fix hop 1** — done. The bottom row now rides the intermediate for `/v1/interactions` and
   `/v1/chat/completions` alike, with no architectural change.
2. ✅ **Unify the two Completions→Responses implementations** — done, before anything else was built
   on top of them. See the section above.
3. ⬜ **Consider a direct converter** only if `tool_choice` allow-list fidelity and the non-function tool
   families are wanted — that is the entire remaining margin, and `stop_sequences` / `seed` /
   `response_modalities` / `cached_content` are unrecoverable at a Responses target under either
   design. Not started; nothing in the repo depends on it.

## How the numbers were produced

- Field inventories: `docs/api/list_of_api_and_schema.md:203` (Completions) and the parameter list in
  `docs/api/openai-response-methods-create.md` (Responses), including the `ReasoningEffort` enum at
  `:3325-3343` (`none | minimal | low | medium | high | xhigh | max`) and the absence of top-level
  `seed` / `stop` / `modalities` (grep count 0 each).
- Per-hop survival: a maximal Interactions body carrying every field `docs/api/interactions.md`
  documents, run through the real `convertGeminiInteractionsToOpenAI` and `completionsToResponsesBody`
  under `tsx`, printing each field's presence at hop 1 and hop 2.
- `tool_choice`: the same two functions over the four documented `mode` values.
- Cross-front-door divergence: the real `handleOpenAIRequest` and `handleMessagesRequest` driven with a
  `globalThis.fetch` mock that captures the outbound body.
