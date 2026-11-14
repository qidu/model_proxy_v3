/**
 * Converter: Chat Completions ↔ Responses API — **both directions**.
 *
 * This file holds the pair in both directions, as `claude-to-gemini.ts` and
 * `gemini-to-openai.ts` do for theirs:
 *
 *   - Completions **response** → Responses response: `convertCompletionsToResponses`
 *     and `convertCompletionsToCompactedResponse`. What an `openai-completions`
 *     upstream answered, re-rendered for a `/v1/responses` client.
 *   - Completions **request body** → Responses request body: `completionsToResponsesBody`.
 *     The second hop every client format takes before an `openai-responses` upstream
 *     (`handleOpenAIRequest`, `chat-completions.ts`, `messages.ts`).
 *
 * The first half also owns the two Completions-side readers the Messages hop shares
 * with it — `openAIContentToText` and `completionsForcedToolName` — which is why
 * `completions-to-claude.ts` imports from here rather than the other way round.
 */

import { OpenAIContent, OpenAIMessage, OpenAIResponse } from '../types/openai.js';
import { NamespaceMap } from './responses-to-completions.js';
import { Logger } from '../utils/logger.js';

/**
 * OpenAI Responses API Response format
 */
export interface OpenAIResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed' | 'in_progress' | 'failed' | 'incomplete';
  incomplete_details?: { reason: string };
  model: string;
  output_text?: string;
  output: Array<{
    id: string;
    type: 'message' | 'function_call' | 'function_call_output' | 'web_search_call' | 'code_interpreter_call' | 'computer_call' | 'computer_call_output' | 'file_search_call' | 'reasoning' | 'refusal';
    status?: 'completed' | 'in_progress' | 'failed' | 'incomplete';
    role?: 'assistant' | 'user' | 'system';
    content?: Array<{
      type: 'output_text' | 'input_text' | 'input_image' | 'input_file' | 'refusal';
      text?: string;
      annotations?: unknown[];
      image_url?: string;
      file_id?: string;
    }>;
    name?: string;
    arguments?: string;
    call_id?: string;
    output?: string;
    namespace?: string;
  }>;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    input_tokens_details?: {
      cached_tokens: number;
      audio_tokens?: number;
    };
    output_tokens_details?: {
      audio_tokens?: number;
      reasoning_tokens?: number;
    };
  };
}

/**
 * Convert Chat Completions response to Responses API format
 */
export function convertCompletionsToResponses(
  completionsResponse: OpenAIResponse,
  model: string,
  namespaceMap?: NamespaceMap,
  options?: { allowedTools?: Set<string> | null; logger?: Logger; requestId?: string }
): OpenAIResponsesResponse {
  const allowedTools = options?.allowedTools;
  const responseId = `resp_${completionsResponse.id || generateResponseId()}`;
  const created_at = completionsResponse.created || Math.floor(Date.now() / 1000);

  // Extract the assistant message content
  const choice = completionsResponse.choices?.[0];
  const message = choice?.message;
  // finish_reason "length" means the model exhausted its token budget — the
  // response (and its open item) is terminal-incomplete, not completed.
  const isIncomplete = choice?.finish_reason === 'length';

  // Build output items from the chat completion message
  const outputItems: OpenAIResponsesResponse['output'] = [];

  // Guard: if choices is empty/missing, return a fallback message item so output is never [].
  // output: [] is always invalid per the Responses API spec.
  if (!completionsResponse.choices?.length) {
    return {
      id: responseId,
      object: 'response',
      created_at,
      status: 'completed',
      model: completionsResponse.model || model,
      output: [{
        id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
        type: 'message',
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: '', annotations: [] }],
      }],
    };
  }

  if (message) {
    const outputItem: OpenAIResponsesResponse['output'][0] = {
      id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      type: 'message',
      status: isIncomplete ? 'incomplete' : 'completed',
      role: 'assistant',
      content: [],
    };

    // Accumulate reasoning text from upstream (DeepSeek: message.reasoning_content
    // as a string field; OpenAI thinking-mode: content part with type === 'thinking').
    // Both formats must round-trip back so multi-turn conversations with thinking
    // mode don't reject the next turn with "reasoning_content must be passed back".
    let reasoningText = '';
    const reasoningMsg = message as unknown as Record<string, unknown>;
    if (typeof reasoningMsg.reasoning_content === 'string' && reasoningMsg.reasoning_content) {
      reasoningText += reasoningMsg.reasoning_content;
    }

    // Handle text content
    if (message.content) {
      if (typeof message.content === 'string') {
        const thinkRegex = /<(?:thinking|think)>([\s\S]*?)<\/(?:thinking|think)>/g;
        let m;
        while ((m = thinkRegex.exec(message.content)) !== null) {
          reasoningText += m[1];
        }
        const cleanedText = message.content.replace(/<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>/g, '').trim();
        if (cleanedText) {
          outputItem.content = [{ type: 'output_text', text: cleanedText, annotations: [] }];
        }
      } else if (Array.isArray(message.content)) {
        const contentParts: NonNullable<typeof outputItem.content> = [];
        for (const part of message.content) {
          if (part.type === 'text') {
            contentParts.push({
              type: 'output_text',
              text: part.text,
              annotations: [],
            });
          } else if (part.type === 'image_url') {
            // Forward image as input_image with the URL
            contentParts.push({
              type: 'input_image',
              image_url: part.image_url?.url,
            });
          } else if (part.type === 'thinking') {
            // OpenAI-style thinking content part — capture for reasoning item
            reasoningText += (part as { thinking?: string }).thinking ?? '';
          }
        }
        outputItem.content = contentParts.length > 0 ? contentParts : [];
      }
    }

    // Emit a reasoning output item (and embed reasoning_text inside the assistant
    // message content) when upstream produced reasoning content. Codex sends the
    // conversation back as input and DeepSeek requires reasoning_content on the
    // assistant turn, so preserving the text on both shapes keeps the round-trip
    // intact.
    if (reasoningText) {
      outputItems.push({
        id: `reasoning_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
        type: 'reasoning',
        status: 'completed',
        content: [{ type: 'reasoning_text', text: reasoningText }],
      } as unknown as OpenAIResponsesResponse['output'][0]);
      // Also append reasoning_text as a content part on the assistant message,
      // matching the Codex-side representation it sends as input on the next turn.
      if (outputItem.content) {
        outputItem.content.push({
          type: 'reasoning_text' as unknown as 'output_text',
          text: reasoningText,
        } as unknown as NonNullable<typeof outputItem.content>[0]);
      }
    }

    // Handle tool calls. allowedTools is a hard constraint (spec): calls to
    // tools outside the set are suppressed and reported, never returned.
    if (message.tool_calls && message.tool_calls.length > 0) {
      let suppressedCalls = 0;
      for (const toolCall of message.tool_calls) {
        const flatName = toolCall.function?.name || '';
        const entry = namespaceMap?.get(flatName);
        if (allowedTools != null && !allowedTools.has(entry ? entry.name : flatName)) {
          suppressedCalls++;
          continue;
        }
        outputItems.push({
          id: toolCall.id || `tool_${Date.now()}`,
          type: 'function_call',
          status: 'completed',
          name: entry ? entry.name : flatName,
          arguments: toolCall.function?.arguments || '',
          call_id: toolCall.id,
          ...(entry?.namespace ? { namespace: entry.namespace } : {}),
        });
      }
      if (suppressedCalls > 0) {
        options?.logger?.warn(options?.requestId ?? '', `[responses] suppressed ${suppressedCalls} tool call(s) outside allowed_tools`);
      }
    }

    // Only include the message item when it has actual content.
    // Tool-call-only responses (finish_reason: "tool_calls") leave content null,
    // so the message item would be empty — omit it to stay spec-compliant.
    const hasContent = outputItem.content && outputItem.content.length > 0;
    if (hasContent) {
      outputItems.push(outputItem);
    }
  }

  // output: [] is invalid per spec. If every tool call was suppressed (or the
  // message was otherwise empty) and only a reasoning item remains, emit a
  // fallback empty-text message item — the spec's "direct reply" fallback.
  if (outputItems.every(it => it.type === 'reasoning')) {
    outputItems.push({
      id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      type: 'message',
      status: isIncomplete ? 'incomplete' : 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    });
  }

  // Build usage info
  const usage = completionsResponse.usage ? {
    input_tokens: completionsResponse.usage.prompt_tokens,
    output_tokens: completionsResponse.usage.completion_tokens,
    total_tokens: completionsResponse.usage.total_tokens,
    input_tokens_details: {
      cached_tokens: completionsResponse.usage.prompt_cache_hit_tokens || 0,
    },
  } : undefined;

  // Collect all output_text content across message output items for the convenience field
  const outputTextParts: string[] = [];
  for (const item of outputItems) {
    if (item.type === 'message' && item.content) {
      for (const part of item.content) {
        if (part.type === 'output_text' && part.text) {
          outputTextParts.push(part.text);
        }
      }
    }
  }
  const output_text = outputTextParts.length > 0 ? outputTextParts.join('') : undefined;

  return {
    id: responseId,
    object: 'response',
    created_at,
    status: isIncomplete ? 'incomplete' : 'completed',
    ...(isIncomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    model: completionsResponse.model || model,
    output_text,
    output: outputItems,
    usage,
  };
}

/**
 * Generate a response ID
 */
function generateResponseId(): string {
  return `resp_${crypto.randomUUID().replace(/-/g, '')}`;
}

/**
 * CompactedResponse format (object: "response.compaction")
 */
export interface CompactedResponse {
  id: string;
  object: 'response.compaction';
  created_at: number;
  output: OpenAIResponsesResponse['output'];
  usage?: OpenAIResponsesResponse['usage'];
}

/**
 * Convert Chat Completions response to CompactedResponse format
 */
export function convertCompletionsToCompactedResponse(
  completionsResponse: OpenAIResponse,
  model: string,
  namespaceMap?: NamespaceMap
): CompactedResponse {
  const base = convertCompletionsToResponses(completionsResponse, model, namespaceMap);
  return {
    id: base.id,
    object: 'response.compaction',
    created_at: base.created_at,
    output: base.output,
    usage: base.usage,
  };
}

// ---------------------------------------------------------------------------
// Completions request body → Responses request body (the second hop)
// ---------------------------------------------------------------------------

export function openAIContentToText(content: OpenAIContent | null | undefined): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(part => part.type === 'text')
    .map(part => 'text' in part ? part.text : '')
    .join('');
}

/**
 * Convert an OpenAI Chat Completions message `content` into Responses API
 * content parts (`input_text` / `output_text` / `input_image`). Used by
 * `completionsToResponsesBody` to route Completions clients through an
 * `openai-responses` upstream.
 *
 * `image_url` parts are forwarded as `input_image`; the Chat Completions
 * `{url, detail}` object is unwrapped into the Responses API's string `image_url`
 * with `detail` as a sibling. The Responses upstream performs its own fetch — no
 * in-proxy SSRF-guarded fetch is needed.
 */
function openAIContentToResponsesParts(
  content: OpenAIContent | null | undefined,
  textType: 'input_text' | 'output_text',
): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  if (typeof content === 'string') {
    parts.push({ type: textType, text: content });
    return parts;
  }
  if (!Array.isArray(content)) return parts;
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: textType, text: part.text });
    } else if (part.type === 'image_url') {
      // The Responses API wants `image_url` as a plain string — a fully qualified URL
      // or a base64 data URL — with `detail` as a *sibling* on the item
      // (`docs/api/openai-response-methods-create.md`: "image_url: optional string or
      // null"). That is the opposite of the Chat Completions shape arriving here, where
      // `image_url` is an object, so it is unwrapped; a client that already sent the
      // string form is passed through unchanged.
      const image = part.image_url as { url?: unknown; detail?: unknown } | string | undefined;
      if (typeof image === 'string') {
        parts.push({ type: 'input_image', image_url: image });
      } else {
        const imagePart: Record<string, unknown> = { type: 'input_image', image_url: image?.url };
        if (image?.detail !== undefined) imagePart.detail = image.detail;
        parts.push(imagePart);
      }
    }
    // Unknown part types (e.g. thinking) are skipped here.
  }
  return parts;
}

/**
 * Emit a Responses `reasoning` item for each `thinking` content part on an assistant
 * message. Called where the message item is pushed rather than up front, so the item
 * order matches the `/v1/messages` converter this one replaced: `reasoning_content`
 * first as the turn's preamble, then the `function_call` items, then this reasoning,
 * then the message. `openAIContentToResponsesParts` skips `thinking` parts, so the
 * text does not also appear as `input_text`/`output_text`.
 */
function pushThinkingReasoning(msg: OpenAIMessage, input: unknown[]): void {
  if (msg.role !== 'assistant' || !Array.isArray(msg.content)) return;
  for (const part of msg.content as unknown as Array<Record<string, unknown>>) {
    if (part.type === 'thinking') {
      input.push({
        type: 'reasoning',
        content: [{ type: 'reasoning_text', text: (part.thinking as string) ?? '' }],
      });
    }
  }
}

/** The forced function name of a Completions `{type:'function', function:{name}}` tool_choice. */
export function completionsForcedToolName(toolChoice: unknown): string | undefined {
  if (!toolChoice || typeof toolChoice !== 'object') return undefined;
  const name = ((toolChoice as Record<string, unknown>).function as Record<string, unknown> | undefined)?.name;
  return typeof name === 'string' && name !== '' ? name : undefined;
}

/** Map a Completions `tool_choice` onto the Responses vocabulary. */
function completionsToolChoiceToResponses(toolChoice: unknown): unknown {
  if (toolChoice === 'auto' || toolChoice === 'none' || toolChoice === 'required') return toolChoice;
  const name = completionsForcedToolName(toolChoice);
  return name === undefined ? undefined : { type: 'function', name };
}

/**
 * Convert an OpenAI Chat Completions body to an OpenAI Responses body (`input`).
 * Used to route Gemini endpoints (interactions/generateContent) through an
 * openai-responses upstream.
 */
export function completionsToResponsesBody(completions: Record<string, unknown>, model: string): Record<string, unknown> {
  const messages = (completions.messages as OpenAIMessage[]) || [];
  const input: unknown[] = [];
  const instructions = messages
    .filter(msg => msg.role === 'system' || msg.role === 'developer')
    .map(msg => openAIContentToText(msg.content))
    .filter(text => text !== '')
    .join('\n');

  for (const msg of messages) {
    if (msg.role === 'system' || msg.role === 'developer') {
      continue;
    }

    // Reasoning round-trip. An OpenAI thinking-mode upstream (DeepSeek) sets
    // `reasoning_content` on the assistant message, and a `thinking` content part
    // carries the same text; either must come back as a Responses `reasoning` item on
    // the next turn or the upstream rejects it with "reasoning_content must be passed
    // back". Taken from the `/v1/messages` converter, which had this and this one did
    // not — the same body shape reaches both.
    //
    // Only the `reasoning_content` half is emitted here. A `thinking` content part is
    // emitted by `pushThinkingReasoning` where the message item is pushed, which keeps
    // the item order this converter inherited: the preamble reasoning first, then the
    // turn's `function_call` items, then the reasoning carried inside `content[]`, then
    // the message.
    if (msg.role === 'assistant') {
      const inlineReasoning = (msg as unknown as Record<string, unknown>).reasoning_content;
      if (typeof inlineReasoning === 'string' && inlineReasoning) {
        input.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text: inlineReasoning }] });
      }
    }

    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      for (const tc of msg.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function.name,
          arguments: tc.function.arguments,
        });
      }
      pushThinkingReasoning(msg, input);
      const contentParts = openAIContentToResponsesParts(msg.content, 'output_text');
      if (msg.content !== '' && contentParts.length > 0) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: contentParts,
        });
      }
      continue;
    }

    if (msg.role === 'tool') {
      // `output` must be a string. A string passes through unchanged and an array of
      // parts is text-extracted as before; anything else is serialized, because a client
      // may send the tool result as an object and the text extractor yields '' for it —
      // that silently dropped the whole result. The serialize branch is the
      // `/v1/messages` converter's rule, kept when the two merged
      // (`tests/unit/messages-handler.test.ts`).
      const toolContent = msg.content;
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id,
        output: typeof toolContent === 'string'
          ? toolContent
          : Array.isArray(toolContent)
            ? openAIContentToText(toolContent)
            : JSON.stringify(toolContent ?? ''),
      });
      continue;
    }

    // Prior assistant turns replayed as input must use `output_text` (mirrors what
    // the upstream originally emitted); user turns use `input_text`.
    const textType = msg.role === 'assistant' ? 'output_text' : 'input_text';
    const contentParts = openAIContentToResponsesParts(msg.content, textType);
    pushThinkingReasoning(msg, input);
    input.push({
      type: 'message',
      role: msg.role,
      content: contentParts.length > 0 ? contentParts : [{ type: textType, text: '' }],
    });
  }

  const responsesBody: Record<string, unknown> = {
    model,
    input,
    stream: completions.stream === true,
  };
  if (instructions) responsesBody.instructions = instructions;

  if (completions.temperature !== undefined) responsesBody.temperature = completions.temperature;
  if (completions.top_p !== undefined) responsesBody.top_p = completions.top_p;
  // Legacy `max_tokens` wins when both names are present; `max_completion_tokens` is the
  // newer OpenAI spelling and is the only one some clients send. Same precedence as
  // `completionsToClaudeBody`. Carrying only the legacy name left a client that used the
  // newer one with no output bound at all on a Responses upstream.
  const maxOutputTokens = (completions.max_tokens as number | undefined)
    ?? (completions.max_completion_tokens as number | undefined);
  if (maxOutputTokens !== undefined) responsesBody.max_output_tokens = maxOutputTokens;
  if (completions.prompt_cache_key !== undefined) responsesBody.prompt_cache_key = completions.prompt_cache_key;
  // Retention and reasoning: same field name on both sides for `store`; the
  // Completions scalar `reasoning_effort` is the Responses nested `reasoning.effort`.
  // Both are set by `convertGeminiInteractionsToOpenAI` for an Interactions client,
  // and either may already be on the body from a Completions client.
  if (completions.store !== undefined) responsesBody.store = completions.store;
  if (completions.reasoning_effort !== undefined) {
    responsesBody.reasoning = { effort: completions.reasoning_effort };
  }
  // Structured output: Chat Completions spells it `response_format`, the Responses
  // API `text.format`. The inverse of `responses-to-completions.ts:197-213`, which is
  // the shape unwrapped here. A `type` outside the three it accepts is left unmapped,
  // as it was before this mapping existed rather than throwing on a shared converter.
  const responseFormat = completions.response_format as Record<string, unknown> | undefined;
  if (responseFormat && typeof responseFormat === 'object') {
    if (responseFormat.type === 'json_schema') {
      const jsonSchema = responseFormat.json_schema as Record<string, unknown> | undefined;
      responsesBody.text = {
        format: {
          type: 'json_schema',
          name: (jsonSchema?.name as string) ?? 'response',
          schema: jsonSchema?.schema,
          ...(jsonSchema?.strict !== undefined ? { strict: jsonSchema.strict } : {}),
        },
      };
    } else if (responseFormat.type === 'json_object' || responseFormat.type === 'text') {
      responsesBody.text = { format: { type: responseFormat.type } };
    }
  }
  if (completions.tools && Array.isArray(completions.tools) && (completions.tools as unknown[]).length > 0) {
    responsesBody.tools = (completions.tools as Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>).map(t => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    }));

    // Gated on the tools above: a tool_choice with no tools is rejected upstream.
    const toolChoice = completionsToolChoiceToResponses(completions.tool_choice);
    if (toolChoice !== undefined) responsesBody.tool_choice = toolChoice;
  }

  return responsesBody;
}
