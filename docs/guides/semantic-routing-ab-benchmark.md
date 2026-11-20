# Benchmark decision routing against weighted random

This is the live A/B benchmark for the narrow semantic-routing subset: for each
request, either let the Clef decision model select a target or select one by the
configured `share` ratio. It uses the existing composite-alias implementation;
no embedding model, signal ladder, or new routing configuration is required.

## 1. Configure two aliases over the same pool

The aliases must reference exactly the same target models. Declare `ability`
and `decision` only on the decision alias, and `share` weights only on the
random alias:

```toml
[composite]
"bench-decision" = {"deepseek-v4-pro" = {ability = "reasoning,complex-coding,analysis"}, "deepseek-v4-flash" = {ability = "fast-coding,simple-tasks,chat"}, decision = {model = "laya", url = "http://127.0.0.1:8765/decision", threshold = 0.5, timeout_ms = 1000}}
"bench-random" = {"deepseek-v4-pro" = {share = 1}, "deepseek-v4-flash" = {share = 1}}
```

Both targets must already resolve through the normal `[models.*]` sections.
Restart the proxy after changing this configuration. Verify that the decision
service is reachable before the run; an unreachable decision service makes the
decision arm fail open to ordinary composite selection instead.

The example uses equal random weights. Change both arms to the desired candidate
pool, but only the random arm has weights.

## 2. Create a benchmark configuration

Save the following as `semantic-routing-ab.json`. Prices are USD per million
tokens and are keyed by the **upstream model ID returned in the response**, not
by the alias name. Remove `prices_per_million` if cost reporting is not needed.

```json
{
  "base_url": "http://127.0.0.1:8788",
  "decision_alias": "bench-decision",
  "random_alias": "bench-random",
  "repeats": 5,
  "max_tokens": 512,
  "temperature": 0,
  "request_timeout_ms": 120000,
  "prices_per_million": {
    "deepseek-v4-pro": { "input": 1.0, "output": 2.0 },
    "deepseek-v4-flash": { "input": 0.1, "output": 0.2 }
  },
  "judge": {
    "model": "independent-quality-judge",
    "timeout_ms": 120000
  },
  "prompts": [
    {
      "id": "code-1",
      "category": "code",
      "prompt": "Write a Python function that finds the first duplicate in a list, with tests.",
      "rubric": "Correct algorithm, clear edge-case handling, and meaningful tests."
    },
    {
      "id": "analysis-1",
      "category": "analysis",
      "prompt": "Explain the tradeoffs between optimistic and pessimistic locking for a small inventory service.",
      "rubric": "Technically correct comparison that reaches a practical recommendation."
    },
    {
      "id": "chat-1",
      "category": "chat",
      "prompt": "Rewrite this in one friendly sentence: Your request has been received and will be processed shortly.",
      "rubric": "One friendly sentence that preserves the original meaning."
    }
  ]
}
```

The `judge` block is optional. When present, it must name a fixed model that is
not either benchmark alias. Prefer a model outside the candidate pool and,
where possible, a different model family to reduce self-preference bias. Each
judge answer must be JSON with a numeric `score` from 0 to 1 and an optional
`reason`.

Use a representative labeled prompt set for a real comparison. The three
prompts above only demonstrate the format.

## 3. Run

```bash
# Optional: the benchmark sends Bearer sk-test by default.
# Set PROXY_API_KEY to override it:
export PROXY_API_KEY='your-proxy-key'

npm run benchmark:routing -- \
  --config docs/getting-started/semantic-routing-ab.json \
  --output /tmp/semantic-routing-ab.jsonl
```

Requests run sequentially through `/v1/chat/completions`. The two arms are
interleaved for each prompt and their order alternates, reducing systematic
time-of-run bias. Increase `repeats` to observe judge drift; use at least 20
repetitions when inspecting the random arm's selection proportions. More
repetitions are needed for stable quality or cost conclusions.

The command prints per-request outcomes and a summary for each arm:

- successful and failed requests;
- selected-model counts, overall and by category;
- mean and p95 end-to-end latency, including decision-routing overhead;
- prompt, completion, and total tokens;
- mean independent-judge quality score, when configured;
- total and mean estimated token cost for samples with known prices and usage;
- missing usage, missing prices, and judge failures.

The JSONL file contains the run configuration, every sample (including response
text and errors), and the final summary. A failed candidate or judge call is
recorded and reported, and the command exits nonzero after finishing the run.

## 4. Interpretation and limits

- **This is an online A/B comparison, not oracle regret.** It cannot prove that
  either arm chose the best available model for a prompt. For regret, run every
  candidate on every prompt, score that capability matrix, and replay the arm
  selections against it as described in
  [Evaluating Semantic Routing Signals and Decisions](../evaluation-of-semantic-routing.md).
- `selected_model` is the model in the final successful response. If the proxy
  retries another target, this is the served model, not necessarily the first
  model chosen by the arm. Upstream failures and adaptive share changes can
  therefore affect the observed mix.
- Candidate latency excludes the benchmark's optional quality-judge call. Judge
  latency is recorded separately.
- Cost covers reported candidate input/output tokens only. The current proxy
  response does not expose decision-model usage, so decision cost and the
  benchmark-only quality-judge cost are not included.
- Without `judge`, the run compares operations and cost only. Selection counts
  alone do not show better response quality.
- Compare quality, cost, and failures together. A higher-scoring arm that always
  chooses the most expensive model is not necessarily the better router.

For a capability-matrix evaluation and the later semantic signal ladder, see
[Semantic Decision Layer: review and draft plan](../plan-semantic-routing-decision.md).
