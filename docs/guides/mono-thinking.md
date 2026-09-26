Summary of 'Thinking' Types in pi-mono LLM API Responses                                                                                    
  Based on my analysis of the pi-mono repository, here's a comprehensive summary of the 'thinking' type in LLM API responses:                 
  1. Core Type Definitions                                                                                                                    
  ThinkingContent Interface (packages/ai/src/types.ts:143-151):
  export interface ThinkingContent {
    type: "thinking";
    thinking: string;
    thinkingSignature?: string; // e.g., for OpenAI responses, the reasoning item ID
    /** When true, the thinking content was redacted by safety filters. The opaque
     * encrypted payload is stored in `thinkingSignature` so it can be passed back
     * to the API for multi-turn continuity. */
    redacted?: boolean;
  }

  ThinkingLevel Type (packages/ai/src/types.ts:45):
  export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

  2. Thinking Events in Stream Protocol

  The stream protocol defines several thinking-related events in AssistantMessageEvent type (packages/ai/src/types.ts:236-248):

  - thinking_start: Emitted when a thinking block begins
  - thinking_delta: Emitted for incremental updates to thinking content
  - thinking_end: Emitted when a thinking block completes

  3. Provider-Specific Handling

  OpenAI Completions (packages/ai/src/providers/openai-completions.ts):
  - Converts OpenAI's reasoning blocks to ThinkingContent
  - Handles streaming thinking updates with thinking_delta events
  - Supports reasoning_effort parameter mapping to thinking levels

  Anthropic (packages/ai/src/providers/anthropic.ts):
  - Handles both regular thinking (thinking) and redacted thinking (redacted_thinking)
  - Supports adaptive thinking for Opus 4.6/Sonnet 4.6
  - Uses thinkingBudgetTokens for older models
  - Maps thinking effort levels: "minimal", "low", "medium", "high"

  4. Configuration Options

  SimpleStreamOptions includes thinking configuration:
  export interface SimpleStreamOptions extends StreamOptions {
    reasoning?: ThinkingLevel;
    /** Custom token budgets for thinking levels (token-based providers only) */
    thinkingBudgets?: ThinkingBudgets;
  }

  ThinkingBudgets interface:
  export interface ThinkingBudgets {
    minimal?: number;
    low?: number;
    medium?: number;
    high?: number;
  }

  5. Model Configuration

  Model interface includes thinking support:
  export interface Model<TApi extends Api> {
    // ...
    reasoning: boolean; // Whether the model supports thinking/reasoning
    // ...
  }

  6. Compatibility Settings

  OpenAICompletionsCompat includes thinking format options:
  thinkingFormat?: "openai" | "zai" | "qwen" | "qwen-chat-template";

  Different providers use different parameters:
  - OpenAI: reasoning_effort
  - Zai: enable_thinking: boolean
  - Qwen: enable_thinking: boolean or chat_template_kwargs.enable_thinking

  7. Usage Examples

  From test files, thinking is typically consumed like this:
  for await (const event of s) {
    if (event.type === "thinking_start") {
      thinkingStarted = true;
    } else if (event.type === "thinking_delta") {
      thinkingChunks += event.delta;
    } else if (event.type === "thinking_end") {
      thinkingCompleted = true;
    }
  }

  8. Key Features

  1. Unified Interface: All providers expose thinking through the same ThinkingContent type
  2. Streaming Support: Real-time thinking updates via event stream
  3. Redacted Thinking: Support for safety-filtered thinking with opaque signatures
  4. Level-Based Control: Granular control over thinking depth/effort
  5. Provider Abstraction: Different provider APIs normalized to common interface
  6. Multi-Turn Continuity: Thinking signatures preserve context across conversations

  9. Supported Providers

  The system supports thinking/reasoning across multiple providers:
  - OpenAI (with reasoning_effort)
  - Anthropic (with thinkingEnabled/thinkingBudgetTokens)
  - Google (with thoughtSignature)
  - Various OpenAI-compatible providers with different thinking formats

  This unified thinking system allows applications to leverage model reasoning capabilities consistently across different LLM providers while
  handling provider-specific implementations transparently.

