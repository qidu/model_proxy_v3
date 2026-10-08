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
import { tmpdir, homedir, platform } from 'os';
import { execFile } from 'child_process';
import { format } from 'util';
import {
  ProcessTerminal,
  SelectList,
  type TUI,
  TuiMainScreen,
  Input,
  getKeybindings,
  type Component,
  type Focusable,
  type SelectItem,
  Box,
  Spacer,
  Markdown,
  TruncatedText,
  type MarkdownTheme,
  type DefaultTextStyle,
} from '@earendil-works/pi-tui';
import { Agent, BACKGROUND_CONTEXT, loadSkills, formatSkillInvocation, type Skill } from '@earendil-works/pi-agent-core';
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node';
import { createModels, createProvider, type Model } from '@earendil-works/pi-ai';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { openAIResponsesApi } from '@earendil-works/pi-ai/api/openai-responses.lazy';
import { googleGenerativeAIApi } from '@earendil-works/pi-ai/api/google-generative-ai.lazy';
import { piMessagesApi } from '@earendil-works/pi-ai/api/pi-messages.lazy';
import type { Env } from './types/shared.js';
import type { ProxyConfig } from './utils/config-loader.js';
import { getConfiguredModelIds } from './utils/config-loader.js';
import { PROXY_PROVIDER_ID, buildProxyPiModel, proxyBaseUrlForApi, type ProxyApiType } from './utils/pi-model-catalog.js';
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

// Cross-platform shell resolution: cmd.exe on Windows, sh on Unix.
function getShell(): { command: string; args: string[] } {
  if (platform() === 'win32') {
    return { command: 'cmd', args: ['/c'] };
  }
  return { command: 'sh', args: ['-c'] };
}

/** Run a shell command in the given directory and return its stdout/stderr. */
async function runShellCommand(command: string, cwd: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  const shell = getShell();
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      shell.command,
      [...shell.args, command],
      { cwd, timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const signal = (error as (NodeJS.ErrnoException & { signal?: string }) | null)?.signal;
        if (error && signal) {
          rejectPromise(new Error(`Command was killed by signal ${signal} (not a timeout): ${command}`));
          return;
        }
        if (error && typeof error.code === 'string') {
          rejectPromise(new Error(`Failed to run command: ${error.message}`));
          return;
        }
        // ChildProcess from execFile has exitCode
        const child = (error as NodeJS.ErrnoException & { child?: { exitCode: number | null } })?.child;
        const code = child?.exitCode ?? (error ? 1 : 0);
        resolvePromise({ stdout: stdout || '', stderr: stderr || '', code });
      }
    );
  });
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

const PROVIDER_ID = PROXY_PROVIDER_ID;
const SYSTEM_PROMPT_FILENAMES = ['AGENTS.md', 'CLAUDE.md'];
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful coding assistant.';
// Explicit end-the-session commands for the follow-up task prompt, alongside
// blank input (both end the loop before the budget is reached).
const QUIT_COMMANDS = new Set(['/q', '/quit', '/exit', '/bye']);

// History management for user inputs (up to 100 entries, excludes command outputs)
const MAX_HISTORY_SIZE = 100;
const inputHistory: string[] = [];
let historyIndex = -1; // -1 means at the "new input" position (end of history)

/** Add a user input to history. Excludes empty strings and command outputs (lines starting with '['). */
function addToHistory(input: string): void {
  const trimmed = input.trim();
  if (!trimmed) return;
  // Don't add command output lines (they start with '[' like '[π shell]')
  if (trimmed.startsWith('[')) return;
  // Don't add quit commands
  if (QUIT_COMMANDS.has(trimmed.toLowerCase())) return;
  // Avoid consecutive duplicates
  if (inputHistory.length > 0 && inputHistory[inputHistory.length - 1] === trimmed) return;
  inputHistory.push(trimmed);
  if (inputHistory.length > MAX_HISTORY_SIZE) {
    inputHistory.shift();
  }
  historyIndex = inputHistory.length; // Reset to "new input" position
}

/** Get the previous history entry (older). Returns the entry or null if at the beginning. */
function historyPrev(): string | null {
  if (inputHistory.length === 0) return null;
  if (historyIndex <= 0) return null;
  historyIndex -= 1;
  return inputHistory[historyIndex];
}

/** Get the next history entry (newer). Returns the entry or null if at the end. */
function historyNext(): string | null {
  if (inputHistory.length === 0) return null;
  if (historyIndex >= inputHistory.length - 1) {
    historyIndex = inputHistory.length;
    return null; // Signal to clear input
  }
  historyIndex += 1;
  return inputHistory[historyIndex];
}

/** Reset history index to the "new input" position. */
function historyReset(): void {
  historyIndex = inputHistory.length;
}
// Confirmed via the `skills` CLI's own bundled agent registry (vercel-labs/skills,
// dist/cli.mjs): the "pi" agent target's global skills dir is ~/.pi/agent/skills,
// distinct from project-scoped ".pi/skills" (used by add_skill, agent-tools.ts) and
// distinct from other agents' global dirs (~/.claude/skills etc. are not pi-scoped).
const GLOBAL_SKILLS_DIR = join(homedir(), '.pi/agent/skills');

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
    return [dim(this.title), '', ...this.list.render(width)];
  }
}

/** Show a single-selection picker in its own throwaway TUI screen; resolves with the chosen value, or null on cancel (Ctrl+C/Esc). */
async function pickFromList(title: string, items: SelectItem[]): Promise<string | null> {
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
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
    return [dim(this.title), ...this.list.render(width)];
  }
}

/** Show a checkbox-style multi-selection picker; resolves with the set of
 *  checked values (possibly empty — declining all candidates is valid), or
 *  null on cancel (Ctrl+C/Esc). Space toggles, Enter confirms. */
async function pickMultiFromList(title: string, items: SelectItem[]): Promise<Set<string> | null> {
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
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
    historyReset();
  }
  get inputComponent(): Input {
    return this.input;
  }
  handleInput(data: string): void {
    // Handle up/down arrow keys for history navigation
    // Up: \x1b[A or \x1bOA, Down: \x1b[B or \x1bOB
    if (data === '\x1b[A' || data === '\x1bOA') {
      const prev = historyPrev();
      if (prev !== null) {
        this.input.setValue(prev);
        this.input.handleInput('\x05'); // Move cursor to end
      }
      return;
    }
    if (data === '\x1b[B' || data === '\x1bOB') {
      const next = historyNext();
      if (next !== null) {
        this.input.setValue(next);
        this.input.handleInput('\x05'); // Move cursor to end
      } else {
        // At the end of history, clear the input for new entry
        this.input.setValue('');
      }
      return;
    }
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
    return [...this.title.split('\n').map(dim), ...this.input.render(width)];
  }
}

/**
 * Wraps an Input to draw a full-width '─' rule above it, separating the pinned
 * bottom input row from the scrolling conversation. pi-tui ships no separator
 * component, and the root Box is constructed with paddingX 0, so children are
 * handed the full terminal width — the rule is drawn at exactly that width and
 * cannot wrap onto a second line.
 *
 * `focused` is forwarded because the Input only emits its CURSOR_MARKER when
 * focused, and the TUI needs that marker to place the hardware cursor. The inner
 * Input still renders at the full width: the rule adds a line rather than
 * columns, so there is nothing to subtract.
 */
export class RuledInput implements Component, Focusable {
  constructor(private readonly input: Input) {
    historyReset();
  }
  get focused(): boolean {
    return this.input.focused;
  }
  set focused(value: boolean) {
    this.input.focused = value;
  }
  handleInput(data: string): void {
    // Handle up/down arrow keys for history navigation
    // Up: \x1b[A or \x1bOA, Down: \x1b[B or \x1bOB
    if (data === '\x1b[A' || data === '\x1bOA') {
      const prev = historyPrev();
      if (prev !== null) {
        this.input.setValue(prev);
        this.input.handleInput('\x05'); // Move cursor to end
      }
      return;
    }
    if (data === '\x1b[B' || data === '\x1bOB') {
      const next = historyNext();
      if (next !== null) {
        this.input.setValue(next);
        this.input.handleInput('\x05'); // Move cursor to end
      } else {
        // At the end of history, clear the input for new entry
        this.input.setValue('');
      }
      return;
    }
    this.input.handleInput(data);
  }
  invalidate(): void {
    this.input.invalidate();
  }
  render(width: number): string[] {
    // A non-positive width (pathologically narrow or zero-width terminal)
    // yields no rule at all: String.repeat would throw RangeError, and
    // dim('') would emit stray SGR bytes for an invisible line.
    const rule = width > 0 ? dim('─'.repeat(width)) : '';
    return [rule, ...this.input.render(width)];
  }
}

/** Show a single-line text prompt in its own throwaway TUI screen; resolves with the entered text (possibly ''), or null on cancel. */
async function promptText(title: string, defaultValue = ''): Promise<string | null> {
  const terminal = new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
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
      if (value !== null) {
        console.log('');
        addToHistory(value);
      }
      resolvePrompt(value);
    };
    screen.inputComponent.onSubmit = (value) => finish(value);
    screen.inputComponent.onEscape = () => finish(null);
    tui.addChild(screen);
    tui.setFocus(screen);
    tui.start();
  });
}

// Persistent TUI state for the entire agent session
let persistentTui: TUI | null = null;
let persistentTerminal: ProcessTerminal | null = null;
let conversationArea: Box;
let statusBar: Box;
let proxyLogLine: Box;
let bottomInput: Input;
let currentAssistantMessage: Markdown | null = null;
let currentTaskMessage: Markdown | null = null;
let currentTaskText = '';
let isAgentRunning = false;
let nextTaskResolver: ((value: string | null) => void) | null = null;
let currentTheme: MarkdownTheme;
let dimStyle: DefaultTextStyle;
let errorStyle: DefaultTextStyle;

// Variables used in updateStatusBar and runAgentTurn (defined in runAgentSession scope, hoisted here for access)
let selected: Set<string> = new Set();
let skillsUsed = 0;
let toolsUsed = 0;
let resultsReceived = 0;
let toolsUsedNames: string[] = [];
let pendingToolNames: string[] = [];
let progressTick = 0;
let committedForTurn = false;
let runningAgent: Agent | null = null;
let budgetHit = false;
let quitRequested = false;
let budget: Budget | null = null;
let tokensUsed = 0;
let turnsUsed = 0;
let currentAssistantMessageContent = '';

/** Default theme for Markdown rendering */
function getDefaultTheme(): MarkdownTheme {
  const colors = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    italic: '\x1b[3m',
    underline: '\x1b[4m',
    strikethrough: '\x1b[9m',
    black: '\x1b[30m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m',
    bgBlack: '\x1b[40m',
    bgRed: '\x1b[41m',
    bgGreen: '\x1b[42m',
    bgYellow: '\x1b[43m',
    bgBlue: '\x1b[44m',
    bgMagenta: '\x1b[45m',
    bgCyan: '\x1b[46m',
    bgWhite: '\x1b[47m',
  };
  return {
    bold: (t: string) => `${colors.bold}${t}${colors.reset}`,
    italic: (t: string) => `${colors.italic}${t}${colors.reset}`,
    underline: (t: string) => `${colors.underline}${t}${colors.reset}`,
    strikethrough: (t: string) => `${colors.strikethrough}${t}${colors.reset}`,
    heading: (t: string) => `${colors.bold}${colors.cyan}${t}${colors.reset}`,
    code: (t: string) => `${colors.green}${t}${colors.reset}`,
    codeBlock: (t: string) => `${colors.gray}${t}${colors.reset}`,
    codeBlockBorder: (t: string) => `${colors.dim}${t}${colors.reset}`,
    codeBlockIndent: '  ',
    link: (t: string) => `${colors.blue}${colors.underline}${t}${colors.reset}`,
    linkUrl: (t: string) => `${colors.dim}${t}${colors.reset}`,
    quote: (t: string) => `${colors.cyan}${t}${colors.reset}`,
    quoteBorder: (t: string) => `${colors.cyan}${t}${colors.reset}`,
    listBullet: (t: string) => `${colors.cyan}${t}${colors.reset}`,
    hr: (t: string) => `${colors.dim}${t}${colors.reset}`,
    highlightCode: undefined,
  };
}

/** Initialize the persistent TUI with conversation area, status bar, and input */
async function startPersistentTui(): Promise<void> {
  currentTheme = getDefaultTheme();
  dimStyle = { color: (t: string) => `\x1b[2m${t}\x1b[0m` };
  errorStyle = { color: (t: string) => `\x1b[31m${t}\x1b[0m`, bold: true };

  persistentTerminal = new ProcessTerminal();
  persistentTui = new TuiMainScreen(persistentTerminal);

  // Conversation area (flex-grow)
  conversationArea = new Box(0, 1);

  // Proxy log line: a single row between the conversation area and the status bar.
  // No padding at all, so it renders zero rows until the first log arrives.
  proxyLogLine = new Box(0, 0);

  // Status bar at bottom (above the '─' rule) — shows tool calling status while agent runs
  statusBar = new Box(0, 0);

  // Bottom input
  bottomInput = new Input();
  bottomInput.onSubmit = handleInputSubmit;
  bottomInput.onEscape = () => {
    // Escape during idle = quit
    if (!isAgentRunning && nextTaskResolver) {
      nextTaskResolver(null);
    }
  };

  // Root container: conversationArea | proxyLogLine | statusBar | inputRow
  // statusBar sits just above the '─' rule (drawn by RuledInput wrapper)
  const root = new Box(0, 0);
  root.addChild(conversationArea);
  root.addChild(proxyLogLine);
  root.addChild(statusBar);
  // `bottomInput` stays the bare Input (onSubmit/setValue call sites below are
  // unchanged); the wrapper exists only to draw the '─' rule above it, so it is
  // what gets mounted and focused.
  const inputRow = new RuledInput(bottomInput);
  root.addChild(inputRow);

  persistentTui.addChild(root);
  persistentTui.setFocus(inputRow);
  persistentTui.start();
  // Proxy log lines show in the single row directly above the status bar, newest
  // replacing the previous one (see captureConsoleOutput).
  captureConsoleOutput((line) => {
    setProxyLogRow(proxyLogLine, line);
  });

  // Initial render
  updateStatusBar();
  requestRender();
}

/** Stop the persistent TUI and restore terminal */
function stopPersistentTui(): void {
  // Console output goes back to the real stderr before teardown, so anything
  // logged while the TUI is being torn down is not swallowed.
  restoreConsoleOutput();
  // Teardown: clear the title (the caller already did too; idempotent).
  stopTuiSpinner(true);
  if (persistentTui) {
    persistentTui.stop();
    persistentTui = null;
  }
  if (persistentTerminal) {
    persistentTerminal = null;
  }
}

/** Request a re-render of the TUI */
function requestRender(): void {
  persistentTui?.requestRender();
}

/** Show `line` as the single row of `row`, replacing whatever it showed before.
 *  TruncatedText clips to one row (a long warning must not wrap onto a second
 *  row or push the '─' rule down), which is why the row is not a Markdown. */
export function setProxyLogRow(row: Box, line: string): void {
  row.clear();
  row.addChild(new TruncatedText(dim(line), 0, 0));
}

// Proxy logging while the persistent TUI owns the screen. src/server.ts routes
// every proxy log line to stderr (console.log/info/debug are aliased to
// console.error there, keeping stdout free for CLI payloads), and a raw stderr
// write lands on whichever row the TUI parked the cursor on — the '>' input row
// — so a proxy warning or error smears across the user's prompt. TUI=true
// resolves the same conflict by silencing the console outright; here the lines
// are wanted, so while the TUI is up each one is shown in a single dedicated row
// above the '─' rule (newest replaces the previous one) and the original methods
// are restored on teardown, leaving background/non-agent logging unaffected.
const CONSOLE_METHODS = ['log', 'info', 'debug', 'warn', 'error'] as const;
type ConsoleMethod = (...args: unknown[]) => void;
let savedConsoleMethods: Record<string, ConsoleMethod> | null = null;

/** Append console output to `append` (one call per line) instead of letting it
 *  reach raw stderr. No-op if output is already being captured. */
export function captureConsoleOutput(append: (line: string) => void): void {
  if (savedConsoleMethods) return;
  const sink = console as unknown as Record<string, ConsoleMethod>;
  const capture: ConsoleMethod = (...args) => {
    // util.format mirrors what the real console methods would have printed,
    // including inspected objects for non-string args. Multi-line messages (a
    // few of the proxy's startup notices are multi-line) are split and delivered
    // line by line, so a one-row display ends up showing the message's last line
    // rather than losing it inside a block.
    const lines = format(...args).split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) return;
    for (const line of lines) append(line);
    requestRender();
  };
  // Every method is replaced, not just console.error: server.ts aliases
  // console.log/info/debug onto console.error's original function at startup, so
  // replacing console.error alone would leave the proxy logger's own channel
  // still writing straight to stderr.
  const saved: Record<string, ConsoleMethod> = {};
  for (const method of CONSOLE_METHODS) {
    saved[method] = sink[method];
    sink[method] = capture;
  }
  savedConsoleMethods = saved;
}

/** Restore the console methods captureConsoleOutput replaced. */
export function restoreConsoleOutput(): void {
  if (!savedConsoleMethods) return;
  const sink = console as unknown as Record<string, ConsoleMethod>;
  for (const method of CONSOLE_METHODS) {
    sink[method] = savedConsoleMethods[method];
  }
  savedConsoleMethods = null;
}

// TUI spinner interval for running status
let tuiSpinnerInterval: ReturnType<typeof setInterval> | null = null;
let spinnerTick = 0;
// Custom spinner frames: ·✢✶✳✻✽. None is Markdown-significant, so the same
// frames go to both consumers: the in-flight task line (a Markdown component)
// and the model-verification spinner (which writes straight to stdout).
export const SPINNER_CHARS = ['·', '✢', '✶', '✳', '✻', '✽'];

// Braille frames used for the input-area prompt while a task is running, so
// the '>' becomes a visibly rotating indicator. Kept separate from
// SPINNER_CHARS: the prompt is a plain string (not Markdown), so it can carry
// these frames even though the others are chosen to avoid Markdown-significant
// characters.
export const PROMPT_SPINNER_CHARS = ['⠇', '⠏', '⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧'];

// The terminal window title, set once at session start (see runAgentSession)
// and animated while a task runs. Module-level rather than a local of
// runAgentSession because runAgentTurn, which drives the spinner, is not
// nested inside it.
const AGENT_TITLE = 'Agent π in proxy v3';
const IS_STDOUT_TTY = Boolean(process.stdout.isTTY);

/** Write the agent's window title with `glyph` in place of the π. Writes only
 *  on a TTY — when stdout is piped the OSC 0 escape would be logged as
 *  garbage. */
function writeAgentTitle(glyph: string): void {
  if (!IS_STDOUT_TTY) return;
  process.stdout.write(`\x1b]0;${AGENT_TITLE.replace('π', glyph)}\x07`);
}

/** Hand the window title back to the shell default (empty OSC 0) */
function clearAgentTitle(): void {
  if (!IS_STDOUT_TTY) return;
  process.stdout.write('\x1b]0;\x07');
}

/** Which glyph the window title shows on a given spinner tick.
 *  π for 14 ticks, then cycles through o, u, n.
 *  At 150ms/tick: π for ~2.1s, then o/u/n each for ~0.45s. 20-tick cycle = 3s. Ticks start at 1. */
export function agentTitleGlyph(tick: number): string {
  const remainder = (tick - 1) % 20;
  if (remainder < 14) return 'π';
  const afterPi = remainder - 14;
  const cycleGlyphs = ['o', 'u', 'n'];
  return cycleGlyphs[afterPi % cycleGlyphs.length];
}

/** Set the prompt indicator shown before the input text. pi-tui's Input exposes
 *  its prompt only at construction (`private readonly prompt`), but the running
 *  indicator swaps it on every spinner tick, so the field is poked directly —
 *  the one place that reaches past the type instead of a dozen call sites. */
function setInputPrompt(prompt: string): void {
  if (!bottomInput) return;
  (bottomInput as unknown as { prompt: string }).prompt = prompt;
  requestRender();
}

/** Start the TUI spinner interval when agent is running */
function startTuiSpinner(): void {
  if (tuiSpinnerInterval !== null) return;
  tuiSpinnerInterval = setInterval(() => {
    spinnerTick += 1;
    const frame = SPINNER_CHARS[spinnerTick % SPINNER_CHARS.length];
    // The in-flight task's line animates its leading `>` through the spinner
    // frames, so the transcript itself shows which task is still running.
    if (currentTaskMessage) {
      currentTaskMessage.setText(`${frame} ${currentTaskText}`);
      requestRender();
    }
    // Also animate the input prompt to show agent is busy
    setInputPrompt(`${PROMPT_SPINNER_CHARS[spinnerTick % PROMPT_SPINNER_CHARS.length]} `);
    // Also alternate the title's π with * so the window tab itself shows that
    // the agent is busy — the transcript may be scrolled off screen.
    writeAgentTitle(agentTitleGlyph(spinnerTick));
  }, 150);
}

/** Stop the TUI spinner interval. `clear` hands the title back to the shell
 *  (session teardown); otherwise π is restored for the next turn. */
function stopTuiSpinner(clear = false): void {
  if (tuiSpinnerInterval !== null) {
    clearInterval(tuiSpinnerInterval);
    tuiSpinnerInterval = null;
  }
  spinnerTick = 0;
  setInputPrompt('> ');
  if (clear) {
    clearAgentTitle();
  } else {
    writeAgentTitle('π');
  }
}

/** Update the status bar with current stats */
function updateStatusBar(): void {
  if (!statusBar) return;
  const skillsList = selected.size > 0 ? `(${[...selected].join(',')})` : '';
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const name of [...toolsUsedNames, ...pendingToolNames]) {
    if (!seen.has(name)) { seen.add(name); ordered.push(name); }
  }
  const toolsList = ordered.length > 0 ? `(${ordered.join(',')})` : '';
  const dots = pendingToolNames.length > 0 ? ` ${'.'.repeat(progressTick + 1)}` : '';
  const suffix = skillsList || toolsList ? ` ${skillsList} | ${toolsList}` : '';
  const line = dim(`(π ${skillsUsed} skills, ${toolsUsed} tools, ${resultsReceived} results)${suffix}${dots}`);

  // Create a temporary Markdown component for the status bar
  statusBar.clear();
  const statusMarkdown = new Markdown(line, 0, 0, currentTheme, { color: dim });
  statusBar.addChild(statusMarkdown);
  requestRender();
}

/** Handle input submission from the bottom input */
function handleInputSubmit(value: string): void {
  bottomInput.setValue('');

  // Add to history (skip quit commands, empty strings, and command outputs)
  addToHistory(value);

  // Quit commands end the session from either state. Intercepted before
  // followUp() so `/q` is never handed to the model as a prompt. Mid-run
  // this aborts the agent the same way budget enforcement does; idle it
  // unblocks the pending next-task wait.
  if (QUIT_COMMANDS.has(value.trim().toLowerCase())) {
    quitRequested = true;
    const quitMsg = new Markdown(dim('[π quit] exiting agent loop'), 1, 1, currentTheme, dimStyle);
    conversationArea.addChild(quitMsg);
    requestRender();
    if (isAgentRunning) {
      runningAgent?.abort();
    } else {
      nextTaskResolver?.(null);
    }
    return;
  }

  if (isAgentRunning) {
    // Mid-run: send as followUp (UserMessage object)
    runningAgent?.followUp({
      role: 'user',
      content: value,
      timestamp: Date.now(),
    });
    // Visual feedback: add as user message immediately
    const userMsg = new Markdown(`> ${value}`, 0, 1, currentTheme, dimStyle);
    conversationArea.addChild(userMsg);
    requestRender();
  } else {
    // Idle: resolve the next task promise
    nextTaskResolver?.(value);
  }
}

/**
 * Run a single agent turn with the given task.
 *
 * `taskLabel` is what the transcript line shows — the user's own words. It
 * defaults to `task`, but callers that prepend shell output to the prompt
 * payload pass the bare input instead: that output is already echoed in the
 * transcript where it ran, and the spinner and the settled `>` marker belong on
 * the user message rather than on the first line of a command output.
 */
async function runAgentTurn(task: string, taskLabel: string = task): Promise<void> {
  isAgentRunning = true;
  committedForTurn = false;

  // Add the task to the conversation. Its leading `>` is replaced by the
  // spinner frames while the task runs, then restored once it settles.
  currentTaskText = taskLabel;
  currentTaskMessage = new Markdown(`${SPINNER_CHARS[0]} ${taskLabel}`, 0, 1, currentTheme, dimStyle);
  conversationArea.addChild(currentTaskMessage);
  startTuiSpinner();
  updateStatusBar();
  requestRender();

  try {
    await runningAgent!.prompt(task);
    while (!budgetHit && !quitRequested && runningAgent!.hasQueuedMessages()) {
      await runningAgent!.continue();
    }
  } catch (err) {
    // A quit aborts the in-flight request on purpose, so that rejection is not
    // an error to report — the `[π quit]` line already says why the turn ended.
    if (!quitRequested) {
      const errMsg = new Markdown(`[error] ${(err as Error).message}`, 1, 1, currentTheme, errorStyle);
      conversationArea.addChild(errMsg);
      requestRender();
    }
  } finally {
    isAgentRunning = false;
    stopTuiSpinner();
    // Task settled: put the static `>` prefix back on its line.
    if (currentTaskMessage) {
      currentTaskMessage.setText(`> ${currentTaskText}`);
      requestRender();
    }
    currentTaskMessage = null;
    currentTaskText = '';
    currentAssistantMessage = null;
  }
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
  const fallback = join(tmpdir(), `task-${randomUUID().slice(0, 8)}`);
  await mkdir(fallback, { recursive: true });
  return {
    dir: fallback,
    fallbackNotice: `"${requested}" is not writable — using "${fallback}" instead.`,
  };
}

async function loadSystemPrompt(workDir: string): Promise<string> {
  for (const filename of SYSTEM_PROMPT_FILENAMES) {
    try {
      const content = await readFile(join(workDir, filename), 'utf-8');
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
const SKILL_LOCK_PATH = join(homedir(), '.agents/.skill-lock.json');

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
    const projectSkillsDir = join(workDir, '.pi/skills');
    const { skills, diagnostics } = await loadSkills(env, [projectSkillsDir, globalSkillsDir], BACKGROUND_CONTEXT);
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
    const skillsDir = join(workDir, '.pi/skills');
    const { skills, diagnostics } = await loadSkills(env, skillsDir, BACKGROUND_CONTEXT);
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
// unchanged (see startAgentSession). At a realistic ~30k tokens/turn the 100-
// turn cap is the limit that normally trips first (≈3m tokens), well inside
// the 50m token budget: the turn cap bounds a runaway loop, and the token
// budget is the outer bound for runs with unusually large turns.
export const DEFAULT_BUDGET: Budget = { tokens: 50_000_000, turns: 100 };

// Prefilled into the budget prompt. Compared against the submitted value to
// detect "took the default", so it must stay in sync with DEFAULT_BUDGET.tokens.
export const BUDGET_PROMPT_DEFAULT = '50m';

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

/** Abbreviate a token budget the way the budget prompt accepts it: thousands-
 *  separated below 1M ("500,000"), lowercase k/m/b/t suffix at or above
 *  ("50m") — matching BUDGET_PROMPT_DEFAULT's lowercase form. Not
 *  config-loader's formatTokenLimit, which abbreviates from 1K and uses
 *  uppercase units (the dashboard/TUI display convention). */
function formatTokenBudget(tokens: number): string {
  if (tokens >= 1_000_000_000_000) return `${(tokens / 1_000_000_000_000).toFixed(0)}t`;
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(0)}b`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}m`;
  return tokens.toLocaleString();
}

/** Human-readable form for logging, e.g. "10 turns", "50m tokens", or "50m tokens / 10 turns" when both are set. */
export function formatBudget(budget: Budget): string {
  const parts: string[] = [];
  if (budget.tokens !== undefined) parts.push(`${formatTokenBudget(budget.tokens)} tokens`);
  if (budget.turns !== undefined) parts.push(`${budget.turns.toLocaleString()} turns`);
  return parts.join(' / ');
}

/** Per-task usage line, e.g. "usage: 1276 tokens / 50m limit and 1 / 100 turns".
 *  A pair is omitted entirely when the budget leaves that dimension unbounded. */
export function formatUsage(tokensUsed: number, turnsUsed: number, budget: Budget): string {
  const parts: string[] = [];
  if (budget.tokens !== undefined) parts.push(`${tokensUsed} tokens / ${formatTokenBudget(budget.tokens)} limit`);
  if (budget.turns !== undefined) parts.push(`${turnsUsed} / ${budget.turns} turns`);
  return `usage: ${parts.join(' and ')}`;
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

function buildSelfModel(alias: string, port: number): Model<ProxyApiType> {
  return buildProxyPiModel(alias, `http://127.0.0.1:${port}`);
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
  if (IS_STDOUT_TTY) {
    process.stdout.write(`\x1b]0;${AGENT_TITLE}\x07`);
  }

  // No OS-level sandbox: the bash tool runs commands via a plain `/bin/sh -c`
  // child process with this user's full privileges (see README "Tool safety
  // limits") — pi-agent-core itself provides no sandboxing either. Only the
  // path-confinement/denylist checks in agent-tools.ts apply, and those are
  // raw string/regex matching, not enforced by the OS. Printed unconditionally
  // at session start so this is visible before any prompt (Rule 8: fail loud).
  console.log('[WARN] No OS-level sandbox — bash/write_file run with this user\'s full privileges,')
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
  console.log(dim('[proxy] checking global/project skills...'));
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
  console.log(dim('[proxy] checking "skills" CLI...'));
  const skillsCliAvailable = await probeSkillsCli(workDir);
  if (!skillsCliAvailable) {
    console.log(dim('[WARN] "skills" CLI not found (npx skills --version failed) — find_skill/add_skill tools disabled for this session.'));
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
    id: PROXY_PROVIDER_ID,
    baseUrl: `http://127.0.0.1:${port}`,
    auth: {
      apiKey: clientApiKey
        ? { name: 'model_proxy_v3 client key', resolve: async () => ({ auth: { apiKey: clientApiKey } }) }
        : { name: 'model_proxy_v3 (DEV_NO_KEY)', resolve: async () => ({ auth: {} }) },
    },
    models: aliases.map((alias) => buildSelfModel(alias, port)),
    api: {
      'anthropic-messages': anthropicMessagesApi(),
      'openai-completions': openAICompletionsApi(),
      'openai-responses': openAIResponsesApi(),
      'google-generative-ai': googleGenerativeAIApi(),
      'pi-messages': piMessagesApi(),
    },
  });
  models.setProvider(provider);

  // The verification round-trip only needs to prove the loopback call reaches
  // upstream and comes back non-empty — it is not a task. The candidate Agent
  // carries the full system prompt and tool set, so an open-ended question
  // ("which model are you?") gets treated as real work and the model starts
  // exploring the working directory instead of answering, which is slow and
  // tells us nothing the picker didn't already. One terse tool-free line
  // keeps the round-trip short; the model's identity is already printed by
  // the picker line above. Shared by the display line and the call below so
  // the two can't drift.
  const VERIFY_PROMPT = 'Reply "ok". Do not use tools.';

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
          appendSystemPrompt: (instructions: string) => {
            const agent = candidateRef.current!;
            agent.state.messages = [
              ...agent.state.messages,
              { role: 'system', content: instructions, timestamp: Date.now() },
            ];
          },
        }),
      },
      streamFn: models.streamSimple.bind(models),
    });
    candidateRef.current = candidate;

    console.log(dim(`[proxy] checking proxy v3 and model `) + choice + dim(` with prompt "${VERIFY_PROMPT}"`));
    let replyText = '';
    let sawError = false;
    // Live progress for the verification round-trip, which can otherwise sit
    // for many seconds with no output at all. Follows printProcessLog's
    // convention further down: animate in place on a TTY, stay silent when
    // stdout is redirected (a line every 150ms would flood a log file). The
    // total elapsed is reported in the result line either way.
    const verifyStartedAt = Date.now();
    let verifyTick = 0;
    let verifyTimer: ReturnType<typeof setInterval> | null = IS_STDOUT_TTY
      ? setInterval(() => {
          verifyTick += 1;
          const secs = ((Date.now() - verifyStartedAt) / 1000).toFixed(1);
          process.stdout.write(`\r\x1b[K${dim(`${SPINNER_CHARS[verifyTick % SPINNER_CHARS.length]} checking… ${secs}s`)}`);
        }, 150)
      : null;
    // Idempotent, and called before any error output so the message is not
    // appended to the half-written progress line.
    const stopVerifyProgress = () => {
      if (verifyTimer !== null) { clearInterval(verifyTimer); verifyTimer = null; }
      if (IS_STDOUT_TTY) process.stdout.write('\r\x1b[K');
    };
    const unsubscribe = candidate.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        replyText += event.assistantMessageEvent.delta;
      }
      if (event.type === 'agent_end') {
        const last = candidate.state.messages[candidate.state.messages.length - 1] as { role?: string; stopReason?: string; errorMessage?: string } | undefined;
        if (last?.role === 'assistant' && last.stopReason === 'error') {
          sawError = true;
          stopVerifyProgress();
          console.error(`[proxy] verifying failed: ${last.errorMessage ?? 'unknown error'}`);
        }
      }
    });
    try {
      await candidate.prompt(VERIFY_PROMPT);
    } catch (err) {
      sawError = true;
      stopVerifyProgress();
      console.error(`[proxy] verifying failed: ${(err as Error).message}`);
    } finally {
      unsubscribe();
      stopVerifyProgress();
    }

    const elapsedSeconds = ((Date.now() - verifyStartedAt) / 1000).toFixed(1);
    if (sawError || !replyText.trim()) {
      if (!sawError) console.error(`[proxy] verifying failed: model returned an empty reply (${elapsedSeconds}s).`);
      console.log(dim('Pick a different model.'));
      continue;
    }

    console.log(dim(`[proxy] replied ${replyText.trim()} (${elapsedSeconds}s)`));
    selectedAlias = choice;
    agent = candidate;
  }

  if (!agent) return; // unreachable, satisfies TS narrowing

  // -- Endpoint schema (API type) picker --
  let selectedApi: ProxyApiType = 'anthropic-messages';
  const apiChoices = [
    { value: 'anthropic-messages' as ProxyApiType, label: 'Anthropic Messages', description: 'Default: /v1/messages (Claude format)' },
    { value: 'openai-completions' as ProxyApiType, label: 'OpenAI Completions', description: '/v1/chat/completions (OpenAI chat format)' },
    { value: 'openai-responses' as ProxyApiType, label: 'OpenAI Responses', description: '/v1/responses (OpenAI Responses API)' },
    { value: 'google-generative-ai' as ProxyApiType, label: 'Google Generative AI', description: '/v1beta/models/{model}:generateContent (Gemini format)' },
  ];
  const apiChoice = await pickFromList(
    `\nSelect endpoint schema for ${selectedAlias} (default: Anthropic Messages):`,
    apiChoices,
  ) as ProxyApiType | null;
  if (apiChoice) {
    selectedApi = apiChoice;
  }
  console.log(dim(`[proxy] using endpoint schema: ${selectedApi}`));

  // Build model with selected API and create new agent for the session.
  // The base URL is per-API: each SDK appends its own path and they disagree
  // about where the version segment lives, so a bare origin made every api
  // but anthropic-messages request an unversioned path the proxy rejects.
  const baseUrl = proxyBaseUrlForApi(port, selectedApi);
  const sessionModel = buildProxyPiModel(selectedAlias, baseUrl, selectedApi);
  models.setProvider(provider); // ensure provider is still registered
  const sessionModels = createModels();
  sessionModels.setProvider(provider);

  // Create new agent with the selected API model
  const candidateRef: { current: Agent | null } = { current: null };
  agent = new Agent({
    initialState: {
      systemPrompt,
      model: sessionModel,
      tools: createAgentTools(workDir, {
        skillsCliAvailable,
        appendSystemPrompt: (instructions: string) => {
          const ag = candidateRef.current!;
          ag.state.messages = [
            ...ag.state.messages,
            { role: 'system', content: instructions, timestamp: Date.now() },
          ];
        },
      }),
    },
    streamFn: sessionModels.streamSimple.bind(sessionModels),
  });
  candidateRef.current = agent;

  // -- Budget prompt --
  let budget: Budget | null = null;
  while (!budget) {
    const raw = await promptText(
      `\n[π budget] Set task budget (e.g. 1000000 or 1m for tokens, e.g. 40 for turns), /quit or /exit to end.\nOr leave blank as DEFAULT budget (${formatBudget(DEFAULT_BUDGET)}):`,
      BUDGET_PROMPT_DEFAULT,
    );
    if (raw === null || QUIT_COMMANDS.has(raw.trim().toLowerCase())) {
      console.log(dim('No budget entered — exiting agent session.\nbye!'));
      return;
    }
    // Blank input and accepting the prefill unchanged both mean "the
    // default" — so both yield the combined DEFAULT_BUDGET. Without this,
    // submitting the prefill would run parseBudget(BUDGET_PROMPT_DEFAULT)
    // = tokens-only and silently drop the turn cap, making the two ways of
    // taking the default behave in opposite ways (one nearly unbounded,
    // one capped).
    if (!raw.trim() || raw.trim().toLowerCase() === BUDGET_PROMPT_DEFAULT) {
      budget = DEFAULT_BUDGET;
      break;
    }
    budget = parseBudget(raw);
    if (!budget) {
      console.error(`[π budget] Could not parse "${raw}" — enter a bare integer for turns (e.g. 20) or a k/m-suffixed value for tokens (e.g. 50k), or leave blank for the default.`);
    }
  }
  console.log(dim(`[budget: ${formatBudget(budget)}]`));

  // Start persistent TUI for the interactive session
  startPersistentTui();

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
  toolsUsedNames = [];
  // Names of tools currently in-flight (start without matching end). Joined
  // with toolsUsedNames in the log so a tool that's been running a while is
  // still visible at the tail of the list.
  pendingToolNames = [];
  // Print a process-log line in place by clearing the current row and
  // returning the cursor to column 0 — successive calls overwrite each
  // other so the terminal shows the latest totals on a single line, rather
  // than one line per tool/result event. `\x1b[K` also erases anything a
  // third-party logger (e.g. the proxy's own per-request lines) wrote on
  // the same row in between, so our next print is the only thing visible
  // on it. A final `\n` is emitted once the run settles (see end of task
  // loop) so the next prompt starts on its own row, not stranded on this
  // one. Progress chatter rather than agent output, so it goes to stderr,
  // where the proxy's own per-request lines land too — stdout carries only the
  // agent's reply (see the console redirect in src/server.ts). Falls back to a
  // plain console.log line when stderr isn't a TTY (e.g. piped to a file) — the
  // carriage return would just corrupt the log.
  const isTty = Boolean(process.stdout.isTTY);
  // The process-log line below is written to stderr, so both its in-place
  // rendering and the ticker that animates its dots are gated on stderr's
  // TTY-ness — not stdout's. Gating the ticker on stdout would emit a plain
  // progress line every 400ms into a piped stderr log.
  const isStderrTty = Boolean(process.stderr.isTTY);
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
    if (progressInterval !== null || !isStderrTty) return;
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
    const suffix = skillsList || toolsList ? ` ${skillsList} | ${toolsList}` : '';
    const line = dim(`(π ${skillsUsed} skills, ${toolsUsed} tools, ${resultsReceived} results)${suffix}${dots}`);
    if (isStderrTty) {
      process.stderr.write(`\r\x1b[K${line}`);
    } else {
      console.log(line);
    }
  };
  const commitProcessLog = () => {
    if (isTty) process.stdout.write('\n');
  };
  // Note: committedForTurn, budgetHit, quitRequested, runningAgent, budget, tokensUsed, turnsUsed,
  // toolsUsed, resultsReceived, toolsUsedNames, pendingToolNames, progressTick,
  // selected, skillsUsed are defined at module scope and initialized here:
  committedForTurn = false;
  budgetHit = false;
  quitRequested = false;
  runningAgent = agent;
  budget = budget; // budget is already set from the prompt
  tokensUsed = 0;
  turnsUsed = 0;
  toolsUsed = 0;
  resultsReceived = 0;
  toolsUsedNames = [];
  pendingToolNames = [];
  progressTick = 0;

  const unsubscribeBudget = runningAgent.subscribe((event) => {
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      // First text delta after the process log: create/update the assistant message component.
      // No defaultTextStyle: the model's reply is the one thing in the transcript
      // that should read at normal brightness, so it stays in the terminal's
      // default foreground rather than the faint dimStyle used for chrome.
      if (!committedForTurn) {
        currentAssistantMessage = new Markdown('', 0, 0, currentTheme);
        conversationArea.addChild(currentAssistantMessage);
        currentAssistantMessageContent = '';
        committedForTurn = true;
        requestRender();
      }
      // Append delta to the current assistant message
      if (currentAssistantMessage) {
        // Track content separately since Markdown doesn't expose it
        currentAssistantMessageContent += event.assistantMessageEvent.delta;
        // trimStart on the display copy only, so the accumulator keeps raw deltas.
        // A reply opening with 4+ spaces would be parsed as a Markdown indented
        // code block, and leading blank lines render as blank rows.
        currentAssistantMessage.setText(currentAssistantMessageContent.trimStart());
        requestRender();
      }
    }
    if (event.type === 'tool_execution_start') {
      toolsUsed += 1;
      if (!toolsUsedNames.includes(event.toolName)) toolsUsedNames.push(event.toolName);
      pendingToolNames.push(event.toolName);
      startProgressInterval();
      updateStatusBar();
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
      updateStatusBar();
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
        runningAgent?.abort();
      }
      // Mark assistant message as complete
      committedForTurn = false;
      currentAssistantMessage = null;
      currentAssistantMessageContent = '';
      updateStatusBar();
    }
  });

  try {
    // -- Task loop (persistent TUI): run a task, summarize what changed, wait for next task via nextTaskResolver --
    // The bottom input row is pinned; user types there. When agent is running,
    // input goes to followUp(). When idle, input resolves nextTaskResolver.
    // Blank input or /q, /quit, /exit end the session early, without waiting for budget.
    // Input starting with '!' runs as a shell command in workDir — accumulate outputs
    // Only when user enters a non-! prompt, concat all shell outputs + input as task

    // Get first task via the nextTaskResolver promise
    let task: string | null = await new Promise<string | null>((resolve) => {
      nextTaskResolver = resolve;
    });

    let shellOutputs: string[] = [];
    // What the task line displays: the user's own words. Set only when shell
    // output gets prepended to the prompt payload below, so the spinner and the
    // settled `>` land on the user message instead of on a command output.
    let taskLabel = '';
    while (task !== null && task.startsWith('!')) {
      const cmd = task.slice(1).trim();
      if (!cmd) {
        task = await new Promise<string | null>((resolve) => {
          nextTaskResolver = resolve;
        });
        continue;
      }
      // Show shell command in conversation
      const shellMsg = new Markdown(dim(`[π shell] running: ${cmd}`), 0, 1, currentTheme, dimStyle);
      conversationArea.addChild(shellMsg);
      requestRender();
      try {
        const result = await runShellCommand(cmd, workDir);
        // Trimmed once, at the source: Markdown parses 4+ leading spaces as an
        // indented code block, so output that starts indented would otherwise
        // render inside ``` fences, and leading blank lines render as blank rows.
        const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
        const exitMsg = new Markdown(dim(`[π shell] exit code: ${result.code}`), 0, 1, currentTheme, dimStyle);
        conversationArea.addChild(exitMsg);
        if (output) {
          const outMsg = new Markdown(output, 0, 1, currentTheme, dimStyle);
          conversationArea.addChild(outMsg);
          shellOutputs.push(output);
        }
        requestRender();
        // Continue prompting for more ! commands or a real task
        task = await new Promise<string | null>((resolve) => {
          nextTaskResolver = resolve;
        });
      } catch (err) {
        const errMsg = new Markdown(dim(`[π shell] error: ${(err as Error).message}`), 0, 1, currentTheme, errorStyle);
        conversationArea.addChild(errMsg);
        requestRender();
        task = await new Promise<string | null>((resolve) => {
          nextTaskResolver = resolve;
        });
      }
    }
    // If we accumulated shell outputs and user entered a real task, combine them
    if (shellOutputs.length > 0 && task && task.trim() && !task.startsWith('!')) {
      taskLabel = task;
      task = shellOutputs.join('\n\n') + '\n\n' + task;
    } else if (shellOutputs.length > 0 && (!task || !task.trim())) {
      // User entered nothing after shell commands: skip turn
      const skipMsg = new Markdown(dim('[π shell] no task input — skipping turn'), 1, 1, currentTheme, dimStyle);
      conversationArea.addChild(skipMsg);
      requestRender();
      task = await new Promise<string | null>((resolve) => {
        nextTaskResolver = resolve;
      });
    }

    // Take initial snapshot before the first task
    let beforeSnapshot = await snapshotWorkDir(workDir);

    while (task !== null && !QUIT_COMMANDS.has(task.trim().toLowerCase()) && task.trim() && !budgetHit && !quitRequested) {
      // Run the agent turn
      await runAgentTurn(task, taskLabel || task);
      taskLabel = '';

      // Snapshot and show diff
      const afterSnapshot = await snapshotWorkDir(workDir);
      const { created, modified } = diffWorkDirSnapshots(beforeSnapshot, afterSnapshot);
      beforeSnapshot = afterSnapshot; // Update for next iteration
      const changeSummary = created.length === 0 && modified.length === 0
        ? '(No files are created or modified.)'
        : [
            created.length > 0 ? `created: ${created.join(', ')}` : null,
            modified.length > 0 ? `modified: ${modified.join(', ')}` : null,
          ].filter(Boolean).join(' | ');

      const summaryMsg = new Markdown(
        dim(`\n[π ${budgetHit ? 'Budget reached' : quitRequested ? 'quit requested' : 'task done'} (${formatUsage(tokensUsed, turnsUsed, budget)})]\n`) +
        changeSummary,
        0, 1, currentTheme, dimStyle
      );
      conversationArea.addChild(summaryMsg);
      requestRender();

      // An explicit quit outranks the budget acknowledgment: the user already
      // said to stop, so don't ask them to confirm it a second time.
      if (quitRequested) {
        clearAgentTitle();
        break;
      }

      if (budgetHit) {
        // Budget enforcement stops the agent, not the session — require an
        // explicit acknowledgment before exiting so this reads as a deliberate
        // stop, not a hang (Rule 8: fail loud, don't just trail off).
        const ackMsg = new Markdown(dim('\n[π budget] reached — press enter or type /q to exit:'), 1, 1, currentTheme, dimStyle);
        conversationArea.addChild(ackMsg);
        requestRender();
        // Wait for acknowledgment
        await new Promise<void>((resolve) => {
          nextTaskResolver = (value) => {
            // Blank input is the documented way out here too ("press enter"),
            // matching the top-level loop, which treats it as end-of-session.
            if (value === null || value.trim() === '' || QUIT_COMMANDS.has(value.trim().toLowerCase())) {
              resolve();
            }
          };
        });
        clearAgentTitle();
        break;
      }

      // Wait for next task via nextTaskResolver
      task = await new Promise<string | null>((resolve) => {
        nextTaskResolver = resolve;
      });

      // Handle ! prefix for follow-up tasks: accumulate shell outputs
      shellOutputs = [];
      while (task !== null && task.startsWith('!')) {
        const cmd = task.slice(1).trim();
        if (!cmd) {
          task = await new Promise<string | null>((resolve) => {
            nextTaskResolver = resolve;
          });
          continue;
        }
        const shellMsg = new Markdown(dim(`[π shell] running: ${cmd}`), 0, 1, currentTheme, dimStyle);
        conversationArea.addChild(shellMsg);
        requestRender();
        try {
          const result = await runShellCommand(cmd, workDir);
          // Trimmed once, at the source — see the matching comment in the first
          // shell loop above.
          const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
          const exitMsg = new Markdown(dim(`[π shell] exit code: ${result.code}`), 0, 1, currentTheme, dimStyle);
          conversationArea.addChild(exitMsg);
          if (output) {
            const outMsg = new Markdown(output, 0, 1, currentTheme, dimStyle);
            conversationArea.addChild(outMsg);
            shellOutputs.push(output);
          }
          requestRender();
          task = await new Promise<string | null>((resolve) => {
            nextTaskResolver = resolve;
          });
        } catch (err) {
          const errMsg = new Markdown(dim(`[π shell] error: ${(err as Error).message}`), 0, 1, currentTheme, errorStyle);
          conversationArea.addChild(errMsg);
          requestRender();
          task = await new Promise<string | null>((resolve) => {
            nextTaskResolver = resolve;
          });
        }
      }
      // If we accumulated shell outputs and user entered a real task, combine them
      if (shellOutputs.length > 0 && task && task.trim() && !task.startsWith('!')) {
        taskLabel = task;
        task = shellOutputs.join('\n\n') + '\n\n' + task;
      } else if (!quitRequested && shellOutputs.length > 0 && (!task || !task.trim())) {
        // User entered nothing after shell commands: skip turn
        const skipMsg = new Markdown(dim('[π shell] no task input — skipping turn'), 1, 1, currentTheme, dimStyle);
        conversationArea.addChild(skipMsg);
        requestRender();
        task = await new Promise<string | null>((resolve) => {
          nextTaskResolver = resolve;
        });
      }
    }
    // Sign off on a user-initiated exit (blank input, /q, /quit, /exit, or a
    // cancelled prompt). Not printed when the budget stopped the run — that
    // path already prints its own "Budget reached" acknowledgment above, and
    // the session ended on its own terms rather than because the user asked.
    if (!budgetHit) {
      const byeMsg = new Markdown(dim('π: bye!'), 1, 1, currentTheme, dimStyle);
      conversationArea.addChild(byeMsg);
      requestRender();
      clearAgentTitle();
    }
  } finally {
    unsubscribeBudget();
    stopPersistentTui();
  }
}
