# TODO: Make composite / fusion TOML blocks spec-compliant

**Date**: 2026-06-27
**Status**: Done
**Priority**: Low (proxy works fine; only affects external spec-parser users)

## Context

The proxy's config files use a relaxed hand-rolled TOML parser (`parseSimpleToml` in
`src/utils/config-loader.ts`) that accepts two forms the **TOML 1.0 spec does not**:

1. **Unquoted wildcard keys** — `claude-*`, `gemini-*`, `*` written bare. Bare keys in TOML
   are restricted to `[A-Za-z0-9_\-]`. The spec form is `"claude-*"`, `"gemini-*"`, `"*"`.
2. **JSON-style inline tables** — composite / fusion targets use `:` as the key/value
   separator, e.g. `{"token_limit": {"num": 120000, "duration": "1d"}, "gpt-5.4-mini": {"share": 50}}`.
   The spec form uses `=`: `{token_limit = {num = 120000, duration = "1d"}, "gpt-5.4-mini" = {share = 50}}`.

Form 1 was partially fixed in the README (wildcards are now quoted). Form 2 has **not** been
addressed and is the subject of this TODO.

## Why it matters

- External tooling that uses a spec-compliant TOML parser (e.g. `toml` npm, Python `tomllib`,
  Go `BurntSushi/toml`) cannot load `proxy_config.example.toml` or the README's composite /
  fusion blocks as-is. CI scripts, config validators, and editor plugins that go through a
  spec parser will reject them.
- A `toml.parse()` of a config that includes the wildcard-key form or `: `-separator inline
  table raises: `Expected ".", "=", or [ \t] but ":" found.` (or `"*" found` for bare
  wildcards).

## Scope

Affected files:

| File | Affected blocks |
|---|---|
| `proxy_config.example.toml` | `gpt-all`, `code-small`, `maxplan`, `claude-haiku-4-5-20251001`, `smarter` (and any other `[composite]` entries with `token_limit` / `share` / `fallback` / `primary` / `role` / `fusion_options` / `fusion` keys) |
| `README.md` L167-172 | composite aliases (`gpt-all`, `gpt-5`, `llama`) |
| `README.md` L186-189 | fusion alias (`smart-answer`) |
| `src/utils/config-loader.ts` `parseSimpleToml()` | the parser that has to keep accepting both forms during the transition |
| TUI / dashboard write-back | whichever function serializes a composite entry back to TOML currently emits `:` form |

The TUI / dashboard write-back currently preserves the `:` form on round-trip, so any config
file edited by hand and then saved by the TUI will get the `:` form re-emitted, even if the
hand-edited file used `=`. Fixing the write side is part of this TODO.

## Plan

### Phase 1 — Make `proxy_config.example.toml` spec-compliant

Convert every `[composite]` entry's inline tables from `:` separator to `=` separator. Bare
sub-keys that are valid TOML bare keys (e.g. `share`, `fallback`, `primary`, `role`, `fusion`,
`min_panel`, `panel_timeout_ms`, `judge_required`, `expose_metadata`, `max_concurrent`,
`num`, `duration`) may be written unquoted; otherwise quote.

Example — current (not spec):
```toml
"gpt-all" = {"token_limit": {"num": 120000, "duration": "1d"}, "gpt-5.4-mini": {"share": 50}, "gpt-5-mini": {"share": 20}, "nvidia/nemotron-3-super-120b-a12b-free": {}}
```

Example — spec-compliant (preferred: sub-table form for readability):
```toml
[composite."gpt-all".token_limit]
num = 120000
duration = "1d"

[composite."gpt-all"."gpt-5.4-mini"]
share = 50

[composite."gpt-all"."gpt-5-mini"]
share = 20

[composite."gpt-all"."nvidia/nemotron-3-super-120b-a12b-free"]
```

Alternative (spec-compliant inline-table form, more compact):
```toml
"gpt-all" = {token_limit = {num = 120000, duration = "1d"}, "gpt-5.4-mini" = {share = 50}, "gpt-5-mini" = {share = 20}, "nvidia/nemotron-3-super-120b-a12b-free" = {}}
```

Decision: prefer the sub-table form for any entry with 3+ targets or a `token_limit`, fall
back to `=`-separated inline for short aliases.

### Phase 2 — Sync README examples

Update README's L167-172 and L186-189 blocks to match the new example-file format.

### Phase 3 — Update TUI / dashboard write-back

Find the function that serializes a composite entry back to TOML string and switch its output
to the spec form. Audit:

- `src/utils/config-loader.ts` (likely a `serializeToToml()` or stringifier used by TUI save)
- `src/tui.ts` composite editor save path
- `src/handlers/dashboard.ts` POST handlers for config updates

Acceptance: round-tripping a config that uses `=` form should produce `=` form, not `:`.

### Phase 4 — Decide on parser compatibility

Options:

| Option | Trade-off |
|---|---|
| (a) Keep parser permissive; accept both `:` and `=` | Backward compatible; no migration risk; the only "loss" is the `:` form remains accepted. |
| (b) Tighten parser to require `=`; reject `:` | Forces all existing user configs to migrate in one step. Risky. |
| (c) Deprecate `:` with a warning, remove in a later major | Standard deprecation path. |

Recommendation: **(c)** — log a deprecation warning when `parseSimpleToml` sees a `:`
separator inside a `{...}` body, document the removal in CHANGELOG, keep accepting for at
least one minor version.

## Verification

After Phase 1+2, the following should all parse with `toml.parse()` from the `toml` npm
package (the same check used to validate the README in this conversation):

- `proxy_config.example.toml`
- All 13 TOML code blocks in `README.md`

The existing check script at `/tmp/check_toml.js` (and its v2 successor) can be promoted into
the repo (e.g. `scripts/check-readme-toml.js`) and wired into CI as a non-blocking check
first, blocking once Phase 4's deprecation period ends.

## Out of scope

- Any change to the routing / auth / composite runtime behavior. The fix is purely
  syntactic; the parsed object shape after migration should be byte-identical to today's
  parsed object shape.
- Adding a real JSON-parser path for inline tables. The proxy's hand-rolled parser should
  still be the only path; we're just aligning what it accepts with the spec.
