# Review: indirect ("bridged") transforms vs direct transforms

**Status: updated after the native-Interactions and direct-conversion changes.** F5, R1, R2, R3, and R5 described in
the original review are implemented. The current matrices use **Native passthrough**, **Direct**, and **Bridged via …**
labels. Typecheck, build, and the full unit suite pass (3111/3111) after the R5 changes.

Scope: the cross-mode matrix in [`README.md` § Supported `upstream_mode`](../../README.md#supported-upstream_mode)
(and its copy in [`docs/api/list_of_api_and_schema.md`](../api/list_of_api_and_schema.md) §2), audited against the
handlers and converters that actually run. The remaining question is: **which bridged routes still justify a direct
converter, and under what measured need?**

Companion notes:

- [`routing-review.md](./routing-review.md) — the original argument for direct conversion on two Interactions routes.
- [`review-interactions-to-openai-responses-hops.md`](../api/review-interactions-to-openai-responses-hops.md) — the
  original field inventory and measurement method. Its "today" and remaining-work sections describe the pre-R2 bridge.

---

## Verdict

1. **"Indirect" remains two independent mechanisms**: a request/response body hub through Chat Completions and, on
   routes that still use it, a stream pivot through `chat.completion.chunk`. A refactor must say which it replaces.
2. **The native/direct routes are complete through R5.** F5 plus R1, R2, and R3 are joined by direct
   `/v1/responses` → `anthropic-messages`: Responses tools now reach Claude without a Completions filter, including
   namespaced functions, web search, code execution, and MCP. The existing Claude JSON/SSE → Responses egress remains
   direct and restores namespace-qualified function calls.
3. **Do not infer the next converter from hop count alone.** R3 is the precedent: most of its apparent margin turned
   out to be two-line hop fixes, and only the MCP family plus two real losses (`document` blocks, reasoning items)
   justified the pair. The remaining candidates — the three-hop `/v1/responses` → Gemini cells (R4),
   `:generateContent` → `openai-responses` (R6), and generateContent → Claude (R7) — each need field-survival
   measurement before anything is built.
4. **`gemini-interactions` means native Interactions.** It is wired natively for `/v1/interactions` and
   `/v1/chat/completions`. The `/v1/messages`, `/v1/responses`, and generateContent cells still have their documented
   generateContent behavior; they must not be described as native Interactions.

---

## 1. Current routing inventory

The matrix is 5 client endpoints × 5 upstream modes = 25 cells. "Hops" counts request-body conversions. Response and
stream conversion must be checked separately; a one-hop request does not prove a direct streamer exists.

### 1.1 Request hops and matrix status

| Client endpoint | `anthropic-messages` | `openai-completions` | `openai-responses` | `gemini-generatecontent` | `gemini-interactions` |
|---|---|---|---|---|---|
| `/v1/messages` | 0 ✅ | 1 ✅ | 1 ✅ direct Responses | 1 ✅ | 1 ⚠️ generateContent |
| `/v1/responses` | 1 ✅ direct Claude | 1 ✅ | 0 ✅ | 3 ✅ | 3 ⚠️ generateContent |
| `/v1/chat/completions` | 1 ✅ | 0 ✅ | 1 ✅ | 1 ✅ | 1 ✅ native Interactions |
| `/v1beta/models/<model>:generateContent` | 2 ✅ | 1 ✅ | 2 ✅ | 0 ✅ | 0 ⚠️ forwards to generateContent |
| `/v1/interactions` | 2 ✅ | 1 ✅ | 1 ✅ direct Responses | 1 ✅ | 0 ✅ native Interactions |

✅ the matrix matches the implemented route · ⚠️ the route is labelled accurately, but native Interactions is not wired
for that cell. The original F1/F2/F4 label errors and F5 dispatch mismatch are fixed.

### 1.2 Chains by cell

| Client endpoint | Upstream mode | Current request chain |
|---|---|---|
| `/v1/messages` | `anthropic-messages` | Native Claude passthrough (`claude.ts`) |
| `/v1/messages` | `openai-completions` | Claude → Completions (`messages.ts:533`) |
| `/v1/messages` | `openai-responses` | Claude → Responses (`claude-to-responses.ts`) |
| `/v1/messages` | either Gemini mode | Claude → generateContent (`handleGeminiRequestForMessages`) |
| `/v1/responses` | `anthropic-messages` | Responses → Claude (`responses-to-claude-request.ts`) |
| `/v1/responses` | `openai-completions` | Responses → Completions |
| `/v1/responses` | `openai-responses` | Native Responses passthrough |
| `/v1/responses` | either Gemini mode | Responses → Completions → Claude → generateContent (`responses.ts:762-764`) |
| `/v1/chat/completions` | `anthropic-messages` | Completions → Claude |
| `/v1/chat/completions` | `openai-completions` | Native Completions passthrough |
| `/v1/chat/completions` | `openai-responses` | Completions → Responses |
| `/v1/chat/completions` | `gemini-generatecontent` | Completions → generateContent |
| `/v1/chat/completions` | `gemini-interactions` | Completions → native Interactions (`completions-to-interactions.ts`) |
| `:generateContent` | `anthropic-messages` | generateContent → Completions → Claude |
| `:generateContent` | `openai-completions` | generateContent → Completions |
| `:generateContent` | `openai-responses` | generateContent → Completions → Responses |
| `:generateContent` | `gemini-generatecontent` | Native generateContent passthrough |
| `:generateContent` | `gemini-interactions` | Body forwarded unchanged to generateContent; native Interactions is not wired |
| `/v1/interactions` | `anthropic-messages` | Interactions → Completions → Claude |
| `/v1/interactions` | `openai-completions` | Interactions → Completions |
| `/v1/interactions` | `openai-responses` | Interactions → Responses (`interactions-to-responses.ts`) |
| `/v1/interactions` | `gemini-generatecontent` | Interactions → generateContent (`interactions-to-gemini.ts`) |
| `/v1/interactions` | `gemini-interactions` | Native Interactions passthrough to `/v1beta/interactions` |

### Original findings, resolved

- **F1/F2:** Responses → Anthropic and Responses → Gemini are now labelled with their actual two- and three-hop chains.
- **F3:** the mode semantics are decided: `gemini-interactions` means native Interactions. R1 wires the matching front
  door natively; the other cells explicitly disclose their remaining generateContent behavior.
- **F4:** Interactions → generateContent is labelled Direct, not Native passthrough.
- **F5:** Chat Completions → native Interactions now has its own URL, request converter, JSON response converter, and
  streamer. It no longer falls through to the OpenAI-native tail.

---

## 2. Two mechanisms, not one

### 2.1 The body hub

Chat Completions remains the reuse hub for the remaining bridged routes:

```
Claude ⇄ Completions ⇄ Responses
Gemini generateContent ⇄ Completions
Interactions ⇄ Completions
Claude ⇄ Gemini generateContent
Interactions → Gemini generateContent
```

Direct exceptions now include:

```
Interactions ⇄ native Interactions             (native passthrough on /v1/interactions)
Completions ⇄ native Interactions             (Chat Completions front door)
Interactions → Responses                       (request; Responses → Interactions is direct too)
Claude → Responses                             (request; /v1/messages front door)
```

The hub still reduces converter count and centralizes existing hook, spool, and response behavior. Those benefits do not
prove that it preserves every field.

### 2.2 The stream pivot

`processSSEBuffer` (`src/handlers/cross-mode-stream.ts:668`) still receives Completions chunks on the remaining
converted routes that use it:

- the Anthropic driver first renders Claude SSE into chunks (`processAnthropicSSEBuffer`, `:142`);
- the Responses driver uses `responsesStreamEventToChatChunks` first (`processResponsesSSEBuffer`, `:340`);
- a native Completions upstream already has the pivot's shape.

Direct streamers now bypass it for:

- Gemini upstream → native Gemini, Claude, or Interactions clients (`gemini-streaming.ts`);
- native Interactions upstream → Chat Completions (`interactions-to-completions.ts`);
- Responses upstream → Interactions (`responses-to-interactions.ts`);
- Responses upstream → Claude (`messages.ts` `handleResponsesStreamAsClaude`, which emits Claude SSE events directly
  and now maps `reasoning` items to thinking blocks with their `signature_delta`).

The last mapper consumes Responses events directly, buffers function-call argument deltas, and emits SDK-compatible
Interactions steps. It does not create a `chat.completion.chunk`. This is the required pattern when a direct request
converter is intended to improve response/stream fidelity as well.

---

## 3. Fidelity: what direct conversion can and cannot prove

For a bridged route through intermediate `H`, the useful loss model is:

```
lost(bridged) = fields target cannot express
              ∪ fields H cannot express
              ∪ mapping losses at either hop

lost(direct)  = fields target cannot express
              ∪ mapping losses in the direct converter
```

This does **not** prove that every direct implementation is more faithful. A direct converter can omit or mistranslate
fields, and an intermediate can carry proxy-specific extensions such as `reasoning_signature`. Direct conversion removes
*intermediate-specific* losses; actual fidelity must be measured.

Field-name similarity is not semantic proof either:

- `previous_interaction_id` and `previous_response_id` identify resources owned by different providers. Renaming one to
  the other does not restore conversation state.
- Claude `thinking.signature` and Responses `reasoning.encrypted_content` are both opaque, but that alone does not make
  their payloads interchangeable.
- Built-in tools with similar names can require provider-specific resource IDs or configuration. URL context is not just
  another spelling of web search, and a Gemini file-search store is not automatically an OpenAI vector store.

Measured intermediate-specific limitations remain relevant:

| Intermediate limitation | Where | Consequence on a bridged route |
|---|---|---|
| Completions has one `reasoning_signature` slot | `gemini-to-openai.ts:398`, `:902-906` | Several signed thought steps cannot all survive |
| Completions tools are function-shaped | `gemini-to-openai.ts:648-660` | Non-function tool declarations die before a Responses hop |
| Completions cannot name a function allow-list | `gemini-to-openai.ts` tool-choice mapping | A 2+-function allow-list becomes `required` |
| Claude → Completions keeps thinking text, not its signature | `claude-to-openai.ts:456-460` | Claude → Responses currently loses the signature |
| Responses has no top-level `stop` | `completions-to-responses.ts` | Stop sequences are unreachable under either request design |

---

## 4. Implemented work and remaining candidates

### R1 — `/v1/interactions` → `gemini-interactions`: implemented

The route now posts the Interactions-shaped body to `/v1beta/interactions` and relays native JSON or SSE without a
generateContent conversion. Fields that the old converter reported as unrepresentable—`agent`, `agent_config`,
`background`, `previous_interaction_id`, `store`, and `speech_config`—remain in the native request. Route hooks,
authentication, bounded response handling, and blob streaming remain active.

The original claim that `/passthrough/v1/interactions` already proved this exact endpoint was wrong: that handler joins
the supplied path as `/v1/interactions`, not `/v1beta/interactions`. The routed tests now prove the actual native URL.

### F5 — `/v1/chat/completions` → `gemini-interactions`: implemented

This is a direct Completions ↔ Interactions route, not a generateContent alias. It supports text, reasoning, images,
function declarations/calls/results, generation options, structured output, usage, JSON responses, and native
Interactions SSE. Output kinds without a Chat Completions projection are reported, and truncated streams abort.

### R2 — `/v1/interactions` → `openai-responses`: implemented for this front door

The direct request converter runs before the legacy Gemini → Completions dispatch. Direct Responses JSON and SSE
conversion replaces the old response bridge for this cell.

Recovered or preserved by explicit mappings include:

- Responses `allowed_tools` for a function allow-list;
- function calls and results;
- web search, code interpreter, and MCP declarations where the required Responses fields can be constructed;
- `background`, reasoning effort/summaries, labels → `metadata`, and structured output;
- image/document inputs, including ref-preserving egress, and token usage.

Not claimed as recovered:

- `previous_interaction_id` without proxy-managed state translation;
- thought signatures without a validated provider mapping;
- stop sequences, seed, response modalities, cached content, agent configuration, URL context, computer-use settings,
  and Gemini file-store IDs without faithful Responses equivalents.

### R3 — `/v1/messages` → `openai-responses`: implemented

The route is direct now: `claude-to-responses.ts` builds the Responses body from the Claude request, and
`responses-to-claude.ts` converts the response back. `messages.ts` no longer builds a synthetic Completions
response, and the SSE egress gained the reasoning events.

Recovered, each lost by the bridge by construction:

- `mcp_servers` → Responses `mcp` tools, the reason this pair was worth building;
- `document` blocks → `input_file` items (`claude-to-openai.ts` skipped them outright, so a PDF never left the proxy);
- `tools[].strict`, declared by both formats and dropped at both hops;
- assistant `thinking` text → a `reasoning` item, and, in the other direction, a `reasoning` summary → a `thinking`
  block, which the synthetic-Completions egress had no position for at all;
- `metadata.user_id` → `metadata`, `output_config.format` → `text.format`.

The comparison the earlier draft of this section asked for, before implementing: most of R3's apparent margin was
**not** architecture. `text.format` already rode the bridge, and `tools[].strict` is a two-line hop fix. What the pair
actually bought is the MCP family plus the `document`/reasoning losses. `service_tier: "auto"` is carried, while
`standard_only` is reported as having no exact Responses value. The other reported drops are `stop_sequences`, `top_k`,
`cached_content`, `cache_control`, and `output_config.task_budget`.

The reasoning-signature case was settled **against** mapping, and against assumption: `openai-to-claude.ts:10-17`
already treats `thinking.signature` as non-load-bearing (it synthesizes a placeholder), and the Interactions ↔
Responses pair refuses the same mapping in both directions. So a client's signature is reported as dropped, and a
thinking block synthesized on the egress carries the shared placeholder. A Responses `reasoning` item carrying only
`encrypted_content` produces no thinking block rather than invented text.

### R4 — `/v1/responses` → either Gemini mode: measure, do not dismiss or assume

These remain the only three-request-hop cells: Responses → Completions → Claude → generateContent. A Responses →
generateContent pair is genuinely absent. Hop count alone does not establish user value; produce a field-survival table
and include response/SSE behavior before prioritizing it.

### R6 — `:generateContent` → `openai-responses`: still bridged

R2 did not change this cell. It can reuse the Responses tool vocabulary and some normalization ideas, but generateContent
history needs its existing tool-call/tool-result/thought handling. Do not substitute the simpler generic `contents`
reader and assume one module automatically covers both Gemini front doors.

### R5 — `/v1/responses` → `anthropic-messages`: implemented

`responses-to-claude-request.ts` builds the Claude body directly after the existing conversation-state expansion. It
preserves function/custom tools and namespace metadata, web search, code execution, MCP connectors, reasoning text,
structured output, media/document inputs, tool history, and usage-related options. MCP responses add the client beta
header. `allowed_tools` remains a response-side hard constraint because Claude cannot express the function set.

The existing Claude JSON/SSE → Responses egress is retained; namespace-qualified function names are restored on both.
Response handling for unrelated server-tool item kinds is not claimed as improved by this refactor.

### R7 — `:generateContent` → `anthropic-messages`: measure

The Gemini → Completions hop retains only function declarations, while Claude declares web-search and code-execution
tools. Direct conversion may therefore recover functionality, but the old zero-margin ruling was never established.
Measure named fields and response/SSE behavior before building it.

### Cases where direct conversion cannot invent a receptor

- Responses targets still have no top-level `seed`, `stop`, or modalities field.
- Claude Messages has no general audio/video inline content block.
- Claude `tool_choice` cannot express a set of allowed function names merely through a direct converter.
- Chat Completions cells are already zero/one request hop; there is no bridged request to remove.

---

## 5. Cost model

The current off-diagonal inventory is fourteen 1-hop cells, three 2-hop cells, two 3-hop cells, and one 0-hop
Gemini-family cell that does not wire native Interactions. This is not an argument to make every cell direct.

A direct pair must account for more than request field mapping:

- `before_conversion` / `before_upstream` / `after_upstream` hooks and `applyMaxTokensCap`;
- blob refs and streamed JSON egress (`createRefAwareJsonBody`), plus bounded/admitted response materialization;
- direct non-streaming response conversion and a direct streamer where fidelity is the goal;
- conversation state, token accounting, privacy/kompress, error envelopes, and per-format terminal failures;
- the request-ref matrix and routed front-door tests, not only isolated converter tests.

The implemented R2 route illustrates both sides: direct mapping recovered real fields, but compatibility fixes were
needed for legacy input envelopes, type-less/generateContent content parts, response model naming, synthetic interaction
IDs, and ref-streaming behavior. R5 additionally preserved namespace restoration, text-only message shape, and the
request-ref matrix.

---

## 6. Recommended sequence now

1. **Keep the corrected labels and routed regression coverage.** Do not reintroduce "Native" for a generateContent
   target or "Direct" for a route that still has a hidden Completions hop.
2. **Measure a named user need before another pair.** R4, R6, and R7 remain eligible; hop count alone is not a
   justification.
3. **Prefer a hop fix when the intermediate preserves the semantics.** Do not build a direct pair for a field that only
   one existing mapper drops accidentally.
4. **Validate semantic mappings against real upstreams.** Provider resource IDs, encrypted reasoning, and built-in tools
   need more than presence checks in a JSON body.
5. **Price request, response, and stream conversion together.** A direct request converter alone does not recover a
   response-side tool or event vocabulary.

---

## 7. Remaining decisions

1. **Native Interactions coverage beyond the two wired cells.** `/v1/messages`, `/v1/responses`, and generateContent
   still use generateContent under `gemini-interactions`. Decide per cell whether to implement native conversion, keep
   the explicitly documented compatibility behavior, or reject the combination.
2. **Where to keep the Completions stream pivot.** It remains useful code reuse on unchanged routes. New direct routes
   should bypass it only when a measured field/event requirement justifies a pair-specific streamer.

---

## Appendix A — documentation drift

Resolved by the implementation tranche:

- the README/API matrices' F1/F2/F4/F5 labels and the native-Interactions mode description;
- the stale Chat Completions comment that said streaming was not wired;
- this review's native passthrough claim, hop grid, direct-streamer inventory, and completed roadmap items.

Still worth separate cleanup:

- `docs/architecture/routing-review.md` retains the original two-route framing and pre-R2 recommendations.
- `docs/api/review-interactions-to-openai-responses-hops.md` is the historical pre-R2 measurement and should be read as
  such; its remaining-work section is not the current implementation status.
- `docs/api/interactions.md` declares its streaming section stale; the SDK vocabulary in
  `src/converters/interactions-stream-events.ts` remains authoritative for the implemented egresses.

## Appendix B — reproducing the current audit

1. Read `resolveUpstreamTarget` in `src/index.ts`, then the selected handler's `upstreamMode` branch. For R2, note that
   the direct branch precedes the legacy Gemini → Completions conversion in `src/handlers/openai.ts`.
2. Inspect the direct pairs directly: `completions-to-interactions.ts`, `interactions-to-completions.ts`,
   `interactions-to-responses.ts`, and `responses-to-interactions.ts`.
3. Use the companion review's maximal-body method for field presence, then validate semantic equivalence with routed
   mocks and, where necessary, real upstream calls.
4. Relevant routed coverage:
   - `tests/unit/chat-completions-interactions.test.ts`
   - `tests/unit/interactions-native-and-responses.test.ts`
   - `tests/unit/responses-gemini-url.test.ts`
   - `tests/unit/interactions-request-field-carry.test.ts`
   - `tests/unit/claude-responses-direct.test.ts`
   - `tests/unit/responses-claude-direct.test.ts`
   - `tests/unit/request-ref-matrix.test.ts`
5. Standard verification: `npm run typecheck`, `npm run build`, and `npm run test:unit`.
