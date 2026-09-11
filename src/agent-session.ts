/**
 * Interactive pi-agent session that uses model_proxy_v3's own HTTP server as
 * its LLM provider (loopback /v1/messages). Started via AGENT=true, mirroring
 * the TUI=true convention in server.ts.
 *
 * Flow: pick working directory -> pick model -> verify with "hi, which model
 * and agent are right here?" -> set a budget (tokens or turns) -> state the
 * task -> run -> summarize file changes
 * -> prompt for a follow-up task (same agent/budget) until blank/budget hit.
 */
import { randomUUID } from 'crypto';
import { access, constants as fsConstants, mkdir, readFile, readdir, stat } from 'fs/promises';
import { closeSync, openSync, writeSync } from 'fs';
import { resolve, relative, join } from 'path';
import { tmpdir, homedir } from 'os';
import { execFile } from 'child_process';
import {
  ProcessTerminal,
  SelectList,
  TUI,
  Input,
  getKeybindings,
  type Component,
  type SelectItem,
} from '@earendil-works/pi-tui';
import { Agent, loadSkills, formatSkillInvocation, type Skill } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { createModels, createProvider, type Model } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import type { Env } from './types/shared.js';
import type { ProxyConfig } from './utils/config-loader.js';
import { getConfiguredModelIds } from './utils/config-loader.js';
import { createAgentTools } from './agent-tools.js';

export interface AgentSessionSource {
  env: Env;
  loadConfig: (forceReload?: boolean) => Promise<ProxyConfig>;
  port: number;
}

// Dark gray (ANSI 90) wrapper for this session's own status/notice output
// (console.log), so it reads as dimmed background chatter against the
// agent's own streamed reply text. console.error output is left plain —
// those signal actual failures and should stay visually distinct.
function dim(text: string): string {
  return `\x1b[90m${text}\x1b[0m`;
}

// eslint-disable-next-line no-control-regex
const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

// TRAJ=true/1 records this session's full console output (status lines, tool
// calls/results, replies) to a flat trajectory log, unrelated to LOG_LEVEL/
// AGENT_MODE's terminal-only dimming above. Path uses os.tmpdir() (not a
// hardcoded /tmp — see the same fix in agent-tools.ts's TMP_ROOT_RAW) so it
// still lands under the real OS temp root when $TMPDIR is set. Opt-in and
// off by default.
//
// The filename carries a per-session random suffix rather than being a fixed,
// predictable path. On Linux os.tmpdir() is normally the shared world-writable
// /tmp, where a fixed name is a symlink-attack target: any local user can
// pre-create it as a link to a file this user can write, and appendFileSync
// follows it — redirecting the whole transcript (task text, file contents in
// tool results) into an attacker-chosen file and clobbering it. A fresh name
// per session also means runs no longer accumulate into one file.
function buildTrajectoryLogPath(): string {
  return join(tmpdir(), `agent_trajectory-${randomUUID().slice(0, 8)}.log`);
}
function isTrajectoryLoggingEnabled(): boolean {
  return process.env.TRAJ === 'true' || process.env.TRAJ === '1';
}

const PROVIDER_ID = 'model-proxy-v3';
const SYSTEM_PROMPT_FILENAMES = ['AGENTS.md', 'CLAUDE.md'];
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful coding assistant.';
// Explicit end-the-session commands for the follow-up task prompt, alongside
// blank input (both end the loop before the budget is reached).
const QUIT_COMMANDS = new Set(['/q', '/quit', '/exit']);
// Confirmed via the `skills` CLI's own bundled agent registry (vercel-labs/skills,
// dist/cli.mjs): the "pi" agent target's global skills dir is ~/.pi/agent/skills,
// distinct from project-scoped ".pi/skills" (used by add_skill, agent-tools.ts) and
// distinct from other agents' global dirs (~/.claude/skills etc. are not pi-scoped).
const GLOBAL_SKILLS_DIR = resolve(homedir(), '.pi/agent/skills');

// ---------------------------------------------------------------------------
// Minimal standalone pi-tui screens (picker + text prompt). The full
// DashboardApp/ListOverlay machinery in tui.ts is built for a persistent,
// continuously-redrawing dashboard with overlays layered on top of it; this
// session only ever shows one linear screen at a time, so it drives its own
// throwaway TUI instance per screen instead of reusing that scaffolding.
// ---------------------------------------------------------------------------

class PickerScreen implements Component {
  private readonly list: SelectList;
  constructor(
    private readonly title: string,
    items: SelectItem[],
  ) {
    this.list = new SelectList(items, 12, {
      selectedPrefix: (t) => `> ${t}`,
      selectedText: (t) => `\x1b[1m${t}\x1b[0m`,
      description: (t) => `\x1b[2m${t}\x1b[0m`,
      scrollInfo: (t) => `\x1b[2m${t}\x1b[0m`,
      noMatch: (t) => `\x1b[2m${t}\x1b[0m`,
    });
  }
  get selectList(): SelectList {
    return this.list;
  }
  handleInput(data: string): void {
    this.list.handleInput(data);
  }
  invalidate(): void {
    this.list.invalidate();
  }
  render(width: number): string[] {
    return [this.title, '', ...this.list.render(width)];
  }
}

/** Show a single-selection picker in its own throwaway TUI screen; resolves with the chosen value, or null on cancel (Ctrl+C/Esc). */
async function pickFromList(title: string, items: SelectItem[]): Promise<string | null> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const screen = new PickerScreen(title, items);
  return new Promise((resolvePick) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      tui.stop();
      resolvePick(value);
    };
    screen.selectList.onSelect = (item) => finish(item.value);
    screen.selectList.onCancel = () => finish(null);
    tui.addChild(screen);
    tui.setFocus(screen);
    tui.start();
  });
}

const MULTISELECT_THEME = {
  selectedPrefix: (t: string) => `> ${t}`,
  selectedText: (t: string) => `\x1b[1m${t}\x1b[0m`,
  description: (t: string) => `\x1b[2m${t}\x1b[0m`,
  scrollInfo: (t: string) => `\x1b[2m${t}\x1b[0m`,
  noMatch: (t: string) => `\x1b[2m${t}\x1b[0m`,
};

/** Checkbox-style picker screen. SelectList has no public "replace items" method
 *  (its `items`/`filteredItems` fields are private, only set via the constructor
 *  or narrowed via setFilter), so toggling a checkbox rebuilds a fresh SelectList
 *  with updated `[x]`/`[ ]` label prefixes and restores the cursor position —
 *  cheap given these lists are small (installed/candidate skills, not thousands
 *  of items). Space toggles the highlighted item; Enter confirms the whole
 *  checked set; Escape/Ctrl+C cancels (same tui.select.cancel keys pickFromList
 *  already relies on). */
class MultiSelectScreen implements Component {
  private list: SelectList;
  private readonly checked = new Set<string>();
  onConfirm?: (values: Set<string>) => void;
  onCancel?: () => void;
  constructor(
    private readonly title: string,
    private readonly baseItems: SelectItem[],
  ) {
    this.list = this.buildList(0);
  }
  private buildList(selectedIndex: number): SelectList {
    const items = this.baseItems.map((item) => ({
      ...item,
      label: `${this.checked.has(item.value) ? '[x]' : '[ ]'} ${item.label}`,
    }));
    const list = new SelectList(items, 12, MULTISELECT_THEME);
    list.setSelectedIndex(selectedIndex);
    return list;
  }
  private toggleCurrent(): void {
    // buildList only prefixes `label`, not `value` — getSelectedItem()'s
    // `.value` is unchanged from baseItems, so it's usable directly as the
    // checked-set key without stripping anything back off.
    const current = this.list.getSelectedItem();
    if (!current) return;
    if (this.checked.has(current.value)) {
      this.checked.delete(current.value);
    } else {
      this.checked.add(current.value);
    }
    const selectedIndex = this.baseItems.findIndex((i) => i.value === current.value);
    this.list = this.buildList(selectedIndex);
  }
  handleInput(data: string): void {
    if (data === ' ') {
      this.toggleCurrent();
      return;
    }
    const kb = getKeybindings();
    if (kb.matches(data, 'tui.select.confirm')) {
      this.onConfirm?.(this.checked);
      return;
    }
    if (kb.matches(data, 'tui.select.cancel')) {
      this.onCancel?.();
      return;
    }
    this.list.handleInput(data);
  }
  invalidate(): void {
    this.list.invalidate();
  }
  render(width: number): string[] {
    return [this.title, ...this.list.render(width)];
  }
}

/** Show a checkbox-style multi-selection picker; resolves with the set of
 *  checked values (possibly empty — declining all candidates is valid), or
 *  null on cancel (Ctrl+C/Esc). Space toggles, Enter confirms. */
async function pickMultiFromList(title: string, items: SelectItem[]): Promise<Set<string> | null> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const fullTitle = `${title}\n(space: toggle, enter: confirm)`;
  const screen = new MultiSelectScreen(fullTitle, items);
  return new Promise((resolvePick) => {
    let settled = false;
    const finish = (value: Set<string> | null) => {
      if (settled) return;
      settled = true;
      tui.stop();
      resolvePick(value);
    };
    screen.onConfirm = (values) => finish(values);
    screen.onCancel = () => finish(null);
    tui.addChild(screen);
    tui.setFocus(screen);
    tui.start();
  });
}

class PromptScreen implements Component {
  private readonly input = new Input();
  constructor(
    private readonly title: string,
    defaultValue = '',
  ) {
    this.input.setValue(defaultValue);
    // setValue() leaves the cursor at 0 (its construction-time default),
    // clamped rather than moved — so a prefilled default (e.g. the cwd)
    // renders with the cursor at the start of the line. Send the
    // cursorLineEnd keybinding (ctrl+e, \x05) to place it at the end, same
    // as if the user had pressed End/ctrl+e themselves.
    this.input.handleInput('\x05');
  }
  get inputComponent(): Input {
    return this.input;
  }
  handleInput(data: string): void {
    this.input.handleInput(data);
  }
  invalidate(): void {
    this.input.invalidate();
  }
  render(width: number): string[] {
    // Split on \n so a caller can pass a multi-line title (e.g. moving a long
    // clause to its own line) — each line must be a separate array element,
    // since the TUI renderer tracks one row per element for cursor repositioning.
    // No blank row between title and input (removed to place '>' directly under title).
    return [...this.title.split('\n'), ...this.input.render(width)];
  }
}

/** Show a single-line text prompt in its own throwaway TUI screen; resolves with the entered text (possibly ''), or null on cancel. */
async function promptText(title: string, defaultValue = ''): Promise<string | null> {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);
  const screen = new PromptScreen(title, defaultValue);
  return new Promise((resolvePrompt) => {
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      tui.stop();
      // Blank line after a submitted answer so whatever follows (status lines,
      // the agent's streamed reply, the next prompt) doesn't butt up against
      // the input line. Skipped on cancel (null), where the session is exiting
      // and the caller prints its own "Cancelled/exiting" notice anyway.
      if (value !== null) console.log('');
      resolvePrompt(value);
    };
    screen.inputComponent.onSubmit = (value) => finish(value);
    screen.inputComponent.onEscape = () => finish(null);
    tui.addChild(screen);
    tui.setFocus(screen);
    tui.start();
  });
}

// ---------------------------------------------------------------------------
// Working directory
// ---------------------------------------------------------------------------

async function isWritable(dir: string): Promise<boolean> {
  try {
    await access(dir, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the user-chosen working directory, creating it if needed and falling back to /tmp when unwritable. Returns the final dir plus a note if a fallback happened. */
async function resolveWorkDir(input: string): Promise<{ dir: string; fallbackNotice: string | null }> {
  const requested = resolve(input.trim() || process.cwd());
  try {
    await mkdir(requested, { recursive: true });
  } catch {
    // fall through to writability check / fallback below
  }
  if (await isWritable(requested)) {
    return { dir: requested, fallbackNotice: null };
  }
  const fallback = resolve(tmpdir(), `task-${randomUUID().slice(0, 8)}`);
  await mkdir(fallback, { recursive: true });
  return {
    dir: fallback,
    fallbackNotice: `"${requested}" is not writable — using "${fallback}" instead.`,
  };
}

async function loadSystemPrompt(workDir: string): Promise<string> {
  for (const filename of SYSTEM_PROMPT_FILENAMES) {
    try {
      const content = await readFile(resolve(workDir, filename), 'utf-8');
      if (content.trim()) return content;
    } catch {
      // not found / unreadable — try next filename
    }
  }
  return DEFAULT_SYSTEM_PROMPT;
}

// The `skills` CLI's own lock file, recording where each skill installed
// globally for *any* agent (via `skills add -g`) came from — confirmed fixed
// path by reading the CLI's own source (dist/cli.mjs: join(homedir(),
// '.agents', '.skill-lock.json')). Reading it directly avoids depending on
// `npx skills list -g`'s human-oriented (non-JSON, ANSI-colored) output as a
// parse target.
const SKILL_LOCK_PATH = resolve(homedir(), '.agents/.skill-lock.json');

interface SkillLockEntry {
  source: string;
}
interface SkillLockFile {
  skills?: Record<string, SkillLockEntry>;
}

/** A skill the user can choose to load for this session. Pi-scoped candidates
 *  (`skill` set) are already loadable as-is. Other-agent candidates
 *  (`installSource` set) need `skills add <installSource> --agent pi` run
 *  first — see loadSelectedSkills. */
interface SkillCandidate {
  item: SelectItem;
  skill?: Skill;
  installSource?: string;
}

/** Reads the skills-CLI lock file for skills installed globally for *other*
 *  agents (e.g. Claude Code, Codex) that aren't yet installed for `pi`.
 *  `alreadyKnownNames` (the pi-scoped candidates) are excluded so an already-pi
 *  skill doesn't also show up as an "other agent" candidate. Missing/unparseable
 *  lock file yields zero candidates — same "not a failure" posture as loadSkills
 *  skipping missing directories (a machine that never ran `skills add -g` for
 *  any agent is normal, not an error). `lockPath` is parameterized (default
 *  SKILL_LOCK_PATH) so this is testable without touching the real
 *  ~/.agents/.skill-lock.json. */
async function gatherOtherAgentCandidates(alreadyKnownNames: Set<string>, lockPath: string = SKILL_LOCK_PATH): Promise<SkillCandidate[]> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf-8');
  } catch {
    return [];
  }
  let lock: SkillLockFile;
  try {
    lock = JSON.parse(raw);
  } catch {
    console.log(dim(`[skills] failed to parse ${lockPath} — skipping other-agent candidates.`));
    return [];
  }
  const candidates: SkillCandidate[] = [];
  for (const [name, entry] of Object.entries(lock.skills ?? {})) {
    if (alreadyKnownNames.has(name) || !entry.source) continue;
    candidates.push({
      item: { value: name, label: name, description: `needs install — ${entry.source}` },
      installSource: entry.source,
    });
  }
  return candidates;
}

/** Gathers every skill the user could load for this session: skills already
 *  installed for `pi` (globally at ~/.pi/agent/skills, or project-scoped at
 *  <workDir>/.pi/skills) plus skills installed globally for other agents (via
 *  the shared skills-CLI lock file). Returns [] when nothing is found anywhere
 *  — a fresh machine with no skills installed for any agent, which is normal
 *  and not an error. `globalSkillsDir`/`lockPath` are parameterized (defaults
 *  GLOBAL_SKILLS_DIR/SKILL_LOCK_PATH) so this is testable without touching the
 *  real ~/.pi/agent/skills or ~/.agents/.skill-lock.json. */
export async function gatherSkillCandidates(
  workDir: string,
  globalSkillsDir: string = GLOBAL_SKILLS_DIR,
  lockPath: string = SKILL_LOCK_PATH,
): Promise<SkillCandidate[]> {
  // @earendil-works/pi-agent-core's loadSkills() walks directories via
  // NodeExecutionEnv, which resolves paths with node:path (backslashes on
  // win32), then hands them to its internal relativeEnvPath() — that function
  // does naive "/"-string slicing instead of path.relative(), so on win32 it
  // never strips the root prefix and passes a raw absolute Windows path into
  // the `ignore` package, which throws `RangeError: path should be a
  // path.relative()d string`. This reproduces on any real skill directory,
  // not just edge cases, so pi-scoped skill loading is disabled on win32
  // until upstream fixes it (lock-file-based other-agent candidates below
  // don't go through loadSkills(), so they're unaffected and stay enabled).
  // Tracked upstream against pi-agent-core.
  let piScoped: SkillCandidate[] = [];
  if (process.platform === 'win32') {
    console.log(dim('[skills] pi-scoped skill loading disabled on win32 (upstream pi-agent-core bug: relativeEnvPath mishandles backslash paths) — see agent-session.ts gatherSkillCandidates.'));
  } else {
    const env = new NodeExecutionEnv({ cwd: workDir });
    const projectSkillsDir = resolve(workDir, '.pi/skills');
    const { skills, diagnostics } = await loadSkills(env, [projectSkillsDir, globalSkillsDir]);
    for (const diag of diagnostics) {
      console.log(dim(`[skills] ${diag.code}: ${diag.message} (${diag.path})`));
    }
    piScoped = skills.map((skill) => ({
      item: { value: skill.name, label: skill.name, description: 'pi' },
      skill,
    }));
  }
  const otherAgent = await gatherOtherAgentCandidates(new Set(piScoped.map((c) => c.item.value)), lockPath);
  return [...piScoped, ...otherAgent];
}

/** Installs (for other-agent candidates) and formats the user-selected skills,
 *  returning the block to append to the system prompt (or '' if none were
 *  selected). Installing reuses the exact `skills add` invocation agent-tools.ts's
 *  add_skill tool already uses, so a candidate selected here behaves identically
 *  to one added mid-session. */
export async function loadSelectedSkills(workDir: string, candidates: SkillCandidate[], selected: Set<string>): Promise<string> {
  const env = new NodeExecutionEnv({ cwd: workDir });
  const formatted: string[] = [];
  const loadedNames: string[] = [];
  for (const candidate of candidates) {
    if (!selected.has(candidate.item.value)) continue;
    if (candidate.skill) {
      formatted.push(formatSkillInvocation(candidate.skill));
      loadedNames.push(candidate.skill.name);
      continue;
    }
    if (!candidate.installSource) continue;
    const name = candidate.item.value;
    console.log(dim(`[skills] installing "${name}" from "${candidate.installSource}" for pi...`));
    await new Promise<void>((resolvePromise, rejectPromise) => {
      execFile(
        'npx',
        ['skills', 'add', candidate.installSource!, '--skill', name, '--agent', 'pi', '-y', '-p'],
        { cwd: workDir, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
        (error) => (error ? rejectPromise(error) : resolvePromise()),
      );
    });
    const skillsDir = resolve(workDir, '.pi/skills');
    const { skills, diagnostics } = await loadSkills(env, skillsDir);
    const installed = skills.find((s) => s.name === name);
    if (!installed) {
      const diagText = diagnostics.map((d) => `${d.code}: ${d.message} (${d.path})`).join('; ');
      throw new Error(`"skills add" reported success but skill "${name}" was not found under ${skillsDir}.${diagText ? ` Diagnostics: ${diagText}` : ''}`);
    }
    formatted.push(formatSkillInvocation(installed));
    loadedNames.push(installed.name);
  }
  if (loadedNames.length === 0) return '';
  return formatted.join('\n\n');
}

/** Cheap availability probe for the `skills` CLI (vercel-labs/skills). Gates whether
 *  find_skill/add_skill are exposed at all — Rule 8: don't ship tools that are present
 *  but always fail. */
function probeSkillsCli(workDir: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    execFile('npx', ['skills', '--version'], { cwd: workDir, timeout: 15_000 }, (error) => {
      resolvePromise(!error);
    });
  });
}

// ---------------------------------------------------------------------------
// Budget parsing
// ---------------------------------------------------------------------------

// A budget is one or both limits; the run stops at whichever is hit first.
// Explicit prompt input always sets exactly one (parseBudget below); the
// blank-input default (DEFAULT_BUDGET) sets both.
export type Budget = { tokens?: number; turns?: number };

const BUDGET_TOKEN_PATTERN = /^(\d+(?:\.\d+)?)([kKmMbBtT])$/;
const BUDGET_BARE_PATTERN = /^(\d+(?:\.\d+)?)$/;
// Bare numbers >= this threshold are parsed as a token limit; smaller bare
// numbers are parsed as a turn count. 1000 makes the heuristic stable for
// everyday turn counts (20/40/200) while letting "2000" / "10000" land
// naturally on the token side without needing a `k` suffix.
const BUDGET_BARE_TOKEN_THRESHOLD = 1000;
const TOKEN_MULTIPLIERS: Record<string, number> = {
  k: 1_000, m: 1_000_000, b: 1_000_000_000, t: 1_000_000_000_000,
};

// Applied when the budget prompt is left blank OR submitted with its prefill
// unchanged (see startAgentSession). Turns is sized to be a runaway-loop
// backstop rather than the binding limit: at a realistic ~30k tokens/turn,
// 5m tokens is roughly 150 turns, so 100 turns keeps tokens as the constraint
// that normally trips first while still bounding a loop that makes no progress.
export const DEFAULT_BUDGET: Budget = { tokens: 5_000_000, turns: 100 };

// Prefilled into the budget prompt. Compared against the submitted value to
// detect "took the default", so it must stay in sync with DEFAULT_BUDGET.tokens.
export const BUDGET_PROMPT_DEFAULT = '5m';

/** Parse a single positive number (with optional k/m/b/t suffix) as a
 *  token limit. Returns null if the input isn't a positive number. */
function parseBudgetTokenValue(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const suffixed = BUDGET_TOKEN_PATTERN.exec(trimmed);
  if (suffixed) {
    const [, numStr, suffix] = suffixed;
    const num = Number(numStr);
    if (!Number.isFinite(num) || num <= 0) return null;
    return Math.round(num * TOKEN_MULTIPLIERS[suffix.toLowerCase()]);
  }
  const bare = BUDGET_BARE_PATTERN.exec(trimmed);
  if (!bare) return null;
  const num = Number(bare[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num);
}

/** Parse a single positive number as a turn count (no suffix allowed, but
 *  any magnitude is fine — a "10 200" turn cap is a valid though unusual
 *  shape). Returns null if the input isn't a positive integer. */
function parseBudgetTurnValue(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const bare = BUDGET_BARE_PATTERN.exec(trimmed);
  if (!bare) return null;
  const num = Number(bare[1]);
  if (!Number.isFinite(num) || num <= 0) return null;
  return Math.round(num);
}

/** Parse a budget-prompt reply. Three shapes:
 *    one number with k/m/b/t suffix (case-insensitive) -> token limit
 *    one bare number >= 1000                            -> token limit
 *    one bare number <  1000                            -> turn count
 *    two whitespace-separated numbers                   -> first = tokens
 *                                                         (with optional suffix),
 *                                                         second = turns
 *  Anything else (non-numeric, zero, negative, more than two tokens) returns
 *  null. Not parseHumanTokenLimit: that parser requires a mandatory duration
 *  suffix (e.g. "50k 1h", for rate-limit windows) and can't parse a standalone
 *  value. */
export function parseBudget(raw: string): Budget | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length === 0 || parts.length > 2) return null;
  if (parts.length === 1) {
    const tokens = parseBudgetTokenValue(parts[0]);
    if (tokens === null) return null;
    if (parts[0].match(BUDGET_TOKEN_PATTERN)) return { tokens };
    // Bare number: small = turns, large (>= 1000) = tokens.
    if (tokens < BUDGET_BARE_TOKEN_THRESHOLD) return { turns: tokens };
    return { tokens };
  }
  // Two-number form: first slot is always tokens, second is always turns.
  const tokens = parseBudgetTokenValue(parts[0]);
  const turns = parseBudgetTurnValue(parts[1]);
  if (tokens === null || turns === null) return null;
  return { tokens, turns };
}

/** Human-readable form for logging, e.g. "10 turns", "5,000,000 tokens", or "5,000,000 tokens / 10 turns" when both are set. */
export function formatBudget(budget: Budget): string {
  const parts: string[] = [];
  if (budget.tokens !== undefined) parts.push(`${budget.tokens.toLocaleString()} tokens`);
  if (budget.turns !== undefined) parts.push(`${budget.turns.toLocaleString()} turns`);
  return parts.join(' / ');
}

// ---------------------------------------------------------------------------
// workDir file-change tracking (for the post-run "files changed" summary)
// ---------------------------------------------------------------------------

const SNAPSHOT_IGNORED_DIRS = new Set(['.git', 'node_modules']);

/** Recursively maps every file under `workDir` to its mtime (ms). Used to
 *  diff before/after a task run and report what the agent created/modified —
 *  works regardless of whether workDir is a git repo. Skips .git/node_modules
 *  (noisy, not "generated stuff" from the agent's own task). Missing/unreadable
 *  entries are skipped rather than failing the whole snapshot (best-effort
 *  summary, not a critical path). */
export async function snapshotWorkDir(workDir: string): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SNAPSHOT_IGNORED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const fullPath = join(dir, entry.name);
        try {
          const st = await stat(fullPath);
          files.set(relative(workDir, fullPath), st.mtimeMs);
        } catch {
          // File removed/unreadable between readdir and stat — skip it.
        }
      }
    }
  }
  await walk(workDir);
  return files;
}

/** Diffs two snapshots into created/modified file lists, sorted for stable
 *  output. Deletions aren't reported — "generated stuff" is about what the
 *  agent produced, not what it removed. */
export function diffWorkDirSnapshots(before: Map<string, number>, after: Map<string, number>): { created: string[]; modified: string[] } {
  const created: string[] = [];
  const modified: string[] = [];
  for (const [path, mtime] of after) {
    const prevMtime = before.get(path);
    if (prevMtime === undefined) created.push(path);
    else if (prevMtime !== mtime) modified.push(path);
  }
  created.sort();
  modified.sort();
  return { created, modified };
}

// ---------------------------------------------------------------------------
// Provider wiring
// ---------------------------------------------------------------------------

function buildSelfModel(alias: string, port: number): Model<'anthropic-messages'> {
  return {
    id: alias,
    name: alias,
    api: 'anthropic-messages',
    provider: PROVIDER_ID,
    baseUrl: `http://127.0.0.1:${port}`,
    reasoning: false,
    input: ['text', 'image'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
}

/**
 * Order the model picker so the interesting aliases come first: composite
 * aliases (coordinator/fusion/fallback/share — the multi-target routing this
 * proxy exists to exercise), then schedule aliases, then the plain [models.*]
 * target models last. getConfiguredModelIds returns the opposite order
 * (targets first, aliases appended); it's shared with /v1/models, the TUI and
 * the dashboard, so this reordering is local to the picker rather than a
 * change to that shared function. Each group keeps its config order, and the
 * kind is shown as the item description so the grouping is visible, not just
 * implied by position — the kind only, not the composite mode
 * (coordinator/fusion/fallback/share), which is more detail than picking a
 * model calls for.
 */
export function buildModelPickerItems(aliases: string[], config: ProxyConfig): SelectItem[] {
  const composite: SelectItem[] = [];
  const schedule: SelectItem[] = [];
  const targets: SelectItem[] = [];
  for (const id of aliases) {
    if (config.composite?.[id]) {
      composite.push({ value: id, label: id, description: 'composite' });
    } else if (config.schedule?.[id]) {
      schedule.push({ value: id, label: id, description: 'schedule' });
    } else {
      targets.push({ value: id, label: id, description: 'target model' });
    }
  }
  return [...composite, ...schedule, ...targets];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function startAgentSession(source: AgentSessionSource): Promise<void> {
  const { env, loadConfig, port } = source;

  // TRAJ=true/1: tee console.log/console.error to a flat trajectory log for
  // the lifetime of this session, restored in the top-level finally below.
  // Wrapping console here (rather than each of the ~25 call sites in this
  // file) mirrors the existing console.log override in server.ts's TUI=true
  // branch. ANSI color codes are stripped for the file (dim() is a
  // terminal-only concern); the console itself keeps its normal formatting.
  const trajectoryEnabled = isTrajectoryLoggingEnabled();
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  let trajectoryFd: number | null = null;
  let trajectoryLogPath: string | null = null;
  if (trajectoryEnabled) {
    trajectoryLogPath = buildTrajectoryLogPath();
    // 'ax' = O_APPEND|O_CREAT|O_EXCL — fails rather than writing if the path
    // already exists, so a pre-planted file/symlink is refused outright.
    // O_NOFOLLOW additionally refuses a symlink at the final component even in
    // the race between the name being chosen and opened. Mode 0600: the
    // transcript can contain file contents and task text, so it must not be
    // readable by other users where tmpdir is shared. Opened once and held for
    // the session instead of re-resolving the path on every appendFileSync
    // call, which is what made the old code follow a swapped-in symlink.
    trajectoryFd = openSync(trajectoryLogPath, fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600);
    const writeLine = (prefix: string, args: unknown[]) => {
      const line = args.map((a) => (typeof a === 'string' ? stripAnsi(a) : String(a))).join(' ');
      // Blank lines are terminal-only spacing (see promptText) — same rationale
      // as stripping ANSI above, they carry no information in the log file.
      if (!line.trim()) return;
      writeSync(trajectoryFd!, `${new Date().toISOString()} ${prefix} ${line}\n`);
    };
    console.log = (...args: unknown[]) => {
      writeLine('[LOG]', args);
      originalConsoleLog(...args);
    };
    console.error = (...args: unknown[]) => {
      writeLine('[ERROR]', args);
      originalConsoleError(...args);
    };
    originalConsoleLog(dim(`[TRAJ] Recording session trajectory to ${trajectoryLogPath}`));
  }

  try {
    await runAgentSession(source);
  } finally {
    if (trajectoryEnabled) {
      console.log = originalConsoleLog;
      console.error = originalConsoleError;
      if (trajectoryFd !== null) closeSync(trajectoryFd);
    }
  }
}

/** The actual session flow, split out from startAgentSession so TRAJ's console
 *  patching (which must wrap every exit path, including early returns below)
 *  stays in one try/finally at the outer call site instead of being duplicated
 *  at each return. */
async function runAgentSession(source: AgentSessionSource): Promise<void> {
  const { env, loadConfig, port } = source;

  // Label the terminal window with the agent's own identity so it's
  // distinguishable from the proxy's other TUI/TRAJ sessions running
  // elsewhere. Only writes on a TTY — when stdout is piped (e.g. logged to
  // a file) the OSC 0 escape would just appear as garbage. The proxy
  // server's main process keeps its own title; on agent exit the two
  // user-facing paths below ("bye!" and "Budget reached") reset to the
  // shell default via the empty OSC-0 sequence, since the agent's job
  // there is done. Early-return paths (no model picked, cancelled
  // prompt, missing API key) skip the restore on purpose — the process
  // is still the proxy server and there is nothing to hand back.
  const agentTitle = 'Agent launched in model proxy v3';
  const isStdoutTty = Boolean(process.stdout.isTTY);
  if (isStdoutTty) {
    process.stdout.write(`\x1b]0;${agentTitle}\x07`);
  }
  const restoreTerminalTitle = () => {
    if (isStdoutTty) process.stdout.write(`\x1b]0;\x07`);
  };

  // No OS-level sandbox: the bash tool runs commands via a plain `/bin/sh -c`
  // child process with this user's full privileges (see README "Tool safety
  // limits") — pi-agent-core itself provides no sandboxing either. Only the
  // path-confinement/denylist checks in agent-tools.ts apply, and those are
  // raw string/regex matching, not enforced by the OS. Printed unconditionally
  // at session start so this is visible before any prompt (Rule 8: fail loud).
  console.log('[WARNING] No OS-level sandbox — bash/write_file run with this user\'s full privileges,')
  console.log(dim('confined only by this session\'s own path/command checks (see README "Tool safety limits").'));

  const dirInputRaw = await promptText('\nWorking directory (default: current dir):', process.cwd());
  if (dirInputRaw === null) {
    console.log(dim('Cancelled — exiting agent session.\nbye!'));
    return;
  }
  const dirInput = dirInputRaw || process.cwd();
  const { dir: workDir, fallbackNotice } = await resolveWorkDir(dirInput);
  if (fallbackNotice) {
    console.log(dim(fallbackNotice));
  }
  const baseSystemPrompt = await loadSystemPrompt(workDir);
  console.log(dim('[check] global/project skills...'));
  const skillCandidates = await gatherSkillCandidates(workDir);
  let startupSkills = '';
  let skillsUsed = 0;
  // Hoisted so the process-log line below can render the names of the skills
  // the user actually loaded for this run, not just a count. Empty when there
  // were no candidates to pick from in the first place.
  let selected: Set<string> = new Set();
  if (skillCandidates.length > 0) {
    selected = (await pickMultiFromList(
      'Select skills to load for this task:',
      skillCandidates.map((c) => c.item),
    ))!;
    if (selected === null) {
      console.log(dim('Cancelled — exiting agent session.\nbye!'));
      return;
    }
    skillsUsed = selected.size;
    startupSkills = await loadSelectedSkills(workDir, skillCandidates, selected);
  }
  const systemPrompt = startupSkills ? `${baseSystemPrompt}\n\n${startupSkills}` : baseSystemPrompt;

  // npx has to resolve the "skills" package even when it's installed locally,
  // which can take a few seconds with no output of its own — print a notice
  // first so this doesn't look like a silent hang (Rule 8).
  console.log(dim('[check] "skills" CLI...'));
  const skillsCliAvailable = await probeSkillsCli(workDir);
  if (!skillsCliAvailable) {
    console.log(dim('[INFO] "skills" CLI not found (npx skills --version failed) — find_skill/add_skill tools disabled for this session.'));
    console.log(dim('       To enable them: run `npm install skills`, then verify with `npx skills find <query>`.'));
  }

  const config = await loadConfig();
  const aliases = getConfiguredModelIds(config);
  if (aliases.length === 0) {
    console.error('[proxy] No models configured in proxy_config.toml — nothing to select. Aborting agent session.');
    return;
  }

  // Resolve a key to auth the loopback /v1/messages call with, same
  // precedence tui.ts's own model-test call already uses (PROXY_CLIENT_API_KEY
  // override, else the proxy's own default_upstream.default_api_key, else
  // DEV_NO_KEY): without this, every verification attempt 401s from the
  // proxy's own auth check (src/index.ts) no matter which model is picked,
  // which previously showed up as an unexplained infinite "pick a different
  // model" loop (Rule 8: fail loud once, up front, instead of looping silently).
  const devNoKey = env.DEV_NO_KEY === 'true' || env.DEV_NO_KEY === '1';
  const agentMode = env.AGENT === 'true' || env.AGENT === '1';
  const defaultAgentKey = agentMode ? 'sk-hi-agent-launched-in-proxy-v3' : undefined;
  const clientApiKey = env.PROXY_CLIENT_API_KEY || defaultAgentKey || config.default_upstream?.default_api_key;
  if (!clientApiKey && !devNoKey && !defaultAgentKey) {
    console.error(
      '[proxy] Cannot start an agent session: no client API key available to authenticate the loopback\n' +
      dim(' /v1/messages call. Set PROXY_CLIENT_API_KEY, configure [default_upstream] default_api_key\n') +
      dim(' in proxy_config.toml, or set DEV_NO_KEY=true. Aborting agent session.'),
    );
    return;
  }

  // Proxy-request logging (e.g. "/v1/messages for ... to ..." and the
  // per-request upstream summary line, both logged at info) is very noisy
  // against the compact [tool]/streamed-text output this session already
  // prints below, and floods the terminal turn-over-turn — suppress it for
  // the remainder of the interactive session by lowering the shared env's
  // LOG_LEVEL (env is the same object every request handler reads its logger
  // from), restoring the original value on exit so background/non-agent
  // traffic logging is unaffected once the session ends. Done here, before
  // the verification call, so even the model-picker's verification round-trip
  // doesn't print the proxy's per-request info lines.
  const models = createModels();
  const provider = createProvider({
    id: PROVIDER_ID,
    baseUrl: `http://127.0.0.1:${port}`,
    auth: {
      apiKey: clientApiKey
        ? { name: 'model_proxy_v3 client key', resolve: async () => ({ auth: { apiKey: clientApiKey } }) }
        : { name: 'model_proxy_v3 (DEV_NO_KEY)', resolve: async () => ({ auth: {} }) },
    },
    models: aliases.map((alias) => buildSelfModel(alias, port)),
    api: anthropicMessagesApi(),
  });
  models.setProvider(provider);

  let selectedAlias: string | null = null;
  let agent: Agent | null = null;

  while (!selectedAlias) {
    const choice = await pickFromList(
      '\nSelect a model (Esc to cancel):',
      buildModelPickerItems(aliases, config),
    );
    if (!choice) {
      console.log(dim('No model selected — exiting agent session.\nbye!'));
      return;
    }
    const model = models.getModel(PROVIDER_ID, choice);
    if (!model) {
      console.error(`[proxy] Internal error: model "${choice}" not found on provider after selection.`);
      continue;
    }

    // candidateRef lets the skill tools reach the live Agent's system prompt
    // (agent.state.systemPrompt) even though tools must be built before the
    // Agent that will hold them is constructed.
    const candidateRef: { current: Agent | null } = { current: null };
    const candidate = new Agent({
      initialState: {
        systemPrompt,
        model,
        tools: createAgentTools(workDir, {
          skillsCliAvailable,
          getSystemPrompt: () => candidateRef.current!.state.systemPrompt,
          setSystemPrompt: (prompt: string) => {
            candidateRef.current!.state.systemPrompt = prompt;
          },
        }),
      },
      streamFn: models.streamSimple.bind(models),
    });
    candidateRef.current = candidate;

    console.log(dim(`[verify] checking proxy v3 with model `) + choice + dim(`, says: hi, which model and agent are right here?`));
    let replyText = '';
    let sawError = false;
    const unsubscribe = candidate.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        replyText += event.assistantMessageEvent.delta;
      }
      if (event.type === 'agent_end') {
        const last = candidate.state.messages[candidate.state.messages.length - 1] as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
        if (last?.role === 'assistant' && last.stopReason === 'error') {
          sawError = true;
          console.error(`[verify] verifying failed: ${last.errorMessage ?? 'unknown error'}`);
        }
      }
    });
    try {
      await candidate.prompt('hi, which model and agent are right here?');
    } catch (err) {
      sawError = true;
      console.error(`[verify] verifying failed: ${(err as Error).message}`);
    } finally {
      unsubscribe();
    }

    if (sawError || !replyText.trim()) {
      if (!sawError) console.error('[verify] verifying failed: model returned an empty reply.');
      console.log(dim('Pick a different model.'));
      continue;
    }

    console.log(dim(`[reply] ${replyText.trim()}`));
    selectedAlias = choice;
    agent = candidate;
  }

  if (!agent) return; // unreachable, satisfies TS narrowing

  // -- Budget prompt --
  let budget: Budget | null = null;
  while (!budget) {
    const raw = await promptText(
      '\n[budget] Set task budget (e.g. 1000000 or 1m for tokens, e.g. 40 for turns), /quit or /exit to end.\nOr leave blank as DEFAULT budget (5m tokens && 100 turns):',
      BUDGET_PROMPT_DEFAULT,
    );
    if (raw === null || QUIT_COMMANDS.has(raw.trim().toLowerCase())) {
      console.log(dim('No budget entered — exiting agent session.\nbye!'));
      return;
    }
    // Blank input and accepting the "5m" prefill unchanged both mean "the
    // default" — so both yield the combined DEFAULT_BUDGET. Without this,
    // submitting the prefill would run parseBudget('5m') = tokens-only and
    // silently drop the turn cap, making the two ways of taking the default
    // behave in opposite ways (one nearly unbounded, one capped).
    if (!raw.trim() || raw.trim().toLowerCase() === BUDGET_PROMPT_DEFAULT) {
      budget = DEFAULT_BUDGET;
      break;
    }
    budget = parseBudget(raw);
    if (!budget) {
      console.error(`[budget] Could not parse "${raw}" — enter a bare integer for turns (e.g. 20) or a k/m-suffixed value for tokens (e.g. 50k), or leave blank for the default.`);
    }
  }
  console.log(dim(`[Budget: ${formatBudget(budget)}]`));

  // Proxy-request logging (e.g. "/v1/messages for ... to ..." and the
  // per-request upstream summary line, both logged at info) is very noisy
  // against the compact [tool]/streamed-text output this session already
  // prints below, and floods the terminal turn-over-turn — suppress it for
  // the remainder of the interactive session by lowering the shared env's
  // LOG_LEVEL (env is the same object every request handler reads its logger
  // from), restoring the original value on exit so background/non-agent
  // traffic logging is unaffected once the session ends.

  // -- Budget enforcement --
  // The Agent class does not forward shouldStopAfterTurn to the underlying
  // loop (that field only exists on AgentLoopConfig, consumed by the
  // low-level agentLoop()/runAgentLoop() functions — confirmed by reading
  // Agent.createLoopConfig() in dist/agent.js, which never includes it).
  // So budget enforcement here uses the Agent class's actual control
  // surface: turn_end subscribers are awaited before the loop starts
  // another LLM call, so calling agent.abort() from one stops the run
  // gracefully after the current turn — the same "stop after this turn"
  // semantics shouldStopAfterTurn documents, via abort() instead. Usage
  // accumulates across follow-up tasks in the loop below (not reset per
  // task) — the budget is for the whole session, same as the original design.
  let turnsUsed = 0;
  let tokensUsed = 0;
  let toolsUsed = 0;
  let resultsReceived = 0;
  // Names of skills that have actually been invoked in this run (de-duped).
  // Populated as the agent's message stream references them; rendered in the
  // process-log line so a long skill-driven turn is visibly attributable
  // rather than just "1 skills".
  const skillsUsedNames: string[] = [];
  // Names of tools the agent has called so far (de-duped) plus the in-flight
  // one — rendered as `<a, b, c>` in the process-log line so the user can
  // see what's currently happening without scrolling the transcript.
  const toolsUsedNames: string[] = [];
  // Names of tools currently in-flight (start without matching end). Joined
  // with toolsUsedNames in the log so a tool that's been running a while is
  // still visible at the tail of the list.
  const pendingToolNames: string[] = [];
  // Print a process-log line in place by clearing the current row and
  // returning the cursor to column 0 — successive calls overwrite each
  // other so the terminal shows the latest totals on a single line, rather
  // than one line per tool/result event. `\x1b[K` also erases anything a
  // third-party logger (e.g. the proxy's own per-request lines) wrote on
  // the same row in between, so our next print is the only thing visible
  // on it. A final `\n` is emitted once the run settles (see end of task
  // loop) so the next prompt starts on its own row, not stranded on this
  // one. No-op when stdout isn't a TTY (e.g. piped to a file) — the
  // carriage return would just corrupt the log.
  const isTty = Boolean(process.stdout.isTTY);
  // Ticks 0..2 every 400ms while the agent is running, so the trailing
  // dots on the process-log line animate `.` -> `..` -> `...` -> `.`
  // and visibly indicate progress during the whole turn (including
  // LLM-only steps with no tools, which can take several seconds for
  // larger models — without dots the line looks frozen between the
  // user's input and the first text delta). The interval is started
  // when a run begins and cleared when it settles, so idle time
  // between turns doesn't burn a timer. No-op (and no interval
  // created) when stdout isn't a TTY.
  let progressTick = 0;
  let progressInterval: ReturnType<typeof setInterval> | null = null;
  const stopProgressInterval = () => {
    if (progressInterval !== null) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
    progressTick = 0;
  };
  const startProgressInterval = () => {
    if (progressInterval !== null || !isTty) return;
    progressInterval = setInterval(() => {
      progressTick = (progressTick + 1) % 3;
      printProcessLog();
    }, 400);
  };
  const printProcessLog = () => {
    const skillsList = selected.size > 0 ? `(${[...selected].join(',')})` : '';
    // De-duped union of completed tool calls plus any still in flight, so
    // a long-running tool stays visible at the tail of the list rather
    // than vanishing between start and end.
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const name of [...toolsUsedNames, ...pendingToolNames]) {
      if (!seen.has(name)) { seen.add(name); ordered.push(name); }
    }
    const toolsList = ordered.length > 0 ? `(${ordered.join(',')})` : '';
    // Only animate dots while at least one tool is in flight; idle turns
    // show a stable suffix so the line doesn't keep flickering for no
    // reason between the agent's text deltas.
    const dots = pendingToolNames.length > 0 ? ` ${'.'.repeat(progressTick + 1)}` : '';
    const line = dim(`[${skillsUsed} skills, ${toolsUsed} tools, ${resultsReceived} results] ${skillsList}|${toolsList} ${dots}`);
    if (isTty) {
      process.stdout.write(`\r\x1b[K${line}`);
    } else {
      console.log(line);
    }
  };
  const commitProcessLog = () => {
    if (isTty) process.stdout.write('\n');
  };
  // Set when the first text delta of a turn has moved past the in-place
  // process-log line (so we know to leave the cursor alone on subsequent
  // deltas). Reset to false at the start of every new task below.
  let committedForTurn = false;
  let budgetHit = false;
  const runningAgent = agent;

  const unsubscribeBudget = runningAgent.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      // First text delta after the process log: move to a fresh line so the
      // agent's reply doesn't sit on the same row as the in-place log line.
      if (isTty && !committedForTurn) {
        process.stdout.write('\n');
        committedForTurn = true;
      }
      process.stdout.write(event.assistantMessageEvent.delta);
    }
    if (event.type === 'tool_execution_start') {
      toolsUsed += 1;
      if (!toolsUsedNames.includes(event.toolName)) toolsUsedNames.push(event.toolName);
      pendingToolNames.push(event.toolName);
      startProgressInterval();
      printProcessLog();
    }
    if (event.type === 'tool_execution_end') {
      resultsReceived += 1;
      // Remove one matching pending entry — if the same tool name ran in
      // parallel, each end should pop one start, not the first match only.
      const idx = pendingToolNames.indexOf(event.toolName);
      if (idx !== -1) pendingToolNames.splice(idx, 1);
      if (pendingToolNames.length === 0) {
        progressTick = 0;
        stopProgressInterval();
      }
      printProcessLog();
    }
    if (event.type === 'turn_end') {
      turnsUsed += 1;
      const msg = event.message as { role?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } };
      if (msg.role === 'assistant' && msg.usage) {
        tokensUsed += msg.usage.input + msg.usage.output + msg.usage.cacheRead + msg.usage.cacheWrite;
      }
      const exceeded =
        (budget!.turns !== undefined && turnsUsed >= budget!.turns) ||
        (budget!.tokens !== undefined && tokensUsed >= budget!.tokens);
      if (exceeded) {
        budgetHit = true;
        runningAgent.abort();
      }
    }
  });

  try {
    // -- Task loop: run a task, summarize what changed, ask for the next one --
    // Follow-up input also doubles as how you answer a clarifying question the
    // agent asked at the end of its last turn (e.g. "Want me to consolidate
    // them?") — it's appended to the same transcript via prompt(), not a fresh
    // conversation, so the agent picks up right where it left off. Blank input
    // or /q, /quit, /exit end the session early, without waiting for budget.
    let task = await promptText('\n[task] What do you want the agent to do?');
    while (task !== null && !QUIT_COMMANDS.has(task.trim().toLowerCase()) && task.trim() && !budgetHit) {
      committedForTurn = false;
      printProcessLog();
      const beforeSnapshot = await snapshotWorkDir(workDir);
      try {
        await runningAgent.prompt(task);
        while (!budgetHit && runningAgent.hasQueuedMessages()) {
          await runningAgent.continue();
        }
      } catch (err) {
        console.error(`\n[agent] Agent run failed: ${(err as Error).message}`);
      }

      // Commit the in-place process-log line so the post-run summary and the
      // "Next task" prompt each start on a fresh row instead of overwriting it.
      // Defensive: if the run died mid-tool (catch path, budget abort) without
      // a matching tool_execution_end, the interval might still be ticking.
      stopProgressInterval();
      commitProcessLog();

      const afterSnapshot = await snapshotWorkDir(workDir);
      const { created, modified } = diffWorkDirSnapshots(beforeSnapshot, afterSnapshot);
      const changeSummary = created.length === 0 && modified.length === 0
        ? '(No files are created or modified.)'
        : [
            created.length > 0 ? `created: ${created.join(', ')}` : null,
            modified.length > 0 ? `modified: ${modified.join(', ')}` : null,
          ].filter(Boolean).join(' | ');
      console.log(dim(
        `\n[${budgetHit ? 'Budget reached' : 'Task done'} (${tokensUsed} tokens, ${turnsUsed} turns used, budget limit: ${formatBudget(budget)})]\n` +
        `${changeSummary}\n`,
      ));

      if (budgetHit) {
        // Budget enforcement stops the agent, not the session — require an
        // explicit acknowledgment before exiting so this reads as a deliberate
        // stop, not a hang (Rule 8: fail loud, don't just trail off).
        commitProcessLog();
        await promptText('\nBudget reached — press enter or type /q to exit:');
        restoreTerminalTitle();
        break;
      }
      commitProcessLog();
      task = await promptText('\nNext task' + dim(` (/quit, /exit or ctrl+c to end)`) + ':');
    }
    // Sign off on a user-initiated exit (blank input, /q, /quit, /exit, or a
    // cancelled prompt). Not printed when the budget stopped the run — that
    // path already prints its own "Budget reached" acknowledgment above, and
    // the session ended on its own terms rather than because the user asked.
    if (!budgetHit) {
      commitProcessLog();
      console.log(dim('bye!'));
      restoreTerminalTitle();
    }
  } finally {
    unsubscribeBudget();
  }
}
