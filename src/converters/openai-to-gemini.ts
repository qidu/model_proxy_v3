/**
 * Convert OpenAI response to Gemini generateContent format
 */

const THINK_REGEX = /<(?:thinking|think)>([\s\S]*?)<\/(?:thinking|think)>/g;

/**
 * Extract <think>/<thinking> content from text, returning the reasoning and
 * the cleaned text separately. Both are empty strings if no tags are present.
 */
function extractThinkContent(text: string): { reasoning: string; cleanText: string } {
    THINK_REGEX.lastIndex = 0;
    let reasoning = '';
    let m;
    while ((m = THINK_REGEX.exec(text)) !== null) {
        reasoning += m[1];
    }
    if (!reasoning) return { reasoning: '', cleanText: text };
    const cleanText = text.replace(/<(?:thinking|think)>[\s\S]*?<\/(?:thinking|think)>/g, '').trim();
    return { reasoning, cleanText };
}

function parseToolArguments(value: unknown): Record<string, unknown> {
    if (value && typeof value === 'object') return value as Record<string, unknown>;
    if (typeof value !== 'string' || value === '') return {};
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
        return {};
    }
}

// Per-request tool-parameter schemas, keyed by requestId -> functionName ->
// JSON schema (the inbound `functionDeclarations[].parameters`). Populated by
// the handler at inbound and consulted by the egress converter to coerce the
// model's tool-call args into the declared JSON types. Keyed by requestId for
// the same reason as the streaming buffers in openai.ts — concurrent requests
// must not share state. Cleared via clearGeminiToolSchemas on stream end.
const geminiToolSchemas: Map<string, Map<string, Record<string, unknown>>> = new Map();

/** Register the inbound tool-parameter schemas for a request. */
export function registerGeminiToolSchemas(requestId: string, schemasByName: Map<string, Record<string, unknown>>): void {
    geminiToolSchemas.set(requestId, schemasByName);
}

/** Remove a request's tool-parameter schemas (called from clearGeminiSSEState). */
export function clearGeminiToolSchemas(requestId: string): void {
    geminiToolSchemas.delete(requestId);
}

/**
 * Coercion-only repair of a single argument value against its declared JSON
 * schema type. Fixes the common weak-model type mismatches:
 *  - scalar where an array is declared  -> wrap in a single-element array
 *  - non-string where a string is declared -> String(value)
 *  - numeric string where a number is declared -> Number(value)
 *  - "true"/"false" where a boolean is declared -> boolean
 * Never fabricates missing required args and never drops unknown keys — a value
 * that cannot be safely coerced is returned unchanged so the upstream can
 * reject it honestly.
 */
function coerceValueToSchemaType(value: unknown, propSchema: Record<string, unknown> | undefined): unknown {
    if (!propSchema || typeof propSchema !== 'object') return value;
    const declared = typeof propSchema.type === 'string' ? (propSchema.type as string).toLowerCase() : undefined;
    if (!declared) return value;

    if (declared === 'array') {
        if (Array.isArray(value)) return value;
        // Wrap a lone scalar/object into a single-element array, coercing the
        // element against `items` when that schema is present.
        const items = propSchema.items as Record<string, unknown> | undefined;
        return [coerceValueToSchemaType(value, items)];
    }
    if (declared === 'string') {
        if (typeof value === 'string') return value;
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        return value;
    }
    if (declared === 'number' || declared === 'integer') {
        if (typeof value === 'number') return value;
        if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
        return value;
    }
    if (declared === 'boolean') {
        if (typeof value === 'boolean') return value;
        if (value === 'true') return true;
        if (value === 'false') return false;
        return value;
    }
    return value;
}

/**
 * Coerce a tool call's args object against its declared parameter schema.
 * Only keys present in `properties` are coerced; unknown keys are left intact
 * (coercion-only, no drop-unknown).
 */
function coerceArgsToSchema(args: Record<string, unknown>, paramSchema: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!paramSchema || typeof paramSchema !== 'object') return args;
    const properties = paramSchema.properties as Record<string, Record<string, unknown>> | undefined;
    if (!properties || typeof properties !== 'object') return args;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(args)) {
        out[key] = key in properties ? coerceValueToSchemaType(args[key], properties[key]) : args[key];
    }
    return out;
}

/**
 * Map an OpenAI `finish_reason` to the Gemini `FinishReason` enum.
 * Gemini SDKs switch on the uppercase enum and throw on anything else
 * (e.g. @google/genai's mapStopReason throws `Unhandled stop reason`), so the
 * raw lowercase OpenAI value must never pass through.
 */
function toGeminiFinishReason(finishReason: unknown): string | undefined {
    if (typeof finishReason !== 'string' || finishReason === '' || finishReason === 'null') {
        return undefined;
    }
    switch (finishReason) {
        case 'stop':
        case 'tool_calls':
        case 'function_call':
            return 'STOP';
        case 'length':
            return 'MAX_TOKENS';
        case 'content_filter':
            return 'SAFETY';
        default:
            // Already a Gemini enum value (gemini-shaped passthrough) — pass through;
            // an unknown lowercase value maps to OTHER rather than leaking verbatim.
            return finishReason === finishReason.toUpperCase() ? finishReason : 'OTHER';
    }
}

export function convertOpenAIToGeminiGenerateContent(
    openaiResponse: any,
    modelId: string,
    requestId: string
): Record<string, unknown> {
    const choices = openaiResponse.choices || [];
    const usage = openaiResponse.usage;

    const geminiResponse: Record<string, any> = {
        model: modelId,
        candidates: [] as any[],
        usageMetadata: {
            promptTokenCount: usage?.prompt_tokens || 0,
            candidatesTokenCount: usage?.completion_tokens || 0,
            totalTokenCount: usage?.total_tokens || 0,
        }
    };

    if (choices.length > 0) {
        const choice = choices[0];
        const content = choice.delta?.content || choice.message?.content || '';
        // Reasoning-model upstreams (e.g. DeepSeek) emit thinking as a dedicated
        // reasoning_content field rather than inline <think> tags.
        const reasoningContent = choice.delta?.reasoning_content || choice.message?.reasoning_content || '';
        const toolCalls = choice.message?.tool_calls || choice.delta?.tool_calls || [];
        const parts: any[] = [];

        if (reasoningContent !== '') {
            parts.push({ thought: true, text: reasoningContent });
        }
        if (content !== '') {
            const { reasoning, cleanText } = extractThinkContent(content);
            if (reasoning) {
                parts.push({ thought: true, text: reasoning });
            }
            if (cleanText) {
                parts.push({ text: cleanText });
            }
        }
        const schemasByName = geminiToolSchemas.get(requestId);
        for (const toolCall of toolCalls) {
            const fn = toolCall.function || {};
            const name = fn.name || '';
            const args = parseToolArguments(fn.arguments);
            parts.push({
                functionCall: {
                    name,
                    args: coerceArgsToSchema(args, schemasByName?.get(name)),
                }
            });
        }

        const finishReason = toGeminiFinishReason(choice.finish_reason);

        // Skip empty content chunks in streaming — unless the chunk carries the
        // finish_reason: strict Gemini clients (@google/genai) end the stream on
        // finishReason and throw "stream ended without a finish reason" if the
        // finish-only chunk (empty delta) is dropped.
        if (parts.length === 0 && finishReason === undefined) {
            // Return minimal response without candidates
            delete geminiResponse.candidates;
            return geminiResponse;
        }

        const candidate: any = {
            content: {
                role: 'model',
                parts
            },
            index: choice.index || 0
        };

        // Only add finishReason if it's present and meaningful
        if (finishReason !== undefined) {
            candidate.finishReason = finishReason;
        }

        geminiResponse.candidates.push(candidate);
    }

    return geminiResponse;
}

/**
 * Convert OpenAI response to Gemini Interactions format
 */
export function convertOpenAIToGeminiInteractions(
    openaiResponse: any,
    modelId: string,
    requestId: string
): Record<string, unknown> {
    const choices = openaiResponse.choices || [];
    const usage = openaiResponse.usage;

    const interactionResponse: Record<string, any> = {
        id: `v1_${Date.now()}_${requestId}`,
        model: modelId,
        status: 'completed',
        object: 'interaction',
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        role: 'model',
        outputs: [] as any[],
        usage: {
            total_input_tokens: usage?.prompt_tokens || 0,
            total_output_tokens: usage?.completion_tokens || 0,
            total_tokens: usage?.total_tokens || 0,
        }
    };

    if (choices.length > 0) {
        const choice = choices[0];
        const content = choice.delta?.content || choice.message?.content || '';
        const toolCalls = choice.message?.tool_calls || choice.delta?.tool_calls || [];
        const outputs: any[] = [];

        if (content !== '') {
            const { reasoning, cleanText } = extractThinkContent(content);
            if (reasoning) {
                outputs.push({ type: 'thought', text: reasoning });
            }
            if (cleanText) {
                outputs.push({ type: 'text', text: cleanText });
            }
        }
        for (const toolCall of toolCalls) {
            const fn = toolCall.function || {};
            outputs.push({
                type: 'function_call',
                id: toolCall.id,
                call_id: toolCall.id,
                name: fn.name || '',
                arguments: parseToolArguments(fn.arguments),
            });
        }

        // Skip empty content chunks in streaming
        if (outputs.length === 0) {
            // Return minimal response without outputs
            delete interactionResponse.outputs;
            return interactionResponse;
        }

        interactionResponse.outputs = outputs;
    }

    return interactionResponse;
}
