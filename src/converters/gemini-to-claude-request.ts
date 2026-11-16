import type { Logger } from '../types/shared.js';
import { isBlobRef, rebindBlobRef } from '../utils/blob-refs.js';
import { ValidationError } from '../utils/errors.js';
import { fetchImageAsInlineData } from '../utils/image-fetch.js';
import { stringify } from '../utils/stringify.js';
import { normalizeEffort, recursivelyCleanSchema } from './claude-to-openai.js';
import { normalizeGeminiSchema } from './gemini-to-openai.js';
import { functionResponseOutput, systemInstructionText } from './gemini-to-responses.js';

interface ConversionOptions {
  logger?: Logger;
  requestId?: string;
}

interface LastCall {
  id: string;
  name: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function warn(options: ConversionOptions | undefined, message: string): void {
  options?.logger?.warn(options.requestId ?? '', `[gemini->claude] ${message}`);
}

function appendMessage(
  messages: Array<Record<string, unknown>>,
  role: 'user' | 'assistant',
  blocks: Array<Record<string, unknown>>,
): void {
  if (blocks.length === 0) return;
  const previous = messages.at(-1);
  if (previous?.role === role) {
    if (typeof previous.content === 'string' && blocks.every(block => block.type === 'text')) {
      previous.content = previous.content + blocks.map(block => block.text as string).join('');
    } else if (Array.isArray(previous.content)) {
      previous.content.push(...blocks);
    } else {
      previous.content = [{ type: 'text', text: previous.content }, ...blocks];
    }
    return;
  }
  messages.push({
    role,
    content: blocks.every(block => block.type === 'text')
      ? blocks.map(block => block.text as string).join('')
      : blocks,
  });
}

async function mediaBlock(
  part: Record<string, unknown>,
  role: 'user' | 'assistant',
  where: string,
  options?: ConversionOptions,
): Promise<Record<string, unknown> | undefined> {
  const inline = asRecord(part.inlineData ?? part.inline_data);
  const file = asRecord(part.fileData ?? part.file_data);
  const media = inline ?? file;
  if (!media) return undefined;
  const mimeValue = media.mimeType ?? media.mime_type;
  const mime = typeof mimeValue === 'string' && mimeValue !== '' ? mimeValue : 'application/octet-stream';
  if (mime.startsWith('audio/') || mime.startsWith('video/')) {
    warn(options, `${where} media ${mime} has no Claude Messages content block; dropped`);
    return undefined;
  }
  if (role === 'assistant') {
    warn(options, `${where} media has no Claude assistant-history content block; dropped`);
    return undefined;
  }

  let data: unknown = media.data;
  let resolvedMime = mime;
  if (!inline) {
    const uri = media.fileUri ?? media.file_uri;
    if (typeof uri !== 'string' || uri === '') throw new ValidationError(`${where} requires fileUri`);
    if (!/^https?:\/\//.test(uri)) {
      throw new ValidationError(`${where} fileUri ${stringify(uri)} cannot be fetched as Claude source data`);
    }
    const fetched = await fetchImageAsInlineData(uri);
    data = fetched.data;
    resolvedMime = fetched.mime_type;
  }
  if (typeof data !== 'string' && !isBlobRef(data)) throw new ValidationError(`${where} requires base64 data`);
  if (typeof data === 'string' && data === '') throw new ValidationError(`${where} requires non-empty base64 data`);
  const source = {
    type: 'base64', media_type: resolvedMime,
    data: isBlobRef(data) ? rebindBlobRef(data, 'claude-source-data', '') : data,
  };
  if (resolvedMime.startsWith('image/')) return { type: 'image', source };
  return {
    type: 'document', source,
    ...(typeof media.displayName === 'string' && media.displayName !== '' ? { title: media.displayName } : {}),
  };
}

async function contentsToClaude(
  contents: unknown,
  options?: ConversionOptions,
): Promise<{ messages: Array<Record<string, unknown>>; system: string[] }> {
  if (!Array.isArray(contents)) throw new ValidationError('generateContent contents must be an array');
  const messages: Array<Record<string, unknown>> = [];
  const system: string[] = [];
  let lastCalls: LastCall[] = [];

  for (const [contentIndex, value] of contents.entries()) {
    const content = asRecord(value);
    if (!content) throw new ValidationError(`contents[${contentIndex}] must be an object`);
    const parts = content.parts;
    if (!Array.isArray(parts)) throw new ValidationError(`contents[${contentIndex}].parts must be an array`);
    if (content.role === 'system' || content.role === 'developer') {
      system.push(systemInstructionText({ parts }));
      continue;
    }
    const role = content.role === 'model' || content.role === 'assistant' ? 'assistant' : 'user';
    const blocks: Array<Record<string, unknown>> = [];
    const contentCalls: LastCall[] = [];
    let responseIndex = 0;

    for (const [partIndex, value] of parts.entries()) {
      const part = asRecord(value);
      if (!part) throw new ValidationError(`contents[${contentIndex}].parts[${partIndex}] must be an object`);
      const where = `contents[${contentIndex}].parts[${partIndex}]`;
      const call = asRecord(part.functionCall ?? part.function_call);
      if (call) {
        if (typeof call.name !== 'string' || call.name === '') throw new ValidationError(`${where}.functionCall.name is required`);
        const id = typeof call.id === 'string' && call.id !== '' ? call.id : `call_${call.name}_${contentCalls.length}`;
        contentCalls.push({ id, name: call.name });
        blocks.push({ type: 'tool_use', id, name: call.name, input: call.args ?? {} });
        if (typeof part.thoughtSignature === 'string' && part.thoughtSignature !== '') {
          const thinking = blocks.filter(block => block.type === 'thinking').at(-1);
          if (thinking && thinking.signature === undefined) thinking.signature = part.thoughtSignature;
          else if (!thinking) blocks.unshift({ type: 'thinking', thinking: '', signature: part.thoughtSignature });
          else warn(options, `${where}.thoughtSignature could not be attached to its thinking block; dropped`);
        }
        continue;
      }
      const result = asRecord(part.functionResponse ?? part.function_response);
      if (result) {
        if (typeof result.name !== 'string' || result.name === '') throw new ValidationError(`${where}.functionResponse.name is required`);
        const suppliedId = typeof result.id === 'string' && result.id !== '' ? result.id : undefined;
        const byId = suppliedId ? lastCalls.find(call => call.id === suppliedId) : undefined;
        if (suppliedId && !byId) warn(options, `${where}.functionResponse id ${stringify(suppliedId)} matches no functionCall; pairing by position`);
        const matched = byId ?? lastCalls[responseIndex] ?? lastCalls.find(call => call.name === result.name);
        const id = matched?.id ?? suppliedId ?? `call_${result.name}_${responseIndex}`;
        responseIndex++;
        blocks.push({ type: 'tool_result', tool_use_id: id, content: functionResponseOutput(result.response) });
        continue;
      }
      if (part.thought === true) {
        const text = typeof part.text === 'string' ? part.text : '';
        const signature = typeof part.thoughtSignature === 'string' && part.thoughtSignature !== '' ? part.thoughtSignature : undefined;
        if (text !== '') blocks.push({ type: 'thinking', thinking: text, ...(signature ? { signature } : {}) });
        else if (signature) warn(options, `${where}.thoughtSignature has no thought text; dropped because Claude thinking blocks require text`);
        continue;
      }
      if (typeof part.text === 'string') {
        if (part.text !== '') blocks.push({ type: 'text', text: part.text });
        if (typeof part.thoughtSignature === 'string' && part.thoughtSignature !== '') {
          const thinking = blocks.filter(block => block.type === 'thinking').at(-1);
          if (thinking && thinking.signature === undefined) thinking.signature = part.thoughtSignature;
          else if (!thinking) blocks.unshift({ type: 'thinking', thinking: '', signature: part.thoughtSignature });
          else warn(options, `${where}.thoughtSignature could not be attached to its thinking block; dropped`);
        }
        continue;
      }
      const block = await mediaBlock(part, role, where, options);
      if (block) blocks.push(block);
      else if (!asRecord(part.inlineData ?? part.inline_data) && !asRecord(part.fileData ?? part.file_data)) {
        throw new ValidationError(`${where} has no direct Claude input mapping`);
      }
    }

    appendMessage(messages, role, blocks);
    if (contentCalls.length > 0) lastCalls = contentCalls;
    else if (responseIndex > 0) lastCalls = [];
  }

  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    const blocks = message.content as Array<Record<string, unknown>>;
    if (blocks.some(block => block.type === 'tool_use') && !blocks.some(block => block.type === 'thinking')) {
      blocks.unshift({ type: 'thinking', thinking: '' });
    }
  }
  if (messages.length === 0) throw new ValidationError('generateContent request produced no Claude messages');
  return { messages, system };
}

function claudeTools(
  value: unknown,
  options?: ConversionOptions,
): { tools: Array<Record<string, unknown>>; functionNames: Set<string> } {
  const tools: Array<Record<string, unknown>> = [];
  const functionNames = new Set<string>();
  for (const [index, entry] of (Array.isArray(value) ? value : []).entries()) {
    const tool = asRecord(entry);
    if (!tool) throw new ValidationError(`tools[${index}] must be an object`);
    const declarations = tool.functionDeclarations ?? tool.function_declarations;
    if (Array.isArray(declarations)) {
      for (const [declarationIndex, value] of declarations.entries()) {
        const declaration = asRecord(value);
        if (!declaration || typeof declaration.name !== 'string' || declaration.name === '') {
          throw new ValidationError(`tools[${index}].functionDeclarations[${declarationIndex}] requires a name`);
        }
        functionNames.add(declaration.name);
        tools.push({
          name: declaration.name,
          ...(declaration.description !== undefined ? { description: declaration.description } : {}),
          input_schema: recursivelyCleanSchema(normalizeGeminiSchema(
            declaration.parametersJsonSchema ?? declaration.parameters_json_schema ?? declaration.parameters ?? { type: 'object', properties: {} },
          )),
        });
      }
    } else if (tool.googleSearch !== undefined || tool.google_search !== undefined || tool.type === 'google_search') {
      tools.push({ type: 'web_search_20250305', name: 'web_search' });
      const config = asRecord(tool.googleSearch ?? tool.google_search);
      if (config && Object.keys(config).length > 0) warn(options, `tools[${index}].googleSearch options have no Claude web_search equivalent; dropped`);
    } else if (tool.codeExecution !== undefined || tool.code_execution !== undefined || tool.type === 'code_execution') {
      tools.push({ type: 'code_execution_20250522', name: 'code_execution' });
    } else {
      warn(options, `tools[${index}] type ${stringify(tool.type ?? Object.keys(tool))} has no faithful Claude tool mapping; dropped`);
    }
  }
  return { tools, functionNames };
}

function functionCallingConfig(request: Record<string, unknown>): Record<string, unknown> | undefined {
  const config = asRecord(request.generationConfig ?? request.generation_config);
  const toolConfig = asRecord(request.toolConfig ?? request.tool_config);
  return asRecord(toolConfig?.functionCallingConfig ?? toolConfig?.function_calling_config)
    ?? asRecord(config?.toolChoice ?? config?.tool_choice);
}

export function extractGeminiAllowedTools(request: Record<string, unknown>): Set<string> | null {
  const choice = functionCallingConfig(request);
  const value = choice?.allowedFunctionNames ?? choice?.allowed_function_names ?? choice?.tools;
  if (!Array.isArray(value)) return null;
  const names = value.filter((name): name is string => typeof name === 'string' && name !== '');
  return names.length > 0 ? new Set(names) : null;
}

function claudeToolChoice(request: Record<string, unknown>, functionNames: Set<string>): Record<string, unknown> | undefined {
  const config = functionCallingConfig(request);
  if (!config || functionNames.size === 0) return undefined;
  const modeValue = config.mode ?? config.type;
  const mode = typeof modeValue === 'string' ? modeValue.toLowerCase() : 'auto';
  const allowed = extractGeminiAllowedTools(request);
  if (allowed) {
    for (const name of allowed) {
      if (!functionNames.has(name)) throw new ValidationError(`toolConfig names undeclared function ${stringify(name)}`);
    }
  }
  if (mode === 'none') return { type: 'none' };
  if (allowed?.size === 1 && (mode === 'any' || mode === 'validated')) return { type: 'tool', name: allowed.values().next().value };
  if (mode === 'any' || mode === 'validated') return { type: 'any' };
  if (mode === 'auto' || mode === 'dynamic') return { type: 'auto' };
  throw new ValidationError(`generateContent tool choice ${stringify(config)} has no Claude equivalent`);
}

export async function geminiToClaudeBody(
  request: Record<string, unknown>,
  model: string,
  options?: ConversionOptions,
): Promise<Record<string, unknown>> {
  const { messages, system } = await contentsToClaude(request.contents, options);
  const declaredSystem = systemInstructionText(request.systemInstruction ?? request.system_instruction);
  if (declaredSystem !== '') system.unshift(declaredSystem);
  const config = asRecord(request.generationConfig ?? request.generation_config) ?? {};
  const { tools, functionNames } = claudeTools(request.tools, options);
  const maxTokens = config.maxOutputTokens ?? config.max_output_tokens;
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: typeof maxTokens === 'number' ? maxTokens : 4096,
    stream: request.stream === true || config.stream === true,
    ...(system.length > 0 ? { system: system.join('\n') } : {}),
    ...(tools.length > 0 ? { tools } : {}),
  };
  const toolChoice = claudeToolChoice(request, functionNames);
  if (toolChoice) body.tool_choice = toolChoice;
  if (typeof config.temperature === 'number') body.temperature = config.temperature;
  const topP = config.topP ?? config.top_p;
  const topK = config.topK ?? config.top_k;
  if (typeof topP === 'number') body.top_p = topP;
  if (typeof topK === 'number') body.top_k = topK;
  const stop = config.stopSequences ?? config.stop_sequences;
  if (Array.isArray(stop) && stop.length > 0) body.stop_sequences = stop;
  else if (typeof stop === 'string' && stop !== '') body.stop_sequences = [stop];

  const outputConfig: Record<string, unknown> = {};
  const thinking = asRecord(config.thinkingConfig ?? config.thinking_config);
  const level = thinking?.thinkingLevel ?? thinking?.thinking_level ?? config.thinkingLevel ?? config.thinking_level;
  const effort = normalizeEffort(typeof level === 'string' ? level : undefined);
  if (effort) outputConfig.effort = effort;
  const schema = config.responseJsonSchema ?? config.response_json_schema ?? config.responseSchema ?? config.response_schema ?? request.response_format;
  const mime = config.responseMimeType ?? config.response_mime_type ?? request.response_mime_type;
  if (schema !== undefined) {
    if (!asRecord(schema)) throw new ValidationError('generateContent response schema must be an object');
    outputConfig.format = { type: 'json_schema', schema: recursivelyCleanSchema(normalizeGeminiSchema(schema)) };
  } else if (mime === 'application/json') {
    outputConfig.format = { type: 'json_schema', schema: { type: 'object' } };
  }
  if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;

  const includeThoughts = thinking?.includeThoughts ?? thinking?.include_thoughts;
  const budget = thinking?.thinkingBudget ?? thinking?.thinking_budget;
  if (includeThoughts === true || typeof budget === 'number' && budget > 0) {
    body.thinking = { type: 'enabled', ...(typeof budget === 'number' && budget > 0 ? { budget_tokens: budget } : {}) };
  } else if (includeThoughts === false) {
    body.thinking = { type: 'disabled' };
  }

  const unsupported: Array<[string, unknown]> = [
    ['cachedContent', request.cachedContent ?? request.cached_content],
    ['safetySettings', request.safetySettings ?? request.safety_settings],
    ['labels', request.labels],
    ['generationConfig.seed', config.seed],
    ['generationConfig.candidateCount', config.candidateCount ?? config.candidate_count],
    ['generationConfig.responseModalities', config.responseModalities ?? config.response_modalities],
    ['generationConfig.speechConfig', config.speechConfig ?? config.speech_config],
  ];
  for (const [field, value] of unsupported) {
    if (value !== undefined) warn(options, `${field} has no faithful Claude Messages equivalent; dropped`);
  }
  return body;
}
