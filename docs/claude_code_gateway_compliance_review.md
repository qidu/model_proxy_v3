# Gap Analysis: Model Proxy v3 → Claude Code Gateway Compliance

This analysis maps the **Anthropic "Claude Code LLM Gateway Compatibility Guide"** (in `docs/api/llm-gateway-protocol-for-claude-code.md`) onto the current `model_proxy_v3` codebase. Each item includes the spec requirement, current proxy behavior with file/function evidence, and the minimal change needed.

## SCOPE RULE (applied throughout)

> **Assume an `anthropic-messages` upstream carries the Anthropic headers. Do NOT assume `openai-*` or `gemini-*` upstreams carry them.**

Anthropic-specific header obligations (`retry-after`, `x-should-retry`, `anthropic-ratelimit-unified-*`, `anthropic-beta`, `anthropic-version`, `anthropic-workspace-id`, `x-claude-code-*`) are therefore scoped to the native `anthropic-messages` route only. That is the route Claude Code actually uses against an Anthropic-compatible gateway (`src/index.ts:2408-2417` dispatches non-SDK `anthropic-messages` → `handleClaudeRequest`).

Consequences:
- **Converted paths are out of scope** for header-forwarding items (2, 11). They talk to OpenAI/Gemini-shaped upstreams that have no such headers to forward; synthesizing them would be fabricating signals.
- **The proxy's own locally-generated 429/503 stay in scope** regardless of upstream mode — those are the proxy's signal, not the upstream's, and Claude Code reads them the same way.
- Body-shape obligations (1, 7, 12) remain in scope for all paths, since they concern payload content rather than headers.

---

## CRITICAL (Blocking — capability-rejection recovery breaks)

### 1. Error Response Bodies Must Be Forwarded Unmodified
**Spec**: "Forward error response bodies unmodified... Claude Code relies on matching upstream error wording for capability-rejection recovery." — section *Automatic retry and error forwarding*

**Current**: `src/utils/errors.ts:234-301` `handleTargetApiError()` switches on status, synthesizes `errorMessage` from `extractUpstreamMessage(requestInfo?.upstreamBody)` and throws `ClaudeProxyError` with a **new** body (`{type, error: {type, message}}`) — the upstream body is only used to extract the message for the log, never forwarded verbatim.

**Evidence**: Every upstream-error path routes through it:
- `src/handlers/claude.ts:157` — the **native `anthropic-messages` pass-through** also wraps (`handleTargetApiError(response, 'Claude API', { upstreamBody })`), so this is not limited to the converted paths.
- `src/handlers/messages.ts:631-635`, `761-771` and `src/handlers/responses.ts` (14 sites: 576-580, 799-804, 1342-1346, 1391-1395, 1467-1471, 1516-1520, 1578-1583).
- `src/handlers/token-counting.ts:203-240`.

→ client always receives a proxy-generated error envelope.

**Fix**: When upstream returns 4xx/5xx, **pipe the raw upstream response body** to the client. Only wrap if upstream body is non-JSON or missing. This must be done at the handler level (not in `handleTargetApiError` which always wraps).

Per the scope rule, the *header*-preservation half of this fix applies to `anthropic-messages` only; the *body*-forwarding half applies to every path, since error wording is payload, not an Anthropic header.

**Status**: ⏳ **PENDING** — affects the native pass-through too (`claude.ts:157`), not just the converted paths. Requires handler-level changes to pipe raw upstream error bodies.

---

### 2. Response Headers Required by Claude Code Are Missing
**Spec** (section *Response headers*):
- `retry-after` — **integer seconds** (not HTTP-date), on every 429/503
- `x-should-retry` — pass upstream `true`/`false` through
- `anthropic-ratelimit-unified-*` — forward on **every** response (success + 429)
- `content-type: text/event-stream` for streams

**Current**:

*Native `anthropic-messages` pass-through (`src/handlers/claude.ts`) — COMPLIANT:*
- `claude.ts:174` (SSE) and `claude.ts:198` (non-SSE) both build the outbound `Response` with `sanitizeUpstreamResponseHeaders(response)` (routing.ts:643-659), which copies **all** upstream headers and deletes only `content-encoding` / `content-length` (required because Node/undici auto-decompresses). `retry-after`, `x-should-retry`, `anthropic-ratelimit-unified-*`, and `content-type: text/event-stream` all survive. This is the primary Claude Code path (`src/index.ts:2408-2417` dispatches non-SDK `anthropic-messages` → `handleClaudeRequest`).

*Locally-generated 429/503 — NOT compliant (in scope under the scope rule, since the signal is the proxy's own):*
- `src/utils/errors.ts:194-200` `createErrorResponse()` only emits `Content-Type` + `x-request-id`. `OverLimitError` (errors.ts:71) and `RateLimitError` (errors.ts:52) both produce HTTP 429 (`errors.ts:276`) with **no** `retry-after` and **no** `x-should-retry`. The proxy already knows the backoff it intends — `src/index.ts:2620-2625` `parseRetryAfterMs()` parses upstream `retry-after` for the local ladder — but nothing re-emits it.
- Per spec, `retry-after` must be **integer seconds, not an HTTP-date**.

*Converted paths — OUT OF SCOPE:*
Per the scope rule, `openai-*` / `gemini-*` upstreams do not carry Anthropic headers, so there is nothing to forward. Recorded for completeness only — **no fix required**:
- `src/handlers/messages.ts:814-819` `handleNonStreamingResponse`: `{ 'Content-Type': 'application/json', 'x-request-id' }`
- `src/handlers/messages.ts:917-924` `handleStreamingResponse` and `1110-1115` `handleResponsesStreamAsClaude`
- `src/handlers/responses.ts` — all 14 outbound `Response` sites (120, 139, 149, 508-513, 593-595, 646-648, 840-842, 1268-1273, 1352-1354, 1397-1399, 1477-1479, 1522-1524, 1602-1607, 1615-1617)
- `src/utils/sdk-handler.ts:379-496` `handleSdkAnthropicRequest` (also omits `x-request-id` entirely — cosmetic only)

**Fix** (narrowed):
1. `createErrorResponse()` (errors.ts:194-200) — when `responseStatus` is 429 or 503, emit `retry-after: <integer seconds>` and `x-should-retry: true`. Thread the intended backoff duration in from the caller.
2. Ensure `sanitizeUpstreamResponseHeaders()` (routing.ts:643-659) does **not** delete these headers — **already satisfied**, it only strips `content-encoding` / `content-length`.

**Status**: ✅ **FIXED for upstream pass-through** (`claude.ts:174,198` forwards everything). ⏳ **PENDING** for the proxy's own 429/503 — `createErrorResponse()` still emits neither `retry-after` nor `x-should-retry`.

---

### 3. Streaming: Synthesize `ping` Events for Pingless Upstreams
**Spec**: "Forward keep-alive `ping` events — synthesize your own pings when translating from a pingless upstream (Claude Code aborts after 5 min of no bytes)."

**Current**: no `ping` event (nor SSE comment heartbeat) is produced anywhere in the codebase — a repo-wide search for `ping` in the streaming paths returns nothing. Specifically:
- `src/handlers/messages.ts:943-1118` `handleStreamingResponse()` / `handleResponsesStreamAsClaude()` — relays upstream SSE chunks verbatim.
- `src/handlers/responses.ts:297-516` `streamClaudeAsResponses()` and `860-1276` `streamCompletionsAsResponses()` — emit no pings.
- `src/converters/streaming.ts` — the Claude-emitting converter (`sendEvent` call sites at 333-342, 532-539) emits `message_delta` / `message_stop` only.
- `src/utils/sdk-handler.ts:443-449` — the SDK SSE path emits no keep-alive.
- `src/handlers/claude.ts:168-180` — native pass-through correctly relays upstream pings **when the upstream sends them**; a pingless upstream (Bedrock `application/vnd.amazon.eventstream`, many OpenAI-compatible gateways) yields 5 minutes of silence and a client abort.

**Fix**: In each streaming handler, start a 30–45 s interval that writes `: ping\n\n` (SSE comment) when no data events have been sent in that window. Stop interval on stream close. For the native pass-through path, wrap `response.body` in a `TransformStream` that interleaves the heartbeat rather than returning it untouched.

**Status**: ⏳ **PENDING** — no keep-alive synthesis on any path.

---

## HIGH (Core compliance — client behavior diverges)

### 4. `/v1/models` Anthropic Discovery Shape & Filtering
**Spec** (section *Model discovery*):
- `GET /v1/models?limit=1000`, **3 s timeout**, redirect = failure
- Gated by `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`
- **Reads `id` / optional `display_name` / optional `description`**
- **Keeps entries whose `id` contains `claude` or `anthropic` anywhere (case-insensitive)**
- Cached to `~/.claude/cache/gateway-models.json`
- Sends **both** `Authorization` and `x-api-key` (v2.1.248+)

**Current**: `src/index.ts:2368-2373` has a `case 'models':` special case keyed on `user-agent.includes('claude-cli')`:
```typescript
const anthropicModels = body.data.map((model: any) => ({
  id: model.id, type: 'model',
  created_at: new Date(model.created * 1000).toISOString(),
  display_name: model.id,   // ← no description
}));
```
- **No `description` field**
- **No `claude`/`anthropic` substring filter**
- Keys on `claude-cli` UA instead of serving Anthropic shape natively
- No 3 s timeout / redirect-failure logic
- No `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` gate (the identifier does not appear anywhere in the repo)
- No `~/.claude/cache/gateway-models.json` write
- `x-api-key` is not forwarded alongside `Authorization` on the discovery fetch

**Status**: ⏳ **PENDING**

**Fix**: 
1. Add env gate `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`.
2. New `handleAnthropicModelsDiscovery()` that: calls upstream with 3 s timeout (abort on redirect), maps to Anthropic shape (`id`, `display_name`, `description`), filters `id.toLowerCase().includes('claude') || id.toLowerCase().includes('anthropic')`, returns `object: 'list', data: [...]`.
3. Serve this shape for **all** `/v1/models` requests when the gate is on (not just `claude-cli` UA).
4. Forward both `Authorization` and `x-api-key` upstream.

---

### 5. Header Forwarding: `anthropic-workspace-id` (Claude Platform on AWS)
**Spec**: "Forward `anthropic-version` and `anthropic-beta` unchanged, **plus `anthropic-workspace-id` when the upstream is the Claude Platform on AWS**."

**Current**: `src/utils/routing.ts:329-339` `extractAuthHeaders()` and `transformAuthHeadersForUpstream()` forward `anthropic-beta` (validated) but **never read or forward `anthropic-workspace-id`**.

**Fix**: In `transformAuthHeadersForUpstream()` when `upstreamMode === 'anthropic-messages'` and target URL matches `*.anthropic.*` or `*.aws.*` (or configurable), read `request.headers.get('anthropic-workspace-id')` and forward it.

**Status**: ✅ **FIXED** — `extractAuthHeaders()` and `transformAuthHeadersForUpstream()` in `src/utils/routing.ts` now read and forward `anthropic-workspace-id` along with `anthropic-version` and `x-claude-code-*` headers.

---

### 6. Gateway Hint Headers (`x-claude-code-*`) — Consume for Routing/Attribution
**Spec** (section *Gateway hint headers*):
- `x-claude-code-request-class` (`main|subagent|workflow|compaction|auxiliary`)
- `x-claude-code-agent-type` (`Explore|Plan|general-purpose|custom|teammate|fork`)
- `x-claude-code-compaction` (`auto|manual|reactive`)
- `x-claude-code-context-compacted`
- `x-claude-code-prev-tool-durations` (`<name>=<ms>;...` ≤32 entries / 4 KB, percent-encoded)
- `x-claude-code-prompt-id` (UUID, v2.1.283+)

**Current**: the headers are **forwarded upstream but never parsed or acted upon**. `src/utils/routing.ts:354-360` (`extractAuthHeaders`) and `499-504` (`transformAuthHeadersForUpstream`) both loop over `request.headers.entries()` and copy any key matching `x-claude-code-` verbatim. Nothing in the repo reads `x-claude-code-request-class`, `-agent-type`, `-compaction`, `-context-compacted`, `-prev-tool-durations`, or `-prompt-id`. Separately, `user-agent` is special-cased at `src/index.ts:2371-2373` for the model-list transform.

**Fix**: 
1. Add `extractClaudeCodeHints(request: Request)` in `routing.ts` that parses all six headers (split/percent-decode `prev-tool-durations`).
2. Make hints available to composite router (`runCompositeAttempts`) and fusion (`runFusion`) for routing decisions (e.g., prefer fast targets for `subagent`, avoid composite for `compaction`).
3. Forward hints upstream — **already done** (routing.ts:354-360, 499-504).

**Status**: ✅ **FIXED** for forwarding — under the scope rule the spec obligation is to *forward* `x-claude-code-*` unchanged, and `routing.ts:354-360` + `499-504` do exactly that on the `anthropic-messages` path. Consuming the hints for routing/attribution is a proxy optimization the guide does not require; optional, not a compliance gap.

---

### 7. System Prompt Attribution Block — Positional Integrity
**Spec**: "Proxy must forward the `system` array exactly as received, keeping the block first and in its own array entry; reordering/prepending/converting-to-string/merging defeats it."

**Current**: audited. The two `system`-touching code paths in `src/utils/request-transform.ts` both leave positional integrity intact:
- `strip_fresh_thinking` (line 331-351) — **misnamed**. It reads `body.thinking` and `body.messages`, never `body.system`; it only does `delete body.thinking` when the conversation has no prior assistant thinking block.
- `ensure_tool_config_cache_ttl` (line 354-373) — **reads** `body.system` only to locate `cache_control` markers (`if (!Array.isArray(body.system)) return;`), and writes to a separate `cache_control_injection_points` field. It does not reorder, merge, stringify, or mutate `system`.

Residual risk — **resolved under the scope rule**: lines 412-437 document `ensure_trailing_user_message` as a workaround for non-Anthropic upstreams that reject a `messages` array not ending on `role:"user"` (the comment at 413-422 explicitly notes "real Anthropic tolerates this, some upstreams don't"). Under the scope rule this transform should be **gated to non-`anthropic-messages` upstreams** — firing it against an Anthropic upstream strips a legitimate trailing `role:"system"` agent-definitions block that Anthropic itself accepts. The transform is opt-in per transform set (the only repo reference is a commented-out `docs/getting-started/proxy_config.example.toml:473`), so today nothing enables it; the gate is a guard against future misconfiguration, not a live bug.

`src/converters/claude-to-openai.ts` flattens `system` to a system-role message by necessity when converting formats; that is inherent to the format conversion and not a violation on `anthropic-messages` (which bypasses conversion entirely — `src/index.ts:2408-2417`).

**Status**: ✅ **COMPLIANT** — no transform reorders, merges, stringifies, or mutates `system`. The one residual (`ensure_trailing_user_message`) is a non-Anthropic-upstream workaround that should be mode-gated; no positional-integrity regression test exists.

**Fix**: Gate `ensure_trailing_user_message` to skip when `upstreamMode === 'anthropic-messages'`. Add a regression test asserting positional integrity (`system[0]` is still the attribution block after all transforms).

---

## MEDIUM (Feature completeness)

### 8. Feature Pass-Through Pairs — Header + Body Must Travel Together
**Spec** (section *Feature pass-through*):
| Feature | Body field | Beta header |
|---------|-----------|-------------|
| Adaptive reasoning | `thinking: {"type":"adaptive"}` | (none) |
| Context management | + `context_management` | (none) |
| Extended context & interleaved thinking | (headers only) | `interleaved-thinking-2025-05-14` |
| Beta tool fields | `tools[].input_schema.strict`, `defer_loading` | `tools-2025-01-15` |
| Effort/structured outputs | `output_config` (`effort`/`format`/`task_budget`) | `output-128k-2025-02-19` |
| Prompt caching | `cache_control` markers | (none) |
| Token counting | `count_tokens` endpoint | (none) |

**Current**:
- `anthropic-beta` validated in `routing.ts:329-337` and `beta-features.ts`
- `interleaved-thinking` detected in `messages.ts:290` and `token-counting.ts:63`
- `output_config.effort` → `reasoning_effort` mapped in `responses.ts` and `messages.ts`
- **Gap**: No explicit check that **both** header and body field travel together for each pair. A converter could drop `cache_control` or `defer_loading` while the beta header still advertises the feature.

**Status**: ⏳ **PENDING** — scoped to `anthropic-messages`. On that path `handleClaudeRequest` (claude.ts:105-117) forwards the body with no format conversion, so body fields survive intact and the pairs travel together by construction; the risk is the `before_upstream` transform hook (`claude.ts:117`), which can mutate the body after the header is already set.

**Fix**: Add a regression test on the `anthropic-messages` path asserting that each beta header's paired body field is unchanged after the full `before_upstream` hook chain.

---

### 9. Disable Flags Semantics
**Spec** (section *Disable pre-release capabilities*):
- `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` — strips experimental betas, keeps stable
- `CLAUDE_CODE_DISABLE_STRUCTURED_OUTPUTS=1` (v2.1.288+)
- `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1`

**Current**: `src/utils/beta-features.ts` validates beta headers but **no env-gated stripping logic** for these three flags.

**Status**: ⏳ **PENDING** — none of the three flags is read anywhere in the repo. Scoped to `anthropic-messages`; for `openai-*`/`gemini-*` upstreams there are no Anthropic betas to strip.

**Fix**: In `validateBetaFeatures()` or a new `applyDisableFlags(betaHeader, env)`, implement the three stripping rules per spec. Gate on `upstreamMode === 'anthropic-messages'` (the `upstreamMode` is already threaded into the `before_upstream` hook context as `hookCtx.upstreamMode`, e.g. `messages.ts:712`).

---

## LOWER (Polish / edge cases)

### 10. `anthropic-version` Header Forwarding
**Spec**: "Forward `anthropic-version` unchanged" (hard-coded `2023-06-01`).

**Current**: forwarded. `src/utils/routing.ts:342-346` (`extractAuthHeaders`) and `489-492` (`transformAuthHeadersForUpstream`) both read `request.headers.get('anthropic-version')` and set `headers['anthropic-version']` unchanged.

**Status**: ✅ **FIXED** — no further work required.

---

### 11. Request Headers: Forward as Open Lists (No Allowlist)
**Spec**: "Forward `anthropic-beta` verbatim; don't allowlist individual values."

**Current**: `routing.ts:333-337` (`extractAuthHeaders`) and `routing.ts:475-483` (`transformAuthHeadersForUpstream`, already gated on `upstreamMode === 'anthropic-messages'`) both validate via `validateBetaFeaturesUtil()` and, on success, **re-serialize as JSON** (`headers['anthropic-beta'] = JSON.stringify(validatedFeatures)`). Only when validation fails does the raw string survive (with `\r\n\0` stripped). The spec explicitly forbids an allowlist.

**Status**: ⏳ **PENDING** — the JSON re-serialization violates the open-list rule on the `anthropic-messages` path. Correctly scoped already: only `transformAuthHeadersForUpstream` gates on `upstreamMode === 'anthropic-messages'`, but `extractAuthHeaders` (routing.ts:329-340) applies the same allowlist-then-JSON-ify unconditionally and feeds every path — so the gate must move into the shared helper.

**Fix**: Forward the raw `anthropic-beta` header **unchanged** (sanitize only `\r\n\0`) when `upstreamMode === 'anthropic-messages'`. Keep `validateBetaFeaturesUtil()` for local feature detection only.

---

### 12. Streaming Contract: `message_delta` + `message_stop` + Stop Reason Preservation
**Spec**: "Relay through `message_delta` + `message_stop`; body ending after a `stop_reason`-carrying `message_delta` with no open block counts as complete; a later usage-only `message_delta` with `stop_reason: null` must not clear the kept `stop_reason`."

**Current**: `src/converters/streaming.ts` (the Claude-emitting converter) emits the terminal pair correctly:
- line 232 — `message_start` initialises `stop_reason: null` (matches spec).
- lines 333-342 — emits `message_delta` with a concrete `stop_reason` + `stop_sequence: null`, then immediately `message_stop`.
- lines 532-539 — same pattern with `stop_reason: hasToolCalls ? "tool_use" : "end_turn"`.

So "emit `message_stop` after final delta" is satisfied on the converted path. The native path (`claude.ts:168-180`) relays upstream events verbatim, so it inherits upstream's contract.

Still **unverified**:
- Whether a later usage-only `message_delta` with `stop_reason: null` would overwrite the kept `stop_reason` — the converter emits exactly one terminal `message_delta`, so this invariant is *structurally* avoided rather than defended.
- Whether `src/converters/streaming.ts` handles "no open block" completion.

**Fix**: Audit and add tests for the three streaming invariants.

**Status**: 🟡 **PARTIAL** — `message_delta` (with a concrete stop reason) followed by `message_stop` is emitted; `stop_reason` preservation against a later `null` is unverified and untested.

---

### 13. Model Discovery Timeout & Redirect Handling
**Spec**: "3 s default timeout, redirect = failure"

**Current**: `src/handlers/models.ts:193-200` uses `createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env))` — **no 3 s cap**, and the `fetch` call specifies **no `redirect`** option (so redirects are followed silently rather than treated as failure). Outbound response headers are only `{'Content-Type': 'application/json', 'x-request-id', 'x-cache': 'MISS'}`.

Separately (CLAUDE.md rule 8 concern): `models.ts:216-218` swallows an upstream fetch failure — `logger.warn(... 'Upstream models fetch failed, returning config-only models')` — and returns a partial list as if it were complete. There is no signal to the client that the list is degraded.

**Status**: ⏳ **PENDING** — mode-independent: the 3 s cap and redirect-failure rules apply to whatever upstream serves the model list, regardless of whether it carries Anthropic headers.

**Fix**: In the new `handleAnthropicModelsDiscovery()` (item 4), use `AbortSignal.timeout(3000)` and `redirect: 'error'` (or manual redirect check). Also surface upstream fetch failure to the client rather than returning a silently-degraded list.

---

## FILES TOUCHED BY THIS ANALYSIS (for surgical changes)

| File | Items | In scope after scoping |
|------|-------|------------------------|
| `src/utils/errors.ts` | 1, 2 | ✅ |
| `src/handlers/claude.ts` | 1, 2, 3, 12 | ✅ |
| `src/handlers/messages.ts` | 1, 2, 3, 12 | partial (body only) |
| `src/handlers/responses.ts` | 2, 3, 12 | partial (body only) |
| `src/converters/streaming.ts` | 12 | ✅ |
| `src/utils/sdk-handler.ts` | 2, 3 | partial (ping only) |
| `src/index.ts` | 1, 3, 4, 6 | ✅ |
| `src/utils/routing.ts` | 2, 5, 6, 10, 11 | ✅ |
| `src/handlers/models.ts` | 4, 13 | ✅ |
| `src/utils/beta-features.ts` | 8, 9, 11 | ✅ |
| `src/converters/claude-to-openai.ts` | 7 | ✅ |
| `src/utils/request-transform.ts` | 7 | ✅ |

Files **not yet audited** for this analysis: `src/handlers/openai.ts`, `src/handlers/gemini.ts`, `src/handlers/composite.ts`, `src/utils/privacy-filter.ts` (streaming restore path).

---

## STATUS SUMMARY

| # | Item | Severity | Status |
|---|------|----------|--------|
| 1 | Error bodies forwarded unmodified | CRITICAL | ⏳ PENDING |
| 2 | Response headers (`retry-after`, `x-should-retry`, ratelimit) | CRITICAL | 🟡 PARTIAL — upstream pass-through ✅, own 429/503 ⏳ |
| 3 | `ping` synthesis | CRITICAL | ⏳ PENDING |
| 4 | `/v1/models` discovery shape + filter + gate | HIGH | ⏳ PENDING |
| 5 | `anthropic-workspace-id` forwarding | HIGH | ✅ FIXED |
| 6 | `x-claude-code-*` gateway hints | HIGH | ✅ FIXED (forwarding is the spec obligation) |
| 7 | System array positional integrity | HIGH | ✅ COMPLIANT (one guard to add) |
| 8 | Feature pass-through pairs | MEDIUM | ⏳ PENDING (test only) |
| 9 | Disable flags | MEDIUM | ⏳ PENDING |
| 10 | `anthropic-version` forwarding | LOWER | ✅ FIXED |
| 11 | Forward headers as open lists | LOWER | ⏳ PENDING |
| 12 | Streaming `message_delta`/`message_stop` | LOWER | 🟡 PARTIAL |
| 13 | Discovery timeout & redirect | LOWER | ⏳ PENDING |

Net after scoping: **6 FIXED/COMPLIANT, 1 PARTIAL-and-mostly-done, 6 PENDING.**

---

## IMPLEMENTATION ORDER (Respecting CLAUDE.md Rules 1, 3, 5)

All items below are scoped to `anthropic-messages` unless noted.

1. **Item 1** — Error body forwarding at handler level (most user-visible breakage; affects the native path too).
2. **Item 2 (residual)** — emit `retry-after` + `x-should-retry` from `createErrorResponse()` for the proxy's own 429/503.
3. **Item 3** — Ping synthesis, incl. a `TransformStream` wrapper on the native pass-through (streaming reliability).
4. **Item 4 + 13** — Model discovery shape/filter/gate plus 3 s timeout and redirect-failure (core Claude Code feature).
5. ~~**Items 5, 6, 10**~~ — DONE
6. **Item 7 (guard)** — gate `ensure_trailing_user_message` to non-Anthropic upstreams; add the positional-integrity regression test.
7. **Items 8, 9, 11** — Beta pass-through test, disable flags, open-list `anthropic-beta` forwarding.
8. **Item 12** — Streaming invariant tests.

---

**Next step**: Per CLAUDE.md rules 1 and 3, implementation requires user approval. Indicate which items to proceed with.

Both previously-open questions are now closed by the scope rule:
- **Item 2 scope** — resolved. Converted paths are out of scope; only the proxy's own 429/503 remain.
- **Item 7 `role:"system"` injection** — resolved. It is config-gated (nothing enables it today) and, per its own comment, is a non-Anthropic-upstream workaround; the fix is to make that gate explicit via `upstreamMode`.

One new decision surfaced by the scoping: **Item 3 (ping synthesis) and Item 1 (error bodies) are body-level, not header-level**, so they remain fully in scope for converted paths. Items whose only remaining work is "don't synthesize Anthropic headers for non-Anthropic upstreams" are now marked out of scope rather than pending.