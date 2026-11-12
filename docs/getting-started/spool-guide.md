# SSD Spool (opt-in)

The `[spool]` section moves large request and response bodies — and individual
SSE events — out of RAM and onto disk, streaming them instead of holding them
whole. This is what makes a slow peer stop costing resident memory: a client
uploading a large image, an upstream reading it, and a client reading the
answer each hold bounded stream buffers rather than a full copy of the body.

The design is
[`docs/architecture/plan-ssd-spool-image-request-bodies.md`](../architecture/plan-ssd-spool-image-request-bodies.md).
Split out of the [README Configuration Reference](../../README.md#configuration-reference).

**Opt-in and off by default.** Leaving the section out, or `enabled = false`,
writes nothing and creates no directory. Spooled state is scratch space for the
current process only: a restart aborts every in-flight exchange, and old spills
are deleted, never resumed or replayed.

## Configuration

```toml
[spool]
enabled = true
dir = "~/.cache/model-proxy/spool"
```

| Field | Default | Purpose |
|---|---|---|
| `enabled` | `false` | Master switch. Off means nothing is spooled and no directory is created. |
| `dir` | `~/.cache/model-proxy/spool` | Root for the spill directories (`responses/`, `events/`, `blobs/`). |
| `threshold_bytes` | `1048576` (1 MiB) | A body or SSE event at or below this stays in RAM; above it, it spills. |
| `max_request_bytes` | `10485760` (10 MiB) | Cap on one request body, enforced by a byte counter for every encoding. |
| `max_response_bytes` | `67108864` (64 MiB) | Cap on one response body, and on one SSE event. Exceeding it is a 500 (or a mid-stream SSE error), never a truncated body. |
| `max_total_bytes` | `2147483648` (2 GiB) | Budget for live spill files. Exceeding it is a 503, never a truncated body. |
| `max_blob_cache_bytes` | `67108864` (64 MiB) | L1 byte cap for the blob cache (see [Blob cache and the ref layer](#blob-cache-and-the-ref-layer)). |
| `max_blob_disk_bytes` | `268435456` (256 MiB) | L2 byte cap for the blob file tree. |
| `ttl_seconds` | `600` | How long an unreferenced blob may sit idle before it is treated as expired. A leased blob never expires; an expired read throws instead of serving stale bytes. |
| `max_materialized_body_bytes` | `0` (off) | §5.9 RAM admission budget. See [Admission budget](#admission-budget-59). |
| `materialization_factor` | `2.0` | Multiplier behind the §5.9 nominal charge. |
| `max_admission_queue` | `64` | Most bodies queued behind the §5.9 budget at once. |
| `admission_timeout_ms` | `30000` | Longest a body waits in that queue. |
| `external_upload_url` | — | §5.8 external upload endpoint. See [External upload](#external-upload-58). |
| `external_upload_token` | — | Optional bearer token for that endpoint. |
| `external_upload_timeout_ms` | `30000` | Bound on one blob upload. |
| `external_url_min_lifetime_s` | `900` | Lifetime floor for the signed URL the uploader gets back (minimum accepted: 60). |

## Request bodies

With `enabled = true`, a request body past `threshold_bytes` is streamed to
`dir` instead of being held in RAM while a slow client uploads it, and the
socket is backpressured until the spool has taken the bytes. An unknown-length
(chunked) body spills once it crosses the same threshold.

`/passthrough` egress is the same shape in reverse: the client's raw bytes are
streamed upstream with an exact `Content-Length` instead of a re-sent
materialized string, keeping only `model` and `stream_options.include_usage`
from the parsed body. That holds whether or not the section is enabled — it
reuses the request body the proxy already holds, so it costs no extra disk
read.

### Blob cache and the ref layer

§5.4's **RAM + SSD two-level blob cache** (`src/utils/blob-store.ts`)
content-addresses a shared base64 payload by the sha256 of its base64 text,
keeps a byte-capped LRU in RAM (`max_blob_cache_bytes`) over a
`blobs/<aa>/<bb>/<sha256>` file tree (`max_blob_disk_bytes`, written
temp-then-rename), and never rebuilds its index from disk — so a file left by
an earlier run can never become a cache hit. A disk budget that cannot be met
without dropping a blob that is still in use is a 503, never a deleted live
blob or an over-budget write.

The §5.4/§9.3 **ref layer** (`src/utils/blob-refs.ts`) is the counterpart that
moves an allowlisted inline payload into one of those blobs and restores the
field's original bytes on the way out. The allowlist is the explicit,
schema-qualified positions: Claude base64 image/document sources, Chat
image/audio/file parts, Gemini `inline_data`, and Responses image/file/inline-skill
parts. An attempt body is copied from an extracted one with `structuredClone`
plus one `retain()` per ref, so the copy shares each blob's lease and releases
it exactly once.

### What the refs travel as (shapes 2 and 3)

The `/v1/messages`-family request path uses that extraction: the payloads leave
the parsed body before privacy, kompress and the tool judge run, the refs then
cross the send boundary and routing as plain JSON (shape 2, §5.3), and the
handler that dispatches the request expands them back to the client's exact
bytes as its first act after parsing — before conversion, validation and the
`before_upstream` hook — with their leases given back when the request ends.

Four egress paths have graduated past that (shape 3): the native `/v1/messages`
send, the native `/v1/chat/completions` send, the `/v1/responses` passthrough
(this handler's default branch, for the native Responses mode and its alias),
and the two converted sends in the `/v1/messages` handler when it targets an
OpenAI upstream (an OpenAI Completions one and an OpenAI Responses one — the
converter carries each ref through re-prefixed, as the data URL the converted
position expects). They keep the refs and stream the body out of the blob
store, one chunk at a time, with a `Content-Length` measured from the skeleton
plus each ref's size and `duplex: 'half'`, so the expanded body never exists on
those paths.

Every other send still expands:

- the `/v1/messages` handler's already-OpenAI branch, whose refs sit in
  positions the token counter refuses to guess at;
- the `/v1/chat/completions` handler's three converting modes, whose converters
  read the payload as a string;
- the `/v1/responses` handler's four converting modes, which read it the same
  way.

### Pre-dispatch consumers

A route's `request_ingress` transforms run before dispatch, so they see a small
`$spoolBlob` object where an allowlisted payload was.

The auth server is the one pre-dispatch consumer that needs the bytes: with no
uploader configured it is handed an expanded copy of the body, and with one it
gets [§5.8's link projection](#external-upload-58).

Neither converted SSE path keeps the request body alive for the client's read
either: the input-token estimate is resolved from the effective body before the
response stream is created, so the stream's transformer and pump carry a number
rather than the body.

### Readers on the request path

A route's `request_ingress` transforms read the attempt body through the
request-side spool rather than a `Request.clone()`. A clone tees the body, so
the branch nobody reads stays resident for as long as the read runs, which is
the second full copy of an image-bearing body §5.7 exists to avoid. The
original is consumed in place — the same block rebuilds the request from the
transformed body, so nothing reads it again — `max_request_bytes` bounds the
read, and no declared length is passed, so it is the spool's own byte count
that is capped rather than a `Content-Length` left over from an earlier body.
Above `threshold_bytes` the read is a *second* spill of a body the ingress
already spilled, so it costs disk churn instead of RAM and a tight
`max_total_bytes` can refuse a request the clone path served. §5.9 is not
charged twice: the request's own ingress lease already covers this
materialization of the same bytes.

The `LOG_LEVEL === 'debug'` routing dump is the other place `src/index.ts` read
the attempt body through `Request.clone()`. It receives the body through the
same request-side spool and hands the request back a stream over that spill,
because unlike the hook it cannot consume the body — the handler sends it
immediately after. So the dump logs what is sent (with spooling on, the
`$spoolBlob` ref rather than the base64, since the ladder has already replaced
the payload), and a receive that fails is answered as the request's error
instead of being forwarded as an empty body.

Two handler entry points that can be routed to an `sdk://` target, `claude.ts`
and `messages.ts`, used to clone the request on that route alone "to preserve
body for SDK handler". A clone tees the body, so the unread branch stayed
resident for the length of the parse — a second full copy of a body that may
carry an image — and nothing ever read it: every `sdk://` branch is handed the
*parsed* object and the SDK handlers behind them are stubs that raise 501. The
two routes now take the same one `await request.json()`, consumed in place
exactly as the non-SDK branch of that ternary always did. The failover ladder
rebuilds a fresh `Request` per rung, so an exhausted body cannot reach another
attempt.

## Response bodies

A non-SSE response body is spooled the same way once it crosses
`threshold_bytes`: the upstream body lands in `responses/` and the client is
sent a stream over that spill, re-read a chunk at a time and freed once the
client has taken every byte, aborted, or the read failed. `max_response_bytes`
caps one response body and exceeding it is a 500, never a truncated body.

### Spooled readers

Each of these receives a bounded body instead of calling `response.text()` or
`response.json()`:

- the `/passthrough` path;
- the `/v1/responses` passthrough;
- the `/v1/messages` handler's three non-streaming readers — the two
  OpenAI-Format/Responses-format conversions and the upstream
  `openai-completions` path, which now receive before they parse;
- the native `anthropic-messages` egress beside them, where the upstream bytes
  are the client's bytes, so the body is relayed from its spill and read again
  only when tracing is on;
- the `/v1/chat/completions` handler's three converted non-streaming readers (the
  `anthropic-messages`, `gemini-generatecontent` and `openai-responses`
  upstreams), each converted after one bounded receive;
- the three cross-mode readers `openai.ts` answers a Gemini-shaped client with
  (`/v1/interactions` and `:generateContent`, from an `anthropic-messages`,
  `openai-responses` or `openai-completions` upstream), converted after one
  bounded receive;
- the `/v1/responses` handler's four converted readers (both
  `openai-completions` and the `anthropic-messages` upstream on
  `POST /v1/responses`, and the converting branches of
  `POST /v1/responses/input_tokens` and `POST /v1/responses/compact`),
  converted after one bounded receive — and the passthrough halves of those
  same two routes, which never parse the body and so relay it unparsed from its
  spill, read again only when tracing is on;
- the native Gemini `:generateContent` egress — the one whose response carries
  the model's `inlineData` image/audio parts, relayed unparsed — the
  `:generateContent` branch that answers a `/v1/messages` client (converted
  after one parse), and the `:countTokens` branch beside it (relayed unparsed);
- the `/v1/embeddings`, `/decision` and `/v1/messages/count_tokens` success
  reads, which parse a bounded receive (`/decision` keeps the text, because its
  answer is the upstream body verbatim);
- a route's `after_upstream` transforms, which receive the body they transform,
  so the ops run on a bounded body and the handler's own receive no longer
  re-bounds an already-materialized copy;
- a route's `response_egress` transforms — the client-egress hook
  `applyWriteoutBody` in `request-transform.ts`, bounded the same way and with
  the same limited scope: the hook still returns a non-JSON body
  (`text/event-stream` among them) as the very `Response` it was handed,
  unread, so only a JSON answer is received. Its ops therefore run on a bounded
  body, and the client-egress read is usually a *second* receive of a body the
  attempt's stats extraction already spooled, which above `threshold_bytes`
  costs a second spill and buys no RAM relief;
- the three model-listing readers in `models.ts` (the model count behind
  `GET /v1/models`' 404 check, the listing itself, and the Anthropic
  model-discovery reader). A §5.7 cap, a spill failure or a §5.9 refusal
  surfaces as itself while a malformed body keeps that reader's own pre-existing
  answer — the count reader still answers a count of 0 and its caller its usual
  404, logged at error level but indistinguishable to the client from an empty
  upstream.

### Upstream error bodies

The `!response.ok` branches are bounded too, so `max_response_bytes` covers an
error answer and a cap breach or a §5.9 refusal surfaces as itself instead of
as the upstream's error. Where the branch already relays the upstream's answer,
the status, type, message and raw body still reach the client unchanged.

- `/v1/embeddings`, `/decision`, `/passthrough` and the two `models.ts` readers
  above;
- every `/v1/responses` branch (`POST /v1/responses`, `/input_tokens` and
  `/compact`, converted and passthrough alike), where a cap breach or a refusal
  reaches the client as its own error (`processing_error` / `over_limit_error`)
  rather than as the upstream's status;
- `/v1/messages`' four (either client format against an `openai-responses` or
  `openai-completions` upstream);
- `openai.ts`'s three (the two cross-mode forwards, to an `anthropic-messages`
  and to an `openai-responses` upstream, and the plain `openai-completions`
  egress);
- `gemini.ts`'s three (`:countTokens`, `/v1/interactions` and the native
  `:generateContent`);
- `claude.ts`'s single one (the native `anthropic-messages` egress), where the
  branch's placeholder for an unreadable body now applies only to a `TypeError`,
  so a cap breach or a refusal reaches the client as itself instead of as the
  upstream's error;
- `/v1/chat/completions`' two converted ones (`anthropic-messages` and
  `gemini-generatecontent`), where the relayed status and bytes are unchanged
  while a cap breach or a refusal propagates as itself.

### Internal readers

- The fusion pipeline's three response reads in `src/index.ts` (each panel
  answer, the judge's analysis and the synthesis body the metadata wrap
  re-reads) no longer call `resp.clone().json()`: they receive once, so an
  image panel's base64 payload is never held twice, a cap breach or a §5.9
  refusal on a panel or judge answer fails the request instead of being read as
  "this model did not answer", and the synthesis body reaches the client byte
  for byte either as the rebuilt metadata answer or streamed back out of its
  spill.
- `src/index.ts`'s non-2xx remote-stats error body (the read behind a failed
  attempt's zero-usage record for `[remote] record_server`) uses the same
  bounded receive in place of `clone().json()`/`clone().text()`. The failure's
  status, headers and bytes still reach the client unchanged, and a cap breach,
  a spill failure or a refusal propagates as itself with no record posted for a
  body the proxy refused to read.
- The remote auth server's own pre-dispatch body in `src/index.ts`'s
  `doAuthRequest` is bounded like the rest but received *without* a trace stage
  on purpose, because that answer can carry `targets[].key`/`otac` while the
  other readers' `withResponseText` echoes the text it takes. Its cap breach,
  spill failure or §5.9 refusal is reported as itself (500 `processing_error` /
  503 `over_limit_error`) instead of as the auth server being unreachable. The
  two no-traces readers share one primitive, `consumeResponseText`, which is
  `withResponseText` without the trace stage.
- The privacy filter's sidecar answer (`POST ${PRIVACY_FILTER_URL}/redact`) goes
  through that same receive because the body it returns is the redacted *prompt
  text*: as large as the request the filter accepted (`max_chars`, 1 024 000 by
  default), so `max_response_bytes` bounds it, above `threshold_bytes` it is
  received onto a spill the parse then reads back, and a cap breach or a §5.9
  refusal reaches the client as itself rather than as "privacy filter
  unavailable". The request still fails closed — no path returns unredacted
  text.
- The kompress sidecar's answer (`POST ${KOMPRESS_URL}/compress`) is received
  through that same no-trace-stage primitive because the answer is compressed
  *prompt* text: `max_response_bytes` bounds it, a spill holds it above
  `threshold_bytes`, and a cap breach or a §5.9 refusal is reported as the
  proxy's own limit rather than as a broken sidecar, while the request still
  fails open by default and forwards the original text. This fail-open is no
  longer fail-silent: unreadable, failing or refused fragments and a batch
  suppressed by `max_chars` are tallied by reason in the compress result and
  logged by the caller (short reasons only, never fragment text).
- The tool judge sidecar's answers (`/judge` and the Clef `/decision` API,
  `src/utils/tool-judge-sidecar.ts`) were the last unbounded request-path read
  in `src/`: both are received through that same primitive, so
  `max_response_bytes` bounds an answer derived from the tools and the user's
  prompt, a spill holds it above `threshold_bytes`, and a cap breach, spill
  failure or §5.9 refusal is named a proxy limit instead of sending a health
  check after a healthy sidecar. The judge still fails open, so the answer is
  discarded and every tool is accounted unjudged, never erased from a read that
  could not finish.

### Structural reads

- On the remote target-retry ladder, the bodies of the responses it *abandons*:
  a re-hit rung (axis 2) or a superseded one (axis 1) has its body cancelled at
  the drop point instead of being left to hold a spill and its reservation
  until the next startup sweep.
- In the attempt loop's JSON usage/tool stats read: one pass over the spooled
  body instead of a `response.clone()` that keeps every remaining byte alive
  for as long as it parses, and the client is sent a stream over the same spill.

## SSE events

**SSE events are framed one at a time** on both streaming egresses — the
attempt loop and the `/passthrough` SSE branch — when `enabled = true`: each
event is relayed as it arrives, boundaries and order preserved and the whole
stream never accumulated, and only an event past `threshold_bytes` spills (to
`events/`), its spill deleted once the client has taken its last byte or
disconnected. An event past `max_response_bytes` fails the stream and reports
the error to the client mid-stream, never a silently truncated response or a
terminal `[DONE]`, and the client's own reads are what drive the upstream
reads, so a slow client pauses the stream instead of growing a RAM queue. With
`enabled = false` there is no framing at all and the relay is the upstream
bytes untouched.

## Admission budget (§5.9)

§5.9's opt-in RAM budget is `max_materialized_body_bytes` (default `0`, off): a
request body or a non-SSE response body whose
`ceil(bytes × materialization_factor)` (factor `2.0`) nominal charge does not
fit the process-wide budget is refused with 503 `over_limit_error`, after
queueing behind at most `max_admission_queue` (64) bodies for at most
`admission_timeout_ms` (30000). It is independent of `enabled`, since a body
the spool never touches is materialized in RAM too.

## External upload (§5.8)

This is live for `auth_with_body`. `external_upload_url` names the HTTPS
endpoint that receives each spooled blob — one `PUT` per distinct blob, the
stored base64 text as the body with an exact `Content-Length`,
`X-Blob-Sha256` and `X-Blob-Size` — and answers with a short-lived signed
download URL plus the stored `sha256`, `size` and `expires_in`, all of which
the uploader checks before the URL is used: HTTPS, no embedded credentials,
matching hash and length, a lifetime at or above the floor.

An optional bearer `external_upload_token` authenticates it,
`external_upload_timeout_ms` bounds one blob, and `external_url_min_lifetime_s`
is the lifetime floor — a floor of 60 seconds, in place of an auth timeout the
proxy has none of. The endpoint must be HTTPS and must not embed credentials,
and configuring a token, timeout or lifetime without a URL — or any of the keys
with `enabled = false`, since a disabled spool produces no blobs to project —
is a startup error. Signed URLs, the token and the endpoint are redacted from
every error and log line.

With `auth_with_body` set, the auth server receives the request with each
extracted inline payload replaced by an `external_blob` object (`url`,
`sha256`, `size`, `media_type`, `encoding: "base64"`) at that field's own path
— text and tools as the upstream will see them — while the upstream request
still streams the original inline bytes from the local blobs.

The proxy **never deletes** an uploaded object: it uploads and forgets, and the
store's own bucket lifecycle rule is what expires them (a decision taken with
the user, and a divergence from the plan's best-effort delete). A blob that
cannot be read, a failed upload or a receipt that disagrees with what was sent
**fails the request explicitly** — 500 `processing_error`, no auth call, no
upstream call — rather than sending an empty binary field or a broken link.
With no uploader configured the auth server gets the whole body inline, exactly
as before.

## Disk lifecycle

Spill files left by a crashed run are deleted at startup once they are over an
hour old (newer ones may belong to a worker starting alongside this one), as
are stale blob files found under the same rule, and anything the sweep declines
to remove — a subdirectory, a symlink, an unlink failure — is reported with its
reason in the startup log.
