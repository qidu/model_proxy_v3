import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { eraseBlockedTools } from '../../src/utils/tool-blocklist.js';
import { blockTool, getBlockedTools, unblockTool } from '../../src/utils/dashboard-stats.js';
import type { Logger } from '../../src/types/shared.js';

const logger: Logger & { debugMessages: string[]; infoMessages: string[] } = {
  debugMessages: [],
  infoMessages: [],
  trace() {},
  debug(_id, message) { this.debugMessages.push(message); },
  info(_id, message) { this.infoMessages.push(message); },
  warn() {},
  error() {},
};

afterEach(() => {
  for (const name of getBlockedTools()) unblockTool(name);
  logger.debugMessages.length = 0;
  logger.infoMessages.length = 0;
});

describe('eraseBlockedTools', () => {
  it('removes static and sidecar-blocked Claude and OpenAI tools while preserving other fields', () => {
    blockTool('static_tool');
    const body: Record<string, unknown> = {
      model: 'test',
      tools: [
        { name: 'static_tool', input_schema: { type: 'object' } },
        { type: 'function', function: { name: 'judge_tool', parameters: { type: 'object' } } },
        { name: 'allowed_tool', description: 'keep' },
      ],
    };

    const result = eraseBlockedTools(body, logger, 'req_1', ['judge_tool'], { judge_tool: 0.87654 });

    assert.deepEqual(result, { erasedNames: ['static_tool', 'judge_tool'], toolChoiceReset: false });
    assert.deepEqual(body, { model: 'test', tools: [{ name: 'allowed_tool', description: 'keep' }] });
    assert.ok(logger.debugMessages.some((line) => line.includes('static blocklist')));
    assert.ok(logger.debugMessages.some((line) => line.includes('confidence=0.8765')));
    assert.deepEqual(logger.infoMessages, ['Erased blocked tools from request: static_tool, judge_tool']);
  });

  it('filters Gemini declarations independently and drops empty wrappers', () => {
    blockTool('blocked');
    const body: Record<string, unknown> = {
      tools: [
        { functionDeclarations: [{ name: 'blocked' }] },
        { functionDeclarations: [{ name: 'blocked' }, { name: 'allowed' }, null] },
      ],
    };

    const result = eraseBlockedTools(body, undefined, 'req_2');

    assert.deepEqual(result.erasedNames, ['blocked', 'blocked']);
    assert.deepEqual(body.tools, [{ functionDeclarations: [{ name: 'allowed' }, null] }]);
  });

  it('deletes tools when every declaration is removed', () => {
    const body: Record<string, unknown> = { tools: [{ name: 'judge_only' }] };
    const result = eraseBlockedTools(body, undefined, 'req_3', ['judge_only']);
    assert.deepEqual(result.erasedNames, ['judge_only']);
    assert.equal('tools' in body, false);
  });

  it('resets Claude and OpenAI forced choices for blocked tools', () => {
    blockTool('static_choice');
    const claude: Record<string, unknown> = { tool_choice: { type: 'tool', name: 'static_choice' } };
    const openai: Record<string, unknown> = { tool_choice: { type: 'function', function: { name: 'judge_choice' } } };

    assert.deepEqual(eraseBlockedTools(claude, undefined, 'req_4'), { erasedNames: [], toolChoiceReset: true });
    assert.deepEqual(eraseBlockedTools(openai, undefined, 'req_5', ['judge_choice']), { erasedNames: [], toolChoiceReset: true });
    assert.equal(claude.tool_choice, 'auto');
    assert.equal(openai.tool_choice, 'auto');
  });

  it('leaves allowed forced choices and non-tool bodies unchanged', () => {
    const allowed: Record<string, unknown> = { tools: 'invalid', tool_choice: { name: 'allowed' } };
    const original = structuredClone(allowed);
    assert.deepEqual(eraseBlockedTools(allowed, undefined, 'req_6'), { erasedNames: [], toolChoiceReset: false });
    assert.deepEqual(allowed, original);
  });

  it('preserves malformed and unnamed tool entries and does not rewrite unchanged arrays', () => {
    const entries = [null, 42, { description: 'anonymous' }, { name: 'allowed' }];
    const body: Record<string, unknown> = { tools: entries };
    const result = eraseBlockedTools(body, undefined, 'req_7', ['missing']);
    assert.deepEqual(result, { erasedNames: [], toolChoiceReset: false });
    assert.equal(body.tools, entries);
    assert.deepEqual(body.tools, [null, 42, { description: 'anonymous' }, { name: 'allowed' }]);
  });
});
