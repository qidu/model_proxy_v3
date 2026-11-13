/**
 * Streaming response converter from OpenAI SSE to Claude SSE
 */

import { countTokensWithTiktoken, getTiktokenTokenizer } from '../utils/token-counting.js';
import { TokenCountingConfig, SYNTHETIC_THINKING_SIGNATURE } from './openai-to-claude.js';
import { stringify } from '../utils/stringify.js';

/**
 * `inputTokens` is the request's input-token estimate, resolved by the caller
 * before the response stream exists (§5.3). This transformer lives as long as
 * the downstream send, so it takes the resulting scalar rather than the request
 * body: closing over the body would pin the whole request — inline base64
 * payloads included — until the client stops reading.
 */
export function createStreamTransformer(
    model: string,
    requestId: string,
    inputTokens = 0,
    tokenCountingConfig?: TokenCountingConfig,
    includeThinking = false
) {
    let initialized = false;
    let buffer = "";
    let hasToolCalls = false;
    // The last `finish_reason` the upstream reported, recorded as it arrives.
    // It cannot be recovered from the frame that precedes [DONE]: that frame may
    // be in an earlier network chunk, or the `choices: []` usage chunk that
    // stream_options.include_usage makes upstream emit after the finish chunk.
    let upstreamFinishReason: string | null = null;
    let hasThinking = false;
    let thinkingStarted = false;
    const messageMutex = requestId || `msg_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const toolCalls: {
        [index: number]: {
            id: string,
            name: string,
            args: string,
            claudeIndex: number,
            started: boolean
        }
    } = {};
    let contentBlockIndex = 0;
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    // Thinking content accumulation state
    let accumulatedThinkingContent = "";
    let accumulatedSignature = "";
    let thinkingBlockIndex = -1;

    // Token counting state
    let outputTokens = 0;
    let tokenizer: any = null;
    let tokenizerReady = false;

    // Upstream-reported usage (from stream_options.include_usage final chunk,
    // which may arrive in any transform() call before [DONE])
    let upstreamPromptTokens = 0;
    let upstreamCompletionTokens = 0;
    let upstreamCachedTokens = 0;
    let upstreamCacheWrittenTokens = 0;

    const captureUpstreamUsage = (usage: any) => {
        if (!usage || typeof usage !== 'object') return;
        if (typeof usage.prompt_tokens === 'number' && usage.prompt_tokens > 0) {
            upstreamPromptTokens = usage.prompt_tokens;
        }
        if (typeof usage.completion_tokens === 'number' && usage.completion_tokens > 0) {
            upstreamCompletionTokens = usage.completion_tokens;
        }
        // OpenAI-style cached tokens
        const detailsCached = usage.prompt_tokens_details?.cached_tokens;
        // DeepSeek-style cache hit/miss tokens
        const cacheHit = usage.prompt_cache_hit_tokens;
        const cacheMiss = usage.prompt_cache_miss_tokens;
        if (typeof detailsCached === 'number' && detailsCached > 0) {
            upstreamCachedTokens = detailsCached;
        } else if (typeof cacheHit === 'number' && cacheHit > 0) {
            upstreamCachedTokens = cacheHit;
        }
        if (typeof cacheMiss === 'number' && cacheMiss > 0) {
            upstreamCacheWrittenTokens = cacheMiss;
        }
    };

    // Prepare the tokenizer for output counting
    const initializeTokenCounting = async () => {
        if (tokenCountingConfig?.enabled) {
            try {
                tokenizer = await getTiktokenTokenizer(tokenCountingConfig.modelName);
                tokenizerReady = true;
            } catch (e) {
                tokenizerReady = false;
            }
        }
    };

    // Count output tokens for text content
    const countOutputTokens = (text: string) => {
        if (!tokenizerReady || !text) return;
        try {
            outputTokens += countTokensWithTiktoken(text, { tokenizer, useLocalCounting: true });
        } catch (e) {
            // Ignore counting errors
        }
    };

    // Count output tokens for tool call arguments
    const countToolCallTokens = (args: string) => {
        if (!tokenizerReady || !args) return;
        try {
            outputTokens += countTokensWithTiktoken(args, { tokenizer, useLocalCounting: true });
        } catch (e) {
            // Ignore counting errors
        }
    };

    // Count thinking tokens separately
    const countThinkingTokens = (thinkingText: string) => {
        if (!tokenizerReady || !thinkingText) return;
        try {
            outputTokens += countTokensWithTiktoken(thinkingText, { tokenizer, useLocalCounting: true });
        } catch (e) {
            // Ignore counting errors
        }
    };

    // Build the final usage object, preferring upstream-reported counts over
    // local tiktoken estimates, and including cache fields when available.
    const buildFinalUsage = () => {
        const usage: Record<string, number> = {
            input_tokens: upstreamPromptTokens > 0 ? upstreamPromptTokens : inputTokens,
            output_tokens: upstreamCompletionTokens > 0 ? upstreamCompletionTokens : outputTokens,
        };
        if (upstreamCachedTokens > 0) {
            usage.cache_read_input_tokens = upstreamCachedTokens;
        }
        if (upstreamCacheWrittenTokens > 0) {
            usage.cache_creation_input_tokens = upstreamCacheWrittenTokens;
        }
        return usage;
    };

    const sendEvent = (controller: TransformStreamDefaultController, event: string, data: object) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${stringify(data)}\n\n`));
    };

    // Process thinking extraction from text content
    const processThinkingExtraction = (textContent: string, controller: TransformStreamDefaultController) => {
        // Add to buffer for processing
        accumulatedThinkingContent += textContent;

        // Try to extract complete thinking blocks
        const thinkingRegex = /<(?:thinking|think)>([\s\S]*?)<\/(?:thinking|think)>/g;
        let match;
        let lastIndex = 0;
        let hasCompleteThinkingBlock = false;

        while ((match = thinkingRegex.exec(accumulatedThinkingContent)) !== null) {
            // Send any text before this thinking block
            if (match.index > lastIndex) {
                const textBefore = accumulatedThinkingContent.substring(lastIndex, match.index);
                if (textBefore.trim()) {
                    countOutputTokens(textBefore);
                    sendEvent(controller, 'content_block_delta', {
                        type: 'content_block_delta',
                        index: 0,
                        delta: { type: 'text_delta', text: textBefore }
                    });
                }
            }

            // Extract thinking content
            const thinkingContent = match[1];

            // Start thinking block if not already started
            if (!thinkingStarted) {
                thinkingStarted = true;
                thinkingBlockIndex = contentBlockIndex + 1;
                contentBlockIndex = thinkingBlockIndex;
                sendEvent(controller, 'content_block_start', {
                    type: 'content_block_start',
                    index: thinkingBlockIndex,
                    content_block: { type: 'thinking', thinking: '' }
                });
            }

            // Send thinking delta
            countThinkingTokens(thinkingContent);
            sendEvent(controller, 'content_block_delta', {
                type: 'content_block_delta',
                index: thinkingBlockIndex,
                delta: { type: 'thinking_delta', thinking: thinkingContent }
            });

            lastIndex = thinkingRegex.lastIndex;
            hasCompleteThinkingBlock = true;
            hasThinking = true;
        }

        // If we found complete thinking blocks, remove processed content
        if (hasCompleteThinkingBlock) {
            accumulatedThinkingContent = accumulatedThinkingContent.substring(lastIndex);
        }

        // If we have remaining text after thinking blocks, send it
        if (accumulatedThinkingContent && !accumulatedThinkingContent.includes('<thinking>') && !accumulatedThinkingContent.includes('<think>')) {
            countOutputTokens(accumulatedThinkingContent);
            sendEvent(controller, 'content_block_delta', {
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: accumulatedThinkingContent }
            });
            accumulatedThinkingContent = '';
        }
    };

    return {
        async transform(chunk: Uint8Array, controller: TransformStreamDefaultController) {
            if (!initialized) {
                // Initialize output token counting (must complete before the
                // first delta so the tokenizer is ready for it). Input tokens
                // were resolved by the caller and arrive on the parameter.
                await initializeTokenCounting();

                // Send message_start event with input tokens
                sendEvent(controller, 'message_start', {
                    type: 'message_start',
                    message: {
                        id: messageMutex,
                        type: 'message',
                        role: 'assistant',
                        model,
                        content: [],
                        stop_reason: null,
                        usage: { input_tokens: inputTokens, output_tokens: outputTokens }
                    }
                });
                // Send content_block_start for first text block
                sendEvent(controller, 'content_block_start', {
                    type: 'content_block_start',
                    index: 0,
                    content_block: { type: 'text', text: '' }
                });
                initialized = true;
            }

            buffer += decoder.decode(chunk, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (!line.startsWith("data: ")) continue;
                const data = line.substring(6);

                if (data.trim() === "[DONE]") {
                    // Send content_block_stop for all active blocks
                    sendEvent(controller, 'content_block_stop', {
                        type: 'content_block_stop',
                        index: 0
                    });

                    // Send signature_delta before content_block_stop for thinking block.
                    // Fall back to a synthetic signature when the upstream provided none,
                    // so signature-less thinking blocks still satisfy Anthropic's spec.
                    if (thinkingStarted && thinkingBlockIndex !== -1) {
                        sendEvent(controller, 'content_block_delta', {
                            type: 'content_block_delta',
                            index: thinkingBlockIndex,
                            delta: {
                                type: 'signature_delta',
                                signature: accumulatedSignature || SYNTHETIC_THINKING_SIGNATURE,
                                index: thinkingBlockIndex
                            }
                        });
                    }

                    // Send content_block_stop for thinking block if active
                    if (thinkingStarted && thinkingBlockIndex !== -1) {
                        sendEvent(controller, 'content_block_stop', {
                            type: 'content_block_stop',
                            index: thinkingBlockIndex
                        });
                    }

                    Object.values(toolCalls).forEach(tc => {
                        if (tc.started) {
                            sendEvent(controller, 'content_block_stop', {
                                type: 'content_block_stop',
                                index: tc.claudeIndex
                            });
                        }
                    });

                    // Determine final stop reason from the reason recorded as the
                    // chunks streamed by, not from the frame before [DONE].
                    let finalStopReason = "end_turn";
                    if (upstreamFinishReason === 'tool_calls' || upstreamFinishReason === 'tool_use') finalStopReason = 'tool_use';
                    else if (upstreamFinishReason === 'length') finalStopReason = 'max_tokens';
                    else if (upstreamFinishReason === 'content_filter') finalStopReason = 'content_filter';
                    else if ((!upstreamFinishReason || upstreamFinishReason === 'stop') && hasToolCalls) finalStopReason = 'tool_use';

                    // Send message_delta with final token counts
                    sendEvent(controller, 'message_delta', {
                        type: 'message_delta',
                        delta: { stop_reason: finalStopReason, stop_sequence: null },
                        usage: buildFinalUsage()
                    });

                    // Send message_stop
                    sendEvent(controller, 'message_stop', {
                        type: 'message_stop'
                    });

                    controller.terminate();
                    return;
                }

                try {
                    const openaiChunk = JSON.parse(data);
                    // With stream_options.include_usage, the usage arrives in a
                    // final chunk that has an empty choices array — capture it
                    // before skipping such chunks.
                    captureUpstreamUsage(openaiChunk.usage);
                    // Record the terminal reason here, before the empty-choices
                    // skip below: the usage chunk that follows the finish chunk
                    // has `choices: []`, so a later reconstruction would miss it.
                    const chunkFinishReason = openaiChunk.choices?.[0]?.finish_reason;
                    if (typeof chunkFinishReason === 'string') upstreamFinishReason = chunkFinishReason;
                    if (!openaiChunk.choices || !Array.isArray(openaiChunk.choices) || openaiChunk.choices.length === 0) {
                        continue;
                    }
                    const delta = openaiChunk.choices[0]?.delta;
                    if (!delta) continue;

                    // Handle text content delta
                    if (delta.content) {
                        const textContent = delta.content;

                        // Check if this chunk contains thinking markers
                        if (textContent.includes('<thinking>') || textContent.includes('</thinking>') || textContent.includes('<think>') || textContent.includes('</think>') || accumulatedThinkingContent) {
                            // Process thinking extraction with state management
                            processThinkingExtraction(textContent, controller);
                        } else {
                            // No thinking markers found, send as regular text
                            countOutputTokens(textContent);
                            sendEvent(controller, 'content_block_delta', {
                                type: 'content_block_delta',
                                index: 0,
                                delta: { type: 'text_delta', text: textContent }
                            });
                        }
                    }

                    // Handle thinking/reasoning content (OpenAI-compatible thinking mode).
                    // `delta.reasoning_content` is always forwarded as a thinking block —
                    // upstream thinking models (e.g. DeepSeek) may produce it even when the
                    // client did not explicitly request thinking, and the round-trip requires
                    // it to be present in the assistant history on the next turn.
                    // The `includeThinking` flag gates only the legacy <think> tag path;
                    // the dedicated reasoning_content field is unconditional.
                    {
                        // Handle reasoning_content (common in thinking-enabled models)
                        const reasoningContent = delta.reasoning_content || delta.reasoning;
                        if (reasoningContent && typeof reasoningContent === 'string') {
                            // Add reasoning content to accumulated thinking content
                            accumulatedThinkingContent += reasoningContent;
                            hasThinking = true;

                            // Start thinking block if not already started
                            if (!thinkingStarted) {
                                thinkingStarted = true;
                                thinkingBlockIndex = contentBlockIndex + 1;
                                contentBlockIndex = thinkingBlockIndex;
                                sendEvent(controller, 'content_block_start', {
                                    type: 'content_block_start',
                                    index: thinkingBlockIndex,
                                    content_block: { type: 'thinking', thinking: '' }
                                });
                            }

                            // Send thinking delta
                            countThinkingTokens(reasoningContent);
                            sendEvent(controller, 'content_block_delta', {
                                type: 'content_block_delta',
                                index: thinkingBlockIndex,
                                delta: { type: 'thinking_delta', thinking: reasoningContent }
                            });
                        }

                        // Handle signature delta for thinking verification
                        const signatureContent = delta.signature;
                        if (signatureContent && typeof signatureContent === 'string') {
                            // Accumulate signature for thinking block
                            accumulatedSignature += signatureContent;
                        }

                        // Also check for signature in the chunk metadata (similar to non-streaming)
                        const reasoningItemId = openaiChunk.reasoning_item_id;
                        const responseSignature = openaiChunk.signature;

                        if (reasoningItemId && !accumulatedSignature) {
                            accumulatedSignature = reasoningItemId;
                        } else if (responseSignature && !accumulatedSignature) {
                            accumulatedSignature = responseSignature;
                        }
                    }

                    // Handle tool call deltas
                    if (delta.tool_calls) {
                        hasToolCalls = true;
                        for (const tc_delta of delta.tool_calls) {
                            const index = tc_delta.index;
                            if (!toolCalls[index]) {
                                toolCalls[index] = {
                                    id: '',
                                    name: '',
                                    args: '',
                                    claudeIndex: 0,
                                    started: false
                                };
                            }

                            if (tc_delta.id) toolCalls[index].id = tc_delta.id;
                            if (tc_delta.function?.name) toolCalls[index].name = tc_delta.function.name;
                            if (tc_delta.function?.arguments) {
                                countToolCallTokens(tc_delta.function.arguments);
                                toolCalls[index].args += tc_delta.function.arguments;
                            }

                            // Start new tool_use block when we have both id and name
                            if (toolCalls[index].id && toolCalls[index].name && !toolCalls[index].started) {
                                contentBlockIndex++;
                                toolCalls[index].claudeIndex = contentBlockIndex;
                                toolCalls[index].started = true;

                                sendEvent(controller, 'content_block_start', {
                                    type: 'content_block_start',
                                    index: contentBlockIndex,
                                    content_block: {
                                        type: 'tool_use',
                                        id: toolCalls[index].id,
                                        name: toolCalls[index].name,
                                        input: {}
                                    }
                                });
                            }

                            // Send input_json_delta for tool arguments
                            if (toolCalls[index].started && tc_delta.function?.arguments) {
                                sendEvent(controller, 'content_block_delta', {
                                    type: 'content_block_delta',
                                    index: toolCalls[index].claudeIndex,
                                    delta: { type: 'input_json_delta', partial_json: tc_delta.function.arguments }
                                });
                            }
                        }
                    }
                } catch (e) {
                    throw new Error(`Invalid JSON in upstream SSE data (request ${requestId || 'unknown'})`);
                }
            }
        },

        flush() {
            // A normal OpenAI stream terminates through the [DONE] branch above,
            // which calls controller.terminate(). Reaching flush without it is an
            // unexpected EOF, not a successful response to finalize.
            throw new Error(`Upstream SSE stream ended before [DONE] (request ${requestId || 'unknown'})`);
        }
    };
}