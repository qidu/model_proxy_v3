import type { Logger } from '../types/shared.js';
import { stringify } from '../utils/stringify.js';
import { parseToolArguments } from './openai-to-gemini.js';
import {
  createInteractionStreamState,
  interactionStreamCreated,
  interactionStreamCloseStep,
  interactionStreamEnded,
  interactionStreamError,
  interactionStreamFinish,
  interactionStreamReasoning,
  interactionStreamStatus,
  interactionStreamText,
  interactionStreamThoughtSignature,
  interactionStreamWholeStep,
  type InteractionStreamState,
} from './interactions-stream-events.js';

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
  options?.logger?.warn(options.requestId ?? '', `[claude->interactions] ${message}`);
}

function claudeUsage(value: unknown): Record<string, number> | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  const cached = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
  const written = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
  return {
    total_input_tokens: input + cached + written,
    total_output_tokens: output,
    ...(cached > 0 ? { total_cached_tokens: cached } : {}),
    total_tokens: input + cached + written + output,
  };
}

function functionCall(block: Record<string, unknown>, index: number, options?: ConversionOptions): Record<string, unknown> | undefined {
  const id = typeof block.id === 'string' && block.id !== '' ? block.id : `call_${index}`;
  if (typeof block.name !== 'string' || block.name === '') {
    warn(options, `function call ${id} has no name; dropped`);
    return undefined;
  }
  if (options?.allowedTools != null && !options.allowedTools.has(block.name)) return undefined;
  return { type: 'function_call', id, name: block.name, arguments: asRecord(block.input) ?? {} };
}

function nativeCall(block: Record<string, unknown>, index: number, options?: ConversionOptions): Record<string, unknown> | undefined {
  const id = typeof block.id === 'string' && block.id !== '' ? block.id : `call_${index}`;
  const input = asRecord(block.input) ?? {};
  if (block.type === 'mcp_tool_use') {
    if (typeof block.name !== 'string' || block.name === '') {
      warn(options, `MCP call ${id} has no name; dropped`);
      return undefined;
    }
    return {
      type: 'mcp_server_tool_call', id, name: block.name, arguments: input,
      ...(typeof block.server_name === 'string' ? { server_name: block.server_name } : {}),
    };
  }
  if (block.type === 'server_tool_use' && block.name === 'web_search') {
    return { type: 'google_search_call', id, arguments: input, search_type: 'web_search' };
  }
  if (block.type === 'server_tool_use' && block.name === 'code_execution') {
    if (typeof input.code !== 'string') {
      warn(options, `code execution call ${id} has no input.code; dropped`);
      return undefined;
    }
    return { type: 'code_execution_call', id, arguments: { code: input.code, language: 'python' } };
  }
  return undefined;
}

function nativeResult(block: Record<string, unknown>, options?: ConversionOptions): Record<string, unknown> | undefined {
  if (block.type === 'mcp_tool_result') {
    const id = block.tool_use_id ?? block.call_id;
    if (typeof id !== 'string' || id === '') {
      warn(options, 'MCP result has no tool_use_id; dropped');
      return undefined;
    }
    if (block.is_error === true) warn(options, `MCP result ${id} is_error has no Interactions MCP result field; the error content is retained`);
    return {
      type: 'mcp_server_tool_result', call_id: id,
      result: typeof block.content === 'string' ? block.content : stringify(block.content ?? block.result ?? ''),
      ...(typeof block.server_name === 'string' ? { server_name: block.server_name } : {}),
    };
  }
  if (block.type === 'code_execution_tool_result') {
    const id = block.tool_use_id ?? block.call_id;
    const content = asRecord(block.content);
    if (typeof id !== 'string' || id === '' || !content) {
      warn(options, 'code execution result requires tool_use_id and an object content; dropped');
      return undefined;
    }
    const stdout = typeof content.stdout === 'string' ? content.stdout : '';
    const stderr = typeof content.stderr === 'string' ? content.stderr : '';
    return {
      type: 'code_execution_result', call_id: id,
      result: stdout + stderr,
      is_error: block.is_error === true || typeof content.return_code === 'number' && content.return_code !== 0,
    };
  }
  return undefined;
}

function interactionError(stopReason: unknown): Record<string, unknown> {
  return {
    code: stopReason === 'refusal' ? '#FinishReason.SAFETY' : typeof stopReason === 'string' ? stopReason : 'upstream_error',
    message: stopReason === 'refusal' ? 'Claude response ended with content_filter (refusal)'
      : typeof stopReason === 'string' ? `Claude response ended with ${stopReason}` : 'Claude response failed',
  };
}

export function claudeToInteraction(
  response: Record<string, unknown>,
  model: string,
  requestId: string,
  options?: ConversionOptions,
): Record<string, unknown> {
  const outputs: Array<Record<string, unknown>> = [];
  let suppressed = 0;
  for (const [index, value] of (Array.isArray(response.content) ? response.content : []).entries()) {
    const block = asRecord(value);
    if (!block) {
      warn(options, `content[${index}] is not an object; dropped`);
      continue;
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      const annotations = Array.isArray(block.citations) ? block.citations.map(asRecord).filter(Boolean).map(citation => ({
        start_index: citation!.start_char_index ?? 0,
        end_index: citation!.end_char_index ?? 0,
        source: citation!.document_title ?? '',
      })) : [];
      outputs.push({ type: 'text', text: block.text, ...(annotations.length > 0 ? { annotations } : {}) });
      continue;
    }
    if (block.type === 'thinking') {
      const text = typeof block.thinking === 'string' ? block.thinking : '';
      const signature = typeof block.signature === 'string' && block.signature !== '' ? block.signature : undefined;
      if (text !== '' || signature) outputs.push({
        type: 'thought',
        ...(text !== '' ? { summary: { content: { type: 'text', text } } } : {}),
        ...(signature ? { signature } : {}),
      });
      continue;
    }
    if (block.type === 'tool_use') {
      const call = functionCall(block, index, options);
      if (call) outputs.push(call);
      else if (options?.allowedTools != null && typeof block.name === 'string' && !options.allowedTools.has(block.name)) suppressed++;
      continue;
    }
    const native = nativeCall(block, index, options) ?? nativeResult(block, options);
    if (native) outputs.push(native);
    else warn(options, `content[${index}] type ${stringify(block.type)} has no Interactions projection; dropped`);
  }
  if (suppressed > 0) warn(options, `suppressed ${suppressed} function call(s) outside allowed_tools`);

  const incomplete = response.stop_reason === 'max_tokens';
  const failed = response.stop_reason === 'refusal' || response.stop_reason === 'timeout';
  const requiresAction = outputs.some(output => output.type === 'function_call');
  return {
    id: `v1_${Date.now()}_${requestId}`,
    model,
    status: incomplete ? 'incomplete' : failed ? 'failed' : requiresAction ? 'requires_action' : 'completed',
    object: 'interaction', created: new Date().toISOString(), updated: new Date().toISOString(), role: 'model',
    outputs,
    ...(claudeUsage(response.usage) ? { usage: claudeUsage(response.usage) } : {}),
    ...(incomplete || failed ? { errors: [interactionError(response.stop_reason)] } : {}),
  };
}

type PendingKind = 'function' | 'mcp' | 'search' | 'code';

interface PendingCall {
  kind: PendingKind;
  id: string;
  name: string;
  serverName?: string;
  arguments: string;
}

export interface ClaudeInteractionStreamState {
  interaction: InteractionStreamState;
  pendingCalls: Map<number, PendingCall>;
  warned: Set<string>;
  suppressed: number;
  usage: Record<string, unknown>;
}

export function createClaudeInteractionStreamState(model: string, requestId: string): ClaudeInteractionStreamState {
  return {
    interaction: createInteractionStreamState(model, requestId),
    pendingCalls: new Map(), warned: new Set(), suppressed: 0, usage: {},
  };
}

function warnStreamType(state: ClaudeInteractionStreamState, type: unknown, options?: ConversionOptions): void {
  const key = stringify(type);
  if (state.warned.has(key)) return;
  state.warned.add(key);
  warn(options, `stream content type ${key} has no Interactions projection; dropped`);
}

function pendingCall(block: Record<string, unknown>, index: number): PendingCall | undefined {
  const kind: PendingKind | undefined = block.type === 'tool_use' ? 'function'
    : block.type === 'mcp_tool_use' ? 'mcp'
      : block.type === 'server_tool_use' && block.name === 'web_search' ? 'search'
        : block.type === 'server_tool_use' && block.name === 'code_execution' ? 'code' : undefined;
  if (!kind) return undefined;
  const input = asRecord(block.input);
  return {
    kind,
    id: typeof block.id === 'string' && block.id !== '' ? block.id : `call_${index}`,
    name: typeof block.name === 'string' ? block.name : '',
    ...(typeof block.server_name === 'string' ? { serverName: block.server_name } : {}),
    arguments: input && Object.keys(input).length > 0 ? stringify(input) : '',
  };
}

function flushCall(state: ClaudeInteractionStreamState, index: number, options?: ConversionOptions): Array<Record<string, unknown>> {
  const pending = state.pendingCalls.get(index);
  state.pendingCalls.delete(index);
  if (!pending) return [];
  const args = parseToolArguments(pending.arguments);
  if (pending.kind === 'function') {
    if (pending.name === '') {
      warn(options, `function call ${pending.id} has no name; dropped`);
      return [];
    }
    if (options?.allowedTools != null && !options.allowedTools.has(pending.name)) {
      state.suppressed++;
      return [];
    }
    return interactionStreamWholeStep(state.interaction, {
      type: 'function_call', id: pending.id, name: pending.name, arguments: args,
    });
  }
  if (pending.kind === 'mcp') {
    if (pending.name === '') {
      warnStreamType(state, 'mcp_call_without_name', options);
      return [];
    }
    return interactionStreamWholeStep(state.interaction, {
      type: 'mcp_server_tool_call', id: pending.id, name: pending.name, arguments: args,
      ...(pending.serverName ? { server_name: pending.serverName } : {}),
    });
  }
  if (pending.kind === 'search') {
    return interactionStreamWholeStep(state.interaction, {
      type: 'google_search_call', id: pending.id, arguments: args, search_type: 'web_search',
    });
  }
  if (typeof args.code !== 'string') {
    warnStreamType(state, 'code_execution_without_code', options);
    return [];
  }
  return interactionStreamWholeStep(state.interaction, {
    type: 'code_execution_call', id: pending.id, arguments: { code: args.code, language: 'python' },
  });
}

export function claudeEventToInteractionEvents(
  state: ClaudeInteractionStreamState,
  event: Record<string, unknown>,
  options?: ConversionOptions,
): Array<Record<string, unknown>> {
  if (state.interaction.finished) return [];
  const type = event.type;
  const index = typeof event.index === 'number' ? event.index : 0;
  if (type === 'message_start') {
    const message = asRecord(event.message);
    state.usage = { ...state.usage, ...asRecord(message?.usage) };
    const events = interactionStreamCreated(state.interaction);
    for (const value of Array.isArray(message?.content) ? message.content : []) {
      const block = asRecord(value);
      if (!block) continue;
      const pending = pendingCall(block, index);
      if (pending) state.pendingCalls.set(index, pending);
      else if (block.type === 'text' && typeof block.text === 'string') events.push(...interactionStreamText(state.interaction, block.text));
      else if (block.type === 'thinking') {
        if (typeof block.thinking === 'string') events.push(...interactionStreamReasoning(state.interaction, block.thinking));
        if (typeof block.signature === 'string') events.push(...interactionStreamThoughtSignature(state.interaction, block.signature));
      } else {
        const result = nativeResult(block, options);
        if (result) events.push(...interactionStreamWholeStep(state.interaction, result));
        else warnStreamType(state, block.type, options);
      }
    }
    return events;
  }
  if (type === 'content_block_start') {
    const block = asRecord(event.content_block);
    if (!block) return [];
    const pending = pendingCall(block, index);
    if (pending) {
      state.pendingCalls.set(index, pending);
      return [];
    }
    if (block.type === 'text' && typeof block.text === 'string') return interactionStreamText(state.interaction, block.text);
    if (block.type === 'thinking') {
      const events = typeof block.thinking === 'string' ? interactionStreamReasoning(state.interaction, block.thinking) : interactionStreamCreated(state.interaction);
      if (typeof block.signature === 'string') {
        events.push(...interactionStreamThoughtSignature(state.interaction, block.signature, block.thinking === '' || block.thinking === undefined));
      }
      return events;
    }
    const result = nativeResult(block, options);
    if (result) return interactionStreamWholeStep(state.interaction, result);
    warnStreamType(state, block.type, options);
    return [];
  }
  if (type === 'content_block_delta') {
    const delta = asRecord(event.delta);
    if (!delta) return [];
    if ((delta.type === 'text_delta' || delta.type === 'text' || delta.type === undefined) && typeof delta.text === 'string') {
      return interactionStreamText(state.interaction, delta.text);
    }
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      return interactionStreamReasoning(state.interaction, delta.thinking);
    }
    if (delta.type === 'signature_delta' && typeof delta.signature === 'string') {
      return interactionStreamThoughtSignature(state.interaction, delta.signature);
    }
    if (delta.type === 'input_json_delta') {
      const pending = state.pendingCalls.get(index);
      if (pending && typeof delta.partial_json === 'string') pending.arguments += delta.partial_json;
    }
    return [];
  }
  if (type === 'content_block_stop') {
    const closed = state.interaction.open?.kind === 'thought' ? interactionStreamCloseStep(state.interaction) : [];
    return [...closed, ...flushCall(state, index, options)];
  }
  if (type === 'message_delta') {
    const delta = asRecord(event.delta);
    if (typeof delta?.stop_reason !== 'string') return [];
    const events: Array<Record<string, unknown>> = [];
    for (const pendingIndex of Array.from(state.pendingCalls.keys())) events.push(...flushCall(state, pendingIndex, options));
    if (state.suppressed > 0) warn(options, `suppressed ${state.suppressed} streamed function call(s) outside allowed_tools`);
    state.usage = { ...state.usage, ...asRecord(event.usage) };
    interactionStreamEnded(state.interaction, claudeUsage(state.usage));
    const incomplete = delta.stop_reason === 'max_tokens';
    const failed = ['refusal', 'timeout'].includes(delta.stop_reason);
    state.interaction.incomplete = incomplete;
    state.interaction.failed = failed;
    if (incomplete || failed) events.push(...interactionStreamError(state.interaction, interactionError(delta.stop_reason)));
    events.push(...interactionStreamFinish(state.interaction, interactionStreamStatus(state.interaction)));
    return events;
  }
  return [];
}
