import type { Logger } from '../types/shared.js';
import { isBlobRef, rebindBlobRef } from '../utils/blob-refs.js';
import { ValidationError } from '../utils/errors.js';
import { stringify } from '../utils/stringify.js';
import { classifyInteractionsInput, functionArgs, interactionResponseSchema, type InteractionsInputEntry } from './interactions-to-gemini.js';

interface ConversionOptions {
  logger?: Logger;
  requestId?: string;
  systemMessagesAsDeveloper?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function warn(options: ConversionOptions | undefined, message: string): void {
  options?.logger?.warn(options.requestId ?? '', `[interactions->responses] ${message}`);
}

function dataUri(data: unknown, mimeType: unknown, position: string): string | ReturnType<typeof rebindBlobRef> {
  const mime = typeof mimeType === 'string' && mimeType !== '' ? mimeType : 'application/octet-stream';
  const prefix = `data:${mime};base64,`;
  if (isBlobRef(data)) return rebindBlobRef(data, position.startsWith('input-image') ? 'responses-input-image' : 'responses-input-file', prefix);
  if (typeof data !== 'string' || data === '') throw new ValidationError(`${position} requires non-empty base64 data`);
  return `${prefix}${data}`;
}

function contentParts(
  content: unknown,
  role: 'user' | 'assistant',
  where: string,
  options?: ConversionOptions,
): Array<Record<string, unknown>> {
  if (typeof content === 'string') {
    return [{ type: role === 'assistant' ? 'output_text' : 'input_text', text: content }];
  }
  if (!Array.isArray(content)) throw new ValidationError(`${where} must be a string or an array of Content parts`);
  const result: Array<Record<string, unknown>> = [];
  for (const [index, value] of content.entries()) {
    const part = asRecord(value);
    if (!part) throw new ValidationError(`${where}[${index}] must be an object`);
    const at = `${where}[${index}]`;
    if ((part.type === 'text' || part.type === undefined) && typeof part.text === 'string') {
      result.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: part.text });
      continue;
    }
    const inline = asRecord(part.inline_data ?? part.inlineData);
    if (inline) {
      const mime = inline.mime_type ?? inline.mimeType;
      if (role === 'assistant' || typeof mime === 'string' && (mime.startsWith('audio/') || mime.startsWith('video/'))) {
        warn(options, `${at} inline media ${stringify(mime)} has no Responses input-message position; dropped`);
      } else if (mime === 'application/pdf') {
        result.push({
          type: 'input_file',
          file_data: dataUri(inline.data, mime, `input-file:${at}`),
          filename: 'document.pdf',
        });
      } else {
        result.push({ type: 'input_image', image_url: dataUri(inline.data, mime, `input-image:${at}`) });
      }
      continue;
    }
    if (part.type === 'image_url' || part.type === undefined && part.image_url !== undefined) {
      if (role === 'assistant') {
        warn(options, `${at} image_url has no Responses output-message position; dropped`);
        continue;
      }
      const image = asRecord(part.image_url);
      const url = typeof part.image_url === 'string' ? part.image_url : image?.url;
      if (typeof url === 'string' || isBlobRef(url)) result.push({ type: 'input_image', image_url: url });
      else throw new ValidationError(`${at}.image_url.url is required`);
      continue;
    }
    if (part.type === 'image') {
      if (role === 'assistant') {
        warn(options, `${at} image has no Responses output-message position; dropped`);
        continue;
      }
      if (typeof part.uri === 'string' && part.uri !== '') {
        result.push({ type: 'input_image', image_url: part.uri });
      } else {
        result.push({ type: 'input_image', image_url: dataUri(part.data, part.mime_type, `input-image:${at}`) });
      }
      continue;
    }
    if (part.type === 'document' && role === 'user') {
      if (typeof part.uri === 'string' && part.uri !== '') {
        result.push({ type: 'input_file', file_url: part.uri });
      } else {
        result.push({
          type: 'input_file',
          file_data: dataUri(part.data, part.mime_type ?? 'application/pdf', `input-file:${at}`),
          filename: 'document.pdf',
        });
      }
      continue;
    }
    throw new ValidationError(`${at} type ${stringify(part.type)} needs a Responses item of its own or has no Responses equivalent`);
  }
  return result;
}

function thoughtToReasoning(step: Record<string, unknown>, options?: ConversionOptions): Record<string, unknown> | undefined {
  if (step.signature !== undefined) {
    warn(options, 'thought.signature is provider-specific and is not mapped to Responses reasoning.encrypted_content');
  }
  const summary = Array.isArray(step.summary)
    ? step.summary.map(asRecord).filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => ({ type: 'summary_text', text: part!.text as string }))
    : [];
  const legacyText = asRecord(asRecord(step.summary)?.content)?.text;
  if (summary.length === 0 && typeof legacyText === 'string' && legacyText !== '') {
    summary.push({ type: 'summary_text', text: legacyText });
  }
  return summary.length > 0 ? { type: 'reasoning', summary } : undefined;
}

function appendStep(
  input: Array<Record<string, unknown>>,
  step: Record<string, unknown>,
  where: string,
  options?: ConversionOptions,
): void {
  if (step.type === 'user_input' || step.type === 'model_output') {
    const role = step.type === 'model_output' ? 'assistant' : 'user';
    input.push({ type: 'message', role, content: contentParts(step.content, role, `${where}.content`, options) });
    return;
  }
  if (step.type === 'function_call') {
    const callId = step.call_id ?? step.id;
    if (typeof callId !== 'string' || callId === '' || typeof step.name !== 'string' || step.name === '') {
      throw new ValidationError(`${where} function_call requires id/call_id and name`);
    }
    if (step.signature !== undefined) warn(options, `${where}.signature has no Responses function_call equivalent; dropped`);
    input.push({
      type: 'function_call',
      call_id: callId,
      name: step.name,
      arguments: stringify(functionArgs(step.arguments, `${where}.arguments`)),
    });
    return;
  }
  if (step.type === 'function_result') {
    if (typeof step.call_id !== 'string' || step.call_id === '') {
      throw new ValidationError(`${where} function_result requires call_id`);
    }
    if (step.is_error !== undefined) warn(options, `${where}.is_error has no Responses function_call_output equivalent; dropped`);
    if (step.signature !== undefined) warn(options, `${where}.signature has no Responses function_call_output equivalent; dropped`);
    input.push({
      type: 'function_call_output',
      call_id: step.call_id,
      output: typeof step.result === 'string'
        ? step.result
        : Array.isArray(step.result)
          ? contentParts(step.result, 'user', `${where}.result`, options)
          : stringify(step.result ?? ''),
    });
    return;
  }
  if (step.type === 'thought') {
    const reasoning = thoughtToReasoning(step, options);
    if (reasoning) input.push(reasoning);
    return;
  }
  throw new ValidationError(`${where} type ${stringify(step.type)} has no direct Responses input mapping`);
}

function appendTurn(
  input: Array<Record<string, unknown>>,
  systemTexts: string[],
  turn: Record<string, unknown>,
  where: string,
  options?: ConversionOptions,
): void {
  if (turn.role === 'system' || turn.role === 'developer') {
    const parts = contentParts(turn.content, 'user', `${where}.content`, options);
    if (options?.systemMessagesAsDeveloper) {
      input.push({ type: 'message', role: 'developer', content: parts });
    } else {
      systemTexts.push(...parts.filter(part => part.type === 'input_text').map(part => part.text as string));
    }
    return;
  }
  const role = turn.role === 'model' || turn.role === 'assistant' ? 'assistant' : 'user';
  input.push({ type: 'message', role, content: contentParts(turn.content, role, `${where}.content`, options) });
}

function withLeadingDeveloperMessages(
  input: Array<Record<string, unknown>>,
  options?: ConversionOptions,
): Array<Record<string, unknown>> {
  if (!options?.systemMessagesAsDeveloper) return input;
  return [
    ...input.filter(item => item.type === 'message' && item.role === 'developer'),
    ...input.filter(item => item.type !== 'message' || item.role !== 'developer'),
  ];
}

function interactionInputToResponses(
  value: unknown,
  systemTexts: string[],
  options?: ConversionOptions,
): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  if (typeof value === 'string') {
    return [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: value }] }];
  }
  if (value === undefined || value === null) throw new ValidationError('Interactions input is required');
  const record = asRecord(value);
  if (record && Array.isArray(record.messages)) {
    for (const [index, message] of record.messages.entries()) {
      const turn = asRecord(message);
      if (!turn) throw new ValidationError(`input.messages[${index}] must be an object`);
      appendTurn(input, systemTexts, turn, `input.messages[${index}]`, options);
    }
    return withLeadingDeveloperMessages(input, options);
  }
  const entries: InteractionsInputEntry[] = classifyInteractionsInput(Array.isArray(value) ? value : [value], 'input');
  for (const entry of entries) {
    if (entry.kind === 'turn') appendTurn(input, systemTexts, entry.element, `input[${entry.index}]`, options);
    else if (entry.kind === 'step') appendStep(input, entry.step, `input[${entry.index}]`, options);
    else input.push({
      type: 'message',
      role: 'user',
      content: contentParts(entry.parts, 'user', `input[${entry.start}]`, options),
    });
  }
  if (input.length === 0 && systemTexts.length === 0) throw new ValidationError('Interactions input produced no Responses items');
  return withLeadingDeveloperMessages(input, options);
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
    const type = tool.type;
    if (type === 'function' || typeof tool.name === 'string' && type === undefined) {
      if (typeof tool.name !== 'string' || tool.name === '') throw new ValidationError(`tools[${index}] function requires name`);
      const fn = {
        type: 'function',
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        parameters: tool.parameters ?? { type: 'object', properties: {} },
        ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
      };
      converted.push(fn);
      functionsByName.set(tool.name, fn);
    } else if (type === 'google_search') {
      const searchTypes = Array.isArray(tool.search_types) ? tool.search_types : [];
      if (searchTypes.some(entry => !['web_search', 'image_search'].includes(String(entry)))) {
        throw new ValidationError(`tools[${index}].search_types has no Responses web_search equivalent`);
      }
      const contentTypes = searchTypes.flatMap(entry => entry === 'web_search' ? ['text'] : entry === 'image_search' ? ['image'] : []);
      converted.push({ type: 'web_search', ...(contentTypes.length > 0 ? { search_content_types: contentTypes } : {}) });
      if (tool.queries !== undefined) warn(options, `tools[${index}].queries has no Responses web_search equivalent; dropped`);
    } else if (type === 'code_execution') {
      converted.push({ type: 'code_interpreter', container: { type: 'auto' } });
    } else if (type === 'mcp_server') {
      if (typeof tool.url !== 'string' || tool.url === '') throw new ValidationError(`tools[${index}] mcp_server requires url for Responses MCP`);
      const allowed = asRecord(tool.allowed_tools);
      const allowedTools = Array.isArray(allowed?.tools)
        ? allowed.tools.filter((name): name is string => typeof name === 'string')
        : Array.isArray(tool.allowed_tools)
          ? tool.allowed_tools.map(entry => asRecord(entry)?.name).filter((name): name is string => typeof name === 'string')
          : [];
      if (allowed?.mode !== undefined) warn(options, `tools[${index}].allowed_tools.mode has no Responses MCP equivalent; dropped`);
      converted.push({
        type: 'mcp',
        server_label: typeof tool.name === 'string' && tool.name !== '' ? tool.name : tool.url,
        server_url: tool.url,
        ...(tool.headers !== undefined ? { headers: tool.headers } : {}),
        ...(allowedTools.length > 0 ? { allowed_tools: allowedTools } : {}),
      });
    } else {
      warn(options, `tools[${index}] type ${stringify(type)} has no faithful Responses tool mapping; dropped`);
    }
  }
  return { tools: converted, functionsByName };
}

function responseToolChoice(
  value: unknown,
  functionsByName: Map<string, Record<string, unknown>>,
): unknown {
  if (value === undefined) return undefined;
  if (value === 'auto' || value === 'none' || value === 'dynamic') return value === 'dynamic' ? 'auto' : value;
  if (value === 'any') return 'required';
  const choice = asRecord(value);
  if (!choice) throw new ValidationError('Interactions tool_choice must be a string or object');
  const allowed = asRecord(choice.allowed_tools);
  const rawNames = allowed?.tools ?? choice.tools;
  const functionName = asRecord(choice.function)?.name;
  const names = typeof functionName === 'string'
    ? [functionName]
    : Array.isArray(rawNames) ? rawNames.filter(name => typeof name === 'string') : [];
  const mode = allowed?.mode ?? choice.mode ?? choice.type;
  if (names.length > 0) {
    return {
      type: 'allowed_tools',
      mode: mode === 'auto' ? 'auto' : 'required',
      tools: names.map(name => {
        const fn = functionsByName.get(name);
        if (!fn) throw new ValidationError(`Interactions tool_choice names undeclared function ${stringify(name)}`);
        return { type: 'function', name };
      }),
    };
  }
  if (mode === 'auto' || mode === 'none' || mode === 'dynamic') return mode === 'dynamic' ? 'auto' : mode;
  if (mode === 'any' || mode === 'validated') return 'required';
  throw new ValidationError(`Interactions tool_choice ${stringify(value)} has no Responses equivalent`);
}

export function interactionsToResponsesBody(
  request: Record<string, unknown>,
  model: string,
  options?: ConversionOptions,
): Record<string, unknown> {
  const systemTexts: string[] = [];
  const input = interactionInputToResponses(request.input, systemTexts, options);
  const declaredSystem = request.system_instruction ?? request.systemInstruction;
  if (typeof declaredSystem === 'string' && declaredSystem !== '') {
    if (options?.systemMessagesAsDeveloper) {
      input.unshift({ type: 'message', role: 'developer', content: [{ type: 'input_text', text: declaredSystem }] });
    } else {
      systemTexts.unshift(declaredSystem);
    }
  } else if (declaredSystem !== undefined) {
    const parts = contentParts(asRecord(declaredSystem)?.parts ?? declaredSystem, 'user', 'system_instruction', options);
    if (options?.systemMessagesAsDeveloper) {
      input.unshift({ type: 'message', role: 'developer', content: parts });
    } else {
      systemTexts.unshift(...parts.filter(part => part.type === 'input_text').map(part => part.text as string));
    }
  }

  const body: Record<string, unknown> = {
    model,
    input,
    ...(systemTexts.length > 0 ? { instructions: systemTexts.join('\n') } : {}),
    ...(request.stream === true ? { stream: true } : {}),
    ...(typeof request.store === 'boolean' ? { store: request.store } : {}),
    ...(typeof request.background === 'boolean' ? { background: request.background } : {}),
  };
  if (request.labels !== undefined) body.metadata = request.labels;

  const config = asRecord(request.generation_config ?? request.generationConfig) ?? {};
  if (typeof config.temperature === 'number') body.temperature = config.temperature;
  if (typeof config.top_p === 'number') body.top_p = config.top_p;
  if (typeof config.max_output_tokens === 'number') body.max_output_tokens = config.max_output_tokens;
  const reasoning: Record<string, unknown> = {};
  if (typeof config.thinking_level === 'string') {
    reasoning.effort = config.thinking_level === 'minimal' ? 'minimal' : config.thinking_level;
  }
  if (config.thinking_summaries === 'auto') reasoning.summary = 'auto';
  if (Object.keys(reasoning).length > 0) body.reasoning = reasoning;

  const { tools, functionsByName } = responseTools(request.tools, options);
  if (tools.length > 0) body.tools = tools;
  const toolChoice = responseToolChoice(config.tool_choice ?? config.toolChoice, functionsByName);
  if (toolChoice !== undefined) body.tool_choice = toolChoice;

  const responseFormat = interactionResponseSchema(request.response_format ?? config.response_format);
  if (responseFormat !== undefined) {
    body.text = { format: { type: 'json_schema', name: 'response', schema: responseFormat } };
  } else if ((request.response_mime_type ?? config.response_mime_type) === 'application/json') {
    body.text = { format: { type: 'json_object' } };
  }

  const unsupported = [
    ['previous_interaction_id', request.previous_interaction_id],
    ['cached_content', request.cached_content],
    ['response_modalities', request.response_modalities],
    ['agent', request.agent],
    ['agent_config', request.agent_config],
    ['generation_config.stop_sequences', config.stop_sequences ?? config.stopSequences],
    ['generation_config.seed', config.seed],
    ['generation_config.speech_config', config.speech_config ?? config.speechConfig],
    ['generation_config.image_config', config.image_config ?? config.imageConfig],
  ] as const;
  for (const [field, value] of unsupported) {
    if (value !== undefined) warn(options, `${field} has no faithful Responses equivalent; dropped`);
  }
  return body;
}
