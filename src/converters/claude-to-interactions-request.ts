import type { ClaudeMessagesRequest } from '../types/claude.js';
import type { Logger } from '../types/shared.js';
import { isBlobRef } from '../utils/blob-refs.js';
import { ValidationError } from '../utils/errors.js';
import { stringify } from '../utils/stringify.js';

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
  options?.logger?.warn(options.requestId ?? '', `[claude->interactions-request] ${message}`);
}

function mediaBlock(block: Record<string, unknown>, where: string): Record<string, unknown> {
  const source = asRecord(block.source);
  if (!source) throw new ValidationError(`${where}.source is required`);
  const type = block.type === 'document' ? 'document' : 'image';
  const mimeType = source.media_type ?? (type === 'document' ? 'application/pdf' : undefined);
  if (source.type === 'url') {
    if (typeof source.url !== 'string' || source.url === '') throw new ValidationError(`${where}.source.url is required`);
    return { type, uri: source.url, ...(typeof mimeType === 'string' ? { mime_type: mimeType } : {}) };
  }
  if (source.type !== 'base64' || typeof source.data !== 'string' && !isBlobRef(source.data)) {
    throw new ValidationError(`${where} only base64 and URL sources have an Interactions equivalent`);
  }
  if (typeof mimeType !== 'string' || mimeType === '') throw new ValidationError(`${where}.source.media_type is required`);
  return { type, data: source.data, mime_type: mimeType };
}

function appendContentStep(
  input: Array<Record<string, unknown>>,
  role: 'user' | 'assistant',
  content: unknown,
  where: string,
  options?: ConversionOptions,
): void {
  if (typeof content === 'string') {
    input.push({ type: role === 'assistant' ? 'model_output' : 'user_input', content: content === '' ? [] : [{ type: 'text', text: content }] });
    return;
  }
  if (!Array.isArray(content)) throw new ValidationError(`${where} must be a string or an array`);
  let parts: Array<Record<string, unknown>> = [];
  const flush = (): void => {
    if (parts.length === 0) return;
    input.push({ type: role === 'assistant' ? 'model_output' : 'user_input', content: parts });
    parts = [];
  };
  for (const [index, value] of content.entries()) {
    const block = asRecord(value);
    if (!block) throw new ValidationError(`${where}[${index}] must be an object`);
    const at = `${where}[${index}]`;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image' || block.type === 'document') {
      parts.push(mediaBlock(block, at));
    } else if (block.type === 'thinking') {
      flush();
      const text = typeof block.thinking === 'string' ? block.thinking : '';
      input.push({
        type: 'thought',
        ...(text ? { summary: [{ type: 'text', text }] } : {}),
        ...(typeof block.signature === 'string' && block.signature ? { signature: block.signature } : {}),
      });
    } else if (block.type === 'redacted_thinking') {
      warn(options, `${at}.data is provider-specific encrypted reasoning; dropped`);
    } else if (block.type === 'tool_use') {
      flush();
      if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name) {
        throw new ValidationError(`${at} tool_use requires id and name`);
      }
      input.push({ type: 'function_call', id: block.id, name: block.name, arguments: asRecord(block.input) ?? {} });
    } else if (block.type === 'tool_result') {
      flush();
      const id = block.tool_use_id;
      if (typeof id !== 'string' || !id) throw new ValidationError(`${at}.tool_use_id is required`);
      const result = typeof block.content === 'string'
        ? block.content
        : Array.isArray(block.content)
          ? block.content.map((entry, resultIndex) => {
            const part = asRecord(entry);
            if (part?.type === 'text' && typeof part.text === 'string') return { type: 'text', text: part.text };
            if (part?.type === 'image' || part?.type === 'document') return mediaBlock(part, `${at}.content[${resultIndex}]`);
            throw new ValidationError(`${at}.content[${resultIndex}] has no Interactions function-result equivalent`);
          })
          : stringify(block.content ?? '');
      input.push({ type: 'function_result', call_id: id, result, ...(block.is_error !== undefined ? { is_error: block.is_error } : {}) });
    } else if (block.type === 'mcp_tool_use') {
      flush();
      if (typeof block.id !== 'string' || !block.id || typeof block.name !== 'string' || !block.name || typeof block.server_name !== 'string' || !block.server_name) {
        throw new ValidationError(`${at} MCP tool use requires id, name, and server_name`);
      }
      input.push({ type: 'mcp_server_tool_call', id: block.id, name: block.name, server_name: block.server_name, arguments: asRecord(block.input) ?? {} });
    } else if (block.type === 'mcp_tool_result') {
      flush();
      const id = block.tool_use_id;
      if (typeof id !== 'string' || !id) throw new ValidationError(`${at}.tool_use_id is required`);
      input.push({
        type: 'mcp_server_tool_result', call_id: id,
        result: typeof block.content === 'string' ? block.content : stringify(block.content ?? ''),
        ...(typeof block.server_name === 'string' ? { server_name: block.server_name } : {}),
      });
    } else if (block.type === 'server_tool_use' && block.name === 'web_search') {
      flush();
      if (typeof block.id !== 'string' || !block.id) throw new ValidationError(`${at}.id is required`);
      input.push({ type: 'google_search_call', id: block.id, arguments: { ...asRecord(block.input), search_type: 'web_search' } });
    } else if (block.type === 'server_tool_use' && block.name === 'code_execution') {
      flush();
      if (typeof block.id !== 'string' || !block.id || typeof asRecord(block.input)?.code !== 'string') {
        throw new ValidationError(`${at} code execution requires id and input.code`);
      }
      input.push({ type: 'code_execution_call', id: block.id, arguments: { ...asRecord(block.input), language: 'python' } });
    } else {
      throw new ValidationError(`${at} type ${stringify(block.type)} has no Interactions equivalent`);
    }
  }
  if (parts.length > 0 || content.length === 0) flush();
}

export function claudeToInteractionsBody(
  request: ClaudeMessagesRequest,
  model: string,
  options?: ConversionOptions,
): Record<string, unknown> {
  const input: Array<Record<string, unknown>> = [];
  for (const [index, message] of request.messages.entries()) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      throw new ValidationError(`messages[${index}].role ${stringify(message.role)} has no Interactions equivalent`);
    }
    appendContentStep(input, message.role, message.content, `messages[${index}].content`, options);
  }
  if (input.length === 0) throw new ValidationError('Claude request produced no Interactions input');

  const system = typeof request.system === 'string'
    ? request.system
    : Array.isArray(request.system)
      ? request.system.map((block, index) => {
        if (block.type !== 'text' || typeof block.text !== 'string') throw new ValidationError(`system[${index}] must be text`);
        return block.text;
      }).join('\n')
      : '';
  const generation: Record<string, unknown> = {
    max_output_tokens: request.max_tokens,
  };
  if (typeof request.temperature === 'number') generation.temperature = request.temperature;
  if (typeof request.top_p === 'number') generation.top_p = request.top_p;
  if (Array.isArray(request.stop_sequences) && request.stop_sequences.length > 0) generation.stop_sequences = request.stop_sequences;
  const effort = request.output_config?.effort ?? request.reasoning_effort;
  if (typeof effort === 'string') generation.thinking_level = effort === 'max' ? 'high' : effort;
  if (request.thinking && request.thinking.type !== 'disabled' && request.thinking.type !== false) generation.thinking_summaries = 'auto';
  else if (request.thinking) generation.thinking_summaries = 'none';

  const tools: Array<Record<string, unknown>> = [];
  for (const [index, tool] of (request.tools ?? []).entries()) {
    const record = tool as unknown as Record<string, unknown>;
    if (record.type === 'web_search_20250305' || record.name === 'web_search' && record.type !== 'custom' && record.type !== undefined) {
      tools.push({ type: 'google_search' });
    } else if (record.type === 'code_execution_20250522' || record.name === 'code_execution' && record.type !== undefined) {
      tools.push({ type: 'code_execution' });
    } else if (record.type !== undefined && record.type !== 'custom') {
      warn(options, `tools[${index}] server type ${stringify(record.type)} has no Interactions equivalent; dropped`);
    } else {
      if (typeof tool.name !== 'string' || !tool.name) throw new ValidationError(`tools[${index}].name is required`);
      tools.push({
        type: 'function', name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        parameters: tool.input_schema ?? { type: 'object', properties: {} },
      });
      if (tool.strict !== undefined) warn(options, `tools[${index}].strict has no Interactions function equivalent; dropped`);
    }
  }
  for (const [index, server] of (request.mcp_servers ?? []).entries()) {
    if (server.type !== 'url' || typeof server.url !== 'string' || !server.url) throw new ValidationError(`mcp_servers[${index}] requires a URL`);
    const configuration = asRecord(server.tool_configuration);
    tools.push({
      type: 'mcp_server', name: server.name, url: server.url,
      ...(server.authorization_token ? { headers: { Authorization: server.authorization_token } } : {}),
      ...(Array.isArray(configuration?.allowed_tools) ? { allowed_tools: { tools: configuration.allowed_tools } } : {}),
    });
  }

  const choice = request.tool_choice;
  if (choice?.type === 'auto' || choice?.type === 'none') generation.tool_choice = choice.type;
  else if (choice?.type === 'any') generation.tool_choice = 'any';
  else if (choice?.type === 'tool') {
    if (typeof choice.name !== 'string' || !choice.name) throw new ValidationError('tool_choice tool requires name');
    generation.tool_choice = { allowed_tools: { mode: 'validated', tools: [choice.name] } };
  }
  if (choice && 'disable_parallel_tool_use' in choice && choice.disable_parallel_tool_use !== undefined) {
    warn(options, 'tool_choice.disable_parallel_tool_use has no Interactions equivalent; dropped');
  }

  const body: Record<string, unknown> = {
    model,
    input,
    ...(system ? { system_instruction: system } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    generation_config: generation,
    ...(request.stream === true ? { stream: true } : {}),
  };
  const format = asRecord(request.output_config?.format);
  if (format?.type === 'json_schema') {
    if (!asRecord(format.schema)) throw new ValidationError('output_config.format json_schema requires schema');
    body.response_format = format.schema;
  } else if (format !== undefined) {
    throw new ValidationError(`output_config.format type ${stringify(format.type)} has no Interactions equivalent`);
  }
  if (request.metadata !== undefined) warn(options, 'metadata has no field in the new Interactions contract; dropped');
  return body;
}
