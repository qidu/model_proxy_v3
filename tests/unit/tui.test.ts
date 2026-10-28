/**
 * Unit tests for tui.ts
 *
 * Covers: resolveModelTestConfig (TUI-side test-picker config resolver).
 *
 * Run with: npx tsx --test tests/unit/tui.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTestTextRequest,
  buildTestToolRequest,
  maxTokensField,
  resolveModelTestConfig,
} from '../../src/tui.js';
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

  it('resolves a direct inline-table target including its upstream model and key', () => {
    const config: ProxyConfig = {
      models: {
        free: {
          upstream_mode: 'openai-completions',
          base_url: 'https://category.example/v1',
          inline: {
            target: 'vendor/actual-model',
            base_url: 'https://model.example/v1',
            api_key: 'inline-secret',
            mode: 'openai-responses',
          },
        },
      },
    };

    assert.deepEqual(resolveModelTestConfig(config, 'inline'), {
      upstreamMode: 'openai-responses',
      targetUrl: 'https://model.example/v1',
      apiKey: 'inline-secret',
      directModel: 'vendor/actual-model',
    });
  });

  it('selects the primary target for a normal composite', () => {
    const config: ProxyConfig = {
      composite: {
        smart: {
          fallback: { fallback: 1 },
          primary: { primary: true },
        },
      },
    };
    const resolved = [{
      alias: 'smart',
      targets: [
        { model: 'fallback', upstreamMode: 'openai-completions', targetUrl: 'https://fallback.example' },
        { model: 'primary', upstreamMode: 'anthropic-messages', targetUrl: 'https://primary.example' },
      ],
    }];

    assert.deepEqual(resolveModelTestConfig(config, 'smart', resolved), {
      upstreamMode: 'anthropic-messages',
      targetUrl: 'https://primary.example',
      directModel: undefined,
    });
  });

  it('selects a fusion panel target and tests its proxy-side model directly', () => {
    const config: ProxyConfig = {
      composite: {
        fused: {
          synth: { role: 'synth' },
          judge: { role: 'judge' },
          panel: { role: 'panel', fusion: 1 },
          fusion_options: { min_panel: 1 },
        },
      },
    };
    const resolved = [{
      alias: 'fused',
      targets: [
        { model: 'synth', routeModel: 'upstream-synth', upstreamMode: 'openai-completions', targetUrl: 'https://synth.example' },
        { model: 'judge', routeModel: 'upstream-judge', upstreamMode: 'openai-completions', targetUrl: 'https://judge.example' },
        { model: 'panel', routeModel: 'upstream-panel', upstreamMode: 'gemini-generatecontent', targetUrl: 'https://panel.example' },
      ],
    }];

    assert.deepEqual(resolveModelTestConfig(config, 'fused', resolved), {
      upstreamMode: 'gemini-generatecontent',
      targetUrl: 'https://panel.example',
      directModel: 'panel',
    });
  });

  it('returns undefined for an unknown model', () => {
    assert.equal(resolveModelTestConfig({ models: {} }, 'missing'), undefined);
  });
});

describe('model test request builders', () => {
  const maxTokenCases = [
    ['openai-responses', 'max_completion_tokens'],
    ['openai-completions', 'max_tokens'],
    ['gemini-generatecontent', 'max_tokens'],
    ['anthropic-messages', 'max_tokens'],
  ] as const;

  for (const [upstreamMode, expected] of maxTokenCases) {
    it(`maxTokensField uses ${expected} for ${upstreamMode}`, () => {
      assert.equal(maxTokensField(upstreamMode), expected);
    });
  }

  const textCases = [
    ['openai-responses', { max_completion_tokens: 32 }],
    ['openai-completions', { max_tokens: 32 }],
    ['gemini-generatecontent', { max_tokens: 32 }],
    ['anthropic-messages', { max_tokens: 32 }],
  ] as const;

  for (const [upstreamMode, tokenField] of textCases) {
    it(`buildTestTextRequest returns the exact ${upstreamMode} shape`, () => {
      assert.deepEqual(buildTestTextRequest(upstreamMode), {
        messages: [{ role: 'user', content: 'Reply with one short sentence.' }],
        ...tokenField,
        stream: false,
      });
    });
  }

  const toolSchema = {
    type: 'object',
    properties: { message: { type: 'string' } },
    required: ['message'],
    additionalProperties: false,
  };
  const openAIToolCases = [
    ['openai-responses', 'max_completion_tokens'],
    ['openai-completions', 'max_tokens'],
    ['gemini-generatecontent', 'max_tokens'],
  ] as const;

  for (const [upstreamMode, tokenField] of openAIToolCases) {
    it(`buildTestToolRequest returns the exact ${upstreamMode} shape`, () => {
      assert.deepEqual(buildTestToolRequest(upstreamMode), {
        messages: [{ role: 'user', content: 'Use the test_tool and say hi.' }],
        [tokenField]: 128,
        tools: [{
          type: 'function',
          function: {
            name: 'test_tool',
            description: 'test tool',
            parameters: toolSchema,
          },
        }],
        tool_choice: 'auto',
      });
    });
  }

  it('buildTestToolRequest returns the exact anthropic-messages shape', () => {
    assert.deepEqual(buildTestToolRequest('anthropic-messages'), {
      messages: [{ role: 'user', content: 'Use the test_tool and say hi.' }],
      max_tokens: 128,
      tools: [{
        name: 'test_tool',
        description: 'test tool',
        input_schema: toolSchema,
      }],
      tool_choice: { type: 'tool', name: 'test_tool' },
    });
  });
});

describe('TUI startup and model defaults', () => {
  it('returns an inert cleanup function when no interactive terminal is available', async () => {
    const { startTUI } = await import('../../src/tui.js');
    let configLoads = 0;
    const stop = startTUI({
      env: {},
      readOnly: false,
      loadConfig: async () => {
        configLoads += 1;
        return {};
      },
    });
    assert.equal(typeof stop, 'function');
    stop();
    assert.equal(configLoads, 0);
  });

  it('uses tuple, category, and default fallbacks for sanitized model entries', () => {
    const config: ProxyConfig = {
      models: {
        default: {
          upstream_mode: 'anthropic-messages',
          base_url: 'https://default.example',
          api_key: 'default-key',
        },
        free: {
          base_url: 'https://category.example',
          api_key: 'category-key',
          tuple: ['vendor/tuple', ''],
        },
      },
    };
    assert.deepEqual(resolveModelTestConfig(config, 'tuple'), {
      upstreamMode: 'anthropic-messages',
      targetUrl: 'https://category.example',
      apiKey: 'category-key',
    });
  });
});

describe('interactive TUI lifecycle', () => {
  it('renders the dashboard, opens and closes help, and cleans up terminal state', { timeout: 5000 }, async () => {
    const { ProcessTerminal } = await import('@earendil-works/pi-tui');
    const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const originalStdoutWrite = process.stdout.write;
    const originalTerminalStart = ProcessTerminal.prototype.start;
    const originalTerminalStop = ProcessTerminal.prototype.stop;
    const originalTerminalWrite = ProcessTerminal.prototype.write;
    const originalFetch = globalThis.fetch;
    const output: string[] = [];
    let terminalInput: ((data: string) => void) | undefined;
    let terminalStarts = 0;
    let terminalStops = 0;
    let configLoads = 0;
    let fetchCalls = 0;
    let stop: (() => void) | undefined;

    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    ProcessTerminal.prototype.start = function (onInput) {
      terminalStarts += 1;
      terminalInput = onInput;
    };
    ProcessTerminal.prototype.stop = function () {
      terminalStops += 1;
    };
    ProcessTerminal.prototype.write = function (data) {
      output.push(data);
    };
    process.stdout.write = ((chunk: unknown) => {
      const text = String(chunk);
      if (text.startsWith('\x1b]0;')) {
        output.push(text);
        return true;
      }
      return (originalStdoutWrite as (this: NodeJS.WriteStream, value: unknown) => boolean).call(process.stdout, chunk);
    }) as typeof process.stdout.write;
    globalThis.fetch = (async () => {
      fetchCalls += 1;
      throw new Error('unexpected network request');
    }) as typeof fetch;

    const waitFor = async (predicate: () => boolean, description: string) => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.fail(`timed out waiting for ${description}`);
    };

    try {
      const { startTUI } = await import('../../src/tui.js');
      const { recordAgentStat, recordModelStat } = await import('../../src/utils/dashboard-stats.js');
      const previousTuiFlag = process.env.TUI;
      process.env.TUI = 'true';
      recordModelStat('__tui_function_model__', { input_tokens: 8, output_tokens: 3, total_tokens: 11 });
      recordAgentStat({ prefix: 'tui-test', ua: 'unit' }, ['__tui_function_tool__']);
      if (previousTuiFlag === undefined) delete process.env.TUI;
      else process.env.TUI = previousTuiFlag;
      stop = startTUI({
        env: { VERSION: 'test-version' },
        readOnly: false,
        loadConfig: async () => {
          configLoads += 1;
          return {
            models: {
              free: {
                upstream_mode: 'openai-completions',
                base_url: 'https://upstream.example/v1',
                alpha: ['vendor/alpha', 'https://upstream.example/v1', '', 'openai-completions'],
              },
            },
            composite: { combo: { alpha: { primary: true } } },
            schedule: { scheduled: { alpha: [{ from: 0, to: 24 }] } },
          };
        },
      });

      await waitFor(() => output.join('').includes('Proxy TUI') && output.join('').includes('Ready'), 'initial dashboard render');
      assert.ok(terminalInput, 'dashboard input handler was not installed');
      terminalInput('h');
      await waitFor(() => output.join('').includes('Hotkeys'), 'help overlay');
      terminalInput('h');
      await new Promise((resolve) => setTimeout(resolve, 150));

      const openAndClose = async (key: string, title: string, closeKey = '\x1b', keys: string[] = []) => {
        terminalInput(key);
        await waitFor(() => output.join('').includes(title), title);
        for (const nestedKey of keys) terminalInput(nestedKey);
        await new Promise((resolve) => setTimeout(resolve, 30));
        terminalInput(closeKey);
        await new Promise((resolve) => setTimeout(resolve, 30));
      };
      await openAndClose('c', 'Edit Composite Aliases Config', '\x1b', ['j', '\r', 'k']);
      await openAndClose('s', 'Edit Schedule Aliases Config', '\x1b', ['j', '\r', 'k']);
      await openAndClose('d', 'Statistics Data', 'd');
      await openAndClose('p', 'Tools Statitic and tool blocklist', 'p');
      const beforeMonthlyRender = output.join('').length;
      terminalInput('U');
      await waitFor(() => output.join('').length > beforeMonthlyRender, 'monthly heatmap render');

      stop();
      stop();
      // The invariant is "no loads AFTER stop" — the periodic 500ms refresh may
      // legitimately tick while the dashboard is running (slow CI runners make
      // the interaction phase exceed one interval), so snapshot at stop rather
      // than assuming the initial load was the only one.
      const loadsAtStop = configLoads;
      assert.ok(loadsAtStop >= 1, 'initial render must load config once');
      await new Promise((resolve) => setTimeout(resolve, 600));

      assert.equal(configLoads, loadsAtStop, 'stopped refresh timer must not reload config');
      assert.equal(fetchCalls, 0, 'unsupported quota providers must not contact upstream services');
      assert.equal(terminalStarts, 1);
      assert.equal(terminalStops, 1, 'idempotent cleanup must stop the terminal once');
      assert.match(output.join(''), /test-version/);
      assert.match(output.join(''), /Esc\/h.*close/);
      assert.match(output.join(''), /__tui_function_model__/);
      assert.match(output.join(''), /__tui_function_tool__/);
      assert.match(output.join(''), /combo/);
      assert.match(output.join(''), /scheduled/);
      assert.ok(output.includes('\x1b]0;\x07'), 'terminal title must be cleared');
    } finally {
      stop?.();
      ProcessTerminal.prototype.start = originalTerminalStart;
      ProcessTerminal.prototype.stop = originalTerminalStop;
      ProcessTerminal.prototype.write = originalTerminalWrite;
      process.stdout.write = originalStdoutWrite;
      globalThis.fetch = originalFetch;
      if (stdinTTY) Object.defineProperty(process.stdin, 'isTTY', stdinTTY);
      else delete (process.stdin as unknown as { isTTY?: boolean }).isTTY;
      if (stdoutTTY) Object.defineProperty(process.stdout, 'isTTY', stdoutTTY);
      else delete (process.stdout as unknown as { isTTY?: boolean }).isTTY;
    }
  });
});
