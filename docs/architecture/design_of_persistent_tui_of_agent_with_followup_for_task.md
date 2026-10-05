---
title: Design: Persistent TUI of Agent with FollowUp for Task
description: Architecture and implementation of persistent TUI for agent sessions with mid-run followUp input
---

# Design: Persistent TUI of Agent with FollowUp for Task

## Overview

This document describes the design and implementation of a persistent Terminal User Interface (TUI) for agent sessions in `model_proxy_v3`. The key innovation is replacing throwaway TUI screens with a single persistent TUI that stays alive for the entire session, supporting mid-run user input via the agent's `followUp()` queue.

## Motivation

### Previous Architecture (Throwaway Screens)

The original implementation used disposable TUI screens created and destroyed per interaction:

- `PickerScreen` / `pickFromList` — model/skill/directory selection
- `MultiSelectScreen` / `pickMultiFromList` — multi-select prompts
- `PromptScreen` / `promptText` — single-line text input

Each screen:
1. Created a new `ProcessTerminal` and `TUI` instance
2. Ran the interaction
3. Called `tui.stop()` which tears down raw mode and stdin
4. Discarded everything

### Problems with Throwaway Approach

1. **No mid-run input** — User couldn't provide input while agent was running
2. **Visual discontinuity** — Screen flicker between interactions
3. **State loss** — Conversation history not visually preserved
4. **Type-ahead hazard** — Input typed during run leaked into next prompt (stdin paused, never flushed)

### New Requirements

1. **Persistent TUI** — Single TUI instance for entire session
2. **Streaming conversation** — Assistant replies stream as Markdown components
3. **Mid-run followUp** — User can type while agent runs; input queued via `agent.followUp()`
4. **Pinned input** — Input row always visible at bottom
5. **Live status bar** — Real-time skills/tools/results/budget counts

## Architecture

### High-Level Components

```
┌─────────────────────────────────────┐
│           Persistent TUI            │
├─────────────────────────────────────┤
│  Status Bar (skills/tools/results)  │  ← Box, updated live
├─────────────────────────────────────┤
│        Conversation Area            │  ← Box (flex-grow)
│  ┌───────────────────────────────┐  │
│  │ User Message (Markdown)       │  │
│  ├───────────────────────────────┤  │
│  │ Assistant Message (Markdown)  │  │  ← Streaming text deltas
│  ├───────────────────────────────┤  │
│  │ Tool Call / Result (Markdown) │  │
│  └───────────────────────────────┘  │
├─────────────────────────────────────┤
│        Bottom Input (Input)         │  ← Pinned, full-width `──` rule above, onSubmit handler
└─────────────────────────────────────┘
```

### Module-Scope State (Hoisted for Cross-Function Access)

```typescript
// Persistent TUI infrastructure
let persistentTui: TUI | null = null;
let persistentTerminal: ProcessTerminal | null = null;
let conversationArea: Box;
let statusBar: Box;
let bottomInput: Input;

// Current rendering state
let currentAssistantMessage: Markdown | null = null;
let currentAssistantMessageContent = '';
let currentTaskMessage: Markdown | null = null;
let currentTaskText = '';
let currentTheme: MarkdownTheme;
let dimStyle: DefaultTextStyle;
let errorStyle: DefaultTextStyle;

// Running-task spinner
let tuiSpinnerInterval: ReturnType<typeof setInterval> | null = null;
let spinnerTick = 0;
export const SPINNER_CHARS = ['·', '✢', '✶', '✳', '✻', '✽'];
// None of these is Markdown-significant, so one array serves both consumers:
// the in-flight task line (a Markdown component) and the model-verification
// spinner (written straight to stdout).


// Window title (OSC 0). Module scope, not locals of runAgentSession: runAgentTurn
// drives the spinner and is not nested inside it.
const AGENT_TITLE = 'Agent π in proxy v3';
const IS_STDOUT_TTY = Boolean(process.stdout.isTTY);
export function agentTitleGlyph(tick: number): string {
  return Math.floor((tick - 1) / 2) % 2 === 0 ? 'π' : '*';
}

// Agent runtime state
let isAgentRunning = false;
let runningAgent: Agent | null = null;
let nextTaskResolver: ((value: string | null) => void) | null = null;

// Budget/turn tracking
let budgetHit = false;
let quitRequested = false;
let budget: Budget | null = null;
let tokensUsed = 0;
let turnsUsed = 0;
let committedForTurn = false;

// Status bar counters
let selected: Set<string> = new Set();
let skillsUsed = 0;
let toolsUsed = 0;
let resultsReceived = 0;
let toolsUsedNames: string[] = [];
let pendingToolNames: string[] = [];
let progressTick = 0;
```

> **Known shadowing**: `runAgentSession` declares its own `let progressTick = 0` (with `startProgressInterval` / `printProcessLog`) for the legacy stderr process-log line. That local shadows the module-scope `progressTick` the status bar reads, so the two counters are independent — and the module-scope one is never incremented, leaving the status bar's trailing dots pinned at a single `.`. The TUI spinner deliberately uses its own `spinnerTick` rather than either.

### Event Flow

```
User Input (bottomInput.onSubmit)
       │
       ▼
┌───────────────────────┐
│ isAgentRunning?       │
└───────────┬───────────┘
            │
    ┌───────┴───────┐
    │               │
   YES              NO
    │               │
    ▼               ▼
runningAgent.    nextTaskResolver
.followUp(       (value)  ──►  New task
  UserMessage)         │
    │                 │
    ▼                 ▼
Render user msg   Resume task loop
in conversation
area
```

### Agent Subscription (Budget Subscriber)

The agent's event subscription handles streaming updates:

```typescript
runningAgent.subscribe((event) => {
  switch (event.type) {
    case 'message_update':
      // text_delta → stream into currentAssistantMessage
      if (event.assistantMessageEvent.type === 'text_delta') {
        if (!committedForTurn) {
          // First delta: create Markdown component
          currentAssistantMessage = new Markdown('', 0, 0, currentTheme, dimStyle);
          conversationArea.clear();
          conversationArea.addChild(currentAssistantMessage);
          currentAssistantMessageContent = '';
          committedForTurn = true;
        }
        // Append delta
        currentAssistantMessageContent += event.assistantMessageEvent.delta;
        currentAssistantMessage.setText(currentAssistantMessageContent);
        requestRender();
      }
      break;

    case 'tool_execution_start':
      // Track in-flight tool
      toolsUsed += 1;
      if (!toolsUsedNames.includes(event.toolName)) toolsUsedNames.push(event.toolName);
      pendingToolNames.push(event.toolName);
      updateStatusBar();
      break;

    case 'tool_execution_end':
      // Track completed tool
      resultsReceived += 1;
      const idx = pendingToolNames.indexOf(event.toolName);
      if (idx !== -1) pendingToolNames.splice(idx, 1);
      updateStatusBar();
      break;

    case 'turn_end':
      turnsUsed += 1;
      // Check budget
      if (budget exceeded) {
        budgetHit = true;
        runningAgent?.abort();
      }
      // Reset turn state
      committedForTurn = false;
      currentAssistantMessage = null;
      currentAssistantMessageContent = '';
      updateStatusBar();
      break;
  }
});
```

## Key Design Decisions

### 1. Reader Approach: Persistent TUI Session

**Decision**: One TUI alive for whole session, streamed reply as component, Input row pinned at bottom.

**Alternative considered**: Blind line reader (`stdin` without TUI), Out-of-band input file.

**Rationale**: 
- Provides best UX — live streaming, visual history, always-visible input
- Integrates with existing pi-tui components (Markdown, Box, Input)
- Avoids stdin/raw-mode conflicts with agent's stdout/stderr

### 2. Queue Semantics: followUp() Only

**Decision**: Mid-run input goes into `followUp()` queue (one-at-a-time drain).

**Alternative considered**: `steer()` (immediate), Both prefix-selected.

**Rationale**:
- `followUp()` respects agent's turn boundaries — input waits until agent decides it's done
- Default `followUpMode: "one-at-a-time"` prevents input flooding
- `steer()` would interrupt agent mid-turn, breaking tool execution flow

### 3. Markdown Streaming Strategy

**Decision**: Track content separately (`currentAssistantMessageContent`), call `setText()` on each delta.

**Rationale**: 
- pi-tui's `Markdown` component has `setText()` but no `getText()` or `content` property
- Incremental `setText()` with full content is simpler than diffing
- Performance acceptable for typical token streams

### 4. Conversation Area Management

**Decision**: `addChild()` only — the conversation area accumulates across turns and is never cleared while the session runs.

**Rationale**:
- The whole point of a persistent TUI is that the transcript survives; an earlier revision called `conversationArea.clear()` on the first text delta of each turn, which discarded the task line and all prior history and defeated the design
- pi-tui's `Box` has `clear()` and `addChild()` but no `replaceChildren()`, so each turn simply appends its own task line and assistant message
- `currentAssistantMessage` / `currentAssistantMessageContent` are reset on `turn_end` so the next turn's deltas land in a *new* component appended below the previous one

### 5. Status Bar Updates

**Decision**: Synchronous `updateStatusBar()` called on every tool/result/event.

**Rationale**:
- Low overhead — just recreates Markdown text
- Keeps counts accurate without debouncing complexity

### 6. Running-Task Indicator

**Decision**: The in-flight task's own conversation line animates its leading `>` through `·✢✶✳✻✽` at 150ms per frame, and reverts to a static `>` in `runAgentTurn`'s `finally` block. Frames come from `SPINNER_CHARS`.

**Rationale**:
- Marks *which* task is running, not merely *that* something is running — a spinner in the status bar cannot distinguish the current task from a queued follow-up
- Uses the same `Markdown.setText()` mechanism as assistant streaming, so no extra component type is needed
- Own `spinnerTick` counter rather than reusing `progressTick`, which drives the status bar's `.`/`..`/`...` dots on a 3-frame cycle; sharing one counter made the dots render a fourth frame
- Mid-run follow-up lines keep a static `>` — they are queued, not in flight
- **Superseded: a separate Markdown-escaped constant.** While the frames were `\ | / + -`, the task line needed its own array: it is a `Markdown`, and both `+ ` and `- ` at the start of a line are list syntax. A bare `+` drew a `-` bullet, so pi-tui animated `\ | / -` while the docs advertised `\ | / +`; a bare `-` drew the right character but as a list item, whose wrapped continuation lines carry a hanging indent a paragraph's do not — visible as the task text jumping sideways whenever the `-` frame came around. Both were escaped into a second constant `SPINNER_MD`, kept separate from the bare `SPINNER_CHARS` the stdout verification spinner uses. Once the frames became `·✢✶✳✻✽`, none is Markdown-significant, so the escape map was the identity and the second constant was removed — one array now serves both consumers. The two regression tests that pinned the escaping (`+` renders as `-`; list markers wrap with a hanging indent) are kept against `SPINNER_CHARS`, so re-introducing a list-marker frame still fails the `renders every frame literally` test

### 6b. Window Title

**Decision**: The session sets the terminal window title to `Agent π in proxy v3` via OSC 0 (`\x1b]0;<title>\x07`) at session start. While a task is in flight the title alternates its π with `*`, holding each glyph for two ticks (`π π * * π π * *` at 150ms/tick, so 300ms per glyph). Idle shows a plain π; the two user-facing exit paths (`bye!`, `Budget reached`) hand the title back to the shell default with an empty OSC 0.

**Rationale**:
- The transcript already shows which task is running, but it can be scrolled off screen — the window/tab title is visible regardless
- Two ticks per glyph rather than one: a flip on every 150ms frame reads as a flicker at the edge of perception, while 300ms per glyph reads as a deliberate blink
- `agentTitleGlyph(tick)` is exported as a pure function, following the `SPINNER_CHARS` precedent, so the cadence is testable without a PTY. `Math.floor((tick - 1) / 2)` is deliberate — `tick` is 1-based (the interval increments before its first glyph), so the obvious `Math.floor(tick / 2) % 2` would make the opening π run a single tick
- Module-scope `AGENT_TITLE`/`IS_STDOUT_TTY` rather than `runAgentSession` locals: `runAgentTurn` drives the spinner and is a module-level function, so it cannot see that function's locals
- All title writes are gated on `IS_STDOUT_TTY` — when stdout is piped the OSC 0 escape would be logged as garbage, the same reasoning as the verification spinner
- Early-return paths (no model picked, cancelled prompt, missing API key) deliberately do *not* restore the shell's title: the process is still the proxy server, so there is nothing to hand back
- `stopTuiSpinner(clear = false)` gained its parameter to fix a teardown ordering bug — the exit paths clear the title inside the `try`, then the `finally` runs `stopPersistentTui()` → `stopTuiSpinner()`, which had unconditionally re-written π after the session ended. `stopPersistentTui` now calls `stopTuiSpinner(true)`

**The `taskLabel` split**: `runAgentTurn(task, taskLabel = task)` separates the prompt *payload* from the transcript *label*. When `!cmd` shell output is accumulated and then prepended to the user's real task, `task` becomes `shellOutputs.join('\n\n') + '\n\n' + userPrompt` — so a spinner written into `task`'s first line landed on the first line of a *command output*, not on the user's words. Callers that prepend therefore pass the bare input as `taskLabel`; `currentTaskText` and the task `Markdown` use `taskLabel`, while `prompt()` receives `task`. The echo of the shell output stays where it already ran, so nothing is duplicated.

### 7. Quit Commands: Intercept Before `followUp()`

**Decision**: `/q`, `/quit`, `/exit` and `/bye` (the existing `QUIT_COMMANDS` set) are intercepted at the top of `handleInputSubmit`, before the `isAgentRunning` branch. They set `quitRequested`, print `[π quit] exiting agent loop`, then `abort()` the agent if a turn is in flight or resolve the pending next-task wait with `null` if idle.

**Alternative considered**: Reusing `budgetHit` as the stop flag; letting `/q` reach the task loop only.

**Rationale**:
- Before this, `handleInputSubmit` forwarded *every* mid-run submission to `followUp()`, so typing `/q` during a run sent the literal string `/q` to the model as a prompt — the commands worked only at the idle task prompt
- A separate `quitRequested` flag rather than reusing `budgetHit`: the two must stay distinguishable, because the budget path prints `[π Budget reached …]` and waits for an acknowledgment while the quit path prints `[π quit requested …]` and breaks immediately. Overloading one flag would make a deliberate quit look like a budget exhaustion
- `abort()` is the same mechanism budget enforcement already uses, and it is documented `void` and non-throwing, so the in-flight `prompt()` settles normally and `runAgentTurn` unwinds through its `finally` (spinner stopped, task line restored to `>`)
- The quit check runs *before* the budget acknowledgment so a user who already asked to stop is not asked to confirm it
- The abort's own rejection is not rendered as `[error]` — a deliberate quit is not an error. Genuine errors still render, since the guard is on `quitRequested` alone
- Blank input remains an end-of-session signal at the top-level loop, and the budget acknowledgment now accepts it too (its prompt says "press enter", but its resolver previously matched only `null` or a quit command)

**Gap**: `/q` typed while a `!cmd` shell command is *executing* lands on an already-resolved `nextTaskResolver`, so it takes effect at the next re-await rather than instantly. `quitRequested` is still set, so the loop exits at its next condition check rather than hanging.

### 8. Bottom Input Rule: Wrap, Don't Fork

**Decision**: `RuledInput` wraps the bottom `Input` and renders one full-width `──` rule *above* it as an extra line. `bottomInput` itself stays a bare `Input`; the wrapper is what gets mounted in the root `Box` and handed to `setFocus`.

**Alternative considered**: Patching pi-tui's `Input` to make its `> ` prompt configurable, or forking the component into this repo. Also considered — and rejected — a leading `│ ` gutter prefixed to each input line: it pushed the `> ` prompt two columns right, which is the one thing the user did not want.

**Rationale**:
- `Input.render()` hardcodes `const prompt = "> "` and the class exposes no prefix property, so neither a gutter nor a rule can be configured — it has to be applied to the rendered output
- Forking the component would mean owning its cursor, kill-ring, undo and bracketed-paste logic; the wrapper is ~20 lines that delegate all of it
- `focused` is forwarded as a getter/setter pair because `Input` only emits `CURSOR_MARKER` when focused, and the TUI needs that marker to place the hardware cursor. The rule is prepended as a separate array element rather than string-concatenated onto the input line, so the marker stays on the input line and can never leak onto the rule
- The rule is its own line, so the inner `Input` still renders at the full `width` — no columns are subtracted and the `> ` prompt stays at column 0
- `visibleWidth` matters for the rule, not `length`: `─` is East-Asian-Width ambiguous, so a width derived from `String.length` could wrap onto a second line
- `'─'.repeat(Math.max(0, width))` guards `String.repeat`'s `RangeError` on a pathologically narrow or zero-width terminal
- Keeping `bottomInput` as the bare `Input` leaves `onSubmit`, `onEscape` and the `setValue('')` in `handleInputSubmit` untouched — only the mounted component changed

### 9. Trim Transcript Text Before It Reaches `Markdown`

**Decision**: Command output is trimmed once at the source — `[stdout, stderr].filter(Boolean).join('\n').trim()` — so the guard, the displayed `Markdown` and the prompt payload all see the same string. Streamed agent output is `trimStart()`ed on the display copy only, leaving `currentAssistantMessageContent` a raw delta accumulator.

**Rationale**:
- This was not only cosmetic. Markdown parses 4+ leading spaces as an *indented code block*, so shell output that starts indented — an `ls`/tree listing, a padded one-liner — was rendered inside ``` fences with per-character syntax highlighting instead of as plain text
- Leading blank lines rendered as actual blank rows, adding vertical noise between transcript entries
- The first shell loop was internally inconsistent: `if (output.trim())` guarded and `shellOutputs.push(output.trim())` trimmed, but `new Markdown(output, …)` rendered the *untrimmed* string. Hoisting the single `.trim()` to the declaration removes the divergence rather than adding a second call
- `.trim()` for command output but `.trimStart()` for the agent stream: a one-shot shell result is complete, while trailing whitespace mid-stream is provisional — and Markdown's two-space soft break would flicker if the tail were stripped on every delta
- Trimming only touches the *leading* edge, so interior indentation a user or model intended survives: `src\n    a.ts\n    b.ts` still renders nested, and a reply that opens with prose followed by an indented code block still renders that code block as a code block

**Alternative considered**: rendering command output with pi-tui's `Text` component instead of `Markdown`. `Text` draws literally, so it would structurally remove every Markdown-syntax trap in shell output — a leading `#` becoming a heading, `*` becoming emphasis, 4-space indentation becoming a code block — rather than only the leading-whitespace symptom. Not adopted here because it changes the transcript's styling and exceeds the ask; see the open question below.

## FollowUp Queue Behavior

### Queue Modes (from pi-agent-core)

```typescript
type QueueMode = "all" | "one-at-a-time";
```

- **`"all"`** — Drain and inject every queued message at next drain point
- **`"one-at-a-time"`** (default) — Drain and inject only oldest message, leave rest for later

### Implications for User

1. **Type-ahead during run**: Each line submitted → one `followUp()` call → one extra turn when drained
2. **Budget still bounds**: `turn_end` fires per turn, budget subscriber calls `abort()` when exceeded
3. **File diff window**: Snapshot taken before task loop, after task loop — mid-run follow-ups land inside same task's diff

## Implementation Details

### File: `src/agent-session.ts`

#### Persistent TUI Initialization (`startPersistentTui`)

```typescript
async function startPersistentTui(): Promise<void> {
  currentTheme = getDefaultTheme();
  dimStyle = { color: (t: string) => `\x1b[2m${t}\x1b[0m` };
  errorStyle = { color: (t: string) => `\x1b[31m${t}\x1b[0m`, bold: true };

  persistentTerminal = new ProcessTerminal();
  persistentTui = new TUI(persistentTerminal);

  // Status bar at top
  statusBar = new Box(1, 0);

  // Conversation area (flex-grow)
  conversationArea = new Box(1, 1);

  // Bottom input
  bottomInput = new Input();
  bottomInput.onSubmit = handleInputSubmit;
  bottomInput.onEscape = () => { /* quit on idle */ };

  // Root container: statusBar | conversationArea | inputRow
  const root = new Box(0, 0);
  root.addChild(statusBar);
  root.addChild(conversationArea);
  // `bottomInput` stays the bare Input so the onSubmit / setValue call sites
  // below are unchanged; the wrapper exists only to draw the '──' rule above it.
  const inputRow = new RuledInput(bottomInput);
  root.addChild(inputRow);

  persistentTui.addChild(root);
  persistentTui.setFocus(inputRow);
  persistentTui.start();
  requestRender();
}
```

#### Input Handling (`handleInputSubmit`)

```typescript
function handleInputSubmit(value: string): void {
  bottomInput.setValue('');

  // Quit commands are intercepted before followUp() — see Decision 7
  if (QUIT_COMMANDS.has(value.trim().toLowerCase())) {
    quitRequested = true;
    // render `[π quit] exiting agent loop`
    if (isAgentRunning) runningAgent?.abort();
    else nextTaskResolver?.(null);
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
    const userMsg = new Markdown(`> ${value}`, 1, 1, currentTheme, dimStyle);
    conversationArea.addChild(userMsg);
    requestRender();
  } else {
    // Idle: resolve the next task promise
    nextTaskResolver?.(value);
  }
}
```

#### Task Loop (simplified)

```typescript
while (true) {
  // Wait for next task
  const task = await new Promise<string | null>(resolve => {
    nextTaskResolver = resolve;
  });

  if (!task) break; // User quit

  // Run agent turn(s)
  isAgentRunning = true;
  await runAgentTurn(task);

  // Check for follow-up turns (tool calls in assistant message)
  while (hasToolCalls(lastAssistantMessage)) {
    await runAgentTurn(''); // Continue turn
  }

  isAgentRunning = false;

  // Show file diff summary
  // ...

  // Budget check
  if (quitRequested) break; // explicit quit outranks the budget acknowledgment
  if (budgetHit) {
    // Acknowledge then break
  }
}
```

The real loop condition is `while (task !== null && !QUIT_COMMANDS.has(task.trim().toLowerCase()) && task.trim() && !budgetHit && !quitRequested)`. The `!quitRequested` term matters for the `!`-shell accumulation branch, which re-arms `nextTaskResolver` at several points and would otherwise re-block after a quit.

## Error Handling

### TUI Teardown

All exit paths must properly stop the TUI:

```typescript
async function cleanupTui(): Promise<void> {
  if (persistentTui) {
    persistentTui.stop();
    persistentTui = null;
  }
  if (persistentTerminal) {
    persistentTerminal = null;
  }
}
```

Called on:
- Normal exit (blank task)
- Budget exceeded
- Error thrown
- Ctrl+C (process SIGINT handler)

### Ctrl+C Handling

The process-level SIGINT handler ensures TUI cleanup:

```typescript
process.on('SIGINT', async () => {
  await cleanupTui();
  process.exit(130);
});
```

## Testing Considerations

### Unit Tests (existing, passing)

- `gatherSkillCandidates` — skill discovery logic
- `loadSelectedSkills` — skill loading and formatting
- `snapshotWorkDir` — file mtime snapshotting for diffs

### Integration Testing Needed

- Persistent TUI rendering with streaming deltas
- followUp queue drain behavior
- Budget enforcement mid-stream
- Quit-command interception (Decision 7)
- Ctrl+C teardown

**Covered**: the pure helpers (`gatherSkillCandidates`, `loadSelectedSkills`, `snapshotWorkDir`, `diffWorkDirSnapshots`, `parseBudget`, `formatBudget`, `buildModelPickerItems`), plus four rendering units that were exported specifically to make them testable — `agentTitleGlyph` (the exact `π π * * π π * *` sequence over the first eight ticks, each glyph held for exactly two, and no tick ever yielding anything but π or `*`), `RuledInput` (rule width via `visibleWidth`, exactly one added line that never wraps, the inner `Input` handed the full width, `CURSOR_MARKER` staying on the input line and never on the rule, `focused`/`handleInput` delegation, zero-width safety), `SPINNER_CHARS` (every frame rendering literally as the task line's leading character, with the unescaped-`+`-becomes-`-` and hanging-indent regressions pinned), and the Markdown leading-whitespace trimming (the 4-space-indented-output-becomes-a-code-block trap, the component's own 1-row top margin as the correct baseline, and interior indentation surviving).

**Not covered**: the running-task spinner's *animation and wiring*, and the quit path — and these cannot get coverage without a design change: `handleInputSubmit`, `runAgentTurn` and the task loop are module-private, and `startAgentSession` needs a TTY, a model choice and an API key. Testing the meaningful property — "given `/q` while running, `followUp` is not called and `abort` is" — would require exporting TUI internals with injectable agent state, or driving a real PTY. Both are larger than the feature; neither is a smoke test worth faking. Note that the frame-rendering tests cover *what a frame renders as*, not that the interval actually advances `spinnerTick`; the `taskLabel` payload/label split is likewise untested, since exercising it needs a real agent turn. The title has the same split: `agentTitleGlyph` covers *which glyph a tick produces*, while the OSC 0 write and the teardown ordering are untested — `writeAgentTitle`/`clearAgentTitle` are module-private and `IS_STDOUT_TTY` is frozen at import, so exercising them needs a real PTY.

## Future Enhancements

1. **Syntax highlighting** — Use `highlightCode` in MarkdownTheme for code blocks
2. **Message folding** — Collapse long tool results
3. **Search/filter** — Find in conversation history
4. **Export** — Save conversation as Markdown/JSON
5. **Themes** — User-selectable color schemes

## Related Documents

- [PLAN.md](../../../PLAN.md) — Implementation plan for this feature
- [CHANGELOG.md](../../../CHANGELOG.md) — Release notes
- [Agent Tools](../reference/agent-tools.md) — Available tools for agent

## References

- pi-tui: `@earendil-works/pi-tui` — TUI framework (ProcessTerminal, TUI, Box, Input, Markdown)
- pi-agent-core: `@earendil-works/pi-agent-core` — Agent loop, followUp/steer queues, event subscription
- pi-ai: `@earendil-works/pi-ai` — Message types (UserMessage, AssistantMessage)