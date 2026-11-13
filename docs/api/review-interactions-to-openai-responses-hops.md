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
| `{mode:'any'}` | `'auto'` | `'auto'` | **loosened** — "must call a tool" became "may answer without one" |
| `{mode:'none'}` | `'none'` | `'none'` | faithful |

Both loosening rows are pinned as intentional by `tests/unit/gemini-interactions-to-openai.test.ts`.
The Completions intermediate has no spelling for a name allow-list or for `required`-as-"must call",
so the two-hop cannot preserve them; the Responses API can (`allowed_tools`). **This is the strongest
argument for a direct converter**: a client's tool constraint silently widens, which is a
safety-relevant change rather than mere data loss. The same argument applies to the tool families —
Responses spells `web_search`, `file_search`, `code_interpreter`, `computer_use` and `mcp` natively,
while Completions `tools[]` only spells functions.

## The two-hop is already two divergent implementations

This is the finding to settle before anyone writes a third.

- `/v1/interactions` → openai-responses uses `completionsToResponsesBody` (`src/handlers/openai.ts:957`).
- `/v1/messages` → openai-responses uses private helpers in `src/handlers/messages.ts:81-211`
  (`completionsMessagesToResponsesInput`, `completionsToolsToResponsesTools`,
  `completionsToolChoiceToResponsesToolChoice`).

Same logical request (one system prompt, one user turn, one function tool) through both front doors,
captured at the fetch mock:

| | `/v1/interactions` | `/v1/messages` |
|---|---|---|
| system prompt | `instructions: "be terse"` | input message `{role:'system'}` — **no `instructions`** |
| input item envelope | `{type:'message', role, content}` | `{role, content}` — **no `type`** |
| `max_output_tokens` | absent | `64` |
| `store` | `false` | absent |
| `reasoning_content` | dropped | → `reasoning` item |
| `prompt_cache_key` | carried | absent |

Both emit valid Responses shapes, so nothing is broken — but the same logical request produces
different bytes depending on which front door it arrives at. `instructions` is the canonical
system-prompt field, so the `messages.ts` shape is expected to be the riskier of the two on a strict
Responses-compatible upstream; that has **not** been tested against a live upstream, so this is
reported as a divergence, not as a break.

## Trade-off

| | two-hop (today) | direct converter |
|---|---|---|
| new code | none | a request converter **and** a response converter |
| `store` | in-band mapping (being fixed) | native field |
| `tool_choice` fidelity | impossible | yes |
| `temperature` / `top_p` / `max_output_tokens` / `response_format` / `thinking_level` | hop-1 fix | yes |
| non-function tool families | impossible | yes |
| hooks / spool / ref egress | already works on the shared body | must be re-wired |
| implementations to maintain | 2 today, should be 1 | 3, unless unified first |

## Recommendation

Only the middle bucket is an architecture question. The bottom row — 7 fields including every sampling
knob — is a mapping gap in `convertGeminiInteractionsToOpenAI`, not a consequence of the intermediate,
and `completionsToResponsesBody` already carries `temperature`/`top_p`/`max_tokens`
(`src/handlers/openai.ts:1018-1020`), so hop 2 was already waiting for them.

Therefore, in order:

1. **Fix hop 1** (in progress). Recovers the bottom row for this route and
   `/v1/chat/completions` simultaneously, with no architectural change.
2. **Unify the two Completions→Responses implementations** before adding a third.
3. **Consider a direct converter** only if `tool_choice` fidelity and the non-function tool families
   are wanted — that is the entire remaining margin, and `stop_sequences` / `seed` /
   `response_modalities` / `cached_content` are unrecoverable at a Responses target under either design.

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
