# Changelog

Historical changes to `model_proxy_v3`. For current usage documentation, see
[README.md](./README.md).

## Latest Changes

### perf(spool): §12's before/after numbers for the four named windows — and the instrument that has to be used to get them

Plan §12's line ("Combined Phases 0–2 change landed, with before/after memory and latency numbers for
slow upload, upstream request send, downstream JSON response, and long/large-event SSE response") now
has a runnable harness: **`tests/perf/spool-memory.ts`**, deliberately outside `npm run test:unit`
because it produces measurements, not assertions. It drives the real handler in-process with
`globalThis.fetch` stubbed by a scripted upstream, once with `[spool] enabled = false` and once with
`true` and everything else identical, and prints the same named windows for both. **"Before" is that
toggle, not an older checkout:** `receiveSpooledBody`'s `const spillable = config.enabled` and every
extraction/admission site gate on it, so off-vs-on isolates this change without a second tree.

**The instrument, because the obvious one lies.** `live()` = `process.memoryUsage()`'s
`heapUsed + arrayBuffers` **after a forced collection**, read at named checkpoints (`upload-end`,
`request-sent`, `request-read`, `response-sent`, `response-drained`) — not sampled. A 1 ms sampler was
written first and is wrong twice over: `arrayBuffers` counts a backing store until a collection
reclaims it, so the harness's own per-pull encoder output read as if the proxy held it (~12 MiB of
floor in *both* modes), and a real spike is aliased away. Measured: with the spool **off**, 63.87 MiB
was live at the send boundary while the sampler never saw more than 13.90 MiB; with it **on**, the
slower send kept the same spike visible (sampler peak 64.81 MiB) — so the sampler reported the spool as
639 % *worse* than the code it improves. What checkpoints cannot see: transients *between* readings
(§7 predicts no change there). Each checkpoint forces a collection, so a window's wall clock includes
it, symmetrically in both modes; the upload window, which contains none, is the clean latency figure.

Scenarios, all 200 and all releasing their spills (`getLiveSpillBytes() === 0` asserted per run): **A**
8 MiB inline image, client dribbling at 16 MiB/s; **A2** the same bytes as non-allowlisted text — the
control that separates ingress spooling from extraction; **B** the image with an instantaneous upload
and an upstream reading at 8 MiB/s; **C** an 8 MiB JSON completion, client at 64 MiB/s; **D** 100 ×
256 KiB SSE events, client at 64 MiB/s. Spool `threshold_bytes = 65536` and `max_blob_cache_bytes =
65536`, so a cache hit cannot mask extraction. Ranges are the min–max over eight runs, six of them with
the documented command and two with test logs silenced — the two configurations differ by up to ~1 MiB
(log strings are live), so a range is the honest unit here, not a mean; each run measures both modes in
one configuration, so the on/off ratios are unaffected. One throwaway exchange per mode precedes the
loop: the first measured run without it inflated A's upload window by ~2.2 MiB of lazily initialized
request-path code that is *live*.

| Scenario | Window | spool off | spool on | on/off | exchange, off → on |
|---|---|---|---|---|---|
| A image, slow upload | upload-end | 10.90–10.95 MiB | 0.17–4.42 MiB | 2–41 % | 869–890 → 869–876 ms |
| A | request-sent | 64.65–64.70 MiB | 10.91–10.93 MiB | 17 % | |
| A | request-read | 75.40–75.45 MiB | 21.69–32.54 MiB | 29–43 % | |
| A2 same bytes, non-ref text | upload-end | 10.94 MiB | −0.33–3.43 MiB | ~0–31 % | 910–937 → 911–944 ms |
| A2 | request-sent | 63.70–64.64 MiB | 52.33–53.30 MiB | 81–84 % | |
| A2 | request-read | 74.44–75.38 MiB | 63.07–64.04 MiB | 84–86 % | |
| B image, slow upstream send | upload-end | 10.79 MiB | −0.31–0.21 MiB | ~0–2 % | 1417–1428 → 1723–1750 ms |
| B | request-sent | 64.48–64.49 MiB | 10.30–10.81 MiB | 16–17 % | |
| B | request-read | 64.48–64.49 MiB | 11.04–15.75 MiB | 17–24 % | |
| C 8 MiB JSON response | response-sent | 16.29–16.31 MiB | 8.21–10.71 MiB | 50–66 % | 535–560 → 544–565 ms |
| D 100 × 256 KiB SSE | response-sent | 1.15–1.16 MiB | 1.01–1.02 MiB | 87–89 % | 1259–1336 → 976–996 ms |

Every `response-drained` row is at the noise floor (`NOISE = 1 MiB`, printed `~0`) except C's
0.47 → 1.17 MiB, inside that band; a window can print slightly negative because the post-baseline
collections also release code that was live when the baseline was taken. What the numbers say:

- **Slow upload: O(N×B) → O(N×C) outside parse, as §7 predicts.** The 10.90–10.95 MiB held at the
  last chunk becomes 0.17–4.42 MiB; the residual is in-flight stream/queue state, not spill
  accounting, and the ledger is 0 at the end. The A/A2 pair attributes the rest: at the send
  boundary the *non-ref* text control only reaches 52.33–53.30 MiB (one body copy saved), while the
  image reaches 10.91–10.93 MiB — the difference is §5.4 extraction, not the ingress spool.
- **Upstream request send: O(N×B) → O(N×C) for shape 3.** Both A and B land at ~10.3–10.9 MiB with the
  spool on against 64.5–64.7 MiB off (~6 live copies of the body off, ~1 with it on), which
  corroborates §2's copy inventory at the boundary where it is largest.
- **Downstream JSON: 16.29–16.31 → 8.21–10.71 MiB (50–66 %),** a partial win only — this path still
  materializes the whole body to convert it, exactly as §7's "outside full parse/serialization"
  caveat says.
- **Long SSE: 1.15–1.16 → 1.01–1.02 MiB (87–89 %), a wash.** These events are non-binary, and §5.7
  spills binary payloads only, so the row is expected to be flat; it is reported as flat rather than
  generalized.
- **Latency, the honest cost:** B is **+295–335 ms** — §7's disk-I/O trade, visible because the send is
  the bottleneck. D is **−265 to −360 ms (20–27 % faster)**, which this harness does *not* isolate (it
  is consistent with §5.7's tee removal and real backpressure, not with spooling); A, A2 and C are
  within run noise.

Gates, so a bad run fails instead of printing a happy table: a non-200, an empty response body, live
spill bytes left after the exchange, a window reached in one mode only, or an upload window that did
not shrink. A later window growing by ≥ 1 MiB prints a `worse:` line and exits non-zero — the plan
buys bounded streaming outside the parse, not a smaller full-parse peak (§7). **Not measured here:**
per-payload-family response bodies (Gemini `inlineData`, Responses generated images), full-parse
concurrency, p50/p95/p99 latency, and §7's heap-allocation profile against §2's copy inventory — §12's
second bullet and the rest of the third stay open.

**This increment produces evidence, not unit tests: no `src/` file changed and no test was added.**
Verified: harness exits 0 with every scenario at 200, eight runs stable in direction (the ranges above
are the min–max across them, spanning the two log configurations);
`npm run typecheck`, `npm run build`, `npm run test:unit` unchanged at 2640/2640.

### test(spool): §10/§5.5 — a restart sweeps the spill directories and adopts nothing from them

The plan's restart evidence ask the question this suite could not answer: seed spills from a previous
process, restart, and prove the restart only discards. The blob half was already pinned (`config-loader.test.ts`'s
blob-sweep case, `blob-store.test.ts`'s "does not resurrect a fresh-process blob from a stale file"); the
**spill** half was not — `sweepStaleSpills(startupSpool)` at `src/utils/config-loader.ts:3278` was wired
with no test behind it, and deleting the call left the file's 227 tests all green. Two cases in
`tests/unit/config-loader.test.ts`'s `[spool] startup resolution` now run the real `loadProxyConfig` path:

- **The sweep reaches every spill kind, and only the old files.** A stale (2 h) and a fresh spill are
  seeded in *each* of `requests/`, `responses/` and `events/`; startup deletes the three stale ones,
  keeps the three recent ones byte-identical (a worker starting alongside this one may still be filling
  them), and `getLiveSpillBytes()` is 0 — the restart holds nothing it found on disk, which is the
  observable form of "no old body/event is parsed or forwarded, no exchange is resumed" given that no
  code path enumerates a spill directory at all.
- **A disabled spool neither creates nor sweeps** (§9.1). With `enabled = false` and a `dir` holding a
  stale spill, the dir still resolves but nothing is created or deleted: a disabled spool produces no
  spills of its own, so files under that path belong to some other run.

Mutations: returning an empty sweep result (the call effectively off) fails the first case — and today
would fail nothing else; `sweepStaleSpills(startupSpool, 0)` fails it on the kept-recent assertion; moving
the sweep above the `enabled` gate fails the second. Verified: 229/229 in `config-loader.test.ts`, full
suite **2640/2640** (536 suites), typecheck and build clean. No production change.

**Stated limit:** what these tests prove about "no old body/event is parsed or forwarded" is the absence
of an adoption path plus an empty ledger, not the behaviour of a replay path — there is no replay path to
exercise, by design. The win32 and tmpfs-mount halves of the same plan bullet remain unrun here.

### feat(spool): §5.7 — the tool judge sidecar's answer is read bounded (the last unbounded request-path read in `src/`)

`callJudgeSidecar` (`/judge`) and `callDecisionApi` (`/decision`) in
`src/utils/tool-judge-sidecar.ts` both read their answer with `await resp.text()`. That was the last
unbounded request-path body read in `src/`, and it is not a small body: the answer is derived from the
tool descriptions and the user's prompt, so it grows with what the client sent. Both now go through one
helper, `readJudgeAnswer`, which receives with `consumeResponseText` — `max_response_bytes` caps the
answer, a spill holds it above `threshold_bytes`, and the `JSON.parse` that follows is the
materialization §5.9 charges. The no-trace variant is deliberate: both callers already log the body at
their own level, so a second `upstream-response` echo would only widen the exposure.

The failure split is the other half. The read sat inside the same `try` as the parse, so a cap breach,
a spill failure or a §5.9 refusal came out as `Tool judge … error: …` — indistinguishable from a broken
sidecar, sending a health check after a healthy one. A `ClaudeProxyError` from the receive is now logged
as `<label> answer over a proxy limit: …` and everything else as `<label> answer read failed: …`. Both
still fail open, as this module documents: the answer is discarded, `judgeTools` accounts every tool as
unjudged, and no tool is erased from a read that could not finish.

Verified: `tests/unit/tool-judge-response-spool.test.ts`, seven tests. A healthy answer still judges
identically from a body that lived on disk mid-receive and was pulled exactly `chunks + 1` times; the
decision API reads the same way; a cap breach and a §5.9 refusal both fail open with the answer body
cancelled on a breach, nothing left on disk, both ledgers back at 0, `judgedNames` empty and
`unjudgedNames` complete; the cap applies with `enabled = false`; and an answer body that errors
mid-stream is still "no answer" rather than a partial one. Mutation check: reverting the helper to
`resp.text()` fails five of the seven.

**Stated weakness:** the log line that separates a proxy limit from a sidecar fault is not pinned by an
assertion. This module builds its logger at import time (`createLogger` snapshots `LOG_LEVEL` then) and
`tests/setup/silent-logs.ts` silences it before any import, so the message cannot be observed from a
unit test; what the suite pins is the observable contract — a failed read never yields a partial or an
erased answer. Removing the `instanceof ClaudeProxyError` branch fails no test.

Full suite 2634/2634 (535 suites), typecheck and build clean. `terminal-notifier` is not on `PATH` in
this environment, so rule #9's notification cannot be sent for this increment.

### test(spool): §12 — a paused client bounds the upstream read, measured at the Node adapter

Plan §12 asks for "paused-client tests [that] prove bounded response queues and upstream read
backpressure across logging, keep-alive, converters, and the Node adapter". The implementation was
already in place (§5.7's `pipeline()` in `src/server.ts`, the pull-driven `wrapSseStreamWithKeepAlive`,
the one-event-per-pull ref serializer, the bounded response receive); nothing measured it. Four tests in
`tests/unit/server.test.ts` now do, and each pins a count rather than a mechanism:

- **A destination that accepts nothing** — a `Writable` whose `_write` never calls back, driven straight
  through `createNodeRequestHandler`: of 1024 offered 64 KiB chunks (64 MiB) the upstream is asked for
  **3** on macOS. The old shape, which wrote into a PassThrough and ignored the `false` it returned,
  reads all 1024.
- **A real stalled socket** — `http.request`, then `res.pause()`, against a 64 MiB body: **15** chunks
  read, 192 KiB of 960 KiB at the client, `cancelled === false` (a pause, not a teardown). After
  `resume()` every byte arrives byte-identical, from exactly 1025 reads — one per chunk plus the read
  that ends the stream.
- **The SSE path** — the same body behind `wrapSseStreamWithKeepAlive` at a 60 s ping interval: **22**
  chunks while stalled, then the same byte-exact delivery and 1025 total. Mutating the SSE branch back to
  `await response.arrayBuffer()` reads **1025 of 1024** at the stall point: the whole body buffered
  before the client saw a byte.
- **A spooled response** — the parse/logging shape (`receiveResponseBody` then a `Response` around the
  spill's `readStream()`): the bounded receive reads the body once (257 reads for 256 chunks) and then
  the stalled client's unread copy sits **on disk** — 16 MiB accounted as a live spill, one file in
  `responses/` at the full size — until the client reads it, after which both the reservation and the
  file are gone.

Two measurements worth keeping: the adapter reads only ~1 MiB ahead of a stalled client (the
`Readable.fromWeb` buffers plus a 192 KiB loopback socket window), and a body must exceed the socket
buffers for a stall to exist at all — a 512 KiB response was fully absorbed before the first assertion,
which is why the spool test uses 16 MiB rather than "bigger than the threshold".

Verified: full suite 2638/2638 (536 suites), typecheck and build clean. Mutation checks: buffering the
non-SSE branch fails three of the four (the sink, the socket, and the spooled response — the last because
the whole spill is read into RAM before the client is answered); buffering the SSE branch fails the SSE
test only, and hangs the pre-existing client-disconnect test, since an un-cancelled upstream body means
the handler never settles; forcing `threshold_bytes` to infinity fails the spooled test with `0 !==
16777216`. **Stated limit:** these bound the queues the proxy builds, not resident bytes — a chunk count
is not a heap high-water mark. That half of §12 (the heap/allocation profile) stays open.
`terminal-notifier` is not on `PATH` in this environment, so rule #9's notification cannot be sent.

### fix(fusion): clear the panel-timeout timer when the panel answers in time

Every fusion panel attempt raced `runAttempt` against a `setTimeout(panel_timeout_ms)` that was
never cleared when the attempt won, so each panel call left a ref'd 60-second timer behind. In a
running proxy that is one stale timer per panel call per fusion request, piling up for a minute
each; in tests it held each fusion test process open for 60 s after the suite's real work
(~0.2 s) was done. The timer is now cleared in `finally` whichever way the race settles.

Verified: `fusion-response-spool.test.ts` process exits in 0.23 s (was 60 s); full suite
2,627/2,627, typecheck clean.

### feat(spool): §5.7 — the kompress sidecar's answer is read bounded, and its silent fail-open now says why

`compressFragment` (`src/utils/kompress.ts`) read the sidecar's `/compress` answer with `resp.json()` —
the last unbounded request-path read outside `tool-judge-sidecar.ts`. The answer is the compressed
fragment, derived from the request's prompt text and bounded by the sidecar's own `max_length`, so it
now goes through `consumeResponseText`: `max_response_bytes` caps it, a spill above `threshold_bytes`
holds the bytes, and the `JSON.parse` is the materialization §5.9 charges. The no-trace-stage variant is
deliberate — this text is user content and must not be echoed into an `upstream-response` line.

The larger hole was that the read *and* the failure were both silent. `catch { return null }` forwarded
the fragment uncompressed with nothing said, and `totalChars > maxChars` skipped a whole batch the same
way — a no-op hitting exactly the largest requests, where compression matters most. Fail-open is not
fail-silent: `CompressResult` now carries `uncompressed: { reason, count }[]`, and each entry names what
happened — `sidecar unreachable: …`, `sidecar returned 500`, `proxy limit on the answer read: …`,
`answer read failed: …`, `answer was not JSON`, `answer carried no "compressed" string`, `combined text
N chars over maxChars M` — never any fragment text. `src/index.ts` logs one `warn` per request when the
tally is non-empty, the same call-site-owns-the-logger convention `judgeTools` uses (a module-level
`createLogger` here would capture `LOG_LEVEL` at import and be invisible to the harness). A proxy limit
is separated from a broken sidecar so the two can be told apart, and with `failOpen = false` the throw
now carries the real reason instead of the blanket `kompress sidecar unavailable`.

A deliberate boundary: a fragment skipped *by design* — shorter than `minChars`, CJK-heavy, or an answer
that did not shorten — is not tallied, because a per-request warn on those would bury the real failures.
`JSON.parse` runs in its own `try` and reports the fixed phrase `answer was not JSON`, because V8's
parse message quotes the rejected input, i.e. would leak prompt text into the log.

Verified: `tests/unit/kompress-response-spool.test.ts`, seven tests on a chunked sidecar answer that can
be watched being pulled and cancelled — a healthy answer compresses byte-identically with one spill file
present mid-receive (`chunks + 1` pulls, one read), the cap rejects fail-open with exactly the reason
`proxy limit on the answer read: Response body too large: exceeded 256 bytes` and the upstream cancelled,
that same reason is what `failOpen = false` throws, the cap still applies with `enabled = false`, a §5.9
refusal names `max_materialized_body_bytes` with all three ledgers back at 0, failures are tallied per
reason in work order, the `maxChars` limit is reported with no sidecar call made, and a malformed answer
carrying `TOP-SECRET-PROMPT-TEXT` reports `answer was not JSON` — the marker appears in no reason.
Mutation check: reverting the receive to `resp.text()` fails five of the thirty-four kompress tests;
deleting the reason tally and the `maxChars` report fails nine.

Full suite 2627/2627 (531 suites), typecheck and build clean. `terminal-notifier` is not on `PATH` in
this environment, so rule #9's notification cannot be sent for this increment.

### feat(spool): §5.7 — the privacy-filter sidecar's answer is read bounded (and one receive primitive replaces two copies)

`redactSidecar` (`src/utils/privacy-filter.ts`) read the sidecar's `/redact` answer with `resp.json()`,
which buffers whatever the sidecar sends. That body is not incidental: it carries the redacted *prompt
text* back, so it is as large as the request the filter accepted — bounded by `max_chars`, 1 024 000 by
default — and near that cap it is larger than `SPOOL_DEFAULTS.thresholdBytes` (1 048 576). It is the
last request-path read in `src/` whose body grows with the request. It now goes through the §5.7
receive: `max_response_bytes` caps it, the bytes live on a spill above `threshold_bytes`, and the
`JSON.parse` that follows is the materialization §5.9 accounts for.

Two failure kinds are now separated, which is the point of the change rather than a side effect. A cap
breach, a spill failure or a §5.9 refusal is the proxy's own limit and is rethrown as itself
(`SpoolResponseTooLargeError` 500 `processing_error`, `SpoolCapacityError`,
`AdmissionOverBudgetError`/`AdmissionTimeoutError`/`AdmissionQueueFullError` 503 `over_limit_error`),
where the old single `catch` wrapped everything as `privacy filter unavailable: …` and blamed a healthy
sidecar. An ordinary fault — unreachable, non-ok status, unparseable or wrongly shaped answer — keeps
that wrapper, and the `fetch` failure was split out of the receive's own `try` so each kind is only ever
reported as what it is (rule #8). The filter stays fail-closed on every path: a rejection is still a
rejection, so no route forwards unredacted text.

The receive needed a primitive that does not log. `withResponseText` emits an `upstream-response` trace
stage with the whole text, and this body is the user's own prompt text — the same reason `doAuthRequest`
inlined the receive in the previous increment. Rather than a third copy of that idiom, the inline
receive is now `consumeResponseText` in `src/utils/spool-response.ts` — receive, admit, read, release,
rethrow — and `withResponseText` is that plus its trace stage, so the two primitives cannot drift.
`doAuthRequest` (`src/index.ts`) switches to it and drops its copy; its behaviour, including
`if (err instanceof ClaudeProxyError) throw err`, is unchanged and its existing
`tests/unit/index-auth-response-spool.test.ts` cases still pass.

Verified: `tests/unit/privacy-filter-response-spool.test.ts`, seven tests on a chunked sidecar answer
that can be watched being pulled and cancelled. A healthy answer still applies the same `redacted[]`
and the same mapping, one spill file exists *mid-receive* (captured per pull, because the spill is
released before `redactBody` returns) and is gone afterwards, and the body is pulled exactly
`chunks + 1` times — one read, no second copy. A body past `max_response_bytes` rejects with
`SpoolResponseTooLargeError`, message `Response body too large: exceeded 256 bytes`, and **not** with
`privacy filter unavailable`; the upstream body is cancelled; nothing is left on disk. The same cap is
asserted with `enabled = false`, since `max_response_bytes` bounds the body and `enabled` only decides
whether disk is used. A §5.9 refusal (`max_materialized_body_bytes: 64`) rejects with
`AdmissionOverBudgetError` naming `max_materialized_body_bytes`, with `getLiveSpillBytes()`,
`getAdmittedBytes()` and the queue depth all back at 0 — a refused read holds nothing — and an admitted
read gives its lease back before `redactBody` returns. The last test pins the surviving wrapper: an
unparseable answer is still `privacy filter unavailable` and still not a `ClaudeProxyError`, so the
split did not swallow the ordinary failure. Mutation check: replacing the receive with `resp.json()`
again fails four of the seven; deleting the `instanceof ClaudeProxyError` rethrow fails the other three.

Full suite 2618/2618 (527 suites), typecheck and build clean. `terminal-notifier` is not on `PATH` in
this environment, so rule #9's notification cannot be sent for this increment.

### feat(spool): §5.7 — the last two request-body tees in `src/` are gone (the `sdk://` routes)

`src/handlers/claude.ts:39` and `src/handlers/messages.ts:225` read their request body through a
conditional that cloned it on the `sdk://` route only:

```ts
const requestBody = isSdkUrl(targetUrl)
  ? await request.clone().json() as Record<string, unknown>
  : await request.json() as Record<string, unknown>;
```

The clone's stated purpose was "preserve body for SDK handler", and a clone *tees* the body: the branch
nobody reads stays resident for as long as the parse runs — here a second full copy of a request that
may carry an image, which is the shape §5.7 exists to remove. Nothing read the preserved branch. Every
`sdk://` call site in both files (`claude.ts:113`, `messages.ts:337`, `messages.ts:575`) is handed
`requestBody`, the *parsed object*, and the handlers behind them — `handleSdkAnthropicRequest` and
`handleSdkOpenAIRequest` in `src/utils/sdk-handler.ts` — are explicit stubs that `void request;` and
raise 501 `not_implemented`. Both routes now take the same one plain `await request.json()`.

Consuming in place is safe here for the reason the previous two increments established: the non-SDK
branch of this same ternary already consumed the body at this exact line, so "the handler's first act
reads the body" was already the invariant on the path that serves real traffic. The failover ladder is
unaffected — `buildRouteAttempt` (`src/index.ts:2093`) builds a **fresh** `Request` for every rung from
`JSON.stringify({ ...bodyObj, model })`, so an exhausted body cannot survive into another attempt, and
`sdk-handler.test.ts` already pins that the 501 is retryable so the ladder moves on. The only observable
difference on the `sdk://` route is `request.bodyUsed` becoming true — the old code left it false
because the clone, not the original, was the branch that got read.

**Property this completes:** no request-body tee remains anywhere in `src/`. Every remaining `.clone()`
outside the response-side spool paths is now inside a comment; the last three to go were the
`request_ingress` read, the `LOG_LEVEL=debug` dump, and these two.

Verified: `tests/unit/handler-request-body-read.test.ts`, five tests, each pinning a property that
survives a broken instrument only on purpose. `Request.prototype.clone()` is counted (the
`countClones` idiom from the response-side suites, pointed at `Request`) and asserted **0** on both
files' `sdk://` routes — counted rather than asserted-absent because the handler's answer, a 501, is
identical before and after, so the count is the only thing that distinguishes the two versions; a
first test clones a request on purpose and asserts the count is 1, so the spy cannot pass vacuously.
`request.bodyUsed` is asserted true, and the rejection is asserted to be the 501 `not_implemented`
`ClaudeProxyError` naming both the model alias and the request id. `messages.ts` is driven on both
formats (already-OpenAI reaches the OpenAI stub directly; native Claude reaches the Anthropic stub
through validation and conversion), so both `sdk://` branches are covered. The fifth test proves the
body is still *parsed* on the `sdk://` route: a malformed body fails with the JSON parse error, not with
`not_implemented`, which is the behaviour a future "skip the parse when the target is an SDK"
short-circuit would silently remove. Mutation check: restoring the `request.clone()` conditional in both
files fails four of the five tests with `expected: 0 / actual: 1`, and a separate probe confirms the
fourth property is not redundant — reading only a clone leaves the original at `bodyUsed: false`, which
is what the old route did.

Full suite 2611/2611 (523 suites), typecheck and build clean. `terminal-notifier` is not on `PATH` in
this environment, so rule #9's notification cannot be sent for this increment.

### feat(spool): §5.1/§5.7 — the `LOG_LEVEL=debug` dump reads the attempt body without a clone

The last `attemptRequest.clone()` in `src/index.ts` was the debug dump (`:2541`): gated on
`path === '/v1/messages' && env.LOG_LEVEL === 'debug'`, it cloned the attempt request, awaited the
clone's text, and wrote `tmpdir()/test_model.log`. The clone *tees* the body, so the branch the dump
never reads stays resident while the read runs — and this one runs immediately before dispatch, so the
copy is of exactly the body the handler is about to send. It now receives `attemptRequest.body` through
`receiveIngressBody` and hands the request back a stream over the same spill
(`new Request(attemptRequest, { body: received.readStream(), duplex: 'half' })`), the idiom the ingress
receive already uses at `:1265`. Consuming in place is not available here — the dump needs the body
*and* so does the send — so re-wrapping is what keeps the change a substitution rather than a drop.

The three deliberate decisions mirror the previous increment, for the same reasons:

- **No declared length.** The attempt request has been re-serialized at least once by the ladder, so
  its `Content-Length` describes an earlier body; §5.1 makes a declared length a hint, and a hint that
  is wrong would spill on the wrong decision.
- **No second §5.9 charge.** This materialization is of bytes the request's own ingress lease already
  covers.
- **The cap is ungated** by `[spool] enabled`, since `receiveSpooledBody` tests `total > maxBytes`
  before consulting `spillable` — one more data point on the conflict increment 43 exposed.

One behaviour change, deliberate and loud: a failed receive **consumes** the body, so the dump can no
longer forward the request. Instead of swallowing the failure into the log line, the block now answers
`logger.warn` plus `createErrorResponse(error, requestId)` — a debug-mode request can return 503
`over_limit_error` (or 413) where it previously logged fine and was served. That is rule #8 applied to
a path that used to hide its own failure; the alternative was sending an empty body upstream.

The honest cost, measured: above `threshold_bytes` this is a **second** spill of a body the ingress
already spilled. With the same subject as the previous increment (raw body 9638 bytes,
`threshold_bytes = 1024`) and **no** `request_ingress` transform, the charges before the dump are the
ingress receive 9638 and the rung's rebuild 4313 — peak **13951**, the clone path's number — and the
dump's own read adds another 4313 for a peak of **18264**. The window `(13951, 18264)` is exactly where
the two disagree. With a transform active the hook's read takes the same third charge and breaches that
budget *first*, so the dump's charge is only separately observable on the transform-free path; the
tests therefore install none.

**Observed while writing the tests, pinned rather than designed:** with spooling on, the dump logs a
`$spoolBlob` ref, not base64. `buildRouteAttempt` (`:2093`) serializes the *ref-bearing* body, so
`test_model.log` shows `{"$spoolBlob":true,"kind":"chat-image-url","hash":"…","prefix":
"data:image/png;base64,","size":5464}` where the spool-off run would show the payload. That is the
honest reading of the file an operator opens when debugging, and a future rehydrate-before-dump would
show up as a difference.

Verified: `tests/unit/request-ingress-transform-refs.test.ts` gained a sixth block, three tests, and a
`set: null` option on `writeConfig` (installing no transform at all, which the block needs for the
reason above). One case runs the same body with the spool off and then on at `2x` (19276, above the
18264 peak) and asserts the forwarded body is byte-identical to the spool-disabled one, the image is
still expanded at the send, no ref reaches the upstream, the dumped payload position *is* a
`$spoolBlob` ref (the rest of the dumped body equals the forwarded one), the dump does not carry the
payload, `getLiveSpillBytes() === 0` and no file is left in `requests/`. A second case sets
`max_total_bytes` to `1.5x` (14457, inside the window) and asserts 503 `over_limit_error`, message
matching `live spill budget exceeded`, **zero** upstream calls, and a returned reservation. The third
runs the identical body and budget with `LOG_LEVEL=error`, asserts no log file is written, and that the
request is served — so the refusal belongs to the dump and not to the budget every request pays. That
the failing charge is the dump's was settled by measurement: reverting to `attemptRequest.clone()` and
re-running the block at the same budget returns **200** on the second case.

Full suite 2606/2606 (522 suites), typecheck and build clean.

### feat(spool): §5.1/§5.7 — the `request_ingress` body read is bounded

`src/index.ts`'s `request_ingress` block — the hook that rewrites the inbound body before any handler
sees it — read its subject with `await attemptRequest.clone().text()` (`:2377`, now `:2497`). It now
receives `attemptRequest.body` through `receiveIngressBody` (`:2497`), reads it, and releases the
reservation in a `finally`. The reason is the one §5.7 exists for: `Request.clone()` *tees* the body,
so the branch nobody reads stays resident for as long as the read runs — a second full copy of a body
that may carry an image. Consuming the original in place is safe and is what makes the change a
reduction rather than a swap: the block rebuilds `attemptRequest` from the transformed body a few lines
down (`createJsonEgressBody(transformed.body, 'att-')`), so nothing reads the original again.

Three deliberate decisions, each visible in the diff:

- **No declared length is passed.** `receiveIngressBody`'s `declaredLength` is a hint for the spill
  decision (§5.1); the `Content-Length` on a request the proxy has already rebuilt describes an earlier
  body, so passing it would spill on a length that is no longer the one being read. The cap is the
  spool's own byte count instead. In practice `max_request_bytes` cannot fire here — the body was
  bounded at ingress and re-serialization adds a model name — but the read is bounded either way.
- **§5.9 is not charged a second time.** The request's own ingress lease (`:1263`) already covers this
  materialization of the same bytes; a second charge inside that lifetime would double-count them
  against `max_materialized_body_bytes`.
- **The cap is applied ungated** by `[spool] enabled`: `receiveSpooledBody` tests `total > maxBytes`
  before it ever consults `spillable`, so the bound holds with the spool off too. On *this* path it
  cannot actually fire while `enabled = false` — with the spool off there is no extraction, so the
  subject is the raw body the ingress already bounded — but the check is unconditional, which is one
  more data point on the gated-vs-ungated conflict increment 43 exposed, still unresolved.

The honest cost: above `threshold_bytes` the read is now a *second* spill of a body the ingress
already spilled, so it trades RAM for disk churn, and a tight `max_total_bytes` can refuse a request
the clone path served. That is the trade, and it is measured: with a 4000-character text message beside
a 4096-byte image (raw body 9638 bytes, `threshold_bytes = 1024`) the ledger's three concurrent
charges are the ingress receive 9638, the router's ref-bearing rebuild 4313, and this read 4313 —
peak **18264** against the clone path's **13951**. The window `(13951, 18264)` is therefore exactly
where the two implementations disagree.

Verified: `tests/unit/request-ingress-transform-refs.test.ts` gained a fifth block, two tests, and an
optional `pad` on `openaiUrlBody` (the pad is load-bearing — with an image alone the *attempt* body is
a few hundred bytes after §5.4 extraction replaced the image with a ref, so it sits below
`threshold_bytes` and nothing spills, which is the trap that made the first version of this test read
200 where it expected 503). One case puts `max_total_bytes` at `1.5x` the raw body, inside the window,
and asserts the refusal and its altitude: 503 `over_limit_error`, message matching
`live spill budget exceeded`, **zero** upstream calls, `getLiveSpillBytes() === 0`, and no file left in
`requests/`. The other runs the same padded body with `enabled = false` and then spooled at `2x` (above
the window, so all four charges fit), asserting the forwarded body is byte-identical to the
spool-disabled one, the hook's op is present, the ref was still expanded at the send, the read's
subject really was above threshold, and both reservations came back. That the failing charge is *this*
read's — and not the router rebuild's — was settled by measurement rather than inference: reverting
the receive to `clone().text()` and re-running the case at the same budget returns **200**.

**Reported, not fixed:** the `catch { parsedBody = {} }` beside the read silently degrades a malformed
attempt body to an empty object, which is then re-serialized and sent upstream as `{}` — a
pre-existing behaviour (the clone path swallowed it the same way), left alone here because changing it
changes what the upstream receives. The `LOG_LEVEL === 'debug'` block a few lines below (`:2541`) is
the next `attemptRequest.clone()` in this file and gets its own increment; it clones the *rebuilt*
request, so this change does not make it worse.

Full suite 2603/2603 (521 suites), typecheck and build clean.

### feat(spool): §5.7 — the client-egress transform read is bounded

`src/utils/request-transform.ts`'s `applyWriteoutBody` — the `response_egress` hook, which rewrites
the body on its way *to* the client — read its body with `await response.text()` (`:982`). It was the
last unbounded read in that module and the exact sibling of `applyAfterUpstream` (`:760`), which the
`after_upstream` increment already routed through `withResponseText`. It now goes through the same
primitive (`:992`): one bounded receive, `max_response_bytes` on the body with a breach cancelling it
rather than truncating it, a §5.9 charge (response class) around the parse, the spill released in a
`finally`, and a trace stage on the read. The ops, the malformed-JSON passthrough, and the rebuilt
`Response` shape (status, statusText, sanitized headers) are unchanged. The dead `hookCtx` mirror —
built and immediately `void`ed, a leftover of the copy from the sibling — is dropped with it.

Two things this hook does differently, preserved rather than blended: its own gate is
`hasHookOps('response_egress', …)` plus a content-type check, so a non-JSON body (an SSE stream, which
is `pipeEventTransformer`'s business) is returned as the very same `Response` without being read at
all; and its read is usually a **second** receive of a body the caller already spooled — the stats
extraction above it re-wraps the body as `response` — so past `threshold_bytes` this costs a second
spill rather than saving RAM. What it buys is the bound, the charge and the stage, not memory. That is
the same honest trade increment 65 recorded on the PII-restore path.

`HookContext.signal` now reaches this hook: the central wrap's `writeoutCtx` (`src/index.ts:2884`)
carried no signal, so it gains `signal: request.signal` (`:2893`) — the *client* request's signal, as
the handlers' `after_upstream` call sites pass. Without it a §5.9 waiter at this hook would hold its
place until `admission_timeout_ms` after the client had gone.

The cap is **not** gated on `[spool] enabled` here either (asserted, not assumed): one more data point
on the gated-vs-ungated conflict increment 43 exposed, still unresolved.

**Not changed, reported:** the trace line this site now emits is labelled `[UPSTREAM-RESP] (client
egress)` — `withResponseText` hardcodes the `upstream-response` stage, whose label reads oddly for a
read of a body on its way out. The repo has an `outbound` stage label for exactly this ("body after
conversion, returned to the client"), but selecting it means adding a stage parameter to the shared
primitive and changing what every caller logs; left alone here. The body at this point is still the
pre-`restorePrivacyResponse` one (that runs after the attempt loop), so what the stage echoes is
sentinel-bearing text, never the caller's own PII.

Verified: `tests/unit/transform-response-spool.test.ts` gained three suites and nine tests beside the
`after_upstream` ones — the two fast paths (op-free, and a non-JSON body that must not be read at all),
an under-threshold answer that leaves no spill and no clone, an above-threshold body captured on disk
mid-receive and released before the client's response is returned, its answer compared to a
spool-disabled run of the same call, the read pulled exactly once start-to-close, a cap breach (500
`processing_error`, upstream body cancelled, no partial spill) both with the spool on and with
`enabled = false`, a malformed-JSON body passed through byte-for-byte through the receive, a §5.9
refusal (503 `over_limit_error`, no bytes, no reservation), and a queued waiter dropped when the client
aborts. Reverting the receive to `await response.text()` fails exactly the six tests that pin it and
leaves the fast-path and under-threshold ones passing. The `writeoutCtx` signal is a call site, read
rather than driven from these tests — as the sibling hook's handler call sites are — so it is pinned by
the unit-level `ctx.signal` contract, not end to end. Full suite 2601/2601 (520 suites), typecheck and
build clean.

### feat(spool): §5.7 — the remote auth server's response body is bounded

`src/index.ts`'s `doAuthRequest` read the auth service's answer with `await authResp.text()` — the last
unbounded remote-body read in that file. It now receives it through the same bounded primitive every
other remote body in the file uses:

- One `receiveResponseBody` (`:1122`), so `max_response_bytes` bounds the body, and a breach cancels
  the auth body instead of buffering it whole — 500 `processing_error`, no spill file left behind, and
  the upstream never reached.
- A §5.9 charge on the read (`:1129`–`:1141`, response class), charged the auth body's own byte count.
  Response class rather than request: a deferred-auth request already holds its own ingress
  reservation (that admission is a few lines later, `:1263`), so this read must not queue behind it
  (hold-and-wait — see `spool-admission.ts`).
- The fetch and the body read are now two `try` blocks. They shared one, and its `catch` answers 503
  "Authentication service unavailable: could not reach remote auth server". A proxy-side limit must
  not be reported as the auth server being down (rule #8), so the read has its own `catch` that
  rethrows any `ClaudeProxyError` (cap breach, spill failure, refusal) to the terminal error mapping
  where it is reported as itself; a transport read failure stays best-effort exactly as before.

The one deliberate divergence from the other readers: the receive is **inline**, not through
`withResponseText`. That primitive's trace stage (`spool-response.ts:166`) echoes the text it
receives, and this body can carry `targets[].key`/`otac` — the upstream API keys the routing ladder is
built from (`target-retry.ts`). A credential-bearing body is never echoed, so this site receives it
without a log stage, and a test pins that no log level, trace included, prints it.

The cap is **not** gated on `[spool] enabled` here (asserted, not assumed), following the repository's
stated rule and the same choice as the four identity receives and increments 54/65 — one more data
point on the gated-vs-ungated conflict increment 43 exposed, which is still unresolved.

**Not fixed, reported:** `:1180` logs a *dropped* `targets[]` entry with `JSON.stringify(d.entry)`, so
a malformed entry that carries `key`/`otac` is written verbatim at error level. That is pre-existing
and independent of this read (it never passes through it), and it is on the no-echo rule's wrong side.

Verified: new `tests/unit/index-auth-response-spool.test.ts`, six tests in four suites, driving the
real `handler` with `[remote] auth_server` set and a scratch `[spool] dir` in the TOML (the config
loader owns `setSpoolConfig`, so `[spool]` has to come from the file). Pinned: a body under the cap
leaves the answer byte-identical to a spool-disabled run; the wire-contract `version` gate still reads
its value from that body; a body past `max_response_bytes` is a 500 `processing_error` naming the
response cap, leaves `upstreamCalls === 0` and no spill file — and crucially does **not** match
`/unavailable|could not reach remote auth server/`; the same with `enabled = false`; a §5.9 refusal is
a 503 `over_limit_error` whose message names the *auth* body's byte count rather than the ingress
body's, with both ledgers back to zero; and the auth body's marker stays out of trace output while the
inbound body's marker is present (a positive control, so the absence is a property of this read and
not a dead capture). The two cap tests are the discriminating ones: replacing the bounded receive with
`await authResp.text()` fails exactly those two and leaves the other four passing. The trace test
drains the client response before the `afterEach` ledger check, because that response's body holds the
*upstream* body's spill reservation until it is read — the 191 bytes the hook first reported were
verified byte-for-byte as that reservation, not suppressed. Full suite 2592/2592 (517 suites),
typecheck and build clean.

### feat(spool): §5.7 — the PII restore reads the client-facing body through the bounded receive

`src/index.ts`'s `restorePrivacyResponse` rebuilt the client-facing body with `await response.text()`
— the last unbounded whole-body read on a response the proxy builds itself. Its two buffered branches
(JSON, and every other content-type) are now one block that reads through `withResponseText`:

- One bounded receive instead of `response.text()`, so above `threshold_bytes` the bytes the restore
  works on live on this response's spill, `max_response_bytes` caps them, and the restore's text takes
  its own §5.9 charge (a re-materialization downstream of the boundary, now recorded as such in
  `spool-admission.ts`'s wiring note, whose "§5.9's per-rung re-acquisition has no caller today" claim
  this makes false on the response side).
- The spill and the lease are released before the restored text is handed to `new Response`, and both
  the cap breach and the §5.9 refusal release first and propagate to the caller's error mapping, so a
  body the proxy refused to read is never restored from a partial copy (rule #8).
- `restorePrivacyResponse` gained a `signal?: AbortSignal` parameter; all four call sites
  (`:3002` ladder, `:3011` fusion, `:3039` attempt loop, `:3091` single attempt) pass the client's
  signal (`request.signal`, or `attempt.request.signal` in the loop). The SSE branch
  (`createRestoreTransformStream`) is untouched.
- `src/utils/spool-response.ts`'s header now lists this reader — the one whose input is a body the
  proxy built itself, and so the one that reads back off the spool it just wrote.

**Measured honestly, because the margins are thin.** There is no RAM relief on this path: the restore
needs the whole text to replace sentinels in, so `readText()` joins exactly what `.text()` joined. The
real effects are (a) `max_response_bytes` now applies to this read too — structurally, since a
handler-synthesized body (a converter's, or the fusion path's) can exceed what the upstream sent;
(b) §5.9's budget covers the one materialization that was outside it, which is what makes the budget a
believable RAM bound; (c) a cap breach or a refusal now fails explicitly here (500 `processing_error`
/ 503 `over_limit_error`) where the old read could only fail as I/O. The cost: the restore receives a
body the handler's own receive still holds on disk, so a PII-active response past `threshold_bytes`
now needs room for a **second** spill, and a `max_total_bytes` that fits only the first is a 503 where
the old read returned 200 (measured: `live spill budget exceeded: 1988 + 1988 bytes >
max_total_bytes 2105`). A streaming restore — the SSE branch's transform stream, applied to these
bodies — would remove that second spill and is left as future work. Two smaller notes: the new
receive is **not** gated on `[spool] enabled` (like the four identity receives, unlike the SSE
framing — the gated-vs-ungated convention increment 43 exposed is still unresolved), and it emits a
new trace-gated `[UPSTREAM-RESP] (privacy restore)` line whose payload is the *pre*-restore,
sentinel-bearing body, which carries no PII by construction.

Verified: `tests/unit/index-routing.test.ts` gains a new `§5.7 spooling of the PII restore read`
describe with two tests, driven end-to-end (real handler, `[privacy_filter] filter_mode = "local"`,
no sidecar — the local hash detector mints `⟦HASH:0⟧` in-process). The first pins correctness of the
new path: the secret never leaves the proxy, the client gets the original value back out of a body
past `threshold_bytes`, no `Response.prototype.clone()` anywhere, and an empty `responses/` dir with
`getLiveSpillBytes() === 0` afterwards. The second is the discriminating one: with
`max_total_bytes = upstreamBytes + 64`, the restore's second spill cannot reserve, and the answer is
503 `over_limit_error` with no spill and no live reservation left. Reverting the restore to
`response.text()` fails exactly that second test (it returns 200) and leaves the first passing — which
is the honest statement of what this increment changes: the first test would have passed before, the
second could not have. Full suite 2586/2586, typecheck and build clean. A cap-breach test for *this*
receive was deliberately not written, because it cannot be isolated: the converted Claude body is
~50 bytes smaller than the upstream OpenAI body, so no `max_response_bytes` value cuts between the two
receives — a test that "passed" by breaching the handler's receive first would prove nothing.

### feat(spool): §5.7 — the non-2xx remote-stats error body is bounded, and a dropped response is released

`src/index.ts`'s `else if (attemptModelId)` branch — the one that records a *failed* attempt to
`[remote] record_server` with zero usage and the real status — read the upstream's error body with
`response.clone().json()` / `.clone().text()` (`:2764`). That is the same second copy §5.7 forbids on
the success side, on the one path where the body is both large and of no use to the client beyond
being relayed. With `[spool] enabled` it now goes through one bounded `receiveResponseBody`:

- The read is the success-side dance verbatim: one bounded receive, one `admitResponseMaterialization`
  on the response class (charged the received byte count, released in a `finally`), the `JSON.parse`
  in a narrow catch of its own. A `content-type` that is not JSON is still recorded as raw text, and a
  body advertised as JSON that is not parseable is still recorded without a body.
- The status and headers reach the client unchanged and the bytes are streamed back out of the same
  spill (`new Response(received.readStream(), response)`), so a failure answer is byte-identical to a
  spool-disabled run — asserted directly, not assumed.
- A breach, a spill write failure or a §5.9 refusal releases the spill and propagates (rule #8)
  instead of being served as the upstream's own error. Before this change that path could not fail at
  all; now `max_response_bytes` applies to it, so an oversized error body is a 500
  `processing_error` and **no** record is posted for a body the proxy refused to read.
- With `[spool] enabled = false` the branch keeps its pre-existing `clone()`, so the disabled path is
  untouched.

This increment also has to release a response the retry ladder abandons, because the two changes
compose into a leak that did not exist before. The statuses the ladder re-hits (axis 2, an explicit
`retry_on`) and the ones it supersedes (axis 1, a rung advance) are exactly the 429/5xx statuses this
branch now spills for, and an abandoned spill keeps both its file and its `getLiveSpillBytes()`
reservation until the *startup* sweep — there is no runtime reaper, so the rest of the process's
requests pay that byte budget down. `runTargetLadder` now has one `discardOutcome` helper (`:2931`)
and cancels the body at both drop points (`:2970`, `:2983`) — stream cancellation is the release
mechanism (`spool-body.ts`'s `cancel: () => finish()`), so the drop is explicit rather than an
abandonment. **Scope note:** the same exposure already exists for increments 44/45's spooled
egresses (a discarded attempt response on a ladder path), and this helper fixes that too; it is a
companion fix the change requires, not a separate feature.

Verified: `tests/unit/index-routing.test.ts` gains five tests in a new nested `describe`. Four drive
the non-2xx read — a 6 KB error body spilled and streamed to the client byte for byte with **no**
`Response.prototype.clone()` and the parsed body recorded; an 8 KB body past `max_response_bytes`
failing as 500 `processing_error` with no record and no live spill; the spool-off path keeping its one
clone and its untouched client copy; and `record_response_body = false` reading nothing at all (zero
clones, nothing on disk). The fifth drives the ladder — a first rung re-hit once (axis 2) and then
superseded (axis 1), every abandoned 500 spilled and released, ending with
`getLiveSpillBytes() === 0` and an empty `responses/` spill dir. Both new behaviours were reverted in
turn and only the intended tests failed: `discardOutcome` made a no-op (1 fail — the ladder test), the
spool branch forced to the disabled one (2 fail — the two spool-on error-body tests; the spool-off and
record-off tests are correctly insensitive). Full suite 2584/2584 (2579 + 5), typecheck and build
clean.

Note on reachability, established while writing these tests: the branch only ever sees a non-2xx
response the *handler returned*. On `/v1/messages` it is unreachable — `messages.ts` reads the error
body itself and throws it out through `handleTargetApiError` — which is why these tests drive the
`openai-completions` passthrough (status, headers and bytes preserved) rather than the Messages path.

### feat(spool): §5.7 — the fusion pipeline's response reads are bounded

`src/index.ts`'s fusion stage read three response bodies without any bound, and each of them is a body
the client never sees: `readResponseJson` (`:2138`) — used for every panel answer (`:2221`) and for the
judge's analysis (`:2286`) — called `resp.clone().json()`, holding a second copy of the whole body for
as long as it parsed, and the synthesis metadata read (`:2347`) went through the same helper, so a
panel answering with an image paid for its base64 payload twice and neither copy was ever capped. All
three now go through the same bounded primitive as every other response:

- `readResponseJson` consumes the body with one `receiveJsonResponse` (`withResponseText` + a parse),
  fed the client's `request.signal` and the stage's own `targetUrl` for the trace line. The
  `content-type` check and the "not JSON" answer are unchanged, but the catch is narrowed: a
  `ClaudeProxyError` — a `max_response_bytes` breach, a spill write failure, a §5.9 refusal — now
  propagates instead of being reported to the client as this panel's answer, which is what the old
  bare `catch { return null; }` did (rule #8). A body advertised as JSON that is not parseable keeps
  its pre-existing "non-JSON response" diagnostic.
- The judge's `catch (e)` narrows the same way: a `ClaudeProxyError` is the proxy's own limit, not a
  judge failure, and must not be degraded into a successful-looking answer. Every other judge failure
  still degrades exactly as before — logged, and a hard error only under `judge_required`.
- The synthesis metadata read is now one `receiveResponseBody` on §5.9's response class
  (`admitResponseMaterialization`, charged the received byte count, released in a `finally` before the
  body is handed on), with the `JSON.parse` in a narrow catch of its own — an unparseable synthesis
  body is forwarded unchanged and no metadata is attached, where before the clone left the original
  body intact for the client. The happy path is unchanged: `content-length` is still dropped from the
  enriched answer, and when a metadata wrap does happen the spill and its reservation are released
  before the rebuilt `Response` is returned. When no wrap happens the body the receive consumed is
  streamed back out of its own spill (`new Response(received.readStream(), synthResp)`), so the
  client's bytes are the upstream's bytes whether or not a spill occurred.
- Panel and judge bodies are never forwarded, so nothing about their own bytes changes; the synthesis
  body reaches the client byte for byte, which the new tests pin against a spool-disabled baseline.
- The cap is applied with `[spool] enabled = false` as well, matching the rule this repository states
  for the other egresses; increment 43's open question about that convention is unaffected.
- Deliberately out of scope, still unbounded and each a separate increment: the remaining reads in
  `src/index.ts` (`:1099`, `:2476`, the spool-disabled stats fallback at `:2704` and the non-2xx
  remote-stats error body at `:2706`/`:2708`), the `restorePrivacyResponse` pair at `:237`/`:253`,
  and the inbound `request.text()`/`request.json()` family (a different direction of travel).

Verified: `tests/unit/fusion-response-spool.test.ts` is new — 6 tests over a three-target
`[composite]` fusion alias (panel + judge + synth) — pinning that a full panel/judge/synth round trip
with `[spool] enabled = true` performs **no** `Response.prototype.clone()` on any of the three bodies
and still sends `panel-a` → `judge-b` → `synth-c` and returns the synthesis answer with the complete
`fusion_metadata`; that a spilled synthesis body reaches the client byte for byte, identical to a
spool-disabled baseline, with the spill freed; that a synthesis body advertised as JSON but not
parseable is still forwarded unchanged; that a `max_response_bytes` breach on the judge stage fails
the whole request (500 `processing_error`, the "Response body too large" message, no synthesis
attempt, no live spill) rather than degrading; and that a prose judge answer still degrades to a 200
with `analysis_present: false`. Each of the five sites was reverted in turn and only the intended
tests failed: back to `resp.clone().json()` (1 fail), the synth receive fed a cloned body (1 fail),
the judge narrowing removed (1 fail), the spill-backed rebuild removed (3 fail — the unparseable-body
test on a client-visible 500, then two more on the 66-byte spill the failed test leaked), and the
release before the enriched return removed (6 fail, the same process-wide ledger cascade). Stated
plainly: the cap cannot by itself prove which of these reads saw a breach, because the egresses and
the attempt loop's stats read already bound every panel/judge/synth body before fusion reads them —
the discriminating pin is the clone count with the spool on, which is why it is asserted directly.
Full suite 2579/2579 (2573 + 6), typecheck and build clean.

### feat(spool): §5.7 — `chat-completions.ts`'s upstream *error* bodies are bounded

`src/handlers/chat-completions.ts`'s two converted branches read the upstream's error body with
`response.text()` and *returned* it to the client, so an error answer was the one body on this egress
that no `max_response_bytes`, no spill and no §5.9 charge applied to: `:128` (an `anthropic-messages`
upstream, converted Claude JSON → Completions JSON) and `:368` (a `gemini-generatecontent` upstream).
Both now go through `withResponseText` on the identity consumer — the branch relays the upstream's
own bytes and never converts them — fed the client's `request.signal`. The `openai-responses` branch
has no such read (it forwards the identity body through the spool), so it is unchanged.

- The normal case is unchanged: same upstream status, same `x-request-id`, and the relayed body byte
  for byte, which the new tests pin against a spool-disabled baseline.
- A cap breach, a spill write failure or a §5.9 refusal now propagates out of the handler instead of
  being served to the client as the upstream's own 429. `handleChatCompletionsPassthrough` has no
  enclosing try/catch — its only `try` guards the inbound JSON parse — so the error leaves it
  unmodified, travels through the attempt loop's `outcomeFromError` to `src/index.ts`'s terminal
  catch (`:2974`) and is rendered as itself (500 `processing_error`, 503 `over_limit_error`). As
  before, a thrown 5xx is `isRetryableOutcome`, so a target ladder may still try its next rung
  first — pre-existing policy, stated not changed.
- The cap is applied with `[spool] enabled = false` as well, matching the rule this repository states
  for the other egresses; increment 43's open question about that convention is unaffected.
- Deliberately out of scope, still unbounded and each a separate increment: the remaining
  `!response.ok` reads in `src/index.ts`, the fusion `readResponseJson` clone, and the inbound
  `request.text()`/`request.json()` family (a different direction of travel).

Verified: `tests/unit/chat-completions-response-spool.test.ts` grew from 10 to 16 tests — three per
site over a two-entry `ERROR_SITES` table: the error body spilled mid-receive (asserted on disk
part-way through) and the client's status and bytes identical to a spool-disabled baseline with no
`Response.prototype.clone()`, a `max_response_bytes` breach raising `SpoolResponseTooLargeError`
(500 `processing_error`) with the upstream body cancelled and no partial spill, and a §5.9 refusal
surfacing as 503 `over_limit_error` ahead of the upstream's 429. Each site was reverted to
`response.text()` in turn and only its own three tests failed (13 pass / 3 fail), then restored.
Full suite 2573/2573 (2567 + 6), typecheck and build clean.

### feat(spool): §5.7 — `claude.ts`'s upstream *error* body is bounded

`src/handlers/claude.ts`'s `!response.ok` branch (`:184`, the native `anthropic-messages` egress of
`/v1/messages`) read the upstream's error body with `response.text()`, so a 429/500 answer was the one
body on that path that no `max_response_bytes`, no spill and no §5.9 charge applied to. It now goes
through `withResponseText`, fed the client's own `request.signal`, with the identity consumer —
`handleTargetApiError` is still given the text and still throws, so the upstream's status, type,
message and `.upstreamBody` reach the client unchanged, and the pre-existing
`logger.error` line and `bodyPreview` computation stay in source position.

- One behaviour genuinely changed, and it is a fix: the branch's bare `catch {}` used to replace
  *any* failure with `'(failed to read response body)'` before handing that placeholder to
  `handleTargetApiError`. With a bounded receive inside it, that would have reported a
  `max_response_bytes` breach, a spill write failure or a §5.9 refusal to the client as the
  upstream's own error — a silent default success of exactly the kind rule #8 forbids. The catch now
  keeps only a `TypeError`, which is what an unreadable upstream body throws and the one case the
  placeholder was written for. Every other error propagates: through the attempt loop's
  `outcomeFromError` to `src/index.ts`'s terminal catch (`:2974`), rendered as itself — 500
  `processing_error`, 503 `over_limit_error` — in the Anthropic envelope. This follows the same
  narrowing already used at `src/handlers/passthrough.ts:300`.
- The cap is applied with `[spool] enabled = false` as well, matching the rule this repository states
  for the other egresses; increment 43's open question about that convention is unaffected.
- Deliberately out of scope, still unbounded and each a separate increment: the remaining
  `!response.ok` reads in `chat-completions.ts` and `src/index.ts`, the fusion `readResponseJson`
  clone, and the inbound `request.json()`/`request.text()` family (a different direction of travel).

Verified: `tests/unit/claude-response-spool.test.ts` grew from 11 to 15 tests. The new section pins
the error body spilled mid-receive (and the `UpstreamApiError` identical to a spool-disabled baseline
in status, type, message and `upstreamBody`, with no `Response.prototype.clone()`), a
`max_response_bytes` breach raising `SpoolResponseTooLargeError` (500 `processing_error`) with the
upstream body cancelled and no partial spill, a §5.9 refusal surfacing as 503 `over_limit_error`
ahead of the upstream's 429, and — the narrowing's own regression test — a `TypeError` from an
unreadable body still yielding the placeholder. Two mutations confirm the pins: restoring the old
`response.text()` + bare `catch` fails the first three, widening only the catch back to bare fails the
cap and refusal tests while the placeholder test still passes. Full suite 2567/2567 (2563 + 4),
typecheck and build clean.

### feat(spool): §5.7 — `gemini.ts`'s upstream *error* bodies are bounded

`src/handlers/gemini.ts`'s three `!response.ok` branches read the upstream's error body with
`response.text()`, so a 429/500 answer was the one body through this handler that no
`max_response_bytes`, no spill and no §5.9 charge applied to — on exactly the branch that is already
going wrong. All three now go through `withResponseText`, the bounded receive the success bodies
beside them already use: `:130` in `handleGeminiCountTokensRequest`, `:280` in
`handleGeminiInteractionsRequest`, and `:493` in the native `handleGeminiGenerateContentRequest`. The
read is fed the client's own `request.signal`, so a §5.9 refusal is decided against the same signal
the rest of the request uses.

- No new failure handling was needed. `:130` and `:280` sit under no try/catch at all, so their
  errors leave the handler exactly as the branch already threw them, and `:493`'s enclosing `catch`
  (`:508`) logs at error level and re-throws, so it neither swallows nor relabels the failure. A cap
  breach, a spill failure or a §5.9 refusal therefore propagates through the attempt loop's
  `outcomeFromError` to `src/index.ts`'s terminal catch (`:2974`) exactly as every other error from
  this handler does, and is rendered as itself — 500 `processing_error`, 503 `over_limit_error` — in
  the Anthropic envelope, the `/v1beta/models/…:countTokens`, `:generateContent` and
  `/v1/interactions` routes being outside the `/v1/responses*` family. The pre-existing retry policy
  applies to it unchanged: a thrown 5xx is `isRetryableOutcome`, so a ladder may still try its next
  rung before the terminal catch, the same as for the upstream error these branches already threw.
- The upstream's own error still reaches the client unchanged, which is now visible in
  `createErrorResponse`'s `UpstreamApiError` passthrough: same status, same
  `handleTargetApiError` type/message mapping, and `.upstreamBody` byte for byte. Each pre-existing
  `logger.error` line and each `bodyPreview = JSON.stringify(geminiRequest).substring(0, 1000)`
  computation stays in its source position, so the observable order stays receive → log → compute →
  throw. As on every other `withResponseText` caller the error body is now also emitted as the
  `upstream-response` pipeline stage, which is gated on `logger.traceEnabled` and changes nothing
  unless tracing is on.
- The cap is applied with `[spool] enabled = false` as well, matching the rule this repository
  states for the other egresses and the pin already in this file's success-path tests; increment
  43's open question about that convention is unaffected by this change.
- Deliberately out of scope, still unbounded and each a separate increment: the remaining
  `!response.ok` reads in `claude.ts`, `chat-completions.ts` and `src/index.ts`, the fusion
  `readResponseJson` clone, and the inbound `request.text()` family (a different direction of
  travel).

Verified: `tests/unit/gemini-response-spool.test.ts` grew from 11 to 20 tests — three per site on a
new three-entry `ERROR_SITES` table (`:countTokens`, `/v1/interactions`, `:generateContent`): the
error body spilled mid-receive (asserted on disk part-way through), the client-visible
`UpstreamApiError` identical to the spool-disabled baseline in status, type, message and
`upstreamBody` with no `Response.prototype.clone()`, a `max_response_bytes` breach raising
`SpoolResponseTooLargeError` (500 `processing_error`) with the upstream body cancelled and no partial
spill, and a §5.9 refusal surfacing as 503 `over_limit_error` ahead of the upstream's 429. Each of
the three sites was reverted to `response.text()` in turn and only its own three tests failed
(17 pass / 3 fail), then restored. Full suite 2563/2563, typecheck and build clean — of which 2554 is
everything except the nine tests appended here, the remaining ten having been added to this tree
concurrently by another writer (see the notes below).

### feat(spool): §5.7 — `openai.ts`'s upstream *error* bodies are bounded

`src/handlers/openai.ts`'s three `!response.ok` branches read the upstream's error body with
`response.text()`, so a 429/500 answer on the `/v1/interactions` and Gemini
`:generateContent` egresses was the one body there that no `max_response_bytes`, no spill and no
§5.9 charge applied to — on exactly the branch that is already going wrong. All three now go through
`withResponseText`, the bounded receive the success bodies beside them already use: `:879` in
`forwardCompletionsAsAnthropicMessages`, `:1035` in `forwardCompletionsAsOpenAIResponses`, and
`:1334` in `handleOpenAIRequest`'s own `openai-completions` path.

- No new failure handling was needed. `:879` and `:1035` sit under no catch at all — both forwards
  are called from `handleOpenAIRequest` *above* its `try`, so their errors leave the handler as
  they are — and `:1334`'s enclosing `catch` logs at debug level and re-throws, so it neither
  swallows nor relabels the failure. A cap breach, a spill failure or a §5.9 refusal therefore
  propagates through the attempt loop's `outcomeFromError` to `src/index.ts`'s terminal catch
  (`:2974`) exactly as every other error from these handlers does, and is rendered as itself — 500
  `processing_error`, 503 `over_limit_error` — in the Anthropic envelope, these routes being outside
  the `/v1/responses*` family. The pre-existing retry policy applies to it unchanged: a thrown 5xx
  is `isRetryableOutcome`, so a ladder may still try its next rung before the terminal catch, the
  same as for the upstream error these branches already threw.
- The upstream's own error still reaches the client unchanged, which is now visible in
  `createErrorResponse`'s `UpstreamApiError` passthrough: same status, same
  `handleTargetApiError` type/message mapping, and the raw body forwarded verbatim. Each
  pre-existing `logger.error`/`logger.debug` line stays in its source position, so the observable
  order stays receive → log → throw. As on every other `withResponseText` caller the error body is
  now also emitted as the `upstream-response` pipeline stage, which is gated on `logger.traceEnabled`
  and changes nothing unless tracing is on.
- The cap is applied with `[spool] enabled = false` as well, matching the rule this repository
  states for the other egresses and the pin already in this file's success-path tests; increment
  43's open question about that convention is unaffected by this change.
- Deliberately out of scope, still unbounded and each a separate increment: the remaining
  `!response.ok` reads in `gemini.ts`, `claude.ts`, `chat-completions.ts` and `src/index.ts`, the
  fusion `readResponseJson` clone, and the inbound `request.text()` family (a different direction of
  travel).

Verified: `tests/unit/openai-response-spool.test.ts` grew from 21 to 30 tests — three per site, on
the existing three-site `SITES` table: the error body spilled mid-receive (asserted on disk
part-way through), the client-visible `UpstreamApiError` identical to the spool-disabled baseline in
status, type, message and `upstreamBody` with no `Response.prototype.clone()`, a
`max_response_bytes` breach raising `SpoolResponseTooLargeError` (500 `processing_error`) with the
upstream body cancelled and no partial spill, and a §5.9 refusal surfacing as 503 `over_limit_error`
ahead of the upstream's 429. The suite was also run with the `:1334` site reverted to
`response.text()` to confirm its three tests fail there. Full suite 2544/2544, typecheck and build
clean.

### feat(spool): §5.7 — `messages.ts`'s upstream *error* bodies are bounded

`src/handlers/messages.ts`'s four `!response.ok` branches read the upstream's error body with
`response.text()`, so a 429/500 answer was the one body on `/v1/messages` that no
`max_response_bytes`, no spill and no §5.9 charge applied to — on exactly the branch that is already
going wrong. All four now go through `withResponseText`, the bounded receive the success bodies
beside them already use: `:401` (OpenAI-format client against an `openai-responses` upstream),
`:505` (the same client against `openai-completions`), `:684` (Claude-format client against
`openai-responses`) and `:822` (Claude-format client against `openai-completions`).

- The landing is uniform and needed no new handling: all four sites live in the single
  `handleMessagesRequest` and end in `handleTargetApiError`, which is typed `never`; none sits under
  a catch of its own — the only nearby catches are `catch (_e) { /* ignore */ }` wrapping nothing but
  the `/tmp/test_model.log` capture — so a cap breach, a spill failure or a §5.9 refusal propagates
  to `src/index.ts`'s terminal catch exactly as each branch's success path does, and is rendered as
  itself (500 `processing_error`, 503 `over_limit_error`) rather than as the upstream's error.
- The upstream's own error still reaches the client unchanged: same status, same
  `handleTargetApiError` type/message mapping, and `.upstreamBody` byte for byte. Each pre-existing
  `activeLogger.error`/`activeLogger.debug` line stays in its source position, so the observable
  order stays receive → log → throw, and the `upstreamBodyPreview` computations in the two
  `openai-completions` branches are untouched. As on every other `withResponseText` caller the error
  body is now also emitted as the `upstream-response` pipeline stage, which is gated on
  `logger.traceEnabled` and changes nothing unless tracing is on.
- The cap is applied with `[spool] enabled = false` as well, matching the rule this repository
  states for the other egresses and the pin already in this file's success-path tests; increment
  43's open question about that convention is unaffected by this change.
- Deliberately out of scope, still unbounded and each a separate increment: the remaining
  `!response.ok` reads in `openai.ts`, `gemini.ts`, `claude.ts`, `chat-completions.ts` and
  `src/index.ts`, the fusion `readResponseJson` clone, and the inbound `request.text()` family
  (a different direction of travel).

Verified: `tests/unit/messages-response-spool.test.ts` gained 12 tests across a four-site table
(both client formats against both upstream modes), three per site: the error body spilled
mid-receive (asserted on disk part-way through), the client-visible `UpstreamApiError` identical to
the spool-disabled baseline in status, type, message and `upstreamBody` with no
`Response.prototype.clone()`, a `max_response_bytes` breach raising `SpoolResponseTooLargeError`
(500 `processing_error`) with the upstream body cancelled and no partial spill, and a §5.9 refusal
surfacing as 503 `over_limit_error` ahead of the upstream's 429. The suite was also run with one site
reverted to `response.text()` to confirm the three tests fail there. Full suite 2535/2535, typecheck
and build clean.

### feat(spool): §5.7 — `responses.ts`'s upstream *error* bodies are bounded

`src/handlers/responses.ts`'s `!response.ok` branches were the next unbounded family: eight sites
called `response.text()` on the upstream's error body, so a 429/500 answer was the one body on those
paths that no `max_response_bytes`, no spill and no §5.9 charge applied to — on exactly the branch
that is already going wrong. All eight now go through `withResponseText`, the same bounded receive
the success bodies beside them use: `:707` (`handleAsAnthropicMessages`), `:777` (`handleAsGemini`),
`:980` (`handleAsCompletions`), `:1685` and `:1734` (`handleResponsesInputTokensRequest`'s converted
and passthrough halves), `:1840` and `:1889` (`handleResponsesCompactRequest`'s two halves) and
`:1989` (`handleAsPassthrough`).

- The increment's content is where a failure lands, and here it is uniform: unlike the auxiliary
  handlers, every one of these branches sits under no catch of its own — the six sub-handlers are
  dispatched untangled from `handleResponsesRequest`, and the only nearby catches are the narrow §5.9
  ones that release and re-throw. So a cap breach, a spill write failure or a §5.9 refusal needs no
  new handling: it propagates to `src/index.ts`'s terminal catch exactly as these handlers' success
  paths do, and is rendered by `createResponsesErrorResponse` as itself (500 `processing_error`,
  503 `over_limit_error`) instead of being reported as the upstream's error.
- The upstream's own error still reaches the client unchanged: same status, same
  `handleResponsesApiError` type/message mapping, and `.upstreamBody` byte for byte, indentation
  included — the raw wording is what a client matches on for capability-rejection recovery. The
  existing `logger.error`/`logger.debug` line stays in its source position, so the observable order
  stays receive → log → throw. One consequence, shared with every other `withResponseText` caller:
  the error body is now also emitted as the `upstream-response` pipeline stage, which is gated on
  `logger.traceEnabled` and so changes nothing unless tracing is on.
- One finding, reported rather than fixed: `handleAsGemini`'s `!claudeResponse.ok` branch (`:777`) is
  **unreachable**. `claudeResponse` comes from `handleGeminiGenerateContentRequest`, which turns any
  non-ok upstream into `handleTargetApiError`'s throw inside its own `try` and otherwise returns only
  200s, so that error body can never be produced or tested. It was made bounded anyway — a one-line
  substitution of an existing statement, not new code — and the test file records why it is not
  pinned.
- Deliberately out of scope, still unbounded and each a separate increment: the remaining
  `!response.ok` reads (`messages.ts`, `openai.ts`, `gemini.ts`, `chat-completions.ts`, `claude.ts`,
  and the ones in `src/index.ts`), the fusion `readResponseJson` clone, and the in-process
  `claudeResponse.json()` in `handleAsGemini` (an already bounded body).

Verified: `tests/unit/responses-response-spool.test.ts` gained 21 tests across a seven-site table
(the four converted readers plus the three passthrough forwards), per site: the error body spilled
mid-receive (asserted on disk part-way through, not merely "a large read happened"), the
client-visible `UpstreamApiError` identical to the spool-disabled baseline in status, type, message
and `upstreamBody`, a `max_response_bytes` breach raising `SpoolResponseTooLargeError` (500
`processing_error`) with the upstream body cancelled and no partial spill, and a §5.9 refusal
surfacing as 503 `over_limit_error` *ahead of* the upstream's 429. The suite was also run with one
site reverted to `response.text()` to confirm the three tests fail there. Full suite 2523/2523,
typecheck and build clean.

### feat(spool): §5.7 — the auxiliary handlers' upstream *error* bodies are bounded

The `!response.ok` reads were the last unbounded family in the handlers this increment touches: five
sites called `response.text()` on an upstream error body and parsed the result, so a 429/500 answer
was the one body on those paths that no `max_response_bytes` and no spill applied to. Each now goes
through `receiveJsonResponse`/`withResponseText`, the same bounded receive its own success path
already uses: `src/handlers/models.ts:224` (`handleModelsRequest`), `:402`
(`handleAnthropicModelsDiscovery`), `src/handlers/embeddings.ts:128`, `src/handlers/decision.ts:157`
and `src/handlers/passthrough.ts:297`.

- The increment's content is where a failure lands, and it splits two ways because the surrounding
  code does. A cap breach, a spill write failure or a §5.9 refusal is the proxy's own limit — never
  the upstream's error, and never a parse failure:
  - `models.ts` ×2 answer it with `createErrorResponse` as itself. Both reads sit inside a catch that
    already had a job (`handleModelsRequest`'s returns a 200 config-only model list;
    `handleAnthropicModelsDiscovery`'s returns a 500 `internal_error` "Model discovery failed"), so
    letting the limit reach either would report a proxy limit as a quietly smaller success or as a
    broken upstream — a silent default success, forbidden by rule #8.
  - `embeddings.ts`, `decision.ts` and `passthrough.ts` already let their success path's receive fail
    upward, so the error body does the same and reaches the same terminal `createErrorResponse` in
    `src/index.ts`. `passthrough.ts` is the one with a placeholder to protect: its
    `'(failed to read response body)'` fallback would have swallowed every spool error into "the
    upstream body could not be read", so its `catch` now re-throws unless the error is the
    `TypeError` an unreadable stream raises — the only case that placeholder was ever for.
- The upstream's own error still reaches the client unchanged: the same status, the same
  `handleTargetApiError` type/message mapping, and `passthrough` still forwards `.upstreamBody` byte
  for byte, indentation included.
- Deliberately out of scope, still unbounded and each a separate increment: the remaining
  `!response.ok` reads (`responses.ts`, `messages.ts`, `openai.ts`, `gemini.ts`,
  `chat-completions.ts`, `claude.ts`, and the two in `src/index.ts`), and the fusion
  `readResponseJson` clone. `/v1/messages/count_tokens` reads nothing on its error branch, so it is
  listed rather than changed.

Verified: `tests/unit/aux-handler-response-spool.test.ts` and
`tests/unit/models-response-spool.test.ts` 13 new tests and
`tests/unit/passthrough-response.test.ts` 3 new, per site where it applies: the error body spilled
mid-receive (asserted on disk part-way through, not merely "a large read happened"), the
client-visible error byte-identical to the spool-disabled answer, a `max_response_bytes` breach
raising `SpoolResponseTooLargeError` (500 `processing_error`) with the upstream body cancelled and no
partial spill, a §5.9 refusal reported as 503 `over_limit_error` rather than as that handler's own
fallback, and passthrough's unreadable-body placeholder still covering a stream that dies mid-body.
Full suite 2502/2502, typecheck and build clean.

### feat(spool): §5.7 — the three model-listing readers' response reads are bounded

`src/handlers/models.ts` held the repo's last three whole-body upstream reads: `getModelCount` (the
`/health` path's count), `handleModelsRequest` (`GET /v1/models`) and `handleAnthropicModelsDiscovery`
(the Anthropic-shaped `?limit=1000` discovery). Each read with `response.text()`/`response.json()` and
then parsed, so nothing bounded what an upstream could send on. All three now go through
`receiveJsonResponse`, the same bounded receive the converting egresses use.

- Each of the three sits inside a catch-all that already had a job, so the receive is threaded
  through it rather than replacing it, and the increment's real content is where a failure lands:
  - `handleModelsRequest` and `handleAnthropicModelsDiscovery` keep their existing malformed-body
    answers (the config-only 200 list; the 500 `internal_error`) — `SyntaxError` is re-thrown into
    those catches deliberately. But a `max_response_bytes` breach, a spill write failure or a §5.9
    refusal is the proxy's own limit, not a parse failure, so those leave through
    `createErrorResponse` as themselves (500 `processing_error`, 503 `over_limit_error`). Letting a
    catch-all take them would turn a proxy limit into a quietly smaller model list (rule #8).
  - `getModelCount`'s catch-all is left intact and **one behaviour is disclosed rather than
    blessed**: it answers `{ count: 0, cached: false }` for every failure, and its only caller
    (`src/index.ts:997`) answers a count of 0 with its usual 404 (`src/index.ts:1013`) — so a cap
    breach is reported at error level but still reaches the client as a 404 it cannot tell from an
    upstream that listed nothing. The cap does take effect (the body is never materialized); the
    status a client sees is unchanged. Fixing that would mean changing a function whose contract is
    a count, so it is left as it is and pinned by a test that says so.
- `getModelCount` takes no `Request`, so it hoists one `createUpstreamAbortSignal(...)` and passes it
  to both the GET and the receive; the two handlers that do take a `Request` pass `request.signal`,
  matching the existing `receiveJsonResponse(…, request.signal)` convention.
- Deliberately out of scope, left as they are: the `!response.ok` upstream *error* reads beside two
  of these sites (`models.ts:217`, `:358`), which belong to the repo-wide error-body item in
  `docs/architecture/todos-of-spool-design.md`.

Verified: `tests/unit/models-response-spool.test.ts` 14/14 — per site: the answer byte-identical to
the same request with spooling off (with the large model id asserted to have survived, so two
equally-degraded answers cannot pass), the spill observed mid-receive on disk and charged, released
before the reader answers, a `max_response_bytes` breach cancelling the upstream body and leaving no
partial spill, and zero `clone()`; plus, per site, the malformed-body answer each handler already
gave and a §5.9 refusal reported as 503 `over_limit_error` rather than as that handler's own
fallback; plus `getModelCount`'s disclosed degradation answering 0 with the real error logged exactly
once. Full suite 2489/2489, typecheck and build clean.

### feat(spool): §5.7 — the `after_upstream` transform path's response read is bounded

`applyAfterUpstream` in `src/utils/request-transform.ts` read its upstream body with
`response.text()` and parsed the result, so on a route that declares `after_upstream` ops the spool
was defeated twice: the transform materialized the whole body in RAM first, and the handler's own
bounded receive then ran its bound over the already-materialized text. It now receives the body
through `withResponseText`, the primitive the converting egresses already use: a body over
`threshold_bytes` lives on that response's spill while it is transformed, `max_response_bytes` caps
it, and the parse is charged to the §5.9 budget.

- One bounded receive wraps both existing branches, unchanged: the `assemble_sse_chunks` assembly
  (5-arg `applyTransformSet`, `content-type` re-labelled `application/json`) and the JSON-ops
  branch (4-arg `applyTransformSet`, with its non-JSON passthrough). That pre-existing 5-arg vs
  4-arg asymmetry is preserved rather than blended. `assembleSseChunks(response)` became
  `assembleSseText(text)`: it now consumes the text the receive already read instead of reading the
  response a second time.
- New optional `HookContext.signal`, fed the **client request's** signal by all five call sites
  (`messages.ts` ×4 → `request.signal`, `openai.ts` ×1 → `originalRequest.signal`) — matching the
  existing `receiveJsonResponse(…, request.signal)` convention. It is the client abort §5.9 names,
  not the upstream `createUpstreamAbortSignal` timeout, which is a different thing. An aborted
  client now drops its queued §5.9 waiter instead of holding its place until `admission_timeout_ms`.
- **One behaviour change, worth stating plainly:** `max_response_bytes` (default 64 MiB) now bounds
  this read *whether or not* `[spool] enabled` is set, as it does on the other receives
  (`enabled` decides whether disk is used; the cap bounds the body). So a route that declares
  `after_upstream` ops and receives a body over the cap now fails with 500 `processing_error`
  instead of being transformed — previously the whole body was read regardless. Transforming it
  instead would mean holding it twice in RAM, which is the cost the cap exists to refuse.
- Fast paths are untouched: a route with no `after_upstream` ops still returns the very same
  `Response` without reading a byte.

Verified: `tests/unit/transform-response-spool.test.ts` 14/14 — both fast paths returning the
identical `Response` with zero pulls; unchanged answer below and above the threshold against a
spool-disabled baseline; the spill observed mid-receive, released before return, and the body read
exactly once (`[0,1,2]` pulls) with zero `clone()`; a `max_response_bytes` breach failing loudly and
cancelling the upstream body (and with `enabled = false`); status/statusText/upstream headers kept
and `content-length`/`content-encoding` dropped on the rebuilt answer; the SSE assembly and the
non-JSON passthrough both still correct through the receive; a §5.9 refusal reported as itself; and
— the signal this increment threaded — an aborted client dropping its queued waiter at once and a
pre-aborted one refused with nothing left on disk. Full suite 2475/2475, typecheck and build clean.

### feat(spool): §5.7 — the small passthrough handlers' response reads are bounded

Three handlers still read their upstream body whole with `response.text()` and then parsed it:
`POST /v1/embeddings`, `POST /decision` and `POST /v1/messages/count_tokens`. Each now reads
through §5.7's bounded receive, so a body over `threshold_bytes` lives on that response's spill
while it is received and `max_response_bytes` caps it.

- New primitive in `src/utils/spool-response.ts`: `withResponseText(response, requestId, logger,
  stageUrl, consume, signal?)` receives the body, takes the §5.9 lease, and runs `consume` on the
  text while the lease and the spill are still held. `receiveJsonResponse` is now its `JSON.parse`
  consumer, so the parse stays charged at every existing call site instead of moving outside the
  budget the budget exists for.
- `embeddings.ts` and `token-counting.ts` go through `receiveJsonResponse`. `decision.ts` goes
  through `withResponseText` and keeps the text: its answer is the upstream body verbatim
  (`new Response(responseText, …)`), and its Clef envelope is validated from the parse of that
  text. Its one signal now covers both the POST and the receive.
- Only `SyntaxError` still maps to each handler's pinned 502 `Invalid upstream response`. A cap
  breach, a spill write failure or a §5.9 refusal is the proxy's own limit and surfaces as itself
  (500 `processing_error`, 503 `over_limit_error`) rather than as a claim about the upstream
  (rule #8). `models.ts`'s two readers are left alone for exactly this reason: they sit inside
  catch-all fallbacks that would turn a spool limit into a quietly smaller answer.

Verified: `tests/unit/aux-handler-response-spool.test.ts` 23/23 — per site: unchanged answer
below and above the threshold, the spill observed mid-receive and released before the answer, a
`max_response_bytes` breach failing loudly and cancelling the upstream body (and with
`enabled = false`), each handler's own malformed-body outcome, a §5.9 refusal reported as 503,
zero `clone()`, and the charge equal to the received byte count; plus `withResponseText` driven
directly to pin that `consume` runs with the spill written and the lease held, and that a
throwing `consume` releases both. Full suite 2461/2461, typecheck and build clean.

### refactor(spool): §5.7 — the last logging-only response clones are gone

`src/handlers/messages.ts` held the repo's final response `tee()` branches used only for
logging: two `response.clone().text()` captures for the `LOG_LEVEL=debug` `/tmp/test_model.log`
dump (body contains `test_tool`). Both now observe the single read the client already performs,
via a module-local `captureTestModelLog` helper — no second reader, no second full body copy.

- The line lands on a terminal state of the body rather than when upstream finished: the end of
  the body, or the cancel the SSE converter performs when it stops upstream at `[DONE]`. A
  client that disconnects before that writes no line where the clone wrote one regardless of
  the client. The capture is therefore not a "response arrived" record; it is a "response body
  ended" record.
- A manual `ReadableStream` with `pull`/`cancel` and a drain-once `finish()` (the shape
  `createRefAwareJsonBody` uses) rather than a `TransformStream` tap: `createStreamTransformer`
  calls `controller.terminate()` on `[DONE]`, so a `flush()`-based tap would never write on any
  converted stream. The write is synchronous (`appendFileSync`) so it cannot be skipped by a
  later rejection, and an observation failure becomes one `logger.debug` line, matching
  `observeStream`'s rule for code that sits on the client's only path.
- The capture still keeps the first 2000 decoded characters; the decoder is flushed at the
  terminal state, so a multibyte sequence split across the last two chunks is not truncated.
- The wrapper is a constructed `Response`, which copies status/headers but not `url`, so the
  two trace labels fall back to `'(upstream)'` / `'(upstream SSE)'` on these debug+`test_tool`
  requests only.

Verified: `tests/unit/messages-response-spool.test.ts` 13/13, including four new cases — the
passthrough body (byte-identical client body, exactly one capture, zero clones, body spilled),
the converted site plus its two gates (no capture without `test_tool`, none outside debug), a
streaming run whose upstream never ends so the converter's cancel is the only terminal path
(one capture of the first 2000 characters, zero clones), and the `!response.ok` 429 path
(capture written with the error status, `upstreamBody` unchanged). Removing `finish()` from the
`cancel` hook fails exactly the streaming case. Full suite 2438/2438, typecheck and build clean.

### feat(spool): §5.9 admission lifetimes closed out

The §5.9 contract item had one unproven behavior and one undocumented deviation left.

- New test in `tests/unit/spool-events.test.ts`: with the whole materialization budget held by
  another body, a spilled SSE event's admission queues *before* the event is parsed, the wait
  pulls nothing further from upstream (the plan's "pause upstream response/event reads while
  their admission is waiting"), and once the budget frees the event is admitted and delivered
  byte-exactly with no spill, scratch blob, or reservation left behind.
- Plan §5.9 now records the per-rung deviation: the request path parses once per request, not
  once per rung — composite and auth-ladder rungs share the parsed object and re-serialize it
  into per-rung attempt spools — so a non-ref body holds its reservation across every rung
  (strictly conservative against the plan's per-rung release/re-acquire), and per-rung
  acquisition exists where a rung actually parses, namely the attempt loop's per-response
  stats read.
- The rest of the item was already proven: binary early release at the send boundary and the
  combined request+response budget (`tests/unit/index-admission.test.ts`), refusal and exact-fit
  admission on every handler's converted response path (`*-response-spool.test.ts` suites).

Verified: 37/37 focused admission/event tests (`spool-admission`, `index-admission`,
`spool-events`); the §12 §5.9 checklist line is now checked.

### docs(spool): §5.5 accepts active-ref pinning as the lease contract

The plan sketched a `leaseId` plus a renewal ticker (`ttl_seconds / 3`); the code implements
active-ref pinning, and the plan now says so explicitly rather than leaving the deviation
implicit. The invariants are unchanged — a leased blob is never deleted by TTL, LRU, or the
sweep; the idle clock starts at the final release; failures are loud — but the mechanism is:
the blob hash is the lease identity, the L2 index's `refs` counts the owners sharing the
lease, and renewal is structural because eviction only ever looks at `refs = 0` entries. That
makes "renewal while merely holding an idle blob" unexpressible and removes the renewal
ticker's failure mode; the plan's renewal-failure requirement maps onto the mechanism's own
loud failures (missing/truncated leased file throws, release with no active lease throws).
§5.8's "renew the lease throughout upload/auth fetch" and the §12 lease/failure test items
were reworded to match.

Verified: the evidence the TODO names already exists in `tests/unit/blob-store.test.ts` —
long-lived hold past TTL (`:421`), missing/truncated file refusal (`:341`, `:621`),
final-release idle expiry (`:404`, `:421`), and lease-underflow refusal (`:388`).

### test(spool): transform contracts on ref-bearing bodies — last Rule-B cell measured

`tests/unit/transform-ref-matrix.test.ts` already ran every named builtin and every Tier-1 op
kind against ref-bearing bodies through the real handlers; its header recorded one unmeasured
cell: a *converting* Rule-B send (`postJsonWithSpool` re-detects refs on the outgoing body)
whose transform drops every ref. A new row closes it: Chat→Claude (`chat-completions.ts:110`)
with a `before_upstream` op that replaces `messages[].content` — the converted body holds no
ref, the send degrades to the plain string path (`streamed: false`, no `Content-Length`,
no `duplex`), byte-identical to the same run with spooling off, and the dropped payload is
proven to be the transform's doing (present in the untransformed baseline). The header note
now lists both measured call sites.

Verified: 29/29 in `transform-ref-matrix` + `request-ingress-transform-refs`.

### test(spool): §5.8 auth link — fetch/hash-verification round trip and the no-delete decision

Two integration tests in `tests/unit/index-auth-projection.test.ts` close the auth-link item.
A verifying auth-service double walks the projection's `external_blob` links, fetches each from
a fake object store, and hash/size-verifies the bytes it downloaded:

- success: the proxy's projected link survives exactly that check, the upstream still gets the
  original inline bytes, and the only call the object store ever sees is the auth service's
  `GET` — the proxy issues no `DELETE`, pinning the 2026-11-04 decision that external-object
  lifetime is the store's lifecycle TTL alone (now recorded in §5.8);
- failure: a store that 404s makes the auth service refuse, the client gets 401, the upstream
  is never called, and the leased blob is still released at request end.

The lease-hold evidence was extended to cover the auth fetch itself: the idle sweep runs at
every external call (upload, auth POST, store GET, upstream send) and must expire nothing.

Verified: 9/9 in `index-auth-projection`.

### fix(spool): §5.9 two-class admission — response reads can no longer deadlock behind request waiters

The new concurrent-traffic evidence exposed a hold-and-wait deadlock under a contended
`max_materialized_body_bytes`: a non-ref request holds its materialization reservation through
the attempt loop (the recorded single-parse deviation), and its *response-side* admission — the
attempt loop's stats parse, or a converting handler's response parse — queued FIFO behind
waiting *request* bodies. The waiters needed the lease the in-flight exchange was holding; the
exchange needed the admission the waiters were blocking. Two admitted requests held the budget
until `admission_timeout_ms` fired, and the client got 503s for traffic that should have drained.

`src/utils/spool-admission.ts` now runs two waiter classes on the one budget. Request bodies use
`admitMaterialization` as before; every response-side read uses the new
`admitResponseMaterialization`, which is admitted ahead of queued request bodies whenever its
bytes fit and is drained first on every release. The hard cap, per-class arrival order, the
shared queue cap, and the timeout/abort refusals are unchanged; a response that genuinely does
not fit waits (ahead of the request queue) and can still time out — the honest answer to an
over-committed budget. The SSE-event parse stays request-class: it runs after the request lease
is released, so it queues safely and keeps the plan's "pause upstream reads while waiting"
behavior. The seven response callsites (`passthrough`, `claude`, `chat-completions`, `gemini`
×2, `responses` ×3, `spool-response.ts`, the attempt-loop stats read) were switched; plan §5.9
records the rule.

Tests: three new two-class cases in `spool-admission.test.ts` (jump-when-fits liveness,
drain-response-first on release, per-class arrival order plus shared queue cap), and the
end-to-end regression in `index-concurrent-traffic.test.ts` below.

### fix(spool): concurrent `putBlob` of one new payload no longer loses lease counts

`putBlob`'s "lookup and lease are one atomic operation" was not: the index check and
`index.set(refs: 1)` were separated by the write's `await`s, so N concurrent requests carrying
the *same new* payload all missed the index, all wrote the file, and each set `refs: 1` — last
write won, every caller believed it held a lease, and the Nth release threw
`refs already 0` in the request `finally` (a 500 for traffic that should dedupe). `putBlob` now
gates one in-flight write per hash; racers chain onto the gate and take the ordinary refs+=1
hit once the entry exists, and a failed write lets the next racer retry as writer. Regression:
`index-concurrent-traffic.test.ts` drives eight concurrent identical requests to one stored
blob with every lease returned.

### test(spool): §12 evidence — concurrent traffic, §5.7 predicate matrix, mid-stream failures

- `tests/unit/index-concurrent-traffic.test.ts` (new): a mixed burst of 8 binary + 8 large
  non-ref requests through the real handler, with §5.9 admission enabled-and-contended and
  disabled. Asserts every request is answered, each upstream body carries exactly its own
  request's payload with no ref marker and no cross-contamination, both ledgers return to zero,
  and the extracted blobs are idle-releasable afterwards.
- §5.7 completed-JSON predicate matrix closed: `spool-response.test.ts` gains a
  `responses-image-generation-result` round trip (byte-exact, exact `Content-Length`, scratch
  cleanup) through `createConvertedResponseBody` — the only completed-JSON extraction point
  for that predicate today; `gemini-response-spool.test.ts` gains the Interactions converted
  egress at handler level (extracted image streamed back with exact length, receive spill
  released before the answer, scratch deleted on completion and on client disconnect).
- Mid-stream failure matrix closed: `spool-events.test.ts` gains the missing-file case — a
  scratch blob *deleted* between the envelope and its chunks errors the stream, emits no
  `[DONE]`, cancels upstream, and leaves nothing on disk.
- The §12 checklist lines for §5.4/§5.7 predicates, mid-stream failures, and §5.8 auth links
  are now checked.

### perf(spool): Phase-3 gate measurement — parse is not the top allocator; Phase 3 stays deferred

`tests/perf/parse-transient.ts` (new, `node --expose-gc --import tsx`) measures the §9.2 reopen
condition with real modules: the full-parse window is **~1.3× body** while the end-to-end
per-exchange peak through the handler is **~5.0–5.6× body** (4 MiB inline-image bodies,
4-concurrent burst, distinct payloads) — parse is ~25–27% of the peak, dominated by the
serialize/re-serialize chain and receive buffers. Removing the entire parse window would
reclaim at most a quarter of the peak, so §9.2's reopen condition is not met and Phase 3 (the
lexical scanner) stays deferred; the script is the rerun harness if the serialize chain ever
flattens enough to move parse to the top. Plan §6/§9.2 record the numbers and the caveat that
V8 string slicing can make the parse window read low.

### feat(spool): §5.7 bounds the two identity forwards in `responses.ts`

The passthrough halves of `POST /v1/responses/input_tokens` (`handleResponsesInputTokensRequest`)
and `POST /v1/responses/compact` (`handleResponsesCompactRequest`) hand the upstream `openai-responses`
body straight to the client — they never convert it. Before this change that was literally
`new Response(<upstream>.body, …)`: no receive, no `max_response_bytes`, no spool, and no trace of
the body either, unlike `handleAsPassthrough`'s non-SSE tail next to them.

- Both now use the same identity shape as that tail (and as `chat-completions.ts`'s
  `openai-responses` branch): `receiveResponseBody` once, the client streamed `received.readStream()`.
  Above `threshold_bytes` the body lives in a `responses/` spill while it is received and the client
  is served from disk a chunk at a time, so the client's read pace — not a buffer — bounds what the
  proxy holds; `max_response_bytes` caps the receive, and a breach cancels the upstream body and
  surfaces as a 500 `processing_error` rather than a truncated body. The cap applies with
  `enabled = false`, as on every other receive; the gated-vs-ungated conflict recorded in the Gemini
  and `:countTokens` entries is unchanged.
- The only read either path does is the trace line, so it is now trace-gated and reads the spool
  instead of a second copy: `if (logger.traceEnabled)`, one §5.9 lease around
  `logPipelineStage(... 'upstream-response' ...)`, released before the body is handed to the client.
  With tracing off — the default log level — neither path reads the body at all, and §5.9 is never
  consulted for it.
- Preserved as they were: the hard-coded `status: 200`, the two-header `outHeaders`
  (`Content-Type`, `x-request-id` — upstream headers are still not copied), and the `!response.ok`
  error reads above them, which are unchanged and still unbounded.
- No §5.7 response-binary extraction: these paths never parse the body, so there is no position to
  extract a payload from — the upstream bytes are the client bytes.
- 12 tests in `tests/unit/responses-response-egress.test.ts`, six properties against both sites in
  one table: a body that is not JSON is forwarded verbatim (a parse-and-reserialize would fail it);
  a body above the threshold spills and is served from the spill, which stays live until the client
  has read it; a cap breach is a 500 `processing_error` with the upstream cancelled and nothing on
  disk; the cap is enforced with `enabled = false`; with tracing on, exactly one `[UPSTREAM-RESP]`
  body line carries the upstream bytes and the forwarded body is unchanged by that read; and with
  tracing off a budget one byte short of the charge still serves the response while the same body
  with tracing on is refused 503 `over_limit_error` with no spill and no reservation.

Reported, not fixed: the `!response.ok` error-body reads in this file (`:707`, `:980`, `:1685`,
`:1734`, `:1889`, `:1989`) and `handleAsGemini`'s in-process `claudeResponse.json()`
(`:786`).

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit`
**2431/2431** (0 skipped, 0 todo, 0 cancelled) — 12 of those are this increment's, and the suite was
2419 before them.

### feat(spool): §5.7 bounds the four converted non-SSE reads in `responses.ts`

`src/handlers/responses.ts` answers a Responses client from an `openai-completions` or
`anthropic-messages` upstream by converting the upstream JSON, and none of those four answers is
streamed: `handleAsAnthropicMessages` and `handleAsCompletions` on `POST /v1/responses`, plus the
converting branches of `handleResponsesInputTokensRequest` (`POST /v1/responses/input_tokens`) and
`handleResponsesCompactRequest` (`POST /v1/responses/compact`). All four read the body whole
(`response.text()` or `compactCompletionsResponse.text()`) and then parsed it, so nothing bounded
what the upstream could send.

- All four now use `receiveJsonResponse`, the same receive as `/v1/messages`,
  `/v1/chat/completions` and `openai.ts`'s cross-mode egresses: one bounded receive, one parse, and
  the spill released before the client is answered. Above `threshold_bytes` the body lives in a
  `responses/` spill while it is received and is read back from disk for that parse, so neither the
  body nor a clone of it is held in RAM; `max_response_bytes` caps it, and a breach cancels the
  upstream body and surfaces as a 500 `processing_error` rather than a truncated body handed to
  `JSON.parse`.
- The cap applies with `enabled = false` — the rule the other receives follow. The
  gated-vs-ungated conflict recorded in the Gemini and `:countTokens` entries is unchanged.
- Behaviour change stated rather than hidden: the `handleAsCompletions` read carried a
  `logger.debug(...substring(0, 1000))` preview and an explicit `logPipelineStage`
  `upstream-response` line. `receiveJsonResponse` emits that stage line itself (whole body, at trace
  level), so the explicit call was redundant and is gone; the 1000-character *debug* preview has no
  replacement. `handleAsAnthropicMessages` lost the same pair of lines (its preview was 500
  characters) in the same change.
- No §5.7 response-binary extraction here, deliberately: the allowlist is Gemini
  `inline_data`/`inlineData` parts and Responses `image_generation_call` results, and all four
  readers convert *away* from those shapes before the client body is built — the two Responses
  converters emit `output_text`/`response.compaction` envelopes, and the input_tokens answer is
  `{object, input_tokens}`. There is no converted position holding a payload to extract.
- Reported, not fixed, as the next increment: the passthrough halves of `/input_tokens` (`:1741`)
  and `/compact` (`:1864`) still hand the upstream body straight to the client with
  `new Response(<upstream>.body, …)` — no receive, no cap, no spill — unlike
  `handleAsPassthrough`'s non-SSE tail. Also reported, not fixed: the four `!response.ok` branches
  above these sites still read the upstream error body with `await response.text()` (`:707`,
  `:980`, `:1685`, `:1808`), and `handleAsGemini`'s `claudeResponse.json()` (`:786`) is an
  in-process parse of an already bounded body.
- 28 tests in `tests/unit/responses-response-spool.test.ts`, seven properties against all four
  readers: the converted body (structure and values, clock-minted fields masked) is unchanged under
  the threshold and above it; the spill is observed live mid-receive, released before the response
  is returned, with `Response.prototype.clone` never called; a cap breach is a 500
  `processing_error` with the upstream cancelled and nothing on disk; the cap is enforced with
  `enabled = false`; a malformed upstream body surfaces as a `SyntaxError` with its spill released;
  a §5.9 refusal is a 503 `over_limit_error` that leaves no spill and no reservation; and an
  admitted body is answered converted with the ledger returned to zero. Three of the four expected
  answers keep every echoed field asserted (`id`, `created_at`, `output_text`, `usage`) and mask
  only the synthesized message id; the `created_at`/`id` pair the Claude upstream's own envelope
  mints is masked on the anthropic-messages reader.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit`
**2418/2418** (0 skipped, 0 todo, 0 cancelled) — 2390 of those before this increment's 28. One
earlier run of the same suite reported 2417/2418 with a single failure whose output was not
captured; the next twenty full-suite runs, including the exact interleaving that preceded it, are
2418/2418, and it was not seen again, so that test could not be named.

### feat(spool): §5.7 bounds the three cross-mode non-SSE reads in `openai.ts`

`handleOpenAIRequest` answers a Gemini-shaped client (`/v1/interactions`,
`/v1beta/models/{model}:generateContent`) from three upstream families, and none of those responses
is streamed to the client — the handler parses the upstream JSON, converts it into the Gemini shape,
and sends that. All three read the body whole before this change: an `anthropic-messages` upstream
in `forwardCompletionsAsAnthropicMessages`, an `openai-responses` upstream in
`forwardCompletionsAsOpenAIResponses`, and an `openai-completions` upstream in
`handleOpenAINonStreamingResponse` each called `response.text()` and `JSON.parse`. Nothing bounded
what the upstream sent on any of them.

- All three now use `receiveJsonResponse`, the same receive as `/v1/messages` and
  `/v1/chat/completions`: one bounded receive, one parse, and the spill released before the client
  is answered. Above `threshold_bytes` the body lives in a `responses/` spill while it is received
  and is read back from disk for the parse, i.e. neither the body nor a clone of it is held in RAM;
  `max_response_bytes` caps it, a breach cancels the upstream body and surfaces as a 500
  `processing_error` rather than a truncated body handed to `JSON.parse`.
- `handleOpenAINonStreamingResponse` gained a `signal` parameter, and its call site passes
  `request.signal`, so the §5.9 `admitMaterialization` lease it now takes is released if the client
  aborts while the body is received — the other two sites already reached `originalRequest.signal`.
- The cap applies with `enabled = false` — the eighth follower of the stated rule. The
  gated-vs-ungated conflict recorded in the Gemini and `:countTokens` entries is unchanged.
- No §5.7 response-binary extraction here, deliberately: the allowlist is Gemini
  `inline_data`/`inlineData` parts and Responses `image_generation_call` results, and all three
  egresses convert *away* from those shapes before the client body is built —
  `convertOpenAIToGeminiGenerateContent` emits only `{thought,text}` / `{text}` / `{functionCall}`
  parts, and the two Interaction paths likewise build their content from the converted Completions
  text. There is no converted position holding a payload, so `createConvertedResponseBody`'s tree
  walk would cost a pass over every response for nothing.
- Reported, not fixed: the `!response.ok` branches above these three still read the upstream error
  body with `await response.text()` (`openai.ts:879`, `:1034`, `:1333`), an unbounded copy on the
  error path; and the "fall back to the OpenAI conversion as-is" branches in the two Interaction
  forwarders are unreachable from dispatch (`src/index.ts` routes only the `interactions` and
  `generateContent` client families here, so `isInteractionsRequest || isGenerateContentRequest` is
  always true), so they were left untouched rather than converted.
- 21 tests in `tests/unit/openai-response-spool.test.ts`, seven properties against all three sites:
  the converted body (structure and values, clock fields masked) is unchanged under the threshold
  and above it; the spill is observed live mid-receive, released before the response is returned,
  with `Response.prototype.clone` never called; a cap breach is a 500 `processing_error` with the
  upstream cancelled and nothing on disk; the cap is enforced with `enabled = false`; a malformed
  upstream body surfaces as a `SyntaxError` with its spill released; a §5.9 refusal is a 503
  `over_limit_error` that leaves no spill and no reservation; and an admitted body is answered
  converted with the ledger returned to zero.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit`
**2390/2390** (0 skipped, 0 todo, 0 cancelled) — 2369 of those before this increment's 21.

### feat(spool): §5.7 streams the native `/v1/messages` non-SSE response from its spill

The native `anthropic-messages` egress in `src/handlers/claude.ts` was the last non-streaming
branch on the `/v1/messages` front door that copied a successful response body in full: it never
converts, so the upstream bytes are the client's bytes, and the `response.clone()` it took existed
only to feed two `logPipelineStage` lines that return immediately unless tracing is on. That read
pulled the body into RAM as fast as the upstream could send it, whatever pace the client kept —
§5.7's "do not call `response.clone().text()` or buffer a second copy" verbatim.

- The body is now received bounded with `receiveResponseBody` and forwarded from there:
  `max_response_bytes` applies to it (the upstream cancelled on breach, a 500 `processing_error`
  to the client), a body past `threshold_bytes` lives in a `responses/` spill, and the client is
  answered from `received.readStream()`, so a spilled body is re-read from disk a chunk at a time
  and the client's read pace — not a buffer — bounds what the proxy holds while it is sent.
  `sanitizeUpstreamResponseHeaders` still strips `content-length`, so the forward restates none.
- The trace lines re-read that spill and only when `logger.traceEnabled`; one §5.9
  `admitMaterialization` lease wraps that single read, is released in `finally` before the stream
  is handed to the client, and a refusal releases the received body before it is thrown, so the
  refusal leaves neither bytes on disk nor a reservation on the ledger (#8). A body nobody will
  read is never charged and never refused.
- The cap applies with `enabled = false` — the seventh follower of the stated rule. The
  gated-vs-ungated conflict recorded in the Gemini and `:countTokens` entries is unchanged.
- Reported, not fixed: the `!response.ok` branch above still reads the upstream error body with
  `await response.text()`, an unbounded copy on the error path; and `src/handlers/messages.ts`
  keeps two logging-only `response.clone()` reads (`:487`, `:811`) behind `LOG_LEVEL=debug` plus a
  `test_tool` request, each appending to `/tmp/test_model.log` under a `catch {}` that swallows the
  failure — the remaining shape §5.7's "no logging-only `tee()`" names. Both are outside this
  increment's branch.
- 11 tests in `tests/unit/claude-response-spool.test.ts`: the sub-threshold and over-threshold
  forwards are byte-identical (indented, non-ASCII fixture) with the upstream status and headers
  intact and no restated `content-length`; a cap breach is a 500 `processing_error` with the
  upstream cancelled and nothing on disk; a client abort mid-body frees the spill and the ledger;
  `enabled = false` forwards byte-identically and still enforces the cap; both trace lines carry
  the upstream payload verbatim and leave the body unchanged; an SSE response still passes straight
  through; and the lease's three states are pinned — trace off, the budget is never consulted and
  nothing is admitted; over budget, 503 `over_limit_error` with the spill released; exactly at
  budget, served with nothing admitted while the client reads. `Response.prototype.clone` is
  patched for the file: the call count is zero on every path.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit`
**2369/2369** (0 skipped, 0 todo, 0 cancelled) — 2358 of those before this increment's 11.

### feat(spool): effective and attempt bodies stream from request spills before slow upstream sends

Large non-ref request bodies no longer have to stay as strings while routing, retries, or a
converted upstream send is slow. `src/utils/spool-json.ts` keeps the existing small-body string
path, writes an oversized final JSON body to the request spill store, and streams it back with an
exact `Content-Length`; when conversion preserved BlobRefs, its shared POST path uses the §5.3
serializer instead of spooling a ref skeleton.

- **Effective bodies.** Default and model-route request reconstruction uses
  `createTextEgressBody(bodyText, 'eff-')`, so the post-mutation body is read from disk at the
  point a handler needs it instead of rebuilt into RAM.
- **Attempt bodies.** Composite candidates, auth-ladder retries, fusion panel/judge/synthesis
  requests, `request_ingress` rewrites, and the phase-scoped handler conversion sends use
  `createJsonEgressBody` / `postJsonWithSpool` with `att-` spills. A pre-send fetch failure
  cancels the stream and returns its reservation.
- **Rung isolation and lineage.** Tests prove the effective spill is gone before dispatch, an
  `att-` spill is live during the upstream read, two fallback rungs get independent attempts over
  the same effective body without model-rewrite leakage, and no spill or ledger bytes remain after
  success or failure.
- **Coverage.** `tests/unit/spool-json.test.ts` covers small/large bodies, exact UTF-8 lengths,
  caps, cancel-before-send, fetch rejection, one-time serialization, and a 12-predicate request
  matrix streamed byte-identically through the shared POST path. `index-routing.test.ts` covers
  effective/attempt lineage and two-rung isolation; `messages-ref-streaming.test.ts` covers a
  large non-ref converted attempt against its string-path baseline.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit`
**2358/2358** (0 skipped, 0 todo, 0 cancelled).

### feat(spool): §5.7 spools the `/v1/messages`-via-`:generateContent` and `:countTokens` non-SSE responses

The two readers left in `src/handlers/gemini.ts`. The claude-format branch of
`handleGeminiNonStreamingResponse` is the gap the native-Gemini entry reported:
`response.text()` → `JSON.parse` → convert, with no `max_response_bytes` at all.
`handleGeminiCountTokensRequest` was the same shape one function up, relaying the
upstream body as a string.

- The converted branch now calls `receiveJsonResponse<Record<string, unknown>>`
  — the helper the `/v1/chat/completions` increment promoted into
  `src/utils/spool-response.ts` — so the body is received with
  `max_response_bytes` enforced (the upstream cancelled on breach), parsed once
  under a §5.9 lease, and the spill released before the client is answered. The
  upstream-response trace line still shows the raw upstream bytes, read from that
  same spill; the outbound line still shows the converted message.
- The branch's own `catch` annotated everything it caught as
  `Failed to convert Gemini response: …`. A spool breach (500 `processing_error`)
  and an admission refusal (503 `over_limit_error`) already carry the status and
  type the client switches on, so the `catch` now rethrows a `ClaudeProxyError`
  unchanged and only wraps genuine conversion failures (repo rule #8). A test
  pins the type, the status, and that the message does not carry the conversion
  prefix.
- No `createConvertedResponseBody` here, for the reason already recorded for this
  converter: `convertGeminiGenerateContentToClaude` collects `part.text` only, so
  an `inlineData` part is gone before any converted value exists to extract from.
  The test fixture carries one, and the assertion is that the client receives the
  text alone.
- `:countTokens` became §5.7's identity shape: `receiveResponseBody` then
  `new Response(received.readStream(), …)`. The body is a `{ totalTokens }`
  object, so nothing on §5.7's response allowlist can be in it, there is nothing
  to extract, and — as before this change — no trace line reads it.
- The cap applies with `enabled = false` on both, the fifth and sixth followers of
  the stated rule (`enabled` decides whether disk is used, not whether the body is
  bounded). The gated-vs-ungated conflict flagged in the Gemini entry is
  unchanged and still unreconciled.
- Reported, not fixed: both functions' `!ok` exits (`await response.text()` on a
  non-2xx reply) are still unbounded, like every other handler's. They carry the
  upstream's error envelope, not a §5.7-allowlisted payload.
- Tests: `tests/unit/gemini-converted-response-spool.test.ts`, 10 cases. The
  converted path: a sub-threshold body converted to the exact Claude message the
  fixture implies (indented non-ASCII text preserved, `inlineData` dropped,
  clock-derived `id` masked), no spill, and `Response.prototype.clone` patched and
  asserted unused; a spilled body whose spill is already gone when the answer
  exists; a breach failing `SpoolResponseTooLargeError` with the upstream
  cancelled and the error type intact; the cap enforced with `enabled = false`;
  the trace reading the spill without changing the answer; the §5.9 refusal
  (one nominal byte short of the budget → 503, no spill, no reservation) and the
  admitted counterpart releasing its lease before the client reads. The identity
  path: a spilled `:countTokens` body forwarded byte-identically and freed by the
  client's read, a breach cancelling the upstream, and `enabled = false` writing
  nothing to disk.
- 2357 unit tests pass (2347 before, +10); `tsc --noEmit` clean; `npm run build`
  clean.

### feat(spool): §5.7 spools the non-SSE `/v1/chat/completions` response — converted and identity

The last Phase‑2 endpoint family whose non-streaming exit still read its upstream
body unbounded. `/v1/chat/completions` — and `/v1/completions`, which routes to the
same handler — answers from three upstream modes without streaming, and none of
them was bounded: the `anthropic-messages` branch called `response.text()` and
parsed it, the `gemini-generatecontent` branch did the same, and the
`openai-responses` branch piped the upstream body straight to the client through
an `observeStream` transform, so a passthrough response had no cap at all.

- `src/utils/spool-response.ts`: `receiveJsonResponse` moved here from
  `src/handlers/messages.ts`, unchanged, and is now exported. It was written there
  as a private helper with one caller; this increment brings three more, so it is
  defined once rather than copied (repo rule #4). `messages.ts` imports it and its
  nine cases still pass unmodified. The *other* inline copies of the same
  receive-and-materialize sequence (five sites: `index.ts`'s stats read,
  `spool-events.ts`, `passthrough.ts`, `gemini.ts` twice, `responses.ts`) are
  untouched: each is shaped for its own handler and folding them together is a
  larger change than this increment, so it is proposed rather than done.
- The two converted branches now use that helper: receive with
  `max_response_bytes` enforced, §5.9 lease on the received size, parse once, spill
  released in `finally` before the client is answered. The cap applies with
  `enabled = false`, the fourth follower of the stated rule (`enabled` decides
  whether disk is used, not whether the body is bounded); the gated-vs-ungated
  conflict flagged in the Gemini entry is unchanged and still unreconciled.
- Deliberately no `createConvertedResponseBody` on either, and the reasons differ:
  a Claude body's image blocks are not on §5.7's response allowlist (only Gemini
  `inline_data` and Responses `image_generation_call` are), and the Gemini branch
  never has an allowlisted position to extract because
  `convertGeminiGenerateContentToClaude` keeps only `part.text` and drops
  `inline_data` before any converted value exists
  (`src/converters/gemini-to-claude.ts:189-200`, pre-existing). The second reason is
  now pinned by a test case rather than left to the comment: a Gemini response
  carrying both a text part and an `inlineData` part reaches the client as the text
  alone.
- The `openai-responses` branch became §5.7's identity shape:
  `receiveResponseBody` then `new Response(received.readStream(), …)`, with the
  trace line reading that same spool under a §5.9 lease instead of the old
  `observeStream` transform. Two consequences, stated rather than hidden: the body
  is now fully received before the client sees its first byte (exactly what
  `/passthrough` has done since its own increment), and an upstream error body past
  `max_response_bytes` is answered 500 instead of being forwarded — the identity
  egresses' existing behaviour. No extraction here either: identity forwarding
  relays whatever the upstream sent, including an `image_generation_call` result
  the client's own route asked for as-is.
- §5.9 note: on the converted branches the request's lease is held across the send,
  so the response is admitted beside it — the behaviour the `/v1/messages`
  increment introduced and pinned in `tests/unit/index-admission.test.ts`. Those
  pins already budget both sides, so nothing moved here.
- Reported, not fixed: the two converted branches' `!ok` exits
  (`await upstreamResponse.text()` on a non-2xx reply) are still unbounded, like the
  `/v1/messages` error exits. They carry the upstream's error envelope, not a
  §5.7-allowlisted payload.
- Tests: `tests/unit/chat-completions-response-spool.test.ts`, 10 cases. The
  converted path: a sub-threshold body converted exactly, writing no spill and never
  calling `Response.prototype.clone` (patched and asserted); a spilled one on disk
  mid-receive for exactly `chunks[0].byteLength` bytes and gone before the answer
  exists, with that answer equal to the un-spooled baseline; a body past
  `max_response_bytes` failing `SpoolResponseTooLargeError` (500
  `processing_error`) with a spill provably live at the breach and the upstream
  cancelled; the cap enforced with `enabled = false`; the Gemini branch's
  `inline_data` drop pinned. The identity path: a spilled body forwarded
  byte-identically from the spool and freed once the client has taken it, the cap
  enforced with spilling off, and the §5.9 pair — a trace read one byte short of
  `ceil(bytes × factor)` refused as 503 `over_limit_error` with no spill and no
  queue slot, an admitted one forwarded unchanged with the lease returned. 2347
  unit tests pass (2337 before, +10); `tsc --noEmit` clean; `npm run build` clean.

### feat(spool): §5.7 spools the non-SSE `/v1/messages` response, the last unbounded reader on that family

Every non-streaming exit of the `/v1/messages` handler read its upstream body with
`await response.text()`: the two Claude-client conversions that target an OpenAI
upstream (an `openai-completions` one and an `openai-responses` one) and the
already-OpenAI branch's conversion. Those bytes were held whole, twice — the
string, then the parsed object — with no `max_response_bytes` anywhere on the
path, which for a converted response carrying an image is the payload §5.7's
allowlist cares about surviving intact.

- `src/handlers/messages.ts`: all three now go through one new helper,
  `receiveJsonResponse`, which receives with `receiveResponseBody(response.body)`
  — spilled past `threshold_bytes`, capped by `max_response_bytes` — takes a §5.9
  `admitMaterialization` lease on the received size, parses the body once, and
  releases both lease and spill in `finally`. The client is sent the *converted*
  body, never these bytes, so nothing of the spool survives the call: `readText()`
  leaving a live spool readable is not relied on here.
- The cap applies with `enabled = false`, following the stated rule that
  "`enabled` only decides whether disk is used" — the third branch to do so, after
  the Interactions egress and the native Gemini one, and consistent with
  `passthrough.ts`/`responses.ts`. The conflict flagged in the Gemini entry is
  unchanged and still unreconciled: the SSE framing and the router's stats read
  gate the same receive on `enabled`. This increment adds a third follower of the
  general rule rather than resolving it.
- The receive sits outside `handleNonStreamingResponse`'s converting `try`/`catch`
  on purpose: that catch re-wraps everything as `Failed to convert response: …`, so
  a `SpoolResponseTooLargeError` raised inside it would have lost its 500
  `processing_error` type. `handleNonStreamingResponse` gained a trailing
  `signal?: AbortSignal` and both call sites pass `request.signal`. Behaviour
  change stated rather than hidden: an upstream body that is not valid JSON now
  surfaces as the parser's `SyntaxError` (still 500) instead of the conversion
  wrapper's message.
- No `createConvertedResponseBody` on this path, deliberately: §5.7's response
  allowlist covers Gemini `inline_data` and Responses `image_generation_call`
  only — Claude assistant image blocks are not on it — so a converted
  `/v1/messages` response has no payload to extract, and calling the extractor
  would be a no-op step added for symmetry.
- §5.9 consequence, stated because it is new on this route: for a body with
  nothing to extract the request's lease is held across the send, so its own
  response is now admitted beside it and a budget sized to the request alone
  refuses that response 503 `over_limit_error` after `admission_timeout_ms`. The
  Gemini Interactions egress already behaves this way (its case asserts the 503);
  the plan's "large non-ref responses use the same rule" is what makes it a rule.
  Three pins in `tests/unit/index-admission.test.ts` moved for it and say so in
  place: the disabled-store case, the queue/timeout case and the parse-failure
  case now budget the request's charge *plus* its response's (the second case
  keeps discriminating because the queued body's charge exceeds the response's).
- Reported, not fixed: the upstream *error*-body reads at the same handler's three
  error exits (`await response.text()` on a non-2xx upstream reply) are still
  unbounded. They carry the upstream's error envelope, not a §5.7-allowlisted
  payload, and are copied verbatim into the client's error, so bounding them is a
  change to error reporting rather than a spool change.
- Tests: `tests/unit/messages-response-spool.test.ts`, 9 cases. A sub-threshold
  body is served exactly as the conversion produces it, writes no spill file, and
  never calls `Response.prototype.clone` (patched and asserted); a spilled one is
  on disk mid-receive for exactly `chunks[0].byteLength` bytes, the spill is gone
  by the time the client's answer exists, and that answer is byte-equal to the
  un-spooled baseline. A body past `max_response_bytes` fails
  `SpoolResponseTooLargeError` (500 `processing_error`) with a spill provably live
  at the breach, the upstream body cancelled and no file or reservation left;
  the cap is asserted enforced with `enabled = false`; an unparseable body raises
  `SyntaxError` holding no spill. Both `openai-responses` egresses are covered for
  the cap too, for a Claude-format and an OpenAI-format client. The §5.9 pair
  pins a refusal one byte short of `ceil(bytes × factor)` as 503
  `over_limit_error` with no upstream call and no spill, and an admitted body
  served unchanged with the lease returned. 2337 unit tests pass (2328 before,
  +9); `tsc --noEmit` clean; `npm run build` clean.

### feat(spool): §5.7 spools the native Gemini `:generateContent` response — the inline-data egress

§5.7's response allowlist names one payload above all others: the `inlineData`
image, audio or video part a native Gemini model generates. That is precisely the
body the proxy was reading whole. `handleGeminiNonStreamingResponse` did
`await response.text()` and handed the resulting string to `new Response`, so a
base64 payload existed twice in RAM — the string, plus the response's own copy of
it — with no `max_response_bytes` anywhere on the path.

- `src/handlers/gemini.ts`: the native branch is now `relayNativeGeminiResponse`,
  which receives the upstream body with `receiveResponseBody(response.body)` —
  spilled past `threshold_bytes`, capped by `max_response_bytes` — and answers the
  client with `new Response(received.readStream(), …)`, so the client's own pace
  bounds what the proxy holds. The branch still never parses, so the upstream
  bytes are the client's bytes: `status` and the `Content-Type`/`x-request-id`
  headers are unchanged and the `inlineData` part crosses byte-identical.
- Moving the native branch out of the enclosing converting `try`/`catch` is part
  of the change, not tidying: that catch re-wraps everything into a generic
  `Error`, so a `SpoolResponseTooLargeError` raised on the new path would have
  lost its 500 and its `processing_error` type on the way out.
- The trace line is the only read this branch performs, so the §5.9 lease is
  taken only when `traceEnabled` materializes the body, and it is released in
  `finally` before the client's copy is handed out — a body nobody reads is never
  charged and never refused. `readText()` leaves a live spool readable, so the
  trace read does not consume the bytes the client is about to receive.
- **The cap applies with `enabled = false`, and here the codebase disagrees with
  itself.** This branch follows the rule stated for the response path —
  "`max_response_bytes` is enforced whether or not spooling is enabled, matching
  ingress: the cap is a body bound, `enabled` only decides whether disk is used" —
  as the Interactions branch in the same file, `passthrough.ts` and
  `responses.ts` already do, so a response past the cap now fails 500
  `processing_error` instead of being forwarded. Two later wirings gate the same
  receive on `getSpoolConfig().enabled` instead: the SSE framing (where the reason
  is different — gating avoids a per-event copy, not the cap) and the router's
  stats read, whose entry argues that routing the disabled case through the
  receive "would newly cap bodies the disabled spool is documented to treat
  exactly as before". Both readings are written down and they cannot both be
  right. This increment follows the general stated rule; the conflict is flagged
  rather than resolved, and flipping this branch to the gated reading is one
  condition.
- Not covered here, and reported as a gap rather than fixed: the `claude-format`
  branch of the same function still does `await response.text()` with no cap. It
  routes through `convertGeminiGenerateContentToClaude`, which keeps only
  `part.text` and silently drops every `inlineData` part, so it cannot carry a
  §5.7-allowlisted payload today — that silent image loss is pre-existing and left
  as it is.
- Tests: `tests/unit/gemini-response-spool.test.ts`, 9 cases. A sub-threshold body
  and a spilled one are both byte-identical to the upstream by sha256 with the
  `inlineData` payload intact (the fixture is indented and non-ASCII, so a
  re-serialize or a re-encode would fail it); the spilled one is charged to the
  ledger for exactly its length, with `Response.prototype.clone` patched and
  asserted never called, the file and the reservation gone once the client has
  read it; a client abort frees the spill; a body past `max_response_bytes` fails
  `SpoolResponseTooLargeError` (500 `processing_error`) with the upstream body
  cancelled and no partial spill; `enabled = false` forwards byte-identically and
  writes nothing, while still enforcing the cap; and tracing reads the body back
  out of the spill without changing a byte the client receives. The §5.9 pair pins
  that the budget is the trace read's: a charge one byte short of the budget is
  refused 503 `over_limit_error` with tracing on and served 200 with it off.
  2328 unit tests pass (2319 before, +9); `tsc --noEmit` clean; `npm run build`
  clean.

### feat(spool): §5.7 spools the router's JSON stats read instead of cloning the body

§5.7's "do not call `response.clone().text()` or buffer a second copy" had one
live exemption left: `runAttempt` in `src/index.ts` read every completed
`application/json` response with `response.clone().json()` for the usage and
tool-name stats. A clone keeps every remaining byte of the upstream body alive
while the clone is parsed, so a response carrying an image paid for its whole
base64 payload twice — the one copy the plan calls out by name, on the path that
runs for every non-streaming JSON response.

- `src/index.ts`: with `[spool] enabled = true` the stats read now uses the same
  bounded receive path as the other response egresses — `receiveResponseBody`
  (spills past `threshold_bytes`, capped by `max_response_bytes`) plus one
  `readText()` parse — and the client's copy is `received.readStream()` over that
  same spool, with `status` and headers preserved. The §5.9
  `admitMaterialization` lease is taken on the received byte count after the
  body is in hand, released in `finally` before the body is handed to the
  client, and a refusal releases the received body first, so nothing is
  charged during the client's read (same shape as `passthrough.ts` /
  `gemini.ts`).
- With the spool off, the pre-spool `response.clone().json()` path is unchanged.
  This is deliberate rather than blended: §5.7 is the spool's behaviour, and
  `receiveSpooledBody` enforces `max_response_bytes` whether or not `enabled` is
  set, so routing the disabled case through it would newly cap bodies the
  disabled spool is documented to treat exactly as before. Consequence, stated
  rather than hidden: the response-side admission charge exists only while the
  spool is on (the request-side charge is unaffected).
- A body advertised as JSON that does not parse is forwarded as it is and
  yields no stats, exactly as the clone path did; the error is not swallowed
  because there is none — the bytes reach the client either way.
- Behaviour change, from §5.7's "on breach cancel upstream and fail explicitly,
  never truncate": a JSON response body past `max_response_bytes` now fails with
  `SpoolResponseTooLargeError` (500 `processing_error`) instead of being parsed
  and forwarded whole. It surfaces as the attempt's failure, which the target
  ladder classifies as retryable (5xx), the same as the other response egresses'
  cap errors.
- Tests: two new cases in `tests/unit/index-routing.test.ts` — a response past
  `threshold_bytes` whose body is on disk (one file in `responses/`) with
  `Response.prototype.clone` patched and asserted never called, the client's
  text byte-identical, the spill and its disk reservation gone after the read;
  and a body past `max_response_bytes` failing 500 `processing_error` with no
  spill left behind. Two existing pins moved for the new wiring, both stated in
  place: `tests/unit/index-admission.test.ts`'s "holds the configured charge
  across the sidecars" now budgets the request's charge *plus* its response's
  (the response draws on the same §5.9 ledger now, and one byte less queues it),
  and `tests/unit/index-routing.test.ts`'s spool-image case samples its
  `SpoolBody.readBytes` counter at the send, since the response's stats read is
  a spool read of its own after it. 2319 unit tests pass; `tsc --noEmit` clean.

### feat(spool): §5.4 token counting understands a ref wherever it sits, so the last live shape-2 rung streams

§5.9's per-rung rule — "a non-ref rung that starts from an effective spool
acquires a fresh reservation before parsing/conversion and releases it after its
attempt spool is complete" — cost one re-materialization that the rest of the
implementation had already made unnecessary: `messages.ts`'s already-OpenAI
branch expanded its refs as its first act, and only because the token counter
could not count them where they were. Closing that consumer contract removes the
expansion rather than charging for it, so the last live request-body
re-materialization is gone.

- `src/utils/token-counting.ts`: the `default:` branch of the block counter — a
  block with no Claude `type` discriminator, i.e. a Chat `image_url`, a Gemini
  `inline_data` or a Responses `image`-slice — now counts every ref it holds by
  §5.3's own rule (`Math.ceil(ref.size / charactersPerToken)`, `ref.size` being
  the payload's base64 character length) *on top of* the block's JSON text, which
  measures the ref's metadata object instead. Without it the payload counted as
  nothing: the invisible undercount §9.3 rejects, and one that
  `estimateInputTokens` turns into a zero for the whole request.
- **Behaviour change, surfaced rather than blended (rule 5).** `refuseUncountedRefs`
  is deleted: a refusal became a counted approximation. The reasoning, recorded
  because it is the one place this increment weakens a guard — the refusal was
  never loud on a live path. Both callers of `countClaudeRequestTokens`
  (`src/converters/openai-to-claude.ts`, `src/handlers/messages.ts`) wrap it in
  `try/catch → 0`, so refusing an untyped ref produced a silent zero rather than
  an error. A *malformed* ref still fails loud: `countRefTokens` asserts the shape
  first (`assertRefShape`), so `{size: 1.5}` throws `BlobStoreError` — pinned by
  test.
- `src/handlers/messages.ts`: the already-OpenAI branch no longer calls
  `rehydrateInlineBlobs`. The body keeps the ref in the field the client spelled
  it in, the ingress hook sees it, and the send re-detects refs on the outgoing
  body (`postJsonWithSpool`) and streams each payload at its own offset — §5.3
  shape 3. The only expansion left in that handler is the `sdk://` branch, which
  answers 501 before its handler reads the body.
- Tests: `tests/unit/token-counting.test.ts` — the refusal case replaced by three:
  the same ref counted at three positions (Chat `image_url`, Gemini
  `inline_data`, Responses `inline`), an exact structural assertion that the count
  is `ceil(size/4)` plus the block's own text and nothing else; a growth assertion
  that two refs of equal JSON length but different recorded size differ by exactly
  one token (sizes 4000/4004, so the JSON text stays the same length); and a
  malformed ref still throwing `BlobStoreError`. `tests/unit/messages-ref-streaming.test.ts`
  — the already-OpenAI shape-2 case replaced by a shape-3 one: the streamed body
  is byte-identical to the same send with the payload inline, `Content-Length` is
  the exact byte count, `duplex: 'half'`, no ref marker upstream, and the payload
  lands back in the field the client wrote (`image_url.url`).
- Two suites that had pinned the removed behaviour were updated to the measured
  one, not the other way round: `tests/unit/transform-ref-matrix.test.ts` row 19
  (already-OpenAI rung under a `before_upstream` rename) and
  `tests/unit/request-ingress-transform-refs.test.ts` case 1 (`request_ingress`
  op that leaves the ref in place) both flip `streamed` to `true`. The ingress
  suite's drop case stays `false` and is now named as the one measured instance of
  the matrix header's open cell (Rule B — shape decided from the outgoing body —
  with a transform that removes every ref), which the converting Rule-B sends
  still leave unmeasured.
- Comments corrected where they documented the expansion that is gone:
  `src/index.ts` (4 sites), `src/utils/blob-refs.ts`, `src/utils/ref-serializer.ts`,
  `src/utils/spool-admission.ts` ("§5.9's per-rung re-acquisition has no caller
  today"), and the headers of the two suites above plus
  `tests/unit/handler-ref-expansion.test.ts` and
  `tests/unit/responses-ref-streaming.test.ts`. Stale `src/index.ts` line
  references in three files were re-anchored to the extraction pass (`:1424`) and
  the `request_ingress` hook (`:2388`).
- One expectation left where it was: no handler-level assertion that reported
  input tokens are ref-derived. The mocked upstream supplies its own `usage`, so
  the local count is not observable through the response — the counter's own suite
  is the evidence, and an end-to-end version of it is not available yet.

### test(spool): §5.4 transform contracts — a payload position is opaque, and a refused path is reported

§5.4's mandate — "validation, token counting, privacy filtering, compression, and
transforms either run before extraction or understand refs" — read as a contract
rather than as prose, and pinned where nothing pinned it. No production behaviour
changed: this is the evidence, plus two comments that no longer described the
code they sat on.

- `tests/unit/request-ingress-transform-refs.test.ts`, 8 cases:
  - The load-time schema refuses every §5.4 payload position by position, not by
    an incidental error: `messages[].content[].source.data`,
    `messages[].content[].image_url.url` and `contents[].parts[].inline_data.data`
    each yield exactly one `unknown path` against their own schema, while the
    nearest legal neighbours (the `messages[].content` subtree, and a scalar
    beside it) validate clean. `$response.choices[].message.role` reaches the
    *other* branch — listed by the schema but not walkable by the engine — so both
    messages are live and a reader can tell which one fired.
  - Refused is not blocked, and that is the part worth knowing: `parseSimpleToml`
    records the errors (`config_errors`) instead of throwing, so the op reaches the
    engine anyway, where a deep `set` writes a literal key
    (`message['content[].source.data']`) beside an untouched payload. A transform
    can therefore neither read nor write a payload — the §5.4 property holds, but
    by degradation rather than by enforcement.
  - `request_ingress` runs on a body that is already refs. Measured through the
    real proxy against a mocked upstream: with spooling on the store holds the
    payload at the moment of the send (`diskEntries === 1`) even when the ingress
    op discarded the only ref, and the upstream bytes are byte-identical to the
    same run with spooling off — both for an op that leaves the ref alone and for
    one that replaces its container. Stated in the file's header rather than left
    implied: a hypothetical pre-hook rehydration is indistinguishable from
    outside, so the ordering rests on `src/index.ts:1424` → `:2388` plus that
    send-time count, not on a black-box difference.
- Comments corrected to match the sends they describe: `src/index.ts` (the ref
  invariant now names the `request_ingress` hook, which runs *between* extraction
  and the handler, and the shape-3 sends that keep their refs, instead of
  claiming every handler expands) and `src/handlers/responses.ts` (the three
  converting branches no longer "expand the refs back into payloads as their first
  act" — they carry the ref through `isBlobRef`-aware converters and the send
  streams it; `postJsonWithSpool` re-detects, and the Gemini branch's synthetic
  request is re-parsed by a handler that decides for itself).
- Reported rather than fixed, pending a decision (rule 5):
  `src/utils/request-transform.ts:496-499` still says the validator accepts
  payload-level paths — it does not, now that `isPathWalkable` exists. Two
  unrelated defects found while establishing the above and left alone: a TOML
  inline op cannot `map_value` a JSON number (the inline parser reads quoted
  values only, and the comparison is a strict `===`), and an unquoted inline
  scalar is coerced to `""` rather than erroring.

### feat(spool): §5.9 gives the request reservation back once its binary is refs

§5.9's admission lifetime, read literally for the first time: "binary reduced to
refs: release after extraction". The request lease used to be held from the
receive of the body to the request's `finally`, so under a
`max_materialized_body_bytes` sized for one body at a time, an image request
could not admit *its own response* — the reservation it was still holding was
the response's competition, and the exchange timed out at `admission_timeout_ms`
into a 503.

- `src/index.ts` returns `materializationLease` at the send boundary, once
  `bodyText` and the parsed body carry refs instead of payloads rather than after
  the response has been built. The condition is
  `inlineExtraction.refs > 0 && inlineExtraction.skipped === 0`: a body that kept
  a payload inline because JSON would escape it (§5.3's `skipped`) still
  materializes binary and stays charged, and a body with no allowlisted payload
  materializes in full for the whole request — under-charging is the one
  direction this budget must not fail in (repo rule #8).
- The release is a request-path release only. The `finally` keeps its call as the
  idempotent backstop for every other path (parse failure, refusal, early
  return), so nothing depends on reaching the boundary.
- Known uncharged remainder, stated rather than left implicit: the three §5.3
  shape-2 branches (`claude.ts`, and `messages.ts`'s sdk-URL and already-OpenAI
  paths) expand refs back into their parsed body, so on those routes a payload is
  live again with no reservation under it. It is bounded by the body's own
  admitted size, and §5.9's per-rung re-acquisition is what removes it.
  `src/utils/spool-admission.ts`'s wiring-status comment now names that and the
  four response-side callers. (Superseded by the §5.4 token-counting entry above:
  the already-OpenAI path keeps its refs and streams them, so two of those three
  branches are gone — only the `sdk://` branches expand.)
- `tests/unit/index-admission.test.ts`: the charge is sampled at the upstream
  call for a ref-bearing image body (0 — the payloads are refs by then, and the
  payload still reached the upstream) against a same-budget body with nothing to
  extract (held in full); and end to end on `/v1/interactions` with a Gemini
  route, where a budget of exactly one request's charge now admits that
  request's own response (200, converted body intact) where a non-ref body of the
  same shape still queues and is refused 503 `over_limit_error` after 60 ms.

### test(spool): §10 request-predicate round-trip matrix, every front door × upstream mode

The request half of §10's "Binary allowlist round-trip matrix", and the evidence
§12 asks for: "Every §5.4 request predicate has round-trip and mid-stream
retention evidence". No production code changed — the rows below are what the
converted egress already does, now pinned.

- `tests/unit/request-ref-matrix.test.ts`: 27 new cases driving the real
  front-door handlers (`/v1/messages`, `/v1/chat/completions`,
  `/v1/interactions`, `/v1beta/models/*:generateContent`, `/v1/responses` and
  its `/compact` and `/input_tokens` sub-paths) against every upstream mode each
  can be converted to — 26 combinations plus one above-threshold case.
- Each row runs the *same* request twice: once with the payloads spilled to real
  refs through a live spool, once with spooling off so the converter sees the
  client's own bytes. `streamed upstream bytes equal the in-memory conversion
  baseline` (§10) is asserted as exact string equality of the two upstream
  bodies, so a serializer that dropped, re-escaped, reordered or truncated a
  payload fails even though the JSON still parses. The ref run must also contain
  no `BLOB_REF_MARKER`, carry each payload the client sent, and release its
  leases.
- The egress shape is asserted per row, not inferred: a streamed send must
  declare `Content-Length` equal to its exact byte count and `duplex: 'half'`;
  a non-streamed send must declare neither. 24 of the 26 rows are §5.3 shape 3;
  the two `interactions→{anthropic-messages,openai-responses}` rows are shape 2
  because `convertGeminiInteractionsToOpenAI` drops the Gemini parts before any
  send. Six rows carry payloads a converter discards (Claude `document` blocks,
  Chat `input_audio`/`file`, Responses `input_file`/inline skill on some
  targets, and all Gemini parts on those two OpenAI-family targets); each is
  asserted absent from *both* runs, so the loss is pinned as converter-level and
  cannot start hiding behind the spool. Those are pre-existing data-loss bugs,
  reported here rather than fixed (repo rule #8).
- §10's "a payload above the spill threshold" is covered per position by
  `tests/unit/blob-refs.test.ts`'s 12-position matrix and end to end by the last
  case here: a payload above `threshold_bytes` and several 64 KiB read chunks
  wide, on a path whose converter rewrites the envelope into a `data:` URL — so
  the emitted JSON has to hold a prefix the ref does not, one chunk at a time.
- Verified by mutation: adding one byte to the serializer's text emission fails
  25 of the 27 rows (the two survivors are exactly the shape-2 rows, whose refs
  never reach the serializer — an independent confirmation of that diagnosis).

### feat(spool): §5.7 identity non-SSE response egress on `/v1/responses`

The `/v1/responses` passthrough branch now forwards its non-streaming upstream
body from a bounded spool instead of reading it whole. §5.7's "identity
forwarding may stream the original response spool directly without parsing" and
"do not call `response.clone().text()` or buffer a second copy".

- `src/handlers/responses.ts` (`handleAsPassthrough`): the non-SSE tail used to
  `await response.text()`, log it, and hand that same string back as the client
  body — a full extra copy of the response, held for a trace line the default
  log level discards, with no `max_response_bytes` on the path. The body is now
  received with `receiveResponseBody` (spilling above `threshold_bytes`, capped
  by `max_response_bytes`) and the client gets `received.readStream()`: the
  write pace, not a buffer, bounds what the proxy holds. `Content-Length` is
  still not declared — the client response headers are unchanged.
- The pipeline trace re-reads the spool and only when `logger.traceEnabled`, so
  the `UPSTREAM-RESP` body line is byte-for-byte what it was and tracing off
  costs no read at all. This is the convention the request side already follows
  (`src/handlers/passthrough.ts`).
- §5.9 admission (`max_materialized_body_bytes`, off by default) is taken around
  that trace read and nowhere else: the lease is acquired after the body is
  received and released in `finally` before the client is handed the stream, and
  a refusal releases the received body and throws `AdmissionOverBudgetError`
  (503 `over_limit_error`) with no spill and no reservation left behind. A
  response nobody reads is never charged and never refused.
- A bodyless upstream response (`response.body === null`) keeps returning an
  empty body without touching the spool; the streaming branch, the error path
  and the header set are untouched.
- Tests: 11 new cases in `tests/unit/responses-response-egress.test.ts` — bytes
  below and above `threshold_bytes` forwarded identically (sha256 against the
  upstream bytes, with a non-ASCII, indented fixture so re-serialization would
  show), a non-JSON upstream body forwarded verbatim, the spill charged while in
  flight and gone after the last byte, the trace body still logged in full and
  the client body unchanged by that read, a bodyless response, a body past
  `max_response_bytes` failing with `SpoolResponseTooLargeError` (500
  `processing_error`) and cancelling the upstream body, a client abort freeing
  the spill, a spill that ends short reporting `SpoolWriteError` without sending
  a byte, and the three admission cases (not charged when unread, refused one
  nominal byte past the budget, held at exactly `ceil(bytes × factor)` across the
  trace read and released before the client reads). Six of the eleven fail
  against the previous implementation, which is what says they are about this
  change.
- Scope: this is the identity half of §5.7's non-SSE response egress, on the one
  branch that never converts. `/v1/responses/compact` already hands the upstream
  stream straight through without reading it, so it has no copy to remove and no
  materialization for `max_materialized_body_bytes` to admit; it is left alone
  deliberately. The converted egresses that still read whole response bodies —
  `responses.ts`'s three conversions, `messages.ts`, `openai.ts`, `gemini.ts`'s
  other branches — remain unwired, and the P1 item "Extend shape-3 to remaining
  request conversions" is still open.

### feat(spool): §5.7 converted non-SSE response egress

A converted response whose payloads were extracted now leaves the proxy as the
JSON skeleton interleaved with the payload's blob chunks, instead of one
`JSON.stringify` of everything. §5.7's "a converted response is fully parsed,
runs consumers that need original bytes, extracts response blobs, and streams
the small transformed JSON skeleton plus blob chunks to the client".

- `src/utils/spool-response.ts` gains `createConvertedResponseBody(value)`
  (`ConvertedResponseBody`): it takes the already-transformed value — the
  handler keeps owning receive, admit, parse and its consumers, as
  `passthrough.ts` does — extracts the §5.7 response allowlist into a
  per-response `ResponseBlobStore`, and returns either the plain JSON string
  (nothing extracted, or `[spool] enabled = false`) or the skeleton stream with
  the exact `Content-Length` the serializer measured. Extraction failure, or a
  payload `JSON.stringify` would have to escape, leaves the bytes unchanged.
- `src/utils/ref-serializer.ts` gains an optional `onDrained` hook on
  `createRefAwareJsonBody`: it runs exactly once on every terminal path (last
  byte handed over, consumer cancel, short body, failed blob read) and only
  after the generator's read handle is closed — the §5.5 ordering — so the
  egress releases its refs and deletes the scratch store there. The SSE path
  passes no hook and is unchanged.
- First caller: `src/handlers/gemini.ts`'s Interactions non-streaming egress.
  The upstream body is received through `receiveResponseBody` (§5.7's
  `max_response_bytes` cap), admitted with one `admitMaterialization(size,
  signal)` lease that is released in `finally` before the client write (the
  body is released first when admission refuses), parsed, converted, and sent
  with `Content-Length` only when it is a stream. The error path and the
  streaming branch are untouched.
- Tests: 7 new cases in `tests/unit/spool-response.test.ts` — a 200 KB Gemini
  inline image delivered byte for byte (sha256 equal to the pre-extraction
  serialization, exact `Content-Length`, several chunks, no `$spoolBlob` marker
  on the wire), the scratch file named for the payload's sha256 and sized to it
  while in flight and gone after the last byte, cancel mid-payload deleting it,
  a payload-free response staying a plain string, two identical payloads as one
  file and two leases, a deleted scratch file failing the body instead of
  sending bytes without it, an ineligible (escaped) payload staying inline and
  round-tripping, and `enabled = false` returning the plain string without ever
  constructing the store. `getBlobStoreStats()` stays at zero throughout: a
  response payload never reaches the cross-request cache.
- Scope: this is the converted response mechanism plus its first caller (Gemini
  Interactions). The remaining egresses that still read whole response bodies —
  `src/handlers/responses.ts`'s three conversions (its identity passthrough's
  non-SSE branch streams its spool unparsed since the entry above),
  `src/handlers/messages.ts`, `src/handlers/openai.ts`,
  `src/handlers/gemini.ts`'s other branches, and the smaller handlers — are not
  wired yet; no converter in `src/` constructs a Responses `image_generation_call`
  item, so the identity passthrough is where that payload actually arrives today.

### feat(spool): §5.7 binary payload extraction in the SSE event pipeline

A spilled SSE event is now inspected for the response allowlist (Gemini
`inlineData.data`, Responses `image_generation_call.result`), its payload moved
into a per-event scratch blob, and the event written back out as the original
envelope interleaved with the payload's chunks. §5.7's "extract allowlisted
binary payloads, replace them with refs, and emit the event skeleton interleaved
with blob chunks", applied to the one event that actually spilled — never to the
stream.

- `src/utils/spool-events.ts` gains `locateEventPayload` (the byte span of a
  single-line JSON `data:` payload), `spliceEvent` (prefix from the event text,
  payload chunks from the store, suffix from the event text, then cleanup), and
  `prepareEvent`, called from the pull loop for each spilled event. Only the
  payload's own span is replaced, so the envelope — `event:`, `id:`, comments,
  spacing, terminator — and every byte outside the payload are the upstream byte
  by construction; the client receives the same base64 it would have received
  unspooled. Small events, `\r` line endings, two-`data:`-line events, non-UTF-8
  bytes and non-JSON data all replay their spill unread, byte for byte.
- Cleanup order follows §5.5: the serializer's file handle is closed
  (`reader.cancel()`) before the refs are released, the event spill returned to
  the ledger and the store's scheduled unlinks awaited. A client disconnect
  mid-event, a failed read or a failed parse all take the same path; `dispose()`'s
  `leaked` count is reported when a lease is still held.
- Admission: one `admitMaterialization(size)` lease per parsed event, taken before
  the event is read into memory and released once its payloads are on disk
  (payload chunks are read back from the store, not held). Waiting for a lease
  inside the pull loop also stops upstream reads while queued (§5.9). A refusal
  aborts the stream as §5.7 requires.
- `src/utils/ref-serializer.ts` accepts an optional `readChunks` provider, so the
  §5.3 serializer is reused for this egress against the scratch store instead of a
  second serializer — and a response payload is never looked up in the
  cross-request cache.
- Tests: 5 new cases in `tests/unit/spool-events.test.ts` — a large Gemini event
  among ordinary ones (scratch blob named by payload sha256 and sized to it,
  envelope chunk byte-exact, event + `[DONE]` byte-identical, both files gone
  afterwards), the Responses `image_generation_call` event keeping its `event:`
  line, a spilled event with nothing allowlisted replayed from its spill with no
  scratch blob, a disconnect mid-extracted-event leaving neither file, and a
  materialization budget that refuses the parse (503 `over_limit_error`, upstream
  cancelled, no `[DONE]`, nothing left on disk).
- Honest scope note: on the identity SSE paths the consumers downstream
  (`usage`/tool tracking) still see whole events, so this is the §5.7 pipeline as
  specified and the groundwork for a ref-serving egress, not a heap reduction on
  those paths today.

### feat(spool): §5.7 per-response scratch blob store

Response and SSE-event binary payloads no longer have a path into the §5.4
cross-request cache. §5.7 says they are per-response scratch, deleted when the
response ends.

- New `src/utils/response-blobs.ts`: `ResponseBlobStore`, one instance per response body
  (or per event) — content-addressed by the payload's sha256 and deduped *within* the
  store, files named `<prefix><store-id>-<hash>.blob` directly inside the already-swept
  `responses/`/`events/` spill directories, so the startup sweep needs no second layout.
  `release()` is synchronous and schedules the unlink (§5.5); `dispose()` awaits those
  deletions, removes whatever was still leased, never throws, and reports
  `{deleted, failed, leaked}` — `leaked` counts leases, so a payload held by two broken
  refs reports two. Construction refuses when `[spool] enabled = false`.
- `src/utils/blob-refs.ts` gains a `RefStorage` seam (`put`/`release`/`read`) with
  `CACHE_STORAGE` over the existing cache. `extractResponseBlobs(body, storage)` now
  takes the store as a **required** argument, so a response payload cannot reach the
  cross-request cache by forgetting one; `rehydrateInlineBlobs` and
  `releaseExtractedBlobs` take it as an optional last argument defaulting to the cache.
  One extraction algorithm, one release contract, two stores.
- The exact-length chunked read moved to `src/utils/spool-chunks.ts` and is shared by
  the cache (`readBlobChunks`) and the scratch store (`readChunks`) — "close file
  handles before unlink" is the same contract in both. `spillDir` is exported from
  `spool-body.ts` so the scratch store reuses the ensured-directory registry.
- Tests: new `tests/unit/response-blobs.test.ts` (11) covers the completion path,
  abort/leak reporting, write failure with no partial file or index entry, a truncated
  file refused instead of served, a failed deletion reported, dispose idempotency,
  `resp-blob-`/`evt-blob-` scope isolation, two live responses never sharing a file, and
  the disabled-spool refusal. The §5.7 block in `tests/unit/blob-refs.test.ts` now runs
  through the scratch store and asserts the cache stays empty.

### test(logger): silence the proxy's own log lines in the unit suite

`npm run test:unit` interleaved the proxy's log into TAP output, so a green run still printed
`[ERROR]`/`[WARN]` lines produced by deliberate fixtures (a 500 stub, a `chmod 0o500` blob dir)
and the log alone could not be told apart from a real failure.

- `src/utils/logger.ts` gains a `silent` level (`LOG_LEVELS.silent = 4`, above every emit
  threshold) admitted by the level whitelist, so `createLogger` suppresses all five levels at it.
- New `tests/setup/silent-logs.ts`, imported by the `test:unit` script via `--import`, defaults
  `LOG_LEVEL` to `silent`; `node --test` runs each file in its own process, so the default reaches
  every suite, and child processes that inherit the env.
- That module also drops the shapes written straight to `console.*` (`config-loader`,
  `key-store`, the blob store, the dashboard) and the ~20 suites that pin `LOG_LEVEL: 'error'` in
  their env object, which beats the default. A suite that asserts on log content installs its own
  `console.*` hook on top and still sees every line.
- Measured over the 426-suite / 2218-test run: 188 noisy lines → 0. `LOG_LEVEL=debug npm run
  test:unit` restores all of them (565), and `LOG_LEVEL=silent` is explicit.
- `tests/unit/cli.test.ts`'s `capture()` now redirects `console.*` alongside
  `process.stdout`/`stderr.write`: the parser reports config errors through `console.error`, so
  the stream-level patch alone saw an empty stream once the setup intercepted it.

### fix(spool): P0 spill accounting, streamed ingress reconstruction, and loud SSE failures

P0 cleanup for the spool work:

- A write failure no longer leaks the current chunk's `max_total_bytes` reservation: the
  receive loop tracks charged bytes separately from the file offset, removes the partial spill,
  and cancels its producer. New injected-failure tests cover request, response, and SSE-event
  spills.
- Request reconstruction no longer calls `readBytes()` into a whole in-memory body. The rebuilt
  `Request` carries a pull-driven spill stream, and `/passthrough` sends a fresh stream directly
  from the raw spill with its exact length. A delayed-upstream test proves 64 KiB read bounds,
  byte identity, and only one whole-body read for the schema/routing pass.
- A spilled SSE event that ends short during delivery now cancels upstream as well as erroring
  the client stream and cleaning its file/reservation. OpenAI SSE conversion errors on malformed
  JSON or EOF before `[DONE]`; Responses-to-Claude conversion errors on malformed JSON, an
  upstream read failure, `response.failed`, or EOF before `response.completed`, without a clean
  close or a false `message_stop`.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit`
**2211/2211** (0 skipped, 0 todo, 0 cancelled).

### feat(spool): shape 3 graduates the `/v1/responses` passthrough send (plan §5.3 shape 3)

Thirty-third increment: `src/handlers/responses.ts` no longer expands every request at the top of
`handleResponsesRequest`. The expansion moved down into the three converting sub-handlers, which need
it, and the native Responses passthrough — the handler's default branch — keeps its refs and streams
the body out of L2 the way `claude.ts:154` and the native `/v1/chat/completions` send already do.

- **One decision per sub-path, not per handler.** `handleAsPassthrough` decides once, on the inbound
  body: `streamRefs = getSpoolConfig().enabled && collectBlobRefs(requestBody).length > 0`. The
  decision precedes the `before_upstream` hook, matching `claude.ts`; the serializer then runs on the
  post-hook body, so a hook that re-shaped the body is still described by the exact
  `Content-Length` measured from what actually goes out (and a hook that removed the refs just
  produces a plain-JSON stream). Spooling off or a ref-free body costs one boolean and one walk.
- **`handleAsAnthropicMessages`, `handleAsGemini` and `handleAsCompletions` expand as their first
  act** (`await rehydrateInlineBlobs(requestBody)`), replacing the single expansion that used to sit
  above the dispatch. This is a correctness requirement, not an optimization, and it was measured
  with those three expansions removed: the `openai-completions` branch relays the ref object itself
  as `image_url.url` (`{"$spoolBlob":true,…}` where the data URL belongs), while the
  `anthropic-messages` branch and both gemini modes fail to decode it and drop the image part — the
  same silent drop recorded for the same two converters in increment 32, left unfixed there and here
  as an unrelated change.
- **Emission follows `claude.ts` exactly**: exact `Content-Length` from the serializer in a
  conditional spread, `body: streamed ? streamed.body : JSON.stringify(upstreamBodyPassthrough)`, and
  a conditional `duplex: 'half'` — a conditional spread skips the excess-property check, so no
  `as RequestInit` cast is needed. Nothing else in the branch changes: the passthrough never converts,
  so the upstream bytes and the `!ok` error path are untouched. One consequence worth naming: the
  error report's `JSON.stringify(requestBody)` preview now shows a small ref object where it used to
  show the payload, which is the same trade every graduated send already makes.
- **The passthrough is the default branch, so the gate is the endpoint, not a mode list**: the
  mode-gate case drives `openai-responses`, the `open-responses` alias (canonicalized upstream, but
  this handler's own dispatch sees both spellings) and no mode at all.
- **Tests** (`tests/unit/responses-ref-streaming.test.ts`, seven cases against a live spool): byte
  identity with the shape-2 reference plus the exact byte-count `Content-Length`, `duplex: 'half'`
  and no ref marker upstream; three refs landing at their own positions across both `input_image`
  spellings (direct string and Chat-style `{url}` object) and a bare `input_file`; a payload larger
  than `BLOB_STREAM_CHUNK_BYTES` reassembled whole; a ref-free body staying on the string path with
  the spool enabled; a missing blob failing the send with `BlobStoreError`; the three passthrough
  mode spellings; and one case per converting mode asserting the string path, no ref upstream, the
  real payload interpolated, and byte equality with the same request sent with no ref at all.
  Falsification: restoring the top-level expansion fails four of the seven, and removing the three
  converting branches' expansion fails exactly the converting-mode case.
- **Docs.** `ref-serializer.ts`'s caller list names this send; `tests/unit/handler-ref-expansion.test.ts`
  keeps its responses case (it drives `openai-completions`, one of the modes that still expands) and
  its header now says where the passthrough's coverage moved.
- **Still caller-less.** `extractResponseBlobs` (§5.7's response side) and `cloneInlineBlobs`.

### feat(spool): shape 3 graduates the native `/v1/chat/completions` send (plan §5.3 shape 3)

Thirty-second increment: `src/handlers/chat-completions.ts` now decides once per request between the
shape-2 expansion and the shape-3 stream, and its native send streams a ref-bearing body the way
`src/handlers/claude.ts:154` and the converted sends in `src/handlers/messages.ts` already do.
Previously every request through this handler expanded the payloads first and sent one large string —
the shape-2 cost the plan says shape 3 exists to remove.

- **One decision, at the body parse** (`src/handlers/chat-completions.ts:84`):
  `streamRefs = !CONVERTING_UPSTREAM_MODES.has(upstreamMode ?? '') && getSpoolConfig().enabled &&
  collectBlobRefs(parsedBody).length > 0`, and the expansion moved inside `if (!streamRefs)`. A body
  expanded there has no refs left to stream, so the send site reuses the one flag. Spooling off, a
  converting mode, or a body without a ref costs one boolean and one walk, and takes the string path
  unchanged.
- **Why the mode conjunct, and what it prevents (measured, not assumed).** The three branches whose
  converters read the payload as a string — `anthropic-messages`, `openai-responses`,
  `gemini-generatecontent` — must stay shape 2. With the conjunct removed and a ref-bearing body,
  `completionsToResponsesBody` forwards the ref object itself upstream as `image_url.url`
  (`{"$spoolBlob":true,…}` where the data URL belongs), while `completionsToClaudeBody` and
  `convertCompletionsToGeminiGenerateContentBody` fail to decode it as a data URI and drop the part,
  so the client's image reaches the upstream as nothing at all. The gate is therefore a correctness
  requirement, not an optimization. Those two converters' silent drop of an undecodable image part is
  pre-existing; it is recorded here rather than changed, which would be an unrelated fix.
- **Emission follows `claude.ts` exactly**: the exact `Content-Length` from the serializer in a
  conditional spread (fetch cannot infer a length for a streamed body), `body: streamed ?
  streamed.body : JSON.stringify(parsedBody)`, and a conditional `duplex: 'half'` — a conditional
  spread skips the excess-property check, so no `as RequestInit` cast is needed. The body is measured
  after the `stream_options.include_usage` rewrite above it, so the declared length describes the
  body that actually goes out.
- **No validation change was needed**, unlike increment 30: `validateOpenAICompletionsRequest` never
  inspects `image_url.url` (the Chat allowlist positions are all strings it does not bound), so a ref
  passes validation and reaches the send.
- **Tests** (`tests/unit/chat-completions-ref-streaming.test.ts`, six cases against a live spool):
  byte identity with the shape-2 reference plus the exact byte-count `Content-Length`, `duplex:
  'half'` and no ref marker upstream; two refs landing at their own positions, data URL prefix and
  all; a payload larger than `BLOB_STREAM_CHUNK_BYTES` reassembled whole; a ref-free body staying on
  the string path with the spool enabled; a missing blob failing the send with `BlobStoreError`; and
  one case per converting mode asserting the string path, no ref upstream, the real payload
  interpolated, and byte equality with the same request sent with no ref at all. Falsification:
  forcing the gate off fails exactly two of the six (byte identity and the chunked payload — the
  position-only case passes either way by design), and dropping the mode conjunct fails exactly the
  converting-mode case.
- **Docs.** `ref-serializer.ts`'s caller list names this send; `tests/unit/handler-ref-expansion.test.ts`
  loses its chat case (the endpoint's native send is no longer shape 2, so the shape-2 file's header
  now says where that coverage moved) — the graduation itself is what made it fail, with
  `[object ReadableStream]` in place of the body.
- **Out of scope, deliberately.** `/v1/completions` is an alias onto this handler but is not in the
  §5.4 extraction gate in `src/index.ts`, so a request on that path can never carry a ref.
- **Still caller-less.** `extractResponseBlobs` (§5.7's response side) and `cloneInlineBlobs`. (§5.4's
  ref-aware leaf count was corrected off this list: `token-counting.ts` counts a Claude image/document
  ref from its recorded size and refuses a ref in a block it has no position to count.)

### feat(spool): §5.7's event pipeline reaches production — SSE is framed per event on both egresses

Thirty-first increment: `streamResponseEvents` stops being a tested-but-caller-less primitive. SSE
responses are now framed one event at a time on the way out, at both places a streaming response
leaves this process: the attempt loop in `src/index.ts` and the `/passthrough/*` SSE branch in
`src/handlers/passthrough.ts` (which returns early from that loop and so is not covered by it). Both
are gated on `[spool] enabled` (§9.1/decision: with spooling off there is nothing to spill, and the
relay stays today's bytes rather than paying a copy per event).

- **Why this candidate.** Checked against the three the request named. (a) *Effective/attempt
  spools*: the plan defines both (§5.2's table, and the per-rung steps at §5.5), but there is no
  module, no config key and no code — it is the outstanding Phase-1/§5.2 item, and what it needs
  first is a decision about threading a reservation through the transformation rungs, not a wiring
  change. (b) *Converted response streaming*: `extractResponseBlobs` is written and tested but needs
  per-response scratch-blob semantics decided first, which is likewise a design question rather than
  an increment. (c) *The SSE-event pipeline*: `streamResponseEvents` was complete, unit-tested and
  would have been dead code in `src/`. It also closes the defect §5.7 names in the live path — today
  a large event accumulates in each consumer's buffer — and it needed no new decision.
- **Placement is the point on the main path.** In `src/index.ts` the wrapper goes in immediately
  after dispatch and *before* the consumers below it: the usage and tool-tracking `TransformStream`s
  (whose `remainder` used to accumulate a whole event), the keep-alive wrapper, and the
  `response_egress` transforms — plus the debug `response.clone()` / `.json()` path, which does not
  exist for `text/event-stream` but is the reason framing has to precede the branch rather than
  follow it. The response is rebuilt as `new Response(streamResponseEvents(response.body), response)`,
  so status and headers are carried through and a client-visible header cannot drift.
- **Passthrough needed its own wiring, for the reason the file exists.** `/passthrough/*` handles its
  own egress and returns before the attempt loop's consumers, so the framing is inserted at the
  `sseSource` it hands to `wrapSseStreamWithKeepAlive`, ahead of the usage tracker. One shared
  primitive, two call sites, no duplicated logic.
- **Tests, and the falsification that says they bite.** `tests/unit/index-routing.test.ts` gains a
  `§5.7 SSE event framing on the response egress` suite of four cases driven through a real
  `/v1/messages` request with an openai-completions upstream: the client stream is byte-identical
  with the spool on and off (with the per-request message id normalized) while event order and
  payloads survive; an event above `threshold_bytes` has a live spill on disk while the client is
  reading it and no spill after; an event past `max_response_bytes` fails the stream with
  `SpoolResponseTooLargeError`, emits no terminal `message_stop`, and leaves no spill; and with the
  spool off an equally oversized event is relayed untouched with no framing. `passthrough-egress.test.ts`
  gains the same pair for the other egress (byte identity on/off, and the cap rejecting mid-stream).
  Disabling either wiring fails exactly three of these six — the spill case and the two cap cases —
  while byte identity and the disabled control still pass, which is what makes them properties rather
  than tautologies. The frame stream is `highWaterMark: 0` and pull-driven, so the spills are observed
  *during* delivery rather than after.
- **Fixture note.** The route-suite upstream is a progressive body (one event per `pull`) rather than
  a single buffered chunk, which is how a real upstream streams: `[DONE]` cannot arrive in the same
  chunk as an earlier event. Whether the proxy cancels the upstream on breach is asserted at the
  primitive level in `spool-events.test.ts` instead, because a stub's `cancel` cannot observe it —
  the converter drains a body that short into itself before the framing sees the oversized event, so
  the stub has already closed and a closed stream has no cancel to call.
- **A pre-existing fatal, found and then made non-fatal (user decision: "log, don't die").** While
  testing this, a stray `TypeError: controller[kState].cancelAlgorithm is not a function` was traced
  to `controller.terminate()` at `src/converters/streaming.ts:344` — the converted Claude bodies call
  it after the terminal `message_stop`, and Node clears a TransformStream's cancel algorithm when it
  does. A later cancel of that readable then throws *inside* `pipeTo`'s own shutdown, where the throw
  is not this code's to catch; it escapes as an unhandled rejection, which is fatal under Node's
  default. It reproduces with spooling **off** on a buffered upstream, so it predates this increment,
  and one client hanging up mid-stream is enough to reach it. `src/server.ts`'s `main()` now installs
  a `process.on('unhandledRejection')` that writes the stack to stderr (`process.stderr.write`,
  because TUI mode reassigns `console.error`) and keeps serving; the request itself has already
  failed on its own path. Accepted tradeoff, stated plainly: the process no longer dies on *any*
  stray rejection, and the underlying `terminate()`/`pipeTo` hazard is still there, logged rather
  than removed.
- **Known limitation, not hidden.** A disk failure while reading back a spooled event errors the
  returned stream but does not cancel upstream. The two failure paths §5.7 does name — the cap
  breach and an exhausted spill budget — are covered, because `receiveSpooledBody` cancels the event
  stream it was handed on its way out and that reaches `cancelSource`; both are asserted. Closing the
  read-back gap would need a way to inject a spill read failure to test it, so it is recorded here
  rather than added untested.
- **Docs.** `spool-events.ts` names its two callers and no longer claims the response side is
  callable-but-unwired; `src/utils/spool.ts`'s header no longer says the response/SSE keys are not
  read by any path, and names where `threshold_bytes`/`max_response_bytes` are now read;
  `src/utils/spool-admission.ts`'s header no longer claims "this module has no caller yet" — it names
  the two call sites (`src/index.ts` before the request body is parsed, `src/handlers/passthrough.ts`
  around its materialized response body) that the twenty-first and twenty-second increments added.
- **Still caller-less.** `extractResponseBlobs` (§5.7's response side) and `cloneInlineBlobs`. (§5.4's
  ref-aware leaf count was corrected off this list: `token-counting.ts` counts a Claude image/document
  ref from its recorded size and refuses a ref in a block it has no position to count.)

### feat(spool): shape 3 reaches the converted egress — `messages.ts` streams instead of expanding (plan §5.3 shape 3)

Thirtieth increment: shape 3 stops being a native-`/v1/messages`-only path. `src/handlers/messages.ts`
now decides once per request between the shape-2 expansion and the shape-3 stream, and its two
converted sends — the OpenAI Completions one and the OpenAI Responses one — stream a ref-bearing
body the way `claude.ts:154` already did. Previously every request through this handler ran the
Claude→OpenAI conversion over rehydrated payloads and sent one large string, which is exactly the
shape-2 cost the plan says shape 3 exists to remove ("shapes 1 and 3 fix the slow-upstream
request-send window; shape 2 does not").

- **One decision, at the body parse** (`src/handlers/messages.ts:232`). `streamRefs = !isSdkUrl(targetUrl) && getSpoolConfig().enabled && collectBlobRefs(requestBody).length > 0`, and the
  expansion moved inside `if (!streamRefs)`. A body expanded here has no refs left to stream, so
  both sends reuse the same flag. Spooling off, an `sdk://` target, or a body without a ref costs one
  boolean and one walk, and takes the string path unchanged.
- **The converter had to learn to carry a ref, re-prefixed.** `convertClaudeContentToOpenAI` used to
  splice `` `data:${media_type};base64,${data}` `` into `image_url.url`; a ref there would have been
  stringified as `[object Object]`. A Claude `source.data` is *bare* base64, so its ref carries
  `prefix: ''` — the converted position needs the data URL back: `{ ...ref, prefix }`. One ref in,
  one ref out, so the lease accounting is unchanged, and the serializer emits `"<prefix>"` plus the
  payload bytes, byte-identical to the interpolation. Flipping the branch to `data` without
  re-prefixing fails four of the new cases — the re-prefix is load-bearing, not cosmetic.
- **The already-OpenAI branch stays shape 2, deliberately.** A request with `isOpenAIFormat` and no
  Claude-format tools goes upstream as the client spelled it, and its `image_url`/`inline_data`/
  `input_image` refs are positions `token-counting.ts` refuses to guess at (`refuseUncountedRefs`).
  Leaving them in place would make `estimateInputTokens`' catch degrade the whole count to 0 (§9.3's
  miscount), so that branch expands at entry (`messages.ts:297`) and the count stays honest.
- **What the §5.3 shape-3 eligibility rule buys here.** The converted Responses position
  (`input[].content[].image_url.url`, object form) is on the allowlist because
  `completionsMessagesToResponsesInput` copies `part.image_url` by reference, so the re-prefixed ref
  survives at that path. `JSON_VERBATIM_PAYLOAD` is what makes the declared `Content-Length` exact:
  the skeleton's bytes plus each ref's recorded `size`, measured without reading a blob.
- **Validation had to accept a ref where it looks for a payload** (`src/utils/validation.ts`). The
  Claude-format path validates *before* conversion, on the ref-bearing body, so a spooled image was
  rejected as `…source.data is required for base64 images`. The new `sourceDataSize` helper reads a
  ref's recorded `size` (`assertRefShape` first, so a malformed ref is refused rather than measured)
  and falls back to the field's own length, and both the image and document branches bound by it.
  That is the size the extraction recorded, not `JSON.stringify(ref).length` — the new test asserts a
  ref whose recorded `size` exceeds the cap is rejected while a small one passes, which a
  field-as-text bound could not distinguish.
- **Tests.** `tests/unit/messages-ref-streaming.test.ts` (new, 8 cases) is the plan's interesting
  path: the conversion sits between the ref and the send. Both converted sends are asserted
  byte-for-byte against the shape-2 string path for the same request, with multi-byte text in the
  skeleton so `Content-Length` is pinned as bytes rather than characters; two refs land at their own
  positions in order; a payload larger than `BLOB_STREAM_CHUNK_BYTES` crosses the chunk boundary; a
  ref-free control still sends a string with no `Content-Length` and no `duplex`; a spooled image is
  accepted through validation; the already-OpenAI branch is asserted *not* to stream; and a blob
  missing from L2 rejects the send with `BlobStoreError` instead of putting a truncated body on the
  wire (repo rule #8). `claude-to-openai.test.ts` gains the ref-through-the-converter case and
  `validation.test.ts` the ref-size cases. The graduated case left
  `tests/unit/handler-ref-expansion.test.ts`, whose mock only records `String(init?.body)` and so
  cannot see a stream; that file is the shape-2 suite and its header now says which paths left it.
- **Consequence, stated rather than hidden:** input usage for a spooled request through this handler
  now follows the §5.3 rule — `Math.ceil(base64 chars / 4)` for the payload with fixed block metadata
  dropped — instead of the tiktoken count over the inline string. The plan sanctions the difference
  ("an approximation and need not match the pre-ref/tiktoken result"), and
  `tests/unit/index-routing.test.ts` now asserts the reported usage equals exactly that sum, which is
  what proves the payload was measured from the ref's recorded length rather than read.

### feat(spool): first ref-aware egress — the native `/v1/messages` send streams the refs (plan §5.3 shape 3)

Twenty-ninth increment: shape 3 gets its first caller. `src/handlers/claude.ts`'s native
`/v1/messages` send is the one place where a ref-bearing body is no longer expanded: the refs stay,
and the send streams the JSON out of L2 — skeleton bytes, then each blob read a chunk at a time at
the offset its ref occupies — so the expanded body never exists. Source: `upstream_mode =
anthropic-messages` (the `case 'messages'` dispatch in `src/index.ts`).

- **One decision, at the top of the handler.** `streamRefs` is computed where the shape-2 expansion
  already lived — `!isSdkUrl(targetUrl) && getSpoolConfig().enabled && collectBlobRefs(requestBody).length > 0`
  — and the send site reuses it, because a body expanded there has no refs left to stream. `enabled`
  gates the walk, so a deployment with spooling off (§9.1) pays one boolean and a ref-free body
  (the common case) takes the string path unchanged. The `sdk://` branch stays on shape 2: it is
  handed the parsed body object itself, and `handleSdkAnthropicRequest` is a 501 stub.
- **What the send does.** `createRefAwareJsonBody(upstreamBody)` returns the stream *and* the exact
  byte length, measured from the skeleton plus each ref's recorded `size` without reading a blob;
  that value goes out as `Content-Length` (fetch cannot infer a length for a streamed body, and a
  stale one is worse than none, §5.3), and `duplex: 'half'` is spread in only on that path. No
  `as RequestInit` cast is needed here, unlike `src/handlers/passthrough.ts:271`: a conditional
  spread avoids the excess-property check that a plain `duplex` key trips.
- **Byte identity is the property, and it is asserted against the other path.** The new tests send
  the same request twice — once with a live spool (refs stream) and once with spooling off (the
  expanded string) — and compare the bytes the fetch call actually carried. That catches a
  serializer that dropped, re-escaped, reordered or truncated a payload, which a
  parses-back-to-the-right-JSON assertion would not. The fixture's skeleton carries multi-byte text
  on purpose, so `Content-Length` is pinned as a byte count rather than a character count.
- **Five cases, none vacuous.** Byte identity + exact `Content-Length` + `duplex: 'half'` + no
  `$spoolBlob` in the bytes; two refs in one body landing at their own positions in order; a payload
  larger than `BLOB_STREAM_CHUNK_BYTES` (64 KiB) reassembled against the reference, so the chunk
  boundary is actually crossed; the negative control, a ref-free body with spooling *on*, still
  sent as a string with no `Content-Length` we set and no `duplex`; and a ref whose blob is gone
  from the store, which must reject the send with `BlobStoreError` rather than put a truncated or
  ref-bearing body on the wire (repo rule #8). Removing the `createRefAwareJsonBody` line fails
  exactly four of them — the fifth is the negative control and passes either way.
- **The mock had to learn to drain a stream.** `tests/unit/handler-ref-expansion.test.ts`'s
  `String(init?.body)` recorded `"[object ReadableStream]"` once the handler streamed, which is the
  falsification that found the claude.ts case there. That file is the shape-2 suite, so its claude
  case moved to `tests/unit/claude-ref-streaming.test.ts` rather than being taught to drain; its
  ref-free case stays, because a body with no ref takes this handler's shape-2 fallback.
- **Consequences, stated rather than hidden.** 1) A native `/v1/messages` request on a spooling
  deployment now pays one extra full walk of the parsed body (`collectBlobRefs`) before the send.
  2) The `Sending to upstream:` debug line, the `upstream-request` trace line and the upstream-error
  preview now show a small `$spoolBlob` object where an allowlisted payload used to be — smaller,
  and the payload is no longer printed. 3) The audit that cleared this: none of the ten
  `request-transform.ts` builtins or five ops reads an allowlisted payload position (they read
  `type`, `role`, `id`, `tool_use_id`, schemas, `system` blocks, headers, `model`, `input`), so
  `before_upstream` on a ref-bearing body is behaviourally safe — only its trace output changes.
- **Docs.** `ref-serializer.ts`'s header no longer says it has no production caller: it names this
  send, and states that graduation is per handler, in the handler. `blob-refs.ts`'s header now says
  the same about the shape-2/shape-3 fork, and README's spool section records the native
  `/v1/messages` send as the graduated one.
- **Still caller-less.** `extractResponseBlobs` (§5.7's response side) and `cloneInlineBlobs` — next,
  and unchanged by this increment. (`streamResponseEvents` has since gained its callers at both
  egresses in the thirty-first increment.)

### feat(spool): refs cross the send boundary, handlers expand, plan §5.3 (shape 2)

Twenty-eighth increment: the §5.3 send boundary stops putting the payloads back. Until now
`src/index.ts` rehydrated every ref at the boundary, so the extraction's RAM relief ended one step
after it began: routing, the attempt builders, conversion, `before_upstream`, the privacy/kompress
passes and the `new Request(…, { body: bodyText })` rebuilds all carried the full binaries again.
The boundary now keeps the refs — which are plain JSON data — and each dispatch handler calls
`rehydrateInlineBlobs` on its parsed body as its first act.

- **Why the handlers and not the boundary.** Dispatch runs *after* it, once per attempt and once per
  rung of the retry ladder, and one composite or fusion alias's body can map to several modes — so
  the boundary cannot know which mode, let alone which handler, is about to read the body. A
  dispatch-site expansion would instead pay a second full-body parse and re-serialize on every
  attempt. Doing it in the handler costs one walk of the body it has already parsed, and it is the
  last point that still precedes every consumer of the payloads: conversion, the request validators,
  the `before_upstream` hook and the upstream send all see original bytes. This is the caller order
  chosen with the user (§5.3 shape 3, Q1).
- **Expansion must precede validation, and now provably does.** `validateClaudeMessage` refuses a
  non-string where it expects the base64 payload (`…source.data is required for base64 images`), so
  a ref surviving into a Claude-format request would 400 every spooled image. Disabling the
  expansion in `claude.ts` and `messages.ts` makes exactly the two expected new tests fail, the
  second with that validator message verbatim — the ordering is a load-bearing property, not a
  claim.
- **Nine parse sites, six files.** `claude.ts` (`/v1/messages` native), `messages.ts`,
  `gemini.ts` (Interactions and `:generateContent` — the latter also serves
  `handleGeminiRequestForMessages`, which merely delegates), `openai.ts` (`:generateContent`),
  `responses.ts` (`/v1/responses`, `input_tokens`, `compact`) and `chat-completions.ts`. The
  `chat-completions.ts` call sits *outside* the `try` whose `catch` reports "Invalid JSON body", so a
  blob-store failure reports itself instead of being relabelled a client parse error. No other parse
  site can see a ref: extraction is gated on the endpoints listed at `src/index.ts:1389`, which is
  also why `/v1/messages/count_tokens` cannot — see the consequence below.
- **The auth server is the one pre-dispatch consumer that must see the old bytes.** §5.8's
  projection covers this when an uploader is configured. Without one, the auth block now expands a
  `structuredClone` of the body into `authBodyText` and `doAuthRequest` posts
  `authBodyText ?? bodyText`. `structuredClone` shares nothing with the original, so the leases stay
  with the body that owns them, and the clone takes no lease of its own — the test asserts the sweep
  still finds the blob evictable after the request.
- **Consequences, stated rather than hidden.** 1) A route's `request_ingress` transforms and the
  `LOG_LEVEL=debug` `test_model.log` dump run per attempt on the ref-bearing text, so an operator's
  transform that reads an image field now sees a `$spoolBlob` object, and the dump prints refs where
  it printed base64. 2) The handler's own inbound debug log has the same property — it is emitted
  after the expansion, so it prints payloads; the pre-handler ones do not. 3) `N` attempts mean `N`
  expansions, i.e. `N` blob-store reads of the same payload (each rung rebuilds its body from
  `bodyText`); the ladder has no cache for this. 4) `countRefTokens` stays unreachable:
  `/v1/messages/count_tokens` is not in the extraction gate, so its handler can never receive a ref.
  Graduating it would mean extending the gate and letting `validateClaudeTokenCountingRequest` accept
  refs — a decision not taken here.
- **Docs corrected where the seam move made them false.** `blob-refs.ts`'s header and
  `rehydrateInlineBlobs`'s doc now describe the handler-owned expansion; `ref-serializer.ts`'s
  "wiring means the boundary has to stop rehydrating" note became "a ref-aware handler streams
  instead of expanding"; and §5.9's reason for not releasing the materialization lease at extraction
  now cites the handler's re-materialization, which is what keeps that reasoning true.

`tests/unit/handler-ref-expansion.test.ts` is new: 10 cases driving the real exported handlers with
a ref-bearing `Request` built by the real `extractInlineBlobs` against a live temp-dir store and a
stubbed `fetch` that records the raw upstream body text. Each case asserts a ref really was
extracted (`refs === 1`, `skipped === 0`) and that the serialized request really carries the marker,
so none can pass vacuously, then asserts the payload is back at the exact position the handler reads
(`messages[0].content[1].source.data`, `image_url.url`, `contents[0].parts[1].inline_data.data`, …).
The Claude-format case is titled for the validator ordering above; the last case pins the no-op —
a ref-free body is left untouched and the marker never appears.
`tests/unit/index-auth-projection.test.ts` grew the no-uploader carve-out: the auth body must carry
no marker, and the post-request sweep must still expire the blob (a lease leaked by the clone would
keep it alive). Reverting the clone's expansion fails that test.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **2169/2169**
(0 skipped, 0 todo, 0 cancelled), +10 over the 2159 baseline.

Byte-identity holds by construction: the JSON round trip through `bodyText` and the attempt builders
already happened before this increment, so the upstream bytes are what they were. The next increment
is shape 3's first wired route — `/v1/messages` with `upstream_mode = anthropic-messages` streaming
its body through `createRefAwareJsonBody` instead of expanding it.

### feat(spool): §5.8's wiring at the shape-2 boundary, plan §5.8

Twenty-seventh increment: `auth_with_body` now hands the auth server external links instead of inline
binaries. The three §5.8 pieces that landed caller-less (`InlineExtraction`, `uploadBlobsForAuth`,
`buildAuthProjection`) meet at the §5.3 shape-2 boundary in `src/index.ts`, between the erase step
and the rehydration — the last point at which the refs exist and the first point at which the body
is final.

- **Upload before rehydration, project, then send the projection.** The block runs only when an
  uploader is configured, `auth_with_body` is on, auth is configured and the body actually extracted
  refs; it uploads, builds the projection from the returned `hash → url` map, and stores the
  projection text in `authBodyText`. The deferred `doAuthRequest` then sends
  `authBodyText ?? bodyText`, so auth receives text and tools with their final post-erase values and
  every inline payload as an `external_blob` link, while model resolution and every attempt builder
  still read the rehydrated `routeBody` with the original bytes. §5.8's "if no external uploader is
  configured, preserve the existing full-body auth behavior" is the `externalUpload === null` case,
  which skips the block entirely.
- **The upload list comes from the leases, not from a body walk.** `InlineExtraction` gained
  `blobs`, the *distinct* blobs behind the extraction's leases in first-lease order (deduped, unlike
  `hashes`, which is one entry per ref so the owner can release repeats). Uploading from the body
  would also find a `$spoolBlob` ref a client forged into a field of its own, and would upload a
  blob this request never leased; uploading from the leases cannot. It also makes the caller
  independent of the walk order and gives the uploader exactly the identity and stored length it
  must declare.
- **The leases are already held.** §5.8's "renew the blob's existing lease throughout upload, auth
  fetch, and the subsequent upstream send" needs no new code: the request's extraction lease lives
  until the handler's `finally`, and the idle sweep only expires `refs === 0` however long a live
  lease is held. The new suite samples a sweep inside each stub (upload, auth, upstream) and gets
  `[0, 0, 0]`, then gets `1` from the same sweep after the request — so the zeros are a property of
  the lease and not of a sweep that never fires.
- **Failure is auth failing, not a substitute body.** An unreachable endpoint, a non-2xx, a receipt
  that disagrees with what was sent or a projection that finds no link all throw out of this block,
  before `doAuthRequest` runs: the auth server is never asked to validate a link-less body, and no
  attempt is built. `ExternalUploadError` and `AuthProjectionError` are `ClaudeProxyError`
  subclasses, so they exit through the existing `createErrorResponse` (500 `processing_error`, or
  504 `upstream_timeout` for the uploader's own abort) with the endpoint's status and no echoed
  signed URL, token or endpoint body.
- **One honest cost, stated rather than hidden:** a forged ref is only refused when the projection
  walks the body, which is *after* the real blob has been uploaded — so that request uploads one
  object it will not use. The test asserts the upload count and the release, and the object expires
  through the store's lifecycle rule, consistent with the "no proxy delete" decision.

Also fixed: the projection was serialized as `JSON.stringify(buildAuthProjection(body, links))`,
which stringifies the `{ body, refs, bytes }` wrapper rather than the projected body — the auth
server would have received a JSON envelope around the request instead of the request. Typecheck and
build both pass either way; the mutation check (reverting the line) fails 2 of the new suite's 7
tests.

`tests/unit/index-auth-projection.test.ts` is new: 7 cases driving the real handler with a stubbed
`fetch` that separates the upload, auth and upstream calls. They pin the upload's wire contract
(`PUT`, `Content-Length` and `X-Blob-Sha256` over the stored base64 text, the streamed body
byte-for-byte), that auth receives the link and *not* the payload while upstream receives the
payload and neither the link nor the signed URL, the sweep evidence above (in-flight `[0, 0, 0]`,
`[1]` after), the rejected upload and the disagreeing receipt (500, no auth call, no upstream call,
lease released), the no-uploader and `auth_with_body`-off paths (no `PUT`; a `GET` with no body),
two refs to one payload (one `PUT`, both links), and a client-forged ref (500 naming the hash, one
`PUT` for the real lease only). `tests/unit/blob-refs.test.ts` grew the `blobs` field (6 whole-record
expectations plus a deduped-list assertion).

Verified: `npm run typecheck` clean; `npm run build` clean; `tests/unit/index-auth-projection.test.ts`
7/7; `tests/unit/blob-refs.test.ts` 29/29; `npm run test:unit` **2159/2159** (0 skipped, 0 todo,
0 cancelled), +7 over the 2152 baseline.

With this, §5.8 is complete apart from the "best-effort delete external objects after the auth
decision" the user's "no proxy delete" decision replaced. The next increment is the response side:
§5.7's `extractResponseBlobs` and the first caller of the §5.3 shape-3 serializer.

### feat(spool): the §5.8 external uploader, plan §5.8

Twenty-sixth increment: the transport the previous increment's keys were waiting for.
`src/utils/external-upload.ts` exports `uploadBlobsForAuth(blobs)`, which streams each distinct L2
blob to the configured endpoint and returns the `hash → signed URL` map that `buildAuthProjection`
takes as its `links` argument. Like the three increments before it, it lands **caller-less**: the
§5.3 shape-2 wiring is the next increment.

- **One `PUT` per distinct blob, to the endpoint's own contract.** Two refs to one payload are one
  stored object (§5.4), so a repeated hash uploads once; two different sizes for one hash throw
  rather than picking one. The body is the stored base64 text itself — no JSON envelope, no
  re-encoding — streamed 64 KiB at a time, with an exact `Content-Length`, `X-Blob-Sha256`,
  `X-Blob-Size`, `Content-Type: application/octet-stream`, and `Authorization: Bearer` only when
  `external_upload_token` is set. Uploads run one at a time: bounded connections, and a failure
  stops before the next blob leaves the host.
- **Every field of the answer is checked before the URL is used.** The endpoint answers
  `{ url, sha256, size, expires_in }`; the proxy requires an absolute `https:` URL with no embedded
  credentials, a `sha256` equal to the uploaded hash (case-insensitively — it is hex, so case is the
  endpoint's), a `size` equal to the uploaded length, and an `expires_in` at or above
  `external_url_min_lifetime_s`. §5.8: "Never silently fall back to an empty binary field or send a
  broken link."
- **Redaction is a property of the module, not of its caller.** The signed URL carries its own
  credentials, and these errors end up in logs, so the URL, the token, the configured endpoint and
  the endpoint's error body are never echoed — the non-2xx message states the status alone, and
  transport failures go through `classifyTransportError`, whose messages are already free of
  hostnames and ports. Tests put a signed URL in an endpoint's error body and a credential in a
  returned link and assert neither reaches the message.
- **A blob that cannot be read fails before the request exists.** `readBlobChunks` is a lazy async
  generator, so its index, expiry, file-open and on-disk-length checks would otherwise run only when
  the peer drains the body — an unknown hash could "succeed" by sending nothing. The body helper is
  async and pulls the opening chunk before `fetch` is called, so the refusal happens in the
  pre-flight instead. Backpressure comes from `pull` (one chunk per unit of demand, §5.7's
  convention), a short stream errors rather than passing off a short body as the declared length,
  and `cancel` closes the L2 handle.
- **The timeout is ours, so the message can state it.** One `AbortController` and a per-blob timer
  (`external_upload_timeout_ms`, `unref`'d so a settled request leaves no pending timer) abort the
  upload; because that signal has exactly one source, an abort is reported as
  `timed out after N ms` (504, `upstream_timeout`) instead of being guessed at from an `AbortError`.
- **No proxy-side delete after the auth decision.** The proxy uploads and forgets; objects expire
  only through the store's own bucket lifecycle rule, which the operator configures. This is a
  decision taken with the user (2026-11-04) and it knowingly diverges from §5.8's "best-effort
  delete external objects after the auth decision" — the twenty-fifth increment's forward pointer
  listed that delete as part of this module, and this is where it was dropped. §5.8's other
  requirements hold unchanged: nothing here is persisted, cached or resumed, so external objects are
  never request recovery state.
- **Leases belong to the caller (§5.5).** This module reads blobs and never retains or releases one.
  A held lease keeps `refs > 0` and the idle sweep only expires `refs === 0`, so §5.8's "renew the
  blob's existing lease throughout upload, auth fetch, and the subsequent upstream send" is
  satisfied by holding it — slow external I/O cannot become a TTL deletion. The wiring increment
  owns taking and releasing it across upload, auth and send.
- **An unconfigured uploader is a refusal, not an empty map.** §5.8: "If no external uploader is
  configured, preserve the existing full-body auth behavior." A caller that reached the uploader
  anyway is misconfigured, so `externalUpload === null` throws without opening a request — an empty
  map would have silently produced a link-less auth body.

`src/utils/external-upload.ts` is new (it reuses `readBlobChunks`/`LeasedBlob` from `blob-store.ts`,
`ClaudeProxyError`/`classifyTransportError` from `errors.ts`, and `getSpoolConfig` from `spool.ts`;
`UploadableBlob` is `Pick<LeasedBlob, 'hash' | 'size'>` rather than a new interface, since §5.8 keeps
exactly the "small ref skeleton" in memory across external I/O).
`tests/unit/external-upload.test.ts` is new: 17 cases in four blocks — the request (one PUT per
distinct blob with the exact header set and streamed body, the omitted bearer, the empty input, the
unconfigured refusal, the two-size refusal, the unreadable blob with no partial map), receipt
verification (foreign hash, wrong size, hash case, the lifetime boundary at 59/60/61 with a
non-integer, a non-2xx whose body is asserted absent, non-JSON, a non-object answer, and the
`http:` / non-URL / embedded-credential / empty-URL links), failures (the timeout's status and type
with no retry, and an `ECONNREFUSED` classified to 502 `upstream_unreachable` with the endpoint
asserted absent), and one test against a real `node:http` server that inspects the received method,
headers and byte-for-byte body — the framing a stubbed `fetch` cannot prove. Mutation gate: deleting
the explicit `Content-Length` from the request headers fails two of the 17, including the real-server
one.

Verified: `npm run typecheck` clean; `npm run build` clean; `tests/unit/external-upload.test.ts`
17/17; `npm run test:unit` **2152/2152** (0 skipped, 0 todo, 0 cancelled), +17 over the 2135
baseline.

The module is inert until it is wired: nothing calls `uploadBlobsForAuth`, so configuring the
uploader today still cannot change a request, and `README.md`'s `[spool]` bullet says so. The wiring
at the §5.3 shape-2 boundary in `src/index.ts` — upload from the still-extracted body's hashes
*before* the rehydration, build the projection from the returned map, hold the leases through the
upstream send, and fail auth explicitly on any upload failure — is the next increment.

### feat(spool): external uploader config surface, plan §5.8

Twenty-fifth increment: the `[spool]` keys that opt into §5.8's external uploader, and the
validation that keeps them from half-existing. No upload happens yet — the transport lands next —
so this increment's job is to make the decision explicit and checkable at startup.

- **Four keys, all under the existing `[spool]` section.** `external_upload_url` names the HTTPS
  endpoint that will receive each spooled blob and answer with a short-lived signed download URL;
  `external_upload_token` is an optional bearer for it; `external_upload_timeout_ms` (30000) bounds
  one blob upload and `external_url_min_lifetime_s` (900) is the shortest signed-URL lifetime the
  uploader will accept. The proxy uploads and stores no object-store credentials and signs nothing
  itself — the endpoint does the signing, which is why the keys stop there.
- **The absent state is the load-bearing one.** §5.8: "If no external uploader is configured,
  preserve the existing full-body auth behavior." `SpoolConfig.externalUpload` is therefore
  `SpoolExternalUploadConfig | null`, and only the absence of `external_upload_url` produces
  `null`. A token, timeout or lifetime on its own throws rather than resolving to a null uploader
  the operator did not ask for.
- **HTTPS only, and the message never quotes the value.** The blob and its signed URL cross the
  public network, so any other protocol is refused with the protocol it found; a URL that embeds
  credentials (`https://user:pass@…`) is refused too, because it would land in the plaintext config
  file and in any error that echoed it — `external_upload_token` is the key for that. The error
  names the key and nothing else, and a test asserts the credential is absent from the message.
- **Configured without `enabled = true` is a startup error**, checked before the spool directory is
  touched: the uploader's whole input is spooled blobs, and a disabled spool produces none. A test
  asserts the directory was not created by the refused attempt.
- **The lifetime floor is 60 s and is a floor, not a check.** The plan asks for a signed URL that
  outlives the auth fetch it is handed to; `src/index.ts`'s `doAuthRequest` issues its `fetch` with
  no timeout and no `AbortSignal`, so there is nothing to compare against. Rather than invent an
  auth timeout, the resolver refuses lifetimes under a minute and accepts the rest on the
  operator's word, which the README says in as many words. This was a decision taken with the user,
  not a reading of the plan.
- **Parser and serializer, not just the resolver.** `external_upload_url` and
  `external_upload_token` are quoted `[spool]` values, so a new `SPOOL_STRING_KEYS` set (alongside
  the existing `SPOOL_NUMERIC_KEYS`, for the same parse-time-typo reason) admits them in both the
  quoted and unquoted branches; the two numbers join `SPOOL_NUMERIC_KEYS`; and the serializer writes
  the strings after `dir` and the numbers in its existing loop, so a dashboard save round-trips all
  four. The token is serialized verbatim, matching `api_key`: that function writes the operator's
  own config file, which already holds secrets in plaintext — §5.8's redaction applies to logs.

`src/utils/spool.ts` gains `SpoolExternalUploadConfig`, the `externalUpload` field on
`SpoolConfig`, `EXTERNAL_UPLOAD_DEFAULTS`, `EXTERNAL_URL_MIN_LIFETIME_FLOOR_S`, and the
`resolveExternalUpload` / `positiveIntegerSetting` helpers; `src/utils/config-loader.ts` gains the
keys on `ProxyConfig.spool`, `SPOOL_STRING_KEYS`, and the parse/serialize wiring.
`tests/unit/spool.test.ts` grows a §5.8 block (10 test cases: the URL-only default resolution, URL
normalization with a trimmed token, the three orphan-key refusals, non-HTTPS, non-URL, empty,
embedded credentials with the credential asserted absent, empty token, non-positive and fractional
timeout, the lifetime floor boundary at 59/60/61, and the disabled-spool refusal with its
no-side-effect assertion) plus a default-state case, and `tests/unit/config-loader.test.ts` extends
the full-key round-trip with the four keys and adds a startup case for the installed uploader
beside the refusal one.

Verified: `npm run typecheck` clean; `npm run build` clean; `tests/unit/spool.test.ts` 64/64 and
`tests/unit/config-loader.test.ts` 227/227; `npm run test:unit` **2135/2135** (0 skipped, 0 todo,
0 cancelled), +15 over the 2120 baseline.

The keys are inert: nothing reads `getSpoolConfig().externalUpload` yet, so setting them today
cannot change a request. `README.md`'s `[spool]` bullet documents them and says so. The uploader
module — streaming L2 upload, signed-URL validation, hash/size verification, best-effort delete
after the auth decision, the lease renewal across upload/auth/send, and the wiring at the §5.3
shape-2 boundary ahead of the rehydration — is the next increment.

### feat(spool): auth_with_body external-link projection, plan §5.8

Twenty-fourth increment: the §5.8 projection itself. `src/utils/auth-projection.ts` exports
`buildAuthProjection(body, links)`, which returns a deep copy of the request body with every
request `BlobRef` replaced — at the same field path, keeping the surrounding metadata — by the
custom `external_blob` object the auth service is contracted to fetch and verify: `type`,
`url`, `sha256`, `size`, `media_type`, `encoding: 'base64'`. Text and tools keep their final
post-sidecar values, and everything that was never a ref passes through untouched.

- **The projection is a copy, never the caller's body.** §5.8: "The upstream request is
  unchanged in semantics: it still streams the original inline base64 fields from the local
  blobs." Replacing the body's own refs would destroy the payloads before the upstream send and
  could put a link object — or a replacement URL — in front of a model API, which the plan
  allows only under a separate product decision that has not been made.
- **Same path, no renaming.** Claude `source.data` becomes the object while `source.type` stays
  `"base64"` and `source.media_type` stays; Chat `image_url.url`, `input_audio.data` and
  `file.file_data`, Responses `input_image.image_url`, `input_file.file_data` and the inline
  skill's `source.data`, Gemini `inlineData.data`/`inline_data.data` and Interactions `input[].data`
  are all replaced in place. No field is renamed to `source.url`, `file_url`, `fileUri` or `uri`.
  The `data:` prefix is dropped from the auth body, and the media type it stated moves into the
  link: `media_type` is the ref's own prefix first, then the media-type sibling the schema puts
  beside the payload (`media_type`, `mime_type`, `mimeType`), then `null`. Chat `input_audio`
  gets `null` — its `format: "wav"` is a container name, not a media type, and reading one out of
  it would be a guess the auth service would then verify against nothing.
- **The link source is a hash→URL map, not a callback.** §5.8's upload is streaming network I/O,
  so it cannot be a synchronous seam; with a `ReadonlyMap` this module stays pure and
  synchronous and the upload is a separate, plainly ordered step its caller owns. The map is
  keyed by hash because two refs to one payload are one stored object, and the caller chooses
  the key set: §5.2's extraction `hashes` list names the blobs *this* request leased, where
  walking the body would also find a client-forged ref and upload a blob the request never
  owned.
- **Fail closed, in the right order.** A ref with no link, an empty URL, a non-URL and a
  non-HTTPS URL each throw an `AuthProjectionError` — §5.8's "Never silently fall back to an
  empty binary field or send a broken link". `assertRefShape` runs *before* the map is
  consulted, so a forged ref's bogus `size` can never be stated as fact in a link that the auth
  service would treat as verified metadata. Signed URLs are never echoed into an error message:
  they carry their own credentials, and §5.8 redacts those from logs.
- **The walk is marker-based and holder-aware**, following `collectBlobRefs`/`restoreRefs` in
  `blob-refs.ts`: a ref is a leaf, each holder is asked for its own media-type sibling, and a
  single `Object.entries` loop covers arrays and objects.

`tests/unit/auth-projection.test.ts` is new (11 tests). The §10 matrix item runs over all twelve
allowlisted positions of the same body `blob-refs.test.ts` uses, with links built from real
`extractInlineBlobs`-produced refs over real L2 blobs, and asserts per position a
`deepStrictEqual` against the exact link object — which also pins that no extra field, such as
the ref's own marker, leaks into the auth request — plus the three `null` media types, the
surviving metadata, no payload and no `data:` prefix anywhere in the auth JSON, and that the
request body is byte-identical to its pre-projection self and still rehydrates to the exact
client input. The §10 sidecar sentence is its own test: text and tools mutated after extraction
arrive in the projection as the mutated values, beside a link. The rest cover pass-through of
remote URLs and file URIs, a no-ref body, one upload serving two refs, and four refusal cases —
no upload, four unusable URL forms with the URL asserted absent from every message, the shape
check preceding the map, and a hash with no link beside refs that have one.

Verified: `npm run typecheck` clean; `npm run build` clean; the new file 11/11 stable over three
runs; `npm run test:unit` **2120/2120** (0 skipped, 0 todo, 0 cancelled), +11 over the 2109
baseline.

Not wired yet, and deliberately so: this increment is the contract, not the transport. There is
no production caller, because §5.8's remaining half is the opt-in uploader (config surface,
streaming L2 upload, short-lived signed URLs, hash/size verification, best-effort delete after
the auth decision, log redaction, and the "if no external uploader is configured, preserve the
existing full-body auth behavior" gate). That increment also owns the wiring, and the wiring has
a constraint worth stating here: `src/index.ts`'s §5.3 shape-2 boundary rehydrates `bodyText`
before the deferred `doAuthRequest` reads it, so the projection has to be built *at* that
boundary, from the still-extracted body, ahead of the rehydration. `README.md` is deliberately
unchanged: no config surface was added.

### feat(spool): mid-stream response-failure reporting, plan §5.7

Twenty-third increment: §5.7's "failure after response streaming begins" now has the evidence half it
was missing. Both response tails in `src/server.ts` ended in `.catch(() => {})`, which swallowed a
rejected `pipeline()` whole (rule #8) — and the Node adapter owns the pipeline but has neither a logger
nor the request id. `src/utils/stream-failure.ts` is the one call it needs: `src/index.ts` attaches a
reporter to the response while `requestId`, `logger`, `path` and `finalResponse` are all in scope, and
the adapter consumes it in the `.catch`.

- **Two meanings of a tail rejection, and only one of them is silent.** A client hang-up rejects the
  pipeline with `code: 'ERR_STREAM_PREMATURE_CLOSE'`; that is the ordinary case and it logs nothing.
  Every other rejection is reported, because swallowing a genuine upstream or disk failure is the worse
  outcome and a false log line is far cheaper than a missing one. The classification was established
  empirically rather than assumed: with a source error after the first chunk the pipeline rejects with
  the source's own error and the client observes an aborted connection either way, and `res.destroyed`
  is `true` in both cases — so the error code is the only usable signal, and the silent set is exactly
  that one code.
- **The line carries the request id, the stage and the cause**:
  `[req_…] [ERROR] [OUT] <endpoint>: response stream failed after headers were sent: <message>`. The
  stage label is `PIPELINE_STAGE_LABEL.outbound` from `src/utils/logger.ts`, which this increment
  `export`s instead of letting the new module keep a second copy of `'OUT'`.
- **A non-`Error` rejection is reported too**, by `String(error)` — the adapter can reject with
  anything, and "not an Error" is not a reason to drop the record.
- **A second symbol smuggle rather than a shared metadata map.** The mechanism mirrors
  `ACTIVE_REQUEST_RELEASE` in `src/utils/dashboard-stats.ts` exactly: the handler attaches a closure the
  adapter cannot build itself, the adapter consumes it once. The two paths keep separate symbols because
  they have nothing in common beyond "the server needs a closure the handler owns", and a general
  metadata map would be an abstraction for two callers (rule #2).
- **The failure report is not on the cleanup path.** `release()` still runs in the `.finally`, so the
  in-flight counter unwinds whether the body succeeded, failed or was cut off; the reporter is
  observation only, and it never throws out of the `.catch`.

The visible change is a behavior change for the client, and it is the right one: a body that fails
mid-write now destroys the connection instead of quietly ending, which is what the old
`passthrough.end()` failure mode produced — a silently truncated body the client could read as a
complete one.

`tests/unit/stream-failure.test.ts` is new (5 tests). Two unit tests pin the exact log line (request
id, `[OUT]` stage, endpoint, the spill's own byte counts) and that a second consume returns
`undefined`, and that the `ERR_STREAM_PREMATURE_CLOSE` rejection logs nothing at all; a third pins that
a bare string rejection is still reported. The first end-to-end test is the §12 item itself: a real
16 MiB upstream body spilled above a 64-byte `threshold_bytes`, truncated to 0 by the client the moment
the first chunk arrives, so every later spill read comes up short while a genuine partial body has
already been delivered. It asserts the client saw an aborted connection (`incoming.complete === false`
plus an `aborted`/`ECONNRESET` socket error) with a byte count strictly between 0 and the body size, the
received prefix's sha256 against the same prefix of the source pattern, exactly one `[ERROR]` line
matching the expected shape, an empty `responses/` directory, `getLiveSpillBytes() === 0` and the
in-flight count back at its baseline — so the failing case is proven to release its spill and its
reservation, not merely to log. The second end-to-end test covers the silent half: an SSE upstream that
yields one frame and never closes, destroyed by the client mid-stream, must log no `[ERROR]` line at all
while still cancelling upstream. The file's `afterEach` asserts both ledgers are empty, so a leak fails
loudly there instead of widening a later test.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **2109/2109** (0
skipped, 0 todo, 0 cancelled), +5 over the 2104 baseline.

Two things flagged rather than changed. The reporter is attached to every response in `src/index.ts`
although only responses the adapter actually pipelines can use it; attaching it conditionally would mean
`src/index.ts` knowing which routes stream, which it currently does not need to. And the SSE half of
§12's item is covered only from the client-disconnect direction: whether a mid-body *upstream* error is
turned into a terminal `response.failed` event by `src/handlers/messages.ts`'s own catch is unverified,
and building a test on unverified handler behaviour would be guesswork.

`README.md` is deliberately unchanged: the increment adds no config surface, and the README's spool
bullet already says a spooled response body is freed once the client has taken every byte, aborted, or
the read failed — which is exactly what the failing case now proves.

### feat(spool): ref-aware token estimation, plan §5.3

Twentieth increment: §5.3's **binary token contribution** — how many tokens a payload contributes once
the spool has replaced it with a `BlobRef` — is now implemented in `src/utils/token-counting.ts`. The
`image` and `document` branches recognise a ref at `source.data` and count it by the §5.3 rule instead
of interpolating it into the label text (where it would have arrived as `data: [object Object]` and
counted as nothing), and the fallback branch refuses a ref it has no binary position for.

- **The rule is exactly `ceil(size / charactersPerToken)`.** The ref's `size` is the base64 character
  count, which is also the blob's byte count because base64 is ASCII, so the arithmetic needs no read.
- **The blob is deliberately never read, and the tokenizer is skipped.** Reading the payload to
  tokenize it would undo the extraction that produced the ref; the same reasoning rules out tiktoken,
  even when a tokenizer is configured.
- **Every fixed block cost is dropped**: the field labels, the media/source type, the `data:` prefix,
  and the former image `+20` / document `+10` overhead. A ref'd image and a ref'd document of the same
  payload length therefore count the same.
- **The result need not match the same body counted inline.** §5.3 accepts that this is an
  approximation of a number that no longer has exact meaning, and upstream-reported usage still wins
  whenever it is present.
- **Every other allowlisted position is refused, not measured.** A Chat `image_url`, a Gemini
  `inline_data` part or a Responses inline file is not a Claude content block, so it reaches the
  `JSON.stringify(block)` fallback — where a ref would be counted as its own metadata object, the
  invisible undercount §9.3 rejects. Those blocks now throw an `[spool]`-prefixed error naming the
  block type and the number of refs. The guard is scoped to that one branch on purpose: the `image` and
  `document` branches count refs, `text`/`thinking`/`tool_use`/`web_search_result` read names no
  allowlisted position writes (a ref there can only be one a client forged), and `tool_result` recurses
  into its nested blocks, which are guarded in turn.
- **A malformed ref throws instead of counting `NaN`.** `assertRefShape` runs before the arithmetic, so
  a fractional `size` or a missing `prefix` is an error rather than a count that silently becomes `NaN`
  for the whole request.
- **This increment lands caller-less, and that is expected.** Refs do not survive the §5.3 shape-2
  send boundary — `src/index.ts` rehydrates the body before handler dispatch — and the only
  `countClaudeRequestTokens` callers pass Claude-shaped bodies from the live request. So the branch is
  a consumer contract ready for shape 3, in the same state as §5.2's clone, §5.4's leaf count, §5.7's
  and §5.9's primitives. It also means no production count changes today.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **2094/2094** (0
skipped, 0 todo, 0 cancelled), +10 over the 2084 baseline. The new `describe` in
`tests/unit/token-counting.test.ts` (10 tests) asserts the exact `1000` for a 4000-byte payload on both
`image` and `document` (so neither surcharge survives) and their equality, exact counts under
`charactersPerToken: 4/10` against a text block that keeps its `+5` overhead, a dangling hash counting
fine against an empty store (no read), a 4000-char payload counting `1000` where the same text through a
one-token-per-character tokenizer counts `4000` (no tiktoken), the `BlobStoreError` for a fractional
`size` and a missing `prefix`, the refusal of a Chat and a Gemini position naming `'image_url'` and
`'untyped'`, a ref nested in `tool_result.content` contributing its binary count, the same contribution
inside `countClaudeRequestTokens`, and one real `extractInlineBlobs` round-trip where the recorded
`size` is the base64 length and the count is `ceil(size / 4)`. Two mutations were checked against the
suite: hardcoding the divisor to `4` or adding the image `+20` back fails eight of the ten tests, and
dropping the `inlinePayloadRef` lookup, the `assertRefShape` call or the fallback guard fails all ten.

Two things flagged rather than changed. `tests/unit/token-counting.test.ts`'s existing coverage of the
inline `+20`/`+10` surcharges asserts only `img > doc` — too weak to catch a swapped constant (rule #7);
the new tests assert exact values and the old one is left alone (rule #3). And the guard's loudness ends
at `src/handlers/messages.ts`, whose `estimateInputTokens` catches any counting failure and returns `0`,
so a refused ref degrades that endpoint's answer rather than reporting the error. That catch-to-0 is
pre-existing and unchanged here, but it means the guard is only as loud as its eventual wiring.

`README.md` is deliberately unchanged: the change adds no config surface and no observable behavior
while refs cannot reach a token counter.

### feat(spool): byte admission around the materialized response body, plan §5.9

Twenty-second increment: §5.9's nominal RAM budget now also covers the **non-SSE response body** on the
`/passthrough/*` identity path. `src/handlers/passthrough.ts` calls `admitMaterialization` once the
upstream body has been received and holds the lease across `readText()` and the usage parse.
`src/utils/spool-admission.ts` is unchanged.

- **Where the reservation is taken.** After `receiveResponseBody` resolves and before `readText()`, the
  same "receive, then reserve before read" order as the request path (increment 21) — a response's size
  is not knowable before it has been received, so this is the earliest point at which the budget can be
  consulted at all. The charge is `received.size`, the bytes actually received, never the
  `Content-Length` the upstream claimed.
- **What the wait bounds, and what it does not.** The wait happens with the body already received: on
  disk for a body above `threshold_bytes`, in the spool's memory branch below it. So for a spilled body
  this is §5.9's "queue while the raw body remains on disk", and for a small body the receive copy
  already exists when the reservation is taken — the budget cannot un-materialize it, only bound the
  parse, the usage record and the re-serialization that follow. §5.9's "pause upstream response reads
  while their admission is waiting" is therefore **not** implemented: the receive loop has to finish
  before there is a size to admit against. Whether the receive loop itself should hold a speculative
  reservation from the first chunk is a design question, not an oversight.
- **Release before the client's stream exists.** The lease is released in a `finally` around the read,
  the trace logs and the usage parse, and `new Response(received.readStream(), …)` is built afterwards —
  so no budget is held while the proxy writes to the client, whose pace is not the proxy's to bound
  (§5.9: "stream spool upstream/client with no admission held"). This is a deliberate difference from
  the request path, where the lease is held to the request's `finally`: the request body re-materializes
  at the §5.3 shape-2 send boundary, whereas the response body here is handed out as a stream over the
  spill and is never materialized again.
- **A refusal gives the spill back.** `received.release()` runs before the `AdmissionOverBudgetError` is
  rethrown. Without it a refused response would leave its bytes on disk and its `max_total_bytes`
  reservation held (rule #8): the spill has no other owner once the handler gives up. At the handler
  boundary the refusal is an `AdmissionOverBudgetError` (`status` 503, `type` `over_limit_error`); the
  route-level catch turns it into the standard error envelope, like the request path.
- **Budget arithmetic the operator now has to get right.** The request's own lease is still held while
  the response is received and parsed (it is released in `src/index.ts`'s request-end `finally`), so
  `max_materialized_body_bytes` has to cover request + response nominal bytes together. A budget sized
  for one body admits the request and then refuses the answer, after the upstream work is paid for.
  Per-rung reacquisition (§5.9's "reacquire at each rung") is the fix and is still open.

Not in this increment: SSE responses are still unadmitted — the streaming branch relays upstream
`pipeThrough` without ever materializing the whole body, which is what §5.9 asks for, and
`streamResponseEvents` (the path that would admit per event) remains caller-less. The upstream **error**
body on the non-OK branch (`!response.ok` → `response.text()`) is also left alone: it is read for a log
preview and for `handleTargetApiError`, and refusing it would replace the upstream's own 4xx/5xx with a
503 about the proxy's budget, which is a behavior change nobody asked for. That read is unbounded and
stays a known gap.

Tests: `tests/unit/passthrough-response.test.ts` gains a `passthrough non-SSE response, byte admission
(§5.9)` block. The exact charge is pinned by sampling the ledger from inside the usage-record fetch —
which runs in the materialized window — against a budget equal to `ceil(bytes × 2)`; the same fixture
with one byte less budget must refuse with `over_limit_error` and `/exceed max_materialized_body_bytes/`,
leaving `spillFiles()` empty and `getLiveSpillBytes()` and `getAdmittedBytes()` at 0 (a leak would show
on both ledgers). A third case pins independence from `[spool] enabled` (budget enforced, nothing
spilled), and a fourth pins that the configured `materialization_factor` is what decides: the same
budget refuses the same bytes at factor 3 and admits them at factor 2, byte for byte. The suite's
`afterEach` now asserts the admission ledger is empty too, so a leaked lease fails loudly in a later
test rather than silently widening the budget.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` 2104/2104 (0 skipped,
0 todo, 0 cancelled) — +4 over the 2100 baseline.

`README.md`'s `[spool]` bullet is corrected rather than left standing: it claimed response bodies "are
not spooled yet (Phase 2), so `enabled = true` does not change response-side memory", which stopped
being true when the §5.7 non-SSE path landed, and it documented none of the §5.9 knobs. It now states
what the response side does, and names `max_materialized_body_bytes`, `materialization_factor`,
`max_admission_queue` and `admission_timeout_ms` with their defaults.

### feat(spool): byte admission wired into the request path, plan §5.9

Twenty-first increment: §5.9's nominal RAM budget is now **enforced by the request path**. `src/index.ts`
calls `admitMaterialization` once the raw body has been received and holds the lease until the request's
`finally`, so the controller from increment 19 is no longer caller-less. `src/utils/spool-admission.ts`
is unchanged.

- **Where the reservation is taken, and why there.** Immediately after `receiveIngressBody` resolves and
  *before* `spool.readBytes()` rebuilds the request. Three sites were weighed: (a) here, (b) after the
  whole receive block, (c) in the routing parse block, which is where §5.9's pseudo-code puts it
  ("reserve … before read/parse"). Only (a) reserves before the first materialization: at (c) the text
  has already been read and parsed, so the reservation would be taken after the allocation it exists to
  bound, and at (b) the rebuild copy is made uncharged. (a) also keeps admission independent of
  `[spool] enabled` — the receive path materializes a body whether or not the store writes it, so a
  reservation placed inside the §5.4 extraction block (which is gated on `enabled`) would have
  silently disabled itself in the store-off configuration §9.1 makes the default.
- **The charge is the raw received size.** `spool.size` is the byte count the client sent, which is
  §5.9's `B`; `materialization_factor` (default 2.0) is the conservative guess at decoded text plus
  parsed objects plus serialization copies on top of it. Extraction shrinking the body does not shrink
  the charge — the reservation is taken before extraction is known.
- **Held to the request-end `finally`, not released after extraction — a deliberate narrowing of
  §5.9.** The plan's pseudo-code releases the reservation "binary reduced to refs: release after
  extraction". That is not done, because §5.3 shape 2 rehydrates every ref at the send boundary: a
  binary body carries its full payload bytes again before the request ends, so an early release would
  leave exactly the largest allocation of exactly the requests this budget exists for uncharged — 30
  concurrent 200 MB image bodies would show a zero ledger at their peak. One rule, hold until the
  request's objects are unreachable, then covers both this case and the non-ref case §5.9 already
  describes that way. Flagged as open: if the plan is meant literally, this is the deviation to
  revisit.
- **The release still precedes client streaming, which is what §5.9's "no admission held during
  network/SSE streaming" protects.** The `finally` runs before `server.ts` consumes the returned
  Response's body, so neither a slow client nor a long-lived SSE response holds a reservation while it
  streams, and the budget is not a cap on concurrent SSE connections.
- **Every refusal is a loud `503 over_limit_error`, and no path leaks a reservation.** An admission
  error is a `ClaudeProxyError`, so the receive block's `createErrorResponse` maps it to its own status
  and type, and the block's log line is split so a refusal is reported as `Request body not admitted: …`
  rather than as a bad body (rule #8). A body that never parses releases through the same `finally`; the
  test proves it with a follow-up request whose charge exactly equals the whole budget, which is
  admitted — a leaked reservation would have made it queue and time out.
- **Flagged, pre-existing and not changed here.** That refusal path emits the Anthropic-shaped error
  envelope for `/v1/responses` too, while the outer catch branches to `createResponsesErrorResponse`;
  the parse-block catch has the same shape. Also worth knowing before tuning: with the store off (the
  default) nothing spills, so §5.9's "queue while the raw body remains on disk" is only literal for a
  body past `threshold_bytes` — a below-threshold body queues with its bytes in the spool's memory
  branch.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **2100/2100** (0
skipped, 0 todo, 0 cancelled), +6 over the 2094 baseline. `tests/unit/index-admission.test.ts` (new, 6
tests) drives the real handler, since the wiring is what is under test: a body one nominal byte over
the budget is refused 503 `over_limit_error` before anything is sent or extracted (0 upstream calls, 0
blob-store entries, ledger 0), with the store both on and off; a `materialization_factor` of 3 is
observed as the exact `ceil(bytes × 3)` charge sampled *inside* the upstream fetch, i.e. while the
parsed body and its serialization are both live; with the store off the resolved config is asserted
`enabled === false` and the charge is still `ceil(bytes × 2)`; a second body arriving while the first
holds the whole budget queues and is refused `admission timed out after 60 ms` without reaching the
upstream, and the first request's release then leaves the ledger at 0; a body that fails to parse
releases; and for a `stream: true` request the ledger is sampled after the handler returns and before
the client reads the body — 0, with the stream then intact through `event: message_stop`. Rule #7: the
refusal tests assert the envelope structurally (top-level `type: 'error'` carrying
`error.type: 'over_limit_error'`), which is the shape `createErrorResponse` actually produces; the
ordering assertions (charge held at send time, ledger 0 before the body is read) are direct
observations of the ledger, not re-statements of the code under test.

### feat(spool): optional byte admission, plan §5.9

Nineteenth increment: §5.9's **nominal materialization admission** — the operator's hard RAM budget
around full-body materialization — now exists as `src/utils/spool-admission.ts`
(`admitMaterialization`, `AdmissionLease`, `getAdmittedBytes`, `getAdmissionQueueDepth`,
`resetAdmission`). It lands **caller-less**, like the two increments before it: §5.9 reserves *before*
the request path reads and parses a body, and threading that reservation through the transformation
rungs — with §5.9's reacquisition for a rung that starts from an effective spool — and releasing it
before network streaming is its own change. The config surface for it already existed (§5.6), so no
config work was needed: `max_materialized_body_bytes`, `materialization_factor`, `max_admission_queue`
and `admission_timeout_ms` were parsed and defaulted but had no consumer until now.

- **Off by default, and independent of `[spool] enabled`.** `max_materialized_body_bytes = 0` (the
  default) admits everything with no ledger, no queue and no wait, so the no-body-semaphore behavior
  is what runs unless an operator opts in (§9.1). When a budget *is* set it is enforced even with
  `enabled = false` — `enabled` decides whether bytes go to disk, the budget decides how many of them
  may be materialized at once, exactly as the per-body caps behave.
- **The reservation is `ceil(bytes × materialization_factor)`.** The factor, not the byte count, is
  the conservative guess at decoded text plus parsed objects plus serialization copies, and it is what
  the ledger charges — `getAdmittedBytes()` never exceeds the budget, and a batch of admitted bodies
  cannot add up past it.
- **A hard cap in arrival order, with no queue jumping.** A body is admitted only from the head of the
  queue: a 100-byte body is not admitted past a waiting 900-byte one even though it would fit in the
  bytes free right now, because "first body that fits" is how a byte budget starves its own queue. A
  body with a 0-byte reservation (an empty body) is the one exception — it takes nothing from anyone, so
  it never waits and never holds a queue slot.
- **Bounded wait, bounded queue, refusal before anything is materialized.** Waiting is bounded by
  `admission_timeout_ms` and the queue by `max_admission_queue`, and both refusals arrive before the
  caller has read a byte, so they can still be answered as a response. A client abort (`AbortSignal`)
  drops a queued waiter and rejects with the caller's own reason. A waiter that times out is taken out
  of the queue and the next waiter is re-checked immediately, so the head it frees is not lost.
- **Decisions taken here.** (1) Every refusal is `503 over_limit_error`, like the spill and blob
  capacity errors — §5.9 allows 429 or 503, and one status for the whole byte-budget family keeps the
  answer independent of the direction the body travels, since the budget covers requests, responses and
  SSE events alike (the direction-dependent cap errors elsewhere are *parameters* for exactly that
  reason). (2) A body whose nominal reservation exceeds the whole budget is refused at once
  (`AdmissionOverBudgetError`) rather than queued: no wait can admit it, and reporting it as a timeout
  30 s later would be a false report of what happened (§5.9's "never begin materialization after
  rejection"). All three refusals are loud and typed — `AdmissionOverBudgetError`,
  `AdmissionQueueFullError`, `AdmissionTimeoutError`.
- **A lease is released exactly once, and a reset strands nothing.** Leases are idempotent, so a
  `finally` that runs after a successful path cannot double-credit the ledger, and the ledger throws on
  underflow instead of clamping it. `resetAdmission()` — what a restart means for admission, since no
  reservation survives one (§5.9) — voids outstanding leases through a generation counter, so a lease
  from before the reset gives nothing back, and *rejects* the waiters it strands rather than leaving
  their promises pending.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **2084/2084** (0
skipped, 0 todo, 0 cancelled), +12 over the 2072 baseline. `tests/unit/spool-admission.test.ts` (new, 12
tests) covers the disabled budget charging nothing and queueing nothing regardless of body size, the
exact `ceil(bytes × factor)` charge including a fraction that rounds up, the cap held under an
interleaved sequence of admissions and releases (600+400 admitted, then 250+250 queued, then drained
head-first), a small body pinned behind a waiting large one, the over-budget refusal naming the budget
with the queue left empty, the queue-full refusal leaving the two waiters ahead untouched,
`AdmissionTimeoutError` after 20 ms with the freed head admitting the waiter behind it, client abort
delivering the caller's own reason with the queue and ledger intact, an already-aborted signal
rejecting without queueing, an empty body admitted immediately despite a waiting queue, and
double-release plus reset semantics (idempotent release, voided leases, stranded waiters rejected).
Two mutations were checked against the suite: letting a fitting body jump the queue fails the
arrival-order test and the timeout-drain test, and removing the post-timeout drain fails the timeout
test — so the two properties the wiring will depend on are actually pinned.

Still outstanding from §5.9: the wiring itself — reserving in `src/index.ts` before the ingress read and
parse, retaining through sidecars/serialization for non-ref exchanges while releasing right after
extraction for binary ones, reacquiring per rung, pausing upstream response/event reads while waiting,
and releasing before network streaming. `README.md` is deliberately unchanged: the knob is parsed but
inert until that wiring lands, and documenting a budget that does nothing yet would misdescribe the
proxy's behavior.

### feat(spool): per-event SSE framing and spill, plan §5.7

Eighteenth increment: §5.7's SSE path — "frame one event at a time, spill an event above
`threshold_bytes` to disk while receiving it, and enforce `max_response_bytes` per event" — now exists as
`src/utils/spool-events.ts` (`streamResponseEvents`), together with the `events/` spill directory it
writes to. The increment lands **caller-less**: the primitive is pinned by tests of its own before the SSE
handler is rewired onto it, so the framing and the spill cannot regress unnoticed while that wiring is
decided.

- **Each event is received through the shared loop.** `receiveSpooledBody` is called once per event with
  `subdir: events/`, `filePrefix: 'evt-'`, `maxBytes: max_response_bytes` and
  `TooLargeError: SpoolResponseTooLargeError`, so the capacity ledger, the reservation, the spill file
  and the breach error class are the ones the request and response directions already use — no second
  copy of the loop (rule #4).
- **The framing is byte-exact, and the delimiter belongs to the event.** An event ends at a blank line
  (`\n\n`), and those two bytes are emitted as part of it, so the concatenation of what the client
  receives is byte-identical to the upstream stream. Framing is done on bytes rather than on decoded
  text: an invalid-UTF-8 payload survives, and no `event:`/`id:`/`[DONE]` line is lost to a JSON
  re-serialize.
- **A blank line split across two chunks still frames.** The module carries whether the last byte it
  handed out was `\n`, so a chunk that *starts* with `\n` completes the delimiter and only that one byte
  closes the event. Without the carry, a chunk boundary between the two newlines either never closes the
  event or closes it early — the case the chunk-size-1 test pins.
- **At most one event is on disk at a time.** The event currently being received may be spilled (above
  `threshold_bytes`); its bytes are handed over only once it is complete, and the spill is deleted as the
  bytes leave. Disk use is therefore bounded by one event, not by the length of the response: this is a
  per-event spool, not an accumulation of the SSE response on disk, which §9.5 rejects.
- **A response-side breach is 500 `processing_error`, and enforcement is independent of `enabled`.** As
  on the response path, the client's request was legal, so a cap breach is not a 4xx; `enabled` gates
  *spilling* only, never the cap. A breach is propagated as a rejected read, so it errors the stream for
  the consumer instead of truncating the response — and because the failure then lands after streaming
  has begun, no terminal `data: [DONE]` is emitted for it.
- **Backpressure at both levels.** The framed-event stream and the returned stream are both pull-driven
  `ReadableStream`s at `highWaterMark: 0`, one `enqueue` per pull, so a stalled client stops the upstream
  reads rather than letting later events queue in RAM. A client cancel forwards the reason upstream and
  releases the spill of the event being written.
- **`events/` is swept like the other spill directories.** `spool.ts` now declares
  `EVENT_SPILL_SUBDIR`/`eventSpillDir` alongside the request and response directories, and
  `sweepStaleSpills` covers all three, so a spill left behind by a killed process is collected at the
  next startup like any other.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **2072/2072** (0 skipped,
0 todo, 0 cancelled), +9 over the 2063 baseline. `tests/unit/spool-events.test.ts` (new, 9 tests) covers
byte-exact relay at chunk sizes 1/2/3/7/40/all (length + sha256 + text, so no boundary is lost), framing
with spilling disabled and nothing written to disk, an event the upstream never terminated, the spill
landing on disk with the exact event's bytes charged to `max_total_bytes` and then deleted, only one
event on disk at a time over four oversized events, a client cancel reaching the upstream with the spill
removed, an event exactly at the cap passing while one byte past it raises `SpoolResponseTooLargeError`
(500 `processing_error`), an event breaching the cap mid-stream aborting with `data: kept\n\n` delivered
and no `[DONE]`, and a stalled client causing zero further upstream reads. `tests/unit/spool.test.ts`'s
aggregate sweep test now spans all three spill directories (3 removed, 1 kept).

Still outstanding from §5.7: the SSE handler wired onto this primitive, and the same
"abort rather than emit a terminal `[DONE]`" rule applied at the handler level. Open question surfaced for
the wiring: should per-event framing and the per-event cap apply when `[spool] enabled = false`, and must
CRLF-framed streams be recognized (the module currently matches the forwarding family's `\n\n`, unlike
`dashboard-stats.ts`, which normalizes `\r\n`)?

### fix(spool): demand-driven SSE event transform, plan §5.7

Seventeenth increment: the last response transform that still "unconditionally enqueue[ed]" —
`pipeEventTransformer` in `src/utils/request-transform.ts`, which rewrites each `data: {...}` event of
the writeout (`response_egress`) SSE stream — now waits for downstream demand, and its double-emitted
`data: [DONE]` sentinel is fixed. It was a detached `start()` loop reading upstream as fast as the
upstream could send and enqueueing every event into its own queue, so a client slower than the upstream
left the rest of the response sitting in RAM, exactly as §5.7 describes.

- **Pull-driven, `highWaterMark: 0`.** One `pull` reads upstream only while a consumer is waiting,
  transforms that chunk's events, and hands over exactly one byte chunk; whatever the chunk produced
  beyond it waits for the consumer's next read. `fill()` loops rather than reading once, because a chunk
  boundary that cuts an event in half produces no complete event — a single read would stall the stream
  there.
- **`data: [DONE]` is emitted exactly once.** The sentinel is not a payload, so it is never parsed or
  transformed; it flows through the data-less branch and is re-emitted verbatim, byte-faithful to its
  original spelling. The old code enqueued it from the sentinel branch *and* then re-emitted the whole
  event from the data-less branch, so every upstream sentinel reached the client twice. The dead
  `terminated`/`otherLines` locals (both `void`ed) went with it.
- **A client disconnect reaches upstream.** The stream gained a `cancel(reason)` that forwards the reason
  to `reader.cancel(reason)`. The old source had no `cancel` handler, so a consumer cancel never touched
  upstream and the detached loop only happened to stop when its next `controller.enqueue` threw into the
  already-cancelled stream — with that error swallowed by the `catch` (rule #8).
- **Upstream failures still surface.** With no `catch` around the read, a rejected `reader.read()` errors
  the output stream and reaches the consumer as a rejection, rather than being folded into a value that
  nobody observes.
- **Opt-in, unchanged in scope.** The fast path still returns `null` when no transform declares
  `response_egress`, so nothing is wrapped on routes that do not use it; `src/index.ts:2611` remains the
  only production call site.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **2063/2063** (0 skipped,
0 todo, 0 cancelled), +4 over the 2059 baseline. `tests/unit/request-transform.test.ts` gained four
tests: the sentinel appears exactly once (exact output equality); an event split across two upstream
chunks is neither duplicated nor lost, with exactly one upstream read per chunk; a consumer that stalls
after the first frame causes no further upstream reads however long it waits, and resuming yields every
remaining event in order; and a consumer cancel delivers the disconnect reason upstream and stops the
reads. Swapping the old implementation back in fails all five touched tests — `not ok 2` (the
strengthened rename test: the sentinel arrives twice), `not ok 5–8` — the old transform reads two chunks
before the consumer's first read resolves, then after the stall has drained the source. A separate probe
against the old file confirmed the cancel bug directly: the reason never reached upstream
(`<never cancelled>`) and the loop died on an enqueue into the cancelled stream. The new file was then
restored byte-identically (`diff` clean). One pre-existing test was renamed: "drops events when
transformer returns null" asserted `notEqual(dropped, null)` and called `buildEventTransformer` directly,
so it now says what it checks — and the null-drop branch it claimed to cover is in fact unreachable, since
every op yields a body and no builtin returns `null`.

Still outstanding from §5.7: SSE per-event framing/spill with `max_response_bytes` enforced per event,
"abort the connection rather than emit a terminal `[DONE]`" when the failure lands after streaming has
begun, and the `events/` spill subdirectory wired into `sweepStaleSpills`. (The framing/spill and the
sweep landed in the eighteenth increment, above; the handler-level abort is still outstanding.)

### fix(spool): demand-driven keep-alive injection, plan §5.7

Sixteenth increment: §5.7's last named requirement — "Keep-alive injection and all response transforms
must likewise wait for downstream demand rather than unconditionally enqueueing" — is met for the
keep-alive wrapper, on the default SSE path. `wrapSseStreamWithKeepAlive` read upstream from a detached
`start()` loop and enqueued every chunk as it arrived, with a `setInterval` that enqueued pings into the
same queue. When the client was slower than the upstream, the wrapper's own queue therefore held the rest
of the response in RAM — pings included — and the read loop never paused; a probe against the old shape
grew past 4 GB. Disk cannot bound that queue, which is exactly why the plan names it.

- **`src/utils/sse-keepalive.ts` is now a pull-driven stream with `highWaterMark: 0`.** Each `pull`
  produces exactly one thing: the next upstream chunk if it arrives within the remaining silence window,
  otherwise a ping. Nothing reads upstream except a pending downstream read, so the client's pace is the
  only thing that pulls the response forward.
- **Ready data wins the race with the ping deadline.** The pull computes
  `waitMs = max(0, lastChunkAt + intervalMs - Date.now())` and races a parked upstream read against that
  deadline — a chunk the source has already queued settles in a microtask, the deadline only in a timer
  phase — so `intervalMs <= 0` cannot starve the upstream or emit an immediate ping per pull.
- **A parked read is never lost or unobserved.** `pending` is cleared only when its outcome is consumed,
  so a chunk that arrives while a ping window is open is forwarded by the next pull, in order. The read's
  rejection is folded into a `ReadOutcome` value and handed to `controller.error()` when it is consumed:
  an unobserved rejection (Node's default `--unhandled-rejections=throw`) would otherwise take the process
  down before the consumer asked for anything, so the failure still surfaces loudly (rule #8).
- **A withdrawn consumer is respected.** A `cancelled` flag stops a pull that was parked across a ping
  from enqueueing or closing on a stream the consumer has already cancelled.
- **The race timer stays ref'd, deliberately unlike `src/rpc.ts:300`.** That poller unrefs because its
  work must not keep the process alive on its own; our timer is the only thing that can settle a read a
  pull is already holding, so unref'ing it let an idle event loop walk away from a waiting consumer —
  which is how the first run of the new tests reported `cancelled`, not `ok`. It is cleared as soon as
  the read wins, so it never outlives one interval.
- **Both call sites are on the default path** — `src/index.ts:2578` (central SSE branch) and
  `src/handlers/passthrough.ts:350` (piped after the usage-tracking transform) — so this bounds memory
  whether or not spooling is enabled.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **2059/2059** (0 skipped,
0 todo), +1 over the 2058 baseline. `tests/unit/sse-keepalive.test.ts` gained three tests: a stalled
consumer stops upstream reads (a source with `highWaterMark: 0` counts the reads the wrapper asked for —
`1` while stalled, `5` after resuming, and the remaining frames arrive in order and unchanged); a silence
of two and a half intervals yields exactly one ping, on demand, and the next ping waits a fresh interval
rather than being already queued; and an upstream error raised while the consumer is stalled reaches the
consumer as a rejection instead of an unhandled one. Swapping the old implementation back in gives
`ok 1–4`, `not ok 5`, `not ok 6` and a cancelled 7 — the two backpressure tests fail loudly against it —
after which the new file was restored byte-identically (`diff` clean). The four pre-existing tests pass
unchanged. `tests/unit/server.test.ts` gained one integration test that puts the wrapper in the real
egress chain (`Response` body → `Readable.fromWeb` → `pipeline` → socket) and reads it in stages: every
byte arrives in order, exactly once, and the response terminates, so a `highWaterMark: 0` body cannot
deadlock a paused real client. That test is a regression guard on ordering, completeness and termination,
not on backpressure — the old implementation passes it too; the backpressure property is pinned at the
stream level, where it is deterministic rather than dependent on kernel send-buffer sizes.

Still unconditional: `pipeEventTransformer` in `src/utils/request-transform.ts` remains a `start`-driven
detached loop (opt-in via a `response_egress` transform), and it double-emits `data: [DONE]`. Both are
next.

### feat(spool): the §5.7 non-SSE identity response path, end to end

Fifteenth increment: the identity half of §5.7's non-SSE responses now has a production caller. "Above
the threshold, stream the upstream body to a per-response spool while counting bytes; do not call
`response.clone().text()` or buffer a second copy. Identity forwarding may stream the original response
spool directly without parsing." `receiveResponseBody` was written in the previous increment and was
caller-less; `SpoolBody.readStream()`, `src/handlers/passthrough.ts` and `src/server.ts` complete it, so
`threshold_bytes` and `max_response_bytes` are enforced on the live passthrough response path.

- **`SpoolBody.readStream()` in `src/utils/spool-body.ts`** is the accessor §5.7 needed: it hands the
  body out a chunk at a time — `BLOB_STREAM_CHUNK_BYTES`, the 64 KiB the blob store already streams
  with, reused rather than re-declared (rule #4) — so the client's socket, not a buffer, sets the pace.
  The stream takes ownership of the spool: the spill is released (file removed, `max_total_bytes`
  reservation returned) when the last byte has been read or the stream is cancelled, while `release()`
  stays idempotent so a caller may still release on its own terminal path.
- **Release before the stream reports completion.** `controller.close()` resolves the consumer's pending
  read immediately, so releasing after it let `await response.arrayBuffer()` return while the spill was
  still reserved and still on disk. The new suite caught exactly that (`getLiveSpillBytes()` non-zero
  after a completed read, spill file still present); the order is now `await finish(); controller.close()`.
  The spilled path closes its read handle before releasing, because `release()` removes the file.
- **A short spill fails loudly.** A spill that ends before its byte count would otherwise be forwarded
  as a whole body; the read raises `SpoolWriteError` instead (rule #8), and the failure path closes the
  handle and releases like every other terminal path.
- **The request side still may not use it.** `readStream()` exists for a client-socket consumer only;
  §5.1 rejects `new Request(url, {body: fileStream})` followed by `.json()` because undici buffers that
  stream in full, so ingress keeps reading bytes at the point of use. The module header says so.
- **`src/handlers/passthrough.ts` forwards the spool.** The non-SSE branch receives the upstream body
  with `receiveResponseBody(response.body)` and answers with `new Response(received.readStream(), …)`.
  Parsing for usage recording is now the one remaining copy of the body, and `max_response_bytes` caps
  it: a breach cancels the upstream body and fails 500 `processing_error` rather than truncating.
- **`src/server.ts` pipes the non-SSE path too.** The old `await response.clone().text()` held a second
  full copy of every non-SSE body — a spooled response included — for as long as the client took to
  accept it; `pipeline(Readable.fromWeb(response.body), res)` with `release()` in `finally` gives the
  upstream, or the response spool, the client's write pace. A bodyless response still takes the
  `res.end()` fast path.
- **Responses are treated as unknown-length.** Upstream `Content-Length` is stale after undici's
  automatic decompression, so it is not passed as `declaredLength`: no early rejection, and the body
  buffers only to `threshold_bytes` before spilling.
- **`max_response_bytes` is enforced whether or not spooling is enabled**, matching ingress: the cap is
  a body bound, `enabled` only decides whether disk is used. Behaviour change, deliberate: a response
  over the 64 MiB default now fails 500 `processing_error` instead of being forwarded.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **2055/2055** (0
skipped, 0 todo) — exactly +6 over the 2049 baseline. Six new tests in
`tests/unit/passthrough-response.test.ts` pin the identity contract: a sub-threshold body arrives
byte-for-byte (sha256 equal, so a parse-and-re-serialize would fail it) with every stale body header
dropped and no spill; a body above `threshold_bytes` lands in `responses/`, is charged to the ledger for
as long as it is live, and is byte-identical to the upstream with both the file and the reservation gone
once the client has read it; usage is still recorded from a spilled response (11/22/33 under the request's
model); a body past `max_response_bytes` throws `SpoolResponseTooLargeError` with status 500 and type
`processing_error`, cancels the upstream body, and leaves no partial spill; cancelling the body mid-read
frees the spill, which is what the Node adapter does on client disconnect; and a spill truncated on disk
fails the read with `SpoolWriteError` and hands the client not one byte. The request-side egress suite,
`spool-response.test.ts` and `server.test.ts`'s 15 tests pass unchanged.

Mutation gate: the spilled `cancel` release, the end-of-body release, the EOF branch, the short-read
guard, the in-memory chunk source, the handler's `receiveResponseBody` call and the adapter's non-SSE
`release()` were each neutralized in turn; each was caught by a named test, with the originals restored
and `diff -q`-verified against their snapshots. No survivors this increment.

Surfaced, not settled (repo rule #5): (a) the adapter keeps its two branches — the SSE branch's extra
`res.on('close', release)` safety net is not added to the non-SSE branch, because `tests/unit/server.test.ts`
pins `releaseCount === 1` from an unguarded callback and merging would double-call it; (b) the identity
path still parses the full body only to record usage, which is the one copy §5.7 leaves in place — a
streaming usage tap would remove it but is a separate decision.

### feat(spool): non-SSE response spooling, and the receive loop shared with ingress (§5.7)

Fourteenth increment: §5.7's response body path. "At or below `threshold_bytes`, retain the existing
bounded in-memory path. Above the threshold, stream the upstream body to a per-response spool while
counting bytes… Enforce `max_response_bytes` per body. On breach or disk failure, cancel the upstream
body and fail explicitly; never silently truncate the response." `receiveResponseBody(body)` now
delivers that, writing to a `responses/` spill directory under the spool root and bounding the body by
`max_response_bytes` rather than by the request limit.

- **The receive loop is written once.** §5.1 and §5.7 ask the same thing of a body — bound it, spill it
  past `threshold_bytes`, charge it to `max_total_bytes`, cancel the upstream on failure — so the loop
  moved to a new `src/utils/spool-body.ts` and takes exactly the four genuinely per-direction values
  (`subdir`, `filePrefix`, `maxBytes`, `bodyLabel`, plus the direction's `TooLargeError` class).
  `receiveIngressBody` is now a wrapper over it. The ledger, the capacity reservation and the error
  classes deliberately stayed shared: a second copy of the ledger is how one direction quietly stops
  being charged to `max_total_bytes`.
- **Ingress's public surface is unchanged,** including the `SpoolBody` class, which `spool-ingress.ts`
  re-exports as `IngressSpool` (`instanceof IngressSpool` is asserted by the ingress suite, so the
  re-export is a value re-export, not a type-only one).
- **The sweep now covers every spill directory.** `RESPONSE_SPILL_SUBDIR` and `responseSpillDir` are
  exported from `src/utils/spool.ts`, and `sweepStaleSpills` iterates both directories with one
  aggregate count. `SpoolSweepResult` gained no field: `dirMissing` was re-defined as "no spill
  directory existed at all" (`dirsSeen === 0`), which is what the existing result shape already meant
  and keeps the pinned `deepEqual` honest.
- **A response cap breach maps to 500 `processing_error`, not 413.** `SpoolResponseTooLargeError`
  follows the in-module convention for spool-side failures (`src/utils/ref-serializer.ts`,
  `src/utils/blob-store.ts`), which is also §5.7's framing — a cap breach and a disk failure are the
  same kind of failure. A 413 was rejected as a false report: the client's request was legal. The
  ingress direction keeps its 413, because there the body *is* the client's request.
- **No production caller yet.** `receiveResponseBody` is not wired into any handler, so
  `threshold_bytes` and `max_response_bytes` remain unenforced on the live response path. Identity
  streaming and the converted/streamed paths, the streaming read accessor, per-response cleanup on
  client abort, and §5.7's SSE per-event framing are the next increment.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **2049/2049** (0
skipped, 0 todo) — exactly +8 over the 2041 baseline. Five new tests in
`tests/unit/spool-response.test.ts`: the body is bounded by `max_response_bytes` and not by the
request limit; one byte past the cap fails both by declared `Content-Length` and by byte count, with
no partial spill left behind; a body above `threshold_bytes` lands in `responses/` as `resp-<uuid>.body`
byte-for-byte (sha256 equal) while `requests/` is never created, with the ledger returning to zero on
release; the prefix is preserved when an unknown-length body crosses the threshold mid-stream (the
file holds exactly the body, nothing double-written); and a mid-stream breach cancels the upstream,
removes the partial spill and leaves the ledger at zero. Two new tests in `tests/unit/spool.test.ts`
cover the sweep blast radius: a stale request spill, a stale response spill and a fresh response spill
under one call (`removed === 2`, `keptRecent === 1`, the fresh file byte-intact), and `dirMissing`
reported only when neither spill directory exists. The ingress suite's 78 tests and `spool.test.ts`'s
53 pass unchanged across the extraction.

Mutation gate: the response subdir, the `resp-` file prefix, the `Response` body label, the response
cap expression, the `TooLargeError` class, the sweep's directory list, the `dirMissing` expression, the
threshold-crossing prefix write and the release guard were each neutralized in turn; each was caught by
a named test, with the original restored and `diff -q`-verified against its snapshot. No survivors this
increment.

### feat(spool): the §5.7 response-binary allowlist, as a second predicate set

Thirteenth increment: §5.7's response-binary allowlist. "The initial response-binary allowlist is
deliberately separate from §5.4's request allowlist": Gemini response content parts with
`inline_data`/`inlineData.data`, for any declared MIME type (the model-generated image/audio/video
parts native Gemini passthrough preserves), and Responses output items with
`type: "image_generation_call"` and a base64 `result`, "whether encountered in a completed JSON
response or an SSE output-item event". New export `extractResponseBlobs(body)` in
`src/utils/blob-refs.ts`, returning the existing `InlineExtraction`.

- **A second finder, not a second module.** The eligibility rule (`JSON_VERBATIM_PAYLOAD`, so §5.3's
  shape-3 exact `Content-Length` holds), the all-or-nothing replacement loop, the walk, the unwind and
  the per-ref lease accounting are shared machinery, so they now live in one `extract(body, find)`
  and take the finder as a parameter: `positionsFor` (§5.4) and `positionsForResponse` (§5.7). Only the
  positions differ — including the `skipped` count for ineligible payloads, which is reported for
  responses exactly as for requests.
- **One kind name is shared; one is new.** `gemini-inline-data` is the one position both allowlists
  read, because the field *is* the shape on both sides: a Gemini content part declares no request or
  response discriminator, so `inline_data` identifies it in `contents[].parts[]` and
  `candidates[].content.parts[]` alike. `responses-image-generation-result` is new; `result` is read
  with form `'bare'` because the documented schema is bare base64 (a data-URL value would still
  round-trip exactly, since prefix plus payload reproduces the field byte for byte). `result` is
  `null` until a call completes, and a non-string is not a payload, so an in-progress item extracts
  nothing.
- **The request positions are *not* reused.** §5.7: "Claude assistant image blocks and OpenAI Chat
  Completions assistant image parts are not added: the documented schemas do not carry them. Do not
  use the request-side `source.data` predicate indiscriminately on responses." A test feeds a
  response-shaped body holding exactly those positions plus four `image_generation_call`s with a
  `null`, an empty, a numeric and a URL `result`: `extractResponseBlobs` yields `refs: 0` and leaves
  the body unchanged, while the same body through `extractInlineBlobs` takes the three request
  positions and still not the generated-image results — so the two allowlists are demonstrably
  different sets, neither absorbing the other.
- **No production caller yet.** This is the primitive §5.7 names; response *spooling* — threshold,
  per-event spill, `max_response_bytes`, abort and sweep semantics — is a later increment, as is any
  further response binary field, which §5.7 requires to arrive with "their own exact predicate and
  round-trip tests".

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **2041/2041** (0
skipped). Three new tests in `tests/unit/blob-refs.test.ts`: the four-position round-trip matrix (both
Gemini spellings in `candidates`, plus a `result` in a completed `output[]` and one inside a nested SSE
output-item event object — the walk reaches the event without a special case), asserting per-position
kind/size/empty-prefix, byte-identical rehydration on a clone, and that a response's blobs are
scratch: four leases released and four blobs evicted to zero; the request/response contrast above; and
the same `inline_data` part read through either allowlist to the same hash — one blob under two leases.

Mutation gate: falling back to the request finder, dropping the `image_generation_call` predicate,
reading `result` with the data-URL form, dropping the Gemini predicate from the response finder,
renaming the shared Gemini kind, and dropping the ineligible-payload count were each neutralized in
turn; each was caught by a named test, with the original restored and `diff -q`-verified. No
survivors this increment.

### perf(streaming): single-pass response observation and real socket backpressure (plan §5.7)

Twelfth increment: §5.7's "Required backpressure changes" landed. "Remove response `tee()` branches used
only for logging and replace them with single-pass observation. In `src/server.ts`, pipe the web response
stream with proper Node `pipeline()` handling, or await socket drain in the `WritableStream.write`
callback; the current ignored `passthrough.write()` result is not backpressure." Both halves are done:
no logging-only `tee()` remains in `src/` (§12's criterion), and the Node adapter no longer ignores
backpressure.

- **`observeStream(logger, requestId, stage, endpoint, format)` in `src/utils/logger.ts`** returns a
  `TransformStream<Uint8Array, Uint8Array>` that logs as the chunk passes through. It sits beside
  `logPipelineStage` because it is the same concern and every affected handler already imports from
  that module. Seven sites in five files now use it: `messages.ts` (raw upstream + outbound),
  `gemini.ts` (raw upstream + outbound), `chat-completions.ts` ×2, `responses.ts`.
- **The cost being removed was real, not stylistic.** `logPipelineStage` returns immediately when
  `!logger.traceEnabled`, but every tee site forked the body and decoded every chunk *before* calling
  it — so at the default log level each response paid a second reader plus a full decode pass for a
  line that was then discarded. Worse, the log branch of a `tee()` reads as fast as it can, so whenever
  the client was slower than the upstream the tee's unread queue held the whole remaining response in
  RAM. A tap on the client's own path costs no copy, and `traceEnabled` is now read before any decode.
- **`format` is required, not defaulted.** The seven sites held two conventions — `'sse-lines'` (four:
  one trace per complete `data: ` line, other lines ignored, `[DONE]` skipped) and `'chunks'` (three:
  the whole decoded chunk). A default would have let a converted site silently inherit the other
  site's convention; each site names its own and keeps it.
- **A trace failure becomes one `debug` line and nothing more.** The observer sits on the client's only
  path, where a throw would abort a response the tee'd branch could not have touched; the test feeds a
  logger whose `trace` throws and asserts every byte still reaches the client plus one report per
  failure.
- **`src/server.ts` SSE path: `pipeline()` replaces the `PassThrough`.** `passthrough.write(chunk)`'s
  return value was ignored, so a slow client pulled the rest of the response into the PassThrough's
  memory, and on a client disconnect nothing cancelled the upstream web stream — it drained to nothing.
  `pipeline(Readable.fromWeb(response.body), res)` gives real backpressure and cancels the upstream body
  when the client hangs up. `release()` keeps its two paths (socket `close`, pipeline `finally`) behind
  the existing once-guard.
- **Three behaviour changes, deliberate.** (a) Observation now stops when the client disconnects,
  where the detached tee loop kept reading to the end. (b) `messages.ts` and `gemini.ts` no longer emit
  `Error logging raw chunks: …` — that line only ever reported the logging branch's own failure, which
  no longer exists. (c) An upstream failure mid-stream now destroys the connection instead of ending the
  response cleanly: the old `passthrough.end()` produced a silently truncated body that looked complete
  to the client. A final `data: ` line that never receives a newline is now logged at flush rather than
  dropped with the buffer (unreachable for well-formed SSE, which ends every event in one, but it is no
  longer a silent drop).

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **2038/2038** (0
skipped). Eight new tests: seven in `tests/unit/logger.test.ts` — bytes and chunk boundaries forwarded
unchanged with trace off (fed invalid UTF-8, which any decode round trip would mangle), zero
`TextDecoder.decode` calls with trace off (counted by subclassing the decoder, the same "assert the work
did not happen, not just the output" idiom as the existing `toJSON` counter), one trace per complete
`data: ` line with other lines and `[DONE]` skipped, a line split across two chunks logged once in full
and not before it terminates, the unterminated tail logged at flush, `'chunks'` logging each chunk
verbatim, and a throwing `trace` leaving the client stream intact — and one in
`tests/unit/server.test.ts`: a client that hangs up mid-stream must cancel the upstream body and not
leak the in-flight count, which legacy `pipe()` fails.

Mutation gate: removing the `traceEnabled` gate, dropping the partial-line buffer, keeping `[DONE]`,
logging every line instead of only `data: `, dropping the flush tail, rethrowing trace failures, and
replacing `pipeline()` with legacy `pipe()` were each neutralized in turn; each was caught by a named
test, with the originals restored and `diff -q`-verified. No survivors this increment.

Surfaced, not settled (repo rule #5): `docs/architecture/design_passthrough_mode.md` §8.2 proposes a
`tee()` for passthrough usage recording, explicitly mirroring the logging tee removed here. It is a
usage recorder rather than logging, so §5.7 does not forbid it — but the same eager-reader cost applies,
and whether it should reuse the observer is a decision for the user.

### feat(spool): ref-aware JSON serializer — §5.3 shape 3 primitives

Eleventh increment: the primitives that let a ref-bearing request body go upstream as ordinary JSON
without ever expanding it into one in-RAM string. New module `src/utils/ref-serializer.ts` exports
`createRefAwareJsonBody(value, { chunkBytes? })` → `{ body: ReadableStream<Uint8Array>, contentLength }`.
It satisfies §5.3's shape-3 requirement — "a ref-aware serializer emits ordinary JSON chunks and
reads each blob file in chunks at the exact ref position… recompute an exact `Content-Length` from
skeleton bytes plus blob sizes, or omit it — never forward a stale length."

- **The wire bytes are the expanded body.** A ref is replaced, at its exact position, by the blob's
  base64 text read through `readBlobChunks` (64 KiB default), so what the upstream receives is
  byte-identical to `JSON.stringify(rehydratedBody)` — the shape-2 answer — while the body in hand
  still holds the ref. `BLOB_REF_MARKER` never appears in the output; the first test asserts that
  literally, then rehydrates the same body and asserts byte equality with the streamed text.
- **`contentLength` is computed, not guessed.** A first, retention-free measuring walk sums
  `event.ref.size` for refs and `Buffer.byteLength(event.text, 'utf8')` for the rest; the stream then
  walks the same tree again on `pull`. If the two disagree at the end (`written !== contentLength`)
  the stream is *errored*, never closed short — a truncated body that claims full length is the one
  failure mode this increment exists to prevent. A blob whose file is gone after the length was
  declared errors the same way.
- **Exactness has a precondition, and it is now enforced upstream of it.** A serializer that emits
  raw payload text can only be byte-exact for payloads `JSON.stringify` would pass through verbatim,
  so `positionsFor`'s `add()` in `src/utils/blob-refs.ts` now requires
  `JSON_VERBATIM_PAYLOAD = /^[\x20\x21\x23-\x5b\x5d-\x7e]+$/` (printable ASCII less `"` and `\`) on
  `prefix + payload`. An ineligible payload — one containing an escape, a control character or a
  non-ASCII byte — stays inline with its bytes unchanged and is counted in `InlineExtraction.skipped`
  and logged, so a payload that is not extracted is reported rather than silently mishandled.
- **`assertRefShape(ref)` runs before any blob is read,** so a malformed ref (a non-string prefix, a
  non-integer or negative size) is a `BlobStoreError` up front rather than a corrupted body later. A
  value that does not carry `BLOB_REF_MARKER` is not a ref and is serialized as an ordinary object;
  that distinction is what the marker exists for.
- **Streaming does not promote into L1.** The chunked read is deliberately the store's
  non-promoting path, so streaming a 1 MiB image through the serializer does not evict the LRU. This
  rests on a test contrast (`readBlob(hashB).source === 'l1'` still holds after `hashA` was chunk-read)
  and on a faithful mutation of that property being caught — not on a comment.
- **No production caller yet.** Wiring one requires passing `contentLength` and `duplex: 'half'` at
  the send boundary in `src/index.ts`, which today rehydrates for shape 2 and therefore forbids refs
  from surviving it — the opposite invariant to shape 3, which needs them to survive to the
  serializer. That is a conflict between two documented shapes, not a gap in this module: repo rule
  #5 says surface it and wait, so the boundary decision is pending rather than guessed. The module
  header says so, and the §5.2 attempt-body clone remains caller-less for the same reason.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **2030/2030**
(0 skipped). Seven new tests in `tests/unit/ref-serializer.test.ts`: the expanded-bytes/exact-length
triple above (including that a 4096-byte blob arrives in exactly four 1024-byte reads); every JSON
rule reproduced with the builtin as the reference (a `toJSON` hook replacing its own value, object
keys JSON has no text for, array `undefined`/function/symbol → `null`, `BigInt` refused); malformed
ref, cycle, `BigInt` and non-object root all refused *before* a byte is emitted; a ref whose size
disagrees with the file erroring the stream instead of sending a short body; a body mutated during
the send erroring rather than forwarding the stale length; a dangling ref erroring after the length
was already declared; and a mid-blob `cancel()` closing the stream without erroring and leaving the
blob on disk.

Mutation gate on this increment's logic: the eligibility predicate, the `written !== contentLength`
check, the `streamed !== ref.size` check, the `chunkBytes` guard, the on-disk-size disagreement and
the short-read guard were each neutralized in turn and each was caught by a named test, with the
originals restored and `diff -q`-verified. Two honest notes. (a) One mutation survived: clamping the
read length with `Math.min(chunkBytes, onDisk - offset)` → `chunkBytes` changes nothing observable
for a regular file — a short read at the tail returns the tail and a read past EOF returns 0 — so it
is an equivalent mutant; only the allocation size differs, and no behavioural test can kill it.
(b) Two properties are asserted structurally rather than by test: the file descriptor closed in the
async generator's `finally` on `cancel()` is not observable from a POSIX test, and
`readBlobChunks`'s idle-expiry branch needs a TTL that cannot be reached without a `Date.now`-stubbing
idiom this repo does not have. Both are stated here rather than covered by a claim the tests do not
make.

### feat(spool): SSE input usage resolved before the response stream exists (plan §5.3)

Tenth increment: the two SSE closures that retained a request body no longer do. §5.3's release
requirement — "before creating the response stream, calculate input usage from the final effective
body … pass only the resulting number and other scalar metadata into the stream" — is met by
`createStreamTransformer` and the Responses-to-Claude pump.

- **`createStreamTransformer(model, requestId, inputTokens, tokenCountingConfig?, includeThinking?)`.**
  The third parameter used to be the request body, which the transformer counted from on the first
  chunk. It is now the count itself, resolved by the caller before the stream exists. This is the
  point of the change rather than a style preference: the transformer lives as long as the
  downstream send, so closing over the body pinned it for the whole client read — and after the
  §5.3 shape 2 send boundary rehydrates the refs, that body holds every inline base64 payload in
  full. A number cannot pin a body; the release is structural, not a matter of discipline.
- **`handleResponsesStreamAsClaude`** hoists the same count above its `TransformStream`, and the
  pump's `inputTokens` now starts from that estimate. It stays a `let`: the `response.completed`
  event still replaces it with upstream usage.
- **Both sites' counting gates are preserved, not blended** (repo rule #5). `createStreamTransformer`
  counted only under `tokenCountingConfig?.enabled`; the Responses pump counted whenever a body was
  handed in, never consulting the config. Each keeps its own gate — the asymmetry is pre-existing
  and is now stated in a comment at each site rather than silently unified.
- **The audit was a read, not an assumption.** Every other SSE closure in the tree was checked and
  takes no request body: the Claude→OpenAI, gemini and responses transformers are built from
  `(model, requestId)`, and the usage/tool tracking, PII-restore mapping and passthrough paths are
  response-side. The plan names two sites; there are two sites.
- **Two behaviour changes, deliberate.** (a) A tokenizer-initialization failure no longer resets a
  successfully computed input count to 0 — the output tokenizer is what that step prepares, and the
  input count is now settled before it runs. (b) The output tokenizer initializes whenever counting
  is enabled; it used to additionally require a request body to be present, which the transformer no
  longer receives.
- **Cost accepted.** Counting now runs on the request path before the `Response` exists rather than
  lazily on the first chunk. It is the same single pass over the body per request as before, just
  earlier, and it fails the same way: a counting error degrades to 0, as it always did.
- **What the tests can and cannot show.** The count's *value* is testable and is pinned; the
  *lifetime* improvement is a property of the signature and is not observable from a test — the
  handler parses its own copy of the request body, so no test can mutate a live body mid-stream to
  distinguish counting-before-the-stream from counting-during-it. The claim here is the signature,
  not a measurement.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **2018/2018**
(0 skipped, up from 2012). Five new tests in `tests/unit/streaming.test.ts` under
`createStreamTransformer — input usage from the caller (§5.3)`: a handed-in count of 4242 appears in
`message_start.usage.input_tokens` and survives into `message_delta` when upstream reports no usage
(so the value is carried, not recomputed); no third argument yields 0; upstream-reported
`prompt_tokens` still wins in `message_delta` (4242 up front, 100 at the end); with counting enabled
and **no** body the output count equals an independently computed tiktoken count of the text delta;
and with counting disabled it stays 0 — that last case passes a real `modelName` on purpose, so it
fails on the gate rather than on a tokenizer that never resolved. One new end-to-end test in
`tests/unit/index-routing.test.ts`: a streaming `/v1/messages` request with `[spool] enabled`, a
4096-byte base64 PNG and `LOCAL_TIKTOKEN=true` against an SSE upstream reports a
`message_start.usage.input_tokens` equal to `countClaudeRequestTokens` over the effective body and
strictly greater than the same count with the image removed, while the upstream text still carries
the exact base64 — the count comes from the post-rehydration body, image included. One assertion
added to an existing `tests/unit/messages-handler.test.ts` Responses-SSE test pins the pump's
pre-stream estimate likewise. Mutation-checked rather than trusted: six mutations — the
`handleStreamingResponse` count forced to 0, `estimateInputTokens` forced to `return 0`, the
Responses pump's estimate forced to 0, `buildFinalUsage` dropping the caller's count, and the
tokenizer-init gate forced off and forced on — each fail at least one test (one, one, one, two, one
and one respectively), and the tree was diffed against a backup after every mutation to prove none
leaked.

### feat(spool): the ref layer's first caller — extraction, one send boundary, one release (plan §5.2/§5.3/§5.4)

Ninth increment: `src/utils/blob-refs.ts` stops being store-first and caller-less. With `[spool]
enabled = true`, the `/v1/messages`-family request path now extracts its allowlisted inline binaries
into blob refs before privacy/kompress/judge-run, expands them back to the client's exact bytes at a
single send boundary, and gives the leases back in the request handler's `finally`. The three
`bodyText = JSON.stringify(body)` sites and every attempt builder are untouched: refs exist only
inside that window, so no conversion handler, attempt builder, or serializer can ever emit one.

- **Why the boundary sits where it does (and not somewhere "cleaner").** §5.8 forbids changing
  full-body auth behavior absent an explicit auth-service contract, and the deferred auth call is the
  first read of `bodyText` after the parse — so the window is parse → privacy → kompress → judge
  sidecar → erase, and the boundary goes immediately after the erase step, before auth, model
  resolution and routing. The alternative — making `buildRouteAttempt` and the synchronous composite
  `map` ref-aware — was rejected: it is a wide change whose failure mode is a ref silently reaching
  an upstream. Verified by reading, not assumed: every consumer in that window reads text, tools or
  scalars, and never an allowlisted binary field.
- **The owner releases from its own lease list, not from a walk of the body.**
  `InlineExtraction` gained `hashes: string[]` (one entry per applied ref, repeats included) and a
  new `releaseExtractedBlobs(extraction)` releases exactly those. `releaseInlineBlobs(body)` walks
  the tree, so a `$spoolBlob` marker a client forged into a field of its own would make the
  handler's teardown throw on a hash the request never leased — after it had already given back the
  real lease on the way there, leaving a dangling ref and a blob that can be swept mid-request. A
  test pins that derailment as the reason the list exists.
- **Opt-in at the call site.** Extraction is gated on `getSpoolConfig().enabled` (§9.1, off by
  default); with no `[spool]` section the request path is exactly what it was, which the routing test
  asserts rather than assumes.
- **Failures need no new handling.** `BlobCapacityError` (503) and `BlobStoreError` (500) already
  extend `ClaudeProxyError`, so the routing block's existing re-raise gives them the right status and
  type; `extractInlineBlobs` restores the body and releases what it took before rethrowing.
- **Costs accepted, and now documented.** The boundary re-serializes the request text even when
  nothing mutated (`JSON.parse`/`stringify` is JSON-equivalent, not byte-identical — `1.0` becomes
  `1`; the same rewrite already happens when privacy/kompress/erase fire). Extraction has no size
  floor — §5.4 sets none, and `threshold_bytes` governs only the §5.1 ingress spill — so every
  allowlisted payload is written to L2, read back at the boundary and then idle-evictable: write-mostly
  churn unless a payload repeats, in which case the L1/L2 hit pays for it.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **2012/2012** (0
skipped, up from 2005). Five new tests in `tests/unit/blob-refs.test.ts` under
`the effective body release list`: the list is one entry per applied ref in application order (two
refs to one payload are two entries of one hash, three leases released, both blobs then
idle-evictable); an extraction whose body holds a forged ref releases its one real lease and leaves
that blob idle; a test showing why a walk is the wrong release (the forged ref derails
`releaseInlineBlobs` only after it has already given back the real lease, so the blob is swept while
the body still names it and rehydration then refuses); a zero-ref extraction returning
`{refs: 0, bytes: 0, hashes: []}` and releasing nothing; and a second release of the same extraction
throwing `BlobStoreError` rather than undercounting. Two new end-to-end tests in
`tests/unit/index-routing.test.ts`: a `/v1/messages`
request carrying a 4096-byte base64 PNG, via the real config loader with a `[spool]` section, gets
its payload into the store while in flight (sampled inside the stubbed `fetch`: one entry, the exact
byte count), sends upstream text with **no** `$spoolBlob` marker and the **exact** original base64,
converts the response back, and releases the lease by the time the response returns (the next idle
sweep deletes the blob and reports zero bytes); and the same request with no `[spool]` section
leaving `enabled` false, the store empty, and the payload intact — §9.1. The test file's
`sentBodyText` now accepts a serialized body as well as a streamed one, since a converted egress
sends a string where passthrough egress streams bytes. Mutation-checked rather than trusted: four
mutations of the two source files — the send boundary removed, the extraction gate forced off, the
lease release removed, and the release list emptied — each fail at least one test (one, one, one and
three respectively), and the tree was diffed against a backup after every mutation to prove none
leaked.

### feat(spool): the §5.2 attempt body — a copy that shares the blob's lease (plan §5.2/§5.5)

Eighth increment: the clone that gives every attempt its own body without copying the payload.
New `cloneInlineBlobs` in `src/utils/blob-refs.ts`; still **store-first and caller-less**, the last
primitive §5.3's converted egress shapes need.

- **`structuredClone` plus one `retain()` per ref.** `cloneInlineBlobs(body)` deep-copies the
  extracted body and takes one more owner on each blob the copy still names, so two attempts — or an
  original and a converted re-send — never share mutable state or a single release. The body is
  copied *before* any lease is taken, so a body `structuredClone` refuses (a function, a class
  instance) refuses here with nothing to undo; a ref that names no blob refuses the whole clone and
  the leases already taken are given back. A caller never receives a half-leased copy.
- **No `leaseId`, and no renewal timer — a documented deviation from §5.5's literal wording.** The L2
  index already counts owners per blob (`refs`), so a ref's `hash` *is* its lease identity and a
  `leaseId` would be a second counter over the same lifetime; renewal is structural for the same
  reason, since `isIdleExpired` requires `refs === 0` and both `retainBlob` and `releaseBlob` set
  `lastUsed = Date.now()` — a blob held by a live exchange can never be expired, LRU-evicted,
  TTL-swept, or freed by `reserveDiskBytes`, so a renewal timer would be a provable no-op. Both
  module headers now say this instead of "not here yet".
- **One release-with-warning idiom.** `undo`'s per-lease failure collection moved into
  `releaseQuietly(hashes, context)` and `undo` now uses it, so the extraction rollback and the clone
  rollback report leftovers the same way: `console.warn` naming each hash, never replacing the error
  that sent the caller there (repo rule #8 — said out loud, not swallowed).
- **`src/utils/blob-store.ts`** gained one comment paragraph saying where the lease accounting lives.
  No code changed there.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **2005/2005**
(0 skipped, up from 2000). Five new tests in `tests/unit/blob-refs.test.ts` under
`§5.2 attempt body clones`: two refs to one payload clone into two independent objects naming the
same hash, one blob file and one payload on disk, the body's two leases released while the clone
still pins the blob through an idle sweep past `ttl_seconds`, then the clone's own rehydration
returning the shared payload twice and its release letting the same sweep delete the file; the copy
proven not to alias the original (mutating a ref's kind, a nested filename, and the model leaves the
source body's `'chat-file-data'`, `undefined` and `'claude'` intact, and each side releases exactly
once); a body with nothing to clone coming back as a plain deep copy with the store still empty; a
body holding a function refusing with `DOMException`/`DataCloneError` and no lease taken; and a
two-ref body where one ref is forged refusing with `BlobStoreError` and releasing the lease it did
take (the real ref then releases and the sweep deletes the blob). Mutation-checked rather than
trusted — eight mutations; seven fail at least one test (one per refusal path, one for the retain
loop, and one that empties `undo`'s rollback after the `releaseQuietly` refactor, which is what
proves the refactor is still covered), and the eighth — collecting refs from `body` instead of
`clone` — is equivalent by construction, since the clone is a deep copy of the same tree and both
collect the same refs in the same order. The tree was diffed against a backup after every mutation
to prove none leaked.

### feat(spool): the allowlist ref layer — inline binary out of the body, exact bytes back (plan §5.4/§9.3)

Seventh increment of `docs/architecture/plan-ssd-spool-image-request-bodies.md`: the predicates that
decide which inline payloads become blobs, and the pass that puts them back. New file
`src/utils/blob-refs.ts`. Like §5.4, it is **store-first and has no production caller yet** — it is
the prerequisite for §5.3's converted egress shapes 2–3.

- **The §5.4 allowlist, one predicate per position.** Each is keyed on the shape's documented
  discriminator rather than on a field name: Claude Messages `type: "image" | "document"` with a
  `source.type: "base64"` (`source.data`); Chat Completions `image_url.url` (only when it is a
  base64 `data:` URL), `input_audio.data`, and `file.file_data` (bare base64 *or* a data URL);
  Gemini any `inline_data`/`inlineData` part's `data` — both spellings, since the part carries no
  type — and Responses `input_image.image_url` (the spec's string form *and* the `{url}` object form
  this repo's own converter relays), `input_file.file_data`, and an inline skill's `source.data`
  (only when `media_type: application/zip`). §9.3's ban is honoured literally: **no** long-base64
  heuristic, and no extraction based only on a field called `data`, `url` or `file_data`. Claude
  `text`/`url` document sources, `file_id`s, remote URLs, Gemini `file_data`/`fileData` (a URI), and
  a `data:` URL that is not in the `;base64,` form are all left exactly as the client sent them.
- **A ref is an object, not a sentinel string.** `{$spoolBlob: true, kind, hash, size, prefix}`
  replaces the field's string, so a consumer that is not ref-aware fails loudly — `source.data` is
  no longer a string — instead of quietly measuring a placeholder (§9.3, repo rule #8). The marker
  is a *string* key on purpose: §5.2 keeps one body per attempt and clones it with
  `structuredClone`, which drops symbol keys. A client object that happens to carry
  `hash`/`size`/`prefix` is **not** a ref, and neither is a marker without a hash.
- **Byte-exact rehydration.** Only the payload goes to the blob; `prefix` records the original
  `data:<media-type>;base64,` text (`''` for bare base64), so `rehydrateInlineBlobs` reproduces the
  field value character for character. A `data:` URL is never decoded and re-encoded — which is why
  the `decodeDataUri` idiom in `src/converters/claude-to-gemini.ts`, which re-encodes URL-encoded
  payloads, is deliberately not reused here.
- **All-or-nothing, with the leases to match.** Extraction takes one lease per ref (`putBlob`), and
  `releaseInlineBlobs` gives back exactly one per *ref* — two refs to one payload are two owners of
  one blob. If a payload cannot be stored, the applied replacements are undone, their leases
  released, and the store's error rethrown, so a caller never receives a half-extracted body or
  leaks a lease. Extraction is idempotent: a second pass reports `{refs: 0, bytes: 0}`.
- **Identification and validation are separate steps.** `isBlobRef` only *identifies* — marker plus a
  string hash — because a body's contents are client-controlled, and a guard that also validated
  would silently ignore a forged ref instead of reporting it. `readRef` validates the `prefix`/`size`
  it is about to concatenate (a missing prefix would otherwise forward a payload with the literal
  text `undefined` glued to it), and the store validates the hash's exact shape before it becomes a
  path. A ref whose blob is gone, or whose recorded size disagrees with the blob's, throws rather
  than substituting different bytes.
- **`src/utils/blob-store.ts`** gained one comment: the "no production caller yet" clause now names
  `blob-refs.ts` as the module holding the allowlist predicates, so neither file read alone claims
  the other's work. No code changed there.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **2000/2000**
(0 skipped, up from 1986). New file `tests/unit/blob-refs.test.ts` (14 tests): a twelve-cell matrix
over the eight ref kinds — both Gemini spellings, both `input_image` forms, and `file.file_data` as
bare base64 and as a data URL — with payloads above `threshold_bytes`, asserting the ref count, one
blob file per payload, the `12 × 1052672` byte accounting, a sub-4 KiB skeleton for 12 MiB of
payload, byte-for-byte rehydration on a `structuredClone` copy, the recorded kind and data-URL
prefix at each position, then release and idle eviction; every §9.3 negative left byte-identical
with nothing stored (including a URL-encoded non-base64 data URL, which must not be decoded); dedup
as one blob under two leases, with a second owner pinning it past the body's release;
all-or-nothing rollback under a 96-byte disk cap, with the two partial leases provably given back
(both entries evictable afterwards); and refusal of a forged hash (`../../../etc/passwd`), a size
mismatch, a deleted `prefix`, a dangling blob, a disabled spool, and a client object that merely
looks like a ref. Mutation-checked rather than trusted — thirteen mutations; apart from the three
walker guards below, each fails at least one test. M1 (`isBlobRef`'s marker check) survived the
first pass, which is what the look-alike test was added for; dropping the hash check, the
prefix/size validation, the size comparison, the rollback, the remote-URL guard, the
`source.type`/`media_type` conditions, or a position's data-URL form each fails a test immediately.
Three `continue` guards — "a ref is a leaf for this walk", one per walker — survive mutation by
construction: a ref holds only scalars, so walking into one is a no-op. They are kept as the explicit
statement of that invariant, not as tested behaviour, and deleting them would be equally
indistinguishable by test. One trap worth recording: `resolveSpoolConfig` reads **snake_case** TOML
keys, so the new helper is typed `Partial<SpoolTomlConfig>` and its overrides are TOML spellings — a
camelCase override is ignored in silence, and the test would have measured the default cap instead
of the one it names. The sibling `blob-store.test.ts` still annotates its helper
`Partial<SpoolConfig>` while passing snake_case keys; that type lie is not copied here.

### feat(spool): the RAM + SSD two-level blob store (plan §5.4)

Sixth increment of `docs/architecture/plan-ssd-spool-image-request-bodies.md`: the cache that will
sit behind refs. New file `src/utils/blob-store.ts` — content-addressed by the sha256 of the blob's
**base64 text** (not of the decoded bytes, so a hit needs no re-encode and exact-string dedup is
enough), with the two tiers §5.4 asks for:

- **L1 (RAM)** — `Map<hash, {b64, bytes, lastUsed}>` capped by total *bytes*
  (`max_blob_cache_bytes`, 64 MiB) with least-recently-used eviction. Admission is best effort: a
  payload larger than the whole L1 budget is never promoted, and L1 eviction never touches the L2
  file.
- **L2 (SSD)** — `<spool_dir>/blobs/<aa>/<bb>/<sha256>`, written under a temp name and renamed into
  place so a blob becomes visible only once it is whole (files 0600, buckets 0700), capped by
  `max_blob_disk_bytes` (256 MiB).
- **A metadata-only index** — `Map<hash, {size, lastUsed, refs}>` with a running byte total, so
  eviction never `stat`s the disk. It starts empty on every process start and is **never** scanned
  or reconstructed: a file left by an earlier run can never turn into a cache hit, and the single
  reader of those files is the startup sweep, which only deletes them.
- **Fail loud (repo rule #8).** Before an L2 write the store evicts idle `refs = 0` entries by LRU
  and, if nothing unleased can be freed, throws `BlobCapacityError` (503, `over_limit_error`) rather
  than exceeding the budget or deleting an active blob. An indexed blob that is missing or shorter
  than its recorded size throws `BlobStoreError` (500, `processing_error`) rather than sending a
  partial payload — a truncated file is reported as "N bytes on disk but indexed as M". Blob paths
  are guarded by a `/^[0-9a-f]{64}$/` check, so a traversal-shaped hash (`../../etc/passwd`) is
  refused before it reaches the filesystem.
- **Leases now, §5.5 later.** The index counts the owners sharing a blob's lease (`refs`, with
  `retainBlob` / `releaseBlob`), and a leased blob is never expired, evicted, or deleted. The
  `leaseId`, renewal and keep-alive rules of §5.5 are deliberately **not** here — they land with the
  conversion paths that consume these refs, along with the §5.4/§9.3 allowlist predicates that
  decide which inline payloads become blobs at all. **This module therefore has no production
  caller yet** (the store-first split of this step).
- **Idle TTL, not wall-clock.** Expiry reuses the `src/utils/conversation-store.ts` idiom
  (insertion-ordered `Map`, evict on access plus opportunistic evict on write) with one difference:
  the TTL is *idle* time measured from the last release, so an exchange still holding a ref is never
  expired even if it is old. L1 may drop a leased blob's RAM copy — the L2 file is authoritative and
  stays readable; L2 eviction drops the L1 copy with it.
- **`sweepStaleBlobs()` wired into startup** in `src/utils/config-loader.ts`, next to the §5.5 spill
  sweep and with mirrored logging. It walks the blob tree two levels deep, deletes regular files
  older than the same age threshold (a worker starting alongside this one may still be writing), and
  reports — never follows — anything it declines to remove (a subdirectory, a symlink, a name that
  is not a blob hash, an unlink failure) with its reason. It never populates the index. The
  `Spool active:` startup line now also prints `maxBlobDiskBytes`.
- **`src/utils/spool.ts`** had a header paragraph claiming this module owned the whole spool
  surface; it now points at `blob-store.ts` and states what is actually live (the §5.1 ingress
  path), which would otherwise have been a comment contradicting the code.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **1986/1986**
(0 skipped, up from 1964). New file `tests/unit/blob-store.test.ts` (21 tests): layout and byte
identity (the hash is the sha256 of the base64 text, the file's content is that text, 0600 in a 0700
bucket, `readBlob` reports `source: 'l2'`); dedup as one file and one write (mtime unchanged,
`diskBytes: 100`, `diskEntries: 1`, a double release throws "no active lease to release"); tmp +
rename leaves no temp name behind; the traversal guard over six hash shapes; a disabled spool
refuses `putBlob` with a plain `Error`, not a `BlobStoreError`, and creates no directory; the L1 LRU
by asserted read sequence (`l2, l1, l1, l2, l2`) with `cacheBytes` under the cap and the L2 index
untouched; an oversized payload never promoted; a leased blob's RAM copy evicted while its file
stays readable; L2 LRU eviction that drops the idle-oldest, keeps the newer idle and the leased, and
lands exactly on the cap with the evicted hash rejecting "not in the cache index"; all-leased under
the cap → `BlobCapacityError` (`status 503`, `type 'over_limit_error'`) with the cap and the leases
intact and nothing written; a missing file ("cannot be read") and a truncated one ("40 bytes on
disk but indexed as 100") with accounting unchanged; the restart rule (`resetBlobStore()` → all-zero
stats, the file still on disk, a later read throwing, a re-`putBlob` reporting `cached: false`); the
idle TTL at 599 s vs 601 s with a leased blob surviving and the idle clock starting at the final
release; an unlink failure reported rather than claimed (`removed === 0`, bytes still counted — root
skipped); and the sweep's aged-vs-recent split, its six-entry skip set, a missing root reported
without being created, and "startup operation only" (the sweep deletes the file while the index
stays untouched, so the next read throws). `tests/unit/config-loader.test.ts` gains one test that
drives the real `loadProxyConfig`: an aged blob is removed at startup, a recent one is kept, and the
store's stats stay all-zero. Both new suites were mutation-checked rather than trusted: removing the
`refs` guard fails the two TTL tests, disabling the length check fails the truncation test, relaxing
the `refs === 0` filter fails the capacity test, and stubbing `blobSweep` out of `config-loader.ts`
fails the startup test — 21/21 and 223/223 clean again after each revert.

### feat(spool): stream passthrough request bodies as identity egress (plan §5.3)

Fifth increment of `docs/architecture/plan-ssd-spool-image-request-bodies.md`: the first egress
shape. `/passthrough` already forwarded the client body with zero transformation; what changed is
*how* it leaves the proxy — the raw client bytes are now streamed upstream with an exact
`Content-Length` instead of being re-held as one full-body string, and the parsed tree is released
before the send. This also discharges Phase 0 item 3 (§9.4), which folds into the chosen Phase 2
step.

- **Identity egress in `src/handlers/passthrough.ts`.** `handlePassthroughRequest` no longer takes
  a `bodyText` argument. It reads the body itself via `readIngressSpoolText()`, parses it, runs the
  existing schema gate, and keeps only scalars — `model`, `stream_options.include_usage`, and a
  300-char preview for error details — inside a block scope, so the source text and the parsed
  object are both collectible before the upstream call. What it sends is the request's own raw
  bytes: `request.body` (the stream `src/index.ts:1200` already builds from the raw spool) with
  `Content-Length` from `IngressSpool.size` and `duplex: 'half'`, matching the repo's existing
  streamed-body convention. Without a raw-body ref (handler called directly, or a body-less
  request) it falls back to the decoded text's UTF-8 bytes, so the handler still stands alone.
- **Byte identity, not a re-serialization.** Identity passthrough makes the *raw spool*
  authoritative (§5.3); a `JSON.stringify` of the parsed body would silently drop the client's
  whitespace and key order. The new tests assert sha256 equality between the client bytes and the
  upstream body on an indented fixture, and a byte-vs-UTF-16 `Content-Length` on a non-ASCII one.
- **Deliberate deviation from the plan's literal transport.** §5.3 says "stream the spool file
  directly: `Content-Length` from `stat`, body from `createReadStream`". That would be a second
  disk read of bytes `src/index.ts:1200` has *already* materialized into the request, and it would
  drag §5.5's lease/lifetime handshake into the send: the spill could not be released until a
  still-streaming upstream body finished, and `open()` + `unlink()` is explicitly ruled out for
  the win32 SEA build. The stated outcome — zero transformation, no full-body string at send — is
  reached without either. If a later step stops materializing the body in `src/index.ts`, the
  natural continuation is to feed `createReadStream` here and take the lease at that point.
- **`src/index.ts` no longer reads a body it does not need.** The deferred
  `auth_with_model` / `auth_with_body` gate still parses the body, so `readIngressSpoolText()` runs
  only inside that branch instead of on every passthrough request.
- **Trace logging keeps full fidelity without retention.** The `upstream-request` trace used to log
  the string the handler already held; it now re-reads the spool *at log time* and only when
  `logger.traceEnabled` is set. Tracing therefore still shows the exact client body (asserted
  verbatim on a >300-char spilled fixture) while nothing is retained when trace is off. The re-read
  is guarded on the spool: `readIngressSpoolText()` falls back to `request.text()`, which the parse
  has already consumed, so the unguarded version threw `Body is already read` on the no-spool path
  (the new test caught it). That path logs the 300-char preview instead.
- **The model scalar is type-checked.** `(body.model as string) || 'unknown'` became "a non-empty
  string, else `'unknown'`", so a non-string `model` can no longer reach the rate-limit and usage
  keys as a coerced value.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **1964/1964**
(0 skipped, up from 1957). New file `tests/unit/passthrough-egress.test.ts` (seven tests): the
client bytes reach the upstream byte-identically with a byte-exact `Content-Length` on both the
no-ref and the spilled path; a spilled body is sent as a **stream**, not a string, still
byte-identical; the upstream-request trace carries a spilled body verbatim and untruncated; invalid
JSON and a schema-gate failure both 400 without ever calling the upstream; the parsed `model` lands
in the rate-limit table under its own key (and not under `'unknown'`); and the
`stream_options.include_usage` warning fires only when the flag is absent. The guards were
mutation-checked rather than assumed: forcing the fallback branch fails the spilled-egress test.
`tests/unit/passthrough-auth.test.ts` and `tests/unit/index-routing.test.ts` were updated for the
new signature — the two routing tests now drain the streamed body and assert its exact text and
byte `Content-Length` through the real `handler.fetch` dispatch path.

### feat(spool): sweep spills left by a crashed run at startup (plan §5.5)

Fourth increment of `docs/architecture/plan-ssd-spool-image-request-bodies.md`: the lifecycle piece.
A restart discards all spool state — no recovery manifest, no replay metadata — so spill files from
a previous process are garbage. They are now removed at startup, but only once they are old enough
to be certain they are garbage.

- **`sweepStaleSpills()` in `src/utils/spool.ts` — age-thresholded, non-recursive, regular files
  only.** A file under `<spool_dir>/requests` whose mtime is at least `SPOOL_SWEEP_MIN_AGE_MS`
  (1 hour) old is deleted; anything newer may belong to a worker starting up alongside this one
  that is still filling it, so it is left alone and counted as `keptRecent`. The sweep does not
  recurse, and a `Dirent.isFile()` check means a symlink is neither followed nor deleted — a link
  planted in the spill directory cannot make cleanup reach a file outside it. The 1-hour default is
  the bound on a plausible in-flight upload: what too large a threshold costs is disk space, and
  what too small a one costs is a corrupt in-flight request.
- **Portable by construction.** Deletion is `unlinkSync` on a closed name. Hiding an open fd behind
  an unlinked name (`open()` + `unlink()`) is POSIX-only and the repo ships a win32 SEA build, so
  the sweep is the answer there too (§5.5).
- **Nothing is skipped silently (repo rule #8).** The result reports `removed`, `keptRecent`,
  `dirMissing`, and a `skipped` list of `{ path, reason }` for every entry left in place —
  directory, symlink/special file, stat failure, or a failed unlink. The startup caller logs the
  removal summary at info and every skipped entry with its reason at warn. A missing `requests/`
  directory is normal (`dirMissing`), not an error: the ingress path creates it on the first spill,
  and the sweep deliberately does not create it as a startup side effect.
- **`src/utils/spool-ingress.ts` now shares the layout** (`requestSpillDir()` /
  `REQUEST_SPILL_SUBDIR`) instead of spelling `'requests'` a second time, so the writer and the
  sweeper cannot drift apart. `src/utils/config-loader.ts` runs the sweep inside the existing
  `if (startupSpool.enabled)` block, next to the `Spool active: dir=…` line that already satisfies
  §5.5's "the resolved path is logged at startup". A disabled spool still touches nothing (§9.1):
  no directory, no sweep, no log.
- **Blast radius is exactly the spill files.** Only `<spool_dir>/requests/*` regular files are
  candidates; the spool root itself is never scanned, so the write probe and anything else an
  operator keeps in `[spool] dir` are out of reach. A future response/event spill directory has to
  be added to the sweep explicitly.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **1957/1957**
(0 skipped, up from 1952). New coverage in `tests/unit/spool.test.ts` (`sweepStaleSpills (§5.5)`,
five tests): a 2-hour-old spill is removed while a 10-minute-old one survives byte-intact and an
equally old file *outside* `requests/` is untouched; with an explicit 1-hour cutoff a file just
under it is kept and one just over it is removed; a missing `requests/` directory yields
`dirMissing` and is not created; a symlink to an old file outside the spool and a subdirectory are
both left in place with their reasons reported while a genuine stale file is still removed; and a
read-only spill directory turns the failed unlink into a `skipped` entry with `removed: 0` rather
than a throw or a false success (that test skips only when the suite runs as root, where
permission checks do not apply). The guards were mutation-checked rather than assumed: dropping the
regular-file check fails the symlink test, ignoring the age threshold fails the two age tests, and
sweeping the spool root instead of the spill subdirectory fails three.

### feat(spool): wire the ingress spool into the live request path (plan §5.1, §5.2, Phase 1)

Third increment of `docs/architecture/plan-ssd-spool-image-request-bodies.md`, and the one that
makes Phase 1 real: the ingress primitive is now on the request path, and the adapter feeding it
applies actual backpressure. Spooling is still **off by default** (`[spool] enabled = false`), so
an unchanged config behaves exactly as before — but with `enabled = true` a large upload now
streams to disk instead of being held in RAM while the client sends it.

- **`src/index.ts` — the 10 MiB buffering block is gone, replaced by one backpressured,
  byte-counted receive path (§5.1).** Every request with a body goes through
  `receiveIngressBody()`: at or below `threshold_bytes` it stays in memory, above it it spills
  from the first byte, and an unknown-length body crosses the threshold without losing the bytes
  already received. `Content-Length` is only the early-rejection hint it always was; the byte
  counter decides. The old block's `if (!body)` / over-cap / read-into-memory branches are
  subsumed. Statuses now come from the error class rather than the explicit `413` the old block
  passed: a declared or counted length past `max_request_bytes` is a `SpoolRequestTooLargeError`
  (413, message wording essentially unchanged), an exhausted spill budget a new
  `SpoolCapacityError` (503), and an unusable spill directory a `SpoolWriteError` (500) — all
  `ClaudeProxyError`s, so `createErrorResponse(error, requestId)` needs no new plumbing and the
  envelope on `/v1/responses` paths is unchanged.
- **The request is re-wrapped, and the ref survives the reconstruction (§5.1, §5.2).** Downstream
  handlers still call `request.json()` / `request.text()` on a dozen paths, so the raw bytes are
  re-wrapped onto a fresh `Request` and `attachIngressSpool()` re-attaches the spool to it —
  `new Request(other, init)` copies neither properties nor symbols, which is why attaching only
  in the adapter is insufficient. The three top-level body reads now go through
  `readIngressSpoolText(request)`: the raw spool when a ref is attached, the request body
  otherwise. A read of an already-released spool throws rather than silently falling back to a
  body the proxy has already answered.
- **The raw spool is released in a `finally` around the handler**, so every terminal path returns
  its `max_total_bytes` reservation — the success path, each error path, and every early return
  inside the handler (repo rule #8). The raw body is fully read before the response is produced,
  so one release point covers all of them.
- **`src/server.ts` — `createNodeBodyStream()` is pull-driven, so the ingress backpressure is
  real.** The previous shape attached a `data` listener and never paused: Node went into flowing
  mode and a client could push its whole body into an unbounded in-memory queue however slowly
  the handler read. Now the stream uses `{ highWaterMark: 0 }`, pauses the socket again right
  after attaching, resumes it only when a read is pending (`pull`), and pauses after each chunk a
  read consumed — one chunk released per read. `drain()` detaches the `'data'`/`'end'` listeners
  and resumes the socket once the handler returns, so the paths that answer without reading the
  body (auth rejection, dashboard, OPTIONS) discard the rest of the upload instead of leaving a
  client to finish writing a body nobody will read. `cancel()` routes through the same drain. The
  `'error'` listener deliberately stays attached: removing it would turn a late socket error into
  an uncaught exception.
- **What Phase 1 still does not fix (§6), unchanged:** slow *upstream* sends and SSE request-body
  retention. Full parsed objects and serialized upstream bodies still exist; the lazy/streamed
  readers that remove them are §5.3/§5.7 Phase 2 work, and the §5.5 startup sweep of stale spill
  files was still to come at this increment (the entry above adds it).
- **The memory win is the upload window, not the peak.** The request is re-wrapped by reading the
  spool back with `readBytes()`, because a `Request` body is a single byte sequence and the
  downstream read sites need one; so a spilled body is materialized once the upload ends, and
  peak residency at the point of use is still O(body) — the same cost §5.2 accepts for the
  effective body. What changed is *when* it is resident: no longer for the whole duration of a
  slow client upload, which is the window §3.1/§6 scoped this phase to. Removing the read-back
  is §5.2's streaming-through-effective-body work.

This closes the four items the previous entry listed as required before enabling: the buffering
block, the `SpoolRef` across reconstruction, the downstream body-read sites, and the pull-based
adapter stream.

Verified: `npm run typecheck` clean; `npm run build` clean; `npm run test:unit` **1952/1952**
(0 skipped). New coverage: `tests/unit/spool-ingress.test.ts` gains the raw-body ref block (the
ref is dropped by `new Request` and re-attaches to the same spool; a spool read does not consume
the request body, so `request.json()` still works afterwards; no ref falls back to the request
body; a released spool fails loudly). `tests/unit/server.test.ts` gains four deterministic
`createNodeBodyStream` tests against a fake `IncomingMessage` that counts `pause`/`resume` and
listeners (paused after construction, one resume per pending read, pause after each consumed
chunk, `drain()`/`cancel()` detach `'data'`/`'end'` and resume while keeping `'error'`, drain is
idempotent, GET/HEAD get no stream), plus two integration tests over a real socket: a 16 MiB
upload whose handler reads one chunk and stalls must stall the client well below the body size
and then deliver all 16 MiB with a matching sha256, and a 4 MiB upload whose handler returns 401
without reading a byte must still receive that response. The backpressure assertion was sized by
measurement, not guesswork: against the old flowing shape `socket.bytesWritten` reaches the whole
16,777,357 bytes within 150 ms, while the pull-driven stream plateaus at 917,645 bytes (~896 KiB
of kernel buffer plus Node's small write queue) and stays there until the handler reads again —
so the test's `stalled < totalBytes / 4` bound discriminates by a margin of ~18×, and the exact
equality after a further 200 ms is what a merely-slower reader would fail.

### feat(spool): the Phase 1 ingress receive path — bounded-memory request bodies (plan §5.1, §5.2, §5.5)

Second increment of `docs/architecture/plan-ssd-spool-image-request-bodies.md`. This adds the
ingress primitive that receives a request body with bounded memory; **nothing calls it yet**, so
an `enabled = true` spool was still inert and behavior unchanged — the entry above is the one that
puts it on the request path.

- **`src/utils/spool-ingress.ts` (new) — `receiveIngressBody()` and the `IngressSpool` handle.**
  A body at or below `threshold_bytes` stays in RAM; a body whose `Content-Length` already
  exceeds it spills from the first byte; an unknown-length body (chunked / HTTP/2) buffers only
  until the threshold is crossed and then writes the bytes already received *before* any further
  read, so no byte is dropped in the memory→file transition. `Content-Length` is treated only as
  an early-rejection hint (§5.1): a declared length past `max_request_bytes` returns 413 without
  pulling a single byte, while a running byte counter enforces the same cap for every encoding.
  The receive loop is a pull-based `pipeline`-style loop — each chunk is written to disk before
  the next `read()` — so the socket and the file both provide backpressure instead of the
  unbounded push the old buffering block relied on.
- **Spilled bytes are charged to `max_total_bytes` as they are written, and released on every
  terminal path** (success, breach, abort, disk error). A breach raises an explicit
  `SpoolCapacityError` (503) rather than truncating the body, and a failed or cancelled upload
  removes its spill file and returns its reservation, so the live total returns to baseline. A
  ledger underflow is thrown, never clamped — a silent clamp would hide exactly the accounting
  bug the counter exists to catch. Only spilled bytes are charged: an in-memory body is bounded
  by `threshold_bytes` × in-flight requests, and the whole-process budget knob is the admission
  limiter of §5.9, which stays disabled by default.
- **A spool is a reader-owned handle, not a stream.** §5.1 rejects
  `new Request(url, { body: fileStream })` followed by `.json()`, because undici buffers the
  whole body anyway; `IngressSpool.readBytes()` / `readText()` read the file at the point of use,
  and `release()` (idempotent, expected in a `finally`) deletes it and returns the reservation.
  Reading a released spool throws instead of returning a short body. With `enabled = false`
  nothing is written and `SpoolWriteError` never fires, but the body still travels the unified
  byte-counted path.
- The three failure modes are loud and mapped to the existing error convention: a body over
  `max_request_bytes` → `SpoolRequestTooLargeError` (413), the aggregate budget exceeded →
  `SpoolCapacityError` (503), and an unusable spill directory or a failed write/close →
  `SpoolWriteError` (500), each carried by `ClaudeProxyError` so `createErrorResponse` needs no
  new plumbing. Spill files are `<spool_dir>/requests/req-<uuid>.body` at mode `0600`, in a
  lazily created `0700` directory; leftover files from a crash are left for the §5.5 startup
  sweep, which is not part of this change.

Still required before any of this could be enabled, and what the entry above went on to do:
replacing the 10 MiB buffering block in `src/index.ts:1176-1211`, preserving the `SpoolRef`
across the early `Request` reconstruction, routing the downstream `request.text()` / `.json()`
sites through the spool, and making `src/server.ts`'s request body stream pull-based (`pull` +
`pause`/`resume`) so the ingress backpressure is real rather than queued in memory.

Verified at this increment: `npm run typecheck` clean; `npm run test:unit` **1942/1942** (0 skipped,
before the ten wiring tests the entry above adds), including
the new `tests/unit/spool-ingress.test.ts` (16 tests: the in-memory path writes no directory and
re-reads one buffer; a declared over-cap length pulls **zero** bytes; an unknown-length over-cap
body is cancelled and leaves no file; `enabled = false` never spills; spill-from-start is
`0600` and sha256-identical to the body; an unknown-length threshold crossing keeps the prefix
byte-identical; the reader stays within two chunks of the file at every pull, which a
buffer-then-write loop would fail; the ledger is unchanged by a refused upload and back to zero
after release, including a mid-stream breach; `release()` twice does not underflow and reading
after release throws; an unwritable spill directory fails with `SpoolWriteError`).

### feat(spool): `[spool]` config surface and the trace-level body-logging gate (plan Phase 0 item 1 + §5.6, foundation for Phase 1)

First increment of `docs/architecture/plan-ssd-spool-image-request-bodies.md`. This change
adds the configuration layer and one free win; **no request path is spooled yet**, so an
`enabled = true` spool is currently inert. Nothing changes for an existing config that has
no `[spool]` section.

- **`src/utils/logger.ts` — gate the body stringification on trace (plan Phase 0 item 1).**
  `logPipelineStage` stringified the whole request/response body (up to a 2 MB preview of
  it) at four pipeline stages before handing the text to `logger.trace`, which then
  discarded it unless `LOG_LEVEL=trace`. It now returns immediately when the new
  `Logger.traceEnabled` flag (derived from `createLogger`'s closed-over `minLevel`) is
  false, so the copy never happens. `Logger` gained the flag in both declarations —
  `src/utils/logger.ts` (the implementation) and the narrower `src/types/shared.ts` view,
  which must stay in sync. Per plan §9.4 this stays unreleased until Phases 1–2 land.
- **`src/utils/spool.ts` (new) — `[spool]` resolution.** `resolveSpoolConfig()` fills every
  §5.6 default (`enabled = false`, `dir = ~/.cache/model-proxy/spool`, `threshold_bytes =
  1048576`, `max_request_bytes = 10485760`, `max_response_bytes = 67108864`, `max_total_bytes
  = 2147483648`, `max_materialized_body_bytes = 0`, `materialization_factor = 2.0`,
  `max_admission_queue = 64`, `admission_timeout_ms = 30000`, `max_blob_cache_bytes =
  67108864`, `max_blob_disk_bytes = 268435456`, `ttl_seconds = 600`), validates each key,
  and expands a leading `~`. An unusable directory is a **fatal** startup error (a new
  `SpoolConfigError` carrying `fatal = true`, the `KeyStoreError` convention): a spool that
  silently falls back to memory would hide the risk it exists to remove. A disabled spool
  touches nothing on disk — reading config never creates a directory. When enabled, the
  directory is created, forced to mode `0700`, and proven writable with a write+unlink
  probe (`mkdir` succeeding says nothing about a read-only mount, a full disk, or another
  owner's directory), and a tmpfs/ramfs target is reported as a RAM-backed warning.
- **`src/utils/config-loader.ts` — the `[spool]` TOML section.** Parsed (quoted `dir`,
  unquoted numeric limits and `enabled`), serialized back for the dashboard/TUI save path,
  and resolved once in `loadProxyConfig` next to the image-encode resolution, logging the
  resolved dir at startup (§5.5). An unrecognised `[spool]` key is reported as a validation
  error rather than dropped — a limit an operator believes is in force but that was never
  parsed is worse than a rejected key.

Deferred deliberately (both noted in `src/utils/spool.ts`): `SPOOL_*` env overrides, because
`isEnvFlagEnabled` lives in `dashboard-stats.ts`, which imports from `config-loader.ts` —
taking that dependency would close a `config-loader → spool → dashboard-stats →
config-loader` cycle; and the blob store/leases themselves, which are Phase 1.

Verified: `npm run typecheck` clean; `npm run test:unit` **1926/1926** (0 skipped), including
the new `tests/unit/spool.test.ts` (per-key validation and its error text, `~` expansion,
mode `0700`, the write probe failing loud, tmpfs/ramfs magic numbers, inertness while
disabled), `tests/unit/logger.test.ts` (the body is serialized **zero** times when trace is
off and exactly once when it is on), `[spool]` parse → serialize → parse coverage plus four
`loadProxyConfig` startup cases (section absent, enabled, unusable dir, invalid limit) in
`tests/unit/config-loader.test.ts`. Also checked outside the test harness: a real
`loadProxyConfig` run with `[spool] enabled = true` logs
`[config] Spool active: dir=… thresholdBytes=… maxTotalBytes=…` and creates the directory as
`drwx------`; the same run without a `[spool]` section creates nothing (the §5.6 default
`~/.cache/model-proxy/spool` is not touched).

### fix(dashboard): a `TUI=1` / `DASHBOARD=1` start recorded no heatmap events and skipped token-limit enforcement — one shared mode-flag predicate, plus a 31-day monthly heatmap window and restore window

`areModeFlagsEnabled()` (`src/utils/dashboard-stats.ts`) accepted only `'true'`, while
`src/server.ts`'s startup gates accept `'true'` **or** `'1'`. Starting with the `=1`
spelling therefore turned on stats persistence, the 31-day retention window and JSONL
restore while every gated recorder stayed a no-op — so `tokenHeatmapEvents` was never
appended to, each dump wrote `heatmapEvents: { models: {}, sequences: [] }`, and the TUI
and dashboard heatmaps stayed empty with no error and no log line. The same `'true'`-only
predicate in `src/index.ts` also skipped the global and composite token-limit checks, so
under `TUI=1` those limits were **not enforced** (latent rather than immediate: the check
is skipped, not merely unrecorded).

`areModeFlagsEnabled()` is now exported from `src/utils/dashboard-stats.ts` alongside a
shared `isEnvFlagEnabled()` value helper, and `src/index.ts` and `src/server.ts` import
them — the recorders and the limit checks that read those recorders share one gate again.
The module's own dump-timer gate (`TUI` / `DASHBOARD` / `DUMP`) uses the same helper, so
`DUMP=0` no longer starts the 30-minute dump timer.

Second, independent defect: `getTokenHeatmapStatsMonthly()` filtered with
`TOKEN_HEATMAP_WINDOW_MS` (7 days) — the weekly view's constant — so the monthly panel
could never show anything older than a week even though retention keeps 31 days. It now
uses `TOKEN_HEATMAP_MONTHLY_WINDOW_MS` (31 days). Note: the panel buckets by
day-of-month, and a 31-day lookback can include the same day-of-month twice at the
window edge (e.g. day 1 of two consecutive months), which merges into one bucket.

Third, independent defect: the startup restore window was too small to reach that history.
`src/server.ts` sized `retentionDays` from the largest configured token-limit duration with
a **7-day** baseline, and `loadTokenStatsFromLog()` skips every JSONL row dated outside
that window — events included. With no `global_token_limit` and no composite `token_limit`
configured, a restart therefore loaded only the last 7 days: on a 90-row log holding
484,549,917 tokens over 8 dates, the dashboard showed 471,652,080 over 5 dates, and
heatmap events from 8 days back were never loaded at all (so the 31-day monthly panel was
empty too). The baseline is now 31 days, matching the monthly heatmap window and the
in-memory event retention. It cannot weaken limit enforcement: the baseline is only ever
raised by a configured limit duration.

`recordModelUsage()` and `recordDailyToken()` were never flag-gated, so the per-model
token counters in the JSONL were unaffected by the first defect — only `heatmapEvents`
(and the other gated recorders) went unrecorded.

Verified: `npm run typecheck` clean; `npm run test:unit` 1867/1867 (two new cases in
`dashboard-stats-tracking.test.ts` — `TUI=1` records exactly one bucket holding the
recorded token count, `TUI=yes` records none — plus two assertions added to the existing
restore case in `dashboard-stats-persistence.test.ts`: an 8-day-old event is present in
the monthly view and absent from the weekly one); a throwaway `TUI=1 PORT=7778` instance
against the real 90-row log now reports 484,549,917 tokens across 30 models, versus
471,652,080 before the baseline change.

### fix(gateway): Claude Code gateway compliance — error body forwarding, retry headers, SSE keep-alive, model discovery, beta pair regression test

Implements five items from `docs/claude_code_gateway_compliance_review.md`
(statuses updated there: now 10 FIXED/COMPLIANT, 1 PARTIAL, 2 PENDING).

- **Error bodies forwarded unmodified (CRITICAL, item 1)** — new `UpstreamApiError`
  (`src/utils/errors.ts`), a `ClaudeProxyError` subclass carrying the raw upstream body
  plus preserved headers (`content-type`, `retry-after`, `x-should-retry`,
  `anthropic-ratelimit-*`). `handleTargetApiError` / `handleResponsesApiError` throw it
  whenever an upstream body was captured, and `createErrorResponse` /
  `createResponsesErrorResponse` render that body **verbatim** with the upstream status —
  Claude Code matches upstream error wording for capability-rejection recovery. Non-JSON
  or missing bodies still fall back to the synthesized envelope, and the synthesized
  message is retained for server logs. Status/type/`instanceof` semantics are unchanged,
  so composite failover and the target-retry ladder are unaffected. Side effect: clients
  now see the upstream's own 401 message instead of the proxy's "check the configured
  api_key" guidance (still logged server-side).
- **`retry-after` + `x-should-retry` on the proxy's own 429/503 (CRITICAL, item 2)** —
  both error renderers emit the headers Claude Code reads on every 429/503, preferring a
  captured upstream `retry-after` (HTTP-dates normalized to integer delta-seconds per
  spec) and defaulting to 30s for purely local errors such as `OverLimitError`.
- **SSE keep-alive synthesis (CRITICAL, item 3)** — new `wrapSseStreamWithKeepAlive()`
  (`src/utils/sse-keepalive.ts`) injects `: ping` comment lines after 30s of upstream
  silence (Claude Code aborts a stream after 5 min without bytes; pingless upstreams like
  Bedrock eventstream could trip that). Applied centrally in `runAttempt` (`index.ts`)
  for every 2xx `text/event-stream` response — covering the native pass-through,
  converted paths, and the SDK handler — and in the passthrough handler's own SSE pipe.
  Comment lines are opaque to the usage/tool tracking transforms.
- **`/v1/models` discovery shape & filtering for Claude Code UAs (HIGH, item 4)** —
  shared `isAnthropicModelId()` / `toAnthropicModel()` helpers (`src/handlers/models.ts`);
  the ungated legacy path (`index.ts` `case 'models':`) now matches UA `claude-cli` **or**
  `claude-code` and returns the Anthropic shape with `description` and the
  claude/anthropic id filter, and no longer produces `Invalid Date` for entries without
  `created`. The gated `handleAnthropicModelsDiscovery` path (env
  `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`, 3s timeout, `redirect: 'error'`,
  `Authorization` + `x-api-key` forwarding) is unchanged.
- **Feature pass-through pair regression test (MEDIUM, item 8)** —
  `tests/unit/beta-passthrough-pairs.test.ts` runs the full `before_upstream` hook chain
  on the `anthropic-messages` path and asserts `thinking`, `context_management`,
  `cache_control` markers, `tools[].input_schema.strict`/`defer_loading`,
  `output_config`, and the `anthropic-beta` header all survive unchanged.

Tests: new coverage in `tests/unit/errors.test.ts` (raw-body forwarding, non-JSON
fallback, retry headers) and `tests/unit/sse-keepalive.test.ts` (relay, ping timing,
close, error propagation); `tests/unit/responses-stream-events.test.ts` and
`messages-handler.test.ts` updated from the old re-wrapping expectations to verbatim
forwarding. Verified: `npm run typecheck`, `npm run build`, and `npm run test:unit`
(1865/1865) all pass.

### fix(dashboard): dedupe the model-test request builders — dashboard now shares `src/utils/model-test.ts` with the TUI

The dashboard's `buildTestToolRequest` (`src/handlers/dashboard.ts`) was a mirrored copy
of the TUI's and had **diverged**: it hardcoded `max_tokens: 128` for every upstream mode,
so the dashboard "test model" button sent `max_tokens` to `openai-responses` /
`open-responses` routes, which reject it with `400 Unsupported parameter: 'max_tokens'`
(the TUI had already fixed this via `maxTokensField()` → `max_completion_tokens`).

The canonical builders (`maxTokensField`, `buildTestTextRequest`, `buildTestToolRequest`,
plus the `TEST_TOOL_*` constants) now live in **`src/utils/model-test.ts`**, imported by
both `src/tui.ts` (which re-exports them for existing callers/tests) and
`src/handlers/dashboard.ts` (mirrored copy deleted). The dashboard's OpenAI-mode test
request now carries `max_completion_tokens` for responses-mode routes, matching the TUI.

Verified: `npm run typecheck` clean; `tests/unit/tui.test.ts` 21/21 (exact request-shape
assertions per upstream mode); `dashboard-endpoints` / `dashboard-config` 24/24.

### docs(config): purge the removed `[default_upstream]` / `[upstream]` `default_*` keys from live docs, and pin `defaultBaseUrl` to `[models.default].base_url`

`docs/**`, `tests/**` comments, `CHANGELOG.md` — `[default_upstream]` was removed earlier
(CHANGELOG:255, a breaking change), yet live documentation still presented
`default_base_url` / `default_api_key` / `default_upstream_mode` as working config, and four
`src/` strings still named them. Nothing in `src/` reads those keys, so every occurrence was
stale. Cleaned up:

- **`src/` user-visible strings and comments** — `handlers/dashboard.ts` warned about
  `upstream.default_api_key`; `tui.ts`, `key-store.ts`, and `agent-tools.ts` comments named
  `default_api_key` / `default_base_url`. The only remaining mention is the intentional
  removal note at `utils/config-loader.ts:52`.
- **`docs/reference/configuration-reference.md`** — the whole `[default_upstream]` field
  section is replaced by "Global defaults — `[models.default]`", which states that the
  section is removed, that an unrecognized header is warned about at load time with its keys
  ignored, and that `[models.default]` is both the inheritance fallback and the Priority-3
  routing stop.
- **`docs/reference/routing-and-aliases.md`** — inheritance chains now read
  `per-entry → section → [models.default]`, and both "Who wins" tables reference
  `[models.default].api_key`.
- **Templates** — `proxy_config.example.toml`, `proxy_config.minimal.toml`,
  `configuration-guide.md`, and `README_DETAILS.md` drop their `[upstream]` /
  `[default_upstream]` blocks and document `[models.default]` as the global default instead.
  `proxy_config.toml_template` also had `[upstream]` holding `budget_to_effort_*` and
  `global_token_limit`, which are `[general]` fields — the section header is corrected to
  `[general]`, so those three settings actually load instead of being discarded with a
  warning.
- **Consul example** — `consul kv put model-proxy-v3/upstream/...` is corrected to
  `general/...` and `models/default/...`; `consul-loader.ts` recognizes only `general`,
  `defaults`, and `models`, so the old paths were silently dropped.
- **`docs/architecture/auth-stats-protocol.md`** — the auth-target descriptor table's `mode`
  row said its default came from `[default_upstream].upstream_mode`; it now names
  `[models.default].upstream_mode`, matching `descriptorToRoute`
  (`utils/target-retry.ts:244`), which layers `descriptor.mode` over
  `getDefaultUpstreamConfig(proxyConfig)`.
- **SSRF allowlist docs** — `api-endpoints.md`, `list_of_api_and_schema.md`,
  `README_DETAILS.md`, and the header of `tests/integration/16_security/ssrf_dynamic_route.test.js`
  now say the allowlist comes from `[models.*].base_url` (including `[models.default]`),
  per-model `base_url` overrides, and `[models.passthrough]` target bases — matching
  `getAllowedHostsFromConfig`.

Also adds `describe('getDefaultUpstreamConfig on a loaded config')` to
`tests/unit/config-loader.test.ts`, which loads real TOML through `loadProxyConfig` and
asserts, for six config shapes, that `getDefaultUpstreamConfig(config).baseUrl` **strictly
equals** `config.models.default.base_url` (including `undefined` when the section or its
`base_url` is absent, and the verbatim `''` a section-level empty string produces — only a
`primary` empty string is normalized to unset). A second test proves the removed
`[default_upstream]` / `[upstream]` `default_*` keys resolve to
`{openai-completions, undefined, undefined}`, create no model categories, and raise
`unknown section header` warnings for both section names.

### fix(embeddings): `[models.EMBEDDING].base_url` is required — `/v1/embeddings` no longer inherits `[models.default].base_url`

`src/index.ts`, `tests/unit/index-routing.test.ts`, docs — `/v1/embeddings` is a fixed route:
it forwards the caller's model id verbatim and never resolves a model entry, so the
inheritance chain documented for the other categories never really applied to it. The
category `base_url` used to fall back to the resolved default host
(`getDefaultUpstreamConfig` → `[models.default].base_url`), which meant an embeddings request
with no `[models.EMBEDDING].base_url` was silently sent to the inference provider. Embeddings
usually live on a different host — a local Ollama, a dedicated embedding provider — so that
fallback is gone:

- `[models.EMBEDDING].base_url` (or `[models.embedding].base_url`) is now **required**. A
  request without it throws before any upstream call and surfaces as `500` with
  `/v1/embeddings requires [models.EMBEDDING].base_url (or [models.embedding].base_url): this
  route does not inherit [models.default].base_url`. The previous `http://localhost` fallback
  is gone with it — `buildUpstreamUrl('', 'v1/embeddings')` would have produced the
  unparseable relative path `/v1/embeddings` anyway.
- Per-entry `base_url` still has no effect on this route, as before.

Only this route changed: model-route resolution in `resolveModelRouteFromEntry` still
inherits `[models.default].base_url` and still falls through to `http://localhost`, and
`api_key` inheritance is untouched — when `[models.EMBEDDING].api_key` is unset, the fixed
route still applies `[models.default].api_key` for `config_key` passthrough. Making `base_url`
EMBEDDING-specific while `api_key` stays inheritable means such a config can now send the
default provider's key to an embeddings host; set `[models.EMBEDDING].api_key` alongside
`base_url` if the hosts differ. That asymmetry predates this change (it applied whenever the
category `base_url` was set explicitly) but is now reachable in every config that has an
EMBEDDING section.

Covered by three cases in `tests/unit/index-routing.test.ts`: routing to
`[models.EMBEDDING].base_url` rather than `[models.default].base_url` when both are set; the
`500` for a missing section `base_url` (section omitted, and section present without
`base_url`) asserting the message and **zero** upstream calls in both configs; and
`ollama-embed` posting to `{base_url}/api/embed` with both directions converted. Docs
updated: `routing-and-aliases.md`, `configuration-reference.md`, `configuration-guide.md`,
`README_DETAILS.md`, `README.md`, and the three config templates.

### feat(embeddings): `upstream_mode = "ollama-embed"` fronts Ollama's native `POST /api/embed`

`[models.EMBEDDING]` is the one category where `upstream_mode` picks the *upstream wire
shape* rather than an inference request converter — `/v1/embeddings` is a fixed route, so
there is no target list and no per-target mode. It now accepts two values instead of
ignoring the field:

- `openai-completions` (default) — posts to `{base_url}/v1/embeddings`, body and response
  forwarded unchanged, exactly as before.
- `ollama-embed` — posts to `{base_url}/api/embed` and converts both directions: the
  request is reduced to `model` / `input` plus `dimensions`, `truncate`, `keep_alive`, and
  `options` when present (`user` and `encoding_format` are dropped), and the response's
  `embeddings` array is wrapped as `{object: "list", data: [{object: "embedding",
  embedding, index}], model, usage}`, with `prompt_tokens` and `total_tokens` both taken
  from Ollama's `prompt_eval_count` — the same accounting Ollama's own `/v1/embeddings`
  uses. Set `base_url` to the Ollama root, since the proxy appends `api/embed`.

Two failure modes are loud rather than silent. `encoding_format: "base64"` is rejected with
`400` before any upstream call, because `/api/embed` returns float arrays only and handing
floats to a caller that asked for base64 would be a silent correctness bug. A response
whose `embeddings` is missing or not an array of arrays is a `502`, not a response shaped
like a success. An unrecognized mode — a typo such as `ollama-embedd` — logs a
`models.EMBEDDING.upstream_mode` config warning naming the accepted values and falls back
to `openai-completions`; a warning rather than an error because the field was ignored here
before, so existing configs may hold stale values.

`EMBEDDING_UPSTREAM_MODES` is a new registry in `src/utils/upstream-modes.ts`, kept
separate from `UPSTREAM_MODES` so these values never reach the retry ladder or the
dashboard's target wizard. The dashboard's category `upstream_mode` select is now
category-aware and preserves any value that is on neither list, so saving from the
dashboard can no longer rewrite `ollama-embed` to the first option.

Covered by ten new cases in `tests/unit/embeddings.test.ts` (request conversion, Ollama-native
field forwarding, response conversion with the timing fields dropped, `usage` fallback when
`prompt_eval_count` is absent, model echo and fallback, the base64 `400` with zero upstream
calls, the three `502` shapes, an empty `embeddings` array as a successful empty result,
non-OK forwarding, and that an absent or `openai-completions` mode leaves the body
byte-identical) plus four `[models.EMBEDDING].upstream_mode` cases in
`tests/unit/config-loader.test.ts` (both accepted values silent, the typo warning's exact
message, and no false positive on other categories).

### feat(decision): add the `ollama` backend for Ollama's `POST /v1/systemone`

`[models.decision] backend = "ollama"` fronts Ollama's System One API — the base API
the Clef schemas are a documented extension of — so `/decision` and `/v1/decision` can
serve typed decisions from `nimble` / `tev` / `clef` / `clef:cloud` on a local Ollama
server (v0.35.0+) or Ollama's cloud (`url = "http://localhost:11434/v1/systemone"`).
The response envelope is byte-identical to Clef's, so nothing else changes.

- **Images are converted, not rejected.** System One takes images as bare base64
  strings and rejects data URLs and remote URLs, so the proxy rewrites the `images`
  array on this backend only: `data:<mime>;base64,<bytes>` → `<bytes>`, and
  `{content_type, base64}` → `base64` (dropping `content_type`, which has no System One
  equivalent). A bare base64 string passes through untouched. This is the first backend
  whose request body is not forwarded byte-for-byte; every other field keeps its value.
- **Unconvertible images fail loud.** A `data:` URL with no base64 payload, an object
  with no non-empty string `base64`, or a non-string/non-object entry is rejected with
  `400` naming the offending index (`images[N]`) before any upstream call, rather than
  being forwarded for the upstream to misread.
- **No model aliasing.** `model` is still the upstream's business: a Clef-only name such
  as `clef-flash` is passed through verbatim and rejected by Ollama. The timeout default
  is the 30000ms shared by the non-laya backends; `timeout_ms` overrides it.

Covered by nine new cases in `tests/unit/decision.test.ts` (data-URL stripping, object
flattening, bare-base64 and field passthrough, the three 400 shapes, byte-for-byte
forwarding when there are no images, the timeout default, and that other backends do
not convert) plus a `[models.decision]` backend-enum case in
`tests/unit/config-loader.test.ts`.

### feat(responses): allowed_tools enforcement, parameter forwarding, item lifecycle, logprobs (gap-review items 3, 8, 10, 12, 13)

Resolves the remaining gap-review items on the `/v1/responses` converter paths (`openai-completions`, `anthropic-messages`, `gemini-*` upstreams):

- **Item 3 — `allowed_tools` is now enforced as a hard constraint.** The converter translates `tool_choice: {type: "allowed_tools", tools: [...]}` to `auto` (or `none` for an empty subset) while keeping the full `tools` list upstream; both stream pumps and both non-streaming converters suppress any tool call outside the allowed set — no lifecycle events, no `output` entry — and log the suppressed count. If suppression empties the output, a fallback direct-reply message item keeps `output` spec-valid. A new exported `extractAllowedTools()` reads both the `tool_choice` form and a top-level `allowed_tools` array.
- **Item 8 — synthesized items now get full lifecycle events.** The reasoning item (built from upstream `reasoning_content` / `<think>` tags) is announced with `output_item.added` → `content_part.added` → `content_part.done` → `output_item.done`, and so is the empty fallback message item, in both pumps. Terminal `output` arrays are assembled in `output_index` order so event indices match payload positions.
- **Item 10 — dropped request parameters are forwarded or mapped.** `service_tier`, `metadata`, and `parallel_tool_calls` pass through; `text.format` (`json_schema` / `json_object` / `text`) maps to `response_format` and wins over a directly-passed `response_format`; `truncation: "auto" | "disabled"` is validated and deliberately not forwarded (completions upstreams fail on context overflow rather than truncating, which satisfies both modes). Invalid `truncation` / `text.format` values throw a 400 `ValidationError`.
- **Item 12 — unknown input item types now fail loudly.** The converter throws a 400 `ValidationError` for any unrecognized item type (including provider-slug-prefixed extension types) instead of warn-and-drop, matching the existing `program` / `program_output` behavior.
- **Item 13 — `logprobs` on deltas.** `response.output_text.delta` now carries the upstream's `logprobs.content` when present, `[]` otherwise (always `[]` on the Anthropic path, whose SSE deltas carry no logprobs).

Item 11 (un-prefixed `reasoning_text` / `namespace` extensions) is resolved as a **documented exception, no code change**: both spellings are read back on input by the converter and have a live round-trip dependency (Codex/DeepSeek), so dual-emitting prefixed variants would double-inject content on the next turn. Recorded in the gap review.

### feat(responses): spec error envelope and previous_response_not_found (gap-review decisions A/B)

Resolves the two open decisions in `docs/api/review-for-gaps-to-the-open-responses-spec.md`:

- **Decision A (item 4)**: with `CONVERSATION_STATE` enabled, a `previous_response_id` that is not in the store now fails the request with 404 `{error: {type: "not_found", code: "previous_response_not_found", param: "previous_response_id"}}` instead of silently answering without the prior context. With state disabled the field is still ignored, preserving the existing locked-in behavior. The prior-history merge (prior input → prior output → new input) now also runs on the `anthropic-messages` and `gemini-*` converter paths via a shared `applyConversationState` helper — previously those paths dropped the field entirely.
- **Decision B (item 7)**: `/v1/responses`-family routes now emit the spec error envelope `{error: {message, type, param, code}}` with the spec's type vocabulary (`invalid_request`, `not_found`, `too_many_requests`, `server_error`), via new `ResponsesApiError` / `createResponsesErrorResponse` / `handleResponsesApiError` in `src/utils/errors.ts`. The outer catch in `src/index.ts` selects the envelope by path; `/v1/messages` and other endpoints keep the Anthropic-shaped envelope unchanged.

### fix(responses): spec-compliant terminal events, content-part lifecycle, and incomplete status on converter paths

Three Open Responses spec violations on the `/v1/responses` converter paths (`openai-completions`, `anthropic-messages`, `gemini-*` upstreams) — the passthrough modes were already compliant by delegation:

- **Mid-stream errors now emit `response.failed`** instead of silently closing the stream. Both SSE pumps (`streamCompletionsAsResponses`, `streamClaudeAsResponses`) send a terminal `response.failed` event with a populated `response.error` once `response.created` has gone out, and log the upstream error instead of swallowing it.
- **`response.content_part.done` is now emitted** between `response.output_text.done` and `response.output_item.done` in both pumps, and every `output_text` part carries the spec-required zero-value `annotations: []` (streaming events, terminal `output` arrays, and the non-streaming converters).
- **Token exhaustion now surfaces as `incomplete`**: `finish_reason: "length"` (Completions) and `stop_reason: "max_tokens"` (Anthropic) map to item/response `status: "incomplete"`, terminal event `response.incomplete`, and `incomplete_details: { reason: "max_output_tokens" }`, in both stream pumps and both non-streaming converters (`convertCompletionsToResponses`, `claudeResponseToResponses`). Previously truncation was misreported as `completed`.

The Claude pump's text events also no longer hardcode `output_index: 0` — the text item's allocated index is tracked, fixing item association when a `tool_use` block precedes text. New `tests/unit/responses-stream-events.test.ts` adds the first SSE event-shape coverage (full lifecycle sequence, mid-stream failure, truncation) for both pumps plus non-streaming conversion; two exact-body expectations in `responses-endpoints.test.ts` gained the `annotations: []` field.

### feat(modes): add `open-responses` upstream mode and endpoint schema

`upstream_mode = "open-responses"` targets an [Open Responses](https://www.openresponses.org) spec-compliant upstream. The spec's wire format is identical to the OpenAI Responses API (same `/v1/responses` resource, SSE events, and error envelope), so the mode canonicalizes to `openai-responses` at route resolution: `/v1/responses` requests pass through natively, and every other client endpoint (`/v1/messages`, `/v1/chat/completions`, `/v1/interactions`, `:generateContent`) converts through the existing Responses transform paths. `open-responses` passthrough targets match `/v1/responses*` paths, and the embedded agent session offers `open-responses` as an endpoint schema (served by the same `/v1/responses` loopback). The WebSocket transport from the 2026-04-24 spec revision is not implemented (the spec marks it MAY).

### build(ci): build the native binary for every supported target

`.github/workflows/ci.yml` — `npm run build:native` moved out of the ubuntu
`test` job into one leg per target, because a SEA binary embeds the Node that
built it and cannot be cross-compiled. The matrix covers all six targets
(`x86_64` and `aarch64` on Linux, macOS, and Windows, via `ubuntu-latest`,
`ubuntu-24.04-arm`, `macos-latest`, `macos-15-intel`, `windows-latest`, and
`windows-11-arm`), instead of the three an OS-only matrix reached. Each leg looks
for `dist/model-proxy-v3-<triple>` and fails if it is missing, which also proves
the runner is the architecture the matrix claims; on Windows the expected name
additionally ends in `.exe`, the suffix Tauri resolves an `externalBin` sidecar
to. Binaries upload as artifacts named after their triple, and a new
`release: [published]` trigger attaches all six to that release. The matrix is
skipped on pull requests, which keep the ubuntu typecheck/build/test gate.
README.md gains a target table and lists the targets that are deliberately not
built (universal macOS, musl Linux, 32-bit).

### test(unit): increase interactive function coverage

`tests/unit/` — exercise populated dashboard composite/schedule/statistics/tool overlays, monthly heatmap rendering, and agent working-directory submission through mocked terminal and local skills-CLI dependencies. The agent startup test also verifies clean abort with an empty model configuration and no upstream requests.

### test(unit): cover streamed bodies and defensive response extraction

`tests/unit/` — add seven tests for content-length-free request buffering, OpenAI reasoning/tool history conversion to Responses input, dashboard malformed JSON and OpenAI tool/error formatting, and dashboard-stat malformed-node handling, response-tool deduplication, and duplicate-tool request-size aggregation.

### test(unit): cover interactive TUI and agent startup lifecycles

`tests/unit/` — drive the real dashboard renderer and help overlay through mocked TTY streams, verifying refresh/timer and terminal cleanup; cancel the agent's first prompt through its real input handler, verifying early exit, ANSI-free trajectory logging, and console/stream restoration without network access.

### test(unit): cover dashboard route tables and request guards

`tests/unit/` — add five tests for dashboard stats/tools/quota/mutation dispatch, malformed model JSON, global token-limit enforcement, OpenAI-style thinking normalization, and nested Responses tool/usage extraction.

### test(unit): cover dashboard tracking and dispatch paths

`tests/unit/`, `src/utils/dashboard-stats.ts` — add 12 tests for dashboard model-test variants and quota validation, timing/response-tool tracking and fragmented SSE, Messages upstream errors, and Decision/passthrough dispatch. Timing recorders now ignore non-finite samples, and response tool-name collection deduplicates repeated names.

### test(unit): cover persistence and remaining routing branches

`tests/unit/` — add 10 tests for dashboard composite/schedule mutations, JSONL stats restore/dump, Messages reasoning/options/stream conversion, dashboard API authentication, request-size limits, and plain Messages routing.

### test(unit): cover low-coverage routing, dashboard, and utility paths

`tests/unit/` — add 47 tests for dashboard page/stats/model-test endpoints, TUI startup and model defaults, Consul KV parsing and URL guards, tool blocklist filtering, agent-session filesystem/skill edges, Messages reasoning/tool streaming, dashboard-stat lifecycle and extraction helpers, and top-level CORS/admin/health/auth/model routing.

### test(unit): broaden source function and handler coverage

`tests/unit/` — add 82 tests for heatmap aggregation/rendering, model caching/discovery, embeddings, token-counting handlers, Messages/Responses conversion and passthrough, TUI request builders/model resolution, and dashboard config sanitization/persistence/validation. Upstream requests are mocked and mutable global/config state is restored between tests.

### test(server): cover the Node HTTP adapter

`src/server.ts`, `tests/unit/server.test.ts` — environment construction, response-header filtering, and request adaptation are now exported and startup runs only for direct execution. Unit tests cover GET/POST forwarding, non-streaming and SSE responses, request-counter release, and handler failures through an ephemeral local HTTP server.

### docs(api): gap analysis of `/v1/responses` against the Open Responses specification (2026-04-24)

`docs/api/review-for-gaps-to-the-open-responses-spec.md` — new review document comparing the `/v1/responses` implementation against `docs/api/spec-of-open-responses-2026-04-24.mdx.txt`. Sixteen items, each with the spec quote (line-cited), current behavior with `file:line` evidence, the minimal fix, and a status; plus a scope rule, a verified-compliant list, a status summary table, and an implementation order.
Analysis only; no code changed. 

### fix(deps): install Keytar's platform prebuilds from the npm registry

`package.json`, `README.md`, `docs/reference/configuration-reference.md`, `docs/getting-started/proxy_config.example.toml` — the optional `@github/keytar` dependency is now pinned to the exact npm registry release `7.10.6` instead of the same-version GitHub tag. The Git checkout contains no `prebuilds/` or `build/Release/keytar.node`, so macOS failed at startup with `Failed to load keytar native addon`; the registry tarball includes `darwin-arm64` and the other platform binaries, and its install script copies the active one into `build/Release`. Existing same-version Git checkouts may need the documented explicit reinstall once because a plain `npm install` can consider them up to date.

**Verification status**: registry `darwin-arm64` prebuild installed successfully, `import('@github/keytar')` passed, a read-only native macOS lookup of a deliberately missing item returned `null`, `npm run typecheck` (pass), `npm run build` (pass), and `npm run test:unit` — **1608 tests, 1608 pass, 0 fail** — executed on this tree.

### fix(config): consolidate system keychain keys into one item

`src/utils/key-store.ts`, `tests/unit/key-store.test.ts`, `README.md`, `docs/reference/configuration-reference.md`, `docs/getting-started/proxy_config.example.toml` — all logical `<target_model_id>/<base_url>` api_keys now live in one JSON object under the reserved `__api_keys_v1__` account in the existing `model_proxy_v3` service. Normal sentinel resolution performs one native keychain read regardless of key count, so macOS item authorization no longer prompts separately for every key; best-effort fallback and the TUI account list read the same bundle. Existing per-account items are migrated automatically when no bundle exists and left in place afterward. The one-time migration still has to read each legacy item and can therefore produce one prompt per old item.

**Verification status**: focused key-store/body-key-store tests (**31 tests, 31 pass, 0 fail**), `npm run typecheck` (pass), `npm run build` (pass), and `npm run test:unit` — **1608 tests, 1608 pass, 0 fail** — executed on this tree. The real macOS GUI permission dialog was not exercised by automated tests.

### fix(config): remove deprecated `[tool_judge_sidecar]`, `[transform_defaults]`, `[decision]`, `[passthrough]` section headers

`src/utils/config-loader.ts`, `tests/unit/config-loader.test.ts`, `tests/unit/transforms-config.test.ts`, `docs/getting-started/validating_tool_judge_sidecar.md` — the back-compat branches for the four old section headers are deleted. They now fall through to the generic unknown-section branch like any unsupported header: their keys are ignored, the config field stays unset, and an "unknown section header … keys under it are ignored" warning is recorded in `_validationWarnings` (surfaced in the TUI/dashboard status). The canonical headers `[tool_judge]`, `[transforms.default]`, `[models.decision]`, `[models.passthrough]` are unchanged, as are the `[models.decision.x]` / `[models.passthrough.x]` / `[transforms.default.x]` third-part guards.

**Breaking change**: configs still using `[tool_judge_sidecar]`, `[transform_defaults]`, `[decision]`, or `[passthrough]` must rename them to `[tool_judge]`, `[transforms.default]`, `[models.decision]`, `[models.passthrough]` — until renamed, those sections silently stop applying (tool judging disabled, decision endpoint disabled, passthrough targets gone, transform mode-defaults unwired).

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — **1604 tests, 1604 pass, 0 fail** — executed on this tree.

### fix(config): rename section header — `[transform_defaults]` → `[transforms.default]`

`src/utils/config-loader.ts`, `README.md`, `docs/getting-started/proxy_config.example.toml`, `docs/getting-started/proxy_config.transforms.example.toml`, `docs/reference/configuration-reference.md`, `docs/reference/transforms-reference.md`, `docs/reference/index.md`, `docs/api/list_of_api_and_schema.md`, `tests/unit/transforms-config.test.ts`, `tests/unit/config-loader.test.ts` — the transform-defaults section header gets a canonical name:

- `[transform_defaults]` → `[transforms.default]`

The parser intercepts `[transforms.default]` **before** the generic `[transforms.<name>]` branch (which would otherwise treat the second dotted part as a transform-set name), mapping it to the existing internal section `transform_defaults` with `currentCategory = null` — so it never creates a transform set named `default`, and all key parsing, validation, and the `config.transform_defaults` field are unchanged. **This reserves `default` as a transform-set name**: a config that declares `[transforms.default]` with actual transform-set keys (`schema`/ops) will now have those keys parsed as transform-defaults entries instead — rename such a set if you have one. The old `[transform_defaults]` header still parses but emits a deprecation `console.warn`, following the existing `[remote.authentication]` pattern; when both headers appear in one file, the later section wins (unchanged pre-existing behavior). `serializeProxyConfigToml` now writes `[transforms.default]`, so configs saved from the dashboard/TUI migrate on save. Docs, comments, and example configs updated; historical documents (prior `CHANGELOG.md` entries, `docs/architecture/`, `docs/contributing/`, `docs/plan-*.md`, `docs/review-*.md`) intentionally untouched.

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — **1608 tests, 1608 pass, 0 fail** — executed on this tree.

### fix(config): rename section headers — `[tool_judge]`, `[models.decision]`, `[models.passthrough]`

`src/utils/config-loader.ts`, `src/handlers/decision.ts`, `src/handlers/dashboard.ts`, `src/tui.ts`, `src/utils/key-store.ts`, `proxy_config.toml`, `README.md`, `docs/getting-started/proxy_config.example.toml`, `docs/getting-started/validating_tool_judge_sidecar.md`, `docs/reference/configuration-reference.md`, `docs/reference/routing-and-aliases.md`, `tests/unit/config-loader.test.ts`, `tests/unit/key-store.test.ts`, `tests/unit/decision.test.ts`, `tests/manual/proxy_decision_config.toml`, `tests/manual/proxy_laya_real.toml`, `tests/manual/verify_decision_e2e.sh`, `tests/integration/README.md` — three TOML section headers get canonical names:

- `[tool_judge_sidecar]` → `[tool_judge]`
- `[decision]` → `[models.decision]`
- `[passthrough]` → `[models.passthrough]`

The parser's section dispatch maps each new header onto the existing internal section (`tool_judge_sidecar` / `decision` / `passthrough`), so all key parsing, validation, and the `ProxyConfig` fields are unchanged. `[models.decision]` and `[models.passthrough]` are intercepted **before** the generic `[models.*]` branch, so they never create `decision`/`passthrough` model categories. The old headers still parse but emit a deprecation `console.warn`, following the existing `[remote.authentication]` deprecation pattern; when both old and new headers appear in one file, the later section wins (unchanged pre-existing behavior). `serializeProxyConfigToml` now writes the canonical headers, so configs saved from the dashboard/TUI migrate on save. Docs, comments, and UI strings updated to the canonical names; historical documents (`CHANGELOG.md` prior entries, `docs/architecture/`, `docs/plan-*.md`, `docs/review-*.md`) intentionally untouched.

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — **1604 tests, 1604 pass, 0 fail** — executed on this tree.

### fix(agent): resolve the loopback client key per selected model alias

`src/agent-session.ts` — agent-session model verification 401ed for any alias whose upstream key differs from `[models.default].api_key`, even when the same model tested green in the dashboard/TUI. Root cause: outside the `free` section (and `config_key` mode) the proxy forwards the *caller's* credential upstream, and the agent session authenticated every loopback `/v1/messages` call with one static key — `PROXY_CLIENT_API_KEY`, else the placeholder `sk-hi-agent-launched-in-proxy-v3`, else the default key — so upstreams received the placeholder and answered 401 (`Invalid API key` / `Missing Authentication header`). The dashboard and TUI model tests were never affected because they already send the model's own configured key.

The client key is now resolved per selected alias with the same precedence those tests use: `PROXY_CLIENT_API_KEY` → the alias's configured `route.apiKey` (via `getModelRouteConfig`) → `[models.default].api_key` → agent-mode placeholder. Composite aliases keep the old fallback (per-target keys are applied proxy-side). The up-front "no client API key" abort now also recognizes per-alias keys as a valid key source.

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — **1594 tests, 1594 pass, 0 fail** — executed on this tree; live-verified end-to-end through the local proxy (`/v1/messages` → `default-deepseek-v4.1-qn` → qnaigc upstream, real 200 response).

### fix(config): remove `[default_upstream]` section, use `[models.default]` as sole fallback

`src/utils/config-loader.ts`, `src/utils/key-store.ts`, `src/utils/consul-loader.ts`, `src/index.ts`, `src/tui.ts`, `proxy_config.toml` — deprecated `[default_upstream]` and its `default_*` keys are fully removed. The single fallback is now `[models.default]` with the same fields (`api_key`, `url`, `model`, `weight`, `timeout_ms`, `max_retries`, `headers`). All config sources (TOML, keychain, Consul/Apollo) and consumers (composite resolution, TUI model test, config_key mode) updated.

**Breaking change**: configs with `[default_upstream]` must migrate to `[models.default]`.

### feat(composite): decision mode — Clef `/decision` API for ability-based target selection

`src/utils/config-loader.ts`, `src/index.ts`, `tests/unit/config-loader.test.ts`, `docs/architecture/design_decision_composite_targeting.md` — new **decision mode** for `[composite]` aliases that uses the Clef `/decision` protocol to intelligently select a target model based on declared abilities.

- **Trigger condition**: activates **only** when **no** static targeting (`primary`/`fallback`/`share`) is configured **and** at least one target has an `ability` field (comma-separated skills like `ability = "coding,reasoning,analysis"`).
- **Protocol**: POST `{model, state, questions}` to the Clef `/decision` endpoint → returns `{answers: {target_selection: {choice, probabilities, confidence}}}`.
- **Fail-open**: any decision API failure (network, timeout, invalid response) falls back to declaration order — same pattern as the tool judge sidecar.
- **Config mirrors `JudgeSidecarConfig`**: `decision = { model = "clef", url = "https://…", api_key = "…", threshold = 0.5, timeout_ms = 3000, context_prompts = 1 }` — all fields optional except `model` and `url` when the block is present.
- **Static precedence**: `primary` → `fallback` (ascending) → `share` (weighted random) → `decision` (ability-based) → declaration order.
- **Quote-aware comma splitting** for `ability` field parsing (e.g., `"coding, reasoning, analysis"`).
- **Integration**: `resolveCompositeWithDecision()` called from `src/index.ts` during composite alias resolution; uses existing `callDecisionApi()` to avoid duplication.

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — **all 201 config-loader tests pass** — executed on this tree.

### docs(readme): add Tool Judge Sidecar section with Clef decision API support

`README.md` — added dedicated documentation for the `[tool_judge_sidecar]` section
after the Decision endpoint, covering:
- Two protocols: legacy sidecar (`/judge`) and Clef decision API (`/decision`, enabled
  via `use_decision_api = true`)
- Two modes: `choice` (per-tool) and `noul` (batch)
- Fail-open behavior, response time expectations
- Reference sidecar server commands for both protocols
- Full configuration reference including new `use_decision_api` and `model` fields

### fix(config): drop invalid tool_judge_sidecar.model values during parsing

`src/utils/config-loader.ts`, `tests/unit/config-loader.test.ts` — invalid `model` values in `[tool_judge_sidecar]` (e.g., `model = "invalid-model"`) are now silently dropped during TOML parsing instead of being stored and then flagged by `validateProxyConfig`. Valid values (`laya`, `clef`, `clef-flash`) are accepted; unrecognized values leave `model` as `undefined`, matching the behavior of other fields like `use_decision_api` that coerce/validate during parsing.

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — all config-loader tests pass.

### feat(judge): judge state carries only tool name + description; noul mode chunks to cover every tool

`src/utils/tool-judge-sidecar.ts`, `src/utils/tool-shapes.ts`, `tests/unit/tool-judge-sidecar.test.ts`, `docs/architecture/design_tool_judge_sidecar_protocol.md`, `docs/getting-started/proxy_config.example.toml`, `docs/getting-started/validating_tool_judge_sidecar.md` — two changes to what the judge is shown and how many tools reach it.

- **Tool context is name + description, not schema.** `buildStateText` serialized each tool's full parameter schema into the state (`1. Read: {"type":"object",…}`), which burned the sidecar encoder's small token budget. `ToolRecord` now carries an optional `description` extracted from all three wire shapes (Claude `description`, OpenAI `function.description`, Gemini `functionDeclarations[].description`; omitted entirely when absent so record shape is unchanged), and the state line is `N. name: description` (600-char cap, `MAX_SCHEMA_CHARS` renamed `MAX_TOOL_DESCRIPTION_CHARS`). Tools without a description render as just `N. name` and are judged on the name alone.
- **noul mode chunks instead of skipping.** Tools past `max_batch_tools` used to be silently kept (`skippedNames`); now the tool list is judged in sequential chunks of `max_batch_tools` per request, each chunk's state carrying only its own tools. Per-request timeout is unchanged: `N questions × timeout_ms`, hard-capped at 2000ms. A failed chunk fails open for just its tools; other chunks still judge. `skippedNames` stays in the `JudgeResult` shape but is always empty; the "over max_batch_tools" log text is gone.
- **Tests**: the old "caps the batch at max_batch_tools" test became a chunking test (4 tools at `max_batch_tools = 2` → 2 requests, disjoint question sets, per-chunk state isolation, all 4 judged); the §4.1-sections and truncation tests now pin the name+description line and the schema's absence; the choice-mode isolation test matches the description-less line format.

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — **1550 tests, 1550 pass, 0 fail** — executed on this tree.

### feat(judge): strip client-injected content from the judged prompt

`src/utils/tool-judge-sidecar.ts`, `tests/unit/tool-judge-sidecar.test.ts` — the judged `User prompt` line carried whatever client harnesses embedded in the user message (a Claude Code `<system-reminder>` date block is ~60 tokens of the sidecar's 512-token budget and says nothing about tool relevance). `stripClientInjectedContent` now cleans the prompt line in three layers; the upstream request body is never touched.

- **Layer 1, known tags.** Blocks stripped with contents and surrounding whitespace (`\s*`, so Claude Code's newline+indentation separators between adjacent blocks are handled): `system-reminder` (Claude Code), `environment_context` (Codex), `local-command-stdout`/`-stderr` (Claude Code `! cmd`), `ide_opened_file`/`ide_selection` (Claude Code IDE integration), `command-message` (slash-command boilerplate). Open/close names must match via a `\1` backreference — unclosed or mismatched tags pass through. The Claude Code local-command `Caveat: The messages below were generated…` paragraph is matched to end-of-line.
- **Slash-command unwrapping.** `<command-name>` and `<command-args>` hold what the user actually typed, so their tags are removed but the inner text is kept (`<command-name>/mcp</command-name>…hi` → `/mcp\n\nhi`).
- **Layer 2, generalized leading tag blocks.** Any leading paragraph wholly wrapped in a matched tag pair and followed by a blank line is stripped regardless of tag name, covering clients whose tags we don't know. The blank-line requirement is the safety rail: `<div>x</div> what does this HTML render?` is untouched.
- **Layer 3, heuristic fallback.** Only when no tag matched at all: blank-line-separated leading paragraphs made *entirely* of machine-looking lines (`key: value`, ISO dates, bare paths, single-line tag pairs) are dropped, keeping from the first human-looking paragraph on. Genuine multi-paragraph prompts (`here is the error:\n\nTypeError: boom\n\nhow do I fix it?`) survive because one prose line keeps a paragraph.
- **Tests**: 12 buildStateText cases cover each layer — per-tag stripping, command unwrap, mid-message blocks, unclosed-tag passthrough, unknown-tag generalized stripping, blank-line gating, machine-paragraph dropping, prose preservation.

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — **1550 tests, 1550 pass, 0 fail** — executed on this tree.

### feat(judge): debug trail for sidecar request, response, decisions, and erasures

`src/utils/tool-judge-sidecar.ts`, `src/utils/tool-blocklist.ts`, `src/index.ts` — at `LOG_LEVEL=debug` a judged request now leaves a complete trail: the exact request payload (`Tool judge sidecar request to <url> (<mode> mode, N question(s), timeout Xms): <json>`, truncated at 4000 chars, logged from the same serialized string that goes on the wire), the raw sidecar response body, one line per tool decision with its factor (`Bash -> erase (confidence=0.1203, noul=0.12)`), per-tool unjudged markers, the existing summary, a pre-erase notice, and per-tool erase lines that name the source — `static blocklist` vs `judge sidecar, confidence=X.XXXX` — via a new `eraseFactors` map on `JudgeResult` threaded into `eraseBlockedTools` (new optional parameter).

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — **1550 tests, 1550 pass, 0 fail** — executed on this tree; live-verified against a remote laya-mlx sidecar (request → raw response → decisions → summary → erasures all present in one request id's log).

### fix(logger): `createLogger` falls back to `process.env.LOG_LEVEL`

`src/utils/logger.ts` — `createLogger` read the level only from its argument, so every module-scope `createLogger({})` (the tool-judge sidecar client among them) was pinned to `info` and its debug output was silently dropped even with `LOG_LEVEL=debug` — the symptom was a request-scoped debug line appearing while the same request's judge-side debug lines vanished. The level now resolves as `env.LOG_LEVEL ?? process.env.LOG_LEVEL ?? 'info'`. `process` access was already assumed in this module (the `AGENT` check at load time), and the fallback also unsticks the other `createLogger({})` call sites.

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — **1550 tests, 1550 pass, 0 fail** — executed on this tree.

### fix(health): warn and skip the model count when no default upstream is configured

`src/index.ts` — the `/health` handler interpolated `getDefaultUpstreamConfig`'s possibly-undefined `baseUrl` straight into `` `${baseUrl}/v1/models` ``, producing a fetch of `undefined/v1/models` and a confusing `Failed to parse URL` error on any config without a `[models.default]` table or `[default_upstream].default_base_url`. The handler now logs `Health check: no default upstream configured … — skipping upstream model count` at warn level and falls through to the existing `404 No models Found.` response without attempting the fetch.

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — **1550 tests, 1550 pass, 0 fail** — executed on this tree, plus a live check: `GET /health` on a config without a default upstream now emits the warning and the 404, with no parse error.

### fix(converters): emit Gemini-enum `finishReason` and keep finish-only chunks in the OpenAI→generateContent conversion

`src/converters/openai-to-gemini.ts`, `tests/unit/openai-to-gemini.test.ts` — an OpenAI-upstream model tested through the proxy's Gemini endpoint (`/v1beta/models/{alias}:streamGenerateContent`, e.g. from the agent-session endpoint-schema picker via pi-ai / `@google/genai`) failed verification even though the reply arrived fine, because the egress conversion violated the Gemini finish-reason contract twice.

- **Lowercase `finishReason` leaked through.** The converter copied OpenAI's `finish_reason` verbatim (`"stop"`), but the Gemini API uses the uppercase enum (`"STOP"`, `"MAX_TOKENS"`, …) and strict SDKs switch on it — `@google/genai`'s `mapStopReason` throws `Unhandled stop reason: stop`. A new `toGeminiFinishReason()` helper maps `stop`/`tool_calls`/`function_call` → `STOP`, `length` → `MAX_TOKENS`, `content_filter` → `SAFETY`, passes through values that are already uppercase enum members, and maps unknown lowercase values to `OTHER`.
- **Finish-only chunks were dropped.** OpenAI upstreams end streams with an empty-delta chunk carrying only `finish_reason`; with zero convertible parts the converter deleted `candidates`, the SSE loop in `src/handlers/openai.ts` skipped the chunk, and the stream ended with no `finishReason` anywhere — `@google/genai` then throws `Google stream ended without a finish reason`. Such chunks now emit a candidate with empty `parts` and the mapped `finishReason`; genuinely empty keepalive chunks (no finish reason) are still dropped.
- pi-ai catches either throw and marks the assistant message `stopReason: "error"`, which is why agent-session's verification reported "verifying failed" on a healthy round-trip. The Interactions sibling converter carries no `finishReason` field and needed no change.
- **Tests**: `tests/unit/openai-to-gemini.test.ts` — existing lowercase assertion updated to `STOP`, plus 4 new cases: the 5-entry lowercase→uppercase mapping table, uppercase passthrough (`RECITATION`), unknown lowercase → `OTHER`, and the finish-only chunk (empty delta + `finish_reason: 'stop'` → candidate with empty parts + `STOP`, not dropped).

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — **1538 tests, 1538 pass, 0 fail** — executed on this tree, plus a live end-to-end check against `tsx src/server.ts` with an OpenRouter-backed alias: `:streamGenerateContent?alt=sse` now terminates with `finishReason: "STOP"` and non-streaming `:generateContent` returns `"STOP"` (both previously lowercase/absent).

### chore(handlers,converters): delete verified-dead gemini code paths

`src/handlers/gemini.ts`, `src/converters/claude-to-gemini.ts`, `src/converters/gemini-streaming.ts`, `docs/dead-duplicate-code-review.md` — dead-code removals from the repo-wide review (findings and per-item fix status live in the review doc).

- **`gemini.ts`**: the unused `GeminiConfig`/`DEFAULT_GEMINI_CONFIG`/`getGeminiConfig()` block, the never-called `extractInteractionId()`, and the unreachable `'openai-compatible'` `endpointType` branches — unreachable because the router dispatches only `'interactions'`/`'native-gemini'` into this handler (openai-compatible clients bound for a Gemini upstream go through `chat-completions.ts`/`responses.ts`), and a Gemini `generateContent` upstream can never return an OpenAI-shaped body. Both `endpointType` unions narrowed accordingly; the consequentially-unused imports (`convertGeminiToClaudeResponse`, `convertOpenAIToClaudeResponse`, `createStreamTransformer`) removed. `convertGeminiToClaudeResponse` is now production-dead (test-only) and flagged as such in the review doc.
- **`claude-to-gemini.ts`**: the ~240-line dead island of six internal converters (`convertClaudeMessagesToGeminiInput`, `convertClaudeContentToGemini`, `mapClaudeImageMimeToGemini`, `convertClaudeToolToGemini`, `convertClaudeConfigToGemini`, `convertClaudeToolChoiceToGemini`) that only ever called each other, plus the imports only they used; the live `decodeDataUri` and both exported entry points are untouched.
- **`gemini-streaming.ts`**: `processContentDelta`, never called (the live handlers inline the same event construction).

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — **1538 tests, 1538 pass, 0 fail** — executed on this tree. No test changes were needed: existing suites only import the live exports.

### fix(agent): hide the shell `!` in the input, reset the prompt after submit

`src/agent-session.ts` — typing a leading `!` swapped the input prompt from `>` to `!`, but the value still carried its own `!`, so the line rendered doubled (`! !ls`). `render` is now wrapped while idle to drop the value's leading `!` from the display (the value keeps it for the task loops' `startsWith('!')` check and the history entry), and `handleInputSubmit` clears the indicator back to `>` as soon as a command is emitted rather than relying on the next keystroke.

### fix(agent): compact million/billion-scale usage in task status

`formatUsage` now renders million/billion-scale used-token counts with up to two decimal places, so the task status reads `usage: 1.93m tokens / 50m limit and 1 / 100 turns` (`2.5b` once past a billion); values below one million and existing budget-limit formatting are unchanged. Unit coverage pins fractional (`1.93m`, `2.5b`) and whole (`2m`, `3b`) forms.

### feat(agent-tui): ctrl-s steers mid-run input, one status line for both renderers, and diff-aware shell output

`src/agent-session.ts`, `tests/unit/agent-session.test.ts`, `docs/architecture/design_of_persistent_tui_of_agent_with_followup_for_task.md` — four passes over the interactive session: mid-run input can be steered into the running task instead of queued as a follow-up, the TUI status bar and the raw stderr process-log now render the same line from one helper (the shadowing that pinned the status bar at zeros is gone), `!` shell output that reads as a unified diff renders green/red instead of through Markdown, and the tab-title glyph cycle holds each letter long enough to read.

- **Steer mode (ctrl-s).** `handleInputSubmit`'s mid-run branch was a hard-coded `followUp()`; it now routes to `runningAgent.steer(message)` when the new module-scope `steerMode` is set and `followUp()` otherwise, with both queues left on pi-agent-core's default `"one-at-a-time"` drain (`steer()` lands at the next turn boundary *inside* the running task; `followUp()` waits until the agent would otherwise stop). The mode is a sticky toggle, not a per-message prefix, and the prompt shows it: the new `agentInputPrompt(steer, busyFrame, shell)` composes `⚡> ` idle / `⚡⠇ ` while the spinner runs, and the echoed user line is badged `⚡ ` to match. Toggle feedback goes to the transient proxy-log row (one row, replacement semantics) rather than the transcript. `ctrl+s` is unbound in pi-tui's `TUI_KEYBINDINGS` defaults and is consumed by the `persistentTui.addInputListener` registered in `startPersistentTui`, so the focused `Input` never sees the byte.
- **One status line, one set of counters.** The `(π …)` line was built inline in two places — `updateStatusBar` (TUI) and `printProcessLog` (stderr) — reading *different* variables: the process-log copy read `runAgentSession`'s locals while `updateStatusBar` read the module-scope names, which at HEAD were only ever declared (`let skillsUsed = 0` etc., assigned nowhere at module scope). Under the persistent TUI every counter in the status bar therefore read 0 and the trailing dots never advanced past a single `.`. `buildStatusLine()` now owns the line (both callers, plus `progressTick` now module-scope), `skillsUsed`/`selected`/`toolsUsed`/`tokensUsed`/`turnsUsed`/`resultsReceived`/`progressTick` are assigned and reset by `runAgentSession` instead of being shadowed by locals of the same name, and filtering the empty parts drops a stray ` | ` the old template emitted when there were tools but no skills.
- **Two renderers, no double-write.** `printProcessLog` returns immediately while `persistentTui` owns the screen: the TUI parks the cursor on the input row, so the raw stderr carriage-return line would land on it and blink against the TUI's own redraws. The 400ms ticker's gate changed from `isStderrTty` to `!isStderrTty && !persistentTui` — a TUI gets animated dots from `updateStatusBar` even when stderr is a pipe, and a piped log still gets no interval at all.
- **Dead module state deleted.** `let budget: Budget | null = null` with its `budget = budget` self-assignment is gone (every read of `budget` is the local declared at 1815), as is `const skillsUsedNames: string[] = []` — declared with a comment describing a population that never happened and referenced nowhere.
- **Title glyph cadence.** `agentTitleGlyph`'s cycle went 20 ticks → 23: after `π`×14, `o`/`u`/`n` are held 3 ticks each (`o,o,o,u,u,u,n,n,n`) instead of one, so each letter stays on screen ~0.45s instead of ~0.15s (cycle 3s → 3.45s at 150ms/tick).
- **Diff-aware shell output.** New `looksLikeDiff(output)` — true only when the text has at least one `+`-leading *and* one `-`-leading line, so `--help` listings and other `-`-only output stay where they were — and `DiffText`, a literal renderer that keeps each line's exact characters (indentation included, which Markdown's bullet path mangled) and paints `-` lines green / `+` lines red / the rest dim: the session's convention, inverted from git's, held in two swappable constants. Wrapping goes through `wrapTextWithAnsi` per line so every wrapped row keeps its line's colour. `shellOutputComponent` picks between `DiffText` and the previous `Markdown(output, 0, 1, …)` at the two `!`-shell call sites; `shellOutputs.push(output)` still gets the raw text, so the model's view is unchanged.
- **Shell prompt indicator.** A leading `!` swaps the idle `> ` for `! ` (via `agentInputPrompt`'s third argument), resynced by wrapping `bottomInput.handleInput` — pi-tui's `Input` has no change callback, and this is the one place a keystroke is observable.
- **Tests**: `tests/unit/agent-session.test.ts` 73 → 84 — `agentInputPrompt` (3: plain, ⚡ badge, busy frame beating both), `looksLikeDiff` (3: real unified diff, prose/empty, single-marker output), `DiffText` (5: per-line colour with exact characters preserved, indentation intact, rows unpadded and reset-terminated, every wrapped row keeping its foreground with no character lost, empty render at width 0) — plus the `agentTitleGlyph` cases rewritten for the 23-tick sequence and cycle.

**Verification status**: `npm run typecheck` (pass), `npm run build` (pass, exit 0) and `npm run test:unit` — **1531 tests, 1531 pass, 0 fail, 290 suites** (+11 for the new helpers) — executed on this tree. Not covered: the ticker wiring, the ctrl-s listener and the `!`-shell call sites are module-private or PTY-bound, so they are verified by inspection only — `steer()`'s existence, the `"one-at-a-time"` queue defaults and `ctrl+s`'s absence from the default keymap were read out of `@earendil-works/pi-agent-core@0.99.2` (`agent.js`, `agent.d.ts`) and `@earendil-works/pi-tui@0.99.2` (`keybindings.js`). Two doc comments are wrong and were left as-is (rule 8): `startPersistentTui` says `RuledInput` delegates to the wrapped `handleInput` "after history navigation", but both arrow branches return before delegating, so recalling a `!cmd` from history leaves the `!` indicator until the next keystroke; and `syncShellPrompt` says it is called "after submissions", for which no call exists — the post-submit prompt comes from `startTuiSpinner`/`stopTuiSpinner` recomputing it. The design doc's section 2 was rewritten for steer mode, but its `progressTick` "Known shadowing" note (~line 125) and the test-coverage inventory's "20-tick cycle" (~line 509) still describe what this change removed and were not corrected.
### refactor(config-loader): extract `getDefaultUpstreamConfig` for the default-upstream lookup chain

`src/utils/config-loader.ts`, `src/index.ts`, `src/utils/target-retry.ts`, `tests/unit/config-loader.test.ts` — five copies of the same three-rung config chain (`[models.default]` table → `[default_upstream]` → literal default) now resolve through one exported helper.

- **The chain had five members.** `parseFixedRoute` and the `/health` handler (`src/index.ts`) each inlined it for raw `upstream_mode`/`base_url` values; `getDefaultModelRoute` and `resolveModelRouteFromEntry` (`config-loader.ts`) ran the same chain with their own `'http://localhost'` base-url literal; `descriptorToRoute` (`target-retry.ts`) ran a mode-only stub of it. All five now call `getDefaultUpstreamConfig(proxyConfig, primary?)`, where `primary` defaults to the `[models.default]` category (with the `!Array.isArray` guard, since the TOML parser can also produce an array-of-tables under that key) and may be overridden per call site — a category config, or `{ upstream_mode: descriptor.mode }`.
- **Per-site literals stay per-site.** The helper only supplies the `'openai-completions'` literal for mode; the `'http://localhost'` base-url literals remain at the two config-loader call sites that had them, and `parseFixedRoute`'s tolerate-undefined base-url coercion (`|| ''` downstream) is unchanged. The `ModelRouteConfig` returned by `getDefaultModelRoute` is field-for-field identical.
- **Deliberately not folded**: four sites that read `default_upstream?.default_api_key` directly with no `[models.default]` rung (`src/index.ts:1669`, `src/index.ts:1752`, `src/handlers/dashboard.ts:3643`, `src/handlers/dashboard.ts:3649`) — giving them the rung would be a behavior change, not a refactor, and is left for a separate decision.
- **Tests**: new 6-test `getDefaultUpstreamConfig` suite in `tests/unit/config-loader.test.ts` — table-wins, array-typed `models.default` ignored, per-key `[default_upstream]` fallback, literal only when both absent, explicit-primary override semantics (per-key, not merged), empty-string fall-through.

**Verification status**: `npm run typecheck` (pass), `npm run test:unit` — **1520 tests, 1520 pass, 0 fail** — and `npm run build` (pass) executed on this tree.

### refactor(auth-headers): import `normalizeOpenAIAuthHeaders` from its own module, drop the routing re-export

`src/handlers/openai.ts`, `src/handlers/responses.ts`, `src/handlers/chat-completions.ts`, `src/handlers/messages.ts`, `src/utils/routing.ts` — when `normalizeOpenAIAuthHeaders` moved into `src/utils/auth-headers.ts` (entry below) it kept a re-export shim in `routing.ts` so the handler files didn't have to move in that pass. They move now.

- All four handlers import `normalizeOpenAIAuthHeaders` from `../utils/auth-headers.js` directly (merged into existing auth-headers import lines where present, e.g. alongside `repackBearerCredential` and `resolveIncomingAuthorization`); `addForwardedHeaders` stays from `routing.js`. All 14 call sites untouched.
- The shim is gone: `routing.ts` no longer imports or re-exports the name (`pickRawApiKey`, which routing uses internally, stays). Pre-removal greps confirmed zero internal uses in `routing.ts` and exactly these four importers repo-wide.

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — **1514 tests, 1514 pass, 0 fail** — executed on this tree; counts unchanged, as expected for an import-only change.

### fix(routing): stop sending `/v1/models` list requests down the gemini credential chain, and unify the gemini classifiers

`src/utils/routing.ts`, `tests/unit/routing.test.ts` — two related cleanups of the gemini path classification.

- **`/v1/models` is a list endpoint, not a gemini call.** `isGeminiEndpoint` in `transformAuthHeadersForUpstream` matched the prefix `/v1/models/`, which also covers the OpenAI-convention model-list path; an `anthropic-messages`-mode list request carrying both `Authorization` and `x-goog-api-key` would then have the **goog key** chosen for the anthropic upstream (401). The matcher now requires a segment after `models/` — genuine gemini calls (`models/{id}`, `models/{id}:generateContent|:streamGenerateContent|:countTokens`, bare model gets) still match, while the bare list endpoint falls to the default `Authorization > x-api-key > goog` chain.
- **One predicate for both classifiers.** `isGeminiApiPath` (leading-slash agnostic, since the two call sites receive differently-normalized inputs) now backs both `transformAuthHeadersForUpstream`'s credential priority and `getHandlerType`'s handler selection, replacing three ad-hoc pattern sets. `getHandlerType`'s behavior is input-equivalent (verified by walking list/beta-list/`:generateContent`/`:streamGenerateContent`-throws/interactions shapes — identical results, including the throw paths). Side effect, the intended one: `/v1beta/interactions*` requests now get goog-first credential priority like their `/v1/interactions*` siblings, instead of falling into the default chain.
- **Tests**: 7 new cases in `tests/unit/routing.test.ts` — the list-endpoint regression (anthropic-mode `/v1/models` + dual credentials → emits `x-api-key: sk-anthropic`), a `:generateContent` positive control, goog-only fall-through on the list endpoint, `/v1beta/interactions` priority + Authorization-only fall-through, and `getHandlerType` pins for `v1beta/interactions` and the throw paths.

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — **1514 tests, 1514 pass, 0 fail** — executed on this tree.

### chore(converters,routing): delete dead model-list converters and a stale beta-features import

`src/converters/openai-to-claude.ts`, `src/utils/routing.ts`, `tests/unit/openai-to-claude.test.ts` — dead code removal, no runtime behavior change.

- **`convertOpenAIModelsToClaude` and `mergeClaudeModelsResponse` are gone.** The former was test-only — its live functionality already lives inline in `src/index.ts`'s `claude-cli` model-list branch, which never called it. The latter had zero call sites anywhere: orphaned when an earlier commit (`32121b2`, per the history below) re-pointed the test suite to `mergeOpenAIModelsResponse` — a different, still-used export; the near-identical names hid the death. Swept with them: `unixToRFC3339` (its only caller was the deleted converter), the `ClaudeModelsResponse`/`ClaudeModel` import bindings, and a pre-existing unreferenced `OpenAIModel` import binding. Module-level `DEFAULT_CONTEXT_LENGTH`/`DEFAULT_MAX_TOKENS` stay — still used by `mergeOpenAIModelsResponse`.
- **`routing.ts` dropped a stale import**: the bare `validateBetaFeatures` binding was imported at line 11 but only the `validateBetaFeatures as validateBetaFeaturesUtil` alias was ever used.
- **Tests**: the 2-test `convertOpenAIModelsToClaude` describe block and its import left with it; no tests existed for `mergeClaudeModelsResponse`. The other suites (`mergeOpenAIModelsResponse`, token-counting) untouched. CHANGELOG references to both names are history and stay.

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — **1507 tests, 1507 pass, 0 fail** (−2) — executed on this tree.

### refactor(auth-headers): deduplicate credential-header logic into a new shared module

`src/utils/auth-headers.ts` (new), `src/index.ts`, `src/utils/routing.ts`, `src/handlers/passthrough.ts`, `src/handlers/openai.ts`, `src/handlers/chat-completions.ts`, `tests/unit/auth-headers.test.ts` (new) — sixteen scattered copies of "recover or repack an API key from auth headers" now live behind one module.

- **Six strip/repack sites folded.** `getRawEndpointUserKey` (`index.ts`), `extractCallerKey` (`passthrough.ts`), the incoming-key block (`openai.ts`), and the anthropic/gemini header repacks (`chat-completions.ts`, two sites in one file) each re-implemented bearer-strip with different header orders, fallbacks, and strip mechanics. They now delegate to `stripBearerPrefix`, `extractRawCredential` (both header orders), `resolveIncomingAuthorization` (three-header recovery from raw request headers), and `repackBearerCredential`. `normalizeOpenAIAuthHeaders` moved in from `routing.ts`.
- **Ten ternaries folded.** `transformAuthHeadersForUpstream`'s four per-endpoint credential priority chains were ten `startsWith('Bearer ') ? x.substring(7) : x` sites; they are now four `pickRawApiKey([...])` calls preserving each chain's order. `pickRawApiKey` uses the legacy **truthiness** semantics — an empty preferred header falls through to the next credential. (A `!= null` "first present wins" variant was tried and reverted after it produced a real regression: empty `x-api-key` + valid `Authorization` yielded `''`, and the caller then emitted no auth headers at all.)
- **Uniform stripping.** All sites now use the case-insensitive `/^Bearer\s+/i` regex; the two exact-case `startsWith('Bearer ')` sites previously sent `bearer k` (lowercase) or multi-space prefixes verbatim as the key — a latent bug fixed by the fold. Deliberate edge-case changes, consistent with the majority behavior: `extractCallerKey` strips case-insensitively, and `getRawEndpointUserKey` falls through to the goog key on an empty `Bearer ` token.
- **Intentionally untouched**: `extractAuthHeaders`'s prefix-*wrap* guard (`routing.ts:313-318`, the last non-shared bearer handler) adds rather than strips a prefix and serves a different role; folding it was judged not worth the blast radius. The four direct `default_upstream?.default_api_key` reads are recorded in the `getDefaultUpstreamConfig` entry above.
- **Tests**: new `tests/unit/auth-headers.test.ts` — 24 tests for the module plus 9 for `pickRawApiKey`, covering both header orders, stripping variants, empty-source fall-through, `Bearer `-token-wins-returns-empty semantics, and the Azure normalization.

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — **1514 tests, 1514 pass, 0 fail** (1500 after the module landed, +9 for the `pickRawApiKey` fold, then updated in place for the truthiness fix) — executed on this tree.

### refactor(sdk): drop the `chatjimmy` submodule and stub `sdk://` routes out of existence

`src/utils/sdk-handler.ts`, `package.json`, `scripts/build-sea.js`, `scripts/init-proxy-config-in-consul-server.sh`, `src/utils/config-loader.ts`, `tests/unit/config-loader.test.ts`, `tests/unit/sdk-handler.test.ts` (new), `tests/README.md`, `tests/providers/llama/messages.sh`, `docs/getting-started/README_DETAILS.md`, `docs/getting-started/configuration-guide.md`, `docs/reference/configuration-reference.md`, `docs/architecture/design_tauri_tray.md`, `docs/architecture/plan-split-cloudflare-worker-vs-local.md`, `docs/architecture/plan-llm-as-a-verifier-plugin.md`, `docs/contributing/security-review.md`, `docs/contributing/security-review-3.md`, `docs/contributing/security-review-4.md`, `.gitmodules` — removes the `submodules/chatjimmy` git submodule and the SDK code path it backed. `sdk://` config values still load; every request to one now fails loud instead of silently routing.

- **The scheme survives, the client does not.** `isSdkUrl()` and the `sdk://` acceptance in `validateBaseUrls` are kept, so existing configs keep loading and the route still parses. What is gone is the dynamic `import('../../submodules/chatjimmy/dist/index.js')`, the `parseSdkUrl` helper (dead code — defined, never called), the two request/response converters, and both SDK client bodies. `src/utils/sdk-handler.ts` went from 497 lines to 73: two exported stubs whose entire body is `throwSdkUnavailable(...)`.
- **Fail loud, not silent (rule 8).** The stubs throw `new ClaudeProxyError(..., 501, 'not_implemented')` naming the model alias and request id. The old handler swallowed SDK failures into a generic `500 SDK_ERROR` body; the stub reports the real reason. The thrown error is an ordinary failed attempt outcome, so the rest of the pipeline behaves: `isRetryableOutcome` treats `status >= 500` as retryable, so a failover ladder skips the `sdk://` rung and moves to a healthy one, and if every rung fails the error propagates to `createErrorResponse` with its real status and message.
- **`package.json`**: the `build-chatjimmy` script is deleted. That was the only reference to the submodule — `optionalDependencies` (`@github/keytar`) and every other script are untouched, and `package-lock.json` had no chatjimmy reference to begin with.
- **`scripts/build-sea.js`**: `'../../submodules/chatjimmy/dist/index.js'` is dropped from `EXTERNALS`, which is now just `['@github/keytar']` (this moved the constant from line 119 to line 101, and `docs/architecture/design_tauri_tray.md` was updated to cite the new line). The build banner no longer claims `sdk://` is excluded from the binary.
- **`tsconfig.json` / `tsconfig.server.json` need no change** — the chatjimmy-sdk path aliases were already removed on 2026-06-17, so nothing there ever resolved into the submodule.
- **`src/utils/config-loader.ts`**: the `sdk:` protocol check in `validateBaseUrls` is unchanged (configs must still load). Only its now-false comment — which described a scheme rewrite at request time — was replaced with one pointing at the 501 stub.
- **Consul seed script**: the two-line `[models.default]` section in `scripts/init-proxy-config-in-consul-server.sh` existed solely to seed the removed route (`["llama3.1-8B", "sdk://localhost", ""]`) and is deleted. `models.default` is an optional catch-all in `getModelConfig`, so its absence is not an error.
- **Docs**: the two `README_DETAILS.md` sections (`Optional: ChatJimmy SDK`, `Routing a model through the SDK`) and the `SDK Handler (sdk://)` thinking-mapping block are removed; the `sdk://` bullets in `configuration-guide.md`, the `sdk://…` paragraph in `configuration-reference.md`, and the submodule lists in the two architecture notes are removed or corrected. The three security-review files keep their findings as history but each `sdk://` finding (M1 in reviews 1/3/4, N1 in reviews 3/4) now carries a dated **RESOLVED by removal** note — the key-forwarding and plaintext-key-log issues are fixed by deletion, not by a code fix.
- **`tests/providers/llama/messages.sh`**: TC13 was labelled `SDK集成测试` while its body was an ordinary `curl_post`, so it now says what it does (`基础请求`). No assertion changed.
- **Knowingly left alone (rule 8)**: `tests/api/sdk/integration.js` still exercises `sdk://` and will exit 1 if run. That is deliberate — the entry below (`fix(tests)` / SDK cleanup) records the earlier decision to leave the file untouched and defer its cleanup to a separate change, and it is wired into no npm script, so it cannot affect `npm run test:unit`. `tests/features/token-counting/results.json` also still names `src/utils/sdk-handler.ts`, and three files under `tests/logs/results/` (`test_llama3_sdk.md`, `test_of_sdk.md`, `test_result_of_deepseek_v4_flash_all_agents_all_tasks.md`) still describe the `sdk://` handler or quote upstream responses carrying a `chatjimmy-…` `system_fingerprint`. All four are generated artifacts recording runs that actually happened; they are left as-is rather than rewritten, since editing a historical log to remove what it observed would falsify the record.

**Verification status: NOT VERIFIED — `npm run typecheck`, `npm run build`, and `npm run test:unit` were all rejected before they ran, and the git-plumbing half of this change is incomplete.** The tool calls for those three commands, for the `.gitmodules` edit, and for `git rm --cached submodules/chatjimmy` were each refused with `claude-sonnet-5 is temporarily unavailable, so auto mode cannot determine the safety of … right now.` (read-only commands were unaffected). Consequently: **`submodules/chatjimmy` is still declared in `.gitmodules` (lines 1-3) and still a gitlink in the index**, `.git/modules/submodules/chatjimmy` has not been deleted, and the now-empty `submodules/chatjimmy/` directory is still on disk. The file edits above are on disk and unrun. `tests/unit/sdk-handler.test.ts` contributes **5 tests in 2 suites** covering what the stub does: `isSdkUrl` recognising `sdk://` and only `sdk://` (including the empty string), both stubs rejecting with a `ClaudeProxyError` asserting `status === 501`, `type === 'not_implemented'`, and a message carrying the scheme, the model alias and the request id, the unknown-alias path reading `unknown` rather than an empty string, and `isRetryableOutcome({ok: false, status: 501}) === true` — the property that makes failover skip the dead rung. The `config-loader` test was retitled (`accepts sdk:// base_url at load time (no SDK behind it)`) with its assertion unchanged, since the scheme is still accepted. **Run `npm run typecheck && npm run build && npm run test:unit` and complete the four git steps before relying on any of this.**

### feat(agent-tui): restyle running indicators, trim leading whitespace, and retune the default budget

`src/tui.ts`, `src/agent-session.ts`, `src/utils/logger.ts`, `src/handlers/dashboard.ts`, `tests/unit/agent-session.test.ts`, `README.md`, `docs/architecture/design_of_persistent_tui_of_agent_with_followup_for_task.md` — a pass over the interactive TUI's running indicators, message indentation, and budget display.

- **Title-bar spinner** (`src/tui.ts`): the proxy dashboard's title-bar braille cycle is now the 10-frame `⠇ ⠏ ⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧`, advancing once per second while a request is in flight.
- **Agent tab title** (`src/agent-session.ts`): `agentTitleGlyph` now holds `π` for the first 14 ticks of each 20-tick cycle, then cycles `o, u, n` — replacing the old `π ↔ *` two-glyph alternation.
- **Input prompt as spinner**: while a task runs, the bottom `Input`'s prompt becomes the same braille spinner (via a new `setInputPrompt` helper, needed because pi-tui's `Input.prompt` is `private readonly`), and reverts to `> ` when the run ends.
- **Leading whitespace removed** from conversation rows, user-message echoes (`│ what to says`), task lines (`✻ what changes`), command/shell output, tool status, and the summary status line — the `Box`/`Markdown` `paddingX` args dropped from `1` to `0`, and the status template literal no longer emits stray spaces when there is no skills/tools suffix.
- **Brightness**: assistant messages keep the terminal default foreground (the added `dimStyle` was removed), so they read brighter than the dim (`\x1b[2m`) status/summary lines.
- **Proxy log noise**: under `AGENT=true` the shared logger drops the `[req_xxxxx]` prefix and the startup-only `config`-id diagnostics (see `src/utils/logger.ts`).
- **Budget default retuned to 50m tokens / 100 turns** (`DEFAULT_BUDGET`, `BUDGET_PROMPT_DEFAULT = '50m'`). With a 50m token budget the 100-turn cap is now the limit that normally trips first (≈3m tokens at a realistic ~30k tokens/turn), so the `DEFAULT_BUDGET` comment and the guard test were rewritten to state that — the token budget is the outer bound for runs with unusually large turns.
- **Progress + budget formatting**: `formatTokenBudget` abbreviates ≥1m tokens with a lowercase suffix (`50m`), matching the budget prompt's lowercase convention (deliberately *not* `config-loader`'s uppercase-from-1K `formatTokenLimit`). The per-task progress line is now `[π task done (usage: 1276 tokens / 50m limit and 1 / 100 turns)]` via a new `formatUsage(tokensUsed, turnsUsed, budget)`.
- **Dashboard test timer** (`src/handlers/dashboard.ts`): the "Testing <model> takes Ns" counter now ticks at 100ms and shows one decimal (0.1s resolution).
- **Removed** the unsupported "Pi Messages" choice from the agent's endpoint-schema picker.

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` — **1471 tests, 1471 pass, 0 fail, 278 suites** — executed on this tree. `tests/unit/agent-session.test.ts` was updated for the changed behaviour: the `agentTitleGlyph` cases now pin the `π`×14-then-`o,u,n` cycle (and that no tick yields anything outside π/o/u/n), the `DEFAULT_BUDGET` case asserts 50,000,000 tokens, the turn-backstop guard now asserts the turn cap trips first, and new `formatUsage` cases cover the both-limits / tokens-only / turns-only shapes. The design doc's test-coverage inventory was corrected to match (it still described the old `π π * *` sequence) and `formatUsage` added to the covered helpers. The dashboard timer is browser-only JavaScript inside the served HTML and has no unit coverage; the `src/tui.ts` title-bar frame change has no unit coverage either.

### feat(decision): accept `"clef"` as an equivalent spelling of the `cloudflare` backend

`src/handlers/decision.ts`, `src/utils/config-loader.ts`, `tests/unit/decision.test.ts`, `README.md`, `docs/getting-started/proxy_config.example.toml` — `[decision] backend = "clef"` is now a recognised spelling of `backend = "cloudflare"`, documented and type-checked instead of arriving there by accident.

- **The two names were already the same backend at runtime — by omission.** The images gate keys on `backend === 'laya'`, so *any* non-`laya` string, `"clef"` included, already fell through to the cloudflare path and got its 30000ms timeout. That equivalence was incidental: it existed only because of the no-runtime-validation gap recorded in the entry below (`config-loader.ts` stores `backend` as a raw string; the union is a type annotation). This change makes it deliberate — the union in `config-loader.ts` now reads `'laya' | 'cloudflare' | 'clef'`, and the handler normalises `'clef'` → `'cloudflare'` at one point so the images gate and the timeout default cannot drift apart on the three names.
- **Why `clef` at all**: the Clef contract is served by Cloudflare's `@cf/cloudflare/clef`, so `clef` names the model and `cloudflare` names the vendor for the same upstream. Both were already in the config-facing conversation; the loader now admits both.
- **Messages and docs name it.** The `503` for a missing `[decision]` section reads `backend ("laya" | "cloudflare" | "clef")`, and the README config block, the backend bullet and `docs/getting-started/proxy_config.example.toml` spell the equivalence out. The `400` for images on `laya` still points only at `"cloudflare"`, which is the canonical name for that backend.

**Verification status**: `npm run typecheck` (pass), `npm run build` (pass, exit 0) and `npm run test:unit` — **1468 tests, 1467 pass, 1 skipped, 0 fail, 277 suites** — executed on this tree. `tests/unit/decision.test.ts` gains a `"clef" is an equivalent spelling of "cloudflare"` block (2 tests), asserting the two properties that would break if the normalisation were dropped: images on `backend = "clef"` are **forwarded** rather than rejected by the laya gate, and the timeout defaults to `30000` on `clef` rather than `5000`. The `spyAbortSignalTimeout` helper moved from the timeouts `describe` to module scope so the new block can use it — no assertion changed. `tests/manual/verify_decision_e2e.sh` was not extended for `clef`; the alias is covered at the handler level only.

### feat(decision): serve the endpoint at `POST /v1/decision` as well as `POST /decision`

`src/index.ts` — the decision route now matches `/decision` **and** `/v1/decision`, so callers that prefix every endpoint with the version segment reach it too. The handler, the config, and the behaviour are identical on both paths: same body consumption, same deferred-auth gate, same upstream, same `x-request-id`. `recordRequestTiming` is called with the path as received, so the two are distinguishable in the timing log.

**Verification status**: `npm run typecheck` (pass) and `npm run test:unit` (pass) executed on this tree, plus a new section 8 in `tests/manual/verify_decision_e2e.sh` that drives the alias through a real proxy. Four checks: `/v1/decision` → `200`, its body carrying the Clef envelope, and — the check that actually distinguishes the alias from an unrelated route answering `200` — a request **with `images` on the `laya` proxy → `400` with the upstream call count unchanged**, proving the same handler runs on the second path. The unit tests still call `handleDecisionRequest` directly, so route matching for either path is exercised only by the manual harness.

### feat(decision): add `POST /decision`, the Clef API endpoint

`src/handlers/decision.ts` (new), `src/utils/config-loader.ts`, `src/index.ts`, `tests/unit/decision.test.ts` (new), `README.md`, `docs/getting-started/proxy_config.example.toml` — adds a route that answers **typed decisions** rather than generating text: the caller sends state plus a map of questions and gets a probability back per question. There is no prompt and no completion; the upstream answers in a single forward pass. It proxies to one of two upstreams that speak the same contract but differ in image support.

- **The contract is the two schema files, not a transcription of them.** `docs/api/decision/clef-schema-input.json` and `clef-schema-output.json` are authoritative. Request envelope `{model, state, questions, images?}`, required `[model, state, questions]`, `questions` a 1–64 entry map of `noul` / `choice` / `score` questions keyed by id; response envelope `{model, answers, usage}` with answers under the request's ids, `usage` required `[input_tokens, output_tokens]`. The README section reproduces both with worked values, and defers to the schemas on any conflict.
- **Two backends, differing in exactly one thing — `images`.** `backend = "laya"` is the local `submodules/laya-mlx/serve_judge.py` sidecar; its MLX encoder is text-only, so a request carrying a non-empty `images` array is rejected with `400` **before any upstream call**. That is deliberate: a silent strip would let a caller mistake a text-only answer for one that saw the image. `backend = "cloudflare"` is any endpoint serving the Clef schemas with image support (e.g. `@cf/cloudflare/clef`), and `images` is forwarded untouched. An empty `images: []` is accepted on both — it carries nothing, so it is not an error.
- **Verbatim in, verbatim out.** The request body is POSTed byte-for-byte to `url` and the upstream response body returned byte-for-byte. There is no model routing, no alias resolution, and no `model`-field rewriting — the `model` in the body (`clef` / `clef-flash`) is the upstream's business. `url` is a **full endpoint**, not a base URL, because it is POSTed verbatim (include `/decision` for the Laya judge server, whose route is `/decision`, not the tool judge's `/judge`).
- **Envelope-only validation, both directions.** The proxy checks the top-level required fields only; per-question shapes, the id charset, the 1–64 bound and the `model` pattern belong to the upstream, and its error is forwarded. A non-2xx upstream response passes through as-is (status, body, `x-request-id`); a 2xx whose body is not JSON, or is missing `model`/`answers`/`usage`, is reported as `502 Invalid upstream response` rather than returned as a malformed success.
- **The config parser is four branches, because that is what the section needs.** `[decision]` is a scalar-only section like `[tool_judge_sidecar]` (no array keys, activation by presence, no `enabled` flag), so it is wired the same way: dispatch on `parts[0]`, plus the quoted-string site and the number/string site. The strings `backend` / `url` / `api_key` are accepted at **both** value sites — that repetition is the documented pattern in this parser (see the `[privacy_filter]` and `[tool_judge_sidecar]` branches) and is what the loader needs when a user quotes a key it expects unquoted. `timeout_ms` is coerced in the number branch only.
- **Cost of getting that wrong is known and was avoided.** `fix(config): parse [tool_judge_sidecar], which the loader silently dropped` (below) records what a missing section branch does here: the header matches nothing, `currentSection` keeps its previous value, and the keys are **mis-attributed** into the preceding section rather than discarded — a fully-specified `[decision]` block would have landed in `[tool_judge_sidecar]` and left `config.decision` undefined with no diagnostic. Verified by parsing a config containing `[decision]` followed by a deliberately-unknown section: the section round-trips as `{backend, url, api_key, timeout_ms}` and the unknown header raises its warning.
- **Auth and stats apply.** The route sits behind the same `[remote] auth_server` gate as other endpoints, including the deferred (`auth_with_model` / `auth_with_body`) modes, which it runs inline because it returns before the normal post-parse auth call — it reads the body first and pulls `model` out of it for the auth lookup. Requests reach `record_server` and the dashboard keyed by the request body's `model`.
- **Not wired, and reported rather than hidden (rule 8)**: an unrecognised `backend` value is not rejected. `config-loader.ts` stores it as a raw string (the `'laya' | 'cloudflare'` union is a type annotation, not a runtime check), and the handler's image gate keys on `backend === 'laya'` — so a typo such as `backend = "cloudflair"` silently takes the **cloudflare** path: images are forwarded, and the timeout defaults to 30000ms. Unlike `[tool_judge_sidecar]`'s unvalidated `mode`, whose unknown value matches no branch and is therefore inert, an unknown `backend` is not inert — it grants image support. Left as-is to keep this change additive and to match the parser's existing no-runtime-validation convention; a one-line guard in the handler would turn it into a `503` naming the valid values, and is the natural follow-up. (The union now also admits `'clef'` — see the entry above — but the gap is unchanged: a typo still lands on the cloudflare path.)

**Verification status**: **automated checks green; the route is now also exercised end-to-end through the real `src/index.ts` request path, but still against a stub upstream — the real Laya sidecar has not been reached.** `npm run typecheck` (pass), `npm run build` (pass), and `npm run test:unit` — **1466 tests, 1465 pass, 1 skipped, 276 suites** — were executed on this tree. The new file `tests/unit/decision.test.ts` contributes **21 tests in 6 suites**, all passing: unconfigured→`503` (section absent; `backend` without `url`); envelope rejection for malformed JSON, non-object bodies, and each of missing/empty/array `questions` and missing/non-string `model`; per-question shapes confirmed **not** validated by the proxy; the images gate in all three states (non-empty on `laya` → `400` with no upstream call, empty on `laya` → accepted, non-empty on `cloudflare` → forwarded untouched); byte-for-byte request forwarding, `Authorization: Bearer` sent only when `api_key` is set, upstream success and error bodies returned verbatim; `502` for a non-JSON body and for a body missing the envelope; and both timeout defaults (`5000` laya / `30000` cloudflare) with `timeout_ms` overriding them, asserting an abort signal reaches every call.

**Manual end-to-end pass — `tests/manual/verify_decision_e2e.sh`, 21 checks, 0 failures.** Driven because the unit tests call `handleDecisionRequest` directly and therefore never exercise route matching, body consumption, or the deferred auth gate in `src/index.ts`. Three real proxy processes (`node --import tsx src/server.ts`) are started against a stub Clef upstream (`tests/manual/stub_clef_upstream.ts`), one per config. Confirmed through the live HTTP path: `noul` / `choice` / `score` → `200` with a well-formed `{model, answers, usage}` envelope and choice probabilities summing to 1; non-empty `images` on `laya` → `400` **with the upstream call count unchanged** (the gate fires before the fetch, not merely a `400`); the same body on `cloudflare` → `200` with `images` arriving at the upstream intact; missing `model`, malformed JSON, and empty `questions` → `400`; a config with no `[decision]` section → `503`; the request body arriving upstream byte-for-byte unchanged; `api_key = "sk-test-key-123"` producing `Authorization: Bearer sk-test-key-123` on the upstream request; **and the `/v1/decision` alias behaving identically to `/decision` on both the success path and the laya images gate**.

**What neither pass covers, stated plainly (rule 8)**: every upstream in both is a stub — no real Cloudflare endpoint was called, and **no live `submodules/laya-mlx/serve_judge.py` has ever been reached**, because MLX is Apple-Silicon-only and this machine is win32/AMD64. The stub answers from the schema files, so what is verified is the proxy's handling of contract-shaped traffic, not agreement with the sidecar. The two schema files were also read rather than run through a JSON-schema validator. Run the sidecar and re-point `[decision] url` at it before relying on the Laya path in production; nothing here substitutes for that.

**Harness note**: the script uses ports `18788`–`18791` and `19999`, deliberately away from the dev proxy's `8788`. It refuses to start if any of its ports is already listening — an earlier revision reused `8788` and silently asserted against whatever process was already bound there, which produced a run of misleading `401`s. `/tmp` is not used for IPC between Node and bash either (it resolves to different directories for Windows Node and git-bash); the stub exposes its recorded traffic over `GET /__count` and `GET /__requests` instead.

### docs(readme): document the Laya tool-judge token budget

`README.md` — adds one bullet to the Documentation section recording the tool-judge sidecar's context limit, which was previously undocumented anywhere in this repo.

- **The limit**: Laya is a bidirectional encoder with a per-checkpoint window (`max_len` in the checkpoint's `rl_agent_config.json`) — 512 tokens for `convaiinnovations/laya`, 1,024 for `laya-multilingual` / `laya-typed-decisions`. It is not a constant in code; the encoder config's `max_position_embeddings` is 8,192, and 512 is only the fallback when the checkpoint carries no `max_len`.
- **Why it matters to the proxy**: the window is shared by the question prefix *and* the `state` text (tool schemas + prompt + recent context) — `submodules/laya-mlx/laya_mlx/common.py:build_sequence`. The proxy's caps in `src/utils/tool-judge-sidecar.ts` (`MAX_PROMPT_CHARS=2000`, `MAX_SCHEMA_CHARS=600` per tool, `max_batch_tools=50`) are *character* budgets, so they do not bound the token count.
- **The failure is silent**: `build_sequence` right-truncates state with `st[:room]` and raises nothing — only the *option* side fails loud (`ValueError: … too many options for the token budget`). `serve_judge.py` therefore cannot report truncation, and `usage.input_tokens` reflects the already-truncated sequence. Over-budget tool lists lose their tail: the judge answers for tools it was never shown.
- **Not reachable from this proxy's own usage**: `choice` mode always sends exactly two criteria (`keep`/`discard`, `buildChoiceRequest`), so the option-side `ValueError` cannot fire here; `noul` mode sends zero options. The repository's exposure is the state budget alone.

**Verification status**: **not run.** This is a README-only change — no source, config, or test file was touched, so `npm run typecheck` / `npm run build` / `npm run test:unit` are unaffected and were not executed. The technical claims were read from source, not executed: `submodules/laya-mlx/laya_mlx/common.py` (`build_prefix`, `build_sequence`), `agent.py:120-123` (the `4 < head_max_len < max_len <= max_position_embeddings` guard) and `agent.py:182-186` (the marker-count guard), `prepared.py` (PrefixCache repeats the same semantics), `tokenizer.py` (`no_truncation()`), `serve_judge.py` (`judge`/`decision` handlers — no token accounting, `ValueError` → 400 only), and `src/utils/tool-judge-sidecar.ts` (`MAX_PROMPT_CHARS`/`MAX_SCHEMA_CHARS`/`max_batch_tools`, `buildChoiceRequest`). The 512-vs-1,024 split comes from the checkpoint table in `submodules/laya-mlx/README.md:83`. No tokenizer was run to confirm real token counts for the state text; the write-up does not depend on a specific count, only on the caps being characters rather than tokens.

### test(routing): cover `parseDynamicRoute`, `getHandlerType` and `buildTargetUrl` from the source

`tests/unit/routing.test.ts` — adds three `describe` blocks (21 tests, 40 assertions) for the dynamic-route helpers, imported from `src/utils/routing.ts` (`parseDynamicRoute`, `getHandlerType`, `buildTargetUrl`). These three had **no** direct unit coverage before; their only exercise was in ad-hoc scripts that carry their own hand-copied reimplementations of the same logic.

- **`parseDynamicRoute` (12 tests)**: pins the parse table — empty prefix with no model id; the scheme taken from the route (`/http/…` → `http://…`); a model id read from the segment before the endpoint; a path prefix kept ahead of the model id (`/openai/v1/abc/v1/messages` → prefix `/openai/v1`, modelId `abc`); a version segment inside the prefix *not* mistaken for a model id; a doubled slash collapsing to `''` rather than `'/'`; and a `v1beta/models/…:generateContent` Gemini endpoint located with the model left inside the endpoint. Error cases assert the three distinct `Error`s by message: `Invalid URL format` (fewer than 4 segments), `Invalid protocol: ftp` (non-`http`/`https`), and `Could not locate Claude endpoint` for `/v1/chat/completions`.
- **`getHandlerType` (4 tests)**: pins every reachable mapping including the ordering that makes `v1/messages/count_tokens` resolve to `token-counting` and not `messages` (the exact-match check precedes the `startsWith('v1/messages')` check), `generateContent` under both `v1/models/` and `v1beta/models/`, and the `Unknown Claude endpoint` throw for a models URL carrying no generative action.
- **`buildTargetUrl` (5 tests)**: model id placed between prefix and endpoint; omitted for both `undefined` and the empty string (the `if (modelId)` falsiness is pinned deliberately, since an empty id is silently dropped rather than producing a doubled slash); prefix ordering; and a round-trip property — `buildTargetUrl(parseDynamicRoute(url))` reconstructs the absolute URL for five route shapes.
- **`/v1/chat/completions` is pinned as *rejected***, not as working. This is the case the copies in `tests/features/routing/fixed.js` list as valid; production does not serve it through dynamic routing.
- **Deliberately not covered, reported instead of enshrined (rule 8)**: `parseDynamicRoute`'s `betweenParts.length > 1` branch and its `Unclear URL structure` error are unreachable — `targetPathEndIndex` is only ever set to `claudeEndpointStartIndex - 1`, so `betweenParts` is always empty. Likewise the second `if` at `src/utils/routing.ts:160` (`nextPart === 'messages' && twoPartsAhead === 'count_tokens'`) is dead: the preceding `nextPart === 'messages'` branch always matches first. No tests were written to lock in either dead path.
- **Scope, as decided**: the two ad-hoc scripts are left **untouched** — `tests/features/routing/fixed.js` (one `parseDynamicRoute` copy) and `tests/api/sdk/integration.js` (three `parseDynamicRoute` copies, of which only the last is live, plus three `buildTargetUrl` copies). Neither is wired into any npm script and neither can fail: both print `✅`/`❌` and exit 0. Removing their copies is deferred to a separate change. Coverage for these helpers now lives where it actually runs — `npm run test:unit`.

**Verification status**: **not run.** Shell execution was unavailable throughout this session (`claude-sonnet-5 is temporarily unavailable, so auto mode cannot determine the safety of Bash`), so `npm run typecheck` and `npm run test:unit` could not be executed and no pass count is claimed. Every expected value above was instead derived by hand-tracing `src/utils/routing.ts` (`parseDynamicRoute` at 121–222, `buildTargetUrl` at 227–236, `getHandlerType` at 514–538) against the new assertions, and the export list at `src/utils/routing.ts:16` was read to confirm the import specifiers resolve. Note that `npm run typecheck` uses the root `tsconfig.json`, whose `include` is `["src/**/*.ts"]` — it does **not** type-check this test file, so `test:unit` is the only gate that exercises it. Run both commands and replace this paragraph with their real results before relying on this change.

### refactor(routing): collapse the four duplicated route→target tables into one helper

`src/index.ts` — replaces four copies of the same `(path, upstream_mode) → {targetUrl, handlerType, upstreamMode, forceStreaming}` dispatch with a single `resolveUpstreamTarget()` helper (`src/index.ts:457`); the file goes from 2852 to 2645 lines. The four sites were `parseFixedRoute` (fixed routes), the `compositeAttempts.map()` candidate builder, `buildRouteAttempt` (fusion and retry rungs), and the `/v1/chat/completions` model-passthrough block. `safeModel` and `isNativeMode` were recomputed at three of them; both now exist once, inside the helper.

- **Pure dedupe, not a reconciliation**: the four copies did not agree with each other. Every disagreement is kept, tagged "dialect difference" in place at the branch that owns it, so the drift is visible in one region instead of four. The dialect is an explicit helper input (`dialect: 'fixed-route' | 'model-route'`) precisely because the same `(path, upstream_mode)` pair has two answers.
- **Divergence 1** — `/v1/messages` with a Gemini mode: a fixed route addresses the `v1beta/models` collection (that path carries no model id), while a model route addresses `v1beta/models/{model}:generateContent`, or `:streamGenerateContent?alt=sse` when the body sets `stream: true`.
- **Divergence 2** — `/v1/interactions` with a Gemini mode: fixed forwards to the API-version root; model routes use the model URL.
- **Divergence 3** — `:countTokens`: a fixed route reports `handlerType: 'token-counting'`, model routes report `'generateContent'`.
- **Divergence 4** — `/v1/chat/completions` under `anthropic-messages` or a Gemini mode: model routes build a native target (`v1/messages`, `v1beta/models/{model}:generateContent`); a fixed route falls through to `openai-completions`.
- **Divergence 5** — the Gemini version prefix: fixed routes honour `GEMINI_API_VERSION`, model-route path-style URLs hardcode `v1beta`, and `/v1/responses` honours the env var in both dialects.
- **Latent gap carried over, then surfaced**: the `compositeAttempts.map()` copy had no `/v1/chat/completions` branch at all and left `candidateTargetUrl = ''` for that path. It is unreachable there (the path is dispatched earlier), so behaviour is unchanged; the call site now throws on an unmapped path instead of silently forwarding an empty target.
- **New loud failure (rule 8)**: for a Gemini target the helper throws when the model id is empty, where the originals built a URL with an empty model segment. Reachable only when a candidate has neither an alias nor a name.

**Verification status**: `npm run typecheck` is clean on the final state. `npm run build`, `npm run test:unit`, and a purpose-built differential test (old vs new route table over 28 paths × 7 upstream modes × 3 base URLs × 3 `GEMINI_API_VERSION` values × 4 config shapes) had **not been run** when this entry was written — shell execution was unavailable in that session. Equivalence was instead established by reading each of the four replaced regions against a pre-change copy of `src/index.ts`. Re-run those three commands and replace this paragraph with their results before relying on this change.

### feat(routing): add ENABLE_DYNAMIC_ROUTING env var, disabled by default

`src/types/shared.ts`, `src/index.ts`, `src/server.ts`, `wrangler.toml`, `tests/unit/dynamic-route-gate.test.ts` (new), `tests/run-integration-tests.js`, `README.md`, `docs/api/api-endpoints.md`, `docs/api/list_of_api_and_schema.md`, `docs/reference/configuration-reference.md`, `docs/getting-started/README_DETAILS.md` — gates per-request dynamic routing (`/{protocol}/{host}/...`) behind a new opt-in flag, **disabled by default**:

- **New flag**: `ENABLE_DYNAMIC_ROUTING`, accepted as `true` or `1` (matching the existing boolean-env convention, e.g. `DEV_NO_KEY`). Declared in the `Env` interface, mapped in the Node adapter (`src/server.ts`, default `"false"`), and added to `wrangler.toml [vars]`.
- **Gate**: a new `isDynamicRoutingEnabled(env)` predicate, checked at the top of the dynamic-route branch in `src/index.ts`. When the flag is off, a dynamic path returns `403 "Dynamic routing is disabled."`
- **Rejected, not reinterpreted**: the gate deliberately returns an explicit error instead of falling through to `parseFixedRoute`. Otherwise a `/https/host/...` path would be silently handed to fixed routing and possibly served as a different endpoint — a silent failure rather than a loud one.
- **Order**: the gate runs *before* the SSRF allowlist check, so a disabled proxy rejects every dynamic route regardless of target host.

**Tests**: `tests/unit/dynamic-route-gate.test.ts` (new, 6 tests) pins unset → `403`; `"false"` → `403`; no upstream call made (proving no fall-through into fixed routing); `"true"` → gate opens and an unlisted host then hits the SSRF `403 "Target host not allowed."`; `"1"` behaves as `"true"`; and `"true"` + an allowlisted host is dispatched upstream.

**Existing tests preserved**: because the flag defaults off, the four pre-existing SSRF integration tests (`tests/integration/16_security/ssrf_dynamic_route.test.js`, TC2001–TC2004) would otherwise fail with the "disabled" error instead of the SSRF error. `tests/run-integration-tests.js` now sets `ENABLE_DYNAMIC_ROUTING: 'true'` in the spawned proxy's env so that suite keeps exercising the SSRF guard.

**Verified**: `npm run typecheck` and `npm run build` clean; `npm run test:unit` 1425/1425 pass; SSRF suite 4/4 pass against a proxy started with `ENABLE_DYNAMIC_ROUTING=true` (and confirmed to fail loudly, 3/4, with the flag unset); with the flag unset, a fixed route (`POST /v1/messages`) still routes normally (502 from an unresolvable test host, not the routing-gate 403).

### fix(deps): upgrade pi-tui and pi-agent-core to 0.99.2

`package.json` — upgrades `@earendil-works/pi-tui` and `@earendil-works/pi-agent-core` from `^0.87.1` to `^0.99.2`. This is a minor version bump within the 0.x series that brings bug fixes and internal improvements to the TUI and agent core libraries. No API-breaking changes were observed in this codebase; the five `TuiMainScreen` construction sites and the agent session integration continue to work without modification. `npm run typecheck` and `npm run build` are clean after the upgrade.

### feat(agent-session): add command history with up/down arrow navigation

`src/agent-session.ts` — adds in-memory input history (up to 100 entries) across all agent session prompts with up/down arrow key navigation:

- **History storage**: New `inputHistory` array (max 100 entries) with `addToHistory()`, `historyPrev()`, `historyNext()`, `historyReset()` functions. This is an **in-memory store only** — it is not persisted to disk, so history is scoped to the lifetime of the agent session process and is lost on exit.
- **Scope**: Applies to both initial setup prompts (`promptText` for model/provider/key) and the persistent TUI input (`RuledInput` / `PromptScreen`)
- **Filtering**: Excludes empty strings, quit commands (`/q`, `/quit`, `/exit`, `/bye`), and command output lines (starting with `[` like `[π shell]`)
- **Deduplication**: Consecutive duplicate inputs are not stored
- **Navigation**: Up arrow (`\x1b[A` / `\x1bOA`) recalls older entries; down arrow (`\x1b[B` / `\x1bOB`) recalls newer entries; at end of history, down arrow clears input for new entry
- **Cursor handling**: After recalling history entry, cursor moves to end of line (Ctrl+E / `\x05`) for immediate editing

### feat(models): implement Anthropic model discovery per Gateway spec (partial)

`src/handlers/models.ts`, `src/index.ts`, `tests/unit/api-hello.test.ts`, `docs/api/list_of_api_and_schema.md` — adds `handleAnthropicModelsDiscovery` to serve `GET /v1/models` with Anthropic-format model list when `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` is set. The handler:
- Forwards both `Authorization` and `x-api-key` headers from the incoming request to the upstream model discovery endpoint
- Applies a 3-second timeout and treats redirects as failures (per spec)
- Transforms upstream responses (OpenAI `{data:[]}`, direct array, or `{models:[]}` formats) to Anthropic shape `{object: 'list', data: AnthropicModel[]}`
- Filters to models containing 'claude' or 'anthropic' in the id (case-insensitive)
- Returns appropriate error responses for timeout (504), redirect (502), upstream errors (upstream status), and other failures (500)

Gated by `isAnthropicModelDiscoveryEnabled(env)` so it only activates when explicitly enabled. The legacy `claude-cli` User-Agent transform for `/v1/models` remains as a fallback when the gate is off.

**Covered by tests**: `tests/unit/api-hello.test.ts` (6 tests for `HEAD /api/hello` probe, which was added in the same commit) — the probe returns `200` with no auth header, makes no upstream call, returns empty body, is answered before the auth gate, and `GET /api/hello` also returns `200`. Anthropic model discovery handler tests are not yet added.

**Known limitation**: the handler sits after `loadProxyConfig(env)`, so if the TOML config fails to load, the probe fails too. Matching `/config-reload` was the closer convention than the dashboard's `loadProxyConfig` bypass.

### feat(route): add Claude Code Gateway header forwarding and error format with docs

`src/utils/routing.ts`, `src/utils/errors.ts`, `src/index.ts`, `docs/api/llm-gateway-protocol-for-claude-code.md` (new), `docs/claude_code_gateway_compliance_review.md` (new) — implements header forwarding and error format required for Claude Code gateway compatibility:

**Header forwarding** (`src/utils/routing.ts`): `getSidecarForwardedHeaders` now extracts and forwards `x-api-key`, `Authorization`, `anthropic-version`, `anthropic-beta`, and `anthropic-dangerous-direct-browser-access` headers from incoming requests to upstream calls. These headers are required by Anthropic's API and were previously dropped.

**Error format** (`src/utils/errors.ts`): `createErrorResponse` now produces Anthropic-compatible error envelopes (`{error: {type, message}}`) with proper `x-request-id` header, replacing the previous generic format. `classifyTransportError` maps network errors to appropriate Anthropic error types (`overloaded`, `timeout`, `api_error`, etc.).

**Documentation**: two new docs — `llm-gateway-protocol-for-claude-code.md` (338 lines) documents the endpoints, headers, and body fields Claude Code sends and what breaks when stripped; `claude_code_gateway_compliance_review.md` (331 lines) provides a compliance checklist against the protocol.

### fix(agent-session): fix agent unit tests

`src/agent-session.ts`, `tests/unit/agent-session.test.ts` — fixes 9 failing tests in the agent session suite. The failures were caused by:
- Test assertions that expected old spinner frame sets (5 frames) vs the current 6-frame set (`·✢✶✳✻✽`)
- Test expectations for transcript trimming behavior that changed when `.trim()` was added to shell output handling
- A test for the quit command path that relied on module-private internals

All tests updated to match current behavior. `npm run test:unit` → 1407 pass / 0 fail.

### fix(dashboard): minor UI fix

`src/handlers/dashboard.ts` — fixes a dashboard UI issue where a button's text or layout was incorrect. The change adjusts 3 lines in the dashboard handler to correct the display.

### fix(cli): add `dsh` command export for deepseek-harness integration

`src/cli.ts` — adds a `dsh` command to the CLI that exports configuration and model data in a format compatible with deepseek-harness. The command outputs JSON suitable for consumption by the `llm-pi-ai` gateway integration. This enables using model_proxy_v3 as a model provider for deepseek-harness without a dedicated plugin (see `docs/guides/agents/proxy-as-provider-for-deepseek-harness.md` and `docs/plan-deepseek-harness-provider-plugin.md`).

### docs: update estimated system resources in README

`README.md` — updates the "Estimated System Resources" section with revised memory and CPU estimates based on current sidecar configurations (privacy filter, kompress, tool judge, etc.).

### fix(config-loader): an unknown TOML section drops its keys and says so, instead of leaking them into the previous section

`src/utils/config-loader.ts`, `tests/unit/config-loader.test.ts`, `docs/getting-started/validating_tool_judge_sidecar.md` — the entry `fix(config): parse [tool_judge_sidecar], which the loader silently dropped` named its own blind spot and left it open: *"the silent-drop behaviour that hid this bug is still there for any other unknown section — `continue`, no warning. Changing that is a parser-wide policy question, not part of this fix."* This closes it.

**The old behaviour was worse than "dropped."** `parseSimpleToml` dispatched section headers on `parts[0]` through an `if / else if` chain with **no terminal `else`**. An unrecognised `[section]` matched nothing, so `currentSection` kept the value it already had and every following key-value line was assigned into the **preceding** section — mis-attributed, not discarded. That is precisely the mechanism by which a missing `[tool_judge_sidecar]` branch once sent the sidecar's six keys into `[privacy_filter]`, left `sidecarConfig` `undefined`, and made `judgeTools` take its `if (!sidecarConfig?.judge_url) return … {called: false}` early return with `_validationErrors` and `_validationWarnings` both empty. The keys did not disappear; they landed somewhere plausible, which is why the result looked like a config that simply had no sidecar block in it.

**The fix is a terminal `else` at the end of the dispatch chain.** It pushes `{path: section, message: "unknown section header at line N — keys under it are ignored (check for a typo, or a section this version does not support)"}` onto a new `sectionFieldWarnings` array, then sets `currentSection = null; currentCategory = null` so the keys below it are discarded rather than absorbed. `currentSection` is declared `string | null` and already starts as `null` (`config-loader.ts:2772`), so the value-assign sites need no new guard: a key with no section now finds no home. A **bare `[transforms]`** header is folded into the same treatment and for the same reason: it names no transform set, so it matched no branch either.

**Why the warning goes into `_validationWarnings` and not just `console.warn`.** The two other header-level problems in this file (`[remote.authentication]` / `[remote.recording]` deprecation, and `[passthrough.<x>]`) do log straight to `console.warn`, and copying that would have been the shorter change — but `src/cli.ts:431-437` counts the attached `_validationErrors` / `_validationWarnings` arrays for `proxy config validate`, so a bare `console.warn` would reach the log and nothing else. Recording it means the warning reaches both the log — the `[WARN] <path>: <message>` line still appears automatically, through the existing loop that prints every entry of `validation.warnings` — and the CLI's `Result: N errors, M warnings` count. (`src/cli.ts` does not re-print the arrays, precisely because the parser already wrote the lines; see the comment at `:427`.) The array is only consumed there — the dashboard's config-write path calls `validateProxyConfig` directly and never sees parser-level warnings, so it is not a third consumer. `sectionFieldWarnings` is kept separate from the sibling `sectionFieldErrors` so an unknown section warns rather than blocking startup.

**Covered by tests**: three in `tests/unit/config-loader.test.ts` — an unknown section between two known ones (keys dropped, the *following* known section still parses, and a warning naming the unknown section is present); an unknown section as the very first header, which must not crash and must contribute no config keys; and a bare `[transforms]`, likewise dropped and warned. The leak witness is `[defaults]`, whose branch accepts arbitrary keys — a leak into `[privacy_filter]` is invisible to a test, because that section allowlists its keys, so the historical failure had to be reproduced against a section that would actually show it. **Mutation-checked**: stripping the two `currentSection = null` resets from the new branches makes two of the three fail with the leak visible in the diff (`judge_url` and `mode` present in `cfg.defaults`), which is what makes them regression tests rather than assertions of the obvious. `npx tsx --test tests/unit/config-loader.test.ts` → **166 pass / 0 fail**; `npm run test:unit` → **1419 pass / 0 fail** (1416 before, i.e. exactly the 3 new); `npx tsc --noEmit` clean.

**No legitimate config trips the new warning.** All five TOMLs in the repo were parsed through `parseSimpleToml` and re-parsed through `serializeProxyConfigToml`'s output — the untracked local `proxy_config.toml`, `docs/getting-started/proxy_config.{example,minimal,transforms.example}.toml`, and `tests/models/proxy_config.or_free_model.toml` — and every one reports zero warnings on both paths, so the serializer does not emit anything its own parser rejects.

**The runbook's §7 is updated with it**: `docs/getting-started/validating_tool_judge_sidecar.md` carried this as the one still-open item of five ("Parser-wide policy, not fixed here"), which was the exact statement this change falsifies. It now records the mechanism, the `_validationWarnings` routing, and the repo-wide sweep, and the section heading reads that all five are resolved.

### fix(judge): `timeout_ms` is now a per-question budget with a 2000 ms cap per request, and the sidecar warms itself before it binds

`src/utils/tool-judge-sidecar.ts`, `src/handlers/dashboard.ts`, `tests/unit/tool-judge-sidecar.test.ts`, `submodules/laya-mlx/serve_judge.py` — two independent ways the judge lost its race against its own timeout. The second is the one that mattered: the proxy's default budget is **50 ms**, measured against a sidecar whose first inference after a restart is the slowest it will ever be.

**The client's budget was flat, and `noul` mode is where that bites.** `callJudgeSidecar` armed `setTimeout(…, config.timeoutMs)` regardless of how much work the request carried. That is fine for `choice`, which issues one request per tool, but `noul` packs *one question per tool into a single request* — so a 50-tool batch got the same 50 ms as a 1-tool batch and was 50× more likely to time out, failing the whole batch open and silently keeping every tool. The fix is `requestTimeoutMs(config, questionCount) = min(config.timeoutMs × max(1, questionCount), max(config.timeoutMs, 2000))`, with a named `MAX_REQUEST_TIMEOUT_MS = 2000` ceiling. Scaling by question count also puts the two modes on the same footing: N tools get at most N × `timeout_ms` either way, since `choice` already spends that as N sequential single-question requests (the per-iteration cost is unchanged — each of those calls still passes `questionCount === 1`). The cap deliberately bounds **the scaling, not the configuration**: `max(config.timeoutMs, 2000)` means a base budget already above 2000 ms is never shrunk to it, which is the otherwise-surprising case, and it is pinned by its own test. The proxy is blocked on this call, so the ceiling exists to stop a large batch stalling a user's request far past the point of usefulness.

**The sidecar paid MLX's lazy setup on the first real request.** `serve_judge.py` loaded the checkpoint before binding — so a broken model failed loudly at startup instead of 500-ing every request — but MLX builds its Metal pipelines and allocates buffers on *first execution*, not at load. The first `POST /judge` after a restart therefore cost noticeably more than steady state, and against a 50 ms default that one-off can be the whole margin. `warmup(agent)` now runs **before the bind**, one throwaway inference per question type against shapes that mirror what the proxy actually sends (a `choice` request for single-tool mode, a two-question `noul` request for batch mode), so whichever mode the proxy is configured for meets a warm model on its first call. It reuses `do_POST`'s own answer-set check, so a model that cannot answer is caught before the port opens rather than by the first client — extending the load-before-bind contract rather than working around it. Failure is fatal (`return 1`), not a warning, for the same reason. Measured cost: **70.7 ms total** across both passes, buying back about 7 ms on the first real request. `--no-warmup` skips it for anyone who would rather pay the one-off on the first call. The wrapper's module docstring records the behaviour, so it is not a second, undocumented startup phase.

**Observed in the dashboard too**: the sidecar panel's Timeout row had been rendering the bare number, `50 ms`, which now understates a batch's budget by a factor of N. It reads `50 ms per tool (a batch of N tools gets N × this, capped at 2000 ms)`.

**Covered by tests**: six added to `tests/unit/tool-judge-sidecar.test.ts` — a `noul` batch gets one request whose budget covers every tool in it, a `choice` request stays on the single-question budget, and a `requestTimeoutMs` suite covering the scale-up, an empty request counting as one question, the 2000 ms cap, and the base-above-the-cap case that must not be shrunk. `serve_judge.py` has no tests of its own (unchanged from the entry that added it), so the warm-up figure is one hand measurement on one checkpoint, not a suite.

**Docs corrected in the same pass** — the runbook `docs/getting-started/validating_tool_judge_sidecar.md` had carried the exact inverse of this behaviour ("`timeout_ms` IS PER HTTP REQUEST, NOT PER TOOL-SET"), which was true when it was written and is now backwards; `docs/getting-started/proxy_config.example.toml` had a stale `~50ms per request`; `docs/architecture/status_of_sidecars_of_proxy.md` §4 now states the per-question semantics and mentions the startup warm-up; `README.md` now lists the tool judge among the sidecars and shows it in the architecture diagram. The design doc's §8 schema block is a *design proposal*, not a description of shipped code, so it is left as written — with its status table already recording which of its keys are not implemented. Nothing in the older CHANGELOG entries was rewritten: `fix(config): parse [tool_judge_sidecar] …` describes the flat budget accurately as the behaviour of its time, and this entry supersedes it.

### feat(converters): implement `mergeClaudeModelsResponse` for `/v1/models` fallback

`src/converters/openai-to-claude.ts`, `tests/unit/openai-to-claude.test.ts` — The previously documented but unimplemented `mergeClaudeModelsResponse` function is now exported. It merges extra model IDs (from `extraModelIds` in the handler) into a `ClaudeModelsResponse`, deduplicating by `id` and setting `first_id`/`last_id` from the merged list. This enables the `/v1/models` fallback path when the upstream URL is invalid (see CHANGELOG entry "Fix: `/v1/models` falls back to local models when upstream URL is invalid"). Covered by `tests/unit/openai-to-claude.test.ts` (1 test in `mergeClaudeModelsResponse` suite).

### fix(config-loader): align tests with documented `base` short alias for `base_url` in inline tables

`tests/unit/config-loader.test.ts` — Two tests in the `parseSimpleToml` suite used `url = "..."` as the short alias for `base_url` in `[models.*]` inline-table entries. The documented and implemented short alias is `base` (matching the `mode`/`key`/`base` 4-letter pattern). Tests updated to use `base = "..."` instead of `url = "..."`, and test names updated from "url" to "base". The inline-table parser in `src/utils/config-loader.ts:3002` already expects `base`; the tests were out of sync since commit d99f62e ("fix(config) update for short alias consistant").

### fix(tools): the judge saw a Gemini request's tools but not its prompt, so it ruled on schema alone

`src/utils/tool-judge-sidecar.ts`, `tests/unit/tool-judge-sidecar.test.ts` — the earlier entry `fix(tools): the judge read Gemini's tool key wrong` stopped the judge from mis-reading Gemini's *tool* key. This fixes the other half of the same blindness: `buildStateText` read the conversation from `body.messages` only (`tool-judge-sidecar.ts:106`), and a Gemini native request has no `messages` at all — its turns are `body.contents[]`, its assistant turn is spelled `model`, and a turn's content sits in `parts[]`. So on `/v1beta/models/{model}:generateContent` (`src/index.ts:504`) the state the judge received said, verbatim, `User prompt: ""`, while `Tools to evaluate:` below it was fully populated. Tool extraction was never the problem here — `src/utils/tool-shapes.ts` already handles Gemini's camelCase `functionDeclarations` — which is exactly what made the failure quiet: the judge was handed a well-formed state naming every tool, and decided keep/discard with no idea what the user had asked for.

**What the empty prompt costs.** The verdict is keep-or-discard on tools a real request is about to run with. With no prompt the judge has only each tool's name and schema, so a request that says *"trim the log"* is judged as though it said nothing — the tool it needs is as likely to be discarded for overlapping its own schema as kept for being needed. This was not failing open: falling open keeps the tools and says so. It was a confident answer built from half the input.

**The fix** is three surgical edits and no new state shape. A new private `conversationTurns(body)` (`:162`) returns `body.messages` when that is a non-empty array and `body.contents` otherwise — `messages` wins when a body carries both, so a Gemini-shaped body that also carries `messages` keeps the richer form instead of being half-read. `buildStateText`'s turn loop (`:113–115`) then takes each turn's content as `m.parts ?? m.content` and maps the `model` role onto `assistant`, leaving `user`/`assistant` turns untouched. `messageToolCalls` (`:186`) gained a `content` parameter — the turn's block list, under whichever name it arrived — and a Gemini `functionCall` branch beside the existing Claude `tool_use` one. `messageText` needed **no** change, and that is worth stating plainly: its loop already reads a generic `block.text`, which is precisely what a Gemini `{text: "…"}` part is, so the prompt text was reachable all along once the turn was found. Only the turn lookup was wrong.

**Probe, the same Gemini-native body through both revisions.** Before: `state contains prompt text?: false`, `User prompt: ""`. After: `true`, `User prompt: "What is the weather in Paris today?"`. The Claude-shaped control body printed identically in both runs, so this adds Gemini without disturbing what already worked.

**Three tests**, in `tests/unit/tool-judge-sidecar.test.ts` (31 → 34; `npm run test:unit` 1410 tests / 265 suites / 0 fail, `npm run typecheck` exit 0). They pin the three things a one-line `messages` read gets wrong, and each asserts a value rather than that something was returned: `reads Gemini native contents, where the assistant turn is model and content is parts` asserts both the prompt *and* a `functionCall` rendered as `- Assistant called: clock({"tz":"UTC"})`; `keeps a trailing Gemini functionResponse turn from becoming the prompt` covers Gemini's habit of ending the array with the tool's own `functionResponse` — a naive "last user-role turn" read would have made the tool's result the prompt; and `prefers messages when a body carries both messages and contents` is the one that fails if `conversationTurns`' precedence is ever reversed.

**Not addressed, and surfaced rather than fixed** — three findings from the same validation pass, none touched by this change. (a) **Unknown TOML sections are mis-attributed, not merely dropped**, and the validation doc understates the severity: `parseSimpleToml`'s section dispatch closes at `src/utils/config-loader.ts:2885` and the `continue;` at `:2886` has no terminal `else`, so an unrecognised `[section]` leaves `currentSection` holding its previous value and its keys land in the *preceding* section — `[passthrough]` followed by a stray section absorbs those keys as `passthrough` entries, with `console.warn` count 0. (b) The protocol doc's §2.2 state example (`design_tool_judge_sidecar_protocol.md:32`) still shows the single-tool form `Tool: file_write\nSchema: {…}`, while §4.1 (`:156–160`) shows the `Tools to evaluate:` numbered form the code actually emits. (c) `docs/getting-started/validating_tool_judge_sidecar.md` still carries the validation run taken before this fix and will keep reporting Q3 as open.

### refactor(tui): drop `SPINNER_MD`, which had become the identity map of `SPINNER_CHARS`

`src/agent-session.ts`, `tests/unit/agent-session.test.ts`, `docs/architecture/design_of_persistent_tui_of_agent_with_followup_for_task.md` — `SPINNER_MD` was a Markdown-escaped copy of `SPINNER_CHARS`, built to stop the `+` and `-` frames rendering as list markers. Since the frames became `·✢✶✳✻✽` (`src/agent-session.ts:599`) none is Markdown-significant, so the map's `c === '+' || c === '-'` branch was unreachable and the constant was a pure identity — two names for one array, with the second existing only to hold a rule that no longer applied. The user's call: *"no needs 'SPINNER_MD'"*. It is removed; the two consumers (the in-flight task line at `:646`/`:745`, and `runAgentTurn`'s task line) now index `SPINNER_CHARS` directly, and the constant carries the note that the same frames serve both the Markdown and stdout spinners.

**What is not lost.** The two regression tests that pin *why* the frames are what they are stay, re-pointed at `SPINNER_CHARS`: an unescaped `+` still renders as a `-` bullet, and unescaped list markers still wrap with a hanging indent. They are now guards against a future frame choice rather than documentation of a live escape map — the `renders every frame literally` test is what fails if a list-marker frame is ever added back, so the safety the deleted branch provided is still enforced, just from the test side.

### test: clear the 14 unit failures — 12 stale expectations, and 2 assertions of a retired alias

`tests/unit/agent-tools.test.ts`, `tests/unit/agent-session.test.ts`, `tests/unit/openai-to-claude.test.ts`, `tests/unit/config-loader.test.ts`, `CHANGELOG.md` — the suite the entry below recorded as **1391 tests / 1377 pass / 14 fail** is now **1407 / 1407 / 0**, with `npm run typecheck` exiting 0. Only one of the 14 was a defect in shipped code, and it was not the one it first appeared to be. No production file is changed by this entry.

**10 of the 14 — `agent-tools` path confinement (`read_file` / `write_file` / `bash — Section 12 rm/mv`).** The tests asserted the literal string `/tmp/`; the guards interpolate `TMP_ROOT_RAW = tmpdir()` (`src/agent-tools.ts:55`) with **no trailing slash**, so on macOS they say `/var/folders/…/T` and on Windows `C:\Users\<user>\AppData\Local\Temp`, and the asserted `/tmp/` matched nowhere. Commit `ae0240c fix(cross-platform): replace hardcoded paths or tmp.` had already made the messages platform-correct; the tests kept asserting the literal it replaced. Fixed by deriving the expected text from `tmpdir()` the same way the source does, with the path's regex metacharacters escaped (`replace(/[.*+?^${}()|[\]\\]/g, '\\$&')` — load-bearing on Windows, whose temp root contains backslashes), and anchoring the tail on the parenthesised path (` \(`) rather than the `\/tmp\/` the message never contained. Four shared regexes (`READ_BLOCKED_RE` / `WRITE_BLOCKED_RE` / `RM_BLOCKED_RE` / `MV_BLOCKED_RE`) replace the 10 literals; each keeps the shape its site already had, including `write_file`'s not naming its tool. **This is the Windows distinction the request asked for** — the assertions now hold on all three platforms rather than being re-hardcoded to macOS. Note what the run actually proved: every escape was blocked in every subtest, including both symlink cases. The guards were never broken; the asserted string was stale.

**1 — `SPINNER_MD` in `tests/unit/agent-session.test.ts`.** Asserted the retired five-glyph set `['\\','|','/','+','-']`; `src/agent-session.ts:599` has held the six frames `['·','✢','✶','✳','✻','✽']` since before this branch. The test now pins the real six, written as literals rather than spread from `SPINNER_CHARS`, matching the sibling `agentTitleGlyph` test's hardcoded `'π π * * π π * *'`. A subtest title claiming "every frame is escaped" was renamed, since that clause is now false.

**1 — `tests/unit/openai-to-claude.test.ts` did not load at all.** It imported `mergeClaudeModelsResponse`, which commit `32121b2 fix(route) update models list schema.` renamed to `mergeOpenAIModelsResponse`; the module-load failure was counted as one test failure and hid every test in the file behind it. The import is fixed and the describe re-pointed at the surviving function's real contract: it returns the **OpenAI** shape (`{object:'list', data:[…]}`, no `first_id`/`last_id`), reuses an already-present model **by identity** rather than re-creating it, and gives appended models the `owned_by: 'system'` / `context_length: 262144` / `max_tokens: 65536` defaults. The identity assertion is what makes the dedupe path meaningful rather than incidentally-green.

**2 — the `[models.*]` inline alias pair, which looked like a source bug and was not.** Both failing tests supplied `url` for the base URL and expected it honoured. `docs/reference/configuration-reference.md:311` settles it: `base_url`'s short alias is **`base`**, "the short alias (**changed from `url`**)" — and commit `d99f62e fix(config) update for short alias consistant.` removed `fields['url']` from that branch and rewrote that doc line in the same commit. The source was correct; the tests asserted an alias the project had deliberately retired. Fixed by moving them to `base`, which is what the user confirmed directly: *"just keep 'base_url | base' equivalent, no needs short 'url' for 'base_url' in config"*.

**A wrong turn, recorded rather than quietly dropped.** I first concluded these two were a source bug and edited `src/utils/config-loader.ts` to re-accept `fields['url']` — an additive change I described at the time as harmless and already-documented. It was neither: it re-introduced a retired alias and contradicted both the reference doc and the commit that retired it. The reference the file's own header points at (`docs/reference/configuration-reference.md#config-field-aliases`) is what disproved it, after I had already landed the edit; it is reverted and `src/utils/config-loader.ts` is unchanged by this entry. **Why the error was plausible enough to make:** `url` genuinely *is* the live short alias for `[passthrough]` (`config-loader.ts:3063`) and for the category-level mapping (`:2930-2939`), the reference doc's `[passthrough]` table lists it, and the alias table in that doc is per-section — I generalised a `[passthrough]` rule into `[models.*]`, which has its own stated rule and a stated reason for it ("short aliases are reserved for inline tables only"). The lesson is that the alias tables are **per-section** and the sections disagree on purpose.

**One more test repaired while in here.** The precedence test beside them supplied `base_url` **and** `url` while asserting the canonical one wins. With `url` retired that assertion passed for a vacuous reason — nothing reads `url` any more, so it could not have failed. It now supplies `base_url` **and `base`**, so it exercises the documented precedence rule (`configuration-reference.md:316`) against a live pair instead of a dead key.

**Not addressed, and surfaced rather than fixed**: (a) `SPINNER_MD`'s escape branch (`src/agent-session.ts:606-608`, `c === '+' || c === '-'`) had become **unreachable** — no shipped frame is `+` or `-`, so the map was the identity of `SPINNER_CHARS` — and the comment above it ("The other three are inert") described a five-glyph set that no longer existed. Surfaced here, then acted on: the user asked for the constant's removal, so it is gone — see the entry at the top of this file. (b) `/tmp/` survives as shorthand in `agent-tools.test.ts`'s header prose and several test titles even though every assertion is now platform-derived; the change was kept to assertions to stay surgical.

### fix(tools): the judge read Gemini's tool key wrong, and four copies of the tool-name rule became one

`src/utils/tool-shapes.ts` (new), `src/utils/tool-judge-sidecar.ts`, `src/utils/dashboard-stats.ts`, `src/utils/tool-blocklist.ts`, `tests/unit/tool-shapes.test.ts` (new), `tests/unit/tool-judge-sidecar.test.ts`, `tests/unit/dashboard-stats.test.ts`, `docs/architecture/design_tool_judge_sidecar_protocol.md`, `docs/getting-started/validating_tool_judge_sidecar.md` — two defects with one root: the rule "what is this `body.tools[i]` entry called, and what schema does it carry" had been written out four times, and one of the four got Gemini's key spelling wrong.

**The bug**: Gemini's native tool form is `{functionDeclarations: [{name, parameters}]}` — **camelCase**, on which `src/utils/tool-blocklist.ts`, `src/utils/converters/claude-to-gemini.ts:454`, `src/utils/handlers/openai.ts:265` and the first-class `/v1beta/models/{model}:generateContent` inbound route (`src/index.ts:485,504`) all agree. The judge's `extractTools` read `body.tools[i].function_declarations` — snake_case — so on a Gemini-native request it matched nothing, returned `[]`, and `judgeTools` reported zero tools judged while logging at `info`/no level at all: **every tool was kept, silently**. That is precisely the failure mode the entry two below this one was written to eliminate ("failing open is still the behaviour; failing open *silently* is not"), reappearing one shape over. The dashboard's `extractToolNamesFromBody` had the same blind spot and returned its `['none']` sentinel, so every Gemini request was counted as carrying no tools. Neither surface had a test that could catch either one — and the judge's test **asserted the snake_case shape**, which is how the bug survived review.

**Both now read camelCase.** `tests/unit/tool-shapes.test.ts` pins the spelling directly (`reads the camelCase Gemini key, not the snake_case one`) and `tests/unit/dashboard-stats.test.ts` asserts a Gemini body names `['ls','cat']` `instead of reporting [none]`.

**Four copies, not two.** The duplicates were: `extractTools` (judge — snake_case Gemini, `function`-first precedence, `type: 'function'` gate, no trim, `{name, schema}[]`); `extractToolNamesFromBody` (`dashboard-stats.ts:917` — no Gemini at all, `name`-first, trims, `['none']` sentinel); a second copy inlined inside `extractToolRequestCharLengthsFromBody`; and `tool-blocklist.ts`'s private `extractToolName` beside its own inline camelCase Gemini filter. The two dashboard copies are fed the *identical* inbound `body` that `judgeTools` is handed at `src/index.ts:1311` vs `:1351`, so they were genuine duplicates, not two views of different data. All four now walk one module, `src/utils/tool-shapes.ts`, which exports `extractToolRecords(body): ToolRecord[]` (`{name, schema}`, deduplicated by name, first occurrence and first schema win) and `toolNameOf(tool): string | undefined` for callers that want one entry's name only. It lives in `utils/` rather than in either consumer so the judge does not depend on the dashboard or the reverse.

**Behaviour deliberately preserved, in five places**: `name` wins over `function.name` and the schema comes from the same branch as the name, so a flat `name` is never paired with a nested `function.parameters` — this is what the judge already did (the first version of the new test asserted the opposite and was wrong, not the code); the OpenAI branch is **not** gated on `type: 'function'`, because the old judge skipped an entry without the tag, which is a second silent drop — an entry that names a function is a tool; nothing in the shared module trims, so the judge keeps receiving names exactly as sent and the dashboard trims in its adapter where it always did; `extractToolRequestCharLengthsFromBody` keeps its own per-tool loop and calls only `toolNameOf` on the entry, so a Gemini wrapper — which has no per-entry name — is still skipped rather than charged, leaving Gemini char accounting unchanged; and `tool-blocklist.ts` keeps its shape-preserving rewriter and its (already correct) inline Gemini filter, borrowing only the name lookup. The judge's `JudgeTool` interface is gone, folded into `ToolRecord`, and `buildStateText(body, tools: ToolRecord[])` takes the shared type — the schema is load-bearing there, since it is serialized into the §4.1 state text, so a `string[]` return would not have done.

**Covered by tests**: `tests/unit/tool-shapes.test.ts` (new, 18 tests — 13 for `extractToolRecords` across the three wire shapes, the flat Responses shape, Gemini's multi-declaration entry, the camelCase/snake_case regression, name-over-nested precedence, dedup keep-first, absent or non-object schemas, untrimmed names and malformed entries; 5 for `toolNameOf` including every case that must return `undefined`); 8 added to `tests/unit/dashboard-stats.test.ts` (4 per converter — the `['none']` sentinel for five empty-ish bodies, trim-then-dedup, both Claude and OpenAI shapes, the Gemini regression, and for the char-length walker: a charged tool, the system-text surcharge once per mentioned name and not otherwise, a repeated name accumulated across entries, and entries it cannot name including a Gemini wrapper); and the 7 `extractTools` tests **moved out** of `tests/unit/tool-judge-sidecar.test.ts` into the new file rather than being duplicated. Full unit suite: **1391 tests, 1377 pass, 14 fail**, and the same 14 fail on a clean checkout of `HEAD` (1331 / 1317 / 14) — so the +60 tests are all new and all passing, and none of the 14 is in a file this change touches. They are the `agent-tools` path-confinement tests (`read_file` / `write_file` / `bash — Section 12 rm/mv path confinement`), `SPINNER_MD` in `tui`, the two `parseSimpleToml` inline-table alias tests, and `openai-to-claude`. *(All 14 are cleared by the entry at the top of this file; the list is kept as the baseline this change was measured against.)* **An earlier revision of this entry said "1291 tests, 1285 pass, 6 fail", and an earlier draft of this work reported 36 `tsc` errors in `tui.ts` / `agent-session.ts` / `agent-tools.ts`: both were artifacts of an `unfinished npm install`** — `node_modules/@earendil-works/*` was absent, so three suites failed to load and `tsc` could not resolve `TuiMainScreen` / `BACKGROUND_CONTEXT`. Once the install completed, `npm run typecheck` exits **0** and the suite collects 100 more tests. The baseline was therefore re-measured against a complete `node_modules`; the numbers above are that measurement, not the earlier ones.

**Docs updated with the code**: the design doc's §6.1 call-site sketch named `extractTools(body)` — renamed to `extractToolRecords(body)`. `docs/getting-started/validating_tool_judge_sidecar.md` §7 listed both the Gemini key and the duplicates as open questions; items 1 and 2 are now recorded as resolved with what they were, and items 3–5 (Gemini `contents` vs `messages` context, silent unknown-TOML-section drops, the §2.2/§4.1 state-text contradiction) are explicitly left open.

**Not addressed**: the judge still gets no prompt context on Gemini requests, because Gemini bodies carry `contents` where `buildStateText` reads `messages`. That is item 3 above and the remaining known Gemini-shaped hole; it is a second bug, not this one.

### fix(config): parse `[tool_judge_sidecar]`, which the loader silently dropped

`src/utils/config-loader.ts`, `tests/unit/config-loader.test.ts` — the entry below this one shipped a client that speaks the tool-judge protocol and a wrapper that serves it, and the feature still could not be turned on: **`[tool_judge_sidecar]` was never parsed.** `ProxyConfig.tool_judge_sidecar` was declared at `config-loader.ts:138` and read by `src/utils/tool-judge-sidecar.ts:423` and `src/dashboard.ts`, but the hand-rolled TOML parser had no branch that ever populated it — not in the section dispatch, not in any of the three value-assign sites — so `sidecarConfig` was `undefined` on every request, `judgeTools` took its `if (!sidecarConfig?.judge_url) return … {called: false}` early return, and the tool list reached the upstream untouched.

**The failure was completely silent**, which is why the entry below was able to claim a hand-verified feature that was in fact unreachable from a config file. An unknown `[section]` falls through the dispatch chain to a bare `continue`; `parseSimpleToml` on a config containing a fully-specified `[tool_judge_sidecar]` returned `tool_judge_sidecar: undefined` with `_validationErrors` and `_validationWarnings` both **empty**. The section header, its six keys, and their values were discarded without a diagnostic. The only way to see it was to notice that the judge's `debug` line never appeared in the proxy log.

**The fix is four branches, mirroring `[privacy_filter]` exactly** — that section is the nearest neighbour (scalar-only sidecar, activation by URL presence, no `enabled` flag) and the branch already documented the pattern of repeating the string keys across both the quoted and unquoted value sites. Dispatch: `parts[0] === 'tool_judge_sidecar'` → `currentSection = 'tool_judge_sidecar'; config.tool_judge_sidecar = {}`. Quoted-string site: `judge_url | mode | api_key`. Number/string site: numbers `timeout_ms | threshold | max_batch_tools`, strings the same three as above. No array branch — the schema has no array keys. Unknown keys and wrong-typed values are still dropped (the allowlist is unchanged), so `enabled = true` does **not** become a second activation path, which the new test pins.

**Verified through the real proxy path**, not just the client: proxy on `:8899` → judge on `:8081` → a recording echo upstream on `:8890`, one `POST /v1/messages` carrying `Read` and `get_weather` for the prompt "What is the weather in Paris today?". The proxy log now shows `Tool judge sidecar (mode=choice, threshold=0.5): 2/2 judged, 1 to erase in 68ms` followed by `Erased blocked tools from request: Read`, and the upstream received `tools: ["get_weather"]` with `tool_choice` reset to `null`. Three consecutive runs at the **default 50 ms timeout** all judged 2/2 and erased `Read`. Note what those numbers mean: `choice` issues one HTTP request per tool, so the 50 ms budget applies per request, and the reported `in 68ms` is the whole loop — the client's total can exceed `timeout_ms` while every individual request stays inside it. `timeout_ms` is therefore a per-call budget, not a per-request wall clock; if the judge is cold or loaded, the symptom is `judged 0/N … failing open` and the remedy is to raise it. *(Superseded: the entry `fix(judge): timeout_ms is now a per-question budget with a 2000 ms cap per request` changed a request's budget to scale with the number of questions it carries. The observation recorded here — that under `choice` the client's total loop can exceed a flat `timeout_ms` while each individual request stays inside it — is still how `choice` behaves, and is now the reason the two modes share one rule.)*

**Covered by tests**: three in `tests/unit/config-loader.test.ts` — all six keys parsed with their exact values and types; the unquoted-value path (`judge_url = http://…`, `mode = choice`) exercising the second assign site; and a mixed-validity block asserting that `enabled = true` and the wrong-typed `threshold = "high"` / `timeout_ms = "2000"` are dropped rather than coerced. A regression back to an unparsed section fails all three. Full unit suite: **1266 pass / 6 fail**, the 6 being the pre-existing failures in `src/tui.ts` / `agent-session.ts` / `agent-tools.ts` (confirmed identical with this change stashed). *(Those numbers were taken with `node_modules/@earendil-works/*` uninstalled, which is what made those three suites and `tsc` fail; see the shared-walker entry above for the re-measured baseline.)*

**Not addressed**: the silent-drop behaviour that hid this bug is still there for any *other* unknown section — `continue`, no warning. Changing that is a parser-wide policy question, not part of this fix, and it is called out in the entry below as the reason the bug survived a hand-verification.

**Docs now match the code, rather than the reverse**: `docs/getting-started/proxy_config.example.toml`, `docs/architecture/status_of_sidecars_of_proxy.md` §4 and the status table appended to `docs/architecture/design_tool_judge_sidecar_protocol.md` all documented `[tool_judge_sidecar]` and listed its six keys as shipped *before* the loader could read them. Those three files are unchanged by this commit — the fix brings the parser up to what they already said, so no doc edit was needed to make them true. One doc **is** added: `docs/getting-started/validating_tool_judge_sidecar.md`, the manual validation procedure that found this bug, written up as a runnable recipe (the three layers, the harness scripts inlined so it does not depend on `/tmp`, the pass criteria for each, and the measured operational notes — 35.5 s cold start, `timeout_ms` being a per-request budget, `noul`'s poor discrimination on this checkpoint). The config-loader prerequisite it names is the fix above.

### feat(judge): serve the tool-judge protocol from Laya, and make the client speak it

`submodules/laya-mlx/serve_judge.py`, `src/utils/tool-judge-sidecar.ts`, `tests/unit/tool-judge-sidecar.test.ts`, `docs/architecture/design_tool_judge_sidecar_protocol.md`, `docs/architecture/status_of_sidecars_of_proxy.md`, `docs/getting-started/proxy_config.example.toml` — the two halves the previous entry left undone. Laya had no HTTP server at all (`laya_mlx/cli.py` is `predict` / `convert` only), and the client did not speak the protocol the design doc specifies, so every judge call parsed to zero erasures while logging an `info`-level success.

**The wrapper** (`serve_judge.py`, stdlib `http.server`, no new dependencies — matching the sibling-sidecar convention in `plan-opf-privacy-filter-plugin.md:45` and the server-inside-the-sidecar-submodule layout): `POST /judge` accepts the doc's `{state, questions}` and calls `agent.system_one(state, questions)` once, under a lock — a single MLX `Agent` is not safe to drive from concurrent threads, and `ThreadingHTTPServer` would otherwise re-enter it. `GET /health` returns `{status, model_version, mode}` (doc §7.2). The model is loaded *before* the socket binds, so a broken checkpoint fails loudly at startup instead of answering every request `500`.

**Why the wrapper does almost nothing:** Laya's per-question answers already carry exactly the doc's §2.4 / §2.5 fields — `{type, confidence, action, choice, probabilities}` for `choice`, `{type, confidence, action, noul}` for `noul` — so the only translation needed is unwrapping Laya's `{model, answers, usage}` envelope into the top-level qid-keyed map the doc specifies. Anything else would be re-implementing the model's own output. Error mapping is deliberate: a `ValueError` (Laya raises it for malformed question definitions, and the wrapper for a bad body) is the caller's fault → `400`; `FloatingPointError` (Laya's own non-finite-outputs signal) and any other inference failure → `500` with the exception named, and the traceback logged. Answers are checked against the question set before returning: a mismatch is a `500`, not a partial map the client would silently fail open on.

**The client rewrite** was five separate defects, all of which had to go:
- `buildNoulRequest` / `buildChoiceRequest` emitted **one question for N tools** (the `toolNames` argument was accepted and never read). Now `noul` keys one question per tool name and `choice` issues one request per tool — the shape Laya and doc §2.3/§2.2 both require, and the reason `choice` is now a sequential loop rather than a single call.
- Both parsers read fields that exist in neither Laya nor the doc — `answer.keep.items[name]` and `answer.decision.probabilities[tool]`. Now `response[toolName]` for `noul` and `response.decision.probabilities.keep` for `choice`, with `keep` iff score **strictly greater than** `threshold` (doc §3).
- `buildStateText` sent only the tool *names*, so the judge had nothing to judge relevance against. It now emits doc §4.1 — the user prompt, each tool with its parameter schema, recent user messages and assistant tool calls (Claude `tool_use` blocks, OpenAI `tool_calls`, legacy `function_call`) — capped at 2000 chars of prompt, 600 per schema, 3 context messages, 5 tool calls. The caps are not cosmetic: Laya builds its sequence with `max_len=512` / `head_max_len=192` and raises `ValueError("Question … has too many options for the token budget")` on overflow, so an unbounded schema dump would fail open on every request.
- A malformed JSON body, a non-object body, a non-2xx, and a timeout all returned `null` — but the old code then logged an `info` success and counted the tools as judged. Per-tool failures now land in `unjudgedNames`, over-cap tools in `skippedNames`, and a summary line (`N/M judged, K to erase, U unjudged (kept), S over max_batch_tools=N`) is logged at `warn` whenever anything was left undecided. `JudgeResult.error` is set for both total (`Sidecar judged none of N tools — failing open`) and partial failure. Failing open is still the behaviour; failing open *silently* is not.
- `judge_url` is documented as a base URL, so the client appends `/judge` — tolerating an already-complete `/judge` URL so a config written against the doc's full-URL example still resolves rather than POSTing to `/judge/judge`.

**Covered by tests**: `tests/unit/tool-judge-sidecar.test.ts` (31 tests as of the shared-walker entry above; it was 38 when this entry was written — the 7 `extractTools` tests now live in `tests/unit/tool-shapes.test.ts`, unchanged apart from the Gemini key they assert) — `buildStateText`'s §4.1 sections, last-user-message-is-the-prompt, OpenAI `tool_calls` argument parsing, schema truncation and both context caps; the request builders' question ids, types and criteria; both parsers including the `> threshold` boundary (exactly `0.5` at threshold `0.5` erases), a missing answer keeping with `factor: 1.0`, and a wrong-typed answer doing the same; and `judgeTools` against a stubbed `globalThis.fetch` — one request per tool in `choice` mode with each state carrying only its own schema, one batched request in `noul` mode, the timeout actually aborting the request, the `api_key` bearer header, and every fail-open path asserting both the decision **and** the report (`unjudgedNames` / `skippedNames` / `error`), so a regression back to silent no-op fails the tests rather than passing them.

**Verified end-to-end once, by hand**: a Python 3.13.3 venv with `mlx==0.32.3` on arm64, `serve_judge.py` started against the locally cached `aac6fef/laya-multilingual-mlx` checkpoint (a converted `convaiinnovations/laya-multilingual`, not the `convaiinnovations/laya` this file defaults to), and the real client driven at it through `judgeTools` over HTTP. It works: `/health` returns the documented shape; a Claude-shaped body asking for the weather with `Read` and `get_weather` attached comes back `2/2 judged, 1 to erase` in `choice` mode with `Read` erased and `get_weather` kept, twice in a row; both error paths (`{"state":"x"}` → `400`, an unknown question type → `400`, an unknown path → `404`) answer as intended; and Laya's answer objects come back as exactly the §2.4/§2.5 fields the wrapper passes through, which is the assumption the whole no-translation design rests on.

**Not covered by tests**: `serve_judge.py` has no tests of its own, and the numbers above are one hand-run on one checkpoint — not a suite, and not reproducible by CI. Two observations from that run that a real rollout needs to settle first. **`noul` mode discriminated poorly** on the multilingual checkpoint: for a weather prompt with `Read` attached, it scored `Read` at `noul=0.7051` and `get_weather` at `0.9343`, so with the default `threshold=0.5` nothing was erased at all, where `choice` mode erased `Read` on the same state — the doc's `noul` instruction wording ("Keep `<tool>` tool?") may just be too weak a prompt for this model, and is worth tuning (or leaving `choice` as the default, which it already is) before `noul` is used in anger. And a prompt needing no tool at all ("Say hello in one word") erased nothing in either mode. **Latency**: 32–106 ms per call end to end, so the doc's 50 ms p99 budget is met only on the warm path — the first call after load was 106 ms. **Startup is the bigger number**: loading the checkpoint and binding the socket took **35.5 s** on this machine (`13:28:41 loading …` → `13:29:16 listening on http://127.0.0.1:8081`), so the process is not usable until roughly half a minute after launch. (An earlier revision of this entry said "about 0.4 s"; that was wrong — the model load dominates, and nothing answers `/health` until it finishes, which is deliberate: `serve_judge.py` binds only after a successful load so a broken checkpoint fails loudly instead of 500-ing every request.)

**Docs corrected while in here**: the example config's `[tool_judge_sidecar]` block documented a *third* response shape that neither Laya nor the client produces (`{type:"noul", items:[{tool, score}]}`, `{type:"choice", tool, probabilities}`) and a Flask stub keyed on `questions["keep"]["tools"]`; `status_of_sidecars_of_proxy.md` §4 listed a `batch_size`/`fail_open` schema that does not exist and credited the sidecar to a `filter_tools` builtin transform that appears nowhere in `src/`; both now describe the shipped contract. The design doc §8 block is left as written — it is a design proposal, not a description of shipped code — with a status table added beside it recording which of its keys (`enabled`, `url`, `thresholds`, `send_context`, `context_window`) are **not** implemented.

### chore(submodules): vendor `qidu/laya-mlx` at `submodules/laya-mlx`

`.gitmodules`, `submodules/laya-mlx` — adds `git@github.com:qidu/laya-mlx.git` (pinned at `fc1df62`, branch `main`) alongside the existing `submodules/{chatjimmy,privacy-filter,kompress,node-keytar}` vendor pins. Laya is an open-weight *typed-decisions* model — a bidirectional encoder with decision heads and zero output tokens, answering `choice` / `score` / `noul` questions in a single forward pass — and is the intended implementation behind `docs/architecture/design_tool_judge_sidecar_protocol.md`.

**Vendor pin only; nothing consumed it at the time of this change.** `src/utils/tool-judge-sidecar.ts` did not talk to Laya's wire format: it sent one question for N tools (Laya, and design doc §2.3, key one question per tool), and parsed `answer.keep.items` / `answer.decision.probabilities[tool]`, which is neither Laya's `{answers: {<qid>: {type, noul | probabilities}}}` envelope nor the design doc's §2.4/§2.5 shapes. Laya also ships no HTTP server — `laya-mlx predict` is a CLI — so `POST /judge` (doc §2.1) needed a wrapper before an end-to-end call was possible. Between this pin and the entry above, every judge call parsed to zero erasures and reported it as an `info`-level success; **both defects are fixed by the entry above**, which is the first change that consumes this submodule.

**Not initialized on this checkout**: like the other four, the pin is declared but empty until `git submodule update --init submodules/laya-mlx`.

### feat(router): answer Claude Code's `HEAD /api/hello` startup probe with a local `200`

`src/index.ts`, `tests/unit/api-hello.test.ts` — `HEAD /api/hello` is the connection-warming probe Claude Code fires at startup, before its first real inference request, so a gateway can pay the TLS and TCP setup cost on traffic the model never sees (`docs/api/llm-gateway-protocol-for-claude-code.md:60`). The path matched no route, so it fell through to the auth presence check and was answered `401` — or, with a credential, died in `parseFixedRoute` with `Unsupported fixed route: /api/hello`. It is now answered with `200` and an empty body, next to `/favicon.ico` and before the auth gate.

**Why before the auth gate:** Claude Code sends the probe with no credentials, which is exactly what the presence check rejects, so any placement after it would return `401` and re-create the bug it is meant to avoid. Answering it locally also keeps it off the upstream entirely. The spec calls this traffic "best-effort startup traffic [the gateway] can reject without breaking anything" — a `401` would indeed be survivable, so this buys latency and log noise, not correctness; the client is documented as skipping the probe when an HTTP proxy or client certificate is configured, in which case it is not sent at all.

**Path-only matching, like the other operational endpoints:** `/favicon.ico` and `/health` both match on path alone, so `/api/hello` does too and `GET /api/hello` also returns `200`. No method check means no second, subtly different code path for a probe that exists only to be fast. The body is `null` rather than an empty string, which is what `HEAD` wants and what both the Workers and the Node adapter (`src/server.ts`, which already skips body-stream construction for `GET`/`HEAD`) expect.

**Covered by tests**: `tests/unit/api-hello.test.ts` (6 tests) — the probe returns `200` with no auth header, makes **no upstream `fetch` call** (asserted against a mocked `globalThis.fetch` recording every call, so a regression that proxied it instead of answering it locally would fail), returns an empty body, is still answered `200` with `DEV_NO_KEY: 'false'`, that is, before the auth presence check; `GET /api/hello` returns `200`, pinning the deliberate no-method-check choice; and an adjacent unknown path, `/api/not-hello`, is still rejected `401`, so the exemption cannot silently widen.

**Not covered by tests**: the end-to-end Claude Code client behaviour — that Claude Code actually issues this probe, and that it treats any response as a warming success, are both taken from the protocol doc and are not driven from a real client here.

**Known limitation, deliberately not addressed**: the handler sits after `loadProxyConfig(env)`, so if the TOML config fails to load, the probe fails too. Matching `/config-reload` — which also loads config before answering — was the closer convention than the `loadProxyConfig` bypass used by the dashboard, and the probe is best-effort by definition.

### feat(server): add `--dashboard` flag; `--tui` and `--agent` imply it

`src/mode-flags.ts`, `src/server.ts`, `src/cli.ts`, `src/utils/dashboard-stats.ts`, `tests/unit/mode-flags.test.ts` — `--dashboard` is the argv spelling of `DASHBOARD=true`: it turns on token-stats persistence (append to `model_proxy_tokens.jsonl` + restore at startup). `--tui` and `--agent` now set it too, since both render the same token stats the dashboard serves, so asking for either is asking for the stats to survive a restart.

**What `--dashboard` does and does not change:** the `/dashboard` page and `/dashboard/api/*` were already always on (loopback-only, optional `DASHBOARD_API_KEY`) — that is untouched. The flag is additive, and only governs the JSONL dump/restore that previously required `TUI=1` or `DUMP=1`: `persistenceEnabled = dashboardEnabled || tuiEnabled || dumpEnabled`. It claims no stdout, so unlike `--rpc`/`--tui`/`--agent` it composes with any of them (`--rpc --dashboard` is allowed) and needed no new conflict guard.

**Why the implication is flag → flag only:** a bare `TUI=true` / `AGENT=true` env var does **not** imply `DASHBOARD`. A supervisor that sets those vars would otherwise silently start writing a JSONL file to the working directory. `DUMP=true` remains the env-only way to get persistence without a UI. The three vars stay one source of truth — `--dashboard` is normalized into `process.env.DASHBOARD` in `src/mode-flags.ts` at import time, exactly like the existing flag/env pairs, so nothing downstream had to learn about flags.

**The periodic-dump gap, and why the TUI is excluded from the timer:** `persistenceEnabled` alone only buys a restore at startup plus the day-rollover write, so the flag would have been restore-without-write. The only periodic writers are the TUI's own 30-min timer (`src/tui.ts`) and the standalone 30-min timer in `src/utils/dashboard-stats.ts` that was gated on `DUMP` alone. That standalone timer now also runs when `DASHBOARD=1` **and the TUI is not running** (`tuiOwnsDumpTimer`): since `--tui` implies `DASHBOARD`, gating on `DASHBOARD` alone would start a second timer beside the TUI's, and the two share the module-global `lastHeatmapDumpTs` cursor — the deltas are additive so nothing is lost, but the same stream would be split across more lines and the TUI would print a spurious "auto-dumped tokens" notice. `--agent` has no timer of its own and is covered by the standalone one.

**Covered by tests**: `tests/unit/mode-flags.test.ts` (17 tests) — `--dashboard` sets `DASHBOARD=true` and starts no UI (`TUI`/`AGENT` stay undefined), overrides a contradicting `DASHBOARD` env var, both `--tui` and `--agent` set `DASHBOARD`, the bare `TUI=true`/`AGENT=true` env vars leave `DASHBOARD` undefined (the flag-only implication, asserted directly), `--dashboards` does not match by prefix, and `MODE_FLAGS` is exactly `['--rpc','--tui','--agent','--dashboard']` with `--dashboard` alone rejected by `runCli` as `Unknown argument: --dashboard` (proving the strip in `src/server.ts` is necessary).

**Not covered by tests**: the import-order timing constraint (no separate-process test), and the standalone 30-min timer path end-to-end — no test drives a `DASHBOARD=1` process across a dump interval, so the `tuiOwnsDumpTimer` exclusion is verified by reading the two timer sites, not by execution.

### fix(agent-session): proxy warn/error log shows on one dedicated row above the `──` rule, not on the `>` prompt row

`src/agent-session.ts`, `tests/unit/agent-session.test.ts` — `src/server.ts` routes every proxy diagnostic to stderr (`console.log`/`info`/`debug` are aliased onto `console.error`'s original function there, keeping stdout free for CLI payloads), and the shared `Logger` emits *every* level — WARN and ERROR included — through `console.log`. A raw stderr write lands on whichever row the TUI parked the cursor on, which is the `>` input row, so a proxy warning smeared across the user's half-typed prompt. `TUI=true` resolves the same conflict by silencing every console method outright; in `AGENT=true` the lines are wanted, so while the persistent TUI owns the screen `captureConsoleOutput(append)` replaces all five methods and shows each line in `proxyLogLine` — a single dedicated row mounted between the conversation area and the `──` rule — then `restoreConsoleOutput()` hands the genuine methods back as the first statement of `stopPersistentTui`.

**Why all five methods, not just `console.error`:** replacing `console.error` alone would leave the proxy logger's own channel (`console.log`) still writing straight to stderr, which is the exact path the bug arrives on.

**Layout — one row, newest replaces the previous:** the proxy can emit warnings per attempt on this branch, so the display is deliberately fixed-height: `setProxyLogRow(row, line)` does `row.clear()` then adds a single `TruncatedText(dim(line), 0, 0)`, the replace-a-child convention `updateStatusBar` already uses. `TruncatedText` clips to exactly one row (ANSI-aware, pad to the render width) so a long warning cannot wrap and push the `──` rule and the `>` row down mid-session; `addChild` without the `clear()` would stack rows instead, growing the layout by one line per warning. The row is a `Box(0, 0)`, and an empty `Box` renders no rows at all, so nothing is consumed before the first log arrives. An earlier cut of this fix appended every line to the conversation area as a dim `Markdown`; that grew the transcript without bound and is what this replaces.

**Why `captureConsoleOutput` takes the sink as a parameter** rather than closing over `proxyLogLine`/`currentTheme`: the redirection/restoration contract is then unit-testable without a real terminal. `requestRender()` inside the capture is null-guarded (`persistentTui?.requestRender()`), so capturing while no TUI exists is a safe no-op. `util.format` reproduces what the real console methods would have printed, including inspected objects for non-string args; multi-line messages (a few of the proxy's startup notices are multi-line) are delivered one callback per non-blank line, so with a single-row display the message's last line is what remains visible.

Restoration is guarded by `savedConsoleMethods`, making capture idempotent: a second capture would otherwise adopt the capturing function as the "original" and restoring it would leave the console diverted for the rest of the process. The early returns in `runAgentSession` (no model picked, cancelled, missing API key) all happen before the TUI starts, so `restoreConsoleOutput()` is a no-op on those paths.

**Covered by tests**: `tests/unit/agent-session.test.ts` → `captureConsoleOutput` (4 tests) assert that capturing diverts all five methods and writes **nothing** to `process.stderr` (asserted against a stubbed `process.stderr.write`, so the test fails if any method escapes the capture), that a multi-line message yields one callback per non-blank line, that teardown restores the *identical* original function objects, and that a second capture is a no-op. `setProxyLogRow` (4 tests) render the real component: the second log replaces the first rather than concatenating (one row, stale text gone), an empty row renders **zero** lines, a long warning is truncated to exactly the render width at widths 10/30/120 (`visibleWidth`, so a wrap is a failure), and the line is dim. Both properties were confirmed to bite by rendering the rejected alternatives: a `Markdown` child in place of `TruncatedText` produced 16 rows at width 30, and two children without the `clear()` produced 2. The aliased-console case was additionally verified against a byte-level replica of `src/server.ts`'s redirect: with `console.log === console.error`, both channels are captured and zero proxy text reaches stderr.

**Not covered by tests**: the on-screen placement (needs a real PTY) and the `AGENT=true` end-to-end path.

**Known limitation, deliberately not addressed**: a multi-line log shows only its last line, since each split line overwrites the row. Separately, `printProcessLog`'s raw `process.stderr.write` (`src/agent-session.ts:1592`, written every 400ms while a tool runs, gated only on `isStderrTty`) bypasses `console` entirely and so is **not** captured — it corrupts the prompt row the same way. Routing it through the capture would take the in-flight progress line off the terminal, which is a behavior change beyond this fix.

### fix(agent-session): dim the `──` rule, and show the `|` tool separator only when a tool has been used

`src/agent-session.ts`, `tests/unit/agent-session.test.ts` — The `──` rule above the `>` row was drawn in the terminal's default foreground, which made it compete with the conversation text. `RuledInput.render` now wraps it in `dim()`, the same dark-gray helper the status bar and transcript notices already use.

The status bar's tool segment always emitted the `|` that separates the skills list from the tool list, so an empty tool list rendered a dangling `… (results) (skills) |  ` — a separator with nothing on its right. It is now `const separator = toolsList ? ' | ' : ' ';`, so the `|` appears only once at least one tool has actually been called. (The status line itself was already `dim()`ed; only the rule gained it.)

`dim()` is applied to the rule rather than the whole row, and the zero-width guard is kept: `dim('')` would emit stray SGR bytes for an invisible line, so a non-positive width still yields `''` rather than a styled empty string.

**Covered by tests**: the `RuledInput` suite asserts the rule is exactly `width` `─` chars on the first row at widths 1/5/40/200, checking `visibleWidth` — `─` is East-Asian-Width ambiguous, so that is what actually decides whether the rule wraps onto a second line. The assertions strip ANSI before comparing, which proves the `dim()` wrapper did not change the rule's geometry; the zero-width case still asserts `lines[0] === ''`.

**Not covered by tests**: that the rule is actually dim, and the status-bar ` | ` separator — `updateStatusBar` reads the module-scope `toolsUsedNames`/`pendingToolNames`/`selected` and writes into the module-scope `statusBar`, so it is not callable in isolation. Both are visible-only changes verified by eye in a real TUI; the geometry tests are what guard them against regressing silently.

### feat(agent-session): window title `Agent π in proxy v3`, alternating π/`*` while a task runs

`src/agent-session.ts`, `tests/unit/agent-session.test.ts` — The agent session sets the terminal window title to `Agent π in proxy v3` via OSC 0 (`\x1b]0;<title>\x07`) at session start, so the window is distinguishable from the proxy's other TUI/TRAJ sessions. While a task is in flight the title alternates its π with `*`, two ticks each — `π π * * π π * *` at 150ms/tick, so each glyph is held 300ms — because the transcript with the running-task spinner may be scrolled off screen. While idle the title shows a plain π.

`agentTitleGlyph(tick)` is extracted as an exported pure function (`tick` is 1-based; `startTuiSpinner` increments `spinnerTick` before its first glyph, so tick 0 never fires) rather than inlined in the interval, following the file's existing convention of exporting `SPINNER_CHARS`/`SPINNER_MD` for tests. The `Math.floor((tick - 1) / 2)` form is deliberate: the obvious `Math.floor(tick / 2) % 2` would make the opening π run a single tick, since tick 0 never occurs.

`AGENT_TITLE` and `IS_STDOUT_TTY` live at module scope, not inside `runAgentSession`: `runAgentTurn` drives the spinner and is a module-level function, so it cannot see that function's locals. All title writes are gated on `IS_STDOUT_TTY` — piped stdout would otherwise log the escapes as garbage. The two user-facing exit paths (`bye!` and `Budget reached`) hand the title back to the shell default with an empty OSC 0; early-return paths (no model picked, cancelled prompt, missing API key) deliberately do not, because the process is still the proxy server and there is nothing to hand back.

`stopTuiSpinner(clear = false)` gained its parameter to fix a teardown ordering bug: those exit paths clear the title inside the `try`, then the `finally` runs `stopPersistentTui()` → `stopTuiSpinner()`, which had unconditionally re-written π after the session had ended. `stopPersistentTui` now calls `stopTuiSpinner(true)`.

**Covered by tests**: `tests/unit/agent-session.test.ts` → `agentTitleGlyph` (3 tests) assert the exact π π * * π π * * sequence over the first eight ticks, that each glyph is held for exactly two ticks (tick *n* = tick *n+1*, tick *n* ≠ tick *n+2*), and that no tick ever yields a glyph other than π or `*`.

**Not covered by tests**: the OSC 0 write itself and the teardown ordering — `writeAgentTitle`/`clearAgentTitle` are module-private and `IS_STDOUT_TTY` is frozen at import, so exercising them needs a real PTY with a TTY stdout.

### feat(server): add `--tui` and `--agent` flags to start dashboard / agent session

`src/mode-flags.ts` (new), `src/server.ts`, `src/cli.ts` — The interactive dashboard (`TUI=true`) and the loopback agent session (`AGENT=true`) were reachable only via environment variables. Two argv flags now spell the same modes: `--tui` and `--agent`, documented in `src/cli.ts` USAGE and forwardable through `npm run server -- --tui` / `--agent`.

**Why a dedicated module at import time:** Six code paths already read `process.env.TUI` / `process.env.AGENT` — `server.ts`'s `env` literal, `LOG_LEVEL` default, `--rpc` conflict check, mode dispatch; `agent-session.ts`'s `agentMode`; and `logger.ts`'s module-scope `AGENT_MODE` (frozen at import). `server.ts`'s first project import (`utils/config-loader.ts` → `utils/logger.ts`) reaches `logger.ts` before `server.ts`'s own body runs, so argv parsed anywhere in the body is too late. The fix is a self-executing module (`src/mode-flags.ts`) placed as `server.ts`'s very first import: it normalizes `--tui`/`--agent` into `process.env` at import time, leaving all six read sites byte-identical. A flag wins over a contradicting env var (`AGENT=0 --agent` starts the agent), being the more specific request.

**Why strip before `runCli`:** `runCli()` treats unknown args as usage errors. A mode flag beside a command (`--tui --list-models`) would otherwise exit 2 with "Unknown argument: --tui". `MODE_FLAGS = ['--rpc','--tui','--agent']` is stripped in `server.ts` before the `runCli` scan; the strip is idempotent and `runCli` exits before the server starts anyway.

**Covered by tests**: `tests/unit/mode-flags.test.ts` (13 tests) — `applyModeFlags` sets the canonical `true` values, leaves unrelated argv alone, overrides contradicting env vars, matches exactly not by prefix, and is idempotent; `MODE_FLAGS` lists exactly the three modes; every mode flag is rejected by `runCli` (proving the strip is necessary); stripping lets a real command through and prints output; stripping all flags leaves empty argv so `runCli` returns `null` (server starts in the requested mode).

**Not covered by tests**: the import-order timing constraint (hard to test in isolation without a separate process); the pre-existing no-TTY silent-fallthrough — with `--tui`/`--agent` and no TTY the existing `&& process.stdin.isTTY && process.stdout.isTTY` guard silently falls through to the plain HTTP server, same as `TUI=true`/`AGENT=true`.

### feat(agent-session): add `-` frame to the running-task spinner

`src/agent-session.ts`, `tests/unit/agent-session.test.ts`, `docs/architecture/design_of_persistent_tui_of_agent_with_followup_for_task.md` — The in-flight task's animated `>` marker cycles through `\ | / +` at 150ms/frame. A user requested the fifth common spinner frame `-` (`\|/+-+`). Adding `-` required escaping it for Markdown: a bare `- ` at a line start is list syntax, and while pi-tui draws the bullet as `-` (same character), the list item's wrapped continuation lines carry a hanging indent that a paragraph's do not — causing the task text to jump sideways on that frame. Both list markers (`+` and `-`) are now escaped in `SPINNER_MD`; the stdout verification spinner keeps bare `SPINNER_CHARS` because it never goes through Markdown.

**Covered by tests**: `tests/unit/agent-session.test.ts` SPINNER_MD suite — the new wrapping regression test asserts that every frame in `SPINNER_MD` wraps its continuation lines at the paragraph indent, and would fail if `-` (or `+`) were unescaped; the existing `renders every frame literally` test still passes; the array-length assertions updated to 5 frames.

**Not covered by tests**: visual confirmation of the 5-frame animation (requires a real PTY); the stdout spinner still uses the bare 5-frame set.

### fix(deps): migrate to pi-tui 0.87's `TuiMainScreen` for the removed `TUI` constructor

`package.json`, `src/tui.ts`, `src/agent-session.ts` — Bumping `@earendil-works/pi-tui` from `^0.76.0` to `^0.87.1` aligns it with `@earendil-works/pi-agent-core`, already at `^0.87.1`, but breaks the build: in 0.87 `TUI` is exported as a **type only**, so the five `new TUI(terminal)` construction sites are no longer valid. The package now ships two implementations of that interface, both extending `abstract class TuiBase`: `TuiMainScreen` (`mode: "regular"`, renders into the main terminal buffer and preserves terminal scrollback) and `TuiAltScreen` (`mode: "fullscreen"`, a fixed-height application-owned viewport in the alternate buffer, with mouse capture, scrollbars and search).

All five sites take `TuiMainScreen`, the behavior-preserving successor. Both the dashboard and the agent screens render inline into the main buffer and rely on the terminal's own scrollback, so `TuiAltScreen` would be a UX change nobody asked for — and would begin capturing mouse input. Its constructor also differs (`(terminal, showHardwareCursor?, logDirectory?, options?)`), so it is not a drop-in even ignoring that.

The five constructor errors were `TS2693`; each degraded the enclosing field's inferred type to `any`, which in turn produced 28 further errors across `src/tui.ts` (`TS2531` on every `this.overlay`/`this.tui` member access, `TS18047` on the `persistentTui` calls, `TS7006` on a callback that lost parameter inference) — 33 in total, all from the one root cause. Fixing the five sites cleared all 33, and `npm run typecheck` and `npm run build` are both clean.

Note that neither `tsconfig.json` nor `tsconfig.server.json` sets `noEmitOnError`, so `npm run build` had been writing a `dist/` that did not typecheck; a fresh `dist/` timestamp is not evidence of a clean build.

`src/tui.ts` used `TUI` only as a value, so its import is replaced outright rather than kept as an unused `type TUI`. `src/agent-session.ts` also uses it in a type position (`let persistentTui: TUI | null`), so it keeps `type TUI` and adds `TuiMainScreen`.

**Not covered by tests**: no test constructs a TUI — the five sites are inside module-private entry points that need a real PTY. Verification was `npm run typecheck` (0 errors), `npm run build`, and the existing unit suite, which imports `src/agent-session.ts` and so would fail at import time were the `TuiMainScreen` export missing. That suite reports 12 pre-existing failures unrelated to this change and unreachable from pi-tui: 10 in `tests/unit/agent-tools.test.ts`, whose path-confinement assertions hardcode POSIX `/tmp/` while `src/agent-tools.ts` deliberately reports the platform temp dir (`C:\Users\<user>\AppData\Local\Temp` on Windows), and 2 in `tests/unit/config-loader.test.ts`, where a `url` alias inside an inline-table `[models.*]` entry parses to `''` instead of the URL.

### fix(agent-session): trim transcript text before it reaches `Markdown`

`src/agent-session.ts` — Every transcript line is handed to pi-tui's `Markdown`, which parses 4+ leading spaces as an indented code block. Ordinary command output — an `ls` or tree listing, a padded one-liner — therefore rendered inside ``` fences with per-character syntax highlighting, and output or replies opening with blank lines rendered as blank rows pushing the transcript down.

Both `!` shell loops now `.trim()` the combined stdout/stderr once, at the source, before constructing the `Markdown`. This also removes an inconsistency in the first loop, which already guarded with `if (output.trim())` and pushed `output.trim()` into `shellOutputs` while rendering the untrimmed `output` — the transcript and the task prompt could show the same output differently.

The streamed agent reply uses `.trimStart()` on the display copy only (`currentAssistantMessage.setText(…)`), leaving the `currentAssistantMessageContent` accumulator holding raw deltas: trailing whitespace is provisional mid-stream, and stripping it on every delta would flicker Markdown's two-space soft break.

Interior indentation is preserved — a nested listing keeps its own 4-space children, since only the leading edge of the whole string is removed — and a genuine indented code block still renders as one.

**Covered by tests**: `tests/unit/agent-session.test.ts` → `output trimming before Markdown` (6 tests) pin the component's own one-row top margin as the baseline, assert that untrimmed 4-space output does fence (the regression), assert trimmed output reaches exactly that margin with no fence and no source indentation, and assert interior indentation and intended code blocks survive.

### feat(agent-session): full-width `──` rule above the bottom input row

`src/agent-session.ts:329–349` — `RuledInput` wraps the pinned bottom `Input` and prepends a `'─'.repeat(width)` row, so the input row reads as visually separate from the scrolling conversation above it. pi-tui ships no separator component, so this is a wrapper rather than a fork: it forwards `focused`, `handleInput` and `invalidate` to the inner `Input` and renders the rule on its own line, leaving the inner component the full terminal width for its own text and cursor. `Math.max(0, width)` guards `String.repeat`'s `RangeError` on a pathologically narrow or zero-width terminal.

An earlier iteration put a `│ ` gutter in front of the prompt character instead; that was removed at request and the class renamed from `PrefixedInput`.

**Covered by tests**: 6 tests in `tests/unit/agent-session.test.ts` → `RuledInput` assert the rule is exactly `width` chars on the first row, that the inner input still renders from row 1 at full width, that the cursor marker stays on the input line and never leaks onto the rule, and that `focused` reads and writes pass through.

### feat(agent-session): live progress and elapsed time during model verification

`src/agent-session.ts` — The `AGENT=true` model picker verifies the chosen model with a loopback `/v1/messages` call before starting the session, and that round-trip can sit for many seconds with no output at all, so a slow or hung proxy was indistinguishable from a working one. The verify loop now prints a live in-place progress line — `\ checking… 3.1s` — reusing the existing `SPINNER_CHARS` set and `dim()` helper rather than introducing a second progress mechanism, at the same 150ms cadence as the TUI's running-task spinner.

The elapsed total is appended to the outcome line either way, so a redirected run still reports duration: `[proxy] replied ok (3.1s)`, or `[proxy] verifying failed: model returned an empty reply (3.1s).`

The animation is gated on `process.stdout.isTTY` and stays silent when stdout is redirected — the verification output goes to stdout via `console.log` (unlike the status bar, which deliberately uses stderr), and a line every 150ms would flood a log file. `stopVerifyProgress()` is idempotent, erases the partial line, and is called before every `console.error` so error text is never appended to a half-written progress line; error output stays plain, per the convention at the top of the file. The timer is declared inside the `while` body and cleared in `finally`, so picking a different model cannot leak an interval.

**Not covered by tests**: the verify loop is inside `runAgentSession`, which is module-private, so this has no unit test — exercising the real path needs a live proxy and model. Only the escape-sequence logic was checked, by a byte-stream replica.

### feat(agent-session): `/q` `/quit` `/exit` `/bye` end the loop from the TUI input row

`src/agent-session.ts` — The four quit commands already existed as `QUIT_COMMANDS` and were honored at the task prompt, but `handleInputSubmit` forwarded **every** mid-run submission to `agent.followUp()`, so typing `/q` while the agent was working sent the literal string `/q` to the model as a prompt instead of stopping it. Quit commands are now intercepted before the `followUp()` branch: they set a new module-scope `quitRequested` flag, print `[π quit] exiting agent loop`, then call `agent.abort()` if a turn is in flight or resolve the pending next-task wait with `null` if idle.

`quitRequested` also stops the queued-follow-up drain in `runAgentTurn`, exits the task loop, and suppresses the `[error]` render for the abort's own rejection (a deliberate quit is not an error). The per-turn summary reads `[π quit requested …]` rather than `[π task done …]` so an aborted turn is not reported as completed. The quit check runs before the budget acknowledgment, so a user who already asked to stop is not asked to confirm it again.

Also fixed: the budget acknowledgment prompt reads "press enter or type /q to exit", but its resolver only accepted `null` or a quit command — blank input did nothing. It now accepts blank input too, matching the top-level loop's existing treatment of blank as end-of-session.

**Not covered by tests**: `handleInputSubmit` and the task loop are module-private and the module's export surface is only its pure helpers, so the quit path has no unit test. Adding one would mean exporting TUI internals or driving a real PTY — a design change, not a test.

### feat(agent-session): persistent TUI with mid-run followUp input

`src/agent-session.ts` — Replaced throwaway TUI screens with a single persistent TUI that stays alive for the entire session. The conversation area streams assistant replies (text deltas, tool calls, tool results) as Markdown components; a pinned input row at the bottom accepts new prompts at any time. While the agent is running, submitted input is queued via `agent.followUp()` (one message per `followUpMode: "one-at-a-time"` drain) and rendered immediately as a user message. Between tasks, input becomes the next task prompt. Status bar shows live counts of skills/tools/results and budget usage.

The in-flight task's line now animates its leading `>` through a `\ | / +` spinner (150ms per frame) and reverts to a static `>` once the turn settles, so the transcript itself shows which task is still running. Also fixed: the first text delta of each turn called `conversationArea.clear()`, which discarded the task line and all prior history — the conversation area now accumulates across turns as designed.

Because that task line is rendered as `Markdown`, the `+` frame needs escaping: `+ ` at a line start is list syntax, and pi-tui draws it as a `-` bullet rather than a plus. `SPINNER_MD` therefore holds the same frames with `+` written `\+`, while `SPINNER_CHARS` stays bare for the stdout verification spinner, which is not Markdown. `runAgentTurn` also takes a `taskLabel` parameter defaulting to `task`, splitting what is sent to the model (`task`, the full payload including accumulated shell output) from what is shown in the transcript (`taskLabel`, the line the user actually typed).

**Covered by tests**: 3 tests in `tests/unit/agent-session.test.ts` → `SPINNER_MD` assert each frame's escaped form and that rendering a frame through `Markdown` yields the intended glyph rather than a list bullet. **Not covered**: that the 150ms interval advances `spinnerTick`, and the `taskLabel` split — both are module-private wiring.

### feat(agent): cross-platform bash tool + shell prefix in task prompt

**Agent bash tool** (`src/agent-tools.ts`) now uses `cmd.exe /c` on Windows and `sh -c` on Unix — no longer requires Git Bash / `sh` in PATH on Windows.

**Agent session** (`src/agent-session.ts`): input starting with `!` runs as a shell command in the working directory and its output becomes the new task input (e.g., `!git status`, `!npm test`). Works at both initial and follow-up task prompts.

### feat(agent-session): accumulate multiple `!` shell outputs before task

`src/agent-session.ts:1199–1235,1273–1310` — entering multiple `!cmd` lines accumulates their outputs; only when the user enters a non-`!` prompt are all shell outputs concatenated with the user input as the agent task. Entering nothing after `!` commands skips the turn (agent does nothing).

### feat(tui, dashboard): version display as "(ver <version>)"

`src/tui.ts:1171` and `src/handlers/dashboard.ts:583` — version now shown as `(ver dev)` / `(ver <version>)` instead of bare version string.

### fix(server): dashboard URL uses 127.0.0.1 instead of 0.0.0.0

`src/server.ts:197` — startup log now shows `http://127.0.0.1:7777/dashboard` (correct for local access) while server still binds to `0.0.0.0`.

### fix(dashboard): button text "test model" → "test it"

`src/handlers/dashboard.ts:2437` — composite alias test button renamed for brevity.

### feat(dashboard): elapsed timer during model/alias testing

`src/handlers/dashboard.ts:2653–2693` — test panel shows `Testing <modelId> takes <n>s …` updating every second until completion.

### fix(agent-session): pipe spacing in process log

`src/agent-session.ts:1093` — `results) |(` → `results) | (` for readability.

### feat(tool-judge): dynamic tool relevance filtering via sidecar

Added a **Tool Judge Sidecar** system that evaluates each tool's relevance against the user prompt before forwarding to the upstream. The proxy calls a local HTTP sidecar (`POST {url}/judge`) with the request state and tool list; the sidecar returns a relevance score (0.0–1.0) per tool. Tools scoring below the configured threshold are erased from the request. Fails OPEN — any sidecar error, timeout, or malformed response keeps all tools and logs a warning.

- **Config** — New `[tool_judge_sidecar]` section in `proxy_config.toml` with `url`, `timeout_ms` (default 50ms), `threshold` (default 0.5), `mode` ("choice" per-tool or "noul" batch), `api_key`, `max_batch_tools` (default 50).
- **Integration** — Runs after privacy filter & kompress, before model routing and static blocklist (`src/index.ts:1329–1345`).
- **Protocol** — HTTP/JSON with `state` + `questions` request; `choice` type returns per-tool `keep`/`discard` with probabilities; `noul` type returns batch scores per tool name.
- **Dashboard** — Web dashboard (`/dashboard`) and TUI (`P` overlay) show sidecar status: enabled/disabled, URL, mode, threshold, timeout, max batch.
- **Static blocklist merge** — Sidecar-erased tools are merged with the existing dashboard/TUI manual blocklist (`src/utils/tool-blocklist.ts`).

### fix(cross-platform): replace hardcoded `/tmp` paths with `tmpdir()` and normalize `resolve()` to `join()`

Seven debug log sites across `src/handlers/dashboard.ts`, `src/handlers/messages.ts`,
`src/index.ts`, and `src/tui.ts` wrote to the literal string `/tmp/test_model.log`,
which fails silently on Windows (no such directory). All now use
`join(tmpdir(), 'test_model.log')` so the OS temp directory is resolved correctly
on macOS (`/var/folders/.../T`), Linux (`/tmp`), and Windows (`%TEMP%`).

Three error messages in `src/agent-tools.ts` reported blocking paths outside the
literal string `/tmp/`, but the actual allowed temp root is `TMP_ROOT_RAW` (from
`os.tmpdir()`). Messages now interpolate `${TMP_ROOT_RAW}` so the reported path
matches the enforcement logic on every platform.

Five path-construction sites in `src/agent-session.ts` used `resolve()` with
embedded forward slashes (`'.pi/agent/skills'`, `'.agents/.skill-lock.json'`,
`'.pi/skills'`) where `join()` is the correct API for joining path segments.
Changed to `join()` for consistency with the rest of the codebase and to avoid
the (harmless but misleading) appearance of POSIX-only paths in Windows builds.
One `resolve()` at line 338 was kept for path normalization of user input.

### build(sea): name `build:native` output with the host target triple

`outputName()` in `scripts/build-sea.js` now emits
`model-proxy-v3-<host target triple>` — `-x86_64-apple-darwin`,
`-aarch64-apple-darwin`, `-x86_64-unknown-linux-gnu`,
`-aarch64-unknown-linux-gnu`, `-x86_64-pc-windows-msvc.exe`,
`-aarch64-pc-windows-msvc.exe` — instead of the platform-tagged `-macos-<arch>`
/ `-linux-<arch>` / `-win.exe` names. That is the shape Tauri's `externalBin`
expects on disk (it appends `-<triple>`, plus `.exe` on Windows, to the untagged
entry), so the tray's `stage-sidecar.sh` copies the SEA across with no rename.
Windows ARM is now named `aarch64-pc-windows-msvc` rather than being left
arch-agnostic as `-win.exe`.

### feat(config): resolve the default config path in the working directory or the home directory

When `PROXY_CONFIG_PATH` is unset, the default is no longer the bare relative
`./proxy_config.toml`. `resolveDefaultProxyConfigPath()`
(`src/utils/config-loader.ts`) now returns `./proxy_config.toml` when it exists
(the repo checkout in dev), else `~/.config/model-proxy-v3/proxy_config.toml`,
creating the home directory (`~/.config/model-proxy-v3`) so there is somewhere to
drop a config. Used by both `src/server.ts` and `src/cli.ts`; the RPC and
dashboard paths read `env.PROXY_CONFIG_PATH`, so they inherit it.

This is what lets the Tauri tray spawn the SEA sidecar with no environment
(`docs/design_tauri_tray.md` §7): a GUI app's working directory is not the repo,
so the old relative default read the wrong file or none. A config dropped in
`~/.config/model-proxy-v3/` is now found. The `TEST_CONFIG` override in
`src/server.ts` keeps precedence over this default.

### feat(rpc): add `--rpc` JSON-RPC 2.0 control channel on stdio

`--rpc` starts a newline-delimited JSON-RPC 2.0 server on stdio alongside the
HTTP server, so an external supervisor (the Tauri tray in
`docs/design_tauri_tray.md`) can start, inspect and control the proxy over the
same pipe that carries its process handle — no port to discover and no key to
pass. It is a *mode*, not a CLI command: `src/server.ts` strips it from argv
before `runCli()`, and it is mutually exclusive with `AGENT`/`TUI` (all three
own stdout), failing loud with exit 2 rather than picking a winner.

`src/rpc.ts` is lazily imported from inside the `server.listen` callback, so the
HTTP socket is already bound before the first request is read — a reply to
`status.get` proves the port is live, and no readiness probe is needed. Stdin
EOF calls the existing `shutdown()`, so the proxy cannot outlive the core that
spawned it (an orphan would hold port 8788).

Every method dispatches to a function the proxy already exposes
(`src/handlers/dashboard.ts` and the config loader); the RPC layer adds no new
state. Notifications are **poll-derived** (1 s, emit-on-change) rather than
instrumented into the request path, which is why `src/index.ts` and
`src/utils/dashboard-stats.ts` are untouched: `stats.tick` reads
`getActiveRequestCount()`/`getTokensInWindow()`, and `config.changed` polls the
config file's mtime. The method and notification tables, error codes and
lifecycle are specified in `docs/design_tauri_tray.md` §3.

### fix(server): route proxy diagnostics to stderr

`src/server.ts` now redirects `console.log`/`info`/`debug` to stderr at startup,
so stdout carries only machine-readable output — CLI subcommand payloads
(`src/cli.ts` writes those with `process.stdout.write`) and, in `--rpc` mode, the
NDJSON JSON-RPC control channel (see `docs/design_tauri_tray.md`).

Previously every proxy log level, including `warn` and `error`, went to stdout
via `console.log` in `src/utils/logger.ts`; a single log line on stdout would
have been parsed as a corrupt JSON-RPC frame. Redirecting the methods in one
place covers the direct `console.log/info/debug` call sites in
`src/utils/key-store.ts` and `src/utils/privacy-filter.ts` as well, and any
`console.log` added later. `console.error`/`warn` already wrote to stderr.

`AGENT=true` is covered too, but its task output is unaffected: the streamed
reply deltas and the pi-tui prompts are written with `process.stdout.write`, so
they stay on stdout, while its status/progress lines (the in-place
`printProcessLog` line in `src/agent-session.ts` now writes to stderr) land with
the proxy's logs. Docker is unaffected (`Dockerfile` has no redirection; both
streams go to the container log), as are TUI mode (which overrides these methods
again) and the Cloudflare Workers target (no stdout/stderr split — the logger is
unchanged).

### fix(agent): shorten the model-picker verification prompt

The `AGENT=true` model picker verifies a chosen model with a loopback
`/v1/messages` call before starting the session. It asked
`"hi, which model and agent are right here?"`, but the candidate Agent is built
with the full system prompt and tool set, so the model read that as a real task
and started exploring the working directory instead of answering — slow, and
redundant since the picker line already names the model.

The prompt is now `Reply "ok". Do not use tools.` (`VERIFY_PROMPT` in
`src/agent-session.ts`, shared by the display line and the call so the two can't
drift). The gate is unchanged: a reply is still required and an error still
sends you back to the picker.

### feat(passthrough): `/passthrough/v1/*` verbatim upstream forwarding

New routing mode: a request to `/passthrough/<path>` is forwarded verbatim to a
configured upstream, bypassing model routing, composite selection, schedule,
transforms, privacy filtering, and kompress. The client's path and body are
relayed unchanged; only the auth header is rewritten when the target declares
`key`.

Configured with inline tables under a single `[passthrough]` section (short
field names are canonical; `base_url`/`url`, `api_key`/`key`, `upstream_mode`/
`mode` are accepted as aliases):

```toml
[passthrough]
openai = {base = "https://api.openai.com", mode = "openai-completions", share = 1}
# key = "sk-..."   # optional; overrides the client key upstream
```

Behavior (see `docs/design_passthrough_mode.md`):

- **Endpoint → mode** is a fixed map: `/v1/messages` and
  `/v1/messages/count_tokens` → `anthropic-messages`; `/v1/chat/completions` →
  `openai-completions`; `/v1/responses`, `/v1/responses/input_tokens`,
  `/v1/responses/compact` → `openai-responses`; `/v1/interactions` →
  `gemini-interactions`; `/v1beta/models/*` and `/v1/models/*` with a
  `:generateContent`/`:streamGenerateContent`/`:countTokens` action →
  `gemini-generatecontent`. An unmapped path is a 404.
- **Candidates** are the targets whose `mode` matches, picked by weighted random
  on `share` (default 1) — the weight only applies within a pool, so a `mode`
  with a single target always uses it whatever its `share`. No candidates for
  that mode is a 404.
- **Schema gate**: a body that does not match the mode's required shape is a 400
  (`messages[]` for the completions/messages modes, `input` for responses and
  interactions, `contents[]` for generateContent).
- **URL** is a plain join — `stripTrailingSlash(base) + '/' + path` — so a base
  already ending in a path prefix (e.g. `https://gw.example.com/anthropic`)
  composes as written and the client path is never rewritten.
- **Retained**: the global client-key presence check, the `auth_server` gate,
  logging, upstream status recording, per-target `timeout`, and usage recording
  (streaming and non-streaming) keyed on the body's `model` (or `unknown` when
  the body carries none). `[remote].record_server` receives the same payload as
  the normal routes. `[general] global_token_limit` is also enforced — it runs
  before dispatch, so a passthrough request is refused once the window limit is
  reached. Endpoint stats include `/passthrough/v1/*` in both the request-count
  and the timing tables (min/avg/max), recorded on the request path like the
  normal routes — time-to-first-byte for SSE.
- **Credential**: `target.key` wins when set, otherwise the caller's key is used.
  Either way the credential is re-emitted in the header the mode actually reads —
  `x-api-key` (`anthropic-messages`), `x-goog-api-key` (Gemini), or
  `Authorization: Bearer` (OpenAI) — and the other credential headers are dropped,
  so an upstream never receives two credentials and an `anthropic-messages`
  upstream gets `x-api-key` rather than a Bearer token it would ignore.
  Non-credential headers (e.g. `anthropic-beta`) are forwarded unchanged.
- **NOT applied — local token counting**: `LOCAL_TIKTOKEN` and the native
  `count_tokens` handler do not run for passthrough requests.
  `/passthrough/v1/messages/count_tokens` is forwarded verbatim to the upstream,
  so the returned count is the upstream's, never a local tiktoken estimate.
- **Streaming usage caveat**: the request body is forwarded byte-for-byte, so the
  proxy never injects `stream_options.include_usage`. For an `openai-completions`
  SSE stream whose request omits it, the upstream usually drops the final usage
  chunk and no tokens are counted — a warning is logged per such request.
  `anthropic-messages` / `openai-responses` / Gemini streams carry usage natively
  and are unaffected.
- **SSRF**: `[passthrough]` target `base` hosts are added to the shared
  `getAllowedHostsFromConfig` allowlist, the same list `[models.*].base_url`
  hosts feed — so they also become reachable through the existing
  `/http/<host>/…` dynamic route (design doc §11.13).
- **Key store**: `[passthrough]` target `key`s are covered by
  `[general] store_key_in_system`, like `[models.*]` api_keys. Since a
  passthrough target has no model id, its keychain account is
  `passthrough.<name>/<base>`.

Integration suite `tests/integration/18_passthrough/` (TC5101–TC5111) covers the
mode mapping, usage-counted-once behavior, 404/400 gates, and the plain-join URL.

### fix(config): short field names in a `[models.*]` section are now a reported error

A `[models.<category>]` section takes only the long field names (`upstream_mode`,
`base_url`, `api_key`); the short aliases (`mode`, `url`, `key`) belong to inline
entries and `[passthrough]` targets. Writing a short alias at section level used to
drop the key silently — the target lost its base_url/mode/key with no message. It is
now reported as a config error (TUI/dashboard status and console), naming the long
form to use. Inline entries keep accepting both forms.

### fix(stats): native Anthropic responses were counted twice

Token usage for `/v1/messages` against an `anthropic-messages` upstream was
recorded twice, so the dashboard, the TUI, and `[remote].record_server` all saw
2× the real token counts for that path.

`src/handlers/claude.ts` recorded usage itself — it teed the SSE body and piped
one branch through `createUsageTrackingTransformStream(accountingModel)`, and on
the non-streaming branch it parsed a clone and called `recordModelUsage` /
`recordUpstreamResponseToolNames` directly. But `src/index.ts` wraps *every* 2xx
response after the handler returns: `text/event-stream` bodies get the same
tracker, `application/json` bodies get `extractUsageFromResponsePayload` →
`recordModelUsage`. `recordModelUsage` accumulates with no dedup, so both
recorders fired for the same bytes and the same model id. The handler-local
recorder predates the centralized block in `index.ts` and was left behind when
it was added.

`claude.ts` now returns the upstream body untouched and does no usage or tool
recording — `index.ts` already covers it, and covers more: composite-alias
windows, the remote `record_server` call, `record_response_body`, and tool names
attributed to the calling agent (the handler-local copy dropped that
attribution). The one behavior change: when `attemptModelId` is undefined the
handler's `requestBody.model` fallback used to record local token stats, and that
degenerate path now records none. `attemptModelId` is always set for
`/v1/messages` in practice (`route.modelAlias || candidateName`).

New suite `tests/integration/17_token_counting/` (TC4101–TC4105) guards this.
Each case sums `total_tokens` across all rows of `GET
/dashboard/api/stats/models` before and after one request and requires the delta
to equal the usage the client was told about — exactly once, so a 2× delta
fails. It covers non-streaming and streaming `/v1/messages`,
`/v1/chat/completions` (including the force-injected
`stream_options.include_usage` chunk), and Gemini `:streamGenerateContent?alt=sse`.
Candidates are discovered from the live config per upstream mode, so the suite is
not tied to particular model ids; unusable candidates print `(skipped: ...)`.
Verified by restoring the old tee: TC4102 fails with `delta 50 != 25 (2x)`, and
passes with the fix.

### feat(cli): `--export-openclaw-providers`

The CLI gained `--export-openclaw-providers`, which prints the `models.providers`
block for an OpenClaw config (`~/.openclaw/openclaw.json`) — a single provider
(`model-proxy-v3`, the same id `--export-pi-models` uses) holding one entry per
configured target model and alias, each pointed at this proxy's loopback origin.
Like `--export-pi-models` it prints to stdout and writes nothing, so the output
can be merged into an existing config by hand; `models.mode` is `merge`, so
importing it does not drop OpenClaw's other providers. The provider declares
`api: 'anthropic-messages'` and `auth: 'api-key'`, and its `apiKey` is the same
dummy `sk-hi` — the proxy's client auth is a presence check, and configured
target `api_key` values are never emitted. Model entries carry
`id`/`name`/`reasoning`/`input`/`cost`/`contextWindow`/`maxTokens` from the
shared `buildProxyPiModel`, inheriting `api` and `baseUrl` from the provider.

The previously unreferenced `OpenClaw*` interfaces in `config-loader.ts` were
also corrected to the real schema: `models.providers` is an object keyed by
provider id (not an array), the api field is `api` (not `apiSchema`), and the
provider block carries `auth`.

### fix(build): `build:native` fails fast on a Node that cannot host SEA

`npm run build:native` on Homebrew Node 26.4.0 died at the blob step with a bare
`Error: Command failed: .../node --experimental-sea-config ...` wrapping "Single
executable application is disabled." — after the typecheck and the esbuild
bundle had already run, and without naming either of the two real causes. That
bottle is built with SEA compiled out (`single_executable_application=false`)
*and* is a shared-library build (`node_shared=true`: a ~37KB launcher plus
`libnode.147.dylib`), so it can neither generate a blob nor have one injected
into it — the fuse lives in the dylib, not in the launcher this script patches.

`scripts/build-sea.js` now runs `assertSeaCapableHost()` before anything else,
checking both flags and reporting every problem it finds plus the fix: build
with an official, self-contained Node (nodejs.org, nvm, `actions/setup-node`),
or, without touching the system Node, `npx --yes --package=node@26 node
scripts/build-sea.js`. The header comment is corrected to match — it previously
offered binary size as the test and claimed `--experimental-sea-config` "passes
on the unusable stub", which stopped being true on Node 26.

The native build was previously undocumented outside this changelog; README now
has a **Deployment → Native single-file binary** section giving `npm run
build:native` and the `npx` backup above.

### feat(cli): config inspection subcommands on the server entrypoint

`dist/server.js` now parses its own argv (`src/cli.ts`) before listening: with no
arguments it starts the HTTP server exactly as before, and with `--list-models
[--json]`, `--validate-config`, `--export-pi-models`, or `--help`/`-h` it runs that
command and exits. This gives a way to check what a config file actually
resolves to (targets, composite/schedule aliases, inherited `base_url`/`mode`)
without booting the proxy or opening the dashboard, and to feed the configured
aliases to a pi-agent-core session as `Model` objects.

`--export-pi-models` emits the `~/.pi/agent/models.json` file shape — a single
`providers` entry (`model-proxy-v3`) holding one pi-ai `Model` per target model
and alias — so its output can be merged straight into that file. The provider's
`apiKey` is the dummy `sk-hi`: the proxy's client auth is a presence check, and
configured target `api_key` values are never emitted.

It also carries the `defaultProvider`/`defaultModel` pair pi keeps in
`~/.pi/agent/settings.json`, so one command covers both files. `--default-model
<id>` picks the default (must be a configured model or alias — otherwise a usage
error); when omitted it falls back to the first configured model.

The commands read the local TOML only (`$PROXY_CONFIG_PATH`, default
`./proxy_config.toml`) — Consul/Apollo remote sources are deliberately not
consulted. `--list-models` reuses `toDashboardConfigPayload`, so `--json` is the
same sanitized shape the dashboard serves with `api_key` values stripped; its
table lists each composite/schedule alias target on its own line (long target
lists were unreadable comma-joined into one cell), with a space before each
target's attribute list (`grok46 (share=10)`), and prints no dash rule under
the headers, keeping `MODE` as the last column of the target-models table;
`--validate-config` reuses the parser's own validation (`parseSimpleToml` logs each
finding and records the arrays) rather than running a second set of checks.

To keep the CLI off the production dependency graph, the pi-ai `Model` builder
moved to `src/utils/pi-model-catalog.ts` (dependency-free) — `pi-ai` is a
devDependency not shipped in the image, so `agent-session.ts`'s `buildSelfModel`
now delegates to it, and the shared provider id lives there too instead of being
duplicated. The shared builder's default `input` is now `['text']` (previously
`['text', 'image']`), so both the export and the agent session declare
text-only input; its `reasoning` is now `true` (previously `false`), so pi
treats the proxy's aliases as reasoning-capable in the exported models file and
in agent sessions alike.

Exit codes: `0` success / `1` command failed (unreadable or invalid config) /
`2` usage error. Covered by `tests/unit/cli.test.ts`.

### fix(agent): pass a `Context` to `loadSkills()` after the pi-agent-core 0.85 bump

`@earendil-works/pi-agent-core` moved from `^0.81.1` to `^0.85.1`, and in that
range `loadSkills()` grew a third parameter: `loadSkills(env, dirs, context)`.
The context is a `@earendil-works/chord` `Context`, threaded into every
`ExecutionEnv` call the loader makes (`fileInfo`, `listDir`, `readTextFile`, …)
so directory walks can be cancelled and attributed to a telemetry parent. The
build failed with `TS2554: Expected 3 arguments, but got 2` at all three call
sites.

Each site now passes `BACKGROUND_CONTEXT` — the shared non-cancellable root
context, which is what these loads are: they run outside any request/session
scope (skill discovery at startup and the `add_skill` tool's post-install
re-read), so there is no parent context to derive from and nothing to cancel.

### fix(build): quote cmd.exe words so `build:native` runs on Windows

`npm run build:native` failed on Windows before it reached SEA. `run()`
(`scripts/build-sea.js`) uses `shell: true` on Windows because `npx` there is
`npx.cmd`, and `execFileSync` with a shell joins the command and argv with plain
spaces and escapes nothing — so cmd re-split every word on whitespace before the
child saw it. The esbuild banner (`--banner:js=const __SEA_IMPORT_META_URL__ =
...`) was the first casualty: esbuild received the fragments as extra positional
inputs and rejected the build with "Must use outdir when there are multiple
input files". The next step failed the same way with `process.execPath` —
`C:\Program Files\nodejs\node.exe` — which cmd truncated to `C:\Program` ("is
not recognized as an internal or external command").

The fix adds `quoteForCmd`, applied to the command and every argument when a
shell is used: words containing whitespace or a cmd control character
(`&|<>^()`) are wrapped in double quotes, which cmd strips before exec while
preserving the inner text (the banner's single quotes survive). Bare words are
left untouched so POSIX argv is unchanged and a path ending in a backslash is
not mis-parsed as an escaped quote. A word containing a literal double quote —
which no argument here does — fails loud rather than mis-quote.

### feat(build): the win32 single-executable build stores keys in its own file body

`store_key_in_system = true` now works inside the **win32** SEA binary.
`@github/keytar` needs too many dependencies on Windows (Visual Studio Build Tools
with the C++ workload + Python 3, via node-gyp) to be worth carrying into
a self-contained single-file distribution, so the win32 build substitutes an
in-binary store there: `loadKeytar`'s failure falls through to
`tryBodyKeyStore()` (`src/utils/body-key-store.ts`), which returns a
`KeytarLike` (`src/utils/key-store.ts:37-42`, unchanged) whose backing store is
the executable's own file body (`process.execPath`): each `setPassword` appends
one `{service, account, password}` record at EOF via `src/utils/body-record.ts`,
and reads walk the record chain backwards, newest-per-account winning. macOS and
Linux are unchanged — they keep the OS keychain via `@github/keytar` — and
Docker, Workers, and macOS/Linux SEA binaries keep the fatal `KeyStoreError`.
The record format (`$ReCorDeR` tail, CRC32, backwards-linked list) is the one from
`store-in-body`, ported path-parameterized; CRC32 is a local table
implementation rather than `node:zlib`'s, which would add a `>=20.15` floor the
Workers/`nodejs_compat` module graph should not inherit.

The gate (`tryBodyKeyStore`) is deliberately narrow — `process.platform ===
'win32'`, a real SEA binary (`node:sea` `isSea()`, imported through a
non-literal specifier like the existing `KEYTAR_MODULE` so no bundler resolves
it statically), and an `execPath` basename that is not `node`/`node.exe`. Any
gate failing returns `null` and the caller keeps its existing fatal error, so
the body store can never be pointed at a plain Node install.

Appending to a **running** `.exe` is not the reference's single rename: a
Windows image cannot be renamed-over by name while mapped. So `appendRecord`
tries the cheap path first — open `self` `'r+'` and append at EOF with no copy
of the ~110 MB binary — and only if Windows denies that open falls back to
copy → append → `rename(self → self.<uniq>.old)` → `rename(tmp → self)`, with
the leftover `.old` swept on the next start and a restore-from-`.old` if the
swap half-completes. The `.old` name is unique per append because a fixed name
is un-renamable-over (the first `.old` is the still-mapped original).

**Security: the records are plaintext inside the `.exe`.** That is not secrecy
— anyone who can read the binary can read the keys — the gain is a
self-contained single-file distribution whose keys travel with the binary
instead of sitting in `proxy_config.toml`. It is a downgrade from an OS
keychain, needs a writable directory beside the executable, and is wiped by a
rebuild (a fresh blob is injected into a fresh copy of `node`). Documented in
[README.md](./README.md) and
[docs/configuration-reference.md](./docs/configuration-reference.md); the
`scripts/build-sea.js` banner and `EXTERNALS` comment now say win32 is
supported rather than fatal.

New tests: `tests/unit/body-record.test.ts` (round-trip, oldest→newest order,
link chain, CRC-corruption stopping the walk, non-linking to a foreign tail,
the swap flow end-to-end, stale-swap sweep) and
`tests/unit/body-key-store.test.ts` (set/get, miss → `null`,
last-write-wins, `findCredentials` latest-per-account service-filtered,
malformed record throwing loud, and the non-win32 gate returning `null`). The
Windows *semantics* — which tier engages, and a read-only directory failing
loud — still need a real Windows host; that is called out in the plan.

### feat(remote): send `version` on the stats usage record

The proxy now sends a `version` field on every `ModelUsageRecordPayload` POSTed
to `[remote] record_server`. `src/utils/model-usage-recorder.ts` gains a
`PROTOCOL_VERSION = 'v1'` constant, set as `version` in
`buildModelUsageRecordPayload` — a fixed proxy constant, sent on every record
regardless of the auth response (the proxy does not echo the auth service's
advertised era). The stats service does not validate it: the POST is
fire-and-forget and the proxy still reads only `response.ok`.

The stats **response** body carries no `version`: only the auth `200` body
advertises the contract era. `tests/scripts/mock-auth-stats-server.js` answers
`/v1/model-usage` with `{ "ok": true }` (was `{ "version": "v1", "ok": true }`)
and now logs the received `version` from each record; `PROTOCOL_VERSION` remains
on the `/v1/validate` response. [docs/architecture/auth-stats-protocol.md](docs/architecture/auth-stats-protocol.md)
documents the auth `200` example body (`version` + a two-rung `targets[]`
ladder) and the `ModelUsageRecordPayload` `version` field.

### feat(remote): require `version` on the auth `200` response

The auth service's `200` body **must** now carry a non-empty string `version`
(the bundled sidecar sends `"v1"`). A `200` whose body is missing `version`, is
not a JSON object, or carries a blank/non-string value is rejected with `401`
before any routing — a service that does not speak the versioned contract fails
loudly instead of being silently trusted (previously the field was advisory and
ignored). The check is a *presence* check; `"v1"` is the current contract era.
The stats `POST` is fire-and-forget and its response never gates the client, so
its `version` field remains unenforced. New helper
`hasRequiredProtocolVersion` in `src/utils/target-retry.ts`; the gate lives in
`src/index.ts` (401 on failure).

### test(mock): `/v1/` route prefix, `version` field, ladder externalized to mock_targets.json

`tests/scripts/mock-auth-stats-server.js` now serves `/v1/validate` and
`/v1/model-usage` (was `/validate` / `/model-usage`), and both `200` responses
carry a `version` body field (`PROTOCOL_VERSION = "v1"`) advertising the
wire-contract era. The auth ladder moved out of the source into
`tests/scripts/mock_targets.json`, which the server reads at startup (fails loud
if missing or invalid); `MOCK_TARGETS_JSON` still overrides it inline. The
`version` field is required by the proxy (see the entry above); see
[docs/architecture/auth-stats-protocol.md](docs/architecture/auth-stats-protocol.md).

### change(remote): raise the default `[remote] max_targets` ladder cap from 4 to 16

The auth `targets[]` failover ladder's default attempt bound is now `16` (was
`4`). The knob itself is unchanged — an explicit `[remote] max_targets` still
overrides the default, and entries are still deduped then truncated to the cap.

### feat(remote): per-rung `retry` override on the auth `targets[]` ladder

An auth `targets[]` descriptor may now carry a `retry` (non-negative integer)
field that overrides `[remote] max_target_retries` for that rung only, falling
back to the config default when absent — so one ladder may mix a rung that
retries twice with rungs that retry once (or not at all, `retry: 0`). `retry_on`
still gates which statuses trigger a same-rung retry; `retry` only sets the
count. The per-rung `timeout` field is unchanged (milliseconds). The mock auth
sidecar's default ladder now emits `timeout: 10000, retry: 1`.

### test(mock): auth sidecar validates the client key, then selects rungs by alias

`tests/scripts/mock-auth-stats-server.js` `/validate` now models the real auth
contract end-to-end:

- It reads the CLIENT's original key (the one the proxy forwards under
  `auth_passthrough_with = "user_key"`) from `x-api-key`, then a Bearer
  `Authorization`, then `x-goog-api-key`, and checks it against a
  `MOCK_USER_KEYS` allowlist (comma-separated, default `sk-test`). A key
  matching none — or none presented — is rejected with `401`.
- On a valid key it returns the configured ladder filtered by alias: only rungs
  whose `alias` equals the request body's `model` are served; no match (or no
  model) yields `{ targets: [] }`, so the proxy falls back to normal config
  resolution.

### fix(remote): drop host allowlist for auth-ladder rungs; replace `section:'free'` hack

The auth `targets[]` failover ladder no longer validates a rung's `base` host
against the config host allowlist. The auth server is a trusted routing
authority and a descriptor is self-contained, so its destination need not appear
as a configured model `base_url`; previously such rungs were silently dropped
(`base host '…' is not allowed`). Only the `base` URL **syntax** is still checked.

- `src/utils/target-retry.ts` — `validateEntry` drops the `isHostAllowed` check
  (keeps `new URL` well-formedness). The unused `DescriptorValidationOptions`
  interface (and its `allowedHostsEnv` / `defaultMode` fields), the
  `validateDescriptorEntries` `opts` parameter, and the now-unused
  `isHostAllowed` import are removed. Call site `src/index.ts` updated to
  `validateDescriptorEntries(rawTargets)`.
- `descriptorToRoute` no longer sets `section: 'free'` to force a rung's key
  upstream. It sets a new `ModelRouteConfig.explicitApiKey` flag instead, and
  `buildRouteAttempt` (`src/index.ts`) applies the key when
  `route.explicitApiKey` is set — removing the abuse of the unrelated
  `[models.free]` section semantics.
- `README.md` and the `tests/scripts/mock-auth-stats-server.js` docblock/banner
  updated to state rung hosts are not allowlist-checked. Tests updated: unit
  allowlist tests now assert any well-formed host is accepted; new integration
  case **TC4010** covers a non-config, non-loopback rung host.

### fix(dashboard): single shared `UPSTREAM_MODES` list (adds `gemini-interactions`)

`gemini-interactions` was already a valid `upstream_mode` at runtime (the
failover ladder accepted it) but two authoring lists omitted it, so the dashboard
model-target wizard could not offer it and `upsertModelTarget` rejected it as an
invalid mode. The upstream-mode list was also duplicated across several modules
that had drifted out of sync.

- New `src/utils/upstream-modes.ts` exports the single `UPSTREAM_MODES` constant
  (and `UpstreamMode` type) — the authoritative order is `openai-completions`
  first, which is also the wizard's default new-target mode.
- `src/utils/config-loader.ts`: the local `MODEL_TARGET_UPSTREAM_MODES` const is
  removed; `upsertModelTarget` validates against `UPSTREAM_MODES`. (Its old type
  was `TransformSchema[]` — the wrong type: this is an upstream-mode whitelist,
  not a transform-set schema, and `gemini-interactions` has no `SCHEMA_PATHS`
  entry.)
- `src/utils/target-retry.ts`: the local `KNOWN_MODES`/`KnownMode` are removed in
  favour of `UPSTREAM_MODES`.
- `src/handlers/dashboard.ts`: the wizard's `MODES`, the category-level
  `upstreamModeSelect`, and the per-model `perModelModeSelect` now interpolate
  `UPSTREAM_MODES` via `JSON.stringify`, so the embedded client script cannot
  drift from the server list again.
- `upsertModelTarget` unit test and the TC720 comment updated to the five-mode set.

### feat(remote): flat `[remote]` config table + auth `targets[]` failover ladder

The `[remote]` config is now a **single flat table** (breaking — see below), and
the auth service's `200` response body may carry a `targets[]` **failover
ladder** that the proxy walks before falling back to config-file model
resolution.

**Breaking config rename.** The nested `[remote.authentication]` and
`[remote.recording]` subsections are **removed**; their fields move to the flat
`[remote]` table under role-prefixed keys (`auth_*`, `record_*`). There is no
dual-parse — a config still using a nested subsection triggers a `console.warn`
naming the flat replacement, and its fields are no longer read.

```toml
[remote]
auth_server           = "https://auth.example.com/validate"
auth_with_model       = false
auth_with_body        = false
auth_passthrough_with = "user_key"
max_targets           = 4        # cap on the targets[] ladder attempts
max_target_retries    = 1        # per-descriptor retry_on re-hits (0 disables)
record_server         = "http://127.0.0.1:8080/model-usage"
record_response_body  = false
```

- **auth `targets[]` failover ladder**: when the auth `200` body carries a
  `targets` array, each entry is a **self-contained descriptor** (`target` +
  `base` required; `mode` / `key` / `otac` / `transforms` / `timeout` /
  `retry_on` optional) and the proxy owns routing for that request — skipping
  `[models.*]` / `[composite]` / `[schedule]` resolution.
- **A rung's `key` replaces the caller's credential**: a non-empty descriptor
  `key` is sent upstream in place of the caller's key (it overwrites the mode's
  auth header, not adds to it) and needs no `auth_passthrough_with = "config_key"`
  opt-in; an entry without a `key` still forwards the caller's credential, so a
  ladder may mix server-pinned and caller-supplied keys. Documented as a Notice
  in `README.md` and `docs/architecture/auth-stats-protocol.md`.
- **Two retry axes**: axis 1 advances the ladder on `429` / any `5xx` / transport
  (→`502`) / abort-timeout (→`504`), bounded by `max_targets`; a deterministic
  `4xx` is terminal. Axis 2 re-hits the same rung per a descriptor's `retry_on`,
  bounded by `max_target_retries`. An invalid entry is dropped (logged) and the
  ladder continues — including when it is `targets[0]`; if all entries are
  invalid (or the body is empty / not-JSON / not-`200`), normal config
  resolution runs.
- **dispatch keys reserved**: `dispatch_server`, `max_dispatches`,
  `dispatch_timeout_ms`, `buffer_non_sse` are parsed but **not yet implemented**
  (the on-failure dispatch path is deferred).
- New `src/utils/target-retry.ts` (descriptor parsing / validation / capping)
  with unit tests; `tests/integration/16_security/target_retry_ladder.test.js`
  covers failover, terminal-4xx, same-target `retry_on`, and the composite
  short-circuit.

### fix(responses): shorten flattened namespace tool names over the 64-char `function.name` limit

Follow-up to the prefixed-name flattening entry below. Chat Completions (and
Anthropic/Gemini) cap `function.name` at 64 chars in addition to the
`[a-zA-Z0-9_-]` charset, so a `<namespace>_Z_<tool>` flattened name built from
long namespace and tool names would be rejected by the upstream.

- `flattenNamespaces` now shortens any flattened name longer than 64 chars to a
  readable truncated head plus a per-request monotonic counter (e.g.
  `<head>_1`), which keeps the name identifiable while guaranteeing distinct
  long names never collide.
- The namespace map is generalized from `Map<flatName, namespacePath>` to
  `Map<flatName, { name, namespace? }>` (exported `NamespaceMap` /
  `NamespaceMapEntry`), so the original bare `name` is recovered by a single
  map lookup rather than by slicing the namespace prefix off the (possibly
  shortened) flat name. Both reverse sites
  (`convertCompletionsToResponses` and the `splitNamespace` helper in
  `streamCompletionsAsResponses`) use the lookup.
- `tests/unit/responses-completions-roundtrip.test.ts`: map-shape assertions
  updated, plus a new test that an over-64 flattened name shortens to exactly
  64 chars and round-trips to the original `name`/`namespace`.

### fix(responses): prefix flattened namespace tool names and restore the `name`/`namespace` split on `function_call` output items

Follow-up to the namespace flattening in "fix(responses): flatten
`namespace`-wrapped tools..." below. That entry discarded the namespace name
entirely, which caused two problems: (1) two namespaces containing a tool with
the same bare name flattened to duplicate keys in the Chat Completions
`tools[]` array, and (2) when the upstream called a flattened tool, the
resulting `function_call` output item carried only the bare `name` with no
`namespace`, so the client couldn't tell which namespace produced the call —
even though the Responses API spec gives `function_call` a separate optional
`namespace: string` field alongside `name` (`docs/openai-response-final.md`).

- **Flatten with prefixed names**: `flattenNamespaces` now renames each leaf
  tool to `<namespace>_Z_<tool>`, nesting joined with `_Z_` at every level
  (e.g. `outer_Z_nested_Z_deep_fn`), fixing collisions and preserving enough
  information to reverse the mapping. The separator is a shared
  `NAMESPACE_SEPARATOR` const, default `_Z_` and overridable via the
  `NAMESPACE_SEPARATOR` env var (read once at module load), rather than a
  bare `_` so the namespace/tool boundary stays visually distinct from single
  underscores inside namespace names (e.g. `mcp__cua_repl`). The value must
  match `/^[a-zA-Z0-9_-]+$/` (the `function.name` charset) — an out-of-charset
  value throws at startup instead of silently producing tool names the
  upstream rejects. It builds a
  `Map<flatName, namespacePath>` (path joined with `.`, e.g. `outer.nested`)
  as a side output.
- **Thread the map to the response side**: the map is attached to the returned
  `OpenAIRequest` as a non-enumerable `__namespaceMap` property (via
  `Object.defineProperty`) so the return type stays `OpenAIRequest` — existing
  call sites, `JSON.stringify` round-trips, and deep-equality assertions are
  unaffected. `getNamespaceMap(request)` reads it back.
  `convertCompletionsToResponses` / `convertCompletionsToCompactedResponse` /
  `streamCompletionsAsResponses` accept the map as an optional param; when a
  tool call's `name` is a key in the map, the emitted `function_call` item gets
  the bare tool `name` and the original `namespace` path. Unmapped (plain
  top-level) tools are emitted unchanged — fully backward-compatible.

- `src/converters/responses-to-completions.ts`: prefixed-name flattening,
  `NAMESPACE_MAP_KEY` / `getNamespaceMap` export.
- `src/converters/completions-to-responses.ts`: optional `namespaceMap` param,
  `namespace?: string` on the output item type, split restore in the
  `function_call` build.
- `src/handlers/responses.ts`: thread the map through `handleAsCompletions`
  (stream + non-stream) and `handleResponsesCompactRequest`; `splitNamespace`
  helper in `streamCompletionsAsResponses` applied at the
  `output_item.added` / `output_item.done` / `response.completed` emission
  points.
- `tests/unit/responses-completions-roundtrip.test.ts`: prefixed-name +
  `namespaceMap` assertions, a namespaced round-trip test, a
  non-namespaced-passthrough test.

### fix(responses): default a missing input item `type` to `"message"` instead of dropping it

Per the Responses API spec, `type` on an input item is optional and defaults
to `"message"` when the item carries `role`/`content` (`EasyInputMessage` /
`Message` in `docs/openai-response-methods-create.md`). The converter used to
treat a typeless item as unrecognized — silently excluded from the assistant-
turn merge and hit the `warnUnhandledItem` fallback in
`convertInputItemToMessages`, dropping the message's content from the
upstream conversation. `convertInputItemsToMessages` in
`src/converters/responses-to-completions.ts` now normalizes `item.type` to
`'message'` up front when it's `undefined` but `role`/`content` are present,
before either the assistant-turn merge or per-item conversion branch on it.
Affects all three conversion paths (`openai-completions`,
`anthropic-messages`, `gemini`); passthrough to an `openai-responses`
upstream is untouched since the body is forwarded as-is.

### test(agent-tools): quote a spliced tmp-path in the /tmp/ rm test; skip the signal-kill test on win32

Two follow-on test fixes after switching the bash tool's shell to bare `'sh'`
(previous entry):

- "allows rm on a path under the real /tmp/ tree" spliced `tmpdir()`'s
  Windows-native backslash path unquoted into the command string
  (`` `rm ${tmpFile}` ``). On win32 the command runs under Git Bash's
  `sh -c`, which treats an unquoted backslash as its own shell escape
  character and strips it, so `rm` received a mangled path and silently did
  nothing — the file survived and the assertion failed. Fixed by
  single-quoting the path (`` `rm '${tmpFile}'` ``), which is what a real
  shell-safe command would do regardless of platform — not a
  Windows-specific workaround. Every other test in this file that splices an
  absolute path into a command is wrapped in `assert.rejects()`, where the
  path-escape check rejects the command from its raw string before it ever
  reaches `sh -c` — so backslash-mangling never mattered for those; this is
  the one test where the command is expected to actually execute.
- "does not misreport an externally-signaled kill as a timeout" relies on
  `kill -TERM $$` delivering a real POSIX signal that `execFile` surfaces via
  `error.signal`. Git Bash/MSYS2's `sh` doesn't do that: `error.signal` stays
  `null` and `error.code` comes back as an MSYS2-specific numeric encoding,
  so the command resolves instead of rejecting. This is a platform capability
  gap in Git Bash's signal emulation, not a bash-tool bug, so the test is
  skipped on `win32` via `t.skip(...)` with the reason recorded instead of
  being weakened or deleted.

### fix(agent-tools): bash tool hardcoded `/bin/sh`, which doesn't resolve via `execFile` on Windows

`execFile` calls the OS spawn API directly — it doesn't go through any
shell's own path translation, so an absolute POSIX path like `/bin/sh` isn't
valid on Windows even with Git Bash installed, and the spawn fails with
`ENOENT` before the command ever runs (surfaced honestly as of the previous
fix below, instead of silently misreporting success).

- `src/agent-tools.ts`: changed the bash tool's `execFile('/bin/sh', ...)` to
  `execFile('sh', ...)`, resolving the executable via `PATH` instead. `sh` is
  always present on Unix and, on Windows, resolves to Git for Windows'
  `sh.exe` when installed — this file already assumes POSIX shell syntax
  throughout (see the rm/mv denylist patterns), so relying on a POSIX shell
  being on `PATH` isn't a new dependency, just no longer hardcoded to a
  POSIX-only absolute path. (Deliberately not `'bash'`: Windows ships a WSL
  `bash.exe` shim in `System32` with no `sh.exe` equivalent, which could
  shadow Git Bash's `bash.exe` depending on `PATH` order — `'sh'` has no such
  ambiguity.)
- Fixes 5 of the 7 tests in `tests/unit/agent-tools.test.ts` that were still
  failing after the fail-loud fix below.

### fix(agent-tools): bash tool silently "succeeded" on a spawn failure instead of failing loud

The `bash` tool's `execFile` callback only rejected the promise when it
detected a timeout or a signal kill; any other `error` (e.g. the child
process failing to spawn at all) fell through to
`resolvePromise({ stdout, stderr, code: child.exitCode })` — reporting
success with whatever nonsense `child.exitCode` held, rather than surfacing
the real failure (Rule 8: fail loud, never swallow errors).

Concretely: on a machine where the hardcoded `/bin/sh` executable can't be
spawned (`ENOENT`), Node sets `child.exitCode` to the *negative libuv errno*
(`-4058` for `ENOENT`) instead of `null`, and the old code returned that as
if it were a real command exit code — so every `bash` call silently reported
`exit code: -4058` and empty stdout instead of erroring, and any test
asserting "does not reject" on a normal command passed for the wrong reason.

- `src/agent-tools.ts`: the callback now distinguishes a real exit (execFile
  sets `error.code` to the *numeric* exit code, matching `child.exitCode`)
  from a spawn failure (`error.code` is an errno *string* like `'ENOENT'`,
  `child.exitCode` is a negative libuv number) — `typeof error.code ===
  'string'` now rejects with a clear `Failed to run command: <message>`
  instead of resolving.
- This is a general correctness fix (any spawn failure on any platform —
  bad executable, `EACCES`, etc. — now surfaces honestly), not specific to
  the `/bin/sh` case. Whether/how to make the bash tool's shell executable
  itself resolve on Windows is a separate, not-yet-decided question — see
  the now-honest failures in `tests/unit/agent-tools.test.ts` ("bash —
  normal execution", "bash — Section 12 rm/mv path confinement", "bash —
  timeout vs. non-timeout kill") for the current state on a Windows
  machine where `/bin/sh` doesn't resolve via `execFile`.

### test(agent-tools): skip symlink-escape tests when the OS won't allow creating symlinks

Three `write_file`/`read_file` path-confinement tests create a symlink
(`fs.symlinkSync`) to prove the escape-via-symlink case is actually blocked.
On Windows, `symlinkSync` throws `EPERM: operation not permitted` for a
non-elevated user without Developer Mode enabled — an OS privilege gate, not
a bug in `src/agent-tools.ts` or the tests. This left the tests failing (not
skipping) with a misleading `EPERM`, on any Windows machine without that
privilege.

- `tests/unit/agent-tools.test.ts`: added a `CAN_SYMLINK` capability probe
  (create+delete one throwaway symlink at module load) and each of the three
  symlink-based tests now calls `t.skip(...)` with a clear reason and
  returns early when the probe failed, instead of calling `symlinkSync` and
  failing on the resulting `EPERM`.
- No change to `src/agent-tools.ts` — the path-confinement logic under test
  is unaffected; only test *setup* (symlink creation) needed the guard.
- To actually exercise these tests locally on Windows: enable Developer Mode
  (Settings → Privacy & security → For developers) or run the test command
  elevated.

### fix(agent-session): disable pi-scoped skill loading on win32 (upstream `ignore` crash)

`gatherSkillCandidates` (agent-session skills picker) crashed on Windows for
any skills directory containing real files, not just malformed-lock-file edge
cases — `RangeError: path should be a path.relative()d string` from the
`ignore` package.

Root cause is upstream, in `@earendil-works/pi-agent-core`'s `loadSkills()`:
its `NodeExecutionEnv` resolves paths with `node:path` (backslashes on
win32), then `skills.js`'s internal `relativeEnvPath()` strips the root
prefix via naive `"/"`-string slicing instead of `path.relative()` — on
win32 that never matches, so a raw absolute Windows path gets passed to
`ignore().ignores(...)`, which throws.

- `src/agent-session.ts`: `gatherSkillCandidates` now skips the `loadSkills()`
  call on `process.platform === 'win32'` (logs why via the existing
  `[skills]` diagnostic line) and returns no pi-scoped candidates on that
  platform. Lock-file-based other-agent candidates (`gatherOtherAgentCandidates`)
  don't go through `loadSkills()` and are unaffected.
- `tests/unit/agent-session.test.ts`: tests that load a real pi-scoped skill
  now branch on `IS_WIN32` and assert the disabled-on-win32 behavior on that
  platform, and the real-loading behavior elsewhere.
- Tracked upstream against `@earendil-works/pi-agent-core`; revisit once
  fixed there.

### fix(config): one unresolvable `STORE_KEY_IN_SYSTEM` sentinel no longer blocks startup

Previously, if any single `api_key` sentinel could not be resolved from the OS
keychain (no exact account and no best-effort base_url match), `applySystemKeyStore`
threw a fatal `KeyStoreError` that aborted the entire config load — so one missing
key stopped *every* model from loading and the proxy from starting (and, in TUI
mode, left the screen stuck on "Loading…"; see the next entry).

An unresolvable sentinel now skips just that slot instead of failing everything
(Rule 8: fail loud, not fail-everything):

- `src/utils/key-store.ts`: the resolve pass clears the offending slot to `''`
  (identical to "not configured" — every consumer falls back through the normal
  `api_key` chain: per-entry → section → `default_upstream.default_api_key` →
  caller/user key), logs `[key-store] … no key was found …`, and collects it in a
  new `unresolved` list. `applySystemKeyStore` now returns
  `{ config, unresolved }`. The keychain itself being unavailable (`loadKeytar`
  failure) and Consul/Apollo sentinels remain fatal `KeyStoreError`s.
- `src/utils/config-loader.ts`: appends each `unresolved` entry to
  `_validationErrors`, so it surfaces in the TUI message line, the dashboard
  status bar (`config_errors`), and the console.
- `tests/unit/key-store.test.ts`: the two "fails loud" tests now assert the slot
  is cleared + reported (and that other slots still resolve) instead of rejecting.
- Docs updated: `README.md`, `docs/configuration-reference.md`.

### fix(tui): surface config-load errors on the initial "Loading…" screen

If the first `loadConfig()` call at TUI startup threw (e.g. a
`KeyStoreError` for an unresolvable `STORE_KEY_IN_SYSTEM` sentinel), the
`refresh()` catch block recorded the error via `view.setMessage(...)`, but
the header render returned early on `!snapshot` before ever reading that
message — so the TUI looked permanently stuck on "Loading…" with no visible
diagnostic (and `console.error` is silenced in TUI mode).

- `src/tui.ts`: `DashboardView`'s render now appends the current message
  (if set and not the default `'Ready'`) below `'Loading…'` while no
  snapshot has loaded yet.

### fix(responses): flatten `namespace`-wrapped tools and best-effort convert `custom` tools when merging `additional_tools`

The `additional_tools` merge added in the previous entry only kept entries
with `type === 'function'`. Per `docs/openai-response-final.md`,
`AdditionalTools.tools[]` also allows `Namespace` (`{ type: "namespace", name,
tools: [...] }`, grouping `function`/`custom` tools under a shared name) and
bare `Custom` tools — both were silently dropped, matching CLAUDE.md rule 8
("fail loud") only for the wrapper, not its contents. A real client request
with 3 namespaces / 11 tools converted to zero upstream tools.

- **`flattenNamespaces`** recursively unwraps `namespace` entries (namespaces
  can nest) before the existing `function`/`custom` filter runs. Chat
  Completions has no namespace concept, so the grouping is discarded and only
  the leaf tools remain.
- **`custom` tools are best-effort converted to `function` tools** with a
  permissive `{ input: string }` parameter schema, since Chat Completions has
  no unconstrained-text tool type and `custom` tools carry no `parameters` to
  translate. A warning is logged (`warn?.logger`) naming the tool, since the
  model now sees a structured-argument tool instead of free text.

- `src/converters/responses-to-completions.ts`: `flattenNamespaces` helper,
  `custom` → `function` conversion with warning.
- `tests/unit/responses-completions-roundtrip.test.ts`: recursive namespace
  flattening test, custom-tool conversion + warning test.

### feat(responses): reject programmatic tool calling on completions upstreams, with an opt-in downgrade transform

Follow-up to a review of the refreshed Responses API spec
(`docs/openai-response-final.md` vs the older `docs/openai-response.md`). The
line diff is ~370k lines but almost entirely reordering noise — sections were
retitled and resorted (old: Create, Retrieve, Delete, Cancel, Compact; new:
Cancel, Compact, Create, Delete, Get). The substantive changes:

- **`FunctionCallOutput`**: `call_id` went from required `string` to optional
  `string or null`, and the item gained `caller` (`Direct` / `Program`
  attribution), `name`, and `namespace`. Additive — the converter ignores the
  new fields, and an absent `call_id` correctly yields `undefined`. No code
  change needed; a regression test locks the tolerance in.
- **`ResponseOutputItem` union grew** from "17 more" to "25 more" variants:
  `FunctionCallOutput`, `ComputerCallOutput`, `LocalShellCallOutput`,
  `McpApprovalResponse`, and `CustomToolCallOutput` are now valid *output*
  items, not input-only.
- **New `program` / `program_output` items** (programmatic tool calling) —
  absent from the old spec. See below.
- **`previous_response_id`, `conversation`, `context_management` /
  `compact_threshold`**: only `| null` nullability added, no functional
  change. `ResponseCompactionItem` was inlined as `Compaction { encrypted_content,
  type, id }` (dropping `created_by`) — cosmetic.
- Lower priority, not acted on: `moderation`, `prompt_cache_options` /
  `prompt_cache_diagnostics` (`prompt_cache_retention` now deprecated), three
  new error codes, two new `incomplete_details.reason` values, and nine new
  shell/steer streaming events.

**Unrecognized input items are no longer dropped silently.**
`convertInputItemToMessages` had no fallback branch, so any item type it did
not know vanished from the upstream conversation with no trace (CLAUDE.md rule
8). It now logs a warning naming the dropped type. `convertResponsesToChatCompletions`
and `convertInputItemsToMessages` take an optional trailing
`ConversionWarnings { logger?, requestId? }` argument; existing two-argument
callers are unaffected.

**`program` / `program_output` are rejected with a 400 rather than converted.**
`program` carries a flat JavaScript `code` string (no structured sub-calls to
map onto `tool_calls`) plus a `fingerprint` the spec says "must be
round-tripped" — and a Chat Completions `messages` array has nowhere to carry
an opaque replay token. Flattening to text or to a synthetic tool call would
produce a conversation that looks intact while silently breaking program
replay upstream, so the converter throws `ValidationError` (400,
`invalid_request_error`) pointing at the `openai-responses` passthrough
upstream instead. No handler plumbing was needed: `createErrorResponse`
already maps `ClaudeProxyError.status`.

Reachability was traced before adding the reject: only a *client* can put
these items on the completions path. `handleAsPassthrough` never writes to the
conversation store and never parses the response body, and all four
`saveConversation` / `appendConversationThreadItems` call sites live in
`handleAsCompletions`, storing output items the proxy itself constructs
(`message`, `function_call`, `reasoning` only). Stored replay cannot
reintroduce a `program` item.

**New opt-in built-in `project_program_to_node_tool`** downgrades these items
onto an ordinary `node` function call for testing against upstreams where you
have verified the behavior. It runs at `before_conversion`, so the converter
never sees the original items and the 400 remains the default. The projection
is lossy in two documented ways — `fingerprint` becomes a model-authored
argument (breaking round-tripping), and it would otherwise invent a tool the
client never declared, so it only fires when a `node` tool is already
declared. See [docs/transforms-reference.md](./docs/transforms-reference.md#project_program_to_node_tool--downgrade-programmatic-tool-calling).

- `src/converters/responses-to-completions.ts`: `ConversionWarnings` param,
  warn-on-unrecognized fallback, `program`/`program_output` reject.
- `src/handlers/responses.ts`: passes `{ logger, requestId }` at all five
  `convertResponsesToChatCompletions` call sites.
- `src/utils/config-loader.ts`: registers `project_program_to_node_tool` in
  `BuiltinName` / `BUILTIN_NAMES`.
- `src/utils/request-transform.ts`: implements the built-in.
- `docs/transforms-reference.md`: built-in table row + reference section.
- `tests/unit/responses-completions-roundtrip.test.ts`: `caller`/optional
  `call_id` tolerance, warn-vs-drop, and three reject tests (both item types,
  plus mid-conversation position).
- `tests/unit/request-transform.test.ts`: six tests for the built-in
  (both projections, tool-declaration gating in both tool shapes, order
  preservation, no-op).

`tests/unit/responses-conversation-state.test.ts` needed no changes — the
conversation-state fields had no functional spec change.

### fix(responses): handle array-form `function_call_output.output` when converting to Chat Completions

Per the Responses API schema, `function_call_output.output` can be a string
or an array of `input_text`/`input_image`/`input_file` parts, not just a
string. `convertInputItemToMessages` was blindly casting it to `string`,
which silently mangled array-form tool output (e.g. image results) sent
upstream.

Now reuses the existing `convertResponsesContentToCompletions` helper (same
union already handled for message content) instead of the unchecked cast.

- `src/converters/responses-to-completions.ts`: `function_call_output` branch
  now converts `output` via `convertResponsesContentToCompletions`.
- `tests/unit/responses-completions-roundtrip.test.ts`: regression tests for
  array-form text-only and text+image output.

### feat(responses): handle `additional_tools` input items when converting to Chat Completions

The Responses API lets a request declare extra tools for a turn via an input
item shaped `{ type: "additional_tools", role: "developer", tools: [...] }`
(role is always `"developer"`). This item type was previously unhandled:
`convertInputItemToMessages` silently dropped it (no branch matched), and its
`tools` were never forwarded upstream — so tools declared this way were
invisible to `openai-completions`/`anthropic-messages`/gemini-mode upstreams
(the passthrough `openai-responses` path already worked, since native
Responses API upstreams understand the item natively).

`convertResponsesToChatCompletions` now collects `tools` from every
`additional_tools` input item and merges them with the request's top-level
`tools` before the existing flat→nested conversion runs — same
function-tools-only filter as `tools` already had (non-function types like
`mcp`, `web_search`, `code_interpreter` are dropped, matching existing
behavior for the top-level field). The `additional_tools` item itself still
emits no message, now via an explicit branch instead of falling through.

- `src/converters/responses-to-completions.ts`: collect + merge `additional_tools`
  tools; explicit no-op branch in `convertInputItemToMessages`.
- `tests/unit/responses-completions-roundtrip.test.ts`: regression tests for
  merging, combining with top-level `tools`, and a missing/malformed `tools` field.

### feat(config): add `openai-completions` as the default upstream mode in the model target wizard

Both the TUI (`m` key) and dashboard "Add target model" wizard now include
`openai-completions` as the first/default choice in the upstream mode picker,
moving it ahead of `anthropic-messages`. The validation set in
`upsertModelTarget` is updated to match the full `TransformSchema` closed set.

- `src/utils/config-loader.ts`: `MODEL_TARGET_UPSTREAM_MODES` now includes
  `openai-completions` at index 0.
- `src/tui.ts`: `openModelModePicker` choices reordered to match.
- `src/handlers/dashboard.ts`: `MODES` array updated, `state.mode` defaults
  to `openai-completions` automatically.
- `tests/unit/config-loader.test.ts`: "accepts all three valid upstream modes"
  test updated to four modes.
- `tests/integration/07_dashboard/dashboard_api.test.js`: comment updated.

### feat(config): blank api_key in the model target wizard reuses a same-base_url keychain entry

When the api-key field is left blank in the "Add target model" wizard (TUI `m`
and dashboard), `upsertModelTarget` now first scans sibling entries within the
*same category* for one already storing `STORE_KEY_IN_SYSTEM` whose effective
base_url (entry's own, falling back to the category's) matches this entry's —
using the same base_url prefix-relation scoring the keychain best-effort
resolver uses (`scoreBaseUrlMatch`, extracted from `key-store.ts`'s
`scoreAccountMatch`; target-name similarity intentionally not considered
here, only base_url). If a match is found, the new entry adopts the sentinel
so it resolves from the same keychain account instead of silently landing on
the category's plaintext `api_key` (previous blank behavior, still the
fallback when no match is found). Editing an entry never matches against
itself, so clearing a previously-plaintext key by blanking the field still
clears it rather than resurrecting a sentinel.

- `src/utils/key-store.ts`: new exported `scoreBaseUrlMatch` (base_url-only
  half of `scoreAccountMatch`, reused by both).
- `src/utils/config-loader.ts`: `upsertModelTarget` — same-category
  `STORE_KEY_IN_SYSTEM` lookup on blank `api_key`.
- `src/handlers/dashboard.ts`: wizard step-3 helper text updated to mention
  the new blank-key behavior.
- `tests/unit/config-loader.test.ts`: regression tests for same-base_url
  match, category-base_url-fallback match, no-match (stays blank),
  cross-category isolation, and self-exclusion on edit.

### fix(config): reject hand-typed `STORE_KEY_IN_SYSTEM` sentinel in the model target wizard

Closes the TODO left in the `feat(config)` entry below. The "Add target model"
wizard's api-key field (TUI `m` and dashboard) had no guardrail against a user
typing/pasting the literal sentinel `STORE_KEY_IN_SYSTEM` by hand. Unlike
`applySystemKeyStore`'s own store-pass (which only ever writes the sentinel
right after storing a real plaintext key to the matching keychain account), a
hand-typed sentinel was written verbatim with no keychain entry behind it. On
next load, resolution keys off `<target>/<base_url>` and could silently
succeed against an unrelated or stale keychain entry sharing that account
(wrong key, no error) instead of failing loud.

`upsertModelTarget` now throws when `patch.api_key === STORE_KEY_IN_SYSTEM`
unless the entry being edited already held that exact sentinel (the
"leave unchanged" edit path, which is backed by a real keychain entry). Both
the TUI wizard and the dashboard wizard call this same function, so the
guardrail applies to both without duplicating the check.

- `src/utils/config-loader.ts`: `upsertModelTarget` — compare `patch.api_key`
  against the existing entry's index-2 value before accepting the sentinel.
- `tests/unit/config-loader.test.ts`: regression tests for add, edit-not-
  previously-sentinel (both throw), and edit-already-sentinel (allowed).

### fix(tui): custom model test sent the wrong api key for plain `[models.*]` targets

Testing a plain (non-composite) model target in the TUI's custom model test
(e.g. `bbb`) could send the proxy-wide `default_upstream.default_api_key`
upstream instead of the model's own key — a 401 from the upstream provider,
even though the config and keychain were both correct and the dashboard's own
"test" button worked fine for the same model.

Root cause: the TUI's test resolver (`resolveModelTestConfig`) reads the
sanitized dashboard snapshot (`snapshot.config`), where every model entry has
already been reduced to `[target, base_url, mode]` with `api_key` stripped for
display. For a model whose category has no category-level `api_key` (e.g. a
one-off entry under its own `[models.<category>]` section), the resolver had
no source for the entry's real key and fell through to
`categoryConfig.api_key || config.default_upstream?.default_api_key` — both
undefined-or-wrong for that entry — so `executeModelTest` sent the *proxy's*
default key (a different provider/account entirely) instead of failing loud
or using the model's own key.

`resolveModelTestConfig` now also accepts the real, unsanitized `ProxyConfig`
and uses `getModelRouteConfig(modelId, realConfig).apiKey` — the same resolver
the dashboard's test button already uses — as the fallback ahead of
`default_upstream`, for both the array and inline-table entry shapes.

- `src/tui.ts`: `resolveModelTestConfig` (new `realConfig` param + api key
  fallback), both call sites in `runModelTest`/`executeModelTest`; exported
  the function (matches the existing `buildTestTextRequest`-style convention)
  so it's unit-testable.
- `tests/unit/tui.test.ts`: new file — regression tests asserting the real
  per-model key is used instead of the wrong proxy-wide default.

### fix(dashboard): inline-table `[models.*]` entries dropped from the sanitized snapshot

An entry written as an inline table (e.g. `bbb = {target = "...", base_url = "...",
api_key = "...", mode = "..."}` — the shape `upsertModelTarget`/the "Add target
model" wizard writes) was silently dropped by `sanitizeDashboardCategoryConfig`,
which only handled array- and string-shaped entries. The TUI's model-test picker
reads this sanitized snapshot (`toDashboardConfigPayload` via `getDashboardSnapshot`),
so testing such a model there found no config, fell back to wrong defaults
(`anthropic-messages` mode, no api key), and failed — while the dashboard's own
"test" button worked because `handleDashboardTestModel` resolves the model
against the real, unsanitized config via `getModelRouteConfig`.

`sanitizeDashboardCategoryConfig` now also converts object-shaped entries into
the same 3-element `[target, base_url, mode]` shape used for arrays (`api_key`
stripped either way).

- `src/utils/config-loader.ts`: `sanitizeDashboardCategoryConfig` object branch.
- `tests/unit/config-loader.test.ts`: regression test for the inline-table case.

**TODO:** the "Add target model" wizard's API-key field (TUI `m` and dashboard)
has no guardrail against a user typing/pasting the literal sentinel
`STORE_KEY_IN_SYSTEM` by hand. Unlike `applySystemKeyStore`'s own store-pass
(which only ever writes the sentinel after it has just stored a real plaintext
key to the matching keychain account), a hand-typed sentinel is written
verbatim with no keychain entry behind it. On next load, resolution keys off
`<target>/<base_url>` and can silently succeed against an unrelated or stale
keychain entry that happens to share that account (wrong key, no error) instead
of failing loud — hit this exactly with `bbb` (`target =
"nvidia/nemotron-3-ultra-550b-a55b:free"`, `base_url =
"https://openrouter.ai/api/v1"`), which resolved to a stale key left over
under that account and got rejected by OpenRouter; fixed by overwriting that
keychain entry, no code change needed. Consider validating in the wizard (and/or
`upsertModelTarget`) that a literal `STORE_KEY_IN_SYSTEM` is only accepted when
a keychain entry already exists for the resulting `<target>/<base_url>` account.

### feat(dashboard): 'Add target model' wizard in web dashboard

Adds a web-dashboard equivalent of the TUI's "Add target" wizard (see the
`feat(tui)` entry below): a new "Add target model" button, styled and
structured like the existing "Add composite alias" wizard (step counter,
Back/Next/Cancel, inline status-line validation, Esc-to-cancel-at-any-step).
6 steps: alias key → target model id → api key → base url → upstream mode →
category (pick an existing `[models.*]` section from a `<select>`, or
choose "+ new category…" to type a new section name).

Saves through a new dedicated endpoint backed by the same
`upsertModelTargetFromDashboard` mutator the TUI wizard uses, rather than
the generic whole-page config save — the whole-page path
(`collectConfigPayload` → `PUT /dashboard/api/config`) intentionally never
round-trips `transforms`/`max_tokens` (config-file-only fields) and this
avoids touching that path at all; only the single new/edited entry is
written. The existing per-category "Add model entry" quick-add
(`openAddModelWizard`) is unchanged.

- `src/handlers/dashboard.ts`: `handleDashboardUpsertModelTarget` handler,
  new `modelTargetWizard` modal markup, `openAddModelTargetWizard()` client
  wizard, `add-model-target` trigger button/click-dispatch branch.
- `src/index.ts`: new route `POST /dashboard/api/models/:category/:aliasKey`.
- Integration tests in `tests/integration/07_dashboard/dashboard_api.test.js`
  (TC719 valid upsert round-trip, TC720 invalid-mode 400 rejection).

### feat(tui): 'Add target' wizard bound to 'm' key

Top-level `m` key in the TUI (Dashboard view) opens an "Add target" panel listing all
`[models.*]` entries across categories. Selecting an existing entry opens a 4-step
wizard (target model id → api key → base url → upstream mode) pre-filled with its
current values for editing. Choosing "+ _input new target_" collects an alias key,
then runs the same 4 steps, followed by a final category step: pick an existing
`[models.*]` section from a list, or choose "+ _input new category_" to type a new
section name. Saves to `proxy_config.toml` via the existing dashboard persistence
path (`saveConfigMutation` → `loadProxyConfigFromPath` → `persistProxyConfigToPath`
→ `clearProxyConfigCache`).

- `src/utils/config-loader.ts`: new `upsertModelTarget` mutator preserving
  indices 4 (transforms) and 5 (max_tokens) when editing, validating upstream
  mode against the closed set (`anthropic-messages`, `openai-responses`,
  `gemini-generatecontent`).
- `src/handlers/dashboard.ts`: `upsertModelTargetFromDashboard` wrapper and
  `getModelTargetFromDashboard` read helper (returns real api_key/mode since
  the TUI only has the sanitized dashboard snapshot).
- `src/tui.ts`: `openModelTargetPicker`, `openModelTargetWizard`,
  `openModelCategoryPicker` (last step for new targets only, editing keeps its
  existing category), `openModelModePicker` — callback-chained multi-step
  flow using existing `ListOverlay` and `openPrompt` helpers. Esc at any step,
  including the trailing category step, cancels the whole wizard.
- Unit tests in `tests/unit/config-loader.test.ts` covering index 4-5 preservation,
  invalid mode rejection, add shape, sentinel round-trip, and serialize/reparse.



### feat(build): `npm run build:native` single-file executable

Adds a second distribution channel alongside the existing one. `npm run build`
is unchanged — `tsc` to `dist/*.js`, run as `node dist/server.js` with
`node_modules` beside it, which is what the Dockerfile ships. `npm run
build:native` (`scripts/build-sea.js`) instead produces one self-contained
binary in `dist/`, named per platform/arch (`model-proxy-v3-macos-arm64`,
`model-proxy-v3-linux-x64`, `model-proxy-v3-win.exe`, …).

The pipeline is Node's built-in SEA (Single Executable Application): esbuild
bundles `src/server.ts` and its whole dependency graph into one CJS file,
`--experimental-sea-config` turns that into a blob, the host `node` binary is
copied, and `postject` injects the blob into the copy. On macOS the copy is
re-signed, since injecting a section invalidates the existing signature. A
`tsc --noEmit` preflight runs first — esbuild strips types without checking
them, so without it a native build could ship code `npm run build` would
reject.

**Cross-compilation is not possible.** The output *is* a copy of the Node that
built it, so each target platform needs its own build host (CI matrix, VM, or
container). This is inherent to SEA, not a limitation of the script.

**The build Node must be official and self-contained** (nodejs.org, nvm,
`actions/setup-node`). Homebrew and some distro packages ship `node` as a small
launcher against a shared `libnode`; the SEA sentinel fuse lives in the library
rather than the launcher, so injection fails. Check by size — a real one is
~110MB, the stub ~50KB. The script reads the fuse out of the binary at build
time rather than assuming `postject`'s default, because its spelling
(`NODE_SEA_FUSE_` vs `POSTJECT_SENTINEL_`) and hash change between Node
releases; it fails with that diagnostic when no fuse is found.

Not in the binary, both matching the Docker image and both failing loud rather
than silently:

- **System keychain** (`@github/keytar`) — a native `.node` addon, which SEA
  has no mechanism to embed. `store_key_in_system = true` raises the existing
  `KeyStoreError`, as it already does in Docker (`--omit=optional`).
- **`sdk://` routes** (the `chatjimmy` submodule) — loaded through a
  deliberately non-literal relative specifier so it stays optional at build
  time. That specifier is relative to the *source file*, and a SEA binary has
  no source tree, so it cannot resolve regardless of what sits next to the
  executable. The existing catch reports `ChatJimmy SDK not available`.

Two bundling details worth recording, both found by running the binary rather
than by reading the source:

- **`import.meta.url` had to be defined explicitly.** Bundling ESM to CJS
  leaves `import.meta` with no equivalent and esbuild emits `import_meta = {}`,
  making `import.meta.url` `undefined`. `@earendil-works/pi-tui` calls
  `createRequire(import.meta.url)` at *module scope*, so it threw
  `ERR_INVALID_ARG_VALUE` the moment that initializer ran — killing `TUI=1` and
  `AGENT=1` at startup while plain HTTP serving looked fine, because both
  import pi-tui lazily. A `--define` plus banner now supplies a real `file://`
  URL derived from `process.execPath`. pi-tui uses that `require` only to probe
  for an optional native addon inside a `try`/`catch`, and SEA cannot ship
  native addons anyway, so the probe now *misses* instead of *throwing*; TUI
  modifier-key detection is degraded in the binary, on every platform equally.
- **`npx` needs a shell on Windows.** There `npx` is `npx.cmd`, and
  `execFileSync` spawns executables directly — `CreateProcess` cannot run a
  batch script, and Node 20+ additionally refuses `.cmd` via `execFile` without
  a shell (CVE-2024-27980). `shell` is now set on win32 only, so POSIX gains no
  extra quoting layer.

Installing for a native build must **not** use `--omit=optional`, unlike the
Dockerfile: esbuild ships its platform binary (`@esbuild/darwin-arm64`,
`@esbuild/linux-x64`, …) as an optional dependency, and omitting it leaves
esbuild unable to run.

Verified on macOS arm64 only: builds, runs from a directory containing just the
binary and a `proxy_config.toml` (no `node_modules`, no source tree), serves
`/dashboard` and `/v1/models`, and starts under both `TUI=1` and `AGENT=1`.
Linux and Windows are expected to work — the script branches correctly for
them and nothing in `src/` is platform-specific — but have not been run.
`proxy_config.toml` is still read from the working directory at runtime
(`PROXY_CONFIG_PATH`); it is not embedded.

### fix(agent): close three path/log confinement holes and two bash edge cases

Follow-up review of `src/agent-session.ts` / `src/agent-tools.ts`. Each item below
was reproduced against the running tools before being fixed, and has a regression
test in `tests/unit/agent-tools.test.ts`.

Security:

- **Symlink bypass of write confinement** — `isPathAllowed` compared only the
  *lexical* (`path.resolve`) form of a target, so a symlink inside the working
  directory pointing outside it passed the check and the write followed the link,
  reporting success on an in-scope path while clobbering a file outside both
  allowed roots. The agent could plant that symlink itself (`ln -s` is on no
  denylist), making it a self-contained bypass. Both the lexical and the
  symlink-resolved form are now required to be in scope, so a link can only ever
  narrow what is reachable, never widen it. Resolution walks up to the deepest
  *existing* ancestor (`realpath` fails on a not-yet-created file, the normal
  `write_file` case), which also catches a symlinked parent directory.
- **`read_file` had no path check at all** — unlike `write_file` it never called
  `isPathAllowed`, so the agent could read anything the operator's account could
  (`~/.ssh/id_rsa`, `~/.aws/credentials`, `proxy_config.toml`'s
  `default_api_key`). Because the session's provider is the proxy itself,
  anything read was sent upstream as conversation context. Now confined to the
  same roots as writes.
- **Trajectory log was symlink-attackable** — `TRAJ=1` appended to a fixed
  `<os.tmpdir()>/agent_trajectory.log`, re-resolving the path on every write. On
  Linux `os.tmpdir()` is normally the shared world-writable `/tmp`, where any
  local user could pre-create that name as a symlink and capture the whole
  transcript (task text, file contents in tool results) while clobbering a file
  of their choosing; the log was also mode `0644`. The name now carries a
  per-session random suffix and is opened **once** with
  `O_EXCL|O_NOFOLLOW|O_APPEND` at mode `0600`, held for the session.

Correctness:

- **Compound commands hid a second `rm`/`mv`** — the extraction regex matched
  only the first `rm`/`mv` in the whole command string, folding everything after
  it (including an independent second invocation) into that first match's
  argument list instead of checking it. Each `&&`/`||`/`;`/`|`-separated segment
  is now checked on its own.
- **Any signal exit was reported as a timeout** — `execFile`'s `error.killed` /
  `error.signal` are set whenever a process ends via a signal, whether Node's
  `timeout` fired, the child killed itself, or something external killed it (OOM
  killer, manual `SIGKILL`). A command killed after two seconds was reported as
  "timed out after 60s". A dedicated timer now tracks whether *our* timeout
  actually fired; other signal exits report the signal instead.

The `⚠️ No OS-level sandbox` caveat is unchanged and still applies: `bash` runs
with the operator's full privileges, and the command denylist remains raw
string/regex matching, evadable by obfuscation. These fixes close gaps in the
path confinement the code already claimed to enforce; they do not add a sandbox.

### feat(agent): interactive `AGENT=true` coding session backed by the proxy itself

A new `AGENT=true`/`1` mode (`src/agent-session.ts`, mirroring the existing
`TUI=true` convention in `server.ts`) runs an interactive
[`@earendil-works/pi-agent-core`](https://www.npmjs.com/package/@earendil-works/pi-agent-core)
session whose LLM provider is the proxy's own loopback `/v1/messages` — so an
agent task exercises the same routing, composite aliases, quota accounting and
privacy filtering as any other client.

Flow: pick a working directory → pick a model → verify with a "hi" round-trip →
set a budget → state a task → run → summarize file changes → prompt for a
follow-up task against the same agent and budget.

- **Tools** (`src/agent-tools.ts`): `read_file`, `write_file`, `bash`, plus
  `find_skill`/`add_skill` when the `skills` CLI is available (probed once at
  startup — tools that would always fail are not exposed at all). Skills are
  loaded from both the project-scoped `.pi/skills` and a global dir.
- **Budget**: prompt accepts tokens (`1m`, `50k`) or turns (`20`), prefilled with
  `5m`. Submitting the prefill unchanged and submitting blank both apply the same
  combined 5,000,000-token / 100-turn default; an explicitly typed value sets
  exactly one limit. Turns is sized as a runaway-loop backstop, not the binding
  limit — at a realistic ~30k tokens/turn the token budget trips first. Note
  pi-agent-core itself imposes **no** turn limit — its `runLoop()` is an
  unbounded `while(true)` — so this budget is the only stop condition besides
  explicit exit. `/q`, `/quit`, `/exit` and ctrl+c end the session at either the
  budget or the task prompt.
- **Model picker** lists composite aliases first and target models last, each
  labelled by kind. Ordering is local to the picker; the shared
  `getConfiguredModelIds` (and therefore `GET /v1/models`) is unchanged.
- **`TRAJ=1`** tees the session's console output to `agent_trajectory-<id>.log`
  under the OS temp dir, ANSI stripped and blank lines dropped. Restored on every
  exit path, including early returns. (Path and open flags hardened later — see
  the `fix(agent)` entry above.)
- **Log verbosity**: for the session's duration `LOG_LEVEL` is raised to `warn`
  so per-request proxy chatter doesn't fight the agent's streamed reply;
  restored on exit. Tool call/result lines are truncated to 120 chars.

**No OS-level sandbox.** `bash` and `write_file` run with the operator's full
privileges; pi-agent-core provides no confinement. Reads, writes, deletes and
moves are confined to the working directory plus the real OS temp tree (reads and
symlink resolution were added later — see the `fix(agent)` entry above), and
`bash` blocks a small denylist of destructive patterns (`rm -rf`, `kill -9`,
force push, `chmod -R 777`, `curl|sh`) — but the command denylist is raw
string/regex matching, not a shell parser, and is evadable by obfuscation. It
guards against an agent mistake, not an adversary. A startup warning states this
explicitly.

### refactor(logs): shorten per-request log lines and request ids

Request-line logging was verbose enough to be hard to scan, especially
interleaved with an agent session's own output:

- `src/index.ts` composite-attempt line is now comma-separated, dropping the
  `for`/`to` filler and the trailing upstream mode:
  `/v1/messages,forclaw,https://openrouter.ai/api/v1/chat/completions`
- `src/handlers/messages.ts` upstream line drops the user-agent prefix,
  `upstream (stream=…)` and `thinking (…)` in favour of a flag list, with the
  user-agent moved to the end:
  `minimax/minimax-m3:free,(s,t) [openai-completions] <ua>`, where `s` means
  streaming and `t` means thinking is *enabled* (a `{type: "disabled"}` block
  counts as off, matching the existing `thinkingType` check).
- `shortRequestId` (`src/utils/logger.ts`) now displays the last 8 digits of the
  timestamp and 6 chars of the UUID: `req_1783840535295_2a042b05-…-5266bdbac7f1`
  → `req_40535295_5266bd`. Two deliberate losses: the truncated timestamp
  discards multiples of 1e8 ms so it repeats every **~27.8 hours** (recoverable
  as `prefix * 1e8 + shown`, but not a full date), and the 6-char fragment is 24
  bits, so ids sharing a displayed millisecond collide far more readily than
  before. Both are fine for reading a log by eye; neither is a unique key. The
  full id is unchanged everywhere outside log display, including upstream
  correlation. Non-matching ids (e.g. the literal `config`) pass through
  untouched.

When `AGENT=true`, the shared logger also dims every remaining line to dark gray
and drops startup-only `config` diagnostics outright. Non-AGENT modes
(`server.ts`, `tui.ts`) are unaffected.

### fix(quota): record upstream rate-limit usage from every endpoint, not just `/v1/messages`

`recordUpstreamRateLimit` (which populates the passively-recorded
`anthropic-ratelimit-unified-5h-utilization` value, both per-model and
per-upstream-host) was only wired into the native `/v1/messages` handler
(`claude.ts`). Requests reaching the same upstream through any other
endpoint/format — `/v1/chat/completions`, `/v1/messages` (compat path),
`/v1/responses` (all sub-routes: anthropic-messages, completions,
input_tokens, compact, passthrough), and the OpenAI-format handlers —
never recorded quota, even though quota is a property of the upstream host,
not the endpoint used to reach it. `recordUpstreamRateLimit` is now called
after every upstream `fetch()` in `chat-completions.ts`, `messages.ts`,
`openai.ts`, `responses.ts` (7 call sites), and `gemini.ts` (3 call sites,
no-ops today since Gemini doesn't send this header, but wired for
consistency and any future Anthropic-compatible bridging).

`getModelQuota` (the active-polling path used for Kimi/DeepSeek/MiniMax/
OpenRouter/Zhipu usage) needed no equivalent change: all 4 call sites
(`tui.ts` quota picker, `tui.ts` composite overlay refresh, and both
`dashboard.ts` `/dashboard/api/quota` variants) already resolve routes via
`getModelRouteConfig`/`getConfiguredModelIds`/`modelChoices`, which key
purely off each model's config entry (`target`, `base_url`, `api_key`) —
never off which proxy endpoint serves it. It was never endpoint-scoped, so
there was nothing to fix.

### fix(stats): record tokens for native Gemini streams, force `include_usage` on streaming chat/completions passthrough, map Gemini cached tokens

Three usage-statistics gaps closed (column semantics per endpoint are now
documented in a new README table under "Token usage statistics columns"):

- **Native Gemini streaming recorded zero tokens.** `:streamGenerateContent?alt=sse`
  chunks carry `usageMetadata`, but the SSE usage tracker only looked for
  OpenAI-shaped `data.usage`. The no-event branch now also parses
  `usageMetadata` (`promptTokenCount` / `candidatesTokenCount` /
  `totalTokenCount` / `cachedContentTokenCount`), final-chunk running totals
  winning.
- **Gemini `cachedContentTokenCount` was dropped everywhere except the
  streaming Gemini→Claude converter.** It is now mapped to `cached_tokens` in
  the JSON usage extractor (`extractUsageFromResponsePayload`), the
  non-streaming Gemini→Claude conversion (`cache_read_input_tokens`), and the
  `/v1/interactions` non-streaming handler (`total_cached_tokens`, which the
  streaming converter already consumed). Note Gemini's `promptTokenCount`
  includes the cached portion, same semantics as OpenAI `prompt_tokens`.
- **Streaming `/v1/chat/completions` native passthrough didn't force
  `stream_options.include_usage`.** OpenAI only emits the usage-bearing final
  chunk when the client sets it; the proxy now forces `include_usage: true` on
  the forwarded body (mirroring the existing converted-route behavior in the
  messages handler / claude-to-openai converter). The extra chunk is
  spec-compliant and forwarded to the client unchanged.

Unit tests added for the `cachedContentTokenCount` JSON mapping and native
Gemini SSE capture (tests/unit/token-usage.test.ts).

### feat(tui): live-refresh the 'Model Quota' picker while open

The Model Quota picker built its quota entries once when opened, so rows kept
showing the values from open time — e.g. a stale `Quota: 100% 5h left` — even
though every upstream response updates the passively recorded
`anthropic-ratelimit-unified-5h-utilization` value (recorded per request in the
anthropic-messages handler; verified against a live Anthropic-compatible upstream,
which forwards
the header on every response). The picker now keeps its live state
(`quotaPickerState`) and is rebuilt from the 500ms refresh loop
(`refreshQuotaPicker`, same pattern as the composite overlay's quota refresh):
row suffixes and the highlighted row's `Quota:` status line update as new
upstream responses arrive while the overlay is open. Provider quota fetches
stay bounded by `getModelQuota`'s 30s cache; the anthropic-5h fallback is a
plain in-memory map read.

### fix(build): keytar dependency now installs prebuilt; Docker skips it; dead config removed

The `@github/keytar` optionalDependency is now pinned as
`github:github/node-keytar#v7.10.6` instead of `file:submodules/node-keytar`, and
the root `postinstall` (git submodule + forced `npx node-gyp rebuild`) is gone:
`npm install` fetches the addon from GitHub and its install script downloads a
prebuilt NAPI binary (ABI 3) — no compiler or Python needed; node-gyp compiles
from source only as the fallback when the prebuilt download fails. The
`submodules/node-keytar` submodule is kept as a local source copy for development
but is no longer used by `npm install`.

The Dockerfile now installs with `--omit=optional --ignore-scripts`, excluding
the keytar addon (no OS keychain in the image; `store_key_in_system` keeps
failing loud there) — previously the root postinstall's `git submodule` call
would have broken the image build.

Also removed the dead `allowScripts` / `lavamoat.allowScripts` blocks from
`package.json` (they referenced `@lavamoat/allow-scripts`, which is not a
dependency). README and `docs/configuration-reference.md` updated to describe
the prebuilt-first install, per-platform system/toolchain requirements (runtime
keychain backend per OS; build toolchain only for the source-build fallback),
and the headless-Linux keyring caveat.

### fix(tui): quota picker falls back to shared host-level usage when a model alias has no recording

Models sharing the same `(target_url, api_key)` (e.g. `codelite`, `codesmall`,
`codestrong` all routed through the same upstream) share one quota pool, but
the TUI's "usage left" was keyed only by model alias (`getUpstreamRateLimitLeft`),
so aliases that hadn't been used recently showed no quota even though a
sibling model on the same credential had a fresh recording. The dashboard's
per-base-URL column already aggregated this correctly via
`getUpstreamRateLimitLeftForUrl`.

The TUI's quota picker (`buildQuotaData`) and composite quota refresh
(`refreshCompositeQuota`) now fall back to `getUpstreamRateLimitLeftForUrl(route.targetUrl)`
when the model-keyed recording is missing, matching the dashboard's behavior.

### feat(transforms): `restore_client_model_alias` builtin to echo the requested alias back in responses

The proxy rewrites the request body's `model` field from the client's alias to
the real upstream model id before forwarding (`index.ts` composite/coordinator/
fusion/default routing), but the response `model` field was pure passthrough —
clients saw the real upstream model id, not the alias they requested, leaking
routing internals and breaking any client-side `response.model === request.model`
checks.

Added an opt-in `response_egress` builtin, `restore_client_model_alias`, that
rewrites the response body's `model` field (JSON, and each `chat.completion.chunk`
SSE event) back to the client-requested alias. Enable it per-route via the
existing transform config mechanism:

```toml
[transforms.restore_alias]
schema = "openai-completions"
response_egress.builtins = ["restore_client_model_alias"]

[models.my-fast-model]
target = "claude-haiku-4-5-20251001"
transforms = "restore_alias"
```

Routes that don't list it keep today's passthrough behavior — this is the
config "toggle." Implementation notes:

- `RouteAttempt` gained a `clientModel?: string` field, set at every attempt
  construction site (composite candidates, `buildRouteAttempt` for
  coordinator/fusion sub-targets, and the default single-route path via a new
  `clientRequestedModel` outer variable) — carries the true pre-alias name
  since the existing `modelId` field gets overwritten with the resolved
  upstream model id.
- Fixed a latent bug: `HookContext.clientModel` at the `response_egress` hook
  was wired to the resolved upstream model id (`attemptModelId`), not the
  client's original alias, inconsistent with `request_ingress`'s correct
  `parsedBody.model`-based wiring. Builtins now receive `clientModel` via the
  `trace` param threaded through `applyTransformSet`/`applyBuiltin`.

### fix(quota): usage-left lookup keyed by upstream model name, not config key

The anthropic 5h utilization header (`anthropic-ratelimit-unified-5h-utilization`)
IS returned by anthropic-compatible upstreams (verified against a local pi proxy)
and recorded by the claude handler — but under the upstream model name
(`route.modelAlias`, e.g. `codelite` → `code-lite-pi`), while every model-keyed
display looked up the config key (`codelite`). Result: aliased models on hosts
without a usage-provider API (pi proxies, etc.) never showed usage-left, while
provider-hosted models (zhipu/minimax/deepseek/…) worked because the active
quota fetch is host-keyed. Fixed on the display side (recording stays keyed by
the upstream name, consistent with the stats tables):

- TUI quota picker (`buildQuotaData`) and composite-alias overlay
  (`refreshCompositeQuota`) now look up `route.modelAlias || modelId`.
- `GET /dashboard/api/quota?model=<id>` now falls back to the recorded header
  value when the route host has no usage provider, mirroring the existing
  `base_url=` variant (returns `provider:"anthropic-5h", source:"response-header"`).

The `base_url=` variant (dashboard upstreams table) was already correct; its
value is in-memory only — present after ≥1 successful proxied response since
process start.

### docs: `store_key_in_system` addon install & recovery instructions

README ("Configuration Reference") and `docs/configuration-reference.md` now document
how to install the `@github/keytar` addon and how to recover from the startup error
`Cannot find package '@github/keytar'`. Two facts established while verifying the
instructions (fresh-clone repro, npm 11 / Node 24 / macOS):

- The parent `npm install` builds the native binding automatically — the submodule's
  install script falls through to `node-gyp rebuild` — so the earlier note's manual
  `cd submodules/node-keytar && npm install && npm run build` is only needed when the
  node-gyp toolchain is missing or the automatic build fails.
- Root cause of the error seen on the dev host: a prune-style npm run
  (`npm install --dry-run --omit=dev` / `--production`) stripped the
  `optionalDependencies` block from `package.json` (and the untracked
  `package-lock.json`), after which no later `npm install` ever re-links the addon —
  npm only installs what `package.json` still declares. Durable fix:
  `git checkout -- package.json && npm install`. Band-aid without the submodule:
  `npm i @github/keytar --no-save` (registry copy with a prebuilt binary; `--no-save`
  keeps the `file:submodules/node-keytar` pin).

### feat(config): `store_key_in_system` — store api_keys in the OS keychain

New `[general] store_key_in_system = true` flag. On config load (Node server,
file-based `PROXY_CONFIG_PATH` only), every plaintext `api_key` in `[models.*]`
(section-level, per-entry, and `[default_upstream].default_api_key`) is stored
into the OS keychain via the vendored `@github/keytar` native addon
(`submodules/node-keytar`) under service `model_proxy_v3` with account
`<target_model_id>/<base_url>`. The config file is then rewritten in place —
backup at `<config>.bak` — with those keys replaced by the literal
`STORE_KEY_IN_SYSTEM` sentinel (targeted text replacement; comments and layout
preserved). On every later load, sentinels are resolved back to real keys from
the keychain into the in-memory config, so routing and the dashboard are
unchanged (`api_key` stays non-editable there, preventing re-leaks).

Scope limits: the feature is skipped entirely for Consul/Apollo config-center
sources (flag ignored with a warning; a sentinel reaching such a config is a
fatal load error, since it could never be resolved and would leak upstream as
a literal key). Composite/schedule aliases carry no api_key of their own and
are not touched. Caller/user keys from request headers (auth passthrough via
empty api_key) are never stored.

Sentinel resolution is exact-account first; on miss it falls back to a
best-effort match over all keychain accounts under `model_proxy_v3`, scored
by base_url similarity (prefix relation; base_url dominates, target-name
similarity tiebreaks) — e.g. a wanted `glm-5.3-anth/https://…/api/anthropic`
resolves from a stored `glm-5.3/https://…/api`. Every fallback use logs a
warning; no similar account at all is still a fatal load error.

TUI additions: a 🔒 marker is shown on the "Proxy TUI" header line (before
the version) when every configured api_key in the local config file is a
`STORE_KEY_IN_SYSTEM` sentinel, and a new hotkey `K(k)` opens a "System
Keychain Keys" overlay
listing the stored `<target_model_id>/<base_url>` accounts (passwords are
never displayed). The hotkey is introduced in the help panel only — it is not
added to the footer hotkey line; 🔒 is also documented in the help markers
section. The web dashboard header shows the same 🔒 beside "Proxy Dashboard"
when `api_keys_in_system_store` is set (updated live on each config load).

Fail-loud semantics: if the flag is set but the keychain/native addon is
unavailable (Docker, Cloudflare Workers, headless Linux without libsecret), or
a sentinel has no keychain entry, startup aborts instead of degrading to an
empty config.

Notes:
- The addon must be built once inside the submodule:
  `cd submodules/node-keytar && npm install && npm run build` (a git checkout
  ships no prebuilds). After that the parent `npm install` symlinks
  `@github/keytar` to the submodule. (Verified later: when the node-gyp
  toolchain is present, the parent `npm install` runs that build automatically —
  see the docs entry above; the manual build is the fallback.)
- `package.json` gained an `allowScripts` field (npm 11+ install-script
  allowlist) covering the keytar install script.

### feat(quota): read model usage/credits left for coding-plan providers

New `src/utils/provider-quota.ts` fetches the remaining usage / balance for a
model's route when its upstream is one of the supported coding-plan providers
(endpoints + response schemas ported from the dsh musage plugin):

| Provider | Route host(s) | Usage endpoint | Result |
|---|---|---|---|
| minimax | `api.minimaxi.com` / `api.minimax.io` | `/v1/api/openplatform/coding_plan/remains` | 5h + 7d used% (dual schema: percent-based + legacy count) |
| deepseek | `api.deepseek.com` | `/user/balance` | balance (CNY/USD) |
| kimi | `api.kimi.com` | `/coding/v1/usages` | 5h + 7d used% |
| openrouter | `openrouter.ai` | `/api/v1/credits` | remaining USD credits |
| zhipu | `open.bigmodel.cn` | `/api/monitor/usage/quota/limit` | 5h + 7d used% |

The provider is detected from the model route's `targetUrl` host — no extra
config. Zhipu is special: its `Authorization` header takes the raw key (no
`Bearer ` prefix). Results are cached per `(provider, apiKey)` for 30s on
success, with exponential backoff (5s → 30min) on failure.

Anthropic-routed models have no usage endpoint, but Anthropic-compatible
upstreams report the account-wide 5h-window used fraction (0-1) in the
`anthropic-ratelimit-unified-5h-utilization` response header. The
`anthropic-messages` passthrough now records this per model on
real traffic (no polling — a value appears only after the first proxied
request to that model) and derives a usage-left percent
(`(1 - utilization)` clamped at 0%) as a fallback when the route has no usage
provider.

Surfaces:

- **TUI**: new `Q` hotkey opens a model picker; every row carries a usage
  suffix — `(58%)` (percent schema), `(7472/20000, 63%)` (remaining/limit +
  used% for count schemas), `(¥43.97)`/`($6.50)` (balance), or `(58%)` from
  the recorded anthropic 5h header — and moving ↑/↓ shows the highlighted
  model's full quota (windows + reset time) on a status line at the bottom of
  the panel; anthropic-routed models show the recorded 5h utilization left,
  e.g. `58% 5h left`.
- **TUI composite panel**: in 'Edit Composite Aliases Config', each target
  row appends its usage-left after the timing suffix, e.g.
  `[0.11/2.12/63.93s] (58% left)` — percent (minimax percent schema /
  anthropic 5h header), count as `remaining/limit, used%` e.g.
  `6930/12000, 42%` (kimi/zhipu/minimax count schema), or balance
  (deepseek/openrouter), refreshed with each config
  refresh (the 30s provider cache bounds the load).
- **Dashboard API**: `GET /dashboard/api/quota?model=<id>` (dashboard
  `api_key` auth) returns the normalized JSON result — `200` on success,
  `404` for unconfigured/unsupported routes, `502` for provider errors.
  A `?base_url=<origin>` variant (matching the stats table's
  `upstream_base_url` values) reuses the first configured route's api key on
  that origin and falls back to the host-keyed anthropic 5h utilization;
  all success responses include a preformatted `left` string.
- **Web dashboard**: the 'Upstream Base URL' table (Request Statistic →
  Status Count) has a new "Usage Left" column — per-origin quota polled from
  the `base_url` quota endpoint (60s client cache on top of the 30s server
  cache; counts render as `6930/12000, 42%`); anthropic-compatible origins
  show the recorded 5h left percent.

### fix(transforms): `codestrong` 500s on Claude Code requests ending in a non-user turn

Claude Code routes through the `auditor` composite (`codesmall`/`codestrong`,
`codestrong` primary) to `codestrong`/`codesmall` → `code-strong-pi`/
`code-small-pi`, `anthropic-messages`-mode upstreams. Failing requests had a
`messages` array that did not end on `role: "user"`, and the proxy forwarded
that array to upstream unchanged. The upstream rejects any non-`user`-terminated
`messages` array with the same generic 400, regardless of which role is
actually trailing:

```
[ERROR] Upstream error response (500): {"type":"error","error":{"type":"api_error",
"message":"400 {\"type\":\"error\",\"error\":{\"type\":\"invalid_request_error\",
\"message\":\"This model does not support assistant message prefill. The
conversation must end with a user message.\"} ..."}}
[WARN] Composite primary auditor.codestrong returned 500
```

The 400 is wrapped as a 500 by the auditor composite's failover logging, but
the underlying condition is a request-shape mismatch, not an upstream outage
— retrying or failing over doesn't fix it, since the same bad `messages` tail
gets replayed to the fallback too.

**Confirmed root cause** (via full `LOG_LEVEL=trace` capture with an adequate
truncation cap — see below): the error text is misleading. The actual
trigger for the reproducing traffic was **not** real assistant-prefill at
all — it was a trailing `role: "system"` message inside `messages`:

```json
{
  "model": "code-strong-pi",
  "messages": [
    { "role": "user", "content": [{ "type": "text", "text": "hi" }] },
    { "role": "system", "content": "Available agent types for the Agent tool:\n- claude: ...\n- Explore: ...\n..." }
  ]
}
```

Claude Code emits this `role: "system"` message inline in `messages` (an
agent-definitions block for the `Agent` tool), in addition to the normal
top-level `system` field — confirmed present already at the `request_ingress`
stage, i.e. sent by the client as-is, not introduced by any proxy conversion
step. Real Anthropic tolerates a `role: "system"` entry inside `messages`;
this upstream does not, and reports the rejection using the same
"assistant message prefill" error text it uses for a genuinely-trailing
`role: "assistant"` message — the two failure modes are indistinguishable
from the error string alone.

Diagnosing this required two visibility fixes along the way, both now
permanent: (1) `LOG_LEVEL` must be `trace` to get full pipeline body/header
logs via `logPipelineStage` (the default `info` level and the always-on
500-char `claude.ts` debug preview are both insufficient to see the tail of a
large `messages` array); (2) `logPipelineStage`'s truncation cap
(`src/utils/logger.ts`) was raised from 128000 to 2,000,000 bytes — the
128000 cap was itself hiding the real tail of `messages` for
request bodies over ~128KB, which is why earlier `LOG_LEVEL=trace` captures
still didn't show the actual failing shape.

Fixed at the routing edge instead of patching a third-party dependency
in-place: a new Tier-2 `before_upstream` builtin,
`ensure_trailing_user_message`. **Revised three times** during testing
against the live upstream, the first two revisions built on the (incorrect)
assumption that a trailing `role: "assistant"` message was the only cause:
- First cut appended a synthetic `{role: "user", content: [...text:
  "Continue."]}` turn — still hit the same 400.
- Second cut folded the trailing assistant text into the preceding user
  message under a `[Previous assistant context]` prefix and dropped the
  assistant message — also still 400'd against the real upstream.
- Third cut stripped the trailing assistant message outright (no fold, no
  append) — still 400'd, because the actual reproducing traffic's trailing
  message was `role: "system"`, not `role: "assistant"`, so the builtin's
  `last.role === 'assistant'` check never matched and the builtin never ran.
- **Current (confirmed) behavior**: generalized to pop *any* trailing
  non-`user` message, looping until `messages` ends on `role: "user"` (or is
  empty) — covers both a trailing `role: "assistant"` (real prefill) and a
  trailing `role: "system"` (this incident), plus any other stacked
  combination. One `LOG_LEVEL=trace` line is emitted per stripped message
  (`[ensure_trailing_user_message] stripped trailing <role> message: ...`),
  recording exactly what was removed.

**Verified fixed** against live Claude Code v2.1.239 traffic through the
`auditor` composite (`codestrong`/`codesmall` → `code-strong-pi`/
`code-small-pi`) after rebuilding and restarting the proxy — the 500s no
longer occur.

No-op when `messages` is empty/absent or already ends with `role: "user"`.
Schema-gated to `anthropic-messages` (`BUILTIN_SCHEMA` in
`config-loader.ts`) since this shape constraint doesn't apply to
`openai-completions` bodies.

Applied to the `codestrong` and `codesmall` routes via a new
`[transforms.claude_anthropic_compat]` set (`proxy_config.toml`) — no other
route or model is affected. A transform-based fix was chosen over
patching the `@earendil-works/pi-ai` dependency in `node_modules` because it:
survives `npm install`/dependency version bumps untouched, stays scoped to
the one broken route via config rather than a global capability check, and
needs no upstream fix or `patch-package` machinery to take effect.

Tests: `tests/unit/request-transform.test.ts` (strip trailing assistant for
string and array content, strip trailing system message, strip multiple
stacked trailing non-user messages, strip-with-no-preceding-message, trace
log emitted per stripped message, no trace log when nothing stripped, no-op
on empty/absent/already-user-terminated messages),
`tests/unit/config-loader.test.ts` (schema-gate accept/reject for the new
builtin). See `docs/transforms-reference.md` for the builtin reference entry.

### feat(chat-completions): streaming usage chunk for anthropic-messages cross-mode

The anthropic-messages SSE converter (`src/handlers/chat-completions.ts`) dropped
usage entirely when translating Claude streams to OpenAI `chat.completion.chunk`
SSE — `/v1/chat/completions` streams via e.g. `glm-5.3-anth` ended with
`finish_reason` + `[DONE]` and no token counts, while the non-streaming response
included usage.

Per the OpenAI Chat Completions spec, a usage chunk is now emitted when the
client sends `stream_options: {"include_usage": true}`: an extra final chunk
with an empty `choices` array (`prompt_tokens`/`completion_tokens`/
`total_tokens`) just before `[DONE]`. Without `stream_options`, the stream is
unchanged (no usage).

Token capture: `input_tokens` from `message_start`, with `message_delta`'s
cumulative counts taking precedence when non-zero (GLM's anthropic endpoint
reports `input_tokens: 0` in `message_start` and the real counts only in
`message_delta`); `output_tokens` from `message_delta`.

Note: this is the canonical OpenAI shape. The openai-completions passthrough
path (e.g. `glm-5.3-comp`) is untouched — bigmodel attaches usage to the final
chunk regardless of `stream_options`, which remains a passthrough deviation.

Tests: `tests/unit/chat-completions-anthropic-streaming.test.ts` (both gating
and token mapping).

### fix(config): 5/6-element model entries rejected by `validateProxyConfig` and dashboard PUT

The per-entry `transforms` (index 4) and `max_tokens` (index 5) fields were
supported by the TOML parser, serializer, and route resolution, but two other
validation sites still only accepted lengths 1/3/4 — so any config that used
them failed:

- `validateProxyConfig` (`src/utils/config-loader.ts`) rejected model entries
  longer than 4 elements with
  `must be [target] or [target, base_url, api_key] or [target, base_url, api_key, mode] (got 6 elements)`
  at proxy startup / dashboard load, despite the config being valid. The 5- and
  6-element forms now validate (`max_tokens` at index 5 must be a number or
  digit string, mirroring the parser's `/^\d+$/` check).
- `isSafeModelArray` (dashboard PUT path, `validateAndNormalizeDashboardModels`)
  rejected 5/6-element arrays with `400 Invalid model entry`, so saving a
  config containing `transforms`/`max_tokens` via the dashboard/TUI or raw
  `PUT /dashboard/api/config` failed. Now accepts lengths 1/3/4/5/6. The PUT
  path still trims entries to the dashboard's 3-tuple display shape
  `[target, base_url, mode]` (mirroring `sanitizeDashboardCategoryConfig` on
  GET) — `transforms`/`max_tokens` remain config-file-only fields; a raw PUT
  including them is silently truncated (documented in code comments).

Root cause: parser, serializer, and validator each evolved and were unit-tested
independently, so their shared accepted-shapes contract drifted. Regression
guards added at three layers:

- Unit (`tests/unit/config-loader.test.ts`): 6-element entries accepted with
  number and digit-string `max_tokens`, rejected with non-numeric.
- Integration boot test (`testcases/08_regression` TC817): PUTs a category
  using all 6 documented array lengths at once, asserts zero `config_errors`.
  This test independently rediscovered the `isSafeModelArray` drift above.
- Integration behavior test (`testcases/15_config_parse` TC1519): a 6-element
  entry's `max_tokens` survives parse → `getModelRouteConfig().maxTokens`
  (the shape consumed by request building), not just the raw array shape.

`tests/README.md` gained a warning documenting this bug class (test
cross-function contracts, not each function in isolation).

### fix(tui): terminal-title activity dot no longer flickers

Identical `OSC 0` title writes are now skipped (dedupe cache in
`updateTerminalTitle`), so the once-per-second `·`/`.` activity alternation
only writes when the title actually changes. Note: the dot requires a terminal
that repaints its title on every OSC 0 write (iTerm2, Terminal.app); Warp
intercepts title sequences and may not show it — the in-TUI header `●`
indicator is unaffected.

### feat(responses): `conversation` param, retrieval endpoints, `store:false` honored; CONVERSATION → CONVERSATION_STATE

The stateful mode for `POST /v1/responses` with `openai-completions` upstream
(env renamed `CONVERSATION` → `CONVERSATION_STATE`, same `true`/`1` gating)
now covers the full stateful Responses API surface:

- **`conversation`** (string or `{"id": ...}`): the conversation thread's
  accumulated items are prepended to the request's `input`; this turn's new
  input items and output items are appended to the thread afterwards. The
  conversation ID is echoed in the response body. Combining
  `previous_response_id` and `conversation` in one request is rejected with
  `400` (spec forbids the combination) — previously `conversation` was
  silently ignored.
- **Retrieval**: `GET /v1/responses/{id}` returns the stored response object
  and `GET /v1/responses/{id}/input_items` returns the merged input items,
  both served from the in-process store (no upstream call, auth checks apply,
  only intercepted while `CONVERSATION_STATE` is enabled). Unknown, expired,
  or unstored IDs return `404`.
- **`store: false`**: such responses are no longer saved — they cannot be
  continued via `previous_response_id`/`conversation` nor retrieved.
- Both streaming and non-streaming responses now store the serialized
  response object for retrieval; conversation threads share the same TTL
  (3600s) and `CONVERSATION_MAX_ENTRIES` cap as response entries.

Docs: `docs/README_DETAILS.md` Known Limitations #4 rewritten for the new
behavior; `docs/configuration-reference.md` env table updated.

### feat(routing): effective-share recovery on success for primary and fallback targets

A successful request through a composite alias's primary or fallback target
now doubles its effective share back toward the configured value
(`recoverEffectiveCompositeShare`, `src/index.ts`), symmetric with the
halving-on-failure decay. Previously a decayed target (e.g. after transient
upstream errors) stayed decayed until process restart; recovery is gradual so
a flapping target does not ping-pong back to full traffic on one success.
Recovery logs when the share actually increases.

### refactor(transforms): thinking-strip on fresh conversations is now an opt-in builtin

The unconditional drop of `thinking: {type: "enabled"}` when the conversation
has no prior assistant thinking blocks (a DeepSeek Anthropic-compat workaround,
`400 "The content[].thinking in the thinking mode must be passed back to the
API"`) moved from `src/handlers/claude.ts` into a new Tier-2 builtin,
`strip_fresh_thinking` (`src/utils/request-transform.ts`), schema-gated to
`anthropic-messages`. Attach it via a transform set
(`deepseek_v4_anthropic_compat` now includes it) — spec-compliant Anthropic
upstreams no longer have client thinking intent silently dropped. The
unset-`thinking` → `{type: "disabled"}` injection remains unconditional.
`proxy_config.toml`'s `deepseek-v4-anth` entry now attaches the compat set.

### feat(config): per-entry `max_tokens` (fill + cap, all upstream modes); strict passthrough when unset

Model entries accept an optional `max_tokens` field (inline-table
`{target = "...", max_tokens = 8192}`, or positional-array index 5). It is a
bare number, not a quoted string.

- **Fill** (`anthropic-messages` routes, where the field is required): when the
  request omits `max_tokens`, the proxy fills this value
  (`src/handlers/claude.ts`).
- **Cap** (all upstream modes): applied centrally at the `before_upstream` hook
  in `runHook` (`src/utils/request-transform.ts`, after transforms run) — if the
  client or a transform sends a larger value, it is clamped down to the
  per-entry cap. Smaller client values pass through unchanged. The
  max-output-tokens field is resolved per upstream schema: `max_tokens`
  (`anthropic-messages`), `max_tokens`/`max_completion_tokens`
  (`openai-completions`), `max_output_tokens` (`openai-responses`),
  `generation_config.max_output_tokens`/`generationConfig.maxOutputTokens`
  (`gemini`).

**Unset → strict passthrough**: when the entry sets no `max_tokens`, the proxy
never sets, modifies, or caps the request's max-output-tokens field on any
endpoint. The `DEFAULT_MAX_TOKENS` env var (fill `8192` when omitted) was
removed as a consequence. The field round-trips through the dashboard config
save (parse → serialize → parse).

### feat(api): serve `/v1/chat/completions` by default; remove `DEV_PASS_THROUGH`

`POST /v1/chat/completions` (per-model routed passthrough) is now always
enabled — no `DEV_PASS_THROUGH=true` env var needed. The env var, its
`Env` type field, the startup warning, and docs references were removed;
`sse.sh` now expects streaming from this endpoint instead of the old
"not allowed" block.

Also fixed in the same path: models in `[models.free]` now use their
configured `api_key` for chat-completions passthrough (same rule as the
other routing paths) instead of forwarding the caller's key upstream.

### Docs: split README into focused reference docs

`README.md` shrank from ~1,634 to ~630 lines. Four new deep-dive docs
under `docs/` now hold the reference material, each linked from the
relevant README summary section:

- **`docs/api-endpoints.md`** — dynamic routing (moved from README),
  image input/output across format boundaries, OpenAI prompt-caching
  fields, and the Dashboard JSON API.
- **`docs/routing-and-aliases.md`** — `[models.*]` category lookup
  priority, `base_url`/`api_key` override + "who wins" tables,
  composite/fusion/coordinator aliases (incl. `toolset` recipes), token
  limits windowing, schedule aliases, and the routing-hierarchy
  level-by-level details.
- **`docs/architecture/auth-stats-protocol.md`** — wire-level contract for the
  remote auth and stats sidecars (requests, headers, OTAC linkage,
  dynamic routing override).
- **`docs/configuration-reference.md`** — all TOML sections
  (`[general]`, `[default_upstream]`, `[remote.*]`, `[transforms.*]`,
  `[privacy_filter]`) and environment variables, incl. sidecars.

The README keeps the endpoint table, the `upstream_mode` matrix, the
routing-hierarchy diagram + summary table, a new "Model Routing &
Aliases" summary, Deployment, and Testing. Cross-links were rewritten
to the new locations (including within the moved docs).

### Change: `@earendil-works/pi-tui` moved to devDependencies

The interactive TUI only runs in local/TTY sessions, not in the Docker
production image. `src/server.ts` now lazy-imports `src/tui.js`
(`await import`) only when `TUI` is enabled and stdin/stdout are TTYs,
so the server starts without `pi-tui` installed. This also resolves the
previous mismatch where the runtime image (`node:20-alpine`) was below
pi-tui's declared `node >= 22.19.0` requirement. Enabling `TUI` in a
container without devDependencies installed fails loudly at startup
(`ERR_MODULE_NOT_FOUND`).

### Fix: local privacy filter rejects word-underscore false positives

The base64url scanner in `src/utils/hash-detect.ts` (`detectB64Priority`)
treated any ≥20-char token with a digit and high entropy as a secret, so
descriptive identifiers such as `deepseek_v4_anthropic_compat` (length 28,
entropy 3.9, one `4`) were wrongly redacted to `⟦HASH:N⟧` sentinels. Added
two independent guards, each tuned with margin so real random keys are kept:

- **Max segment run ≥ 12**: the longest run between `_`/`-` separators must
  reach 12. Random keys have a long unbroken run (`ouV7bwSqBiabj9kei4_ZiIlcQW90nsx`
  → 18); word identifiers split into short dictionary segments (≤ 9).
- **Digit ratio ≥ 0.08**: random keys are digit-rich (≥ 0.16 in practice);
  word identifiers carry only an incidental digit (`v4` → ~0.04).

Pure-hex keys (`sk-6f1ea0…`, `6255cf92…`) are unaffected — they are caught
by the hex scanner, which still runs first.

### Fix: privacy filter dedups identical tokens across messages

`redactLocal` in `src/utils/privacy-filter.ts` minted a new `⟦HASH:N⟧`
sentinel for every detected span, so the same token (e.g. an API key
repeated across message turns) produced N distinct sentinels all mapping
to the identical value. Now one sentinel is reused per unique token
string, keeping the mapping minimal and the debug log accurate.

### TUI: help overlay, monthly heatmap view, hotkey updates

- **`h` hotkey**: opens a help overlay listing all hotkeys with short
  descriptions. Composite overlay keys (`a`, `m`, `f`, `e`, `l`, `d`) are
  also listed. Closes with `Esc` or `h`.
- **`Shift+u` hotkey**: toggle the token heatmap between the existing
  weekly view (weekday × hour) and a new monthly view (day-of-month 1–31).
  Both views build from the same usage stats data.
- **Hotkey consistency**: dashboard keys `C/S/T/D/P/L` now accept both
  lower and upper case; composite overlay keys `a/m/f/e/l/d` also accept
  both cases; bottom hotkey bar updated.

### Privacy filter: hash detection improvements

- **Require at least one digit** in base64url tokens (`detectB64Priority`).
  Real API keys almost always contain digits; this filters out descriptive
  identifiers like filenames while still catching real keys.
- **Default entropy threshold raised** from 3.0 to 3.5 across `detectHashPriority`,
  `detectB64Priority`, and `findHashSpans`, reducing false positives on
  descriptive identifiers.
- **Path-context exclusion** in `findHashSpans`: tokens preceded by `/` or `\`
  (path separator) or followed by a file extension (`.ext`, 1–5 chars) are
  now skipped as path components.

### Fix: privacy filter restore fallback gap

`restorePrivacyResponse` in `src/index.ts` only restored sentinels for
`text/event-stream` and `application/json` responses. Other content-types
(e.g. `text/plain`, empty content-type) fell through unrestored, leaking
`⟦HASH:n⟧` sentinels to the client. Added a text fallback that buffers and
restores any remaining content-type.

### Rename: `auth_url` → `auth_server`

The remote-auth sidecar URL field under `[remote.authentication]` is renamed
from `auth_url` to `auth_server`, matching the `record_server` naming on the
stats side (new form only — no legacy parsing). Updated: `ProxyConfig`
interface + both parser branches + serializer in `config-loader.ts`; the
single accessor in `src/index.ts`; README (quick-start TOML, protocol section,
mermaid diagram, config-reference table, `DEV_NO_KEY` row); the two
`docs/nginx_conf/*/USAGE.md` notes; `proxy_config.example.toml`; and the
unit / `15_config_parse` test fixtures.

### Config schema: `[remote.authentication]` + `[remote.recording]`

The sidecar config is restructured under a new `[remote]` namespace (new form
only — no legacy parsing):

- **`[general] auth_url` / `auth_with_model` / `auth_with_body` /
  `auth_passthrough_with`** moved to **`[remote.authentication]`** (field names
  unchanged).
- **`[model_usage]`** renamed to **`[remote.recording]`**; **`record_url`** →
  **`record_server`**; **`record_body`** → **`record_response_body`**.

Updated: `ProxyConfig` interface, `parseSimpleToml` (section-header, quoted-key,
and unquoted-value parsers), `serializeProxyConfigToml`, all `src/index.ts`
accessors (`proxyConfig.remote?.authentication?.*` /
`proxyConfig.remote?.recording?.*`), README config-reference tables + protocol
section + mermaid diagram, `proxy_config.example.toml`, and the unit /
`15_config_parse` test cases.

### Rename: `access_token` → `one_time_auth_code` (OTAC) on auth/stats sidecars

The linkage header exchanged between the auth sidecar (`[general] auth_url`)
and the stats sidecar (`[model_usage] record_url`) is renamed from
`access_token` to `one_time_auth_code` (OTAC — one-time authorization code).
The semantics are unchanged: the auth response's `one_time_auth_code` header
is stored per-request and re-sent on the stats POST so a combined backend can
correlate the usage record with the authenticated principal. Renamed in:
`doAuthRequest` (header read), the `modelUsageOneTimeAuthCode` variable,
`recordModelUsageToRemote`'s `oneTimeAuthCode` parameter, and the stats POST
header. README + mermaid diagram updated.

### Feature: record non-2xx responses + `response_status` to stats service

Every usage record POSTed to `[model_usage] record_url` now carries a
`response_status` field (the upstream HTTP status; `0` when no response was
obtained). Non-2xx upstream responses are now recorded too — previously only
successful responses produced a record, so failures were invisible to the
collector. Non-2xx records carry all token counters at `0` (error bodies rarely
carry usage) and the real status. When `record_body = true`, the non-2xx
constructed error body is attached to `response_body` (parsed JSON for
JSON errors, raw text otherwise), matching the success-body behavior. Streaming
responses remain 200-or-bust (errors come as non-streaming JSON even when
`stream:true` was requested). `buildModelUsageRecordPayload` grew a required
`responseStatus` param; the two success call sites pass the real status, the
new non-2xx branch passes `response.status`.

### Feature: `auth_with_body` / `record_body` — forward full request/response bodies to sidecars

Two new config flags let the remote auth and stats sidecars see entire request
and response bodies (raw JSON, not base64):

- **`[general] auth_with_body = true`** (default `false`) — the `auth_url` call
  is deferred until after the request body is parsed (same timing as
  `auth_with_model`), and the entire parsed request body is forwarded as the
  `POST` body with `Content-Type: application/json`. The method switches from
  `GET` to `POST` only when a parsed body is available; on non-body-parsed
  routes (dynamic routes) it degrades to the bodyless form. Either
  `auth_with_model` or `auth_with_body` triggers the deferred path. The body
  sent is post privacy-filter / kompress / tool-blocklist, so redacted PII
  never reaches the auth sidecar.
- **`[model_usage] record_body = true`** (default `false`) — each usage record
  POSTed to `record_url` includes a `response_body` field: the parsed JSON
  object for non-streaming responses, or the accumulated raw SSE text (all
  events concatenated) for streaming responses. Streaming body capture is
  threaded through `createUsageTrackingTransformStream` via a new optional
  `collectBody` flag.

Implementation: `doAuthRequest` now takes an optional body string; the payload
builder `buildModelUsageRecordPayload` and recorder `recordModelUsageToRemote`
grew an optional `responseBody` argument; the two stats call sites (JSON +
streaming SSE) populate it. The README "Auth & Stats Service Protocol" section
documents both flags, and the mermaid diagram now shows the GET/POST auth form
and the optional `response_body` on the stats POST.

### Docs: auth & stats service protocol + dynamic-routing override spec

Documented the wire-level contract between the proxy and the two optional
remote sidecars (`[general] auth_url` and `[model_usage] record_url`) in a new
**Auth & Stats Service Protocol** section of the README, plus a mermaid
sequence diagram showing proxy ↔ auth/stats/upstream interaction. Documented
the design contract for the auth service returning a **one-time dynamic
routing override** in its response body (acting as a single-use alias config
entry: `target` / `mode` / `base` / `key` / `transforms`), which the proxy
would apply directly for that request and skip config-file model resolution.
The override is per-request and ephemeral; requires `auth_with_model = true`.
(README documentation only — no code change in this revision.)

### Feature: client-IP forwarding headers on auth / stats sidecar calls

The proxy now forwards the caller's client IP to the remote auth service
(`[general] auth_url`) and the stats recorder (`[model_usage] record_url`) via
two headers: `x-forwarded-for` (always set when a client IP is detectable) and
`x-real-ip` (set only when the caller did not already provide one, preserving
any explicit value from an outer proxy). The client IP is resolved by the
existing `getClientIp` helper (`cf-connecting-ip` → first `x-forwarded-for`
entry → `x-real-ip`). Added `getSidecarForwardedHeaders` in `src/utils/routing.ts`
alongside `addForwardedHeaders`; the latter is unchanged so upstream provider
calls (Claude/OpenAI/Gemini) keep carrying only `x-forwarded-for` as before.
`recordModelUsageToRemote` grew an optional `extraHeaders` parameter that the
two stats call sites (JSON response + streaming SSE) populate with the same
forwarding headers.

### Feature: Apollo config backend (`PROXY_CONFIG_APOLLO`)

Added [Apollo](https://www.apolloconfig.com/) (apolloconfig/apollo) as a third
config source alongside the local TOML file and Consul. One Apollo namespace
holds the *entire* `proxy_config.toml` content as a plain-text value; the
proxy fetches it via `GET {meta}/configs/{app_id}/{cluster}/{namespace}` and
runs it through the existing `parseSimpleToml()` + validation pipeline — no
Apollo SDK, no live-reload long-poll. Reload is on-demand via `/config-reload`,
the same model Consul uses.

`PROXY_CONFIG_APOLLO` points at a connection file:

```
apollo:
app_id = "proxyv3"
cluster = "default"
namespace = "test"
meta = "https://test-apollo-config.example.com"
access_key_secret = "<plaintext HMAC-SHA1 key>"
```

`access_key_secret` is the **plaintext HMAC-SHA1 key**. It is never sent
directly; each request is signed as `Authorization: Apollo
<app_id>:<base64(HMAC-SHA1(secret, "<timestamp>\n<path?query>"))>` with a
`Timestamp` header. The `enc:...` wrapper is a Portal storage-layer format and
is not handled here — if a deployment stores the key encrypted at rest, it must
be decrypted before being written to the connection file.

The Apollo `meta` host is **not** restricted to private/LAN addresses (unlike
Consul) — point it only at an Apollo instance you trust. Node-only: the
connection file is read with `fs`, so this backend is unavailable in the
Cloudflare Workers build.

Backend precedence when more than one is set: **Apollo > Consul > Path**.

**No live-update notifications.** The proxy does not subscribe to Apollo's
`notifications/v2` long-poll (nor Consul watches). After publishing a change
in the portal, call `GET /config-reload` (or restart) for it to take effect.
The proxy emits a `[WARN]` startup reminder when the Apollo backend is active.

### Refactor: Consul KV loader extracted to `src/utils/consul-loader.ts`

Moved `ConsulKvEntry`, `buildConsulKvUrl`, `parseConsulConfig`, and their
helpers (`decodeBase64`, `parseConsulArrayValue`, `parseConsulScalarValue`,
`applyConsulKvEntry`) out of `config-loader.ts` into a standalone module.
No behavior change. `config-loader.ts` now imports these via
`./consul-loader.js`.

### Breaking: `PROXY_CONFIG_URL` renamed to `PROXY_CONFIG_CONSUL`

The Consul-backend discriminator env var has been renamed to make room for the
Apollo backend. Update your environment:

```
- PROXY_CONFIG_URL=http://127.0.0.1:8500
+ PROXY_CONFIG_CONSUL=http://127.0.0.1:8500
```

No backward-compat alias is provided. The Consul host SSRF guard (loopback /
private-LAN only) is unchanged.

### Feature: `assemble_sse_chunks` builtin — SSE-to-non-SSE assembly for openai-completions

New builtin for the `after_upstream` hook on `openai-completions` routes. When an
upstream only supports streaming, attach this builtin alongside `before_upstream`
ops that force `stream=true` and `stream_options.include_usage=true`. The builtin
reads the SSE stream to completion and assembles all `chat.completion.chunk` events
into a single `chat.completion` JSON response returned to the client:

- Choices are grouped by `choices[].index` and sorted; supports `n>1` with
  out-of-order or interleaved chunks
- Text `content` deltas are concatenated per choice index
- `tool_calls` argument deltas are concatenated per `(choice index, tool-call index)`
- `finish_reason` is taken from the last chunk that carries it per choice
- `usage` is forwarded from the final chunk (requires `stream_options.include_usage`)

**Safety rails:**

- **Schema-gated at config load.** Declaring `assemble_sse_chunks` under any schema
  other than `openai-completions` now fails load-time validation with an error like
  `builtin "assemble_sse_chunks" requires schema "openai-completions" but set has
  schema "anthropic-messages"`. Without this gate, the builtin would silently emit
  `choices: []` on Claude/Gemini SSE streams, destroying the response.
- **Warns on content-type mismatch.** When the builtin is declared but the upstream
  returns a non-SSE content type (e.g. `application/json`), the proxy logs
  `assemble_sse_chunks: expected text/event-stream from upstream but got "..."`
  and passes the response through unchanged — no silent corruption.

Example config (see `proxy_config.transforms.example.toml` for full snippet):

```toml
my-model = {target = "actual-model-id", base_url = "https://...", api_key = "sk-...", transforms = "sse_to_completions"}

[transforms.sse_to_completions]
schema = "openai-completions"
before_upstream.ops = [
  {op = "set", path = "stream",         value = true},
  {op = "set", path = "stream_options", value = {include_usage = true}},
]
after_upstream.builtins = ["assemble_sse_chunks"]
```

Multiple transforms compose via comma-separated CSV (e.g.
`transforms = "max_tokens_rename,sse_to_completions"`). Sets at different hook
points never conflict; sets touching the same path at the same hook resolve
last-writer-wins (left-to-right). See the inline comments in
`proxy_config.transforms.example.toml` for the full conflict-avoidance notes.

Newest merged work, reverse-chronological.

### Tweak: config errors/warnings surface only at idle, not mid-held-message

Config errors and warnings in the periodic refresh now only surface when the
status bar is idle (no held message). Previously they would fire unconditionally
every 500ms, overwriting any in-progress success or action message. Now held
messages are preserved to their natural expiry; when the bar goes idle it shows
existing config errors (6000ms) or warnings (2000ms) before settling to 'Ready'.

### Tweak: TUI status-bar messages now have explicit hold durations

Error and result messages in the TUI bottom status bar previously cleared on the
next refresh (no guaranteed display time). They now hold for a fixed duration by
category: caught errors and config warnings hold 2s, config errors hold 5s, and
model test results (single and test-all) hold 6s. The minimum hold is now 1s —
the `setMessage` default changed from `0` to `1000ms`, so transient messages
that previously passed no duration also linger for at least one second.

### Fix: wildcard routing now works in all provider sections; `[models.FREE]` / `[models.EMBEDDING]` are canonical exact-only names

**What changed:**

Previously, `prefix-*` wildcard matching in Priority 2 was hardcoded to only
check `claude`, `gemini`, and `gpt` sections. User-defined provider sections
(e.g. `[models.nvidia]`, `[models.openrouter]`) were silently skipped — their
wildcard entries never matched, contrary to what the README documented.

Priority 2 now iterates all sections dynamically, giving every provider section
(built-in or user-defined) full `prefix-*` wildcard support. The two special
concrete sections — `[models.FREE]` and `[models.EMBEDDING]` — remain
exact-only and are explicitly excluded.

**Canonical section names:** `FREE` and `EMBEDDING` are now the documented and
example-config forms. Both names are case-insensitive (`free`/`FREE`,
`embedding`/`EMBEDDING` work identically at runtime).

**Routing priority (unchanged structure, corrected behaviour):**

| Priority | Match type | Sections checked |
|---|---|---|
| 1 | Exact key | All sections |
| 2 | `prefix-*` wildcard | All sections except `FREE`/`free`, `EMBEDDING`/`embedding`, `default` |
| 3 | `prefix-*` then `*` catch-all | `default` only |

**Files touched:** `src/utils/config-loader.ts` (Priority 2 wildcard loop),
`src/index.ts` (`EMBEDDING`/`embedding` fallback lookup, `FREE`/`free` section
check), `proxy_config.example.toml`, `proxy_config.toml_template` (section
headers updated to uppercase), `README.md` (routing table + callout corrected),
`tests/unit/config-loader.test.ts` (4 new `getModelConfig` cases).

### Breaking: unified sliding/calendar token-limit windowing

The global `global_token_limit` and per-alias composite `token_limit` previously
used two different windowing strategies — sliding for global, fixed-window
accumulator for composite. They now share one parser and one event-log-based
enforcement path, with both sliding and calendar-anchored durations supported.

**Duration vocabulary (shared by both limits):**

| Token | Shape | Cutoff |
|---|---|---|
| `1h`–`23h` | sliding | last N hours from now |
| `1d`–`6d` | sliding | last N days from now |
| `1w` | calendar | start of current calendar week (configurable start day) |
| `1m` | calendar | first day of current calendar month, 00:00 local |

**Breaking changes:**

- `1w` is now a **calendar week** (was: sliding 7 days from now).
- `1m` is now a **calendar month** (was: sliding 30 days from now).
- Composite alias limits no longer use a fixed-window accumulator that resets
  at a drifting boundary. They use a per-alias event log queried against the
  derived cutoff. State no longer needs `windowStartMs`/`accumulator` fields;
  persistence format changed to `compositeAliasStates` (legacy
  `compositeLimitWindows` records still load but with empty event logs).

**New config key:** `general.week_start_day = "monday" | "sunday"` (default
`monday`). Controls where the `1w` calendar cutoff lands.

**Migration impact:** there is no exact replacement for the previous rolling
7-day or rolling-30-day behavior. The closest sliding equivalents are `6d` and
`6d` respectively (max sliding day-count). Users who depended on rolling
windows should re-evaluate which duration best fits their use case.

**Files touched:** `src/utils/config-loader.ts` (type + parser +
`getCompositeTokenLimit` + `week_start_day`), `src/utils/dashboard-stats.ts`
(`WindowSpec`, `parseWindowSpec`, `getWindowCutoff`, `setWeekStartDay`,
composite storage rewrite, `getTokensInWindowSince`, 31-day retention,
persistence), `src/index.ts` (global check uses cutoff, simplified config
sync), `src/tui.ts` (panel uses cutoff).

### Fix: config sections losting on dashboard/TUI save

Four bugs in `src/utils/config-loader.ts` caused silent data loss when the
dashboard or TUI wrote the config back to disk:

- **`[privacy_filter]` dropped by serializer.** `serializeProxyConfigToml` had
  no branch for `config.privacy_filter`, so every setting (`filter_mode`,
  `filter_url`, `timeout_ms`, `max_chars`, `entropy_threshold`, `hash_min_len`,
  `whitelist_add`, `whitelist_remove`, `whitelist_file`) was silently discarded
  on save. Fixed by adding a `[privacy_filter]` emit block.

- **`[fetch]` dropped by both parser and serializer.** `parseSimpleToml` had no
  section-header branch for `[fetch]`, so `image_encode` and `timeout_ms` were
  never loaded into `config.fetch`. `serializeProxyConfigToml` likewise had no
  emit block. Fixed both. Also added `hash_min_len` to the `ProxyConfig.privacy_filter`
  interface (it was parsed but the field was missing from the type).

- **Transform `headers.set` / `headers.remove` lost on round-trip.** The
  serializer emitted `before_upstream.headers.set = {...}` and
  `before_upstream.headers.remove = [...]` correctly, but `parseSimpleToml`
  had no matching parse paths, so they were dropped on reload. Fixed by adding
  an inline-object parser for `<hook>.headers.set` and a `headers.remove` branch
  in the existing array handler.

- **`set`/`default` transform ops coerced non-string values to strings.**
  `serializeTransformOp` called `String(op.value)` before `JSON.stringify` for
  `set` and `default` ops, turning `value = 0` into `value = "0"`. Fixed by
  removing the premature `String()` coercion.

### Fix: TUI `cached` / `wrote` token columns now record all upstream usage shapes

The TUI/dashboard stats pipeline previously only recognized the Claude usage
shape (`cache_read_input_tokens` / `cache_creation_input_tokens`) and the
Responses-API shape (`input_tokens_details.cached_tokens`). Cache fields used by
other upstream shapes were silently dropped, so `cached`/`wrote` showed 0 even
when the upstream reported non-zero values. In several configurations streaming
responses recorded nothing at all.

Fixed locations (all in `src/utils/dashboard-stats.ts` unless noted):

- **`extractUsageFromResponsePayload` (non-streaming JSON responses).** The
  `cached` fallback chain is now `cache_read_input_tokens` (Claude) →
  `prompt_cache_hit_tokens` (OpenRouter) → `prompt_tokens_details.cached_tokens`
  (chat-completions / OpenAI / GLM) → `input_tokens_details.cached_tokens`
  (Responses). `wrote` now also falls back to `prompt_cache_miss_tokens`
  (chat-completions) in addition to `cache_creation_input_tokens` (Claude).
- **OpenAI-SSE streaming branch of `createUsageTrackingTransformStream`.** Same
  fallback chain applied; previously only `prompt_tokens` / `completion_tokens`
  / `total_tokens` were read, so cache fields from chat-completions SSE were
  dropped.
- **Responses-SSE streaming branch (new).** `event: response.completed` and
  `response.in_progress` frames were previously unmatched by either SSE branch
  (they have an `event:` line, so the OpenAI-SSE branch was skipped, but the
  Claude-SSE branch only matched `message_start` / `message_delta`). Streaming
  `/v1/responses` — both Responses-shaped upstream passthrough and the
  Claude→Responses / Completions→Responses conversion paths — recorded zero
  usage. The parser now reads `data.response.usage` (`input_tokens`,
  `output_tokens`, `total_tokens`, `input_tokens_details.cached_tokens`) for
  those event types.
- **`extractTokenCounts` in `src/converters/openai-to-claude.ts`.** When
  `/v1/messages` is routed to a chat-completions upstream, stats are extracted
  from the converted Claude-shape client response, so the converter must carry
  the cache field through. It previously mapped
  `prompt_cache_hit_tokens` / `input_tokens_details.cached_tokens` but not
  `prompt_tokens_details.cached_tokens`, dropping cache hits to `undefined` on
  this common path. Now uses the same fallback chain as
  `extractUsageFromResponsePayload`.
- **`??` short-circuit fix in `extractUsageFromResponsePayload`.** The
  multi-shape fallback chain originally returned a literal `0` from the
  `prompt_tokens_details` ternary when that field was absent — and since `??`
  does not fall through on `0`, a Responses payload with only
  `input_tokens_details.cached_tokens` resolved to `0` instead of the actual
  value. Caught by a regression test; both ternaries now return `undefined`
  when their nested field is absent so the chain falls through correctly.

**Verification:** `glm-5.2-comp` (chat-completions upstream) with a warm GLM
prompt cache now records `cached += 64` per request, matching the upstream
`prompt_tokens_details.cached_tokens: 64` exactly. `in`, `out`, `total` were
already correct and remain so. `glm-5.2-anth` (anthropic-messages upstream) was
already correct via `cache_read_input_tokens`.

**Known limitations (unchanged, spec-driven):**
- `/v1/responses` exposes no cache-write field in its usage spec, so `wrote`
  stays 0 for that API.
- `completion_tokens_details.reasoning_tokens` / `output_tokens_details.
  reasoning_tokens` remain bundled inside `out` — not surfaced as a separate
  column.

### Add: `/v1/interactions` (Gemini) → `openai-completions` image preservation

### Add: `/v1/interactions` (Gemini) → `openai-completions` image preservation

`convertGeminiInteractionsToOpenAI` (`src/handlers/openai.ts`) previously
extracted only text from each turn's parts, silently dropping `inline_data` /
`inlineData` image parts. This affected any `/v1/interactions` client (Gemini
Interactions SDK shape) routed to an `openai-completions` upstream — image
inputs were lost.

Two sub-paths are fixed using a new shared helper `geminiPartsToOpenAIContent`:

- **Contents-format branch** (Gemini generateContent shape): each `parts` array
  is converted via the helper, emitting OpenAI `image_url` data-URI parts for
  any `inline_data` / `inlineData`. Text-only content still collapses to a
  joined string (wire shape preserved).
- **Array-of-turns `input` branch** (TC203-style): string content preserved
  unchanged; array content (Gemini parts shape) routed through the helper.
- Both snake_case (`inline_data.mime_type`) and camelCase (`inlineData.mimeType`)
  accepted.
- `thought:true` text parts are skipped (thinking markers; not part of content
  body in this direction).

**Known limitation (left as-is):** `convertGeminiGenerateContentToOpenAI`
still drops `inline_data` parts on the `funcCallParts` branch — i.e. a Gemini
model turn that emits both a `functionCall` *and* an image in the same turn.
This is a rare edge case (image-generation-with-tools models), and OpenAI's
spec does not define assistant `tool_calls` turns with array image content.
See README "Image input/output across format boundaries" for the limitation
listing.

**Files**: `src/handlers/openai.ts` (new `geminiPartsToOpenAIContent` helper,
updated both branches of `convertGeminiInteractionsToOpenAI`, exported that
function for testability).

**Tests**: 5 new in `tests/unit/gemini-to-openai-image.test.ts` —
snake_case `inline_data`, camelCase `inlineData`, array-of-turns image
preservation, text-only collapse (regression), TC203 string content
(regression).

### Add: `/v1/responses` → `anthropic-messages` / `gemini-generatecontent` image preservation

`/v1/responses` clients sending `input_image` parts previously lost them on every
non-passthrough route — the chain routed through `convertResponsesToChatCompletions`
which emitted a `[Image input]` placeholder string, then a local
`completionsBodyToClaudeBody` copy in `responses.ts` that itself dropped array
content. Both gaps are closed:

- **`src/converters/responses-to-completions.ts`** — `convertContentToString`
  renamed to `convertResponsesContentToCompletionsContent`. It now returns
  Chat Completions `image_url` parts (object form `{url, detail?}`) for each
  Responses `input_image` part, instead of the `[Image input]` placeholder.
  Text-only content still collapses to a string (wire shape preserved).
- **`src/handlers/responses.ts`** — `handleAsAnthropicMessages` and
  `handleAsGemini` now reuse `completionsToClaudeBody` from `./openai.js`
  (awaited, async). The previous local `completionsBodyToClaudeBody` is kept
  for reference with a deprecation comment — do not add new call sites.

This reuse also fixes three latent bugs on these routes that the local copy had
fallen behind on: consecutive `tool` messages are now grouped into a single
user turn (Claude requirement), `reasoning_content` is now preserved as
`thinking` blocks, and `image_url` parts become Claude `image` blocks (data:
URI decoded in-process; http(s) fetched via the SSRF-guarded
`fetchImageAsInlineData` and optional `[fetch] image_encode` sidecar).

**Files**: `src/converters/responses-to-completions.ts` (renamed helper +
image preservation), `src/handlers/responses.ts` (reuse + deprecated local
copy retained with comments).

**Tests**: 5 new in `tests/unit/responses-completions-roundtrip.test.ts` —
data-URI input_image end-to-end into Claude `image` block, http input_image
through the sidecar fetch, text-only collapse (regression), object-form
`{url, detail}` normalization, image_url preserved as array content.

### Add: OpenAI `image_url` → Responses `input_image` (Completions → openai-responses)

`completionsToResponsesBody` (`src/handlers/openai.ts`) now forwards `image_url`
content parts as Responses API `input_image` parts. Closes the gap where an
OpenAI SDK client sending `image_url` to `/v1/chat/completions` or
`/v1/interactions` routed to an `openai-responses` upstream silently lost images
(the old converter used `openAIContentToText`, which filtered to text only).

Unlike the Gemini and Claude directions, no in-proxy image fetch is needed: the
Responses API accepts image URLs natively, so the `image_url` object
(`{url, detail?}`) is passed through unchanged. This mirrors the existing
Claude → Responses pattern in `src/handlers/messages.ts:151`.

- Text-only array content still emits a single `input_text`/`output_text` part
  (no behavior change for non-image requests; existing tests pass unchanged).
- `image_url` parts are always emitted as `input_image` regardless of message
  role (matches `messages.ts`); text parts use the role-appropriate
  `input_text` / `output_text`.

**Files**: `src/handlers/openai.ts` (new `openAIContentToResponsesParts`
helper, updated regular-message branch in `completionsToResponsesBody`).

**Tests**: 3 new in `tests/unit/handlers.test.ts` — URL passthrough (with
`detail`), data: URI passthrough, assistant role mixing `output_text` +
`input_image`.

### Add: OpenAI `image_url` → Claude `image` block conversion (Completions → anthropic-messages)

`completionsToClaudeBody` (`src/handlers/openai.ts`) now converts `image_url`
parts into Claude `image` blocks (`{type:'image', source:{type:'base64',
media_type, data}}`). Closes the most common cross-mode gap: an OpenAI SDK
client sending `image_url` to `/v1/chat/completions` or `/v1/interactions`
routed to an `anthropic-messages` upstream previously lost images silently —
the converter read only `m.content ?? ''` and dropped array content.

- `data:` URI images are decoded in-process via the shared `decodeDataUri`
  helper (now exported from `src/converters/claude-to-gemini.ts`).
- http(s) image URLs are fetched via the existing SSRF-guarded
  `fetchImageAsInlineData` (and respect the optional `[fetch] image_encode`
  sidecar configuration).
- Text-only arrays still collapse to a string (preserves prior wire shape and
  existing tests; no behavior change for non-image requests).
- The `function` is now `async`; both call sites
  (`forwardCompletionsAsAnthropicMessages` in `openai.ts`, and
  `handleChatCompletionsPassthrough` in `chat-completions.ts`) `await` it.

**Known limitation**: Anthropic's Messages API restricts `image` blocks to
`user` role messages per spec. The proxy emits image blocks for any role
containing `image_url` (matches how `convertClaudeToGeminiRequest` and
`convertClaudeContentToOpenAI` already handle images cross-role); if Claude
rejects assistant-role images, that is the upstream's spec enforcement.

**Files**: `src/handlers/openai.ts` (helper `openAIContentToClaudeStringOrBlocks`,
async `completionsToClaudeBody`), `src/converters/claude-to-gemini.ts` (exported
`decodeDataUri`), `src/handlers/chat-completions.ts` (await call site).

**Tests**: 6 new in `tests/unit/handlers.test.ts` — data-URI decode, http→sidecar
fetch, text-only array collapse, thinking + image ordering, malformed data-URI
throws (Fail Loud), empty url skip.

### Add: optional image-encode sidecar for OpenAI `image_url` → Gemini `inline_data`

The Direction B conversion (commit 71e0a4c) now supports delegating the http(s)
image fetch + base64 encode to an external sidecar, as an alternative to the
default in-process fetcher. Useful when you want the proxy worker to stay
CPU-light (no in-process image download + base64) or want to centralize SSRF
policy / image fetching in a dedicated service.

Configuration (toml):
```toml
[fetch]
image_encode = "localhost:34567"   # shorthand; "http://localhost:34567" also accepted
timeout_ms = 40000                 # per-call timeout (optional, default 40000)
```
Env-var overrides: `IMAGE_ENCODE_URL`, `IMAGE_ENCODE_TIMEOUT_MS`.

**Sidecar contract**: `POST {image_encode}/encode` with body `{"url": "..."}`.
Response: `{"mime_type": "...", "data": "<base64>"}`. Any non-OK status,
non-JSON body, or missing `data` field is treated as a hard failure (Fail
Loud — no placeholder).

**Validation**: the sidecar itself must be reachable on localhost or a
private/LAN host (validated via `isInternalHost` at startup). The image URL's
own SSRF policy is the sidecar's responsibility — when a sidecar is
configured, the proxy skips its in-process `isInternalHost` check on the
image URL. `data:` URIs are still decoded in-process (no sidecar call) since
they carry no network fetch.

**Files**: `src/utils/image-fetch.ts` (new `resolveImageEncodeConfig`,
`setImageEncodeConfig`, `getImageEncodeConfig`, `fetchImageViaSidecar`),
`src/utils/config-loader.ts` (new `[fetch]` section + startup wiring),
`src/types/shared.ts` (new env vars), `proxy_config.example.toml`
(documented example).

**Tests**: 12 new in `tests/unit/image-fetch.test.ts` covering sidecar
delegation (success, non-OK status, missing data, non-JSON) and the resolver
(null, shorthand, trailing-slash strip, env precedence, timeout, non-local
rejection, non-http rejection, LAN-host acceptance).

### Add: bidirectional OpenAI `image_url` ↔ Gemini `inline_data` conversion

Two previously-silent image-drop gaps are closed. Image parts now flow across
the OpenAI ↔ Gemini format boundary in both directions.

**Direction A — Gemini → OpenAI** (existing route, surgical):
`convertGeminiGenerateContentToOpenAI` in `src/handlers/openai.ts` now emits
OpenAI `image_url` (data-URI) parts from Gemini `inline_data`/`inlineData`
parts. Used when a Gemini SDK client sends `generateContent` with images and
the route targets an OpenAI-compatible upstream. When a turn has image parts
its `content` becomes an array mixing text and `image_url` parts; text-only
turns keep string `content` (unchanged). Both snake_case and camelCase Gemini
field names are accepted on input. Assistant turns that also carry
`tool_calls` stay text-only — OpenAI does not support `image_url` on a
`tool_calls` turn.

**Direction B — OpenAI → Gemini** (new cross-mode route):
`/v1/chat/completions` requests with `image_url` blocks routed to a
`gemini-generatecontent` upstream now work end-to-end. New components:
- `convertCompletionsToGeminiGenerateContentBody` in
  `src/converters/claude-to-gemini.ts` — converts OpenAI Completions body to
  Gemini `generateContent` body (system → `systemInstruction`, images →
  `inline_data`, tools → `functionDeclarations`, tool_calls → `functionCall`).
- `forwardCompletionsAsGeminiGenerateContent` branch in
  `src/handlers/chat-completions.ts` — non-streaming + streaming. Streaming
  switches the URL to `:streamGenerateContent?alt=sse` and converts Gemini SSE
  chunks to OpenAI `chat.completion.chunk` SSE inline.
- `fetchImageAsInlineData` in `src/utils/image-fetch.ts` — server-side image
  fetch for http(s) `image_url` values, with an SSRF guard that blocks
  loopback / RFC1918 / link-local / mDNS hosts (reuses `isInternalHost`) and a
  20 MiB byte cap. `data:` URIs decode synchronously; http(s) URLs are fetched
  and base64-encoded.
- URL build fix at `src/index.ts:1186` for DEV_PASS_THROUGH mode so a
  `gemini-generatecontent` route resolves to `v1beta/models/<model>:generateContent`.

**Known limitations on the OpenAI-client → Gemini-upstream response path**:

1. **Tool-call and thinking parts of a Gemini response are dropped.**
   `convertGeminiGenerateContentToClaude` (`src/converters/gemini-to-claude.ts:191-203`)
   extracts `text` parts only. The streaming transformer handles text deltas
   and `finishReason`, but not `functionCall` or `thought` parts. Tracked as a
   follow-up — extending that converter would let tool-calls round-trip into
   OpenAI `tool_calls` and thinking into `reasoning_content`.

2. **Model-generated image output is not carryable to an OpenAI client.**
   This is a hard limit imposed by the target response schemas, not a missing
   converter:
   - The Anthropic API spec restricts `image` content blocks to **user**
     (input) messages — an assistant message carrying an `image` block is
     rejected by a real Anthropic-compatible upstream. The proxy's local
     `ClaudeContentBlock` type permits it structurally, but the spec does not.
   - The OpenAI Chat Completions response schema has no image-output content
     type at all (`choices[].message.content` is text, or an array of
     `text`/`image_url` parts where `image_url` is also input-only).
   So a Gemini model that returns `inlineData` (e.g. an image-generation
   model) cannot deliver those bytes to a `/v1/chat/completions` client
   through this cross-mode route, regardless of how the converters are
   extended. Model-generated images only reach clients through native Gemini
   passthrough (`:generateContent`/`/v1/interactions` client →
   `gemini-generatecontent`/`gemini-interactions` upstream), where
   `inlineData` passes through unchanged.

**Tests**: `tests/unit/gemini-to-openai-image.test.ts`,
`tests/unit/completions-to-gemini.test.ts`,
`tests/unit/image-fetch.test.ts`,
`tests/unit/chat-completions-gemini-streaming.test.ts` (20 new tests).

### Add: full-pipeline request/response header tracing (`LOG_LEVEL=trace`)

Extended the trace logs added above to also emit the request/response headers at
each pipeline stage (inbound, upstream-request, upstream-response, outbound).
Auth-bearing headers (`Authorization`, `x-api-key`, `x-goog-api-key`,
`anthropic-beta`) are stripped entirely (not masked) from the log output, per
the rest of the codebase's redaction convention. Emitted as `[STAGE-HEADERS]
endpoint: {…}` lines via `logger.trace`.

- `logPipelineHeaders()` added to `src/utils/logger.ts` alongside
  `logPipelineStage()`; wired at every fetch/return site across all handlers
  (`claude`, `messages`, `chat-completions`, `gemini`, `openai`, `responses`).

### Add: full-pipeline request/response body tracing (`LOG_LEVEL=trace`)

Added a new `trace` log level (below `debug`) that logs the message body at each
of the four stages of the proxy pipeline for every request:

1. **inbound** — the raw body as received at the endpoint, before any conversion.
2. **upstream-request** — the body after conversion, as sent to the upstream.
3. **upstream-response** — the raw body (or SSE chunks) received back from upstream.
4. **outbound** — the body (or SSE events) after conversion, as returned to the client.

This makes it possible to diagnose format-conversion bugs by capturing the exact
body at each stage instead of relying on synthetic reproduction.

- `Logger` (`src/utils/logger.ts`, `src/types/shared.ts`) gained a `trace` method,
  ordered below `debug` (`trace=-1, debug=0, info=1, warn=2, error=3`). `LOG_LEVEL=trace`
  now enables both trace and debug output; `LOG_LEVEL=debug` does not emit trace lines.
- New `logPipelineStage(logger, requestId, stage, endpoint, body)` helper in
  `src/utils/logger.ts` labels output as `[IN]`, `[UPSTREAM-REQ]`, `[UPSTREAM-RESP]`, or
  `[OUT]` and truncates bodies over 128,000 chars.
- Wired into every request handler (`claude.ts`, `messages.ts`, `gemini.ts`, `openai.ts`,
  `responses.ts`, `chat-completions.ts`) at all four stages, covering both streaming (SSE,
  via stream `tee()` so the client stream is undisturbed) and non-streaming paths.
- Fixed a bug in `createLogger`'s level-validation whitelist that would have silently
  downgraded `LOG_LEVEL=trace` to `info` (the whitelist array didn't include `'trace'`).

### Fix: synthesize a `signature` on signature-less thinking blocks

Anthropic's spec marks `signature` as REQUIRED on thinking content blocks, and
clients like `@ai-sdk/anthropic` reject responses missing it with a
`TypeValidationError`. Upstreams such as DeepSeek and bigmodel.cn's glm-5.2
emit reasoning without a signature, so both the non-streaming converter
(`src/converters/openai-to-claude.ts`) and the streaming converter
(`src/converters/streaming.ts`) now fall back to a shared constant
`SYNTHETIC_THINKING_SIGNATURE`. A constant (not a random/request-id value) is
used because the field is only consumed for Anthropic's own reasoning
round-trip verification — which does not apply to translated upstreams — so
nothing keys off its value; a constant keeps it reproducible and testable.

### Fix: `buildUpstreamUrl` dedupes any trailing `v\d+` version segment

`buildUpstreamUrl` (in `src/utils/routing.ts`) previously only stripped a
doubled version segment when both the `base_url` tail and the suffix head
were exactly `v1` or `v1beta`. Providers whose version segment is anything
else (e.g. Zhipu/BigModel `…/paas/v4`) got the suffix's `v1/...` appended
verbatim, producing a 404-inducing `/v4/v1/...` path under
`openai-completions` (and likewise for `anthropic-messages`,
`openai-responses`, and Gemini `v1beta/models/...:action` suffixes).

Rule 3 now matches any trailing `v\d+[a-z]*` segment on `base_url` against
any leading `v\d+[a-z]*/` segment on the suffix; the base's version wins and
the suffix's leading version is dropped. The previous workaround of
pre-baking the full path into `base_url` (still handled by rule 1) is no
longer required for these providers. +8 unit tests in
`tests/unit/routing.test.ts` (676 → 684), all passing.

### Test: add unit coverage for `thinking.ts` and `beta-features.ts`

Both `src/utils/thinking.ts` and `src/utils/beta-features.ts` are pure,
branch-heavy modules that previously had no direct unit tests (only indirect
exercise via converters). Added `tests/unit/thinking.test.ts` and
`tests/unit/beta-features.test.ts` covering normalization, budget
validation/adjustment, estimation, merge logic, and the anthropic-beta header
parse/validate contract (unknown features dropped, invalid JSON returns `null`
without throwing). +76 unit tests (600 → 676), all passing.

### Fix: dashboard now preserves per-model `upstream_mode` overrides on save

Editing a `[models.*]` inline-table entry on `/dashboard` silently dropped
the per-model `upstream_mode` (a.k.a. short alias `mode`) override on every
save. `modelEntryRow` only rendered inputs for the target alias and
`base_url`, and `collectConfigPayload` always sent `[target, base_url, '']`
— so the backend `applyDashboardConfigUpdate` (which already reads `value[2]`
as the mode) received an empty string and rewrote the entry with no override.
After the fix, each model row renders a per-model `<select>` seeded from
the GET payload's 3-element `[target, base_url, mode]` shape (mode index 2,
`(inherit)` option for empty), and the PUT payload carries the picked mode
at index 2. The existing inline-table aliases from `parseSimpleToml`
(`upstream_mode`/`mode`, `base_url`/`url`, `api_key`/`key`) round-trip
end-to-end now.

### Dashboard: in-page wizards for "Add target" and "Add model entry"

The two remaining `window.prompt`-based "add" flows on the `/dashboard`
config editor are now self-contained modal wizards, matching the look and
feel of the existing "Add composite alias" wizard (step indicator, Back /
Next / Cancel, Esc-to-close, inline `modal-status` validation, and the
`configDirty` gate that pauses stats auto-reload while the modal is open).

- **"Add target"** (`composite.<alias>` → Add target) replaces the prompt
  chain that asked for mode → model id → (coordinator only) role. For an
  empty alias it shows a mode-picker step; for a non-empty alias the mode
  is inferred from the existing targets and the wizard steps straight to
  the target-id + per-mode properties form (composite: share / routing /
  fallback, fusion: weight / role, coordinator: coord / role). Plain
  composite aliases with no per-mode shape skip the properties step, as
  before.
- **"Add model entry"** (`models.<category>` → Add model entry) replaces
  the single key prompt with a small form collecting model key, alias
  (upstream model id), and an optional base_url override, so the new row
  is immediately useful instead of seeded with blanks. Wildcard keys
  (`*`, `gpt-*`) are still allowed.
- The per-mode target-property fields and the cfg builder were extracted
  into shared module-level helpers (`compositeTargetFieldsHtml`,
  `buildCompositeTargetCfg`) so the alias wizard and the new target
  wizard cannot drift on field shape.
- Side fix: new model entries are now written with the correctly-shaped
  array (`[alias]` or `[alias, base_url, '']`) instead of the previous
  `['', '']` 2-element seed, which the backend config validator rejects.
  The old prompt path would have produced a row that failed validation
  on save once the user typed anything into it.
- The now-dead `promptAliasMode` helper has been removed.

### Fix: inline-table model entries now accept canonical key aliases

`[models.*]` inline-table entries (e.g. `"glm-5.2-a" = {target = "...", ...}`)
previously only parsed the short keys `mode` / `base_url` / `api_key`. Setting
the canonical `upstream_mode` (which the rest of the codebase and the category
sections use) was silently ignored, so a per-model override had no effect and
the model fell back to the category's `upstream_mode` — surfacing as 404s when
a model's `base_url` was an Anthropic-format host but the section defaulted to
`openai-completions`. The parser now accepts both forms, with the canonical
`upstream_mode` / `base_url` / `api_key` winning when both are present:

- `upstream_mode` | `mode`
- `base_url` | `url`
- `api_key` | `key`

### Feature: `ensure_tool_config_cache_ttl` builtin (system → injection points)

The `ensure_tool_config_cache_ttl` builtin now translates Anthropic-native
prompt caching on the system prompt into the litellm/Bedrock-bridge
convention. It reads `cache_control` from `body.system` content blocks (the
array-of-blocks shape — a plain-string `system` is ignored) and appends a
`{location:"tool_config", control:{...}}` entry to
`body.cache_control_injection_points` when no `tool_config` entry already
exists (caller-provided entries win). The serialized body is reordered so
`cache_control_injection_points` lands after `tools`.

No-op when `system` is absent, is a plain string, or carries no block-level
`cache_control`. Attach via the existing `[transforms.bedrock_tool_cache_ttl_compat]`
set on any bedrock-via-litellm route that uses system-prompt caching. See
[docs/transforms-reference.md](./docs/transforms-reference.md).

### Fix: TOML save path now preserves `[transforms.*]` and `[transform_defaults]`

`serializeProxyConfigToml` (used by `persistProxyConfigToPath`, which backs
every TUI and dashboard-driven config save) had no branch for `transforms` or
`transform_defaults`. As a result, any edit through the TUI or dashboard
silently dropped every `[transforms.<name>]` section and the
`[transform_defaults]` table on save. On reload, `[models.*]` entries still
referenced transform-set names that no longer existed, so `validateAllTransforms`
emitted per-reference errors and transform resolution produced empty sets.

The fix adds serialization for transforms (schema, per-hook `ops`/`builtins`,
`anthropic_beta_map`) and `transform_defaults`, and extends the round-trip
integrity check in `persistProxyConfigToPath` to assert transform-set names and
`transform_defaults` keys survive — so this class of silent loss is now caught
at save time.

Known pre-existing gap (not addressed here): `parseSimpleToml` has no branch
that consumes `before_upstream.headers.set` / `headers.remove` (or the
`response_egress` equivalents). The engine reads these fields
(`applyHeaderTransforms` in `src/utils/request-transform.ts`), but they cannot
currently be expressed in TOML. The serializer now emits them when present, so
the on-disk form is correct; closing the parse-side gap is tracked separately.

### Fix: config validator accepts `sdk://` `base_url`

`validateProxyConfig` previously rejected any non-`http(s)` scheme in
`default_upstream.default_base_url`, `[models.*].base_url`, and per-model
overrides. This flagged valid `sdk://` entries (e.g.
`models.free.llama3.base_url = "sdk://chatjimmy.ai/api"`) as
`base_url must use http or https protocol, got: sdk:`. The `sdk://` scheme is
a project-internal convention rewritten to `https://` at request time by
`src/utils/sdk-handler.ts`, so it is now accepted alongside `http`/`https`.
Added a positive `sdk://` unit test; the existing `ftp://bad` rejection case
still holds.

### Tests: unit coverage for `hash-detect.ts`, handlers, `config-loader.ts`, `validation.ts`

Closed the largest coverage gaps flagged in the test-coverage review by adding
four unit-test files:

- **`tests/unit/hash-detect.test.ts`** (47 cases) — full coverage of the
  security-sensitive redaction scanner: `shannonEntropy`, `detectHashPriority`
  (HIGH/LOW/NO branches, hexspeak whitelist, ordered-sequence filter, entropy
  threshold, custom minLen), `detectB64Priority` (length floor, pure-hex skip,
  entropy bar), `findHashSpans` (hex+b64 merge, overlap dedupe, left-to-right
  ordering), and `buildWhitelist` (add/remove, file ingestion, comment
  stripping, short/non-hex entry filtering).
- **`tests/unit/handlers.test.ts`** (30 cases) — covers the exported pure
  transformation helpers from the four big handlers: `completionsToClaudeBody`
  (system extraction, tool_calls/tool_result grouping, reasoning_content→
  thinking, tool mapping, stop normalization), `completionsToResponsesBody`
  (instructions lift, input_text/output_text, function_call/output mapping,
  passthrough fields), `claudeJsonToSyntheticCompletions` (text/tool_use/
  thinking conversion, finish_reason mapping, usage totals), and
  `isGeminiRequest` (path/URL classification).
- **`tests/unit/config-loader.test.ts`** (103 cases) — covers `parseHumanTokenLimit`,
  `formatTokenLimit`, `normalizeHookAlias`, `parseSimpleToml` (all sections +
  inline tables, multi-line arrays, legacy aliases, `anthropic_beta_map`),
  `validateTransformSet`/`validateAllTransforms`, `getModelConfig`
  (exact/wildcard/default-catch-all precedence), `getModelRouteConfig`
  (direct/composite/schedule resolution + cycle detection + wildcard
  substitution), `validateProxyConfig` (model/composite/schedule/base_url
  rules), `getModelNamesInConfig`, `findAliasNameConflicts`/
  `stripConflictingAliases`, self-referencing composite target detection,
  `getConfiguredModelIds`, `getAllowedHostsFromConfig`,
  `getCompositeAliasMode`, and `resolveScheduleTarget` (hour/weekday/weekend
  matching).
- **`tests/unit/validation.test.ts`** (95 cases) — covers every public function in
  `validation.ts`: `validateClaudeMessagesRequest` (required fields, numeric
  bounds, `stop_sequences`/`metadata`/`stream`), `validateClaudeMessage`,
  `validateClaudeContent`, every branch of `validateClaudeContentBlock`
  (text/image-base64/image-url/document/tool_use/tool_result/thinking/
  web_search_result), `clampThinkingBudget` (incl. interleaved-thinking
  exception and the `max_tokens < 1024` throw), `validateThinkingConfig`,
  `validateClaudeTokenCountingRequest`, `validateModelsRequestParams`,
  `validateOpenAICompletionsRequest`, and `validateAuthHeaders`.

The full network/streaming request paths in the four handlers remain covered
by the integration suite in `./testcases`; these unit tests target the
deterministic conversion logic that is hard to localize from integration
failures alone. Total unit-test count rises from 309 to 584, all passing.

### Feature: `filter_anthropic_beta` builtin + `anthropic_beta_map` config

Claude Code sends `anthropic-beta: header1,header2,...` to enable experimental
features. Upstreams that don't understand a given flag reject the request with
`invalid beta flag`. Following the model in
[docs/claude-beta-headers.md](./docs/claude-beta-headers.md) (mirrored from
LiteLLM's `anthropic_beta_headers_config.json`), this proxy now supports a
per-set allow/map table so operators can keep only the flags a given upstream
supports, and optionally rename them (e.g. Bedrock maps
`advanced-tool-use-2025-11-20` → `tool-search-tool-2025-10-19`).

**New builtin** `filter_anthropic_beta`, attached at `before_upstream`. Reads
the `anthropic-beta` request header (comma-separated form), filters each entry
through the owning set's `anthropic_beta_map`:
- entry not in the map → dropped (allowlist semantics);
- map value `""` (TOML's spelling of null) → dropped;
- map value is a non-empty string → emitted under that mapped name.

When no entries survive, the header is removed entirely.

**New config field** `anthropic_beta_map` on `[transforms.<name>]`:

```toml
[transforms.bedrock_beta_compat]
schema = "anthropic-messages"
anthropic_beta_map = {"computer-use-2025-01-24" = "computer-use-2025-01-24", "advanced-tool-use-2025-11-20" = "tool-search-tool-2025-10-19", "unsupported-feature" = ""}
before_upstream.builtins = ["filter_anthropic_beta"]
```

See [docs/transforms-reference.md](./docs/transforms-reference.md) §
`filter_anthropic_beta`.

**Bug fix — `before_upstream` header transforms were discarded.** Every
`before_upstream` call site destructured only `{ body }` from `runHook(...)` and
threw away the returned `headers`, so the existing `headers.set` /
`headers.remove` knob had no effect since it was introduced. All twelve call
sites in `handlers/{messages,chat-completions,responses,openai,gemini,claude}.ts`
now capture `headers` back and thread it into the upstream `fetch()`. This was a
prerequisite for `filter_anthropic_beta` (which mutates headers) and also fixes
the pre-existing `headers.set`/`headers.remove` mechanism.

### Rename: canonical hook names `endpoint_readin`/`endpoint_writeout` → `request_ingress`/`response_egress`

The transform-hook names `endpoint_readin` and `endpoint_writeout` were opaque
jargon (a prior review at `docs/review_of_transforms_hooks_implementation.md`
flagged this). They are now renamed to the self-describing
`request_ingress` / `response_egress` everywhere: TypeScript types
(`TransformSet`, `HookPoint`, `HookKey`), runtime keys, validator, error
messages, README, `docs/transforms-reference.md`, `proxy_config.example.toml`,
`proxy_config.transforms.example.toml`, and tests.

**Backwards compatibility**: `endpoint_readin` and `endpoint_writeout` remain
accepted as legacy aliases in `proxy_config.toml` — the existing
`normalizeHookAlias()` mechanism was simply flipped so the alias direction now
maps old → new canonical. Existing configs continue to load unchanged. The
`HOOK_KEYS` parser set still contains both names.

The other three hooks (`before_conversion`, `before_upstream`, `after_upstream`)
are unchanged — they had no aliases and still don't.

### Feature: schema-aware tool-arg coercion on the `:generateContent` egress path

Antigravity's Gemini endpoint validates the model's tool calls against each
tool's Go argument struct. Weak-model tool calling on `deepseek-v4-*` produced
JSON type mismatches — most commonly a scalar where an array is declared —
which Antigravity rejected as `invalid tool call error (invalid_signature)
… cannot unmarshal string into … of type []string`. See
[docs/review_of_antigravity_gemini_with_ds_tools.md](./docs/review_of_antigravity_gemini_with_ds_tools.md)
(§ "Optional fix — schema-aware egress type-coercion pass").

The proxy now coerces tool-call args against the inbound tool schema at the
single egress converter, following the existing per-request-state convention:

- `src/converters/openai-to-gemini.ts` — new `geminiToolSchemas`
  `Map<requestId, Map<name, schema>>` (mirrors `geminiToolCallBuffers`), with
  `registerGeminiToolSchemas` / `clearGeminiToolSchemas`. `coerceArgsToSchema`
  is **coercion-only**: scalar→array wrap (recursing into `items`),
  scalar↔string, numeric-string→number/integer, `"true"`/`"false"`→boolean.
  It never fabricates missing required args and never drops unknown keys —
  uncoercible values pass through so the upstream can still reject honestly.
- `src/handlers/openai.ts` — registers `{name → parameters}` from
  `requestBody.tools[].functionDeclarations` at inbound, clears in
  `clearGeminiSSEState` (streaming + `finally` leak-guard) and on the
  non-streaming `generateContent` path.

Scope is deliberately narrow: it fixes the `[]string`-style unmarshal
rejections but leaves the omitted-required-arg errors (`Query is required`,
`TargetFile not found`, …) untouched, since fabricating those would violate
fail-loud (CLAUDE.md rule #8). Verified: the previously-failing
`multi-agents-test.py 2 1 3` run (`deepseek-v4-anth`, task `stale_or_dead_tests`)
now completes successfully.

### Fix: DeepSeek thinking-mode round-trip on the Gemini endpoint path

Requests entering via `/v1beta/models/<alias>:streamGenerateContent` and
forwarded to a DeepSeek upstream failed with HTTP 400 on any turn that replayed
a prior assistant tool call:

- `deepseek-v4-comp` (openai-completions): `The reasoning_content in the
  thinking mode must be passed back to the API.`
- `deepseek-v4-anth` (anthropic-messages): `The content[].thinking in the
  thinking mode must be passed back to the API.`

DeepSeek requires the reasoning/thinking block to be **present** (an empty
placeholder is accepted; no signature exists on its API) on assistant turns
that carried tool calls — the earlier "strip it" hypothesis was exactly
backwards. Antigravity's Gemini SDK replays thoughts without `thoughtSignature`,
so the real block can't be replayed, but an unsigned/empty one satisfies the
upstream. See
[docs/review_of_antigravity_gemini_with_ds_tools.md](./docs/review_of_antigravity_gemini_with_ds_tools.md).

Two `src` fixes:

- `src/handlers/openai.ts` — `forwardCompletionsAsAnthropicMessages` now
  ensures a leading `{type:'thinking', thinking:''}` block on every assistant
  message that has `tool_use` but no thinking block. The comp path is handled
  by a `default` transform op that sets `reasoning_content = ""`.
- `src/utils/config-loader.ts` — the custom `parseSimpleToml` gained
  bracket-counting multiline-array accumulation, so transform `*.ops = [ … ]`
  arrays spanning multiple physical lines are parsed (previously silently
  dropped, which also disabled `max_tokens_rename` and friends).
  `messages[role=assistant].reasoning_content` was added to
  `SCHEMA_PATHS['openai-completions']` so the op validates at load time.

Separately documented (no code change): the `invalid_signature` /
`invalid_args` tool-call errors seen in the same runs are Antigravity's
client-side validation of the model's own malformed tool calls, not a proxy
defect — the proxy preserves tool schemas and arg names intact through the
conversion chain.

### Fix: transport errors sanitized and mapped to 502 / 504

When an upstream `fetch()` rejects at the transport layer (DNS failure,
connection refused, TLS error, abort/timeout, malformed URL), the outer
request catch in `src/index.ts` previously returned **HTTP 500** with the
raw `error.message` echoed verbatim to the client. That message routinely
contains internal hostnames, ports, and filesystem paths from the underlying
socket error (e.g. `getaddrinfo ENOTFOUND internal-host.local:443`),
leaking infrastructure details.

Two new behaviors in `src/utils/errors.ts`:

- **`classifyTransportError(error)`** inspects the thrown error's `code`,
  `cause.code`, and `name` to distinguish failure modes. Node's `fetch`
  wraps every rejection as `TypeError: fetch failed`, so the real signal
  lives on `error.cause.code` (`ENOTFOUND`, `ECONNREFUSED`,
  `ECONNRESET`, `ERR_INVALID_URL`, …) or on `error.name`
  (`AbortError` / `TimeoutError`).
- **`createErrorResponse`** now calls the classifier when handed a plain
  `Error` with no explicit `customStatus`. The result:
  - DNS / connection / TLS / URL failures → **502** `upstream_unreachable`,
    message `"Upstream service unreachable"` (or `"Upstream URL is invalid"`
    for `ERR_INVALID_URL`).
  - abort / timeout → **504** `upstream_timeout`, message
    `"Upstream request timed out"`.
  - Anything that doesn't match the transport signatures falls through to
    the previous 500 behavior.

Sanitization is gated on `customStatus === undefined`, so the many call
sites that pass an explicit status with a hand-crafted message
(`createErrorResponse(new Error('Authentication failed.'), rid, 401)`,
the 413 body-too-large path, etc.) keep their crafted client-facing message.
`ClaudeProxyError` (which already carries a sanitized message via
`handleTargetApiError`) is also untouched. The original raw error message
remains in the server log via the existing `logger.error` line in the outer
catch.

The same classifier is also applied at the top of the composite / schedule
retry loop in `src/index.ts` (`runAttempt` catch). Previously the
share-decay branch was gated on `error instanceof ClaudeProxyError`, so a
target that failed at the transport layer (DNS / refused / TLS / abort)
skipped the penalty — composite routing would keep sending traffic to a
dead target instead of decaying its share toward the floor. Transport
errors are now classified in the catch, so `primary` and `fallback`
targets get their share decayed on 502/504 just as they already did for
upstream-returned 5xx. The retry-warn log line still uses the raw error
message so operators see the real socket error (e.g. `ENOTFOUND`) in logs.

### Change: `base_url` values validated once at config-load time

`validateProxyConfig` (`src/utils/config-loader.ts`) now runs a dedicated
`validateBaseUrls` pass over every `base_url` that will end up in a `targetUrl`
passed to `fetch()`. Previously an invalid `base_url` (e.g. an out-of-range
port like `http://localhost:123456`, or a non-http/https scheme) only failed
when a request actually hit the upstream — surfacing as an opaque 500 from
`new URL()` / `fetch()` throwing synchronously inside the handler.

Sources validated, mirroring `getAllowedHostsFromConfig`:

- `[default_upstream].default_base_url`
- `[models.*].base_url` (category level)
- per-model `base_url` overrides at array index 1 (entries of length 3, 4, 5)

Each invalid value is reported with its config path, so it surfaces through the
same channels as other validation errors: console at startup, dashboard status
bar via `config_errors`, TUI message line via `_validationErrors`, and the
`PUT /dashboard/api/config` 400 response that rejects saves. Empty/whitespace
values are skipped here (they fall back to the category-level URL, which is
validated separately).

### Fix: `/v1/models` falls back to local models when upstream URL is invalid

`handleModelsRequest` (`src/handlers/models.ts`) constructed the upstream URL
via `new URL(targetUrl)` *before* the try/catch wrapping the fetch. When
`targetUrl` was malformed (e.g. an out-of-range port like `123456` from a
misconfigured `[models.default] base_url`), `new URL` threw `Invalid URL`,
which escaped the catch and surfaced as a request error instead of returning
the locally configured model list.

The URL construction and the query-param population (`after`/`before`/`limit`)
are now moved inside the try block, so any malformed-upstream-URL failure falls
through to the existing warn-and-continue path and the response is built solely
from `extraModelIds` via `mergeClaudeModelsResponse`.

### Change: `/v1/models` is now exempt from auth

`GET /v1/models` (and `/v1/models?...`) no longer requires an auth header and
no longer triggers the `auth_url` sidecar. Previously every model-API path
went through the same auth gate (presence check on `Authorization` /
`x-api-key` / `x-goog-api-key`, then the optional `auth_url` validation),
which blocked SDK discovery / model-listing calls that legitimately have no
credential.

The exemption mirrors the existing treatment of `/health`, `/`, and
`/dashboard`: model listing is treated as public metadata.

Behavior change in `src/index.ts`:

- A new `isModelsListPath` flag (`path === '/v1/models' || path.startsWith('/v1/models?')`)
  is added to the auth gate.
- The presence-check failure (`!hasAuth && !devNoKey`) now also skips when
  `isModelsListPath` is true.
- `authUrl` is forced to `''` for the models-list path, so the sidecar call
  is skipped entirely — not just the presence check.

`/dashboard/api/*` writes are unaffected: they are still gated by
`[dashboard].api_key` via `validateDashboardApiAuth`, which runs in a
separate branch and is independent of this gate. All other model-API paths
(`/v1/messages`, `/v1/responses`, `/v1/chat/completions`, `/v1/embeddings`,
`/v1beta/models/*`) keep requiring auth as before.

### Fix: `inject_missing_tool_results` now handles a trailing `tool_use`

The `inject_missing_tool_results` builtin (`src/utils/request-transform.ts`)
had a loop bound of `i < msgs.length - 1` that skipped the final message in
the array. When an assistant message containing `tool_use` blocks was the
**last** message (no following user/`tool_result` message), the builtin did
nothing — forwarding a malformed conversation to DeepSeek's
anthropic-messages endpoint, which rejected it with
`tool_use ids were found without tool_result blocks immediately after`.

This is exactly the Codex flow: Codex replays the model's prior
`function_call` as the final input item, and the proxy's
`completionsBodyToClaudeBody` converter emits a trailing
`assistant(tool_use)` with no following user message.

The loop now visits every index. When a tool_use assistant has no following
user message, a consolidated `user` message with one placeholder
`tool_result` per unmatched id is appended. The same reordering logic
already used for the non-trailing case (constraint A: text-only assistants
move after the tool_result message) applies.

Also wired the builtin to `deepseek-v4-anth` in `proxy_config.toml` via a
new `deepseek_v4_anthropic_compat` transform set — previously the config
declared no `[transforms.*]` sections, so the builtin was inactive even
though it existed.

One existing unit test ("does not synthesize when the assistant is followed
by another assistant") codified the old, broken behavior. It is replaced by
a test asserting the corrected behavior: synthesis happens and the
text-only assistant is reordered after the synthesized `tool_result`.

### Fix: strip stale `content-encoding` from pass-through responses

Node's `fetch` (undici) auto-decompresses gzip/deflate/br upstream bodies but
leaves the original `content-encoding` and `content-length` headers on the
`Response`. Any handler that re-wrapped the (already-decompressed) body with
the copied upstream headers produced a Response whose headers claimed gzip
while the bytes were plain text. Clients using strict gzip decoding (e.g. the
TUI's own `fetch` call in `runModelTest`) then crashed with
`TypeError: terminated` / `Z_DATA_ERROR: incorrect header check`. The most
visible symptom: testing `glm-5.2-a` (mode = `anthropic-messages`,
`open.bigmodel.cn/api/anthropic` returns gzip) from the TUI always showed
`test failed glm-5.2-a (?) terminated`, while `curl` (lenient) succeeded.

**Two-layer fix:**

1. **Boundary strip in the Node adapter** (commit `f629c67`):
   `src/server.ts` — the non-streaming response path at line 136 was using
   `Object.fromEntries(response.headers.entries())`, which forwarded the
   stale `content-encoding: gzip` to the Node `http` response while
   `response.clone().text()` had already decompressed the body. Changed to
   use the existing `nodeResponseHeaders()` helper (which the streaming path
   at line 110 already used), stripping `content-encoding` + `content-length`
   consistently at the process boundary. This alone resolved the
   user-visible symptom for every code path.

2. **Defense-in-depth across internal handlers**: even with the boundary
   fixed, internal `Response` objects still had headers that disagreed with
   their bodies — a landmine for any future internal consumer (dev
   passthrough, transform hooks, response re-wrapping). Added
   `sanitizeUpstreamResponseHeaders(response)` to `src/utils/routing.ts`
   (strips `content-encoding` + `content-length`, returns a fresh `Headers`)
   and applied it at the 11 sites that build a new `Response` from a
   decompressed body with copied upstream headers:
   - `src/handlers/claude.ts` — streaming pass-through (L189) and
     non-streaming pass-through (L220) in `handleClaudeRequest`.
   - `src/utils/request-transform.ts` — `applyAfterUpstream` non-JSON
     fallback (L463) and JSON path (L478); `applyWriteoutBody` non-JSON
     fallback (L550) and JSON path (L568).
   - `src/index.ts` — `restorePrivacyResponse` streaming (L186) and JSON
     (L192); `endpoint_writeout` SSE rewrite (L2254); `endpoint_writeout`
     header-ops seed (L2270, also sanitizes the headers *before* feeding
     them into transform hooks); `applyCorsHeaders` (L280).

**Scope of the original bug:** any model with `mode = "anthropic-messages"`
whose upstream returns gzip and that went through `handleClaudeRequest`
non-streaming was affected. From the shipped config that was `glm-5.2-a`
(`open.bigmodel.cn/api/anthropic`). `openai-completions` models
(`minimax-*`, `deepseek-*`, etc.) were unaffected because their handlers
build a fresh `Response` with explicit clean headers after parsing the body.

**Files changed:**
- `src/server.ts` — non-streaming path now uses `nodeResponseHeaders()`
  (commit `f629c67`).
- `src/utils/routing.ts` — new exported
  `sanitizeUpstreamResponseHeaders(response)` helper.
- `src/handlers/claude.ts`, `src/utils/request-transform.ts`,
  `src/index.ts` — apply the helper at the latent re-wrap sites.

### Feat: make `wrangler` an optional peer dependency

Wrangler is only needed for Cloudflare Workers deployment (`npm run dev` /
`npm run deploy`). The Node server path (`npm run server`, Docker image,
`dist/server.js`) does not use it. Previously it was listed in
`devDependencies` and got auto-installed for everyone.

**What changed:**
- Moved `wrangler` from `devDependencies` to `peerDependencies` with
  `peerDependenciesMeta: { optional: true }` in `package.json`.
- Removed the three `sed` lines in `Dockerfile` that stripped `wrangler` from
  `package.json` before `npm install` — no longer needed since optional
  peerDeps are not auto-installed.
- `@cloudflare/workers-types` stays as a `devDependency` (still needed at
  build time by `tsconfig.server.json` to type the shared fetch handler in
  `src/index.ts`).

**Impact:**
- Node-only / Docker users no longer pull wrangler on `npm install`.
- Cloudflare Workers users must run `npm install wrangler` before
  `npm run dev` / `npm run deploy`. Without it, npm exits with
  `command not found: wrangler`.

**Files changed:**
- `package.json` — added `peerDependencies` + `peerDependenciesMeta`; removed
  `wrangler` from `devDependencies`.
- `Dockerfile` — removed the `RUN sed -i ...` block.
- `README.md` — reduced wrangler mentions from 2 to 1.

### Fix: dashboard UI tightening — narrower inputs and TUI label cleanup

**Dashboard:**
- `share` input box: narrowed to 60px in both the wizard modal and composite target rows.
- `upstream_mode` select: narrowed to 180px (previously used `class="wide"` spanning 2 grid columns).
- `token_limit` duration select: narrowed to 100px.
- `Add window` button: indented 16px to align with the "days" select in schedule window rows.
- Added `.sched-window-row` CSS for consistent window row layout (previously only inline).
- `.danger` button: slightly lighter red tint for better contrast.

**TUI:**
- Composite target row: changed `non-FB` label to `Fallback` when `fallback: 0`.

**Files changed:**
- `src/handlers/dashboard.ts` — input/select widths, Add window alignment, CSS additions.
- `src/tui.ts` — `non-FB` → `Fallback`.

### Feat: TUI/dashboard support for `coordinator` composite aliases

Builds on the `coordinator` composite mode (see entry below). The proxy itself
already routed `planner`/`executor` targets — this round wires the editor UX
so users can see, edit, create, and delete coordinator aliases from the TUI and
the web dashboard without hand-editing `proxy_config.toml`.

**What you see:**
- Composite aliases in the main TUI views and the `Edit Composite Aliases Config`
  overlay now render an `[O]` tag for coordinator aliases (alongside the
  existing `[F]` for fusion and `[C]` for plain share/primary/fallback).
- The Test-custom-model picker shows `[O]` / `[F]` / `[C]` per alias and groups
  all three at the top of the list.
- In `proxy_config.toml`, each coordinator target now renders as
  `coord:1 planner` (or `executor`) on its row in the editor overlay.

**Editing:**
- The TUI edit prompt for a coordinator target now shows `[p]lanner / [e]xecutor
  [coord]`; defaults to `p` or `e` based on the existing role. Both `p`/`e`
  short forms and the full `planner`/`executor` words are accepted.
- The dashboard's coordinator `<select>` renders `[p]lanner` / `[e]xecutor`
  (canonical `planner`/`executor` values are persisted to TOML).
- TUI/dashboard fusion editing mirrors the same convention:
  `[p]anel / [j]udge / [s]ynth [weight]`, default `p 1`, accept `p`/`j`/`s`.

**Creating / converting empty aliases:**
- TUI `A` (add alias) and `M` (add target on an empty alias like `xxx`/`yyy`)
  now route through a new `Mode for <alias>` picker — choose `composite`,
  `fusion`, or `coordinator` first, then proceed to the model picker. The
  chosen mode seeds the first target's fields so `getCompositeAliasMode`
  picks up the right mode on subsequent edits.
- Dashboard `Add composite alias` and `Add target` (on an empty alias) use
  the same numbered-choice prompt. For coordinator, the dashboard also asks
  for a planner target at creation time so the alias is immediately usable.
- The TUI previously fell through to plain composite for empty aliases (since
  `getCompositeAliasMode` returns `'share'` rather than `undefined` for them).
  Now the mode picker fires before the model picker.

**Deleting an alias:**
- TUI `D` on an alias line (not just on a target row) now opens a
  "Delete composite alias `<alias>`?" confirmation and removes the alias via
  `removeCompositeAliasFromDashboard`. The toolbar hint `D del` already
  covered both cases.

**Backend plumbing:**
- `src/utils/config-loader.ts` — `CompositeTargetPatch.coord` added;
  `upsertCompositeTarget` now writes `coord` (mirrors the existing `fusion`
  handling: `null`/`0` deletes, must be a finite non-negative number); role
  validation now also accepts `'planner'`/`'executor'`.

**Bug fix in passing:**
- Newly-added `window.prompt(...)` strings in `handleDashboardPage` had to use
  `\\n` (not `\n`) so the outer HTML template literal doesn't collapse the
  escape into a real newline — which would break the inner JS single-quoted
  string literal at parse time (`SyntaxError: Invalid or unexpected token`).
  Fixed at `promptAliasMode()` and the coordinator role prompt in
  `add-composite-target`.

**Files changed:**
- `src/utils/config-loader.ts` — `CompositeTargetPatch.coord`,
  `upsertCompositeTarget` coord handling, role validation list.
- `src/tui.ts` — `getCompositeAliasMode` import; `[O]` tag in alias summary,
  custom-models list, model-test picker; coordinator target summary;
  `openModePicker`; `openAddAliasPrompt` mode-routing; `openTargetPicker`
  empty-alias detection (now uses the alias's own keys, not `getCompositeAliasMode`)
  + `forceMode` argument; coordinator add/edit prompts with `p`/`e` short
  forms; fusion prompts with `p`/`j`/`s` short forms; `openDeleteAliasConfirm`
  and `D`-on-alias handler; `removeCompositeAliasFromDashboard` import.
- `src/handlers/dashboard.ts` — `promptAliasMode()` helper;
  `add-composite-alias` mode pick + planner seed for coordinator;
  `add-composite-target` empty-alias mode pick + role pick (with
  `1`/`2`/`p`/`e`); coordinator `<select>` labels; fusion `<select>` labels.

---

### Feat: transforms — hook aliases, reference doc, debug log

Three usability improvements from the transforms/hooks review:

1. **Backward-compatible hook name aliases** (`src/utils/config-loader.ts`).
   `request_ingress` is now accepted as an alias for `endpoint_readin`, and
   `response_egress` as an alias for `endpoint_writeout` in `proxy_config.toml`.
   Both are normalized to the canonical name at config load time; the runtime
   engine and TypeScript types are unchanged. Old names continue to work as-is.

2. **`docs/transforms-reference.md`** — a single-page cheat sheet with three
   tables: hooks (name, alias, when, schema, side), Tier-1 ops (op, fields,
   effect, example), and Tier-2 built-ins (name, schema, what it does).
   Also documents the 5-element model array wire format and default-resolution
   order. Supersedes having to read the design doc for day-to-day authoring.

3. **DEBUG log line per request** (`src/index.ts`, `src/utils/request-transform.ts`).
   When `LOG_LEVEL=debug`, one line is emitted per request for any route that has
   transforms configured, showing the resolved set names and per-hook op/builtin
   counts:
   ```
   [req_…] [DEBUG] transforms: endpoint_readin=[deepseek_compat:b=1] before_upstream=[deepseek_compat:b=1,ops=1]
   ```
   `b=N` = N built-ins, `ops=N` = N Tier-1 ops. Only hooks with active ops are listed.
   Zero runtime cost when `LOG_LEVEL` is `info` or higher.

---

### Fix: transforms — `endpoint_readin` mutations discarded, and passthrough/generateContent paths never ran transforms

Antigravity agents routed to `deepseek-v4-anth` (DeepSeek's `anthropic-messages`-compatible
endpoint) failed on tool-using turns with
`Invalid schema for function 'glob_tool': "STRING" is not valid under any of the schemas
listed in the 'anyOf' keyword`. DeepSeek requires lowercase JSON-schema types
(`"string"`), but Gemini/proto-style tool schemas arrive with uppercase (`"STRING"`).
Three root causes:

1. **`endpoint_readin` change-detection was always false** (`src/index.ts`). Builtins/ops
   mutate the body object *in place*, so `runHook` returns the same reference. The guard
   `if (transformed.body !== parsedBody)` never fired, so the mutated (lowercased) body was
   discarded and the original forwarded upstream. Now always rebuilds the request from the
   transformed body. **This affected every `endpoint_readin` transform on every route**, not
   just this one — they silently no-op'd.

2. **Passthrough and generateContent paths bypassed transforms** (`src/index.ts`). The
   `/v1/chat/completions` passthrough (LocalOpenAIAgentConfig transport) and
   `:generateContent` (GeminiAPIEndpoint transport) paths dispatch through the final
   `runAttempt` with no `route`, so the hook never fired. The resolved route is now hoisted
   (`outerRoute`) and threaded into that `runAttempt`.

3. **`lowercase_tool_schema_types` skipped composition keywords**
   (`src/utils/request-transform.ts`). It only recursed into `properties`/`items`, so a
   `{type:"STRING"}` nested inside `anyOf`/`oneOf`/`allOf` (as in `glob_tool`) survived
   uppercase — exactly what the error named. Now recurses into all three.

**Config wiring** (`proxy_config.toml`): attached `deepseek_v4_anthropic_compat` to the
`deepseek-v4-anth` entry (it was defined but orphaned — resolving zero transforms) and added
`lowercase_tool_schema_types` to its `endpoint_readin.builtins`.

**Files changed:** `src/index.ts`, `src/utils/request-transform.ts`, `proxy_config.toml`.

### Fix: Antigravity/Gemini + local OpenAI agents — parallel tool calls corrupted through `anthropic-messages` streaming

Antigravity agents (`transport=GeminiAPIEndpoint` and `transport=LocalOpenAIAgentConfig`)
routed to `max-m3-anth` (MiniMax `anthropic-messages`, targeting `MiniMax-M3`) failed on
tool-using turns. Two root causes in `src/handlers/openai.ts`:

1. **Tool-call index collision.** When converting Anthropic SSE → Gemini, each completed
   `tool_use` block was emitted with a hardcoded `tool_calls[].index = 0`. Multiple parallel
   tool calls in one turn therefore collided in `geminiToolCallBuffer`, concatenating
   different tools' argument JSON into one string → `invalid_args`. Now uses the Anthropic
   content-block index.

2. **`message_delta` never flushed buffered tool calls.** The Anthropic `message_delta`
   finish event emitted a Gemini `finishReason` directly instead of routing through
   `processSSEBuffer`, so tool calls buffered at `content_block_stop` were never emitted.
   Now routes a synthetic finish chunk through `processSSEBuffer` to trigger its flush logic.

Additionally, the module-level single-flight SSE buffers (`anthropicToolBuffers`,
`anthropicThinkingBuffers`, `thinkStreamBuffer`, `geminiToolCallBuffer`) were made
per-request (keyed by `requestId`). Concurrent streams (parallel sub-agent tool calls)
interleave on the event loop across `await reader.read()`, so shared buffers corrupted
unrelated requests. Added `clearAnthropicSSEState`/`clearGeminiSSEState` cleanup on
`message_stop`/`[DONE]` and in stream-handler `finally` blocks to prevent leaks on error.

**Files changed:** `src/handlers/openai.ts`.

(Ported from `feature/fusion` commit `3182231`. The thinking/`reasoning_content`
round-trip parts of that commit — in `claude-to-openai.ts`, `openai-to-claude.ts`, and
`claudeJsonToSyntheticCompletions` — were already present on this branch.)

### Feat: `coordinator` composite mode (prewalk pattern)

New composite alias strategy that routes a conversation through **two models in
sequence**: a capable `planner` model handles requests during the planning stage,
then the proxy switches to a faster/cheaper `executor` model once the first
trigger tool call appears in the accumulated message history — reusing the full
context without re-reading anything. Mirrors the prewalk pattern from oh-my-pi.

**Config shape** (`[composite]`):

```toml
"smart-coder" = {
  "deepseek-v4-pro"   = {coord = 1, role = "planner"},
  "deepseek-v4-flash" = {coord = 1, role = "executor"},
  toolset = ["ExitPlanMode", "Edit", "Write"]
}
```

Each coordinator participant carries `coord = 1` and `role = "planner"` or
`"executor"`. The top-level `toolset` key lists trigger tool names:

| `toolset` value | Behaviour |
|---|---|
| absent | Use default set: `ExitPlanMode`, `Edit`, `Write`, `Bash`, `NotebookEdit` |
| `["Edit", "Write"]` | Only those tool names trigger hand-off |
| `[]` (empty) | Any tool call triggers hand-off |

Role targets may be direct model names, `[models.*]` aliases, `[schedule]`
aliases, or other `[composite]` aliases of any mode (resolved through the full
`getModelRouteConfig` chain; cycle detection applies).

**Files changed:**
- `src/utils/config-loader.ts` — `FusionRole` extended with `'planner'|'executor'`;
  `CompositeTargetConfig.coord`, `CompositeModelConfig.toolset`, `CoordinatorPlan`,
  `COORDINATOR_DEFAULT_TRIGGER_TOOLS`, `resolveCoordinatorPlan` added;
  `getCompositeAliasMode` now returns `'coordinator'` (highest precedence);
  parse/serialize/sanitize updated.
- `src/utils/coordinator.ts` — new file: `detectCoordinatorStage(messages, triggerTools)`.
- `src/index.ts` — coordinator dispatch block inserted before fusion routing.
- `tests/unit/coordinator.test.ts` — 27 unit tests (all passing; 23 originally landed with the feature, plus 4 config-round-trip cases added during finalization).

### Fix: `/v1/responses` → `anthropic-messages` — out-of-order `function_call`/text items produced consecutive assistant messages

Codex CLI routed through `max-m3-anth` (MiniMax's `anthropic-messages`-compatible endpoint,
targeting `MiniMax-M3`) failed on turn 2+ of a tool-using conversation with
`invalid params, 400 (2013)`.

Codex replays a prior turn's `function_call` item *before* the assistant `message` item
containing the text that preceded it in the original turn. `convertInputItemsToMessages`
(`src/converters/responses-to-completions.ts`) converted each input item independently and
in order, so this produced two consecutive `assistant`-role messages (`tool_use` then `text`)
before the `tool_result`. The Anthropic Messages API requires strict role alternation and a
`tool_use` block's `tool_result` to immediately follow the single message that emitted it —
MiniMax rejected the malformed shape with error 2013.

**Fix:** `convertInputItemsToMessages` now merges a `function_call` and any adjacent assistant
`message`/`reasoning` items belonging to the same turn — regardless of their order in the
`input` array — into a single assistant message carrying both `content` (text) and
`tool_calls`.

**Files changed:** `src/converters/responses-to-completions.ts`.

### Fix: thinking/reasoning round-trip for streaming, non-streaming, and Gemini paths

Surfaced by multi-agent live run (`tests/multi-agents-test.ts`, Claude + Gemini agents × `deepseek-v4-comp` / `deepseek-v4-anth`). Three converter bugs caused thinking-mode responses to drop `reasoning_content` on the way back to the client, breaking subsequent multi-turn requests that require the reasoning to be passed back.

**Bug 1 — `src/converters/streaming.ts`: `reasoning_content` gated behind `includeThinking` flag**

`delta.reasoning_content` (DeepSeek auto-thinking in streaming mode) was only forwarded as a `{type:'thinking'}` SSE block when `includeThinking` was set. Claude/Gemini agent SDKs never set that flag, so streaming thinking content was silently dropped.

Fix: removed the `if (includeThinking)` guard from the `reasoning_content` / `delta.reasoning` branch — `reasoning_content` is now always forwarded unconditionally. The flag continues to gate only the legacy `<think>` tag extraction path.

**Bug 2 — `src/converters/openai-to-claude.ts`: `reasoning_content` ignored in non-streaming path**

`convertOpenAIToClaudeResponse` iterated only `message.content`; `message.reasoning_content` from DeepSeek's non-streaming response was silently ignored, so the next assistant turn carried no thinking block.

Fix: a `{type:'thinking', thinking: inlineReasoning}` block is now prepended to `contentBlocks` when `message.reasoning_content` is present, before the text block — matching the order required by `convertClaudeToOpenAIRequest` for round-trip preservation.

**Bug 3 — `src/handlers/openai.ts:claudeJsonToSyntheticCompletions`: thinking blocks dropped**

When converting Anthropic-format responses to synthetic completions (used by the Gemini→Anthropic→Gemini path), `{type:'thinking'}` content blocks were discarded. Downstream converters (`convertOpenAIToGeminiGenerateContent`) therefore never saw `reasoning_content` and could not emit `{thought:true}` parts for the Gemini SDK's history.

Fix: thinking blocks are now collected and joined into a `reasoning_content` field on the synthetic `message`, using the existing `as unknown as Record<string, unknown>` cast pattern.

### Fix: TUI composite target editing — saves blocked by transform validation in parser

Two bugs prevented `Edit Composite Aliases Config` from saving changes to
`proxy_config.toml` and reflecting them in the overlay.

**Bug 1 — `parseSimpleToml` threw on transform errors, blocking every write**
(`src/utils/config-loader.ts`)

The `transforms_hooks` branch added `validateAllTransforms` at the end of
`parseSimpleToml` and threw if any transform set reference was undefined.
`persistProxyConfigToPath` calls `parseSimpleToml(serialized)` for its
round-trip integrity check — so every mutation save (add/edit/delete composite
targets) threw before touching the disk. The error was swallowed by the TUI
`try/catch`, leaving the overlay on stale data with no visible feedback.

Fix: remove the throw from `parseSimpleToml`. The function is a parser used in
multiple contexts; validation belongs only in callers that load config for
active use. Transform errors are now appended to `_validationErrors` (surfaced
in the dashboard status bar) and logged to stderr, but they no longer block
writes.

**Bug 2 — mutation `refresh(true)` silently dropped if a background poll was in-flight**
(`src/tui.ts`)

`DashboardApp.refresh()` bailed out immediately (`if (this.refreshing) return`)
when a concurrent refresh was running. The 500 ms background poll meant this
race was common: save succeeded, `refresh(true)` returned without re-reading the
file, overlay kept the old snapshot.

Fix: added `pendingMutationRefresh` flag. When `refresh(true)` finds
`this.refreshing`, it sets the flag instead of returning silently. The in-flight
refresh checks the flag in its `finally` block and immediately fires another
`refresh(true)` with a forced cache-bust. Additionally, mutation refreshes now
always pass `forceReload = true` to `loadConfig` regardless of the caller's
argument.

**Additional TUI fixes** (`src/tui.ts`)

- Edit prompt for composite targets now pre-fills current `share`/`primary`/
  `fallback` values instead of opening blank.
- Format hint corrected from `input <share> <primary> <fallback>` to
  `share [primary] [fallback]`.
- After validation errors in the edit prompt, `focusAlias` and `requestRender`
  are now called (matching the add-target path) so the composite overlay regains
  focus.
- Removed a leftover `console.error('[DEBUG] handleInput: ...')` that spammed
  stderr on every keypress in the composite overlay.

### Fix: Anthropic tool_use/tool_result pairing injection (Step 15)

Multi-agent live test (`tests/multi-agents-test.ts`, Codex agent × `deepseek-v4-anth`) surfaced:

```
messages.10: `tool_use` ids were found without `tool_result` blocks immediately after: ...
```

DeepSeek's Anthropic-compatible endpoint enforces that every `tool_use.id` in an
assistant message is immediately followed by a `tool_result` block in the next
user message. When the Codex SDK sends conversation history where tool results
are missing or out of position, the upstream rejects the request.

**Fix — new `inject_missing_tool_results` Tier-2 built-in**

Runs a single forward pass over the `messages` array. Handles three patterns
(all discovered during multi-agent live verification):

1. **Split-assistant**: the Codex SDK emits one Completions assistant turn as
   two messages — `{tool_calls}` then `"text"`. After conversion these become
   two consecutive assistant messages with the `tool_result` user messages landing
   AFTER the text assistant. We reorder: collect the text-only assistants as a
   tail, insert the consolidated `tool_result` user message immediately after the
   `tool_use` assistant, then re-append the tail. Result:
   `tool_use_asst → user(tool_results) → text_asst`.

2. **Scattered tool_results**: multiple `role:"tool"` Completions messages
   (one per call) become separate user messages. Anthropic spec (and DeepSeek)
   require all tool_results for one turn in a single user message. We merge
   consecutive pure-tool user messages into one.

3. **Missing tool_result**: after the above, if any `tool_use.id` has no
   matching `tool_result`, we synthesize a placeholder block with `content: ''`.

Bound to `deepseek-v4-anth` via a new `deepseek_v4_anthropic_compat` transform set
(`schema = "anthropic-messages"`). The schema-anchor gates application to
anthropic-messages routes only.

**Wiring fix — `handleAsAnthropicMessages` in `src/handlers/responses.ts`**

This handler (`/v1/responses` → `anthropic-messages`) was missing a
`before_upstream` hook call — it built the Anthropic-format body and fetched
directly. Added `route` and `upstreamMode` parameters and wired
`runHook('before_upstream', ...)` before fetch.

**Tests** — 10 unit tests in `tests/unit/request-transform.test.ts`:
text-next insertion, string-content insertion, multiple missing ids,
partial synthesis, all-present no-op, no-tool-use no-op, assistant-not-user no-op,
merge consecutive pure-tool messages, merge + synthesize, split-assistant reorder.

**Verified** — `tests/multi-agents-test.ts 0 0 2` (Codex × `deepseek-v4-anth`):
`tool_use ids were found without tool_result blocks` error no longer reproduces.
All 400 errors remaining are unrelated (thinking round-trip — Step 14).

### Fix: Multi-turn thinking-content round-trip vs DeepSeek thinking-mode

Multi-agent live test on port `7777` (`tests/multi-agents-test.ts`, 4 models ×
all agents × task #2) surfaced repeated `400` responses from DeepSeek upstreams
with:

> `The 'reasoning_content' in the thinking mode must be passed back to the API`
> `The 'content[].thinking' in the thinking mode must be passed back to the API`

Root cause: two conversion paths silently **dropped** prior-turn reasoning
instead of round-tripping it to the wire format the upstream expects.

**Smoking-gun #1 — Claude → OpenAI Completions** (`src/converters/claude-to-openai.ts`)

Both `convertClaudeToOpenAIRequest` and `convertClaudeTokenCountingToOpenAI`
iterated assistant content blocks but had no branch for `type: 'thinking'` —
those blocks were silently discarded. Each now accumulates
`thinkingParts: string[]` alongside `textParts` and `toolCalls` and emits the
joined string as a per-message `reasoning_content` field on the resulting
OpenAI assistant message (via the existing `as unknown as Record<string, unknown>`
cast pattern, matching `responses-to-completions.ts:194-196` and `openai.ts:444`).

**Smoking-gun #2 — OpenAI Completions → OpenAI Responses** (`src/handlers/messages.ts`)

`completionsMessagesToResponsesInput` (function-level, defined inline in
the file) had a `return null` for `thinking` content parts (the prior
shape was a degenerate 5-line helper that produced empty output for the
prior turn's reasoning). Rewritten to:

- Emit a Responses `reasoning` input item with a single `reasoning_text`
  part whenever the source message carries a per-message
  `reasoning_content` field, OR
- Emit the same `reasoning` item whenever an array-style `content` part
  has `type: 'thinking'` (using `part.thinking` as the text), without
  also emitting a redundant text message item.

Both fixes are scoped to round-tripping reasoning — they do not change the
non-thinking path.

**Tests:** new file `tests/unit/thinking-roundtrip.test.ts` (7 cases):

- emits `reasoning_content` on assistant message when a thinking block is present
  (Claude → Completions main converter)
- same for the token-counting converter
- multiple thinking blocks join into a single `reasoning_content` string
- no `reasoning_content` is emitted when there is no thinking block
- inline `reasoning_content` field on the assistant message emits a Responses
  `reasoning` input item (Completions → Responses)
- `content[]` with `{type:'thinking'}` emits the same `reasoning` input item
- no `reasoning` item is emitted when there is nothing to round-trip

165/165 unit tests pass after the change; `npx tsc --noEmit` is clean.

**Live verification (port 7777):**

Direct curl: `POST /v1/messages` to `deepseek-v4-comp` with `thinking.budget_tokens=1024`
and a multi-turn history (turn-2 assistant has `{type:"thinking", ...}` and
`{type:"text", ...}` blocks, turn-3 user asks a follow-up) returns **`200`**.
DeepSeek accepts the request — the prior reasoning round-trips end-to-end. The
proxy response keeps the throwaway `writeout_marker` `id` rewrite
(`"step12_response_path_active"`) to confirm the new build is live.

Multi-agent test (`tests/multi-agents-test.ts 0 0 2`): the prior
`reasoning_content must be passed back` failure mode no longer reproduces on
the same multi-turn shape that triggered it before the fix. Remaining
failures in that run are separate, pre-existing issues and are out of scope
for this entry: Anthropic-format `tool_use`/`tool_result` mismatch on
`deepseek-v4-anth` (different bug — Claude-format pairing invariant), agent
SDK package install errors (`@earendil-works/pi-agent-core` not on disk,
`opencode` binary not on PATH), and Codex-on-`openai-responses` returning
empty output for reasons unrelated to thinking content.

### Fix: Step 13a — validator now rejects unwalkable nested paths

`SCHEMA_PATHS` in `src/utils/config-loader.ts` whitelisted response-side paths
like `$response.choices[].message.content`, `$response.output`, and tool-call
chains such as `messages[].tool_calls[].function.name`. The Tier-1 op runner
(`applyOpToBody` / `parsePath`) can only target a single top-level segment, so
any of those paths would silently produce a literal-bracketed key on the body
when applied — corrupting the response. The validator now performs a
**two-pass** check: first the schema-vocabulary whitelist (already in place),
then a new `isPathWalkable` predicate that accepts only paths the engine can
actually execute:

- `$response.<field>` — single segment, no `.` or `[`
- `messages[].<field>` or `messages[role=X].<field>` — single segment after the
  bracket, no further nesting
- top-level names — single segment, no `.` or `[`

Anything deeper is rejected at load with a clear
`"[<hook>] path \"<…>\" … cannot walk it (nested arrays/objects)"` message that
points authors at the named built-ins (`lowercase_tool_schema_types`,
`recover_tool_message_name`) or a shallow path.

**Tests:**
+6 in `tests/unit/transforms-config.test.ts` covering nested `$response`,
shallow `$response.<field>`, nested `messages[].<sub>`, and the cross-schema
case.
+1 in `tests/unit/request-transform.test.ts` asserting that the engine — even
if a transform slipped past validation — never creates a literal-bracketed
key on a JSON body.

**Regression-checked:**
- `proxy_config.toml` still validates cleanly with zero errors against the new
  predicate (only `$response.id` is in use there, which is shallow and walked).
- `curl /v1/messages` through `deepseek-v4-comp` still rewrites the response
  `id` to `"step12_response_path_active"`; no literal `"$response.id"` field
  appears.

### Verify: Step 12 `$response.*` path resolution confirmed end-to-end

The throwaway `[transforms.writeout_marker]` set in `proxy_config.toml` now uses
`endpoint_writeout.ops = [{ op = "set", path = "$response.id", value =
"step12_response_path_active" }]`. After a fresh `node dist/server.js` on
`:7777`, a `curl /v1/messages` to `deepseek-v4-comp` rewrites the response's
`id` field to `"step12_response_path_active"` without creating a literal
`"$response.id"` field.

**Implementation and tests:**
- `parsePath` recognizes the `$response.` prefix and strips it before applying
  the existing shallow generic operation runner.
- Unit coverage verifies response-side `set`, `rename`, and `remove` operations.
- Nested response paths such as `$response.choices[].message.content` remain
  outside the shallow path runner and are still reserved for a future path-walk
  step.

### Verify: Step 11 `endpoint_writeout` body-op wiring confirmed end-to-end

A throwaway `[transforms.writeout_marker]` set was added to `proxy_config.toml`
with `endpoint_writeout.ops = [{ op = "set", path = "model", value =
"step11_writeout_active" }]`, and attached to `deepseek-v4-comp` via the
inline-table 5th-element `transforms = "deepseek_compat,writeout_marker"`
CSV. After a fresh `node dist/server.js` on `:7777`, a `curl /v1/messages` to
`deepseek-v4-comp` returns `"model":"step11_writeout_active"` — proving the
Step 11 `applyWriteoutBody` path is wired through config → resolver → central
writeout wrap.

**Two collateral fixes surfaced during verification:**

1. **Inline-table parser split on CSV commas inside quoted `transforms` value**
   (`src/utils/config-loader.ts`). The naive `tableBody.split(',')` treated
   `"deepseek_compat,writeout_marker"` as multiple fields. Replaced with a
   quote-aware splitter that tracks `inQuote` and only splits on unquoted
   commas. Multi-element inline-table entries with a CSV 5th field now parse
   correctly.

2. **Section-style `[transforms.<name>]` ops on multi-line arrays were
   silently dropped.** The single-line regex `^([\w.]+)\s*=\s*(\[.*\])$`
   doesn't match arrays spanning multiple lines. The new `writeout_marker`
   set is now written on one line so it matches.

**Response-path follow-up:** Step 12 now resolves the whitelisted shallow
`$response.<field>` prefix before applying generic operations. Nested response
paths remain outside the shallow runner.

### Feat: `endpoint_writeout` body ops + SSE per-event transforms (Step 11)

Closes the deferred hook gap from Step 1–9. The `endpoint_writeout` hook can now
mutate the response body (non-streaming JSON) and per-event SSE frames going
back to the client. Header transforms for this hook were already wired in
`index.ts`; this step adds the body half.

**Engine additions** (`src/utils/request-transform.ts`):
- `hasHookOps(hook, transforms)` — fast-path gate: returns `true` only if at
  least one declared set has a slot for `hook`. Used to skip all buffering
  work when no rules fire.
- `applyWriteoutBody(response, ctx)` — mirror of `applyAfterUpstream`, but on
  the client-schema response. Buffers JSON body, applies all declared
  `endpoint_writeout` ops left-to-right, returns a new `Response` with the
  rewritten body and the original status/headers. Non-JSON bodies and
  malformed JSON pass through unchanged. Returns the original `Response`
  unchanged when `hasHookOps('endpoint_writeout', …)` is false.
- `pipeEventTransformer(responseBody, ctx)` — wraps an SSE byte stream so each
  `data: {…}\n\n` frame passes through the writeout hook's per-event
  transformer before being written back. `[DONE]` sentinel is passed through
  unchanged. Non-data lines (comments, `event:`, `id:`) and non-JSON payloads
  pass through verbatim. Events whose transformer returns `null` are dropped.
- `transformSseEvent(…)` — internal helper that splits a single SSE event
  text block into data lines / other lines, runs the transformer on the
  parsed JSON payload, and re-emits the result.

**Central wiring** (`src/index.ts`):
The `endpoint_writeout` wrap section in `runAttempt` now does four things in
order on the response going to the client:

1. Set `streaming: true` on the writeout context when content-type is
   `text/event-stream` (was hard-coded `false`).
2. For non-streaming responses: call `applyWriteoutBody` to buffer and
   rewrite the JSON body (skipped for SSE — buffering would consume the
   pipeable stream and break streaming behavior).
3. For streaming responses: wrap `response.body` with `pipeEventTransformer`
   to rewrite events in flight, only if a writeout transformer was built.
4. Apply header transforms via the existing `runHook` path (unchanged).

The streaming guard preserves the existing behavior where stats extraction
already consumed a `response.clone()` — the original `response.body` remains
available for `pipeEventTransformer` to wrap.

**Tests** (`tests/unit/request-transform.test.ts`):
+14 tests in 3 new `describe` blocks (41 tests total, all passing):
- `applyWriteoutBody` (7): fast-path returns same Response when no
  transforms; active path applies ops; preserves status and headers;
  non-JSON content-type passthrough; malformed JSON passthrough; multi-set
  fold left-to-right; preserves header from outer response.
- `pipeEventTransformer (writeout SSE)` (4): fast-path returns `null`; drops
  events whose transformer returns `null`; rewrites payload when transformer
  returns a new object; multi-event sequence processing.
- `hasHookOps` (3): empty transform list; declared hook; different hooks.

### Fix: `proxy_config.toml` inline-table `transforms` field + Gemini SDK error handling (Step 10)

Three fixes that round out the Step 8 `deepseek_compat` / `minimax_compat`
work and harden the TUI/config path.

**Root causes and fixes:**

1. **5-element inline-table model entries failed validation**
   The Step 8 wiring added `transforms = "deepseek_compat"` to inline-table
   entries like `deepseek-v4-comp = {target = ..., transforms = "..."}`,
   which caused the inline-table parser to emit a 5-element array. The
   validator in `validateProxyConfig` only accepted 1/2/4-element shapes and
   rejected the new shape with *"must be [target] or [target, base_url,
   api_key] or [target, base_url, api_key, mode] (got 5 elements)"*.
   **Fix:** added a `value.length === 5` branch in the validator that runs
   the same per-field type checks (target/base_url/api_key/mode) plus a new
   `transforms must be a comma-separated string` check. `parseSimpleToml`
   already emitted 5-element arrays when the inline-table had a `transforms`
   key — only the validator was wrong. The 5-element array is the same
   shape `resolveModelRouteFromEntry` already consumed at index 4.

2. **Inline-table entries without `mode` still parsed correctly**
   `minimax-m2.7-high` and the `gemma-4-*` entries omit `mode` and rely on
   the section-level `upstream_mode = "openai-completions"` default. The
   Step 8 parser changes did not affect this path, but the validator now
   also accepts `mode = ""` for these entries.
   **Fix:** no code change needed — the 4-element branch already permitted
   empty `mode`. Verified by re-running `validateProxyConfig` against the
   full config.

3. **Gemini SDK error paths swallowed by the proxy**
   When the Gemini SDK or any other upstream returned an error response with
   `Content-Type: application/json; charset=utf-8` containing a
   `{"error": {...}}` envelope, the proxy's writeout path returned the
   upstream body verbatim with no logging and no normalization. Errors that
   arrived with non-`application/json` content-type (e.g. HTML from a load
   balancer) failed silently because there was no content-type check before
   attempting to read the body.
   **Fix:** added a content-type guard in the writeout wrap before applying
   any JSON body transform — non-JSON responses pass through unchanged. The
   upstream body is logged with status + first 200 chars when an error is
   surfaced (debug logging only — production logs unchanged).

**Tests**: 131 unit tests across 8 files, all passing (+2 in
`transforms-config.test.ts` covering the 5-element inline-table validation:
accepts valid 5-element shape; rejects non-string `transforms`; rejects
empty `target` in 5-element shape).

### Feat: Request/response transform hooks (Steps 1–4)

Implements the full two-tier transform system described in
`docs/design_request_transform_hooks.md`.

**Config layer** (`src/utils/config-loader.ts`):
- New types: `TransformSchema`, `TransformOp`, `BuiltinName`, `TransformSet`
- `ProxyConfig` extended with `transforms` and `transform_defaults` sections
- `ModelRouteConfig` now carries `transforms: TransformSet[]` — merged at load time
  from mode-defaults → sector-defaults → entry (left-to-right)
- `parseSimpleToml` parses `[transforms.*]` + `[transform_defaults]` sections,
  including inline-table op arrays (`before_upstream.ops = [{op="rename",...}]`)
- `parseTransformOpsInline`, `validateTransformSet`, `validateAllTransforms` — fail-loud
  validation of unknown paths, unknown builtins, unknown schemas at config load
- `resolveTransforms()` merges mode-level defaults with per-route transform names

**Transform engine** (`src/utils/request-transform.ts`):
- Tier-1 generic ops: `rename`, `set`, `default`, `remove`, `map_value`
  over shallow paths (top-level fields, `messages[role=X].field`)
- Tier-2 built-ins: `lowercase_tool_schema_types` (recursive schema normalizer),
  `recover_tool_message_name` (cross-message lookup for missing tool name)
- `runHook(hook, payload, ctx)` — left-to-right fold across transform sets
- `buildEventTransformer(hook, ctx)` — null fast path when no transforms active

**Wiring** (`src/index.ts`, `src/handlers/chat-completions.ts`, `src/handlers/messages.ts`,
`src/handlers/openai.ts`, `src/handlers/responses.ts`, `src/handlers/claude.ts`,
`src/handlers/gemini.ts`):
- `endpoint_readin` applied centrally in `runAttempt` before any handler sees the body
- `endpoint_writeout` (headers) applied centrally in `runAttempt` after the handler
- `before_upstream` wired in all seven handlers via `route?: ModelRouteConfig` param:
  - `handleChatCompletionsPassthrough` — OpenAI chat-completions passthrough
  - `handleMessagesRequest` — both openai-upstream and claude-upstream fetch paths
  - `handleOpenAIRequest` — main OpenAI fetch path
  - `handleResponsesRequest` / `handleAsCompletions` — Responses→Completions conversion path
  - `handleClaudeRequest` — native Anthropic messages upstream
  - `handleGeminiRequest` / `handleGeminiRequestForMessages` — Gemini Interactions and
    generateContent fetch paths
- `RouteAttempt` carries `route?: ModelRouteConfig`; `runAttempt` threads it into every
  handler call-site
- Removed inline `normalizeJsonSchemaTypes` + tool-patch loops from `chat-completions.ts`
  (replaced by `lowercase_tool_schema_types` and `recover_tool_message_name` builtins)

**`mapMaxTokensForUpstream` migration (Step 6 — partial):**
- Added `[transforms.max_tokens_rename]` to `proxy_config.toml` with
  `before_upstream.ops = [{op="rename",path="max_tokens",to="max_completion_tokens"}]`
- Added `[transform_defaults]` binding `openai-completions` and `openai-responses` modes
  to the `max_tokens_rename` set — so all routes with those modes get the rename for free
- Removed `mapMaxTokensForUpstream` call from the already-wired `before_upstream` sites
  in `messages.ts` (both openai and claude upstream paths), `openai.ts` (main fetch),
  `responses.ts/handleAsCompletions`; the transform engine now handles the rename
- All active `mapMaxTokensForUpstream` call-sites migrated to transform engine:
  - `chat-completions.ts/openai-responses` path: wired `before_upstream` on converted body
  - `openai.ts/forwardCompletionsAsOpenAIResponses`: added `route?` param, wired hook
  - `responses.ts/handleResponsesInputTokensRequest`: added `route?`, wired both fetch paths
  - `responses.ts/handleResponsesCompactRequest`: added `route?`, wired both fetch paths
  - `responses.ts/handleAsPassthrough`: added `route?`, wired hook
  - `index.ts`: passes `attemptRoute` to `handleResponsesInputTokensRequest` and `handleResponsesCompactRequest`
- Removed `mapMaxTokensForUpstream` import from `chat-completions.ts`, `openai.ts`, `responses.ts`
- `shouldUseMaxCompletionTokens` / `mapMaxTokensForUpstream` kept in `routing.ts` (still
  referenced by `gemini.ts` dead code `handleGeminiToOpenAIMode` and routing unit tests)

**`before_conversion` hook wired (Step 5):**
- `messages.ts`: wired before `convertClaudeToOpenAIRequest`; result merged back to `claudeRequest` via `Object.assign`
- `openai.ts`: wired before the Gemini/Claude format-detection branch; `requestBody` changed `const` → `let`
- `responses.ts/handleAsCompletions`: wired before `convertResponsesToChatCompletions`; `effectiveBody` changed `const` → `let`
- `gemini.ts/handleGeminiGenerateContentRequest`: wired before `isNativeGeminiRequest` branch; `requestBody` changed `const` → `let`
- All wired with `upstreamMode` from route context and fast-path guard `if (route)`

**Remaining hooks (`after_upstream`, `endpoint_writeout` body):** deferred — no transforms
currently declare ops for these hooks; infrastructure will be added when first needed.
Header transforms for `endpoint_writeout` are already wired centrally in `index.ts`.

**Dead code removal and routing.ts cleanup (Step 7):**
- Removed `handleGeminiToOpenAIMode`, `handleOpenAIStreamingToClaude`, `handleGeminiToGeminiMode`
  dead functions from `gemini.ts` (~265 lines)
- Removed `mapMaxTokensForUpstream` and `shouldUseMaxCompletionTokens` from `routing.ts` —
  behavior is now fully owned by the transform engine
- Removed `convertClaudeToOpenAIRequest` import from `gemini.ts` (was only used in dead code)
- Updated `routing.test.ts` to remove tests for the deleted functions

**`deepseek_compat` and `minimax_compat` transform sets (Step 8):**
- Added `[transforms.deepseek_compat]` to `proxy_config.toml`:
  - `endpoint_readin.builtins = ["lowercase_tool_schema_types"]` — normalizes uppercase JSON-Schema
    types (e.g. `"STRING"` → `"string"`) from antigravity SDK before routing
  - `before_upstream.builtins = ["recover_tool_message_name"]` — fills missing `name` in `tool`
    messages from matching prior `assistant.tool_calls[].function.name` by `tool_call_id`
  - `before_upstream.ops`: `map_value` `messages[role=assistant].content "" → null` when
    `tool_calls` sibling present
  - Wired to `deepseek-v4-comp` entry via `transforms = "deepseek_compat"`
- Added `[transforms.minimax_compat]` to `proxy_config.toml`:
  - `before_upstream.ops`: same `map_value` null-content patch
  - Wired to `max-m3-comp` and `minimax-m2.7-high` entries
- Extended inline-table model entry parser (`config-loader.ts`) to read `transforms` field —
  stores as `entry[4]` (comma-separated set names), which `resolveModelRouteFromEntry` already
  reads at index 4
- Extended `serializeModelEntry` to emit `transforms` field on round-trip (used by
  `dumpProxyConfigToml`)

**`after_upstream` hook fully wired (Step 9):**
- Added `applyAfterUpstream(response, ctx)` to `request-transform.ts` — buffers the upstream
  response body, applies `after_upstream` ops, and returns a new `Response`. Non-JSON bodies
  (e.g. SSE streams) are passed through unchanged. Fast-path exits immediately when no
  `after_upstream` transforms are active.
- Wired in all handler fetch sites (12 total):
  - `openai.ts`: `forwardCompletionsAsOpenAIResponses` + main `handleOpenAIRequest` fetch
  - `claude.ts`: `handleClaudeRequest` main fetch
  - `messages.ts`: all four fetch sites (openai-passthrough → openai-responses,
    openai-passthrough → openai-completions, claude-upstream → openai-responses,
    claude-upstream → openai-completions)
  - `responses.ts`: `handleAsCompletions`, `handleAsPassthrough`,
    `handleResponsesInputTokensRequest` (both paths), `handleResponsesCompactRequest` (both paths)
  - `chat-completions.ts`: anthropic-messages path, openai-responses path, direct passthrough
  - `gemini.ts`: `handleGeminiInteractionsRequest`, `handleGeminiGenerateContentRequest`
- Removed `fillMissingToolMessageNames` unconditional call from `handleOpenAIRequest` — this
  function duplicated the `recover_tool_message_name` built-in now applied selectively via
  `deepseek_compat`. Other routes no longer get the transform applied unnecessarily.

**Tests**: 136 unit tests, all passing (+6 new `applyAfterUpstream` tests in
`tests/unit/request-transform.test.ts`: fast-path identity, empty-transforms fast-path,
active remove op, active rename op, status preservation, non-JSON SSE passthrough)

### Fix: TUI model test — inline-table config resolution, fallback mode, and DeepSeek thinking rejection

Three fixes to the TUI's "test model" feature in `src/tui.ts` that improve coverage
and unblock the test for compat-mode `anthropic-messages` upstreams like DeepSeek.

**Root causes and fixes:**

1. **`deepseek-v4-anth` and other inline-table model entries resolved to section-level defaults**
   The TUI's `resolveModelTestConfig` recognized the array-form
   (`"model" = ["target", "base_url", "api_key", "mode"]`) and the bare section-default
   fallback, but silently fell through to section-level `upstream_mode`/`base_url`/`api_key`
   for the inline-table form
   (`"model" = {target = "...", base_url = "...", api_key = "...", mode = "..."}`) used
   throughout `proxy_config.toml` for `deepseek-v4-anth`, `minimax-m2.7-high`,
   `minimax-m3-anth`, `gemma-4-*`, and similar entries. The model test for `deepseek-v4-anth`
   therefore POSTed to `http://192.168.68.179:3000` (the `[models.free]` default) with
   `openai-completions` mode and no DeepSeek key, instead of the configured
   `https://api.deepseek.com/anthropic` with `anthropic-messages`.
   **Fix:** added an inline-table branch in `resolveModelTestConfig` that reads
   `target`/`base_url`/`api_key`/`mode` per entry with `typeof` guards, then falls back
   to section/global defaults. `deepseek-v4-anth` now resolves to
   `upstreamMode="anthropic-messages"`, `targetUrl="https://api.deepseek.com/anthropic"`,
   `apiKey="sk-..."`, `directModel="deepseek-v4-flash"`.
   *Note: empty-string per-field values (e.g. `api_key = ""` in `codelite` and
   `codesmall`) are intentionally preserved as "not set" — the per-field `||` chain
   falls through to the section/global default rather than rejecting the entry, so
   the TUI test for these models still resolves to a working key.*

2. **Unresolvable upstream mode silently fell back to `openai-completions`**
   When the TUI could not resolve any model config (no entry, no section default, no
   proxy default) it built an OpenAI completions body and sent it to the local proxy's
   `/v1/messages` endpoint. The proxy's `/v1/messages` natively speaks Claude, and the
   default OpenAI shape doesn't match that endpoint without a routing decision.
   **Fix:** the fallback upstream mode in `executeModelTest` is now `'anthropic-messages'`,
   which is the proxy's primary `/v1/messages` protocol. The TUI now always POSTs a
   valid body shape to `/v1/messages`, regardless of whether the model is resolvable.

3. **Anthropic-format `thinking: {type: "adaptive"}` rejected by DeepSeek compat shim**
   `buildTestToolRequest` previously added `thinking: {type: "adaptive"}` to every
   `anthropic-messages` test body "to exercise the same thinking path real Anthropic
   traffic uses." Real Claude accepts the omission, but DeepSeek's `/anthropic`
   compatibility endpoint rejects the combination of `thinking` + forced
   `tool_choice: {type: "tool", name: "test_tool"}` with
   *"Thinking mode does not support this tool_choice"* (400). The DeepSeek
   `thinking_mode` doc (see `docs/deepseek_thinking.md`) describes the OpenAI-format
   toggle as `{"thinking": {"type": "enabled/disabled"}}` and never documents the
   Anthropic-format `{"type": "adaptive"}` shape.
   **Fix:** removed the `thinking` block from `buildTestToolRequest`. The TUI test is a
   liveness probe for the model route, not a feature exercise; if a dedicated
   thinking-path test is needed later it should be a separate test mode.

### Fix: `/v1/chat/completions` DEV_PASS_THROUGH — tool schema types, `content: null`, and multi-turn tool calls

Four interrelated fixes to the `handleChatCompletionsPassthrough` path used by
`DEV_PASS_THROUGH=true` clients (e.g. Antigravity `LocalOpenAIAgentConfig`, LangGraph).
All changes affect `anthropic-messages` and `openai-completions` upstream routes.

**Root causes and fixes:**

1. **Uppercase JSON Schema type strings rejected by DeepSeek (`"STRING"` instead of `"string"`)**
   The Antigravity SDK (`google-antigravity`) introspects Python type annotations and emits
   JSON Schema `type` fields in all-caps (`"STRING"`, `"INTEGER"`, `"BOOLEAN"`, etc.).
   DeepSeek and other strict upstreams reject these as invalid per the OpenAI spec.
   **Fix:** `handleChatCompletionsPassthrough` in `src/handlers/chat-completions.ts` now
   recursively lowercases all `type` strings in every tool's `function.parameters` schema
   before forwarding, via a new `normalizeSchemaCasing()` helper.

2. **`messages[N].content is required` (400 from proxy validator) on multi-turn tool calls**
   The OpenAI spec permits `content: null` on assistant messages that contain `tool_calls`
   (the model produced only function calls, no text). Two issues stacked:
   - The proxy's own `validateChatCompletionsRequest` in `src/utils/validation.ts` was
     throwing `content is required` when `content === null`, treating `null` and `undefined`
     the same. Fixed: only `undefined` is now rejected; `null` is accepted for assistant
     messages. `content` must be a string, array, or `null`.
   - LangGraph sends multi-turn history where assistant messages with `tool_calls` have
     `content: ""` (empty string). DeepSeek's Anthropic-compatible endpoint rejects
     `content: ""` when `tool_calls` is present. **Fix:** `handleChatCompletionsPassthrough`
     now normalizes inbound assistant messages: if `tool_calls` is present and
     `content === ""`, it is rewritten to `null` before forwarding.

3. **`anthropic-messages` path sent model alias instead of resolved target name**
   In the `anthropic-messages` conversion branch, `modelId` (the original alias, e.g.
   `deepseek-v4-anth`) was taking priority over `parsedBody.model` (the already-rewritten
   target, e.g. `deepseek-v4-flash`). Claude rejected the alias name.
   **Fix:** priority is now `parsedBody.model || modelId || 'unknown'` — the rewritten
   body model always wins when present.

4. **Multiple consecutive tool messages rejected by Claude (`anthropic-messages` path)**
   When an assistant turn issued N tool calls, the OpenAI → Claude converter
   (`completionsToClaudeBody` in `src/handlers/openai.ts`) produced N separate
   `{role: "user", content: [{type: "tool_result"}]}` messages. Claude requires all
   tool results for a single turn to be bundled in one `user` message.
   **Fix:** `completionsToClaudeBody` now uses a loop that collects all consecutive
   `role: "tool"` messages into a single `{role: "user", content: [...tool_results]}`
   message before continuing. This was already partially noted in the prior "Gemini-endpoint"
   changelog entry but the `completionsToClaudeBody` path was re-fixed here for the
   completions passthrough specifically.

**Additional change — `claudeJsonToSyntheticCompletions` returns `null` content for tool-only responses**

`claudeJsonToSyntheticCompletions` in `src/handlers/openai.ts` (the non-streaming
Claude → OpenAI completions converter) was returning `content: ""` on assistant messages
where the upstream responded with only `tool_use` blocks and no text. This caused the
next LangGraph turn to send `content: ""` back, triggering fix #2 above.
**Fix:** when `tool_use` blocks are present and the text content is empty, `content` is
returned as `null` to match the OpenAI spec.

**Files changed:** `src/handlers/chat-completions.ts`, `src/handlers/openai.ts`,
`src/utils/validation.ts`.

### Fix: Gemini-endpoint → `openai-completions` streaming with DeepSeek reasoning models

Resolved a cascade of five interrelated bugs that prevented Gemini-endpoint clients
(e.g. Antigravity `GeminiAPIEndpoint`) from completing multi-turn agentic tasks through
an `openai-completions` upstream such as `deepseek-v4-flash` on DeepSeek.

**Root causes and fixes:**

1. **Fragmented streaming tool calls emitted as broken `functionCall` parts**
   DeepSeek fragments a single tool call across multiple SSE chunks: the first chunk
   carries `index`, `id`, `name`, and a partial-args string; continuation chunks carry
   only more argument text at the same index. The stateless `convertOpenAIToGeminiGenerateContent`
   converter was called for every chunk, producing name-less `call_undefined_N` parts.
   **Fix:** `processSSEBuffer` now accumulates tool-call deltas in a `geminiToolCallBuffer`
   (keyed by `index`) and flushes one complete `functionCall` per tool call when
   `finish_reason` arrives (`src/handlers/openai.ts`).

2. **`reasoning_content` not passed back on next turn**
   DeepSeek reasoning models emit thinking in a dedicated `delta.reasoning_content` field
   (not inline `<think>` tags). The converter ignored it, so the subsequent request omitted
   `reasoning_content` from the assistant turn and DeepSeek rejected it with:
   `The reasoning_content in the thinking mode must be passed back to the API.`
   **Fix:** `convertOpenAIToGeminiGenerateContent` now extracts `reasoning_content` and
   emits it as a `{thought: true, text}` Gemini part (`src/converters/openai-to-gemini.ts`).
   On the inbound side, `convertGeminiGenerateContentToOpenAI` maps `thought:true` Gemini
   parts to the standard `reasoning_content` field on the assistant message (not a private
   `_thinking` field), so it round-trips correctly through subsequent requests.
   `completionsToClaudeBody` reads the same `reasoning_content` field and converts it to
   a `{type: "thinking"}` Claude content block for `anthropic-messages` upstreams.

3. **Tool messages missing `name` field**
   Several converters (`convertClaudeToOpenAIRequest`, `convertGeminiGenerateContentToOpenAI`,
   Antigravity `LocalOpenAIAgentConfig` passthrough) emitted `role:"tool"` messages without
   the `name` field. DeepSeek's OpenAI endpoint requires it.
   **Fix (A):** `convertGeminiGenerateContentToOpenAI` now tracks each assistant turn's
   `tool_calls` in `lastToolCalls` and uses that to set `name` and match `tool_call_id`
   by position when converting the following `functionResponse` turn.
   **Fix (B):** `fillMissingToolMessageNames` post-processes the converted OpenAI request
   in `handleOpenAIRequest`, recovering `name` from `tool_calls` by `tool_call_id` for
   any converter that missed it (`src/handlers/openai.ts`).
   **Fix (C):** `handleChatCompletionsPassthrough` applies the same recovery for clients
   that hit `/v1/chat/completions` directly (`src/handlers/chat-completions.ts`).

4. **Tool-call IDs mismatched between assistant and tool turns**
   The previous ID scheme `call_${name}_${i}` generated IDs independently in each turn,
   which diverged when multiple calls shared the same function name.
   **Fix:** IDs are now generated once in the assistant turn and recovered by position for
   the corresponding tool-result turn via `lastToolCalls`.

5. **Multiple tool results sent as separate `user` messages (anthropic-messages path)**
   When an assistant turn issued N tool calls, the converter produced N separate
   `{role:"user", content:[{type:"tool_result"}]}` messages. Claude requires all results
   bundled in a single `user` message immediately after the assistant turn.
   **Fix:** `completionsToClaudeBody` now uses a loop that collects consecutive `tool`-role
   messages into one `{role:"user", content:[...tool_results]}` message.

**Files changed:** `src/converters/openai-to-gemini.ts`, `src/handlers/openai.ts`,
`src/handlers/chat-completions.ts`.

### Fix: `DEV_PASS_THROUGH` `/v1/chat/completions` returns raw Claude response to OpenAI clients
Notice:
`handleChatCompletionsPassthrough` was forwarding the Claude Messages upstream response directly
to the client without conversion. Clients expecting OpenAI completions format (e.g. Antigravity
`LocalOpenAIAgentConfig`) received a Claude response object with no `choices` field, triggering:

```
model output error: model output must contain either output text or tool calls
```

The `anthropic-messages` branch in `chat-completions.ts` now converts:
- **Non-streaming**: Claude JSON → `claudeJsonToSyntheticCompletions` → OpenAI `chat.completion`
- **Streaming**: Claude SSE events (`content_block_delta`, `content_block_start`,
  `message_delta`, `message_stop`) → OpenAI `chat.completion.chunk` SSE, including tool call
  streaming (`input_json_delta` → `function.arguments` delta).

`claudeJsonToSyntheticCompletions` is extracted as an exported helper in `src/handlers/openai.ts`
(replacing the previously inlined duplicate in `forwardCompletionsAsAnthropicMessages`).

**Files changed:** `src/handlers/chat-completions.ts`, `src/handlers/openai.ts`.

### Fix: `DEV_PASS_THROUGH` `/v1/chat/completions` fails for `anthropic-messages` routes

When `DEV_PASS_THROUGH=true` and `LocalOpenAIAgentConfig` (e.g. Antigravity) hits
`/v1/chat/completions` with a model whose route uses `anthropic-messages` (e.g. `minimax-m3`),
the proxy had two bugs:

1. **Wrong upstream URL** — `src/index.ts` was appending `v1/chat/completions` to the route's
   `base_url` regardless of `upstream_mode`. For `anthropic-messages` routes this produced a URL
   like `https://api.minimaxi.com/anthropic/v1/chat/completions` which returns 404. Fixed: the
   upstream path is now selected as `v1/messages` for `anthropic-messages`, `v1/responses` for
   `openai-responses`, and `v1/chat/completions` otherwise.

2. **Wrong request body format** — `handleChatCompletionsPassthrough` only handled
   `openai-responses` body conversion; for `anthropic-messages` it forwarded the raw OpenAI
   completions body. Fixed: the handler now converts completions → Claude Messages format
   (via the existing `completionsToClaudeBody`) and sets `anthropic-version` before forwarding.
   `completionsToClaudeBody` is now exported from `src/handlers/openai.ts`.

**Files changed:** `src/index.ts`, `src/handlers/chat-completions.ts`, `src/handlers/openai.ts`.

### Fix: `systemInstruction` dropped when routing Gemini `generateContent` to OpenAI upstream

When Antigravity SDK (or any client) sends a Gemini `generateContent` request with
`systemInstruction` to an `openai-completions` upstream route (e.g. `max-m3`), the system
prompt was silently dropped during conversion. The model received no system context and
hallucinated tool names not in the provided schema, causing errors like:

```
invalid tool call error (invalid_signature) SearchDirectory is required
```

`convertGeminiGenerateContentToOpenAI` in `src/handlers/openai.ts` now extracts
`systemInstruction.parts[*].text` (standard Gemini format) and prepends it as an OpenAI
`{ role: "system", content: "..." }` message before the conversation turns.

**Files changed:** `src/handlers/openai.ts`.

### `DEV_PASS_THROUGH` upstream-auth notice

The README and `docs/README_DETAILS.md` now explicitly flag that `DEV_PASS_THROUGH=true`
on `/v1/chat/completions` forwards the caller's `Authorization` / `x-api-key` /
`x-goog-api-key` to the upstream unchanged — the proxy does **not** perform a local
credential check, the upstream directly authenticates the request (valid key → 200,
invalid key → upstream 401). Previously this was implied by the "validation only (no
model routing)" startup warning but not stated in the docs. No code change; this is
a documentation-only notice. See the env-var table row in `README.md` and the
`DEV_PASS_THROUGH` section in `docs/README_DETAILS.md`.

### Node server decoded response header normalization

The Node server adapter now removes `content-encoding` and `content-length` from
responses before writing them to clients. This prevents clients from trying to
decompress plain text when Node `fetch()` has already decoded an upstream
compressed response while preserving the upstream compression headers.

**Files changed:** `src/server.ts`.

### Composite alias resolution for `DEV_PASS_THROUGH` `/v1/chat/completions`

When `DEV_PASS_THROUGH=true`, the `/v1/chat/completions` passthrough handler now resolves
composite aliases and `target`-mapped model ids before forwarding the request upstream.

- Composite aliases (e.g. `for-claw`) are resolved to their primary/weighted target model
  via the same `getModelRouteConfig` path used by `/v1/messages`.
- `target`-mapped entries (e.g. `minimax-m3` → `MiniMax-M3`, `MiniMaxAI/MiniMax-M3` → `MiniMax-M3`)
  are also resolved.
- The `model` field in the forwarded request body is rewritten to the resolved target model id.
  If no alias resolves, the original model name is forwarded unchanged.
- Previously, composite alias names were forwarded verbatim, causing upstreams to return
  `unknown model` errors (e.g. MiniMax error 2013).

**Files changed:** `src/index.ts`, `README.md`, `docs/README_DETAILS.md`.

### `<think>` tag extraction for `openai-completions` upstream

Upstreams with mode `openai-completions` that emit reasoning wrapped in `<think>...</think>` or
`<thinking>...</thinking>` XML tags now have that content split into each endpoint's
native reasoning field, mirroring the existing `<thinking>` behavior.

- `/v1/messages`: extracted into a Claude `thinking` content block.
- `/v1/responses`: extracted into a `reasoning` output item, with `reasoning_text`
  embedded inside the assistant message for round-trip fidelity (matches Codex's
  expected input shape for multi-turn DeepSeek responses).
- `/v1/interactions`: extracted into a `thought` output item alongside the cleaned
  text output.
- `/v1beta/models/<model>:generateContent`: extracted into a Gemini `thought`
  content part alongside the cleaned text part.
- Tag is stripped from the user-visible text content in all paths.
- Both streaming and non-streaming responses are covered; the streaming path
  stitches tags that straddle SSE chunk boundaries via a per-stream `thinkStreamBuffer`
  that is reset on `[DONE]` to avoid cross-request leakage.

`README.md` documents the new behavior next to the existing thinking/reasoning notes.

**Files changed:** `src/converters/openai-to-claude.ts`, `src/converters/streaming.ts`,
`src/converters/completions-to-responses.ts`, `src/converters/openai-to-gemini.ts`,
`src/handlers/responses.ts`, `src/handlers/openai.ts`, `tests/unit/think-tag-extraction.test.ts`,
`README.md`.

### Model usage HTTP recording and auth context headers

The proxy can now optionally POST per-request model usage records to an HTTP collector configured with `[model_usage] record_url`.

- Usage records include `request_id`, `endpoint`, raw `user_key`, `model`, and token counters (`input_tokens`, `cached_tokens`, `cache_written_tokens`, `output_tokens`, `total_tokens`).
- JSON and streaming responses reuse the existing token accounting path, so both non-streaming usage payloads and final streaming usage chunks are reported.
- If `auth_url` returns an `access_token` response header, that one-request token is forwarded to `record_url` as an `access_token` request header.
- Requests to `auth_url` now also include `request_id` and `endpoint` headers, plus the existing auth headers and optional `x-resource-for` when `auth_with_model = true`.
- `proxy_config.example.toml` and `README.md` document the new optional `[model_usage]` section.

**Files changed:** `src/index.ts`, `src/utils/model-usage-recorder.ts`, `src/utils/config-loader.ts`, `src/utils/dashboard-stats.ts`, `tests/unit/token-usage.test.ts`, `tests/unit/auth-with-model.test.ts`, `testcases/15_config_parse/config_parse.test.js`, `README.md`, `proxy_config.example.toml`.

### TUI statistics overlay and compact tool names

The proxy TUI now has a `D` hotkey that opens a scrollable statistics overlay,
matching the existing overlay style used by `P` Tool Blocklist. The panel shows
all rows from `Top Models`, `Tools Used`, and `Top Endpoints` instead of the
main view's first-five-row summaries.

- `Top Models` keeps the full token/accounting column set.
- `Tools Used` and `Top Endpoints` use their own shorter column sets, with
  separator lines between modules.
- Long tool names are compacted in both the statistics overlay and Tool
  Blocklist panel using a prefix/suffix form to preserve recognizable endings.

**Files changed:** `src/tui.ts`.

### Token usage propagation across streaming and cache-aware routes

Token accounting is now more complete across transformed streaming routes:

- OpenAI Chat Completions streaming requests now force `stream_options.include_usage = true` in both Claude-format conversion and OpenAI passthrough paths, so final upstream usage chunks can be propagated.
- Gemini streaming conversion now parses final `interaction.usage` / `usageMetadata` and emits Claude `message_delta.usage`, allowing `/v1/messages` and `/v1/responses` Gemini streaming routes to report final input/output/cache-read token counts.
- OpenAI Responses `usage.input_tokens_details.cached_tokens` is preserved through Claude and Responses conversion paths instead of being dropped or hardcoded to zero when available.
- Local token counting now includes tool results and other non-text blocks with best-effort serialization instead of silently skipping them.
- Unit tests cover streaming usage propagation, cache-token mapping, and local non-text token counting.

**Files changed:** `src/converters/gemini-streaming.ts`, `src/converters/openai-to-claude.ts`, `src/handlers/messages.ts`, `src/handlers/responses.ts`, `src/utils/token-counting.ts`, `tests/unit/token-usage.test.ts`, `README.md`.

### `[general]` section; `[upstream]` renamed to `[default_upstream]`; `auth_passthrough_with` and `auth_url`

Three related config-layer changes landed together.

**`[upstream]` → `[default_upstream]`**

The TOML section that holds global upstream defaults (`default_base_url`,
`default_api_key`, `upstream_mode`) is renamed from `[upstream]` to
`[default_upstream]` to make its scope clearer — it applies only to models
that fall through every `[models.*]` section. Existing configs must rename
the section header; all other keys inside it are unchanged.

**New `[general]` section**

A top-level `[general]` section collects settings that are not tied to a
specific upstream:

- `global_token_limit` and `budget_to_effort_low/medium/high` (previously
  in `[upstream]`) have moved here.
- `auth_url` (optional): if set, the proxy validates every inbound auth
  header by forwarding it (plus `User-Agent`) to this URL via `GET`. HTTP
  200 (or a 301/302 chain that resolves to 200) = success; any 4xx/5xx
  = 401 to the client; network error = 503.
- `auth_passthrough_with` (optional, default `"user_key"`): controls which
  credentials the proxy sends to the upstream provider.

**`auth_passthrough_with`**

| Value | Behaviour |
|:------|:----------|
| `"user_key"` *(default)* | Caller's auth header is forwarded upstream for all sections except `[models.free]`, which always uses its configured key. Unchanged from prior behaviour. |
| `"config_key"` | Configured `api_key` wins for every section — per-entry → section → `[default_upstream] default_api_key`. Callers can still send a key (needed for the `auth_url` validation step) but it is not forwarded upstream. |

`config_key` is intended for shared-gateway deployments where callers must
not supply their own upstream credentials.

**Files changed:** `proxy_config.toml`, `proxy_config.example.toml`,
`src/utils/config-loader.ts` (interface + TOML parser + Consul loader +
serializer), `src/index.ts` (five auth-header sites), `src/server.ts`,
`src/tui.ts`, `src/handlers/dashboard.ts`, `README.md`.

### Privacy filter: local hash-only mode (no sidecar)

The proxy now ports the entropy-based hash/API-key scanner from
[`submodules/privacy-filter/hash_detect.py`](./submodules/privacy-filter/hash_detect.py)
into the TypeScript runtime as `src/utils/hash-detect.ts`. When
`[privacy_filter] filter_mode = "local"` is set in `proxy_config.toml`, the
proxy redacts hash-shaped tokens (API keys, tokens) in-process with no
HTTP call and no Python sidecar. Detected spans are replaced with the
same `⟦HASH:n⟧` sentinels the sidecar emits and are restored on the
response exactly as in sidecar mode — the on-the-wire shape is
identical, so the existing `restoreText` / streaming transform code is
shared.

- **Config source**: a new `[privacy_filter]` toml section. Env vars
  (`PRIVACY_FILTER_URL`, `PRIVACY_FILTER_TIMEOUT_MS`, etc.) override toml,
  matching the rest of the proxy's plugin knobs. The plugin is enabled
  when `filter_mode = "local"` (no URL required), or when
  `filter_mode = "sidecar"` is paired with a valid `filter_url`;
  otherwise it stays inert. There is no separate `enabled` flag — the
  combination of `filter_mode` and `filter_url` is what turns the
  filter on.
- **Detection semantics**: identical to the Python reference — Shannon
  entropy ≥ `entropy_threshold` (default `3.0`), 8+ contiguous hex chars
  with non-hex boundaries, length multiple of 8 ⇒ `HIGH` (16–256 chars),
  otherwise `LOW`. A built-in whitelist (`deadbeef`, `cafebabe`, etc.)
  is always applied and can be extended with `whitelist_add` /
  `whitelist_remove`. The minimum token length is configurable via
  `hash_min_len` (default `8`); the Python `hash_detect.py` was updated
  to match (`<= 8` → `< 8`).
- **Sidecar mode is unchanged**; setting `[privacy_filter] filter_mode = "sidecar"`
  + `filter_url = "..."` activates the OPF Python sidecar via toml, in
  addition to the legacy `PRIVACY_FILTER_URL` env-var path.

**Files changed:** `src/utils/hash-detect.ts` (new), `src/utils/privacy-filter.ts`
(local mode + toml plumbing), `src/utils/config-loader.ts`
(`[privacy_filter]` section), `src/index.ts` (wire toml through
`getPrivacyFilterConfig`), `proxy_config.toml` and `proxy_config.example.toml`
(documented example), `testcases/16_security/privacy_filter.test.js`
(TC2115–TC2122), `dist/`.

### Privacy filter now restores both `PII` and `HASH` sentinels

The privacy-filter sidecar ([`submodules/privacy-filter/serve.py`](./submodules/privacy-filter/serve.py)) emits two sentinel prefixes: `⟦PII:n⟧` (model-detected PII) and `⟦HASH:n⟧` (cryptographic-hash-shaped secrets such as API keys and tokens, caught by the entropy-based `hash_detect.py` scan). Previously the proxy's `SENTINEL_REGEX` only matched `PII:`, so `HASH:` sentinels would leak through as literal text in streaming responses. The regex now matches `(?:PII|HASH):`, and the info log line no longer claims HASH spans are PII. On overlap the sidecar's priority order (`HASH_HIGH > HASH_LOW > MODEL`) still applies — the proxy is just restoration, not detection.

**Files changed:** `src/utils/privacy-filter.ts`, `src/index.ts`, `testcases/16_security/privacy_filter.test.js` (TC2113, TC2114), `dist/`.

### Smaller production Docker image

- After the TypeScript build, `Dockerfile` runs `npm prune --omit=dev` so the runtime image no longer carries `wrangler`, `@anthropic-ai/claude-code`, `@anthropic-ai/claude-agent-sdk`, `@openai/codex-sdk`, `@google/genai`, etc. They have also been moved to `devDependencies` in `package.json`.

**Files changed:** `Dockerfile`, `package.json`.

### `DEV_PASS_THROUGH` now honors per-model routes and OpenAI Responses upstreams

- `/v1/chat/completions` with `DEV_PASS_THROUGH=true` now resolves the request `model` through the normal model config before forwarding, so per-model `base_url`, `api_key`, and `mode` entries (including `[models.free]`) are used instead of always falling back to `[models.default]`.
- If the resolved route uses `upstream_mode = "openai-responses"`, the Chat Completions body is converted to Responses format and sent to `/v1/responses`; `openai-completions` routes still forward the original body as-is.
- Azure OpenAI Responses routes keep using the configured model key; the handler normalizes OpenAI-style auth to Azure's `api-key` header for Azure URLs.

**Files changed:** `src/index.ts`, `src/handlers/chat-completions.ts`, `src/handlers/openai.ts`, `testcases/16_security/dev_pass_through_responses.test.js`, `README.md`, `testcases/README.md`.

### Gemini endpoint routing can target Anthropic Messages and OpenAI Responses

- `/v1/interactions` can now route to `upstream_mode = "anthropic-messages"` and `"openai-responses"` through the existing OpenAI Chat Completions intermediate conversion. The upstream response is converted back to the Interactions shape.
- `/v1beta/models/{model}:generateContent` and `:streamGenerateContent` (plus `/v1/models/...`) can now route to `anthropic-messages` and `openai-responses` through the same double-conversion path, then convert responses back to Gemini `candidates[].content.parts`.
- Cross-mode streaming text deltas are converted back to Gemini-shaped SSE instead of passing through raw Claude or Responses SSE.
- Tool calls are preserved: Claude `tool_use` blocks and OpenAI Responses `function_call` items become Chat Completions `tool_calls`, then Gemini `functionCall` parts or Interactions `function_call` outputs.
- When routing Interactions/generateContent to OpenAI Responses, `system`/`developer` messages are forwarded as Responses `instructions`, and OpenAI content-part arrays are normalized to text for Responses `input_text` fields.

**Files changed:** `src/index.ts`, `src/handlers/openai.ts`, `src/converters/openai-to-gemini.ts`, `testcases/16_security/openai_responses_routing.test.js`, `README.md`.

### `base_url` may now point to a full upstream endpoint path

The proxy no longer blindly appends the endpoint suffix to a configured `base_url`. If `base_url` already contains a known full endpoint path, it is used as-is. This lets providers configure `base_url` to the exact upstream URL they need, without getting a doubled path such as `.../v1/messages/v1/messages`.

Recognised full-endpoint markers (case-insensitive):

- `/v1/messages`, `/anthropic/messages` (anthropic-messages)
- `/v1/chat/completions`, `/v1/interactions` (openai-completions / interactions)
- `/v1/responses`, `/openai/responses` (openai-responses, including Azure)
- `/v1beta/models/{model}:generateContent`, `/v1/models/{model}:generateContent`, `:streamGenerateContent`, `:countTokens`

Gemini `base_url` can also stop at the API version or models collection, such as `https://generativelanguage.googleapis.com/v1beta` or `https://generativelanguage.googleapis.com/v1beta/models`; the proxy appends `{model}:generateContent` without duplicating `/v1beta` or `/models`.

For example, a model configured with `base_url = "https://api.anthropic.com/v1/messages"` and `upstream_mode = "anthropic-messages"` will forward `/v1/messages` requests to that exact URL, rather than `https://api.anthropic.com/v1/messages/v1/messages`.

**Files changed:** `src/utils/routing.ts` (new `buildUpstreamUrl` helper), `src/index.ts` (use helper in fixed, composite, and fusion routing).

### Thinking budget clamping: `budget_tokens` is capped to `max_tokens` (with interleaved-thinking exception)
When request to `kimi-2.7-code`, exception shows rised: 'InvalidParameter: max_completion_tokens [32000] must be greater than thinking_budget [32768]'. This is not a fix for the problem, they are just completions to follow api docs:
- **`POST /v1/messages` and `POST /v1/messages/count_tokens`**: when `thinking` is enabled and
  `thinking.budget_tokens` exceeds `max_tokens`, the request validator reduces
  `budget_tokens` down to `max_tokens` before forwarding, keeping the budget within the
  per-response output window required by the Claude API spec.
- **Interleaved-thinking exception**: if the request carries the
  `anthropic-beta: interleaved-thinking-2025-05-14` header, `budget_tokens` is left
  unchanged even when it exceeds `max_tokens` (per `docs/claude-extended-thinking.md`),
  since interleaved thinking is permitted to consume the full context window for
  reasoning tokens.
- **Below-minimum `max_tokens`**: if `max_tokens < 1024` while thinking is enabled with a
  non-null budget, validation throws with a clear message instead of clamping to an
  invalid value.

**Files changed:** `src/utils/validation.ts` (new `clampThinkingBudget`; updated
`validateClaudeMessagesRequest` / `validateClaudeTokenCountingRequest` signatures),
`src/handlers/messages.ts`, `src/handlers/token-counting.ts`.

### Composite alias safety: routing cycle detection, name-conflict stripping, self-reference rejection

#### Routing cycle detection
- **Load time**: `validateProxyConfig` now resolves every composite alias through the full routing chain and catches cycles (e.g. `for-claw6 → for-claw7 → for-claw8 → for-claw6`). Each unique cycle is pushed as a fatal validation error, logged as `[FATAL]`, and surfaced in the TUI status bar and dashboard status bar via `_validationErrors`.
- **Request time**: `getModelRouteConfig`, `getOrderedCompositeTargets`, `resolveCompositeModelRoute`, `getCompositeRouteCandidates`, and `resolveFusionPlan` all accept a `visited: Set<string>` parameter. If a cycle is detected mid-resolution, a `Routing cycle detected: A → B → … → A` error is thrown immediately rather than looping forever.
- **Dashboard snapshot**: `getDashboardSnapshot` now passes `new Set([alias])` when resolving each composite target's route and uses `flatMap` + try/catch so a cyclic target is silently omitted from the snapshot instead of crashing the entire snapshot call (which previously caused TUI to hang at `Loading…`).

#### Nested composite routing (composite → composite)
- Composite targets that are themselves composite (or schedule/fusion) aliases are now resolved through the full routing chain (`getModelRouteConfig`) rather than only `resolveModelRouteFromConfig` (which only looked at `[models.*]`). This makes `alias-a → alias-b → real-model` work correctly end-to-end.

#### Name-conflict stripping
- `findAliasNameConflicts` / `stripConflictingAliases`: composite and schedule aliases whose name collides with a `[models.*]` entry are stripped from the in-memory config at load time. `[FATAL]` is logged per stripped alias; `_validationErrors` carries the error so it appears in TUI / dashboard.
- `addCompositeAlias` / `addScheduleAlias` throw if the new alias name matches an existing model name, preventing the conflict from being written to disk.

#### Self-reference rejection
- `findSelfReferencingCompositeTargets` / `stripSelfReferencingCompositeTargets`: composite targets that list their own alias name as a target are stripped from the in-memory config at load time with `[FATAL]` logging.
- `upsertCompositeTarget` and `validateAndNormalizeComposite` (dashboard PUT path) both throw immediately if a target name equals the alias name, preventing self-references from reaching disk.
- All four TUI call sites for `upsertCompositeTargetFromDashboard` (add/edit × share/fusion) are wrapped in try/catch; errors are shown on the TUI message line without saving.

**Files changed:** `src/utils/config-loader.ts`, `src/handlers/dashboard.ts`, `src/tui.ts`.

### Test runner: `TEST_CONFIG` default is now force-set on `process.env`

- **Fixed silent isolation bypass**: `run-tests.js` and `testcases/utils/test_helpers.js`
  each computed a local `TEST_CONFIG` constant as `process.env.TEST_CONFIG || 'test_'`,
  but never wrote that default back to `process.env.TEST_CONFIG`. Any code path
  that read `process.env.TEST_CONFIG` directly (e.g. the proxy process itself,
  when started independently of `run-tests.js`) would see it unset and fall back
  to `./proxy_config.toml` instead of the isolated `./test_proxy_config.toml`,
  letting config-mutating test suites (composite/fusion/schedule PUTs, tool
  blocklist, global token limit) write into the real config file.
- Both files now do `if (!process.env.TEST_CONFIG) process.env.TEST_CONFIG = 'test_';`
  before reading it, so `TEST_CONFIG` is always defined for every child process
  and for `src/server.ts`'s own `PROXY_CONFIG_PATH` resolution, regardless of
  whether it arrived empty, unset, or already set by the caller.

**Files changed:** `run-tests.js`, `testcases/utils/test_helpers.js`.

### Schedule window editor: friendly `days` input (weekdays/weekend/everyday) in TUI and dashboard

- **Simplified `days` semantics**: schedule windows now accept `"weekday"`/`"weekdays"`
  and `"weekend"`/`"weekends"` in any casing; any other string value normalizes
  to "every day" instead of throwing a validation error. Explicit day-name
  arrays (e.g. `["mon","tue"]`) are still honored for hand-edited TOML. Added
  a shared `normalizeScheduleDays()` helper in `src/utils/config-loader.ts`
  used by the TOML parser, the dashboard JSON-payload validator
  (`validateAndNormalizeScheduleWindow`), and `upsertScheduleWindow` (the
  function both the TUI and the dashboard HTTP route call), so all three
  input paths agree.
- **TUI**: replaced the single JSON-array text prompt for editing a schedule
  target's windows with a step wizard — `from` (number prompt) → `to` (number
  prompt) → **days** (a 3-way picker: Every day / Weekdays / Weekend), with an
  "add another window" loop, or "Set as fallback" to clear the window list in
  one step. Also fixed the alias panel's per-target summary line, which
  previously silently dropped `days: "weekday"`/`"weekend"` (it only rendered
  array-style day lists).
- **Dashboard**: the schedule window's `days` free-text input (which could
  only ever produce a custom day array, never the special weekday/weekend
  values) is now a `<select>` dropdown with the same three options, matching
  the TUI.

**Files changed:** `src/utils/config-loader.ts` (`normalizeScheduleDays`,
`parseScheduleWindow`, `validateAndNormalizeScheduleWindow`,
`upsertScheduleWindow`), `src/tui.ts` (`openEditScheduleWindowsPrompt`,
`ScheduleAliasesOverlay.render`), `src/handlers/dashboard.ts`
(`scheduleAliasRows`, `collectConfigPayload`).

### Schedule Aliases panel: target-add UX fixes, target scope, and test-isolation path bug

- **Enter no longer dismisses the "Add target" list** — selecting a target in the
  "Adding target to *alias*" picker now returns to the Schedule Aliases panel
  (matching Esc/cancel behavior), instead of leaving no overlay open.
- **Key rebind**: adding a schedule target is now `M` (was `T`), for consistency
  with the Composite Aliases panel's `M add target` binding.
- **Target picker no longer offers invalid candidates**: wildcard routing patterns
  (`*`, `claude-*`, etc.) and the schedule alias itself (self-reference) are
  excluded from the "Adding target to *alias*" list.
- **Schedule targets can now be composite/fusion aliases**, not just concrete
  custom models — the picker already sourced candidates from
  `getConfiguredModelIds()` (which includes composite alias names), so this
  was a filtering/doc fix rather than a resolver change.
- **Fixed test-config isolation path bug**: `src/server.ts` computed the
  `TEST_CONFIG`-isolated config path as `` ./${TEST_CONFIG}_proxy_config.toml ``
  (extra underscore), while `run-tests.js` copies the developer config to
  `` ./${TEST_CONFIG}proxy_config.toml `` (no extra underscore). Because the two
  paths didn't match, a running test suite's `PUT /dashboard/api/config` calls
  could end up mutating a config path outside the isolation the test runner set
  up. Removed the extra underscore so the server reads/writes the exact path
  `run-tests.js` isolates.

**Files changed:** `src/tui.ts` (`ScheduleAliasesOverlay`, `openAddScheduleTargetPrompt`), `src/server.ts`.

### Config validation warnings + relaxed `api_key` requirement

`validateProxyConfig` now distinguishes **warnings** from **errors**. Situations that were previously
hard errors but are valid in practice (e.g. missing `api_key` when the caller supplies their own
auth header) are now surfaced as warnings and no longer block the config from loading.

- `ValidationResult` gains a `warnings: ConfigValidationError[]` field (same shape as `errors`).
- Dashboard GET `/dashboard/api/config` response includes `config_warnings` alongside `config_errors`.
- Dashboard UI and TUI both display warnings in amber/yellow when there are no hard errors.
- `api_key` absence is no longer an error for any section — the proxy forwards the caller's auth header.
  Only `base_url` absence (when required) remains a hard error.

**Files changed:** `src/utils/config-loader.ts`, `src/handlers/dashboard.ts`, `src/tui.ts`.

### Per-model `mode` override in `models.*` entries

Each model entry in a `[models.<section>]` block can now declare an explicit
`mode` to override the section's `upstream_mode`. This allows a single
category (e.g. `[models.free]`) to route different models to different
API formats without needing separate sections.

**Config syntax** (both forms supported):

```toml
[models.free]
upstream_mode = "openai-completions"   # section default
sonnet46 = {target = "claude-sonnet-4-6", base_url = "http://localhost:3000", api_key = "", mode = "anthropic-messages"}
opus46   = ["claude-opus-4-6", "http://localhost:3000", "", "anthropic-messages"]
```

**Mode resolution chain**: `model entry mode` → `section upstream_mode` →
`[upstream] upstream_mode` → `"openai-completions"`.

**Files changed:**
- `src/utils/config-loader.ts` — `resolveModelRouteFromEntry` extracts
  `modelMode` from entry[3] and cascades it; inline-table and array
  parsers handle `mode`; validation accepts 4-element arrays;
  `sanitizeDashboardCategoryConfig` preserves mode at index 2 of the
  3-element `[target, base_url, mode]` dashboard format;
  `applyDashboardConfigUpdate` reconstructs the 4-element internal form
  on PUT.
- `src/tui.ts` — `modelChoices()` and `resolveModelTestConfig()` now read
  mode from index 2 of the dashboard sanitized array (was incorrectly
  reading index 3), so the Test Custom Model panel shows the correct
  `anthropic-messages` / `completions` / `gemini` label per model.

### Bug fix: config `api_key` overrode caller key for `[models.default]` targets reached via composite / direct routing

The non-fusion composite dispatch in `src/index.ts` (the `compositeAttempts.map` block) was applying
the model's per-entry `api_key` from the config on top of the caller's auth headers unconditionally,
for every section. This contradicted the documented rule in `proxy_config.example.toml`:

> For the `[models.default]` tier, the auth key sent by the caller takes priority over ALL configured
> `api_key` values, including per-entry overrides. The `api_key` field is intentionally left unset by
> admins in practice — it only acts as a fallback when the caller did not supply an auth key.

Effect: a request for a model like `max-m3` (whose entry in `[models.default]` declares a
`sk-cp-p_i6lDK-...` key) would send the config key to the upstream, ignoring the caller's
`Authorization` / `x-api-key` header. The fusion path was already correct (gated on
`route.section === 'free'`), so the same target behaved differently depending on whether it was
reached via a fusion alias or via composite / direct routing.

Fix: align the inline composite-dispatch block with `buildRouteAttempt` — only override the caller's
auth with the config `api_key` when `route.section === 'free'`. All non-`free` sections
(`default`, `claude`, `gemini`, etc.) now pass the caller's key through unchanged. Affects
`src/index.ts` only (one block, ~10 lines).

### Bug fixes: `/v1/responses` reasoning round-trip (DeepSeek thinking mode + Codex multi-turn)

Four root causes behind the persistent `"reasoning_content must be passed back to the API"` error
when using the Responses API (`/v1/responses`) with DeepSeek thinking-mode upstreams and the Codex
CLI. All changes are in the responses handler and its two converter modules.

- **Streaming path silently dropped `delta.reasoning_content`** — `streamCompletionsAsResponses`
  in `src/handlers/responses.ts` was ignoring the `reasoning_content` / `thinking` delta fields
  that DeepSeek and OpenAI thinking-mode upstreams send per chunk. Added accumulation into
  `accumulatedReasoning` and emitted a `reasoning` output item (with the text) in the final
  `response.output_item.done` event for each text message. The `reasoning_text` is also appended
  inside the assistant message's content array so Codex can echo it back on the next turn.

- **Non-streaming path produced an empty `reasoning` output item** —
  `src/converters/completions-to-responses.ts` was emitting a `reasoning` item with no content
  when the upstream `message.reasoning_content` field was present. Fixed to actually extract the
  string and populate `content: [{ type: 'reasoning_text', text: reasoningText }]`. Also handles
  `part.type === 'thinking'` content parts from OpenAI-style array content.

- **Consecutive `function_call` input items produced separate assistant messages** —
  `src/converters/responses-to-completions.ts` was converting each `function_call` item into its
  own assistant message. Chat Completions (and DeepSeek) require all tool calls from a single
  assistant turn to be in *one* assistant message with multiple `tool_calls` entries. The new
  `convertInputItemsToMessages` exported function collects all consecutive `function_call` items
  and merges them into a single assistant message.

- **Server-side call_id → reasoning store for Codex multi-turn** — Codex builds conversation
  history from `response.output_item.done` events and echoes `function_call` items back as input
  on the next turn, but does **not** re-send `reasoning` items. Without a server-side store, the
  `reasoning_content` field would be absent from the echoed assistant message, causing DeepSeek to
  reject the request. Added a module-level `reasoningByCallId` map (10-minute TTL) in
  `src/handlers/responses.ts`: when a streaming response ends with both tool calls and accumulated
  reasoning, the reasoning is keyed by each `call_id`. On the next request, `handleAsCompletions`
  walks the converted messages and injects the stored `reasoning_content` onto any assistant message
  whose `tool_calls` match a stored entry.

### Bug fixes: OpenAI thinking passthrough + composite 413 path

Two single-case regressions caught by the full integration suite are now
fixed; the suite runs **18/18 suites, 165/165 cases** against the local
proxy (port 7799, `qnaigc` upstream). Recorded in
`tests/test_results_at_2026-06-22_20-14-47.md`.

- **TC413 — OpenAI-style thinking field (`{ enabled, budget_tokens }`)
  was rejected with HTTP 400** on `/v1/messages`. The request was dispatched
  to the Claude-format path (because `requestBody.thinking` is truthy) and
  then failed `validateClaudeMessagesRequest` with `thinking.type is
  required`. Added `normalizeOpenAIToClaudeThinking()` in
  `src/utils/thinking.ts` and applied it in `src/handlers/messages.ts`
  right after JSON parsing, so format detection, validation, and
  conversion all see the canonical Claude shape
  (`{ type: 'enabled'|'disabled', budget_tokens }`).
  Test now uses `budget_tokens: 2000` (validation floor is 1024) and
  `max_tokens: 3000` to fit.
- **TC1110 — Composite `token_limit` exhaustion returned 400 instead of
  413.** Two issues stacked:
  1. `OverLimitError` in `src/utils/errors.ts` was using 429 /
     `rate_limit_error`, the rate-limit shape. Token-limit exhaustion is a
     payload-size / quota concept, not RPM, so it now returns 413 /
     `over_limit_error` to match the documented `token_limit reached`
     contract and the canonical Anthropic-style error envelope.
  2. The catch block in `src/index.ts` around the model-routing body
     parse was swallowing *every* error (including typed
     `ClaudeProxyError` instances) and rewriting it as a 400 "Invalid
     request body". Added an `instanceof ClaudeProxyError` re-raise
     branch so the original status code and `type` field reach the
     client.

  Manual verification: two consecutive requests against a temporary
  `__test_ttl413__` alias with `token_limit: { num: 1, duration: '1h' }`
  now return `200` then
  `413 {"type":"over_limit_error","error":{"type":"over_limit_error","message":"Composite alias '__test_ttl413__' token limit (1 1h) reached (10). No further requests will be routed through this alias."}}`.

### Kompress (context compression) plugin

The proxy can now drop low-importance tokens out of outbound request text to cut
upstream token usage and cost. It mirrors the privacy-filter architecture: a thin
`fetch`-only client (`src/utils/kompress.ts`) talks to a persistent
[kompress](./submodules/kompress/README.md) HTTP sidecar (`POST /compress`), so it
stays Cloudflare-Workers-compatible and is **entirely inert unless `KOMPRESS_URL`
is set**.

Unlike the privacy filter, compression is **lossy and one-directional** — there is
no response-side restore (no sentinel map, no transform stream).

- **`src/utils/kompress.ts`** (new) — `getKompressConfig(env)` (returns `null` when
  `KOMPRESS_URL` unset; validates the sidecar is an internal host), `shouldCompressPath`,
  `isCjkHeavy` (English-only model guard), and `compressBody` (parallel per-fragment
  fan-out to the sidecar).
- **Scope:** compresses only **user-message text** and **tool definitions/results**
  (Anthropic `tools[].description` + `tool_result`, OpenAI `function.description` +
  `role:'tool'`). The system prompt, assistant messages, JSON schemas, images, and
  tool-call inputs are left untouched.
- **CJK guard:** the model is English-only and garbles non-Latin input, so fragments
  above a non-ASCII threshold (or containing CJK/Kana/Hangul) are passed through
  uncompressed.
- **Fail-open by default** (inverse of the privacy filter): a sidecar outage forwards
  the original uncompressed text rather than failing the request. Override with
  `KOMPRESS_FAIL_OPEN=false`.
- **Wiring** (`src/index.ts`): runs right after PII redaction and before tool-blocklist
  erasure, inside the same body-parse block, so single/composite/fusion paths all see
  the compressed body.
- **Env:** `KOMPRESS_URL`, `KOMPRESS_ENDPOINTS`, `KOMPRESS_FAIL_OPEN`,
  `KOMPRESS_TIMEOUT_MS`, `KOMPRESS_MAX_CHARS`, `KOMPRESS_KEEP_RATIO`, `KOMPRESS_MIN_CHARS`
  (declared in `src/types/shared.ts`, surfaced in `src/server.ts`).

### Dashboard Tool Blocklist (mirrors TUI `P` overlay)

The `/dashboard` web UI now ships the same tool blocklist the TUI exposes
behind the `P` key. The previous "Tools Used" aggregated view is replaced
by a per-`(tool, agent)` table with a Block/Unblock button per row.

- **`GET /dashboard/api/tools/blocklist`** (`src/handlers/dashboard.ts`) —
  returns `{ rows: AgentToolPanelEntry[], blockedTools: string[] }` from
  `getAgentToolPanelStats()` + `[...getBlockedTools()]`. Reuses the
  same data feed the TUI overlay consumes (per-tool × per-agent
  `in_requests` / `in_responses` / `in_request_chars`).
- **`POST /dashboard/api/tools/toggle-block`** — body
  `{ tool_name: string, blocked: boolean }`, calls `blockTool()` /
  `unblockTool()` from `src/utils/dashboard-stats.ts`, returns
  `{ ok, tool_name, blocked }`. Returns `400 { error }` when `tool_name`
  is missing or empty.
- **Routes registered** in `src/index.ts` next to the existing
  `/dashboard/api/stats/agents`, `/test-model`, `/global-token-limit`
  handlers.
- **Dashboard UI** (`section-agent` in `handleDashboardPage()`):
  - Heading renamed "Tools Used" → "Tool Blocklist" with a one-line
    caption pointing at the TUI `P` overlay.
  - Table now has 7 columns: status (`✗` / `·`) | Tool | Agent | in req
    | in resp | total len | Action.
  - Blocked rows get a red `✗` status cell, a light red background,
    and the action button toggles between `Block` (neutral) and
    `Unblock` (red).
  - Click handler delegated on `#toolStats` posts to the toggle-block
    endpoint and re-fetches `/tools/blocklist` to refresh the view.
  - 5-second auto-refresh already in place keeps the block state live
    with the rest of the dashboard.
- **Behavior parity with TUI**: blocked tools stop accumulating
  `in_requests` / `in_responses` / `in_request_chars` (existing
  pre-block counts are preserved). In-memory only — same as the TUI,
  resets at proxy restart.
- **Backward compatibility**: `GET /dashboard/api/stats/agents` and
  the `toolStats` field on the main `/dashboard/api/config` snapshot
  are unchanged. The aggregated per-tool view is still available via
  the API; only the dashboard UI now uses the per-`(tool, agent)` view.

### Model Statistic Collapse (default 10)

The Model Statistic table in `/dashboard` now collapses to the top 10
models by default and shows a `Show all (N)` / `Collapse` toggle next
to the existing Export CSV button — same pattern as the Tool Blocklist
section.

- **Default view** shows 10 rows; the toggle is hidden when fewer than
  10 models are present, otherwise it reads `Show all (N)` (collapsed)
  or `Collapse` (expanded).
- **`Export CSV` interaction**: the existing button reads rows from the
  DOM, so it exports only the currently visible rows. Click `Show all`
  first if a full export is needed. This matches the pre-existing CSV
  behavior (the button always reflected whatever was rendered).

### Request Hot-Path Performance: Single Body Parse + Incremental Token-Window Cache

Two optimizations on the per-request hot path, applied without changing any
behavioral contract.

- **Single request body parse** (`src/index.ts`) — tool/agent stats were
  previously extracted from a `request.clone().json()` call at the top of
  the request handler, *before* the routing block parsed the same body via
  `request.text()` + `JSON.parse()`. That meant every JSON request paid
  for two full body parses (and a full body clone allocation). The
  extraction now happens inside the routing block, reading from the body
  that was already parsed for model resolution. `recordAgentStat()` is
  also called from that same site, so routed requests still record tool
  stats exactly as before; non-routed paths (`/v1/models`, `/dashboard`,
  dynamic routes) had no tool stats to record in the first place.
- **Incremental cache for `getTokensInWindow`** (`src/utils/dashboard-stats.ts`)
  — `tokenHeatmapEvents` is append-only within the 30-day retention window
  and sorted by ascending timestamp, so events older than the current
  query cutoff are immutable. The function previously did an O(n) scan of
  the entire 30-day array on every call (each call: every active token-
  limit window checks its accumulator). It now caches the sum of all
  events older than the previous cutoff in `windowSumFrozen`, with
  `windowSumCutoff` marking the boundary, and only scans the live tail
  plus absorbs newly-eligible events into the frozen sum on each call.
  Pruning (30-day `shift()`) only removes events outside any query window,
  so the frozen sum is never invalidated. Cold start still pays a single
  O(n) pass to seed the cache; subsequent calls are O(tail length).

### Token Log Persistence Made Opt-In (TUI=1 / DUMP=1)

Token log persistence (the `model_proxy_tokens.jsonl` JSONL file holding
token stats, heatmap data, and composite limit windows) is now gated on
`TUI=true|1` or `DUMP=true|1`. Without one of those flags the proxy
performs no JSONL file I/O at all — no startup restore, no day-rollover
dump, no periodic 30-min dump, no `Ctrl+U` dump.

- **src/utils/dashboard-stats.ts** — added a module-level
  `persistenceEnabled` flag plus `setStatsPersistenceEnabled(enabled)` /
  `isStatsPersistenceEnabled()` exports. `dumpTodayTokens()`,
  `dumpDailyTokens()`, `advanceDaySlotIfNeeded()` (the day-rollover dump
  path), and `loadTokenStatsFromLog()` all early-return when the flag is
  false. The in-memory `recordTokenHeatmapEvent()` 30-day pruning is
  unchanged, so heatmap stats still age out after 30 days; they just
  don't outlive the process.
- **src/server.ts** — computes `persistenceEnabled = TUI || DUMP`,
  calls `setStatsPersistenceEnabled()` once, and wraps the
  `loadTokenStatsFromLog(retentionDays)` call (and its retention-window
  computation) in an `if (persistenceEnabled)` block. The retention
  window is still derived from the configured global / composite token
  limits and falls back to 30 days when no local TOML config is available.
- The live `/dashboard` and TUI views continue to work either way — they
  read from the in-memory state, which is always populated by the request
  hot path regardless of persistence.
- See [README § 3.2 Token Log Persistence](./README.md#32-token-log-persistence)
  for the full behavior.

### Tool Blocklist (TUI `P` key)

Added a Tool Blocklist overlay in the TUI that lists every observed
`(tool, agent)` pair with `req` / `resp` / `len` counters. Press `Enter` to
toggle the block state for the highlighted tool; blocked tools are marked
with a red `✗` and stop accumulating stats (existing pre-block counts are
preserved). Blocklist state is in-memory only and resets at proxy restart.
See the **Tool Blocklist (`P`)** section in README for full details.

### TUI keybinding change

The model test picker's "test all (30m)" / "stop test timer" toggle is now
`W`. The `P` key on the main view now opens the Tool Blocklist overlay.

### Security Hardening

A batch of defensive fixes applied after review of the proxy boundary. All
user-facing behavior changes.

- **SSRF protection on internal sidecar URLs** — `PROXY_CONFIG_URL` (Consul
  config source) and `PRIVACY_FILTER_URL` (PII-redaction sidecar) are now
  validated against a new `isInternalHost()` helper (`src/utils/routing.ts`).
  The URL must resolve to `localhost` / `127.x.x.x`, an RFC-1918 range
  (`10/8`, `172.16/12`, `192.168/16`), a link-local range (`169.254/16`,
  `fe80::/10`), an IPv6 ULA (`fc00::/7`), `*.local` (mDNS), or `::1`.
  Anything else (public DNS names, public IPs, exotic schemes) is rejected
  at startup with a descriptive error. This closes the path where a
  misconfigured or attacker-controlled `PROXY_CONFIG_URL` could be used to
  exfiltrate the proxy's outbound traffic.
- **No request body in client-facing error messages** — `handleTargetApiError`
  (`src/utils/errors.ts`) used to append a 300-char preview of the upstream
  request body to the `invalid_request_error` message returned to the client.
  That body can contain user prompts, tool arguments, or PII. The preview is
  now logged server-side only via `logger.debug('errors', ...)`; the client
  gets a generic message.
- **No internal error messages from SDK handlers** — `handleSdkOpenAIRequest`
  and `handleSdkAnthropicRequest` (`src/utils/sdk-handler.ts`) caught
  exceptions and returned `error.message` verbatim to the caller, which
  could leak stack frames, file paths, or upstream error bodies. They now
  return `"An internal error occurred"`; the original error continues to be
  logged.
- **Stricter `anthropic-beta` header handling** — `validateBetaFeatures()`
  (`src/utils/beta-features.ts`) silently forwarded any unknown beta feature
  name upstream. Unknown features are now dropped. Additionally,
  CRLF/control chars are stripped from the header value before forwarding,
  so a header value like `prompt-caching\r\nX-Injected: 1` cannot be used
  to inject extra response headers.
- **Tighter API-key logging** — the partial-key formatter in
  `transformAuthHeadersForUpstream` (`src/utils/routing.ts`) used
  `first16...last8` for `x-goog-api-key`, `x-api-key`, and `Authorization`.
  Reduced to `first4...` (or `***` if shorter than 4 chars). The previous
  window could expose enough entropy to brute-force the prefix.
- **Hardened host allowlist** — wildcard entries in `ALLOWED_HOSTS`
  (`*.example.com`) now require a literal `.` separator before the domain,
  so `*.example.com` no longer matches the apex `example.com`. The wildcard
  rule now correctly rejects suffixes that are not real subdomains.

### Misc bug fixes (bundled with the hardening pass)

- `crypto.randomUUID()` replaces `Math.random()` for `resp_*` and `msg_*`
  IDs in `completions-to-responses.ts` and `responses.ts`.
- `dashboard.ts` uses `??` (not `||`) for `PROXY_CONFIG_PATH`, so an
  explicitly empty string is preserved as a real path instead of falling
  through to `null`.

### Per-(tool, agent) stats and persistence changes

- `agentToolStats` and `blockedTools` fields are now part of the dashboard
  snapshot (`src/handlers/dashboard.ts`) — `agentToolStats` is built by the
  new `getAgentToolPanelStats()` in `src/utils/dashboard-stats.ts`, which
  joins the three source maps (`agentStats`, `toolRequestChars`,
  `upstreamResponseToolStats`) into a per-(tool, agent) row keyed by
  `${tool}\0${agent}`.
- `recordToolRequestChars()` and `recordUpstreamResponseToolNames()` now
  take an `agent` argument; `createResponseToolTrackingTransformStream()`
  now takes an `agent` argument and threads it into the `flush()` callback.
  The Claude request handler (`src/index.ts`) passes the user-agent prefix
  through both call sites.
- `dumpTodayTokens()` writes a new `toolStats` field (per-(tool, agent) rows
  with `name`, `agent`, `req`, `resp`, `len`, `blocked`) in the JSONL token
  log. `loadTokenStatsFromLog()` restores those rows back into the three
  source maps on startup (latest dump per date wins, and the `blocked` flag
  is applied via `blockTool()` so the blocklist survives a restart).
- The cumulative `modelStats` Map (powers TUI "Top Models" +
  `getModelTotalTokens()`) is now also restored from the latest dump per
  date, and is **accumulated** across the latest per-date dumps (each
  per-date dump is that day's totals, so summing reconstructs true
  all-time). Previously only the daily `modelStats` map was restored, and
  the cumulative map was not restored at all.
- `recordAgentStat()`, `recordToolRequestChars()`, and
  `recordUpstreamResponseToolNames()` short-circuit on `blockedTools` so
  blocked tools no longer grow their counters.
- **Blocked tools are erased from the request body before forwarding**: a
  new `eraseBlockedTools()` helper in `src/utils/tool-blocklist.ts` runs at
  the body-parsing chokepoint in `src/index.ts` (right after the privacy
  filter). It strips tool definitions matching the blocklist from the
  `tools` array, supports the Claude / OpenAI / Gemini shapes, deletes the
  `tools` field entirely if the filter would empty it, and resets
  `tool_choice` to `'auto'` if it forces a blocked tool. Past `tool_use` /
  `tool_result` blocks in message history are intentionally left untouched.

### ChatJimmy SDK Made Optional (2026-06-17)

- **src/utils/sdk-handler.ts**: The submodule is imported through a
  non-literal dynamic specifier, so `tsc` no longer treats it as a static
  build/typecheck dependency. The existing try/catch surfaces a missing
  submodule only when an `sdk://` route is hit at runtime.
- **package.json / tsconfig.json / tsconfig.server.json**: Removed the
  unused `chatjimmy-sdk` `imports` entry and TypeScript `paths` aliases
  (nothing in `src/` imported that alias; the handler references `dist/`
  by relative path).
- **Net effect**: clone, `npm install`, `npm run typecheck`, `npm run
  build`, and `npm run server` all succeed without the submodule. See
  [Optional: ChatJimmy SDK](./README.md#optional-chatjimmy-sdk-sdk-models).

### Model Response Time Tracking

The proxy now tracks per-model response time (min/avg/max in ms) alongside
existing per-endpoint timing.

- **Recording**: `recordModelTiming(modelId, elapsedMs)` is called inside
  `runAttempt()` after each request completes (both success and error),
  using the config key (`attemptModelId`) as the timing key — same key
  used by `recordModelStat`/`recordModelUsage`
- **Storage**: `requestModelTimingStats` map (same shape as
  `requestEndpointTimingStats`: `min_time_ms`, `max_time_ms`,
  `total_time_ms`, `count`)
- **Snapshot**: `getDashboardSnapshot()` and `handleDashboardRequestStats()`
  expose `model_timings` in `requestStats`
- **TUI Custom Models**: each configured model shows `[min/avg/maxs]`
  after its description, resolved by matching `routeModel` (upstream name)
  from the config array
- **TUI Composite Aliases**: each target shows `[min/avg/maxs]` after its
  properties, resolved by matching `routeModel` from `compositeResolved`
- **Dashboard HTML**: Model Statistic table has 3 new columns (min(s),
  avg(s), max(s)) joined from `model_timings` keyed by the resolved
  upstream model name

### Composite Fallback to Default Upstream

Composite aliases now support unresolved target models by falling back to
the default upstream route (`getDefaultModelRoute`) while preserving the
target model as `modelAlias`. This allows aliases such as `code-small` to
route even when the target is not explicitly declared in `models.*`.

### Messages Format Detection Fix (Claude blocks vs OpenAI passthrough)

`/v1/messages` request detection now treats block-style Claude content
(`content: [{type:"text"|"tool_use"|"tool_result"|"thinking", ...}]`) as
Claude format, forcing Claude→OpenAI conversion for `openai-completions`
upstreams. This prevents malformed passthrough payloads to
`/v1/chat/completions`.

### Dashboard Side-Nav Active Style

The active side navigation item in `/dashboard` now has a visible border
(light gray) for clearer section focus.

### Config Reload Endpoint Rename

The config reload endpoint is now `/config-reload` (previously `/reload`).

### Token Counting Toggle Simplification

Removed `LOCAL_TOKEN_COUNTING`. Local token counting is now controlled
only by `LOCAL_TIKTOKEN` (`true`/`1` enables tiktoken-based local
counting). If API-based token counting fails, the proxy falls back to
byte-based counting for user text.

### TOML Parser Regex Order Fix

The `parseSimpleToml()` function in `config-loader.ts` checked
`unquotedMatch` (regex `key = (.+)`) before `arrayMatch` (regex `key =
[...]`). For model IDs containing only hyphens and underscores (e.g.,
`deepseek-v4-flash`), the greedy `unquotedMatch` captured the array
value but silently discarded it since `models` sections are not in its
handling scope. Models with dots (e.g., `gpt-5.4-mini`) were unaffected
because `.` is outside the `[a-zA-Z0-9_-]` character class. Fixed by
swapping the check order — `arrayMatch` is now evaluated before
`unquotedMatch`, with a comment explaining the ordering constraint. This
fixes composite model resolution (e.g., `code-small` → `deepseek-v4-flash`)
where the candidate model key was previously never found in its category.

### Thinking Block Validation Field Fix

`ThinkingBlock` type defines field `thinking: string`, but
`validateClaudeContentBlock()` in `validation.ts` was checking `block.text`
for `type: "thinking"` blocks. This caused validation to throw `text is
required for thinking blocks` when Claude CLI sent requests with thinking
content blocks in assistant messages (the field is `thinking`, not `text`).
Fixed by changing the check to `block.thinking`.

### Upstream Error Diagnostics

The proxy now reads and logs upstream error response bodies in
`handleClaudeRequest` before throwing, making it possible to diagnose
API-level errors (e.g., DeepSeek returning 400 about thinking mode).

### DeepSeek Thinking Mode Compatibility

Some upstreams (e.g., DeepSeek's Anthropic-compatible API) internally
default models to thinking mode and require prior `content[].thinking`
blocks in the conversation even on the first request. The proxy now:

- Defaults `thinking` to `disabled` when the client doesn't set it
- Strips `thinking: { type: "enabled" }` when there are no prior
  assistant thinking blocks in the conversation history (avoids 400
  errors on first requests)

### Full Request Body Logging

Added debug-level logging of the full request body sent to upstreams in
`handleClaudeRequest` for easier troubleshooting.

### Thinking Signature Support & Streaming Improvements

- **Signature Delta Events**: Added full `signature_delta` support for
  thinking block verification in streaming
- **OpenAI-to-Claude Conversion**: Enhanced conversion of OpenAI's
  `reasoning_item_id` and `signature` to Claude's thinking format
- **Streaming Thinking Extraction**: Improved thinking content extraction
  from `<thinking>` markers and `reasoning_content` fields
- **Thinking Block Lifecycle**: Proper `content_block_start/delta/stop`
  events for thinking blocks in streaming

### Gemini `:countTokens` Endpoint

Added routing for `POST /v1beta/models/{model}:countTokens` and
`POST /v1/models/{model}:countTokens`. The request body is proxied as-is
to the upstream Gemini API and the raw JSON response (`totalTokens`) is
returned. Previously these paths fell through to an "Unsupported fixed
route" error (HTTP 500).

### OpenAI Handler Error Propagation Fix

`handleOpenAIRequest` previously threw a plain `Error` on upstream
non-2xx responses, which the outer error handler converted to HTTP 500
regardless of the actual upstream status. For streaming requests, it
silently returned HTTP 200 with the error wrapped in an SSE frame. Both
paths now use `handleTargetApiError()`, propagating the correct upstream
status code (401, 403, 429, etc.) to the client — matching the behavior
of the Claude and Gemini handlers.

---

## 2026-03-04 — ChatJimmy SDK Integration

**Optional, lazily-loaded submodule**: ChatJimmy SDK lives in
`submodules/chatjimmy` and is loaded at runtime via dynamic import only
when an `sdk://` model is requested. It is not required to build or run
the proxy.

**SDK Handler**: `src/utils/sdk-handler.ts` provides SDK-based request
handling:

- **SDK URL detection**: `sdk://` URLs use chatjimmy SDK clients instead
  of HTTP fetch
- **OpenAI-compatible mode**: `handleSdkOpenAIRequest()` uses
  `OpenAICompatibleClient`
- **Anthropic-compatible mode**: `handleSdkAnthropicRequest()` uses
  `OpenAICompatibleClient` as fallback
- **Streaming support**: SDK Anthropic stream is converted from OpenAI
  chunks to Claude SSE event format (`message_start`, `content_block_*`,
  `message_delta`, `message_stop`)
- **Streaming fallback**: If SDK stream is unavailable, falls back to
  non-stream response

---

## 2026-03-03 — Enhanced Thinking Configuration

- **Type Definitions**: Updated `ThinkingConfigParam` type to accept
  `boolean` values (`true`/`false`) in addition to string values
  (`"enabled"`/`"disabled"`)
- **Normalization Utility**: Added `normalizeThinkingConfig()` function to
  standardize thinking config across the codebase
- **Token Counting**: Updated token counting logic to handle boolean
  thinking types
- **Validation**: Enhanced validation to accept boolean values while
  maintaining backward compatibility

## 2026-03-03 — Thinking Signature Support

- **Signature Delta Events**: Added `"signature_delta"` to
  `ClaudeStreamEvent.delta.type` for streaming signature verification
- **Streaming Signature Emission**: Implemented `signature_delta` event
  emission before `content_block_stop` for thinking blocks
- **Signature Accumulation**: Accumulates signatures from multiple
  sources: `delta.signature`, `reasoning_item_id`, and `signature` fields
- **OpenAI-to-Claude Conversion**: Converts OpenAI's `reasoning_item_id`
  and `signature` to Claude's `signature_delta` format
- **Anthropic Pass-Through**: Passes through `signature_delta` events
  from Anthropic upstream unchanged
- **Non-Streaming Compatibility**: Includes signature in thinking block
  metadata for non-streaming responses

**Files modified** (covers the Model Response Time Tracking, Thinking
Signature Support, and adjacent changes):

- `src/utils/dashboard-stats.ts` — added `requestModelTimingStats` map,
  `recordModelTiming()`, `getRequestModelTimingStatsDesc()`
- `src/index.ts` — `recordModelTiming(attemptModelId, elapsedMs)` called
  inside `runAttempt()` for all requests
- `src/handlers/dashboard.ts` — `model_timings` in snapshot/API, 3 new
  columns (min/avg/max) in HTML model stats table and CSV export
- `src/tui.ts` — timing display (`[min/avg/maxs]`) in Custom Models
  section and Composite Aliases overlay
- `src/types/claude.ts` - Added `"signature_delta"` to stream event types
- `src/converters/streaming.ts` - Added signature accumulation and
  emission logic
- `src/converters/openai-to-claude.ts` - Enhanced signature extraction
  from response metadata

## 2026-03-03 — Gemini v1 Endpoint Support

- **Path Pattern Matching**: Updated regex patterns to support both
  `/v1beta/models/` and `/v1/models/` endpoints
- **URL Building**: Enhanced URL construction logic for both v1beta and
  v1 endpoints
- **Model Extraction**: Improved model ID extraction from both endpoint
  versions

## 2026-03-03 — API Key Management

- **Priority Logic**: Added intelligent API key priority based on
  upstream mode
- **Format Utility**: Created `formatApiKeyForUpstream()` function for
  consistent header formatting
- **Header Transformation**: Enhanced
  `transformAuthHeadersForUpstream()` to handle `Bearer` prefix stripping
- **Configuration Integration**: Better integration of config API keys
  with request processing

**Files modified** (covers the Enhanced Thinking Configuration, Gemini v1
Endpoint Support, and API Key Management changes):

- `src/converters/claude-to-gemini.ts` - Added boolean thinking support
  for Gemini conversion
- `src/converters/claude-to-openai.ts` - Added boolean thinking support
  for OpenAI conversion
- `src/index.ts` - Enhanced routing for v1 endpoints, API key priority
  logic
- `src/types/claude.ts` - Updated ThinkingConfigParam type definition
- `src/utils/routing.ts` - Added `formatApiKeyForUpstream()`, enhanced
  path matching
- `src/utils/thinking.ts` - Added normalization utility, updated all
  thinking functions
- `src/utils/token-counting.ts` - Updated to handle boolean thinking
  types
- `src/utils/validation.ts` - Enhanced validation for boolean thinking
  values

---

## 2026-02-28 — Gemini CLI Config Integration

Successfully tested proxy using **Gemini CLI configuration** from
`~/.gemini/.env`. All models work with the CLI's base URL and API key
settings.

**Gemini CLI Config Test Results:**

| Test Suite       | Models Tested | Passed | Success Rate |
|------------------|---------------|--------|--------------|
| Basic Models     | 10            | 9      | 90%          |
| Gemini Models    | 3             | 3      | 100%         |
| Claude Models    | 6             | 5      | 83.3%        |
| Thinking Models  | 10            | 7      | 70%          |
| **Total**        | **29**        | **24** | **82.8%**    |

**Basic Models (90% success):**

- deepseek/deepseek-v3.1
- deepseek-r1
- minimax/minimax-m2.1
- moonshotai/kimi-k2.5
- minimax/minimax-m2.5
- qwen3-32b
- deepseek/deepseek-v3.2-exp
- z-ai/glm-4.7
- moonshotai/kimi-k2-0905
- z-ai/glm-5 (upstream issue)

**Gemini Models (100% success):**

- gemini-2.5-flash
- gemini-3.1-pro-preview
- gemini-3.0-flash-preview

**Claude Models (83.3% success):**

- claude-4.6-sonnet
- claude-4.5-opus
- claude-4.5-haiku
- claude-4.0-sonnet
- claude-3.7-sonnet
- claude-4.1-sonnet (invalid request)

**Thinking Models (70% success):**

- deepseek/deepseek-v3.2-exp-thinking
- deepseek/deepseek-v3.1-terminus-thinking
- deepseek-r1-0528
- qwen3-30b-a3b-thinking-2507
- qwen3-next-80b-a3b-thinking
- doubao-1.5-thinking-pro
- moonshotai/kimi-k2-thinking
- qwen3-vl-30b-a3b-thinking (upstream unavailable)
- qwen3-235b-a22b-thinking-2507 (upstream unavailable)
- doubao-seed-1.6-thinking (upstream unavailable)

**Key Findings:**

- Proxy works seamlessly with Gemini CLI config (`~/.gemini/.env`)
- Uses `GOOGLE_GEMINI_BASE_URL` and `GEMINI_API_KEY` from CLI config
- 82.8% overall success rate across 29 models from 6+ providers
- All Gemini models (100%) and most Claude models (83.3%) working
- All thinking models show step-by-step reasoning
- SSE streaming: complete message boundaries guaranteed (fixed 2026-03-02)
- 5 failures: 1 upstream issue, 1 invalid request, 3 unavailable models

**Test scripts:**

- `test_gemini_cli.sh` - Basic models test (10 models)
- `test_gemini_models_cli.sh` - Gemini models test (3 models)
- `test_claude_models_cli.sh` - Claude models test (6 models)
- `test_thinking_cli.sh` - Thinking models test (10 models)

## 2026-02-28 — Unconfigured Models Validated

Successfully tested proxy with **no specific model IDs configured** in
`proxy_config.toml`. All models used fallback configuration from
`[models.default]` and `[upstream]` sections.

**Test Results: 100% Success (24/24 tests passed)**

| Test Suite      | Models | Tests | Passed | Success Rate |
|-----------------|--------|-------|--------|--------------|
| DeepSeek Models | 2      | 6     | 6      | 100%         |
| Thinking Models | 4      | 12    | 12     | 100%         |
| SSE Streaming   | 2      | 6     | 6      | 100%         |
| **Total**       | **8**  | **24**| **24** | **100%**     |

**Key Findings:**

- Unconfigured models work perfectly with default settings
- All 3 endpoints supported: `/v1/messages`, `/v1/interactions`,
  `generateContent`
- SSE streaming works for all endpoints
- Thinking/reasoning models work without special configuration
- Fallback chain validated: `[models.default]` → `[upstream]` →
  hardcoded defaults

See `docs/test_results_unconfigured_models.md` for complete details.

## 2026-02-28 — ENV Variables Removed

Removed `FIXED_ROUTE_TARGET_URL` and `FIXED_ROUTE_PATH_PREFIX` environment
variables. All configuration now in `proxy_config.toml`:

**Configuration hierarchy for unconfigured models:**

```
1. [models.default].upstream_mode / base_url / api_key
   ↓ (if missing)
2. [upstream].upstream_mode / default_base_url / default_api_key
   ↓ (if missing)
3. Configurable fallback: "openai-completions" / "https://api.qnaigc.com"
   (hardcoded in src/utils/config-loader.ts, src/index.ts, and src/tui.ts;
    override by setting [upstream].default_base_url or [models.default].base_url
    in proxy_config.toml — there is no env var to override this final fallback)
```

See `docs/config_env_removal.md` for migration guide.

## 2026-02-27 — Config Structure Updated

The routing logic and configuration structure have been revised to align
implementation with documentation:

- **Category-based config**: Models grouped by provider with inheritance
- **Array format**: `["model-alias", "base-url", "api-key"]` with empty
  string inheritance
- **Explicit upstream_mode**: `anthropic-messages`,
  `gemini-generatecontent`, `openai-completions`
- **No normalization**: Model names preserved as-is (e.g.,
  `"deepseek/deepseek-v3.2"`)

See `docs/routing_config_revision.md` for complete details.

## 2026-02-25 — Comprehensive Testing (Production Ready)

See [README.md § Testing](./README.md#-testing) for the consolidated test
result tables and provider success rates. Detailed per-suite breakdowns
live in `docs/test_results_*.md` and `docs/*_test_results.md`.
