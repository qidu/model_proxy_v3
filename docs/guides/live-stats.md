# Live Stats

Terminal (TUI) and web dashboards for per-model, per-tool, and per-agent usage stats,
plus the `model_proxy_tokens.jsonl` usage-dump format and the startup
stats-restoration rules. Split out of the
[README Quick Start](../README.md#4-watch-live-stats-optional).

## Mode-flag gating: what gets tracked

The proxy only records detailed stats and enforces token limits when **at least one**
of `--dashboard`, `--tui`, `--agent`, or `--rpc` is enabled (or their env-var
equivalents `DASHBOARD=true`, `TUI=true`, `AGENT=true`, `RPC=true`). In "plain proxy"
mode (no flags), memory usage is minimal:

| Store | Flags set | No flags |
|-------|-----------|----------|
| `modelStats` (per-model totals) | ✅ | ✅ |
| `dailyTokenStats` (daily rollup) | ✅ | ✅ |
| `tokenHeatmapEvents` (sliding-window events) | ✅ | ❌ |
| `compositeAliasStates.events` (alias limit windows) | ✅ | ❌ |
| `agentStats` / `toolRequestChars` / `upstreamResponseToolStats` | ✅ | ❌ |
| `requestEndpointStats` / timing / upstream / status codes | ✅ | ❌ |

**Token limits enforced:** ✅ Global + Composite alias | ❌ **Both disabled**

This means without any UI/runtime flag the proxy runs with minimal overhead —
only cumulative per-model and daily totals are kept, no heatmap, no tool tracking,
and no token-limit enforcement.

---

## Terminal dashboard

Start with the terminal dashboard:

```bash
TUI=true npm run server
```

You get a live view of configured models, token usage, response times, and tool stats.
Press `c` to edit composite aliases, `s` to edit schedule aliases, `t` to send a test
request, `r` to reload config, `l` to edit the global token limit, `d` to open the
statistics overlay, `p` to open the tools blocklist overlay, `Ctrl+U` to dump usage to
JSONL now, `Ctrl+C` to quit. A web dashboard is also available at `GET /dashboard`.

## JSONL usage dump

When `TUI=true`, `DASHBOARD=true` or `DUMP=true` is set, token stats are appended to
`model_proxy_tokens.jsonl` in the working directory. `--dashboard` is the argv spelling
of `DASHBOARD=true`, and `--tui`/`--agent` imply it; a bare `TUI=true`/`AGENT=true` env
var does not (set `DASHBOARD=true` explicitly there). Each line is one JSON dump:

```json
{
  "date": "2026-07-15",
  "timestamp": 1784112345,
  "lastDumpTs": 1784109999,
  "modelStats": [
    {
      "model": "claude-sonnet-4-6",
      "requests": 12,
      "failed_requests": 0,
      "input_tokens": 12345,
      "cached_tokens": 0,
      "cache_written_tokens": 0,
      "output_tokens": 6789,
      "total_tokens": 19134
    }
  ],
  "toolStats": [
    { "name": "Read", "agent": "unknown", "req": 3, "resp": 1, "len": 2048, "blocked": 0 }
  ],
  "heatmapEvents": {
    "models": { "ab12": "claude-sonnet-4-6" },
    "sequences": [{ "ts": 1784112300, "values": 19134, "id": "ab12" }]
  }
}
```

Fields:
- `date`: local `YYYY-MM-DD` bucket for the dump.
- `timestamp`: dump time in Unix seconds.
- `lastDumpTs`: previous dump timestamp. `0` means a full snapshot; non-zero means
  `heatmapEvents` is a delta since that timestamp.
- `modelStats`: cumulative per-model totals for that date.
- `toolStats`: optional cumulative per-tool/per-agent totals.
- `heatmapEvents`: token events used for the Tokens Panel and rolling global token
  limit. Current files use the compact `{models, sequences}` shape, where model
  names are mapped to short ids and each sequence stores `{ts, values, id}` in Unix
  seconds. Older files with `heatmapEvents: [{timestamp, values, model}]` are still
  accepted.
- `compositeAliasStates`: optional persisted per-alias token-limit event log,
  written by day-rollover/full-snapshot dumps. Each alias entry stores
  `{limit, duration, events: [{ts, tokens}]}`; events are kept in Unix seconds
  and pruned to the 31-day retention bound on load. Legacy rows using the older
  `compositeLimitWindows` shape (accumulator-based) are still accepted but
  restore with an empty event log since an accumulator cannot be reconstructed
  into per-event history.

## Startup stats loading

On startup, the proxy avoids double-counting persisted stats as follows:
- `modelStats`, `toolStats`, and `compositeAliasStates` are loaded only from the
  latest dump for each retained date because they are cumulative snapshots.
- `modelStats` from those latest per-day dumps are summed across days to rebuild the
  all-time dashboard totals.
- `heatmapEvents` are loaded from all retained rows, because delta rows and multiple
  proxy instances can contain different events. The loader skips events older than
  the retention cutoff, skips events at or before a row's non-zero `lastDumpTs`, and
  deduplicates by `timestamp:values:modelId` before adding them to memory.
