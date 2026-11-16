# Review: indirect ("bridged") transforms vs direct transforms

**Status: advisory only. No code was changed to produce this note.**

Scope: the cross-mode matrix in [`README.md` § Supported `upstream_mode`](../../README.md#supported-upstream_mode)
(and its copy in [`docs/api/list_of_api_and_schema.md`](../api/list_of_api_and_schema.md) §2), audited against the
handlers and converters that actually run. It answers one question: **which "indirect transform" routes are worth
refactoring into direct ones, and in what order?**

Companion notes already in the repo, which this one extends rather than repeats:

- [`routing-review.md`](./routing-review.md) — the argument for direct on `/v1/interactions` (2 routes).
- [`review-interactions-to-openai-responses-hops.md`](../api/review-interactions-to-openai-responses-hops.md) — the
  measured field inventory for one route, with method.

---

## Verdict

1. **"Indirect" is not one thing.** It is two independent mechanisms (a *body hub* through Chat Completions, and a
   *stream pivot* through `chat.completion.chunk`) plus the 20 converted cells that use them in different
   combinations. Any refactor plan has to say which one it is changing.
2. **Only two converter *directions* are worth building**: Gemini-family → Responses (which serves both the
   `/v1/interactions` and `:generateContent` front doors with one module) and Claude → Responses. Every other bridged
   route loses nothing that a direct converter could recover beyond what a hop fix recovers — §4 shows the margin
   route by route.
3. **The single biggest win is not a converter at all.** `/v1/interactions` → `gemini-interactions` is the same API
   family as the client, i.e. a passthrough — and it is currently implemented as a conversion to
   `:generateContent`. Passthrough mode (`/passthrough/v1/interactions`) already proves the correct target works.
4. **Fix the labels before planning the refactor — and check one cell that is not wired.** Five of the 25 cells carry
   a label the code contradicts (§1.1), so the roadmap that "prefer direct transforms long-term" would be built on a
   wrong inventory. One of the five is worse than a label problem: `/v1/chat/completions` → `gemini-interactions` has
   no handler branch and forwards the unconverted Chat body to a generateContent URL (F5). The label fix is docs-only
   and costs nothing; F5 is a small code fix.

---

## 1. What the code actually does

Measured from the handler → converter call chains. The matrix is 5 client endpoints × 5 upstream modes = 25 cells.
"Hops" counts request-body conversions; the response side generally mirrors the count (some cells differ by one, e.g.
`/v1/responses` → `gemini-generatecontent` is three hops on the request and two on the response).

### 1.1 Hops per cell, and whether the matrix label matches

| Client endpoint | `anthropic-messages` | `openai-completions` | `openai-responses` | `gemini-generatecontent` | `gemini-interactions` |
|---|---|---|---|---|---|
| `/v1/messages` | 0 ✅ | 1 ✅ | 2 ✅ | 1 ✅ | 1 ⚠️ **F3** |
| `/v1/responses` | 2 ❌ **F1** | 1 ✅ | 0 ✅ | 3 ❌ **F2** | 3 ❌ **F2** |
| `/v1/chat/completions` | 1 ✅ | 0 ✅ | 1 ✅ | 1 ✅ | **0 ❌ F5** (unconverted) |
| `/v1beta/models/<model>:generateContent` | 2 ✅ | 1 ✅ | 2 ✅ | 0 ✅ | 0 ✅ |
| `/v1/interactions` | 2 ✅ | 1 ✅ | 2 ✅ | 1 ⚠️ **F4** | 1 ❌ **F3** |

✅ label matches the code · ⚠️ label is loose but the chain works · ❌ label describes code that does not exist, or the
cell is not wired. Tally: 18 ✅, 2 ⚠️, 5 ❌.

### 1.2 The chains, cell by cell

| Client endpoint | Upstream mode | Chain today (file:line of the hop) | Matrix label |
|---|---|---|---|
| `/v1/messages` | `anthropic-messages` | — (body forwarded; `claude.ts`) | Native passthrough |
| `/v1/messages` | `openai-completions` | Claude → Completions (`messages.ts:533`) | Direct |
| `/v1/messages` | `openai-responses` | Claude → Completions (`messages.ts:533`) → Responses (`messages.ts:546`, `completionsToResponsesBody`) | Indirect via `openai-completions` |
| `/v1/messages` | `gemini-generatecontent` | Claude → generateContent (`convertClaudeToGeminiRequest`) | Direct |
| `/v1/messages` | `gemini-interactions` | Claude → **generateContent** (`index.ts:2679` → `handleGeminiRequestForMessages`; `gemini.ts:507`) | Direct, "Gemini Interactions/generateContent-compatible upstream" |
| `/v1/responses` | `anthropic-messages` | Responses → Completions (`convertResponsesToChatCompletions`) → Claude (`completionsToClaudeBody`); `responses.ts:650` | **Direct transform** |
| `/v1/responses` | `openai-completions` | Responses → Completions (`responses.ts:882`) | Direct |
| `/v1/responses` | `openai-responses` | — (`handleAsPassthrough`, `responses.ts:1931`) | Native passthrough |
| `/v1/responses` | `gemini-generatecontent` | Responses → Completions → Claude → generateContent (`responses.ts:111` → `handleAsGemini`, `:747`) | **Direct transform via Claude Messages** |
| `/v1/responses` | `gemini-interactions` | identical to the cell above (`responses.ts:111` takes both) | **Direct transform via Claude Messages** |
| `/v1/chat/completions` | `anthropic-messages` | Completions → Claude (`chat-completions.ts:102`) | Convert passthrough |
| `/v1/chat/completions` | `openai-completions` | — | Native passthrough |
| `/v1/chat/completions` | `openai-responses` | Completions → Responses (`chat-completions.ts:327`) | Transform passthrough |
| `/v1/chat/completions` | `gemini-generatecontent` | Completions → generateContent (`chat-completions.ts:502`) | Transform passthrough |
| `/v1/chat/completions` | `gemini-interactions` | **none** — falls past the `gemini-generatecontent` branch to the OpenAI-native tail (`chat-completions.ts:746-811`) | "Same as `gemini-generatecontent`; not separately wired today" |
| `/v1beta/models/<model>:generateContent` | `anthropic-messages` | generateContent → Completions (`openai.ts:498`) → Claude (`completionsToClaudeBody`, `openai.ts:40`) | Indirect via `openai-completions` |
| `/v1beta/models/<model>:generateContent` | `openai-completions` | generateContent → Completions (`openai.ts:457`) | Direct |
| `/v1beta/models/<model>:generateContent` | `openai-responses` | generateContent → Completions → Responses (`openai.ts:243`) | Indirect via `openai-completions` |
| `/v1beta/models/<model>:generateContent` | `gemini-generatecontent` | — (`index.ts:560-568`) | Native passthrough |
| `/v1beta/models/<model>:generateContent` | `gemini-interactions` | — (same branch as above) | Native Gemini-family route |
| `/v1/interactions` | `anthropic-messages` | Interactions → Completions (`gemini-to-openai.ts`) → Claude (`openai.ts:40`) | Indirect via `openai-completions` |
| `/v1/interactions` | `openai-completions` | Interactions → Completions (`openai.ts:460`) | Direct |
| `/v1/interactions` | `openai-responses` | Interactions → Completions → Responses (`openai.ts:243`) | Indirect via `openai-completions` |
| `/v1/interactions` | `gemini-generatecontent` | Interactions → generateContent (`gemini.ts:78-80` → `interactions-to-gemini.ts`) | Native Gemini-family route |
| `/v1/interactions` | `gemini-interactions` | Interactions → **generateContent**, identical to the cell above (`index.ts:521-529`) | Native Gemini-family route, "using Interactions-compatible mode" |

### Findings

- **F1** — `/v1/responses` → `anthropic-messages` is labelled **Direct transform** but is two conversions
  (`responses.ts:650`). The README's note "Direct transform means the proxy converts directly between the client
  endpoint format and the selected upstream family" is false for this cell.
- **F2** — `/v1/responses` → `gemini-generatecontent` **and** → `gemini-interactions` are labelled **Direct transform
  via Claude Messages**, and the note spells out two hops. The code takes three on both cells:
  `convertResponsesToChatCompletions` → `completionsToClaudeBody` → `convertClaudeToGeminiRequest`. The Completions hop
  is missing from the label **and** from the note's arrow chain, which is the one place a reader would go to check it.
- **F3** — `gemini-interactions` is not a distinct upstream wire format anywhere in the routing table. Both Gemini
  modes resolve to the same `:generateContent` / `:streamGenerateContent` URL (`index.ts:521-529`,
  `index.ts:556-597`, `gemini.ts:507`), and `/v1/interactions` → either mode ends in
  `convertInteractionsToGenerateContent`. The real Interactions API is `POST {base}/v1beta/interactions`
  (`docs/api/interactions.md:19`; the SDK declares the matching SSE vocabulary, see
  `src/converters/interactions-stream-events.ts`). The one place it is reached is passthrough mode:
  `ENDPOINT_MODE_MAP` maps `/v1/interactions` → `gemini-interactions` and forwards verbatim
  (`src/handlers/passthrough.ts:42`). The auth layer also already treats the mode as the real API — it has a
  dedicated branch for `/v1beta/interactions/<id>` paths in `gemini-interactions` mode and prefers `x-goog-api-key`
  there (`tests/unit/routing.test.ts:598-618`) — so the mode's own resource paths are contemplated everywhere except
  the routing table.
- **F4** — `/v1/interactions` → `gemini-generatecontent` is called a "Native Gemini-family route". It is a
  conversion (Interactions body → generateContent body), i.e. a *direct transform*. "Native" should mean the same
  API family; here it does not.
- **F5** — `/v1/chat/completions` → `gemini-interactions` is **not wired**. `resolveUpstreamTarget` points the cell at
  `geminiModelUrl('generateContent')` but leaves `upstreamMode: 'gemini-interactions'` (`index.ts:591-595`), while the
  handler's only Gemini branch is keyed on `'gemini-generatecontent'` (`chat-completions.ts:502`). The cell therefore
  falls through to the OpenAI-native tail (`:746-811`) and posts the **unconverted Chat Completions body** to a Gemini
  `:generateContent` URL, relaying whatever comes back. The matrix's "Same as `gemini-generatecontent`; not separately
  wired today" reads as a benign omission; it is a format mismatch.

Two of these are inventory bugs only (F1, F2, F4 and F3's labelling half describe chains that work and are tested).
F3's other half and F5 are wiring gaps: a real Interactions upstream is never reached, and one cell is not wired at
all.

---

## 2. Two mechanisms, not one

### 2.1 The body hub

Body conversions are chained through `src/converters/` with **Chat Completions as the hub**:

```
Claude ⇄ Completions ⇄ Responses
Gemini generateContent ⇄ Completions
Interactions ⇄ Completions
Claude ⇄ Gemini generateContent          (the one non-hub pair that exists)
Interactions → Gemini generateContent
```

Note what is *not* in that graph: a real Gemini Interactions upstream. It has no edge, which is F3.

Eleven body converters plus three streaming modules (14 files, ~8.2k lines in `src/converters/`) cover the 24 cells
that are wired today (F5 is the 25th). The hub is why the matrix has 24 working cells with 14 modules instead of
~40: every new front door converts *to* the hub once, and every upstream converts *from* it once.

### 2.2 The stream pivot

Streaming has a second, independent hub. `processSSEBuffer` (`src/handlers/cross-mode-stream.ts:668`) is the only
SSE egress for every **converted** route whose upstream is not Gemini-shaped, and its input is always an OpenAI
`chat.completion.chunk`:

- `cross-mode-stream.ts:171/263/298` — the `anthropic-messages` driver renders Claude SSE into chunks first
  (`processAnthropicSSEBuffer`, `:142`), then hands them to the pivot.
- `cross-mode-stream.ts:385` — the `openai-responses` driver defers the whole vocabulary to
  `responsesStreamEventToChatChunks` first (`processResponsesSSEBuffer`, `:340`).
- `openai.ts:652/663` — a native Completions upstream is already in the pivot's shape.

The file's own header says it: *"Two upstream families are not Gemini-shaped, so their streams are rendered into
OpenAI Completions chunks first … and then handed to `processSSEBuffer`, which turns a Completions chunk into
whatever the client's endpoint expects."*

**This is the part of "indirect" that a body-only refactor would miss.** A direct converter for a route buys nothing
on the streaming side unless the streamer for that pair is written too. The only cross-format streamer that bypasses
the pivot today is `gemini-streaming.ts` (Gemini upstream → any of its three client dialects: `native-gemini`,
`claude-format`, `interactions`). Every other cross-format route — a Gemini-format or Interactions client facing an
Anthropic / Responses / Completions upstream, and a Claude client facing Completions / Responses — runs through
`chat.completion.chunk`. Any refactor plan that says "add a direct converter" is half a plan.

---

## 3. Why bridged is never better on fidelity

For a two-hop route through intermediate `H`:

```
lost(2-hop) = lost(client → H) ∪ lost(H → target) ∪ (fields H cannot spell at all)
lost(direct) = lost(client → target)
```

The two-hop loss set is a **superset** of the direct one, for every pair and every field. Bridged routing is never a
fidelity win; it is a *code reuse* win. That reframing matters, because it means the question is never "is direct
more accurate?" (yes, always) but "is the margin large enough to pay for a converter plus a streamer plus its
tests?"

The repo's own comments already record measured instances of the third term:

| Intermediate limitation | Where | Consequence on a bridged route |
|---|---|---|
| Completions has **one** `reasoning_signature` slot | `gemini-to-openai.ts:398`, `:902-906` | a Gemini turn with several signed thought steps loses all but the first |
| Completions `tools[]` spells **functions only** | `gemini-to-openai.ts:648-660` | Interactions `google_search` / `code_execution` / `url_context` / `computer_use` / `mcp_server` / `file_search` are dropped before the Responses hop, which *could* have carried them |
| Completions `tool_choice` cannot name **a set** | [`review-interactions-to-openai-responses-hops.md`](../api/review-interactions-to-openai-responses-hops.md) §`tool_choice` | an Interactions allow-list of 2+ functions becomes `'required'` |
| Claude → Completions keeps thinking **text** but drops the **signature** | `claude-to-openai.ts:336-341` | `/v1/messages` → `openai-responses` sends thinking back unsigned |
| Responses has no top-level `stop` | `gemini-to-openai.ts:733` | `stop_sequences` survives to Completions, then dies — unreachable at a Responses target under either design |

---

## 4. Route by route: is the margin real?

Ordered by margin per unit of new code. R6 rides R2's module; R7 is included to show why it should not be built.

### R1 — `/v1/interactions` → `gemini-interactions`: wire the passthrough (biggest margin, smallest cost)

Today: `Interactions → generateContent` (`gemini.ts` `handleGeminiInteractionsRequest` →
`convertInteractionsToGenerateContent`), against a `:generateContent` URL. Request-level fields with no
generateContent spelling are dropped with a warning: `agent`, `agent_config`, `background`,
`previous_interaction_id`, `store`, `speech_config` (`interactions-to-gemini.ts:107-109`). Fields that do survive,
survive incidentally — the non-function tool families ride through only because generateContent happens to spell the
same six in `GENERATE_CONTENT_TOOL_KEYS` (`:95-98`).

**Against a real Interactions upstream every one of those is a field the upstream itself declares** — it is the same
API. The loss is not a mapping gap to be fixed with better conversion; it is a conversion that does not need to
happen.

Why it is cheap:

- Passthrough mode already forwards this exact body to this exact endpoint byte-for-byte
  (`passthrough.ts:42` + `buildPlainJoinUrl`), so the URL, the auth header (`x-goog-api-key`) and the schema gate
  (`{input: string | object | array}`) all exist and are exercised.
- The client-format SSE vocabulary is already implemented (`interactions-stream-events.ts`,
  `gemini-streaming.ts` dialect `interactions`), and no longer follows the stale event names in
  `docs/api/interactions.md` — it follows the SDK.
- The conversion path stays as the fallback for a `gemini-generatecontent` target; nothing is deleted.

Why it needs a decision first: see §7, question 1. If `gemini-interactions` is *meant* to be an alias for
generateContent (some upstreams are Gemini-compatible but expose no `/interactions` route), then R1 is a **new
mode**, not a change to this one — and the matrix needs a row for it.

### R2 — `/v1/interactions` → `openai-responses`: the converter with the measured margin

Already argued and measured in [`review-interactions-to-openai-responses-hops.md`](../api/review-interactions-to-openai-responses-hops.md):
a direct converter recovers roughly 10 fields, of which these have no Completions spelling at all —

- `tool_choice` allow-list (Responses `allowed_tools`),
- the six non-function tool families (Responses `web_search` / `file_search` / `code_interpreter` /
  `computer_use` / `mcp`),
- `thinking_summaries`, `background`, `previous_interaction_id`.

Everything else on the list is recoverable by a hop-1 or hop-2 mapping fix (the review's own conclusion, and the
precedent for `store` and `labels`, both fixed that way). Note the unavoidable residue: `stop_sequences`, `seed`,
`response_modalities`, `cached_content` are unreachable at a Responses target under **either** design.

### R3 — `/v1/messages` → `openai-responses`: real margin, second priority

Two hops today (`messages.ts:533` then `messages.ts:546`), and the losses are Claude-only:

- **thinking signatures are dropped** at hop 1 (`claude-to-openai.ts:336-341` keeps `block.thinking`, discards
  `block.signature`), and hop 2 drops the proxy's `reasoning_signature` carrier anyway
  (`completions-to-responses.ts:453-458`), so a Claude thinking-mode tool loop routed here loses the signature it is
  expected to replay. `redacted_thinking` has no Completions spelling at all. Responses `reasoning` items *do* have an
  opaque `encrypted_content` slot — the closest analogue. Either a direct converter or two hop fixes can pair the two
  ends (see §6); this is the strongest argument for the pair, not a proof that only a converter works.
- `mcp_servers` — Responses spells an `mcp` tool family natively; Completions spells functions only. Architecture, not
  a mapping gap.
- `metadata` and `cache_control` — hop fixes, not architecture: Completions has `user` and `metadata`, so Claude's
  `metadata.user_id` can ride the bridge; and Responses has no per-message cache breakpoint either way.
- Unrecoverable either way: `top_k`, `stop_sequences` (no Responses field).

Cost is higher than R2 because it needs a **new pair** (Claude ↔ Responses does not exist as a module today) **and**
a new streamer for the Claude-SSE egress, which currently only exists as "Responses SSE → chunks → Claude SSE"
(`cross-mode-stream.ts:340`).

### R4 — `/v1/responses` → `gemini-generatecontent` / `gemini-interactions`: three hops, and the label hides it

Chain: Responses → Completions → Claude → generateContent. Whatever R3 and the Claude↔Gemini pair each lose is lost
here too, twice over. The direct converter would be Responses → generateContent, which is a genuinely new pair
(neither `responses-to-*` nor `*-to-gemini` reaches it in one step).

This is the route where the *label* is doing the most damage: it reads as a one-hop design with a Claude bridge, and
the bridge is two hops wide.

### R5 — `/v1/responses` → `anthropic-messages`: margin ≈ 0, one hop fix instead

Two hops (Completions in the middle), and neither difference that matters is an architecture question:

- `text.format` → structured output already rides the bridge (`responses-to-completions.ts:193-213` →
  `completions-to-claude.ts:204-223`).
- `tools[].strict` is dropped at the Claude hop (`completions-to-claude.ts:244-249` maps only
  `name`/`description`/`parameters`), but Completions carries the field — a two-line hop fix, exactly like `store` and
  `labels` were.

A Responses↔Claude *pair* is still worth having for R3 (it is the direction that buys the reasoning-signature
mapping); the `/v1/responses` → `anthropic-messages` route is not a reason of its own.

### R6 — `/v1beta/models/<model>:generateContent` → `openai-responses`: shares R2's margin, and its module

The Gemini front door carries the same six non-function tool families (`googleSearch`, `codeExecution`,
`urlContext`, `computerUse`, `fileSearch`, `mcpServer` — `interactions-to-gemini.ts:95-98`), and they die at hop 1
for exactly R2's reason. `convertGeminiInteractionsToOpenAI` already accepts **either** Gemini spelling (`input` or
`contents`, `system_instruction` or `systemInstruction`), so a direct Gemini-family → Responses converter written the
same way serves both front doors from one module. That is why R2 is priced as one piece of work, not two.

### R7 — `/v1beta/models/<model>:generateContent` → `anthropic-messages`: margin ≈ 0

Almost everything Gemini-specific here has no Claude receptor: `safetySettings`, `cachedContent`,
`generationConfig.topK` / `candidateCount` / `mediaResolution`, audio/video parts. Structured output is *not* a gap —
`responseSchema` rides the bridge as `response_format` and lands as `output_config.format`
(`completions-to-claude.ts:204-223`). The one remaining candidate is
`functionCallingConfig.allowedFunctionNames`, and Claude spells `tool_choice` as `auto` / `any` / `tool` (one name) /
`none` — a set is not expressible there either. A direct converter would recover nothing a hop fix could not.

### Where the margin is zero — do not build these

| Route | Why a direct converter buys nothing |
|---|---|
| Anything → `openai-responses` carrying `seed` / `stop` / `modalities` | The Responses API has no such field. Unreachable under either design. |
| Anything → `anthropic-messages` carrying audio/video inline parts | Claude Messages has no audio/video content block. |
| `/v1/interactions` → `anthropic-messages` allow-list `tool_choice` | Claude spells `tool_choice` as `auto`/`any`/`tool`(one name)/`none`. A set of permitted functions is not expressible, so the direct converter cannot restore what the Completions bridge dropped. |
| `/v1/chat/completions` → anything (except `gemini-interactions`) | Chat Completions *is* the hub; these cells are already 1 hop or 0. The `gemini-interactions` cell is not a margin question — it is F5, a cell that is not wired (see §7 Q4). |

---

## 5. Cost model (why "make everything direct" is the wrong refactor)

- Cells: the five endpoints (`/v1/messages`, `/v1/responses`, `/v1/chat/completions`,
  `/v1beta/models/<model>:generateContent`, `/v1/interactions`) × the five upstream modes
  (`anthropic-messages`, `openai-completions`, `openai-responses`, `gemini-generatecontent`,
  `gemini-interactions`) = 25. Diagonal = 5 passthroughs. Off-diagonal = 20 ordered pairs, each needing a request
  converter, a response converter, and a streamer → **~40 converter units + 20 stream mappers**, against today's 11
  body converters + 3 streaming modules + 1 pivot. §1.1's hop grid shows how the 20 are covered today: twelve 1-hop,
  six 2-hop, two 3-hop.
- Each new converter unit is not just a mapping function. Every existing one re-wires, and a new one must too:
  - `before_conversion` / `before_upstream` hooks and the per-entry `maxTokens` cap that only runs inside them
    (`applyMaxTokensCap`, `src/utils/request-transform.ts`) — the omission of this hook from one egress is already
    a fixed bug (`openai.ts:88-102`);
  - §5.3 egress shape (refs streamed, not expanded) and the §5.4 extraction contract
    (`src/utils/blob-refs.ts`, `createRefAwareJsonBody`, `createConvertedResponseBody`);
  - §5.9 byte admission on the materialized response body;
  - `allowed_tools` enforcement, which is response-side today precisely because Completions cannot express it
    (`responses.ts:924`);
  - conversation state, token counting, privacy/kompress, and the per-client-format error envelope.
- Regression surface: 137 files under `tests/unit/`, including `tests/unit/request-ref-matrix.test.ts`, which pins
  26 front-door × upstream rows (27 cases) and already reports six converter-level drops. A new converter pair
  changes rows in that matrix, not just its own test.
- The measured precedent is in the repo: unifying the two divergent Completions→Responses implementations
  (see the companion review) was worth doing *before* building anything on top, and it changed upstream bytes for
  one front door. Any direct-converter work has the same shape of blast radius.

---

## 6. Recommended sequence

**Step 0 — fix the vocabulary (docs only, do this regardless).** Replace the two-value vocabulary
(`Direct` / `Indirect`) with three, in `README.md` and `docs/api/list_of_api_and_schema.md`:

| Term | Definition |
|---|---|
| **Native passthrough** | 0 conversions; client format == upstream format. |
| **Direct** | exactly 1 conversion. |
| **Bridged via X** | ≥2 conversions; **name every intermediate**, and count them. |

Corrected cells (only the rows that change):

| Route | Today's label | Corrected |
|---|---|---|
| `/v1/responses` → `anthropic-messages` | Direct transform | Bridged via `openai-completions` (2 hops) |
| `/v1/responses` → `gemini-generatecontent` | Direct transform via Claude Messages | Bridged via `openai-completions` → `anthropic-messages` (3 hops) |
| `/v1/responses` → `gemini-interactions` | Direct transform via Claude Messages | Bridged via `openai-completions` → `anthropic-messages` (3 hops) |
| `/v1/interactions` → `gemini-generatecontent` | Native Gemini-family route | Direct (Interactions → generateContent) |
| `/v1/interactions` → `gemini-interactions` | Native Gemini-family route, "Interactions-compatible mode" | Direct to `:generateContent`; **the Interactions upstream is not reached** — see Q1 |
| `/v1/messages` → `gemini-interactions` | Direct, "Interactions/generateContent-compatible upstream" | Direct to generateContent (identical to `gemini-generatecontent` today) |
| `/v1/chat/completions` → `gemini-interactions` | "Same as `gemini-generatecontent`; not separately wired today" | **Not wired**: the Chat body is forwarded unconverted to a generateContent URL — see F5 |

**Step 1 — R1, the Interactions passthrough**, once Q1 is answered. Highest margin per line of code, no new mapping
logic, and passthrough mode already demonstrates the target. Whichever way Q1 goes, F5 is fixed in the same change:
either the `/v1/chat/completions` branch key widens to accept both Gemini modes, or that cell gets its own branch.

**Step 2 — measure before building.** Only R2 and R3 survived §4. For each, produce a field-survival table with the
method in the companion review (maximal client body → real converters → print presence per hop). A converter should
be justified by *named fields a user needs*, not by the architecture diagram.

**Step 3 — prefer hop-fixes.** When the lost field *does* exist in the intermediate, fix the hop. The repo has three
precedents (`store`, `labels`, the sampling knobs), all cheaper than a converter and all landed without an
architectural change.

**Step 4 — R2 (with R6), then R3 (with R5)**, in that order. R2's module covers both Gemini front doors and reuses
the Responses tool vocabulary that already exists in `completions-to-responses.ts`; R3 needs a new pair *and* a new
streamer, and should be taken together with R5 so the Claude↔Responses pair is written once.

Do **not** start with `/v1/messages` → `openai-responses` merely because it is the most-used front door. There are two
ways to fix its headline loss, and both should be priced before either is chosen:

- **(a) Two hop fixes** — `claude-to-openai.ts:336-341` stops discarding `thinking.signature` (Completions already
  has a `reasoning_signature` carrier in this proxy's dialect), and `completions-to-responses.ts:453-458` stops
  dropping it and maps it onto `reasoning.encrypted_content`.
- **(b) One direct Claude→Responses pair**, which does both in one place and also covers `mcp_servers`.

Option (a) is cheaper and fits the repo's precedent, but it writes a proxy-internal carrier field onto two foreign
wire formats; option (b) costs a new pair plus a streamer. That is a deliberate decision about compatibility, not a
side effect of the front door being popular.

---

## 7. Open questions (owner decisions — not decided here)

1. **What is `gemini-interactions` supposed to mean?** Two coherent answers, and they lead to different roadmaps:
   (a) *A real Gemini Interactions upstream* — then F3 is a defect (the mode never reaches `/v1beta/interactions`)
   and R1 is the fix; (b) *an alias for generateContent-compatible Gemini* — then the mode should be documented as
   an alias, and R1 is a **fourth** mode (`gemini-interactions-native`, say) rather than a change to this one.
   The README, the routing table and passthrough mode currently imply different answers. Evidence for (a): the auth
   layer already has a branch for real Interactions paths in this mode (`tests/unit/routing.test.ts:598-618`), and
   `docs/api/interactions.md` documents `GET`/`DELETE`/`cancel` on `/v1beta/interactions/<id>`. Evidence for (b):
   nothing in the routing table ever builds such a URL, so the mode has only ever meant "generateContent on a
   Gemini-compatible upstream".
2. **Relabel now, or after R1?** Step 0 is docs-only and independent of every code decision; the only cost is that
   `routing-review.md` and the README notes reference the old wording.
3. **Keep the single stream pivot?** R3/R4 need direct streamers. The alternative — keep one pivot, widen the chunk
   — makes every streamer pay for every future field. Worth an explicit decision before the first new streamer is
   written.
4. **Is `gemini-interactions` on the `/v1/chat/completions` row real?** The matrix claims it is the same as
   `gemini-generatecontent`, but it is not wired at all (F5): the cell forwards the Chat body unconverted to a
   generateContent URL. If the mode becomes distinct (Q1a) that cell needs a `gemini-interactions` branch beside
   `chat-completions.ts:502`; if it stays an alias, the branch key should simply be widened to accept both modes. This
   is the one cell where the answer is a fix either way.

---

## Appendix A — doc/code drift found while auditing (reported, not fixed)

| Location | Drift |
|---|---|
| `src/index.ts:593-594` | "The chat-completions handler handles non-streaming (`:generateContent`); streaming lands in Phase 3." Streaming is wired (`chat-completions.ts:559`). |
| `docs/architecture/routing-review.md:78` | "Indirect transform has two" — there are five routes, and two mechanisms. |
| `README.md:411` | Names only the `/v1/interactions` two routes as "the current indirect" ones, omitting `/v1/messages` → `openai-responses`, `/v1beta/models/<model>:generateContent` → `anthropic-messages`/`openai-responses`, and the three-hop `/v1/responses` → `gemini-generatecontent`/`gemini-interactions`. |
| `README.md:399`, `docs/api/list_of_api_and_schema.md:137` | The `/v1/chat/completions` → `gemini-interactions` cell says "Same as `gemini-generatecontent`; not separately wired today" / "(not wired today)". It is not the same: no branch matches, so the Chat body is forwarded unconverted to a generateContent URL (F5). |
| `docs/api/interactions.md:1-10` | Self-declared stale for streaming; the SDK (`src/converters/interactions-stream-events.ts`) is authoritative. Kept consistent with the existing note, so nothing new — flagged only because a direct Interactions path (R1) would make this file the one a reader reaches first. |

## Appendix B — reproducing the audit

1. Hop chains: read the dispatch in `src/index.ts` `resolveUpstreamTarget` (`:470-640`), then each handler's
   `upstreamMode` branch listed in §1. Every conversion is a named import at the top of the handler.
2. Streaming pivot: `grep -n "processSSEBuffer(" src/` — three producers, one consumer.
3. Field survival per route: the method in
   [`review-interactions-to-openai-responses-hops.md`](../api/review-interactions-to-openai-responses-hops.md#how-the-numbers-were-produced)
   (maximal body → real converters under `tsx` → print presence per hop), or drive `globalThis.fetch` with a mock
   to capture the outbound body per front door.
4. Reachability of the real Interactions endpoint: `grep -rn "v1beta/interactions" src/` (no routing table entry;
   only the passthrough pass-through at `passthrough.ts:42`).
