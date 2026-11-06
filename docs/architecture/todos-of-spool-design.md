# SSD spool design TODO

Plan: `docs/architecture/plan-ssd-spool-image-request-bodies.md`

Status values: `[ ]` pending, `[~]` in progress, `[x]` complete with verification.

Current verification: typecheck clean, build clean, 2,640/2,640 unit tests pass, plus the `tests/perf/parse-transient.ts` Phase-3 gate measurement. All P0–P2 items and the §12 evidence items named below are complete; the open P3 items are the remaining heap/latency profiles, the win32 and tmpfs-mount runs, and the §10 restart bullet is evidenced for the spill half only.

## P0 — Correctness and lifecycle defects

- [x] **Fix spill reservation accounting on write failure** — 38 focused tests pass, including injected request/response/event write failures.
  - Return the current chunk’s reservation when a write fails partway through.
  - Add injected mid-write failure tests for requests, responses, and SSE events.
- [x] **Stop rebuilding spilled requests fully into RAM** — 39 routing/passthrough tests pass; identity egress reads bounded spill chunks during a delayed upstream send.
  - Removed the `spool.readBytes()`-based request reconstruction.
  - Identity passthrough now streams directly from the raw spill.
  - Verified only the initial schema/routing read materializes a spilled body.
- [x] **Complete mid-stream failure cleanup for current paths** — 75 focused tests pass, plus the full suite.
  - Event spill read failures now cancel upstream and clean up.
  - Malformed upstream JSON and unexpected EOF now error instead of emitting terminal success.
  - Missing-blob/disk failures and pre-header cap failures are covered; the planned renewal protocol itself remains in P2 because the implementation currently uses active-ref pinning.

## P1 — Missing production design

- [x] **Implement effective and attempt spools**
  - `src/utils/spool-json.ts` keeps small bodies on the existing string path and writes oversized final JSON to request spills before network I/O.
  - Default/model-route effective bodies, composite candidates, auth-ladder retries, fusion stages, request-ingress rewrites, and converted handler POSTs use the shared disk-backed egress path.
  - Tests prove byte identity, exact lengths, effective-before-attempt lifecycle, two-rung isolation, pre-send rejection cleanup, and ledger/file cleanup; focused routing and attempt tests pass.
- [x] **Extend shape-3 to remaining request conversions**
  - Make remaining converters ref-aware instead of dropping or rehydrating payloads.
  - Cover Responses, Gemini, Interactions, and other supported conversion paths.
  - Run the complete request-predicate round-trip matrix.
  - Done: `tests/unit/request-ref-matrix.test.ts` drives all 26 front-door × upstream-mode
    combinations (plus `/v1/responses/compact` and `/input_tokens`, and the four SSE
    variants §10 names) through the real handlers, running each request both with the
    payloads spilled to real refs and with spooling off, and asserting the two upstream
    bodies are byte-identical. 24 rows are §5.3 shape 3 with an exact `Content-Length` and
    `duplex: 'half'`; the shape is asserted per row rather than inferred.
  - Scope, reported not fixed: `convertGeminiInteractionsToOpenAI` still drops every Gemini
    part on the `anthropic-messages` and `openai-responses` targets (hence those two rows
    are shape 2 — no ref ever reaches the send), and six further rows carry payloads a
    converter discards (Claude `document` blocks, Chat `input_audio`/`file`, Responses
    `input_file` and inline skill on some targets). Each drop is asserted absent from the
    spool-disabled baseline too, so it is pinned as converter-level data loss that the
    spool neither causes nor hides.
  - Note: the converters' ref-awareness predates this change in the working tree; this
    increment is the matrix evidence, and it is the first thing to fail if that
    ref-awareness regresses.
- [x] **Implement converted non-SSE response streaming**
  - Spool and parse large responses.
  - Extract Gemini inline-data and Responses image-generation payloads.
  - Stream transformed JSON skeletons plus blob chunks to clients.
  - Done: `createConvertedResponseBody(value)` in `src/utils/spool-response.ts` takes the
    transformed value and returns either the plain JSON string or the §5.3 skeleton stream
    with an exact `Content-Length`, extracting into a per-response `ResponseBlobStore`;
    `createRefAwareJsonBody` gained a once-per-terminal-path `onDrained` hook (after the
    generator's read handle closes, §5.5) so the egress releases its refs and deletes the
    scratch store. First caller: the Gemini Interactions non-streaming egress in
    `src/handlers/gemini.ts` (`receiveResponseBody` → one `admitMaterialization` lease
    released in `finally` → parse/convert → converted body, `Content-Length` only for a
    stream). 7 tests in `tests/unit/spool-response.test.ts` prove byte identity against the
    pre-extraction serialization, chunked delivery, scratch-file lifetime across
    completion/cancel/deletion, single-file dedupe with two leases, the ineligible-escaped
    and `enabled = false` fallbacks, and an untouched cross-request cache.
  - Scope: the remaining whole-body response readers are not wired — Responses' three
    conversions, plus `messages.ts`/`openai.ts`/`gemini.ts`'s other branches. No converter
    in `src/` constructs a Responses `image_generation_call`, so the identity passthrough
    is where that allowlisted payload arrives today; these egresses are the next §5.7
    items.
  - Update (later increments): the readers this scope named are now wired — the four
    converted `responses.ts` readers and its two identity forwards, the `/v1/messages`
    non-SSE and converted readers, `/v1/chat/completions`' two converted egresses and its
    `openai-responses` passthrough, the three small passthrough handlers, and the
    `after_upstream` transform path (`applyAfterUpstream` now receives through
    `withResponseText`, `tests/unit/transform-response-spool.test.ts`), and all three
    `models.ts` model-listing readers (`tests/unit/models-response-spool.test.ts`, which also
    pins the one degradation left in place: `getModelCount` answers a count of 0 for a cap
    breach — logged at error level, but its caller still answers its usual 404, so the client
    cannot tell it from an empty upstream). Update (later increment): the fusion
    `readResponseJson` clone in `src/index.ts` is wired too — the panel and judge reads receive
    once and consume the body (a `ClaudeProxyError` propagating instead of becoming "no answer"),
    and the synthesis metadata read is one bounded receive whose spill the client streams from
    (`tests/unit/fusion-response-spool.test.ts`). Still unwired, and each a separate increment: the
    `!response.ok` error-body reads repo-wide, and the rest of the `src/index.ts` reads named
    below.
  - Update (later increment): the `!response.ok` family is started — the five error-body reads in
    the auxiliary handlers (`models.ts` ×2, `embeddings.ts`, `decision.ts`, `passthrough.ts`) now
    receive through the same bounded primitive as their success paths, with a cap breach, a spill
    failure or a §5.9 refusal surfacing as itself (rule #8) while `passthrough` keeps its
    `'(failed to read response body)'` placeholder for the `TypeError` an unreadable stream raises.
    Update (next increment): `responses.ts`'s eight `!response.ok` reads are bounded too — the
    converted and passthrough halves of `/v1/responses`, `/input_tokens` and `/compact` reach the
    same terminal `createResponsesErrorResponse` on a cap breach or refusal, the upstream's own
    status/type/message and `.upstreamBody` still reach the client unchanged, and `handleAsGemini`'s
    branch is **unreachable** (its responder throws inside its own `try` and otherwise returns only
    200s), so seven of the eight are pinned and the eighth is noted in the test file.
    Update (next increment): `messages.ts`'s four `!response.ok` reads are bounded too — both client
    formats against both upstream modes, all four ending in `handleTargetApiError` under no catch of
    their own, so the upstream's own status/type/message/`.upstreamBody` reach the client unchanged
    while a cap breach or a §5.9 refusal propagates to `src/index.ts`'s terminal catch as itself.
    Update (next increment): `openai.ts`'s three are bounded too — the two cross-mode forwards
    (`anthropic-messages`, `openai-responses`) and the plain `openai-completions` path, the first
    two reached from `handleOpenAIRequest` *above* its `try` and the third under its debug-and-rethrow
    `catch`, so none of them swallows or relabels; the same terminal catch renders the cap breach and
    the refusal in the Anthropic envelope, and the upstream's own status/type/message/`.upstreamBody`
    still reach the client unchanged.
    Update (next increment): `gemini.ts`'s three are bounded too — `:countTokens` and
    `/v1/interactions` under no catch at all and the native `:generateContent` under a log-and-rethrow
    `catch`, so again nothing is swallowed or relabelled; the same terminal catch renders the cap
    breach and the refusal in the Anthropic envelope, and the upstream's own
    status/type/message/`.upstreamBody` still reach the client unchanged.
    Update (next increment): `claude.ts`'s single one (`:184`, the native `anthropic-messages`
    egress) is bounded too, and its bare `catch {}` is narrowed to a `TypeError` — the placeholder
    for an unreadable body is exactly what a `TypeError` is, so a cap breach, a spill failure or a
    §5.9 refusal now propagates to the terminal catch instead of being reported to the client as the
    upstream's error (the same narrowing as `passthrough.ts:300`).
    Update (next increment): `chat-completions.ts`'s two converted ones (`:128`, `:368`) are bounded
    too — identity consumers, because those branches *return* the upstream error rather than throwing
    it, so the relayed status and bytes are unchanged while a cap breach, a spill failure or a §5.9
    refusal escapes the handler (which has no catch of its own) to the terminal catch as itself.
    Update (next increment): `src/index.ts`'s non-2xx remote-stats error body (the `[remote]
    record_server` zero-usage record for a failed attempt) is bounded too, and it is the one read in
    that family whose body the client still needs: the same receive + parse, but the spill is handed
    back under the response (`new Response(received.readStream(), response)`), so the failure's
    status, headers and bytes reach the client unchanged while a cap breach, a spill failure or a
    §5.9 refusal releases the spill and propagates with **no** record posted for a body the proxy
    refused to read. The retry ladder's two drop points (a re-hit rung, axis 2; a superseded rung,
    axis 1) now cancel the body they abandon, because those statuses (429/5xx) are exactly the ones
    this read spills for and the only other reaper is the startup sweep.
    Still unwired in that family: the rest of `src/index.ts`'s reads (the `request_ingress` clone
    at `:2481`, the spool-disabled stats fallbacks at `:2742`/`:2842`). The fusion
    `readResponseJson` clone is
    wired (see the response-read item above): the panel and judge reads now consume their body, and
    the synthesis metadata read is bounded with its spill streamed to the client.
    Update (next increment): the `restorePrivacyResponse` pair (`:237`/`:253`, now one branch) is
    bounded too — JSON and every other content-type go through one `withResponseText` call, the four
    call sites pass the client's signal, and the SSE branch is untouched. It is the one reader whose
    input is a body the proxy built itself, so it reads back off the spool it just wrote: no RAM
    relief is measurable (the restored string is held either way), the gains are the
    `max_response_bytes` cap and §5.9's charge on that text, and the cost is a *second* spill for a
    PII-active body past `threshold_bytes` — a `max_total_bytes` that fits only the first is now a
    503 `over_limit_error` (`1988 + 1988 bytes > max_total_bytes 2105`) where the old read
    succeeded. That cap cannot be isolated on this path: the converted Claude body is ~50 bytes
    *smaller* than the upstream OpenAI body, so no `max_response_bytes` cuts between the two
    receives; the discriminating test is the `max_total_bytes` one. A streaming restore (the SSE
    branch's `createRestoreTransformStream`, which would avoid the second spill) is left as future
    work.
    Update (next increment): the remote auth server's body in `doAuthRequest` (`src/index.ts:1122`)
    is bounded too — the last unbounded remote-body read in that file. It receives inline rather than
    through `withResponseText`, deliberately: that primitive's trace stage echoes the text it
    receives, and this body can carry `targets[].key`/`otac` (`target-retry.ts`), so it is received
    with no log stage and a test pins that trace prints nothing of it. The fetch and the body read are
    now two `try` blocks, because the shared one answered 503 "could not reach remote auth server" —
    a proxy-side cap breach or §5.9 refusal now rethrows (only `ClaudeProxyError`) and is reported as
    itself (rule #8). The cap is applied ungated (`enabled = false` included, asserted), one more data
    point on increment 43's unresolved convention. `tests/unit/index-auth-response-spool.test.ts`
    (6 tests / 4 suites) drives the real handler; the two cap tests are the discriminating ones
    (reverting to `await authResp.text()` fails exactly those two). Pre-existing and reported, not
    fixed: `:1180` logs a dropped `targets[]` entry with `JSON.stringify(d.entry)`, so a malformed
    entry carrying `key`/`otac` is echoed verbatim at error level.
    Update (next increment): the transform module's *last* unbounded read is bounded too —
    `applyWriteoutBody` (`request-transform.ts:982`, the `response_egress` hook that rewrites the body
    on its way to the client) now receives through `withResponseText` like its mirror
    `applyAfterUpstream`, so `max_response_bytes` bounds it, the parse charges §5.9, the spill is
    released in a `finally`, and the read gets a trace stage. The ops, the malformed-JSON passthrough
    and the rebuilt `Response` are unchanged, and the dead `hookCtx` mirror is dropped. Two
    differences kept, not blended: this hook's gate is `hasHookOps('response_egress', …)` plus a
    content-type check, so a non-JSON body is returned as the same `Response` unread; and its read is
    usually a *second* receive of a body the caller already spooled, so above `threshold_bytes` it
    costs a second spill and buys no RAM relief — the same trade as the `restorePrivacyResponse`
    increment above. `HookContext.signal` now reaches this hook: `writeoutCtx`
    (`src/index.ts:2884`) gains `signal: request.signal`, the client's signal, as the handlers'
    `after_upstream` call sites pass. Ungated cap again, asserted. Reported, not changed: the stage is
    `upstream-response`, so the line reads `[UPSTREAM-RESP] (client egress)`; the repo's `outbound`
    label would fit better, but switching it means a stage parameter on the shared primitive. Nine new
    tests in `tests/unit/transform-response-spool.test.ts` (three suites beside the `after_upstream`
    ones); reverting the receive to `await response.text()` fails exactly the six that pin it. The
    `writeoutCtx` signal is a call site, read rather than driven — as the sibling's handler call sites
    are.
    Update (next increment): the `request_ingress` read in `src/index.ts` is bounded too — the block
    used `attemptRequest.clone().text()` (`:2377`), and a clone *tees* the body, so the branch nobody
    reads stays resident for as long as the read runs: the second full copy of an image-bearing body
    §5.7 rules out. It now receives `attemptRequest.body` through `receiveIngressBody` (`:2497`) and
    releases the spill in a `finally`; consuming the original is safe because the block rebuilds
    `attemptRequest` from the transformed body a few lines down. No declared length is passed (a
    rebuilt request's `Content-Length` describes an earlier body, and §5.1 makes a declared length a
    hint only) and §5.9 is not charged again (the request's ingress lease at `:1263` already covers
    this materialization of the same bytes). Above `threshold_bytes` the read is a *second* spill of a
    body the ingress already spilled, so it trades RAM for disk churn and a tight `max_total_bytes` can
    refuse a request the clone path served — the same honest trade as the two increments above, but
    here it is *measured*: with an image plus a 4000-character text message the ledger's three
    concurrent charges are the ingress receive 9638, the router's ref-bearing rebuild 4313 and the read
    4313, a peak of 18264 against the clone path's 13951, so `1.5x` the raw body sits in the window
    `(13951, 18264)` where the two implementations disagree. Two new tests in
    `tests/unit/request-ingress-transform-refs.test.ts` (block 5, with a `pad` parameter added to
    `openaiUrlBody` — load-bearing, since with an image alone §5.4 extraction leaves the *attempt* body
    a few hundred bytes and below `threshold_bytes`, which is the trap that made the first version of
    this test read 200 where it wanted 503): the refusal case asserts 503 `over_limit_error`,
    `live spill budget exceeded`, zero upstream calls, `getLiveSpillBytes() === 0` and an empty
    `requests/`; the round-trip case runs the padded body byte-identically against a spool-disabled
    baseline and asserts no reservation survives. That the failing charge is this read's, rather than
    the router rebuild's, was settled by measurement: reverting the receive to `clone().text()` and
    re-running at the same budget returns 200. Reported, not fixed: `catch { parsedBody = {} }` turns a
    malformed attempt body into `{}`, which is then re-serialized and sent upstream (pre-existing — the
    clone path swallowed it identically); the `LOG_LEVEL === 'debug'` dump below it (`:2541`) is the
    next `clone()` in the file and clones the *rebuilt* request, so this change does not worsen it.
    Update (next increment): that dump is bounded too, and it was the last `clone()` in the file. It
    ran `attemptRequest.clone().text()` right before dispatch and now receives the attempt body through
    `receiveIngressBody`, handing the request back a stream over the same spill
    (`new Request(attemptRequest, { body: received.readStream(), duplex: 'half' })`, the ingress
    receive's own idiom) — consuming in place is not available, since the dump needs the body and so
    does the send. Same three decisions for the same reasons (no declared length, no second §5.9
    charge, ungated cap) and one deliberate behaviour change: a failed receive consumes the body, so
    the refusal is answered (`logger.warn` + `createErrorResponse`) instead of being swallowed into the
    dump's failure line — a debug-mode request can now return 503/413 where it used to log fine and be
    served (rule #8). Measured window: **without** a `request_ingress` transform the charges before
    the dump are the ingress receive 9638 and the rung's rebuild 4313 (peak 13951, the clone path's
    number) and the dump's read adds another 4313 for a peak of 18264, so `1.5x` sits in
    `(13951, 18264)`; with a transform active the hook's read takes that same third charge and breaches
    first, which is why block 6 installs none (`set: null` on `writeConfig`). Three new tests in
    `tests/unit/request-ingress-transform-refs.test.ts` (byte-identical forward + a `$spoolBlob` ref in
    the log at `2x`; the refusal at `1.5x` with zero upstream calls; the same budget with
    `LOG_LEVEL=error` served and no file written). Power check by measurement, not inference: reverting
    to `attemptRequest.clone()` returns 200 on the refusal case at the same budget. Pinned alongside:
    with spooling on the dump holds the ref, not the base64 — `buildRouteAttempt` serializes the
    ref-bearing body.
    Update (next increment): the last two request-body tees in `src/` are gone — the `sdk://` route in
    `src/handlers/claude.ts` (`:39`) and in `src/handlers/messages.ts` (`:225`) read the body through
    `isSdkUrl(targetUrl) ? await request.clone().json() : await request.json()`, and the clone's stated
    purpose ("preserve body for SDK handler") was never served: every `sdk://` call site in both files
    is handed `requestBody`, the *parsed* object, and `handleSdkAnthropicRequest`/`handleSdkOpenAIRequest`
    in `src/utils/sdk-handler.ts` are stubs that `void request;` and raise 501 `not_implemented`. Both
    routes now take the same plain `await request.json()`, consumed in place — the non-SDK branch of
    that same ternary always did, and `buildRouteAttempt` (`src/index.ts:2093`) rebuilds a fresh
    `Request` per rung, so an exhausted body cannot reach another attempt. The only observable change is
    `request.bodyUsed` becoming true on the `sdk://` route. Property this completes: no request-body tee
    remains in `src/` (every surviving `.clone()` outside the response-side paths is a comment). New
    file `tests/unit/handler-request-body-read.test.ts`, five tests: a `Request.prototype.clone()` count
    of **0** on both files' `sdk://` routes (counted, because the 501 answer is identical before and
    after, so the count is the only discriminator) plus a first test that clones on purpose and asserts
    the count is 1, so the spy cannot pass vacuously; `bodyUsed === true`; the 501
    `not_implemented` `ClaudeProxyError` naming alias and request id; `messages.ts` driven on both
    formats, so both `sdk://` branches are covered; and a malformed body proving the `sdk://` route
    still *parses* (the JSON parse error, not the 501). Mutation check: restoring the clone fails four of
    the five with `expected: 0 / actual: 1`, and a probe confirms reading only a clone leaves the
    original at `bodyUsed: false` — the old route's actual state.
    Update (next increment): the privacy-filter sidecar's answer is bounded too, and it was the last
    request-path read in `src/` whose body grows with the request. `redactSidecar`
    (`src/utils/privacy-filter.ts`) called `resp.json()` on the `/redact` answer, which returns the
    redacted *prompt text* — as large as the request the filter accepted (`max_chars`, 1 024 000 by
    default, i.e. right at `SPOOL_DEFAULTS.thresholdBytes` 1 048 576). It now receives through
    `consumeResponseText`, the no-trace half of `withResponseText`, so `max_response_bytes` caps it, a
    body above `threshold_bytes` spills while the parse runs, and the parse charges §5.9. The
    failure split is the substance: a cap breach, spill failure or §5.9 refusal is the proxy's limit
    and is rethrown as itself, where the old single `catch` wrapped it as `privacy filter unavailable`
    and blamed a healthy sidecar; an unreachable/non-ok/unparseable answer keeps that wrapper, and the
    `fetch` failure was moved out of the receive's `try` so neither kind is mislabelled (rule #8). Every
    path still rejects — the filter is fail-closed, so no route forwards unredacted text. The primitive
    is shared rather than copied a third time: `src/index.ts`'s `doAuthRequest` (whose inline receive was
    the previous increment's no-trace copy) now calls it too, behaviour unchanged, and its existing
    `tests/unit/index-auth-response-spool.test.ts` cases pass. New file
    `tests/unit/privacy-filter-response-spool.test.ts`, seven tests on a chunked, watchable sidecar
    answer: unchanged `redacted[]`/mapping with a spill file observed *mid-receive* (per pull, since the
    spill is released before the call returns) and gone afterwards; `chunks + 1` pulls, i.e. one read
    and no second copy; a cap breach as `SpoolResponseTooLargeError` (`Response body too large:
    exceeded 256 bytes`) with the upstream body cancelled, no spill left, and the message asserted
    *not* to be `privacy filter unavailable`; the same cap with `enabled = false`; a §5.9 refusal as
    `AdmissionOverBudgetError` with the spill ledger, the admitted-bytes ledger and the queue depth all
    back at 0; an admitted read returning its lease before `redactBody` resolves; and an unparseable
    answer still wrapped and still not a `ClaudeProxyError`. Mutation check: `resp.json()` again fails
    four of the seven, deleting the `instanceof ClaudeProxyError` rethrow fails the other three.
    Update (next increment): the kompress sidecar's answer is bounded too — the last unbounded
    request-path read outside `tool-judge-sidecar.ts`. `compressFragment` (`src/utils/kompress.ts`)
    called `resp.json()` on the `/compress` answer, which is the compressed *fragment*, i.e. user
    prompt text, so it receives through `consumeResponseText` (bounded by `max_response_bytes`, spilled
    above `threshold_bytes`, parse charged to §5.9) and, like the two readers above, *without* a trace
    stage. The bigger hole was that this site was silent as well as unbounded: `catch { return null }`
    and the `totalChars > maxChars` early return both forwarded the original text with nothing said,
    the second one exactly on the largest requests. `CompressResult` now carries
    `uncompressed: { reason, count }[]` — `sidecar unreachable: …`, `sidecar returned <status>`,
    `proxy limit on the answer read: …`, `answer read failed: …`, `answer was not JSON`,
    `answer carried no "compressed" string`, `combined text N chars over maxChars M` — and
    `src/index.ts` logs one `warn` per request from the caller that owns `logger`/`requestId`, the
    `judgeTools` convention (a module-level `createLogger` captures `LOG_LEVEL` at import and would be
    invisible to the harness). Reasons never carry fragment text; `JSON.parse` runs in its own `try`
    and reports the fixed phrase, because V8's message quotes the rejected input. Boundary: a fragment
    skipped by design (below `minChars`, CJK-heavy, answer not shorter) is deliberately not tallied, so
    a per-request warn does not bury the real failures. Fail-open is unchanged (the request still
    forwards its own text), and with `failOpen = false` the throw now names the real reason. New file
    `tests/unit/kompress-response-spool.test.ts`, seven tests; `tests/unit/kompress.test.ts` updated for
    the reasons. Mutation check: `resp.text()` again fails five of the thirty-four kompress tests,
    deleting the reason tally and the `maxChars` report fails nine. Full suite 2627/2627.
    Update (next increment): the tool judge sidecar's answers are bounded too, which closes the set —
    nothing on the request path in `src/` reads a body unbounded now. `callJudgeSidecar` (`/judge`) and
    `callDecisionApi` (`/decision`) both did `await resp.text()`, and both did it *inside* the same
    `try` as the parse, so a cap breach, spill failure or §5.9 refusal was reported as
    `Tool judge … error: …`, i.e. as a broken sidecar. One helper, `readJudgeAnswer(response,
    requestId, label)`, now receives through `consumeResponseText` — the no-trace variant, because
    both callers already log the body at their own level — and logs a `ClaudeProxyError` as
    `<label> answer over a proxy limit: …`, anything else as `<label> answer read failed: …`, then
    returns null so the module keeps failing open. New file
    `tests/unit/tool-judge-response-spool.test.ts`, seven tests (healthy answer judged from a body that
    spilled mid-receive with `chunks + 1` pulls; the same through the decision API; breach and §5.9
    refusal both fail open with the body cancelled, nothing on disk, both ledgers 0, `judgedNames`
    empty and `unjudgedNames` complete; cap with `enabled = false`; an answer body that errors
    mid-stream is "no answer"). Mutation check: `resp.text()` again fails five of the seven. **Known
    gap, recorded rather than papered over:** the two message labels are not asserted — the module's
    logger is built at import (`createLogger` snapshots `LOG_LEVEL`) and the harness silences it, so
    deleting the `instanceof ClaudeProxyError` branch fails no test; the suite pins the observable
    contract instead. Full suite 2634/2634.
- [x] **Stream the identity non-SSE response from its spool**
  - Do not buffer a second copy for a log line.
  - Enforce `max_response_bytes` on the forwarded body.
  - Done: the `/v1/responses` passthrough non-SSE branch in `src/handlers/responses.ts`
    used to `await response.text()` for `logPipelineStage` alone (a no-op unless tracing)
    and hand that string back as the client body — a whole extra copy with no response
    cap. It now receives with `receiveResponseBody` and forwards `received.readStream()`;
    the trace re-reads the spool and only when `logger.traceEnabled`; the §5.9 lease
    wraps that one read, is released in `finally` before the client is handed the stream,
    and releases the received body on refusal. 11 tests in
    `tests/unit/responses-response-egress.test.ts` (6 of them fail against the previous
    implementation).
  - Scope: `/v1/responses/compact` already streams the upstream body unread, so it has no
    copy to remove and no materialization to admit — left alone. The whole-body readers
    listed in the item above are still unwired.
  - Update (later increments): the readers this scope named are wired; the same "Update"
    note on the item above lists what remains.
- [x] **Add response/event scratch-blob storage**
  - Keep response blobs separate from the cross-request cache.
  - Delete scratch blobs after final delivery or abort.
  - Test completion, disconnect, disk failure, and handle-close ordering.
  - Done: `src/utils/response-blobs.ts` (per-response store, `put`/`release`/`read`/
    `readChunks`/`dispose`), `RefStorage` seam in `blob-refs.ts` and
    `extractResponseBlobs(body, storage)`, tests in `tests/unit/response-blobs.test.ts`.
    First caller: the SSE event framer (§5.7, below); the non-SSE response egress is the
    separate P1 item above.
- [x] **Complete the SSE binary-event pipeline** — 15 focused tests pass, plus the full suite.
  - Integrate response binary extraction with the existing event framer.
  - Add per-event admission and scratch cleanup.
  - Test large Gemini and Responses events among ordinary events.
  - `src/utils/spool-events.ts` now parses a spilled event, extracts its allowlisted
    payload into a per-event `ResponseBlobStore`, and emits the envelope copied verbatim
    from the event text around the payload's chunks (`spliceEvent`), so the client
    receives the same bytes upstream sent. `ref-serializer.ts` gained a pluggable
    `readChunks` provider so the same skeleton-plus-chunks serializer reads the scratch
    store instead of the cache. One `admitMaterialization` lease per parsed event, released
    after the payloads are on disk; refs, spill and store are released/removed on
    completion, on client disconnect and on a failed parse. A `\r`, two `data:` lines, a
    non-UTF-8 or a non-JSON event is replayed from its spill unread.

## P2 — Contract reconciliation

- [x] **Finish §5.9 admission lifetimes**
  - Release the materialization (RAM) reservation after allowlisted binary payloads become refs, when no later consumer rehydrates them.
    Done earlier: `src/index.ts` releases at the send boundary when `refs > 0 && skipped === 0`; `tests/unit/index-admission.test.ts` proves the release and the combined request+response budget.
  - Keep spill/blob disk ownership separate: release disk state only when its owning body or blob lease ends.
  - Reacquire admission per rung.
    Resolved as a recorded deviation: rungs share one parse, so a non-ref body holds its reservation across all rungs (conservative); per-rung acquisition exists where a rung actually parses (the attempt loop's response-stats read). Plan §5.9 records this.
  - Pause upstream response/event reads while queued.
    New test in `tests/unit/spool-events.test.ts`: a queued event's admission wait pulls nothing further from upstream, and delivery resumes byte-exactly once the budget frees.
  - Cover converted responses and combined request+response budgets.
    Every handler's `*-response-spool.test.ts` suite covers admission refusal/admission on its converted response path; `index-admission.test.ts` covers the combined budget.
- [x] **Resolve the lease-contract deviation**
  - Resolved by revising the plan: §5.5 now records active-ref pinning as the accepted mechanism — the blob hash is the lease identity, the L2 index's `refs` counts shared owners, and renewal is structural (TTL/LRU only look at `refs = 0` entries, so a live exchange's blob can never expire). The leaseId/renewal-ticker protocol is not implemented.
  - Test evidence, all in `tests/unit/blob-store.test.ts`: long-lived — a lease held a simulated hour past `ttl_seconds = 600` is never expired and the idle clock starts only at the final release (`:421`); missing-file — a missing/truncated leased file throws instead of serving a partial payload (`:341`, `:621`); final-release — the last release makes the blob idle-eligible and it then expires normally (`:404`, `:421`); the renewal-failure requirement maps to the mechanism's own loud failures (release with no active lease throws, `:388`).
- [x] **Resolve request-transform behavior**
  - Transforms are ref-safe by position, and that is now proven end to end: extraction runs before any hook, the ref is plain JSON the engine cannot address (payload paths are refused at load — `tests/unit/request-ingress-transform-refs.test.ts`), and every named builtin plus every Tier-1 op kind runs against a ref-bearing body in `tests/unit/transform-ref-matrix.test.ts` with byte-identity against the spool-off baseline.
  - New matrix row closes the last recorded gap: a *converting* Rule-B send (`chat-completions.ts:110`, Chat→Claude) whose `before_upstream` op drops the ref's container degrades to the plain string egress (`streamed: false`, no `Content-Length`/`duplex`), byte-identical to spool-off — previously measured only for the already-OpenAI Messages send.
- [x] **Close remaining auth-link requirements**
  - Prove the auth service fetches and hash-verifies external objects.
    New `tests/unit/index-auth-projection.test.ts` block: a verifying auth-service double walks the projection's `external_blob` links, fetches each from a fake object store, and hash/size-verifies the bytes — the projected link survives exactly that check; a 404ing store makes auth refuse, the client gets 401, and the upstream is never called.
  - Record the final decision on proxy deletion versus store-lifecycle-only cleanup.
    §5.8 now records the 2026-11-04 decision: the proxy issues no `DELETE` to the object store on any path; the store's lifecycle TTL alone bounds every external object. The success-path test asserts the only object-store call is the auth service's GET.
  - Add auth-fetch failure and cleanup integration tests.
    Both new tests run the real handler end to end and assert the lease is held across upload/auth/auth-fetch/send and released at request end on success and failure (no lingering lease, no proxy-side delete).

## P3 — Acceptance evidence and documentation

- [ ] **Measure the actual memory goals** — the four named windows are measured (2026-11-06, `tests/perf/spool-memory.ts`); the profile, concurrency and percentile halves are not.
  - [x] Capture heap/allocation profiles for slow upload, slow upstream send, downstream JSON, and long/large-event SSE.
    `tests/perf/spool-memory.ts` drives the real handler in-process with a scripted `globalThis.fetch`, once with `[spool] enabled = false` and once with `true` and nothing else changed (the toggle isolates the change: `receiveSpooledBody`'s `spillable = config.enabled` and every extraction/admission site gate on it). Live bytes (`heapUsed + arrayBuffers` after a forced collection) at named checkpoints, min–max over eight runs (six with test logs silenced, two not; the configurations differ by up to ~1 MiB because log strings are live): upload-end 10.90–10.95 → 0.17–4.42 MiB (image) and 10.94 → −0.33–3.43 MiB (the non-ref text control, which separates ingress spooling from extraction), request-sent 64.65–64.70 → 10.91–10.93 MiB (against 63.70–64.64 → 52.33–53.30 MiB for the control), request-read 75.40–75.45 → 21.69–32.54 MiB, downstream JSON response-sent 16.29–16.31 → 8.21–10.71 MiB, SSE response-sent 1.15–1.16 → 1.01–1.02 MiB (non-binary events are not spilled per event, so that row is a wash by design). Latency: slow upstream send **+295–335 ms** (§7's disk-I/O trade, visible because the send is the bottleneck); the SSE total improves 1259–1336 → 976–996 ms (20–27 %), which the harness does not isolate.
  - [x] Include mid-stream request-body reachability and external-buffer accounting.
    Reachability is what the checkpoints measure — an unreachable buffer is invisible to them by construction, and the A/A2 pair attributes a changed window to extraction or to the ingress spool rather than to spooling in general. `arrayBuffers` is counted, **but only after a forced collection**: a 1 ms sampler of the same sum counts uncollected garbage (measured: 63.87 MiB live at the send boundary with the spool off, sampler peak 13.90 MiB) and aliases transient spikes, which is how it first reported the spool as 639 % worse.
  - [ ] Record before/after memory and p50/p95/p99 latency.
    Totals are recorded per scenario; percentile latency and full-parse concurrency are not, and `p50/p95/p99` needs a load-driving harness rather than this single-exchange one.
  - Still open for §12's second bullet: the heap-allocation profile against §2's copy inventory (the measured ~6 live body copies off / ~1 on at the send boundary is a partial result), and per-payload-family response bodies (Gemini `inlineData`, Responses generated images), which is where a *binary* SSE event would exercise §5.7's per-event spill.
- [ ] **Complete end-to-end test evidence**
  - Full request/response predicate matrix across applicable conversions and SSE variants.
  - Concurrent binary and non-ref traffic with admission enabled and disabled.
  - Real restart test now in place (§10 "Restart is discard-only", spill half — see the item below); win32 and tmpfs-mount runs remain.
- [x] **Align documentation**
  - README's response-cap status: verified correct — `max_response_bytes` breaches return **500** (`SpoolResponseTooLargeError`), `max_total_bytes` returns **503** (`SpoolCapacityError`), and the README says exactly that (`:832`, `:922`).
  - Record deliberate deviations in the plan: §5.5 active-ref pinning, §5.9 single-parse/across-rung hold plus the two-class waiter rule, §5.8 no-proxy-delete, §9.2 the gate measurement keeping Phase 3 deferred.
  - §12 items checked only where the evidence exists: the §5.9, §5.4/§5.7 predicate, mid-stream failure, §5.8 auth-link and paused-client lines are now checked; the heap-profile and landed-change lines stay open.
- [x] **Keep Phase 3 deferred**
  - Resolved by measurement (`tests/perf/parse-transient.ts`, 2026-11): the full-parse window is ~1.3× body while the end-to-end per-exchange peak is ~5× body — parse is ~25–27% of the peak, not the top allocator. The §9.2 reopen condition is not met; Phase 3 stays deferred, and the script is the rerun harness if the serialize chain ever flattens enough to move parse to the top.
- [x] **Fix the §5.9 hold-and-wait deadlock found by the concurrent-traffic evidence**
  - Concurrent non-ref traffic under a contended budget deadlocked: a non-ref request holds its reservation through the attempt loop, and its response-side admission queued *behind* waiting request bodies — the waiters needed the lease the exchange held, the exchange needed the admission the waiters blocked. Found by the new `tests/unit/index-concurrent-traffic.test.ts`.
  - `src/utils/spool-admission.ts` now has two waiter classes on the one budget: response-side reads (`admitResponseMaterialization`) are admitted and drained ahead of queued request bodies; the hard cap, per-class arrival order, and the timeout/queue refusals are unchanged. All seven response-side callsites (five handlers, `spool-response.ts`, the attempt-loop stats read) use it; the SSE-event parse stays request-class (it runs after the request lease is released, so it queues safely and pauses upstream as designed).
  - Plan §5.9 records the two-class rule; new unit tests pin the liveness ordering, per-class arrival order, the shared queue cap, and the drain priority.
- [x] **Fix the concurrent `putBlob` lease race found by the same burst**
  - Concurrent identical payloads raced `putBlob`'s index check past the write's `await`s: every racer `index.set(refs: 1)` (last write won), and the extra releases threw `refs already 0` in the request `finally`. `putBlob` now gates one in-flight write per hash; racers chain onto it and take the ordinary refs+=1 hit. Regression test: `index-concurrent-traffic.test.ts` dedupes eight concurrent identical requests to one stored blob with every lease returned.
- [x] **Close the §5.7 response/event predicate evidence**
  - `responses-image-generation-result` in a completed JSON body: new `createConvertedResponseBody` round-trip/cleanup test in `spool-response.test.ts` (the only completed-JSON extraction point for that predicate today).
  - The Interactions converted egress (the one handler that calls `createConvertedResponseBody`) now has handler-level tests: extracted image streamed back with exact `Content-Length`, receive spill released before the answer, scratch blob deleted on completion and on client disconnect (`gemini-response-spool.test.ts`).
- [x] **Close the mid-stream failure evidence (§12)**
  - New spool-events test: a scratch blob *deleted* (not just truncated) between the envelope and its chunks errors the stream, emits no `[DONE]`, cancels upstream, and leaves nothing on disk. Together with the existing truncate/disk/parse/log/cleanup coverage this completes the §12 line's failure matrix.
- [x] **Close the paused-client backpressure evidence (§12)**
  - "Paused-client tests prove bounded response queues and upstream read backpressure across … the Node adapter." `tests/unit/server.test.ts` gains a `createNodeRequestHandler — a paused client` block that pins read counts, not mechanisms: a `Writable` that never accepts a byte (deterministic, measured 3 of 1024 chunks for a 64 MiB body); a real `res.pause()` client (15 chunks read, 192 KiB of 960 KiB delivered, `cancelled === false`, then all bytes and exactly `chunks + 1` reads after `resume()`); the same through the SSE branch with a keep-alive-wrapped body (22 chunks, then byte-exact); and a `receiveResponseBody`-spooled response, where the stalled client's unread copy is 16 MiB accounted as a live spill with one full-size file in `responses/`, released and removed once read.
  - Mutations: buffering the non-SSE branch fails three of the four; buffering the SSE branch fails the SSE test and *hangs* the pre-existing disconnect test (an un-cancelled upstream body never settles); forcing `threshold_bytes` to infinity fails the spooled test.
  - Limit recorded: a pull count bounds the queues the proxy builds, not resident bytes. The heap/allocation half of §12 stays open under "Measure the actual memory goals".
- [x] **Close the restart-is-discard-only evidence (§10, §5.4/§5.5)**
  - "Seed request/response/event spills and blobs from a previous process, then restart. … An orphan older than the age threshold is removed; a freshly written file belonging to a concurrently active worker is not removed." The blob half already existed; the **spill** half did not: `sweepStaleSpills(startupSpool)` (`src/utils/config-loader.ts:3278`) had no test, and removing the call from the real startup path passed all 227 tests in `config-loader.test.ts`.
  - `tests/unit/config-loader.test.ts` `[spool] startup resolution` gains two cases through the real `loadProxyConfig`. (1) A stale (2 h) and a fresh spill seeded in each of `requests/`, `responses/`, `events/`: startup deletes all three stale files, keeps the three recent ones byte-identical, and `getLiveSpillBytes()` stays 0. (2) `enabled = false` with a `dir` holding a stale spill: the dir still resolves, nothing is created or swept (§9.1 — a disabled spool owns no spills).
  - Mutations: an empty sweep result instead of `sweepStaleSpills(startupSpool)` fails (1) and nothing else; `minAgeMs = 0` fails (1) on the kept-recent assertion; moving the sweep above the `enabled` gate fails (2).
  - Already covered: L2 index empty and never rebuilt from disk (`config-loader.test.ts` blob-sweep case, `blob-store.test.ts` `sweepStaleBlobs`), no cache hit from an old file (`blob-store.test.ts` "does not resurrect a fresh-process blob from a stale file").
  - Limit recorded: "no old body/event is parsed or forwarded, no exchange is resumed" is evidenced by the absence of any code path that enumerates a spill directory (the sweep is the only one) plus the empty ledger — there is no replay path to exercise. The same §10 bullet's win32 and tmpfs-mount halves are not runnable here.
