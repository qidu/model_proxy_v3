# Design: `/passthrough` Working Mode

Status: draft / for review
Scope: verbatim relay of `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/interactions`, and Gemini `:generateContent` to config-declared upstreams, streaming and non-streaming

---

## 1. Problem

The proxy's normal routes are *transforming*: a client request is converted to the
upstream's schema, aliased to a target model id, run through composite / schedule /
transform logic, and converted back. That is the right default, but it is wrong for
two cases:

- a client that already speaks the upstream's exact dialect and wants the bytes
  forwarded unchanged (no conversion, no alias rewrite, no injected fields), and
- a caller that wants to pin a request to a *specific* upstream provider, chosen
  by API family rather than by model name.

Today the only way to reach a raw upstream is the `/http/<host>/...` dynamic route
(`src/index.ts:372`), which is unrestricted by mode and carries no per-target key.

## 2. Goal

Add a `/passthrough` prefix that relays a request **verbatim** — body, query
string, and endpoint path untouched — to an upstream selected from a
`[passthrough]` config table by API family. The proxy supplies only `base` and
`key`; it performs no schema conversion whatsoever. Both SSE streaming and
non-streaming responses are relayed as-is.

## 3. Semantics

```
POST /passthrough/<upstream-path>
```

The `/passthrough` prefix is stripped and `<upstream-path>` is appended to the
chosen target's `base`. The body and query string are forwarded as received.

### 3.1 Endpoint → mode map

Mode is a function of the pathname only (after stripping `/passthrough`),
matched exactly for fixed paths and by pattern for the Gemini action paths:

| pathname | mode | match |
|---|---|---|
| `/v1/chat/completions` | `openai-completions` | exact |
| `/v1/messages` | `anthropic-messages` | exact |
| `/v1/messages/count_tokens` | `anthropic-messages` | exact |
| `/v1/responses` | `openai-responses` | exact |
| `/v1/interactions` | `gemini-interactions` | exact |
| `/v1/models/{model}:generateContent` · `/v1beta/models/{model}:generateContent` | `gemini-generatecontent` | pattern |
| `/v1/models/{model}:streamGenerateContent` · `/v1beta/models/{model}:streamGenerateContent` | `gemini-generatecontent` | pattern |

The action paths match `^/(v1beta|v1)/models/([^:?]+):(stream)?[Gg]enerateContent$`
(mirrors the existing route regex at `src/index.ts:501`). `{model}` is carried
through verbatim into the upstream path — passthrough does not rewrite it, and
the client's chosen version prefix (`v1` or `v1beta`) is part of that path.

`/v1/messages/count_tokens` shares the `anthropic-messages` gate (§5): its body
(`ClaudeTokenCountingRequest`, `src/types/claude.ts:139`) also requires
`messages`. Paths are matched exactly, so this row is required — it is not
covered by the `/v1/messages` row.

A path with no mapping, or a path outside `/passthrough/*`, is rejected with
**404**.

### 3.2 Why the endpoint decides, not the schema

Anthropic Messages and OpenAI Chat Completions share the same required core —
`{model, messages}`. The repo's own validators confirm this:
`validateOpenAICompletionsRequest` (`src/utils/validation.ts:439`) and
`validateClaudeMessagesRequest` (`src/utils/validation.ts:14`) both accept a body
of `{model, messages:[…]}`. So no schema rule can separate the two families
without false-rejecting valid traffic. The endpoint is the authoritative signal;
the schema is only a consistency gate (§5).

### 3.3 Query string

Preserved verbatim, including `?alt=sse`. Passthrough does **not** inject
`alt=sse` on the `:streamGenerateContent` path — the client controls it. A client
that omits it gets whatever the upstream returns by default.

## 4. Config

```toml
[passthrough]
a = {base = "https://api.example.com",   key = "sk-aaa", mode = "anthropic-messages", share = 3, timeout = 600000}
b = {base = "https://other.example.com", key = "",       mode = "anthropic-messages", share = 1}
c = {base = "https://third.example.com", key = "sk-ccc", mode = "openai-completions"}
d = {base = "https://gemini.example.com", key = "g-key", mode = "gemini-generatecontent"}
```

Each entry is a named target.

| field | required | meaning |
|---|---|---|
| `base` | yes | upstream base URL; the request path is appended |
| `key` | no | upstream credential; when empty the caller's key is forwarded (§7) |
| `mode` | yes | API family this target serves; one of `UPSTREAM_MODES` (`src/utils/upstream-modes.ts:9`) |
| `share` | no | relative weight for random selection among same-mode candidates (default `1`) |
| `timeout` | no | per-entry upstream timeout in ms; falls back to the env default (§6) |

Field names accept the same short aliases as the `[models.*]` inline-table form
(`src/utils/config-loader.ts:2836`): `base` / `base_url` / `url`, `key` /
`api_key`, `mode` / `upstream_mode`.

An unknown `mode`, a missing `base`, or an empty entry name is a load-time error.

## 5. Selection rule

```
mode  := MODE_FOR_PATH(path)            # map in §3.1; nil when unmapped
if mode is nil                        -> 404    # endpoint not servable
cands := [ t in config.passthrough if t.mode == mode ]
if cands is empty                     -> 404    # no target serves this mode
body  := parse(request.body)            # unparseable JSON -> 400
if not schemaMatches(mode, body)      -> 400    # endpoint and body disagree
target := weightedPick(cands, by: share)
```

The two failure modes are split deliberately:

- **404** — the capability does not exist: the endpoint has no mode mapping, or no
  configured target declares that mode.
- **400** — the capability exists but the request is malformed: the body does not
  match the endpoint's schema, or the body is not valid JSON.

`schemaMatches` uses each mode's positive core marker — cheap, and true for every
valid body of that family:

| mode | body shape required |
|---|---|
| `openai-completions` | `Array.isArray(body.messages)` |
| `anthropic-messages` | `Array.isArray(body.messages)` |
| `openai-responses` | `body.input` is a string or array |
| `gemini-interactions` | `body.input` is a string, object, or array (`src/types/gemini.ts:209`) |
| `gemini-generatecontent` | `Array.isArray(body.contents)` |

What the gate catches: a Responses body (`input`, no `messages`) sent to
`/passthrough/v1/messages`, or a messages body sent to `/passthrough/v1/responses`
→ 400.

What it deliberately does **not** catch: an Anthropic body sent to
`/passthrough/v1/chat/completions`. Both carry `messages`, so it forwards and the
upstream returns 400. That is the honest outcome — passthrough's contract is
"don't second-guess me" (§3.2).

When several entries share a mode and pass the gate, one is chosen at random with
probability proportional to its `share` (entries that omit `share` count as `1`,
so an all-default candidate set is a uniform pick).

## 6. Request flow

Handled as an early branch in `src/index.ts` `fetch()` — placed **before** the
model-routing block (`src/index.ts:1236`) so the request never enters the
composite / schedule / transform machinery:

1. `isPassthroughRoute(path)` — strip the `/passthrough` prefix to get
   `upstreamPath`; preserve the query string.
2. Read the raw body text once; parse a copy for the §5 schema gate.
3. Resolve the mode (§3.1) and select `target` (§5).
4. **Remote auth gate** — run the `[remote].auth_server` check explicitly
   (§8.1), since the branch sits ahead of the deferred-auth call sites.
5. Build the upstream URL by **plain join** (§11.12): `targetUrl :=
   stripTrailingSlash(target.base) + '/' + upstreamPath`, then append the query
   string. `buildUpstreamUrl` (`src/utils/routing.ts:255`) is **not** used — its
   heuristics rewrite the client's path.
6. Build headers: `addForwardedHeaders(...)` (`src/utils/routing.ts:565`),
   `Content-Type: application/json`, plus auth (§7).
7. `fetch(targetUrl, { method, headers, body: rawBodyText,
   signal: createUpstreamAbortSignal(target.timeout ?? getUpstreamBodyTimeoutMs(env)) })`.
8. **Remote usage recording** — non-streaming JSON responses only (§8.2).
9. Return the upstream `Response` unchanged. The response body is never
   re-serialized, so both cases are transparent: `server.ts` pipes
   `text/event-stream` straight through, and a non-streaming JSON body is
   forwarded as received. No SSE special-casing is required.

## 7. Auth

The target's `key` is formatted for the mode via the existing
`formatApiKeyForUpstream` (`src/utils/routing.ts:496`): `x-api-key` for
`anthropic-messages`, `x-goog-api-key` for the two Gemini modes,
`Authorization: Bearer` otherwise.

When `key` is empty, the caller's inbound auth headers are forwarded verbatim
(`extractAuthHeaders`) — the proxy holds no credential for that target and
passes the caller's through.

## 8. Remote pipeline (`[remote]`)

### 8.1 Auth (`auth_server`)

The credential-presence check (`src/index.ts:940`) and the immediate
`auth_server` call (`src/index.ts:1075`) both sit *before* the passthrough branch,
so they apply unchanged. The **deferred** auth call — used when
`auth_with_model` or `auth_with_body` is set — runs at `src/index.ts:1324` and
`1724`, i.e. *after* the branch point, so passthrough must invoke `doAuthRequest`
itself (§6 step 4). Skipping it would leave a fail-CLOSED gate fail-OPEN for
passthrough traffic.

- `x-resource-for`: pass `body.model` — passthrough resolves no model id, but the
  request body still carries one.
- `endpoint`: the auth sidecar receives the raw client path
  (`/passthrough/v1/messages`), not the stripped upstream path.

For passthrough the auth server is a **pure gate**: 200 → forward, non-200 →
reject. It returns no `targets[]`, so the failover ladder
(`src/index.ts:1052-1069`) never applies and the target always comes from
`[passthrough]` (§5) — no conflict with §5's selection.

The 200 body must still satisfy the wire-contract gate
(`hasRequiredProtocolVersion`, `src/utils/target-retry.ts:101`): a JSON object
carrying a non-empty `version` string. An empty, non-JSON, or version-less body
is rejected with 401 even though the status was 200. This gate is shared with the
normal routes, so it is not new behavior — but "returns 200" alone is not
sufficient.

### 8.2 Usage stats (`record_server`)

`recordModelUsageToRemote` is called only inside `runAttempt`
(`src/index.ts:2391`, `2419`, `2461`), which passthrough bypasses. To keep
`record_server` coverage, passthrough records its own usage:

- model id — `body.model` (no resolution occurs).
- non-streaming: parse the response JSON, `extractUsageFromResponsePayload`,
  then `recordModelUsageToRemote`. `record_response_body` applies as usual.
- streaming: **tee the body** (below).

#### Streaming tee

`response.body.tee()` yields `[clientStream, usageStream]`. The client branch is
returned unchanged; the usage branch is drained by a detached async task that
parses SSE frames and, on stream end, calls `recordModelUsageToRemote`. This
mirrors the existing tee-to-log pattern (`src/handlers/chat-completions.ts:492`,
`src/handlers/responses.ts:1588`) but feeds the recorder instead of the logger.

Frame handling — split on `\n\n`, take the `data:` payload, `JSON.parse`, then:

```
extractUsageFromResponsePayload(frame)
  ?? extractUsageFromResponsePayload(frame.response)
```

The first form covers Claude (`message_start` / `message_delta`), OpenAI
(usage-bearing final chunk), Gemini (`usageMetadata`), and Interactions. The
second covers the Responses API, whose `response.completed` event nests usage
under `response`. Both are the existing helper
(`src/utils/dashboard-stats.ts:1250`), so no new usage-shape parsing is needed.

`createUsageTrackingTransformStream` (`src/utils/dashboard-stats.ts:1472`) is
**not** reused: it keys on Anthropic `event: message_start` / `message_delta`
frames and would miss the other four modes.

Caveats:

- **Verbatim is preserved** — the tee does not alter the client branch.
- **Best-effort by nature** — if the client disconnects mid-stream the usage
  branch ends early, so no or partial usage is recorded. The call is
  fire-and-forget, as in the normal path.
- **OpenAI Completions usage may be absent.** The normal route force-injects
  `stream_options.include_usage: true`; passthrough must not (verbatim), so a
  client that omits the flag gets no usage chunk and nothing is recorded.
  Claude, Responses, and Gemini emit usage unconditionally.
- **Gemini non-SSE streams.** `:streamGenerateContent` without `alt=sse` returns
  a JSON array stream, not SSE — the frame parser will not match it, and no usage
  is recorded for that form.
- **`record_response_body` on a stream** buffers the entire SSE body in memory
  (the existing transform's `collectBody` flag, `src/utils/dashboard-stats.ts:1476`).
  Decide whether to enable it for streams.
- The recorder fires when the stream ends, i.e. after the response has already
  been returned to the client.

### 8.3 Dispatch (`dispatch_server`)

Inert today — parsed into `remote_dispatch_active`
(`src/utils/config-loader.ts:3399`) and surfaced on the dashboard, but not
invoked at runtime (`src/utils/target-retry.ts` references it only in a doc
comment). Nothing for passthrough to preserve.

## 9. Guardrails and integration points

- **SSRF** — add every `[passthrough].*.base` host to
  `getAllowedHostsFromConfig` (`src/utils/config-loader.ts:2406`), mirroring the
  `/http/` dynamic-route treatment. **Widen the shared list; do not keep a
  passthrough-only allowlist (§11.13).** Accepted consequence: that function is
  consumed only by the `/http/<host>/…` dynamic route
  (`src/index.ts:1709-1711`), so a passthrough base host also becomes reachable
  through `/http/`. This matches how `[models.*].base_url` hosts are already
  treated — the allowlist has never been scoped per-feature.
- **Config plumbing** — add `passthrough?: Record<string, PassthroughTargetConfig>`
  to `ProxyConfig` (`src/utils/config-loader.ts:24`); add a
  `parts[0] === 'passthrough'` section branch and an inline-table entry parser to
  `parseSimpleToml` (`src/utils/config-loader.ts:2629`), following the
  `[models.*]` inline-table pattern; add serializer support so
  `/config-reload` dumps round-trip.
- **Validation** — reject unknown `mode` / missing `base` / non-positive `share`
  at load time, loud (CLAUDE.md §8). Warn when a target's `mode` is not reachable
  from any endpoint in §3.1 (dead config). Also warn when a `base` already ends
  in a version segment (`/v1`, `/v1beta`) or a known endpoint path — with the
  plain join (§6 step 5) that suffix is kept and the client's version prefix
  appended after it, so `base = …/v1` + `/passthrough/v1/messages` reaches
  `…/v1/v1/messages`. The `base` must be a bare origin (optionally with a path
  prefix), not an endpoint.
- **Docs** — add the section to `proxy_config.example.toml` and the endpoint
  tables in `README.md`.

## 10. Deliberately bypassed

Because the relay is verbatim, `/passthrough` does **not** apply:

- model routing / alias rewriting (no model id is resolved),
- composite / schedule / fusion,
- `[transforms.*]` hooks,
- privacy filter and kompress,
- tool blocklist,
- any schema converter,
- per-model token stats keyed by a resolved model id (§8.2 substitutes
  `body.model`).

CORS, request logging, upstream status recording, the timeout abort signal, the
`[remote].auth_server` gate, and non-streaming `[remote].record_server` usage
recording still apply (§8). Privacy-filter and kompress remain bypassed by
design — they would rewrite the body, which contradicts the verbatim contract.

## 11. Resolved decisions

1. Empty `key` → forward the caller's key verbatim (§7).
2. Any `/passthrough/*` is routed; a path with no mode mapping → 404 (§3.1).
3. Random selection is weighted by the per-entry `share` field, default `1` (§5).
4. A per-entry `timeout` override is supported, falling back to the env default (§6).
5. Both SSE and non-streaming responses are relayed as-is (§6).
6. Endpoint/body disagreement → **400**; unmapped endpoint or unserved mode → **404** (§5).
7. The endpoint set includes `/v1/interactions` and the Gemini
   `:generateContent` / `:streamGenerateContent` action paths, under both the
   `v1` and `v1beta` version prefixes (§3.1).
8. `/v1/messages/count_tokens` maps to `anthropic-messages` (§3.1).
9. `[remote].auth_server` still gates passthrough; `[remote].record_server`
   still records non-streaming usage (§8).
10. The auth server is a pure allow/deny gate for passthrough — it returns no
    `targets[]`, so the failover ladder never applies (§8.1).
11. Streaming usage is recorded via a body tee, using the existing
    `extractUsageFromResponsePayload` helper (§8.2).
12. **Plain join, not `buildUpstreamUrl`.** The upstream URL is
    `stripTrailingSlash(target.base) + '/' + upstreamPath` (query appended), so
    `http(s)://<proxy-url>/passthrough/v1/...` maps 1:1 onto
    `http(s)://<configured-base-url>/v1/...`. `buildUpstreamUrl`'s
    full-endpoint short-circuit (`src/utils/routing.ts:262`) and version-dedupe
    (`src/utils/routing.ts:281`) both rewrite the client's path — the
    version-dedupe would turn a client `v1` request into `v1beta` for a
    `…/v1beta` base — which contradicts the verbatim contract. `base` is
    validated to be a bare origin/path prefix, not an endpoint (§9).
13. **Passthrough hosts widen the shared SSRF allowlist.** `[passthrough].*.base`
    hosts are added to `getAllowedHostsFromConfig` (§9) rather than to a separate
    passthrough-only list. Accepted consequence: those hosts also become
    reachable via the existing `/http/<host>/…` dynamic route, consistent with
    how `[models.*].base_url` hosts are already treated.

## 12. Open

None outstanding.
