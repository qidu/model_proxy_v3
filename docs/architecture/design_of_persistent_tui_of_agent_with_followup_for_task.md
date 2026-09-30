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
│        Bottom Input (Input)         │  ← Pinned, onSubmit handler
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
let currentTheme: MarkdownTheme;
let dimStyle: DefaultTextStyle;
let errorStyle: DefaultTextStyle;

// Agent runtime state
let isAgentRunning = false;
let runningAgent: Agent | null = null;
let nextTaskResolver: ((value: string | null) => void) | null = null;

// Budget/turn tracking
let budgetHit = false;
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

**Decision**: `conversationArea.clear()` + `addChild(currentAssistantMessage)` on new turn.

**Rationale**:
- pi-tui's `Box` has `clear()` and `addChild()` but no `replaceChildren()`
- Simple and reliable — no need to track individual message components

### 5. Status Bar Updates

**Decision**: Synchronous `updateStatusBar()` called on every tool/result/event.

**Rationale**:
- Low overhead — just recreates Markdown text
- Keeps counts accurate without debouncing complexity

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

  // Root container: statusBar | conversationArea | bottomInput
  const root = new Box(0, 0);
  root.addChild(statusBar);
  root.addChild(conversationArea);
  root.addChild(bottomInput);

  persistentTui.setRoot(root);
  persistentTui.start();
  requestRender();
}
```

#### Input Handling (`handleInputSubmit`)

```typescript
function handleInputSubmit(value: string): void {
  bottomInput.setValue('');

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
  if (budgetHit) {
    // Acknowledge then break
  }
}
```

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
- Ctrl+C teardown

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