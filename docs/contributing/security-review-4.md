# Security Review 4 — `src/`

**Scope:** full `./src/` tree on branch `feature/fusion`, current as of 2026-07-12 (HEAD `41bcd23`).
**Method:** read-only review. Re-verifies open findings from `security-review-3.md` (2026-07-06, baseline `e26a3ab`) against current code, plus the code changed since then (commits `d28fe1b`, `53632e7`, `dceda9b`, `cc95fdc`: model-name escaping for Gemini upstream, thinking-budget clamping vs max_tokens, `budgetToReasoningEffort` extraction, short request-id logging).
**Date:** 2026-07-12

> Net change since the last review: **H2 (unescaped model name in upstream URL) is fixed on the main routing paths** — commit `d28fe1b` introduces `safeModel = encodeURIComponent(upstreamModelName)` and uses it at all 8 previously-flagged interpolation sites. However a **residual variant remains in `parseFixedRoute`** (default-route builder), see **R1**. The two other genuinely exploitable items from review 3 are still open and unchanged: **N1** (full API key logged at debug, `sdk-handler.ts:243`) and **H4** (secrets/prompts to predictable files — the token log has grown to 43.8 MB and is still not gitignored). No new vulnerability was introduced by the thinking-budget or logging changes.

---

## 1. Status of prior findings

### High

- **H2 — Unescaped model name in upstream URL → FIXED on flagged sites (commit `d28fe1b`), residual variant remains (see R1).**
  `index.ts:1002/1262` now compute `const safeModel = encodeURIComponent(upstreamModelName)` and every previously-flagged URL build uses it: `index.ts:1046-1047, 1063-1064, 1077, 1093, 1307-1308, 1321-1322, 1331, 1344`. `grep` confirms no remaining `${upstreamModelName}` interpolation into URLs in `src/`. Path/query injection via `body.model` on the model-specific and composite routing paths is closed.
  **Residual:** the *default-route* builder `parseFixedRoute` still interpolates a **URL-decoded** model ID without re-encoding — tracked as **R1** below.

- **N1 (review 3) — API key logged in plaintext at debug level → STILL PRESENT (High).** `sdk-handler.ts:243`:
  ```ts
  activeLogger.debug(requestId, `Using SDK client config: ${JSON.stringify(config)}`);
  ```
  `config` (built at `sdk-handler.ts:230-240`) includes `apiKey: apiKey || ''`. At `LOG_LEVEL=debug` the **full upstream API key** goes to the console log. Line number shifted 242→243 by the `budgetToReasoningEffort` import; the finding is otherwise unchanged from review 3. The parallel Claude-SDK path (`sdk-handler.ts:400-406`) builds the same config object but does *not* log it — only the OpenAI path leaks. **Fix:** redact `apiKey` before stringifying, or drop it from the logged object.

- **H4 — Plaintext prompts/keys to predictable files → STILL PRESENT (High, still growing).**
  - `./model_proxy_tokens.jsonl` (`TOKEN_LOG_FILE`, `dashboard-stats.ts:304`, written at `dashboard-stats.ts:417,490`) is now **43.8 MB**, world-readable (`-rw-r--r--`), untracked, and **still not in `.gitignore`** (checked this pass: `.gitignore` lists only `.claude/`, `.wrangler/`, `node_modules/`, `dist/`, `docs/test_keys.md`, `.git_audit_before_commiting`, `.env`, `.kiro`, `tests/.fuse_*`).
  - `./config-dumps/` (full config incl. API keys, `dumpProxyConfigToml` at `config-loader.ts:1737`, called from `index.ts:514`) — also still not gitignored.
  - `/tmp/test_model.log` debug dumps: the previously-flagged `dashboard.ts:1881,1907` sites remain, and this pass also inventoried the same pattern at `index.ts:1659-1672` (full request body + auth-header names for every `/v1/messages` request at debug), `messages.ts:191,342` (upstream response bodies when the request contains `test_tool`), and `tui.ts:1810,1837`. All write client prompt/response content to a predictable world-readable `/tmp` path. All are gated on `LOG_LEVEL=debug`, but that is an operational toggle, not a security boundary.

- **H1 (residual) — SSRF allowlist only on dynamic routes → UNCHANGED.** `isHostAllowed` is called only at `index.ts:1195` for `/http/...`,`/https/...` dynamic routes. Fixed routes (config-defined `base_url`) are still not validated against the allowlist. Unchanged from review 3; admin surface for changing `base_url` remains loopback-gated, so this stays Medium-context.

### Medium

- **M4 — CORS reflects arbitrary Origin → STILL PRESENT.** `server.ts:25` still defaults `ALLOWED_ORIGINS='*'`; `getCorsOrigin` (`index.ts:151-`) reflects the request origin when unset. Combined with no caller auth on `/v1/*` (C3), any browser origin can read proxied responses. Unchanged.

- **M5 — Missing Gemini timeouts → UNCHANGED.** `gemini.ts:138` and `gemini.ts:257` carry `createUpstreamAbortSignal(...)`; the three fetches at `gemini.ts:374, 555, 657` still have **no abort signal** (re-verified this pass). A hung upstream on the Gemini→OpenAI and native-Gemini paths still ties up the request indefinitely.

- **M1 — `sdk://` key forwarding → UNCHANGED.** `sdk-handler.ts:401-402` still builds `baseURL` from the config-controlled `sdk://` target and attaches the caller's key. Operator-controlled config; residual risk unchanged. The exploitable half of this finding is N1 (the debug log), above.

### Low / informational

- **C3 — No real client auth → UNCHANGED (intentional design).** `validateAuthHeaders` (`validation.ts:492`) is presence-only and still called only from token-counting (`token-counting.ts:66`). Still safe only while the listener is loopback/trusted-network only.
- **M3 — Partial API keys logged → UNCHANGED (acceptable).** `routing.ts:313-322` logs 4-char prefixes only.

---

## 2. New findings (code changed since 2026-07-06)

- **R1 — Residual model-name URL injection in `parseFixedRoute` (Medium).** The default-route builder decodes the model segment from the URL path and re-interpolates it **without re-encoding**:
  - `index.ts:306` → `310`: `modelId = decodeURIComponent(modelMatch[2])` → `` `${defaultBaseUrl}/${apiVersion}/models/${modelId}:countTokens` ``
  - `index.ts:333` → `346`: same pattern for `:generateContent`/`:streamGenerateContent`.

  The regex capture `([^:?]+)` runs against the still-encoded `url.pathname`, so it excludes literal `:` and `?` — but a client can smuggle them percent-encoded (e.g. `/v1beta/models/x%3AgenerateContent%3Fkey%3DATTACKER%23:generateContent`): after `decodeURIComponent` the raw `:`/`?`/`#`/`/` characters land in the upstream URL. This is the same bug class as H2, on the path taken when the model has **no model-specific config** (default routing, `index.ts:1158,1207`) with a Gemini-native default mode. Lower severity than the original H2 because it requires the fall-through default route + gemini default mode, but the fix is the same one already applied elsewhere: interpolate `encodeURIComponent(modelId)` (or the still-encoded `modelMatch[2]`) at `index.ts:310,346`.

  Related, minor: `buildTargetUrl` (`routing.ts:227-235`) also interpolates the dynamic-route `modelId` unencoded, but that path segment never went through `decodeURIComponent` and the host is allowlist-checked (`index.ts:1195`), so only path-level smuggling within an allowed host is possible. Defense-in-depth only.

- **R2 — Thinking-budget clamp (`clampThinkingBudget`) — CHECKED, SAFE.** `validation.ts:307-332` clamps `thinking.budget_tokens` down to `max_tokens`; throws a `ValidationError` when `max_tokens < 1024` (fail-loud, good). The interleaved-thinking exception is gated on the client-supplied `anthropic-beta` header via `validateBetaFeatures`/`hasBetaFeature` (`messages.ts:233-234`, `token-counting.ts:61-62`) — client-controlled, but the only effect is *skipping a client-favorable clamp*, i.e. the request is forwarded with the budget the client asked for, matching upstream API semantics. No trust-boundary issue. `validateBetaFeatures` (`beta-features.ts:34-66`) drops unknown feature strings rather than forwarding them, and header values are stripped of `\r\n\0` on the raw-forward fallback (`routing.ts:281,398`) — no header injection.

- **R3 — `budgetToReasoningEffort` extraction — CHECKED, SAFE.** Pure numeric mapping (`claude-to-openai.ts:186-217`); replaces three previously-duplicated inline ternaries (`messages.ts:134,306`, `sdk-handler.ts:220`). Thresholds come from operator config parsed through `parseInt` with `isNaN` guards (`index.ts:1683-1701`). No injection surface.

- **R4 — Short request-id logging — CHECKED, SAFE.** `shortRequestId` (`logger.ts:28-32`) is display-only truncation of a **server-generated** id; regex is anchored and linear (no ReDoS), non-matching ids pass through unchanged. No security impact.

- **R5 — `/tmp/test_model.log` writer inventory expanded (folds into H4).** Debug-gated plaintext dumps of request/response bodies exist at `index.ts:1659-1672`, `messages.ts:191,342`, `dashboard.ts:1881,1907`, `tui.ts:1810,1837`. Review 3 listed only the dashboard sites; the full set should be remediated together (non-shared path or removal, restrictive file mode).

---

## 3. Checked and found safe (this pass)

- All 8 previously-flagged model-URL interpolation sites now use `encodeURIComponent` (`index.ts:1046-1093, 1307-1344`); no `${upstreamModelName}` remains in any URL template.
- Beta-header handling: unknown features dropped, CR/LF/NUL stripped on fallback forwarding — no header injection via `anthropic-beta`.
- `clampThinkingBudget`: fail-loud on unclampable input; client-controlled beta header can only relax a client-favorable clamp.
- `budgetToReasoningEffort` and its config thresholds: numeric-only, NaN-guarded.
- `shortRequestId`: anchored regex on server-generated input, display-only.
- Loopback gate on `/config-reload` and `/dashboard*` (`index.ts:492-503`) unchanged and still in place; `x-client-address` still server-injected at `server.ts:67-72`.
- `eval` / `Function()` / `child_process` / dynamic `require` from request data: none found in `src/`.

---

## 4. Recommended priorities (highest impact first)

1. **N1 — stop logging `config` (incl. `apiKey`) verbatim** at `sdk-handler.ts:243`. One-line fix; leaks the full upstream key at debug level. [FIXED]
2. **H4 — secrets/prompts to predictable files.** Add `model_proxy_tokens.jsonl` and `config-dumps/` to `.gitignore` immediately (the token log is 43.8 MB, world-readable, and one `git add -A` away from being committed). Move or remove all six `/tmp/test_model.log` writers (R5 inventory); restrict file modes. [FIXED]
3. **R1 — re-encode the model segment in `parseFixedRoute`** at `index.ts:310,346` — same fix already applied everywhere else by `d28fe1b`. [FIXED]
4. **M5 — add abort signals** to the three remaining Gemini fetches (`gemini.ts:374, 555, 657`). [FIXED]
5. **H1 (residual) — extend `isHostAllowed` to fixed routes** so a config-defined `base_url` pointing at an internal host is rejected. [FIXED]
6. **M4 — set a real `ALLOWED_ORIGINS` default** instead of `'*'` at `server.ts:25`.
7. **C3 (residual) — add a real caller-credential check** on `/v1/*` if the listener is ever exposed beyond localhost.

---

*Read-only review. No source files were modified in producing it.*
