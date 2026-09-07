import { Env } from '../types/shared.js';
import {
  ProxyConfig,
  CompositeTargetPatch,
  applyDashboardConfigUpdate,
  addCompositeAlias,
  getCompositeRouteCandidates,
  getConfiguredModelIds,
  getModelRouteConfig,
  loadProxyConfigFromPath,
  persistProxyConfigToPath,
  removeCompositeAlias,
  removeCompositeTarget,
  toDashboardConfigPayload,
  upsertCompositeAliasLimit,
  upsertCompositeTarget,
  upsertModelTarget,
  ModelTargetPatch,
  upsertFusionOptions,
  FusionOptions,
  clearProxyConfigCache,
  loadProxyConfig,
  parseHumanTokenLimit,
  formatTokenLimit,
  validateProxyConfig,
  upsertGlobalTokenLimit,
  addScheduleAlias,
  removeScheduleAlias,
  upsertScheduleWindow,
  removeScheduleTarget,
  resolveScheduleTarget,
  ScheduleWindow,
} from '../utils/config-loader.js';
import {
  getAgentStatsDesc,
  getModelStatsDesc,
  getRequestEndpointStatsDesc,
  getRequestEndpointTimingStatsDesc,
  getRequestModelTimingStatsDesc,
  getCompositeLimitWindowsSnapshot,
  getRequestStatusCodeFromUpstreamStatsDesc,
  getRequestStatusCodeToEndpointStatsDesc,
  getRequestUpstreamStatsDesc,
  getTokenHeatmapStatsDesc,
  getTokenHeatmapStatsMonthly,
  getToolUsageStatsDesc,
  getUpstreamResponseToolStatsDesc,
  getAgentToolPanelStats,
  getBlockedTools,
  blockTool,
  unblockTool,
  getPrivacyKeysDetected,
} from '../utils/dashboard-stats.js';
import { formatApiKeyForUpstream } from '../utils/routing.js';
import { getModelQuota, formatQuotaLeft, getUpstreamRateLimitLeft, getUpstreamRateLimitLeftForUrl, type QuotaResult } from '../utils/provider-quota.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isDashboardReadOnly(env: Env): boolean {
  return !!env.PROXY_CONFIG_CONSUL || !!env.PROXY_CONFIG_APOLLO;
}

function getConfigPathForWrite(env: Env): string {
  if (isDashboardReadOnly(env)) {
    throw new Error('Dashboard config editing is disabled when PROXY_CONFIG_CONSUL or PROXY_CONFIG_APOLLO is configured');
  }

  if (!env.PROXY_CONFIG_PATH) {
    throw new Error('PROXY_CONFIG_PATH is not configured');
  }

  return env.PROXY_CONFIG_PATH;
}

export interface DashboardSnapshot {
  config: ReturnType<typeof toDashboardConfigPayload> & {
    read_only: boolean;
    config_path: string | null;
  };
  modelStats: ReturnType<typeof getModelStatsDesc>;
  toolStats: ReturnType<typeof getToolUsageStatsDesc>;
  agentToolStats: ReturnType<typeof getAgentToolPanelStats>;
  blockedTools: string[];
  requestStats: {
    endpoints: ReturnType<typeof getRequestEndpointStatsDesc>;
    upstreams: ReturnType<typeof getRequestUpstreamStatsDesc>;
    upstream_response_tools: ReturnType<typeof getUpstreamResponseToolStatsDesc>;
    status_codes_from_upstreams: ReturnType<typeof getRequestStatusCodeFromUpstreamStatsDesc>;
    status_codes_to_endpoints: ReturnType<typeof getRequestStatusCodeToEndpointStatsDesc>;
    endpoint_timings: ReturnType<typeof getRequestEndpointTimingStatsDesc>;
    model_timings: ReturnType<typeof getRequestModelTimingStatsDesc>;
  };
  tokenHeatmap: ReturnType<typeof getTokenHeatmapStatsDesc>;
  tokenHeatmapMonthly: ReturnType<typeof getTokenHeatmapStatsMonthly>;
  privacyKeysDetected: number;
  compositeLimitWindows: ReturnType<typeof getCompositeLimitWindowsSnapshot>;
  compositeResolved: Array<{
    alias: string;
    targets: Array<{
      model: string;
      routeModel: string | undefined;
      upstreamMode: string;
      targetUrl: string;
    }>;
  }>;
  scheduleResolved: Array<{
    alias: string;
    activeTarget: string | undefined;
    targets: Array<{
      model: string;
      windows: ScheduleWindow[];
    }>;
  }>;
}

export function getDashboardSnapshot(proxyConfig: ProxyConfig, env: Env): DashboardSnapshot {
  const config = {
    ...toDashboardConfigPayload(proxyConfig),
    read_only: isDashboardReadOnly(env),
    config_path: env.PROXY_CONFIG_PATH ?? null,
  };

  const compositeResolved = Object.keys(config.composite)
    .sort((a, b) => a.localeCompare(b))
    .map((alias) => ({
      alias,
      targets: Object.entries(proxyConfig.composite?.[alias] || {})
        .filter(([key]) => key !== 'token_limit' && key !== 'fusion_options' && !key.startsWith('_'))
        .flatMap(([modelName]) => {
          try {
            const route = getModelRouteConfig(modelName, proxyConfig, new Set([alias]));
            return [{
              model: modelName,
              routeModel: route.modelAlias,
              upstreamMode: route.upstreamMode,
              targetUrl: route.targetUrl,
            }];
          } catch {
            // Cycle or unresolvable target — omit from snapshot so consumers
            // don't receive undefined upstreamMode/targetUrl.
            return [];
          }
        }),
    }));

  const scheduleResolved = Object.keys(config.schedule)
    .sort((a, b) => a.localeCompare(b))
    .map((alias) => ({
      alias,
      activeTarget: resolveScheduleTarget(alias, proxyConfig),
      targets: Object.entries(proxyConfig.schedule?.[alias] || {}).map(([model, windows]) => ({
        model,
        windows: windows || [],
      })),
    }));

  return {
    config,
    modelStats: getModelStatsDesc(),
    toolStats: getToolUsageStatsDesc(),
    agentToolStats: getAgentToolPanelStats(),
    blockedTools: [...getBlockedTools()],
    requestStats: {
      endpoints: getRequestEndpointStatsDesc(),
      upstreams: getRequestUpstreamStatsDesc(),
      upstream_response_tools: getUpstreamResponseToolStatsDesc(),
      status_codes_from_upstreams: getRequestStatusCodeFromUpstreamStatsDesc(),
      status_codes_to_endpoints: getRequestStatusCodeToEndpointStatsDesc(),
      endpoint_timings: getRequestEndpointTimingStatsDesc(),
      model_timings: getRequestModelTimingStatsDesc(),
    },
    tokenHeatmap: getTokenHeatmapStatsDesc(),
    tokenHeatmapMonthly: getTokenHeatmapStatsMonthly(),
    privacyKeysDetected: getPrivacyKeysDetected(),
    compositeLimitWindows: getCompositeLimitWindowsSnapshot(),
    compositeResolved,
    scheduleResolved,
  };
}

function saveConfigMutation(env: Env, mutate: (baseConfig: ProxyConfig) => ProxyConfig): ReturnType<typeof toDashboardConfigPayload> {
  const configPath = getConfigPathForWrite(env);
  const baseConfig = loadProxyConfigFromPath(configPath);
  const nextConfig = mutate(baseConfig);
  persistProxyConfigToPath(configPath, nextConfig);
  clearProxyConfigCache();
  return toDashboardConfigPayload(nextConfig);
}

export function addCompositeAliasFromDashboard(env: Env, alias: string): ReturnType<typeof toDashboardConfigPayload> {
  return saveConfigMutation(env, (baseConfig) => addCompositeAlias(baseConfig, alias));
}

export function removeCompositeAliasFromDashboard(env: Env, alias: string): ReturnType<typeof toDashboardConfigPayload> {
  return saveConfigMutation(env, (baseConfig) => removeCompositeAlias(baseConfig, alias));
}

export function upsertCompositeTargetFromDashboard(
  env: Env,
  alias: string,
  targetModel: string,
  patch: CompositeTargetPatch,
): ReturnType<typeof toDashboardConfigPayload> {
  return saveConfigMutation(env, (baseConfig) =>
    upsertCompositeTarget(baseConfig, alias, targetModel, patch, getConfiguredModelIds(baseConfig)),
  );
}

export function upsertModelTargetFromDashboard(
  env: Env,
  category: string,
  aliasKey: string,
  patch: ModelTargetPatch,
): ReturnType<typeof toDashboardConfigPayload> {
  return saveConfigMutation(env, (baseConfig) => upsertModelTarget(baseConfig, category, aliasKey, patch));
}

/**
 * Read the real (unsanitized) `[models.<category>]` entry for `aliasKey` —
 * unlike `toDashboardConfigPayload`, this includes `api_key`. Used to prefill
 * the TUI's edit wizard. Returns undefined when the entry doesn't exist
 * (adding a new target).
 */
export function getModelTargetFromDashboard(
  env: Env,
  category: string,
  aliasKey: string,
): ModelTargetPatch | undefined {
  const configPath = getConfigPathForWrite(env);
  const baseConfig = loadProxyConfigFromPath(configPath);
  const categoryConfig = baseConfig.models?.[category];
  if (!categoryConfig || Array.isArray(categoryConfig)) return undefined;
  const entry = categoryConfig[aliasKey];
  if (!Array.isArray(entry)) return undefined;
  const [target, base_url, api_key, mode] = entry;
  return {
    target: target ?? aliasKey,
    base_url: base_url ?? '',
    api_key: api_key ?? '',
    mode: mode || categoryConfig.upstream_mode || '',
  };
}

export function upsertCompositeAliasLimitFromDashboard(
  env: Env,
  alias: string,
  rawInput: string | null,
): ReturnType<typeof toDashboardConfigPayload> {
  if (rawInput === null || rawInput.trim() === '') {
    return saveConfigMutation(env, (baseConfig) => upsertCompositeAliasLimit(baseConfig, alias, null));
  }
  const parsed = parseHumanTokenLimit(rawInput);
  if (!parsed) {
    throw new Error(`Invalid token limit format: "${rawInput}". Use: <num> <1h|1d|1w|1m>  (e.g. 50K 1d, 1.5M 1h, 100000 1w)`);
  }
  return saveConfigMutation(env, (baseConfig) => upsertCompositeAliasLimit(baseConfig, alias, parsed));
}

export function upsertGlobalTokenLimitFromDashboard(
  env: Env,
  rawInput: string | null,
): ReturnType<typeof toDashboardConfigPayload> {
  if (rawInput === null || rawInput.trim() === '') {
    return saveConfigMutation(env, (baseConfig) => upsertGlobalTokenLimit(baseConfig, null));
  }
  const parsed = parseHumanTokenLimit(rawInput);
  if (!parsed) {
    throw new Error(`Invalid token limit format: "${rawInput}". Use: <num> <1h|1d|1w|1m>  (e.g. 1.1B 1d, 50K 1h)`);
  }
  return saveConfigMutation(env, (baseConfig) => upsertGlobalTokenLimit(baseConfig, rawInput.trim()));
}

export function upsertFusionOptionsFromDashboard(
  env: Env,
  alias: string,
  options: FusionOptions | null,
): ReturnType<typeof toDashboardConfigPayload> {
  return saveConfigMutation(env, (baseConfig) => upsertFusionOptions(baseConfig, alias, options));
}

export function removeCompositeTargetFromDashboard(
  env: Env,
  alias: string,
  targetModel: string,
): ReturnType<typeof toDashboardConfigPayload> {
  return saveConfigMutation(env, (baseConfig) => removeCompositeTarget(baseConfig, alias, targetModel));
}

export function addScheduleAliasFromDashboard(env: Env, alias: string): ReturnType<typeof toDashboardConfigPayload> {
  return saveConfigMutation(env, (baseConfig) => addScheduleAlias(baseConfig, alias));
}

export function removeScheduleAliasFromDashboard(env: Env, alias: string): ReturnType<typeof toDashboardConfigPayload> {
  return saveConfigMutation(env, (baseConfig) => removeScheduleAlias(baseConfig, alias));
}

export function upsertScheduleTargetFromDashboard(
  env: Env,
  alias: string,
  targetModel: string,
  windows: ScheduleWindow[],
): ReturnType<typeof toDashboardConfigPayload> {
  return saveConfigMutation(env, (baseConfig) =>
    upsertScheduleWindow(baseConfig, alias, targetModel, windows, getConfiguredModelIds(baseConfig)),
  );
}

export function removeScheduleTargetFromDashboard(
  env: Env,
  alias: string,
  targetModel: string,
): ReturnType<typeof toDashboardConfigPayload> {
  return saveConfigMutation(env, (baseConfig) => removeScheduleTarget(baseConfig, alias, targetModel));
}

export async function handleDashboardAddScheduleAlias(request: Request, env: Env): Promise<Response> {
  try {
    const body = await request.json() as { alias?: unknown };
    if (typeof body.alias !== 'string' || !body.alias.trim()) {
      return jsonResponse({ error: 'alias is required' }, 400);
    }
    const payload = addScheduleAliasFromDashboard(env, body.alias.trim());
    return jsonResponse(payload);
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 400);
  }
}

export function handleDashboardRemoveScheduleAlias(env: Env, alias: string): Response {
  try {
    const payload = removeScheduleAliasFromDashboard(env, alias);
    return jsonResponse(payload);
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 400);
  }
}

export async function handleDashboardUpsertScheduleTarget(
  request: Request,
  env: Env,
  alias: string,
): Promise<Response> {
  try {
    const body = await request.json() as { target?: unknown; windows?: unknown };
    if (typeof body.target !== 'string' || !body.target.trim()) {
      return jsonResponse({ error: 'target is required' }, 400);
    }
    if (!Array.isArray(body.windows)) {
      return jsonResponse({ error: 'windows must be an array' }, 400);
    }
    const payload = upsertScheduleTargetFromDashboard(env, alias, body.target.trim(), body.windows as ScheduleWindow[]);
    return jsonResponse(payload);
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 400);
  }
}

export function handleDashboardRemoveScheduleTarget(
  env: Env,
  alias: string,
  target: string,
): Response {
  try {
    const payload = removeScheduleTargetFromDashboard(env, alias, target);
    return jsonResponse(payload);
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 400);
  }
}

export async function handleDashboardUpsertModelTarget(
  request: Request,
  env: Env,
  category: string,
  aliasKey: string,
): Promise<Response> {
  try {
    const body = await request.json() as Partial<ModelTargetPatch>;
    if (typeof body.target !== 'string' || !body.target.trim()) {
      return jsonResponse({ error: 'target is required' }, 400);
    }
    if (typeof body.mode !== 'string') {
      return jsonResponse({ error: 'mode is required' }, 400);
    }
    const payload = upsertModelTargetFromDashboard(env, category, aliasKey, {
      target: body.target,
      api_key: typeof body.api_key === 'string' ? body.api_key : '',
      base_url: typeof body.base_url === 'string' ? body.base_url : '',
      mode: body.mode,
    });
    return jsonResponse(payload);
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 400);
  }
}

export function handleDashboardPage(env: Env): Response {
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Proxy Dashboard</title>
    <style>
      body { font-family: system-ui, sans-serif; max-width: 900px; margin: 0 auto; padding: 20px; }
      table { width: 100%; border-collapse: collapse; margin-top: 20px; }
      th, td { padding: 8px; text-align: left; border-bottom: 1px solid #ddd; }
      th { background-color: #f5f5f5; }
      .num { text-align: right; }
      .card { background: #f9f9f9; padding: 20px; border-radius: 8px; margin-bottom: 20px; }
      .badge { display: inline-block; padding: 2px 8px; background: #4caf50; color: white; border-radius: 4px; font-size: 12px; }
      .model-tag { display: inline-block; padding: 2px 6px; background: #e3f2fd; border: 1px solid #90caf9; border-radius: 4px; font-size: 11px; margin: 2px; }
      h3 { margin-top: 0; }
      .api-key-note { font-size: 12px; color: #666; margin-top: 5px; }
      /* Login section */
      #login-providers-list { list-style: none; padding: 0; margin: 0; }
      #login-providers-list li { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid #eee; }
      #login-providers-list li:last-child { border-bottom: none; }
      .provider-name { min-width: 140px; font-weight: 500; }
      .login-btn { padding: 4px 14px; background: #1976d2; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; }
      .login-btn:hover { background: #1565c0; }
      .login-btn:disabled { background: #90a4ae; cursor: default; }
      .login-status { font-size: 12px; color: #555; }
      .login-status.error { color: #c62828; }
      .login-status.success { color: #2e7d32; }
      .login-status a { color: #1565c0; }
      .alias-config-header { margin-bottom: 10px; }
      .alias-add-row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin-bottom: 12px; }
      .alias-add-row input, .alias-add-row select, .alias-name-input, .alias-target-select { padding: 4px 8px; font-size: 13px; }
      .alias-add-row button, .alias-save-btn, .alias-delete-btn { padding: 4px 10px; border: 1px solid #bdbdbd; border-radius: 4px; background: white; cursor: pointer; }
      .alias-delete-btn { color: #c62828; }
      .alias-message { font-size: 12px; color: #555; min-height: 16px; }
      .alias-message.error { color: #c62828; }
      .alias-message.success { color: #2e7d32; }

      .config-block { border: 1px solid #ddd; border-radius: 6px; padding: 12px; margin-top: 10px; }
      .config-row { display: grid; grid-template-columns: 260px 1fr 1fr; gap: 8px; align-items: center; margin-bottom: 8px; }
      .config-row label { font-weight: 600; }
      input[type="text"], input[type="number"], select {
        width: 100%;
        padding: 6px 10px;
        border: 1px solid #bdbdbd;
        border-radius: 6px;
        background: white;
        font-size: 13px;
        box-sizing: border-box;
      }
      input[type="text"]:focus, input[type="number"]:focus, select:focus {
        outline: none;
        border-color: #1976d2;
        box-shadow: 0 0 0 2px rgba(25, 118, 210, 0.15);
      }
      .config-row .wide { grid-column: 2 / span 2; }
      .sched-window-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; margin: 4px 0 4px 16px; }
      .sched-window-row .sched-window-label { width: 70px; font-weight: 600; font-size: 13px; }
      .sched-window-row .sched-window-time { display: flex; align-items: center; gap: 6px; }
      .sched-window-row .sched-window-days { display: flex; align-items: center; gap: 6px; }
      .sched-window-row input[type=number] { width: 70px; }
      .sched-window-row select { width: auto; min-width: 110px; }
      .row-actions { display: flex; gap: 8px; align-items: center; }
      .mini-btn { padding: 4px 8px; font-size: 12px; justify-self: start; width: auto; }
      .test-btn { padding: 4px 8px; font-size: 12px; background: #e8f5e9; border: 1px solid #a5d6a7; color: #2e7d32; }
      .test-btn:hover { background: #c8e6c9; }
      .test-btn.testing { background: #fff9c4; border-color: #fff176; color: #f57f17; }
      .test-btn.error-result { background: #ffebee; border-color: #ef9a9a; color: #c62828; }
      .test-btn.success-result { background: #e8f5e9; border-color: #a5d6a7; color: #2e7d32; }
      .danger { background: #fff9c454; border: 1px solid #ffebee; }
      .section-actions { margin-top: 8px; }
      /* Tool blocklist */
      tr.tool-row.blocked { background: #fff1f1; }
      tr.tool-row td.status-blocked { color: #c62828; font-weight: 700; }
      .block-btn { padding: 2px 8px; font-size: 12px; cursor: pointer; border-radius: 4px; }
      .block-btn.block { background: white; border: 1px solid #bdbdbd; }
      .block-btn.unblock { background: #fff1f1; border: 1px solid #ef9a9a; color: #c62828; }
      .config-divider { margin: 14px 0; border-top: 3px solid #fff; }
      .config-toolbar { display: flex; justify-content: flex-end; align-items: center; gap: 8px; flex-wrap: wrap; }
      .global-limit-group { display: flex; align-items: center; gap: 6px; margin-right: auto; }
      .global-limit-group label { font-size: 13px; font-weight: 500; white-space: nowrap; }
      .wildcard-test-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 8px 0 12px; }
      .wildcard-test-row label { font-size: 13px; font-weight: 600; }
      #wildcardModelInput { width: 260px; }
      #wildcardRouteHint { font-size: 12px; color: #000; }
      #wildcardTestStatus { font-size: 12px; color: #666; }
      #wildcardTestStatus.error { color: #c62828; }
      #globalTokenLimitNum { padding: 4px 8px; font-size: 13px; border: 1px solid #bdbdbd; border-radius: 4px; }
      #globalTokenLimitDuration { padding: 4px 6px; font-size: 13px; border: 1px solid #bdbdbd; border-radius: 4px; }
      #saveGlobalLimit { padding: 4px 10px; font-size: 13px; border: 1px solid #bdbdbd; border-radius: 4px; background: white; cursor: pointer; }
      #saveGlobalLimit:hover { background: #f0f0f0; }
      #globalLimitStatus { font-size: 12px; color: #555; }
      .request-submodule { margin-top: 18px; }
      .primary-label { font-size: 11px; color: #444; }
      button {
        padding: 8px 14px;
        border: 1px solid #bdbdbd;
        border-radius: 6px;
        background: white;
        cursor: pointer;
        font-size: 13px;
      }
      button:hover { background: #f3f6fb; }
      button:disabled { opacity: 0.6; cursor: default; }
      /* Floating side nav */
      .side-nav { position: fixed; top: 50%; right: 0; transform: translateY(-50%); display: flex; flex-direction: column; gap: 2px; z-index: 1000; }
      .side-nav a { display: block; padding: 8px 14px; background: #e0e0e0; color: #333; text-decoration: none; font-size: 13px; border-radius: 6px 0 0 6px; transition: background 0.15s; opacity: 0.7; }
      .side-nav a:hover { opacity: 1; }
      .side-nav a.active { background: white; opacity: 0.9; border: 1px solid #d3d3d3; border-right: none; }
      #configStatus {
        margin-left: 8px;
        font-size: 11px;
        background: #e3f2fd;
        border: 1px solid #bbdefb;
        color: #1565c0;
        border-radius: 6px;
        padding: 3px 8px;
        min-height: 20px;
        display: inline-flex;
        align-items: center;
      }
      #configStatus.error {
        background: #ffebee;
        border: 1px solid #ef9a9a;
        color: #c62828;
      }
      #testResultPanel .result-model { font-weight: 600; }
      #testResultPanel.success { background: #e8f5e9; border: 1px solid #a5d6a7; color: #1b5e20; }
      #testResultPanel.error { background: #ffebee; border: 1px solid #ef9a9a; color: #b71c1c; }
      #testResultPanel.testing { background: #fff9c4; border: 1px solid #fff176; color: #e65100; }
      .result-usage { font-size: 12px; opacity: 0.8; }
      .result-clear { float: right; background: none; border: none; cursor: pointer; font-size: 13px; padding: 0; color: inherit; opacity: 0.7; }
      .result-clear:hover { opacity: 1; }
      .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.4); display: flex; align-items: flex-start; justify-content: center; z-index: 2000; padding-top: 6vh; }
      .modal-overlay[hidden] { display: none; }
      .modal { position: relative; background: white; border-radius: 8px; padding: 20px; max-width: 560px; width: 90%; box-shadow: 0 4px 16px rgba(0,0,0,0.18); }
      .modal-close-x { position: absolute; top: 8px; right: 12px; background: none; border: none; font-size: 22px; line-height: 1; cursor: pointer; color: #666; padding: 4px 8px; }
      .modal-close-x:hover { color: #c62828; }
      .modal h3 { margin-top: 0; }
      .modal-status { font-size: 13px; padding: 6px 0; min-height: 20px; }
      .modal-status.error { color: #c62828; }
      .modal-status.ok { color: #2e7d32; }
      .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
      .modal label { display: block; font-size: 12px; font-weight: 600; margin-top: 8px; }
      .modal input[type=text], .modal select { width: 100%; padding: 6px 8px; font-size: 13px; border: 1px solid #bdbdbd; border-radius: 4px; box-sizing: border-box; }
      .modal input[type=number] { width: 100%; padding: 6px 8px; font-size: 13px; border: 1px solid #bdbdbd; border-radius: 4px; box-sizing: border-box; }
      .wizard-steps { font-size: 11px; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
      .modal .mode-options { display: flex; gap: 8px; margin-top: 6px; }
      .modal .mode-option { flex: 1; padding: 8px; border: 1px solid #bdbdbd; border-radius: 4px; cursor: pointer; text-align: center; font-size: 13px; }
      .modal .mode-option.selected { background: #e3f2fd; border-color: #1976d2; }
      .modal .field-row { display: none; }
      .modal .field-row.visible { display: block; }
      .modal .helper-text { font-size: 11px; color: #666; margin-top: 2px; }
    </style>
  </head>
  <body>
    <h1>Proxy Dashboard <span id="keyStoreLock" hidden title="All config api_keys are STORE_KEY_IN_SYSTEM (stored in the system keychain)" style="font-size:16px;">🔒</span> <span style="color:#9e9e9e;font-size:14px;font-weight:normal;">${env.VERSION || 'dev'}</span></h1>

    <div id="compositeAliasWizard" class="modal-overlay" hidden>
      <div class="modal" role="dialog" aria-labelledby="wizTitle" aria-modal="true">
        <button type="button" class="modal-close-x" id="wiz-close-x" aria-label="Close wizard" title="Close (Esc)">×</button>
        <div class="wizard-steps" id="wizSteps">Step 1 of 3</div>
        <h3 id="wizTitle">New composite alias — Step 1: Name &amp; mode</h3>
        <div id="wizBody">
          <label for="wiz-alias-name">Alias name</label>
          <input type="text" id="wiz-alias-name" placeholder="e.g. gpt-all" autocomplete="off" />
          <label>Mode</label>
          <div class="mode-options" id="wiz-mode-options">
            <div class="mode-option selected" data-mode="composite" id="wiz-mode-composite"><b>Ç</b> composite<br /><span style="font-size:11px;color:#666;">share / primary / fallback</span></div>
            <div class="mode-option" data-mode="fusion" id="wiz-mode-fusion"><b>ƒ</b> fusion<br /><span style="font-size:11px;color:#666;">panel / judge / synth</span></div>
            <div class="mode-option" data-mode="coordinator" id="wiz-mode-coordinator"><b>Ö</b> coordinator<br /><span style="font-size:11px;color:#666;">planner / executor stages</span></div>
          </div>
        </div>
        <div class="modal-status" id="wiz-status"></div>
        <div class="modal-actions">
          <button type="button" class="mini-btn" id="wiz-cancel">Cancel</button>
          <button type="button" class="mini-btn" id="wiz-back" hidden>Back</button>
          <button type="button" class="mini-btn" id="wiz-submit">Next</button>
        </div>
      </div>
    </div>

    <div id="scheduleWizard" class="modal-overlay" hidden>
      <div class="modal" role="dialog" aria-labelledby="schedWizTitle" aria-modal="true">
        <button type="button" class="modal-close-x" id="sched-wiz-close-x" aria-label="Close wizard" title="Close (Esc)">×</button>
        <div class="wizard-steps" id="schedWizSteps">Step 1 of 2</div>
        <h3 id="schedWizTitle">New schedule alias</h3>
        <div id="schedWizBody">
          <label for="sched-wiz-alias-name">Alias name</label>
          <input type="text" id="sched-wiz-alias-name" placeholder="e.g. day-shift" autocomplete="off" />
          <div class="helper-text">Schedule aliases route by hour-of-day. Add at least one target after creating.</div>
        </div>
        <div class="modal-status" id="sched-wiz-status"></div>
        <div class="modal-actions">
          <button type="button" class="mini-btn" id="sched-wiz-cancel">Cancel</button>
          <button type="button" class="mini-btn" id="sched-wiz-back" hidden>Back</button>
          <button type="button" class="mini-btn" id="sched-wiz-submit">Next</button>
        </div>
      </div>
    </div>

    <div id="scheduleTargetWizard" class="modal-overlay" hidden>
      <div class="modal" role="dialog" aria-labelledby="schedTgtTitle" aria-modal="true">
        <button type="button" class="modal-close-x" id="sched-tgt-close-x" aria-label="Close wizard" title="Close (Esc)">×</button>
        <h3 id="schedTgtTitle">Add schedule target</h3>
        <div id="schedTgtBody">
          <label for="sched-tgt-alias">Schedule alias</label>
          <input type="text" id="sched-tgt-alias" readonly />
          <label for="sched-tgt-model">Target model id</label>
          <input type="text" id="sched-tgt-model" placeholder="e.g. minimax-m3" autocomplete="off" />
          <div class="helper-text">Must match an existing model id defined under [models.*].</div>
        </div>
        <div class="modal-status" id="sched-tgt-status"></div>
        <div class="modal-actions">
          <button type="button" class="mini-btn" id="sched-tgt-cancel">Cancel</button>
          <button type="button" class="mini-btn" id="sched-tgt-submit">Create target</button>
        </div>
      </div>
    </div>

    <div id="compositeTargetWizard" class="modal-overlay" hidden>
      <div class="modal" role="dialog" aria-labelledby="ctgtTitle" aria-modal="true">
        <button type="button" class="modal-close-x" id="ctgt-close-x" aria-label="Close wizard" title="Close (Esc)">×</button>
        <div class="wizard-steps" id="ctgt-steps">Step 1 of 2</div>
        <h3 id="ctgtTitle">Add target</h3>
        <div id="ctgtBody"></div>
        <div class="modal-status" id="ctgt-status"></div>
        <div class="modal-actions">
          <button type="button" class="mini-btn" id="ctgt-cancel">Cancel</button>
          <button type="button" class="mini-btn" id="ctgt-back" hidden>Back</button>
          <button type="button" class="mini-btn" id="ctgt-submit">Next</button>
        </div>
      </div>
    </div>

    <div id="modelEntryWizard" class="modal-overlay" hidden>
      <div class="modal" role="dialog" aria-labelledby="meTitle" aria-modal="true">
        <button type="button" class="modal-close-x" id="me-close-x" aria-label="Close wizard" title="Close (Esc)">×</button>
        <div class="wizard-steps" id="me-steps">Step 1 of 1</div>
        <h3 id="meTitle">Add model entry</h3>
        <div id="meBody"></div>
        <div class="modal-status" id="me-status"></div>
        <div class="modal-actions">
          <button type="button" class="mini-btn" id="me-cancel">Cancel</button>
          <button type="button" class="mini-btn" id="me-submit">Create entry</button>
        </div>
      </div>
    </div>

    <div id="modelTargetWizard" class="modal-overlay" hidden>
      <div class="modal" role="dialog" aria-labelledby="mtWizTitle" aria-modal="true">
        <button type="button" class="modal-close-x" id="mt-wiz-close-x" aria-label="Close wizard" title="Close (Esc)">×</button>
        <div class="wizard-steps" id="mt-wiz-steps">Step 1 of 6</div>
        <h3 id="mtWizTitle">Add target model — Step 1: Alias key</h3>
        <div id="mt-wiz-body"></div>
        <div class="modal-status" id="mt-wiz-status"></div>
        <div class="modal-actions">
          <button type="button" class="mini-btn" id="mt-wiz-cancel">Cancel</button>
          <button type="button" class="mini-btn" id="mt-wiz-back" hidden>Back</button>
          <button type="button" class="mini-btn" id="mt-wiz-submit">Next</button>
        </div>
      </div>
    </div>

    <div class="side-nav" id="sideNav">
      <a href="#section-config">Config</a>
      <a href="#section-model">Model</a>
      <a href="#section-request">Request</a>
      <a href="#section-agent">Agent</a>
    </div>

    <section class="card" id="section-config">
      <h2>Config Module</h2>
      <p>Edit config for <code>models.*</code> and <code>composite.*</code> as models alias. Note the <code>api_key</code> fields are hidden and not editable.</p>
      <div class="wildcard-test-row">
        <label for="wildcardModelInput">Wildcard model test:</label>
        <input type="text" id="wildcardModelInput" placeholder="model id matched by wildcard" autocomplete="off" />
        <button id="testWildcardModel" type="button" class="test-btn mini-btn">test</button>
        <span id="wildcardRouteHint"></span>
        <span id="wildcardTestStatus"></span>
      </div>
      <div id="configForm"></div>
      <div class="config-divider"></div>
      <div class="config-toolbar">
        <div class="global-limit-group">
          <label for="globalTokenLimitNum">Total limit:</label>
          <input type="text" id="globalTokenLimitNum" placeholder="e.g. 700M" title="Token amount only, e.g. 50K, 1.5M, 1.1B" style="width:90px;" autocomplete="off" />
          <select id="globalTokenLimitDuration">
            <option value="">(no limit)</option>
            <option value="1h">1 hour</option>
            <option value="1d">1 day</option>
            <option value="1w">1 week</option>
            <option value="1m">1 month</option>
          </select>
          <button id="saveGlobalLimit">Set</button>
          <span id="globalLimitStatus"></span>
        </div>
        <button id="reloadConfig">Reload</button>
        <button id="saveConfig">Save</button>
        <span id="configStatus"></span>
      </div>
    </section>

    <div id="testResultPanel" style="display:none; position:fixed; top:50%; left:0; transform:translateY(-50%); width:240px; border-radius:0 8px 8px 0; padding:14px 16px; z-index:999; font-size:13px; line-height:1.5; word-break:break-all; box-shadow:2px 2px 12px rgba(0,0,0,0.12);"></div>

    <section class="card" id="section-model">
      <h2>Model Statistic <button id="toggleModelStats" class="mini-btn" style="font-size:12px;">Show all</button> <button id="exportModelStatsCsv" class="mini-btn" style="font-size:12px;">Export CSV</button></h2>
      <table id="modelStats">
        <thead><tr><th>Model ID</th><th class="num">Requests</th><th class="num">Failed</th><th class="num">Input Tokens</th><th class="num">Cached Tokens</th><th class="num">Cache Written Tokens</th><th class="num">Output Tokens</th><th class="num">Total Tokens</th><th class="num">min(s)</th><th class="num">avg(s)</th><th class="num">max(s)</th></tr></thead>
        <tbody></tbody>
      </table>
    </section>

    <section class="card" id="section-request">
      <h2>Request Statistic</h2>

      <div class="request-submodule">
        <h3>Privacy Filter</h3>
        <table>
          <thead><tr><th>Metric</th><th class="num">Count</th></tr></thead>
          <tbody><tr><td>filtered Keys (total)</td><td class="num" id="privacyKeysDetected">0</td></tr></tbody>
        </table>
      </div>

      <div class="request-submodule">
        <h3>Status Count</h3>
        <table id="requestUpstreamStats">
          <thead><tr><th>Upstream Base URL</th><th class="num">Usage Left</th><th class="num">Responses</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="request-submodule">
        <table id="requestStatusCodeFromUpstreamStats">
          <thead><tr><th>Status Code of Upstreams</th><th class="num">Responses</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="request-submodule">
        <table id="requestStatusCodeToEndpointStats">
          <thead><tr><th>Status Code of Endpoints</th><th class="num">Responses</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>

      <div class="request-submodule">
        <h3>Requests Timing</h3>
        <table id="requestEndpointTimingStats">
          <thead><tr><th>endpoint</th><th class="num">req</th><th class="num">min(s)</th><th class="num">avg(s)</th><th class="num">max(s)</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </section>

    <section class="card" id="section-agent">
      <h2>Tool Blocklist <button id="toggleToolStats" class="mini-btn" style="font-size:12px;">Show all</button></h2>
      <p style="font-size:12px;color:#666;margin:0 0 8px;">Blocked tools stop accumulating <code>in req</code> / <code>in resp</code> / <code>total len</code> stats. Existing pre-block counts are preserved. Same as TUI <code>P</code> overlay.</p>
      <table id="toolStats">
        <thead><tr><th></th><th>Tool</th><th>Agent</th><th class="num">in req</th><th class="num">in resp</th><th class="num">total len</th><th></th></tr></thead>
        <tbody></tbody>
      </table>
    </section>

    <script>
      const configForm = document.getElementById('configForm');
      const configStatus = document.getElementById('configStatus');
      const saveButton = document.getElementById('saveConfig');
      const globalTokenLimitNum = document.getElementById('globalTokenLimitNum');
      const globalTokenLimitDuration = document.getElementById('globalTokenLimitDuration');
      const globalLimitStatus = document.getElementById('globalLimitStatus');
      const wildcardModelInput = document.getElementById('wildcardModelInput');
      const testWildcardModelButton = document.getElementById('testWildcardModel');
      const wildcardRouteHint = document.getElementById('wildcardRouteHint');
      const wildcardTestStatus = document.getElementById('wildcardTestStatus');
      let currentConfig = { models: {}, composite: {}, schedule: {} };
      let isReadOnly = false;
      let configPathHint = '';
      let compositeResolved = [];
      let modelStats = [];
      let configErrorsList = [];
      let compositeLimitWindowsSnapshot = {};
      const dashboardApiKeyStorageKey = 'model-proxy-dashboard-api-key';
      const dashboardApiKeyMaxAgeMs = 7 * 24 * 60 * 60 * 1000;

      function getDashboardApiKey() {
        try {
          const raw = localStorage.getItem(dashboardApiKeyStorageKey);
          if (!raw) return '';
          const stored = JSON.parse(raw);
          if (!stored || typeof stored.value !== 'string' || typeof stored.savedAt !== 'number') {
            localStorage.removeItem(dashboardApiKeyStorageKey);
            return '';
          }
          if (Date.now() - stored.savedAt > dashboardApiKeyMaxAgeMs) {
            localStorage.removeItem(dashboardApiKeyStorageKey);
            return '';
          }
          return stored.value;
        } catch {
          localStorage.removeItem(dashboardApiKeyStorageKey);
          return '';
        }
      }

      function setDashboardApiKey(value) {
        try {
          if (value) localStorage.setItem(dashboardApiKeyStorageKey, JSON.stringify({ value, savedAt: Date.now() }));
          else localStorage.removeItem(dashboardApiKeyStorageKey);
        } catch {}
      }

      // Shared helpers used by both the "Add composite alias" wizard
      // (openAddAliasWizard) and the "Add target" wizard
      // (openAddCompositeTargetWizard). Kept module-level so the two
      // wizards cannot drift on per-mode field shape.

      // Returns the step-3 target-property fields HTML for a given alias
      // mode. Lifted verbatim from openAddAliasWizard.renderStep3.
      function compositeTargetFieldsHtml(mode) {
        if (mode === 'composite') {
          return '<label for="wiz-share">share</label>' +
            '<input type="number" id="wiz-share" min="0" step="1" value="0" style="width:70px;" />' +
            '<label for="wiz-routing">routing type</label>' +
            '<select id="wiz-routing">' +
              '<option value="fallback" selected>fallback</option>' +
              '<option value="primary">primary</option>' +
            '</select>' +
            '<label for="wiz-fallback">fallback priority</label>' +
            '<input type="number" id="wiz-fallback" min="0" step="1" placeholder="blank = no priority" />' +
            '<div class="helper-text">fallback: used after primary is at capacity. primary: preferred target.</div>';
        }
        if (mode === 'fusion') {
          return '<label for="wiz-fusion-weight">fusion weight</label>' +
            '<input type="number" id="wiz-fusion-weight" min="0" step="1" value="1" />' +
            '<label for="wiz-fusion-role">role</label>' +
            '<select id="wiz-fusion-role">' +
              '<option value="panel">[p]anel → panel</option>' +
              '<option value="judge">[j]udge → judge</option>' +
              '<option value="synth">[s]ynth → synth</option>' +
            '</select>';
        }
        // coordinator
        return '<label for="wiz-coord">coord</label>' +
          '<input type="number" id="wiz-coord" min="0" step="1" value="1" />' +
          '<label for="wiz-coord-role">role</label>' +
          '<select id="wiz-coord-role">' +
            '<option value="planner">[p]lanner</option>' +
            '<option value="executor">[e]xecutor</option>' +
          '</select>';
      }

      // parseNum mirrors openAddAliasWizard's inner helper: blank → null,
      // invalid → NaN, otherwise the number.
      function parseCompositeNum(v) {
        if (v === '' || v === null || v === undefined) return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return NaN;
        return n;
      }

      // Builds the target cfg object for the given mode by reading the
      // step-3 inputs. setStatus(msg, kind) reports inline errors. Returns
      // the cfg, or null on validation failure.
      function buildCompositeTargetCfg(mode, setStatus) {
        if (mode === 'composite') {
          const shareEl = document.getElementById('wiz-share');
          const routingEl = document.getElementById('wiz-routing');
          const fallbackEl = document.getElementById('wiz-fallback');
          let share = parseCompositeNum(shareEl ? shareEl.value : 0);
          const fallback = parseCompositeNum(fallbackEl ? fallbackEl.value : '');
          if (share === null) share = 0;
          if (Number.isNaN(share)) { setStatus('share must be a non-negative number.', 'error'); return null; }
          if (Number.isNaN(fallback)) { setStatus('fallback priority must be a non-negative number or blank.', 'error'); return null; }
          const cfg = { share: share };
          const isPrimary = routingEl && routingEl.value === 'primary';
          if (isPrimary) cfg.primary = true;
          if (!isPrimary && fallback !== null) cfg.fallback = fallback;
          return cfg;
        }
        if (mode === 'fusion') {
          const wEl = document.getElementById('wiz-fusion-weight');
          const roleEl = document.getElementById('wiz-fusion-role');
          let w = parseCompositeNum(wEl ? wEl.value : 1);
          if (w === null) w = 1;
          if (Number.isNaN(w)) { setStatus('fusion weight must be a non-negative number.', 'error'); return null; }
          return { fusion: w, role: roleEl ? roleEl.value : 'panel' };
        }
        // coordinator
        const cEl = document.getElementById('wiz-coord');
        const roleEl = document.getElementById('wiz-coord-role');
        let c = parseCompositeNum(cEl ? cEl.value : 1);
        if (c === null) c = 1;
        if (Number.isNaN(c)) { setStatus('coord must be a non-negative number.', 'error'); return null; }
        return { coord: c, role: roleEl ? roleEl.value : 'planner' };
      }

      // In-page wizard for adding a new composite alias. Single-target only:
      // user picks alias name + mode, then ONE target model + per-mode fields,
      // then submits. Uses inline inputs/selects + a status span — no
      // window.alert / window.prompt / window.confirm.
      function openAddAliasWizard() {
        const overlay = document.getElementById('compositeAliasWizard');
        if (!overlay) return;

        const stepsEl = document.getElementById('wizSteps');
        const titleEl = document.getElementById('wizTitle');
        const bodyEl = document.getElementById('wizBody');
        const statusEl = document.getElementById('wiz-status');
        const cancelBtn = document.getElementById('wiz-cancel');
        const backBtn = document.getElementById('wiz-back');
        const submitBtn = document.getElementById('wiz-submit');
        const closeXBtn = document.getElementById('wiz-close-x');
        if (!stepsEl || !titleEl || !bodyEl || !statusEl || !cancelBtn || !backBtn || !submitBtn || !closeXBtn) return;

        const state = { step: 1, mode: 'composite', alias: '', target: '' };
        const buildEnvLabel = ${JSON.stringify(env.VERSION || 'dev')};

        function setStatus(msg, kind) {
          statusEl.textContent = msg || '';
          statusEl.className = 'modal-status' + (kind ? ' ' + kind : '');
        }

        function setMode(mode) {
          state.mode = mode;
          document.querySelectorAll('#wiz-mode-options .mode-option').forEach(function (el) {
            el.classList.toggle('selected', el.getAttribute('data-mode') === mode);
          });
        }

        function renderStep1() {
          state.step = 1;
          stepsEl.textContent = 'Step 1 of 3';
          titleEl.textContent = 'New composite alias — Step 1: Name & mode';
          bodyEl.innerHTML =
            '<label for="wiz-alias-name">Alias name</label>' +
            '<input type="text" id="wiz-alias-name" placeholder="e.g. gpt-all" autocomplete="off" />' +
            '<label>Mode</label>' +
            '<div class="mode-options" id="wiz-mode-options">' +
              '<div class="mode-option" data-mode="composite"><b>Ç</b> composite<br /><span style="font-size:11px;color:#666;">share / primary / fallback</span></div>' +
              '<div class="mode-option" data-mode="fusion"><b>ƒ</b> fusion<br /><span style="font-size:11px;color:#666;">panel / judge / synth</span></div>' +
              '<div class="mode-option" data-mode="coordinator"><b>Ö</b> coordinator<br /><span style="font-size:11px;color:#666;">planner / executor stages</span></div>' +
            '</div>';
          bodyEl.querySelectorAll('#wiz-mode-options .mode-option').forEach(function (el) {
            el.addEventListener('click', function () {
              setMode(el.getAttribute('data-mode'));
              setStatus('');
            });
          });
          const aliasInput = document.getElementById('wiz-alias-name');
          if (aliasInput) {
            aliasInput.value = state.alias;
            aliasInput.focus();
          }
          setMode(state.mode);
          backBtn.hidden = true;
          submitBtn.textContent = 'Next';
        }

        function renderStep2() {
          state.step = 2;
          stepsEl.textContent = 'Step 2 of 3';
          titleEl.textContent = 'New composite alias — Step 2: Target model';
          bodyEl.innerHTML =
            '<label for="wiz-target-name">Target model id</label>' +
            '<input type="text" id="wiz-target-name" placeholder="e.g. minimax-m3" autocomplete="off" />' +
            '<div class="helper-text">Free text — type an existing model id defined under [models.*].</div>';
          const tgtInput = document.getElementById('wiz-target-name');
          if (tgtInput) {
            tgtInput.value = state.target;
            tgtInput.focus();
          }
          backBtn.hidden = false;
          submitBtn.textContent = 'Next';
        }

        function renderStep3() {
          state.step = 3;
          stepsEl.textContent = 'Step 3 of 3';
          titleEl.textContent = 'New composite alias — Step 3: Target properties';
          bodyEl.innerHTML = compositeTargetFieldsHtml(state.mode);
          if (state.mode === 'composite') {
            var routingSelEl = document.getElementById('wiz-routing');
            if (routingSelEl) {
              routingSelEl.addEventListener('change', function() {
                var fbInput = document.getElementById('wiz-fallback');
                if (fbInput) fbInput.hidden = routingSelEl.value === 'primary';
              });
            }
          }
          backBtn.hidden = false;
          var envLabel = buildEnvLabel || 'dev';
          submitBtn.textContent = 'Create alias ' + state.alias + ' (' + envLabel + ')';
        }

        function validateStep1() {
          const aliasInput = document.getElementById('wiz-alias-name');
          if (!aliasInput) return null;
          const alias = (aliasInput.value || '').trim();
          if (!alias) {
            setStatus('Alias name is required.', 'error');
            aliasInput.focus();
            return null;
          }
          if (currentConfig.composite[alias]) {
            setStatus('Composite alias already exists.', 'error');
            aliasInput.focus();
            return null;
          }
          // Mirror addCompositeAlias's model-id collision check so the user
          // sees the same conflict message inline instead of as a fatal at
          // save time. Reserved keys per getModelNamesInConfig.
          const reserved = { upstream_mode: 1, base_url: 1, api_key: 1 };
          if (currentConfig.models) {
            for (const [category, catCfg] of Object.entries(currentConfig.models)) {
              if (category === 'list' || Array.isArray(catCfg)) continue;
              if (!catCfg || typeof catCfg !== 'object') continue;
              for (const key of Object.keys(catCfg)) {
                if (reserved[key]) continue;
                if (key.startsWith('_')) continue;
                if (key === alias) {
                  setStatus(
                    'Composite alias name "' + alias + '" conflicts with a model defined under [models.*] — alias and model names must be unique',
                    'error',
                  );
                  aliasInput.focus();
                  return null;
                }
              }
            }
          }
          return alias;
        }

        function validateStep2() {
          const tgtInput = document.getElementById('wiz-target-name');
          if (!tgtInput) return null;
          const target = (tgtInput.value || '').trim();
          if (!target) {
            setStatus('Target model id is required.', 'error');
            tgtInput.focus();
            return null;
          }
          return target;
        }

        function buildTargetCfg() {
          return buildCompositeTargetCfg(state.mode, setStatus);
        }

        function close() {
          if (overlay._wizKeydown) {
            document.removeEventListener('keydown', overlay._wizKeydown);
            overlay._wizKeydown = null;
          }
          overlay.hidden = true;
          setStatus('');
          // Resume auto-reload timers (both stats and config) that were
          // paused by configDirty while the wizard was open.
          configDirty = false;
        }

        function onSubmit() {
          setStatus('');
          if (state.step === 1) {
            const alias = validateStep1();
            if (!alias) return;
            state.alias = alias;
            renderStep2();
            return;
          }
          if (state.step === 2) {
            const target = validateStep2();
            if (!target) return;
            state.target = target;
            renderStep3();
            return;
          }
          // step 3: finalize
          const cfg = buildTargetCfg();
          if (!cfg) return;
          currentConfig.composite[state.alias] = {};
          currentConfig.composite[state.alias][state.target] = cfg;
          renderConfigForm(currentConfig);
          saveConfig().then(function () {
            close();
          }).catch(function (err) {
            delete currentConfig.composite[state.alias];
            renderConfigForm(currentConfig);
            setStatus('Save failed: ' + (err && err.message ? err.message : err), 'error');
          });
        }

        function onBack() {
          setStatus('');
          if (state.step === 2) { renderStep1(); return; }
          if (state.step === 3) { renderStep2(); return; }
        }

        // Wire up persistent handlers for this wizard session. We replace them
        // (clone) on open to drop any listeners from a prior session.
        cancelBtn.onclick = function () { close(); };
        backBtn.onclick = function () { onBack(); };
        submitBtn.onclick = function () { onSubmit(); };
        closeXBtn.onclick = function () { close(); };

        // Escape closes the wizard at any step. Stored on overlay so we
        // can remove it when the wizard is dismissed.
        overlay._wizKeydown = function (ev) {
          if (ev.key === 'Escape' || ev.key === 'x' || ev.key === 'X') {
            ev.preventDefault();
            close();
          }
        };
        document.addEventListener('keydown', overlay._wizKeydown);

        overlay.hidden = false;
        renderStep1();
      }

      // In-page wizard for adding a new target to an existing composite
      // alias. Replaces the old window.prompt chain. Step layout depends
      // on whether the alias is empty (mode not yet decided):
      //   empty alias:      1) mode picker  2) target id  3) target props
      //   non-empty alias:  1) target id    2) target props  (mode inferred)
      // For a plain composite alias with no per-mode shape, the props step
      // is skipped and the target is inserted as {} (parity with the old
      // dashboard.ts:1989 path).
      function openAddCompositeTargetWizard(alias) {
        const overlay = document.getElementById('compositeTargetWizard');
        if (!overlay) return;

        const stepsEl = document.getElementById('ctgt-steps');
        const titleEl = document.getElementById('ctgtTitle');
        const bodyEl = document.getElementById('ctgtBody');
        const statusEl = document.getElementById('ctgt-status');
        const cancelBtn = document.getElementById('ctgt-cancel');
        const backBtn = document.getElementById('ctgt-back');
        const submitBtn = document.getElementById('ctgt-submit');
        const closeXBtn = document.getElementById('ctgt-close-x');
        if (!stepsEl || !titleEl || !bodyEl || !statusEl || !cancelBtn || !backBtn || !submitBtn || !closeXBtn) return;

        if (!currentConfig.composite[alias]) {
          currentConfig.composite[alias] = {};
        }

        // Infer the alias's mode from its existing targets. Same logic the
        // rendering uses (dashboard.ts composite-block head tag).
        const existingKeys = Object.keys(currentConfig.composite[alias]).filter((k) => k !== 'token_limit' && k !== 'fusion_options');
        const isCoordHead = existingKeys.some((k) => { const c = currentConfig.composite[alias][k] || {}; return typeof c.coord === 'number' && c.coord > 0; });
        const isFusionHead = !isCoordHead && !!currentConfig.composite[alias].fusion_options;
        const inferredMode = isCoordHead ? 'coordinator' : isFusionHead ? 'fusion' : 'composite';
        const aliasEmpty = existingKeys.length === 0;

        // state.mode is meaningful only when aliasEmpty (user picks).
        // Once the alias has targets we lock to inferredMode.
        const state = { step: 1, mode: aliasEmpty ? 'composite' : inferredMode, target: '' };
        const hasPropsStep = aliasEmpty || inferredMode === 'fusion' || inferredMode === 'coordinator';
        const totalSteps = (aliasEmpty ? 1 : 0) + 1 + (hasPropsStep ? 1 : 0);

        function setStatus(msg, kind) {
          statusEl.textContent = msg || '';
          statusEl.className = 'modal-status' + (kind ? ' ' + kind : '');
        }

        function setMode(mode) {
          state.mode = mode;
          bodyEl.querySelectorAll('#ctgt-mode-options .mode-option').forEach(function (el) {
            el.classList.toggle('selected', el.getAttribute('data-mode') === mode);
          });
        }

        function stepLabel() {
          return 'Step ' + state.step + ' of ' + totalSteps;
        }

        function renderModePicker() {
          bodyEl.innerHTML =
            '<label>Mode</label>' +
            '<div class="mode-options" id="ctgt-mode-options">' +
              '<div class="mode-option" data-mode="composite"><b>Ç</b> composite<br /><span style="font-size:11px;color:#666;">share / primary / fallback</span></div>' +
              '<div class="mode-option" data-mode="fusion"><b>ƒ</b> fusion<br /><span style="font-size:11px;color:#666;">panel / judge / synth</span></div>' +
              '<div class="mode-option" data-mode="coordinator"><b>Ö</b> coordinator<br /><span style="font-size:11px;color:#666;">planner / executor stages</span></div>' +
            '</div>';
          bodyEl.querySelectorAll('#ctgt-mode-options .mode-option').forEach(function (el) {
            el.addEventListener('click', function () {
              setMode(el.getAttribute('data-mode'));
              setStatus('');
            });
          });
          setMode(state.mode);
        }

        function renderTargetId() {
          bodyEl.innerHTML =
            '<label for="ctgt-target-name">Target model id</label>' +
            '<input type="text" id="ctgt-target-name" placeholder="e.g. minimax-m3" autocomplete="off" />' +
            '<div class="helper-text">Free text — type an existing model id defined under [models.*].</div>';
          const tgtInput = document.getElementById('ctgt-target-name');
          if (tgtInput) {
            tgtInput.value = state.target;
            tgtInput.focus();
          }
        }

        function renderProps() {
          bodyEl.innerHTML = compositeTargetFieldsHtml(state.mode);
          if (state.mode === 'composite') {
            var routingSelEl = document.getElementById('wiz-routing');
            if (routingSelEl) {
              routingSelEl.addEventListener('change', function () {
                var fbInput = document.getElementById('wiz-fallback');
                if (fbInput) fbInput.hidden = routingSelEl.value === 'primary';
              });
            }
          }
        }

        function render() {
          stepsEl.textContent = stepLabel();
          titleEl.textContent = 'Add target to composite.' + alias + ' — Step ' + state.step + ': ' + (
            aliasEmpty && state.step === 1 ? 'mode' :
            (state.step === (aliasEmpty ? 2 : 1)) ? 'target model' : 'target properties'
          );
          if (aliasEmpty && state.step === 1) {
            renderModePicker();
            backBtn.hidden = true;
            submitBtn.textContent = 'Next';
            return;
          }
          const targetStep = aliasEmpty ? 2 : 1;
          if (state.step === targetStep) {
            renderTargetId();
            backBtn.hidden = !aliasEmpty;
            submitBtn.textContent = hasPropsStep ? 'Next' : 'Create target';
            return;
          }
          // props step
          renderProps();
          backBtn.hidden = false;
          submitBtn.textContent = 'Create target';
        }

        function validateTargetId() {
          const tgtInput = document.getElementById('ctgt-target-name');
          if (!tgtInput) return null;
          const target = (tgtInput.value || '').trim();
          if (!target) {
            setStatus('Target model id is required.', 'error');
            tgtInput.focus();
            return null;
          }
          if (currentConfig.composite[alias][target]) {
            setStatus('Composite target already exists.', 'error');
            tgtInput.focus();
            return null;
          }
          return target;
        }

        function close() {
          if (overlay._ctgtKeydown) {
            document.removeEventListener('keydown', overlay._ctgtKeydown);
            overlay._ctgtKeydown = null;
          }
          overlay.hidden = true;
          setStatus('');
          configDirty = false;
        }

        function onSubmit() {
          setStatus('');
          const targetStep = aliasEmpty ? 2 : 1;
          if (aliasEmpty && state.step === 1) {
            // mode picked; default 'composite' if user never clicked.
            state.step = 2;
            render();
            return;
          }
          if (state.step === targetStep) {
            const target = validateTargetId();
            if (!target) return;
            state.target = target;
            if (hasPropsStep) {
              state.step = targetStep + 1;
              render();
              return;
            }
            // No props step (plain composite alias, non-empty). Insert {}.
            currentConfig.composite[alias][state.target] = {};
            finalize();
            return;
          }
          // props step
          const cfg = buildCompositeTargetCfg(state.mode, setStatus);
          if (!cfg) return;
          currentConfig.composite[alias][state.target] = cfg;
          finalize();
        }

        function finalize() {
          renderConfigForm(currentConfig);
          saveConfig().then(function () {
            close();
          }).catch(function (err) {
            delete currentConfig.composite[alias][state.target];
            renderConfigForm(currentConfig);
            setStatus('Save failed: ' + (err && err.message ? err.message : err), 'error');
          });
        }

        function onBack() {
          setStatus('');
          const targetStep = aliasEmpty ? 2 : 1;
          if (state.step === targetStep && aliasEmpty) {
            state.step = 1;
            render();
            return;
          }
          if (state.step === targetStep + 1) {
            state.step = targetStep;
            render();
            return;
          }
        }

        cancelBtn.onclick = function () { close(); };
        backBtn.onclick = function () { onBack(); };
        submitBtn.onclick = function () { onSubmit(); };
        closeXBtn.onclick = function () { close(); };

        overlay._ctgtKeydown = function (ev) {
          if (ev.key === 'Escape' || ev.key === 'x' || ev.key === 'X') {
            ev.preventDefault();
            close();
          }
        };
        document.addEventListener('keydown', overlay._ctgtKeydown);

        overlay.hidden = false;
        render();
      }

      // In-page wizard for adding a new [models.<category>] target model,
      // styled and structured like openAddAliasWizard. Unlike
      // openAddModelWizard (single-step, category fixed, no api_key/mode),
      // this collects everything the config array can hold — alias key,
      // target model id, api key, base url, upstream mode — and picks (or
      // creates) the category as the final step. Saves through the
      // dedicated POST /dashboard/api/models/:category/:aliasKey endpoint
      // (backed by upsertModelTargetFromDashboard) rather than the generic
      // whole-page PUT, so api_key round-trips correctly and any existing
      // transforms/max_tokens on other entries are untouched.
      function openAddModelTargetWizard() {
        const overlay = document.getElementById('modelTargetWizard');
        if (!overlay) return;

        const stepsEl = document.getElementById('mt-wiz-steps');
        const titleEl = document.getElementById('mtWizTitle');
        const bodyEl = document.getElementById('mt-wiz-body');
        const statusEl = document.getElementById('mt-wiz-status');
        const cancelBtn = document.getElementById('mt-wiz-cancel');
        const backBtn = document.getElementById('mt-wiz-back');
        const submitBtn = document.getElementById('mt-wiz-submit');
        const closeXBtn = document.getElementById('mt-wiz-close-x');
        if (!stepsEl || !titleEl || !bodyEl || !statusEl || !cancelBtn || !backBtn || !submitBtn || !closeXBtn) return;

        const TOTAL_STEPS = 6;
        const MODES = ['anthropic-messages', 'openai-responses', 'gemini-generatecontent'];
        const state = { step: 1, aliasKey: '', target: '', apiKey: '', baseUrl: '', mode: MODES[0], category: '' };

        function setStatus(msg, kind) {
          statusEl.textContent = msg || '';
          statusEl.className = 'modal-status' + (kind ? ' ' + kind : '');
        }

        function modelNameConflicts(name) {
          const reserved = { upstream_mode: 1, base_url: 1, api_key: 1 };
          if (!currentConfig.models) return false;
          for (const [category, catCfg] of Object.entries(currentConfig.models)) {
            if (category === 'list' || Array.isArray(catCfg)) continue;
            if (!catCfg || typeof catCfg !== 'object') continue;
            for (const key of Object.keys(catCfg)) {
              if (reserved[key]) continue;
              if (key.startsWith('_')) continue;
              if (key === name) return true;
            }
          }
          return false;
        }

        function renderStep1() {
          state.step = 1;
          stepsEl.textContent = 'Step 1 of ' + TOTAL_STEPS;
          titleEl.textContent = 'Add target model — Step 1: Alias key';
          bodyEl.innerHTML =
            '<label for="mt-wiz-alias-key">Alias key</label>' +
            '<input type="text" id="mt-wiz-alias-key" placeholder="e.g. gpt-5-mini" autocomplete="off" />' +
            '<div class="helper-text">Client-facing name — the key clients request under [models.&lt;category&gt;].</div>';
          const el = document.getElementById('mt-wiz-alias-key');
          if (el) { el.value = state.aliasKey; el.focus(); }
          backBtn.hidden = true;
          submitBtn.textContent = 'Next';
        }

        function renderStep2() {
          state.step = 2;
          stepsEl.textContent = 'Step 2 of ' + TOTAL_STEPS;
          titleEl.textContent = 'Add target model — Step 2: Target model id';
          bodyEl.innerHTML =
            '<label for="mt-wiz-target">Target model id</label>' +
            '<input type="text" id="mt-wiz-target" placeholder="e.g. gpt-5-mini-2025-08-07" autocomplete="off" />' +
            '<div class="helper-text">Upstream model id to map ' + escapeHtml(state.aliasKey) + ' to.</div>';
          const el = document.getElementById('mt-wiz-target');
          if (el) { el.value = state.target; el.focus(); }
          backBtn.hidden = false;
          submitBtn.textContent = 'Next';
        }

        function renderStep3() {
          state.step = 3;
          stepsEl.textContent = 'Step 3 of ' + TOTAL_STEPS;
          titleEl.textContent = 'Add target model — Step 3: API key';
          bodyEl.innerHTML =
            '<label for="mt-wiz-api-key">API key (optional)</label>' +
            '<input type="text" id="mt-wiz-api-key" placeholder="leave blank to use the category api_key" autocomplete="off" />' +
            '<div class="helper-text">Leave blank to inherit the category&#39;s api_key.</div>';
          const el = document.getElementById('mt-wiz-api-key');
          if (el) { el.value = state.apiKey; el.focus(); }
          backBtn.hidden = false;
          submitBtn.textContent = 'Next';
        }

        function renderStep4() {
          state.step = 4;
          stepsEl.textContent = 'Step 4 of ' + TOTAL_STEPS;
          titleEl.textContent = 'Add target model — Step 4: Base URL';
          bodyEl.innerHTML =
            '<label for="mt-wiz-base-url">Base URL (optional)</label>' +
            '<input type="text" id="mt-wiz-base-url" placeholder="leave blank to use the category base_url" autocomplete="off" />' +
            '<div class="helper-text">Leave blank to inherit the category&#39;s base_url.</div>';
          const el = document.getElementById('mt-wiz-base-url');
          if (el) { el.value = state.baseUrl; el.focus(); }
          backBtn.hidden = false;
          submitBtn.textContent = 'Next';
        }

        function renderStep5() {
          state.step = 5;
          stepsEl.textContent = 'Step 5 of ' + TOTAL_STEPS;
          titleEl.textContent = 'Add target model — Step 5: Upstream mode';
          bodyEl.innerHTML =
            '<label>Upstream mode</label>' +
            '<div class="mode-options" id="mt-wiz-mode-options">' +
              MODES.map((m) => '<div class="mode-option" data-mode="' + m + '">' + m + '</div>').join('') +
            '</div>';
          bodyEl.querySelectorAll('#mt-wiz-mode-options .mode-option').forEach((el) => {
            el.addEventListener('click', () => {
              state.mode = el.getAttribute('data-mode');
              bodyEl.querySelectorAll('#mt-wiz-mode-options .mode-option').forEach((o) => {
                o.classList.toggle('selected', o.getAttribute('data-mode') === state.mode);
              });
              setStatus('');
            });
          });
          bodyEl.querySelectorAll('#mt-wiz-mode-options .mode-option').forEach((o) => {
            o.classList.toggle('selected', o.getAttribute('data-mode') === state.mode);
          });
          backBtn.hidden = false;
          submitBtn.textContent = 'Next';
        }

        function renderStep6() {
          state.step = 6;
          stepsEl.textContent = 'Step 6 of ' + TOTAL_STEPS;
          titleEl.textContent = 'Add target model — Step 6: Category';
          const categories = Object.keys(currentConfig.models || {});
          const optionsHtml = categories.map((c) => '<option value="' + escapeHtml(c) + '">' + escapeHtml(c) + '</option>').join('');
          bodyEl.innerHTML =
            '<label for="mt-wiz-category">Category ([models.&lt;category&gt;] section)</label>' +
            '<select id="mt-wiz-category">' + optionsHtml + '<option value="__new__">+ new category…</option></select>' +
            '<div id="mt-wiz-new-category-row" hidden>' +
              '<label for="mt-wiz-new-category">New category name</label>' +
              '<input type="text" id="mt-wiz-new-category" placeholder="e.g. claude, gemini, free" autocomplete="off" />' +
            '</div>';
          const selectEl = document.getElementById('mt-wiz-category');
          const newRowEl = document.getElementById('mt-wiz-new-category-row');
          if (selectEl) {
            selectEl.value = categories.includes(state.category) ? state.category : (categories[0] || '__new__');
            newRowEl.hidden = selectEl.value !== '__new__';
            selectEl.addEventListener('change', () => {
              newRowEl.hidden = selectEl.value !== '__new__';
              if (selectEl.value === '__new__') {
                const newInput = document.getElementById('mt-wiz-new-category');
                if (newInput) newInput.focus();
              }
              setStatus('');
            });
          }
          backBtn.hidden = false;
          var envLabel = ${JSON.stringify(env.VERSION || 'dev')} || 'dev';
          submitBtn.textContent = 'Create target model (' + envLabel + ')';
        }

        function validateStep1() {
          const el = document.getElementById('mt-wiz-alias-key');
          if (!el) return null;
          const aliasKey = (el.value || '').trim();
          if (!aliasKey) {
            setStatus('Alias key is required.', 'error');
            el.focus();
            return null;
          }
          if (modelNameConflicts(aliasKey)) {
            setStatus('Alias key "' + aliasKey + '" already exists under [models.*].', 'error');
            el.focus();
            return null;
          }
          if (currentConfig.composite && currentConfig.composite[aliasKey]) {
            setStatus('Alias key "' + aliasKey + '" conflicts with a composite alias — names must be unique.', 'error');
            el.focus();
            return null;
          }
          return aliasKey;
        }

        function validateStep2() {
          const el = document.getElementById('mt-wiz-target');
          if (!el) return null;
          const target = (el.value || '').trim();
          if (!target) {
            setStatus('Target model id is required.', 'error');
            el.focus();
            return null;
          }
          return target;
        }

        function validateStep6() {
          const selectEl = document.getElementById('mt-wiz-category');
          if (!selectEl) return null;
          if (selectEl.value !== '__new__') return selectEl.value;
          const newInput = document.getElementById('mt-wiz-new-category');
          const newCategory = newInput ? (newInput.value || '').trim() : '';
          if (!newCategory) {
            setStatus('New category name is required.', 'error');
            if (newInput) newInput.focus();
            return null;
          }
          return newCategory;
        }

        function close() {
          if (overlay._mtWizKeydown) {
            document.removeEventListener('keydown', overlay._mtWizKeydown);
            overlay._mtWizKeydown = null;
          }
          overlay.hidden = true;
          setStatus('');
          configDirty = false;
        }

        function finalize() {
          setStatus('Saving...');
          submitBtn.disabled = true;
          dashboardFetch('/dashboard/api/models/' + encodeURIComponent(state.category) + '/' + encodeURIComponent(state.aliasKey), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target: state.target, api_key: state.apiKey, base_url: state.baseUrl, mode: state.mode }),
          }).then(async (res) => {
            const result = await res.json();
            submitBtn.disabled = false;
            if (!res.ok) {
              setStatus('Save failed: ' + (result.error || 'unknown error'), 'error');
              return;
            }
            currentConfig.models = result.models || {};
            currentConfig.composite = result.composite || {};
            currentConfig.schedule = result.schedule || {};
            renderConfigForm(currentConfig);
            close();
          }).catch((err) => {
            submitBtn.disabled = false;
            setStatus('Save failed: ' + (err && err.message ? err.message : err), 'error');
          });
        }

        function onSubmit() {
          setStatus('');
          if (state.step === 1) {
            const aliasKey = validateStep1();
            if (!aliasKey) return;
            state.aliasKey = aliasKey;
            renderStep2();
            return;
          }
          if (state.step === 2) {
            const target = validateStep2();
            if (!target) return;
            state.target = target;
            renderStep3();
            return;
          }
          if (state.step === 3) {
            const el = document.getElementById('mt-wiz-api-key');
            state.apiKey = el ? (el.value || '').trim() : '';
            renderStep4();
            return;
          }
          if (state.step === 4) {
            const el = document.getElementById('mt-wiz-base-url');
            state.baseUrl = el ? (el.value || '').trim() : '';
            renderStep5();
            return;
          }
          if (state.step === 5) {
            renderStep6();
            return;
          }
          // step 6: finalize
          const category = validateStep6();
          if (!category) return;
          state.category = category;
          finalize();
        }

        function onBack() {
          setStatus('');
          if (state.step === 2) { renderStep1(); return; }
          if (state.step === 3) { renderStep2(); return; }
          if (state.step === 4) { renderStep3(); return; }
          if (state.step === 5) { renderStep4(); return; }
          if (state.step === 6) { renderStep5(); return; }
        }

        cancelBtn.onclick = function () { close(); };
        backBtn.onclick = function () { onBack(); };
        submitBtn.onclick = function () { onSubmit(); };
        closeXBtn.onclick = function () { close(); };

        overlay._mtWizKeydown = function (ev) {
          if (ev.key === 'Escape' || ev.key === 'x' || ev.key === 'X') {
            ev.preventDefault();
            close();
          }
        };
        document.addEventListener('keydown', overlay._mtWizKeydown);

        overlay.hidden = false;
        renderStep1();
      }

      // In-page wizard for adding a new model entry to a [models.<category>]
      // section. Replaces the old single window.prompt. Collects key + alias
      // + optional base_url so the row is immediately useful, and writes the
      // correctly-shaped array ([alias] or [alias, base, '']) so the backend
      // validator (which rejects bare 2-element arrays) accepts it.
      function openAddModelWizard(category) {
        const overlay = document.getElementById('modelEntryWizard');
        if (!overlay) return;

        const stepsEl = document.getElementById('me-steps');
        const titleEl = document.getElementById('meTitle');
        const bodyEl = document.getElementById('meBody');
        const statusEl = document.getElementById('me-status');
        const cancelBtn = document.getElementById('me-cancel');
        const submitBtn = document.getElementById('me-submit');
        const closeXBtn = document.getElementById('me-close-x');
        if (!stepsEl || !titleEl || !bodyEl || !statusEl || !cancelBtn || !submitBtn || !closeXBtn) return;

        function setStatus(msg, kind) {
          statusEl.textContent = msg || '';
          statusEl.className = 'modal-status' + (kind ? ' ' + kind : '');
        }

        function render() {
          stepsEl.textContent = 'Step 1 of 1';
          titleEl.textContent = 'Add model entry to models.' + category;
          bodyEl.innerHTML =
            '<label for="me-key">Model key</label>' +
            '<input type="text" id="me-key" placeholder="e.g. gpt-5-mini" autocomplete="off" />' +
            '<div class="helper-text">Wildcard keys (e.g. "*" or "gpt-*") are treated as routing patterns, not concrete model names.</div>' +
            '<label for="me-alias">Target model (upstream model id to map to)</label>' +
            '<input type="text" id="me-alias" placeholder="e.g. gpt-5-mini-2025-08-07" autocomplete="off" />' +
            '<label for="me-base">Base URL override (optional)</label>' +
            '<input type="text" id="me-base" placeholder="https://..." autocomplete="off" />';
          const keyInput = document.getElementById('me-key');
          if (keyInput) keyInput.focus();
        }

        function close() {
          if (overlay._meKeydown) {
            document.removeEventListener('keydown', overlay._meKeydown);
            overlay._meKeydown = null;
          }
          overlay.hidden = true;
          setStatus('');
          configDirty = false;
        }

        function onSubmit() {
          setStatus('');
          const keyInput = document.getElementById('me-key');
          const aliasInput = document.getElementById('me-alias');
          const baseInput = document.getElementById('me-base');
          if (!keyInput) return;
          const key = (keyInput.value || '').trim();
          const alias = (aliasInput && aliasInput.value || '').trim();
          const base = (baseInput && baseInput.value || '').trim();
          if (!key) {
            setStatus('Model key is required.', 'error');
            keyInput.focus();
            return;
          }
          // Reserved keys the rendering/config use internally — allowing
          // them would corrupt the category (modelEntryRow would shadow
          // upstream_mode / base_url rows).
          if (key === 'upstream_mode' || key === 'base_url' || key === 'api_key') {
            setStatus('Key "' + key + '" is reserved for category-level fields.', 'error');
            keyInput.focus();
            return;
          }
          if (currentConfig.models[category] && currentConfig.models[category][key] !== undefined) {
            setStatus('Model key already exists in this category.', 'error');
            keyInput.focus();
            return;
          }
          // Build the array shape the backend validator accepts. A bare
          // 2-element [alias, base] is rejected (see collectConfigPayload
          // comment), so emit 1 or 3 elements.
          const value = base ? [alias, base, ''] : [alias];
          currentConfig.models[category][key] = value;
          renderConfigForm(currentConfig);
          saveConfig().then(function () {
            close();
          }).catch(function (err) {
            delete currentConfig.models[category][key];
            renderConfigForm(currentConfig);
            setStatus('Save failed: ' + (err && err.message ? err.message : err), 'error');
          });
        }

        cancelBtn.onclick = function () { close(); };
        submitBtn.onclick = function () { onSubmit(); };
        closeXBtn.onclick = function () { close(); };

        overlay._meKeydown = function (ev) {
          if (ev.key === 'Escape' || ev.key === 'x' || ev.key === 'X') {
            ev.preventDefault();
            close();
          }
        };
        document.addEventListener('keydown', overlay._meKeydown);

        overlay.hidden = false;
        render();
      }

      // In-page wizard for adding a new schedule alias. Steps:
      //   1) Alias name (with model-id collision check)
      //   2) Optional first target model id (blank = no target yet)
      // Uses inline inputs + status span — no window.alert / window.prompt /
      // window.confirm.
      function openAddScheduleAliasWizard() {
        const overlay = document.getElementById('scheduleWizard');
        if (!overlay) return;
        const stepsEl = document.getElementById('schedWizSteps');
        const titleEl = document.getElementById('schedWizTitle');
        const bodyEl = document.getElementById('schedWizBody');
        const statusEl = document.getElementById('sched-wiz-status');
        const cancelBtn = document.getElementById('sched-wiz-cancel');
        const backBtn = document.getElementById('sched-wiz-back');
        const submitBtn = document.getElementById('sched-wiz-submit');
        const closeXBtn = document.getElementById('sched-wiz-close-x');
        if (!stepsEl || !titleEl || !bodyEl || !statusEl || !cancelBtn || !backBtn || !submitBtn || !closeXBtn) return;

        const state = { step: 1, alias: '', target: '' };
        const buildEnvLabel = ${JSON.stringify(env.VERSION || 'dev')};

        function setStatus(msg, kind) {
          statusEl.textContent = msg || '';
          statusEl.className = 'modal-status' + (kind ? ' ' + kind : '');
        }

        function modelNameConflicts(alias) {
          const reserved = { upstream_mode: 1, base_url: 1, api_key: 1 };
          if (!currentConfig.models) return false;
          for (const [category, catCfg] of Object.entries(currentConfig.models)) {
            if (category === 'list' || Array.isArray(catCfg)) continue;
            if (!catCfg || typeof catCfg !== 'object') continue;
            for (const key of Object.keys(catCfg)) {
              if (reserved[key]) continue;
              if (key.startsWith('_')) continue;
              if (key === alias) return true;
            }
          }
          return false;
        }

        function renderStep1() {
          state.step = 1;
          stepsEl.textContent = 'Step 1 of 2';
          titleEl.textContent = 'New schedule alias — Step 1: Name';
          bodyEl.innerHTML =
            '<label for="sched-wiz-alias-name">Alias name</label>' +
            '<input type="text" id="sched-wiz-alias-name" placeholder="e.g. day-shift" autocomplete="off" />' +
            '<div class="helper-text">Schedule aliases route by hour-of-day. Add at least one target after creating.</div>';
          const aliasInput = document.getElementById('sched-wiz-alias-name');
          if (aliasInput) {
            aliasInput.value = state.alias;
            aliasInput.focus();
          }
          backBtn.hidden = true;
          submitBtn.textContent = 'Next';
        }

        function renderStep2() {
          state.step = 2;
          stepsEl.textContent = 'Step 2 of 2';
          titleEl.textContent = 'New schedule alias — Step 2: First target (optional)';
          bodyEl.innerHTML =
            '<label for="sched-wiz-target-name">First target model id (optional)</label>' +
            '<input type="text" id="sched-wiz-target-name" placeholder="e.g. minimax-m3 — blank to add targets later" autocomplete="off" />' +
            '<div class="helper-text">Free text — must match a model id defined under [models.*].</div>';
          const tgtInput = document.getElementById('sched-wiz-target-name');
          if (tgtInput) {
            tgtInput.value = state.target;
            tgtInput.focus();
          }
          backBtn.hidden = false;
          var envLabel = buildEnvLabel || 'dev';
          submitBtn.textContent = 'Create alias ' + state.alias + ' (' + envLabel + ')';
        }

        function validateStep1() {
          const aliasInput = document.getElementById('sched-wiz-alias-name');
          if (!aliasInput) return null;
          const alias = (aliasInput.value || '').trim();
          if (!alias) {
            setStatus('Alias name is required.', 'error');
            aliasInput.focus();
            return null;
          }
          if (currentConfig.schedule[alias]) {
            setStatus('Schedule alias already exists.', 'error');
            aliasInput.focus();
            return null;
          }
          if (modelNameConflicts(alias)) {
            setStatus(
              'Schedule alias name "' + alias + '" conflicts with a model defined under [models.*] — alias and model names must be unique',
              'error',
            );
            aliasInput.focus();
            return null;
          }
          return alias;
        }

        function validateStep2() {
          const tgtInput = document.getElementById('sched-wiz-target-name');
          if (!tgtInput) return '';
          return (tgtInput.value || '').trim();
        }

        function close() {
          if (overlay._schedWizKeydown) {
            document.removeEventListener('keydown', overlay._schedWizKeydown);
            overlay._schedWizKeydown = null;
          }
          overlay.hidden = true;
          setStatus('');
          configDirty = false;
        }

        function onSubmit() {
          setStatus('');
          if (state.step === 1) {
            const alias = validateStep1();
            if (!alias) return;
            state.alias = alias;
            renderStep2();
            return;
          }
          // step 2: finalize
          const target = validateStep2();
          currentConfig.schedule[state.alias] = {};
          if (target) {
            currentConfig.schedule[state.alias][target] = [];
          }
          renderConfigForm(currentConfig);
          saveConfig().then(function () {
            close();
          }).catch(function (err) {
            delete currentConfig.schedule[state.alias];
            renderConfigForm(currentConfig);
            setStatus('Save failed: ' + (err && err.message ? err.message : err), 'error');
          });
        }

        function onBack() {
          setStatus('');
          if (state.step === 2) renderStep1();
        }

        cancelBtn.onclick = function () { close(); };
        backBtn.onclick = function () { onBack(); };
        submitBtn.onclick = function () { onSubmit(); };
        closeXBtn.onclick = function () { close(); };

        overlay._schedWizKeydown = function (ev) {
          if (ev.key === 'Escape' || ev.key === 'x' || ev.key === 'X') {
            ev.preventDefault();
            close();
          }
        };
        document.addEventListener('keydown', overlay._schedWizKeydown);

        overlay.hidden = false;
        renderStep1();
      }

      // Single-step modal for adding a target model to an existing schedule
      // alias. Replaces the window.prompt/window.alert chain.
      function openAddScheduleTargetWizard(alias) {
        const overlay = document.getElementById('scheduleTargetWizard');
        if (!overlay) return;
        const titleEl = document.getElementById('schedTgtTitle');
        const bodyEl = document.getElementById('schedTgtBody');
        const statusEl = document.getElementById('sched-tgt-status');
        const cancelBtn = document.getElementById('sched-tgt-cancel');
        const submitBtn = document.getElementById('sched-tgt-submit');
        const closeXBtn = document.getElementById('sched-tgt-close-x');
        if (!titleEl || !bodyEl || !statusEl || !cancelBtn || !submitBtn || !closeXBtn) return;

        titleEl.textContent = 'Add schedule target — schedule.' + alias;
        bodyEl.innerHTML =
          '<label for="sched-tgt-alias">Schedule alias</label>' +
          '<input type="text" id="sched-tgt-alias" value="' + escapeHtml(alias) + '" readonly />' +
          '<label for="sched-tgt-model">Target model id</label>' +
          '<input type="text" id="sched-tgt-model" placeholder="e.g. minimax-m3" autocomplete="off" />' +
          '<div class="helper-text">Must match an existing model id defined under [models.*].</div>';

        function setStatus(msg, kind) {
          statusEl.textContent = msg || '';
          statusEl.className = 'modal-status' + (kind ? ' ' + kind : '');
        }

        function close() {
          if (overlay._schedTgtKeydown) {
            document.removeEventListener('keydown', overlay._schedTgtKeydown);
            overlay._schedTgtKeydown = null;
          }
          overlay.hidden = true;
          setStatus('');
          configDirty = false;
        }

        function onSubmit() {
          setStatus('');
          const modelInput = document.getElementById('sched-tgt-model');
          if (!modelInput) return;
          const targetModel = (modelInput.value || '').trim();
          if (!targetModel) {
            setStatus('Target model id is required.', 'error');
            modelInput.focus();
            return;
          }
          if (currentConfig.schedule[alias] && currentConfig.schedule[alias][targetModel]) {
            setStatus('Schedule target already exists.', 'error');
            modelInput.focus();
            return;
          }
          if (!currentConfig.schedule[alias]) currentConfig.schedule[alias] = {};
          currentConfig.schedule[alias][targetModel] = [];
          renderConfigForm(currentConfig);
          saveConfig().then(function () {
            close();
          }).catch(function (err) {
            delete currentConfig.schedule[alias][targetModel];
            if (Object.keys(currentConfig.schedule[alias]).length === 0) {
              delete currentConfig.schedule[alias];
            }
            renderConfigForm(currentConfig);
            setStatus('Save failed: ' + (err && err.message ? err.message : err), 'error');
          });
        }

        cancelBtn.onclick = function () { close(); };
        submitBtn.onclick = function () { onSubmit(); };
        closeXBtn.onclick = function () { close(); };

        overlay._schedTgtKeydown = function (ev) {
          if (ev.key === 'Escape' || ev.key === 'x' || ev.key === 'X') {
            ev.preventDefault();
            close();
          }
        };
        document.addEventListener('keydown', overlay._schedTgtKeydown);

        overlay.hidden = false;
        setTimeout(function () {
          const mi = document.getElementById('sched-tgt-model');
          if (mi) mi.focus();
        }, 0);
      }

      let dashboardApiKeyPrompt = null;

      function promptDashboardApiKey() {
        if (!dashboardApiKeyPrompt) {
          dashboardApiKeyPrompt = Promise.resolve()
            .then(() => {
              const nextKey = window.prompt('Dashboard API key from [dashboard].api_key:');
              const trimmed = nextKey ? nextKey.trim() : '';
              if (trimmed) setDashboardApiKey(trimmed);
              return trimmed;
            })
            .finally(() => { dashboardApiKeyPrompt = null; });
        }
        return dashboardApiKeyPrompt;
      }

      async function dashboardFetch(url, options) {
        while (true) {
          const init = { ...(options || {}) };
          const headers = new Headers(init.headers || {});
          const apiKey = getDashboardApiKey();
          if (apiKey) headers.set('Authorization', 'Bearer ' + apiKey);
          init.headers = headers;

          const res = await fetch(url, init);
          if (res.status !== 401) return res;

          const nextKey = await promptDashboardApiKey();
          if (!nextKey) return res;
        }
      }

      // Set when the user mutates the config (e.g. adding an alias). While true,
      // the dashboard-statistic auto-reload is paused to avoid clobbering the
      // in-flight change. Cleared after the next successful loadConfig().
      let configDirty = false;

      function getAliasUsed(aliasName) {
        const resolved = compositeResolved.find(r => r.alias === aliasName);
        if (!resolved) return 0;
        return resolved.targets.reduce((sum, t) => {
          const statKey = t.routeModel || t.model;
          const entry = modelStats.find(m => m.model === statKey);
          return sum + (entry ? entry.total_tokens : 0);
        }, 0);
      }

      function escapeHtml(value) {
        return String(value ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
      }

      function formatRemainingMs(ms) {
        if (ms <= 0) return '0s';
        const s = Math.floor(ms / 1000);
        if (s < 60) return s + 's';
        const m = Math.floor(s / 60);
        if (m < 60) return m + 'm ' + (s % 60) + 's';
        const h = Math.floor(m / 60);
        if (h < 24) return h + 'h ' + (m % 60) + 'm';
        const d = Math.floor(h / 24);
        return d + 'd ' + (h % 24) + 'h';
      }

      function formatTokenLimitNum(num) {
        if (num >= 1e12) return (num / 1e12).toFixed(1).replace(/\.0$/, '') + 'T';
        if (num >= 1e9) return (num / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
        if (num >= 1e6) return (num / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        if (num >= 1e3) return (num / 1e3).toFixed(1).replace(/\.0$/, '') + 'K';
        return String(num);
      }

      // Client-side mirror of the backend's parseHumanTokenLimit
      // (src/utils/config-loader.ts). Parses "<num[K|M|B|T]> <1h|1d|1w|1m>"
      // into { num, duration }, or returns null on invalid input.
      function parseHumanTokenLimit(raw) {
        const trimmed = (raw || '').trim();
        if (!trimmed) return null;
        const match = trimmed.match(/^([\d.]+)\s*([kKmMbBtT]?)\s+(\d{1,2})([hHdDwWmM])$/);
        if (!match) return null;
        let num = parseFloat(match[1]);
        if (!Number.isFinite(num) || num < 0) return null;
        const suffix = match[2].toLowerCase();
        if (suffix === 'k') num *= 1e3;
        else if (suffix === 'm') num *= 1e6;
        else if (suffix === 'b') num *= 1e9;
        else if (suffix === 't') num *= 1e12;
        if (num < 0 || !Number.isFinite(num)) return null;
        const count = parseInt(match[3], 10);
        const unit = match[4].toLowerCase();
        if (unit === 'h' && (count < 1 || count > 23)) return null;
        if (unit === 'd' && (count < 1 || count > 6)) return null;
        if ((unit === 'w' || unit === 'm') && count !== 1) return null;
        return { num: num, duration: count + unit };
      }

      function wildcardRoutes(config) {
        const routes = [];
        Object.values(config.models || {}).forEach((category) => {
          if (!category || Array.isArray(category)) return;
          Object.entries(category).forEach(([key, value]) => {
            if (Array.isArray(value) && (key === '*' || key.endsWith('-*'))) routes.push(key);
          });
        });
        return Array.from(new Set(routes)).sort();
      }

      function renderWildcardRouteHint(config) {
        const routes = wildcardRoutes(config);
        if (routes.length) {
          const highlighted = routes.map((r) => '<span style="color:#e67e22;font-weight:bold;">' + escapeHtml(r) + '</span>');
          wildcardRouteHint.innerHTML = 'configured: ' + highlighted.join(', ');
        } else {
          wildcardRouteHint.textContent = 'no wildcard routes configured';
        }
      }

      function upstreamModeSelect(categoryName, currentMode) {
        const disabledAttr = isReadOnly ? ' disabled' : '';
        const options = ['anthropic-messages', 'openai-completions', 'openai-responses', 'gemini-generatecontent', 'gemini-interactions'];
        const optionHtml = options.map((mode) => {
          const selected = mode === currentMode ? ' selected' : '';
          return '<option value="' + escapeHtml(mode) + '"' + selected + '>' + escapeHtml(mode) + '</option>';
        }).join('');

        return '<select data-kind="cat-upstream" data-category="' + escapeHtml(categoryName) + '" style="width:180px;"' + disabledAttr + '>'
          + optionHtml
          + '</select>';
      }

      // Per-model upstream_mode override select. Empty value means "inherit
      // from category" — preserved as no override when serialized back to
      // TOML (see serializeModelEntry: mode === '' produces no mode= key).
      // Mirrors upstreamModeSelect's option set so the per-model pick cannot
      // drift from the category-level list.
      function perModelModeSelect(categoryName, modelKey, currentMode) {
        const disabledAttr = isReadOnly ? ' disabled' : '';
        const options = ['', 'anthropic-messages', 'openai-completions', 'openai-responses', 'gemini-generatecontent', 'gemini-interactions'];
        const optionHtml = options.map((mode) => {
          const selected = mode === currentMode ? ' selected' : '';
          const label = mode === '' ? '(inherit)' : mode;
          return '<option value="' + escapeHtml(mode) + '"' + selected + '>' + escapeHtml(label) + '</option>';
        }).join('');

        return '<select data-kind="model-mode" data-category="' + escapeHtml(categoryName) + '" data-key="' + escapeHtml(modelKey) + '" style="width:160px;"' + disabledAttr + '>'
          + optionHtml
          + '</select>';
      }

      function modelEntryRow(categoryName, modelKey, modelValue) {
        const disabledAttr = isReadOnly ? ' disabled' : '';
        const alias = Array.isArray(modelValue) ? modelValue[0] || '' : (modelValue || '');
        const base = Array.isArray(modelValue) ? modelValue[1] || '' : '';
        // GET sanitizer emits [target, base_url, mode] (api_key stripped);
        // mode lives at index 2 and is '' when the entry inherits the
        // category's upstream_mode.
        const perModelMode = Array.isArray(modelValue) ? modelValue[2] || '' : '';
        // Wildcard entries (e.g. "*", "claude-*", "gemini-*") are routing
        // patterns, not concrete model names, so they cannot be tested via
        // the proxy's /v1/messages endpoint. Hide the test button but keep
        // the alias/base_url inputs editable.
        const isWildcard = modelKey === '*' || modelKey.endsWith('-*');
        const testBtnHtml = isWildcard
          ? ''
          : '<button type="button" class="test-btn mini-btn" data-action="test-model" data-model="' + escapeHtml(modelKey) + '">t</button>';
        const wildcardStyle = isWildcard ? ' style="border-left:3px solid #e67e22;padding-left:6px;background:#fff8f3;"' : '';
        return '<div class="config-row"' + wildcardStyle + '>'
          + '<label>' + (isWildcard ? '<span style="color:#e67e22;font-weight:bold;">' + escapeHtml(modelKey) + '</span>' : escapeHtml(modelKey)) + '</label>'
          + '<input type="text" data-kind="model-alias" data-category="' + escapeHtml(categoryName) + '" data-key="' + escapeHtml(modelKey) + '" value="' + escapeHtml(alias) + '" placeholder="model alias"' + disabledAttr + ' />'
          + '<div class="row-actions">'
            + testBtnHtml
            + '<input type="text" data-kind="model-base" data-category="' + escapeHtml(categoryName) + '" data-key="' + escapeHtml(modelKey) + '" value="' + escapeHtml(base) + '" placeholder="base_url override"' + disabledAttr + ' />'
            + perModelModeSelect(categoryName, modelKey, perModelMode)
            + '<button type="button" class="mini-btn danger" data-action="remove-model" data-category="' + escapeHtml(categoryName) + '" data-key="' + escapeHtml(modelKey) + '"' + (isReadOnly ? ' disabled' : '') + '>x</button>'
          + '</div>'
          + '</div>';
      }

      function compositeEntryRows(aliasName, targets, limitWindow) {
        const disabledAttr = isReadOnly ? ' disabled' : '';
        const keys = Object.keys(targets || {}).filter((key) => key !== 'token_limit' && key !== 'fusion_options');
        const tokenLimit = targets.token_limit;
        const limitNum = tokenLimit?.num ?? '';
        const limitDuration = tokenLimit?.duration ?? '';
        const usageLabel = limitWindow
          ? '<span style="font-size:13px;color:#666;margin-left:6px;">Window: ' + formatTokenLimitNum(limitWindow.accumulator) + ' / ' + formatTokenLimitNum(limitWindow.limit) + ' (' + limitWindow.duration + ') — ' + formatRemainingMs(limitWindow.remainingMs) + ' left</span>'
          : '<span style="font-size:13px;color:#888;margin-left:6px;">No active window</span>';
        const durationOptions = [
          { value: '', label: '(no limit)' },
          { value: '1h', label: '1 hour' },
          { value: '1d', label: '1 day' },
          { value: '1w', label: '1 week' },
          { value: '1m', label: '1 month' },
        ];
        const durationOptionsHtml = durationOptions.map((o) =>
          '<option value="' + escapeHtml(o.value) + '"' + (limitDuration === o.value ? ' selected' : '') + '>' + o.label + '</option>'
        ).join('');
        const displayNum = typeof limitNum === 'number' && limitNum > 0 ? formatTokenLimitNum(limitNum) : '';

        // Detect coordinator alias: any target has coord > 0
        const isCoordinator = keys.some((k) => {
          const c = targets[k] || {};
          return typeof c.coord === 'number' && c.coord > 0;
        });
        // Detect fusion alias: has fusion_options or any target with fusion/role (but not coord)
        const fusionOpts = targets.fusion_options || {};
        const isFusion = !isCoordinator && (!!targets.fusion_options || keys.some((k) => {
          const c = targets[k] || {};
          return c.fusion !== undefined || c.role !== undefined;
        }));

        const rows = [
          '<div class="config-row" style="flex-wrap:wrap;gap:6px;align-items:center;">'
            + '<label style="min-width:120px;">' + escapeHtml(aliasName + '.token_limit') + '</label>'
            + '<input type="text" data-kind="comp-limit-num" data-alias="' + escapeHtml(aliasName) + '" value="' + escapeHtml(displayNum) + '" placeholder="e.g. 50K, 1.5M, 100000" style="width:140px;"' + disabledAttr + ' />'
            + '<select data-kind="comp-limit-duration" data-alias="' + escapeHtml(aliasName) + '" style="width:100px;"' + disabledAttr + '>' + durationOptionsHtml + '</select>'
            + usageLabel
            + '</div>'
        ];

        if (isFusion) {
          // fusion_options row
          rows.push(
            '<div class="config-row" style="flex-wrap:wrap;gap:6px;align-items:center;">'
              + '<label style="min-width:120px;">' + escapeHtml(aliasName + '.fusion_options') + '</label>'
              + '<span style="font-size:12px;color:#666;margin-right:4px;">min_panel</span>'
              + '<input type="number" data-kind="comp-fusion-min-panel" data-alias="' + escapeHtml(aliasName) + '" value="' + escapeHtml(fusionOpts.min_panel ?? '') + '" placeholder="1" style="width:60px;"' + disabledAttr + ' />'
              + '<span style="font-size:12px;color:#666;margin-left:8px;margin-right:4px;">panel_timeout_ms</span>'
              + '<input type="number" data-kind="comp-fusion-timeout" data-alias="' + escapeHtml(aliasName) + '" value="' + escapeHtml(fusionOpts.panel_timeout_ms ?? '') + '" placeholder="60000" style="width:80px;"' + disabledAttr + ' />'
              + '<span style="font-size:12px;color:#666;margin-left:8px;margin-right:4px;">judge_required</span>'
              + '<select data-kind="comp-fusion-judge-req" data-alias="' + escapeHtml(aliasName) + '"' + disabledAttr + '>'
                + '<option value=""' + (fusionOpts.judge_required === undefined ? ' selected' : '') + '>(default)</option>'
                + '<option value="true"' + (fusionOpts.judge_required === true ? ' selected' : '') + '>true</option>'
                + '<option value="false"' + (fusionOpts.judge_required === false ? ' selected' : '') + '>false</option>'
              + '</select>'
              + '<span style="font-size:12px;color:#666;margin-left:8px;margin-right:4px;">expose_metadata</span>'
              + '<select data-kind="comp-fusion-expose-meta" data-alias="' + escapeHtml(aliasName) + '"' + disabledAttr + '>'
                + '<option value=""' + (fusionOpts.expose_metadata === undefined ? ' selected' : '') + '>(default)</option>'
                + '<option value="true"' + (fusionOpts.expose_metadata === true ? ' selected' : '') + '>true</option>'
                + '<option value="false"' + (fusionOpts.expose_metadata === false ? ' selected' : '') + '>false</option>'
              + '</select>'
              + '<span style="font-size:12px;color:#666;margin-left:8px;margin-right:4px;">max_concurrent</span>'
              + '<input type="number" data-kind="comp-fusion-max-conc" data-alias="' + escapeHtml(aliasName) + '" value="' + escapeHtml(fusionOpts.max_concurrent ?? '') + '" placeholder="(all)" style="width:60px;"' + disabledAttr + ' />'
              + '</div>'
          );
        }

        if (keys.length === 0) {
          rows.push('<div class="config-row"><label>' + escapeHtml(aliasName) + '</label><div class="wide">(empty)</div></div>');
          return rows.join('');
        }
        return rows.concat(keys.map((targetName) => {
          const cfg = targets[targetName] || {};
          if (isCoordinator) {
            // Coordinator target: show coord weight + [p]lanner / [e]xecutor role
            const coordWeight = cfg.coord ?? 1;
            const roleOptions = [['planner', '[p]lanner'], ['executor', '[e]xecutor']];
            const roleHtml = roleOptions.map(([v, lbl]) =>
              '<option value="' + v + '"' + (cfg.role === v || (v === 'planner' && cfg.role === undefined) ? ' selected' : '') + '>' + lbl + '</option>'
            ).join('');
            return '<div class="config-row">'
              + '<label>' + escapeHtml(targetName) + '</label>'
              + '<span style="font-size:12px;color:#666;margin-right:4px;">coord</span>'
              + '<input type="number" data-kind="comp-coord" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '" value="' + escapeHtml(coordWeight) + '" placeholder="1" style="width:60px;"' + disabledAttr + ' />'
              + '<span style="font-size:12px;color:#666;margin-left:8px;margin-right:4px;">role</span>'
              + '<select data-kind="comp-coord-role" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '"' + disabledAttr + '>' + roleHtml + '</select>'
              + '<div class="row-actions">'
                + '<button type="button" class="test-btn mini-btn" data-action="test-model" data-model="' + escapeHtml(targetName) + '">t</button>'
                + '<button type="button" class="mini-btn danger" data-action="remove-composite-target" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '"' + (isReadOnly ? ' disabled' : '') + '>x</button>'
              + '</div>'
              + '</div>';
          }
          if (isFusion) {
            // Fusion target: show fusion weight + role instead of share/primary/fallback
            const fusionWeight = cfg.fusion ?? '';
            const roleOptions = [['', '(default)'], ['panel', '[p]anel → panel'], ['judge', '[j]udge → judge'], ['synth', '[s]ynth → synth']];
            const roleHtml = roleOptions.map(([v, lbl]) =>
              '<option value="' + v + '"' + (cfg.role === v || (v === '' && cfg.role === undefined) ? ' selected' : '') + '>' + lbl + '</option>'
            ).join('');
            return '<div class="config-row">'
              + '<label>' + escapeHtml(targetName) + '</label>'
              + '<span style="font-size:12px;color:#666;margin-right:4px;">fusion</span>'
              + '<input type="number" data-kind="comp-fusion" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '" value="' + escapeHtml(fusionWeight) + '" placeholder="1" style="width:60px;"' + disabledAttr + ' />'
              + '<span style="font-size:12px;color:#666;margin-left:8px;margin-right:4px;">role</span>'
              + '<select data-kind="comp-role" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '"' + disabledAttr + '>' + roleHtml + '</select>'
              + '<div class="row-actions">'
                + '<button type="button" class="test-btn mini-btn" data-action="test-model" data-model="' + escapeHtml(targetName) + '">t</button>'
                + '<button type="button" class="mini-btn danger" data-action="remove-composite-target" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '"' + (isReadOnly ? ' disabled' : '') + '>x</button>'
              + '</div>'
              + '</div>';
          }
          const share = cfg.share ?? '';
          const fallback = cfg.fallback === 0 ? '' : cfg.fallback ?? '';
          const routingVal = cfg.primary === true ? 'primary' : 'fallback';
          const routingOptions = ['fallback', 'primary'].map((v) =>
            '<option value="' + v + '"' + (routingVal === v ? ' selected' : '') + '>' + v + '</option>'
          ).join('');
          return '<div class="config-row">'
            + '<label>' + escapeHtml(targetName) + '</label>'
            + '<input type="number" data-kind="comp-share" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '" value="' + escapeHtml(share) + '" placeholder="share" style="width:70px;"' + disabledAttr + ' />'
            + '<div class="row-actions">'
            + '<button type="button" class="test-btn mini-btn" data-action="test-model" data-model="' + escapeHtml(targetName) + '">t</button>'
              + '<select data-kind="comp-routing" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '" style="font-size:12px;"' + disabledAttr + '>' + routingOptions + '</select>'
              + '<input type="number" data-kind="comp-fallback" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '" value="' + escapeHtml(fallback) + '" placeholder="priority"' + (cfg.primary === true ? ' hidden' : '') + ' style="width: 120px;"' + disabledAttr + ' />'
              + '<button type="button" class="mini-btn danger" data-action="remove-composite-target" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '"' + (isReadOnly ? ' disabled' : '') + '>x</button>'
            + '</div>'
            + '</div>';
        })).join('');
      }

      function scheduleAliasRows(aliasName, targets) {
        const disabledAttr = isReadOnly ? ' disabled' : '';
        const keys = Object.keys(targets || {}).filter((k) => !k.startsWith('_'));
        if (keys.length === 0) {
          return '<div class="config-row"><label>' + escapeHtml(aliasName) + '</label><div class="wide">(empty)</div></div>';
        }
        const daysOptions = [
          { value: '', label: 'Every day' },
          { value: 'weekday', label: 'Weekdays' },
          { value: 'weekend', label: 'Weekend' },
        ];
        return keys.map((targetName) => {
          const windows = Array.isArray(targets[targetName]) ? targets[targetName] : [];
          const isFallback = windows.length === 0;
          const windowRows = windows.map((w, idx) => {
            const fromVal = (w && typeof w.from === 'number') ? w.from : '';
            const toVal = (w && typeof w.to === 'number') ? w.to : '';
            // Only "weekday"/"weekend" are offered by the dropdown; a custom day
            // array (from hand-edited TOML) has no dropdown option, so it renders
            // as "Every day" here — saving the form will normalize it away. This
            // matches the TUI editor, which also only offers the 3-way choice.
            const daysVal = w && (w.days === 'weekday' || w.days === 'weekend') ? w.days : '';
            const daysOptionsHtml = daysOptions.map((o) =>
              '<option value="' + o.value + '"' + (daysVal === o.value ? ' selected' : '') + '>' + o.label + '</option>'
            ).join('');
            return '<div class="sched-window-row">'
              + '<span class="sched-window-label">window ' + (idx + 1) + '</span>'
              + '<span class="sched-window-time">'
              +   '<span style="font-size:12px;color:#666;">from</span>'
              +   '<input type="number" min="0" max="24" step="0.25" data-kind="sched-window-from" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '" data-index="' + idx + '" value="' + escapeHtml(fromVal) + '" placeholder="0"' + disabledAttr + ' />'
              +   '<span style="font-size:12px;color:#666;">to</span>'
              +   '<input type="number" min="0" max="24" step="0.25" data-kind="sched-window-to" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '" data-index="' + idx + '" value="' + escapeHtml(toVal) + '" placeholder="24"' + disabledAttr + ' />'
              + '</span>'
              + '<span class="sched-window-days">'
              +   '<span style="font-size:12px;color:#666;">days</span>'
              +   '<select data-kind="sched-window-days" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '" data-index="' + idx + '"' + disabledAttr + '>' + daysOptionsHtml + '</select>'
              + '</span>'
              + '<button type="button" class="mini-btn danger" data-action="remove-schedule-window" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '" data-index="' + idx + '"' + (isReadOnly ? ' disabled' : '') + '>x</button>'
              + '</div>';
          }).join('');
          const fallbackBadge = isFallback ? '<span class="badge" style="background:#90a4ae;">fallback</span>' : '';
          return '<div class="config-row">'
            + '<label>' + escapeHtml(targetName) + ' ' + fallbackBadge + '</label>'
            + '<div class="row-actions">'
            + '<button type="button" class="mini-btn" data-action="add-schedule-window" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '"' + (isReadOnly ? ' disabled' : '') + ' style="margin-left:66px;">Add window</button>'
            + '<button type="button" class="mini-btn danger" data-action="remove-schedule-target" data-alias="' + escapeHtml(aliasName) + '" data-target="' + escapeHtml(targetName) + '"' + (isReadOnly ? ' disabled' : '') + '>x</button>'
            + '</div>'
            + '</div>'
            + windowRows;
        }).join('');
      }

      function renderConfigForm(config) {
        const modelBlocks = Object.entries(config.models || {}).map(([categoryName, category]) => {
          const disabledAttr = isReadOnly ? ' disabled' : '';
          const rows = [];
          rows.push('<div class="config-row"><label>' + escapeHtml(categoryName + '.upstream_mode') + '</label>' + upstreamModeSelect(categoryName, category.upstream_mode || '') + '</div>');
          rows.push('<div class="config-row"><label>' + escapeHtml(categoryName + '.base_url') + '</label><input class="wide" type="text" data-kind="cat-base" data-category="' + escapeHtml(categoryName) + '" value="' + escapeHtml(category.base_url || '') + '"' + disabledAttr + ' /></div>');

          Object.entries(category).forEach(([key, value]) => {
            if (key === 'upstream_mode' || key === 'base_url') return;
            rows.push(modelEntryRow(categoryName, key, value));
          });

          rows.push('<div class="section-actions"><button type="button" class="mini-btn" data-action="add-model" data-category="' + escapeHtml(categoryName) + '"' + (isReadOnly ? ' disabled' : '') + '>Add model entry</button></div>');

          return '<div class="config-block"><h3>models.' + escapeHtml(categoryName) + '</h3>' + rows.join('') + '</div>';
        }).join('');

        const compositeBlocks = Object.entries(config.composite || {}).map(([aliasName, targets]) => {
          const rows = compositeEntryRows(aliasName, targets, compositeLimitWindowsSnapshot[aliasName])
            + '<div class="section-actions"><button type="button" class="test-btn mini-btn" data-action="test-composite" data-alias="' + escapeHtml(aliasName) + '">test model</button>'
            + ' <button type="button" class="mini-btn" data-action="add-composite-target" data-alias="' + escapeHtml(aliasName) + '"' + (isReadOnly ? ' disabled' : '') + '>Add target</button>'
            + ' <button type="button" class="mini-btn danger" data-action="remove-composite-alias" data-alias="' + escapeHtml(aliasName) + '"' + (isReadOnly ? ' disabled' : '') + '>Remove alias</button></div>';
          const hasError = configErrorsList.some((e) => e.path === 'composite.' + aliasName);
          const errorMark = hasError ? ' <span style="color:#c62828;font-weight:bold;" title="Config error — see status bar">x</span>' : '';
          const aliasKeys = Object.keys(targets || {}).filter((k) => k !== 'token_limit' && k !== 'fusion_options');
          const isCoordHead = aliasKeys.some((k) => { const c = (targets || {})[k] || {}; return typeof c.coord === 'number' && c.coord > 0; });
          const isFusionHead = !isCoordHead && !!targets.fusion_options;
          const aliasTypeTag = isCoordHead ? ' <span style="font-size:11px;color:#555;"><b>Ö</b></span>' : isFusionHead ? ' <span style="font-size:11px;color:#555;"><b>ƒ</b></span>' : ' <span style="font-size:11px;color:#555;"><b>Ç</b></span>';
          return '<div class="config-block"><h3>composite.' + escapeHtml(aliasName) + aliasTypeTag + errorMark + '</h3>' + rows + '</div>';
        }).join('');

        const compositeGlobalActions = '<div class="section-actions"><button type="button" class="mini-btn" data-action="add-composite-alias"' + (isReadOnly ? ' disabled' : '') + '>Add composite alias</button></div>';

        const scheduleBlocks = Object.entries(config.schedule || {}).map(([aliasName, targets]) => {
          const rows = scheduleAliasRows(aliasName, targets);
          return '<div class="config-block"><h3>schedule.' + escapeHtml(aliasName) + '</h3>' + rows
            + '<div class="section-actions">'
            + '<button type="button" class="mini-btn" data-action="add-schedule-target" data-alias="' + escapeHtml(aliasName) + '"' + (isReadOnly ? ' disabled' : '') + '>Add target</button>'
            + ' <button type="button" class="mini-btn danger" data-action="remove-schedule-alias" data-alias="' + escapeHtml(aliasName) + '"' + (isReadOnly ? ' disabled' : '') + '>Remove alias</button>'
            + '</div></div>';
        }).join('');

        const scheduleGlobalActions = '<div class="section-actions"><button type="button" class="mini-btn" data-action="add-schedule-alias"' + (isReadOnly ? ' disabled' : '') + '>Add schedule alias</button></div>';

        const modelTargetGlobalActions = '<div class="section-actions"><button type="button" class="mini-btn" data-action="add-model-target"' + (isReadOnly ? ' disabled' : '') + '>Add target model</button></div>';

        configForm.innerHTML = modelTargetGlobalActions + modelBlocks
          + '<div class="config-divider"></div>' + compositeBlocks + compositeGlobalActions
          + '<div class="config-divider"></div>' + scheduleBlocks + scheduleGlobalActions;
      }

      function collectConfigPayload() {
        const payload = { models: {}, composite: {}, schedule: {} };

        Object.keys(currentConfig.models || {}).forEach((categoryName) => {
          payload.models[categoryName] = {};
        });

        document.querySelectorAll('[data-kind="cat-upstream"]').forEach((el) => {
          const category = el.dataset.category;
          payload.models[category].upstream_mode = el.value;
        });

        document.querySelectorAll('[data-kind="cat-base"]').forEach((el) => {
          const category = el.dataset.category;
          payload.models[category].base_url = el.value;
        });

        document.querySelectorAll('[data-kind="model-alias"]').forEach((el) => {
          const category = el.dataset.category;
          const key = el.dataset.key;
          const alias = el.value;
          const baseEl = document.querySelector('[data-kind="model-base"][data-category="' + category + '"][data-key="' + key + '"]');
          const base = baseEl ? baseEl.value : '';
          const modeEl = document.querySelector('[data-kind="model-mode"][data-category="' + category + '"][data-key="' + key + '"]');
          const mode = modeEl ? modeEl.value : '';
          // Backend validator accepts model entries as [target] (1 elem) or
          // [target, base_url, mode] (3 elems) — see isSafeModelArray /
          // TC1214. A bare 2-element array would be rejected as
          // "Invalid model entry for <category>.<key>". Index 2 carries the
          // per-model upstream_mode override ('' = inherit category).
          payload.models[category][key] = (base || mode) ? [alias, base, mode] : [alias];
        });

        Object.entries(currentConfig.composite || {}).forEach(([aliasName, targets]) => {
          payload.composite[aliasName] = {};
          const limitNumEl = document.querySelector('[data-kind="comp-limit-num"][data-alias="' + aliasName + '"]');
          const limitDurEl = document.querySelector('[data-kind="comp-limit-duration"][data-alias="' + aliasName + '"]');
          const numVal = limitNumEl ? limitNumEl.value.trim() : '';
          const durVal = limitDurEl ? limitDurEl.value.trim() : '';
          if (numVal !== '' && durVal !== '') {
            // Parse human-readable format: "50K", "1.5M", "100000" etc.
            const rawInput = numVal + ' ' + durVal;
            const parsed = parseHumanTokenLimit(rawInput);
            if (parsed) {
              payload.composite[aliasName].token_limit = parsed;
            }
          }

          // Collect fusion_options if present in DOM (fusion alias)
          const minPanelEl = document.querySelector('[data-kind="comp-fusion-min-panel"][data-alias="' + aliasName + '"]');
          if (minPanelEl !== null) {
            const fusionOpts = {};
            if (minPanelEl.value !== '') fusionOpts.min_panel = Number(minPanelEl.value);
            const timeoutEl = document.querySelector('[data-kind="comp-fusion-timeout"][data-alias="' + aliasName + '"]');
            if (timeoutEl && timeoutEl.value !== '') fusionOpts.panel_timeout_ms = Number(timeoutEl.value);
            const judgeReqEl = document.querySelector('[data-kind="comp-fusion-judge-req"][data-alias="' + aliasName + '"]');
            if (judgeReqEl && judgeReqEl.value !== '') fusionOpts.judge_required = judgeReqEl.value === 'true';
            const exposeMetaEl = document.querySelector('[data-kind="comp-fusion-expose-meta"][data-alias="' + aliasName + '"]');
            if (exposeMetaEl && exposeMetaEl.value !== '') fusionOpts.expose_metadata = exposeMetaEl.value === 'true';
            const maxConcEl = document.querySelector('[data-kind="comp-fusion-max-conc"][data-alias="' + aliasName + '"]');
            if (maxConcEl && maxConcEl.value !== '') fusionOpts.max_concurrent = Number(maxConcEl.value);
            if (Object.keys(fusionOpts).length > 0) {
              payload.composite[aliasName].fusion_options = fusionOpts;
            }
          }

          Object.keys(targets || {}).forEach((targetName) => {
            if (targetName === 'token_limit' || targetName === 'fusion_options') return;
            // Coordinator target fields
            const coordEl = document.querySelector('[data-kind="comp-coord"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
            if (coordEl !== null) {
              const entry = {};
              entry.coord = coordEl.value !== '' ? Number(coordEl.value) : 1;
              const coordRoleEl = document.querySelector('[data-kind="comp-coord-role"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
              if (coordRoleEl && coordRoleEl.value !== '') entry.role = coordRoleEl.value;
              payload.composite[aliasName][targetName] = entry;
              return;
            }
            // Fusion target fields
            const fusionEl = document.querySelector('[data-kind="comp-fusion"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
            if (fusionEl !== null) {
              const entry = {};
              if (fusionEl.value !== '') entry.fusion = Number(fusionEl.value);
              const roleEl = document.querySelector('[data-kind="comp-role"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
              if (roleEl && roleEl.value !== '') entry.role = roleEl.value;
              payload.composite[aliasName][targetName] = entry;
              return;
            }
            // Normal composite target fields
            const shareEl = document.querySelector('[data-kind="comp-share"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
            const routingEl = document.querySelector('[data-kind="comp-routing"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
            const fallbackEl = document.querySelector('[data-kind="comp-fallback"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
            const entry = {};
            if (shareEl && shareEl.value !== '') entry.share = Number(shareEl.value);
            const isPrimary = routingEl && routingEl.value === 'primary';
            if (isPrimary) {
              entry.primary = true;
            } else if (fallbackEl && fallbackEl.value !== '') {
              const fallbackValue = Number(fallbackEl.value);
              if (fallbackValue !== 0) entry.fallback = fallbackValue;
            }
            payload.composite[aliasName][targetName] = entry;
          });
        });

        Object.entries(currentConfig.schedule || {}).forEach(([aliasName, targets]) => {
          payload.schedule[aliasName] = {};
          Object.keys(targets || {}).forEach((targetName) => {
            if (targetName.startsWith('_')) return;
            const fromEls = document.querySelectorAll('[data-kind="sched-window-from"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
            const toEls = document.querySelectorAll('[data-kind="sched-window-to"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
            const daysEls = document.querySelectorAll('[data-kind="sched-window-days"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
            const count = fromEls.length;
            if (count === 0) {
              payload.schedule[aliasName][targetName] = [];
              return;
            }
            const windows = [];
            for (let i = 0; i < count; i++) {
              const fromVal = fromEls[i].value.trim();
              const toVal = toEls[i].value.trim();
              // days dropdown value is "", "weekday", or "weekend" — "" (Every day) omits the field.
              const daysVal = daysEls[i] ? daysEls[i].value.trim() : '';
              const entry = {};
              if (fromVal !== '') entry.from = Number(fromVal);
              if (toVal !== '') entry.to = Number(toVal);
              if (daysVal === 'weekday' || daysVal === 'weekend') {
                entry.days = daysVal;
              }
              windows.push(entry);
            }
            payload.schedule[aliasName][targetName] = windows;
          });
        });

        return payload;
      }

      function ensureCategory(categoryName) {
        if (!currentConfig.models[categoryName]) {
          currentConfig.models[categoryName] = { upstream_mode: '', base_url: '' };
        }
      }

      function onRoutingChange(aliasName, targetName, isPrimary) {
        // Show/hide fallback priority input based on routing type selection
        const fbEl = document.querySelector('[data-kind="comp-fallback"][data-alias="' + aliasName + '"][data-target="' + targetName + '"]');
        if (fbEl) fbEl.hidden = isPrimary;
      }

      let testResultClearTimer = null;

      function showTestResult(success, modelId, status, detail, usage) {
        const panel = document.getElementById('testResultPanel');
        if (testResultClearTimer) clearTimeout(testResultClearTimer);
        if (success) {
          panel.className = 'success';
          panel.innerHTML = '<button class="result-clear" onclick="clearTestResult()">✗</button>'
            + '<span class="result-model">✓ ' + escapeHtml(modelId) + '</span> '
            + '<span style="opacity:0.7">(' + status + ')</span>'
            + (usage ? ' <span class="result-usage">usage=' + escapeHtml(usage) + '</span>' : '')
            + (detail ? ' <span style="opacity:0.8">' + escapeHtml(detail) + '</span>' : '');
        } else {
          panel.className = 'error';
          panel.innerHTML = '<button class="result-clear" onclick="clearTestResult()">✗</button>'
            + '<span class="result-model">✗ ' + escapeHtml(modelId) + '</span> '
            + '<span style="opacity:0.7">(' + (status || '?') + ')</span>'
            + (detail ? ' — ' + escapeHtml(detail) : '');
        }
        panel.style.display = 'block';
        // Auto-clear after 20s
        testResultClearTimer = setTimeout(clearTestResult, 20000);
      }

      function clearTestResult() {
        const panel = document.getElementById('testResultPanel');
        panel.style.display = 'none';
        if (testResultClearTimer) { clearTimeout(testResultClearTimer); testResultClearTimer = null; }
      }

      async function testModel(modelId, btn) {
        const isCompositeBtn = document.querySelector('[data-action="test-composite"][data-alias="' + modelId + '"]') !== null;
        btn = btn || document.querySelector('[data-action="test-model"][data-model="' + modelId + '"]')
          || document.querySelector('[data-action="test-composite"][data-alias="' + modelId + '"]');
        if (btn) {
          btn.disabled = true;
          btn.className = 'test-btn mini-btn testing';
          btn.textContent = '…';
        }
        const panel = document.getElementById('testResultPanel');
        if (testResultClearTimer) clearTimeout(testResultClearTimer);
        panel.className = 'testing';
        panel.innerHTML = '<button class="result-clear" onclick="clearTestResult()">✗</button> Testing ' + escapeHtml(modelId) + '…';
        panel.style.display = 'block';

        try {
          const res = await dashboardFetch('/dashboard/api/test-model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ modelId }),
          });
          const result = await res.json();
          showTestResult(result.success, result.modelId, result.status, result.detail, result.usage);
        } catch (err) {
          showTestResult(false, modelId, null, err.message, null);
        } finally {
          if (btn) {
            btn.disabled = false;
            btn.className = 'test-btn mini-btn';
            btn.textContent = btn === testWildcardModelButton || isCompositeBtn ? 'test' : 't';
          }
        }
      }

      function testWildcardModel() {
        const modelId = wildcardModelInput.value.trim();
        if (!modelId) {
          wildcardTestStatus.textContent = 'Enter a model id';
          wildcardTestStatus.className = 'error';
          return;
        }
        wildcardTestStatus.textContent = '';
        wildcardTestStatus.className = '';
        void testModel(modelId, testWildcardModelButton);
      }

      function handleConfigAction(event) {
        const target = event.target;
        if (!target || !target.dataset) return;

        if (target.dataset.action === 'test-model') {
          void testModel(target.dataset.model);
          return;
        }
        if (target.dataset.action === 'test-composite') {
          void testModel(target.dataset.alias);
          return;
        }

        if (isReadOnly) {
          return;
        }

        if (target.dataset.kind === 'comp-routing') {
          onRoutingChange(target.dataset.alias, target.dataset.target, target.value === 'primary');
          return;
        }

        if (!target.dataset.action) return;

        currentConfig = collectConfigPayload();
        const action = target.dataset.action;

        if (action === 'add-model') {
          const category = target.dataset.category;
          if (!category) return;
          ensureCategory(category);
          // Mark dirty before opening the wizard so stats auto-reload is
          // paused while the user fills the modal.
          configDirty = true;
          openAddModelWizard(category);
          return;
        }

        if (action === 'add-model-target') {
          // Mark dirty before opening the wizard so stats auto-reload is
          // paused while the user fills the modal.
          configDirty = true;
          openAddModelTargetWizard();
          return;
        }

        if (action === 'remove-model') {
          const category = target.dataset.category;
          const key = target.dataset.key;
          if (!category || !key) return;
          if (!window.confirm('Remove models.' + category + '.' + key + '?')) return;
          delete currentConfig.models[category][key];
          renderConfigForm(currentConfig);
          saveConfig();
          return;
        }

        if (action === 'add-composite-alias') {
          // Mark dirty before opening the wizard so stats auto-reload is
          // paused while the user is filling in the modal.
          configDirty = true;
          openAddAliasWizard();
          return;
        }

        if (action === 'remove-composite-alias') {
          const alias = target.dataset.alias;
          if (!alias) return;
          if (!window.confirm('Remove composite.' + alias + '?')) return;
          delete currentConfig.composite[alias];
          renderConfigForm(currentConfig);
          saveConfig();
          return;
        }

        if (action === 'add-composite-target') {
          const alias = target.dataset.alias;
          if (!alias) return;
          // Mark dirty before opening the wizard so stats auto-reload is
          // paused while the user is filling in the modal.
          configDirty = true;
          openAddCompositeTargetWizard(alias);
          return;
        }

        if (target.dataset.kind === 'comp-limit-num' || target.dataset.kind === 'comp-limit-duration') {
          const alias = target.dataset.alias;
          if (!alias) return;
          const numEl = document.querySelector('[data-kind="comp-limit-num"][data-alias="' + alias + '"]');
          const durEl = document.querySelector('[data-kind="comp-limit-duration"][data-alias="' + alias + '"]');
          const numVal = numEl ? numEl.value.trim() : '';
          const durVal = durEl ? durEl.value.trim() : '';
          if (numVal === '' || durVal === '') {
            delete currentConfig.composite[alias].token_limit;
          } else {
            const rawInput = numVal + ' ' + durVal;
            const parsed = parseHumanTokenLimit(rawInput);
            if (!parsed) {
              window.alert('Invalid token limit. Use: <num[K|M|B|T]> <1h|1d|1w|1m>  (e.g. 50K 1d, 1.5M 1h)');
              return;
            }
            currentConfig.composite[alias].token_limit = parsed;
          }
          renderConfigForm(currentConfig);
          saveConfig();
          return;
        }

        if (action === 'remove-composite-target') {
          const alias = target.dataset.alias;
          const targetModel = target.dataset.target;
          if (!alias || !targetModel) return;
          if (!window.confirm('Remove composite target ' + alias + ' -> ' + targetModel + '?')) return;
          if (currentConfig.composite[alias]) {
            delete currentConfig.composite[alias][targetModel];
          }
          renderConfigForm(currentConfig);
          saveConfig();
          return;
        }

        if (action === 'add-schedule-alias') {
          // Mark dirty before opening the wizard so the config auto-reload
          // timer is paused while the user fills the modal.
          configDirty = true;
          openAddScheduleAliasWizard();
          return;
        }

        if (action === 'remove-schedule-alias') {
          const alias = target.dataset.alias;
          if (!alias) return;
          if (!window.confirm('Remove schedule.' + alias + '?')) return;
          delete currentConfig.schedule[alias];
          renderConfigForm(currentConfig);
          saveConfig();
          return;
        }

        if (action === 'add-schedule-target') {
          const alias = target.dataset.alias;
          if (!alias) return;
          configDirty = true;
          openAddScheduleTargetWizard(alias);
          return;
        }

        if (action === 'remove-schedule-target') {
          const alias = target.dataset.alias;
          const targetModel = target.dataset.target;
          if (!alias || !targetModel) return;
          if (!window.confirm('Remove schedule target ' + alias + ' -> ' + targetModel + '?')) return;
          if (currentConfig.schedule[alias]) {
            delete currentConfig.schedule[alias][targetModel];
          }
          renderConfigForm(currentConfig);
          saveConfig();
          return;
        }

        if (action === 'add-schedule-window') {
          const alias = target.dataset.alias;
          const targetModel = target.dataset.target;
          if (!alias || !targetModel) return;
          const windows = currentConfig.schedule[alias]?.[targetModel];
          if (!Array.isArray(windows)) {
            currentConfig.schedule[alias][targetModel] = [];
          }
          currentConfig.schedule[alias][targetModel].push({ from: 0, to: 24 });
          renderConfigForm(currentConfig);
          saveConfig();
          return;
        }

        if (action === 'remove-schedule-window') {
          const alias = target.dataset.alias;
          const targetModel = target.dataset.target;
          const idx = Number(target.dataset.index);
          if (!alias || !targetModel || isNaN(idx)) return;
          const windows = currentConfig.schedule[alias]?.[targetModel];
          if (Array.isArray(windows) && idx >= 0 && idx < windows.length) {
            windows.splice(idx, 1);
            currentConfig.schedule[alias][targetModel] = windows;
          }
          renderConfigForm(currentConfig);
          saveConfig();
          return;
        }
      }

      async function loadConfig(forceReload) {
        configStatus.textContent = 'Loading...';
        const res = await dashboardFetch(forceReload === true ? '/dashboard/api/config?reload=1' : '/dashboard/api/config');
        const json = await res.json();
        isReadOnly = json.config.read_only === true;
        const keyStoreLock = document.getElementById('keyStoreLock');
        if (keyStoreLock) keyStoreLock.hidden = json.config.api_keys_in_system_store !== true;
        currentConfig = {
          models: json.config.models || {},
          composite: json.config.composite || {},
          schedule: json.config.schedule || {},
        };
        compositeResolved = json.compositeResolved || [];
        modelStats = json.modelStats || [];
        compositeLimitWindowsSnapshot = json.compositeLimitWindows || {};
        configErrorsList = json.config.config_errors || [];
        const glRaw = (json.config.global_token_limit || '').trim();
        const glParts = glRaw ? glRaw.split(' ') : []; // ' ' is better than /\s+/
        globalTokenLimitNum.value = glParts[0] || '';
        globalTokenLimitDuration.value = (glParts[1] || '').toLowerCase();
        renderConfigForm(currentConfig);
        renderWildcardRouteHint(currentConfig);
        saveButton.disabled = isReadOnly;
        configPathHint = json.config.config_path ? ' (' + json.config.config_path + ')' : '';

        // Display config validation errors/warnings
        const configErrors = json.config.config_errors || [];
        const configWarnings = json.config.config_warnings || [];
        if (configErrors.length > 0) {
          const errorList = configErrors.map((e) => e.path + ': ' + e.message).join('; ');
          configStatus.innerHTML = '<span style="color:#c62828;">Config errors: ' + escapeHtml(errorList) + '</span>';
          configStatus.className = 'error';
        } else if (configWarnings.length > 0) {
          const warnList = configWarnings.map((e) => e.path + ': ' + e.message).join('; ');
          configStatus.innerHTML = '<span style="color:#e65100;">Config warnings: ' + escapeHtml(warnList) + '</span>';
          configStatus.className = '';
        } else if (isReadOnly) {
          configStatus.textContent = 'Loaded (read-only: remote)' + configPathHint;
          configStatus.className = '';
        } else {
          configStatus.textContent = 'Loaded' + configPathHint;
          configStatus.className = '';
        }
        // Form is now in sync with the backend — local mutation has been
        // (or is about to be) saved, so resume stats auto-reload.
        configDirty = false;
      }

      async function saveConfig() {
        if (isReadOnly) {
          configStatus.textContent = 'Read-only mode: config source is PROXY_CONFIG_CONSUL or PROXY_CONFIG_APOLLO';
          return;
        }

        configStatus.textContent = 'Saving...';
        try {
          const parsed = collectConfigPayload();
          const res = await dashboardFetch('/dashboard/api/config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed)
          });
          const result = await res.json();
          if (!res.ok) {
            throw new Error(result.error || 'Save failed');
          }
          await loadConfig();
          configStatus.textContent = 'Saved' + configPathHint;
        } catch (err) {
          configStatus.textContent = 'Error: ' + err.message;
        }
      }

      function renderRows(tableId, rows, mapper) {
        const tbody = document.querySelector(tableId + ' tbody');
        tbody.innerHTML = rows.map(mapper).join('');
      }

      // Usage-left cells for the Upstream Base URL table. Client-side cache
      // (60s) keeps the 10s stats re-render from re-hammering the quota
      // endpoint; the server-side 30s quota cache bounds provider load.
      const quotaCellCache = new Map();
      async function fillQuotaCells() {
        document.querySelectorAll('.quota-cell').forEach(async (cell) => {
          const base = decodeURIComponent(cell.dataset.base);
          let cached = quotaCellCache.get(base);
          if (!cached || Date.now() - cached.at > 60000) {
            let text = '—';
            try {
              const res = await dashboardFetch('/dashboard/api/quota?base_url=' + encodeURIComponent(base));
              const json = await res.json();
              if (res.ok && json.left) text = json.left;
              else if (!res.ok && json.kind && json.kind !== 'unsupported' && json.kind !== 'unconfigured') text = '⚠ ' + (json.kind || '');
            } catch (e) { /* leave '—' */ }
            cached = { text, at: Date.now() };
            quotaCellCache.set(base, cached);
          }
          cell.textContent = cached.text;
        });
      }

      async function loadModelStats() {
        const modelsRes = await dashboardFetch('/dashboard/api/stats/models');
        const modelsJson = await modelsRes.json();
        const reqRes = await dashboardFetch('/dashboard/api/stats/requests');
        const reqJson = await reqRes.json();
        const timingMap = {};
        for (const t of (reqJson.model_timings || [])) {
          timingMap[t.endpoint] = t;
        }
        renderModelRows(modelsJson.data || [], (row) => {
          const timing = timingMap[row.model];
          const minS = timing ? (timing.min_time_ms / 1000).toFixed(2) : '-';
          const avgS = timing ? (timing.avg_time_ms / 1000).toFixed(2) : '-';
          const maxS = timing ? (timing.max_time_ms / 1000).toFixed(2) : '-';
          return '<tr><td>' + (row.model.split('/').pop() || row.model) + '</td><td class="num">' + fmtStat(row.requests) + '</td><td class="num">' + fmtStat(row.failed_requests || 0) + '</td><td class="num">' + fmtStat(row.input_tokens) + '</td><td class="num">' + fmtStat(row.cached_tokens) + '</td><td class="num">' + fmtStat(row.cache_written_tokens) + '</td><td class="num">' + fmtStat(row.output_tokens) + '</td><td class="num">' + fmtStat(row.total_tokens) + '</td><td class="num">' + minS + '</td><td class="num">' + avgS + '</td><td class="num">' + maxS + '</td></tr>';
        });
      }

      let modelStatsExpanded = false;

      function renderModelRows(data, mapper) {
        const tbody = document.querySelector('#modelStats tbody');
        const rows = modelStatsExpanded ? data : data.slice(0, 10);
        tbody.innerHTML = rows.map(mapper).join('');
        const btn = document.getElementById('toggleModelStats');
        if (data.length > 10) {
          btn.style.display = 'inline-block';
          btn.textContent = modelStatsExpanded ? 'Collapse' : 'Show all (' + data.length + ')';
        } else {
          btn.style.display = 'none';
        }
      }

      let toolStatsExpanded = false;

      function fmtStat(n) {
        if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + 'B';
        if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
        if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
        return String(n);
      }

      function renderToolRows(data, blocked) {
        const tbody = document.querySelector('#toolStats tbody');
        const rows = toolStatsExpanded ? data : data.slice(0, 10);
        const blockedSet = new Set(blocked || []);
        tbody.innerHTML = rows.map((row) => {
          const isBlocked = blockedSet.has(row.tool_name);
          const status = isBlocked ? '✗' : '·';
          const statusCls = isBlocked ? 'status-blocked' : '';
          const rowCls = isBlocked ? 'tool-row blocked' : 'tool-row';
          const actionLabel = isBlocked ? 'Unblock' : 'Block';
          const actionCls = isBlocked ? 'block-btn unblock' : 'block-btn block';
          return '<tr class="' + rowCls + '">'
            + '<td class="' + statusCls + '">' + status + '</td>'
            + '<td>' + escapeHtml(row.tool_name) + '</td>'
            + '<td>' + escapeHtml(row.agent) + '</td>'
            + '<td class="num">' + fmtStat(row.in_requests) + '</td>'
            + '<td class="num">' + fmtStat(row.in_responses) + '</td>'
            + '<td class="num">' + fmtStat(row.in_request_chars || 0) + '</td>'
            + '<td><button type="button" class="' + actionCls + '" data-action="toggle-tool-block" data-tool="' + escapeHtml(row.tool_name) + '" data-blocked="' + (isBlocked ? '1' : '0') + '">' + actionLabel + '</button></td>'
            + '</tr>';
        }).join('');
        const btn = document.getElementById('toggleToolStats');
        if (data.length > 10) {
          btn.style.display = 'inline-block';
          btn.textContent = toolStatsExpanded ? 'Collapse' : 'Show all (' + data.length + ')';
        } else {
          btn.style.display = 'none';
        }
      }

      async function loadToolStats() {
        const res = await dashboardFetch('/dashboard/api/tools/blocklist');
        const json = await res.json();
        renderToolRows(json.rows || [], json.blockedTools || []);
      }

      async function toggleToolBlock(toolName, currentlyBlocked) {
        try {
          const res = await dashboardFetch('/dashboard/api/tools/toggle-block', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool_name: toolName, blocked: !currentlyBlocked })
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error || 'Failed');
          await loadToolStats();
        } catch (err) {
          window.alert('Toggle failed: ' + err.message);
        }
      }

      document.querySelector('#toolStats').addEventListener('click', (e) => {
        const target = e.target;
        if (target && target.dataset && target.dataset.action === 'toggle-tool-block') {
          void toggleToolBlock(target.dataset.tool, target.dataset.blocked === '1');
        }
      });

      document.getElementById('toggleToolStats').addEventListener('click', () => {
        toolStatsExpanded = !toolStatsExpanded;
        loadToolStats();
      });

      document.getElementById('toggleModelStats').addEventListener('click', () => {
        modelStatsExpanded = !modelStatsExpanded;
        loadModelStats();
      });

      document.getElementById('exportModelStatsCsv').addEventListener('click', () => {
        const rows = [
          ['Model', 'Requests', 'Failed', 'Input Tokens', 'Cached Tokens', 'Cache Written', 'Output Tokens', 'Total Tokens', 'min(s)', 'avg(s)', 'max(s)']
        ];
        document.querySelectorAll('#modelStats tbody tr').forEach((tr) => {
          const cols = [];
          tr.querySelectorAll('td').forEach((td) => cols.push(td.textContent.trim()));
          if (cols.length > 0) rows.push(cols);
        });
        const bom = '\\uFEFF';
        const csv = rows.map((r) => r.map((c) => '"' + c.replace(/"/g, '""') + '"').join(',')).join('\\n');
        const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const now = new Date();
        const ts = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0') + '_' + String(now.getHours()).padStart(2, '0') + '-' + String(now.getMinutes()).padStart(2, '0') + '-' + String(now.getSeconds()).padStart(2, '0');
        a.download = 'model_stats_' + ts + '.csv';
        a.click();
        URL.revokeObjectURL(url);
      });

      async function loadRequestStats() {
        const res = await dashboardFetch('/dashboard/api/stats/requests');
        const json = await res.json();

        const privacyEl = document.getElementById('privacyKeysDetected');
        if (privacyEl) privacyEl.textContent = fmtStat(json.privacy_keys_detected || 0);

        renderRows('#requestUpstreamStats', json.upstreams || [], (row) =>
          '<tr><td>' + row.upstream_base_url + '</td><td class="num quota-cell" data-base="' + encodeURIComponent(row.upstream_base_url) + '">…</td><td class="num">' + row.responses + '</td></tr>'
        );
        fillQuotaCells();

        renderRows('#requestStatusCodeFromUpstreamStats', json.status_codes_from_upstreams || [], (row) =>
          '<tr><td>' + row.status_code + '</td><td class="num">' + row.responses + '</td></tr>'
        );

        renderRows('#requestStatusCodeToEndpointStats', json.status_codes_to_endpoints || [], (row) =>
          '<tr><td>' + row.status_code + '</td><td class="num">' + row.responses + '</td></tr>'
        );

        const endpointReqs = {};
        for (const ep of json.endpoints || []) {
          endpointReqs[ep.endpoint] = ep.requests;
        }
        renderRows('#requestEndpointTimingStats', json.endpoint_timings || [], (row) =>
          '<tr><td>' + row.endpoint + '</td><td class="num">' + fmtStat(endpointReqs[row.endpoint] || 0) + '</td><td class="num">' + ((row.min_time_ms || 0) / 1000).toFixed(2) + '</td><td class="num">' + ((row.avg_time_ms || 0) / 1000).toFixed(2) + '</td><td class="num">' + ((row.max_time_ms || 0) / 1000).toFixed(2) + '</td></tr>'
        );
      }

      document.getElementById('reloadConfig').addEventListener('click', () => loadConfig(true));
      document.getElementById('saveConfig').addEventListener('click', saveConfig);

      async function saveGlobalLimit() {
        const num = globalTokenLimitNum.value.trim();
        const dur = globalTokenLimitDuration.value;
        if (num && !dur) {
          globalLimitStatus.textContent = 'Select a duration';
          return;
        }
        const value = (num && dur) ? num + ' ' + dur : '';
        globalLimitStatus.textContent = 'Saving...';
        try {
          const res = await dashboardFetch('/dashboard/api/global-token-limit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value })
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error || 'Failed');
          globalLimitStatus.textContent = value ? 'Set' : 'Cleared';
          setTimeout(() => { globalLimitStatus.textContent = ''; }, 2000);
        } catch (err) {
          globalLimitStatus.textContent = 'Error: ' + err.message;
        }
      }

      document.getElementById('saveGlobalLimit').addEventListener('click', saveGlobalLimit);
      globalTokenLimitNum.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveGlobalLimit(); });
      testWildcardModelButton.addEventListener('click', testWildcardModel);
      wildcardModelInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') testWildcardModel(); });
      configForm.addEventListener('click', handleConfigAction);

      async function refreshAll() {
        await loadConfig();
        await loadModelStats();
        await loadRequestStats();
        await loadToolStats();
      }

      refreshAll();
      setInterval(() => {
        // Skip stats auto-reload while a config mutation is being saved —
        // otherwise the in-flight change can be clobbered by re-rendering
        // around it. Resumes on the next loadConfig() tick.
        if (configDirty) return;
        loadModelStats();
        loadRequestStats();
        loadToolStats();
      }, 10000);

      setInterval(() => {
        // Skip config auto-reload while a config mutation is in progress
        // (dirty flag is set when a wizard / prompt is open) so the wizard
        // DOM is not torn down by a concurrent re-render.
        if (configDirty) return;
        loadConfig();
      }, 30000);

      // Scroll spy for side nav
      const sections = ['section-config', 'section-model', 'section-request', 'section-agent'];
      const navLinks = document.querySelectorAll('.side-nav a');
      const observer = new IntersectionObserver((entries) => {
        let activeId = '';
        for (const entry of entries) {
          if (entry.isIntersecting) activeId = entry.target.id;
        }
        navLinks.forEach((a) => {
          a.classList.toggle('active', a.getAttribute('href') === '#' + activeId);
        });
      }, { rootMargin: '-20% 0px -70% 0px' });
      sections.forEach((id) => observer.observe(document.getElementById(id)));
    </script>
  </body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
    },
  });
}

export function handleDashboardGetConfig(proxyConfig: ProxyConfig, env: Env): Response {
  // Return the full snapshot so the dashboard has modelStats and compositeResolved
  // for computing live token usage alongside config editing.
  try {
    return jsonResponse(getDashboardSnapshot(proxyConfig, env));
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 500);
  }
}

export async function handleDashboardPutConfig(request: Request, env: Env, _proxyConfig: ProxyConfig): Promise<Response> {
  try {
    const payload = await request.json();
    const configPath = getConfigPathForWrite(env);

    const baseConfig = loadProxyConfigFromPath(configPath);
    const nextConfig = applyDashboardConfigUpdate(baseConfig, payload);

    // Reject invalid config before it is persisted — an invalid model entry or
    // composite target would otherwise be written to disk and silently degrade
    // the live config on the next reload.
    const validation = validateProxyConfig(nextConfig);
    if (!validation.valid) {
      // Surface the first fatal error's path + message in `error` so the
      // dashboard status bar shows the specific reason (e.g. which alias
      // name collides with a model) instead of the generic "Invalid config".
      const first = validation.errors[0];
      const firstMessage = first ? `${first.path}: ${first.message}` : 'Invalid config';
      return jsonResponse({
        error: firstMessage,
        config_errors: validation.errors,
      }, 400);
    }

    persistProxyConfigToPath(configPath, nextConfig);
    clearProxyConfigCache();

    const reloadedConfig = await loadProxyConfig(env);
    return jsonResponse(getDashboardSnapshot(reloadedConfig, env));
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 400);
  }
}

export async function handleDashboardGlobalTokenLimit(request: Request, env: Env): Promise<Response> {
  try {
    const { value } = await request.json() as { value: string };
    upsertGlobalTokenLimitFromDashboard(env, value ?? null);
    return jsonResponse({ ok: true });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 400);
  }
}

export function handleDashboardModelStats(): Response {
  return jsonResponse({ data: getModelStatsDesc() });
}

export function handleDashboardAgentStats(): Response {
  return jsonResponse({ data: getToolUsageStatsDesc() });
}

export function handleDashboardToolBlocklist(): Response {
  return jsonResponse({
    rows: getAgentToolPanelStats(),
    blockedTools: [...getBlockedTools()],
  });
}

export async function handleDashboardToggleToolBlock(request: Request): Promise<Response> {
  try {
    const body = await request.json() as { tool_name?: unknown; blocked?: unknown };
    const tool_name = typeof body.tool_name === 'string' ? body.tool_name.trim() : '';
    const blocked = body.blocked === true;
    if (!tool_name) {
      return jsonResponse({ error: 'tool_name is required' }, 400);
    }
    if (blocked) {
      blockTool(tool_name);
    } else {
      unblockTool(tool_name);
    }
    return jsonResponse({ ok: true, tool_name, blocked });
  } catch (error) {
    return jsonResponse({ error: (error as Error).message }, 400);
  }
}

export function handleDashboardRequestStats(): Response {
  return jsonResponse({
    endpoints: getRequestEndpointStatsDesc(),
    upstreams: getRequestUpstreamStatsDesc(),
    upstream_response_tools: getUpstreamResponseToolStatsDesc(),
    status_codes_from_upstreams: getRequestStatusCodeFromUpstreamStatsDesc(),
    status_codes_to_endpoints: getRequestStatusCodeToEndpointStatsDesc(),
    endpoint_timings: getRequestEndpointTimingStatsDesc(),
    model_timings: getRequestModelTimingStatsDesc(),
    privacy_keys_detected: getPrivacyKeysDetected(),
  });
}

// Test model constants (mirrored from tui.ts)
const TEST_MODEL_ENDPOINT = '/v1/messages';
const TEST_TOOL_NAME = 'test_tool';
const TEST_TOOL_DESCRIPTION = 'test tool';
const TEST_TOOL_PROMPT = 'Use the test_tool and say hi.';
const TEST_TOOL_SCHEMA = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
  additionalProperties: false,
};

function buildTestToolRequest(upstreamMode: string): Record<string, unknown> {
  const openaiToolBody = {
    messages: [{ role: 'user', content: TEST_TOOL_PROMPT }],
    max_tokens: 128,
    tools: [{
      type: 'function',
      function: {
        name: TEST_TOOL_NAME,
        description: TEST_TOOL_DESCRIPTION,
        parameters: TEST_TOOL_SCHEMA,
      },
    }],
    tool_choice: 'auto',
  };

  if (upstreamMode === 'openai-completions' ||
      upstreamMode === 'openai-responses' ||
      upstreamMode === 'gemini-generatecontent' ||
      upstreamMode === 'gemini-interactions') {
    return openaiToolBody;
  }

  return {
    messages: [{ role: 'user', content: TEST_TOOL_PROMPT }],
    max_tokens: 128,
    tools: [{ name: TEST_TOOL_NAME, description: TEST_TOOL_DESCRIPTION, input_schema: TEST_TOOL_SCHEMA }],
    tool_choice: { type: 'tool', name: TEST_TOOL_NAME },
  };
}

function extractTestResultDetail(responseBody: unknown): string {
  if (!responseBody || typeof responseBody !== 'object') return String(responseBody);
  const record = responseBody as Record<string, unknown>;
  const lines: string[] = [];

  // Extract error
  const error = record.error;
  if (error) {
    if (typeof error === 'string') lines.push(`error: ${error.trim()}`);
    else if (typeof error === 'object') {
      const e = error as Record<string, unknown>;
      if (typeof e.message === 'string' && e.message.trim()) lines.push(`error: ${e.message.trim()}`);
      else if (typeof e.type === 'string' && e.type.trim()) lines.push(`error: ${e.type.trim()}`);
    }
  }

  // Extract text content
  const content = record.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === 'object') {
        const b = block as Record<string, unknown>;
        if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
          lines.push(`msg: ${b.text.trim().slice(0, 120)}`);
        }
        if (b.type === 'tool_use' && typeof b.name === 'string') {
          const input = b.input !== undefined ? compact(b.input) : '';
          lines.push(`tool: ${b.name} ${input}`);
        }
      }
    }
  }

  // OpenAI tool_calls format
  const toolCalls = record.tool_calls;
  if (Array.isArray(toolCalls)) {
    for (const call of toolCalls) {
      if (call && typeof call === 'object') {
        const c = call as Record<string, unknown>;
        const fn = c.function as Record<string, unknown> | undefined;
        const name = fn && typeof fn.name === 'string' ? fn.name : (typeof c.name === 'string' ? c.name : 'tool');
        const args = fn && fn.arguments !== undefined ? compact(fn.arguments) : (c.arguments !== undefined ? compact(c.arguments) : '');
        lines.push(`tool: ${name} ${args}`);
      }
    }
  }

  // OpenAI outputs format
  const outputs = record.outputs;
  if (Array.isArray(outputs)) {
    for (const output of outputs) {
      if (output && typeof output === 'object') {
        const o = output as Record<string, unknown>;
        if (o.type === 'function_call') {
          const name = typeof o.name === 'string' ? o.name : 'tool';
          const args = o.arguments !== undefined ? compact(o.arguments) : '';
          lines.push(`tool: ${name} ${args}`);
        }
      }
    }
  }

  if (lines.length === 0) {
    // Fallback: output_text
    if (typeof record.output_text === 'string' && record.output_text.trim()) {
      lines.push(`msg: ${record.output_text.trim().slice(0, 120)}`);
    }
  }

  return lines.length > 0 ? lines.join(' | ') : JSON.stringify(responseBody).slice(0, 120);
}

function compact(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 80 ? `${text.slice(0, 80)}…` : text;
  } catch {
    return String(value);
  }
}

/**
 * GET /dashboard/api/quota?model=<id>  |  ?base_url=<origin>
 *
 * Resolves the model's route (targetUrl + api_key from the unsanitized
 * config), detects the provider from the route host and returns the
 * remaining usage / credits as JSON. Supported providers: minimax
 * (api.minimaxi.com / api.minimax.io), deepseek, kimi, openrouter, zhipu.
 *
 * `base_url=<origin>` variant (matching the stats table's
 * `upstream_base_url` values): finds the first configured route on that
 * origin, uses its api_key, and falls back to the passively recorded
 * anthropic 5h utilization when the origin has no usage provider. The
 * `model=<id>` variant applies the same fallback, looked up under the
 * upstream model name (route.modelAlias) — the key the header recording
 * uses. All success responses include a preformatted `left` string for
 * display.
 */
export async function handleDashboardModelQuota(
  request: Request,
  proxyConfig: ProxyConfig,
): Promise<Response> {
  const params = new URL(request.url).searchParams;
  const modelId = params.get('model');
  const baseUrl = params.get('base_url');
  try {
    if (modelId) {
      const route = getModelRouteConfig(modelId, proxyConfig);
      const result = await getModelQuota(route);
      if (!result.ok && result.kind === 'unsupported') {
        // Anthropic-compatible origins have no usage endpoint; fall back to
        // the 5h utilization recorded from proxied response headers (keyed by
        // the upstream model name, e.g. codelite → code-lite-pi).
        const headerLeft = getUpstreamRateLimitLeft(route.modelAlias || modelId);
        if (headerLeft) {
          return jsonResponse({
            ok: true, provider: 'anthropic-5h', source: 'response-header',
            left: headerLeft, fetchedAt: Date.now(),
          }, 200);
        }
      }
      return quotaResponse(result, formatQuotaLeft(result));
    }
    if (baseUrl) {
      // Find the first configured route whose target URL lives on this
      // origin and reuse its api_key (the stats table only records origins).
      let apiKey: string | undefined;
      for (const id of getConfiguredModelIds(proxyConfig)) {
        const route = getModelRouteConfig(id, proxyConfig);
        if (originOf(route.targetUrl) === baseUrl) {
          apiKey = route.apiKey;
          break;
        }
      }
      const result = await getModelQuota({ targetUrl: baseUrl, apiKey });
      if (!result.ok && result.kind === 'unsupported') {
        // Anthropic-compatible origins have no usage endpoint; fall back to
        // the 5h utilization recorded from proxied response headers.
        const headerLeft = getUpstreamRateLimitLeftForUrl(baseUrl);
        if (headerLeft) {
          return jsonResponse({
            ok: true, provider: 'anthropic-5h', source: 'response-header',
            left: headerLeft, fetchedAt: Date.now(),
          }, 200);
        }
      }
      return quotaResponse(result, formatQuotaLeft(result));
    }
    return jsonResponse({ error: 'model or base_url query parameter is required' }, 400);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 500);
  }
}

function quotaResponse(result: QuotaResult, left: string | null): Response {
  const status = result.ok ? 200
    : result.kind === 'unconfigured' || result.kind === 'unsupported' ? 404
    : 502;
  return jsonResponse(left != null ? { ...result, left } : result, status);
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export async function handleDashboardTestModel(
  request: Request,
  env: Env,
  proxyConfig: ProxyConfig,
): Promise<Response> {
  try {
    const { modelId } = await request.json() as { modelId: string };

    if (!modelId) {
      return jsonResponse({ error: 'modelId is required' }, 400);
    }

    const snapshot = getDashboardSnapshot(proxyConfig, env);

    // Resolve config for this model
    let upstreamMode = 'openai-completions';
    let testApiKey: string | undefined;

    // Check composite aliases first
    const alias = snapshot.compositeResolved.find((a) => a.alias === modelId);
    if (alias && alias.targets.length > 0) {
      upstreamMode = alias.targets[0].upstreamMode;
      // Composite aliases don't expose a per-target API key in the snapshot;
      // fall back to the proxy-wide default. The proxy's auth check just
      // needs any non-empty value, and this same key is what the upstream
      // call will use.
      testApiKey = proxyConfig.default_upstream?.default_api_key;
    } else {
      // Use getModelRouteConfig to correctly resolve the per-model mode (e.g. mode = "anthropic-messages"
      // on an entry inside models.free which has upstream_mode = "openai-completions").
      const route = getModelRouteConfig(modelId, proxyConfig);
      upstreamMode = route.upstreamMode;
      testApiKey = route.apiKey || proxyConfig.default_upstream?.default_api_key;
    }

    const requestBody = buildTestToolRequest(upstreamMode);
    const fullRequestBody = { ...requestBody, model: modelId };

    const port = env.PORT || '8788';
    const endpoint = `http://127.0.0.1:${port}${TEST_MODEL_ENDPOINT}`;

    // Build auth headers for the local /v1/messages call.
    // The proxy requires at least one of Authorization/x-api-key/x-goog-api-key
    // (see src/index.ts auth check), and the same header is forwarded upstream,
    // so we reuse the model's configured key, formatted per upstream mode:
    //   anthropic-messages  -> x-api-key: <key>
    //   openai-completions  -> Authorization: Bearer <key>
    //   gemini-*            -> x-goog-api-key: <key>
    const authHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (testApiKey) {
      Object.assign(authHeaders, formatApiKeyForUpstream(testApiKey, upstreamMode));
    } else {
      // No key configured anywhere: still send a placeholder so the local
      // auth check passes and the request reaches the upstream. The upstream
      // call will then fail with its own 401, which is a clearer signal than
      // a generic local 401.
      Object.assign(authHeaders, formatApiKeyForUpstream('unconfigured-test-key', upstreamMode));
      console.warn(`[dashboard-test-model] No API key configured for "${modelId}" or upstream.default_api_key; using placeholder.`);
    }

    // Debug log test request/response to /tmp/test_model.log (LOG_LEVEL=debug)
    if (env.LOG_LEVEL === 'debug') {
      try {
        const fs = await import('fs');
        fs.writeFileSync('/tmp/test_model.log',
          `[${new Date().toISOString()}] test model request\n` +
          `target: ${endpoint}\n` +
          `upstreamMode: ${upstreamMode}\n` +
          `modelId: ${modelId}\n` +
          `request body:\n${JSON.stringify(fullRequestBody, null, 2)}\n`,
        );
      } catch (_e) { /* ignore */ }
    }

    const testResponse = await fetch(endpoint, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify(fullRequestBody),
    });

    const contentType = testResponse.headers.get('content-type') || '';
    const responseBody = contentType.includes('application/json')
      ? await testResponse.json()
      : await testResponse.text();

    // Append response to debug log (LOG_LEVEL=debug)
    if (env.LOG_LEVEL === 'debug') {
      try {
        const fs = await import('fs');
        const responseText = typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody, null, 2);
        fs.appendFileSync('/tmp/test_model.log',
          `response status: ${testResponse.status}\n` +
          `response body:\n${responseText}\n` +
          `---\n`,
        );
      } catch (_e) { /* ignore */ }
    }

    const usage = typeof responseBody === 'object' && responseBody !== null && 'usage' in responseBody
      ? JSON.stringify((responseBody as Record<string, unknown>).usage ?? {})
      : null;
    const detail = extractTestResultDetail(responseBody);

    if (!testResponse.ok) {
      return jsonResponse({
        success: false,
        modelId,
        status: testResponse.status,
        detail,
        usage,
      });
    }

    return jsonResponse({
      success: true,
      modelId,
      status: testResponse.status,
      detail,
      usage,
    });
  } catch (err) {
    return jsonResponse({ success: false, modelId: '?', error: (err as Error).message }, 500);
  }
}
