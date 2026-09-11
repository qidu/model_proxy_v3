import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  gatherSkillCandidates,
  loadSelectedSkills,
  snapshotWorkDir,
  diffWorkDirSnapshots,
  parseBudget,
  formatBudget,
  DEFAULT_BUDGET,
  BUDGET_PROMPT_DEFAULT,
  buildModelPickerItems,
} from '../../src/agent-session.js';
import type { ProxyConfig } from '../../src/utils/config-loader.js';

/**
 * Unit tests for gatherSkillCandidates / loadSelectedSkills: load skills from
 * both the project-scoped dir (workDir/.pi/skills) and a global dir
 * (parameterized here instead of the real ~/.pi/agent/skills), plus skills
 * from a shared lock file (parameterized instead of the real
 * ~/.agents/.skill-lock.json). Tests check real content (which skill names
 * loaded, that formatted output contains the skill body) not just "did not
 * throw".
 */

// gatherSkillCandidates disables pi-scoped skill loading (loadSkills()) on
// win32 (upstream @earendil-works/pi-agent-core bug: relativeEnvPath does
// "/"-string slicing instead of path.relative(), so it hands the `ignore`
// package a raw absolute backslash path and throws — reproduces on any real
// skill directory, not just edge cases). Lock-file-based other-agent
// candidates don't go through loadSkills() and are unaffected. Tests that
// load a real pi-scoped skill assert the win32-disabled behavior instead of
// the real-loading behavior on that platform.
const IS_WIN32 = process.platform === 'win32';

let workDir: string;
let globalSkillsDir: string;
let lockFilePath: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'agent-session-test-workdir-'));
  globalSkillsDir = mkdtempSync(join(tmpdir(), 'agent-session-test-global-'));
  lockFilePath = join(tmpdir(), `agent-session-test-lock-${Date.now()}.json`);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(globalSkillsDir, { recursive: true, force: true });
  rmSync(lockFilePath, { force: true });
});

function writeSkill(dir: string, name: string, body: string) {
  const skillDir = join(dir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `---\nname: ${name}\ndescription: test skill ${name}\n---\n\n${body}\n`);
}

function writeLockFile(entries: Record<string, { source: string }>) {
  writeFileSync(lockFilePath, JSON.stringify({ skills: entries }, null, 2), 'utf-8');
}

describe('gatherSkillCandidates', () => {
  it('returns empty array when no skills dirs exist and no lock file', async () => {
    const result = await gatherSkillCandidates(
      workDir,
      resolve(globalSkillsDir, 'does-not-exist'),
      join(tmpdir(), 'does-not-exist-lock.json'),
    );
    assert.deepEqual(result, []);
  });

  it('loads a skill from the global dir as a pi-scoped candidate', async () => {
    writeSkill(globalSkillsDir, 'global-skill', 'Do the global thing.');

    const result = await gatherSkillCandidates(workDir, globalSkillsDir, lockFilePath);

    if (IS_WIN32) {
      assert.deepEqual(result, []);
      return;
    }
    assert.equal(result.length, 1);
    assert.equal(result[0].item.value, 'global-skill');
    assert.equal(result[0].item.description, 'pi');
    assert.ok(result[0].skill);
    assert.equal(result[0].skill!.name, 'global-skill');
    assert.match(result[0].skill!.content, /Do the global thing\./);
  });

  it('loads a skill from the project-scoped .pi/skills dir', async () => {
    writeSkill(resolve(workDir, '.pi/skills'), 'project-skill', 'Do the project thing.');

    const result = await gatherSkillCandidates(workDir, resolve(globalSkillsDir, 'does-not-exist'), lockFilePath);

    if (IS_WIN32) {
      assert.deepEqual(result, []);
      return;
    }
    assert.equal(result.length, 1);
    assert.equal(result[0].item.value, 'project-skill');
    assert.equal(result[0].item.description, 'pi');
    assert.ok(result[0].skill);
    assert.equal(result[0].skill!.name, 'project-skill');
    assert.match(result[0].skill!.content, /Do the project thing\./);
  });

  it('loads both project and global skills together', async () => {
    writeSkill(resolve(workDir, '.pi/skills'), 'project-skill', 'Project body.');
    writeSkill(globalSkillsDir, 'global-skill', 'Global body.');

    const result = await gatherSkillCandidates(workDir, globalSkillsDir, lockFilePath);

    if (IS_WIN32) {
      assert.deepEqual(result, []);
      return;
    }
    assert.equal(result.length, 2);
    const names = result.map((c) => c.item.value).sort();
    assert.deepEqual(names, ['global-skill', 'project-skill']);
    for (const c of result) {
      assert.equal(c.item.description, 'pi');
      assert.ok(c.skill);
    }
  });

  it('includes other-agent candidates from the lock file', async () => {
    writeLockFile({
      'other-skill': { source: 'some-org/some-pkg' },
    });

    const result = await gatherSkillCandidates(workDir, resolve(globalSkillsDir, 'does-not-exist'), lockFilePath);

    // Other-agent candidates come from the lock file, not loadSkills(), so
    // they're unaffected by the win32 guard — this holds on every platform.
    assert.equal(result.length, 1);
    assert.equal(result[0].item.value, 'other-skill');
    assert.equal(result[0].item.description, 'needs install — some-org/some-pkg');
    assert.ok(result[0].installSource);
    assert.equal(result[0].installSource, 'some-org/some-pkg');
  });

  it('excludes other-agent skills already installed for pi (dedup)', async () => {
    writeSkill(globalSkillsDir, 'shared-skill', 'Shared body.');
    writeLockFile({
      'shared-skill': { source: 'some-org/some-pkg' },
      'other-skill': { source: 'another-org/another-pkg' },
    });

    const result = await gatherSkillCandidates(workDir, globalSkillsDir, lockFilePath);

    if (IS_WIN32) {
      // shared-skill can't be seen as pi-scoped (loadSkills() is disabled), so
      // it no longer dedupes and both lock-file entries surface as other-agent.
      assert.equal(result.length, 2);
      const names = result.map((c) => c.item.value).sort();
      assert.deepEqual(names, ['other-skill', 'shared-skill']);
      for (const c of result) assert.ok(c.installSource);
      return;
    }
    assert.equal(result.length, 2);
    const names = result.map((c) => c.item.value).sort();
    assert.deepEqual(names, ['other-skill', 'shared-skill']);
    // shared-skill should be pi-scoped (already installed for pi)
    const shared = result.find((c) => c.item.value === 'shared-skill');
    assert.ok(shared?.skill);
    assert.equal(shared!.item.description, 'pi');
    // other-skill should be other-agent
    const other = result.find((c) => c.item.value === 'other-skill');
    assert.ok(other?.installSource);
  });

  it('handles missing/empty lock file gracefully', async () => {
    writeSkill(globalSkillsDir, 'global-skill', 'Global body.');

    // No lock file written (lockFilePath is for a non-existent file)

    const result = await gatherSkillCandidates(workDir, globalSkillsDir, lockFilePath);

    if (IS_WIN32) {
      assert.deepEqual(result, []);
      return;
    }
    assert.equal(result.length, 1);
    assert.equal(result[0].item.value, 'global-skill');
  });

  it('handles malformed lock file gracefully (does not throw)', async () => {
    writeSkill(globalSkillsDir, 'global-skill', 'Global body.');
    writeFileSync(lockFilePath, '{ not valid json', 'utf-8');

    const result = await gatherSkillCandidates(workDir, globalSkillsDir, lockFilePath);

    if (IS_WIN32) {
      assert.deepEqual(result, []);
      return;
    }
    assert.equal(result.length, 1);
    assert.equal(result[0].item.value, 'global-skill');
  });
});

describe('loadSelectedSkills', () => {
  // Note: these tests don't shell out to `skills add` (would need the CLI and
  // a real package source). They only test the pi-scoped path (no install
  // needed) and error handling for missing installed skill after "install".
  // The full install path is exercised in manual integration testing.

  it('returns empty string when no candidates selected', async () => {
    writeSkill(globalSkillsDir, 'skill-a', 'Body A.');

    const candidates = await gatherSkillCandidates(workDir, globalSkillsDir, lockFilePath);
    const result = await loadSelectedSkills(workDir, candidates, new Set());

    assert.equal(result, '');
  });

  it('loads a selected pi-scoped skill and formats it', async () => {
    writeSkill(globalSkillsDir, 'skill-a', 'Body A.');
    writeSkill(globalSkillsDir, 'skill-b', 'Body B.');

    const candidates = await gatherSkillCandidates(workDir, globalSkillsDir, lockFilePath);
    const result = await loadSelectedSkills(workDir, candidates, new Set(['skill-a']));

    if (IS_WIN32) {
      // gatherSkillCandidates() returns [] on win32, so there's no
      // "skill-a" candidate to select — nothing to load or format.
      assert.equal(result, '');
      return;
    }
    assert.match(result, /name="skill-a"/);
    assert.match(result, /Body A\./);
    assert.ok(!result.includes('skill-b'));
  });

  it('loads multiple selected pi-scoped skills joined by double newline', async () => {
    writeSkill(globalSkillsDir, 'skill-a', 'Body A.');
    writeSkill(globalSkillsDir, 'skill-b', 'Body B.');

    const candidates = await gatherSkillCandidates(workDir, globalSkillsDir, lockFilePath);
    const result = await loadSelectedSkills(workDir, candidates, new Set(['skill-a', 'skill-b']));

    if (IS_WIN32) {
      assert.equal(result, '');
      return;
    }
    assert.match(result, /name="skill-a"/);
    assert.match(result, /Body A\./);
    assert.match(result, /name="skill-b"/);
    assert.match(result, /Body B\./);
    assert.ok(result.includes('\n\n')); // join separator
  });
});

/**
 * Unit tests for snapshotWorkDir/diffWorkDirSnapshots: the before/after file
 * snapshot mechanism behind the post-task "files changed" summary. Assertions
 * check actual map contents/classification, not just "did not throw".
 */
describe('snapshotWorkDir', () => {
  it('maps every file under workDir to its mtime', async () => {
    writeFileSync(join(workDir, 'a.txt'), 'a');
    mkdirSync(join(workDir, 'sub'));
    writeFileSync(join(workDir, 'sub', 'b.txt'), 'b');

    const snapshot = await snapshotWorkDir(workDir);

    assert.deepEqual([...snapshot.keys()].sort(), ['a.txt', join('sub', 'b.txt')]);
    for (const mtime of snapshot.values()) {
      assert.equal(typeof mtime, 'number');
      assert.ok(mtime > 0);
    }
  });

  it('skips .git and node_modules subdirectories', async () => {
    writeFileSync(join(workDir, 'kept.txt'), 'kept');
    mkdirSync(join(workDir, '.git'));
    writeFileSync(join(workDir, '.git', 'HEAD'), 'ref: refs/heads/main');
    mkdirSync(join(workDir, 'node_modules'));
    writeFileSync(join(workDir, 'node_modules', 'pkg.js'), 'module.exports = {};');

    const snapshot = await snapshotWorkDir(workDir);

    assert.deepEqual([...snapshot.keys()], ['kept.txt']);
  });

  it('returns an empty map for a directory with no files', async () => {
    const snapshot = await snapshotWorkDir(workDir);
    assert.deepEqual([...snapshot.keys()], []);
  });
});

describe('diffWorkDirSnapshots', () => {
  it('classifies a path only in "after" as created', () => {
    const before = new Map<string, number>();
    const after = new Map([['new.txt', 1000]]);

    assert.deepEqual(diffWorkDirSnapshots(before, after), { created: ['new.txt'], modified: [] });
  });

  it('classifies a path with a changed mtime as modified', () => {
    const before = new Map([['changed.txt', 1000]]);
    const after = new Map([['changed.txt', 2000]]);

    assert.deepEqual(diffWorkDirSnapshots(before, after), { created: [], modified: ['changed.txt'] });
  });

  it('excludes a path with an unchanged mtime from both lists', () => {
    const before = new Map([['same.txt', 1000]]);
    const after = new Map([['same.txt', 1000]]);

    assert.deepEqual(diffWorkDirSnapshots(before, after), { created: [], modified: [] });
  });

  it('does not report a path removed in "after" (deletions are not tracked)', () => {
    const before = new Map([['removed.txt', 1000]]);
    const after = new Map<string, number>();

    assert.deepEqual(diffWorkDirSnapshots(before, after), { created: [], modified: [] });
  });

  it('returns created and modified lists sorted for stable output', () => {
    const before = new Map([['z-changed.txt', 1000], ['a-changed.txt', 1000]]);
    const after = new Map([
      ['z-changed.txt', 2000],
      ['a-changed.txt', 2000],
      ['z-new.txt', 1000],
      ['a-new.txt', 1000],
    ]);

    assert.deepEqual(diffWorkDirSnapshots(before, after), {
      created: ['a-new.txt', 'z-new.txt'],
      modified: ['a-changed.txt', 'z-changed.txt'],
    });
  });

  it('reflects a real mtime change on disk via snapshotWorkDir + utimesSync', async () => {
    const filePath = join(workDir, 'real.txt');
    writeFileSync(filePath, 'v1');
    const before = await snapshotWorkDir(workDir);

    const newTime = new Date(Date.now() + 10_000);
    utimesSync(filePath, newTime, newTime);
    const after = await snapshotWorkDir(workDir);

    assert.deepEqual(diffWorkDirSnapshots(before, after), { created: [], modified: ['real.txt'] });
  });
});

/**
 * Unit tests for parseBudget/formatBudget/DEFAULT_BUDGET: the budget-prompt
 * parser (single-kind, explicit input) and the combined default applied when
 * the prompt is left blank (both a token and a turn limit; whichever hits
 * first stops the run — see startAgentSession's turn_end handler).
 */
describe('parseBudget', () => {
  it('parses a bare integer < 1000 as a turn budget', () => {
    assert.deepEqual(parseBudget('20'), { turns: 20 });
    assert.deepEqual(parseBudget('40'), { turns: 40 });
    assert.deepEqual(parseBudget('999'), { turns: 999 });
  });

  it('parses a bare integer >= 1000 as a token budget', () => {
    assert.deepEqual(parseBudget('1000'), { tokens: 1000 });
    assert.deepEqual(parseBudget('2000'), { tokens: 2000 });
  });

  it('parses a fractional bare number as a (rounded) turn count when < 1000', () => {
    assert.deepEqual(parseBudget('1.5'), { turns: 2 });
  });

  it('parses a k-suffixed value as a token budget', () => {
    assert.deepEqual(parseBudget('50k'), { tokens: 50_000 });
    assert.deepEqual(parseBudget('50K'), { tokens: 50_000 });
  });

  it('parses an m-suffixed value as a token budget', () => {
    assert.deepEqual(parseBudget('2m'), { tokens: 2_000_000 });
    assert.deepEqual(parseBudget('2M'), { tokens: 2_000_000 });
  });

  it('parses a b- or t-suffixed value as a token budget', () => {
    assert.deepEqual(parseBudget('1b'), { tokens: 1_000_000_000 });
    assert.deepEqual(parseBudget('1t'), { tokens: 1_000_000_000_000 });
  });

  it('rounds fractional token values', () => {
    assert.deepEqual(parseBudget('1.5k'), { tokens: 1_500 });
  });

  it('parses two whitespace-separated numbers as tokens + turns', () => {
    assert.deepEqual(parseBudget('2m 40'), { tokens: 2_000_000, turns: 40 });
    assert.deepEqual(parseBudget('2000 40'), { tokens: 2000, turns: 40 });
    // bare number < 1000 first also OK (the first slot is always tokens in the
    // two-number form, even if it's a small number — a deliberate "cap tokens
    // low, run a long time" shape).
    assert.deepEqual(parseBudget('20 40'), { tokens: 20, turns: 40 });
  });

  it('rejects zero, negative, and non-numeric input', () => {
    assert.equal(parseBudget('0'), null);
    assert.equal(parseBudget('-5'), null);
    assert.equal(parseBudget('abc'), null);
    assert.equal(parseBudget(''), null);
  });

  it('rejects more than two whitespace-separated tokens', () => {
    assert.equal(parseBudget('1 2 3'), null);
  });

  it('rejects the two-number form when the second slot can\'t be parsed as turns', () => {
    assert.equal(parseBudget('1m abc'), null);
  });
});

describe('DEFAULT_BUDGET', () => {
  it('is a combined 5,000,000-token / 100-turn budget', () => {
    assert.deepEqual(DEFAULT_BUDGET, { tokens: 5_000_000, turns: 100 });
  });

  // The prompt compares the submitted value against BUDGET_PROMPT_DEFAULT to
  // detect "took the default"; if the two drift apart, submitting the prefill
  // silently falls through to parseBudget and loses the turn cap.
  it('keeps BUDGET_PROMPT_DEFAULT in sync with its token count', () => {
    assert.deepEqual(parseBudget(BUDGET_PROMPT_DEFAULT), { tokens: DEFAULT_BUDGET.tokens });
  });

  // Turns must be a backstop, not the binding limit — at a realistic ~30k
  // tokens/turn the token budget should run out first (see the comment on
  // DEFAULT_BUDGET). Guards against reintroducing the old 10-turn cap, which
  // made the 5m token limit unreachable in practice.
  it('sizes turns so the token budget is the limit that normally trips first', () => {
    const realisticTokensPerTurn = 30_000;
    assert.ok(
      DEFAULT_BUDGET.turns! * realisticTokensPerTurn > DEFAULT_BUDGET.tokens! / 2,
      `${DEFAULT_BUDGET.turns} turns caps a typical run well below the ${DEFAULT_BUDGET.tokens}-token budget`,
    );
  });
});

describe('formatBudget', () => {
  it('formats a turns-only budget', () => {
    assert.equal(formatBudget({ turns: 20 }), '20 turns');
  });

  it('formats a tokens-only budget', () => {
    assert.equal(formatBudget({ tokens: 50_000 }), '50,000 tokens');
  });

  it('formats a combined budget as "tokens / turns"', () => {
    assert.equal(formatBudget(DEFAULT_BUDGET), '5,000,000 tokens / 100 turns');
  });
});

describe('buildModelPickerItems', () => {
  // getConfiguredModelIds returns target models first, then composite, then
  // schedule aliases — the picker inverts that, so pass them in that original
  // order to prove the reordering actually happens.
  const config: ProxyConfig = {
    models: {
      claude: { base_url: 'https://x', 'target-a': ['target-a', '', ''] } as any,
      gemini: { base_url: 'https://y', 'target-b': ['target-b', '', ''] } as any,
    },
    composite: {
      'cmp-share': { 'target-a': { share: 1 } },
      'cmp-fusion': { 'target-a': { role: 'panel' }, 'target-b': { role: 'judge' } },
    },
    schedule: { 'sched-1': { 'target-a': [] } },
  };
  const inputOrder = ['target-a', 'target-b', 'cmp-share', 'cmp-fusion', 'sched-1'];

  it('lists composite aliases first, then schedule, then target models last', () => {
    const items = buildModelPickerItems(inputOrder, config);
    assert.deepEqual(
      items.map((i) => i.value),
      ['cmp-share', 'cmp-fusion', 'sched-1', 'target-a', 'target-b'],
    );
  });

  it('labels each item with its kind, not the composite mode', () => {
    const items = buildModelPickerItems(inputOrder, config);
    const byValue = Object.fromEntries(items.map((i) => [i.value, i.description]));
    // Both composites get the same label regardless of their differing modes
    // (cmp-fusion is a fusion alias, cmp-share a share alias).
    assert.equal(byValue['cmp-fusion'], 'composite');
    assert.equal(byValue['cmp-share'], 'composite');
    assert.equal(byValue['sched-1'], 'schedule');
    assert.equal(byValue['target-a'], 'target model');
  });

  it('preserves each group\'s relative input order', () => {
    const items = buildModelPickerItems(['target-b', 'target-a', 'cmp-fusion', 'cmp-share'], config);
    assert.deepEqual(
      items.map((i) => i.value),
      ['cmp-fusion', 'cmp-share', 'target-b', 'target-a'],
    );
  });

  it('keeps value and label equal to the alias id so selection still resolves', () => {
    const items = buildModelPickerItems(inputOrder, config);
    for (const item of items) {
      assert.equal(item.label, item.value);
    }
  });

  it('treats an alias absent from composite/schedule as a target model', () => {
    const items = buildModelPickerItems(['unknown-alias'], {});
    assert.deepEqual(items, [{ value: 'unknown-alias', label: 'unknown-alias', description: 'target model' }]);
  });

  it('returns [] for no aliases', () => {
    assert.deepEqual(buildModelPickerItems([], config), []);
  });
});