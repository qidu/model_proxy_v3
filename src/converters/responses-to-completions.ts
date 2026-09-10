/**
 * Converter: OpenAI Responses API format to Chat Completions format
 */

import { OpenAIRequest, OpenAIMessage, OpenAIToolCall, OpenAIContent, OpenAIContentPart } from '../types/openai.js';
import { Logger } from '../utils/logger.js';
import { stringify } from '../utils/stringify.js';
import { ValidationError } from '../utils/errors.js';

/**
 * Reports input items this converter did not recognize. The Responses API item
 * union keeps growing (e.g. `program` / `program_output` for programmatic tool
 * calling, `mcp_approval_response`, `computer_call_output`), and an unhandled
 * item would otherwise be dropped from the upstream conversation with no trace.
 */
export interface ConversionWarnings {
  logger?: Logger;
  requestId?: string;
}

function warnUnhandledItem(type: string, warn?: ConversionWarnings): void {
  warn?.logger?.warn(
    warn.requestId ?? '',
    `[responses->completions] dropped unrecognized input item type: ${type || '(missing type)'}`
  );
}

/**
 * Recursively flattens `{ type: "namespace", tools: [...] }` entries (which group
 * `function`/`custom` tools under a shared name) into a flat list of tools. Chat
 * Completions has no namespace concept, so namespace grouping is discarded.
 */
function flattenNamespaces(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const flat: Array<Record<string, unknown>> = [];
  for (const t of tools) {
    if (t.type === 'namespace' && Array.isArray(t.tools)) {
      flat.push(...flattenNamespaces(t.tools as Array<Record<string, unknown>>));
    } else {
      flat.push(t);
    }
  }
  return flat;
}

/**
 * Convert OpenAI Responses API request to Chat Completions request
 */
export function convertResponsesToChatCompletions(
  responsesRequest: Record<string, unknown>,
  model: string,
  warn?: ConversionWarnings
): OpenAIRequest {
  const messages: OpenAIMessage[] = [];

  // model parameter is the alias (already resolved by the caller); prefer it over the raw
  // body field so that model remapping (e.g. codex-mini-latest → gpt-4o-mini) takes effect.
  const responseModel = model || (responsesRequest.model as string);

  // Map top-level instructions to a system message (prepended before input)
  if (responsesRequest.instructions) {
    messages.push({
      role: 'system',
      content: responsesRequest.instructions as string,
    });
  }

  // Convert input items to messages
  const input = responsesRequest.input;
  let additionalTools: Array<Record<string, unknown>> = [];
  if (input) {
    if (typeof input === 'string') {
      // Simple text input - treat as user message
      messages.push({
        role: 'user',
        content: input,
      });
    } else if (Array.isArray(input)) {
      // Array of input items — use the stateful converter to thread reasoning across turns
      const inputItems = input as Array<Record<string, unknown>>;
      // `{ type: "additional_tools", role: "developer", tools: [...] }` items declare
      // extra tools for this turn. Chat Completions has no per-item tool scoping —
      // only one flat request-level `tools` array — so collect them here and merge
      // into the top-level `tools` conversion below (same flat→nested handling,
      // same function-tools-only filter as `responsesRequest.tools`).
      for (const item of inputItems) {
        if (item.type === 'additional_tools' && Array.isArray(item.tools)) {
          additionalTools.push(...(item.tools as Array<Record<string, unknown>>));
        }
      }
      messages.push(...convertInputItemsToMessages(inputItems, warn));
    } else {
      // Object input - treat as user message
      messages.push({
        role: 'user',
        content: stringify(input),
      });
    }
  }

  // Build the completions request
  const completionsRequest: OpenAIRequest = {
    model: responseModel,
    messages,
    stream: responsesRequest.stream === true,
  };

  // Copy optional parameters
  if (responsesRequest.temperature !== undefined) {
    completionsRequest.temperature = responsesRequest.temperature as number;
  }
  if (responsesRequest.max_output_tokens !== undefined) {
    completionsRequest.max_tokens = responsesRequest.max_output_tokens as number;
  } else if (responsesRequest.max_tokens !== undefined) {
    completionsRequest.max_tokens = responsesRequest.max_tokens as number;
  }
  if (responsesRequest.top_p !== undefined) {
    completionsRequest.top_p = responsesRequest.top_p as number;
  }
  if (responsesRequest.stop !== undefined) {
    completionsRequest.stop = responsesRequest.stop as string | string[];
  }
  if (responsesRequest.response_format !== undefined) {
    completionsRequest.response_format = responsesRequest.response_format as { type: 'text' | 'json_object' };
  }
  // Combine top-level `tools` with any `additional_tools` input items (developer-
  // supplied extra tools for this turn — see the `input` loop above). `namespace`
  // tools group `function`/`custom` tools under a shared name — flatten them into
  // the same flat list before conversion (Chat Completions has no namespace concept).
  const allTools = flattenNamespaces([
    ...(Array.isArray(responsesRequest.tools) ? (responsesRequest.tools as Array<Record<string, unknown>>) : []),
    ...additionalTools,
  ]);
  if (allTools.length > 0) {
    // Responses API function tools use a flat format:
    //   { type: "function", name: "fn", description?: "...", parameters: {...} }
    // Chat Completions uses a nested format:
    //   { type: "function", function: { name: "fn", description?: "...", parameters: {...} } }
    // `custom` tools (unconstrained-text tools, no `parameters`) are best-effort
    // converted to function tools with a permissive string-input schema, since
    // Chat Completions has no equivalent tool type.
    // Other non-function Responses API tools (web_search_preview, file_search, mcp, etc.) are dropped.
    const converted = allTools
      .filter(t => t.type === 'function' || t.type === 'custom')
      .map(t => {
        if (t.type === 'custom') {
          warn?.logger?.warn(
            warn.requestId ?? '',
            `[responses->completions] best-effort converting custom tool '${t.name as string}' to a function tool (unconstrained-text input has no Chat Completions equivalent)`
          );
          return {
            type: 'function' as const,
            function: {
              name: t.name as string,
              ...(t.description != null ? { description: t.description as string } : {}),
              parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
            },
          };
        }
        if (t.function != null) {
          // Already in Chat Completions nested format — pass through as-is
          return t as unknown as { type: 'function'; function: { name: string; description?: string; parameters: any } };
        }
        // Responses API flat format → Chat Completions nested format
        return {
          type: 'function' as const,
          function: {
            name: t.name as string,
            ...(t.description != null ? { description: t.description as string } : {}),
            parameters: t.parameters,
          },
        };
      });
    if (converted.length > 0) {
      completionsRequest.tools = converted;
    }
  }
  if (responsesRequest.tool_choice !== undefined) {
    const tc = responsesRequest.tool_choice as Record<string, unknown> | string;
    if (typeof tc === 'object' && tc !== null && tc.type === 'function') {
      // Responses API: { type: "function", name: "fn" }
      // Chat Completions: { type: "function", function: { name: "fn" } }
      completionsRequest.tool_choice = {
        type: 'function',
        function: { name: tc.name as string },
      };
    } else {
      // "auto" | "none" | "required" — pass through as-is
      completionsRequest.tool_choice = tc as OpenAIRequest['tool_choice'];
    }
  }
  if (responsesRequest.frequency_penalty !== undefined) {
    completionsRequest.frequency_penalty = responsesRequest.frequency_penalty as number;
  }
  if (responsesRequest.presence_penalty !== undefined) {
    completionsRequest.presence_penalty = responsesRequest.presence_penalty as number;
  }
  if (responsesRequest.seed !== undefined) {
    completionsRequest.seed = responsesRequest.seed as number;
  }
  if (responsesRequest.logprobs !== undefined) {
    completionsRequest.logprobs = responsesRequest.logprobs as boolean | number;
  }
  if (responsesRequest.top_logprobs !== undefined) {
    completionsRequest.top_logprobs = responsesRequest.top_logprobs as number;
  }
  if (responsesRequest.thinking !== undefined) {
    completionsRequest.thinking = responsesRequest.thinking as { enabled?: boolean; budget_tokens?: number };
  }
  if (responsesRequest.reasoning_effort !== undefined) {
    completionsRequest.reasoning_effort = responsesRequest.reasoning_effort as 'low' | 'medium' | 'high';
  }
  if (responsesRequest.prompt_cache_key !== undefined) {
    completionsRequest.prompt_cache_key = responsesRequest.prompt_cache_key as string;
  }

  return completionsRequest;
}

/**
 * Convert a list of input items to messages, threading reasoning_content from
 * standalone reasoning items through to adjacent assistant/function_call turns.
 *
 * A single assistant turn can be split across several input items — one or more
 * function_call items plus an assistant `message` item carrying the turn's text,
 * in either order (some clients replay the call before its own preceding text),
 * possibly interleaved with a standalone `reasoning` item. All of these are
 * merged into ONE assistant message here: Anthropic-compatible upstreams (and
 * Chat Completions/DeepSeek) reject two consecutive assistant messages, and
 * require a tool_use block's tool_result to immediately follow the single
 * message that emitted it.
 */
export function convertInputItemsToMessages(items: Array<Record<string, unknown>>, warn?: ConversionWarnings): OpenAIMessage[] {
  const allMessages: OpenAIMessage[] = [];
  let pendingReasoningContent: string | null = null;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    if (item.type === 'reasoning') {
      pendingReasoningContent = extractReasoningText(item) ?? pendingReasoningContent;
      continue; // no message emitted for reasoning items
    }

    const isAssistantMessage = item.type === 'message' && item.role === 'assistant';
    if (item.type === 'function_call' || isAssistantMessage) {
      const toolCalls: OpenAIToolCall[] = [];
      const textParts: string[] = [];
      let reasoningText = pendingReasoningContent;
      pendingReasoningContent = null;

      const consumeTurnItem = (turnItem: Record<string, unknown>): void => {
        if (turnItem.type === 'function_call') {
          toolCalls.push({
            id: (turnItem.call_id as string) || (turnItem.id as string),
            type: 'function',
            function: {
              name: turnItem.name as string,
              arguments: turnItem.arguments as string,
            },
          });
        } else {
          const parts = extractAssistantMessageParts(turnItem);
          if (parts.text) textParts.push(parts.text);
          if (parts.reasoningText) reasoningText = parts.reasoningText;
        }
      };
      consumeTurnItem(item);

      // Absorb any further function_call / assistant-message items belonging to
      // the same turn, skipping over (and consuming) interleaved reasoning items.
      while (i + 1 < items.length) {
        const next = items[i + 1];
        if (next.type === 'function_call' || (next.type === 'message' && next.role === 'assistant')) {
          i++;
          consumeTurnItem(items[i]);
          continue;
        }
        if (next.type === 'reasoning') {
          i++;
          reasoningText = extractReasoningText(items[i]) ?? reasoningText;
          continue;
        }
        break;
      }

      const combinedText = textParts.join('');
      if (!combinedText && toolCalls.length === 0 && !reasoningText) {
        // Nothing meaningful to emit (matches prior behavior of dropping empty
        // assistant message items).
        continue;
      }

      const assistantMsg: OpenAIMessage = {
        role: 'assistant',
        content: (combinedText || (toolCalls.length > 0 ? null : '')) as unknown as string,
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      if (reasoningText) {
        (assistantMsg as unknown as Record<string, unknown>).reasoning_content = reasoningText;
      }
      allMessages.push(assistantMsg);
      continue;
    }

    const msgs = convertInputItemToMessages(item, pendingReasoningContent, warn);
    if (item.type === 'message') {
      pendingReasoningContent = null;
    }
    allMessages.push(...msgs);
  }
  return allMessages;
}

/**
 * Extract concatenated reasoning_text from a standalone `reasoning` input item's
 * content array, or null if none present.
 */
function extractReasoningText(item: Record<string, unknown>): string | null {
  const content = item.content as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(content)) return null;
  const text = content
    .filter(c => c.type === 'reasoning_text')
    .map(c => c.text as string)
    .join('');
  return text || null;
}

/**
 * Extract the output text and any embedded reasoning_text from an assistant
 * `message` input item, whether its content is a plain string or a content-part
 * array (as seen in replayed Responses API output).
 */
function extractAssistantMessageParts(item: Record<string, unknown>): { text: string; reasoningText: string | null } {
  const content = item.content;
  if (typeof content === 'string') {
    return { text: content, reasoningText: null };
  }
  if (Array.isArray(content)) {
    const textPart = content.find((c: Record<string, unknown>) => c.type === 'output_text');
    const reasoningPart = content.find((c: Record<string, unknown>) => c.type === 'reasoning_text');
    return {
      text: textPart ? (textPart as Record<string, unknown>).text as string : '',
      reasoningText: reasoningPart ? (reasoningPart as Record<string, unknown>).text as string : null,
    };
  }
  return { text: '', reasoningText: null };
}

/**
 * Convert a single input item to one or more messages
 */
function convertInputItemToMessages(item: Record<string, unknown>, pendingReasoningContent?: string | null, warn?: ConversionWarnings): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];
  const role = item.role as string;
  const type = item.type as string;

  if (type === 'additional_tools') {
    // Developer-supplied extra tools for this turn — consumed by the tools
    // merge in convertResponsesToChatCompletions above. Emit nothing here.
    return messages;
  }

  if (type === 'reasoning') {
    // Standalone reasoning output item — consumed by convertInputItemsToMessages above.
    // Emit nothing here; the reasoning text is attached to the next assistant turn.
    return messages;
  }

  if (type === 'message') {
    const content = item.content;
    if (role === 'assistant' && Array.isArray(content)) {
      // Output messages passed as input (continuing conversations) — extract output_text.
      // When the prior turn used thinking mode, also pull out reasoning_text so
      // upstreams like DeepSeek that require reasoning_content to be round-tripped
      // (when sending the conversation back on a later turn) do not reject the request.
      const textContent = content.find(
        (c: Record<string, unknown>) => c.type === 'output_text'
      );
      const reasoningContent = content.find(
        (c: Record<string, unknown>) => c.type === 'reasoning_text'
      );
      if (textContent || reasoningContent) {
        const assistantMsg: OpenAIMessage = {
          role: 'assistant',
          content: textContent
            ? (textContent as Record<string, unknown>).text as string
            : '',
        };
        if (reasoningContent) {
          (assistantMsg as unknown as Record<string, unknown>).reasoning_content =
            (reasoningContent as Record<string, unknown>).text as string;
        }
        messages.push(assistantMsg);
      }
    } else if (content) {
      messages.push({
        role: convertRole(role),
        content: convertResponsesContentToCompletions(content),
      });
    }
  } else if (type === 'function_call') {
    // Assistant-side tool call — map to an assistant message with tool_calls.
    // Attach reasoning_content when a preceding reasoning item was collected so
    // thinking-mode upstreams (e.g. DeepSeek) don't reject the multi-turn request.
    const assistantMsg: OpenAIMessage = {
      role: 'assistant',
      content: null as unknown as string,
      tool_calls: [{
        id: item.call_id as string || item.id as string,
        type: 'function',
        function: {
          name: item.name as string,
          arguments: item.arguments as string,
        },
      }],
    };
    if (pendingReasoningContent) {
      (assistantMsg as unknown as Record<string, unknown>).reasoning_content = pendingReasoningContent;
    }
    messages.push(assistantMsg);
  } else if (type === 'function_call_output') {
    // Tool result — map to a tool message. `output` can be a string or an
    // array of input_text/input_image/input_file parts (same union as
    // message content), so reuse the shared converter instead of assuming string.
    messages.push({
      role: 'tool',
      content: item.output != null ? convertResponsesContentToCompletions(item.output) : '',
      tool_call_id: item.call_id as string,
    });
  } else if (type === 'program' || type === 'program_output') {
    // Programmatic tool calling has no Chat Completions equivalent: `program`
    // carries a flat JavaScript `code` string (not per-tool structured calls we
    // could map onto `tool_calls`), and its `fingerprint` is an opaque replay
    // token the spec says "must be round-tripped" — there is nowhere in a
    // `messages` array to carry it. Flattening to text would yield a
    // conversation that looks intact while silently breaking program replay
    // upstream, so refuse the request instead of degrading it.
    throw new ValidationError(
      `Item type '${type}' (programmatic tool calling) cannot be converted to the Chat Completions API. ` +
      `Use an 'openai-responses' upstream to pass these items through unmodified.`
    );
  } else {
    // Unrecognized item type — emit nothing, but say so rather than dropping
    // conversation content silently.
    warnUnhandledItem(type, warn);
  }

  return messages;
}

/**
 * Convert Responses API role to Chat Completions role
 */
function convertRole(role: string): OpenAIMessage['role'] {
  switch (role) {
    case 'system':
      return 'system';
    case 'developer':
      return 'system';
    case 'user':
      return 'user';
    case 'assistant':
      return 'assistant';
    default:
      return 'user';
  }
}

/**
 * Convert content to string representation for simple message format
 */
/**
 * Convert a Responses-API content value (string or array of `input_text` /
 * `input_image` / `input_file` parts) into the Chat Completions `content`
 * shape.
 *
 * - String content returns as-is.
 * - Array content without any `input_image` parts collapses to a joined text
 *   string (preserves the existing wire shape and avoids unnecessarily
 *   switching to array-form `content`).
 * - Array content containing one or more `input_image` parts returns an
 *   `OpenAIContentPart[]` mixing `{type:'text'}` and `{type:'image_url'}`.
 *   The Responses `image_url` (string or `{url, detail}` object) is normalized
 *   to the Completions object form `{url, detail?}`.
 * - `input_file` parts still emit a `[File: ...]` text placeholder (no
 *   Completions-native file part exists).
 *
 * Note: callers that route through `completionsToClaudeBody` (handlers/openai.ts)
 * will further convert `image_url` parts into Claude `image` blocks (with
 * server-side fetch for http URLs).
 */
function convertResponsesContentToCompletions(content: unknown): OpenAIContent {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return stringify(content);
  }

  const parts: OpenAIContentPart[] = [];
  let hasImage = false;
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue;
    const partObj = part as Record<string, unknown>;
    if (partObj.type === 'input_text') {
      parts.push({ type: 'text', text: (partObj.text as string) ?? '' });
    } else if (partObj.type === 'input_image') {
      hasImage = true;
      // Responses accepts image_url as either a string or {url, detail?} object.
      // Completions requires the object form — normalize.
      const url = partObj.image_url as unknown;
      const normalized = typeof url === 'string'
        ? { url }
        : (url as { url: string; detail?: 'low' | 'high' | 'auto' }) ?? { url: '' };
      parts.push({ type: 'image_url', image_url: normalized });
    } else if (partObj.type === 'input_file') {
      parts.push({ type: 'text', text: `[File: ${(partObj.filename as string) || 'unknown'}]` });
    }
  }

  if (!hasImage) {
    // Collapse text-only content to a string (matches prior wire shape).
    return parts
      .map(p => (p.type === 'text' ? p.text : ''))
      .filter(t => t !== '')
      .join('\n');
  }
  return parts;
}