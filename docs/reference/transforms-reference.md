# Transforms & Hooks — Reference

One-page cheat sheet. For design rationale see `design_request_transform_hooks.md`.

---

## Hooks — lifecycle positions

| Hook | Alias | Fires when | Schema seen | Side |
|------|-------|-----------|-------------|------|
| `request_ingress` | `endpoint_readin` | After JSON parse, before routing | client | request |
| `before_conversion` | — | After routing, before format converter | client | request |
| `before_upstream` | — | After format conversion, before `fetch()` | upstream | request |
| `after_upstream` | — | After `fetch()`, before `!ok` check | upstream | response |
| `response_egress` | `endpoint_writeout` | Before `Response` returned to client | client | response |

**Ordering**: hooks fire in the table order above. Within a hook, declared transform sets run left-to-right (mode-defaults → sector-defaults → entry transforms). Within each set, Tier-2 built-ins run first, then Tier-1 ops in declared order.

**Aliases**: `endpoint_readin` and `endpoint_writeout` are accepted everywhere `request_ingress` / `response_egress` appear in `proxy_config.toml` (legacy names). They are normalized to the canonical names at config load time.

**Header transforms** are supported only on `before_upstream` and `response_egress`. A `headers` block under any other hook is a TypeScript type error.

### Two independent axes

Transforms operate on **two orthogonal axes**. Conflating them is the most common source of confusion:

- **Axis 1 — Lifecycle (when a hook fires, what it can observe)** — see the table below.
- **Axis 2 — Declaration scope (which sets attach to a route)** — see [Named sets and defaults](#named-sets-and-defaults).

A hook's lifecycle stage does **not** restrict which scopes its enclosing set can be attached at. Every attached set's declared hooks all fire at their stage, regardless of whether the set was attached per-upstream-mode, per-section, or per-model entry.

#### Axis 1 — lifecycle context per hook

What each hook can observe and branch on at its point in the pipeline:

| Hook | `route` | `upstreamMode` | Body schema | Can branch on target? |
|------|:---:|:---:|:---:|:---:|
| `request_ingress` | — | — | client | **no** (target-agnostic) |
| `before_conversion` | yes | yes | client | yes |
| `before_upstream` | yes | yes | upstream | yes |
| `after_upstream` | yes | yes | upstream response | yes |
| `response_egress` | yes | yes | client response | yes |

`request_ingress` is the only hook that runs **before** routing — it cannot read `route.targetUrl`, `route.upstreamMode`, or any resolved target field, and the same transformed body propagates to whichever handler is dispatched. The other four run inside (or after) the chosen handler and carry the resolved `route` in `HookContext`, so ops/built-ins can branch on `upstreamMode`, `section`, or other route fields.

This is the only sense in which hooks differ by "scope": `request_ingress` is target-agnostic (pre-routing); the rest can observe the resolved target.

### `before_conversion` vs `before_upstream` — when to use which

Both are request-side hooks, but the **format converter runs between them**, so they see different body shapes:

- **`before_conversion`** — sees the body in the **client's protocol** (e.g. the raw Anthropic or Gemini request the client sent). `route` and `upstreamMode` are already resolved, so rules can branch on the target. Use it for client-schema tweaks that the converter would otherwise mangle or drop — e.g. renaming a field that only exists in the client's wire format, or fixing a client-specific quirk before translation.
- **`before_upstream`** — sees the body in the **upstream's protocol** (the post-conversion shape that will be sent to `fetch()`). Use it for anything that must match what the upstream actually receives — e.g. `max_tokens → max_completion_tokens` (an upstream-schema field), header injection, or built-ins like `inject_missing_tool_results` that operate on the converted shape.

**Rule of thumb**: if the field exists on the client's request as-sent, use `before_conversion`; if it only exists after format conversion (or is an upstream-only field), use `before_upstream`. When in doubt, use `before_upstream` — it's the primary seam and the body most rules target.

A field can exist at both seams with different names (e.g. Anthropic `max_tokens` → OpenAI `max_completion_tokens` after conversion); pick the seam whose shape your `path` matches.

---

## Tier-1 ops — shallow field rewrites

All ops target a **path**. Three path shapes are supported:

| Path shape | Example | What it targets |
|-----------|---------|----------------|
| Top-level field | `max_tokens` | Single key on the request/response body root |
| Message field | `messages[role=assistant].content` | Field on every message matching the role filter |
| Response field | `$response.id` | Top-level key on the upstream/client response body |

Paths must be shallow (single segment after the prefix). Nested paths like `$response.choices[].message.content` are rejected at config load with an error pointing to the relevant built-in.

| Op | Required fields | Optional fields | Effect |
|----|----------------|----------------|--------|
| `rename` | `path`, `to` | — | Rename key; no-op if `path` is absent |
| `set` | `path`, `value` | — | Unconditionally set key to `value` |
| `default` | `path`, `value` | — | Set key to `value` only if absent or `undefined` |
| `remove` | `path` | — | Delete key; no-op if absent |
| `map_value` | `path`, `from`, `to` | `when_sibling` | Replace `from` value with `to`; with `when_sibling`, only fires when that sibling key exists on the same object |

### Op examples

```toml
# Rename max_tokens → max_completion_tokens (OpenAI Responses API)
{ op = "rename", path = "max_tokens", to = "max_completion_tokens" }

# Force a fixed model name upstream
{ op = "set", path = "model", value = "deepseek-chat" }

# Strip an unsupported field
{ op = "remove", path = "thinking" }

# Map empty assistant content to null when tool_calls is present
{ op = "map_value", path = "messages[role=assistant].content", from = "", to = null, when_sibling = "tool_calls" }
```

---

## Tier-2 built-ins — deep / cross-message logic

Built-ins are declared in the `builtins` list of a hook slot. They run **before** Tier-1 ops within the same slot.

| Built-in | Works on schema | What it does |
|----------|----------------|-------------|
| `lowercase_tool_schema_types` | `openai-completions`, `anthropic-messages` | Recursively lowercases every `type` field in `tools[*].function.parameters` (OpenAI shape) and `tools[*].input_schema` (Anthropic shape), including inside `anyOf`/`oneOf`/`allOf`. Required for upstreams that reject uppercase JSON-Schema type strings (e.g. DeepSeek). |
| `recover_tool_message_name` | `openai-completions` | Fills in missing `name` on `role=tool` messages by back-filling from the matching `tool_calls[].function.name` in the preceding assistant turn. Required for upstreams that reject nameless tool messages. |
| `inject_missing_tool_results` | `anthropic-messages` | Enforces three DeepSeek-Anthropic invariants: (A) reorders text-only assistant turns that appear between a tool_use assistant and its tool_result user message; (B) merges consecutive pure-tool user messages into one; (C) synthesizes a placeholder `tool_result` block for any `tool_use` id that has no matching result. |
| `filter_anthropic_beta` | any | Filters and optionally renames entries in the `anthropic-beta` request header using the set's `anthropic_beta_map`. Entries not in the map, or mapped to `null`/`""`, are dropped; others are emitted under their mapped name. See [anthropic-beta header filtering](#filter_anthropic_beta--anthropic-beta-header-filtering) below. |
| `ensure_tool_config_cache_ttl` | `anthropic-messages` | Translates Anthropic-native prompt caching on the system prompt into the litellm/Bedrock-bridge convention. Reads `cache_control` from `body.system` content blocks (the array-of-blocks shape — a plain-string `system` is ignored), then appends `{location:"tool_config", control:{...}}` to `body.cache_control_injection_points` when no `tool_config` entry already exists (caller-provided entries win). The serialized body is reordered so `cache_control_injection_points` lands after `tools`. No-op when `system` is absent, is a plain string, or carries no block-level `cache_control`. |
| `ensure_trailing_user_message` | `anthropic-messages` | While `body.messages` ends with a non-`user` role (`assistant`, `system`, or anything else), pops that message outright, repeating until the array ends on `user` (or is empty). Covers both real Anthropic "assistant message prefill" (trailing `role:"assistant"`) and a trailing inline `role:"system"` message (some clients emit an agent-definitions block as a `system`-role message in `messages`, in addition to the normal top-level `system` field). Some Anthropic-compatible upstreams reject either case with the same 400 "This model does not support assistant message prefill." Emits one `LOG_LEVEL=trace` line per stripped message (`[ensure_trailing_user_message] stripped trailing <role> message: ...`) showing exactly what was removed. No-op when `messages` is empty/absent or already ends with `role:"user"`. |
| `restore_client_model_alias` | any (`response_egress` only) | Rewrites the response body's `model` field back to the alias the client originally requested, undoing the request-side alias→target rewrite. Applies to both the buffered JSON body and each `chat.completion.chunk` SSE event. **Opt-in per route** — see [restore_client_model_alias](#restore_client_model_alias--echo-the-requested-alias-back-to-the-client) below for why this isn't a default. |
| `project_program_to_node_tool` | `openai-responses` (`before_conversion` only) | Downgrades Responses `program` / `program_output` items (programmatic tool calling) into an ordinary `node` function call so an `openai-completions` upstream can carry them, instead of the request being rejected with a 400. **Lossy and opt-in — experimental.** Only projects when the request already declares a `node` tool. See [project_program_to_node_tool](#project_program_to_node_tool--downgrade-programmatic-tool-calling) below for the two known hazards before enabling it. |

### Built-in example

```toml
[transforms.deepseek_compat]
schema = "openai-completions"

request_ingress.builtins = ["lowercase_tool_schema_types"]

before_upstream.builtins = ["recover_tool_message_name"]
before_upstream.ops = [
  { op = "rename", path = "max_tokens", to = "max_completion_tokens" },
]
```

### `ensure_trailing_user_message` — trailing non-user message guard

Some Anthropic-compatible upstreams reject a `messages` array that doesn't end
on `role: "user"`, regardless of which non-`user` role is trailing:

- **Real assistant prefill** — Anthropic's own API accepts a `messages` array
  ending on `role: "assistant"` as a way to force a specific continuation.
  Some upstreams don't support this. This can happen even without deliberate
  prefill use — e.g. a client resending its history right after an
  interrupted/aborted generation, before a new user turn has been appended.
- **Trailing `role: "system"` message** — some clients (e.g. Claude Code) emit
  an inline agent-definitions block as a `role: "system"` message inside
  `messages`, in addition to the normal top-level `system` field. Real
  Anthropic tolerates this; some upstreams don't.

Both cases are reported by these upstreams with the same generic error:

```
400 {"type":"error","error":{"type":"invalid_request_error","message":
"This model does not support assistant message prefill. The conversation
must end with a user message."}}
```

The builtin pops trailing non-`user` messages outright — repeating until the
array ends on `user` (or is empty) — it does not append a synthetic turn or
fold content elsewhere:

```json
// before (rejected by upstream)
{
  "model": "code-strong-pi",
  "messages": [
    { "role": "user", "content": "Write a poem." },
    { "role": "assistant", "content": "Here is" },
    { "role": "system", "content": "Available agent types for the Agent tool: ..." }
  ]
}

// after ensure_trailing_user_message (before_upstream)
{
  "model": "code-strong-pi",
  "messages": [
    { "role": "user", "content": "Write a poem." }
  ]
}
```

With `LOG_LEVEL=trace`, the proxy logs exactly what was removed, one line per
stripped message (in this example, `system` then `assistant`):

```
[req_...] [TRACE] [ensure_trailing_user_message] stripped trailing system
message: {"role":"system","content":"Available agent types for the Agent tool: ..."}
[req_...] [TRACE] [ensure_trailing_user_message] stripped trailing assistant
message: {"role":"assistant","content":"Here is"}
```

Attach it to routes hitting such upstreams:

```toml
[transforms.claude_anthropic_compat]
schema = "anthropic-messages"
before_upstream.builtins = ["ensure_trailing_user_message"]
```

### `filter_anthropic_beta` — anthropic-beta header filtering

Claude Code sends `anthropic-beta: header1,header2,...` to enable experimental
features. Upstreams that don't understand a given flag reject the whole request
with `invalid beta flag`. This built-in applies a per-set allow/map table so
operators can keep only the flags a given upstream supports, and optionally
rename them (e.g. Bedrock maps `advanced-tool-use-2025-11-20` to
`tool-search-tool-2025-10-19`). Mirrors LiteLLM's
`anthropic_beta_headers_config.json` — see
[docs/claude-beta-headers.md](./claude-beta-headers.md) for the full model.

The map is declared at the **top level** of the transform set (not under a hook
slot), and the built-in is typically attached to `before_upstream`:

```toml
[transforms.bedrock_beta_compat]
schema = "anthropic-messages"
anthropic_beta_map = {"computer-use-2025-01-24" = "computer-use-2025-01-24", "advanced-tool-use-2025-11-20" = "tool-search-tool-2025-10-19", "unsupported-feature" = ""}
before_upstream.builtins = ["filter_anthropic_beta"]
```

Filtering rules (input is the comma-separated form real Claude Code sends; the
JSON-array form produced by `beta-features.ts` is **not** parsed here):

1. **Entry not in map** → dropped (allowlist semantics).
2. **Map value `""` (empty string)** → dropped. This is the TOML spelling of
   LiteLLM's `null`, since TOML has no null scalar.
3. **Map value is a non-empty string** → emitted under that mapped name
   (pass-through when the value equals the key, rename otherwise).

If every entry is dropped, the `anthropic-beta` header is removed entirely
(no empty header is sent). The built-in is a no-op when the set has no
`anthropic_beta_map` (the header passes through unchanged).

> **Note — base header.** The base `anthropic-beta` header is populated by
> `routing.ts` and only for `anthropic-messages` upstreams. This built-in is a
> second-stage filter on top of that base; it does not add the header for
> non-anthropic upstreams.

### `restore_client_model_alias` — echo the requested alias back to the client

**By default the proxy does not do this.** The request body's `model` field is
rewritten from the client's alias to the real upstream model id before
forwarding (e.g. `my-fast-model` → `claude-haiku-4-5-20251001`), but the
*response* body's `model` field is left as pure passthrough — whatever the
real upstream model returns is what the client sees, in both the JSON body
and every SSE `chat.completion.chunk` event. This means a client that sent
`model: "my-fast-model"` will see `model: "claude-haiku-4-5-20251001"` in the
response, not the alias it requested.

Attach this built-in to a route to restore the alias in the response instead:

```toml
[transforms.restore_alias]
schema = "openai-completions"
response_egress.builtins = ["restore_client_model_alias"]

[models.my-fast-model]
target = "claude-haiku-4-5-20251001"
transforms = "restore_alias"
```

Routes that don't reference a set with this built-in keep the default
passthrough behavior — enabling it is per-route, not global. This also
applies to composite/coordinator/fusion aliases: the value restored is always
the top-level alias the client sent, not the name of whichever internal
sub-target actually served the request.

No-op when the response body has no `model` field, or when the resolving
context has no client-requested model name to restore.

---

### `project_program_to_node_tool` — downgrade programmatic tool calling

**Experimental, lossy, opt-in.** Enable this only to test against an upstream
whose behavior you have verified; the default (a 400) is the safe path.

The Responses API's programmatic tool calling produces two item types that
have no Chat Completions equivalent:

| Item | Fields |
|------|--------|
| `program` | `id`, `call_id`, `code` (JavaScript source), `fingerprint`, `type` |
| `program_output` | `id`, `call_id`, `result`, `status`, `type` |

Both appear in *responses* (as `ResponseOutputItem` variants) **and** in
*requests* (the create-response `input` union accepts output-item types so a
client can replay a prior turn as history). By default, an `openai-completions`
route rejects them:

```
400 invalid_request_error
Item type 'program' (programmatic tool calling) cannot be converted to the
Chat Completions API. Use an 'openai-responses' upstream to pass these items
through unmodified.
```

That is the correct default, because the conversion cannot be done losslessly
(see hazards below). Attaching this built-in downgrades them instead:

```toml
[transforms.program_node]
schema = "openai-responses"
before_conversion.builtins = ["project_program_to_node_tool"]

[models.my-model]
transforms = "program_node"
```

The projection, applied at `before_conversion` so the converter never sees the
original items:

| Responses item | → | Chat Completions |
|---|---|---|
| `program {code, fingerprint, type}` | → | `function_call` named `node`, `arguments = {code, fingerprint, type}` |
| `program_output {result, status, type}` | → | `function_call_output`, `output = {result, status, type}` |

`call_id` is carried through both so the call and its result stay paired, and
surrounding items keep their order.

**Hazard 1 — `fingerprint` round-tripping breaks.** The spec documents
`fingerprint` as an opaque replay token that "must be round-tripped". Here it
becomes a `node` argument, and `arguments` is a field the *upstream model*
authors on the next turn. Since that model has never seen a real fingerprint,
it will copy the stale value, invent one, or omit it — and a stale fingerprint
looks valid. The spec does not document what the platform does with a bad
fingerprint, so assume replay is unreliable. This is inherent to the
projection, not a fixable bug: the value originates from the Responses
platform, and this mapping hands authorship to something that cannot know it.

**Hazard 2 — inventing an undeclared tool.** Projecting onto `node` gives the
upstream an assistant turn calling a tool the client never declared. Strict
upstreams may reject the request; lenient ones may conclude `node` is
available and start calling it, with no executor behind it. To contain this,
the built-in **only projects when the request already declares a `node` tool**
(either `{name: "node"}` or `{function: {name: "node"}}`). Otherwise it logs a
warning and leaves the items alone, so the converter's 400 still applies.

No-op when `input` is absent or contains no `program`/`program_output` items.

---

## Named sets and defaults

Transform sets are defined under `[transforms.<name>]` and referenced by name.

### Axis 2 — declaration scope (which sets attach)

For every route, the effective transform list is resolved by merging three declaration scopes:

```
mode-defaults  →  sector-defaults  →  entry transforms
```

- **mode-defaults**: `[transform_defaults]` — a map of `upstream_mode → [set_names]`. Applied to every route using that upstream mode.
- **sector-defaults**: `transforms = "..."` on a `[models.<section>]` category block.
- **entry transforms**: `transforms = "..."` in the model entry itself (5th element of the positional array, or `transforms` key in the inline-table form).

These scopes attach **whole transform sets**, not individual hooks. A single set attached at any scope can declare `request_ingress`, `before_conversion`, `before_upstream`, `after_upstream`, and `response_egress` slots simultaneously — all of them fire at their lifecycle stage (Axis 1). There is no mechanism to attach, say, a set's `before_upstream` ops per-model while attaching its `request_ingress` ops globally; the granularity is the set, not the hook.

Multiple names are comma-separated strings: `transforms = "set_a,set_b"`. List form (`transforms = ["a","b"]`) is **not** supported — use CSV.

### Config wire format for model entries

Model entries are positional arrays:

```toml
[models.deepseek]
"deepseek-v3" = ["deepseek-chat", "https://api.deepseek.com/v1", "sk-...", "openai-completions", "deepseek_compat"]
#                 ^target          ^base_url                       ^api_key  ^upstream_mode        ^transforms CSV
```

Or inline-table form (equivalent):

```toml
[models.deepseek]
"deepseek-v3" = { target = "deepseek-chat", base_url = "https://api.deepseek.com/v1", api_key = "sk-...", mode = "openai-completions", transforms = "deepseek_compat" }
```

---

## Visibility

To see which transforms resolve for a route, run the server with `LOG_LEVEL=debug`. One line per request is emitted showing the resolved set names and per-hook op/builtin counts:

```
[req_…] [DEBUG] transforms: request_ingress=[deepseek_compat:b=1] before_upstream=[deepseek_compat:b=1,ops=1]
```

`b=N` = N built-ins, `ops=N` = N Tier-1 ops. Only hooks with at least one op or builtin are listed.
