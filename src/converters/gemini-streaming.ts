/**
 * Gemini Streaming Response Converter
 * Converts Gemini SSE streaming format to Claude SSE streaming format
 */

import { GeminiSSEEvent, GeminiContent } from '../types/gemini.js';
import { stringify } from '../utils/stringify.js';
import type { Logger } from '../utils/logger.js';
import { convertGenerateContentToInteraction, blockedPromptReason } from './gemini-to-interactions.js';

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
    /** A text block is open at `contentIndex` and needs its content_block_stop. */
    textBlockOpen: boolean;
    /** At least one functionCall part was emitted — the turn stops for tool_use. */
    hasToolUse: boolean;
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
        textBlockOpen: false,
        hasToolUse: false,
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
        for (const part of parts) {
            const functionCall = part.functionCall as Record<string, unknown> | undefined;
            if (functionCall) {
                // A functionCall cannot share a block with text — close the
                // text block first, then emit a complete tool_use block of its own.
                if (state.textBlockOpen) {
                    sendClaudeEvent(controller, 'content_block_stop', {
                        type: 'content_block_stop',
                        index: state.contentIndex,
                    });
                    state.textBlockOpen = false;
                    state.contentIndex += 1;
                }
                const toolIndex = state.contentIndex;
                // Carry the upstream's own call id when it has one so the client
                // can echo it back in the matching tool_result; mint one when the
                // upstream omitted it (`FunctionCall.id` is optional).
                sendClaudeEvent(controller, 'content_block_start', {
                    type: 'content_block_start',
                    index: toolIndex,
                    content_block: {
                        type: 'tool_use',
                        id: typeof functionCall.id === 'string' && functionCall.id !== ''
                            ? functionCall.id
                            : `tool_${Date.now()}_${toolIndex}`,
                        name: functionCall.name,
                        input: {},
                    },
                });
                sendClaudeEvent(controller, 'content_block_delta', {
                    type: 'content_block_delta',
                    index: toolIndex,
                    delta: { type: 'input_json_delta', partial_json: stringify(functionCall.args ?? {}) },
                });
                sendClaudeEvent(controller, 'content_block_stop', {
                    type: 'content_block_stop',
                    index: toolIndex,
                });
                state.contentIndex += 1;
                state.hasToolUse = true;
            } else if (typeof part.text === 'string' && part.text) {
                if (!state.textBlockOpen) {
                    sendClaudeEvent(controller, 'content_block_start', {
                        type: 'content_block_start',
                        index: state.contentIndex,
                        content_block: { type: 'text', text: '' },
                    });
                    state.textBlockOpen = true;
                }
                state.accumulatedText += part.text;
                sendClaudeEvent(controller, 'content_block_delta', {
                    type: 'content_block_delta',
                    index: state.contentIndex,
                    delta: { type: 'text_delta', text: part.text },
                });
            }
        }
    }

    const usage = convertGeminiUsageToClaudeUsage(chunk.usageMetadata as Record<string, unknown> | undefined);
    if (candidate?.finishReason || usage) {
        if (state.textBlockOpen) {
            sendClaudeEvent(controller, 'content_block_stop', { type: 'content_block_stop', index: state.contentIndex });
            state.textBlockOpen = false;
        }
        sendClaudeEvent(controller, 'message_delta', {
            type: 'message_delta',
            delta: {
                stop_reason: state.hasToolUse
                    ? 'tool_use'
                    : candidate?.finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'end_turn',
            },
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

/**
 * Create a transform stream that renders a generateContent SSE stream as
 * Interactions API events (§ the `/v1/interactions` front door).
 *
 * This is the one egress dialect that had no emitter at all: the handler used to
 * wrap this module's Claude-SSE transformer in a second `TransformStream`, which
 * is a pass-through — a `TransformStream` instance exposes only `readable` and
 * `writable`, so `new TransformStream(instance)` has no `transform` to apply and
 * the client received the upstream's own `{candidates:[…]}` chunks.
 *
 * Events are framed the way the Interactions API frames them — the type is inside
 * the payload's `event_type`, with no SSE `event:` line — which is also how this
 * module's `handleGeminiEvent` already reads them.
 *
 * The closing `interaction.complete` is not assembled here: the accumulated
 * generateContent parts are handed to `convertGenerateContentToInteraction`, so
 * the streamed interaction's `status`, `error`, `outputs` and `usage` are the
 * same objects the non-streaming egress produces, and the two cannot drift. The
 * one field either path could have got wrong on its own — an id minted for a call
 * the upstream sent without one — is minted from the part's position in the
 * answer on both, which is why a streamed content block is converted at that
 * position rather than as a one-part answer.
 */
export function createInteractionsStreamTransformer(
    model: string,
    requestId: string,
    logger?: Logger
): TransformStream<Uint8Array, Uint8Array> {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let started = false;
    let completed = false;
    /** Upstream-shaped parts, so the closing conversion sees one conversation. */
    const parts: Array<Record<string, unknown>> = [];
    /** The text part still being appended to, or null once another part starts. */
    let openText: Record<string, unknown> | null = null;
    let openTextIndex: number | null = null;
    let contentIndex = 0;
    let usageMetadata: Record<string, unknown> | undefined;
    let promptFeedback: Record<string, unknown> | undefined;
    let responseId: string | undefined;
    /** Content kinds already reported as unprojectable, so each is named once. */
    const reportedDrops = new Set<string>();

    const started_at = new Date().toISOString();
    let interactionId: string | undefined;

    const write = (controller: TransformStreamDefaultController<string>, event: Record<string, unknown>) => {
        controller.enqueue(`data: ${stringify(event)}\n\n`);
    };

    const ensureStarted = (controller: TransformStreamDefaultController<string>) => {
        if (started) return;
        started = true;
        interactionId = responseId ?? `v1_${Date.now()}_${requestId}`;
        write(controller, {
            event_type: 'interaction.start',
            interaction: {
                id: interactionId,
                model,
                status: 'in_progress',
                object: 'interaction',
                created: started_at,
                updated: started_at,
                role: 'model',
                outputs: [],
            },
        });
    };

    const closeText = (controller: TransformStreamDefaultController<string>) => {
        if (openTextIndex === null) return;
        write(controller, { event_type: 'content.stop', index: openTextIndex });
        openText = null;
        openTextIndex = null;
    };

    /** One non-text part: it arrives whole, so it opens and closes at once. */
    const writeWholeContent = (
        controller: TransformStreamDefaultController<string>,
        part: Record<string, unknown>
    ) => {
        closeText(controller);
        // The position this part holds in the answer, which is where the closing
        // conversion will find it again — it converts the accumulated parts as one
        // candidate, so a call id it mints comes from this index. Minting here from
        // a one-part candidate instead would name the same call differently in the
        // streamed content and in the closing interaction.
        const position = parts.length;
        parts.push(part);
        const index = contentIndex++;
        const { content, dropped } = convertPartForStream(part, position);
        if (dropped.length > 0) {
            // Rule #8: a part this stream cannot project would otherwise leave a
            // shorter answer with no trace of what went missing.
            for (const kind of dropped) {
                if (reportedDrops.has(kind)) continue;
                reportedDrops.add(kind);
                logger?.warn(requestId, `Upstream stream content with no Interactions projection was dropped: ${kind}`);
            }
        }
        if (!content) return;
        write(controller, { event_type: 'content.start', index, content });
        write(controller, { event_type: 'content.stop', index });
    };

    const handleChunk = (chunk: Record<string, unknown>, controller: TransformStreamDefaultController<string>) => {
        const candidates = chunk.candidates as Array<Record<string, unknown>> | undefined;
        const candidate = candidates?.[0];
        const content = candidate?.content as Record<string, unknown> | undefined;
        const chunkParts = Array.isArray(content?.parts) ? content.parts as Array<Record<string, unknown>> : [];

        if (typeof chunk.responseId === 'string' && chunk.responseId !== '') responseId = chunk.responseId;
        if (chunk.usageMetadata) usageMetadata = chunk.usageMetadata as Record<string, unknown>;
        if (chunk.promptFeedback) promptFeedback = chunk.promptFeedback as Record<string, unknown>;

        if (chunkParts.length > 0) ensureStarted(controller);

        for (const part of chunkParts) {
            if (typeof part.text === 'string' && part.thought !== true && !part.functionCall) {
                if (!openText) {
                    openText = { text: '' };
                    parts.push(openText);
                    openTextIndex = contentIndex++;
                    write(controller, {
                        event_type: 'content.start',
                        index: openTextIndex,
                        content: { type: 'text', text: '' },
                    });
                }
                openText.text = `${openText.text as string}${part.text}`;
                write(controller, {
                    event_type: 'content.delta',
                    index: openTextIndex,
                    delta: { type: 'text', text: part.text },
                });
                continue;
            }
            writeWholeContent(controller, part);
        }

        const finishReason = candidate?.finishReason;
        // A blocked prompt is terminal too, and carries no `finishReason`: the
        // upstream ends the stream after the `promptFeedback` chunk.
        const blocked = blockedPromptReason(promptFeedback) !== undefined;
        if ((typeof finishReason !== 'string' || finishReason === '') && !blocked) return;

        ensureStarted(controller);
        closeText(controller);

        // The same conversion the non-streaming egress runs, over the parts this
        // stream accumulated: one place decides what a finish reason means.
        const { interaction } = convertGenerateContentToInteraction(
            {
                ...(responseId ? { responseId } : {}),
                candidates: [{
                    content: { role: 'model', parts },
                    ...(typeof finishReason === 'string' && finishReason !== '' ? { finishReason } : {}),
                }],
                ...(usageMetadata ? { usageMetadata } : {}),
                ...(promptFeedback ? { promptFeedback } : {}),
            },
            model,
            requestId
        );
        interaction.id = interactionId!;
        write(controller, { event_type: 'interaction.complete', interaction });
        completed = true;
    };

    return new TransformStream({
        transform(chunk: Uint8Array, controller: TransformStreamDefaultController<Uint8Array>) {
            const stringController = {
                enqueue: (value: string) => controller.enqueue(encoder.encode(value)),
            } as TransformStreamDefaultController<string>;

            buffer += decoder.decode(chunk, { stream: true });
            const messages = buffer.split('\n\n');
            buffer = messages.pop() || '';
            for (const message of messages) {
                if (!message.trim()) continue;
                for (const line of message.split('\n')) {
                    if (!line.startsWith('data: ')) continue;
                    const data = line.slice(6).trim();
                    if (data === '' || data === '[DONE]') continue;
                    let parsed: Record<string, unknown>;
                    try {
                        parsed = JSON.parse(data) as Record<string, unknown>;
                    } catch {
                        // Not a JSON data line: the upstream sent something this
                        // stream cannot project, and a partial answer is worse
                        // than a loud failure (Rule #8).
                        throw new Error(`Invalid JSON in upstream SSE data (request ${requestId || 'unknown'})`);
                    }
                    handleChunk(parsed, stringController);
                }
            }
        },

        flush() {
            // An Interactions stream ends with `interaction.complete` (the upstream
            // chunk that carries a `finishReason`). Reaching the end without one is
            // an unexpected EOF, not a finished interaction — the same refusal
            // `createStreamTransformer` makes for a stream with no `[DONE]`.
            if (!completed) {
                throw new Error(`Upstream SSE stream ended before a finishReason (request ${requestId || 'unknown'})`);
            }
        },
    });
}

/**
 * One generateContent part -> the Interactions `Content` to emit for it, plus the
 * kinds the conversion had to drop. Delegates to the non-streaming converter so a
 * part has exactly one projection whichever egress carries it.
 *
 * `position` is where the part sits in the answer, which the caller passes because
 * this conversion sees one part at a time: a call id the upstream did not supply is
 * minted from it, and must be the id the closing conversion mints for the same
 * part (`convertGenerateContentToInteraction`'s `partIndexBase`).
 */
function convertPartForStream(
    part: Record<string, unknown>,
    position: number
): { content?: Record<string, unknown>; dropped: string[] } {
    const { interaction, dropped } = convertGenerateContentToInteraction(
        { candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP' }] },
        'stream',
        'stream',
        position
    );
    const outputs = interaction.outputs as Array<Record<string, unknown>> | undefined;
    return { content: outputs?.[0], dropped };
}
