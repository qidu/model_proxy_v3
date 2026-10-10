# Dead & Duplicate Code Review — `src/`

Date: 2026-10-09
Scope: all of `src/` (~41.5k lines, 60+ files)
Method: 5 parallel review agents, every finding verified with repo-wide grep (excluding `node_modules/`, `dist/`, `submodules/`). No dead-code tooling (knip/ts-prune/unimported) is installed in the repo, so all findings are from manual verification.

---

## 1. Dead code (zero references anywhere — safe to delete)

### Converters

- ~~`src/converters/claude-to-gemini.ts:82-320`~~ — ✅ **FIXED (2026-10-09)**: removed the ~160-line dead island of 6 functions (`convertClaudeMessagesToGeminiInput`, `convertClaudeContentToGemini`, `mapClaudeImageMimeToGemini`, `convertClaudeToolToGemini`, `convertClaudeConfigToGemini`, `convertClaudeToolChoiceToGemini`) plus the now-unused imports (`ClaudeContentBlock`, `ClaudeTool`, `ClaudeMessage`, `ClaudeToolUseBlock`, `ClaudeToolResultBlock`, `ThinkingBlock`, all `types/gemini` imports, `stringify`). `decodeDataUri` was kept (live, used by `src/handlers/openai.ts`). No test changes needed — tests only import the live exports. Verified: `npm run typecheck` clean; 38/38 tests pass in `claude-to-gemini.test.ts`, `completions-to-gemini.test.ts`, `token-usage.test.ts`.
- ~~`src/converters/gemini-streaming.ts:370-384`~~ — ✅ **FIXED (2026-10-09)**: removed `processContentDelta` (never called; same logic inlined in the live handlers).

### Handlers

- ~~`src/handlers/gemini.ts:29-50`~~ — ✅ **FIXED (2026-10-09)**: removed the `GeminiConfig` interface / `DEFAULT_GEMINI_CONFIG` const / `getGeminiConfig()` block (zero references).
- ~~`src/handlers/gemini.ts:546`~~ — ✅ **FIXED (2026-10-09)**: removed `extractInteractionId()` (never called).
- ~~`src/handlers/gemini.ts:577-588, 629-630`~~ — ✅ **FIXED (2026-10-09)**: removed the unreachable `'openai-compatible'` `endpointType` branches, narrowed both `endpointType` unions to `'interactions' | 'native-gemini'`, and removed the now-unused imports (`convertGeminiToClaudeResponse`, `convertOpenAIToClaudeResponse`, `createStreamTransformer`). Rationale for unreachability: see §5 endpoint-dispatch matrix — openai-compatible clients bound for a Gemini upstream are handled by `chat-completions.ts` / `responses.ts`, never `gemini.ts`, and a Gemini `generateContent` upstream can never return an OpenAI-shaped body. `src/converters/gemini-to-claude.ts`'s `convertGeminiToClaudeResponse` is now fully production-dead (test-only — see §1 "Production-dead, test-only exports"). No test changes needed; verified: `npm run typecheck` clean, 69/69 tests pass in `handlers.test.ts`, `gemini-to-claude.test.ts`, `completions-to-gemini.test.ts`, `claude-to-gemini.test.ts`.
- `src/handlers/openai.ts:1627` — `convertOpenAIStreamToClaude()` never called (only mentioned in historical docs).
- `src/handlers/responses.ts:180` — `completionsBodyToClaudeBody()` — dead by its own docstring ("Kept for reference only… Do not add new call sites"), eslint-suppressed; former callers now use `completionsToClaudeBody` from `openai.ts`.
- `src/handlers/models.ts:71` — `clearModelCache()` never called anywhere, including tests.

### Utils / config

- `src/utils/config-loader.ts:4719-4766` — OpenClaw file helpers cluster, dead as a group: `DEFAULT_OPENCLAW_CONFIG_PATH`, `resolveOpenClawConfigPath`, `loadOpenClawConfigFromPath`, `persistOpenClawConfigToPath`. (`cli.ts` builds the OpenClaw config in memory and only imports the types.)
- `src/utils/dashboard-stats.ts` — 5 exported functions with zero callers:
  - `getWeekStartDay` (:234) — setter is used, nothing reads it back
  - `recordModelUsageForComposites` (:356) — superseded by live `recordCompositeTokenUsage` (:340)
  - `clearLiveTokens` (:477)
  - `isStatsPersistenceEnabled` (:657) — setter used by `server.ts:14`, getter unused
  - `extractToolCountFromResponsePayload` (:1241) — sibling `extractToolNamesFromResponsePayload` is live

### Top-level files

- `src/server.ts:200,264` — `agentSessionPromise` assigned but never read; the `.catch()/.finally()` chain hangs off the call itself.
- `src/index.ts:1209` — `let isGeminiBypass = false;` declared, never read or reassigned.
- `src/index.ts:65` — unused import `recordResponseStatusCodeFromUpstream`.
- `src/index.ts:80` — unused import `getTokensInWindow` (only `getTokensInWindowSince` is used, :1137).
- `src/tui.ts:395-400` — 5 unused color helpers: `gray`, `darkGray`, `mediumBlue`, `lightGreen`, `mediumGreen`.
- `src/heatmap.ts:32-36` — 5 unused terminal-control consts: `ALT_SCREEN`, `EXIT_ALT_SCREEN`, `HIDE_CURSOR`, `SHOW_CURSOR`, `CLEAR_SCREEN`.
- `src/heatmap.ts:97-99` — `stripAnsi()` never called (tui.ts imports only build/render functions).

### Dead types in `src/types/`

- `src/types/shared.ts` — `TargetConfig` (:262), `ClaudeResponse` (:270), `RouterContext` (:279). Only `Env`, `Logger`, `ClaudeErrorResponse` are ever imported from this file.
- `src/types/claude.ts` — `ClaudeModelsResponse` (:171), `ClaudeModel` (:178), `ClaudeStreamEvent` (:189).
- `src/types/openai.ts` — `OpenAIStreamChunk` (:161).
- `src/types/gemini.ts` — `GeminiModelOption` (:289), `GeminiAgentOption` (:301).

### Production-dead, test-only exports

Referenced only by unit tests. Decision needed: keep as tested public API, or remove along with their tests.

- `src/utils/thinking.ts` — 10 of 11 exports (~250 lines) used only by `tests/unit/thinking.test.ts`: `validateThinkingBudget` (:89), `getEffectiveThinkingBudget` (:126), `isThinkingEnabled` (:144), `createDefaultThinkingConfig` (:154), `adjustThinkingBudget` (:174), `estimateThinkingTokens` (:213), `mergeThinkingConfigs` (:234), `createThinkingBlock` (:258), `validateThinkingForTokenCounting` (:275), plus `normalizeThinkingConfig` (internal-only). Only `normalizeOpenAIToClaudeThinking` (:15, used at `handlers/messages.ts:18`) is live. Overlaps `validation.ts`'s canonical thinking validation (see §2).
- `src/utils/errors.ts` — `AuthenticationError` (:36), `PermissionError` (:43), `RateLimitError` (:50), `ProcessingError` (:57) never thrown in src; mini-validation framework `validateRequired` (:306), `validateString` (:323), `validateNumber` (:370), `validateArray` (:405) test-only — real validators live in `utils/validation.ts`.
- `src/utils/beta-features.ts` — `createBetaHeader` (:84), `validateBetaFeaturesForEndpoint` (:91).
- `src/utils/image-fetch.ts:52` — `getImageEncodeConfig` (production reads config via `resolveImageEncodeConfig` in `config-loader.ts`).
- `src/utils/provider-quota.ts:416` — `clearQuotaCache`.
- `src/utils/config-loader.ts:1078` — `isScheduleAlias` (`resolveScheduleTarget` doesn't call it).
- `src/handlers/gemini.ts:717` — `isGeminiRequest` (only `tests/unit/handlers.test.ts`).
- `src/converters/openai-to-claude.ts:295-302` — `convertOpenAITokenCountingToClaude` (only `tests/unit/openai-to-claude.test.ts`; production re-implements the same response inline — see §2).
- `src/converters/gemini-to-claude.ts:13` — `convertGeminiToClaudeResponse` and its private helpers (`convertGeminiContentToClaude`, `convertGeminiUsageToClaude`, `mapGeminiStatusToStopReason`). Now fully production-dead (its last src importer was removed with the gemini.ts cleanup on 2026-10-09); kept alive only by `tests/unit/gemini-to-claude.test.ts`. Note: `convertGeminiGenerateContentToClaude` in the same file **is** live (used by `handlers/gemini.ts`).

### Unnecessary `export` keywords (not dead, but module-local only)

- `src/handlers/models.ts:50,61,79` — `getCachedModels`, `setCachedModels`, `getCachedModelCount`; `:236,242` — `AnthropicModel`, `AnthropicModelsResponse`.
- `src/handlers/dashboard.ts:83` — `DashboardSnapshot` interface.
- `src/converters/responses-to-completions.ts:16,34,56,70` — `NamespaceMapEntry`, `ConversionWarnings`, `NAMESPACE_MAP_KEY`, `NAMESPACE_SEPARATOR`.
- Various `dashboard-stats.ts` agent helpers, `callJudgeSidecar`, `validateAllTransforms`, `normalizeHookAlias`, `buildEventTransformer`, etc.

---

## 2. Duplicates

### High-value merges

1. **Auth-header mode switch, twice in one file** — `src/utils/routing.ts:534-561` `formatApiKeyForUpstream` vs the inline switch inside `transformAuthHeadersForUpstream` (:428-448). Identical `switch (upstreamMode)` → header mapping, same comments. The standalone function is canonical; the switch should delegate. Also: the `anthropic-beta` validate-and-forward block is duplicated at :329-339 vs :450-461.

2. **`<think>` tag extraction, 5 implementations:**
   - `src/converters/openai-to-gemini.ts:5-21` (`THINK_REGEX` + `extractThinkContent` — canonical helper)
   - `src/converters/openai-to-claude.ts:165-176`
   - `src/converters/streaming.ts:152` (inside `processThinkingExtraction`)
   - `src/converters/completions-to-responses.ts:109-114`
   - `src/handlers/responses.ts:988`

3. **`convertClaudeTokenCountingToOpenAI` vs `convertClaudeToOpenAIRequest`** — `src/converters/claude-to-openai.ts:241-357` vs :362-499. ~100 lines of near-identical message-conversion logic; differ only in the final request wrapper. `convertClaudeToOpenAIRequest` is canonical (3 production callers).

4. **Completions→Claude body conversion, twice:** `src/handlers/openai.ts:638` `completionsToClaudeBody` (canonical: tool-result grouping, `reasoning_content`→thinking, image parts) vs dead `src/handlers/responses.ts:180` `completionsBodyToClaudeBody`.

5. **Completions→Responses request conversion, twice:** `src/handlers/openai.ts:719` `completionsToResponsesBody` (+ `openAIContentToResponsesParts` :323) vs `src/handlers/messages.ts:96` `completionsMessagesToResponsesInput` (+ helpers :55/:75). Slightly different feature sets (openai.ts: `instructions`/`prompt_cache_key`; messages.ts: reasoning round-trip). A merged converter belongs in `src/converters/`.

6. **Identical "Messages→openai-responses upstream" block twice within `src/handlers/messages.ts`:** :318-403 (OpenAI-format inbound) and :593-690 (Claude-format inbound) — same `responsesBody` build, fetch/`applyAfterUpstream`/error handling, near-verbatim `syntheticCompletions` literal (~30 lines each). Includes a duplicated `LOG_LEVEL=debug` `test_tool` file-dump block (:440-456 and :739-754).

7. **TUI ↔ dashboard model-test code — already diverged (bug risk):**
   - `src/tui.ts:278` `buildClaudeToolRequest` + :294 `buildOpenAIToolRequest` + :345 `buildTestToolRequest` + `TEST_TOOL_*` consts (:48-58) vs `src/handlers/dashboard.ts:3405-3443` (own copy, comment admits "mirrored from tui.ts"). **Diverged:** tui.ts uses `maxTokensField()` (`max_completion_tokens` for openai-responses); dashboard hardcodes `max_tokens`.
   - `src/tui.ts:2676` `executeModelTest` + :3660 `resolveModelTestConfig` vs `src/handlers/dashboard.ts:3617` `handleDashboardTestModel` (loopback endpoint construction, per-mode auth headers, composite-alias resolution, `test_model.log` dump).
   - `src/tui.ts:73` `formatTestResultDetail` vs `src/handlers/dashboard.ts:3446` `extractTestResultDetail`.
   - Canonical: tui.ts versions.

8. **Shell exec helpers:** `src/agent-session.ts:66-99` (`getShell`, `runShellCommand`) vs `src/agent-tools.ts:37-42` (`getShell`, byte-identical) + `runCli`/bash-tool execFile wrapper (:114-124, :279-324). Canonical: agent-tools.ts.

9. **`selectWeightedCompositeCandidate`:** `src/index.ts:137` (generic, takes `getWeight`) vs `src/utils/config-loader.ts:861` (same algorithm hardwired to `targetConfig.share`). Canonical: index.ts; config-loader could call it with `c => c.targetConfig.share ?? 1`.

10. **Identical JSON-args parser:** `src/handlers/openai.ts:344` `parseJsonObject()` ≡ `src/converters/openai-to-gemini.ts:23` `parseToolArguments()` — line-for-line identical.

11. **`TargetConfig` type defined twice:** `src/types/shared.ts:262` (dead) vs `src/utils/routing.ts:63` (live, canonical). Also: dead `ClaudeModel`/`ClaudeModelsResponse` (`types/claude.ts:171-185`) overlap live `AnthropicModel`/`AnthropicModelsResponse` (`handlers/models.ts:236-245`).

12. **Thinking-budget validation, twice with divergent rules:** `src/utils/thinking.ts:89` `validateThinkingBudget` / :275 `validateThinkingForTokenCounting` (min budget 1, plain `Error`) vs `src/utils/validation.ts:306/337` `clampThinkingBudget` / `validateThinkingConfig` (min 1024, `ValidationError`). validation.ts is canonical (wired into request validation); thinking.ts versions are dead in src.

13. **Token-counting response built inline 3×:** `src/handlers/token-counting.ts:131-134, 179-194, 253-256` while purpose-built `convertOpenAITokenCountingToClaude` (`src/converters/openai-to-claude.ts:295`) sits unused.

14. **`convertOpenAIToGeminiGenerateContent` vs `convertOpenAIToGeminiInteractions`** — `src/converters/openai-to-gemini.ts:110-186` vs :191-252: identical choice/usage/content/`reasoning_content`/tool_calls extraction; only the output envelope differs.

### Medium / structural duplicates

15. **Tiktoken init + input-token counting:** `src/converters/openai-to-claude.ts:92-114` (`calculateLocalTokens`) vs `src/converters/streaming.ts:77-95` (`initializeTokenCounting`) — same `getTiktokenTokenizer` → `TokenCountingOptions` → `countClaudeRequestTokens` flow with silent-catch fallback.

16. **Gemini usage → Claude usage:** `src/converters/gemini-streaming.ts:19-38` (`convertGeminiUsageToClaudeUsage`, handles both token namings — canonical superset) vs `src/converters/gemini-to-claude.ts:133-145` (`convertGeminiUsageToClaude`, Interactions naming only).

17. **Gemini parts → OpenAI content:** `geminiPartsToOpenAIContent` (`src/handlers/openai.ts:44-71`) vs inline copy inside `convertGeminiGenerateContentToOpenAI` (:228-256). File's own comment (:38-43) admits the duplication.

18. **`TextRef {get,set}` + body text-walking:** `src/utils/privacy-filter.ts:200-270` (`collectTextRefs`) vs `src/utils/kompress.ts:141-219` (`collectCompressibleRefs`) — identical interface and walking pattern; only fragment-selection policy differs.

19. **"string | content-blocks → text" helpers scattered:** `openAIContentToText` (`handlers/openai.ts:303`), `messageText` (`utils/tool-judge-sidecar.ts:172`), `extractSystemText` (`utils/dashboard-stats.ts:930`), system-text branch in `utils/token-counting.ts:238`, `collectTextRefs` (privacy-filter). Same shape dispatch, slightly different join semantics.

20. **Char-based token estimators, twice:** `handlers/token-counting.ts:154` `extractUserTextCharsAsTokenEstimate` (chars/3) vs `utils/token-counting.ts:100` `estimateTokenCount` (chars/4 + 5 overhead).

21. **Upstream-fetch + observability scaffold** (`Content-Type` + `addForwardedHeaders(normalizeOpenAIAuthHeaders(...))` → `fetch` → `recordResponseStatusCodeFromUpstream` → `recordUpstreamResponseToolCount` → `recordUpstreamRateLimit` → `handleTargetApiError`) repeated ~10× across `messages.ts`, `responses.ts`, `openai.ts`, `gemini.ts`, `chat-completions.ts`, `passthrough.ts`. A shared "post to upstream with observability" helper would collapse most of it. Near-identical passthrough halves also in `responses.ts`: `handleResponsesInputTokensRequest` (:1358-1401) vs `handleResponsesCompactRequest` (:1483-1526).

22. **SSE tee-logging loops, 5 copies:** `handlers/gemini.ts:637-697` (double-tee), `handlers/messages.ts:851-915` (same double-tee shape), `handlers/responses.ts:1589-1602`, `handlers/chat-completions.ts:271-285` and :487-500.

23. **SSE buffer-split idiom ~8×:** `chat-completions.ts:147-154` ≡ :382-389 ≡ `openai.ts:384-395` ≡ :495-503 ≡ `messages.ts:1007-1013` ≡ `gemini-streaming.ts:116` etc. (`split('\n\n')` → pop tail → find `data: ` line → slice(6) → `JSON.parse`). A shared SSE-event iterator would collapse these.

24. **OpenAI chunk literal vs existing helper:** `openAIChunk()` exists (`handlers/openai.ts:355`) but identical `chatcmpl_${Date.now()}` chunk literals are hand-inlined at `openai.ts:439-451`, :472-478, and 5× in `chat-completions.ts:161-193`.

25. **Cross-mode forward tails:** `handlers/openai.ts:806` `forwardCompletionsAsAnthropicMessages` and :965 `forwardCompletionsAsOpenAIResponses` share the same post-response block (synthetic completions → gemini/envelope branch → logging).

26. **`stripAnsi` / color wrappers:** `stripAnsi` in `heatmap.ts:97` (dead) and `agent-session.ts:102` (live); `dim`/`bold`/`fg` wrappers duplicated across `heatmap.ts:62-67`, `tui.ts:383-400`, `agent-session.ts:61`. No shared tui-style module exists.

27. **Dashboard in-page JS** (`handlers/dashboard.ts`): `modelNameConflicts()` appears twice (~:1409 and ~:1817, near-identical); wizard functions share repeated `setStatus`/`close`/Escape-keydown scaffolding.

28. **RouteAttempt construction:** `src/index.ts:1582-1637` (inline `compositeAttempts.map` body) vs :1777-1838 (`buildRouteAttempt`) — same body-rebuild + auth-header + `resolveUpstreamTarget` sequence. The map block could delegate to `buildRouteAttempt`.

---

## 3. Explicitly checked and cleared (not duplicates / not dead)

- `src/utils/token-counting.ts` vs `src/handlers/token-counting.ts` — not duplicates; the handler is layered on the utils module (imports at `handlers/token-counting.ts:20-25`).
- `src/handlers/passthrough.ts:83` `buildPlainJoinUrl` vs `utils/routing.ts` `buildUpstreamUrl` — intentionally different (plain join, no mode-aware path mapping).
- `src/utils/stringify.ts` — the single stringify wrapper (over `fast-safe-stringify`/`safe-stable-stringify`), used by 6 converters + `dashboard-stats.ts`. Note: most handlers bypass it and call `JSON.stringify` directly (~150 sites) — inconsistent rather than duplicated.
- All 12 handler files are wired into routing (`src/index.ts:15-43` imports, :2191-2280 dispatch).
- Fully live files verified: `upstream-modes.ts`, `coordinator.ts`, `sdk-handler.ts`, `tool-judge-sidecar.ts`, `hash-detect.ts`, `pi-model-catalog.ts`, `apollo-loader.ts`, `consul-loader.ts`, `body-key-store.ts`, `body-record.ts`, `tool-blocklist.ts`.
- Entry points verified via `package.json` bin/main, `wrangler.toml`, and scripts: `index.ts`, `server.ts`, `cli.ts` static; `tui.ts`, `rpc.ts`, `agent-session.ts` lazy-imported — all real.

---

## 4. Independent issue: NUL bytes in `src/tui.ts`

`src/tui.ts` contains literal NUL bytes around lines 2183/2193/2219 (a `'^@'` separator convention, ~offset 92890). This makes ripgrep/Grep treat the file as binary and silently truncate matches — and would likely break automated dead-code tools (knip/ts-prune) as well. Two review agents hit this independently. Recommend replacing with an escaped `'\0'` string literal if intentional.

---

## 5. Endpoint-dispatch matrix (why `'openai-compatible'` was unreachable in `gemini.ts`)

The proxy's architecture is **"handler per upstream mode, converters for cross-format"**. The dispatcher (`src/index.ts:2233-2285`) picks a `handlerType` from the **client endpoint**, then sub-dispatches by `upstreamMode`. Upstream modes: `anthropic-messages` (claude), `openai-completions` + `openai-responses` (openai-compatible), `gemini-generatecontent` + `gemini-interactions` (native-gemini / interactions).

Every client endpoint routed to a **Gemini upstream**:

| Client endpoint | Handler | Response conversion |
|---|---|---|
| `/v1/messages` (anthropic) | `gemini.ts` → `handleGeminiRequestForMessages` (`index.ts:2237`) | `'claude-format'` → `endpointType: 'interactions'` |
| `/v1/interactions` | `gemini.ts` → `handleGeminiRequest` (`index.ts:2246`) | literal `'interactions'` |
| `:generateContent` (native) | `gemini.ts` → `handleGeminiRequest` (`index.ts:2254`) | `'native-gemini'` |
| `/v1/chat/completions` (openai-compatible) | **`chat-completions.ts`** (`index.ts:2272`; `handlerType` stays `'chat-completions'` even for gemini upstreams, `:578`) | `convertCompletionsToGeminiGenerateContentBody` etc. |
| `/v1/responses` (openai-compatible) | **`responses.ts`** (`index.ts:2261`, `:611`) | its own converters |

Consequences:

1. `endpointType` inside `gemini.ts` can only ever be `'interactions'` or `'native-gemini'` — openai-compatible clients bound for a Gemini upstream never enter `gemini.ts`; their own handlers call the `converters/` layer directly.
2. The removed branch was also semantically impossible: it parsed the **upstream response** as OpenAI-shaped, but `gemini.ts` only ever fetches a Gemini `generateContent` URL, which always returns Gemini-shaped JSON.
3. When auditing for dead branches in other handlers, the same check applies: a handler only needs output conversions for the client endpoints the dispatcher can route into it — not for the whole matrix.

---

## 6. Suggested next steps (priority order)

1. Delete fully-dead code in §1 (converters dead island ✅ done, gemini.ts config block + unreachable branches ✅ done, unused imports/consts, dead types).
2. Fix the diverged TUI↔dashboard model-test duplication (§2.7) — live bug risk.
3. Merge `routing.ts` auth-header switch (§2.1) and `selectWeightedCompositeCandidate` (§2.9).
4. Factor `extractThinkContent` (§2.2) and the JSON-args parser (§2.10) into shared helpers.
5. Decide fate of test-only exports (§1) — either wire them in or delete with their tests.
6. Fix NUL bytes in `tui.ts` (§4), then consider adding `knip` to CI to keep this from regressing.
