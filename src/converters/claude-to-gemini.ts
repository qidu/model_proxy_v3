/**
 * Claude to Gemini Request Converter
 * Converts Claude API requests to Gemini Interactions API format
 */

import { ClaudeMessagesRequest, ClaudeTextBlock, ClaudeImageBlock } from '../types/claude.js';
import { fetchImageAsInlineData } from '../utils/image-fetch.js';

/**
 * Convert Claude request to Gemini generateContent format
 */
export function convertClaudeToGeminiRequest(
    claudeRequest: ClaudeMessagesRequest,
    modelId?: string
): Record<string, unknown> {
    const contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];

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
                    parts.push({
                        inline_data: {
                            mime_type: imgBlock.source.media_type || 'image/jpeg',
                            data: imgBlock.source.data
                        }
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
 * Exported for reuse by `completionsToClaudeBody` (handlers/openai.ts) which
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

/**
 * Convert an OpenAI Chat Completions request body into a Gemini
 * generateContent request body. Mirrors `completionsToClaudeBody`
 * (src/handlers/openai.ts:499) for the anthropic-messages cross-mode route.
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
                parts.push({ functionCall: { name: fn?.name ?? '', args } });
            }
        }

        if (m.role === 'tool') {
            // Tool result — emit as functionResponse on a user turn.
            parts.length = 0;
            parts.push({
                functionResponse: {
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
                        const url = (part.image_url as Record<string, unknown> | undefined)?.url as string;
                        if (typeof url !== 'string' || url === '') continue;
                        if (url.startsWith('data:')) {
                            parts.push({ inline_data: decodeDataUri(url) });
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
        const fds = tools
            .map(t => {
                const fn = (t.function ?? {}) as Record<string, unknown>;
                return {
                    name: fn.name,
                    description: fn.description ?? '',
                    parameters: fn.parameters ?? { type: 'object', properties: {} },
                };
            })
            .filter(fd => typeof fd.name === 'string');
        if (fds.length > 0) geminiBody.tools = [{ functionDeclarations: fds }];
    }

    if (completions.stream === true) geminiBody.stream = true;

    // Carrier for the requested model — Gemini generateContent URL embeds the
    // model, but the body field is harmless and useful for diagnostics.
    geminiBody.model = model;

    return geminiBody;
}