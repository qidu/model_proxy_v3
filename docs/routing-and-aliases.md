# Model Routing & Aliases

Full reference for how the proxy resolves a model name to an upstream, and for all alias types
(`[models.*]`, `[composite]`, `[schedule]`). The
[README](../README.md#routing-hierarchy-logic-levels) keeps the three-level hierarchy table and
the category lookup priority table; this doc covers everything else.

## Category lookup priority

Each `[models.<category>]` section groups models by provider. An incoming model name is
resolved against the configured sections in three priority levels (highest first):

| Priority | Lookup | Where it's checked |
|:--------:|:-------|:-------------------|
| 1 | **Exact key** match | All `[models.*]` sections |
| 2 | **`prefix-*` wildcard** | `models.claude`, then `models.gemini`, then `models.gpt` |
| 3 | **`*` catch-all** | `models.default` |

- An exact entry always wins over a wildcard in the same category — e.g. an explicit
  `claude-sonnet-4-6` is matched before `claude-*`.
- All sections except `[models.FREE]` and `[models.EMBEDDING]` support `prefix-*` wildcard
  matching. This includes built-in sections (`claude`, `gemini`, `gpt`) and any
  user-defined section (`nvidia`, `openrouter`, etc.).
- `[models.FREE]` and `[models.EMBEDDING]` are **exact-only** — they never pick up wildcards.
  Both names are case-insensitive (`free`/`FREE`, `embedding`/`EMBEDDING` are equivalent);
  UPPERCASE is the canonical form in documentation and example configs.
- Only `prefix-*` (hyphen before `*`) is a wildcard; the `*` is substituted so the
  upstream sees the real model name. A bare `*` key is the final `models.default`
  catch-all and preserves the original model name.

| Section | Exact | `prefix-*` | `*` catch-all |
|:--------|:-----:|:----------:|:-------------:|
| `models.claude` | ✅ | ✅ | ❌ |
| `models.gemini` | ✅ | ✅ | ❌ |
| `models.gpt`, `models.nvidia`, … (user-defined) | ✅ | ✅ | ❌ |
| `models.FREE` | ✅ | ❌ | ❌ |
| `models.default` | ✅ | ✅ (optional) | ✅ (recommended) |
| `models.EMBEDDING` | ✅ | ❌ | ❌ |

> **Section flavors — wildcards vs. exact-only:** every section supports `prefix-*`
> wildcard routing **except** the two special concrete sections `[models.FREE]` and
> `[models.EMBEDDING]`, which are exact-only. User-defined provider sections such as
> `[models.gpt]` and `[models.nvidia]` support wildcards the same way built-in
> sections do. Runtime caller-vs-config key priority is governed separately by the
> **Who wins** tables below.

## `base_url` / `api_key` override rules

Each model entry is an inline table `{target, base_url, api_key}`. Resolution walks an
inheritance chain — anything left empty falls back to the level above:

- **`base_url`**: per-entry override → section `base_url` → `[default_upstream] default_base_url`
  → `http://localhost`.
- **Configured `api_key`**: per-entry override → section `api_key` → `[default_upstream] default_api_key`.
  This only resolves the configured fallback key; runtime caller-vs-config priority is section-specific below.
- **`upstream_mode`**: per-entry `mode` → section `upstream_mode` → `[default_upstream] upstream_mode`
  → `"openai-completions"`.
- The target-only form (`opus48 = {target = "..."}`) inherits `base_url` from the section,
  then `[default_upstream] default_base_url`; `api_key` may be inherited from the section or
  `[default_upstream] default_api_key`, or supplied by the caller for non-`free` sections.

> **What `[default_upstream] default_base_url` is for:** it is the global upstream endpoint used
> when no per-entry or section `base_url` is configured, including models that fall through
> every section's exact / wildcard / catch-all lookup.

> **`base_url` may include the full endpoint path.** If `base_url` already contains a known
> full upstream endpoint path, the proxy uses it as-is instead of appending the endpoint
> suffix again. This lets you point a model at the exact URL an upstream expects (e.g.
> `base_url = "https://api.anthropic.com/v1/messages"` with
> `upstream_mode = "anthropic-messages"`) without producing a doubled path like
> `.../v1/messages/v1/messages`. Recognised full-endpoint markers (case-insensitive):
> `/v1/messages`, `/anthropic/messages`, `/v1/chat/completions`, `/chat/completions`, `/v1/interactions`,
> `/v1/responses`, `/openai/responses`, and
> `/v1beta/models/{model}:generateContent` or `/v1/models/{model}:generateContent`
> (`:streamGenerateContent`, `:countTokens`). For Gemini, `base_url` may also end
> at the API version or models collection (for example `/v1beta` or `/v1beta/models`);
> the proxy appends the model endpoint without duplicating the version path.

**Who wins — caller's key vs. configured `api_key`** — controlled by `[remote] auth_passthrough_with`:

`auth_passthrough_with = "user_key"` *(default)*

| Section | Caller's auth header | Configured `api_key` |
|:--------|:---------------------|:---------------------|
| `[models.FREE]` | **Ignored** | Section/per-entry key **always wins** — the proxy authenticates upstream on the caller's behalf (this is what makes the FREE tier work). |
| `[models.default]` | **Wins** | Used only when the caller sends no key. May come from the entry, section, or `[default_upstream] default_api_key`. |
| `[models.claude]`, `[models.gemini]` | **Wins** | Caller's key passes through; configured keys are not used. |
| `[models.EMBEDDING]` | **Overridden for embeddings** | Section `api_key` wins for `/v1/embeddings` requests when configured. |

`auth_passthrough_with = "config_key"`

| Section | Caller's auth header | Configured `api_key` |
|:--------|:---------------------|:---------------------|
| `[models.FREE]` | **Ignored** | Section/per-entry key always wins (unchanged). |
| `[models.default]`, `[models.claude]`, `[models.gemini]`, etc. | **Replaced** | Configured key **always wins** — per-entry → section → `[default_upstream] default_api_key`. |
| Models hitting `[default_upstream]` (no section match) | **Replaced** | `[default_upstream] default_api_key` is used if set. |
| `[models.EMBEDDING]` | **Overridden for embeddings** | Section `api_key` wins for `/v1/embeddings` requests when configured. |

> **Why `[models.EMBEDDING].api_key` always wins** — the fixed-route branch in
> `src/index.ts` (around line 1534) applies the embedding section's `api_key`
> **after** `transformAuthHeadersForUpstream` has populated `modelAuthHeaders`
> from the caller's headers, and the spread order is
> `{ ...modelAuthHeaders, ...formatApiKeyForUpstream(embeddingApiKey, …) }`.
> So when the section has an `api_key`, the config key replaces whatever the
> caller sent. This is intentional: `[models.EMBEDDING]` is typically used to
> pin a single provider-scoped key (e.g. NVIDIA integrate) so callers don't
> need to manage upstream credentials. For other sections, the
> `auth_passthrough_with` setting controls this same priority.

Use `config_key` when the proxy is a shared gateway and callers should not supply their own upstream credentials.

Composite and fusion aliases don't route directly: each target is resolved through its own
`[models.*]` section, so the rules above apply per target. The rule is keyed on
`route.section === 'free'`, so it holds uniformly across direct, composite, and fusion paths.

## Composite Aliases & Fusion

Group multiple models under one name in a `[composite]` section:

```toml
[composite]
# Weighted random: ~70% to model-a, ~30% to model-b
"smart" = {"model-a" = {share = 70}, "model-b" = {share = 30}}

# Primary with fallback, plus a daily token cap
"gpt" = {token_limit = {num = 80000, duration = "1d"}, "gpt-5-mini" = {primary = true}, "gpt-5.4-mini" = {fallback = 1}}
```

- `share` — weighted random selection across targets.
- `primary` / `fallback` — try primary first, fall back in order on failure.
  When a target returns a non-200 upstream error, its effective share is reduced in memory
  by half for later requests, down to a floor of one tenth of its configured share:
  - **Primary target**: decay fires when the `primary = true` target fails. Subsequent
    requests use a weighted pick between the primary (at its reduced share) and the other
    targets, so a heavily degraded primary is less likely to be tried first.
  - **Fallback targets** (no primary): when the alias has two or more `fallback`-numbered
    targets and the first-tried one fails, its effective share is decayed by the same rule.
    The next request picks the first attempt by weighted share, so a degraded fallback-1
    can be overtaken by fallback-2.
  - Decay is runtime-only — `proxy_config.toml` is never modified and state resets when
    the proxy process restarts.
- `primary` and `fallback` are **independent and both optional** — the table below
  covers every valid shape for a composite alias's targets. The detected mode is
  derived from the targets, not set explicitly:

  | Targets with `primary` | Targets with `fallback > 0` | Detected mode | Selection behavior |
  |:---:|:---:|:---|:---|
  | 0 | 0 | `share` | Weighted random across targets by `share` |
  | ≥1 | 0 | `fallback` | The first `primary` target in config order wins; other targets are unused at the routing step (they still participate in weighted pick after a primary decay). |
  | 0 | ≥1 | `fallback` | Lowest `fallback` number wins; ties broken by config order. |
  | ≥1 | ≥1 | `fallback` | The `primary` target always wins — `fallback` numbers on other targets are ignored at the routing step. |
- `token_limit` — `{num, duration}` token cap. Duration follows the same vocabulary as `global_token_limit` (see [Token Limits](#token-limits)). Returns HTTP 413 when exceeded.

### Fusion

**Fusion** fans a request out to multiple "panel" models in parallel and routes through an
optional "judge" and an optional but recommended "synth" model that writes the final answer.
If no synth is configured, the judge is used as synth; if no judge exists, the first panel is used:

```toml
[composite]
"answer" = {opus = {fusion = 1, role = "panel"}, sonnet = {fusion = 1, role = "panel"}, "judge-m" = {fusion = 1, role = "judge"}, "synth-m" = {role = "synth"}}
```

For the full set of composite/fusion options and the TUI editor workflow, see
[`docs/design_fusion_composite_alias.md`](./design_fusion_composite_alias.md).

### Coordinator

**Coordinator** routes a single conversation through two models in sequence — a
`planner` (capable/expensive) during the planning stage, then an `executor`
(fast/cheap) once the planning stage is over — reusing the full accumulated
context without re-reading anything. This mirrors the *prewalk* pattern: the
expensive model reads and thinks, the cheap model edits and executes.

```toml
[composite]
# Planner → executor hand-off at ExitPlanMode / Edit / Write (default toolset)
"smart-coder" = {
  "deepseek-v4-pro"   = {coord = 1, role = "planner"},
  "deepseek-v4-flash" = {coord = 1, role = "executor"}
}

# Custom toolset — only explicit plan-mode exit triggers hand-off
"smart-coder-strict" = {
  "deepseek-v4-pro"   = {coord = 1, role = "planner"},
  "deepseek-v4-flash" = {coord = 1, role = "executor"},
  toolset = ["ExitPlanMode"]
}

# Role targets can be other composite aliases (resolved recursively)
"smart-claw" = {
  "code-strong" = {coord = 1, role = "planner"},
  "code-small"  = {coord = 1, role = "executor"},
  toolset = ["ExitPlanMode", "Edit", "Write"]
}
```

- Each participant carries `coord = 1` and `role = "planner"` or `"executor"`. Exactly one of each is required.
- The optional top-level `toolset` key lists the tool names the proxy scans for in the accumulated `messages[]` history to detect the stage boundary.
- The switch is **one-way and stateless**: once a trigger tool appears in the message history it stays there, so every subsequent request for the same conversation routes to the executor.
- Role targets resolve through the full routing chain — direct model names, `[models.*]` aliases, `[schedule]` aliases, or other `[composite]` aliases of any mode.

#### What tools should be configured in the coordinator's `toolset`?

`toolset` should only contain tools whose **first call unambiguously signals the end of planning and the start of execution** (file mutations, explicit plan-mode exits). Tools the planner legitimately calls during the planning stage must never be in `toolset` — they would trigger a premature hand-off to the executor while the planner is still thinking.

| Tool | Suitable for `toolset`? | Reason |
|---|---|---|
| `ExitPlanMode` | ✅ Yes (in default) | Explicit end of Claude Code plan mode |
| `Edit` | ✅ Yes (in default) | First file mutation |
| `Write` | ✅ Yes (in default) | First file creation |
| `NotebookEdit` | ✅ Yes (in default) | First notebook mutation |
| `Bash` | ✅ Yes (in default) | Shell execution (can be removed if planner shells out for reads) |
| `EnterPlanMode` | ❌ Never | Called *during* planning — would hand off immediately |
| `AskUserQuestion` | ❌ Never | Planner may ask for clarification — a planning-stage call |
| `TaskCreate` / `TaskList` | ❌ Never | Planner uses these to record the plan — planning-stage calls |
| `WebFetch` / `WebSearch` | ❌ Never | Planner researches context — planning-stage calls |
| `EnterWorktree` | ⚠️ Operator choice | Only useful if your workflow always enters a worktree at the start of execution, never during planning |
| `ExitWorktree` | ❌ Not useful | Signals completion, not start of execution — too late |

**Practical `toolset` recipes:**

```toml
# Default (absent key) — best for Claude Code plan-mode workflows:
# triggers on ExitPlanMode, Edit, Write, Bash, NotebookEdit
"smart-coder" = {"opus" = {coord=1, role="planner"}, "flash" = {coord=1, role="executor"}}

# Strictest — only explicit plan-mode exit triggers; planner can freely shell out / grep
toolset = ["ExitPlanMode"]

# Mutation-only — file changes trigger but Bash is allowed during planning
toolset = ["ExitPlanMode", "Edit", "Write", "NotebookEdit"]

# Any tool triggers — planner does zero tool calls (pure prose planning only)
toolset = []
```

> **Cycles are not allowed.** A composite alias may target another composite alias, but the
> chain must terminate at a real `[models.*]` entry — `A → B → C → A` is rejected at load time
> with a `[FATAL]` log, marked with a red `x` in the TUI / dashboard, and the cyclic target is
> omitted from the snapshot. See [CHANGELOG.md](../CHANGELOG.md) for the full safety rules.

## Token Limits

Two layers of token caps share the same windowing engine:

- **Global** — `general.global_token_limit`, applied to every model-API request.
- **Per-alias** — `token_limit` inside any `[composite]` entry, applied to requests routed through that alias.

When the in-window usage is at or above the configured cap, the next request is rejected with HTTP 413 (`over_limit_error`) before it reaches the upstream. Both layers are checked at request-admission time; if both apply, hitting either one rejects the request.

### Windowing strategies

Every duration token is either **sliding** (rolls continuously from "now") or **calendar** (anchored to a wall-clock boundary). The vocabulary:

| Token | Strategy | Cutoff (lower bound of the window) |
|---|---|---|
| `1h`–`23h` | sliding | `now - N×1h` |
| `1d`–`6d` | sliding | `now - N×24h` |
| `1w` | calendar | start of the current calendar week (`week_start_day` 00:00 local) |
| `1m` | calendar | first day of the current calendar month, 00:00 local |

The token amount accepts an optional magnitude suffix: `K` (thousand), `M` (million), `B` (billion), `T` (trillion). Examples: `"50K 6h"`, `"1.5M 1w"`, `"2B 1m"`.

Calendar windows refresh at the boundary, not on a rolling timer. With `1w`, the cutoff is Monday 00:00 (or Sunday 00:00 if `week_start_day = "sunday"`); with `1m`, it is the first of the month at 00:00. Configure the week anchor:

```toml
[general]
global_token_limit = "700M 1w"
week_start_day = "monday"   # or "sunday" (default: monday)
```

```toml
[composite]
# Sliding 6-hour cap on this alias
"fast" = {token_limit = {num = 1000000, duration = "6h"}, "model-a" = {}}
# Calendar-month cap on this alias
"monthly" = {token_limit = {num = 2000000000, duration = "1m"}, "model-b" = {primary = true}}
```

### What the limit actually does — and what it doesn't

The cap is enforced as a **pre-request admission check**, not a hard ceiling. The proxy sums the tokens already recorded in the window and rejects new requests once that sum reaches the configured number. It does **not**:

- pre-reserve tokens before the upstream call,
- abort a response mid-stream if it crosses the cap,
- coordinate across concurrent in-flight requests.

So actual peak consumption in a window can overshoot the configured number — by as much as the largest single request that slipped in just before the threshold, and by `(concurrency − 1) × avg_request_size` during concurrent bursts. If you need a true hard cap, treat the configured number as a soft target and monitor actual usage.

### Migration note (from pre-`3.x` rolling windows)

Older versions treated `1w` and `1m` as **sliding** windows (rolling 7 days / 30 days from now). They are now **calendar** windows. There is no exact replacement for the previous rolling-7d / rolling-30d behavior — the closest sliding equivalents are `6d`. Users who depended on the rolling semantics should re-evaluate which duration fits their use case.

## Schedule Aliases

A `[schedule]` alias is the **top-most layer**: it picks *one* target for the request
based on a timetable (server-local hour-of-day and day-of-week), then hands that target
down to whatever routing rule resolves it (`[models.*]` or another `[composite]`).
There is no weighting or fan-out here — exactly one target is selected per request.

```toml
[schedule]
"saver" = {"maxplan" = [{from = 9, to = 12}, {from = 14, to = 18}], "code-small" = [{from = 0, to = 9, days = "weekday"}], "max-m3" = [{days = "weekend"}], "max-m2.7-high" = []}
```

In the example above, on weekday mornings `code-small` serves, on weekday office
hours `maxplan` serves, on weekends `max-m3` serves, and `max-m2.7-high` (the
**fallback** with an empty `[]` window list) handles anything that falls between
the configured windows.

**Window syntax — every entry is `{from?, to?, days?}`:**

| Field | Range | Default | Meaning |
|---|---|---|---|
| `from` | `0..24` (inclusive of start) | `0` | Hour-of-day the window opens (server-local time). |
| `to`   | `0..24` (exclusive of end) | `24` | Hour-of-day the window closes. `24` is a legal value (end-of-day). |
| `days` | `"weekday"`/`"weekdays"`, `"weekend"`/`"weekends"` (any casing), or `[mon, tue, ...]` | everyday | When the window applies, evaluated against server-local day-of-week. Any other string (including hand-typed typos) normalizes to "everyday" rather than raising an error. |

A target with **`windows = []`** is a **fallback**: it serves when no other target
matches the current time. If multiple empty-window targets are configured, the first one listed is used.
If no fallback exists and no window matches, schedule does not select a target; the
request falls through to normal routing with the original model name, including
`[models.default]` / `*` catch-all routing when configured.

**Selection rules (in order, first match wins):**

1. The current `(hour, day-of-week)` matches one of the target's `windows` → that target.
2. Otherwise, the target with `windows = []` (the fallback) → that target.
3. Otherwise, no schedule target is selected and normal/default routing handles the original model name.

**Windows are unioned across the alias**, not per-target: a single window belongs to
exactly one target. If two targets cover overlapping hours, the *first one listed*
in the TOML wins for the overlap.

**A schedule target is itself routed through the rest of the config** — `maxplan`,
`code-small`, `max-m3`, `max-m2.7-high` above are ordinary `[composite]` or
`[models.*]` entries. Schedule is *transparent composition*: it doesn't replace
composite/fusion/models, it just decides which of them serves this request at this
moment.

**Manage via the dashboard / TUI:**

- Web UI: open `GET /dashboard`, scroll to the **Schedule** section, edit aliases and
  their window lists inline — each window has `from`/`to` number inputs and a
  **days dropdown** (Every day / Weekdays / Weekend). Save persists to `proxy_config.toml`.
- TUI: press `s` to open `ScheduleAliasesOverlay` (mirror of the composite editor
  at `c`). `a` adds an alias, `m` adds a target under the selected alias (a
  concrete `[models.*]` entry or another composite/fusion alias — wildcard
  patterns like `*`/`claude-*` and the alias itself are excluded from the
  picker), `d` deletes, `e` opens a step-by-step window editor (from → to → a
  Every day/Weekdays/Weekend picker, repeat to add more windows, or choose
  "Set as fallback" to clear all windows), arrow keys navigate, `Esc` closes.
- HTTP: the four `/dashboard/api/schedule/*` routes listed in [Dashboard API](./api-endpoints.md#dashboard-api).

**Auth / section flag:** schedule targets inherit whatever `route.section === 'free'`
or "caller's key wins" rule their underlying `[models.*]` section imposes — schedule
selects the target, but the target's section still governs upstream auth.

## Routing Hierarchy (Logic Levels) — details

The proxy has **three logic levels**, stacked bottom-up. Each level chooses *which
level below* gets to serve this request:

```
                        ┌────────────────────────────────┐
   Level 3 (top)        │  [schedule]                   │  ← timetable (hour-of-day, day-of-week)
                        │  "what should serve *now*?"   │
                        ├────────────────────────────────┤
   Level 2 (middle)     │  [composite]                  │  ← share / primary+fallback / fusion fan-out / coordinator
                        │  "split or sequence across N?" │
                        ├────────────────────────────────┤
   Level 1 (base)       │  [models.*]                   │  ← exact name / prefix-* wildcard / * catch-all
                        │  "which upstream?"             │
                        └────────────────────────────────┘
```

### Level 1 — `[models.*]` custom / target models

Direct routing to an upstream. Three lookup modes, tried in priority order:

- **Exact key** — `"claude-sonnet-4-6" = {...}` resolves only that exact name.
- **Prefix wildcard** — `"claude-*" = {...}` resolves any `claude-*` and substitutes
  the `*` with the real suffix.
- **`*` catch-all** — `"*" = {}` (typically in `[models.default]`) resolves anything
  that wasn't claimed by an earlier mode, preserving the original model name.

Each entry picks its `upstream_mode` / `base_url` / `api_key` from an inheritance
chain (per-entry → section → `[default_upstream]` defaults). Custom/target models are the
*only* level that actually talks to an upstream — Levels 2 and 3 must always
resolve down to a Level-1 entry before a single byte is sent.

### Level 2 — `[composite]` aliases (share, fan-out, or coordinator)

Logical grouping of two or more Level-1 entries under one name. Three strategies:

- **`share`-weighted distribution** — `{"max-m2.7-high" = {share = 100}, "max-m3" = {share = 100}}`
  splits each request randomly across targets by weight. One or more may be marked
  `primary` (the default target) or `fallback` (consulted in order if the primary fails).
  This is one request → one target.
- **`fusion` fan-out** — every target with `fusion = 1, role = "panel"` runs in parallel
  against the same request; an optional `role = "judge"` scores them; and an optional but recommended
  `role = "synth"` merges them into one final response. Without synth, fusion uses the judge, then the first panel. `fusion_options` configures
  `min_panel`, `panel_timeout_ms`, `judge_required`, `expose_metadata`, `max_concurrent`.
  This is one request → many targets → one response.
- **`coordinator` (prewalk)** — routes to the `planner` target until a trigger tool call
  appears in the conversation history, then permanently switches to the `executor` target.
  This is one request → one target (which target depends on conversation stage).

A composite alias **does not route directly**. Each target it names is resolved
through its own `[models.*]` section, so per-target `base_url`, `api_key`, and
section-based auth rules all still apply. Section flag `route.section === 'free'`
is computed per-target, so a composite made of free-tier targets stays free-tier end-to-end.

### Level 3 — `[schedule]` timetable

The highest layer. Each request asks: *given the current server-local hour and
day-of-week, which [composite] or [models.*] entry should serve me right now?*
The chosen target then flows through Levels 2 → 1 exactly as if the caller had
asked for that target by name. Schedule is **transparent**: it adds *when* without
overriding *how*.

| Level | Section | Selects by | Cardinality | Re-routes to |
|:-----:|:--------|:-----------|:------------|:-------------|
| 3 | `[schedule]` | Timetable windows | 1 → 1 (one target picked per request) | Level 2 or 1 |
| 2 | `[composite]` (share / primary+fallback) | Weighted random or fallback order | 1 → 1 | Level 1 |
| 2 | `[composite]` (fusion) | Role + `fusion_options` | 1 → N → 1 (panel×N + judge + synth) | Level 1 |
| 2 | `[composite]` (coordinator) | Stage detection via `toolset` in messages history | 1 → 1 (planner → executor, one-way) | Level 1 |
| 1 | `[models.*]` | Exact / `prefix-*` / `*` catch-all | 1 → 1 (one upstream) | — (sends) |

Three concrete examples of the same caller request resolving differently per layer:

- **Level 1 only** — `model: "claude-sonnet-4-6"` → matched exactly in `[models.claude]`
  → sent to `api.anthropic.com`.
- **Level 2 (share)** — `model: "maxplan"` → `[composite].maxplan` picks
  `max-m2.7-high` or `max-m3` by weight → that target resolved in `[models.*]`
  → sent to its upstream.
- **Level 2 (coordinator)** — `model: "smart-coder"` → `[composite].smart-coder`
  detects stage from the messages history (no trigger yet → planner; trigger present →
  executor) → that target resolved in `[models.*]` → sent. Once an `Edit`/`Write`/`ExitPlanMode`
  appears, every subsequent request for the same conversation routes to the executor.
- **Level 2 (fusion)** — `model: "smarter"` → `[composite].smarter` fans out to
  three panel targets in parallel, judges them, and a `synth` target merges the
  result → each leg resolved in its own `[models.*]`.
- **Level 3 (schedule)** — `model: "saver"` at 10 AM Tuesday → `[schedule].saver`
  picks the `maxplan` target (its `from = 9, to = 12` window matches) →
  `[composite].maxplan` picks one of its targets by weight → that target resolved
  in `[models.*]` → sent.
