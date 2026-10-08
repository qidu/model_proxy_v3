# Plan: Separate Web Dashboard, TUI Dashboard, and High-Performance Proxy Server

## Context

The current model-proxy-v3 is a monolithic application where:
- The high-performance proxy server (`src/index.ts`) handles all API endpoints (Claude, Gemini, OpenAI formats)
- The web dashboard (`src/handlers/dashboard.ts`) is served at `/dashboard` by the same server
- The TUI dashboard (`src/tui.ts`) runs in the same process when `TUI=true`
- Both dashboards share: config loading, statistics tracking, model routing logic

This creates coupling issues:
- Dashboards cannot run independently without the full proxy server
- Local development requires running the full proxy just to test dashboard UI changes
- High-performance proxy server includes dashboard overhead
- Testing/debugging dashboards requires proxy server to be running

## Goal

Split the codebase into three independently usable modules:
1. **`proxy-core`** - High-performance proxy server module (endpoints, upstreams, message transforming, routing)
2. **`dashboard-web`** - Web dashboard (HTML/JS, served separately, communicates via API)
3. **`dashboard-tui`** - Terminal dashboard (runs independently, communicates via API)

All three share common libraries:
- `config-loader` - Configuration parsing/validation
- `dashboard-stats` - Statistics collection/aggregation
- `routing` - Auth handling, URL building
- `converters` - Format conversions (Claude↔OpenAI↔Gemini)

## Current Architecture Analysis

### Shared Dependencies (to extract as common packages)

| Module | Used By | Key Exports |
|--------|---------|-------------|
| `src/utils/config-loader.ts` | index.ts, dashboard.ts, tui.ts | `loadProxyConfig`, `validateProxyConfig`, `ProxyConfig`, composite alias functions |
| `src/utils/dashboard-stats.ts` | index.ts, dashboard.ts, tui.ts | `recordModelStat`, `getModelStatsDesc`, `getToolUsageStatsDesc`, token heatmap |
| `src/utils/routing.ts` | index.ts, dashboard.ts | `extractAuthHeaders`, `transformAuthHeadersForUpstream`, `formatApiKeyForUpstream` |
| `src/converters/*` | index.ts, handlers/* | All format converters |
| `src/handlers/*` | index.ts | All endpoint handlers |

### Web Dashboard (`src/handlers/dashboard.ts`)
- Serves HTML page at `/dashboard` (embedded 700+ line template)
- REST API: `/dashboard/api/config` (GET/PUT), `/dashboard/api/stats/*`, `/dashboard/api/test-model`
- Uses `getDashboardSnapshot()` to combine config + stats + composite resolution
- Embeds test model logic with tool calling

### TUI Dashboard (`src/tui.ts`)
- Terminal UI using `@mariozechner/pi-tui`
- Same data sources as web dashboard via `getDashboardSnapshot()`
- Interactive composite alias editing (add/remove targets, set limits)
- Model testing with live feedback
- Keyboard shortcuts for all operations

### Proxy Server (`src/index.ts`)
- Main fetch handler with complex routing logic
- Handles 10+ endpoint types with model-specific/composite routing
- Authentication header transformation per upstream mode
- Streaming response handling with usage tracking
- Composite alias fallback/retry logic

## Implementation Plan

### Phase 1: Extract Common Library (`packages/common`)

Create a shared npm package with:
```
packages/common/
├── src/
│   ├── config-loader.ts      # From src/utils/config-loader.ts
│   ├── dashboard-stats.ts    # From src/utils/dashboard-stats.ts
│   ├── routing.ts            # From src/utils/routing.ts
│   ├── errors.ts             # From src/utils/errors.ts
│   ├── validation.ts         # From src/utils/validation.ts
│   ├── thinking.ts           # From src/utils/thinking.ts
│   ├── token-counting.ts     # From src/utils/token-counting.ts
│   ├── logger.ts             # From src/utils/logger.ts
│   ├── beta-features.ts      # From src/utils/beta-features.ts
│   ├── fetch-timeout.ts      # From src/utils/fetch-timeout.ts
│   ├── conversation-store.ts # From src/utils/conversation-store.ts
│   ├── sdk-handler.ts        # From src/utils/sdk-handler.ts
│   ├── stringify.ts          # From src/utils/stringify.ts
│   ├── types/
│   │   ├── claude.ts         # From src/types/claude.ts
│   │   ├── openai.ts         # From src/types/openai.ts
│   │   ├── gemini.ts         # From src/types/gemini.ts
│   │   └── shared.ts         # From src/types/shared.ts
│   └── converters/
│       ├── claude-to-openai.ts
│       ├── openai-to-claude.ts
│       ├── streaming.ts
│       ├── claude-to-gemini.ts
│       ├── gemini-to-claude.ts
│       ├── gemini-streaming.ts
│       └── responses-to-completions.ts
├── package.json
└── tsconfig.json
```

**Key changes:**
- Remove `loadProxyConfig(env)` that reads from `env` - make config loading explicit
- Export `ProxyConfig`, `ModelRouteConfig`, `CompositeRouteSelection` types
- Make `dashboard-stats` work with explicit config (not global state) or provide reset function

### Phase 2: Create Proxy Core Module (`packages/proxy-core`)

```
packages/proxy-core/
├── src/
│   ├── index.ts              # Main fetch handler (from src/index.ts)
│   ├── handlers/
│   │   ├── messages.ts       # From src/handlers/messages.ts
│   │   ├── claude.ts         # From src/handlers/claude.ts
│   │   ├── gemini.ts         # From src/handlers/gemini.ts
│   │   ├── openai.ts         # From src/handlers/openai.ts
│   │   ├── responses.ts      # From src/handlers/responses.ts
│   │   ├── models.ts         # From src/handlers/models.ts
│   │   ├── token-counting.ts # From src/handlers/token-counting.ts
│   │   ├── embeddings.ts     # From src/handlers/embeddings.ts
│   │   └── chat-completions.ts # From src/handlers/chat-completions.ts
│   └── heatmap.ts            # From src/heatmap.ts (used by stats)
├── package.json              # Depends on @model-proxy/common
├── tsconfig.json
├── wrangler.toml             # For Cloudflare Workers deployment
└── server.ts                 # Node.js entry point (from src/server.ts)
```

**Key changes:**
- Remove dashboard routes (`/dashboard*`) from router
- Remove TUI startup logic
- Accept `ProxyConfig` as constructor parameter (not load from env)
- Accept stats collector as dependency (for testing/mocking)
- Export `createProxyHandler(config, statsCollector?)` factory function
- Keep `loadProxyConfig(env)` as optional convenience for standalone use

### Phase 3: Create Web Dashboard Module (`packages/dashboard-web`)

```
packages/dashboard-web/
├── src/
│   ├── index.ts              # HTTP server entry point
│   ├── handlers/
│   │   ├── dashboard.ts      # Refactored from src/handlers/dashboard.ts
│   │   ├── config.ts         # Config API (GET/PUT /api/config)
│   │   ├── stats.ts          # Stats API (/api/stats/*)
│   │   └── test-model.ts     # Test model API (/api/test-model)
│   ├── static/
│   │   ├── index.html        # Extracted from dashboard.ts template
│   │   ├── dashboard.css     # Extracted styles
│   │   └── dashboard.js      # Extracted client-side JS
│   └── utils/
│       └── proxy-client.ts   # Client to call proxy-core API
├── package.json              # Depends on @model-proxy/common, @model-proxy/proxy-core (for types)
├── tsconfig.json
├── vite.config.ts            # For building static assets
└── server.ts                 # Node.js server (serves static + API)
```

**Key changes:**
- Extract HTML/CSS/JS from the 700-line template string into separate files
- Dashboard server calls proxy-core via HTTP (configurable `PROXY_URL`)
- Config API reads/writes `proxy_config.toml` directly (file mode) or errors (URL mode)
- Stats API proxies to proxy-core's stats endpoints
- Test model API proxies to proxy-core's `/v1/messages` endpoint

### Phase 4: Create TUI Dashboard Module (`packages/dashboard-tui`)

```
packages/dashboard-tui/
├── src/
│   ├── index.ts              # Entry point (from src/tui.ts)
│   ├── components/
│   │   ├── DashboardView.ts  # Main view (from DashboardView class)
│   │   ├── CompositeAliasesOverlay.ts
│   │   ├── PromptOverlay.ts
│   │   └── ListOverlay.ts
│   ├── utils/
│   │   ├── proxy-client.ts   # HTTP client to proxy-core
│   │   └── test-model.ts     # Test model logic (shared with web)
│   └── types.ts              # Local types
├── package.json              # Depends on @model-proxy/common, @model-proxy/proxy-core (for types)
├── tsconfig.json
└── bin/
    └── model-proxy-tui       # Executable entry point
```

**Key changes:**
- TUI connects to proxy-core via HTTP (configurable `PROXY_URL`)
- Uses same API endpoints as web dashboard
- Remove direct imports of dashboard handlers - use HTTP client instead
- Keep all interactive features (composite editing, model testing)

### Phase 5: Update Root Package & Tooling

```
model_proxy_v3/
├── package.json              # Workspace root with npm workspaces
├── packages/
│   ├── common/
│   ├── proxy-core/
│   ├── dashboard-web/
│   └── dashboard-tui/
├── proxy_config.toml         # Shared config (can be in each package or root)
├── turbo.json                # Turborepo config for build orchestration
└── README.md                 # Updated documentation
```

**Scripts:**
- `npm run build` - Build all packages (via turborepo)
- `npm run dev:proxy` - Run proxy-core in dev mode
- `npm run dev:web` - Run dashboard-web in dev mode (proxies to proxy-core)
- `npm run dev:tui` - Run dashboard-tui in dev mode (connects to proxy-core)
- `npm run start:all` - Start all three (proxy + web + tui)

### Phase 6: Configuration & Deployment

**Environment Variables:**
- `PROXY_CONFIG_PATH` - Path to config file (used by all packages)
- `PROXY_URL` - Proxy server URL (used by dashboards to connect)
- `DASHBOARD_PORT` - Web dashboard port (default 3000)
- `TUI=true` - Enable TUI (now separate process)

**Deployment Options:**
1. **All-in-one**: Run proxy-core with both dashboards embedded (current behavior, for backwards compat)
2. **Separate processes**: Run proxy-core on port 8788, dashboard-web on 3000, TUI as separate CLI
3. **Cloudflare Workers**: Deploy proxy-core only; dashboards run locally or on separate hosting

## Critical Files to Modify

### New Files (Phase 1-4)
1. `packages/common/package.json` - Common library package
2. `packages/common/tsconfig.json` - TypeScript config
3. `packages/proxy-core/package.json` - Proxy core package
4. `packages/proxy-core/src/index.ts` - Refactored main handler
5. `packages/proxy-core/src/server.ts` - Node entry point
6. `packages/dashboard-web/package.json` - Web dashboard package
7. `packages/dashboard-web/src/index.ts` - Web server entry
8. `packages/dashboard-web/src/handlers/*.ts` - Split dashboard handlers
9. `packages/dashboard-web/static/*` - Extracted static assets
10. `packages/dashboard-tui/package.json` - TUI package
11. `packages/dashboard-tui/src/index.ts` - TUI entry point
12. `packages/dashboard-tui/bin/model-proxy-tui` - CLI executable
13. `turbo.json` - Build orchestration
14. Root `package.json` - Workspace config

### Modified Files
1. `src/utils/config-loader.ts` → `packages/common/src/config-loader.ts` - Remove env-dependent loading
2. `src/utils/dashboard-stats.ts` → `packages/common/src/dashboard-stats.ts` - Make stats injectable/resettable
3. `src/index.ts` → `packages/proxy-core/src/index.ts` - Remove dashboard routes, accept config as param
4. `src/handlers/dashboard.ts` → `packages/dashboard-web/src/handlers/*.ts` - Split into API handlers
5. `src/tui.ts` → `packages/dashboard-tui/src/components/*.ts` - Extract components, use HTTP client
6. `wrangler.toml` → `packages/proxy-core/wrangler.toml` - Proxy-only deployment config

## Verification Plan

### Unit Tests
- Common package: config parsing, validation, stats aggregation
- Proxy-core: routing logic, format conversion, auth handling
- Dashboard-web: API handlers, config persistence
- Dashboard-tui: overlay components, key handling

### Integration Tests
1. **Proxy-core standalone**: 
   - `GET /v1/models` returns models
   - `POST /v1/messages` routes to upstream
   - Streaming works for all endpoint types
   - Composite aliases work with fallback

2. **Dashboard-web + proxy-core**:
   - Dashboard loads at `http://localhost:3000`
   - Config API reads/writes `proxy_config.toml`
   - Stats update in real-time
   - Test model button works

3. **Dashboard-tui + proxy-core**:
   - TUI starts and shows live stats
   - Composite alias editing works (add/remove/edit)
   - Model testing works (including composite aliases)
   - Keyboard shortcuts function

4. **All three together**:
   - No port conflicts
   - Shared config file works
   - Stats synchronized across all

### Backwards Compatibility
- Provide `npm run server` that starts proxy-core with embedded dashboards (current behavior)
- `TUI=true npm run server` still works
- `wrangler deploy` from `packages/proxy-core` works for Cloudflare

## Migration Strategy

1. **Step 1**: Create `packages/common` and move shared code (no behavior change)
2. **Step 2**: Create `packages/proxy-core` with refactored index.ts (test proxy alone)
3. **Step 3**: Create `packages/dashboard-web` with extracted static assets (test web dashboard)
4. **Step 4**: Create `packages/dashboard-tui` with HTTP client (test TUI)
5. **Step 5**: Update root package.json with workspace config and convenience scripts
6. **Step 6**: Verify all deployment modes work

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Global stats state in `dashboard-stats.ts` | Add `resetStats()` and make stats collector injectable |
| Dashboard HTML embedded in TS string | Extract to separate files using Vite/esbuild |
| TUI directly imports dashboard handlers | Create HTTP client wrapper for all dashboard APIs |
| Config loading depends on `Env` type | Make config loading accept plain object/path |
| Circular dependencies | Enforce dependency direction: common → proxy-core → dashboards |

## Success Criteria

1. ✅ `npm run dev:proxy` starts proxy server on port 8788 (no dashboard)
2. ✅ `npm run dev:web` starts web dashboard on port 3000, connects to proxy
3. ✅ `npm run dev:tui` starts TUI, connects to proxy
3. ✅ `npm run start:all` starts all three with correct ports
4. ✅ `wrangler deploy` from `packages/proxy-core` deploys proxy only
5. ✅ All existing API endpoints work identically
6. ✅ Dashboard config editing persists to `proxy_config.toml`
7. ✅ Composite alias editing works in both dashboards
8. ✅ Model testing works in both dashboards
9. ✅ Token stats and heatmap work across restarts