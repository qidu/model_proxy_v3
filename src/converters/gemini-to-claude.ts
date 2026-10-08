/**
 * Gemini to Claude Response Converter
 * Converts Gemini Interactions API responses to Claude API format
 */

import { ClaudeMessagesResponse, ClaudeContentBlock, ClaudeTextBlock, ClaudeToolUseBlock, ClaudeToolResultBlock } from '../types/claude.js';
import { GeminiInteractionResponse, GeminiContent, GeminiUsage } from '../types/gemini.js';
import { stringify } from '../utils/stringify.js';

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
 * Convert Gemini generateContent response to Claude format
 */
export function convertGeminiGenerateContentToClaude(
    geminiResponse: Record<string, unknown>,
    model: string,
    requestId: string
): ClaudeMessagesResponse {
    const candidates = geminiResponse.candidates as Array<Record<string, unknown>> | undefined;
    const usageMetadata = geminiResponse.usageMetadata as Record<string, number> | undefined;
    
    let content: ClaudeContentBlock[] = [];
    let stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop_sequence' | 'timeout' | null = null;
    
    if (candidates && candidates.length > 0) {
        const firstCandidate = candidates[0];
        const candidateContent = firstCandidate.content as Record<string, unknown> | undefined;
        const finishReason = firstCandidate.finishReason as string | undefined;
        
        if (candidateContent) {
            const parts = candidateContent.parts as Array<Record<string, unknown>> | undefined;
            if (parts && parts.length > 0) {
                const textParts: string[] = [];
                for (const part of parts) {
                    if (part.text) {
                        textParts.push(part.text as string);
                    }
                }
                if (textParts.length > 0) {
                    content = [{
                        type: 'text',
                        text: textParts.join('')
                    }];
                }
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