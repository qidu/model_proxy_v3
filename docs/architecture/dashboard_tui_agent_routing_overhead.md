# Dashboard / TUI / Agent Overhead on Proxy Routing

**Date**: 2026-10-01
**Status**: Analysis only — no code changed, no profiling run
**As of**: commit `5ef2341` (branch `feature/targeting_failover`)

## Question

Does the dashboard (`/dashboard`), the TUI (`TUI=true`), or the agent (`AGENT=true`) affect the performance of proxy request routing?

And, added later: what do the CLI subcommands and the JSON-RPC channel (`--rpc`) cost? (The file keeps its original name.)

## Method and confidence

This is a **static code-path analysis**: every call site that the routing hot path reaches was traced through `src/index.ts` → `src/utils/dashboard-stats.ts`. **No benchmarks or profiles were taken**, so the *rankings* below are supported by the code, while the *magnitudes* are estimated, not measured. Treat absolute numbers as unverified.

Line references are to commit `5ef2341` and will drift.

## Bottom line

Seven entries, often conflated — the last is not a cost at all, and is listed to close the question:

| Cost source | When it is paid | Relative weight |
|---|---|---|
| Stats instrumentation in the request path | **Always** — every model API request, every mode, no UI required | Steady per-request tax |
| TUI refresh loop (500 ms snapshot + repaint) | Only with `TUI=1` *and* a TTY | Dominant steady-state CPU when on |
| Stats persistence (JSONL restore + sync appends) | `TUI=1`, `DASHBOARD=1` or `DUMP=1` (the `--tui`/`--agent`/`--dashboard` flags set the first) | Occasional loop-blocking write |
| Web dashboard polling | Only while a browser tab is open | Same per-poll cost as the TUI loop, 20× less frequent |
| JSON-RPC channel (`--rpc`) | Only with `--rpc` | Unconditional 1 Hz 24 h-tail walk + sync `statSync`; heavier when the client polls |
| Agent session | Only with `AGENT=1` *and* a TTY | Heaviest per unit of work, lightest at idle |
| CLI subcommands (`--list-models`, …) | Never during serving — the process exits first | **Zero runtime overhead** |

The single most important finding: **the thing people call "the dashboard" is not the UI.** The per-request instrumentation that feeds it lives in the proxy's hot path unconditionally, and is paid whether or not anything is displaying it.

Every mode above — TUI, web dashboard, agent session, and the `--rpc` channel — shares **one Node process and one event loop** (`src/server.ts`), so every millisecond any of them spends is a millisecond the router does not have. The one exception is the CLI, which exits before the server exists.

## Tier 0 — Always on, inside the routing hot path

Paid by every model API request, in every mode, whether or not any UI is attached. (`/dashboard`, health, and CLI routes return before this point; see Tier 2 and the CLI section.) `src/utils/dashboard-stats.ts` serves two roles at once: it is the data source for the UIs, and it is a per-request instrumentation layer with hooks wired directly into `src/index.ts`.

### Request-side body walks

Unconditional for model API requests, immediately after `JSON.parse(bodyText)` (`src/index.ts:1287–1304`):

- `extractToolNamesFromBody`
- `resolveAgentName` — which calls `extractSystemAgentName` (`dashboard-stats.ts:946`) and runs `systemText.replace(/\s+/g, ' ').trim()` over the **entire system prompt**
- `extractToolRequestCharLengthsFromBody`
- `recordToolRequestChars`, `recordAgentStat`

### Response-side re-parsing

`src/index.ts:2429–2465`: `response.clone()` (`:2440`) followed by `.json()` to build `modelUsageRecordBody`, then `extractUsageFromResponsePayload` (`:2442`) and `extractToolNamesFromResponsePayload` (`:2461`). Non-streaming JSON bodies are therefore parsed **twice**.

### SSE double-parse — per streamed chunk

`src/index.ts:2470–2488` always attaches **two** `TransformStream`s to every streaming response:

1. `createUsageTrackingTransformStream` (`dashboard-stats.ts:1472+`): per chunk — `decoder.decode(chunk, {stream: true})`, optional `collectedBody += decoded`, `(remainder + decoded).replace(/\r\n/g, '\n')`, `text.split('\n\n')`, then per part `part.match(/^event: (.+)$/m)`, `part.match(/^data: ?(.+?)\r?$/m)` and `JSON.parse` of the data line, plus `setLiveTokens` per event.
2. `createResponseToolTrackingTransformStream` (`dashboard-stats.ts:2185–2297`): per chunk `split('\n')` and `JSON.parse` on **every** `data:` line, recursive `collectToolNamesFromPayload`, and `onNames(...)` in `flush()`.

So streaming bytes are decoded and JSON-parsed a second time, inside the proxy, for statistics that may have no consumer. On a long streaming completion this scales with the number of SSE events, not with request count.

### Token-limit window sums — per request, when limits are configured

- `global_token_limit` → `getTokensInWindowSince(cutoff)` (`src/index.ts:1108`). That function (`dashboard-stats.ts:1775–1822`) binary-searches the window boundary and then **walks the entire live tail on every call**:

  ```ts
  let total = windowSumFrozen;
  for (let j = i; j < tokenHeatmapEvents.length; j++) { total += tokenHeatmapEvents[j].values; }
  ```

  The `windowSumFrozen` / `windowSumCutoff` cache only absorbs events that have **aged out** of the window. It does nothing for the hot tail, so cost grows with request rate × window length.
- composite `token_limit` → `getCompositeAliasTokenUsage` → `sumCompositeEventsSince` (`dashboard-stats.ts:284–306`), called at `src/index.ts:1479` (fusion) and `src/index.ts:1505` (weighted/fallback/coordinator). Same binary-search-then-walk-the-tail shape.

Both are configuration-dependent **on the request path**: with no token limits configured, neither runs there. (The same scan does run unconditionally once per second in `--rpc` mode — see Tier 2b.)

### Synchronous disk write reachable from the request path

`recordDailyToken` → `advanceDaySlotIfNeeded` → `dumpDailyTokens` (`dashboard-stats.ts:495–598`): a full `.filter()` of `tokenHeatmapEvents`, a `JSON.stringify`, and `writeFileSync(TOKEN_LOG_FILE, logLine, { flag: 'a' })`. This is gated on `persistenceEnabled`, so it is a TUI/DUMP cost rather than a bare-proxy one — but when it fires (day rollover) it blocks the loop mid-request.

### Snapshot builders — full scans

`getTokenHeatmapStatsDesc()` (1721–1748) and `getTokenHeatmapStatsMonthly()` (1750–1766) each do a complete linear scan of `tokenHeatmapEvents` with per-event `new Date()`, and are invoked on **every** snapshot build. Roughly nine `*Desc()` builders additionally spread and `.sort()` their maps (`getRequestEndpointTimingStatsDesc` `:1679`, `getRequestModelTimingStatsDesc` `:1709`, and peers).

## Tier 1 — TUI (`TUI=1`)

### Only on a real TTY

`TUI=1` is not sufficient. `src/server.ts:272` gates the whole mode:

```ts
} else if (tuiEnabled && process.stdin.isTTY && process.stdout.isTTY) {
```

In a headless or piped deployment (systemd, Docker, a supervisor capturing stdout) the branch is skipped, the TUI object is never constructed, and **nothing below in this section is paid** — but `persistenceEnabled` is still true via `dashboardEnabled` (`src/server.ts:212`), so the JSONL restore at boot and the synchronous appends still happen. The refresh loop, the repaints, and the console nulling do not.

### The 500 ms snapshot loop

`start()` (`src/tui.ts:1416`) installs:

```ts
this.refreshTimer = setInterval(() => { void this.refresh(); }, 500);
this.titleTimer = setInterval(() => this.updateTerminalTitle(), 1000);
this.hourlyDumpTimer = setInterval(() => { /* ... dumpTodayTokens(); ... */ }, 30 * 60 * 1000);
```

`refresh()` (`src/tui.ts:1480`) loads config and calls `getDashboardSnapshot(proxyConfig, this.source.env)` (`:1495`) — the builder in `src/handlers/dashboard.ts:132` that runs the full scans and sorted builders listed in Tier 0. Twice per second, on the same event loop that is serving requests.

Rendering is separate but adjacent: `scheduleRender()` (`:1469`) debounces 100 ms into a full repaint, and the 1 s title ticker calls `getActiveRequestCount()` (cheap, and it writes OSC 0 only on change).

### `TUI=1` / `DASHBOARD=1` (or `DUMP=1`) turns on stats persistence

`src/server.ts:210–216`:

```ts
const tuiEnabled = process.env.TUI === 'true' || process.env.TUI === '1';
const dumpEnabled = process.env.DUMP === 'true' || process.env.DUMP === '1';
const dashboardEnabled = process.env.DASHBOARD === 'true' || process.env.DASHBOARD === '1';
const persistenceEnabled = dashboardEnabled || tuiEnabled || dumpEnabled;
setStatsPersistenceEnabled(persistenceEnabled);
```

This buys, on top of the above: a JSONL restore at boot (retention sized from the largest configured token-limit duration, `src/server.ts:223–244`) and synchronous `writeFileSync` appends on the 30-minute timer (`src/tui.ts:1423`, or the standalone one in `src/utils/dashboard-stats.ts` for `DASHBOARD=1` with no TUI) and at day rollover.

### The offset — TUI mode *removes* logging cost

`src/server.ts:273–277` nulls all five console methods before starting pi-tui:

```ts
console.log = () => {};
console.info = () => {};
console.warn = () => {};
console.error = () => {};
console.debug = () => {};
```

Every `logger.*` call still builds its line string and then discards it, but the actual stdout write is gone. On a logging-heavy configuration, TUI mode can be **net cheaper** than plain mode — a genuine trade, not purely additive overhead.

## Tier 2 — Web dashboard (`/dashboard`)

Costs nothing until a browser tab is open. While one is, the page polls the proxy process itself (`src/handlers/dashboard.ts:3243, 3253`):

```ts
setInterval(() => { if (configDirty) return; loadModelStats(); loadRequestStats(); loadToolStats(); }, 10000);
setInterval(() => { if (configDirty) return; loadConfig(); }, 30000);
```

Each 10 s stats poll rebuilds the same snapshot as the TUI loop, but 20× less often — so in practice this is a small fraction of the TUI's continuous cost.

Additionally, `saveConfigMutation` calls `persistProxyConfigToPath` + `clearProxyConfigCache()`, invalidating the cached config the routing path reads (a one-off cost per config edit).

The `/dashboard` and `/dashboard/api/*` routes (`src/index.ts:711–942`) are wired ahead of the model-request gates, so they do **not** consume token limits or run the global limit check — but they do occupy the event loop.

## Tier 3 — Agent (`AGENT=true`)

- **Also TTY-gated**: `src/server.ts:252` requires `process.stdin.isTTY && process.stdout.isTTY` exactly as the TUI does. Headless (`AGENT=true` under a supervisor) starts no session at all, so this tier costs nothing there.
- **Precedence**: `src/server.ts:218` — if both are set, AGENT wins and the TUI does not start.
- **Lighter at idle**: persistence is on via the `--agent` flag's implied `DASHBOARD=1` (with a bare `AGENT=true` env var it stays off unless `DASHBOARD=1`/`DUMP=1`), and `LOG_LEVEL` defaults to `'warn'` instead of `'info'` (`src/server.ts` env default), so there is less logging than plain mode.
- **Heaviest per unit of work**: the agent uses the proxy's own HTTP server as its LLM provider over loopback `/v1/messages`. Every agent turn is therefore a **real proxy request through the entire Tier-0 path**, held open for the turn's duration. On top of that: `execFile` subprocess spawns (`src/agent-session.ts`, `src/agent-tools.ts`), its own pi-tui rendering on the same stdout, and the shared event loop.

So AGENT mode's routing impact is best understood not as ambient overhead but as **load generation**: it is a client of the proxy that happens to run inside it.

## CLI subcommands — no runtime overhead

`--list-models`, `--export-pi-models`, `--export-openclaw-providers` and `--validate-config` (`src/cli.ts:71`) never coexist with a serving proxy. `runCli` (`src/cli.ts:79`) is pure — parse argv, load config once, write a result to stdout, return an exit code — and `src/server.ts:93–96` acts on that code **before `createServer` is reached**:

```ts
const cliExitCode = runCli(argv.filter((arg) => !(MODE_FLAGS as readonly string[]).includes(arg)), env);
if (cliExitCode !== null) {
  process.exit(cliExitCode);
}
```

No CLI command starts the server, installs a timer, or leaves anything running. Its only cost is a one-off config load during startup, on a process that is about to exit. **CLI overhead on routing is zero**, and there is nothing here to optimize.

Note the mutual-exclusion guard that follows it (`src/server.ts:100–103`): `--rpc` combined with `AGENT` or `TUI` is a fatal error (exit 2), because all three claim stdout. The three modes are therefore disjoint by construction, which is what makes the per-mode accounting below clean.

## Tier 2b — JSON-RPC control channel (`--rpc`)

`src/rpc.ts` is the model of restraint in this codebase. Its module comment states the design intent — *"Every method is a thin wrapper over a function the proxy already exposes, so this layer adds no new state"* — and its poll block repeats it: keeping the poll here *"rather than instrumenting the request hot path is what leaves index.ts and dashboard-stats.ts untouched."* That is true, and it is why `--rpc` adds **no per-request cost at all**. What it does add is a fixed recurring cost and a client-driven one.

### Always-on: the 1 Hz poll-and-diff (`src/rpc.ts:277–300`)

`startRpc` installs one interval, `NOTIFY_INTERVAL_MS = 1000` (`:56`), that runs unconditionally for the lifetime of the process:

```ts
const activeRequests = getActiveRequestCount();
const tokensTotal = getTokensInWindow(TOKEN_WINDOW_MS);
if (activeRequests !== prevActive || tokensTotal !== prevTokens) { /* emit stats.tick */ }
const configPath = source.env.PROXY_CONFIG_PATH;
if (configPath) { try { const mtime = statSync(configPath).mtimeMs; /* emit config.changed */ } catch {} }
```

Three properties make this more than the "negligible" it looks like:

1. **`getTokensInWindow` is not a counter read.** `TOKEN_WINDOW_MS` is 24 h (`:55`), and the getter is a one-liner delegation (`dashboard-stats.ts:1828–1830`) to `getTokensInWindowSince(now - 24h)` — the function described in Tier 0 that binary-searches the boundary and then **walks every event in the live 24 h tail**. TUI mode recomputes that same scan every 500 ms, but only when a TUI is attached; `--rpc` pays it every second, forever, on an idle proxy with no requests to report.
2. **It is not gated on configuration.** The request-triggered scan at `src/index.ts:1108` only runs when `global_token_limit` is set. This one runs regardless, so a proxy with no token limits configured still performs the walk.
3. **`statSync` is synchronous.** One blocking syscall per second on the loop that is serving requests. Small, but it is real blocking I/O in `--rpc` mode that plain mode does not have.

The timer is `timer.unref?.()`'d (`:300`), which is the right choice — it keeps the RPC channel from holding the process open — but it does not reduce the cost while the proxy is serving, which is exactly when routing matters. And since `startRpc` is only called from the non-TTY/non-agent `else` branch (`src/server.ts:289–311`), this cost is paid by every plain `--rpc` proxy even when no client is attached.

The diff-and-emit discipline is correct — nothing is written when nothing changed — but under load `tokensTotal` changes on effectively every token-consuming request, so `stats.tick` degrades to **one `JSON.stringify` + one stdout line per second**. `write()` (`src/rpc.ts:224`) is fire-and-forget with no backpressure handling: a client that stops reading causes the kernel pipe buffer to fill and lines to accumulate in memory rather than blocking the loop, so the failure mode is memory/GC pressure, not stalls.

Because of the exit-2 guard, `--rpc` never runs alongside the TUI, so it **never** pays the 500 ms snapshot loop, and `persistenceEnabled` is false unless `DASHBOARD=1`/`DUMP=1` (or `--rpc` is paired with `--dashboard`) — no JSONL restore, no synchronous appends. `LOG_LEVEL` also stays at the default `info`, and `src/server.ts:79–81` redirects `console.log/info/debug` to stderr so stdout remains clean as the wire. `--rpc` therefore has the plain-mode logging profile, not the TUI's reduced one.

### Client-driven: the on-demand methods

`dispatch` (`src/rpc.ts:138`) is a switch over thin wrappers. Most are cheap (`status.get`, `tools.blocklist`, `quota.get`, `tokenLimit.set`, `schedule.alias`). Two classes are not:

- **Snapshot methods** — `stats.models`, `stats.agents` and `stats.requests`. Each calls the same `handleDashboard*Stats()` handler the web dashboard uses, i.e. one unit of the same work the TUI does per tick, including the Tier-0 scans and sorted builders. `stats.requests` additionally loads the config and slices every array value against the caller's `limit`. Cost is exactly the TUI loop's per-tick cost, paid **only when the client asks** — so its impact is a function of the tray's poll cadence, which is not set by this repo. A tray polling at the web dashboard's 10 s would land in the same place as Tier 2; a tray polling at 1 s would be equivalent to running the TUI. The config-derived reads (`config.get`, `models.list`) are cheap by comparison.
- **`model.test`** — issues a **real upstream LLM call** from inside the proxy process. It is not instrumentation overhead; it is load generation against the configured provider, plus the routing path of a normal request.

One structural cost applies to every method: the handlers are HTTP handlers, so each call is driven by a synthetic `Request` (`syntheticRequest`, `src/rpc.ts:78`) and its result is read back through `res.text()` + `JSON.parse` (`unwrap`, `:101`). Every RPC reply therefore round-trips through request/response serialization rather than being taken as an object. Small per call, but it means no RPC method is ever literally free.

`config.put` and `config.reload` clear the config cache, invalidating the cached config the routing path reads (one-off per edit, same as the dashboard's `saveConfigMutation`).

## Flat costs that do not scale with request count

`src/rpc.ts` never touches the request hot path — the design comment quoted in Tier 2b is accurate, and unlike the dashboard's stats layer there is no per-request hook anywhere in it. Its cost is a **fixed 1 Hz poll** (which does include the Tier-0 24 h-tail walk and a sync `statSync`, unconditionally — see Tier 2b) plus whatever the client requests on demand. It is not free, but it is flat and bounded: it does not grow with request count the way the Tier-0 instrumentation does.

Other amortized-away costs: the 31-day retention prune in `recordTokenHeatmapEvent` is a head-`shift()` loop bounded by the number of aged events; the model health-check timer (`src/tui.ts:2857`) only runs on demand.

## Conflict with existing documentation

`docs/reference/cpu-optimization-advices.md:77` states:

> **Statistics modules** (`Model Statistic`, `Request Statistic`, `Agent Statistic`) consume virtually no CPU — they are just lightweight `Map` counters and are not worth optimizing.

That is true of the **counters** themselves. It is **not** true of everything in `src/utils/dashboard-stats.ts`, which also contains the SSE transform streams, the per-request window-tail scans, the synchronous JSONL dumps, and the snapshot builders — all of which are CPU work proportional to request/traffic volume rather than fixed-size `Map` increments.

These two documents currently disagree about where the dashboard's cost lives. The claim in `cpu-optimization-advices.md` is narrower than it reads; it has been left unedited pending a decision on how to reconcile them.

## Candidate optimizations (not implemented)

Listed for discussion only — no change has been made, and each should be approved before it is built.

1. **Gate the two SSE tracking streams** behind "is anything consuming stats" (a registered consumer, or a mode flag), so a bare proxy with no TUI/dashboard attached pays nothing per chunk.
2. **Make the TUI snapshot loop incremental** — recompute only what changed rather than re-scanning `tokenHeatmapEvents` and re-sorting nine maps every 500 ms; or lengthen the interval.
3. **Bound the live window tail walk** in `getTokensInWindowSince` / `sumCompositeEventsSince` with a running suffix sum, so per-request limit checks stop scaling with window length × request rate.
4. **Move JSONL persistence off the request path** — queue appends and flush asynchronously, so a day rollover cannot block mid-request.
5. **Skip the response re-parse** when nothing consumes usage/tool stats.
6. **Make the `--rpc` poll cheap** — maintain a running 24 h suffix sum (item 3) so `getTokensInWindow` is O(1) at 1 Hz, and/or skip the poll while no client is attached.

Before acting on any of these, the honest next step is **measurement**: `node --prof` with a representative SSE load, TUI on vs. off, would convert the estimates above into numbers.
