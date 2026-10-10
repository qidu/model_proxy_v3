/**
 * Gemini Streaming Response Converter
 * Converts Gemini SSE streaming format to Claude SSE streaming format
 */

import { GeminiSSEEvent, GeminiContent } from '../types/gemini.js';
import { stringify } from '../utils/stringify.js';

type ClaudeUsage = {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
};

function toNumber(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
}

function convertGeminiUsageToClaudeUsage(usage: Record<string, unknown> | undefined): ClaudeUsage | undefined {
    if (!usage) return undefined;

    const inputTokens = toNumber(usage.total_input_tokens) ?? toNumber(usage.promptTokenCount);
    const outputTokens = toNumber(usage.total_output_tokens) ?? toNumber(usage.candidatesTokenCount);
    const cachedTokens = toNumber(usage.total_cached_tokens) ?? toNumber(usage.cachedContentTokenCount);

    if (inputTokens === undefined && outputTokens === undefined && cachedTokens === undefined) {
        return undefined;
    }

    const claudeUsage: ClaudeUsage = {
        input_tokens: inputTokens ?? 0,
        output_tokens: outputTokens ?? 0,
    };
    if (cachedTokens !== undefined) {
        claudeUsage.cache_read_input_tokens = cachedTokens;
    }
    return claudeUsage;
}

/**
 * State for streaming conversion
 */
interface StreamingState {
    currentId: string;
    currentRole: string;
    contentIndex: number;
    accumulatedText: string;
    hasStarted: boolean;
    hasEnded: boolean;
}

/**
 * Create a pass-through transform stream for native Gemini SSE format
 */
export function createNativeGeminiStreamTransformer(
    model: string,
    requestId: string
): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    
    return new TransformStream({
        transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
            // Decode chunk and add to buffer
            buffer += decoder.decode(chunk, { stream: true });
            
            // Split by double newline (SSE message boundary)
            const messages = buffer.split('\n\n');
            
            // Keep last incomplete message in buffer
            buffer = messages.pop() || '';
            
            // Enqueue complete messages
            for (const message of messages) {
                if (message.trim()) {
                    controller.enqueue(encoder.encode(message + '\n\n'));
                }
            }
        },
        
        flush(controller: TransformStreamDefaultController<Uint8Array>) {
            // Flush remaining buffer
            if (buffer.trim()) {
                controller.enqueue(encoder.encode(buffer + '\n\n'));
            }
        }
    });
}

/**
 * Create a transform stream for converting Gemini SSE to Claude SSE format
 */
export function createGeminiStreamTransformer(
    model: string,
    requestId: string
): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    const state: StreamingState = {
        currentId: requestId || `msg_${Date.now()}`,
        currentRole: 'model',
        contentIndex: 0,
        accumulatedText: '',
        hasStarted: false,
        hasEnded: false,
    };

    const parseMessage = (message: string, controller: TransformStreamDefaultController<Uint8Array>) => {
        const stringController = {
            enqueue: (value: string) => controller.enqueue(encoder.encode(value)),
        } as TransformStreamDefaultController<string>;

        for (const line of message.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = line.substring(6).trim();
            if (!data || data === '[DONE]') continue;
            try {
                const parsed = JSON.parse(data);
                if (parsed.event_type) {
                    handleGeminiEvent(parsed, stringController, model, requestId, state);
                } else {
                    handleNativeGeminiChunk(parsed, stringController, model, requestId, state);
                }
            } catch {
                continue;
            }
        }
    };

    return new TransformStream({
        transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
            buffer += decoder.decode(chunk, { stream: true });
            const messages = buffer.split('\n\n');
            buffer = messages.pop() || '';
            for (const message of messages) {
                if (message.trim()) {
                    parseMessage(message, controller);
                }
            }
        },

        flush(controller: TransformStreamDefaultController<Uint8Array>) {
            if (buffer.trim()) {
                parseMessage(buffer, controller);
            }
        }
    });
}

/**
 * Handle Gemini SSE event
 */
function sendClaudeEvent(controller: TransformStreamDefaultController<string>, event: string, data: object) {
    controller.enqueue(`event: ${event}\ndata: ${stringify(data)}\n\n`);
}

function ensureMessageStarted(
    controller: TransformStreamDefaultController<string>,
    model: string,
    requestId: string,
    state: StreamingState
) {
    if (state.hasStarted) return;
    const messageStart = {
        type: 'message_start',
        message: {
            id: state.currentId || requestId || `msg_${Date.now()}`,
            type: 'message',
            role: 'assistant',
            model,
            content: [] as any[],
            stop_reason: null,
            usage: { input_tokens: 0, output_tokens: 0 },
        },
    };
    sendClaudeEvent(controller, 'message_start', messageStart);
    state.hasStarted = true;
}

function handleNativeGeminiChunk(
    chunk: Record<string, unknown>,
    controller: TransformStreamDefaultController<string>,
    model: string,
    requestId: string,
    state: StreamingState
) {
    ensureMessageStarted(controller, model, requestId, state);

    const candidates = chunk.candidates as Array<Record<string, any>> | undefined;
    const candidate = candidates?.[0];
    const parts = candidate?.content?.parts as Array<Record<string, unknown>> | undefined;
    if (parts?.length) {
        if (state.contentIndex === 0 && !state.accumulatedText) {
            sendClaudeEvent(controller, 'content_block_start', {
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' },
            });
        }
        for (const part of parts) {
            if (typeof part.text === 'string' && part.text) {
                state.accumulatedText += part.text;
                sendClaudeEvent(controller, 'content_block_delta', {
                    type: 'content_block_delta',
                    index: 0,
                    delta: { type: 'text_delta', text: part.text },
                });
            }
        }
    }

    const usage = convertGeminiUsageToClaudeUsage(chunk.usageMetadata as Record<string, unknown> | undefined);
    if (candidate?.finishReason || usage) {
        sendClaudeEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: 0 });
        sendClaudeEvent(controller, 'message_delta', {
            type: 'message_delta',
            delta: { stop_reason: candidate?.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn' },
            ...(usage ? { usage } : {}),
        });
        sendClaudeEvent(controller, 'message_stop', { type: 'message_stop' });
        state.hasEnded = true;
    }
}

function handleGeminiEvent(
    event: GeminiSSEEvent,
    controller: TransformStreamDefaultController<string>,
    model: string,
    requestId: string,
    state: StreamingState
) {
    switch (event.event_type) {
        case 'interaction.start':
            // Handle interaction start
            if (event.interaction) {
                state.currentId = event.interaction.id;
                state.currentRole = event.interaction.role || 'model';
                // Send message start
                const messageStart = {
                    type: 'message_start',
                    message: {
                        id: event.interaction.id,
                        type: 'message',
                        role: 'assistant',
                        model: model,
                        content: [] as any[],
                        stop_reason: null,
                        usage: { input_tokens: 0, output_tokens: 0 },
                    },
                };
                controller.enqueue(`event: message_start\ndata: ${stringify(messageStart)}\n\n`);
                state.hasStarted = true;
            }
            break;

        case 'content.start':
            // Handle new content block start
            if (event.content) {
                state.contentIndex = event.index || 0;
                const contentStart = {
                    type: 'content_block_start',
                    index: event.index || 0,
                    content_block: { type: mapGeminiContentTypeToClaude(event.content.type) },
                };
                controller.enqueue(`event: content_block_start\ndata: ${stringify(contentStart)}\n\n`);
            }
            break;

        case 'content.delta':
            // Handle content delta (text chunks, tool calls, etc.)
            if (event.delta) {
                const delta = event.delta as any;
                if (delta.type === 'text' && delta.text) {
                    state.accumulatedText += delta.text;
                    const deltaEvent = {
                        type: 'content_block_delta',
                        index: event.index || 0,
                        delta: { type: 'text_delta', text: delta.text },
                    };
                    controller.enqueue(`event: content_block_delta\ndata: ${stringify(deltaEvent)}\n\n`);
                } else if (delta.type === 'function_call') {
                    const toolUseEvent = {
                        type: 'content_block_delta',
                        index: event.index || 0,
                        delta: {
                            type: 'tool_use',
                            id: delta.id || `tool-${Date.now()}`,
                            name: delta.name,
                            input: delta.arguments || {},
                        },
                    };
                    controller.enqueue(`event: content_block_delta\ndata: ${stringify(toolUseEvent)}\n\n`);
                } else if (delta.type === 'function_result') {
                    const toolResultEvent = {
                        type: 'content_block_delta',
                        index: event.index || 0,
                        delta: {
                            type: 'tool_result',
                            tool_use_id: delta.call_id,
                            content: delta.result,
                            is_error: delta.is_error,
                        },
                    };
                    controller.enqueue(`event: content_block_delta\ndata: ${stringify(toolResultEvent)}\n\n`);
                } else {
                    // Generic delta
                    const genericEvent = {
                        type: 'content_block_delta',
                        index: event.index || 0,
                        delta,
                    };
                    controller.enqueue(`event: content_block_delta\ndata: ${stringify(genericEvent)}\n\n`);
                }
            }
            break;

        case 'content.stop':
            // Handle content block stop
            controller.enqueue(`event: content_block_stop\ndata: {"type":"content_block_stop","index":${event.index || 0}}\n\n`);
            break;

        case 'interaction.complete':
            // Handle interaction complete
            state.hasEnded = true;
            // Send message delta with stop reason and final usage when available
            const usage = convertGeminiUsageToClaudeUsage(
                (event.interaction?.usage as unknown as Record<string, unknown> | undefined) ??
                ((event as unknown as Record<string, unknown>).usageMetadata as Record<string, unknown> | undefined)
            );
            const messageDelta = {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                ...(usage ? { usage } : {}),
            };
            controller.enqueue(`event: message_delta\ndata: ${stringify(messageDelta)}\n\n`);
            // Send message stop
            controller.enqueue(`event: message_stop\ndata: {"type":"message_stop","index":0}\n\n`);
            break;

        case 'interaction.status_update':
            // Handle status update
            if (event.status === 'failed') {
                const errorDelta = {
                    type: 'message_delta',
                    delta: { stop_reason: 'max_tokens' },
                };
                controller.enqueue(`event: message_delta\ndata: ${stringify(errorDelta)}\n\n`);
            }
            break;

        case 'error':
            // Handle error
            const errorEvent = {
                type: 'error',
                error: {
                    type: event.error?.code || 'internal_error',
                    message: event.error?.message || 'Unknown error occurred',
                },
            };
            controller.enqueue(`event: error\ndata: ${stringify(errorEvent)}\n\n`);
            break;
    }
}

/**
 * Map Gemini content type to Claude content block type
 */
function mapGeminiContentTypeToClaude(geminiType: string): string {
    switch (geminiType) {
        case 'text':
            return 'text';
        case 'function_call':
            return 'tool_use';
        case 'image':
            return 'image';
        default:
            return 'text';
    }
}