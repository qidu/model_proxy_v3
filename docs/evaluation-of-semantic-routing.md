# Evaluating Semantic Routing Signals and Decisions

Separate **“Did the rules execute correctly?”** from **“Did routing choose a better model?”**. The ranking trace proves the first; only outcome evaluation proves the second.

This evaluation approach applies to the signals and decisions proposed in [Semantic Decision Layer: review and draft plan](./plan-semantic-routing-decision.md).

## 1. Evaluate signals independently

Build a labeled request dataset covering normal, boundary, and failure cases. Replay it without dispatching upstream requests.

| Signal | Evaluation |
|---|---|
| `keyword` | Exact expected matches, case handling, overlapping phrases, and false positives |
| `structure` / `context` | Fixtures with and without tools/images; token boundaries such as 31,999 and 32,000 |
| `decision.task` | Intent precision/recall and a confusion matrix between `chat`, `code`, and `analysis` |
| `decision.difficulty` | Agreement with human labels, including exact and within-one-level agreement |
| `decision.needs_verification` | Precision/recall against examples that do and do not require verification |
| `embedding.code_task` | Threshold sweep over code, poetry, email, and ambiguous requests; verify negative candidates reduce false positives |

For every signal, record:

- Match rate and resolved/unknown rate.
- Confidence/value distribution.
- Evaluation latency.
- Stability across repeated runs, especially for judge signals.
- Errors and timeouts.

A signal with high accuracy but frequent timeouts may still be unsuitable for a high-priority decision.

## 2. Test decision behavior with golden cases

Give the pure evaluator precomputed signal results and assert the selected decision, outcome, and `decidedBy`. This requires no model or network.

For the examples added to the draft:

| Input condition | Expected effect |
|---|---|
| 32,000 tokens | `long_context` wins by priority |
| Tools + `task:code` | `agentic_code` supplies its ordered candidates |
| `task:code` without tools | `agentic_code` does not match |
| Hard + `task:analysis` | `difficult_analysis` routes to `deepseek-v4-pro` |
| Hard + `task:code` | `difficult_analysis` does not match |
| Brief + `task:chat` | `brief_chat` selects the flash model |
| Brief + `task:code` | `brief_chat` does not match |
| No specific match | `fallback` wins as catch-all |
| Judge signal unresolved with `on_unknown = "no_match"` | Evaluation continues to lower-priority decisions |
| Multiple decisions match | Verify tier, confidence comparability, priority, and name ordering |

Also test projection boundaries (`0.40`, `0.75`), negative weights, and unresolved-term imputation counts.

These tests detect **shadowed rules**: a high-priority decision that prevents lower-priority decisions from ever being used.

## 3. Measure routing effectiveness offline

For a representative prompt set, run each candidate model on the same prompt and score the responses using task tests, human review, or an independent evaluator.

Then compare:

- Existing static/composite baseline.
- Existing ability-based composite decision.
- Proposed semantic ladder.
- Oracle selection—the best available model for each request.

The most useful metric is **quality loss versus the oracle**:

```text
best available model score − score of the model selected by routing
```

Also report cost and latency. A router that selects the best model but always chooses the most expensive one may not be useful. If appropriate, define a fixed utility combining quality, token cost, and latency before evaluating the results.

## 4. Run in shadow mode before enabling it

On real traffic, evaluate the semantic decisions but continue serving through the existing route. Log:

- Baseline route and proposed route.
- Signal states, values, confidences, and errors.
- Matched candidates, winner, and `decidedBy`.
- Decision latency and budget breaches.
- Route-change and fallback rates.

Inspect routes by category, especially requests where the proposal disagrees with the baseline. The dashboard statistic described in §11 of the draft is useful here: if almost everything is decided by `fallback` or `only_candidate`, the ladder is not adding much value.

## 5. Validate live outcomes with a limited A/B rollout

After shadow results look sensible, enable the new routing for a small cohort and compare:

- Task success or response-quality score.
- Human preference on a sampled set.
- Retry/fallback and upstream-error rates.
- End-to-end latency, including decision overhead.
- Token usage and cost per successful request.
- Unknown-signal and decision-budget-breach rates.

Use the existing composite/static route as the control. Do not judge success merely from how often decisions match—**a high match rate only shows that the ladder is active, not that it improves outcomes**.

The draft’s §12 already covers evaluator correctness; the missing operational evaluation is mainly **labeled offline replay → shadow comparison → measured A/B rollout**.
