/**
 * Claude to Gemini Request Converter
 * Converts Claude API requests to Gemini Interactions API format
 */

import { ClaudeMessagesRequest, ClaudeTextBlock, ClaudeImageBlock, ClaudeToolUseBlock, ClaudeToolResultBlock } from '../types/claude.js';
import { isBlobRef, rebindBlobRef, type BlobRef } from '../utils/blob-refs.js';
import { fetchImageAsInlineData } from '../utils/image-fetch.js';
import { recursivelyCleanSchema } from './claude-to-openai.js';
import { stringify } from '../utils/stringify.js';

/**
 * Convert Claude request to Gemini generateContent format
 */
export function convertClaudeToGeminiRequest(
    claudeRequest: ClaudeMessagesRequest,
    modelId?: string
): Record<string, unknown> {
    const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
    // Gemini's functionResponse carries a tool *name*, Claude's tool_result only
    // a tool_use_id — so remember the name of every tool_use seen so far.
    const toolNamesById = new Map<string, string>();

    for (const msg of claudeRequest.messages) {
        const parts: Array<Record<string, unknown>> = [];

        if (typeof msg.content === 'string') {
            parts.push({ text: msg.content });
        } else if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
                if (typeof block === 'string') {
                    parts.push({ text: block });
                } else if (block.type === 'text') {
                    parts.push({ text: (block as ClaudeTextBlock).text });
                } else if (block.type === 'image') {
                    const imgBlock = block as ClaudeImageBlock;
                    const data: unknown = imgBlock.source.data;
                    parts.push({
                        inline_data: {
                            mime_type: imgBlock.source.media_type || 'image/jpeg',
                            data: isBlobRef(data) ? rebindBlobRef(data, 'gemini-inline-data', '') : data
                        }
                    });
                } else if (block.type === 'tool_use') {
                    const toolUse = block as ClaudeToolUseBlock;
                    toolNamesById.set(toolUse.id, toolUse.name);
                    parts.push({
                        functionCall: {
                            ...(typeof toolUse.id === 'string' && toolUse.id !== '' ? { id: toolUse.id } : {}),
                            name: toolUse.name,
                            args: toolUse.input ?? {},
                        },
                    });
                } else if (block.type === 'tool_result') {
                    const toolResult = block as ClaudeToolResultBlock;
                    const name = toolNamesById.get(toolResult.tool_use_id);
                    // Fail Loud (Rule #8): an unresolvable result would otherwise
                    // reach Gemini as a nameless functionResponse and be rejected there.
                    if (!name) {
                        throw new Error(
                            `Cannot convert tool_result "${toolResult.tool_use_id}" to a Gemini functionResponse: ` +
                            `no preceding tool_use block carries that id`
                        );
                    }
                    parts.push({
                        functionResponse: {
                            ...(typeof toolResult.tool_use_id === 'string' && toolResult.tool_use_id !== '' ? { id: toolResult.tool_use_id } : {}),
                            name,
                            response: {
                                content: typeof toolResult.content === 'string'
                                    ? toolResult.content
                                    : stringify(toolResult.content),
                            },
                        },
                    });
                }
                // Skip other block types for now
            }
        }
        
        if (parts.length > 0) {
            contents.push({
                role: msg.role === 'user' ? 'user' : 'model',
                parts
            });
        }
    }

    const request: Record<string, unknown> = {
        contents
    };

    // Add system instruction
    if (claudeRequest.system) {
        if (typeof claudeRequest.system === 'string') {
            request.system_instruction = { parts: [{ text: claudeRequest.system }] };
        }
    }

    // Add generation config
    if (claudeRequest.temperature !== undefined || claudeRequest.max_tokens !== undefined) {
        const config: Record<string, unknown> = {};
        if (claudeRequest.temperature !== undefined) config.temperature = claudeRequest.temperature;
        if (claudeRequest.max_tokens !== undefined) config.max_output_tokens = claudeRequest.max_tokens;
        request.generation_config = config;
    }

    // Add tools
    if (Array.isArray(claudeRequest.tools) && claudeRequest.tools.length > 0) {
        const nameless = claudeRequest.tools.filter(t => typeof t?.name !== 'string' || t.name === '');
        // Fail Loud (Rule #8): Gemini would reject the declaration anyway, and a
        // silently dropped tool leaves the model unable to call it.
        if (nameless.length > 0) {
            throw new Error(
                `Cannot convert ${nameless.length} Claude tool(s) to Gemini functionDeclarations: missing "name"`
            );
        }
        request.tools = [{
            functionDeclarations: claudeRequest.tools.map(tool => ({
                name: tool.name,
                description: tool.description ?? '',
                parameters: recursivelyCleanSchema(tool.input_schema ?? { type: 'object', properties: {} }),
            })),
        }];
    }

    // Add tool choice
    const toolChoice = claudeRequest.tool_choice;
    if (toolChoice) {
        const functionCallingConfig: Record<string, unknown> = {};
        if (toolChoice.type === 'auto') {
            functionCallingConfig.mode = 'AUTO';
        } else if (toolChoice.type === 'any') {
            functionCallingConfig.mode = 'ANY';
        } else if (toolChoice.type === 'none') {
            functionCallingConfig.mode = 'NONE';
        } else if (toolChoice.type === 'tool') {
            functionCallingConfig.mode = 'ANY';
            if (toolChoice.name) functionCallingConfig.allowedFunctionNames = [toolChoice.name];
        }
        if (functionCallingConfig.mode) {
            request.toolConfig = { functionCallingConfig };
        }
    }

    // Add cached content
    if (claudeRequest.cached_content) {
        request.cachedContent = claudeRequest.cached_content;
    }

    return request;
}

/**
 * Decode a data: URI into mime_type + base64 data. Throws on malformed input
 * (Rule #8 — Fail Loud) so the upstream receives an honest error rather than a
 * silently corrupted image part.
 *
 * Exported for reuse by `completionsToClaudeBody` (converters/completions-to-claude.ts) which
 * converts OpenAI `image_url` parts into Claude `image` blocks.
 */
export function decodeDataUri(url: string): { mime_type: string; data: string } {
    const m = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
    if (!m) {
        throw new Error(`Malformed image_url data URI: ${url.slice(0, 60)}`);
    }
    const mime = m[1] || 'image/jpeg';
    const isBase64 = m[2] === ';base64';
    const raw = m[3] ?? '';
    if (!isBase64) {
        // URL-encoded inline payload — base64-encode the decoded bytes.
        return { mime_type: mime, data: btoa(decodeURIComponent(raw)) };
    }
    return { mime_type: mime, data: raw };
}

/** Decode a data URL, or move its BlobRef to a bare-payload position without reading it. */
export function decodeDataUriOrRef(value: string | BlobRef): { mime_type: string; data: string | BlobRef } {
    if (!isBlobRef(value)) return decodeDataUri(value);
    const mime = /^data:([^;,]*)/.exec(value.prefix)?.[1]?.trim();
    return {
        mime_type: mime || 'image/jpeg',
        data: rebindBlobRef(value, 'gemini-inline-data', ''),
    };
}

/**
 * Convert an OpenAI Chat Completions request body into a Gemini
 * generateContent request body. Mirrors `completionsToClaudeBody`
 * (`src/handlers/openai.ts`) for the anthropic-messages cross-mode route.
 *
 * Async because http(s) image_url values are fetched server-side with an SSRF
 * guard (src/utils/image-fetch.ts). `data:` URIs are decoded synchronously.
 */
export async function convertCompletionsToGeminiGenerateContentBody(
    completions: Record<string, unknown>,
    model: string,
): Promise<Record<string, unknown>> {
    const messages = (completions.messages as Array<Record<string, unknown>>) || [];
    const systemMsg = messages.find(m => m.role === 'system' || m.role === 'developer');
    const otherMessages = messages.filter(m => m.role !== 'system' && m.role !== 'developer');

    const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

    for (const m of otherMessages) {
        const role = m.role === 'assistant' ? 'model' : (m.role as string);
        const parts: Array<Record<string, unknown>> = [];
        const reasoning = m.reasoning_content as string | undefined;

        if (reasoning) parts.push({ thought: true, text: reasoning });

        const toolCalls = m.tool_calls as Array<Record<string, unknown>> | undefined;
        if (toolCalls && toolCalls.length > 0) {
            for (const tc of toolCalls) {
                const fn = tc.function as Record<string, unknown> | undefined;
                let args: unknown = (fn?.arguments as string) ?? {};
                if (typeof args === 'string' && args !== '') {
                    try { args = JSON.parse(args); } catch { /* keep string */ }
                } else if (typeof args === 'string') {
                    args = {};
                }
                parts.push({
                    functionCall: {
                        ...(typeof tc.id === 'string' && tc.id !== '' ? { id: tc.id } : {}),
                        name: fn?.name ?? '',
                        args,
                    },
                });
            }
        }

        if (m.role === 'tool') {
            // Tool result — emit as functionResponse on a user turn.
            parts.length = 0;
            parts.push({
                functionResponse: {
                    ...(typeof m.tool_call_id === 'string' && m.tool_call_id !== '' ? { id: m.tool_call_id } : {}),
                    name: (m.name as string) || '',
                    response: { content: m.content ?? '' },
                },
            });
        } else {
            const content = m.content;
            if (typeof content === 'string') {
                if (content !== '') parts.push({ text: content });
            } else if (Array.isArray(content)) {
                for (const part of content as Array<Record<string, unknown>>) {
                    const pType = part.type;
                    if (pType === 'text' && typeof part.text === 'string') {
                        parts.push({ text: part.text });
                    } else if (pType === 'image_url') {
                        const url: unknown = (part.image_url as Record<string, unknown> | undefined)?.url;
                        if (typeof url !== 'string' && !isBlobRef(url)) continue;
                        if (isBlobRef(url) || url.startsWith('data:')) {
                            parts.push({ inline_data: decodeDataUriOrRef(url) });
                        } else {
                            // http(s) — server-side fetch with SSRF guard.
                            // Fail Loud on any error (no placeholder).
                            parts.push({ inline_data: await fetchImageAsInlineData(url) });
                        }
                    }
                    // Other part types (e.g. input_audio) are skipped — Gemini
                    // generateContent's multimodal surface here is image-only.
                }
            }
        }

        if (parts.length > 0) contents.push({ role, parts });
    }

    const geminiBody: Record<string, unknown> = { contents };

    if (systemMsg) {
        const sysContent = typeof systemMsg.content === 'string'
            ? systemMsg.content
            : '';
        if (sysContent !== '') {
            geminiBody.systemInstruction = { parts: [{ text: sysContent }] };
        }
    }

    const config: Record<string, unknown> = {};
    if (completions.max_tokens !== undefined) config.max_output_tokens = completions.max_tokens;
    if (completions.temperature !== undefined) config.temperature = completions.temperature;
    if (completions.top_p !== undefined) config.top_p = completions.top_p;
    if (completions.stop !== undefined) {
        config.stopSequences = Array.isArray(completions.stop) ? completions.stop : [completions.stop];
    }
    if (Object.keys(config).length > 0) geminiBody.generationConfig = config;

    const tools = completions.tools as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(tools) && tools.length > 0) {
        // Fail Loud (Rule #8): Gemini rejects a nameless declaration anyway, and a
        // silently dropped tool leaves the model unable to call one the client
        // asked for. Name the tool kinds, so a non-`function` tool (which this
        // route has no Gemini equivalent for) is not reported as a missing name.
        const nameless = tools.filter(t => {
            const name = (t.function as Record<string, unknown> | undefined)?.name;
            return typeof name !== 'string' || name === '';
        });
        if (nameless.length > 0) {
            const kinds = [...new Set(nameless.map(t =>
                typeof t.type === 'string' && t.type !== '' ? t.type : 'untyped'))];
            throw new Error(
                `Cannot convert ${nameless.length} OpenAI tool(s) to Gemini functionDeclarations: ` +
                `no "function.name" (tool type(s): ${kinds.join(', ')})`
            );
        }
        geminiBody.tools = [{
            functionDeclarations: tools.map(t => {
                const fn = (t.function ?? {}) as Record<string, unknown>;
                return {
                    name: fn.name,
                    description: fn.description ?? '',
                    // Gemini's Schema is an OpenAPI subset, so clean it exactly as
                    // the Claude path above does: OpenAI tool parameters commonly
                    // carry '$schema', 'additionalProperties' and a 'format' the
                    // upstream rejects.
                    parameters: recursivelyCleanSchema(fn.parameters ?? { type: 'object', properties: {} }),
                };
            }),
        }];
    }

    // Add tool choice — the same functionCallingConfig the Claude path above
    // builds. Without it a request that forces one function reaches Gemini
    // indistinguishable from "auto", so the model may answer in prose instead.
    const toolChoice = completions.tool_choice;
    if (toolChoice !== undefined && toolChoice !== null) {
        const functionCallingConfig: Record<string, unknown> = {};
        if (toolChoice === 'auto') {
            functionCallingConfig.mode = 'AUTO';
        } else if (toolChoice === 'none') {
            functionCallingConfig.mode = 'NONE';
        } else if (toolChoice === 'required') {
            // OpenAI's "required" (any tool) == Gemini's ANY with no allow-list.
            functionCallingConfig.mode = 'ANY';
        } else if (typeof toolChoice === 'object') {
            const name = ((toolChoice as Record<string, unknown>).function as Record<string, unknown> | undefined)?.name;
            // Fail Loud (Rule #8): named intent we cannot honour must not downgrade
            // to ANY, which would let the model call a different tool.
            if (typeof name !== 'string' || name === '') {
                throw new Error(
                    'Cannot convert tool_choice to a Gemini functionCallingConfig: the forced-function form has no "function.name"'
                );
            }
            functionCallingConfig.mode = 'ANY';
            functionCallingConfig.allowedFunctionNames = [name];
        } else {
            throw new Error(
                `Cannot convert tool_choice value ${stringify(toolChoice)} to a Gemini functionCallingConfig`
            );
        }
        geminiBody.toolConfig = { functionCallingConfig };
    }

    if (completions.stream === true) geminiBody.stream = true;

    // Carrier for the requested model — Gemini generateContent URL embeds the
    // model, but the body field is harmless and useful for diagnostics.
    geminiBody.model = model;

    return geminiBody;
}