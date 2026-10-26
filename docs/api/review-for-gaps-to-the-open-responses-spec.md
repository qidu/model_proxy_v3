# Gap Analysis: `POST /v1/responses` → Open Responses Specification (2026-04-24)

This analysis maps the **Open Responses specification** (in `docs/api/spec-of-open-responses-2026-04-24.mdx.txt`) onto the current `/v1/responses` implementation in `model_proxy_v3`. Each item includes the spec requirement, current proxy behavior with file/function evidence, and the minimal change needed.

Spec line references in this document point at `docs/api/spec-of-open-responses-2026-04-24.mdx.txt`; code references point at the repo.

## SCOPE RULE (applied throughout)

> **Assume `upstreamMode: openai-responses` is a verbatim pass-through. Deviations below bind the converter paths only.**

`handleAsPassthrough` (`src/handlers/responses.ts:1531`) forwards the request body and the upstream SSE stream unchanged, so on that route every spec obligation — `allowed_tools`, `truncation`, `service_tier`, `previous_response_id`, item lifecycle, terminal events — is the upstream server's to satisfy. Nothing in this document is a defect on that path.

Every item below therefore applies to the three **converter** paths, which re-synthesize both the request and the SSE stream:

- `handleAsCompletions` (`src/handlers/responses.ts:655`) — `openai-completions` upstream
- `handleAsAnthropicMessages` (`src/handlers/responses.ts:522`) — `anthropic-messages` upstream
- `handleAsGemini` (`src/handlers/responses.ts:603`) — `gemini-*` upstream

Both Anthropic and Gemini paths funnel through `convertResponsesToChatCompletions` (`responses.ts:535`, `responses.ts:613`), so they share a single conversion surface.

The WebSocket transport section of the spec is scoped separately (item 14) — the spec says servers **MAY** expose it.

---

## CRITICAL (MUST violations — the client protocol breaks)

### 1. Mid-stream Errors Produce No Terminal Event and Are Swallowed
**Spec** (line 84): *"The stream MUST include a terminal response event (`response.completed`, `response.failed`, or `response.incomplete`)."* And (line 433): *"Any error incurred while streaming will be followed by a `response.failed` event."*

**Current**: Both stream pumps end in a bare `catch` that only closes the writer:

- `streamCompletionsAsResponses` — `src/handlers/responses.ts:1260-1264` (`// Stream ended or errored; close writer to flush what we have`)
- `streamClaudeAsResponses` — `src/handlers/responses.ts:500-502` (`// stream ended or errored`)

If the upstream fails after `response.created` has been sent, the client receives a stream that simply stops: no `response.completed`, no `response.failed`, no `[DONE]`. The proxy cannot distinguish "model finished" from "upstream 500" and discards the reason entirely.

**Evidence**: `grep -rn "response.failed" src/` → **0 hits**. Neither pump has an error branch; the only terminal event emitted anywhere is `response.completed` (`responses.ts:485`, `responses.ts:1253`).

This also violates CLAUDE.md rule 8 (fail loud): a failed stream is reported to the client as an ordinary end-of-stream.

**Fix**: In both `catch` blocks, emit a terminal event before closing the writer. When `response.created` has already been sent, emit `response.failed` with a populated `response.error` (`{code, message}`) and status `failed`; when nothing has been sent yet, propagate to `handleTargetApiError` so a real HTTP status is returned. Never leave the writer closed without a terminal event.

**Status**: ✅ **FIXED** (2026-10-25) — both pumps track a `streamStarted` flag and emit `response.failed` with `error: {code: 'server_error', message}` followed by `[DONE]` once `response.created` has been sent; the error is logged instead of swallowed.

---

### 2. `response.content_part.done` Is Never Emitted
**Spec** (line 258): *"The delta events MAY be repeated many times, and end with `response.<content_type>.done`. The content part is then closed with `response.content_part.done`."*

**Current**: Both pumps go `response.content_part.added` → `response.output_text.delta` → `response.output_text.done` → `response.output_item.done`, skipping the part-close event:

- `streamClaudeAsResponses` — added at `responses.ts:380`, `output_text.done` at `:458`, `output_item.done` at `:467`
- `streamCompletionsAsResponses` — added at `responses.ts:1019`, `output_text.done` at `:1109`, `output_item.done` at `:1126`

**Evidence**: `grep -rn "content_part.done" src/` → **0 hits**. A client that tracks content-part lifecycle (the spec's stated purpose at line 469 — *"Signaling that no further changes will occur to a content part"*) never sees a part close.

**Fix**: Emit `response.content_part.done` (`item_id`, `output_index`, `content_index`, `part` with the accumulated text) immediately before each `response.output_item.done`, in both pumps.

**Status**: ✅ **FIXED** (2026-10-25) — emitted between `output_text.done` and `output_item.done` in both pumps, with `annotations: []` on the part.

---

### 3. `allowed_tools` Is Neither Implemented Nor Enforced
**Spec** (line 547): *"Servers MUST enforce `allowed_tools` as a hard constraint: If `allowed_tools` is present, any tool call to a tool not listed MUST be rejected or suppressed by the server (e.g., by treating it as a model error, translating it into a direct reply, or applying provider-specific fallback behavior)."*

**Current**: The field is not read anywhere. `grep -rn "allowed_tools" src/` → only the generic `tool_choice` branch in `convertResponsesToChatCompletions` (`src/converters/responses-to-completions.ts:259-272`), which handles the `{type:"function"}` form and forwards **everything else verbatim**:

```ts
} else {
  // "auto" | "none" | "required" — pass through as-is
  completionsRequest.tool_choice = tc as OpenAIRequest['tool_choice'];
}
```

**Evidence**: The structured form the spec documents as the enforcement surface — `tool_choice: {type:"allowed_tools", tools:[...]}` — reaches a Chat Completions upstream as an object it does not define, which typical upstreams reject with a 400 `invalid tool_choice`. The top-level `allowed_tools` field (spec line 547 area) is not copied by the converter at all and is dropped silently. No filtering or post-validation is applied to the model's tool calls on the response side either.

Net effect: on the converter paths the client's hard constraint is either an upstream error or a no-op. Neither is enforcement.

**Fix**: Two halves, both required. (a) Translate `tool_choice: {type:"allowed_tools", tools:[...]}` into a form the target upstream understands, or pass the full `tools` list and enforce locally. (b) Enforce on the response: any `function_call` naming a tool outside the allowed set must be rejected/suppressed per the spec, and the violation reported rather than returned as a normal tool call. Surfacing the spec's own option — translating a fully-suppressed call into a direct reply — is the least disruptive behavior.

**Status**: ✅ **FIXED** (2026-10-25) — (a) the converter translates `tool_choice: {type:"allowed_tools", tools:[...]}` to `auto` (`none` for an empty subset) while keeping the full `tools` list upstream; (b) a new exported `extractAllowedTools()` reads both the `tool_choice` form and a top-level `allowed_tools` array, and both stream pumps plus both non-streaming converters suppress disallowed tool calls (no lifecycle events, no `output` entry), log the suppressed count, and fall back to a direct-reply message item if suppression empties the output.

---

### 4. `previous_response_id` Is Silently Ignored on 3 of 4 Paths, and Silently Forgotten Otherwise
**Spec** (line 502): *"When `previous_response_id` is provided, the server MUST load both the input and output associated with that prior response and treat them as part of the new request's context."* Order is mandated (line 514): *"`previous_response.input` → `previous_response.output` → `input`."*

**Current**:

- **`openai-responses` (passthrough)** — compliant by delegation: the field is forwarded upstream.
- **`openai-completions`** — implemented: `responses.ts:668-717` merges `prior.inputItems` + `prior.outputItems` in the mandated order and deletes the field before conversion (`:717`).
- **`anthropic-messages` and `gemini-*`** — **not implemented**: both call `convertResponsesToChatCompletions` (`responses.ts:535`, `:613`) with no prior-state handling, and the converter never reads `previous_response_id` (`grep` → 0 hits in `src/converters/responses-to-completions.ts`). The field is dropped and the request proceeds with only the new `input`.

The merge in the completions path is additionally gated on `CONVERSATION_STATE` (`responses.ts:668`), which defaults to `'false'` (`src/server.ts:57`).

The store **miss** path is the sharper problem:

```ts
// src/handlers/responses.ts:694-700
const prior = getConversation(previousResponseId);
if (prior) { mergedInput = [...prior.inputItems, ...prior.outputItems, ...mergedInput]; }
else {
  logger.debug(requestId, `[conversation] previous_response_id=${previousResponseId} not found in store (expired or unknown)`);
}
```

An expired, evicted, or `store:false` prior response produces a **debug log and a normal answer**, so the model silently loses the entire conversation context while the client believes it resumed a thread. The spec provides the exact error for this (`previous_response_not_found`, lines 125/127/173); `grep -rn "previous_response_not_found" src/` → **0 hits**.

**Fix**: (a) Read `previous_response_id` in the Anthropic/Gemini paths, or make those paths reject it explicitly rather than ignore it. (b) Replace the silent store miss with an error carrying code `previous_response_not_found`; never continue a continuation request with the prior context missing. (c) Decide the `CONVERSATION_STATE=false` behavior (see *Decisions needed*).

**Status**: ✅ **FIXED** (2026-10-25) — decision A resolved as option (2): with `CONVERSATION_STATE` enabled, a store miss fails with 404 `{error: {type: "not_found", code: "previous_response_not_found", param: "previous_response_id"}}` and no upstream call; with state disabled the field is still ignored (existing behavior preserved). A shared `applyConversationState` helper now applies the merge on all three converter paths (completions, anthropic-messages, gemini-*).

---

## HIGH (Core compliance — client behavior diverges)

### 5. Status Is Hardcoded `completed`; `incomplete` Is Never Used
**Spec** (line 230): *"`incomplete` — the model has exhausted its token budget while emitting tokens belonging to this item. This is a terminal state. If an item ends in a terminal state, it MUST be the last item emitted, and the containing response also MUST be in an `incomplete` state."*

**Current**: `convertCompletionsToResponses` writes `status: 'completed'` unconditionally — `src/converters/completions-to-responses.ts:75, 80, 91, 150, 171, 216` — and never inspects `finish_reason` (its only appearance is a comment at `:181`). The stream paths do the same: `responses.ts:492`, `:1133`, `:1159`, `:1185`, `:1200`.

**Evidence**: A `finish_reason: "length"` truncation — the model ran out of token budget mid-message — is reported to the client as a fully completed response, with `response.completed` as the terminal event. The response's `status` field, the item's `status`, and the terminal event type all say `completed`. The `IncompleteResponse` state the spec defines is unreachable in this implementation.

**Fix**: Map `finish_reason: "length"` → item `status: 'incomplete'`, response `status: 'incomplete'`, terminal event `response.incomplete`. The Anthropic path has the equivalent signal in `stop_reason: "max_tokens"`.

**Status**: ✅ **FIXED** (2026-10-25) — both pumps and both non-streaming converters map `finish_reason: "length"` / `stop_reason: "max_tokens"` to item+response `status: 'incomplete'`, terminal event `response.incomplete`, and `incomplete_details: { reason: 'max_output_tokens' }`.

---

### 6. `output_index` Collision in the Claude Stream Path
**Spec** (line 258 and the event examples): `output_index` identifies which output item an event belongs to; every event for an item must carry that item's index.

**Current**: `streamClaudeAsResponses` allocates indices correctly for `response.output_item.added` (`responses.ts:373` message, `:391` function_call — both from `nextOutputIndex++`) but then hardcodes `output_index: 0` for every text event:

- `response.output_text.delta` — `responses.ts:412` (`output_index: 0, // text item is always first`)
- `response.output_text.done` — `responses.ts:462`
- `response.output_item.done` — `responses.ts:469`

The comment's premise does not hold. Claude emits `content_block_start` with `tool_use` before any `text` block whenever it goes straight to a tool (a common case). Then the `function_call` item takes index 0, the `message` item takes index 1, and every subsequent text event still claims index 0 — colliding with the function-call item.

**Evidence**: The completions pump already does this correctly with a `textOutputIndex` variable (`responses.ts:1016, 1023, 1113, 1129`), so the two pumps disagree on the same wire format.

**Fix**: Replace the three hardcoded `0`s with the `outputIndex` captured when the text part was opened. The message item's index is allocated lazily at first text delta, so the value must be stored, not recomputed.

**Status**: ✅ **FIXED** (2026-10-25) — the Claude pump tracks `textOutputIndex` (set when the text item opens) and uses it for the text delta/done/part-done/item-done events.

---

### 7. Error Envelope Is Anthropic-Shaped, Not Responses-Shaped
**Spec** (lines 422-445): a structured object `{"error": {"message", "type", "param", "code"}}`, with types `server_error` (500), `invalid_request` (400), `not_found` (404), `model_error` (500), `too_many_requests` (429).

**Current**: Two different envelopes are produced inside the same endpoint.

*Responses-shaped (correct)* — the retrieval 404, `handleResponsesRetrievalRequest` (`src/handlers/responses.ts:119-122`):

```ts
JSON.stringify({ error: { message, type: 'invalid_request_error', param: null, code: null } })
```

*Anthropic-shaped (wrong for this endpoint)* — every other error from `/v1/responses`: `createErrorResponse` (`src/utils/errors.ts:186-196`) returns `{type:'error', error:{type, message}}` with **no** `param` and **no** `code`, and `handleTargetApiError` (`src/utils/errors.ts:238-262` onward) maps upstream statuses onto Anthropic types (`invalid_request_error`, `authentication_error`, `permission_error`, `rate_limit_error`, `processing_error`) rather than the spec's set. Reached from the outer catch at `src/index.ts:2734-2743` and from all 14 `handleTargetApiError` call sites in `responses.ts`.

**Evidence**: A Responses-shaped client reading `error.type` sees `rate_limit_error` where the spec defines `too_many_requests`, and `error.code` is never populated, so `model_not_found` and `previous_response_not_found` are unexpressible. Two shapes in one handler is also a CLAUDE.md rule 5 situation — see *Decisions needed*.

**Fix**: Emit the Responses envelope for `/v1/responses` errors: `{error:{message, type, param, code}}` with the spec's type vocabulary. Cannot be done inside `createErrorResponse` alone, since that helper is shared with the Anthropic endpoints — see *Decisions needed*.

**Status**: ✅ **FIXED** (2026-10-25) — decision B resolved as option (1): new `ResponsesApiError` / `createResponsesErrorResponse` / `handleResponsesApiError` in `src/utils/errors.ts` emit `{error: {message, type, param, code}}` with the spec's type vocabulary; the outer catch in `src/index.ts` selects the envelope by path, so `/v1/messages` keeps the Anthropic envelope unchanged.

---

## MEDIUM (Feature completeness)

### 8. Items Appear in `output` With No Stream Events
**Spec** (lines 223-231, and the item lifecycle list): items have a lifecycle, and streamable content "MUST be backed by a content part."

**Current**: The reasoning item and the empty-fallback message item are pushed into the final `output` array but never announced:

- reasoning item included in `response.completed` — `responses.ts:1182-1187`
- fallback empty message when the stream produced only reasoning — `responses.ts:1218-1224`; Claude-path equivalent at `responses.ts:482`

A client that builds response state from SSE events sees items in the terminal payload that it was never told about, with no `output_item.added` / `content_part.added` / `output_item.done`.

Note the fallback item exists for a real reason — the code comment at `responses.ts:1214-1216` explains it avoids an invalid `output: []` — so its presence is not the defect; the missing lifecycle events are.

**Fix**: Emit the full lifecycle (`output_item.added` → `content_part.added` → `content_part.done` → `output_item.done`) for both synthesized item types before they appear in the terminal `output`, rather than adding them to the payload silently.

**Status**: ✅ **FIXED** (2026-10-25) — the completions pump announces the reasoning item on the first reasoning delta and closes it before the text item opens (or at end of stream); the fallback empty message item gets the full four-event lifecycle in both pumps; terminal `output` arrays are assembled in `output_index` order so event indices match payload positions.

---

### 9. `annotations` Is Missing From `output_text` Parts
**Spec** (lines 271, 305, 329 — every `output_text` part in the examples): carries `"annotations": []`.

**Current**: parts are emitted as `{type:'output_text', text}` with no `annotations` — `responses.ts:386` and `:1025` (content-part added, empty text), `:470` / `:1134` (item done, accumulated text), and the non-streaming builder in `src/converters/completions-to-responses.ts`. The spec's requirement that non-nullable fields carry zero values is what `annotations: []` satisfies.

**Fix**: Add `annotations: []` to every `output_text` part in both pumps and in the converter.

**Status**: ✅ **FIXED** (2026-10-25) — `annotations: []` on every `output_text` part in both stream pumps, the terminal `output` arrays, and both non-streaming converters.

---

### 10. Request Parameters Silently Dropped by the Converter
**Spec**: `truncation` (line 612): *"`disabled`: The server MUST NOT truncate any input. If the combined context exceeds the model's maximum context window, the request MUST fail with an error instead of silently dropping content."* `service_tier` (line 621) is a scheduling hint.

**Current**: `convertResponsesToChatCompletions` is a whitelist (`src/converters/responses-to-completions.ts:127-307`). Verified absent from it: `truncation`, `service_tier`, `parallel_tool_calls`, `metadata`, `include`, and `text`. It copies `response_format` instead (`:201-202`), but the Responses API spells structured output `text.format`, so a client using `text.format` has it ignored.

The `truncation: "disabled"` case is the one with a MUST attached: the parameter is not forwarded, so the proxy neither honors the no-truncation guarantee nor fails when context is exceeded — the mode has no observable effect in either direction.

**Fix**: Forward `service_tier`, `metadata`, `parallel_tool_calls` (all natively supported by the completions upstreams); map `text.format` → `response_format`; for `truncation: "disabled"`, either enforce the context check and fail loudly, or reject the request as unsupported. Do not silently accept it.

**Status**: ✅ **FIXED** (2026-10-25) — `service_tier` / `metadata` / `parallel_tool_calls` are forwarded; `text.format` (`json_schema` / `json_object` / `text`) maps to `response_format` and wins over a directly-passed `response_format`; `truncation: "auto" | "disabled"` is validated and deliberately not forwarded — completions upstreams fail with a context-length error rather than truncating, which is exactly the `disabled` contract and is permitted under `auto` (truncation is a MAY there). Invalid `truncation` / `text.format` values throw a 400 `ValidationError`. `include` remains dropped (converter paths do not support it).

---

### 11. Un-prefixed Schema Extensions
**Spec**: extension fields and item types are expected to be provider-slug-prefixed (the spec's own example is `acme:search_result`), so conformant clients may treat anything else as unknown and discard it.

**Current**: the implementation adds bare extension names:

- `{type:'reasoning_text'}` content parts inside `message` items — `responses.ts:1124`, `:1186`, `:1195`; `src/converters/completions-to-responses.ts:151`, `:157`
- `namespace` on `function_call` items — `responses.ts:1065`, `:1163`, `:1169`; `src/converters/completions-to-responses.ts:175`

**Fix**: Prefix them with this proxy's slug (e.g. `modelproxy:reasoning_text`), keeping the unprefixed spelling only if a known client depends on it — in which case both should be emitted and the dependency documented.

**Status**: ⚠️ **DOCUMENTED EXCEPTION (2026-10-25) — no code change.** Both fields are OpenAI Responses API conventions with a live round-trip dependency: `reasoning_text` content parts and `namespace` on `function_call` items are read back by `convertResponsesToChatCompletions` when Codex/DeepSeek clients send the conversation back as input (thinking-mode upstreams reject the next turn if reasoning is not round-tripped). Emitting both the bare and a `modelproxy:`-prefixed spelling would double-inject the reasoning text on the next turn, and dropping the bare spelling would break those clients. The deviation from the spec's extension-prefixing guidance is accepted and recorded here.

---

### 12. Unknown Input Item Types Are Dropped With Only a Warning
**Current**: `warnUnhandledItem` in `src/converters/responses-to-completions.ts` logs and drops unrecognized input item types. By contrast, `program` / `program_output` correctly throw `ValidationError` (`responses-to-completions.ts:127` onward), which is the rule-8-conformant behavior.

**Current effect**: a client sending an item type this proxy does not model gets a plausible-looking answer computed from partial context, with the loss recorded only in a log line.

**Fix**: Extend the throwing behavior to all unknown input item types, or return them in the response's error/notice surface. At minimum, do not answer as if the input were complete.

**Status**: ✅ **FIXED** (2026-10-25) — `warnUnhandledItem` is removed; the converter now throws a 400 `ValidationError` for every unrecognized input item type (including provider-slug-prefixed extension types such as `acme:search_result`), pointing the client at an `openai-responses` passthrough upstream. The error surfaces through the outer catch as the spec envelope `{error: {type: "invalid_request", ...}}`.

---

## LOWER (Polish / edge cases)

### 13. `logprobs` Omitted From `output_text.delta`
**Spec**: the delta examples always carry `"logprobs": []`.

**Current**: `logprobs` / `top_logprobs` are accepted and forwarded to the upstream (`src/converters/responses-to-completions.ts:284` onward) but the Responses stream never surfaces them back (`responses.ts:406-413`, `:1032-1040`).

**Fix**: Emit `logprobs` on deltas when the upstream supplies them; emit `[]` otherwise.

**Status**: ✅ **FIXED** (2026-10-25) — `response.output_text.delta` carries the upstream chunk's `logprobs.content` when present, `[]` otherwise; the Claude pump always emits `[]` (Claude SSE deltas carry no logprobs).

---

### 14. WebSocket Transport Is Absent
**Spec** (lines 117-173): the 2026-04-24 revision adds a WebSocket transport — `type: "response.create"` turn messages, one in-flight response per connection, connection-local previous-response state, a 60-minute connection limit with `websocket_connection_limit_reached`, `store=false` continuation failing with `previous_response_not_found`, and the `/responses/compact` reconnect pattern.

**Current**: nothing implemented — `grep -rn "response.create\|websocket_connection_limit_reached\|previous_response_not_found" src/` → 0 hits for all three. The HTTP `/v1/responses/compact` handler *is* implemented (`responses.ts:1404-1409`).

**Assessment**: the spec says servers **MAY** expose WebSocket, so its absence is compliant. Recorded because the compaction-reconnect flow the spec describes has no server side here, and because the connection-local state model is a different design from the current process-wide `CONVERSATION_STATE` store (which would not provide the `store=false` zero-retention guarantee the spec describes).

**Status**: ✅ **COMPLIANT (not required)** — no fix planned unless WebSocket is wanted.

---

### 15. GET Retrieval Is Gated Behind `CONVERSATION_STATE`
`handleResponsesRetrievalRequest` (`responses.ts:111`) serves `GET /v1/responses/{id}` and `/{id}/input_items` from the in-process store, and is only reachable when `CONVERSATION_STATE` is `'true'`/`'1'` (`src/index.ts:1120`); otherwise the request falls through. The spec does not mandate a GET retrieval endpoint, so this is informational — but note the coupling: turning state off silently removes retrieval rather than returning a documented error.

**Status**: ✅ **COMPLIANT** — informational.

---

### 16. `model_not_found` Is Unreachable
The spec's error example (line 442) is `{"type": "invalid_request_error", "code": "model_not_found"}`. In this proxy an unknown or unconfigured model falls back to the default model with a fail-open log (`src/utils/config-loader.ts:1046`), so that code can never be produced.

**Assessment**: likely intentional routing policy rather than an oversight — recording it so the divergence is known, not asserting it is a defect.

**Status**: ✅ **COMPLIANT** — informational; flagged for confirmation.

---

## VERIFIED COMPLIANT (no change needed)

Confirmed against the spec, so they are not re-litigated above:

- `Content-Type: text/event-stream` for streams, `application/json` for non-streaming (spec line 84).
- The `event:` field always matches the `type` in the body; no SSE `id` is ever set (spec line 86 — *"Servers SHOULD NOT use `id`"*).
- `sequence_number` is monotonic within a stream (`nextSeq()` in both pumps).
- `response.output_item.added` always precedes that item's content events.
- `[DONE]` is emitted only after the terminal event (permitted, spec line 84).
- `store` defaults to `true` (`responses.ts:685`); `store: false` suppresses persistence in the completions path (`:809`, `:833`).
- `previous_response_id` + `conversation` together is rejected with 400 (`responses.ts:675-678`).
- Merge **order** in the stateful path is the mandated `prior.input → prior.output → input` (`responses.ts:695`).
- `tool_choice: {type:"function", name}` → `{type:"function", function:{name}}` (`responses-to-completions.ts:259-266`); `"auto" | "none" | "required"` pass through.
- WebSocket absence (spec **MAY**) — item 14.

---

## DECISIONS NEEDED — RESOLVED (2026-10-25)

Both convention questions have been decided and implemented:

**A. Item 4 — resolved as option (2).** With `CONVERSATION_STATE` enabled, a missing `previous_response_id` errors with 404 `previous_response_not_found`; with state disabled the field is ignored. The existing test at `tests/unit/responses-conversation-state.test.ts` asserting the disabled-case drop still holds; new tests cover the enabled-case error and the Anthropic-path merge.

**B. Item 7 — resolved as option (1).** A Responses-specific error builder (`createResponsesErrorResponse` / `handleResponsesApiError` / `ResponsesApiError` in `src/utils/errors.ts`) is selected at the `/v1/responses` handler boundary in `src/index.ts`; the shared Anthropic-shaped helpers are untouched and `/v1/messages` behavior is unchanged.

---

## FILES TOUCHED BY THIS ANALYSIS

No files were modified. Files that an implementation would touch:

| File | Items |
|---|---|
| `src/handlers/responses.ts` | 1, 2, 4, 5, 6, 8, 9, 11 |
| `src/converters/responses-to-completions.ts` | 3, 4, 5, 10, 11, 12 |
| `src/converters/completions-to-responses.ts` | 5, 9, 11 |
| `src/utils/errors.ts` | 4, 7 |
| `src/utils/conversation-store.ts` | 4 |
| `src/index.ts` | 7, 15 |
| `src/server.ts` | 4 (decision A) |
| `tests/unit/responses-conversation-state.test.ts` | 4 (decision A — asserts current behavior) |
| `tests/unit/responses-completions-roundtrip.test.ts` | 1, 2, 5, 6, 8, 9 — **no SSE event-shape tests exist today**: `grep` for `content_part`, `sequence_number`, `response.completed`, `response.failed`, `annotations` in `tests/` returns nothing |

---

## STATUS SUMMARY

| # | Item | Severity | Status |
|---|---|---|---|
| 1 | Terminal event on mid-stream error (`response.failed`) | CRITICAL | ✅ FIXED |
| 2 | `response.content_part.done` | CRITICAL | ✅ FIXED |
| 3 | `allowed_tools` enforcement | CRITICAL | ✅ FIXED |
| 4 | `previous_response_id` on non-completions paths / silent miss | CRITICAL | ✅ FIXED (decision A → option 2) |
| 5 | `status: incomplete` from `finish_reason` | HIGH | ✅ FIXED |
| 6 | `output_index` collision in Claude pump | HIGH | ✅ FIXED |
| 7 | Responses-shaped error envelope | HIGH | ✅ FIXED (decision B → option 1) |
| 8 | Items in `output` with no stream events | MEDIUM | ✅ FIXED |
| 9 | `annotations: []` on content parts | MEDIUM | ✅ FIXED |
| 10 | Dropped params (`truncation`, `service_tier`, `text.format`, …) | MEDIUM | ✅ FIXED |
| 11 | Un-prefixed extensions (`reasoning_text`, `namespace`) | MEDIUM | ⚠️ DOCUMENTED EXCEPTION (round-trip dependency) |
| 12 | Unknown item types dropped with a warning | MEDIUM | ✅ FIXED (now throws 400) |
| 13 | `logprobs` on delta | LOWER | ✅ FIXED |
| 14 | WebSocket transport | LOWER | ✅ COMPLIANT (MAY) |
| 15 | GET retrieval gated on `CONVERSATION_STATE` | LOWER | ✅ COMPLIANT |
| 16 | `model_not_found` unreachable (fail-open) | LOWER | ✅ COMPLIANT |

Net: **12 FIXED (1–10, 12, 13 — all 4 MUST violations), 1 DOCUMENTED EXCEPTION (11), 3 COMPLIANT-and-not-required.** SSE event-shape coverage for the stream-level fixes lives in `tests/unit/responses-stream-events.test.ts`.

---

## IMPLEMENTATION ORDER (Respecting CLAUDE.md Rules 1, 3, 5)

All items are scoped to the converter paths (`openai-completions`, `anthropic-messages`, `gemini-*`) unless stated.

1. **Item 1** — terminal event + error propagation in both pumps. Highest user impact: today a failed stream is indistinguishable from a clean one.
2. **Item 2** — `response.content_part.done`. Small, local, same two functions as item 1; do them together.
3. **Item 6** — `output_index` in the Claude pump. Same function as item 2, one-line class of fix, and it corrupts item association for tool-first responses.
4. **Decisions A and B** — resolve the two convention questions, then implement **item 4** and **item 7**.
5. **Item 5** — `incomplete` states from `finish_reason` / `stop_reason`.
6. **Item 3** — `allowed_tools` enforcement. The only item requiring new behavior rather than corrected behavior; needs its own design (local filtering plus response-side validation, and a decision on the spec's "translate into a direct reply" option).
7. **Items 8, 9, 11, 12** — item lifecycle, `annotations`, extension prefixes, unknown-item handling.
8. **Item 10** — parameter forwarding, including the `truncation: "disabled"` MUST.
9. **Item 13** — `logprobs`, if wanted.
10. **Tests** — SSE event-shape coverage for items 1, 2, 3, 5, 6, 8, 9, 12, and 13 lives in `tests/unit/responses-stream-events.test.ts` (full lifecycle sequence, mid-stream `response.failed`, truncation → `response.incomplete`, allowed_tools suppression, reasoning/fallback lifecycle, logprobs, for both pumps plus non-streaming conversion); converter-level coverage for items 3, 10, and 12 in `tests/unit/responses-completions-roundtrip.test.ts`.

---

**Next step**: none — all actionable items are resolved. Items 1–10, 12, and 13 are fixed (see per-item status notes); item 11 is a documented exception (round-trip dependency on the bare `reasoning_text` / `namespace` spellings); items 14–16 are compliant-and-not-required. SSE event-shape coverage for items 1, 2, 3, 5, 6, 8, 9, 12, and 13 lives in `tests/unit/responses-stream-events.test.ts`; converter-level coverage for items 3, 10, and 12 in `tests/unit/responses-completions-roundtrip.test.ts`.
