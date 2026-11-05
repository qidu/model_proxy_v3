# SSD spool design TODO

Plan: `docs/architecture/plan-ssd-spool-image-request-bodies.md`

Status values: `[ ]` pending, `[~]` in progress, `[x]` complete with verification.

Current P2 verification: typecheck clean, build clean, 2,489/2,489 unit tests pass. All P0–P2 items are complete; P3 (measurement and end-to-end evidence) remains.

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
    cannot tell it from an empty upstream). Still unwired, and each a separate increment: the
    `!response.ok` error-body reads repo-wide, and the fusion `readResponseJson` clone in
    `src/index.ts`.
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

- [ ] **Measure the actual memory goals**
  - Capture heap/allocation profiles for slow upload, slow upstream send, downstream JSON, and long/large-event SSE.
  - Include mid-stream request-body reachability and external-buffer accounting.
  - Record before/after memory and p50/p95/p99 latency.
- [ ] **Complete end-to-end test evidence**
  - Full request/response predicate matrix across applicable conversions and SSE variants.
  - Concurrent binary and non-ref traffic with admission enabled and disabled.
  - Real restart, win32, and tmpfs-mount tests.
- [ ] **Align documentation**
  - Fix the README’s response-cap status mismatch: implementation returns **500**, not 503.
  - Record deliberate deviations in the plan.
  - Mark §12 items complete only when their evidence exists.
- [ ] **Keep Phase 3 deferred**
  - Reconsider the lexical scanner only if Phase-2 profiles show full parsing remains the top allocator.
