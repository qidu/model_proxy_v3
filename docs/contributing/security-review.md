# Consolidated Security Review — `src/`

**Scope:** Proxy implementation under `./src/` (entry/routing, upstream/SSRF, dashboard/logging/storage).
**Method:** Read-only review of source; key findings verified directly against the code (file:line cited).
**Date:** 2026-06-10 (re-verified 2026-06-11)

> **Re-verification note (2026-06-11):** key claims spot-checked against the current tree — `0.0.0.0` bind (`server.ts:123`), unauthenticated `/config-reload` (`index.ts:398`) and `PUT /dashboard/api/config` (`index.ts:449`), dead `isHostAllowed` (exported `routing.ts:16`, never called), unescaped model in upstream URL (`index.ts:686-687, 703`) all still hold. Line numbers in `dashboard-stats.ts` past ~735 have shifted due to an unrelated streaming-usage fix; other citations unaffected.

---

## 0. The deployment-scoping question

The question raised was:

> If **TUI is unset (or the process is limited to a local user)** and the **`/dashboard` page is limited to localhost-only visiting**, are the findings below still serious?

Short answer: **the *intent* of that mitigation is sound and would downgrade most Critical/High findings — but the code does not currently enforce it.** Two facts decide this:

1. **The server binds to all interfaces, not localhost.**
   `src/server.ts:123` → `server.listen(port, '0.0.0.0', ...)`. As written, the dashboard and every endpoint are reachable from any network the host is attached to. "Localhost-only" is therefore an *operator assumption*, not a code guarantee.

2. **There is no localhost gate on the dashboard handlers.**
   - The only localhost logic is `isLocalhostOrigin` at `src/index.ts:69-79`, which inspects the **CORS `Origin` header**. That is a *browser* control and is trivially absent/spoofed by any non-browser client (curl, scripts). It does not restrict who can call the endpoint.
   - `x-client-address` (the real socket peer, set in `server.ts:62`) is only read at `index.ts:639` for **logging** — it is never used to allow/deny the dashboard or config endpoints.

**Conclusion:** If localhost-only and single-local-user are *actually* enforced at the deployment layer (see §3), the network-reachable Critical findings (C1, C2, C3, H3) drop to **Low** (local-only attacker / defense-in-depth). The findings that are *not* about the dashboard's network exposure — H2 (URL injection on the proxy data path), H1 (dead SSRF allowlist), M1 (cross-upstream key forwarding), M2 (error-body leakage), H4/M3 (secrets in files/logs) — **remain serious regardless**, because they live on the normal proxy request path that authenticated/legitimate clients use, or they leak secrets to local files.

A reassessment table is in §2.

---

## 1. Findings (verified)

Severities below are the **as-deployed-today** ratings (server on `0.0.0.0`, no auth, no localhost gate). The §2 table shows how they change under the localhost/local-user assumption.

### Critical

- **C1 — Unauthenticated dashboard config write → key exfiltration / SSRF.**
  `index.ts:449-452` dispatches `PUT /dashboard/api/config` with no auth check; `dashboard.ts:947-963` persists arbitrary JSON to `proxy_config.toml`. An attacker repoints `base_url` to a host they control; the next proxied request ships the configured upstream API key there.

- **C2 — Unauthenticated `/config-reload` dumps full config including upstream keys.**
  `index.ts:398-422` runs before any auth and calls `dumpProxyConfigToml()`, which writes the **complete config (incl. API keys)** to `./config-dumps/` (config-loader.ts:818-828). (`config-dumps/` already exists untracked in the working tree.)

- **C3 — No real client authentication on any proxy/dashboard endpoint.**
  `validateAuthHeaders` (validation.ts:392-396) only checks header *presence* (`Authorization` OR `x-api-key`), never compares to a configured secret — so it is not authentication. It is also only invoked from `token-counting.ts:60`, never on `/v1/messages`, `/dashboard/*`, etc. With a server-side `default_api_key`/`route.apiKey` configured, any anonymous caller gets a free key-bearing relay.

### High

- **H1 — SSRF allowlist is dead code.**
  `isHostAllowed` / `getAllowedHosts` (routing.ts:35-64) are exported but **never called** anywhere in `src/` (verified). No upstream URL is validated against `ALLOWED_HOSTS`; `http://` and internal IPs pass freely. This is the missing guard that makes C1 fully weaponizable.

- **H2 — Client-controlled model name injected unescaped into the upstream URL path.**
  `index.ts:686-687, 703-704, 724` build `${route.targetUrl}/v1beta/models/${upstreamModelName}:...` with **no `encodeURIComponent`**. When no `modelAlias` is configured, `upstreamModelName` derives from client `body.model`, enabling path/query injection — e.g. `model = "x:generateContent?key=ATTACKER#"` or `../../` to alter the upstream endpoint or smuggle query params. **On the normal proxy data path — independent of dashboard exposure.**

- **H3 — Unauthenticated test-model loopback SSRF / internal-port disclosure.**
  `dashboard.ts:1146-1167` makes the server POST to `http://127.0.0.1:${PORT}` with a client-supplied `modelId`, probing internal models and revealing the internal port. Chains with C1/C3.

- **H4 — Predictable plaintext logs of prompts/usage written to disk.**
  `dashboard-stats.ts:90,119,182` appends usage/prompt-derived data to fixed relative path `./model_proxy_tokens.jsonl` with default file permissions (file already present in tree). At `LOG_LEVEL=debug`, `dashboard.ts:1153,1179` writes full request/response bodies to world-readable `/tmp/test_model.log`.

### Medium

- **M1 — Cross-upstream API-key forwarding.** `src/utils/sdk-handler.ts:229` **and** `:392` (two call sites) send the client's provider key to a hardcoded `https://chatjimmy.ai/api` for any `sdk://` route (key confusion / leakage to a fixed third party).
- **M2 — Upstream error bodies returned/echoed verbatim.** `errors.ts:141-161` embeds the upstream URL + up to 500 chars of the request body into client-facing errors; `embeddings.ts:53-64` returns raw upstream `errorText`. Leaks internal URLs, prompt content, and potentially echoed auth headers.
- **M3 — Partial API keys logged.** `routing.ts:267-281` logs the first 16 chars of the key; `openai.ts:116-118` logs key tails; `index.ts:822-828` logs partial key values.
- **M4 — CORS reflects arbitrary Origin.** `index.ts:84-98` reflects the request Origin when `ALLOWED_ORIGINS` is unset; `server.ts:24` defaults `ALLOWED_ORIGINS='*'`. Combined with no auth, browsers can read proxied responses cross-origin.
- **M5 — Missing timeouts on three Gemini fetches.** `gemini.ts:322-326, 503-507, 605-609` omit the abort signal used by other handlers → a hung upstream ties up the request (DoS).

### Low

- **L1 — Log injection.** `logger.ts:32-47` interpolates client-supplied strings (model, UA, error text) into `console.log` with no control-char/newline stripping.
- **L2 — Spoofable client IP.** `routing.ts:430-455` trusts `cf-connecting-ip` / `x-forwarded-for` / `x-real-ip` unconditionally; any IP-based logging/decision is forgeable.
- **L3 — Body-size check trusts `content-length`.** `index.ts:515-523` — bypassable via chunked transfer or omitted length.
- **L4 — Host header trusted for URL base.** `server.ts:44` builds the request URL from the client `Host` header.
- **L5 — Latent stored-XSS sink in dashboard.** `dashboard.ts:813,830,879` insert `model` / `tool_name` / `upstream_base_url` into HTML via `innerHTML` without escaping (the config form *is* escaped via `escapeHtml`). Currently operator/upstream-controlled data, but unsafe if any of those names become attacker-influenced.

---

## 2. Reassessment under "localhost-only dashboard + local user, TUI unset"

Assumption being evaluated: the dashboard/admin surface is reachable **only** from the local host, and the proxy process / its files are confined to a single trusted local user. **TUI unset is not itself a security control** — disabling TUI does not change which endpoints exist; the HTTP dashboard at `/dashboard` is always served regardless of TUI (`index.ts:441`).

| ID | Finding | As deployed today | Under localhost+local-user (IF truly enforced) | Why the rating changes (or not) |
|----|---------|-------------------|-----------------------------------------------|---------------------------------|
| C1 | Unauth dashboard config write | **Critical** | **Low** | Attack requires reaching `/dashboard/api/config`; if that's localhost-only, only a local actor can exploit it. Still defense-in-depth (a local low-priv process or SSRF-from-another-app could hit it). |
| C2 | Unauth `/config-reload` key dump | **Critical** | **Low** | Same network-reachability reasoning. Note keys still land in `./config-dumps/` on disk — local file exposure remains (see H4). |
| C3 | No client auth (key-bearing relay) | **Critical** | **Medium** | If *only* localhost can call the proxy, abuse is local. But many deploy the **proxy data path** (`/v1/*`) for non-local clients while keeping only the dashboard local — in that common case C3 stays **High**. Depends on whether the *whole* server is localhost-bound or only `/dashboard`. |
| H1 | Dead SSRF allowlist | **High** | **Medium** | The allowlist is meant to constrain *outbound* upstream calls; localhost-binding the inbound side doesn't restore it. Still relevant because config (local or remote) can point upstreams anywhere. |
| **H2** | **Unescaped model → upstream URL injection** | **High** | **High (unchanged)** | Lives on the normal proxy data path used by legitimate clients; not a dashboard issue. Localhost scoping does **not** help. |
| H3 | Test-model loopback SSRF | **High** | **Low** | Endpoint is part of the dashboard surface; localhost-only removes the remote vector. |
| **H4** | **Plaintext prompts/keys to predictable files** | **High** | **High → Medium** | "Single local user" reduces *cross-user* exposure, but world-readable `/tmp/test_model.log` and CWD `*.jsonl`/`config-dumps/` still violate least-privilege and survive on disk/backups. Not fixed by network scoping. |
| M1 | Cross-upstream key forwarding | **Medium** | **Medium (unchanged)** | Outbound behavior; unrelated to inbound localhost scoping. |
| M2 | Verbatim upstream error leakage | **Medium** | **Medium (unchanged)** | Returned to whoever calls the proxy data path. |
| M3 | Partial keys in logs | **Medium** | **Low–Medium** | Local-user logs reduce blast radius, but partial-key logging is still poor hygiene. |
| M4 | CORS Origin reflection | **Medium** | **Low** | Only meaningful for browser clients reaching the server; localhost binding largely neutralizes the remote browser vector. |
| M5 | Missing Gemini timeouts | **Medium** | **Medium (unchanged)** | DoS via slow upstream is independent of who the client is. |
| L1–L5 | Misc | **Low** | **Low (unchanged)** | — |

### Bottom line for the scoped deployment

- **Genuinely de-risked by localhost-only + local-user:** C1, C2, H3, M4 (and partly M3). These are dashboard/network-exposure issues whose only attacker vector is removed when the surface is truly local.
- **NOT fixed by the scoping — still serious:** **H2** (URL injection on the proxy data path), **H1** (outbound SSRF guard missing), **H4/M3** (secrets persisted to predictable, sometimes world-readable files), **M1** (key forwarded to a hardcoded third party), **M2** (error-body leakage), **M5** (DoS). These do not depend on *who* can reach the dashboard.
- **Conditional:** **C3** hinges on whether the *entire* listener is localhost-bound or only `/dashboard` is. If `/v1/*` is served to remote clients (the usual reason to run a proxy), C3 remains **High**.

### Two caveats that determine whether the scoping even holds

1. **It must be enforced, not assumed.** Today nothing in `src/` restricts the dashboard to localhost (see §0). To make "localhost-only" real, bind the listener to `127.0.0.1` (change `server.ts:123` `'0.0.0.0'` → `'127.0.0.1'`), or front the process with a firewall/reverse proxy that blocks external access to `/dashboard*` and `/config-reload`. The `isLocalhostOrigin`/CORS check is **not** an access control.
2. **"Local user" must mean file permissions too.** H4 writes secrets/prompts to `/tmp` and CWD with default perms. On a shared host, "local" is not "private." Restrict file modes / relocate these artifacts.

---

## 3. Recommended priorities

Ordered for the scoped (localhost-dashboard) deployment, highest impact first:

1. **Make the localhost assumption real (cheap, removes C1/C2/H3):** bind the listener to `127.0.0.1`, or block `/dashboard*` + `/config-reload` at the network edge. Do not rely on the CORS Origin check for access control.
2. **H2 — `encodeURIComponent` the model URL segment** (`index.ts:686-687, 703-704, 724`). Not mitigated by scoping; affects every Gemini-native request.
3. **H1 — actually call `isHostAllowed`** before every upstream `fetch` so config can't point keys at arbitrary/internal hosts.
4. **H4/M3 — stop writing secrets/prompts to predictable files**; if debug dumps are needed, use restrictive perms and a non-shared path, and never dump full keys. Also add `model_proxy_tokens.jsonl` and `config-dumps/` to `.gitignore` — both are currently untracked in the working tree (the latter contains dumped keys per C2) and could be accidentally committed.
5. **C3 — add a real authenticated check** on the proxy data path *if* `/v1/*` is exposed beyond localhost (compare against a configured secret with a constant-time comparison, not mere header presence).
6. **M2 — sanitize upstream error bodies** before returning them to clients.
7. **M5 — add the abort/timeout signal** to the three Gemini fetches.

---

*This document is a security assessment only by `claude-opus-4-8`. No source files were modified in producing it.*
