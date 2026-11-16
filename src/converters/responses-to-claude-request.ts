import type { Logger } from '../types/shared.js';
import { isBlobRef } from '../utils/blob-refs.js';
import { ValidationError } from '../utils/errors.js';
import { stringify } from '../utils/stringify.js';
import { decodeDataUriOrRef } from './claude-to-gemini.js';
import { parseToolArguments } from './openai-to-gemini.js';
import { SYNTHETIC_THINKING_SIGNATURE } from './openai-to-claude.js';
import {
  flattenNamespaces,
  NAMESPACE_MAP_KEY,
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
  options?.logger?.warn(options.requestId ?? '', `[responses->claude] ${message}`);
}

function base64Utf8Decode(data: string): string {
  const binary = atob(data);
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

function documentSource(
  part: Record<string, unknown>,
  where: string,
  options?: ConversionOptions,
): Record<string, unknown> | undefined {
  if (typeof part.file_url === 'string' && part.file_url !== '') return { type: 'url', url: part.file_url };
  const raw = part.file_data ?? asRecord(part.file)?.file_data;
  if (raw === undefined || raw === null) {
    warn(options, `${where} file_id/file_data has no Claude document source; dropped`);
    return undefined;
  }
  let data: unknown = raw;
  let mime = 'application/pdf';
  if (typeof raw === 'string' && raw.startsWith('data:')) {
    const decoded = decodeDataUriOrRef(raw);
    data = decoded.data;
    mime = decoded.mime_type;
  } else if (isBlobRef(raw)) {
    const decoded = decodeDataUriOrRef(raw);
    data = decoded.data;
    mime = raw.prefix === '' ? 'application/pdf' : decoded.mime_type;
  }
  if (mime === 'text/plain') {
    if (typeof data !== 'string') throw new ValidationError(`${where} text file ref cannot be decoded inline`);
    return { type: 'text', media_type: 'text/plain', data: base64Utf8Decode(data) };
  }
  return { type: 'base64', media_type: mime, data };
}

function contentToClaudeBlocks(
  content: unknown,
  where: string,
  options?: ConversionOptions,
): Array<Record<string, unknown>> {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw new ValidationError(`${where} must be a string or an array`);

  const blocks: Array<Record<string, unknown>> = [];
  for (const [index, value] of content.entries()) {
    const part = asRecord(value);
    if (!part) throw new ValidationError(`${where}[${index}] must be an object`);
    const at = `${where}[${index}]`;
    if (part.type === 'input_text' || part.type === 'output_text' || part.type === 'text') {
      if (typeof part.text === 'string') blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'input_image' || part.type === 'image_url') {
      const raw = part.image_url ?? part.url;
      const value = isBlobRef(raw) || typeof raw === 'string' ? raw : asRecord(raw)?.url;
      if (typeof value === 'string' && !value.startsWith('data:')) {
        blocks.push({ type: 'image', source: { type: 'url', url: value } });
      } else if (typeof value === 'string' || isBlobRef(value)) {
        const decoded = decodeDataUriOrRef(value);
        blocks.push({ type: 'image', source: { type: 'base64', media_type: decoded.mime_type, data: decoded.data } });
      } else {
        throw new ValidationError(`${at}.image_url is required`);
      }
      continue;
    }
    if (part.type === 'input_file' || part.type === 'file') {
      const source = documentSource(part, at, options);
      if (source) blocks.push({
        type: 'document',
        source,
        title: part.filename ?? asRecord(part.file)?.filename ?? 'document.pdf',
      });
      continue;
    }
    if (part.type === 'inline') {
      warn(options, `${at} inline extension content has no Claude content-block equivalent; dropped`);
      continue;
    }
    if (part.type === 'refusal') {
      warn(options, `${at} refusal has no Claude request content block; dropped`);
      continue;
    }
    throw new ValidationError(`${at} type ${stringify(part.type)} has no Claude content-block equivalent`);
  }
  return blocks;
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

function appendMessage(
  messages: Array<Record<string, unknown>>,
  role: 'user' | 'assistant',
  content: Array<Record<string, unknown>>,
): void {
  if (content.length === 0) return;
  const textOnly = content.every(block => block.type === 'text');
  const previous = messages.at(-1);
  if (previous?.role === role) {
    if (typeof previous.content === 'string' && textOnly) {
      previous.content = previous.content + content.map(block => block.text as string).join('');
    } else if (Array.isArray(previous.content)) {
      previous.content.push(...content);
    } else {
      previous.content = [{ type: 'text', text: previous.content }, ...content];
    }
  } else {
    messages.push({
      role,
      content: textOnly ? content.map(block => block.text as string).join('') : content,
    });
  }
}

function toolResultContent(output: unknown, where: string, options?: ConversionOptions): unknown {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return contentToClaudeBlocks(output, where, options);
  return stringify(output ?? '');
}

function responseTools(
  request: Record<string, unknown>,
  additionalTools: Array<Record<string, unknown>>,
  options?: ConversionOptions,
): { tools: Array<Record<string, unknown>>; mcpServers: Array<Record<string, unknown>>; namespaceMap: NamespaceMap } {
  const namespaceMap: NamespaceMap = new Map();
  const flattened = flattenNamespaces([
    ...(Array.isArray(request.tools) ? request.tools as Array<Record<string, unknown>> : []),
    ...additionalTools,
  ], namespaceMap, { value: 0 });
  const tools: Array<Record<string, unknown>> = [];
  const mcpServers: Array<Record<string, unknown>> = [];

  for (const [index, tool] of flattened.entries()) {
    if (tool.type === 'function' || tool.type === 'custom') {
      if (typeof tool.name !== 'string' || tool.name === '') throw new ValidationError(`tools[${index}] requires a name`);
      tools.push({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        input_schema: tool.type === 'custom'
          ? { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] }
          : tool.parameters ?? { type: 'object', properties: {} },
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      });
    } else if (tool.type === 'web_search' || tool.type === 'web_search_preview' || tool.type === 'web_search_2025_08_26') {
      const filters = asRecord(tool.filters);
      tools.push({
        type: 'web_search_20250305',
        name: 'web_search',
        ...(Array.isArray(filters?.allowed_domains) ? { allowed_domains: filters.allowed_domains } : {}),
        ...(asRecord(tool.user_location) ? { user_location: { type: 'approximate', ...asRecord(tool.user_location) } } : {}),
      });
      if (tool.external_web_access !== undefined) warn(options, `tools[${index}].external_web_access has no Claude web_search equivalent; dropped`);
    } else if (tool.type === 'code_interpreter') {
      tools.push({ type: 'code_execution_20250522', name: 'code_execution' });
      const container = asRecord(tool.container);
      if (Array.isArray(container?.file_ids) && container.file_ids.length > 0) {
        warn(options, `tools[${index}].container.file_ids has no Claude code_execution equivalent; dropped`);
      }
    } else if (tool.type === 'mcp') {
      if (typeof tool.server_url !== 'string' || tool.server_url === '') {
        throw new ValidationError(`tools[${index}] MCP connector requires server_url for Claude mcp_servers`);
      }
      const headers = asRecord(tool.headers);
      const allowed = Array.isArray(tool.allowed_tools)
        ? tool.allowed_tools.filter(name => typeof name === 'string')
        : asRecord(tool.allowed_tools)?.tool_names;
      mcpServers.push({
        type: 'url',
        name: tool.server_label ?? tool.server_url,
        url: tool.server_url,
        ...(typeof headers?.Authorization === 'string' ? { authorization_token: headers.Authorization } : {}),
        ...(Array.isArray(allowed) ? { tool_configuration: { allowed_tools: allowed } } : {}),
      });
    } else if (tool.type === 'computer_use_preview' || tool.type === 'computer_use') {
      tools.push({
        type: 'computer_20250124',
        name: 'computer',
        display_width_px: tool.display_width,
        display_height_px: tool.display_height,
      });
    } else {
      warn(options, `tools[${index}] type ${stringify(tool.type)} has no Claude tool equivalent; dropped`);
    }
  }
  return { tools, mcpServers, namespaceMap };
}

function claudeToolChoice(
  value: unknown,
  hasTools: boolean,
  parallelToolCalls: unknown,
): Record<string, unknown> | undefined {
  if (!hasTools) return undefined;
  let choice: Record<string, unknown> | undefined;
  if (value === 'auto') choice = { type: 'auto' };
  else if (value === 'none') choice = { type: 'none' };
  else if (value === 'required') choice = { type: 'any' };
  const record = asRecord(value);
  if (record?.type === 'function' || record?.type === 'custom') {
    if (typeof record.name !== 'string' || record.name === '') throw new ValidationError('tool_choice function requires name');
    choice = { type: 'tool', name: record.name };
  } else if (record?.type === 'allowed_tools') {
    const allowed = Array.isArray(record.tools) ? record.tools : [];
    choice = { type: allowed.length === 0 ? 'none' : record.mode === 'required' ? 'any' : 'auto' };
  } else if (record && !choice) {
    if (typeof record.type === 'string') choice = { type: 'tool', name: record.type };
  }
  if (parallelToolCalls === false) {
    choice = { ...(choice ?? { type: 'auto' }), disable_parallel_tool_use: true };
  }
  return choice;
}

export function responsesToClaudeBody(
  request: Record<string, unknown>,
  model: string,
  options?: ConversionOptions,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  const instructions: string[] = [];
  const additionalTools: Array<Record<string, unknown>> = [];
  const input = request.input;

  if (typeof input === 'string') {
    appendMessage(messages, 'user', [{ type: 'text', text: input }]);
  } else if (Array.isArray(input)) {
    for (const [index, value] of input.entries()) {
      const item = asRecord(value);
      if (!item) throw new ValidationError(`input[${index}] must be an object`);
      const at = `input[${index}]`;
      if (item.type === 'additional_tools') {
        if (Array.isArray(item.tools)) additionalTools.push(...item.tools as Array<Record<string, unknown>>);
        continue;
      }
      if (item.type === 'message' || item.role !== undefined) {
        const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : 'system';
        if (role === 'system') {
          instructions.push(...contentToClaudeBlocks(item.content, `${at}.content`, options)
            .filter(block => block.type === 'text').map(block => block.text as string));
        } else {
          appendMessage(messages, role, contentToClaudeBlocks(item.content, `${at}.content`, options));
        }
        continue;
      }
      if (item.type === 'reasoning') {
        const text = reasoningText(item);
        if (text !== '') appendMessage(messages, 'assistant', [{ type: 'thinking', thinking: text, signature: SYNTHETIC_THINKING_SIGNATURE }]);
        if (item.encrypted_content !== undefined && item.encrypted_content !== null) {
          warn(options, `${at}.encrypted_content is provider-specific and is not used as a Claude thinking signature`);
        }
        continue;
      }
      if (item.type === 'function_call' || item.type === 'custom_tool_call') {
        const id = item.call_id ?? item.id;
        if (typeof id !== 'string' || id === '' || typeof item.name !== 'string' || item.name === '') {
          throw new ValidationError(`${at} tool call requires id/call_id and name`);
        }
        appendMessage(messages, 'assistant', [{
          type: 'tool_use', id, name: item.name,
          input: item.type === 'custom_tool_call' ? { input: item.input ?? '' } : parseToolArguments(item.arguments),
        }]);
        continue;
      }
      if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        if (typeof item.call_id !== 'string' || item.call_id === '') throw new ValidationError(`${at} requires call_id`);
        appendMessage(messages, 'user', [{
          type: 'tool_result', tool_use_id: item.call_id,
          content: toolResultContent(item.output, `${at}.output`, options),
        }]);
        continue;
      }
      throw new ValidationError(`${at} type ${stringify(item.type)} has no direct Claude input mapping`);
    }
  } else if (input !== undefined && input !== null) {
    throw new ValidationError('Responses input must be a string or an array');
  }

  if (messages.length === 0) throw new ValidationError('Responses request produced no Claude messages');
  if (typeof request.instructions === 'string' && request.instructions !== '') instructions.unshift(request.instructions);

  const { tools, mcpServers, namespaceMap } = responseTools(request, additionalTools, options);
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: typeof request.max_output_tokens === 'number' ? request.max_output_tokens : 4096,
    stream: request.stream === true,
    ...(instructions.length > 0 ? { system: instructions.join('\n') } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(mcpServers.length > 0 ? { mcp_servers: mcpServers } : {}),
  };
  const toolChoice = claudeToolChoice(request.tool_choice, tools.length > 0, request.parallel_tool_calls);
  if (toolChoice) body.tool_choice = toolChoice;
  if (typeof request.temperature === 'number') body.temperature = request.temperature;
  if (typeof request.top_p === 'number') body.top_p = request.top_p;

  const metadata = asRecord(request.metadata);
  const userId = metadata?.user_id ?? request.user ?? request.safety_identifier;
  if (typeof userId === 'string' && userId !== '') body.metadata = { user_id: userId };

  const outputConfig: Record<string, unknown> = {};
  const reasoning = asRecord(request.reasoning);
  if (typeof reasoning?.effort === 'string') {
    outputConfig.effort = reasoning.effort === 'minimal' ? 'low' : reasoning.effort === 'xhigh' ? 'max' : reasoning.effort;
  }
  const text = asRecord(request.text);
  const format = asRecord(text?.format);
  if (format?.type === 'json_schema') {
    if (!asRecord(format.schema)) throw new ValidationError('text.format json_schema requires schema');
    outputConfig.format = { type: 'json_schema', schema: format.schema };
  } else if (format?.type === 'json_object') {
    outputConfig.format = { type: 'json_schema', schema: { type: 'object' } };
  }
  if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;

  if (request.service_tier === 'auto') body.service_tier = 'auto';
  else if (request.service_tier !== undefined) warn(options, `service_tier ${stringify(request.service_tier)} has no Claude equivalent; dropped`);
  for (const field of ['background', 'store', 'truncation'] as const) {
    if (request[field] !== undefined) warn(options, `${field} has no Claude Messages equivalent; dropped`);
  }
  if (namespaceMap.size > 0) {
    Object.defineProperty(body, NAMESPACE_MAP_KEY, { value: namespaceMap, enumerable: false });
  }
  return body;
}
