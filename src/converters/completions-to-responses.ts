/**
 * Converter: Chat Completions response to Responses API format
 */

import { OpenAIResponse } from '../types/openai.js';

/**
 * OpenAI Responses API Response format
 */
export interface OpenAIResponsesResponse {
  id: string;
  object: 'response';
  created_at: number;
  status: 'completed' | 'in_progress' | 'failed';
  model: string;
  output_text?: string;
  output: Array<{
    id: string;
    type: 'message' | 'function_call' | 'function_call_output' | 'web_search_call' | 'code_interpreter_call' | 'computer_call' | 'computer_call_output' | 'file_search_call' | 'reasoning' | 'refusal';
    status?: 'completed' | 'in_progress' | 'failed';
    role?: 'assistant' | 'user' | 'system';
    content?: Array<{
      type: 'output_text' | 'input_text' | 'input_image' | 'input_file' | 'refusal';
      text?: string;
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
  namespaceMap?: Map<string, string>
): OpenAIResponsesResponse {
  const responseId = `resp_${completionsResponse.id || generateResponseId()}`;
  const created_at = completionsResponse.created || Math.floor(Date.now() / 1000);

  // Extract the assistant message content
  const choice = completionsResponse.choices?.[0];
  const message = choice?.message;

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
        content: [{ type: 'output_text', text: '' }],
      }],
    };
  }

  if (message) {
    const outputItem: OpenAIResponsesResponse['output'][0] = {
      id: `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
      type: 'message',
      status: 'completed',
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
          outputItem.content = [{ type: 'output_text', text: cleanedText }];
        }
      } else if (Array.isArray(message.content)) {
        const contentParts: NonNullable<typeof outputItem.content> = [];
        for (const part of message.content) {
          if (part.type === 'text') {
            contentParts.push({
              type: 'output_text',
              text: part.text,
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

    // Handle tool calls
    if (message.tool_calls && message.tool_calls.length > 0) {
      for (const toolCall of message.tool_calls) {
        const flatName = toolCall.function?.name || '';
        const namespace = namespaceMap?.get(flatName);
        outputItems.push({
          id: toolCall.id || `tool_${Date.now()}`,
          type: 'function_call',
          status: 'completed',
          name: namespace ? flatName.slice(namespace.replace(/\./g, '_').length + 1) : flatName,
          arguments: toolCall.function?.arguments || '',
          call_id: toolCall.id,
          ...(namespace ? { namespace } : {}),
        });
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
    status: 'completed',
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
  namespaceMap?: Map<string, string>
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