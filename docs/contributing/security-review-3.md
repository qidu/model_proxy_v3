# Security Review 3 — `src/`

**Scope:** full `./src/` tree on branch `feature/fusion`, current as of 2026-07-06.
**Method:** read-only review. Re-verifies findings from `security-review.md` (Jun 10) and `security-review-2.md` (Jul 1) against current code, plus new code changed since Jul 1 (commits `8df369b`..`e26a3ab`: timetable schedule, composite-to-composite targets with cycle detection, UA/agent-name stats, dashboard schedule editing).
**Date:** 2026-07-06

> Net change since the last review: the loopback gate that prior reviews *recommended* is now implemented for all admin paths (`index.ts:492-503`), the SSRF allowlist is wired in for dynamic routes (`index.ts:1194`), prototype-pollution guards are applied to the new schedule/composite key-copy sites, and two of four Gemini fetches now carry abort signals. One prior Critical (C1/C2/C3) and one High (H1) are effectively downgraded by these changes. The genuinely exploitable items still open are **H2** (unescaped model in upstream URL), **H4** (secrets/prompts to predictable files, now 42 MB and untracked), and **N1** below (API key logged in plaintext at debug).

---

## 1. Status of prior findings

### Critical → resolved/downgraded

- **C1 — Unauth dashboard config write → FIXED (loopback-gated).** `index.ts:492-503` now blocks any non-loopback `x-client-address` from `/config-reload` and every `/dashboard*` path before dispatch. The header is set from `req.socket.remoteAddress` at `server.ts:67-72` (not from a client-supplied header), so it cannot be spoofed. `PUT /dashboard/api/config` (`index.ts:599`) is inside the `/dashboard` prefix and therefore gated.
- **C2 — Unauth `/config-reload` key dump → FIXED (loopback-gated).** Same gate covers `/config-reload` (`index.ts:492,505`). The dump still writes full config to `./config-dumps/` (`config-loader.ts:1737`, called at `index.ts:514`), and the error path no longer echoes internals to the client (`index.ts:521-531`) — but see **H4** for the on-disk exposure that remains.
- **C3 — No real client auth → UNCHANGED (intentional).** `validateAuthHeaders` (`utils/validation.ts`) is still presence-only and still only called from token-counting. Per review 2 this is the documented `models.free` design (proxy authenticates upstream on the caller's behalf). Still safe only if the listener is not exposed to untrusted callers; see **N3** below.

### High

- **H1 — Dead SSRF allowlist → PARTIALLY FIXED.** `isHostAllowed` is now called at `index.ts:1194` — but **only for dynamic routes** (`/http/host/...`, `/https/host/...`). Fixed routes (config-defined `base_url`) and the dashboard test-model loopback are *not* validated against `ALLOWED_HOSTS`. A config pointing `base_url` at an internal host (set via the now-loopback-gated dashboard, or via a crafted config file/URL) still routes keys to arbitrary/internal hosts. Downgraded from Critical-context to Medium-context; the dynamic-route path is closed.
- **H2 — Unescaped model name in upstream URL → STILL PRESENT (High).** `upstreamModelName = route.modelAlias || candidateName` (`index.ts:1001, 1260`) is interpolated into `${route.targetUrl}/v1beta/models/${upstreamModelName}:generateContent` and friends with **no `encodeURIComponent`** at `index.ts:1045-1046, 1062-1063, 1076, 1092, 1305-1306, 1319-1320, 1329, 1342`. When no `modelAlias` is configured, `upstreamModelName` derives from the client-supplied `body.model`, enabling path/query injection (e.g. `model = "x:generateContent?key=ATTACKER#"` or `../../` to alter the upstream endpoint or smuggle query params). This is on the normal proxy data path and is **not** mitigated by the loopback gate. Same finding, same severity, same line range as Jun 10.
- **H3 — Test-model loopback SSRF → FIXED (loopback-gated) but unchanged structurally.** `dashboard.ts:1856` still POSTs to `http://127.0.0.1:${port}/v1/messages` with a client-supplied `modelId`, but the endpoint is now reachable only from loopback via the `index.ts:492-503` gate. Downgraded to defense-in-depth.
- **H4 — Plaintext prompts/keys to predictable files → STILL PRESENT (High, worsened).**
  - `./model_proxy_tokens.jsonl` is written with default file permissions at `dashboard-stats.ts:417,490` and is **not in `.gitignore`**. It is currently **42 MB** on disk and untracked — a commit accident away from being pushed, and world-readable on a shared host.
  - `./config-dumps/` (full config incl. API keys, written by `dumpProxyConfigToml` at `config-loader.ts:1737`) is also **not in `.gitignore`**.
  - `/tmp/test_model.log` debug dump (`dashboard.ts:1881,1907`) still writes full request/response bodies to a predictable world-readable path with default permissions.

### Medium

- **M1 — Cross-upstream key forwarding to chatjimmy → STILL PRESENT.** `sdk-handler.ts:234-236` builds `{ baseURL: targetUrl.replace(/^sdk:\/\//, 'https://'), apiKey: apiKey || '' }` for any `sdk://` route; `targetUrl` is config-controlled so this is only "hardcoded third party" if the operator configured `sdk://chatjimmy.ai/api`. The real new issue is **N1** below — the same config object is logged verbatim at debug.
- **M2 — Upstream error bodies echoed → partially addressed.** `/config-reload` error path (`index.ts:521-531`) now returns a generic message. Other handlers were not re-audited this pass; review 2 noted `errors.ts` deliberately avoids echoing raw upstream bodies to clients.
- **M3 — Partial API keys logged → STILL PRESENT (Low).** `index.ts:1221` logs `${value.substring(0,4)}...${value.substring(value.length-4)}`. Truncated prefix+suffix is acceptable hygiene; the prior `openai.ts` substring bug (logging the key *tail*) is confirmed fixed — `openai.ts` no longer logs `substring(64)`.
- **M4 — CORS reflects arbitrary Origin → STILL PRESENT (Medium).** `getCorsOrigin` (`index.ts:129-177`) reflects `requestOrigin` whenever `ALLOWED_ORIGINS` is unset, and `server.ts:25` still defaults `ALLOWED_ORIGINS='*'`. With no auth on `/v1/*` (C3) this means any browser origin can read proxied responses cross-origin. Loopback gating of `/dashboard` limits the admin surface, but the data path is unaffected.
- **M5 — Missing Gemini timeouts → PARTIALLY FIXED.** `gemini.ts:142, 261` now use `createUpstreamAbortSignal(getUpstreamBodyTimeoutMs(env))`. Three fetches still lack a signal: `gemini.ts:374, 555, 657`. A hung upstream on those paths still ties up the request.

### Low

- **L5 — Dashboard innerHTML sinks → FIXED.** All client-controlled values inserted into dashboard HTML are now funneled through `escapeHtml` (e.g. `dashboard.ts:627,823,988-997,1022`). The `configForm.innerHTML = modelBlocks + ... compositeBlocks + ... scheduleBlocks` sink at `dashboard.ts:832` is built entirely from `escapeHtml`-wrapped values. No unescaped client/upstream-controlled string reaches `innerHTML` in the reviewed range.

---

## 2. New findings (code changed since 2026-07-01)

- **N1 — API key logged in plaintext at debug level (High).** `src/utils/sdk-handler.ts:242`:
  ```ts
  activeLogger.debug(requestId, `Using SDK client config: ${JSON.stringify(config)}`);
  ```
  `config` (line 234-240) includes `apiKey: apiKey || ''`. At `LOG_LEVEL=debug` this writes the **full upstream API key** to the structured logger — the same class of bug as the prior `openai.ts` substring issue (review 2 H1), but worse because it is the whole key, not a tail. The logger has no redaction layer (review 2 M1), so any future call site can leak secrets by construction. **Fix:** redact `apiKey` before stringifying, or drop it from the logged object.

- **N2 — Schedule validation is robust (CHECKED, SAFE).** `config-loader.ts:1517-1568` validates schedule windows: `from`/`to` must be numbers in `[0,24]`, `from < to`, `days` must be `"weekday"`, `"weekend"`, or an array of valid 3-letter day names. `resolveScheduleTarget` (`config-loader.ts:542-569`) does a single-hop lookup (does not recurse into schedule-of-schedule), so no infinite recursion. No injection into timers/eval — schedule only selects which target alias to route to.

- **N3 — Composite cycle detection is enforced at request time (CHECKED, SAFE).** `getModelRouteConfig` (`config-loader.ts:571-591`) throws on `visited.has(effectiveName)` with the full chain in the message; `getOrderedCompositeTargets` (`config-loader.ts:242-279`) threads `visited` through recursion. A crafted config (composite A → B → A) cannot cause stack overflow at request time — it throws a `Routing cycle detected` error. Cycle detection runs on every routing call, not only on file load, so a dashboard-submitted cyclic config is caught when first routed, not when first persisted (config-load validation `findAliasNameConflicts` at `config-loader.ts:1288` catches name collisions but not arbitrary cycles — the runtime guard is the real backstop).

- **N4 — Prototype-pollution guards applied to new key-copy sites (CHECKED, SAFE).** `assertSafeKey`/`DANGEROUS_KEYS` (`config-loader.ts:2298-2302`) is called at the new schedule key-copy sites (`config-loader.ts:2478, 2485`) and the composite sites (`config-loader.ts:2313, 2329`), in addition to the existing dashboard-model sites (`config-loader.ts:2508, 2515, 2585`). `JSON.parse` already makes `__proto__` an own non-magic property, and the denylist is defense-in-depth — consistent with review 2 M4.

- **N5 — UA/agent-name stats: no XSS / terminal-escape injection (CHECKED, SAFE).** Client `User-Agent` is reduced to its first whitespace-delimited token via `extractUserAgentPrefix` (`dashboard-stats.ts:740-745`) before being used as a map key; it is never inserted into dashboard HTML unescaped (all dashboard `innerHTML` sites use `escapeHtml`, see L5). In the TUI, UA-derived strings are rendered through the TUI's own widget layer; no raw `stdout.write` of client-controlled bytes alongside the `\x1b]0;...\x07` title sequence at `tui.ts:1246` (the title is a fixed string). No terminal-escape injection vector found.

- **N6 — New dashboard schedule endpoints are loopback-gated (CHECKED, SAFE).** `POST /dashboard/api/schedule/alias`, `DELETE /dashboard/api/schedule/alias/:name`, `POST /dashboard/api/schedule/alias/:name/target` (`index.ts:635-654`) all match `path.startsWith('/dashboard')` and are therefore inside the `index.ts:492-503` loopback gate. `decodeURIComponent` is applied to the path params (`index.ts:643,652`) — values are then used as object keys in config writes, not in URLs or filesystem paths.

- **N7 — `x-client-address` is server-injected, not client-trusted (CHECKED, SAFE).** `server.ts:67-72` overwrites `headers['x-client-address']` from `req.socket.remoteAddress` on every request, so the loopback check at `index.ts:495-496` cannot be bypassed by a client sending a spoofed header. (This was the assumption prior reviews asked to be verified; it holds.)

---

## 3. Checked and found safe (this pass)

- Loopback gate covers every admin path (`/config-reload`, `/dashboard`, `/dashboard/api/*`) via prefix match — no admin endpoint reachable off-loopback.
- Server-injected `x-client-address` cannot be spoofed by client headers.
- Schedule feature: no eval/timer injection; input validated; single-hop resolution; no recursion.
- Composite cycle detection: enforced at request time with a visited-set, throws on cycle.
- Prototype-pollution denylist (`DANGEROUS_KEYS`/`assertSafeKey`) applied to all key-copy sites including new schedule/composite ones.
- Dashboard HTML: all `innerHTML` sinks use `escapeHtml`; no unescaped client/upstream value reaches the DOM.
- UA/agent stats: first-token-only extraction, no XSS, no terminal-escape injection in TUI title.
- New schedule dashboard endpoints: inside loopback gate; path params used as object keys only, not in URLs/paths.
- `eval` / `Function()` / `child_process` / dynamic `require`: none found in `src/` (the `import(/* @vite-ignore */ sdkPath)` at `sdk-handler.ts:68` is a path computed from a hardcoded relative string, not request data).

---

## 4. Recommended priorities (highest impact first)

1. **H2 — `encodeURIComponent` the model URL segment** at `index.ts:1045-1046, 1062-1063, 1076, 1092, 1305-1306, 1319-1320, 1329, 1342`. Not mitigated by any current control; affects every Gemini-native request when no alias is configured.
2. **N1 — stop logging `config` (incl. `apiKey`) verbatim** at `sdk-handler.ts:242`. Redact or omit the key.
3. **H4 — secrets/prompts to predictable files.** Add `model_proxy_tokens.jsonl`, `config-dumps/`, `/tmp/test_model.log` (or a non-shared path) to `.gitignore` immediately (the 42 MB token log is untracked today). Restrict file modes on `writeFileSync`/`mkdirSync` (`dashboard-stats.ts:417,490`, `config-loader.ts:1737`, `dashboard.ts:1881,1907`). Never dump full keys.
4. **M5 — add abort signals** to the three remaining Gemini fetches (`gemini.ts:374, 555, 657`).
5. **H1 (residual) — extend `isHostAllowed` to fixed routes** so a config-defined `base_url` pointing at an internal host is rejected, not just dynamic-route hosts.
6. **M4 — set a real `ALLOWED_ORIGINS` default** (or require it in production) instead of `'*'` at `server.ts:25`, so the data path is not cross-origin readable by arbitrary browsers.
7. **C3 (residual) — add a real caller-credential check** on `/v1/*` if the listener is ever exposed beyond localhost.

---

*Read-only review. No source files were modified in producing it.*
