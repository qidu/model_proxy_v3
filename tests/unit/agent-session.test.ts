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
  RuledInput,
  setProxyLogRow,
  captureConsoleOutput,
  restoreConsoleOutput,
  SPINNER_CHARS,
  SPINNER_MD,
  agentTitleGlyph,
} from '../../src/agent-session.js';
import type { ProxyConfig } from '../../src/utils/config-loader.js';
import { CURSOR_MARKER, Box, Input, Markdown, visibleWidth, type MarkdownTheme } from '@earendil-works/pi-tui';

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

/** Strip ANSI SGR sequences so assertions compare visible text, not styling. */
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('RuledInput', () => {
  it('prepends a rule of exactly the render width, made only of ─', () => {
    const lines = new RuledInput(new Input()).render(40);
    assert.equal(plain(lines[0]), '─'.repeat(40));
    // visibleWidth, not length: '─' is East-Asian-Width ambiguous, so this is
    // what actually decides whether the rule can wrap onto a second line.
    assert.equal(visibleWidth(lines[0]), 40);
  });

  it('adds exactly one line and never wraps, at narrow and wide widths', () => {
    for (const width of [1, 5, 40, 200]) {
      const wrapped = new RuledInput(new Input()).render(width);
      const bare = new Input().render(width);
      assert.equal(wrapped.length, bare.length + 1, `width ${width}: line count`);
      assert.equal(visibleWidth(wrapped[0]), width, `width ${width}: rule width`);
    }
  });

  it('hands the inner Input the full width — no columns are subtracted', () => {
    const width = 40;
    const bare = new Input();
    const wrapped = new RuledInput(new Input());
    assert.deepEqual(wrapped.render(width).slice(1), bare.render(width));
  });

  it('keeps the cursor marker on the input line, never on the rule', () => {
    const row = new RuledInput(new Input());
    row.focused = true;
    const lines = row.render(40);
    // The marker must exist at all — the TUI derives the hardware cursor column
    // from it, so a wrapper that lost it would hide the cursor.
    assert.ok(
      lines.slice(1).some((l) => l.includes(CURSOR_MARKER)),
      'cursor marker missing from the input lines',
    );
    assert.equal(lines[0].includes(CURSOR_MARKER), false, 'cursor marker leaked onto the rule');
  });

  it('delegates focused and handleInput to the inner Input', () => {
    const input = new Input();
    const row = new RuledInput(input);
    assert.equal(row.focused, false);
    row.focused = true;
    assert.equal(input.focused, true);
    row.handleInput('abc');
    assert.match(plain(row.render(40).slice(1).join('\n')), /abc/);
  });

  it('renders an empty rule at zero width instead of throwing', () => {
    // String.repeat throws RangeError on a negative count; a pathologically
    // narrow terminal must not take the TUI down with it.
    const lines = new RuledInput(new Input()).render(0);
    assert.equal(lines[0], '');
  });
});

describe('captureConsoleOutput', () => {
  // While the persistent TUI owns the screen, proxy log lines (routed to stderr
  // by the console redirect in src/server.ts) would otherwise be written on top
  // of the '>' prompt row. The contract that matters: capturing diverts every
  // console method before it reaches stderr, and teardown hands the genuine
  // methods back — a capture that failed to restore would silently swallow all
  // later logging. `console` is process-global, so each test restores it.
  const methods = ['log', 'info', 'debug', 'warn', 'error'] as const;

  it('diverts every method that can reach stderr, writing none of it', () => {
    const lines: string[] = [];
    const stderrChunks: string[] = [];
    const realWrite = process.stderr.write;
    process.stderr.write = ((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof realWrite;
    try {
      // console.log/info/debug are aliased onto console.error's original
      // function by src/server.ts, so replacing console.error alone would leave
      // the proxy logger's own channel still writing to stderr.
      captureConsoleOutput((line) => lines.push(line));
      for (const method of methods) console[method](`boom-${method}`);
    } finally {
      restoreConsoleOutput();
      process.stderr.write = realWrite;
    }
    assert.deepEqual(lines, methods.map((m) => `boom-${m}`));
    assert.deepEqual(stderrChunks.filter((chunk) => chunk.includes('boom')), []);
  });

  it('splits a multi-line message into one callback per line', () => {
    const lines: string[] = [];
    const realWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof realWrite;
    try {
      captureConsoleOutput((line) => lines.push(line));
      console.error('first\nsecond\n\nthird');
    } finally {
      restoreConsoleOutput();
      process.stderr.write = realWrite;
    }
    assert.deepEqual(lines, ['first', 'second', 'third']);
  });

  it('restores the original methods on teardown', () => {
    const before = methods.map((m) => console[m]);
    const realWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof realWrite;
    try {
      captureConsoleOutput(() => {});
      for (const [i, method] of methods.entries()) {
        assert.notEqual(console[method], before[i], `console.${method} was not replaced`);
      }
      restoreConsoleOutput();
    } finally {
      process.stderr.write = realWrite;
    }
    for (const [i, method] of methods.entries()) {
      assert.equal(console[method], before[i], `console.${method} was not restored`);
    }
  });

  it('is idempotent — a second capture never adopts the first as the original', () => {
    // Without the guard, the second call would save the capturing function as
    // the "original" and restoring it would leave the console diverted forever.
    const before = methods.map((m) => console[m]);
    const realWrite = process.stderr.write;
    process.stderr.write = (() => true) as typeof realWrite;
    try {
      captureConsoleOutput(() => {});
      captureConsoleOutput(() => {});
      restoreConsoleOutput();
    } finally {
      process.stderr.write = realWrite;
    }
    for (const [i, method] of methods.entries()) {
      assert.equal(console[method], before[i], `console.${method} was not restored`);
    }
  });
});

describe('setProxyLogRow', () => {
  // The row is one line by contract: a proxy warning that wrapped would push the
  // '─' rule and the '>' prompt down a row mid-session, and two logs sharing the
  // row would concatenate into one unreadable line. Box + TruncatedText is what
  // delivers both properties, so assert them on the real render at the widths a
  // terminal actually reports.
  it('shows only the newest line — the previous one is replaced, not concatenated', () => {
    const row = new Box(0, 0);
    setProxyLogRow(row, 'first warning');
    setProxyLogRow(row, 'second warning');
    const lines = row.render(60);
    assert.equal(lines.length, 1, 'row must stay one line tall');
    assert.match(plain(lines[0]), /second warning/);
    assert.equal(plain(lines[0]).includes('first warning'), false, 'stale line still visible');
  });

  it('renders no row at all before the first log', () => {
    // A blank row here would permanently eat a line of the transcript.
    assert.deepEqual(new Box(0, 0).render(40), []);
  });

  it('truncates a long warning to exactly the render width instead of wrapping', () => {
    for (const width of [10, 30, 120]) {
      const row = new Box(0, 0);
      setProxyLogRow(row, `[WARN] ${'target ladder '.repeat(30)}`);
      const lines = row.render(width);
      assert.equal(lines.length, 1, `width ${width}: wrapped onto a second row`);
      assert.equal(visibleWidth(lines[0]), width, `width ${width}: row is not exactly full width`);
    }
  });

  it('renders the line dimmed, keeping the log visually subordinate to the task', () => {
    const row = new Box(0, 0);
    setProxyLogRow(row, 'x');
    assert.match(row.render(20)[0], /\x1b\[90m/);
  });
});

describe('SPINNER_MD', () => {
  // Identity theme: every MarkdownTheme value is a style fn returning its input.
  // These assertions are about line text, not styling, and a Proxy keeps working
  // if pi-tui adds theme keys — unlike a hand-built partial object.
  const theme = new Proxy({} as MarkdownTheme, { get: () => (t: string) => t });
  const dimStyle = { color: (t: string) => t };

  /** Render `${frame} ${text}` the way the in-flight task line does, and return its first visible char. */
  function leadChar(frame: string): string {
    const md = new Markdown(`${frame} run the tests`, 1, 1, theme, dimStyle);
    const line = md.render(60).map(plain).find((l) => l.trim() !== '');
    assert.ok(line, `no rendered line for frame ${JSON.stringify(frame)}`);
    return line!.trimStart()[0];
  }

  it('holds the \\|/+- frames in order, escaped only where Markdown needs it', () => {
    assert.deepEqual(SPINNER_CHARS, ['\\', '|', '/', '+', '-']);
    assert.equal(SPINNER_MD.length, SPINNER_CHARS.length);
    assert.deepEqual(SPINNER_MD, ['\\', '|', '/', '\\+', '\\-']);
  });

  it('renders every frame literally as the leading character of the task line', () => {
    for (let i = 0; i < SPINNER_CHARS.length; i++) {
      assert.equal(
        leadChar(SPINNER_MD[i]),
        SPINNER_CHARS[i],
        `frame ${JSON.stringify(SPINNER_CHARS[i])} did not render literally`,
      );
    }
  });

  it('regression: an unescaped "+" is Markdown list syntax and renders as "-"', () => {
    // This is why SPINNER_MD exists. Passing SPINNER_CHARS straight to Markdown
    // silently animated `\ | / -` while the docs advertised `\ | / +`.
    assert.equal(leadChar('+'), '-');
    assert.equal(leadChar('\\+'), '+');
  });

  it('regression: unescaped list markers wrap with a hanging indent, so every frame is escaped', () => {
    // `-` is the subtle one: a list bullet is also drawn as `-`, so leadChar
    // cannot tell it apart from a paragraph. What differs is the wrap — a list
    // item indents its continuation lines, a paragraph does not. On a long task
    // description that shows up as the text jumping sideways whenever the
    // spinner reaches the `+` or `-` frame.
    const text = 'a task description long enough to wrap across several lines in the terminal';
    /** Indent of the second visible line, i.e. where wrapped text resumes. */
    const wrapIndent = (frame: string): number => {
      const lines = new Markdown(`${frame} ${text}`, 1, 1, theme, dimStyle)
        .render(40)
        .map(plain)
        .filter((l) => l.trim() !== '');
      assert.ok(lines.length > 1, `text did not wrap for frame ${JSON.stringify(frame)}`);
      return lines[1].length - lines[1].trimStart().length;
    };

    const paragraph = wrapIndent('\\'); // inert frame: the paragraph baseline
    assert.equal(wrapIndent('-'), paragraph + 2, 'unescaped "-" should still be a list item');
    assert.equal(wrapIndent('+'), paragraph + 2, 'unescaped "+" should still be a list item');
    for (const frame of SPINNER_MD) {
      assert.equal(
        wrapIndent(frame),
        paragraph,
        `frame ${JSON.stringify(frame)} wraps unlike a paragraph`,
      );
    }
  });
});

describe('agentTitleGlyph', () => {
  it('starts on π and runs π π * * π π * * over the first eight ticks', () => {
    // Ticks are 1-based: startTuiSpinner increments spinnerTick before its first
    // glyph, so tick 0 never reaches this function.
    const seq = [1, 2, 3, 4, 5, 6, 7, 8].map(agentTitleGlyph);
    assert.deepEqual(seq, ['π', 'π', '*', '*', 'π', 'π', '*', '*']);
  });

  it('holds each glyph for exactly two ticks', () => {
    // The hold length is what the user asked for (2 πs then 2 *s, not a flip on
    // every 150ms frame). Assert it directly rather than only in the sequence.
    for (let start = 1; start <= 8; start += 2) {
      assert.equal(agentTitleGlyph(start), agentTitleGlyph(start + 1));
      assert.notEqual(agentTitleGlyph(start), agentTitleGlyph(start + 2));
    }
  });

  it('returns only π or *, for every tick', () => {
    for (let tick = 1; tick <= 200; tick++) {
      assert.ok(
        agentTitleGlyph(tick) === 'π' || agentTitleGlyph(tick) === '*',
        `unexpected glyph at tick ${tick}`,
      );
    }
  });
});

describe('output trimming before Markdown', () => {
  // Identity theme: every MarkdownTheme value is a style fn returning its input.
  const theme = new Proxy({} as MarkdownTheme, { get: () => (t: string) => t });
  const dimStyle = { color: (t: string) => t };

  /**
   * Markdown always emits one blank row above the paragraph as its own top
   * margin — even `"hello world"` renders at index 1. So "no leading blanks"
   * means exactly MARGIN, never zero.
   */
  const MARGIN = 1;

  function render(src: string): string[] {
    return new Markdown(src, 1, 1, theme, dimStyle).render(40).map(plain);
  }

  /** Leading-blank count, whether a ``` fence appeared, and the first visible line. */
  function lead(src: string): { blanks: number; fenced: boolean; first: string } {
    const lines = render(src);
    const idx = lines.findIndex((l) => l.trim() !== '');
    assert.notEqual(idx, -1, `nothing visible rendered for ${JSON.stringify(src)}`);
    return { blanks: idx, fenced: lines.some((l) => l.includes('```')), first: lines[idx].replace(/\s+$/, '') };
  }

  it('baseline: plain text carries exactly one blank row of component margin', () => {
    assert.deepEqual(lead('hello world'), { blanks: MARGIN, fenced: false, first: ' hello world' });
  });

  it('regression: untrimmed 4-space-indented output becomes a Markdown code block', () => {
    // This is the trap trimming exists to avoid. `ls` output like "    a.ts"
    // starts at column 4, which Markdown reads as an indented code block and
    // pi-tui draws inside ``` fences — so ordinary command output was rendered
    // as syntax-highlighted code.
    const raw = lead('    file1\n    file2');
    assert.equal(raw.fenced, true, 'raw 4-space output should fence');
    assert.equal(raw.first, ' ```', 'raw output should open with a fence line');
  });

  it('trims command output to the margin, with no fence and no source indentation', () => {
    // Cases are the shapes real shell output takes: a tree/ls listing that
    // starts indented, output preceded by blank lines, and a padded one-liner.
    const cases: Array<[string, string, string]> = [
      ['4-space indented', '    file1\n    file2', ' file1'],
      ['leading newlines', '\n\n\nDone in 1.2s\n', ' Done in 1.2s'],
      ['leading spaces', '   ok\n', ' ok'],
    ];
    for (const [name, src, wantFirst] of cases) {
      assert.deepEqual(lead(src.trim()), { blanks: MARGIN, fenced: false, first: wantFirst }, name);
    }
  });

  it('trims leading blank lines from streamed agent output', () => {
    // The agent path uses trimStart, not trim: trailing whitespace is
    // provisional mid-stream, and Markdown's two-space soft break would
    // flicker if it were stripped on every delta.
    const raw = lead('\n\nI fixed the bug.');
    const trimmed = lead('\n\nI fixed the bug.'.trimStart());
    assert.equal(raw.blanks, MARGIN + 1, 'untrimmed reply should show an extra blank row');
    assert.equal(trimmed.blanks, MARGIN, 'trimStart should leave only the component margin');
    assert.equal(trimmed.first, ' I fixed the bug.');
  });

  it('preserves interior indentation that the author intended', () => {
    // Trimming only removes leading whitespace; a nested listing keeps its
    // indentation instead of being flattened to column 1. Rendered lines are
    // right-padded to the full width, so compare visible text only.
    const lines = render('src\n    a.ts\n    b.ts'.trim())
      .filter((l) => l.trim() !== '')
      .map((l) => l.replace(/\s+$/, ''));
    assert.deepEqual(lines, [' src', '     a.ts', '     b.ts']);
    assert.equal(lead('src\n    a.ts\n    b.ts'.trim()).fenced, false);
  });

  it('still renders an intended code block as a code block after trimming', () => {
    // trimStart must not flatten real Markdown structure: a reply that opens
    // with prose and then indents a code block keeps it as a code block.
    assert.equal(lead("Here's the code:\n\n    indented thing".trim()).fenced, true);
  });
});