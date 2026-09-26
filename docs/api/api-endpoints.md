# API Endpoints — Details

Deep-dive reference for the proxy's API endpoints. The [README](../README.md#api-endpoints)
keeps the endpoint table and the `upstream_mode` conversion matrix; this doc covers the
per-feature details: dynamic routing, image input/output across format boundaries, OpenAI
prompt-caching fields, and the Dashboard JSON API.

## Dynamic routing

In addition to the fixed endpoints, the proxy accepts **per-request dynamic routes** of the
form `/{protocol}/{host}/{path_prefix}/{model_id?}/{claude_endpoint}`, e.g.
`/https/api.qnaigc.com/openai/v1/models/deepseek-v3.1/v1/messages`. The first path segment after
the leading slash is the protocol (`http` or `https`); the next is the upstream host; the proxy
then walks the remaining segments to find the boundary between the upstream API path prefix, an
optional model id, and the trailing Claude-style endpoint (`v1/messages`, `v1/models`,
`v1/messages/count_tokens`, etc.).

- **No body conversion.** Dynamic routes are passthrough: the body is forwarded to the resolved
  upstream URL verbatim, and auth headers (`Authorization` / `x-api-key` / `x-goog-api-key`) are
  forwarded as-is from the caller. The proxy does **not** perform a local credential check.
- **SSRF guard.** The parsed host is checked against `ALLOWED_HOSTS` (env, default
  `127.0.0.1,localhost`) plus any host derived from `[models.*]` / `[default_upstream]` config
  (`getAllowedHostsFromConfig`). Requests for hosts outside that allowlist are rejected with `403`.
- **Use case.** Lets a single proxy instance fan out to many config-approved upstreams without a
  `[models.*]` entry per target — useful for ad-hoc probing during development.

## Image input/output across format boundaries

**Wire shapes the proxy produces.** In every supported direction, image bytes travel **inline in the request body** — The proxy does NOT upload images to external storage and does NOT expose any image-serving endpoint.
- The '[fetch] image_encode' sidecard for processing the images fetching and base64 encoding of image_url from `/v1/chat/completions` asynchronously outside the proxy.

| Target upstream | Wire shape emitted | What's in it |
|---|---|---|
| Gemini (`gemini-generatecontent`) | `inline_data: {mime_type, data: "<base64>"}` | Raw base64 string in a JSON field |
| OpenAI (`openai-completions` / `openai-responses`) | `image_url: {url: "data:<mime>;base64,<base64>"}` | A **data URI** — the base64 bytes are inside the URL string itself |
| Claude (`anthropic-messages`) | `image: {source: {type: "base64", media_type, data}}` | Raw base64 string in a JSON field |

This row describes only what the proxy **emits to an OpenAI upstream when source bytes are inline** (Gemini `inline_data`, Claude base64, or a caller-supplied `data:` URI). In that direction the proxy always produces a `data:` URI — the field is named `image_url` but the bytes live inside the string after the comma, and the upstream parses it server-side with no second network fetch. It is **not** a constraint on what callers can send: OpenAI's schema also accepts a real `https://...` URL in `image_url.url`. When a caller does send an HTTP URL, see the **Source-shape handling** table below for the per-route behavior (some routes fetch+inline the bytes, others pass the URL through unchanged).

**Source-shape handling.**

| Source shape | What happens | Result |
|---|---|---|
| Client sent `data:` URI | Decoded synchronously in-process | Bytes embedded inline in the upstream request |
| Client sent raw base64 (Gemini `inline_data` / Claude `image`) | Passed through / re-wrapped into target shape | Bytes embedded inline |
| Client sent `https://...` URL | **Fetched and base64-encoded, then the URL is discarded** (see *who fetches HTTP URLs* below) | Bytes embedded inline — except on the OpenAI → OpenAI Responses route, where the URL is passed through unchanged |

**Fetch+base64 only runs for real HTTP(S) URLs** — `data:` URIs are decoded, raw base64 is re-wrapped, neither hits the network.

**Who fetches HTTP URLs** (only relevant when the caller actually sent an `https://...` URL):

- **OpenAI → OpenAI Responses route**: nobody. The proxy passes `image_url: {url, detail?}` through unchanged and the OpenAI Responses upstream fetches the URL itself. No in-proxy SSRF guard, no sidecar.
- **Every other route that needs inline bytes** (OpenAI → Gemini, OpenAI → Claude, Responses → Claude/Gemini): the work is done by whichever of these is configured:
  - **No sidecar configured** (default) → the **proxy fetches in-process**, with its own SSRF guard (loopback / RFC1918 / link-local / mDNS blocked via `isInternalHost`; 20 MiB byte cap; `ALLOWED_HOSTS` does **not** apply to image URLs).
  - **`[fetch] image_encode` (or `IMAGE_ENCODE_URL`) configured** → the proxy delegates to the **sidecar** via `POST {url}/encode` with `{"url":"..."}`; the sidecar returns `{"mime_type","data"}`. The sidecar must be on localhost / private LAN and applies its own SSRF policy. The sidecar is **opt-in**.

The only HTTP URL ever involved is the *input* URL the client sent; neither proxy nor sidecar hosts or re-serves images.

Image **input** is converted across the OpenAI ↔ Gemini boundary in both directions:

- **Gemini → OpenAI** (Gemini SDK client → OpenAI-compatible upstream): each Gemini `inline_data`/`inlineData` request part becomes an OpenAI `image_url` data-URI part. Both snake_case and camelCase Gemini field names are accepted.
- **OpenAI → Gemini** (`/v1/chat/completions` client → `gemini-generatecontent` upstream): each OpenAI `image_url` request part becomes a Gemini `inline_data` part. `data:` URIs decode synchronously. http(s) URLs are either (a) fetched server-side in-process with an SSRF guard (loopback / RFC1918 / link-local / mDNS hosts blocked via `isInternalHost`, 20 MiB byte cap; `ALLOWED_HOSTS` does **not** apply to image URLs), or (b) delegated to an image-encode sidecar when `[fetch] image_encode` (or `IMAGE_ENCODE_URL`) is configured — the sidecar receives `POST {url}/encode` with `{"url":"..."}` and returns `{"mime_type","data"}`. The sidecar must be on localhost / private LAN; its own SSRF policy governs the image URL.
- **OpenAI → Claude** (`/v1/chat/completions` or `/v1/interactions` client → `anthropic-messages` upstream): each OpenAI `image_url` request part becomes a Claude `image` block (`source.type = "base64"`). `data:` URIs decode via the shared `decodeDataUri` helper; http(s) URLs use the same SSRF-guarded fetch / sidecar path as the Gemini direction above. Text-only array `content` collapses back to a plain string to preserve the existing wire shape. Anthropic's spec restricts `image` blocks to `user`-role messages; the proxy emits them for any role containing `image_url` (matches the existing cross-role behavior of `convertClaudeToGeminiRequest` / `convertClaudeContentToOpenAI`) — if Claude rejects assistant-role images, that is upstream spec enforcement.
- **OpenAI → OpenAI Responses** (`/v1/chat/completions` or `/v1/interactions` client → `openai-responses` upstream): each OpenAI `image_url` request part becomes a Responses `input_image` part. The `image_url` object (`{url, detail?}`) is passed through unchanged — the Responses upstream performs its own image fetch, so no in-proxy SSRF guard or sidecar is involved. Text parts use the role-appropriate `input_text` (user) / `output_text` (assistant).
- **Responses → Claude / Gemini** (`/v1/responses` client → `anthropic-messages` or `gemini-generatecontent` / `gemini-interactions` upstream): each Responses `input_image` part becomes a Completions `image_url` part (object form `{url, detail?}`) in the intermediate representation, then a Claude `image` block on the `anthropic-messages` route (data: URI decoded in-process; http(s) via the same SSRF-guarded fetch / sidecar path as the OpenAI → Claude direction). The Gemini direction benefits from the same chain via the shared `completionsToClaudeBody` reuse.

Image **output** from a Gemini model (e.g. `inlineData` returned by an image-generation model) is **not carryable** to a `/v1/chat/completions` or `/v1/messages` client through any cross-mode route. This is a hard limit imposed by the target response schemas, not a missing converter:

- **Claude Messages**: the Anthropic API spec restricts `image` content blocks to **user** (input) messages. An assistant message carrying an `image` block is rejected by a real Anthropic-compatible upstream. The proxy's local TypeScript types permit the structure, but the spec does not.
- **OpenAI Chat Completions**: `choices[].message.content` is text, or an array of `text` / `image_url` parts where `image_url` is also input-only. There is no field for a model-generated image in a completion response.

Model-generated images only reach clients through **native Gemini passthrough** — a `:generateContent` / `/v1/interactions` client routed to a `gemini-generatecontent` / `gemini-interactions` upstream — where `inlineData` passes through unchanged.

On the cross-mode `/v1/chat/completions` → `gemini-generatecontent` response path specifically, tool-call and thinking parts of a Gemini response are also dropped today (the response-side `convertGeminiGenerateContentToClaude` extracts text only). Extending that converter would let tool-calls round-trip into OpenAI `tool_calls` and thinking into `reasoning_content`; image output would still be blocked by the schema limits above.

**Known limitation — Gemini `generateContent` → OpenAI with mixed `functionCall` + `inline_data` in one turn:** `convertGeminiGenerateContentToOpenAI` (in `src/handlers/openai.ts`) drops `inline_data` parts when a Gemini model turn contains both a `functionCall` *and* an image in the same turn — only the `tool_calls` and text are emitted. This is an intentional trade-off: it's a rare edge case (image-generation-with-tools models that emit a tool call and an image together), and OpenAI's Chat Completions spec does not define assistant `tool_calls` turns that also carry array-form image content, so emitting such a turn would risk upstream rejection. Text-only turns and image+text turns (no tool calls) on this route are unaffected.

## OpenAI prompt caching fields

The proxy only preserves OpenAI prompt-caching controls when the target mode can carry them without changing prompt structure. Cross-mode conversion preserves the top-level routing key, but not request-wide cache policy or content-block breakpoints.

| Client endpoint | `upstream_mode` | `prompt_cache_key` | `prompt_cache_options` | `prompt_cache_breakpoint` |
|---|---|---|---|---|
| `POST /v1/responses` | `openai-responses` | Preserved | Preserved | Preserved |
| `POST /v1/responses` | `openai-completions` | Preserved | Dropped | Dropped during `input` → `messages` conversion |
| `POST /v1/chat/completions` | `openai-completions` | Preserved | Preserved | Preserved |
| `POST /v1/chat/completions` | `openai-responses` | Preserved | Dropped | Dropped during `messages` → Responses `input` / `instructions` conversion |

## Dashboard API

The `/dashboard` web UI is driven by a small JSON API. Dashboard/admin routes
are restricted to loopback clients by the Node server adapter. To also require a
bearer token for the JSON API, set:

```toml
[dashboard]
api_key = "your-dashboard-key"
```

When `dashboard.api_key` is configured, every `/dashboard/api/*` route requires
`Authorization: Bearer <dashboard.api_key>`. `GET /dashboard` remains loadable
from loopback without auth. The browser dashboard prompts for the key on the
first API `401`, sends dashboard API requests sequentially, stores the key in
browser `localStorage`, and expires the saved key after 7 days. The `/dashboard`
HTML response uses no-cache headers so browser users get the latest dashboard
script. If `dashboard.api_key` is omitted or empty, dashboard APIs keep the old
loopback-only behavior.

| Endpoint | Purpose |
|---|---|
| `GET /dashboard/api/config` | Read current config snapshot; `?reload=1` re-reads the TOML file |
| `PUT /dashboard/api/config` | Replace the whole config snapshot (also auto-saves the TOML) |
| `POST /dashboard/api/global-token-limit` | Set / update the global token cap (sliding or calendar window) |
| `POST /dashboard/api/schedule/alias` | Add a new `[schedule]` alias (body: `{alias: string}`) |
| `DELETE /dashboard/api/schedule/alias/:alias` | Remove a `[schedule]` alias |
| `POST /dashboard/api/schedule/alias/:alias/target` | Upsert a target's window list (body: `{target, windows}`) |
| `DELETE /dashboard/api/schedule/alias/:alias/target/:target` | Remove a target from an alias |
| `POST /dashboard/api/test-model` | Send a test request through a configured model |
| `GET /dashboard/api/stats/models` | Per-model token and request stats |
| `GET /dashboard/api/stats/agents` | Per-agent request stats |
| `GET /dashboard/api/stats/requests` | Endpoint, upstream, status-code, timing, and tool-response stats |
| `GET /dashboard/api/tools/blocklist` | Read the current tool blocklist |
| `POST /dashboard/api/tools/toggle-block` | Block or unblock a tool by name |

The four `schedule/*` routes are the dedicated CRUD for `[schedule]` aliases;
mutations also round-trip through the TOML file so the change persists across restarts.

**Stats are keyed by resolved upstream model id, not the alias/target key.**
A `[models.*]` entry like `max-m3 = {target = "MiniMax-M3", ...}` is looked up
under the key `max-m3`, but every request routed through it — including
`requests`/`failed_requests` counts and all token counters — is recorded
against `MiniMax-M3` (the resolved `target`), because that's the model id
actually sent upstream. If a `[models.*]` entry has no explicit `target`
(so key == resolved model id), this distinction doesn't matter. But when
`target` differs from the key, check stats under the `target` value, not
the alias key, if a row looks stuck at zero requests/tokens despite live traffic.
