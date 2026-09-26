# Plan: Integrate LLM-as-a-Verifier as a best-of-N selection plugin

## Goal

Use [`llm-as-a-verifier`](https://github.com/llm-as-a-verifier/llm-as-a-verifier) (`~/dev/bot/llm-as-a-verifier`)
as a plugin for this proxy so a request can be answered by the **best of N candidate responses**
instead of the first one: sample one target model N times, rank the samples with a Probabilistic
Pivot Tournament (PPT) scored from token logprobs, and return the winner **verbatim**.

Constraints taken as given for this plan:

- **The `fusion` module is not modified.** No changes to `runFusion`, `resolveFusionPlan`,
  `FusionRole`, or `FusionOptions`. `verifier` is a **sibling strategy at the same routing level**.
- **The verifier prefers the same model** for generation and for scoring, routed through this proxy.
- **The proxy never fans out.** Generation and selection both happen inside the sidecar; the proxy
  makes exactly one outbound call per verified request.
- **Access control**: the proxy serves the sidecar only the configured target models, and only from
  the sidecar itself.

## The flow

```
  Claude Code
      │  POST /v1/messages            model = "claude-best5"      ← verifier alias (Level 2)
      ▼
  ┌─────────────────┐
  │ model_proxy_v3  │  resolves alias → target model + verifier options
  │     :8788       │
  └────────┬────────┘
           │  POST /select   {model:"deepseek-v4-flash", problem, samples:5, ...}
           │  one_time_auth_code: otac_…  (capability)   x-request-id: req_…  (correlation)
           ▼
  ┌─────────────────┐
  │ verifier sidecar│   ① generate: 5 × sampling calls  ─┐
  │     :8790       │   ② score:    PPT logprob calls   ─┤ all back through the proxy,
  │  (Python)       │   ③ select:   winner verbatim     ─┘ naming the TARGET model
  └────────┬────────┘
           │  each call: one_time_auth_code (echoed)  ·  x-request-id (inherited)
           │             user-agent: llm-verifier-sidecar/…  ·  x-forwarded-for
           │             NO Authorization of its own
           ▼
  ┌─────────────────┐
  │ model_proxy_v3  │  Level 1 [models.*] → real upstream
  │     :8788       │  guard: sidecar-origin + OTAC grant + per-grant allowlist
  │                 │  credentials: replayed from the original request
  └─────────────────┘
           │
           ▼  winner returned verbatim, unwrapped, for "claude-best5"
        Claude Code
```

### Why this terminates — no depth counter needed

The sidecar's re-entrant calls name the **target model** (`deepseek-v4-flash`), not the alias.
That is a plain `[models.*]` entry, so `getCompositeAliasMode` (`config-loader.ts:826`) returns
`undefined` for it and routing goes straight to Level 1. **The recursion terminates structurally,
by naming** — there is no composite lookup to re-enter.

This is stronger than fusion's `x-fusion-depth` guard (`src/index.ts:1894`), which is needed
because fusion's panel targets re-enter the router and *may themselves* be composites. Here they
cannot be. A depth header is still set as a belt-and-braces guard against a misconfiguration where
the target of a verifier alias resolves back to that alias. That case is also reported by
[config-load validation](#config-load-validation) — which reports rather than blocks, so the depth
header and the existing `visited` cycle detection in `getModelRouteConfig` are what actually contain
it.

### What this design removes

Compared with a proxy-side fan-out:

- **No duplicated fan-out logic.** Batching, per-call timeouts, `min_*` floors, and depth capping
  are not reimplemented — the earlier draft's ~100-line duplication of `runFusion` (a CLAUDE.md
  rule #4 violation) is gone, along with the "extract a shared helper later" follow-up it required.
- **No `samples`-expansion in the config layer.** `samples = 5` is a number forwarded to the
  sidecar, not N synthetic panel entries. This sidesteps the fact that composite targets are object
  keys (`getCompositeTargetEntries`, `config-loader.ts:490`) and a repeated model name would
  silently overwrite (`config-loader.ts:3228`).
- **Sampling concurrency is Python's problem.** `select()` is already thread-pooled with a
  `max_workers` knob.

The proxy-side change is now: one additive branch in `getCompositeAliasMode`, one
`resolveVerifierPlan`, one call to the sidecar, one access guard.

---

## Background: what the upstream pieces actually are

- **`llm-as-a-verifier`** is a **Python library**, not a proxy. It exposes `select()` (best of N),
  `compare()` (raw pairwise reward), and `track()` / `ProgressTracker` (per-step progress).
- **[TurboAgent](https://github.com/llm-as-a-verifier/TurboAgent)** is the proxy wrapper around
  that library. It is a **peer of this proxy, not a component of it**.

### TurboAgent is out of scope — deliberately

TurboAgent bundles an Anthropic-compatible endpoint, fan-out to N candidates, and PPT selection.
This proxy already has the first natively (README §API Endpoints); under this design the second and
third both live in the sidecar. Chaining them
(`Claude Code → TurboAgent:8888 → model_proxy_v3:8788 → upstream`) would mean two proxies, two
configs, and two model-alias namespaces — with TurboAgent's routing driven by *its own* config
rather than the request, fighting this proxy's `[models.*]` layer. **Do not chain.**

### `select()` does not generate — the sidecar must

`llm_verifier.select(problem, candidates, ...)` takes candidates as an **argument**
(`llm_verifier/__init__.py:116`). It ranks; it does not produce. So the sidecar owns a
generate-then-select endpoint: N sampling calls, then `select()` over the results. This is new code
beyond a thin `select()` wrapper, and it is the main sidecar-side work item.

## Why a sidecar

1. `llm-as-a-verifier` is Python; this proxy is TypeScript. A `fetch` to an external URL keeps the
   two decoupled, matching `privacy-filter` and `kompress`.
2. Verification is **logprob-driven** and the reward math plus tournament is a research artifact we
   would otherwise reimplement in TS and keep in sync with upstream.
3. It matches the established convention: inert unless its `*_URL` is set
   (`src/utils/kompress.ts:41`), so existing behavior is unchanged by default.

Note: `submodules/{chatjimmy,kompress,privacy-filter}` are all currently **empty** on this checkout
(submodules not initialized). Any build/verify step below assumes `git submodule update --init`.

---

## Verifier as a Level-2 strategy

The README documents **three logic levels** (§Routing Hierarchy). `verifier` slots in at **Level 2,
beside `fusion`**, and re-routes to Level 1 as the others do:

| Level | Section | Selects by | Cardinality | Re-routes to |
|:-----:|:--------|:-----------|:------------|:-------------|
| 2 | `[composite]` (fusion) | Role + `fusion_options` | 1 → N → 1 (panel×N + judge + synth) | Level 1 |
| 2 | `[composite]` (**verifier**) | `verifier_options` | 1 → **sidecar** → 1 (**winner verbatim**) | Level 1 (via sidecar) |

### Why a sibling and not a fusion role

Beyond the "don't modify fusion" constraint, the two are semantically different:

- **fusion** ends with a **synth model writing a new merged answer** (`src/index.ts:2024`), guided
  by judge JSON of `consensus` / `contradictions` / `blind_spots` (`src/index.ts:1974`).
- **verifier** ends with **one candidate returned byte-for-byte**. Nothing is rewritten.

A verifier is therefore not a drop-in for the `judge` role — it would replace judge *and* synth.
Keeping them siblings avoids making `FusionPlan.synth` optional (`config-loader.ts:893` currently
guarantees it via `synth = judge ?? panel[0]`) and leaves the shipped fusion path untouched.

`getCompositeAliasMode` (`config-loader.ts:826`) is the dispatch point; the new mode is detected
before the `fusion` branch by the presence of `verifier_options`, and the existing `isFusion` test
is left exactly as written.

---

## Configuration — worked example

Three surfaces must agree: the proxy's TOML (alias + target routing), the proxy's env (where the
sidecar is and who may call back), and the sidecar's env (where its LLM endpoint is). They are
shown together because the failure modes are all *mismatches between* them.

### 1. Proxy TOML — the target model's Level-1 route

The alias is Level 2, but what actually gets called is the **target model's `[models.*]` entry**.
In `proxy_config.example.toml` the relevant entry already exists and already satisfies the scorer
constraint:

```toml
[models.default]
upstream_mode = "openai-completions"          # ← the scorer requirement, already met
base_url = "https://api.qnaigc.com"

deepseek-v4-flash = {base_url = "https://api.deepseek.com", api_key = "sk-66c13986be87488"}
deepseek-v4-pro   = {base_url = "https://api.deepseek.com", api_key = "sk-66c13986be87488"}
```

`[models.*]` sections are **category groups keyed by upstream mode**, not one section per model.
Because `[models.default]` is already `openai-completions`, any model routed there can serve as
both target and scorer with **no new `[models.*]` entry at all** — the earlier draft of this plan
invented a `deepseek-v4-flash-verify` entry that is not needed. A separate entry is required only
when the target sits in a non-`openai-completions` section (e.g. `[models.claude]`) and you want to
keep generating there while scoring elsewhere.

### 2. Proxy TOML — the verifier alias

```toml
[composite]
# Level 2, sibling of fusion. One target model, five samples, self-scored.
"claude-best5" = {verifier_options = {samples = 5, temperature = 1.0, n_evaluations = 4, pivots = 2, criteria = "swe_bench", otac_max_reuse = 80}, "deepseek-v4-flash" = {verifier = 1, role = "target"}}

# Split roles: generate on a Claude route, score on an openai-completions route.
"claude-best3-split" = {verifier_options = {samples = 3, temperature = 1.0}, "claude-sonnet-4-5" = {verifier = 1, role = "target"}, "deepseek-v4-pro" = {verifier = 1, role = "scorer"}}
```

Mirrors the shipped fusion entry (`proxy_config.example.toml:286`): `verifier_options` for the run,
`verifier = 1` to mark participation, `role` to assign the job.

| Field | Meaning |
|---|---|
| `role = "target"` | The model sampled `samples` times. Any `upstream_mode`. |
| `role = "scorer"` | The model scoring pairs. **Must resolve to `openai-completions`.** Omit to reuse the target's route — accepted only if that route is already `openai-completions`, as in `claude-best5` above. |
| `samples` | N candidates. Flagged by config validation if `< 2` (report-only — see below). |
| `temperature` | Sampling spread. Flagged if `0`, which would make N identical samples (report-only). |
| `n_evaluations` / `pivots` | K repeats and pivot count — the cost knobs from the table below. |
| `criteria` | Benchmark name or criteria-file path passed to `select()`. |
| `otac_max_reuse` | Upper clamp on how many times this alias's OTAC grant may be redeemed. Optional; omit to use the computed bound. A value below the derived bound is **reported by config validation and enforced by the pre-dispatch admission check** — validation in this proxy logs, it does not block (`config-loader.ts:2486`, `:3035`), so the admission check is the enforcement point, not a backstop. Never enforced mid-tournament. See below. |

`claude-best5` is the "prefer the same model" case: one name, both roles, `openai-completions`
throughout.

#### `otac_max_reuse` — the per-alias redemption ceiling

The grant's `remainingCalls` is normally **derived**, not configured: `samples` generation calls plus
the tournament's comparison count (the cost table below), times `VERIFIER_CALL_MARGIN`. That is the
right default, because the proxy already knows the exact shape of the run it is authorizing.

`otac_max_reuse` is an **upper clamp** on that derived number, not a replacement for it:

```
remainingCalls := min(ceil((samples + maxScoringCalls) × VERIFIER_CALL_MARGIN), otac_max_reuse ?? ∞)
```

Clamping rather than overriding matters: if an operator sets it *above* what the run needs, the
derived bound still wins and the extra headroom is inert. A too-generous value cannot silently
widen the capability.

Two reasons an operator would set it. First, a **cost circuit-breaker** per alias: `claude-best5`'s
derived bound is 67 at `VERIFIER_CALL_MARGIN = 1.25` (5 generations + 12 comparisons × K=4 = 53,
rounded up by the margin), so `80` sits just above it and caps blast
radius if a future config change inflates `samples` or `n_evaluations` without anyone re-reading the
cost table. Second, **defence in depth against a compromised sidecar** — the derived bound already
limits redemptions, but it is computed from values the sidecar's own request influenced; the clamp
is a number only the proxy's TOML can set.

##### The ceiling is an admission check, never a mid-flight cutoff

A ceiling set *below* the derived bound must be caught **before `/select` is dispatched**, not by
401ing calls once the tournament is running. Enforcing it mid-flight is actively harmful, and the
reason is specific to how the library handles failures.

`select()` defaults to `on_error="tie"`, which **swallows a failed scoring call and scores it
0.5/0.5** (`llm_verifier/fine_grained_reward.py:827`, `:920-921`). The exception never propagates.
So a ceiling hit part-way through a tournament produces:

- N generation calls that **already succeeded** — the candidates are shipped, paid for, and correct
- 401s landing on *scoring* calls, each silently degrading to a tie
- a completed tournament, a returned winner, and an HTTP 200

The winner is then partly or wholly **arbitrary, and indistinguishable from a real selection**. This
is the same silent-failure class as a scorer route that strips logprobs, and it must be closed the
same way: never let a credential decision corrupt a result that already cost real tokens.

Hence three rules, which together mean the ceiling can never silently degrade an answer:

1. **Admission check.** If the derived bound would exceed `otac_max_reuse`, the alias is
   misconfigured — refuse to dispatch `/select` at all and fail open to a single plain call to the
   target model, with a warning naming the alias and both numbers. Nothing is spent discovering
   this.

   **This check is load-bearing, not belt-and-braces — verified against the current code.**
   An earlier draft of this plan called a binding ceiling "rejected at config load" and treated this
   check as a redundant backstop. That was wrong about the proxy's actual behavior.
   `validateProxyConfig` (`config-loader.ts:1853`) is called from
   `loadProxyConfig` (`:2486`) and from the TOML parser (`:3035`), and **neither call site throws**.
   Both do exactly the same thing with the result:

   ```ts
   const validation = validateProxyConfig(config);
   for (const err of validation.errors) {
     const level = err.message.includes('Routing cycle detected') ? '[FATAL]' : '[ERROR]';
     console.error(`${level} ${err.path}: ${err.message}`);   // logged, then execution continues
   }
   // …errors stashed on config._validationErrors and returned to the caller
   ```

   The errors are logged and attached to `_validationErrors`, whose only reader in `src/` is the TUI
   (`tui.ts:1371`) — a display surface. Even the `[FATAL]` label on a routing cycle is **just a
   string in a log line**; nothing branches on it. So a config carrying validation errors still
   loads, and `/config-reload` (`index.ts:717`) returns `{"status":"ok"}` for it, because its
   `try/catch` only fires on fetch/parse failures, not on validation errors.

   The consequence for this plan: **config-load "rejection" cannot be assumed to prevent a bad
   ceiling from reaching dispatch.** Either the new validation must be made to actually throw —
   a change to shared config machinery, affecting every existing validation error, outside this
   plan's additive-only scope — or the pre-dispatch check is what genuinely enforces the ceiling.
   This plan takes the second path: validation reports, and the admission check enforces.
2. **`on_error="raise"` on the sidecar's `select()` call.** A 401 must abort the tournament loudly
   rather than tie it. This is a one-line sidecar choice with a large correctness payoff and is
   worth making independently of the ceiling: it also covers upstream outages and rate limits, which
   would otherwise be laundered into ties the same way.
3. **Mid-flight exhaustion fails open.** With (1) and (2) in place, hitting the ceiling mid-run means
   a *looping sidecar*, not a tight bound. The sidecar aborts, the proxy falls back to one plain
   call, and the event is logged as a warning — the same path as a sidecar outage, never a 401
   surfaced to the client and never a tie-corrupted winner.

Validated at config load alongside `samples` and `temperature`: non-integers, values `< 1`, and any
value **below the derived bound** each emit a validation error naming the alias and both numbers.
Earlier drafts of this plan accepted a binding value with only a warning, on the grounds that
deliberately throttling an alias is legitimate; that reasoning does not survive rule (1). A ceiling
that can never be honored at runtime without corrupting results is not a throttle, it is a
misconfiguration. To genuinely reduce an alias's cost, lower `samples` or `n_evaluations` — the knobs
that change what the run *needs*, rather than capping what it is *allowed*.

**What "validation error" buys, precisely.** Per the finding under rule (1), `validateProxyConfig`
errors are logged and stashed, never thrown, so this entry does not stop the config from loading and
does not make `/config-reload` return non-200. Adding the check is still worth it — it is how an
operator learns the alias is wrong, via the log line and the TUI's validation panel — but the plan
must not lean on it for safety. The order is:

| Surface | What it does | What it does **not** do |
|---|---|---|
| Config-load validation | Logs `[ERROR]`, stashes on `_validationErrors`, surfaces in the TUI | Block load; fail `/config-reload`; prevent dispatch |
| Pre-dispatch admission check | Refuses `/select`, falls open to one plain call, warns | Nothing — this is the enforcement |

This is a deliberate scope decision, not an oversight. Making validation throw would change shared
config machinery for *every* existing validation error — and `config-loader.ts:3048-3053` documents
why it currently does not: `parseSimpleToml` runs both for normal loading and for the integrity
round-trip inside `persistProxyConfigToPath`, so throwing there would block every mutation save. That
is a separate decision for the proxy's owners, out of scope here (CLAUDE.md rule #5: surfaced, not
silently worked around).

**This generalizes beyond `otac_max_reuse`.** Every "rejected at config load" guard this plan adds —
scorer route not `openai-completions`, `samples < 2`, `temperature = 0`, alias cycles (see
*Config-load validation* below) — has the same property: it reports, it does not block. Each one
therefore needs a runtime counterpart or an accepted failure mode. The scorer-route guard is the one
that matters most, because a non-`openai-completions` scorer strips logprobs and yields all-ties —
silent corruption, exactly the class rule (1) exists to close. It is handled the same way: checked
again before dispatch, failing open to a plain call rather than running a tournament that cannot
produce a real ranking.

### 3. Proxy env — sidecar location and callback trust

```bash
VERIFIER_URL=http://127.0.0.1:8790      # unset ⇒ plugin entirely inert
VERIFIER_SIDECAR_IPS=127.0.0.1,::1      # matched against x-client-address (real socket peer)
VERIFIER_TIMEOUT_MS=300000              # covers N generations + the whole tournament
VERIFIER_FAIL_OPEN=true                 # sidecar down ⇒ one plain call to the target model
```

### 4. Sidecar env — endpoint only, no credentials, no model

The library builds its client from the environment: `create_client` (`fine_grained_reward.py:167`)
checks `OPENAI_BASE_URL` **first**, so pointing it at the proxy is purely configuration.

```bash
# The only required setting. The /v1 suffix is required — the OpenAI SDK
# appends /chat/completions to it (matches the library's own documented
# example at llm-as-a-verifier/README.md:63).
OPENAI_BASE_URL=http://127.0.0.1:8788/v1

python submodules/llm-as-a-verifier/serve.py --port 8790
```

The sidecar is deliberately **stateless about both identity and model**. Everything else arrives
per-request in the `/select` body and headers, because the proxy is the component that actually
knows them:

| What | Where it comes from | Why not sidecar config |
|---|---|---|
| **Scorer model** | `/select` body, from `verifier_options`/`role = "scorer"` | The proxy resolved the alias; a startup flag would be a second source of truth that can silently disagree with the TOML. Different aliases can use different scorers against one sidecar. |
| **Target model** | `/select` body, echoed on each callback | Same — per-alias, not per-process. |
| **Credentials** | Never held; see below | The sidecar has no basis to choose a key; the proxy already applies its own `user_key` / `config_key` policy. |

**No `OPENAI_API_KEY`.** The sidecar does not hold upstream credentials at all. It echoes the
`x-request-id` it was given plus the target model id, and the proxy re-applies whatever key policy
that original request resolved to. This is strictly better than giving the sidecar a key: a static
sidecar key would override the caller's key on `[models.default]` (where the caller's key wins) and
silently bill every user's verification traffic to one account.

**The library's `DEFAULT_MODEL` must never be reached.** It is `gemini-2.5-flash`
(`fine_grained_reward.py:26`), which returns no logprobs — falling back to it ties every pair
0.5/0.5 while still returning a plausible answer. The sidecar therefore rejects a `/select` body
with no scorer model rather than defaulting (CLAUDE.md rule #8).

### Credential handling: one-time auth code (OTAC)

The flow — sidecar holds no key, proxy re-applies the original request's policy — **requires a
proxy-side component that does not exist today.** Stating this plainly because it is the one part
of this plan that is new mechanism rather than new configuration:

- `transformAuthHeadersForUpstream` (`routing.ts:349`) derives the upstream key from
  `request.headers` on the **live inbound request**. Its `requestId` parameter is used only for
  logging (`routing.ts:366`) — it is not a lookup key.
- There is no store keyed by request id. The in-memory maps in `dashboard-stats.ts` and
  `conversation-store.ts` hold statistics and conversations, never credentials.

#### Why the request id must not be the credential

The obvious shortcut is to let `x-request-id` itself authorize the callback. It should not, for
three reasons:

1. **It is not secret.** The request id is a logging identifier — it appears in `logger` output at
   every level, is forwarded to the auth sidecar as `request_id` (`index.ts:967`), and flows into
   dashboard/JSONL records. Anything that reaches a log would become a bearer credential.
2. **It is guessable in structure.** `req_${Date.now()}_${uuid}` (`index.ts:186`) leaks its own
   creation time; only the UUID carries entropy. Sound today, but it was never designed to be
   unguessable and nothing stops that format from changing.
3. **It has the wrong lifetime.** One id covers the whole client request; a credential should be
   redeemable once, for one purpose.

So: keep `x-request-id` for **correlation** (logs, stats, attribution) and add a separate **OTAC**
for **authorization**. Different jobs, different fields — conflating them is what makes log
exposure into privilege escalation.

#### The grant

**This proxy already has a one-time-auth-code convention — reuse it, do not invent a second.**
`recordModelUsageToRemote` takes an `oneTimeAuthCode` and sends it as the header
`one_time_auth_code` (`model-usage-recorder.ts:65`, `:71`); the value is minted by the auth sidecar
and read off its response at `index.ts:988`. The verifier grant follows the same header name and
the same shape, so operators meet one concept rather than two (CLAUDE.md rule #4).

When the proxy dispatches `/select`, it mints a code and holds the grant server-side:

```ts
// Workers-compatible: global crypto, no node import (cf. index.ts:180-186).
const otac = `otac_${crypto.randomUUID().replace(/-/g, '')}`;

verifierGrants.set(otac, {
  requestId,                    // correlation only — never the credential
  aliasName,                    // the verifier alias, for stats attribution
  userKey: endpointUserKey,     // the ORIGINAL client, for per-caller accounting
  authHeaders,                  // the caller's resolved upstream auth
  allowedModels: new Set([...]),// exactly the target/scorer this alias named
  remainingCalls: Math.min(
    Math.ceil((samples + maxScoringCalls) * callMargin),
    otacMaxReuse ?? Infinity,      // per-alias clamp; see otac_max_reuse above
  ),
  expiresAt: Date.now() + timeoutMs,
});
```

The code goes to the sidecar in the `/select` request; the sidecar returns it on every callback as
`one_time_auth_code`, alongside the inherited `x-request-id`. The proxy then:

```
grant := verifierGrants.get(one_time_auth_code)      // constant-time compare on the key
  ├─ missing / expired              → 401
  ├─ exhausted                      → 401 + warn  (looping sidecar; sidecar aborts,
  │                                                 proxy falls back to one plain call)
  ├─ model ∉ grant.allowedModels    → 403
  └─ else → decrement remainingCalls, use grant.authHeaders
```

The exhausted branch is unreachable in a correct run: `otac_max_reuse` is checked at admission and
`remainingCalls` is derived from the run's actual shape. Reaching it means the sidecar is looping, so
it is a warning rather than a routine outcome — and the sidecar's `on_error="raise"` ensures the
`401` aborts the tournament instead of being scored as a tie.

#### Why counted rather than strictly single-use

A literal one-time code cannot work here: a single `/select` legitimately makes `samples`
generation calls plus a whole tournament of scoring calls, all under one grant. Minting a fresh
code per call would need a proxy→sidecar round trip per call, which is the thing this design
avoids.

So the grant is **one-time in the sense that matters** — bound to one client request, redeemable a
bounded number of times, then dead. `remainingCalls` is computed from `samples` and the tournament
size (the cost table below gives the exact comparison count), plus a small margin for retries, then
clamped by the alias's optional `otac_max_reuse` — which is verified to be non-binding *before*
dispatch, so it can never cut a tournament short (see
[the admission check](#the-ceiling-is-an-admission-check-never-a-mid-flight-cutoff)).

Exhaustion mid-run therefore means one thing: a **looping sidecar**. It aborts the run and fails
open to a single plain call, with a warning naming the alias — never a `401` surfaced to the client,
because by the time the ceiling is reached the N generation calls have already been paid for, and
`select()`'s default error handling would launder the 401s into 0.5/0.5 ties and return an arbitrary
winner under an HTTP 200. The sidecar sets `on_error="raise"` for the same reason (CLAUDE.md
rule #8).

#### What OTAC buys over keying on the request id

| Property | Request id as credential | OTAC |
|---|---|---|
| Appears in logs | Yes — everywhere | No; never logged, only its presence/validity is |
| Redemption bound | Unbounded while pending | `remainingCalls`, then dead |
| Revocable independently | No — would break correlation | Yes; drop the grant, keep the id |
| Rotates per verification | No | Yes |

#### Handling rules

The grant table is a **credential store** and gets the handling of one:

- **Never logged.** Log the request id for correlation; for the OTAC log only a validity verdict.
  A `/dashboard` surface must never expose it (contrast `compositeAliasStates`, which is exported).
- **Deleted in a `finally`** when `/select` returns, plus swept on insert against `expiresAt`, so a
  sidecar that never returns cannot leak credentials for the process lifetime.
- **Compared in constant time.** `crypto.subtle.timingSafeEqual` where available, else a manual
  constant-time compare; on the Python side `hmac.compare_digest` (stdlib, verified available).
  A plain `Map.get` is a hash lookup and not itself a timing oracle, but any explicit comparison
  path must be constant-time.
- **Transport.** Loopback HTTP is the default and acceptable for a host-side sidecar; the code is a
  bearer token, so a non-loopback deployment must use TLS. Worth stating because
  `VERIFIER_SIDECAR_IPS` permits RFC-1918 addresses.

#### Relationship to the origin check

OTAC does **not** replace the `x-client-address` check — it composes with it. The socket check
answers *"is this the sidecar?"*; the OTAC answers *"is this a live, authorized verification, and
for which models?"*. Requiring both means a leaked code is unusable from off-host, and a
compromised host process still cannot reach models outside the grant.

---

## Accounting: attributing verifier traffic to the original client

The grant carries `userKey` and `aliasName` precisely so every callback can be billed to the client
that caused it. What that costs varies sharply by statistic, because the existing recorders are
keyed differently — worth setting out plainly rather than claiming "the dashboard just works":

| Statistic | Keyed by | Does it attribute today? | Work needed |
|---|---|---|---|
| `recordModelStat` / `recordModelUsage` (`dashboard-stats.ts:1361`, `:1393`) | model name only (`normalizeModelStatKey`, `:1321`) | **Yes, correctly.** Callbacks name the target model, so its tokens accrue to that model exactly as a direct call would. | None. |
| Remote usage records (`buildModelUsageRecordPayload`, `model-usage-recorder.ts:35`) | `request_id` + `user_key` + `model` | **No.** Would record the sidecar's context. | Pass `grant.userKey` and `grant.requestId` instead of the callback's own. |
| Composite windows (`recordCompositeTokenUsage`, `dashboard-stats.ts:312`) | alias name | **No.** Callbacks name a model, not the alias, so `compositeAliasName` is `undefined` on that hop. | Pass `grant.aliasName`. |
| Agent stats (`recordAgentStat`, `dashboard-stats.ts:1410`) | `prefix\0ua` | **No** — and actively wrong. The sidecar's UA would create a phantom `llm-verifier-sidecar` agent. | Suppress on callbacks; the original request already recorded the real agent at `index.ts:1169`. |

So the answer is **yes, but it is deliberate work, not a freebie.** Three of the four recorders
need the grant's identity threaded through; only per-model token totals are correct by accident.

### The rule

> On a redeemed callback, every recorder is called with the **grant's** identity
> (`requestId`, `userKey`, `aliasName`), never the callback's own — except agent stats, which are
> suppressed entirely to avoid double-counting the request.

"Never the callback's own" includes anything the sidecar *sends back*. The `alias` in the `/select`
body is outbound diagnostic context only; if a future change has the sidecar echo it, the proxy
still reads `grant.aliasName` and ignores the echo. Accounting identity comes from the grant
table — which only the proxy writes — and from nowhere else. See
[The alias travels outbound only](#the-alias-travels-outbound-only).

The `sidecarForwardedHeaders` argument already threaded into `recordModelUsageToRemote`
(`index.ts:2280`) is the existing precedent for passing sidecar-related context into a recorder.

### Cost visibility is the whole point

A best-of-5 request costs 5 generation calls plus ~48 scoring calls. Attributed correctly, the
operator sees one `claude-best5` alias consuming ~53 calls' worth of tokens billed to the caller who
asked for it. Attributed wrongly, that spend appears as anonymous sidecar traffic and the alias
looks nearly free — which would make the cost table below unfalsifiable in production. This is the
main reason the sidecar routes back through the proxy at all rather than calling upstreams directly.

### Double-counting hazard

The alias-level record and the per-model records describe **the same tokens at two granularities**.
`recordCompositeTokenUsage` already coexists with `recordModelUsage` for fusion (`index.ts:2270`,
`:2284`), so the pattern is established — but any new dashboard panel summing "alias totals +
model totals" would double every verified token. Verification step 6 asserts the totals reconcile.

#### Workers note

The grant table is a `Map`, so it is Node-only — it does not survive across Workers isolates. The
plugin stays Workers-*compatible* (it is still just `fetch`); this path would need Durable Objects
or KV there. Acceptable, since the sidecar is host-side regardless.

#### The alternative, for the record

**`config_key` only** — require verifier aliases to route to models with a configured `api_key`,
refusing to dispatch otherwise (a config-load error alone would not stop it, per the validation
finding above). No grant table, no lifetime or secrecy concerns. But verification
could never use a caller's own key, which rules out `[models.default]`, where the caller's key
taking priority is the entire point of the tier. Kept as the fallback if the grant table proves
awkward under review.

### How the four surfaces can disagree

Each row is a real mismatch, and most fail quietly — which is why they are called out rather than
left to discovery:

| Mismatch | Symptom | Guard |
|---|---|---|
| Scorer routes to a non-`openai-completions` section | **Silent**: every pair ties 0.5/0.5; a plausible answer is returned | Pre-dispatch re-check (fails open) + `/health` logprob probe; the config-load entry reports but does not block |
| OTAC grant missing or expired | Callback 401s | TTL bounded by `VERIFIER_TIMEOUT_MS`; logged with the request id and the verdict, never the code |
| OTAC grant **exhausted** mid-run | Callback 401s → sidecar aborts → **proxy fails open** to one plain call. Never surfaced to the client as a 401, never a tie-corrupted winner | Unreachable in a correct run (admission check + derived bound); reaching it means a looping sidecar, so it is logged as a warning |
| `OPENAI_BASE_URL` missing the `/v1` suffix | 404 on every call | `/health` probe fails at startup |
| Sidecar in Docker, `VERIFIER_SIDECAR_IPS` still loopback | Every call 403s | Documented beside `ALLOWED_HOSTS` |
| `/select` body omits `scorer_model` | **Silent** if defaulted: `gemini-2.5-flash` returns no logprobs | Sidecar `400`s instead of defaulting |
| Alias names a target that resolves back to the alias | Infinite recursion | Existing `visited` cycle detection in `getModelRouteConfig` errors on the path; the config-load entry reports it earlier |

### Why key priority makes the OTAC grant the right call

The two tiers invert each other, which is exactly why the sidecar must not carry a key of its own:

- `[models.default]` — the **caller's** key beats configured `api_key` values
  (`proxy_config.example.toml:193-199`). A sidecar key here would *outrank* the real caller and bill
  everyone's verification traffic to one account.
- `[models.FREE]` — configured keys win (`proxy_config.example.toml:143-146`), so the caller's key
  is irrelevant and any placeholder would do.

A sidecar holding one static key cannot be correct for both. Replaying the original request's
resolved auth headers is correct for both by construction, because it reuses the decision the proxy
already made for that request.

---

## Hard constraint: the scorer route must be `openai-completions`

This is the one way to get the feature wrong, and it **fails silently rather than loudly**:

| Upstream mode for the scorer | Result |
|---|---|
| `openai-completions` | **Native passthrough** (README §Supported `upstream_mode`). `logprobs` survive. **Required.** |
| `anthropic-messages` | Response is rebuilt by `claudeJsonToSyntheticCompletions` (`handlers/openai.ts:905`), which constructs `choices[]` from scratch and never populates logprobs. |
| `openai-responses` | Both Responses-path synthesizers hardcode `logprobs: null` (`handlers/messages.ts:383`, `:663`). |
| `gemini-*` | Converted through Chat Completions; no logprob channel. |

Underlying reason: **Claude can generate candidates but can never verify them** — the Messages API
returns no logprobs, so there is no distribution to take an expectation over. TurboAgent rejects an
`anthropic/` verifier for the same reason.

Without a guard the failure mode is a tournament that scores every pair 0.5/0.5 and returns a
*plausible* answer — indistinguishable from success. Three layers, in the order they actually bite:

1. **Config load** emits a validation error for a scorer whose resolved route is not
   `openai-completions`. This is **visibility only** — `validateProxyConfig` logs and stashes, it
   never throws (`config-loader.ts:2486`, `:3035`), so a misconfigured alias still loads and still
   dispatches. Necessary for the operator to find the mistake; not sufficient to prevent it.
2. **Pre-dispatch re-check** applies the same test just before `/select` is dispatched, and fails
   open to a single plain call to the target model. This is the layer that actually stops an
   all-ties tournament from running, and it is why layer 1 being non-blocking is tolerable.
3. **Sidecar `/health`** issues one tiny `logprobs=True` probe at startup and refuses to serve if
   the response carries no logprobs (CLAUDE.md rule #8 — fail loud). Catches the case config cannot
   see: a route that *is* `openai-completions` but whose upstream strips logprobs anyway.

### The proxy is verified to preserve logprobs

`handleChatCompletionsPassthrough` (`src/handlers/chat-completions.ts:21`) parses the body and
forwards it as-is — it does not rebuild the body field-by-field. `logprobs` / `top_logprobs` are
declared legal transform paths for the `openai-completions` schema (`config-loader.ts:151`), and
the README lists `/v1/chat/completions` as "always enabled; per-model routed passthrough"
(`DEV_PASS_THROUGH` was removed — see CHANGELOG "feat(api): serve `/v1/chat/completions` by
default"). The verifier's client is a plain `OpenAI(base_url=...)`
(`fine_grained_reward.py:125`) and does not care what is behind it.

### DeepSeek auto-detection will not fire through the proxy

`create_openai_client` (`fine_grained_reward.py:125`) tags the client for DeepSeek's distinct call
path only when the literal string `api.deepseek.com` appears in `base_url`
(`fine_grained_reward.py:143`), and `default_max_workers` (`fine_grained_reward.py:179`) keys off
the same string (`fine_grained_reward.py:184`). With
`OPENAI_BASE_URL=http://localhost:8788/v1`:

- the **vLLM-style prefill trick** (`_score_tags_by_prefill`, `fine_grained_reward.py:465`) is used
  instead of DeepSeek's sampled score tags, even when DeepSeek is the real upstream;
- concurrency drops from 500 to the default 50.

Neither is fatal, but both must be checked against a direct-to-DeepSeek run before the scores are
trusted — [Verification](#verification) step 2. If the prefill path misbehaves, the fallback is to
let the sidecar call `create_deepseek_client()` directly for scoring traffic only.

---

## Identity propagation and access control

### Headers the sidecar must send back

Every call the sidecar makes to the proxy carries:

| Header | Value | Purpose |
|---|---|---|
| `x-request-id` | inherited verbatim from the proxy's `/select` call | Ties all N generation calls and every scoring call to the originating client request in logs and stats. |
| `user-agent` | `llm-verifier-sidecar/<version>` | Distinguishes sidecar traffic from client traffic in the dashboard. |
| `x-forwarded-for` | the sidecar's own address | Standard forwarding chain, matching `getSidecarForwardedHeaders` (`routing.ts:585`). |

The proxy's outbound `/select` call correspondingly sends `x-request-id` (the value from
`generateRequestId()`, `src/index.ts:185`) and `user-agent: model-proxy-v3/<version>`, so the
identity is a round trip rather than two disconnected halves.

Without the inherited `x-request-id`, the N generation calls would appear as unrelated requests
from an unknown agent: dashboard stats key on the resolved upstream model id, so **token
accounting would still be correct**, but per-tool / per-agent attribution would show the sidecar
instead of the real client. Inheriting the id fixes attribution without changing the stats keying.

### Restricting the proxy to serve the sidecar only its target models

The requirement is that the proxy serve the sidecar **only** the configured verifier target models,
and only to the sidecar. One correctness point matters here more than the rest:

> **`x-forwarded-for` alone cannot be the access check.** `getClientIp` (`routing.ts:546`) *trusts*
> inbound `x-forwarded-for` and `x-real-ip` — any client can set them. Gating on XFF would be
> trivially spoofable and would grant unrestricted model access to anyone who guessed the header.

The proxy already solves exactly this problem for its admin endpoints. `server.ts:79` injects
`x-client-address` from `req.socket.remoteAddress` — **the real socket peer, unspoofable** — and
`src/index.ts:708` gates `/dashboard` and `/config-reload` on it. Reuse that mechanism:

```
sidecar-origin  := x-client-address ∈ VERIFIER_SIDECAR_IPS      (default: loopback)
grant           := verifierGrants.get(one_time_auth_code)          (else 401)
not exhausted   := grant.remainingCalls > 0 && now < expiresAt  (else 401)
model permitted := requested model ∈ grant.allowedModels        (else 403)
credentials     := grant.authHeaders                            (the caller's own)
```

All four must hold. Because the allowlist is carried **on the grant** rather than derived globally,
a callback can only reach the models *its own* alias named — a verifier for `deepseek-v4-flash`
cannot call `claude-sonnet-4-5` even though another alias uses it. Design points:

- **XFF is carried and logged, never trusted for authorization.** It documents the chain; it does
  not grant access. This distinction should be stated in the code comment so a later reader does
  not "simplify" the check into `getClientIp`.
- **The grant is the capability, and the OTAC is the only key to it.** Created when `/select` is
  dispatched, deleted in a `finally` when it returns; an unknown, expired, or exhausted code is a
  `401`, never a fallback to global rules.
- **`x-request-id` authorizes nothing.** It travels for correlation and appears in logs; the OTAC
  never appears in logs. Two fields because they have two different jobs.
- **Deny is the default for sidecar-origin traffic.** A sidecar-IP request naming a model outside
  its grant's allowlist gets `403`, so a compromised or buggy sidecar cannot use the proxy as an
  open relay to arbitrary upstreams.
- **Non-sidecar clients are unaffected.** Ordinary traffic from other addresses routes exactly as
  today; this guard adds no restriction to the existing surface.

Deployment note: when the sidecar runs in Docker rather than on loopback,
`VERIFIER_SIDECAR_IPS` must list its container address. Document this next to `ALLOWED_HOSTS`,
since the failure (`403` on every scoring call) is otherwise puzzling.

### Config-load validation

Reported at load as a validation error naming the offending alias. **Read "reported", not
"rejected"**: as established under `otac_max_reuse` above, `validateProxyConfig` logs and stashes its
errors and never throws (`config-loader.ts:2486`, `:3035`), so none of these prevent the config from
loading or make `/config-reload` fail. They are how an operator *finds out*; the runtime guards below
are what keep a bad config from corrupting a result.

1. Scorer route is not `openai-completions`. **Also re-checked before dispatch** — this is the one
   entry with a silent-corruption failure mode (logprobs stripped ⇒ every pair ties), so it fails
   open to a plain call rather than running an all-ties tournament.
2. `otac_max_reuse` below the derived bound, or not a positive integer. **Also re-checked before
   dispatch** (the admission check).
3. `samples < 2` — a tournament over one candidate is meaningless.
4. `temperature = 0` (or unset) with `samples > 1` — N identical samples, ~48 wasted verifier calls.
   Default `temperature = 1.0`.
5. A verifier alias whose `target` resolves back to that same alias (the structural-termination
   assumption). Reuses the `visited` cycle-detection already threaded through
   `getModelRouteConfig`.

Items 3–5 are left report-only by choice. Each is either self-limiting or fails loudly on its own:
`samples < 2` and `temperature = 0` waste money but cannot fabricate a ranking, and a self-referential
alias hits the existing cycle detection in `getModelRouteConfig` and errors there rather than
recursing. Only items 1–2 can return a confident wrong answer, which is why only those two are
duplicated as runtime guards.

---

## Cost model (measured, not assumed)

PPT comparison count is `N` (ring pass) + `|non-pivots| × k + C(k,2)` (pivot rounds), from
`pivot_tournament.py:74`. Each comparison is `n_evaluations` verifier calls (default 4), each
carrying **both** candidate texts:

| N | k (pivots) | PPT comparisons | Round-robin `C(N,2)` | Verifier calls @ K=4 |
|---|---|---|---|---|
| 3 | 2 | 6 | **3** | 24 |
| 5 | 2 | 12 | **10** | 48 |
| 5 | 3 | 14 | **10** | 56 |
| 8 | 2 | 21 | 28 | 84 |
| 8 | 3 | 26 | 28 | 104 |

**PPT is more expensive than a full round-robin below N≈8.** The asymptotic `O(Nk)` win is real but
does not apply in this range; the ring pass buys positional-bias cancellation, not savings, at
small N.

Practical read: a best-of-5 request costs **5 generation calls + ~48 scoring calls**. Prefix caching
helps (upstream claims 5.2% → 78.4% hit rate) but only on backends that cache prefixes. This must be
**off by default and opt-in per alias**.

Because every one of those calls now flows through the proxy, the cost is **visible** in
`model_proxy_tokens.jsonl` and the dashboard rather than being invisible spend — one of the main
reasons to route the sidecar back through the proxy at all. The privacy filter also applies, which
matters here: each scoring call ships **both full candidate texts** (~80k tokens on Terminal-Bench
2.1) to the scorer.

---

## Components

### Component 1 — Python sidecar

New file: `submodules/llm-as-a-verifier/serve.py` (stdlib `http.server`, matching privacy-filter's
`serve.py`). Threaded server; `select()` owns its own concurrency via `max_workers`.

```python
# Holds NO credentials and NO model config. Both arrive per request.
#
# Endpoints:
#   GET  /health  -> {"status":"ok","logprobs_ok":true}
#                    Startup probe: one tiny logprobs=True call through the proxy.
#                    Refuse to serve when the backend returns no logprobs.
#   POST /select  -> headers  x-request-id:    req_…   # correlation only
#                             one_time_auth_code: otac_…  # the capability; echo, never log
#                    body {"model": "deepseek-v4-flash",      # TARGET model, not the alias
#                          "scorer_model": "deepseek-v4-flash",  # from verifier_options
#                          "alias": "claude-best5",           # DIAGNOSTIC ONLY — see below
#                          "messages": [...],                 # original client messages
#                          "samples": 5, "temperature": 1.0,
#                          "criteria": {...} | "benchmark_name",
#                          "n_evaluations": 4, "pivots": 2, "seed": 0}
#                    resp {"index": 0, "winner": {...},        # verbatim upstream choice
#                          "scores": [...], "usage": {...}}
#                    400 when scorer_model is absent — never fall back to the
#                    library DEFAULT_MODEL (gemini-2.5-flash, no logprobs).
#
# ① generate: `samples` concurrent POSTs to OPENAI_BASE_URL/chat/completions,
#    model=<target>, temperature=<temperature>. Keep each raw choice object.
# ② select:  llm_verifier.select(problem, [text of each choice], model=<scorer_model>,
#            on_error="raise")   # NEVER the "tie" default — see below
# ③ return:  the raw choice at result.index, untouched.
#
# Every outbound call carries, and carries NO Authorization of its own:
#   one_time_auth_code  echoed verbatim — the capability the proxy redeems for the
#                    caller's credentials. Held in memory for the life of the
#                    request, never logged, never written to disk.
#   x-request-id     inherited verbatim — correlation only, safe to log
#   user-agent       llm-verifier-sidecar/<version>
#   x-forwarded-for  attribution only, never trusted for authorization
#
# The model being called is already the `model` field of each outbound request
# body, so the proxy checks it against grant.allowedModels directly — no
# separate x-verifier-model header, which would just be a second source of
# truth that could disagree with the body.
```

Returning the **raw choice object** rather than re-serialized text is what makes "verbatim"
literal — tool calls, `reasoning_content`, and `finish_reason` survive selection untouched.

#### `on_error="raise"` is mandatory, not a preference

`select()` defaults to `on_error="tie"`, which catches a failed scoring call and records it as
0.5/0.5 (`llm_verifier/fine_grained_reward.py:827`, `:920-921`). The default suits offline benchmark
runs, where finishing a sweep matters more than any single pair. It is wrong for a serving path.

Under the default, an upstream outage, a rate limit, a stripped-logprobs response, or an exhausted
grant all degrade into ties — and the tournament still returns a winner under an HTTP 200. The
caller cannot distinguish a genuine selection from one where every comparison silently tied, which
means **paying N× for a best-of-N that quietly became a coin flip**. Setting `on_error="raise"`
turns each of those into an aborted run that fails open to a single plain call, which is honest
about what happened and costs the client nothing extra.

This is the same failure class as the scorer-route/logprobs hazard, arriving by a different route,
and it is closed the same way (CLAUDE.md rule #8).

#### The alias travels outbound only

`alias` is included in the `/select` body so the sidecar can name it in its own logs and error
messages ("tournament for `claude-best5` aborted"). It is **diagnostic only**, and the sidecar must
not echo it back — not in a response field, not in a callback header.

The proxy already knows the alias for any given OTAC: it is `grant.aliasName`, recorded when
`/select` was dispatched. A returned copy would be a second source for a fact the proxy already
holds authoritatively, arriving over the one path this design otherwise treats as untrusted.

The stakes are concrete: `compositeAliasName` drives `recordCompositeTokenUsage`
(`index.ts:2284`, `dashboard-stats.ts:1627`), the live composite-accounting path. If the sidecar
supplied it, a buggy or compromised sidecar could bill one alias's token window against another, or
omit it and make verifier traffic vanish from alias accounting entirely. Deriving it from the grant
makes both unrepresentable.

Same reasoning as `--scorer-model` and the sidecar's `OPENAI_API_KEY`: **one source of truth, and it
is the proxy's config — never the sidecar's request.**

### Component 2 — Node plugin module

New file: `src/utils/verifier.ts`, mirroring `kompress.ts`:

- `getVerifierConfig(env): VerifierConfig | null` — `null` when `VERIFIER_URL` is unset. Reuses
  `isInternalHost()` (`routing.ts:37`) for the same SSRF guard kompress applies (`kompress.ts:55`).
- `runVerifier(config, plan, body, requestId, authHeaders): Promise<Response | null>` — mints the
  OTAC, registers the grant, issues one `POST /select` carrying `one_time_auth_code`, `x-request-id`,
  and the proxy `user-agent`, then revokes the grant in a `finally`.
- `verifierGrants: Map<string, {requestId, aliasName, userKey, authHeaders, allowedModels, remainingCalls, expiresAt}>`
  — the grant table, keyed by OTAC. **Module-private**: never exported, never logged, never
  surfaced on `/dashboard`. A sweep on insert drops entries past `expiresAt` so a sidecar that
  never returns cannot leak credentials for the process lifetime.
- `redeemVerifierGrant(request, env)` — the `x-client-address` + OTAC + allowlist check above.
  Decrements `remainingCalls` and returns the caller's `authHeaders`, or a `401`/`403`. Logs the
  request id and the verdict; **never the code itself**.
- **Fail-open**, like kompress and unlike privacy-filter: selection is an optimization, not a
  correctness boundary, so a sidecar outage falls back to a single ordinary call to the target
  model. This is also the landing point for every aborted tournament — which is precisely why the
  sidecar sets `on_error="raise"`. Under the library's `"tie"` default the failure never surfaces as
  an error at all, so fail-open is never reached and the client silently receives a tie-chosen
  winner instead. (Privacy is fail-closed because leaking PII is worse than erroring; the asymmetry is
  deliberate.)

Extracting `problem` from a request body should reuse the existing `extractUserPrompt`
(`src/index.ts:1845`) — **reading it, not moving or changing it**, so fusion stays untouched.

### Environment variables

| Var | Default | Meaning |
|-----|---------|---------|
| `VERIFIER_URL` | (unset) | Sidecar base URL, e.g. `http://127.0.0.1:8790`. Unset = plugin off. |
| `VERIFIER_SIDECAR_IPS` | `127.0.0.1,::1` | Socket addresses accepted as sidecar origin (`x-client-address`). |
| `VERIFIER_TIMEOUT_MS` | `300000` | Per-`/select` timeout, and the OTAC grant's TTL. Covers N generations **and** the full tournament, so far higher than kompress. |
| `VERIFIER_CALL_MARGIN` | `1.25` | Multiplier on the computed `remainingCalls` bound, absorbing retries. Raise if legitimate runs hit exhaustion. Applies to every alias; use the per-alias `otac_max_reuse` to clamp one alias instead. |
| `VERIFIER_FAIL_OPEN` | `true` | On sidecar failure, fall back to one plain call to the target model. |
| `VERIFIER_CRITERIA` | (unset) | Benchmark name or criteria-file path passed through to `select()`. |

Per-alias knobs (`samples`, `temperature`, `n_evaluations`, `pivots`, `otac_max_reuse`) live in `verifier_options` in
TOML — visible in the dashboard and working with `PROXY_CONFIG_URL` / Consul, matching how
`fusion_options` is configured.

### Streaming

**Verification is fundamentally incompatible with token-by-token streaming**: all N candidates must
be complete before ranking starts. TurboAgent has the same limitation ("the response arrives as one
burst"). Buffer and re-emit the winner as a single SSE message (friendlier to Claude Code) rather
than rejecting `stream:true`. Document it; never silently degrade.

## Files to add / modify

**New**
1. `submodules/llm-as-a-verifier/serve.py` — sidecar: generate N, `select()`, return winner.
2. `src/utils/verifier.ts` — config, `runVerifier`, `isSidecarRequest`.
3. `tests/unit/verifier.test.ts` — config validation, sidecar-origin guard, selection against a
   mocked sidecar.

**Modified**
4. `.gitmodules` — add `submodules/llm-as-a-verifier`.
5. `src/server.ts` — surface the new env vars (alongside `KOMPRESS_*`, `server.ts:50`).
6. `src/types/shared.ts` — declare the new `Env` fields (alongside `KOMPRESS_*`, `shared.ts:183`).
7. `src/index.ts` — **additive only**: a `verifier` branch beside the existing fusion branch
   (`src/index.ts:1315`), and the sidecar-origin guard near the existing admin-path check
   (`src/index.ts:702`). No edits inside `runFusion`.
8. `src/utils/config-loader.ts` — **additive only**: `VerifierOptions` (including the optional
   `otac_max_reuse`, validated as an integer `>= 1` beside the `samples` / `temperature` checks),
   the `verifier` target field, `resolveVerifierPlan`, and a `verifier` branch in
   `getCompositeAliasMode` placed before the `isFusion` test. Existing fusion types and functions
   unchanged.
9. `README.md` (Features, Routing Hierarchy table, API Endpoints note) + `CHANGELOG.md` —
   CLAUDE.md rule #3.

## Verification

**Prerequisite — logprobs survive the proxy (no code required)**

1. With an `openai-completions` route:
   `curl localhost:8788/v1/chat/completions -d '{"model":"...","messages":[...],"logprobs":true,"top_logprobs":5}'`
   → `choices[0].logprobs.content` is populated, not `null`.
2. `OPENAI_BASE_URL=http://localhost:8788/v1 python scripts/run_bo5.py` → scores are not uniformly
   0.5 and land within noise of a direct-to-DeepSeek run. This is the check that catches the
   prefill-vs-DeepSeek path divergence.

**Sidecar**

3. `POST /select` with two obviously-unequal candidates → `index` picks the better one; `winner` is
   the raw choice object.
4. **Determinism**: same body and `seed` twice → identical `index` and `scores`.
5. **Identity propagation**: proxy logs show all N generation calls and every scoring call sharing
   the originating `x-request-id`, with `user-agent: llm-verifier-sidecar/…`.

**Access control and credentials**

6. **Sidecar origin, valid OTAC, allowed model** → served, and the upstream receives the
   **original caller's** key — not a sidecar key, and not the TOML fallback. Assert against two
   different callers to prove the key follows the request rather than the process. In the same run,
   assert accounting: the remote usage record carries the **original** `request_id` and `user_key`;
   the alias window accrues under `claude-best5`; per-model totals accrue under the target model;
   no `llm-verifier-sidecar` agent appears in agent stats; and alias total == sum of the model
   totals for that verification (the double-counting check).
7. **Sidecar origin, model outside that grant's allowlist** → `403`, including a model that another
   verifier alias legitimately uses. Proves the allowlist is per-grant, not global.
8. **Valid `x-request-id` but absent or wrong `one_time_auth_code`** → `401`. The test that proves the
   request id is not a credential; a log-scraper replaying ids gets nothing.
9. **Revoked after completion**: replay a previously valid OTAC once `/select` has returned → `401`.
10. **Exhaustion never corrupts a result.** Force `remainingCalls` to zero mid-tournament and assert
    all three properties, because the failure this guards against is silent: (a) a warning is logged
    naming the alias; (b) the sidecar **aborts** rather than completing — `on_error="raise"` means
    the `401` propagates instead of being scored 0.5/0.5; (c) the client gets the fail-open single
    plain call, **not** a `401` and **not** a winner chosen from tied scores. Property (b) is the
    one worth writing a dedicated test for: run the same fixture with the library's default
    `on_error="tie"` and confirm it *would* have returned an arbitrary winner under HTTP 200. That
    contrast is the regression this test exists to prevent.
11. **`otac_max_reuse` clamps, never widens**: set it far above the derived bound (e.g. `10000`) and
    assert `remainingCalls` still equals the derived value. This is the test that proves a generous
    value cannot silently enlarge the capability.
12. **`otac_max_reuse` below the derived bound produces a config validation error** naming the alias
    and both numbers. Assert on `_validationErrors` (and the log line), **not** on a thrown
    exception or a failed load — `validateProxyConfig` does not throw (`config-loader.ts:2486`,
    `:3035`), so a test asserting rejection would be testing behavior the proxy does not have.
    Non-integer or `< 1` likewise, alongside the `samples` and `temperature` checks. Assert too that
    `/config-reload` still returns 200 for this config: that is the current contract, and pinning it
    documents why step 13 is the load-bearing test.
13. **Admission check runs before spend**: load a config carrying a binding ceiling (which loads
    successfully, per step 12), issue one request → the proxy fails open to a single plain call and
    **zero generation calls are made**. Asserts the ceiling is caught before N samples are paid for,
    not after. This is the enforcement test; step 12 only covers operator visibility.
14. **Spoofed `x-forwarded-for` from a non-sidecar address** → still `403`, even with a valid OTAC.
    Proves origin and capability are both required, not either.
15. **No credential leak on sidecar hang**: kill the sidecar mid-`/select`; after
    `VERIFIER_TIMEOUT_MS` the grant is gone (assert on table size, exposed to tests only).
16. **OTAC never logged**: run a verification at `debug` level and grep the full log for the code —
    zero hits, while the request id appears throughout.
17. **Ordinary client traffic** → unaffected; existing `./testcases` suite green.

**End to end**

18. **Selection is verbatim**: the body returned for the alias is byte-identical to the winning
    candidate — *not* a synthesized merge. The property distinguishing `verifier` from `fusion`.
19. **Fail-open**: stop the sidecar; the request still succeeds via one plain call to the target
    model, with a warning logged.
20. **Config validation reports**: scorer on `anthropic-messages`; `samples = 1`; `temperature = 0`
    — each produces a validation error naming the alias. Assert on `_validationErrors`, not on a
    load failure (see step 12). Then assert the *consequence* that matters: with the
    `anthropic-messages` scorer still loaded, a request to that alias fails open to one plain call
    and runs **zero** scoring calls, rather than completing an all-ties tournament.
21. **Sidecar rejects a bodiless scorer**: `/select` with no `scorer_model` → `400`, never a
    `gemini-2.5-flash` fallback.
22. **Alias echo is ignored**: have a stub sidecar return a *different* alias than the one it was
    sent, in both a response field and a callback header. Composite tokens must still accrue to the
    alias in the grant. Proves accounting identity comes from the grant table, not the wire.
23. **A failed scoring call aborts rather than ties**: stub one scoring call to `500` mid-tournament
    → the run aborts and fails open. Asserts `on_error="raise"` is actually set; with the library
    default this returns a winner computed from a tie and the test would pass silently otherwise.
24. **Fusion untouched**: fusion tests green and `git diff` shows no changes inside `runFusion` /
    `resolveFusionPlan`. The gate on the "don't modify fusion" constraint.
25. **Disabled**: unset `VERIFIER_URL` → behavior identical to today (`node run-tests.js --all`,
    `npm run test:unit`).
26. `npm run typecheck` clean.

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| **Silent 0.5/0.5 ties** if the scorer route loses logprobs | Re-checked before dispatch and failed open to a plain call; sidecar `/health` probes logprobs at startup and refuses to serve. Config-load validation reports it but does not block (`config-loader.ts:2486`, `:3035`). |
| **Silent 0.5/0.5 ties from *any* failed scoring call** — `select()`'s `on_error="tie"` default swallows outages, rate limits, and 401s alike (`fine_grained_reward.py:920-921`), returning an arbitrary winner under HTTP 200 | Sidecar sets `on_error="raise"`, so a failed call aborts the run and fails open to one plain call instead of laundering the failure into a tie. Verification steps 10 and 23. |
| **Credential ceiling corrupting a paid-for result** — 401s landing mid-tournament after N generations already succeeded | `otac_max_reuse` is an admission check before dispatch, not a mid-flight cutoff. A binding value is reported at config load and **enforced** by that admission check — validation does not block loading, so the pre-dispatch check is what prevents it reaching a tournament. Mid-run exhaustion means a looping sidecar and fails open. Verification steps 10, 12, 13. |
| Sidecar echoing an alias the proxy then trusts for accounting | The alias is outbound-diagnostic only; accounting reads `grant.aliasName` from the proxy-written grant table. Verification step 22. |
| **XFF spoofing** granting open-relay access to upstreams | Authorization binds to `x-client-address` (`server.ts:79`, real socket peer), never to `getClientIp`. XFF is logged, not trusted. Verification step 14 asserts this. |
| Compromised/buggy sidecar relaying arbitrary models | Allowlist bound to the grant, so a callback reaches only the models its own alias named; deny-by-default for sidecar-origin traffic. |
| **Request id treated as a credential** — it appears in every log line and in the auth-sidecar payload (`index.ts:967`) | Authorization uses a separate OTAC that is never logged; the request id carries correlation only. Verification steps 8 and 16. |
| **OTAC leaking via logs** | Never logged, never on `/dashboard`, never persisted — only its verdict is. Verification step 16 greps a debug-level log for it. |
| Leaked OTAC replayed from elsewhere | Origin check (`x-client-address`) is required *in addition*, so a code alone is unusable off-host. Verification step 14. |
| Leaked OTAC replayed on-host | Bounded `remainingCalls`, TTL, and revocation in a `finally`. Verification steps 9 and 10 (10 asserts exhaustion fails open rather than tie-corrupting the result). |
| **Grant table leaking keys** if a sidecar never returns | Entries carry `expiresAt` (`VERIFIER_TIMEOUT_MS`), are deleted in a `finally`, and are swept on insert. Module-private. Verification step 15. |
| Static sidecar key would misbill every caller | The sidecar holds no credentials; the proxy replays the original request's resolved auth headers, correct under both `[models.default]` and `[models.FREE]` priority rules. |
| Bearer OTAC over plaintext on a non-loopback deployment | Loopback default; TLS required when `VERIFIER_SIDECAR_IPS` is widened to RFC-1918 addresses. |
| `remainingCalls` bound computed too tightly, failing valid runs | Derived from `samples` + tournament size (cost table above) plus retry margin; exhaustion logs a warning naming the alias, and fails open rather than failing silently or 401ing the client. |
| `otac_max_reuse` set stale-low after `samples` grows | Reported at config load naming the alias and both numbers, and refused at the pre-dispatch admission check — never honored at runtime, where it could only bind mid-tournament. Verification steps 12 and 13. |
| `otac_max_reuse` set high in the belief it *grants* more calls | It clamps only; the derived bound still wins. Verification step 11 asserts a `10000` value does not widen the grant. |
| Grant table is Node-only (no Workers isolate persistence) | The plugin stays Workers-compatible (pure `fetch`); this path needs Durable Objects/KV there. Acceptable — the sidecar is host-side regardless. |
| DeepSeek call-path divergence through the proxy | Verification step 2 compares against a direct run; fall back to `create_deepseek_client()` for scoring traffic if scores diverge. |
| Cost multiple (5 generations + ~48 scoring calls for best-of-5) | Off by default; opt-in per alias; measured table above rather than the misleading `O(Nk)` claim. Cost is at least visible via dashboard/JSONL. |
| Latency: N generations then a full tournament | `VERIFIER_TIMEOUT_MS` default 300 s; fail-open falls back to a single plain call. |
| Correlated failure from sampling one model N times | Accepted tradeoff of "prefer same model"; a diverse panel remains expressible by pointing target/scorer at different models. |
| Wasted spend when `temperature = 0` makes N samples identical | Reported at config load (report-only, by choice — it wastes money but cannot fabricate a ranking); default `temperature = 1.0`. |
| Sidecar in Docker fails every call with `403` | Document `VERIFIER_SIDECAR_IPS` beside `ALLOWED_HOSTS`; loopback default is correct only for host-side sidecars. |
| PPT costs *more* than round-robin at N<8 | Documented; `pivots` exposed so operators can tune. |
| Sidecar is a research artifact, API may drift | Pin the submodule commit; the `/select` contract is ours and insulates the proxy from signature changes. |
| Streaming incompatibility | Buffer and re-emit the winner as a single SSE message; document the behavior. |
| Cloudflare Workers build | Plugin is pure `fetch` to an external URL, so it stays Workers-compatible; only the sidecar is host-side. |
