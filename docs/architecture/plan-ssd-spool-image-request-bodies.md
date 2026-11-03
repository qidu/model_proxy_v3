# Plan: SSD spool for large JSON request and response bodies

Status: **Draft** — design only, nothing implemented
Date: 2026-11-03
Scope: Reduce resident memory for slow, in-flight exchanges with large JSON
bodies — especially documented inline base64 images, audio, video, documents,
files, and skill bundles — by spooling requests, finite JSON responses, and
individual SSE events to disk and streaming them at egress. The goal is that
"in flight" stops implying "the full body/event is in memory" for every slow
leg. Touches the Node HTTP adapter (`src/server.ts`), the routing ladder's body
handling (`src/index.ts`), upstream `fetch` call sites, and response/SSE
converters.

**Scope boundary:** ingress spooling is content-agnostic. Ref-based extraction
covers the explicit, schema-qualified inline-binary positions in §9.3 and the
response positions in §5.7, including non-image binary payloads. Large text
and unknown/base64-looking fields outside those allowlists still get the
slow-upload/download benefit, but their parsed and serialized forms remain
O(body/event size). No generic long-string or base64 detection is allowed.

**Storage lifetime:** all disk state is scratch space for the current proxy
process, not a persistent request or response store. A process/system restart
aborts every in-flight upload, upstream send, and downstream response. Old
request/response/event spills and blob entries are never read, resumed,
replayed, or reused after restart; they are only deleted by safe stale-file
cleanup. There is no WAL, manifest, recovery log, or resumable protocol.

**Decisions recorded 2026-11-02 (§9):** spooling is **opt-in, off by default**
(9.1); the Phase 3 lexical scanner is **deferred pending Phase 2 measurements**
(9.2); refs are **restricted to explicit inline-binary positions** (9.3);
Phase 0 does **not** ship ahead of Phases 1–2 — all memory work lands as one
reviewable change; response spooling is **per JSON body or SSE event, with
backpressure, never whole-stream accumulation** (9.5).

Accepted consequence: the current multi-copy peak (§2) stays in production
until that single change lands.

Related: [Proxy Implementation](./proxy_impementation.md),
[Passthrough Mode](./design_passthrough_mode.md),
[Request Transform Hooks](./design_request_transform_hooks.md),
[Sidecar Status](./status_of_sidecars_of_proxy.md) (the `image_encode` sidecar
that already produces these base64 blobs, `src/utils/image-fetch.ts`),
[Dashboard/TUI/Agent Overhead](./dashboard_tui_agent_routing_overhead.md)
(the existing "what sits in the hot path" analysis).

---

## 1. The claim

The problem is not just the allocation peak. It is **live request/response
body state kept reachable while someone else is slow** — the client uploading,
the upstream reading the request, or the client reading a response/SSE stream.
Spooling and ref-based streaming are worth doing because they sever those
links for supported paths: after extraction, resident memory depends on bounded
stream buffers and small per-exchange metadata rather than on minutes of peer
latency. Full parse and non-ref processing are unthrottled by default, with
optional byte admission in §5.9.

Four consequences worth stating up front:

1. **The offload is not circular.** On many Linux systems `/tmp` is tmpfs.
   Spool to `os.tmpdir()` and the "offload" can silently stay in RAM. §5.6.
2. **Spooling cannot eliminate the full-parse transient.** `JSON.parse` and
   the current converters still need O(body/event size) live state per exchange,
   with no default proxy semaphore bounding materialization. Optional §5.9
   admission adds a nominal byte budget; L1/L2 sizing alone does not. §4.
3. **SSE has two different memory problems.** Some response converters retain
   the parsed request for token counting after `fetch` returns headers, and
   response queues/events can buffer output when the downstream client is
   slow. Request-body offload alone fixes neither; §5.3 and §5.7 address them
   separately.
4. **"Spill" and "cache" describe different objects.** Request, response, and
   per-event spills are temporary and deleted after their last reader. The
   request blob store behind the refs (§5.4) is a genuine two-tier RAM + SSD
   cache with cross-request hits; response blobs are per-response scratch by
   default. The cache's L1 bytes count against the process memory budget.

---

## 2. Where the bytes are today

Measured by reading the code paths, not profiled. `B` = request-body size on
the wire. A 5 MiB binary image becomes about 6.7 MiB of base64 before the
surrounding JSON. JavaScript string representation, V8 copies, external
buffers, and object overhead vary, so `B` is an order-of-memory unit, not an
exact heap multiplier.

| # | Site | Live state and lifetime |
|---|---|---|
| 1 | `src/server.ts:79-87` — inbound `req` wrapped in a `ReadableStream` whose `data` handler enqueues unconditionally | With no consumer backpressure, queued upload chunks can grow toward **O(B)**. |
| 2 | `src/index.ts:1178-1212` — the existing 10 MiB request cap reads all chunks, allocates a combined `Uint8Array`, and rebuilds the `Request` | The cap exists, but its implementation buffers the body. Chunks, the combined buffer, and request representations can coexist during ingestion; the rebuilt body remains available for later reads. |
| 3 | `src/index.ts:1372-1377` — `await request.text()` then `JSON.parse(bodyText)` | Text plus parsed value are **O(B)** during parse; the parsed value remains reachable as `routeBody` for routing and retries. |
| 4 | Handler reads such as `src/handlers/chat-completions.ts:38-43` and `src/handlers/responses.ts:76` | The rebuilt request is read and parsed again. Handler text/objects can coexist with `routeBody` and converted objects. |
| 5 | `src/index.ts:2240-2260` — `clone().text()`, parse, and `JSON.stringify` for a transformed ladder rung | Another **O(B)** transient per transformed rung. Replacing this with a shared mutable object would be wrong unless rung isolation is intentionally changed. |
| 6 | Upstream handler conversions and `body: JSON.stringify(...)` at `fetch` call sites | Original objects, converted objects, and the serialized string can coexist. The serialized body is retained for the upstream send. |
| 7 | `src/utils/logger.ts:82` — object bodies are stringified before `logger.trace` gates on level | Another full string for object bodies, transient at each pipeline stage, even when trace logging is disabled. |
| 8 | undici encoding/buffering the string body for the socket | Additional **O(B)** send-side state is possible; the exact copy count needs a heap/allocation profile. |

The safe conclusion is **O(B) per live request with multiple transient or
retained representations**, not the previous draft's unprofiled "2B steady /
4B peak". Long duration, not just copy count, turns this into high RSS.

The caps that exist are not a memory bound across requests:

- `src/index.ts:1183` caps the total request at 10 MiB, using the buffering
  implementation above. Any example or test above that size is rejected today
  unless the limit is made configurable first.
- `src/utils/validation.ts:9` limits one Claude image block to 10 MiB, and
  `src/utils/image-fetch.ts` caps one fetched image at 20 MiB.
- Nothing caps image count, concurrent large parses, total live body bytes, or
  total queued SSE response bytes. `src/server.ts` does not inspect
  `Content-Length`; `src/index.ts` does, and also counts streamed bytes.

`src/handlers/passthrough.ts` is a special case: it parses at `:159` for the
schema gate and forwards the original `bodyText` at `:222`. The schema gate
needs the parsed object, but after that gate and model/usage-field extraction,
the SSE path needs only scalar metadata — not the whole parsed object.

---

## 3. Three windows, one variable

The reported symptom is "slow requests". There are three distinct request-body
retention windows, plus a separate response-buffering issue.

### 3.1 Slow upload

The client dribbles a large body over 60 s. Today the adapter, the 10 MiB cap,
and `request.text()` buffer it for that period. The current cap limits one
request's size but not the sum across concurrent uploads.

### 3.2 Slow upstream request send

The upstream accepts a connection but reads the JSON body slowly. The
`JSON.stringify` result and related request objects can stay live until the
send completes. `fetch` resolving to a `Response` normally ends the send-side
need for those bytes, but it does not release objects captured elsewhere.

### 3.3 Long-lived SSE response

`stream: true` does not make the inbound JSON smaller or streamed; it makes the
**response** long-lived. On some converted paths, the full parsed request stays
reachable for that whole response:

- `src/handlers/messages.ts:848` passes `requestBody` to
  `createStreamTransformer`. The returned transform closure retains it, and
  `src/converters/streaming.ts:78-87` uses it to count input tokens on the
  first transformed chunk.
- `src/handlers/messages.ts:944-977` similarly lets the Responses-to-Claude
  pump use `requestBody` for input token counting.

A several-minute thinking or generation stream can therefore pin base64 data
long after the upstream request body was sent. This is endpoint-specific, not
an unavoidable property of SSE: a passthrough path that extracts only model,
usage flags, and other scalars can let its parsed request become collectible
when the handler returns.

**Design requirement:** Phase 2 is incomplete if it streams egress bytes but
leaves the original request body in an SSE closure. Compute token counts and
other request-derived metadata before constructing the response stream, pass
only those scalars/refs into it, and verify reachability per endpoint.

### 3.4 SSE response bytes are not automatically bounded

Chunking a response is not the same as applying backpressure. Current examples
include `response.body.tee()` branches, unconditional `enqueue` in
`src/utils/sse-keepalive.ts:55-62`, and `src/server.ts:133-148` ignoring the
return value of `passthrough.write(chunk)` without waiting for drain. A slow
downstream client can therefore accumulate response data independently of the
request-body copies discussed above.

Response binary spooling and the required backpressure changes are in scope
(§5.7), but chunking alone is not a memory bound. Memory reports should
separate:

- request-body representations and spills;
- non-SSE response spills and per-SSE-event spills;
- the bounded L1 request blob cache versus per-response scratch blobs;
- unfull-parse transients and large non-ref objects;
- response queues and converter state, which must be bounded by downstream
  backpressure rather than allowed to grow behind disk writes.

---

## 4. What SSD offload can and cannot do

Cannot: avoid a transient full parse under the current converter architecture.
`fs.readFile`/`readSpoolText`, UTF-8 decoding, and `JSON.parse` still require
O(B) live state per body/event. Large fields outside the §9.3 and §5.7
allowlists also remain O(B) through non-ref processing. With §5.9 admission
disabled, both can scale as O(N×B) across N exchanges.

Can: keep slow I/O from pinning those full bodies after disk-backed state has
been produced:

- during a slow upload: bounded per-request buffers plus metadata; disk holds
  the spilled remainder;
- during full parse/materialization: O(B) per exchange, with no default proxy
  cap; optional §5.9 admission reserves nominal bytes before parsing;
- between parse and egress: small refs/metadata after supported inline binary
  payloads are detached; arbitrary non-ref bodies are instead written to
  effective/attempt spills before their full objects are released;
- during a slow upstream request send: bounded chunks for identity forwarding,
  streamed-ref egress, and non-ref attempt-spool egress; rehydrated string
  egress remains O(B) and is transitional;
- during a slow downstream response: bounded chunks plus finite response/event
  spills. SSE is processed one event at a time, never accumulated as a whole
  stream, and downstream backpressure pauses upstream reads (§5.7);
- during a long SSE response: no full request body on paths that explicitly
  replace it with scalar usage metadata, refs, or previously written spills.

There is no "~0 resident" claim. Stream buffers, non-allowlisted fields,
small JSON structure, refs, the L1 cache, V8 heap overhead, external buffers,
and bounded response queues remain. Full-parse concurrency and non-ref
processing must be measured under real traffic; larger L1/L2 caches support
blob retention but do not bound those allocations without optional §5.9
admission.

> **Note:** whole-request admission control is not introduced (§8). Optional
> §5.9 byte admission applies only to materialization and is released before
> upstream/client streaming or a long-lived SSE response. Operators needing a
> hard connection limit must apply separate connection admission.

---

## 5. Design

### 5.0 End-to-end request/response flow

**What is stored on disk**

| Data written to disk | Contents | Purpose |
|---|---|---|
| **Raw request spool** | The whole original JSON request body above `threshold_bytes`, including text and inline base64 | Backpressured upload, initial parsing, and identity passthrough |
| **Effective spool** | The whole post-mutation JSON body only when it remains large and has not been reduced to refs | Preserve privacy/kompress/tool-erase changes across retries and rungs |
| **Non-ref attempt spool** | One rung's whole converted/transformed JSON body after `JSON.stringify` | Release full objects before a slow upstream send |
| **Request blob store** | Only allowlisted binary payload fields, stored as their original base64 text | Avoid retaining binary in RAM during conversion, retries, and slow upstream sends |
| **Non-SSE response spool** | A whole large JSON response body | Avoid buffering a large upstream response in RAM |
| **SSE event spool** | One complete large SSE event, including its JSON framing | Process a large event without accumulating the entire SSE stream |
| **Response/event blobs** | Binary payloads extracted from responses/events | Stream binary to a slow client with backpressure |

For the main converted request path containing binary:

```text
Whole raw JSON request → raw spool
                       → parse and mutate
                       → extract binary parts to blob store
                       → effective small JSON skeleton + BlobRefs in RAM
                       → stream skeleton + binary blob chunks upstream
```

An additional whole-body **effective spool is not needed** once extraction has
reduced the effective body to a small skeleton. It is used only for large
bodies that still contain non-ref data.

Additional boundaries:

- Small bodies remain in bounded RAM.
- BlobRefs, leases, and the L2 index are metadata in RAM; binary payloads are
  not stored in the index.
- Response blobs are deleted after delivery rather than entering the request
  cache.
- Everything on local disk is process-lifetime scratch; nothing is resumed or
  reconstructed after restart.
- `max_total_bytes` caps request/response/event spills; `max_blob_disk_bytes`
  separately caps the L2 request-blob cache.

Both diagrams describe the same stages. The flowchart emphasizes storage and
branching; the sequence diagram emphasizes client/proxy/upstream interactions.

**Flowchart view**

```mermaid
flowchart TD
  C["Client"] --> I["Ingress adapter<br/>threshold + byte caps + backpressure"]
  I -->|small body| M["Bounded RAM body"]
  I -->|large body| RS["SSD: original JSON request spool"]
  M --> P["full parse<br/>validate, token-count, original-byte transforms"]
  RS --> P
  P -->|identity passthrough| ID["Stream original JSON<br/>without full-body stringify"]
  M --> ID
  RS --> ID
  P -->|converted route| X["Offload allowlisted request binary<br/>replace inline data with BlobRefs"]
  X --> B["SSD: request blob store"]
  X --> T["Ref-aware conversion<br/>small JSON skeleton + BlobRefs"]
  T --> S["Ref-aware serializer<br/>small JSON chunks"]
  B -->|blob chunks| S
  ID --> U["Upstream fetch<br/>backpressured POST"]
  S --> U
  U -->|request send complete| RC["Delete request spool<br/>after the last reader"]
  U --> R{"Response type"}
  R -->|large non-SSE JSON| JS["SSD: response body spool"]
  JS --> JP["parse + response transforms"]
  JP --> JB["SSD: per-response binary scratch"]
  JP --> JO["Backpressured client write<br/>JSON skeleton + blob chunks"]
  JB -->|blob chunks| JO
  JO --> C
  JO --> JC["Delete response spool and blobs<br/>after client write"]
  R -->|large SSE event| ES["SSD: one-event spool<br/>never the whole SSE stream"]
  ES --> EP["event parse<br/>extract response binary"]
  EP --> EB["SSD: per-event binary scratch"]
  EP --> EO["Backpressured client write<br/>event skeleton + blob chunks"]
  EB -->|blob chunks| EO
  EO --> C
  EO --> EC["Delete event spool and blobs<br/>after client write"]
  R -->|small JSON body or ordinary SSE event| BP["Forward with<br/>downstream backpressure"]
  BP --> C
  N["All disk state is process-lifetime scratch<br/>restart discards everything; no resume or replay"]
```

**Sequence view**

```mermaid
sequenceDiagram
    participant C as Client
    participant P as Proxy RAM
    participant D as SSD scratch<br/>(current process only)
    participant U as Upstream Provider

    C->>P: POST JSON with inline binary
    opt body above threshold
        P->>D: stream original JSON to request spool
    end
    P->>P: full parse O(B)<br/>validate, token-count, original-byte transforms
    alt identity passthrough
        P->>U: POST original JSON from bounded RAM or spool chunks
    else converted route
        P->>D: offload allowlisted binary to blob store
        P->>P: ref-aware conversion<br/>small JSON skeleton + BlobRefs
        P->>U: POST skeleton chunks + blob chunks
    end
    P->>D: delete request spool after last reader
    U-->>P: JSON response or SSE stream
    alt large non-SSE JSON body
        P->>D: spool response body above threshold
        P->>P: parse + response transforms
        P->>D: offload response binary payloads
        P-->>C: backpressured write of JSON skeleton + blob chunks
        P->>D: delete response spool and blobs after client write
    else large SSE event containing binary
        P->>D: spool one large event, never whole SSE stream
        P->>P: event parse + extract response binary
        P-->>C: backpressured write of event skeleton + blob chunks
        P->>D: delete event spool and blobs after client write
    else small JSON body or ordinary SSE event
        P-->>C: forward with downstream backpressure
    end
    Note over P,D: request, response, event, and blob files are scratch only<br/>restart discards everything - no resume or replay
```

The request path uses an **original JSON spool** for the initial parse and
identity forwarding. After global mutations, the **effective body** (a ref
skeleton) or a separate **effective spool** for a large non-ref body is the
canonical state for retries/rungs. The blob store holds payloads extracted
before or produced during conversion. Converted binary egress keeps only a
small JSON skeleton plus refs in RAM and streams skeleton chunks interleaved
with blob chunks. The response path applies the same model to a finite JSON
body or one SSE event, never a whole SSE stream. Full parses happen in RAM
without a proxy concurrency throttle. All disk state is scratch for the current process
and is discarded, never resumed, after restart.

### 5.1 Ingress: spool, do not buffer

Replace the buffering behavior in both `createNodeRequestHandler`
(`src/server.ts:79`) and the existing cap (`src/index.ts:1178-1212`) with one
backpressured, byte-counted path:

- A declared body at or below `threshold_bytes` (proposed 1 MiB) may use the
  in-memory path, but the adapter still needs pull-based backpressure.
- A larger declared body spills from the start. For unknown/chunked lengths,
  buffer only until the threshold; on crossing it, write the already-received
  prefix and then the remaining chunks to the file. Do not discard the prefix
  by switching directly to `pipeline()` after N bytes.
- `pipeline()` or an equivalent async iterator/write loop applies socket and
  filesystem backpressure. Memory is bounded by configured stream buffers per
  active upload, not by body size.
- `Content-Length` is only an early rejection hint. The actual byte counter is
  authoritative and enforces `max_request_bytes` for every encoding.
- A total-bytes reservation enforces `max_total_bytes` across live spools and
  is released on every terminal path. On breach, return an explicit error with
  a `warn` log line. **Never** truncate silently (repo rule #8).

Attach a `SpoolRef` to the request without header smuggling, and preserve it
through early `Request` reconstruction such as `src/index.ts:1211`. The ref
identifies the **raw client body** for identity forwarding and original-byte
consumers. Once global mutations produce the effective request state, converted
rungs must use that state rather than treating the raw spool as their body
source. A symbol or `WeakMap<Request, SpoolRef>` attached only in the adapter is
insufficient because later `Request` objects lose the association.

**Anti-pattern to avoid:** constructing `new Request(url, {body: fileStream})`
and then calling `.json()`. undici buffers the stream entirely; that is exactly
the behavior being escaped. The body must come off disk at the point of use.

### 5.2 Body ownership

`await request.text()` becomes `await readSpoolText(rawSpoolRef)` for the
initial spilled body:

```ts
// src/utils/spool.ts
const text = await readSpoolText(rawSpoolRef);
routeBody = JSON.parse(text);
```

There is no proxy body-materialization semaphore or `max_body_concurrency`
setting by default. Full parses and non-ref processing retain O(N×B) across N
concurrent exchanges when §5.9 admission is disabled; L1/L2 capacity does not
change that transient. Enabling its nominal byte budget adds pre-parse admission
without introducing a request-count or SSE-lifetime cap.

Use three explicitly different ownership states:

- **Raw spool:** the immutable original client bytes. It is authoritative only
  for identity passthrough and consumers that intentionally need original
  bytes before mutation.
- **Effective body:** the parsed object after privacy, kompress, tool erase,
  and other global mutations. This is the same role as today's mutated
  `routeBody`, and is the canonical state for every converted/ladder attempt.
- **Attempt body:** an attempt-local object derived from the effective body,
  followed by rung-specific model rewriting and `request_ingress` transforms.

Ownership rules:

- Let the full source text become collectible immediately after the initial
  parse; do not retain `bodyText` through validation, extraction, or sidecars.
- Binary extraction produces a small skeleton with leased BlobRefs before
  privacy/kompress/judge and other network I/O, so those consumers do not retain
  the binary payload.
- An arbitrary large non-ref body remains fully resident through global
  sidecars and `JSON.stringify` into its effective spool. Release the parsed
  object and transient string immediately after the write. This is an O(B) per
  exchange cost with no fixed proxy concurrency cap.
- For a non-ref rung requiring conversion, parse the effective spool,
  convert/apply hooks, and serialize once to an **attempt spool**. Release the
  full objects/string before streaming that attempt spool upstream. If no
  conversion is needed, stream the effective spool directly. No full non-ref
  body is captured by an SSE closure. Apply the same spill-before-network rule
  to non-ref responses and events.
- Read-only routing and metadata extraction reuse the effective body when it is
  in RAM rather than parsing another copy.
- Construct at most one handler body per attempt and pass that object directly
  instead of having the handler call `.text()`/`.json()` again.
- After binary extraction, create an attempt body with
  `structuredClone(effectiveBody)`: the JSON skeleton is small, and no binary
  payload is copied. Every cloned BlobRef keeps the **same `leaseId`**; cloning
  performs an atomic lease `retain()` that increments the L2 index's `refs`
  count. The effective body owns its initial ref until no more attempts can be
  created, and every attempt releases its cloned ref exactly once in `finally`.
  Never reconstruct a converted rung by parsing the raw spool; doing so would
  lose redaction, compression, and tool erasure.
- Per-rung hooks mutate only the attempt body. Mutations from rung A must not
  leak into rung B, while both inherit all effective-body mutations.
- The raw spool is not overwritten. Raw/effective/attempt spills have
  independent byte accounting/lifecycle within `max_total_bytes`.
- Inline-binary extraction releases full-payload owners only after validation
  and all consumers that require original bytes have run or become ref-aware.

### 5.3 Egress: three shapes, increasing ambition

1. **Identity.** `/passthrough` forwards `bodyText` verbatim
   (`passthrough.ts:222`). Stream the spool file directly: `Content-Length`
   from `stat`, body from `createReadStream`. After the schema gate, retain
   only `model`, `stream_options.include_usage`, and other required scalars.
   Zero transformation, no full-body string at send. The raw spool is valid
   here because current `/passthrough` bypasses privacy/kompress/tool-erase
   mutations. If passthrough later gains those mutations, stream an effective
   spool or disable this identity optimization instead of forwarding the raw
   client body.
2. **Converted, rehydrated.** Handlers build objects with blob refs, then
   expand refs and serialize to one full string at the send boundary. This can
   reduce intermediate copies, but the full string/send buffer is still O(B)
   for a slow upstream. It is transitional, not a flat-memory solution.
3. **Converted, streamed.** A ref-aware serializer emits ordinary JSON chunks
   and reads each blob file in chunks at the exact ref position. Token/sentinel
   replacement, if used, must be collision-safe and preserve JSON escaping.
   Every streamed upstream `fetch` init needs `duplex: 'half'`; the existing
   inbound example in `src/server.ts:104` is not enough. Recompute an exact
   `Content-Length` from skeleton bytes plus blob sizes, or omit it — never
   forward a stale length.

Shapes 1 and 3 fix the slow-upstream request-send window. Shape 2 does not.

**Token estimation and SSE release requirement for all supported converted
paths:** before creating the response stream, calculate input usage from the
final effective/attempt body after sidecars and applicable hooks, then pass only
the resulting number and other scalar metadata into the stream. In particular,
change `createStreamTransformer` and the Responses-to-Claude pump so they do not
close over `requestBody` for the whole stream.

For non-binary text/tools, retain the existing estimator. For every extracted
binary payload, use only its base64 character count:

```ts
binaryTokens = Math.ceil(blobBase64CharLength / charactersPerToken); // default 4
```

Base64 is ASCII, so the blob's stored byte length is its character count. Do
not read the blob for token counting. **Ignore all fixed block metadata** for
this binary contribution: no field labels, media/source type, data-URL prefix,
or former image/document `+20`/`+10` overhead. This is deliberately an
approximation and need not match the pre-ref/tiktoken result. Upstream-reported
usage remains preferred whenever available.

Apply the same full-body-release audit to privacy restoration, usage recording,
conversation state, and transforms.

### 5.4 The store behind the refs

**This one is the RAM + SSD two-level cache**: L2 disk is the on-disk copy for
the current process lifetime, L1 memory is the hot tier, and a recurring image
is a hit. It is different from the §5.1 per-request spill, which is never
shared across requests. Neither tier is loaded or reused after a restart.

- **L1 memory:** `Map<sha256, {b64, bytes, lastUsed}>`, capped by **total bytes**
  (proposed 64 MiB), LRU eviction. Entries vary from KB to tens of MB, so a
  count-based cap is meaningless. Include this entire cap in memory estimates.
  Streamed egress should not need to promote a large blob into L1 merely to
  send it once.
- **L2 disk:** `<spool_dir>/blobs/<aa>/<bb>/<sha256>`, atomic write (tmp + rename;
  the pattern already used by `src/utils/config-loader.ts`), lazy delete on
  expiry plus a startup sweep. Total current-process L2 payload bytes are capped
  by `max_blob_disk_bytes`, separately from request/response/event spills.
- **L2 index, entirely in process memory:**
  `Map<sha256, {size, lastUsed, refs}>`. It contains metadata only, never the
  base64 payload. `size` is the blob's on-disk byte count, `lastUsed` drives
  idle LRU/TTL, and `refs` counts active owners sharing the lease, including
  cloned attempt refs. The index tracks the running byte total so eviction
  does not need to `stat` every file.
- The L2 index starts empty on every process start. Startup never scans old
  blobs to reconstruct it and never creates cache hits from old files; safe
  stale-file deletion is the only permitted startup operation. Thus restart
  requires no index recovery, snapshot, WAL, or deserialization.
- Before an L2 write, evict idle `refs = 0` entries by LRU until
  `currentBytes + size <= max_blob_disk_bytes`. Entries with `refs > 0` are
  pinned. If insufficient unleased bytes can be freed, fail the new cache write
  explicitly rather than exceed the cap, delete an active blob, or silently
  bypass accounting. L1 eviction remains independent and can still free RAM.
- **Hash the base64 text**, not the decoded bytes. It is what the wire needs, so
  a hit needs no re-encode; exact-string dedup is enough. Skip "same image,
  different padding" — a decode pass per ingest costs more than it saves.
- **Refs exist only at explicit, schema-qualified inline-binary positions
  (9.3).** The allowlist covers the documented SSE request families and their
  non-streaming counterparts:
  - Claude Messages: a `type: "image"` or `type: "document"` content block
    with `source.type: "base64"` → `source.data`. This includes base64 PDFs;
    plain-text and URL document sources are excluded.
  - OpenAI Chat Completions: a `type: "image_url"` part → `image_url.url`
    when it contains a base64 `data:` URL; a `type: "input_audio"` part →
    `input_audio.data`; and a `type: "file"` part → `file.file_data` when
    inline base64/data-URL content is present. Remote URLs and file IDs have
    no inline payload to extract.
  - Gemini: any `inline_data` or `inlineData` part with a `data` string →
    `data`, for image, audio, video, PDF, and other declared MIME types.
    `file_data`/`fileData` contains a URI rather than inline bytes and is not
    extracted.
  - OpenAI Responses: a `type: "input_image"` item/content part → `image_url`
    for a base64 `data:` URL; a `type: "input_file"` item/content part →
    `file_data` when inline content is present; and an inline skill with
    `type: "inline"`, `source.type: "base64"`, and
    `source.media_type: "application/zip"` → `source.data`.

  Ref metadata records the source shape and any original `data:` URL prefix;
  only the base64 payload is stored in the blob. Rehydration must reproduce
  the original field and wire bytes exactly. There is no generic "long
  base64-looking string" detection. Large text and fields outside this
  allowlist remain O(B) after parse.
- Every consumer contract must be explicit: validation, token counting,
  privacy filtering, compression, and transforms either run before extraction
  or understand refs. Rehydration must happen only where original bytes are
  semantically required, not by default on every pass.
- Eviction/TTL convention mirrors `src/utils/conversation-store.ts`
  (insertion-ordered `Map`, lazy evict on access + opportunistic evict on
  write) rather than introducing a second idiom, with one exception: TTL is
  idle time after the last lease release. L2 eviction must skip leased blobs;
  L1 may evict their memory entries because the leased L2 file remains the
  source for streaming.

### 5.5 Lifecycle

**BlobRef leases:**

- Every `BlobRef` carries a `leaseId` in addition to its blob hash, byte
  length, and wire-format metadata. Blob creation and the initial lease become
  visible only after the atomic tmp+rename completes. Cache lookup and lease
  acquisition are one atomic operation, so eviction cannot win that race.
- The lease follows the ref through conversion, retries, and serialization.
  Cloned BlobRefs share one lease rather than creating independent rung leases:
  `retain()` increments `refs`, each clone's `release()` decrements it exactly
  once, and the lease manager renews that shared lease once regardless of clone
  count. Renewal occurs at no more than `ttl_seconds / 3`, even if the
  upstream/client has produced no new bytes recently. There is no 600-second
  maximum request duration and no maximum total lease duration;
  `ttl_seconds = 600` applies only after the blob becomes idle. Existing
  request/upstream timeout and abort policies still end the affected exchange.
- A leased L2 blob is never deleted by TTL, LRU, opportunistic cleanup, or a
  slow upstream request send. The same protection covers a slow client write
  of a response body or SSE event. Renewal while merely holding an idle cached
  blob is forbidden: only a live exchange with an unconsumed ref extends it.
- Every effective-body/attempt/response owner releases its ref in `finally`
  after its reader finishes or aborts. Only when the shared lease reaches
  `refs = 0` does renewal stop: for a request-cache blob, idle TTL starts then;
  for a per-response/event scratch blob, final release schedules deletion.
  Close file handles before unlink. A failed clone does not increment `refs`;
  a failed attempt after `retain()` still releases exactly once.
- Renewal failure, a missing leased file, or an expired lease must fail the
  exchange loudly and cancel the send. Never continue with a partial blob or
  silently fall back to an empty payload. Restart still discards all leases
  and files; no lease is persisted or recovered.

**Spill and request lifetime:**

- A per-request spool has explicit owners/readers. Delete it only after parse,
  retries, and the upstream request body have finished with it — response
  headers alone do not prove that a still-streaming request body is finished.
- Remove files on completion, error, upstream abort, and client abort. Close
  file handles before unlinking, including on win32. Client disconnect must
  cancel the upstream work and any active file reader, not merely release the
  dashboard counter.
- SSE response completion should normally find no per-request upload spool
  still needed: the upstream request send has already ended. Cached blobs may
  outlive the request only under the §5.4 cache policy and after all leases
  have been released.
- Restart discards all request and cache state. Startup never parses old
  request spills, continues a client upload or upstream send, resumes an SSE
  response, or treats old blobs as cache hits. Crash leftovers are only
  removed by a startup sweep with an age threshold, so a file written 100 ms
  ago by a concurrently starting worker is not deleted. No recovery manifest
  or replay metadata is written.
- **Do not** rely on `open()` + `unlink()` (unlinked-but-open fds). It is
  POSIX-only and the repo ships a win32 SEA build. The sweep is the portable
  answer.
- Directory mode `0700`; the resolved path is logged at startup.

### 5.6 Config

A `[spool]` section beside the existing `[fetch]` in `proxy_config.toml`,
resolved by `src/utils/config-loader.ts` like its neighbours:

```toml
[spool]
enabled = false                # opt-in per 9.1 — nothing is spooled until true
dir = "~/.cache/model-proxy/spool"
threshold_bytes = 1048576      # below this, bounded in-memory path
max_request_bytes = 10485760   # preserves the current 10 MiB default
max_response_bytes = 67108864  # one JSON response body or one SSE event
max_total_bytes = 2147483648   # live request/response/event spills, not cache
max_materialized_body_bytes = 0 # optional §5.9 nominal RAM budget; 0 disables
materialization_factor = 2.0   # conservative copy/object overhead calibration
max_admission_queue = 64       # maximum waiting large bodies/events
admission_timeout_ms = 30000   # maximum admission wait
max_blob_cache_bytes = 67108864   # L1 payload bytes in RAM
max_blob_disk_bytes = 268435456   # L2 payload bytes on disk, excluding spills
ttl_seconds = 600              # idle TTL after last lease release, not send limit
```

Env overrides follow the existing `SPOOL_*` convention if the loader requires
them. Validate at startup and fail on an unusable directory (repo rule #8 — a
spool config that silently falls back to memory is worse than no config). Warn
explicitly if the selected filesystem is tmpfs or another RAM-backed mount.
The configured per-request limit replaces the hardcoded cap without weakening
chunked-body enforcement. `max_response_bytes` does not cap total SSE stream
length; it caps each finite event, while `max_total_bytes` caps all live spills.

**Concurrency sizing:** there is no `max_body_concurrency`. For more concurrent
blob-heavy exchanges, advise operators to increase `max_blob_cache_bytes` (L1
RAM) and `max_blob_disk_bytes` (L2 disk) so active blobs remain available without
cache-cap failures. Size L1 within the host's RAM budget and L2 within available
SSD capacity, then measure cache hit/eviction rates. These settings support blob
retention and reuse; they do **not** limit full-parse or large non-ref memory,
which remains O(N×B) when §5.9 admission is disabled. Operators needing a proxy
nominal-byte budget enable `max_materialized_body_bytes` separately.

### 5.7 Response bodies and SSE events

Response offload uses the same scratch directory, blob serializer, and
process-lifetime rules, but the finite unit differs by response type. There is
no response body/event semaphore by default; §5.9 adds optional byte admission.

**Non-SSE JSON responses:**

- At or below `threshold_bytes`, retain the existing bounded in-memory path.
- Above the threshold, stream the upstream body to a per-response spool while
  counting bytes; do not call `response.clone().text()` or buffer a second copy.
- Identity forwarding may stream the original response spool directly without
  parsing. A converted response is fully parsed, runs consumers that need
  original bytes, extracts response blobs, and streams the small transformed
  JSON skeleton plus blob chunks to the client.
- Enforce `max_response_bytes` per body. On breach or disk failure, cancel the
  upstream body and fail explicitly; never silently truncate the response.

**SSE responses:**

- Frame one event at a time, preserving event boundaries and order. Small
  events pass through with bounded buffering. If an event exceeds
  `threshold_bytes`, spill that event while receiving it; never spool the whole
  SSE stream before forwarding.
- A large event is capped by `max_response_bytes` and fully parsed when
  inspection/conversion is required. Extract allowlisted binary
  payloads, replace them with refs, and emit the event skeleton interleaved
  with blob chunks. Ordinary comments, keep-alives, and non-JSON events remain
  byte-passthrough.
- Process events sequentially so usage/tool tracking and client event order
  cannot change. A slow client pauses event reads from upstream; it must not
  cause later events to accumulate in an unbounded RAM queue.
- Delete the raw event spool and response blobs after the client write
  completes, or on upstream/client abort. Response blobs are per-response
  scratch and do **not** populate the cross-request blob cache by default.

The initial response-binary allowlist is deliberately separate from §5.4's
request allowlist:

- Gemini response content parts with `inline_data`/`inlineData.data`, for any
  declared MIME type. These are the model-generated images/audio/video/binary
  parts preserved by native Gemini passthrough.
- OpenAI Responses output items with `type: "image_generation_call"` and a
  base64 `result`, whether encountered in a completed JSON response or an SSE
  output-item event. Other streaming binary fields require their own exact
  predicate and round-trip tests before being added.

Claude assistant image blocks and OpenAI Chat Completions assistant image
parts are not added: the documented schemas do not carry them. Do not use the
request-side `source.data` predicate indiscriminately on responses.

**Failure after response streaming begins:** before response headers, return an
explicit non-2xx error. Once headers or any body bytes/events have reached the
client, a renewal, disk, or parse failure must **abort the client connection**
and emit an error log containing the request ID and failed stage. Do not emit a
terminal success/`[DONE]` event or silently accept a truncated body. Cancel the
upstream response and active file readers; release each shared-lease ref exactly
once in `finally`; close file handles before deleting
request/response/event spills and scratch blobs; and release the in-flight
request counter. The same connection-abort rule applies to a partially written
non-SSE response.

**Required backpressure changes:** remove response `tee()` branches used only
for logging and replace them with single-pass observation. In `src/server.ts`,
pipe the web response stream with proper Node `pipeline()` handling, or await
socket drain in the `WritableStream.write` callback; the current ignored
`passthrough.write()` result is not backpressure. Keep-alive injection and all
response transforms must likewise wait for downstream demand rather than
unconditionally enqueueing. These changes are required for response spooling
to bound memory; disk alone cannot fix an unconsumed in-memory queue.

### 5.8 `auth_with_body`: external-link projection

The auth sidecar must see the post-privacy/kompress/judge body, but it does not
need to receive inline binary under an updated auth contract. When external
link upload is explicitly configured, build a separate **auth projection**:
text and tools keep their final mutated values, while each request `BlobRef`
becomes a small `BlobLinkRef`:

```json
{
  "type": "external_blob",
  "url": "https://object-store.example/signed-download-url",
  "sha256": "<hash of stored base64 payload>",
  "size": 123456,
  "media_type": "image/png",
  "encoding": "base64"
}
```

`external_blob` is a **new custom-defined object in the auth request only**. It
is not defined by any Claude, OpenAI, or Gemini request schema. The proxy and
auth service must explicitly implement and version this contract. The auth
service must understand `external_blob` and, when it needs the content, fetch
and hash-verify it before returning its auth decision.

**Uniform replacement rule:** keep the original field path and surrounding
metadata, but replace the inline string value with the `external_blob` object.
Apply this rule to every allowlisted binary field, whether or not the schema has
a native URL alternative. Do not rename the field to `source.url`, `file_url`,
`fileUri`, or `uri` in the auth projection. Existing remote URLs/file URIs were
never extracted and pass through unchanged. The upstream path later rehydrates
the original inline field/value from the local BlobRef, not this auth object.

For example, an original Claude image block:

```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",
    "data": "AAAA..."
  }
}
```

has this auth-only projection:

```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",
    "data": {
      "type": "external_blob",
      "url": "https://object-store.example/signed-url",
      "sha256": "<hash>",
      "size": 123456,
      "media_type": "image/png",
      "encoding": "base64"
    }
  }
}
```

The same same-path replacement applies to Chat Completions `image_url.url`,
`input_audio.data`, and `file.file_data`; Responses `input_image.image_url`,
`input_file.file_data`, and inline skill `source.data`; Gemini
`inlineData.data`/`inline_data.data`; and Interactions `input[].data`.

**Schema-native inline-binary → URL mappings**

These mappings describe fields already defined by the respective model APIs;
they are not the custom auth-only `BlobLinkRef`:

| API schema | Inline base64 image/binary field(s) | URL/URI field mapping | Notes |
|---|---|---|---|
| Chat Completions | `content[].image_url.url` (image data URL)<br/>`content[].input_audio.data` (audio)<br/>`content[].file.file_data` (file) | Image: replace in the **same** `content[].image_url.url` field with an `https://` URL.<br/>Audio: **no URL field**.<br/>File: **no URL field**. | `file.file_id` is an uploaded-file ID, not a URL. |
| Responses | `input_image.image_url` (image data URL)<br/>`input_file.file_data` (file/document)<br/>Inline skill `source.data` (ZIP) | Image: replace in the **same** `input_image.image_url` field.<br/>File: `input_file.file_data` → `input_file.file_url`.<br/>Inline skill ZIP: **no URL field**. | `file_id` and `skill_id` are resource IDs, not URLs. |
| Claude Messages | `image.source.data`<br/>`document.source.data` | `image.source.data` → `image.source.url`.<br/>`document.source.data` → `document.source.url`. | Change `source.type` from `base64` to `url`; document URL mapping applies to the URL PDF source variant. |
| Gemini GenerateContent | `inlineData.data` or `inline_data.data` for image/audio/video/document | `inlineData.data` → `fileData.fileUri`.<br/>`inline_data.data` → `file_data.file_uri`. | Also map `mimeType` ↔ `mime_type`; supported URI schemes depend on the provider. |
| Gemini Interactions | `input[].data` where `type` is `image`, `audio`, `document`, or `video` | `input[].data` → `input[].uri` for each content type. | Keep the content `type` and `mime_type`. |

Only these schema-native mappings can replace inline binary with a URL on an
upstream request, and only after an explicit product decision to make that
change. They do not authorize sending the custom auth object upstream.

- Upload each L2 blob by streaming it to the configured object store. Upload
  and auth network I/O retain only the small ref skeleton, not the full parsed
  request. Renew the blob's existing lease throughout upload, auth fetch, and
  the subsequent upstream
  send; slow external I/O must not trigger TTL deletion.
- Serialize and send only the small auth projection to `auth_with_body`. Do not
  rehydrate a full auth JSON string. The upstream request is unchanged in
  semantics: it still streams the original inline base64 fields from the local
  blobs. Never send `BlobLinkRef` objects or replacement URLs upstream unless
  a separate product decision explicitly changes the upstream API request.
- Require an HTTPS object store reachable by the auth service, short-lived
  signed download URLs, a URL lifetime longer than the auth timeout, and
  hash/size verification. Signed URLs and credentials are redacted from logs.
  External upload is a separate opt-in because user binary content now leaves
  the proxy host.
- Upload, URL-generation, auth-fetch, or verification failure fails auth
  explicitly and prevents the upstream call. Never silently fall back to an
  empty binary field or send a broken link.
- Best-effort delete external objects after the auth decision, and configure a
  storage-lifecycle TTL for failure/crash leftovers. External objects are not
  request recovery state, are never reused as a persistent proxy cache, and
  are never resumed after restart. This temporary auth-link store does not
  change the no-cross-process-sharing rule for the local blob cache.
- If no external uploader is configured, preserve the existing full-body auth
  behavior. The implementation must not silently emit refs or strip binary
  without the auth service's explicit contract support.

### 5.9 Optional byte-based materialization admission

Operators who need a hard proxy-level budget for large non-ref processing can
enable admission with `max_materialized_body_bytes`. It is **0/disabled by
default**, so the no-body-semaphore behavior remains unchanged unless opted in.
This is a byte budget around full-body materialization, not a total in-flight or
SSE connection limit.

```text
Raw body is fully received into a spool
  → read spilled size B
  → reserve ceil(B × materialization_factor) before read/parse
  → read + parse + validate
  → binary reduced to refs: release reservation after extraction
  → large non-ref: retain reservation through sidecars/conversion/stringify
  → write effective/attempt/egress spool
  → release full objects and reservation
  → stream spool upstream/client with no admission held
```

Admission must start before parsing because non-ref status is unknown until the
body has been parsed. Binary exchanges therefore use a reservation temporarily
and release it as soon as extraction succeeds. Non-ref exchanges keep it through
slow sidecars and serialization. A non-ref rung that starts from an effective
spool acquires a fresh reservation before parsing/conversion and releases it
after its attempt spool is complete. Large non-ref responses and SSE events use
the same rule.

Admission behavior:

- If capacity is available, proceed immediately. Otherwise queue in arrival
  order while the raw body remains on disk; pause upstream response/event reads
  while their admission is waiting.
- Bound the queue by `max_admission_queue` and each wait by
  `admission_timeout_ms`. On timeout/overflow, return `429` or `503` with an
  explicit error before client response headers; never begin materialization
  after rejection.
- On client abort, timeout, parse/validation/sidecar/disk failure, or
  serialization failure, remove the queued waiter or release its reservation in
  `finally`. No reservation survives restart.
- `materialization_factor` accounts conservatively for decoded text, parsed
  objects, and serialization copies; B alone is not an exact heap size. Start
  with a measured factor and validate with heap profiles. The byte limit is a
  hard cap on **nominal admitted bytes**, while actual RSS correctness depends
  on that calibration and still needs process/host limits.
- Queued raw spills remain under `max_total_bytes`; L1/L2 cache sizing is
  independent. Admission is released before slow upstream/client streaming and
  the long-lived SSE response, so it does not limit total SSE connections.

---

## 6. Phases

### Phase 0 — free wins, no new storage (ships with Phases 1–2, not before)

1. `src/utils/logger.ts:74-85`: gate object `JSON.stringify` on trace level.
   Needs a `traceEnabled` flag exposed from `createLogger`'s closed-over
   `minLevel` (`logger.ts:129`). Removes full-body stringifications at every
   log level above trace.
2. `src/index.ts:2240` + `:2259` and handler entry points: remove redundant
   read/parse/serialize cycles where ownership can be made explicit. Preserve
   attempt-local mutation isolation for per-rung transforms.
3. `src/handlers/passthrough.ts:159`: after the schema gate, drop the parsed
   object; keep only the model, usage flags, and other scalars actually used by
   the response path.
4. Make the existing total body cap configurable and enforce it in the
   streaming path; add a per-request inline-binary payload-count cap next to
   `validation.ts:9`. These are DoS guards independent of spooling.

Phase 0 reduces copy constants but leaves O(N×B) live-request behavior. It is
self-contained enough to ship alone, but the 2026-11-02 decision was to hold it
so the whole memory change is reviewed as one unit (§9.4).

### Phase 1 — ingress spool (§5.1, §5.2)

Fixes the slow-upload window. Replaces, rather than wraps, the existing 10 MiB
buffering block and preserves `SpoolRef` across request reconstruction. Adds
real backpressure to both the in-memory and spill branches.

Phase 1 alone does **not** fix slow upstream sends or SSE request-body
retention: full parsed objects and serialized upstream bodies still exist.

### Phase 2 — request/response egress and SSE release (§5.3, §5.7, §5.8)

Fixes the slow-upstream request-send and slow-downstream response-send windows
for identity and streamed-ref paths. Removes full request bodies from SSE
response closures while preserving token usage and other response metadata.
Adds finite JSON response spooling, per-SSE-event spooling, and the required
end-to-end downstream backpressure. When configured, `auth_with_body` uses the
external-link projection in §5.8 instead of uploading a full inline-binary
body to the auth sidecar.

Scope request shapes 2–3 to the documented endpoint families that carry the
§5.4 inline-binary shapes, rather than all stringify sites at once:

- `/v1/messages`;
- `/v1/chat/completions` (and its `/v1/completions` alias);
- `/v1/responses`;
- `/v1beta/models/{model}:generateContent` and `:streamGenerateContent`, plus
  the `/v1/models/{model}` equivalents;
- `/v1/interactions`.

Cover both SSE and non-SSE variants because their request bodies have the same
inline payloads. Cover every supported upstream conversion, not only native
passthrough, and audit each SSE response closure for accidental full-body
retention. Response work covers native Gemini inline-data output and OpenAI
Responses image-generation output in both completed JSON and SSE events.
Fields outside the request/response binary allowlists remain subject to §9.3
and §5.7.

### Phase 3 — deferred, not approved (§9.2)

Constant memory *through* parse via a schema-aware pre-scan that rewrites only
§5.4 binary payload runs into tokens on disk before parsing.

**Status: deferred.** Do not start it. The trigger to reopen is the Phase 2
measurement of §7: if the full-parse transient is still the top allocator under
real inline-binary traffic, the scanner is worth the lexing risk; until that
number exists, it is speculation against a real behavior change. A context-free
`"data":"…"` scanner is not approved.

---

## 7. Expected effect and measurement

Let `N` be live exchanges, `B` body/event size, `C` bounded stream-buffer memory
per active unit, and `R` response-side queued/converter state. The target is
asymptotic, not an unprofiled copy multiplier:

| Window | Today | After Phase 1 | After Phase 2 |
|---|---|---|---|
| Slow upload | O(N×B), including adapter/cap buffering | O(N×C) outside parse | O(N×C) outside parse |
| Full parse | Up to O(N×B) | O(N×B), with no proxy body semaphore | O(N×B) during parse, plus small refs/metadata after extraction |
| Slow upstream request send | O(N×B) | O(N×B) | O(N×C) for identity/shape 3 and non-ref attempt-spool streaming; shape 2 remains O(N×B) |
| Slow downstream JSON response | O(N×B) for clone/text/stringify paths | Same as today | O(N×C) outside full parse/serialization |
| Large non-ref sidecars/conversion/serialization | O(N×B) | O(N×B) | O(N×B), then disk-backed I/O after object release |
| Long converted SSE response | O(N×B) on paths retaining `requestBody`, plus R | Same as today | Small request metadata/refs plus bounded R after closure release |
| Large binary SSE event with slow client | O(N×B) for the event, plus potentially unbounded R | Same as today | O(N×C) outside event parse, bounded R, no whole-stream accumulation |

Add the global L1 blob-cache cap and O(blob count) L2 index metadata to all
Phase 2 totals. `max_blob_disk_bytes` limits L2 disk payload bytes, not the RAM
index entry count. Under §9.3 and §5.7, arbitrary non-ref fields remain O(B)
per materialized body and O(N×B) in aggregate with admission disabled. Enabling
§5.9 instead caps nominal admitted materialization bytes at
`max_materialized_body_bytes`, subject to `materialization_factor` calibration.
This is not a constant-memory parse/serialization claim. `R` is bounded by the
Phase 2 downstream backpressure changes, not merely by moving queued bytes to
disk.

Phase 0 reduces constants only. Phases are *stages of one change*, not release
steps: per §9.4 they ship together, so operators should evaluate the final
combined result rather than an intermediate phase.

Measurement requirements:

- Use heap snapshots/allocation profiles and external-buffer accounting at each
  window, including after response headers and midway through an open SSE
  stream. RSS alone is affected by GC timing and allocator retention.
- Record full-parse concurrency and p50/p95/p99 end-to-end latency, not only
  memory. Tune L1/L2 sizes from hit/eviction rates and host RAM/SSD budgets.
- Report each request and response payload family separately, including Gemini
  output blobs and OpenAI image-generation output. Measure completed JSON
  responses, individual SSE events, and non-allowlisted large text as separate
  cases rather than generalizing one result to all of them.

Costs, stated honestly:

- **Disk I/O** of spool writes/reads plus blob reads. For always-new payloads
  this is a RAM→I/O trade with added latency, and only wins when peak RAM
  matters more than that cost.
- **Disk footprint** includes live request/response/event spills and retained
  L2 request blobs; `max_total_bytes` caps the spills and
  `max_blob_disk_bytes` independently caps the L2 payload cache.
- **Cache/index memory:** L1 can add up to `max_blob_cache_bytes`, and the L2
  index adds O(blob count) metadata in RAM. Measure both; neither is free
  merely because it improves dedup hits or avoids filesystem `stat` calls.
- **New failure modes:** a full/slow filesystem or an L2 cap whose entries are
  all leased can fail requests that used to succeed. Must surface as an
  explicit error with a log line, never as a truncated body or active-blob
  eviction.

---

## 8. Rejected alternatives

| Alternative | Why rejected |
|---|---|
| Admission control over in-flight requests as the primary fix | It would bound N and protect against overload, but a whole-request permit is held for minutes by slow uploads and SSE responses, causing queue waits for healthy traffic. Rejected in favor of spooling/streaming plus optional §5.9 nominal-byte admission only around materialization; no whole-request/SSE permit is held. |
| `new Request(url, { body: fileStream })` then `.json()` | undici buffers the whole stream; the memory is not saved, only relocated a layer deeper. |
| `fs.readFile` + parse without ingress spooling | Saves nothing during the upload window, which is half the complaint. |
| Spool to `os.tmpdir()` without checking the filesystem | A tmpfs offload remains RAM. |
| Streaming JSON parser dependency | `package.json` carries only `fast-safe-stringify`, `js-tiktoken`, `safe-stable-stringify`; a new runtime dep for one endpoint class is not warranted before §9.2 reopens. |
| Compress/resize images at the proxy | Product decision (fidelity), not a memory fix, and it changes what the model sees. Out of scope. |

---

## 9. Decisions

All five were settled on 2026-11-02. Each records what was chosen, not just
what was rejected, so a later reader does not re-litigate it.

### 9.1 On-disk inline payloads — **opt-in, off by default**

`[spool] enabled = false` ships as the default; user request/response payloads
and inline binary content reach disk only when an operator turns it on.

Rejected: default-on above a threshold (would write user content to disk in
every deployment, noticed or not), and an operator-created-directory-as-consent
model (a config that silently means "off" conflicts with fail-loud — repo rule
#8).

Consequence accepted: the slow-upload fix only reaches operators who opt in,
and the feature ships unused by most deployments. Documented in `README.md` as
part of the implementation change.

### 9.2 Phase 3 scanner — **deferred pending Phase 2 measurements**

Not approved, not rejected. The trigger to reopen is stated in §6, Phase 3:
the full-parse transient must still be the top allocator under real
inline-binary traffic. Recording it as deferred rather than rejected matters —
the reason is "we don't have the number yet", not "we judged it unsound".

A lexical `"data":"…"` rewrite could make parse itself constant-memory, but a
context-free rewrite is not compliant with §9.3. It can change what
`token-counting.ts`, `privacy-filter.ts`, `kompress.ts`, and request transforms
observe; a base64-looking text block would be miscounted unless original bytes
are restored before every consumer. Reopening Phase 3 therefore requires both
measurements and a schema-aware design, not merely a longer-string threshold.

### 9.3 Refs are restricted to explicit inline-binary positions

Only the exact §5.4 allowlist is permitted. It covers Claude base64 images and
documents, OpenAI Chat Completions images/audio/files, all Gemini inline-data
MIME types, and OpenAI Responses images/files/inline skill ZIP bundles. No
generic long-base64 detection and no extraction based only on a field named
`data`, `url`, or `file_data`.

Rejected: allowing refs anywhere with rehydration before text passes. That
larger memory win would catch pasted artifacts and arbitrary strings, but any
text-inspecting pass that forgets to rehydrate would silently miscount — a
failure mode invisible in output. Adding a new binary schema requires a new
explicit predicate and consumer/round-trip tests.

**Accepted limitation:** large text and custom fields outside the allowlist
remain O(B) per materialized body and O(N×B) in aggregate, with full parse/
`JSON.stringify` transients and no proxy body-concurrency cap. Effective/attempt
spills back subsequent network I/O, and no full non-ref body is retained in an
SSE closure. They also receive content-agnostic ingress spooling and identity
passthrough streaming. Larger L1/L2 caches do not change this non-ref cost.

### 9.4 Phase 0 timing — **hold, ship as one change**

The four zero-storage fixes do not ship ahead of Phases 1–2; all memory work is
reviewed as one unit. Consequence accepted and recorded in the header: the
current multi-copy peak stays in production in the meantime.

### 9.5 Response spooling — **per finite body/event, in scope**

Large non-SSE JSON responses and individual large SSE events are spooled under
`max_response_bytes`, fully parsed when required without a body semaphore, and
streamed to the client with downstream backpressure. Response blobs are deleted after delivery and do
not enter the cross-request cache by default.

Rejected: accumulating an entire SSE response on disk before forwarding. That
would delay ordinary events, grow disk usage with stream duration, and still
leave ordering/abort semantics unclear. Also rejected: spooling while leaving
`tee()`, unconditional `enqueue`, or ignored socket backpressure in place,
because those queues can continue growing in RAM independently of disk usage.

---

## 10. Tests

Per repo rule #7, each test asserts a property, not "did not throw". Use bodies
above the spill threshold but within the configured request cap unless the test
specifically exercises rejection.

- **Ingress, slow client:** POST a large body with chunk delays; assert (a) the
  handler receives byte-identical content (compare hash), (b) heap/external
  buffer growth is bounded by configured stream buffers rather than body size,
  and (c) the spool file is removed after the last reader finishes.
- **Threshold crossing with unknown length:** a chunked body starts below and
  ends above the threshold; assert the spilled prefix plus suffix hash-equals
  the input and no byte is dropped during the memory-to-file transition.
- **Ingress caps:** body past `max_request_bytes` → `413`, no upstream call;
  aggregate spill reservations past `max_total_bytes` produce the documented
  explicit error and return to baseline after completion/abort.
- **Concurrent traffic and cache sizing:** run many large binary and non-ref
  requests/responses/events with §5.9 disabled. Assert there is no admission
  queue, binary bodies become small ref skeletons after extraction, and full-
  parse/non-ref O(N×B) memory is reported honestly. Measure L1/L2 hit and
  eviction rates under increased `max_blob_cache_bytes`/`max_blob_disk_bytes`;
  do not treat larger caches as a parse-memory bound.
- **Optional materialization admission:** with a small
  `max_materialized_body_bytes` and known `materialization_factor`, assert no
  read/parse begins before reservation and nominal admitted bytes never exceed
  the budget. Binary bodies release after extraction; non-ref bodies retain
  admission through delayed sidecars and effective/attempt/egress-spool writes,
  then release before network streaming. Cover per-rung reacquisition, responses,
  and SSE events. Queue excess work in arrival order, pause upstream event reads,
  and assert timeout/overflow returns explicit `429`/`503` before headers. Abort,
  failure, and restart must remove waiters/release reservations exactly once;
  queued spills remain under `max_total_bytes`.
- **Raw/effective body lineage:** after early `Request` reconstruction, assert
  the raw `SpoolRef` remains available for identity passthrough. Then use a
  body containing PII, compressible text, two tools, and a binary payload; apply
  privacy, kompress, and tool erase before two ladder rungs. Assert every
  converted upstream body inherits all three mutations, the original PII is
  absent, and the binary bytes still match the baseline. Instrument spool reads
  to prove converted rungs never reconstruct from the raw spool; when disk-
  backed effective state is required, assert they read the effective spool.
- **Rung isolation and shared leases:** give two rungs different model rewrites
  and `request_ingress` mutations. Assert both start from the same effective
  body and rung A's mutations are absent from rung B. Every cloned BlobRef keeps
  the same `leaseId`; `retain()` increments `refs` before the attempt can read,
  each attempt releases exactly once, and no intermediate release can reach
  `refs = 0` while the effective body or another attempt still owns a ref.
  Assert no binary reread into memory. Identity passthrough alone hash-equals
  the raw client body.
- **Effective-spool serialization:** for a large non-ref body, assert
  `JSON.stringify(effectiveBody)` runs exactly once after global mutations, the
  effective spool contains that exact string, and the transient string is
  released after the write. Assert per-rung parses read the effective spool and
  inherit all mutations.
- **Non-ref attempt-spool send:** for a large non-ref converted rung, assert
  parsing/conversion/`JSON.stringify` produce an attempt spool containing the
  final body. Then delay the upstream read and assert full objects/strings are
  collectible before the wait and upstream bytes hash-equal the in-memory
  baseline. Repeat for a large non-ref response/event and verify the client
  write starts only after the same object release.
- **Disk failure:** spool directory made unwritable mid-run on request and
  response paths → explicit failure and log line, with no truncated body
  forwarded upstream or to the client.
- **Egress, slow upstream:** upstream reading at 1 KiB/100 ms; assert forwarded
  bytes hash-equal the in-memory case. If `Content-Length` is present it is
  exact; otherwise no stale length is forwarded.
- **BlobRef lease outlives idle TTL:** with a fake clock and `ttl_seconds = 600`,
  keep an upstream POST and a downstream response/event write alive for 1200
  seconds, including a no-byte-progress interval above 600 seconds. Assert the
  lease renews, L2 eviction does not delete the blob, no `ENOENT` occurs, and
  forwarded bytes hash-equal the baseline. After the final release, assert an
  idle cache blob expires normally and a response/event scratch blob is deleted.
- **Lease release and failure:** abort upstream and downstream writes; assert
  renewal stops, every lease is released, and cleanup occurs after handles
  close. Inject renewal failure or remove a leased file; assert the exchange
  fails explicitly and no partial/empty payload is substituted.
- **Failure after response streaming begins:** after a partial non-SSE body or
  an initial SSE event reaches the client, inject renewal, disk, and parse
  failures. Assert the client observes a connection abort, an error log contains
  request ID and stage, no success/`[DONE]` terminator is emitted, upstream reads
  and file readers are cancelled, every shared-lease ref is released exactly
  once, handles close before deletion, spills/scratch blobs are
  removed, and the active-request counter returns to baseline. Inject the same
  failures before headers and assert an explicit non-2xx response instead.
- **L2 disk cap and RAM index:** with a small `max_blob_disk_bytes`, insert
  enough blobs to exceed it. Assert the index's `size` sum and actual current-
  process L2 bytes stay within the cap, `refs = 0` entries evict in LRU order,
  `refs > 0` entries remain readable without `stat`-based index reconstruction,
  and lease release updates `refs`. When all entries are leased and no bytes
  can be freed, assert the new cache write fails explicitly without exceeding
  the cap or deleting an active blob.
- **Binary allowlist round-trip matrix:** exercise every §5.4 predicate with a
  payload above the spill threshold: Claude image and base64 PDF; Chat
  Completions image, audio, and file; Gemini image/audio/video/PDF in both
  `inline_data` and `inlineData` spellings; Responses image, file, and inline
  skill ZIP. For each, assert a ref replaces the inline payload, the original
  data-URL prefix/metadata survives where applicable, and streamed upstream
  bytes equal the in-memory conversion baseline. Run the applicable SSE and
  non-SSE variant, including Gemini `:streamGenerateContent` and
  `/v1/interactions`.
- **`auth_with_body` link projection:** for every §5.4 binary predicate, assert
  the auth body contains a valid `external_blob` link with matching hash/size/
  media type and no inline base64, while its text/tools reflect the final
  sidecar mutations. Have the auth service fetch and verify the object, then
  assert the upstream still receives the original inline binary bytes. Without
  an uploader, assert legacy full-body auth remains unchanged.
- **Auth-link lease and failure:** keep upload/auth fetch alive beyond the idle
  TTL and assert renewal prevents deletion while retaining only the small ref
  skeleton. Inject upload, URL, auth-fetch, and hash-verification failures; assert
  no upstream call and explicit errors. Assert signed URLs are redacted from
  logs, external deletion/lifecycle cleanup is scheduled, and restart never
  reuses an external object as recovery/cache state.
- **Converted SSE lifetime:** parameterize over the binary families and
  converted endpoints above. Let the upstream request finish, then keep the
  SSE response open with delayed events. Assert non-binary usage follows the
  existing estimator, each binary contribution is exactly
  `Math.ceil(base64CharLength / charactersPerToken)` with no fixed block
  metadata, and upstream-reported usage wins when present. The stream
  transformer owns scalar token metadata/refs, not `requestBody` or its base64
  strings. Take a mid-stream heap profile as integration evidence; a unit test
  of the transformer API alone is not enough.
- **Passthrough SSE lifetime:** hold an identity SSE response open with each
  binary family and verify the parsed request is collectible after the schema
  gate and scalar metadata extraction while response forwarding continues
  correctly.
- **Non-SSE response binary round-trip:** return Gemini `inline_data`/
  `inlineData` output and an OpenAI Responses `image_generation_call.result`
  above the response threshold. Assert client bytes equal the in-memory
  conversion baseline, response blobs do not enter the request cache, and all
  response spills/blobs are deleted after delivery. A body above
  `max_response_bytes` fails explicitly without truncated client output.
- **SSE binary event spooling:** send ordinary events before and after a large
  Gemini inline-data event and a large Responses image-generation event.
  Assert event order and bytes are preserved, only the large event is spilled,
  no whole-stream spool exists, per-event files are deleted after the client
  write, and ordinary events do not wait behind an unbounded RAM queue.
- **Downstream backpressure:** pause the client while upstream continues to
  produce data. Assert Node/socket and web-stream queues stay bounded, upstream
  reads pause after configured buffers fill, and resuming causes no dropped or
  reordered bytes. Cover logging, keep-alive injection, converted streams, and
  the Node adapter; no logging-only `tee()` remains.
- **Predicate negatives and scope boundary:** Claude plain-text/URL documents,
  remote image URLs, file IDs, Gemini `fileData`, non-ZIP skill sources, large
  text, unknown base64-looking fields, and response fields that merely reuse a
  request-side field name must not become refs. Assert their forwarded values
  are unchanged; non-allowlisted large fields remain O(B) after parse.
- **Token round-trip (Phase 3):** body containing a long base64-looking *text*
  value → forwarded bytes hash-equal input.
- **Restart is discard-only:** seed request/response/event spills and blobs
  from a previous process, then restart. Assert the L2 index is empty, no disk
  scan/deserialization reconstructs it, no old body/event is parsed or
  forwarded, no old blob produces a cache hit, and no client/upstream exchange
  is resumed. An orphan older than the age threshold is removed; a freshly
  written file belonging to a concurrently active worker is not removed.
- **Platform:** on win32, the spool path never uses the unlinked-fd strategy and
  deletion occurs only after handles close.
- **tmpfs detection:** a spool dir on tmpfs produces the startup warning.

Test-process hygiene: locate with `pgrep`/`lsof` then `kill`; no `pkill` (repo rule #7).

---

## 11. Out of scope

- Cross-process or cross-instance sharing of the blob store.
- Generic refs for large text, custom fields, or other positions outside the
  explicit §9.3 request and §5.7 response inline-binary allowlists.
- Any change to `image_encode` sidecar semantics (`src/utils/image-fetch.ts`);
  if anything, the sidecar is the natural place to *produce* blobs instead of
  base64.

---

## 12. Verification checklist before this stops being a draft

Decisions are recorded (§9); what remains is evidence.

- [x] `§9.1`–`§9.5` decided and recorded (2026-11-02).
- [ ] Combined Phases 0–2 change landed, with before/after memory and latency
      numbers for slow upload, upstream request send, downstream JSON response,
      and long/large-event SSE response.
- [ ] Heap/allocation profile confirms or corrects §2's copy inventory.
- [ ] Mid-stream SSE profiles show no full request body retained on supported
      converted paths; non-binary accounting is unchanged and binary usage uses
      the documented payload-length estimate with upstream usage preferred.
- [ ] Paused-client tests prove bounded response queues and upstream read
      backpressure across logging, keep-alive, converters, and the Node adapter.
- [ ] Mid-stream renewal/disk/parse failure tests prove client connection abort,
      error logging, upstream cancellation, and complete lease/spill cleanup
      without a false success terminator.
- [ ] Every §5.4 request predicate has round-trip and mid-stream retention
      evidence; every §5.7 response predicate has completed-JSON and applicable
      SSE-event round-trip/cleanup evidence. Non-ref tests separately report
      ungated O(N×B) processing and prove object release before network I/O.
- [ ] Optional §5.9 tests prove pre-parse byte reservation, binary early release,
      non-ref retention through serialization, bounded queue/timeout, abort and
      failure cleanup, and no admission held during network/SSE streaming.
- [ ] §5.8 auth-link tests prove post-sidecar auth content, binary-free auth
      projections, unchanged upstream inline bytes, lease renewal, failure
      handling, URL redaction, and external-object cleanup.
- [ ] `CHANGELOG.md` + `README.md` updated in the same change as any
      implementation, per the repo's documentation rule.
