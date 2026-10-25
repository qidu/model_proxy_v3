/**
 * Converter from OpenAI API format to Claude API format
 */

import { ClaudeMessagesResponse, ClaudeContentBlock, ClaudeTokenCountingResponse } from '../types/claude.js';
import { OpenAIResponse, OpenAITokenCountingResponse, OpenAIModelsResponse, OpenAITextPart, OpenAIThinkingPart } from '../types/openai.js';
import { countClaudeRequestTokens, getTiktokenTokenizer, TokenCountingOptions } from '../utils/token-counting.js';

/**
 * Anthropic's API spec marks `signature` as REQUIRED on thinking content
 * blocks (clients like @ai-sdk/anthropic reject otherwise-valid responses
 * with a TypeValidationError when the field is missing). Most non-Anthropic
 * upstreams (DeepSeek, bigmodel.cn's glm-5.2, etc.) don't emit a signature,
 * so we synthesize a stable placeholder. The signature is only functionally
 * load-bearing for Anthropic's own reasoning round-trip verification, which
 * does not apply to translated upstreams — convertClaudeToOpenAIRequest
 * round-trips thinking via `reasoning_content`, not via signature.
 */
export const SYNTHETIC_THINKING_SIGNATURE = "synthetic";

export interface TokenCountingConfig {
    enabled: boolean;
    modelName: string;
}

/**
 * Convert OpenAI finish reason to Claude stop reason
 */
function convertFinishReasonToStopReason(finishReason: string | null): string | null {
    if (!finishReason) return null;

    const stopReasonMap: Record<string, string> = {
        stop: "end_turn",
        length: "max_tokens",
        tool_calls: "tool_use",
        "stop_sequence": "end_turn",
        "content_filter": "content_filter",
    };

    return stopReasonMap[finishReason] || "end_turn";
}

/**
 * Extract token counts from various response formats
 * Handles standard OpenAI format and non-standard formats like QNAIGC
 * Uses local token counting as fallback when LOCAL_TIKTOKEN is enabled
 */
export async function extractTokenCounts(
    usage: Record<string, any> | undefined,
    requestBody?: Record<string, any>,
    config?: TokenCountingConfig
): Promise<{
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
}> {
    if (!usage) {
        return { input_tokens: 0, output_tokens: 0 };
    }

    // Standard OpenAI format: prompt_tokens, completion_tokens
    // QNAIGC non-standard format: input, output
    const inputTokens = usage.prompt_tokens ?? usage.input;
    const outputTokens = usage.completion_tokens ?? usage.output;
    const cacheReadTokens = usage.prompt_cache_hit_tokens
        ?? usage.prompt_tokens_details?.cached_tokens
        ?? usage.input_tokens_details?.cached_tokens;
    const cacheCreationTokens = usage.prompt_cache_miss_tokens;

    // If local token counting is enabled and upstream returned 0 or undefined, use local counting
    if (config?.enabled && (inputTokens === undefined || inputTokens === 0 || outputTokens === undefined || outputTokens === 0)) {
        return {
            input_tokens: await calculateLocalTokens(requestBody, config, 'input'),
            output_tokens: await calculateLocalTokens(requestBody, config, 'output'),
            cache_creation_input_tokens: cacheCreationTokens,
            cache_read_input_tokens: cacheReadTokens,
        };
    }

    return {
        input_tokens: inputTokens ?? 0,
        output_tokens: outputTokens ?? 0,
        cache_creation_input_tokens: cacheCreationTokens,
        cache_read_input_tokens: cacheReadTokens,
    };
}

/**
 * Calculate local token count for input or output
 */
async function calculateLocalTokens(
    requestBody: Record<string, any> | undefined,
    config: TokenCountingConfig,
    type: 'input' | 'output'
): Promise<number> {
    if (type === 'input') {
        // Count input tokens from request body
        if (!requestBody || !requestBody.messages) return 0;
        try {
            const tokenizer = await getTiktokenTokenizer(config.modelName);
            const options: TokenCountingOptions = {
                useLocalCounting: true,
                tokenizer,
            };
            return countClaudeRequestTokens(requestBody as any, options);
        } catch (e) {
            return 0;
        }
    }
    // For output tokens, we can only estimate or use upstream value
    // Return 0 as fallback since we can't predict completion size
    return 0;
}

/**
 * Convert OpenAI model response to Claude format
 */
export async function convertOpenAIToClaudeResponse(
    openaiResponse: OpenAIResponse,
    model: string,
    requestId: string,
    requestBody?: Record<string, any>,
    config?: TokenCountingConfig
): Promise<ClaudeMessagesResponse> {
    // Handle empty choices array gracefully
    if (!openaiResponse.choices || !Array.isArray(openaiResponse.choices) || openaiResponse.choices.length === 0) {
        // Return a valid Claude response with empty content
        return {
            id: openaiResponse.id || requestId,
            type: "message",
            role: "assistant",
            model: model,
            content: [],
            stop_reason: null,
            usage: await extractTokenCounts(openaiResponse.usage, requestBody, config),
        };
    }

    // Get the first choice (OpenAI typically returns one choice unless n > 1)
    const choice = openaiResponse.choices[0];
    const message = choice.message;
    const content = message.content;
    const contentBlocks: ClaudeContentBlock[] = [];

    // Handle reasoning_content from thinking-mode upstreams (e.g. DeepSeek).
    // Must be emitted as a thinking block BEFORE the text block so the round-trip
    // preserves it: convertClaudeToOpenAIRequest reads `block.type === 'thinking'`
    // and emits `reasoning_content` on the next request, which DeepSeek requires.
    const inlineReasoning = (message as unknown as Record<string, unknown>).reasoning_content;
    if (inlineReasoning && typeof inlineReasoning === 'string') {
        contentBlocks.push({ type: 'thinking', thinking: inlineReasoning, signature: SYNTHETIC_THINKING_SIGNATURE } as unknown as ClaudeContentBlock);
    }

    // Handle text content
    if (content) {
        let textContent: string;
        let thinkingContent = '';
        let thinkingSignature: string | undefined = undefined;

        if (typeof content === 'string') {
            textContent = content;

            // Extract <thinking>...</thinking> and <think>...</think> markers from text content
            const thinkingRegex = /<(?:thinking|think)>([\s\S]*?)<\/(?:thinking|think)>/g;
            let match;
            let hasThinkingContent = false;

            while ((match = thinkingRegex.exec(textContent)) !== null) {
                thinkingContent += match[1];
                hasThinkingContent = true;
            }

            // If thinking content found, strip markers from text
            if (hasThinkingContent) {
                const cleanedText = textContent.replace(/<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>/g, '').trim();
                if (cleanedText) {
                    contentBlocks.push({
                        type: 'text',
                        text: cleanedText
                    });
                }
            } else {
                // No thinking markers found, add as regular text
                contentBlocks.push({
                    type: 'text',
                    text: textContent
                });
            }
        } else if (Array.isArray(content)) {
            // Extract text and thinking from content parts
            const textParts: string[] = [];

            for (const part of content) {
                if (part.type === 'text') {
                    textParts.push((part as OpenAITextPart).text);
                } else if (part.type === 'thinking') {
                    const thinkingPart = part as OpenAIThinkingPart;
                    thinkingContent += thinkingPart.thinking;
                    // Extract signature from thinking part if available
                    if (thinkingPart.signature) {
                        thinkingSignature = thinkingPart.signature;
                    }
                }
                // Handle other part types as needed
            }

            textContent = textParts.join('');
            if (textContent) {
                contentBlocks.push({
                    type: 'text',
                    text: textContent
                });
            }
        } else {
            textContent = String(content);
            contentBlocks.push({
                type: 'text',
                text: textContent
            });
        }

        // Add thinking block if we have thinking content
        if (thinkingContent) {
            const thinkingBlock: any = {
                type: 'thinking',
                thinking: thinkingContent
            };

            // Add signature if available
            if (thinkingSignature) {
                thinkingBlock.signature = thinkingSignature;
            }

            // Also check for reasoning_item_id or other signature fields in the response
            if (!thinkingSignature) {
                // Check for reasoning_item_id or other signature fields
                const reasoningItemId = (openaiResponse as any).reasoning_item_id;
                const responseSignature = (openaiResponse as any).signature;

                if (reasoningItemId) {
                    thinkingBlock.signature = reasoningItemId;
                } else if (responseSignature) {
                    thinkingBlock.signature = responseSignature;
                }
            }

            // Anthropic API spec requires `signature` on thinking blocks.
            // Synthesize a placeholder when the upstream provided none.
            if (!thinkingBlock.signature) {
                thinkingBlock.signature = SYNTHETIC_THINKING_SIGNATURE;
            }

            contentBlocks.push(thinkingBlock);
        }
    }

    // Handle tool calls
    if (message?.tool_calls) {
        message.tool_calls.forEach(call => {
            contentBlocks.push({
                type: 'tool_use',
                id: call.id,
                name: call.function.name,
                input: JSON.parse(call.function.arguments),
            });
        });
    }

    // Determine stop_reason, handling empty finish_reason from providers like QNAIGC
    let stopReason = convertFinishReasonToStopReason(choice.finish_reason);

    // If stop_reason is null/empty or "end_turn" but we have tool calls, use "tool_use"
    // This handles providers that return empty or incorrect finish_reason
    if ((!stopReason || stopReason === "end_turn") && message?.tool_calls && message.tool_calls.length > 0) {
        stopReason = "tool_use";
    }

    const response: ClaudeMessagesResponse = {
        id: openaiResponse.id || requestId,
        type: "message",
        role: "assistant",
        model: model,
        content: contentBlocks,
        stop_reason: stopReason,
        usage: await extractTokenCounts(openaiResponse.usage, requestBody, config),
    };

    return response;
}

/**
 * Convert OpenAI token counting response to Claude format
 */
export function convertOpenAITokenCountingToClaude(
    openaiResponse: OpenAITokenCountingResponse
): ClaudeTokenCountingResponse {
    return {
        type: "token_count",
        input_tokens: openaiResponse.prompt_tokens,
    };
}

const DEFAULT_CONTEXT_LENGTH = 262144;
const DEFAULT_MAX_TOKENS = 65536;

/**
 * Merge extra model IDs into OpenAI models response
 */
export function mergeOpenAIModelsResponse(
    openaiResponse: OpenAIModelsResponse,
    extraModelIds: string[] = []
): OpenAIModelsResponse {
    const modelsMap = new Map(openaiResponse.data.map((model) => [model.id, model] as const));
    const now = Math.floor(Date.now() / 1000);

    for (const modelId of extraModelIds) {
        if (!modelsMap.has(modelId)) {
            modelsMap.set(modelId, {
                id: modelId,
                object: "model",
                created: now,
                owned_by: "system",
                context_length: DEFAULT_CONTEXT_LENGTH,
                max_tokens: DEFAULT_MAX_TOKENS,
            });
        }
    }

    return {
        object: "list",
        data: [...modelsMap.values()],
    };
}
