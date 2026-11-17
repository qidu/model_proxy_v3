import type { Logger } from '../types/shared.js';
import { isBlobRef } from '../utils/blob-refs.js';
import { ValidationError } from '../utils/errors.js';
import { stringify } from '../utils/stringify.js';
import { decodeDataUriOrRef } from './claude-to-gemini.js';
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
  options?.logger?.warn(options.requestId ?? '', `[responses->interactions-request] ${message}`);
}

function contentParts(content: unknown, where: string): Array<Record<string, unknown>> {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw new ValidationError(`${where} must be a string or an array`);
  const parts: Array<Record<string, unknown>> = [];
  for (const [index, value] of content.entries()) {
    const part = asRecord(value);
    if (!part) throw new ValidationError(`${where}[${index}] must be an object`);
    const at = `${where}[${index}]`;
    if (['input_text', 'output_text', 'text', 'reasoning_text', 'summary_text'].includes(String(part.type))) {
      if (typeof part.text === 'string') parts.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'input_image' || part.type === 'image_url') {
      const raw = part.image_url ?? part.url;
      const url = isBlobRef(raw) || typeof raw === 'string' ? raw : asRecord(raw)?.url;
      if (typeof url !== 'string' && !isBlobRef(url)) throw new ValidationError(`${at}.image_url is required`);
      if (typeof url === 'string' && !url.startsWith('data:')) parts.push({ type: 'image', uri: url });
      else {
        const decoded = decodeDataUriOrRef(url);
        parts.push({ type: 'image', mime_type: decoded.mime_type, data: decoded.data });
      }
      continue;
    }
    if (part.type === 'input_file' || part.type === 'file') {
      const file = asRecord(part.file) ?? part;
      const fileUrl = file.file_url;
      if (typeof fileUrl === 'string' && fileUrl !== '') {
        parts.push({ type: 'document', uri: fileUrl, mime_type: 'application/pdf' });
        continue;
      }
      const raw = file.file_data;
      if (typeof raw !== 'string' && !isBlobRef(raw)) throw new ValidationError(`${at}.file_data is required`);
      const decoded = decodeDataUriOrRef(raw);
      if (decoded.mime_type !== 'application/pdf') {
        throw new ValidationError(`${at} has mime type ${decoded.mime_type}; Interactions documents support application/pdf`);
      }
      parts.push({ type: 'document', mime_type: decoded.mime_type, data: decoded.data });
      continue;
    }
    if (part.type === 'refusal' || part.type === 'inline') continue;
    throw new ValidationError(`${at} type ${stringify(part.type)} has no Interactions Content equivalent`);
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

function toolName(name: unknown, namespace: unknown, namespaceMap: NamespaceMap): string {
  if (typeof name !== 'string' || name === '') return '';
  if (typeof namespace !== 'string' || namespace === '') return name;
  for (const [flat, original] of namespaceMap) {
    if (original.name === name && original.namespace === namespace) return flat;
  }
  return `${namespace.replace(/\./g, NAMESPACE_SEPARATOR)}${NAMESPACE_SEPARATOR}${name}`;
}

export function responsesToInteractionsBody(
  request: Record<string, unknown>,
  model: string,
  options?: ConversionOptions,
): Record<string, unknown> {
  const inputValue = request.input;
  const additionalTools: Array<Record<string, unknown>> = [];
  if (Array.isArray(inputValue)) {
    for (const value of inputValue) {
      const item = asRecord(value);
      if (item?.type === 'additional_tools' && Array.isArray(item.tools)) {
        additionalTools.push(...item.tools as Array<Record<string, unknown>>);
      }
    }
  }

  const namespaceMap: NamespaceMap = new Map();
  const tools = flattenNamespaces([
    ...(Array.isArray(request.tools) ? request.tools as Array<Record<string, unknown>> : []),
    ...additionalTools,
  ], namespaceMap, { value: 0 });
  const convertedTools: Array<Record<string, unknown>> = [];
  for (const [index, tool] of tools.entries()) {
    if (tool.type === 'function' || tool.type === 'custom') {
      if (typeof tool.name !== 'string' || tool.name === '') throw new ValidationError(`tools[${index}] requires a name`);
      convertedTools.push({
        type: 'function',
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        parameters: tool.type === 'custom'
          ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] }
          : tool.parameters ?? { type: 'object', properties: {} },
      });
      if (tool.strict !== undefined) warn(options, `tools[${index}].strict has no Interactions function equivalent; dropped`);
    } else if (['web_search', 'web_search_preview', 'web_search_2025_08_26'].includes(String(tool.type))) {
      const contentTypes = Array.isArray(tool.search_content_types) ? tool.search_content_types : [];
      const searchTypes = contentTypes.flatMap(entry => entry === 'text' ? ['web_search'] : entry === 'image' ? ['image_search'] : []);
      convertedTools.push({ type: 'google_search', ...(searchTypes.length > 0 ? { search_types: searchTypes } : {}) });
    } else if (tool.type === 'code_interpreter') {
      convertedTools.push({ type: 'code_execution' });
      if (tool.container !== undefined) warn(options, `tools[${index}].container has no Interactions code_execution equivalent; dropped`);
    } else if (tool.type === 'mcp') {
      if (typeof tool.server_url !== 'string' || tool.server_url === '') throw new ValidationError(`tools[${index}] MCP requires server_url`);
      convertedTools.push({
        type: 'mcp_server',
        name: typeof tool.server_label === 'string' && tool.server_label !== '' ? tool.server_label : tool.server_url,
        url: tool.server_url,
        ...(tool.headers !== undefined ? { headers: tool.headers } : {}),
        ...(Array.isArray(tool.allowed_tools) ? { allowed_tools: { tools: tool.allowed_tools } } : {}),
      });
    } else {
      warn(options, `tools[${index}] type ${stringify(tool.type)} has no faithful Interactions equivalent; dropped`);
    }
  }

  const input: Array<Record<string, unknown>> = [];
  const instructions: string[] = [];
  if (typeof inputValue === 'string') {
    input.push({ type: 'user_input', content: [{ type: 'text', text: inputValue }] });
  } else if (Array.isArray(inputValue)) {
    for (const [index, value] of inputValue.entries()) {
      const item = asRecord(value);
      if (!item) throw new ValidationError(`input[${index}] must be an object`);
      const at = `input[${index}]`;
      if (item.type === 'additional_tools') continue;
      if (item.type === 'message' || item.role !== undefined) {
        const parts = contentParts(item.content, `${at}.content`);
        if (item.role === 'system' || item.role === 'developer') {
          for (const part of parts) {
            if (part.type !== 'text') throw new ValidationError(`${at} system instructions must be text`);
            instructions.push(part.text as string);
          }
        } else {
          input.push({ type: item.role === 'assistant' ? 'model_output' : 'user_input', content: parts });
        }
      } else if (item.type === 'reasoning') {
        const text = reasoningText(item);
        if (text) input.push({ type: 'thought', summary: [{ type: 'text', text }] });
        if (item.encrypted_content != null) warn(options, `${at}.encrypted_content has no Interactions thought-signature equivalent; dropped`);
      } else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const id = item.call_id ?? item.id;
        const name = toolName(item.name, item.namespace, namespaceMap);
        if (typeof id !== 'string' || id === '' || name === '') throw new ValidationError(`${at} tool call requires id/call_id and name`);
        input.push({
          type: 'function_call', id, name,
          arguments: item.type === 'custom_tool_call' ? { input: item.input ?? '' } : parseToolArguments(item.arguments),
        });
      } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        if (typeof item.call_id !== 'string' || item.call_id === '') throw new ValidationError(`${at} requires call_id`);
        const result = typeof item.output === 'string'
          ? item.output
          : Array.isArray(item.output) ? contentParts(item.output, `${at}.output`) : stringify(item.output ?? '');
        input.push({ type: 'function_result', call_id: item.call_id, result });
      } else {
        throw new ValidationError(`${at} type ${stringify(item.type)} has no Interactions input mapping`);
      }
    }
  } else {
    throw new ValidationError('Responses input must be a string or an array');
  }
  if (input.length === 0 && instructions.length === 0 && typeof request.instructions !== 'string') {
    throw new ValidationError('Responses request produced no Interactions input');
  }
  if (typeof request.instructions === 'string' && request.instructions !== '') instructions.unshift(request.instructions);

  const generation: Record<string, unknown> = {};
  if (typeof request.max_output_tokens === 'number') generation.max_output_tokens = request.max_output_tokens;
  if (typeof request.temperature === 'number') generation.temperature = request.temperature;
  if (typeof request.top_p === 'number') generation.top_p = request.top_p;
  if (typeof request.seed === 'number') generation.seed = request.seed;
  if (request.stop !== undefined) generation.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  const reasoning = asRecord(request.reasoning);
  if (typeof reasoning?.effort === 'string') generation.thinking_level = reasoning.effort === 'max' ? 'high' : reasoning.effort;
  if (reasoning?.summary === 'auto') generation.thinking_summaries = 'auto';

  const choice = request.tool_choice ?? (request.allowed_tools !== undefined
    ? { type: 'allowed_tools', tools: request.allowed_tools }
    : undefined);
  if (choice === 'auto' || choice === 'none') generation.tool_choice = choice;
  else if (choice === 'required') generation.tool_choice = 'any';
  else {
    const selected = asRecord(choice);
    if (selected?.type === 'function' || selected?.type === 'custom') {
      const name = toolName(selected.name, selected.namespace, namespaceMap);
      if (!name) throw new ValidationError('tool_choice function requires name');
      generation.tool_choice = { allowed_tools: { mode: 'validated', tools: [name] } };
    } else if (selected?.type === 'allowed_tools') {
      const names = (Array.isArray(selected.tools) ? selected.tools : []).map(tool => {
        const entry = asRecord(tool);
        return toolName(entry?.name, entry?.namespace, namespaceMap);
      }).filter(name => name !== '');
      generation.tool_choice = {
        allowed_tools: { mode: selected.mode === 'required' ? 'validated' : 'auto', tools: names },
      };
    } else if (choice !== undefined) {
      throw new ValidationError(`tool_choice ${stringify(choice)} has no Interactions equivalent`);
    }
  }

  const body: Record<string, unknown> = {
    model,
    input,
    ...(instructions.length > 0 ? { system_instruction: instructions.join('\n') } : {}),
    ...(convertedTools.length > 0 ? { tools: convertedTools } : {}),
    ...(Object.keys(generation).length > 0 ? { generation_config: generation } : {}),
    ...(request.stream === true ? { stream: true } : {}),
    ...(typeof request.store === 'boolean' ? { store: request.store } : {}),
    ...(typeof request.background === 'boolean' ? { background: request.background } : {}),
    ...(Array.isArray(request.response_modalities) ? { response_modalities: request.response_modalities } : {}),
  };
  const format = asRecord(asRecord(request.text)?.format);
  if (format?.type === 'json_schema') {
    if (!asRecord(format.schema)) throw new ValidationError('text.format json_schema requires schema');
    body.response_format = format.schema;
  } else if (format?.type === 'json_object') {
    body.response_format = { type: 'object' };
  } else if (format !== undefined && format.type !== 'text') {
    throw new ValidationError(`text.format type ${stringify(format.type)} has no Interactions equivalent`);
  }

  for (const field of ['metadata', 'top_k', 'truncation', 'service_tier', 'prompt_cache_key', 'parallel_tool_calls', 'user', 'safety_identifier'] as const) {
    if (request[field] !== undefined) warn(options, `${field} has no Interactions equivalent; dropped`);
  }
  if (namespaceMap.size > 0) Object.defineProperty(body, NAMESPACE_MAP_KEY, { value: namespaceMap, enumerable: false });
  return body;
}
