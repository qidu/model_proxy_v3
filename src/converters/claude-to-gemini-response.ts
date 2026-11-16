import type { Logger } from '../types/shared.js';
import { stringify } from '../utils/stringify.js';
import { parseToolArguments } from './openai-to-gemini.js';

interface ConversionOptions {
  logger?: Logger;
  requestId?: string;
  allowedTools?: Set<string> | null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function warn(options: ConversionOptions | undefined, message: string): void {
  options?.logger?.warn(options.requestId ?? '', `[claude->gemini] ${message}`);
}

function claudeUsageToGemini(value: unknown): Record<string, number> {
  const usage = asRecord(value);
  const input = typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0;
  const cached = typeof usage?.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
  const written = typeof usage?.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
  const output = typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0;
  return {
    promptTokenCount: input + cached + written,
    candidatesTokenCount: output,
    totalTokenCount: input + cached + written + output,
    ...(cached > 0 ? { cachedContentTokenCount: cached } : {}),
  };
}

function claudeFinishReason(value: unknown, options?: ConversionOptions): string {
  switch (value) {
    case 'max_tokens': return 'MAX_TOKENS';
    case 'refusal': return 'SAFETY';
    case 'timeout': return 'OTHER';
    case 'end_turn':
    case 'stop_sequence':
    case 'tool_use':
    case undefined:
    case null:
      return 'STOP';
    default:
      warn(options, `unmapped Claude stop_reason ${stringify(value)}; finishReason is OTHER`);
      return 'OTHER';
  }
}

function toolUsePart(
  block: Record<string, unknown>,
  index: number,
  options?: ConversionOptions,
): Record<string, unknown> | undefined {
  if (typeof block.name !== 'string' || block.name === '') {
    warn(options, `tool_use ${index} has no name; dropped`);
    return undefined;
  }
  if (options?.allowedTools != null && !options.allowedTools.has(block.name)) return undefined;
  const id = typeof block.id === 'string' && block.id !== '' ? block.id : `call_${index}`;
  return { functionCall: { id, name: block.name, args: asRecord(block.input) ?? {} } };
}

export function claudeToGeminiResponse(
  response: Record<string, unknown>,
  model: string,
  options?: ConversionOptions,
): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [];
  const content = Array.isArray(response.content) ? response.content : [];
  let suppressed = 0;
  for (const [index, value] of content.entries()) {
    const block = asRecord(value);
    if (!block) {
      warn(options, `content[${index}] is not an object; dropped`);
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ text: block.text });
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      parts.push({
        thought: true, text: block.thinking,
        ...(typeof block.signature === 'string' && block.signature !== '' ? { thoughtSignature: block.signature } : {}),
      });
    } else if (block.type === 'tool_use') {
      const part = toolUsePart(block, index, options);
      if (part) parts.push(part);
      else if (options?.allowedTools != null && typeof block.name === 'string' && !options.allowedTools.has(block.name)) suppressed++;
    } else {
      warn(options, `content[${index}] type ${stringify(block.type)} has no generateContent response part; dropped`);
    }
  }
  if (suppressed > 0) warn(options, `suppressed ${suppressed} tool call(s) outside allowedFunctionNames`);
  return {
    model: typeof response.model === 'string' ? response.model : model,
    candidates: [{
      content: { role: 'model', parts }, index: 0,
      finishReason: claudeFinishReason(response.stop_reason, options),
    }],
    usageMetadata: claudeUsageToGemini(response.usage),
  };
}

interface PendingCall {
  id: string;
  name: string;
  arguments: string;
}

interface PendingThinking {
  text: string;
  signature?: string;
}

interface UsageAccumulator {
  input?: number;
  cached?: number;
  written?: number;
  output?: number;
}

export interface ClaudeGeminiStreamState {
  model: string;
  pendingCalls: Map<number, PendingCall>;
  thinking: Map<number, PendingThinking>;
  usage: UsageAccumulator;
  finished: boolean;
  suppressed: number;
  warned: Set<string>;
}

export function createClaudeGeminiStreamState(model: string): ClaudeGeminiStreamState {
  return {
    model, pendingCalls: new Map(), thinking: new Map(), usage: {},
    finished: false, suppressed: 0, warned: new Set(),
  };
}

function absorbUsage(state: ClaudeGeminiStreamState, value: unknown): void {
  const usage = asRecord(value);
  if (!usage) return;
  if (typeof usage.input_tokens === 'number') state.usage.input = usage.input_tokens;
  if (typeof usage.output_tokens === 'number') state.usage.output = usage.output_tokens;
  if (typeof usage.cache_read_input_tokens === 'number') state.usage.cached = usage.cache_read_input_tokens;
  if (typeof usage.cache_creation_input_tokens === 'number') state.usage.written = usage.cache_creation_input_tokens;
}

function streamUsage(state: ClaudeGeminiStreamState): Record<string, number> | undefined {
  const usage = state.usage;
  if (usage.input === undefined && usage.output === undefined && usage.cached === undefined && usage.written === undefined) return undefined;
  const input = (usage.input ?? 0) + (usage.cached ?? 0) + (usage.written ?? 0);
  const output = usage.output ?? 0;
  return {
    promptTokenCount: input, candidatesTokenCount: output, totalTokenCount: input + output,
    ...(usage.cached !== undefined && usage.cached > 0 ? { cachedContentTokenCount: usage.cached } : {}),
  };
}

function geminiChunk(
  state: ClaudeGeminiStreamState,
  parts: Array<Record<string, unknown>>,
  finishReason?: string,
): Record<string, unknown> {
  return {
    model: state.model,
    candidates: [{ content: { role: 'model', parts }, index: 0, ...(finishReason ? { finishReason } : {}) }],
    usageMetadata: streamUsage(state) ?? { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
  };
}

function warnStreamType(state: ClaudeGeminiStreamState, type: unknown, options?: ConversionOptions): void {
  const key = stringify(type);
  if (state.warned.has(key)) return;
  state.warned.add(key);
  warn(options, `stream content type ${key} has no generateContent response part; dropped`);
}

function flushThinking(state: ClaudeGeminiStreamState, index: number): Record<string, unknown>[] {
  const thinking = state.thinking.get(index);
  state.thinking.delete(index);
  if (!thinking || thinking.text === '' && !thinking.signature) return [];
  return [{
    thought: true,
    ...(thinking.text !== '' ? { text: thinking.text } : {}),
    ...(thinking.signature ? { thoughtSignature: thinking.signature } : {}),
  }];
}

function flushCall(state: ClaudeGeminiStreamState, index: number, options?: ConversionOptions): Record<string, unknown>[] {
  const call = state.pendingCalls.get(index);
  state.pendingCalls.delete(index);
  if (!call) return [];
  if (call.name === '') {
    warn(options, `streamed tool_use ${call.id || `at content block ${index}`} has no name; dropped`);
    return [];
  }
  if (options?.allowedTools != null && !options.allowedTools.has(call.name)) {
    state.suppressed++;
    return [];
  }
  return [{ functionCall: { id: call.id || `call_${index}`, name: call.name, args: parseToolArguments(call.arguments) } }];
}

function startBlock(
  state: ClaudeGeminiStreamState,
  index: number,
  block: Record<string, unknown>,
  options?: ConversionOptions,
): Array<Record<string, unknown>> {
  if (block.type === 'tool_use') {
    const input = asRecord(block.input);
    state.pendingCalls.set(index, {
      id: typeof block.id === 'string' ? block.id : `call_${index}`,
      name: typeof block.name === 'string' ? block.name : '',
      arguments: input && Object.keys(input).length > 0 ? stringify(input) : '',
    });
    return [];
  }
  if (block.type === 'thinking') {
    state.thinking.set(index, {
      text: typeof block.thinking === 'string' ? block.thinking : '',
      ...(typeof block.signature === 'string' && block.signature !== '' ? { signature: block.signature } : {}),
    });
    return [];
  }
  if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') return [geminiChunk(state, [{ text: block.text }])];
  if (block.type !== 'text') warnStreamType(state, block.type, options);
  return [];
}

export function claudeEventToGeminiChunks(
  state: ClaudeGeminiStreamState,
  event: Record<string, unknown>,
  options?: ConversionOptions,
): Array<Record<string, unknown>> {
  if (state.finished) return [];
  const type = event.type;
  const index = typeof event.index === 'number' ? event.index : 0;
  if (type === 'message_start') {
    const message = asRecord(event.message);
    if (typeof message?.model === 'string') state.model = message.model;
    absorbUsage(state, message?.usage);
    const chunks: Array<Record<string, unknown>> = [];
    for (const value of Array.isArray(message?.content) ? message.content : []) {
      const block = asRecord(value);
      if (block) chunks.push(...startBlock(state, index, block, options));
    }
    return chunks;
  }
  if (type === 'content_block_start') {
    const block = asRecord(event.content_block);
    return block ? startBlock(state, index, block, options) : [];
  }
  if (type === 'content_block_delta') {
    const delta = asRecord(event.delta);
    if (!delta) return [];
    if (delta.type === 'input_json_delta') {
      const call = state.pendingCalls.get(index);
      if (call && typeof delta.partial_json === 'string') call.arguments += delta.partial_json;
      return [];
    }
    if (delta.type === 'thinking_delta') {
      const thinking = state.thinking.get(index) ?? { text: '' };
      if (typeof delta.thinking === 'string') thinking.text += delta.thinking;
      state.thinking.set(index, thinking);
      return [];
    }
    if (delta.type === 'signature_delta') {
      const thinking = state.thinking.get(index) ?? { text: '' };
      if (typeof delta.signature === 'string' && delta.signature !== '') thinking.signature = delta.signature;
      state.thinking.set(index, thinking);
      return [];
    }
    if ((delta.type === 'text_delta' || delta.type === 'text' || delta.type === undefined) && typeof delta.text === 'string' && delta.text !== '') {
      return [geminiChunk(state, [{ text: delta.text }])];
    }
    return [];
  }
  if (type === 'content_block_stop') {
    const parts = [...flushThinking(state, index), ...flushCall(state, index, options)];
    return parts.length > 0 ? [geminiChunk(state, parts)] : [];
  }
  if (type === 'message_delta') {
    const delta = asRecord(event.delta);
    absorbUsage(state, event.usage);
    if (typeof delta?.stop_reason !== 'string') return [];
    const parts: Array<Record<string, unknown>> = [];
    for (const pendingIndex of Array.from(state.thinking.keys())) parts.push(...flushThinking(state, pendingIndex));
    for (const pendingIndex of Array.from(state.pendingCalls.keys())) parts.push(...flushCall(state, pendingIndex, options));
    state.finished = true;
    if (state.suppressed > 0) warn(options, `suppressed ${state.suppressed} streamed tool call(s) outside allowedFunctionNames`);
    const chunks = parts.length > 0 ? [geminiChunk(state, parts)] : [];
    chunks.push(geminiChunk(state, [], claudeFinishReason(delta.stop_reason, options)));
    return chunks;
  }
  return [];
}
