/**
 * Gemini to Claude Response Converter
 * Converts Gemini Interactions API responses to Claude API format
 */

import { ClaudeMessagesResponse, ClaudeContentBlock, ClaudeTextBlock, ClaudeToolUseBlock, ClaudeToolResultBlock } from '../types/claude.js';
import { GeminiInteractionResponse, GeminiContent, GeminiUsage } from '../types/gemini.js';
import { stringify } from '../utils/stringify.js';
import { Logger } from '../utils/logger.js';

/**
 * Convert Gemini interaction response to Claude format
 */
export function convertGeminiToClaudeResponse(
    geminiResponse: GeminiInteractionResponse,
    model: string,
    requestId: string
): ClaudeMessagesResponse {
    const role = geminiResponse.role === 'model' ? 'assistant' : geminiResponse.role;

    return {
        id: geminiResponse.id,
        type: 'message',
        role: role,
        model: model,
        content: convertGeminiContentToClaude(geminiResponse.outputs),
        stop_reason: mapGeminiStatusToStopReason(geminiResponse.status),
        usage: convertGeminiUsageToClaude(geminiResponse.usage),
    };
}

/**
 * Convert Gemini content blocks to Claude format
 */
function convertGeminiContentToClaude(
    outputs?: GeminiContent[]
): ClaudeContentBlock[] {
    if (!outputs || outputs.length === 0) {
        return [];
    }

    const claudeBlocks: ClaudeContentBlock[] = [];

    for (const output of outputs) {
        switch (output.type) {
            case 'text':
                const textContent = output as any;
                const textBlock: ClaudeTextBlock = {
                    type: 'text',
                    text: textContent.text || '',
                };
                if (textContent.annotations && textContent.annotations.length > 0) {
                    textBlock.citations = textContent.annotations.map((ann: any) => ({
                        type: 'char_location' as const,
                        cited_text: '',
                        document_index: 0,
                        document_title: ann.source,
                        start_char_index: ann.start_index,
                        end_char_index: ann.end_index,
                    }));
                }
                claudeBlocks.push(textBlock);
                break;

            case 'image':
                const imageContent = output as any;
                claudeBlocks.push({
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: imageContent.mime_type || 'image/png',
                        data: imageContent.data,
                    },
                });
                break;

            case 'function_call':
                const callContent = output as any;
                const toolUseBlock: ClaudeToolUseBlock = {
                    type: 'tool_use',
                    id: callContent.id || `tool-${Date.now()}`,
                    name: callContent.name,
                    input: callContent.arguments || {},
                };
                claudeBlocks.push(toolUseBlock);
                break;

            case 'function_result':
                const resultContent = output as any;
                const toolResultBlock: ClaudeToolResultBlock = {
                    type: 'tool_result',
                    tool_use_id: resultContent.call_id || '',
                    content: resultContent.result as string,
                };
                if (resultContent.is_error) {
                    toolResultBlock.content = String(resultContent.result);
                }
                claudeBlocks.push(toolResultBlock);
                break;

            case 'thought':
                // Map thought to Claude thinking block
                const thoughtContent = output as any;
                claudeBlocks.push({
                    type: 'thinking',
                    thinking: thoughtContent.signature || thoughtContent.summary?.content?.text || '',
                    signature: thoughtContent.signature,
                });
                break;

            case 'code_execution_result':
                const codeResult = output as any;
                claudeBlocks.push({
                    type: 'text',
                    text: codeResult.result || '',
                });
                break;

            default:
                // Handle unknown types as text
                claudeBlocks.push({
                    type: 'text',
                    text: stringify(output),
                });
        }
    }

    return claudeBlocks;
}

/**
 * Convert Gemini usage stats to Claude format
 */
function convertGeminiUsageToClaude(usage?: GeminiUsage): {
    input_tokens: number;
    output_tokens: number;
} {
    if (!usage) {
        return { input_tokens: 0, output_tokens: 0 };
    }

    return {
        input_tokens: usage.total_input_tokens,
        output_tokens: usage.total_output_tokens,
    };
}

/**
 * Map Gemini interaction status to Claude stop reason
 */
function mapGeminiStatusToStopReason(
    status: string
): 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'timeout' | null {
    switch (status) {
        case 'completed':
            return 'end_turn';
        case 'in_progress':
            return null; // Still generating
        case 'requires_action':
            return 'tool_use'; // Tool call requested
        case 'failed':
            return null;
        case 'cancelled':
            return 'stop_sequence';
        default:
            return null;
    }
}

/**
 * Convert Gemini generateContent response to Claude format.
 *
 * `options.logger` is optional and carries warnings only: Rule #8 requires a
 * reply part this converter cannot project, and any `finishReason` it does not
 * map, to be reported rather than vanish into an answer that looks complete.
 */
export function convertGeminiGenerateContentToClaude(
    geminiResponse: Record<string, unknown>,
    model: string,
    requestId: string,
    options?: { logger?: Logger },
): ClaudeMessagesResponse {
    const candidates = geminiResponse.candidates as Array<Record<string, unknown>> | undefined;
    const usageMetadata = geminiResponse.usageMetadata as Record<string, number> | undefined;
    
    let content: ClaudeContentBlock[] = [];
    let stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'timeout' | null = null;
    let hasToolUse = false;

    if (candidates && candidates.length > 0) {
        const firstCandidate = candidates[0];
        const candidateContent = firstCandidate.content as Record<string, unknown> | undefined;
        const finishReason = firstCandidate.finishReason as string | undefined;

        if (candidateContent) {
            const parts = candidateContent.parts as Array<Record<string, unknown>> | undefined;
            if (parts && parts.length > 0) {
                const textParts: string[] = [];
                const toolUseBlocks: ClaudeToolUseBlock[] = [];
                // Rule #8: a part this converter cannot project must be counted by
                // kind and reported, not dropped into a shorter, clean-looking answer.
                const droppedKinds = new Map<string, number>();
                let thoughtParts = 0;
                for (const part of parts) {
                    const functionCall = part.functionCall as Record<string, unknown> | undefined;
                    if (functionCall) {
                        // Gemini's `FunctionCall.id` is optional: carry the
                        // upstream's own id when it has one so the client can
                        // echo it back in the matching tool_result, and mint one
                        // when the upstream omitted it.
                        toolUseBlocks.push({
                            type: 'tool_use',
                            id: typeof functionCall.id === 'string' && functionCall.id !== ''
                                ? functionCall.id
                                : `tool_${Date.now()}_${toolUseBlocks.length}`,
                            name: functionCall.name as string,
                            input: functionCall.args ?? {},
                        });
                    } else if (typeof part.text === 'string') {
                        // A thought part carries the same `text` field, so it lands
                        // here and is answered as ordinary text: this path has no
                        // thinking projection, which the warning below states.
                        if (part.thought === true) thoughtParts++;
                        textParts.push(part.text);
                    } else {
                        const kind = part.inline_data || part.inlineData ? 'inline_data'
                            : part.functionResponse ? 'functionResponse'
                            : part.executableCode ? 'executableCode'
                            : part.codeExecutionResult ? 'codeExecutionResult'
                            : part.file_data || part.fileData ? 'file_data'
                            : Object.keys(part).join('+') || '<empty>';
                        droppedKinds.set(kind, (droppedKinds.get(kind) ?? 0) + 1);
                    }
                }
                if (droppedKinds.size > 0) {
                    options?.logger?.warn(
                        requestId,
                        `[gemini->claude] dropped generateContent reply part(s) with no Claude Messages projection: ` +
                        [...droppedKinds].map(([kind, n]) => `${kind}×${n}`).join(', ')
                    );
                }
                if (thoughtParts > 0) {
                    options?.logger?.warn(
                        requestId,
                        `[gemini->claude] folded ${thoughtParts} thought part(s) into the answer text ` +
                        `(this path has no thinking/reasoning projection)`
                    );
                }
                const blocks: ClaudeContentBlock[] = [];
                if (textParts.length > 0) {
                    blocks.push({
                        type: 'text',
                        text: textParts.join('')
                    });
                }
                blocks.push(...toolUseBlocks);
                content = blocks;
                hasToolUse = toolUseBlocks.length > 0;
            }
        }

        // Map finish reason
        switch (finishReason) {
            case 'STOP':
                stopReason = 'end_turn';
                break;
            case 'MAX_TOKENS':
                stopReason = 'max_tokens';
                break;
            case 'SAFETY':
            case 'RECITATION':
                stopReason = 'stop_sequence';
                break;
            default:
                // Rule #8: an unmapped raw value must not read as a clean stop when
                // it reaches the client. `undefined`/`null`/`FINISH_REASON_UNSPECIFIED`
                // mean "no reason given", which is nothing to report.
                if (finishReason && finishReason !== 'FINISH_REASON_UNSPECIFIED') {
                    options?.logger?.warn(
                        requestId,
                        `[gemini->claude] unmapped Gemini finishReason ${JSON.stringify(finishReason)}; ` +
                        `stop_reason left null (an OpenAI client sees "stop")`
                    );
                }
        }

        // Gemini reports a tool call as finishReason STOP; the block itself
        // is what makes this turn a tool turn.
        if (hasToolUse) {
            stopReason = 'tool_use';
        }
    }
    
    return {
        id: `msg_${Date.now()}_${requestId.slice(-8)}`,
        type: 'message',
        role: 'assistant',
        model: model,
        content: content,
        stop_reason: stopReason,
        usage: {
            input_tokens: usageMetadata?.promptTokenCount || 0,
            output_tokens: usageMetadata?.candidatesTokenCount || 0,
            ...(usageMetadata?.cachedContentTokenCount ? { cache_read_input_tokens: usageMetadata.cachedContentTokenCount } : {}),
        },
    };
}