# Plan: Integrate OpenAI Privacy Filter (`opf`) as a PII redaction plugin

## Goal

Use the local `opf` privacy filter (`~/dev/bot/privacy-filter`) as a plugin for this proxy so
that **PII never leaves the machine**: redact PII out of the LLM request before it is sent
upstream, then restore the original values in the response returned to the client.

Decisions (confirmed):
- **Runtime**: `opf` runs as a **persistent Python HTTP sidecar** (model stays warm in memory).
- **Behavior**: **reversible** — redact outbound request, keep a placeholder→original map,
  re-insert originals in the response (client sees correct data, upstream never sees PII).
- **Config**: **environment variables only** (no TOML/dashboard surface for now).

## Why a sidecar

`opf` is a ~1.5B-param model; loading it costs seconds and it must stay resident. Spawning the
CLI per request is far too slow. `opf` ships a clean Python API (`opf._api.OPF`) but **no HTTP
server**, so we add a thin server around it. The proxy (Node/TS, also Cloudflare-Workers-capable)
talks to it over HTTP via `fetch`, which keeps the two cleanly decoupled and lets the filter be
disabled by simply not setting its URL.

## Reversibility design (the critical part)

`opf` returns `detected_spans` with `{label, start, end, text, placeholder}`, but placeholders are
**not unique** (two emails both become `<PRIVATE_EMAIL>`), so the raw placeholder is not
reversible. The sidecar therefore assigns a **unique sentinel per span** and returns the mapping.

Sentinel format: `⟦PII:7⟧` (rare unicode brackets + index) — chosen so it is extremely unlikely to
appear in real text and survives JSON round-trips. The sidecar owns sentinel generation so there is
a single source of truth.

Flow per request:
1. Proxy extracts user-visible text fields from the request body.
2. Sends them to the sidecar `POST /redact`.
3. Sidecar runs `opf`, replaces each detected span with a unique sentinel, returns
   `{ redacted: [...], mapping: { "⟦PII:0⟧": "alice@x.com", ... } }`.
4. Proxy writes redacted text back into the body, sends upstream.
5. On the response, proxy replaces every sentinel back to its original value (non-streaming: string
   replace; streaming: a `TransformStream` that buffers across chunk boundaries).

## Component 1 — Python sidecar

New file: `~/dev/bot/privacy-filter/serve.py` (kept in the privacy-filter repo; pure stdlib
`http.server` so no extra deps).

```python
# Endpoints:
#   GET  /health           -> {"status":"ok","device":...,"model_loaded":true}
#   POST /redact           -> body {"texts": ["...", "..."]}
#                             resp {"redacted": ["...", "..."],
#                                   "mapping": {"⟦PII:0⟧": "original", ...},
#                                   "span_count": N}
#
# Loads opf._api.OPF once at startup with output_mode="typed" so labels are known.
# For each input text: run redactor.redact(text) -> RedactionResult.detected_spans,
# walk spans left->right, emit unique sentinel per span, accumulate mapping.
# Sentinels are unique across the whole batch so one request's map is self-consistent.
```

Run it:
```bash
source ~/dev/ai/bin/activate
OPF_MOE_TRITON=0 python submodules/privacy-filter/serve.py --device auto --port 8799
```

`--device auto` (the default) probes mps → cuda → cpu; the chosen device is exercised by a warmup
`redact()` so an unusable backend fails fast and falls back to cpu. An explicit `--device` is tried
first, then cpu as a fallback. Flags (`--device`, `--port`, `--checkpoint`, `--output-mode`) are
documented in the privacy-filter README "Run as a server" section.

## Component 2 — Node plugin module

New file: `src/utils/privacy-filter.ts`

Responsibilities:
- Read env config (below) once; expose `isPrivacyEnabled()`.
- `redactBody(body, endpoint): Promise<{ body, mapping }>`
  - Knows the body shapes used by the proxy:
    - Claude/Anthropic `messages[].content` (string OR `{type:'text', text}` blocks) and `system`.
    - OpenAI `messages[].content`.
  - Collects all text fragments, calls the sidecar once (`POST /redact` with the batch), and writes
    redacted fragments back into a cloned body. Returns the merged `mapping`.
  - **Always fail-closed**: if the sidecar is unreachable, return an error rather than leak PII
    upstream. A privacy tool must never forward unredacted text on sidecar failure, so there is
    no opt-out flag for this.
- `restoreText(text, mapping): string` — replace all sentinels with originals.
- `createRestoreTransformStream(mapping): TransformStream` — for SSE responses; buffers a small
  tail so sentinels split across chunks are still matched before flushing.

The module is self-contained and does nothing when `PRIVACY_FILTER_URL` is unset, so existing
behavior is unchanged by default.

## Component 3 — Wiring into the router

File: `src/index.ts`. The cleanest chokepoint is **`runAttempt`** (every handler dispatches through
it) plus the request-body parse that already happens earlier. Concretely:

1. **Redact request**: when privacy is enabled and `path` is a chat endpoint
   (`/v1/messages`, `/v1/responses`, and `/v1/chat/completions` passthrough), after the request
   body is parsed, call `redactBody(...)`, replace the request body text used to build
   `RouteAttempt`(s), and stash the returned `mapping` on the attempt (e.g. `attempt.piiMapping`).
   - This must run for both the single-attempt path and the `compositeAttempts` map. For **fusion**,
     redact the inbound `_fusionBody` once so panel/judge/synth all operate on redacted text; the
     mapping is restored only on the final synth response.
2. **Restore response**: inside `runAttempt`, after the handler returns `response` and after the
   existing usage/tool tracking:
   - JSON response → read text, `restoreText`, rebuild `Response`.
   - `text/event-stream` → `response.body.pipeThrough(createRestoreTransformStream(mapping))`
     (composed with the existing usage/tool transforms).

Scope note: limit v1 to the text content of chat endpoints. Tool-call arguments, embeddings input,
and image blocks are explicitly out of scope for the first cut (documented as a known limitation).

## Environment variables

Added to `src/server.ts` env wiring (and read in `privacy-filter.ts`):

| Var | Default | Meaning |
|-----|---------|---------|
| `PRIVACY_FILTER_URL` | (unset) | Sidecar base URL, e.g. `http://127.0.0.1:8799`. Unset = plugin off. |
| `PRIVACY_FILTER_TIMEOUT_MS` | `30000` | Per-call timeout to the sidecar. |
| `PRIVACY_FILTER_MAX_CHARS` | `200000` | Skip redaction above this size (safety cap). |

## Files to add / modify

**New**
1. `~/dev/bot/privacy-filter/serve.py` — HTTP sidecar around `opf._api.OPF`.
2. `src/utils/privacy-filter.ts` — Node plugin (config, redactBody, restoreText, stream transform).

**Modified**
3. `src/index.ts` — call `redactBody` on inbound request; restore in `runAttempt`
   (JSON + SSE), including the composite and fusion paths.
4. `src/server.ts` — surface the new env vars in the `env` object.
5. `~/dev/bot/privacy-filter/README.md` — short "Run as a server" section.

## Verification

1. **Sidecar unit**: `curl -s localhost:8799/redact -d '{"texts":["email alice@x.com and bob@y.com"]}'`
   → two distinct sentinels, mapping has 2 entries, both emails recoverable.
2. **Round-trip (non-streaming)**: send `/v1/messages` containing an email; confirm via proxy debug
   log that the **upstream** body shows sentinels (no raw email) and the **client** response shows
   the original email restored.
3. **Streaming**: same with `stream:true`; confirm sentinels are restored even when one is split
   across two SSE chunks.
4. **Fail-closed**: stop the sidecar; request errors (no PII leaks). There is no opt-out — a
   privacy tool must never forward unredacted text on sidecar failure.
5. **Disabled**: unset `PRIVACY_FILTER_URL`; behavior identical to today (regression check via
   existing `run-tests.js` against `./testcases`).
6. `npm run typecheck` clean.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| Sidecar latency on CPU adds per-request delay | Keep model warm; batch all message texts in one `/redact` call; allow `--device cuda`. |
| Sentinel collision with real text | Use rare-unicode sentinel `⟦PII:n⟧`; reject/escape if input already contains the bracket pair. |
| Sentinel split across SSE chunks | Restore transform restores all *complete* sentinels each chunk and only holds back a trailing *unclosed* `⟦…` (within max sentinel length) until the next chunk. |
| Over/under-redaction (model limitation) | Documented; `output_mode` and device tunable via sidecar flags; not a correctness guarantee. |
| PII leak if sidecar down | **Always fail-closed** (no opt-out); error rather than forward unredacted text. |
| Cloudflare Workers build (no Node child process) | Plugin is pure `fetch` to an external URL, so it remains Workers-compatible; only the sidecar is host-side. |
```
