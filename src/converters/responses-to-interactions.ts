import type { Logger } from '../types/shared.js';
import { stringify } from '../utils/stringify.js';
import {
  createInteractionStreamState,
  interactionStepFromContent,
  interactionStreamAdoptId,
  interactionStreamCreated,
  interactionStreamEnded,
  interactionStreamError,
  interactionStreamFinish,
  interactionStreamReasoning,
  interactionStreamStatus,
  interactionStreamText,
  interactionStreamWholeStep,
  type InteractionStreamState,
} from './interactions-stream-events.js';
import { parseToolArguments } from './openai-to-gemini.js';

interface ConversionOptions {
  logger?: Logger;
  requestId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isoTime(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  return new Date().toISOString();
}

function responsesReasoningText(item: Record<string, unknown>): string {
  const parts = [
    ...(Array.isArray(item.summary) ? item.summary : []),
    ...(Array.isArray(item.content) ? item.content : []),
  ];
  return parts.map(asRecord)
    .filter(part => part?.type === 'summary_text' || part?.type === 'reasoning_text')
    .map(part => typeof part?.text === 'string' ? part.text : '')
    .join('');
}

function responsesUsage(value: unknown): Record<string, unknown> | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  const cached = asRecord(usage.input_tokens_details)?.cached_tokens;
  const reasoning = asRecord(usage.output_tokens_details)?.reasoning_tokens;
  return {
    total_input_tokens: input,
    total_output_tokens: output,
    total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : input + output,
    ...(typeof cached === 'number' ? { total_cached_tokens: cached } : {}),
    ...(typeof reasoning === 'number' ? { total_thought_tokens: reasoning } : {}),
  };
}

function responseAnnotations(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  const annotations: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    const annotation = asRecord(entry);
    if (annotation?.type === 'url_citation') {
      annotations.push({
        type: 'url_citation',
        ...(typeof annotation.url === 'string' ? { url: annotation.url } : {}),
        ...(typeof annotation.title === 'string' ? { title: annotation.title } : {}),
        ...(typeof annotation.start_index === 'number' ? { start_index: annotation.start_index } : {}),
        ...(typeof annotation.end_index === 'number' ? { end_index: annotation.end_index } : {}),
      });
    } else if (annotation?.type === 'file_citation' || annotation?.type === 'container_file_citation') {
      annotations.push({
        type: 'file_citation',
        ...(typeof annotation.filename === 'string' ? { file_name: annotation.filename } : {}),
        ...(typeof annotation.file_id === 'string' ? { source: annotation.file_id } : {}),
        ...(typeof annotation.start_index === 'number' ? { start_index: annotation.start_index } : {}),
        ...(typeof annotation.end_index === 'number' ? { end_index: annotation.end_index } : {}),
      });
    }
  }
  return annotations;
}

function responseError(response: Record<string, unknown>, fallback: string): Record<string, unknown> {
  const error = asRecord(response.error);
  return {
    code: typeof error?.code === 'string' ? error.code : fallback,
    message: typeof error?.message === 'string'
      ? error.message
      : typeof asRecord(response.incomplete_details)?.reason === 'string'
        ? `Response incomplete: ${asRecord(response.incomplete_details)?.reason}`
        : fallback,
  };
}

export function responsesToInteraction(
  response: Record<string, unknown>,
  model: string,
  requestId: string,
  options?: ConversionOptions,
): Record<string, unknown> {
  const outputs: Array<Record<string, unknown>> = [];
  let refusal = '';
  for (const [index, value] of (Array.isArray(response.output) ? response.output : []).entries()) {
    const item = asRecord(value);
    if (!item) {
      options?.logger?.warn(options.requestId ?? requestId, `[responses->interactions] dropped non-object output[${index}]`);
      continue;
    }
    if (item.type === 'message') {
      for (const partValue of Array.isArray(item.content) ? item.content : []) {
        const part = asRecord(partValue);
        if (part?.type === 'output_text' && typeof part.text === 'string') {
          const annotations = responseAnnotations(part.annotations);
          outputs.push({ type: 'text', text: part.text, ...(annotations.length > 0 ? { annotations } : {}) });
        }
        if (typeof part?.refusal === 'string') refusal += part.refusal;
      }
    } else if (item.type === 'reasoning') {
      const text = responsesReasoningText(item);
      if (text) outputs.push({ type: 'thought', summary: [{ type: 'text', text }] });
      if (item.encrypted_content !== undefined && item.encrypted_content !== null) {
        options?.logger?.warn(options.requestId ?? requestId, '[responses->interactions] reasoning.encrypted_content is provider-specific; no Interactions thought signature was invented');
      }
    } else if (item.type === 'function_call') {
      const id = typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : `call_${index}`;
      if (typeof item.name !== 'string' || item.name === '') {
        options?.logger?.warn(options.requestId ?? requestId, `[responses->interactions] dropped function_call ${id} without a name`);
        continue;
      }
      outputs.push({ type: 'function_call', id, name: item.name, arguments: parseToolArguments(item.arguments) });
    } else {
      options?.logger?.warn(options.requestId ?? requestId, `[responses->interactions] dropped output type ${stringify(item.type)} with no Interactions projection`);
    }
  }

  const incomplete = response.status === 'incomplete';
  const failed = response.status === 'failed' || refusal !== '';
  const status = incomplete ? 'incomplete' : failed ? 'failed' : outputs.some(output => output.type === 'function_call') ? 'requires_action' : 'completed';
  const usage = responsesUsage(response.usage);
  return {
    id: `v1_${Date.now()}_${requestId}`,
    model,
    status,
    object: 'interaction',
    created: isoTime(response.created_at),
    updated: new Date().toISOString(),
    steps: outputs.map(interactionStepFromContent),
    ...(usage ? { usage } : {}),
    ...(incomplete || failed ? { errors: [responseError(response, refusal || 'Responses request failed')] } : {}),
  };
}

interface PendingFunctionCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ResponsesInteractionStreamState {
  interaction: InteractionStreamState;
  pendingCalls: Map<number, PendingFunctionCall>;
  warned: Set<string>;
  refusal: string;
}

export function createResponsesInteractionStreamState(model: string, requestId: string): ResponsesInteractionStreamState {
  return {
    interaction: createInteractionStreamState(model, requestId),
    pendingCalls: new Map<number, PendingFunctionCall>(),
    warned: new Set<string>(),
    refusal: '',
  };
}

function warnStreamType(
  state: ResponsesInteractionStreamState,
  type: unknown,
  options?: ConversionOptions,
): void {
  const key = stringify(type);
  if (state.warned.has(key)) return;
  state.warned.add(key);
  options?.logger?.warn(
    options.requestId ?? state.interaction.requestId,
    `[responses->interactions] dropped stream item type ${key} with no Interactions projection`,
  );
}

function flushFunctionCall(
  state: ResponsesInteractionStreamState,
  outputIndex: number,
  item?: Record<string, unknown>,
  options?: ConversionOptions,
): Array<Record<string, unknown>> {
  const pending = state.pendingCalls.get(outputIndex);
  if (!pending && !item) return [];
  const id = typeof item?.call_id === 'string' ? item.call_id
    : typeof item?.id === 'string' ? item.id
      : pending?.id ?? `call_${outputIndex}`;
  const name = typeof item?.name === 'string' ? item.name : pending?.name ?? '';
  if (!name) {
    warnStreamType(state, 'function_call_without_name', options);
    state.pendingCalls.delete(outputIndex);
    return [];
  }
  const rawArguments = typeof item?.arguments === 'string' && item.arguments !== '' ? item.arguments : pending?.arguments ?? '';
  state.pendingCalls.delete(outputIndex);
  return interactionStreamWholeStep(state.interaction, {
    type: 'function_call', id, name, arguments: parseToolArguments(rawArguments),
  });
}

function terminalEvents(
  state: ResponsesInteractionStreamState,
  response: Record<string, unknown>,
  outcome: 'completed' | 'incomplete' | 'failed',
  options?: ConversionOptions,
): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const index of Array.from(state.pendingCalls.keys())) {
    events.push(...flushFunctionCall(state, index, undefined, options));
  }
  interactionStreamEnded(state.interaction, responsesUsage(response.usage));
  state.interaction.incomplete = outcome === 'incomplete';
  state.interaction.failed = outcome === 'failed' || (outcome !== 'incomplete' && state.refusal !== '');
  if (state.interaction.incomplete || state.interaction.failed) {
    events.push(...interactionStreamError(state.interaction, responseError(response, state.refusal || 'Responses stream failed')));
  }
  events.push(...interactionStreamFinish(state.interaction, interactionStreamStatus(state.interaction)));
  return events;
}

export function responsesEventToInteractionEvents(
  state: ResponsesInteractionStreamState,
  event: Record<string, unknown>,
  options?: ConversionOptions,
): Array<Record<string, unknown>> {
  const type = event.type;
  if (state.interaction.finished) return [];

  if (type === 'response.created') {
    const response = asRecord(event.response);
    interactionStreamAdoptId(state.interaction, response?.id);
    if (response?.created_at !== undefined) state.interaction.created = isoTime(response.created_at);
    return interactionStreamCreated(state.interaction);
  }
  if (type === 'response.output_text.delta') {
    return typeof event.delta === 'string' ? interactionStreamText(state.interaction, event.delta) : [];
  }
  if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
    return typeof event.delta === 'string' ? interactionStreamReasoning(state.interaction, event.delta) : [];
  }
  if (type === 'response.refusal.delta') {
    if (typeof event.delta === 'string') state.refusal += event.delta;
    return [];
  }
  if (type === 'response.output_item.added') {
    const item = asRecord(event.item);
    if (item?.type === 'function_call') {
      const outputIndex = typeof event.output_index === 'number' ? event.output_index : 0;
      state.pendingCalls.set(outputIndex, {
        id: typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : `call_${outputIndex}`,
        name: typeof item.name === 'string' ? item.name : '',
        arguments: '',
      });
    } else if (item?.type !== 'message' && item?.type !== 'reasoning') {
      warnStreamType(state, item?.type ?? '(missing type)', options);
    }
    return [];
  }
  if (type === 'response.function_call_arguments.delta') {
    const outputIndex = typeof event.output_index === 'number' ? event.output_index : 0;
    const pending = state.pendingCalls.get(outputIndex) ?? { id: `call_${outputIndex}`, name: '', arguments: '' };
    if (typeof event.delta === 'string') pending.arguments += event.delta;
    state.pendingCalls.set(outputIndex, pending);
    return [];
  }
  if (type === 'response.function_call_arguments.done') {
    const outputIndex = typeof event.output_index === 'number' ? event.output_index : 0;
    const pending = state.pendingCalls.get(outputIndex);
    if (pending && typeof event.arguments === 'string') pending.arguments = event.arguments;
    return [];
  }
  if (type === 'response.output_item.done') {
    const item = asRecord(event.item);
    if (item?.type === 'function_call') {
      const outputIndex = typeof event.output_index === 'number' ? event.output_index : 0;
      return flushFunctionCall(state, outputIndex, item, options);
    }
    return [];
  }
  if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
    const response = asRecord(event.response) ?? {};
    const outcome = type === 'response.incomplete' ? 'incomplete' : type === 'response.failed' ? 'failed' : 'completed';
    return terminalEvents(state, response, outcome, options);
  }
  return [];
}
