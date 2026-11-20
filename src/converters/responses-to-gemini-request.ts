import type { Logger } from '../types/shared.js';
import { isBlobRef } from '../utils/blob-refs.js';
import { ValidationError } from '../utils/errors.js';
import { fetchImageAsInlineData } from '../utils/image-fetch.js';
import { stringify } from '../utils/stringify.js';
import { decodeDataUriOrRef } from './claude-to-gemini.js';
import { recursivelyCleanSchema } from './claude-to-openai.js';
import { parseToolArguments } from './openai-to-gemini.js';
import {
  flattenNamespaces,
  NAMESPACE_MAP_KEY,
  NAMESPACE_SEPARATOR,
  type NamespaceMap,
} from './responses-to-completions.js';

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
  options?.logger?.warn(options.requestId ?? '', `[responses->gemini] ${message}`);
}

function appendContent(
  contents: Array<Record<string, unknown>>,
  role: 'user' | 'model',
  parts: Array<Record<string, unknown>>,
): void {
  if (parts.length === 0) return;
  const previous = contents.at(-1);
  if (previous?.role === role && Array.isArray(previous.parts)) previous.parts.push(...parts);
  else contents.push({ role, parts });
}

async function contentToGeminiParts(
  content: unknown,
  where: string,
  options?: ConversionOptions,
): Promise<Array<Record<string, unknown>>> {
  if (typeof content === 'string') return content === '' ? [] : [{ text: content }];
  if (!Array.isArray(content)) throw new ValidationError(`${where} must be a string or an array`);
  const parts: Array<Record<string, unknown>> = [];
  for (const [index, value] of content.entries()) {
    const part = asRecord(value);
    if (!part) throw new ValidationError(`${where}[${index}] must be an object`);
    const at = `${where}[${index}]`;
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      if (typeof part.text === 'string') parts.push({ text: part.text });
      continue;
    }
    if (part.type === 'input_image' || part.type === 'image_url') {
      const raw = part.image_url ?? part.url;
      const url = isBlobRef(raw) || typeof raw === 'string' ? raw : asRecord(raw)?.url;
      if (typeof url !== 'string' && !isBlobRef(url)) throw new ValidationError(`${at}.image_url is required`);
      if (typeof url === 'string' && !url.startsWith('data:')) {
        parts.push({ inline_data: await fetchImageAsInlineData(url) });
      } else {
        parts.push({ inline_data: decodeDataUriOrRef(url) });
      }
      if (part.detail !== undefined) warn(options, `${at}.detail has no generateContent equivalent; dropped`);
      continue;
    }
    if (part.type === 'input_file' || part.type === 'file') {
      const fileUrl = part.file_url ?? asRecord(part.file)?.file_url;
      if (typeof fileUrl === 'string' && fileUrl !== '') {
        parts.push({ inline_data: await fetchImageAsInlineData(fileUrl) });
        continue;
      }
      const raw = part.file_data ?? asRecord(part.file)?.file_data;
      if (typeof raw !== 'string' && !isBlobRef(raw)) {
        warn(options, `${at}.file_id has no generateContent inline-data equivalent; dropped`);
        continue;
      }
      const decoded = typeof raw === 'string' && !raw.startsWith('data:')
        ? { mime_type: 'application/octet-stream', data: raw }
        : decodeDataUriOrRef(raw);
      if (isBlobRef(raw) && raw.prefix === '') decoded.mime_type = 'application/octet-stream';
      parts.push({ inline_data: decoded });
      if (part.filename !== undefined) warn(options, `${at}.filename has no generateContent inline-data equivalent; dropped`);
      continue;
    }
    if (part.type === 'inline' || part.type === 'refusal') {
      warn(options, `${at} ${part.type} has no generateContent request part; dropped`);
      continue;
    }
    throw new ValidationError(`${at} type ${stringify(part.type)} has no generateContent content-part equivalent`);
  }
  return parts;
}

function reasoningText(item: Record<string, unknown>): string {
  return [
    ...(Array.isArray(item.summary) ? item.summary : []),
    ...(Array.isArray(item.content) ? item.content : []),
  ].map(asRecord)
    .filter(part => part?.type === 'summary_text' || part?.type === 'reasoning_text')
    .map(part => typeof part?.text === 'string' ? part.text : '')
    .join('');
}

function toolName(
  name: unknown,
  namespace: unknown,
  namespaceMap: NamespaceMap,
): string {
  if (typeof name !== 'string' || name === '') return '';
  if (typeof namespace !== 'string' || namespace === '') return name;
  for (const [flat, original] of namespaceMap) {
    if (original.name === name && original.namespace === namespace) return flat;
  }
  return `${namespace.replace(/\./g, NAMESPACE_SEPARATOR)}${NAMESPACE_SEPARATOR}${name}`;
}

interface GeminiTools {
  declarations: Array<Record<string, unknown>>;
  nativeTools: Array<Record<string, unknown>>;
  namespaceMap: NamespaceMap;
}

function geminiTools(
  request: Record<string, unknown>,
  additionalTools: Array<Record<string, unknown>>,
  options?: ConversionOptions,
): GeminiTools {
  const namespaceMap: NamespaceMap = new Map();
  const flattened = flattenNamespaces([
    ...(Array.isArray(request.tools) ? request.tools as Array<Record<string, unknown>> : []),
    ...additionalTools,
  ], namespaceMap, { value: 0 });
  const declarations: Array<Record<string, unknown>> = [];
  const nativeTools: Array<Record<string, unknown>> = [];
  for (const [index, tool] of flattened.entries()) {
    if (tool.type === 'function' || tool.type === 'custom') {
      if (typeof tool.name !== 'string' || tool.name === '') throw new ValidationError(`tools[${index}] requires a name`);
      declarations.push({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        parameters: recursivelyCleanSchema(tool.type === 'custom'
          ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] }
          : tool.parameters ?? { type: 'object', properties: {} }),
      });
      if (tool.strict !== undefined) warn(options, `tools[${index}].strict has no generateContent function declaration equivalent; dropped`);
    } else if (tool.type === 'web_search' || tool.type === 'web_search_preview' || tool.type === 'web_search_2025_08_26') {
      nativeTools.push({ googleSearch: {} });
      for (const field of ['filters', 'user_location', 'search_content_types', 'external_web_access']) {
        if (tool[field] !== undefined) warn(options, `tools[${index}].${field} has no Gemini googleSearch equivalent; dropped`);
      }
    } else if (tool.type === 'code_interpreter') {
      nativeTools.push({ codeExecution: {} });
      if (tool.container !== undefined) warn(options, `tools[${index}].container has no Gemini codeExecution equivalent; dropped`);
    } else {
      warn(options, `tools[${index}] type ${stringify(tool.type)} has no generateContent tool equivalent; dropped`);
    }
  }
  return { declarations, nativeTools, namespaceMap };
}

function geminiToolChoice(
  value: unknown,
  hasFunctions: boolean,
  namespaceMap: NamespaceMap,
): Record<string, unknown> | undefined {
  if (!hasFunctions || value === undefined) return undefined;
  const config: Record<string, unknown> = {};
  if (value === 'auto') config.mode = 'AUTO';
  else if (value === 'none') config.mode = 'NONE';
  else if (value === 'required') config.mode = 'ANY';
  const choice = asRecord(value);
  if (choice?.type === 'function' || choice?.type === 'custom') {
    const name = toolName(choice.name, choice.namespace, namespaceMap);
    if (name === '') throw new ValidationError('tool_choice function requires name');
    config.mode = 'ANY';
    config.allowedFunctionNames = [name];
  } else if (choice?.type === 'allowed_tools') {
    const tools = Array.isArray(choice.tools) ? choice.tools : [];
    const names = tools.map(tool => {
      const entry = asRecord(tool);
      return toolName(entry?.name, entry?.namespace, namespaceMap);
    }).filter(name => name !== '');
    config.mode = names.length === 0 ? 'NONE' : choice.mode === 'required' ? 'ANY' : 'AUTO';
    if (names.length > 0) config.allowedFunctionNames = names;
  } else if (choice && Object.keys(config).length === 0) {
    throw new ValidationError(`tool_choice ${stringify(value)} has no generateContent equivalent`);
  }
  return Object.keys(config).length > 0 ? { functionCallingConfig: config } : undefined;
}

export async function responsesToGeminiBody(
  request: Record<string, unknown>,
  model: string,
  options?: ConversionOptions,
): Promise<Record<string, unknown>> {
  const input = request.input;
  const additionalTools: Array<Record<string, unknown>> = [];
  if (Array.isArray(input)) {
    for (const value of input) {
      const item = asRecord(value);
      if (item?.type === 'additional_tools' && Array.isArray(item.tools)) {
        additionalTools.push(...item.tools as Array<Record<string, unknown>>);
      }
    }
  }
  const { declarations, nativeTools, namespaceMap } = geminiTools(request, additionalTools, options);
  const contents: Array<Record<string, unknown>> = [];
  const instructions: string[] = [];
  const callNames = new Map<string, string>();

  if (typeof input === 'string') {
    appendContent(contents, 'user', [{ text: input }]);
  } else if (Array.isArray(input)) {
    for (const [index, value] of input.entries()) {
      const item = asRecord(value);
      if (!item) throw new ValidationError(`input[${index}] must be an object`);
      const at = `input[${index}]`;
      if (item.type === 'additional_tools') continue;
      if (item.type === 'message' || item.role !== undefined) {
        const parts = await contentToGeminiParts(item.content, `${at}.content`, options);
        if (item.role === 'system' || item.role === 'developer') {
          for (const [partIndex, part] of parts.entries()) {
            if (typeof part.text !== 'string') throw new ValidationError(`${at}.content[${partIndex}] system instructions must be text`);
            instructions.push(part.text);
          }
        } else {
          appendContent(contents, item.role === 'assistant' ? 'model' : 'user', parts);
        }
        continue;
      }
      if (item.type === 'reasoning') {
        const text = reasoningText(item);
        if (text !== '') appendContent(contents, 'model', [{ thought: true, text }]);
        if (item.encrypted_content !== undefined && item.encrypted_content !== null) {
          warn(options, `${at}.encrypted_content is provider-specific and is not used as a Gemini thoughtSignature`);
        }
        continue;
      }
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const id = item.call_id ?? item.id;
        const name = toolName(item.name, item.namespace, namespaceMap);
        if (typeof id !== 'string' || id === '' || name === '') throw new ValidationError(`${at} tool call requires id/call_id and name`);
        callNames.set(id, name);
        appendContent(contents, 'model', [{
          functionCall: {
            id,
            name,
            args: item.type === 'custom_tool_call' ? { input: item.input ?? '' } : parseToolArguments(item.arguments),
          },
        }]);
        continue;
      }
      if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        if (typeof item.call_id !== 'string' || item.call_id === '') throw new ValidationError(`${at} requires call_id`);
        const name = callNames.get(item.call_id);
        if (!name) throw new ValidationError(`${at} has no preceding function call with call_id ${stringify(item.call_id)}`);
        appendContent(contents, 'user', [{
          functionResponse: {
            id: item.call_id,
            name,
            response: { content: typeof item.output === 'string' ? item.output : stringify(item.output ?? '') },
          },
        }]);
        continue;
      }
      throw new ValidationError(`${at} type ${stringify(item.type)} has no direct generateContent input mapping`);
    }
  } else if (input !== undefined && input !== null) {
    throw new ValidationError('Responses input must be a string or an array');
  }
  if (contents.length === 0 && instructions.length === 0) throw new ValidationError('Responses request produced no generateContent contents');
  if (typeof request.instructions === 'string' && request.instructions !== '') instructions.unshift(request.instructions);

  const body: Record<string, unknown> = {
    model,
    contents,
    ...(instructions.length > 0 ? { systemInstruction: { parts: [{ text: instructions.join('\n') }] } } : {}),
    ...(declarations.length > 0 || nativeTools.length > 0
      ? { tools: [...(declarations.length > 0 ? [{ functionDeclarations: declarations }] : []), ...nativeTools] }
      : {}),
  };
  const requestedToolChoice = request.tool_choice ?? (request.allowed_tools !== undefined
    ? { type: 'allowed_tools', tools: request.allowed_tools }
    : undefined);
  const toolChoice = geminiToolChoice(requestedToolChoice, declarations.length > 0, namespaceMap);
  if (toolChoice) body.toolConfig = toolChoice;

  const generation: Record<string, unknown> = {};
  if (typeof request.max_output_tokens === 'number') generation.maxOutputTokens = request.max_output_tokens;
  else if (typeof request.max_tokens === 'number') generation.maxOutputTokens = request.max_tokens;
  for (const [source, target] of [
    ['temperature', 'temperature'], ['top_p', 'topP'], ['top_k', 'topK'],
    ['frequency_penalty', 'frequencyPenalty'], ['presence_penalty', 'presencePenalty'],
    ['seed', 'seed'], ['logprobs', 'logprobs'], ['top_logprobs', 'topLogprobs'],
  ] as const) {
    if (request[source] !== undefined) generation[target] = request[source];
  }
  if (request.stop !== undefined) generation.stopSequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  const reasoning = asRecord(request.reasoning);
  const thinking: Record<string, unknown> = {};
  if (typeof reasoning?.effort === 'string') {
    thinking.thinkingLevel = reasoning.effort === 'max' || reasoning.effort === 'xhigh'
      ? 'HIGH'
      : reasoning.effort.toUpperCase();
  }
  if (reasoning?.summary === 'auto') thinking.includeThoughts = true;
  if (Object.keys(thinking).length > 0) generation.thinkingConfig = thinking;
  const format = asRecord(asRecord(request.text)?.format);
  if (format?.type === 'json_schema') {
    if (!asRecord(format.schema)) throw new ValidationError('text.format json_schema requires schema');
    generation.responseMimeType = 'application/json';
    generation.responseJsonSchema = format.schema;
  } else if (format?.type === 'json_object') {
    generation.responseMimeType = 'application/json';
  } else if (format?.type === 'text') {
    generation.responseMimeType = 'text/plain';
  } else if (format !== undefined) {
    throw new ValidationError(`text.format type ${stringify(format.type)} has no generateContent equivalent`);
  }
  if (Object.keys(generation).length > 0) body.generationConfig = generation;

  for (const field of ['background', 'store', 'truncation', 'metadata', 'service_tier', 'prompt_cache_key', 'parallel_tool_calls', 'user', 'safety_identifier'] as const) {
    if (request[field] !== undefined) warn(options, `${field} has no generateContent equivalent; dropped`);
  }
  if (namespaceMap.size > 0) Object.defineProperty(body, NAMESPACE_MAP_KEY, { value: namespaceMap, enumerable: false });
  return body;
}
