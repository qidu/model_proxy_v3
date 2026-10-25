import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  getDashboardSnapshot,
  getModelTargetFromDashboard,
  handleDashboardAddScheduleAlias,
  handleDashboardGlobalTokenLimit,
  handleDashboardPutConfig,
  handleDashboardUpsertModelTarget,
  handleDashboardUpsertScheduleTarget,
  type DashboardSnapshot,
} from '../../src/handlers/dashboard.js';
import type { Env } from '../../src/types/shared.js';
import {
  clearProxyConfigCache,
  loadProxyConfigFromPath,
  type ProxyConfig,
} from '../../src/utils/config-loader.js';

const CONFIG_TOML = `
[models.free]
upstream_mode = "openai-completions"
base_url = "https://category.example/v1"
api_key = "category-secret"
alpha = ["vendor/alpha", "https://alpha.example/v1", "model-secret", "openai-responses"]
`;

let tempDir = '';
let configPath = '';
let proxyConfig: ProxyConfig;

function env(extra: Partial<Env> = {}): Env {
  return { PROXY_CONFIG_PATH: configPath, LOG_LEVEL: 'error', ...extra };
}

function putRequest(payload: unknown): Request {
  return new Request('http://localhost/dashboard/api/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function mutationRequest(payload: unknown): Request {
  return new Request('http://localhost/dashboard/api/mutation', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

function dashboardModelsPayload() {
  return {
    models: {
      free: {
        upstream_mode: 'openai-completions',
        base_url: 'https://category.example/v1',
        alpha: ['vendor/alpha', 'https://alpha.example/v1', 'openai-responses'],
      },
    },
    composite: {},
    schedule: {},
  };
}

beforeEach(() => {
  clearProxyConfigCache();
  tempDir = mkdtempSync(join(tmpdir(), 'mpv3-dashboard-config-'));
  configPath = join(tempDir, 'proxy_config.toml');
  writeFileSync(configPath, CONFIG_TOML, 'utf8');
  proxyConfig = loadProxyConfigFromPath(configPath);
});

afterEach(() => {
  clearProxyConfigCache();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('dashboard config reads', () => {
  it('sanitizes model keys and reports writable local config state', () => {
    const snapshot = getDashboardSnapshot(proxyConfig, env());

    assert.equal(snapshot.config.read_only, false);
    assert.equal(snapshot.config.config_path, configPath);
    assert.deepEqual(snapshot.config.models.free, {
      upstream_mode: 'openai-completions',
      base_url: 'https://category.example/v1',
      alpha: ['vendor/alpha', 'https://alpha.example/v1', 'openai-responses'],
    });
    assert.equal(JSON.stringify(snapshot.config).includes('category-secret'), false);
    assert.equal(JSON.stringify(snapshot.config).includes('model-secret'), false);
  });

  it('prefills a real model target including its secret and returns undefined for missing entries', () => {
    assert.deepEqual(getModelTargetFromDashboard(env(), 'free', 'alpha'), {
      target: 'vendor/alpha',
      base_url: 'https://alpha.example/v1',
      api_key: 'model-secret',
      mode: 'openai-responses',
    });
    assert.equal(getModelTargetFromDashboard(env(), 'free', 'missing'), undefined);
    assert.equal(getModelTargetFromDashboard(env(), 'missing', 'alpha'), undefined);
  });
});

describe('handleDashboardPutConfig', () => {
  it('persists a valid update and returns the sanitized reloaded snapshot', async () => {
    const payload = dashboardModelsPayload();
    payload.models.free.alpha = ['vendor/alpha-v2', 'https://new-alpha.example/v1', 'anthropic-messages'];

    const response = await handleDashboardPutConfig(putRequest(payload), env(), proxyConfig);
    const body = await response.json() as DashboardSnapshot;

    assert.equal(response.status, 200);
    assert.equal(body.config.read_only, false);
    assert.deepEqual(body.config.models.free.alpha, [
      'vendor/alpha-v2',
      'https://new-alpha.example/v1',
      'anthropic-messages',
    ]);
    assert.equal(JSON.stringify(body.config).includes('category-secret'), false);
    assert.equal(JSON.stringify(body.config).includes('model-secret'), false);

    const persisted = loadProxyConfigFromPath(configPath);
    const category = persisted.models.free as Record<string, unknown>;
    assert.equal(category.api_key, 'category-secret');
    assert.deepEqual(category.alpha, [
      'vendor/alpha-v2',
      'https://new-alpha.example/v1',
      'model-secret',
      'anthropic-messages',
    ]);
  });

  it('returns config_errors and leaves the file byte-for-byte unchanged for an invalid update', async () => {
    const before = readFileSync(configPath, 'utf8');
    const payload = dashboardModelsPayload();
    (payload.models.free as Record<string, unknown>).broken = 'not-a-model-array';

    const response = await handleDashboardPutConfig(putRequest(payload), env(), proxyConfig);
    const body = await response.json() as { error: string; config_errors: unknown[] };

    assert.equal(response.status, 400);
    assert.equal(body.error, 'models.free.broken: must be [target, base_url, api_key]');
    assert.deepEqual(body.config_errors, [
      { path: 'models.free.broken', message: 'must be [target, base_url, api_key]' },
    ]);
    assert.equal(readFileSync(configPath, 'utf8'), before);
  });
});

describe('dashboard config mutation protection and validation', () => {
  for (const [provider, key] of [
    ['Consul', 'PROXY_CONFIG_CONSUL'],
    ['Apollo', 'PROXY_CONFIG_APOLLO'],
  ] as const) {
    it(`marks ${provider} config read-only and rejects representative mutations without accessing a service`, async () => {
      const remoteEnv = env({ [key]: 'http://127.0.0.1:1/unreachable' });
      const before = readFileSync(configPath, 'utf8');

      const snapshot = getDashboardSnapshot(proxyConfig, remoteEnv);
      assert.equal(snapshot.config.read_only, true);

      const putResponse = await handleDashboardPutConfig(putRequest(dashboardModelsPayload()), remoteEnv, proxyConfig);
      assert.equal(putResponse.status, 400);
      assert.match((await putResponse.json() as { error: string }).error, /editing is disabled/);

      const modelResponse = await handleDashboardUpsertModelTarget(
        mutationRequest({ target: 'vendor/beta', base_url: '', api_key: '', mode: 'openai-completions' }),
        remoteEnv,
        'free',
        'beta',
      );
      assert.equal(modelResponse.status, 400);
      assert.match((await modelResponse.json() as { error: string }).error, /editing is disabled/);
      assert.throws(() => getModelTargetFromDashboard(remoteEnv, 'free', 'alpha'), /editing is disabled/);
      assert.equal(readFileSync(configPath, 'utf8'), before);
    });
  }

  it('rejects blank and invalid mutation requests without changing the config', async () => {
    const before = readFileSync(configPath, 'utf8');
    const cases: Array<{ expected: string; run: () => Promise<Response> }> = [
      {
        expected: 'target is required',
        run: () => handleDashboardUpsertModelTarget(
          mutationRequest({ target: '   ', mode: 'openai-completions' }), env(), 'free', 'beta',
        ),
      },
      {
        expected: 'mode is required',
        run: () => handleDashboardUpsertModelTarget(
          mutationRequest({ target: 'vendor/beta' }), env(), 'free', 'beta',
        ),
      },
      {
        expected: 'alias is required',
        run: () => handleDashboardAddScheduleAlias(mutationRequest({ alias: '  ' }), env()),
      },
      {
        expected: 'target is required',
        run: () => handleDashboardUpsertScheduleTarget(
          mutationRequest({ target: '', windows: [] }), env(), 'scheduled',
        ),
      },
      {
        expected: 'windows must be an array',
        run: () => handleDashboardUpsertScheduleTarget(
          mutationRequest({ target: 'alpha', windows: {} }), env(), 'scheduled',
        ),
      },
      {
        expected: 'Invalid token limit format',
        run: () => handleDashboardGlobalTokenLimit(mutationRequest({ value: 'not-a-limit' }), env()),
      },
    ];

    for (const testCase of cases) {
      const response = await testCase.run();
      assert.equal(response.status, 400);
      assert.match((await response.json() as { error: string }).error, new RegExp(testCase.expected));
      assert.equal(readFileSync(configPath, 'utf8'), before);
    }
  });
});

describe('dashboard composite and schedule mutations', () => {
  it('persists composite targets, limits, fusion options, and removals', async () => {
    const {
      addCompositeAliasFromDashboard,
      removeCompositeAliasFromDashboard,
      removeCompositeTargetFromDashboard,
      upsertCompositeAliasLimitFromDashboard,
      upsertCompositeTargetFromDashboard,
      upsertFusionOptionsFromDashboard,
      upsertGlobalTokenLimitFromDashboard,
      upsertModelTargetFromDashboard,
    } = await import('../../src/handlers/dashboard.js');

    addCompositeAliasFromDashboard(env(), 'smart');
    upsertCompositeTargetFromDashboard(env(), 'smart', 'alpha', { share: 10, primary: true });
    upsertCompositeAliasLimitFromDashboard(env(), 'smart', '1.5K 1h');
    upsertFusionOptionsFromDashboard(env(), 'smart', { min_panel: 1 });
    upsertGlobalTokenLimitFromDashboard(env(), '2K 1d');
    upsertModelTargetFromDashboard(env(), 'free', 'beta', {
      target: 'vendor/beta', base_url: 'https://beta.example/v1', api_key: 'beta-secret', mode: 'openai-completions',
    });

    let persisted = loadProxyConfigFromPath(configPath);
    assert.equal(persisted.composite.smart.alpha.share, 10);
    assert.equal(persisted.composite.smart.alpha.primary, true);
    assert.deepEqual(persisted.composite.smart.token_limit, { num: 1500, duration: '1h' });
    assert.deepEqual(persisted.composite.smart.fusion_options, { min_panel: 1 });
    assert.equal(persisted.general?.global_token_limit, '2K 1d');
    assert.deepEqual((persisted.models.free as Record<string, unknown>).beta, [
      'vendor/beta', 'https://beta.example/v1', 'beta-secret', 'openai-completions',
    ]);

    upsertCompositeAliasLimitFromDashboard(env(), 'smart', null);
    upsertGlobalTokenLimitFromDashboard(env(), '');
    upsertFusionOptionsFromDashboard(env(), 'smart', null);
    removeCompositeTargetFromDashboard(env(), 'smart', 'alpha');
    removeCompositeAliasFromDashboard(env(), 'smart');
    persisted = loadProxyConfigFromPath(configPath);
    assert.equal(persisted.composite.smart, undefined);
    assert.equal(persisted.general?.global_token_limit, undefined);
    assert.throws(() => upsertCompositeAliasLimitFromDashboard(env(), 'smart', 'bad-limit'), /Invalid token limit format/);
  });

  it('persists schedule targets and returns sanitized removal responses', async () => {
    const {
      addScheduleAliasFromDashboard,
      handleDashboardRemoveScheduleAlias,
      handleDashboardRemoveScheduleTarget,
      upsertScheduleTargetFromDashboard,
    } = await import('../../src/handlers/dashboard.js');

    addScheduleAliasFromDashboard(env(), 'scheduled');
    upsertScheduleTargetFromDashboard(env(), 'scheduled', 'alpha', [{ from: 1, to: 12 }]);
    let persisted = loadProxyConfigFromPath(configPath);
    assert.deepEqual(persisted.schedule.scheduled.alpha, [{ from: 1, to: 12 }]);

    const removeTarget = handleDashboardRemoveScheduleTarget(env(), 'scheduled', 'alpha');
    assert.equal(removeTarget.status, 200);
    assert.equal(JSON.stringify(await removeTarget.json()).includes('model-secret'), false);
    persisted = loadProxyConfigFromPath(configPath);
    assert.deepEqual(persisted.schedule.scheduled, {});

    const removeAlias = handleDashboardRemoveScheduleAlias(env(), 'scheduled');
    assert.equal(removeAlias.status, 200);
    persisted = loadProxyConfigFromPath(configPath);
    assert.equal(persisted.schedule.scheduled, undefined);
  });
});
