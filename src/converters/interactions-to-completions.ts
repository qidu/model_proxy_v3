import type { Logger } from '../types/shared.js';
import { stringify } from '../utils/stringify.js';

interface InteractionConversionOptions {
  logger?: Logger;
  requestId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function interactionCreatedTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function interactionUsageToCompletionUsage(value: unknown): Record<string, unknown> | undefined {
  const usage = asRecord(value);
  if (!usage) return undefined;
  const input = typeof usage.total_input_tokens === 'number' ? usage.total_input_tokens : 0;
  const output = typeof usage.total_output_tokens === 'number' ? usage.total_output_tokens : 0;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: typeof usage.total_tokens === 'number' ? usage.total_tokens : input + output,
    ...(typeof usage.total_cached_tokens === 'number'
      ? { prompt_tokens_details: { cached_tokens: usage.total_cached_tokens } }
      : {}),
  };
}

function thoughtText(output: Record<string, unknown>): string {
  if (Array.isArray(output.summary)) {
    return output.summary
      .map(part => asRecord(part))
      .filter(part => part?.type === 'text' && typeof part.text === 'string')
      .map(part => part!.text as string)
      .join('');
  }
  const legacy = asRecord(asRecord(output.summary)?.content);
  return typeof legacy?.text === 'string' ? legacy.text : '';
}

function finishReasonForStatus(
  status: unknown,
  sawToolCall: boolean,
  options?: InteractionConversionOptions,
): string {
  if (status === 'requires_action' || (status === 'completed' && sawToolCall)) return 'tool_calls';
  if (status === 'completed') return 'stop';
  if (status === 'incomplete') return 'length';
  if (status === 'failed') return 'content_filter';
  options?.logger?.warn(
    options.requestId ?? '',
    `[interactions->completions] terminal status ${stringify(status)} has no exact Chat Completions finish_reason; reported as "stop"`,
  );
  return 'stop';
}

export function convertInteractionToChatCompletion(
  interaction: Record<string, unknown>,
  model: string,
  requestId: string,
  options?: InteractionConversionOptions,
): Record<string, unknown> {
  if (interaction.status === 'in_progress') {
    throw new Error(`Non-streaming Interactions response ${stringify(interaction.id)} is still in progress`);
  }

  const text: string[] = [];
  const reasoning: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  let reasoningSignature: string | undefined;
  const outputs: unknown[] = [];
  if (Array.isArray(interaction.steps)) {
    for (const [index, value] of interaction.steps.entries()) {
      const step = asRecord(value);
      if (step?.type === 'model_output') {
        if (Array.isArray(step.content)) outputs.push(...step.content);
        else options?.logger?.warn(options.requestId ?? requestId, `[interactions->completions] dropped steps[${index}] with non-array content`);
      } else {
        outputs.push(value);
      }
    }
  } else if (Array.isArray(interaction.outputs)) {
    outputs.push(...interaction.outputs);
  }
  for (const [index, value] of outputs.entries()) {
    const output = asRecord(value);
    if (!output) {
      options?.logger?.warn(options.requestId ?? requestId, `[interactions->completions] dropped non-object content[${index}]`);
      continue;
    }
    if (output.type === 'text' && typeof output.text === 'string') {
      text.push(output.text);
    } else if (output.type === 'thought') {
      const summary = thoughtText(output);
      if (summary) reasoning.push(summary);
      if (typeof output.signature === 'string' && output.signature !== '') {
        if (reasoningSignature && reasoningSignature !== output.signature) {
          options?.logger?.warn(options.requestId ?? requestId, '[interactions->completions] kept the first thought signature; Completions has one reasoning_signature slot');
        } else {
          reasoningSignature = output.signature;
        }
      }
    } else if (output.type === 'function_call') {
      const id = typeof output.id === 'string' && output.id !== '' ? output.id : `call_${index}`;
      if (typeof output.name !== 'string' || output.name === '') {
        options?.logger?.warn(options.requestId ?? requestId, `[interactions->completions] dropped function_call ${id} without a name`);
        continue;
      }
      toolCalls.push({
        id,
        type: 'function',
        function: {
          name: output.name,
          arguments: typeof output.arguments === 'string' ? output.arguments : stringify(output.arguments ?? {}),
        },
      });
    } else {
      options?.logger?.warn(
        options.requestId ?? requestId,
        `[interactions->completions] dropped output type ${stringify(output.type)} with no Chat Completions projection`,
      );
    }
  }

  const responseModel = typeof interaction.model === 'string' && interaction.model !== '' ? interaction.model : model;
  return {
    id: typeof interaction.id === 'string' && interaction.id !== '' ? interaction.id : `chatcmpl_${requestId}`,
    object: 'chat.completion',
    created: interactionCreatedTime(interaction.created),
    model: responseModel,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: toolCalls.length > 0 && text.length === 0 ? null : text.join(''),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        ...(reasoning.length > 0 ? { reasoning_content: reasoning.join('\n') } : {}),
        ...(reasoningSignature ? { reasoning_signature: reasoningSignature } : {}),
      },
      finish_reason: finishReasonForStatus(interaction.status, toolCalls.length > 0, { logger: options?.logger, requestId }),
    }],
    ...(interactionUsageToCompletionUsage(interaction.usage)
      ? { usage: interactionUsageToCompletionUsage(interaction.usage) }
      : {}),
  };
}

export interface InteractionChatStreamState {
  id: string;
  created: number;
  model: string;
  requestId: string;
  roleSent: boolean;
  finished: boolean;
  sawToolCall: boolean;
  toolCallCount: number;
  usage?: Record<string, unknown>;
  warned: Set<string>;
  streamError?: unknown;
}

export function createInteractionChatStreamState(model: string, requestId: string): InteractionChatStreamState {
  return {
    id: `chatcmpl_${requestId}`,
    created: Math.floor(Date.now() / 1000),
    model,
    requestId,
    roleSent: false,
    finished: false,
    sawToolCall: false,
    toolCallCount: 0,
    warned: new Set<string>(),
  };
}

function streamChunk(
  state: InteractionChatStreamState,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
  choicesEmpty = false,
): Record<string, unknown> {
  return {
    id: state.id,
    object: 'chat.completion.chunk',
    created: state.created,
    model: state.model,
    choices: choicesEmpty ? [] : [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function ensureRole(state: InteractionChatStreamState, chunks: Array<Record<string, unknown>>): void {
  if (state.roleSent) return;
  state.roleSent = true;
  chunks.push(streamChunk(state, { role: 'assistant', content: '' }));
}

function warnStreamType(
  state: InteractionChatStreamState,
  type: unknown,
  options?: InteractionConversionOptions,
): void {
  const key = stringify(type);
  if (state.warned.has(key)) return;
  state.warned.add(key);
  options?.logger?.warn(
    options.requestId ?? state.requestId,
    `[interactions->completions] dropped stream payload type ${key} with no Chat Completions projection`,
  );
}

export function interactionEventToChatChunks(
  state: InteractionChatStreamState,
  event: Record<string, unknown>,
  options?: InteractionConversionOptions,
): Array<Record<string, unknown>> {
  const chunks: Array<Record<string, unknown>> = [];
  if (state.finished) return chunks;

  if (event.event_type === 'interaction.created') {
    const interaction = asRecord(event.interaction);
    if (typeof interaction?.id === 'string' && interaction.id !== '') state.id = interaction.id;
    if (interaction?.created !== undefined) state.created = interactionCreatedTime(interaction.created);
    if (typeof interaction?.model === 'string' && interaction.model !== '') state.model = interaction.model;
    ensureRole(state, chunks);
    return chunks;
  }

  if (event.event_type === 'step.start') {
    const step = asRecord(event.step);
    if (step?.type !== 'function_call') {
      if (step?.type !== 'model_output' && step?.type !== 'thought') warnStreamType(state, step?.type ?? 'step.start', options);
      return chunks;
    }
    const name = step.name;
    if (typeof name !== 'string' || name === '') {
      warnStreamType(state, 'function_call_without_name', options);
      return chunks;
    }
    state.sawToolCall = true;
    ensureRole(state, chunks);
    const toolCallIndex = state.toolCallCount++;
    chunks.push(streamChunk(state, {
      tool_calls: [{
        index: toolCallIndex,
        id: typeof step.id === 'string' && step.id !== '' ? step.id : `call_${String(event.index ?? 0)}`,
        type: 'function',
        function: {
          name,
          arguments: typeof step.arguments === 'string' ? step.arguments : stringify(step.arguments ?? {}),
        },
      }],
    }));
    return chunks;
  }

  if (event.event_type === 'step.delta') {
    const delta = asRecord(event.delta);
    if (delta?.type === 'text' && typeof delta.text === 'string' && delta.text !== '') {
      ensureRole(state, chunks);
      chunks.push(streamChunk(state, { content: delta.text }));
    } else if (delta?.type === 'thought_summary') {
      const content = asRecord(delta.content);
      if (typeof content?.text === 'string' && content.text !== '') {
        ensureRole(state, chunks);
        chunks.push(streamChunk(state, { reasoning_content: content.text }));
      }
    } else if (delta?.type === 'thought_signature' && typeof delta.signature === 'string' && delta.signature !== '') {
      ensureRole(state, chunks);
      chunks.push(streamChunk(state, { reasoning_signature: delta.signature }));
    } else {
      warnStreamType(state, delta?.type ?? 'step.delta', options);
    }
    return chunks;
  }

  if (event.event_type === 'step.stop') {
    state.usage = interactionUsageToCompletionUsage(event.usage ?? event.step_usage) ?? state.usage;
    return chunks;
  }

  if (event.event_type === 'interaction.completed') {
    const interaction = asRecord(event.interaction);
    if (state.streamError !== undefined && interaction?.status !== 'incomplete') {
      throw new Error(`Interactions stream failed: ${stringify(state.streamError)}`);
    }
    state.usage = interactionUsageToCompletionUsage(interaction?.usage) ?? state.usage;
    state.finished = true;
    ensureRole(state, chunks);
    chunks.push(streamChunk(state, {}, finishReasonForStatus(interaction?.status, state.sawToolCall, {
      logger: options?.logger,
      requestId: state.requestId,
    })));
    return chunks;
  }

  if (event.event_type === 'error') {
    state.streamError = event.error ?? event;
    return chunks;
  }

  if (event.event_type !== 'interaction.status_update') warnStreamType(state, event.event_type, options);
  return chunks;
}

export function interactionStreamUsageChunk(state: InteractionChatStreamState): Record<string, unknown> | undefined {
  if (!state.usage) return undefined;
  return { ...streamChunk(state, {}, null, true), usage: state.usage };
}

export function interactionsAsCompletionsStream(
  upstream: Response,
  model: string,
  requestId: string,
  logger?: Logger,
): Response {
  const state = createInteractionChatStreamState(model, requestId);
  const encoder = new TextEncoder();
  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        if (!upstream.body) throw new Error('Interactions upstream returned an empty stream');
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        const processEvent = (rawEvent: string): void => {
          const data = rawEvent.split(/\r?\n/)
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trimStart())
            .join('\n');
          if (!data || data === '[DONE]') return;
          const event = JSON.parse(data) as Record<string, unknown>;
          for (const chunk of interactionEventToChatChunks(state, event, { logger, requestId })) {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          }
        };
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split(/\r?\n\r?\n/);
          buffer = events.pop() ?? '';
          for (const event of events) processEvent(event);
        }
        buffer += decoder.decode();
        if (buffer.trim()) processEvent(buffer);
        if (!state.finished) throw new Error(`Interactions stream ended before interaction.completed (request ${requestId})`);
        const usage = interactionStreamUsageChunk(state);
        if (usage) controller.enqueue(encoder.encode(`data: ${JSON.stringify(usage)}\n\n`));
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  });
  return new Response(readable, { headers: { 'Content-Type': 'text/event-stream' } });
}
