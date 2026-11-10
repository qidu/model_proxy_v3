# Semantic decision layer TODO

Plan: `docs/plan-semantic-routing-decision.md`

Status values: `[ ]` pending, `[~]` in progress, `[x]` complete with verification.

Current verification: **baseline only — no code from this plan has landed.** On
`feature/semantic-routing`, `npm run typecheck` clean, `npm run build` clean,
`npm run test:unit` 2646/2646 pass (538 suites).

This file is the build order for the plan, not a restatement of it. Part I of the
plan is the judgement (what to port and what not to), §2 the mechanics, Part II the
design. Here: the increments in dependency order, the file each one touches, and a
*Done when* that a test or a command can falsify. Where the plan and the current code
disagree, the disagreement is recorded in **§A** and stays open until §B settles it —
it is never resolved silently inside an increment.

**Plan amendments applied so far — 2026-11-08.** §5.4's key-format prose, §6's
config surface and rules, and the decision blocks in §5.6/§6.2/§6.3/§6.4 now read
as keyed sub-sections (`[routing.decisions.<name>]`, no `name` key, bare outcome
keys), and §6's reference to an undeclared `context.beyond_window` signal is fixed
to the `context.long_context` it actually declares. Plan-only: no code from the plan
has landed, so the verification baseline below is unchanged. Recorded as §A1,
§A10 and §A11; §A1 and §A10 are settled under D5 and D9, while §A11 is a
plan-example fix with no decision attached.

**2026-11-10.** Cross-references corrected in place: A7's location and its
second missing name, the A9/D4/D8 decision targets, increment 10's answer-key
spelling brought in line with D9, `readJudgeAnswer`'s module privacy flagged in
increment 9 and D7, stale line numbers refreshed. And the measurement
sequencing is ruled as follow-building, not gate-building — recorded as §A12,
with plan §12.1's sequencing paragraph amended the same day.

---

## A. Findings that change the plan

These were read off the code, not the plan. Each one turns a plan sentence into work
the plan does not name, or into a decision the plan assumes away.

**A1. Decision declaration form — settled on keyed sub-sections.**
`parseSimpleToml` (`src/utils/config-loader.ts:3357`) has no `[[...]]` support, so
plan §6.2/§6.4's array-of-tables could not be read. **Ruled: `[routing.decisions.<name>]`**
(D5), which is what the plan already writes in §5.6 and in §6.3's projection — so
§6.2 and §6.4 were the outliers to amend, not the ruler. Cost is small: section
dispatch already handles `parts[0]` + `parts[1]` for `[models.<category>]`, so
`routing.{signals,projections,decisions}.<name>` is the same depth. Three
consequences must be built rather than assumed:

- duplicate headers are warn-and-overwrite today; for `routing.decisions.*` that is
  silent config loss and must be a hard error (rule 8);
- the decision's name is now the section suffix, so it may not contain `.` — the
  parser splits on it, so reject rather than mis-parse;
- a `name = ` key inside the section is redundant and can disagree with the header —
  reject it.

This contradicts the `[models.passthrough.<name>]` / `[models.decision.<x>]`
"declare inline tables instead" warnings. Those warnings stay as-is (out of scope);
the reference docs should state the rule that actually holds — *a body that fits on one
physical line may be an inline table under its parent section; anything longer needs
its own `[<parent>.<name>]` section* — because `parseSimpleToml` folds multi-line
**arrays** only, not multi-line inline tables. That applies to `signals` as much as to
`decisions`: a `choice` signal whose `criteria` do not fit on one line must be
`[routing.signals.<name>]`, so the parser accepts both forms uniformly for all three
collections. The plan now states this as its "Declaration form" rule (amended
2026-11-08, §6), so increment 2 parses the amended form rather than re-deciding it.

**A2. There is no recursive inline-table builder.**
`splitTopLevel` (`:1840`) already splits at depth 0 and understands quotes, so the
plan's rule trees (`rules = {and = [{signal=…}, {or=[…]}]}`) can be *torn apart*, but
the object builder is per-shape and one level deep: `parseCompositeModelConfig`
(`:1660`), `parseScheduleWindow` (`:1878`), `parseScheduleConfig` (`:1928`) each
hand-roll their own. `[routing.signals]`/`[routing.projections]`/`rules` need one
recursive parser (inline tables, arrays, nested arrays-of-tables) instead of a fourth
hand-rolled variant (rule 4). Precedent for the shape, not the generality:
`parseScheduleConfig` is already "map of name → array of inline tables".

**A3. `adaptToClefRequest` cannot carry the plan's questions — §10 row 7's
"unchanged, just import" is not achievable as written.**
`ClefQuestion` is `ClefChoiceQuestion | ClefNoulQuestion` (`tool-judge-sidecar.ts:122`)
— **no `score`** — and `adaptToClefRequest` (`:153`) maps choice criteria from an
array to an object with **hardcoded** keep/discard descriptions, because it exists to
serve the tool judge. `ClefAnswer` (`:125`) likewise has no `score`/`legend` field,
and `callDecisionApi` (`:682`) calls that adapter internally. A `score` signal, or a
`choice` with arbitrary criteria, would be mangled or dropped on the way out.
`adaptFromClefResponse` (`:187`, the `answers` map) is fine and should be reused.
→ D7.

**A4. Batch failure granularity is per-question on success, all-or-nothing on
transport failure.** `callDecisionApi` returns `answers` on success, so a question the
backend omitted (or answered in a shape that fails the per-type validator) is
individually unresolvable → `signalErrors`/`Unknown`, exactly as §2.6 requires. But
its failure paths return `null` for the whole batch (timeout, non-2xx, malformed
body). Every question in the batch is then unresolved — that is the correct outcome,
but the summary line must say "batch failed", not "N questions failed", and the tests
must pin both granularities separately.

**A5. `budget_ms` and `requestTimeoutMs()` are different knobs.**
`requestTimeoutMs` (`:559`) is *per-question × question count*, ceilinged at
`MAX_REQUEST_TIMEOUT_MS = 2000`. Plan §7 wants a **total** `[routing].budget_ms`
(default 1000). Both can exist, but the relationship must be stated (total budget
wins; the per-question scale divides it) or one silently overrides the other.
→ D3.

**A6. `stripClientInjectedContent` is module-private** (`tool-judge-sidecar.ts:324`).
Plan §12 says the signal tests "reuse `stripClientInjectedContent`, rule 4"; that
requires exporting it (no behaviour change, but it is a second caller's worth of
surface, so it is its own increment rather than a side edit).

**A7. Symbol name drift — two names, both in §6's round-trip bullet.** The plan
says "`parseProxyConfig` / `serializeProxyConfig` gain `routing`"; neither name
exists. The real ones are `parseSimpleToml` (`:3357`, reached through
`loadProxyConfig` at `:3104`) and `serializeProxyConfigToml` (`:2854`). (§10 row 4
names no functions — it says "types + parse + serialize + validate" — so the drift
was §6's, not §10's.) Pinned here so increment 3 grows neither a second serializer
nor a second parser.

**A8. A `candidates` outcome can be re-ordered *after* the ladder decides.**
`orderCompositeCandidatesForRuntimeShare` (`src/index.ts:162`) re-picks the first
candidate when the alias has a `primary` with a decayed share, or ≥2 `fallback`
targets of which any decayed. A decision that chose candidate[0] would then lose its
choice. `_coordCandidate` already sets the bypass precedent (`src/index.ts:1866`:
`coordCandidate ? [coordCandidate] : …`). §5.6's ordering guarantee is therefore not
free — it needs an explicit bypass rule. → D6.

**A9. "dashboard" is two different things in this repo.** Plan §10 row 8 wants the
`[routing]` block rendered/editable and the ranking trace shown. In-repo that means
`src/tui.ts` + the dashboard config API + `dashboard-config.test.ts` (and the
`serializeProxyConfigToml` round-trip); out-of-repo it means `proxy_tray`
(`docs/architecture/design_tauri_tray.md`). → D8.

**A10. The plan contradicts itself on the signal key format and on the outcome
spelling — both amended 2026-11-08.** §5.4 said signals are keyed
`"<type>:<name>"`; every example in §5.5, §5.6, §6.2 and §6.4 references
`"<type>.<name>"` — `context.long_context`, `decision.task:code`,
`projection.effort_high`, `embedding.code_task` — i.e. dot between type and name,
colon only before a `choice` label. The examples are what a config author types and
they compose with the section paths (`[routing.signals] "task" = …` →
`decision.task`), so they won. Separately, §5.6 wrote the outcome as bare keys on
the decision (`route = "..."`) while §6.2 nested it (`outcome = {route = "..."}`);
the bare form won, because the decision already has its own section and the nested
form costs a level for nothing. §5.4's prose now reads `"<type>.<name>"` +
`":<label>"`, and §6 states the one-bare-outcome-key rule. → D9, settled.

**A11. One of the plan's own examples referenced a signal it never declared.**
§6's `long_context` decision carried `rules = { signal = "context.beyond_window" }`
while the same example's `[routing.signals]` block declared `long_context` (a
`context` signal, `min_tokens = 32000`) and no `beyond_window` at all — so under the
load-time validation §6 itself mandates ("unknown signal references are hard errors")
that config could never have loaded. Fixed 2026-11-08 to
`context.long_context`, with the `long_context` signal declared in the block. Kept
as a finding because it is the failure mode increment 3's validation exists to
catch, and because it shows the plan's examples are not themselves under test.

**A12. Measurement follows building — it is an online experiment, not a
development test.** Plan §12.1's sequencing paragraph said "run D vs. C first",
which read as a pre-build gate and put P8's title ("runs alongside P0–P5") at
odds with increment 25's ("D vs C first"). Ruled 2026-11-10: these benchmarks
are long-running experiments that need the shipped router and live traffic —
§12.1 step 4's shadow validation, the 3× judge-drift runs, and real-hardware
judge latency (§12.1's own honesty constraint already forbids stub-derived
numbers) — so P8 starts once phases 0–2 ship and never gates them. The D/C arms
cost zero new proxy code either way, which is what §12.1's "zero new code" was
actually claiming. Plan §12.1's sequencing paragraph amended the same day.

---

## B. Decisions that must be settled before phase 0

Plan §14: "Phase 0 … is the phase requiring the design decision in §15 to be settled
first." These are that set, plus the ones §A surfaced. Each is a config-visible or
architecture-visible choice, so it is the owner's (rule 5), and each blocks the
increment named.

- [ ] **D1 — one top-level `[routing]` block, or extend `[composite.*.decision]`?**
  (plan §15.1) Blocks increments 1–3 and everything after.
  Recommendation: `[routing]`, because decisions must target direct model names and a
  ladder wants one flat priority space. The alias-scoped alternative is much smaller
  and cannot express "this request goes to a different *model*".
  Must be answered together with D2 — they are one decision.

- [ ] **D2 — accept a third routing dialect.** The repo already has fixed-route
  (`parseFixedRoute`), model-route, and composite/alias resolution; `[routing]` is a
  fourth resolution stage above all of them. Rule 5 says surface it, not decide it.
  If accepted, the precedence has to be *stated and tested* — proposed:
  auth ladder (`_coordCandidate` / `authTargets`) > coordinator > fusion > **routing
  decisions** > `getCompositeAliasMode`'s existing chain. Blocks increment 12.

- [ ] **D3 — how `budget_ms` relates to `requestTimeoutMs()`** (§A5). Blocks
  increment 10. Proposed: `budget_ms` is the hard total for all judge traffic in one
  request; the per-request Clef timeout is `min(requestTimeoutMs(questionCount),
  remaining budget)`. A budget breach leaves the un-asked questions unresolved and
  logs the breach counter (§11), never errors the request.

- [ ] **D4 — is `fail_request` available at all?** (plan §15.4) Blocks
  increment 5 (which implements the policy and its §2.3 order-independence
  test) and increment 16's fail-open row if it ships.
  Recommendation per §9: implement `match | no_match` only, and reject
  `fail_request` at load with "not supported" rather than shipping a sharp tool no
  config asks for. If it ships, §2.3's order-independence must be tested explicitly.

- [x] **D5 — declaration syntax for decisions → `[routing.decisions.<name>]`.** (§A1)
  Ruled in favour of keyed sub-sections. Consequences:
  - §5.6 and §6.3 already used this form; §6.2 and §6.4 used `[[routing.decisions]]`
    and were **amended against the plan on 2026-11-08**, along with §6's opening
    example and its "Declaration form" rule. Increment 2 no longer carries the
    amendment — it only has to parse the amended form.
  - Duplicate decision sections become a hard error; names may not contain `.` and may
    not be repeated inside the section as a `name` key (§A1).
  - Declaration order survives as object insertion order, so a serializer that
    iterates keys keeps the ladder's visual order — but priority still ranks, and no
    test may depend on order (§2.5).
  - Rejected: `[[...]]` (a parser feature nothing else in the repo uses), and
    inline tables for decisions (rule trees collapse onto one unreadable line, since
    only arrays are folded across lines).

- [ ] **D6 — does a `candidates` outcome bypass runtime-share ordering?** (§A8)
  Blocks increment 13. Recommendation: bypass, following `_coordCandidate`'s
  precedent, because §5.6 calls a decision outcome authoritative; the alternative
  silently voids the decision on any alias with decayed shares.

- [ ] **D7 — how the routing signal layer talks to Clef** (§A3). Blocks increments
  9–10. Options: (a) widen the shared `ClefQuestion`/`ClefAnswer` types to include
  `score` and arbitrary criteria, and stop hardcoding keep/discard in
  `adaptToClefRequest` (one contract, both callers — but it changes a file the tool
  judge depends on); (b) a routing-local request builder that imports
  `adaptFromClefResponse` and `readJudgeAnswer` and leaves `adaptToClefRequest`
  alone (but still touches the shared file — `readJudgeAnswer` is module-private
  at `:583` and must be exported — and leaves two builders to keep in sync).
  Recommendation: (a), because the hardcoded criteria in the shared adapter are
  already a latent bug class for any second caller, and one Clef contract is what
  makes §4's "works with every backend unchanged" claim true.

- [ ] **D8 — which dashboard.** (§A9) Blocks increment 21. In-repo TUI + dashboard
  config API, or `proxy_tray`, or both later.

- [x] **D9 — signal key format and outcome spelling → dot-form keys, bare outcome
  keys.** (§A10) Settled 2026-11-08 by amending the plan rather than the code, since
  no code reads either yet: keys are `"<type>.<name>"` plus `":<label>"` for `choice`
  (the examples are what config authors type, and they compose with the section
  paths), and a decision declares exactly one outcome as a bare key
  (`route` / `candidates` / `algorithm`) following §5.6, because the decision has its
  own section and a nested `outcome = {…}` levels it for nothing. §5.4's prose and
  §6.2/§6.4 were the outliers and were rewritten; increment 3 rejects zero or two
  outcome keys. Cheap now, expensive once configs are in the wild.

---

## P0 — Config surface (phase 0, first shippable slice)

Nothing here routes anything yet. It exists so every later increment has a validated
config to read, and so a broken config fails at load instead of at request time.

- [ ] **1. `ProxyConfig.routing` types.** *Plan §6, §10 row 4.*
  - `src/utils/config-loader.ts`: add `routing?` to `ProxyConfig` (`:27`), next to
    `composite`/`schedule`, matching the inline-table convention.
  - Types to declare: `RoutingConfig` (`strategy`, `apply_to`, `budget_ms`, optional
    `degrade`, optional `embedding`), `RoutingSignalConfig` (a discriminated union on
    `type`: `keyword` | `decision` | `structure` | `context` | `embedding`),
    `RoutingProjectionConfig`, `RoutingRuleNode` (recursive: `signal` leaf |
    `{and: […]}` | `{or: […]}` | `{not: […]}`), `RoutingDecisionConfig` (`priority`,
    `tier?`, `rules`, `on_unknown?`, `outcome` — the name is the section suffix from
    D5, not a field), `RoutingOutcome` (`route` | `candidates` | `algorithm`).
  - **Done when:** types compile and a fixture object literal of every variant in
    §6.2's example type-checks; `npm run typecheck` clean.

- [ ] **2. Parse `[routing]`.** *Plan §6; form settled in D5, spelling in D9.*
  - `parseSimpleToml` (`:3357`): section dispatch for `routing`, `routing.embedding`,
    `routing.signals`, and the keyed `routing.projections.<name>` /
    `routing.decisions.<name>` — the same depth as `[models.<category>]`, so a new
    `parts[0]` branch with `parts[2]` as the name, not a new parsing mechanism.
  - `parts[2]` empty, or a name containing `.`, or a `name =` key inside the section →
    hard error (§A1). Strip surrounding quotes from `parts[2]` first — the plan quotes
    signal keys, and `section.split('.')` (`:3401`) is not quotes-aware, so a quoted
    name is only safe because dots in names are rejected.
  - Duplicate `[routing.decisions.<name>]` → hard error, not the existing
    warn-and-overwrite (§A1, rule 8).
  - One recursive inline-table/array parser (§A2), built on `splitTopLevel` (`:1840`)
    and used by signals, projections (`terms`/`bands`), and `rules` — not three
    hand-rolled copies.
  - Decide whether to extend the multi-line fold (`:3382`) from balanced `[]` to
    balanced `[]` **and** `{}`. The plan now states the section-by-force rule (§A1),
    so this is a convenience — a nested `question = { … }` could span lines like a
    `terms = [ … ]` already can — not a requirement. Small change to a path every
    existing config goes through, so it needs its own test either way (a one-line
    config must parse byte-identically).
  - The plan is already amended (§A1, §A11): §5.4's key prose, §6, §6.2, §6.3 and
    §6.4 use keyed sub-sections with bare outcome keys. Parse that form; do not
    re-decide it here.
  - **Done when:** §6.2's full Variant A example, copied verbatim from the plan in
    its keyed form, parses into the exact object the test asserts (deep-equal, not
    "did not throw"); a deliberately malformed rule tree produces a named error rather
    than an empty decision; and a duplicate decision section fails the load with its
    path named.

- [ ] **3. Validate and round-trip `[routing]`.** *Plan §6, §13; A7.*
  - `validateProxyConfig` (`:2290`): hard errors for unknown signal references, a
    `score` question without a predicate, a rule tree over the depth/node caps
    (default 8/64, §5.1), a `not` node with more than one child, an `embedding`
    signal with no provider unless `[routing].degrade = "skip"`, an unknown
    `strategy`/`apply_to`/`on_unknown`/`algorithm` value, a decision with zero or
    two outcome keys, and a projection band `emit` name that collides with any other
    signal or projection name — signals are one flat namespace (§5.4), so a collision
    silently shadowed by insertion order is the same class of bug as a duplicate
    section.
  - **Runtime** allow-list for `[routing.embedding].backend` (§6's "known gap" bullet;
    the union type at `:210` is compile-time only and the plan asks that this class of
    silent misconfiguration not exist for the new feature).
  - `serializeProxyConfigToml` (`:2854`) must emit the block so the dashboard editor
    does not drop it — the same hazard `COMPOSITE_META_KEYS` (`:639`) exists to
    prevent.
  - **Done when:** `tests/unit/config-loader.test.ts` has a parse → serialize → parse
    round-trip that is byte-identical for §6.2 **and** §6.4, and one test per load
    error above asserting the error *path* (e.g. `routing.decisions.code.rules`), not
    merely that validation failed.

## P1 — Evaluator: pure, no I/O

`src/utils/semantic-decision.ts` (§5.1). No `fetch`, no config, no logger — it takes a
`SignalSet` and decisions and returns a result, which is what makes the K3 matrix
testable without stubbing anything.

- [ ] **4. K3 tables and tree evaluation.** *Plan §2.2, §5.1.*
  - Leaf evaluation: leaf when `type != ''`; unsupported signal type is `False`; a
    leaf is *unresolved* only when its key is in `signalErrors` and it did not match
    (§2.2's exact wording — this is the property that must not drift).
  - AND: `False` short-circuits, `False` with `on_error` is recorded and downgraded at
    the end, `Unknown` sets state and continues; a node ending `Unknown` is forced
    `scored=false, kind=none`.
  - OR: any `True` wins, `preferredMatch` order (non-`on_error` > `on_error`,
    scored > unscored, higher confidence), `Unknown` only if nothing matched `True`.
  - NOT: strictly unary, warning + `False` when not.
  - **Done when:** `tests/unit/semantic-decision.test.ts` asserts all **nine** AND
    cells and all nine OR cells by their `state` *and* the three NOT cases, with
    `false AND unknown = false` and `true OR unknown = true` as their own named
    cases. The table is written as a literal, not derived from the implementation.

- [ ] **5. `on_unknown`, caps, and the unresolved-signal contract.** *Plan §2.3, §5.1,
  D4.*
  - Applied only when the raw state is exactly `Unknown`; preserve `originalState` for
    the trace (§2.3).
  - Depth cap (8) and node cap (64) enforced *at load* (increment 3) and defensively
    at eval, with a named error.
  - `fail_request`, **if** D4 keeps it: abort the entire evaluation with a typed
    error, no result, regardless of priority, and no decision's outcome applied.
  - **Done when:** one test per policy; and one test proving `fail_request` on a
    priority-100 decision aborts an evaluation in which a priority-900 decision
    already matched (§2.3's order-independence) and that the caller's fail-open path
    is taken with the typed error surfaced in the log line, not swallowed.

- [ ] **6. Score kinds, evidence, and the comparability gate.** *Plan §2.4, §5.2.*
  - `probability` (decision signals), `similarity` (embedding), `none` (everything
    else, including projections). `none` carries confidence 1.0 and is never evidence.
  - AND's aggregated confidence is a single evidence-bearing leaf's score only when
    exactly one exists; otherwise mean-of-children **reported, never ranked**.
  - `poolComparable(members)` exactly as §5.2 writes it.
  - **Done when:** three tests — an unscored pool, a mixed-kind pool, and a
    `none`-only pool each fall back to priority (with `decidedBy = "priority"`); a
    single-kind scored pool ranks by confidence. Plus one test pinning that an AND's
    mean-of-children never becomes `confidence` on the trace.

- [ ] **7. Selection and the ranking trace.** *Plan §2.5, §5.3.*
  - `selectBestDecision(results, strategy)`: tier (hard key when any matched decision
    declares one) → catch-all last → confidence (strategy `confidence`, only when
    comparable) or priority (strategy `priority`) → name.
  - `RankingTrace` with `decidedBy` ∈ `tier | catch_all | confidence | priority |
    name | only_candidate`, `candidates[]`, and a human-readable `reason` that says
    *why confidence was ignored* when it was.
  - **Done when:** one test per `decidedBy` value (six total), proving the comparator
    order rather than the winner alone; plus a no-match result that is distinguishable
    from "no `[routing]` block configured" (increment 15's log line depends on it).

## P2 — Signals: side-effecting, one flat namespace

`src/utils/signals.ts` (§5.4). Every evaluator returns a triple or an error slot —
never throws, never silently `False`.

- [ ] **8. Signal module skeleton + the local signal types.** *Plan §5.4, §12; A6.*
  - Key convention: `"<type>.<name>"`, plus `":<label>"` for `choice` signals
    (`decision.task:code`) — the form every plan example uses and what §5.4's prose
    now says (§A10, D9). One flat `signalConfidences` / `signalValues` /
    `signalErrors` map across types.
  - `keyword`: `keywords`, `mode: any|all`, `case_sensitive`, optional `fuzzy` +
    `fuzzy_threshold`. Evaluated over the **stripped** prompt — reuse
    `stripClientInjectedContent` (export it here; §A6) so a `<background>` block the
    client injects cannot create a signal.
  - `structure`: `has_tools`, `has_images`, `min_messages`, `min_tool_calls`,
    `min_content_chars`, over the parsed body.
  - `context`: `min_tokens`/`max_tokens` over the request's own token count — reuse
    the existing counter rather than adding a second estimator (rule 4).
  - **Done when:** `tests/unit/signals.test.ts` covers keyword modes and each
    structural field against fixture bodies, asserts the flat key format exactly, and
    pins that a client-injected block yields no keyword signal.

- [ ] **9. The `decision` signal, part 1 — request construction.** *Plan §5.4, §2.6,
  §4; D7.*
  - Build one batched `ClefRequest` holding exactly one question per *needed* signal,
    with stable ids, honouring the schema's caps (64 questions per request; `score`
    criteria 2–10 levels — `docs/api/decision/clef-schema-input.json`).
  - Route it through the existing client surface: `adaptFromClefResponse` (`:187`) for
    the answers map and `readJudgeAnswer` for the bounded read — module-private at
    `:583` today, so exporting it is part of this increment, the same surfacing A6
    flags for `stripClientInjectedContent`. Whatever D7 picks for
    `adaptToClefRequest` (`:153`), do not fork the transport.
  - **Done when:** a test asserts the outgoing body — question count, ids, `type`s,
    criteria — for a ladder that needs three signals, and that two signals sharing one
    question ask it once.

- [ ] **10. The `decision` signal, part 2 — answers, budget, laziness, cache.** *Plan
    §2.6, §7, §11; D3, A4.*
  - Per-type answer handling: `noul` → value + predicate (default `gte 0.5`);
    `choice` → `"decision.<name>:<label>"` match plus the bare `"decision.<name>"`
    value; `score` → value + required predicate. Write answers into both
    `signalValues` and `signalConfidences` under the D9 key form —
    `decision.<name>`, with the colon reserved for a `choice` label.
  - Absent / malformed / predicate-rejected answer → `signalErrors`, **unresolved**;
    transport failure → every question in the batch unresolved (§A4). Keep the two
    distinguishable in the report.
  - Lazy evaluation: walk the ladder in priority order and only ask for questions some
    still-possible decision needs; short-circuit on a match.
  - `budget_ms` accounting shared across all signals of the request (§D3), with the
    breach counter (§11) and *degrade to priority order*, never an error (§9).
  - Optional per-request cache keyed on the question-set hash + state text (§7).
  - **Done when:** `tests/unit/signals.test.ts` proves each answer type; a
    `choice` label that does not match the predicate lands unresolved and **not**
    `false`; a stubbed transport failure leaves all questions unresolved but yields a
    200 response through normal routing; a ladder whose top decision matches asks
    **zero** questions; a budget breach still serves the request and increments the
    counter.

- [ ] **11. Signal errors never masquerade as negative matches.** *Plan R1 item 2,
  §2.2, §9.*
  - This is its own increment because it is the failure mode that is invisible in
    production: a dead judge silently unbinding a rule moves traffic with no error
    anywhere.
  - **Done when:** a test per signal type proves a failing evaluator produces
    `signalErrors[key]` + unresolved (→ `Unknown` → `on_unknown`), and a
    mutation-check is recorded: forcing the failure path to `false` makes the routing
    test do the wrong thing.

## P3 — Wiring into dispatch

- [ ] **12. The resolver: signals → decisions → outcome.** *Plan §5.6, §10; D2.*
  - `src/utils/semantic-routing.ts` (or the resolver half of `signals.ts` if it stays
    small): evaluate, select, apply the winner's outcome. Ordering guarantee from
    §5.6: `route` decisions before `candidates` before algorithms; within a class, the
    ladder. A ladder with no match and no catch-all leaves the request exactly as
    today.
  - `route` outcome returns a model name for the caller to apply; `candidates`
    returns an ordered attempt list; `algorithm` delegates.
  - **Done when:** unit tests drive the resolver against fixture bodies for each
    outcome kind and assert the returned structure, including "no match → today's
    resolution unchanged".

- [ ] **13. Hook `apply_to = "composite"` (the default) into the composite branch.**
    *Plan §10 row 5, §3; D6, A8.*
  - `src/index.ts:1841`: the existing `resolveCompositeWithDecision` call site. The
    legacy `[composite.<alias>].decision` block becomes sugar for
    `algorithm = "decision"` in increment 19, so this call site ends up calling the
    new resolver — but only after 19, not before.
  - If D6 says a decision outcome bypasses runtime-share ordering, thread it where
    `_coordCandidate` already does (`src/index.ts:1866`).
  - **Done when:** `tests/unit/index-routing.test.ts` proves `candidates` changes
    `compositeAttempts[0]`, `route` rewrites `body.model`, and
    `apply_to = "composite"` leaves a direct model name untouched.

- [ ] **14. Hook `apply_to = "all"`.** *Plan §10 row 5; D2.*
  - `src/index.ts`: after `modelName` is read (`:1600`) and after schedule resolution
    (`:1612`), before deferred auth (`:1632`) and before the auth-ladder branch
    (`:1638`) — so a routing decision's model name is what auth sees. Skipped when
    the auth ladder owns routing, and when coordinator/fusion already own the alias.
  - **Done when:** a test proves the routed model reaches the upstream body for a
    non-composite path, and a second test proves the auth ladder / coordinator /
    fusion paths are unchanged with `[routing]` present.

- [ ] **15. The summary log line.** *Plan §9, §11.*
  - One line per routed request in the tool judge's style: strategy, resolved/total
    signals, matched decision, `decidedBy`, confidence with *why it was unranked*,
    elapsed vs budget, and every unresolved signal with its error string. Emitted on
    the **no-match** path too.
  - Elapsed time attributed so decision latency is not read as upstream latency (§11).
  - **Done when:** `SilentLogs`-off tests capture the line and assert its fields for
    three cases: matched-and-scored, matched-by-priority-after-mixed-kinds, and
    no-match. A test asserts nothing is logged when no `[routing]` block exists.

- [ ] **16. Fail-open, one test per failure path.** *Plan §9, §12, AGENTS rule 8.*
  - Timeout, 502/bad envelope, unparseable answer, below-threshold confidence, a
    `fail_request` abort (if D4 keeps it) — each still serves the request through
    today's exact/wildcard/composite/catch-all resolution, and each is *reported*.
  - **Done when:** `tests/unit/semantic-decision.test.ts` has one test per path
    asserting both halves: a 200 response **and** the reported signal/error. Mirror
    the existing decision-composite tests' shape.

## P4 — Projections (phase 1)

- [ ] **17. `weighted_sum` + `threshold_bands`.** *Plan §5.5, §6.3, §12.*
  - Terms over signal values with signed weights; a missing/unresolved term
    contributes its configured `default` (default `0`) and is **counted** in the
    report (rule 8). A projection is never `Unknown`.
  - Bands are first-match-wins with `[gte, lt)` bounds; emitted names become signals of
    type `projection`, kind `none`, confidence 1.0 — referenceable by decisions,
    never ranked on.
  - **Done when:** `tests/unit/semantic-projections.test.ts` pins exact sums, each
    band boundary (`0.399…`, `0.40`, `0.749…`, `0.75`), the imputed-term count, and
    that an emitted name lands in `signalValues`/matches as `projection.<name>`.

- [ ] **18. `sigmoid_distance` calibration + `multi_emit`.** *Plan §5.5, §6.3.*
  - Small, and only worth building with a config that uses it — if none does, delete
    this item rather than shipping dead surface (rule 2).
  - **Done when:** if built, a test pins the monotone map at slope 10 across the
    configured band edges and `multi_emit`'s "every matching band emits" against
    `threshold_bands`' first-match on the same input.

## P5 — Decision-mode unification (phase 2)

- [ ] **19. `[composite.<alias>].decision` becomes sugar for `algorithm = "decision"`.**
    *Plan §5.6, §2, §12.*
  - `resolveCompositeWithDecision` (`:1008`) keeps its fail-open behaviour and its
    auto-generated `target_selection` question from `buildDecisionQuestions` (`:1145`);
    it becomes the `algorithm = "decision"` implementation rather than a separate
    path.
  - `getCompositeAliasMode` (`:1167`) keeps its precedence chain and its
    `decision`-branch conditions (`hasDecisionConfig && hasAbility && !hasPriority`)
    **unchanged** — the mode is a reporting/TUI concern now, not a dispatch switch.
    Do not "simplify" it while wiring the resolver (rule 3).
  - **Done when:** every existing composite-decision test still passes unmodified, and
    a new test asserts a §6.1 config and the equivalent `[routing]` ladder produce the
    same candidate order and the same `target_selection` question body.

## P6 — Documentation and dashboard

- [ ] **20. Docs.** *Plan §13, D8.*
  - `docs/reference/semantic-decision.md` (signals, decisions, projections, outcomes,
    `on_unknown`, the degradation story, a worked ladder), index entries, the
    `[routing]` block in `docs/reference/configuration-reference.md`,
    `docs/reference/routing-and-aliases.md` (where the layer sits in resolution
    order), a note in `docs/architecture/design_decision_composite_targeting.md` that
    this subsumes it, a commented `[routing]` example in
    `docs/getting-started/proxy_config.example.toml`, and a `CHANGELOG.md` entry that
    says existing config is unaffected.
  - **Done when:** each file above is updated in the same commit as the code it
    describes, and the example config in `proxy_config.example.toml` is added to the
    parse/validate round-trip test so it cannot rot.

- [ ] **21. Dashboard surface.** *Plan §10 row 8; D8 decides the target.*
  - Render/edit the `[routing]` block without dropping it on save (depends on
    increment 3's serializer), and surface `decidedBy` distribution + budget-breach
    counter. If `justified_by = only_candidate` dominates, the ladder is decoration —
    that is the number worth showing.
  - **Done when:** `tests/unit/dashboard-config.test.ts` round-trips a config with a
    `[routing]` block through the dashboard's read/write path, and the stats test
    asserts the two counters exist in the payload.

## P7 — Optional: Variant B, the embedding classifier (phase 3)

**Do not start before phase 0–2 ships and §12.1's measurement says the per-request
judge call is the bottleneck, or a taxonomy outgrows one `choice` question** (plan
§15.3). Nothing here changes any config that does not declare an `embedding` signal.

- [ ] **22. Provider contract + Ollama backend.** *Plan §8.2, §8.3, A3.*
  - Four-method contract (`embed`, `embedBatch`, `dimension`, `backend`) with optional
    capabilities in separate interfaces (§R5). Thin HTTP client reusing the existing
    converters `toOllamaEmbedRequest`/`fromOllamaEmbedResponse`
    (`src/handlers/embeddings.ts:28`, `:47`) — they are currently module-private, so
    export them (rule 4).
  - Dimension **asserted** from config, mismatch = error (§8.3). Prototype embeddings
    computed once at startup; a failure is a **loud load-time error**, never a silently
    empty bank.
  - **Done when:** tests cover a cold cache, a dimension mismatch as an error (not a
    truncation), the cache key `(backend, model, dimension, textHash)`, and a startup
    prototype-embedding failure surfacing as a load error.

- [ ] **23. The `embedding` signal.** *Plan §5.4, §8.4.*
  - Aggregation `mean|max|any`; contrastive `negative_candidates` requiring
    `positive − negative ≥ margin/threshold`; match is `score >= threshold`
    (inclusive); confidence is a monotone map of the score; kind `similarity`.
  - `prototype_scoring` (clustering ≤8 centroids at 0.9) **only if** measurement asks
    for it — it is an optimisation over a candidate list that must exist and be tuned
    first (§R5).
  - **Done when:** `tests/unit/embedding-signal.test.ts` pins cosine values on
    fixtures, each aggregation, the negative margin, the inclusive threshold, and that
    an unreachable provider leaves the signal **unresolved** (→ `on_unknown`), never
    `false`.

- [ ] **24. Manual verification procedure.** *Plan §8.4.*
  - Extend `tests/manual/verify_decision_e2e.sh` (21 checks today, driving real proxy
    processes against `tests/manual/stub_clef_upstream.ts`) with the ladder: start the
    judge (and Ollama for Variant B), send a real prompt, read the ranking trace.
  - **Done when:** the script has a check per `decidedBy` path and one per unresolved
    signal kind, and the README documents that MLX is Apple-Silicon-only so CI cannot
    run it — the honesty constraint is part of the deliverable, not a footnote.

## P8 — Evidence and measurement (long-running online experiments; they follow
phases 0–2 and never gate them — §A12)

- [ ] **25. D vs C — zero new proxy code, and not a gate.** *Plan §12.1, sequencing
    amended 2026-11-10 (§A12).*
  - Extend `tests/perf/benchmark.ts` with the four-arm harness: a labeled prompt suite
    (~300–500), a fixed 3–5 model pool, and the capability matrix (every model × every
    prompt → `{score, tokens, latency, cost}`). Then replay the **existing** arms:
    `share`/weighted (D) and `[composite.*.decision]` (C). This answers "does judge
    selection beat weighted random at all" from modes that already exist — but it is a
    long-running online experiment over live traffic (the §12.1 shadow-validation
    step), not a development test, so it runs after phases 0–2 ship and nothing in
    P0–P5 waits on its verdict.
  - **Done when:** the harness reports regret-vs-oracle per category, quality-per-dollar
    against the cheap↔best line, and the routing-overhead share — and it states which
    figures are stubbed. Judge latency must be measured on real hardware; a
    stub-derived overhead number is worthless here (§12.1's honesty constraint).

- [ ] **26. A against the same matrix, once the evaluator exists.** *Plan §12.1.*
  - Replay is a lookup, not a re-run. Run judge arms 3× to expose drift; add the
    labeled-ideal router as the ceiling any category policy can reach.
  - **Done when:** §12.1's "reading the results" table is filled in with this repo's
    numbers, and the conclusion (build / don't build / hybrid) is written into the
    plan rather than left in a terminal.

- [ ] **27. B only if A's measured overhead justifies it.** *Plan §12.1, §15.3.*
  - Determinism is B's selling point — verify it, do not assume it.
  - **Done when:** the same harness reports B's regret and overhead beside A's.

- [ ] **28. Close the phase gate.** *Plan §14.*
  - Phases 0–2 = a complete router: no embedding model, no new process, no new runtime
    dependency (three today). Verify that claim, do not assert it: `package.json`
    dependencies unchanged, no new sidecar, Workers-shaped `fetch` handler still the
    entry point (`src/index.ts`, served by `src/server.ts`).
  - **Done when:** those three checks are recorded here with the command or diff that
    proves each.

---

## Deferred / not planned

- `set` and `span` questions (plan §16, phase 4) — no config needs them.
- Learned feedback / cross-request state (plan §16).
- Any streaming-path change: decisions run pre-dispatch, before a stream exists.
- In-process `transformers.js`/ONNX embeddings (plan §8.2 option C) — rejected while
  it breaks the Node/Workers parity the split plan maintains.
- Changes to `fusion`, `coordinator`, `share`, `fallback` modes.
- Phase-4 prototype clustering, `multi_emit`, and the mean-of-children confidence as a
  ranking key (plan R4: report it, never rank on it).

## Verification discipline for this document

- An item is `[x]` only with its *Done when* satisfied and a test path (or a command)
  named in the item.
- Mutations that prove a test bites are recorded in the item, then reverted — the
  spool TODOs' convention, kept here because most of these items are failure paths
  where a passing test can mean the path was never reached.
- If an increment disproves a plan sentence, the plan is amended in the same change
  and the amendment is listed under **§A** here — the plan is the contract, and a
  contract that quietly disagrees with the code is worse than no plan.
- Anything left unwired when an increment closes is named in the item as *scope*, with
  the reason it is out — not dropped silently (rule 8).
