# Plan: `coordinator` Composite Mode

## Overview

The `coordinator` mode is a new composite alias type that routes a single
conversation through **two models in sequence**: a `planner` model that handles
the planning (read-only) stage and an `executor` model that handles the
execution (mutating) stage.

This mirrors the **prewalk** pattern from oh-my-pi (`packages/coding-agent/src/session/prewalk.ts`):

> Start on a capable/expensive planning model. At the moment the client
> transitions from planning to execution, hot-swap to a faster/cheaper executor
> model and continue the conversation — reusing the full message history
> accumulated during planning.

The key insight is that Claude Code (and oh-my-pi's agent loop) already signals
this transition through the **tool stream** it sends to the proxy. Planning
ends when the client calls `ExitPlanMode` (or the first edit/write-class tool
use appears in a non-plan-mode flow). The proxy can detect this boundary in the
**incoming request messages**, not in the response, because the tool result is
appended to the conversation history by the client before the next request.

---

## How oh-my-pi's Prewalk Works (Reference)

Source: `packages/coding-agent/src/session/prewalk.ts`

1. Session starts on the **planner** model (e.g. Claude Opus).
2. A `prewalk-plan` nudge is injected as a custom system message: _"Write your
   complete plan before taking any action."_
3. `PrewalkCoordinator.advanceAtTurnEnd()` is called after each assistant turn.
4. **Gate 1 – todo list:** If the session has the `todo` tool, the coordinator
   waits until the model has committed a `todo` call before allowing hand-off.
5. **Gate 2 – action tool:** The moment any `edit` or `write` tool result
   appears in the turn, the hand-off fires:
   - Plan-nudge messages are scrubbed from the message history.
   - `setModelTemporary(executor)` hot-swaps the model.
   - A `prewalk-checklist` nudge is injected: _"Verify consistency, scope,
     verification before declaring done."_
6. All subsequent turns run on the executor model with the full planning context.

The hand-off is **one-way and stateless after firing**: once the coordinator
clears `this.#prewalk`, the session runs normally on the executor.

**Why the todo gate matters (and why the proxy skips it):** oh-my-pi's
`prewalk-plan.md` prompt forces the planner to capture the plan as a **5-9 item
todo list** before the first edit. The blog is explicit that an item limit is a
*must* — without it a strong planner (GPT 5.6) creates 60-item lists and batches
them, defeating the steering. The todo list is what keeps the small executor on
track after hand-off ("it cannot forget the todo reminder that bugs it
endlessly"). The proxy injects **no** plan prompt and rewrites **no** history,
so it neither creates nor gates on a todo list. The steering therefore stays a
**client-side** concern (Claude Code / oh-my-pi plan-mode + todo tool); the
proxy only swaps the upstream model at the stage boundary.

**Executor target default (`--prewalk-into`):** oh-my-pi defaults the executor
to whatever model fills the `smol` role in its model registry (`--prewalk-into`
overrides it). The proxy has no model-role registry, so the executor is always
an **explicit** `role = "executor"` target — there is no implicit "smol"
fallback. This is a deliberate divergence: proxy config names the executor
directly.

---

## Signal Available in the Proxy

The proxy sits between the client (Claude Code / oh-my-pi) and upstream
providers. It receives each request as a **complete snapshot** of the
conversation so far (`messages` array). The proxy can inspect the tail of the
`messages` array for signals:

| Signal | Meaning | Location in request |
|---|---|---|
| `tool_use` block with `name = "ExitPlanMode"` in last assistant message | Planning phase ended explicitly | `messages[-1].content[*].name` |
| `tool_result` block answering an `ExitPlanMode` tool call | Confirmed exit from plan mode | `messages[-1].content[*]` (user turn) |
| `tool_use` block with `name` in `EXECUTOR_TRIGGER_TOOLS` set (e.g. `Edit`, `Write`, `Bash`, `NotebookEdit`) | First mutating action (non-plan-mode flow) | same |

The proxy sees the **post-tool-call turn** (the `user` message that carries
`tool_result`) before the next assistant call is dispatched. This is the right
point to switch models — identical to oh-my-pi's `advanceAtTurnEnd`.

### Default trigger set (`COORDINATOR_TRIGGER_TOOLS`)

```
ExitPlanMode   ← explicit plan-mode exit (primary signal for Claude Code sessions)
Edit           ← file mutation
Write          ← file creation
NotebookEdit   ← notebook mutation
```

The trigger set is **configurable** in the composite definition so operators
can tune it per alias (e.g. omit `Bash` if a planner legitimately shells out
for reads).

---

## Design: Config Shape

The coordinator is expressed **inline** inside a `[composite]` value, using the
same per-target object syntax already used by fusion. No new top-level key is
needed.

```toml
[composite]
"code-strong" = {opus48 = {share = 0, fallback = 0}, opus46 = {share = 0, fallback = 0}}
"code-small" = {"max-m2.7-high" = {share = 100, fallback = 0}, "max-m3" = {share = 100, primary = true, fallback = 0}, sonnet46 = {share = 0}}

"smart-coder" = {
  "deepseek-v4-pro"   = {coord = 1, role = "planner"},
  "deepseek-v4-flash" = {coord = 1, role = "executor"},
  toolset = ["ExitPlanMode", "Edit", "Write"]
}

"smart-claw" = {
  "code-strong"   = {coord = 1, role = "planner"},
  "code-small" = {coord = 1, role = "executor"},
  toolset = ["ExitPlanMode", "Edit", "Write"]
}
```

### Field semantics

| Field | Location | Meaning |
|---|---|---|
| `coord = 1` | per-target entry | Marks this target as a coordinator participant (analogous to `fusion > 0`). Both planner and executor must carry it. |
| `role = "planner"` | per-target entry | This target handles the planning stage (read-only, capable/expensive model). Exactly one required. |
| `role = "executor"` | per-target entry | This target handles the execution stage (fast/cheap model). Exactly one required. |
| `toolset = [...]` | top-level meta key | Override the trigger tool set. When absent or empty, **any `tool_use` block triggers hand-off** — the executor's role begins at the first tool call of any kind. |

### Routing through the existing chain

Each coordinator role target name is resolved through `getModelRouteConfig` —
the **full routing chain**. The role value can therefore be:

- A direct upstream model name (e.g. `"deepseek-v4-pro"`)
- A `[models.*]` alias (e.g. `"claude-opus-4-6"` defined in `[models.claude]`)
- A `[schedule]` alias (e.g. `"work-hours"`)
- A user-defined `[composite]` alias of any mode — share, fallback, fusion,
  **or another coordinator**. The inner alias is resolved to a leaf route
  (base_url, api_key, upstream_mode, model_alias) before the coordinator routes
  the conversation to it.

Cycle detection via the `visited` set applies identically. A planner that
resolves through a composite which resolves back through this coordinator
throws a routing-cycle error.

#### Rule: nested resolution is opaque to the coordinator

The coordinator treats each role target as a **black box** that resolves to a
leaf `ModelRouteConfig` (`targetUrl`, `apiKey`, `upstreamMode`, `modelAlias`).
The coordinator only decides **which** leaf route to send the conversation to
for the current stage. Whatever upstream that leaf route points at — and
however it was chosen (share weight, fallback ordering, fusion plan, schedule
window, or another coordinator) — is the upstream that runs the conversation
for that stage.

The coordinator does **not**:

- Inspect the inner alias's mode (share/fallback/fusion/coordinator/schedule).
- Run panel fan-out or judge/synth synthesis on the planner or executor. Only
  the leaf-route stage selection is in scope.
- Apply its own `toolset` to the inner alias's child requests — `toolset`
  only governs hand-off between this coordinator's two stages, not anything
  inside the inner alias.

#### Example: `smart-claw` (planner/executor as composite aliases)

```toml
[composite]
"code-strong" = {opus48 = {share = 0, fallback = 0}, opus46 = {share = 0, fallback = 0}}
"code-small"  = {"max-m2.7-high" = {share = 100, fallback = 0}, "max-m3" = {share = 100, primary = true, fallback = 0}, sonnet46 = {share = 0}}

"smart-claw"  = {
  "code-strong"   = {coord = 1, role = "planner"},
  "code-small"    = {coord = 1, role = "executor"},
  toolset = ["ExitPlanMode", "Edit", "Write"]
}
```

When a request arrives for `model: "smart-claw"`:

1. **Coordinator detection:** `getCompositeAliasMode("smart-claw")` sees
   entries with `coord > 0` → mode is `'coordinator'`.
2. **Plan resolution:** `resolveCoordinatorPlan("smart-claw")`:
   - `planner` target = `"code-strong"`, role = `"planner"`.
   - `executor` target = `"code-small"`, role = `"executor"`.
3. **Stage detection:** `detectCoordinatorStage(messages, toolset)` returns
   `'planning'` or `'executing'` based on whether `ExitPlanMode` / `Edit` /
   `Write` appears in the conversation history.
4. **Leaf route resolution** (depending on stage):

   - **Planning stage:** call `getModelRouteConfig("code-strong", proxyConfig, nextVisited)`.
     `"code-strong"` is a share-composite; the share/primary/fallback chain
     selects one of `opus48` / `opus46` (both have `share = 0`, `fallback = 0` —
     not eligible; both share=0 makes no candidate eligible, so it falls through
     to the default route). The planner route's `targetUrl`, `apiKey`,
     `upstreamMode`, and `modelAlias` are whatever `getModelRouteConfig`
     returned.
   - **Execution stage:** call `getModelRouteConfig("code-small", proxyConfig, nextVisited)`.
     `"code-small"` is a share/primary/fallback composite; primary = `max-m3`
     is selected first (since it has `primary = true`). The executor route is
     `max-m3`'s route — `targetUrl` from `[models.free]`, `modelAlias` = `max-m3`.
5. **Forward:** rewrite `requestBody.model` to the leaf `modelAlias` and
   forward to the leaf `targetUrl` with `apiKey` and `upstreamMode` headers
   set accordingly.

In other words: `smart-claw` doesn't know or care that `"code-strong"` is a
share-composite and `"code-small"` is a share/primary/fallback composite — it
just resolves them as opaque role placeholders.

#### Cycle rule

A coordinator role target may resolve through any chain, **including another
coordinator**, as long as the chain does not revisit a coordinator currently on
the resolution stack. Concretely:

- `A.coordinator → B.coordinator → C.coordinator → ...` is allowed for any
  depth, provided no alias revisits itself.
- `A.coordinator → B.coordinator → A` throws a routing-cycle error, the same
  cycle error thrown by any other composite alias recursion.

Multi-stage planning (planner itself being a planner chain) is therefore
expressible without artificial nesting caps.

### Interaction with other composite modes

A composite alias is classified by its most-specific mode — coordinator takes
precedence over fusion/fallback/share. `getCompositeAliasMode` detects
coordinator **first** (any entry with `coord = 1`). A single alias mixing
`coord` and `fusion` entries is an error detected at config-load time.

When the coordinator's role target is itself a composite alias, that inner
alias's mode (share/fallback/fusion/coordinator) is irrelevant to the outer
coordinator — the outer just receives the leaf route. The inner alias's mode
still governs how the leaf route was chosen (panel fan-out vs. weighted
random vs. fallback ordering).

---

## Design: Config Loader Changes (`src/utils/config-loader.ts`)

### Type changes

**Extend `FusionRole`:**

```ts
// Before:
export type FusionRole = 'panel' | 'judge' | 'synth';

// After:
export type FusionRole = 'panel' | 'judge' | 'synth' | 'planner' | 'executor';
```

**Extend `CompositeTargetConfig`:**

```ts
export interface CompositeTargetConfig {
  share?: number;
  primary?: boolean;
  fallback?: number;
  fusion?: number;
  coord?: number;    // > 0 marks target as coordinator participant
  role?: FusionRole; // 'planner' | 'executor' for coordinator; 'panel'|'judge'|'synth' for fusion
}
```

**Extend `CompositeModelConfig`:**

```ts
export interface CompositeModelConfig {
  token_limit?: TokenLimitConfig;
  fusion_options?: FusionOptions;
  toolset?: string[];   // coordinator trigger tools; ignored for other modes
  [modelName: string]: CompositeTargetConfig | TokenLimitConfig | FusionOptions | string[] | undefined;
}
```

**New `CoordinatorPlan` type:**

```ts
export interface CoordinatorPlan {
  alias: string;
  plannerRoute: ModelRouteConfig;
  plannerName: string;
  executorRoute: ModelRouteConfig;
  executorName: string;
  triggerTools: Set<string>;
}
```

No standalone `CoordinatorConfig` type is needed — the configuration is
embedded in `CompositeTargetConfig` (via `coord` + `role`) and
`CompositeModelConfig` (via `toolset`).

### New constants

```ts
/** Used when toolset is unset or empty[] — the executor's role begins at
 *  the first tool call of any kind. Represented as `null` in the plan
 *  (vs. a Set of specific tool names) so `detectCoordinatorStage` treats
 *  it as "any tool_use fires hand-off". */
export const COORDINATOR_TRIGGER_ALL_TOOLS = null;

/** Used when `toolset` is not present in config at all — apply a curated
 *  default set tuned for Claude Code plan-mode exits. */
export const COORDINATOR_DEFAULT_TRIGGER_TOOLS = new Set([
  'ExitPlanMode',   // explicit Claude Code plan-mode exit (primary signal)
  'Edit',           // file mutation
  'Write',          // file creation
  'Bash',           // shell execution
  'NotebookEdit',   // notebook mutation
]);
```

**Toolset resolution precedence:**

| Config value | `triggerTools` value used |
|---|---|
| `toolset = []` (empty array) | `null` (any tool call triggers hand-off) |
| `toolset = ["Edit", "Write"]` | `Set(["Edit", "Write"])` |
| `toolset` absent | `COORDINATOR_DEFAULT_TRIGGER_TOOLS` |

### Update `COMPOSITE_META_KEYS`

```ts
const COMPOSITE_META_KEYS = new Set(['token_limit', 'fusion_options', 'toolset']);
```

`toolset` must be excluded from `getCompositeTargetEntries` so it is not
treated as a model name.

### Update `CoordinatorPlan`

```ts
export interface CoordinatorPlan {
  alias: string;
  plannerRoute: ModelRouteConfig;
  plannerName: string;
  executorRoute: ModelRouteConfig;
  executorName: string;
  /** `null` = any tool call triggers hand-off; `Set<string>` = only listed tool names. */
  triggerTools: Set<string> | null;
}
```

### New function: `resolveCoordinatorPlan`

```ts
export function resolveCoordinatorPlan(
  modelName: string,
  proxyConfig: ProxyConfig,
  visited?: Set<string>,
): CoordinatorPlan | undefined
```

Algorithm:
1. Read `proxyConfig.composite?.[modelName]`.
2. Return `undefined` if absent.
3. Call `getCompositeTargetEntries(config)` and filter for entries where
   `cfg.coord` is a positive number.
4. Return `undefined` if no `coord` entries (not a coordinator alias).
5. Find the entry with `role === 'planner'` and the entry with
   `role === 'executor'`. Throw if either is missing or if more than one of
   either role is present.
6. Resolve each through `getModelRouteConfig(name, proxyConfig, nextVisited)`.
7. Resolve `triggerTools`:
   - If `config.toolset` is `undefined` (key absent) → use `COORDINATOR_DEFAULT_TRIGGER_TOOLS`.
   - If `config.toolset` is `[]` (empty array) → use `null` (any tool triggers).
   - Otherwise → use `new Set(config.toolset)`.
8. Return `CoordinatorPlan`.

### Update: `getCompositeAliasMode`

```ts
// Before return type: 'fusion' | 'fallback' | 'share' | undefined
// After:
export type CompositeAliasMode = 'coordinator' | 'fusion' | 'fallback' | 'share';

export function getCompositeAliasMode(
  modelName: string,
  proxyConfig: ProxyConfig,
): CompositeAliasMode | undefined
```

Detection order (first match wins):
1. Any entry has `coord > 0` → `'coordinator'`
2. Any entry has `role` in `{'panel','judge','synth'}` or `fusion > 0` → `'fusion'`
3. Any entry has `primary === true` or `fallback > 0` → `'fallback'`
4. Otherwise → `'share'`

---

## Design: Stage Detection (`src/utils/coordinator.ts`)

New utility file, ~60 lines.

```ts
export function detectCoordinatorStage(
  messages: ClaudeMessage[],                    // request body messages array
  triggerTools: Set<string> | null,             // null = any tool call triggers
): 'planning' | 'executing'
```

### Algorithm

1. Walk `messages` in reverse (most-recent-first).
2. For each `assistant` message, scan its `content` array for `tool_use` blocks.
3. **If `triggerTools === null`:** any `tool_use` block at all → `'executing'`.
4. **If `triggerTools` is a Set:** any `tool_use.name` in the set → `'executing'`.
5. Scan is bounded to the recent tail (last N message pairs) to avoid O(n) cost
   on very long conversations.
6. If no trigger found in the bounded tail → `'planning'`.

### Why scan the assistant turn (not the tool_result)?

The `tool_result` `user` message appears **after** the `tool_use` assistant
message. At the moment of the next assistant call, the `tool_result` is already
in `messages`. Scanning the last **assistant** message for a trigger `tool_use`
name is simpler and has the same effect: the model called a trigger tool, so
we're in the execution stage.

---

## Design: Request Handler Integration (`src/handlers/claude.ts`)

`handleClaudeRequest` is where native (anthropic-messages) requests are
dispatched. The coordinator intercept happens **before** the upstream fetch:

```
incoming request
  └─ resolve alias → composite alias mode check
       └─ mode == 'coordinator' → resolveCoordinatorPlan(alias)
            └─ detectCoordinatorStage(messages, plan.triggerTools)
                 ├─ 'planning'  → route to plan.plannerRoute
                 └─ 'executing' → route to plan.executorRoute
```

The selected `ModelRouteConfig` replaces the route that would have been used.
The `model` field in the request body is rewritten to the resolved
`modelAlias` (same as composite/fusion already does).

For the **messages handler** (`src/handlers/messages.ts`) which handles
`openai-completions` upstream, the same interception applies — the messages
array is already available in `openaiRequestBody.messages`.

### No session state stored in the proxy

The proxy is stateless between requests. Each request independently re-derives
the stage from the conversation history. This is correct because:

- The full `messages` array is sent on every request.
- The trigger tools appear in that history once called.
- No server-side session tracking is needed.

This is simpler than oh-my-pi's stateful `PrewalkCoordinator` because the
proxy does not need to inject nudge messages or scrub history — it just routes
to the right upstream.

---

## What the Proxy Does NOT Do (vs. oh-my-pi)

| oh-my-pi prewalk | Proxy coordinator |
|---|---|
| Injects `prewalk-plan` nudge message | No injection — the client (Claude Code) already sees plan-mode system prompt |
| Scrubs nudge from history at hand-off | No scrubbing — proxy is stateless |
| Waits for `todo` gate | No gate — proxy routes on first trigger in history |
| Injects `prewalk-checklist` nudge | No injection — could be added as a system prompt suffix later |
| Arms per-subagent via frontmatter `prewalk:` | Config-driven via `[composite.X.coordinator]` |

The proxy's coordinator is a **routing-layer analogue** of prewalk. The richer
nudge/gate behavior belongs in the client (Claude Code / oh-my-pi) or in a
future stateful session middleware layer.

---

## Files to Change

| File | Change |
|---|---|
| `src/utils/config-loader.ts` | Extend `FusionRole`, `CompositeTargetConfig`, `CompositeModelConfig`; add `CoordinatorPlan`, `COORDINATOR_DEFAULT_TRIGGER_TOOLS`, `resolveCoordinatorPlan`; update `getCompositeAliasMode` return type and detection order; add `'toolset'` to `COMPOSITE_META_KEYS` |
| `src/utils/coordinator.ts` | **New file** — `detectCoordinatorStage` |
| `src/handlers/claude.ts` | Route coordinator aliases before upstream fetch |
| `src/handlers/messages.ts` | Same coordinator routing intercept for openai-completions path |
| `src/server.ts` | No change expected — routing resolution happens in handlers |
| `proxy_config.toml` | Example coordinator alias (non-breaking addition) |

---

## Example Configs

### Minimal (uses curated default toolset)

```toml
[composite]
"smart-coder" = {"claude-opus-4-6" = {coord = 1, role = "planner"}, "claude-sonnet-4-6" = {coord = 1, role = "executor"}}
```

### Empty toolset — hand off at first tool call of any kind

```toml
[composite]
"smart-coder" = {"claude-opus-4-6" = {coord = 1, role = "planner"}, "claude-sonnet-4-6" = {coord = 1, role = "executor"}, toolset = []}
```

The planner does no tool calls; the executor takes over at the first tool use
regardless of name. This is the most aggressive hand-off behavior.

### Custom toolset (only plan-mode exit triggers hand-off)

```toml
[composite]
"smart-coder" = {"claude-opus-4-6" = {coord = 1, role = "planner"}, "claude-sonnet-4-6" = {coord = 1, role = "executor"}, toolset = ["ExitPlanMode"]}
```

### Using [models.*] aliases as targets

```toml
[composite]
"dev-smart" = {"deepseek-v4-pro" = {coord = 1, role = "planner"}, "deepseek-v4-flash" = {coord = 1, role = "executor"}, toolset = ["ExitPlanMode", "Edit", "Write", "Bash"]}
```

With any of the above, requests to `model: "smart-coder"`:

- Planning stage (no trigger in history) → forwarded to the `planner` target with its resolved route and model alias
- Execution stage (`ExitPlanMode` or other trigger tool present in message history) → forwarded to the `executor` target

The transition is **irreversible within a conversation**: once trigger tool calls appear in the `messages[]` array they are permanent, which matches prewalk semantics exactly.

---

## Prewalk Feature Parity Analysis

| oh-my-pi prewalk feature | Proxy coordinator equivalent | Covered? |
|---|---|---|
| Start on planner model | `role = "planner"` target routed until trigger fires | ✅ |
| Hand-off to executor at first edit/write | `detectCoordinatorStage` on trigger tools in `messages[]` | ✅ |
| One-way irreversible switch | Trigger tools stay in history → permanent stage flip | ✅ |
| Custom trigger tool set | `toolset = [...]` per alias | ✅ |
| Skip hand-off if planner == executor | Validate in `resolveCoordinatorPlan`, warn + no-op | ✅ planned |
| `prewalk-plan` nudge injected before planning | **Not done** — client (Claude Code) provides plan-mode system prompt | ✗ by design |
| Scrub nudge messages at hand-off | **Not done** — proxy is stateless, no history mutation | ✗ by design |
| Todo-list gate (wait for `todo` call before hand-off) | **Not done** — proxy cannot inspect tool results in responses | ✗ by design |
| Todo item-limit steering (`prewalk-plan.md` hardcodes 5-9 items to stop 60-item batch lists) | **Not done** — proxy injects no plan prompt; item-limit lives client-side | ✗ by design |
| `prewalk-checklist` nudge injected post hand-off | **Not done** — future: could append to system prompt on executor calls | ✗ future |
| `--prewalk-into <model>` defaults executor to the `smol` role model | Executor is an explicit `role = "executor"` target; proxy has no model-role registry | ✗ by design (explicit is required) |
| `--no-prewalk` per-run disable flag | No per-request disable — coordinator is purely config-driven; drop the alias to disable | ✗ by design |
| `prewalkWouldBeNoop`: skip if planner == executor AND same thinking level; effort-only delta still arms | Proxy warns + no-ops on identical planner/executor route; it has no per-role thinking level | ⚠ partial (Open Q #2) |
| Per-subagent arm via frontmatter `prewalk:` | Config-driven per `[composite]` alias | ✅ (different scope) |

The proxy implements the **routing layer** of prewalk. The nudge/gate behaviors
require either a stateful session proxy or client-side support (Claude Code /
oh-my-pi). The stateless approach is intentional and sufficient for model-cost
optimization.

---

## Open Questions / Decisions Needed

1. **Toolset resolution precedence (clarification):** The new rule is:
   - `toolset` key absent → use `COORDINATOR_DEFAULT_TRIGGER_TOOLS` (curated list)
   - `toolset = []` (empty) → use `null` (any tool call triggers hand-off)
   - `toolset = ["Edit", "Write"]` → use `Set(["Edit", "Write"])`

   The distinction between "absent" and "empty" gives operators two escape
   hatches: keep the curated default, or be maximally aggressive (hand off at
   first tool call of any kind). This subsumes the previous `Bash` debate —
   operators who want read-only planning just omit `toolset`; operators who
   want early hand-off write `toolset = []`.

2. **Error on planner == executor:** If both roles resolve to the same upstream
   model+url, the coordinator is a no-op. Validate at config load: throw if
   both routes are identical, or warn and allow. Suggest: warn, allow (avoids
   hard failure for aliased names that coincidentally resolve to the same model).

   *Prewalk parallel:* oh-my-pi's `prewalkWouldBeNoop` skips the swap only when
   the target matches the current model **and** the thinking level; an
   effort-only delta on the same model still arms (it's a real cheapening). The
   proxy has no per-role thinking level, so route identity is the only signal —
   the warn-and-allow rule above is the proxy's equivalent of `prewalkWouldBeNoop`.

3. **Coordinator + fusion conflict:** An alias mixing `coord > 0` and
   `fusion > 0` entries is ambiguous. Throw at config-load time with a clear
   error. `getCompositeAliasMode` returns `'coordinator'` first so it would
   silently ignore fusion — explicit error is safer.

4. **Stage detection on non-messages endpoints:** `/v1/messages/count_tokens`
   has a `messages` body; detection works normally. `/v1/models` has no body;
   default to `'planning'` (route to planner). Document this.

5. **Logging:** Log `[coordinator] alias=smart-coder stage=planning model=claude-opus-4-6`
   at `info` level per request for observability.

---

## Target Branch: `feature/transforms_hooks`

Implement the coordinator on **`feature/transforms_hooks`**, not `feature/fusion`.

### Why

Both branches carry the full composite/fusion foundation the design depends on
(`FusionRole`, `CompositeTargetConfig`, `getCompositeAliasMode`,
`resolveFusionPlan`, `getModelRouteConfig` with cycle detection), so either
branch *can* host the feature. `transforms_hooks` is the better host for two
reasons:

1. **It has a purpose-built hook seam that maps directly onto the coordinator's
   needs.** The coordinator must inspect `messages[]` for trigger tools, decide
   the route **before the upstream fetch**, and rewrite `requestBody.model` to
   the resolved leaf. `transforms_hooks` already provides:
   - `HookPoint = 'before_upstream'` — the exact interception point this design
     specifies.
   - `HookContext` carrying `route`, `clientModel`, `requestId`, `logger` —
     everything `resolveCoordinatorPlan` + `detectCoordinatorStage` need.
   - Normalized `messages[]` / `tool_use` / `tool_result` handling across
     Anthropic and Completions formats (`src/utils/request-transform.ts`), which
     is the hardest part of reliable stage detection. On `feature/fusion` this
     normalization does not exist and stage detection would re-solve
     tool_use/tool_result matching by hand in each handler.

2. **It collapses the two documented change sites into one.** The plan lists
   both `src/handlers/claude.ts` and `src/handlers/messages.ts` as
   "before the upstream fetch" intercept points. `transforms_hooks` unifies
   that into a single `before_upstream` hook — one code path instead of two.

### Comparison

| | `feature/fusion` | `feature/transforms_hooks` |
|---|---|---|
| Composite/fusion foundation | ✅ | ✅ |
| `before_upstream` hook point | ❌ (bolt into 2 handlers) | ✅ (single seam) |
| Normalized tool_use/tool_result parsing | ❌ | ✅ (reusable) |

### Note on divergence

The branches share ancestor `53ef902` but have diverged. `feature/fusion` a recent 
tracing logging fix and other 5 commits not in `transforms_hooks`,  the tracing log 
is the only required commit for the coordinator implementation, ignore rest commits.
