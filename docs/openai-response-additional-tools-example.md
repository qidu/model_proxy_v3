# `additional_tools` request example — parsed schema

Source: `client-request.json` (a real Responses API request from a Codex-style
client, model `moonshotai/kimi-k3`). Documents the actual shape of an
`additional_tools` input item with `namespace`-wrapped tools, cross-referenced
against `docs/openai-response-final.md`.

## Top level (Responses API request)

```
model: string                            "moonshotai/kimi-k3"
input: array[7]                          see "input[]" below
tool_choice: string                      "auto"
parallel_tool_calls: boolean
reasoning: { effort, summary, context }  all strings, e.g. "high" / "detailed" / "all_turns"
store: boolean
stream: boolean
include: array[1] of string              e.g. "reasoning.encrypted_content"
prompt_cache_key: string (uuid)
text: { verbosity: string }              e.g. "low"
client_metadata: object                  Codex-specific passthrough (installation-id,
                                          turn/window/thread/session ids, turn-metadata JSON string)
```

## `input[]` (7 items, discriminated by `type`)

| idx | type | role | shape |
|---|---|---|---|
| 0 | `additional_tools` | developer | `{ type, id, role, tools: array[3] }` — namespace-grouped tool declarations |
| 1 | `message` | developer | `{ type, id, role, content: array[1] }` |
| 2 | `message` | developer | `{ type, id, role, content: array[5] }` |
| 3 | `message` | developer | `{ type, id, role, content: array[1] }` |
| 4 | `message` | developer | `{ type, id, role, content: array[1] }` |
| 5 | `message` | user | `{ type, id, role, content: array[1] }` |
| 6 | `message` | user | `{ type, id, role, content: array[1] }` |

All `message` content parts are uniformly:

```
{ type: "input_text", text: string }
```

## `input[0]` — `AdditionalTools` item

```
{ type: "additional_tools", id: string, role: "developer", tools: array[3] }
```

Matches `AdditionalTools object { role, tools, type, id }` in
`docs/openai-response-final.md`.

### `input[0].tools[]` — 3 `Namespace` objects

```
Namespace: { type: "namespace", name: string, description: string, tools: array[N] }
```

| namespace | tools count | leaf tool shapes |
|---|---|---|
| `functions` | 3 | 1× `custom` (`exec`), 2× `function` (`wait`, `request_user_input`) |
| `collaboration` | 6 | 6× `function` (`followup_task`, `interrupt_agent`, `list_agents`, `send_message`, `spawn_agent`, `wait_agent`) |
| `mcp__cua_repl` | 2 | 2× `function` (`js`, `js_reset`) |

Leaf tool shapes:

```
Function: { type: "function", name, description, strict: boolean, parameters: object (JSON schema) }
Custom:   { type: "custom",   name, description, format: object }   // no `parameters`
```

This matches the `AdditionalTools.tools[]` → `Namespace { description, name,
tools, type }` → `Function` / `Custom` union documented in
`docs/openai-response-final.md`.

## Relevance

`src/converters/responses-to-completions.ts` merges `additional_tools` items
into the flat Chat Completions `tools[]` array. `namespace` wrappers are
flattened recursively (`flattenNamespaces`), and each leaf tool is **renamed
to `<namespace>_Z_<tool>`** with nesting joined by `_Z_` at every level (e.g.
`collaboration_Z_spawn_agent`, `outer_Z_nested_Z_deep_fn`). Prefixing avoids
collisions when two namespaces contain a same-named tool, and preserves enough
information to reverse the mapping. Flattened names longer than 64 chars (the
`function.name` limit imposed by Chat Completions/Anthropic/Gemini) are
shortened to a readable truncated head plus a per-request counter (e.g.
`<head>_1`). `custom` tools are best-effort converted
to `function` tools with a permissive `{ input: string }` parameter schema
(logged as a warning), since Chat Completions has no namespace or
unconstrained-text tool concept.

The flattening pass also records a `Map<flatName, { name, namespace? }>` (the
`namespace` path joined with `.`, e.g. `outer_Z_nested_Z_deep_fn` →
`{ name: 'deep_fn', namespace: 'outer.nested' }`), so the original bare name is
recovered by lookup even when the flat name was shortened. It is attached to the
returned `OpenAIRequest` as a non-enumerable `__namespaceMap` property and read
back with `getNamespaceMap(request)`. When the upstream calls a flattened tool,
`convertCompletionsToResponses` (and the streaming transform) look the name up
in that map and emit a `function_call` output item with the bare tool `name`
plus the original `namespace` path — restoring the spec shape documented in
`docs/openai-response-final.md`. Tools that did not come from a namespace are
emitted unchanged (bare `name`, no `namespace` field).

See `CHANGELOG.md` ("fix(responses): shorten flattened namespace tool names...")
for details.
