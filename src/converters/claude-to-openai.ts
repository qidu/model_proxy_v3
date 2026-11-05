/**
 * Converter from Claude API format to OpenAI API format
 */

import { ClaudeMessagesRequest, ClaudeTokenCountingRequest, ClaudeContent, ClaudeContentBlock, ClaudeTool, ThinkingConfigParam } from '../types/claude.js';
import { OpenAIRequest, OpenAITokenCountingRequest, OpenAIMessage, OpenAIToolCall } from '../types/openai.js';
import { stringify } from '../utils/stringify.js';
import { isBlobRef } from '../utils/blob-refs.js';

/**
 * Recursively cleans a JSON Schema to make it compatible with target APIs like Google Gemini.
 * - Removes '$schema' and 'additionalProperties' keys.
 * - For properties of type 'string', removes the 'format' field unless it's 'date-time' or 'enum'.
 */
export function recursivelyCleanSchema(schema: any): any {
    if (schema === null || typeof schema !== 'object') {
        return schema;
    }

    if (Array.isArray(schema)) {
        return schema.map(item => recursivelyCleanSchema(item));
    }

    const newSchema: { [key: string]: any } = {};
    for (const key in schema) {
        if (Object.prototype.hasOwnProperty.call(schema, key)) {
            if (key === '$schema' || key === 'additionalProperties') {
                continue;
            }
            newSchema[key] = recursivelyCleanSchema(schema[key]);
        }
    }

    if (newSchema.type === 'string' && newSchema.format) {
        const supportedFormats = ['date-time', 'enum'];
        if (!supportedFormats.includes(newSchema.format)) {
            delete newSchema.format;
        }
    }

    return newSchema;
}

/**
 * Convert Claude content blocks to OpenAI format
 */
function convertClaudeContentToOpenAI(content: ClaudeContent): OpenAIMessage['content'] {
    if (typeof content === 'string') {
        return content;
    }

    const contentArray = content.map(block => {
        if (block.type === 'text') {
            return { type: 'text' as const, text: block.text };
        } else if (block.type === 'image') {
            const prefix = `data:${block.source.media_type};base64,`;
            const data: unknown = block.source.data;
            return {
                type: 'image_url' as const,
                image_url: {
                    // §5.3 shape 3: a spooled payload stays a ref, re-prefixed with the
                    // data URL this line used to build, so it streams in chunks at the
                    // converted position and rehydrates to exactly the string the
                    // interpolation produced.
                    url: isBlobRef(data) ? { ...data, prefix } : `${prefix}${data}`
                }
            };
        }
        // Skip document, tool_use, tool_result blocks (handled separately)
        return null;
    }).filter(Boolean) as any[];

    return contentArray.length > 0 ? contentArray : '';
}

/**
 * Convert Claude tool definitions to OpenAI format
 */
function convertClaudeToolsToOpenAI(tools: ClaudeTool[] | undefined): OpenAIRequest['tools'] {
    if (!tools || tools.length === 0) {
        return undefined;
    }

    return tools.map(tool => ({
        type: "function" as const,
        function: {
            name: tool.name,
            description: tool.description || '',
            parameters: recursivelyCleanSchema(tool.input_schema),
        },
    }));
}

/**
 * Convert Claude tool_choice to OpenAI format
 */
function convertClaudeToolChoiceToOpenAI(toolChoice: ClaudeMessagesRequest['tool_choice']): OpenAIRequest['tool_choice'] {
    if (!toolChoice) {
        return undefined;
    }

    if (toolChoice.type === 'auto' || toolChoice.type === 'any') {
        return 'auto';
    } else if (toolChoice.type === 'tool') {
        return {
            type: 'function',
            function: { name: toolChoice.name! }
        };
    } else if (toolChoice.type === 'none') {
        return 'none';
    }

    return undefined;
}

/**
 * Normalize effort value, mapping non-standard values like "xhigh" to valid ones
 */
function normalizeEffort(effort: string | undefined): "low" | "medium" | "high" | "max" | undefined {
    if (!effort) return undefined;
    switch (effort) {
        case "low": return "low";
        case "medium": return "medium";
        case "high": return "high";
        case "max": return "max";
        case "xhigh": return "max";
        default: return undefined;
    }
}

/**
 * Convert Claude thinking config to OpenAI format
 * Can optionally convert to reasoning_effort based on budget thresholds
 */
export interface ThinkingConversionOptions {
    budget_to_effort_low?: number;
    budget_to_effort_medium?: number;
    budget_to_effort_high?: number;
    explicit_reasoning_effort?: "low" | "medium" | "high" | "max";
    task_budget_total?: number;
}

export function convertClaudeThinkingToOpenAI(
    thinking: ThinkingConfigParam | undefined,
    options?: ThinkingConversionOptions
): { thinking?: OpenAIRequest['thinking']; reasoning_effort?: "low" | "medium" | "high" | "max" } {
    if (!thinking) {
        return {};
    }

    if (thinking.type === false || thinking.type === 'disabled') {
        return { thinking: { enabled: false } };
    }

    if (thinking.type === true || thinking.type === 'enabled' || thinking.type === 'adaptive') {
        const convertedThinking: OpenAIRequest['thinking'] = { enabled: true };
        if (thinking.budget_tokens !== undefined) {
            convertedThinking.budget_tokens = thinking.budget_tokens;
        } else if (options?.task_budget_total !== undefined) {
            convertedThinking.budget_tokens = options.task_budget_total;
        }

        // Use explicit reasoning_effort from request body if provided
        if (options?.explicit_reasoning_effort) {
            return { thinking: convertedThinking, reasoning_effort: options.explicit_reasoning_effort };
        }

        const hasThresholds = options &&
            (options.budget_to_effort_low !== undefined ||
             options.budget_to_effort_medium !== undefined ||
             options.budget_to_effort_high !== undefined);

        if (!hasThresholds || convertedThinking.budget_tokens === undefined) {
            return { thinking: convertedThinking };
        }

        const budget = convertedThinking.budget_tokens;
        const effort = budgetToReasoningEffort(budget, options);

        return { thinking: convertedThinking, reasoning_effort: effort };
    }

    return {};
}

/**
 * Map a thinking budget_tokens value to a reasoning_effort enum using the
 * configured thresholds in ThinkingConversionOptions.
 *
 * Threshold semantics (matching convertClaudeThinkingToOpenAI):
 * - budget_to_effort_high === 0 → always "high" (special-case "force high")
 * - budget >= budget_to_effort_high → "high"
 * - budget >= budget_to_effort_medium → "medium"
 * - otherwise → "low"
 *
 * When no thresholds are configured (options undefined or all undefined),
 * falls back to legacy cutoffs 4096/2048 so behavior is unchanged for
 * callers that previously used the inline hardcoded ternary.
 */
export function budgetToReasoningEffort(
    budget: number,
    options?: ThinkingConversionOptions
): "low" | "medium" | "high" | "max" {
    const highThreshold = options?.budget_to_effort_high;
    const mediumThreshold = options?.budget_to_effort_medium;
    const hasThresholds =
        options !== undefined &&
        (options.budget_to_effort_low !== undefined ||
         options.budget_to_effort_medium !== undefined ||
         options.budget_to_effort_high !== undefined);

    if (!hasThresholds) {
        // Legacy fallback used by the openai-passthrough and SDK paths.
        return budget >= 4096 ? 'high' : budget >= 2048 ? 'medium' : 'low';
    }

    if (highThreshold !== undefined && (budget >= highThreshold || highThreshold === 0)) {
        return "high";
    }
    if (mediumThreshold !== undefined && (budget >= mediumThreshold || mediumThreshold === 0)) {
        return "medium";
    }
    return "low";
}

/**
 * Extract tool results from Claude content array
 */
function extractToolResultsFromClaudeContent(content: ClaudeContentBlock[]): Array<{ tool_use_id: string; content: string }> {
    return content
        .filter(block => block.type === 'tool_result')
        .map(block => ({
            tool_use_id: block.tool_use_id,
            content: typeof block.content === 'string' ? block.content : stringify(block.content)
        }));
}

/**
 * Extract non-tool content from Claude content array
 */
function extractNonToolContentFromClaudeContent(content: ClaudeContentBlock[]): ClaudeContentBlock[] {
    return content.filter(block => block.type !== 'tool_result');
}

/**
 * Convert Claude token counting request to OpenAI format
 */
export function convertClaudeTokenCountingToOpenAI(
    claudeRequest: ClaudeTokenCountingRequest,
    modelName: string,
    requestId?: string,
    conversionOptions?: ThinkingConversionOptions
): OpenAITokenCountingRequest {
    const openaiMessages: OpenAIMessage[] = [];

    // Handle system message - must be first in OpenAI format
    if (claudeRequest.system) {
        const systemContent = typeof claudeRequest.system === 'string'
            ? claudeRequest.system
            : claudeRequest.system.map(block => block.text).join('\n');
        openaiMessages.push({ role: "system", content: systemContent });
    }

    // Process each message
    for (const message of claudeRequest.messages) {
        if (message.role === 'user') {
            if (Array.isArray(message.content)) {
                const toolResults = extractToolResultsFromClaudeContent(message.content);
                const otherContent = extractNonToolContentFromClaudeContent(message.content);

                // Add tool results as tool messages first
                toolResults.forEach(toolResult => {
                    openaiMessages.push({
                        role: 'tool',
                        tool_call_id: toolResult.tool_use_id,
                        content: toolResult.content,
                    });
                });

                // Add other content as user message
                if (otherContent.length > 0) {
                    const contentArray = convertClaudeContentToOpenAI(otherContent);
                    if (contentArray !== '') {
                        openaiMessages.push({
                            role: "user",
                            content: contentArray
                        });
                    }
                }
            } else {
                // Simple string content
                openaiMessages.push({ role: "user", content: message.content });
            }
        } else if (message.role === 'assistant') {
            const textParts: string[] = [];
            const toolCalls: OpenAIToolCall[] = [];
            const thinkingParts: string[] = [];

            if (Array.isArray(message.content)) {
                message.content.forEach(block => {
                    if (block.type === 'text') {
                        textParts.push(block.text);
                    } else if (block.type === 'tool_use') {
                        toolCalls.push({
                            id: block.id,
                            type: 'function',
                            function: {
                                name: block.name,
                                arguments: stringify(block.input || {})
                            },
                        });
                    } else if (block.type === 'thinking') {
                        // Preserve reasoning so thinking-mode upstreams (e.g. DeepSeek)
                        // don't reject the next turn with "reasoning_content must be
                        // passed back".
                        thinkingParts.push(block.thinking ?? '');
                    }
                });
            }

            // OpenAI requires content to be non-null for assistant messages with tool calls
            const assistantMessage: OpenAIMessage = {
                role: 'assistant',
                content: textParts.length > 0 ? textParts.join('\n') : ''
            };

            if (toolCalls.length > 0) {
                assistantMessage.tool_calls = toolCalls;
            }

            if (thinkingParts.length > 0) {
                (assistantMessage as unknown as Record<string, unknown>).reasoning_content =
                    thinkingParts.join('\n');
            }

            openaiMessages.push(assistantMessage);
        }
    }

    // Build OpenAI token counting request with max_tokens=1
    // to minimize costs — we only need the usage data
    const openaiRequest: OpenAITokenCountingRequest = {
        model: modelName,
        messages: openaiMessages,
        max_tokens: 1,
    };

    // Handle tools
    const convertedTools = convertClaudeToolsToOpenAI(claudeRequest.tools);
    if (convertedTools) {
        openaiRequest.tools = convertedTools;
    }

    // Handle thinking
    const convertedThinking = convertClaudeThinkingToOpenAI(claudeRequest.thinking, conversionOptions);
    if (convertedThinking.thinking) {
        openaiRequest.thinking = convertedThinking.thinking;
    }
    if (convertedThinking.reasoning_effort) {
        openaiRequest.reasoning_effort = convertedThinking.reasoning_effort;
    }

    return openaiRequest;
}

/**
 * Main converter: Claude Messages Request → OpenAI Request
 */
export function convertClaudeToOpenAIRequest(
    claudeRequest: ClaudeMessagesRequest,
    modelName: string,
    conversionOptions?: ThinkingConversionOptions
): OpenAIRequest {
    const openaiMessages: OpenAIMessage[] = [];

    // Handle system message - must be first in OpenAI format
    if (claudeRequest.system) {
        const systemContent = typeof claudeRequest.system === 'string' 
            ? claudeRequest.system 
            : claudeRequest.system.map(block => block.text).join('\n');
        openaiMessages.push({ role: "system", content: systemContent });
    }

    // Process each message
    for (const message of claudeRequest.messages) {
        if (message.role === 'user') {
            if (Array.isArray(message.content)) {
                const toolResults = extractToolResultsFromClaudeContent(message.content);
                const otherContent = extractNonToolContentFromClaudeContent(message.content);

                // Add tool results as tool messages first
                toolResults.forEach(toolResult => {
                    openaiMessages.push({
                        role: 'tool',
                        tool_call_id: toolResult.tool_use_id,
                        content: toolResult.content,
                    });
                });

                // Add other content as user message
                if (otherContent.length > 0) {
                    const contentArray = convertClaudeContentToOpenAI(otherContent);
                    if (contentArray !== '') {
                        openaiMessages.push({
                            role: "user",
                            content: contentArray
                        });
                    }
                }
            } else {
                // Simple string content
                openaiMessages.push({ role: "user", content: message.content });
            }
        } else if (message.role === 'assistant') {
            const textParts: string[] = [];
            const toolCalls: OpenAIToolCall[] = [];
            const thinkingParts: string[] = [];

            if (Array.isArray(message.content)) {
                message.content.forEach(block => {
                    if (block.type === 'text') {
                        textParts.push(block.text);
                    } else if (block.type === 'tool_use') {
                        toolCalls.push({
                            id: block.id,
                            type: 'function',
                            function: {
                                name: block.name,
                                arguments: stringify(block.input || {})
                            },
                        });
                    } else if (block.type === 'thinking') {
                        // Preserve reasoning so thinking-mode upstreams (e.g. DeepSeek)
                        // don't reject the next turn with "reasoning_content must be
                        // passed back".
                        thinkingParts.push(block.thinking ?? '');
                    }
                });
            }

            // OpenAI requires content to be non-null for assistant messages with tool calls
            const assistantMessage: OpenAIMessage = {
                role: 'assistant',
                content: textParts.length > 0 ? textParts.join('\n') : ''
            };

            if (toolCalls.length > 0) {
                assistantMessage.tool_calls = toolCalls;
            }

            if (thinkingParts.length > 0) {
                (assistantMessage as unknown as Record<string, unknown>).reasoning_content =
                    thinkingParts.join('\n');
            }

            openaiMessages.push(assistantMessage);
        }
    }

    // Build OpenAI request
    const openaiRequest: OpenAIRequest = {
        model: modelName,
        messages: openaiMessages,
        max_tokens: claudeRequest.max_tokens,
        temperature: claudeRequest.temperature,
        top_p: claudeRequest.top_p,
        stream: claudeRequest.stream,
        stop: claudeRequest.stop_sequences,
    };

    // Ask upstream to include token usage in the final streaming chunk
    if (claudeRequest.stream) {
        openaiRequest.stream_options = { include_usage: true };
    }

    // Handle tools
    const convertedTools = convertClaudeToolsToOpenAI(claudeRequest.tools);
    if (convertedTools) {
        openaiRequest.tools = convertedTools;
    }

    // Handle tool_choice
    const convertedToolChoice = convertClaudeToolChoiceToOpenAI(claudeRequest.tool_choice);
    if (convertedToolChoice !== undefined) {
        openaiRequest.tool_choice = convertedToolChoice;
    } else if (convertedTools) {
        // If tools are present but tool_choice is not specified, default to "auto"
        openaiRequest.tool_choice = 'auto';
    }

    // Handle thinking
    const convertedThinking = convertClaudeThinkingToOpenAI(claudeRequest.thinking, {
        ...conversionOptions,
        explicit_reasoning_effort: conversionOptions?.explicit_reasoning_effort ??
            normalizeEffort(claudeRequest.reasoning_effort) ?? normalizeEffort(claudeRequest.output_config?.effort),
        task_budget_total: claudeRequest.output_config?.task_budget?.total,
    });
    if (convertedThinking.thinking) {
        openaiRequest.thinking = convertedThinking.thinking;
    }
    if (convertedThinking.reasoning_effort) {
        openaiRequest.reasoning_effort = convertedThinking.reasoning_effort;
    }

    return openaiRequest;
}
