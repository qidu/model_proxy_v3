import type { Logger } from '../types/shared.js';
import { isBlobRef, rebindBlobRef } from '../utils/blob-refs.js';
import { ValidationError } from '../utils/errors.js';
import { stringify } from '../utils/stringify.js';
import { normalizeGeminiSchema } from './gemini-to-openai.js';
import { BLOCKING_FINISH_REASONS, blockedPromptReason } from './gemini-to-interactions.js';
import type { NamespaceMap } from './responses-to-completions.js';

interface ConversionOptions {
  logger?: Logger;
  requestId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function warn(options: ConversionOptions | undefined, message: string): void {
  options?.logger?.warn(options.requestId ?? '', `[gemini->responses] ${message}`);
}

function dataUri(data: unknown, mimeType: unknown, position: string, file: boolean): string | ReturnType<typeof rebindBlobRef> {
  const mime = typeof mimeType === 'string' && mimeType !== '' ? mimeType : 'application/octet-stream';
  const prefix = `data:${mime};base64,`;
  if (isBlobRef(data)) return rebindBlobRef(data, file ? 'responses-input-file' : 'responses-input-image', prefix);
  if (typeof data !== 'string' || data === '') throw new ValidationError(`${position} requires non-empty base64 data`);
  return `${prefix}${data}`;
}

function pushMessage(
  input: Array<Record<string, unknown>>,
  role: 'user' | 'assistant',
  parts: Array<Record<string, unknown>>,
): void {
  if (parts.length === 0) return;
  const previous = input.at(-1);
  if (previous?.type === 'message' && previous.role === role && Array.isArray(previous.content)) {
    previous.content.push(...parts);
  } else {
    input.push({ type: 'message', role, content: parts });
  }
}

function contentPartToResponses(
  part: Record<string, unknown>,
  role: 'user' | 'assistant',
  where: string,
  options?: ConversionOptions,
): Record<string, unknown> | undefined {
  const inline = asRecord(part.inlineData ?? part.inline_data);
  const file = asRecord(part.fileData ?? part.file_data);
  const media = inline ?? file;
  if (media) {
    const mime = media.mimeType ?? media.mime_type;
    const isImage = typeof mime === 'string' && mime.startsWith('image/');
    if (role === 'assistant') {
      warn(options, `${where} media has no Responses output-message position; dropped`);
      return undefined;
    }
    if (isImage) {
      const imageUrl = inline
        ? dataUri(media.data, mime, where, false)
        : media.fileUri ?? media.file_uri;
      if (typeof imageUrl !== 'string' && !isBlobRef(imageUrl)) {
        throw new ValidationError(`${where} image requires inline data or fileUri`);
      }
      return { type: 'input_image', image_url: imageUrl };
    }
    const fileData = inline
      ? dataUri(media.data, mime, where, true)
      : undefined;
    if (inline) return { type: 'input_file', file_data: fileData, filename: 'document' };
    const fileUrl = media.fileUri ?? media.file_uri;
    if (typeof fileUrl !== 'string' || fileUrl === '') throw new ValidationError(`${where} file requires fileUri`);
    return { type: 'input_file', file_url: fileUrl, ...(typeof media.displayName === 'string' ? { filename: media.displayName } : {}) };
  }
  if (typeof part.text === 'string') {
    return { type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text };
  }
  return undefined;
}

export function systemInstructionText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  const record = asRecord(value);
  const parts = record?.parts;
  if (Array.isArray(parts)) {
    return parts.map((value, index) => {
      const part = asRecord(value);
      if (!part || typeof part.text !== 'string' || part.thought === true) {
        throw new ValidationError(`systemInstruction.parts[${index}] must be ordinary text`);
      }
      return part.text;
    }).join('');
  }
  if (typeof record?.text === 'string') return record.text;
  throw new ValidationError('systemInstruction must be a string or a text part list');
}

interface LastCall {
  id: string;
  name: string;
}

export function functionResponseOutput(value: unknown): string {
  return typeof value === 'string' ? value : stringify(value ?? {});
}

function contentsToResponses(
  contents: unknown,
  options?: ConversionOptions,
): { input: Array<Record<string, unknown>>; instructions: string[] } {
  if (!Array.isArray(contents)) throw new ValidationError('generateContent contents must be an array');
  const input: Array<Record<string, unknown>> = [];
  const instructions: string[] = [];
  let lastCalls: LastCall[] = [];

  for (const [contentIndex, value] of contents.entries()) {
    const content = asRecord(value);
    if (!content) throw new ValidationError(`contents[${contentIndex}] must be an object`);
    const role = content.role === 'model' || content.role === 'assistant' ? 'assistant' : 'user';
    const parts = content.parts;
    if (!Array.isArray(parts)) throw new ValidationError(`contents[${contentIndex}].parts must be an array`);
    if (content.role === 'system' || content.role === 'developer') {
      instructions.push(systemInstructionText({ parts }));
      continue;
    }

    let messageParts: Array<Record<string, unknown>> = [];
    let contentCalls: LastCall[] = [];
    let responseIndex = 0;
    const flushMessage = (): void => {
      pushMessage(input, role, messageParts);
      messageParts = [];
    };

    for (const [partIndex, value] of parts.entries()) {
      const part = asRecord(value);
      if (!part) throw new ValidationError(`contents[${contentIndex}].parts[${partIndex}] must be an object`);
      const where = `contents[${contentIndex}].parts[${partIndex}]`;
      if (typeof part.thoughtSignature === 'string' && part.thoughtSignature !== '') {
        warn(options, `${where}.thoughtSignature is provider-specific and is not mapped to Responses reasoning.encrypted_content`);
      }

      const call = asRecord(part.functionCall ?? part.function_call);
      if (call) {
        flushMessage();
        if (typeof call.name !== 'string' || call.name === '') throw new ValidationError(`${where}.functionCall.name is required`);
        const id = typeof call.id === 'string' && call.id !== '' ? call.id : `call_${call.name}_${contentCalls.length}`;
        contentCalls.push({ id, name: call.name });
        input.push({ type: 'function_call', call_id: id, name: call.name, arguments: stringify(call.args ?? {}) });
        continue;
      }

      const result = asRecord(part.functionResponse ?? part.function_response);
      if (result) {
        flushMessage();
        if (typeof result.name !== 'string' || result.name === '') throw new ValidationError(`${where}.functionResponse.name is required`);
        const suppliedId = typeof result.id === 'string' && result.id !== '' ? result.id : undefined;
        const byId = suppliedId ? lastCalls.find(call => call.id === suppliedId) : undefined;
        if (suppliedId && !byId) {
          warn(options, `${where}.functionResponse id ${stringify(suppliedId)} matches no functionCall; pairing by position`);
        }
        const matched = byId ?? lastCalls[responseIndex] ?? lastCalls.find(call => call.name === result.name);
        const callId = matched?.id ?? suppliedId ?? `call_${result.name}_${responseIndex}`;
        responseIndex++;
        input.push({ type: 'function_call_output', call_id: callId, output: functionResponseOutput(result.response) });
        continue;
      }

      if (part.thought === true) {
        flushMessage();
        if (typeof part.text === 'string' && part.text !== '') {
          input.push({ type: 'reasoning', content: [{ type: 'reasoning_text', text: part.text }] });
        }
        continue;
      }

      const converted = contentPartToResponses(part, role, where, options);
      if (converted) {
        messageParts.push(converted);
      } else if (!asRecord(part.inlineData ?? part.inline_data) && !asRecord(part.fileData ?? part.file_data) && typeof part.text !== 'string') {
        throw new ValidationError(`${where} has no direct Responses input mapping`);
      }
    }
    flushMessage();
    if (contentCalls.length > 0) lastCalls = contentCalls;
    else if (parts.some(part => asRecord(part)?.functionResponse || asRecord(part)?.function_response)) lastCalls = [];
  }

  if (input.length === 0 && instructions.length === 0) throw new ValidationError('generateContent request produced no Responses input');
  return { input, instructions };
}

function responseTools(
  tools: unknown,
  options?: ConversionOptions,
): { tools: Array<Record<string, unknown>>; functionsByName: Map<string, Record<string, unknown>> } {
  const converted: Array<Record<string, unknown>> = [];
  const functionsByName = new Map<string, Record<string, unknown>>();
  for (const [index, value] of (Array.isArray(tools) ? tools : []).entries()) {
    const tool = asRecord(value);
    if (!tool) throw new ValidationError(`tools[${index}] must be an object`);
    const declarations = tool.functionDeclarations ?? tool.function_declarations;
    if (Array.isArray(declarations)) {
      for (const [declarationIndex, value] of declarations.entries()) {
        const declaration = asRecord(value);
        if (!declaration || typeof declaration.name !== 'string' || declaration.name === '') {
          throw new ValidationError(`tools[${index}].functionDeclarations[${declarationIndex}] requires a name`);
        }
        const fn = {
          type: 'function',
          name: declaration.name,
          ...(declaration.description !== undefined ? { description: declaration.description } : {}),
          parameters: normalizeGeminiSchema(declaration.parametersJsonSchema ?? declaration.parameters_json_schema ?? declaration.parameters ?? { type: 'object', properties: {} }),
        };
        converted.push(fn);
        functionsByName.set(declaration.name, fn);
      }
      continue;
    }
    if (tool.googleSearch !== undefined || tool.google_search !== undefined || tool.type === 'google_search') {
      converted.push({ type: 'web_search' });
      const config = asRecord(tool.googleSearch ?? tool.google_search);
      if (config && Object.keys(config).length > 0) warn(options, `tools[${index}].googleSearch options have no Responses web_search equivalent; dropped`);
    } else if (tool.codeExecution !== undefined || tool.code_execution !== undefined || tool.type === 'code_execution') {
      converted.push({ type: 'code_interpreter', container: { type: 'auto' } });
    } else {
      warn(options, `tools[${index}] type ${stringify(tool.type ?? Object.keys(tool))} has no faithful Responses tool mapping; dropped`);
    }
  }
  return { tools: converted, functionsByName };
}

function responseToolChoice(
  request: Record<string, unknown>,
  config: Record<string, unknown>,
  functionsByName: Map<string, Record<string, unknown>>,
): unknown {
  const toolConfig = asRecord(request.toolConfig ?? request.tool_config);
  const choice = asRecord(toolConfig?.functionCallingConfig ?? toolConfig?.function_calling_config)
    ?? asRecord(config.toolChoice ?? config.tool_choice);
  const rawChoice = choice ?? config.toolChoice ?? config.tool_choice;
  if (rawChoice === undefined) return undefined;
  const rawMode = typeof rawChoice === 'string' ? rawChoice : asRecord(rawChoice)?.mode ?? asRecord(rawChoice)?.type;
  const mode = typeof rawMode === 'string' ? rawMode.toLowerCase() : 'auto';
  const namesValue = asRecord(rawChoice)?.allowedFunctionNames ?? asRecord(rawChoice)?.allowed_function_names ?? asRecord(rawChoice)?.tools;
  const names = Array.isArray(namesValue) ? namesValue.filter((name): name is string => typeof name === 'string' && name !== '') : [];
  if (mode === 'none') return 'none';
  if (names.length > 0) {
    for (const name of names) {
      if (!functionsByName.has(name)) throw new ValidationError(`toolConfig names undeclared function ${stringify(name)}`);
    }
    return {
      type: 'allowed_tools',
      mode: mode === 'any' || mode === 'validated' ? 'required' : 'auto',
      tools: names.map(name => ({ type: 'function', name })),
    };
  }
  if (mode === 'any' || mode === 'validated') return 'required';
  if (mode === 'auto' || mode === 'dynamic') return 'auto';
  throw new ValidationError(`generateContent tool choice ${stringify(rawChoice)} has no Responses equivalent`);
}

export function geminiToResponsesBody(
  request: Record<string, unknown>,
  model: string,
  options?: ConversionOptions,
): Record<string, unknown> {
  const { input, instructions } = contentsToResponses(request.contents, options);
  const declaredSystem = request.systemInstruction ?? request.system_instruction;
  const system = systemInstructionText(declaredSystem);
  if (system !== '') instructions.unshift(system);

  const config = asRecord(request.generationConfig ?? request.generation_config) ?? {};
  const body: Record<string, unknown> = {
    model,
    input,
    ...(instructions.length > 0 ? { instructions: instructions.join('\n') } : {}),
    stream: request.stream === true || config.stream === true,
  };
  if (typeof config.temperature === 'number') body.temperature = config.temperature;
  if (typeof config.topP === 'number' || typeof config.top_p === 'number') body.top_p = config.topP ?? config.top_p;
  const maxOutputTokens = config.maxOutputTokens ?? config.max_output_tokens;
  if (typeof maxOutputTokens === 'number') body.max_output_tokens = maxOutputTokens;
  if (request.labels !== undefined) body.metadata = request.labels;

  const thinking = asRecord(config.thinkingConfig ?? config.thinking_config);
  const reasoning: Record<string, unknown> = {};
  const level = thinking?.thinkingLevel ?? thinking?.thinking_level ?? config.thinkingLevel ?? config.thinking_level;
  if (typeof level === 'string') reasoning.effort = level;
  if (thinking?.includeThoughts === true || thinking?.include_thoughts === true || config.thinkingSummaries === 'auto' || config.thinking_summaries === 'auto') {
    reasoning.summary = 'auto';
  }
  if (Object.keys(reasoning).length > 0) body.reasoning = reasoning;

  const { tools, functionsByName } = responseTools(request.tools, options);
  if (tools.length > 0) body.tools = tools;
  const toolChoice = responseToolChoice(request, config, functionsByName);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;

  const schema = config.responseJsonSchema ?? config.response_json_schema ?? config.responseSchema ?? config.response_schema ?? request.response_format;
  const mime = config.responseMimeType ?? config.response_mime_type ?? request.response_mime_type;
  if (schema !== undefined) {
    if (!asRecord(schema)) throw new ValidationError('generateContent response schema must be an object');
    body.text = { format: { type: 'json_schema', name: 'response', schema: normalizeGeminiSchema(schema) } };
  } else if (mime === 'application/json') {
    body.text = { format: { type: 'json_object' } };
  } else if (mime === 'text/plain') {
    body.text = { format: { type: 'text' } };
  }

  const unsupported: Array<[string, unknown]> = [
    ['cachedContent', request.cachedContent ?? request.cached_content],
    ['safetySettings', request.safetySettings ?? request.safety_settings],
    ['generationConfig.stopSequences', config.stopSequences ?? config.stop_sequences],
    ['generationConfig.seed', config.seed],
    ['generationConfig.topK', config.topK ?? config.top_k],
    ['generationConfig.candidateCount', config.candidateCount ?? config.candidate_count],
    ['generationConfig.responseModalities', config.responseModalities ?? config.response_modalities],
    ['generationConfig.speechConfig', config.speechConfig ?? config.speech_config],
    ['generationConfig.thinkingConfig.thinkingBudget', thinking?.thinkingBudget ?? thinking?.thinking_budget],
  ];
  for (const [field, value] of unsupported) {
    if (value !== undefined) warn(options, `${field} has no faithful Responses equivalent; dropped`);
  }
  return body;
}

interface GeminiResponsesOptions extends ConversionOptions {
  allowedTools?: Set<string> | null;
  namespaceMap?: NamespaceMap;
}

function geminiUsageToResponses(value: unknown): Record<string, unknown> | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const input = typeof usage.promptTokenCount === 'number' ? usage.promptTokenCount : 0;
  const candidates = typeof usage.candidatesTokenCount === 'number' ? usage.candidatesTokenCount : 0;
  const reasoning = typeof usage.thoughtsTokenCount === 'number' ? usage.thoughtsTokenCount : 0;
  const cached = typeof usage.cachedContentTokenCount === 'number' ? usage.cachedContentTokenCount : 0;
  const output = candidates + reasoning;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: typeof usage.totalTokenCount === 'number' ? usage.totalTokenCount : input + output,
    input_tokens_details: { cached_tokens: cached },
    ...(reasoning > 0 ? { output_tokens_details: { reasoning_tokens: reasoning } } : {}),
  };
}

function restoreToolName(name: string, namespaceMap?: NamespaceMap): { name: string; namespace?: string } {
  return namespaceMap?.get(name) ?? { name };
}

function responseTerminal(gemini: Record<string, unknown>, candidate?: Record<string, unknown>): { status: string; reason?: string } {
  const finish = candidate?.finishReason;
  const blocked = blockedPromptReason(gemini.promptFeedback) !== undefined
    || typeof finish === 'string' && BLOCKING_FINISH_REASONS.has(finish);
  if (blocked) return { status: 'incomplete', reason: 'content_filter' };
  if (finish === 'MAX_TOKENS') return { status: 'incomplete', reason: 'max_output_tokens' };
  return { status: 'completed' };
}

function newItemId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function geminiToResponsesResponse(
  gemini: Record<string, unknown>,
  model: string,
  requestId: string,
  options?: GeminiResponsesOptions,
): Record<string, unknown> {
  const candidates = Array.isArray(gemini.candidates) ? gemini.candidates.map(asRecord).filter(Boolean) : [];
  const candidate = candidates[0];
  if (candidates.length > 1) warn(options, `${candidates.length - 1} additional candidate(s) have no Responses output position; dropped`);
  const terminal = responseTerminal(gemini, candidate);
  const output: Array<Record<string, unknown>> = [];
  const parts = Array.isArray(asRecord(candidate?.content)?.parts) ? asRecord(candidate?.content)?.parts as unknown[] : [];
  let suppressed = 0;

  for (const [index, value] of parts.entries()) {
    const part = asRecord(value);
    if (!part) {
      warn(options, `candidate part ${index} is not an object; dropped`);
      continue;
    }
    const call = asRecord(part.functionCall ?? part.function_call);
    if (call) {
      if (typeof call.name !== 'string' || call.name === '') {
        warn(options, `candidate functionCall ${index} has no name; dropped`);
        continue;
      }
      const restored = restoreToolName(call.name, options?.namespaceMap);
      if (options?.allowedTools != null && !options.allowedTools.has(restored.name)) {
        suppressed++;
        continue;
      }
      const id = typeof call.id === 'string' && call.id !== '' ? call.id : `call_${index}`;
      output.push({
        id, type: 'function_call', status: 'completed', name: restored.name,
        ...(restored.namespace ? { namespace: restored.namespace } : {}),
        arguments: stringify(call.args ?? {}), call_id: id,
      });
      continue;
    }
    if (typeof part.text === 'string') {
      if (part.thought === true) {
        output.push({ id: newItemId('reasoning'), type: 'reasoning', status: 'completed', summary: [{ type: 'summary_text', text: part.text }] });
        if (part.thoughtSignature !== undefined) warn(options, 'thoughtSignature is provider-specific and is not mapped to Responses reasoning.encrypted_content');
      } else {
        output.push({
          id: newItemId('msg'), type: 'message', status: terminal.status === 'incomplete' ? 'incomplete' : 'completed',
          role: 'assistant', content: [{ type: 'output_text', text: part.text, annotations: [] }],
        });
      }
      continue;
    }
    const kind = part.inlineData || part.inline_data ? 'inline_data'
      : part.executableCode ? 'executableCode'
        : part.codeExecutionResult ? 'codeExecutionResult'
          : part.fileData || part.file_data ? 'file_data' : Object.keys(part).join('+') || '(empty)';
    warn(options, `candidate part type ${kind} has no Responses output projection; dropped`);
  }
  if (suppressed > 0) options?.logger?.warn(options.requestId ?? requestId, `[responses] suppressed ${suppressed} tool call(s) outside allowed_tools`);
  if (output.length === 0) {
    output.push({
      id: newItemId('msg'), type: 'message', status: terminal.status === 'incomplete' ? 'incomplete' : 'completed',
      role: 'assistant', content: [{ type: 'output_text', text: '', annotations: [] }],
    });
  }
  const outputText = output.filter(item => item.type === 'message')
    .flatMap(item => Array.isArray(item.content) ? item.content : [])
    .map(asRecord).filter(part => part?.type === 'output_text' && typeof part.text === 'string')
    .map(part => part!.text as string).join('');
  return {
    id: `resp_${crypto.randomUUID().replace(/-/g, '')}`,
    object: 'response', created_at: Math.floor(Date.now() / 1000),
    status: terminal.status,
    ...(terminal.reason ? { incomplete_details: { reason: terminal.reason } } : {}),
    model: typeof gemini.modelVersion === 'string' ? gemini.modelVersion : model,
    output_text: outputText,
    output,
    usage: geminiUsageToResponses(gemini.usageMetadata),
  };
}

interface ActiveGeminiResponsesItem {
  kind: 'message' | 'reasoning';
  id: string;
  outputIndex: number;
  text: string;
  item: Record<string, unknown>;
}

export interface GeminiResponsesStreamState {
  id: string;
  createdAt: number;
  model: string;
  sequence: number;
  nextOutputIndex: number;
  output: Array<Record<string, unknown>>;
  active?: ActiveGeminiResponsesItem;
  usage?: Record<string, unknown>;
  finished: boolean;
  suppressed: number;
}

export function createGeminiResponsesStreamState(model: string): GeminiResponsesStreamState {
  return {
    id: `resp_${crypto.randomUUID().replace(/-/g, '')}`,
    createdAt: Math.floor(Date.now() / 1000), model,
    sequence: 0, nextOutputIndex: 0, output: [], finished: false, suppressed: 0,
  };
}

export function geminiResponsesCreatedEvent(state: GeminiResponsesStreamState): Record<string, unknown> {
  return {
    type: 'response.created', sequence_number: state.sequence++,
    response: { id: state.id, object: 'response', created_at: state.createdAt, status: 'in_progress', model: state.model, output: [] },
  };
}

function streamEvent(state: GeminiResponsesStreamState, events: Array<Record<string, unknown>>, type: string, fields: Record<string, unknown>): void {
  events.push({ type, sequence_number: state.sequence++, ...fields });
}

function closeActiveStreamItem(state: GeminiResponsesStreamState, events: Array<Record<string, unknown>>, incomplete: boolean): void {
  const active = state.active;
  if (!active) return;
  if (active.kind === 'message') {
    streamEvent(state, events, 'response.output_text.done', {
      item_id: active.id, output_index: active.outputIndex, content_index: 0, text: active.text, logprobs: [],
    });
    streamEvent(state, events, 'response.content_part.done', {
      item_id: active.id, output_index: active.outputIndex, content_index: 0,
      part: { type: 'output_text', text: active.text, annotations: [] },
    });
  } else {
    streamEvent(state, events, 'response.reasoning_summary_text.done', {
      item_id: active.id, output_index: active.outputIndex, summary_index: 0, text: active.text,
    });
    streamEvent(state, events, 'response.reasoning_summary_part.done', {
      item_id: active.id, output_index: active.outputIndex, summary_index: 0,
      part: { type: 'summary_text', text: active.text },
    });
  }
  active.item.status = incomplete ? 'incomplete' : 'completed';
  streamEvent(state, events, 'response.output_item.done', { output_index: active.outputIndex, item: active.item });
  state.active = undefined;
}

function openActiveStreamItem(
  state: GeminiResponsesStreamState,
  events: Array<Record<string, unknown>>,
  kind: 'message' | 'reasoning',
): ActiveGeminiResponsesItem {
  closeActiveStreamItem(state, events, false);
  const id = newItemId(kind === 'message' ? 'msg' : 'reasoning');
  const outputIndex = state.nextOutputIndex++;
  const item: Record<string, unknown> = kind === 'message'
    ? { id, type: 'message', status: 'in_progress', role: 'assistant', content: [] }
    : { id, type: 'reasoning', status: 'in_progress', summary: [] };
  const active: ActiveGeminiResponsesItem = { kind, id, outputIndex, text: '', item };
  state.active = active;
  state.output.push(item);
  streamEvent(state, events, 'response.output_item.added', { output_index: outputIndex, item });
  if (kind === 'message') {
    streamEvent(state, events, 'response.content_part.added', {
      item_id: id, output_index: outputIndex, content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  } else {
    streamEvent(state, events, 'response.reasoning_summary_part.added', {
      item_id: id, output_index: outputIndex, summary_index: 0, part: { type: 'summary_text', text: '' },
    });
  }
  return active;
}

function fallbackStreamMessage(state: GeminiResponsesStreamState, events: Array<Record<string, unknown>>, incomplete: boolean): void {
  const active = openActiveStreamItem(state, events, 'message');
  active.item.content = [{ type: 'output_text', text: '', annotations: [] }];
  closeActiveStreamItem(state, events, incomplete);
}

export function geminiChunkToResponsesEvents(
  state: GeminiResponsesStreamState,
  chunk: Record<string, unknown>,
  options?: GeminiResponsesOptions,
): Array<Record<string, unknown>> {
  if (state.finished) return [];
  const events: Array<Record<string, unknown>> = [];
  const candidates = Array.isArray(chunk.candidates) ? chunk.candidates.map(asRecord).filter(Boolean) : [];
  const candidate = candidates[0];
  if (candidates.length > 1) warn(options, `${candidates.length - 1} additional streamed candidate(s) have no Responses output position; dropped`);
  const parts = Array.isArray(asRecord(candidate?.content)?.parts) ? asRecord(candidate?.content)?.parts as unknown[] : [];
  for (const [index, value] of parts.entries()) {
    const part = asRecord(value);
    if (!part) continue;
    const call = asRecord(part.functionCall ?? part.function_call);
    if (call) {
      closeActiveStreamItem(state, events, false);
      if (typeof call.name !== 'string' || call.name === '') {
        warn(options, `streamed functionCall ${index} has no name; dropped`);
        continue;
      }
      const restored = restoreToolName(call.name, options?.namespaceMap);
      if (options?.allowedTools != null && !options.allowedTools.has(restored.name)) {
        state.suppressed++;
        continue;
      }
      const id = typeof call.id === 'string' && call.id !== '' ? call.id : `call_${state.nextOutputIndex}`;
      const outputIndex = state.nextOutputIndex++;
      const args = stringify(call.args ?? {});
      const item: Record<string, unknown> = {
        id, type: 'function_call', status: 'completed', name: restored.name,
        ...(restored.namespace ? { namespace: restored.namespace } : {}), arguments: args, call_id: id,
      };
      state.output.push(item);
      streamEvent(state, events, 'response.output_item.added', {
        output_index: outputIndex,
        item: { ...item, status: 'in_progress', arguments: '' },
      });
      streamEvent(state, events, 'response.function_call_arguments.delta', { item_id: id, output_index: outputIndex, delta: args });
      streamEvent(state, events, 'response.function_call_arguments.done', { item_id: id, output_index: outputIndex, arguments: args });
      streamEvent(state, events, 'response.output_item.done', { output_index: outputIndex, item });
      continue;
    }
    if (typeof part.text === 'string' && part.text !== '') {
      const kind = part.thought === true ? 'reasoning' : 'message';
      const active = state.active?.kind === kind ? state.active : openActiveStreamItem(state, events, kind);
      active.text += part.text;
      if (kind === 'message') {
        active.item.content = [{ type: 'output_text', text: active.text, annotations: [] }];
        streamEvent(state, events, 'response.output_text.delta', {
          item_id: active.id, output_index: active.outputIndex, content_index: 0, delta: part.text, logprobs: [],
        });
      } else {
        active.item.summary = [{ type: 'summary_text', text: active.text }];
        streamEvent(state, events, 'response.reasoning_summary_text.delta', {
          item_id: active.id, output_index: active.outputIndex, summary_index: 0, delta: part.text,
        });
        if (part.thoughtSignature !== undefined) warn(options, 'streamed thoughtSignature is provider-specific and is not mapped to Responses reasoning.encrypted_content');
      }
      continue;
    }
    if (typeof part.text !== 'string') {
      const kind = part.inlineData || part.inline_data ? 'inline_data'
        : part.executableCode ? 'executableCode'
          : part.codeExecutionResult ? 'codeExecutionResult'
            : part.fileData || part.file_data ? 'file_data' : Object.keys(part).join('+') || '(empty)';
      warn(options, `streamed candidate part type ${kind} has no Responses output projection; dropped`);
    }
  }

  const usage = geminiUsageToResponses(chunk.usageMetadata);
  if (usage) state.usage = usage;
  const terminal = responseTerminal(chunk, candidate);
  const blocked = blockedPromptReason(chunk.promptFeedback) !== undefined;
  if (candidate?.finishReason !== undefined || blocked) {
    const incomplete = terminal.status === 'incomplete';
    closeActiveStreamItem(state, events, incomplete);
    if (state.output.length === 0) fallbackStreamMessage(state, events, incomplete);
    if (state.suppressed > 0) options?.logger?.warn(options.requestId ?? '', `[responses] suppressed ${state.suppressed} tool call(s) outside allowed_tools`);
    const type = incomplete ? 'response.incomplete' : 'response.completed';
    streamEvent(state, events, type, {
      response: {
        id: state.id, object: 'response', created_at: state.createdAt, status: terminal.status, model: state.model,
        output: state.output, ...(state.usage ? { usage: state.usage } : {}),
        ...(terminal.reason ? { incomplete_details: { reason: terminal.reason } } : {}),
      },
    });
    state.finished = true;
  }
  return events;
}

export function geminiResponsesFailedEvent(state: GeminiResponsesStreamState, message: string): Record<string, unknown> {
  return {
    type: 'response.failed', sequence_number: state.sequence++,
    response: {
      id: state.id, object: 'response', created_at: state.createdAt, status: 'failed', model: state.model,
      output: state.output, error: { code: 'server_error', message },
    },
  };
}
