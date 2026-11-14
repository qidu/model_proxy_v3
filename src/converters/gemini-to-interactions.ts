/**
 * Gemini generateContent response -> Interactions API response converter.
 *
 * The non-streaming half of `/v1/interactions` served by a
 * `gemini-generatecontent` upstream. It was inline in `src/handlers/gemini.ts`
 * and had two defects beyond the text passthrough it did:
 *
 * 1. `status` was the literal `'completed'`, and `candidates[0].finishReason`
 *    was never read. A `MAX_TOKENS` answer therefore told the client it had
 *    finished, and a `SAFETY` block with no candidate content told it there was
 *    a completed answer with an empty `outputs` array — the failure was invisible
 *    (Rule #8).
 * 2. Non-text parts were relayed verbatim from the upstream's dialect:
 *    `{inlineData}` and `{functionCall}` reached the client with no `type`
 *    discriminator (unparseable as an Interactions `Content`, whose `type` the
 *    spec marks required), and a `{thought:true, text}` part became
 *    `{type:'text'}`, i.e. the model's reasoning was served as its answer.
 *
 * The `id` is the upstream's own `responseId` when it supplies one. It used to be
 * minted (`v1_<timestamp>_<requestId>`) even then, which is the identifier a
 * client would send back as `previous_interaction_id`.
 *
 * The interactions `status` enum has no "truncated" member
 * (`types/gemini.ts:235`), and the resource does declare an `error`
 * (`docs/api/list_of_api_and_schema.md:245`). A blocked or truncated answer is
 * therefore `failed` and carries the upstream's reason in `error`. A cleanly
 * stopped function call is `requires_action`, as the Interactions contract
 * declares; any other clean stop is `completed`.
 */

import { ProcessingError } from '../utils/errors.js';
import { stringify } from '../utils/stringify.js';

/**
 * Finish reasons that mean the model did not answer at all: a safety or
 * provenance filter stopped it, and `outputs` is empty or partial by policy.
 */
const BLOCKING_FINISH_REASONS = new Set([
    'SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII',
    'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_RECITATION',
]);

/** Finish reasons that ended the answer early, or failed it after it started. */
const TRUNCATING_FINISH_REASONS = new Set([
    'MAX_TOKENS', 'MALFORMED_FUNCTION_CALL', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS',
    'LANGUAGE', 'OTHER',
]);

export interface InteractionConversion {
    interaction: Record<string, unknown>;
    /** Content kinds the response carried that have no Interactions equivalent. */
    dropped: string[];
}

/**
 * Convert a generateContent response body into an Interactions `Interaction`.
 * Throws `ProcessingError` (500) when the upstream answered with a body this
 * route cannot read at all: an empty interaction reported as `completed` would
 * be the silent success Rule #8 forbids.
 *
 * `partIndexBase` is the index `candidates[0].content.parts[0]` holds in the
 * answer. Only the minted call id depends on it, and the streaming egress passes
 * the real position of the one part it is converting, so that the id a streamed
 * content block announces is the id this conversion reports for it in the closing
 * interaction (`gemini-streaming.ts`).
 */
export function convertGenerateContentToInteraction(
    response: unknown,
    model: string,
    requestId: string,
    partIndexBase = 0
): InteractionConversion {
    if (!isRecord(response)) {
        throw new ProcessingError('Upstream generateContent response is not a JSON object');
    }

    const dropped: string[] = [];
    const candidate = asRecord(Array.isArray(response.candidates) ? response.candidates[0] : undefined);

    const outputs = partsOf(candidate).flatMap((part, index) => {
        const converted = convertPart(part, index + partIndexBase, dropped);
        return converted ? [converted] : [];
    });

    const finishReason = typeof candidate?.finishReason === 'string' ? candidate.finishReason : '';
    const blockReason = blockedPromptReason(response.promptFeedback);
    const blocked = blockReason !== undefined;

    const error = interactionError(finishReason, blockReason);
    const failed = blocked
        || BLOCKING_FINISH_REASONS.has(finishReason)
        || TRUNCATING_FINISH_REASONS.has(finishReason);
    const requiresAction = outputs.some(output => output.type === 'function_call');
    const status = failed ? 'failed' : requiresAction ? 'requires_action' : 'completed';

    const now = new Date().toISOString();
    const interaction: Record<string, unknown> = {
        // The upstream's own id when it has one; §5.4's rule against synthesizing
        // an identifier applies to a `previous_interaction_id` round trip too.
        id: typeof response.responseId === 'string' && response.responseId !== ''
            ? response.responseId
            : `v1_${Date.now()}_${requestId}`,
        model,
        status,
        object: 'interaction',
        created: now,
        updated: now,
        role: 'model',
        outputs,
        usage: convertUsage(asRecord(response.usageMetadata)),
        ...(error ? { error } : {}),
    };

    return { interaction, dropped };
}

/**
 * The reason an upstream blocked the prompt, if it did.
 *
 * Exported because the streaming egress needs the same test: a blocked prompt
 * arrives as a chunk carrying `promptFeedback` with no `finishReason` at all, so
 * the stream must treat it as terminal. A `promptFeedback` that carries only
 * `safetyRatings` — which normal responses do — is not a block.
 */
export function blockedPromptReason(promptFeedback: unknown): string | undefined {
    const reason = asRecord(promptFeedback)?.blockReason;
    return typeof reason === 'string' && reason !== '' && reason !== 'BLOCK_REASON_UNSPECIFIED'
        ? reason
        : undefined;
}

/** The error object: `code` a URI naming the upstream's own reason, `message` prose. */
function interactionError(
    finishReason: string,
    blockReason?: string
): { code: string; message: string } | undefined {    if (blockReason) {
        return {
            code: `https://ai.google.dev/api/generate-content#BlockReason.${blockReason}`,
            message: `The upstream blocked the prompt (${blockReason}) and returned no candidate.`,
        };
    }
    if (finishReason === '' || finishReason === 'STOP' || finishReason === 'FINISH_REASON_UNSPECIFIED') {
        return undefined;
    }
    const where = BLOCKING_FINISH_REASONS.has(finishReason)
        ? 'The upstream withheld the answer'
        : 'The upstream stopped the answer early';
    return {
        code: `https://ai.google.dev/api/generate-content#FinishReason.${finishReason}`,
        message: `${where} (finishReason ${finishReason}).`,
    };
}

function partsOf(candidate: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
    const content = asRecord(candidate?.content);
    const parts = content?.parts;
    if (!Array.isArray(parts)) return [];
    return parts.filter(isRecord);
}

// --- parts -------------------------------------------------------------------

/** A generateContent part -> the Interactions `Content` that expresses it. */
function convertPart(
    part: Record<string, unknown>,
    index: number,
    dropped: string[]
): Record<string, unknown> | undefined {
    if (part.thought === true) {
        return convertThought(part);
    }
    if (typeof part.text === 'string') {
        return { type: 'text', text: part.text };
    }

    const inlineData = asRecord(part.inline_data ?? part.inlineData);
    if (inlineData) return convertInlineData(inlineData, dropped);

    const functionCall = asRecord(part.functionCall ?? part.function_call);
    if (functionCall) {
        return {
            type: 'function_call',
            name: typeof functionCall.name === 'string' ? functionCall.name : '',
            arguments: asRecord(functionCall.args) ?? {},
            // Required by the Interactions spec. The upstream supplies one for a
            // call it expects to be answered; without it the call could not be
            // matched to a `function_result` at all.
            id: typeof functionCall.id === 'string' && functionCall.id !== '' ? functionCall.id : `call_${index}`,
        };
    }

    const executableCode = asRecord(part.executableCode ?? part.executable_code);
    if (executableCode) {
        return {
            type: 'code_execution_call',
            arguments: {
                language: typeof executableCode.language === 'string' ? executableCode.language : 'python',
                code: typeof executableCode.code === 'string' ? executableCode.code : '',
            },
        };
    }

    const codeResult = asRecord(part.codeExecutionResult ?? part.code_execution_result);
    if (codeResult) {
        const outcome = codeResult.outcome;
        return {
            type: 'code_execution_result',
            result: typeof codeResult.output === 'string' ? codeResult.output : stringify(codeResult.output),
            is_error: typeof outcome === 'string' && outcome !== 'OUTCOME_OK',
        };
    }

    // Rule #8: a part with no Interactions projection is reported, not served as
    // something it is not.
    dropped.push(partKind(part));
    return undefined;
}

/**
 * A thought part: the signature to replay, and the summary of the reasoning when
 * the upstream sent one. It is *not* the answer, which is what relaying its
 * `text` as a text content used to make it.
 */
function convertThought(part: Record<string, unknown>): Record<string, unknown> {
    const summary = typeof part.text === 'string' && part.text !== ''
        ? { summary: { content: { type: 'text', text: part.text } } }
        : {};
    const signature = typeof part.thoughtSignature === 'string' && part.thoughtSignature !== ''
        ? { signature: part.thoughtSignature }
        : {};
    return { type: 'thought', ...summary, ...signature };
}

/**
 * An inline payload -> the typed Interactions content for its MIME type. The
 * Interactions `Content` union names image, audio, video and document, which is
 * what the media MIME types map onto.
 */
function convertInlineData(
    inlineData: Record<string, unknown>,
    dropped: string[]
): Record<string, unknown> | undefined {
    const mimeType = typeof inlineData.mimeType === 'string'
        ? inlineData.mimeType
        : typeof inlineData.mime_type === 'string' ? inlineData.mime_type : '';
    const data = typeof inlineData.data === 'string' ? inlineData.data : '';

    const type = contentKindForMimeType(mimeType);
    if (!type) {
        dropped.push(`inlineData(${mimeType || 'no mime type'})`);
        return undefined;
    }
    return { type, data, mime_type: mimeType };
}

/** The Interactions `Content` type for a MIME type, or undefined if it has none. */
function contentKindForMimeType(mimeType: string): 'image' | 'audio' | 'video' | 'document' | undefined {
    if (mimeType.startsWith('image/')) return 'image';
    if (mimeType.startsWith('audio/')) return 'audio';
    if (mimeType.startsWith('video/')) return 'video';
    if (mimeType === 'application/pdf') return 'document';
    return undefined;
}

/** A name for a part this converter cannot project, for the drop report. */
function partKind(part: Record<string, unknown>): string {
    const keys = Object.keys(part);
    return keys.length > 0 ? `part(${keys.slice(0, 3).join(',')})` : 'part(empty)';
}

// --- usage -------------------------------------------------------------------

/**
 * `usageMetadata` -> the Interactions `usage`. Includes the thought and cached
 * counts the Interactions type declares (`types/gemini.ts:188`); every field is
 * omitted rather than defaulted when the upstream did not report it.
 */
function convertUsage(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
    const usage: Record<string, unknown> = {
        total_input_tokens: numberOr(metadata?.promptTokenCount, 0),
        total_output_tokens: numberOr(metadata?.candidatesTokenCount, 0),
        total_tokens: numberOr(metadata?.totalTokenCount, 0),
    };
    const optional: Array<[string, string]> = [
        ['total_cached_tokens', 'cachedContentTokenCount'],
        ['total_thought_tokens', 'thoughtsTokenCount'],
        ['total_tool_use_tokens', 'toolUsePromptTokenCount'],
    ];
    for (const [target, source] of optional) {
        if (typeof metadata?.[source] === 'number') usage[target] = metadata[source];
    }
    return usage;
}

function numberOr(value: unknown, fallback: number): number {
    return typeof value === 'number' ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return asRecord(value) !== undefined;
}
