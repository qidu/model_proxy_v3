---
version: v1
status: draft
---

# Plan: Remote target-retry dispatch interface

## Goal

When a single upstream request to one target fails, ask a remote **dispatch server**
(a sidecar, analogous to the existing `[remote] auth_server`) for a
replacement target — `{target, base, mode, key, otac}` — and retry the same logical
request against it, without involving the client.

This is a **per-target, low-level failure-over**, deliberately orthogonal to the
config-driven `[composite]`/`[schedule]` fallback: it wraps each individual upstream
attempt (composite candidate *or* single non-composite attempt) and resolves the failure
before the composite loop ever sees it. Composite share decay only ever runs for targets
that dispatch could not rescue.

## Decisions (confirmed with the user)

- **Placement**: low level, per-attempt — **not** part of the composite fallback list.
- **Triggers**: non-2xx upstream, network/transport errors, and timeout-before-first-byte.
- **Optional**: also retry non-SSE response bodies (`buffer_non_sse`), by buffering them;
  SSE streaming to the client is never buffered and never retried mid-stream.
- **Contract**: request carries `(target model, otac, base_url, schema, error)`; response
  returns a retrying `(target, key, base_url, otac)`.
- **Fail-open on dispatch failure**: if the dispatch server is unreachable / times out,
  the original upstream error is preserved and rethrown (no fabricated route).
- **The descriptor is self-contained; there is NO model-resolution step.** The client may
  request a model the **auth server knows but the proxy has no `[models.*]` entry for**. So a
  descriptor is *not* an overlay on a config-resolved route — it is the complete route.
  `target` + `base` are **required**; `mode` defaults to `[default_upstream].upstream_mode`
  (→ `openai-completions`); `key` is optional (absent ⇒ normal client-key passthrough).
  Config resolution (`[models.*]` / `[composite]` / `[schedule]`) is **skipped entirely**,
  matching `docs/auth-stats-protocol.md:79-80` literally. See Why the descriptor must be
  self-contained.
- **Separate ladder, not the composite loop.** When `targets[]` is present the ladder
  short-circuits *before* route resolution and owns the whole dispatch, including the
  post-response pipeline. The existing composite loop (`src/index.ts:2469`) is left untouched
  and never runs for override requests.
- **Two independent retry axes** (confirmed): the default trigger set decides whether the
  ladder **advances to the next entry**; a per-entry `retry_on` decides whether to **re-hit
  the same target in place** first. They are orthogonal knobs, not one overriding the other.
- **Config shape**: a **single flat `[remote]` table** — no `[remote.authentication]` /
  `[remote.recording]` / `[remote.dispatch]` subsections. Roles stay distinct as prefixed
  keys (`auth_*` / `record_*` / `dispatch_*`); only the nesting changes. The three roles
  keep their opposite failure semantics (auth fail-closed, dispatch fail-open, recording
  fire-and-forget), which is why they are not collapsed into one URL/contract.
- **No dual-parse**: the legacy `[remote.authentication]` / `[remote.recording]` subsections
  are dropped, not accepted alongside the flat keys — a hard switch. An existing config that
  still carries the old subsections silently disables auth/recording until migrated; the
  migration must ship with a CHANGELOG + README note.

## Scope of this slice — Phase 1: auth targets failover

This document describes the full design (auth override **and** the dispatch keys). The
first implementation slice is deliberately narrower — **auth targets failover only**:

> When `[remote] auth_server` returns a `200` whose body carries a `targets`
> array, parse it into `RemoteTargetDescriptor[]`, use `targets[0]` as the initial route, and
> try the remaining entries in order as a **failover ladder** on an upstream failure.

Concretely in scope:

- Parse the auth `200` response body → `targets` (new: today the body is read only for
  error text, `src/index.ts:1011/1025`, and otherwise discarded).
- Build each entry into a **self-contained** `ModelRouteConfig` (no `[models.*]` lookup, no
  inheritance chain), then route through the existing `buildRouteAttempt`.
- Support the **no-alias case**: a requested model with no `[models.*]` entry, routed purely
  from the descriptor. This is the driving use case, not an edge case.
- Short-circuit **before** compositeAttempts construction (`src/index.ts:1382`), and own the
  post-response pipeline (`recordRequestTiming` / `restorePrivacyResponse` /
  `applyCorsHeaders`).
- Per-entry validation: `target` non-empty; `base` present and passing `isHostAllowed`;
  `mode` (if present) a known handler mode; `timeout` (if present) a finite positive number;
  `retry_on` (if present) an array of finite integers — **invalid entry ⇒ drop that entry
  (ERROR log) and continue the ladder with the remaining entries**, including an invalid
  `targets[0]`. If every entry is invalid, fall back to normal config resolution.
- Axis 1 — per-entry failover: on a retryable outcome (default trigger set) advance to the
  next entry; per-entry `timeout` feeds the abort signal.
- Axis 2 — per-entry same-target retry governed by `retry_on`.
- A proxy-side `max_targets` cap bounding the remote-supplied array length.
- Thread the entry's `otac` so that rung's `record_server` record stays linked.

Explicitly **deferred** to later slices (still designed below, not built now):

- The dispatch-role sidecar and its `callDispatchServer` round-trip.
- Extending the retry ladder with dispatch-returned targets after the auth array is exhausted.
- `buffer_non_sse` (non-SSE buffered body retry).

Acceptance:

1. An auth server that returns `targets: [A, B]` where `A` fails causes the same logical
   request to be retried on `B` without the client seeing it; composite share decay does
   **not** run for the rescued attempt.
2. The same works for a client model that has **no `[models.*]` entry at all** — no request
   ever reaches `http://localhost`, and the upstream sees the descriptor's `base`/`key`.

## Background: current failure handling

- Upstream non-2xx is turned into a thrown `ClaudeProxyError` by
  `handleTargetApiError` (`src/utils/errors.ts:288`) — **in most handlers, but not all**.
  `chat-completions.ts:119-125` and `embeddings.ts:53-63` instead
  `return new Response(errText, { status })`, forwarding the upstream error verbatim. Those
  failures therefore arrive at the ladder as a *returned Response*, not a thrown error, and a
  `try/catch`-only ladder would treat them as success and never fail over. (The existing
  composite loop has this same blind spot today.)
- Do **not** normalize those two handlers to throw: passing the upstream error body through
  byte-for-byte is deliberate, and `handleTargetApiError` would reshape it into the proxy's
  own error envelope. Instead the ladder classifies on **both** axes via a single
  `isRetryableOutcome(outcome)`, where `outcome` is
  `{ ok, status, error? }` derived from either a returned `Response` (`status >= 400`) or a
  caught error (`ClaudeProxyError.status`, or `classifyTransportError` → 502/504).
- Transport errors throw as-is; `classifyTransportError` (`src/utils/errors.ts:102`)
  maps them to a synthetic 502/504 for share-decay purposes.
- Both propagate out of `runAttempt` (`src/index.ts:2142`) into the composite loop's
  `catch` (`src/index.ts:2491`), which decays share and tries the next precomputed
  candidate, then `throw lastError` (`src/index.ts:2523`).
- The single non-composite path calls `runAttempt` once (`src/index.ts:2527`) with no retry.
- Upstream `fetch(targetUrl, ...)` is issued **inside each handler** (claude.ts:127,
  messages.ts:421/720, openai.ts:848/995, gemini.ts:143, chat-completions.ts:100/465,
  responses.ts:564/780, embeddings.ts:43, models.ts:110/194, token-counting.ts:222, …).
- Auth-sidecar plumbing to reuse: `doAuthRequest` fetch (`src/index.ts:999`),
  `getSidecarForwardedHeaders(request)` (`src/utils/routing.ts:585`),
  `modelUsageOneTimeAuthCode` (`src/index.ts:968`), SSRF allow-list
  `isHostAllowed` (`src/utils/routing.ts:78`, re-exported at :16) and
  `getAllowedHostsFromConfig` (`src/utils/config-loader.ts:2398`).

## Design

### Config

**Single flat `[remote]` table** (decided) — the shipped `[remote.authentication]` /
`[remote.recording]` subsections are removed and the flat keys replace them. Type block
`src/utils/config-loader.ts:33-44`:

```toml
[remote]
# auth role — pre-route gate, fail-CLOSED (401/503 to client on failure)
auth_server           = "http://127.0.0.1:8787/auth"     # absent ⇒ auth off
auth_with_model       = false
auth_with_body        = false
auth_passthrough_with = "user_key"                       # "user_key" | "config_key"
max_targets           = 4        # cap on the remote-supplied targets[] ladder length
max_target_retries    = 1        # axis 2: same-target retries per entry (0 disables)

# recording role — post-response, fire-and-forget (never affects the client)
record_server         = "http://127.0.0.1:8787/record"   # absent ⇒ recording off
record_response_body  = false

# dispatch role — on-failure retry, fail-OPEN (rethrow original error on failure)
dispatch_server       = "http://127.0.0.1:8788/dispatch" # absent ⇒ feature off
max_dispatches        = 2        # loop guard per attempt
dispatch_timeout_ms   = 2000     # bound the oracle call so a hung sidecar can't stall
buffer_non_sse        = false    # optional: buffer non-SSE bodies so mid-body failures retry
```

```ts
remote?: {
  // auth role — pre-route gate, fail-CLOSED
  auth_server?: string;
  auth_with_model?: boolean;
  auth_with_body?: boolean;
  auth_passthrough_with?: 'user_key' | 'config_key';
  max_targets?: number;
  max_target_retries?: number;
  // recording role — post-response, fire-and-forget
  record_server?: string;
  record_response_body?: boolean;
  // dispatch role — on-failure retry, fail-OPEN
  dispatch_server?: string;
  max_dispatches?: number;
  dispatch_timeout_ms?: number;
  buffer_non_sse?: boolean;
};
```

Role key names/semantics are unchanged; only the nesting flattens. Parse sites collapse to
a single `currentSection === 'remote'` branch (TOML section-open `:2695-2703`, TOML
key/value `:2748-2759`, JSON `:3059-3071`); the serializer emits one `[remote]` block
(`:2262-2272`); snapshot flags (`:3388-3389`) gain `remote_dispatch_active`
(`!!config.remote?.dispatch_server`) beside `remote_auth_active` / `remote_recording_active`.

**Breaking.** With hard-switch (no dual-parse), a `proxy_config.toml` still using the old
subsections loses auth+recording on upgrade — the migration is part of this work, not
follow-up.

### Why the descriptor must be self-contained

The driving case: **the client requests a model the remote auth server knows about, but which
has no alias entry on the proxy side.** There is nothing in `[models.*]` to resolve, so any
design that treats the descriptor as a *partial overlay on a resolved route* is unsafe.

Concretely, `getModelRouteConfig` (`config-loader.ts:1037-1072`) never throws for an unknown
model — it falls through to `getDefaultModelRoute` (`:771-790`), which yields:

```
targetUrl:   [default_upstream].default_base_url  ||  "http://localhost"
apiKey:      [default_upstream].default_api_key   ||  undefined
upstreamMode:[default_upstream].upstream_mode     ||  "openai-completions"
```

So "merge the descriptor over the inheritance chain" would mean: a descriptor that omits
`base` silently routes to **`http://localhost`**, and one that omits `key` sends **no API
key** upstream. Both are broken requests that *look* like a configured fallback. Hence:

- `target` and `base` are **required** on every entry; an entry missing either is invalid and
  is dropped (see Invalid-entry handling).
- `mode` is optional, defaulting to `[default_upstream].upstream_mode` then
  `openai-completions` — the one field where falling back to global config is safe, because
  it selects a wire format rather than a destination or a credential.
- `key` is optional: absent ⇒ the normal client-key passthrough
  (`transformAuthHeadersForUpstream`, `routing.ts:349`) applies, exactly as for a config
  route with no `api_key`.
- `transforms` names are resolved against `[transforms.*]` via `resolveTransforms`
  (`config-loader.ts:541`) with **no section layer** — mode-defaults still apply (they key off
  `mode`, which is always known), the sector layer does not (there is no section).

The descriptor is therefore assembled directly into a `ModelRouteConfig` and handed to the
existing `buildRouteAttempt` (`src/index.ts:1724`) — reusing the request-building and
path×mode machinery without reusing config resolution.

### Why reuse `buildRouteAttempt` (and not "rebuild the attempt")

An earlier draft had `rebuildAttempt` swap `modelId` / `targetUrl` / `authHeaders` on an
existing `RouteAttempt`. That cannot work, for two independent reasons:

1. **`RouteAttempt.request` carries a single-use body stream.** Handlers consume it
   (`request.json()` / `request.clone().text()`, e.g. `src/index.ts:2153`). A second
   `runAttempt` on the same `Request` throws *"Body is unusable"*. The composite path avoids
   this only because `buildRouteAttempt` mints a **fresh `Request` per candidate**
   (`src/index.ts:1733-1737`). Swapping `modelId` alone would also leave the *old* model id
   in the serialized body — composite re-stringifies `{...bodyObj, model: upstreamModelName}`
   (`:1732`) precisely to avoid that.
2. **`targetUrl` is not a field, it is a path×mode matrix.** `buildRouteAttempt`
   (`:1724-1900+`) derives `targetUrl`, `handlerType`, `upstreamMode` and `forceStreaming`
   from `(path, route.upstreamMode, bodyObj.stream)` — gemini needs the model *inside* the
   URL plus `:streamGenerateContent?alt=sse`, anthropic gets `v1/messages`, openai gets
   `v1/chat/completions`. A descriptor `mode` change also changes **which handler runs**
   (`runAttempt`'s switch, `:2234`).

So the ladder reuses the existing builder instead of reimplementing it:

```
descriptor (target+base required, mode/key/transforms/timeout optional)
  -> ModelRouteConfig, built directly       # NO config resolution, NO inheritance chain
  -> buildRouteAttempt(target, route, bodyObj)   # fresh Request, correct model id,
                                                 # resolveTransforms, path x mode matrix
  -> runAttempt
```

**Module boundary consequence.** `buildRouteAttempt` is a *closure inside the request
handler* in `index.ts` (it captures `request`, `path`, `requestId`, `env`, `useConfigKey`,
…), so it cannot be imported by `src/utils/target-retry.ts`. Therefore:

- `src/utils/target-retry.ts` exports only **pure, injectable** pieces: descriptor parsing,
  per-entry validation, descriptor→`ModelRouteConfig`, and outcome classification.
- The **ladder itself stays in `index.ts`**, where `buildRouteAttempt` and `runAttempt` are in
  scope. (The earlier draft listed the ladder in both files — that was contradictory.)

### Retry layer placement

**A separate ladder that replaces dispatch — it does not wrap the composite loop.** When the
auth response carried `targets[]`, the ladder short-circuits **before** the compositeAttempts
construction block (`src/index.ts:1382-1418`), not at the `runAttempt` call sites.

Short-circuiting *early* is required, not stylistic: with no `[models.*]` entry for the
requested model, letting normal resolution run first would build a bogus
`getDefaultModelRoute` candidate pointed at `http://localhost` (see Why the descriptor must be
self-contained), and could set `compositeAliasName` / `_coordCandidate` / `_fusionPlan` state
that the ladder would then have to unwind.

```
# at dispatch, before compositeAttempts construction:
if overrideEntries:
    response = await runTargetLadder(overrideEntries, bodyObj)
    recordRequestTiming(path, Date.now() - requestStartTime)
    return applyCorsHeaders(await restorePrivacyResponse(response, piiMapping, ...), request, env)
# else: existing composite loop / single-attempt path, unchanged
```

Because the ladder replaces the dispatch rather than nesting inside it, it **owns the
post-response pipeline** — `recordRequestTiming`, `restorePrivacyResponse`, `applyCorsHeaders`
— which the two existing call sites currently apply (`:2487`, `:2537`). Missing any of these
would silently drop PII restoration or CORS for override requests only.

```
runTargetLadder(entries, bodyObj):
  valid = [e for e in entries if e.valid]          # validate+drop FIRST
  valid = dedupe(valid, key = target@base@key)     # then dedupe
  valid = valid[0 .. max_targets-1]                # then cap ATTEMPTS, not array slots
  if valid is empty: fall back to normal config resolution

  lastOutcome = null
  for entry in valid:
    route   = descriptorToRoute(entry)             # self-contained; no config resolution
    attempt = buildRouteAttempt(entry.target, route, bodyObj)   # fresh Request per rung
    setOtacForThisRung(entry.otac)

    # --- axis 2: same-target retry (retry_on) ---
    for n in 0 .. max_target_retries:
      outcome = await runAttemptCapturingOutcome(attempt)
      if outcome.ok: return outcome.response
      if !entry.retry_on?.includes(outcome.status): break
      if n == max_target_retries: break
      await delay(backoff(n))
      attempt = buildRouteAttempt(entry.target, route, bodyObj)  # body is single-use

    lastOutcome = outcome
    # --- axis 1: advance ladder (default trigger set) ---
    if !isRetryableOutcome(outcome): break         # 400/404/422 stop the ladder

  # exhausted (or stopped): surface the LAST failure in its original form
  if lastOutcome.response: return lastOutcome.response   # returned-Response handlers:
                                                          # give the client the verbatim body
  throw lastOutcome.error                                 # thrown ClaudeProxyError / transport
```

Two details the earlier draft got wrong:

- **Validate → dedupe → cap, in that order.** Capping the raw array first meant
  `[invalid, invalid, A, B, C]` with `max_targets = 4` tried only `A, B` and silently dropped
  a perfectly good `C`. The cap must bound real attempts.
- **The exhausted path cannot be `throw lastError` alone.** A failure from
  `chat-completions.ts` / `embeddings.ts` is a *returned `Response`*, not a thrown error —
  there is nothing to throw, and the verbatim upstream error body must reach the client
  (asserted in Testing). Hence the two-branch ending.

Note `buildRouteAttempt` is re-invoked on **every** rung *and* every same-target retry —
each needs its own `Request` (reason 1 above). `bodyObj` is the reusable parsed object.

### Proxy → dispatch request

`POST {dispatch_server}` with the same forwarded-header set `doAuthRequest` builds
(`src/index.ts:987`, including `getSidecarForwardedHeaders`), body:

```json
{
  "request_id": "...",
  "endpoint": "/v1/messages",
  "client_model": "claude-sonnet-4-6",
  "target_model": "gpt-5",
  "base_url": "https://api.openai.com/v1",
  "schema": "openai-completions",
  "attempt": 1,
  "response_status": 401,
  "error": "upstream returned 401 ...",
  "one_time_auth_code": "otac_abc123",
  "prev_targets": ["gpt-5@https://api.openai.com/v1"]
}
```

`schema` is derived from the handler type / upstream mode already known on the attempt.
Transport errors send `response_status: null` with the error string.

### Shared target descriptor

Both remote responses use **one** target descriptor, so the auth override and the
dispatch response never drift. `targets` is an ordered array; the proxy tries entries in
order (per-entry failover) before falling back to config resolution or spending another
dispatch round-trip:

```ts
interface RemoteTargetDescriptor {
  target: string;              // REQUIRED — upstream model id
  base: string;                // REQUIRED — base_url (no safe fallback; see below)
  mode?: string;               // upstream_mode; default [default_upstream] -> openai-completions
  key?: string;                // api_key; absent => normal client-key passthrough
  otac?: string;               // replaces modelUsageOneTimeAuthCode for this rung
  transforms?: string;         // comma-separated [transforms.*] set names
  timeout?: number;            // abort deadline, ms (Phase 1: whole-request)
  retry_on?: number[];         // axis 2 only: statuses worth re-hitting THIS target on
}
```

`target` and `base` are **required** because the requested model may have no `[models.*]`
entry at all — there is no config route to inherit a destination from, and the silent fallback
is `http://localhost` (see Why the descriptor must be self-contained). `mode` and `key` have
safe fallbacks; a destination does not.

`timeout` and `retry_on` are the fields added for this change:

- `timeout`: the abort deadline for the upstream call, ms, carried on the resolved
  `ModelRouteConfig` (see Guards). Absent ⇒ keep the env/default `UPSTREAM_BODY_TIMEOUT_MS`.
- `retry_on`: optional per-entry status list driving **axis 2 — same-target retry**. A failure
  whose status is in this list is re-attempted against *the same target* (up to
  `max_target_retries`) before the ladder advances. It does **not** decide whether the ladder
  advances — that is axis 1's default trigger set. Absent ⇒ no same-target retry, go straight
  to the next entry.

`otac` and `retry_on` are **not** in the operator-facing contract yet
(`docs/auth-stats-protocol.md:71-73` lists only `target`/`mode`/`base`/`key`/`transforms`/
`timeout`). Shipping them means amending that doc — see Protocol doc amendments.

### The two retry axes

They are orthogonal. Axis 1 asks *"is this failure worth trying a different target?"*; axis 2
asks *"is this failure worth re-hitting the same target?"*.

| | Axis 1 — advance ladder | Axis 2 — same-target retry |
|---|---|---|
| Governed by | default trigger set (fixed, proxy-side) | per-entry `retry_on` (remote-supplied) |
| Bound | `max_targets` | `max_target_retries` |
| On miss | **stop the ladder**, rethrow to client | no in-place retry; fall through to axis 1 |

**Axis 1 default trigger set** (fixed; replaces the earlier "any non-2xx retries"):

- retryable → `429`, `5xx`, transport errors (DNS / refused / TLS / abort), pre-first-byte timeout
- terminal → `400`, `401`, `403`, `404`, `413`, `422` and other deterministic 4xx

Rationale: a malformed or unauthorized request gets the *same* answer from every target, so
walking the ladder just re-sends and re-bills the full prompt N times.

**Implementation note — this collapses to two comparisons.** `classifyTransportError`
(`errors.ts:102-136`) already maps *every* transport failure to `502` and *every*
abort/timeout to `504` before the ladder sees it. So "transport" and "timeout" are not
separate checks:

```ts
isRetryableOutcome = (o) => o.status === 429 || o.status >= 500;
```

Listing them as distinct rows above is for the reader; implementing them as distinct branches
(e.g. re-sniffing `err.code`) would duplicate the classifier and drift from it.

Worked example, `targets: [A(retry_on=[429]), B, C]`:

- A returns `429` → in `retry_on` ⇒ re-hit A in place; still `429` ⇒ axis 1 says `429` is
  retryable ⇒ advance to B.
- A returns `500` → not in A's `retry_on` ⇒ no in-place retry; axis 1 says `5xx` is retryable
  ⇒ advance to B.
- A returns `400` → no in-place retry; axis 1 says terminal ⇒ **stop**, return `400`. B and C
  are never tried.

**Axis 2 bounds.** Inline retries block a waiting client, so the only existing backoff in the
repo (`provider-quota.ts:350`, exponential 5s → 30min) is **not** a usable precedent — it
governs a background cache. Use a short, explicitly-bounded policy:
`max_target_retries = 1` default (0 disables), delay `250ms * 2^n` capped at `2s`, and the
whole ladder additionally bounded by the client's own abort signal. Honor a `Retry-After`
response header when present and shorter than the cap.

### Dispatch → proxy response

`200` JSON — `targets` is the shared descriptor array (same shape as the auth override):

```json
{ "targets": [
    { "target": "claude-opus-4-6", "base": "https://proxy.internal/anthropic",
      "mode": "anthropic", "key": "sk-...", "otac": "otac_xyz789", "timeout": 30000,
      "retry_on": [429, 500, 502, 503] },
    { "target": "gpt-5", "base": "https://api.openai.com/v1",
      "mode": "openai-completions", "timeout": 10000 }
] }
```

- `204` / `{}` / empty `targets` ⇒ give up, rethrow original error.
- Non-200 / timeout / network error ⇒ fail open, rethrow original error (never swallow).
- Auth-response override uses the identical array/descriptor (see README
  "Auth dynamic-routing override" and `docs/auth-stats-protocol.md`).

### Trigger matrix

Axis 1 (advance the ladder). Applies identically whether the handler **threw** or **returned**
a `>= 400` Response — see Background.

| Failure                                          | Retry? |
| ------------------------------------------------ | ------ |
| Upstream `429` or `5xx`                          | yes    |
| Upstream `400` / `401` / `403` / `404` / `413` / `422` (deterministic) | no — stop the ladder, rethrow |
| Transport: DNS / refused / TLS / abort           | yes    |
| Timeout before first byte (SSE or non-streaming) | yes    |
| Global `UPSTREAM_BODY_TIMEOUT_MS` reached **after** SSE first byte | no — mid-stream, bytes already sent to client |
| Mid-stream failure on **SSE** body               | no — bytes already sent to client |
| Mid-body failure on **non-SSE** body, `buffer_non_sse = true` | yes — body fully read before forwarding |
| Client cancellation / disconnect                 | no — **not reachable**, see below |

Client disconnect never reaches the ladder as an outcome to classify: the upstream fetch's
abort signal is `createUpstreamAbortSignal(...)`, an independent timer — nothing threads the
inbound `request.signal` into it. So this row records an outcome, not a check to implement.

SSE detection: response `content-type` contains `text/event-stream`. When
`buffer_non_sse` is on, the retry layer reads the whole body for non-SSE responses (so a
read error is catchable) and re-wraps it as a complete `Response` before returning.
Per-entry `timeout` stops applying once SSE first-byte is observed (see Guards and
precedence); everything after that point is governed by the existing global timeout, with no
failover — the SSE mid-stream row above is unchanged by this plan.

### Guards and precedence

- `max_targets` bounds the ladder (the array length is remote-controlled — without a cap an
  auth server returning 50 entries means 50 full-prompt upstream attempts);
  `max_target_retries` bounds axis 2; `max_dispatches` bounds dispatch rounds in the deferred
  slice.
- Dedupe key is **`target@base@key`**, not `target@base`: two entries differing only by `key`
  (key rotation, a second account on the same model+base) are a legitimate failover pair and
  must not be collapsed. `prev_targets` always carries every already-failed key.
- **Invalid-entry handling**: `target` must be present and non-empty; `base` must be
  **present** and pass `isHostAllowed` (`src/utils/routing.ts:78`); `mode`, if present, must
  map to a known handler mode; `timeout`/`retry_on`, if present, must be well-formed
  (finite positive number / array of finite integers). Any entry failing these checks is
  **dropped** (ERROR log naming the offending field) and the ladder continues with the
  remaining entries — this applies even to `targets[0]` (the ladder then leads with the first
  valid entry). If every entry is invalid, fall back to normal config resolution.
  A **missing `base` is an invalid entry, not an inherit-from-config signal** — that is the
  whole point of the self-contained rule.
- Returned `key` (when non-empty) overrides the `auth_passthrough_with` chain; empty ⇒ keep
  existing key resolution.
- Returned `otac` replaces `modelUsageOneTimeAuthCode` so the retry's `record_server` POST
  stays linked to the right admission.
- **`timeout` rides on `ModelRouteConfig`, not `RouteAttempt`.** The precedent is
  `ModelRouteConfig.maxTokens` (`config-loader.ts:514`): a per-route scalar consumed via
  `ctx.route.maxTokens` inside `runHook('before_upstream')` (`request-transform.ts:667,698`)
  with **zero handler signature changes**. `route` is already threaded to every handler,
  whereas a new `RouteAttempt` field is not — `createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env))`
  appears at ~20 call sites across 9 handler files, none of which receive the attempt.
- **Phase 1 treats `timeout` as a whole-request deadline**, which is what
  `createUpstreamAbortSignal` (`src/utils/fetch-timeout.ts:19`) already does. The
  first-byte-only refinement for SSE is **deferred**: `fetch()` resolves at headers, so
  "first-byte" semantics means clearing the timer on resolve and arming a second one for the
  body read — per-call-site surgery at every SSE site, and not needed for the acceptance
  criterion. `docs/auth-stats-protocol.md:83-85` currently documents `timeout` as
  *first-byte*; Phase 1 must either ship that or correct the doc (see Protocol doc
  amendments) — documenting one and shipping the other is not acceptable.
- **`retry_on`** drives axis 2 only (same-target retry). See The two retry axes. A status
  absent from `retry_on` is *not* an error and *not* "invalid" — it simply means no in-place
  retry, and axis 1 then decides whether to advance.
- Fail loud: every dispatch failure/timeout is logged with the reason; the original upstream
  error is rethrown unchanged.

## Files to change

**Phase 1 — auth targets failover:**

- `src/index.ts` — in `doAuthRequest`, JSON-parse the `200` body into
  `RemoteTargetDescriptor[]` and stash it request-scoped (alongside
  `modelUsageOneTimeAuthCode`, `:968`); add the ladder short-circuit **before**
  compositeAttempts construction (`:1382`) so no config resolution runs for override
  requests; build each rung via `descriptorToRoute` + the existing `buildRouteAttempt`
  (`:1724`); have the ladder apply `recordRequestTiming` / `restorePrivacyResponse` /
  `applyCorsHeaders` itself; set `modelUsageOneTimeAuthCode` per rung; normalize the
  thrown-vs-returned stats asymmetry at `:2298-2308`. Note the deferred-auth constraint: the
  override is only reachable on the `doAuthRequest(modelName, bodyText)` path (`:1275`), since
  the other three call sites (`:1038`, `:1051`, `:1671`) run with no parsed body.
  The composite loop (`:2469`) and single-attempt call (`:2527`) are **left unchanged**.
- `src/utils/target-retry.ts` — new, **pure/injectable only** (the ladder itself stays in
  `index.ts`, since `buildRouteAttempt` is a closure there): descriptor parsing, per-entry
  validation (required `target`/`base`, `isHostAllowed`, known `mode`, well-formed
  `timeout`/`retry_on` — invalid entries dropped, ladder continues), `descriptorToRoute`
  (descriptor → self-contained `ModelRouteConfig`), and `isRetryableOutcome` covering both
  thrown errors and returned `>= 400` Responses. No `callDispatchServer`, no
  `buffer_non_sse` yet.
- `src/utils/config-loader.ts` — add `timeout?: number` to `ModelRouteConfig` (`:507-515`,
  alongside `maxTokens`); `descriptorToRoute` sets it directly on the self-contained route
  (no merge).
- `src/utils/fetch-timeout.ts` — **no change needed in Phase 1.** With `timeout` on
  `ModelRouteConfig`, handlers pass `route.timeout ?? getUpstreamBodyTimeoutMs(env)` into the
  existing `createUpstreamAbortSignal`. The SSE first-byte re-arm is deferred.
- handler upstream fetches (~20 `createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env))`
  call sites across claude.ts, messages.ts, openai.ts, gemini.ts, chat-completions.ts,
  responses.ts, embeddings.ts, models.ts, token-counting.ts) — read the per-route timeout.
  Mechanical one-line change per site, no signature changes.
- `src/utils/routing.ts` — reuse `isHostAllowed` / `getSidecarForwardedHeaders` (no change
  expected unless a shared retryable-error classifier is added).
- `src/utils/config-loader.ts` — **flat `[remote]` migration (breaking)**: rewrite the
  `remote?` type to the flat keys; collapse the TOML section-open (`:2695-2703`) + key/value
  (`:2748-2759`) and JSON (`:3059-3071`) branches to one `'remote'` section; drop the old
  `[remote.authentication]` / `[remote.recording]` subsection headers; flatten the serializer
  (`:2262-2272`) to a single `[remote]` block; add the `remote_dispatch_active` snapshot flag
  (`:3388-3389`).
- `README.md` + `docs/auth-stats-protocol.md` + `docs/configuration-reference.md` — already
  describe the `targets` array; update every `[remote.authentication]` / `[remote.recording]`
  heading to the flat `[remote]` table, align the wording with the implemented precedence, and
  document the flat dispatch keys. See Protocol doc amendments for the content changes.
- **Migration call sites the earlier draft missed** — the flat-`[remote]` switch must also
  update:
  - `proxy_config.toml:6,10` — the repo's own config still uses the old subsections.
  - `tests/unit/auth-with-model.test.ts`, `tests/unit/config-loader.test.ts`,
    `tests/integration/15_config_parse/config_parse.test.js`.
  - consumers: `src/index.ts:965-967`, `:1058`, `:1185-1186`;
    `src/utils/config-loader.ts:2262-2272` (serializer), `:2695-2703` (TOML section-open),
    `:2748-2759` (TOML kv), `:3059-3071` (JSON), `:3388-3389` (snapshot flags);
    `src/utils/model-usage-recorder.ts:14,23` (doc comments); `src/tui.ts:1225-1226`.
- **Fail loud on the old section headers.** The plan's "silently disables auth/recording until
  migrated" is a silent-failure mode and violates repo rule #8. The parser already warns on
  duplicate keys (`config-loader.ts:2735`); add the same treatment — on encountering
  `[remote.authentication]` / `[remote.recording]`, emit a `console.warn` naming the flat
  replacement. Cheap, and turns a silent auth outage into a visible one.
- `CHANGELOG.md` — entry per repo convention, calling out the **breaking** config rename.

## Protocol doc amendments

`docs/auth-stats-protocol.md` was updated recently and is now the operator-facing contract.
Five places it diverges from what Phase 1 would ship — each must be reconciled before
implementation, not after:

1. **`otac` and `retry_on` are not in the descriptor** (`:71-73` lists only
   `target`/`mode`/`base`/`key`/`transforms`/`timeout`). Both must be added. For `otac` the
   doc must also say which wins when the `one_time_auth_code` **response header** (`:65-66`)
   and a per-entry `otac` both appear — the header is currently documented as the single
   per-request admission code, so per-entry OTAC is a genuine extension of the contract.
2. **`base` becomes required, and the merge language must go.** `:76-78` currently says
   override fields are "merged on top of the normal inheritance chain (per-entry → section →
   `[default_upstream]`)". That is unsafe for the driving use case — a model with no
   `[models.*]` entry inherits `http://localhost` and no API key
   (`getDefaultModelRoute`, `config-loader.ts:771-790`). The doc must state that each entry
   is self-contained, that `target` and `base` are required, and that only `mode` falls back
   to `[default_upstream]`. Sidecar authors are currently being told the opposite.
3. **`timeout` is documented as first-byte** (`:83-85`) but Phase 1 ships whole-request.
   Correct the doc, or move the first-byte work into Phase 1.
4. **The trigger set is unspecified.** `:83-85` documents timeout expiry as the *only*
   thing that advances the array; non-2xx and transport failover are absent, as is the
   terminal-status list and the two-axis split. A sidecar author cannot currently predict when
   their `targets` array advances. Document axis 1's fixed set and axis 2's `retry_on`.
5. **Section headings** (`:9`, `:92`, `:101`, `:111`) still use the nested form and need the
   flat `[remote]` rename.

**Deferred (dispatch slices):**

- `src/utils/target-retry.ts` — remaining: `callDispatchServer`, `buffer_non_sse` body
  handling.

## Sidecar visibility (constrains this slice)

Summarized from the two current-behavior questions, because the failover feature depends on
what the auth / record sidecars can actually observe.

**`auth_server` (input side) — allowlist, not passthrough.** `doAuthRequest`
(`src/index.ts:978-994`) forwards only: `Authorization`, `x-api-key`, `x-goog-api-key`,
`user-agent` (each only if the client sent it), plus proxy-generated `request_id`,
`endpoint`, `x-resource-for` (only when `auth_with_model = true`), and the client-IP pair
`x-forwarded-for` / `x-real-ip`. Every other client header (e.g. `anthropic-beta`,
`anthropic-version`, cookies, custom headers) is dropped. The request **body** is forwarded
only when `auth_with_body = true`, as the *post-transformation* parsed JSON (privacy-filter /
kompress / tool-blocklist rewrites already applied) — never the raw bytes. Consequences:

- The override is only usable when auth is **deferred past body parsing** (`auth_with_model`
  or `auth_with_body` true); otherwise auth runs pre-parse (`src/index.ts:1037`) and the
  sidecar cannot key the override to the requested model/body.
- The sidecar sees the request the *proxy* would send upstream (post-rewrite), not the
  client's raw bytes — fine for target selection, but not a byte-exact audit copy.

**`record_server` (output side) — body opt-in, headers never.** `ModelUsageRecordPayload`
(`src/utils/model-usage-recorder.ts:4-59`) carries `request_id`, `timestamp`, `endpoint`,
`user_key`, `model`, `response_status`, the five token counters, and — only when
`record_response_body = true` — `response_body`: the full upstream body (parsed JSON, or the
accumulated decoded SSE text, or the error body for non-2xx). It **never** carries upstream
response *headers* (no `content-type`, `x-ratelimit-*`, `request-id`, `retry-after`), and the
streaming path hardcodes `response_status: 200` (`src/index.ts:2350`). Consequences:

- Failover decisions can only use **status + body**, never response headers — consistent with
  the trigger set above. (The one exception is `Retry-After` for axis 2 backoff, which is read
  off the live `Response` inside the ladder, not via the recorder.)
- Each rung's record POST carries **that rung's `otac`**; the `one_time_auth_code` header is
  the only linkage key, so getting it wrong corrupts the admission↔usage tie
  (`docs/auth-stats-protocol.md:155-162`). Mechanically this is the closure variable
  `modelUsageOneTimeAuthCode` (`src/index.ts:968`), read at `:2306` and `:2396` — the ladder
  sets it per rung rather than once per request.

**A ladder emits one record per rung — by design, not a bug.** `runAttempt` records stats
inline (`src/index.ts:2298-2308`) and POSTs a non-2xx usage record (`:2372-2400`) *before* the
error escapes, so a 3-rung ladder produces 3 records for one logical request. That matches
`docs/auth-stats-protocol.md:110-119` ("Non-2xx responses are recorded too… lets the collector
see failures and their statuses by default"), and `response_status: 0` is reserved for "no
response obtained" (`:144`). All rungs share one `request_id`, so the collector groups on it.
Do **not** suppress failed-rung records. Two real defects remain:

- **Asymmetry**: thrown failures skip `recordModelStat` / `recordModelTiming` (`:2298-2308`)
  entirely, while returned-Response failures run them — the same upstream failure is counted
  differently depending on which handler produced it. Normalize.
- **Cumulative timing**: `recordRequestTiming(path, Date.now() - requestStartTime)` measures
  from the *request* start, so a rescued request reports the whole ladder's latency as if it
  were one upstream call.

## Gotchas / constraints

- **Streaming safety**: this is the core constraint — mid-stream SSE retry is impossible
  without fully buffering, which defeats streaming. Hence SSE is excluded; only non-SSE
  bodies can opt into buffered retry.
- **Non-idempotency / double-billing**: a retry re-sends the prompt; upstream may have
  already executed/billed before erroring. `max_dispatches` and the trigger set are the
  only mitigation — document that retry is best-effort, not exactly-once.
- **Doc/code conflict to resolve**: `docs/auth-stats-protocol.md:63-86` and
  `README.md:60-79` document the auth response body carrying `target`/`mode`/`base`/`key`,
  but the code never parses it (commit `6a2038a` added docs + header forwarding only).
  Parse it with the **same** response-body→route resolution used here, or remove the claim.
- **OTAC threading**: each rung must record with **its own** entry's `otac`, not the failed
  target's, or the admission↔usage linkage corrupts (`docs/auth-stats-protocol.md:155-162`).
  This is the closure variable `modelUsageOneTimeAuthCode` (`src/index.ts:968`) set per rung.
- **Loop cost**: the ladder adds latency only on the failure path; `max_targets` ×
  `max_target_retries` bounds the worst case, and each entry's `timeout` bounds a hung target.

## Testing

- Unit (`src/utils/target-retry.ts`, injected fetch): non-2xx → next entry → retry succeeds;
  transport error → retry; timeout pre-first-byte → retry; SSE mid-stream → no retry;
  non-SSE body error with `buffer_non_sse` on/off; `204`/`{}`/timeout/network ⇒ original
  error rethrown; dedupe on `target@base@key` stops a repeated entry from looping; a
  disallowed `base` drops **that entry only** (the ladder continues with the next valid one,
  and if every entry is invalid it falls back to normal config resolution); invalid entry
  (bad `mode`/`target`/`timeout`/`retry_on`) is dropped and the ladder continues, including
  when `targets[0]` is the invalid one — and `max_targets` caps **attempts**, so
  `[invalid, invalid, A, B, C]` with cap 4 still attempts `A`/`B`/`C`; `key`/`otac`
  precedence; descriptor `timeout` overrides the env default for that attempt (assert the
  abort deadline used, and that absent `timeout` keeps `UPSTREAM_BODY_TIMEOUT_MS`).
- **No-`[models.*]` entry (the driving case — must be a first-class test, not an edge case)**:
  a request whose model id has no alias config anywhere (neither `[models.*]` nor
  `[composite]`) is routed **purely** from the descriptor. Assert the upstream URL is the
  descriptor's `base` (never `http://localhost`, the `getDefaultModelRoute` fallback) and the
  API key comes from the descriptor's `key` (absent ⇒ client-key passthrough).

- **Two-axis matrix** (the point of this design — test the axes independently):
  - axis 1 advance: `429`/`5xx`/transport/timeout advance to the next entry.
  - axis 1 terminal: `400`/`401`/`403`/`404`/`413`/`422` **stop** the ladder — assert the
    later entries were never fetched, and that the client sees the original status.
  - axis 2 hit: status in `retry_on` re-hits the *same* target (assert same URL twice) before
    advancing.
  - axis 2 miss: status not in `retry_on` advances immediately (assert the target was fetched
    exactly once).
  - `max_target_retries = 0` disables axis 2 entirely.
- **Returned-Response failures** (the `chat-completions.ts` / `embeddings.ts` shape): a
  handler returning `new Response(body, {status: 503})` must fail over exactly like a thrown
  `ClaudeProxyError`, and its verbatim error body must survive to the client when the ladder
  is exhausted.
- **Body reuse across rungs**: a 3-rung ladder must send the *same* prompt and the *correct*
  per-rung model id upstream — the regression guard for the single-use `Request` body.
- **Bounds**: an array longer than `max_targets` is truncated, not walked.
- **Recording**: an N-rung ladder emits N records sharing one `request_id`, each with its own
  `response_status` and that rung's `otac`; thrown and returned failures record identically.
- Integration: an auth `targets: [A, B]` response whose `A` fails → the ladder rescues on `B`
  → composite share decay does **not** run for the rescued attempt (the ladder never entered
  the composite loop). A second integration covers the no-alias case end-to-end: no
  `[models.*]` entry, `targets: [A, B]`, `A` fails, `B` succeeds, client sees `B`'s body.
- Assert meaningful properties (returned target/url/key, rethrown error identity), not just
  "does not throw".

## Out of scope

- Retrying after client disconnect or mid-SSE-stream.
- Dispatch-driven *initial* routing (that is the auth-override feature).
- Any change to `[composite]`/`[schedule]` semantics.
