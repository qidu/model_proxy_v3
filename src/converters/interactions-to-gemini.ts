/**
 * Gemini Interactions API -> generateContent request converter.
 *
 * `/v1/interactions` served by a `gemini-generatecontent` upstream used to be
 * converted inline in `src/handlers/gemini.ts`, and four of that mapping's
 * defects came from what it did not translate:
 *
 * 1. `contents` was seeded empty and only replaced when `input` matched one of
 *    four shapes, so every other shape (a single `Content`, a single `Turn`, an
 *    absent `input`) reached the upstream as `contents: []`.
 * 2. Only `text` parts were translated; an image, a tool call or a thought part
 *    was copied through in the Interactions spelling into a `parts` array, which
 *    generateContent cannot parse.
 * 3. `tools` was copied verbatim. The Interactions `Tool` is flat
 *    (`{type:'function', name, description, parameters}`); generateContent wants
 *    `{functionDeclarations: [...]}` or a predefined family (`{googleSearch: {}}`).
 * 4. `generation_config` was copied verbatim into `generationConfig`. The
 *    Interactions knobs are `{top_p, max_output_tokens, stop_sequences,
 *    thinking_level, thinking_summaries, tool_choice, …}`; generateContent's are
 *    `{topP, maxOutputTokens, stopSequences, thinkingConfig, …}` plus a separate
 *    `toolConfig`. Google's JSON parser rejects unknown names, so the whole
 *    request failed on a field name the client never wrote.
 *
 * `response_format`, `response_mime_type` and `response_modalities` were never
 * read at all; they are mapped here.
 *
 * Everything this module cannot express is either translated or refused with a
 * 400 — an unmapped field name must never reach the upstream (Rule #8), because
 * the error it earns names a field the client never sent. The few request-level
 * fields with no generateContent equivalent are dropped and *reported* to the
 * caller in `dropped`, for the handler to log.
 *
 * Parts are read tolerantly, in the three dialects a body reaching this front
 * door can hold: generateContent's own (`{text}`, `{inline_data}`, …), the
 * Interactions one (`{type:'image', data, mime_type}`, …), and Claude's
 * `{type:'image', source:{…}}`. `gemini-to-openai.ts` reads the first two for the
 * same reason, and the handler-ref fixture uses the third.
 */

import { recursivelyCleanSchema } from './claude-to-openai.js';
import { isBlobRef, rebindBlobRef } from '../utils/blob-refs.js';
import { ValidationError } from '../utils/errors.js';
import { stringify } from '../utils/stringify.js';

/** The `type` discriminators the Interactions API declares for a Content part. */
const INTERACTIONS_PART_TYPES = new Set([
    'text', 'image', 'audio', 'video', 'document',
    'function_call', 'function_result', 'thought',
    'code_execution_call', 'code_execution_result',
]);

/**
 * Part keys that already spell a generateContent part. A part with no `type` that
 * carries one is relayed unchanged: it is either a body a transform reshaped into
 * the upstream's own dialect, or a native client's, and rebuilding it would move
 * §5.4's ref positions for no gain.
 *
 * Only the spellings this repo reads or writes somewhere are listed. The camelCase
 * names are generateContent's own; `inline_data`/`file_data` are listed in both
 * cases because the sibling converters read either (`gemini-to-openai.ts:52`,
 * `gemini-to-claude.ts:230`) and §5.4's allowlist is pinned against both. A
 * snake_case twin nothing reads — `function_call`, `function_response`,
 * `executable_code`, `code_execution_result` — is deliberately absent: relaying it
 * would carry a field name generateContent does not declare into a request, which
 * is the upstream error naming a field the client never wrote that this module
 * exists to prevent.
 */
const GENERATE_CONTENT_PART_KEYS = [
    'text',
    'inline_data', 'inlineData',
    'file_data', 'fileData',
    'functionCall',
    'functionResponse',
    'thought',
    'executableCode',
    'codeExecutionResult',
] as const;

/**
 * Tool keys that already spell a generateContent `Tool`. A tool carrying one is
 * relayed unchanged, for the reason the parts mapper does the same: it is a
 * native client's or a transform's output, and the sibling converter reads both
 * spellings in the other direction (`gemini-to-openai.ts:242`).
 */
const GENERATE_CONTENT_TOOL_KEYS = [
    'functionDeclarations', 'googleSearch', 'codeExecution', 'urlContext',
    'computerUse', 'fileSearch', 'mcpServer', 'mcpServers',
] as const;

/**
 * Request-level fields with no generateContent spelling. Reported rather than
 * silently dropped, because each changes what the client asked for: `agent` /
 * `agent_config` select a different product, `background` a different execution
 * model, `previous_interaction_id` state the upstream cannot see, `store` a
 * retrieval this proxy has no route for, `speech_config` a capability.
 */
const UNMAPPABLE_FIELDS = [
    'agent', 'agent_config', 'background', 'previous_interaction_id', 'store', 'speech_config',
] as const;

export interface InteractionsConversion {
    body: Record<string, unknown>;
    /** Names of request fields dropped for having no generateContent equivalent. */
    dropped: string[];
}

/**
 * Convert an Interactions request body into a generateContent request body.
 * Throws `ValidationError` (400) for a body this route cannot express.
 */
export function convertInteractionsToGenerateContent(
    request: Record<string, unknown>
): InteractionsConversion {
    const dropped: string[] = [];

    const { contents, systemTexts } = buildContents(request.input);
    const body: Record<string, unknown> = { contents };

    // `system_instruction` is a top-level string on this API; so is any
    // `system`/`developer` message hoisted out of `input.messages`, since
    // generateContent's `contents` only knows 'user' and 'model'. The
    // generateContent spellings of the same field (`{parts:[…]}`, `{text}`, the
    // camelCase alias) are accepted too, as the sibling converter accepts them.
    const declaredSystem = request.system_instruction ?? request.systemInstruction;
    const systemInstruction = systemInstructionText(declaredSystem);
    const systemText = [systemInstruction, ...systemTexts].filter(text => text !== '').join('\n\n');
    if (systemText !== '') {
        body.systemInstruction = { parts: [{ text: systemText }] };
    }

    const tools = buildTools(request.tools);
    if (tools.length > 0) body.tools = tools;

    const { generationConfig, toolConfig, dropped: droppedConfig } = buildConfig(request);
    if (generationConfig) body.generationConfig = generationConfig;
    if (toolConfig) body.toolConfig = toolConfig;
    dropped.push(...droppedConfig);

    // Fields with a generateContent equivalent that keeps the client's meaning.
    if (request.cached_content !== undefined) body.cachedContent = request.cached_content;
    if (request.stream === true) body.stream = true;

    for (const field of UNMAPPABLE_FIELDS) {
        if (request[field] !== undefined) dropped.push(field);
    }

    return { body, dropped };
}

// --- input -> contents -------------------------------------------------------

/** One content per turn/step; a part list becomes one `user` content. */
function buildContents(input: unknown): { contents: Array<Record<string, unknown>>; systemTexts: string[] } {
    const systemTexts: string[] = [];

    if (typeof input === 'string') {
        return { contents: [{ role: 'user', parts: [{ text: input }] }], systemTexts };
    }

    if (Array.isArray(input)) {
        if (input.length === 0) {
            throw new ValidationError('Interactions request `input` array must carry at least one content');
        }
        const first = asRecord(input[0]);

        if (first && 'role' in first) {
            return { contents: input.map(item => turnToContent(asRecord(item), 'input[]')), systemTexts };
        }
        if (first && (first.type === 'user_input' || first.type === 'model_output')) {
            return { contents: input.map(item => stepToContent(asRecord(item))), systemTexts };
        }
        // An Interactions `Content[]` is one user turn's part list, not one content
        // per part — the shape the spec's own examples use.
        return {
            contents: [{ role: 'user', parts: input.map((part, i) => toGeminiPart(asRecord(part), `input[${i}]`)) }],
            systemTexts,
        };
    }

    const record = asRecord(input);
    if (record) {
        if (Array.isArray(record.messages)) {
            const contents: Array<Record<string, unknown>> = [];
            for (let i = 0; i < record.messages.length; i++) {
                const message = asRecord(record.messages[i]) ?? {};
                const role = message.role;
                if (role === 'system' || role === 'developer') {
                    // Hoisted rather than refused: there is no reason the top-level
                    // field has to be the only way to send a system prompt, and this
                    // front door's Completions hop carries a system message through.
                    systemTexts.push(requireString(message.content, `input.messages[${i}].content`));
                    continue;
                }
                contents.push({
                    role: contentRole(role, `input.messages[${i}].role`),
                    parts: contentToParts(message.content, `input.messages[${i}]`),
                });
            }
            if (contents.length === 0) {
                throw new ValidationError(
                    'Interactions request `input.messages` must contain at least one user or model message'
                );
            }
            return { contents, systemTexts };
        }
        if ('role' in record) {
            return { contents: [turnToContent(record, 'input')], systemTexts };
        }
        if (record.type === 'user_input' || record.type === 'model_output') {
            // The scalar form of an input step, which the array branch above reads.
            return { contents: [stepToContent(record)], systemTexts };
        }
        if (typeof record.type === 'string') {
            return { contents: [{ role: 'user', parts: [toGeminiPart(record, 'input')] }], systemTexts };
        }
    }

    throw new ValidationError(
        'Interactions request `input` must be a string, a Content, an array of Content or Turn, ' +
        'or an object with `messages`'
    );
}

function turnToContent(turn: Record<string, unknown> | undefined, where: string): Record<string, unknown> {
    if (!turn) throw new ValidationError(`Interactions ${where} entry must be an object`);
    return {
        role: contentRole(turn.role, `${where}.role`),
        parts: contentToParts(turn.content, where),
    };
}

/**
 * An input *step*: a Turn whose `type` stands in for its `role`. `user_input` is
 * the client's turn, `model_output` the model's own earlier turn.
 */
function stepToContent(step: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!step) throw new ValidationError('Interactions input step must be an object');
    return {
        role: step.type === 'model_output' ? 'model' : 'user',
        parts: contentToParts(step.content, `input step ${stringify(step.type)}`),
    };
}

/** A Turn/message `content`: a bare string, or a part list. */
function contentToParts(content: unknown, where: string): Array<Record<string, unknown>> {
    if (typeof content === 'string') return [{ text: content }];
    if (Array.isArray(content)) {
        if (content.length === 0) {
            throw new ValidationError(`Interactions ${where}.content must carry at least one part`);
        }
        return content.map((part, i) => toGeminiPart(asRecord(part), `${where}.content[${i}]`));
    }
    throw new ValidationError(`Interactions ${where}.content must be a string or an array of Content parts`);
}

// --- parts -------------------------------------------------------------------

/** An Interactions Content part -> the generateContent part that expresses it. */
function toGeminiPart(part: Record<string, unknown> | undefined, where: string): Record<string, unknown> {
    if (!part) throw new ValidationError(`Interactions ${where} must be an object`);

    if (typeof part.type === 'string' && INTERACTIONS_PART_TYPES.has(part.type)) {
        switch (part.type) {
            case 'text':
                // An empty string is carried as it stands: it is a part the client
                // sent, not a value this converter gets to drop.
                if (typeof part.text !== 'string') {
                    throw new ValidationError(`Interactions ${where}.text must be a string`);
                }
                return { text: part.text };

            case 'image':
            case 'audio':
            case 'video':
            case 'document':
                return mediaPart(part, where);

            case 'function_call': {
                const id = typeof part.id === 'string' && part.id !== '' ? { id: part.id } : {};
                return {
                    functionCall: {
                        ...id,
                        name: requireString(part.name, `${where}.name`),
                        args: functionArgs(part.arguments, `${where}.arguments`),
                    },
                };
            }

            case 'function_result': {
                // generateContent matches a result to its call by `id` when one is
                // present, and by name otherwise.
                const id = typeof part.call_id === 'string' && part.call_id !== '' ? { id: part.call_id } : {};
                const result = part.result;
                return {
                    functionResponse: {
                        ...id,
                        name: requireString(part.name, `${where}.name`),
                        response: { content: typeof result === 'string' ? result : stringify(result) },
                    },
                };
            }

            case 'thought': {
                // The Interactions thought carries a signature to replay and, at
                // most, a summary of the reasoning — not the reasoning itself.
                const summary = asRecord(asRecord(part.summary)?.content);
                const text = typeof summary?.text === 'string' ? { text: summary.text } : {};
                const signature = typeof part.signature === 'string' && part.signature !== ''
                    ? { thoughtSignature: part.signature }
                    : {};
                return { thought: true, ...text, ...signature };
            }

            case 'code_execution_call': {
                const args = asRecord(part.arguments) ?? {};
                return {
                    executableCode: {
                        language: typeof args.language === 'string' ? args.language : 'PYTHON',
                        code: requireString(args.code, `${where}.arguments.code`),
                    },
                };
            }

            default:
                return {
                    codeExecutionResult: {
                        outcome: part.is_error === true ? 'OUTCOME_FAILED' : 'OUTCOME_OK',
                        output: typeof part.result === 'string' ? part.result : stringify(part.result),
                    },
                };
        }
    }

    if (!('type' in part) && GENERATE_CONTENT_PART_KEYS.some(key => key in part)) return part;

    throw new ValidationError(
        `Interactions ${where} is not a Content part: no recognized \`type\` ` +
        `(${stringify(part.type)}) and no generateContent part field`
    );
}

/** An image/audio/video/document part, whichever of the spellings holds its bytes. */
function mediaPart(part: Record<string, unknown>, where: string): Record<string, unknown> {
    const source = asRecord(part.source);

    // Claude's spelling: `{type:'image', source:{type:'base64', media_type, data}}`.
    if (source) {
        if (source.type !== 'base64') {
            throw new ValidationError(
                `Interactions ${where} is a Claude-style ${stringify(source.type)} source; only ` +
                '`base64` has a generateContent equivalent on this route'
            );
        }
        return {
            inline_data: {
                mime_type: mediaType(part, source, where),
                data: keepRefInPlace(source.data),
            },
        };
    }

    const mimeType = mediaType(part, undefined, where);
    if ((typeof part.data === 'string' && part.data !== '') || isBlobRef(part.data)) {
        return { inline_data: { mime_type: mimeType, data: keepRefInPlace(part.data) } };
    }
    if (typeof part.uri === 'string' && part.uri !== '') {
        // A Files API URI. An http(s) URL would need a server-side fetch, which
        // this route does not do.
        return { file_data: { file_uri: part.uri, mime_type: mimeType } };
    }
    throw new ValidationError(`Interactions ${where} carries neither \`data\` nor \`uri\``);
}

/**
 * Leave a §5.4 ref in its payload position so the egress expands it in place. The
 * media MIME types share the one `gemini-inline-data` position
 * (`utils/blob-refs.ts`), which is also the kind the request walk assigns.
 */
function keepRefInPlace(data: unknown): unknown {
    return isBlobRef(data) ? rebindBlobRef(data, 'gemini-inline-data', '') : data;
}

/** The declared MIME type, from the Interactions field or Claude's `media_type`. */
function mediaType(
    part: Record<string, unknown>,
    source: Record<string, unknown> | undefined,
    where: string
): string {
    const declared = part.mime_type ?? source?.media_type;
    if (typeof declared === 'string' && declared !== '') return declared;
    throw new ValidationError(`Interactions ${where} must declare a mime_type`);
}

// --- tools -------------------------------------------------------------------

/**
 * Interactions tools -> generateContent `tools`. The flat function entries are
 * grouped into one `{functionDeclarations: [...]}`; a predefined family becomes
 * the empty-object field that selects it.
 */
function buildTools(tools: unknown): Array<Record<string, unknown>> {
    if (tools === undefined) return [];
    if (!Array.isArray(tools)) {
        throw new ValidationError('Interactions request `tools` must be an array');
    }

    const declarations: Array<Record<string, unknown>> = [];
    const predefined: Array<Record<string, unknown>> = [];

    for (let i = 0; i < tools.length; i++) {
        const tool = asRecord(tools[i]);
        if (!tool) throw new ValidationError(`Interactions tools[${i}] must be an object`);

        if (GENERATE_CONTENT_TOOL_KEYS.some(key => key in tool)) {
            predefined.push(tool);
            continue;
        }

        switch (tool.type) {
            case 'function':
                declarations.push({
                    name: requireString(tool.name, `tools[${i}].name`),
                    description: typeof tool.description === 'string' ? tool.description : '',
                    // Gemini's Schema is an OpenAPI subset: the same cleaning the
                    // Claude and Completions paths apply (no `$schema`, no
                    // `additionalProperties`, no unsupported `format`).
                    parameters: recursivelyCleanSchema(asRecord(tool.parameters) ?? { type: 'object', properties: {} }),
                });
                break;

            case 'google_search':
                predefined.push({ googleSearch: {} });
                break;

            case 'code_execution':
                predefined.push({ codeExecution: {} });
                break;

            case 'url_context':
                predefined.push({ urlContext: {} });
                break;

            case 'computer_use': {
                const environment = typeof tool.environment === 'string' ? { environment: tool.environment } : {};
                const excluded = Array.isArray(tool.excludedPredefinedFunctions)
                    ? { excludedPredefinedFunctions: tool.excludedPredefinedFunctions }
                    : {};
                predefined.push({ computerUse: { ...environment, ...excluded } });
                break;
            }

            case 'file_search': {
                const config: Record<string, unknown> = {};
                if (Array.isArray(tool.file_search_store_names)) {
                    config.fileSearchStoreNames = tool.file_search_store_names;
                }
                if (typeof tool.top_k === 'number') config.topK = tool.top_k;
                if (typeof tool.metadata_filter === 'string') config.metadataFilter = tool.metadata_filter;
                predefined.push({ fileSearch: config });
                break;
            }

            case 'mcp_server':
                // generateContent's MCP spelling is pinned by nothing in this repo
                // (`docs/api/list_of_api_and_schema.md` names the field but no
                // shape), and guessing one would earn an upstream error naming it.
                throw new ValidationError(
                    'Interactions `mcp_server` tools have no pinned generateContent equivalent on this route'
                );

            default:
                throw new ValidationError(
                    `Interactions tools[${i}] carries an unsupported type ${stringify(tool.type)}`
                );
        }
    }

    return declarations.length > 0
        ? [{ functionDeclarations: declarations }, ...predefined]
        : predefined;
}

// --- generation config -------------------------------------------------------

/**
 * `generation_config` (plus the knobs the Interactions API declares beside it)
 * -> `generationConfig` and `toolConfig`.
 */
function buildConfig(request: Record<string, unknown>): {
    generationConfig?: Record<string, unknown>;
    toolConfig?: Record<string, unknown>;
    dropped: string[];
} {
    const dropped: string[] = [];
    const source = request.generation_config;
    if (source !== undefined && !isRecord(source)) {
        throw new ValidationError('Interactions request `generation_config` must be an object');
    }
    const config = source ?? {};

    const out: Record<string, unknown> = {};
    copyNumber(config, out, 'temperature', 'temperature');
    copyNumber(config, out, 'top_p', 'topP');
    copyNumber(config, out, 'seed', 'seed');
    copyNumber(config, out, 'max_output_tokens', 'maxOutputTokens');
    copyStringArray(config, out, 'stop_sequences', 'stopSequences');

    const thinking = buildThinkingConfig(config);
    if (thinking) out.thinkingConfig = thinking;

    const imageConfig = asRecord(config.image_config);
    if (imageConfig) {
        const mapped: Record<string, unknown> = {};
        copyString(imageConfig, mapped, 'aspect_ratio', 'aspectRatio');
        copyString(imageConfig, mapped, 'image_size', 'imageSize');
        if (Object.keys(mapped).length > 0) out.imageConfig = mapped;
    }

    // Declared beside `generation_config` on this API, and inside it on the type
    // (`types/gemini.ts`), but fields of generateContent's `generationConfig`
    // either way. The top-level spelling wins when both are present.
    copyString(request, out, 'response_mime_type', 'responseMimeType');
    copyString(config, out, 'response_mime_type', 'responseMimeType');

    const responseFormat = request.response_format ?? config.response_format;
    if (responseFormat !== undefined) {
        if (!isRecord(responseFormat)) {
            throw new ValidationError('Interactions `response_format` must be an object (a JSON schema)');
        }
        out.responseSchema = recursivelyCleanSchema(responseFormat);
    }

    const modalities = request.response_modalities;
    if (modalities !== undefined) {
        if (!Array.isArray(modalities)) {
            throw new ValidationError('Interactions request `response_modalities` must be an array');
        }
        out.responseModalities = modalities.map(m => String(m).toUpperCase());
    }

    // The interactions `speech_config` is `{voice, language, speaker}` and
    // generateContent's is `{voiceConfig:{prebuiltVoiceConfig:{voiceName}},
    // languageCode, multiSpeakerVoiceConfig}` — not a rename, so it is reported
    // rather than guessed at.
    if (config.speech_config !== undefined) dropped.push('generation_config.speech_config');

    const toolConfig = buildToolConfig(config.tool_choice);

    return {
        ...(Object.keys(out).length > 0 ? { generationConfig: out } : {}),
        ...(toolConfig ? { toolConfig } : {}),
        dropped,
    };
}

/**
 * The Interactions thinking knobs -> generateContent's `thinkingConfig`.
 *
 * `thinking_level` is carried by name — a model that does not take a level says so
 * itself — but re-cased: every generateContent enum identifier this module emits
 * is upper case (`AUTO`/`ANY`/`NONE`, `OUTCOME_OK`, `PYTHON`,
 * `responseModalities`), and the Interactions level is declared lower case
 * (`interactions.md:51`, `types/gemini.ts:163`). `thinking_summaries` is the one
 * knob with a boolean equivalent.
 */
function buildThinkingConfig(config: Record<string, unknown>): Record<string, unknown> | undefined {
    const out: Record<string, unknown> = {};
    if (typeof config.thinking_level === 'string' && config.thinking_level !== '') {
        out.thinkingLevel = config.thinking_level.toUpperCase();
    }
    if (config.thinking_summaries === 'auto') out.includeThoughts = true;
    else if (config.thinking_summaries === 'none') out.includeThoughts = false;
    return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * `generation_config.tool_choice` -> `toolConfig.functionCallingConfig`. Accepts
 * the bare enum and the object form, both of which the Interactions spec allows.
 * An unrecognized value is refused rather than dropped: a client that forced a
 * tool would otherwise get a free-choice turn with no way to tell.
 */
function buildToolConfig(toolChoice: unknown): Record<string, unknown> | undefined {
    if (toolChoice === undefined || toolChoice === null) return undefined;

    if (typeof toolChoice === 'string') {
        const mode = callingMode(toolChoice);
        if (!mode) {
            throw new ValidationError(`Interactions tool_choice ${stringify(toolChoice)} has no generateContent mode`);
        }
        return { functionCallingConfig: { mode } };
    }

    const choice = asRecord(toolChoice);
    if (!choice) {
        throw new ValidationError('Interactions tool_choice must be a string or an object');
    }

    const name = asRecord(choice.function)?.name;
    if (typeof name === 'string' && name !== '') {
        // The forced-single-function form: ANY, restricted to that function.
        return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [name] } };
    }

    const allowed = Array.isArray(choice.tools)
        ? choice.tools.filter((n): n is string => typeof n === 'string' && n !== '')
        : [];
    if (allowed.length > 0) {
        return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: allowed } };
    }

    const mode = callingMode(choice.type ?? choice.mode);
    if (!mode) {
        throw new ValidationError(`Interactions tool_choice ${stringify(toolChoice)} has no generateContent mode`);
    }
    return { functionCallingConfig: { mode } };
}

/** Interactions tool-choice value -> generateContent `FunctionCallingConfig.mode`. */
function callingMode(value: unknown): string | undefined {
    switch (value) {
        case 'auto':
            return 'AUTO';
        case 'any':
        case 'validated':
            // `validated` is the same constraint in Gemini's vocabulary: the model
            // is constrained to always predict a function call.
            return 'ANY';
        case 'none':
            return 'NONE';
        default:
            return undefined;
    }
}

// --- small helpers -----------------------------------------------------------

/**
 * A call's arguments. The spec declares an object, but the JSON-string spelling
 * reaches this front door too; parsing it beats sending `{}` and losing the call's
 * arguments to a silent default (Rule #8).
 */
function functionArgs(value: unknown, where: string): Record<string, unknown> {
    if (value === undefined || value === null) return {};
    if (typeof value === 'string') {
        if (value === '') return {};
        try {
            const parsed = JSON.parse(value);
            if (isRecord(parsed)) return parsed;
        } catch {
            throw new ValidationError(`Interactions ${where} is a string that is not JSON`);
        }
        throw new ValidationError(`Interactions ${where} is a JSON string that is not an object`);
    }
    const record = asRecord(value);
    if (!record) throw new ValidationError(`Interactions ${where} must be an object or a JSON object string`);
    return record;
}

/**
 * The declared system prompt as text, in any of the spellings this front door is
 * served: the Interactions string, generateContent's `{parts:[{text}]}`, a bare
 * `{text}`, or the camelCase alias of the field itself. An unrecognized shape is
 * refused rather than dropped — a lost system prompt changes the answer.
 */
function systemInstructionText(declared: unknown): string {
    if (declared === undefined || declared === null) return '';
    if (typeof declared === 'string') return declared;

    const record = asRecord(declared);
    if (record) {
        const parts = record.parts;
        if (Array.isArray(parts)) {
            return parts
                .map(part => {
                    const text = asRecord(part)?.text;
                    return typeof text === 'string' ? text : '';
                })
                .join('');
        }
        if (typeof record.text === 'string') return record.text;
    }
    throw new ValidationError('Interactions `system_instruction` must be a string or a text part list');
}

/** Interactions turn/step role -> generateContent content role. */
function contentRole(role: unknown, where: string): string {
    if (role === 'user' || role === 'model' || role === 'assistant') {
        return role === 'assistant' ? 'model' : role;
    }
    throw new ValidationError(
        `Interactions ${where} must be "user" or "model"; a system prompt belongs in \`system_instruction\``
    );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, where: string): string {
    if (typeof value !== 'string' || value === '') {
        throw new ValidationError(`Interactions ${where} must be a non-empty string`);
    }
    return value;
}

function copyNumber(from: Record<string, unknown>, to: Record<string, unknown>, key: string, target: string): void {
    if (typeof from[key] === 'number') to[target] = from[key];
}

function copyString(from: Record<string, unknown>, to: Record<string, unknown>, key: string, target: string): void {
    if (typeof from[key] === 'string' && from[key] !== '') to[target] = from[key];
}

function copyStringArray(from: Record<string, unknown>, to: Record<string, unknown>, key: string, target: string): void {
    const value = from[key];
    if (!Array.isArray(value)) return;
    const strings = value.filter((item): item is string => typeof item === 'string' && item !== '');
    if (strings.length > 0) to[target] = strings;
}
