# Proposal: Per-Model / Per-Upstream Request Transform Layer + Hook-Point Lifecycle

Status: draft / for review
Scope: request & response rewriting for models that share an endpoint or `upstream_mode`

---

## 1. Problem

Two (or more) models — call them **A** and **B** — are often served by the *same endpoint* and the *same `upstream_mode`* (e.g. `deepseek-v4-comp` and `max-m3-comp` both use `openai-completions`). Their message schema is nominally identical, but each upstream has small quirks:

- MiniMax & DeepSeek require assistant `content: ""` → `content: null` when `tool_calls` present
- DeepSeek rejects `tool` messages missing `name`; needs recovery from prior turn
- google-antigravity SDK emits uppercase JSON-Schema `type` (`"STRING"`) that DeepSeek rejects
- some upstreams need `max_tokens` → `max_completion_tokens`, others (`api.qnaigc.com`) don't
- header shape differs (`x-api-key` vs `Authorization: Bearer` vs `api-key` for Azure)

### Where these live today (the actual pain)

These fixes are **hard-coded, scattered inline** across handlers:

- `src/handlers/chat-completions.ts:80-111` — uppercase-schema fix + tool-name recovery + `content:null` patch
- `src/handlers/openai.ts:88` — schema lowercasing
- also touched in `responses.ts`, `claude.ts`, `messages.ts`
- `src/utils/routing.ts:305-346` — `max_tokens` mapping keyed by *hostname string match* (`api.qnaigc.com`)
- `src/utils/routing.ts:478-514` — auth-header shape hard-coded by `upstreamMode` switch

**Consequences:** adding model C means editing N handler files; the rules are keyed by ad-hoc `hostname.includes('...')` checks rather than declared config; there's no single place to see "what gets rewritten for DeepSeek."

## 2. Goal

Let config declare, per model / per sector / per upstream, a set of **request transforms** (add / remove / rewrite body fields, rewrite headers) that the proxy applies at the boundary — without editing handler code. A/B sharing an endpoint differ only by their declared transform set.

## 3. Design

### 3a. Config schema — a `[transforms.*]` block referenced by models

A transform set declares **operations** against fields of the endpoint / upstream-mode
message schema. Field names are formal and schema-anchored — not ad-hoc flags — and the
engine is kept deliberately small by splitting into two tiers (below).

The engine stays deliberately simple (per open-question #4 decision). Two tiers:

#### Tier 1 — generic ops over a *shallow* path

Paths reference actual schema fields (`src/types/openai.ts`, `src/types/claude.ts`,
`src/types/gemini.ts`) but only two shapes are supported — **no** deep recursion, **no**
cross-message references:

- **top-level request param** — `max_tokens`, `temperature`, `tool_choice`,
  `reasoning_effort`, `output_config`, `system`, … (single segment)
- **message field, optionally role-filtered** — `messages[].content`, `messages[].name`,
  `messages[role=assistant].content`, `messages[role=tool].name`

Generic ops:

| op | meaning |
|----|---------|
| `rename`    | rename a field, preserving value (`max_tokens` → `max_completion_tokens`) |
| `set`       | force a field to a literal value |
| `default`   | set only when the field is absent |
| `remove`    | delete a field |
| `map_value` | replace value via `from`→`to` (e.g. `"" → null`), optional `when_sibling` guard |

#### Tier 2 — named built-in ops (the gnarly cases stay in code)

The two operations that would force a real path-matcher (deep JSON-Schema recursion,
cross-message id lookup) remain **named built-ins**, referenced by name — not expressed as
paths. This keeps the engine free of a `**` recursor and a `[id=$.x]` join.

| built-in | what it does (ports the existing inline logic verbatim) |
|----------|---------|
| `lowercase_tool_schema_types` | recurse `tools[].function.parameters` / `tools[].input_schema`, lowercase every `type` (`chat-completions.ts:20-36`) |
| `recover_tool_message_name`   | fill missing `tool` message `name` from the matching prior `assistant.tool_calls[].function.name` by `tool_call_id` (`chat-completions.ts:94-110`) |

Adding a *new* deep-field quirk means adding a new named built-in (one function) — not new
config syntax. New shallow-field quirks need only config.

#### Example — the current quirks

```toml
[transforms.deepseek_compat]
schema = "openai-completions"      # which message schema the paths refer to
builtins = [ "lowercase_tool_schema_types", "recover_tool_message_name" ]
ops = [
  # assistant content:"" → null when tool_calls present
  { op = "map_value", path = "messages[role=assistant].content", when_sibling = "tool_calls", from = "", to = null },
  # rename max_tokens for upstreams that want the Responses-style param
  { op = "rename", path = "max_tokens", to = "max_completion_tokens" },
  { op = "remove", path = "output_config" },
]
headers = { set = { }, remove = [ ] }

[transforms.minimax_compat]
schema = "openai-completions"
ops = [
  { op = "map_value", path = "messages[role=assistant].content", when_sibling = "tool_calls", from = "", to = null },
]

# the max_tokens rename lives here, bound to the two openai upstream modes (open-question #3)
[transforms.max_tokens_completion]
schema = "openai-completions"
ops = [ { op = "rename", path = "max_tokens", to = "max_completion_tokens" } ]

# qnaigc opt-out: undo the mode default (keeps legacy max_tokens)
[transforms.no_max_completion_tokens]
schema = "openai-completions"
ops = [ { op = "rename", path = "max_completion_tokens", to = "max_tokens" } ]

# mode-level defaults: auto-applied to every route with that upstream_mode (open-question #3 sub)
[transform_defaults]
openai-completions = ["max_tokens_completion"]
openai-responses   = ["max_tokens_completion"]

[models.free]
upstream_mode = "openai-completions"
deepseek-v4-comp = { target = "deepseek-v4-flash", base_url = "https://api.deepseek.com", api_key = "…", transforms = ["deepseek_compat"] }
max-m3-comp      = { target = "MiniMax-M3", base_url = "https://api.minimaxi.com", api_key = "…", transforms = ["minimax_compat"] }
# qnaigc entry opts out of the mode default:
gpt-x-qnaigc     = { target = "gpt-x", base_url = "https://api.qnaigc.com", api_key = "…", transforms = ["no_max_completion_tokens"] }
```

- `transforms` is a **list of named transform sets**, applied in order.
- Each set declares its `schema` (`openai-completions` | `anthropic-messages` |
  `openai-responses` | `gemini-generatecontent`) so `ops` paths validate against the right
  field vocabulary at config load.
- **`[transform_defaults]`** binds sets to an `upstream_mode`; they auto-apply to every
  route of that mode. Effective order per route (see #8): **mode-defaults → sector-defaults
  → entry `transforms`**, so an entry set can override/undo a mode default (the qnaigc
  opt-out above renames `max_completion_tokens` back).
- A sector can set a default `transforms = [...]` that individual entries inherit/extend.
- Named sets are reusable across models (A and B can share `deepseek_compat` or not).

### 3b. Resolution — extend `ModelRouteConfig`

`ModelRouteConfig` (`src/utils/config-loader.ts:192`) already carries `{targetUrl, apiKey, upstreamMode, modelAlias, section}`. Add:

```ts
export interface ModelRouteConfig {
  …
  transforms?: TransformSet[];   // resolved & merged (mode+sector+entry) from config
}

// new top-level config surfaces (src/utils/config-loader.ts, ProxyConfig)
export interface ProxyConfig {
  …
  transforms?: Record<string, TransformSet>;   // [transforms.<name>]
  transform_defaults?: Record<string, string[]>; // [transform_defaults]: upstream_mode → set names
}
```

Resolve and **merge** the named transform sets in `resolveModelRouteFromEntry` (`src/utils/config-loader.ts:219`): concatenate **mode-defaults (`[transform_defaults][upstreamMode]`) → sector-default `transforms` → entry `transforms`** into the final `route.transforms` list, in that order (#8 fold order). The route object arrives at the handler fully-resolved — handlers stay dumb and never consult `[transform_defaults]` themselves.

### 3c. One transform engine — `src/utils/request-transform.ts` (new)

A single pure function applied by every handler right before the upstream `fetch`:

```ts
applyRequestTransforms(
  body: Record<string, unknown>,
  headers: Record<string, string>,
  transforms: TransformSet[],
): { body, headers }
```

It implements the Tier-1 generic ops (`rename` / `set` / `default` / `remove` / `map_value`) over shallow field paths, plus a small registry of Tier-2 named built-ins (`lowercase_tool_schema_types`, `recover_tool_message_name`) that wrap the existing inline logic. No `**` recursor or cross-message join in the engine.

### 3d. Migrate the scattered fixes

Replace the inline `if` blocks in `chat-completions.ts`, `openai.ts`, `responses.ts`, `claude.ts`, `messages.ts` with a single `applyRequestTransforms(...)` call fed by `route.transforms`. The `max_tokens` hostname hack in `routing.ts` (`shouldUseMaxCompletionTokens` / `mapMaxTokensForUpstream`, `:305-346`) is folded in (open-question #3): the `rename max_tokens → max_completion_tokens` op becomes a **default transform bound to the `openai-completions` / `openai-responses` upstream modes**, and `api.qnaigc.com` entries carry an explicit opt-out set. Those two `routing.ts` helpers are then deleted.

## 4. Why this shape (tradeoffs)

- **Declarative named sets** (vs. inline per-entry keys) — because A and B frequently share the *same* quirk set; naming avoids copy-paste and keeps `[models.*]` readable. Cost: one extra indirection.
- **Two-tier engine** (shallow generic ops + named built-ins for the deep cases) rather than a full path DSL with recursion/joins — keeps it safe (no arbitrary code in config), matches CLAUDE.md "simplicity first," and reuses the exact tested logic. A fully-generic rule DSL would be over-engineering for the current quirk set; the two gnarly cases stay as one function each.
- **Hook at route resolution + single apply point** — one obvious place to add model C; no handler edits.

---

## 5. Hook-Point Design: Request/Response Transform Lifecycle

### 5.1 The real lifecycle (mapped to code)

A request flows through these seams today:

```
inbound Request
  │  index.ts:1077  bodyText = await request.text(); body = JSON.parse(...)
  │  index.ts:1164  getModelRouteConfig(modelName) → ModelRouteConfig
  │  index.ts:1186  alias rewrite (body.model = resolvedModelAlias)
  ▼
dispatch  index.ts:2040  switch(handlerType) → handleXxxRequest(...)
  │           ← body still in CLIENT shape, but route/upstreamMode now known   [before_conversion]
  ├─ handler: format conversion (completionsToClaudeBody / completionsToResponsesBody / …)
  │           ← A/B share upstream_mode here; body is now in UPSTREAM shape
  ▼
  fetch(targetUrl, {headers, body})   ← the upstream boundary
  ▼
  upstreamResponse (JSON or SSE stream)
  │  handler: response conversion (claudeJsonToSyntheticCompletions / SSE remap)
  ▼
outbound Response
```

### 5.2 The five hook points

| Hook | Fires | Body shape | Sees | Use for |
|------|-------|-----------|------|---------|
| **`request_ingress`** | right after inbound parse, **before** route/alias resolution | *client* schema | raw client body + headers (no route yet) | normalize client quirks (uppercase JSON-Schema types from antigravity), strip client-only fields |
| **`before_conversion`** | inside handler, **after** dispatch/routing, **before** the format converter | *client* schema | client body + **resolved `route` / `upstreamMode`** | client-schema tweaks that need to know the target (e.g. drop a field only for a specific upstream, before it gets converted/renamed) |
| **`before_upstream`** | inside handler, **after** format conversion, **immediately before** `fetch` | *upstream* schema | final upstream body + upstream headers + resolved `route` | the A/B differentiators: `content:null`, tool-name recovery, `max_tokens`→`max_completion_tokens`, header set/remove |
| **`after_upstream`** | **after** `fetch` returns, **before** response conversion | *upstream* response schema | upstream body/stream + status | fix upstream response quirks, inject/normalize fields, remap error bodies |
| **`response_egress`** | just before returning `Response` to client | *client* response schema | final client body/stream + response headers | **user-facing response rewriting**: reshape body fields, `map_value`, strip provider headers, add `x-*` metadata |

#### Why these five (and why the split)

- **`request_ingress` vs `before_conversion`** — both see *client-schema* body, but `request_ingress` runs **centrally before routing** (no `route` yet) while `before_conversion` runs **in-handler after routing** (`route` / `upstreamMode` known). Use request_ingress for target-agnostic client normalization; use before_conversion when the client-schema tweak must depend on which upstream the request is headed to.
- **`before_conversion` vs `before_upstream`** — the format converter runs *between* them. A rule like "lowercase schema types" is a *client-schema* concern (before_conversion); "`content:"" → null`" is an *upstream-schema* concern that only exists after conversion (before_upstream). Collapsing them would force rules to guess which shape they operate on — exactly today's ambiguity.
- **`before_upstream` is the primary A/B seam.** A and B share endpoint + `upstream_mode`, so they reach the *same* handler and the *same* converted body. They differ **only** by the transform set attached to their `route` — resolved at `getModelRouteConfig` and applied here.

### 5.3 Where each hook physically attaches

- `request_ingress` — `index.ts` ~line 1078, once, right after `JSON.parse(bodyText)`. Central, before dispatch.
- `before_conversion` — inside each handler, right after entry / before the `completionsToXxxBody` call (e.g. `chat-completions.ts:119`, `:225`). Per-handler because it needs the resolved `route` but must run before conversion.
- `before_upstream` — inside each handler, at the point just before `fetch` (e.g. `chat-completions.ts:128`, `:228`, `:251`; `messages.ts` upstream fetch; etc.). This is per-handler because the converted body only exists there.
- `after_upstream` — inside each handler, right after `const upstreamResponse = await fetch(...)` and **before** the `if (!response.ok)` early-return, so it fires on both success and error responses (open-question #7). `ctx.status` distinguishes them.
- `response_egress` — **split (open-question #5 = both)**: header ops run centrally in the `index.ts` dispatch wrap (~line 2096), once for every handler; body ops run in-handler (buffered JSON at `return new Response(...)`, streaming via per-event `transformEvent` on the SSE loop, `chat-completions.ts:166`). One declared set, two execution sites.

**Streaming caveat:** `after_upstream` / `response_egress` must support the SSE case. For streams, a body transform is a **per-event** callback (fired on each parsed SSE event, like the existing loop at `chat-completions.ts:166`), not a whole-body function. Header transforms run once. The hook signature must distinguish `transformBody` (buffered) from `transformEvent` (streamed).

### 5.4 Signature

```ts
type HookPoint = 'request_ingress' | 'before_conversion' | 'before_upstream' | 'after_upstream' | 'response_egress';

interface HookContext {
  hook: HookPoint;
  route: ModelRouteConfig;      // targetUrl, upstreamMode, modelAlias, section, transforms
  upstreamMode: string;
  clientModel: string;          // pre-alias name
  requestId: string;
  streaming: boolean;
  logger: Logger;
  status?: number;              // upstream HTTP status; set on after_upstream / response_egress only.
                                // non-2xx ⇒ body is a provider error shape, not the success schema (see §6 #7)
}

// buffered (JSON) — request or response
type BodyHook   = (body: Record<string, unknown>, ctx: HookContext) => Record<string, unknown>;
type HeaderHook = (headers: Record<string, string>, ctx: HookContext) => Record<string, string>;
// streamed — one parsed SSE event at a time (after/writeout only)
type EventHook  = (event: Record<string, unknown>, ctx: HookContext) => Record<string, unknown> | null; // null = drop event
```

A `TransformSet` groups its `ops` under the hook at which they fire. Each op still uses
the canonical field-path + operation vocabulary of §3a; the hook only decides *when* it
runs (and therefore which schema shape the path resolves against — client vs upstream):

```toml
[transforms.deepseek_compat]
schema = "openai-completions"

request_ingress.builtins = [ "lowercase_tool_schema_types" ]   # client-schema: before conversion
before_upstream.builtins = [ "recover_tool_message_name" ]     # upstream-schema: just before fetch
before_upstream.ops = [
  { op = "map_value", path = "messages[role=assistant].content", when_sibling = "tool_calls", from = "", to = null },
  { op = "rename",    path = "max_tokens", to = "max_completion_tokens" },
]
response_egress.headers = { remove = [ "openai-organization" ] }
```

The engine resolves `route.transforms` → a `{ [hook]: { ops, builtins } }` map and a single dispatcher `runHook(hook, payload, ctx)` is called at each of the five seams.

---

## 6. Open questions (need decision — CLAUDE.md §5)

### Transform layer
1. **Response transforms too?** **DECIDED: yes, in scope for v1.** The two hooks form request/response pairs:
   - request: `request_ingress` (client schema) → `before_upstream` (upstream schema)
   - response: `after_upstream` (upstream schema) → **`response_egress`** (client schema — the **user-facing response-rewriting hook**)
   `response_egress` is where users reshape the response the client finally sees (strip/inject fields & headers, rename, `map_value`), operating on the client-schema response after any format conversion. `after_upstream` handles upstream-schema response quirks before conversion.
2. **Ordering vs `upstream_mode` conversion** — **DECIDED (confirmed).** `before_upstream` is the sole *upstream-schema* request seam: it runs *after* format conversion (`completionsToClaudeBody`, etc.) so ops operate on the final upstream body. The pre-conversion need is covered by `before_conversion` (client-schema, in-handler, post-routing — added in #6), so no additional hook is required.
3. **`max_tokens` mapping** — **DECIDED: fold it in.** Today `routing.ts:305-346` is an *inverted* rule: for `openai-completions`/`openai-responses` upstreams it renames `max_tokens`→`max_completion_tokens` for **everyone except** `api.qnaigc.com` (hostname `includes` check). Migration:
   - The `rename max_tokens → max_completion_tokens` `before_upstream` op becomes the **default transform bound to the `openai-completions` and `openai-responses` upstream modes** (a mode-level default transform set, so no per-model config needed).
   - `api.qnaigc.com` routes get an explicit **opt-out**: either a `keep = ["max_tokens"]` marker or simply omit the default and attach a qnaigc set without the rename. Prefer an explicit `no_max_completion_tokens` named set on the qnaigc entries so the exception is visible in config, not hidden in a hostname string.
   - Delete `shouldUseMaxCompletionTokens` / `mapMaxTokensForUpstream` from `routing.ts` once migrated.
   **Sub-question DECIDED: use mode-level default transform sets.** A `[transform_defaults]` block maps `upstream_mode → [transform names]`; those sets are auto-applied to every route with that mode, so the `max_tokens` rename lives in one place (bound to `openai-completions` / `openai-responses`) rather than repeated per model. `api.qnaigc.com` entries opt out via an explicit `no_max_completion_tokens` set. Resolution & ordering (ties into #8): the effective transform list for a route is **mode-defaults → sector-defaults → entry `transforms`**, concatenated in that order, then folded left-to-right — so a per-entry set can override/undo a mode default (e.g. the qnaigc opt-out `rename`s `max_completion_tokens` back, or a `keep`/`remove` marker suppresses it). See §3a/§3b for schema and merge.
4. **Path-syntax scope** — **DECIDED: keep the engine simple.** §3a is now two tiers: shallow generic ops (top-level params + role-filtered `messages[].<field>`) and two named built-ins for the deep cases (`lowercase_tool_schema_types`, `recover_tool_message_name`). No `**` recursor, no `[id=$.x]` join. New deep-field quirks add one built-in function; new shallow quirks are config-only.
   **Sub-question DECIDED: validate at config load.** Each transform set's `ops` paths are checked against its declared `schema`'s known field vocabulary (derived from `src/types/*.ts`) when the config is parsed. An unknown/misspelled path (or a path illegal for that schema, e.g. `messages[].content` under a Gemini schema) is a **hard load error** — the config is rejected, not silently no-op'd (CLAUDE.md §8 Fail Loud). Wiring: extend the existing config validation in `src/utils/config-loader.ts` (alongside `getModelRouteConfig` resolution) with a `validateTransformSet(set)` pass that enumerates legal shallow paths per schema; named `builtins` are validated against the built-in registry. Referencing an undefined transform name in a model's `transforms = [...]` list is likewise a load error.

### Hook points
5. **`response_egress` placement** — **DECIDED: both.** Central wrap around the dispatch result in `index.ts` (~line 2096) runs the **header** ops once, uniformly, for every handler. Body/stream ops run **in-handler**: buffered JSON via a whole-body transform at the `return new Response(...)`, streaming via a per-event `transformEvent` on the SSE loop (`chat-completions.ts:166`). So a single `response_egress` transform set may split at execution time — headers centrally, body in the handler — but authors declare it as one set.
6. **Hook count** — **DECIDED: add `before_conversion`, so 5 hooks.** It runs in-handler after routing but before the format converter, giving rules a client-schema seam that knows the resolved `route` / `upstreamMode` (which `request_ingress`, running centrally pre-routing, does not). See §5.2 for the full ordering.
7. **Error responses** — **DECIDED: fire on non-2xx too.** `after_upstream` runs for *every* upstream response so transforms can remap/normalize error bodies (e.g. wrap a raw provider error into the client's expected `{error:{type,message}}` shape). Consequences:
   - The hook must be invoked **before** each `if (!response.ok)` early-return — these are pervasive (every handler; ~20 sites, e.g. `chat-completions.ts:142`, `messages.ts:392/631`, `openai.ts:646/767/1005`, `responses.ts:467/621/1110…`). Simplest wiring: fire `after_upstream` immediately after the `fetch`, ahead of the `!ok` check, so both success and error paths pass through it.
   - `HookContext` carries `status` (see §5.4) so an error-remap op can key off it; the error body schema differs from the success schema, so ops on error bodies target the provider error shape, not `choices[]`/`content[]`.
   - Out of scope: `after_upstream` does **not** fabricate a response when `fetch` itself throws (network error) — that stays with existing `handleTargetApiError`.
8. **Ordering within a hook** — **DECIDED: config-declared order, no priority system.** Deterministic, two-level:
   - across sets: the `transforms = ["a", "b"]` list order on the model entry (sector-inherited sets prepend, then the entry's own sets);
   - within a set: `builtins` run before `ops`, then `ops` in array order, then `headers`.
   Application is a left-to-right fold — a later op sees the result of earlier ops (e.g. a `rename` then a `map_value` on the new name works if declared in that order). No weights, no priorities; if order matters, the author sequences it. Same rule at every hook.

---

## 7. Status

All §6 questions (#1–#8) and both sub-questions (#3, #4) are **decided** — see inline
**DECIDED** notes. No open items remain. No code written yet; this doc is ready to drive
implementation.

Implementation outline:
1. Config types + parse: `[transforms.*]`, `[transform_defaults]` on `ProxyConfig`;
   `validateTransformSet` (schema-path + builtin-name validation, fail-loud) in
   `src/utils/config-loader.ts`.
2. Resolution: merge mode→sector→entry into `route.transforms` in `resolveModelRouteFromEntry`.
3. Engine: `src/utils/request-transform.ts` — Tier-1 ops, Tier-2 builtin registry,
   `runHook(hook, payload, ctx)` dispatcher; buffered + `transformEvent` (streaming) paths.
4. Wire the five call-sites; migrate the scattered inline patches (§1) and delete
   `shouldUseMaxCompletionTokens` / `mapMaxTokensForUpstream` from `routing.ts`.
