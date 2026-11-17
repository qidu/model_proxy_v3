import type { Logger } from '../types/shared.js';
import { isBlobRef, rebindBlobRef } from '../utils/blob-refs.js';
import { ValidationError } from '../utils/errors.js';
import { stringify } from '../utils/stringify.js';
import { normalizeEffort, recursivelyCleanSchema } from './claude-to-openai.js';
import { classifyInteractionsInput, functionArgs, type InteractionsInputEntry } from './interactions-to-gemini.js';

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
  options?.logger?.warn(options.requestId ?? '', `[interactions->claude] ${message}`);
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
    content: blocks.every(block => block.type === 'text') ? blocks.map(block => block.text as string).join('') : blocks,
  });
}

function mediaBlock(
  part: Record<string, unknown>,
  role: 'user' | 'assistant',
  where: string,
  options?: ConversionOptions,
): Record<string, unknown> | undefined {
  const inline = asRecord(part.inlineData ?? part.inline_data);
  const source = asRecord(part.source);
  const isMedia = inline || source || ['image', 'audio', 'video', 'document'].includes(String(part.type));
  if (!isMedia) return undefined;
  const mime = part.mime_type ?? part.mimeType ?? inline?.mime_type ?? inline?.mimeType ?? source?.media_type
    ?? (part.type === 'document' ? 'application/pdf' : 'image/jpeg');
  if (part.type === 'audio' || part.type === 'video' || typeof mime === 'string' && (mime.startsWith('audio/') || mime.startsWith('video/'))) {
    warn(options, `${where} media ${stringify(mime)} has no Claude Messages content block; dropped`);
    return undefined;
  }
  if (role === 'assistant') {
    warn(options, `${where} media has no Claude assistant-history content block; dropped`);
    return undefined;
  }

  let resolvedSource: Record<string, unknown>;
  if (source?.type === 'base64' || source?.type === 'url') {
    resolvedSource = {
      ...source,
      ...(isBlobRef(source.data) ? { data: rebindBlobRef(source.data, 'claude-source-data', '') } : {}),
    };
  } else {
    const uri = part.uri;
    if (typeof uri === 'string' && uri !== '') {
      if (!/^https?:\/\//.test(uri)) throw new ValidationError(`${where}.uri cannot be used as a Claude URL source`);
      resolvedSource = { type: 'url', url: uri };
    } else {
      const data = inline?.data ?? part.data;
      if (typeof data !== 'string' && !isBlobRef(data)) throw new ValidationError(`${where} requires base64 data or a URL`);
      if (typeof data === 'string' && data === '') throw new ValidationError(`${where} requires non-empty base64 data`);
      resolvedSource = {
        type: 'base64', media_type: mime,
        data: isBlobRef(data) ? rebindBlobRef(data, 'claude-source-data', '') : data,
      };
    }
  }
  return {
    type: part.type === 'document' || typeof mime === 'string' && !mime.startsWith('image/') ? 'document' : 'image',
    source: resolvedSource,
    ...(part.name !== undefined ? { title: part.name } : {}),
  };
}

function contentToClaudeBlocks(
  content: unknown,
  role: 'user' | 'assistant',
  where: string,
  options?: ConversionOptions,
): Array<Record<string, unknown>> {
  if (typeof content === 'string') return content === '' ? [] : [{ type: 'text', text: content }];
  if (!Array.isArray(content)) throw new ValidationError(`${where} must be a string or an array of Content parts`);
  const blocks: Array<Record<string, unknown>> = [];
  for (const [index, value] of content.entries()) {
    const part = asRecord(value);
    if (!part) throw new ValidationError(`${where}[${index}] must be an object`);
    const at = `${where}[${index}]`;
    if ((part.type === 'text' || part.type === 'input_text' || part.type === 'output_text' || part.type === undefined) && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    if (part.type === 'image_url') {
      const image = asRecord(part.image_url);
      const url = typeof part.image_url === 'string' ? part.image_url : image?.url;
      if (typeof url !== 'string' || url === '') throw new ValidationError(`${at}.image_url.url is required`);
      if (role === 'assistant') {
        warn(options, `${at} image_url has no Claude assistant-history content block; dropped`);
      } else {
        blocks.push({ type: 'image', source: { type: 'url', url } });
      }
      continue;
    }
    const media = mediaBlock(part, role, at, options);
    if (media) blocks.push(media);
    else if (!asRecord(part.inlineData ?? part.inline_data) && !asRecord(part.source) && !['image', 'audio', 'video', 'document'].includes(String(part.type))) {
      throw new ValidationError(`${at} type ${stringify(part.type)} has no Claude content-block equivalent`);
    }
  }
  return blocks;
}

function thoughtToClaude(step: Record<string, unknown>): Record<string, unknown> | undefined {
  const summary = Array.isArray(step.summary)
    ? step.summary.map(asRecord).filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part!.text as string).join('')
    : '';
  const legacy = asRecord(asRecord(step.summary)?.content)?.text;
  const text = summary || (typeof legacy === 'string' ? legacy : '');
  const signature = typeof step.signature === 'string' && step.signature !== '' ? step.signature : undefined;
  if (text === '' && !signature) return undefined;
  return { type: 'thinking', thinking: text, ...(signature ? { signature } : {}) };
}

function appendStep(
  messages: Array<Record<string, unknown>>,
  step: Record<string, unknown>,
  where: string,
  options?: ConversionOptions,
): void {
  if (step.type === 'user_input' || step.type === 'model_output') {
    const role = step.type === 'model_output' ? 'assistant' : 'user';
    appendMessage(messages, role, contentToClaudeBlocks(step.content, role, `${where}.content`, options));
    return;
  }
  if (step.type === 'function_call') {
    const id = step.call_id ?? step.id;
    if (typeof id !== 'string' || id === '' || typeof step.name !== 'string' || step.name === '') {
      throw new ValidationError(`${where} function_call requires id/call_id and name`);
    }
    appendMessage(messages, 'assistant', [{
      type: 'tool_use', id, name: step.name, input: functionArgs(step.arguments, `${where}.arguments`),
    }]);
    return;
  }
  if (step.type === 'function_result') {
    if (typeof step.call_id !== 'string' || step.call_id === '') throw new ValidationError(`${where} function_result requires call_id`);
    appendMessage(messages, 'user', [{
      type: 'tool_result', tool_use_id: step.call_id,
      content: typeof step.result === 'string' ? step.result : stringify(step.result ?? ''),
    }]);
    return;
  }
  if (step.type === 'thought') {
    const thinking = thoughtToClaude(step);
    if (thinking) appendMessage(messages, 'assistant', [thinking]);
    return;
  }
  if (step.type === 'mcp_server_tool_call') {
    if (typeof step.id !== 'string' || step.id === '' || typeof step.name !== 'string' || step.name === '') {
      throw new ValidationError(`${where} MCP call requires id and name`);
    }
    appendMessage(messages, 'assistant', [{
      type: 'mcp_tool_use', id: step.id, name: step.name,
      input: asRecord(step.arguments) ?? {},
      ...(typeof step.server_name === 'string' ? { server_name: step.server_name } : {}),
    }]);
    return;
  }
  if (step.type === 'mcp_server_tool_result') {
    if (typeof step.call_id !== 'string' || step.call_id === '') throw new ValidationError(`${where} MCP result requires call_id`);
    appendMessage(messages, 'user', [{
      type: 'mcp_tool_result', tool_use_id: step.call_id,
      content: typeof step.result === 'string' ? step.result : stringify(step.result ?? ''),
      ...(typeof step.server_name === 'string' ? { server_name: step.server_name } : {}),
    }]);
    return;
  }
  if (step.type === 'google_search_call') {
    if (typeof step.id !== 'string' || step.id === '') throw new ValidationError(`${where} search call requires id`);
    appendMessage(messages, 'assistant', [{
      type: 'server_tool_use', id: step.id, name: 'web_search', input: asRecord(step.arguments) ?? {},
    }]);
    return;
  }
  throw new ValidationError(`${where} type ${stringify(step.type)} has no direct Claude input mapping`);
}

function appendTurn(
  messages: Array<Record<string, unknown>>,
  system: string[],
  turn: Record<string, unknown>,
  where: string,
  options?: ConversionOptions,
): void {
  const role = turn.role === 'model' || turn.role === 'assistant' ? 'assistant' : 'user';
  const blocks = contentToClaudeBlocks(turn.content, role, `${where}.content`, options);
  if (turn.role === 'system' || turn.role === 'developer') {
    for (const [index, block] of blocks.entries()) {
      if (block.type !== 'text') throw new ValidationError(`${where}.content[${index}] system instructions must be text`);
      system.push(block.text as string);
    }
  } else {
    appendMessage(messages, role, blocks);
  }
}

function interactionInputToClaude(
  value: unknown,
  system: string[],
  options?: ConversionOptions,
): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  if (typeof value === 'string') {
    appendMessage(messages, 'user', [{ type: 'text', text: value }]);
    return messages;
  }
  if (value === undefined || value === null) throw new ValidationError('Interactions input is required');
  const record = asRecord(value);
  if (record && Array.isArray(record.messages)) {
    for (const [index, message] of record.messages.entries()) {
      const turn = asRecord(message);
      if (!turn) throw new ValidationError(`input.messages[${index}] must be an object`);
      appendTurn(messages, system, turn, `input.messages[${index}]`, options);
    }
  } else {
    const entries: InteractionsInputEntry[] = classifyInteractionsInput(Array.isArray(value) ? value : [value], 'input');
    for (const entry of entries) {
      if (entry.kind === 'turn') appendTurn(messages, system, entry.element, `input[${entry.index}]`, options);
      else if (entry.kind === 'step') appendStep(messages, entry.step, `input[${entry.index}]`, options);
      else appendMessage(messages, 'user', contentToClaudeBlocks(entry.parts, 'user', `input[${entry.start}]`, options));
    }
  }
  // No placeholder thinking block is fabricated here. DeepSeek's
  // Anthropic-compatible endpoint requires a `content[].thinking` block on an
  // assistant turn that carried tool_use, but it is the only upstream that
  // tolerates the unsigned block that would satisfy it — `ThinkingBlockParam`
  // requires `signature`, which this converter has no way to mint. A target that
  // needs the shim opts in via the `inject_missing_thinking_block` builtin.
  if (messages.length === 0) throw new ValidationError('Interactions input produced no Claude messages');
  return messages;
}

function claudeTools(
  value: unknown,
  options?: ConversionOptions,
): { tools: Array<Record<string, unknown>>; mcpServers: Array<Record<string, unknown>>; functionNames: Set<string> } {
  const tools: Array<Record<string, unknown>> = [];
  const mcpServers: Array<Record<string, unknown>> = [];
  const functionNames = new Set<string>();
  for (const [index, entry] of (Array.isArray(value) ? value : []).entries()) {
    const tool = asRecord(entry);
    if (!tool) throw new ValidationError(`tools[${index}] must be an object`);
    if (tool.type === 'function' || typeof tool.name === 'string' && tool.type === undefined) {
      if (typeof tool.name !== 'string' || tool.name === '') throw new ValidationError(`tools[${index}] function requires name`);
      functionNames.add(tool.name);
      tools.push({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        input_schema: recursivelyCleanSchema(asRecord(tool.parameters) ?? { type: 'object', properties: {} }),
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      });
    } else if (tool.type === 'google_search') {
      tools.push({ type: 'web_search_20250305', name: 'web_search' });
      if (tool.queries !== undefined) warn(options, `tools[${index}].queries has no Claude web_search declaration equivalent; dropped`);
    } else if (tool.type === 'code_execution') {
      tools.push({ type: 'code_execution_20250522', name: 'code_execution' });
      if (tool.language !== undefined && tool.language !== 'python') warn(options, `tools[${index}].language ${stringify(tool.language)} has no Claude code_execution equivalent; dropped`);
    } else if (tool.type === 'mcp_server') {
      if (typeof tool.url !== 'string' || tool.url === '') throw new ValidationError(`tools[${index}] mcp_server requires url`);
      const headers = asRecord(tool.headers);
      const allowed = Array.isArray(tool.allowed_tools)
        ? tool.allowed_tools.map(entry => asRecord(entry)?.name).filter((name): name is string => typeof name === 'string')
        : [];
      if (headers && Object.keys(headers).some(name => name.toLowerCase() !== 'authorization')) {
        warn(options, `tools[${index}].headers has non-Authorization values with no Claude MCP equivalent; dropped`);
      }
      mcpServers.push({
        type: 'url', name: typeof tool.name === 'string' && tool.name !== '' ? tool.name : tool.url, url: tool.url,
        ...(typeof headers?.Authorization === 'string' ? { authorization_token: headers.Authorization } : {}),
        ...(allowed.length > 0 ? { tool_configuration: { allowed_tools: allowed } } : {}),
      });
    } else {
      warn(options, `tools[${index}] type ${stringify(tool.type)} has no faithful Claude tool mapping; dropped`);
    }
  }
  return { tools, mcpServers, functionNames };
}

function interactionToolChoice(value: unknown): { names: string[]; mode: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return { names: [], mode: value };
  const choice = asRecord(value);
  if (!choice) throw new ValidationError('Interactions tool_choice must be a string or object');
  const allowed = asRecord(choice.allowed_tools);
  const rawNames = allowed?.tools ?? choice.tools;
  const functionName = asRecord(choice.function)?.name;
  const names = typeof functionName === 'string'
    ? [functionName]
    : Array.isArray(rawNames) ? rawNames.filter((name): name is string => typeof name === 'string') : [];
  return { names, mode: String(allowed?.mode ?? choice.mode ?? choice.type ?? 'auto') };
}

export function extractInteractionsAllowedTools(request: Record<string, unknown>): Set<string> | null {
  const config = asRecord(request.generation_config ?? request.generationConfig);
  const choice = interactionToolChoice(config?.tool_choice ?? config?.toolChoice);
  return choice && choice.names.length > 0 ? new Set(choice.names) : null;
}

function claudeToolChoice(request: Record<string, unknown>, functionNames: Set<string>): Record<string, unknown> | undefined {
  const config = asRecord(request.generation_config ?? request.generationConfig);
  const choice = interactionToolChoice(config?.tool_choice ?? config?.toolChoice);
  if (!choice || functionNames.size === 0) return undefined;
  for (const name of choice.names) {
    if (!functionNames.has(name)) throw new ValidationError(`Interactions tool_choice names undeclared function ${stringify(name)}`);
  }
  if (choice.mode === 'none') return { type: 'none' };
  if (choice.names.length === 1 && ['any', 'validated', 'function'].includes(choice.mode)) return { type: 'tool', name: choice.names[0] };
  if (choice.mode === 'any' || choice.mode === 'validated') return { type: 'any' };
  if (choice.mode === 'auto' || choice.mode === 'dynamic' || choice.mode === 'function' && choice.names.length === 0) return { type: 'auto' };
  throw new ValidationError(`Interactions tool_choice ${stringify(choice)} has no Claude equivalent`);
}

export function interactionsToClaudeBody(
  request: Record<string, unknown>,
  model: string,
  options?: ConversionOptions,
): Record<string, unknown> {
  const system: string[] = [];
  const messages = interactionInputToClaude(request.input, system, options);
  const declaredSystem = request.system_instruction ?? request.systemInstruction;
  if (typeof declaredSystem === 'string' && declaredSystem !== '') system.unshift(declaredSystem);
  else if (declaredSystem !== undefined) {
    const blocks = contentToClaudeBlocks(asRecord(declaredSystem)?.parts ?? declaredSystem, 'user', 'system_instruction', options);
    system.unshift(...blocks.map(block => {
      if (block.type !== 'text') throw new ValidationError('system_instruction must contain text only');
      return block.text as string;
    }));
  }

  const config = asRecord(request.generation_config ?? request.generationConfig) ?? {};
  const { tools, mcpServers, functionNames } = claudeTools(request.tools, options);
  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: typeof config.max_output_tokens === 'number' ? config.max_output_tokens : 4096,
    stream: request.stream === true,
    ...(system.length > 0 ? { system: system.join('\n') } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(mcpServers.length > 0 ? { mcp_servers: mcpServers } : {}),
  };
  const toolChoice = claudeToolChoice(request, functionNames);
  if (toolChoice) body.tool_choice = toolChoice;
  if (typeof config.temperature === 'number') body.temperature = config.temperature;
  if (typeof config.top_p === 'number') body.top_p = config.top_p;
  const stop = config.stop_sequences ?? config.stopSequences;
  if (Array.isArray(stop) && stop.length > 0) body.stop_sequences = stop;
  else if (typeof stop === 'string' && stop !== '') body.stop_sequences = [stop];

  const outputConfig: Record<string, unknown> = {};
  const effort = normalizeEffort(typeof config.thinking_level === 'string' ? config.thinking_level : undefined);
  if (effort) outputConfig.effort = effort;
  const responseFormat = request.response_format ?? config.response_format;
  if (responseFormat !== undefined) {
    if (!asRecord(responseFormat)) throw new ValidationError('Interactions response_format must be an object');
    outputConfig.format = { type: 'json_schema', schema: responseFormat };
  } else if ((request.response_mime_type ?? config.response_mime_type) === 'application/json') {
    outputConfig.format = { type: 'json_schema', schema: { type: 'object' } };
  }
  if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;
  if (config.thinking_summaries === 'auto') body.thinking = { type: 'enabled' };
  else if (config.thinking_summaries === 'none') body.thinking = { type: 'disabled' };

  const labels = asRecord(request.labels);
  if (typeof labels?.user_id === 'string' && labels.user_id !== '') body.metadata = { user_id: labels.user_id };
  if (labels && Object.keys(labels).some(key => key !== 'user_id')) {
    warn(options, 'labels not carried to the anthropic-messages upstream: Claude metadata accepts only user_id; dropped');
  }
  const unsupported = [
    ['previous_interaction_id', request.previous_interaction_id],
    ['cached_content', request.cached_content],
    ['response_modalities', request.response_modalities],
    ['agent', request.agent],
    ['agent_config', request.agent_config],
    ['store', request.store],
    ['background', request.background],
    ['generation_config.seed', config.seed],
    ['generation_config.speech_config', config.speech_config ?? config.speechConfig],
  ] as const;
  for (const [field, value] of unsupported) {
    if (value !== undefined) warn(options, `${field} has no faithful Claude Messages equivalent; dropped`);
  }
  return body;
}
