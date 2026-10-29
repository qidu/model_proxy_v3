# Semantic Decision Layer: review and draft plan

Status: **Draft** — Part I (review) and Part II (plan)
Date: 2026-05-21
Scope: A review of the vLLM Semantic Router's decision core and classification
layer, and a plan to grow this proxy's existing Clef `/decision` composite
selection into a general semantic routing layer — named signals, a priority
ladder of decisions with three-valued AND/OR/NOT rules, score projections, and
pluggable selection algorithms.

**Yes — the decision model alone is enough for semantic routing.** Classification
happens *inside* the judge, as typed `noul` / `choice` / `score` questions; the
ladder above it is ordinary rule evaluation with no model involved. An
embedding-backed classifier is an **optional accelerator** that buys latency,
determinism and large-taxonomy accuracy — not capability (§7.1).

Two build paths: **Variant A** (decision model only, no local embedding — the
default, and a complete product) and **Variant B** (adds the optional embedding
classifier).

Related: [Design: Using `/decision` API for Composite Alias Target Selection](./architecture/design_decision_composite_targeting.md)
(the existing feature this plan extends), [Design: Fusion Composite Alias](./architecture/design_fusion_composite_alias.md),
[Plan: LLM as Verifier Plugin](./architecture/plan-llm-as-a-verifier-plugin.md).

---

# Part I — Review: the reference decision core and classification layer

Reviewed: `../semantic-router` — `src/semantic-router/pkg/decision/` (the
evaluation core, ~1.9k lines with tests), `src/semantic-router/pkg/classification/`
(the classifier that computes the signals), `src/semantic-router/pkg/embedding/`
(the provider contract and prototype scoring), `src/semantic-router/pkg/config/`
(the rule and signal types), and the reference recipe
`config/recipes/decision-balance/config.yaml` (an 11-decision ladder that
exercises the whole design).

Part I is the judgement. **§2 describes the mechanics it is judging** — read the
two together; Part I does not restate the tables and types.

## R1. What the design gets right

Five properties carry the design. All five are worth porting, and four of them
are the difference between a router you can debug and one you cannot.

1. **Three-valued logic, used honestly** (`engine.go:105-111`). Signals that
   cannot be evaluated become `unknown`, not `false`. The Kleene tables are
   applied asymmetrically on purpose: `false AND unknown = false` (one refuted
   conjunct refutes the conjunction) but `true AND unknown = unknown`; dually
   `true OR unknown = true` and `false OR unknown = unknown`. This is the
   correct treatment of partial information, and it is the property that makes
   the whole system behave sanely when a judge model is flaky.
2. **A signal failure can never masquerade as a negative match**
   (`engine.go:438-445`). An unresolved leaf is tracked through
   `SignalErrors`/`SignalErrorMatches` and resolved explicitly by policy, rather
   than falling through to "didn't match". Without this, a dead judge silently
   unbinds a routing rule and traffic moves with no error anywhere.
3. **`on_unknown` as an explicit, per-decision policy** (`engine_unknown.go:27-49`).
   The author of a decision declares what an unresolved signal means *for that
   decision* — `match`, `no_match`, or `fail_request`. Defaulting this globally
   would be wrong; making it per-decision is right.
4. **A deterministic total order over matches** (`selection.go:91-125`): tier as
   a hard key, catch-all always last, then confidence-or-priority, then name.
   Every request resolves to exactly one decision by a rule you can state in a
   sentence.
5. **A ranking trace** (`ranking_trace.go:14-30`) recording `decidedBy`
   (`tier` | `catch_all` | `confidence` | `priority` | `name` | `only_candidate`)
   and the candidate set. This answers "why did this request go there" after the
   fact. It is the single most operationally valuable output of the package and
   it costs almost nothing.

## R2. The confidence comparability gate is the subtlest and most valuable piece

`selection.go:48-76` refuses to compare confidences unless every non-catch-all
matched decision is `scored && !onError` **and** all their score kinds are
identical. Failing that, the pool is disqualified and **priority decides**.

Two consequences make this the right design:

- **It makes confidence an optimisation, never the contract.** Declared priority
  is always a safe answer; confidence applies only where it means something.
  A ladder degrades from "smart" to "predictable" rather than to "arbitrary".
- **It prevents false precision.** A `0.62` cosine similarity and a `0.9` judge
  probability are different units. Without the gate, a mixed ladder ranks on
  arithmetic that has no meaning, and the config author cannot tell which
  decision won or why.

The mechanism is subtle because it is *derived*, not declared: a decision is
`ConfidenceScored` only if its tree declares exactly one score kind
(`engine.go:271-274`), and because OR evaluates to its winning branch verbatim,
a tree whose branches carry different kinds self-disqualifies. AND aggregation
adds a second subtlety — an AND's confidence equals a single evidence-bearing
leaf's score only when exactly one such leaf reported one; otherwise it is a mean
over matched children and is explicitly **not** scored.

**Verdict: port the gate exactly.** Port the mean-of-children value as a
reported number only, never as a ranking key.

## R3. Cost of the design, paid knowingly

- **Confidence only flows from a small set of signal types.** Score kinds exist
  for `probability` (domain, classifier, decision, safety, preference) and
  `similarity` (embedding, reask, kb); `complexity`/`jailbreak` are `unknown`;
  everything else — keyword, language, pii, context, structure, event, metadata,
  projection, action, authz — is `none` and carries no evidence. So a ladder
  built mostly from keyword and structural signals **cannot rank by confidence at
  all**; it is a pure priority ladder. That is a real constraint on how a config
  can be written and should be documented, not discovered.
- **Projections deliberately discard their own arithmetic.** A projection emits
  band *names* as signals of kind `none` (`projection_config.go:120-143`), so a
  decision referencing `effort_high` cannot see the score that produced it and
  cannot be confidence-ranked. Good boundary — the evaluator stays small — but it
  means a projection-driven ladder is priority-driven by construction.
- **`fail_request` is global and order-independent.** An unresolved signal in any
  decision aborts the *entire* evaluation with no result, even if a
  higher-priority decision already matched (`engine_unknown_test.go:176-232`).
  It is a sharp tool with no scoping mechanism.

## R4. What not to port

| Not ported | Why |
|---|---|
| Unbounded rule nesting | The reference recurses with no depth or node cap. Acceptable for hand-authored config; not acceptable for config a dashboard writes. Cap both. |
| 29 signal types | Each needs a classifier, a fixture, and a doc row. Five cover the routing cases here (§5.4); add more only when a config genuinely cannot be expressed without one. |
| `set` / `span` question types | A new answer shape and a new predicate form for cases `noul`/`choice`/`score` already cover. |
| Mean-of-children confidence as a ranking input | It is not a comparable quantity. Report it; do not rank on it. |
| The model-runtime coupling | `embedding_models` defaults `Backend` to the model runtime and ships `Qwen3`/`MmBert`/multimodal paths. This proxy has no in-process model machinery and should not grow one (§8.2). |
| `fail_request` as a default | The reference makes it available; our convention is fail-open with a loud report (§9). Keep it opt-in at most. |

## R5. The classification and embedding layer — verdict

`classifier.go` is a `Classifier` owning an `embedding.Provider` plus one
sub-classifier per signal family, and a `modelservice.Decider` for decision
questions. The parts worth taking are the *contracts*, not the classifiers:

- **The provider interface is four methods** (`provider.go`) — `Embed`,
  `EmbedBatch`, `Dimension`, `Backend`. Optional capabilities sit in separate
  interfaces (`ConfigurableProvider`, `ImageProvider`, `AudioProvider`,
  `FullInputProvider`, `InputChecker`) so the base contract stays implementable
  by anything, including a plain HTTP client. **This is the shape to copy for
  Variant B.**
- **Contrastive negative candidates are the cheapest precision win** in the whole
  config surface. A rule asserting "looks like code" without also asserting "but
  not like a poetry request" fires on both. `EmbeddingRule` carries
  `NegativeCandidates` and `NegativeImageCandidates` for exactly this.
- **`aggregation_method: mean | max | any`** is the second-cheapest win: `max`
  for a rule that should fire on one strong phrasing, `mean` for a rule that
  should require broad agreement.
- **`PrototypeScoring`** (`prototype_scoring_config.go`) clusters candidate
  phrasings into ≤8 centroids at a 0.9 similarity threshold, with
  `BestWeight`/`TopM`/`MarginThreshold` blending. Worth having, but **not worth
  building first** — it is an optimisation over a candidate list that has to
  exist and be tuned before clustering helps.
- **Dimension is asserted, not inferred** (`openai_provider.go` carries
  `ExpectedDimension`). A silently truncated or zero-padded vector produces
  plausible-looking nonsense, which is worse than an error.

Weaknesses, both inherited if we copy naively: the type surface is large enough
that a config can describe a signal no backend can compute, and the
`PrototypeScoringConfig.Resolve` rule (a present config replaces the family
default wholesale rather than merging into it) is a merge semantics users
reliably misread.

## R6. Contract compatibility — the enabling finding

The Clef wire schema this proxy already speaks (`docs/api/decision/`) is a
**strict subset** of the reference's `modelservice.Decider` typed-question
contract: same request envelope, same per-question `type`/`instructions`/
`criteria`, same `answers` map. Clef adds `images`; the reference adds `parts`
and a windowed-scan `max_tokens`. `noul`, `choice`, and `score` mean the same
thing on both sides, and `selection.DecisionModelSelector`
(`selection/decision_model.go`) is the reference's own twin of this proxy's
`decision` composite mode — same idea, same failure mode, same fail-open
external-dependency declaration.

**This is what makes the plan cheap.** The evaluation layer can be built above
the wire protocol, so it works unchanged with `laya`, `cloudflare`/`clef`, and
`ollama`, and no adapter is needed. It also means the plan is not speculative:
the design being ported is already running, in Go, against the same contract.

---

# Part II — Plan: semantic decision layer for this proxy

## 1. Goal

Today a composite alias can ask one question — *"which of these models, given
their declared `ability` strings?"* — and reorder its candidate list from the
answer. That is the whole of this proxy's semantic routing.

This plan makes that one hard-coded question into a general mechanism:

- **Signals** — named, typed predicates over the request (`keyword`, `decision`,
  `structure`, `context`, and — optionally — `embedding`), each evaluating to
  `{state, confidence, value}`. Only `embedding` needs a model of our own; the
  rest are local reads or judge questions.
- **Decisions** — a priority-ordered ladder of rules over those signals,
  combining them with AND/OR/NOT under three-valued (true/false/**unknown**)
  logic, each decision naming an outcome.
- **Projections** — weighted score sums mapped through threshold bands, so a
  model's *level* answer (`score`) can drive routing the way the router's
  reference `decision-balance` recipe drives an `effort` band.
- **Algorithms** — the outcome of a matched decision is either a static
  candidate order, or the existing LLM `choice` selection (which becomes one
  algorithm among several rather than the only option).

**The decision model is the classification layer.** Every semantic judgement in
this design — what the request is about, how hard it is, whether it needs
verification — is a typed question answered by the judge the proxy already
calls. Nothing in the ladder depends on an embedding model; §7.1 states exactly
which capabilities are available without one.

### 1.1 Why general policy-based semantic routing?

The existing composite decision is already a narrow form of semantic routing.
The main benefit of this proposal is not semantic understanding itself, but
**general policy-based semantic routing**: replacing one hard-coded target
selection question with reusable signals, explicit rules, and multiple routing
outcomes.

| Aspect | Existing composite decision | Draft semantic decision |
|---|---|---|
| Scope | Targets within one composite alias | Composite candidates or direct model routing |
| Semantic input | One fixed `choice` question | Multiple named `noul`, `choice`, and `score` questions |
| Other signals | Prompt, history, tools, and abilities embedded in judge context | Explicit keyword, structure, context, decision, and optional embedding signals |
| Rules | Implicit: choose one target | Configurable AND/OR/NOT rule trees |
| Multiple policies | No | Priority/tier ladder with catch-all decisions |
| Score combination | No | Projections such as weighted difficulty/verification scores mapped to effort bands |
| Outcomes | Reorder existing candidates | Pin a route, supply candidates, or invoke a selection algorithm |
| Failure handling | Fail open to normal composite candidate ordering, which is not necessarily declaration order | Three-valued `unknown` handling, per-decision policy, and fail-open reporting |
| Observability | Limited selection logging | Ranking trace explaining the winner and whether tier, priority, confidence, or catch-all decided |

The existing feature can ask, *"For this alias, which declared target best fits
the request?"* The general layer can instead express: *"If the request contains
images, route to the vision model; otherwise, if it is a difficult code task,
use the powerful coding model; if it is easy and the user wants brevity, use the
cheap model; otherwise use the default."*

Its benefits are:

- **Better routing decisions** — route on intent, difficulty, context size,
  tools, images, keywords, or combinations rather than model abilities alone.
- **Deterministic overrides where needed** — high-priority structural or policy
  rules can constrain or bypass judge-based selection instead of trusting one
  LLM answer for everything.
- **Reusable, explainable policies** — named signals and decisions can be shared,
  while the ranking trace explains why a route won and how partial failures were
  handled.

The trade-off is complexity and potentially additional judge latency. If the
only requirement is *"pick the best target inside this alias"*, the existing
composite decision is simpler and sufficient. The general layer adds
configuration, evaluator and test surface, and a decision budget that must be
managed through batching, lazy evaluation, and caching. Embeddings are not the
main benefit: they are an optional accelerator for latency, determinism, and
large-taxonomy accuracy, not a prerequisite for semantic routing (§7.1).

Non-goals are in §16. The existing `decision` composite mode keeps working
unchanged; it is expressed by the new machinery as one special case (§5.6).

---

## 2. Background: the reference implementation in detail

Part I is the review — what the design gets right, what it costs, and what is
not worth porting. This section is the **mechanics** those judgements rest on,
recorded in enough detail to reimplement: the evaluation model, the three-valued
tables, the confidence mechanics, selection, typed questions, projections, and
the embedding contracts.

### 2.1 Evaluation model

`DecisionEngine` holds `keywordRules`, `embeddingRules`, `categories`,
`decisions`, `strategy`. Each request is evaluated into a `SignalMatches`
value: one `[]string` of matched rule names per signal type
(`keywordRules`, `embeddingRules`, `domainRules`, … 24 types in all), plus

- `SignalConfidences map[string]float64` keyed `"<signalType>:<ruleName>"` (and
  `"<signalType>:<ruleName>:<label>"` for labelled answers), defaulting to `1.0`
  when unreported;
- `SignalValues map[string]float64` — the raw numeric answer before predicate
  application;
- `SignalErrors map[string]string` and `SignalErrorMatches map[string]bool` —
  which signals failed to evaluate and whether their fallback value matched.

A `Decision` carries `Name`, `Priority`, `Tier`, a recursive `RuleNode` tree,
`ModelRefs`, `Algorithm`, `Plugins`, and an output contract. `RuleNode` is
`{Type, Name, Label, Predicate, OnError, OnUnknown, Operator, Conditions}`; a
node is a leaf when `Type != ""`, and `IsCatchAll()` is true for an entirely
empty node or a childless root AND.

The engine walks the tree bottom-up (`evalNode`), producing
`{state, confidence, scored, matchedRules, onError, kind, evidence}` per node.

### 2.2 Three-valued logic — port this exactly

Three states: `evaluationFalse=0`, `evaluationTrue=1`, `evaluationUnknown=2`.
This is strong Kleene (K3), and the tables are the load-bearing part:

| AND | T | F | U |
|-----|---|---|---|
| **T** | T | F | U |
| **F** | F | F | F |
| **U** | U | F | U |

| OR | T | F | U |
|----|---|---|---|
| **T** | T | T | T |
| **F** | T | F | U |
| **U** | T | U | U |

`NOT`: `T→F`, `F→T`, `U→U`.

The asymmetries are deliberate and were verified against the reference's
`engine_unknown_test.go`: `false AND unknown = false` (an AND is refuted by one
refuted conjunct regardless of the rest), while `true AND unknown = unknown`
(the AND is still undetermined). Dually, `true OR unknown = true` and
`false OR unknown = unknown`. `NOT unknown = unknown` — an unknown premise never
becomes a confident conclusion.

Evaluation rules on top of the tables:

- **AND** — any `False` child without `on_error` short-circuits the whole node to
  `False`; `False` *with* `on_error` is recorded and evaluation continues, later
  downgrading the node to `{False, onError: true}`. Unknown children set the node
  state to `Unknown` and continue. A node that ends `Unknown` is explicitly
  `scored=false, kind=none`.
- **OR** — any `True` child wins. Among multiple `True` children,
  `preferredMatch` picks: a non-`on_error` match over an `on_error` one, then a
  scored match over an unscored one, then the higher confidence. If nothing is
  `True` but some child was `Unknown` → `Unknown`; otherwise `False`.
- **NOT** — strictly unary (a non-unary NOT warns and evaluates `False`).
  `False→True` (confidence 1, inherits the child's matched rules), `Unknown→Unknown`,
  `True→False` (carries the child's confidence).
- **Leaves** — an unsupported signal type is `False`. Otherwise the signal type
  resolves to a name list and membership is the test. A leaf is *unresolved* when
  its key is present in `SignalErrors` **and** it did not match (or its
  error-match flag is set). An unresolved leaf becomes `Unknown` when a policy is
  configured; if the type is `classifier`/`decision` with `on_error: "match"` it
  becomes `True` with confidence 1 and `onError: true`; otherwise it degrades to
  a plain `False` match test.

### 2.3 `on_unknown` — the one place a decision may refuse to decide

Applied only when a decision's raw state is exactly `Unknown`:

| policy | result |
|---|---|
| `match` | `True`, confidence 1, unscored, matched rules `["on_unknown:match"]` |
| `no_match` | `False`, confidence 0 |
| `fail_request` | throws `DecisionUnresolvedError` wrapping `ErrDecisionUnresolved` |

`fail_request` on **any** decision aborts the whole evaluation and returns no
result, regardless of that decision's priority — an unresolved required signal
overrides an otherwise-valid match. The engine preserves `originalState` for
traces so the pre-policy state is still observable.

### 2.4 Confidence and score kinds — port the gate, not the arithmetic

Confidence is compared between matched decisions only under a strict
comparability gate:

- Each decision's confidence is compared only if that decision is
  `ConfidenceScored` = `scored && !onError` **and** its rule tree declares
  exactly one score kind.
- A pool of candidates (keyed by tier when tiered, else a single pool) is
  *comparable* only when **every** non-catch-all member is `ConfidenceScored`
  and all their score kinds are identical. Otherwise the pool is disqualified
  and **priority decides**.

Score kinds: `probability` (domain, classifier, decision, safety, preference),
`similarity` (embedding, reask, kb), `unknown` (complexity, jailbreak), and
`none` (keyword, language, pii, context, structure, event, metadata, projection,
action, authz, …). A `none` leaf carries confidence 1.0 but is never *evidence*.

AND aggregation is the subtle part: an AND's confidence is comparable only when
**exactly one** evidence-bearing leaf reported a score — then the AND's
confidence *is* that leaf's score. Otherwise the AND's confidence is the mean
over matched children and it is marked `scored=false, kind=none`. Because OR
returns the winning branch's evaluation verbatim, a decision whose tree declares
more than one score kind is automatically disqualified from confidence
comparison.

**Why this matters for us:** without the gate, a ladder of decisions would
compare a `0.62` embedding similarity against a `0.9` judge probability and pick
a winner by arithmetic that means nothing. The gate converts "unknown
comparability" into "fall back to declared priority", which is always a safe
answer. Port the gate. The mean-of-children fallback arithmetic is worth
keeping too, but only as an observability value — never as a ranking key.

### 2.5 Selection

`selectBestDecision` sorts matched results with `decisionResultLess`:

1. **Tier** — if any matched decision has `tier > 0`, lower tier wins outright
   (a hard pre-filter, not a weighted factor).
2. **Catch-all** — a non-catch-all always ranks before a catch-all.
3. **Confidence** — only when the pool is comparable *and* the two values differ.
4. **Priority** — higher wins.
5. **Name** — lexicographic, as a deterministic tie-break.

Order of (3) vs (4) is the strategy switch: `strategy = "confidence"` puts
confidence first, `strategy = "priority"` puts priority first. There are exactly
two strategies. Note that a *tiered* match and a *catch-all* fallthrough are both
expressed through this one comparator, and the ranking trace records which rule
decided (`tier`, `catch_all`, `confidence`, `priority`, `name`, `only_candidate`).

### 2.6 Typed decision questions

The Go `modelservice.Decider` contract and the Clef wire schema agree on the
question types:

| type | question | answer | match semantics |
|---|---|---|---|
| `noul` | yes/no | `noul: 0..1` | predicate over the probability (default `gte 0.5`) |
| `choice` | pick one of N | `choice`, `probabilities`, `confidence` | matches `"<rule>:<choice>"`; the chosen option also lands under `"<rule>"` |
| `score` | ordered rubric | `score`, `legend`, `probabilities`, `confidence` | matches when the expected level passes the predicate (predicate required) |
| `set` | labels above threshold | `selected: string[]` | per-label keys `"<rule>:<label>"` |
| `span` | labelled spans | `spans` | per-label keys |

Answers are written into both `SignalValues` and `SignalConfidences` under
`"decision:<rule>"`, so a later numeric predicate (`difficulty gte 2`) reads the
same number a `choice`/`score` question produced.

A failed or timed-out question writes `SignalErrors["decision:<rule>"]` and
leaves the signal unresolved → `Unknown`, never `False`. That is the property
that keeps a flaky judge from silently rerouting traffic.

### 2.7 Projections

`routing.projections.scores` compute a named score (e.g. `weighted_sum` over
signal values, with negative weights allowed), and
`routing.projections.mappings` map that score through a calibration into named
outputs. Two mapping methods: `threshold_bands` (first band whose bounds
contain the score) and `multi_emit` (every matching band emits). Calibration may
be `sigmoid_distance` with a slope, which turns a raw similarity into a smooth
0..1 effort number instead of a hard cliff.

The engine never sees the projection's internals — it sees the emitted band
names as a signal list under signal type `projection` with score kind `none`.
That is a good boundary: **projections are a config-time computation that
produces ordinary signals**, so the evaluator stays small.

The router's reference `decision-balance` recipe is the worked example worth
copying: an 11-decision ladder from `guard` (priority 1000, jailbreak OR safety
→ fast refusal) down to `fast` (priority 100, an empty catch-all), with
`long_context` keyed on a token count, `agentic` keyed on `has_tools AND
(task:agentic OR needs:tools gte 0.5)`, a `frontier` decision whose algorithm is
the LLM `decision` selection, and an `effort` projection over
`weighted_sum(difficulty 0.3, needs:deliberation 0.35, needs:verification 0.1,
brief_request −0.35)` mapped into four bands by a sigmoid of slope 10.

### 2.8 The classification/embedding layer

`pkg/classification/classifier.go` is a `Classifier` that owns an
`embedding.Provider` plus one sub-classifier per signal family (keyword,
jailbreak, PII, fact-check, hallucination, feedback, reask, preference,
language, structure, complexity, knowledge base) and a `modelservice.Decider`
for decision questions.

The embedding contract is deliberately tiny:

```go
type Provider interface {
    Embed(ctx, text string) ([]float32, error)
    EmbedBatch(ctx, texts []string) ([][]float32, error)
    Dimension() int
    Backend() string
}
```

Two backends: `model_runtime` (local, embeddings come from the model runtime's
prepared set) and `openai_compatible` (remote HTTP, with retries, response-size
cap, and a never-truncate-on-the-server rule for full-input embedding).
Capability interfaces (`ImageProvider`, `AudioProvider`, `FullInputProvider`,
`ConfigurableProvider`) let an embedding rule ask for image/audio/layer/dimension
without the base provider having to support it.

`EmbeddingRule` is: `Name`, `Threshold`, positive `Candidates`, contrastive
`NegativeCandidates`, `AggregationMethod` (`mean` | `max` | `any`), and
`QueryModality` (`text` | `image` | `audio` — the latter two require a multimodal
model type). `PrototypeScoring` adds a clustering step so that a rule with many
candidate phrasings scores against a few cluster prototypes rather than a flat
max over every phrasing — with `ClusterSimilarityThreshold` (default 0.9),
`MaxPrototypes` (default 8), `BestWeight`, `TopM`, `MarginThreshold`.

**Negative candidates are the cheapest precision win** and are the part most
worth copying: a rule that says "looks like code" without also saying "but not
like a poetry request" will fire on both.

### 2.9 What not to port

See **R4** in Part I for the list and the reasoning behind each row. The gates
it names are enforced at config load (§6) rather than left to reviewer
discipline: rule-tree depth and node caps, an allow-list of signal types, and no
ranking on mean-of-children confidence.

---

## 3. What already exists in this proxy

The seam is already there and needs generalising, not inventing.

| Piece | Location | Today |
|---|---|---|
| Clef endpoint | `src/handlers/decision.ts` | pure pass-through of `POST /decision` to `[models.decision].url`; envelope-only validation; verbatim body forward; 502 on a bad upstream envelope |
| Clef client | `src/utils/tool-judge-sidecar.ts` | `callDecisionApi()`, `adaptToClefRequest()`, `adaptFromClefResponse()`, `requestTimeoutMs()` |
| Composite selector | `src/utils/config-loader.ts` | `resolveCompositeWithDecision()`, `buildDecisionState()`, `buildDecisionQuestions()` |
| Alias mode | `src/utils/config-loader.ts` | `getCompositeAliasMode()` → `coordinator \| fusion \| fallback \| decision \| share` |
| Hook point | `src/index.ts` | `resolveCompositeWithDecision(...)` at the pre-dispatch composite branch, already async and already reordering candidates |
| Local judge | `submodules/laya-mlx` | `serve_judge.py` serves the Clef `/decision` protocol (and a legacy `/judge`) from one process |
| Embeddings | `src/handlers/embeddings.ts` | **proxy only** — forwards `/v1/embeddings` upstream, with an `ollama-embed` upstream mode. No in-process embedding model, no ONNX, no transformers.js |

Three properties of the existing implementation are load-bearing for this plan:

1. **`resolveCompositeWithDecision` fails open on every error path** — no
   `decision` block, no target with `ability`, no `target_selection` answer,
   no `choice`, confidence below `threshold`, selection not a candidate, or any
   throw → the candidates from `getCompositeRouteCandidates()` are returned
   unchanged. This is normal composite ordering, not necessarily declaration
   order: primary/fallback ordering or weighted/share selection may already have
   been applied.
2. **The proxy is a Workers-shaped `fetch` handler**
   (`export default { async fetch(request, env) }`) served on Node via
   `src/server.ts`. Anything in-process must survive both targets.
3. **The request body is already fully buffered** before routing, so a decision
   can inspect and rewrite it freely. But the model is fixed for the lifetime of
   a streaming response — a decision must complete *before* the upstream fetch.

---

## 4. Contract compatibility

The Clef schema (`docs/api/decision/clef-schema-input.json` /
`clef-schema-output.json`) is a strict subset of the router's
`modelservice.Decider` typed-question contract: same `model`/`state`/`questions`
request, same per-question `type`/`instructions`/`criteria`, same
`answers` map. Clef adds `images`; the router adds `parts` and `max_tokens`.
`noul`/`choice`/`score` mean the same thing on both sides.

**Consequence:** the plan's signal layer can speak Clef unchanged, and the
existing backends (`laya`, `cloudflare`/`clef`, `ollama`) keep working with no
adapter. The evaluation engine sits *above* the wire protocol, so it is
independent of which backend answers.

---

## 5. Architecture

```
  request body
      │
      ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ 1. SIGNALS      named predicates → {state, confidence, value}│
  │    decision · keyword · structure · context · embedding (opt)│
  └──────────────────────────┬──────────────────────────────────┘
                             ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ 2. PROJECTIONS  weighted_sum → threshold_bands               │
  │    emits ordinary signal names (score kind: none)            │
  └──────────────────────────┬──────────────────────────────────┘
                             ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ 3. DECISIONS    priority ladder, K3 AND/OR/NOT, on_unknown   │
  │    → first match (tier → catch-all → confidence → priority)   │
  └──────────────────────────┬──────────────────────────────────┘
                             ▼
  ┌─────────────────────────────────────────────────────────────┐
  │ 4. OUTCOME      route | candidates | algorithm               │
  │    static order · decision(LLM choice) · weighted · nothing  │
  └─────────────────────────────────────────────────────────────┘
```

### 5.1 The evaluator

New module `src/utils/semantic-decision.ts` (evaluator, pure) plus
`src/utils/signals.ts` (signal evaluators, side-effecting). The evaluator takes
an already-computed `SignalSet` and a decision list and returns a result — it
must not perform I/O, which is what makes it testable without stubbing fetch.

```ts
type EvalState = 'true' | 'false' | 'unknown';

interface LeafEval {
  state: EvalState;
  confidence: number;      // 1.0 when unreported
  value?: number;          // raw numeric answer, when the signal produced one
  scored: boolean;         // reported AND kind !== 'none' AND evidence === 1
  evidence: 0 | 1;         // 0 for policy leaves, which never carry evidence
  kind: ScoreKind;         // 'none' | 'probability' | 'similarity'
  onError: boolean;
  matchedRules: string[];
}

interface DecisionResult {
  decision: DecisionConfig;
  confidence: number;
  scored: boolean;         // = leaf.scored && !onError
  kind: ScoreKind;
  catchAll: boolean;
  matchedRules: string[];
}
```

AND/OR/NOT and leaf evaluation port §2.2 and §2.3 literally, including:

- the exact K3 tables;
- `preferredMatch` for OR (non-`on_error` > `on_error`, scored > unscored,
  then higher confidence);
- `Unknown` nodes forced to `scored=false, kind=none`;
- `fail_request` aborting the whole evaluation with a typed error and no result;
- **new:** a depth cap (default 8) and a node-count cap (default 64) per rule
  tree, rejected at config load. The reference's unbounded recursion is fine for
  hand-written config and not fine for a config a dashboard writes.

### 5.2 Confidence and the comparability gate

Port §2.4 in full, because it is the difference between a robust ladder and a
ladder that silently picks by noise:

```ts
// A pool is comparable only when every non-catch-all member is scored and all
// score kinds agree. Otherwise priority decides.
function poolComparable(members: DecisionResult[]): boolean {
  const scored = members.filter((m) => !m.catchAll);
  if (scored.length === 0) return false;
  if (!scored.every((m) => m.scored)) return false;
  return new Set(scored.map((m) => m.kind)).size === 1;
}
```

Score kinds in this proxy are only three — `probability` (from `decision`
signals), `similarity` (from `embedding` signals), and `none` (everything else,
including projections). A mixed ladder therefore falls back to priority, which
is the intended behaviour: **declared priority is the contract; confidence is an
optimisation that applies only when it is meaningful.**

### 5.3 Selection

`selectBestDecision(results, strategy)` with the comparator from §2.5:
tier (hard key, when any matched decision declares one) → catch-all last →
confidence-if-comparable (strategy `confidence`) or priority
(strategy `priority`) → name. Emit the same ranking trace shape as the
reference so a decision can be explained after the fact:

```ts
interface RankingTrace {
  strategy: 'priority' | 'confidence';
  tiered: boolean;
  comparable: boolean;
  decidedBy: 'tier' | 'catch_all' | 'confidence' | 'priority' | 'name' | 'only_candidate';
  winner?: string;
  runnerUp?: string;
  candidates: Array<{ name: string; priority: number; tier?: number; confidence?: number; scored: boolean }>;
  reason: string;
}
```

`decidedBy` is the single most useful field for operators: it answers "why did
this request go to that model" without re-running anything.

### 5.4 Signals

All signals produce the same triple, and all are keyed `"<type>:<name>"` (plus
`":label"` where a signal has labels), so `signalConfidences` /
`signalValues` / `signalErrors` are one flat namespace.

**Variant A signals (no embedding model required):**

| type | config | produces |
|---|---|---|
| `keyword` | `keywords`, `mode: any\|all`, `case_sensitive`, optional `fuzzy` + `fuzzy_threshold` | match + confidence 1.0, kind `none` |
| `decision` | `question` (Clef), optional `predicate`, `timeout_ms` | value + confidence, kind `probability`; labels for `choice` |
| `structure` | `has_tools`, `has_images`, `min_messages`, `min_tool_calls`, `min_content_chars` | match, kind `none` |
| `context` | `min_tokens`, `max_tokens` (over the request's own token count) | match, kind `none` |

**Variant B signal (optional — requires the embedding provider, §8):**

| type | config | produces |
|---|---|---|
| `embedding` | `candidates`, `negative_candidates`, `threshold`, `aggregation: mean\|max\|any`, optional `prototype_scoring` | value (best score) + confidence = a monotone map of the score into 0..1, kind `similarity` |

Semantics of an `embedding` signal, mirroring the reference's `EmbeddingRule`:

- score = the aggregation (`mean`/`max`/`any`) of cosine similarity between the
  request embedding and each positive candidate embedding;
- if `negative_candidates` are present, compute their aggregate the same way and
  require `positive - negative` (or a configured `margin`) to clear the
  threshold — this is what makes the signal a *contrastive* classifier instead
  of a bag of trigger phrases;
- `prototype_scoring` (optional, off by default) clusters the positive
  candidates at load time and scores against at most `max_prototypes` cluster
  centroids, with `best_weight` blending best-prototype and mean-of-top-m;
- match is `score >= threshold`.

Every signal evaluator returns an error slot rather than throwing. A signal that
cannot be computed (provider down, timeout, malformed answer) is recorded in
`signalErrors` and left **unresolved** — the evaluator then decides whether that
means `Unknown`, `False`-with-`on_error`, or an `on_unknown` policy. §2.6's rule
stands: **a failed signal is never silently `False`.**

### 5.5 Projections

```toml
[routing.projections.effort]
method = "weighted_sum"
terms = [
  { signal = "decision.difficulty",      weight = 0.30 },
  { signal = "decision.needs:deliberation", weight = 0.35 },
  { signal = "decision.needs:verification", weight = 0.10 },
  { signal = "keyword.brief_request",    weight = -0.35 },
]
bands = [
  { lt  = 0.40, emit = "effort_off"    },
  { gte = 0.40, lt = 0.675, emit = "effort_medium" },
  { gte = 0.675, lt = 1.15, emit = "effort_high"   },
  { gte = 1.15, emit = "effort_max"    },
]
```

- A term whose signal is missing or unresolved contributes its **weighted
  default** (configurable `default`, default `0`), and the projection records
  how many terms were imputed. A projection is never `Unknown` — it is a
  computation over values, and an imputed value is reported, not hidden
  (rule 8).
- `bands` are first-match-wins (`threshold_bands` semantics). A second method
  `multi_emit` (every matching band emits) is available for the "flag all
  applicable bands" case.
- Emitted names become signals of type `projection` with score kind `none` and
  confidence 1.0 — i.e. **projections can be referenced by decisions exactly
  like any other signal, and never participate in confidence comparison.** That
  is intentional and matches the reference.

A `sigmoid` calibration for a single embedding score
(`method = "sigmoid_distance", slope = 10`) is also supported, for the case
where one similarity number should be smoothly stretched across bands rather
than hard-thresholded.

### 5.6 Outcomes

A matched decision resolves to exactly one outcome:

```toml
# (a) pin a model — also covers non-composite, direct model names
[routing.decisions.long_context]
route = "glm-5.3-flash"

# (b) reorder a composite alias's candidates (the existing behaviour, generalised)
[routing.decisions.code]
candidates = ["qwen3.8-flash-next", "glm-5.3-flash", "qwen3.8-27b"]

# (c) delegate: ask the judge model to pick (the existing `decision` alias mode)
[routing.decisions.frontier]
algorithm = "decision"
```

| outcome | effect | fail-open |
|---|---|---|
| `route` | sets/overrides `body.model` before the composite branch | stays with the caller's model |
| `candidates` | ordered attempt list consumed by the existing retry loop | normal composite candidate ordering |
| `algorithm = "decision"` | the existing `resolveCompositeWithDecision` Clef `choice` call, with `ability`-derived criteria | normal composite candidate ordering (§3, already implemented) |
| `algorithm = "weighted"` | deterministic weighted pick over `share` | normal composite candidate ordering |
| `algorithm = "rate"` | client-declared output rate to a reasoning-effort/reasoning-model mapping | unchanged |

The existing `[composite.<alias>].decision` block becomes sugar for
`algorithm = "decision"` with auto-generated criteria, so no existing config
changes meaning. `getCompositeAliasMode()`'s `decision` branch keeps its
position in the precedence chain (`coordinator > fusion > fallback > decision >
share`) and simply delegates to the new resolver.

**Ordering guarantee:** `route` decisions run before `candidates` decisions run
before algorithms, and within a class the priority ladder applies. A decision
that never matches (no catch-all declared) leaves the request on today's exact /
wildcard / composite / catch-all model resolution, unchanged.

---

## 6. Config surface

A new top-level `[routing]` block, inline-table style to match `[composite]`:

```toml
[routing]
strategy = "priority"        # "priority" | "confidence"
apply_to = "composite"       # "composite" (default) | "all"

[routing.signals]
"brief_request"  = { type = "keyword", keywords = ["tl;dr", "briefly", "one sentence"], mode = "any" }
"code_task"      = { type = "embedding", threshold = 0.62, aggregation = "mean",
                     candidates = ["write a function", "fix this bug", "refactor the module"],
                     negative_candidates = ["write a poem", "summarize this email"] }
"task"           = { type = "decision",
                     question = { type = "choice", instructions = "Classify the request.",
                                  criteria = { chat = "…", code = "…", analysis = "…" } },
                     timeout_ms = 800 }
"difficulty"     = { type = "decision",
                     question = { type = "score", instructions = "How hard is this?",
                                  criteria = ["trivial", "easy", "moderate", "hard", "research-grade"] },
                     predicate = { gte = 2 } }

[routing.projections]
"effort" = { method = "weighted_sum", terms = [...], bands = [...] }

[[routing.decisions]]
name = "long_context"
priority = 900
rules = { signal = "context.beyond_window" }
outcome = { route = "glm-5.3-flash" }

[[routing.decisions]]
name = "code"
priority = 450
rules = { and = [ { signal = "projection.effort_medium" },
                  { or = [ { signal = "decision.task:code" },
                           { signal = "embedding.code_task" } ] } ] }
on_unknown = "no_match"
outcome = { candidates = ["qwen3.8-flash-next", "glm-5.3-flash"] }

[[routing.decisions]]
name = "fallback"
priority = 100
rules = { }                  # catch-all — always ranks last
outcome = { route = "qwen3.8-27b" }
```

Rules of the surface:

- `[routing.signals.*]` are declared once and referenced by name; ids are
  `[A-Za-z0-9_.-]+`. A `decision` signal names its own `deployment` optionally,
  defaulting to `[models.decision]`.
- `[[routing.decisions]]` is an array of tables so declaration order is visible,
  though priority (not order) is what ranks. `rules = { }` is the catch-all.
- `on_unknown` is per-decision, values `match | no_match | fail_request`, with
  `fail_request` explicitly documented as opt-in and not the default (§9).
- **Validation at load time** (`validateProxyConfig`): unknown signal references
  are hard errors; a `score` question without a predicate is a hard error (the
  reference requires it); a rule tree over the depth/node caps is a hard error;
  `embedding` signals declared without a configured embedding provider are a
  hard error *unless* `[routing].degrade = "skip"` is set, in which case they are
  reported as unresolved at request time (§8.4).
- **Known gap to not repeat**: the `[models.decision]` `backend` field is
  validated only as a union type, not at runtime — a typo like
  `backend = "cloudflair"` silently grants image support (the changelog
  documents this). Validate the embedding `backend` at load time with an
  explicit allow-list (`"ollama" | "openai" | "sidecar"`) so the same class of
  silent misconfiguration cannot exist for the new feature.
- Round-trip: `parseProxyConfig` / `serializeProxyConfig` gain `routing` so the
  dashboard's TOML editor does not drop the block — this is the same
  round-trip hazard `COMPOSITE_META_KEYS` exists to prevent.

---

## 7. Variant A — decision model only: a complete semantic router

**This is the default and the recommended first ship.** It adds no runtime
dependency, no new process, no new network path, and no model of our own: every
semantic judgement comes from the Clef judge the proxy already talks to, through
the endpoint `src/handlers/decision.ts` already forwards. **The judge is the
classifier.**

### 7.1 Is semantic routing available without an embedding model? Yes

An embedding model adds no class of routing decision that the ladder cannot
already express. What it adds is cost, determinism, and accuracy at scale. The
capability set, side by side:

| capability | Variant A (decision model) | + embeddings | note |
|---|---|---|---|
| Route on meaning, not keywords | **yes** — `noul`/`choice`/`score` | yes | the judge reads the prompt; this is the core capability |
| Multi-class intent (`decision.task:code`) | **yes** — one `choice` question | yes, and scales further | see the scaling note below |
| Ordinal level (`score` → `effort_high`) | **yes** | yes | `score` is the highest-value question type and needs no embeddings |
| Threshold gates (`precise_facts gte 0.8`) | **yes** | yes | |
| Multi-step intent ("needs verification *because* …") | **yes** | **no** | requires judgement, not similarity — a judge-only capability |
| Lexical / structural signals (keywords, tokens, tools, images) | **yes** | yes | local either way; no model involved |
| Contrastive boundary (positive vs negative phrasing) | **yes**, as prose in `instructions` | **better** — machine-checkable `negative_candidates` | quality, not capability |
| Per-request cost of an always-on signal | one batched judge round trip | **sub-millisecond** | the first real gap |
| Same input → same answer | no — a judge can drift | **yes** | the second real gap |
| Works when the judge is unreachable | **no** — degrades through normal fallback routing (§9) | yes, independently | a genuine dependency, stated plainly |

So the answer is yes, with two honest qualifications that are *dependencies*,
not capability gaps:

1. **The judge must be reachable.** Semantic routing without embeddings is not
   routing without a model — it is routing with the model you already have. When
   that model is down the layer fails open through normal model/composite
   resolution and says so (§9); it never invents a route.
2. **Cost and determinism, not expressiveness, are what embeddings fix.** A
   ladder whose signals fire on *every* request pays one batched judge call per
   request; a ladder that must produce byte-identical answers across runs for
   regression testing is better served by prototypes. Both are legitimate
   motivators for Variant B (§8.1); neither is a precondition for shipping.

**The one place the choice is not free.** A `choice` question puts every option
into a single prompt, so the judge performs an N-way discrimination in one pass;
a prototype bank instead compares against N independent vectors. Both are
linear in N, but only the first degrades in *accuracy* as N grows. A taxonomy of
a few tens of well-separated classes is fine on `choice` — and is better served
by a two-level question set than by pushing one question to hundreds of options.
It is at that scale that the embedding classifier becomes the right tool, and it
is why phase 3 is sequenced rather than struck (§14).

What Variant A gives you:

- a priority ladder that today's `[composite.*.decision]` cannot express — the
  existing feature can only reorder *one* alias's targets by one question;
- `score` questions driving bands (`difficulty gte 2`, `effort_high`), which is
  the single highest-value capability in the reference recipe;
- `choice` questions as labelled signals (`decision.task:code`), so a
  classification answer becomes a rule term rather than a whole routing
  decision;
- `noul` gates (`precise_facts gte 0.8`, `correction gte 0.6`) for the
  "is this special" checks;
- structural and keyword signals, which are free and cover a surprising amount
  of routing (token budget, image present, tool count).

Cost profile: **one judge call per `decision` signal per request**, so a
three-question ladder is three calls. Mitigations, all of which the plan
requires:

- one **batched Clef request** carrying every question of every signal that will
  be evaluated (§5.4 already produces one `state` per request) — Clef allows up
  to 64 questions per request, and the reference does exactly this;
- a **total decision budget** (`[routing].budget_ms`, default 1000) with a
  per-question split, reusing `requestTimeoutMs()`'s per-question semantics;
- **short-circuiting**: signals are declared, not evaluated eagerly. A decision's
  tree is walked lazily and a signal is only requested if some decision could
  still match — and the ladder is evaluated in priority order, so a high-priority
  match ends evaluation before the cheap structural signals are even needed;
- **an optional per-request cache** keyed on a hash of the judge question set +
  the state text, which collapses the repeated-identical-prompt case.

Latency: the reference's own numbers for the local judge are ~13 ms
end-to-end for a short typed decision, ~7 ms on the multilingual checkpoint, with
zero output tokens — but see §8.4's honesty note about what has actually been
verified in this repo. Budget for a worst case of the configured
`budget_ms`, and design so that exceeding it degrades to priority order rather
than to an error.

**Variant A is a complete product.** It is not a stepping stone that must be
finished by Variant B.

---

## 8. Variant B — the optional embedding classifier

Adds one signal type (`embedding`) backed by an embedding provider. Everything
else — evaluator, ladder, projections, outcomes — is unchanged, which is the
point: the decision engine is protocol- and provider-agnostic.

**This whole section is optional.** §7 already ships the same routing
capabilities without it, and no config that avoids declaring an `embedding`
signal changes meaning if this is never built. Read §8.1 first: it is the case
for building it, and the case against building it speculatively.

### 8.1 What embeddings actually buy, and what they do not

Worth saying plainly, because the framing "semantic routing needs embeddings" is
wrong about this proxy (§7.1 shows the capability set is identical). The judge
model already reads the prompt semantically; an embedding does not add
understanding. What it adds is:

1. **Latency** — a cosine similarity against precomputed prototypes is
   sub-millisecond and needs no network hop, versus a judge round trip.
2. **Determinism** — the same text gets the same score every time. A judge's
   answer can drift between calls, which makes a ladder hard to reason about and
   hard to regression-test.
3. **Cost at volume** — a signal that fires on every request (e.g. "is this a
   security-sensitive question") should not cost an LLM call per request.
4. **Contrastive precision** — negative candidates give a cheap, auditable way
   to carve a signal's boundary, which a `noul` question expresses only as prose
   in `instructions`.

And what it does not buy: anything the judge already does better. Multi-step
intent ("needs verification *because* the user is asking for a factual claim
about their own code") is a judge question, not an embedding threshold. The plan
therefore positions embeddings as a **cheap pre-filter and a stability layer in
front of the judge**, not a replacement for it — which is exactly the shape the
reference recipe uses (embedding rules for stable lexical-ish boundaries,
`decision` questions for judgement, projections combining both).

### 8.2 Provider options

| option | where it runs | new deps | Workers-safe | notes |
|---|---|---|---|---|
| **A. Ollama `/api/embed`** (recommended) | separate local process | none | yes (plain HTTP) | the proxy already has the request/response converters for this exact endpoint in `src/handlers/embeddings.ts` (`toOllamaEmbedRequest`, `fromOllamaEmbedResponse`) |
| **B. Extend `submodules/laya-mlx` with `/embeddings`** | the judge sidecar | none in the proxy | yes | one local process for judge + embeddings; but CI checks out `submodules: false`, so nothing embedding-related can be integration-tested there |
| **C. `transformers.js` / ONNX in-process** | the proxy itself | a heavyweight runtime dep (the proxy has 3 runtime deps today) | **no** — would need a Node-only guard, breaking the Worker/Node parity the split plan maintains | best latency and no extra process; worst blast radius |
| **D. Remote OpenAI-compatible `/v1/embeddings`** | an upstream | none | yes | zero new client code (the handler exists) but it is not *local*, and it adds a network dependency to the routing hot path |
| **E. Gemini / provider-native embeddings** | an upstream | none | yes | same as D, per-provider auth |

**Recommendation: A, with B as a documented alternative and C rejected for now.**
Rationale: A reuses converters that already exist and are already tested
(`tests/unit/embeddings.test.ts`), keeps the proxy dependency-free and
Workers-shaped, and matches the repo's existing sidecar convention that
capabilities live behind a URL. C is the option that would be most attractive on
latency grounds and the one to revisit *only* if measurements show the HTTP hop
dominates — it is not worth breaking Workers parity speculatively (rule 2).

This is a decision for the repo owner; it is listed in §15.

### 8.3 Config

```toml
[routing.embedding]
backend = "ollama"                  # "ollama" | "openai" | "sidecar"
url = "http://localhost:11434"      # ollama: base URL; openai: full /v1/embeddings URL
model = "nomic-embed-text"
timeout_ms = 200
dimension = 768                     # asserted; a mismatch is a load-time error
cache_size = 512                    # best-effort LRU, per isolate
```

- **Prototype embeddings are computed once at startup** and cached. A failure to
  embed the prototypes is a **load-time error**, loudly reported — not a
  silently empty prototype bank that makes every signal `unknown` forever.
- **Request embeddings** are computed once per request and shared by every
  `embedding` signal (one call, many rules).
- **Dimension is asserted, not inferred.** A provider returning a different
  dimension than configured is an error, because a silently truncated or
  zero-padded vector produces plausible-looking nonsense.
- **The cache is best-effort and must not be treated as state.** In Workers the
  isolate is short-lived; on Node it persists. Both must be correct with a cold
  cache, and the cache must be keyed on `(backend, model, dimension, textHash)`.

### 8.4 Honesty note on verification

`CHANGELOG.md` records that **no live `serve_judge.py` has ever been reached in
this repo's test runs** (MLX is Apple-Silicon-only), and CI checks out with
`submodules: false`. Everything about the decision path that is currently
"verified" is verified against stubs. Variant B must not be described as
"working" on the strength of unit tests against a mocked provider. The plan
requires:

- a documented manual verification procedure, **extending the one that already
  exists**: `tests/manual/verify_decision_e2e.sh` (21 checks) drives real proxy
  processes against `tests/manual/stub_clef_upstream.ts` over the live HTTP path,
  which is what the unit tests deliberately do not do. The new ladder needs the
  same treatment — start Ollama, start the judge sidecar, run a real prompt, and
  read the ranking trace;
- explicit degradation: when the embedding provider is unreachable, `embedding`
  signals are **unresolved**, which the ladder resolves through `on_unknown` or,
  by default, degrades to priority order. It must not be possible for a dead
  embedding endpoint to change routing silently.

---

## 9. Fail-open, fail-loud

`AGENTS.md` rule 8 ("errors must be thrown, returned, or reported — never
swallowed") is in tension with the decision path's documented fail-open
behaviour. The proxy already resolves this tension for the tool judge, and this
plan follows that precedent:

- **Behaviourally fail open.** A decision layer must never turn a working
  request into a 500. If the judge is unreachable, times out, returns a
  malformed envelope, or answers below threshold, routing proceeds on the
  ladder's priority order and then on today's exact/wildcard/composite/catch-all
  resolution. The request is served.
- **Report loudly.** Every decision evaluation emits one summary line in the
  style the tool judge already uses:

  ```
  Semantic decision (strategy=priority): 3/4 signals resolved, matched "code"
  (decided_by=priority, confidence 0.71 unranked: mixed score kinds) in 84ms
  [1 unresolved: decision.difficulty (timeout after 800ms)]
  ```

  Counts of resolved/unresolved signals, which decision matched, why it won
  (`decidedBy`, and *why confidence was ignored* when it was), and the elapsed
  time against the budget. Unresolved signal names and their error strings are
  always included.
- **`fail_request` is opt-in and never the default.** A config that wants a hard
  failure declares it per decision, and the plan documents it as advanced.
- The same line is emitted on the *no match* path, so "nothing matched" is
  visible rather than indistinguishable from "no feature configured".

---

## 10. Integration points

| # | File | Change |
|---|---|---|
| 1 | `src/utils/semantic-decision.ts` | **new** — evaluator (pure): K3 logic, ladder, selection, ranking trace |
| 2 | `src/utils/signals.ts` | **new** — signal evaluators: keyword, structure, context, decision (Clef via the existing client), embedding (Variant B, optional) |
| 3 | `src/utils/embedding-provider.ts` | **new** (Variant B, optional) — thin HTTP provider, reusing the converters from `src/handlers/embeddings.ts` |
| 4 | `src/utils/config-loader.ts` | `[routing]` types + parse + serialize + validate; `resolveCompositeWithDecision` delegates to the new resolver; `getCompositeAliasMode` unchanged in precedence |
| 5 | `src/index.ts` | call the new resolver at the existing pre-dispatch point (the composite branch that already awaits `resolveCompositeWithDecision`), and — for `apply_to = "all"` — immediately after `modelName` is read from the body |
| 6 | `src/handlers/decision.ts` | unchanged (still the Clef pass-through the signals call into) |
| 7 | `src/utils/tool-judge-sidecar.ts` | unchanged; the new code imports `callDecisionApi`/`adaptFromClefResponse` rather than duplicating them (rule 4) |
| 8 | dashboard | render/edit the `[routing]` block; show the ranking trace for a recent request |
| 9 | `docs/` | new `docs/reference/semantic-decision.md`; index entries; `CHANGELOG.md` |

**Hook-point note.** The request body is buffered before routing (§3), so
inspecting the prompt, the tool list, and the recent turns costs nothing extra.
The decision must complete before the upstream fetch, because a streaming
response fixes the model for its lifetime. This makes the decision a
**pre-dispatch** concern with no interaction with streaming, retries, or the
transform hooks.

**Interaction with the transform hooks.** A `before_upstream` hook can rewrite
`body.model` but cannot change the chosen upstream target, so it is the wrong
place for routing decisions. Documented as such to prevent a future
implementation from reaching for it.

---

## 11. Observability

- **One summary log line per routed request** (§9), plus the ranking trace at
  debug level.
- **Dashboard stats**: per-decision match counts and `decidedBy` distribution.
  This is the number that tells you whether the ladder is doing anything — if
  `decidedBy = only_candidate` for every request, the ladder is decoration.
- **Budget breach counter**: how often the decision budget was exceeded, which
  is the signal to either raise `budget_ms` or move a signal to embeddings.
- Decision latency must be attributed so it is visible in the routing-overhead
  accounting rather than appearing as unexplained upstream latency.

---

## 12. Test strategy

Conventions taken from the repo: `node:test` + `node:assert/strict`, flat files
in `tests/unit/`, **no HTTP server and no network**, sidecars stubbed by
monkey-patching `globalThis.fetch` and asserting the outgoing body.

| area | test | property verified |
|---|---|---|
| evaluator | `tests/unit/semantic-decision.test.ts` | **all nine K3 cells** for AND and OR, all three NOT cases, plus `false AND unknown = false` and `true OR unknown = true` specifically |
| evaluator | same | `on_unknown` × `match`/`no_match`/`fail_request`; `fail_request` on a low-priority decision overrides a high-priority match and yields no result |
| evaluator | same | depth and node caps reject over-deep trees at load |
| confidence | same | comparability gate: an unscored pool, a mixed-kind pool, and a `none`-kind pool each fall back to priority; a single-kind scored pool ranks by confidence |
| selection | same | tier beats priority; catch-all ranks last; name breaks ties; `decidedBy` is correct in each case |
| signals | `tests/unit/signals.test.ts` | keyword modes; structural signals against fixture bodies; a `<background>`-style client-injected block does **not** create signals (reuse `stripClientInjectedContent`, rule 4) |
| signals | same | a failing signal lands in `signalErrors` and is **unresolved**, never `false` |
| clef body | same | the batched request carries exactly one question per needed signal, with stable ids, and is forwarded byte-for-byte through the existing endpoint |
| projections | `tests/unit/semantic-projections.test.ts` | `weighted_sum` values; band boundaries are `[gte, lt)` with the first band matching; imputed terms are counted and reported; emitted names appear as `projection` signals of kind `none` |
| embedding | `tests/unit/embedding-signal.test.ts` | cosine math on fixtures; `mean`/`max`/`any` aggregation; negative-candidate margin; threshold boundary is inclusive; **dimension mismatch is an error, not a truncation** |
| provider | same | prototype-embedding failure at startup is a loud error; a cold cache is correct; the cache key includes backend/model/dimension |
| routing | `tests/unit/index-routing.test.ts` | decision changes `compositeAttempts[0]`; `route` rewrites `body.model`; `apply_to = "composite"` leaves direct model names untouched |
| fail-open | `tests/unit/semantic-decision.test.ts` | every failure path (timeout, 502, bad envelope, unparseable answer, below-threshold confidence) still serves the request through normal fallback routing — one test per path, mirroring the existing decision-composite tests |
| config | `tests/unit/config-loader.test.ts` | parse → serialize → parse round-trips `[routing]` losslessly; unknown signal references and score-without-predicate are load errors; the legacy `[composite.*.decision]` block still resolves identically |

Two tests deserve calling out as the ones that matter most, because they cover
the failure modes that are invisible in production: **the full K3 table** (a
one-cell regression changes routing under partial information, silently) and
**unresolved ≠ false** (a dead judge that degrades to `false` reroutes traffic
with no error anywhere).

---

## 13. Documentation

- `docs/reference/semantic-decision.md` — signals, decisions, projections,
  outcomes, `on_unknown`, the degradation story, and a worked ladder.
- `docs/reference/configuration-reference.md` — the `[routing]` block.
- `docs/reference/routing-and-aliases.md` — where the decision layer sits
  relative to exact/wildcard/composite/schedule resolution.
- `docs/architecture/index.md` — append this plan under Feature Plans.
- `docs/architecture/design_decision_composite_targeting.md` — mark the
  relationship: this plan subsumes it; the existing mode remains supported.
- `CHANGELOG.md` — under Latest Changes, describing the added `[routing]` block,
  the new signal types, and that existing config is unaffected.
- `docs/getting-started/proxy_config.example.toml` — a commented `[routing]`
  example, consistent with how `[tool_judge]` and `[models.decision]` are
  documented there.

---

## 14. Phasing

| phase | content | size | ships alone? |
|---|---|---|---|
| **0** | evaluator + signals (`keyword`, `decision`, `structure`, `context`) + config surface; `route`/`candidates` outcomes; ranking trace; fail-open tests | **L** | yes — **this is the complete semantic router** |
| **1** | projections (`weighted_sum`, bands) | **M** | yes |
| **2** | `algorithm = "decision"` unification (existing mode becomes sugar); dashboard rendering | **M** | yes |
| **3** | *optional*: embedding provider + `embedding` signal + prototype scoring | **M** | yes |
| **4** | prototype clustering, `multi_emit`, set/span questions, learned feedback | **S–M each** | opt-in |

Phases 0–2 together are the product: a full semantic router with no embedding
model, no new process, and no new runtime dependency. Phase 0 is the bulk of the
work and the phase requiring the design decision in §15 to be settled first.

Phase 3 is an accelerator layered on top, and is the only phase that can be
dropped without changing any config that does not declare an `embedding` signal.
It is independent of phases 1 and 2, so it can be done by a different person in
parallel once phase 0's signal interface is frozen.

---

## 15. Open decisions (owner's call)

1. **Config shape — one `[routing]` block, or extend `[composite.*.decision]`?**
   The plan recommends a top-level `[routing]` block because decisions must be
   able to target direct model names, not only composite aliases, and because a
   ladder wants a flat priority space. The cheaper alternative keeps decisions
   alias-scoped: add `questions` and an embedding provider to the existing
   composite `decision` block and stop there. That is a real option and it is
   much smaller — it just cannot express "this request goes to a *different
   model*, not a different target of the same alias".
   Note this adds a **third routing dialect** alongside the existing fixed-route
   and model-route paths. Per `AGENTS.md` rule 5 this is surfaced rather than
   decided here.

2. **Embedding backend (§8.2).** Recommended: Ollama `/api/embed`, reusing the
   existing converters. Alternative: extend `submodules/laya-mlx` with
   `/embeddings` so one local process serves judge and embeddings. Rejected for
   now: in-process `transformers.js`/ONNX, which would break Node/Workers parity
   for a latency gain that has not been measured.

3. **Is Variant B wanted at all?** On the evidence in §7.1 the answer is
   probably not, at first: the decision model covers every routing capability,
   and embeddings buy cost, determinism and large-taxonomy accuracy rather than
   new expressiveness. Recommended: ship phases 0–2, measure the judge round
   trip on real traffic, and build phase 3 only if the measurement says the
   per-request judge call is the bottleneck or if a taxonomy outgrows a `choice`
   question. Building it in parallel with phase 0 would be speculative (rule 2).

4. **`fail_request` as an available value.** It is in the plan as an opt-in
   because the reference has it, but our fail-open convention argues for
   omitting it entirely. If no config is expected to want a hard failure, drop
   it and keep `match` / `no_match`.

5. **Plan location and naming.** Drafted at `docs/plan-semantic-decision.md`
   (root `docs/`) to sit alongside the other root-level plans; rename if this
   becomes a full design document rather than a plan.

---

## 16. Non-goals

- **No `set` or `span` questions.** `noul`/`choice`/`score` covers the routing
  cases; the extra answer and predicate shapes are not worth their surface.
- **No new sidecar process.** The decision layer calls endpoints that already
  exist (`/decision`, and one embeddings endpoint for Variant B).
- **No change to the `fusion`, `coordinator`, `share`, or `fallback` modes.**
  They keep their precedence in `getCompositeAliasMode`, and the decision layer
  sits where the existing `decision` branch already sits.
- **No learning / feedback loop.** Interesting, out of scope, cannot be
  validated here.
- **No cross-request state.** The scoring is per-request; the only cache is a
  best-effort embedding memo with no correctness role.
- **No streaming-path change.** Decisions run pre-dispatch, before any response
  stream exists.
