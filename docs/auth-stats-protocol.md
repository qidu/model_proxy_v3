# Auth & Stats Service Protocol

The proxy talks to two optional remote services over plain HTTP. This document
records the exact wire-level contract for each, so an operator can implement
a compatible auth/stats backend in any language. For the high-level overview and
sequence diagram, see [Proxy ↔ remote auth & stats service](../README.md#proxy--remote-auth--stats-service)
in the README.

## Auth service — `[remote.authentication] auth_server`

**When**: before routing (every non-exempt model-API request). Exempt paths:
`/health`, `/`, `/dashboard`, `/v1/models`.

**Timing**:
- `auth_with_model = false` (default) → auth runs **before** the request body is
  parsed.
- `auth_with_model = true` → auth runs **after** body parsing, so the requested
  model id is known and forwarded as `x-resource-for`. Required for the dynamic
  routing override (the proxy needs the override before resolving the route).
- `auth_with_body = true` → auth also runs **after** body parsing, and the entire
  parsed request body is forwarded to the auth service as the `POST` body (raw
  JSON, not base64). Either `auth_with_model` or `auth_with_body` defers auth
  until the body is available. On endpoints where the proxy does not parse a
  body (e.g. dynamic routes), `auth_with_body` has no body to send and degrades
  to a bodyless call.

**Ordering vs. model resolution.** Under every configuration the auth call
precedes route resolution — `getModelRouteConfig()`
(`src/utils/config-loader.ts:1037`) never runs before `doAuthRequest()`
(`src/index.ts:973`, `fetch` at `src/index.ts:999`). Only the position within
the request shifts:

| Flags | Call chain |
|---|---|
| default (both `false`) | `loadProxyConfig` (`index.ts:748`) → header presence check (`index.ts:948`) → **`doAuthRequest()` (`index.ts:1038`)** → body parse (`index.ts:1198`) → `modelName = body.model` (`index.ts:1248`) → **`getModelRouteConfig()` (`index.ts:1285`)** |
| `auth_with_model` and/or `auth_with_body` | body parse (`index.ts:1198`) → `modelName = body.model` (`index.ts:1248`) → `resolveScheduleTarget()` (`index.ts:1264`) → **`doAuthRequest()` (`index.ts:1275`)** → **`getModelRouteConfig()` (`index.ts:1285`)** |

`doAuthRequest` has three mutually exclusive call sites: the early one above,
the deferred body path (`index.ts:1274`), and a deferred fixed-routing fallback
for endpoints with no parsed body (`index.ts:1670`).

**`x-resource-for` carries the client's model id, not the target.** By design,
remote auth authorizes on the model id **as it appeared in the user's original
request** — the alias, never the resolved upstream `target`. This keeps
authorization independent of routing config, so retargeting an alias or adding
a wildcard never silently changes who is authorized. `x-resource-for` is set at
`src/index.ts:986`.

The one exception is a **schedule alias**, which is resolved one hop before auth
(`resolveScheduleTarget`, `src/index.ts:1264`, ahead of the deferred auth call
at `:1275`): the sidecar then sees the target that alias selects for the current
time-of-day, not the name the client sent. For every other alias kind —
exact-match, wildcard, catch-all, composite/fusion — the client's literal string
is forwarded unchanged, including model ids that match nothing in config. A
sidecar matching `x-resource-for` against a known-model list therefore needs an
explicit policy for unrecognized ids, and must tolerate the header being absent
entirely (the two bodyless call sites, `index.ts:1038` and `:1671`, never send
it, and it is omitted whenever no model id could be extracted).

The resolved target is never sent to the auth service. It reaches the backend
only afterwards, as the stats record's `model` field.

**Two independent credential systems.** The remote auth call is a *global
inbound gate*: it validates the **client's** headers against `auth_server`, and
is not per-provider, so it carries no ordering dependency on resolution.
Upstream/per-provider credentials are selected separately and necessarily
*after* resolution — `transformAuthHeadersForUpstream()` (`src/index.ts:1335`),
then the route's own key via `formatApiKeyForUpstream(modelRoute.apiKey, …)`
(`src/index.ts:1340`, guarded at `:1339`), which takes effect when
`auth_passthrough_with = 'config_key'` or the route's section is `free`. That selection is a local
config lookup with **no network call**. So `auth_with_model` exists only so the
auth sidecar can see which model is requested (quota/entitlement decisions and
the dynamic routing override) — not because the proxy needs the resolution
result in order to authenticate.

**No auth-result caching.** `doAuthRequest` fires on every non-exempt request;
there is no memoization, so the ordering above is the effective ordering every
time. There is no OAuth or token-refresh path anywhere — `src/utils/key-store.ts`
holds static config values. The one outbound call that *can* precede auth is a
config fetch: on a cold `cachedConfig` (`config-loader.ts:2438`),
`loadProxyConfig` may hit Apollo (`config-loader.ts:2476`) or Consul first.

**Request** (proxy → auth service):

| Aspect | Value |
|---|---|
| Method | `GET` by default; switches to **`POST`** when `auth_with_body = true` and a parsed body is available |
| URL | `auth_server` as configured |
| Redirects | followed |

Headers forwarded (each only if the client sent it):

| Header | Source |
|---|---|
| `Authorization` | client's `Authorization` |
| `x-api-key` | client's `x-api-key` |
| `x-goog-api-key` | client's `x-goog-api-key` |
| `user-agent` | client's `User-Agent` |
| `request_id` | proxy-generated request id |
| `endpoint` | inbound request path (e.g. `/v1/messages`) |
| `x-resource-for` | requested model id — **only when `auth_with_model = true`** |
| `x-forwarded-for` | resolved client IP (`cf-connecting-ip` → `x-forwarded-for`[0] → `x-real-ip`). Always sent when a client IP is detectable. |
| `x-real-ip` | resolved client IP — **only when the caller did not already send `x-real-ip`** (an explicit outer-proxy value is preserved). |
| `Content-Type` | `application/json` — **only on the `POST` form** (`auth_with_body = true` with a parsed body). Absent on the default `GET`. |

When `auth_with_body = true`, the `POST` body is the **raw parsed request JSON**
(post privacy-filter / kompress / tool-blocklist rewriting, so the auth sidecar
never sees redacted PII). The body is not base64-encoded — it is sent as
parseable JSON so the sidecar can inspect fields directly.

**Response** (auth service → proxy):

| Status | Proxy behavior |
|---|---|
| `200` | Auth passes; proceed to routing. |
| any `4xx` / `5xx` | Proxy returns `401 Authentication failed.` to the client. |
| network error | Proxy returns `503 Authentication service unavailable.` to the client. |

On `200`, the proxy reads:

- **Header `one_time_auth_code`** (OTAC, optional) — stored and re-sent as the
  `one_time_auth_code` header on the later stats `POST record_server` call (see below).
- **JSON body** (optional) — the **dynamic routing override**, a one-time alias
  config entry. See the table in [Proxy ↔ remote auth & stats service](../README.md#proxy--remote-auth--stats-service).

**Dynamic routing override precedence.** When the auth response body carries
any of `target` / `mode` (`upstream_mode`) / `base` (`base_url`) / `key`
(`api_key`) / `transforms`, the proxy treats them as the resolved route for
**this request only**:

1. The override fields are merged on top of the normal inheritance chain
   (per-entry → section → `[default_upstream]`). Auth-provided fields win over
   config-file fields for the same request.
2. If the override supplies a `target`, the upstream sees that model id and the
   proxy skips `[models.*]` / `[composite]` / `[schedule]` resolution entirely.
3. If the override supplies `transforms`, those `[transforms.*]` sets are
   applied at the same five lifecycle hooks as config-attached sets.
4. If the body is empty / not JSON / not a `200`, normal config resolution
   proceeds unchanged.

The override is **never cached** and **never persisted** to `proxy_config.toml`
— it is a single-use, per-request alias.

## Stats service — `[remote.recording] record_server`

**When**: after the upstream response is received, once token usage is known.
For streaming (`text/event-stream`) responses, usage is extracted from the SSE
final event and the record is POSTed when the stream closes. For JSON
responses, it is POSTed immediately after parsing. The POST is fire-and-forget
(non-blocking); failures are logged at `WARN` and do not affect the client
response.

**When (with `record_response_body`)**: `[remote.recording] record_response_body = true` (default `false`)
adds the **entire constructed response body** to each usage record. For JSON
responses this is the parsed response object; for streaming (`text/event-stream`)
responses this is the accumulated raw SSE text (all events concatenated,
captured as the stream flows through to the client, and POSTed once the stream
closes). The body is sent raw (not base64) as a JSON value, so the collector
can inspect it directly. When `record_response_body = false` (default), the field is
omitted entirely.

**Non-2xx responses are recorded too.** Every record carries a `response_status`
field (the upstream HTTP status), reported **by default** whenever `record_server`
is configured — no extra flag needed. When the upstream returns a non-2xx
status, the proxy still POSTs a record — with all token counters at `0` (error
bodies rarely carry usage) and `response_status` set to the real status. Only
`response_body` is gated (by `record_response_body = true`); when that flag is on, the
non-2xx constructed response body (the upstream's error JSON or text) is
attached to `response_body` just like a success body. This lets the collector
see failures and their statuses by default, and opt into error payloads via
`record_response_body`.

**Request** (proxy → stats service):

| Aspect | Value |
|---|---|
| Method | `POST` |
| URL | `record_server` as configured |
| Content-Type | `application/json` |

| Header | Value |
|---|---|
| `one_time_auth_code` | the one-time authorization code (OTAC) the auth service returned for this request, if any (absent otherwise) |
| `x-forwarded-for` | resolved client IP, same value as sent to the auth service (when detectable) |
| `x-real-ip` | resolved client IP — **only when the caller did not already send `x-real-ip`** |

Body (`ModelUsageRecordPayload`):

| Field | Type | Meaning |
|---|---|---|
| `request_id` | string | Same proxy-generated request id forwarded to auth. |
| `timestamp` | string | ISO 8601 timestamp of the record. |
| `endpoint` | string | Inbound request path (e.g. `/v1/messages`). |
| `user_key` | string | Raw caller auth key (from `Authorization` / `x-api-key` / `x-goog-api-key`). |
| `model` | string | **Resolved** upstream model id actually sent upstream (the `target`, not the alias key). |
| `response_status` | number | Upstream HTTP status. `0` means no response was obtained. Non-2xx statuses are recorded with all token counters at `0`. |
| `input_tokens` | number | Input tokens reported by the upstream (or local tiktoken estimate when `LOCAL_TIKTOKEN=true`). For non-2xx, `0`. |
| `cached_tokens` | number | Prompt-caching read tokens (Anthropic / OpenAI cache-read), if reported. |
| `cache_written_tokens` | number | Prompt-caching write tokens, if reported. |
| `output_tokens` | number | Output tokens reported by the upstream. |
| `total_tokens` | number | Sum when reported by the upstream, else `input + output`. |
| `response_body` | object \| string | **Only when `record_response_body = true`.** Parsed JSON object for non-streaming responses; accumulated raw SSE text for streaming responses. Absent otherwise. |

**Response**: the proxy only checks `response.ok`; a non-2xx is logged at
`WARN` with the status code. There is no retry.

## Combining auth and stats in one service

When `auth_server` and `record_server` point at the same backend, the
`one_time_auth_code` (OTAC) header returned by the auth step is the linkage key:
it travels on the auth response header, then on the stats request header,
letting the backend tie the usage record back to the authenticated principal
without re-validating the credential. If the two are separate services,
`one_time_auth_code` is simply not sent on the stats call.
