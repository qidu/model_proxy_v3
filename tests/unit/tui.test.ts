/**
 * Unit tests for tui.ts
 *
 * Covers: resolveModelTestConfig (TUI-side test-picker config resolver).
 *
 * Run with: npx tsx --test tests/unit/tui.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveModelTestConfig } from '../../src/tui.js';
import { toDashboardConfigPayload, type ProxyConfig } from '../../src/utils/config-loader.js';

describe('resolveModelTestConfig', () => {
  it('falls back to the real per-model api_key (from realConfig) when the sanitized snapshot strips it', () => {
    const realConfig: ProxyConfig = {
      models: {
        default: {
          upstream_mode: 'openai-completions',
          base_url: 'https://api.minimaxi.com',
          api_key: 'default-key-wrong-provider',
        },
        bbc: {
          bbb: [
            'nvidia/nemotron-3-ultra-550b-a55b:free',
            'https://openrouter.ai/api/v1',
            'sk-or-v1-real-bbb-key',
            'openai-responses',
          ],
        },
      },
    };
    // Simulate the sanitized dashboard snapshot the TUI actually reads from:
    // [target, base_url, mode] — api_key stripped.
    const sanitized = toDashboardConfigPayload(realConfig);
    const sanitizedConfig = sanitized as unknown as ProxyConfig;

    const withRealConfig = resolveModelTestConfig(sanitizedConfig, 'bbb', undefined, realConfig);
    assert.equal(withRealConfig?.apiKey, 'sk-or-v1-real-bbb-key', 'must use bbb\'s own key, not the proxy-wide default');
    assert.equal(withRealConfig?.targetUrl, 'https://openrouter.ai/api/v1');
    assert.equal(withRealConfig?.upstreamMode, 'openai-responses');

    // Without realConfig (old behavior), the per-model key is unavailable:
    // the sanitized snapshot carries neither the entry's own api_key (stripped)
    // nor models.default (not part of the sanitized payload at all), so
    // resolveModelTestConfig itself yields no apiKey.
    const withoutRealConfig = resolveModelTestConfig(sanitizedConfig, 'bbb', undefined);
    assert.equal(withoutRealConfig?.apiKey, undefined);
  });

  it('still prefers the category api_key over models.default when realConfig has no per-model key', () => {
    const realConfig: ProxyConfig = {
      models: {
        default: {
          upstream_mode: 'openai-completions',
          base_url: 'https://api.minimaxi.com',
          api_key: 'default-key-wrong-provider',
        },
        free: {
          upstream_mode: 'openai-completions',
          base_url: 'https://openrouter.ai/api/v1',
          api_key: 'sk-or-v1-category-key',
          plainmodel: ['some/target', 'https://openrouter.ai/api/v1'],
        },
      },
    };
    const sanitized = toDashboardConfigPayload(realConfig);
    const sanitizedConfig = sanitized as unknown as ProxyConfig;

    const resolved = resolveModelTestConfig(sanitizedConfig, 'plainmodel', undefined, realConfig);
    assert.equal(resolved?.apiKey, 'sk-or-v1-category-key');
  });
});
