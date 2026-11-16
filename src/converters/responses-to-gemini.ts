import type { Logger } from '../types/shared.js';
import { stringify } from '../utils/stringify.js';
import { parseToolArguments } from './openai-to-gemini.js';
import { responsesReasoningText } from './responses-to-claude.js';

interface ConversionOptions {
  logger?: Logger;
  requestId?: string;
}

export interface ResponsesGeminiAnswer {
  response: Record<string, unknown>;
  dropped: Record<string, number>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function countDropped(dropped: Record<string, number>, type: unknown): void {
  const key = typeof type === 'string' && type !== '' ? type : '(missing type)';
  dropped[key] = (dropped[key] ?? 0) + 1;
}

function responsesUsageToGemini(value: unknown): Record<string, number> {
  const usage = asRecord(value);
  const input = typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0;
  const output = typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0;
  const cached = asRecord(usage?.input_tokens_details)?.cached_tokens;
  const reasoning = asRecord(usage?.output_tokens_details)?.reasoning_tokens;
  const thoughtTokens = typeof reasoning === 'number' ? reasoning : 0;
  return {
    promptTokenCount: input,
    candidatesTokenCount: Math.max(0, output - thoughtTokens),
    totalTokenCount: typeof usage?.total_tokens === 'number' ? usage.total_tokens : input + output,
    ...(typeof cached === 'number' ? { cachedContentTokenCount: cached } : {}),
    ...(thoughtTokens > 0 ? { thoughtsTokenCount: thoughtTokens } : {}),
  };
}

function finishReason(response: Record<string, unknown>, hasRefusal: boolean): string {
  const reason = asRecord(response.incomplete_details)?.reason;
  if (hasRefusal || response.status === 'incomplete' && reason === 'content_filter') return 'SAFETY';
  if (response.status === 'incomplete' && reason === 'max_output_tokens') return 'MAX_TOKENS';
  if (response.status === 'failed') return 'OTHER';
  if (response.status === 'incomplete') return 'OTHER';
  return 'STOP';
}

function functionCallPart(item: Record<string, unknown>, index: number): Record<string, unknown> | undefined {
  if (typeof item.name !== 'string' || item.name === '') return undefined;
  const id = typeof item.call_id === 'string' && item.call_id !== ''
    ? item.call_id
    : typeof item.id === 'string' && item.id !== '' ? item.id : `call_${index}`;
  return { functionCall: { id, name: item.name, args: parseToolArguments(item.arguments) } };
}

export function responsesToGeminiResponse(
  response: Record<string, unknown>,
  model: string,
  options?: ConversionOptions,
): ResponsesGeminiAnswer {
  const parts: Array<Record<string, unknown>> = [];
  const dropped: Record<string, number> = {};
  let refusal = '';
  for (const [index, value] of (Array.isArray(response.output) ? response.output : []).entries()) {
    const item = asRecord(value);
    if (!item) {
      countDropped(dropped, '(malformed item)');
      continue;
    }
    if (item.type === 'message') {
      for (const partValue of Array.isArray(item.content) ? item.content : []) {
        const part = asRecord(partValue);
        if (part?.type === 'output_text' && typeof part.text === 'string') {
          parts.push({ text: part.text });
          if (typeof part.refusal === 'string') refusal += part.refusal;
        } else if (part?.type === 'refusal' && typeof part.refusal === 'string') {
          refusal += part.refusal;
        } else if (part) {
          countDropped(dropped, `content_part:${stringify(part.type)}`);
        }
      }
    } else if (item.type === 'reasoning') {
      const text = responsesReasoningText(item);
      if (text !== '') parts.push({ thought: true, text });
      if (item.encrypted_content !== undefined && item.encrypted_content !== null) {
        options?.logger?.warn(options.requestId ?? '', '[responses->gemini] reasoning.encrypted_content is provider-specific; no thoughtSignature was invented');
      }
    } else if (item.type === 'function_call') {
      const part = functionCallPart(item, index);
      if (part) parts.push(part);
      else countDropped(dropped, 'function_call_without_name');
    } else {
      countDropped(dropped, item.type);
    }
  }
  if (refusal !== '') options?.logger?.warn(options.requestId ?? '', '[responses->gemini] the upstream refused the request; finishReason is SAFETY and refusal text is not presented as an answer');
  if (response.status === 'failed') options?.logger?.warn(options.requestId ?? '', `[responses->gemini] upstream response failed: ${stringify(asRecord(response.error)?.message ?? response.error)}`);
  if (response.status === 'incomplete' && !['max_output_tokens', 'content_filter'].includes(String(asRecord(response.incomplete_details)?.reason))) {
    options?.logger?.warn(options.requestId ?? '', `[responses->gemini] incomplete reason ${stringify(asRecord(response.incomplete_details)?.reason)} has no Gemini equivalent; finishReason is OTHER`);
  }

  return {
    response: {
      model: typeof response.model === 'string' ? response.model : model,
      candidates: [{
        content: { role: 'model', parts },
        index: 0,
        finishReason: finishReason(response, refusal !== ''),
      }],
      usageMetadata: responsesUsageToGemini(response.usage),
    },
    dropped,
  };
}

interface PendingFunctionCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ResponsesGeminiStreamState {
  model: string;
  pendingCalls: Map<number, PendingFunctionCall>;
  textByOutput: Map<number, string>;
  reasoningByOutput: Map<number, string>;
  dropped: Record<string, number>;
  refusal: string;
  sawToolCall: boolean;
  finished: boolean;
}

export function createResponsesGeminiStreamState(model: string): ResponsesGeminiStreamState {
  return {
    model,
    pendingCalls: new Map(),
    textByOutput: new Map(),
    reasoningByOutput: new Map(),
    dropped: {},
    refusal: '',
    sawToolCall: false,
    finished: false,
  };
}

function geminiChunk(state: ResponsesGeminiStreamState, parts: Array<Record<string, unknown>>, finish?: string, usage?: unknown): Record<string, unknown> {
  return {
    model: state.model,
    candidates: [{ content: { role: 'model', parts }, index: 0, ...(finish ? { finishReason: finish } : {}) }],
    usageMetadata: responsesUsageToGemini(usage),
  };
}

function appendUnstreamedText(
  state: ResponsesGeminiStreamState,
  outputIndex: number,
  item: Record<string, unknown>,
  reasoning: boolean,
): string {
  const full = reasoning ? responsesReasoningText(item) : (Array.isArray(item.content) ? item.content : [])
    .map(asRecord)
    .filter(part => part?.type === 'output_text' && typeof part.text === 'string')
    .map(part => part!.text as string)
    .join('');
  const carried = (reasoning ? state.reasoningByOutput : state.textByOutput).get(outputIndex) ?? '';
  if (full === carried) return '';
  return full.startsWith(carried) ? full.slice(carried.length) : full;
}

function flushCall(state: ResponsesGeminiStreamState, outputIndex: number, item?: Record<string, unknown>): Record<string, unknown>[] {
  const pending = state.pendingCalls.get(outputIndex);
  if (!pending && !item) return [];
  const merged = {
    ...(pending ?? {}),
    ...(item ?? {}),
    call_id: item?.call_id ?? pending?.id,
    arguments: typeof item?.arguments === 'string' && item.arguments !== '' ? item.arguments : pending?.arguments ?? '',
  };
  state.pendingCalls.delete(outputIndex);
  const part = functionCallPart(merged, outputIndex);
  if (!part) {
    countDropped(state.dropped, 'function_call_without_name');
    return [];
  }
  state.sawToolCall = true;
  return [part];
}

export function responsesEventToGeminiChunks(
  state: ResponsesGeminiStreamState,
  event: Record<string, unknown>,
): Array<Record<string, unknown>> {
  if (state.finished) return [];
  const type = event.type;
  const outputIndex = typeof event.output_index === 'number' ? event.output_index : 0;

  if (type === 'response.created') {
    const response = asRecord(event.response);
    if (typeof response?.model === 'string') state.model = response.model;
    return [];
  }
  if (type === 'response.output_text.delta') {
    if (typeof event.delta !== 'string' || event.delta === '') return [];
    state.textByOutput.set(outputIndex, (state.textByOutput.get(outputIndex) ?? '') + event.delta);
    return [geminiChunk(state, [{ text: event.delta }])];
  }
  if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
    if (typeof event.delta !== 'string' || event.delta === '') return [];
    state.reasoningByOutput.set(outputIndex, (state.reasoningByOutput.get(outputIndex) ?? '') + event.delta);
    return [geminiChunk(state, [{ thought: true, text: event.delta }])];
  }
  if (type === 'response.refusal.delta') {
    if (typeof event.delta === 'string') state.refusal += event.delta;
    return [];
  }
  if (type === 'response.output_item.added') {
    const item = asRecord(event.item);
    if (item?.type === 'function_call') {
      state.pendingCalls.set(outputIndex, {
        id: typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : `call_${outputIndex}`,
        name: typeof item.name === 'string' ? item.name : '',
        arguments: typeof item.arguments === 'string' ? item.arguments : '',
      });
      state.sawToolCall = true;
    } else if (item?.type !== 'message' && item?.type !== 'reasoning') {
      countDropped(state.dropped, item?.type);
    }
    return [];
  }
  if (type === 'response.function_call_arguments.delta') {
    const pending = state.pendingCalls.get(outputIndex) ?? { id: `call_${outputIndex}`, name: '', arguments: '' };
    if (typeof event.delta === 'string') pending.arguments += event.delta;
    state.pendingCalls.set(outputIndex, pending);
    return [];
  }
  if (type === 'response.function_call_arguments.done') {
    const pending = state.pendingCalls.get(outputIndex);
    if (pending && typeof event.arguments === 'string') pending.arguments = event.arguments;
    return [];
  }
  if (type === 'response.output_item.done') {
    const item = asRecord(event.item);
    if (item?.type === 'function_call') {
      const parts = flushCall(state, outputIndex, item);
      return parts.length > 0 ? [geminiChunk(state, parts)] : [];
    }
    if (item?.type === 'reasoning') {
      const text = appendUnstreamedText(state, outputIndex, item, true);
      return text === '' ? [] : [geminiChunk(state, [{ thought: true, text }])];
    }
    if (item?.type === 'message') {
      const text = appendUnstreamedText(state, outputIndex, item, false);
      return text === '' ? [] : [geminiChunk(state, [{ text }])];
    }
    return [];
  }
  if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
    const response = asRecord(event.response) ?? {};
    const parts: Array<Record<string, unknown>> = [];
    for (const index of Array.from(state.pendingCalls.keys())) parts.push(...flushCall(state, index));
    state.finished = true;
    const chunks = parts.length > 0 ? [geminiChunk(state, parts)] : [];
    chunks.push(geminiChunk(state, [], finishReason(response, state.refusal !== ''), response.usage));
    return chunks;
  }
  return [];
}
