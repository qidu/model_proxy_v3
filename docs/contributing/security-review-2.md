Security Review — src/

  Scope: full src/ tree (converters, handlers, utils, index.ts, server.ts). Two focused sub-reviews + direct verification of key claims.

  High

  H1 — FIXED — Secret-masking bug logs API key suffixes at debug level
  src/handlers/openai.ts:129-131, 197
  Was: activeLogger.debug(requestId, `Authorization: ${authTokenIn.substring(64)} at endpoint`); (and the x-api-key/x-goog-api-key/upstream variants).
  .substring(N) returns everything after index N, not a truncated prefix (the likely intent). For keys longer than 64/32 chars, this wrote the tail of the real secret
  to logs whenever LOG_LEVEL=debug.
  Fix applied: all four call sites now use `.substring(0, 16) + '...'`, matching the truncated-prefix pattern already used elsewhere (messages.ts:310-314).

  H2 — No client-facing API key validation; proxy authenticates upstream on caller's behalf for models.free
  src/index.ts:670-683 — auth gate is presence-only (hasAuth just checks a header is non-empty; no comparison against any allow-list of valid keys — no such list exists
  anywhere in src/). Combined with models.free semantics (src/index.ts:943,1197, documented in README.md:219 as intentional: "the proxy authenticates upstream on the
  caller's behalf — this is what makes the FREE tier work"), any bogus bearer token reaches real upstream models paid for by the proxy owner. Fusion aliases fan out to
  panel + judge + synth upstream calls per single client request, multiplying cost/DoS blast radius.

  This appears to be an intentional design tradeoff (documented feature), not an oversight — but it means the proxy is only safe to expose to a trusted network/caller
  set. If this proxy is (or could become) reachable from the open internet, this is a real cost-abuse/DoS vector.
  Fix direction: if internet-facing, add a real caller-credential check (proxy-issued key compared with constant-time equality) before permitting free/fusion routing,
  plus per-key rate limiting.

  Medium

  M1 — Upstream error bodies/content logged verbatim, unredacted
  src/handlers/claude.ts:132, messages.ts:212,358, gemini.ts:150,269 log up to 2000 chars of raw upstream error bodies (potentially containing user PII) at error level.
  Not returned to the client (client responses are properly sanitized — verified in errors.ts), but logger.ts has no redaction layer, so any future call site can leak
  secrets by construction.

  M2 — Debug sink writes full response bodies to a fixed, unauthenticated /tmp path
  src/handlers/messages.ts:188-197,334-343 — appendFileSync('/tmp/test_model.log', ...) when LOG_LEVEL=debug. Bypasses the structured logger/redaction entirely;
  predictable path, default /tmp permissions.

  M3 — NOT A BUG — No global request body size cap on several handlers (finding was stale)
  chat-completions.ts:27 (request.text()), embeddings.ts:26, Gemini/Responses paths — appear to read the full body into memory with no cap when viewed in isolation.
  Verified: a global 10MB body-buffering cap already exists at src/index.ts:704-739 (added in commit ba82cfb6, "fix(proxy) hard limit body size"), enforced before
  dispatch to every handler (chat-completions, embeddings, Gemini, Responses all pass through it). Content-Length is checked first when present, then the body is
  streamed into a bounded buffer and the Request is reconstructed. No fix needed; original finding predates that commit.

  M4 — FIXED — Fragile (currently safe) key-copy pattern in config merge
  src/utils/config-loader.ts (validateAndNormalizeDashboardModels, validateAndNormalizeComposite, applyDashboardConfigUpdate) copies request-body keys via Object.entries
   into plain objects. No exploitable prototype pollution existed (JSON.parse makes "__proto__" an own, non-magic property, and no generic/recursive merge utility touched
  these objects), but there was no explicit denylist, so a future refactor to a generic merge could have silently reintroduced the risk.
  Fix applied: added a `DANGEROUS_KEYS` denylist (`__proto__`, `constructor`, `prototype`) and an `assertSafeKey()` helper, called at all four key-copy sites
  (composite alias/key, dashboard model category/key, and the rebuild loop in applyDashboardConfigUpdate) as defense in depth.

  Low

  - L1 — config_path disclosed to any loopback caller via dashboard snapshot (dashboard.ts:104) — minor path-disclosure, gated behind the loopback-only dashboard access
  check.
  - L2 — Dashboard access relies solely on a loopback-IP header check (index.ts:486-497), no secondary shared-secret. Safe today because server.ts overwrites the header
  from the real socket, but adding a DASHBOARD_TOKEN would be defense-in-depth.
  - L3 — validateAuthHeaders (validation.ts:445) is only invoked from token-counting.ts, not from the other handlers — those rely on upstream auth resolution rather than
   a local check (not independently exploitable, just inconsistent).

  Checked and found SAFE

  - SSRF (routing.ts isHostAllowed/dynamic route parsing): uses WHATWG URL canonicalization consistently for both the check and the actual fetch; no decimal/octal/hex IP
   bypass, no wildcard-suffix substring bug.
  - Path traversal: all config-dump / token-log file paths are server-controlled (env vars, Date.toISOString()), never request-derived.
  - Secret redaction in dashboard responses: api_key/default_api_key consistently stripped before returning config; test-model endpoint never echoes the key.
  - Client-facing error responses (errors.ts): deliberately avoid echoing raw upstream body/PII to the client (comment confirms this was a prior fix); only a narrow,
  validated error.message field is surfaced.
  - Fusion recursion guard (x-fusion-depth header, index.ts:1367): correctly blocks self-referential loops even through a base_url pointing back at the proxy itself.
  - eval/Function()/child_process/dynamic require: none found anywhere in src/.
  - ReDoS: all user-input-facing regexes (thinking-tag extraction, TOML parsing, beta-feature validation) use bounded/non-nested lazy quantifiers — no
  catastrophic-backtracking shape found.
  - beta-features.ts, conversation-store.ts, fetch-timeout.ts: whitelist validation, TTL+hard-cap memory bound, and AbortSignal.timeout-bounded upstream fetches all
  implemented correctly.
  - CORS: not reachable from the files reviewed for this pass — flagging as unverified rather than safe (would need a follow-up pass on server.ts/index.ts CORS branch
  specifically if that's a priority).

----
reviewed and partialy fixed by `sonnet-5`
on Jul 1
